# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""Refuse invisible or direction-changing characters in source files.

Bidirectional overrides, zero-width characters, line separators and
control characters make code read differently from how it runs
("Trojan Source", CVE-2021-42574). Write them as \\uXXXX escapes instead.

    python3 -I tools/check_source_chars.py            # check, exit 1 if found
    python3 -I tools/check_source_chars.py --fix      # rewrite them as escapes (.mjs/.js only)
"""
import os
import sys

BAD = set(range(0x00, 0x20)) - {0x09, 0x0A, 0x0D}
BAD |= {0x7F, 0x00AD, 0x061C, 0x180E, 0x2028, 0x2029, 0x2060, 0xFEFF}
BAD |= set(range(0x80, 0xA0)) | set(range(0x200B, 0x2010)) | set(range(0x202A, 0x202F)) | set(range(0x2066, 0x206A))
EXTENSIONS = (".mjs", ".js", ".json", ".py", ".sh", ".html", ".css", ".md")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    # Windows consoles are not UTF-8 by default: the messages are in French.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    fix = "--fix" in sys.argv[1:]
    found = 0
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in (".git", "dist", "__pycache__")]
        for name in files:
            if not name.endswith(EXTENSIONS):
                continue
            path = os.path.join(base, name)
            text = open(path, encoding="utf-8").read()
            hits = [(i, c) for i, c in enumerate(text) if ord(c) in BAD]
            if not hits:
                continue
            if fix and name.endswith((".mjs", ".js")):
                text = "".join("\\u%04x" % ord(c) if ord(c) in BAD else c for c in text)
                open(path, "w", encoding="utf-8").write(text)
                print(f"corrigé : {os.path.relpath(path, ROOT)} ({len(hits)})")
                continue
            for i, c in hits:
                line = text.count("\n", 0, i) + 1
                print(f"{os.path.relpath(path, ROOT)}:{line}: caractère invisible U+{ord(c):04X}")
                found += 1
    if found:
        print(f"{found} caractère(s) à écrire en séquence \\uXXXX.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
