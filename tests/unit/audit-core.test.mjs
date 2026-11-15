// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Regression tests for the security audit of the core (step 1): one test
 * per finding, so that none can come back. Special characters are built
 * with String.fromCodePoint, never typed, so the source stays readable.
 */

import { test, eq, assert, throws } from "./harness.mjs";
import { decode, el, encode, toDebugString, WbxmlError } from "../../src/core/wbxml.mjs";
import { parseServer, ServerAddressError } from "../../src/core/server.mjs";
import { evaluateTls, tlsMessage } from "../../src/core/tls-policy.mjs";
import { folderName, status } from "../../src/core/sanitize.mjs";
import { folderCreateRequest, folderUpdateRequest, parsePing, parseSync, ProtocolError, MAX_FOLDERS } from "../../src/core/protocol.mjs";
import { retryDelay } from "../../src/core/backoff.mjs";

const cp = (...codes) => String.fromCodePoint(...codes);
const RLO = cp(0x202e);

/** <AirSync:Sync> holding one <Status> whose text is `pieces` STR_I pieces of `piece` bytes. */
function manyPieces(count, piece = [0x41]) {
  const body = [0x03, 0x01, 0x6a, 0x00, 0x45, 0x4e]; // header, <Sync>, <Status>
  const unit = [0x03, ...piece, 0x00];
  const out = new Uint8Array(body.length + unit.length * count + 2);
  out.set(body);
  for (let i = 0; i < count; i++) out.set(unit, body.length + i * unit.length);
  out[out.length - 2] = 0x01;
  out[out.length - 1] = 0x01;
  return out;
}

test("audit cœur 1 : IPv6 écrite comme Thunderbird l'écrit, sinon le certificat n'était pas contrôlé", () => {
  eq(parseServer("[2001:0db8::1]").origin, "https://[2001:db8::1]");
  eq(parseServer("[2001:db8:0:0:0:0:0:1]").origin, "https://[2001:db8::1]");
  eq(parseServer("[::ffff:192.0.2.1]").origin, "https://[::ffff:c000:201]");
});

