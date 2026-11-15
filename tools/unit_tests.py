# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""Run the unit tests on any OS.

The core is plain JavaScript without Node or browser APIs, so any JS engine
with ES modules runs the tests. This picks, in order:
  - the engine named by the JS_SHELL environment variable;
  - JavaScriptCore's `jsc` (shipped with macOS, or on PATH);
  - `node`, `deno` or `bun` on PATH.

    python3 -I tools/unit_tests.py        (Windows: py -3 -I tools\\unit_tests.py)
"""
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.join(ROOT, "tests", "unit")
MAC_JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"


def engine():
    forced = os.environ.get("JS_SHELL")
    if forced:
        return forced
    for candidate in (shutil.which("jsc"), MAC_JSC if os.path.exists(MAC_JSC) else None):
        if candidate:
            return candidate
    for name in ("node", "deno", "bun"):
        found = shutil.which(name)
        if found:
            return found
    return None


def command(exe):
    name = os.path.basename(exe).lower()
    if name.startswith("jsc"):
        return [exe, "-m", "run-all.mjs"]
    if name.startswith("deno"):
        return [exe, "run", "--allow-read", "run-all.mjs"]
    return [exe, "run-all.mjs"]  # node, bun


def main():
    # Windows consoles are not UTF-8 by default: the messages are in French.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    check = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "tools", "check_source_chars.py")])
    if check.returncode:
        return check.returncode
    exe = engine()
    if not exe:
        print("Aucun moteur JavaScript trouvé : installez Node.js (ou définissez JS_SHELL).")
        return 2
    # A test that never settles can make some engines exit quietly with
    # status 0, skipping the rest: success requires the final summary line,
    # with every test counted as passed.
    proc = subprocess.run(command(exe), cwd=TESTS, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output = proc.stdout.decode("utf-8", "replace")
    sys.stdout.write(output)
    summary = re.search(r"^(\d+)/(\d+) tests réussis", output, re.M)
    if proc.returncode:
        return proc.returncode
    if not summary or summary.group(1) != summary.group(2) or summary.group(2) == "0":
        print("Échec : la suite s'est arrêtée sans son bilan final (test jamais terminé ?).")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
