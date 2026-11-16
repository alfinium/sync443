// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * WBXML 1.3 as used by Exchange ActiveSync ([MS-ASWBXML], WAP-192).
 *
 * Every byte from the server is untrusted, so the decoder:
 *  - refuses documents above `maxBytes`, with more than `maxNodes` elements
 *    or nested deeper than `maxDepth`;
 *  - refuses a truncated document (an element left open, a string without
 *    its terminator, opaque data running past the end);
 *  - refuses what ActiveSync never uses (attributes, entities, string
 *    table references, extension tokens, processing instructions);
 *  - collects the pieces of an element's text and joins them once, so many
 *    small pieces cost linear time, not quadratic.
 *
 * The encoder refuses unknown tags and U+0000 in text: a NUL would end the
 * string early and let what follows be read as tokens.
 *
 * Tree: { ns, tag, children: Element[], value: Uint8Array|null, opaque }.
 * Unknown pages and tokens decode under placeholder names ("#page26",
 * "#0x2c"), so a newer server never breaks the client; readers ignore them.
 */

import { encodeUtf8, decodeUtf8 } from "./utf8.mjs";
import { pageOf, namespaceOf, tokenOf, tagOf } from "./codepages.mjs";

const SWITCH_PAGE = 0x00;
const END = 0x01;
const STR_I = 0x03;
const OPAQUE = 0xc3;
const CHARSET_UTF8 = 106;

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxNodes: 500_000, // elements AND pieces of text/opaque data
  maxDepth: 64,
});

export class WbxmlError extends Error {
  constructor(message) {
    super(`WBXML : ${message}`);
    this.name = "WbxmlError";
  }
}

// ── Element tree ───────────────────────────────────────────────────────────

/**
 * An element. `name` is "Namespace:Tag", or "Tag" to take the parent's
 * namespace. `content` is a string or number (text), a Uint8Array (opaque
 * data), an array of elements (null/undefined/false entries are skipped),
 * or nothing (empty element).
 */
export function el(name, content) {
  const colon = name.indexOf(":");
  const node = { ns: null, tag: name, children: [], value: null, opaque: false };
  if (colon >= 0) {
    node.ns = name.slice(0, colon);
    node.tag = name.slice(colon + 1);
  }
  if (content == null) return node; // empty element
  if (content instanceof Uint8Array) {
    node.opaque = true;
    node.value = content;
    return node;
  }
  if (Array.isArray(content)) {
    for (const item of content) if (item) node.children.push(item);
    return node;
  }
  const isText = typeof content === "string" || (typeof content === "number" && Number.isSafeInteger(content));
  if (!isText) throw new WbxmlError(`contenu invalide pour <${name}>`);
  const text = String(content);
  if (text.includes("\u0000")) throw new WbxmlError(`caractère NUL refusé dans <${name}>`);
  node.value = encodeUtf8(text);
  return node;
}

// ── Writing ────────────────────────────────────────────────────────────────

/**
 * Output collected as runs: single bytes gather in `pending` until a byte
 * array (text, opaque data) arrives; result() joins the runs once.
 */
class Writer {
  constructor() {
    this.runs = [];
    this.pending = [];
    this.length = 0;
  }
  byte(b) {
    this.pending.push(b);
  }
  bytes(arr) {
    this.#closeRun();
    this.runs.push(arr);
    this.length += arr.length;
  }
  #closeRun() {
    if (!this.pending.length) return;
    this.runs.push(this.pending);
    this.length += this.pending.length;
    this.pending = [];
  }
  /** Multi-byte integer: base-128 groups, most significant first, every group but the last flagged 0x80. */
  multiByte(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new WbxmlError("entier hors limites");
    const groups = [];
    let rest = value;
    do {
      groups.push(rest % 128);
      rest = (rest - (rest % 128)) / 128;
    } while (rest > 0);
    for (let k = groups.length - 1; k >= 0; k--) this.byte(k > 0 ? groups[k] | 0x80 : groups[k]);
  }
  result() {
    this.#closeRun();
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const run of this.runs) {
      out.set(run, at);
      at += run.length;
    }
    return out;
  }
}

