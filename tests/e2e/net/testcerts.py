# SPDX-License-Identifier: MIT
# Copyright (c) 2026 alfinium
"""Throw-away X.509 test certificates, Python standard library only.

No openssl needed, on any OS: RSA keys are generated here (Miller-Rabin
primes from the `secrets` module), certificates are DER-encoded by hand
(RFC 5280) and signed with RSASSA-PKCS1-v1_5 / SHA-256 (RFC 8017).

FOR TESTS ONLY: nothing here is meant to protect anything real.

    ca = make_ca("Sync443 Test CA")
    leaf = make_leaf(ca, "localhost", dns=["localhost"])            # or ips=["::1"], eku=CLIENT_AUTH
    write_pem(leaf.cert_der, "cert.pem"); write_key(leaf.key, "key.pem")
"""

import base64
import datetime
import hashlib
import ipaddress
import secrets
from pathlib import Path

# ── RSA ───────────────────────────────────────────────────────────────────

_SMALL_PRIMES = [p for p in range(3, 2000) if all(p % d for d in range(2, int(p ** 0.5) + 1))]


def _probably_prime(n, rounds=24):
    for p in _SMALL_PRIMES:
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        a = 2 + secrets.randbelow(n - 3)
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits, e):
    while True:
        # Top two bits set: the product of two such primes has exactly 2*bits bits.
        n = secrets.randbits(bits) | (3 << (bits - 2)) | 1
        if (n - 1) % e and _probably_prime(n):
            return n


