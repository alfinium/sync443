# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""Unit tests of the ActiveSync test server (mock_eas.py) and its WBXML codec.

    python3 -I tests/e2e/mail/test_mock_eas.py
    python3 -I -m unittest discover -s tests/e2e/mail -p "test_*.py"

The server is driven over real TLS by mini_client.py, as the extension
would drive it.
"""

import base64
import datetime
import hashlib
import re
import socket
import ssl
import sys
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
sys.dont_write_bytecode = True
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import wbxml  # noqa: E402
from mini_client import MAIL_OPTIONS, MiniEasClient, parse_sync  # noqa: E402
from mock_eas import FolderType, MockEasServer, make_mime  # noqa: E402
from wbxml import WbxmlError, el  # noqa: E402

ALICE = "alice@example.test"
BOB = "bob@example.test"
HEADER = bytes((0x03, 0x01, 0x6A, 0x00))


# ── WBXML ─────────────────────────────────────────────────────────────────


class WbxmlTests(unittest.TestCase):
    def test_codepages_identical_to_the_extension(self):
        src = (ROOT / "src" / "core" / "codepages.mjs").read_text(encoding="utf-8")
        body = src[src.index("const PAGES = ["):src.index("];\n\nconst nsByPage")]
        js = set()
        for m in re.finditer(r'\[(\d+), "(\w+)", \[(.*?)\]\],', body, re.S):
            for token, tag in re.findall(r'\[0x([0-9a-f]{2}), "(\w+)"\]', m.group(3)):
                js.add((int(m.group(1)), m.group(2), int(token, 16), tag))
        py = {(page, ns, token, tag) for page, ns, tags in wbxml.PAGES for token, tag in tags}
        self.assertGreater(len(js), 500)
        self.assertEqual(py, js)

    def test_every_tag_round_trips(self):
        for page, ns, tags in wbxml.PAGES:
            for token, tag in tags:
                doc = el(f"{ns}:{tag}", [el(f"{ns}:{tag}", "valeur é"), el(f"{ns}:{tag}", b"\x00\xff"),
                                         el(f"{ns}:{tag}")])
                self.assertEqual(wbxml.decode(wbxml.encode(doc)), doc, f"{ns}:{tag}")

    def test_known_encoding(self):
        doc = el("FolderHierarchy:FolderSync", [el("SyncKey", "0")])
        self.assertEqual(wbxml.encode(doc), HEADER + bytes.fromhex("0007565203300001 01"))

    def test_long_opaque_length(self):
        doc = el("ComposeMail:SendMail", [el("ClientId", "1"), el("Mime", bytes(range(256)) * 3)])
        data = wbxml.encode(doc)
        self.assertIn(bytes((0xC3, 0x86, 0x00)), data)  # 768 as a multi-byte integer
        self.assertEqual(wbxml.decode(data).data("Mime"), bytes(range(256)) * 3)

    def test_namespaces_and_reading(self):
        doc = el("AirSync:Sync", [el("Collections", [el("Collection", [
            el("SyncKey", "5"), el("Options", [el("AirSyncBase:BodyPreference", [el("Type", "4")]),
                                               el("MIMESupport", "2")])])])])
        back = wbxml.decode(wbxml.encode(doc))
        opts = back.find("Collections", "Collection", "Options")
        self.assertEqual(opts.child("AirSyncBase:BodyPreference").text("Type"), "4")
        self.assertEqual(opts.child("MIMESupport").ns, "AirSync")
        self.assertIsNone(back.find("Collections", "Nope"))
        self.assertIn("<AirSyncBase:Type>4</AirSyncBase:Type>", wbxml.to_xml(back))

    def test_decoder_refuses_malformed_input(self):
        cases = {
            "vide": b"",
            "en-tête court": b"\x03\x01\x6a",
            "version 1.2": bytes((0x02, 0x01, 0x6A, 0x00, 0x05)),
            "identifiant public": bytes((0x03, 0x00, 0x00, 0x6A, 0x00, 0x05)),
            "jeu de caractères": bytes((0x03, 0x01, 0x04, 0x00, 0x05)),
            "table des chaînes": bytes((0x03, 0x01, 0x6A, 0x01, 0x41, 0x05)),
            "page inconnue": HEADER + bytes((0x00, 0x03, 0x05)),
            "page 99": HEADER + bytes((0x00, 99, 0x05)),
            "jeton inconnu": HEADER + bytes((0x11,)),
            "attributs": HEADER + bytes((0x85, 0x01)),
            "ENTITY": HEADER + bytes((0x45, 0x02, 0x41, 0x01)),
            "LITERAL": HEADER + bytes((0x04, 0x00)),
            "STR_T": HEADER + bytes((0x45, 0x83, 0x00, 0x01)),
            "PI": HEADER + bytes((0x43,)),
            "EXT_0": HEADER + bytes((0x45, 0xC0, 0x01)),
            "élément non refermé": HEADER + bytes((0x45,)),
            "texte sans fin": HEADER + bytes((0x45, 0x03, 0x41)),
            "END orphelin": HEADER + bytes((0x05, 0x01)),
            "deux racines": HEADER + bytes((0x05, 0x05)),
            "données après la racine": HEADER + bytes((0x45, 0x01, 0x00, 0x00)),
            "texte et éléments": HEADER + bytes((0x45, 0x03, 0x41, 0x00, 0x0B, 0x01)),
            "éléments puis texte": HEADER + bytes((0x45, 0x0B, 0x03, 0x41, 0x00, 0x01)),
            "texte et opaque": HEADER + bytes((0x45, 0x03, 0x41, 0x00, 0xC3, 0x01, 0x42, 0x01)),
            "opaque tronqué": HEADER + bytes((0x45, 0xC3, 0x05, 0x41, 0x42)),
            "UTF-8 invalide": HEADER + bytes((0x45, 0x03, 0xFF, 0x00, 0x01)),
            "texte hors élément": HEADER + bytes((0x03, 0x41, 0x00)),
            "entier trop long": HEADER + bytes((0x45, 0xC3, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01)),
            "changement de page tronqué": HEADER + bytes((0x45, 0x00)),
            "trop profond": HEADER + bytes((0x56,)) * 70 + bytes((0x01,)) * 70,
            "pas de racine": HEADER,
        }
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(WbxmlError):
                wbxml.decode(data)

    def test_decoder_limits(self):
        doc = el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", "1")]) for _ in range(50)])])
        data = wbxml.encode(doc)
        with self.assertRaises(WbxmlError):
            wbxml.decode(data, max_nodes=20)
        with self.assertRaises(WbxmlError):
            wbxml.decode(data, max_bytes=10)

    def test_encoder_refuses(self):
        with self.assertRaises(WbxmlError):
            wbxml.encode(el("AirSync:Sync", [el("SyncKey", "a\x00b")]))
        with self.assertRaises(WbxmlError):
            wbxml.encode(el("AirSync:Nope"))
        with self.assertRaises(WbxmlError):
            wbxml.encode(el("Unknown:Sync"))
        with self.assertRaises(WbxmlError):
            el("AirSync:Sync", True)
        mixed = el("AirSync:Sync", "x")
        mixed.children.append(el("AirSync:SyncKey", "1"))
        with self.assertRaises(WbxmlError):
            wbxml.encode(mixed)
        with self.assertRaises(WbxmlError):
            wbxml.encode(el("SyncKey", "1"))  # no namespace at the root


# ── Server fixtures ───────────────────────────────────────────────────────


class ServerTestCase(unittest.TestCase):
    options = {}

    def setUp(self):
        self.srv = MockEasServer(**self.options).start()
        self.addCleanup(self.srv.stop)
        self.srv.add_user(ALICE, "alice-pw", display_name="Alice Test")
        self.srv.add_user(BOB, "bob-pw", display_name="Bob Test")
        self.inbox = self.srv.folder_id(ALICE, FolderType.INBOX)
        self.trash = self.srv.folder_id(ALICE, FolderType.DELETED)
        self.sent = self.srv.folder_id(ALICE, FolderType.SENT)
        self.c = MiniEasClient(self.srv, ALICE, "alice-pw")

    def tearDown(self):
        self.assertEqual(self.srv.internal_errors(), [])

    def ready(self, client=None):
        """Provisioned, hierarchy synchronised. -> hierarchy key"""
        c = client or self.c
        c.provision()
        fs = c.folder_sync("0")
        self.assertEqual(fs["status"], "1")
        return fs["key"]

    def prime(self, folder, client=None, options=MAIL_OPTIONS):
        """Sync key 0 for a collection. -> key"""
        r = (client or self.c).sync(folder, "0", options=options)
        self.assertEqual(r["status"], "1")
        self.assertEqual(r["commands"], [])
        return r["key"]

    def drain(self, folder, key, client=None, window=100):
        """Sync until MoreAvailable is gone. -> (key, [commands])"""
        out = []
        for _ in range(50):
            r = (client or self.c).sync(folder, key, window=window)
            if r["doc"] is None:
                return key, out
            self.assertEqual(r["status"], "1")
            key = r["key"]
            out += r["commands"]
            if not r["more"]:
                return key, out
        self.fail("MoreAvailable sans fin")


# ── HTTP, TLS, authentication ─────────────────────────────────────────────


class HttpTests(ServerTestCase):
    def test_tls_with_the_test_authority(self):
        pem = Path(self.srv.ca_cert_path).read_text(encoding="ascii")
        der = ssl.PEM_cert_to_DER_cert(pem)
        self.assertEqual(hashlib.sha256(der).hexdigest().upper(), self.srv.ca_sha256)
        self.assertRegex(self.srv.ca_sha256, r"^[0-9A-F]{64}$")
        self.assertEqual(self.srv.ca_sha256_colon.replace(":", ""), self.srv.ca_sha256)
        self.assertTrue(self.srv.origin.startswith("https://127.0.0.1:"))
        for host in ("127.0.0.1", "localhost"):
            resp = MiniEasClient(self.srv, ALICE, "alice-pw", host=host).options()
            self.assertEqual(resp.status, 200)
        bad = ssl.create_default_context()  # system roots only: the test authority is unknown
        with self.assertRaises(ssl.SSLError):
            self.c.ctx = bad
            self.c.options()

    def test_options(self):
        resp = self.c.options()
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.header("ms-asprotocolversions"), "12.1,14.0,14.1")
        self.assertIn("FolderSync", resp.header("ms-asprotocolcommands").split(","))
        self.assertEqual(resp.header("content-length"), "0")
        self.assertEqual(resp.body, b"")

    def test_authentication(self):
        resp = self.c.request("OPTIONS", auth=False)
        self.assertEqual(resp.status, 401)
        self.assertTrue(resp.header("www-authenticate").startswith("Basic"))
        self.assertEqual(self.c.request("OPTIONS", password="wrong").status, 401)
        resp, _ = MiniEasClient(self.srv, ALICE, "nope").command("FolderSync", el(
            "FolderHierarchy:FolderSync", [el("SyncKey", "0")]))
        self.assertEqual(resp.status, 401)
        refused = [r for r in self.srv.requests() if r.get("auth") == "refused"]
        self.assertEqual(len(refused), 2)
        self.assertNotIn("nope", repr(refused))  # the password is never logged

    def test_strict_requests(self):
        c = self.c
        fs = wbxml.encode(el("FolderHierarchy:FolderSync", [el("SyncKey", "0")]))
        version = ("MS-ASProtocolVersion", "14.1")
        ctype = ("Content-Type", "application/vnd.ms-sync.wbxml")
        q = c.query("FolderSync")
        self.assertEqual(c.request("POST", q.replace("&DeviceId=MiniClient1", ""), [version, ctype], fs).status, 400)
        self.assertEqual(c.request("POST", q, [ctype], fs).status, 400)  # no MS-ASProtocolVersion
        self.assertEqual(c.request("POST", q, [("MS-ASProtocolVersion", "2.5"), ctype], fs).status, 400)
        self.assertEqual(c.request("POST", q, [version, ("Content-Type", "text/plain")], fs).status, 400)
        self.assertEqual(c.request("POST", c.query("Bogus"), [version, ctype], fs).status, 501)
        self.assertEqual(c.request("POST", c.query("Search"), [version, ctype], fs).status, 501)
        self.assertEqual(c.request("POST", q.replace(ALICE.replace("@", "%40"), "bob"), [version, ctype], fs).status,
                         400)
        self.assertEqual(c.request("GET").status, 405)
        self.assertEqual(c.request("POST", q, [version, ctype], b"\x03\x01\x6a\x00\x45").status, 400)
        self.assertEqual(c.request("POST", c.query("Sync"), [version, ctype], fs).status, 400)  # wrong root
        self.assertEqual(c.request("POST", c.query("FolderSync"), [version]).status, 400)  # empty body
        raw = (f"POST /Microsoft-Server-ActiveSync?{q} HTTP/1.1\r\nHost: x\r\n"
               "Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n").encode()
        self.assertEqual(c.exchange(raw).status, 501)
        raw = f"POST /Microsoft-Server-ActiveSync?{q} HTTP/1.1\r\nHost: x\r\n\r\n".encode()
        self.assertEqual(c.exchange(raw).status, 411)
        raw = b"OPTIONS /other HTTP/1.1\r\nHost: x\r\n\r\n"
        self.assertEqual(c.exchange(raw).status, 404)
        raw = b"OPTIONS /Microsoft-Server-ActiveSync HTTP/1.0\r\nHost: x\r\n\r\n"
        self.assertEqual(c.exchange(raw).status, 505)
        raw = b"OPTIONS /Microsoft-Server-ActiveSync HTTP/1.1\nHost: x\n\n\r\n\r\n"
        self.assertEqual(c.exchange(raw).status, 400)
        self.assertTrue(self.srv.protocol_errors())

    def test_faults(self):
        self.srv.add_fault("OPTIONS", http_status=503, retry_after=7)
        resp = self.c.options()
        self.assertEqual((resp.status, resp.header("retry-after")), (503, "7"))
        self.assertEqual(self.c.options().status, 200)
        self.ready()
        self.srv.add_fault("FolderSync", status="129", times=None)
        for _ in range(2):
            self.assertEqual(self.c.folder_sync("0")["status"], "129")
        self.srv.clear_faults()
        self.assertEqual(self.c.folder_sync("0")["status"], "1")


# ── Provisioning ──────────────────────────────────────────────────────────


class ProvisionTests(ServerTestCase):
    def folder_sync_status(self, version=None):
        resp, doc = self.c.command("FolderSync", el("FolderHierarchy:FolderSync", [el("SyncKey", "0")]),
                                   version=version)
        return resp.status, doc.text("Status") if doc is not None else None

    def test_not_provisioned(self):
        self.assertEqual(self.folder_sync_status(), (200, "142"))
        self.assertEqual(self.folder_sync_status("12.1"), (449, None))
        self.c.policy_key = "12345"
        self.assertEqual(self.folder_sync_status(), (200, "142"))

    def test_two_step_provision_with_status_3(self):
        doc = self.c.provision(ack="3")
        self.assertEqual(doc.text("Status"), "1")
        self.assertIsNotNone(self.c.policy_key)
        acks = self.srv.provision_acks(ALICE, "MiniClient1")
        self.assertEqual(len(acks), 1)
        self.assertEqual(acks[0]["status"], "3")
        first = self.srv.actions("provision")[0]
        self.assertEqual(first["phase"], 1)
        self.assertEqual(first["device_info"]["Model"], "MiniEas")
        self.assertEqual(self.srv.device_state(ALICE, "MiniClient1")["ack_status"], "3")
        self.assertEqual(self.folder_sync_status(), (200, "1"))
        policy = self.srv.requests("Provision")[0]["response"]
        self.assertEqual(policy.find("Policies", "Policy", "Data", "EASProvisionDoc").text("DevicePasswordEnabled"),
                         "0")
        self.assertEqual(policy.child("Settings:DeviceInformation").text("Status"), "1")

    def test_outdated_or_wrong_key(self):
        self.c.provision()
        good = self.c.policy_key
        self.c.policy_key = str(int(good) % 4000000000 + 1)
        self.assertEqual(self.folder_sync_status(), (200, "144"))
        self.c.policy_key = good
        self.srv.refresh_policy()
        self.assertEqual(self.folder_sync_status(), (200, "143"))
        self.assertEqual(self.folder_sync_status("12.1"), (449, None))
        self.c.provision()
        self.assertEqual(self.folder_sync_status(), (200, "1"))

    def test_device_information_required_in_14_1(self):
        doc = self.c.provision(device_info=False)
        self.assertEqual(doc.text("Status"), "165")
        self.c.version = "14.0"
        self.assertEqual(self.c.provision(device_info=False).text("Status"), "1")

    def test_ack_with_wrong_key_and_refused_ack(self):
        resp, doc = self.c.command("Provision", el("Provision:Provision", [el("Policies", [el("Policy", [
            el("PolicyType", "MS-EAS-Provisioning-WBXML"), el("PolicyKey", "42"), el("Status", "1")])])]),
            policy_key="42")
        self.assertEqual(doc.text("Policies", "Policy", "Status"), "5")
        self.srv.options.accepted_ack_statuses = ("1",)
        self.assertEqual(self.c.provision(ack="3").text("Status"), "139")
        self.assertIsNone(self.c.policy_key)
        self.assertEqual(self.c.provision(ack="1").text("Status"), "1")

    def test_remote_wipe(self):
        self.ready()
        self.srv.set_remote_wipe(ALICE, "MiniClient1")
        self.assertEqual(self.folder_sync_status(), (200, "140"))
        self.assertEqual(self.folder_sync_status("12.1"), (449, None))
        doc = self.c.provision()
        self.assertTrue(doc.has("RemoteWipe"))
        self.assertFalse(doc.has("Policies"))
        state = self.srv.device_state(ALICE, "MiniClient1")
        self.assertEqual((state["wipe"], state["wipe_notified"], state["wipe_ack"]), ("device", 1, None))
        # Another device of the same user is not concerned.
        other = MiniEasClient(self.srv, ALICE, "alice-pw", device_id="Other1")
        self.ready(other)
        # A client that obeys acknowledges; ours never does, but the server records it.
        _, doc = self.c.command("Provision", el("Provision:Provision", [el("RemoteWipe", [el("Status", "1")])]),
                                policy_key="0")
        self.assertEqual(doc.text("Status"), "1")
        self.assertEqual(self.srv.actions("wipe_ack")[0]["status"], "1")
        self.srv.set_remote_wipe(ALICE, "MiniClient1", on=False)
        self.ready()

    def test_no_policy(self):
        self.srv.options.policy = None
        doc = self.c.provision()
        self.assertEqual(doc.text("Policies", "Policy", "Status"), "2")
        self.assertIsNone(self.c.policy_key)
        self.assertEqual(self.folder_sync_status(), (200, "1"))


# ── Folders ───────────────────────────────────────────────────────────────


class FolderTests(ServerTestCase):
    def test_initial_and_incremental_folder_sync(self):
        self.c.provision()
        fs = self.c.folder_sync("0")
        types = {name: t for op, _, parent, name, t in fs["changes"] if op == "Add" and parent == "0"}
        self.assertEqual(types["Inbox"], 2)
        self.assertEqual(types["Calendar"], 8)
        self.assertEqual(types["Contacts"], 9)
        self.assertEqual(types["Tasks"], 7)
        self.assertEqual(fs["doc"].text("Changes", "Count"), str(len(fs["changes"])))
        key = fs["key"]
        again = self.c.folder_sync(key)
        self.assertEqual((again["status"], again["key"], again["changes"]), ("1", key, []))
        projects = self.srv.add_folder(ALICE, "Projets", parent=self.inbox)
        sub = self.srv.add_folder(ALICE, "2026", parent=projects)
        cal = self.srv.add_folder(ALICE, "Anniversaires", type_=FolderType.USER_CALENDAR)
        fs = self.c.folder_sync(key)
        # Parents before children (by depth).
        self.assertEqual(fs["changes"], [("Add", cal, "0", "Anniversaires", 13),
                                         ("Add", projects, self.inbox, "Projets", 12),
                                         ("Add", sub, projects, "2026", 12)])
        self.srv.rename_folder(ALICE, projects, "Projets 2026", parent="0")
        self.srv.delete_folder(ALICE, cal)
        fs2 = self.c.folder_sync(fs["key"])
        self.assertEqual(fs2["changes"], [("Update", projects, "0", "Projets 2026", 12), ("Delete", cal, None,
                                                                                           None, None)])
        # The previous key is still accepted once (lost response), an unknown one is not.
        self.assertEqual(self.c.folder_sync(fs["key"])["changes"], fs2["changes"])
        self.assertEqual(self.c.folder_sync("999")["status"], "9")
        self.assertEqual(self.c.folder_sync(fs2["key"])["status"], "9")  # state was reset
        self.assertEqual(self.c.folder_sync("0")["status"], "1")

    def test_folder_create_update_delete(self):
        key = self.ready()

        def op(cmd, *children):
            _, doc = self.c.command(cmd, el(f"FolderHierarchy:{cmd}", list(children)))
            return doc

        doc = op("FolderCreate", el("SyncKey", key), el("ParentId", self.inbox), el("DisplayName", "Clients"),
                 el("Type", "12"))
        self.assertEqual(doc.text("Status"), "1")
        new_id, key = doc.text("ServerId"), doc.text("SyncKey")
        self.assertEqual(self.srv.folder_id(ALICE, "Inbox/Clients"), new_id)
        self.assertEqual(self.c.folder_sync(key)["changes"], [])  # its own change is not echoed
        self.assertEqual(op("FolderCreate", el("SyncKey", key), el("ParentId", self.inbox),
                            el("DisplayName", "clients"), el("Type", "12")).text("Status"), "2")
        self.assertEqual(op("FolderCreate", el("SyncKey", key), el("ParentId", "999"), el("DisplayName", "X"),
                            el("Type", "12")).text("Status"), "5")
        self.assertEqual(op("FolderCreate", el("SyncKey", "1"), el("ParentId", "0"), el("DisplayName", "X"),
                            el("Type", "12")).text("Status"), "9")
        self.assertEqual(op("FolderCreate", el("SyncKey", key), el("ParentId", "0"), el("DisplayName", "X"),
                            el("Type", "2")).text("Status"), "10")
        doc = op("FolderUpdate", el("SyncKey", key), el("ServerId", new_id), el("ParentId", "0"),
                 el("DisplayName", "Clients 2026"))
        self.assertEqual(doc.text("Status"), "1")
        key = doc.text("SyncKey")
        self.assertEqual(self.srv.folder_id(ALICE, "Clients 2026"), new_id)
        self.assertEqual(op("FolderUpdate", el("SyncKey", key), el("ServerId", self.inbox), el("ParentId", "0"),
                            el("DisplayName", "Boîte")).text("Status"), "3")
        self.assertEqual(op("FolderUpdate", el("SyncKey", key), el("ServerId", "999"), el("ParentId", "0"),
                            el("DisplayName", "Y")).text("Status"), "4")
        self.assertEqual(op("FolderUpdate", el("SyncKey", key), el("ServerId", new_id), el("ParentId", new_id),
                            el("DisplayName", "Y")).text("Status"), "5")
        self.srv.add_message(ALICE, new_id, subject="dans le dossier")
        self.assertEqual(op("FolderDelete", el("SyncKey", key), el("ServerId", self.trash)).text("Status"), "3")
        self.assertEqual(op("FolderDelete", el("SyncKey", key), el("ServerId", "999")).text("Status"), "4")
        doc = op("FolderDelete", el("SyncKey", key), el("ServerId", new_id))
        self.assertEqual(doc.text("Status"), "1")
        self.assertNotIn(new_id, [f["server_id"] for f in self.srv.folders(ALICE)])
        self.assertEqual(self.c.folder_sync(doc.text("SyncKey"))["changes"], [])
        kinds = [(a["kind"], a["status"]) for a in self.srv.actions() if a["kind"].startswith("folder_")]
        self.assertEqual(kinds[0], ("folder_create", "1"))
        self.assertEqual(kinds[-1], ("folder_delete", "1"))

    def test_foldersync_zero_resets_sync_states(self):
        self.ready()
        key = self.prime(self.inbox)
        self.c.folder_sync("0")
        r = self.c.sync(self.inbox, key)
        self.assertEqual((r["status"], r["key"]), ("3", "0"))


# ── Sync ──────────────────────────────────────────────────────────────────


class SyncTests(ServerTestCase):
    def test_initial_sync_window_and_more_available(self):
        ids = [self.srv.add_message(ALICE, self.inbox, subject=f"Message {n}",
                                    date=datetime.datetime(2026, 11, 1 + n, tzinfo=datetime.timezone.utc))
               for n in range(5)]
        self.ready()
        key = self.prime(self.inbox)
        r = self.c.sync(self.inbox, key, window=2)
        self.assertEqual([op for op, _, _ in r["commands"]], ["Add", "Add"])
        self.assertEqual([sid for _, sid, _ in r["commands"]], [ids[4], ids[3]])  # newest first
        self.assertTrue(r["more"])
        key, rest = self.drain(self.inbox, r["key"], window=2)
        self.assertEqual([sid for _, sid, _ in rest], [ids[2], ids[1], ids[0]])
        data = r["commands"][0][2]
        self.assertEqual(data.text("Email:Subject"), "Message 4")
        self.assertEqual(data.text("Email:Read"), "0")
        self.assertEqual(data.text("Email:DateReceived"), "2026-11-05T00:00:00.000Z")
        self.assertEqual(data.text("AirSyncBase:Body", "Type"), "4")
        mime = self.srv.message(ALICE, self.inbox, ids[4])["mime"]
        self.assertEqual(data.data("AirSyncBase:Body", "Data"), mime)
        self.assertEqual(data.text("AirSyncBase:Body", "EstimatedDataSize"), str(len(mime)))
        # Nothing new: an empty response, and the key does not move.
        resp, doc = self.c.command("Sync", el("AirSync:Sync", [el("Collections", [el("Collection", [
            el("SyncKey", key), el("CollectionId", self.inbox)])])]))
        self.assertEqual((resp.status, resp.body, doc), (200, b"", None))
        state = self.srv.device_state(ALICE, "MiniClient1")["collections"][self.inbox]
        self.assertEqual(state["key"], key)
        self.assertEqual(sorted(state["known"]), sorted(ids))

    def test_server_side_changes(self):
        a = self.srv.add_message(ALICE, self.inbox, subject="A")
        b = self.srv.add_message(ALICE, self.inbox, subject="B")
        d = self.srv.add_message(ALICE, self.inbox, subject="D")
        self.ready()
        key, _ = self.drain(self.inbox, self.prime(self.inbox))
        self.srv.set_read(ALICE, self.inbox, a)
        self.srv.set_flag(ALICE, self.inbox, b)
        self.srv.delete_message(ALICE, self.inbox, d)
        new = self.srv.add_message(ALICE, self.inbox, subject="Nouveau")
        key, cmds = self.drain(self.inbox, key)
        by_op = {(op, sid): data for op, sid, data in cmds}
        self.assertEqual(sorted(by_op), sorted([("Change", a), ("Change", b), ("Delete", d), ("Add", new)]))
        self.assertEqual(by_op[("Change", a)].text("Email:Read"), "1")
        self.assertEqual(by_op[("Change", b)].text("Email:Flag", "Email:Status"), "2")
        self.assertIsNone(by_op[("Change", a)].child("Email:Subject"))  # a Change carries what may change
        self.srv.set_flag(ALICE, self.inbox, b, False)
        self.srv.set_read(ALICE, self.inbox, a, True)  # already read: no Change
        key, cmds = self.drain(self.inbox, key)
        self.assertEqual([(op, sid) for op, sid, _ in cmds], [("Change", b)])
        self.assertEqual(cmds[0][2].child("Email:Flag").children, [])
        moved = self.srv.move_message(ALICE, self.inbox, a, self.trash)
        key, cmds = self.drain(self.inbox, key)
        self.assertEqual([(op, sid) for op, sid, _ in cmds], [("Delete", a)])
        tkey, tcmds = self.drain(self.trash, self.prime(self.trash))
        self.assertEqual([(op, sid) for op, sid, _ in tcmds], [("Add", moved)])
        gone = self.srv.mass_delete(ALICE, self.inbox)
        key, cmds = self.drain(self.inbox, key)
        self.assertEqual(sorted(sid for op, sid, _ in cmds if op == "Delete"), sorted(gone))

    def test_client_change_read_and_flag(self):
        a = self.srv.add_message(ALICE, self.inbox, subject="A")
        self.ready()
        key, _ = self.drain(self.inbox, self.prime(self.inbox))
        r = self.c.sync(self.inbox, key, commands=[el("Change", [el("ServerId", a), el("ApplicationData", [
            el("Email:Read", "1"), el("Email:Flag", [el("Email:Status", "2"), el("Email:FlagType", "Flag for follow up")])])])])
        self.assertEqual((r["status"], r["commands"], r["responses"]), ("1", [], []))
        self.assertNotEqual(r["key"], key)
        msg = self.srv.message(ALICE, self.inbox, a)
        self.assertTrue(msg["read"] and msg["flagged"])
        act = self.srv.actions("sync_change")[0]
        self.assertEqual((act["server_id"], act["changes"], act["status"]), (a, {"read": True, "flag": 2}, "1"))
        key, cmds = self.drain(self.inbox, r["key"])
        self.assertEqual(cmds, [])  # no echo of the device's own change
        r = self.c.sync(self.inbox, key, commands=[el("Change", [el("ServerId", "1:999"), el("ApplicationData", [
            el("Email:Read", "1")])])])
        self.assertEqual([(op, sid, st) for op, sid, st, _ in r["responses"]], [("Change", "1:999", "8")])
        r = self.c.sync(self.inbox, r["key"], commands=[el("Change", [el("ServerId", a), el("ApplicationData", [
            el("Email:Read", "yes")])])])
        self.assertEqual(r["responses"][0][2], "6")

    def test_conflict_returns_server_state(self):
        a = self.srv.add_message(ALICE, self.inbox, subject="A")
        self.ready()
        key, _ = self.drain(self.inbox, self.prime(self.inbox))
        self.srv.set_flag(ALICE, self.inbox, a)
        r = self.c.sync(self.inbox, key, commands=[el("Change", [el("ServerId", a), el("ApplicationData", [
            el("Email:Read", "1")])])])
        self.assertEqual([(op, sid) for op, sid, _ in r["commands"]], [("Change", a)])
        data = r["commands"][0][2]
        self.assertEqual((data.text("Email:Read"), data.text("Email:Flag", "Email:Status")), ("1", "2"))

    def test_client_delete(self):
        a = self.srv.add_message(ALICE, self.inbox, subject="A")
        b = self.srv.add_message(ALICE, self.inbox, subject="B")
        self.ready()
        key, _ = self.drain(self.inbox, self.prime(self.inbox))
        tkey, _ = self.drain(self.trash, self.prime(self.trash))
        r = self.c.sync(self.inbox, key, deletes_as_moves=True, commands=[el("Delete", [el("ServerId", a)])])
        self.assertEqual((r["status"], r["commands"]), ("1", []))
        self.assertIsNone(self.srv.message(ALICE, self.inbox, a))
        in_trash = self.srv.find_messages(ALICE, subject="A", folder=self.trash)
        self.assertEqual(len(in_trash), 1)
        self.assertEqual(self.srv.actions("sync_delete")[0]["moved_to"], (self.trash, in_trash[0]["server_id"]))
        tkey, cmds = self.drain(self.trash, tkey)
        self.assertEqual([(op, sid) for op, sid, _ in cmds], [("Add", in_trash[0]["server_id"])])
        # From the trash, or without DeletesAsMoves, the item is gone for good.
        r2 = self.c.sync(self.trash, tkey, commands=[el("Delete", [el("ServerId", in_trash[0]["server_id"])])])
        self.assertEqual(r2["status"], "1")
        r = self.c.sync(self.inbox, r["key"], deletes_as_moves=False, commands=[el("Delete", [el("ServerId", b)])])
        self.assertEqual(self.srv.messages(ALICE, self.trash), [])
        self.assertEqual(self.srv.messages(ALICE, self.inbox), [])
        r = self.c.sync(self.inbox, r["key"], commands=[el("Delete", [el("ServerId", b)])])
        self.assertEqual(self.srv.actions("sync_delete")[-1]["status"], "8")

    def test_bad_key_status_3_and_previous_key(self):
        self.srv.add_message(ALICE, self.inbox, subject="A")
        self.ready()
        key0 = self.prime(self.inbox)
        r1 = self.c.sync(self.inbox, key0)
        self.assertEqual(len(r1["commands"]), 1)
        # The response was lost: the client sends key0 again and gets the same item.
        r1b = self.c.sync(self.inbox, key0)
        self.assertEqual([sid for _, sid, _ in r1b["commands"]], [sid for _, sid, _ in r1["commands"]])
        self.assertEqual(r1b["key"], r1["key"])
        r = self.c.sync(self.inbox, "{bogus}7")
        self.assertEqual((r["status"], r["key"]), ("3", "0"))
        self.assertNotIn(self.inbox, self.srv.device_state(ALICE, "MiniClient1")["collections"])
        r = self.c.sync(self.inbox, r1b["key"])
        self.assertEqual(r["status"], "3")
        self.srv.invalidate_sync_state(ALICE, "MiniClient1", self.inbox)
        key = self.prime(self.inbox)
        self.assertEqual(len(self.drain(self.inbox, key)[1]), 1)

    def test_status_12_and_protocol_errors(self):
        key = self.ready()
        self.assertEqual(self.c.sync("999", "0")["status"], "12")
        late = self.srv.add_folder(ALICE, "Arrivé après")
        self.assertEqual(self.c.sync(late, "0")["status"], "12")  # not in the device's hierarchy yet
        self.c.folder_sync(key)
        self.assertEqual(self.c.sync(late, "0")["status"], "1")
        r = self.c.sync(self.inbox, "0", commands=[el("Delete", [el("ServerId", "1:1")])])
        self.assertEqual(r["status"], "4")
        self.assertEqual(self.c.sync(self.inbox, "0", window=0)["status"], "4")
        bad = [el("AirSync:FilterType", "7")]
        self.assertEqual(self.c.sync(self.inbox, "0", options=bad)["status"], "4")
        self.srv.delete_folder(ALICE, late)
        self.assertEqual(self.c.sync(late, "0")["status"], "12")

    def test_filter_type_soft_delete(self):
        a = self.srv.add_message(ALICE, self.inbox, subject="Récent")
        old = self.srv.add_message(ALICE, self.inbox, subject="Ancien",
                                   date=datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=10))
        self.ready()
        opts = [el("AirSync:FilterType", "3"), el("AirSyncBase:BodyPreference", [el("Type", "4")]),
                el("AirSync:MIMESupport", "2")]
        key, cmds = self.drain(self.inbox, self.prime(self.inbox, options=opts))
        self.assertEqual([sid for _, sid, _ in cmds], [a])
        self.assertNotIn(old, [sid for _, sid, _ in cmds])
        self.srv.set_message_date(ALICE, self.inbox, a, datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc))
        key, cmds = self.drain(self.inbox, key)
        self.assertEqual([(op, sid) for op, sid, _ in cmds], [("SoftDelete", a)])

    def test_filter_type_change(self):
        old = self.srv.add_message(ALICE, self.inbox, subject="Ancien",
                                   date=datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=60))
        recent = self.srv.add_message(ALICE, self.inbox, subject="Récent")
        self.ready()
        rest = [el("AirSyncBase:BodyPreference", [el("Type", "4")]), el("AirSync:MIMESupport", "2")]
        month, everything = [el("AirSync:FilterType", "5")] + rest, [el("AirSync:FilterType", "0")] + rest
        key, cmds = self.drain(self.inbox, self.prime(self.inbox, options=month))
        self.assertEqual([sid for _, sid, _ in cmds], [recent])
        # By default the wider period applies to the same key: the older item comes as an Add.
        r = self.c.sync(self.inbox, key, options=everything)
        self.assertEqual((r["status"], [(op, sid) for op, sid, _ in r["commands"]]), ("1", [("Add", old)]))
        # Narrower again: SoftDelete. Then a server that starts over when the period changes.
        r = self.c.sync(self.inbox, r["key"], options=month)
        self.assertEqual((r["status"], [(op, sid) for op, sid, _ in r["commands"]]), ("1", [("SoftDelete", old)]))
        self.srv.set_option("status3_on_filter_change", True)
        self.assertIsNone(self.c.sync(self.inbox, r["key"], options=month)["doc"])  # same period: nothing new, no reset
        self.assertEqual(self.c.sync(self.inbox, r["key"], options=everything)["status"], "3")
        key, cmds = self.drain(self.inbox, self.prime(self.inbox, options=everything))
        self.assertEqual(sorted(sid for _, sid, _ in cmds), sorted([old, recent]))
        with self.assertRaises(ValueError):
            self.srv.set_option("inconnue", True)

    def test_body_preferences(self):
        mime = make_mime("Corps", "x@example.test", ALICE, "Texte brut é\r\n" * 50, html_body="<p>Riche</p>")
        a = self.srv.add_message(ALICE, self.inbox, mime)
        self.ready()
        trunc = [el("AirSyncBase:BodyPreference", [el("Type", "4"), el("TruncationSize", "100")]),
                 el("AirSync:MIMESupport", "2")]
        key, cmds = self.drain(self.inbox, self.prime(self.inbox, options=trunc))
        body = cmds[0][2].child("AirSyncBase:Body")
        self.assertEqual((body.text("Type"), body.text("Truncated"), len(body.data("Data"))), ("4", "1", 100))
        self.assertEqual(cmds[0][2].text("AirSyncBase:NativeBodyType"), "2")
        # Type 4 without MIMESupport 2: plain text instead.
        plain = [el("AirSyncBase:BodyPreference", [el("Type", "4")])]
        r = self.c.sync(self.inbox, key, options=plain, commands=[el("Fetch", [el("ServerId", a)])])
        fetched = r["responses"][0][3].child("ApplicationData")
        self.assertEqual(fetched.text("AirSyncBase:Body", "Type"), "1")
        self.assertIn("Texte brut é", fetched.text("AirSyncBase:Body", "Data"))
        resp, doc = self.c.command("ItemOperations", el("ItemOperations:ItemOperations", [el("Fetch", [
            el("Store", "Mailbox"), el("AirSync:CollectionId", self.inbox), el("AirSync:ServerId", a),
            el("Options", [el("AirSync:MIMESupport", "2"), el("AirSyncBase:BodyPreference", [el("Type", "4")])])])]))
        fetch = doc.find("Response", "Fetch")
        self.assertEqual(fetch.text("Status"), "1")
        self.assertEqual(fetch.find("Properties", "AirSyncBase:Body").data("Data"), mime)

    def test_empty_request_reuses_the_last_one(self):
        self.ready()
        resp, doc = self.c.command("Sync", None)
        self.assertEqual(doc.text("Status"), "13")
        key = self.prime(self.inbox)
        key, _ = self.drain(self.inbox, key)
        a = self.srv.add_message(ALICE, self.inbox, subject="A")
        resp, doc = self.c.command("Sync", None)
        r = parse_sync(doc)
        self.assertEqual([(op, sid) for op, sid, _ in r["commands"]], [("Add", a)])
        self.assertEqual(self.srv.device_state(ALICE, "MiniClient1")["collections"][self.inbox]["key"], r["key"])

    def test_wait_and_get_item_estimate(self):
        self.srv.options.heartbeat_scale = 0.02
        self.ready()
        key, _ = self.drain(self.inbox, self.prime(self.inbox))
        resp, doc = self.c.command("GetItemEstimate", el("GetItemEstimate:GetItemEstimate", [el("Collections", [
            el("Collection", [el("AirSync:SyncKey", key), el("CollectionId", self.inbox)])])]))
        self.assertEqual(doc.find("Response", "Collection").text("Estimate"), "0")
        self.srv.add_message(ALICE, self.inbox, subject="A")
        _, doc = self.c.command("GetItemEstimate", el("GetItemEstimate:GetItemEstimate", [el("Collections", [
            el("Collection", [el("AirSync:SyncKey", key), el("CollectionId", self.inbox)])])]))
        self.assertEqual(doc.find("Response", "Collection").text("Estimate"), "1")
        key, _ = self.drain(self.inbox, key)
        r = self.c.sync(self.inbox, key, top=[el("AirSync:Wait", "100")])
        self.assertEqual((r["status"], r["doc"].find("Limit").text()), ("14", "59"))
        threading.Timer(0.3, lambda: self.srv.add_message(ALICE, self.inbox, subject="B")).start()
        started = time.monotonic()
        r = self.c.sync(self.inbox, key, top=[el("AirSync:HeartbeatInterval", "120")])
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertEqual([op for op, _, _ in r["commands"]], ["Add"])


# ── MoveItems ─────────────────────────────────────────────────────────────


class MoveTests(ServerTestCase):
    def move(self, sid, src, dst):
        _, doc = self.c.command("MoveItems", el("Move:MoveItems", [el("Move", [
            el("SrcMsgId", sid), el("SrcFldId", src), el("DstFldId", dst)])]))
        r = doc.child("Response")
        return r.text("Status"), r.text("DstMsgId")

    def test_move_items(self):
        a = self.srv.add_message(ALICE, self.inbox, subject="A")
        archive = self.srv.add_folder(ALICE, "Archives")
        self.ready()
        key, _ = self.drain(self.inbox, self.prime(self.inbox))
        akey, _ = self.drain(archive, self.prime(archive))
        status, dst = self.move(a, self.inbox, archive)
        self.assertEqual(status, "3")
        self.assertTrue(dst.startswith(archive + ":"))
        self.assertEqual(self.srv.message(ALICE, archive, dst)["subject"], "A")
        self.assertEqual(self.drain(self.inbox, key)[1], [])  # the source knows
        self.assertEqual([(op, sid) for op, sid, _ in self.drain(archive, akey)[1]], [("Add", dst)])
        self.assertEqual(self.move(a, self.inbox, archive), ("1", None))
        self.assertEqual(self.move(dst, archive, "999"), ("2", None))
        self.assertEqual(self.move(dst, archive, self.srv.folder_id(ALICE, FolderType.CALENDAR)), ("2", None))
        self.assertEqual(self.move(dst, archive, archive), ("4", None))
        acts = self.srv.actions("move")
        self.assertEqual([x["status"] for x in acts], ["3", "1", "2", "2", "4"])
        self.assertEqual(acts[0]["dst_msg_id"], dst)


class MoveWithoutEchoTests(ServerTestCase):
    options = {"move_adds_to_destination": False}

    def test_destination_knows_the_moved_item(self):
        a = self.srv.add_message(ALICE, self.inbox, subject="A")
        self.ready()
        self.drain(self.inbox, self.prime(self.inbox))
        tkey = self.prime(self.trash)
        _, doc = self.c.command("MoveItems", el("Move:MoveItems", [el("Move", [
            el("SrcMsgId", a), el("SrcFldId", self.inbox), el("DstFldId", self.trash)])]))
        self.assertEqual(doc.find("Response").text("Status"), "3")
        self.assertEqual(self.drain(self.trash, tkey)[1], [])


# ── Ping ──────────────────────────────────────────────────────────────────


class PingTests(ServerTestCase):
    options = {"heartbeat_scale": 0.02}  # 60 s -> 1.2 s

    def ping(self, heartbeat=60, folders=None, client=None):
        folders = folders if folders is not None else [(self.inbox, "Email")]
        body = el("Ping:Ping", [el("HeartbeatInterval", heartbeat), el("Folders", [
            el("Folder", [el("Id", fid), el("Class", cls)]) for fid, cls in folders])])
        _, doc = (client or self.c).command("Ping", body)
        return doc.text("Status"), [f.text() for f in doc.find("Folders").children] if doc.has("Folders") else [], doc

    def test_heartbeat_limits_and_missing_parameters(self):
        self.ready()
        status, _, doc = self.ping(59)
        self.assertEqual((status, doc.text("HeartbeatInterval")), ("5", "60"))
        status, _, doc = self.ping(3541)
        self.assertEqual((status, doc.text("HeartbeatInterval")), ("5", "3540"))
        _, doc = self.c.command("Ping", None)
        self.assertEqual(doc.text("Status"), "3")
        self.assertEqual(self.ping(folders=[("999", "Email")])[0], "7")
        self.assertEqual(self.ping(folders=[(self.inbox, "Calendar")])[0], "4")

    def test_timeout_and_cached_parameters(self):
        self.ready()
        self.drain(self.inbox, self.prime(self.inbox))
        started = time.monotonic()
        self.assertEqual(self.ping()[0], "1")
        self.assertGreaterEqual(time.monotonic() - started, 1.0)
        _, doc = self.c.command("Ping", None)  # same parameters as last time
        self.assertEqual(doc.text("Status"), "1")
        self.assertEqual(self.srv.device_state(ALICE, "MiniClient1")["last_ping"], (60, [(self.inbox, "Email")]))

    def test_wakes_on_new_mail(self):
        self.ready()
        key, _ = self.drain(self.inbox, self.prime(self.inbox))
        self.srv.options.heartbeat_scale = 1.0
        threading.Thread(target=lambda: (self.srv.wait_until(lambda: self.srv.pings_waiting(ALICE), 10),
                                         self.srv.add_message(ALICE, self.inbox, subject="Push"))).start()
        started = time.monotonic()
        status, folders, _ = self.ping(folders=[(self.inbox, "Email"), (self.sent, "Email")])
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual((status, folders), ("2", [self.inbox]))
        # Pending changes answer at once.
        self.assertEqual(self.ping()[:2], ("2", [self.inbox]))
        self.drain(self.inbox, key)
        self.assertEqual(self.srv.pings_waiting(), [])

    def test_wake_hook_and_hierarchy_change(self):
        self.ready()
        self.drain(self.inbox, self.prime(self.inbox))
        self.drain(self.sent, self.prime(self.sent))
        self.srv.options.heartbeat_scale = 1.0
        threading.Thread(target=lambda: (self.srv.wait_until(lambda: self.srv.pings_waiting(ALICE, "MiniClient1"), 10),
                                         self.srv.wake_ping(ALICE, "MiniClient1", [self.sent]))).start()
        status, folders, _ = self.ping(folders=[(self.inbox, "Email"), (self.sent, "Email")])
        self.assertEqual((status, folders), ("2", [self.sent]))
        self.assertEqual(self.srv.wake_ping(ALICE, "MiniClient1", remember=True), 0)
        self.assertEqual(self.ping()[:2], ("2", [self.inbox]))
        threading.Thread(target=lambda: (self.srv.wait_until(lambda: self.srv.pings_waiting(ALICE), 10),
                                         self.srv.add_folder(ALICE, "Nouveau"))).start()
        self.assertEqual(self.ping()[0], "7")

    def test_delivery_wakes_the_recipient(self):
        bob = MiniEasClient(self.srv, BOB, "bob-pw", device_id="BobPhone")
        self.ready(bob)
        bob_inbox = self.srv.folder_id(BOB, FolderType.INBOX)
        self.drain(bob_inbox, self.prime(bob_inbox, client=bob), client=bob)
        self.ready()
        self.srv.options.heartbeat_scale = 1.0
        result = {}
        t = threading.Thread(target=lambda: result.update(r=self.ping(folders=[(bob_inbox, "Email")], client=bob)))
        t.start()
        self.srv.wait_until(lambda: self.srv.pings_waiting(BOB), 10)
        _, doc = self.c.command("SendMail", el("ComposeMail:SendMail", [
            el("ClientId", "c1"), el("SaveInSentItems"), el("Mime", make_mime("Pour Bob", ALICE, BOB))]))
        t.join(10)
        self.assertEqual(result["r"][:2], ("2", [bob_inbox]))

    def test_client_leaving_ends_the_ping(self):
        self.ready()
        self.drain(self.inbox, self.prime(self.inbox))
        self.srv.options.heartbeat_scale = 1.0
        body = wbxml.encode(el("Ping:Ping", [el("HeartbeatInterval", "600"), el("Folders", [
            el("Folder", [el("Id", self.inbox), el("Class", "Email")])])]))
        tcp = socket.create_connection(("127.0.0.1", self.srv.port))
        tls = self.c.ctx.wrap_socket(tcp, server_hostname="127.0.0.1")
        head = (f"POST /Microsoft-Server-ActiveSync?{self.c.query('Ping')} HTTP/1.1\r\nHost: x\r\n"
                f"Authorization: Basic {base64.b64encode(b'alice@example.test:alice-pw').decode()}\r\n"
                f"MS-ASProtocolVersion: 14.1\r\nX-MS-PolicyKey: {self.c.policy_key}\r\n"
                f"Content-Type: application/vnd.ms-sync.wbxml\r\nContent-Length: {len(body)}\r\n\r\n").encode()
        tls.sendall(head + body)
        self.srv.wait_until(lambda: self.srv.pings_waiting(ALICE), 10)
        tls.close()
        self.srv.wait_until(lambda: not self.srv.pings_waiting(ALICE), 5)
        last = self.srv.requests("Ping")[-1]
        self.assertIsNone(last["http_status"])
        self.assertIn("client parti", last["error"])


# ── SendMail and Settings ─────────────────────────────────────────────────


class SendMailTests(ServerTestCase):
    def send(self, client_id, mime, save=True):
        children = [el("ClientId", client_id) if client_id else None, el("SaveInSentItems") if save else None,
                    el("Mime", mime) if mime is not None else None]
        resp, doc = self.c.command("SendMail", el("ComposeMail:SendMail", children))
        return resp, doc.text("Status") if doc is not None else None

    def test_delivery_and_sent_copy(self):
        self.ready()
        mime = make_mime("Réunion", f"Alice Test <{ALICE}>", [f"Bob <{BOB}>", "dehors@example.org"],
                         "Bonjour Bob.\r\n", bcc="cache@example.org")
        resp, status = self.send("msg-1", mime)
        self.assertEqual((resp.status, resp.body, status), (200, b"", None))
        sent = self.srv.sent_mails(ALICE)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["mime"], mime)
        self.assertEqual(sent[0]["status"], "1")
        self.assertTrue(sent[0]["mime_opaque"])
        self.assertEqual(sent[0]["delivered_to"], [BOB])
        self.assertEqual(sorted(sent[0]["recipients"]), sorted([BOB, "dehors@example.org", "cache@example.org"]))
        got = self.srv.find_messages(BOB, subject="Réunion")
        self.assertEqual(len(got), 1)
        self.assertNotIn(b"cache@example.org", got[0]["mime"])
        copy = self.srv.messages(ALICE, self.sent)
        self.assertEqual(len(copy), 1)
        self.assertTrue(copy[0]["read"])
        self.assertEqual(sent[0]["sent_copy"], copy[0]["server_id"])
        self.send("msg-2", make_mime("Sans copie", ALICE, BOB), save=False)
        self.assertEqual(len(self.srv.messages(ALICE, self.sent)), 1)

    def test_refusals(self):
        self.ready()
        mime = make_mime("X", ALICE, BOB)
        self.assertEqual(self.send(None, mime)[1], "103")
        self.assertEqual(self.send("m1", None)[1], "103")
        self.assertEqual(self.send("m1", mime)[1], None)
        self.assertEqual(self.send("m1", mime)[1], "118")
        self.assertEqual(self.send("m2", b"pas un message")[1], "107")
        self.assertEqual(self.send("m3", b"Subject: rien\r\n\r\ncorps")[1], "119")
        self.assertEqual([m["status"] for m in self.srv.sent_mails()], ["103", "103", "1", "118", "107", "119"])
        self.assertEqual(len(self.srv.find_messages(BOB, subject="X")), 1)


class SettingsTests(ServerTestCase):
    def test_user_information(self):
        self.ready()
        _, doc = self.c.command("Settings", el("Settings:Settings", [
            el("UserInformation", [el("Get")]),
            el("DeviceInformation", [el("Set", [el("Model", "Thunderbird"), el("UserAgent", "Sync443/1.0")])])]))
        self.assertEqual(doc.text("Status"), "1")
        account = doc.find("UserInformation", "Get", "Accounts", "Account")
        self.assertEqual(account.text("UserDisplayName"), "Alice Test")
        self.assertEqual(account.find("EmailAddresses").text("PrimarySmtpAddress"), ALICE)
        self.assertEqual(doc.find("DeviceInformation").text("Status"), "1")
        self.assertEqual(self.srv.device_state(ALICE, "MiniClient1")["info"]["Model"], "Thunderbird")
        _, doc = self.c.command("Settings", el("Settings:Settings", [el("UserInformation", [el("Get")])]),
                                version="14.0")
        self.assertEqual(doc.find("UserInformation", "Get", "EmailAddresses").text("SMTPAddress"), ALICE)


class ControlApiTests(ServerTestCase):
    def test_lookup_and_logs(self):
        self.assertEqual(self.srv.folder_id(ALICE, "Inbox"), self.inbox)
        self.assertEqual(self.srv.folder_id(ALICE, self.inbox), self.inbox)
        with self.assertRaises(KeyError):
            self.srv.folder_id(ALICE, "Nope")
        cal = self.srv.folder_id(ALICE, FolderType.CALENDAR)
        self.assertEqual(len(self.srv.messages(ALICE, cal)), 1)  # sample event the mail client must ignore
        sid = self.srv.add_message(ALICE, subject="Hello", message_id="<abc@example.test>")
        self.assertEqual(self.srv.find_messages(ALICE, message_id="abc@example.test")[0]["server_id"], sid)
        since = self.srv.last_seq()
        self.ready()
        reqs = self.srv.requests(since=since)
        self.assertEqual([r["cmd"] for r in reqs], ["Provision", "Provision", "FolderSync"])
        self.assertEqual(reqs[-1]["device_type"], "MiniTest")
        self.assertEqual(reqs[-1]["version"], "14.1")
        self.assertEqual(reqs[-1]["policy_key"], self.c.policy_key)
        self.assertEqual(self.srv.devices(ALICE), ["MiniClient1"])
        self.srv.reset_device(ALICE, "MiniClient1")
        self.assertIsNone(self.srv.device_state(ALICE, "MiniClient1")["hierarchy_key"])
        with self.assertRaises(TimeoutError):
            self.srv.wait_until(lambda: False, timeout=0.2)

    def test_collections_requested_and_transcript(self):
        naive = self.srv.add_message(ALICE, self.inbox, subject="Date sans fuseau",
                                     date=datetime.datetime(2026, 1, 2, 3, 4, 5))
        self.assertEqual(self.srv.message(ALICE, self.inbox, naive)["date"].tzinfo, datetime.timezone.utc)
        self.srv.options.heartbeat_scale = 0.01  # the Ping below times out after 0.6 s
        self.ready()
        since = self.srv.last_seq()
        self.drain(self.inbox, self.prime(self.inbox))
        self.c.command("Ping", el("Ping:Ping", [el("HeartbeatInterval", "60"), el("Folders", [
            el("Folder", [el("Id", self.sent), el("Class", "Email")])])]))
        self.assertEqual(self.srv.collections_requested(ALICE, since=since), {self.inbox, self.sent})
        text = self.srv.transcript(since=since)
        self.assertIn("Sync user=alice@example.test", text)
        self.assertIn("<AirSync:CollectionId>" + self.inbox, text)
        self.assertNotIn("alice-pw", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
