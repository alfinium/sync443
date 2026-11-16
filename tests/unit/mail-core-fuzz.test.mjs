// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Fuzzing of the mail core with fixed seeds (reproducible):
 *  1. generated MIME messages whose internal headers are known: the
 *     results must be exactly the message without them (top level only for
 *     received messages, every part for drafts);
 *  2. mutated and random messages: nothing is thrown, removals only remove
 *     (the result is a subsequence), a second pass removes nothing more,
 *     the body of a received message is kept byte for byte, and
 *     Message-IDs follow their rules;
 *  3. random folder tables and FolderSync changes: no cycle kept, every
 *     rule of the tree holds, local paths are one for one and valid on
 *     every system, and nothing depends on the order of the table.
 */

import { test, assert, eq, prng } from "./harness.mjs";
import { messageIdOf, ensureMessageId, stripInternalHeaders, cleanDraft, MAX_MESSAGE_ID } from "../../src/core/mime.mjs";
import {
  applyChanges,
  buildTree,
  localPaths,
  specialFolders,
  kindOf,
  SPECIAL_PATHS,
  RESERVED_ROOT_NAMES,
  ROOT_ID,
  MAX_DEPTH,
  MAX_TREE_FOLDERS,
  MAX_STORED_FOLDERS,
  MAX_NAME_LENGTH,
} from "../../src/core/folder-tree.mjs";
import { itemId } from "../../src/core/sanitize.mjs";
import { encodeUtf8 } from "../../src/core/utf8.mjs";

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const int = (rnd, n) => Math.floor(rnd() * n);
const ch = (code) => String.fromCharCode(code);
const hex = (b) => Array.from(b.subarray(0, 48), (x) => x.toString(16).padStart(2, "0")).join(" ") + (b.length > 48 ? " …" : "");
const CR = 0x0d;
const LF = 0x0a;

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** `small` can be obtained from `big` by removing bytes. */
function isSubsequence(small, big) {
  let j = 0;
  for (let i = 0; i < big.length && j < small.length; i++) if (big[i] === small[j]) j++;
  return j === small.length;
}

/**
 * Reference reading of the top-level header block, written independently
 * of mime.mjs with the same line rules (LF, CRLF, lone CR): offset of the
 * body (after the first empty line), or -1 when the headers run to the end.
 */
function bodyOffset(bytes) {
  let pos = 0;
  while (pos < bytes.length) {
    let end = pos;
    while (end < bytes.length && bytes[end] !== CR && bytes[end] !== LF) end++;
    let next = end;
    if (end < bytes.length) next = bytes[end] === CR && bytes[end + 1] === LF ? end + 2 : end + 1;
    if (end === pos) return next;
    pos = next;
  }
  return -1;
}

// ── 1. Generated messages ─────────────────────────────────────────────────

const INTERNAL = ["X-Mozilla-Status", "X-Mozilla-Status2", "X-Mozilla-Keys", "X-Mozilla-Draft-Info", "X-Mozilla-Cloud-Part", "X-Mozilla-", "X-Account-Key", "X-Identity-Key", "Fcc"];
const ORDINARY = ["Subject", "From", "To", "Date", "Content-Transfer-Encoding", "X-Mozilla", "X-Account-Keys", "Fccx", "X-Identity", "Received", "X-Custom-Header"];
const TEXT = Array.from("abcdefghijklmnopqrstuvwxyz ABCXYZ 0123456789 :;<>@=\"()[]/\\?.,é€😀\t");

const randomCase = (rnd, s) => Array.from(s, (c) => (rnd() < 0.3 ? (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) : c)).join("");
const randomText = (rnd, max) => Array.from({ length: int(rnd, max) }, () => pick(rnd, TEXT)).join("");

/**
 * A MIME message built from segments whose fate is known: internal fields
 * of header blocks go, everything else stays. Lines end with CRLF or LF.
 * → { input, cleaned (cleanDraft), stripped (stripInternalHeaders) }
 */
