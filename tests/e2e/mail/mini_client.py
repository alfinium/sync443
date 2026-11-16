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

Calendar and tasks: sync(..., supported=...) for the first Sync, add_item,
change_item and delete_item for one client command, event_data and task_data
to write ApplicationData, meeting_response for MeetingResponse.
"""

import base64
import datetime
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
             deletes_as_moves=None, top=(), supported=None):
        """One-collection Sync. -> {"status", "key", "commands": [(op, server_id, data)], "responses",
        "more", "doc"} (doc None for an empty response).
        supported: the children of Supported (elements, or names of the collection's class given as
        "Calendar:Subject"); an empty list sends an empty Supported; None sends none."""
        children = [el("SyncKey", key), el("CollectionId", collection_id)]
        if supported is not None:
            children.append(el("Supported", [x if isinstance(x, wbxml.Element) else el(x) for x in supported]))
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

    def add_item(self, collection_id, key, data, client_id="c1", **kw):
        """Sync with one Add. -> (ServerId or None, Status, the parsed Sync)"""
        r = self.sync(collection_id, key, commands=[el("Add", [el("ClientId", client_id),
                                                              el("ApplicationData", data)])], **kw)
        answer = next((x for op, _, _, x in r["responses"] if op == "Add" and x.text("ClientId") == client_id), None)
        if answer is None:
            return None, None, r
        return answer.text("ServerId"), answer.text("Status"), r

    def change_item(self, collection_id, key, server_id, data, **kw):
        """Sync with one Change. -> (Status: "1" when the server says nothing, the parsed Sync)"""
        r = self.sync(collection_id, key, commands=[el("Change", [el("ServerId", server_id),
                                                                 el("ApplicationData", data)])], **kw)
        status = next((st for op, sid, st, _ in r["responses"] if op == "Change" and sid == server_id), None)
        return (status or ("1" if r["status"] == "1" else None)), r

    def delete_item(self, collection_id, key, server_id, **kw):
        """Sync with one Delete. -> the parsed Sync"""
        return self.sync(collection_id, key, commands=[el("Delete", [el("ServerId", server_id)])], **kw)

    def meeting_response(self, *requests):
        """MeetingResponse. Each request: (UserResponse, CollectionId, RequestId[, InstanceId]).
        -> (HttpResponse, [(RequestId, Status, CalendarId)], top-level Status, the decoded document)"""
        body = []
        for req in requests:
            children = [el("UserResponse", req[0]), el("CollectionId", req[1]), el("RequestId", req[2])]
            if len(req) > 3 and req[3] is not None:
                children.append(el("InstanceId", req[3]))
            body.append(el("Request", children))
        resp, doc = self.command("MeetingResponse", el("MeetingResponse:MeetingResponse", body))
        if doc is None:
            return resp, [], None, None
        results = [(r.text("RequestId"), r.text("Status"), r.text("CalendarId")) for r in doc.children_named("Result")]
        return resp, results, doc.text("Status"), doc


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

# Calendar and tasks.

PIM_OPTIONS = [el("AirSync:FilterType", "0"), el("AirSyncBase:BodyPreference", [el("Type", "1")])]
# Children of Supported for the Calendar class ([MS-ASCMD] 2.2.3.179): the required ones, then the optional ones.
SUPPORTED_REQUIRED = ("DtStamp", "Categories", "Sensitivity", "BusyStatus", "UID", "Timezone", "StartTime", "Subject",
                      "Location", "EndTime", "Recurrence", "AllDayEvent", "Reminder", "Exceptions")
SUPPORTED_OPTIONAL = ("Attendees", "OrganizerName", "OrganizerEmail", "MeetingStatus", "ResponseRequested",
                      "DisallowNewTimeProposal")


def calendar_supported(version="14.1", without=()):
    """Every calendar element a client can declare in Supported for a protocol version, but `without`."""
    names = SUPPORTED_REQUIRED + SUPPORTED_OPTIONAL
    if version.startswith("12."):
        names = [n for n in names if n not in ("ResponseRequested", "DisallowNewTimeProposal")]
    return [f"Calendar:{n}" for n in names if n not in without]


def compact(when):
    """Compact DateTime ("20261120T093000Z") of a datetime (naive: UTC)."""
    if when.tzinfo is not None:
        when = when.astimezone(datetime.timezone.utc)
    return when.strftime("%Y%m%dT%H%M%SZ")


def long_date(when):
    """dateTime ("2026-11-20T09:30:00.000Z") of a datetime (naive: UTC)."""
    if when.tzinfo is not None:
        when = when.astimezone(datetime.timezone.utc)
    return when.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def body_element(text):
    return el("AirSyncBase:Body", [el("Type", "1"), el("Data", text)])


def _recurrence(ns, fields):
    order = ("Type", "Start", "Until", "Occurrences", "Interval", "WeekOfMonth", "DayOfWeek", "MonthOfYear",
             "DayOfMonth", "Regenerate", "DeadOccur", "CalendarType", "IsLeapMonth", "FirstDayOfWeek")
    unknown = set(fields) - set(order)
    assert not unknown, unknown
    return el(f"{ns}:Recurrence", [el(name, fields[name]) for name in order if name in fields])


def event_data(**fields):
    """Calendar ApplicationData children. Keys are element names (Subject="…", StartTime=datetime or text,
    AllDayEvent=0…); Attendees=[{Email, Name, AttendeeStatus, AttendeeType}], Categories=[…],
    Recurrence={Type: 1, …}, Exceptions=[{ExceptionStartTime: …, Deleted: 1, Subject: …}], Body="text",
    Timezone=bytes or base64 text. A value None writes an empty element."""
    out = []
    for name, value in fields.items():
        if isinstance(value, datetime.datetime):
            value = compact(value)
        if name == "Body":
            out.append(body_element(value))
        elif name == "Timezone" and isinstance(value, (bytes, bytearray)):
            out.append(el("Calendar:Timezone", base64.b64encode(bytes(value)).decode("ascii")))
        elif name == "Attendees":
            out.append(el("Calendar:Attendees", [el("Attendee", [el(k, v) for k, v in a.items()]) for a in value]))
        elif name == "Categories":
            out.append(el("Calendar:Categories", [el("Category", c) for c in value]))
        elif name == "Recurrence":
            rec = {k: compact(v) if isinstance(v, datetime.datetime) else v for k, v in value.items()}
            out.append(_recurrence("Calendar", rec))
        elif name == "Exceptions":
            out.append(el("Calendar:Exceptions", [el("Exception", event_data(**x)) for x in value]))
        else:
            out.append(el(f"Calendar:{name}", value))
    return out


def task_data(**fields):
    """Tasks ApplicationData children. Keys are element names (Subject="…", Complete=0, DueDate=datetime…);
    Categories=[…], Recurrence={Type: 0, Start: datetime, …}, Body="text"."""
    out = []
    for name, value in fields.items():
        if isinstance(value, datetime.datetime):
            value = long_date(value)
        if name == "Body":
            out.append(body_element(value))
        elif name == "Categories":
            out.append(el("Tasks:Categories", [el("Category", c) for c in value]))
        elif name == "Recurrence":
            rec = {k: long_date(v) if isinstance(v, datetime.datetime) else v for k, v in value.items()}
            out.append(_recurrence("Tasks", rec))
        else:
            out.append(el(f"Tasks:{name}", value))
    return out
