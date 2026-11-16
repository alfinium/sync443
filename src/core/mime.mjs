// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Raw Internet messages (RFC 5322) and MIME structure (RFC 2045, 2046),
 * read and edited as bytes: never decoded to text, so every byte that is
 * not removed comes out exactly as it went in.
 *
 *   messageIdOf(bytes)          → string | null   (strict: see the function)
 *   ensureMessageId(bytes)      → { bytes, messageId, synthetic }
 *   replaceMessageId(bytes, id) → bytes   (the message under another Message-ID)
 *   dateOf(bytes), fromAddressOf(bytes), addressOf(text)   (fingerprint of a message)
 *   stripInternalHeaders(bytes) → bytes   (received messages: top-level header block)
 *   cleanDraft(bytes)           → bytes   (drafts to send: top level and every MIME part)
 *
 * Lines. A line ends at LF, at CRLF, or at a CR not followed by LF (some
 * readers, older Thunderbird code among them, split there; treating it as a
 * line end means a header hidden behind a lone CR is still found). A header
 * block runs from its first byte to the first empty line, or to the end of
 * the data when there is none. A line starting with a space or a tab
 * continues the previous field (folding, RFC 5322 2.2.3), even when it holds
 * nothing but blanks. Field names are compared without regard to ASCII case,
 * and blanks between a name and its colon are tolerated (obsolete syntax,
 * RFC 5322 4.5). A line without a colon is kept as it is and ends the
 * previous field.
 *
 * Internal headers: Thunderbird reads some headers of a stored message as
 * its own state (X-Mozilla-Status, X-Mozilla-Status2 and X-Mozilla-Keys set
 * flags and tags) and writes others into drafts (X-Mozilla-Draft-Info,
 * X-Account-Key, X-Identity-Key, Fcc, X-Mozilla-Cloud-Part in attachments).
 * Removed: every field whose name starts with "X-Mozilla-", and the fields
 * named X-Account-Key, X-Identity-Key and Fcc. A removed field goes with its
 * continuation lines and its line ending; nothing else changes.
 *
 * Limits. messageIdOf, dateOf and fromAddressOf only look at the first
 * MAX_HEADER_BYTES (1 MiB) of a message. The removals and replaceMessageId
 * are not capped: Thunderbird reads a stored header block whatever its
 * size, so a capped removal could be bypassed by padding the headers. They
 * run in one pass, in time linear in the size of the message (a delimiter
 * line costs at most the length of the longest boundary, whatever the
 * nesting depth), and never throw on malformed data.
 */

import { sha256, toHex } from "./sha256.mjs";

/** Part of a message searched for its Message-ID. */
export const MAX_HEADER_BYTES = 1024 * 1024;
/** Deepest nesting of multipart bodies that cleanDraft walks into. */
export const MAX_MIME_DEPTH = 32;
/** Most MIME parts cleanDraft walks through; the rest of the message is left as it is. */
export const MAX_MIME_PARTS = 10_000;
/** Longest Message-ID accepted, in characters (RFC 5322 line limit). */
export const MAX_MESSAGE_ID = 998;
/** Domain of the Message-IDs given to messages that have none (RFC 6761: never resolves). */
export const SYNTHETIC_DOMAIN = "sync443.invalid";

const HTAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SP = 0x20;
const QUOTE = 0x22;
const LPAREN = 0x28;
const RPAREN = 0x29;
const DASH = 0x2d;
const SLASH = 0x2f;
const COLON = 0x3a;
const SEMI = 0x3b;
const LT = 0x3c;
const EQUALS = 0x3d;
const GT = 0x3e;
const BACKSLASH = 0x5c;

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const MOZILLA_PREFIX = ascii("x-mozilla-");
const INTERNAL_NAMES = [ascii("x-account-key"), ascii("x-identity-key"), ascii("fcc")];
const MESSAGE_ID = ascii("message-id");
const CONTENT_TYPE = ascii("content-type");
const MULTIPART = ascii("multipart");
const BOUNDARY = ascii("boundary");

