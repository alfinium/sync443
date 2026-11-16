// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Fuzzing of the HTTP/1.1 response parser and request serializer, with
 * fixed seeds (reproducible):
 *  1. random byte streams biased toward HTTP syntax;
 *  2. random mutations of valid responses;
 *  3. random valid responses under random limits: whether each must be
 *     accepted or refused is computed from its exact sizes;
 *  4. endless streams of every kind: refused within the limits, no hang;
 *  5. performance: 16 MiB bodies pushed in tiny pieces, in linear time;
 *  6. random request fields: refused, or a well-formed request.
 * The parser must return a response within the limits or throw an
 * HttpError (never another exception), with the same result for any split
 * of the input (whole, byte by byte, random pieces).
 */

import { test, assert, eq, prng } from "./harness.mjs";
import { ResponseParser, HttpError, HTTP_LIMITS, serializeRequest } from "../../src/core/http1.mjs";

const ch = (...codes) => String.fromCharCode(...codes);

function b(...parts) {
  const list = [];
  for (const p of parts) {
    if (typeof p === "string") for (let k = 0; k < p.length; k++) list.push(p.charCodeAt(k) & 0xff);
    else for (const x of p) list.push(x);
  }
  return new Uint8Array(list);
}

const hex = (bytes) => Array.from(bytes.subarray(0, 80), (x) => x.toString(16).padStart(2, "0")).join(" ") + (bytes.length > 80 ? " …" : "");
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const ones = (n) => new Array(n).fill(1);

function randomSizes(rnd, total) {
  const sizes = [];
  let left = total;
  while (left > 0) {
    const n = 1 + Math.floor(rnd() * Math.min(left, rnd() < 0.5 ? 3 : 40));
    sizes.push(n);
    left -= n;
  }
  return sizes;
}

const TIGHT = Object.freeze({
  maxStatusLine: 96,
  maxHeaderBytes: 384,
  maxHeaders: 10,
  maxBodyBytes: 1024,
  maxChunkSizeDigits: 4,
  maxTrailerBytes: 96,
  maxChunkExtBytes: 24,
  maxInterimResponses: 3,
});

const TCHAR_LOWER = new Set("!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyz");
const isBidiOrInvisible = (x) =>
  x === 0x061c || x === 0x200e || x === 0x200f || (x >= 0x202a && x <= 0x202e) || (x >= 0x2066 && x <= 0x2069) || x === 0x00ad || (x >= 0x200b && x <= 0x200d) || x === 0x2060 || x === 0xfeff;

/** Invariants of every accepted response. */
function checkResponse(r, L, data) {
  const where = ` pour [${hex(data)}]`;
  assert(Number.isInteger(r.status) && r.status >= 200 && r.status <= 599, `statut final ${r.status}${where}`);
  assert(typeof r.reason === "string" && r.reason === r.reason.trim(), `raison non nettoyée${where}`);
  for (const c of r.reason) {
    const x = c.codePointAt(0);
    assert(!(x < 0x20 || (x >= 0x7f && x <= 0x9f) || x === 0x2028 || x === 0x2029 || isBidiOrInvisible(x)), `caractère ${x} dans la raison${where}`);
  }
  assert(r.headers instanceof Map, `headers doit être une Map${where}`);
  let lines = 0;
  for (const [name, values] of r.headers) {
    assert(name.length > 0 && Array.from(name).every((c) => TCHAR_LOWER.has(c)), `nom d'en-tête ${JSON.stringify(name)}${where}`);
    assert(Array.isArray(values) && values.length > 0, `valeurs de ${name}${where}`);
    for (const v of values) {
      lines++;
      assert(typeof v === "string", `valeur de ${name}${where}`);
      for (let k = 0; k < v.length; k++) {
        const c = v.charCodeAt(k);
        assert(c === 9 || (c >= 0x20 && c !== 0x7f), `contrôle ${c} dans ${name}${where}`);
      }
      assert(!/^[ \t]|[ \t]$/.test(v), `OWS non retiré dans ${name}${where}`);
    }
  }
  assert(lines <= L.maxHeaders, `maxHeaders dépassé (${lines})${where}`);
  assert(r.body instanceof Uint8Array && r.body.length <= L.maxBodyBytes, `maxBodyBytes dépassé${where}`);
  const noBody = r.status === 204 || r.status === 304;
  if (noBody) {
    eq(r.body.length, 0, `corps d'une réponse sans corps${where}`);
  } else {
    const te = r.headers.get("transfer-encoding");
    const cl = r.headers.get("content-length");
    if (te) {
      assert(te.length === 1 && asciiLower(te[0]) === "chunked" && !cl, `Transfer-Encoding accepté : ${te}${where}`);
    } else if (cl) {
      assert(cl.every((v) => v === cl[0]) && /^[0-9]+$/.test(cl[0]), `Content-Length accepté : ${cl}${where}`);
      eq(r.body.length, Number(cl[0]), `longueur du corps${where}`);
    } else {
      assert(false, `corps sans longueur annoncée accepté${where}`);
    }
  }
  for (const v of r.headers.get("content-encoding") ?? []) eq(asciiLower(v), "identity", `Content-Encoding accepté${where}`);
}