function generate(rnd) {
  const segments = []; // [piece, internal, topLevel]
  const style = int(rnd, 3); // 0 CRLF, 1 LF, 2 mixed
  const eol = () => (style === 0 ? "\r\n" : style === 1 ? "\n" : pick(rnd, ["\r\n", "\n"]));
  const push = (piece, internal = false, top = false) => segments.push([piece, internal, top]);
  let counter = 0;

  const headerBlock = (contentType, top) => {
    const count = int(rnd, 6);
    const typeAt = int(rnd, count + 1);
    for (let i = 0; i <= count; i++) {
      if (i === typeAt && contentType) push(`Content-Type: ${contentType}${eol()}`);
      if (i === count) break;
      const internal = rnd() < 0.4;
      const name = randomCase(rnd, pick(rnd, internal ? INTERNAL : ORDINARY));
      let field = `${name}${rnd() < 0.1 ? " " : ""}:${rnd() < 0.8 ? " " : ""}${randomText(rnd, 30)}${eol()}`;
      for (let k = int(rnd, 3); k > 0; k--) field += `${pick(rnd, [" ", "\t", "   "])}${randomText(rnd, 20)}x${eol()}`;
      push(field, internal, top);
    }
  };

  const active = []; // boundaries of the multipart bodies being written
  const bodyLines = () => {
    for (let k = int(rnd, 4); k > 0; k--) {
      const r = rnd();
      if (r < 0.1 && active.length) {
        // Looks like a delimiter but is not one: text after the boundary.
        push(`--${pick(rnd, active)}${pick(rnd, ["-x", "x", " x", "--x", "-- -", "_", "\t."])}${eol()}`);
      } else if (r < 0.2) {
        push(`${pick(rnd, INTERNAL)}: dans un corps${eol()}`);
      } else if (r < 0.3) {
        push(eol());
      } else if (r < 0.45) {
        const bin = new Uint8Array(int(rnd, 64));
        for (let i = 0; i < bin.length; i++) {
          bin[i] = int(rnd, 256);
          if (bin[i] === 0x2d) bin[i] = 0x2e; // no "-": never a delimiter
        }
        push(bin);
        push(eol());
      } else {
        push(`${randomText(rnd, 40).replace(/^-+/, "")}${eol()}`);
      }
    }
  };

  /** A multipart body, or null: { type, write() }. Boundaries are unique and never prefixes of each other. */
  const multipart = (depth) => {
    if (depth >= 4 || rnd() >= 0.45) return null;
    const boundary = `b${depth}x${++counter}y${int(rnd, 1e6)}`;
    const subtype = pick(rnd, ["mixed", "alternative", "related", "MIXED"]);
    return {
      type: `multipart/${subtype}; ${rnd() < 0.5 ? `boundary="${boundary}"` : `boundary=${boundary}`}`,
      write() {
        active.push(boundary);
        bodyLines(); // preamble
        for (let p = 1 + int(rnd, 3); p > 0; p--) {
          push(`--${boundary}${rnd() < 0.2 ? " \t" : ""}${eol()}`);
          part(depth + 1);
        }
        push(`--${boundary}--${eol()}`);
        active.pop();
        bodyLines(); // epilogue
      },
    };
  };

  const part = (depth) => {
    const nested = multipart(depth);
    if (!nested && rnd() < 0.15) {
      headerBlock("message/rfc822", false);
      push(eol());
      // An attached message: its headers are content and stay, internal or not.
      push(`X-Mozilla-Status: 0001${eol()}X-Account-Key: account1${eol()}Subject: joint${eol()}${eol()}texte${eol()}`);
      return;
    }
    headerBlock(nested ? nested.type : rnd() < 0.5 ? "text/plain; charset=UTF-8" : null, false);
    push(eol());
    if (nested) nested.write();
    else bodyLines();
  };

  const top = multipart(0);
  if (!top && rnd() < 0.08) {
    headerBlock(null, true); // headers only, up to the end of the data
  } else {
    headerBlock(top ? top.type : null, true);
    push(eol());
    if (top) top.write();
    else bodyLines();
  }
  const bytesOf = (piece) => (typeof piece === "string" ? encodeUtf8(piece) : piece);
  return {
    input: concat(segments.map(([piece]) => bytesOf(piece))),
    cleaned: concat(segments.filter(([, internal]) => !internal).map(([piece]) => bytesOf(piece))),
    stripped: concat(segments.filter(([, internal, topLevel]) => !(internal && topLevel)).map(([piece]) => bytesOf(piece))),
  };
}

