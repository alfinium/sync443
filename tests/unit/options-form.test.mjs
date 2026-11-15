// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * src/options/form.mjs: validation of the mailbox form and the texts of the
 * settings page. Dates are built in local time, as the page shows them.
 * Unusual characters are written as \u escapes, never literally.
 */

import { test, eq, assert } from "./harness.mjs";
import {
  validateForm,
  formValues,
  emailError,
  permissionPattern,
  statusView,
  formatTime,
  logText,
  debugText,
  kindsLabel,
  frequencyLabel,
  periodLabel,
  FREQUENCIES,
  PERIODS,
  KINDS,
  DEFAULTS,
} from "../../src/options/form.mjs";
import { SYNC_KINDS } from "../../src/sync/store.mjs";

const values = (over = {}) => ({
  email: "alice@example.com",
  username: "",
  password: "s3cret pass",
  name: "Travail",
  server: "mail.example.com",
  syncMinutes: "0",
  filterType: "5",
  sync: { mail: true, calendar: false, contacts: false, tasks: false },
  ...over,
});

const existing = (over = {}) => ({
  id: "0123456789ab",
  email: "alice@example.com",
  username: "",
  name: "Travail",
  origin: "https://mail.example.com",
  server: "mail.example.com",
  syncMinutes: 15,
  filterType: "3",
  sync: { mail: true, calendar: true, contacts: false, tasks: false },
  ...over,
});

const fields = (r) => r.errors.map((e) => e.field);

test("formulaire : nouvelle boîte valable, requête et autorisation d'hôte", () => {
  const r = validateForm(values({ email: "  alice@example.com ", server: " https://Mail.Example.com/Microsoft-Server-ActiveSync " }));
  eq(r.ok, true);
  eq(r.errors, []);
  eq(r.passwordRequired, true);
  eq(r.permission, "https://mail.example.com/*");
  eq(r.request, {
    mailbox: {
      id: null,
      email: "alice@example.com",
      username: "",
      name: "Travail",
      server: "mail.example.com",
      syncMinutes: 0,
      filterType: "5",
      sync: { mail: true, calendar: false, contacts: false, tasks: false },
    },
    password: "s3cret pass",
  });
});

test("formulaire : port et IPv6, l'autorisation couvre l'hôte (les motifs n'ont pas de port)", () => {
  const a = validateForm(values({ server: "mail.example.com:8443" }));
  eq(a.request.mailbox.server, "mail.example.com:8443");
  eq(a.permission, "https://mail.example.com/*");
  const b = validateForm(values({ server: "[2001:DB8:0:0::1]:443" }));
  eq(b.request.mailbox.server, "[2001:db8::1]");
  eq(b.permission, "https://[2001:db8::1]/*");
  eq(permissionPattern("exemple.fr"), "https://exemple.fr/*");
});

test("formulaire : serveur refusé avec le message de parseServer", () => {
  for (const server of ["", "http://mail.example.com", "user:pw@mail.example.com", "localhost", "127.0.0.1", "*.example.com", "mail.example.com:70000"]) {
    const r = validateForm(values({ server }));
    eq(r.ok, false, server);
    eq(fields(r), ["server"], server);
    assert(r.errors[0].message.length > 5, server);
    eq(r.request, null);
    eq(r.permission, null);
  }
});

test("formulaire : adresse e-mail", () => {
  for (const email of ["", "alice", "alice@", "@example.com", "alice@example", "a b@example.com", "alice@@example.com", "alice@example..com", "alice\u202e@example.com", "alice\u200b@example.com", `${"a".repeat(250)}@example.com`]) {
    eq(fields(validateForm(values({ email }))), ["email"], JSON.stringify(email));
  }
  eq(emailError("prénom.nom@exemple.fr"), null);
  eq(emailError(""), "Indiquez l'adresse e-mail.");
});

test("formulaire : mot de passe obligatoire pour une nouvelle boîte, sans caractère de contrôle", () => {
  const r = validateForm(values({ password: "" }));
  eq(fields(r), ["password"]);
  eq(r.errors[0].message, "Indiquez le mot de passe.");
  eq(fields(validateForm(values({ password: "a\u0000b" }))), ["password"]);
  eq(fields(validateForm(values({ password: "a\nb" }))), ["password"]);
  eq(fields(validateForm(values({ password: "\ud800" }))), ["password"]);
  eq(fields(validateForm(values({ password: "x".repeat(1025) }))), ["password"]);
  // Spaces are kept: they may be part of the password.
  eq(validateForm(values({ password: " a b " })).request.password, " a b ");
});

test("modification : mot de passe vide gardé si l'origine et l'identifiant ne changent pas", () => {
  const r = validateForm(values({ password: "" }), existing());
  eq(r.ok, true);
  eq(r.passwordRequired, false);
  eq(r.request.password, null);
  eq(r.request.mailbox.id, "0123456789ab");
  // Same origin written differently, address in other case.
  const same = validateForm(values({ password: "", server: "https://MAIL.example.com:443/", email: "Alice@Example.com" }), existing());
  eq(same.ok, true);
  // A new password may be given anyway.
  eq(validateForm(values({ password: "neuf" }), existing()).request.password, "neuf");
});

