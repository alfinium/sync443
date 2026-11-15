// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * WBXML tests, from WAP-192 (WBXML 1.3: header, global tokens, mb_u_int32)
 * and [MS-ASWBXML] (code pages), and from the behaviour documented at the
 * top of src/core/wbxml.mjs.
 */

import { test, assert, eq, throws } from "./harness.mjs";
import {
  el, encode, decode, child, childrenNamed, at, text, bytes, toDebugString, looksLikeWbxml, WbxmlError, DEFAULT_LIMITS,
} from "../../src/core/wbxml.mjs";
import { encodeUtf8 } from "../../src/core/utf8.mjs";

const H = [0x03, 0x01, 0x6a, 0x00]; // WBXML 1.3, unknown public id, UTF-8, empty string table
const doc = (...body) => new Uint8Array([...H, ...body.flat()]);
const strI = (s) => [0x03, ...encodeUtf8(s), 0x00];
const isWbxml = (e) => e instanceof WbxmlError;
const refuse = (bytesIn, what, limits) => throws(() => decode(bytesIn, limits), isWbxml, what);

/** n nested AirSync:Sync elements, the innermost holding the text "x": n levels with content. */
const nestBytes = (n) => doc(Array(n).fill(0x45), strI("x"), Array(n).fill(0x01));
const nestTree = (n) => {
  let node = el("AirSync:Sync", "x");
  for (let i = 1; i < n; i++) node = el("AirSync:Sync", [node]);
  return node;
};

// ── Encoding ──────────────────────────────────────────────────────────────

test("wbxml : FolderSync avec SyncKey 0, octet par octet", () => {
  const out = encode(el("FolderHierarchy:FolderSync", [el("SyncKey", "0")]));
  // header, SWITCH_PAGE 7, FolderSync|content, SyncKey|content, STR_I "0", END, END
  eq(out, new Uint8Array([0x03, 0x01, 0x6a, 0x00, 0x00, 0x07, 0x56, 0x52, 0x03, 0x30, 0x00, 0x01, 0x01]));
  const back = decode(out);
  eq([back.ns, back.tag], ["FolderHierarchy", "FolderSync"]);
  eq(text(back, "SyncKey"), "0");
});

test("wbxml : racine en page 0 sans SWITCH_PAGE, élément vide sans bit de contenu", () => {
  eq(encode(el("AirSync:Sync", [el("Collections")])), doc(0x45, 0x1c, 0x01));
  eq(encode(el("AirSync:Sync")), doc(0x05));
});

test("wbxml : changement de page et retour, espace de noms hérité du parent", () => {
  const root = el("AirSync:Sync", [
    el("Collections", [
      el("Collection", [
        el("Options", [el("AirSyncBase:BodyPreference", [el("Type", "2")]), el("MIMESupport", "0")]),
      ]),
    ]),
  ]);
  const expected = doc(
    0x45, 0x5c, 0x4f, 0x57, // Sync, Collections, Collection, Options
    0x00, 0x11, 0x45, 0x46, strI("2"), 0x01, 0x01, // page 17: BodyPreference > Type "2"
    0x00, 0x00, 0x62, strI("0"), 0x01, // back to page 0: MIMESupport "0"
    0x01, 0x01, 0x01, 0x01,
  );
  eq(encode(root), expected);
  const options = at(decode(expected), "Collections", "Collection", "Options");
  eq([options.children[0].ns, options.children[0].children[0].ns, options.children[0].children[0].tag], ["AirSyncBase", "AirSyncBase", "Type"]);
  eq([options.children[1].ns, options.children[1].tag], ["AirSync", "MIMESupport"]);
});

