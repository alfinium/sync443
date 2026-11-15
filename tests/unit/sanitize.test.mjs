// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the gate for untrusted values. Limits come from [MS-ASCMD]
 * (ids up to 64 characters), [MS-ASDTYPE] 2.3 (dateTime), [MS-ASPROV]
 * (policy key: unsigned 32-bit) and RFC 5321/5322 (addresses).
 */

import { test, assert, eq } from "./harness.mjs";
import { cleanText, itemId, syncKey, status, integer, flag, dateTime, emailAddress, folderName, policyKey } from "../../src/core/sanitize.mjs";

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

// ── Dates ─────────────────────────────────────────────────────────────────

test("dateTime : formes compacte et étendue, en UTC", () => {
  const t = Date.UTC(2026, 10, 15, 14, 30, 0);
  eq(dateTime("20261115T143000Z"), new Date(t), "compacte");
  eq(dateTime("2026-11-15T14:30:00Z"), new Date(t), "étendue");
  eq(dateTime("2026-11-15T14:30:00.000Z"), new Date(t), "étendue avec millisecondes nulles");
  eq(dateTime("1601-01-01T00:00:00.000Z"), new Date(Date.UTC(1601, 0, 1)), "première date admise");
  eq(dateTime("99991231T235959Z"), new Date(Date.UTC(9999, 11, 31, 23, 59, 59)), "dernière date admise");
});

test("dateTime : millisecondes de la forme étendue conservées", () => {
  eq(dateTime("2026-11-15T14:30:00.123Z")?.getTime(), Date.UTC(2026, 10, 15, 14, 30, 0, 123));
  eq(dateTime("2026-11-15T14:30:00.5Z")?.getTime(), Date.UTC(2026, 10, 15, 14, 30, 0, 500), "un chiffre = dixièmes");
  eq(dateTime("2026-11-15T14:30:00.05Z")?.getTime(), Date.UTC(2026, 10, 15, 14, 30, 0, 50), "deux chiffres = centièmes");
  eq(dateTime("2026-11-15T14:30:00.1234Z"), null, "quatre chiffres");
  eq(dateTime("2026-11-15T14:30:00.Z"), null, "point sans chiffre");
});

test("dateTime : dates impossibles refusées (31 février, 29 février hors bissextile…)", () => {
  eq(dateTime("20260231T000000Z"), null, "31 février");
  eq(dateTime("20260230T000000Z"), null, "30 février");
  eq(dateTime("20260229T000000Z"), null, "29 février 2026");
  eq(dateTime("19000229T000000Z"), null, "29 février 1900");
  eq(dateTime("20000229T000000Z")?.getTime(), Date.UTC(2000, 1, 29), "29 février 2000");
  eq(dateTime("20240229T120000Z")?.getTime(), Date.UTC(2024, 1, 29, 12), "29 février 2024");
  eq(dateTime("20260431T000000Z"), null, "31 avril");
  for (const bad of ["20261315T000000Z", "20260015T000000Z", "20261100T000000Z", "20261132T000000Z", "20261115T240000Z", "20261115T236000Z", "20261115T235960Z"]) {
    eq(dateTime(bad), null, bad);
  }
});

test("dateTime : année hors 1601–9999 refusée", () => {
  eq(dateTime("16001231T235959Z"), null, "1600");
  eq(dateTime("0000-01-01T00:00:00Z"), null, "an 0");
  eq(dateTime("0099-01-01T00:00:00Z"), null, "an 99 (Date.UTC le lirait 1999)");
  eq(dateTime("10000-01-01T00:00:00Z"), null, "année sur 5 chiffres");
  eq(dateTime("100000101T000000Z"), null, "forme compacte trop longue");
});

test("dateTime : formats inexacts refusés", () => {
  for (const bad of [
    "20261115T143000z", "20261115T143000", "20261115 143000Z", "2026-11-15T14:30:00+01:00", "2026-11-15 14:30:00Z",
    "2026-11-15T14:30Z", "20261115T143000.000Z", "2026-1115T14:30:00Z", "2026-11-15T14:30:00Z\n", " 20261115T143000Z",
    "2026-11-15", "١٢٣٤-11-15T14:30:00Z", "",
  ]) {
    eq(dateTime(bad), null, JSON.stringify(bad));
  }
  for (const v of NOT_STRINGS) eq(dateTime(v), null);
  eq(dateTime(new Date()), null, "un objet Date n'est pas une chaîne");
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
