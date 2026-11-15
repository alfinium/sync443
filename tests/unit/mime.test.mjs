// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the raw message functions: Message-ID as Thunderbird exposes
 * it (RFC 5322 3.6.4), synthetic ids, and removal of Thunderbird's internal
 * headers at the top level (received messages) and in every MIME part
 * (drafts, RFC 2046 5.1). Bodies must come out byte for byte.
 */

import { test, assert, eq, throws } from "./harness.mjs";
import {
  messageIdOf,
  ensureMessageId,
  stripInternalHeaders,
  cleanDraft,
  MAX_HEADER_BYTES,
  MAX_MIME_DEPTH,
  MAX_MIME_PARTS,
} from "../../src/core/mime.mjs";
import { encodeUtf8, decodeUtf8 } from "../../src/core/utf8.mjs";

const b = (s) => encodeUtf8(s);
const s = (bytes) => decodeUtf8(bytes);
const ch = (code) => String.fromCharCode(code);
const NOT_BYTES = [null, undefined, "Message-ID: <a@b>", [77], 42, {}];

// ── messageIdOf ───────────────────────────────────────────────────────────

test("messageIdOf : message ordinaire, sans chevrons", () => {
  const msg = "From: a@example.com\r\nMessage-ID: <abc.123@example.com>\r\nSubject: x\r\n\r\ncorps\r\n";
  eq(messageIdOf(b(msg)), "abc.123@example.com");
});

test("messageIdOf : nom de champ sans égard à la casse", () => {
  for (const name of ["Message-ID", "Message-Id", "message-id", "MESSAGE-ID", "mEsSaGe-iD"]) {
    eq(messageIdOf(b(`${name}: <x@y>\r\n\r\n`)), "x@y", name);
  }
});

test("messageIdOf : champ replié, commentaires et blancs autour ignorés", () => {
  eq(messageIdOf(b("Message-ID:\r\n <abc@example.com>\r\n\r\n")), "abc@example.com", "replié");
  eq(messageIdOf(b("Message-ID:\r\n\t<abc@example.com>\r\nX: y\r\n\r\n")), "abc@example.com", "tabulation");
  eq(messageIdOf(b("Message-ID: (un commentaire) <abc@example.com> (un autre)\r\n\r\n")), "abc@example.com");
  eq(messageIdOf(b("Message-ID: (imbriqué (deux) \\) niveaux)  <abc@x>\r\n\r\n")), "abc@x", "commentaire imbriqué");
  eq(messageIdOf(b("Message-ID :  <abc@x>\r\n\r\n")), "abc@x", "blanc avant les deux-points (syntaxe obsolète)");
  eq(messageIdOf(b("Message-ID:<abc@x>\r\n\r\n")), "abc@x", "sans espace");
});

test("messageIdOf : sans chevrons, le premier mot", () => {
  eq(messageIdOf(b("Message-ID: abc@example.com\r\n\r\n")), "abc@example.com");
  eq(messageIdOf(b("Message-ID: abc@example.com (commentaire)\r\n\r\n")), "abc@example.com");
  eq(messageIdOf(b("Message-ID: 12345\r\n\r\n")), "12345", "sans @, comme certains logiciels");
});

test("messageIdOf : fins de ligne LF seules, et champ en fin de données", () => {
  eq(messageIdOf(b("Subject: x\nMessage-ID: <a@b>\n\ncorps")), "a@b");
  eq(messageIdOf(b("Subject: x\r\nMessage-ID: <a@b>")), "a@b", "sans fin de ligne");
  eq(messageIdOf(b("Message-ID: a@b")), "a@b", "sans chevrons ni fin de ligne");
});

test("messageIdOf : seul le premier champ Message-ID compte", () => {
  eq(messageIdOf(b("Message-ID: <premier@x>\r\nMessage-ID: <second@x>\r\n\r\n")), "premier@x");
  eq(messageIdOf(b("Message-ID: <>\r\nMessage-ID: <second@x>\r\n\r\n")), null, "premier inutilisable → null");
});

