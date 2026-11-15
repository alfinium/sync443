// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Raw Internet messages (RFC 5322) and MIME structure (RFC 2045, 2046),
 * read and edited as bytes: never decoded to text, so every byte that is
 * not removed comes out exactly as it went in.
 *
 *   messageIdOf(bytes)          → string | null
 *   ensureMessageId(bytes)      → { bytes, messageId, synthetic }
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
 * Limits. messageIdOf only looks at the first MAX_HEADER_BYTES (1 MiB) of a
 * message. The removals are not capped: Thunderbird reads a stored header
 * block whatever its size, so a capped removal could be bypassed by padding
 * the headers. They run in one pass, in time linear in the size of the
 * message (times the nesting depth, at most MAX_MIME_DEPTH, for delimiter
 * lines), and never throw on malformed data.
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

/**
 * The id in a Message-ID field value bytes[from, to): the text between the
 * first "<" and the next ">", or, without angle brackets, the first word.
 * `complete` is false when the field may continue past `to` (cut by the
 * 1 MiB window): an id that is not closed within it is then refused.
 * Accepted: 1 to 998 visible ASCII characters other than "<" and ">".
 */
function extractMessageId(bytes, from, to, complete) {
  const i = skipCfws(bytes, from, to);
  if (i >= to) return null;
  let start;
  let stop;
  if (bytes[i] === LT) {
    start = i + 1;
    stop = start;
    while (stop < to && bytes[stop] !== GT) stop++;
    if (stop >= to) return null;
  } else {
    start = i;
    stop = i;
    while (stop < to) {
      const b = bytes[stop];
      if (b === SP || b === HTAB || b === CR || b === LF || b === LPAREN) break;
      stop++;
    }
    if (stop >= to && !complete) return null;
  }
  const length = stop - start;
  if (length < 1 || length > MAX_MESSAGE_ID) return null;
  for (let k = start; k < stop; k++) {
    const b = bytes[k];
    if (b < 0x21 || b > 0x7e || b === LT || b === GT) return null;
  }
  return String.fromCharCode.apply(null, bytes.subarray(start, stop));
}

/**
 * Message-ID of the top-level header block, without angle brackets, as
 * Thunderbird exposes it (`headerMessageId`) for a well-formed message:
 * the value of the FIRST field named Message-ID, unfolded, comments and
 * blanks around it ignored. null when there is none in the first 1 MiB,
 * when that first field is unusable (empty, no closing ">", controls,
 * blanks or non-ASCII bytes inside, more than 998 characters), or when the
 * input is not a Uint8Array.
 */
export function messageIdOf(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const limit = Math.min(bytes.length, MAX_HEADER_BYTES);
  const window = bytes.subarray(0, limit);
  const lines = new Lines(window, limit);
  let pos = 0;
  while (pos < limit) {
    const ce = lines.contentEnd(pos);
    if (ce === pos) return null; // empty line: end of the header block
    const next = lines.next(ce);
    if (!isBlank(window[pos])) {
      const colon = colonOf(window, pos, ce);
      if (colon >= 0 && sameWord(window, pos, nameEnd(window, pos, colon), MESSAGE_ID)) {
        let end = next;
        while (end < limit && isBlank(window[end])) end = lines.next(lines.contentEnd(end));
        return extractMessageId(window, colon + 1, end, end < limit || limit === bytes.length);
      }
    }
    pos = next;
  }
  return null;
}

/** Bytes of an ASCII string. */
function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * The message with a Message-ID. When messageIdOf finds one, the bytes are
 * returned as they are (the same array) with `synthetic: false`. Otherwise
 * "Message-ID: <hex@sync443.invalid>" and CRLF are put in front of the
 * message, hex being the first 16 bytes of the SHA-256 of the original
 * bytes in lowercase hexadecimal (32 characters): the same message always
 * gets the same id. The new field comes first, so it is also the first
 * Message-ID of the result: messageIdOf(result.bytes) === result.messageId.
 */
export function ensureMessageId(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("ensureMessageId : Uint8Array attendu");
  const existing = messageIdOf(bytes);
  if (existing !== null) return { bytes, messageId: existing, synthetic: false };
  const messageId = `${toHex(sha256(bytes).subarray(0, 16))}@${SYNTHETIC_DOMAIN}`;
  const field = asciiBytes(`Message-ID: <${messageId}>\r\n`);
  const out = new Uint8Array(field.length + bytes.length);
  out.set(field);
  out.set(bytes, field.length);
  return { bytes: out, messageId, synthetic: true };
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

/**
 * Whether the line bytes[pos, ce), known to start with "--", is a delimiter
 * of one of the open multipart bodies: "--" boundary, optionally "--" (the
 * close delimiter), then only blanks (RFC 2046 5.1.1). The innermost body
 * is tried first. Returns level * 2 + (close ? 1 : 0), or -1.
 */
function delimiterOf(bytes, pos, ce, stack) {
  for (let level = stack.length - 1; level >= 0; level--) {
    const boundary = stack[level];
    let j = pos + 2;
    if (ce - j < boundary.length) continue;
    let same = true;
    for (let k = 0; k < boundary.length; k++) {
      if (bytes[j + k] !== boundary[k]) {
        same = false;
        break;
      }
    }
    if (!same) continue;
    j += boundary.length;
    let close = 0;
    if (j + 1 < ce && bytes[j] === DASH && bytes[j + 1] === DASH) {
      close = 1;
      j += 2;
    }
    while (j < ce && isBlank(bytes[j])) j++;
    if (j === ce) return level * 2 + close;
  }
  return -1;
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
  const stack = []; // boundaries of the open multipart bodies, innermost last
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
      const hit = delimiterOf(bytes, pos, ce, stack);
      if (hit >= 0) {
        if (inHeaders) {
          closeField(pos);
          endHeaders(false);
        }
        const level = hit >> 1;
        if (hit & 1) {
          stack.length = level; // close delimiter: what follows is the epilogue
        } else {
          stack.length = level + 1;
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
