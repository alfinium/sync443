// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * HTTP/1.1 tests: request serialization (exact bytes, injection attempts,
 * reserved headers), response parsing (valid responses under every split,
 * every error case, limits exactly at and one past, request-smuggling
 * ambiguities, interim responses, responses without content).
 * Unusual characters are built with String.fromCharCode, never written
 * literally in this file.
 */

import { test, assert, eq, throws, prng } from "./harness.mjs";
import { serializeRequest, ResponseParser, HttpError, HTTP_LIMITS, headerValue } from "../../src/core/http1.mjs";

const CRLF = "\r\n";
const ch = (...codes) => String.fromCharCode(...codes);
const NUL = ch(0);
const CR = ch(13);
const LF = ch(10);
const DEL = ch(0x7f);
const isHttpError = (e) => e instanceof HttpError && e.name === "HttpError" && e.message.startsWith("HTTP : ");

/** Bytes from strings (one byte per character, 0 to 255) and arrays of byte values. */
function b(...parts) {
  const list = [];
  for (const p of parts) {
    if (typeof p === "string") {
      for (let k = 0; k < p.length; k++) {
        const c = p.charCodeAt(k);
        if (c > 0xff) throw new Error(`b() : caractère hors octet (${c})`);
        list.push(c);
      }
    } else {
      for (const x of p) list.push(x);
    }
  }
  return new Uint8Array(list);
}

const latin1 = (bytes) => {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return s;
};

/** Headers Map as the parser builds it. */
function H(...pairs) {
  const m = new Map();
  for (const [k, v] of pairs) {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  }
  return m;
}

/** Feeds `input` to a new parser in pieces of the given sizes (the rest last), then end(). */
function parse(input, { method = "POST", limits, sizes = null, end = true } = {}) {
  const data = input instanceof Uint8Array ? input : b(input);
  const p = new ResponseParser({ method, limits });
  let at = 0;
  if (sizes) {
    for (const n of sizes) {
      p.push(data.subarray(at, at + n));
      at += n;
    }
  }
  if (at < data.length) p.push(data.subarray(at));
  if (end) p.end();
  return p.response;
}

const show = (input) => JSON.stringify(input instanceof Uint8Array ? latin1(input) : input).slice(0, 120);

function refused(input, opts = {}, what = "") {
  return throws(() => parse(input, opts), isHttpError, what || show(input));
}

/** Result of a parse: { response } or { error: message }; any other exception fails the test. */
function outcome(input, opts = {}) {
  try {
    return { response: parse(input, opts) };
  } catch (e) {
    if (!isHttpError(e)) throw e;
    return { error: e.message };
  }
}

const ones = (n) => new Array(n).fill(1);

function randomSizes(rnd, total) {
  const sizes = [];
  let left = total;
  while (left > 0) {
    const n = 1 + Math.floor(rnd() * Math.min(left, rnd() < 0.5 ? 4 : 64));
    sizes.push(n);
    left -= n;
  }
  return sizes;
}

// ── Request serialization ─────────────────────────────────────────────────

const BASE = {
  method: "POST",
  host: "mail.example.com",
  path: "/Microsoft-Server-ActiveSync?Cmd=Ping&User=alice&DeviceId=ABC&DeviceType=Thunderbird",
  headers: [["X-Test", "ok"]],
  body: null,
};
const req = (patch) => ({ ...BASE, ...patch });
const refusedRequest = (r, what = "") => throws(() => serializeRequest(r), isHttpError, what || show(JSON.stringify(r)));

test("requête : POST ActiveSync typique, octets exacts", () => {
  const body = new Uint8Array([0x03, 0x01, 0x6a, 0x00, 0x00, 0x07, 0x56, 0x52, 0x03, 0x30, 0x00, 0x01, 0x01]);
  const out = serializeRequest({
    method: "POST",
    host: "mail.example.com",
    path: "/Microsoft-Server-ActiveSync?Cmd=FolderSync&User=alice%40example.com&DeviceId=SYNC443ABCDEF&DeviceType=Thunderbird",
    headers: [
      ["User-Agent", "Sync443/1.0"],
      ["Authorization", "Basic YWxpY2VAZXhhbXBsZS5jb206c2VjcmV0"],
      ["Content-Type", "application/vnd.ms-sync.wbxml"],
      ["MS-ASProtocolVersion", "14.1"],
      ["X-MS-PolicyKey", "0"],
    ],
    body,
  });
  const head =
    "POST /Microsoft-Server-ActiveSync?Cmd=FolderSync&User=alice%40example.com&DeviceId=SYNC443ABCDEF&DeviceType=Thunderbird HTTP/1.1\r\n" +
    "Host: mail.example.com\r\n" +
    "User-Agent: Sync443/1.0\r\n" +
    "Authorization: Basic YWxpY2VAZXhhbXBsZS5jb206c2VjcmV0\r\n" +
    "Content-Type: application/vnd.ms-sync.wbxml\r\n" +
    "MS-ASProtocolVersion: 14.1\r\n" +
    "X-MS-PolicyKey: 0\r\n" +
    "Content-Length: 13\r\n" +
    "Accept-Encoding: identity\r\n" +
    "\r\n";
  eq(out, b(head, body));
  assert(out instanceof Uint8Array, "Uint8Array attendu");
});

test("requête : OPTIONS sans corps, octets exacts (pas de Content-Length)", () => {
  const out = serializeRequest({
    method: "OPTIONS",
    host: "mail.example.com:8443",
    path: "/Microsoft-Server-ActiveSync",
    headers: [
      ["User-Agent", "Sync443/1.0"],
      ["Authorization", "Basic YWxpY2U6c2VjcmV0"],
    ],
    body: null,
  });
  eq(
    latin1(out),
    "OPTIONS /Microsoft-Server-ActiveSync HTTP/1.1\r\n" +
      "Host: mail.example.com:8443\r\n" +
      "User-Agent: Sync443/1.0\r\n" +
      "Authorization: Basic YWxpY2U6c2VjcmV0\r\n" +
      "Accept-Encoding: identity\r\n" +
      "\r\n",
  );
});

test("requête : Content-Length selon la méthode et le corps", () => {
  const head = (r) => latin1(serializeRequest(r)).split("\r\n\r\n")[0];
  for (const body of [null, undefined]) {
    assert(head(req({ body })).endsWith("\r\nContent-Length: 0\r\nAccept-Encoding: identity"), "POST sans corps : Content-Length: 0");
  }
  const { body: _omitted, ...noBody } = BASE;
  assert(head(noBody).includes("\r\nContent-Length: 0\r\n"), "POST, corps omis : Content-Length: 0");
  for (const method of ["OPTIONS", "GET", "HEAD", "DELETE", "PUT"]) assert(!head(req({ method })).includes("Content-Length"), `${method} sans corps : pas de Content-Length`);
  assert(head(req({ method: "OPTIONS", body: new Uint8Array(0) })).includes("\r\nContent-Length: 0\r\n"), "corps vide fourni : Content-Length: 0");
  const out = serializeRequest(req({ method: "GET", body: new Uint8Array(70000) }));
  assert(latin1(out.subarray(0, 300)).includes("\r\nContent-Length: 70000\r\n"), "Content-Length du corps");
  eq(out.length, latin1(out).indexOf("\r\n\r\n") + 4 + 70000, "corps copié après la ligne vide");
  // Headers omitted or null: none besides ours.
  eq(head({ method: "OPTIONS", host: "h.example", path: "/" }), "OPTIONS / HTTP/1.1\r\nHost: h.example\r\nAccept-Encoding: identity");
  eq(head({ method: "OPTIONS", host: "h.example", path: "/", headers: null }), "OPTIONS / HTTP/1.1\r\nHost: h.example\r\nAccept-Encoding: identity");
});