test("messageIdOf : rien hors du bloc d'en-têtes de tête", () => {
  eq(messageIdOf(b("Subject: x\r\n\r\nMessage-ID: <corps@x>\r\n")), null, "dans le corps");
  eq(messageIdOf(b("\r\nMessage-ID: <corps@x>\r\n")), null, "message sans en-têtes");
  eq(messageIdOf(b("Subject: x\r\n Message-ID: <suite@x>\r\n\r\n")), null, "ligne de continuation d'un autre champ");
  eq(messageIdOf(b("X-Message-ID: <a@b>\r\nMessage-ID-Old: <c@d>\r\n\r\n")), null, "autres noms");
  eq(messageIdOf(b("Subject: x\r\n\r\n")), null, "absent");
  eq(messageIdOf(new Uint8Array(0)), null, "vide");
});

test("messageIdOf : une ligne de blancs prolonge le champ, elle ne termine pas le bloc", () => {
  eq(messageIdOf(b("Subject: x\r\n \r\nMessage-ID: <a@b>\r\n\r\n")), "a@b");
  eq(messageIdOf(b("Subject: x\r\n\t\r\nMessage-ID: <a@b>\r\n\r\n")), "a@b");
});

test("messageIdOf : un CR isolé termine une ligne", () => {
  eq(messageIdOf(b("Subject: x\rMessage-ID: <a@b>\r\n\r\n")), "a@b");
  eq(messageIdOf(b("Subject: x\r\rMessage-ID: <a@b>\r\n\r\n")), null, "CR CR : ligne vide, fin du bloc");
  eq(messageIdOf(b("Subject: x\n\r\nMessage-ID: <a@b>\r\n")), null, "LF CRLF : ligne vide");
});

test("messageIdOf : identifiants refusés", () => {
  const refused = [
    "<>",
    "<abc@x",
    "< abc@x>",
    "<abc @x>",
    "<abc\r\n @x>",
    `<a${ch(0)}b@x>`,
    `<a${ch(1)}b@x>`,
    `<a${ch(0x7f)}b@x>`,
    "<été@x>",
    "<<abc@x>",
    "",
    "   ",
    "(seulement un commentaire)",
  ];
  for (const value of refused) eq(messageIdOf(b(`Message-ID: ${value}\r\n\r\n`)), null, JSON.stringify(value));
});

test("messageIdOf : 998 caractères au plus", () => {
  const id998 = `${"a".repeat(996)}@x`;
  eq(id998.length, 998);
  eq(messageIdOf(b(`Message-ID: <${id998}>\r\n\r\n`)), id998);
  eq(messageIdOf(b(`Message-ID: <a${id998}>\r\n\r\n`)), null, "999");
});

test("messageIdOf : fenêtre de 1 Mio", () => {
  const filler = `X-Filler: ${"f".repeat(98)}\r\n`; // 110 bytes
  const count = Math.ceil(MAX_HEADER_BYTES / filler.length);
  const big = filler.repeat(count);
  eq(messageIdOf(b(`${big}Message-ID: <loin@x>\r\n\r\ncorps`)), null, "au-delà de 1 Mio");
  eq(messageIdOf(b(`Message-ID: <tot@x>\r\n${big}\r\ncorps`)), "tot@x", "bloc de plus de 1 Mio, identifiant au début");
  eq(messageIdOf(b(`Message-ID: <tot@x>\r\n${big}`)), "tot@x", "aucune ligne vide");
  // A field cut by the window: the id is not closed within it.
  const head = "X: y\r\n".repeat(Math.floor((MAX_HEADER_BYTES - 20) / 6));
  const cut = b(`${head}Message-ID:${" ".repeat(MAX_HEADER_BYTES)}<a@b>\r\n\r\n`);
  eq(messageIdOf(cut), null, "champ coupé par la fenêtre");
  const word = b(`${"X: y\r\n".repeat(Math.floor((MAX_HEADER_BYTES - 14) / 6))}Message-ID: ${"a".repeat(64)}@x\r\n\r\n`);
  eq(messageIdOf(word), null, "mot coupé par la fenêtre");
});

test("messageIdOf : entrée qui n'est pas un Uint8Array → null", () => {
  for (const bad of NOT_BYTES) eq(messageIdOf(bad), null, String(bad));
});

// ── ensureMessageId ───────────────────────────────────────────────────────

