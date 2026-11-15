// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Server address tests. A host is checked the way the WHATWG URL parser
 * will read it later: a name whose last label is a number is an IPv4
 * address there ("127.1" is 127.0.0.1), and IPv6 literals have many
 * spellings ("[0::1]" is [::1]).
 */

import { test, assert, eq, throws } from "./harness.mjs";
import { parseServer, ServerAddressError, EAS_PATH } from "../../src/core/server.mjs";

const LOCAL = { allowLocal: true };
const refused = (input, opts, what) => throws(() => parseServer(input, opts), ServerAddressError, what ?? JSON.stringify(input));

test("parseServer : nom seul → https, port par défaut omis", () => {
  eq(EAS_PATH, "/Microsoft-Server-ActiveSync");
  eq(parseServer("mail.example.com"), {
    host: "mail.example.com",
    port: null,
    origin: "https://mail.example.com",
    url: "https://mail.example.com/Microsoft-Server-ActiveSync",
    display: "mail.example.com",
  });
});

test("parseServer : schéma https accepté, quelle que soit la casse", () => {
  eq(parseServer("https://mail.example.com").origin, "https://mail.example.com");
  eq(parseServer("HTTPS://Mail.Example.COM").host, "mail.example.com");
  eq(parseServer("hTtPs://mail.example.com").origin, "https://mail.example.com");
});

test("parseServer : majuscules du nom normalisées", () => {
  const s = parseServer("MAIL.Example.COM:8443");
  eq([s.host, s.origin, s.display], ["mail.example.com", "https://mail.example.com:8443", "mail.example.com:8443"]);
});

test("parseServer : http toujours refusé, même vers la machine locale en test", () => {
  refused("http://mail.example.com");
  refused("http://mail.example.com", LOCAL, "http distant en test");
  refused("http://127.0.0.1:8080", LOCAL, "http local en test");
  refused("HTTP://LOCALHOST", LOCAL);
  const a = parseServer("https://127.0.0.1:8443", LOCAL);
  eq([a.origin, a.url, a.display], ["https://127.0.0.1:8443", "https://127.0.0.1:8443/Microsoft-Server-ActiveSync", "127.0.0.1:8443"]);
  eq(parseServer("[::1]:5000", LOCAL).origin, "https://[::1]:5000");
});

test("parseServer : autres schémas refusés", () => {
  for (const s of ["ftp://mail.example.com", "file://mail.example.com", "ws://mail.example.com", "wss://mail.example.com", "javascript://mail.example.com", "x-https://mail.example.com", "httpss://mail.example.com"]) {
    refused(s);
    refused(s, LOCAL);
  }
});

test("parseServer : identifiant ou mot de passe dans l'adresse refusés", () => {
  for (const s of ["user@mail.example.com", "https://user:pass@mail.example.com", "https://@mail.example.com", "user:pass@mail.example.com/", "https://a@b@mail.example.com", "mail.example.com@evil.example"]) {
    const e = refused(s);
    assert(e.message.includes("identifiant"), `message explicite attendu : ${e.message}`);
  }
  // "@" after the authority belongs to the path or the query: ignored with them.
  eq(parseServer("mail.example.com/x@y").host, "mail.example.com");
  eq(parseServer("mail.example.com?u=a@b").host, "mail.example.com");
});

test("parseServer : jokers refusés", () => {
  for (const s of ["*", "*.example.com", "https://*.example.com", "mail.*.com", "*:443", "mail.example.*"]) refused(s);
});

test("parseServer : hôte local refusé hors tests", () => {
  for (const s of ["localhost", "LOCALHOST", "localhost.", "https://localhost:443", "127.0.0.1", "127.1.2.3", "127.255.255.255", "[::1]", "[::1]:8443"]) {
    refused(s);
  }
  eq(parseServer("https://localhost:8443", LOCAL).origin, "https://localhost:8443", "https local admis en test");
  eq(parseServer("127.0.0.1", LOCAL).origin, "https://127.0.0.1");
});

test("parseServer : formes détournées de l'adresse locale refusées", () => {
  for (const s of [
    "127.1", "127.0.1", "0x7f.0.0.1", "0x7F.1", "0177.0.0.1", "127.000.000.001", "0.0.0.0", "0.1.2.3",
    "mail.localhost", "a.b.localhost", "LOCALHOST.localhost.",
    "[0:0:0:0:0:0:0:1]", "[::0:1]", "[0::1]", "[::0001]", "[::]", "[::0]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]",
    "[::ffff:7f00:0001]", "[::127.0.0.1]", "[::ffff:0.0.0.0]",
  ]) {
    refused(s);
  }
});

test("parseServer : nom terminé par un nombre admis seulement en IPv4 canonique", () => {
  for (const s of ["256.1.1.1", "1.2.3", "1.2.3.4.5", "192.168.1.300", "192.168.001.1", "example.123", "example.0x1", "mail.example.0"]) refused(s);
  eq(parseServer("192.168.1.10").host, "192.168.1.10");
  eq(parseServer("10.0.0.1:8443").origin, "https://10.0.0.1:8443");
  eq(parseServer("mail1.example2.com3").host, "mail1.example2.com3", "chiffres dans des étiquettes non numériques");
  eq(parseServer("8.example.com").host, "8.example.com");
});