test("requête : en-têtes de l'appelant dans l'ordre, doublons conservés", () => {
  const out = latin1(serializeRequest(req({ headers: [["B", "2"], ["A", "1"], ["B", "3"], ["X-Empty", ""], ["X-Inner", "a b\tc"]] })));
  assert(out.includes("\r\nB: 2\r\nA: 1\r\nB: 3\r\nX-Empty: \r\nX-Inner: a b\tc\r\nContent-Length: 0\r\n"), out);
});

test("requête : le corps est copié (la sortie ne partage pas la mémoire de l'appelant)", () => {
  const body = new Uint8Array([1, 2, 3]);
  const out = serializeRequest(req({ body }));
  body[0] = 9;
  eq(Array.from(out.subarray(out.length - 3)), [1, 2, 3]);
});

test("requête : formes d'hôte acceptées", () => {
  for (const host of [
    "mail.example.com",
    "mail.example.com:8443",
    "MAIL.Example.COM",
    "[2001:db8::1]",
    "[2001:db8::1]:8443",
    "[::ffff:192.0.2.1]",
    "192.0.2.1",
    "192.0.2.1:443",
    "localhost",
    "exchange_01.corp.example",
    "xn--exmple-cua.com",
    "a:1",
    "a:65535",
  ]) {
    assert(latin1(serializeRequest(req({ host }))).includes(`\r\nHost: ${host}\r\n`), host);
  }
});

test("requête : hôtes refusés", () => {
  for (const host of [
    "",
    "mail.example.com:",
    "mail.example.com:0",
    "mail.example.com:00",
    ":443",
    "mail.example.com:65536",
    "mail.example.com:443:1",
    "mail.example.com:+443",
    "mail.example.com:1234567",
    "mail.example.com:44a",
    "2001:db8::1",
    "[2001:db8::1",
    "[2001:db8::1]x",
    "[2001:db8::1]:",
    "[2001:db8::1]:0",
    "[zz::1]",
    "[]",
    "[1]",
    "[::1%25eth0]",
    ".example.com",
    "example..com",
    "example.com.",
    "user@example.com",
    "example.com/path",
    "example.com?x",
    "example.com#x",
    "exa mple.com",
    "example.com\r\nX-Injected: 1",
    `ex${ch(0xe9)}mple.com`,
    `example.com${ch(9)}`,
    `example.com${NUL}`,
    "a".repeat(254),
    `${"a.".repeat(300)}com`,
    null,
    undefined,
    42,
    ["mail.example.com"],
  ]) {
    refusedRequest(req({ host }), `hôte ${JSON.stringify(host)}`);
  }
});

test("requête : chemins acceptés et refusés", () => {
  for (const path of ["/", "/Microsoft-Server-ActiveSync?Cmd=Ping&User=DOM%5Calice", "/a/b;c=d?x=1&y=2", "//x", "/~u/+=,!$'()*:@[]|^`{}<>\"\\", "/%41%2f%2F"]) {
    assert(latin1(serializeRequest(req({ path }))).startsWith(`POST ${path} HTTP/1.1\r\n`), path);
  }
  for (const path of [
    "",
    "*",
    "Microsoft-Server-ActiveSync",
    "http://mail.example.com/",
    "/a b",
    "/a#frag",
    "/a%",
    "/a%2",
    "/a%zz",
    "/a%g0",
    "/a%%41",
    `/a${ch(9)}b`,
    "/a\r\nHost: evil.example",
    "/ HTTP/1.1\r\nHost: evil.example\r\n\r\nGET /",
    `/a${NUL}`,
    `/${ch(0xe9)}`,
    `/${DEL}`,
    `/${ch(0x2028)}`,
    `/${"a".repeat(8192)}`,
    null,
    42,
  ]) {
    refusedRequest(req({ path }), `chemin ${JSON.stringify(path)}`);
  }
  eq(serializeRequest(req({ path: `/${"a".repeat(8191)}` })).length > 8192, true, "chemin de 8192 caractères accepté");
});

test("requête : méthodes acceptées et refusées", () => {
  for (const method of ["POST", "OPTIONS", "GET", "PROPFIND", "M-SEARCH", "A".repeat(32)]) {
    assert(latin1(serializeRequest(req({ method }))).startsWith(`${method} /`), method);
  }
  for (const method of [
    "",
    "PO ST",
    "POST\r\n",
    `PO${NUL}ST`,
    "GET / HTTP/1.1\r\nX:",
    `P${ch(0xd6)}ST`,
    "CONNECT",
    "A".repeat(33),
    "(POST)",
    "POST:",
    "POST/",
    null,
    undefined,
    42,
  ]) {
    refusedRequest(req({ method }), `méthode ${JSON.stringify(method)}`);
  }
});

test("requête : CR, LF, NUL, contrôles et non-ASCII refusés partout", () => {
  const BAD = [
    CR,
    LF,
    CRLF,
    NUL,
    ch(1),
    ch(0x0b),
    ch(0x0c),
    ch(0x1b),
    ch(0x1f),
    DEL,
    ch(0x80),
    ch(0x85),
    ch(0xa0),
    ch(0xe9),
    ch(0x2028),
    ch(0x2029),
    ch(0x202e),
    ch(0x200b),
    ch(0xfeff),
    ch(0xd800),
    ch(0x10a),
    String.fromCodePoint(0x1f600),
  ];
  for (const c of BAD) {
    const code = Array.from(c, (x) => x.charCodeAt(0).toString(16)).join("+");
    refusedRequest(req({ method: `PO${c}ST` }), `méthode avec ${code}`);
    refusedRequest(req({ path: `/a${c}b` }), `chemin avec ${code}`);
    refusedRequest(req({ host: `mail${c}.example.com` }), `hôte avec ${code}`);
    refusedRequest(req({ headers: [[`X${c}Y`, "v"]] }), `nom d'en-tête avec ${code}`);
    refusedRequest(req({ headers: [["X", `a${c}b`]] }), `valeur d'en-tête avec ${code}`);
    refusedRequest(req({ headers: [["X", c]] }), `valeur d'en-tête réduite à ${code}`);
  }
  // Classic header injection: a second header, a second request.
  refusedRequest(req({ headers: [["X-A", "v\r\nHost: evil.example"]] }));
  refusedRequest(req({ headers: [["X-A", "v\r\n\r\nGET /evil HTTP/1.1"]] }));
  refusedRequest(req({ headers: [["X-A", "v\nX-B: w"]] }));
  refusedRequest(req({ headers: [["X-A", "v\rX-B: w"]] }));
});

test("requête : noms d'en-tête qui ne sont pas des tokens", () => {
  for (const name of ["", "X Foo", "X:Foo", "X-Foo:", " X", "X ", `X${ch(9)}`, "X(1)", "X/1", "X@1", 'X"', "X{", "X}", "X[", "X]", "X=1", "X,Y", "X;Y", "X?", "X\\", "X<", "X>", null, 42, undefined]) {
    refusedRequest(req({ headers: [[name, "v"]] }), `nom ${JSON.stringify(name)}`);
  }
  // Every tchar is accepted.
  const out = latin1(serializeRequest(req({ headers: [["!#$%&'*+-.^_`|~09AZaz", "v"]] })));
  assert(out.includes("\r\n!#$%&'*+-.^_`|~09AZaz: v\r\n"), out);
});

