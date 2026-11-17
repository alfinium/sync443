# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""End-to-end proof of the address books in a real, headless Thunderbird.

    python3 -I tests/e2e/contacts/run_contacts_test.py [--keep] [--log]

Windows, macOS, Linux; Python 3.8+ standard library only.
  THUNDERBIRD   path of the Thunderbird executable (otherwise looked for in
                the usual places of each OS, as tests/e2e/net does)

What it does, all in a throw-away profile (never your Thunderbird profile):
  1. builds a test extension with the real src/tb/contact-store.mjs, the
     modules it needs, and the print / phase / quit helper of the calendar
     test;
  2. phase 1: a book made for a mailbox; contacts written from the server's
     descriptions and read back through Thunderbird's own API; what
     Thunderbird makes of a card never taken for a change of the user;
     changes, additions and deletions made as the user makes them; undoing;
     read-only contacts;
  3. phase 2, Thunderbird started again on the same profile: the changes
     that waited, then the removal of the book, a book of the user left
     untouched.

Prints a PASS/FAIL/SKIP list; exit status 1 on any FAIL.
"""

import sys
import tempfile
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE.parent / "net"))
sys.path.insert(0, str(HERE.parent / "calendar"))

import run_net_test as net  # noqa: E402
import run_calendar_test as cal  # noqa: E402  (run_phase, parse, collect: the same protocol of lines)

EXTENSION_ID = "sync443-contacts-e2e@sync443.test"
SOURCES = ["tb/contact-store.mjs", "sync/store.mjs"]


def build_xpi(path):
    ext = HERE / "extension"
    helper = HERE.parent / "calendar" / "extension" / "experiments" / "sync443CalendarTest"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for file in sorted(ext.rglob("*")):
            if file.is_file():
                z.write(file, file.relative_to(ext).as_posix())
        for name in ("schema.json", "implementation.js"):
            z.write(helper / name, f"experiments/sync443CalendarTest/{name}")
        for file in sorted((ROOT / "src" / "core").glob("*.mjs")):
            z.write(file, f"src/core/{file.name}")
        for name in SOURCES:
            z.write(ROOT / "src" / name, f"src/{name}")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    keep = "--keep" in sys.argv
    show_log = "--log" in sys.argv
    started = time.time()
    thunderbird = net.find_thunderbird()
    work = Path(tempfile.mkdtemp(prefix="sync443-contacts-e2e-"))
    version = "?"
    try:
        profile = work / "profile"
        (profile / "extensions").mkdir(parents=True)
        build_xpi(profile / "extensions" / f"{EXTENSION_ID}.xpi")
        net.write_text(profile / "user.js", net.USER_JS)
        log_path = work / "thunderbird.log"
        text1, done1, s1, stuck1 = cal.run_phase(thunderbird, profile, 1, log_path)
        lines1 = cal.parse(text1)
        cal.collect(lines1, 1, done1, s1, stuck1)
        version = (cal.info_of(lines1, "probe") or {}).get("version", "?")
        if done1:
            text2, done2, s2, stuck2 = cal.run_phase(thunderbird, profile, 2, log_path)
            cal.collect(cal.parse(text2), 2, done2, s2, stuck2)
        else:
            cal.skip("phase 2 (after a restart)", "phase 1 did not finish")
        log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        if show_log or any(r[0] == "FAIL" for r in cal.results):
            print("\nFrom Thunderbird's log:")
            for line in [l for l in log.splitlines() if "sync443" in l.lower() or "error" in l.lower()][-40:]:
                print("    " + line[:400])
    finally:
        if keep:
            print(f"\nKept: {work}")
        else:
            net.remove_tree(work)

    results = cal.results
    width = min(max((len(r[1]) for r in results), default=0), 110)
    print(f"\nResults address books: {thunderbird} {version} (headless), {sys.platform}")
    for status, label, detail in results:
        shown = str(detail).replace("\r", "\\r").replace("\n", "\\n") if detail not in (None, "") else ""
        print(f"  {status:4}  {label.ljust(width)}" + (f"   [{shown[:700]}]" if shown else ""))
    fails = sum(1 for r in results if r[0] == "FAIL")
    passes = sum(1 for r in results if r[0] == "PASS")
    skips = sum(1 for r in results if r[0] == "SKIP")
    print(f"\n{passes} PASS, {fails} FAIL, {skips} SKIP in {time.time() - started:.1f} s")
    return 1 if fails or not results else 0


if __name__ == "__main__":
    sys.exit(main())
