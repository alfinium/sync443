// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * UTF-8 tests. Expected values come from the Unicode Standard (chapter 3,
 * "U+FFFD substitution of maximal subparts") and from the WHATWG Encoding
 * Standard: the UTF-8 decoder algorithm of section 9.1.1 is transcribed
 * below as an independent oracle for random inputs. encodeURIComponent
 * (ECMA-262, which writes UTF-8 octets as %XX) is the oracle for encoding.
 */

import { test, assert, eq, prng } from "./harness.mjs";
import { encodeUtf8, decodeUtf8 } from "../../src/core/utf8.mjs";

const B = (...xs) => new Uint8Array(xs);
const R = "�";

/** Reference encoder through encodeURIComponent (throws on a lone surrogate). */
function refEncode(str) {
  const e = encodeURIComponent(str);
  const out = [];
  for (let i = 0; i < e.length; i++) {
    if (e[i] === "%") {
      out.push(parseInt(e.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(e.charCodeAt(i));
    }
  }
  return new Uint8Array(out);
}

/** WHATWG Encoding, 9.1.1 "UTF-8 decoder", with replacement error mode. */
function refDecode(bytes) {
  let cp = 0;
  let seen = 0;
  let needed = 0;
  let lower = 0x80;
  let upper = 0xbf;
  const out = [];
  let i = 0;
  for (;;) {
    if (i >= bytes.length) {
      if (needed !== 0) out.push(0xfffd);
      break;
    }
    const byte = bytes[i++];
    if (needed === 0) {
      if (byte <= 0x7f) out.push(byte);
      else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1;
        cp = byte & 0x1f;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0;
        if (byte === 0xed) upper = 0x9f;
        needed = 2;
        cp = byte & 0xf;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90;
        if (byte === 0xf4) upper = 0x8f;
        needed = 3;
        cp = byte & 0x7;
      } else out.push(0xfffd);
      continue;
    }
    if (byte < lower || byte > upper) {
      cp = needed = seen = 0;
      lower = 0x80;
      upper = 0xbf;
      i--; // "restore byte to ioQueue"
      out.push(0xfffd);
      continue;
    }
    lower = 0x80;
    upper = 0xbf;
    cp = (cp << 6) | (byte & 0x3f);
    seen++;
    if (seen !== needed) continue;
    out.push(cp);
    cp = needed = seen = 0;
  }
  let s = "";
  for (let k = 0; k < out.length; k += 4096) s += String.fromCodePoint(...out.slice(k, k + 4096));
  return s;
}

const hasLoneSurrogate = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
};

// ── Writing ──────────────────────────────────────────────────────────────

test("utf8 : encodage sur 1, 2, 3 et 4 octets, bornes comprises", () => {
  eq(encodeUtf8(""), B(), "chaîne vide");
  eq(encodeUtf8("A"), B(0x41));
  eq(encodeUtf8("\u0000"), B(0x00), "U+0000");
  eq(encodeUtf8("\u007f"), B(0x7f), "U+007F");
  eq(encodeUtf8("\u0080"), B(0xc2, 0x80), "U+0080");
  eq(encodeUtf8("é"), B(0xc3, 0xa9), "é");
  eq(encodeUtf8("߿"), B(0xdf, 0xbf), "U+07FF");
  eq(encodeUtf8("ࠀ"), B(0xe0, 0xa0, 0x80), "U+0800");
  eq(encodeUtf8("€"), B(0xe2, 0x82, 0xac), "€");
  eq(encodeUtf8("퟿"), B(0xed, 0x9f, 0xbf), "U+D7FF");
  eq(encodeUtf8(""), B(0xee, 0x80, 0x80), "U+E000");
  eq(encodeUtf8("￿"), B(0xef, 0xbf, 0xbf), "U+FFFF");
  eq(encodeUtf8("\u{10000}"), B(0xf0, 0x90, 0x80, 0x80), "U+10000");
  eq(encodeUtf8("😀"), B(0xf0, 0x9f, 0x98, 0x80), "U+1F600");
  eq(encodeUtf8("\u{10ffff}"), B(0xf4, 0x8f, 0xbf, 0xbf), "U+10FFFF");
});

