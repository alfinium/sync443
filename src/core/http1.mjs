// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * HTTP/1.1 over a connection the extension opened itself, after its own
 * certificate check: the request bytes it writes and the response bytes it
 * reads. Written from RFC 9110 (semantics) and RFC 9112 (message syntax).
 *
 * serializeRequest() refuses anything that could change the shape of the
 * request: CR, LF, NUL or any other control, non-ASCII text, a method or a
 * header name that is not a token, a malformed host or path, and the
 * headers that frame the message or manage the connection (it writes those
 * itself). It never writes a malformed or injected request.
 *
 * ResponseParser reads bytes from a server that is not trusted, and neither
 * is anything in between. It is:
 *  - strict wherever leniency allows request smuggling or response
 *    splitting: framing headers, line endings, chunk syntax, bytes after the
 *    end of the response. A body must announce its length (Content-Length
 *    or chunked): one that only ends with the connection cannot be told
 *    from a connection cut by the network;
 *  - bounded everywhere: status line, header section, number of header
 *    lines, body, chunk size and extensions, trailers, interim responses;
 *  - incremental: any split of the input gives the same result, at a cost
 *    linear in the number of bytes (bodies are collected in pieces and
 *    joined once);
 *  - closed: it throws only HttpError, and once it has thrown it stays
 *    failed (every later call throws the same error).
 *
 * Header names and values are ASCII-lowercased and compared without
 * String.prototype.toLowerCase(): Unicode case mapping turns U+212A
 * (KELVIN SIGN) into "k", so "chun\u212Aed" would pass for "chunked".
 */

import { decodeUtf8 } from "./utf8.mjs";
import { cleanText } from "./sanitize.mjs";

export class HttpError extends Error {
  /** `code`: "TOO_LARGE" when the body exceeds maxBodyBytes, "PROTOCOL" otherwise. */
  constructor(message, code = "PROTOCOL") {
    super(`HTTP : ${message}`);
    this.name = "HttpError";
    this.code = code;
  }
}

/**
 * Sizes include the line endings: the status line is at most maxStatusLine
 * bytes with its CRLF, the header section (field lines and the empty line
 * that ends it) at most maxHeaderBytes, the trailer section likewise at most
 * maxTrailerBytes. maxHeaders counts field lines. Each interim (1xx)
 * response has its own status line and header section budget; there are at
 * most maxInterimResponses of them. A chunk-size line is at most
 * maxChunkSizeDigits hex digits followed by at most maxChunkExtBytes bytes of
 * extensions.
 */
export const HTTP_LIMITS = Object.freeze({
  maxStatusLine: 8 * 1024,
  maxHeaderBytes: 64 * 1024,
  maxHeaders: 100,
  maxBodyBytes: 16 * 1024 * 1024,
  maxChunkSizeDigits: 8,
  maxTrailerBytes: 8 * 1024,
  maxChunkExtBytes: 1024,
  maxInterimResponses: 16,
});

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const HTAB = 0x09;
const DQUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const SEMICOLON = 0x3b;
const EQUALS = 0x3d;
const DEL = 0x7f;

// tchar (RFC 9110 section 5.6.2): the characters of a token.
const TCHAR = new Uint8Array(256);
for (const c of "!#$%&'*+-.^_`|~") TCHAR[c.charCodeAt(0)] = 1;
for (let c = 0x30; c <= 0x39; c++) TCHAR[c] = 1;
for (let c = 0x41; c <= 0x5a; c++) TCHAR[c] = TCHAR[c + 0x20] = 1;

// Value of a hex digit, or -1.
const HEX = new Int8Array(256).fill(-1);
for (let c = 0; c < 10; c++) HEX[0x30 + c] = c;
for (let c = 0; c < 6; c++) HEX[0x41 + c] = HEX[0x61 + c] = 10 + c;

const fail = (message, code) => {
  throw new HttpError(message, code);
};

