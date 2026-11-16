# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""End-to-end test of Sync443's mail, in a real, headless Thunderbird, against
the strict mock ActiveSync server (mock_eas.py).

    python3 -I tests/e2e/mail/run_mail_test.py [--keep] [--log] [--phases=1,2,3] [--steps=3,4,5,6]

  --keep     keep the work directory (profile, test package, logs)
  --log      print the extension's log and Thunderbird's output
  --phases   run only these phases (each needs the previous ones)
  --steps    phase 1 only runs these of its steps 3 to 7 (1 and 2, the
             mailboxes and the first sync, always run): for debugging
  --no-server-archives
             the mailbox has no "Archives" folder on the server (by default it
             has one, which collides with the local "/Archives"): Thunderbird's
             Archive action then makes the engine create it
  --trace    print the timeline of the requests the main server received,
             phase by phase (Ping folders and outcome, Sync collections)
  --debug-log
             the extension logs at debug level (its log keeps only its last
             entries: debug lines push out the info and warning ones)
  --local-folders
             create Thunderbird's "Local Folders" account before the first
             mailbox (by default the profile has none, as when Sync443 is
             the only mail account: the case where Thunderbird would take
             a Sync443 account as its Local Folders)
  --src=DIR  test another source tree instead of src/ (e.g. a copy with a
             proposed patch applied); the release-package check still looks
             at src/
  --locale=LANG
             Thunderbird's interface language for the run (intl.locale.requested,
             e.g. en-US or fr; the build must ship that language): the
             scenario checks that the extension's texts (settings page,
             toolbar button, manifest) are in it. Without it, Thunderbird
             keeps the language of its build; either way the texts must be those
             of the catalogue Thunderbird picks for it (English when none fits)

Windows, macOS, Linux; Python 3.8+ standard library only.
  THUNDERBIRD   path of the Thunderbird executable (otherwise looked for in
                the usual places of each OS, as tests/e2e/net does)
  On Linux with Thunderbird as a snap, set TMPDIR to a directory in your home:
  the snap cannot see the system's /tmp.

What it does, all in a throw-away directory (never your Thunderbird profile):
  1. starts three mock ActiveSync servers over TLS: the main one (its test
     authority is trusted by the profile AND pinned by the mailboxes), one
     whose authority Thunderbird trusts but no mailbox pins, one whose
     authority nobody trusts; puts two users and their mail on the main one;
  2. builds a TEST package of the extension in the work directory: src/ as it
     is, plus test-config.json (allowLocal, scenario, pins = the main
     authority's SHA-256, and what the scenario needs to know), the scenario
     (test-scenario.mjs) and a test-only helper experiment
     (extension/experiments/sync443MailTest); the test manifest also gets
     "https://127.0.0.1/*" (host permission without a user gesture) and
     "compose.send" (to click Send programmatically). Release builds
     (tools/build_xpi.py) package src/ only: this is checked too;
  3. runs Thunderbird three times on the same profile (phases 1, 2, 3 of
     test-scenario.mjs), answering the scenario's requests (files in the
     profile) by driving the mock server between its steps;
  4. checks, from the outside: the mock's protocol and internal errors, that
     every request came over TLS and that the refused servers never received
     an application byte, the console errors of the extension, and, once
     Thunderbird is stopped, the profile's files (prefs.js, logins.json,
     Mail directory).

Prints a PASS/FAIL/SKIP list (and GAP: behaviour this version does not
implement); exit status 1 on any FAIL.