test("utf8 : un surrogate isolé est encodé en U+FFFD", () => {
  const FFFD = [0xef, 0xbf, 0xbd];
  eq(encodeUtf8("\ud800"), B(...FFFD), "haut seul");
  eq(encodeUtf8("\udc00"), B(...FFFD), "bas seul");
  eq(encodeUtf8("\udbff"), B(...FFFD), "haut seul (fin de plage)");
  eq(encodeUtf8("\udfff"), B(...FFFD), "bas seul (fin de plage)");
  eq(encodeUtf8("a\ud800b"), B(0x61, ...FFFD, 0x62), "haut suivi d'une lettre");
  eq(encodeUtf8("\udc00\ud800"), B(...FFFD, ...FFFD), "paire inversée");
  eq(encodeUtf8("\ud800𐀀"), B(...FFFD, 0xf0, 0x90, 0x80, 0x80), "haut seul puis paire valide");
  eq(encodeUtf8("x\ud83d"), B(0x78, ...FFFD), "haut seul en fin de chaîne");
});

test("utf8 : encodage identique à encodeURIComponent (tout le BMP, échantillon astral)", () => {
  const cps = [];
  for (let cp = 0; cp <= 0xffff; cp++) if (cp < 0xd800 || cp > 0xdfff) cps.push(cp);
  for (let cp = 0x10000; cp <= 0x10ffff; cp += 97) cps.push(cp);
  cps.push(0x10ffff, 0x1f600, 0xe0001);
  for (let k = 0; k < cps.length; k += 2048) {
    const s = String.fromCodePoint(...cps.slice(k, k + 2048));
    eq(encodeUtf8(s), refEncode(s), `bloc ${k}`);
  }
});

test("utf8 : encodeUtf8 convertit une valeur non textuelle avec String()", () => {
  eq(encodeUtf8(123), B(0x31, 0x32, 0x33));
  eq(encodeUtf8(null), B(0x6e, 0x75, 0x6c, 0x6c));
});

// ── Reading ──────────────────────────────────────────────────────────────

test("utf8 : aller-retour exact sur tous les points de code hors surrogates", () => {
  const cps = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp === 0xd800) cp = 0xe000;
    cps.push(cp);
    if (cps.length === 8000 || cp === 0x10ffff) {
      const s = String.fromCodePoint(...cps);
      const back = decodeUtf8(encodeUtf8(s));
      assert(back === s, `aller-retour faux autour de U+${cp.toString(16)}`);
      cps.length = 0;
    }
  }
});

test("utf8 : décodage de séquences valides", () => {
  eq(decodeUtf8(B()), "");
  eq(decodeUtf8(B(0x00)), "\u0000", "NUL décodé tel quel");
  eq(decodeUtf8(B(0x41, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80)), "Aé€😀");
  eq(decodeUtf8(B(0xed, 0x9f, 0xbf)), "퟿", "U+D7FF");
  eq(decodeUtf8(B(0xee, 0x80, 0x80)), "", "U+E000");
  eq(decodeUtf8(B(0xf4, 0x8f, 0xbf, 0xbf)), "\u{10ffff}", "U+10FFFF");
  eq(decodeUtf8(B(0xef, 0xbb, 0xbf, 0x41)), "\ufeffA", "le BOM n'est pas retiré");
});