/**
 * Parses `data` in the given pieces, then end(). Returns { response } or
 * { error: message }; anything but an HttpError fails the test, as does an
 * internal error, a slow parse, or a broken invariant.
 */
function run(data, { limits = TIGHT, sizes = null } = {}) {
  const started = Date.now();
  const p = new ResponseParser({ method: "POST", limits });
  let error = null;
  try {
    let at = 0;
    if (sizes) {
      for (const n of sizes) {
        p.push(data.subarray(at, at + n));
        at += n;
      }
    }
    if (at < data.length) p.push(data.subarray(at));
    p.end();
  } catch (e) {
    error = e;
  }
  const ms = Date.now() - started;
  assert(ms < 1000, `analyse trop lente (${ms} ms) pour [${hex(data)}]`);
  if (error) {
    if (!(error instanceof HttpError)) throw new Error(`exception inattendue ${error?.name}: ${error?.message} pour [${hex(data)}]`);
    assert(error.cause === undefined, `erreur interne (${error.cause?.name}: ${error.cause?.message}) pour [${hex(data)}]`);
    assert(!p.done && p.response === null, `réponse exposée après une erreur pour [${hex(data)}]`);
    let again = null;
    try {
      p.end();
    } catch (e) {
      again = e;
    }
    assert(again === error, "erreur non persistante");
    return { error: error.message };
  }
  assert(p.done, `end() accepté mais réponse non terminée pour [${hex(data)}]`);
  checkResponse(p.response, { ...HTTP_LIMITS, ...limits }, data);
  return { response: p.response };
}

/** Same result whole, byte by byte and in random pieces. */
function runAllSplits(data, opts, rnd) {
  const reference = run(data, opts);
  eq(run(data, { ...opts, sizes: ones(data.length) }), reference, `octet par octet [${hex(data)}]`);
  eq(run(data, { ...opts, sizes: randomSizes(rnd, data.length) }), reference, `découpe aléatoire [${hex(data)}]`);
  return reference;
}

// ── 1. Random byte streams ────────────────────────────────────────────────

const PIECES = [
  "HTTP/1.1 ",
  "HTTP/1.0 ",
  "HTTP/1.1 200 OK\r\n",
  "HTTP/1.1 100 Continue\r\n\r\n",
  "HTTP/1.1 204 No Content\r\n",
  "200 ",
  "204 ",
  "304 ",
  "100 ",
  "101 ",
  "OK",
  "\r\n",
  "\r\n",
  "\r\n",
  "\r\n\r\n",
  "\n",
  "\r",
  ":",
  ": ",
  " ",
  "\t",
  "Content-Length: ",
  "Transfer-Encoding: ",
  "Content-Encoding: ",
  "chunked",
  "identity",
  "gzip",
  ",",
  ";",
  "=",
  '"',
  "\\",
  "0",
  "1",
  "5",
  "a",
  "F",
  "ffff",
  "00000",
  "\r\n0\r\n\r\n",
  "X-A",
  ch(0),
  ch(0x7f),
  ch(0xc3, 0xa9),
  ch(0xe2, 0x80, 0xae),
];