The calendar, the tasks and the meetings are tested by a sibling runner,
run_calendar_sync_test.py, with a scenario of its own (calendar-scenario.mjs)
on a profile and servers of its own: it imports this module for the servers'
requests (Rpc, CALLABLE), the test package (build_test_package), the phases
(run_phase, parse, collect) and the report. Here the calendar is only
synchronized in the background, as for any mailbox that has it checked.
"""

import base64
import datetime
import email
import email.policy
import email.utils
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
sys.dont_write_bytecode = True
for _p in (str(HERE), str(HERE.parent / "net")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Launch helpers shared with the sync443Net test: find_thunderbird,
# stop_process, remove_tree, write_text, USER_JS (throw-away profile prefs).
import run_net_test as net  # noqa: E402
import mock_eas  # noqa: E402
import testcerts  # noqa: E402
import wbxml  # noqa: E402
from mock_eas import FolderType, MockEasServer, make_mime  # noqa: E402

EXTENSION_ID = "sync443@alfinium.github.io"
RESULTS_FILE = "sync443mail-e2e.txt"
PHASE_FILE = "sync443mail-phase.json"
RPC_PREFIX = "sync443mail-rpc-"
PHASE_TIMEOUT_S = {1: 900, 2: 420, 3: 420}
ALICE = ("alice@example.test", "alice-mot-de-passe")
BOB = ("bob@example.test", "bob-mot-de-passe")
INTERNAL_HEADER = re.compile(rb"(?im)^(x-mozilla-[a-z0-9-]*|x-account-key|x-identity-key|fcc)[ \t]*:")
TEST_FILES = ("test-config.json", "test-scenario.mjs", "sync443MailTest")

USER_JS = net.USER_JS + """
user_pref("layout.spellcheckDefault", 0);
user_pref("mail.compose.attachment_reminder", false);
user_pref("mail.biff.show_alert", false);
user_pref("mail.biff.play_sound", false);
"""

results = []
gaps = []
notes = []


def check(cond, label, detail=None):
    results.append(("PASS" if cond else "FAIL", label, detail))


def skip(label, detail=None):
    results.append(("SKIP", label, detail))


# ── Servers ────────────────────────────────────────────────────────────────

class OtherMaterial(mock_eas.CertMaterial):
    """The mock's certificate material, from another throw-away authority."""

    def __init__(self, ca_name):  # noqa: D401 - same attributes as CertMaterial
        self.dir = Path(tempfile.mkdtemp(prefix="sync443-mail-e2e-ca-"))
        self.ca = testcerts.make_ca(ca_name)
        self.leaf = testcerts.make_leaf(self.ca, "localhost", dns=["localhost"], ips=["127.0.0.1", "::1"])
        self.ca_path = str(self.dir / "ca.pem")
        self.cert_path = str(self.dir / "server.pem")
        self.chain_path = str(self.dir / "server-chain.pem")
        self.key_path = str(self.dir / "server.key")
        testcerts.write_cert(self.ca, self.ca_path)
        testcerts.write_cert(self.leaf, self.cert_path)
        testcerts.write_key(self.leaf, self.key_path)
        with open(self.chain_path, "w", encoding="ascii", newline="\n") as out:
            for part in (self.cert_path, self.ca_path):
                with open(part, encoding="ascii") as f:
                    out.write(f.read())
        self.ca_der = self.ca.cert_der
        self.leaf_der = self.leaf.cert_der
        self.ca_sha256 = hashlib.sha256(self.ca_der).hexdigest().upper()
        self.leaf_sha256 = hashlib.sha256(self.leaf_der).hexdigest().upper()
        with open(self.ca_path, encoding="ascii") as f:
            self.ca_pem = f.read()


class OtherCaServer(MockEasServer):
    """A mock server whose certificate comes from another authority."""

    def __init__(self, material, **kw):
        super().__init__(**kw)
        self._other = material

    def start(self):
        saved = mock_eas.cert_material
        mock_eas.cert_material = lambda: self._other
        try:
            return super().start()
        finally:
            mock_eas.cert_material = saved


def raw_message(subject, to, body, extra=b"", message_id=True):
    head = (f"From: Expediteur E2E <expediteur@example.test>\r\nTo: {to}\r\nSubject: {subject}\r\n"
            f"Date: {email.utils.format_datetime(datetime.datetime.now(datetime.timezone.utc))}\r\n")
    if message_id:
        head += f"Message-ID: {email.utils.make_msgid(domain='e2e.test')}\r\n"
    head += "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n"
    return extra + head.encode("ascii") + body.encode("ascii")


def setup_fixture(srv, server_archives=True):
    """Users, folders and messages of the scenario (subjects: test-scenario.mjs, S).
    server_archives: the mailbox has a top-level "Archives" folder (with one message) from the start."""
    a, b = ALICE[0], BOB[0]
    srv.add_user(a, ALICE[1], display_name="Alice Test")
    srv.add_user(b, BOB[1], display_name="Bob Test")
    projets = srv.add_folder(a, "Projets")
    srv.add_folder(a, "2026", parent=projets)
    srv.add_folder(a, "Clients", parent="Inbox")
    if server_archives:
        srv.add_folder(a, "Archives")
    srv.add_folder(a, "Factures: 2026")
    masse = srv.add_folder(a, "Masse")
    srv.add_folder(a, "Agenda perso", type_=FolderType.USER_CALENDAR)
    srv.add_folder(a, "Contacts perso", type_=FolderType.USER_CONTACTS)
    srv.add_folder(a, "Taches perso", type_=FolderType.USER_TASKS)

    def add(folder, subject, **kw):
        return srv.add_message(a, folder, subject=subject, to=a, **kw)

    add("Inbox", "E2E non lu")
    add("Inbox", "E2E lu suivi", read=True, flagged=True)
    fake = raw_message("E2E faux statut", a, "Le serveur pretend que ce message est lu et etiquete.\r\n",
                       extra=b"X-Mozilla-Status: 0001\r\nX-Mozilla-Status2: 00000000\r\n"
                             b"X-Mozilla-Keys: $label1 important\r\nX-Account-Key: account1\r\n")
    srv.add_message(a, "Inbox", fake, read=False)
    no_id = raw_message("E2E sans message-id", a, "Pas de Message-ID.\r\n", message_id=False)
    srv.add_message(a, "Inbox", no_id)
    dup = make_mime("E2E doublon", to=a, message_id="<doublon@e2e.test>")
    srv.add_message(a, "Inbox", dup)
    srv.add_message(a, "Inbox", dup)
    for subject in ("E2E a deplacer", "E2E a supprimer", "E2E serveur drapeau", "E2E serveur supprime",
                    "E2E serveur deplace", "E2E redemarrage supprimer", "E2E redemarrage deplacer", "E2E temoin",
                    "E2E a archiver", "E2E vers dossier local"):
        add("Inbox", subject)
    add("Inbox/Clients", "E2E client")
    add("Projets", "E2E projet")
    add("Projets/2026", "E2E dans 2026")
    add("Sent Items", "E2E deja envoye", read=True)
    add("Deleted Items", "E2E deja supprime", read=True)
    if server_archives:
        add("Archives", "E2E archive serveur")
    add("Factures: 2026", "E2E facture")
    for n in range(1, 61):
        add(masse, f"E2E masse {n:02d}")
    srv.add_message(b, "Inbox", subject="E2E pour Bob 1", to=b)
    srv.add_message(b, "Inbox", subject="E2E pour Bob 2", to=b)

    def paths(login):
        views = srv.folders(login)
        by_id = {f["server_id"]: f for f in views}

        def path(f):
            parts = [f["name"]]
            while f["parent_id"] != "0" and f["parent_id"] in by_id:
                f = by_id[f["parent_id"]]
                parts.append(f["name"])
            return "/".join(reversed(parts))

        return {path(f): f["server_id"] for f in views}, [f["server_id"] for f in views
                                                          if f["type"] not in mock_eas.MAIL_TYPES]

    folders_a, pim_a = paths(a)
    folders_b, pim_b = paths(b)
    synthetic = hashlib.sha256(no_id).hexdigest()[:32] + "@sync443.invalid"
    return {"folders": {"alice": folders_a, "bob": folders_b}, "pimFolders": {"alice": pim_a, "bob": pim_b},
            "syntheticId": synthetic, "dupId": "doublon@e2e.test"}


