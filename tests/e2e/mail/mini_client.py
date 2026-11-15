# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""A tiny ActiveSync client for testing mock_eas.py (Python standard library only).

One TLS connection per request, verified against the mock's test authority;
responses are read as strictly as the extension reads them: a Content-Length
is required and nothing may follow the announced body.

    c = MiniEasClient(srv, "alice@example.test", "secret")
    c.provision()
    folders = c.folder_sync("0")
    resp, doc = c.command("Sync", el("AirSync:Sync", [...]))
"""

import base64
import socket
import ssl
import sys
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import wbxml  # noqa: E402
from wbxml import el  # noqa: E402


class HttpResponse:
    def __init__(self, status, reason, headers, body):
        self.status = status
        self.reason = reason
        self.headers = headers  # lower-case name -> [values]
        self.body = body

    def header(self, name):
        values = self.headers.get(name.lower())
        return values[0] if values else None

    def __repr__(self):
        return f"<HttpResponse {self.status} {self.reason} {len(self.body)} octets>"


class ProtocolViolation(AssertionError):
    """The server answered something a strict client refuses."""


def read_response(sock):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(65536)
        if not chunk:
            raise ProtocolViolation(f"réponse tronquée (en-têtes) : {data[:200]!r}")
        data += chunk
    head, _, rest = data.partition(b"\r\n\r\n")
    lines = head.decode("ascii").split("\r\n")
    version, status, reason = (lines[0].split(" ", 2) + [""])[:3]
    if version != "HTTP/1.1":
        raise ProtocolViolation(f"ligne d'état inattendue : {lines[0]!r}")
    headers = {}
    for line in lines[1:]:
        name, sep, value = line.partition(":")
        if not sep:
            raise ProtocolViolation(f"en-tête invalide : {line!r}")
        headers.setdefault(name.strip().lower(), []).append(value.strip())
    if "transfer-encoding" in headers:
        raise ProtocolViolation("Transfer-Encoding inattendu")
    lengths = headers.get("content-length")
    if not lengths or len(lengths) != 1 or not lengths[0].isdigit():
        raise ProtocolViolation("Content-Length absent ou invalide")
    length = int(lengths[0])
    body = rest
    while len(body) < length:
        chunk = sock.recv(65536)
        if not chunk:
            raise ProtocolViolation("corps tronqué")
        body += chunk
    if len(body) > length:
        raise ProtocolViolation("octets après le corps annoncé")
    # Nothing may follow (the server closes the connection).
    try:
        sock.settimeout(5)
        extra = sock.recv(1)
    except (ssl.SSLError, OSError):
        extra = b""
    if extra:
        raise ProtocolViolation("octets après la réponse")
    return HttpResponse(int(status), reason, headers, body)


class MiniEasClient:
    def __init__(self, server, login, password, device_id="MiniClient1", device_type="MiniTest", version="14.1",
                 host=None):
        self.server = server
        self.login = login
        self.password = password
        self.device_id = device_id
        self.device_type = device_type
        self.version = version
        self.host = host or server.host
        self.policy_key = None
        self.ctx = ssl.create_default_context(cafile=server.ca_cert_path)

    # ── HTTP ──────────────────────────────────────────────────────────────

    def exchange(self, raw, timeout=30.0, server_hostname=None):
        """Send raw request bytes on a new verified TLS connection; read the response."""
        with socket.create_connection((self.host, self.server.port), timeout=timeout) as tcp:
            with self.ctx.wrap_socket(tcp, server_hostname=server_hostname or self.host) as tls:
                tls.sendall(raw)
                return read_response(tls)

    def request(self, method, query="", headers=(), body=b"", auth=True, password=None, timeout=30.0):
        target = "/Microsoft-Server-ActiveSync" + (f"?{query}" if query else "")
        lines = [f"{method} {target} HTTP/1.1", f"Host: {self.host}:{self.server.port}", "User-Agent: MiniEas/1.0"]
        if auth:
            token = base64.b64encode(f"{self.login}:{password or self.password}".encode("utf-8")).decode("ascii")
            lines.append(f"Authorization: Basic {token}")
        lines += [f"{k}: {v}" for k, v in headers]
        if body or method == "POST":
            lines.append(f"Content-Length: {len(body)}")
        raw = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii") + body
        return self.exchange(raw, timeout=timeout)

    def query(self, cmd):
        return "&".join(f"{k}={quote(v, safe='')}" for k, v in (
            ("Cmd", cmd), ("User", self.login), ("DeviceId", self.device_id), ("DeviceType", self.device_type)))

    def command(self, cmd, doc, *, policy_key="auto", version=None, timeout=30.0, body=None, extra_headers=()):
        """POST a command. -> (HttpResponse, decoded Element or None)."""
        payload = body if body is not None else (wbxml.encode(doc) if doc is not None else b"")
        headers = [("MS-ASProtocolVersion", version or self.version)]
        if payload:
            headers.append(("Content-Type", "application/vnd.ms-sync.wbxml"))
        key = self.policy_key if policy_key == "auto" else policy_key
        if key:
            headers.append(("X-MS-PolicyKey", key))
        headers += list(extra_headers)
        resp = self.request("POST", self.query(cmd), headers, payload, timeout=timeout)
        decoded = None
        if resp.status == 200 and resp.body:
            if resp.header("content-type") != "application/vnd.ms-sync.wbxml":
                raise ProtocolViolation(f"Content-Type inattendu : {resp.header('content-type')}")
            decoded = wbxml.decode(resp.body, check_utf8=False)
        return resp, decoded

    def options(self):
        return self.request("OPTIONS")

    # ── Commands ──────────────────────────────────────────────────────────

    def provision(self, ack="3", device_info=True):
        """Two-step Provision; keeps and returns the final key."""
        first = [el("Provision:Policies", [el("Policy", [el("PolicyType", "MS-EAS-Provisioning-WBXML")])])]
        if device_info:
            first.insert(0, el("Settings:DeviceInformation", [el("Set", [
                el("Model", "MiniEas"), el("FriendlyName", "Mini client"), el("UserAgent", "MiniEas/1.0")])]))
        resp, doc = self.command("Provision", el("Provision:Provision", first), policy_key="0")
        assert resp.status == 200 and doc is not None, resp
        temp = doc.text("Policies", "Policy", "PolicyKey")
        if doc.text("Status") != "1" or temp is None:
            return doc
        resp, doc = self.command("Provision", el("Provision:Provision", [el("Policies", [el("Policy", [
            el("PolicyType", "MS-EAS-Provisioning-WBXML"), el("PolicyKey", temp), el("Status", ack)])])]),
            policy_key=temp)
        assert resp.status == 200 and doc is not None, resp
        final = doc.text("Policies", "Policy", "PolicyKey")
        if doc.text("Status") == "1" and final:
            self.policy_key = final
        return doc

    def folder_sync(self, key="0"):
        """-> {"status", "key", "changes": [(op, server_id, parent_id, name, type)]}"""
        resp, doc = self.command("FolderSync", el("FolderHierarchy:FolderSync", [el("SyncKey", key)]))
        assert resp.status == 200 and doc is not None, resp
        changes = []
        for c in (doc.child("Changes").children if doc.has("Changes") else []):
            if c.tag == "Count":
                continue
            changes.append((c.tag, c.text("ServerId"), c.text("ParentId"), c.text("DisplayName"),
                            int(c.text("Type")) if c.has("Type") else None))
        return {"status": doc.text("Status"), "key": doc.text("SyncKey"), "changes": changes, "doc": doc}

    def sync(self, collection_id, key, *, commands=None, window=None, options=None, get_changes=None,
             deletes_as_moves=None, top=()):
        """One-collection Sync. -> {"status", "key", "commands": [(op, server_id, data)], "responses",
        "more", "doc"} (doc None for an empty response)."""
        children = [el("SyncKey", key), el("CollectionId", collection_id)]
        if deletes_as_moves is not None:
            children.append(el("DeletesAsMoves", "1" if deletes_as_moves else "0"))
        if get_changes is not None:
            children.append(el("GetChanges", "1" if get_changes else "0"))
        if window is not None:
            children.append(el("WindowSize", window))
        if options is not None:
            children.append(el("Options", options))
        if commands:
            children.append(el("Commands", commands))
        resp, doc = self.command("Sync", el("AirSync:Sync", [el("Collections", [el("Collection", children)]),
                                                             *top]))
        assert resp.status == 200, resp
        return parse_sync(doc)


def parse_sync(doc, collection_index=0):
    if doc is None:
        return {"status": None, "key": None, "commands": [], "responses": [], "more": False, "doc": None}
    colls = doc.find("Collections")
    if colls is None:
        return {"status": doc.text("Status"), "key": None, "commands": [], "responses": [], "more": False,
                "doc": doc, "top": True}
    c = colls.children[collection_index]
    commands = [(x.tag, x.text("ServerId"), x.child("ApplicationData")) for x in
                (c.child("Commands").children if c.has("Commands") else [])]
    responses = [(x.tag, x.text("ServerId") or x.text("ClientId"), x.text("Status"), x) for x in
                 (c.child("Responses").children if c.has("Responses") else [])]
    return {"status": c.text("Status"), "key": c.text("SyncKey"), "commands": commands, "responses": responses,
            "more": c.has("MoreAvailable"), "doc": doc, "collection_id": c.text("CollectionId")}


MAIL_OPTIONS = [el("AirSync:FilterType", "0"),
                el("AirSyncBase:BodyPreference", [el("Type", "4")]),
                el("AirSync:MIMESupport", "2")]