test("fuzz MIME : messages générés, en-têtes internes retirés exactement", () => {
  const rnd = prng(0x5e11);
  for (let round = 0; round < 600; round++) {
    const { input, cleaned, stripped } = generate(rnd);
    const outClean = cleanDraft(input);
    if (!sameBytes(outClean, cleaned)) {
      throw new Error(`cleanDraft, tour ${round} :\nentrée  [${hex(input)}]\nattendu [${hex(cleaned)}]\nobtenu  [${hex(outClean)}]`);
    }
    const outStrip = stripInternalHeaders(input);
    if (!sameBytes(outStrip, stripped)) {
      throw new Error(`stripInternalHeaders, tour ${round} :\nentrée  [${hex(input)}]\nattendu [${hex(stripped)}]\nobtenu  [${hex(outStrip)}]`);
    }
    assert(cleanDraft(outClean) === outClean, `cleanDraft non idempotent, tour ${round}`);
  }
});

// ── 2. Mutated and random messages ────────────────────────────────────────

const INSERTS = [CR, LF, 0x20, 0x09, 0x2d, 0x3a, 0x3c, 0x3e, 0x28, 0x29, 0x22, 0x5c, 0x00, 0x58];

function mutate(rnd, bytes) {
  let b = bytes;
  for (let m = 1 + int(rnd, 6); m > 0; m--) {
    const at = int(rnd, b.length + 1);
    const r = rnd();
    if (r < 0.3 && b.length) {
      const copy = b.slice();
      copy[Math.min(at, copy.length - 1)] = rnd() < 0.5 ? pick(rnd, INSERTS) : int(rnd, 256);
      b = copy;
    } else if (r < 0.6) {
      b = concat([b.subarray(0, at), Uint8Array.of(pick(rnd, INSERTS)), b.subarray(at)]);
    } else if (r < 0.75) {
      b = concat([b.subarray(0, at), b.subarray(Math.min(b.length, at + 1 + int(rnd, 16)))]);
    } else if (r < 0.9) {
      const from = int(rnd, b.length + 1);
      const piece = b.subarray(from, Math.min(b.length, from + int(rnd, 64)));
      b = concat([b.subarray(0, at), piece, b.subarray(at)]);
    } else {
      b = b.subarray(0, at);
    }
  }
  return b;
}

function randomMessage(rnd) {
  const pieces = ["\r", "\n", "\r\n", " ", "\t", ":", "--", "-", "<", ">", "(", ")", "\\", '"', ";", "=", "a", "Z", "@", "é",
    "Message-ID", "message-id:", "X-Mozilla-Status", "Fcc", "X-Account-Key", "Content-Type: multipart/mixed; boundary=b",
    "boundary=", "multipart/", "--b", "--b--", "\r\n\r\n", "\n\n"];
  const parts = [];
  for (let k = int(rnd, 60); k > 0; k--) {
    if (rnd() < 0.1) {
      const bin = new Uint8Array(int(rnd, 16));
      for (let i = 0; i < bin.length; i++) bin[i] = int(rnd, 256);
      parts.push(bin);
    } else {
      parts.push(encodeUtf8(pick(rnd, pieces)));
    }
  }
  return concat(parts);
}

/** Lines of the top-level header block (LF, CRLF or a lone CR end a line; an empty line ends the block). */
function headerLines(text) {
  const out = [];
  let pos = 0;
  while (pos < text.length) {
    let e = pos;
    while (e < text.length && text[e] !== "\n" && text[e] !== "\r") e++;
    if (e === pos) break;
    out.push(text.slice(pos, e));
    pos = text[e] === "\r" && text[e + 1] === "\n" ? e + 2 : e + 1;
  }
  return out;
}