test("fuzz http1 : flux d'octets aléatoires, HttpError ou réponse valide, même résultat pour toute découpe", () => {
  const rnd = prng(0x1f1);
  const stats = { accepted: 0, refused: 0 };
  for (let round = 0; round < 2500; round++) {
    let s = rnd() < 0.6 ? "HTTP/1.1 200 OK\r\n" : "";
    const n = 1 + Math.floor(rnd() * 60);
    for (let k = 0; k < n; k++) s += rnd() < 0.85 ? PIECES[Math.floor(rnd() * PIECES.length)] : ch(Math.floor(rnd() * 256));
    // A body must announce its length: for half the streams, what follows the first empty line gets one.
    if (rnd() < 0.5) {
      const end = s.indexOf("\r\n\r\n");
      if (end >= 0) s = `${s.slice(0, end + 2)}Content-Length: ${s.length - end - 4}\r\n${s.slice(end + 2)}`;
    }
    const result = runAllSplits(b(s), {}, rnd);
    if (result.response) stats.accepted++;
    else stats.refused++;
  }
  assert(stats.accepted > 25 && stats.refused > 1000, `exploration trop pauvre : ${JSON.stringify(stats)}`);
});

// ── 2. Mutations of valid responses ───────────────────────────────────────

const CORPUS = [
  "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.ms-sync.wbxml\r\nContent-Length: 12\r\n\r\n\x03\x01j\x00\x00\x07VR\x030\x00\x01",
  "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-A: 1\r\n\r\n5;e=1\r\nhello\r\n4\r\n abc\r\n0\r\nT: v\r\n\r\n",
  "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"x\"\r\nContent-Length: 0\r\n\r\n",
  "HTTP/1.0 200 OK\r\nX-A: 1\r\nX-A: 2\r\nContent-Length: 4\r\n\r\nbody",
  "HTTP/1.1 204 No Content\r\nX-B: b\r\n\r\n",
  "HTTP/1.1 304 Not Modified\r\nContent-Length: 50\r\n\r\n",
  "HTTP/1.1 449 Retry after sending a PROVISION command\r\nContent-Length: 0\r\nMS-Server-ActiveSync: 15.1\r\n\r\n",
  "HTTP/1.1 200 OK\r\nMS-ASProtocolVersions: 2.5,12.0,12.1,14.0,14.1,16.0,16.1\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nok",
  "HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\nHTTP/1.1 200 \r\nTransfer-Encoding: Chunked\r\n\r\n001 ; a = \"q\\\"\"\r\nZ\r\n0\r\n\r\n",
];
const INTERESTING = [0x0d, 0x0a, 0x20, 0x09, 0x3a, 0x3b, 0x2c, 0x3d, 0x22, 0x5c, 0x30, 0x31, 0x39, 0x66, 0x46, 0x2d, 0x2b, 0x00, 0x7f, 0x80, 0xff];
const INSERTS = ["\r\n", "\n", "\r", " ", "\t", "Content-Length: 1\r\n", "Content-Length: 0\r\n", "Transfer-Encoding: chunked\r\n", "Transfer-Encoding: gzip\r\n", "Content-Encoding: gzip\r\n", "HTTP/1.1 100 Continue\r\n\r\n", "0\r\n\r\n", "FFFF", ";x=y", " folded\r\n"];

function mutate(base, rnd) {
  let a = Array.from(base);
  const int = (n) => Math.floor(rnd() * n);
  const ops = 1 + int(3);
  for (let k = 0; k < ops; k++) {
    const at = int(a.length + 1);
    switch (int(7)) {
      case 0:
        if (a.length) a[Math.min(at, a.length - 1)] = int(256);
        break;
      case 1:
        if (a.length) a[Math.min(at, a.length - 1)] = INTERESTING[int(INTERESTING.length)];
        break;
      case 2:
        a.splice(at, 0, INTERESTING[int(INTERESTING.length)]);
        break;
      case 3:
        a.splice(at, 0, ...b(INSERTS[int(INSERTS.length)]));
        break;
      case 4:
        a.splice(at, 1 + int(8));
        break;
      case 5: {
        const len = 1 + int(16);
        a.splice(int(a.length + 1), 0, ...a.slice(at, at + len));
        break;
      }
      default:
        a = a.slice(0, at);
    }
  }
  return new Uint8Array(a);
}