test("modification : changer de serveur ou d'identifiant oblige à retaper le mot de passe", () => {
  for (const over of [{ server: "other.example.com" }, { server: "mail.example.com:8443" }, { username: "EXEMPLE\\alice" }, { email: "bob@example.com" }]) {
    const r = validateForm(values({ password: "", ...over }), existing());
    eq(r.passwordRequired, true, JSON.stringify(over));
    eq(fields(r), ["password"], JSON.stringify(over));
    eq(r.errors[0].message, "Le serveur ou l'identifiant a changé : retapez le mot de passe.");
    eq(validateForm(values({ password: "retapé", ...over }), existing()).ok, true);
  }
  // Explicit sign-in name equal to the old address: same sign-in.
  eq(validateForm(values({ password: "", username: "alice@example.com" }), existing()).ok, true);
});

test("formulaire : identifiant facultatif, sans deux-points ni caractère caché", () => {
  eq(validateForm(values({ username: " EXEMPLE\\alice " })).request.mailbox.username, "EXEMPLE\\alice");
  eq(fields(validateForm(values({ username: "alice:x" }))), ["username"]);
  eq(fields(validateForm(values({ username: "al\u202eice" }))), ["username"]);
  eq(fields(validateForm(values({ username: "a\tb" }))), ["username"]);
  eq(fields(validateForm(values({ username: "u".repeat(257) }))), ["username"]);
});

test("formulaire : nom nettoyé, l'adresse par défaut", () => {
  eq(validateForm(values({ name: "  " })).request.mailbox.name, "alice@example.com");
  eq(validateForm(values({ name: "Tra\u202evail\u200b\n2" })).request.mailbox.name, "Travail 2");
  eq(fields(validateForm(values({ name: "n".repeat(257) }))), ["name"]);
});

test("formulaire : fréquence et période parmi les choix proposés", () => {
  for (const [m] of FREQUENCIES) eq(validateForm(values({ syncMinutes: String(m) })).request.mailbox.syncMinutes, m);
  eq(validateForm(values({ syncMinutes: 30 })).request.mailbox.syncMinutes, 30);
  for (const syncMinutes of ["", "2", "abc", "-1", "1.5", null, undefined]) {
    eq(fields(validateForm(values({ syncMinutes }))), ["syncMinutes"], String(syncMinutes));
  }
  for (const [f] of PERIODS) eq(validateForm(values({ filterType: f })).request.mailbox.filterType, f);
  for (const filterType of ["6", "7", "8", "", 5, "05"]) eq(fields(validateForm(values({ filterType }))), ["filterType"], String(filterType));
});

test("formulaire : au moins un élément à synchroniser, booléens seulement", () => {
  eq(fields(validateForm(values({ sync: { mail: false, calendar: false, contacts: false, tasks: false } }))), ["sync"]);
  eq(fields(validateForm(values({ sync: { mail: "true" } }))), ["sync"]);
  eq(fields(validateForm(values({ sync: undefined }))), ["sync"]);
  const r = validateForm(values({ sync: { calendar: true, extra: true } }));
  eq(r.request.mailbox.sync, { mail: false, calendar: true, contacts: false, tasks: false });
});

test("formulaire : toutes les erreurs à la fois, dans l'ordre du formulaire", () => {
  const r = validateForm({ email: "x", password: "", server: "http://a.b", syncMinutes: "9", filterType: "9", sync: {} });
  eq(fields(r), ["email", "server", "password", "syncMinutes", "filterType", "sync"]);
});

test("formValues : valeurs par défaut, puis celles d'une boîte", () => {
  eq(formValues(), {
    email: "",
    username: "",
    password: "",
    name: "",
    server: "",
    syncMinutes: "0",
    filterType: DEFAULTS.filterType,
    sync: { mail: true, calendar: true, contacts: true, tasks: true },
  });
  eq(formValues(existing()), {
    email: "alice@example.com",
    username: "",
    password: "",
    name: "Travail",
    server: "mail.example.com",
    syncMinutes: "15",
    filterType: "3",
    sync: { mail: true, calendar: true, contacts: false, tasks: false },
  });
  eq(formValues(existing({ server: undefined, origin: "https://mail.example.com:8443", syncMinutes: 7, filterType: "8" })).server, "mail.example.com:8443");
  eq(formValues(existing({ syncMinutes: 7 })).syncMinutes, "0");
  eq(formValues(existing({ filterType: "8" })).filterType, "5");
  // The defaults are a valid mailbox once filled in.
  eq(validateForm({ ...formValues(), email: "a@example.com", password: "p", server: "mail.example.com" }).ok, true);
});

