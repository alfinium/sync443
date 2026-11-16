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
import email
import email.message
import email.policy
import hashlib
import json
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
from mini_client import (MAIL_OPTIONS, PIM_OPTIONS, SUPPORTED_REQUIRED, MiniEasClient,  # noqa: E402
                         calendar_supported, compact, event_data, long_date, parse_sync, task_data)
from mock_eas import (FolderType, MockEasServer, global_obj_id, make_mime, make_timezone,  # noqa: E402
                      parse_timezone, uid_of_global_obj_id)
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


# ── Calendar and tasks ────────────────────────────────────────────────────

UTC = datetime.timezone.utc
PARIS = make_timezone(-60, {"name": "CET", "change": {"month": 10, "week": 5, "weekday": 0, "hour": 3}},
                      {"name": "CEST", "bias": -60, "change": {"month": 3, "week": 5, "weekday": 0, "hour": 2}})
COMPACT = r"^\d{8}T\d{6}Z$"


class PimTestCase(ServerTestCase):
    def setUp(self):
        super().setUp()
        self.cal = self.srv.folder_id(ALICE, FolderType.CALENDAR)
        self.todo = self.srv.folder_id(ALICE, FolderType.TASKS)
        self.now = datetime.datetime.now(UTC).replace(microsecond=0)
        self.start = (self.now + datetime.timedelta(days=7)).replace(hour=9, minute=0, second=0)
        self.end = self.start + datetime.timedelta(hours=1)

    def days(self, n, hours=0):
        return self.start + datetime.timedelta(days=n, hours=hours)

    def client(self, version="14.1", login=ALICE, password="alice-pw", device=None):
        c = MiniEasClient(self.srv, login, password, device_id=device or "Dev" + version.replace(".", ""),
                          version=version)
        self.ready(c)
        return c

    def open(self, folder, client=None, supported=None, options=PIM_OPTIONS):
        """First Sync (SyncKey 0), then everything the server has. -> (key, {ServerId: ApplicationData})"""
        c = client or self.c
        r = c.sync(folder, "0", supported=supported, options=options)
        self.assertEqual(r["status"], "1", r["doc"])
        key, cmds = self.drain(folder, r["key"], client=c)
        return key, {sid: data for op, sid, data in cmds if op == "Add"}

    def errors(self):
        return [e["message"] for e in self.srv.protocol_errors()]

    def state(self, client, folder):
        return self.srv.device_state(client.login, client.device_id)["collections"][folder]

    def refusals(self, client, folder, key, cases):
        """Each (name, ApplicationData, protocol violation?) is an Add the server answers with Status 6.
        A violation is also recorded as a protocol error; nothing is stored. -> the collection's key"""
        before = len(self.srv.messages(client.login, folder))
        for n, (name, data, violation) in enumerate(cases):
            with self.subTest(name):
                known = len(self.errors())
                sid, status, r = client.add_item(folder, key, data, client_id=f"bad{n}")
                key = r["key"]
                self.assertEqual((sid, status), (None, "6"))
                self.assertEqual(len(self.errors()) - known, 1 if violation else 0, self.errors()[known:])
                self.assertTrue(self.srv.actions("sync_add")[-1]["reason"])
        self.assertEqual(len(self.srv.messages(client.login, folder)), before)
        return key


class HelperTests(unittest.TestCase):
    def test_timezone_structure(self):
        self.assertEqual(len(PARIS), 172)
        self.assertEqual(make_timezone(), bytes(172))
        zone = parse_timezone(base64.b64encode(PARIS).decode("ascii"))
        self.assertEqual(zone["bias"], -60)
        self.assertEqual(zone["standard"], {"name": "CET", "bias": 0, "change": {
            "month": 10, "week": 5, "weekday": 0, "hour": 3, "minute": 0}})
        self.assertEqual(zone["daylight"]["bias"], -60)
        self.assertEqual(make_timezone(**zone), PARIS)
        self.assertEqual(PARIS[:4], (-60).to_bytes(4, "little", signed=True))
        self.assertEqual(PARIS[68:84], bytes((0, 0, 10, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 0, 0, 0)))  # SYSTEMTIME
        with self.assertRaises(ValueError):
            parse_timezone(bytes(171))
        with self.assertRaises(ValueError):
            make_timezone(0, {"name": "x" * 33})

    def test_global_obj_id(self):
        classid = bytes.fromhex("040000008200E00074C5B7101A82E008")
        raw = global_obj_id("réunion-1@example.test")
        uid = "réunion-1@example.test".encode("utf-8")
        self.assertEqual(raw, classid + bytes(20) + (len(uid) + 13).to_bytes(4, "little")
                         + b"vCal-Uid" + bytes((1, 0, 0, 0)) + uid + b"\x00")
        self.assertEqual(uid_of_global_obj_id(raw), "réunion-1@example.test")
        self.assertEqual(uid_of_global_obj_id(base64.b64encode(raw).decode("ascii")), "réunion-1@example.test")
        # The identifier of [MS-ASCMD] 4.16: an Outlook UID is the hexadecimal form of its GlobalObjId.
        outlook = ("040000008200E00074C5B7101A82E00800000000122CD5EB1DB7CA01000000000000000010000000"
                   "CA93B43442E5314A8AF02D7E133D17EF")
        self.assertEqual(base64.b64encode(global_obj_id(outlook)).decode("ascii"),
                         "BAAAAIIA4AB0xbcQGoLgCAAAAAASLNXrHbfKAQAAAAAAAAAAEAAAAMqTtDRC5TFKivAtfhM9F+8=")
        self.assertEqual(uid_of_global_obj_id(global_obj_id(outlook)), outlook)
        self.assertEqual(uid_of_global_obj_id(classid + bytes(24)), (classid + bytes(24)).hex().upper())
        for bad in (b"", bytes(40), classid + bytes(20) + (99).to_bytes(4, "little") + b"x",
                    classid + bytes(20) + (12).to_bytes(4, "little") + b"vCal-Uid" + bytes((1, 0, 0, 0))):
            with self.assertRaises(ValueError):
                uid_of_global_obj_id(bad)