test("wbxml : el() — nom qualifié ou non, types de contenu", () => {
  const a = el("Email:Subject", "Bonjour");
  eq([a.ns, a.tag, a.opaque, a.children], ["Email", "Subject", false, []]);
  eq(a.value, encodeUtf8("Bonjour"));
  const b = el("SyncKey");
  eq([b.ns, b.tag, b.value], [null, "SyncKey", null]);
  eq(el("WindowSize", 42).value, encodeUtf8("42"), "nombre");
  eq(el("WindowSize", 0).value, encodeUtf8("0"), "le nombre 0 n'est pas « absent »");
  eq(el("SyncKey", "").value, new Uint8Array(0), "texte vide");
  const raw = new Uint8Array([0, 1, 2]);
  const c = el("ComposeMail:Mime", raw);
  eq([c.opaque, c.value], [true, raw]);
  const d = el("AirSync:Sync", [null, el("Status", "1"), undefined, false, el("SyncKey", "2")]);
  eq(d.children.map((x) => x.tag), ["Status", "SyncKey"], "entrées vides ignorées");
  for (const bad of [{}, true, Symbol("x"), () => 1, new ArrayBuffer(2), [1, 2].values()]) {
    throws(() => el("AirSync:Sync", bad), isWbxml, `contenu ${String(bad?.toString?.() ?? typeof bad)}`);
  }
});

test("wbxml : U+0000 refusé dans le texte, accepté dans les données opaques", () => {
  throws(() => el("AirSync:SyncKey", "a\u0000b"), isWbxml, "el()");
  const forged = el("AirSync:SyncKey", "ab");
  forged.value = new Uint8Array([0x61, 0x00, 0x03, 0x62]);
  throws(() => encode(forged), isWbxml, "valeur modifiée à la main");
  const nested = el("AirSync:Sync", [forged]);
  throws(() => encode(nested), isWbxml, "dans un descendant");
  const mime = el("ComposeMail:Mime", new Uint8Array([0x00, 0x01, 0x00]));
  eq(decode(encode(mime)).value, new Uint8Array([0x00, 0x01, 0x00]));
});

test("wbxml : encode refuse racine sans espace de noms, noms inconnus, contenu mêlé", () => {
  throws(() => encode(el("Sync")), isWbxml, "racine sans espace de noms");
  throws(() => encode(null), isWbxml, "racine null");
  throws(() => encode(undefined), isWbxml, "racine absente");
  throws(() => encode(el(":Sync")), isWbxml, "espace de noms vide");
  throws(() => encode(el("Inconnu:Sync")), isWbxml, "espace de noms inconnu");
  throws(() => encode(el("AirSync:Inconnu")), isWbxml, "balise inconnue");
  throws(() => encode(el("AirSync:Sync", [el("Subject", "x")])), isWbxml, "balise d'un autre espace sans préfixe");
  throws(() => encode(el("AirSync:Sync", [el("Email:Subject", [el("Inconnu")])])), isWbxml, "balise inconnue en profondeur");
  const mixed = el("AirSync:Sync", [el("Status", "1")]);
  mixed.value = encodeUtf8("texte");
  throws(() => encode(mixed), isWbxml, "texte et enfants");
});

test("wbxml : longueur des données opaques codée en mb_u_int32", () => {
  const cases = [[0, [0x00]], [1, [0x01]], [127, [0x7f]], [128, [0x81, 0x00]], [300, [0x82, 0x2c]], [16383, [0xff, 0x7f]], [16384, [0x81, 0x80, 0x00]]];
  for (const [n, prefix] of cases) {
    const data = new Uint8Array(n).map((_, i) => i & 0xff);
    const out = encode(el("ComposeMail:Mime", data));
    // header, SWITCH_PAGE 21, Mime|content, OPAQUE, length, data, END
    eq(Array.from(out.slice(0, 8 + prefix.length)), [...H, 0x00, 0x15, 0x50, 0xc3, ...prefix], `longueur ${n}`);
    eq(out.length, 8 + prefix.length + n + 1, `taille totale pour ${n}`);
    const back = decode(out);
    eq([back.opaque, back.value], [true, data], `relecture ${n}`);
  }
});

test("wbxml : texte vide et élément vide se distinguent", () => {
  const withEmpty = encode(el("AirSync:SyncKey", ""));
  eq(withEmpty, doc(0x4b, 0x03, 0x00, 0x01));
  const a = decode(withEmpty);
  eq([a.value, text(a), bytes(a)], [new Uint8Array(0), "", new Uint8Array(0)]);
  const empty = encode(el("AirSync:SyncKey"));
  eq(empty, doc(0x0b));
  const b = decode(empty);
  eq([b.value, text(b), bytes(b)], [null, "", new Uint8Array(0)]);
});