test("ensureMessageId : message qui a déjà un Message-ID → inchangé", () => {
  const input = b("Message-ID: <a@b>\r\nSubject: x\r\n\r\ncorps");
  const result = ensureMessageId(input);
  assert(result.bytes === input, "même tableau");
  eq(result.messageId, "a@b");
  eq(result.synthetic, false);
});

test("ensureMessageId : identifiant synthétique en tête, haché du message d'origine", () => {
  const original = "Subject: test\r\nFrom: a@example.com\r\n\r\nbody\r\n";
  const result = ensureMessageId(b(original));
  eq(result.synthetic, true);
  eq(result.messageId, "40eb89866b83526f46996c7a72776c34@sync443.invalid");
  eq(s(result.bytes), `Message-ID: <40eb89866b83526f46996c7a72776c34@sync443.invalid>\r\n${original}`);
  eq(messageIdOf(result.bytes), result.messageId, "relu");
  eq(ensureMessageId(b(original)).messageId, result.messageId, "déterministe");
  eq(ensureMessageId(result.bytes).synthetic, false, "idempotent");
});

test("ensureMessageId : message vide, sans en-têtes, ou au premier champ inutilisable", () => {
  const empty = ensureMessageId(new Uint8Array(0));
  eq(empty.messageId, "e3b0c44298fc1c149afbf4c8996fb924@sync443.invalid");
  eq(s(empty.bytes), "Message-ID: <e3b0c44298fc1c149afbf4c8996fb924@sync443.invalid>\r\n");
  for (const original of ["\r\ncorps seul", "Message-ID: <>\r\n\r\n", " ligne de continuation\r\n\r\n", "\nLF"]) {
    const r = ensureMessageId(b(original));
    eq(r.synthetic, true, JSON.stringify(original));
    eq(messageIdOf(r.bytes), r.messageId, `relu : ${JSON.stringify(original)}`);
    eq(s(r.bytes.subarray(r.bytes.length - b(original).length)), original, "original intact après le champ");
  }
});

test("ensureMessageId : en-têtes de plus de 1 Mio → identifiant ajouté, relu", () => {
  const big = b(`${"X-Filler: abcdefghij\r\n".repeat(60_000)}Message-ID: <loin@x>\r\n\r\ncorps`);
  assert(big.length > MAX_HEADER_BYTES);
  const r = ensureMessageId(big);
  eq(r.synthetic, true);
  eq(messageIdOf(r.bytes), r.messageId);
});

test("ensureMessageId : entrée qui n'est pas un Uint8Array refusée", () => {
  for (const bad of NOT_BYTES) throws(() => ensureMessageId(bad), TypeError, String(bad));
});

// ── stripInternalHeaders ──────────────────────────────────────────────────

test("stripInternalHeaders : retire les en-têtes que Thunderbird interprète", () => {
  const input = [
    "From: a@example.com",
    "X-Mozilla-Status: 0009",
    "X-Mozilla-Status2: 00800000",
    "Subject: bonjour",
    "X-Mozilla-Keys: $label1 junk",
    "X-Account-Key: account1",
    "X-Identity-Key: id1",
    "X-Mozilla-Draft-Info: internal/draft; vcard=0",
    "Fcc: mailbox://nobody@Local%20Folders/Sent",
    "To: b@example.com",
    "",
    "X-Mozilla-Status: 0001",
    "corps",
    "",
  ].join("\r\n");
  const expected = "From: a@example.com\r\nSubject: bonjour\r\nTo: b@example.com\r\n\r\nX-Mozilla-Status: 0001\r\ncorps\r\n";
  eq(s(stripInternalHeaders(b(input))), expected);
});

test("stripInternalHeaders : casse ignorée, lignes de continuation emportées", () => {
  const input = "x-mozilla-status: 0001\r\nX-MOZILLA-KEYS: a\r\n  b\r\n\tc\r\nfcc: x\r\nX-ACCOUNT-KEY: k\r\nSubject: s\r\n folded\r\n\r\nbody";
  eq(s(stripInternalHeaders(b(input))), "Subject: s\r\n folded\r\n\r\nbody");
  eq(s(stripInternalHeaders(b("X-Mozilla-Status : 0001\r\nA: b\r\n\r\n"))), "A: b\r\n\r\n", "blanc avant les deux-points");
  eq(s(stripInternalHeaders(b("X-Mozilla-: x\r\nA: b\r\n\r\n"))), "A: b\r\n\r\n", "préfixe seul");
});