const lower = (b) => (b >= 0x41 && b <= 0x5a ? b + 0x20 : b);
const isBlank = (b) => b === SP || b === HTAB;

/** bytes[from, from + word.length) equals `word` (lowercase ASCII codes), ignoring ASCII case. */
function startsWithWord(bytes, from, to, word) {
  if (to - from < word.length) return false;
  for (let i = 0; i < word.length; i++) if (lower(bytes[from + i]) !== word[i]) return false;
  return true;
}

const sameWord = (bytes, from, to, word) => to - from === word.length && startsWithWord(bytes, from, to, word);

/**
 * Line reader over bytes[0, end). The next LF and the next CR are found
 * with indexOf and remembered, so a whole pass costs linear time even when
 * one of them never occurs.
 */
class Lines {
  constructor(bytes, end) {
    this.bytes = bytes;
    this.end = end;
    this.lf = -2; // -2: not searched yet; -1: none left
    this.cr = -2;
  }

  /** Offset of the terminator of the line starting at `pos`, or `end` for a last line without one. */
  contentEnd(pos) {
    if (this.lf !== -1 && this.lf < pos) this.lf = this.bytes.indexOf(LF, pos);
    if (this.cr !== -1 && this.cr < pos) this.cr = this.bytes.indexOf(CR, pos);
    let e = this.end;
    if (this.lf >= 0 && this.lf < e) e = this.lf;
    if (this.cr >= 0 && this.cr < e) e = this.cr;
    return e;
  }

  /** Start of the line after a terminator found at `ce`. */
  next(ce) {
    if (ce >= this.end) return this.end;
    return this.bytes[ce] === CR && ce + 1 < this.end && this.bytes[ce + 1] === LF ? ce + 2 : ce + 1;
  }
}

/** Offset of the colon ending the field name of a line, or -1. */
function colonOf(bytes, pos, ce) {
  for (let i = pos; i < ce; i++) if (bytes[i] === COLON) return i;
  return -1;
}

/** End of a field name: the colon, minus the blanks before it. */
function nameEnd(bytes, pos, colon) {
  let e = colon;
  while (e > pos && isBlank(bytes[e - 1])) e--;
  return e;
}

function isInternalName(bytes, from, to) {
  if (startsWithWord(bytes, from, to, MOZILLA_PREFIX)) return true;
  for (const word of INTERNAL_NAMES) if (sameWord(bytes, from, to, word)) return true;
  return false;
}

/** Skips blanks, line breaks and comments (nested, with quoted pairs: RFC 5322 3.2.2). */
function skipCfws(bytes, i, to) {
  while (i < to) {
    const b = bytes[i];
    if (b === SP || b === HTAB || b === CR || b === LF) {
      i++;
      continue;
    }
    if (b !== LPAREN) break;
    let depth = 0;
    while (i < to) {
      const c = bytes[i++];
      if (c === BACKSLASH) i++;
      else if (c === LPAREN) depth++;
      else if (c === RPAREN && --depth === 0) break;
    }
  }
  return i < to ? i : to;
}

// ── Message-ID ────────────────────────────────────────────────────────────

const NUL = 0x00;
const MAX_ID_VALUE = 2048; // raw bytes of a Message-ID field value, folding included
// Bytes never accepted in an id: blanks and controls (by range), angle brackets, parentheses, quote, backslash.
const ID_EXCLUDED = new Set([LT, GT, LPAREN, RPAREN, QUOTE, BACKSLASH]);
const isIdByte = (b) => b >= 0x21 && b <= 0x7e && !ID_EXCLUDED.has(b);

/** A field name of RFC 5322 (ftext: printable ASCII but the colon), nothing else. */
function isFieldName(bytes, from, to) {
  if (to <= from) return false;
  for (let i = from; i < to; i++) if (bytes[i] < 0x21 || bytes[i] > 0x7e) return false;
  return true;
}

