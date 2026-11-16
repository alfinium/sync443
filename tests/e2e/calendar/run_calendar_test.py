# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""End-to-end proof of the sync443Calendar experiment in a real, headless Thunderbird.

    python3 -I tests/e2e/calendar/run_calendar_test.py [--keep] [--log]

Windows, macOS, Linux; Python 3.8+ standard library only.
  THUNDERBIRD   path of the Thunderbird executable (otherwise looked for in
                the usual places of each OS, as tests/e2e/net does)
  On Linux with Thunderbird as a snap, set TMPDIR to a directory in your home:
  the snap cannot see the system's /tmp.

What it does, all in a throw-away profile (never your Thunderbird profile):
  1. builds a test extension with the real src/experiments/sync443Calendar
     and a test-only helper (acts on calendars as Thunderbird's interface
     does, reads items back through Thunderbird's own API, creates calendars
     the extension does not own, counts notifications and scheduling
     messages);
  2. phase 1, Thunderbird -headless, on a fresh profile: the provider type
     registered at startup; calendars (creation, update, marks, properties,
     calendars that are not ours); items of every shape of the contract
     written from descriptions and read back field by field; changes made
     through the calendar objects (journal, collapsing, local-only
     properties, acknowledgement, undoing, detached items); hostile
     descriptions and hostile recurrences; two items with one UID;
     scheduling (nothing is sent) and the replies Thunderbird asks for;
     what the server rewrote or cannot be read; faults put into
     Thunderbird's own storage and recurrence code; refusal of a page other
     than the background page; the limits of calendars and of items;
  3. phase 2, Thunderbird started again on the same profile: the provider
     registered again with its calendars, what survived the restart (items,
     zones, pending changes and their marks), then removal of everything,
     and the extension stopping while a calendar object is still held;
  4. checks from the outside, Thunderbird stopped: prefs.js and the SQLite
     files of the profile's calendar-data directory.

A step that could freeze Thunderbird if a fix regressed (a recurrence
Thunderbird 140 never finishes expanding) is announced by the scenario with
the time it may take: when it does not return in that time, Thunderbird is
stopped at once and the step is reported as failed, instead of the run
waiting for the end of the phase.