test("requête : en-têtes réservés refusés, quelle que soit la casse", () => {
  for (const name of [
    "Host",
    "HOST",
    "host",
    "Content-Length",
    "content-length",
    "CONTENT-LENGTH",
    "Transfer-Encoding",
    "transfer-encoding",
    "Connection",
    "connection",
    "Accept-Encoding",
    "TE",
    "te",
    "Upgrade",
    "Keep-Alive",
    "Proxy-Connection",
  ]) {
    refusedRequest(req({ headers: [["X-Before", "1"], [name, "x"]] }), `en-tête réservé ${name}`);
  }
});

test("requête : valeurs d'en-tête, espaces autour refusés", () => {
  for (const value of [" a", "a ", `${ch(9)}a`, `a${ch(9)}`, " ", 42, null, undefined, ["x"], { toString: () => "x" }]) {
    refusedRequest(req({ headers: [["X", value]] }), `valeur ${JSON.stringify(value)}`);
  }
  let visible = "";
  for (let c = 0x21; c <= 0x7e; c++) visible += ch(c);
  assert(latin1(serializeRequest(req({ headers: [["X", visible]] }))).includes(`\r\nX: ${visible}\r\n`), "tout l'ASCII visible");
});

test("requête : formes d'entrée invalides", () => {
  for (const r of [null, undefined, "POST / HTTP/1.1", 42, true]) refusedRequest(r, `requête ${String(r)}`);
  for (const headers of ["X: y", { X: "y" }, [["X"]], [["X", "y", "z"]], ["X: y"], [null], [{ 0: "X", 1: "y", length: 2 }], 42]) {
    refusedRequest(req({ headers }), `en-têtes ${JSON.stringify(headers)}`);
  }
  for (const body of ["abc", [1, 2], new ArrayBuffer(3), new Uint16Array(2), new Uint8ClampedArray(2), new DataView(new ArrayBuffer(2)), 0, {}]) {
    refusedRequest(req({ body }), `corps ${Object.prototype.toString.call(body)}`);
  }
});

test("requête : un message d'erreur ne contient jamais la valeur refusée", () => {
  const e = refusedRequest(req({ headers: [["Authorization", `Basic s3cr3tP4ss${CR}`]] }));
  assert(!e.message.includes("s3cr3t"), e.message);
  assert(e.message.includes("Authorization"), "le nom de l'en-tête aide au diagnostic");
});

test("requête : chaque propriété est lue une seule fois (pas de valeur changeante)", () => {
  let reads = 0;
  const r = {
    method: "POST",
    host: "mail.example.com",
    get path() {
      reads++;
      return reads === 1 ? "/ok" : "/evil\r\nX: 1";
    },
    headers: [],
    body: null,
  };
  const out = latin1(serializeRequest(r));
  eq(reads, 1);
  assert(out.startsWith("POST /ok HTTP/1.1\r\n"), out);
});

test("requête : requêtes valides aléatoires, en-tête toujours bien formé", () => {
  const rnd = prng(9112);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const TCHARS = "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const word = (alphabet, min, max) => {
    let s = "";
    const n = min + Math.floor(rnd() * (max - min + 1));
    for (let k = 0; k < n; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    return s;
  };
  let PATHCHARS = "";
  for (let c = 0x21; c <= 0x7e; c++) if (c !== 0x23 && c !== 0x25) PATHCHARS += ch(c);
  let VALUECHARS = " \t";
  for (let c = 0x21; c <= 0x7e; c++) VALUECHARS += ch(c);
  for (let round = 0; round < 500; round++) {
    const method = pick(["POST", "OPTIONS", "GET", "PUT"]);
    const host = pick(["mail.example.com", "h:8443", "[2001:db8::2]:443", "192.0.2.7"]);
    const path = `/${word(PATHCHARS, 0, 40)}`;
    const headers = [];
    const n = Math.floor(rnd() * 6);
    for (let k = 0; k < n; k++) {
      let name = word(TCHARS, 1, 12);
      if (/^(host|content-length|transfer-encoding|connection|accept-encoding|te|upgrade|keep-alive|proxy-connection)$/i.test(name)) name = `X-${name}`;
      let value = word(VALUECHARS, 0, 30).replace(/^[ \t]+|[ \t]+$/g, "");
      headers.push([name, value]);
    }
    const body = rnd() < 0.5 ? null : new Uint8Array(Math.floor(rnd() * 50)).map(() => Math.floor(rnd() * 256));
    const out = serializeRequest({ method, host, path, headers, body });
    const text = latin1(out);
    const end = text.indexOf("\r\n\r\n");
    assert(end > 0, "fin d'en-tête manquante");
    const head = text.slice(0, end);
    for (let k = 0; k < head.length; k++) {
      const c = head.charCodeAt(k);
      if (c === 13) assert(head.charCodeAt(k + 1) === 10, "CR isolé");
      else if (c === 10) assert(head.charCodeAt(k - 1) === 13, "LF isolé");
      else assert(c === 9 || (c >= 0x20 && c <= 0x7e), `octet ${c} dans l'en-tête`);
    }
    const lines = head.split("\r\n");
    eq(lines[0], `${method} ${path} HTTP/1.1`);
    eq(lines[1], `Host: ${host}`);
    for (let k = 0; k < headers.length; k++) eq(lines[2 + k], `${headers[k][0]}: ${headers[k][1]}`);
    const rest = lines.slice(2 + headers.length);
    const cl = body ? [`Content-Length: ${body.length}`] : method === "POST" ? ["Content-Length: 0"] : [];
    eq(rest, [...cl, "Accept-Encoding: identity"]);
    eq(out.subarray(end + 4), body ?? new Uint8Array(0));
  }
});

// ── Response parsing: valid responses ─────────────────────────────────────

test("réponse : 200 avec Content-Length, terminée sans attendre end()", () => {
  const p = new ResponseParser({ method: "POST" });
  eq(p.done, false);
  eq(p.response, null);
  p.push(b("HTTP/1.1 200 OK\r\nContent-Type: application/vnd.ms-sync.wbxml\r\nContent-Length: 5\r\n\r\nhell"));
  eq(p.done, false, "pas terminé avant le dernier octet");
  eq(p.response, null);
  p.push(b("o"));
  eq(p.done, true, "terminé au dernier octet du corps");
  eq(p.response, { status: 200, reason: "OK", headers: H(["content-type", "application/vnd.ms-sync.wbxml"], ["content-length", "5"]), body: b("hello") });
  p.end();
  p.end();
  eq(p.done, true, "end() après la fin : sans effet");
  p.push(new Uint8Array(0));
  eq(p.done, true, "push() vide : sans effet");
});

test("réponse : chunked avec extensions et trailers (ignorés)", () => {
  const r = parse(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
      "5;name=value\r\nhello\r\n" +
      "1A ; a = \"q\\\"; x\" ; b\r\n" + "abcdefghijklmnopqrstuvwxyz" + "\r\n" +
      "4\r\n\r\n\r\n\r\n" + // data that looks like line endings
      "0;last\r\nX-Trailer: t\r\nContent-Length: 999\r\n\r\n",
    { end: false },
  );
  eq(r.status, 200);
  eq(latin1(r.body), "helloabcdefghijklmnopqrstuvwxyz\r\n\r\n");
  eq(r.headers, H(["transfer-encoding", "chunked"]), "les trailers ne sont pas ajoutés aux en-têtes");
});

