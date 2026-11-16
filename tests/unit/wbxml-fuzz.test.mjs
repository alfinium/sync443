// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Fuzzing of the WBXML decoder with fixed seeds (reproducible):
 *  1. random byte buffers;
 *  2. random mutations of valid documents;
 *  3. random valid trees, round-tripped encode → decode.
 * The decoder must return a well-formed tree within the limits, or throw a
 * WbxmlError: never another exception, never a hang.
 */

import { test, assert, eq, prng } from "./harness.mjs";
import { el, encode, decode, text, toDebugString, WbxmlError, DEFAULT_LIMITS } from "../../src/core/wbxml.mjs";
import { namespaceOf, tagOf } from "../../src/core/codepages.mjs";

const H = [0x03, 0x01, 0x6a, 0x00];
// Every [page, namespace, tag, token] of the code pages, in page then token order.
const TAGS = [];
for (let page = 0; page < 256; page++) {
  for (let token = 0; token < 256; token++) {
    const tag = tagOf(page, token);
    if (tag !== undefined) TAGS.push([page, namespaceOf(page), tag, token]);
  }
}
const TAGS_BY_NS = new Map();
for (const [, ns, tag] of TAGS) {
  if (!TAGS_BY_NS.has(ns)) TAGS_BY_NS.set(ns, []);
  TAGS_BY_NS.get(ns).push(tag);
}
const TIGHT = { maxBytes: 4096, maxNodes: 200, maxDepth: 12 };
const hex = (b) => Array.from(b.subarray(0, 64), (x) => x.toString(16).padStart(2, "0")).join(" ") + (b.length > 64 ? " …" : "");
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const int = (rnd, n) => Math.floor(rnd() * n);

/** Checks a decoded tree: shape, limits, and that the readers accept it. */
function checkTree(root, limits) {
  let nodes = 0;
  let height = 0;
  const stack = [[root, 1]];
  while (stack.length) {
    const [n, d] = stack.pop();
    nodes++;
    height = Math.max(height, d);
    assert(typeof n.ns === "string" && n.ns.length > 0 && typeof n.tag === "string" && n.tag.length > 0, "nom d'élément invalide");
    assert(Array.isArray(n.children), "children doit être un tableau");
    assert(n.value === null || n.value instanceof Uint8Array, "value doit être null ou Uint8Array");
    assert(typeof n.opaque === "boolean", "opaque doit être booléen");
    for (const c of n.children) stack.push([c, d + 1]);
  }
  assert(nodes <= limits.maxNodes, `maxNodes dépassé : ${nodes} > ${limits.maxNodes}`);
  // maxDepth counts elements with content; an empty element may sit one level below.
  assert(height <= limits.maxDepth + 1, `maxDepth dépassé : ${height} > ${limits.maxDepth} + 1`);
  text(root);
  const dbg = toDebugString(root, { shown: new Set(["Status", "SyncKey"]), maxLength: 2048 });
  assert(dbg.length <= 2050, "toDebugString non plafonné");
}

/** Decodes; any exception other than WbxmlError fails the test. Returns the tree or null. */
function tryDecode(input, limits, stats) {
  const full = { ...DEFAULT_LIMITS, ...limits };
  const started = Date.now();
  let tree = null;
  try {
    tree = decode(input, limits);
  } catch (e) {
    if (!(e instanceof WbxmlError)) throw new Error(`exception inattendue ${e?.name}: ${e?.message} pour [${hex(input)}]`);
    stats.refused++;
  }
  const ms = Date.now() - started;
  assert(ms < 500, `décodage trop lent (${ms} ms) pour [${hex(input)}]`);
  if (tree) {
    stats.accepted++;
    assert(input.length <= full.maxBytes, "document au-delà de maxBytes accepté");
    checkTree(tree, full);
  }
  return tree;
}

/** Random bytes biased toward WBXML tokens, so the fuzzer goes past the header. */
function biasedByte(rnd) {
  const r = rnd();
  if (r < 0.15) return pick(rnd, [0x00, 0x01, 0x03, 0xc3]);
  if (r < 0.45) return 0x05 + int(rnd, 0x3b) + (rnd() < 0.5 ? 0x40 : 0); // tag, with or without content
  if (r < 0.6) return int(rnd, 26); // page numbers, small lengths
  if (r < 0.85) return 0x20 + int(rnd, 0x5f); // text
  return int(rnd, 256);
}

// ── 1. Random buffers ─────────────────────────────────────────────────────