test("utf8 : octets invalides → U+FFFD par sous-partie maximale", () => {
  const cases = [
    [[0x80], R, "continuation isolée"],
    [[0xbf], R, "continuation isolée (fin)"],
    [[0x80, 0x80], R + R, "deux continuations"],
    [[0xc0, 0x80], R + R, "NUL non minimal (C0 80)"],
    [[0xc1, 0xbf], R + R, "forme non minimale C1"],
    [[0xe0, 0x80, 0x80], R + R + R, "E0 80 80 non minimal"],
    [[0xe0, 0x9f, 0xbf], R + R + R, "E0 9F BF non minimal"],
    [[0xed, 0xa0, 0x80], R + R + R, "surrogate D800 encodé"],
    [[0xed, 0xbf, 0xbf], R + R + R, "surrogate DFFF encodé"],
    [[0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80], R.repeat(6), "paire de surrogates encodée (CESU-8)"],
    [[0xf0, 0x80, 0x80, 0x80], R.repeat(4), "F0 non minimal"],
    [[0xf0, 0x8f, 0xbf, 0xbf], R.repeat(4), "F0 8F non minimal"],
    [[0xf4, 0x90, 0x80, 0x80], R.repeat(4), "au-delà de U+10FFFF"],
    [[0xf5, 0x80, 0x80, 0x80], R.repeat(4), "F5 interdit"],
    [[0xf8, 0x88, 0x80, 0x80, 0x80], R.repeat(5), "ancienne forme sur 5 octets"],
    [[0xfc, 0x84, 0x80, 0x80, 0x80, 0x80], R.repeat(6), "ancienne forme sur 6 octets"],
    [[0xfe], R, "FE"],
    [[0xff], R, "FF"],
    [[0xc3], R, "tronqué après le premier octet"],
    [[0xe2, 0x82], R, "tronqué : un seul U+FFFD pour E2 82"],
    [[0xf0, 0x9f, 0x98], R, "tronqué : un seul U+FFFD pour F0 9F 98"],
    [[0xf1, 0x80, 0x80], R, "tronqué : F1 80 80"],
    [[0xe2, 0x82, 0x41], R + "A", "interrompu par ASCII"],
    [[0xf0, 0x9f, 0x41], R + "A", "interrompu après 2 octets"],
    [[0xf0, 0x9f, 0x98, 0x41], R + "A", "interrompu après 3 octets"],
    [[0xe2, 0x41, 0x82], R + "A" + R, "continuation après ASCII"],
    [[0xc3, 0xc3, 0xa9], R + "é", "début répété"],
    [[0xe0, 0xa0, 0xc3, 0xa9], R + "é", "E0 A0 puis é"],
    // Unicode Standard, chapter 3, U+FFFD substitution example.
    [[0x61, 0xf1, 0x80, 0x80, 0xe1, 0x80, 0xc2, 0x62, 0x80, 0x63, 0x80, 0xbf, 0x64], `a${R}${R}${R}b${R}c${R}${R}d`, "exemple du standard Unicode"],
  ];
  for (const [bytes, expected, what] of cases) {
    eq(decodeUtf8(B(...bytes)), expected, what);
    eq(refDecode(B(...bytes)), expected, `oracle : ${what}`);
  }
});

test("utf8 : bornes start/end", () => {
  const bytes = B(0x78, 0xc3, 0xa9, 0x79, 0xe2, 0x82, 0xac);
  eq(decodeUtf8(bytes, 1, 3), "é");
  eq(decodeUtf8(bytes, 3), "y€");
  eq(decodeUtf8(bytes, 0, 2), "x" + R, "fin au milieu d'une séquence");
  eq(decodeUtf8(bytes, 2, 4), R + "y", "début sur une continuation");
  eq(decodeUtf8(bytes, 4, 4), "", "intervalle vide");
  eq(decodeUtf8(bytes, 0, 6), "xéy" + R, "fin avant le dernier octet de €");
});

test("utf8 : texte long (au-delà des blocs internes de 8192)", () => {
  const s = ("é😀a€".repeat(5000) + "\u{10ffff}").repeat(3);
  eq(decodeUtf8(encodeUtf8(s)), s);
  const big = "a".repeat(8191) + "😀" + "b".repeat(8192) + "é";
  eq(decodeUtf8(encodeUtf8(big)), big, "paire de surrogates à la limite d'un bloc");
});

test("utf8 : décodage aléatoire identique à l'algorithme WHATWG, sans surrogate isolé", () => {
  const rnd = prng(0x5eed01);
  // Bytes chosen to hit the interesting boundaries often.
  const pool = [0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xe1, 0xed, 0xee, 0xef, 0xf0, 0xf1, 0xf4, 0xf5, 0xfe, 0xff];
  for (let round = 0; round < 3000; round++) {
    const len = Math.floor(rnd() * 40);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = rnd() < 0.7 ? pool[Math.floor(rnd() * pool.length)] : Math.floor(rnd() * 256);
    const got = decodeUtf8(bytes);
    const want = refDecode(bytes);
    if (got !== want) throw new Error(`divergence pour [${Array.from(bytes).join(",")}] : ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
    assert(!hasLoneSurrogate(got), "surrogate isolé dans le résultat");
    // A decoded string re-encodes to valid UTF-8 that decodes to itself.
    eq(decodeUtf8(encodeUtf8(got)), got, "ré-encodage stable");
    // Wherever the bytes are valid UTF-8, decodeURIComponent must agree.
    let pct = "";
    for (const b of bytes) pct += `%${b.toString(16).padStart(2, "0")}`;
    let strict = null;
    try {
      strict = decodeURIComponent(pct);
    } catch {
      /* invalid UTF-8 */
    }
    if (strict !== null) eq(got, strict, "accord avec decodeURIComponent");
    else assert(got.includes(R), "une séquence invalide doit produire U+FFFD");
  }
});