test("wbxml : grand document (croissance du tampon d'écriture)", () => {
  const big = new Uint8Array(300_000).map((_, i) => (i * 7) & 0xff);
  const many = Array.from({ length: 5000 }, (_, i) => el("Email:Subject", `objet n° ${i} — é😀`));
  const root = el("AirSync:Sync", [el("ComposeMail:Mime", big), el("AirSync:Commands", many)]);
  const back = decode(encode(root));
  eq(bytes(back, "ComposeMail:Mime"), big);
  const subjects = childrenNamed(child(back, "Commands"), "Subject");
  eq(subjects.length, 5000);
  eq(text(subjects[4321]), "objet n° 4321 — é😀");
});

test("wbxml : l'encodeur refuse une imbrication au-delà de maxDepth", () => {
  const max = DEFAULT_LIMITS.maxDepth;
  eq(decode(encode(nestTree(max))).tag, "Sync", `${max} niveaux acceptés`);
  throws(() => encode(nestTree(max + 1)), isWbxml, `${max + 1} niveaux`);
});

test("wbxml : encode → decode conserve les caractères hors ASCII et astraux", () => {
  const s = "Réunion « budget » 📅 — 日本語 \u{10ffff}\t\r\n";
  eq(text(decode(encode(el("Email:Subject", s)))), s);
  // A lone surrogate becomes U+FFFD on the way (UTF-8 cannot carry it).
  eq(text(decode(encode(el("Email:Subject", "a\ud800b")))), "a�b");
});

// ── Decoding: header ──────────────────────────────────────────────────────

test("wbxml : en-tête — versions 1.1 à 1.3, autres refusées", () => {
  for (const v of [0x01, 0x02, 0x03]) eq(decode(new Uint8Array([v, 0x01, 0x6a, 0x00, 0x05])).tag, "Sync", `version ${v}`);
  for (const v of [0x00, 0x04, 0x13, 0xff]) refuse(new Uint8Array([v, 0x01, 0x6a, 0x00, 0x05]), `version ${v}`);
});

test("wbxml : en-tête — identifiant public sur plusieurs octets ou index de table", () => {
  eq(decode(new Uint8Array([0x03, 0x81, 0x01, 0x6a, 0x00, 0x05])).tag, "Sync", "identifiant public 0x81 0x01");
  eq(decode(new Uint8Array([0x03, 0x00, 0x05, 0x6a, 0x03, 0x61, 0x62, 0x00, 0x05])).tag, "Sync", "index 5 + table de 3 octets");
  eq(decode(new Uint8Array([0x03, 0x01, 0x80, 0x6a, 0x00, 0x05])).tag, "Sync", "jeu 106 codé sur deux octets");
  refuse(new Uint8Array([0x03, 0x01, 0x6a, 0x05, 0x61, 0x00]), "table des chaînes plus longue que le document");
  refuse(new Uint8Array([0x03, 0x01, 0x6a, 0x8f, 0xff, 0xff, 0xff, 0x7f, 0x05]), "table des chaînes de 4 Gio");
});

test("wbxml : jeu de caractères autre que UTF-8 refusé", () => {
  for (const cs of [[0x00], [0x03], [0x04], [0x6b], [0x87, 0x77]]) {
    const e = refuse(new Uint8Array([0x03, 0x01, ...cs, 0x00, 0x05]), `jeu ${cs}`);
    assert(/caract/.test(e.message), e.message);
  }
});

test("wbxml : looksLikeWbxml", () => {
  assert(looksLikeWbxml(doc(0x05)));
  assert(looksLikeWbxml(new Uint8Array([0x01, 0x01, 0x6a, 0x00])));
  assert(!looksLikeWbxml(new Uint8Array([0x03, 0x01, 0x6a])), "trop court");
  assert(!looksLikeWbxml(encodeUtf8("<html><body>")), "HTML");
  assert(!looksLikeWbxml(new Uint8Array([0x00, 0x01, 0x6a, 0x00])), "version 0");
  assert(!looksLikeWbxml(new Uint8Array([0x04, 0x01, 0x6a, 0x00])), "version 4");
});