test("fuzz wbxml : 20 000 tampons aléatoires → arbre valide ou WbxmlError", () => {
  const rnd = prng(0xfa11);
  const stats = { accepted: 0, refused: 0 };
  for (let i = 0; i < 20_000; i++) {
    const mode = i % 3;
    let input;
    if (mode === 0) {
      input = new Uint8Array(int(rnd, 64)).map(() => int(rnd, 256));
    } else {
      const body = Array.from({ length: int(rnd, i % 2 ? 12 : 200) }, () => biasedByte(rnd));
      const header = mode === 1 ? H : [1 + int(rnd, 3), pick(rnd, [0x01, 0x00, 0x81]), 0x6a, int(rnd, 3)];
      input = new Uint8Array([...header, ...body]);
    }
    tryDecode(input, undefined, stats);
    tryDecode(input, TIGHT, stats);
  }
  assert(stats.refused > 0, "aucun refus : générateur inefficace");
  assert(stats.accepted > 50, `trop peu de documents acceptés (${stats.accepted}) : le fuzzing reste en surface`);
});

test("fuzz wbxml : documents aléatoires dont les éléments restent bien imbriqués", () => {
  // Structurally plausible streams (balanced START/END) with random tokens in between.
  const rnd = prng(0xba1a);
  const stats = { accepted: 0, refused: 0 };
  for (let i = 0; i < 10_000; i++) {
    const out = [...H];
    let open = 0;
    const steps = 1 + int(rnd, 60);
    out.push(0x45 + int(rnd, 0x3a));
    open++;
    for (let s = 0; s < steps && open > 0; s++) {
      const r = rnd();
      if (r < 0.3) {
        out.push(0x45 + int(rnd, 0x3a));
        open++;
      } else if (r < 0.5) {
        out.push(0x05 + int(rnd, 0x3a));
      } else if (r < 0.65) {
        out.push(0x03, ...Array.from({ length: int(rnd, 6) }, () => 1 + int(rnd, 255)), 0x00);
      } else if (r < 0.72) {
        const n = int(rnd, 5);
        out.push(0xc3, n, ...Array.from({ length: n }, () => int(rnd, 256)));
      } else if (r < 0.8) {
        out.push(0x00, int(rnd, 30));
      } else if (r < 0.98) {
        out.push(0x01);
        open--;
      } else {
        out.push(int(rnd, 256));
      }
    }
    while (open-- > 0) out.push(0x01);
    tryDecode(new Uint8Array(out), undefined, stats);
    tryDecode(new Uint8Array(out), { maxBytes: 64, maxNodes: 8, maxDepth: 3 }, stats);
  }
  assert(stats.accepted > 3000, `trop peu de documents acceptés (${stats.accepted})`);
});

// ── 2. Mutations of valid documents ───────────────────────────────────────

const SEEDS = [
  el("FolderHierarchy:FolderSync", [
    el("Status", "1"),
    el("SyncKey", "{a3f1-77}"),
    el("Changes", [
      el("Count", "2"),
      el("Add", [el("ServerId", "5"), el("ParentId", "0"), el("DisplayName", "Boîte de réception"), el("Type", "2")]),
      el("Update", [el("ServerId", "6"), el("ParentId", "5"), el("DisplayName", "Archives 📦"), el("Type", "12")]),
    ]),
  ]),
  el("AirSync:Sync", [
    el("Collections", [
      el("Collection", [
        el("SyncKey", "42"),
        el("CollectionId", "5"),
        el("Status", "1"),
        el("Commands", [
          el("Add", [
            el("ServerId", "5:1"),
            el("ApplicationData", [
              el("Email:Subject", "Réunion"),
              el("Email:From", "\"Dupont\" <jean@example.com>"),
              el("AirSyncBase:Body", [el("Type", "4"), el("EstimatedDataSize", "12"), el("Data", "MIME-Version: 1.0")]),
            ]),
          ]),
          el("Delete", [el("ServerId", "5:2")]),
        ]),
        el("MoreAvailable"),
      ]),
    ]),
  ]),
  el("Provision:Provision", [
    el("Status", "1"),
    el("Policies", [el("Policy", [el("PolicyType", "MS-EAS-Provisioning-WBXML"), el("Status", "1"), el("PolicyKey", "1307199584")])]),
    el("RemoteWipe"),
  ]),
  el("ComposeMail:SendMail", [el("ClientId", "c1"), el("SaveInSentItems"), el("Mime", new Uint8Array(300).map((_, i) => i & 0xff))]),
].map(encode);

const SPECIAL = [0x00, 0x01, 0x02, 0x03, 0x04, 0x40, 0x43, 0x80, 0x83, 0x85, 0xc3, 0xc5, 0xff, 0x7f];