/** Every invariant of the MIME functions on one input; returns nothing, throws on a violation. */
function checkMime(input, label) {
  const started = Date.now();
  // Message-ID: null, or 1 to 998 visible ASCII characters without angle brackets.
  const mid = messageIdOf(input);
  if (mid !== null) {
    assert(typeof mid === "string" && mid.length >= 1 && mid.length <= MAX_MESSAGE_ID, `${label} : longueur ${mid.length}`);
    assert(/^[\x21-\x3b\x3d\x3f-\x7e]+$/.test(mid), `${label} : identifiant invalide ${JSON.stringify(mid)}`);
  }
  const ensured = ensureMessageId(input);
  eq(messageIdOf(ensured.bytes), ensured.messageId, `${label} : identifiant relu`);
  if (ensured.synthetic) {
    assert(mid === null, `${label} : synthétique alors qu'un identifiant existe`);
    assert(/^[0-9a-f]{32}@sync443\.invalid$/.test(ensured.messageId), `${label} : forme synthétique`);
    // Our field first (with the original's line ending), a guard when the original starts with a blank,
    // then the original with every Message-ID field renamed and nothing else changed.
    const text = Array.from(ensured.bytes, (x) => String.fromCharCode(x)).join("");
    const original = Array.from(input, (x) => String.fromCharCode(x)).join("");
    const head = /^Message-ID: <[0-9a-f]{32}@sync443\.invalid>(\r\n|\n)(X-Sync443-Continuation:(\r\n|\n))?/.exec(text);
    assert(head, `${label} : champ synthétique absent en tête`);
    assert(Boolean(head[2]) === (input.length > 0 && (input[0] === 0x20 || input[0] === 0x09)), `${label} : garde de repli`);
    const rest = text.slice(head[0].length);
    const unrename = (x) => x.toLowerCase().split("x-sync443-original-message-id").join("message-id");
    eq(unrename(rest), unrename(original), `${label} : seuls les noms des champs Message-ID changent`);
    assert(!headerLines(rest).some((l) => /^message-id[ \t]*:/i.test(l)), `${label} : un ancien Message-ID reste visible`);
  } else {
    assert(ensured.bytes === input && ensured.messageId === mid, `${label} : message déjà identifié modifié`);
  }
  for (const [name, fn] of [["stripInternalHeaders", stripInternalHeaders], ["cleanDraft", cleanDraft]]) {
    const out = fn(input);
    assert(out instanceof Uint8Array, `${label} : ${name} doit rendre des octets`);
    assert(out.length <= input.length, `${label} : ${name} a ajouté des octets`);
    assert(isSubsequence(out, input), `${label} : ${name} a modifié des octets [${hex(input)}]`);
    const again = fn(out);
    assert(again === out, `${label} : ${name} non idempotent [${hex(input)}] → [${hex(out)}] → [${hex(again)}]`);
  }
  // A received message keeps its body byte for byte, and its header block ends at the same place.
  const stripped = stripInternalHeaders(input);
  const at = bodyOffset(input);
  const outAt = bodyOffset(stripped);
  if (at < 0) {
    assert(outAt < 0, `${label} : un corps est apparu [${hex(input)}]`);
  } else {
    assert(outAt >= 0 && sameBytes(stripped.subarray(outAt), input.subarray(at)), `${label} : corps modifié [${hex(input)}] → [${hex(stripped)}]`);
  }
  const ms = Date.now() - started;
  assert(ms < 1000, `${label} : trop lent (${ms} ms)`);
}

test("fuzz MIME : messages générés puis mutés", () => {
  const rnd = prng(0xc0ffee);
  for (let round = 0; round < 1500; round++) checkMime(mutate(rnd, generate(rnd).input), `muté ${round}`);
});