/**
 * The id of an unfolded, trimmed Message-ID value bytes[from, to) skipping
 * CR and LF: exactly "<id>" or a bare "id", with 1 to 998 visible ASCII
 * characters other than < > ( ) " \. Anything more (a comment, a second
 * word, text after the closing bracket) → null.
 */
function strictId(bytes, from, to) {
  const value = [];
  for (let i = from; i < to; i++) {
    const b = bytes[i];
    if (b === CR || b === LF) continue;
    if (value.length >= MAX_ID_VALUE) return null;
    value.push(b);
  }
  let s = 0;
  let e = value.length;
  while (s < e && isBlank(value[s])) s++;
  while (e > s && isBlank(value[e - 1])) e--;
  if (s < e && value[s] === LT) {
    if (value[e - 1] !== GT) return null;
    s++;
    e--;
  }
  const length = e - s;
  if (length < 1 || length > MAX_MESSAGE_ID) return null;
  for (let k = s; k < e; k++) if (!isIdByte(value[k])) return null;
  return String.fromCharCode.apply(null, value.slice(s, e));
}

/**
 * Message-ID of the top-level header block, without angle brackets, read
 * strictly so that it is the value Thunderbird stores as `headerMessageId`
 * whichever of its readers is asked. null (the caller then gives the
 * message an id of its own, see ensureMessageId) unless all of this holds:
 *  - the header block ends (empty line, or end of data) within the first
 *    MAX_HEADER_BYTES (1 MiB);
 *  - up to the end of the Message-ID field, the block does not start with a
 *    continuation line, holds no NUL and no lone CR, and every field line
 *    has a colon after a well-formed name (printable ASCII, no blank:
 *    "Message-ID :" is refused too);
 *  - exactly one field is named Message-ID (any ASCII case, blanks before
 *    the colon included) in the whole block;
 *  - its value, unfolded and trimmed, is "<id>" or a bare "id" and nothing
 *    else (no comment, no second word): 1 to 998 visible ASCII characters
 *    other than < > ( ) " \.
 * Also null when the input is not a Uint8Array.
 */
export function messageIdOf(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const limit = Math.min(bytes.length, MAX_HEADER_BYTES);
  const lines = new Lines(bytes, limit);
  const nul = bytes.subarray(0, limit).indexOf(NUL); // the first NUL: only one before the field's end matters
  // A NUL in the line, or a lone CR ending it (readers disagree on both).
  const bad = (pos, ce) => (nul >= pos && nul < ce) || (ce < limit && bytes[ce] === CR && (ce + 1 >= bytes.length || bytes[ce + 1] !== LF));
  let field = null; // [valueFrom, valueTo] of the Message-ID field
  let phase = 0; // 0 before the field, 1 in it (continuation lines), 2 after it
  let pos = 0;
  for (;;) {
    if (pos >= limit) {
      if (limit < bytes.length) return null; // the block goes on past the window
      break;
    }
    const ce = lines.contentEnd(pos);
    if (ce === pos) break; // empty line: end of the block
    if (ce === limit && limit < bytes.length) return null; // line cut by the window
    const next = lines.next(ce);
    if (isBlank(bytes[pos])) {
      if (pos === 0) return null; // a block that starts with a continuation line
      if (phase === 1) {
        if (bad(pos, ce)) return null;
        field[1] = ce;
      }
      pos = next;
      continue;
    }
    if (phase === 1) phase = 2;
    const colon = colonOf(bytes, pos, ce);
    const isMid = colon >= 0 && sameWord(bytes, pos, nameEnd(bytes, pos, colon), MESSAGE_ID);
    if (phase === 2) {
      if (isMid) return null; // a second Message-ID field: which one a reader keeps is not certain
    } else {
      if (bad(pos, ce) || colon < 0 || !isFieldName(bytes, pos, colon)) return null;
      if (isMid) {
        field = [colon + 1, ce];
        phase = 1;
      }
    }
    pos = next;
  }
  return field ? strictId(bytes, field[0], field[1]) : null;
}

