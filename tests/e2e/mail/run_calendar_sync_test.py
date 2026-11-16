# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""End-to-end test of Sync443's calendar, tasks and meetings, in a real,
headless Thunderbird, against the strict mock ActiveSync server (mock_eas.py).

    python3 -I tests/e2e/mail/run_calendar_sync_test.py [--keep] [--log] [--steps=4,5] [--phases=1,2]

A sibling of run_mail_test.py, whose machinery it reuses (the same test
build of the extension, the same fake server, the same requests from the
scenario to the runner, the same PASS/FAIL report): the mail runner and its
counts stay as they are, and the calendar scenario runs alone, on a profile
and servers of its own. Run both to cover everything.

  --keep     keep the work directory (profile, test package, logs)
  --log      print the extension's log and Thunderbird's output
  --steps    run only these steps of the scenario (1 to 9, see
             calendar-scenario.mjs; the setup always runs): for debugging.
             Steps 8 (restart) and 9 (removal of a mailbox) need phase 2
  --phases   run only these phases (phase 2 needs phase 1)
  --trace    print the timeline of the requests the main server received
  --no-debug-log
             the extension logs at its usual level (by default it logs at
             debug level, so that the search of its log for personal content
             covers what debugging shows too)
  --src=DIR  test another source tree instead of src/

Windows, macOS, Linux; Python 3.8+ standard library only.
  THUNDERBIRD   path of the Thunderbird executable (otherwise looked for in
                the usual places of each OS, as tests/e2e/net does)
  On Linux with Thunderbird as a snap, set TMPDIR to a directory in your home:
  the snap cannot see the system's /tmp.

What it does, all in a throw-away directory (never your Thunderbird profile):
  1. starts two mock ActiveSync servers over TLS, under the same test
     authority (trusted by the profile and pinned by the mailboxes): the main
     one (ActiveSync 12.1 to 14.1, two users) and one that only speaks 12.1
     (one user);
  2. builds a TEST package of the extension as run_mail_test.py does, plus
     the calendar scenario (calendar-scenario.mjs) and the privileged helper
     of the calendar module's own test (tests/e2e/calendar/extension/
     experiments/sync443CalendarTest), which acts on Thunderbird's calendars
     through Thunderbird's own interfaces;
  3. runs Thunderbird twice on the same profile (phases 1 and 2 of
     calendar-scenario.mjs), answering the scenario's requests by driving the
     mock servers between its steps;
  4. checks, from the outside: the mock servers' protocol and internal errors
     (a calendar item, a task, a MeetingResponse or a SendMail a real server
     would refuse fails here), that every request came over TLS, the console
     errors of the extension, and, once Thunderbird is stopped, the profile's
     files (prefs.js and the calendar databases after the removal of a
     mailbox).

Prints a PASS/FAIL/SKIP list (and GAP: behaviour this version does not
implement); exit status 1 on any FAIL.
"""

import base64
import email
import email.policy
import json
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
sys.dont_write_bytecode = True
for _p in (str(HERE), str(HERE.parent / "net")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# The mail runner's machinery: servers, test package, phases, requests of the scenario, report.
import run_mail_test as mail  # noqa: E402
import run_net_test as net  # noqa: E402
from mock_eas import MockEasServer  # noqa: E402

HELPER = HERE.parent / "calendar" / "extension" / "experiments" / "sync443CalendarTest"
PHASE_TIMEOUT_S = {1: 2400, 2: 600}
ALICE, BOB = mail.ALICE, mail.BOB
CAROL = ("carol@example.test", "carol-mot-de-passe")
CAROL_BIS = ("carol-bis", "carol-bis-mot-de-passe")  # another sign-in name on the 12.1 server, for the same address
TEST_FILES = mail.TEST_FILES + ("calendar-scenario.mjs", "sync443CalendarTest")

# A fixed default zone, so that the scenario does not depend on the machine;
# no reminder window in a profile nobody looks at.
USER_JS = mail.USER_JS + """
user_pref("calendar.timezone.useSystemTimezone", false);
user_pref("calendar.timezone.local", "Europe/Paris");
user_pref("calendar.alarms.show", false);
user_pref("calendar.alarms.playsound", false);
user_pref("calendar.alarms.showmissed", false);
"""

# What Thunderbird writes in its console when its calendar manager was asked for its calendars before the
# main window loaded its calendar part.
EARLY_CALENDARS = "Calendar manager initialised calendars before loadCalendarComponent"

check, skip = mail.check, mail.skip


def customize(pkg, manifest):
    """The calendar scenario and the helper that acts on Thunderbird's calendars, added to the mail test package."""
    shutil.copy2(HERE / "calendar-scenario.mjs", pkg / "calendar-scenario.mjs")
    shutil.copytree(HELPER, pkg / "experiments" / "sync443CalendarTest")
    manifest["experiment_apis"]["sync443CalendarTest"] = {
        "schema": "experiments/sync443CalendarTest/schema.json",
        "parent": {"scopes": ["addon_parent"], "paths": [["sync443CalendarTest"]],
                   "script": "experiments/sync443CalendarTest/implementation.js"},
    }