/** ASCII-only lower case (A-Z), never Unicode case mapping. */
function asciiLower(s) {
  let out = "";
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : s[k];
  }
  return out;
}

function isToken(s) {
  if (typeof s !== "string" || s.length === 0) return false;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c > 0xff || !TCHAR[c]) return false;
  }
  return true;
}

// ── Request ───────────────────────────────────────────────────────────────

// Written or decided by serializeRequest itself ("Connection" included), or
// meaningless with "Accept-Encoding: identity" (TE and Upgrade would ask the
// server for codings or a protocol switch the parser refuses).
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "accept-encoding",
  "te",
  "upgrade",
  "keep-alive",
  "proxy-connection",
]);
const MAX_METHOD = 32;
const MAX_PATH = 8 * 1024;
const MAX_HOST = 512;

/**
 * Host header value: reg-name or IPv4 address (letters, digits, "-", "_",
 * dot-separated non-empty labels) or an IPv6 literal in brackets, then an
 * optional ":port" (1 to 65535). Internationalised names must already be in
 * their ASCII (punycode) form. The IPv6 literal is only checked for its
 * characters (hex digits, ":" and "."), enough to rule out any injection: the
 * address itself was validated by parseServer().
 */
function isValidHost(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > MAX_HOST) return false;
  let rest;
  if (host.charCodeAt(0) === 0x5b) {
    const close = host.indexOf("]");
    if (close < 3) return false; // at least "[::]"
    let colons = 0;
    for (let k = 1; k < close; k++) {
      const c = host.charCodeAt(k);
      if (c === COLON) colons++;
      else if (c !== 0x2e && (c > 0xff || HEX[c] < 0)) return false;
    }
    if (colons < 2) return false;
    rest = host.slice(close + 1);
  } else {
    const colon = host.indexOf(":");
    const name = colon < 0 ? host : host.slice(0, colon);
    rest = colon < 0 ? "" : host.slice(colon);
    if (name.length === 0 || name.length > 253) return false;
    let label = 0;
    for (let k = 0; k < name.length; k++) {
      const c = name.charCodeAt(k);
      if (c === 0x2e) {
        if (label === 0) return false; // empty label: leading dot, "..", trailing dot
        label = 0;
        continue;
      }
      const ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f;
      if (!ok) return false;
      label++;
    }
    if (label === 0) return false;
  }
  if (rest === "") return true;
  if (rest.charCodeAt(0) !== COLON || rest.length < 2 || rest.length > 6) return false;
  for (let k = 1; k < rest.length; k++) {
    const c = rest.charCodeAt(k);
    if (c < 0x30 || c > 0x39) return false;
  }
  const port = Number(rest.slice(1));
  return port >= 1 && port <= 65535;
}

/** origin-form: "/" then visible ASCII, no "#", and every "%" followed by two hex digits. */
function isValidPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH || path.charCodeAt(0) !== 0x2f) return false;
  for (let k = 0; k < path.length; k++) {
    const c = path.charCodeAt(k);
    if (c <= SP || c >= DEL || c === 0x23) return false;
    if (c === 0x25) {
      const h1 = path.charCodeAt(k + 1);
      const h2 = path.charCodeAt(k + 2);
      if (!(h1 < 0x80 && HEX[h1] >= 0 && h2 < 0x80 && HEX[h2] >= 0)) return false;
    }
  }
  return true;
}

/** Field value written by us: visible ASCII, space and tab inside, nothing else; no surrounding whitespace. */
function isValidValue(value) {
  if (typeof value !== "string") return false;
  for (let k = 0; k < value.length; k++) {
    const c = value.charCodeAt(k);
    if (c === HTAB || c === SP) {
      if (k === 0 || k === value.length - 1) return false;
    } else if (c < 0x21 || c > 0x7e) {
      return false;
    }
  }
  return true;
}

