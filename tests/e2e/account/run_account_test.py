# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""End-to-end proof of the sync443Account experiment in a real, headless Thunderbird.

    python3 -I tests/e2e/account/run_account_test.py [--keep] [--log]

Windows, macOS, Linux; Python 3.8+ standard library only.
  THUNDERBIRD   path of the Thunderbird executable (otherwise looked for in
                the usual places of each OS, as tests/e2e/net does)
  On Linux with Thunderbird as a snap, set TMPDIR to a directory in your home:
  the snap cannot see the system's /tmp.

What it does, all in a throw-away profile (never your Thunderbird profile):
  1. builds a test extension with the real src/experiments/sync443Account and
     a test-only helper (creates accounts the extension does not own, forges
     marks, inspects accounts, folders, outgoing servers and logins);
  2. phase 1, Thunderbird -headless, on a fresh profile (no Local Folders,
     no outgoing server): Local Folders never taken for ours, the neutral
     outgoing server never left as the default one; then argument checks,
     creation and update of accounts, the send route (checkSendRoute,
     automatic repairs, safe values), archive and junk settings, refusals
     (Local Folders, unmarked accounts, accounts of another extension),
     passwords,
     files kept outside the profile's Mail folder, removal of one account,
     refusal of a page other than the background page;
  3. phase 2, Thunderbird started again on the same profile: what survived
     the restart, then removal of everything;
  4. checks from the outside, Thunderbird stopped: the profile's Mail
     directory, prefs.js and logins.json;
  5. phase 3, the same profile with Thunderbird's Rust login store switched
     on (signon.storage.rust.enabled): the password functions again.

Prints a PASS/FAIL/SKIP list; exit status 1 on any FAIL.
"""

import json
import os
import re
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

EXTENSION_ID = "sync443-account-e2e@sync443.test"
RESULTS_FILE = "sync443account-e2e.txt"
PHASE_FILE = "sync443account-phase.json"
PHASE_TIMEOUT_S = 60
OUR_MAILBOXES = ("a1b2c3d4e5f6", "0123456789ab")

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
        api = ROOT / "src" / "experiments" / "sync443Account"
        for name in ("schema.json", "implementation.js"):
            z.write(api / name, f"experiments/sync443Account/{name}")


def parse(text):
    """{kind: [values]} from the "SYNC443ACCOUNT-<KIND> <json>" lines."""
    out = {}
    for line in text.splitlines():
        m = re.match(r"^SYNC443ACCOUNT-([A-Z]+) (.*)$", line.strip())
        if m:
            try:
                value = json.loads(m.group(2))
            except ValueError:
                value = m.group(2)
            out.setdefault(m.group(1), []).append(value)
    return out


def run_phase(thunderbird, profile, phase, log_path):
    """Runs Thunderbird on the profile until the extension reports the end of the phase."""
    results_path = profile / RESULTS_FILE
    if results_path.exists():
        results_path.unlink()
    net.write_text(profile / PHASE_FILE, json.dumps({"phase": phase}))
    env = dict(os.environ, MOZ_CRASHREPORTER_DISABLE="1")
    started = time.time()
    done = False
    exited_at = None
    with open(log_path, "ab") as logf:
        proc = subprocess.Popen([str(thunderbird), "-headless", "-no-remote", "-profile", str(profile)],
                                stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT, env=env)
        deadline = time.time() + PHASE_TIMEOUT_S
        while time.time() < deadline:
            time.sleep(0.2)
            if results_path.exists() and "SYNC443ACCOUNT-DONE" in results_path.read_text(encoding="utf-8", errors="replace"):
                done = True
                break
            if proc.poll() is not None:
                # On some systems the first process only launches the real one: give it time.
                exited_at = exited_at or time.time()
                if time.time() - exited_at > 15:
                    break
        # The extension quits Thunderbird itself once done; the next phase
        # needs the profile unlocked and prefs.js written.
        net.stop_process(proc)
    text = results_path.read_text(encoding="utf-8", errors="replace") if results_path.exists() else ""
    net.write_text(log_path.parent / f"phase{phase}.txt", text)  # kept with --keep
    return text, done, time.time() - started


def collect(lines, phase, done, seconds):
    for crash in lines.get("CRASH", []):
        check(False, f"phase {phase} : le scénario ne plante pas", crash.get("error") if isinstance(crash, dict) else crash)
    check(done, f"phase {phase} : Thunderbird exécute tout le scénario puis se ferme", f"{seconds:.1f} s" if done else "délai dépassé")
    for c in lines.get("CHECK", []):
        if isinstance(c, dict):
            check(bool(c.get("ok")), f"[{phase}] {c.get('label')}", None if c.get("ok") else c.get("detail"))
    for s in lines.get("SKIP", []):
        if isinstance(s, dict):
            skip(f"[{phase}] {s.get('label')}", s.get("detail"))


def plant_old_neutral(prefs, key):
    """Rewrites the neutral server's host and port in prefs.js to the values of its first design (sync443.invalid:465)."""
    if not key or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", key) or not prefs.is_file():
        return False
    text = prefs.read_text(encoding="utf-8")
    host = f'user_pref("mail.smtpserver.{key}.hostname", "127.0.0.1");'
    port = f'user_pref("mail.smtpserver.{key}.port", 1);'
    if host not in text or port not in text:
        return False
    text = text.replace(host, f'user_pref("mail.smtpserver.{key}.hostname", "sync443.invalid");')
    text = text.replace(port, f'user_pref("mail.smtpserver.{key}.port", 465);')
    net.write_text(prefs, text)
    return True