# ── Requests from the scenario ─────────────────────────────────────────────

CALLABLE = {"add_message", "set_read", "set_flag", "delete_message", "move_message", "mass_delete", "add_folder", "set_option",
            "rename_folder", "delete_folder", "last_seq", "pings_waiting", "wake_ping", "folders", "devices",
            "folder_id", "users",
            # Calendar, tasks and meetings (calendar-scenario.mjs, run by run_calendar_sync_test.py).
            "add_event", "change_event", "delete_event", "events", "event", "find_events", "set_attendee_status",
            "cancel_meeting", "add_task", "change_task", "delete_task", "tasks", "task", "find_tasks",
            "deliver_invitation", "meeting_responses", "sent_calendar_parts"}
# Those that only read the server: not listed in the timeline of --trace.
READ_ONLY_CALLS = {"last_seq", "pings_waiting", "folders", "devices", "folder_id", "users", "events", "event", "find_events",
                   "tasks", "task", "find_tasks", "meeting_responses", "sent_calendar_parts"}


def jsonable(value):
    if isinstance(value, (bytes, bytearray)):
        return {"$b64": base64.b64encode(bytes(value)).decode("ascii")}
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, wbxml.Element):
        return None
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [jsonable(v) for v in value]
    return value


def folder_paths(srv, login):
    views = srv.folders(login)
    by_id = {f["server_id"]: f for f in views}
    out = {}
    for f in views:
        parts, g = [f["name"]], f
        while g["parent_id"] != "0" and g["parent_id"] in by_id:
            g = by_id[g["parent_id"]]
            parts.append(g["name"])
        out[f["server_id"]] = "/".join(reversed(parts))
    return views, out


def message_view(m, path=None):
    out = {"server_id": m["server_id"], "subject": m.get("subject"), "message_id": m.get("message_id"),
           "read": m["read"], "flagged": m["flagged"]}
    if path is not None:
        out.update(folder=path, folder_id=m["folder_id"])
    return out


def sync_keys(doc):
    keys = []
    stack = [doc] if doc is not None else []
    while stack:
        node = stack.pop()
        if node.tag == "SyncKey":
            try:
                keys.append(node.text())
            except wbxml.WbxmlError:
                keys.append("?")
        stack.extend(node.children)
    return keys


def texts(doc, tag, ns=None):
    """Texts of every element named `tag` (in namespace `ns`, if given) under doc."""
    out = []
    stack = [doc] if doc is not None else []
    while stack:
        node = stack.pop()
        if node.tag == tag and (ns is None or node.ns == ns):
            try:
                out.append(node.text())
            except wbxml.WbxmlError:
                out.append("?")
        stack.extend(reversed(node.children))
    return out


def request_view(r):
    out = {k: r.get(k) for k in ("seq", "time", "method", "cmd", "user", "device_id", "http_status", "status", "error",
                                 "tls_version", "ping", "duration")}
    doc = r.get("request")
    out["sync_keys"] = sync_keys(doc)
    if r.get("cmd") == "Ping":
        out["ping_folders"] = texts(doc, "Id", "Ping")
        out["heartbeat"] = (texts(doc, "HeartbeatInterval") or [None])[0]
        resp = r.get("response")
        out["ping_changed"] = texts(resp, "Folder", "Ping") if resp is not None else []
    elif r.get("cmd") == "Sync":
        out["collections"] = list(zip(texts(doc, "CollectionId"), texts(doc, "SyncKey")))
        out["filters"] = collection_filters(doc)
    return out