test("stripInternalHeaders : noms voisins conservés", () => {
  const input = "X-Mozilla: a\r\nX-Mozillas-Status: b\r\nX-Account-Keys: c\r\nXFcc: d\r\nFcc2: e\r\nX-Identity: f\r\nMozilla-Status: g\r\n\r\n";
  const bytes = b(input);
  assert(stripInternalHeaders(bytes) === bytes, "rien à retirer : même tableau");
});

test("stripInternalHeaders : fins de ligne LF, CR isolé, dernier champ sans fin de ligne", () => {
  eq(s(stripInternalHeaders(b("A: 1\nX-Mozilla-Status: 8\nB: 2\n\nX-Mozilla-Status: 8\n"))), "A: 1\nB: 2\n\nX-Mozilla-Status: 8\n");
  eq(s(stripInternalHeaders(b("A: 1\rX-Mozilla-Status: 8\r\n\r\nbody"))), "A: 1\r\r\nbody", "caché derrière un CR isolé");
  eq(s(stripInternalHeaders(b("A: 1\r\nX-Mozilla-Keys: junk"))), "A: 1\r\n", "en fin de données");
  eq(s(stripInternalHeaders(b("X-Mozilla-Keys: junk"))), "", "seul champ");
});

test("stripInternalHeaders : un retrait ne fait jamais disparaître la ligne vide qui clôt les en-têtes", () => {
  // Joined naively, the lone CR and the LF of the empty line would make one CRLF:
  // the body's first line would become a header.
  const cases = [
    ["A: 1\rX-Mozilla-Keys: x\n\nX-Mozilla-Status: 0008\n\nsuite", "A: 1\r\n\nX-Mozilla-Status: 0008\n\nsuite"],
    ["A: 1\rX-Mozilla-Keys: x\r\n\nX-Mozilla-Status: 0008\n", "A: 1\r\n\nX-Mozilla-Status: 0008\n"],
    ["A: 1\rX-Mozilla-A: x\rX-Mozilla-B: y\n folded\n\nX-Mozilla-Status: 8\n", "A: 1\r\n\nX-Mozilla-Status: 8\n"],
  ];
  for (const [input, expected] of cases) {
    const out = stripInternalHeaders(b(input));
    eq(s(out), expected, JSON.stringify(input));
    assert(stripInternalHeaders(out) === out, "rien de plus à retirer : le corps est resté corps");
  }
  const draftCase = b("Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\rX-Mozilla-A: 1\n\nX-Mozilla-Status: corps\n--b--\n");
  eq(s(cleanDraft(draftCase)), "Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\nX-Mozilla-Status: corps\n--b--\n", "dans une partie");
});

test("stripInternalHeaders : sans ligne vide, tout le message est en-têtes", () => {
  eq(s(stripInternalHeaders(b("A: 1\r\nX-Mozilla-Status: 8\r\nB: 2\r\n"))), "A: 1\r\nB: 2\r\n");
});

test("stripInternalHeaders : bloc d'en-têtes de plus de 1 Mio traité entièrement", () => {
  const filler = "X-Filler: abcdefghij\r\n".repeat(60_000);
  const input = b(`${filler}X-Mozilla-Status: 0008\r\n\r\ncorps`);
  eq(s(stripInternalHeaders(input)), `${filler}\r\ncorps`);
});

test("stripInternalHeaders : seulement le bloc de tête, pas les parties MIME", () => {
  const input = "Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nX-Mozilla-Cloud-Part: x\r\n\r\ntexte\r\n--b--\r\n";
  const bytes = b(input);
  assert(stripInternalHeaders(bytes) === bytes);
});