// ── Decoding: structure ───────────────────────────────────────────────────

test("wbxml : documents tronqués refusés", () => {
  refuse(new Uint8Array([]), "vide");
  refuse(new Uint8Array([0x03]), "1 octet");
  refuse(new Uint8Array([0x03, 0x01, 0x6a]), "3 octets");
  refuse(doc(), "en-tête seul");
  refuse(new Uint8Array([0x03, 0x81, 0x81, 0x81]), "entier de l'en-tête tronqué");
  refuse(doc(0x45), "élément non refermé");
  refuse(doc(0x45, 0x4b, strI("a"), 0x01), "racine non refermée");
  refuse(doc(0x4b, 0x03, 0x61, 0x62), "texte sans terminaison");
  refuse(doc(0x45, 0x00), "changement de page sans numéro");
  refuse(doc(0x4b, 0xc3), "longueur opaque absente");
  refuse(doc(0x4b, 0xc3, 0x81), "longueur opaque tronquée");
  const full = encode(el("AirSync:Sync", [el("Status", "1"), el("ComposeMail:Mime", new Uint8Array([1, 2, 3])), el("Email:Subject", "é")]));
  for (let n = 0; n < full.length; n++) refuse(full.subarray(0, n), `préfixe de ${n} octets`);
  eq(decode(full).children.length, 3, "le document complet est accepté");
});

test("wbxml : END sans élément ouvert, plusieurs racines, texte hors élément", () => {
  refuse(doc(0x01), "END seul");
  refuse(doc(0x45, 0x01, 0x01), "END en trop");
  assert(/plusieurs/.test(refuse(doc(0x05, 0x05), "deux racines vides").message), "refus dès la seconde racine");
  refuse(doc(0x45, 0x01, 0x05), "seconde racine après la première");
  refuse(doc(0x45, 0x01, 0x45, 0x01), "deux racines avec contenu");
  refuse(doc(strI("x"), 0x05), "texte avant la racine");
  refuse(doc(0x45, 0x01, strI("x")), "texte après la racine");
  refuse(doc(0xc3, 0x01, 0x61, 0x05), "données opaques hors élément");
});

test("wbxml : attributs, entités, extensions, STR_T, PI et LITERAL refusés", () => {
  const tokens = {
    0x02: "ENTITY", 0x04: "LITERAL", 0x40: "EXT_I_0", 0x41: "EXT_I_1", 0x42: "EXT_I_2", 0x43: "PI", 0x44: "LITERAL_C",
    0x80: "EXT_T_0", 0x81: "EXT_T_1", 0x82: "EXT_T_2", 0x83: "STR_T", 0x84: "LITERAL_A", 0xc0: "EXT_0", 0xc1: "EXT_1",
    0xc2: "EXT_2", 0xc4: "LITERAL_AC", 0x85: "Sync avec attributs", 0xc5: "Sync avec attributs et contenu", 0xbf: "attributs",
  };
  for (const [tok, name] of Object.entries(tokens)) {
    refuse(doc(0x45, Number(tok), 0x00, 0x00, 0x00, 0x01, 0x01), `${name} dans un élément`);
    refuse(doc(Number(tok), 0x00, 0x01), `${name} à la racine`);
  }
});

test("wbxml : entiers mb_u_int32 trop grands ou trop longs", () => {
  let e = refuse(doc(0x4b, 0xc3, 0x90, 0x80, 0x80, 0x80, 0x00, 0x01), "2^32");
  assert(/hors limites/.test(e.message), e.message);
  e = refuse(doc(0x4b, 0xc3, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, 0x61, 0x01), "6 octets");
  assert(/trop long/.test(e.message), e.message);
  e = refuse(doc(0x4b, 0xc3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x01), "valeur énorme");
  assert(/trop long|hors limites/.test(e.message), e.message);
  e = refuse(doc(0x4b, 0xc3, 0x8f, 0xff, 0xff, 0xff, 0x7f, 0x01), "2^32−1, plus grand que le document");
  assert(/tronqué/.test(e.message), e.message);
  refuse(new Uint8Array([0x03, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, 0x6a, 0x00, 0x05]), "identifiant public sur 6 octets");
  refuse(new Uint8Array([0x03, 0x01, 0x90, 0x80, 0x80, 0x80, 0x00, 0x00, 0x05]), "jeu de caractères ≥ 2^32");
  // Five bytes with leading zero groups are still a valid (if wasteful) encoding.
  eq(decode(doc(0x4b, 0xc3, 0x80, 0x80, 0x80, 0x80, 0x02, 0x61, 0x62, 0x01)).value, new Uint8Array([0x61, 0x62]));
});