export function encode(root) {
  if (!root?.ns) throw new WbxmlError("l'élément racine doit avoir un espace de noms");
  const w = new Writer();
  w.bytes([0x03, 0x01, CHARSET_UTF8, 0x00]); // WBXML 1.3, unknown public id, UTF-8, no string table
  let currentPage = 0;
  // Iterative depth-first walk: [node, inheritedNs] to open, or a close marker.
  const stack = [[root, root.ns]];
  let depth = 0;
  while (stack.length) {
    const item = stack.pop();
    if (item === END) {
      w.byte(END);
      depth--;
      continue;
    }
    const [node, inherited] = item;
    const ns = node.ns ?? inherited;
    const page = pageOf(ns);
    if (page === undefined) throw new WbxmlError(`espace de noms inconnu « ${ns} »`);
    const token = tokenOf(ns, node.tag);
    if (token === undefined) throw new WbxmlError(`balise inconnue « ${ns}:${node.tag} »`);
    if (!Array.isArray(node.children)) throw new WbxmlError(`<${ns}:${node.tag}> : élément mal formé`);
    if (node.value && node.children.length) throw new WbxmlError(`<${ns}:${node.tag}> : texte et éléments mêlés`);
    if (page !== currentPage) {
      w.byte(SWITCH_PAGE);
      w.byte(page);
      currentPage = page;
    }
    const hasContent = node.value !== null || node.children.length > 0;
    w.byte(hasContent ? token | 0x40 : token);
    if (!hasContent) continue;
    if (++depth > DEFAULT_LIMITS.maxDepth) throw new WbxmlError("imbrication trop profonde");
    if (node.value !== null) {
      if (node.opaque) {
        w.byte(OPAQUE);
        w.multiByte(node.value.length);
        w.bytes(node.value);
      } else {
        if (node.value.includes(0)) throw new WbxmlError(`caractère NUL refusé dans <${ns}:${node.tag}>`);
        w.byte(STR_I);
        w.bytes(node.value);
        w.byte(0x00);
      }
    }
    stack.push(END);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push([node.children[i], ns]);
  }
  return w.result();
}

// ── Parsing ────────────────────────────────────────────────────────────────

/** Quick check before decoding: a WBXML 1.1-1.3 version byte (decode() checks the rest). */
export function looksLikeWbxml(bytes) {
  return bytes.length >= 4 && bytes[0] >= 0x01 && bytes[0] <= 0x03;
}

export function decode(bytes, limits = DEFAULT_LIMITS) {
  // A limit that is missing, NaN, infinite or not positive falls back to the default: never lifted.
  const limit = (x, d) => (Number.isFinite(x) && x >= 0 ? x : d);
  const maxBytes = limit(limits?.maxBytes, DEFAULT_LIMITS.maxBytes);
  const maxNodes = limit(limits?.maxNodes, DEFAULT_LIMITS.maxNodes);
  const maxDepth = limit(limits?.maxDepth, DEFAULT_LIMITS.maxDepth);
  if (!(bytes instanceof Uint8Array)) throw new WbxmlError("données invalides");
  if (bytes.length > maxBytes) throw new WbxmlError(`document trop volumineux (${bytes.length} octets)`);
  let pos = 0; // next byte to read

  // Multi-byte integer: at most five base-128 groups; a set high bit announces another group.
  const readInt = () => {
    let total = 0;
    for (let groups = 1; groups <= 5; groups++) {
      if (pos >= bytes.length) throw new WbxmlError("document tronqué (entier)");
      const octet = bytes[pos];
      pos += 1;
      total = total * 128 + (octet & 0x7f);
      if ((octet & 0x80) === 0) {
        if (total > 0xffffffff) throw new WbxmlError("entier hors limites");
        return total;
      }
    }
    throw new WbxmlError("entier trop long");
  };

  if (bytes.length < 4) throw new WbxmlError("document tronqué (en-tête)");
  const version = bytes[pos++];
  if (version < 0x01 || version > 0x03) throw new WbxmlError(`version inconnue 0x${version.toString(16)}`);
  if (readInt() === 0) readInt(); // public id given as a string table index
  const charset = readInt();
  if (charset !== CHARSET_UTF8) throw new WbxmlError(`jeu de caractères ${charset} non géré`);
  const tableLength = readInt();
  if (tableLength > bytes.length - pos) throw new WbxmlError("document tronqué (table des chaînes)");
  pos += tableLength; // never referenced: STR_T is refused below

  const root = { ns: "", tag: "#document", children: [], value: null, opaque: false };
  const stack = [root];
  const pieces = [[]]; // text pieces of each open element, joined at END
  let page = 0;
  let nodes = 0;

  const finish = (node, parts) => {
    if (!parts.length) {
      if (parts.sawEmpty) node.value = new Uint8Array(0); // empty text: "" rather than no content
      return;
    }
    if (parts.length === 1) {
      node.value = parts[0].slice(); // a copy: a small value must not keep the whole response alive
      return;
    }
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    node.value = out;
  };

  while (pos < bytes.length) {
    const b = bytes[pos++];
    if (b === SWITCH_PAGE) {
      if (pos >= bytes.length) throw new WbxmlError("document tronqué (changement de page)");
      page = bytes[pos++];
      continue;
    }
    if (b === END) {
      if (stack.length <= 1) throw new WbxmlError("fin d'élément sans élément ouvert");
      finish(stack.pop(), pieces.pop());
      continue;
    }
    if (b === STR_I) {
      if (stack.length <= 1) throw new WbxmlError("texte hors élément");
      const end = bytes.indexOf(0x00, pos);
      if (end < 0) throw new WbxmlError("document tronqué (texte sans terminaison)");
      if (end > pos) {
        // Every piece counts like an element: many tiny pieces must not exhaust memory.
        if (++nodes > maxNodes) throw new WbxmlError("trop d'éléments");
        pieces[pieces.length - 1].push(bytes.subarray(pos, end));
      } else {
        pieces[pieces.length - 1].sawEmpty = true;
      }
      pos = end + 1;
      continue;
    }
    if (b === OPAQUE) {
      if (stack.length <= 1) throw new WbxmlError("données hors élément");
      const len = readInt();
      if (len > bytes.length - pos) throw new WbxmlError("document tronqué (données opaques)");
      if (len > 0) {
        if (++nodes > maxNodes) throw new WbxmlError("trop d'éléments");
        pieces[pieces.length - 1].push(bytes.subarray(pos, pos + len));
      } else {
        pieces[pieces.length - 1].sawEmpty = true;
      }
      stack[stack.length - 1].opaque = true;
      pos += len;
      continue;
    }
    if (b & 0x80) throw new WbxmlError(`jeton 0x${b.toString(16)} non géré (attributs ou extension)`);
    const token = b & 0x3f;
    if (token < 0x05) throw new WbxmlError(`jeton global 0x${b.toString(16)} non géré`);

    if (++nodes > maxNodes) throw new WbxmlError("trop d'éléments");
    const node = {
      ns: namespaceOf(page) ?? `#page${page}`,
      tag: tagOf(page, token) ?? `#0x${token.toString(16)}`,
      children: [],
      value: null,
      opaque: false,
    };
    const parent = stack[stack.length - 1];
    if (parent === root && root.children.length) throw new WbxmlError("plusieurs éléments racine");
    parent.children.push(node);
    if (b & 0x40) {
      if (stack.length > maxDepth) throw new WbxmlError("imbrication trop profonde");
      stack.push(node);
      pieces.push([]);
    }
  }
  if (stack.length !== 1) throw new WbxmlError("document tronqué (élément non refermé)");
  if (root.children.length !== 1) throw new WbxmlError("document sans élément racine");
  return root.children[0];
}