test("stripInternalHeaders : corps et octets non UTF-8 intacts", () => {
  const body = new Uint8Array(512);
  for (let i = 0; i < 512; i++) body[i] = i & 0xff;
  const head = b("X-Mozilla-Status: 0001\r\nSubject: =?utf-8?q?=C3=A9?=\r\n\r\n");
  const input = new Uint8Array(head.length + body.length);
  input.set(head);
  input.set(body, head.length);
  const out = stripInternalHeaders(input);
  const keptHead = b("Subject: =?utf-8?q?=C3=A9?=\r\n\r\n");
  eq(out.length, keptHead.length + body.length);
  eq(out.subarray(keptHead.length), body);
});

test("stripInternalHeaders et cleanDraft : entrée qui n'est pas un Uint8Array refusée", () => {
  for (const bad of NOT_BYTES) {
    throws(() => stripInternalHeaders(bad), TypeError, String(bad));
    throws(() => cleanDraft(bad), TypeError, String(bad));
  }
});

// ── cleanDraft ────────────────────────────────────────────────────────────

/** Joins lines with CRLF; lines starting with "!" are internal and must disappear. */
function draft(lines) {
  return {
    input: b(lines.map((l) => (l.startsWith("!") ? l.slice(1) : l)).join("\r\n")),
    expected: lines.filter((l) => !l.startsWith("!")).join("\r\n"),
  };
}

test("cleanDraft : brouillon de Thunderbird, en tête et dans chaque partie", () => {
  const { input, expected } = draft([
    "!X-Mozilla-Status: 0001",
    "!X-Mozilla-Status2: 00000000",
    "!X-Mozilla-Keys:                                                                                 ",
    "!FCC: imap://user@imap.example.com/Sent",
    "!X-Identity-Key: id1",
    "!X-Account-Key: account2",
    "Message-ID: <draft@example.com>",
    "Date: Sun, 15 Nov 2026 10:00:00 +0100",
    "MIME-Version: 1.0",
    "From: A <a@example.com>",
    "To: b@example.com",
    "Subject: rapport",
    "!X-Mozilla-Draft-Info: internal/draft; vcard=0; receipt=0; DSN=0; uuencode=0;",
    "! attachmentreminder=0; deliveryformat=4",
    'Content-Type: multipart/mixed; boundary="------------mixed1"',
    "",
    "This is a multi-part message in MIME format.",
    "--------------mixed1",
    'Content-Type: multipart/alternative; boundary="------------alt2"',
    "",
    "",
    "--------------alt2",
    "Content-Type: text/plain; charset=UTF-8; format=flowed",
    "Content-Transfer-Encoding: 7bit",
    "",
    "Bonjour,",
    "X-Mozilla-Status: ceci est du texte",
    "",
    "--------------alt2",
    "Content-Type: text/html; charset=UTF-8",
    "!X-Mozilla-Internal: 1",
    "Content-Transfer-Encoding: 7bit",
    "",
    "<p>Bonjour,</p>",
    "",
    "--------------alt2--",
    "",
    "--------------mixed1",
    'Content-Type: text/html; charset=UTF-8; name="rapport.pdf.html"',
    'Content-Disposition: attachment; filename="rapport.pdf.html"',
    "!X-Mozilla-Cloud-Part: cloudFile; url=https://cloud.example.com/f/1;",
    "! provider=ext; file=file:///Users/moi/Documents/rapport.pdf; name=rapport.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "PGh0bWw+PC9odG1sPg==",
    "",
    "--------------mixed1",
    "Content-Type: application/pdf; name=a.pdf",
    "!X-Mozilla-External-Attachment-URL: file:///Users/moi/a.pdf",
    "Content-Disposition: attachment; filename=a.pdf",
    "",
    "JVBERi0xLjQK",
    "",
    "--------------mixed1--",
    "",
    "épilogue",
    "X-Mozilla-Status: épilogue intact",
    "",
  ]);
  eq(s(cleanDraft(input)), expected);
});

test("cleanDraft : partie message/rfc822 non ouverte, préambule intact", () => {
  const { input, expected } = draft([
    "!X-Mozilla-Draft-Info: internal/draft",
    "Content-Type: multipart/mixed; boundary=xyz",
    "",
    "X-Mozilla-Status: préambule",
    "--xyz",
    "Content-Type: message/rfc822",
    "!X-Mozilla-Status: 0001",
    "",
    "X-Mozilla-Status: 0001",
    "X-Account-Key: account9",
    "Subject: message transféré",
    "",
    "texte",
    "--xyz--",
    "",
  ]);
  eq(s(cleanDraft(input)), expected);
});