/**
 * request: { method, host, path, headers: [[name, value], ...], body: Uint8Array|null }
 * Returns the request bytes: request line, Host, the caller's headers in
 * order, Content-Length (when there is a body, "0" for a POST without one),
 * "Accept-Encoding: identity", the empty line, the body.
 * No "Connection: close": an HTTP/1.1 server then frames every body (length
 * or chunks), so a connection cut by the network cannot pass for a complete,
 * empty answer; the caller closes the connection once the answer is read.
 * Throws HttpError on any invalid input. Error messages never contain a
 * header value (it may be a credential).
 */
export function serializeRequest(request) {
  if (request === null || typeof request !== "object") fail("requête invalide");
  // Each property is read once: what is checked is what is written.
  const { method, host, path, headers = [], body = null } = request;
  if (!isToken(method) || method.length > MAX_METHOD) fail("méthode invalide");
  if (method === "CONNECT") fail("méthode CONNECT non prise en charge");
  if (!isValidHost(host)) fail("hôte invalide");
  if (!isValidPath(path)) fail("chemin de requête invalide");
  if (headers !== null && !Array.isArray(headers)) fail("liste d'en-têtes invalide");
  if (body !== null && body !== undefined && !(body instanceof Uint8Array)) fail("corps de requête invalide (Uint8Array attendu)");

  let head = `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n`;
  for (const pair of headers ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2) fail("en-tête invalide (paire [nom, valeur] attendue)");
    const [name, value] = pair;
    if (!isToken(name)) fail("nom d'en-tête invalide");
    if (RESERVED_HEADERS.has(asciiLower(name))) fail(`en-tête réservé : ${name}`);
    if (!isValidValue(value)) fail(`valeur invalide pour l'en-tête ${name}`);
    head += `${name}: ${value}\r\n`;
  }
  if (body) head += `Content-Length: ${body.length}\r\n`;
  else if (method === "POST") head += "Content-Length: 0\r\n";
  head += "Accept-Encoding: identity\r\n\r\n";

  // Everything in `head` was checked to be ASCII.
  const out = new Uint8Array(head.length + (body ? body.length : 0));
  for (let k = 0; k < head.length; k++) out[k] = head.charCodeAt(k);
  if (body) out.set(body, head.length);
  return out;
}

// ── Response ──────────────────────────────────────────────────────────────

/** The single value of a header, or null if absent or present with different values. */
export function headerValue(headers, name) {
  if (!(headers instanceof Map) || typeof name !== "string") return null;
  const values = headers.get(asciiLower(name));
  if (!Array.isArray(values) || values.length === 0) return null;
  const first = values[0];
  for (let k = 1; k < values.length; k++) if (values[k] !== first) return null;
  return first;
}

const STAGE = 64 * 1024;

/** Body bytes, copied into fixed-size pieces and joined once: linear for any split. */
class BodyBuffer {
  constructor(max) {
    this.max = max;
    this.total = 0;
    this.pieces = [];
    this.stage = null;
    this.used = 0;
  }

  append(src, start, end) {
    let n = end - start;
    if (n > this.max - this.total) fail("corps de réponse trop grand", "TOO_LARGE");
    this.total += n;
    while (n > 0) {
      if (this.stage === null) {
        this.stage = new Uint8Array(STAGE);
        this.used = 0;
      }
      const k = Math.min(n, STAGE - this.used);
      if (k <= 16) {
        for (let m = 0; m < k; m++) this.stage[this.used + m] = src[start + m];
      } else {
        this.stage.set(src.subarray(start, start + k), this.used);
      }
      this.used += k;
      start += k;
      n -= k;
      if (this.used === STAGE) {
        this.pieces.push(this.stage);
        this.stage = null;
      }
    }
  }

  join() {
    const out = new Uint8Array(this.total);
    let at = 0;
    for (const p of this.pieces) {
      out.set(p, at);
      at += p.length;
    }
    if (this.stage) out.set(this.stage.subarray(0, this.used), at);
    this.pieces = [];
    this.stage = null;
    return out;
  }
}