test("réponse : chunked sans données (bloc final seul) et tailles hexadécimales", () => {
  eq(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n").body, new Uint8Array(0));
  eq(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n000\r\n\r\n").body, new Uint8Array(0));
  const r = parse(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\na\r\n${"x".repeat(10)}\r\n0F\r\n${"y".repeat(15)}\r\n0\r\n\r\n`);
  eq(r.body.length, 25);
  const ext = `5;n="${ch(0xc3, 0xa9)}${ch(9)}\\${ch(0xff)}"`; // obs-text and quoted-pair in a quoted string
  eq(latin1(parse(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${ext}\r\nhello\r\n0\r\n\r\n`).body), "hello");
});

test("réponse : corps sans longueur annoncée refusé dès la fin des en-têtes", () => {
  // Ended only by the connection, it could not be told from a connection cut by the network.
  for (const text of ["HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n", "HTTP/1.1 200 OK\r\n\r\n", "HTTP/1.0 404 Not Found\r\nX-A: 1\r\n\r\n"]) {
    const p = new ResponseParser({ method: "POST" });
    const e = throws(() => p.push(b(`${text}body until close`)), isHttpError, show(text));
    assert(/longueur/.test(e.message), e.message);
    throws(() => p.end(), isHttpError, "toujours refusé à la fermeture");
    eq([p.done, p.response], [false, null]);
  }
});

test("réponse : HTTP/1.0 accepté", () => {
  eq(parse("HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok", { end: false }).body, b("ok"));
  const r = parse("HTTP/1.0 404 Not Found\r\nX-A: 1\r\nContent-Length: 4\r\n\r\ngone");
  eq([r.status, r.reason, latin1(r.body)], [404, "Not Found", "gone"]);
});

test("réponse : phrase de raison vide, nettoyée des contrôles et des caractères bidi", () => {
  eq(parse("HTTP/1.1 200 \r\nContent-Length: 0\r\n\r\n").reason, "");
  eq(parse("HTTP/1.1 503 Service  Unavailable \r\nContent-Length: 0\r\n\r\n").reason, "Service  Unavailable");
  const dirty = b("HTTP/1.1 400 ", [0x00, 0x42, 0x61, 0x1b, 0x64, 0x7f, 0x09, 0x52], [0xe2, 0x80, 0xae], [0xc2, 0x85], "eq", [0xff], "\r\nContent-Length: 0\r\n\r\n");
  eq(parse(dirty).reason, `Bad Req${ch(0xfffd)}`);
  eq(parse(b("HTTP/1.1 200 Tr", [0xc3, 0xa8], "s bien\r\nContent-Length: 0\r\n\r\n")).reason, `Tr${ch(0xe8)}s bien`);
});

test("réponse : en-têtes en minuscules, valeurs multiples dans l'ordre, OWS retirés", () => {
  const r = parse(
    b(
      "HTTP/1.1 200 OK\r\n",
      "Set-Cookie: a=1\r\n",
      "X-Mixed:value\r\n",
      "SET-COOKIE:   b=2 \t\r\n",
      "X-Empty:\r\n",
      "X-Blank: \t \r\n",
      "X-Inner: a \t b\r\n",
      "X-Utf8: caf", [0xc3, 0xa9], "\r\n",
      "X-Latin1: caf", [0xe9], "\r\n",
      "!#$%&'*+-.^_`|~09AZaz: tchar\r\n",
      "Content-Length: 0\r\n\r\n",
    ),
  );
  eq(
    r.headers,
    H(
      ["set-cookie", "a=1"],
      ["x-mixed", "value"],
      ["set-cookie", "b=2"],
      ["x-empty", ""],
      ["x-blank", ""],
      ["x-inner", "a \t b"],
      ["x-utf8", `caf${ch(0xe9)}`],
      ["x-latin1", `caf${ch(0xfffd)}`],
      ["!#$%&'*+-.^_`|~09azaz", "tchar"],
      ["content-length", "0"],
    ),
  );
  eq(r.headers.get("set-cookie"), ["a=1", "b=2"]);
});

test("réponse : headerValue (valeur unique, doublons identiques, conflit)", () => {
  const r = parse("HTTP/1.1 200 OK\r\nContent-Type: a\r\nX-Dup: same\r\nx-dup: same\r\nX-Conflict: 1\r\nX-Conflict: 2\r\nContent-Length: 0\r\n\r\n");
  eq(headerValue(r.headers, "Content-Type"), "a");
  eq(headerValue(r.headers, "CONTENT-TYPE"), "a");
  eq(headerValue(r.headers, "x-dup"), "same");
  eq(headerValue(r.headers, "X-Conflict"), null);
  eq(headerValue(r.headers, "X-Absent"), null);
  eq(headerValue(new Map([["x", []]]), "x"), null);
  eq(headerValue(null, "x"), null);
  eq(headerValue({ get: () => ["x"] }, "x"), null);
  eq(headerValue(r.headers, null), null);
  // ASCII-only case folding: the Kelvin sign is not a "k".
  eq(headerValue(new Map([["k", ["v"]]]), ch(0x212a)), null);
});

test("réponse : réponses intermédiaires 1xx ignorées (100, 102, 103, 199)", () => {
  const r = parse(
    "HTTP/1.1 100 Continue\r\n\r\n" +
      "HTTP/1.1 102 Processing\r\n\r\n" +
      "HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload\r\nContent-Length: 50\r\n\r\n" +
      "HTTP/1.1 199 Whatever\r\nTransfer-Encoding: chunked\r\n\r\n" +
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    { end: false },
  );
  eq(r, { status: 200, reason: "OK", headers: H(["content-length", "2"]), body: b("ok") }, "en-têtes des 1xx non conservés");
  refused("HTTP/1.1 100 Continue\r\n\r\n", {}, "1xx seule puis fermeture");
  for (const text of [
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
    "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 101 Switching Protocols\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
  ]) {
    const e = refused(text, {}, "101 (même suivi d'une réponse finale)");
    assert(e.message.includes("101"), e.message);
  }
  refused("HTTP/1.1 100 Continue\r\nX: a\r\n folded\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", {}, "en-têtes d'une 1xx vérifiés");
});

test("réponse : 204 et 304 sans corps, quels que soient les en-têtes", () => {
  for (const [method, text] of [
    ["POST", "HTTP/1.1 204 No Content\r\n\r\n"],
    ["POST", "HTTP/1.1 204 No Content\r\nTransfer-Encoding: chunked\r\n\r\n"],
    ["OPTIONS", "HTTP/1.1 304 Not Modified\r\nContent-Length: 50\r\n\r\n"],
  ]) {
    const p = new ResponseParser({ method });
    p.push(b(text));
    eq(p.done, true, `${method} ${text.slice(9, 12)} terminé à la ligne vide`);
    eq(p.response.body, new Uint8Array(0));
    throws(() => p.push(b("x")), isHttpError, "octet après une réponse sans corps");
  }
});