test("cleanDraft : syntaxe de Content-Type tolérée", () => {
  const variants = [
    "Content-Type: MULTIPART/Mixed; BOUNDARY=xyz",
    "Content-Type: multipart/mixed;\r\n\tboundary=\"xyz\"",
    "Content-Type: multipart/mixed (commentaire); charset=\"a;b\"; boundary = \"xyz\"",
    "Content-Type: (c) multipart / related ; type=\"text/html\" ; boundary=xyz ; start=a",
    "content-type: multipart/alternative; boundary=\"x\\yz\"",
    "Content-Type: multipart/mixed; foo; =bar; boundary=xyz",
    "Content-Type: multipart/mixed; boundary=xyz; boundary=autre",
  ];
  for (const ct of variants) {
    const input = b(`${ct}\r\n\r\n--xyz\r\nX-Mozilla-Cloud-Part: a\r\nContent-Type: text/plain\r\n\r\nt\r\n--xyz--\r\n`);
    eq(s(cleanDraft(input)), `${ct}\r\n\r\n--xyz\r\nContent-Type: text/plain\r\n\r\nt\r\n--xyz--\r\n`, ct);
  }
});

test("cleanDraft : multipart mal formé laissé tel quel", () => {
  const bad = [
    "Content-Type: multipart/mixed",
    "Content-Type: multipart/mixed; boundary=",
    'Content-Type: multipart/mixed; boundary=""',
    'Content-Type: multipart/mixed; boundary="xyz',
    `Content-Type: multipart/mixed; boundary="${"x".repeat(201)}"`,
    `Content-Type: multipart/mixed; boundary="xy${ch(1)}z"`,
    "Content-Type: multipart/mixed; boundary*=xyz",
    "Content-Type: text/plain; boundary=xyz",
    "Content-Type: multipartx/mixed; boundary=xyz",
  ];
  for (const ct of bad) {
    const input = b(`${ct}\r\n\r\n--xyz\r\nX-Mozilla-Cloud-Part: a\r\n\r\nt\r\n--xyz--\r\n`);
    assert(cleanDraft(input) === input, ct);
  }
});

test("cleanDraft : délimiteur avec blancs finaux reconnu, avec texte final non", () => {
  const { input, expected } = draft([
    "Content-Type: multipart/mixed; boundary=b",
    "",
    "--b  \t",
    "!X-Mozilla-A: 1",
    "",
    "texte",
    "--b x",
    "X-Mozilla-B: corps",
    "",
    "--b--  ",
    "",
  ]);
  eq(s(cleanDraft(input)), expected);
});

test("cleanDraft : délimiteur fermant absent → parties lues jusqu'à la fin", () => {
  const { input, expected } = draft([
    "Content-Type: multipart/mixed; boundary=b",
    "",
    "--b",
    "!X-Mozilla-A: 1",
    "",
    "texte",
    "--b",
    "!X-Mozilla-B: 2",
    "Content-Type: text/plain",
    "",
    "fin sans délimiteur",
  ]);
  eq(s(cleanDraft(input)), expected);
});

test("cleanDraft : partie sans ligne vide avant le délimiteur suivant", () => {
  const { input, expected } = draft([
    "Content-Type: multipart/mixed; boundary=b",
    "",
    "--b",
    "Content-Type: text/plain",
    "!X-Mozilla-A: 1",
    "--b",
    "!X-Mozilla-B: 2",
    "",
    "texte",
    "--b--",
    "",
  ]);
  eq(s(cleanDraft(input)), expected);
});

test("cleanDraft : un délimiteur extérieur ferme les parties intérieures", () => {
  const { input, expected } = draft([
    "Content-Type: multipart/mixed; boundary=out",
    "",
    "--out",
    "Content-Type: multipart/alternative; boundary=in",
    "",
    "--in",
    "!X-Mozilla-A: 1",
    "",
    "texte (la partie intérieure n'est jamais fermée)",
    "--out",
    "!X-Mozilla-B: 2",
    "",
    "--in",
    "X-Mozilla-C: corps, plus un délimiteur actif",
    "--out--",
    "",
  ]);
  eq(s(cleanDraft(input)), expected);
});