test("audit cœur 2 : les morceaux de texte comptent dans la limite d'éléments", () => {
  throws(() => decode(manyPieces(600_000)), (e) => e instanceof WbxmlError && /trop d'éléments/.test(e.message), "600 000 morceaux d'un octet");
  const t0 = Date.now();
  const d = decode(manyPieces(1_000_000, []), { maxBytes: 4_000_000 });
  eq(d.children[0].value.length, 0, "un million de morceaux vides : aucun stockage");
  assert(Date.now() - t0 < 2000, "en temps linéaire");
});

test("audit cœur 2 bis : une petite valeur ne retient pas toute la réponse en mémoire", () => {
  const bytes = encode(el("AirSync:Sync", [el("Status", "1"), el("SyncKey", "x".repeat(100_000))]));
  const d = decode(bytes);
  const st = d.children[0].value;
  eq(st.buffer.byteLength, st.length, "valeur copiée, pas une vue sur le document");
});

test("audit cœur B1 : une limite NaN, infinie ou négative ne lève pas la limite", () => {
  let deep = el("Status", "1");
  for (let i = 0; i < 70; i++) deep = el("Collections", [deep]);
  const bytes = encode(el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", "1")])])]));
  decode(bytes, { maxDepth: NaN, maxNodes: Infinity, maxBytes: -1 }); // falls back to the defaults
  throws(() => decode(manyPieces(600_000), { maxNodes: Infinity }), WbxmlError, "Infinity → limite par défaut");
});

test("audit cœur 3 : le nom d'émetteur affiché est nettoyé et présenté comme falsifiable", () => {
  const issuer = `CN=DigiCert Global G2 ${RLO}TRUSTED by IT\n\nCN=x${"y".repeat(500)}`;
  const r = evaluateTls({ state: "secure", certificates: [{ issuer, fingerprint: { sha256: "AB".repeat(32) } }] });
  assert(!r.issuer.includes(RLO) && !r.issuer.includes("\n") && r.issuer.length <= 200, "émetteur nettoyé");
  const m = tlsMessage(r.reason, issuer);
  assert(!m.includes(RLO) && !m.includes("\n"), "message nettoyé");
  assert(m.includes("que n'importe qui peut choisir"), "le nom est présenté comme falsifiable");
});

test("audit cœur B5 : épinglage limité au certificat du serveur ou à la racine ; exception refusée", () => {
  const chain = [
    { subject: "CN=s", issuer: "CN=i", fingerprint: { sha256: "11".repeat(32) } },
    { subject: "CN=i", issuer: "CN=r", fingerprint: { sha256: "22".repeat(32) } },
    { subject: "CN=r", issuer: "CN=r", fingerprint: { sha256: "33".repeat(32) } },
  ];
  eq(evaluateTls({ state: "secure", certificates: chain }, { pins: ["22".repeat(32)] }).reason, "not-public-root");
  eq(evaluateTls({ state: "secure", certificates: chain }, { pins: ["33".repeat(32)] }).reason, "pinned");
  const withRoot = [...chain.slice(0, 2), { ...chain[2], isBuiltInRoot: true }];
  eq(evaluateTls({ state: "secure", certificates: withRoot, overridableErrorCategory: "trust_error" }).reason, "exception");
});

test("audit cœur 4 : alias locaux refusés", () => {
  for (const host of ["localhost.localdomain", "localhost4.localdomain4", "localhost6.localdomain6", "ip6-localhost", "ip6-loopback", "x.localhost"]) {
    throws(() => parseServer(host), ServerAddressError, host);
  }
});

test("audit cœur 5 : caractères invisibles, de remplissage ou empilés retirés des noms de dossier", () => {
  eq(folderName(`Inbox${cp(0xe0049, 0xe0047, 0xe004e)}`), "Inbox", "caractères d'étiquette");
  eq(folderName(`A${cp(0x2061, 0x034f, 0xfe0f, 0x180b, 0x17b4)}B`), "AB", "invisibles divers");
  eq(folderName(cp(0x3164)), null, "remplissage hangul seul");
  eq(folderName(cp(0x2800)), null, "motif braille vide seul");
  eq(folderName(`e${cp(0x0301).repeat(500)}`).length <= 5, true, "marques combinantes plafonnées");
  eq(folderName(`e${cp(0x0301)}`), cp(0x00e9), "forme NFC");
  eq(folderName(`a${cp(0xe000)}`), null, "usage privé refusé");
});

test("audit cœur 6 : un nom de dossier n'est jamais réécrit en silence avant envoi", () => {
  throws(() => folderCreateRequest("1", "0", `  Projets${RLO}\tclient  `), ProtocolError);
  throws(() => folderUpdateRequest("1", "5", "0", "x".repeat(300)), ProtocolError);
  throws(() => folderCreateRequest("1", "0", null), ProtocolError);
  folderCreateRequest("1", "0", "Projets client");
});

test("audit cœur 7 : réponses invalides écartées, Ping plafonné et dédoublonné, dossier en double refusé", () => {
  const ping = el("Ping:Ping", [el("Status", "2"), el("Folders", [el("Folder", "5"), el("Folder", "5"), el("Folder", "")])]);
  eq(parsePing(decode(encode(ping))).folders, ["5"]);
  const many = el("Ping:Ping", [el("Folders", Array.from({ length: MAX_FOLDERS + 1 }, (_, i) => el("Folder", String(i))))]);
  throws(() => parsePing(decode(encode(many))), ProtocolError);
  const twice = el("AirSync:Sync", [el("Collections", [
    el("Collection", [el("SyncKey", "1"), el("CollectionId", "5"), el("Status", "1")]),
    el("Collection", [el("SyncKey", "9"), el("CollectionId", "5"), el("Status", "1")]),
  ])]);
  throws(() => parseSync(decode(encode(twice))), ProtocolError);
});

test("audit cœur 8 : le journal de débogage neutralise sens d'écriture et séparateurs", () => {
  const d = decode(encode(el("AirSync:Sync", [el("Status", `1${RLO}${cp(0x2028)}${cp(0x0085)}x`)])));
  const s = toDebugString(d, { shown: new Set(["Status"]) });
  assert(!s.includes(RLO) && !s.includes(cp(0x2028)) && !s.includes(cp(0x0085)), s);
});

test("audit cœur B8-B10 : statuts normalisés, nombres non entiers refusés", () => {
  eq(status("0140"), "140");
  throws(() => el("WindowSize", NaN), WbxmlError);
  throws(() => el("WindowSize", 1e21), WbxmlError);
  throws(() => encode({ ns: "AirSync", tag: "Sync", value: null, opaque: false }), WbxmlError, "élément sans liste d'enfants");
});

test("audit cœur B4 : délai toujours fini, entre 1 s et un jour", () => {
  for (const opts of [{ random: () => NaN }, { max: NaN }, { base: 0 }, { base: -5 }, { retryAfterMs: 10 ** 12 }]) {
    const d = retryDelay(3, opts);
    assert(Number.isFinite(d) && d >= 1000 && d <= 86_400_000, `${JSON.stringify(opts)} → ${d}`);
  }
  eq(retryDelay(0, { retryAfterMs: 60_000 }), 60_000, "Retry-After respecté même sans échec compté");
});