// Parser states.
const S_STATUS = 0;
const S_HEADERS = 1;
const S_LENGTH = 2; // Content-Length body
const S_CHUNK_SIZE = 3;
const S_CHUNK_DATA = 4;
const S_CHUNK_CR = 5; // CRLF after the chunk data
const S_CHUNK_LF = 6;
const S_TRAILERS = 7;
const S_DONE = 8;

function mergeLimits(limits) {
  if (limits === undefined || limits === null) return HTTP_LIMITS;
  if (typeof limits !== "object") fail("limites invalides");
  const out = { ...HTTP_LIMITS };
  for (const key of Object.keys(limits)) {
    if (!Object.prototype.hasOwnProperty.call(HTTP_LIMITS, key)) fail(`limite inconnue : ${key}`);
    const v = limits[key];
    if (!Number.isSafeInteger(v) || v < 0) fail(`limite invalide : ${key}`);
    out[key] = v;
  }
  return Object.freeze(out);
}

/**
 * Incremental response parser.
 *   const p = new ResponseParser({ method: "POST", limits }); // limits merged over HTTP_LIMITS
 *   p.push(bytes);  // Uint8Array, any split; throws HttpError
 *   p.end();        // the peer closed the connection; throws if the response is incomplete
 *   p.done;         // true once a complete final response was parsed
 *   p.response;     // { status, reason, headers: Map<lowercase name, string[]>, body } once done, else null
 * Bytes after the end of the response are an error (no pipelining). The
 * parser copies what it keeps: the caller may reuse its buffers. The
 * response to a HEAD (or CONNECT) request is not handled: those methods
 * are refused.
 */
export class ResponseParser {
  #limits;
  #state = S_STATUS;
  #error = null;
  #ended = false;
  #received = false;
  #response = null;

  // Current line (without its LF), bounded by the limit of the current state.
  #line = new Uint8Array(256);
  #lineLen = 0;

  // Current response head.
  #version = 11;
  #status = 0;
  #reason = "";
  #headers = null;
  #headerBytes = 0;
  #headerCount = 0;
  #interim = 0;

  // Body.
  #body = null;
  #remaining = 0;
  #trailerBytes = 0;

  constructor(options = {}) {
    if (options === null || typeof options !== "object") fail("options invalides");
    const { method = "GET", limits } = options;
    if (!isToken(method)) fail("méthode invalide");
    if (method === "CONNECT" || method === "HEAD") fail(`méthode ${method} non prise en charge`);
    this.#limits = mergeLimits(limits);
  }

  get done() {
    return this.#state === S_DONE && this.#error === null;
  }

  get response() {
    return this.done ? this.#response : null;
  }