class CalendarSyncTests(PimTestCase):
    def full_event(self):
        return self.srv.add_event(
            ALICE, subject="Série é", location="Salle 1", body="Notes", start=self.start, end=self.end,
            timezone=PARIS, reminder=15, categories=["Travail", "Urgent"], sensitivity=2, busy_status=1,
            organizer_email=BOB, organizer_name="Bob Test",
            attendees=[{"email": ALICE, "name": "Alice Test", "status": 5, "type": 1},
                       {"email": "carol@example.org", "name": "Carol", "type": 2}],
            response_requested=True, disallow_new_time=True, response_type=2, reply_time=self.now,
            recurrence={"type": 3, "interval": 2, "week_of_month": 1, "day_of_week": 2, "until": self.days(300),
                        "calendar_type": 1, "first_day_of_week": 1},
            exceptions=[{"exception_start": self.days(60), "deleted": True},
                        {"exception_start": self.days(120), "subject": "Autre", "location": "",
                         "start": self.days(121), "end": self.days(121, 2), "response_type": 3,
                         "attendees": [{"email": ALICE, "name": "Alice Test"}]}])

    def test_event_elements_for_each_version(self):
        sid = self.full_event()
        for version in ("14.1", "14.0", "12.1"):
            with self.subTest(version):
                v14 = version != "12.1"
                _, items = self.open(self.cal, self.client(version))
                d = items[sid]
                self.assertEqual(base64.b64decode(d.text("Calendar:Timezone")), PARIS)
                self.assertEqual(d.text("Calendar:StartTime"), compact(self.start))
                self.assertEqual(d.text("Calendar:EndTime"), compact(self.end))
                self.assertRegex(d.text("Calendar:DtStamp"), COMPACT)
                self.assertEqual((d.text("Calendar:Subject"), d.text("Calendar:Location")), ("Série é", "Salle 1"))
                self.assertEqual((d.text("Calendar:OrganizerEmail"), d.text("Calendar:OrganizerName")),
                                 (BOB, "Bob Test"))
                self.assertEqual(d.text("Calendar:MeetingStatus"), "3")  # a meeting received from someone else
                self.assertEqual([d.text(f"Calendar:{n}") for n in ("Sensitivity", "BusyStatus", "AllDayEvent",
                                                                    "Reminder")], ["2", "1", "0", "15"])
                self.assertEqual([c.text() for c in d.child("Calendar:Categories").children], ["Travail", "Urgent"])
                people = d.child("Calendar:Attendees").children
                self.assertEqual([(a.text("Email"), a.text("Name"), a.text("AttendeeStatus"), a.text("AttendeeType"))
                                  for a in people], [(ALICE, "Alice Test", "5", "1"),
                                                     ("carol@example.org", "Carol", None, "2")])
                rec = d.child("Calendar:Recurrence")
                self.assertEqual([rec.text(n) for n in ("Type", "Interval", "WeekOfMonth", "DayOfWeek", "Until")],
                                 ["3", "2", "1", "2", compact(self.days(300))])
                self.assertEqual(rec.text("CalendarType"), "1" if v14 else None)
                self.assertEqual(rec.text("FirstDayOfWeek"), "1" if version == "14.1" else None)
                gone, moved = d.child("Calendar:Exceptions").children
                self.assertEqual([(c.tag, c.text()) for c in gone.children],
                                 [("Deleted", "1"), ("ExceptionStartTime", compact(self.days(60)))])
                self.assertEqual(moved.text("ExceptionStartTime"), compact(self.days(120)))
                self.assertEqual((moved.text("Subject"), moved.text("StartTime")), ("Autre", compact(self.days(121))))
                self.assertEqual(moved.child("Location").value, None)  # empty: not inherited from the series
                self.assertEqual(moved.has("Attendees"), v14)
                self.assertEqual(moved.text("ResponseType"), "3" if v14 else None)
                body = d.child("AirSyncBase:Body")
                self.assertEqual((body.text("Type"), body.text("EstimatedDataSize"), body.text("Data")),
                                 ("1", "5", "Notes"))
                self.assertEqual(d.text("AirSyncBase:NativeBodyType"), "1")
                late = [d.text(f"Calendar:{n}") for n in ("ResponseRequested", "ResponseType",
                                                          "DisallowNewTimeProposal")]
                self.assertEqual(late, ["1", "2", "1"] if v14 else [None, None, None])
                self.assertEqual(d.text("Calendar:AppointmentReplyTime"), compact(self.now) if v14 else None)
        self.assertEqual(self.errors(), [])

    def test_sample_raw_item_and_fetch(self):
        self.ready()
        raw = self.srv.add_raw_item(ALICE, self.cal, [el("Calendar:Subject", "Brut"), el("Calendar:UID", "raw-1")])
        key, items = self.open(self.cal)
        sample = next(sid for sid in items if sid != raw)
        self.assertEqual(items[sample].text("Calendar:Subject"), "Réunion de test")
        self.assertEqual(items[sample].text("Calendar:MeetingStatus"), "0")
        self.assertEqual([c.name for c in items[raw].children], ["Calendar:Subject", "Calendar:UID"])
        views = {v["server_id"]: v for v in self.srv.events(ALICE)}
        self.assertEqual(views[raw], {"server_id": raw, "folder_id": self.cal, "class": "Calendar", "version": 1,
                                      "raw": True})
        self.assertEqual(views[sample]["subject"], "Réunion de test")
        r = self.c.sync(self.cal, key, commands=[el("Fetch", [el("ServerId", sample)])])
        self.assertEqual(r["responses"][0][3].child("ApplicationData").text("Calendar:Subject"), "Réunion de test")
        _, doc = self.c.command("ItemOperations", el("ItemOperations:ItemOperations", [el("Fetch", [
            el("Store", "Mailbox"), el("AirSync:CollectionId", self.cal), el("AirSync:ServerId", sample)])]))
        fetch = doc.find("Response", "Fetch")
        self.assertEqual((fetch.text("Status"), fetch.text("AirSync:Class")), ("1", "Calendar"))
        self.assertEqual(fetch.find("Properties").text("Calendar:Subject"), "Réunion de test")

    def test_client_add_change_delete(self):
        self.ready()
        key, items = self.open(self.cal, supported=calendar_supported())
        data = event_data(Timezone=PARIS, DtStamp=self.now, StartTime=self.start, Subject="Créé", UID="uid-1",
                          Location="Ici", EndTime=self.end, Body="Texte é", Sensitivity=0, BusyStatus=2,
                          AllDayEvent=0, Reminder=10, Categories=["A", "B"], MeetingStatus=0)
        sid, status, r = self.c.add_item(self.cal, key, data, client_id="new-1")
        self.assertTrue(sid.startswith(self.cal + ":"))
        self.assertEqual((status, r["status"], r["commands"]), ("1", "1", []))
        e = self.srv.event(ALICE, self.cal, sid)
        self.assertEqual((e["subject"], e["uid"], e["location"], e["body"], e["reminder"], e["categories"]),
                         ("Créé", "uid-1", "Ici", "Texte é", 10, ["A", "B"]))
        self.assertEqual((e["start"], e["end"]), (self.start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                                  self.end.strftime("%Y-%m-%dT%H:%M:%SZ")))
        self.assertEqual((e["zone"]["bias"], base64.b64decode(e["timezone"])), (-60, PARIS))
        act = self.srv.actions("sync_add")[-1]
        self.assertEqual((act["client_id"], act["server_id"], act["status"], act["class"], act["fields"]["subject"]),
                         ("new-1", sid, "1", "Calendar", "Créé"))
        key, cmds = self.drain(self.cal, r["key"])
        self.assertEqual(cmds, [])  # no echo of the device's own item
        changed = event_data(Timezone=PARIS, DtStamp=self.now, StartTime=self.days(1), Subject="Modifié", UID="uid-1",
                             Location="Là", EndTime=self.days(1, 2), Sensitivity=0, BusyStatus=2, AllDayEvent=0,
                             Categories=["A"])
        status, r = self.c.change_item(self.cal, key, sid, changed)
        self.assertEqual((status, r["responses"], r["commands"]), ("1", [], []))
        e = self.srv.event(ALICE, self.cal, sid)
        self.assertEqual((e["subject"], e["location"], e["reminder"], e["categories"], e["version"]),
                         ("Modifié", "Là", None, ["A"], 2))
        self.assertEqual(e["body"], "Texte é")  # no Body in the Change: the body stays
        self.assertEqual(self.srv.actions("sync_change")[-1]["changes"]["subject"], "Modifié")
        status, r = self.c.change_item(self.cal, r["key"], self.cal + ":999", changed)
        self.assertEqual(status, "8")
        r = self.c.delete_item(self.cal, r["key"], sid)
        self.assertEqual(r["status"], "1")
        self.assertIsNone(self.srv.event(ALICE, self.cal, sid))
        self.assertEqual(self.errors(), [])
        json.dumps(self.srv.events(ALICE))  # plain dictionaries

    def test_add_refused_with_status_6(self):
        self.ready()
        key, _ = self.open(self.cal)
        s, e = self.start, self.end

        def rec(**fields):
            return event_data(StartTime=s, EndTime=e, Recurrence=fields)

        cases = [
            ("EndTime without StartTime", event_data(Subject="x", EndTime=e), False),
            ("DayOfMonth with Type 1", rec(Type=1, DayOfWeek=2, DayOfMonth=3), False),
            ("DayOfWeek with Type 2", rec(Type=2, DayOfMonth=3, DayOfWeek=2), False),
            ("MonthOfYear with Type 3", rec(Type=3, WeekOfMonth=1, DayOfWeek=2, MonthOfYear=4), False),
            ("WeekOfMonth with Type 5", rec(Type=5, DayOfMonth=1, MonthOfYear=2, WeekOfMonth=1), False),
            ("CalendarType 13", rec(Type=2, DayOfMonth=1, CalendarType=13), False),
            ("CalendarType 16", rec(Type=2, DayOfMonth=1, CalendarType=16), False),
            ("CalendarType 23", rec(Type=5, DayOfMonth=1, MonthOfYear=2, CalendarType=23), False),
            ("two CalendarType", event_data(StartTime=s, EndTime=e) + [el("Calendar:Recurrence", [
                el("Type", "2"), el("DayOfMonth", "3"), el("CalendarType", "1"), el("CalendarType", "1")])], False),
            ("FirstDayOfWeek 7", rec(Type=1, DayOfWeek=2, FirstDayOfWeek=7), False),
            ("Recurrence without Type", rec(Interval=1), False),
            ("Type 4", rec(Type=4), False),
            ("weekly without DayOfWeek", rec(Type=1), False),
            ("yearly without MonthOfYear", rec(Type=5, DayOfMonth=1), False),
            ("Occurrences 1000", rec(Type=0, Occurrences=1000), False),
            ("Timezone of 171 bytes", event_data(StartTime=s, EndTime=e, Timezone=bytes(171)), False),
            ("Timezone not base64", event_data(StartTime=s, EndTime=e, Timezone="@@@"), False),
            ("Timezone name not padded with zeros", event_data(StartTime=s, EndTime=e, Timezone=(
                bytes(4) + b"A\x00\x00\x00B\x00" + bytes(162))), False),
            ("StartTime not compact", event_data(StartTime="2027-03-01T09:00:00Z", EndTime=e), False),
            ("StartTime 31 February", event_data(StartTime="20270231T090000Z", EndTime=e), False),
            ("EndTime before StartTime", event_data(StartTime=e, EndTime=s), False),
            ("BusyStatus 4", event_data(StartTime=s, EndTime=e, BusyStatus=4), False),
            ("Sensitivity 4", event_data(StartTime=s, EndTime=e, Sensitivity=4), False),
            ("MeetingStatus 2", event_data(StartTime=s, EndTime=e, MeetingStatus=2), False),
            ("AllDayEvent 2", event_data(StartTime=s, EndTime=e, AllDayEvent=2), False),
            ("Reminder not a number", event_data(StartTime=s, EndTime=e, Reminder="soon"), False),
            ("OrganizerEmail", event_data(StartTime=s, EndTime=e, OrganizerEmail="nobody"), False),
            ("UID of 301 characters", event_data(StartTime=s, EndTime=e, UID="u" * 301), False),
            ("Attendee without Name", event_data(StartTime=s, EndTime=e, Attendees=[{"Email": BOB}]), False),
            ("AttendeeStatus 1", event_data(StartTime=s, EndTime=e, Attendees=[
                {"Email": BOB, "Name": "Bob", "AttendeeStatus": 1}]), False),
            ("Exception without ExceptionStartTime", event_data(StartTime=s, EndTime=e, Recurrence={"Type": 0},
                                                                Exceptions=[{"Deleted": 1}]), False),
            ("Exceptions without Recurrence", event_data(StartTime=s, EndTime=e, Exceptions=[
                {"ExceptionStartTime": s, "Deleted": 1}]), False),
            ("Subject twice", event_data(StartTime=s, EndTime=e, Subject="a") + event_data(Subject="b"), False),
            ("Body of type 3", event_data(StartTime=s, EndTime=e) + [el("AirSyncBase:Body", [
                el("Type", "3"), el("Data", "e1xydGYxfQ==")])], False),
            # What a client must not send, or what belongs to another class: also a protocol error.
            ("ResponseType", event_data(StartTime=s, EndTime=e, ResponseType=3), True),
            ("AppointmentReplyTime", event_data(StartTime=s, EndTime=e, AppointmentReplyTime=s), True),
            ("ClientUid", event_data(StartTime=s, EndTime=e, ClientUid="abc"), True),
            ("OnlineMeetingExternalLink", event_data(StartTime=s, EndTime=e, OnlineMeetingExternalLink="x"), True),
            ("ResponseType in an Exception", event_data(StartTime=s, EndTime=e, Recurrence={"Type": 0}, Exceptions=[
                {"ExceptionStartTime": s, "ResponseType": 3}]), True),
            ("element of another class", event_data(StartTime=s, EndTime=e) + [el("Email:Subject", "x")], True),
            ("task element", event_data(StartTime=s, EndTime=e) + [el("Tasks:Complete", "0")], True),
            ("Attendee child", event_data(StartTime=s, EndTime=e) + [el("Calendar:Email", BOB)], True),
        ]
        key = self.refusals(self.c, self.cal, key, cases)
        # Still accepted: Interval 0 becomes 1, Occurrences wins over Until, a yearly "nth day" needs no DayOfWeek,
        # and 14.1 may send an empty Reminder.
        sid, status, r = self.c.add_item(self.cal, key, event_data(
            StartTime=s, EndTime=e, Reminder=None, Recurrence={"Type": 0, "Interval": 0, "Occurrences": 5,
                                                               "Until": self.days(30)}))
        self.assertEqual(status, "1")
        got = self.srv.event(ALICE, self.cal, sid)
        self.assertEqual((got["recurrence"]["interval"], got["recurrence"]["occurrences"], got["recurrence"]["until"],
                          got["reminder"]), (1, 5, None, None))
        sid, status, r = self.c.add_item(self.cal, r["key"], rec(Type=6, WeekOfMonth=5, MonthOfYear=6))
        self.assertEqual(status, "1")

    def test_elements_refused_by_version(self):
        s, e = self.start, self.end
        c140 = self.client("14.0")
        key, _ = self.open(self.cal, c140)
        key = self.refusals(c140, self.cal, key, [
            ("FirstDayOfWeek in 14.0", event_data(StartTime=s, EndTime=e, Recurrence={
                "Type": 1, "DayOfWeek": 2, "FirstDayOfWeek": 1}), True),
            ("empty Reminder in 14.0", event_data(StartTime=s, EndTime=e, Reminder=None), False),
        ])
        ok = event_data(StartTime=s, EndTime=e, ResponseRequested=1, DisallowNewTimeProposal=0,
                        Recurrence={"Type": 2, "DayOfMonth": 3, "CalendarType": 1, "IsLeapMonth": 0})
        self.assertEqual(c140.add_item(self.cal, key, ok)[1], "1")
        c121 = self.client("12.1")
        key, _ = self.open(self.cal, c121)
        self.refusals(c121, self.cal, key, [
            ("ResponseRequested in 12.1", event_data(StartTime=s, EndTime=e, ResponseRequested=1), True),
            ("DisallowNewTimeProposal in 12.1", event_data(StartTime=s, EndTime=e, DisallowNewTimeProposal=1), True),
            ("CalendarType in 12.1", event_data(StartTime=s, EndTime=e, Recurrence={
                "Type": 2, "DayOfMonth": 3, "CalendarType": 1}), True),
            ("Attendees in an Exception in 12.1", event_data(StartTime=s, EndTime=e, Recurrence={"Type": 0}, Exceptions=[
                {"ExceptionStartTime": s, "Attendees": [{"Email": BOB, "Name": "Bob"}]}]), True),
        ])

    def test_missing_times_on_add(self):
        self.ready()
        key, _ = self.open(self.cal)
        sid, status, r = self.c.add_item(self.cal, key, event_data(Subject="Sans heures"))
        self.assertEqual(status, "1")
        got = self.srv.event(ALICE, self.cal, sid)
        begin = datetime.datetime.strptime(got["start"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        finish = datetime.datetime.strptime(got["end"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        self.assertIn(begin.minute, (0, 30))
        self.assertEqual(begin.second, 0)
        self.assertTrue(datetime.timedelta(0) <= begin - self.now <= datetime.timedelta(minutes=31))
        self.assertEqual(finish - begin, datetime.timedelta(minutes=30))
        self.assertTrue(got["uid"])  # the server made one
        past = self.now - datetime.timedelta(days=2)
        sid, status, r = self.c.add_item(self.cal, r["key"], event_data(StartTime=past))
        self.assertEqual(status, "1")
        self.assertGreater(self.srv.event(ALICE, self.cal, sid)["end"], got["start"])
        self.assertEqual(self.c.add_item(self.cal, r["key"], event_data(StartTime=self.start))[1], "6")

    def meeting(self, subject):
        return self.srv.add_event(
            ALICE, subject=subject, location="L", body="B", start=self.start, end=self.end, timezone=PARIS,
            reminder=15, categories=["C"], sensitivity=1, uid="uid-" + subject, all_day=False,
            attendees=[{"email": BOB, "name": "Bob", "status": 3, "type": 1}], response_requested=True,
            recurrence={"type": 0, "interval": 1}, exceptions=[{"exception_start": self.days(2), "deleted": True}])

    def test_ghosting_with_and_without_supported(self):
        a, b, c = self.meeting("A"), self.meeting("B"), self.meeting("C")
        moved = {"StartTime": self.days(1), "EndTime": self.days(1, 1)}
        # No Supported: nothing is ghosted, so what the Change leaves out is deleted.
        plain = self.client(device="NoSupported")
        key, _ = self.open(self.cal, plain)
        self.assertIsNone(self.state(plain, self.cal)["supported"])
        status, r = plain.change_item(self.cal, key, a, event_data(Subject="A2", **moved))
        self.assertEqual(status, "1")
        got = self.srv.event(ALICE, self.cal, a)
        self.assertEqual((got["subject"], got["start"]), ("A2", self.days(1).strftime("%Y-%m-%dT%H:%M:%SZ")))
        for field in ("location", "reminder", "sensitivity", "busy_status", "timezone", "uid", "all_day",
                      "organizer_email", "organizer_name", "meeting_status", "response_requested", "recurrence",
                      "response_type"):
            self.assertIsNone(got[field], field)
        self.assertEqual((got["categories"], got["attendees"], got["exceptions"]), ([], [], []))
        self.assertEqual(got["body"], "B")  # [MS-ASCMD] 2.2.3.24: no Body, no change
        self.assertGreaterEqual(got["dtstamp"], self.now.strftime("%Y-%m-%dT%H:%M:%SZ"))
        status, r = plain.change_item(self.cal, r["key"], a, event_data(Subject="A3"))
        self.assertEqual(status, "6")  # StartTime is not ghosted and the server cannot keep an event without it
        self.assertEqual(self.srv.event(ALICE, self.cal, a)["subject"], "A2")
        # Supported names the 14 required elements: those are not ghosted, the six others are.
        some = self.client(device="RequiredOnly")
        key, _ = self.open(self.cal, some, supported=[f"Calendar:{n}" for n in SUPPORTED_REQUIRED])
        self.assertEqual(self.state(some, self.cal)["supported"], sorted(SUPPORTED_REQUIRED))
        status, r = some.change_item(self.cal, key, b, event_data(Subject="B2", Recurrence={"Type": 0}, **moved))
        self.assertEqual(status, "1")
        got = self.srv.event(ALICE, self.cal, b)
        for field in ("location", "reminder", "sensitivity", "busy_status", "timezone", "uid", "all_day"):
            self.assertIsNone(got[field], field)
        self.assertEqual(got["categories"], [])
        self.assertEqual((got["organizer_email"], got["meeting_status"], got["response_requested"],
                          [x["email"] for x in got["attendees"]], got["response_type"]), (ALICE, 1, True, [BOB], 1))
        # Exceptions is named by Supported, yet without it in the Change the exceptions stay ([MS-ASCAL] 3.2.5.3.1).
        self.assertEqual([x["deleted"] for x in got["exceptions"]], [True])
        # An empty Supported: everything that can be ghosted is. Location cannot ([MS-ASCAL] 2.2.2.27).
        ghost = self.client(device="EmptySupported")
        key, _ = self.open(self.cal, ghost, supported=[])
        self.assertEqual(self.state(ghost, self.cal)["supported"], [])
        status, r = ghost.change_item(self.cal, key, c, event_data(Subject="C2"))
        self.assertEqual(status, "1")
        got = self.srv.event(ALICE, self.cal, c)
        self.assertEqual((got["subject"], got["location"], got["reminder"], got["sensitivity"], got["uid"],
                          got["categories"], got["start"]),
                         ("C2", None, 15, 1, "uid-C", ["C"], self.start.strftime("%Y-%m-%dT%H:%M:%SZ")))
        self.assertEqual((got["recurrence"]["type"], len(got["exceptions"]), len(got["attendees"])), (0, 1, 1))
        self.assertEqual(base64.b64decode(got["timezone"]), PARIS)
        self.assertEqual(self.errors(), [])

    def test_exceptions_in_a_change(self):
        sid = self.meeting("E")
        c = self.client()
        key, _ = self.open(self.cal, c, supported=[])
        status, r = c.change_item(self.cal, key, sid, event_data(Exceptions=[
            {"ExceptionStartTime": self.days(5), "Subject": "Déplacée", "StartTime": self.days(5, 3),
             "EndTime": self.days(5, 4), "Location": None, "Body": "Autre texte"}]))
        self.assertEqual(status, "1")
        got = self.srv.event(ALICE, self.cal, sid)["exceptions"]
        self.assertEqual([(x["exception_start"][:10], x["deleted"]) for x in got],
                         [(self.days(2).strftime("%Y-%m-%d"), True), (self.days(5).strftime("%Y-%m-%d"), False)])
        self.assertEqual((got[1]["subject"], got[1]["location"], got[1]["body"]), ("Déplacée", "", "Autre texte"))
        status, r = c.change_item(self.cal, r["key"], sid, event_data(Exceptions=[
            {"ExceptionStartTime": self.days(5), "Deleted": 1}]))
        self.assertEqual([x["deleted"] for x in self.srv.event(ALICE, self.cal, sid)["exceptions"]], [True, True])
        status, r = c.change_item(self.cal, r["key"], sid, event_data(Exceptions=[
            {"ExceptionStartTime": self.days(6), "Deleted": 1}, {"ExceptionStartTime": self.days(6), "Deleted": 1}]))
        self.assertEqual(status, "6")

    def test_supported_only_in_its_place(self):
        self.ready()

        def first(children, client=None):
            _, doc = (client or self.c).command("Sync", el("AirSync:Sync", [el("Collections", [
                el("Collection", children)])]))
            return parse_sync(doc)["status"]

        full = [el(n) for n in calendar_supported()]
        key0, cid = el("SyncKey", "0"), el("CollectionId", self.cal)
        self.assertEqual(first([key0, cid, el("Options", PIM_OPTIONS), el("Supported", full)]), "4")
        self.assertEqual(first([key0, el("Supported", full), cid]), "4")
        self.assertEqual(first([el("Supported", full), key0, cid]), "4")
        self.assertEqual(first([key0, cid, el("WindowSize", "5"), el("GetChanges", "0")]), "4")  # strict order
        self.assertEqual(first([key0, cid, el("Supported", [el("Calendar:Subject")])]), "4")  # required ones missing
        self.assertEqual(first([key0, cid, el("Supported", full + [el("Calendar:ResponseType")])]), "4")
        self.assertEqual(first([key0, cid, el("Supported", full + [el("Calendar:Subject")])]), "4")  # twice
        self.assertEqual(first([key0, cid, el("Supported", full[:-1] + [el("Calendar:Subject", "x")])]), "4")
        self.assertEqual(first([key0, cid, el("Supported", [el("Contacts:FirstName")])]), "4")
        self.assertEqual(first([key0, el("CollectionId", self.todo), el("Supported", [el("Tasks:Subject")])]), "4")
        self.assertEqual(first([key0, el("CollectionId", self.todo), el("Supported")]), "1")
        self.assertEqual(len(self.errors()), 10)
        old = self.client("12.1")
        self.assertEqual(first([key0, cid, el("Supported", full)], old), "4")  # ResponseRequested: from 14.0
        self.assertEqual(first([key0, cid, el("Supported", [el(n) for n in calendar_supported("12.1")])], old), "1")
        self.assertEqual(first([el("Class", "Calendar"), key0, cid], old), "1")  # Class in Collection: up to 12.1
        self.assertEqual(first([el("Class", "Calendar"), key0, cid]), "4")
        # With another SyncKey, Supported is ignored without an error status; the server notes the misuse.
        r = self.c.sync(self.cal, "0", supported=[], options=PIM_OPTIONS)
        known = len(self.errors())
        r = self.c.sync(self.cal, r["key"], supported=calendar_supported())
        self.assertEqual(r["status"], "1")
        self.assertEqual(self.state(self.c, self.cal)["supported"], [])
        self.assertEqual(len(self.errors()), known + 1)
        self.assertIn("Supported", self.errors()[-1])
        # The request the server keeps for an empty Sync does not replay Supported.
        self.srv.add_event(ALICE, subject="Après")
        _, doc = self.c.command("Sync", None)
        self.assertEqual([op for op, _, _ in parse_sync(doc)["commands"]], ["Add"])
        self.assertEqual(len(self.errors()), known + 1)

    def test_filter_type(self):
        day = datetime.timedelta(days=1)
        hour = datetime.timedelta(hours=1)

        def at(days_ago):
            return self.now - days_ago * day

        ids = {
            "old": self.srv.add_event(ALICE, subject="old", start=at(40), end=at(40) + hour),
            "month": self.srv.add_event(ALICE, subject="month", start=at(20), end=at(20) + hour),
            "recent": self.srv.add_event(ALICE, subject="recent", start=at(3), end=at(3) + hour),
            "future": self.srv.add_event(ALICE, subject="future", start=at(-90), end=at(-90) + hour),
            "endless": self.srv.add_event(ALICE, subject="endless", start=at(400), end=at(400) + hour,
                                          recurrence={"type": 0}),
            "ended": self.srv.add_event(ALICE, subject="ended", start=at(400), end=at(400) + hour,
                                        recurrence={"type": 0, "until": at(200)}),
            "counted": self.srv.add_event(ALICE, subject="counted", start=at(400), end=at(400) + hour,
                                          recurrence={"type": 1, "day_of_week": 2, "occurrences": 2}),
            "running": self.srv.add_event(ALICE, subject="running", start=at(400), end=at(400) + hour,
                                          recurrence={"type": 1, "day_of_week": 2, "until": at(-30)}),
        }
        sample = self.srv.find_events(ALICE, subject="Réunion de test")[0]["server_id"]
        self.ready()

        def window(value):
            return [el("AirSync:FilterType", value), el("AirSyncBase:BodyPreference", [el("Type", "1")])]

        key, items = self.open(self.cal, options=window("4"))  # two weeks back
        self.assertEqual(sorted(items), sorted([ids["recent"], ids["future"], ids["endless"], ids["running"], sample]))
        r = self.c.sync(self.cal, key, options=window("5"))  # one month back: one more
        self.assertEqual([(op, sid) for op, sid, _ in r["commands"]], [("Add", ids["month"])])
        r = self.c.sync(self.cal, r["key"], options=window("0"))
        self.assertEqual(sorted(sid for op, sid, _ in r["commands"] if op == "Add"),
                         sorted([ids["old"], ids["ended"], ids["counted"]]))
        r = self.c.sync(self.cal, r["key"], options=window("7"))  # six months back
        self.assertEqual(sorted((op, sid) for op, sid, _ in r["commands"]),
                         sorted([("SoftDelete", ids["ended"]), ("SoftDelete", ids["counted"])]))
        # An item that leaves the period is a SoftDelete, not a Delete.
        r = self.c.sync(self.cal, r["key"], options=window("4"))
        self.assertEqual(sorted((op, sid) for op, sid, _ in r["commands"]),
                         sorted([("SoftDelete", ids["old"]), ("SoftDelete", ids["month"])]))
        self.srv.change_event(ALICE, self.cal, ids["recent"], start=at(60), end=at(60) + hour)
        key, cmds = self.drain(self.cal, r["key"])
        self.assertEqual([(op, sid) for op, sid, _ in cmds], [("SoftDelete", ids["recent"])])
        self.assertIsNotNone(self.srv.event(ALICE, self.cal, ids["recent"]))
        for bad in ("1", "2", "3", "8", "9"):
            self.assertEqual(self.c.sync(self.cal, "0", options=window(bad))["status"], "4", bad)
        self.assertEqual(self.c.sync(self.cal, "0", options=window("6"))["status"], "1")

    def test_body_preference(self):
        sid = self.srv.add_event(ALICE, subject="Corps", body="é" * 100 + " <fin>")
        self.ready()

        def body_with(*prefs):
            options = [el("AirSync:FilterType", "0")] + [el("AirSyncBase:BodyPreference", list(p)) for p in prefs]
            return self.open(self.cal, options=options)[1][sid].child("AirSyncBase:Body")

        body = body_with([el("Type", "1"), el("TruncationSize", "51")])
        self.assertEqual((body.text("Type"), body.text("EstimatedDataSize"), body.text("Truncated")), ("1", "206", "1"))
        self.assertEqual(body.text("Data"), "é" * 25)  # cut between characters
        body = body_with([el("Type", "1")])
        self.assertEqual((body.text("Truncated"), body.text("Data")), (None, "é" * 100 + " <fin>"))
        body = body_with([el("Type", "2")])
        self.assertEqual((body.text("Type"), body.text("Data")),
                         ("2", "<html><body><pre>" + "é" * 100 + " &lt;fin&gt;</pre></body></html>"))
        body = body_with([el("Type", "2"), el("TruncationSize", "10"), el("AllOrNone", "1")],
                         [el("Type", "1"), el("TruncationSize", "20")])
        self.assertEqual((body.text("Type"), body.text("Data")), ("1", "é" * 10))
        body = body_with([el("Type", "1"), el("TruncationSize", "10"), el("AllOrNone", "1")])
        self.assertEqual((body.text("Truncated"), body.has("Data")), ("1", False))
        body = body_with([el("Type", "3")])  # RTF: the mock has plain text only
        self.assertEqual(body.text("Type"), "1")

    def test_server_side_changes(self):
        sid = self.srv.add_event(ALICE, subject="Point", start=self.start, end=self.end,
                                 attendees=[{"email": BOB, "name": "Bob", "status": 0, "type": 1}])
        self.ready()
        key, items = self.open(self.cal, supported=calendar_supported())
        self.assertEqual(items[sid].text("Calendar:MeetingStatus"), "1")
        self.srv.change_event(ALICE, self.cal, sid, subject="Point déplacé", start="2030-01-02T10:00:00Z",
                              end="20300102T110000Z", location="Salle 2")
        key, cmds = self.drain(self.cal, key)
        self.assertEqual([(op, s) for op, s, _ in cmds], [("Change", sid)])
        d = cmds[0][2]
        self.assertEqual((d.text("Calendar:Subject"), d.text("Calendar:StartTime"), d.text("Calendar:EndTime"),
                          d.text("Calendar:Location")), ("Point déplacé", "20300102T100000Z", "20300102T110000Z",
                                                         "Salle 2"))
        self.srv.set_attendee_status(ALICE, self.cal, sid, BOB.upper(), "accepted")  # as when Bob's reply arrives
        key, cmds = self.drain(self.cal, key)
        self.assertEqual(cmds[0][2].find("Calendar:Attendees", "Attendee").text("AttendeeStatus"), "3")
        self.srv.set_attendee_status(ALICE, self.cal, sid, BOB, 4)
        self.assertEqual(self.srv.event(ALICE, self.cal, sid)["attendees"][0]["status"], 4)
        self.srv.cancel_meeting(ALICE, self.cal, sid)
        key, cmds = self.drain(self.cal, key)
        self.assertEqual(cmds[-1][2].text("Calendar:MeetingStatus"), "5")
        self.srv.delete_event(ALICE, self.cal, sid)
        key, cmds = self.drain(self.cal, key)
        self.assertEqual([(op, s) for op, s, _ in cmds], [("Delete", sid)])
        with self.assertRaises(KeyError):
            self.srv.set_attendee_status(ALICE, self.cal, sid, BOB, 3)
        other = self.srv.add_event(ALICE, subject="Seul")
        with self.assertRaises(KeyError):
            self.srv.set_attendee_status(ALICE, self.cal, other, BOB, 3)
        with self.assertRaises(ValueError):
            self.srv.cancel_meeting(ALICE, self.cal, other)
        with self.assertRaises(TypeError):
            self.srv.add_event(ALICE, sujet="faute de frappe")
        with self.assertRaises(ValueError):
            self.srv.change_event(ALICE, self.cal, other, start="demain")
        with self.assertRaises(TypeError):
            self.srv.change_task(ALICE, self.cal, other, subject="pas une tâche")
        with self.assertRaises(TypeError):
            self.srv.add_event(ALICE, self.inbox, subject="pas dans un dossier de courrier")
        with self.assertRaises(TypeError):
            self.srv.add_task(ALICE, self.cal, subject="pas dans un agenda")
        self.assertEqual([e["subject"] for e in self.srv.find_events(ALICE, subject="Seul")], ["Seul"])
        self.assertEqual(self.srv.find_events(ALICE, uid=self.srv.event(ALICE, self.cal, other)["uid"])[0]["server_id"],
                         other)

    def test_ping_and_estimate_see_calendar_and_task_changes(self):
        self.ready()
        key, _ = self.open(self.cal)
        tkey, _ = self.open(self.todo)
        folders = el("Folders", [el("Folder", [el("Id", self.cal), el("Class", "Calendar")]),
                                 el("Folder", [el("Id", self.todo), el("Class", "Tasks")])])
        self.srv.add_task(ALICE, subject="Nouvelle")
        _, doc = self.c.command("Ping", el("Ping:Ping", [el("HeartbeatInterval", "60"), folders]))
        self.assertEqual((doc.text("Status"), [f.text() for f in doc.child("Folders").children]), ("2", [self.todo]))
        self.srv.add_event(ALICE, subject="Nouveau")
        self.srv.change_event(ALICE, self.cal, self.srv.find_events(ALICE, subject="Réunion de test")[0]["server_id"],
                              location="Ailleurs")
        _, doc = self.c.command("GetItemEstimate", el("GetItemEstimate:GetItemEstimate", [el("Collections", [
            el("Collection", [el("AirSync:SyncKey", key), el("CollectionId", self.cal)])])]))
        self.assertEqual(doc.find("Response", "Collection").text("Estimate"), "2")
        _, doc = self.c.command("Ping", None)
        self.assertEqual([f.text() for f in doc.child("Folders").children], [self.cal, self.todo])

    def test_conflict_and_failed_change(self):
        sid = self.srv.add_event(ALICE, subject="Conflit", start=self.start, end=self.end)
        self.ready()
        key, _ = self.open(self.cal, supported=[])
        self.srv.change_event(ALICE, self.cal, sid, location="Serveur")
        status, r = self.c.change_item(self.cal, key, sid, event_data(Subject="Client"))
        self.assertEqual(status, "7")  # the server's object stays, and comes back
        self.assertEqual([(op, s, d.text("Calendar:Subject")) for op, s, d in r["commands"]],
                         [("Change", sid, "Conflit")])
        self.assertTrue(self.srv.actions("sync_change")[-1]["conflict"])
        client_wins = [el("AirSync:FilterType", "0"), el("AirSync:Conflict", "0")]
        self.srv.change_event(ALICE, self.cal, sid, location="Serveur 2")
        status, r = self.c.change_item(self.cal, r["key"], sid, event_data(Subject="Client"), options=client_wins)
        self.assertEqual((status, r["commands"]), ("1", []))
        self.assertEqual(self.srv.event(ALICE, self.cal, sid)["subject"], "Client")
        # The option that makes the next calendar Change fail, once.
        self.srv.set_option("fail_next_calendar_change", "6")
        status, r = self.c.change_item(self.cal, r["key"], sid, event_data(Subject="Refusé"))
        self.assertEqual((status, r["status"]), ("6", "1"))
        self.assertEqual(self.srv.event(ALICE, self.cal, sid)["subject"], "Client")
        self.assertEqual(self.srv.actions("sync_change")[-1]["injected"], "6")
        self.assertIsNone(self.srv.options.fail_next_calendar_change)
        status, r = self.c.change_item(self.cal, r["key"], sid, event_data(Subject="Accepté"))
        self.assertEqual(status, "1")
        self.srv.set_option("fail_next_calendar_change", 5)  # a status of the whole collection
        before = r["key"]
        status, r = self.c.change_item(self.cal, before, sid, event_data(Subject="Panne"))
        self.assertEqual((r["status"], r["key"], r["responses"]), ("5", before, []))
        self.assertEqual(self.srv.event(ALICE, self.cal, sid)["subject"], "Accepté")
        # A task Change is not concerned.
        self.srv.set_option("fail_next_calendar_change", "6")
        tid = self.srv.add_task(ALICE, subject="T")
        tkey, _ = self.open(self.todo)
        self.assertEqual(self.c.change_item(self.todo, tkey, tid, task_data(Subject="T2", Complete=0))[0], "1")
        self.assertEqual(self.srv.options.fail_next_calendar_change, "6")


class TaskSyncTests(PimTestCase):
    def test_task_elements_for_each_version(self):
        due = self.days(3)
        sid = self.srv.add_task(
            ALICE, subject="Rapport é", body="Détails", importance=2, start_date=self.start, utc_start_date=self.start,
            due_date=due, utc_due_date=due, categories=["Travail"], sensitivity=1, reminder_set=True,
            reminder_time=self.days(2),
            recurrence={"type": 1, "start": self.start, "interval": 2, "day_of_week": 4, "occurrences": 6,
                        "regenerate": 0, "dead_occur": 0})
        done = self.srv.add_task(ALICE, subject="Fait", complete=True,
                                 recurrence={"type": 2, "start": self.start, "day_of_month": 5, "until": self.days(90)})
        for version in ("14.1", "14.0", "12.1"):
            with self.subTest(version):
                _, items = self.open(self.todo, self.client(version))
                d = items[sid]
                self.assertEqual([d.text(f"Tasks:{n}") for n in ("Subject", "Importance", "Complete", "Sensitivity",
                                                                 "ReminderSet")], ["Rapport é", "2", "0", "1", "1"])
                self.assertEqual([d.text(f"Tasks:{n}") for n in ("StartDate", "UtcStartDate", "DueDate", "UtcDueDate",
                                                                 "ReminderTime")],
                                 [long_date(self.start), long_date(self.start), long_date(due), long_date(due),
                                  long_date(self.days(2))])
                self.assertIsNone(d.child("Tasks:DateCompleted"))
                self.assertEqual([c.text() for c in d.child("Tasks:Categories").children], ["Travail"])
                self.assertEqual(d.text("AirSyncBase:Body", "Data"), "Détails")
                rec = d.child("Tasks:Recurrence")
                self.assertEqual([rec.text(n) for n in ("Type", "Start", "Interval", "DayOfWeek", "Occurrences",
                                                        "Regenerate", "DeadOccur")],
                                 ["1", long_date(self.start), "2", "4", "6", "0", "0"])
                # [MS-ASTASK] 2.2.2.13: FirstDayOfWeek always comes with a weekly recurrence, from 14.1.
                self.assertEqual(rec.text("FirstDayOfWeek"), "0" if version == "14.1" else None)
                self.assertIsNone(rec.child("CalendarType"))
                d = items[done]
                self.assertEqual(d.text("Tasks:Complete"), "1")
                self.assertRegex(d.text("Tasks:DateCompleted"), r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$")
                rec = d.child("Tasks:Recurrence")
                self.assertEqual((rec.text("DayOfMonth"), rec.text("Until")), ("5", long_date(self.days(90))))
                self.assertEqual(rec.text("CalendarType"), None if version == "12.1" else "0")
        json.dumps(self.srv.tasks(ALICE))

    def test_client_add_change_delete(self):
        self.ready()
        key, items = self.open(self.todo, supported=[])
        self.assertEqual([d.text("Tasks:Subject") for d in items.values()], ["Tâche de test"])
        due = self.days(3)
        sid, status, r = self.c.add_item(self.todo, key, task_data(
            Body="Notes", Subject="Du client", Importance=2, UtcStartDate=self.start, StartDate=self.start,
            UtcDueDate=due, DueDate=due, Categories=["A"], Complete=0, Sensitivity=1, ReminderSet=1,
            ReminderTime=self.days(2)), client_id="t-1")
        self.assertEqual((status, r["commands"]), ("1", []))
        got = self.srv.task(ALICE, self.todo, sid)
        self.assertEqual((got["subject"], got["body"], got["importance"], got["categories"], got["complete"],
                          got["sensitivity"], got["reminder_set"], got["due_date"]),
                         ("Du client", "Notes", 2, ["A"], False, 1, True, due.strftime("%Y-%m-%dT%H:%M:%SZ")))
        self.assertEqual(self.srv.actions("sync_add")[-1]["class"], "Tasks")
        # A Change: what is left out is deleted, except Importance, ReminderSet and the body.
        status, r = self.c.change_item(self.todo, r["key"], sid, task_data(Subject="Terminé", Complete=1))
        self.assertEqual(status, "1")
        got = self.srv.task(ALICE, self.todo, sid)
        self.assertEqual((got["subject"], got["complete"], got["importance"], got["reminder_set"], got["body"]),
                         ("Terminé", True, 2, True, "Notes"))
        self.assertEqual((got["due_date"], got["start_date"], got["categories"], got["sensitivity"],
                          got["reminder_time"]), (None, None, [], None, None))
        self.assertGreaterEqual(got["date_completed"], self.now.strftime("%Y-%m-%dT%H:%M:%SZ"))
        completed = got["date_completed"]
        status, r = self.c.change_item(self.todo, r["key"], sid, task_data(Subject="Toujours", Complete=1,
                                                                           Importance=7))
        self.assertEqual((self.srv.task(ALICE, self.todo, sid)["date_completed"],
                          self.srv.task(ALICE, self.todo, sid)["importance"]), (completed, 7))
        status, r = self.c.change_item(self.todo, r["key"], sid, task_data(Subject="Rouverte", Complete=0))
        self.assertIsNone(self.srv.task(ALICE, self.todo, sid)["date_completed"])
        r = self.c.delete_item(self.todo, r["key"], sid)
        self.assertIsNone(self.srv.task(ALICE, self.todo, sid))
        self.assertEqual(self.srv.messages(ALICE, self.trash), [])  # not moved to Deleted Items
        self.assertEqual(self.errors(), [])

    def test_add_refused_with_status_6(self):
        self.ready()
        key, _ = self.open(self.todo)
        s = self.start

        def rec(**fields):
            return task_data(Subject="r", Complete=0, Recurrence=fields)

        cases = [
            ("no Complete", task_data(Subject="x"), False),
            ("Complete 2", task_data(Complete=2), False),
            ("Recurrence without Type", rec(Start=s), False),
            ("Recurrence without Start", rec(Type=0), False),
            ("CalendarType with Type 0", rec(Type=0, Start=s, CalendarType=1), False),
            ("CalendarType 17", rec(Type=2, Start=s, DayOfMonth=1, CalendarType=17), False),
            ("CalendarType 23", rec(Type=2, Start=s, DayOfMonth=1, CalendarType=23), False),
            ("DayOfMonth with Type 1", rec(Type=1, Start=s, DayOfWeek=2, DayOfMonth=1), False),
            ("DayOfWeek with Type 2", rec(Type=2, Start=s, DayOfMonth=1, DayOfWeek=2), False),
            ("DayOfWeek with Type 5", rec(Type=5, Start=s, DayOfMonth=1, MonthOfYear=2, DayOfWeek=2), False),
            ("WeekOfMonth with Type 1", rec(Type=1, Start=s, DayOfWeek=2, WeekOfMonth=1), False),
            ("FirstDayOfWeek 7", rec(Type=1, Start=s, DayOfWeek=2, FirstDayOfWeek=7), False),
            ("weekly without DayOfWeek", rec(Type=1, Start=s), False),
            ("Start not a dateTime", rec(Type=0, Start=compact(s)), False),
            ("Occurrences 256", rec(Type=0, Start=s, Occurrences=256), False),
            ("ReminderSet 2", task_data(Complete=0, ReminderSet=2), False),
            ("Sensitivity 4", task_data(Complete=0, Sensitivity=4), False),
            ("DueDate in compact form", task_data(Complete=0, DueDate=compact(s)), False),
            ("OrdinalDate", task_data(Complete=0, OrdinalDate=s), True),
            ("calendar element", task_data(Complete=0) + [el("Calendar:Subject", "x")], True),
        ]
        key = self.refusals(self.c, self.todo, key, cases)
        sid, status, r = self.c.add_item(self.todo, key, rec(Type=3, Start=s, DayOfWeek=127, WeekOfMonth=5,
                                                             Occurrences=3, Until=self.days(9), FirstDayOfWeek=6))
        self.assertEqual(status, "1")
        got = self.srv.task(ALICE, self.todo, sid)["recurrence"]
        self.assertEqual((got["occurrences"], got["until"], got["first_day_of_week"]), (3, None, 6))
        c140 = self.client("14.0")
        key, _ = self.open(self.todo, c140)
        key = self.refusals(c140, self.todo, key, [
            ("FirstDayOfWeek in 14.0", rec(Type=1, Start=s, DayOfWeek=2, FirstDayOfWeek=1), True)])
        self.assertEqual(c140.add_item(self.todo, key, rec(Type=2, Start=s, DayOfMonth=3, CalendarType=1))[1], "1")
        c121 = self.client("12.1")
        key, _ = self.open(self.todo, c121)
        self.refusals(c121, self.todo, key, [
            ("CalendarType in 12.1", rec(Type=2, Start=s, DayOfMonth=3, CalendarType=1), True),
            ("IsLeapMonth in 12.1", rec(Type=2, Start=s, DayOfMonth=3, IsLeapMonth=0), True)])

    def test_filter_incomplete_tasks_and_server_changes(self):
        todo = self.srv.add_task(ALICE, subject="À faire")
        done = self.srv.add_task(ALICE, subject="Faite", complete=True)
        sample = self.srv.find_tasks(ALICE, subject="Tâche de test")[0]["server_id"]
        self.ready()
        incomplete = [el("AirSync:FilterType", "8"), el("AirSyncBase:BodyPreference", [el("Type", "1")])]
        key, items = self.open(self.todo, options=incomplete)
        self.assertEqual(sorted(items), sorted([todo, sample]))
        self.srv.change_task(ALICE, self.todo, todo, complete=True)
        key, cmds = self.drain(self.todo, key)
        self.assertEqual([(op, s) for op, s, _ in cmds], [("SoftDelete", todo)])
        self.srv.change_task(ALICE, self.todo, done, complete=False, subject="Refaite")
        key, cmds = self.drain(self.todo, key)
        self.assertEqual([(op, s, d.text("Tasks:Subject")) for op, s, d in cmds], [("Add", done, "Refaite")])
        # Completed by the device itself: it leaves the device's view too.
        status, r = self.c.change_item(self.todo, key, sample, task_data(Subject="Tâche de test", Complete=1))
        self.assertEqual(status, "1")
        self.assertEqual([(op, s) for op, s, _ in r["commands"]], [("SoftDelete", sample)])
        self.srv.delete_task(ALICE, self.todo, done)
        key, cmds = self.drain(self.todo, r["key"])
        self.assertEqual([(op, s) for op, s, _ in cmds], [("Delete", done)])
        r = self.c.sync(self.todo, key, options=[el("AirSync:FilterType", "0")])
        self.assertEqual(sorted(s for op, s, _ in r["commands"] if op == "Add"), sorted([todo, sample]))
        for bad in ("4", "5", "7"):
            self.assertEqual(self.c.sync(self.todo, "0", options=[el("AirSync:FilterType", bad)])["status"], "4")
        with self.assertRaises(TypeError):
            self.srv.add_task(ALICE, recurrence={"type": 0})  # a task recurrence needs its start


# ── Meetings ──────────────────────────────────────────────────────────────


class MeetingTestCase(PimTestCase):
    def invite(self, login=ALICE, **fields):
        fields.setdefault("organizer", BOB)
        fields.setdefault("organizer_name", "Bob Test")
        fields.setdefault("subject", "Point d'équipe")
        fields.setdefault("start", self.start)
        fields.setdefault("end", self.end)
        return self.srv.deliver_invitation(login, **fields)

    def mailbox(self, client=None, folders=()):
        """Synchronize the Inbox (and other folders) of a ready client. -> {folder: key}"""
        return {f: self.drain(f, self.prime(f, client=client), client=client)[0] for f in (self.inbox, *folders)}


class InvitationTests(MeetingTestCase):
    def test_invitation_mail_for_each_version(self):
        inv = self.invite(uid="uid-équipe-1", location="Salle 3", body="Ordre du jour", timezone=PARIS, reminder=30,
                          recurrence={"type": 1, "interval": 1, "day_of_week": 4, "until": self.days(60),
                                      "first_day_of_week": 1})
        self.assertEqual((inv["uid"], inv["collection_id"]), ("uid-équipe-1", self.inbox))
        json.dumps(inv)
        view = self.srv.message(ALICE, self.inbox, inv["mail_id"])
        self.assertEqual((view["subject"], view["invitation"]["uid"], view["invitation"]["organizer_email"]),
                         ("Point d'équipe", "uid-équipe-1", BOB))
        # The MIME body: a text/calendar part whose method is REQUEST.
        self.assertIn(b"Content-Type: text/calendar; method=REQUEST", view["mime"])
        msg = email.message_from_bytes(view["mime"], policy=email.policy.default)
        self.assertEqual((str(msg["From"]), str(msg["To"])), (f"Bob Test <{BOB}>", f"Alice Test <{ALICE}>"))
        self.assertEqual([p.get_content_type() for p in msg.walk()],
                         ["multipart/alternative", "text/plain", "text/calendar"])
        ics = [p for p in msg.walk() if p.get_content_type() == "text/calendar"][0]
        self.assertEqual(ics.get_param("method"), "REQUEST")
        lines = ics.get_content().replace("\r\n ", "").split("\r\n")
        for wanted in ("BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:uid-équipe-1",
                       "DTSTART:" + compact(self.start), "DTEND:" + compact(self.end), "SUMMARY:Point d'équipe",
                       "LOCATION:Salle 3", "DESCRIPTION:Ordre du jour", f'ORGANIZER;CN="Bob Test":mailto:{BOB}',
                       "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=" + compact(self.days(60)) + ";WKST=MO",
                       "END:VEVENT", "END:VCALENDAR"):
            self.assertIn(wanted, lines)
        self.assertTrue(any(line.startswith("ATTENDEE;") and line.endswith(f":mailto:{ALICE}")
                            and "PARTSTAT=NEEDS-ACTION" in line and "RSVP=TRUE" in line for line in lines))
        self.assertTrue(all(len(line.encode("utf-8")) <= 75 for line in ics.get_content().split("\r\n")))
        for version in ("14.1", "14.0", "12.1"):
            with self.subTest(version):
                c = self.client(version)
                _, cmds = self.drain(self.inbox, self.prime(self.inbox, client=c), client=c)
                d = cmds[0][2]
                self.assertEqual(d.text("Email:MessageClass"), "IPM.Schedule.Meeting.Request")
                self.assertEqual(d.text("Email:ContentClass"), "urn:content-classes:calendarmessage")
                self.assertEqual(d.data("AirSyncBase:Body", "Data"), view["mime"])
                mr = d.child("Email:MeetingRequest")
                names = [c.name for c in mr.children]
                wanted = ["AllDayEvent", "StartTime", "DtStamp", "EndTime", "InstanceType", "Location", "Organizer",
                          "Reminder", "ResponseRequested", "Recurrences", "Sensitivity", "BusyStatus", "TimeZone",
                          "GlobalObjId"]
                wanted = [f"Email:{n}" for n in wanted]
                if version != "12.1":
                    wanted.append("Email:DisallowNewTimeProposal")  # [MS-ASEMAIL] 2.2.2.27: from 14.0
                if version == "14.1":
                    wanted.append("Email2:MeetingMessageType")  # [MS-ASEMAIL] 2.2.2.47: from 14.1
                self.assertEqual(names, wanted)  # the order of the schema
                self.assertEqual([mr.text(n) for n in ("AllDayEvent", "StartTime", "EndTime", "InstanceType",
                                                       "Location", "Organizer", "Reminder", "ResponseRequested")],
                                 ["0", long_date(self.start), long_date(self.end), "1", "Salle 3",
                                  f'"Bob Test" <{BOB}>', "1800", "1"])
                self.assertEqual(base64.b64decode(mr.text("TimeZone")), PARIS)
                self.assertEqual(uid_of_global_obj_id(mr.text("GlobalObjId")), "uid-équipe-1")
                self.assertEqual(base64.b64decode(mr.text("GlobalObjId")), global_obj_id("uid-équipe-1"))
                rec = mr.find("Recurrences", "Recurrence")
                self.assertEqual([rec.text(n) for n in ("Type", "Interval", "Until", "DayOfWeek")],
                                 ["1", "1", compact(self.days(60)), "4"])
                self.assertEqual(rec.text("Email2:FirstDayOfWeek"), "1" if version == "14.1" else None)
                self.assertEqual(mr.text("Email2:MeetingMessageType"), "1" if version == "14.1" else None)
        # A plain mail next to it keeps its class and has no MeetingRequest.
        self.srv.add_message(ALICE, self.inbox, subject="Simple")
        self.ready()
        _, cmds = self.drain(self.inbox, self.prime(self.inbox))
        plain = next(d for _, _, d in cmds if d.text("Email:Subject") == "Simple")
        self.assertEqual((plain.text("Email:MessageClass"), plain.child("Email:MeetingRequest")), ("IPM.Note", None))
        self.assertEqual(plain.text("Email:ContentClass"), "urn:content-classes:message")
        with self.assertRaises(ValueError):
            self.invite(organizer=ALICE)

    def test_calendar_copy_like_exchange(self):
        inv = self.invite(uid="uid-copie", location="Salle 3")
        self.assertTrue(inv["calendar_id"].startswith(self.cal + ":"))
        got = self.srv.event(ALICE, self.cal, inv["calendar_id"])
        self.assertEqual((got["uid"], got["subject"], got["organizer_email"], got["meeting_status"],
                          got["response_type"], got["busy_status"], got["response_requested"], got["reply_time"]),
                         ("uid-copie", "Point d'équipe", BOB, 3, 5, 1, True, None))
        self.assertEqual([a["email"] for a in got["attendees"]], [ALICE])
        for version in ("14.1", "12.1"):
            _, items = self.open(self.cal, self.client(version))
            d = items[inv["calendar_id"]]
            self.assertEqual((d.text("Calendar:MeetingStatus"), d.text("Calendar:BusyStatus")), ("3", "1"))
            # [MS-ASCMD] 4.16.4.2: not answered yet is ResponseType 5, which exists from 14.0.
            self.assertEqual(d.text("Calendar:ResponseType"), "5" if version == "14.1" else None)
        # An update of the invitation refreshes the same calendar item.
        again = self.invite(uid="uid-copie", location="Salle 4", start=self.days(1), end=self.days(1, 1), sequence=1)
        self.assertEqual(again["calendar_id"], inv["calendar_id"])
        got = self.srv.event(ALICE, self.cal, inv["calendar_id"])
        self.assertEqual((got["location"], got["version"]), ("Salle 4", 2))
        self.assertEqual(len(self.srv.find_events(ALICE, uid="uid-copie")), 1)
        # The other kind of server: nothing in the calendar until the user answers.
        self.srv.set_option("invitation_in_calendar", False)
        alone = self.invite(uid="uid-seule")
        self.assertIsNone(alone["calendar_id"])
        self.assertEqual(self.srv.find_events(ALICE, uid="uid-seule"), [])


class MeetingResponseTests(MeetingTestCase):
    def test_accept_tentative_decline_on_the_mail(self):
        for version in ("14.1", "14.0", "12.1"):
            with self.subTest(version):
                c = self.client(version)
                invs = [self.invite(uid=f"uid-{version}-{n}") for n in range(3)]
                keys = self.mailbox(c, [self.trash, self.cal])
                since = self.srv.last_seq()
                resp, results, top, _ = c.meeting_response((1, self.inbox, invs[0]["mail_id"]),
                                                           (2, self.inbox, invs[1]["mail_id"]),
                                                           (3, self.inbox, invs[2]["mail_id"]))
                self.assertEqual((resp.status, top), (200, None))
                self.assertEqual(results, [(invs[0]["mail_id"], "1", invs[0]["calendar_id"]),
                                           (invs[1]["mail_id"], "1", invs[1]["calendar_id"]),
                                           (invs[2]["mail_id"], "1", None)])  # declined: no CalendarId
                accepted = self.srv.event(ALICE, self.cal, invs[0]["calendar_id"])
                self.assertEqual((accepted["response_type"], accepted["busy_status"]), (3, 2))
                self.assertGreaterEqual(accepted["reply_time"], self.now.strftime("%Y-%m-%dT%H:%M:%SZ"))
                tentative = self.srv.event(ALICE, self.cal, invs[1]["calendar_id"])
                self.assertEqual((tentative["response_type"], tentative["busy_status"]), (2, 1))
                self.assertIsNone(self.srv.event(ALICE, self.cal, invs[2]["calendar_id"]))  # declined: removed
                # The answered invitations left the Inbox for Deleted Items.
                self.assertEqual(self.srv.messages(ALICE, self.inbox), [])
                self.assertEqual(len(self.srv.messages(ALICE, self.trash)), 3)
                _, cmds = self.drain(self.inbox, keys[self.inbox], client=c)
                self.assertEqual(sorted((op, sid) for op, sid, _ in cmds),
                                 sorted(("Delete", i["mail_id"]) for i in invs))
                _, cmds = self.drain(self.trash, keys[self.trash], client=c)
                self.assertEqual([op for op, _, _ in cmds], ["Add"] * 3)
                _, cmds = self.drain(self.cal, keys[self.cal], client=c)
                self.assertEqual(sorted((op, sid) for op, sid, _ in cmds), sorted([
                    ("Change", invs[0]["calendar_id"]), ("Change", invs[1]["calendar_id"]),
                    ("Delete", invs[2]["calendar_id"])]))
                if version != "12.1":
                    changed = {sid: d for op, sid, d in cmds if op == "Change"}
                    self.assertEqual(changed[invs[0]["calendar_id"]].text("Calendar:ResponseType"), "3")
                    self.assertRegex(changed[invs[0]["calendar_id"]].text("Calendar:AppointmentReplyTime"), COMPACT)
                # What the scenario reads: who, which meeting, which answer.
                seen = self.srv.meeting_responses(ALICE, since=since)
                self.assertEqual([(m["user"], m["device"], m["uid"], m["answer"], m["response"], m["source"],
                                   m["organizer"], m["status"], m["calendar_id"]) for m in seen], [
                    (ALICE, c.device_id, f"uid-{version}-0", "accepted", 1, "mail", BOB, "1", invs[0]["calendar_id"]),
                    (ALICE, c.device_id, f"uid-{version}-1", "tentative", 2, "mail", BOB, "1", invs[1]["calendar_id"]),
                    (ALICE, c.device_id, f"uid-{version}-2", "declined", 3, "mail", BOB, "1", None)])
                json.dumps(seen)
                self.assertEqual([a["answer"] for a in self.srv.actions("meeting_response", since=since)],
                                 ["accepted", "tentative", "declined"])
                self.srv.mass_delete(ALICE, self.trash)
        self.assertEqual(self.errors(), [])

    def test_answer_creates_the_calendar_item_without_the_copy(self):
        self.srv.set_option("invitation_in_calendar", False)
        self.srv.set_option("invitation_after_response", "removed")
        inv = self.invite(uid="uid-sans-copie", location="Salle 3", timezone=PARIS)
        other = self.invite(uid="uid-refus")
        self.ready()
        self.mailbox()
        _, results, _, _ = self.c.meeting_response((2, self.inbox, inv["mail_id"]), (3, self.inbox, other["mail_id"]))
        calendar_id = results[0][2]
        self.assertEqual(results, [(inv["mail_id"], "1", calendar_id), (other["mail_id"], "1", None)])
        got = self.srv.event(ALICE, self.cal, calendar_id)
        self.assertEqual((got["uid"], got["location"], got["meeting_status"], got["response_type"],
                          got["busy_status"], got["organizer_email"], base64.b64decode(got["timezone"])),
                         ("uid-sans-copie", "Salle 3", 3, 2, 1, BOB, PARIS))
        self.assertEqual(self.srv.find_events(ALICE, uid="uid-refus"), [])
        self.assertEqual((self.srv.messages(ALICE, self.inbox), self.srv.messages(ALICE, self.trash)), ([], []))
        # "kept": the answered mail stays where it is, and can be answered again.
        self.srv.set_option("invitation_after_response", "kept")
        kept = self.invite(uid="uid-gardée")
        self.drain(self.inbox, self.prime(self.inbox))
        for answer in (1, 3):
            self.assertEqual(self.c.meeting_response((answer, self.inbox, kept["mail_id"]))[1][0][1], "1")
        self.assertEqual(len(self.srv.messages(ALICE, self.inbox)), 1)
        self.assertEqual(self.srv.find_events(ALICE, uid="uid-gardée"), [])

    def test_on_the_calendar_item_with_14_1_only(self):
        inv = self.invite(uid="uid-agenda")
        c = self.client("14.1")
        self.mailbox(c, [self.cal])
        _, results, _, _ = c.meeting_response((1, self.cal, inv["calendar_id"]))
        self.assertEqual(results, [(inv["calendar_id"], "1", inv["calendar_id"])])
        self.assertEqual(self.srv.event(ALICE, self.cal, inv["calendar_id"])["response_type"], 3)
        self.assertEqual(self.srv.messages(ALICE, self.inbox), [])  # the invitation of that meeting left the Inbox
        self.assertEqual(self.srv.meeting_responses()[-1]["source"], "calendar")
        _, results, _, _ = c.meeting_response((3, self.cal, inv["calendar_id"]))
        self.assertEqual(results, [(inv["calendar_id"], "1", None)])
        self.assertIsNone(self.srv.event(ALICE, self.cal, inv["calendar_id"]))
        self.assertEqual(self.errors(), [])
        # [MS-ASCMD] 2.2.1.11: up to 14.0, not on an item of the Calendar folder.
        for version in ("14.0", "12.1"):
            other = self.invite(uid=f"uid-agenda-{version}")
            old = self.client(version)
            self.mailbox(old, [self.cal])
            known = len(self.errors())
            _, results, _, _ = old.meeting_response((1, self.cal, other["calendar_id"]))
            self.assertEqual(results, [(other["calendar_id"], "2", None)])
            self.assertEqual(self.srv.event(ALICE, self.cal, other["calendar_id"])["response_type"], 5)
            self.assertEqual(len(self.errors()), known + 1)
            # InstanceId does not exist before 14.1 either ([MS-ASCMD] 2.2.3.92.1).
            _, results, _, _ = old.meeting_response((1, self.inbox, other["mail_id"], long_date(self.start)))
            self.assertEqual(results[0][1], "2")
            self.assertEqual(len(self.errors()), known + 2)

    def test_instance_id(self):
        series = self.invite(uid="uid-série", recurrence={"type": 0, "interval": 1, "until": self.days(30)})
        single = self.invite(uid="uid-unique")
        mine = self.srv.add_event(ALICE, subject="La mienne", start=self.start, end=self.end,
                                  attendees=[{"email": BOB, "name": "Bob"}], recurrence={"type": 0})
        c = self.client("14.1")
        self.mailbox(c, [self.cal])
        third = long_date(self.days(2))

        def status(*request):
            return c.meeting_response(request)[1][0][1:]

        self.assertEqual(status(1, self.cal, series["calendar_id"], third), ("1", series["calendar_id"]))
        got = self.srv.event(ALICE, self.cal, series["calendar_id"])
        self.assertEqual([(x["exception_start"], x["response_type"], x["deleted"]) for x in got["exceptions"]],
                         [(self.days(2).strftime("%Y-%m-%dT%H:%M:%SZ"), 3, False)])
        self.assertEqual(got["response_type"], 5)  # the series itself is still not answered
        self.assertEqual(len(self.srv.messages(ALICE, self.inbox)), 2)  # and its invitation stays
        self.assertEqual(self.srv.meeting_responses()[-1]["instance_id"], third)
        _, items = self.open(self.cal, c)
        exception = items[series["calendar_id"]].find("Calendar:Exceptions", "Exception")
        self.assertEqual((exception.text("ResponseType"), exception.text("ExceptionStartTime")),
                         ("3", compact(self.days(2))))
        self.assertRegex(exception.text("AppointmentReplyTime"), COMPACT)
        # A declined occurrence is removed from the series; it cannot be answered again.
        self.assertEqual(status(3, self.cal, series["calendar_id"], third), ("1", None))
        self.assertEqual([x["deleted"] for x in self.srv.event(ALICE, self.cal, series["calendar_id"])["exceptions"]],
                         [True])
        self.assertEqual(status(1, self.cal, series["calendar_id"], third), ("2", None))
        self.assertEqual(status(1, self.cal, series["calendar_id"], long_date(self.days(-3))), ("2", None))
        self.assertEqual(status(1, self.cal, series["calendar_id"], long_date(self.days(40))), ("2", None))
        self.assertEqual(status(1, self.cal, single["calendar_id"], third), ("146", None))  # no recurrence
        self.assertEqual(status(1, self.cal, series["calendar_id"], "2027-13-45T99:00:00.000Z"), ("104", None))
        self.assertEqual(status(1, self.inbox, series["mail_id"], third), ("2", None))  # on the mail: invalid
        self.assertEqual(status(1, self.cal, mine, third), ("2", None))  # the user is the organizer
        self.assertEqual(self.errors(), [])
        self.assertEqual(status(1, self.cal, series["calendar_id"], compact(self.days(2))), ("2", None))
        self.assertEqual(len(self.errors()), 1)  # 16 characters where the schema wants 24

    def test_refusals(self):
        inv = self.invite(uid="uid-refus")
        plain = self.srv.add_message(ALICE, self.inbox, subject="Simple")
        delegated = self.invite(uid="uid-déléguée", message_type=6)
        mine = self.srv.add_event(ALICE, subject="La mienne", attendees=[{"email": BOB, "name": "Bob"}])
        alone = self.srv.add_event(ALICE, subject="Rendez-vous")
        archive = self.srv.add_folder(ALICE, "Archives")
        filed = self.srv.move_message(ALICE, self.inbox, self.invite(uid="uid-classée")["mail_id"], archive)
        self.ready()
        self.mailbox(folders=[self.cal])

        def answer(*request):
            return self.c.meeting_response(request)[1][0]

        def raw(children):
            _, doc = self.c.command("MeetingResponse", el("MeetingResponse:MeetingResponse", [el("Request", children)]))
            return [(r.text("RequestId"), r.text("Status")) for r in doc.children_named("Result")]

        # Status 2 without a protocol error: the request is well formed, the item is not a meeting to answer.
        self.assertEqual(answer(1, self.inbox, self.inbox + ":999"), (self.inbox + ":999", "2", None))
        self.assertEqual(answer(1, "999", inv["mail_id"])[1], "2")
        self.assertEqual(answer(1, self.inbox, plain)[1], "2")
        self.assertEqual(answer(1, self.cal, alone)[1], "2")
        self.assertEqual(answer(1, self.cal, mine)[1], "2")  # the user is the organizer
        self.assertEqual(self.errors(), [])
        # Status 2 with a protocol error: what a client must not send.
        self.assertEqual(answer(1, archive, filed)[1], "2")  # a folder this device does not synchronize
        self.assertEqual(answer(4, self.inbox, inv["mail_id"])[1], "2")
        self.assertEqual(answer(1, self.inbox, delegated["mail_id"])[1], "2")  # MeetingMessageType 6
        self.assertEqual(raw([el("CollectionId", self.inbox), el("RequestId", inv["mail_id"])]),
                         [(inv["mail_id"], "2")])
        self.assertEqual(raw([el("UserResponse", "1"), el("RequestId", inv["mail_id"])]), [(inv["mail_id"], "2")])
        self.assertEqual(raw([el("UserResponse", "1"), el("CollectionId", self.inbox)]), [(None, "2")])
        self.assertEqual(raw([el("UserResponse", "1"), el("Search:LongId", "abc")]), [(None, "2")])
        self.assertEqual(raw([el("UserResponse", "1"), el("CollectionId", self.inbox),
                              el("RequestId", inv["mail_id"]), el("SendResponse")]), [(inv["mail_id"], "2")])
        self.assertEqual(raw([el("UserResponse", "1"), el("UserResponse", "1"), el("CollectionId", self.inbox),
                              el("RequestId", inv["mail_id"])]), [(inv["mail_id"], "2")])
        self.assertEqual(len(self.errors()), 9)
        # Nothing was answered, nothing moved.
        self.assertEqual(self.srv.event(ALICE, self.cal, inv["calendar_id"])["response_type"], 5)
        self.assertEqual(len(self.srv.messages(ALICE, self.inbox)), 3)
        self.assertEqual({m["status"] for m in self.srv.meeting_responses()}, {"2"})
        # Statuses 3 and 4 (errors of the server), on request; then the same answer works.
        for code in (3, "4"):
            self.srv.set_option("fail_next_meeting_response", code)
            self.assertEqual(answer(1, self.inbox, inv["mail_id"]), (inv["mail_id"], str(code), None))
            self.assertIsNone(self.srv.options.fail_next_meeting_response)
        self.assertEqual(answer(1, self.inbox, inv["mail_id"]), (inv["mail_id"], "1", inv["calendar_id"]))
        self.assertEqual(answer(1, self.inbox, inv["mail_id"])[1], "2")  # the mail is not in the Inbox any more

    def test_request_limits(self):
        inv = self.invite(uid="uid-limite")
        self.ready()
        self.mailbox()
        one = (1, self.inbox, inv["mail_id"])
        # [MS-ASCMD] 3.1.5.10: at most 100 Request elements; beyond, Status 103 (an HTTP 400 up to 12.1).
        resp, results, top, _ = self.c.meeting_response(*[one] * 101)
        self.assertEqual((resp.status, results, top), (200, [], "103"))
        self.assertEqual(self.srv.meeting_responses(), [])
        resp, results, top, _ = self.c.meeting_response()
        self.assertEqual((results, top), ([], "103"))
        _, doc = self.c.command("MeetingResponse", el("MeetingResponse:MeetingResponse", [el("Result")]))
        self.assertEqual(doc.text("Status"), "103")
        old = self.client("12.1")
        self.drain(self.inbox, self.prime(self.inbox, client=old), client=old)
        self.assertEqual(old.meeting_response(*[one] * 101)[0].status, 400)
        self.assertEqual(len(self.errors()), 4)
        resp, results, top, _ = self.c.meeting_response(*[one] * 100)
        self.assertEqual(([r[1] for r in results[:2]], len(results), top), (["1", "2"], 100, None))
        self.srv.set_option("max_meeting_responses", 1)
        self.assertEqual(self.c.meeting_response(one, one)[2], "103")


# ── SendMail: calendar parts ──────────────────────────────────────────────


class SendMailCalendarTests(ServerTestCase):
    def meeting_mime(self, method, subject, uid, to, cc=None, bcc=None):
        ics = ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//FR\r\n"
               f"METHOD:{method}\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nSUMMARY:{subject}\r\n"
               "DTSTART:20270301T090000Z\r\nDTEND:20270301T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
        msg = email.message.EmailMessage(policy=email.policy.SMTP)
        msg["From"] = f"Alice Test <{ALICE}>"
        msg["To"] = to
        if cc:
            msg["Cc"] = cc
        if bcc:
            msg["Bcc"] = bcc
        msg["Subject"] = subject
        msg.set_content("Vous êtes invité.\r\n")
        msg.add_alternative(ics, subtype="calendar", charset="utf-8", cte="base64", params={"method": method})
        return msg.as_bytes(), ics

    def send(self, client_id, mime):
        resp, doc = self.c.command("SendMail", el("ComposeMail:SendMail", [
            el("ClientId", client_id), el("SaveInSentItems"), el("Mime", mime)]))
        return doc.text("Status") if doc is not None else None

    def test_calendar_parts_of_what_was_sent(self):
        self.ready()
        request, ics_request = self.meeting_mime("REQUEST", "Réunion d'été", "uid-1", f"Bob Test <{BOB}>, x@example.org",
                                                 cc="Carol <carol@example.org>", bcc="cache@example.org")
        cancel, ics_cancel = self.meeting_mime("CANCEL", "Annulé : Réunion d'été", "uid-1", BOB)
        self.assertIsNone(self.send("m1", request))
        self.assertIsNone(self.send("m2", make_mime("Sans agenda", ALICE, BOB)))
        self.assertIsNone(self.send("m3", cancel))
        self.assertEqual(self.send("m3", cancel), "118")  # refused: not sent, not listed
        parts = self.srv.sent_calendar_parts(ALICE)
        self.assertEqual([(p["client_id"], p["subject"], p["to"], p["cc"], p["bcc"]) for p in parts], [
            ("m1", "Réunion d'été", [BOB, "x@example.org"], ["carol@example.org"], ["cache@example.org"]),
            ("m3", "Annulé : Réunion d'été", [BOB], [], [])])
        self.assertEqual(parts[0]["parts"], [{"method": "REQUEST", "text": ics_request}])
        self.assertEqual(parts[1]["parts"], [{"method": "CANCEL", "text": ics_cancel}])
        self.assertEqual((parts[0]["user"], parts[0]["sender"]), (ALICE, f"Alice Test <{ALICE}>"))
        json.dumps(parts)
        self.assertEqual(self.srv.sent_calendar_parts(BOB), [])
        self.assertEqual([p["client_id"] for p in self.srv.sent_calendar_parts(since=parts[0]["seq"])], ["m3"])
        # Delivered to the other user of the server like any mail: the same message, nothing more.
        got = {m["subject"]: m for m in self.srv.messages(BOB, FolderType.INBOX)}
        self.assertEqual(sorted(got), ["Annulé : Réunion d'été", "Réunion d'été", "Sans agenda"])
        delivered = got["Réunion d'été"]["mime"]
        self.assertNotIn(b"cache@example.org", delivered)
        back = email.message_from_bytes(delivered, policy=email.policy.default)
        part = [p for p in back.walk() if p.get_content_type() == "text/calendar"][0]
        self.assertEqual((part.get_param("method"), part.get_content()), ("REQUEST", ics_request))
        self.assertNotIn("invitation", got["Réunion d'été"])  # a plain mail: only deliver_invitation makes invitations
        bob = MiniEasClient(self.srv, BOB, "bob-pw", device_id="BobPhone")
        self.ready(bob)
        bob_inbox = self.srv.folder_id(BOB, FolderType.INBOX)
        _, cmds = self.drain(bob_inbox, self.prime(bob_inbox, client=bob), client=bob)
        self.assertEqual({d.text("Email:MessageClass") for _, _, d in cmds}, {"IPM.Note"})
        self.assertEqual(len(self.srv.events(BOB)), 1)  # the sample only: nothing was put in Bob's calendar
        self.assertEqual(self.srv.protocol_errors(), [])


# ── Protocol versions offered ─────────────────────────────────────────────


class OnlyVersion140Tests(MeetingTestCase):
    options = {"versions": ("14.0",)}

    def test_behaves_as_14_0(self):
        self.assertEqual(self.c.options().header("ms-asprotocolversions"), "14.0")
        resp, _ = self.c.command("FolderSync", el("FolderHierarchy:FolderSync", [el("SyncKey", "0")]))
        self.assertEqual(resp.status, 400)  # 14.1 is not offered
        resp, _ = self.c.command("FolderSync", el("FolderHierarchy:FolderSync", [el("SyncKey", "0")]),
                                 version="12.1")
        self.assertEqual(resp.status, 400)  # nor 12.1
        c = self.client("14.0")
        sid = self.srv.add_event(ALICE, subject="Hebdo", attendees=[{"email": BOB, "name": "Bob"}],
                                 response_requested=True,
                                 recurrence={"type": 2, "day_of_month": 3, "first_day_of_week": 1})
        inv = self.invite(uid="uid-140")
        keys = self.mailbox(c, [self.cal])
        _, items = self.open(self.cal, c)
        rec = items[sid].child("Calendar:Recurrence")
        self.assertEqual((rec.text("CalendarType"), rec.child("FirstDayOfWeek")), ("0", None))
        self.assertEqual((items[sid].text("Calendar:ResponseType"), items[sid].text("Calendar:ResponseRequested")),
                         ("1", "1"))
        _, cmds = self.drain(self.inbox, self.prime(self.inbox, client=c), client=c)
        mr = cmds[0][2].child("Email:MeetingRequest")
        self.assertEqual((mr.text("DisallowNewTimeProposal"), mr.child("Email2:MeetingMessageType")), ("0", None))
        self.assertEqual(c.meeting_response((1, self.cal, inv["calendar_id"]))[1][0][1], "2")
        self.assertEqual(c.meeting_response((1, self.inbox, inv["mail_id"]))[1],
                         [(inv["mail_id"], "1", inv["calendar_id"])])
        self.assertEqual(c.meeting_response(*[(1, self.inbox, inv["mail_id"])] * 101)[2], "103")


class OnlyVersion121Tests(MeetingTestCase):
    options = {"versions": ("12.1",)}

    def test_behaves_as_12_1(self):
        self.assertEqual(self.c.options().header("ms-asprotocolversions"), "12.1")
        c = MiniEasClient(self.srv, ALICE, "alice-pw", device_id="Old121", version="12.1")
        resp, _ = c.command("FolderSync", el("FolderHierarchy:FolderSync", [el("SyncKey", "0")]))
        self.assertEqual(resp.status, 449)  # not provisioned: an HTTP status in 12.1
        self.ready(c)
        sid = self.srv.add_event(ALICE, subject="Hebdo", attendees=[{"email": BOB, "name": "Bob"}],
                                 response_requested=True, recurrence={"type": 2, "day_of_month": 3})
        inv = self.invite(uid="uid-121")
        _, items = self.open(self.cal, c, supported=calendar_supported("12.1"))
        d = items[sid]
        self.assertEqual([d.child(f"Calendar:{n}") for n in ("ResponseType", "ResponseRequested",
                                                             "AppointmentReplyTime", "DisallowNewTimeProposal")],
                         [None] * 4)
        self.assertIsNone(d.child("Calendar:Recurrence").child("CalendarType"))
        self.assertEqual(d.find("Calendar:Attendees", "Attendee").text("Email"), BOB)
        _, cmds = self.drain(self.inbox, self.prime(self.inbox, client=c), client=c)
        mr = cmds[0][2].child("Email:MeetingRequest")
        self.assertEqual((mr.child("DisallowNewTimeProposal"), mr.child("Email2:MeetingMessageType")), (None, None))
        self.assertEqual(uid_of_global_obj_id(mr.text("GlobalObjId")), "uid-121")
        self.assertEqual(c.meeting_response((1, self.inbox, inv["mail_id"]))[1],
                         [(inv["mail_id"], "1", inv["calendar_id"])])
        self.assertEqual(self.srv.event(ALICE, self.cal, inv["calendar_id"])["response_type"], 3)
        sid, status, r = c.add_item(self.cal, self.state(c, self.cal)["key"], event_data(
            StartTime=self.start, EndTime=self.end, Subject="12.1", Attendees=[
                {"Email": BOB, "Name": "Bob", "AttendeeStatus": 0, "AttendeeType": 1}], MeetingStatus=1))
        self.assertEqual(status, "1")
        self.assertEqual(self.srv.protocol_errors(), [])
        resp, _ = MiniEasClient(self.srv, ALICE, "alice-pw", device_id="New141").command(
            "FolderSync", el("FolderHierarchy:FolderSync", [el("SyncKey", "0")]))
        self.assertEqual(resp.status, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
