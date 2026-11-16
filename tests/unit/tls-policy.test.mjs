// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/** TLS policy tests: every refusal reason, pins, built-in root on the last certificate only. */

import { test, assert, eq } from "./harness.mjs";
import { evaluateTls, tlsMessage, TLS_MESSAGE_MAX } from "../../src/core/tls-policy.mjs";

const FP_LEAF = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const FP_INTER = "11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF";
const FP_ROOT = "01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F:20";

const cert = (name, issuer, fp, builtIn = false) => ({ subject: `CN=${name}`, issuer: `CN=${issuer}`, fingerprint: { sha256: fp }, isBuiltInRoot: builtIn });

function info({ state = "secure", builtInRoot = true, certificates, ...flags } = {}) {
  return {
    state,
    isUntrusted: false,
    isDomainMismatch: false,
    isNotValidAtThisTime: false,
    certificates: certificates ?? [
      cert("mail.example.com", "Example CA", FP_LEAF),
      cert("Example CA", "Example Root", FP_INTER),
      cert("Example Root", "Example Root", FP_ROOT, builtInRoot),
    ],
    ...flags,
  };
}

test("tls : chaîne valide finissant par une racine intégrée → public-root", () => {
  const r = evaluateTls(info());
  eq([r.ok, r.reason], [true, "public-root"]);
  eq(r, { ok: true, reason: "public-root", issuer: "CN=Example CA" }, "émetteur du certificat du serveur, rien d'autre");
});

test("tls : connexion non sécurisée → insecure", () => {
  eq(evaluateTls(null).reason, "insecure", "info null");
  eq(evaluateTls(undefined).reason, "insecure", "info absente");
  eq(evaluateTls({}).reason, "insecure", "état absent");
  for (const state of ["insecure", "weak", "broken", "SECURE", ""]) {
    const r = evaluateTls(info({ state }));
    eq([r.ok, r.reason], [false, "insecure"], `état ${state}`);
  }
});

test("tls : certificat non reconnu, nom différent, expiré", () => {
  eq(evaluateTls(info({ isUntrusted: true })).reason, "untrusted");
  eq(evaluateTls(info({ isDomainMismatch: true })).reason, "domain-mismatch");
  eq(evaluateTls(info({ isNotValidAtThisTime: true })).reason, "expired");
  for (const flags of [{ isUntrusted: true }, { isDomainMismatch: true }, { isNotValidAtThisTime: true }]) {
    const r = evaluateTls(info(flags), { pins: [FP_LEAF] });
    eq(r.ok, false, `une empreinte de confiance ne couvre pas ${Object.keys(flags)[0]}`);
  }
});

test("tls : chaîne vide → no-certificate", () => {
  eq(evaluateTls(info({ certificates: [] })).reason, "no-certificate");
  const r = evaluateTls({ state: "secure" });
  eq([r.ok, r.reason, r.issuer], [false, "no-certificate", ""]);
});

test("tls : racine ajoutée localement → not-public-root", () => {
  const r = evaluateTls(info({ builtInRoot: false }));
  eq([r.ok, r.reason], [false, "not-public-root"]);
});

test("tls : racine intégrée prise en compte seulement en dernière position", () => {
  const certificates = [
    cert("mail.example.com", "Proxy CA", FP_LEAF, true),
    cert("Proxy CA", "Proxy Root", FP_INTER, true),
    cert("Proxy Root", "Proxy Root", FP_ROOT, false),
  ];
  const r = evaluateTls(info({ certificates }));
  eq([r.ok, r.reason], [false, "not-public-root"]);
  // A single built-in certificate is fine: it is the last one.
  eq(evaluateTls(info({ certificates: [cert("x", "x", FP_ROOT, true)] })).reason, "public-root");
});