def collection_filters(doc):
    """[[CollectionId, FilterType or None]] of a Sync request, collection by collection."""
    out = []
    stack = [doc] if doc is not None else []
    while stack:
        node = stack.pop()
        if node.tag == "Collection" and node.ns == "AirSync":
            ids, filters = texts(node, "CollectionId"), texts(node, "FilterType")
            out.append([ids[0] if ids else None, filters[0] if filters else None])
            continue
        stack.extend(reversed(node.children))
    return out


def trace_lines(srv, since=0, until=None, t0=None, calls=()):
    """The requests as a timeline, one line each, with the scenario's changes to the server (--trace)."""
    lines = []
    pending = sorted(calls)
    for r in srv.requests(since=since):
        if until is not None and r["seq"] > until:
            break
        while pending and t0 is not None and pending[0][0] <= r["time"]:
            at, what = pending.pop(0)
            lines.append(f"  +{at - t0:8.2f}s   ** scénario : {what}")
        v = request_view(r)
        t0 = v["time"] if t0 is None else t0
        start, end = v["time"], v["time"] + (v.get("duration") or 0)  # time: when the request began
        extra = ""
        if v["cmd"] == "Ping":
            extra = f" hb={v.get('heartbeat')} -> {v.get('ping')} folders={v.get('ping_folders')} changed={v.get('ping_changed')}"
        elif v["cmd"] == "Sync":
            extra = f" {v.get('collections')}"
        lines.append(f"  +{start - t0:8.2f}s..+{end - t0:8.2f}s #{v['seq']} {v['cmd']} {v.get('user')} "
                     f"{(v.get('device_id') or '')[-6:]} HTTP {v.get('http_status')} St={v.get('status')}{extra}"
                     + (f" [{v['error']}]" if v.get("error") else ""))
    return lines


def sent_view(m):
    mime = m.get("mime") or b""
    internal = sorted({x.decode("ascii", "replace") for x in INTERNAL_HEADER.findall(mime)})
    parts = 0
    subject = None
    try:
        msg = email.message_from_bytes(mime, policy=email.policy.default)
        subject = str(msg.get("subject", ""))
        for part in msg.walk():
            parts += 1
            for name in part.keys():
                low = name.lower()
                if low.startswith("x-mozilla-") or low in ("x-account-key", "x-identity-key", "fcc"):
                    internal.append(name)
    except Exception as e:  # noqa: BLE001 - reported as a part count of 0
        subject = f"illisible : {e}"
    return {"status": m.get("status"), "error": m.get("error"), "recipients": m.get("recipients"),
            "delivered_to": m.get("delivered_to"), "save_in_sent": m.get("save_in_sent"),
            "sent_copy": m.get("sent_copy"), "subject": subject, "internal_headers": sorted(set(internal)),
            "parts": parts, "size": len(mime)}


class Rpc:
    """Answers the scenario's requests: <profile>/sync443mail-rpc-*.req → .res"""

    def __init__(self, profile, servers):
        self.profile = profile
        self.servers = servers
        self.count = 0
        self.errors = []
        self.calls = []  # (time, description) of the calls that change the server, for --trace

    def poll(self):
        for req in sorted(self.profile.glob(f"{RPC_PREFIX}*.req")):
            try:
                data = json.loads(req.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue  # being written (the helper writes through a temporary file, but be safe)
            try:
                answer = {"ok": True, "result": jsonable(self.handle(data))}
            except Exception as e:  # noqa: BLE001 - sent back to the scenario
                answer = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                self.errors.append(f"{data.get('op')} {data.get('method', '')}: {e}")
            res = req.with_suffix(".res")
            tmp = req.with_suffix(".restmp")
            tmp.write_text(json.dumps(answer), encoding="utf-8")
            os.replace(tmp, res)
            req.unlink()
            self.count += 1

    def handle(self, data):
        op = data.get("op")
        srv = self.servers[data.get("server") or "main"]
        login = data.get("login")
        if op == "call":
            method = data.get("method")
            if method not in CALLABLE:
                raise ValueError(f"méthode non autorisée : {method}")
            if method not in READ_ONLY_CALLS:
                self.calls.append((time.time(), f"{method} {data.get('args', [])[1:]} {data.get('kwargs', {})}"))
            return getattr(srv, method)(*data.get("args", []), **data.get("kwargs", {}))
        if op == "add_dated":  # a message received `days` days ago (JSON has no dates)
            when = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=float(data["days"]))
            return srv.add_message(login, data.get("folder", "Inbox"), subject=data["subject"], date=when)
        if op == "summary":
            return [message_view(m) for m in srv.messages(login, data["folder"])]
        if op == "find":
            views, paths = folder_paths(srv, login)
            out = []
            for f in views:
                for m in srv.messages(login, f["server_id"]):
                    if m.get("subject") == data["subject"]:
                        out.append(message_view(m, paths[f["server_id"]]))
            return out
        if op == "folders":
            views, paths = folder_paths(srv, login)
            return [dict(f, path=paths[f["server_id"]]) for f in views]
        if op == "requests":
            return [request_view(r) for r in srv.requests(login=login, device_id=data.get("device_id"),
                                                         since=data.get("since", 0))]
        if op == "actions":
            kinds = data.get("kinds")
            return [a for a in srv.actions(login=login, device_id=data.get("device_id"), since=data.get("since", 0))
                    if not kinds or a["kind"] in kinds]
        if op == "sent":
            return [sent_view(m) for m in srv.sent_mails(login)]
        if op == "collections_requested":
            return sorted(srv.collections_requested(login=login, device_id=data.get("device_id"),
                                                    since=data.get("since", 0)))
        raise ValueError(f"opération inconnue : {op}")