test("parseServer : ports", () => {
  const p = parseServer("mail.example.com:8443");
  eq([p.port, p.origin, p.display], [8443, "https://mail.example.com:8443", "mail.example.com:8443"]);
  const d = parseServer("mail.example.com:443");
  eq([d.port, d.origin, d.display], [443, "https://mail.example.com", "mail.example.com"], "443 omis");
  eq(parseServer("mail.example.com:1").port, 1);
  eq(parseServer("mail.example.com:65535").port, 65535);
  eq(parseServer("mail.example.com:08443").origin, "https://mail.example.com:8443", "zéro de tête normalisé");
  for (const s of ["mail.example.com:0", "mail.example.com:65536", "mail.example.com:99999999999999999999", "mail.example.com:", "mail.example.com:abc", "mail.example.com:-1", "mail.example.com:443:1", "mail.example.com:+443", "mail.example.com:4 43"]) {
    refused(s);
  }
});

test("parseServer : IPv6 littéral", () => {
  const a = parseServer("[2001:db8::1]");
  eq([a.host, a.port, a.origin], ["[2001:db8::1]", null, "https://[2001:db8::1]"]);
  const b = parseServer("https://[2001:DB8::1]:8443/owa");
  eq([b.host, b.port, b.origin], ["[2001:db8::1]", 8443, "https://[2001:db8::1]:8443"]);
  // Canonical form (RFC 5952, as Thunderbird writes request URLs): the certificate check matches by origin.
  eq(parseServer("[2001:db8:0:0:0:0:2:1]").host, "[2001:db8::2:1]");
  eq(parseServer("[2001:0DB8:0000::0001]").origin, "https://[2001:db8::1]");
  eq(parseServer("[2001:db8:0:0:1:0:0:1]").host, "[2001:db8::1:0:0:1]", "premier plus long bloc de zéros");
  eq(parseServer("[1:0:2:3:4:5:6:7]").host, "[1:0:2:3:4:5:6:7]", "un seul groupe nul n'est pas abrégé");
  eq(parseServer("[::ffff:192.0.2.1]").host, "[::ffff:c000:201]", "IPv4 projetée, non locale, écrite en hexadécimal");
  for (const alias of ["localhost.localdomain", "localhost4.localdomain4", "localhost6", "ip6-localhost", "ip6-loopback"]) refused(alias);
  for (const s of ["2001:db8::1", "[2001:db8::1", "2001:db8::1]", "[zz::1]", "[1:2:3:4:5:6:7:8:9]", "[1::2::3]", "[:1]", "[1:]", "[12345::1]", "[]", "[::ffff:1.2.3.256]", "[2001:db8::1]:0"]) {
    refused(s);
  }
});

test("parseServer : point final retiré, étiquettes vides refusées", () => {
  eq(parseServer("mail.example.com.").host, "mail.example.com");
  eq(parseServer("mail.example.com.:8443").origin, "https://mail.example.com:8443");
  for (const s of ["mail.example.com..", ".example.com", "mail..example.com", ".", ".."]) refused(s);
});

test("parseServer : chemin, requête et fragment ignorés", () => {
  for (const s of ["https://mail.example.com/owa/?x=1#y", "mail.example.com/Microsoft-Server-ActiveSync", "mail.example.com?x", "mail.example.com#frag", "mail.example.com/"]) {
    eq(parseServer(s).url, "https://mail.example.com/Microsoft-Server-ActiveSync", s);
  }
});

test("parseServer : espaces refusés à l'intérieur, tolérés autour", () => {
  eq(parseServer("  mail.example.com \t\n").host, "mail.example.com");
  for (const s of ["mail example.com", "mail.example.com /x", "mail.exa mple.com", "mail.example.com\u2028x", "https:// mail.example.com"]) refused(s);
  for (const s of ["", "   ", null, undefined]) refused(s);
});

test("parseServer : noms invalides refusés", () => {
  for (const s of [
    "-mail.example.com", "mail-.example.com", "mail_x.example.com", "example", "mail.example.com\\evil.com",
    "https:/mail.example.com", "http:mail.example.com", "//mail.example.com", "https://", "mail.ex%61mple.com",
    `${"a".repeat(64)}.example.com`, `${"a.".repeat(126)}com`, "mail.example.com\u0000", "[mail.example.com]",
  ]) {
    refused(s);
  }
  eq(parseServer(`${"a".repeat(63)}.example.com`).host.length, 63 + 12, "étiquette de 63");
  const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.com`; // 247 characters
  eq(parseServer(long).host, long, "nom de 247 caractères");
});

test("parseServer : nom non ASCII refusé sans URL (shell jsc)", () => {
  if (typeof URL === "function") return; // Thunderbird converts it to punycode instead
  for (const s of ["exämple.com", "mail.exämple.com:8443", "ｍａｉｌ.example.com", "１２７.０.０.１"]) refused(s);
});