test("fuzz MIME : suites aléatoires de morceaux d'en-têtes et d'octets", () => {
  const rnd = prng(0xbadc0de);
  for (let round = 0; round < 1500; round++) checkMime(randomMessage(rnd), `aléatoire ${round}`);
  checkMime(new Uint8Array(0), "vide");
});

// ── 3. Folder hierarchies ─────────────────────────────────────────────────

const NAMES = [
  "Inbox", "inbox", "INBOX", "Junk", "junk", "Archives", "Templates", "Sent", "Unsent Messages", "Trash", "Drafts",
  "Projets", "projets", "PROJETS", "Projets (2)", "projets (3)", "a/b", "a_b", "a\\b", "x.", "X", "x ", "...", ". .",
  "CON", "con.txt", "COM1", "lpt9.log", "Nul ", "CONIN$", "Aux.", "😀", "Straße", "STRASSE", "ß", "ss",
  "é", "e" + ch(0x301), "É", "L".repeat(120), `${"L".repeat(119)}M`, `${"L".repeat(96)} (2)`, "dossier:2026", "a*b?c",
  '"cité"', "<x>", "|", `ctl${ch(1)}${ch(0x1f)}`, `del${ch(0x7f)}`,
];
const RESERVED_KEYS = new Set(RESERVED_ROOT_NAMES.map((n) => n.toUpperCase().toLowerCase().normalize("NFC")));
const keyOf = (s) => s.toUpperCase().toLowerCase().normalize("NFC");
const DEVICE = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/i;

function randomTable(rnd) {
  const size = int(rnd, 90);
  const pool = Array.from({ length: Math.max(1, size + int(rnd, 10)) }, (_, i) => (rnd() < 0.85 ? String(i + 1) : pick(rnd, [`f:${i}`, `${i}A`, `${i}a`])));
  const table = new Map();
  for (let i = 0; i < size; i++) {
    let id = pick(rnd, pool);
    if (rnd() < 0.01) id = pick(rnd, ["0", "", "x".repeat(65), `bad${ch(0)}`]);
    const r = rnd();
    const parentId = r < 0.3 ? ROOT_ID : r < 0.92 ? pick(rnd, pool) : r < 0.97 ? "999" : pick(rnd, ["", null, 5]);
    const name = rnd() < 0.97 ? pick(rnd, NAMES) : pick(rnd, ["", 42, null]);
    const type = rnd() < 0.97 ? 1 + int(rnd, 19) : pick(rnd, [0, 20, "12", 2.5]);
    table.set(id, rnd() < 0.99 ? { parentId, name, type } : null);
  }
  return table;
}

function randomKinds(rnd) {
  return { mail: rnd() < 0.8, calendar: rnd() < 0.5, contacts: rnd() < 0.5, tasks: rnd() < 0.5 };
}

/** Independent check of whether an entry belongs in the tree: valid entry, chain of valid entries to the root, depth ≤ 32. */
function expectedDepth(table, id) {
  const valid = (k) => {
    const f = table.get(k);
    return typeof k === "string" && itemId(k) !== null && k !== ROOT_ID && f && typeof f === "object" &&
      itemId(f.parentId) !== null && typeof f.name === "string" && f.name.length > 0 && Number.isInteger(f.type) && f.type >= 1 && f.type <= 19;
  };
  let depth = 0;
  let current = id;
  const seen = new Set();
  for (;;) {
    if (!valid(current) || seen.has(current)) return -1;
    seen.add(current);
    depth++;
    const parent = table.get(current).parentId;
    if (parent === ROOT_ID) return depth <= MAX_DEPTH ? depth : -1;
    current = parent;
  }
}

