// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the e-mail codec against [MS-ASEMAIL] (Read, Flag/Status),
 * [MS-ASAIRS] (Body, Type, Data, Truncated) and [MS-ASCMD] (Sync Options).
 * ApplicationData is built, encoded to WBXML and decoded again, then read
 * through protocol.parseSync, as it arrives from a server.
 */

import { test, assert, eq, throws } from "./harness.mjs";
import { readEmail, changeEmail, mailOptions, DEFAULT_MAX_MIME_BYTES, MAIL_FILTER_TYPES, FLAG_TYPE } from "../../src/core/mail-codec.mjs";
import { el, encode, decode, child, text, at } from "../../src/core/wbxml.mjs";
import { parseSync, syncRequest, changeCommand, ProtocolError } from "../../src/core/protocol.mjs";
import { encodeUtf8 } from "../../src/core/utf8.mjs";

/** ApplicationData of an Add in a Sync response, as the client receives it. */
function received(children) {
  const doc = el("AirSync:Sync", [
    el("Collections", [
      el("Collection", [
        el("SyncKey", "2"),
        el("CollectionId", "5"),
        el("Status", "1"),
        el("Commands", [el("Add", [el("ServerId", "5:1"), el("ApplicationData", children)])]),
      ]),
    ]),
  ]);
  return parseSync(decode(encode(doc))).collections[0].commands[0].data;
}

const mimeBody = (data, extra = []) =>
  el("AirSyncBase:Body", [el("AirSyncBase:Type", "4"), ...extra, data === undefined ? null : el("AirSyncBase:Data", data)]);

const NONE = { read: null, flagged: null, mime: null, truncated: false };

// ── readEmail ─────────────────────────────────────────────────────────────

test("readEmail : Read 1 / 0, absent ou invalide → null", () => {
  eq(readEmail(received([el("Email:Read", "1")])).read, true);
  eq(readEmail(received([el("Email:Read", "0")])).read, false);
  eq(readEmail(received([el("Email:Subject", "x")])).read, null, "absent");
  for (const bad of ["2", "", "true", " 1", "01"]) eq(readEmail(received([el("Email:Read", bad)])).read, null, JSON.stringify(bad));
});

test("readEmail : drapeau actif (Status 2) → true", () => {
  const data = received([el("Email:Flag", [el("Email:Status", "2"), el("Email:FlagType", "for Follow Up")])]);
  eq(readEmail(data).flagged, true);
});

test("readEmail : drapeau effacé (0), terminé (1) ou <Flag/> vide → false", () => {
  eq(readEmail(received([el("Email:Flag", [el("Email:Status", "0")])])).flagged, false, "0");
  eq(readEmail(received([el("Email:Flag", [el("Email:Status", "1"), el("Email:CompleteTime", "2026-11-15T10:00:00.000Z")])])).flagged, false, "1");
  eq(readEmail(received([el("Email:Flag")])).flagged, false, "vide");
  eq(readEmail(received([el("Email:Flag", "")])).flagged, false, "texte vide");
});

test("readEmail : drapeau absent ou illisible → null", () => {
  eq(readEmail(received([el("Email:Read", "1")])).flagged, null, "absent");
  eq(readEmail(received([el("Email:Flag", [el("Email:FlagType", "for Follow Up")])])).flagged, null, "sans Status");
  for (const bad of ["3", "", "x", "-1"]) {
    eq(readEmail(received([el("Email:Flag", [el("Email:Status", bad)])])).flagged, null, JSON.stringify(bad));
  }
  eq(readEmail(received([el("Email:Flag", [el("AirSyncBase:Status", "2")])])).flagged, null, "Status d'un autre espace de noms");
});

test("readEmail : corps MIME en données opaques, octet pour octet", () => {
  const raw = new Uint8Array(1024);
  for (let i = 0; i < raw.length; i++) raw[i] = i & 0xff; // NUL included: opaque data carries any byte
  const result = readEmail(received([el("Email:Read", "0"), mimeBody(raw, [el("AirSyncBase:EstimatedDataSize", "1024")])]));
  eq(result.mime, raw);
  eq(result.truncated, false);
  eq(result.read, false);
});

