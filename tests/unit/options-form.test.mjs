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
  CALENDAR_PERIODS,
  TASK_FILTERS,
  KINDS,
  KIND_FIELDS,
  DEFAULTS,
  discardConfirm,
  uncheckConfirm,
  moveConfirm,
  FIELD_ORDER,
  failedText,
  shown,
} from "../../src/options/form.mjs";
import { SYNC_KINDS } from "../../src/sync/store.mjs";
import { withLanguage, LOCALES } from "./i18n-fake.mjs";

const values = (over = {}) => ({
  email: "alice@example.com",
  username: "",
  password: "s3cret pass",
  name: "Travail",
  server: "mail.example.com",
  syncMinutes: "0",
  filterType: "5",
  calendarPeriod: "7",
  taskFilter: "0",
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
  eq("passwordRequired" in r, false, "interne");
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
      calendarPeriod: "7",
      taskFilter: "0",
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
  eq(fields(r), ["email", "password", "server", "syncMinutes", "filterType", "sync"]);
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
    calendarPeriod: "7",
    taskFilter: "0",
    sync: { mail: true, calendar: true, contacts: true, tasks: true },
  });
  // existing(): a mailbox saved before calendar and tasks were synchronised, without the two fields.
  eq(formValues(existing()), {
    email: "alice@example.com",
    username: "",
    password: "",
    name: "Travail",
    server: "mail.example.com",
    syncMinutes: "15",
    filterType: "3",
    calendarPeriod: "7",
    taskFilter: "0",
    sync: { mail: true, calendar: true, contacts: false, tasks: false },
  });
  eq(formValues(existing({ syncMinutes: 7 })).syncMinutes, "0");
  eq(formValues(existing({ filterType: "8" })).filterType, "5");
  // The defaults are a valid mailbox once filled in.
  eq(validateForm({ ...formValues(), email: "a@example.com", password: "p", server: "mail.example.com" }).ok, true);
});