def mime_texts(mime):
    """Every text a message holds, decoded: its headers and its parts."""
    out = []
    try:
        msg = email.message_from_bytes(mime or b"", policy=email.policy.default)
        for part in msg.walk():
            out.extend(f"{k}: {v}" for k, v in part.items())
            if not part.is_multipart():
                try:
                    out.append(str(part.get_content()))
                except Exception:  # noqa: BLE001 - a part that cannot be decoded is searched as bytes below
                    pass
    except Exception:  # noqa: BLE001
        pass
    out.append((mime or b"").decode("utf-8", "replace"))
    return out


def leaks(servers, needles):
    """Where any of these texts reached a server: in a stored event or task, in a sent message, in a request."""
    hits = []

    def search(where, text):
        for needle in needles:
            if needle and needle in text:
                hits.append(f"{where} : {needle}")

    for name, srv in servers.items():
        for user in srv.users():
            login = user["login"]
            for folder in srv.folders(login):
                if folder["type"] in (8, 13):
                    for item in srv.events(login, folder["server_id"]):
                        search(f"{name}, événement de {login}", json.dumps(item, ensure_ascii=False, default=str))
                elif folder["type"] in (7, 15):
                    for item in srv.tasks(login, folder["server_id"]):
                        search(f"{name}, tâche de {login}", json.dumps(item, ensure_ascii=False, default=str))
        for sent in srv.sent_mails():
            for text in mime_texts(sent.get("mime")):
                search(f"{name}, message envoyé par {sent.get('user')}", text)
        search(f"{name}, requêtes reçues", srv.transcript(since=0, max_value=100000))
    return sorted(set(hits))


def sent_raw(srv, login, since):
    """Accepted SendMail messages as written: the To header itself, and the plain-text part."""
    out = []
    for m in srv.sent_mails(login):
        if m["seq"] <= since or m["status"] != "1":
            continue
        msg = email.message_from_bytes(m.get("mime") or b"", policy=email.policy.default)
        text = next((str(p.get_content()) for p in msg.walk() if p.get_content_type() == "text/plain"), "")
        out.append({"seq": m["seq"], "to": str(msg.get("To", "")), "text": text})
    return out


class Rpc(mail.Rpc):
    """The mail runner's requests, and those only the calendar scenario makes."""

    def handle(self, data):
        op = data.get("op")
        if op == "leaks":
            return leaks(self.servers, [str(n) for n in data.get("needles", [])])
        if op == "sent_raw":
            return sent_raw(self.servers[data.get("server") or "main"], data.get("login"), data.get("since", 0))
        if op == "protocol_errors":
            return self.servers[data.get("server") or "main"].protocol_errors()
        return super().handle(data)