def info_of(lines, key):
    for value in lines.get("INFO", []):
        if isinstance(value, dict) and key in value:
            return value[key]
    return None


def inside(path, directory):
    try:
        Path(os.path.realpath(path)).relative_to(os.path.realpath(directory))
        return True
    except ValueError:
        return False


def main():
    # Windows consoles are not UTF-8 by default: the messages are in French.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    keep = "--keep" in sys.argv
    show_log = "--log" in sys.argv
    started = time.time()
    thunderbird = net.find_thunderbird()
    work = Path(tempfile.mkdtemp(prefix="sync443-account-e2e-"))
    probe = {}
    try:
        profile = work / "profile"
        (profile / "extensions").mkdir(parents=True)
        build_xpi(profile / "extensions" / f"{EXTENSION_ID}.xpi")
        net.write_text(profile / "user.js", net.USER_JS)
        log_path = work / "thunderbird.log"
        mail_dir = profile / "Mail"

        # ── Phase 1
        text1, done1, s1 = run_phase(thunderbird, profile, 1, log_path)
        lines1 = parse(text1)
        collect(lines1, 1, done1, s1)
        probe = info_of(lines1, "probe") or {}
        paths = info_of(lines1, "paths") or {}
        if paths:
            check(not Path(paths["r2"]).exists() and inside(paths["r2"], mail_dir),
                  "[disque] phase 1 : dossier du compte supprimé absent de <profil>/Mail", paths["r2"])
            check(Path(paths["r1"]).is_dir() and inside(paths["r1"], mail_dir),
                  "[disque] phase 1 : dossier du compte conservé présent dans <profil>/Mail", paths["r1"])

        # ── Phase 2 (only if phase 1 went through: it builds on its state)
        if done1:
            # The neutral server's values of its first design, written while
            # Thunderbird is stopped: no notification, checkSendRoute must see them.
            planted = plant_old_neutral(profile / "prefs.js", info_of(lines1, "neutralKey"))
            check(planted, "[prefs.js] anciennes valeurs du serveur neutre (sync443.invalid:465) plantées entre les phases")
            text2, done2, s2 = run_phase(thunderbird, profile, 2, log_path)
            lines2 = parse(text2)
            collect(lines2, 2, done2, s2)
            again = (info_of(lines2, "paths2") or {}).get("again")
            if paths:
                listing = sorted(p.name for p in mail_dir.iterdir()) if mail_dir.is_dir() else []
                gone = [p for p in (paths["r1"], paths["r2"], again) if p]
                check(all(not Path(p).exists() for p in gone),
                      "[disque] Thunderbird arrêté : aucun dossier des comptes supprimés ne reste dans <profil>/Mail", listing)
                kept = [paths["localFolders"]] + list(paths["foreign"])
                check(all(Path(p).is_dir() for p in kept),
                      "[disque] « Dossiers locaux » et les comptes étrangers gardent leurs fichiers", listing)
            prefs = profile / "prefs.js"
            if prefs.is_file():
                ptext = prefs.read_text(encoding="utf-8", errors="replace")
                leftovers = [m for m in OUR_MAILBOXES if m in ptext]
                check(not leftovers, "[prefs.js] plus aucune trace des boîtes supprimées (marques, serveurs, identités)", leftovers)
                smtp_marks = re.findall(r'user_pref\("mail\.smtpserver\.[^"]*\.sync443\.owner"', ptext)
                check(not smtp_marks, "[prefs.js] plus aucun serveur sortant neutre", smtp_marks)
                owners = sorted(re.findall(r'user_pref\("mail\.server\.[^"]*\.sync443\.owner", "([^"]*)"\);', ptext))
                check(owners == sorted(["autre@extension.test", EXTENSION_ID]),
                      "[prefs.js] seules restent les marques des comptes étrangers du test", owners)
            else:
                check(False, "[prefs.js] écrit par Thunderbird à la fermeture")
            logins = profile / "logins.json"
            if logins.is_file():
                data = json.loads(logins.read_text(encoding="utf-8"))
                realms = [entry.get("httpRealm") for entry in data.get("logins", [])]
                check("Sync443" not in realms and realms.count("Autre domaine") == 1,
                      "[logins.json] plus aucune entrée « Sync443 » ; l'entrée étrangère reste", realms)
            else:
                skip("[logins.json] contrôle du fichier", "stockage des mots de passe ailleurs que dans logins.json")
            # ── Phase 3: the same profile, Thunderbird's Rust login store switched on
            if done2:
                with open(profile / "user.js", "a", encoding="utf-8", newline="\n") as f:
                    f.write('user_pref("signon.storage.rust.enabled", true);\n')
                text3, done3, s3 = run_phase(thunderbird, profile, 3, log_path)
                collect(parse(text3), 3, done3, s3)
        else:
            skip("phase 2 (après redémarrage)", "la phase 1 n'a pas abouti")

        log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        if show_log or any(r[0] == "FAIL" for r in results):
            print("\nExtrait du journal de Thunderbird :")
            for line in [l for l in log.splitlines() if "sync443" in l.lower() or "error" in l.lower()][-60:]:
                print("    " + line[:400])
    finally:
        if keep:
            print(f"\nDossier conservé : {work}")
        else:
            net.remove_tree(work)

    width = min(max((len(r[1]) for r in results), default=0), 100)
    print(f"\nRésultats sync443Account : {thunderbird} {probe.get('version', '?')} (sans interface), {sys.platform}")
    if probe:
        print(f"  gestionnaire de mots de passe : {probe.get('logins')}, stockage Rust actif : {probe.get('rustLogins')}")
    for status, label, detail in results:
        shown = str(detail).replace("\r", "\\r").replace("\n", "\\n") if detail not in (None, "") else ""
        print(f"  {status:4}  {label.ljust(width)}" + (f"   [{shown[:300]}]" if shown else ""))
    fails = sum(1 for r in results if r[0] == "FAIL")
    passes = sum(1 for r in results if r[0] == "PASS")
    skips = sum(1 for r in results if r[0] == "SKIP")
    print(f"\n{passes} PASS, {fails} FAIL, {skips} SKIP en {time.time() - started:.1f} s")
    return 1 if fails or not results else 0


if __name__ == "__main__":
    sys.exit(main())