  push(chunk) {
    if (this.#error) throw this.#error;
    try {
      this.#push(chunk);
    } catch (e) {
      throw this.#fail(e);
    }
  }

  end() {
    if (this.#error) throw this.#error;
    try {
      this.#end();
    } catch (e) {
      throw this.#fail(e);
    }
  }

  #fail(e) {
    let err = e;
    if (!(e instanceof HttpError)) {
      // Not supposed to happen: kept so the contract (HttpError only) holds.
      err = new HttpError("erreur interne de l'analyseur");
      err.cause = e;
    }
    this.#error = err;
    this.#response = null;
    this.#body = null;
    this.#line = null;
    return err;
  }

  #end() {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#state === S_DONE) return;
    if (!this.#received) fail("connexion fermée sans réponse");
    fail("réponse incomplète : connexion fermée trop tôt");
  }

  #push(chunk) {
    if (!(chunk instanceof Uint8Array)) fail("push() attend un Uint8Array");
    const n = chunk.length;
    if (n === 0) return;
    if (this.#ended) fail("données reçues après la fermeture de la connexion");
    this.#received = true;
    let i = 0;
    while (i < n) {
      switch (this.#state) {
        case S_STATUS:
        case S_HEADERS:
        case S_CHUNK_SIZE:
        case S_TRAILERS: {
          i = this.#readLine(chunk, i);
          if (i < 0) return;
          break;
        }
        case S_LENGTH:
        case S_CHUNK_DATA: {
          const k = Math.min(n - i, this.#remaining);
          this.#body.append(chunk, i, i + k);
          i += k;
          this.#remaining -= k;
          if (this.#remaining === 0) {
            if (this.#state === S_LENGTH) this.#finish();
            else this.#state = S_CHUNK_CR;
          }
          break;
        }
        case S_CHUNK_CR:
          if (chunk[i] !== CR) fail("CRLF manquant après les données d'un bloc");
          i++;
          this.#state = S_CHUNK_LF;
          break;
        case S_CHUNK_LF:
          if (chunk[i] !== LF) fail("CRLF manquant après les données d'un bloc");
          i++;
          this.#state = S_CHUNK_SIZE;
          break;
        default:
          fail("données après la fin de la réponse");
      }
    }
  }

  /** Bytes the current line may take, LF included. */
  #lineRoom() {
    const L = this.#limits;
    switch (this.#state) {
      case S_STATUS:
        return L.maxStatusLine;
      case S_HEADERS:
        return L.maxHeaderBytes - this.#headerBytes;
      case S_CHUNK_SIZE:
        return L.maxChunkSizeDigits + L.maxChunkExtBytes + 2;
      default:
        return L.maxTrailerBytes - this.#trailerBytes;
    }
  }

  #tooLong() {
    switch (this.#state) {
      case S_STATUS:
        fail("ligne d'état trop longue");
        break;
      case S_HEADERS:
        fail("section d'en-têtes trop longue");
        break;
      case S_CHUNK_SIZE:
        fail("ligne de taille de bloc trop longue");
        break;
      default:
        fail("section de trailers trop longue");
    }
  }

  /**
   * Takes the bytes of the current line from chunk[i...]. Returns the index
   * after its LF once the line is complete (and handled), or -1 when the
   * chunk ends first. Fails as soon as the line cannot fit its limit.
   */
  #readLine(chunk, i) {
    const room = this.#lineRoom() - this.#lineLen;
    const n = chunk.length;
    const stop = Math.min(n, i + room);
    let j = i;
    while (j < stop && chunk[j] !== LF) j++;
    if (j === stop) {
      if (stop - i === room) this.#tooLong(); // even the LF would not fit
      this.#append(chunk, i, n);
      return -1;
    }
    this.#append(chunk, i, j);
    this.#onLine();
    return j + 1;
  }

  #append(chunk, from, to) {
    const add = to - from;
    if (add === 0) return;
    const need = this.#lineLen + add;
    if (need > this.#line.length) {
      let size = Math.max(256, this.#line.length * 2);
      while (size < need) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.#line.subarray(0, this.#lineLen));
      this.#line = grown;
    }
    if (add <= 16) {
      for (let m = 0; m < add; m++) this.#line[this.#lineLen + m] = chunk[from + m];
    } else {
      this.#line.set(chunk.subarray(from, to), this.#lineLen);
    }
    this.#lineLen = need;
  }

  #onLine() {
    const total = this.#lineLen + 1; // with the LF
    if (this.#lineLen === 0 || this.#line[this.#lineLen - 1] !== CR) fail("fin de ligne sans CR (LF seul)");
    const len = this.#lineLen - 1; // without the CRLF
    this.#lineLen = 0;
    switch (this.#state) {
      case S_STATUS:
        this.#onStatusLine(len);
        break;
      case S_HEADERS:
        this.#headerBytes += total;
        if (len === 0) this.#onEndOfHeaders();
        else this.#onHeaderLine(len);
        break;
      case S_CHUNK_SIZE:
        this.#onChunkSizeLine(len);
        break;
      default:
        this.#trailerBytes += total;
        if (len === 0) this.#finish();
        else this.#parseField(len, "trailer"); // checked, then ignored
    }
  }

