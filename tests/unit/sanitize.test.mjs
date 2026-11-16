// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the gate for untrusted values. Limits come from [MS-ASCMD]
 * (ids up to 64 characters), [MS-ASPROV] (policy key: unsigned 32-bit)
 * and RFC 5321/5322 (addresses).
 */

import { test, assert, eq } from "./harness.mjs";
import { cleanText, contentText, hasHidden, itemId, syncKey, status, integer, flag, emailAddress, folderName, policyKey } from "../../src/core/sanitize.mjs";

const NOT_STRINGS = [null, undefined, 42, true, {}, [], ["a"], new String("a")];
const BIDI = ["\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"];
const hasLoneSurrogate = (s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(s);

// ── cleanText ─────────────────────────────────────────────────────────────

test("cleanText : valeur non textuelle → chaîne vide", () => {
  for (const v of NOT_STRINGS) eq(cleanText(v), "", `entrée ${String(v)}`);
});

test("cleanText : fins de ligne normalisées, caractères de contrôle retirés", () => {
  eq(cleanText("a\r\nb\rc\nd"), "a\nb\nc\nd");
  eq(cleanText("a\r\r\nb"), "a\n\nb");
  eq(cleanText("\u0000a\u0001b\u0008c\u000bd\u000ce\u000ef\u001fg\u007fh"), "abcdefgh");
  eq(cleanText("a\tb"), "a\tb", "la tabulation reste sans singleLine");
  eq(cleanText("Réunion 📅 « budget »"), "Réunion 📅 « budget »", "texte ordinaire inchangé");
});

test("cleanText : singleLine remplace tabulations et sauts de ligne par une espace", () => {
  eq(cleanText("a\n\nb\tc\r\nd", { singleLine: true }), "a b c d");
  eq(cleanText("a\t\n\t b", { singleLine: true }), "a  b", "une seule espace par suite, les espaces restent");
  eq(cleanText("a\u0000\nb", { singleLine: true }), "a b");
});

test("cleanText : stripBidi retire les contrôles bidirectionnels", () => {
  const evil = `facture${BIDI.join("")}fdp.exe`;
  eq(cleanText(evil, { stripBidi: true }), "facturefdp.exe");
  eq(cleanText(evil), evil, "conservés sans stripBidi");
  eq(cleanText("مرحبا שלום", { stripBidi: true }), "مرحبا שלום", "l'écriture de droite à gauche elle-même est conservée");
});

test("cleanText : coupe à max sans couper une paire de surrogates", () => {
  eq(cleanText("x".repeat(65), { max: 64 }), "x".repeat(64), "65 → 64");
  eq(cleanText("x".repeat(64), { max: 64 }), "x".repeat(64), "64 → 64");
  eq(cleanText("a😀", { max: 2 }), "a", "pas de demi-paire");
  eq(cleanText("😀😀", { max: 3 }), "😀");
  eq(cleanText("😀😀", { max: 4 }), "😀😀");
  eq(cleanText("x".repeat(70_000)).length, 64 * 1024, "64 Kio par défaut");
  for (let max = 1; max < 12; max++) assert(!hasLoneSurrogate(cleanText("a😀b😀😀c", { max })), `max ${max}`);
});

// ── Identifiers and keys ──────────────────────────────────────────────────

test("itemId : 1 à 64 caractères, sans contrôle", () => {
  eq(itemId("1"), "1");
  eq(itemId("5:12"), "5:12");
  eq(itemId("x".repeat(64)), "x".repeat(64), "64 caractères");
  eq(itemId("x".repeat(65)), null, "65 caractères");
  eq(itemId("😀".repeat(32)), "😀".repeat(32), "64 unités UTF-16");
  eq(itemId("😀".repeat(32) + "a"), null, "65 unités UTF-16");
  eq(itemId(""), null);
  eq(itemId("Boîte/été"), "Boîte/été");
  for (const c of ["\u0000", "\t", "\n", "\r", "\u001f", "\u007f"]) eq(itemId(`a${c}b`), null, `contrôle U+${c.charCodeAt(0).toString(16)}`);
  for (const v of NOT_STRINGS) eq(itemId(v), null);
});

test("syncKey : 1 à 64 caractères ASCII visibles", () => {
  eq(syncKey("0"), "0");
  eq(syncKey("{1b3e-4F}"), "{1b3e-4F}");
  eq(syncKey("!".repeat(64)), "!".repeat(64), "64");
  eq(syncKey("~".repeat(65)), null, "65");
  eq(syncKey(""), null);
  for (const bad of ["a b", "a\tb", "é", "a\u0000", "\u007f", "abc\n", "😀"]) eq(syncKey(bad), null, JSON.stringify(bad));
  for (const v of NOT_STRINGS) eq(syncKey(v), null);
});

test("status : 1 à 4 chiffres", () => {
  eq(status("1"), "1");
  eq(status("0177"), "177", "zéros de tête retirés : un statut ne peut pas échapper à son traitement");
  eq(status("1234"), "1234");
  for (const bad of ["12345", "", "-1", "1a", " 1", "1 ", "+1", "١", "1.0"]) eq(status(bad), null, JSON.stringify(bad));
  eq(status(1), null, "nombre");
  eq(status(null), null);
});

test("integer : décimal dans [min, max]", () => {
  eq(integer("0"), 0);
  eq(integer("42"), 42);
  eq(integer("007"), 7, "zéros de tête");
  eq(integer("2147483647"), 2 ** 31 - 1, "max par défaut");
  eq(integer("2147483648"), null, "au-delà du max par défaut");
  eq(integer("-1"), null, "min 0 par défaut");
  eq(integer("-1", { min: -5 }), -1);
  eq(integer("12345678901", { max: 2 ** 53 }), null, "plus de 10 chiffres");
  eq(integer("19", { min: 1, max: 19 }), 19);
  eq(integer("20", { min: 1, max: 19 }), null);
  eq(integer("0", { min: 1, max: 19 }), null);
  for (const bad of ["", "1.5", "1e3", " 1", "1 ", "+1", "0x10", "Infinity", "NaN", "--1", "1-"]) eq(integer(bad), null, JSON.stringify(bad));
  for (const v of NOT_STRINGS) eq(integer(v), null);
});

test("flag : « 0 » et « 1 » seulement", () => {
  eq(flag("1"), true);
  eq(flag("0"), false);
  for (const bad of ["true", "false", "", " 1", "01", "2", 1, 0, true, null]) eq(flag(bad), null, JSON.stringify(bad));
});

test("policyKey : entier non signé de 32 bits écrit en décimal", () => {
  eq(policyKey("0"), "0");
  eq(policyKey("1307199584"), "1307199584");
  eq(policyKey("4294967295"), "4294967295", "2^32−1");
  eq(policyKey("0000000001"), "0000000001", "10 chiffres");
  eq(policyKey("4294967296"), null, "2^32");
  eq(policyKey("9999999999"), null);
  eq(policyKey("00000000001"), null, "11 chiffres");
  for (const bad of ["", "-1", "1.0", " 1", "1 ", "0x1", "abc", "１"]) eq(policyKey(bad), null, JSON.stringify(bad));
  for (const v of NOT_STRINGS) eq(policyKey(v), null);
});

// ── Addresses ─────────────────────────────────────────────────────────────

test("emailAddress : adresses ordinaires", () => {
  eq(emailAddress("jean.dupont@example.com"), "jean.dupont@example.com");
  eq(emailAddress("  Jean+Tag@Sub.Example.co.uk \n"), "Jean+Tag@Sub.Example.co.uk", "espaces autour retirés, casse conservée");
  eq(emailAddress("!#$%&'*+/=?^_`{|}~-@example.com"), "!#$%&'*+/=?^_`{|}~-@example.com", "caractères spéciaux du dot-atom");
  eq(emailAddress("a@ex--ample.com"), "a@ex--ample.com", "tirets internes");
});

test("emailAddress : partie locale ≤ 64, total ≤ 254, étiquettes ≤ 63", () => {
  const domain189 = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(61)}`;
  eq(emailAddress(`${"l".repeat(64)}@example.com`), `${"l".repeat(64)}@example.com`, "partie locale de 64");
  eq(emailAddress(`${"l".repeat(65)}@example.com`), null, "partie locale de 65");
  eq(emailAddress(`${"l".repeat(64)}@${domain189}`)?.length, 254, "254 caractères");
  eq(emailAddress(`${"l".repeat(64)}@${domain189}c`), null, "255 caractères");
  eq(emailAddress(`a@${"d".repeat(63)}.com`)?.length, 2 + 63 + 4, "étiquette de 63");
  eq(emailAddress(`a@${"d".repeat(64)}.com`), null, "étiquette de 64");
});

test("emailAddress : formes refusées", () => {
  for (const bad of [
    "", "a", "a@", "@example.com", "a@@example.com", "a@b@example.com", "a@localhost", "a@example", "a@example.com.",
    "a@.example.com", "a@example..com", "a@-example.com", "a@example-.com", "a@ex_ample.com", ".a@example.com",
    "a.@example.com", "a..b@example.com", '"a b"@example.com', "a@[127.0.0.1]", "a b@example.com", "Jean <jean@example.com>",
    "jérôme@example.com", "a@exämple.com", "a@example.com\u0000", "a\u202e@example.com", "a@example.com,b@example.com",
  ]) {
    eq(emailAddress(bad), null, JSON.stringify(bad));
  }
  for (const v of NOT_STRINGS) eq(emailAddress(v), null);
});

test("emailAddress : temps borné sur une entrée hostile", () => {
  const started = Date.now();
  for (let i = 0; i < 200; i++) {
    emailAddress(`a@${"a-".repeat(120)}!`);
    emailAddress(`${"a.".repeat(120)}@`);
    emailAddress(`a@${"a".repeat(250)}`);
  }
  assert(Date.now() - started < 1000, "expression rationnelle trop lente");
});

// ── Folder names ──────────────────────────────────────────────────────────

test("folderName : une ligne, sans astuce bidi, ni « . » ni « .. »", () => {
  eq(folderName("Boîte de réception"), "Boîte de réception");
  eq(folderName("  Archives 2026  "), "Archives 2026");
  eq(folderName("a\nb\tc\r\nd"), "a b c d");
  eq(folderName("Factures\u202efdp.exe"), "Facturesfdp.exe");
  for (const bad of [".", "..", " . ", " .. ", ".\u202e.", "\u200f.\u200e", "", "   ", "\u0000", "\u202e", "\n\t"]) {
    eq(folderName(bad), null, JSON.stringify(bad));
  }
  eq(folderName("..."), "...", "trois points : un nom ordinaire");
  eq(folderName(".a"), ".a");
  for (const v of NOT_STRINGS) eq(folderName(v), null);
});

test("folderName : 255 caractères au plus, paire de surrogates jamais coupée", () => {
  eq(folderName("x".repeat(255)), "x".repeat(255));
  eq(folderName("x".repeat(300)), "x".repeat(255), "coupé à 255");
  const cut = folderName("😀".repeat(200));
  eq(cut.length, 254, "la demi-paire finale est retirée");
  assert(!hasLoneSurrogate(cut), "surrogate isolé");
});

// ── Content of calendar items and tasks ───────────────────────────────────

// Characters are built here, never typed: no source file holds an invisible one.
const at = (...codes) => String.fromCodePoint(...codes);
const JOINERS = [0x200c, 0x200d];
/** Every code point contentText removes besides controls, as [first, last] ranges. */
const HIDDEN_RANGES = [
  [0x00ad, 0x00ad], [0x061c, 0x061c], [0x180e, 0x180e], [0x200b, 0x200b], [0x200e, 0x200f], [0x202a, 0x202e], [0x2060, 0x2060], [0x2066, 0x2069],
  [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xfffe, 0xffff], [0xe0000, 0xe007f],
];
const isHidden = (code) => HIDDEN_RANGES.some(([first, last]) => code >= first && code <= last);
const isControl = (code) => (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f);

test("contentText: not a string is an empty text, and holds nothing hidden", () => {
  for (const v of NOT_STRINGS) {
    eq(contentText(v), "", String(v));
    eq(hasHidden(v), false, String(v));
  }
});

test("contentText: the zero-width joiner and non-joiner stay", () => {
  const family = at(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const persian = at(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645);
  for (const text of [family, persian, `${family} ${persian}`, at(0x200c), at(0x200d)]) {
    eq(contentText(text), text);
    eq(contentText(text, { singleLine: true }), text);
    eq(hasHidden(text), false);
  }
  // cleanText is what it was for its callers: with stripBidi the two joiners go, as every invisible character.
  eq(cleanText(`a${at(0x200c)}b${at(0x200d)}c`, { stripBidi: true }), "abc");
  eq(cleanText(`a${at(0x200c)}b${at(0x200d)}c`), `a${at(0x200c)}b${at(0x200d)}c`);
});

test("contentText: every code point is kept, or removed for one of two reasons", () => {
  // The whole basic plane (but the surrogates), the tag block and its neighbours, and a few others.
  const codes = [];
  for (let code = 0; code <= 0xffff; code++) if (code < 0xd800 || code > 0xdfff) codes.push(code);
  for (let code = 0xdfff0; code <= 0xe0100; code++) codes.push(code);
  codes.push(0x10000, 0x1f600, 0x1f3f4, 0xe01ef, 0xf0000, 0x10ffff);
  let hidden = 0;
  for (const code of codes) {
    const text = `a${at(code)}b`;
    const label = `U+${code.toString(16)}`;
    if (isHidden(code)) {
      hidden++;
      eq(contentText(text), "ab", `${label} is removed`);
      eq(hasHidden(text), true, `${label} is said`);
    } else if (isControl(code)) {
      eq(contentText(text), "ab", `${label}, a control, is removed`);
      eq(hasHidden(text), false, `${label}: no loss`);
    } else if (code === 0x0d || code === 0x2028 || code === 0x2029) {
      eq(contentText(text), "a\nb", `${label} is a line break`);
      eq(hasHidden(text), false, label);
    } else {
      eq(contentText(text), text, `${label} is kept`);
      eq(hasHidden(text), false, label);
    }
  }
  eq(hidden, 1 + 1 + 1 + 1 + 2 + 5 + 1 + 4 + 1 + 3 + 2 + 128, "the documented set, and nothing else");
  for (const code of JOINERS) assert(!isHidden(code));
});

test("contentText: lines, controls and bounds are those of cleanText", () => {
  eq(contentText("a\r\nb\rc\nd"), "a\nb\nc\nd");
  eq(contentText("a\tb"), "a\tb", "a tab stays in a text of several lines");
  eq(contentText("a\n\nb\tc\r\nd", { singleLine: true }), "a b c d");
  eq(contentText(`a${at(0x2028)}b${at(0x2029)}c`, { singleLine: true }), "a b c");
  eq(contentText(`a${at(0)}${at(0x1b)}${at(0x7f)}${at(0x85)}b`), "ab");
  eq(contentText("x".repeat(70_000)).length, 64 * 1024, "64 KiB by default");
  eq(contentText("x".repeat(65), { max: 64 }), "x".repeat(64));
  eq(contentText(`a${at(0x1f600)}`, { max: 2 }), "a", "never half a pair");
  eq(contentText(`${at(0x202e).repeat(10)}abc`, { max: 3 }), "abc", "cut after cleaning");
  eq(contentText("x", { max: Infinity }), "x");
  // The same texts through both functions, where nothing hidden is involved.
  for (const text of ["", "Budget 2026", "a\tb\r\nc", `a${at(0x07)}b`, `${at(0x0645)}${at(0x05d0)} mixed`, at(0x1f600).repeat(3)]) {
    eq(contentText(text), cleanText(text), JSON.stringify(text));
    eq(contentText(text, { singleLine: true }), cleanText(text, { singleLine: true, stripBidi: true }), JSON.stringify(text));
  }
});

test("hasHidden: one character anywhere is enough, and every call answers the same", () => {
  const hiddenOnes = [0x00ad, 0x200b, 0x200e, 0x202e, 0x2066, 0xfeff, 0xfffa, 0xffff, 0xe0001, 0xe007f];
  for (const code of hiddenOnes) {
    for (const text of [at(code), `${at(code)}abc`, `abc${at(code)}`, `${"x".repeat(5000)}${at(code)}${"y".repeat(5000)}`]) {
      // Called several times in a row: no state is kept from one call to the next.
      eq([hasHidden(text), hasHidden(text), hasHidden(text)], [true, true, true], `U+${code.toString(16)}`);
      eq(contentText(text), text.split(at(code)).join(""));
    }
  }
  eq(hasHidden(""), false);
  eq(hasHidden("x".repeat(100_000)), false);
});

test("contentText, hasHidden: a lone surrogate is a loss, and hides nothing that follows it", () => {
  // In JavaScriptCore a character class with the u flag misses some characters right after a lone surrogate.
  const unit = (...codes) => String.fromCharCode(...codes);
  const hiddenOnes = HIDDEN_RANGES.flatMap(([first, last]) => [first, last]);
  for (const lone of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
    eq(hasHidden(`a${unit(lone)}b`), true, "a lone surrogate is no text");
    eq(contentText(`a${unit(lone)}b`), `a${unit(0xfffd)}b`);
    for (const code of hiddenOnes) {
      for (const text of [`${unit(lone)}${at(code)}`, `a${unit(lone)}${at(code)}b`, `${at(code)}${unit(lone)}`, `${unit(lone)}${at(code)}${unit(lone)}${at(code)}`]) {
        const label = `U+${code.toString(16)} beside U+${lone.toString(16)}`;
        eq(hasHidden(text), true, label);
        eq(contentText(text), text.split(at(code)).join("").split(unit(lone)).join(unit(0xfffd)), label);
        eq(contentText(text, { singleLine: true }).includes(at(code)), false, label);
      }
    }
    eq(contentText(`${unit(lone)}${at(0x200d)}`), `${unit(0xfffd)}${at(0x200d)}`, "the joiner stays");
  }
  eq(hasHidden(at(0x1f600)), false, "a pair is a character");
});