test("wbxml : données opaques s'étendant au-delà de la fin", () => {
  const e = refuse(doc(0x4b, 0xc3, 0x05, 0x01, 0x02, 0x03), "5 annoncés, 3 présents");
  assert(/opaques/.test(e.message), `cause précise attendue : ${e.message}`);
  refuse(doc(0x4b, 0xc3, 0x04, 0x01, 0x02, 0x03, 0x01), "la longueur avale le END");
  eq(decode(doc(0x4b, 0xc3, 0x03, 0x01, 0x02, 0x03, 0x01)).value, new Uint8Array([1, 2, 3]), "longueur exacte");
});

test("wbxml : noms provisoires pour les pages et jetons inconnus", () => {
  const d = decode(doc(0x00, 0x1a, 0x45, 0x2c, 0x00, 0x00, 0x51, strI("v"), 0x01, 0x01));
  eq([d.ns, d.tag], ["#page26", "#0x5"]);
  eq([d.children[0].ns, d.children[0].tag], ["#page26", "#0x2c"]);
  eq([d.children[1].ns, d.children[1].tag, text(d.children[1])], ["AirSync", "#0x11", "v"], "jeton inutilisé d'une page connue");
  eq(decode(doc(0x00, 0x03, 0x05)).ns, "#page3", "page 3 (AirNotify) non gérée");
  eq(decode(doc(0x00, 0xff, 0x3f)).ns, "#page255");
  // Readers do not mistake them for real tags.
  const e = decode(doc(0x45, 0x00, 0x1a, 0x4e, strI("140"), 0x01, 0x01));
  eq(child(e, "Status"), null);
});

test("wbxml : le texte s'arrête au premier NUL ; morceaux concaténés", () => {
  eq(text(decode(doc(0x4b, 0x03, 0x61, 0x00, 0x03, 0x62, 0x00, 0x01))), "ab");
  const mixed = decode(doc(0x4b, strI("ab"), 0xc3, 0x01, 0x63, strI("d"), 0x01));
  eq([text(mixed), mixed.opaque], ["abcd", true], "texte et données opaques");
  const multi = decode(doc(0x4b, strI("é"), strI("😀"), 0x01));
  eq(text(multi), "é😀");
  // A multi-byte character split across two pieces is joined before decoding.
  eq(text(decode(doc(0x4b, 0x03, 0xc3, 0x00, 0x03, 0xa9, 0x00, 0x01))), "é");
});

test("wbxml : texte UTF-8 invalide remplacé à la lecture", () => {
  eq(text(decode(doc(0x4b, 0x03, 0xc3, 0x28, 0xff, 0x00, 0x01))), "�(�");
});

test("wbxml : entrée autre qu'un Uint8Array refusée", () => {
  for (const bad of [null, undefined, "abc", [3, 1, 106, 0, 5], new ArrayBuffer(8), new Uint16Array(5), new Uint8ClampedArray([3, 1, 106, 0, 5]), {}]) {
    refuse(bad, `entrée ${Object.prototype.toString.call(bad)}`);
  }
});

test("wbxml : sous-tableau avec décalage", () => {
  const full = encode(el("AirSync:Sync", [el("SyncKey", "k1"), el("Status", "1")]));
  const host = new Uint8Array(full.length + 20).fill(0x00);
  host.set(full, 10);
  const d = decode(host.subarray(10, 10 + full.length));
  eq([text(d, "SyncKey"), text(d, "Status")], ["k1", "1"]);
});