# ── Package ────────────────────────────────────────────────────────────────

def build_test_package(work, config, src, customize=None):
    """src/ + test material, in work/package, zipped to work/<id>.xpi.
    customize(pkg, manifest): a sibling runner adds its own test material (run_calendar_sync_test.py)."""
    pkg = work / "package"
    if pkg.exists():
        shutil.rmtree(pkg)
    shutil.copytree(src, pkg, ignore=shutil.ignore_patterns(".DS_Store", "Thumbs.db", "desktop.ini",
                                                                      "__pycache__"))
    manifest = json.loads((pkg / "manifest.json").read_text(encoding="utf-8"))
    manifest["permissions"] = list(manifest["permissions"]) + ["https://127.0.0.1/*", "compose.send"]
    manifest["experiment_apis"]["sync443MailTest"] = {
        "schema": "experiments/sync443MailTest/schema.json",
        "parent": {"scopes": ["addon_parent"], "paths": [["sync443MailTest"]],
                   "script": "experiments/sync443MailTest/implementation.js"},
    }
    (pkg / "test-config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    shutil.copy2(HERE / "test-scenario.mjs", pkg / "test-scenario.mjs")
    shutil.copytree(HERE / "extension" / "experiments" / "sync443MailTest", pkg / "experiments" / "sync443MailTest")
    if customize:
        customize(pkg, manifest)
    (pkg / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    xpi = work / f"{EXTENSION_ID}.xpi"
    with zipfile.ZipFile(xpi, "w", zipfile.ZIP_DEFLATED) as z:
        for file in sorted(pkg.rglob("*")):
            if file.is_file():
                z.write(file, file.relative_to(pkg).as_posix())
    return xpi


def catalogues(src):
    """{language: {key: message}} of the extension's translations (src/_locales), for the language checks."""
    out = {}
    base = Path(src) / "_locales"
    for path in sorted(base.glob("*/messages.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        out[path.parent.name] = {key: entry["message"] for key, entry in data.items()}
    return out


def release_package_files():
    """What tools/build_xpi.py would package (without building anything)."""
    spec = importlib.util.spec_from_file_location("build_xpi", ROOT / "tools" / "build_xpi.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return [name for name, _ in mod.collect()]


# ── Thunderbird ────────────────────────────────────────────────────────────

def parse(text):
    """{kind: [values]} from the "SYNC443MAIL-<KIND> <json>" lines."""
    out = {}
    for line in text.splitlines():
        m = re.match(r"^SYNC443MAIL-([A-Z]+) (.*)$", line.strip())
        if m:
            try:
                value = json.loads(m.group(2))
            except ValueError:
                value = m.group(2)
            out.setdefault(m.group(1), []).append(value)
    return out


def run_phase(thunderbird, profile, phase, extra, rpc, log_path, timeout=None):
    results_path = profile / RESULTS_FILE
    if results_path.exists():
        results_path.unlink()
    for leftover in profile.glob(f"{RPC_PREFIX}*"):
        leftover.unlink()
    net.write_text(profile / PHASE_FILE, json.dumps(dict(extra, phase=phase)))
    env = dict(os.environ, MOZ_CRASHREPORTER_DISABLE="1")
    started = time.time()
    done = False
    exited_at = None
    with open(log_path, "ab") as logf:
        logf.write(f"\n===== phase {phase} =====\n".encode())
        logf.flush()
        proc = subprocess.Popen([str(thunderbird), "-headless", "-no-remote", "-profile", str(profile)],
                                stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT, env=env)
        deadline = time.time() + (timeout or PHASE_TIMEOUT_S[phase])
        while time.time() < deadline:
            rpc.poll()
            if results_path.exists() and "SYNC443MAIL-DONE" in results_path.read_text(encoding="utf-8",
                                                                                       errors="replace"):
                done = True
                break
            if proc.poll() is not None:
                # On some systems the first process only launches the real one: give it time.
                exited_at = exited_at or time.time()
                if time.time() - exited_at > 15:
                    break
            time.sleep(0.05)
        net.stop_process(proc)
    text = results_path.read_text(encoding="utf-8", errors="replace") if results_path.exists() else ""
    net.write_text(log_path.parent / f"phase{phase}.txt", text)  # kept with --keep
    return text, done, time.time() - started


def collect(lines, phase, done, seconds):
    for crash in lines.get("CRASH", []):
        detail = crash.get("error") if isinstance(crash, dict) else crash
        check(False, f"[{phase}] le scénario ne plante pas", detail)
        if isinstance(crash, dict) and crash.get("stack"):
            notes.append(f"phase {phase}, pile : {crash['stack'][:800]}")
    check(done, f"[{phase}] Thunderbird exécute toute la phase puis se ferme",
          f"{seconds:.1f} s" if done else f"délai dépassé ({seconds:.0f} s)")
    for c in lines.get("CHECK", []):
        if isinstance(c, dict):
            check(bool(c.get("ok")), f"[{phase}] {c.get('label')}", None if c.get("ok") else c.get("detail"))
    for g in lines.get("GAP", []):
        if isinstance(g, dict):
            gaps.append((phase, g.get("label"), g.get("detail")))
    errors = [e for batch in lines.get("ERRORS", []) if isinstance(batch, list) for e in batch]
    ours = [e for e in errors if e.get("ours")]
    check(not ours, f"[{phase}] console de Thunderbird : aucune erreur venant de l'extension",
          [f"{e.get('message')} @ {e.get('source')}:{e.get('line')}" for e in ours][:10])
    others = [e for e in errors if not e.get("ours")]
    if others:
        notes.append(f"phase {phase} : {len(others)} erreur(s) de console hors extension, par exemple : "
                     + " | ".join(f"{e.get('message', '')[:160]} @ {e.get('source', '')[-60:]}" for e in others[:4]))


def info_of(lines, key):
    for value in lines.get("INFO", []):
        if isinstance(value, dict) and key in value:
            return value[key]
    return None


def print_log(lines, phase, last=80):
    entries = lines.get("LOG", [])
    if entries:
        print(f"\nJournal de l'extension, phase {phase} ({len(entries)} entrées, les {min(last, len(entries))} dernières) :")
        for e in entries[-last:]:
            print(f"    {e.get('level', '?'):5} {str(e.get('msg', ''))[:300]}")


# ── Run ────────────────────────────────────────────────────────────────────

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    keep = "--keep" in sys.argv
    show_log = "--log" in sys.argv
    wanted_phases = (1, 2, 3)
    wanted_steps = None
    local_folders = "--local-folders" in sys.argv
    server_archives = "--no-server-archives" not in sys.argv
    debug_log = "--debug-log" in sys.argv
    trace = "--trace" in sys.argv
    phase_marks = {}  # phase -> (first seq, launch time)
    src = ROOT / "src"
    ui_locale = None
    for arg in sys.argv[1:]:
        if arg.startswith("--locale="):
            ui_locale = arg.split("=", 1)[1]
            if not re.fullmatch(r"[a-z]{2,3}(?:-[A-Z]{2})?", ui_locale):
                sys.exit(f"--locale : langue invalide : {ui_locale!r} (par exemple en-US ou fr)")
        elif arg.startswith("--src="):
            src = Path(arg.split("=", 1)[1]).resolve()
            if not (src / "manifest.json").is_file():
                sys.exit(f"--src : pas de manifest.json dans {src}")
        elif arg.startswith("--phases="):
            wanted_phases = tuple(int(x) for x in arg.split("=", 1)[1].split(",") if x)
        elif arg.startswith("--steps="):
            wanted_steps = [int(x) for x in arg.split("=", 1)[1].split(",") if x]
    started = time.time()
    thunderbird = net.find_thunderbird()
    work = Path(tempfile.mkdtemp(prefix="sync443-mail-e2e-"))
    servers = {}
    materials = []
    phases = {}
    durations = {}
    try:
        # 1. Servers.
        main_srv = MockEasServer().start()
        servers["main"] = main_srv
        unpinned_ca = OtherMaterial("Sync443 Mail E2E Unpinned CA")
        untrusted_ca = OtherMaterial("Sync443 Mail E2E Untrusted CA")
        materials += [unpinned_ca, untrusted_ca]
        servers["unpinned"] = OtherCaServer(unpinned_ca).start()
        servers["untrusted"] = OtherCaServer(untrusted_ca).start()
        for name in ("unpinned", "untrusted"):
            servers[name].add_user(ALICE[0], ALICE[1])  # were the certificate check bypassed, the login would work
        fixture = setup_fixture(main_srv, server_archives)
        config = {
            "allowLocal": True,
            "scenario": True,
            "pins": [main_srv.ca_sha256],
            "e2e": dict(fixture,
                        port=main_srv.port,
                        unpinnedPort=servers["unpinned"].port,
                        untrustedPort=servers["untrusted"].port,
                        caBase64=base64.b64encode(main_srv.ca_der).decode("ascii"),
                        caSha256=main_srv.ca_sha256,
                        unpinnedCaBase64=base64.b64encode(unpinned_ca.ca_der).decode("ascii"),
                        localFolders=local_folders,
                        serverArchives=server_archives,
                        debugLog=debug_log,
                        alice={"login": ALICE[0], "password": ALICE[1]},
                        bob={"login": BOB[0], "password": BOB[1]},
                        uiLocale=ui_locale,
                        catalogues=catalogues(src)),
        }

        # 2. Test package, throw-away profile.
        profile = work / "profile"
        (profile / "extensions").mkdir(parents=True)
        xpi = build_test_package(work, config, src)
        shutil.copy2(xpi, profile / "extensions" / xpi.name)
        net.write_text(profile / "user.js", USER_JS + (f'user_pref("intl.locale.requested", "{ui_locale}");\n' if ui_locale else ""))
        log_path = work / "thunderbird.log"
        release = release_package_files()
        leaked = [n for n in release if any(t in n for t in TEST_FILES)]
        release_manifest = json.loads((ROOT / "src" / "manifest.json").read_text(encoding="utf-8"))
        check(not leaked and "compose.send" not in release_manifest["permissions"]
              and not any("127.0.0.1" in p for p in release_manifest["permissions"])
              and "sync443MailTest" not in release_manifest.get("experiment_apis", {}),
              "paquet publié (tools/build_xpi.py) : aucun fichier ni droit de test", leaked)
        rpc = Rpc(profile, servers)

        # 3. Phases.
        extra = {"steps": wanted_steps} if wanted_steps else {}
        for phase in wanted_phases:
            if phase > 1 and not phases.get(phase - 1, (None, False))[1]:
                skip(f"phase {phase}", f"la phase {phase - 1} n'a pas abouti")
                continue
            phase_marks[phase] = (main_srv.last_seq(), time.time())
            text, done, seconds = run_phase(thunderbird, profile, phase, extra, rpc, log_path)
            lines = parse(text)
            phases[phase] = (lines, done)
            durations[phase] = seconds
            collect(lines, phase, done, seconds)
            if phase == 1:
                extra = {"previous": info_of(lines, "idsBeforeRestart")}
                tech = info_of(lines, "selectedEncryptionTechnology")
                if tech is not None:
                    notes.append("compose.getComposeDetails(), identité de A sans clé OpenPGP ni certificat S/MIME : "
                                 f"selectedEncryptionTechnology = {json.dumps(tech, ensure_ascii=False)}")
                at = info_of(lines, "serverArchivesAtFirstSync")
                if at is not None:
                    notes.append(f"dossier « Archives » du serveur à la première synchro : {at}")
                binding = info_of(lines, "archivesBinding")
                if binding is not None:
                    notes.append(f"après l'archivage : {json.dumps(binding, ensure_ascii=False)}")
                status = info_of(lines, "mboxStatusOfUnreadImport")
                if status:
                    notes.append(f"message non lu importé par messages.import() : en-têtes écrits dans le fichier du dossier {status}")
            after = info_of(lines, "idsAfterRestart") if phase == 2 else None
            if after:
                notes.append(f"identifiants Thunderbird des messages visés : avant redémarrage {after.get('before')}, "
                             f"après {dict((k, v) for k, v in after.items() if k != 'before')}")

        # 4. Checks from the outside.
        boxes = info_of(phases.get(1, ({}, False))[0], "mailboxes") or {}
        for name, srv in servers.items():
            check(not srv.protocol_errors(), f"serveur {name} : aucune requête refusée comme mal formée",
                  srv.protocol_errors()[:5])
            check(not srv.internal_errors(), f"serveur {name} : aucune erreur interne",
                  [e[:300] for e in srv.internal_errors()[:3]])
        reqs = main_srv.requests()
        tls_failures = [r.get("error") for r in reqs if r.get("method") is None and str(r.get("error", "")).startswith("TLS")]
        check(not tls_failures, "serveur principal : aucune connexion hors TLS ou refusée en TLS (aucun HTTP en clair)",
              tls_failures[:5])
        authenticated = [r for r in reqs if r.get("user")]
        check(authenticated and all(r.get("tls_version") for r in authenticated),
              "toutes les requêtes authentifiées ont eu lieu en TLS",
              f"{len(authenticated)} requêtes ; versions : {sorted({str(r.get('tls_version')) for r in authenticated})}")
        empty = [r for r in reqs if r.get("method") is None]
        check(not empty, "serveur principal : aucune connexion ouverte puis abandonnée sans requête", [r.get("error") for r in empty][:5])
        for name in ("unpinned", "untrusted"):
            got = servers[name].requests()
            check(got and all(r.get("method") is None and not r.get("user") for r in got),
                  f"serveur {name} : jamais un octet applicatif sur toute la durée du test", [r.get("error") for r in got])
        check(rpc.count > 0, "requêtes du scénario au faux serveur traitées", rpc.count)
        if rpc.errors:  # a step that fails on one shows as a CHECK or a CRASH of the scenario
            notes.append(f"{len(rpc.errors)} requête(s) du scénario refusée(s) par le faux serveur, par exemple : "
                         + " | ".join(rpc.errors[:3]))

        # Profile files, Thunderbird stopped.
        if phases.get(3):
            b_account = info_of(phases[3][0], "bAccount") or {}
            b_path = b_account.get("localPath")
            if b_path:
                check(not Path(b_path).exists(), "[disque] dossier local du compte de B absent, Thunderbird arrêté", b_path)
            prefs = profile / "prefs.js"
            if prefs.is_file() and boxes:
                ptext = prefs.read_text(encoding="utf-8", errors="replace")
                check(boxes["B"]["id"] not in ptext and boxes["A"]["id"] in ptext,
                      "[prefs.js] plus aucune trace de B (marques, serveur, identité), A toujours là")
                smtp_marks = re.findall(r'user_pref\("mail\.smtpserver\.[^"]*\.sync443\.owner"', ptext)
                check(len(smtp_marks) == 1, "[prefs.js] un seul serveur sortant neutre (celui de A)", smtp_marks)
            logins = profile / "logins.json"
            if logins.is_file() and boxes:
                data = json.loads(logins.read_text(encoding="utf-8"))
                ours = [(e.get("hostname"), e.get("httpRealm")) for e in data.get("logins", []) if e.get("httpRealm") == "Sync443"]
                check(ours == [(boxes["A"]["origin"], "Sync443")],
                      "[logins.json] une seule entrée Sync443, celle de A (celle de B retirée)", ours)
            else:
                skip("[logins.json] contrôle du fichier", "mots de passe stockés ailleurs que dans logins.json")

        if trace:
            marks = sorted(phase_marks.items())
            for i, (phase, (seq, launched)) in enumerate(marks):
                until = marks[i + 1][1][0] if i + 1 < len(marks) else None
                print(f"\nChronologie du serveur principal, phase {phase} (temps depuis le lancement de Thunderbird) :")
                end = marks[i + 1][1][1] if i + 1 < len(marks) else float("inf")
                calls = [c for c in rpc.calls if launched <= c[0] < end]
                for line in trace_lines(main_srv, since=seq, until=until, t0=launched, calls=calls):
                    print(line[:400])
        log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        failed = any(r[0] == "FAIL" for r in results)
        if show_log or failed:
            for phase, (lines, _) in sorted(phases.items()):
                print_log(lines, phase, last=400 if show_log else 120)
            print("\nExtrait du journal de Thunderbird :")
            for line in [l for l in log.splitlines() if "sync443" in l.lower() or "error" in l.lower()][-60:]:
                print("    " + line[:400])
            if failed:
                print("\nDerniers échanges avec le faux serveur :")
                print(main_srv.transcript(since=max(0, main_srv.last_seq() - 40), max_value=80)[-6000:])
    finally:
        for srv in servers.values():
            try:
                srv.stop()
            except Exception:  # noqa: BLE001 - best effort
                pass
        for material in materials:
            material.cleanup()
        if keep:
            print(f"\nDossier conservé : {work}")
        else:
            net.remove_tree(work)

    return report(f"Résultats courrier : {thunderbird} (sans interface), {sys.platform}"
                  + (f", sources {src}" if src != ROOT / "src" else "") + (f", langue {ui_locale}" if ui_locale else "")
                  + (", « Dossiers locaux » créés d'avance" if local_folders else "")
                  + ("" if server_archives else ", sans dossier « Archives » sur le serveur"), started, durations)


def report(title, started, durations):
    """Prints the PASS/FAIL/SKIP list, the gaps and the notes; -> the exit status (1 on any FAIL)."""
    width = min(max((len(r[1]) for r in results), default=0), 110)
    print(f"\n{title}")
    for status, label, detail in results:
        shown = str(detail).replace("\r", "\\r").replace("\n", "\\n") if detail not in (None, "") else ""
        print(f"  {status:4}  {label.ljust(width)}" + (f"   [{shown[:400]}]" if shown else ""))
    if gaps:
        print("\nÉcarts (non implémenté dans cette version, signalé et non inventé) :")
        for phase, label, detail in gaps:
            print(f"  GAP   [{phase}] {label}" + (f"   [{json.dumps(detail, ensure_ascii=False)[:300]}]" if detail else ""))
    if notes:
        print("\nConstats :")
        for note in notes:
            print(f"  - {note}")
    fails = sum(1 for r in results if r[0] == "FAIL")
    passes = sum(1 for r in results if r[0] == "PASS")
    skips = sum(1 for r in results if r[0] == "SKIP")
    phase_times = ", ".join(f"phase {p} : {s:.0f} s" for p, s in sorted(durations.items()))
    print(f"\n{passes} PASS, {fails} FAIL, {skips} SKIP, {len(gaps)} GAP en {time.time() - started:.1f} s ({phase_times})")
    return 1 if fails or not results else 0


if __name__ == "__main__":
    sys.exit(main())
