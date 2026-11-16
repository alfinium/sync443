# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""Stateful Exchange ActiveSync 14.1 test server, Python standard library only.

Written from the Microsoft specifications [MS-ASHTTP], [MS-ASCMD],
[MS-ASWBXML], [MS-ASPROV], [MS-ASEMAIL], [MS-ASAIRS], [MS-ASCAL],
[MS-ASTASK] and [MS-ASDTYPE]. It behaves like a strict real server, so that
the end-to-end test fails when the client sends something a real server
would refuse:

  - HTTPS only (certificate issued by a throw-away test authority, see
    ../net/testcerts.py), HTTP/1.1 requests framed by Content-Length;
    every response carries a Content-Length, then the connection is closed;
  - Basic authentication per user (401 otherwise), OPTIONS, POST
    /Microsoft-Server-ActiveSync?Cmd=…&User=…&DeviceId=…&DeviceType=…;
  - provisioning ([MS-ASPROV]): X-MS-PolicyKey checked on every command
    (HTTP 449 in 12.1, Status 142/143/144 in 14.x), two-step Provision,
    remote wipe on request;
  - FolderSync, FolderCreate/Update/Delete, Sync (WindowSize, MoreAvailable,
    client Change/Delete/Add/Fetch, DeletesAsMoves, FilterType/SoftDelete,
    Status 3 and 12), MoveItems, Ping (long poll), SendMail (local delivery),
    Settings (UserInformation, DeviceInformation), GetItemEstimate,
    ItemOperations (Fetch, EmptyFolderContents);
  - calendar and task classes ([MS-ASCAL], [MS-ASTASK]): typed items for the
    negotiated version, client Add/Change/Delete validated as the
    specifications require, Supported and ghosting, FilterType per class;
  - meetings: invitation mails (MeetingRequest), MeetingResponse, and the
    calendar parts of what SendMail received.

Everything is driven in-process by the test, thread-safe:

    srv = MockEasServer().start()
    srv.add_user("alice@example.test", "secret", display_name="Alice")
    inbox = srv.folder_id("alice@example.test", FolderType.INBOX)
    srv.add_message("alice@example.test", inbox, subject="Bonjour")
    ...            # point the client at srv.origin, pin srv.ca_sha256
    srv.wait_until(lambda: srv.actions(kind="sync_change"), timeout=60)
    srv.stop()