// ── Reading ───────────────────────────────────────────────────────────────

const matches = (node, name) => {
  const i = name.indexOf(":");
  return i < 0 ? node.tag === name : node.ns === name.slice(0, i) && node.tag === name.slice(i + 1);
};

/** First child named `name` ("Tag" or "Namespace:Tag"), or null. */
export function child(node, name) {
  if (!node) return null;
  for (const c of node.children) if (matches(c, name)) return c;
  return null;
}

/** Follow a path of child names; null if any step is missing. */
export function at(node, ...path) {
  let current = node;
  for (const name of path) {
    current = child(current, name);
    if (!current) return null;
  }
  return current;
}

/** Text of the element at `path` (UTF-8): null if absent, "" if empty. */
export function text(node, ...path) {
  const target = path.length ? at(node, ...path) : node;
  if (!target) return null;
  return target.value ? decodeUtf8(target.value) : "";
}

/** Raw bytes of the element at `path`: null if absent, empty array if empty. */
export function bytes(node, ...path) {
  const target = path.length ? at(node, ...path) : node;
  if (!target) return null;
  return target.value ?? new Uint8Array(0);
}

/**
 * Readable form for the debug log. Only the values of `shown` tags
 * (technical ones: statuses, keys, ids) are written, cut to `maxValue`
 * bytes; every other value is replaced by its length, so the log never
 * holds message bodies, subjects, names or addresses. Iterative, capped.
 */
export function toDebugString(node, { shown = new Set(), maxValue = 64, maxLength = 32 * 1024 } = {}) {
  const lines = [];
  let length = 0;
  // Built trees (el()) leave `ns` null on children that take their parent's namespace.
  const stack = [[node, 0, node.ns]];
  while (stack.length) {
    const [n, depth, inherited] = stack.pop();
    const ns = n.ns ?? inherited;
    let line = `${"  ".repeat(Math.min(depth, 32))}<${ns}:${n.tag}>`;
    if (n.value) {
      if (n.opaque || !(shown.has(n.tag) || shown.has(`${ns}:${n.tag}`))) {
        line += ` [${n.value.length} octets]`;
      } else {
        const shown = decodeUtf8(n.value, 0, Math.min(n.value.length, maxValue)).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "·"); // controls, bidi and invisible characters, separators
        line += ` ${shown}${n.value.length > maxValue ? "…" : ""}`;
      }
    }
    length += line.length + 1;
    if (length > maxLength) {
      lines.push("…");
      break;
    }
    lines.push(line);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push([n.children[i], depth + 1, ns]);
  }
  return lines.join("\n");
}