Prints a PASS/FAIL/SKIP list; exit status 1 on any FAIL.
"""

import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE.parent / "net"))

# Launch helpers shared with the sync443Net test: find_thunderbird,
# stop_process, remove_tree, write_text, USER_JS (throw-away profile prefs).
import run_net_test as net  # noqa: E402

EXTENSION_ID = "sync443-calendar-e2e@sync443.test"
RESULTS_FILE = "sync443calendar-e2e.txt"
PHASE_FILE = "sync443calendar-phase.json"
PHASE_TIMEOUT_S = 180
# A fixed default zone, so that the scenario does not depend on the machine;
# no reminder window in a profile nobody looks at.
USER_JS = net.USER_JS + """
user_pref("calendar.timezone.useSystemTimezone", false);
user_pref("calendar.timezone.local", "Europe/Paris");
user_pref("calendar.alarms.show", false);
user_pref("calendar.alarms.playsound", false);
user_pref("calendar.alarms.showmissed", false);
"""

results = []


def check(cond, label, detail=None):
    results.append(("PASS" if cond else "FAIL", label, detail))


def skip(label, detail=None):
    results.append(("SKIP", label, detail))


def build_xpi(path):
    ext = HERE / "extension"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for file in sorted(ext.rglob("*")):
            if file.is_file():
                z.write(file, file.relative_to(ext).as_posix())
        api = ROOT / "src" / "experiments" / "sync443Calendar"
        for name in ("schema.json", "implementation.js"):
            z.write(api / name, f"experiments/sync443Calendar/{name}")


def parse(text):
    """{kind: [values]} from the "SYNC443CALENDAR-<KIND> <json>" lines."""
    out = {}
    for line in text.splitlines():
        m = re.match(r"^SYNC443CALENDAR-([A-Z]+) (.*)$", line.strip())
        if m:
            try:
                value = json.loads(m.group(2))
            except ValueError:
                value = m.group(2)
            out.setdefault(m.group(1), []).append(value)
    return out


def open_guard(text):
    """The guarded step that is running, if any: (label, seconds allowed, how many guards were opened so far)."""
    current = None
    opened = 0
    for line in text.splitlines():
        m = re.match(r"^SYNC443CALENDAR-(GUARD|UNGUARD) (.*)$", line.strip())
        if not m:
            continue
        if m.group(1) == "UNGUARD":
            current = None
            continue
        opened += 1
        try:
            value = json.loads(m.group(2))
            current = (str(value.get("label")), float(value.get("seconds")), opened)
        except (ValueError, TypeError, AttributeError):
            current = ("?", 10.0, opened)
    return current


def run_phase(thunderbird, profile, phase, log_path):
    """Runs Thunderbird on the profile until the extension reports the end of the phase.

    → (text of the results, done, seconds, label of the guarded step that did not return or None).
    """
    results_path = profile / RESULTS_FILE
    if results_path.exists():
        results_path.unlink()
    net.write_text(profile / PHASE_FILE, json.dumps({"phase": phase}))
    env = dict(os.environ, MOZ_CRASHREPORTER_DISABLE="1")
    started = time.time()
    done = False
    stuck = None
    exited_at = None
    guard = None  # (number of the guard, when it was first seen open)
    with open(log_path, "ab") as logf:
        proc = subprocess.Popen([str(thunderbird), "-headless", "-no-remote", "-profile", str(profile)],
                                stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT, env=env)
        deadline = time.time() + PHASE_TIMEOUT_S
        while time.time() < deadline:
            time.sleep(0.2)
            text = results_path.read_text(encoding="utf-8", errors="replace") if results_path.exists() else ""
            if "SYNC443CALENDAR-DONE" in text:
                done = True
                break
            # A guarded step that does not return: Thunderbird is frozen, there is nothing to wait for.
            current = open_guard(text)
            if current is None:
                guard = None
            else:
                if guard is None or guard[0] != current[2]:
                    guard = (current[2], time.time())
                if time.time() - guard[1] > current[1]:
                    stuck = current[0]
                    break
            if proc.poll() is not None:
                # On some systems the first process only launches the real one: give it time.
                exited_at = exited_at or time.time()
                if time.time() - exited_at > 15:
                    break
        # The extension quits Thunderbird itself once done; the next phase
        # needs the profile unlocked, prefs.js written and the databases closed.
        # Only the process started here is ever stopped.
        net.stop_process(proc, 1 if stuck is not None else 20)
    text = results_path.read_text(encoding="utf-8", errors="replace") if results_path.exists() else ""
    net.write_text(log_path.parent / f"phase{phase}.txt", text)  # kept with --keep
    return text, done, time.time() - started, stuck


def collect(lines, phase, done, seconds, stuck=None):
    for crash in lines.get("CRASH", []):
        check(False, f"phase {phase}: the scenario does not crash", crash.get("error") if isinstance(crash, dict) else crash)
    if stuck is not None:
        check(False, f"phase {phase}: a step that must return at once froze Thunderbird, which was stopped", stuck)
    check(done, f"phase {phase}: Thunderbird runs the whole scenario, then quits", f"{seconds:.1f} s" if done else "timed out")
    for c in lines.get("CHECK", []):
        if isinstance(c, dict):
            check(bool(c.get("ok")), f"[{phase}] {c.get('label')}", None if c.get("ok") else c.get("detail"))
    for s in lines.get("SKIP", []):
        if isinstance(s, dict):
            skip(f"[{phase}] {s.get('label')}", s.get("detail"))


def info_of(lines, key):
    for value in lines.get("INFO", []):
        if isinstance(value, dict) and key in value:
            return value[key]
    return None


def rows_of(database, calendar_ids):
    """{table: rows} of these calendars in a calendar database of Thunderbird (None if there is no such file)."""
    if not database.is_file():
        return None
    out = {}
    connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
    try:
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cal\\_%' ESCAPE '\\'")]
        marks = ",".join("?" for _ in calendar_ids)
        for table in tables:
            columns = [row[1] for row in connection.execute(f"PRAGMA table_info({table})")]
            if "cal_id" in columns and calendar_ids:
                out[table] = connection.execute(f"SELECT COUNT(*) FROM {table} WHERE cal_id IN ({marks})", list(calendar_ids)).fetchone()[0]
    finally:
        connection.close()
    return out


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    keep = "--keep" in sys.argv
    show_log = "--log" in sys.argv
    started = time.time()
    thunderbird = net.find_thunderbird()
    work = Path(tempfile.mkdtemp(prefix="sync443-calendar-e2e-"))
    probe = {}
    notes = []
    try:
        profile = work / "profile"
        (profile / "extensions").mkdir(parents=True)
        build_xpi(profile / "extensions" / f"{EXTENSION_ID}.xpi")
        net.write_text(profile / "user.js", USER_JS)
        log_path = work / "thunderbird.log"
        store = profile / "calendar-data" / "sync443.sqlite"

        # ── Phase 1
        text1, done1, s1, stuck1 = run_phase(thunderbird, profile, 1, log_path)
        lines1 = parse(text1)
        collect(lines1, 1, done1, s1, stuck1)
        probe = info_of(lines1, "probe") or {}
        notes += [n for n in lines1.get("NOTE", []) if isinstance(n, str)]
        kept = info_of(lines1, "kept") or {}
        ours = list(kept.get("ours", []))
        if done1 and ours:
            rows = rows_of(store, ours)
            check(rows is not None and rows.get("cal_events", 0) > 0 and rows.get("cal_metadata", 0) > 0,
                  "[disk] between the phases: our calendars' items and journal are in calendar-data/sync443.sqlite", rows)
            prefs = profile / "prefs.js"
            ptext = prefs.read_text(encoding="utf-8", errors="replace") if prefs.is_file() else ""
            check(all(f'calendar.registry.{cid}.type", "sync443"' in ptext for cid in ours),
                  "[prefs.js] between the phases: our calendars are registered with the type sync443", ours)

        # ── Phase 2 (only if phase 1 went through: it builds on its state)
        if done1:
            text2, done2, s2, stuck2 = run_phase(thunderbird, profile, 2, log_path)
            lines2 = parse(text2)
            collect(lines2, 2, done2, s2, stuck2)
            notes += [n for n in lines2.get("NOTE", []) if isinstance(n, str)]
            if done2:
                prefs = profile / "prefs.js"
                if prefs.is_file():
                    ptext = prefs.read_text(encoding="utf-8", errors="replace")
                    left = sorted(set(re.findall(r'user_pref\("(calendar\.registry\.[^".]+)\.', ptext)))
                    mine = [name for name in left if any(name.endswith(cid) for cid in ours)]
                    check(not mine, "[prefs.js] nothing left of the calendars removed", mine)
                    named = [cid for cid in ours if re.search(re.escape(cid) + r"(?![0-9])", ptext)]
                    check(not named, "[prefs.js] their ids appear nowhere (order of calendars included)", named)
                    foreign = kept.get("foreign", [])
                    check(all(f"calendar.registry.{cid}." in ptext for cid in foreign),
                          "[prefs.js] the calendars that are not ours are still registered", foreign)
                else:
                    check(False, "[prefs.js] written by Thunderbird when it quits")
                rows = rows_of(store, ours)
                check(rows is not None and all(n == 0 for n in rows.values()),
                      "[disk] calendar-data/sync443.sqlite: no row left for the calendars removed", rows)
                user = kept.get("user")
                rows = rows_of(profile / "calendar-data" / "local.sqlite", [user] if user else [])
                check(rows is not None and rows.get("cal_events", 0) >= 1,
                      "[disk] calendar-data/local.sqlite: the user's own calendar still has its event", rows)
        else:
            skip("phase 2 (after a restart)", "phase 1 did not finish")

        log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        if show_log or any(r[0] == "FAIL" for r in results):
            print("\nFrom Thunderbird's log:")
            for line in [l for l in log.splitlines() if "sync443" in l.lower() or "error" in l.lower()][-60:]:
                print("    " + line[:400])
    finally:
        if keep:
            print(f"\nKept: {work}")
        else:
            net.remove_tree(work)

    width = min(max((len(r[1]) for r in results), default=0), 110)
    print(f"\nResults sync443Calendar: {thunderbird} {probe.get('version', '?')} (headless), {sys.platform}, "
          f"default zone {probe.get('defaultZone', '?')}")
    for status, label, detail in results:
        shown = str(detail).replace("\r", "\\r").replace("\n", "\\n") if detail not in (None, "") else ""
        print(f"  {status:4}  {label.ljust(width)}" + (f"   [{shown[:600]}]" if shown else ""))
    for note in notes:
        print(f"  NOTE  {note}")
    fails = sum(1 for r in results if r[0] == "FAIL")
    passes = sum(1 for r in results if r[0] == "PASS")
    skips = sum(1 for r in results if r[0] == "SKIP")
    print(f"\n{passes} PASS, {fails} FAIL, {skips} SKIP in {time.time() - started:.1f} s")
    return 1 if fails or not results else 0


if __name__ == "__main__":
    sys.exit(main())