test("réponse : Content-Length: 0 terminée sans end(), OWS autour de la valeur", () => {
  eq(parse("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", { end: false }).body.length, 0);
  eq(parse("HTTP/1.1 200 OK\r\nContent-Length:3\r\n\r\nabc", { end: false }).body.length, 3);
  eq(parse("HTTP/1.1 200 OK\r\nContent-Length: \t3 \t\r\n\r\nabc", { end: false }).body.length, 3);
  eq(parse("HTTP/1.1 200 OK\r\nContent-Length: 0000000000000003\r\n\r\nabc", { end: false }).body.length, 3, "16 chiffres");
  eq(parse("HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 3\r\n\r\nabc", { end: false }).body.length, 3, "doublon identique");
});

test("réponse : Content-Encoding identity accepté, tout autre refusé", () => {
  for (const v of ["identity", "IDENTITY", "Identity"]) eq(parse(`HTTP/1.1 200 OK\r\nContent-Encoding: ${v}\r\nContent-Length: 0\r\n\r\n`).status, 200, v);
  for (const v of ["gzip", "deflate", "br", "compress", "x-gzip", "identity, gzip", "gzip, identity", "identity,", ""]) {
    refused(`HTTP/1.1 200 OK\r\nContent-Encoding: ${v}\r\nContent-Length: 0\r\n\r\n`, {}, `Content-Encoding: ${v}`);
  }
  refused("HTTP/1.1 200 OK\r\nContent-Encoding: identity\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n", {}, "deux Content-Encoding");
  refused("HTTP/1.1 204 No Content\r\nContent-Encoding: gzip\r\n\r\n", {}, "même sans corps");
});

test("réponse : les données sont copiées (l'appelant peut réutiliser son tampon)", () => {
  const p = new ResponseParser({});
  const data = b("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nabcdef");
  const buf = new Uint8Array(1);
  for (const x of data) {
    buf[0] = x;
    p.push(buf);
  }
  buf[0] = 0;
  eq(latin1(p.response.body), "abcdef");
  // Large pieces too: one 64-byte buffer reused for every piece of a 300-byte body.
  const p2 = new ResponseParser({});
  p2.push(b("HTTP/1.1 200 OK\r\nContent-Length: 300\r\n\r\n"));
  const piece = new Uint8Array(64);
  for (let at = 0; at < 300; at += 64) {
    piece.fill(0x41 + at / 64);
    p2.push(piece.subarray(0, Math.min(64, 300 - at)));
  }
  piece.fill(0);
  const expected = new Uint8Array(300);
  for (let k = 0; k < 300; k++) expected[k] = 0x41 + Math.floor(k / 64);
  eq(p2.response.body, expected);
  // Same for a chunked body (one chunk of 300 bytes).
  const p3 = new ResponseParser({});
  p3.push(b("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n12c\r\n"));
  for (let at = 0; at < 300; at += 64) {
    piece.fill(0x61 + at / 64);
    p3.push(piece.subarray(0, Math.min(64, 300 - at)));
  }
  piece.fill(0);
  p3.push(b("\r\n0\r\n\r\n"));
  for (let k = 0; k < 300; k++) expected[k] = 0x61 + Math.floor(k / 64);
  eq(p3.response.body, expected);
});

// ── Every split gives the same result ─────────────────────────────────────