/** Bytes of an ASCII string. */
function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Name given to the Message-ID fields a message already had, when it gets an id of its own. */
export const ORIGINAL_ID_FIELD = "X-Sync443-Original-Message-ID";
/** Field put after the new Message-ID when the original starts with a continuation line, which then folds into it. */
const CONTINUATION_FIELD = "X-Sync443-Continuation";

/**
 * The message under the Message-ID `messageId` (no angle brackets):
 *  - every field of the top-level header block whose name is Message-ID
 *    (any case, blanks before the colon included) is renamed
 *    X-Sync443-Original-Message-ID, however big the block, so that no
 *    reader can take an old one;
 *  - "Message-ID: <messageId>" is put first, with the line ending of the
 *    original's first line (CRLF by default);
 *  - when the original starts with a blank (a continuation line), an empty
 *    X-Sync443-Continuation field follows ours: that line folds into it,
 *    never into the Message-ID.
 * Nothing else changes. Linear in the size of the header block.
 */
export function replaceMessageId(bytes, messageId) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("replaceMessageId : Uint8Array attendu");
  const lines = new Lines(bytes, bytes.length);
  const renamed = [];
  let eol = "\r\n";
  let pos = 0;
  while (pos < bytes.length) {
    const ce = lines.contentEnd(pos);
    if (pos === 0 && ce < bytes.length && bytes[ce] === LF) eol = "\n";
    if (ce === pos) break; // empty line: end of the header block
    if (!isBlank(bytes[pos])) {
      const colon = colonOf(bytes, pos, ce);
      if (colon >= 0) {
        const end = nameEnd(bytes, pos, colon);
        if (sameWord(bytes, pos, end, MESSAGE_ID)) renamed.push([pos, end]);
      }
    }
    pos = lines.next(ce);
  }
  const guard = bytes.length && isBlank(bytes[0]) ? `${CONTINUATION_FIELD}:${eol}` : "";
  const head = asciiBytes(`Message-ID: <${messageId}>${eol}${guard}`);
  const name = asciiBytes(ORIGINAL_ID_FIELD);
  const out = new Uint8Array(head.length + bytes.length + renamed.length * (name.length - MESSAGE_ID.length));
  out.set(head);
  let n = head.length;
  let copied = 0;
  for (const [from, to] of renamed) {
    out.set(bytes.subarray(copied, from), n);
    n += from - copied;
    out.set(name, n);
    n += name.length;
    copied = to;
  }
  out.set(bytes.subarray(copied), n);
  return out;
}

/**
 * The message with a Message-ID. When messageIdOf finds one, the bytes are
 * returned as they are (the same array) with `synthetic: false`. Otherwise
 * the message gets "<hex@sync443.invalid>" through replaceMessageId, hex
 * being the first 16 bytes of the SHA-256 of the original bytes in
 * lowercase hexadecimal (32 characters): the same message always gets the
 * same id. `hash` (optional): that SHA-256, when the caller has it already.
 */
export function ensureMessageId(bytes, { hash = null } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("ensureMessageId : Uint8Array attendu");
  const existing = messageIdOf(bytes);
  if (existing !== null) return { bytes, messageId: existing, synthetic: false };
  const digest = hash instanceof Uint8Array && hash.length === 32 ? hash : sha256(bytes);
  const messageId = `${toHex(digest.subarray(0, 16))}@${SYNTHETIC_DOMAIN}`;
  return { bytes: replaceMessageId(bytes, messageId), messageId, synthetic: true };
}

// ── Date and sender (fingerprint of a message) ────────────────────────────