test("cleanDraft : frontière préfixe d'une autre", () => {
  const { input, expected } = draft([
    "Content-Type: multipart/mixed; boundary=abc",
    "",
    "--abc",
    "Content-Type: multipart/alternative; boundary=abcd",
    "",
    "--abcd",
    "!X-Mozilla-A: 1",
    "",
    "texte",
    "--abcd--",
    "--abc",
    "!X-Mozilla-B: 2",
    "",
    "--abcde",
    "X-Mozilla-C: corps",
    "--abc--",
    "",
  ]);
  eq(s(cleanDraft(input)), expected);
});

test(`cleanDraft : profondeur limitée à ${MAX_MIME_DEPTH}`, () => {
  const levels = MAX_MIME_DEPTH + 8;
  const lines = [`Content-Type: multipart/mixed; boundary=b0`, "X-Mozilla-Level: 0", ""];
  for (let i = 1; i <= levels; i++) {
    lines.push(`--b${i - 1}`, `Content-Type: multipart/mixed; boundary=b${i}`, `X-Mozilla-Level: ${i}`, "");
  }
  for (let i = levels; i >= 1; i--) lines.push(`--b${i - 1}--`);
  const out = s(cleanDraft(b(lines.join("\r\n"))));
  const left = out.split("\r\n").filter((l) => l.startsWith("X-Mozilla-Level"));
  // The top level and levels 1 to MAX_MIME_DEPTH are cleaned; deeper parts are not opened.
  eq(left.length, levels - MAX_MIME_DEPTH);
  eq(left[0], `X-Mozilla-Level: ${MAX_MIME_DEPTH + 1}`);
});

test(`cleanDraft : au plus ${MAX_MIME_PARTS} parties parcourues`, () => {
  const lines = ["Content-Type: multipart/mixed; boundary=b", ""];
  for (let i = 1; i <= MAX_MIME_PARTS + 2; i++) lines.push("--b", `X-Mozilla-Part: ${i}`, "", "t");
  lines.push("--b--", "");
  const out = s(cleanDraft(b(lines.join("\r\n"))));
  const left = out.split("\r\n").filter((l) => l.startsWith("X-Mozilla-Part"));
  eq(left, [`X-Mozilla-Part: ${MAX_MIME_PARTS + 1}`, `X-Mozilla-Part: ${MAX_MIME_PARTS + 2}`]);
});

test("cleanDraft : fins de ligne LF seules", () => {
  const input = "X-Mozilla-Draft-Info: x\nContent-Type: multipart/mixed; boundary=b\n\n--b\nX-Mozilla-Cloud-Part: y\nContent-Type: text/plain\n\nt\n--b--\n";
  eq(s(cleanDraft(b(input))), "Content-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\nt\n--b--\n");
});

test("cleanDraft : rien à retirer → même tableau", () => {
  const input = b("Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nt\r\n--b--\r\n");
  assert(cleanDraft(input) === input);
  const plain = b("Subject: x\r\n\r\nX-Mozilla-Status: corps");
  assert(cleanDraft(plain) === plain);
});

test("cleanDraft : corps binaire intact octet par octet", () => {
  const body = new Uint8Array(4096);
  for (let i = 0; i < body.length; i++) body[i] = (i * 7 + 3) & 0xff;
  // A body without "--b" at a line start, so it cannot hold a delimiter.
  for (let i = 0; i + 1 < body.length; i++) if (body[i] === 0x2d && body[i + 1] === 0x2d) body[i + 1] = 0x2e;
  const head = b("Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nX-Mozilla-A: 1\r\nContent-Type: application/octet-stream\r\n\r\n");
  const tail = b("\r\n--b--\r\n");
  const input = new Uint8Array(head.length + body.length + tail.length);
  input.set(head);
  input.set(body, head.length);
  input.set(tail, head.length + body.length);
  const out = cleanDraft(input);
  const removed = b("X-Mozilla-A: 1\r\n").length;
  eq(out.length, input.length - removed);
  eq(out.subarray(head.length - removed, head.length - removed + body.length), body);
});