test("choix : libellés, « bientôt » pour les contacts seulement", () => {
  eq(KINDS.map((k) => k.key), [...SYNC_KINDS]);
  eq(KINDS.filter((k) => k.soon).map((k) => k.key), ["contacts"]);
  eq(kindsLabel({ mail: true, calendar: true, contacts: false, tasks: true }), "Courrier, Agenda, Tâches");
  eq(kindsLabel({ mail: true, calendar: true, contacts: true, tasks: true }), "Courrier, Agenda, Contacts (bientôt), Tâches");
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
    text: "Synchronisation suspendue : le serveur a supprimé 120 éléments d'un coup (messages, événements ou tâches). Ces suppressions ne seront appliquées qu'après votre confirmation ; vous pouvez aussi garder les copies locales.",
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

test("suppressions en masse : garder les copies locales est proposé et expliqué", () => {
  const v = statusView({ blocked: { code: "MASS_DELETE" }, pendingDeletes: 3 }, 0);
  eq(v.massDelete, 3, "boutons « Confirmer les suppressions » et « Garder les copies locales » montrés");
  assert(v.text.endsWith("vous pouvez aussi garder les copies locales."), v.text);
  eq(statusView({ blocked: { code: "AUTH", message: "x" } }, 0).massDelete, null, "pas pour un autre blocage");
  assert(discardConfirm().startsWith("Les suppressions faites sur le serveur ne seront pas appliquées"), discardConfirm());
  assert(discardConfirm().includes("resynchronisés") && discardConfirm().includes("sans synchronisation"), discardConfirm());
});

test("mass deletions: the status line and the question also hold for events and tasks, in the ten languages", async () => {
  // The held deletions may be messages, events or tasks: no language may speak of messages alone.
  const WORDS = {
    en: ["events", "tasks"], fr: ["événements", "tâches"], de: ["Termine", "Aufgaben"], es_ES: ["eventos", "tareas"], it: ["eventi", "attività"],
    pt_BR: ["eventos", "tarefas"], pl: ["wydarze", "zada"], cs: ["událost", "úkol"], ru: ["событи", "задач"], ja: ["予定", "タスク"],
  };
  eq(Object.keys(WORDS).sort(), [...LOCALES].sort());
  for (const lang of LOCALES) {
    await withLanguage(lang, () => {
      const counted = statusView({ blocked: { code: "MASS_DELETE" }, pendingDeletes: 75 }, 0).text;
      const many = statusView({ blocked: { code: "MASS_DELETE" } }, 0).text;
      assert(counted.includes("75"), `${lang}: the number is shown`);
      for (const text of [counted, many, discardConfirm()]) for (const word of WORDS[lang]) assert(text.includes(word), `${lang}: “${word}” missing from “${text}”`);
    });
  }
  assert(discardConfirm().includes("ne sont plus liés au serveur"), "what becomes of the events and tasks kept");
});

test("calendar or tasks unchecked: a question before saving (what leaves Thunderbird, nothing on the server, unsent changes lost)", async () => {
  const before = (sync) => existing({ sync: { mail: true, contacts: false, calendar: false, tasks: false, ...sync } });
  const now = (sync) => ({ mail: true, contacts: false, calendar: false, tasks: false, ...sync });
  const lost = " Les modifications pas encore envoyées au serveur sont perdues.";
  eq(uncheckConfirm(before({ calendar: true, tasks: true }), now({ tasks: true }), "Travail"), `Ne plus synchroniser l'agenda de « Travail » ? Ses événements seront retirés de Thunderbird. Rien n'est supprimé sur le serveur.${lost}`);
  eq(uncheckConfirm(before({ calendar: true, tasks: true }), now({ calendar: true }), "Travail"), `Ne plus synchroniser les tâches de « Travail » ? Ses tâches seront retirées de Thunderbird. Rien n'est supprimé sur le serveur.${lost}`);
  eq(
    uncheckConfirm(before({ calendar: true, tasks: true }), now(), "Travail"),
    `Ne plus synchroniser l'agenda ni les tâches de « Travail » ? Ses agendas seront retirés de Thunderbird, avec leurs événements et leurs tâches. Rien n'est supprimé sur le serveur.${lost}`,
  );
  // Nothing to ask: a new mailbox, nothing unchecked, an item checked, or an item that was not synchronised before.
  eq(uncheckConfirm(null, now(), "Travail"), "");
  eq(uncheckConfirm(before({ calendar: true, tasks: true }), now({ calendar: true, tasks: true }), "Travail"), "");
  eq(uncheckConfirm(before(), now({ calendar: true, tasks: true }), "Travail"), "");
  eq(uncheckConfirm(before({ tasks: true }), now({ calendar: false, tasks: true }), "Travail"), "");
  eq(uncheckConfirm(before({ calendar: true }), { ...now({ calendar: true }), mail: false }, "Travail"), "", "unchecking mail removes nothing");
  eq(uncheckConfirm(before({ calendar: "true" }), now(), "Travail"), "", "only a real boolean");
  // The name is shown as text, cleaned; every language names it and says that the server keeps everything.
  const odd = `Tra${String.fromCharCode(0x202e)}vail${String.fromCharCode(10)}B`;
  const cleaned = uncheckConfirm(before({ calendar: true }), now(), odd);
  assert(cleaned.startsWith("Ne plus synchroniser l'agenda de « Travail B » ?"), `the name is cleaned, on one line: ${cleaned}`);
  const SERVER = { en: "server", fr: "serveur", de: "Server", es_ES: "servidor", it: "server", pt_BR: "servidor", pl: "serwerze", cs: "serveru", ru: "сервере", ja: "サーバー" };
  for (const lang of LOCALES) {
    await withLanguage(lang, () => {
      const texts = [
        uncheckConfirm(before({ calendar: true, tasks: true }), now({ tasks: true }), "Boîte 1"),
        uncheckConfirm(before({ calendar: true, tasks: true }), now({ calendar: true }), "Boîte 1"),
        uncheckConfirm(before({ calendar: true, tasks: true }), now(), "Boîte 1"),
      ];
      eq(new Set(texts).size, 3, `${lang}: three different questions`);
      for (const text of texts) assert(text.includes("Boîte 1") && text.includes("Thunderbird") && text.includes(SERVER[lang]), `${lang} : ${text}`);
    });
  }
});

test("another server or sign-in name: a question before saving when calendars would leave Thunderbird with unsent changes", async () => {
  const before = (over = {}) => existing({ sync: { mail: true, contacts: false, calendar: true, tasks: true }, ...over });
  const request = (over = {}) => ({ email: "alice@example.com", username: "", sync: { mail: true, contacts: false, calendar: true, tasks: true }, ...over });
  const same = { origin: "https://mail.example.com" };
  const other = { origin: "https://mail2.example.com" };
  const asked = "Changer le serveur ou l'identifiant de « Travail » ? Ses agendas et ses tâches seront retirés de Thunderbird, puis synchronisés de nouveau depuis le serveur. Les modifications pas encore envoyées au serveur sont perdues.";
  // Another server (the origin: scheme, host and port), or another sign-in name.
  eq(moveConfirm(before(), other, request(), "Travail"), asked);
  eq(moveConfirm(before(), { origin: "https://mail.example.com:8443" }, request(), "Travail"), asked, "another port is another server");
  eq(moveConfirm(before(), same, request({ username: "DOMAINE\\alice" }), "Travail"), asked);
  eq(moveConfirm(before({ username: "alice" }), same, request({ username: "" }), "Travail"), asked, "back to the address");
  eq(moveConfirm(before({ username: "alice" }), same, request({ username: "Alice" }), "Travail"), asked, "compared as it is, as the background compares it");
  // Only one of the two is synchronised: its calendar leaves all the same.
  eq(moveConfirm(before({ sync: { mail: true, calendar: false, tasks: true } }), other, request({ sync: { mail: true, tasks: true } }), "Travail"), asked);
  // Nothing to ask: the same server and sign-in name, a new mailbox, no calendar and no tasks, or none of them kept
  // (what is unchecked has its own question).
  eq(moveConfirm(before(), same, request(), "Travail"), "");
  eq(moveConfirm(before({ username: "alice" }), same, request({ username: "alice" }), "Travail"), "");
  eq(moveConfirm(before(), same, request({ email: "alice@example.com", username: "alice@example.com" }), "Travail"), "", "the address typed as the sign-in name is the same sign-in name");
  eq(moveConfirm(null, other, request(), "Travail"), "");
  eq(moveConfirm(before({ sync: { mail: true, calendar: false, tasks: false } }), other, request(), "Travail"), "", "no calendar until now: nothing leaves");
  eq(moveConfirm(before(), other, request({ sync: { mail: true, calendar: false, tasks: false } }), "Travail"), "", "both unchecked: uncheckConfirm asks");
  eq(moveConfirm(before(), null, request(), "Travail"), "", "no server parsed: the form has an error of its own");
  eq(moveConfirm(before({ sync: { calendar: "true" } }), other, request(), "Travail"), "", "only a real boolean");
  // The form's own result gives what is compared.
  const form = validateForm(values({ server: "mail2.example.com", password: "p", sync: { mail: true, calendar: true, contacts: false, tasks: false } }), before());
  eq(form.ok, true);
  eq(moveConfirm(before(), form.server, form.request.mailbox, "Travail"), asked);
  // The name is shown as text, cleaned; every language names it and says what is lost.
  const odd = `Tra${String.fromCharCode(0x202e)}vail${String.fromCharCode(10)}B`;
  assert(moveConfirm(before(), other, request(), odd).startsWith("Changer le serveur ou l'identifiant de « Travail B » ?"));
  for (const lang of LOCALES) {
    await withLanguage(lang, () => {
      const text = moveConfirm(before(), other, request(), "Boîte 1");
      assert(text.includes("Boîte 1") && text.includes("Thunderbird") && /[.。]$/.test(text), `${lang} : ${text}`);
      // It ends as the other questions do: changes not yet sent are lost.
      const tail = /[^.。?？]+[.。]$/.exec(text)[0].trim();
      assert(uncheckConfirm(before(), { mail: true }, "Boîte 1").endsWith(tail), `${lang} : ${tail}`);
    });
  }
});

test("messages impossibles à importer : signalés après l'état, s'il y en a", () => {
  const now = new Date(2026, 10, 15, 16, 30).getTime();
  const at = new Date(2026, 10, 15, 16, 2).getTime();
  eq(statusView({ lastSuccessAt: at, failedItems: 3 }, now), {
    tone: "ok",
    text: "Synchronisée à 16:02. 3 messages n'ont pas pu être importés : nouvel essai automatique.",
    massDelete: null,
  });
  eq(statusView({ lastSuccessAt: at, failedItems: 1 }, now).text, "Synchronisée à 16:02. 1 message n'a pas pu être importé : nouvel essai automatique.");
  eq(statusView({ running: true, failedItems: 2 }, now).text, "Synchronisation en cours… 2 messages n'ont pas pu être importés : nouvel essai automatique.");
  for (const failedItems of [0, -1, 1.5, "3", null, undefined]) {
    eq(statusView({ lastSuccessAt: at, failedItems }, now).text, "Synchronisée à 16:02.", String(failedItems));
  }
  eq(failedText(0), "");
  eq(failedText(12), "12 messages n'ont pas pu être importés : nouvel essai automatique.");
});

test("events and tasks that cannot be imported: counted apart from messages (which alone are tried again)", () => {
  const now = new Date(2026, 10, 15, 16, 30).getTime();
  const at = new Date(2026, 10, 15, 16, 2).getTime();
  eq(statusView({ lastSuccessAt: at, failedItems: 5, failedCalendarItems: 2 }, now).text,
    "Synchronisée à 16:02. 3 messages n'ont pas pu être importés : nouvel essai automatique. 2 événements ou tâches n'ont pas pu être importés.");
  eq(failedText(1, 1), "1 événement ou tâche n'a pas pu être importé.");
  eq(failedText(2, 1), "1 message n'a pas pu être importé : nouvel essai automatique. 1 événement ou tâche n'a pas pu être importé.");
  eq(failedText(4, 4), "4 événements ou tâches n'ont pas pu être importés.");
  eq(failedText(3, 9), "3 événements ou tâches n'ont pas pu être importés.", "never more than the whole");
  for (const calendar of [0, -1, 1.5, "2", null, undefined, NaN]) eq(failedText(3, calendar), "3 messages n'ont pas pu être importés : nouvel essai automatique.", String(calendar));
  eq(failedText(0, 2), "");
});

test("page : ordre des champs et texte affiché partagés avec options.mjs", () => {
  eq([...FIELD_ORDER], ["email", "password", "name", "server", "username", "syncMinutes", "filterType", "sync", "calendarPeriod", "taskFilter"]);
  eq(shown("a\u202eb\nc"), "ab c");
  eq(shown(42), "");
  eq(shown("x".repeat(400)).length, 300);
});

// ── Calendar period and task filter (stage 4) ─────────────────────────────

test("form: calendar period and task filter among the choices offered, always sent in the request", () => {
  eq(CALENDAR_PERIODS.map(([f]) => f), ["4", "5", "6", "7", "0"]);
  eq(TASK_FILTERS.map(([f]) => f), ["0", "8"]);
  eq([DEFAULTS.calendarPeriod, DEFAULTS.taskFilter], ["7", "0"]);
  eq(CALENDAR_PERIODS.map(([, label]) => label()), ["2 semaines", "1 mois", "3 mois", "6 mois", "Tout"]);
  eq(TASK_FILTERS.map(([, label]) => label()), ["Toutes les tâches", "Tâches non terminées seulement"]);
  const all = { mail: true, calendar: true, contacts: false, tasks: true };
  for (const [f] of CALENDAR_PERIODS) eq(validateForm(values({ sync: all, calendarPeriod: f })).request.mailbox.calendarPeriod, f);
  for (const [f] of TASK_FILTERS) eq(validateForm(values({ sync: all, taskFilter: f })).request.mailbox.taskFilter, f);
  // The request of an edited mailbox carries them too.
  const r = validateForm(values({ password: "", sync: all, calendarPeriod: "4", taskFilter: "8" }), existing());
  eq([r.ok, r.request.mailbox.calendarPeriod, r.request.mailbox.taskFilter], [true, "4", "8"]);
});

test("form: calendar period and task filter refused outside the choices, when their item is checked", () => {
  const all = { mail: true, calendar: true, contacts: false, tasks: true };
  // "1", "2", "3" are mail periods only; "8" is a task filter only; numbers are not strings.
  for (const calendarPeriod of ["1", "2", "3", "8", "9", "", "07", " 7", "7 ", "all", "__proto__", 7, null, undefined, ["7"]]) {
    const r = validateForm(values({ sync: all, calendarPeriod }));
    eq(fields(r), ["calendarPeriod"], String(calendarPeriod));
    eq(r.errors[0].message, "Choisissez la période d'agenda à synchroniser.");
    eq(r.request, null);
  }
  for (const taskFilter of ["1", "4", "7", "9", "", "08", "constructor", 0, 8, null, undefined]) {
    const r = validateForm(values({ sync: all, taskFilter }));
    eq(fields(r), ["taskFilter"], String(taskFilter));
    eq(r.errors[0].message, "Choisissez les tâches à synchroniser.");
  }
  // After the other fields, in the order of the page.
  const r = validateForm({ email: "x", password: "", server: "http://a.b", syncMinutes: "9", filterType: "9", calendarPeriod: "9", taskFilter: "9", sync: { calendar: true, tasks: true } });
  eq(fields(r), ["email", "password", "server", "syncMinutes", "filterType", "calendarPeriod", "taskFilter"]);
});

test("form: a hidden field keeps its value; an unusable one becomes the default instead of an unseen error", () => {
  eq(KIND_FIELDS.map((pair) => [...pair]), [["calendar", "calendarPeriod"], ["tasks", "taskFilter"]]);
  for (const [, field] of KIND_FIELDS) assert(FIELD_ORDER.includes(field), field);
  const mailOnly = { mail: true, calendar: false, contacts: false, tasks: false };
  // Unchecked: the value chosen earlier is still sent, to be there when the item is checked again.
  const kept = validateForm(values({ sync: mailOnly, calendarPeriod: "4", taskFilter: "8" }));
  eq([kept.ok, kept.request.mailbox.calendarPeriod, kept.request.mailbox.taskFilter], [true, "4", "8"]);
  // Unchecked and unusable: nobody could see the error, the default is sent.
  for (const bad of ["9", "", undefined, null, 7]) {
    const r = validateForm(values({ sync: mailOnly, calendarPeriod: bad, taskFilter: bad }));
    eq([r.ok, r.request.mailbox.calendarPeriod, r.request.mailbox.taskFilter], [true, "7", "0"], String(bad));
  }
  // Each field follows its own item.
  eq(fields(validateForm(values({ sync: { mail: true, calendar: true }, calendarPeriod: "9", taskFilter: "9" }))), ["calendarPeriod"]);
  eq(fields(validateForm(values({ sync: { mail: true, tasks: true }, calendarPeriod: "9", taskFilter: "9" }))), ["taskFilter"]);
});

test("formValues: calendar period and task filter of a mailbox, the defaults when absent or invalid", () => {
  eq([formValues(existing({ calendarPeriod: "5", taskFilter: "8" })).calendarPeriod, formValues(existing({ calendarPeriod: "5", taskFilter: "8" })).taskFilter], ["5", "8"]);
  eq(formValues(existing({ calendarPeriod: "0" })).calendarPeriod, "0");
  for (const bad of ["1", "8", "", 7, null, undefined, {}, "__proto__"]) eq(formValues(existing({ calendarPeriod: bad })).calendarPeriod, "7", String(bad));
  for (const bad of ["4", "7", "", 8, 0, null, undefined, [], "toString"]) eq(formValues(existing({ taskFilter: bad })).taskFilter, "0", String(bad));
  // What the form shows for an old mailbox is a request the form accepts.
  const old = formValues(existing());
  eq(validateForm({ ...old, password: "" }, existing()).request.mailbox, {
    id: "0123456789ab",
    email: "alice@example.com",
    username: "",
    name: "Travail",
    server: "mail.example.com",
    syncMinutes: 15,
    filterType: "3",
    calendarPeriod: "7",
    taskFilter: "0",
    sync: { mail: true, calendar: true, contacts: false, tasks: false },
  });
});