test("fuzz http1 : mutations de réponses valides, HttpError ou réponse valide, même résultat pour toute découpe", () => {
  const rnd = prng(9112);
  const bases = CORPUS.map((s) => b(s));
  for (const base of bases) assert(run(base, { limits: HTTP_LIMITS }).response, `corpus invalide : [${hex(base)}]`);
  const stats = { accepted: 0, refused: 0 };
  for (let round = 0; round < 5000; round++) {
    const data = mutate(bases[Math.floor(rnd() * bases.length)], rnd);
    const limits = rnd() < 0.5 ? TIGHT : HTTP_LIMITS;
    const result = runAllSplits(data, { limits }, rnd);
    if (result.response) stats.accepted++;
    else stats.refused++;
  }
  assert(stats.accepted > 400 && stats.refused > 2000, `exploration trop pauvre : ${JSON.stringify(stats)}`);
});

// ── 3. Valid responses under random limits ────────────────────────────────

const TOKEN_CHARS = "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const FRAMING_NAMES = new Set(["content-length", "transfer-encoding", "content-encoding"]);

/**
 * A random valid response, with what it needs from each limit (the
 * smallest value of each limit that accepts it) and the expected result.
 */
function genResponse(rnd) {
  const int = (n) => Math.floor(rnd() * n);
  const pick = (arr) => arr[int(arr.length)];
  const need = {};
  for (const key of Object.keys(HTTP_LIMITS)) need[key] = 0;
  const grow = (key, v) => {
    if (v > need[key]) need[key] = v;
  };
  let wire = "";
  const pad = () => pick(["", "", " ", "\t", " \t "]);
  const word = (alphabet, min, max) => {
    let s = "";
    const n = min + int(max - min + 1);
    for (let k = 0; k < n; k++) s += alphabet[int(alphabet.length)];
    return s;
  };
  const reasonText = () => (rnd() < 0.2 ? "" : Array.from({ length: 1 + int(3) }, () => word("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 1, 8)).join(" "));
  /** [wire bytes, decoded value]: visible ASCII, inner blanks, sometimes "é" in UTF-8. */
  const value = () => {
    let w = "";
    let d = "";
    const n = int(20);
    for (let k = 0; k < n; k++) {
      const r = rnd();
      if (r < 0.1) {
        w += ch(0xc3, 0xa9);
        d += ch(0xe9);
      } else {
        const c = r < 0.2 && k > 0 && k < n - 1 ? pick([" ", "\t"]) : ch(0x21 + int(0x5e));
        w += c;
        d += c;
      }
    }
    return [w, d];
  };
  const randomFields = (count) => {
    const fields = [];
    for (let k = 0; k < count; k++) {
      let name = word(TOKEN_CHARS, 1, 10);
      if (FRAMING_NAMES.has(asciiLower(name))) name = `X-${name}`;
      fields.push([name, ...value()]);
    }
    return fields;
  };
  const statusLine = (version, code, reason) => {
    const line = `HTTP/1.${version} ${code} ${reason}\r\n`;
    grow("maxStatusLine", line.length);
    wire += line;
  };
  const section = (fields) => {
    let bytes = 2;
    for (const [name, w] of fields) {
      const line = `${name}:${pad()}${w}${pad()}\r\n`;
      wire += line;
      bytes += line.length;
    }
    wire += "\r\n";
    grow("maxHeaderBytes", bytes);
    grow("maxHeaders", fields.length);
  };

  const interim = rnd() < 0.7 ? 0 : 1 + int(3);
  need.maxInterimResponses = interim;
  for (let k = 0; k < interim; k++) {
    statusLine(pick(["1", "0"]), pick([100, 102, 103, 199]), reasonText());
    section(randomFields(int(4)));
  }

  const status = pick([200, 200, 200, 201, 204, 206, 304, 400, 401, 403, 404, 449, 451, 500, 503]);
  const noBody = status === 204 || status === 304;
  const framing = noBody ? pick(["none", "ignored-length"]) : pick(["length", "length2", "chunked"]);
  const body = new Uint8Array(int(4) === 0 ? 0 : int(300)).map(() => int(256));
  const reason = reasonText();
  statusLine(framing === "chunked" || rnd() < 0.8 ? "1" : "0", status, reason);

  const fields = randomFields(int(6));
  const insert = (field) => fields.splice(int(fields.length + 1), 0, field);
  const digitsOf = (n) => {
    const h = n.toString(16);
    return "0".repeat(int(3)) + (rnd() < 0.5 ? h : h.toUpperCase());
  };
  if (framing === "length" || framing === "length2") {
    const v = rnd() < 0.2 ? `00${body.length}` : String(body.length);
    insert(["Content-Length", v, v]);
    if (framing === "length2") insert([pick(["content-length", "CONTENT-LENGTH"]), v, v]);
  } else if (framing === "ignored-length") {
    const v = String(int(1e9));
    insert(["Content-Length", v, v]);
  } else if (framing === "chunked") {
    const v = pick(["chunked", "Chunked", "CHUNKED"]);
    insert(["Transfer-Encoding", v, v]);
  }
  if (rnd() < 0.2) insert(["Content-Encoding", "identity", "identity"]);
  section(fields);

  let expectedBody = new Uint8Array(0);
  const latin1 = (bytes) => {
    let s = "";
    for (const x of bytes) s += ch(x);
    return s;
  };
  if (framing === "length" || framing === "length2") {
    wire += latin1(body);
    expectedBody = body;
    need.maxBodyBytes = body.length;
  } else if (framing === "chunked") {
    const ext = () => (rnd() < 0.7 ? "" : pick([";a", ";a=b", ' ; name="v a l"', ";x;y=z", "\t;q", `;${"e".repeat(1 + int(40))}`]));
    let at = 0;
    while (at < body.length) {
      const size = Math.min(body.length - at, 1 + int(64));
      const d = digitsOf(size);
      const e = ext();
      grow("maxChunkSizeDigits", d.length);
      grow("maxChunkExtBytes", e.length);
      wire += `${d}${e}\r\n${latin1(body.subarray(at, at + size))}\r\n`;
      at += size;
    }
    const last = "0".repeat(1 + int(2));
    const e = ext();
    grow("maxChunkSizeDigits", last.length);
    grow("maxChunkExtBytes", e.length);
    wire += `${last}${e}\r\n`;
    let trailer = 2;
    for (const [name, w] of randomFields(int(3))) {
      const line = `${name}: ${w}\r\n`;
      wire += line;
      trailer += line.length;
    }
    wire += "\r\n";
    need.maxTrailerBytes = trailer;
    expectedBody = body;
    need.maxBodyBytes = body.length;
  }

  const headers = new Map();
  for (const [name, , d] of fields) {
    const key = asciiLower(name);
    if (!headers.has(key)) headers.set(key, []);
    headers.get(key).push(d);
  }
  return { data: b(wire), need, expected: { status, reason, headers, body: expectedBody } };
}

test("fuzz http1 : réponses valides aléatoires sous des limites aléatoires (acceptée ssi chaque limite suffit)", () => {
  const rnd = prng(0x9112);
  const stats = { accepted: 0, refused: 0 };
  for (let round = 0; round < 2500; round++) {
    const { data, need, expected } = genResponse(rnd);
    const limits = {};
    for (const key of Object.keys(need)) {
      const r = rnd();
      if (r < 0.04 && need[key] > 0) limits[key] = need[key] - 1;
      else if (r < 0.35) limits[key] = need[key];
      else if (r < 0.45) limits[key] = need[key] + 1;
    }
    const effective = { ...HTTP_LIMITS, ...limits };
    const fits = Object.keys(need).every((key) => need[key] <= effective[key]);
    const result = runAllSplits(data, { limits }, rnd);
    if (fits) {
      eq(result, { response: expected }, `réponse attendue (limites ${JSON.stringify(limits)}) pour [${hex(data)}]`);
      stats.accepted++;
    } else {
      assert(result.error, `limite dépassée mais réponse acceptée : besoins ${JSON.stringify(need)}, limites ${JSON.stringify(limits)} pour [${hex(data)}]`);
      stats.refused++;
    }
  }
  assert(stats.accepted > 1000 && stats.refused > 300, `exploration trop pauvre : ${JSON.stringify(stats)}`);
});

// ── 4. Endless streams ────────────────────────────────────────────────────

/** Pushes `prefix`, then `unit` over and over: must throw an HttpError within `bound` bytes. */
function endless(prefix, unit, bound, limits = HTTP_LIMITS) {
  const p = new ResponseParser({ limits });
  const block = b(unit.repeat(Math.max(1, Math.floor(4096 / unit.length))));
  let pushed = 0;
  const started = Date.now();
  try {
    p.push(b(prefix));
    pushed += prefix.length;
    while (pushed <= bound + block.length) {
      p.push(block);
      pushed += block.length;
    }
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    assert(Date.now() - started < 2000, `trop lent pour ${JSON.stringify(unit)}`);
    return e;
  }
  throw new Error(`aucune erreur après ${pushed} octets pour ${JSON.stringify(prefix.slice(0, 40))} + ${JSON.stringify(unit)}…`);
}

test("fuzz http1 : flux sans fin refusés dans les limites, sans blocage", () => {
  const L = HTTP_LIMITS;
  const ok = "HTTP/1.1 200 OK\r\n";
  const chunked = `${ok}Transfer-Encoding: chunked\r\n\r\n`;
  endless("HTTP/1.1 200 ", "R", L.maxStatusLine);
  endless("", "A", L.maxStatusLine);
  endless("", "HTTP/1.1 100 Continue\r\n\r\n", 26 * (L.maxInterimResponses + 1));
  endless("", "HTTP/1.1 100 Continue\r\nX: y\r\n\r\n", 32 * (L.maxInterimResponses + 1));
  endless(ok, "X: y\r\n", L.maxHeaderBytes);
  endless(ok, "Set-Cookie: a=b\r\n", L.maxHeaderBytes);
  endless(`${ok}X: `, "y", L.maxHeaderBytes);
  endless(`${ok}X: `, " ", L.maxHeaderBytes);
  endless(chunked, "0", L.maxChunkSizeDigits + L.maxChunkExtBytes + 2);
  endless(chunked, "1", L.maxChunkSizeDigits + L.maxChunkExtBytes + 2);
  endless(`${chunked}1`, ";a", L.maxChunkExtBytes + 2);
  endless(`${chunked}1;a=`, "b", L.maxChunkExtBytes + 2);
  endless(`${chunked}1;a="`, "q", L.maxChunkExtBytes + 2);
  // 1-byte chunks: the same logic as with 16 MiB, at a fraction of the bytes.
  const small = { ...L, maxBodyBytes: 256 * 1024 };
  endless(chunked, "1\r\nX\r\n", 6 * small.maxBodyBytes, small);
  endless(chunked, "FFFF\r\n", L.maxBodyBytes + 6 * 0x10000);
  endless(`${chunked}0\r\n`, "T: 1\r\n", L.maxTrailerBytes);
  endless(`${chunked}0\r\nT: `, "v", L.maxTrailerBytes);
  endless(`${ok}\r\n`, "body", 0); // no announced length: refused at the end of the header section
  endless(`${ok}Content-Length: 5\r\n\r\n`, "hello", 10);
  endless("HTTP/1.1 204 No Content\r\n\r\n", "x", 1);
  endless("", "\r\n", 2);
  endless("", ch(0), L.maxStatusLine);
  const tight = { ...TIGHT };
  endless(chunked, "1\r\nX\r\n", 6 * tight.maxBodyBytes, tight);
  endless(ok, "X: y\r\n", tight.maxHeaderBytes, tight);
});

// ── 5. Performance ────────────────────────────────────────────────────────

const MIB16 = 16 * 1024 * 1024;

function timed(label, fn, maxMs = 4000) {
  const started = Date.now();
  fn();
  const ms = Date.now() - started;
  assert(ms < maxMs, `${label} : ${ms} ms (attendu < ${maxMs} ms)`);
}

test("perf http1 : 16 Mio (Content-Length) poussés octet par octet", () => {
  timed("16 Mio octet par octet", () => {
    const p = new ResponseParser({});
    p.push(b(`HTTP/1.1 200 OK\r\nContent-Length: ${MIB16}\r\n\r\n`));
    // One reused 1-byte buffer: measures the parser, not the allocation of 16 M views.
    const one = new Uint8Array(1);
    for (let k = 0; k < MIB16; k++) {
      one[0] = k & 0xff;
      p.push(one);
    }
    assert(p.done, "réponse terminée");
    const body = p.response.body;
    eq(body.length, MIB16);
    for (const k of [0, 1, 255, 256, 65535, 65536, 65537, MIB16 - 1]) eq(body[k], k & 0xff, `octet ${k}`);
  });
});

test("perf http1 : 16 Mio chunked en morceaux de 1 à 7 octets", () => {
  const CHUNK = 4096;
  const blocks = MIB16 / CHUNK;
  const line = b(`${CHUNK.toString(16)};x=1\r\n`);
  const head = b("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
  const tail = b("0\r\n\r\n");
  const data = new Uint8Array(head.length + blocks * (line.length + CHUNK + 2) + tail.length);
  let at = 0;
  data.set(head, at);
  at += head.length;
  for (let k = 0; k < blocks; k++) {
    data.set(line, at);
    at += line.length;
    data.fill(k & 0xff, at, at + CHUNK);
    at += CHUNK;
    data[at++] = 0x0d;
    data[at++] = 0x0a;
  }
  data.set(tail, at);
  timed("16 Mio chunked, morceaux minuscules", () => {
    const p = new ResponseParser({});
    const rnd = prng(16);
    for (let k = 0; k < data.length; ) {
      const n = 1 + Math.floor(rnd() * 7);
      p.push(data.subarray(k, k + n));
      k += n;
    }
    assert(p.done, "réponse terminée");
    eq(p.response.body.length, MIB16);
    eq(p.response.body[MIB16 - 1], (blocks - 1) & 0xff);
  });
});

test("perf http1 : un million de blocs d'un octet et 64 Kio d'en-têtes, octet par octet", () => {
  timed("1 M blocs d'un octet", () => {
    const n = 1 << 20;
    const unit = b("1\r\nX\r\n");
    const head = b("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
    const data = new Uint8Array(head.length + n * unit.length + 5);
    data.set(head);
    for (let k = 0; k < n; k++) data.set(unit, head.length + k * unit.length);
    data.set(b("0\r\n\r\n"), head.length + n * unit.length);
    const p = new ResponseParser({});
    const rnd = prng(1);
    for (let k = 0; k < data.length; ) {
      const m = 1 + Math.floor(rnd() * 16);
      p.push(data.subarray(k, k + m));
      k += m;
    }
    assert(p.done, "réponse terminée");
    eq(p.response.body.length, n);
  });
  timed("64 Kio d'en-têtes octet par octet", () => {
    // 99 lines of 660 bytes and one filling the rest: exactly maxHeaderBytes.
    let text = "";
    for (let k = 0; k < 99; k++) text += `X-${String(k).padStart(2, "0")}: ${"v".repeat(652)}\r\n`;
    text += `X-99: ${"w".repeat(HTTP_LIMITS.maxHeaderBytes - text.length - 10)}\r\n\r\n`;
    eq(text.length, HTTP_LIMITS.maxHeaderBytes);
    const data = b(`HTTP/1.1 204 No Content\r\n${text}`);
    const p = new ResponseParser({});
    const one = new Uint8Array(1);
    for (const x of data) {
      one[0] = x;
      p.push(one);
    }
    assert(p.done, "réponse terminée");
    eq(p.response.headers.size, 100);
  });
  timed("une ligne d'en-tête de 64 Kio octet par octet", () => {
    const data = b(`HTTP/1.1 204 No Content\r\nX: ${"v".repeat(HTTP_LIMITS.maxHeaderBytes - 7)}\r\n\r\n`);
    const p = new ResponseParser({});
    const one = new Uint8Array(1);
    for (const x of data) {
      one[0] = x;
      p.push(one);
    }
    assert(p.done, "réponse terminée");
  });
});

// ── 6. Request serializer ─────────────────────────────────────────────────

test("fuzz http1 : champs de requête aléatoires, refusés ou requête bien formée", () => {
  const rnd = prng(0x5e7);
  const int = (n) => Math.floor(rnd() * n);
  const POOL = [
    ..."abcXYZ019-._~:/?&=%#@!$'()*+,;[]{}<>|\\^`\" \t",
    "%41",
    "\r",
    "\n",
    "\r\n",
    ch(0),
    ch(1),
    ch(0x1b),
    ch(0x7f),
    ch(0x80),
    ch(0xe9),
    ch(0x2028),
    ch(0x202e),
    ch(0xfeff),
    ch(0xd800),
    String.fromCodePoint(0x1f600),
    "Host",
    "Content-Length",
    "Transfer-Encoding",
    "Connection",
  ];
  const text = (max) => {
    let s = "";
    const n = int(max + 1);
    for (let k = 0; k < n; k++) s += POOL[int(POOL.length)];
    return s;
  };
  const unsafe = (s, allowBlank) => {
    for (let k = 0; k < s.length; k++) {
      const c = s.charCodeAt(k);
      if (c > 0x7e || (c < 0x20 && !(allowBlank && c === 9)) || (c === 0x20 && !allowBlank)) return true;
    }
    return false;
  };
  const stats = { accepted: 0, refused: 0 };
  for (let round = 0; round < 4000; round++) {
    const method = rnd() < 0.7 ? "POST" : text(6);
    const host = rnd() < 0.7 ? "mail.example.com" : text(12);
    const path = rnd() < 0.3 ? "/Microsoft-Server-ActiveSync" : `/${text(16)}`;
    const headers = Array.from({ length: int(4) }, () => [rnd() < 0.5 ? "X-Test" : text(6), rnd() < 0.3 ? "ok" : text(12)]);
    let out = null;
    try {
      out = serializeRequest({ method, host, path, headers, body: rnd() < 0.5 ? null : new Uint8Array(int(10)) });
    } catch (e) {
      if (!(e instanceof HttpError)) throw new Error(`exception inattendue ${e?.name}: ${e?.message}`);
      stats.refused++;
      continue;
    }
    stats.accepted++;
    assert(!unsafe(method, false) && !unsafe(host, false) && !unsafe(path, false), `champ dangereux accepté : ${JSON.stringify({ method, host, path })}`);
    for (const [name, value] of headers) assert(!unsafe(name, false) && !unsafe(value, true), `en-tête dangereux accepté : ${JSON.stringify([name, value])}`);
    let s = "";
    for (const x of out) s += ch(x);
    const end = s.indexOf("\r\n\r\n");
    const lines = s.slice(0, end).split("\r\n");
    eq(lines[0], `${method} ${path} HTTP/1.1`);
    eq(lines[0].split(" ").length, 3, "ligne de requête en trois parties");
    eq(lines[1], `Host: ${host}`);
    for (let k = 0; k < headers.length; k++) eq(lines[2 + k], `${headers[k][0]}: ${headers[k][1]}`);
    const names = lines.slice(1).map((l) => asciiLower(l.slice(0, l.indexOf(":"))));
    eq(names.filter((n) => n === "host").length, 1, "un seul Host");
    assert(names.filter((n) => n === "content-length").length <= 1, "au plus un Content-Length");
    eq(names.filter((n) => n === "transfer-encoding").length, 0, "pas de Transfer-Encoding");
    eq(names.filter((n) => n === "connection").length, 0, "pas de Connection : le serveur doit annoncer la longueur de chaque réponse");
  }
  assert(stats.accepted > 200 && stats.refused > 1000, `exploration trop pauvre : ${JSON.stringify(stats)}`);
});