function mutate(rnd, src) {
  let b = Array.from(src);
  const ops = 1 + int(rnd, 4);
  for (let k = 0; k < ops; k++) {
    const at = int(rnd, b.length + 1);
    switch (int(rnd, 8)) {
      case 0: if (b.length) b[at % b.length] ^= 1 << int(rnd, 8); break; // bit flip
      case 1: if (b.length) b[at % b.length] = int(rnd, 256); break; // random byte
      case 2: if (b.length) b[at % b.length] = pick(rnd, SPECIAL); break; // WBXML token
      case 3: b.splice(at, 0, ...Array.from({ length: 1 + int(rnd, 4) }, () => biasedByte(rnd))); break; // insert
      case 4: b.splice(at, 1 + int(rnd, 8)); break; // delete
      case 5: b = b.slice(0, at); break; // truncate
      case 6: { // duplicate a slice
        const from = int(rnd, b.length + 1);
        b.splice(at, 0, ...b.slice(from, from + int(rnd, 16)));
        break;
      }
      default: { // swap two bytes
        const j = int(rnd, b.length);
        if (b.length) [b[at % b.length], b[j]] = [b[j], b[at % b.length]];
      }
    }
  }
  return new Uint8Array(b);
}

test("fuzz wbxml : 20 000 mutations de documents valides → arbre valide ou WbxmlError", () => {
  const rnd = prng(0x6d757461);
  const stats = { accepted: 0, refused: 0 };
  for (let i = 0; i < 20_000; i++) {
    const input = mutate(rnd, SEEDS[i % SEEDS.length]);
    tryDecode(input, undefined, stats);
    tryDecode(input, TIGHT, stats);
  }
  assert(stats.accepted > 100 && stats.refused > 100, `répartition suspecte : ${JSON.stringify(stats)}`);
});

test("fuzz wbxml : tout préfixe strict d'un document valide est refusé", () => {
  for (const seed of SEEDS) {
    eq(decode(seed) !== null, true);
    for (let n = 0; n < seed.length; n++) {
      let err = null;
      try {
        decode(seed.subarray(0, n));
      } catch (e) {
        err = e;
      }
      assert(err instanceof WbxmlError, `préfixe de ${n}/${seed.length} octets accepté ou mauvaise exception (${err?.name})`);
    }
  }
});

// ── 3. Random valid trees ─────────────────────────────────────────────────

function randomText(rnd) {
  let s = "";
  const n = int(rnd, 16);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.5) s += String.fromCharCode(1 + int(rnd, 0x7e));
    else if (r < 0.7) s += String.fromCharCode(0x80 + int(rnd, 0x780));
    else if (r < 0.85) s += String.fromCharCode(0xe000 + int(rnd, 0x2000));
    else if (r < 0.97) s += String.fromCodePoint(0x10000 + int(rnd, 0x100000));
    else s += String.fromCharCode(0xd800 + int(rnd, 0x800)); // lone surrogate: becomes U+FFFD
  }
  return s;
}

function randomTree(rnd, budget, parentNs = null, depth = 0) {
  budget.left--;
  let ns;
  let name;
  if (parentNs && rnd() < 0.5) {
    ns = parentNs;
    name = pick(rnd, TAGS_BY_NS.get(ns)); // bare name: inherits the parent's namespace
  } else {
    [, ns] = pick(rnd, TAGS);
    name = `${ns}:${pick(rnd, TAGS_BY_NS.get(ns))}`;
  }
  const r = rnd();
  if (depth >= 10 || budget.left <= 0 || r < 0.3) return el(name, randomText(rnd));
  if (r < 0.4) return el(name, new Uint8Array(int(rnd, 40)).map(() => int(rnd, 256)));
  if (r < 0.5) return el(name);
  if (r < 0.52) return el(name, int(rnd, 1e6));
  const kids = [];
  const n = int(rnd, 6);
  for (let i = 0; i < n && budget.left > 0; i++) kids.push(rnd() < 0.05 ? null : randomTree(rnd, budget, ns, depth + 1));
  return el(name, kids);
}

/** Compares a decoded tree with the tree it was encoded from (namespaces resolved). */
function sameTree(decoded, original, inheritedNs, path = "racine") {
  const ns = original.ns ?? inheritedNs;
  eq([decoded.ns, decoded.tag], [ns, original.tag], path);
  eq(decoded.value, original.value, `${path} : valeur`);
  eq(decoded.opaque, original.opaque && original.value !== null, `${path} : opaque`);
  eq(decoded.children.length, original.children.length, `${path} : enfants`);
  original.children.forEach((c, i) => sameTree(decoded.children[i], c, ns, `${path}/${c.tag}[${i}]`));
}

const measure = (node) => {
  let nodes = 0;
  const depth = (n) => {
    nodes++;
    if (n.value && n.value.length) nodes++; // a non-empty value is one piece, and pieces count too
    const kids = n.children.map(depth);
    return n.value !== null || n.children.length ? 1 + Math.max(0, ...kids) : 0;
  };
  const d = depth(node);
  return { nodes, depth: d };
};