See MockEasServer for the whole control API.
"""

import atexit
import base64
import binascii
import datetime
import email
import email.header
import email.policy
import email.utils
import hashlib
import html
import re
import secrets
import select
import shutil
import socket
import ssl
import sys
import tempfile
import threading
import time
import traceback
import uuid
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote_to_bytes

HERE = Path(__file__).resolve().parent
NET_DIR = HERE.parent / "net"
for _p in (str(HERE), str(NET_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import testcerts  # noqa: E402
import wbxml  # noqa: E402
from wbxml import Element, WbxmlError, el  # noqa: E402

__all__ = ["MockEasServer", "ServerOptions", "FolderType", "make_mime", "DEFAULT_POLICY", "cert_material",
           "make_timezone", "parse_timezone", "global_obj_id", "uid_of_global_obj_id"]

EAS_PATH = "/Microsoft-Server-ActiveSync"
WBXML_TYPE = "application/vnd.ms-sync.wbxml"
# What Exchange 2010 SP1 and later advertise ([MS-ASHTTP] 2.2.4).
PROTOCOL_COMMANDS = (
    "Sync", "SendMail", "SmartForward", "SmartReply", "GetAttachment", "GetHierarchy", "CreateCollection",
    "DeleteCollection", "MoveCollection", "FolderSync", "FolderCreate", "FolderDelete", "FolderUpdate", "MoveItems",
    "GetItemEstimate", "MeetingResponse", "Search", "Settings", "Ping", "ItemOperations", "Provision",
    "ResolveRecipients", "ValidateCert",
)
# Root element of each command's request and response.
ROOTS = {
    "Sync": "AirSync:Sync",
    "FolderSync": "FolderHierarchy:FolderSync",
    "FolderCreate": "FolderHierarchy:FolderCreate",
    "FolderUpdate": "FolderHierarchy:FolderUpdate",
    "FolderDelete": "FolderHierarchy:FolderDelete",
    "MoveItems": "Move:MoveItems",
    "GetItemEstimate": "GetItemEstimate:GetItemEstimate",
    "Ping": "Ping:Ping",
    "Provision": "Provision:Provision",
    "Settings": "Settings:Settings",
    "SendMail": "ComposeMail:SendMail",
    "SmartReply": "ComposeMail:SmartReply",
    "SmartForward": "ComposeMail:SmartForward",
    "ItemOperations": "ItemOperations:ItemOperations",
    "Search": "Search:Search",
    "ResolveRecipients": "ResolveRecipients:ResolveRecipients",
    "ValidateCert": "ValidateCert:ValidateCert",
    "MeetingResponse": "MeetingResponse:MeetingResponse",
}
# Commands whose request may have an empty body (the server then reuses the last one).
EMPTY_BODY_ALLOWED = {"Sync", "Ping"}
POLICY_TYPE = "MS-EAS-Provisioning-WBXML"

REASONS = {
    200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 411: "Length Required", 413: "Payload Too Large", 415: "Unsupported Media Type",
    429: "Too Many Requests", 431: "Request Header Fields Too Large", 449: "Retry With",
    500: "Internal Server Error", 501: "Not Implemented", 503: "Service Unavailable",
    505: "HTTP Version Not Supported",
}


class FolderType:
    """Folder types of [MS-ASCMD] 2.2.3.186.3."""
    GENERIC = 1
    INBOX = 2
    DRAFTS = 3
    DELETED = 4
    SENT = 5
    OUTBOX = 6
    TASKS = 7
    CALENDAR = 8
    CONTACTS = 9
    NOTES = 10
    JOURNAL = 11
    USER_MAIL = 12
    USER_CALENDAR = 13
    USER_CONTACTS = 14
    USER_TASKS = 15
    USER_JOURNAL = 16
    USER_NOTES = 17
    UNKNOWN = 18
    RECIPIENT_CACHE = 19


MAIL_TYPES = frozenset({1, 2, 3, 4, 5, 6, 12})
USER_TYPES = frozenset(range(12, 19))  # created by users: may be renamed, moved, deleted
CREATABLE_TYPES = frozenset(range(12, 18))


def class_of_type(folder_type):
    """Item class of a folder type (Ping's Class, Sync's options)."""
    if folder_type in MAIL_TYPES:
        return "Email"
    return {7: "Tasks", 15: "Tasks", 8: "Calendar", 13: "Calendar", 9: "Contacts", 14: "Contacts", 19: "Contacts",
            10: "Notes", 17: "Notes", 11: "Journal", 16: "Journal"}.get(folder_type, "Email")


# FilterType ([MS-ASCMD] 2.2.3.68.2): days kept, by value, and the values each class accepts.
FILTER_DAYS = {0: None, 1: 1, 2: 3, 3: 7, 4: 14, 5: 31, 6: 92, 7: 183, 8: None}
FILTERS_BY_CLASS = {"Email": {0, 1, 2, 3, 4, 5}, "Calendar": {0, 4, 5, 6, 7}, "Tasks": {0, 8},
                    "Contacts": {0}, "Notes": {0}, "Journal": {0}}

# EASProvisionDoc ([MS-ASPROV] 2.2.2.27), in schema order. None: empty element.
DEFAULT_POLICY = (
    ("DevicePasswordEnabled", "0"), ("AlphanumericDevicePasswordRequired", "0"),
    ("PasswordRecoveryEnabled", "0"), ("RequireStorageCardEncryption", "0"), ("AttachmentsEnabled", "1"),
    ("MinDevicePasswordLength", "4"), ("MaxInactivityTimeDeviceLock", "900"),
    ("MaxDevicePasswordFailedAttempts", "8"), ("MaxAttachmentSize", None), ("AllowSimpleDevicePassword", "1"),
    ("DevicePasswordExpiration", None), ("DevicePasswordHistory", "0"), ("AllowStorageCard", "1"),
    ("AllowCamera", "1"), ("RequireDeviceEncryption", "0"), ("AllowUnsignedApplications", "1"),
    ("AllowUnsignedInstallationPackages", "1"), ("MinDevicePasswordComplexCharacters", "3"), ("AllowWiFi", "1"),
    ("AllowTextMessaging", "1"), ("AllowPOPIMAPEmail", "1"), ("AllowBluetooth", "2"), ("AllowIrDA", "1"),
    ("RequireManualSyncWhenRoaming", "0"), ("AllowDesktopSync", "1"), ("MaxCalendarAgeFilter", "0"),
    ("AllowHTMLEmail", "1"), ("MaxEmailAgeFilter", "0"), ("MaxEmailBodyTruncationSize", "-1"),
    ("MaxEmailHTMLBodyTruncationSize", "-1"), ("RequireSignedSMIMEMessages", "0"),
    ("RequireEncryptedSMIMEMessages", "0"), ("RequireSignedSMIMEAlgorithm", "0"),
    ("RequireEncryptionSMIMEAlgorithm", "0"), ("AllowSMIMEEncryptionAlgorithmNegotiation", "2"),
    ("AllowSMIMESoftCerts", "1"), ("AllowBrowser", "1"), ("AllowConsumerEmail", "1"),
    ("AllowRemoteDesktop", "1"), ("AllowInternetSharing", "1"), ("UnapprovedInROMApplicationList", None),
    ("ApprovedApplicationList", None),
)


@dataclass
class ServerOptions:
    """Behaviour switches. The defaults are the strictest realistic choice."""
    versions: tuple = ("12.1", "14.0", "14.1")  # MS-ASProtocolVersions
    require_provisioning: bool = True  # X-MS-PolicyKey checked on every command but Provision
    provision_style: str = "auto"  # "auto": HTTP 449 in 12.x, Status 142/143/144 in 14.x; "449": always 449
    policy: tuple = DEFAULT_POLICY  # None: "no policy for this device" (Policy Status 2, no key needed)
    accepted_ack_statuses: tuple = ("1", "2", "3")  # Provision acknowledgements accepted (3 = not applied)
    require_device_information: bool = True  # 14.1: first Provision without DeviceInformation -> Status 165
    heartbeat_min: int = 60  # Ping and Sync HeartbeatInterval bounds, in protocol seconds
    heartbeat_max: int = 3540
    heartbeat_scale: float = 1.0  # wall-clock seconds per protocol second while waiting (0.05: 60 s -> 3 s)
    max_ping_folders: int = 300
    default_window_size: int = 100
    max_window_size: int = 512
    empty_sync_response: bool = True  # Sync with nothing to report: HTTP 200, empty body (like Exchange)
    sync_responses_for_success: bool = False  # also answer successful client Changes in <Responses>
    move_adds_to_destination: bool = True  # MoveItems: the moved item comes back as an Add in the destination
    move_deletes_from_source: bool = False  # MoveItems: the source also reports a Delete for the old id
    foldersync_zero_resets_collections: bool = True  # FolderSync SyncKey 0 invalidates every Sync state
    status12_on_hierarchy_change: bool = False  # Sync: Status 12 for every collection while the hierarchy is stale
    status3_on_filter_change: bool = False  # Sync: a known collection whose FilterType changes starts over (Status 3)
    ping_status7_on_hierarchy_change: bool = True  # Ping: Status 7 when the device's hierarchy is stale
    body_data_opaque: bool = False  # AirSyncBase:Data as OPAQUE instead of an inline string
    max_request_bytes: int = 64 * 1024 * 1024
    io_timeout: float = 30.0  # seconds, socket reads and writes
    server_version_header: str = "14.1"  # MS-Server-ActiveSync
    # Meetings. An invitation also appears in the user's Calendar, not yet answered, as on Exchange
    # (ResponseType 5 from 14.0); False: the calendar item appears only when the user answers.
    invitation_in_calendar: bool = True
    # What becomes of an invitation mail once answered with MeetingResponse (the specifications do not say):
    # "deleted_items" (moved there, as Exchange does), "removed" (deleted for good) or "kept".
    invitation_after_response: str = "deleted_items"
    max_meeting_responses: int = 100  # Request elements per MeetingResponse ([MS-ASCMD] 3.1.5.10)
    # One-shot: the next client Change of a calendar item is not applied and gets this Sync status
    # (item status in Responses; 5 and 16, whose scope is global, as the collection's status). Then None again.
    fail_next_calendar_change: object = None
    # One-shot: the next MeetingResponse Request does nothing and gets this Status (3: mailbox error, 4: server
    # error, [MS-ASCMD] 2.2.3.177.9). Then None again.
    fail_next_meeting_response: object = None


# ── Certificates ──────────────────────────────────────────────────────────


class CertMaterial:
    """A throw-away authority and a server certificate for localhost, 127.0.0.1 and ::1."""

    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix="sync443-mock-eas-"))
        self.ca = testcerts.make_ca("Sync443 Mock EAS Test CA")
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

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)


_MATERIAL = None
_MATERIAL_LOCK = threading.Lock()


def cert_material():
    """The process-wide test certificates (made once, removed at exit)."""
    global _MATERIAL
    with _MATERIAL_LOCK:
        if _MATERIAL is None:
            _MATERIAL = CertMaterial()
            atexit.register(_MATERIAL.cleanup)
        return _MATERIAL


def colon_hex(hex_upper):
    return ":".join(hex_upper[i:i + 2] for i in range(0, len(hex_upper), 2))


# ── MIME helpers ──────────────────────────────────────────────────────────


def make_mime(subject="Message de test", sender="expediteur@example.test", to="destinataire@example.test",
              body="Bonjour,\r\n\r\nCeci est un message de test.\r\n", *, cc=None, bcc=None, message_id=None,
              date=None, html_body=None, extra_headers=()):
    """An RFC 5322 message (bytes, CRLF line ends). `to`, `cc`, `bcc`: a string or a list."""
    from email.message import EmailMessage
    msg = EmailMessage(policy=email.policy.SMTP)
    msg["From"] = sender
    msg["To"] = to if isinstance(to, str) else ", ".join(to)
    if cc:
        msg["Cc"] = cc if isinstance(cc, str) else ", ".join(cc)
    if bcc:
        msg["Bcc"] = bcc if isinstance(bcc, str) else ", ".join(bcc)
    msg["Subject"] = subject
    when = date or datetime.datetime.now(datetime.timezone.utc)
    msg["Date"] = email.utils.format_datetime(when)
    msg["Message-ID"] = message_id or email.utils.make_msgid(domain="sync443.test")
    msg["MIME-Version"] = "1.0"
    for name, value in extra_headers:
        msg[name] = value
    msg.set_content(body)
    if html_body is not None:
        msg.add_alternative(html_body, subtype="html")
    return msg.as_bytes()


def _split_mime(mime):
    """(header block, separator, body) of a message; header block without its final line end."""
    for sep in (b"\r\n\r\n", b"\n\n"):
        i = mime.find(sep)
        if i >= 0:
            return mime[:i], sep, mime[i + len(sep):]
    return mime, b"", b""


def _header_fields(mime):
    """[(name, raw value)] of the top header block, unfolded."""
    head, _, _ = _split_mime(mime)
    fields = []
    for line in re.split(rb"\r?\n", head):
        if not line:
            continue
        if line[:1] in (b" ", b"\t") and fields:
            name, value = fields[-1]
            fields[-1] = (name, value + b" " + line.strip())
            continue
        name, sep, value = line.partition(b":")
        if not sep:
            continue
        fields.append((name.strip().decode("ascii", "replace"), value.strip()))
    return fields


def _decode_header(raw):
    text = raw.decode("utf-8", "replace").replace("\x00", "�")
    try:
        return str(email.header.make_header(email.header.decode_header(text))).replace("\x00", "�")
    except Exception:  # noqa: BLE001 - a malformed encoded word is shown as is
        return text


def _valid_mime(mime):
    """A header block of "Name: value" lines, then an empty line."""
    head, sep, _ = _split_mime(mime)
    if not sep or not head:
        return False
    for line in re.split(rb"\r?\n", head):
        if line[:1] in (b" ", b"\t"):
            continue
        if not re.match(rb"^[!-9;-~]+:", line):
            return False
    return True


def _remove_headers(mime, names):
    """The message without the top-level header fields `names` (lower case)."""
    head, sep, body = _split_mime(mime)
    eol = b"\r\n" if b"\r\n" in head or sep == b"\r\n\r\n" else b"\n"
    kept = []
    skipping = False
    for line in re.split(rb"\r?\n", head):
        if line[:1] in (b" ", b"\t"):
            if not skipping:
                kept.append(line)
            continue
        name = line.partition(b":")[0].strip().lower().decode("ascii", "replace")
        skipping = name in names
        if not skipping:
            kept.append(line)
    return eol.join(kept) + sep + body


def _add_headers(mime, fields):
    head, sep, body = _split_mime(mime)
    eol = b"\r\n" if b"\r\n" in head or sep == b"\r\n\r\n" else b"\n"
    extra = b"".join(f"{k}: {v}".encode("ascii") + eol for k, v in fields)
    return extra + mime


class Summary:
    """Header values of a message, decoded for the Email ApplicationData."""

    def __init__(self, mime):
        fields = {}
        for name, value in _header_fields(mime):
            fields.setdefault(name.lower(), value)
        get = lambda n: _decode_header(fields[n]) if n in fields else None  # noqa: E731
        self.subject = get("subject") or ""
        self.sender = get("from") or ""
        self.to = get("to") or ""
        self.cc = get("cc") or ""
        self.bcc = get("bcc") or ""
        self.reply_to = get("reply-to") or ""
        self.message_id = (get("message-id") or "").strip()
        self.date = get("date")
        importance = (get("importance") or "").strip().lower()
        priority = (get("x-priority") or "").strip()[:1]
        if importance == "high" or priority in ("1", "2"):
            self.importance = 2
        elif importance == "low" or priority in ("4", "5"):
            self.importance = 0
        else:
            self.importance = 1
        self.content_type = (get("content-type") or "text/plain").lower()

    def addresses(self, *headers):
        values = [getattr(self, h) for h in headers if getattr(self, h)]
        return [addr for _, addr in email.utils.getaddresses(values) if addr]

    @property
    def display_to(self):
        names = [name or addr for name, addr in email.utils.getaddresses([self.to]) if name or addr]
        return "; ".join(names)


def _text_bodies(mime):
    """(plain text, HTML or None) of a message, for the non-MIME body types."""
    plain, rich = None, None
    try:
        msg = email.message_from_bytes(mime, policy=email.policy.default)
        part = msg.get_body(preferencelist=("plain",))
        if part is not None:
            plain = part.get_content()
        part = msg.get_body(preferencelist=("html",))
        if part is not None:
            rich = part.get_content()
    except Exception:  # noqa: BLE001 - a broken message still has a body
        pass
    if plain is None:
        if rich is not None:
            plain = re.sub(r"<[^>]*>", "", rich)
        else:
            plain = _split_mime(mime)[2].decode("utf-8", "replace")
    return plain.replace("\x00", "�"), (rich.replace("\x00", "�") if rich is not None else None)


def eas_date(when):
    return when.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def _aware(when):
    """A datetime with a time zone (a naive one is taken as UTC), or None."""
    if when is None or when.tzinfo is not None:
        return when
    return when.replace(tzinfo=datetime.timezone.utc)


# ── Calendar, tasks, meetings: values ─────────────────────────────────────

_COMPACT = re.compile(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$")
_DATETIME = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?Z$")
_UTC = datetime.timezone.utc


def _parse_compact(text):
    """Compact DateTime of [MS-ASDTYPE] 2.7.2 ("20261120T093000Z") -> aware datetime, or None."""
    m = _COMPACT.match(text or "")
    if not m:
        return None
    try:
        return datetime.datetime(*(int(g) for g in m.groups()), tzinfo=_UTC)
    except ValueError:
        return None


def _parse_datetime(text):
    """dateTime of [MS-ASDTYPE] 2.3 ("2026-11-20T09:30:00.000Z", milliseconds optional) -> aware datetime, or None."""
    m = _DATETIME.match(text or "")
    if not m:
        return None
    y, mo, d, h, mi, sec = (int(g) for g in m.groups())
    try:
        if h == 24 and mi == 0 and sec == 0:  # hours go up to 24: midnight at the end of the day
            return datetime.datetime(y, mo, d, tzinfo=_UTC) + datetime.timedelta(days=1)
        return datetime.datetime(y, mo, d, h, mi, sec, tzinfo=_UTC)
    except ValueError:
        return None


def compact_date(when):
    return when.astimezone(_UTC).strftime("%Y%m%dT%H%M%SZ")


def _plain_date(when):
    """How the control API shows a date: "YYYY-MM-DDTHH:MM:SSZ" (None stays None)."""
    return None if when is None else when.astimezone(_UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _to_date(value, name="date"):
    """A date given to the control API -> aware UTC datetime (None stays None). Accepted: a datetime (naive: UTC),
    "YYYY-MM-DDTHH:MM:SS[.mmm]Z", "YYYYMMDDTHHMMSSZ" or "YYYY-MM-DD" (midnight UTC)."""
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        return _aware(value).astimezone(_UTC).replace(microsecond=0)
    if isinstance(value, str):
        found = _parse_datetime(value) or _parse_compact(value)
        if found is None and re.match(r"^\d{4}-\d{2}-\d{2}$", value):
            found = _parse_datetime(value + "T00:00:00Z")
        if found is not None:
            return found
    raise ValueError(f"{name} : date invalide {value!r}")


# TimeZone structure of [MS-ASDTYPE] 2.7.6: Bias (LONG), StandardName (32 WCHAR), StandardDate (SYSTEMTIME),
# StandardBias (LONG), DaylightName (32 WCHAR), DaylightDate (SYSTEMTIME), DaylightBias (LONG) = 172 bytes.
TIMEZONE_BYTES = 172


def _tz_name(text):
    data = (text or "").encode("utf-16-le")
    if len(data) > 64:
        raise ValueError("nom de fuseau trop long (32 caractères UTF-16 au plus)")
    return data + bytes(64 - len(data))


def _tz_date(change):
    """A yearly change {"month", "week" (1-5, 5: last), "weekday" (0: Sunday), "hour", "minute"} -> SYSTEMTIME."""
    if not change:
        return bytes(16)
    words = (0, int(change["month"]), int(change.get("weekday", 0)), int(change.get("week", 1)),
             int(change.get("hour", 0)), int(change.get("minute", 0)), 0, 0)
    return b"".join(w.to_bytes(2, "little") for w in words)


def make_timezone(bias=0, standard=None, daylight=None):
    """The 172 bytes of a TimeZone structure. `bias`: minutes to add to local time to get UTC (-60 for UTC+1).
    `standard`, `daylight`: {"name": "", "bias": 0, "change": {"month", "week", "weekday", "hour", "minute"}}
    or None (no name, no bias, no change)."""
    standard, daylight = standard or {}, daylight or {}
    out = (int(bias).to_bytes(4, "little", signed=True)
           + _tz_name(standard.get("name")) + _tz_date(standard.get("change"))
           + int(standard.get("bias", 0)).to_bytes(4, "little", signed=True)
           + _tz_name(daylight.get("name")) + _tz_date(daylight.get("change"))
           + int(daylight.get("bias", 0)).to_bytes(4, "little", signed=True))
    assert len(out) == TIMEZONE_BYTES
    return out


def parse_timezone(data):
    """172 bytes (or their base64 text) -> {"bias", "standard": {"name", "bias", "change"}, "daylight": {…}}.
    "change" is None when the SYSTEMTIME has no month; its "year" is kept when it is not 0."""
    if isinstance(data, str):
        data = base64.b64decode(data, validate=True)
    if len(data) != TIMEZONE_BYTES:
        raise ValueError(f"structure TimeZone de {len(data)} octets (172 attendus)")

    def part(offset):
        name = data[offset:offset + 64].decode("utf-16-le", "replace").split("\x00", 1)[0]
        year, month, weekday, week, hour, minute, _, _ = (
            int.from_bytes(data[offset + 64 + i:offset + 66 + i], "little") for i in range(0, 16, 2))
        change = None
        if month:
            change = {"month": month, "week": week, "weekday": weekday, "hour": hour, "minute": minute}
            if year:
                change["year"] = year
        return {"name": name, "bias": int.from_bytes(data[offset + 80:offset + 84], "little", signed=True),
                "change": change}

    return {"bias": int.from_bytes(data[:4], "little", signed=True), "standard": part(4), "daylight": part(88)}


def _to_timezone(value):
    """A time zone given to the control API -> 172 bytes or None. Accepted: bytes, base64 text, or the
    keyword arguments of make_timezone as a dictionary."""
    if value is None:
        return None
    if isinstance(value, dict):
        return make_timezone(**value)
    data = base64.b64decode(value, validate=True) if isinstance(value, str) else bytes(value)
    if len(data) != TIMEZONE_BYTES:
        raise ValueError(f"structure TimeZone de {len(data)} octets (172 attendus)")
    return data


def _client_timezone(text):
    """The Timezone a client sent -> 172 bytes, or None when it is not a valid structure: base64 of exactly
    172 bytes, and every WCHAR after the end of a name set to 0 ([MS-ASDTYPE] 2.7.6)."""
    try:
        data = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        return None
    if len(data) != TIMEZONE_BYTES:
        return None
    for offset in (4, 88):
        chars = [data[offset + i:offset + i + 2] for i in range(0, 64, 2)]
        if b"\x00\x00" in chars and any(c != b"\x00\x00" for c in chars[chars.index(b"\x00\x00"):]):
            return None
    return data


# GlobalObjId of a meeting request ([MS-ASEMAIL] 2.2.2.37): CLASSID INSTDATE NOW RESERVED BYTECOUNT DATA.
GLOBAL_OBJ_CLASSID = bytes.fromhex("040000008200E00074C5B7101A82E008")
_VCAL_MARK = b"vCal-Uid" + bytes((1, 0, 0, 0))


def global_obj_id(uid):
    """The GlobalObjId (bytes) of a meeting UID. A UID that is itself the hexadecimal form of a GlobalObjId
    (as Outlook writes them) is taken as such; any other UID is wrapped in the vCal-Uid form.
    INSTDATE, NOW and RESERVED are zero, so that the same UID always gives the same value."""
    if re.match(r"^(?:[0-9A-Fa-f]{2}){40,}$", uid) and bytes.fromhex(uid[:32]) == GLOBAL_OBJ_CLASSID:
        raw = bytes.fromhex(uid)
        if int.from_bytes(raw[36:40], "little") == len(raw) - 40:
            return raw
    data = _VCAL_MARK + uid.encode("utf-8") + b"\x00"
    return GLOBAL_OBJ_CLASSID + bytes(4) + bytes(8) + bytes(8) + len(data).to_bytes(4, "little") + data


def uid_of_global_obj_id(data):
    """The meeting UID of a GlobalObjId (bytes or base64 text); raises ValueError if it is not well formed."""
    if isinstance(data, str):
        data = base64.b64decode(data, validate=True)
    if len(data) < 40 or data[:16] != GLOBAL_OBJ_CLASSID:
        raise ValueError("GlobalObjId : CLASSID absent")
    body = data[40:]
    if int.from_bytes(data[36:40], "little") != len(body):
        raise ValueError("GlobalObjId : BYTECOUNT ne correspond pas aux données")
    if body.startswith(_VCAL_MARK):
        if len(body) <= len(_VCAL_MARK) or not body.endswith(b"\x00"):
            raise ValueError("GlobalObjId : UID vCal sans octet nul final")
        return body[len(_VCAL_MARK):-1].decode("utf-8")
    return (data[:16] + bytes(4) + data[20:]).hex().upper()  # the UID of an instance is the one of its series


# iCalendar text of an invitation (RFC 5545, RFC 5546).

def _ical_text(value):
    return (value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
            .replace("\r\n", "\\n").replace("\n", "\\n").replace("\r", "\\n"))


def _ical_param(value):
    return '"' + re.sub(r'[\x00-\x1f\x7f"]', "", value) + '"'


def _ical_fold(line):
    """Lines of at most 75 octets, cut between characters; continuation lines start with a space."""
    out, current, size = [], "", 0
    for ch in line:
        width = len(ch.encode("utf-8"))
        if size + width > 75:
            out.append(current)
            current, size = " ", 1
        current += ch
        size += width
    out.append(current)
    return "\r\n".join(out)


_ICAL_DAYS = ((1, "SU"), (2, "MO"), (4, "TU"), (8, "WE"), (16, "TH"), (32, "FR"), (64, "SA"))


def _ical_rrule(rec, all_day):
    """RRULE of an ActiveSync recurrence ([MS-ASCAL] 2.2.2.37.1)."""
    kind = rec["type"]
    days = ",".join(name for bit, name in _ICAL_DAYS if (rec.get("day_of_week") or 0) & bit)
    parts = []
    if kind == 0 and not days:
        parts.append("FREQ=DAILY")
    elif kind in (0, 1):
        parts += ["FREQ=WEEKLY", f"BYDAY={days}"]
    elif kind == 2:
        parts += ["FREQ=MONTHLY", f"BYMONTHDAY={rec['day_of_month']}"]
    elif kind == 5:
        parts += ["FREQ=YEARLY", f"BYMONTH={rec['month_of_year']}", f"BYMONTHDAY={rec['day_of_month']}"]
    else:
        parts.append("FREQ=MONTHLY" if kind == 3 else "FREQ=YEARLY")
        if kind == 6:
            parts.append(f"BYMONTH={rec['month_of_year']}")
        week = rec["week_of_month"]
        if (rec.get("day_of_week") or 0) == 127 and week == 5:
            parts.append("BYMONTHDAY=-1")
        else:
            parts += [f"BYDAY={days}", f"BYSETPOS={-1 if week == 5 else week}"]
    if (rec.get("interval") or 1) > 1:
        parts.append(f"INTERVAL={rec['interval']}")
    if rec.get("occurrences"):
        parts.append(f"COUNT={rec['occurrences']}")
    elif rec.get("until"):
        parts.append("UNTIL=" + (rec["until"].strftime("%Y%m%d") if all_day else compact_date(rec["until"])))
    if rec.get("first_day_of_week") is not None:
        parts.append("WKST=" + _ICAL_DAYS[rec["first_day_of_week"]][1])
    return ";".join(parts)


def _invitation_ics(inv, method="REQUEST"):
    """The VCALENDAR of an invitation, times in UTC (dates in the meeting's own zone for an all-day event)."""
    def local_day(when):
        bias = parse_timezone(inv["timezone"])["bias"] if inv.get("timezone") else 0
        return (when - datetime.timedelta(minutes=bias)).strftime("%Y%m%d")

    lines = ["BEGIN:VCALENDAR", "PRODID:-//Sync443//Mock EAS//FR", "VERSION:2.0", f"METHOD:{method}", "BEGIN:VEVENT",
             "UID:" + _ical_text(inv["uid"]), "DTSTAMP:" + compact_date(inv["dtstamp"])]
    if inv.get("all_day"):
        lines += ["DTSTART;VALUE=DATE:" + local_day(inv["start"]), "DTEND;VALUE=DATE:" + local_day(inv["end"])]
    else:
        lines += ["DTSTART:" + compact_date(inv["start"]), "DTEND:" + compact_date(inv["end"])]
    lines.append("SUMMARY:" + _ical_text(inv.get("subject") or ""))
    if inv.get("location"):
        lines.append("LOCATION:" + _ical_text(inv["location"]))
    if inv.get("body"):
        lines.append("DESCRIPTION:" + _ical_text(inv["body"]))
    lines.append(f"ORGANIZER;CN={_ical_param(inv.get('organizer_name') or inv['organizer_email'])}"
                 f":mailto:{inv['organizer_email']}")
    rsvp = "TRUE" if inv.get("response_requested") else "FALSE"
    for a in inv.get("attendees") or []:
        role = {2: "OPT-PARTICIPANT", 3: "NON-PARTICIPANT"}.get(a.get("type"), "REQ-PARTICIPANT")
        kind = "RESOURCE" if a.get("type") == 3 else "INDIVIDUAL"
        lines.append(f"ATTENDEE;CUTYPE={kind};ROLE={role};PARTSTAT=NEEDS-ACTION;RSVP={rsvp}"
                     f";CN={_ical_param(a.get('name') or a['email'])}:mailto:{a['email']}")
    if inv.get("recurrence"):
        lines.append("RRULE:" + _ical_rrule(inv["recurrence"], inv.get("all_day")))
    lines += [f"SEQUENCE:{int(inv.get('sequence') or 0)}", "STATUS:CONFIRMED",
              "TRANSP:" + ("TRANSPARENT" if inv.get("busy_status") == 0 else "OPAQUE"),
              "CLASS:" + {2: "PRIVATE", 3: "CONFIDENTIAL"}.get(inv.get("sensitivity"), "PUBLIC"),
              "END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(_ical_fold(line) for line in lines) + "\r\n"


def _calendar_parts(mime):
    """[{"method", "text"}] of the text/calendar parts of a message (method: the Content-Type parameter)."""
    out = []
    try:
        msg = email.message_from_bytes(mime, policy=email.policy.default)
        for part in msg.walk():
            if part.get_content_type() != "text/calendar":
                continue
            method = part.get_param("method")
            raw = part.get_payload(decode=True) or b""
            charset = part.get_content_charset() or "utf-8"
            try:
                text = raw.decode(charset)
            except (LookupError, UnicodeDecodeError):
                text = raw.decode("utf-8", "replace")
            out.append({"method": str(method) if method is not None else None, "text": text})
    except Exception:  # noqa: BLE001 - a message that cannot be read has no calendar part
        return []
    return out


# Calendar class ([MS-ASCAL] 2.2.2). (element, field, first protocol version)
CAL_TOP = (
    ("Timezone", "timezone", "12.1"), ("AllDayEvent", "all_day", "12.1"), ("BusyStatus", "busy_status", "12.1"),
    ("OrganizerName", "organizer_name", "12.1"), ("OrganizerEmail", "organizer_email", "12.1"),
    ("DtStamp", "dtstamp", "12.1"), ("EndTime", "end", "12.1"), ("Location", "location", "12.1"),
    ("Reminder", "reminder", "12.1"), ("Sensitivity", "sensitivity", "12.1"), ("Subject", "subject", "12.1"),
    ("StartTime", "start", "12.1"), ("UID", "uid", "12.1"), ("MeetingStatus", "meeting_status", "12.1"),
    ("Attendees", "attendees", "12.1"), ("Categories", "categories", "12.1"), ("Recurrence", "recurrence", "12.1"),
    ("Exceptions", "exceptions", "12.1"), ("DisallowNewTimeProposal", "disallow_new_time", "14.0"),
    ("ResponseRequested", "response_requested", "14.0"),
)
CAL_FIELD = {name: field for name, field, _ in CAL_TOP}
CAL_SINCE = {name: since for name, _, since in CAL_TOP}
# Elements a request must never carry (2.2.2.2, 2.2.2.33, 2.2.2.34, 2.2.2.40), or that only 16.x defines (2.2.2.13).
CAL_NEVER_IN_REQUEST = {"AppointmentReplyTime": "le client ne doit pas l'envoyer",
                        "ResponseType": "le client ne doit pas l'envoyer",
                        "OnlineMeetingConfLink": "le client ne doit pas l'envoyer",
                        "OnlineMeetingExternalLink": "le client ne doit pas l'envoyer",
                        "ClientUid": "défini à partir de la version 16.0"}
# Children of Supported for the Calendar class ([MS-ASCMD] 2.2.3.179): the required ones, then the optional ones.
SUPPORTED_REQUIRED = ("DtStamp", "Categories", "Sensitivity", "BusyStatus", "UID", "Timezone", "StartTime", "Subject",
                      "Location", "EndTime", "Recurrence", "AllDayEvent", "Reminder", "Exceptions")
SUPPORTED_OPTIONAL = ("Attendees", "OrganizerName", "OrganizerEmail", "MeetingStatus", "ResponseRequested",
                      "DisallowNewTimeProposal")
EXCEPTION_FIELDS = (("Subject", "subject"), ("StartTime", "start"), ("EndTime", "end"), ("Location", "location"),
                    ("Categories", "categories"), ("Sensitivity", "sensitivity"), ("BusyStatus", "busy_status"),
                    ("AllDayEvent", "all_day"), ("Reminder", "reminder"), ("DtStamp", "dtstamp"),
                    ("MeetingStatus", "meeting_status"), ("Attendees", "attendees"))
MEETING_STATUSES = frozenset({0, 1, 3, 5, 7, 9, 11, 13, 15})
ATTENDEE_STATUSES = {"unknown": 0, "tentative": 2, "accepted": 3, "declined": 4, "not-responded": 5}
RECURRENCE_TYPES = frozenset({0, 1, 2, 3, 5, 6})
# CalendarType values a request must not use ([MS-ASCAL] 3.2.5.3; [MS-ASTASK] 2.2.2.4 has no 13, 21, 22 either).
CALENDAR_TYPES_REFUSED = frozenset({13, 16, 17, 18, 19, 21, 22, 23})
EVENT_KEYS = ("uid", "subject", "location", "body", "start", "end", "all_day", "timezone", "dtstamp", "busy_status",
              "sensitivity", "reminder", "categories", "organizer_name", "organizer_email", "attendees",
              "meeting_status", "response_requested", "disallow_new_time", "response_type", "reply_time",
              "recurrence", "exceptions")
EVENT_DATES = ("start", "end", "dtstamp", "reply_time")
RECURRENCE_KEYS = ("type", "interval", "occurrences", "until", "day_of_week", "day_of_month", "week_of_month",
                   "month_of_year", "calendar_type", "is_leap_month", "first_day_of_week")
TASK_KEYS = ("subject", "body", "importance", "start_date", "utc_start_date", "due_date", "utc_due_date",
             "categories", "complete", "date_completed", "sensitivity", "reminder_set", "reminder_time", "recurrence")
TASK_DATES = ("start_date", "utc_start_date", "due_date", "utc_due_date", "date_completed", "reminder_time")
TASK_RECURRENCE_KEYS = ("type", "start", "until", "occurrences", "interval", "day_of_week", "day_of_month",
                        "week_of_month", "month_of_year", "regenerate", "dead_occur", "calendar_type",
                        "is_leap_month", "first_day_of_week")


def _at_least(version, wanted):
    return float(version) >= float(wanted)


class _Refused(Exception):
    """An item the client sent is refused. `violation`: the client broke a rule of the protocol (an element it
    must not send, or that its version does not define), which is also recorded as a protocol error."""

    def __init__(self, reason, violation=False):
        super().__init__(reason)
        self.reason = reason
        self.violation = violation


def _only(parent, allowed_ns, what):
    """{name: element} of the children of `parent`; refuses another namespace, and an element given twice."""
    out = {}
    for c in parent.children:
        if c.ns not in allowed_ns:
            raise _Refused(f"{what} : élément {c.name} étranger à la classe", violation=True)
        key = c.tag if c.ns == allowed_ns[0] else c.name
        if key in out:
            raise _Refused(f"{what} : élément {c.name} en double")
        out[key] = c
    return out


def _text_of(node):
    """Text of a leaf element (strings travel as inline strings, [MS-ASDTYPE] 2.7)."""
    if node.children:
        raise _Refused(f"<{node.name}> : éléments à la place d'une valeur")
    if node.opaque and node.value:
        raise _Refused(f"<{node.name}> : données opaques à la place d'un texte", violation=True)
    return node.text()


def _number(node, low, high):
    text = _text_of(node)
    if not re.match(r"^\d{1,10}$", text) or not low <= int(text) <= high:
        raise _Refused(f"<{node.name}> : valeur {text[:20]!r} hors de {low}-{high}")
    return int(text)


def _flag(node):
    text = _text_of(node)
    if text not in ("0", "1"):
        raise _Refused(f"<{node.name}> : valeur {text[:20]!r} (0 ou 1 attendu)")
    return text == "1"


def _one_of(node, allowed):
    text = _text_of(node)
    if not re.match(r"^\d{1,3}$", text) or int(text) not in allowed:
        raise _Refused(f"<{node.name}> : valeur {text[:20]!r} non admise")
    return int(text)


def _compact_of(node):
    found = _parse_compact(_text_of(node))
    if found is None:
        raise _Refused(f"<{node.name}> : date compacte invalide")
    return found


def _datetime_of(node):
    found = _parse_datetime(_text_of(node))
    if found is None:
        raise _Refused(f"<{node.name}> : date invalide")
    return found


def _body_of(node):
    """airsyncbase:Body of a request ([MS-ASAIRS] 2.2.2.9) -> plain text. Type first, then the optional
    EstimatedDataSize, Truncated (ignored) and Data. The mock keeps plain text: an HTML body loses its tags."""
    order = [c.tag for c in node.children]
    if any(c.ns != "AirSyncBase" for c in node.children) or order[:1] != ["Type"] or len(set(order)) != len(order):
        raise _Refused("Body : Type attendu en premier, chaque élément une seule fois")
    if [t for t in order if t not in ("Type", "EstimatedDataSize", "Truncated", "Data")]:
        raise _Refused("Body : élément inattendu")
    wanted = [t for t in ("Type", "EstimatedDataSize", "Truncated", "Data") if t in order]
    if order != wanted:
        raise _Refused("Body : éléments dans le désordre")
    kind = _text_of(node.child("Type"))
    if kind not in ("1", "2"):
        raise _Refused(f"Body : Type {kind[:10]!r} non pris en charge par le serveur de test (1 ou 2)")
    data = node.child("Data")
    try:
        text = data.text() if data is not None else ""
    except WbxmlError:
        raise _Refused("Body : texte UTF-8 invalide") from None
    if kind == "2":
        text = html.unescape(re.sub(r"<[^>]*>", "", text))
    return text


def _categories_of(node, ns):
    names = []
    for c in node.children:
        if c.name != f"{ns}:Category":
            raise _Refused(f"Categories : élément {c.name} inattendu", violation=True)
        names.append(_text_of(c))
    if len(names) > 300:
        raise _Refused("Categories : plus de 300 catégories")
    return names


def _recurrence_children(node, ns, version, names):
    """{name: element} of a Recurrence, after the checks common to events and tasks."""
    seen = {}
    for c in node.children:
        if c.ns != ns or c.tag not in names:
            raise _Refused(f"Recurrence : élément {c.name} inattendu", violation=True)
        if c.tag in seen:
            raise _Refused(f"Recurrence : élément {c.tag} en double")
        seen[c.tag] = c
    for name, since in (("CalendarType", "14.0"), ("IsLeapMonth", "14.0"), ("FirstDayOfWeek", "14.1")):
        if name in seen and not _at_least(version, since):
            raise _Refused(f"Recurrence : {name} n'existe pas en version {version}", violation=True)
    return seen


def _event_end_of_series(event):
    """When a calendar item stops mattering for FilterType: None (never: an endless series), else a datetime.
    Without expanding the series: Until, or the start plus one period per occurrence (never too early)."""
    rec = event.get("recurrence")
    last = event.get("end") or event.get("start")
    if not rec or last is None:
        return last
    if rec.get("occurrences"):
        weekly = rec["type"] == 1 or (rec["type"] == 0 and rec.get("day_of_week"))
        days = {2: 31, 3: 31, 5: 366, 6: 366}.get(rec["type"], 7 if weekly else 1)
        return last + datetime.timedelta(days=days * (rec.get("interval") or 1) * rec["occurrences"])
    if rec.get("until"):
        return max(last, rec["until"] + datetime.timedelta(days=1))
    return None


def _half_hour_after(now):
    """The current time moved to the next half hour, as in the example of [MS-ASCAL] 3.2.4.4 (18:03 -> 18:30)."""
    base = now.replace(second=0, microsecond=0)
    if base.minute in (0, 30) and base == now.replace(microsecond=0):
        return base
    return base.replace(minute=0) + datetime.timedelta(minutes=30 if base.minute < 30 else 60)


def _plain(value):
    """Fields as the control API shows them: dates as "YYYY-MM-DDTHH:MM:SSZ", bytes as base64 text."""
    if isinstance(value, datetime.datetime):
        return _plain_date(value)
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


# What the control API is given, as stored fields.

def _attendee_fields(value):
    unknown = set(value) - {"email", "name", "status", "type"}
    if unknown or not value.get("email"):
        raise TypeError(f"participant invalide : {value!r}")
    status = value.get("status")
    if isinstance(status, str):
        status = ATTENDEE_STATUSES[status]
    return {"email": str(value["email"]), "name": str(value.get("name") or value["email"]),
            "status": None if status is None else int(status),
            "type": None if value.get("type") is None else int(value["type"])}


def _recurrence_fields(value, keys, dates):
    if value is None:
        return None
    unknown = set(value) - set(keys)
    if unknown or value.get("type") not in RECURRENCE_TYPES:
        raise TypeError(f"récurrence invalide : {value!r}")
    out = {k: None for k in keys}
    for key, v in value.items():
        out[key] = _to_date(v, key) if key in dates else (None if v is None else int(v))
    return out


def _exception_fields(value):
    allowed = {"exception_start", "deleted", "body", "response_type", "reply_time"} | {f for _, f in EXCEPTION_FIELDS}
    unknown = set(value) - allowed
    if unknown or value.get("exception_start") is None:
        raise TypeError(f"exception invalide : {value!r}")
    out = {}
    for key, v in value.items():
        if key in ("exception_start", "start", "end", "dtstamp", "reply_time"):
            v = _to_date(v, key)
        elif key == "attendees":
            v = [_attendee_fields(a) for a in v or []]
        elif key == "categories":
            v = [str(c) for c in v or []]
        elif key == "deleted":
            v = bool(v)
        out[key] = v
    out.setdefault("deleted", False)
    return out


def _event_fields(fields, base=None):
    unknown = set(fields) - set(EVENT_KEYS)
    if unknown:
        raise TypeError(f"champ d'événement inconnu : {sorted(unknown)}")
    out = dict(base or {})
    for key, value in fields.items():
        if key in EVENT_DATES:
            value = _to_date(value, key)
        elif key == "timezone":
            value = _to_timezone(value)
        elif key == "attendees":
            value = [_attendee_fields(a) for a in value or []]
        elif key == "categories":
            value = [str(c) for c in value or []]
        elif key == "recurrence":
            value = _recurrence_fields(value, RECURRENCE_KEYS, ("until",))
        elif key == "exceptions":
            value = [_exception_fields(x) for x in value or []]
        elif key in ("subject", "location", "body", "organizer_name", "organizer_email", "uid"):
            value = None if value in (None, "") else str(value)
        elif key in ("all_day", "response_requested", "disallow_new_time"):
            value = None if value is None else bool(value)
        elif value is not None:
            value = int(value)
        out[key] = value
    return out


def _task_fields(fields, base=None):
    unknown = set(fields) - set(TASK_KEYS)
    if unknown:
        raise TypeError(f"champ de tâche inconnu : {sorted(unknown)}")
    out = dict(base or {})
    for key, value in fields.items():
        if key in TASK_DATES:
            value = _to_date(value, key)
        elif key == "categories":
            value = [str(c) for c in value or []]
        elif key == "recurrence":
            value = _recurrence_fields(value, TASK_RECURRENCE_KEYS, ("start", "until"))
            if value is not None and value["start"] is None:
                raise TypeError("récurrence de tâche sans start")
        elif key in ("subject", "body"):
            value = None if value in (None, "") else str(value)
        elif key in ("complete", "reminder_set"):
            value = None if value is None else bool(value)
        elif value is not None:
            value = int(value)
        out[key] = value
    return out


# What a client sends, as stored fields. Only the elements present are returned: the caller decides what an
# absent element means (nothing for an Add, ghosting for a Change).

def _read_attendees(node, where="Attendees"):
    out = []
    for a in node.children:
        if a.name != "Calendar:Attendee":
            raise _Refused(f"{where} : élément {a.name} inattendu", violation=True)
        parts = {}
        for c in a.children:
            if c.ns != "Calendar" or c.tag not in ("Email", "Name", "AttendeeStatus", "AttendeeType"):
                raise _Refused(f"Attendee : élément {c.name} inattendu", violation=True)
            if c.tag in parts:
                raise _Refused(f"Attendee : élément {c.tag} en double")
            parts[c.tag] = c
        if "Email" not in parts or "Name" not in parts:
            raise _Refused("Attendee sans Email ou sans Name")  # [MS-ASCAL] 2.2.2.3: both are required
        out.append({"email": _text_of(parts["Email"]), "name": _text_of(parts["Name"]),
                    "status": _one_of(parts["AttendeeStatus"], (0, 2, 3, 4, 5)) if "AttendeeStatus" in parts else None,
                    "type": _one_of(parts["AttendeeType"], (1, 2, 3)) if "AttendeeType" in parts else None})
    return out


def _read_cal_recurrence(node, version):
    """Recurrence of an event, with the refusals of [MS-ASCAL] 3.2.5.3 (Status 6)."""
    names = ("Type", "Occurrences", "Interval", "WeekOfMonth", "DayOfWeek", "MonthOfYear", "Until", "DayOfMonth",
             "CalendarType", "IsLeapMonth", "FirstDayOfWeek")
    if not node.children:
        raise _Refused("Recurrence vide")
    kinds = [c for c in node.children if c.name == "Calendar:CalendarType"]
    if len(kinds) > 1:  # 3.2.5.3: more than one CalendarType (the rule names the types 2, 3, 5 and 6)
        raise _Refused("Recurrence : plusieurs CalendarType")
    parts = _recurrence_children(node, "Calendar", version, names)
    if "Type" not in parts:  # 2.2.2.45: required up to 14.1
        raise _Refused("Recurrence sans Type")
    kind = _one_of(parts["Type"], RECURRENCE_TYPES)
    # 3.2.5.3: a child that does not go with the Type.
    for name, allowed in (("DayOfMonth", (2, 5)), ("DayOfWeek", (0, 1, 3, 6)), ("MonthOfYear", (5, 6)),
                          ("WeekOfMonth", (3, 6))):
        if name in parts and kind not in allowed:
            raise _Refused(f"Recurrence : {name} avec Type {kind}")
    # 2.2.2.37.1: the children each Type requires.
    for name in {1: ("DayOfWeek",), 2: ("DayOfMonth",), 3: ("WeekOfMonth", "DayOfWeek"),
                 5: ("DayOfMonth", "MonthOfYear"), 6: ("WeekOfMonth", "MonthOfYear")}.get(kind, ()):
        if name not in parts:
            raise _Refused(f"Recurrence : {name} absent pour le Type {kind}")
    out = {k: None for k in RECURRENCE_KEYS}
    out["type"] = kind
    if "Interval" in parts:
        out["interval"] = _number(parts["Interval"], 0, 999) or 1  # 0: as 1, like Exchange 2010 SP1 and later
    if "Occurrences" in parts:
        out["occurrences"] = _number(parts["Occurrences"], 1, 999)
    if "Until" in parts and "Occurrences" not in parts:  # 3.2.5.3: Occurrences wins, Until is ignored
        out["until"] = _compact_of(parts["Until"])
    elif "Until" in parts:
        _compact_of(parts["Until"])
    if "WeekOfMonth" in parts:
        out["week_of_month"] = _number(parts["WeekOfMonth"], 1, 5)
    if "DayOfWeek" in parts:
        out["day_of_week"] = _number(parts["DayOfWeek"], 1, 127)
    if "MonthOfYear" in parts:
        out["month_of_year"] = _number(parts["MonthOfYear"], 1, 12)
    if "DayOfMonth" in parts:
        out["day_of_month"] = _number(parts["DayOfMonth"], 1, 31)
    if "CalendarType" in parts:
        out["calendar_type"] = _number(parts["CalendarType"], 0, 23)
        if out["calendar_type"] in CALENDAR_TYPES_REFUSED:  # 3.2.5.3
            raise _Refused(f"Recurrence : CalendarType {out['calendar_type']} interdit")
    if "IsLeapMonth" in parts:
        out["is_leap_month"] = int(_flag(parts["IsLeapMonth"]))
    if "FirstDayOfWeek" in parts:
        out["first_day_of_week"] = _number(parts["FirstDayOfWeek"], 0, 6)  # 3.2.5.3: outside 0-6
    return out


def _read_exceptions(node, version):
    out = []
    for x in node.children:
        if x.name != "Calendar:Exception":
            raise _Refused(f"Exceptions : élément {x.name} inattendu", violation=True)
        parts = {}
        for c in x.children:
            key = c.tag if c.ns == "Calendar" else c.name
            if key in parts:
                raise _Refused(f"Exception : élément {key} en double")
            parts[key] = c
        allowed = {"Deleted", "ExceptionStartTime", "AirSyncBase:Body"} | {name for name, _ in EXCEPTION_FIELDS}
        for key, c in parts.items():
            if key in ("AppointmentReplyTime", "ResponseType", "OnlineMeetingConfLink", "OnlineMeetingExternalLink"):
                raise _Refused(f"Exception : {key}, que le client ne doit pas envoyer", violation=True)
            if key not in allowed:
                raise _Refused(f"Exception : élément {c.name} inattendu", violation=True)
        if "Attendees" in parts and not _at_least(version, "14.0"):  # [MS-ASCAL] 2.2.2.4
            raise _Refused(f"Exception : Attendees n'existe pas en version {version}", violation=True)
        if "ExceptionStartTime" not in parts:  # 2.2.2.23: required
            raise _Refused("Exception sans ExceptionStartTime")
        item = {"exception_start": _compact_of(parts["ExceptionStartTime"]), "deleted": False}
        if "Deleted" in parts:
            item["deleted"] = _flag(parts["Deleted"])
        # An empty element removes the value inherited from the series ([MS-ASCAL] 3.1.5.3.1).
        for name, field in (("Subject", "subject"), ("Location", "location")):
            if name in parts:
                item[field] = _text_of(parts[name])
        for name, field in (("StartTime", "start"), ("EndTime", "end"), ("DtStamp", "dtstamp")):
            if name in parts:
                item[field] = _compact_of(parts[name])
        if "AirSyncBase:Body" in parts:
            item["body"] = _body_of(parts["AirSyncBase:Body"]) if parts["AirSyncBase:Body"].children else ""
        if "Categories" in parts:
            item["categories"] = _categories_of(parts["Categories"], "Calendar")
        if "Sensitivity" in parts:
            item["sensitivity"] = _number(parts["Sensitivity"], 0, 3)
        if "BusyStatus" in parts:
            item["busy_status"] = _number(parts["BusyStatus"], 0, 3)
        if "AllDayEvent" in parts:
            item["all_day"] = _flag(parts["AllDayEvent"])
        if "Reminder" in parts:
            item["reminder"] = _reminder_of(parts["Reminder"], version)
        if "MeetingStatus" in parts:
            item["meeting_status"] = _one_of(parts["MeetingStatus"], MEETING_STATUSES)
        if "Attendees" in parts:
            item["attendees"] = _read_attendees(parts["Attendees"], "Exception/Attendees")
        if "end" in item and "start" in item and item["end"] < item["start"]:
            raise _Refused("Exception : EndTime avant StartTime")
        out.append(item)
    if len(out) > 256:  # [MS-ASCAL] 2.2.2.21
        raise _Refused("Exceptions : plus de 256 exceptions")
    starts = [x["exception_start"] for x in out]
    if len(set(starts)) != len(starts):
        raise _Refused("Exceptions : deux exceptions pour la même occurrence")
    return out


def _reminder_of(node, version):
    """Minutes, or None for the empty element, which only 14.1 allows here ([MS-ASCAL] 2.2.2.38)."""
    if node.value in (None, b"") and not node.children:
        if not _at_least(version, "14.1"):
            raise _Refused(f"Reminder vide en version {version}")
        return None
    return _number(node, 0, 4294967295)


def _read_event(data, version):
    """Calendar ApplicationData of an Add or a Change -> {field: value} for the elements present."""
    parts = _only(data, ("Calendar", "AirSyncBase"), "événement")
    given = {}
    for key, node in parts.items():
        if key in CAL_NEVER_IN_REQUEST:
            raise _Refused(f"élément {key} : {CAL_NEVER_IN_REQUEST[key]}", violation=True)
        if key in ("AirSyncBase:Body", "AirSyncBase:NativeBodyType"):
            continue
        if key not in CAL_FIELD:
            raise _Refused(f"élément {node.name} étranger à la classe Calendar", violation=True)
        if not _at_least(version, CAL_SINCE[key]):
            raise _Refused(f"élément {key} : n'existe pas en version {version}", violation=True)
    if "EndTime" in parts and "StartTime" not in parts:  # [MS-ASCAL] 3.2.5.3
        raise _Refused("EndTime sans StartTime")
    if "Timezone" in parts:
        given["timezone"] = _client_timezone(_text_of(parts["Timezone"]))
        if given["timezone"] is None:
            raise _Refused("Timezone : structure invalide (172 octets en base64 attendus)")
    for name in ("AllDayEvent", "ResponseRequested", "DisallowNewTimeProposal"):
        if name in parts:
            given[CAL_FIELD[name]] = _flag(parts[name])
    if "BusyStatus" in parts:  # [MS-ASCAL] 2.2.2.9: 4 does not exist up to 14.1
        given["busy_status"] = _number(parts["BusyStatus"], 0, 3)
    if "Sensitivity" in parts:
        given["sensitivity"] = _number(parts["Sensitivity"], 0, 3)
    if "MeetingStatus" in parts:
        given["meeting_status"] = _one_of(parts["MeetingStatus"], MEETING_STATUSES)
    if "Reminder" in parts:
        given["reminder"] = _reminder_of(parts["Reminder"], version)
    for name in ("DtStamp", "StartTime", "EndTime"):
        if name in parts:
            given[CAL_FIELD[name]] = _compact_of(parts[name])
    for name in ("Subject", "Location", "OrganizerName", "OrganizerEmail", "UID"):
        if name in parts:
            given[CAL_FIELD[name]] = _text_of(parts[name]) or None
    if given.get("organizer_email") and not re.match(r"^[^@\s]+@[^@\s]+$", given["organizer_email"]):
        raise _Refused("OrganizerEmail : adresse invalide")  # [MS-ASCAL] 2.2.2.35, [MS-ASDTYPE] 2.7.3
    if len(given.get("uid") or "") > 300:  # [MS-ASCAL] 2.2.2.46
        raise _Refused("UID de plus de 300 caractères")
    if "Attendees" in parts:
        given["attendees"] = _read_attendees(parts["Attendees"])
    if "Categories" in parts:
        given["categories"] = _categories_of(parts["Categories"], "Calendar")
    if "Recurrence" in parts:
        given["recurrence"] = _read_cal_recurrence(parts["Recurrence"], version)
    if "Exceptions" in parts:
        given["exceptions"] = _read_exceptions(parts["Exceptions"], version)
    if "AirSyncBase:Body" in parts:
        given["body"] = _body_of(parts["AirSyncBase:Body"]) or None
    if "AirSyncBase:NativeBodyType" in parts:
        _one_of(parts["AirSyncBase:NativeBodyType"], (1, 2, 3))
    return given


def _read_task_recurrence(node, version):
    """Recurrence of a task, with the refusals [MS-ASTASK] states (Status 6)."""
    names = ("Type", "Start", "Until", "Occurrences", "Interval", "DayOfWeek", "DayOfMonth", "WeekOfMonth",
             "MonthOfYear", "Regenerate", "DeadOccur", "CalendarType", "IsLeapMonth", "FirstDayOfWeek")
    parts = _recurrence_children(node, "Tasks", version, names)
    if "Type" not in parts:  # [MS-ASTASK] 2.2.2.29
        raise _Refused("Recurrence sans Type")
    if "Start" not in parts:  # [MS-ASTASK] 3.2.5.3.3
        raise _Refused("Recurrence sans Start")
    kind = _one_of(parts["Type"], RECURRENCE_TYPES)
    if "CalendarType" in parts and kind not in (2, 3, 5, 6):  # 2.2.2.4
        raise _Refused(f"Recurrence : CalendarType avec Type {kind}")
    if "DayOfMonth" in parts and kind not in (2, 5):  # 2.2.2.9
        raise _Refused(f"Recurrence : DayOfMonth avec Type {kind}")
    if "DayOfWeek" in parts and kind in (2, 5):  # 2.2.2.10
        raise _Refused(f"Recurrence : DayOfWeek avec Type {kind}")
    if "WeekOfMonth" in parts and kind not in (3, 6):  # 2.2.2.33
        raise _Refused(f"Recurrence : WeekOfMonth avec Type {kind}")
    # The children each Type needs at least once (2.2.2.9, 2.2.2.10, 2.2.2.17, 2.2.2.33).
    for name in {1: ("DayOfWeek",), 2: ("DayOfMonth",), 3: ("DayOfWeek", "WeekOfMonth"),
                 5: ("DayOfMonth", "MonthOfYear"), 6: ("DayOfWeek", "WeekOfMonth", "MonthOfYear")}.get(kind, ()):
        if name not in parts:
            raise _Refused(f"Recurrence : {name} absent pour le Type {kind}")
    out = {k: None for k in TASK_RECURRENCE_KEYS}
    out["type"] = kind
    out["start"] = _datetime_of(parts["Start"])
    if "Occurrences" in parts:
        out["occurrences"] = _number(parts["Occurrences"], 1, 255)
    if "Until" in parts:
        until = _datetime_of(parts["Until"])
        if "Occurrences" not in parts:  # [MS-ASTASK] 3.2.5.3.4: Occurrences wins
            out["until"] = until
    if "Interval" in parts:
        out["interval"] = _number(parts["Interval"], 0, 999) or 1
    if "DayOfWeek" in parts:
        out["day_of_week"] = _number(parts["DayOfWeek"], 1, 127)
    if "DayOfMonth" in parts:
        out["day_of_month"] = _number(parts["DayOfMonth"], 1, 31)
    if "WeekOfMonth" in parts:
        out["week_of_month"] = _number(parts["WeekOfMonth"], 1, 5)
    if "MonthOfYear" in parts:
        out["month_of_year"] = _number(parts["MonthOfYear"], 1, 12)
    if "Regenerate" in parts:
        out["regenerate"] = int(_flag(parts["Regenerate"]))
    if "DeadOccur" in parts:
        out["dead_occur"] = _number(parts["DeadOccur"], 0, 255)
    if "CalendarType" in parts:
        out["calendar_type"] = _number(parts["CalendarType"], 0, 23)
        if out["calendar_type"] in CALENDAR_TYPES_REFUSED:
            raise _Refused(f"Recurrence : CalendarType {out['calendar_type']} interdit")
    if "IsLeapMonth" in parts:
        out["is_leap_month"] = int(_flag(parts["IsLeapMonth"]))
    if "FirstDayOfWeek" in parts:  # 2.2.2.13: a value outside the table is Status 6
        out["first_day_of_week"] = _number(parts["FirstDayOfWeek"], 0, 6)
    return out


TASK_FIELD = {"Subject": "subject", "Importance": "importance", "UtcStartDate": "utc_start_date",
              "StartDate": "start_date", "UtcDueDate": "utc_due_date", "DueDate": "due_date",
              "Categories": "categories", "Recurrence": "recurrence", "Complete": "complete",
              "DateCompleted": "date_completed", "Sensitivity": "sensitivity", "ReminderTime": "reminder_time",
              "ReminderSet": "reminder_set"}


def _read_task(data, version):
    """Tasks ApplicationData of an Add or a Change -> {field: value} for the elements present."""
    parts = _only(data, ("Tasks", "AirSyncBase"), "tâche")
    given = {}
    for key, node in parts.items():
        if key not in TASK_FIELD and key not in ("AirSyncBase:Body", "AirSyncBase:NativeBodyType"):
            raise _Refused(f"élément {node.name} étranger à la classe Tasks", violation=True)
    if "Complete" not in parts:  # [MS-ASTASK] 2.2.2.7: required
        raise _Refused("tâche sans Complete")
    given["complete"] = _flag(parts["Complete"])
    if "Subject" in parts:
        given["subject"] = _text_of(parts["Subject"]) or None
    if "Importance" in parts:  # 2.2.2.14: any value is accepted and returned
        given["importance"] = _number(parts["Importance"], 0, 255)
    if "Sensitivity" in parts:
        given["sensitivity"] = _number(parts["Sensitivity"], 0, 3)
    if "ReminderSet" in parts:  # 2.2.2.22: anything but 0 or 1 is Status 6
        given["reminder_set"] = _flag(parts["ReminderSet"])
    for name in ("UtcStartDate", "StartDate", "UtcDueDate", "DueDate", "DateCompleted", "ReminderTime"):
        if name in parts:
            given[TASK_FIELD[name]] = _datetime_of(parts[name])
    if "Categories" in parts:
        given["categories"] = _categories_of(parts["Categories"], "Tasks")
    if "Recurrence" in parts:
        given["recurrence"] = _read_task_recurrence(parts["Recurrence"], version)
    if "AirSyncBase:Body" in parts:
        given["body"] = _body_of(parts["AirSyncBase:Body"]) or None
    if "AirSyncBase:NativeBodyType" in parts:
        _one_of(parts["AirSyncBase:NativeBodyType"], (1, 2, 3))
    return given


# ── Data model ────────────────────────────────────────────────────────────


class Item:
    """A message (mime set), an event or a task (pim set: its fields), or another item (raw ApplicationData
    children). A message that is an invitation also has `invitation`: the fields of its MeetingRequest."""

    _seq = 0

    def __init__(self, server_id, *, mime=None, raw=None, pim=None, cls="Email", read=False, flag=0, date=None):
        Item._seq += 1
        self.seq = Item._seq
        self.server_id = server_id
        self.mime = mime
        self.raw = raw
        self.pim = pim
        self.invitation = None
        self.cls = cls
        self.read = bool(read)
        self.flag = int(flag)  # 0 none, 1 complete, 2 flagged ([MS-ASEMAIL] FlagStatus)
        self.categories = []
        self.date = _aware(date) or _utcnow()
        self.version = 1
        self._summary = None

    @property
    def summary(self):
        if self._summary is None:
            self._summary = Summary(self.mime or b"")
        return self._summary

    def view(self, folder_id):
        out = {"server_id": self.server_id, "folder_id": folder_id, "class": self.cls, "read": self.read,
               "flag": self.flag, "flagged": self.flag == 2, "categories": list(self.categories),
               "date": self.date, "version": self.version}
        if self.mime is not None:
            s = self.summary
            out.update(mime=self.mime, subject=s.subject, sender=s.sender, to=s.to,
                       message_id=s.message_id.strip("<>"))
        if self.invitation is not None:
            out["invitation"] = _plain(self.invitation)
        return out


class Folder:
    def __init__(self, server_id, parent_id, name, type_):
        self.server_id = server_id
        self.parent_id = parent_id
        self.name = name
        self.type = type_
        self.items = {}  # ServerId -> Item, in insertion order
        self.next_item = 1

    @property
    def cls(self):
        return class_of_type(self.type)

    def new_item_id(self):
        sid = f"{self.server_id}:{self.next_item}"
        self.next_item += 1
        return sid

    def view(self):
        return {"server_id": self.server_id, "parent_id": self.parent_id, "name": self.name, "type": self.type,
                "class": self.cls, "count": len(self.items)}


class _KeyedState:
    """A sync state with a current key and the previous one (a client may resend it after a lost response)."""

    def __init__(self, counter=1):
        self.counter = counter
        self.known = {}
        self.prev = None  # (counter, known)

    def key_of(self, counter):
        raise NotImplementedError

    @property
    def key(self):
        return self.key_of(self.counter)

    @property
    def prev_key(self):
        return self.key_of(self.prev[0]) if self.prev else None

    def advance(self, known):
        self.prev = (self.counter, self.known)
        self.counter += 1
        self.known = known

    def rollback(self):
        self.counter, self.known = self.prev
        self.prev = None


class CollectionState(_KeyedState):
    """What one device has of one collection: ServerId -> version it has seen."""

    def __init__(self, collection_id):
        super().__init__()
        self.collection_id = collection_id
        self.uuid = str(uuid.uuid4()).upper()
        self.options = {}
        self.supported = None  # None: no Supported element; else the names it listed (empty: all ghosted)

    def key_of(self, counter):
        return f"{{{self.uuid}}}{counter}"


class HierarchyState(_KeyedState):
    """What one device has of the folder hierarchy: ServerId -> (ParentId, DisplayName, Type)."""

    def key_of(self, counter):
        return str(counter)


class Device:
    def __init__(self, user, device_id, device_type):
        self.user = user
        self.device_id = device_id
        self.device_type = device_type
        self.policy_key = None
        self.policy_version = None
        self.pending_key = None
        self.ack_status = None
        self.wipe = None  # None, "device" or "account"
        self.wipe_notified = 0
        self.wipe_ack = None
        self.hierarchy = None
        self.hierarchy_counter = 0  # never reused, so an old key cannot match a new state
        self.collections = {}
        self.last_ping = None  # (heartbeat, [(id, class)])
        self.last_sync = None
        self.info = {}
        self.client_ids = set()
        self.pending_wake = None


class User:
    def __init__(self, login, password, address, display_name):
        self.login = login
        self.password = password
        self.email = address
        self.display_name = display_name
        self.folders = {}
        self.next_folder = 1
        self.devices = {}

    def names(self):
        names = {self.login.lower(), self.email.lower()}
        if "@" in self.email:
            names.add(self.email.split("@", 1)[0].lower())
        return names


class _HttpAbort(Exception):
    def __init__(self, status, message="", headers=(), body=b""):
        super().__init__(message or REASONS.get(status, ""))
        self.status = status
        self.message = message
        self.headers = list(headers)
        self.body = body


class _Drop(Exception):
    """Close the connection without answering."""


class _Request:
    def __init__(self, method, target, headers, body, conn, record):
        self.method = method
        self.target = target
        self.headers = headers  # lower-case name -> [values]
        self.body = body
        self.conn = conn
        self.record = record

    def header(self, name):
        values = self.headers.get(name.lower())
        return values[0] if values else None


class _Ctx:
    """One command being served."""

    def __init__(self, req, cmd, user, device, version, doc):
        self.req = req
        self.cmd = cmd
        self.user = user
        self.device = device
        self.version = version
        self.doc = doc
        self.record = req.record


_TOKEN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_REQUEST_LINE = re.compile(r"^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\S+) HTTP/(\d)\.(\d)$")
_DEVICE_ID = re.compile(r"^[A-Za-z0-9]{1,32}$")
_DEVICE_TYPE = re.compile(r"^[\x21-\x7e]{1,32}$")
_SYNC_KEY = re.compile(r"^[\x21-\x7e]{1,64}$")
_ITEM_ID = re.compile(r"^[^\x00-\x1f\x7f]{1,64}$")


def _status_doc(cmd, status, *extra):
    return el(ROOTS[cmd], [el("Status", str(status)), *extra])


# ── Server ────────────────────────────────────────────────────────────────


class MockEasServer:
    """The test server and its control API (every public method is thread-safe).

    Folders and items are named by ServerId; `folder` arguments also accept a
    folder type (int: first folder of that type) or a path of display names
    ("Inbox/Projets"). Users are named by login.
    """

    def __init__(self, host="127.0.0.1", port=0, options=None, **overrides):
        self.host = host
        self.requested_port = port
        self.options = options or ServerOptions()
        for k, v in overrides.items():
            if not hasattr(self.options, k):
                raise TypeError(f"option inconnue : {k}")
            setattr(self.options, k, v)
        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._users = {}
        self._requests = []
        self._actions = []
        self._sent = []
        self._meeting_responses = []
        self._protocol_errors = []
        self._internal_errors = []
        self._faults = []
        self._pings = {}
        self._policy_version = 1
        self._seq = 0
        self._stopping = False
        self._sock = None
        self._threads = []
        self._conns = set()
        self.port = None
        self._material = None

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def start(self):
        self._material = cert_material()
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(self._material.chain_path, self._material.key_path)
        self._ssl = ctx
        family = socket.AF_INET6 if ":" in self.host else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.bind((self.host, self.requested_port))
        sock.listen(64)
        sock.settimeout(0.2)
        self._sock = sock
        self.port = sock.getsockname()[1]
        t = threading.Thread(target=self._accept_loop, name="mock-eas-accept", daemon=True)
        t.start()
        self._accept_thread = t
        return self

    def stop(self):
        with self._cond:
            self._stopping = True
            self._cond.notify_all()
        if self._sock is not None:
            self._accept_thread.join(timeout=5)
            try:
                self._sock.close()
            except OSError:
                pass
        with self._lock:
            conns = list(self._conns)
        for c in conns:
            try:
                c.shutdown(socket.SHUT_RDWR)  # wakes a thread blocked in recv(), which close() alone may not
            except (OSError, ValueError):
                pass
            try:
                c.close()
            except OSError:
                pass
        for t in list(self._threads):
            t.join(timeout=5)

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()

    @property
    def origin(self):
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"https://{host}:{self.port}"

    @property
    def url(self):
        return self.origin + EAS_PATH

    @property
    def ca_cert_path(self):
        """PEM file of the test authority (to add to the test profile)."""
        return self._material.ca_path

    @property
    def ca_pem(self):
        return self._material.ca_pem

    @property
    def ca_der(self):
        return self._material.ca_der

    @property
    def ca_sha256(self):
        """SHA-256 of the authority's certificate, 64 upper-case hex digits (the client's pin format)."""
        return self._material.ca_sha256

    @property
    def ca_sha256_colon(self):
        """Same, "AA:BB:…" (as Gecko shows it)."""
        return colon_hex(self._material.ca_sha256)

    @property
    def leaf_sha256(self):
        return self._material.leaf_sha256

    @property
    def cert_path(self):
        return self._material.cert_path

    # ── Users, folders, items (control API) ──────────────────────────────

    def add_user(self, login, password, email_address=None, display_name=None, *, default_folders=True,
                 pim_samples=True):
        """A mailbox. Default folders: Inbox, Drafts, Deleted Items, Sent Items, Outbox, Junk Email (mail),
        Calendar, Contacts, Tasks, Notes, Journal; with pim_samples, one event, contact and task in them
        (the event and the task as typed items, see events() and tasks())."""
        address = email_address or (login if "@" in login else f"{login}@example.test")
        with self._cond:
            if login in self._users:
                raise ValueError(f"utilisateur déjà présent : {login}")
            user = User(login, password, address, display_name or address.split("@")[0])
            self._users[login] = user
            if default_folders:
                for name, type_ in (("Inbox", 2), ("Drafts", 3), ("Deleted Items", 4), ("Sent Items", 5),
                                    ("Outbox", 6), ("Junk Email", 12), ("Calendar", 8), ("Contacts", 9),
                                    ("Tasks", 7), ("Notes", 10), ("Journal", 11)):
                    self._new_folder(user, "0", name, type_)
                if pim_samples:
                    self._add_pim_samples(user)
            self._changed()
            return login

    def set_password(self, login, password):
        with self._cond:
            self._user(login).password = password

    def users(self):
        with self._lock:
            return [{"login": u.login, "email": u.email, "display_name": u.display_name,
                     "devices": sorted(u.devices)} for u in self._users.values()]

    def folder_id(self, login, ref):
        """ServerId of a folder: `ref` is a ServerId, a type (int) or a path of display names."""
        with self._lock:
            return self._folder(self._user(login), ref).server_id

    def folders(self, login):
        with self._lock:
            return [f.view() for f in self._user(login).folders.values()]

    def add_folder(self, login, name, parent="0", type_=FolderType.USER_MAIL):
        """A folder created on the server (seen by devices at their next FolderSync). -> ServerId"""
        with self._cond:
            user = self._user(login)
            parent_id = "0" if parent in ("0", None) else self._folder(user, parent).server_id
            folder = self._new_folder(user, parent_id, name, int(type_))
            self._changed()
            return folder.server_id

    def rename_folder(self, login, folder, name=None, parent=None):
        """Rename and/or move a folder on the server."""
        with self._cond:
            user = self._user(login)
            f = self._folder(user, folder)
            if name is not None:
                f.name = name
            if parent is not None:
                pid = "0" if parent == "0" else self._folder(user, parent).server_id
                if pid == f.server_id or pid in self._descendants(user, f.server_id):
                    raise ValueError("un dossier ne peut pas aller dans lui-même")
                f.parent_id = pid
            self._changed()

    def delete_folder(self, login, folder):
        """Delete a folder, its subfolders and their items. -> deleted ServerIds"""
        with self._cond:
            user = self._user(login)
            f = self._folder(user, folder)
            ids = [f.server_id, *self._descendants(user, f.server_id)]
            for fid in ids:
                user.folders.pop(fid, None)
            self._changed()
            return ids

    def add_message(self, login, folder=FolderType.INBOX, mime=None, *, subject=None, sender=None, to=None,
                    body=None, read=False, flagged=False, date=None, message_id=None):
        """A message stored on the server (new mail for the devices). -> ServerId"""
        with self._cond:
            user = self._user(login)
            f = self._folder(user, folder)
            if mime is None:
                mime = make_mime(subject or "Message de test", sender or "expediteur@example.test",
                                 to or user.email, body if body is not None else "Bonjour.\r\n",
                                 message_id=message_id, date=date)
            item = Item(f.new_item_id(), mime=bytes(mime), read=read, flag=2 if flagged is True else int(flagged),
                        date=date)
            f.items[item.server_id] = item
            self._changed()
            return item.server_id

    def deliver(self, login, mime):
        """New mail in the Inbox. -> ServerId"""
        return self.add_message(login, FolderType.INBOX, mime)

    def add_raw_item(self, login, folder, application_data, cls=None):
        """A non-mail item sent as it is: `application_data` is a list of Elements (children of ApplicationData).
        For events and tasks, add_event and add_task make items the server understands."""
        with self._cond:
            user = self._user(login)
            f = self._folder(user, folder)
            item = Item(f.new_item_id(), raw=list(application_data), cls=cls or f.cls)
            f.items[item.server_id] = item
            self._changed()
            return item.server_id

    def messages(self, login, folder):
        """Items of a folder, as dicts (server_id, read, flag, flagged, mime, subject, message_id…)."""
        with self._lock:
            f = self._folder(self._user(login), folder)
            return [i.view(f.server_id) for i in f.items.values()]

    def message(self, login, folder, server_id):
        with self._lock:
            f = self._folder(self._user(login), folder)
            item = f.items.get(server_id)
            return item.view(f.server_id) if item else None

    def find_messages(self, login, *, subject=None, message_id=None, folder=None):
        """Messages of a user (or of one folder) by subject and/or Message-ID (without <>)."""
        with self._lock:
            user = self._user(login)
            folders = [self._folder(user, folder)] if folder is not None else list(user.folders.values())
            out = []
            for f in folders:
                for item in f.items.values():
                    if item.mime is None:
                        continue
                    if subject is not None and item.summary.subject != subject:
                        continue
                    if message_id is not None and item.summary.message_id.strip("<>") != message_id.strip("<>"):
                        continue
                    out.append(item.view(f.server_id))
            return out

    def set_read(self, login, folder, server_id, read=True):
        self._modify(login, folder, server_id, lambda i: setattr(i, "read", bool(read)))

    def set_flag(self, login, folder, server_id, flagged=True):
        """flagged: True/False, or a FlagStatus (0 none, 1 complete, 2 flagged)."""
        status = 2 if flagged is True else 0 if flagged is False else int(flagged)
        self._modify(login, folder, server_id, lambda i: setattr(i, "flag", status))

    def set_option(self, name, value):
        """Change a server option while running (the scenario plays another kind of server)."""
        with self._cond:
            if not hasattr(self.options, name):
                raise ValueError(f"option inconnue : {name}")
            setattr(self.options, name, value)

    def set_message_date(self, login, folder, server_id, when):
        """Change the received date (an older date can take a message out of a device's FilterType: SoftDelete)."""
        self._modify(login, folder, server_id, lambda i: setattr(i, "date", _aware(when)), bump=False)

    def delete_message(self, login, folder, server_id):
        with self._cond:
            f = self._folder(self._user(login), folder)
            if f.items.pop(server_id, None) is None:
                raise KeyError(f"élément inconnu : {server_id}")
            self._changed()

    def move_message(self, login, folder, server_id, destination):
        """Move on the server (devices see a Delete and an Add). -> new ServerId"""
        with self._cond:
            user = self._user(login)
            src = self._folder(user, folder)
            dst = self._folder(user, destination)
            if server_id not in src.items:
                raise KeyError(f"élément inconnu : {server_id}")
            new_id = self._move_item(src, server_id, dst)
            self._changed()
            return new_id

    def mass_delete(self, login, folder, count=None):
        """Delete `count` items (all by default), oldest first. -> deleted ServerIds"""
        with self._cond:
            f = self._folder(self._user(login), folder)
            ids = list(f.items)[:count] if count is not None else list(f.items)
            for sid in ids:
                del f.items[sid]
            self._changed()
            return ids

    # ── Calendar and tasks (control API) ─────────────────────────────────
    #
    # Dates are given as datetime (naive: UTC) or text ("2026-11-20T09:30:00Z", "20261120T093000Z",
    # "2026-11-20") and read back as "YYYY-MM-DDTHH:MM:SSZ". A time zone is given as its 172 bytes, their
    # base64 text or the arguments of make_timezone, and read back as base64 text ("timezone") and decoded
    # ("zone"). Everything else is plain numbers, texts, lists and dictionaries, so that it travels as JSON.

    def add_event(self, login, folder=FolderType.CALENDAR, **fields):
        """An event stored on the server (devices get an Add). -> ServerId
        Fields, all optional: uid, subject, location, body (plain text), start, end (default: tomorrow, one
        hour), all_day, timezone (default: UTC), dtstamp, busy_status (0-3), sensitivity (0-3), reminder (minutes),
        categories, organizer_name, organizer_email, attendees ([{email, name, status, type}]), meeting_status
        (default: 0, or with attendees 1 when the organizer is the user and 3 otherwise), response_requested,
        disallow_new_time, response_type, reply_time, recurrence ({type, interval, occurrences, until,
        day_of_week, day_of_month, week_of_month, month_of_year, calendar_type, is_leap_month, first_day_of_week}),
        exceptions ([{exception_start, deleted, subject, start, end, location, body, categories, sensitivity,
        busy_status, all_day, reminder, dtstamp, meeting_status, attendees, response_type, reply_time}]; in an
        exception, an empty text or list means "not inherited from the series")."""
        with self._cond:
            user = self._user(login)
            f = self._folder(user, folder)
            if f.cls != "Calendar":
                raise TypeError(f"le dossier {f.name} n'est pas un agenda")
            item = Item(f.new_item_id(), pim=self._new_event(user, _event_fields(fields)), cls="Calendar")
            f.items[item.server_id] = item
            self._changed()
            return item.server_id

    def change_event(self, login, folder, server_id, **fields):
        """Change fields of an event on the server (same fields as add_event; the others stay). Devices get a
        Change. DtStamp becomes the current time unless given."""
        with self._cond:
            item = self._pim_item(login, folder, server_id, "Calendar")
            changed = _event_fields(fields, item.pim)
            if "dtstamp" not in fields:
                changed["dtstamp"] = _utcnow().replace(microsecond=0)
            if not changed.get("recurrence"):
                changed["exceptions"] = []
            item.pim = changed
            item.version += 1
            self._changed()

    def delete_event(self, login, folder, server_id):
        """Delete an event on the server (devices get a Delete)."""
        with self._cond:
            item = self._pim_item(login, folder, server_id, "Calendar")
            del self._folder(self._user(login), folder).items[item.server_id]
            self._changed()

    def events(self, login, folder=FolderType.CALENDAR):
        """What a calendar folder holds: one dictionary per item, with server_id, folder_id, version and the
        fields of add_event (an item added with add_raw_item has "raw": True instead of fields)."""
        with self._lock:
            f = self._folder(self._user(login), folder)
            return [self._pim_view(i, f) for i in f.items.values()]

    def event(self, login, folder, server_id):
        with self._lock:
            f = self._folder(self._user(login), folder)
            item = f.items.get(server_id)
            return self._pim_view(item, f) if item is not None else None

    def find_events(self, login, *, uid=None, subject=None):
        """Events of every calendar folder of a user, by UID and/or subject."""
        with self._lock:
            out = []
            for f in self._user(login).folders.values():
                for item in f.items.values():
                    if f.cls != "Calendar" or item.pim is None:
                        continue
                    if (uid is None or item.pim.get("uid") == uid) and (
                            subject is None or item.pim.get("subject") == subject):
                        out.append(self._pim_view(item, f))
            return out

    def set_attendee_status(self, login, folder, server_id, email_address, status):
        """Record an attendee's answer in the organizer's event, as when a reply arrives. `status`: 0 unknown,
        2 tentative, 3 accepted, 4 declined, 5 not responded (or these names). Devices get a Change."""
        code = ATTENDEE_STATUSES[status] if isinstance(status, str) else int(status)
        if code not in ATTENDEE_STATUSES.values():
            raise ValueError(f"statut de participant invalide : {status!r}")
        with self._cond:
            item = self._pim_item(login, folder, server_id, "Calendar")
            found = [a for a in item.pim.get("attendees") or [] if a["email"].lower() == email_address.lower()]
            if not found:
                raise KeyError(f"participant inconnu : {email_address}")
            for a in found:
                a["status"] = code
            item.pim["dtstamp"] = _utcnow().replace(microsecond=0)
            item.version += 1
            self._changed()

    def cancel_meeting(self, login, folder, server_id):
        """Mark a meeting as cancelled (MeetingStatus 5 for its organizer, 7 for an attendee), as when the
        cancellation is processed. Devices get a Change."""
        with self._cond:
            item = self._pim_item(login, folder, server_id, "Calendar")
            status = item.pim.get("meeting_status") or 0
            if not status & 1:
                raise ValueError("cet événement n'est pas une réunion")
            item.pim["meeting_status"] = status | 4
            item.pim["dtstamp"] = _utcnow().replace(microsecond=0)
            item.version += 1
            self._changed()

    def add_task(self, login, folder=FolderType.TASKS, **fields):
        """A task stored on the server (devices get an Add). -> ServerId
        Fields, all optional: subject, body (plain text), importance (0-2, default 1), start_date,
        utc_start_date, due_date, utc_due_date, categories, complete, date_completed (default: now when
        complete), sensitivity (0-3), reminder_set, reminder_time, recurrence ({type, start, until, occurrences,
        interval, day_of_week, day_of_month, week_of_month, month_of_year, regenerate, dead_occur,
        calendar_type, is_leap_month, first_day_of_week})."""
        with self._cond:
            f = self._folder(self._user(login), folder)
            if f.cls != "Tasks":
                raise TypeError(f"le dossier {f.name} n'est pas un dossier de tâches")
            task = {"importance": 1, "complete": False, "sensitivity": 0, "reminder_set": False}
            item = Item(f.new_item_id(), pim=self._settled_task(_task_fields(fields, task)), cls="Tasks")
            f.items[item.server_id] = item
            self._changed()
            return item.server_id

    def change_task(self, login, folder, server_id, **fields):
        """Change fields of a task on the server (same fields as add_task; the others stay)."""
        with self._cond:
            item = self._pim_item(login, folder, server_id, "Tasks")
            item.pim = self._settled_task(_task_fields(fields, item.pim))
            item.version += 1
            self._changed()

    def delete_task(self, login, folder, server_id):
        """Delete a task on the server (devices get a Delete)."""
        with self._cond:
            item = self._pim_item(login, folder, server_id, "Tasks")
            del self._folder(self._user(login), folder).items[item.server_id]
            self._changed()

    def tasks(self, login, folder=FolderType.TASKS):
        """What a task folder holds: one dictionary per item, with server_id, folder_id, version and the
        fields of add_task."""
        with self._lock:
            f = self._folder(self._user(login), folder)
            return [self._pim_view(i, f) for i in f.items.values()]

    def task(self, login, folder, server_id):
        with self._lock:
            f = self._folder(self._user(login), folder)
            item = f.items.get(server_id)
            return self._pim_view(item, f) if item is not None else None

    def find_tasks(self, login, *, subject=None):
        """Tasks of every task folder of a user, by subject."""
        with self._lock:
            return [self._pim_view(item, f) for f in self._user(login).folders.values() for item in f.items.values()
                    if f.cls == "Tasks" and item.pim is not None
                    and (subject is None or item.pim.get("subject") == subject)]

    # ── Meetings (control API) ───────────────────────────────────────────

    def deliver_invitation(self, login, *, organizer, subject="Réunion de test", start=None, end=None, uid=None,
                           organizer_name=None, location=None, body=None, all_day=False, timezone=None,
                           attendees=None, response_requested=True, recurrence=None, sensitivity=0, busy_status=2,
                           reminder=15, message_type=1, disallow_new_time=False, sequence=0, dtstamp=None,
                           date=None, read=False):
        """An invitation from `organizer` (an address) arrives for a user: a mail in the Inbox whose
        MessageClass is IPM.Schedule.Meeting.Request, with the MeetingRequest element ([MS-ASEMAIL] 2.2.2.48,
        GlobalObjId built from the UID) and a MIME body carrying a text/calendar; method=REQUEST part. With the
        option invitation_in_calendar, the meeting is also put in the user's Calendar, not yet answered; an
        invitation whose UID is already there updates that item.
        attendees: [{email, name, type}] (default: the user alone); message_type: MeetingMessageType (14.1).
        -> {"uid", "mail_id", "collection_id" (the Inbox), "calendar_id" (None without the calendar copy)}"""
        with self._cond:
            user = self._user(login)
            inbox = self._folder(user, FolderType.INBOX)
            now = _utcnow().replace(microsecond=0)
            begin = _to_date(start, "start") or (now.replace(minute=0, second=0) + datetime.timedelta(days=1))
            inv = {
                "uid": uid or uuid.uuid4().hex.upper(), "subject": subject, "location": location or None,
                "body": body or None, "start": begin,
                "end": _to_date(end, "end") or begin + datetime.timedelta(hours=1), "all_day": bool(all_day),
                "timezone": _to_timezone(timezone) or make_timezone(), "dtstamp": _to_date(dtstamp, "dtstamp") or now,
                "organizer_email": organizer, "organizer_name": organizer_name or organizer.split("@")[0],
                "attendees": [_attendee_fields(a) for a in attendees or [{"email": user.email,
                                                                           "name": user.display_name, "type": 1}]],
                "response_requested": bool(response_requested),
                "recurrence": _recurrence_fields(recurrence, RECURRENCE_KEYS, ("until",)),
                "sensitivity": int(sensitivity), "busy_status": int(busy_status),
                "reminder": None if reminder is None else int(reminder), "message_type": int(message_type),
                "disallow_new_time": bool(disallow_new_time), "sequence": int(sequence),
            }
            if organizer.lower() == user.email.lower():
                raise ValueError("une invitation vient d'un autre organisateur que l'utilisateur")
            item = Item(inbox.new_item_id(), mime=self._invitation_mime(user, inv, date), read=read, date=date)
            item.invitation = inv
            inbox.items[item.server_id] = item
            calendar_id = None
            if self.options.invitation_in_calendar:
                calendar_id = self._meeting_to_calendar(user, inv, response_type=5, busy_status=1, replied=None)
            self._changed()
            return {"uid": inv["uid"], "mail_id": item.server_id, "collection_id": inbox.server_id,
                    "calendar_id": calendar_id}

    def meeting_responses(self, login=None, since=0):
        """MeetingResponse requests received, one dictionary per Request: seq, time, user, device, response
        (1 accept, 2 tentative, 3 decline), answer ("accepted", "tentative", "declined"), collection_id,
        request_id, instance_id, source ("mail" or "calendar"), uid and organizer (of the meeting, when found),
        status (as answered) and calendar_id."""
        with self._lock:
            return [dict(r) for r in self._meeting_responses
                    if r["seq"] > since and (login is None or r["user"] == login)]

    def sent_calendar_parts(self, login=None, since=0):
        """The calendar parts of what users sent with SendMail: one dictionary per accepted message that has
        a text/calendar part, with seq, user, client_id, sender, to, cc, bcc (lists of addresses), subject and
        parts: [{"method" (the Content-Type parameter, as sent), "text" (decoded)}]."""
        out = []
        for m in self.sent_mails(login):
            if m["seq"] <= since or m["status"] != "1":
                continue
            parts = _calendar_parts(m["mime"])
            if not parts:
                continue
            s = Summary(m["mime"])
            out.append({"seq": m["seq"], "user": m["user"], "client_id": m["client_id"], "sender": s.sender,
                        "to": s.addresses("to"), "cc": s.addresses("cc"), "bcc": s.addresses("bcc"),
                        "subject": s.subject, "parts": parts})
        return out

    # ── Devices ───────────────────────────────────────────────────────────

    def set_remote_wipe(self, login, device_id, on=True, account_only=False):
        """Ask (or stop asking) a device to wipe itself: Status 140 on its commands, RemoteWipe in Provision."""
        with self._cond:
            dev = self._device(self._user(login), device_id, create=True)
            dev.wipe = ("account" if account_only else "device") if on else None
            self._changed()

    def refresh_policy(self):
        """New policy: every device must provision again (Status 143, or 449 in 12.x)."""
        with self._cond:
            self._policy_version += 1
            self._changed()

    def reset_device(self, login, device_id):
        """Forget every sync state of a device (its keys then get Status 3 / 9)."""
        with self._cond:
            dev = self._device(self._user(login), device_id)
            dev.hierarchy = None
            dev.collections.clear()
            dev.last_ping = None
            dev.last_sync = None
            self._changed()

    def invalidate_sync_state(self, login, device_id, folder=None):
        """Drop one collection state (or all): the next Sync with the old key gets Status 3."""
        with self._cond:
            user = self._user(login)
            dev = self._device(user, device_id)
            if folder is None:
                dev.collections.clear()
            else:
                dev.collections.pop(self._folder(user, folder).server_id, None)
            self._changed()

    def devices(self, login):
        with self._lock:
            return sorted(self._user(login).devices)

    def device_state(self, login, device_id):
        """Everything the server keeps for a device (keys, known items and folders, policy, wipe, info)."""
        with self._lock:
            dev = self._device(self._user(login), device_id)
            h = dev.hierarchy
            return {
                "device_id": dev.device_id, "device_type": dev.device_type, "info": dict(dev.info),
                "policy_key": dev.policy_key, "provisioned": dev.policy_key is not None,
                "ack_status": dev.ack_status, "wipe": dev.wipe, "wipe_notified": dev.wipe_notified,
                "wipe_ack": dev.wipe_ack,
                "hierarchy_key": h.key if h else None, "known_folders": dict(h.known) if h else {},
                "collections": {cid: {"key": s.key, "known": dict(s.known), "options": dict(s.options),
                                      "supported": None if s.supported is None else sorted(s.supported)}
                                for cid, s in dev.collections.items()},
                "last_ping": dev.last_ping,
            }

    # ── Push ──────────────────────────────────────────────────────────────

    def wake_ping(self, login=None, device_id=None, folders=None, remember=False):
        """End waiting Pings with Status 2 (`folders`: ServerIds to report, default: all pinged).
        remember: if no Ping is waiting, the device's next Ping returns at once. -> Pings woken"""
        with self._cond:
            woken = 0
            for entry in self._pings.values():
                if (login is None or entry["user"] == login) and (device_id is None or entry["device"] == device_id):
                    entry["forced"] = list(folders) if folders else list(entry["folders"])
                    woken += 1
            if not woken and remember and login and device_id:
                self._device(self._user(login), device_id, create=True).pending_wake = list(folders or [])
            self._cond.notify_all()
            return woken

    def pings_waiting(self, login=None, device_id=None):
        """Pings currently held: [{user, device, folders, heartbeat, started}]."""
        with self._lock:
            return [{k: e[k] for k in ("user", "device", "folders", "heartbeat", "started")}
                    for e in self._pings.values()
                    if (login is None or e["user"] == login) and (device_id is None or e["device"] == device_id)]

    # ── Faults ────────────────────────────────────────────────────────────

    def add_fault(self, cmd=None, *, login=None, device_id=None, http_status=None, status=None, retry_after=None,
                  delay=0.0, drop=False, times=1):
        """Make matching requests fail, before they are processed:
        http_status (with Retry-After), status (a top-level WBXML Status in the command's root element),
        drop (close without answering), delay (seconds before answering or failing).
        times: how many requests (None: until clear_faults). -> fault id"""
        with self._cond:
            self._seq += 1
            self._faults.append({"id": self._seq, "cmd": cmd, "login": login, "device": device_id,
                                 "http_status": http_status, "status": status, "retry_after": retry_after,
                                 "delay": delay, "drop": drop, "times": times, "hits": 0})
            return self._seq

    def clear_faults(self):
        with self._cond:
            self._faults.clear()

    # ── What the client did ───────────────────────────────────────────────

    def requests(self, cmd=None, login=None, device_id=None, since=0):
        """HTTP requests served: dicts with seq, time, method, cmd, user, device_id, device_type, version,
        policy_key, http_status, status (top-level WBXML Status), request/response (Elements), error."""
        with self._lock:
            return [dict(r) for r in self._requests
                    if r["seq"] > since and (cmd is None or r.get("cmd") == cmd)
                    and (login is None or r.get("user") == login)
                    and (device_id is None or r.get("device_id") == device_id)]

    def actions(self, kind=None, login=None, device_id=None, since=0):
        """What the client asked the server to do, one dict per operation. Kinds: provision, wipe_ack,
        sync_change, sync_delete, sync_add, sync_fetch, move, folder_create, folder_update, folder_delete,
        send_mail, empty_folder, settings, meeting_response. A calendar or task sync_add has "fields" and a
        sync_change "changes" (what the client sent, as in events()); a refused one has "reason"."""
        with self._lock:
            return [dict(a) for a in self._actions
                    if a["seq"] > since and (kind is None or a["kind"] == kind)
                    and (login is None or a["user"] == login)
                    and (device_id is None or a["device"] == device_id)]

    def sent_mails(self, login=None):
        """SendMail received: dicts with user, device, client_id, mime (as received), save_in_sent, status,
        recipients, delivered_to (local users), sent_copy (ServerId in Sent Items)."""
        with self._lock:
            return [dict(m) for m in self._sent if login is None or m["user"] == login]

    def provision_acks(self, login=None, device_id=None):
        """Second Provision requests (acknowledgements): dicts with policy_key and status as received."""
        return [a for a in self.actions("provision", login, device_id) if a["phase"] == 2]

    def protocol_errors(self):
        """Requests a strict server refused as malformed (each: seq, cmd, message)."""
        with self._lock:
            return [dict(e) for e in self._protocol_errors]

    def internal_errors(self):
        """Exceptions inside the mock itself (should stay empty)."""
        with self._lock:
            return list(self._internal_errors)

    def last_seq(self):
        """Sequence number of the latest request or action (for `since=`)."""
        with self._lock:
            return self._seq

    def collections_requested(self, login=None, device_id=None, since=0):
        """CollectionIds named by the client in Sync, Ping, GetItemEstimate and ItemOperations requests
        (to check that a mail-only client never touches calendar, contacts or tasks folders)."""
        out = set()
        for r in self.requests(login=login, device_id=device_id, since=since):
            doc = r.get("request")
            if doc is None:
                continue
            stack = [doc]
            while stack:
                node = stack.pop()
                if node.tag in ("CollectionId", "SrcFldId", "DstFldId") or (node.tag == "Id" and node.ns == "Ping"):
                    out.add(node.text())
                stack.extend(node.children)
        return out

    def transcript(self, since=0, max_value=120):
        """The requests as readable text (to print when a scenario step fails). No password; message
        bodies are cut to `max_value` characters."""
        lines = []
        for r in self.requests(since=since):
            lines.append(f"#{r['seq']} {r.get('method')} {r.get('cmd')} user={r.get('user')} "
                         f"device={r.get('device_id')} -> HTTP {r.get('http_status')} Status={r.get('status')}"
                         + (f" [{r['error']}]" if r.get("error") else ""))
            for arrow, key in (("  >", "request"), ("  <", "response")):
                if r.get(key) is not None:
                    text = wbxml.to_xml(r[key], max_value=max_value)
                    lines += [f"{arrow} {line}" for line in text.splitlines()]
        return "\n".join(lines)

    def wait_until(self, predicate, timeout=30.0, message=None):
        """Wait until predicate() is true (evaluated under the server lock, after every change and
        request). -> its value. Raises TimeoutError."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                value = predicate()
                if value:
                    return value
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(message or "condition non remplie dans le délai")
                self._cond.wait(min(remaining, 0.5))

    # ── Internals: model ──────────────────────────────────────────────────

    def _changed(self):
        self._cond.notify_all()

    def _next_seq(self):
        self._seq += 1
        return self._seq

    def _user(self, login):
        user = self._users.get(login)
        if user is None:
            raise KeyError(f"utilisateur inconnu : {login}")
        return user

    def _device(self, user, device_id, create=False, device_type="Unknown"):
        dev = user.devices.get(device_id)
        if dev is None:
            if not create:
                raise KeyError(f"appareil inconnu : {device_id}")
            dev = user.devices[device_id] = Device(user.login, device_id, device_type)
        return dev

    def _folder(self, user, ref):
        if isinstance(ref, Folder):
            return ref
        if isinstance(ref, int) and not isinstance(ref, bool):
            for f in user.folders.values():
                if f.type == ref:
                    return f
            raise KeyError(f"aucun dossier de type {ref}")
        if ref in user.folders:
            return user.folders[ref]
        parent = "0"
        found = None
        for name in str(ref).split("/"):
            found = next((f for f in user.folders.values() if f.parent_id == parent and f.name == name), None)
            if found is None:
                raise KeyError(f"dossier inconnu : {ref}")
            parent = found.server_id
        return found

    def _new_folder(self, user, parent_id, name, type_):
        fid = str(user.next_folder)
        user.next_folder += 1
        folder = Folder(fid, parent_id, name, type_)
        user.folders[fid] = folder
        return folder

    def _descendants(self, user, folder_id):
        out = []
        todo = [folder_id]
        while todo:
            current = todo.pop()
            for f in user.folders.values():
                if f.parent_id == current:
                    out.append(f.server_id)
                    todo.append(f.server_id)
        return out

    def _modify(self, login, folder, server_id, change, bump=True):
        with self._cond:
            f = self._folder(self._user(login), folder)
            item = f.items.get(server_id)
            if item is None:
                raise KeyError(f"élément inconnu : {server_id}")
            before = (item.read, item.flag, list(item.categories))
            change(item)
            if bump and (item.read, item.flag, list(item.categories)) != before:
                item.version += 1  # devices get a Change only when something really changed
            self._changed()

    def _move_item(self, src, server_id, dst):
        item = src.items.pop(server_id)
        item.server_id = dst.new_item_id()
        item.version += 1
        dst.items[item.server_id] = item
        return item.server_id

    def _hierarchy_snapshot(self, user):
        return {f.server_id: (f.parent_id, f.name, f.type) for f in user.folders.values()}

    def _hierarchy_stale(self, user, dev):
        return dev.hierarchy is None or dev.hierarchy.known != self._hierarchy_snapshot(user)

    def _add_pim_samples(self, user):
        contact = [el("Contacts:FileAs", "Martin, Claire"), el("Contacts:FirstName", "Claire"),
                   el("Contacts:LastName", "Martin"), el("Contacts:Email1Address", "claire.martin@example.test")]
        event = self._new_event(user, _event_fields({"subject": "Réunion de test"}))
        task = self._settled_task(_task_fields({"subject": "Tâche de test", "importance": 1, "sensitivity": 0,
                                                "reminder_set": False}))
        for type_, kind, data in ((8, "pim", event), (9, "raw", contact), (7, "pim", task)):
            f = self._folder(user, type_)
            item = Item(f.new_item_id(), cls=f.cls, **{kind: data})
            f.items[item.server_id] = item

    # ── Internals: events, tasks, invitations ────────────────────────────

    def _pim_item(self, login, folder, server_id, cls):
        f = self._folder(self._user(login), folder)
        item = f.items.get(server_id)
        if item is None:
            raise KeyError(f"élément inconnu : {server_id}")
        if item.pim is None or item.cls != cls:
            raise TypeError(f"l'élément {server_id} n'est pas de la classe {cls}")
        return item

    def _pim_view(self, item, folder):
        out = {"server_id": item.server_id, "folder_id": folder.server_id, "class": item.cls,
               "version": item.version}
        if item.pim is None:
            out["raw"] = True
            return out
        out.update(_plain(item.pim))
        if item.cls == "Calendar":
            out["zone"] = parse_timezone(item.pim["timezone"]) if item.pim.get("timezone") else None
        return out

    @staticmethod
    def _blank_event():
        event = {k: None for k in EVENT_KEYS}
        event.update(categories=[], attendees=[], exceptions=[])
        return event

    def _new_event(self, user, fields):
        """A complete event from what the test gave, with the values a server would have."""
        now = _utcnow().replace(microsecond=0)
        event = self._blank_event()
        event.update({k: v for k, v in fields.items() if v is not None})
        event["uid"] = event["uid"] or uuid.uuid4().hex.upper()
        if event["start"] is None:
            event["start"] = now.replace(minute=0, second=0) + datetime.timedelta(days=1)
        if event["end"] is None:
            event["end"] = event["start"] + datetime.timedelta(hours=1)
        event["dtstamp"] = event["dtstamp"] or now
        if "timezone" not in fields:
            event["timezone"] = make_timezone()
        for key, default in (("busy_status", 2), ("sensitivity", 0), ("all_day", False)):
            if event[key] is None:
                event[key] = default
        mine = (event["organizer_email"] or user.email).lower() == user.email.lower()
        if event["attendees"] and event["organizer_email"] is None:
            event["organizer_email"], event["organizer_name"] = user.email, user.display_name
        if event["meeting_status"] is None:
            event["meeting_status"] = (1 if mine else 3) if event["attendees"] or not mine else 0
        self._settle_response(event)
        if not event["recurrence"]:
            event["exceptions"] = []
        return event

    @staticmethod
    def _settle_response(event):
        """ResponseType is the server's: 1 for the organizer, 5 until an attendee answers, none for an appointment."""
        status = event.get("meeting_status") or 0
        if not status & 1:
            event["response_type"] = event["reply_time"] = None
        elif event.get("response_type") is None:
            event["response_type"] = 5 if status & 2 else 1

    @staticmethod
    def _settled_task(task):
        out = {k: None for k in TASK_KEYS}
        out.update(task)
        out["categories"] = list(out["categories"] or [])
        out["complete"] = bool(out["complete"])
        if not out["complete"]:
            out["date_completed"] = None
        elif out["date_completed"] is None:  # [MS-ASTASK] 2.2.2.8: sent whenever Complete is 1
            out["date_completed"] = _utcnow().replace(microsecond=0)
        return out

    def _invitation_mime(self, user, inv, date):
        """The message of an invitation: multipart/alternative, a plain text and a text/calendar; method=REQUEST
        part, both in UTF-8 and 8bit. Written by hand, so that its bytes are exactly known."""
        from email.headerregistry import Address
        from email.message import EmailMessage
        msg = EmailMessage(policy=email.policy.SMTP)
        msg["From"] = Address(inv["organizer_name"], addr_spec=inv["organizer_email"])
        msg["To"] = [Address(a["name"], addr_spec=a["email"]) for a in inv["attendees"]]
        msg["Subject"] = inv["subject"]
        msg["Date"] = email.utils.format_datetime(_aware(date) or _utcnow())
        msg["Message-ID"] = email.utils.make_msgid(domain="mock-eas.test")
        msg["MIME-Version"] = "1.0"
        head = _split_mime(msg.as_bytes())[0]
        boundary = b"=_mock-eas_" + uuid.uuid4().hex[:16].encode("ascii")
        text = inv["body"] or f"Invitation : {inv['subject']}\nDébut : {_plain_date(inv['start'])}\n"
        text = "\r\n".join(text.splitlines()) + "\r\n"
        body = b""
        for kind, data in ((b'text/plain; charset="utf-8"', text),
                           (b'text/calendar; method=REQUEST; charset="utf-8"', _invitation_ics(inv))):
            body += (b"--" + boundary + b"\r\nContent-Type: " + kind + b"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
                     + data.encode("utf-8") + b"\r\n")
        return (head + b'\r\nContent-Type: multipart/alternative; boundary="' + boundary + b'"\r\n\r\n'
                + body + b"--" + boundary + b"--\r\n")

    @staticmethod
    def _calendar_item_of(user, uid):
        """(folder, item) of the user's calendar item for a meeting UID (default Calendar first), or None."""
        if not uid:
            return None
        folders = sorted((f for f in user.folders.values() if f.cls == "Calendar"),
                         key=lambda f: f.type != FolderType.CALENDAR)
        for f in folders:
            for item in f.items.values():
                if item.pim is not None and item.pim.get("uid") == uid:
                    return f, item
        return None

    def _meeting_to_calendar(self, user, inv, response_type, busy_status, replied):
        """Create the attendee's calendar item of an invitation, or refresh the one with the same UID. -> ServerId"""
        fields = {"uid": inv["uid"], "subject": inv["subject"], "location": inv["location"], "body": inv["body"],
                  "start": inv["start"], "end": inv["end"], "all_day": inv["all_day"], "timezone": inv["timezone"],
                  "dtstamp": inv["dtstamp"], "busy_status": busy_status, "sensitivity": inv["sensitivity"],
                  "reminder": inv["reminder"], "organizer_name": inv["organizer_name"],
                  "organizer_email": inv["organizer_email"], "attendees": [dict(a) for a in inv["attendees"]],
                  "meeting_status": 3, "response_requested": inv["response_requested"],
                  "disallow_new_time": inv["disallow_new_time"], "response_type": response_type,
                  "reply_time": replied, "recurrence": dict(inv["recurrence"]) if inv["recurrence"] else None}
        found = self._calendar_item_of(user, inv["uid"])
        if found is not None:
            item = found[1]
            item.pim.update(fields)
            if not item.pim["recurrence"]:
                item.pim["exceptions"] = []
            item.version += 1
            return item.server_id
        cal = next((f for f in user.folders.values() if f.type == FolderType.CALENDAR), None)
        if cal is None:
            return None
        event = self._blank_event()
        event.update(fields)
        item = Item(cal.new_item_id(), pim=event, cls="Calendar")
        cal.items[item.server_id] = item
        return item.server_id

    # ── Internals: calendar and task ApplicationData ─────────────────────

    def _pim_body(self, text, options):
        """airsyncbase:Body of an event or a task ([MS-ASAIRS] 2.2.2.9), stored as plain text: the first
        BodyPreference of type 1 (plain text) or 2 (HTML) decides, with its TruncationSize; AllOrNone passes to
        the next one when the text is too long ([MS-ASAIRS] 2.2.2.3.2). No preference: plain text, whole."""
        text = text or ""
        prefs = [p for p in options.get("body_prefs") or [] if p["type"] in (1, 2)]
        prefs = prefs or [{"type": 1, "truncation": None, "all_or_none": False, "preview": None}]
        for n, pref in enumerate(prefs):
            shown = text if pref["type"] == 1 else "<html><body><pre>" + html.escape(text) + "</pre></body></html>"
            data = shown.encode("utf-8")
            full, limit = len(data), pref["truncation"]
            truncated = limit is not None and full > limit
            if truncated and pref["all_or_none"]:
                if n + 1 < len(prefs):
                    continue
                data = b""
            elif truncated:
                data = data[:limit].decode("utf-8", "ignore").encode("utf-8")
            children = [el("AirSyncBase:Type", pref["type"]), el("AirSyncBase:EstimatedDataSize", full)]
            if truncated:
                children.append(el("AirSyncBase:Truncated", "1"))
            if data or not truncated:
                children.append(el("AirSyncBase:Data", data,
                                   opaque=self.options.body_data_opaque or b"\x00" in data))
            if pref["preview"]:
                children.append(el("AirSyncBase:Preview", " ".join(text.split())[:pref["preview"]]))
            return el("AirSyncBase:Body", children)

    @staticmethod
    def _attendees_el(attendees):
        return el("Calendar:Attendees", [el("Attendee", [
            el("Email", a["email"]), el("Name", a["name"]),
            el("AttendeeStatus", a["status"]) if a.get("status") is not None else None,
            el("AttendeeType", a["type"]) if a.get("type") is not None else None]) for a in attendees])

    @staticmethod
    def _recurrence_el(ns, rec, version, date_text):
        """Recurrence of an event (ns Calendar) or of a meeting request (ns Email; CalendarType, IsLeapMonth
        and FirstDayOfWeek then live in Email2)."""
        late = "Email2" if ns == "Email" else ns
        out = [el(f"{ns}:Type", rec["type"])]
        if rec.get("interval") is not None or ns == "Email":  # required in a meeting request
            out.append(el(f"{ns}:Interval", rec.get("interval") or 1))
        if rec.get("occurrences") is not None:
            out.append(el(f"{ns}:Occurrences", rec["occurrences"]))
        elif rec.get("until") is not None:
            out.append(el(f"{ns}:Until", date_text(rec["until"])))
        for name, key in (("WeekOfMonth", "week_of_month"), ("DayOfMonth", "day_of_month"),
                          ("DayOfWeek", "day_of_week"), ("MonthOfYear", "month_of_year")):
            if rec.get(key) is not None:
                out.append(el(f"{ns}:{name}", rec[key]))
        if _at_least(version, "14.0"):
            # A response has a CalendarType whenever the Type is 2, 3, 5 or 6 ([MS-ASCAL] 2.2.2.10).
            if rec.get("calendar_type") is not None or rec["type"] in (2, 3, 5, 6):
                out.append(el(f"{late}:CalendarType", rec.get("calendar_type") or 0))
            if rec.get("is_leap_month") is not None:
                out.append(el(f"{late}:IsLeapMonth", rec["is_leap_month"]))
        if _at_least(version, "14.1") and rec.get("first_day_of_week") is not None:
            out.append(el(f"{late}:FirstDayOfWeek", rec["first_day_of_week"]))
        return el(f"{ns}:Recurrence", out)

    def _exception_el(self, exc, options, version):
        """An Exception: only what differs from the series; an empty element where the series' value does not
        apply ([MS-ASCAL] 3.2.5.3.2)."""
        out = []
        if exc.get("deleted"):
            out.append(el("Calendar:Deleted", "1"))
        out.append(el("Calendar:ExceptionStartTime", compact_date(exc["exception_start"])))
        if exc.get("deleted"):
            return el("Calendar:Exception", out)
        for name, key in (("Subject", "subject"), ("StartTime", "start"), ("EndTime", "end")):
            if key in exc:
                value = exc[key]
                out.append(el(f"Calendar:{name}", (compact_date(value) if key != "subject" else value) or None))
        if "body" in exc:
            out.append(self._pim_body(exc["body"], options))
        if "location" in exc:
            out.append(el("Calendar:Location", exc["location"] or None))
        if "categories" in exc:
            out.append(el("Calendar:Categories", [el("Category", c) for c in exc["categories"]] or None))
        for name, key in (("Sensitivity", "sensitivity"), ("BusyStatus", "busy_status")):
            if exc.get(key) is not None:
                out.append(el(f"Calendar:{name}", exc[key]))
        if exc.get("all_day") is not None:
            out.append(el("Calendar:AllDayEvent", "1" if exc["all_day"] else "0"))
        if "reminder" in exc:
            if exc["reminder"] is not None:
                out.append(el("Calendar:Reminder", exc["reminder"]))
            elif _at_least(version, "14.1"):  # the empty element exists from 14.1 only ([MS-ASCAL] 2.2.2.38)
                out.append(el("Calendar:Reminder"))
        if exc.get("dtstamp") is not None:
            out.append(el("Calendar:DtStamp", compact_date(exc["dtstamp"])))
        if exc.get("meeting_status") is not None:
            out.append(el("Calendar:MeetingStatus", exc["meeting_status"]))
        if _at_least(version, "14.0"):
            if "attendees" in exc:
                out.append(self._attendees_el(exc["attendees"]) if exc["attendees"] else el("Calendar:Attendees"))
            if exc.get("reply_time") is not None:
                out.append(el("Calendar:AppointmentReplyTime", compact_date(exc["reply_time"])))
            if exc.get("response_type") is not None:
                out.append(el("Calendar:ResponseType", exc["response_type"]))
        return el("Calendar:Exception", out)

    def _event_data(self, event, options, version):
        """Calendar ApplicationData for the protocol version ([MS-ASCAL] 2.2.2), in the order of the examples
        of [MS-ASCMD] 4.16.4.2 and [MS-ASCAL] 4.2. The whole item, for an Add as for a Change."""
        v14 = _at_least(version, "14.0")
        out = []

        def add(name, value):
            if value is not None:
                out.append(el(f"Calendar:{name}", value))

        if event.get("timezone") is not None:
            add("Timezone", base64.b64encode(event["timezone"]).decode("ascii"))
        add("DtStamp", compact_date(event["dtstamp"]) if event.get("dtstamp") else None)
        add("StartTime", compact_date(event["start"]))
        add("Subject", event.get("subject"))
        add("UID", event.get("uid"))
        add("OrganizerName", event.get("organizer_name"))
        add("OrganizerEmail", event.get("organizer_email"))
        if event.get("attendees"):
            out.append(self._attendees_el(event["attendees"]))
        add("Location", event.get("location"))
        add("EndTime", compact_date(event["end"]))
        if event.get("recurrence"):
            out.append(self._recurrence_el("Calendar", event["recurrence"], version, compact_date))
        out.append(self._pim_body(event.get("body"), options))
        add("Sensitivity", event.get("sensitivity"))
        add("BusyStatus", event.get("busy_status"))
        if event.get("all_day") is not None:
            add("AllDayEvent", "1" if event["all_day"] else "0")
        add("Reminder", event.get("reminder"))
        if event.get("recurrence") and event.get("exceptions"):
            out.append(el("Calendar:Exceptions", [self._exception_el(x, options, version)
                                                  for x in event["exceptions"]]))
        add("MeetingStatus", event.get("meeting_status"))
        out.append(el("AirSyncBase:NativeBodyType", "1"))
        if v14:  # [MS-ASCAL] 2.2.2.39, 2.2.2.2, 2.2.2.40, 2.2.2.17: from 14.0
            if event.get("response_requested") is not None:
                add("ResponseRequested", "1" if event["response_requested"] else "0")
            add("AppointmentReplyTime", compact_date(event["reply_time"]) if event.get("reply_time") else None)
            add("ResponseType", event.get("response_type"))
            if event.get("disallow_new_time") is not None:
                add("DisallowNewTimeProposal", "1" if event["disallow_new_time"] else "0")
        if event.get("categories"):
            out.append(el("Calendar:Categories", [el("Category", c) for c in event["categories"]]))
        return out

    def _task_data(self, task, options, version):
        """Tasks ApplicationData for the protocol version ([MS-ASTASK] 2.2.2)."""
        out = [self._pim_body(task.get("body"), options)]

        def add(name, value):
            if value is not None:
                out.append(el(f"Tasks:{name}", value))

        add("Subject", task.get("subject"))
        add("Importance", task.get("importance"))
        for name, key in (("UtcStartDate", "utc_start_date"), ("StartDate", "start_date"),
                          ("UtcDueDate", "utc_due_date"), ("DueDate", "due_date")):
            add(name, eas_date(task[key]) if task.get(key) else None)
        if task.get("categories"):
            out.append(el("Tasks:Categories", [el("Category", c) for c in task["categories"]]))
        rec = task.get("recurrence")
        if rec:
            parts = [el("Tasks:Type", rec["type"]), el("Tasks:Start", eas_date(rec["start"]))]
            if rec.get("occurrences") is not None:
                parts.append(el("Tasks:Occurrences", rec["occurrences"]))
            elif rec.get("until") is not None:
                parts.append(el("Tasks:Until", eas_date(rec["until"])))
            for name, key in (("Interval", "interval"), ("DayOfWeek", "day_of_week"),
                              ("DayOfMonth", "day_of_month"), ("WeekOfMonth", "week_of_month"),
                              ("MonthOfYear", "month_of_year"), ("Regenerate", "regenerate"),
                              ("DeadOccur", "dead_occur")):
                if rec.get(key) is not None:
                    parts.append(el(f"Tasks:{name}", rec[key]))
            if _at_least(version, "14.0"):
                if rec.get("calendar_type") is not None or rec["type"] in (2, 3, 5, 6):  # [MS-ASTASK] 2.2.2.4
                    parts.append(el("Tasks:CalendarType", rec.get("calendar_type") or 0))
                if rec.get("is_leap_month") is not None:
                    parts.append(el("Tasks:IsLeapMonth", rec["is_leap_month"]))
            if _at_least(version, "14.1") and (rec.get("first_day_of_week") is not None or rec["type"] == 1):
                # [MS-ASTASK] 2.2.2.13: always returned for a weekly recurrence (Sunday when the client gave none)
                parts.append(el("Tasks:FirstDayOfWeek", rec.get("first_day_of_week") or 0))
            out.append(el("Tasks:Recurrence", parts))
        add("Complete", "1" if task.get("complete") else "0")
        add("DateCompleted", eas_date(task["date_completed"]) if task.get("date_completed") else None)
        add("Sensitivity", task.get("sensitivity"))
        add("ReminderTime", eas_date(task["reminder_time"]) if task.get("reminder_time") else None)
        if task.get("reminder_set") is not None:
            add("ReminderSet", "1" if task["reminder_set"] else "0")
        out.append(el("AirSyncBase:NativeBodyType", "1"))
        return out

    def _meeting_request_el(self, inv, version):
        """MeetingRequest of an invitation mail, children in the order of the schema ([MS-ASEMAIL] 2.2.2.48, 6.1)."""
        name = inv["organizer_name"].replace('"', "")
        organizer = f'"{name}" <{inv["organizer_email"]}>'
        out = [el("Email:AllDayEvent", "1" if inv["all_day"] else "0"),
               el("Email:StartTime", eas_date(inv["start"])), el("Email:DtStamp", eas_date(inv["dtstamp"])),
               el("Email:EndTime", eas_date(inv["end"])),
               el("Email:InstanceType", "1" if inv["recurrence"] else "0")]
        if inv["location"]:
            out.append(el("Email:Location", inv["location"]))
        out.append(el("Email:Organizer", organizer))
        if inv["reminder"] is not None:
            out.append(el("Email:Reminder", inv["reminder"] * 60))  # seconds here ([MS-ASEMAIL] 2.2.2.63)
        out.append(el("Email:ResponseRequested", "1" if inv["response_requested"] else "0"))
        if inv["recurrence"]:
            out.append(el("Email:Recurrences", [self._recurrence_el("Email", inv["recurrence"], version,
                                                                    compact_date)]))
        out += [el("Email:Sensitivity", inv["sensitivity"]), el("Email:BusyStatus", inv["busy_status"]),
                el("Email:TimeZone", base64.b64encode(inv["timezone"]).decode("ascii")),
                el("Email:GlobalObjId", base64.b64encode(global_obj_id(inv["uid"])).decode("ascii"))]
        if _at_least(version, "14.0"):  # [MS-ASEMAIL] 2.2.2.27
            out.append(el("Email:DisallowNewTimeProposal", "1" if inv["disallow_new_time"] else "0"))
        if _at_least(version, "14.1"):  # [MS-ASEMAIL] 2.2.2.47
            out.append(el("Email2:MeetingMessageType", inv["message_type"]))
        return el("Email:MeetingRequest", out)

    # ── Internals: what a client's Add or Change does to an event or a task ──

    def _client_event_add(self, given):
        """The event a client's Add creates ([MS-ASCAL] 3.2.4.4 for missing times)."""
        now = _utcnow().replace(microsecond=0)
        event = self._blank_event()
        event.update(given)
        start, end = given.get("start"), given.get("end")
        if start is None:  # and no EndTime either: EndTime without StartTime was refused (3.2.5.3)
            start = _half_hour_after(now)
            end = start + datetime.timedelta(minutes=30)
        elif end is None:
            if start > now:
                raise _Refused("StartTime dans le futur sans EndTime")
            end = _half_hour_after(now) + datetime.timedelta(minutes=30)
        if end < start:
            raise _Refused("EndTime avant StartTime")
        event.update(start=start, end=end)
        event["uid"] = event["uid"] or uuid.uuid4().hex.upper()  # [MS-ASCAL] 2.2.2.46: the server may create it
        event["dtstamp"] = event["dtstamp"] or now
        if event["exceptions"] and not event["recurrence"]:
            raise _Refused("Exceptions sans Recurrence")
        self._settle_response(event)
        return event

    def _client_event_change(self, event, given, supported, version):
        """The event after a client's Change.

        An element present replaces the value. For an element absent:
          - [MS-ASCMD] 2.2.3.179. Without Supported in the collection's first Sync, no element is ghosted; with
            a Supported that has children, only the elements it names are not ghosted; with an empty Supported,
            every element that can be ghosted is. A ghosted element absent from a Change keeps its value.
            "If the element is not ghosted, any existing value for that element is deleted."
          - [MS-ASCAL] 2.2.2.27: Location cannot be ghosted, so it is deleted whenever it is absent.
          - [MS-ASCMD] 2.2.3.24 and [MS-ASCAL] 3.2.5.3.1: Exceptions absent leaves every exception as it is, even
            if Supported named Exceptions; an Exception absent leaves that exception as it is. A Body absent
            leaves the body as it is.
          - ResponseType and AppointmentReplyTime are the server's (a request never has them): untouched.
          - An element the protocol version does not define cannot be sent, so it is untouched.
        The mock cannot keep an event without StartTime or EndTime: when one is absent and not ghosted, the
        Change is refused (Status 6). A DtStamp deleted this way becomes the time of the change."""
        new = dict(event)

        def ghosted(name):
            return name != "Location" and supported is not None and name not in supported

        for name, field, since in CAL_TOP:
            if name == "Exceptions":
                continue
            if field in given:
                new[field] = given[field]
            elif not _at_least(version, since) or ghosted(name):
                continue
            elif name in ("StartTime", "EndTime"):
                raise _Refused(f"{name} absent d'un Change alors qu'il n'est pas fantôme")
            else:
                new[field] = [] if field in ("attendees", "categories") else None
        if "body" in given:
            new["body"] = given["body"]
        if new["dtstamp"] is None:
            new["dtstamp"] = _utcnow().replace(microsecond=0)
        if "exceptions" in given:
            if not new["recurrence"]:
                raise _Refused("Exceptions sans Recurrence")
            kept = {x["exception_start"]: x for x in event["exceptions"]}
            kept.update({x["exception_start"]: x for x in given["exceptions"]})
            new["exceptions"] = list(kept.values())
        if not new["recurrence"]:
            new["exceptions"] = []
        if new["end"] < new["start"]:
            raise _Refused("EndTime avant StartTime")
        self._settle_response(new)
        return new

    def _client_task_add(self, given):
        task = {"importance": 1, "sensitivity": 0, "reminder_set": False}  # the defaults of [MS-ASTASK] 2.2.2
        task.update(given)
        return self._settled_task(task)

    def _client_task_change(self, task, given):
        """The task after a client's Change. Tasks have no ghosting: an element absent is deleted
        ([MS-ASCMD] 2.2.3.24), except Importance and ReminderSet, which keep their value ([MS-ASTASK] 3.2.5.3.1,
        3.2.5.3.2), and the Body ([MS-ASCMD] 2.2.3.24). A completed task keeps its completion date."""
        new = dict(task)
        for name, field in TASK_FIELD.items():
            if field in given:
                new[field] = given[field]
            elif name not in ("Importance", "ReminderSet", "DateCompleted"):
                new[field] = [] if field == "categories" else None
        if "body" in given:
            new["body"] = given["body"]
        return self._settled_task(new)

    def _pim_add(self, ctx, folder, data, working, entry):
        """Client Add in a calendar or task folder. -> (status, new ServerId or None)"""
        try:
            if folder.cls == "Calendar":
                given = _read_event(data, ctx.version)
                pim = self._client_event_add(given)
            else:
                given = _read_task(data, ctx.version)
                pim = self._client_task_add(given)
        except (_Refused, WbxmlError) as e:
            self._refused(ctx, entry, e, f"Add {folder.cls}")
            return "6", None
        entry["fields"] = _plain(given)
        item = Item(folder.new_item_id(), pim=pim, cls=folder.cls)
        folder.items[item.server_id] = item
        working[item.server_id] = item.version
        return "1", item.server_id

    def _pim_change(self, ctx, folder, state, item, data, working, entry):
        """Client Change of an event or a task. -> status"""
        fail = self.options.fail_next_calendar_change
        if fail is not None and item.cls == "Calendar":
            self.options.fail_next_calendar_change = None
            entry["injected"] = str(fail)
            return str(fail)
        if working.get(item.server_id) != item.version:
            # Changed on the server since this device last saw it ([MS-ASCMD] 2.2.3.34): the server's object
            # stays and the client's is discarded (Status 7), unless Conflict is 0.
            entry["conflict"] = True
            if state.options.get("conflict", 1) == 1:
                return "7"
        try:
            if item.cls == "Calendar":
                given = _read_event(data, ctx.version)
                new = self._client_event_change(item.pim, given, state.supported, ctx.version)
            else:
                given = _read_task(data, ctx.version)
                new = self._client_task_change(item.pim, given)
        except (_Refused, WbxmlError) as e:
            self._refused(ctx, entry, e, f"Change {item.cls}")
            return "6"
        entry["changes"] = _plain(given)
        if new != item.pim:
            item.pim = new
            item.version += 1
        working[item.server_id] = item.version
        return "1"

    def _refused(self, ctx, entry, error, what):
        reason = error.reason if isinstance(error, _Refused) else str(error)
        entry["reason"] = reason
        if not isinstance(error, _Refused) or error.violation:
            self._protocol_error(ctx, f"{what} : {reason}")

    def _in_window(self, item, options, now):
        """Is the item within the collection's FilterType ([MS-ASCMD] 2.2.3.68.2)?"""
        chosen = options.get("filter_type", 0)
        if item.pim is not None and item.cls == "Tasks":
            return chosen != 8 or not item.pim.get("complete")  # 8: incomplete tasks only
        days = FILTER_DAYS.get(chosen)
        if days is None:
            return True
        cutoff = now - datetime.timedelta(days=days)
        if item.pim is None:
            return item.date >= cutoff
        # Calendar: what is in the future, and a series without an end, are sent whatever the period.
        last = _event_end_of_series(item.pim)
        return last is None or last >= cutoff

    def _supported(self, ctx, coll, folder, key):
        """The Supported element of a calendar or task collection ([MS-ASCMD] 2.2.3.179), and the order of
        the Collection's children ([MS-ASCMD] 2.2.3.29.2), which is strictly enforced.
        -> (names or None, problem or None)"""
        order = ("SyncKey", "CollectionId", "Supported", "DeletesAsMoves", "GetChanges", "WindowSize",
                 "ConversationMode", "Options", "Commands")
        last = -1
        for c in coll.children:
            if c.ns == "AirSync" and c.tag == "Class" and ctx.version.startswith("12."):
                continue  # [MS-ASCMD] 2.2.3.27.6: a child of Collection up to 12.1 only
            if c.ns != "AirSync" or c.tag not in order:
                return None, f"élément {c.name} inattendu dans Collection"
            rank = order.index(c.tag)
            if rank < last or (rank == last and c.tag != "Options"):
                return None, f"élément {c.tag} mal placé dans Collection (ordre imposé)"
            last = rank
        sup = coll.child("Supported")
        if sup is None:
            return None, None
        if key != "0":
            # Not an error for the specification, which has the server ignore it: the first list stays.
            self._protocol_error(ctx, "Supported avec une SyncKey non nulle : ignoré")
            return None, None
        names = []
        for c in sup.children:
            if c.ns != folder.cls or c.children or c.value:
                return None, f"Supported : {c.name} inattendu ou non vide"
            names.append(c.tag)
        if len(set(names)) != len(names):
            return None, "Supported : élément en double"
        if folder.cls == "Tasks":
            if names:  # only calendar and contact elements can be ghosted
                return None, "Supported : la classe Tasks n'a pas d'élément fantôme"
            return frozenset(), None
        allowed = set(SUPPORTED_REQUIRED) | set(SUPPORTED_OPTIONAL)
        if not _at_least(ctx.version, "14.0"):
            allowed -= {"ResponseRequested", "DisallowNewTimeProposal"}
        unknown = [n for n in names if n not in allowed]
        if unknown:
            return None, f"Supported : {unknown[0]} non admis en version {ctx.version}"
        missing = [n for n in SUPPORTED_REQUIRED if n not in names]
        if names and missing:
            return None, f"Supported : élément obligatoire absent ({missing[0]})"
        return frozenset(names), None

    # ── Internals: change computation ─────────────────────────────────────

    def _view(self, folder, options):
        if not options.get("filter_type", 0):
            return folder.items
        now = _utcnow()
        return {sid: i for sid, i in folder.items.items() if self._in_window(i, options, now)}

    def _pending(self, folder, options, known):
        """[(op, ServerId)] the device must receive: deletes, soft deletes, changes, adds (newest first)."""
        view = self._view(folder, options)
        out = [("Delete", sid) for sid in known if sid not in folder.items]
        out += [("SoftDelete", sid) for sid in known if sid in folder.items and sid not in view]
        out += [("Change", sid) for sid, v in known.items() if sid in view and view[sid].version != v]
        adds = [i for sid, i in view.items() if sid not in known]
        adds.sort(key=lambda i: (i.date, i.seq), reverse=True)
        out += [("Add", i.server_id) for i in adds]
        return out

    def _folder_has_changes(self, user, dev, folder_id):
        folder = user.folders.get(folder_id)
        if folder is None:
            return False
        state = dev.collections.get(folder_id)
        if state is None:
            return bool(folder.items)
        return bool(self._pending(folder, state.options, state.known))

    # ── Internals: HTTP ───────────────────────────────────────────────────

    def _accept_loop(self):
        while not self._stopping:
            try:
                conn, addr = self._sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            t = threading.Thread(target=self._serve_connection, args=(conn, addr), name="mock-eas-conn",
                                 daemon=True)
            with self._lock:
                self._threads = [x for x in self._threads if x.is_alive()]
                self._threads.append(t)
                self._conns.add(conn)
            t.start()

    def _serve_connection(self, raw, addr):
        record = None
        tls = None
        try:
            raw.settimeout(self.options.io_timeout)
            try:
                tls = self._ssl.wrap_socket(raw, server_side=True)
            except (ssl.SSLError, OSError) as e:
                with self._cond:
                    self._requests.append({"seq": self._next_seq(), "time": time.time(), "method": None,
                                           "cmd": None, "user": None, "device_id": None,
                                           "http_status": None, "error": f"TLS : {e}"})
                    self._cond.notify_all()
                return
            with self._lock:
                self._conns.add(tls)
            record = {"time": time.time(), "method": None, "target": None, "cmd": None, "user": None,
                      "device_id": None, "device_type": None, "version": None, "policy_key": None,
                      "http_status": None, "status": None, "request": None, "response": None, "error": None,
                      "tls_version": tls.version()}
            started = time.monotonic()
            try:
                req = self._read_request(tls, record)
                status, headers, body = self._dispatch(req)
            except _HttpAbort as e:
                status, headers, body = e.status, e.headers, e.body
                if e.message and not record.get("error"):
                    record["error"] = e.message
            except _Drop as e:
                record["error"] = f"connexion fermée sans réponse : {e}"
                status = None
            except (OSError, ssl.SSLError) as e:  # the client went away: not the server's fault
                record["error"] = f"connexion interrompue : {type(e).__name__}: {e}"
                status = None
            except Exception as e:  # noqa: BLE001 - reported, the connection answers 500
                with self._lock:
                    self._internal_errors.append(f"{type(e).__name__}: {e}\n{traceback.format_exc()}")
                record["error"] = f"erreur interne : {type(e).__name__}: {e}"
                status, headers, body = 500, [], b""
            if status is not None:
                record["http_status"] = status
                try:
                    self._write_response(tls, status, headers, body)
                except OSError as e:
                    record["error"] = record.get("error") or f"envoi impossible : {e}"
            record["duration"] = time.monotonic() - started
        finally:
            if record is not None:
                with self._cond:
                    record["seq"] = self._next_seq()
                    self._requests.append(record)
                    self._cond.notify_all()
            for s in (tls, raw):
                if s is None:
                    continue
                try:
                    if s is tls:
                        s.settimeout(1.0)
                        s.unwrap()
                except (OSError, ValueError, ssl.SSLError):
                    pass
                try:
                    s.close()
                except OSError:
                    pass
                with self._lock:
                    self._conns.discard(s)

    def _read_request(self, tls, record):
        buf = bytearray()
        while True:
            end = buf.find(b"\r\n\r\n")
            if end >= 0:
                break
            if len(buf) > 64 * 1024:
                raise _HttpAbort(431, "en-têtes trop longs")
            try:
                chunk = tls.recv(65536)
            except socket.timeout:
                raise _Drop("délai de lecture dépassé (en-têtes)") from None
            if not chunk:
                raise _Drop("connexion fermée avant la fin des en-têtes" if buf else "connexion vide")
            buf += chunk
        head = bytes(buf[:end])
        rest = bytes(buf[end + 4:])
        try:
            text = head.decode("ascii")
        except UnicodeDecodeError:
            raise _HttpAbort(400, "octets non ASCII dans les en-têtes") from None
        if re.search(r"\r(?!\n)|(?<!\r)\n", text) or "\x00" in text:
            raise _HttpAbort(400, "fins de ligne invalides dans les en-têtes")
        lines = text.split("\r\n")
        m = _REQUEST_LINE.match(lines[0])
        if not m:
            raise _HttpAbort(400, "ligne de requête invalide")
        method, target = m.group(1), m.group(2)
        record["method"], record["target"] = method, target
        if (m.group(3), m.group(4)) != ("1", "1"):
            raise _HttpAbort(505, f"HTTP/{m.group(3)}.{m.group(4)} refusé")
        headers = {}
        for line in lines[1:]:
            if line[:1] in (" ", "\t"):
                raise _HttpAbort(400, "en-tête replié (obs-fold) refusé")
            name, sep, value = line.partition(":")
            if not sep or not _TOKEN.match(name):
                raise _HttpAbort(400, "ligne d'en-tête invalide")
            value = value.strip(" \t")
            if re.search(r"[\x00-\x08\x0a-\x1f\x7f]", value):
                raise _HttpAbort(400, f"caractère de contrôle dans l'en-tête {name}")
            headers.setdefault(name.lower(), []).append(value)
        if len(headers.get("host", [])) != 1:
            raise _HttpAbort(400, "en-tête Host absent ou multiple")
        if "transfer-encoding" in headers:
            raise _HttpAbort(501, "Transfer-Encoding non pris en charge (Content-Length attendu)")
        lengths = headers.get("content-length", [])
        if len(lengths) > 1:
            raise _HttpAbort(400, "Content-Length multiple")
        if lengths:
            if not re.match(r"^\d{1,12}$", lengths[0]):
                raise _HttpAbort(400, "Content-Length invalide")
            length = int(lengths[0])
        elif method == "POST":
            raise _HttpAbort(411, "Content-Length absent")
        else:
            length = 0
        if length > self.options.max_request_bytes:
            raise _HttpAbort(413, f"corps trop volumineux ({length} octets)")
        body = bytearray(rest)
        while len(body) < length:
            try:
                chunk = tls.recv(min(65536, length - len(body)))
            except socket.timeout:
                raise _Drop("délai de lecture dépassé (corps)") from None
            if not chunk:
                raise _Drop("connexion fermée avant la fin du corps")
            body += chunk
        if len(body) > length:
            raise _HttpAbort(400, "octets après le corps annoncé (pipelining non pris en charge)")
        return _Request(method, target, headers, bytes(body), tls, record)

    def _write_response(self, tls, status, headers, body):
        lines = [f"HTTP/1.1 {status} {REASONS.get(status, 'Status')}",
                 f"Date: {email.utils.formatdate(usegmt=True)}",
                 "Server: Sync443-MockEAS",
                 "Cache-Control: private"]
        names = {k.lower() for k, _ in headers}
        for k, v in headers:
            lines.append(f"{k}: {v}")
        if body and "content-type" not in names:
            lines.append(f"Content-Type: {WBXML_TYPE}")
        lines.append(f"Content-Length: {len(body)}")
        lines.append("Connection: close")
        tls.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii") + body)

    def _authenticate(self, req):
        challenge = [("WWW-Authenticate", 'Basic realm="Sync443 mock EAS"')]
        value = req.header("authorization")
        if not value:
            raise _HttpAbort(401, "authentification absente", challenge)
        scheme, _, token = value.partition(" ")
        if scheme.lower() != "basic" or not token:
            raise _HttpAbort(401, "schéma d'authentification non pris en charge", challenge)
        try:
            decoded = base64.b64decode(token.strip(), validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            raise _HttpAbort(401, "authentification Basic mal formée", challenge) from None
        login, sep, password = decoded.partition(":")
        if not sep:
            raise _HttpAbort(401, "authentification Basic mal formée", challenge)
        req.record["login"] = login
        with self._lock:
            name = login.split("\\", 1)[-1].lower()
            user = next((u for u in self._users.values() if name in (u.login.lower(), u.email.lower())), None)
            ok = user is not None and secrets.compare_digest(user.password.encode("utf-8"),
                                                             password.encode("utf-8"))
        if not ok:
            req.record["auth"] = "refused"
            raise _HttpAbort(401, f"mot de passe refusé pour « {login} »", challenge)
        req.record["auth"] = "ok"
        req.record["user"] = user.login
        return user

    def _parse_query(self, query):
        params = {}
        if not query:
            return params
        for part in query.split("&"):
            name, sep, value = part.partition("=")
            if not sep or not name:
                raise _HttpAbort(400, f"paramètre de requête mal formé « {part[:40]} »")
            if re.search(r"%(?![0-9A-Fa-f]{2})", value + name):
                raise _HttpAbort(400, "encodage % invalide dans la requête")
            try:
                decoded = unquote_to_bytes(value.replace("+", " ")).decode("utf-8")
            except UnicodeDecodeError:
                raise _HttpAbort(400, "paramètre de requête non UTF-8") from None
            if name in params:
                raise _HttpAbort(400, f"paramètre {name} en double")
            params[name] = decoded
        return params

    def _protocol_error(self, ctx_or_cmd, message):
        cmd = ctx_or_cmd.cmd if isinstance(ctx_or_cmd, _Ctx) else ctx_or_cmd
        with self._lock:
            self._protocol_errors.append({"seq": self._seq, "time": time.time(), "cmd": cmd, "message": message})

    def _action(self, ctx, kind, **data):
        with self._cond:
            entry = {"seq": self._next_seq(), "time": time.time(), "kind": kind, "user": ctx.user.login,
                     "device": ctx.device.device_id, **data}
            self._actions.append(entry)
            self._cond.notify_all()
            return entry

    def _options_headers(self):
        return [("Allow", "OPTIONS,POST"), ("Public", "OPTIONS,POST"),
                ("MS-Server-ActiveSync", self.options.server_version_header),
                ("MS-ASProtocolVersions", ",".join(self.options.versions)),
                ("MS-ASProtocolCommands", ",".join(PROTOCOL_COMMANDS))]

    def _apply_fault(self, req, cmd, user, device_id):
        with self._lock:
            fault = None
            for f in self._faults:
                if f["times"] is not None and f["hits"] >= f["times"]:
                    continue
                if f["cmd"] not in (None, cmd) or f["login"] not in (None, user.login):
                    continue
                if f["device"] not in (None, device_id):
                    continue
                fault = f
                f["hits"] += 1
                break
        if fault is None:
            return None
        req.record["fault"] = fault["id"]
        if fault["delay"]:
            time.sleep(fault["delay"])
        if fault["drop"]:
            raise _Drop("panne simulée")
        if fault["http_status"]:
            headers = [("Retry-After", str(fault["retry_after"]))] if fault["retry_after"] is not None else []
            raise _HttpAbort(fault["http_status"], "panne simulée", headers)
        if fault["status"] is not None and cmd in ROOTS:
            return _status_doc(cmd, fault["status"])
        return None

    def _dispatch(self, req):
        record = req.record
        path, _, query = req.target.partition("?")
        if path.lower() != EAS_PATH.lower():
            raise _HttpAbort(404, f"chemin inconnu {path[:80]}")
        if req.method not in ("OPTIONS", "POST"):
            raise _HttpAbort(405, f"méthode {req.method} refusée", [("Allow", "OPTIONS,POST")])
        user = self._authenticate(req)
        if req.method == "OPTIONS":
            record["cmd"] = "OPTIONS"
            self._apply_fault(req, "OPTIONS", user, None)
            return 200, self._options_headers(), b""
        params = self._parse_query(query)
        cmd = params.get("Cmd")
        record["cmd"] = cmd
        for name in ("Cmd", "User", "DeviceId", "DeviceType"):
            if not params.get(name):
                raise _HttpAbort(400, f"paramètre {name} absent")
        device_id, device_type = params["DeviceId"], params["DeviceType"]
        record["device_id"], record["device_type"] = device_id, device_type
        if not _DEVICE_ID.match(device_id):
            raise _HttpAbort(400, "DeviceId invalide (1 à 32 lettres ou chiffres)")
        if not _DEVICE_TYPE.match(device_type):
            raise _HttpAbort(400, "DeviceType invalide")
        if params["User"].split("\\", 1)[-1].lower() not in user.names():
            raise _HttpAbort(400, "le paramètre User ne correspond pas à l'utilisateur authentifié")
        version = req.header("ms-asprotocolversion")
        record["version"] = version
        if version is None:
            raise _HttpAbort(400, "en-tête MS-ASProtocolVersion absent")
        if version not in self.options.versions:
            raise _HttpAbort(400, f"version {version} non proposée")
        record["policy_key"] = req.header("x-ms-policykey")
        if cmd not in PROTOCOL_COMMANDS:
            raise _HttpAbort(501, f"commande inconnue {cmd[:40]}")
        handler = getattr(self, f"_cmd_{cmd.lower()}", None)
        with self._lock:
            dev = self._device(user, device_id, create=True, device_type=device_type)
            dev.device_type = device_type
        fault_doc = self._apply_fault(req, cmd, user, device_id)
        if handler is None:
            raise _HttpAbort(501, f"commande {cmd} non implémentée par le serveur de test")
        doc = None
        if req.body:
            ctype = (req.header("content-type") or "").split(";")[0].strip().lower()
            if ctype != WBXML_TYPE:
                raise _HttpAbort(400, f"Content-Type {ctype or 'absent'} refusé ({WBXML_TYPE} attendu)")
            try:
                doc = wbxml.decode(req.body)
            except WbxmlError as e:
                self._protocol_error(cmd, str(e))
                raise _HttpAbort(400, str(e)) from None
            record["request"] = doc
            if doc.name != ROOTS[cmd]:
                self._protocol_error(cmd, f"élément racine {doc.name} pour {cmd}")
                raise _HttpAbort(400, f"élément racine {doc.name} inattendu pour {cmd}")
        elif cmd not in EMPTY_BODY_ALLOWED:
            self._protocol_error(cmd, "corps vide")
            raise _HttpAbort(400, f"corps vide pour {cmd}")
        if fault_doc is not None:
            return self._wbxml_reply(record, fault_doc)
        with self._cond:
            ctx = _Ctx(req, cmd, user, dev, version, doc)
            gate = self._policy_gate(ctx)
            if gate is not None:
                return self._wbxml_reply(record, gate)
            result = handler(ctx)
            self._cond.notify_all()
        return self._wbxml_reply(record, result)

    def _wbxml_reply(self, record, doc):
        if doc is None:
            return 200, [], b""
        record["response"] = doc
        status = doc.child("Status")
        if status is not None:
            record["status"] = status.text()
        return 200, [], wbxml.encode(doc)

    # ── Provisioning ──────────────────────────────────────────────────────

    def _policy_gate(self, ctx):
        """None if the command may run; else a status document (or HTTP 449)."""
        dev = ctx.device
        legacy = ctx.version.startswith("12.") or self.options.provision_style == "449"
        if ctx.cmd == "Provision":
            return None
        if dev.wipe:
            if legacy:
                raise _HttpAbort(449, "effacement à distance demandé")
            return _status_doc(ctx.cmd, 140)
        if not self.options.require_provisioning or self.options.policy is None:
            return None
        key = ctx.req.header("x-ms-policykey")
        if dev.policy_key is None or key in (None, "", "0"):
            code = 142
        elif key != dev.policy_key:
            code = 144
        elif dev.policy_version != self._policy_version:
            code = 143
        else:
            return None
        ctx.record["policy_refused"] = code
        if legacy:
            raise _HttpAbort(449, f"appareil non provisionné (équivalent Status {code})")
        return _status_doc(ctx.cmd, code)

    def _new_policy_key(self):
        return str(secrets.randbelow(0xFFFFFFFE) + 1)

    def _cmd_provision(self, ctx):
        doc, dev = ctx.doc, ctx.device
        pre = []
        info_el = doc.child("Settings:DeviceInformation")
        if info_el is not None:
            settings = info_el.child("Set")
            if settings is None:
                self._protocol_error(ctx, "DeviceInformation sans Set")
                return el("Provision:Provision", [el("Status", "2")])
            dev.info = {c.tag: c.text() for c in settings.children}
            pre.append(el("Settings:DeviceInformation", [el("Status", "1")]))
        wipe_el = doc.child("RemoteWipe") or doc.child("AccountOnlyRemoteWipe")
        if wipe_el is not None:
            status = wipe_el.text("Status")
            dev.wipe_ack = status
            self._action(ctx, "wipe_ack", status=status, account_only=wipe_el.tag == "AccountOnlyRemoteWipe")
            return el("Provision:Provision", [*pre, el("Status", "1")])
        policies = doc.child("Policies")
        policy = policies.child("Policy") if policies is not None else None
        if dev.wipe:
            dev.wipe_notified += 1
            self._action(ctx, "provision", phase=1 if policy is None or not policy.has("PolicyKey") else 2,
                         policy_key=None, status=None, wipe_sent=dev.wipe, device_info=dict(dev.info))
            tag = "AccountOnlyRemoteWipe" if dev.wipe == "account" else "RemoteWipe"
            return el("Provision:Provision", [*pre, el("Status", "1"), el(tag)])
        if policy is None:
            self._protocol_error(ctx, "Provision sans Policies/Policy")
            return el("Provision:Provision", [*pre, el("Status", "2")])
        policy_type = policy.text("PolicyType")
        key = policy.text("PolicyKey")
        ack = policy.text("Status")
        phase = 1 if key is None else 2
        entry = self._action(ctx, "provision", phase=phase, policy_type=policy_type, policy_key=key, status=ack,
                             device_info=dict(dev.info), header_key=ctx.req.header("x-ms-policykey"))
        if policy_type != POLICY_TYPE:
            entry["result"] = "unknown-policy-type"
            return el("Provision:Provision", [*pre, el("Status", "1"), el("Policies", [el("Policy", [
                el("PolicyType", policy_type or ""), el("Status", "3")])])])
        if phase == 1:
            if ack is not None:
                self._protocol_error(ctx, "Provision : Status sans PolicyKey")
                return el("Provision:Provision", [*pre, el("Status", "2")])
            if ctx.version == "14.1" and info_el is None and self.options.require_device_information:
                self._protocol_error(ctx, "Provision 14.1 sans DeviceInformation")
                entry["result"] = "device-information-required"
                return el("Provision:Provision", [el("Status", "165")])
            if self.options.policy is None:
                dev.policy_key = None
                entry["result"] = "no-policy"
                return el("Provision:Provision", [*pre, el("Status", "1"), el("Policies", [el("Policy", [
                    el("PolicyType", POLICY_TYPE), el("Status", "2")])])])
            dev.pending_key = self._new_policy_key()
            entry["temporary_key"] = dev.pending_key
            policy_doc = [el(f"Provision:{name}", value) for name, value in self.options.policy]
            return el("Provision:Provision", [*pre, el("Status", "1"), el("Policies", [el("Policy", [
                el("PolicyType", POLICY_TYPE), el("Status", "1"), el("PolicyKey", dev.pending_key),
                el("Data", [el("EASProvisionDoc", policy_doc)])])])])
        # Phase 2: acknowledgement of the policy received with the temporary key.
        if ack not in ("1", "2", "3", "4"):
            self._protocol_error(ctx, f"Provision : accusé de réception invalide « {ack} »")
            entry["result"] = "bad-ack"
            return el("Provision:Provision", [*pre, el("Status", "2")])
        if dev.pending_key is None or key != dev.pending_key:
            entry["result"] = "key-mismatch"
            return el("Provision:Provision", [*pre, el("Status", "1"), el("Policies", [el("Policy", [
                el("PolicyType", POLICY_TYPE), el("Status", "5")])])])
        dev.ack_status = ack
        if ack not in self.options.accepted_ack_statuses:
            entry["result"] = "refused"
            dev.pending_key = None
            return el("Provision:Provision", [*pre, el("Status", "139")])
        dev.policy_key = self._new_policy_key()
        dev.policy_version = self._policy_version
        dev.pending_key = None
        entry["result"] = "provisioned"
        entry["final_key"] = dev.policy_key
        return el("Provision:Provision", [*pre, el("Status", "1"), el("Policies", [el("Policy", [
            el("PolicyType", POLICY_TYPE), el("Status", "1"), el("PolicyKey", dev.policy_key)])])])

    # ── FolderSync and folder commands ────────────────────────────────────

    def _folder_changes(self, user, known):
        current = self._hierarchy_snapshot(user)
        depth = {}

        def depth_of(fid):
            d, seen = 0, set()
            while fid in current and fid not in seen:
                seen.add(fid)
                fid = current[fid][0]
                d += 1
            return d

        for fid in current:
            depth[fid] = depth_of(fid)
        adds = sorted((fid for fid in current if fid not in known), key=lambda f: (depth[f], int(f)))
        updates = [fid for fid in current if fid in known and known[fid] != current[fid]]
        deletes = [fid for fid in known if fid not in current]
        changes = []
        for fid in adds:
            p, n, t = current[fid]
            changes.append(el("Add", [el("ServerId", fid), el("ParentId", p), el("DisplayName", n), el("Type", t)]))
        for fid in updates:
            p, n, t = current[fid]
            changes.append(el("Update", [el("ServerId", fid), el("ParentId", p), el("DisplayName", n),
                                         el("Type", t)]))
        for fid in deletes:
            changes.append(el("Delete", [el("ServerId", fid)]))
        return changes, current

    def _cmd_foldersync(self, ctx):
        user, dev = ctx.user, ctx.device
        key = ctx.doc.text("SyncKey")
        if key is None or not _SYNC_KEY.match(key):
            self._protocol_error(ctx, "FolderSync sans SyncKey valide")
            return el("FolderHierarchy:FolderSync", [el("Status", "10")])
        h = dev.hierarchy
        if key == "0":
            dev.hierarchy_counter += 1
            h = dev.hierarchy = HierarchyState(dev.hierarchy_counter)
            if self.options.foldersync_zero_resets_collections:
                dev.collections.clear()
        elif h is not None and key == h.key:
            pass
        elif h is not None and key == h.prev_key:
            h.rollback()
        else:
            dev.hierarchy = None
            ctx.record["note"] = "SyncKey de hiérarchie inconnue : état de l'appareil effacé"
            return el("FolderHierarchy:FolderSync", [el("Status", "9")])
        changes, current = self._folder_changes(user, h.known)
        if changes or key == "0":
            dev.hierarchy_counter += 1
            h.prev = (h.counter, h.known)
            h.counter = dev.hierarchy_counter
            h.known = current
        return el("FolderHierarchy:FolderSync", [el("Status", "1"), el("SyncKey", h.key), el("Changes", [
            el("Count", len(changes)), *changes])])

    def _folder_op_key(self, ctx, root):
        """None if the request's SyncKey is the device's current hierarchy key, else the error document."""
        key = ctx.doc.text("SyncKey")
        h = ctx.device.hierarchy
        if key is None:
            self._protocol_error(ctx, f"{ctx.cmd} sans SyncKey")
            return el(root, [el("Status", "10")])
        if h is None or key != h.key:
            return el(root, [el("Status", "9")])
        return None

    def _advance_hierarchy(self, dev, user):
        h = dev.hierarchy
        dev.hierarchy_counter += 1
        h.prev = (h.counter, h.known)
        h.counter = dev.hierarchy_counter
        # The device knows its own change; other server changes stay pending.
        h.known = dict(h.known)

    def _cmd_foldercreate(self, ctx):
        root = "FolderHierarchy:FolderCreate"
        user, dev, doc = ctx.user, ctx.device, ctx.doc
        parent, name, type_text = doc.text("ParentId"), doc.text("DisplayName"), doc.text("Type")
        entry = self._action(ctx, "folder_create", parent_id=parent, name=name, type=type_text, status=None,
                             server_id=None)
        bad = self._folder_op_key(ctx, root)
        if bad is None and (parent is None or not name or type_text is None or not type_text.isdigit()):
            self._protocol_error(ctx, "FolderCreate incomplet")
            bad = el(root, [el("Status", "10")])
        if bad is None and int(type_text) not in CREATABLE_TYPES:
            self._protocol_error(ctx, f"FolderCreate : type {type_text} non créable")
            bad = el(root, [el("Status", "10")])
        if bad is None and parent != "0" and parent not in user.folders:
            bad = el(root, [el("Status", "5")])
        if bad is None and any(f.parent_id == parent and f.name.lower() == name.lower()
                               for f in user.folders.values()):
            bad = el(root, [el("Status", "2")])
        if bad is not None:
            entry["status"] = bad.text("Status")
            return bad
        folder = self._new_folder(user, parent, name, int(type_text))
        self._advance_hierarchy(dev, user)
        dev.hierarchy.known[folder.server_id] = (folder.parent_id, folder.name, folder.type)
        entry.update(status="1", server_id=folder.server_id)
        return el(root, [el("Status", "1"), el("SyncKey", dev.hierarchy.key), el("ServerId", folder.server_id)])

    def _cmd_folderupdate(self, ctx):
        root = "FolderHierarchy:FolderUpdate"
        user, dev, doc = ctx.user, ctx.device, ctx.doc
        sid, parent, name = doc.text("ServerId"), doc.text("ParentId"), doc.text("DisplayName")
        entry = self._action(ctx, "folder_update", server_id=sid, parent_id=parent, name=name, status=None)
        bad = self._folder_op_key(ctx, root)
        if bad is None and (sid is None or parent is None or not name):
            self._protocol_error(ctx, "FolderUpdate incomplet")
            bad = el(root, [el("Status", "10")])
        folder = user.folders.get(sid) if bad is None else None
        if bad is None and folder is None:
            bad = el(root, [el("Status", "4")])
        if bad is None and folder.type not in USER_TYPES:
            bad = el(root, [el("Status", "3")])
        if bad is None and parent != "0" and (parent not in user.folders or parent == sid
                                              or parent in self._descendants(user, sid)):
            bad = el(root, [el("Status", "5")])
        if bad is None and any(f.parent_id == parent and f.name.lower() == name.lower() and f.server_id != sid
                               for f in user.folders.values()):
            bad = el(root, [el("Status", "2")])
        if bad is not None:
            entry["status"] = bad.text("Status")
            return bad
        folder.parent_id, folder.name = parent, name
        self._advance_hierarchy(dev, user)
        dev.hierarchy.known[sid] = (parent, name, folder.type)
        entry["status"] = "1"
        return el(root, [el("Status", "1"), el("SyncKey", dev.hierarchy.key)])

    def _cmd_folderdelete(self, ctx):
        root = "FolderHierarchy:FolderDelete"
        user, dev, doc = ctx.user, ctx.device, ctx.doc
        sid = doc.text("ServerId")
        entry = self._action(ctx, "folder_delete", server_id=sid, status=None, deleted=[])
        bad = self._folder_op_key(ctx, root)
        if bad is None and sid is None:
            self._protocol_error(ctx, "FolderDelete sans ServerId")
            bad = el(root, [el("Status", "10")])
        folder = user.folders.get(sid) if bad is None else None
        if bad is None and folder is None:
            bad = el(root, [el("Status", "4")])
        if bad is None and folder.type not in USER_TYPES:
            bad = el(root, [el("Status", "3")])
        if bad is not None:
            entry["status"] = bad.text("Status")
            return bad
        ids = [sid, *self._descendants(user, sid)]
        for fid in ids:
            user.folders.pop(fid, None)
        self._advance_hierarchy(dev, user)
        for fid in ids:
            dev.hierarchy.known.pop(fid, None)
            dev.collections.pop(fid, None)
        entry.update(status="1", deleted=ids)
        return el(root, [el("Status", "1"), el("SyncKey", dev.hierarchy.key)])

    # ── Sync ──────────────────────────────────────────────────────────────

    def _parse_options(self, coll, folder):
        """Sticky options of a collection from its <Options> -> (dict or None, error message)."""
        chosen = None
        for opts in coll.children_named("Options"):
            cls = opts.text("Class")
            if cls is None or cls == folder.cls:
                chosen = opts
                break
        if chosen is None:
            return None, None
        out = {"filter_type": 0, "body_prefs": [], "mime_support": 0, "conflict": 1, "rights_management": False}
        for c in chosen.children:
            name = c.name
            value = c.text() if c.value is not None else ""
            if name == "AirSync:FilterType":
                if not value.isdigit() or int(value) not in FILTERS_BY_CLASS.get(folder.cls, {0}):
                    return None, f"FilterType {value} invalide pour {folder.cls}"
                out["filter_type"] = int(value)
            elif name == "AirSyncBase:BodyPreference":
                t = c.text("Type")
                if t is None or t not in ("1", "2", "3", "4"):
                    return None, f"BodyPreference/Type {t} invalide"
                trunc = c.text("TruncationSize")
                if trunc is not None and not trunc.isdigit():
                    return None, "TruncationSize invalide"
                all_or_none = c.text("AllOrNone")
                if all_or_none not in (None, "0", "1"):
                    return None, "AllOrNone invalide"
                preview = c.text("Preview")
                if preview is not None and (not preview.isdigit() or int(preview) > 255):
                    return None, "Preview invalide"
                out["body_prefs"].append({"type": int(t), "truncation": int(trunc) if trunc is not None else None,
                                          "all_or_none": all_or_none == "1",
                                          "preview": int(preview) if preview else None})
            elif name == "AirSync:MIMESupport":
                if value not in ("0", "1", "2"):
                    return None, f"MIMESupport {value} invalide"
                out["mime_support"] = int(value)
            elif name == "AirSync:Conflict":
                if value not in ("0", "1"):
                    return None, f"Conflict {value} invalide"
                out["conflict"] = int(value)
            elif name == "AirSync:MIMETruncation":
                if not value.isdigit() or int(value) > 8:
                    return None, f"MIMETruncation {value} invalide"
                out["mime_truncation"] = int(value)
            elif name == "AirSync:MaxItems":
                if not value.isdigit():
                    return None, "MaxItems invalide"
                out["max_items"] = int(value)
            elif name == "RightsManagement:RightsManagementSupport":
                out["rights_management"] = value == "1"
            elif name in ("AirSync:Class", "AirSyncBase:BodyPartPreference"):
                pass
            else:
                return None, f"élément {name} inattendu dans Options"
        return out, None

    def _body(self, item, options):
        prefs = options.get("body_prefs") or [{"type": 1, "truncation": None, "all_or_none": False,
                                               "preview": None}]
        mime_support = options.get("mime_support", 0)
        s = item.summary
        is_smime = "pkcs7" in s.content_type or "multipart/signed" in s.content_type
        chosen = None
        for p in prefs:
            if p["type"] == 4 and not (mime_support == 2 or (mime_support == 1 and is_smime)):
                continue
            if p["type"] in (1, 2, 4):
                chosen = p
                break
        if chosen is None:
            chosen = {"type": 1, "truncation": None, "all_or_none": False, "preview": None}
        plain, rich = _text_bodies(item.mime)
        if chosen["type"] == 4:
            data = item.mime
        elif chosen["type"] == 2:
            data = (rich if rich is not None else "<html><body><pre>" + html.escape(plain) + "</pre></body></html>"
                    ).encode("utf-8")
        else:
            data = plain.encode("utf-8")
        full = len(data)
        limit = chosen["truncation"]
        truncated = limit is not None and full > limit
        if truncated:
            if chosen["all_or_none"]:
                data = b""
            else:
                data = data[:limit]
                if chosen["type"] != 4:
                    data = data.decode("utf-8", "ignore").encode("utf-8")
        children = [el("AirSyncBase:Type", chosen["type"]), el("AirSyncBase:EstimatedDataSize", full)]
        if truncated:
            children.append(el("AirSyncBase:Truncated", "1"))
        if data or not truncated:
            opaque = self.options.body_data_opaque or b"\x00" in data
            children.append(el("AirSyncBase:Data", data, opaque=opaque))
        if chosen["preview"]:
            children.append(el("AirSyncBase:Preview", " ".join(plain.split())[:chosen["preview"]]))
        return el("AirSyncBase:Body", children), (2 if rich is not None else 1)

    def _flag_element(self, item):
        if item.flag == 2:
            start = eas_date(item.date)
            return el("Email:Flag", [el("Email:Status", "2"), el("Email:FlagType", "Flag for follow up"),
                                     el("Tasks:StartDate", start), el("Tasks:UtcStartDate", start),
                                     el("Tasks:DueDate", start), el("Tasks:UtcDueDate", start)])
        if item.flag == 1:
            done = eas_date(_utcnow())
            return el("Email:Flag", [el("Email:Status", "1"), el("Email:CompleteTime", done),
                                     el("Tasks:DateCompleted", done)])
        return el("Email:Flag")

    def _application_data(self, item, options, full=True, version="14.1"):
        """ApplicationData children: everything for an Add or Fetch, the changeable properties for a Change
        (an event or a task is always sent whole)."""
        if item.raw is not None:
            return list(item.raw)
        if item.pim is not None:
            if item.cls == "Calendar":
                return self._event_data(item.pim, options, version)
            return self._task_data(item.pim, options, version)
        if not full:
            out = [el("Email:Read", "1" if item.read else "0"), self._flag_element(item)]
            if item.categories:
                out.append(el("Email:Categories", [el("Email:Category", c) for c in item.categories]))
            return out
        s = item.summary
        body, native = self._body(item, options)
        topic = re.sub(r"^\s*((re|fw|fwd|tr)\s*:\s*)+", "", s.subject, flags=re.I)
        out = []
        if s.to:
            out.append(el("Email:To", s.to))
        if s.cc:
            out.append(el("Email:Cc", s.cc))
        out += [el("Email:From", s.sender), el("Email:Subject", s.subject)]
        if s.reply_to:
            out.append(el("Email:ReplyTo", s.reply_to))
        out += [el("Email:DateReceived", eas_date(item.date)), el("Email:DisplayTo", s.display_to),
                el("Email:ThreadTopic", topic), el("Email:Importance", s.importance),
                el("Email:Read", "1" if item.read else "0"), body]
        if item.invitation is not None:  # [MS-ASCMD] 3.1.5.6, example 4.16.3.2
            out += [el("Email:MessageClass", "IPM.Schedule.Meeting.Request"),
                    self._meeting_request_el(item.invitation, version)]
            content_class = "urn:content-classes:calendarmessage"
        else:
            out.append(el("Email:MessageClass", "IPM.Note"))
            content_class = "urn:content-classes:message"
        out += [el("Email:InternetCPID", "65001"), self._flag_element(item),
                el("Email:ContentClass", content_class), el("AirSyncBase:NativeBodyType", native),
                el("Email2:ConversationId", hashlib.md5(topic.lower().encode("utf-8")).digest()),
                el("Email2:ConversationIndex", int(item.date.timestamp()).to_bytes(5, "big", signed=False))]
        if item.categories:
            out.append(el("Email:Categories", [el("Email:Category", c) for c in item.categories]))
        return out

    def _apply_change(self, item, data):
        """Client Change of an email -> (status, what changed, ignored property names)."""
        changed, ignored = {}, []
        for c in data.children:
            if c.name == "Email:Read":
                value = c.text()
                if value not in ("0", "1"):
                    return "6", changed, ignored
                changed["read"] = value == "1"
            elif c.name == "Email:Flag":
                status = c.text("Email:Status")
                if not c.children:
                    status = "0"
                if status not in ("0", "1", "2"):
                    return "6", changed, ignored
                changed["flag"] = int(status)
            elif c.name == "Email:Categories":
                changed["categories"] = [x.text() for x in c.children_named("Email:Category")]
            else:
                ignored.append(c.name)
        if "read" in changed:
            item.read = changed["read"]
        if "flag" in changed:
            item.flag = changed["flag"]
        if "categories" in changed:
            item.categories = changed["categories"]
        return "1", changed, ignored

    def _client_commands(self, ctx, folder, state, commands_el, working, deletes_as_moves):
        user = ctx.user
        responses = []
        for cmd in commands_el.children:
            sid = cmd.text("ServerId")
            if cmd.tag == "Change":
                data = cmd.child("ApplicationData")
                item = folder.items.get(sid) if sid else None
                entry = self._action(ctx, "sync_change", collection_id=folder.server_id, server_id=sid,
                                     changes={}, ignored=[], status=None)
                if sid is None or data is None:
                    self._protocol_error(ctx, "Change sans ServerId ou ApplicationData")
                    status = "6"
                elif item is None:
                    status = "8"
                elif item.raw is not None:
                    item.raw = list(data.children)
                    status = "1"
                elif item.pim is not None:
                    entry["class"] = item.cls
                    status = self._pim_change(ctx, folder, state, item, data, working, entry)
                else:
                    base = working.get(sid)
                    before = (item.read, item.flag, list(item.categories))
                    status, changed, ignored = self._apply_change(item, data)
                    entry.update(changes=changed, ignored=ignored)
                    if status == "1" and (item.read, item.flag, item.categories) != before:
                        conflict = base != item.version
                        item.version += 1
                        if not conflict:
                            working[sid] = item.version
                        entry["conflict"] = conflict
                entry["status"] = status
                if status != "1" or self.options.sync_responses_for_success:
                    responses.append(el("Change", [el("ServerId", sid or ""), el("Status", status)]))
            elif cmd.tag == "Delete":
                entry = self._action(ctx, "sync_delete", collection_id=folder.server_id, server_id=sid,
                                     deletes_as_moves=deletes_as_moves, moved_to=None, status=None)
                if sid is None:
                    self._protocol_error(ctx, "Delete sans ServerId")
                    entry["status"] = "6"
                    continue
                working.pop(sid, None)
                if sid not in folder.items:
                    entry["status"] = "8"  # nothing to delete: a real server says nothing either
                    continue
                trash = next((f for f in user.folders.values() if f.type == FolderType.DELETED), None)
                if deletes_as_moves and trash is not None and folder is not trash and folder.cls == "Email":
                    entry["moved_to"] = (trash.server_id, self._move_item(folder, sid, trash))
                else:
                    del folder.items[sid]
                entry["status"] = "1"
            elif cmd.tag == "Add":
                client_id = cmd.text("ClientId")
                data = cmd.child("ApplicationData")
                entry = self._action(ctx, "sync_add", collection_id=folder.server_id, client_id=client_id,
                                     status=None, server_id=None)
                if client_id is None or data is None:
                    self._protocol_error(ctx, "Add sans ClientId ou ApplicationData")
                    status, new_id = "6", None
                elif folder.cls == "Email":
                    status, new_id = "6", None  # [MS-ASCMD]: no email Add before protocol 16.0
                elif folder.cls in ("Calendar", "Tasks"):
                    entry["class"] = folder.cls
                    status, new_id = self._pim_add(ctx, folder, data, working, entry)
                else:
                    item = Item(folder.new_item_id(), raw=list(data.children), cls=folder.cls)
                    folder.items[item.server_id] = item
                    working[item.server_id] = item.version
                    status, new_id = "1", item.server_id
                entry.update(status=status, server_id=new_id)
                answer = [el("ClientId", client_id or "")]
                if new_id:
                    answer.append(el("ServerId", new_id))
                answer.append(el("Status", status))
                responses.append(el("Add", answer))
            elif cmd.tag == "Fetch":
                item = folder.items.get(sid) if sid else None
                self._action(ctx, "sync_fetch", collection_id=folder.server_id, server_id=sid,
                             status="1" if item else "8")
                if item is None:
                    responses.append(el("Fetch", [el("ServerId", sid or ""), el("Status", "8")]))
                else:
                    responses.append(el("Fetch", [el("ServerId", sid), el("Status", "1"), el(
                        "ApplicationData", self._application_data(item, state.options, version=ctx.version))]))
            else:
                self._protocol_error(ctx, f"commande {cmd.tag} inattendue dans Commands")
                return None
        return responses

    def _sync_collection(self, ctx, coll, budget):
        """-> (Collection element, True if it has nothing to report)."""
        user, dev = ctx.user, ctx.device
        key, cid = coll.text("SyncKey"), coll.text("CollectionId")

        def reply(status, new_key=None, commands=(), responses=(), more=False):
            children = [el("SyncKey", new_key if new_key is not None else (key or "0")),
                        el("CollectionId", cid or ""), el("Status", status)]
            if commands:
                children.append(el("Commands", list(commands)))
            if responses:
                children.append(el("Responses", list(responses)))
            if more:
                children.append(el("MoreAvailable"))
            return el("Collection", children)

        if key is None or cid is None or not _SYNC_KEY.match(key) or not _ITEM_ID.match(cid):
            self._protocol_error(ctx, "Collection sans SyncKey ou CollectionId valide")
            return reply("4"), False
        folder = user.folders.get(cid)
        if folder is None or dev.hierarchy is None or cid not in dev.hierarchy.known:
            return reply("12"), False
        if self.options.status12_on_hierarchy_change and self._hierarchy_stale(user, dev):
            return reply("12"), False
        supported = None
        if folder.cls in ("Calendar", "Tasks"):
            supported, problem = self._supported(ctx, coll, folder, key)
            if problem:
                self._protocol_error(ctx, problem)
                return reply("4"), False
        options, problem = self._parse_options(coll, folder)
        if problem:
            self._protocol_error(ctx, problem)
            return reply("4"), False
        commands_el = coll.child("Commands")
        gc = coll.child("GetChanges")
        if gc is None:
            get_changes = key != "0"
        elif gc.value in (None, b"", b"1"):
            get_changes = True
        elif gc.value == b"0":
            get_changes = False
        else:
            self._protocol_error(ctx, "GetChanges invalide")
            return reply("4"), False
        window = self.options.default_window_size
        ws = coll.text("WindowSize")
        if ws is not None:
            if not ws.isdigit() or int(ws) < 1:
                self._protocol_error(ctx, f"WindowSize {ws} invalide")
                return reply("4"), False
            window = min(int(ws), self.options.max_window_size)
        dam = coll.text("DeletesAsMoves")
        if dam not in (None, "", "0", "1"):
            self._protocol_error(ctx, "DeletesAsMoves invalide")
            return reply("4"), False
        deletes_as_moves = dam != "0"  # [MS-ASCMD] 2.2.3.43: absent means TRUE
        if key == "0":
            if commands_el is not None or (gc is not None and get_changes):
                self._protocol_error(ctx, "SyncKey 0 avec Commands ou GetChanges")
                return reply("4"), False
            state = CollectionState(cid)
            state.options = options or {}
            state.supported = supported
            dev.collections[cid] = state
            return reply("1", state.key), False
        state = dev.collections.get(cid)
        if state is None or key not in (state.key, state.prev_key):
            dev.collections.pop(cid, None)
            ctx.record.setdefault("notes", []).append(f"SyncKey inconnue pour {cid} : état effacé")
            return reply("3", "0"), False
        if key == state.prev_key:
            state.rollback()
            ctx.record.setdefault("notes", []).append(f"SyncKey précédente pour {cid} : réponse rejouée")
        if (options is not None and self.options.status3_on_filter_change
                and options.get("filter_type", 0) != state.options.get("filter_type", 0)):
            dev.collections.pop(cid, None)
            ctx.record.setdefault("notes", []).append(f"FilterType changé pour {cid} : état effacé")
            return reply("3", "0"), False
        if options is not None:
            state.options = options
        fail = self.options.fail_next_calendar_change
        if (fail is not None and str(fail) in ("5", "16") and folder.cls == "Calendar" and commands_el is not None
                and any(c.tag == "Change" for c in commands_el.children)):
            # A status whose scope is the whole collection: nothing is applied, the key does not move.
            self.options.fail_next_calendar_change = None
            self._action(ctx, "sync_change", collection_id=cid, server_id=None, changes={}, ignored=[],
                         status=str(fail), injected=str(fail))
            return reply(str(fail)), False
        working = dict(state.known)
        responses = []
        if commands_el is not None:
            responses = self._client_commands(ctx, folder, state, commands_el, working, deletes_as_moves)
            if responses is None:
                return reply("4"), False
        commands, more = [], False
        if get_changes:
            pending = self._pending(folder, state.options, working)
            limit = window if budget[0] is None else min(window, budget[0])
            chosen, more = pending[:limit], len(pending) > limit
            if budget[0] is not None:
                budget[0] -= len(chosen)
            view = folder.items
            for op, sid in chosen:
                if op in ("Delete", "SoftDelete"):
                    working.pop(sid, None)
                    commands.append(el(op, [el("ServerId", sid)]))
                else:
                    item = view[sid]
                    working[sid] = item.version
                    data = self._application_data(item, state.options, full=op == "Add", version=ctx.version)
                    commands.append(el(op, [el("ServerId", sid), el("ApplicationData", data)]))
        if commands_el is None and not commands and not responses:
            return reply("1", state.key), True
        state.advance(working)
        return reply("1", state.key, commands, responses, more), False

    def _sync_wait_seconds(self, doc):
        """-> (seconds or None, error document or None)."""
        wait, hb = doc.text("Wait"), doc.text("HeartbeatInterval")
        if wait is not None and hb is not None:
            return None, _status_doc("Sync", 4)
        if wait is not None:
            if not wait.isdigit():
                return None, _status_doc("Sync", 4)
            if not 1 <= int(wait) <= 59:
                return None, _status_doc("Sync", 14, el("Limit", 1 if int(wait) < 1 else 59))
            return int(wait) * 60, None
        if hb is not None:
            if not hb.isdigit():
                return None, _status_doc("Sync", 4)
            lo, hi = self.options.heartbeat_min, self.options.heartbeat_max
            if not lo <= int(hb) <= hi:
                return None, _status_doc("Sync", 14, el("Limit", lo if int(hb) < lo else hi))
            return int(hb), None
        return None, None

    @staticmethod
    def _with_current_key(dev, coll):
        """A cached collection (no SyncKey, no Commands) with the key the server issued last."""
        state = dev.collections.get(coll.text("CollectionId"))
        key = state.key if state is not None else "-"  # no state: the collection gets Status 3
        return Element("AirSync", "Collection", [Element("AirSync", "SyncKey", value=key.encode("ascii")),
                                                 *coll.children])

    def _cmd_sync(self, ctx):
        """[MS-ASCMD] 2.2.1.21. An empty request (or Partial) reuses the last one: its collections and
        options, with the latest SyncKeys and without its Commands."""
        dev = ctx.device
        doc = ctx.doc
        cached = dev.last_sync
        if doc is None:
            if cached is None:
                return _status_doc("Sync", 13)
            top_children = cached["top"]
            colls = [self._with_current_key(dev, c) for c in cached["collections"]]
        else:
            top_children = [c for c in doc.children if c.tag in ("Wait", "HeartbeatInterval", "WindowSize")]
            colls_el = doc.child("Collections")
            given = colls_el.children_named("Collection") if colls_el is not None else []
            if doc.has("Partial"):
                if cached is None:
                    return _status_doc("Sync", 13)
                by_id = {c.text("CollectionId"): self._with_current_key(dev, c) for c in cached["collections"]}
                for c in given:
                    by_id[c.text("CollectionId")] = c
                colls = list(by_id.values())
                top_children = top_children or cached["top"]
            else:
                colls = given
        if not colls:
            self._protocol_error(ctx, "Sync sans Collections")
            return _status_doc("Sync", 4)
        top = Element("AirSync", "Sync", top_children)
        seconds, error = self._sync_wait_seconds(top)
        if error is not None:
            return error
        ids = [c.text("CollectionId") for c in colls]
        if len(set(ids)) != len(ids):
            self._protocol_error(ctx, "Sync : une collection apparaît deux fois")
            return _status_doc("Sync", 4)
        window = top.text("WindowSize")
        budget = [None]
        if window is not None:
            if not window.isdigit() or int(window) < 1:
                self._protocol_error(ctx, "WindowSize invalide")
                return _status_doc("Sync", 4)
            budget = [min(int(window), self.options.max_window_size)]
        dev.last_sync = {"top": top_children, "collections": [
            Element("AirSync", "Collection", [x for x in c.children
                                              if x.tag not in ("SyncKey", "Commands", "Supported")])
            for c in colls]}
        if seconds:
            self._sync_wait(ctx, colls, seconds)
        results = [self._sync_collection(ctx, c, budget) for c in colls]
        if self.options.empty_sync_response and all(nothing for _, nothing in results):
            return None
        return el("AirSync:Sync", [el("Collections", [r for r, _ in results])])

    def _sync_wait(self, ctx, colls, seconds):
        """Hold a Sync with Wait/HeartbeatInterval until one of its collections has news (lock held)."""
        user, dev = ctx.user, ctx.device

        def ready():
            for c in colls:
                cid, key = c.text("CollectionId"), c.text("SyncKey")
                state = dev.collections.get(cid)
                if c.has("Commands") or key == "0" or state is None or key != state.key:
                    return True
                if self._folder_has_changes(user, dev, cid):
                    return True
            return False

        deadline = time.monotonic() + seconds * self.options.heartbeat_scale
        while not ready() and not self._stopping:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or self._client_gone(ctx.req.conn):
                return
            self._cond.wait(min(remaining, 0.25))

    def _client_gone(self, conn):
        """Has the client closed the connection (or sent anything) while its request is held?"""
        try:
            readable, _, _ = select.select([conn], [], [], 0)
        except (OSError, ValueError):
            return True
        if not readable:
            return False
        try:
            conn.setblocking(False)
            try:
                data = conn.recv(1)
            finally:
                conn.settimeout(self.options.io_timeout)
        except ssl.SSLWantReadError:
            return False  # part of a TLS record: nothing to read yet
        except (OSError, ssl.SSLError, ValueError):
            return True
        # Closed (b""), or bytes the client should not send while waiting: either way, the request is over.
        del data
        return True

    # ── Ping ──────────────────────────────────────────────────────────────

    def _cmd_ping(self, ctx):
        user, dev, doc = ctx.user, ctx.device, ctx.doc
        o = self.options
        heartbeat, folders = None, None
        if doc is not None:
            hb = doc.text("HeartbeatInterval")
            if hb is not None:
                if not hb.isdigit():
                    self._protocol_error(ctx, "HeartbeatInterval invalide")
                    return _status_doc("Ping", 4)
                heartbeat = int(hb)
            folders_el = doc.child("Folders")
            if folders_el is not None:
                folders = []
                for f in folders_el.children_named("Folder"):
                    fid, cls = f.text("Id"), f.text("Class")
                    if not fid or cls not in ("Email", "Calendar", "Contacts", "Tasks", "Notes"):
                        self._protocol_error(ctx, "Ping : Folder sans Id ou Class valide")
                        return _status_doc("Ping", 4)
                    folders.append((fid, cls))
        cached = dev.last_ping
        if heartbeat is None:
            heartbeat = cached[0] if cached else None
        if folders is None:
            folders = cached[1] if cached else None
        if heartbeat is None or not folders:
            return _status_doc("Ping", 3)
        if not o.heartbeat_min <= heartbeat <= o.heartbeat_max:
            limit = o.heartbeat_min if heartbeat < o.heartbeat_min else o.heartbeat_max
            return _status_doc("Ping", 5, el("HeartbeatInterval", limit))
        if len(folders) > o.max_ping_folders:
            return _status_doc("Ping", 6, el("MaxFolders", o.max_ping_folders))
        dev.last_ping = (heartbeat, folders)
        ids = [fid for fid, _ in folders]
        for fid, cls in folders:
            folder = user.folders.get(fid)
            if folder is None:
                return _status_doc("Ping", 7)
            if folder.cls != cls:
                self._protocol_error(ctx, f"Ping : classe {cls} pour le dossier {fid} ({folder.cls})")
                return _status_doc("Ping", 4)
        # A newer Ping replaces the device's previous one.
        for entry in self._pings.values():
            if entry["user"] == user.login and entry["device"] == dev.device_id:
                entry["superseded"] = True
        self._cond.notify_all()
        token = object()
        entry = {"user": user.login, "device": dev.device_id, "folders": ids, "heartbeat": heartbeat,
                 "started": time.time(), "forced": None, "superseded": False}
        if dev.pending_wake is not None:
            entry["forced"] = dev.pending_wake or ids
            dev.pending_wake = None
        self._pings[token] = entry
        deadline = time.monotonic() + heartbeat * o.heartbeat_scale
        try:
            while True:
                if entry["forced"] is not None:
                    changed = [f for f in entry["forced"] if f in ids] or ids
                    ctx.record["ping"] = "woken"
                    return el("Ping:Ping", [el("Status", "2"), el("Folders", [el("Folder", f) for f in changed])])
                changed = [fid for fid in ids if self._folder_has_changes(user, dev, fid)]
                if changed:
                    ctx.record["ping"] = "changes"
                    return el("Ping:Ping", [el("Status", "2"), el("Folders", [el("Folder", f) for f in changed])])
                if any(fid not in user.folders for fid in ids) or (
                        o.ping_status7_on_hierarchy_change and self._hierarchy_stale(user, dev)):
                    ctx.record["ping"] = "hierarchy"
                    return _status_doc("Ping", 7)
                if entry["superseded"] or self._stopping:
                    ctx.record["ping"] = "superseded" if entry["superseded"] else "stopping"
                    return _status_doc("Ping", 1)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    ctx.record["ping"] = "timeout"
                    return _status_doc("Ping", 1)
                if self._client_gone(ctx.req.conn):
                    ctx.record["ping"] = "client-gone"
                    raise _Drop("client parti pendant le Ping")
                self._cond.wait(min(remaining, 0.25))
        finally:
            self._pings.pop(token, None)

    # ── MoveItems ─────────────────────────────────────────────────────────

    def _cmd_moveitems(self, ctx):
        user, dev = ctx.user, ctx.device
        answers = []
        moves = ctx.doc.children_named("Move")
        if not moves:
            self._protocol_error(ctx, "MoveItems sans Move")
        for mv in moves:
            src_id, src_f, dst_f = mv.text("SrcMsgId"), mv.text("SrcFldId"), mv.text("DstFldId")
            entry = self._action(ctx, "move", src_msg_id=src_id, src_fld_id=src_f, dst_fld_id=dst_f, status=None,
                                 dst_msg_id=None)
            src = user.folders.get(src_f) if src_f else None
            dst = user.folders.get(dst_f) if dst_f else None
            if src_id is None or src is None or src_id not in src.items:
                status = "1"
            elif dst is None or dst.cls != src.cls:
                status = "2"
            elif src is dst:
                status = "4"
            else:
                status = "3"
            new_id = None
            if status == "3":
                new_id = self._move_item(src, src_id, dst)
                item = dst.items[new_id]
                src_state = dev.collections.get(src.server_id)
                if src_state is not None and not self.options.move_deletes_from_source:
                    src_state.known.pop(src_id, None)
                dst_state = dev.collections.get(dst.server_id)
                if dst_state is not None and not self.options.move_adds_to_destination:
                    dst_state.known[new_id] = item.version
            entry.update(status=status, dst_msg_id=new_id)
            answer = [el("SrcMsgId", src_id or ""), el("Status", status)]
            if new_id:
                answer.append(el("DstMsgId", new_id))
            answers.append(el("Response", answer))
        return el("Move:MoveItems", answers)

    # ── MeetingResponse ───────────────────────────────────────────────────

    def _cmd_meetingresponse(self, ctx):
        """[MS-ASCMD] 2.2.1.11: answer a meeting request in the Inbox, or (14.1) a meeting in the Calendar."""
        doc = ctx.doc

        def invalid(message):
            # InvalidXML ([MS-ASCMD] 2.2.2: Status 103; an HTTP 400 up to 12.1).
            self._protocol_error(ctx, message)
            if ctx.version.startswith("12."):
                raise _HttpAbort(400, message)
            return _status_doc("MeetingResponse", 103)

        requests = doc.children_named("MeetingResponse:Request")
        if not requests or len(requests) != len(doc.children):
            return invalid("MeetingResponse : un ou plusieurs Request attendus, rien d'autre")
        if len(requests) > self.options.max_meeting_responses:  # [MS-ASCMD] 3.1.5.10
            return invalid(f"MeetingResponse : plus de {self.options.max_meeting_responses} Request")
        return el("MeetingResponse:MeetingResponse", [self._meeting_response(ctx, r) for r in requests])

    def _meeting_response(self, ctx, req):
        """One Request -> its Result (RequestId, Status, CalendarId)."""
        user, dev = ctx.user, ctx.device
        parts, malformed = {}, None
        for c in req.children:
            if c.tag in parts or c.children or not (c.ns == "MeetingResponse" or c.name == "Search:LongId"):
                malformed = malformed or f"MeetingResponse : élément {c.name} en double ou inattendu"
            parts.setdefault(c.tag, c)

        def text(name):
            try:
                return parts[name].text() if name in parts else None
            except WbxmlError:
                return ""

        answer, cid, rid, instance = text("UserResponse"), text("CollectionId"), text("RequestId"), text("InstanceId")
        entry = {"seq": self._next_seq(), "time": time.time(), "user": user.login, "device": dev.device_id,
                 "response": int(answer) if answer in ("1", "2", "3") else None,
                 "answer": {"1": "accepted", "2": "tentative", "3": "declined"}.get(answer),
                 "collection_id": cid, "request_id": rid, "instance_id": instance, "source": None, "uid": None,
                 "organizer": None, "status": None, "calendar_id": None}
        self._meeting_responses.append(entry)

        def result(status, calendar_id=None, why=None, violation=False):
            entry.update(status=str(status), calendar_id=calendar_id)
            if why:
                entry["error"] = why
            if violation:
                self._protocol_error(ctx, f"MeetingResponse : {why}")
            self._action(ctx, "meeting_response", **{k: entry[k] for k in (
                "response", "answer", "collection_id", "request_id", "instance_id", "source", "uid", "status",
                "calendar_id")})
            children = [el("RequestId", rid)] if rid is not None else []
            children.append(el("Status", status))
            if calendar_id:
                children.append(el("CalendarId", calendar_id))
            return el("MeetingResponse:Result", children)

        # What the request itself must be ([MS-ASCMD] 2.2.3.150.2, 2.2.3.194, 6.25): Status 2 otherwise.
        if malformed:
            return result(2, why=malformed, violation=True)
        unknown = [n for n in parts if n not in ("UserResponse", "CollectionId", "RequestId", "InstanceId")]
        if unknown:  # LongId needs Search, which this server does not have; SendResponse and the rest are 16.x
            return result(2, why=f"élément {unknown[0]} non pris en charge en version {ctx.version}", violation=True)
        if entry["response"] is None:
            return result(2, why="UserResponse absent ou hors de 1, 2, 3", violation=True)
        if not cid or not rid or len(cid) > 64 or len(rid) > 64:
            return result(2, why="CollectionId ou RequestId absent ou trop long", violation=True)
        if instance is not None and ctx.version != "14.1":  # [MS-ASCMD] 2.2.3.92.1
            return result(2, why=f"InstanceId n'existe pas en version {ctx.version}", violation=True)
        if instance is not None and len(instance) != 24:
            return result(2, why="InstanceId : 24 caractères attendus", violation=True)
        fail = self.options.fail_next_meeting_response
        if fail is not None:
            self.options.fail_next_meeting_response = None
            return result(fail, why="panne simulée")
        folder = user.folders.get(cid)
        if folder is None:
            return result(2, why="dossier inconnu")
        if cid not in dev.collections:
            # 2.2.1.11: only for a folder the device synchronizes.
            return result(2, why="dossier que l'appareil ne synchronise pas", violation=True)
        item = folder.items.get(rid)
        if item is None:
            return result(2, why="élément inconnu")
        when = None
        if folder.cls == "Email" and item.invitation is not None:
            inv = item.invitation
            entry.update(source="mail", uid=inv["uid"], organizer=inv["organizer_email"])
            if instance is not None:  # 2.2.3.177.9: an InstanceId that names a meeting request mail
                return result(2, why="InstanceId sur un message d'invitation")
            if inv["message_type"] == 6:  # 3.1.5.6: a delegated request must not be answered
                return result(2, why="invitation déléguée (MeetingMessageType 6)", violation=True)
            organizer, event = inv["organizer_email"], None
        elif folder.cls == "Calendar" and item.pim is not None:
            event = item.pim
            entry.update(source="calendar", uid=event.get("uid"), organizer=event.get("organizer_email"))
            if ctx.version != "14.1":  # 2.2.1.11: not in the Calendar folder up to 14.0
                return result(2, why=f"réponse sur un élément d'agenda en version {ctx.version}", violation=True)
            if not (event.get("meeting_status") or 0) & 1:
                return result(2, why="cet élément n'est pas une réunion")
            organizer = event.get("organizer_email") or user.email
            if not (event.get("meeting_status") or 0) & 2:
                organizer = user.email
            if instance is not None:
                when = _parse_datetime(instance)
                if when is None:
                    return result(104, why="InstanceId : date invalide")
                if not event.get("recurrence"):
                    return result(146, why="InstanceId sur une réunion sans récurrence")
                until = event["recurrence"].get("until")
                gone = any(x["exception_start"] == when and x.get("deleted") for x in event["exceptions"])
                if when < event["start"] or (until is not None and when.date() > until.date()) or gone:
                    return result(2, why="InstanceId : occurrence inexistante")
        else:
            return result(2, why="ni invitation ni réunion")
        if organizer.lower() == user.email.lower():  # 2.2.3.177.9
            return result(2, why="l'utilisateur est l'organisateur de cette réunion")

        now = _utcnow().replace(microsecond=0)
        response_type = {1: 3, 2: 2, 3: 4}[entry["response"]]
        found = (folder, item) if event is not None else self._calendar_item_of(user, entry["uid"])
        calendar_id = None
        if when is not None:
            # One occurrence: the answer is kept in its exception; a declined occurrence is deleted.
            target = found[1]
            others = [x for x in target.pim["exceptions"] if x["exception_start"] != when]
            mine = next((x for x in target.pim["exceptions"] if x["exception_start"] == when),
                        {"exception_start": when, "deleted": False})
            mine = dict(mine, deleted=True) if entry["response"] == 3 else dict(
                mine, response_type=response_type, reply_time=now)
            target.pim["exceptions"] = others + [mine]
            target.version += 1
            calendar_id = None if entry["response"] == 3 else target.server_id
        elif entry["response"] == 3:
            # 3.1.5.6: declined, the server deletes the calendar item and returns no CalendarId.
            if found is not None:
                del found[0].items[found[1].server_id]
        elif found is not None:
            found[1].pim.update(response_type=response_type, reply_time=now,
                                busy_status=2 if entry["response"] == 1 else 1)
            found[1].version += 1
            calendar_id = found[1].server_id
        else:
            # 2.2.3.18: accepted or tentative, the server adds the calendar item if none is present.
            calendar_id = self._meeting_to_calendar(user, item.invitation, response_type,
                                                    2 if entry["response"] == 1 else 1, now)
        if when is None:
            self._retire_invitations(user, entry["uid"], item if event is None else None)
        return result(1, calendar_id)

    def _retire_invitations(self, user, uid, answered):
        """An answered invitation leaves the Inbox, by the option invitation_after_response: the mail that was
        answered, or, for an answer given on the calendar item, the invitations of that meeting in the Inbox."""
        how = self.options.invitation_after_response
        if how == "kept":
            return
        trash = next((f for f in user.folders.values() if f.type == FolderType.DELETED), None)
        for f in list(user.folders.values()):
            if f.cls != "Email" or f is trash or (answered is None and f.type != FolderType.INBOX):
                continue
            for sid, mail in list(f.items.items()):
                if mail is answered or (answered is None and mail.invitation is not None
                                        and mail.invitation["uid"] == uid):
                    if how == "deleted_items" and trash is not None:
                        self._move_item(f, sid, trash)
                    else:
                        del f.items[sid]

    # ── GetItemEstimate ───────────────────────────────────────────────────

    def _cmd_getitemestimate(self, ctx):
        user, dev = ctx.user, ctx.device
        colls = ctx.doc.find("Collections")
        out = []
        for c in (colls.children_named("Collection") if colls is not None else []):
            cid = c.text("CollectionId")
            key = c.text("AirSync:SyncKey")
            folder = user.folders.get(cid) if cid else None
            state = dev.collections.get(cid) if cid else None
            if folder is None:
                status = "2"
            elif key in (None, "0"):
                status = "3"
            elif state is None or key != state.key:
                status = "4"
            else:
                status = "1"
            children = [el("Status", status)]
            if status == "1":
                count = len(self._pending(folder, state.options, state.known))
                children.append(el("Collection", [el("CollectionId", cid), el("Estimate", count)]))
            out.append(el("Response", children))
        if not out:
            self._protocol_error(ctx, "GetItemEstimate sans Collection")
            return el("GetItemEstimate:GetItemEstimate", [el("Response", [el("Status", "2")])])
        return el("GetItemEstimate:GetItemEstimate", out)

    # ── ItemOperations ────────────────────────────────────────────────────

    def _cmd_itemoperations(self, ctx):
        user, dev = ctx.user, ctx.device
        answers = []
        for op in ctx.doc.children:
            if op.tag == "Fetch":
                store = op.text("Store")
                cid, sid = op.text("AirSync:CollectionId"), op.text("AirSync:ServerId")
                folder = user.folders.get(cid) if cid else None
                item = folder.items.get(sid) if folder is not None and sid else None
                self._action(ctx, "item_fetch", collection_id=cid, server_id=sid)
                if store != "Mailbox":
                    answers.append(el("Fetch", [el("Status", "9")]))
                    continue
                if item is None:
                    answers.append(el("Fetch", [el("Status", "6"), el("AirSync:CollectionId", cid or ""),
                                                el("AirSync:ServerId", sid or "")]))
                    continue
                options = {"filter_type": 0, "body_prefs": [], "mime_support": 0}
                opts = op.child("Options")
                if opts is not None:
                    parsed, problem = self._parse_options(el("AirSync:Collection", [
                        el("AirSync:Options", [c for c in opts.children if c.name != "ItemOperations:Schema"
                                               and c.name != "ItemOperations:Range"])]), folder)
                    if problem:
                        self._protocol_error(ctx, problem)
                        answers.append(el("Fetch", [el("Status", "2")]))
                        continue
                    options = parsed or options
                answers.append(el("Fetch", [el("Status", "1"), el("AirSync:CollectionId", cid),
                                            el("AirSync:ServerId", sid), el("AirSync:Class", item.cls),
                                            el("Properties", self._application_data(item, options,
                                                                                    version=ctx.version))]))
            elif op.tag == "EmptyFolderContents":
                cid = op.text("AirSync:CollectionId")
                folder = user.folders.get(cid) if cid else None
                subfolders = op.has("Options", "DeleteSubFolders")
                entry = self._action(ctx, "empty_folder", collection_id=cid, delete_subfolders=subfolders,
                                     status=None)
                if folder is None:
                    entry["status"] = "6"
                    answers.append(el("EmptyFolderContents", [el("Status", "6"), el("AirSync:CollectionId",
                                                                                    cid or "")]))
                    continue
                folder.items.clear()
                if subfolders:
                    for fid in self._descendants(user, cid):
                        user.folders.pop(fid, None)
                entry["status"] = "1"
                answers.append(el("EmptyFolderContents", [el("Status", "1"), el("AirSync:CollectionId", cid)]))
            else:
                self._protocol_error(ctx, f"ItemOperations : {op.tag} non pris en charge")
                return el("ItemOperations:ItemOperations", [el("Status", "2")])
        return el("ItemOperations:ItemOperations", [el("Status", "1"), el("Response", answers)])

    # ── Settings ──────────────────────────────────────────────────────────

    def _cmd_settings(self, ctx):
        user, dev = ctx.user, ctx.device
        out = [el("Status", "1")]
        asked = []
        for part in ctx.doc.children:
            asked.append(part.tag)
            if part.tag == "UserInformation":
                if not part.has("Get"):
                    self._protocol_error(ctx, "UserInformation sans Get")
                    out.append(el("UserInformation", [el("Status", "2")]))
                    continue
                addresses = el("EmailAddresses", [el("SMTPAddress", user.email)]
                               + ([el("PrimarySmtpAddress", user.email)] if ctx.version == "14.1" else []))
                if ctx.version == "14.1":
                    got = el("Get", [el("Accounts", [el("Account", [
                        el("UserDisplayName", user.display_name), addresses])])])
                else:
                    got = el("Get", [addresses])
                out.append(el("UserInformation", [el("Status", "1"), got]))
            elif part.tag == "DeviceInformation":
                settings = part.child("Set")
                if settings is None:
                    self._protocol_error(ctx, "DeviceInformation sans Set")
                    out.append(el("DeviceInformation", [el("Status", "2")]))
                    continue
                dev.info = {c.tag: c.text() for c in settings.children}
                out.append(el("DeviceInformation", [el("Status", "1")]))
            elif part.tag == "Oof":
                if part.has("Get"):
                    out.append(el("Oof", [el("Status", "1"), el("Get", [el("OofState", "0")])]))
                else:
                    out.append(el("Oof", [el("Status", "1")]))
            elif part.tag == "DevicePassword":
                out.append(el("DevicePassword", [el("Status", "1")]))
            elif part.tag == "RightsManagementInformation":
                out.append(el("RightsManagementInformation", [el("Status", "1")]))
            else:
                self._protocol_error(ctx, f"Settings : {part.tag} inattendu")
                return _status_doc("Settings", 2)
        self._action(ctx, "settings", asked=asked)
        return el("Settings:Settings", out)

    # ── SendMail ──────────────────────────────────────────────────────────

    def _cmd_sendmail(self, ctx):
        user, dev, doc = ctx.user, ctx.device, ctx.doc
        client_id = doc.text("ClientId")
        mime = doc.data("Mime")
        save = doc.has("SaveInSentItems")
        account = doc.text("AccountId")
        record = {"seq": self._next_seq(), "time": time.time(), "user": user.login, "device": dev.device_id,
                  "client_id": client_id, "mime": mime, "save_in_sent": save, "status": None, "recipients": [],
                  "delivered_to": [], "sent_copy": None, "mime_opaque": bool(doc.child("Mime") and
                                                                              doc.child("Mime").opaque)}
        self._sent.append(record)

        def fail(status, why):
            record["status"] = str(status)
            record["error"] = why
            self._action(ctx, "send_mail", client_id=client_id, status=str(status), error=why)
            return _status_doc("SendMail", status)

        if client_id is None or not _ITEM_ID.match(client_id):
            self._protocol_error(ctx, "SendMail sans ClientId")
            return fail(103, "ClientId absent")
        if not mime:
            self._protocol_error(ctx, "SendMail sans Mime")
            return fail(103, "Mime absent")
        if account is not None and account != user.email:
            return fail(166, "AccountId inconnu")
        if client_id in dev.client_ids:
            return fail(118, "ClientId déjà envoyé")
        if not _valid_mime(mime):
            return fail(107, "MIME invalide")
        summary = Summary(mime)
        recipients = summary.addresses("to", "cc", "bcc")
        record["recipients"] = recipients
        if not recipients:
            return fail(119, "aucun destinataire")
        dev.client_ids.add(client_id)
        stored = mime
        added = []
        if not summary.message_id:
            added.append(("Message-ID", email.utils.make_msgid(domain="mock-eas.test")))
        if not summary.date:
            added.append(("Date", email.utils.formatdate(usegmt=True)))
        if added:
            stored = _add_headers(stored, added)
        delivered = _remove_headers(stored, {"bcc"})
        for address in recipients:
            target = next((u for u in self._users.values() if u.email.lower() == address.lower()), None)
            if target is None or target.login in record["delivered_to"]:
                continue
            inbox = next((f for f in target.folders.values() if f.type == FolderType.INBOX), None)
            if inbox is None:
                continue
            item = Item(inbox.new_item_id(), mime=delivered)
            inbox.items[item.server_id] = item
            record["delivered_to"].append(target.login)
        if save:
            sent = next((f for f in user.folders.values() if f.type == FolderType.SENT), None)
            if sent is not None:
                item = Item(sent.new_item_id(), mime=stored, read=True)
                sent.items[item.server_id] = item
                record["sent_copy"] = item.server_id
        record["status"] = "1"
        record["from"] = summary.sender
        self._action(ctx, "send_mail", client_id=client_id, status="1", recipients=recipients,
                     delivered_to=list(record["delivered_to"]), save_in_sent=save)
        return None


def _main():
    """Run a server by hand: python3 -I mock_eas.py [port]."""
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    srv = MockEasServer(port=port).start()
    srv.add_user("alice@example.test", "alice-password", display_name="Alice Test")
    srv.add_user("bob@example.test", "bob-password", display_name="Bob Test")
    for n in range(3):
        srv.add_message("alice@example.test", FolderType.INBOX, subject=f"Message {n + 1}")
    print(f"Serveur ActiveSync de test : {srv.url}")
    print(f"Autorité de test : {srv.ca_cert_path}")
    print(f"Empreinte SHA-256 : {srv.ca_sha256_colon}")
    print("Comptes : alice@example.test / alice-password, bob@example.test / bob-password. Ctrl+C pour arrêter.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        srv.stop()


if __name__ == "__main__":
    _main()