class RsaKey:
    def __init__(self, bits=2048):
        e = 65537
        while True:
            p, q = _prime(bits // 2, e), _prime(bits // 2, e)
            if p != q:
                break
        self.n, self.e = p * q, e
        self.d = pow(e, -1, (p - 1) * (q - 1))
        self.p, self.q = p, q
        self.size = (self.n.bit_length() + 7) // 8

    def public_der(self):
        return _seq(_int(self.n), _int(self.e))

    def private_der(self):  # PKCS#1 RSAPrivateKey
        p, q, d = self.p, self.q, self.d
        return _seq(_int(0), _int(self.n), _int(self.e), _int(d), _int(p), _int(q),
                    _int(d % (p - 1)), _int(d % (q - 1)), _int(pow(q, -1, p)))

    def sign_sha256(self, data):
        digest_info = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(data).digest()
        em = b"\x00\x01" + b"\xff" * (self.size - len(digest_info) - 3) + b"\x00" + digest_info
        return pow(int.from_bytes(em, "big"), self.d, self.n).to_bytes(self.size, "big")


# ── DER ───────────────────────────────────────────────────────────────────

def _tlv(tag, content):
    n = len(content)
    if n < 0x80:
        length = bytes([n])
    else:
        raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
        length = bytes([0x80 | len(raw)]) + raw
    return bytes([tag]) + length + content


def _seq(*items):
    return _tlv(0x30, b"".join(items))


def _set(*items):
    return _tlv(0x31, b"".join(items))


def _int(v):
    raw = v.to_bytes(max(1, (v.bit_length() + 8) // 8), "big")  # room for a sign bit
    while len(raw) > 1 and raw[0] == 0 and raw[1] < 0x80:
        raw = raw[1:]
    return _tlv(0x02, raw)


def _oid(dotted):
    parts = [int(x) for x in dotted.split(".")]
    out = bytes([40 * parts[0] + parts[1]])
    for v in parts[2:]:
        chunk = [v & 0x7F]
        v >>= 7
        while v:
            chunk.insert(0, 0x80 | (v & 0x7F))
            v >>= 7
        out += bytes(chunk)
    return _tlv(0x06, out)


def _bits(content, unused=0):
    return _tlv(0x03, bytes([unused]) + content)


def _octets(content):
    return _tlv(0x04, content)


def _utc(t):
    return _tlv(0x17, t.strftime("%y%m%d%H%M%SZ").encode())


_NULL = b"\x05\x00"
_TRUE = b"\x01\x01\xff"
_SHA256_RSA = _seq(_oid("1.2.840.113549.1.1.11"), _NULL)
_RSA = _seq(_oid("1.2.840.113549.1.1.1"), _NULL)


def _name(cn):
    return _seq(_set(_seq(_oid("2.5.4.10"), _tlv(0x0C, b"Sync443 test"))),
                _set(_seq(_oid("2.5.4.3"), _tlv(0x0C, cn.encode()))))


def _ext(oid, value, critical=False):
    return _seq(_oid(oid), *( [_TRUE] if critical else []), _octets(value))


# ── Certificates ──────────────────────────────────────────────────────────

class Issued:
    def __init__(self, cn, key, cert_der, ski):
        self.cn, self.key, self.cert_der, self.ski = cn, key, cert_der, ski


def _certificate(subject_cn, key, issuer, extensions, days):
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    spki = _seq(_RSA, _bits(key.public_der()))
    tbs = _seq(
        _tlv(0xA0, _int(2)),  # v3
        _int(secrets.randbits(63) | 1),
        _SHA256_RSA,
        _name(issuer.cn if issuer else subject_cn),
        _seq(_utc(now - datetime.timedelta(hours=1)), _utc(now + datetime.timedelta(days=days))),
        _name(subject_cn),
        spki,
        _tlv(0xA3, _seq(*extensions)),
    )
    signer = issuer.key if issuer else key
    return _seq(tbs, _SHA256_RSA, _bits(signer.sign_sha256(tbs)))


def make_ca(cn, key=None):
    key = key or RsaKey()
    ski = hashlib.sha1(key.public_der()).digest()
    exts = [
        _ext("2.5.29.19", _seq(_TRUE), critical=True),  # basicConstraints: CA
        _ext("2.5.29.15", _bits(b"\x06", 1), critical=True),  # keyUsage: keyCertSign, cRLSign
        _ext("2.5.29.14", _octets(ski)),  # subjectKeyIdentifier
    ]
    return Issued(cn, key, _certificate(cn, key, None, exts, 3), ski)


SERVER_AUTH = "1.3.6.1.5.5.7.3.1"
CLIENT_AUTH = "1.3.6.1.5.5.7.3.2"


def make_leaf(ca, cn, dns=(), ips=(), key=None, eku=SERVER_AUTH):
    key = key or RsaKey()
    ski = hashlib.sha1(key.public_der()).digest()
    names = [_tlv(0x82, d.encode("ascii")) for d in dns]
    names += [_tlv(0x87, ipaddress.ip_address(ip).packed) for ip in ips]
    exts = [
        _ext("2.5.29.19", _seq(), critical=True),  # basicConstraints: not a CA
        _ext("2.5.29.15", _bits(b"\xa0", 5), critical=True),  # keyUsage: digitalSignature, keyEncipherment
        _ext("2.5.29.37", _seq(_oid(eku))),  # extendedKeyUsage
        *([_ext("2.5.29.17", _seq(*names))] if names else []),  # subjectAltName
        _ext("2.5.29.14", _octets(ski)),
        _ext("2.5.29.35", _seq(_tlv(0x80, ca.ski))),  # authorityKeyIdentifier
    ]
    return Issued(cn, key, _certificate(cn, key, ca, exts, 2), ski)


def _pem(label, der):
    b64 = base64.b64encode(der).decode("ascii")
    lines = [b64[i:i + 64] for i in range(0, len(b64), 64)]
    return f"-----BEGIN {label}-----\n" + "\n".join(lines) + f"\n-----END {label}-----\n"


def _write(path, text):
    with open(Path(path), "w", encoding="ascii", newline="\n") as f:
        f.write(text)


def write_cert(issued, path):
    _write(path, _pem("CERTIFICATE", issued.cert_der))


def write_key(issued, path):
    _write(path, _pem("RSA PRIVATE KEY", issued.key.private_der()))