const VALID = [
  ["POST", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"],
  ["POST", `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n1A\r\n${"x".repeat(26)}\r\n0\r\nX-Trailer: t\r\n\r\n`],
  ["POST", "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\nHTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"x\"\r\nContent-Length: 0\r\n\r\n"],
  ["POST", "HTTP/1.0 200 OK\r\nX-A: 1\r\nX-A: 2\r\nContent-Length: 4\r\n\r\nbody"],
  ["OPTIONS", "HTTP/1.1 200 OK\r\nMS-ASProtocolVersions: 2.5,12.0,12.1,14.0,14.1,16.0,16.1\r\nMS-ASProtocolCommands: Sync,SendMail\r\nContent-Length: 0\r\n\r\n"],
  ["POST", "HTTP/1.1 204 No Content\r\n\r\n"],
  ["POST", "HTTP/1.1 304 Not Modified\r\nContent-Length: 99\r\n\r\n"],
  ["POST", b("HTTP/1.1 200 ", [0xc3, 0xa9], "t", [0x01], "\r\nX-Name: caf", [0xc3, 0xa9], "\r\nContent-Length: 3\r\n\r\n", [0, 0xff, 0x0a])],
  ["POST", "HTTP/1.1 200 \r\nTransfer-Encoding: Chunked\r\n\r\n000001 ; a = \"q\\\"; x\" ; b\r\nZ\r\n0;last\r\n\r\n"],
];

const INVALID = [
  "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloX",
  "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
  "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhelloX\r\n0\r\n\r\n",
  "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\n0\r\n\r\n",
  "HTTP/1.1 200 OK\r\nX: a\r\n b\r\nContent-Length: 0\r\n\r\n",
  "HTTP/1.1 200 OK\nContent-Length: 0\r\n\r\n",
  `HTTP/1.1 200 OK\r\nX: a${NUL}b\r\nContent-Length: 0\r\n\r\n`,
  "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel",
  "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n000000001\r\nx\r\n0\r\n\r\n",
  "HTTP/1.0 200 OK\r\nX-A: 1\r\nX-A: 2\r\n\r\nbody until close",
];

test("réponse : résultat identique pour toute découpe (2 morceaux, octet par octet, aléatoire)", () => {
  const rnd = prng(7230);
  const cases = [...VALID.map(([method, text]) => [method, text, true]), ...INVALID.map((text) => ["POST", text, false])];
  for (const [method, text, valid] of cases) {
    const data = text instanceof Uint8Array ? text : b(text);
    const reference = outcome(data, { method });
    eq("response" in reference, valid, `${valid ? "valide" : "invalide"} attendu : ${show(data)} → ${reference.error}`);
    for (let cut = 0; cut <= data.length; cut++) eq(outcome(data, { method, sizes: [cut] }), reference, `coupure à ${cut} : ${show(data)}`);
    eq(outcome(data, { method, sizes: ones(data.length) }), reference, `octet par octet : ${show(data)}`);
    for (let k = 0; k < 20; k++) eq(outcome(data, { method, sizes: randomSizes(rnd, data.length) }), reference, `découpe aléatoire : ${show(data)}`);
  }
});

// ── Response parsing: errors ──────────────────────────────────────────────

test("erreurs : lignes d'état invalides", () => {
  for (const text of [
    "HTTP/1.1 200OK\r\n\r\n",
    "HTTP/1.2 200 OK\r\n\r\n",
    "HTTP/1.9 200 OK\r\n\r\n",
    "HTTP/2 200 OK\r\n\r\n",
    "HTTP/2.0 200 OK\r\n\r\n",
    "HTTP/0.9 200 OK\r\n\r\n",
    "http/1.1 200 OK\r\n\r\n",
    "HTTPS/1.1 200 OK\r\n\r\n",
    "HTTP/1.1  200 OK\r\n\r\n",
    " HTTP/1.1 200 OK\r\n\r\n",
    "HTTP/1.1 20 OK\r\n\r\n",
    "HTTP/1.1 2000 OK\r\n\r\n",
    "HTTP/1.1 2x0 OK\r\n\r\n",
    "HTTP/1.1 -20 OK\r\n\r\n",
    "HTTP/1.1 +20 OK\r\n\r\n",
    "HTTP/1.1 099 Low\r\n\r\n",
    "HTTP/1.1 000 Zero\r\n\r\n",
    "HTTP/1.1 600 High\r\n\r\n",
    "HTTP/1.1 999 High\r\n\r\n",
    `HTTP/1.1${ch(9)}200 OK\r\n\r\n`,
    `HTTP/1.1 200${ch(9)}OK\r\n\r\n`,
    "HTTP/1.10 200 OK\r\n\r\n",
    "HTTP/1.1 200 OK\n\r\n",
    "HTTP/1.1 200 OK\n\n",
    `HTTP/1.1 200 O${CR}K\r\n\r\n`,
    `HTTP/1.1 200 OK${CR}${CR}\n\r\n`,
    "\r\nHTTP/1.1 200 OK\r\n\r\n",
    "ICY 200 OK\r\n\r\n",
    "<html>hello</html>\r\n",
    "\r\n",
    "\n",
    b([0x16, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28]), // a TLS alert, as if TLS were not set up
  ]) {
    refused(text);
  }
});

test("erreurs : lignes d'en-tête invalides (obs-fold, espace avant « : », nom, contrôles)", () => {
  for (const line of [
    " X: folded-start",
    `${ch(9)}X: folded-start`,
    "X: a\r\n continued",
    `X: a\r\n${ch(9)}continued`,
    "X : a",
    `X${ch(9)}: a`,
    "X a: b",
    ": a",
    "X",
    `X-${ch(0xe9)}: a`,
    "X(1): a",
    "X/1: a",
    "X@: a",
    "X[: a",
    'X": a',
    "X,Y: a",
    "X;Y: a",
    "X=Y: a",
    "X?: a",
    "X{: a",
    `X: a${NUL}b`,
    `X: ${NUL}`,
    `X: ${ch(1)}`,
    `X: a${ch(0x0b)}`,
    `X: a${ch(0x0c)}`,
    `X: ${ch(0x1b)}[31m`,
    `X: a${ch(0x1f)}`,
    `X: a${DEL}`,
    `X: a${CR}b`,
    `X: a${CR}`,
    `X: a${LF}Y: b`,
    `Transfer-Encoding${NUL}: chunked`,
  ]) {
    refused(`HTTP/1.1 200 OK\r\n${line}\r\nContent-Length: 0\r\n\r\n`, {}, JSON.stringify(line));
  }
  refused("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\n", {}, "ligne vide finale en LF seul");
  refused("HTTP/1.1 200 OK\r\nContent-Length: 0\n\r\n", {}, "LF seul après un en-tête");
  refused(`HTTP/1.1 200 OK\r\nContent-Length: 0\r\n${CR}\r\n`, {}, "CR en trop dans la ligne vide");
});

test("erreurs : contrebande — Content-Length et Transfer-Encoding à la fois", () => {
  refused("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n");
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n5\r\nhello\r\n0\r\n\r\n");
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n0\r\n\r\n");
  refused("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nTransfer-Encoding: identity\r\n\r\n");
  // Refused as soon as the header section ends, before any body byte.
  const p = new ResponseParser({});
  throws(() => p.push(b("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n")), isHttpError);
});

test("erreurs : contrebande — Content-Length multiples ou mal formés", () => {
  for (const values of [["5", "6"], ["5", "05"], ["5", " 5", "6"], ["5", "5", "4"]]) {
    refused(`HTTP/1.1 200 OK\r\n${values.map((v) => `Content-Length: ${v}\r\n`).join("")}\r\nhello`, {}, `Content-Length ${values}`);
  }
  for (const v of ["5, 5", "5,5", "+5", "-1", "-0", "5.0", "0x10", "", "1e3", "5 5", "five", "00000000000000005", "99999999999999999999", `5${ch(0xd9, 0xa5)}`, `${ch(0xef, 0xbc, 0x95)}`]) {
    refused(`HTTP/1.1 200 OK\r\nContent-Length: ${v}\r\n\r\nhello`, {}, `Content-Length: ${JSON.stringify(v)}`);
  }
});

test("erreurs : contrebande — Transfer-Encoding autre que « chunked » exactement", () => {
  for (const v of ["Chunked", "CHUNKED", "chunked", "cHuNkEd"]) {
    eq(parse(`HTTP/1.1 200 OK\r\nTransfer-Encoding: ${v}\r\n\r\n0\r\n\r\n`).status, 200, v);
  }
  eq(parse(`HTTP/1.1 200 OK\r\nTransfer-Encoding:  chunked ${ch(9)}\r\n\r\n0\r\n\r\n`).status, 200, "OWS autour");
  for (const v of [
    "gzip",
    "chunked, gzip",
    "gzip, chunked",
    "chunked, chunked",
    "chunked,",
    ",chunked",
    "chunked,identity",
    "identity",
    "chunked;q=1",
    "chunked ;",
    "",
    "chun ked",
    "x-chunked",
    "chunkedx",
    `chun${ch(0xe2, 0x84, 0xaa)}ed`, // U+212A KELVIN SIGN, lowercased to "k" by toLowerCase()
    `CHUN${ch(0xe2, 0x84, 0xaa)}ED`,
    `chunked${ch(0x0b)}`,
  ]) {
    refused(`HTTP/1.1 200 OK\r\nTransfer-Encoding: ${v}\r\n\r\n0\r\n\r\n`, {}, `Transfer-Encoding: ${JSON.stringify(v)}`);
  }
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", {}, "deux lignes chunked");
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", {}, "gzip puis chunked");
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n ,chunked\r\n\r\n0\r\n\r\n", {}, "chunked par obs-fold");
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding : chunked\r\n\r\n0\r\n\r\n", {}, "espace avant les deux-points");
  refused("HTTP/1.0 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", {}, "Transfer-Encoding en HTTP/1.0");
});

test("erreurs : tailles de bloc négatives, signées, énormes ou mal écrites", () => {
  const chunked = (line) => `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${line}\r\nhello\r\n0\r\n\r\n`;
  for (const line of [
    "-1",
    "-0",
    "+5",
    " 5",
    `${ch(9)}5`,
    "5 ",
    `5${ch(9)}`,
    "0x5",
    "",
    "g",
    "5g",
    "5.0",
    "5,",
    "000000005",
    "FFFFFFFF",
    "FFFFFFFFFFFFFFFF",
    "7FFFFFFF",
    "1000001",
    `5${NUL}`,
    `5${CR}`,
    `5;${NUL}`,
    "5;",
    "5;=x",
    "5;a=",
    '5;a="unterminated',
    "5;a=b c",
    "5;a=b;",
    "5 ;a ",
    "5;a b",
    "5;a=b=c",
    "5;a=\"x\\",
    `5;a="${ch(1)}"`,
    `5;a="${DEL}"`,
    "5;a=\"x\"y",
    "5;(a)",
    `5;${ch(0xe9)}`,
  ]) {
    refused(chunked(line), {}, `taille ${JSON.stringify(line)}`);
  }
  for (const line of ["5", "05", "00000005", "5;a", "5;a=b", "5 ; a = b", '5;a="x;y \\" z"', "5;a;b=c;d=\"\"", "5\t;a"]) {
    eq(latin1(parse(chunked(line)).body), "hello", `taille ${JSON.stringify(line)}`);
  }
  // A huge size is refused at its line, before any data arrives.
  const p = new ResponseParser({});
  throws(() => p.push(b("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nFFFFFFFF\r\n")), isHttpError);
});

test("erreurs : CRLF manquant ou faux après les données d'un bloc", () => {
  for (const tail of ["helloX\n0\r\n\r\n", "hello\n\n0\r\n\r\n", "helloX\r\n0\r\n\r\n", "hello!\r\n0\r\n\r\n", "hello\n0\r\n\r\n", "hello\r0\r\n\r\n", "hello\r\r\n0\r\n\r\n", "hello0\r\n\r\n", "hell\r\n0\r\n\r\n", "hello\n\r0\r\n\r\n"]) {
    refused(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n${tail}`, {}, JSON.stringify(tail));
  }
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\nhello\r\n0\r\n\r\n", {}, "LF seul après la taille");
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\n\r\n", {}, "LF seul après le bloc final");
});

test("erreurs : trailers vérifiés comme des en-têtes", () => {
  eq(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-A: 1\r\nX-B:\r\n\r\n").status, 200);
  for (const trailer of [" X: folded", "X: a\r\n b", "X : a", "X", `X: a${NUL}`, `X: ${ch(0x1b)}`, `X: a${CR}b`, `X: a${LF}`]) {
    refused(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n${trailer}\r\n\r\n`, {}, `trailer ${JSON.stringify(trailer)}`);
  }
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX: 1\r\n\n", {}, "ligne vide finale en LF seul");
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n", {}, "ligne vide finale absente");
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX: 1\r\n", {}, "fermeture au milieu des trailers");
});

test("erreurs : réponse incomplète à la fermeture", () => {
  for (const text of [
    "",
    "H",
    "HTTP/1.1 200 OK",
    "HTTP/1.1 200 OK\r",
    "HTTP/1.1 200 OK\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n",
    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r",
    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhell",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n",
    "HTTP/1.1 100 Continue\r\n\r\n",
  ]) {
    const p = new ResponseParser({});
    p.push(b(text));
    eq(p.done, false, show(text));
    const e = throws(() => p.end(), isHttpError, show(text));
    assert(/fermée/.test(e.message), e.message);
  }
});

test("erreurs : octets après la fin de la réponse (pas de seconde réponse)", () => {
  for (const extra of ["x", "\r\n", "\n", NUL, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"]) {
    refused(`HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello${extra}`, {}, `après CL : ${JSON.stringify(extra)}`);
    refused(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n${extra}`, {}, `après chunked : ${JSON.stringify(extra)}`);
    refused(`HTTP/1.1 204 No Content\r\n\r\n${extra}`, {}, `après 204 : ${JSON.stringify(extra)}`);
  }
  const p = new ResponseParser({});
  p.push(b("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
  eq(p.done, true);
  throws(() => p.push(b("H")), isHttpError);
  eq(p.done, false, "une réponse suivie de données en trop n'est plus exposée");
  eq(p.response, null);
});

test("erreurs : l'erreur est persistante, done reste faux", () => {
  const p = new ResponseParser({});
  const first = throws(() => p.push(b("HTTP/1.1 200 OK\r\nX : a\r\n")), isHttpError);
  for (const call of [() => p.push(b("Content-Length: 0\r\n\r\n")), () => p.push(new Uint8Array(0)), () => p.end(), () => p.push("x")]) {
    const again = throws(call, isHttpError);
    assert(again === first, "même erreur à chaque appel");
  }
  eq(p.done, false);
  eq(p.response, null);
});

test("erreurs : arguments invalides de push(), push() après end()", () => {
  for (const arg of ["HTTP/1.1", null, undefined, 42, [72, 84], new ArrayBuffer(4), new Uint16Array(2), new Uint8ClampedArray(2), new DataView(new ArrayBuffer(2))]) {
    const p = new ResponseParser({});
    throws(() => p.push(arg), isHttpError, Object.prototype.toString.call(arg));
  }
  const p = new ResponseParser({});
  p.push(b("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc"));
  p.end();
  eq(latin1(p.response.body), "abc");
  throws(() => p.push(b("d")), isHttpError, "push() après end()");
});

test("erreurs : options invalides du constructeur", () => {
  for (const options of [null, 42, "POST"]) throws(() => new ResponseParser(options), isHttpError, `options ${options}`);
  for (const method of ["", "PO ST", "CONNECT", "HEAD", 42, null, `GET${CR}`]) throws(() => new ResponseParser({ method }), isHttpError, `méthode ${method}`);
  for (const limits of [42, "x", { maxBodyBytes: -1 }, { maxBodyBytes: 1.5 }, { maxBodyBytes: "10" }, { maxBodyBytes: NaN }, { maxBodyBytes: Infinity }, { maxBodyByte: 10 }, [1]]) {
    throws(() => new ResponseParser({ limits }), isHttpError, `limites ${JSON.stringify(limits)}`);
  }
  new ResponseParser();
  new ResponseParser({});
  new ResponseParser({ method: "OPTIONS", limits: null });
  new ResponseParser({ limits: {} });
});

// ── Limits: exactly at and one past ───────────────────────────────────────

test("limites : valeurs par défaut figées", () => {
  eq(HTTP_LIMITS.maxStatusLine, 8 * 1024);
  eq(HTTP_LIMITS.maxHeaderBytes, 64 * 1024);
  eq(HTTP_LIMITS.maxHeaders, 100);
  eq(HTTP_LIMITS.maxBodyBytes, 16 * 1024 * 1024);
  eq(HTTP_LIMITS.maxChunkSizeDigits, 8);
  eq(HTTP_LIMITS.maxTrailerBytes, 8 * 1024);
  assert(Object.isFrozen(HTTP_LIMITS), "HTTP_LIMITS figé");
});

test("limites : ligne d'état (CRLF compris) à la limite acceptée, un octet de plus refusé", () => {
  const line = (n) => `HTTP/1.1 200 ${"R".repeat(n - 15)}\r\n`;
  const limits = { maxStatusLine: 64 };
  eq(line(64).length, 64);
  eq(parse(`${line(64)}Content-Length: 0\r\n\r\n`, { limits }).status, 200);
  refused(`${line(65)}Content-Length: 0\r\n\r\n`, { limits });
  eq(parse(`${line(8192)}Content-Length: 0\r\n\r\n`).reason.length, 8192 - 15, "défaut : 8192");
  refused(`${line(8193)}Content-Length: 0\r\n\r\n`, {}, "défaut : 8193");
  // Refused as soon as the line cannot fit, without waiting for its end.
  const p = new ResponseParser({ limits });
  p.push(b(`HTTP/1.1 200 ${"R".repeat(50)}`)); // 63 bytes
  throws(() => p.push(b("R")), isHttpError);
  const q = new ResponseParser({ limits });
  q.push(b(`HTTP/1.1 200 ${"R".repeat(49)}`));
  q.push(b("\r"));
  q.push(b("\n"));
  q.push(b("Content-Length: 0\r\n\r\n"));
  eq(q.done, true);
});

test("limites : section d'en-têtes (ligne vide comprise) à la limite acceptée, un octet de plus refusé", () => {
  const section = (n) => `X: ${"v".repeat(n - 7)}\r\n\r\n`;
  const limits = { maxHeaderBytes: 100 };
  eq(section(100).length, 100);
  eq(parse(`HTTP/1.1 204 No Content\r\n${section(100)}`, { limits }).headers.get("x")[0].length, 93);
  refused(`HTTP/1.1 204 No Content\r\n${section(101)}`, { limits });
  eq(parse("HTTP/1.1 204 No Content\r\n\r\n", { limits: { maxHeaderBytes: 2 } }).status, 204, "section vide : 2 octets");
  refused("HTTP/1.1 204 No Content\r\n\r\n", { limits: { maxHeaderBytes: 1 } });
  // Several lines: the total counts.
  const lines = `A: 1\r\nB: 2\r\nC: ${"c".repeat(81)}\r\n\r\n`;
  eq(lines.length, 100);
  eq(parse(`HTTP/1.1 204 No Content\r\n${lines}`, { limits }).headers.size, 3);
  refused(`HTTP/1.1 204 No Content\r\nA: 10\r\nB: 2\r\nC: ${"c".repeat(81)}\r\n\r\n`, { limits });
  // Each interim response has its own budget.
  eq(parse(`HTTP/1.1 100 Continue\r\n${section(100)}HTTP/1.1 204 No Content\r\n${section(100)}`, { limits }).status, 204);
  refused(`HTTP/1.1 100 Continue\r\n${section(101)}HTTP/1.1 204 No Content\r\n\r\n`, { limits });
  // Default.
  eq(parse(`HTTP/1.1 204 No Content\r\n${section(65536)}`).status, 204, "défaut : 65536");
  refused(`HTTP/1.1 204 No Content\r\n${section(65537)}`, {}, "défaut : 65537");
  // Refused as soon as the budget is exceeded, even without a LF.
  const p = new ResponseParser({ limits });
  p.push(b(`HTTP/1.1 200 OK\r\nX: ${"v".repeat(96)}`)); // 99 bytes of the section
  throws(() => p.push(b("v")), isHttpError);
});

test("limites : nombre de lignes d'en-tête à la limite accepté, une de plus refusée", () => {
  const head = (n) => `HTTP/1.1 204 No Content\r\n${Array.from({ length: n }, (_, k) => `X-${k}: ${k}\r\n`).join("")}\r\n`;
  eq(parse(head(3), { limits: { maxHeaders: 3 } }).headers.size, 3);
  refused(head(4), { limits: { maxHeaders: 3 } });
  eq(parse(head(0), { limits: { maxHeaders: 0 } }).status, 204);
  refused(head(1), { limits: { maxHeaders: 0 } });
  eq(parse(head(100)).headers.size, 100, "défaut : 100");
  refused(head(101), {}, "défaut : 101");
  // Repeated names count as lines, not as distinct names.
  refused(`HTTP/1.1 204 No Content\r\n${"Set-Cookie: a\r\n".repeat(4)}\r\n`, { limits: { maxHeaders: 3 } });
  // Interim responses are counted separately.
  eq(parse(head(3).replace("204 No Content", "100 Continue") + head(3), { limits: { maxHeaders: 3 } }).status, 204);
});

test("limites : corps (Content-Length, chunked) à la limite accepté, un octet de plus refusé", () => {
  const limits = { maxBodyBytes: 10 };
  eq(parse("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789", { limits }).body.length, 10);
  const p = new ResponseParser({ limits });
  throws(() => p.push(b("HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n")), isHttpError, "Content-Length refusé avant le corps");

  eq(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n6\r\nefghij\r\n0\r\n\r\n", { limits }).body.length, 10);
  const q = new ResponseParser({ limits });
  q.push(b("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n"));
  throws(() => q.push(b("7\r\n")), isHttpError, "bloc refusé dès sa taille");
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nB\r\n", { limits });

  // Default: 16 MiB.
  const max = 16 * 1024 * 1024;
  const s = new ResponseParser({});
  s.push(b(`HTTP/1.1 200 OK\r\nContent-Length: ${max}\r\n\r\n`));
  s.push(new Uint8Array(max - 1));
  eq(s.done, false);
  s.push(new Uint8Array(1));
  eq(s.response.body.length, max);
  throws(() => new ResponseParser({}).push(b(`HTTP/1.1 200 OK\r\nContent-Length: ${max + 1}\r\n\r\n`)), isHttpError, "défaut : 16 Mio + 1");
});

test("limites : chiffres de la taille de bloc à la limite acceptés, un de plus refusé", () => {
  const chunked = (size, n) => `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${size}\r\n${"x".repeat(n)}\r\n0\r\n\r\n`;
  eq(parse(chunked("0000000A", 10)).body.length, 10, "8 chiffres");
  refused(chunked("00000000A", 10), {}, "9 chiffres");
  eq(parse(chunked("FF", 255), { limits: { maxChunkSizeDigits: 2 } }).body.length, 255);
  refused(chunked("0FF", 255), { limits: { maxChunkSizeDigits: 2 } });
  refused(chunked("100", 256), { limits: { maxChunkSizeDigits: 2 } });
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n000\r\n\r\n", { limits: { maxChunkSizeDigits: 2 } }, "bloc final aussi");
});

test("limites : extensions de bloc à la limite acceptées, un octet de plus refusé", () => {
  const chunked = (ext) => `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5${ext}\r\nhello\r\n0\r\n\r\n`;
  const limits = { maxChunkExtBytes: 10 };
  eq(parse(chunked(`;${"a".repeat(9)}`), { limits }).body.length, 5);
  refused(chunked(`;${"a".repeat(10)}`), { limits });
  eq(parse(chunked(`;${"a".repeat(1023)}`)).body.length, 5, "défaut : 1024");
  refused(chunked(`;${"a".repeat(1024)}`), {}, "défaut : 1025");
});

test("limites : trailers (ligne vide comprise) à la limite acceptés, un octet de plus refusés", () => {
  const tail = (n) => `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX: ${"t".repeat(n - 7)}\r\n\r\n`;
  const limits = { maxTrailerBytes: 20 };
  eq(parse(tail(20), { limits }).status, 200);
  refused(tail(21), { limits });
  eq(parse("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", { limits: { maxTrailerBytes: 2 } }).status, 200);
  refused("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", { limits: { maxTrailerBytes: 1 } });
  eq(parse(tail(8192)).status, 200, "défaut : 8192");
  refused(tail(8193), {}, "défaut : 8193");
});

test("limites : réponses intermédiaires à la limite acceptées, une de plus refusée", () => {
  const limits = { maxInterimResponses: 2 };
  const final = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
  eq(parse(`${"HTTP/1.1 100 Continue\r\n\r\n".repeat(2)}${final}`, { limits }).status, 200);
  refused(`${"HTTP/1.1 100 Continue\r\n\r\n".repeat(3)}${final}`, { limits });
  eq(parse(`${"HTTP/1.1 102 Processing\r\n\r\n".repeat(16)}${final}`).status, 200, "défaut : 16");
  refused(`${"HTTP/1.1 102 Processing\r\n\r\n".repeat(17)}${final}`, {}, "défaut : 17");
});

test("limites : fusionnées sur les valeurs par défaut", () => {
  // Only maxBodyBytes changes: the default status line limit still applies.
  const limits = { maxBodyBytes: 3 };
  refused("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabcd", { limits });
  eq(parse(`HTTP/1.1 200 ${"R".repeat(8000)}\r\nContent-Length: 3\r\n\r\nabc`, { limits }).body.length, 3);
  refused(`HTTP/1.1 200 ${"R".repeat(8200)}\r\nContent-Length: 3\r\n\r\nabc`, { limits });
});