const DATE = ascii("date");
const FROM = ascii("from");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ZONES = new Map([["ut", 0], ["utc", 0], ["gmt", 0], ["z", 0], ["est", -300], ["edt", -240], ["cst", -360], ["cdt", -300], ["mst", -420], ["mdt", -360], ["pst", -480], ["pdt", -420]]);
const MAX_FIELD_TEXT = 4096;

/** Unfolded value of the first field named `word` in the top-level header block (first 1 MiB), as Latin-1 text, or null. */
function fieldText(bytes, word) {
  if (!(bytes instanceof Uint8Array)) return null;
  const limit = Math.min(bytes.length, MAX_HEADER_BYTES);
  const lines = new Lines(bytes, limit);
  let pos = 0;
  while (pos < limit) {
    const ce = lines.contentEnd(pos);
    if (ce === pos) return null;
    let next = lines.next(ce);
    if (!isBlank(bytes[pos])) {
      const colon = colonOf(bytes, pos, ce);
      if (colon >= 0 && sameWord(bytes, pos, nameEnd(bytes, pos, colon), word)) {
        let s = "";
        let from = colon + 1;
        let to = ce;
        for (;;) {
          for (let i = from; i < to && s.length < MAX_FIELD_TEXT; i++) s += String.fromCharCode(bytes[i]);
          if (next >= limit || !isBlank(bytes[next])) break;
          from = next;
          to = lines.contentEnd(next);
          next = lines.next(to);
        }
        return s;
      }
    }
    pos = next;
  }
  return null;
}

/** Comments (nested, RFC 5322 3.2.2) of a header text replaced by a blank. */
function dropComments(s) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && depth) i++;
    else if (c === "(") depth++;
    else if (c === ")" && depth) {
      if (--depth === 0) out += " ";
    } else if (!depth) out += c;
  }
  return out;
}

/**
 * The Date field of the top-level header block (RFC 5322 3.3, obsolete
 * forms included: two-digit years, named zones), in milliseconds since the
 * epoch, or null when absent or not understood.
 */
export function dateOf(bytes) {
  const text = fieldText(bytes, DATE);
  if (text === null) return null;
  const m = /^\s*(?:[a-z]{3,9}\s*,\s*)?(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{2,4})\s+(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?\s*([+-]\d{4}|[a-z]{1,5})?/i.exec(dropComments(text));
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  let year = Number(m[3]);
  if (m[3].length === 2) year += year < 50 ? 2000 : 1900;
  else if (m[3].length === 3) year += 1900;
  const [day, hour, minute, second] = [Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  let offset = 0;
  if (m[7]) {
    if (/^[+-]/.test(m[7])) {
      const v = Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3));
      offset = m[7][0] === "-" ? -v : v;
    } else {
      offset = ZONES.get(m[7].toLowerCase()) ?? 0;
    }
  }
  const at = Date.UTC(year, month, day, hour, minute, Math.min(second, 59)) - offset * 60_000;
  return Number.isFinite(at) ? at : null;
}

/**
 * The address (lowercase) in a From-like text: the last <…> holding an
 * "@", else the first word holding one; null when there is none. Display
 * names, encoded or not, are ignored: the address itself is never encoded.
 */