test("choix : libellés, « bientôt » pour agenda, contacts et tâches", () => {
  eq(KINDS.map((k) => k.key), [...SYNC_KINDS]);
  eq(KINDS.filter((k) => k.soon).map((k) => k.key), ["calendar", "contacts", "tasks"]);
  eq(kindsLabel({ mail: true, calendar: true, contacts: false, tasks: true }), "Courrier, Agenda (bientôt), Tâches (bientôt)");
  eq(kindsLabel({}), "Rien");
  eq(frequencyLabel(0), "Dès réception");
  eq(frequencyLabel(60), "Toutes les heures");
  eq(frequencyLabel(7), "Toutes les 7 minutes");
  eq(periodLabel("0"), "Tout");
  eq(periodLabel("2"), "3 jours");
  eq(periodLabel("x"), "Inconnue");
});

test("formatTime : heure aujourd'hui, date cette année, année sinon", () => {
  const now = new Date(2026, 10, 15, 16, 30).getTime();
  eq(formatTime(new Date(2026, 10, 15, 9, 5).getTime(), now), "09:05");
  eq(formatTime(new Date(2026, 0, 3, 23, 59).getTime(), now), "03/01 à 23:59");
  eq(formatTime(new Date(2025, 11, 31, 8, 0).getTime(), now), "31/12/2025 à 08:00");
  eq(formatTime(NaN, now), "");
});

test("état d'une boîte : bloquée, en cours, erreur, synchronisée, jamais", () => {
  const now = new Date(2026, 10, 15, 16, 30).getTime();
  const at = (h, m) => new Date(2026, 10, 15, h, m).getTime();
  eq(statusView({ blocked: { code: "MASS_DELETE", message: "x" }, pendingDeletes: 120 }, now), {
    tone: "blocked",
    text: "Synchronisation suspendue : le serveur a supprimé 120 messages d'un coup. Ces suppressions ne seront appliquées qu'après votre confirmation.",
    massDelete: 120,
  });
  eq(statusView({ blocked: { code: "MASS_DELETE" } }, now).massDelete, 0);
  eq(statusView({ blocked: { code: "AUTH", message: "Identifiant ou mot de passe refusé par le serveur." } }, now), {
    tone: "blocked",
    text: "Arrêtée : Identifiant ou mot de passe refusé par le serveur. Rien ne sera tenté automatiquement : cliquez sur « Synchroniser » pour reprendre.",
    massDelete: null,
  });
  eq(statusView({ blocked: { code: "X" } }, now).text.startsWith("Arrêtée : erreur grave. "), true);
  eq(statusView({ running: true, lastSuccessAt: at(9, 0) }, now), { tone: "running", text: "Synchronisation en cours…", massDelete: null });
  eq(statusView({ lastError: { code: "NETWORK", message: "Serveur injoignable." }, nextAttemptAt: at(16, 45) }, now), {
    tone: "error",
    text: "Erreur : Serveur injoignable. Nouvel essai à 16:45.",
    massDelete: null,
  });
  eq(statusView({ lastError: { code: "TLS", message: "Certificat refusé" }, nextAttemptAt: at(10, 0) }, now).text, "Erreur : Certificat refusé.");
  eq(statusView({ lastSuccessAt: at(16, 2) }, now), { tone: "ok", text: "Synchronisée à 16:02.", massDelete: null });
  eq(statusView({ lastSuccessAt: new Date(2026, 9, 1, 8, 0).getTime() }, now).text, "Synchronisée le 01/10 à 08:00.");
  eq(statusView({}, now), { tone: "idle", text: "Pas encore synchronisée.", massDelete: null });
  eq(statusView(null, now).tone, "idle");
  eq(statusView("bloquée", now).tone, "idle");
});

test("état d'une boîte : texte du serveur réduit à une ligne propre", () => {
  const v = statusView({ lastError: { code: "HTTP", message: "a\u202eb\nc\u0000d" + "e".repeat(1000) } }, 0);
  assert(!/[\u202e\n\u0000]/.test(v.text), v.text);
  assert(v.text.length < 320, String(v.text.length));
});

test("journal : du plus récent au plus ancien, détails en retrait", () => {
  const t1 = new Date(2026, 10, 15, 9, 5, 7).getTime();
  const t2 = new Date(2026, 10, 15, 9, 6, 0).getTime();
  eq(
    logText([
      { t: t1, level: "info", msg: "Démarrage." },
      { t: t2, level: "debug", msg: "→ Sync", details: "Status 1\nSyncKey 2" },
      { t: "x", level: "info", msg: "ignorée" },
      null,
      { t: t2, level: "error", msg: "a\u202eb" },
    ]),
    [
      "2026-11-15 09:06:00  erreur    ab",
      "2026-11-15 09:06:00  débogage  → Sync",
      "      Status 1",
      "      SyncKey 2",
      "2026-11-15 09:05:07  info      Démarrage.",
    ].join("\n"),
  );
  eq(logText([]), "Le journal est vide.");
  eq(logText(null), "Le journal est vide.");
});

test("débogage : texte de l'échéance", () => {
  const now = new Date(2026, 10, 15, 14, 0).getTime();
  eq(debugText(now + 3_600_000, now), "Actif jusqu'à 15:00.");
  eq(debugText(now, now), "");
  eq(debugText(0, now), "");
  eq(debugText(NaN, now), "");
});