def rows_of(database, calendar_ids):
    """{table: rows} of these calendars in a calendar database of Thunderbird (None if there is no such file)."""
    if not database.is_file():
        return None
    out = {}
    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    try:
        tables = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cal\\_%' ESCAPE '\\'")]
        marks = ",".join("?" for _ in calendar_ids)
        for table in tables:
            columns = [row[1] for row in connection.execute(f"PRAGMA table_info({table})")]
            if "cal_id" in columns and calendar_ids:
                out[table] = connection.execute(f"SELECT COUNT(*) FROM {table} WHERE cal_id IN ({marks})",
                                                list(calendar_ids)).fetchone()[0]
    finally:
        connection.close()
    return out


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    keep = "--keep" in sys.argv
    show_log = "--log" in sys.argv
    trace = "--trace" in sys.argv
    debug_log = "--no-debug-log" not in sys.argv
    wanted_phases = (1, 2)
    wanted_steps = None
    src = ROOT / "src"
    for arg in sys.argv[1:]:
        if arg.startswith("--src="):
            src = Path(arg.split("=", 1)[1]).resolve()
            if not (src / "manifest.json").is_file():
                sys.exit(f"--src : pas de manifest.json dans {src}")
        elif arg.startswith("--phases="):
            wanted_phases = tuple(int(x) for x in arg.split("=", 1)[1].split(",") if x)
        elif arg.startswith("--steps="):
            wanted_steps = [int(x) for x in arg.split("=", 1)[1].split(",") if x]
    started = time.time()
    thunderbird = net.find_thunderbird()
    work = Path(tempfile.mkdtemp(prefix="sync443-calendar-sync-e2e-"))
    servers = {}
    phases = {}
    durations = {}
    phase_marks = {}
    try:
        # 1. Servers: the main one, and one that only speaks ActiveSync 12.1 (same test authority).
        main_srv = MockEasServer().start()
        old_srv = MockEasServer(versions=("12.1",), server_version_header="12.1").start()
        servers.update(main=main_srv, old=old_srv)
        main_srv.add_user(ALICE[0], ALICE[1], display_name="Alice Test", pim_samples=False)
        main_srv.add_user(BOB[0], BOB[1], display_name="Bob Test", pim_samples=False)
        old_srv.add_user(CAROL[0], CAROL[1], display_name="Carol Test", pim_samples=False)
        old_srv.add_user(CAROL_BIS[0], CAROL_BIS[1], email_address=CAROL[0], display_name="Carol Test", pim_samples=False)
        config = {
            "allowLocal": True,
            "scenario": True,
            "pins": [main_srv.ca_sha256],
            "e2e": {
                "suite": "calendar",
                "port": main_srv.port,
                "oldPort": old_srv.port,
                "caBase64": base64.b64encode(main_srv.ca_der).decode("ascii"),
                "caSha256": main_srv.ca_sha256,
                "debugLog": debug_log,
                "alice": {"login": ALICE[0], "password": ALICE[1]},
                "bob": {"login": BOB[0], "password": BOB[1]},
                "carol": {"login": CAROL[0], "password": CAROL[1]},
                "carolBis": {"login": CAROL_BIS[0], "password": CAROL_BIS[1]},
            },
        }

        # 2. Test package, throw-away profile.
        profile = work / "profile"
        (profile / "extensions").mkdir(parents=True)
        xpi = mail.build_test_package(work, config, src, customize)
        shutil.copy2(xpi, profile / "extensions" / xpi.name)
        net.write_text(profile / "user.js", USER_JS)
        log_path = work / "thunderbird.log"
        release = mail.release_package_files()
        leaked = [n for n in release if any(t in n for t in TEST_FILES)]
        release_manifest = json.loads((ROOT / "src" / "manifest.json").read_text(encoding="utf-8"))
        check(not leaked and "sync443CalendarTest" not in release_manifest.get("experiment_apis", {})
              and "sync443MailTest" not in release_manifest.get("experiment_apis", {}),
              "paquet publié (tools/build_xpi.py) : aucun fichier de test, aucune API de test", leaked)
        rpc = Rpc(profile, servers)

        # 3. Phases.
        extra = {"steps": wanted_steps} if wanted_steps else {}
        for phase in wanted_phases:
            if phase > 1 and not phases.get(phase - 1, (None, False))[1]:
                skip(f"phase {phase}", f"la phase {phase - 1} n'a pas abouti")
                continue
            phase_marks[phase] = (main_srv.last_seq(), time.time())
            text, done, seconds = mail.run_phase(thunderbird, profile, phase, extra, rpc, log_path,
                                                 timeout=PHASE_TIMEOUT_S[phase])
            lines = mail.parse(text)
            phases[phase] = (lines, done)
            durations[phase] = seconds
            mail.collect(lines, phase, done, seconds)
            if phase == 1:
                extra = dict(extra, previous=mail.info_of(lines, "forNextPhase"))
                shown = mail.info_of(lines, "confirmWindow")
                if shown:
                    mail.notes.append(f"fenêtre de confirmation, telle qu'affichée : {json.dumps(shown, ensure_ascii=False)}")
                found = mail.info_of(lines, "itipAnswerFound")
                if found:
                    mail.notes.append("« Accepter » par le traitement iTIP de Thunderbird, invitation déjà dans l'agenda : "
                                      f"{json.dumps(found, ensure_ascii=False)}")
            seen = mail.info_of(lines, f"sendingSeen{phase}")
            if seen:
                mail.notes.append(f"phase {phase}, guet des envois de Thunderbird : {len(seen.get('transports', []))} appel(s) "
                                  f"à un transport de courrier (agenda personnel témoin), SMTP : {json.dumps(seen.get('smtp'))}")
            read = mail.info_of(lines, f"logLinesRead{phase}")
            if read:
                mail.notes.append(f"phase {phase} : {read} lignes du journal de l'extension examinées")

        # 4. Checks from the outside.
        for name, srv in servers.items():
            check(not srv.protocol_errors(), f"serveur {name} : aucune requête refusée comme mal formée",
                  srv.protocol_errors()[:5])
            check(not srv.internal_errors(), f"serveur {name} : aucune erreur interne",
                  [e[:300] for e in srv.internal_errors()[:3]])
            reqs = srv.requests()
            authenticated = [r for r in reqs if r.get("user")]
            check(authenticated and all(r.get("tls_version") for r in authenticated),
                  f"serveur {name} : toutes les requêtes authentifiées ont eu lieu en TLS", len(authenticated))
        check(rpc.count > 0, "requêtes du scénario aux faux serveurs traitées", rpc.count)
        if rpc.errors:  # a step that fails on one shows as a CHECK or a CRASH of the scenario
            mail.notes.append(f"{len(rpc.errors)} requête(s) du scénario refusée(s) par un faux serveur, par exemple : "
                              + " | ".join(rpc.errors[:3]))

        # Profile files, Thunderbird stopped: what the removal of mailbox A left.
        last = phases.get(2, ({}, False))
        removed = mail.info_of(last[0], "removed") if last[1] else None
        kept = mail.info_of(last[0], "kept") if last[1] else None
        if removed:
            gone = removed.get("calendarIds", [])
            prefs = profile / "prefs.js"
            if prefs.is_file():
                ptext = prefs.read_text(encoding="utf-8", errors="replace")
                check(removed["mailboxId"] not in ptext,
                      "[prefs.js] plus aucune trace de la boîte supprimée (agendas, ordre d'affichage, compte, identité)",
                      [line[:160] for line in ptext.splitlines() if removed["mailboxId"] in line][:5])
                still = [cid for cid in kept.get("calendarIds", []) if f'calendar.registry.{cid}.type", "sync443"' in ptext]
                check(still == kept.get("calendarIds", []),
                      "[prefs.js] les agendas des autres boîtes sont toujours enregistrés, avec le type sync443", still)
            else:
                check(False, "[prefs.js] écrit par Thunderbird à sa fermeture")
            store = profile / "calendar-data" / "sync443.sqlite"
            rows = rows_of(store, gone)
            check(rows is not None and all(n == 0 for n in rows.values()),
                  "[disque] calendar-data/sync443.sqlite : plus aucune ligne pour les agendas de la boîte supprimée", rows)
            rows = rows_of(store, kept.get("calendarIds", []))
            check(rows is not None and rows.get("cal_events", 0) > 0,
                  "[disque] calendar-data/sync443.sqlite : les éléments des autres boîtes y sont toujours", rows)
            user = kept.get("userCalendarId")
            rows = rows_of(profile / "calendar-data" / "local.sqlite", [user] if user else [])
            check(rows is not None and rows.get("cal_events", 0) == 2,
                  "[disque] calendar-data/local.sqlite : l'agenda personnel de l'utilisateur a toujours ses deux événements", rows)

        if trace:
            marks = sorted(phase_marks.items())
            for i, (phase, (seq, launched)) in enumerate(marks):
                until = marks[i + 1][1][0] if i + 1 < len(marks) else None
                end = marks[i + 1][1][1] if i + 1 < len(marks) else float("inf")
                print(f"\nChronologie du serveur principal, phase {phase} (temps depuis le lancement de Thunderbird) :")
                calls = [c for c in rpc.calls if launched <= c[0] < end]
                for line in mail.trace_lines(main_srv, since=seq, until=until, t0=launched, calls=calls):
                    print(line[:400])
        log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        # Thunderbird's own remark about calendars loaded before its main window: counted, start by start (the
        # scenario checks what could follow from it: calendars missing, disabled or not served after a restart).
        early = [part.count(EARLY_CALENDARS) for part in log.split("===== phase ")[1:]]
        if any(early):
            mail.notes.append("console de Thunderbird, « Calendar manager initialised calendars before loadCalendarComponent "
                              f"ran… » : {early} fois par démarrage (le type d'agenda de l'extension est enregistré au "
                              "démarrage de l'extension, avant la fenêtre principale)")
        failed = any(r[0] == "FAIL" for r in mail.results)
        if show_log or failed:
            for phase, (lines, _) in sorted(phases.items()):
                entries = [e for e in lines.get("LOG", []) if e.get("level") != "debug"]
                mail.print_log({"LOG": entries}, phase, last=400 if show_log else 150)
            print("\nExtrait du journal de Thunderbird :")
            for line in [l for l in log.splitlines() if ("sync443" in l.lower() or "error" in l.lower())
                         and not l.startswith("SYNC443MAIL-")][-60:]:
                print("    " + line[:400])
        if show_log:
            for phase, (lines, _) in sorted(phases.items()):
                print(f"\nÉtapes de la phase {phase} :")
                t0 = None
                for s in lines.get("STEP", []):
                    t0 = t0 or s.get("at")
                    print(f"    +{(s.get('at') - t0) / 1000:7.1f} s  {s.get('name')}")
    finally:
        for srv in servers.values():
            try:
                srv.stop()
            except Exception:  # noqa: BLE001 - best effort
                pass
        if keep:
            print(f"\nDossier conservé : {work}")
        else:
            net.remove_tree(work)

    return mail.report(f"Résultats agenda, tâches et réunions : {thunderbird} (sans interface), {sys.platform}"
                       + (f", sources {src}" if src != ROOT / "src" else "")
                       + (f", étapes {wanted_steps}" if wanted_steps else ""), started, durations)


if __name__ == "__main__":
    sys.exit(main())