test("wbxml : élément avec bit de contenu mais sans contenu", () => {
  const d = decode(doc(0x45, 0x4b, 0x01, 0x01));
  eq([d.children[0].value, d.children[0].children, text(d, "SyncKey")], [null, [], ""]);
});

// ── Limits ────────────────────────────────────────────────────────────────

test("wbxml : limite maxBytes", () => {
  const d = encode(el("AirSync:Sync", [el("SyncKey", "abcdef")]));
  eq(decode(d, { maxBytes: d.length }).tag, "Sync", "taille exacte acceptée");
  refuse(d, "un octet de trop", { maxBytes: d.length - 1 });
});

test("wbxml : limite maxNodes (éléments vides compris)", () => {
  const d = doc(0x45, Array(9).fill(0x0e), 0x01); // Sync + 9 empty Status = 10 elements
  eq(decode(d, { maxNodes: 10 }).children.length, 9);
  refuse(d, "11e élément", { maxNodes: 9 });
  refuse(doc(0x05), "même un seul élément", { maxNodes: 0 });
});

test("wbxml : limite maxDepth", () => {
  eq(decode(nestBytes(8), { maxDepth: 8 }).tag, "Sync", "8 niveaux");
  refuse(nestBytes(9), "9 niveaux", { maxDepth: 8 });
  const max = DEFAULT_LIMITS.maxDepth;
  eq(decode(nestBytes(max)).tag, "Sync", `${max} niveaux par défaut`);
  refuse(nestBytes(max + 1), `${max + 1} niveaux par défaut`);
  refuse(nestBytes(100_000), "100 000 niveaux, sans débordement de pile");
});

test("wbxml : une limite absente ou undefined garde la valeur par défaut", () => {
  const deep = nestBytes(DEFAULT_LIMITS.maxDepth + 1);
  refuse(deep, "limites partielles", { maxNodes: 1000 });
  refuse(deep, "maxDepth: undefined", { maxDepth: undefined });
  refuse(deep, "maxDepth: null", { maxDepth: null });
  refuse(deep, "toutes undefined", { maxBytes: undefined, maxNodes: undefined, maxDepth: undefined });
  eq(decode(nestBytes(3), { maxBytes: undefined, maxNodes: undefined }).tag, "Sync");
  assert(Object.isFrozen(DEFAULT_LIMITS), "DEFAULT_LIMITS doit être figé");
});

// ── Reading ───────────────────────────────────────────────────────────────

test("wbxml : child, childrenNamed, at, text, bytes", () => {
  const d = decode(encode(el("AirSync:Sync", [
    el("Status", "1"),
    el("Collections", [
      el("Collection", [el("CollectionId", "a"), el("Email:Status", "e1")]),
      el("Collection", [el("CollectionId", "b")]),
    ]),
    el("ComposeMail:Mime", new Uint8Array([9, 8])),
    el("SyncKey"),
  ])));
  eq(text(d, "Status"), "1");
  eq(text(d, "AirSync:Status"), "1", "nom qualifié");
  eq(text(d, "Email:Status"), null, "mauvais espace de noms");
  eq(childrenNamed(child(d, "Collections"), "Collection").length, 2);
  eq(childrenNamed(child(d, "Collections"), "AirSync:Collection").map((c) => text(c, "CollectionId")), ["a", "b"]);
  eq(text(d, "Collections", "Collection", "Email:Status"), "e1", "chemin");
  eq(at(d, "Collections", "Inconnu", "CollectionId"), null);
  eq(text(d, "Absent"), null, "absent → null");
  eq(text(d, "SyncKey"), "", "vide → chaîne vide");
  eq(bytes(d, "Mime"), new Uint8Array([9, 8]));
  eq(bytes(d, "SyncKey"), new Uint8Array(0));
  eq(bytes(d, "Absent"), null);
  eq(text(d), "", "élément à enfants, sans texte");
  eq(child(null, "X"), null);
  eq(childrenNamed(null, "X"), []);
  eq(at(null, "X"), null);
  eq(text(null, "X"), null);
  eq(bytes(undefined, "X"), null);
  eq(at(d), d, "chemin vide");
});

// ── Debug log ─────────────────────────────────────────────────────────────