test("readEmail : corps MIME en chaîne", () => {
  const message = "Subject: été\r\nMessage-ID: <a@b>\r\n\r\ncorps\r\n";
  const result = readEmail(received([mimeBody(message)]));
  eq(result.mime, encodeUtf8(message));
});

test("readEmail : Truncated", () => {
  const partial = readEmail(received([mimeBody("Subject: x\r\n\r\ndébut", [el("AirSyncBase:Truncated", "1")])]));
  eq(partial.truncated, true);
  eq(partial.mime, encodeUtf8("Subject: x\r\n\r\ndébut"), "début du message conservé");
  eq(readEmail(received([mimeBody("x", [el("AirSyncBase:Truncated", "0")])])).truncated, false);
});

test("readEmail : seul le premier corps de type 4 compte", () => {
  const html = el("AirSyncBase:Body", [el("AirSyncBase:Type", "2"), el("AirSyncBase:Data", "<p>x</p>")]);
  eq(readEmail(received([html])), NONE, "corps HTML seul");
  eq(readEmail(received([html, mimeBody("A: b\r\n\r\nc")])).mime, encodeUtf8("A: b\r\n\r\nc"));
  eq(readEmail(received([mimeBody("premier"), mimeBody("second")])).mime, encodeUtf8("premier"));
  const typeless = el("AirSyncBase:Body", [el("AirSyncBase:Data", "x")]);
  eq(readEmail(received([typeless])).mime, null, "sans Type");
});

test("readEmail : corps absent, Data absente ou vide → mime null", () => {
  eq(readEmail(received([el("Email:Read", "1")])).mime, null);
  eq(readEmail(received([mimeBody(undefined)])).mime, null, "Data absente");
  eq(readEmail(received([mimeBody(new Uint8Array(0))])).mime, null, "Data opaque vide");
  eq(readEmail(received([mimeBody("")])).mime, null, "Data texte vide");
});

test("readEmail : plafond maxMimeBytes → mime null, truncated true", () => {
  const data = received([mimeBody(new Uint8Array(10).fill(65))]);
  eq(readEmail(data, { maxMimeBytes: 10 }).mime.length, 10, "à la limite");
  eq(readEmail(data, { maxMimeBytes: 9 }), { read: null, flagged: null, mime: null, truncated: true }, "au-delà");
  for (const bad of [NaN, -1, "5", Infinity, null]) eq(readEmail(data, { maxMimeBytes: bad }).mime.length, 10, `plafond invalide ${bad} → défaut`);
});

test("readEmail : plafond par défaut de 64 Mio", () => {
  eq(DEFAULT_MAX_MIME_BYTES, 64 * 1024 * 1024);
  const huge = { ns: "AirSyncBase", tag: "Data", children: [], value: new Uint8Array(DEFAULT_MAX_MIME_BYTES + 1), opaque: true };
  const body = { ns: "AirSyncBase", tag: "Body", children: [{ ns: "AirSyncBase", tag: "Type", children: [], value: encodeUtf8("4"), opaque: false }, huge], value: null, opaque: false };
  const data = { ns: "AirSync", tag: "ApplicationData", children: [body], value: null, opaque: false };
  eq(readEmail(data), { read: null, flagged: null, mime: null, truncated: true });
});

test("readEmail : entrée qui n'est pas un élément → tout à null", () => {
  for (const bad of [null, undefined, "x", 42, {}, { children: "x" }]) eq(readEmail(bad), NONE, String(bad));
  eq(readEmail(received([])), NONE, "ApplicationData vide");
});

// ── changeEmail ───────────────────────────────────────────────────────────

/** ApplicationData of a Change as the server receives it (encoded, decoded). */
function sent(data) {
  const doc = decode(encode(syncRequest([{ collectionId: "5", syncKey: "3", commands: [changeCommand("5:1", data)] }])));
  return at(doc, "Collections", "Collection", "Commands", "Change", "ApplicationData");
}

