# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""Local servers for the sync443Net end-to-end test (Python stdlib only).

- TlsServer: a TLS server that logs, per connection, the SNI it was given,
  the end of the handshake, and every application byte received with its
  time. It answers each complete HTTP/1.1 request with a fixed response
  (or, for the path /big, with a large body sent as fast as the client
  takes it, to observe backpressure) and closes.
- ConnectProxy: an HTTP proxy that only does CONNECT, logs the exact request
  it received and what goes through, and can answer 407, 403, or 200
  followed by stray bytes for chosen target ports.
- Socks5Proxy: a SOCKS5 proxy (no authentication, CONNECT only) that logs
  the requested target and what goes through.
- SilentServer: accepts TCP connections and never answers.
- RecordingRelay: a plain TCP relay to another local server (one this
  module cannot decrypt, such as "openssl s_server"), logging the TLS
  records the client sends (content type and length).

Portable (Windows, macOS, Linux): loopback sockets and threads only.

Every log entry is a dict, kept in memory; times come from time.time().
"""

import socket
import ssl
import struct
import threading
import time

BIG_BODY = 32 * 1024 * 1024


def recv_exact(sock, n):
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise ConnectionError("closed")
        data += chunk
    return data


def listen_loopback(host="127.0.0.1", port=0):
    """A listening socket on the loopback interface ("127.0.0.1" or "::1"), on `port` or a free one."""
    s = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM)
    s.bind((host, port))
    s.listen(64)
    return s


def ipv6_loopback_available():
    try:
        listen_loopback("::1").close()
        return True
    except OSError:
        return False


def tls_records(data):
    """[(content type, length)] of the TLS records in a byte stream (as far as it is complete)."""
    out = []
    i = 0
    while i + 5 <= len(data):
        length = int.from_bytes(data[i + 3:i + 5], "big")
        out.append((data[i], length))
        i += 5 + length
    return out


class _Base:
    def __init__(self, name, host="127.0.0.1", port=0):
        self.name = name
        self.lock = threading.Lock()
        self.log = []
        self.sock = listen_loopback(host, port)
        self.port = self.sock.getsockname()[1]
        self.stopping = False
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self):
        while not self.stopping:
            try:
                conn, addr = self.sock.accept()
            except OSError:
                return
            rec = {"server": self.name, "accepted_at": time.time(), "peer": addr[1]}
            with self.lock:
                self.log.append(rec)
            threading.Thread(target=self._guarded, args=(conn, rec), daemon=True).start()

    def _guarded(self, conn, rec):
        try:
            self.handle(conn, rec)
        except Exception as e:  # noqa: BLE001 - logged, never raised in a server thread
            rec.setdefault("error", f"{type(e).__name__}: {e}")
        finally:
            rec["closed_at"] = time.time()
            try:
                conn.close()
            except OSError:
                pass

    def entries(self):
        with self.lock:
            return [dict(r) for r in self.log]

    def stop(self):
        self.stopping = True
        try:
            self.sock.close()
        except OSError:
            pass


class TlsServer(_Base):
    """
    tls13_only: refuse anything older than TLS 1.3.
    tls10_only: TLS 1.0 only (raises if this Python's TLS library cannot).
    client_ca: ask the client for a certificate issued by this authority
               (optional: the handshake goes on without one); logged as "client_cert".
    sink: after the handshake, never read (the client's writes pile up).
    """

    def __init__(self, name, certfile, keyfile, host="127.0.0.1", tls13_only=False, tls10_only=False,
                 client_ca=None, sink=False):
        if tls10_only:
            self.context = ssl.SSLContext(ssl.PROTOCOL_TLSv1)
            try:
                self.context.set_ciphers("DEFAULT:@SECLEVEL=0")  # OpenSSL 1.1+: allow TLS 1.0
            except ssl.SSLError:
                self.context.set_ciphers("DEFAULT")  # LibreSSL: no security levels
        else:
            self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(certfile, keyfile)
        if tls13_only:
            self.context.minimum_version = ssl.TLSVersion.TLSv1_3
        if client_ca:
            self.context.verify_mode = ssl.CERT_OPTIONAL
            self.context.load_verify_locations(client_ca)
        self.sink = sink
        self.context.sni_callback = self._sni
        self._sni_seen = {}
        super().__init__(name, host)

    def _sni(self, sslobj, server_name, _context):
        self._sni_seen[id(sslobj)] = server_name
        return None

    def handle(self, conn, rec):
        conn.settimeout(15)
        tls = self.context.wrap_socket(conn, server_side=True, do_handshake_on_connect=False)
        rec["sni"] = None
        rec["app_bytes"] = 0
        rec["chunks"] = []
        try:
            tls.do_handshake()
        except (ssl.SSLError, OSError) as e:
            rec["sni"] = self._sni_seen.pop(id(tls), None)
            rec["handshake"] = f"failed: {type(e).__name__}: {getattr(e, 'reason', None) or e}"
            return
        rec["sni"] = self._sni_seen.pop(id(tls), None)
        rec["handshake"] = "ok"
        rec["handshake_at"] = time.time()
        rec["tls_version"] = tls.version()
        rec["resumed"] = tls.session_reused
        rec["client_cert"] = tls.getpeercert(binary_form=True)
        if self.sink:
            while not self.stopping and time.time() - rec["handshake_at"] < 60:
                time.sleep(0.2)
            return
        data = b""
        while True:
            try:
                chunk = tls.recv(65536)
            except (ssl.SSLError, OSError) as e:
                rec["recv_error"] = f"{type(e).__name__}: {e}"
                break
            if not chunk:
                break
            now = time.time()
            rec["chunks"].append((now, len(chunk)))
            rec.setdefault("first_app_byte_at", now)
            rec["app_bytes"] += len(chunk)
            data += chunk
            rec["data"] = data
            head_end = data.find(b"\r\n\r\n")
            if head_end < 0:
                continue
            length = 0
            for line in data[:head_end].split(b"\r\n")[1:]:
                k, _, v = line.partition(b":")
                if k.strip().lower() == b"content-length":
                    length = int(v.strip())
            if len(data) < head_end + 4 + length:
                continue
            path = data.split(b" ", 2)[1] if data.count(b" ") >= 2 else b"/"
            self._respond(tls, rec, path)
            break
        try:
            tls.unwrap()
        except (ssl.SSLError, OSError):
            pass

    def _respond(self, tls, rec, path):
        if path == b"/big":
            head = (b"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
                    b"Content-Length: %d\r\nConnection: close\r\n\r\n" % BIG_BODY)
            tls.sendall(head)
            block = bytes(range(256)) * 256  # 64 KiB
            sent = 0
            rec["big_progress"] = []  # (time, bytes handed to the kernel so far)
            while sent < BIG_BODY:
                tls.sendall(block)
                sent += len(block)
                rec["big_progress"].append((time.time(), sent))
            rec["big_sent"] = sent
            return
        body = b"bonjour depuis le serveur de test\n"
        tls.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %d\r\n"
                    b"Connection: close\r\n\r\n%s" % (len(body), body))
        rec["responded_at"] = time.time()


def _relay(a, b, rec, key, stop):
    """Copy a -> b, appending what passes (as bytes) to rec[key]."""
    rec[key] = b""
    try:
        while not stop.is_set():
            chunk = a.recv(65536)
            if not chunk:
                break
            rec[key] += chunk
            b.sendall(chunk)
    except OSError:
        pass
    finally:
        stop.set()
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _connect_upstream(host, port):
    # The test servers listen on 127.0.0.1 (and one on ::1): "localhost" is
    # pinned to IPv4 so that the result does not depend on the OS resolver.
    return socket.create_connection(("127.0.0.1" if host == "localhost" else host, port), timeout=10)


def _relay_both(client, upstream, rec):
    client.settimeout(None)
    upstream.settimeout(None)
    stop = threading.Event()
    t = threading.Thread(target=_relay, args=(upstream, client, rec, "to_client", stop), daemon=True)
    t.start()
    _relay(client, upstream, rec, "to_server", stop)
    t.join(timeout=15)
    upstream.close()


class ConnectProxy(_Base):
    """behaviours: {target port: "auth" | "deny" | "junk"}."""

    def __init__(self, name, behaviours):
        self.behaviours = behaviours
        super().__init__(name)

    def handle(self, conn, rec):
        conn.settimeout(15)
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = conn.recv(4096)
            if not chunk:
                rec["request"] = head
                return
            head += chunk
            if len(head) > 16384:
                return
        request, _, extra = head.partition(b"\r\n\r\n")
        rec["request"] = request + b"\r\n\r\n"
        rec["extra_before_answer"] = extra
        line = request.split(b"\r\n", 1)[0].decode("latin-1")
        parts = line.split(" ")
        if len(parts) != 3 or parts[0] != "CONNECT":
            conn.sendall(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n")
            return
        host, _, port = parts[1].rpartition(":")
        host = host.strip("[]")
        port = int(port)
        rec["target"] = (host, port)
        behaviour = self.behaviours.get(port)
        rec["behaviour"] = behaviour
        if behaviour == "auth":
            conn.sendall(b"HTTP/1.1 407 Proxy Authentication Required\r\n"
                         b"Proxy-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\n\r\n")
            return
        if behaviour == "deny":
            conn.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        if behaviour == "junk":
            conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\nJUNK-BEFORE-TLS")
            rec["to_server"] = b""
            try:
                while True:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    rec["to_server"] += chunk
            except OSError:
                pass
            return
        upstream = _connect_upstream(host, port)
        conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
        rec["tunnel_at"] = time.time()
        _relay_both(conn, upstream, rec)


class Socks5Proxy(_Base):
    def handle(self, conn, rec):
        conn.settimeout(15)
        ver, nmethods = recv_exact(conn, 2)
        methods = recv_exact(conn, nmethods)
        rec["methods"] = list(methods)
        if ver != 5 or 0 not in methods:
            conn.sendall(b"\x05\xff")
            return
        conn.sendall(b"\x05\x00")
        ver, cmd, _rsv, atyp = recv_exact(conn, 4)
        if atyp == 1:
            host = socket.inet_ntoa(recv_exact(conn, 4))
        elif atyp == 3:
            host = recv_exact(conn, recv_exact(conn, 1)[0]).decode("ascii")
        elif atyp == 4:
            host = socket.inet_ntop(socket.AF_INET6, recv_exact(conn, 16))
        else:
            conn.sendall(b"\x05\x08\x00\x01\x00\x00\x00\x00\x00\x00")
            return
        port = struct.unpack(">H", recv_exact(conn, 2))[0]
        rec["target"] = (host, port)
        rec["atyp"] = atyp
        if cmd != 1:
            conn.sendall(b"\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00")
            return
        try:
            upstream = _connect_upstream(host, port)
        except OSError:
            conn.sendall(b"\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00")
            return
        conn.sendall(b"\x05\x00\x00\x01" + socket.inet_aton("127.0.0.1") + struct.pack(">H", port))
        rec["tunnel_at"] = time.time()
        _relay_both(conn, upstream, rec)


class SilentServer(_Base):
    def handle(self, conn, rec):
        conn.settimeout(20)
        rec["received"] = b""
        try:
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                rec["received"] += chunk
        except OSError:
            pass


class RecordingRelay(_Base):
    """Relays to 127.0.0.1:upstream_port; logs what the client sends ("to_server")."""

    def __init__(self, name, upstream_port):
        self.upstream_port = upstream_port
        super().__init__(name)

    def handle(self, conn, rec):
        upstream = socket.create_connection(("127.0.0.1", self.upstream_port), timeout=10)
        _relay_both(conn, upstream, rec)