  // status-line = HTTP-version SP 3DIGIT SP [ reason-phrase ]
  #onStatusLine(len) {
    const b = this.#line;
    // Some servers omit the space and empty reason ("HTTP/1.1 200"): tolerated, nothing else is.
    const ok =
      len >= 12 &&
      b[0] === 0x48 && b[1] === 0x54 && b[2] === 0x54 && b[3] === 0x50 && b[4] === 0x2f && b[5] === 0x31 && b[6] === 0x2e && // "HTTP/1."
      (b[7] === 0x31 || b[7] === 0x30) &&
      b[8] === SP &&
      b[9] >= 0x30 && b[9] <= 0x39 && b[10] >= 0x30 && b[10] <= 0x39 && b[11] >= 0x30 && b[11] <= 0x39 &&
      (len === 12 || b[12] === SP);
    if (!ok) fail("ligne d'état invalide");
    const status = (b[9] - 0x30) * 100 + (b[10] - 0x30) * 10 + (b[11] - 0x30);
    if (status < 100 || status > 599) fail(`code d'état invalide : ${status}`);
    if (status === 101) fail("changement de protocole (101) refusé");
    if (status < 200 && ++this.#interim > this.#limits.maxInterimResponses) fail("trop de réponses intermédiaires (1xx)");

    // The reason phrase is only shown: controls are dropped, tabs become spaces.
    const kept = new Uint8Array(Math.max(0, len - 13));
    let m = 0;
    for (let k = 13; k < len; k++) {
      const c = b[k];
      if (c === CR) fail("CR isolé dans la ligne d'état");
      if (c === HTAB) kept[m++] = SP;
      else if (c >= SP && c !== DEL) kept[m++] = c;
    }
    const reason = cleanText(decodeUtf8(kept, 0, m), { max: this.#limits.maxStatusLine, singleLine: true, stripBidi: true }).trim();

    this.#version = b[7] === 0x31 ? 11 : 10;
    this.#status = status;
    this.#reason = reason;
    this.#headers = new Map();
    this.#headerBytes = 0;
    this.#headerCount = 0;
    this.#state = S_HEADERS;
  }

  #onHeaderLine(len) {
    if (++this.#headerCount > this.#limits.maxHeaders) fail("trop d'en-têtes");
    const [name, value] = this.#parseField(len, "en-tête");
    const list = this.#headers.get(name);
    if (list) list.push(value);
    else this.#headers.set(name, [value]);
  }

  /** field-line = field-name ":" OWS field-value OWS; returns [lowercase name, value]. */
  #parseField(len, what) {
    const b = this.#line;
    if (b[0] === SP || b[0] === HTAB) fail(`${what} replié (obs-fold) refusé`);
    let k = 0;
    let name = "";
    while (k < len && TCHAR[b[k]]) {
      const c = b[k++];
      name += String.fromCharCode(c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
    }
    if (k === 0 || k === len || b[k] !== COLON) fail(`${what} invalide : nom ou « : » incorrect`);
    let start = k + 1;
    let end = len;
    while (start < end && (b[start] === SP || b[start] === HTAB)) start++;
    while (end > start && (b[end - 1] === SP || b[end - 1] === HTAB)) end--;
    for (let p = start; p < end; p++) {
      const c = b[p];
      if ((c < SP && c !== HTAB) || c === DEL) fail(c === CR ? `CR isolé dans un ${what}` : `caractère de contrôle dans un ${what}`);
    }
    return [name, decodeUtf8(b, start, end)];
  }

  #onEndOfHeaders() {
    if (this.#status < 200) {
      // Interim response: its fields are dropped, the final response follows.
      this.#state = S_STATUS;
      return;
    }
    const h = this.#headers;
    for (const v of h.get("content-encoding") ?? []) {
      if (asciiLower(v) !== "identity") fail("codage de contenu non pris en charge (identity demandé)");
    }
    this.#body = new BodyBuffer(this.#limits.maxBodyBytes);
    if (this.#status === 204 || this.#status === 304) {
      // No content, whatever the framing headers say (RFC 9112 section 6.3).
      this.#finish();
      return;
    }
    const te = h.get("transfer-encoding");
    const cl = h.get("content-length");
    if (te) {
      if (this.#version === 10) fail("Transfer-Encoding dans une réponse HTTP/1.0");
      if (cl) fail("Transfer-Encoding et Content-Length à la fois");
      if (te.length !== 1 || asciiLower(te[0]) !== "chunked") fail("Transfer-Encoding non pris en charge (seul « chunked » est accepté)");
      this.#state = S_CHUNK_SIZE;
      return;
    }
    if (cl) {
      const text = cl[0];
      for (const v of cl) if (v !== text) fail("valeurs de Content-Length différentes");
      if (text.length === 0 || text.length > 16) fail("Content-Length invalide");
      for (let k = 0; k < text.length; k++) {
        const c = text.charCodeAt(k);
        if (c < 0x30 || c > 0x39) fail("Content-Length invalide");
      }
      const length = Number(text);
      if (length > this.#limits.maxBodyBytes) fail("corps de réponse trop grand (Content-Length)", "TOO_LARGE");
      if (length === 0) {
        this.#finish();
        return;
      }
      this.#remaining = length;
      this.#state = S_LENGTH;
      return;
    }
    fail("réponse sans longueur annoncée (Content-Length ou chunked attendu)");
  }

  // chunk-size [ chunk-ext ] CRLF
  #onChunkSizeLine(len) {
    const b = this.#line;
    const L = this.#limits;
    let k = 0;
    let size = 0;
    while (k < len && HEX[b[k]] >= 0) {
      size = size * 16 + HEX[b[k]];
      k++;
    }
    if (k === 0) fail("taille de bloc invalide");
    if (k > L.maxChunkSizeDigits) fail("taille de bloc trop longue");
    if (k < len) {
      if (len - k > L.maxChunkExtBytes) fail("extension de bloc trop longue");
      this.#checkChunkExt(k, len);
    }
    if (size === 0) {
      this.#trailerBytes = 0;
      this.#state = S_TRAILERS;
      return;
    }
    if (size > L.maxBodyBytes - this.#body.total) fail("corps de réponse trop grand", "TOO_LARGE");
    this.#remaining = size;
    this.#state = S_CHUNK_DATA;
  }

  /**
   * chunk-ext = *( BWS ";" BWS ext-name [ BWS "=" BWS ext-val ] ), ext-val
   * a token or a quoted-string. Checked strictly, then ignored.
   */
  #checkChunkExt(k, len) {
    const b = this.#line;
    const bad = () => fail("ligne de taille de bloc invalide");
    const skipWs = (p) => {
      while (p < len && (b[p] === SP || b[p] === HTAB)) p++;
      return p;
    };
    const token = (p) => {
      const from = p;
      while (p < len && TCHAR[b[p]]) p++;
      if (p === from) bad();
      return p;
    };
    let p = k;
    while (p < len) {
      p = skipWs(p);
      if (p >= len || b[p] !== SEMICOLON) bad();
      p = token(skipWs(p + 1));
      const q = skipWs(p);
      if (q < len && b[q] === EQUALS) {
        p = skipWs(q + 1);
        if (p < len && b[p] === DQUOTE) {
          p++;
          for (;;) {
            if (p >= len) bad();
            const c = b[p];
            if (c === DQUOTE) {
              p++;
              break;
            }
            if (c === BACKSLASH) {
              p++;
              const e = p < len ? b[p] : -1;
              if (!(e === HTAB || (e >= SP && e !== DEL))) bad();
            } else if (!(c === HTAB || (c >= SP && c !== DEL))) {
              bad();
            }
            p++;
          }
        } else {
          p = token(p);
        }
      }
    }
  }

  #finish() {
    this.#response = {
      status: this.#status,
      reason: this.#reason,
      headers: this.#headers,
      body: this.#body.join(),
    };
    this.#body = null;
    this.#line = new Uint8Array(0);
    this.#state = S_DONE;
  }
}