function shuffled(rnd, map) {
  const entries = [...map];
  for (let i = entries.length - 1; i > 0; i--) {
    const j = int(rnd, i + 1);
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  return new Map(entries);
}

function checkTree(table, kinds, rnd, label) {
  const tree = buildTree(table, { kinds });
  const { nodes, rejected } = tree;
  assert(nodes.size <= MAX_TREE_FOLDERS, `${label} : trop de nœuds`);
  const rejectedIds = new Set();
  for (const r of rejected) {
    assert(r.serverId === null || table.has(r.serverId), `${label} : rejet d'un dossier inconnu`);
    assert(!nodes.has(r.serverId), `${label} : ${r.serverId} à la fois gardé et rejeté`);
    rejectedIds.add(r.serverId);
  }
  // Each node: chosen kind, same-kind parent already seen (parents first), right depth, reaches the root.
  const seen = new Set();
  for (const [id, n] of nodes) {
    const source = table.get(id);
    eq([n.name, n.type], [source.name, source.type], `${label} : ${id} recopié`);
    const kind = kindOf(n.type);
    assert(kind && kinds[kind] === true, `${label} : ${id} d'un élément non choisi`);
    if (n.parentId === ROOT_ID) {
      eq(n.depth, 1, `${label} : profondeur de ${id}`);
    } else {
      assert(seen.has(n.parentId), `${label} : parent de ${id} absent ou placé après`);
      eq(kindOf(nodes.get(n.parentId).type), kind, `${label} : parent de ${id} d'un autre élément`);
      eq(n.depth, nodes.get(n.parentId).depth + 1, `${label} : profondeur de ${id}`);
    }
    assert(n.depth >= 1 && n.depth <= MAX_DEPTH, `${label} : profondeur hors bornes`);
    seen.add(id);
  }
  // Completeness: what belongs in the tree is in it; every other entry of a chosen kind is reported.
  for (const [id, f] of table) {
    const depth = expectedDepth(table, id);
    const chosen = f && typeof f === "object" && kinds[kindOf(f.type)] === true;
    if (depth > 0 && chosen) assert(nodes.has(id), `${label} : ${id} aurait dû être gardé`);
    if (depth < 0 && chosen) assert(rejectedIds.has(typeof id === "string" ? id : null), `${label} : ${id} ni gardé ni signalé`);
    if (depth < 0) assert(!nodes.has(id), `${label} : ${id} gardé à tort`);
  }

  const paths = localPaths(tree);
  const special = specialFolders(tree);
  const keys = new Set();
  for (const [id, n] of nodes) {
    if (kindOf(n.type) !== "mail") {
      assert(!paths.has(id), `${label} : chemin pour un dossier qui n'est pas du courrier`);
      continue;
    }
    const path = paths.get(id);
    assert(typeof path === "string" && path.startsWith("/"), `${label} : ${id} sans chemin`);
    const key = keyOf(path);
    assert(!keys.has(key), `${label} : chemin en double ${path}`);
    keys.add(key);
    if (special.has(id)) {
      eq(path, SPECIAL_PATHS.get(special.get(id)), `${label} : dossier spécial ${id}`);
      continue;
    }
    const parentPath = n.parentId === ROOT_ID ? "" : paths.get(n.parentId);
    assert(path.startsWith(`${parentPath}/`), `${label} : ${path} hors de ${parentPath}`);
    const segment = path.slice(parentPath.length + 1);
    assert(segment.length > 0 && !segment.includes("/"), `${label} : segment ${JSON.stringify(segment)}`);
    assert([...segment].length <= MAX_NAME_LENGTH, `${label} : segment trop long`);
    assert(!/[\\:*?"<>|\x00-\x1f\x7f]/.test(segment), `${label} : caractère interdit dans ${JSON.stringify(segment)}`);
    assert(!/[. ]$/.test(segment), `${label} : point ou espace final dans ${JSON.stringify(segment)}`);
    const stem = segment.split(".")[0].replace(/ +$/, "");
    assert(!DEVICE.test(stem), `${label} : nom de périphérique ${segment}`);
    if (n.parentId === ROOT_ID) assert(!RESERVED_KEYS.has(keyOf(segment)), `${label} : nom réservé à la racine ${segment}`);
  }
  eq(paths.size, [...nodes.values()].filter((n) => kindOf(n.type) === "mail").length, `${label} : un chemin par dossier de courrier`);

  // Nothing depends on the order of the table.
  const again = buildTree(shuffled(rnd, table), { kinds });
  eq([...again.nodes], [...nodes], `${label} : nœuds selon l'ordre de la table`);
  eq(again.rejected, rejected, `${label} : rejets selon l'ordre de la table`);
  eq(localPaths(again), paths, `${label} : chemins selon l'ordre de la table`);
  return tree;
}

test("fuzz dossiers : tables aléatoires, arbre sans cycle et chemins un pour un", () => {
  const rnd = prng(0xf01de5);
  for (let round = 0; round < 400; round++) checkTree(randomTable(rnd), randomKinds(rnd), rnd, `table ${round}`);
});

test("fuzz dossiers : arbres profonds et larges, noms en collision", () => {
  const rnd = prng(0xdeef);
  for (let round = 0; round < 30; round++) {
    const table = new Map();
    const count = 200 + int(rnd, 600);
    for (let i = 1; i <= count; i++) {
      const parent = i === 1 || rnd() < 0.1 ? ROOT_ID : String(1 + int(rnd, i - 1)); // always an earlier folder: no cycle
      table.set(String(i), { parentId: parent, name: pick(rnd, NAMES.slice(0, 24)), type: pick(rnd, [12, 12, 12, 1, 2, 3, 4, 5, 6, 13]) });
    }
    // A long chain, beyond the depth limit.
    for (let d = 1; d <= MAX_DEPTH + 5; d++) table.set(`c${d}`, { parentId: d === 1 ? ROOT_ID : `c${d - 1}`, name: "Chaîne", type: 12 });
    checkTree(table, { mail: true, calendar: rnd() < 0.5, contacts: false, tasks: false }, rnd, `large ${round}`);
  }
});

test("fuzz dossiers : changements FolderSync aléatoires", () => {
  const rnd = prng(0x4c4a);
  for (let round = 0; round < 300; round++) {
    const before = randomTable(rnd);
    const snapshot = [...before];
    const pool = [...before.keys()].filter((k) => typeof k === "string");
    const changes = [];
    for (let k = int(rnd, 40); k > 0; k--) {
      const serverId = rnd() < 0.7 && pool.length ? pick(rnd, pool) : String(500 + int(rnd, 50));
      const op = pick(rnd, ["add", "update", "delete", "delete", "move", null]);
      changes.push({ op, serverId, parentId: rnd() < 0.3 ? ROOT_ID : pick(rnd, [...pool, "0", "998"]), displayName: pick(rnd, NAMES), type: 1 + int(rnd, 19) });
    }
    if (rnd() < 0.2) changes.push(null, "x", { op: "add" });
    const after = applyChanges(before, changes);
    eq([...before], snapshot, `tour ${round} : table d'origine modifiée`);
    assert(after.size <= MAX_STORED_FOLDERS, `tour ${round} : trop de dossiers`);
    // Deleted (and not added again) in this batch: neither they nor anything below them remain.
    const deleted = new Set();
    for (const c of changes) {
      if (!c || typeof c !== "object" || itemId(c.serverId) === null) continue;
      if (c.op === "delete") deleted.add(c.serverId);
      else if ((c.op === "add" || c.op === "update") && after.has(c.serverId)) deleted.delete(c.serverId);
    }
    for (const id of after.keys()) {
      const seen = new Set();
      for (let current = id; after.has(current) && !seen.has(current); current = after.get(current)?.parentId) {
        seen.add(current);
        assert(!deleted.has(current), `tour ${round} : ${id} est resté sous un dossier supprimé`);
        const parent = after.get(current)?.parentId;
        assert(!deleted.has(parent), `tour ${round} : ${id} est resté sous ${parent}, supprimé`);
      }
    }
    // Without deletions, nothing disappears.
    if (!changes.some((c) => c?.op === "delete")) for (const id of before.keys()) assert(after.has(id), `tour ${round} : ${id} perdu`);
    checkTree(after, randomKinds(rnd), rnd, `après changements ${round}`);
  }
});