test("toDebugString : valeurs montrées seulement pour les balises autorisées (arbre construit, espaces hérités)", () => {
  const tree = el("AirSync:Sync", [
    el("Status", "1"),
    el("SyncKey", "k\u0007y\nz"),
    el("Email:Subject", "Projet confidentiel"),
    el("Calendar:Subject", "Rendez-vous médecin"),
    el("ComposeMail:Mime", encodeUtf8("From: a@b.c")),
    el("AirSyncBase:Body", [el("Data", "Corps du message")]),
    el("Collections"),
  ]);
  const out = toDebugString(tree, { shown: new Set(["Status", "SyncKey", "Email:Subject"]) });
  eq(out.split("\n"), [
    "<AirSync:Sync>",
    "  <AirSync:Status> 1",
    "  <AirSync:SyncKey> k·y·z",
    "  <Email:Subject> Projet confidentiel",
    "  <Calendar:Subject> [20 octets]",
    "  <ComposeMail:Mime> [11 octets]",
    "  <AirSyncBase:Body>",
    "    <AirSyncBase:Data> [16 octets]",
    "  <AirSync:Collections>",
  ]);
  for (const secret of ["Rendez-vous", "From:", "Corps"]) assert(!out.includes(secret), `valeur cachée visible : ${secret}`);
  // "Namespace:Tag" entries also apply to children that inherit the namespace.
  const built = el("FolderHierarchy:FolderSync", [el("SyncKey", "7"), el("DisplayName", "Privé")]);
  eq(toDebugString(built, { shown: new Set(["FolderHierarchy:SyncKey"]) }), "<FolderHierarchy:FolderSync>\n  <FolderHierarchy:SyncKey> 7\n  <FolderHierarchy:DisplayName> [6 octets]");
  eq(toDebugString(decode(encode(built)), { shown: new Set(["FolderHierarchy:SyncKey"]) }), toDebugString(built, { shown: new Set(["FolderHierarchy:SyncKey"]) }), "même rendu après décodage");
});

test("toDebugString : sans liste, aucune valeur ; données opaques jamais montrées", () => {
  const tree = el("AirSync:Sync", [el("Status", "1"), el("Email:Subject", "secret"), el("ComposeMail:Mime", encodeUtf8("secret2"))]);
  const none = toDebugString(tree);
  assert(!none.includes("secret") && !none.includes(" 1"), none);
  const opaque = toDebugString(tree, { shown: new Set(["Mime", "ComposeMail:Mime"]) });
  assert(!opaque.includes("secret2") && opaque.includes("[7 octets]"), opaque);
});

test("toDebugString : valeur coupée à maxValue, sortie plafonnée à maxLength", () => {
  const long = el("AirSync:SyncKey", "x".repeat(100));
  eq(toDebugString(long, { shown: new Set(["SyncKey"]), maxValue: 10 }), "<AirSync:SyncKey> xxxxxxxxxx…");
  eq(toDebugString(long, { shown: new Set(["SyncKey"]) }), `<AirSync:SyncKey> ${"x".repeat(64)}…`, "64 par défaut");
  const wide = el("AirSync:Sync", Array.from({ length: 50_000 }, (_, i) => el("Status", String(i))));
  const out = toDebugString(wide, { shown: new Set(["Status"]), maxLength: 4096 });
  assert(out.length <= 4096 + 2, `longueur ${out.length}`);
  assert(out.endsWith("\n…"), "marque de troncature");
  const def = toDebugString(wide, { shown: new Set(["Status"]) });
  assert(def.length <= 32 * 1024 + 2, `plafond par défaut dépassé : ${def.length}`);
});

test("toDebugString : indentation plafonnée, nœuds inconnus, arbre très profond", () => {
  let node = { ns: "#page30", tag: "#0x3f", children: [], value: null, opaque: false };
  for (let i = 0; i < 5000; i++) node = { ns: "AirSync", tag: "Sync", children: [node], value: null, opaque: false };
  const out = toDebugString(node, { maxLength: 1e9 });
  const lines = out.split("\n");
  eq(lines.length, 5001);
  eq(lines[5000], `${" ".repeat(64)}<#page30:#0x3f>`);
});
