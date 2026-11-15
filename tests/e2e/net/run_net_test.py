# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""End-to-end proof of the sync443Net experiment in a real, headless Thunderbird.

    python3 -I tests/e2e/net/run_net_test.py [--keep] [--log]

Windows, macOS, Linux; Python 3.8+ standard library only.
  THUNDERBIRD   path of the Thunderbird executable (otherwise looked for in
                the usual places of each OS)
  OPENSSL       optional: used (1) when this Python's ssl module cannot serve
                TLS 1.3 (e.g. macOS's /usr/bin/python3), to run
                "openssl s_server -tls1_3" for the TLS 1.3 case, and (2) to
                package a client certificate as PKCS#12 for the client
                certificate control; without it those parts are SKIPped
  On Linux with Thunderbird as a snap, set TMPDIR to a directory in your home:
  the snap cannot see the system's /tmp.

What it does, all in a throw-away directory (never your Thunderbird profile):
  1. creates a test certificate authority and server certificates
     (testcerts.py, no openssl): "localhost" (DNS name only, no IP address,
     so that a check against the proxy's address 127.0.0.1 would fail),
     "example.org" (wrong name), "localhost" from an authority Thunderbird
     does not trust, and "::1" (IP address);
  2. starts local TLS servers that log every application byte they receive,
     an HTTP CONNECT proxy and a SOCKS5 proxy that log what passes through;
  3. builds a test extension with the real src/experiments/sync443Net and the
     real src/core/tls-policy.mjs, and runs it in Thunderbird
     (-headless -no-remote -profile <tmp>); the extension opens connections
     directly, through the HTTP proxy and through SOCKS, judges each
     certificate, and writes a request with a fake "Authorization: Basic"
     header only when the certificate is accepted;
  4. checks, from the servers' and proxies' own logs, what reached the network.

Prints a PASS/FAIL/SKIP list; exit status 1 on any FAIL.
"""

import base64
import hashlib
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))

import net_servers  # noqa: E402
import testcerts  # noqa: E402

EXTENSION_ID = "sync443-net-e2e@sync443.test"
RESULTS_FILE = "sync443net-e2e.txt"
TIMEOUT_S = 120
FAKE_PASSWORD = b"dGVzdDp0ZXN0"
CRLF = "\r\n"

USER_JS = """
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("xpinstall.signatures.required", false);
user_pref("browser.dom.window.dump.enabled", true);
user_pref("devtools.console.stdout.chrome", true);
user_pref("devtools.console.stdout.content", true);
user_pref("mail.shell.checkDefaultClient", false);
user_pref("mail.provider.suppress_dialog_on_startup", true);
user_pref("mailnews.start_page.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("app.update.disabledForTesting", true);
user_pref("security.OCSP.enabled", 0);
user_pref("security.enterprise_roots.enabled", false);
user_pref("network.proxy.type", 0);
user_pref("network.proxy.allow_hijacking_localhost", true);
"""

results = []


def check(cond, label, detail=None):
    results.append(("PASS" if cond else "FAIL", label, detail))


def skip(label, detail=None):
    results.append(("SKIP", label, detail))


def starts(value, prefix):
    return isinstance(value, str) and value.startswith(prefix)


def write_text(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


# ── Programs ───────────────────────────────────────────────────────────────

def find_thunderbird():
    env = os.environ.get("THUNDERBIRD")
    if env:
        if Path(env).is_file():
            return Path(env)
        sys.exit(f"THUNDERBIRD={env} : fichier introuvable.")
    candidates = []
    if sys.platform == "darwin":
        candidates += [Path("/Applications/Thunderbird.app/Contents/MacOS/thunderbird"),
                       Path.home() / "Applications/Thunderbird.app/Contents/MacOS/thunderbird"]
    elif os.name == "nt":
        for var in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA"):
            base = os.environ.get(var)
            if base:
                candidates.append(Path(base) / "Mozilla Thunderbird" / "thunderbird.exe")
    else:
        found = shutil.which("thunderbird")
        if found:
            candidates.append(Path(found))
        candidates += [Path("/usr/lib/thunderbird/thunderbird"), Path("/usr/lib64/thunderbird/thunderbird"),
                       Path("/usr/bin/thunderbird"), Path("/snap/bin/thunderbird")]
    for c in candidates:
        if c.is_file():
            return c
    sys.exit("Thunderbird introuvable. Indiquez son exécutable : THUNDERBIRD=<chemin> "
             f"(cherché : {', '.join(str(c) for c in candidates) or 'aucun emplacement connu'}).")


def find_openssl():
    env = os.environ.get("OPENSSL")
    if env:
        return Path(env) if Path(env).is_file() else None
    found = shutil.which("openssl")
    return Path(found) if found else None


def wait_listening(port, seconds=5.0):
    end = time.time() + seconds
    while time.time() < end:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def stop_process(proc, grace=20):
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.wait(timeout=grace)
        return
    except subprocess.TimeoutExpired:
        pass
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def remove_tree(path):
    for _ in range(10):  # Windows may hold files a moment after the process exits
        shutil.rmtree(path, ignore_errors=True)
        if not Path(path).exists():
            return
        time.sleep(0.5)


# ── Extension ──────────────────────────────────────────────────────────────

def build_xpi(path, config):
    ext = HERE / "extension"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for file in sorted(ext.rglob("*")):
            if file.is_file():
                z.write(file, file.relative_to(ext).as_posix())
        api = ROOT / "src" / "experiments" / "sync443Net"
        for name in ("schema.json", "implementation.js"):
            z.write(api / name, f"experiments/sync443Net/{name}")
        for file in sorted((ROOT / "src" / "core").glob("*.mjs")):
            z.write(file, f"core/{file.name}")
        z.writestr("test-config.json", json.dumps(config))


def free_port():
    s = net_servers.listen_loopback()
    port = s.getsockname()[1]
    s.close()
    return port


def expected_request(port, name, host="localhost", get=False):
    if get:
        return (f"GET /test/{name} HTTP/1.0{CRLF}Host: {host}:{port}{CRLF}"
                f"Authorization: Basic {FAKE_PASSWORD.decode()}{CRLF}Connection: close{CRLF}{CRLF}").encode()
    head = (f"POST /test/{name} HTTP/1.1{CRLF}Host: {host}:{port}{CRLF}"
            f"Authorization: Basic {FAKE_PASSWORD.decode()}{CRLF}Content-Type: application/octet-stream{CRLF}"
            f"Content-Length: 256{CRLF}Connection: close{CRLF}{CRLF}").encode()
    return head + bytes(range(256))


def connect_request(authority):
    return f"CONNECT {authority} HTTP/1.1{CRLF}Host: {authority}{CRLF}{CRLF}".encode()


def colon_hex(digest):
    return ":".join(f"{b:02X}" for b in digest)


# ── Run ────────────────────────────────────────────────────────────────────

def main():
    keep = "--keep" in sys.argv
    show_log = "--log" in sys.argv
    started = time.time()
    thunderbird = find_thunderbird()
    work = Path(tempfile.mkdtemp(prefix="sync443-net-e2e-"))
    servers = []
    s_server = None
    env = {}
    try:
        # 1. Certificates (one key per authority, one shared by the servers).
        ca = testcerts.make_ca("Sync443 Test CA")
        other_ca = testcerts.make_ca("Sync443 Other CA")
        server_key = testcerts.RsaKey()
        issued = {
            "good": testcerts.make_leaf(ca, "localhost", dns=["localhost"], key=server_key),
            "wrongName": testcerts.make_leaf(ca, "example.org", dns=["example.org"], key=server_key),
            "untrusted": testcerts.make_leaf(other_ca, "localhost", dns=["localhost"], key=server_key),
            "ipv6": testcerts.make_leaf(ca, "ipv6-loopback", ips=["::1"], key=server_key),
            "ipv4": testcerts.make_leaf(ca, "ipv4-loopback", ips=["127.0.0.1"], key=server_key),
            "client": testcerts.make_leaf(ca, "Sync443 test client", eku=testcerts.CLIENT_AUTH),
        }
        files = {}
        for name, leaf in issued.items():
            cert, key = work / f"{name}.pem", work / f"{name}.key"
            testcerts.write_cert(leaf, cert)
            testcerts.write_key(leaf, key)
            files[name] = (str(cert), str(key))
        ca_sha256 = hashlib.sha256(ca.cert_der).digest()
        ca_pem = work / "ca.pem"
        testcerts.write_cert(ca, ca_pem)
        openssl = find_openssl()
        client_p12 = work / "client.p12"
        if openssl:
            try:
                subprocess.run([str(openssl), "pkcs12", "-export", "-in", files["client"][0], "-inkey", files["client"][1],
                                "-out", str(client_p12), "-passout", "pass:sync443", "-name", "Sync443 test client",
                                "-certpbe", "PBE-SHA1-3DES", "-keypbe", "PBE-SHA1-3DES", "-macalg", "sha1"],
                               check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except (OSError, subprocess.CalledProcessError):
                pass

        # 2. Servers and proxies.
        def tls(role, cert, **kw):
            srv = net_servers.TlsServer(role, *files[cert], **kw)
            servers.append(srv)
            return srv

        srv = {role: tls(role, cert) for role, cert in [
            ("okDirect", "good"), ("refuseDirect", "good"), ("mismatchDirect", "wrongName"),
            ("untrustedDirect", "untrusted"), ("exceptionDirect", "wrongName"), ("okProxy", "good"), ("refuseProxy", "good"),
            ("mismatchProxy", "wrongName"), ("okSocks", "good"), ("refuseSocks", "good"),
            ("mismatchSocks", "wrongName"), ("misc", "good"), ("big", "good"), ("hold", "good"), ("revoke", "ipv4")]}
        srv["sink"] = tls("sink", "good", sink=True)
        srv["clientAuth"] = tls("clientAuth", "good", client_ca=str(ca_pem))
        try:
            srv["weak"] = tls("weak", "good", tls10_only=True)
        except (ssl.SSLError, ValueError, AttributeError, OSError):
            pass  # this Python's TLS library cannot serve TLS 1.0
        ports = {role: s.port for role, s in srv.items()}
        ports.setdefault("weak", None)
        try:  # a banned port (6697, IRC over TLS): nothing may connect to it
            banned = net_servers.SilentServer("banned", port=6697)
            servers.append(banned)
        except OSError:
            banned = None

        tls13 = {"mode": None}
        if ssl.HAS_TLSv1_3:
            srv["tls13"] = tls("tls13", "good", tls13_only=True)
            ports["tls13"] = srv["tls13"].port
            tls13["mode"] = "python"
        else:
            if openssl:
                port = free_port()
                s_server = subprocess.Popen(
                    [str(openssl), "s_server", "-accept", str(port), "-cert", files["good"][0], "-key", files["good"][1],
                     "-tls1_3", "-www", "-quiet"],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if wait_listening(port):
                    relay = net_servers.RecordingRelay("tls13-relay", port)
                    servers.append(relay)
                    tls13.update(mode="openssl", relay=relay)
                    ports["tls13"] = relay.port
                else:
                    tls13["why"] = f"{openssl} s_server -tls1_3 ne démarre pas"
            else:
                tls13["why"] = f"le module ssl de ce Python ({ssl.OPENSSL_VERSION}) ne sert pas TLS 1.3 et openssl est introuvable (OPENSSL=<chemin>)"
        if tls13["mode"] is None:
            ports["tls13"] = None

        if net_servers.ipv6_loopback_available():
            srv["ipv6"] = tls("ipv6", "ipv6", host="::1")
            srv["ipv6Proxy"] = tls("ipv6Proxy", "ipv6", host="::1")
            ports.update(ipv6=srv["ipv6"].port, ipv6Proxy=srv["ipv6Proxy"].port)
        else:
            ports.update(ipv6=None, ipv6Proxy=None)

        silent = net_servers.SilentServer("silent")
        servers.append(silent)
        special = {"proxyAuth": free_port(), "proxyDeny": free_port(), "proxyJunk": free_port()}
        http_proxy = net_servers.ConnectProxy("http-proxy", {special["proxyAuth"]: "auth", special["proxyDeny"]: "deny",
                                                             special["proxyJunk"]: "junk"})
        socks_proxy = net_servers.Socks5Proxy("socks-proxy")
        servers += [http_proxy, socks_proxy]
        ports.update(special, silent=silent.port, closed=free_port())
        config = {"ports": ports, "httpProxyPort": http_proxy.port, "socksProxyPort": socks_proxy.port,
                  "caBase64": base64.b64encode(ca.cert_der).decode("ascii"), "caSha256": ca_sha256.hex().upper(),
                  "wrongNameBase64": base64.b64encode(issued["wrongName"].cert_der).decode("ascii"),
                  "clientP12": str(client_p12) if client_p12.is_file() else None, "clientP12Password": "sync443"}

        # 3. Throw-away profile with the test extension, then Thunderbird.
        profile = work / "profile"
        (profile / "extensions").mkdir(parents=True)
        build_xpi(profile / "extensions" / f"{EXTENSION_ID}.xpi", config)
        write_text(profile / "user.js", USER_JS)
        results_path = profile / RESULTS_FILE
        log_path = work / "thunderbird.log"
        env = dict(os.environ, MOZ_CRASHREPORTER_DISABLE="1")
        done = False
        exited_at = None
        with open(log_path, "wb") as logf:
            proc = subprocess.Popen([str(thunderbird), "-headless", "-no-remote", "-profile", str(profile)],
                                    stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT, env=env)
            deadline = time.time() + TIMEOUT_S
            while time.time() < deadline:
                time.sleep(0.25)
                if results_path.exists() and "SYNC443NET-DONE" in results_path.read_text(encoding="utf-8", errors="replace"):
                    done = True
                    break
                if proc.poll() is not None:
                    # On some systems the first process only launches the real one: give it time.
                    exited_at = exited_at or time.time()
                    if time.time() - exited_at > 15:
                        break
            stop_process(proc)
        time.sleep(0.3)  # let server threads write their last log entries
        text = results_path.read_text(encoding="utf-8", errors="replace") if results_path.exists() else ""
        log = log_path.read_text(encoding="utf-8", errors="replace")

        # 4. Checks.
        evaluate(text, done, config, srv, silent, http_proxy, socks_proxy, ca_sha256, tls13, banned,
                 issued["client"].cert_der)
        if show_log or any(r[0] == "FAIL" for r in results):
            print("\nExtrait du journal de Thunderbird :")
            for line in [l for l in log.splitlines() if "sync443" in l.lower() or "error" in l.lower()][-60:]:
                print("    " + line[:400])
    finally:
        for s in servers:
            s.stop()
        if s_server is not None:
            s_server.terminate()
            try:
                s_server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                s_server.kill()
        if keep:
            print(f"\nDossier conservé : {work}")
        else:
            remove_tree(work)

    width = max((len(r[1]) for r in results), default=0)
    print(f"\nRésultats sync443Net : {thunderbird} (sans interface), {sys.platform}")
    for status, label, detail in results:
        shown = str(detail).replace("\r", "\\r").replace("\n", "\\n") if detail not in (None, "") else ""
        print(f"  {status:4}  {label.ljust(width)}" + (f"   [{shown}]" if shown else ""))
    fails = sum(1 for r in results if r[0] == "FAIL")
    passes = sum(1 for r in results if r[0] == "PASS")
    skips = sum(1 for r in results if r[0] == "SKIP")
    print(f"\n{passes} PASS, {fails} FAIL, {skips} SKIP en {time.time() - started:.1f} s")
    return 1 if fails or not results else 0


def parse_results(text):
    """{kind: [values]} from the "SYNC443NET-<KIND> <json>" lines."""
    out = {}
    for line in text.splitlines():
        m = re.match(r"^SYNC443NET-([A-Z-]+) (.*)$", line.strip())
        if m:
            try:
                value = json.loads(m.group(2))
            except ValueError:
                value = m.group(2)
            out.setdefault(m.group(1), []).append(value)
    return out


def evaluate(text, done, config, srv, silent, http_proxy, socks_proxy, ca_sha256, tls13, banned, client_der):
    ports = config["ports"]
    lines = parse_results(text)
    cases = {c.get("name"): c for c in lines.get("CASE", []) if isinstance(c, dict)}
    setup = (lines.get("SETUP") or [{}])[0]
    for crash in lines.get("CRASH", []):
        check(False, "le scénario ne plante pas", crash.get("error") if isinstance(crash, dict) else crash)
    check(bool(lines.get("CASES")), "Thunderbird exécute tout le scénario")
    check(done, "puis désactive l'extension et se ferme", "délai dépassé" if not done else None)
    check(setup.get("trustedAuthority") == colon_hex(ca_sha256), "autorité de test ajoutée au profil jetable")
    probe = setup.get("probe") or {}
    check(isinstance(probe.get("stateCertUserOverridden"), int) and isinstance(probe.get("anonymousConnect"), int)
          and probe.get("https6697Allowed") is False,
          "constantes Gecko utilisées présentes (STATE_CERT_USER_OVERRIDDEN, ANONYMOUS_CONNECT, ports interdits)", probe)
    for name, value in cases.items():
        if "crashed" in value:
            check(False, f"{name} : pas d'exception inattendue", value["crashed"])

    logs = {role: s.entries() for role, s in srv.items()}
    proxy_log = http_proxy.entries()
    socks_log = socks_proxy.entries()

    def ms(t):
        return t * 1000.0

    # ── Arguments, permission
    a = cases.get("arguments", {})
    check(starts(a.get("noPermission"), "PERMISSION:"), "hôte sans permission (example.com) → PERMISSION", a.get("noPermission"))
    check(starts(a.get("otherNameSameMachine"), "PERMISSION:"),
          "même machine sous un autre nom (127.0.0.1, permission https://localhost/* seulement) → PERMISSION",
          a.get("otherNameSameMachine"))
    for key in ("upperCase", "path", "userinfo", "shortIPv4", "port0", "port70000", "portString", "tinyTimeout",
                "timeoutOver120s", "noOptions"):
        check(starts(a.get(key), "CONFIG:"), f"argument invalide ({key}) → CONFIG", a.get(key))
    check(starts(a.get("bannedPort"), "CONFIG:") and "interdit" in a.get("bannedPort", ""),
          "port interdit par Gecko pour https (6697) → CONFIG", a.get("bannedPort"))
    if banned is not None:
        check(not banned.entries(), "port interdit : aucune connexion TCP ouverte vers lui", len(banned.entries()))
    else:
        skip("port interdit : aucune connexion TCP", "le port 6697 est déjà occupé sur cette machine")
    for key in ("unknownIdWrite", "unknownIdRead"):
        check(starts(a.get(key), "CLOSED:"), f"identifiant inconnu ({key}) → CLOSED", a.get(key))
    check("unknownIdClose" in a and a.get("unknownIdClose") is None, "close() d'un identifiant inconnu : sans effet")

    # ── Successful exchanges
    def chain_checks(name, c, leaf_cn="CN=localhost"):
        si = c.get("securityInfo") or {}
        certs = si.get("certificates") or []
        check(c.get("idIsUuid") is True, f"{name} : identifiant aléatoire (UUID)")
        check(si.get("state") == "secure" and not si.get("isUntrusted") and not si.get("isDomainMismatch")
              and not si.get("isNotValidAtThisTime") and "overridableErrorCategory" not in si,
              f"{name} : securityInfo « secure », sans exception de certificat",
              f"{si.get('state')}, {si.get('protocolVersion')}")
        check(len(certs) == 2 and leaf_cn in certs[0].get("subject", "")
              and "CN=Sync443 Test CA" in certs[1].get("subject", "")
              and certs[1].get("fingerprint", {}).get("sha256") == colon_hex(ca_sha256),
              f"{name} : chaîne vérifiée = certificat du serveur + autorité de test",
              [x.get("subject") for x in certs])
        check(len(certs) == 2 and certs[0].get("isBuiltInRoot") is False and certs[1].get("isBuiltInRoot") is False,
              f"{name} : isBuiltInRoot faux (autorité de test, pas une racine intégrée)")
        check(c.get("verdictWithoutPin") == "not-public-root" and c.get("verdict") == "pinned",
              f"{name} : tls-policy refuse sans épinglage, accepte avec l'empreinte de l'autorité",
              f"{c.get('verdictWithoutPin')} / {c.get('verdict')}")

    def received_after_open(name, c, r):
        first = ms(r["first_app_byte_at"])
        check(c.get("openedAt") is not None and first >= c["openedAt"] + 90,
              f"{name} : premier octet applicatif reçu APRÈS open() (+ pause de 100 ms), donc envoyé par write()",
              f"+{first - c.get('openedAt', 0):.0f} ms après la fin de open()")

    def ok_case(name, role, route, host="localhost", leaf_cn="CN=localhost", sni="localhost"):
        c = cases.get(name, {})
        port = ports[role]
        check(c.get("route") == route, f"{name} : route « {route} »", c.get("route") or c.get("openError"))
        chain_checks(name, c, leaf_cn)
        resp = c.get("response") or ""
        check(resp.startswith("HTTP/1.1 200 OK") and resp.endswith("bonjour depuis le serveur de test\n"),
              f"{name} : réponse complète lue jusqu'à la fin du flux", resp[:30])
        conns = [r for r in logs[role] if r.get("app_bytes")]
        got = [r for r in conns if r.get("data") == expected_request(port, name, host)]
        check(len(got) == 1, f"{name} : le serveur reçoit la requête exacte (Authorization + octets 0..255)",
              f"{len(conns)} connexion(s) avec données")
        if got:
            r = got[0]
            check(r.get("sni") == sni, f"{name} : SNI reçu par le serveur = {sni!r}", r.get("sni"))
            received_after_open(name, c, r)
        return c

    ok_case("direct-ok", "okDirect", "direct")
    ok_case("direct-ok-again", "okDirect", "direct")
    resumed = [r.get("resumed") for r in logs["okDirect"]]
    check(len(logs["okDirect"]) == 2, "aucune autre connexion vers ce serveur (le refus de 127.0.0.1 n'a rien ouvert)",
          len(logs["okDirect"]))
    if True in resumed:
        check(True, "session TLS reprise (resumption) : la chaîne vérifiée est quand même fournie", f"reprise : {resumed}")

    # ── Refusals after inspection: nothing written
    def refused_case(name, role, route):
        c = cases.get(name, {})
        check(c.get("route") == route and c.get("verdict") == "not-public-root" and c.get("closedWithoutWriting") is True,
              f"{name} : connexion ouverte, certificat refusé par la page d'arrière-plan, fermée sans écrire",
              c.get("verdict") or c.get("openError"))
        conns = logs[role]
        check(len(conns) == 1 and conns[0].get("handshake") == "ok",
              f"{name} : le serveur a vu une poignée de main TLS complète", [r.get("handshake") for r in conns])
        check(bool(conns) and all(r.get("app_bytes", 0) == 0 for r in conns),
              f"{name} : ZÉRO octet applicatif reçu par le serveur", [r.get("app_bytes") for r in conns])

    def tls_refused(name, role):
        c = cases.get(name, {})
        check(starts(c.get("openError"), "TLS:"), f"{name} : open() rejeté avec TLS", c.get("openError") or c.get("verdict"))
        conns = logs[role]
        check(bool(conns) and all(r.get("app_bytes", 0) == 0 for r in conns),
              f"{name} : ZÉRO octet applicatif reçu par le serveur",
              [(r.get("handshake"), r.get("app_bytes")) for r in conns])

    refused_case("direct-refused", "refuseDirect", "direct")
    tls_refused("direct-mismatch", "mismatchDirect")
    tls_refused("direct-untrusted", "untrustedDirect")
    tls_refused("direct-exception", "exceptionDirect")
    check("exception" in (cases.get("direct-exception", {}).get("openError") or ""),
          "certificat accepté par Gecko seulement grâce à une exception de sécurité → refusé quand même",
          cases.get("direct-exception", {}).get("openError"))

    # ── TLS 1.3 (the client's handshake ends when it SENDS its Finished)
    t_ok, t_no = cases.get("tls13-ok", {}), cases.get("tls13-refused", {})
    if tls13["mode"] is None:
        skip("TLS 1.3", tls13.get("why"))
    else:
        how = "serveur Python" if tls13["mode"] == "python" else "openssl s_server derrière un relais"
        check((t_ok.get("securityInfo") or {}).get("protocolVersion") == "TLSv1.3",
              f"tls13-ok : TLS 1.3 négocié ({how})", (t_ok.get("securityInfo") or {}).get("protocolVersion") or t_ok.get("openError"))
        chain_checks("tls13-ok", t_ok)
        check((t_ok.get("response") or "").startswith("HTTP/1."), "tls13-ok : réponse lue", (t_ok.get("response") or "")[:20])
        check(t_no.get("closedWithoutWriting") is True and t_no.get("verdict") == "not-public-root",
              "tls13-refused : certificat refusé par la page d'arrière-plan, fermée sans écrire", t_no.get("verdict"))
        if tls13["mode"] == "python":
            conns = logs["tls13"]
            want = expected_request(ports["tls13"], "tls13-ok", get=True)
            got = [r for r in conns if r.get("data") == want]
            check(len(conns) == 2 and all(r.get("tls_version") == "TLSv1.3" for r in conns) and len(got) == 1,
                  "TLS 1.3 : le serveur reçoit la requête exacte sur une connexion, rien sur l'autre",
                  [(r.get("tls_version"), r.get("app_bytes")) for r in conns])
            if got:
                received_after_open("tls13-ok", t_ok, got[0])
        else:
            relayed = sorted(tls13["relay"].entries(), key=lambda r: r["accepted_at"])
            records = [net_servers.tls_records(r.get("to_server", b"")) for r in relayed]
            # After the ClientHello, every client record is "application data" on the outside;
            # its Finished (53 bytes) and close_notify alert (19 bytes) are small, a request is not.
            big = [[n for t, n in recs if t == 0x17 and n > 64] for recs in records]
            check(len(records) == 2 and big[0] and not big[1],
                  "TLS 1.3 : enregistrements chiffrés vus par le relais : une requête sur la connexion acceptée, "
                  "aucune sur la connexion refusée (Finished et alerte de fermeture seulement)",
                  [[(t, n) for t, n in recs] for recs in records])

    # ── IPv6 literal
    if ports.get("ipv6"):
        ok_case("ipv6-ok", "ipv6", "direct", host="[::1]", leaf_cn="CN=ipv6-loopback", sni=None)
    else:
        skip("IPv6 [::1]", "pas d'IPv6 sur l'interface de bouclage")

    # ── Misc: limits, timeouts, errors
    m = cases.get("misc", {})
    for key in ("badBytesString", "badBytes256", "badBytesArray", "tooBig", "badMaxBytes0", "badMaxBytesBig", "concurrentRead"):
        check(starts(m.get(key), "CONFIG:"), f"connexion ouverte, appel invalide ({key}) → CONFIG", m.get(key))
    check(starts(m.get("readTimeout"), "TIMEOUT:") and 250 <= (m.get("readTimeoutMs") or 0) < 2000,
          "read() sans données → TIMEOUT dans le délai demandé (300 ms)", f"{m.get('readTimeout')} {m.get('readTimeoutMs')} ms")
    check((m.get("response") or "").startswith("HTTP/1.1 200 OK"), "après un TIMEOUT de lecture, la connexion reste utilisable")
    misc_data = [r for r in logs["misc"] if r.get("app_bytes")]
    check(len(misc_data) == 1 and misc_data[0].get("data") == expected_request(ports["misc"], "after-timeout"),
          "seule la connexion qui a écrit a envoyé des octets au serveur", len(misc_data))
    check(starts(m.get("writeAfterClose"), "CLOSED:") and starts(m.get("readAfterClose"), "CLOSED:"),
          "write()/read() après close() → CLOSED", f"{m.get('writeAfterClose')} / {m.get('readAfterClose')}")
    check(m.get("closeTwice") is None and "closeTwice" in m, "close() deux fois : sans effet")
    check(m.get("opened16") == 16 and starts(m.get("seventeenth"), "CONFIG:"),
          "16 connexions au plus par extension ; la 17e → CONFIG", m.get("seventeenth"))
    check(m.get("afterClosingAll") == "direct", "après fermeture, une nouvelle connexion est possible")
    check(starts(m.get("silent"), "TIMEOUT:") and (m.get("silentMs") or 99999) < 4000,
          "serveur muet (TCP sans TLS) → TIMEOUT dans le délai (1,5 s)", f"{m.get('silent')} {m.get('silentMs')} ms")
    silent_bytes = [r.get("received", b"") for r in silent.entries()]
    check(bool(silent_bytes) and all(b[:1] == b"\x16" and FAKE_PASSWORD not in b for b in silent_bytes),
          "le serveur muet n'a reçu que le début de la poignée de main TLS", [b[:1].hex() for b in silent_bytes])
    check(starts(m.get("refusedPort"), "NETWORK:"), "port fermé → NETWORK", m.get("refusedPort"))

    # ── One write at a time, 1 MiB at most
    w = cases.get("writes", {})
    check(w.get("verdict") == "pinned" and w.get("blocked") is True,
          "serveur qui ne lit pas : les écritures de 1 Mio finissent par rester en attente",
          f"{w.get('written')} Mio acceptés avant blocage {w.get('error') or ''}")
    check(starts(w.get("concurrent"), "CONFIG:") and "écriture est déjà en cours" in (w.get("concurrent") or ""),
          "une seconde écriture pendant qu'une autre est en cours → CONFIG", w.get("concurrent"))
    check(starts(w.get("pendingAfterClose"), "CLOSED:"), "close() termine l'écriture en attente → CLOSED", w.get("pendingAfterClose"))

    # ── Host permission removed while a connection is open
    r = cases.get("revoke", {})
    check(starts(r.get("beforeGrant"), "PERMISSION:"), "127.0.0.1 sans permission → PERMISSION", r.get("beforeGrant"))
    check(r.get("verdict") == "pinned" and starts(r.get("readWhileAllowed"), "TIMEOUT:"),
          "permission accordée à l'exécution : connexion ouverte et lisible", r.get("readWhileAllowed"))
    check(r.get("removed") is True and starts(r.get("writeAfterRevoke"), "PERMISSION:"),
          "permission retirée → write() refusé (PERMISSION)", r.get("writeAfterRevoke"))
    check(starts(r.get("readAfterRevoke"), "CLOSED:"), "… et la connexion a été fermée (read() → CLOSED)", r.get("readAfterRevoke"))
    check(starts(r.get("openAfterRevoke"), "PERMISSION:"), "… et open() est de nouveau refusé", r.get("openAfterRevoke"))
    check(len(logs["revoke"]) == 1 and logs["revoke"][0].get("app_bytes", 0) == 0,
          "permission retirée : ZÉRO octet applicatif reçu par le serveur", [x.get("app_bytes") for x in logs["revoke"]])

    # ── Client certificate: never sent, never asked for
    cc = cases.get("client-cert", {})
    by_path = {}
    for e in logs["clientAuth"]:
        m = re.match(rb"^[A-Z]+ (/test/[a-z-]+) ", e.get("data") or b"")
        by_path[m.group(1).decode() if m else None] = e
    for key, label in (("ask", "« Demander à chaque fois »"), ("auto", "« Choisir automatiquement »")):
        c = cc.get(key) or {}
        e = by_path.get(f"/test/clientcert-{key}", {})
        check((c.get("response") or "").startswith("HTTP/1.1 200 OK") and e.get("handshake") == "ok"
              and e.get("data") == expected_request(ports["clientAuth"], f"clientcert-{key}"),
              f"serveur qui demande un certificat client, réglage {label} : poignée de main terminée sans dialogue, échange complet",
              c.get("openError") or e.get("handshake"))
        check("client_cert" in e and e.get("client_cert") is None,
              f"… aucun certificat client envoyé ({label})", "certificat reçu" if e.get("client_cert") else None)
    if config.get("clientP12"):
        check(cc.get("imported") == 0, "certificat client + clé importés dans le profil (PKCS#12)", cc.get("imported"))
        control = by_path.get("/test/fetch-control", {})
        check(cc.get("fetchStatus") == 200 and control.get("client_cert") == client_der,
              "témoin : la pile HTTP de Thunderbird (fetch) envoie ce certificat au même serveur ; sync443Net non (ANONYMOUS_CONNECT)",
              cc.get("fetchError") or ("certificat reçu" if control.get("client_cert") else "aucun certificat reçu"))
    else:
        skip("témoin certificat client (fetch l'envoie, sync443Net non)", "openssl introuvable pour créer le PKCS#12 (OPENSSL=<chemin>)")

    # ── Deprecated TLS: Gecko completes the handshake but calls it broken
    wk = cases.get("weak-tls10", {})
    wl = logs.get("weak", [])
    if not ports.get("weak"):
        skip("TLS 1.0 (connexion « faible »)", f"le module ssl de ce Python ({ssl.OPENSSL_VERSION}) ne sert pas TLS 1.0")
    elif wl and wl[0].get("handshake") == "ok" and wl[0].get("tls_version") == "TLSv1":
        check(starts(wk.get("openError"), "TLS:") and "non sûre" in (wk.get("openError") or ""),
              "TLS 1.0 accepté par Gecko (réglages de test) mais jugé non sûr → refusé (TLS), jamais rendu à l'extension",
              wk.get("openError") or wk.get("verdict"))
        check(all(x.get("app_bytes", 0) == 0 for x in wl), "TLS 1.0 : ZÉRO octet applicatif reçu par le serveur")
    else:
        check(starts(wk.get("openError"), "TLS:"), "TLS 1.0 refusé (par Gecko lui-même, avant la fin de la poignée de main)",
              wk.get("openError"))
        skip("TLS 1.0 : refus par sync443Net d'une connexion « faible » terminée", "Gecko a refusé TLS 1.0 lui-même")

    # ── Backpressure
    b = cases.get("big", {})
    big_rec = [r for r in logs["big"] if r.get("big_progress")]
    check(b.get("bodyBytes") == net_servers.BIG_BODY and b.get("patternOk") is True,
          "32 Mio reçus intacts, lus par tranches", f"{b.get('bodyBytes')} octets, {b.get('chunks')} lectures")
    check(0 < (b.get("maxChunk") or 0) <= 1048576, "aucune lecture ne dépasse maxBytes (1 Mio)", b.get("maxChunk"))
    if big_rec and b.get("readStartedAt"):
        before = max([n for t, n in big_rec[0]["big_progress"] if ms(t) <= b["readStartedAt"]] or [0])
        check(before <= 12 * 1024 * 1024,
              "contre-pression : sans lecture par l'extension, Thunderbird cesse de lire le réseau",
              f"{before / 1048576:.1f} Mio envoyés par le serveur en 2,5 s sans lecture "
              f"(2 Mio de tampon Thunderbird + tampons TCP du système)")
    else:
        check(False, "contre-pression mesurée", b.get("error"))

    # ── HTTP proxy (CONNECT)
    c = ok_case("proxy-ok", "okProxy", "http-proxy")
    authority = f"localhost:{ports['okProxy']}"
    tunnels = [r for r in proxy_log if r.get("target") == ("localhost", ports["okProxy"])]
    check(len(tunnels) == 1 and tunnels[0].get("request") == connect_request(authority),
          "proxy : requête CONNECT exacte « CONNECT hôte:port HTTP/1.1 » + Host, rien d'autre",
          tunnels[0].get("request") if tunnels else None)
    if tunnels:
        t = tunnels[0]
        check(t.get("extra_before_answer") == b"", "proxy : aucun octet envoyé avant sa réponse 200")
        to_server = t.get("to_server", b"")
        check(to_server[:1] == b"\x16", "proxy : après le 200, le premier octet est un enregistrement TLS (ClientHello)")
        check(FAKE_PASSWORD not in to_server and b"Authorization" not in to_server,
              "proxy : le mot de passe ne le traverse que chiffré")
        check(ms(t.get("tunnel_at", 0)) <= (c.get("openedAt") or 0), "proxy : tunnel établi avant la fin de open()")
    check(len(logs["okProxy"]) == 1 and logs["okProxy"][0].get("sni") == "localhost",
          "à travers le tunnel, TLS est négocié pour l'hôte CIBLE (SNI « localhost », certificat sans adresse IP "
          "accepté alors que la connexion TCP va au proxy 127.0.0.1)")
    if ports.get("ipv6Proxy"):
        ok_case("ipv6-proxy-ok", "ipv6Proxy", "http-proxy", host="[::1]", leaf_cn="CN=ipv6-loopback", sni=None)
        v6 = [r for r in proxy_log if r.get("target") == ("::1", ports["ipv6Proxy"])]
        check(len(v6) == 1 and v6[0].get("request") == connect_request(f"[::1]:{ports['ipv6Proxy']}"),
              "proxy : CONNECT vers une adresse IPv6 écrite entre crochets", v6[0].get("request") if v6 else None)
    refused_case("proxy-refused", "refuseProxy", "http-proxy")
    check(any(r.get("target") == ("localhost", ports["refuseProxy"]) for r in proxy_log), "proxy-refused : passé par le proxy")
    tls_refused("proxy-mismatch", "mismatchProxy")
    check(any(r.get("target") == ("localhost", ports["mismatchProxy"]) for r in proxy_log),
          "proxy-mismatch : passé par le proxy ; le certificat « example.org » est refusé pour la cible « localhost »")
    pa = cases.get("proxy-auth", {})
    check(starts(pa.get("openError"), "PROXY_AUTH:"), "proxy qui exige une authentification (407) → PROXY_AUTH", pa.get("openError"))
    auth_req = [r for r in proxy_log if r.get("target") == ("localhost", ports["proxyAuth"])]
    check(bool(auth_req) and b"proxy-authorization" not in auth_req[0].get("request", b"").lower()
          and auth_req[0].get("extra_before_answer") == b"",
          "407 : aucun identifiant envoyé au proxy, rien après la requête CONNECT")
    pd = cases.get("proxy-deny", {})
    check(starts(pd.get("openError"), "PROXY:"), "proxy qui refuse (403) → PROXY", pd.get("openError"))
    pj = cases.get("proxy-junk", {})
    check(starts(pj.get("openError"), "PROXY:") or starts(pj.get("openError"), "TLS:"),
          "proxy qui envoie des octets avant TLS → refusé", pj.get("openError"))
    junk = [r for r in proxy_log if r.get("target") == ("localhost", ports["proxyJunk"])]
    check(bool(junk) and FAKE_PASSWORD not in junk[0].get("to_server", b"") and b"Authorization" not in junk[0].get("to_server", b""),
          "proxy-junk : rien d'applicatif écrit", junk[0].get("to_server", b"")[:1].hex() if junk else None)
    pdn = cases.get("proxy-down", {})
    check(starts(pdn.get("openError"), "PROXY:"), "proxy configuré mais injoignable → PROXY", pdn.get("openError"))

    # ── SOCKS5
    ok_case("socks-ok", "okSocks", "socks")
    s_ok = [r for r in socks_log if r.get("target") == ("localhost", ports["okSocks"])]
    check(len(s_ok) == 1, "SOCKS5 : la connexion passe par le proxy, cible « localhost » (résolution par le proxy)",
          [r.get("target") for r in socks_log])
    if s_ok:
        check(s_ok[0].get("to_server", b"")[:1] == b"\x16" and FAKE_PASSWORD not in s_ok[0].get("to_server", b""),
              "SOCKS5 : TLS de bout en bout, le mot de passe ne le traverse que chiffré")
    refused_case("socks-refused", "refuseSocks", "socks")
    tls_refused("socks-mismatch", "mismatchSocks")
    check(any(r.get("target") == ("localhost", ports["mismatchSocks"]) for r in socks_log), "socks-mismatch : passé par le proxy SOCKS")

    # ── Only the background page
    v = cases.get("view-type", {})
    page = v.get("page")
    if v.get("tabCreated") and page:
        check(starts(page.get("open"), "PERMISSION:") and starts(page.get("close"), "PERMISSION:"),
              "une page de l'extension autre que l'arrière-plan est refusée → PERMISSION",
              f"{page.get('open')} / {page.get('close')}")
    else:
        skip("page autre que l'arrière-plan refusée", v.get("tabError") or "onglet sans réponse")

    # ── Extension shutdown closes its connections
    hold = (lines.get("HOLD") or [{}])[0]
    disabling = (lines.get("DISABLING") or [{}])[0].get("at")
    disabled = (lines.get("DISABLED") or [{}])[0].get("at")
    finished = (lines.get("DONE") or [{}])[0].get("at")
    held = logs["hold"]
    closed = ms(held[0]["closed_at"]) if held and "closed_at" in held[0] else None
    check(len(held) == 1 and held[0].get("handshake") == "ok" and held[0].get("app_bytes", 0) == 0 and hold.get("route"),
          "connexion laissée ouverte par l'extension (sans écrire)")
    check(bool(disabling and disabled and finished and closed) and disabling - 5 <= closed <= disabled + 1000 < finished,
          "désactiver l'extension ferme ses connexions (avant la fermeture de Thunderbird)",
          f"fermée {closed - disabling:.0f} ms après le début de la désactivation" if closed and disabling
          else (lines.get("DISABLE-FAILED") or ["désactivation non observée"])[0])

    # ── The password, everywhere
    written = {"okDirect": 2, "misc": 1, "big": 1, "okProxy": 1, "okSocks": 1, "ipv6": 1, "ipv6Proxy": 1,
               "tls13": 1, "clientAuth": 2}
    for role, entries in logs.items():
        with_pw = sum(1 for r in entries if FAKE_PASSWORD in (r.get("data") or b""))
        check(with_pw == written.get(role, 0),
              f"mot de passe reçu par « {role} » seulement là où l'extension a écrit ({written.get(role, 0)})", with_pw)
    leaks = [r.get("target") for r in proxy_log + socks_log if FAKE_PASSWORD in r.get("to_server", b"") + r.get("request", b"")]
    check(not leaks, "aucun proxy ne voit le mot de passe en clair", leaks or None)


if __name__ == "__main__":
    sys.exit(main())