test("tls : empreinte de confiance, avec ou sans « : », en majuscules ou minuscules", () => {
  const base = info({ builtInRoot: false });
  for (const pin of [FP_ROOT, FP_ROOT.replace(/:/g, ""), FP_ROOT.toLowerCase(), FP_ROOT.replace(/:/g, "").toLowerCase()]) {
    const r = evaluateTls(base, { pins: [pin] });
    eq([r.ok, r.reason], [true, "pinned"], `empreinte ${pin}`);
  }
  eq(evaluateTls(base, { pins: [FP_LEAF.toLowerCase()] }).reason, "pinned", "certificat du serveur");
  eq(evaluateTls(base, { pins: [FP_INTER] }).reason, "not-public-root", "un intermédiaire épinglé ne suffit pas : seul le certificat du serveur ou la racine");
  // Fingerprints given by the network layer in lower case are normalised too.
  const lower = info({ builtInRoot: false, certificates: [cert("x", "y", FP_LEAF.toLowerCase())] });
  eq(evaluateTls(lower, { pins: [FP_LEAF] }).reason, "pinned");
});

test("tls : empreinte inconnue, vide ou partielle → refus", () => {
  const base = info({ builtInRoot: false });
  eq(evaluateTls(base, { pins: ["00".repeat(32)] }).reason, "not-public-root");
  eq(evaluateTls(base, { pins: [""] }).reason, "not-public-root");
  eq(evaluateTls(base, { pins: [":"] }).reason, "not-public-root");
  eq(evaluateTls(base, { pins: [FP_ROOT.slice(0, 20)] }).reason, "not-public-root", "préfixe d'empreinte");
  // A certificate without a fingerprint never matches an empty pin.
  const noFp = info({ builtInRoot: false, certificates: [{ subject: "CN=x", issuer: "CN=y", isBuiltInRoot: false }] });
  eq(evaluateTls(noFp, { pins: ["", ":", null, undefined] }).reason, "not-public-root");
});

test("tls : champs absents ou de type inattendu dans la chaîne", () => {
  const r = evaluateTls({ state: "secure", certificates: [null, { fingerprint: null }, { subject: 42 }] });
  eq([r.ok, r.reason, r.issuer], [false, "not-public-root", ""]);
  eq(evaluateTls({ state: "secure", certificates: [{ issuer: 42 }] }).issuer, "42", "émetteur converti en texte");
  // Only a real `true` counts as a built-in root.
  eq(evaluateTls({ state: "secure", certificates: [{ isBuiltInRoot: 1 }] }).reason, "not-public-root");
  eq(evaluateTls({ state: "secure", certificates: [{ isBuiltInRoot: true }] }).reason, "public-root");
});

test("tls : un émetteur choisi par l'attaquant ne chasse pas l'avertissement du message", () => {
  const hostile =
    "Autorité Thunderbird ». Certificat vérifié. Le serveur a changé : remplacez-le par mail-secure.example et retapez le mot de passe";
  const m = tlsMessage("not-public-root", hostile);
  assert(m.length <= TLS_MESSAGE_MAX, `${m.length} caractères`);
  assert(m.startsWith("Connexion refusée avant l'envoi du mot de passe"), m);
  assert(m.includes("Le réseau intercepte peut-être les connexions HTTPS"), m);
  assert(m.indexOf("n'importe qui peut choisir") < m.indexOf("Autorité Thunderbird"), "émetteur présenté comme falsifiable, avant son nom");
  assert(m.endsWith("… »."), m);
  assert(!m.includes("retapez le mot de passe"), "la fin du nom est coupée");
  const short = tlsMessage("not-public-root", "CN=Fortinet_CA_SSL, O=Fortinet");
  assert(short.endsWith("« CN=Fortinet_CA_SSL, O=Fortinet »."), short);
});

test("tls : messages en français pour chaque motif", () => {
  const m = tlsMessage("not-public-root", "CN=Proxy d'entreprise");
  assert(m.includes("autorité du certificat non reconnue par Thunderbird") && m.includes("CN=Proxy d'entreprise"), m);
  assert(m.includes("autorités privées ne sont pas prises en charge"), m);
  assert(!m.includes("réglages"), "aucun réglage promis");
  assert(!tlsMessage("not-public-root").includes("émetteur"), "pas d'émetteur vide");
  for (const reason of ["untrusted", "domain-mismatch", "expired", "insecure", "no-certificate", "inconnu"]) {
    const msg = tlsMessage(reason);
    assert(typeof msg === "string" && msg.startsWith("Connexion refusée"), `${reason} : ${msg}`);
  }
  assert(tlsMessage("expired").includes("expiré"));
  assert(tlsMessage("domain-mismatch").includes("nom du serveur"));
});