test("fuzz wbxml : 3000 arbres valides aléatoires, aller-retour exact et limites précises", () => {
  const rnd = prng(0x7aee);
  for (let i = 0; i < 3000; i++) {
    const tree = randomTree(rnd, { left: 1 + int(rnd, 300) });
    if (!tree.ns) continue;
    const bytesOut = encode(tree);
    const back = decode(bytesOut);
    sameTree(back, tree, tree.ns);
    eq(encode(back), bytesOut, "ré-encodage identique");
    // Limits are exact: the document passes at its own size, and fails one below.
    const { nodes, depth } = measure(tree);
    decode(bytesOut, { maxNodes: nodes, maxDepth: depth, maxBytes: bytesOut.length });
    assert(throwsWbxml(() => decode(bytesOut, { maxNodes: nodes - 1 })), `maxNodes ${nodes - 1} non respecté`);
    if (depth > 0) assert(throwsWbxml(() => decode(bytesOut, { maxDepth: depth - 1 })), `maxDepth ${depth - 1} non respecté`);
    assert(throwsWbxml(() => decode(bytesOut, { maxBytes: bytesOut.length - 1 })), "maxBytes non respecté");
  }
});

function throwsWbxml(fn) {
  try {
    fn();
  } catch (e) {
    if (e instanceof WbxmlError) return true;
    throw e;
  }
  return false;
}

// ── Performance and hostile shapes ────────────────────────────────────────

test("fuzz wbxml : 100 000 petits morceaux de texte dans un élément, en temps linéaire", () => {
  const n = 100_000;
  const buf = new Uint8Array(4 + 1 + 3 * n + 1);
  buf.set(H, 0);
  buf[4] = 0x4b; // AirSync:SyncKey with content
  for (let i = 0; i < n; i++) buf.set([0x03, 0x61 + (i % 26), 0x00], 5 + 3 * i);
  buf[buf.length - 1] = 0x01;
  const started = Date.now();
  const d = decode(buf);
  const ms = Date.now() - started;
  eq(d.value.length, n);
  eq(text(d).slice(0, 28), "abcdefghijklmnopqrstuvwxyzab");
  assert(ms < 1000, `décodage de ${n} morceaux en ${ms} ms (attendu bien moins de 2 s)`);
});

test("fuzz wbxml : 100 000 morceaux opaques dans un élément, en temps linéaire", () => {
  const n = 100_000;
  const buf = new Uint8Array(4 + 1 + 3 * n + 1);
  buf.set(H, 0);
  buf[4] = 0x4b;
  for (let i = 0; i < n; i++) buf.set([0xc3, 0x01, i & 0xff], 5 + 3 * i);
  buf[buf.length - 1] = 0x01;
  const started = Date.now();
  const d = decode(buf);
  const ms = Date.now() - started;
  eq([d.value.length, d.opaque, d.value[300]], [n, true, 300 & 0xff]);
  assert(ms < 1000, `décodage en ${ms} ms`);
});

test("fuzz wbxml : imbrication maxDepth + 1 refusée, maxDepth acceptée", () => {
  const nest = (n) => new Uint8Array([...H, ...Array(n).fill(0x45), 0x03, 0x78, 0x00, ...Array(n).fill(0x01)]);
  const max = DEFAULT_LIMITS.maxDepth;
  decode(nest(max));
  assert(throwsWbxml(() => decode(nest(max + 1))), `${max + 1} niveaux acceptés`);
  assert(throwsWbxml(() => decode(nest(9), { maxDepth: 8 })), "9 niveaux acceptés avec maxDepth 8");
});

test("fuzz wbxml : gros tampons aléatoires et pathologiques sans blocage", () => {
  const rnd = prng(0xb16);
  const cases = [
    new Uint8Array([...H, ...new Uint8Array(1_000_000).map(() => biasedByte(rnd))]),
    new Uint8Array([...H, 0x45, ...new Uint8Array(500_000).fill(0x05), 0x01]), // 500 001 elements
    new Uint8Array([...H, 0x4b, 0x03, ...new Uint8Array(1_000_000).fill(0x61)]), // string without its NUL
    new Uint8Array([...H, ...new Uint8Array(1_000_000).fill(0x00)]), // SWITCH_PAGE 0, over and over
    new Uint8Array([...H, 0x4b, ...Array.from({ length: 300_000 }, (_, i) => (i % 3 === 0 ? 0x03 : i % 3 === 1 ? 0x62 : 0x00)), 0x01]),
  ];
  const counts = { accepted: 0, refused: 0 };
  const started = Date.now();
  for (const c of cases) {
    tryDecode(c, undefined, counts);
    tryDecode(c, { maxNodes: 1000 }, counts);
  }
  const ms = Date.now() - started;
  assert(ms < 3000, `trop lent : ${ms} ms`);
  // 500 001 empty elements under maxNodes 1000 must be refused.
  assert(throwsWbxml(() => decode(cases[1], { maxNodes: 1000 })), "maxNodes ignoré");
});