export function addressOf(text) {
  if (typeof text !== "string") return null;
  const s = dropComments(text.slice(0, MAX_FIELD_TEXT));
  let found = null;
  for (const m of s.matchAll(/<([^<>\s]*)>/g)) if (m[1].includes("@")) found = m[1];
  if (found === null) {
    for (const w of s.split(/[\s,;]+/)) {
      if (w.includes("@")) {
        found = w;
        break;
      }
    }
  }
  if (found === null) return null;
  found = found.replace(/^[<"'(]+|[>"'),.]+$/g, "").toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+$/.test(found) ? found : null;
}

/** The address of the From field of the top-level header block (see addressOf), or null. */
export function fromAddressOf(bytes) {
  return addressOf(fieldText(bytes, FROM));
}

// ── Removing internal headers ─────────────────────────────────────────────

/**
 * Copy of `src` without some ranges of whole lines, given in increasing
 * order. The copy is only made at the first removal: with none, finish()
 * returns `src` itself.
 *
 * The lines kept stay the same lines. One case needs care: when the kept
 * text ends with a line ended by a lone CR and the line after the removed
 * range is an empty line ended by LF, joining them would make one CRLF of
 * the two and swallow that empty line (the end of a header block), turning
 * what follows into headers. The removed range then keeps its own last
 * byte, an LF, which pairs with the CR and leaves the empty line in place.
 */
class Editor {
  constructor(src) {
    this.src = src;
    this.out = null;
    this.n = 0;
    this.copied = 0;
  }

  remove(from, to) {
    if (!this.out) this.out = new Uint8Array(this.src.length);
    if (from > this.copied) {
      this.out.set(this.src.subarray(this.copied, from), this.n);
      this.n += from - this.copied;
    }
    if (this.n > 0 && this.out[this.n - 1] === CR && to < this.src.length && this.src[to] === LF) to--;
    this.copied = to;
  }

  finish() {
    if (!this.out) return this.src;
    this.out.set(this.src.subarray(this.copied), this.n);
    this.n += this.src.length - this.copied;
    return this.out.subarray(0, this.n);
  }
}

const TSPECIALS = new Set(ascii('()<>@,;:\\"/[]?='));
const isTokenByte = (b) => b > 0x20 && b < 0x7f && !TSPECIALS.has(b);

/** Skips to the next ";" outside quoted strings and comments, or to `to`. */
function skipParameter(bytes, i, to) {
  while (i < to) {
    const b = bytes[i];
    if (b === SEMI) return i;
    if (b === QUOTE) {
      i++;
      while (i < to && bytes[i] !== QUOTE) i += bytes[i] === BACKSLASH ? 2 : 1;
      i++;
    } else if (b === LPAREN) {
      i = skipCfws(bytes, i, to);
    } else {
      i++;
    }
  }
  return to;
}

/**
 * Boundary of a Content-Type value bytes[from, to) when it is multipart/*
 * (RFC 2045 5.1, RFC 2046 5.1.1), as bytes; null otherwise or when the
 * boundary is missing or unusable (empty, longer than 200 bytes, or with a
 * byte outside printable ASCII and space). The first boundary parameter wins.
 */
function multipartBoundary(bytes, from, to) {
  let i = skipCfws(bytes, from, to);
  const typeStart = i;
  while (i < to && isTokenByte(bytes[i])) i++;
  if (!sameWord(bytes, typeStart, i, MULTIPART)) return null;
  i = skipCfws(bytes, i, to);
  if (i >= to || bytes[i] !== SLASH) return null;
  i = skipCfws(bytes, i + 1, to);
  while (i < to && isTokenByte(bytes[i])) i++;
  for (;;) {
    i = skipCfws(bytes, i, to);
    if (i >= to) return null;
    if (bytes[i] !== SEMI) {
      i = skipParameter(bytes, i, to);
      continue;
    }
    i = skipCfws(bytes, i + 1, to);
    const nameStart = i;
    while (i < to && isTokenByte(bytes[i])) i++;
    const isBoundary = sameWord(bytes, nameStart, i, BOUNDARY);
    i = skipCfws(bytes, i, to);
    if (i >= to || bytes[i] !== EQUALS) {
      i = skipParameter(bytes, i, to);
      continue;
    }
    i = skipCfws(bytes, i + 1, to);
    const value = [];
    let ok = true;
    if (i < to && bytes[i] === QUOTE) {
      i++;
      ok = false;
      while (i < to) {
        let b = bytes[i++];
        if (b === QUOTE) {
          ok = true;
          break;
        }
        if (b === BACKSLASH && i < to) b = bytes[i++];
        if (b !== CR && b !== LF && value.length <= 200) value.push(b); // folding inside quotes is dropped
      }
    } else {
      while (i < to) {
        const b = bytes[i];
        if (b === SEMI || b === SP || b === HTAB || b === CR || b === LF) break;
        if (value.length <= 200) value.push(b);
        i++;
      }
    }
    if (!isBoundary) continue;
    if (!ok || value.length < 1 || value.length > 200 || value.some((b) => b < 0x20 || b > 0x7e)) return null;
    return Uint8Array.from(value);
  }
}

/** Boundary bytes without trailing blanks, as a string (the key of BoundaryStack). */
function boundaryKey(bytes, from, to) {
  while (to > from && isBlank(bytes[to - 1])) to--;
  return String.fromCharCode.apply(null, bytes.subarray(from, to));
}

/**
 * Boundaries of the open multipart bodies, innermost last, with an index
 * by key (the boundary without trailing blanks), so that a line starting
 * with "--" is checked against the few boundaries it can be, not against
 * every open one: a delimiter line costs at most the length of the
 * longest boundary, whatever the nesting depth.
 */
class BoundaryStack {
  constructor() {
    this.list = [];
    this.byKey = new Map(); // key → levels, increasing
  }

  get length() {
    return this.list.length;
  }

  push(boundary) {
    const key = boundaryKey(boundary, 0, boundary.length);
    const levels = this.byKey.get(key);
    if (levels) levels.push(this.list.length);
    else this.byKey.set(key, [this.list.length]);
    this.list.push({ boundary, key });
  }

  /** Close every level from `level` up. */
  truncate(level) {
    while (this.list.length > level) {
      const { key } = this.list.pop();
      const levels = this.byKey.get(key);
      levels.pop();
      if (!levels.length) this.byKey.delete(key);
    }
  }

  /** The line bytes[pos, ce) is "--" boundary, optionally "--", then only blanks (RFC 2046 5.1.1)? → 0 no, 1 open, 2 close. */
  static #match(bytes, pos, ce, boundary) {
    let j = pos + 2;
    if (ce - j < boundary.length) return 0;
    for (let k = 0; k < boundary.length; k++) if (bytes[j + k] !== boundary[k]) return 0;
    j += boundary.length;
    let close = false;
    if (j + 1 < ce && bytes[j] === DASH && bytes[j + 1] === DASH) {
      close = true;
      j += 2;
    }
    while (j < ce && isBlank(bytes[j])) j++;
    return j === ce ? (close ? 2 : 1) : 0;
  }

  /**
   * Whether the line bytes[pos, ce), known to start with "--", is a
   * delimiter of one of the open bodies, the innermost first. Returns
   * level * 2 + (close ? 1 : 0), or -1.
   */
  delimiterOf(bytes, pos, ce) {
    let end = ce;
    while (end > pos + 2 && isBlank(bytes[end - 1])) end--;
    if (end - pos - 2 > 202) return -1; // longer than any boundary (200) and "--"
    const candidates = [...(this.byKey.get(boundaryKey(bytes, pos + 2, end)) ?? [])];
    if (end - pos >= 4 && bytes[end - 1] === DASH && bytes[end - 2] === DASH) {
      candidates.push(...(this.byKey.get(boundaryKey(bytes, pos + 2, end - 2)) ?? []));
    }
    candidates.sort((a, b) => b - a);
    for (const level of candidates) {
      const m = BoundaryStack.#match(bytes, pos, ce, this.list[level].boundary);
      if (m) return level * 2 + (m === 2 ? 1 : 0);
    }
    return -1;
  }
}

/**
 * One pass over the message: removes internal fields from the top-level
 * header block and, with `walkParts`, from the header block of every MIME
 * part. A part starts after a delimiter line of an enclosing multipart
 * body; its header block ends at its first empty line (or, malformed, at
 * the next delimiter). A multipart part opens a nested body (up to
 * MAX_MIME_DEPTH); other parts, message/rfc822 included, are bodies whose
 * lines are only checked for delimiters. A delimiter of an outer body closes
 * the inner ones; a body never closed runs to the end of the data, as MIME
 * readers do. Preambles, epilogues, delimiter lines and bodies are copied
 * byte for byte.
 */
function removeInternal(bytes, walkParts) {
  const length = bytes.length;
  const lines = new Lines(bytes, length);
  const editor = new Editor(bytes);
  const stack = new BoundaryStack(); // boundaries of the open multipart bodies, innermost last
  let parts = 0;
  let inHeaders = true;
  let fieldStart = -1; // field being read, and what to do with it
  let fieldDrop = false;
  let typeFrom = -1; // value of the first Content-Type field of the current header block
  let typeTo = -1;
  let typeOpen = false;

  const closeField = (at) => {
    if (fieldStart < 0) return;
    if (fieldDrop) editor.remove(fieldStart, at);
    if (typeOpen) typeTo = at;
    fieldStart = -1;
    typeOpen = false;
  };

  const openField = (pos, ce) => {
    fieldStart = pos;
    fieldDrop = false;
    const colon = colonOf(bytes, pos, ce);
    if (colon < 0) return;
    const end = nameEnd(bytes, pos, colon);
    fieldDrop = isInternalName(bytes, pos, end);
    if (walkParts && typeFrom < 0 && sameWord(bytes, pos, end, CONTENT_TYPE)) {
      typeFrom = colon + 1;
      typeOpen = true;
    }
  };

  /** End of a header block; `hasBody`: it ended with an empty line, so a body follows. */
  const endHeaders = (hasBody) => {
    inHeaders = false;
    if (hasBody && typeFrom >= 0 && stack.length < MAX_MIME_DEPTH) {
      const boundary = multipartBoundary(bytes, typeFrom, typeTo);
      if (boundary) stack.push(boundary);
    }
    typeFrom = -1;
    typeTo = -1;
  };

  let pos = 0;
  while (pos < length) {
    const ce = lines.contentEnd(pos);
    const next = lines.next(ce);
    if (stack.length && ce - pos >= 2 && bytes[pos] === DASH && bytes[pos + 1] === DASH) {
      const hit = stack.delimiterOf(bytes, pos, ce);
      if (hit >= 0) {
        if (inHeaders) {
          closeField(pos);
          endHeaders(false);
        }
        const level = hit >> 1;
        if (hit & 1) {
          stack.truncate(level); // close delimiter: what follows is the epilogue
        } else {
          stack.truncate(level + 1);
          if (++parts > MAX_MIME_PARTS) break; // the rest is left as it is
          inHeaders = true;
        }
        pos = next;
        continue;
      }
    }
    if (inHeaders) {
      if (ce === pos) {
        closeField(pos);
        endHeaders(true);
        if (!walkParts || !stack.length) break; // nothing left to clean
      } else if (!isBlank(bytes[pos])) {
        closeField(pos);
        openField(pos, ce);
      } // else: continuation line, part of the current field
    } else if (!stack.length) {
      break;
    }
    pos = next;
  }
  if (inHeaders) closeField(length);
  return editor.finish();
}

/**
 * A received message without the internal headers of its top-level header
 * block, so a sender cannot set Thunderbird flags or tags. The body is not
 * looked at. Returns `bytes` itself when nothing is removed.
 */
export function stripInternalHeaders(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("stripInternalHeaders : Uint8Array attendu");
  return removeInternal(bytes, false);
}

/**
 * A draft about to be sent without Thunderbird's internal headers, in the
 * top-level header block and in the header block of every MIME part, so
 * that nothing local (account and identity keys, folder addresses, paths of
 * cloud or detached attachments) leaves the computer. Bodies, preambles and
 * epilogues are left byte for byte; message/rfc822 parts are not entered.
 * Returns `bytes` itself when nothing is removed.
 */
export function cleanDraft(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("cleanDraft : Uint8Array attendu");
  return removeInternal(bytes, true);
}