test("changeEmail : lu / non lu", () => {
  const read = sent(changeEmail({ read: true }));
  eq(read.children.length, 1);
  eq([read.children[0].ns, read.children[0].tag, text(read.children[0])], ["Email", "Read", "1"]);
  eq(text(sent(changeEmail({ read: false })), "Email:Read"), "0");
});

test("changeEmail : poser un drapeau (Status 2, FlagType)", () => {
  const data = sent(changeEmail({ flagged: true }));
  const flag = child(data, "Email:Flag");
  assert(flag, "Flag présent");
  eq(flag.children.map((c) => `${c.ns}:${c.tag}`), ["Email:Status", "Email:FlagType"]);
  eq(text(flag, "Email:Status"), "2");
  eq(text(flag, "Email:FlagType"), FLAG_TYPE);
  eq(FLAG_TYPE, "for Follow Up");
});

test("changeEmail : effacer un drapeau → <Flag/> vide", () => {
  const flag = child(sent(changeEmail({ flagged: false })), "Email:Flag");
  eq(flag.children.length, 0);
  eq(flag.value, null);
});

test("changeEmail : les deux, dans l'ordre Read puis Flag", () => {
  const data = sent(changeEmail({ flagged: true, read: false }));
  eq(data.children.map((c) => c.tag), ["Read", "Flag"]);
});

test("changeEmail : propriété absente ou null non envoyée", () => {
  eq(changeEmail({}), []);
  eq(changeEmail(), []);
  eq(changeEmail({ read: null, flagged: undefined }), []);
  eq(changeEmail({ read: true, flagged: null }).length, 1);
});

test("changeEmail : valeur non booléenne refusée", () => {
  for (const bad of ["1", 1, 0, "true", {}, []]) {
    throws(() => changeEmail({ read: bad }), ProtocolError, `read ${JSON.stringify(bad)}`);
    throws(() => changeEmail({ flagged: bad }), ProtocolError, `flagged ${JSON.stringify(bad)}`);
  }
});

test("changeEmail puis readEmail : mêmes états", () => {
  for (const read of [true, false]) {
    for (const flagged of [true, false]) {
      const back = readEmail(received(changeEmail({ read, flagged })));
      eq([back.read, back.flagged], [read, flagged], `${read}/${flagged}`);
    }
  }
});

// ── mailOptions ───────────────────────────────────────────────────────────

/** Options of a Sync request as the server receives them. */
function options(list) {
  const doc = decode(encode(syncRequest([{ collectionId: "5", syncKey: "3", options: list }])));
  return at(doc, "Collections", "Collection", "Options");
}

test("mailOptions : période, MIME pour tous les messages, corps MIME complet", () => {
  const opts = options(mailOptions({ filterType: "3" }));
  eq(opts.children.map((c) => `${c.ns}:${c.tag}`), ["AirSync:FilterType", "AirSync:MIMESupport", "AirSyncBase:BodyPreference"]);
  eq(text(opts, "AirSync:FilterType"), "3");
  eq(text(opts, "AirSync:MIMESupport"), "2");
  const pref = child(opts, "AirSyncBase:BodyPreference");
  eq(pref.children.map((c) => `${c.ns}:${c.tag}`), ["AirSyncBase:Type"], "sans TruncationSize : message entier");
  eq(text(pref, "AirSyncBase:Type"), "4");
});

test("mailOptions : périodes 0 à 5, en texte ou en nombre", () => {
  eq(MAIL_FILTER_TYPES, ["0", "1", "2", "3", "4", "5"]);
  for (let i = 0; i <= 5; i++) {
    eq(text(options(mailOptions({ filterType: String(i) })), "AirSync:FilterType"), String(i));
    eq(text(options(mailOptions({ filterType: i })), "AirSync:FilterType"), String(i));
  }
});

test("mailOptions : autres périodes refusées (6 et 7 : agenda, 8 : tâches)", () => {
  for (const bad of ["6", "7", "8", 6, 8, -1, "-1", "", "03", " 3", 3.5, "3.0", null, undefined, true, {}, ["3"]]) {
    throws(() => mailOptions({ filterType: bad }), ProtocolError, JSON.stringify(bad) ?? String(bad));
  }
  throws(() => mailOptions(), ProtocolError, "sans argument");
});
