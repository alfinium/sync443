// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Translations (src/_locales/<language>/messages.json, src/i18n.mjs).
 *
 *  - the catalogues: the same keys and the same placeholders in every
 *    language, no empty message, every $NAME$ declared;
 *  - the keys used: every file the extension loads (from the manifest,
 *    through its pages and module imports) is read; every t("key"),
 *    data-i18n="key", __MSG_key__ and table of keys of i18n.mjs names a
 *    message that exists, and every message is used;
 *  - the texts in English and in French: failures chosen by their code,
 *    the French catalogue showing the engine's own reason;
 *  - calendar and meetings: the tables of keys the sync engine uses
 *    (subjects of meeting messages, notifications), in every language.
 */

import { test, eq, assert } from "./harness.mjs";
import { CATALOGS, LOCALES, DEFAULT_LOCALE, readText, render, withLanguage, tagOf } from "./i18n-fake.mjs";
import {
  t,
  sentence,
  errorText,
  errorDetail,
  serverErrorText,
  ERROR_KEYS,
  KEYED_ERRORS,
  SERVER_ERROR_KEYS,
  MEETING_SUBJECT_KEYS,
  MEETING_TEXT_KEYS,
  CALENDAR_NOTICE_KEYS,
  CALENDAR_COUNT_NOTICE_KEYS,
  itemTitle,
  cleanLine,
  meetingSubject,
  meetingText,
  calendarNotice,
} from "../../src/i18n.mjs";
import { statusView, formatTime, frequencyLabel, periodLabel, kindsLabel, logText, validateForm, debugText, uncheckConfirm, moveConfirm, CALENDAR_PERIODS, TASK_FILTERS } from "../../src/options/form.mjs";
import { questionText, recipientsText, whenText } from "../../src/confirm/confirm.mjs";
import { parseServer } from "../../src/core/server.mjs";
import { recordFailure } from "../../src/sync/health.mjs";
import { EasError, ERR } from "../../src/transport/client.mjs";

const SRC = "../../src/";
const PLACEHOLDER_USE = /\$([A-Za-z0-9_@]+)\$/g;

const keysOf = (lang) => Object.keys(CATALOGS[lang]);
const placeholdersOf = (entry) =>
  Object.fromEntries(Object.entries(entry.placeholders ?? {}).map(([name, p]) => [name.toLowerCase(), String(p?.content)]));

// ── The files the extension loads ─────────────────────────────────────────

/** "options/../core/x.mjs" → "core/x.mjs"; null when it leaves src/. */
function normalize(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

const STATIC_IMPORT = /^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*["'](\.{1,2}\/[^"'\n]+)["']/gm;
const BARE_IMPORT = /^[ \t]*import[ \t]*["'](\.{1,2}\/[^"'\n]+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["'](\.{1,2}\/[^"'\n]+)["']\s*\)/g;
const HTML_SCRIPT = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;

/** Pages the background opens itself (windows.create): no entry of the manifest names them. */
const OPENED_PAGES = ["confirm/confirm.html"];

let loaded = null;

/** { manifest, files: Map(path in src/ → text) }: the manifest, its pages and scripts, and every module they import. */
async function extensionFiles() {
  if (loaded) return loaded;
  const manifest = JSON.parse(await readText(`${SRC}manifest.json`));
  const files = new Map([["manifest.json", JSON.stringify(manifest)]]);
  const visit = async (raw) => {
    const path = normalize(raw);
    assert(path !== null, `${raw} sort de src/`);
    if (files.has(path)) return;
    const text = await readText(SRC + path);
    files.set(path, text);
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const refs = path.endsWith(".html")
      ? [...text.matchAll(HTML_SCRIPT)].map((m) => m[1])
      : [...text.matchAll(STATIC_IMPORT), ...text.matchAll(BARE_IMPORT), ...text.matchAll(DYNAMIC_IMPORT)].map((m) => m[1]);
    for (const ref of refs) await visit(dir + ref);
  };
  for (const script of manifest.background?.scripts ?? []) await visit(script);
  if (manifest.options_ui?.page) await visit(manifest.options_ui.page);
  for (const page of OPENED_PAGES) await visit(page);
  for (const api of Object.values(manifest.experiment_apis ?? {})) if (api?.parent?.script) await visit(api.parent.script);
  loaded = { manifest, files };
  return loaded;
}

/**
 * The code of a file without its comments, so that examples such as t("key")
 * in them are not taken for uses. Only comments that start a line are
 * removed: "/*" also appears inside strings ("https://host/*").
 */
const code = (path, text) =>
  path.endsWith(".html")
    ? text.replace(/<!--[\s\S]*?-->/g, "")
    : text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** [{ key, where }] for every message the extension names. */
async function usedKeys() {
  const { files } = await extensionFiles();
  const used = [];
  const add = (key, where) => used.push({ key, where });
  for (const [path, raw] of files) {
    const text = code(path, raw);
    if (path === "manifest.json") {
      for (const m of text.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) add(m[1], path);
    } else if (path.endsWith(".html")) {
      for (const m of text.matchAll(/\bdata-i18n(?:-[a-z-]+)?\s*=\s*"([^"]*)"/g)) add(m[1], path);
    } else {
      for (const m of text.matchAll(/\bt\(\s*"([^"]*)"/g)) add(m[1], path);
      // errorText(failure, "fallbackKey")
      for (const m of text.matchAll(/\berrorText\([^()]*?,\s*"([^"]*)"\s*\)/g)) add(m[1], path);
    }
  }
  for (const key of [...ERROR_KEYS.values(), "errorOther", ...KEYED_ERRORS, ...SERVER_ERROR_KEYS.values(), "unexpectedError"]) add(key, "i18n.mjs");
  // Calendar and meetings: chosen from these tables by the sync engine (meetingSubject, meetingText, calendarNotice).
  for (const table of [MEETING_SUBJECT_KEYS, MEETING_TEXT_KEYS, CALENDAR_NOTICE_KEYS]) for (const key of Object.values(table)) add(key, "i18n.mjs");
  for (const pair of Object.values(CALENDAR_COUNT_NOTICE_KEYS)) for (const key of Object.values(pair)) add(key, "i18n.mjs");
  return used;
}

// ── Catalogues ────────────────────────────────────────────────────────────

test("traductions : anglais par défaut, nom et description du manifeste traduits", async () => {
  const { manifest } = await extensionFiles();
  eq(manifest.default_locale, DEFAULT_LOCALE);
  eq([manifest.name, manifest.description, manifest.browser_action.default_title], ["__MSG_extensionName__", "__MSG_extensionDescription__", "__MSG_actionSync__"]);
  eq(LOCALES[0], DEFAULT_LOCALE);
  eq(LOCALES.length, 10, "les dix langues les plus employées dans Thunderbird");
  for (const lang of LOCALES) {
    eq(CATALOGS[lang].extensionName.message, "Sync443 – EAS Client for Thunderbird", lang);
    eq(CATALOGS[lang].languageTag.message, tagOf(lang), `${lang} : languageTag`);
    assert(/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(lang), `${lang} : code de dossier de Thunderbird attendu (pt_BR…)`);
  }
});

test("traductions : erreurs du moteur traduites hors du français, réglage de casse yes ou no", () => {
  const engine = [...ERROR_KEYS.values(), "errorOther"];
  for (const lang of LOCALES) {
    for (const key of engine) {
      const text = render(CATALOGS[lang][key], ["<raison>"]);
      if (lang === "fr") eq(text, "<raison>", `fr : ${key} montre la raison du moteur`);
      else assert(!text.includes("<raison>") && text.trim(), `${lang} : ${key} doit être traduit, sans la raison française`);
    }
    assert(["yes", "no"].includes(CATALOGS[lang].sendReasonLowercase.message), `${lang} : sendReasonLowercase`);
  }
  eq(CATALOGS.de.sendReasonLowercase.message, "no", "de : les noms gardent leur majuscule");
});

test("traductions : les mêmes clés dans chaque langue (sans doublon à la casse près)", () => {
  const reference = keysOf(DEFAULT_LOCALE).sort();
  for (const lang of LOCALES) {
    const keys = keysOf(lang);
    eq([...keys].sort(), reference, lang);
    eq(new Set(keys.map((k) => k.toLowerCase())).size, keys.length, `${lang} : deux clés ne diffèrent que par la casse`);
    for (const k of keys) assert(/^[A-Za-z0-9_]+$/.test(k), `${lang} : nom de message invalide ${k}`);
  }
});

test("traductions : aucun message vide, chaque message anglais décrit pour les traducteurs", () => {
  for (const lang of LOCALES) {
    for (const [key, entry] of Object.entries(CATALOGS[lang])) {
      assert(typeof entry?.message === "string" && entry.message.trim() !== "", `${lang} : ${key} vide`);
      assert(entry.message === entry.message.trim(), `${lang} : ${key} commence ou finit par une espace`);
    }
  }
  for (const [key, entry] of Object.entries(CATALOGS.en)) assert(typeof entry.description === "string" && entry.description.trim(), `en : ${key} sans description`);
});

test("traductions : les mêmes paramètres dans chaque langue, tous déclarés, numérotés $1, $2…", () => {
  for (const key of keysOf(DEFAULT_LOCALE)) {
    const reference = placeholdersOf(CATALOGS[DEFAULT_LOCALE][key]);
    const contents = Object.values(reference).sort();
    eq(contents, contents.map((_, i) => `$${i + 1}`), `${key} : paramètres $1…$n`);
    for (const lang of LOCALES) {
      const entry = CATALOGS[lang][key];
      eq(placeholdersOf(entry), reference, `${lang} : ${key}`);
      for (const m of entry.message.matchAll(PLACEHOLDER_USE)) assert(m[1].toLowerCase() in reference, `${lang} : ${key} : ${m[0]} non déclaré`);
      // Every message renders, and every placeholder of a French or English message is shown (only the
      // engine's errors may leave out the French reason, in languages other than French).
      const subs = contents.map((_, i) => `<${i + 1}>`);
      const text = render(entry, subs);
      assert(!/\$[A-Za-z0-9_@]+\$/.test(text), `${lang} : ${key} : paramètre non remplacé`);
      const engineError = [...ERROR_KEYS.values(), "errorOther"].includes(key);
      if (!engineError || lang === "fr") for (const s of subs) assert(text.includes(s), `${lang} : ${key} : ${s} non affiché`);
    }
  }
});

// ── Keys used ─────────────────────────────────────────────────────────────

test("traductions : fichiers chargés par l'extension parcourus depuis le manifeste", async () => {
  const { files } = await extensionFiles();
  for (const path of ["background.mjs", "send.mjs", "i18n.mjs", "options/options.html", "options/options.mjs", "options/form.mjs", "confirm/confirm.html", "confirm/confirm.mjs", "core/server.mjs", "log.mjs"]) {
    assert(files.has(path), `${path} non parcouru`);
  }
});

test("traductions : chaque clé employée existe, chaque message est employé", async () => {
  const used = await usedKeys();
  const known = new Set(keysOf(DEFAULT_LOCALE));
  const missing = used.filter(({ key }) => !known.has(key)).map(({ key, where }) => `${where} : ${key}`);
  eq(missing, [], "clés absentes des catalogues");
  const names = new Set(used.map(({ key }) => key));
  eq([...known].filter((k) => !names.has(k)), [], "messages jamais employés");
});

test("traductions : textes passés par t(\"clé\") seulement (la recherche des clés est complète)", async () => {
  const { files } = await extensionFiles();
  for (const [path, raw] of files) {
    if (!/\.m?js$/.test(path) || path === "i18n.mjs") continue;
    const text = code(path, raw);
    const calls = [...text.matchAll(/\bt\(\s*([^\s)])/g)].filter((m) => m[1] !== '"');
    eq(calls.map((m) => m[0]), [], `${path} : t() sans clé écrite en toutes lettres`);
    assert(!/\bgetMessage\s*\(/.test(text), `${path} : getMessage en dehors de i18n.mjs`);
  }
});

test("traductions : la page de réglages ne garde aucun texte en dur, sauf l'avis hors de Thunderbird (en anglais)", async () => {
  const { files } = await extensionFiles();
  const html = files.get("options/options.html");
  const filled = [...html.matchAll(/<(\w+)\b([^>]*)\bdata-i18n="([^"]+)"[^>]*>([^<]*)</g)].filter((m) => m[4].trim());
  eq(filled.map((m) => m[3]), ["pageOutsideThunderbird"]);
  eq(filled[0][4], CATALOGS.en.pageOutsideThunderbird.message);
  // Elements with text but no key (the product name aside).
  const bare = [...html.matchAll(/<(h1|h2|h3|p|label|legend|button|title|span|li|option)\b(?![^>]*data-i18n)[^>]*>([^<]+)</g)].map((m) => m[2].trim());
  eq(bare, ["Sync443"]);
});

// ── In English and in French ──────────────────────────────────────────────

test("traductions : catalogue français = textes d'avant, catalogue anglais = traduction", async () => {
  eq(t("addMailbox"), "Ajouter une boîte");
  eq(t("removeQuestion", "Travail"), "Supprimer la boîte « Travail » ? Son compte, ses dossiers locaux et son mot de passe seront retirés de Thunderbird. Rien n'est supprimé sur le serveur. Les modifications pas encore envoyées au serveur sont perdues.");
  await withLanguage("en", () => {
    eq(t("addMailbox"), "Add a mailbox");
    eq(t("removeQuestion", "Work"), "Remove the mailbox “Work”? Its account, its local folders and its password will be removed from Thunderbird. Nothing is deleted on the server. Changes not yet sent to the server are lost.");
    eq(t("languageTag"), "en");
  });
});

test("traductions : échec du moteur choisi par son code ; en français, la raison du moteur telle quelle", async () => {
  const auth = new EasError(ERR.AUTH, "Identifiant ou mot de passe refusé par le serveur.");
  eq(errorText(auth), "Identifiant ou mot de passe refusé par le serveur.");
  eq(errorDetail(auth, errorText(auth)), "", "pas de détail : la raison est affichée");
  for (const key of [...ERROR_KEYS.values(), "errorOther"]) eq(t(key, "raison"), "raison", key);
  // Without a reason: the fallback.
  eq(errorText({ code: "TLS" }), "Erreur inattendue.");
  eq(errorText({ code: "TLS" }, "statusSeriousError"), "erreur grave.");
  await withLanguage("en", () => {
    eq(errorText(auth), "The server refused the sign-in name or the password.");
    eq(errorDetail(auth, errorText(auth)), "Details (in French): Identifiant ou mot de passe refusé par le serveur.");
    eq(errorText({ code: "TLS", message: "Connexion refusée : certificat du serveur non reconnu." }), "Connection refused before the password was sent: the server's certificate was not accepted. The network may be intercepting HTTPS connections. Certificates from a private authority are not supported yet.");
    eq(errorText({ code: "NOT_A_CODE", message: "x" }), "Unexpected error.");
    eq(errorText({ code: "__proto__", message: "x" }), "Unexpected error.");
    eq(errorText({ code: "TLS" }), "Connection refused before the password was sent: the server's certificate was not accepted. The network may be intercepting HTTPS connections. Certificates from a private authority are not supported yet.");
    for (const key of ERROR_KEYS.values()) assert(t(key, "raison") !== "raison" && !t(key, "raison").includes("raison"), key);
  });
});

test("traductions : un texte qui ne peut pas être construit donne \"\", sans exception (l'envoi n'en dépend pas)", () => {
  const i18n = globalThis.browser.i18n;
  try {
    globalThis.browser.i18n = { ...i18n, getMessage: () => { throw new Error("catalogue indisponible"); } };
    eq(t("sendBusy"), "");
    globalThis.browser.i18n = i18n;
    eq(t("sendBusy", { toString() { throw new Error("paramètre"); } }), "");
  } finally {
    globalThis.browser.i18n = i18n;
  }
});

test("traductions : serveur occupé, sans promettre un nouvel essai (l'envoi n'en fait pas)", async () => {
  for (const lang of LOCALES) {
    if (lang === "fr") continue; // the engine's own reason, which promises nothing
    await withLanguage(lang, () => {
      const text = errorText({ code: "BUSY", message: "Connexion momentanément impossible (trop de connexions ouvertes)." });
      assert(text && text === t("errorBusy", "x"), lang);
    });
  }
  await withLanguage("en", () => eq(t("errorBusy", "x"), "The server is busy, or too many connections are open."));
});

test("traductions : échecs nommés par la page d'arrière-plan (key), gardés par la santé de la boîte", async () => {
  const e = new EasError(ERR.NETWORK, "Mot de passe inaccessible pour le moment.", { key: "errorPasswordLocked" });
  const health = recordFailure({}, e, 1000, { random: () => 0 });
  eq(health.lastError.key, "errorPasswordLocked");
  eq(errorText(health.lastError), "Mot de passe inaccessible pour le moment.");
  eq(recordFailure({}, { code: "CONFIG", message: "x", key: "pas une clé !" }, 1000).blocked, { code: "CONFIG", message: "x", at: 1000 });
  eq(errorText({ code: "NETWORK", message: "Serveur injoignable.", key: "addMailbox" }), "Serveur injoignable.", "seulement les clés prévues");
  await withLanguage("en", () => {
    eq(errorText(health.lastError), "The password cannot be accessed at the moment.");
    eq(statusView({ blocked: recordFailure({}, new EasError(ERR.CONFIG, "Mot de passe absent.", { key: "errorPasswordAbsent" }), 0).blocked }).text,
      "Stopped: No password saved: edit the mailbox to enter it. Nothing will be attempted automatically: click “Synchronize” to resume.");
  });
});

test("traductions : adresse de serveur refusée, message choisi par son code", async () => {
  const refusal = (input) => {
    try {
      parseServer(input);
    } catch (e) {
      return e;
    }
    return null;
  };
  const cases = [
    ["", "EMPTY", "Indiquez le serveur, par exemple mail.exemple.com.", "Enter the server, for example mail.example.com."],
    ["mail exemple.com", "SPACE", "L'adresse du serveur ne doit pas contenir d'espace.", "The server address must not contain spaces."],
    ["http://mail.example.com", "SCHEME", "Le serveur doit être joignable en HTTPS.", "The server must be reachable over HTTPS."],
    ["jean@mail.example.com", "CREDENTIALS", "L'adresse du serveur ne doit pas contenir d'identifiant ni de mot de passe.", "The server address must not contain a sign-in name or a password."],
    ["mail", "INVALID", "Serveur invalide : mail", "Invalid server: mail"],
    ["mail.example.com:99999", "PORT", "Port invalide : 99999", "Invalid port: 99999"],
  ];
  for (const [input, code, fr, en] of cases) {
    const e = refusal(input);
    eq([e?.code, e?.message, serverErrorText(e)], [code, fr, fr], input);
    await withLanguage("en", () => eq(serverErrorText(e), en, input));
  }
  eq(serverErrorText(new Error("x")), "Serveur invalide.");
});

test("traductions : page de réglages en anglais (choix, état, journal, erreurs de saisie)", async () => {
  const now = new Date(2026, 10, 15, 16, 30).getTime();
  await withLanguage("en", () => {
    eq([frequencyLabel(0), frequencyLabel(15), frequencyLabel(60), frequencyLabel(7)], ["As soon as mail arrives", "Every 15 minutes", "Every hour", "Every 7 minutes"]);
    eq([periodLabel("5"), periodLabel("0"), periodLabel("x")], ["1 month", "All", "Unknown"]);
    eq(kindsLabel({ mail: true, calendar: true, contacts: true, tasks: true }), "Mail, Calendar, Contacts (coming soon), Tasks");
    eq(statusView({}, now).text, "Not synchronized yet.");
    eq(statusView({ running: true }, now).text, "Synchronizing…");
    eq(statusView({ blocked: { code: "MASS_DELETE" }, pendingDeletes: 120 }, now).text.startsWith("Synchronization paused: the server deleted 120 items at once (messages, events or tasks)."), true);
    const error = statusView({ lastError: { code: "NETWORK", message: "Serveur injoignable." }, nextAttemptAt: new Date(2026, 10, 15, 16, 45).getTime(), failedItems: 2 }, now);
    assert(/^Error: The server cannot be reached\. Next attempt at \S+ PM\. 2 messages could not be imported/.test(error.text), error.text);
    eq(error.detail, "Details (in French): Serveur injoignable.");
    const day = formatTime(new Date(2026, 0, 3, 23, 59).getTime(), now);
    assert(/^\S+ at \S+ PM$/.test(day), day);
    eq(statusView({ lastSuccessAt: new Date(2026, 9, 1, 8, 0).getTime() }, now).text.startsWith("Synchronized on "), true);
    assert(logText([{ t: now, level: "warn", msg: "Serveur injoignable." }]).includes("  warning   Serveur injoignable."), "niveau traduit, entrée en français");
    eq(logText([]), "The log is empty.");
    const form = validateForm({ email: "", password: "", server: "", syncMinutes: "", filterType: "", sync: {} });
    eq(form.errors.map((x) => x.message), [
      "Enter the email address.",
      "Enter the password.",
      "Enter the server, for example mail.example.com.",
      "Choose a synchronization frequency.",
      "Choose the period of mail to synchronize.",
      "Choose at least one item to synchronize.",
    ]);
  });
  // Back in French: no detail, the reason is in the text.
  eq(statusView({ lastError: { code: "NETWORK", message: "Serveur injoignable." } }, now), { tone: "error", text: "Erreur : Serveur injoignable.", massDelete: null });
});

test("traductions : chaque langue compose la page sans paramètre oublié ni ponctuation doublée", async () => {
  const now = new Date(2026, 10, 15, 16, 30).getTime();
  const at = (h, m) => new Date(2026, 10, 15, h, m).getTime();
  for (const lang of LOCALES) {
    await withLanguage(lang, () => {
      const texts = [
        frequencyLabel(0),
        frequencyLabel(15),
        frequencyLabel(7),
        periodLabel("5"),
        kindsLabel({ mail: true, calendar: true, contacts: true, tasks: true }),
        statusView({}, now).text,
        statusView({ running: true, failedItems: 1 }, now).text,
        statusView({ lastSuccessAt: at(16, 2), failedItems: 12 }, now).text,
        statusView({ lastSuccessAt: new Date(2025, 0, 3, 8, 0).getTime() }, now).text,
        statusView({ blocked: { code: "MASS_DELETE" }, pendingDeletes: 120 }, now).text,
        statusView({ blocked: { code: "MASS_DELETE" } }, now).text,
        statusView({ blocked: { code: "AUTH", message: "Identifiant ou mot de passe refusé par le serveur." } }, now).text,
        statusView({ blocked: { code: "X" } }, now).text,
        statusView({ lastError: { code: "TLS", message: "Certificat refusé" }, nextAttemptAt: at(16, 45) }, now).text,
        statusView({ lastError: { code: "LOCAL" } }, now).text,
        logText([{ t: now, level: "debug", msg: "x" }]),
        logText([]),
        debugText(now + 3_600_000, now),
        ...validateForm({ email: "a", password: "", server: "http://x", username: "a:b", syncMinutes: "2", filterType: "9", sync: {} }).errors.map((e) => e.message),
        t("removeQuestion", "Work"),
        uncheckConfirm({ sync: { calendar: true, tasks: true } }, { calendar: false, tasks: true }, "Work"),
        uncheckConfirm({ sync: { calendar: true, tasks: true } }, { calendar: true, tasks: false }, "Work"),
        uncheckConfirm({ sync: { calendar: true, tasks: true } }, {}, "Work"),
        moveConfirm({ origin: "https://old.example.com", email: "a@example.com", sync: { calendar: true } }, { origin: "https://new.example.com" }, { email: "a@example.com", sync: { calendar: true } }, "Work"),
        t("sendReasonRefused", t("sendStatus116"), "116"),
        t("sendFailedDraft", t("sendReasonTooLarge", 50)),
        // Calendar and tasks in the form.
        ...CALENDAR_PERIODS.map(([, label]) => label()),
        ...TASK_FILTERS.map(([, label]) => label()),
        ...validateForm({ email: "a@example.com", password: "p", server: "mail.example.com", syncMinutes: "0", filterType: "5", calendarPeriod: "", taskFilter: "", sync: { calendar: true, tasks: true } }).errors.map((e) => e.message),
        // The confirmation window.
        ...["invite", "update", "cancel"].map(questionText),
        recipientsText(1),
        recipientsText(2),
        recipientsText(100),
        whenText({ allDay: true, time: Date.UTC(2026, 10, 16) }),
        whenText({ allDay: false, time: Date.UTC(2026, 10, 16, 14, 30) }, { timeZone: "UTC" }),
        t("confirmLabelFrom"),
        `${t("confirmExpired")} ${t("confirmNothingSent")}`,
        `${t("badAnswer")} ${t("confirmNothingSent")}`,
        t("confirmUncertain"),
        // Meeting messages and calendar notifications, with a failure of the engine as the reason.
        ...Object.keys(MEETING_SUBJECT_KEYS).map((kind) => meetingSubject(kind, "Budget")),
        meetingSubject("invite", ""),
        meetingText("when", whenText({ allDay: false, time: Date.UTC(2026, 10, 16, 14, 30) }, { timeZone: "UTC" })),
        meetingText("where", "Salle 2"),
        ...Object.keys(CALENDAR_NOTICE_KEYS).map((name) => calendarNotice(name, "Budget", name === "tooManyAttendees" || name === "keptLocalTooManyAttendees" ? 100 : sentence(errorText({ code: "NETWORK", message: "Serveur injoignable." })))),
        calendarNotice("sendFailed", "", sentence(errorText({ code: "LOCAL" }))),
        ...Object.keys(CALENDAR_COUNT_NOTICE_KEYS).flatMap((name) => [1, 2, 5, 21, 104].map((count) => calendarNotice(name, "", count))),
      ];
      for (const text of texts) {
        assert(typeof text === "string" && text.trim(), `${lang} : texte vide`);
        assert(!/\$[A-Za-z0-9_@]+\$|\$\d/.test(text), `${lang} : paramètre non remplacé : ${text}`);
        assert(!/[.。!?！？]\.$|\.\.$/.test(text.replace(/…$/, "")), `${lang} : ponctuation doublée : ${text}`);
      }
      eq(t("languageTag"), tagOf(lang), lang);
    });
  }
});

// ── Calendar and meetings ─────────────────────────────────────────────────

test("translations: the confirmation window keeps no hard-coded text", async () => {
  const { files } = await extensionFiles();
  const html = code("confirm/confirm.html", files.get("confirm/confirm.html"));
  eq([...html.matchAll(/>([^<]+)</g)].map((m) => m[1].trim()).filter(Boolean), []);
  assert(!/\b(?:title|alt|placeholder|aria-label|value)="[^"]+"/.test(html), "attribute with a hard-coded text");
  assert(html.includes('<title data-i18n="confirmTitle">'), "translated window title");
});

test("translations: tables of meeting subjects and calendar notifications, frozen, without inherited names", () => {
  eq(Object.keys(MEETING_SUBJECT_KEYS), ["invite", "update", "cancel", "accepted", "tentative", "declined"]);
  eq(Object.keys(MEETING_TEXT_KEYS), ["when", "where", "noTitle"]);
  eq(Object.keys(CALENDAR_NOTICE_KEYS), [
    "sendFailed", "sendUncertain", "tooManyAttendees", "answerFailed", "answerNoInvitation", "answerNeedsMail", "changeRefused", "recurrenceUnsupported", "readOnly", "tooLarge",
    // After the security audit of stage 4: what the engine and the scheduler tell the user by name.
    "keptLocal", "serverChanged", "detached", "restoreUnsupported", "organizerChanged", "notSentExpired", "notSentFull", "notSentOld",
    "replyNotSent", "keptLocalTooManyAttendees", "keptLocalRecurrence", "keptLocalTooLarge",
  ]);
  eq(Object.keys(CALENDAR_COUNT_NOTICE_KEYS), ["changesDropped"]);
  eq({ ...CALENDAR_COUNT_NOTICE_KEYS.changesDropped }, { one: "calendarChangesDroppedOne", many: "calendarChangesDroppedMany" });
  assert(Object.isFrozen(CALENDAR_COUNT_NOTICE_KEYS.changesDropped) && Object.getPrototypeOf(CALENDAR_COUNT_NOTICE_KEYS.changesDropped) === null, "the pair is frozen too, without inherited names");
  for (const name of Object.keys(CALENDAR_COUNT_NOTICE_KEYS)) assert(!(name in CALENDAR_NOTICE_KEYS), `${name}: in one table only`);
  const keys = [];
  for (const table of [MEETING_SUBJECT_KEYS, MEETING_TEXT_KEYS, CALENDAR_NOTICE_KEYS, CALENDAR_COUNT_NOTICE_KEYS]) {
    assert(Object.isFrozen(table), "frozen");
    eq(Object.getPrototypeOf(table), null, "no prototype: no inherited name answers");
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) eq(table[name], undefined, name);
    for (const key of Object.values(table).flatMap((value) => (typeof value === "string" ? [value] : Object.values(value)))) {
      for (const lang of LOCALES) assert(typeof CATALOGS[lang][key]?.message === "string", `${lang}: ${key}`);
      keys.push(key);
    }
  }
  eq(new Set(keys).size, keys.length, "one message per name");
  // The catalogues already had sendFailed and sendUncertain, for mail: the calendar's own are apart.
  eq([CALENDAR_NOTICE_KEYS.sendFailed, CALENDAR_NOTICE_KEYS.sendUncertain], ["calendarSendFailed", "calendarSendUncertain"]);
});

test("translations: placeholders of the meeting and calendar messages, the title first", () => {
  const shape = (key) => Object.fromEntries(Object.entries(CATALOGS.en[key].placeholders ?? {}).map(([name, p]) => [name, p.content]));
  for (const key of Object.values(MEETING_SUBJECT_KEYS)) eq(shape(key), { summary: "$1" }, key);
  eq(shape(MEETING_TEXT_KEYS.when), { when: "$1" });
  eq(shape(MEETING_TEXT_KEYS.where), { location: "$1" });
  eq(shape(MEETING_TEXT_KEYS.noTitle), {});
  for (const [name, key] of Object.entries(CALENDAR_NOTICE_KEYS)) {
    const expected = name === "sendFailed" || name === "answerFailed" ? { summary: "$1", reason: "$2" } : name === "tooManyAttendees" || name === "keptLocalTooManyAttendees" ? { summary: "$1", max: "$2" } : { summary: "$1" };
    eq(shape(key), expected, key);
  }
  // A number and no title: nothing for one, the number for several.
  eq([shape(CALENDAR_COUNT_NOTICE_KEYS.changesDropped.one), shape(CALENDAR_COUNT_NOTICE_KEYS.changesDropped.many)], [{}, { count: "$1" }]);
  eq(shape("confirmLabelFrom"), {});
  for (const key of ["uncheckCalendarConfirm", "uncheckTasksConfirm", "uncheckBothConfirm", "removeQuestion", "moveConfirm"]) eq(shape(key), { name: "$1" }, key);
});

test("translations: English sources of the meeting and calendar messages", () => {
  const en = (key) => CATALOGS.en[key].message;
  eq(Object.values(MEETING_SUBJECT_KEYS).map(en), [
    "Invitation: $SUMMARY$",
    "Updated invitation: $SUMMARY$",
    "Cancelled: $SUMMARY$",
    "Accepted: $SUMMARY$",
    "Tentatively accepted: $SUMMARY$",
    "Declined: $SUMMARY$",
  ]);
  eq(Object.values(MEETING_TEXT_KEYS).map(en), ["When: $WHEN$", "Where: $LOCATION$", "(no title)"]);
  eq(Object.values(CALENDAR_NOTICE_KEYS).map(en), [
    "The meeting message for “$SUMMARY$” was not sent: $REASON$ The event is saved, but the attendees were not informed.",
    "The meeting message for “$SUMMARY$” may not have been sent: the connection was lost. Check the Sent folder before sending it again.",
    "“$SUMMARY$” has more than $MAX$ attendees: Sync443 cannot send its invitations. The change was undone.",
    "Your answer to “$SUMMARY$” could not be sent: $REASON$ The event is back as it was.",
    "Your answer to “$SUMMARY$” could not be sent: its invitation was not found on the server. The event is back as it was.",
    "Your answer to “$SUMMARY$” could not be sent: answering invitations on this server requires mail to be synchronized for this mailbox.",
    "The server refused a change to “$SUMMARY$”. The server's version is restored.",
    "The repetition of “$SUMMARY$” cannot be saved on an ActiveSync server. The change was undone.",
    "“$SUMMARY$” cannot be changed from Thunderbird. The change was undone.",
    "“$SUMMARY$” is too large to be saved on the server. The change was undone.",
    "“$SUMMARY$” could not be saved on the server. It stays in Thunderbird as a local copy that is no longer synchronized.",
    "“$SUMMARY$” was changed on the server before your change was sent. The server's version is shown; your change was not sent.",
    "“$SUMMARY$” is no longer the same item on the server. Your version stays in Thunderbird as a local copy that is no longer synchronized.",
    "An occurrence of “$SUMMARY$” that was changed or deleted cannot be put back into its series on an ActiveSync server. The change was undone.",
    "The organizer of “$SUMMARY$” was changed in Thunderbird: no message was sent to the attendees.",
    "The meeting message for “$SUMMARY$” was not sent: the confirmation was not answered in time. The event is saved, but the attendees were not informed.",
    "The meeting message for “$SUMMARY$” was not sent: too many messages are waiting. The event is saved, but the attendees were not informed.",
    "The meeting message for “$SUMMARY$” was not sent: it had been waiting for more than a day. The event is saved, but the attendees were not informed.",
    "Your answer to “$SUMMARY$” is saved in your calendar, but no reply was sent to the organizer: the invitation was not found in this mailbox.",
    "“$SUMMARY$” has more than $MAX$ attendees: Sync443 cannot send its invitations. It stays in Thunderbird as a local copy that is no longer synchronized.",
    "The repetition of “$SUMMARY$” cannot be saved on an ActiveSync server. It stays in Thunderbird as a local copy that is no longer synchronized.",
    "“$SUMMARY$” is too large to be saved on the server. It stays in Thunderbird as a local copy that is no longer synchronized.",
  ]);
  eq(Object.values(CALENDAR_COUNT_NOTICE_KEYS.changesDropped).map(en), [
    "One change made in Thunderbird was not sent: its calendar is no longer synchronized with the server. A new item stays in Thunderbird as a local copy.",
    "$COUNT$ changes made in Thunderbird were not sent: their calendar is no longer synchronized with the server. New items stay in Thunderbird as local copies.",
  ]);
  eq(en("confirmLabelFrom"), "From");
});

test("translations: the questions asked before calendars leave Thunderbird say that changes not yet sent are lost, in every language", async () => {
  // In English, the sentence itself; elsewhere, the same closing sentence in the four questions and in the move question.
  const lost = "Changes not yet sent to the server are lost.";
  const questions = ["uncheckCalendarConfirm", "uncheckTasksConfirm", "uncheckBothConfirm", "removeQuestion", "moveConfirm"];
  for (const key of questions) assert(CATALOGS.en[key].message.endsWith(` ${lost}`), `en: ${key}`);
  for (const lang of LOCALES) {
    const tails = questions.map((key) => /[^.。?？]+[.。]$/.exec(CATALOGS[lang][key].message)?.[0].trim());
    assert(tails[0] && tails[0].length > 20, `${lang}: a closing sentence`);
    eq(new Set(tails).size, 1, `${lang}: the same sentence closes the five questions: ${JSON.stringify(tails)}`);
    if (lang !== "en") assert(tails[0] !== lost, `${lang}: translated`);
    // The sentence that was there before is still there: nothing is deleted on the server.
    for (const key of questions.slice(0, 4)) assert(CATALOGS[lang][key].message.split(/[.。]/).filter((part) => part.trim()).length >= 3, `${lang}: ${key} keeps its sentences`);
  }
  eq(
    uncheckConfirm({ sync: { calendar: true } }, { calendar: false }, "Travail"),
    "Ne plus synchroniser l'agenda de « Travail » ? Ses événements seront retirés de Thunderbird. Rien n'est supprimé sur le serveur. Les modifications pas encore envoyées au serveur sont perdues.",
  );
  await withLanguage("en", () => {
    eq(t("uncheckBothConfirm", "Work"), `Stop synchronizing the calendar and the tasks of “Work”? Its calendars will be removed from Thunderbird, with their events and tasks. Nothing is deleted on the server. ${lost}`);
    eq(t("moveConfirm", "Work"), `Change the server or the sign-in name of “Work”? Its calendars and tasks will be removed from Thunderbird, then synchronized again from the server. ${lost}`);
  });
});

test("translations: subject and lines of a meeting message, chosen by kind", async () => {
  eq(Object.keys(MEETING_SUBJECT_KEYS).map((kind) => meetingSubject(kind, "Budget")), [
    "Invitation : Budget",
    "Invitation mise à jour : Budget",
    "Annulé : Budget",
    "Accepté : Budget",
    "Accepté provisoirement : Budget",
    "Refusé : Budget",
  ]);
  eq(meetingSubject("invite", ""), "Invitation : (sans titre)");
  eq(meetingSubject("invite", null), "Invitation : (sans titre)");
  eq([meetingText("when", "16/11/2026 14:30"), meetingText("where", "Salle 2"), meetingText("noTitle")], ["Quand : 16/11/2026 14:30", "Où : Salle 2", "(sans titre)"]);
  // Only the tables' own names: nothing inherited, nothing from another table.
  for (const kind of ["", "reply", "INVITE", "sendFailed", "__proto__", "constructor", "toString", null, undefined, 1, ["invite"]]) eq(meetingSubject(kind, "Budget"), "", String(kind));
  for (const name of ["", "invite", "__proto__", "constructor", null, undefined]) eq(meetingText(name, "x"), "", String(name));
  await withLanguage("en", () => {
    eq(meetingSubject("tentative", "Budget review"), "Tentatively accepted: Budget review");
    eq(meetingSubject("cancel", "  "), "Cancelled: (no title)");
    eq([meetingText("when", "11/16/2026, 2:30 PM"), meetingText("where", "Room 2")], ["When: 11/16/2026, 2:30 PM", "Where: Room 2"]);
  });
  // A substitution is never read again as a placeholder.
  eq(meetingSubject("invite", "$SUMMARY$ $1 $$"), "Invitation : $SUMMARY$ $1 $$");
});

test("translations: titles from outside are shown as one clean line", () => {
  const rlo = String.fromCharCode(0x202e);
  const zwsp = String.fromCharCode(0x200b);
  eq(itemTitle(`Réunion${rlo} fdp.exe\r\nligne 2${String.fromCharCode(0)}${zwsp}`), "Réunion fdp.exe ligne 2");
  eq(itemTitle(` ${zwsp}\n`), "(sans titre)");
  for (const none of ["", null, undefined, 42, {}, ["x"]]) eq(itemTitle(none), "(sans titre)", String(none));
  eq(itemTitle("x".repeat(3000)).length, 1024);
  eq(itemTitle("x".repeat(3000), 10), "xxxxxxxxxx");
  eq(meetingSubject("invite", `Bud${rlo}get\nligne 2`), "Invitation : Budget ligne 2");
  eq(calendarNotice("readOnly", `Bud${rlo}get\nligne 2`), "« Budget ligne 2 » ne peut pas être modifié depuis Thunderbird. La modification a été annulée.");
});

test("translations: what is shown is cleaned where it is shown — joiners and every invisible character go, whatever the readers let through", () => {
  const c = (code) => String.fromCodePoint(code);
  // The readers of the server's items keep U+200C and U+200D in titles and places (they are part of the text
  // written back to the server). Nothing shown to the user, in a notification or in the window, keeps them.
  const hidden = [0xad, 0x34f, 0x61c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0x206a, 0x206f, 0xfeff, 0xfff9, 0xfffb, 0xfffe, 0xffff, 0xe0001, 0xe0041, 0xe007f];
  for (const code of hidden) {
    const hex = code.toString(16);
    eq(cleanLine(`Bud${c(code)}get`), "Budget", `cleanLine U+${hex}`);
    eq(itemTitle(`Bud${c(code)}get`), "Budget", `itemTitle U+${hex}`);
    eq(calendarNotice("readOnly", `Bud${c(code)}get`), calendarNotice("readOnly", "Budget"), `notification U+${hex}`);
    eq(meetingSubject("invite", `Bud${c(code)}get`), "Invitation : Budget", `subject U+${hex}`);
    eq(meetingText("where", `Salle${c(code)} 2`), "Où : Salle 2", `place U+${hex}`);
    eq(calendarNotice("sendFailed", "Budget", `Rai${c(code)}son.`), calendarNotice("sendFailed", "Budget", "Raison."), `reason U+${hex}`);
    // Half a character before or after it hides nothing (a lone surrogate is replaced before anything is looked for).
    for (const half of [0xd83d, 0xde00, 0xdb40]) {
      const lone = String.fromCharCode(half);
      eq(cleanLine(`a${lone}${c(code)}b`), `a${c(0xfffd)}b`, `half ${half.toString(16)} then U+${hex}`);
      eq(cleanLine(`a${c(code)}${lone}b`), `a${c(0xfffd)}b`, `U+${hex} then half ${half.toString(16)}`);
    }
  }
  // Controls go, line breaks and tabs become one space each run, a lone surrogate is replaced.
  for (const code of [0x00, 0x07, 0x1b, 0x7f, 0x85, 0x9f]) eq(cleanLine(`a${c(code)}b`), "ab", `control U+${code.toString(16)}`);
  for (const code of [0x09, 0x0a, 0x0d, 0x2028, 0x2029]) eq(cleanLine(`a${c(code)}b`), "a b", `break U+${code.toString(16)}`);
  eq(cleanLine(`a\r\n\tb`), "a b");
  eq(cleanLine(`a${String.fromCharCode(0xd800)}b`), `a${c(0xfffd)}b`);
  // What is visible stays: letters of every script, emoji, the no-break spaces dates are written with.
  const kept = `Réunion ${c(0x1f468)}${c(0x1f469)} ${c(0x645)}${c(0x6cc)} ${c(0x4f1a)}${c(0x8b70)} 14${c(0x202f)}h${c(0xa0)}30`;
  eq(cleanLine(kept), kept);
  // Bounded, on characters that were kept (a pair is never cut in two).
  eq(cleanLine(`${c(0x200d)}`.repeat(50) + "x".repeat(20), 10), "xxxxxxxxxx");
  assert(cleanLine(`${"x".repeat(9)}${c(0x1f600)}`, 10).isWellFormed());
  for (const none of [null, undefined, 42, {}, ["x"]]) eq(cleanLine(none), "", String(none));
});

test("translations: changesDropped takes a number and no title — one message for one, another for several", async () => {
  eq(calendarNotice("changesDropped", "", 1), "Une modification faite dans Thunderbird n'a pas été envoyée : son agenda n'est plus synchronisé avec le serveur. Un nouvel élément reste dans Thunderbird comme copie locale.");
  eq(calendarNotice("changesDropped", "", 3), "3 modifications faites dans Thunderbird n'ont pas été envoyées : leur agenda n'est plus synchronisé avec le serveur. Les nouveaux éléments restent dans Thunderbird comme copies locales.");
  eq(calendarNotice("changesDropped", "", "12"), calendarNotice("changesDropped", "", 12), "a number in digits is a number");
  // The title is not used, whatever is given for it; no "(no title)" either.
  eq(calendarNotice("changesDropped", "Budget", 2), calendarNotice("changesDropped", "", 2));
  assert(!calendarNotice("changesDropped", "", 1).includes("sans titre") && !calendarNotice("changesDropped", "Budget", 2).includes("Budget"));
  // Nothing to tell without a whole number from 1 on: no notification rather than a wrong one.
  for (const none of [0, -1, 1.5, NaN, Infinity, "", "x", "1e3", " 2", null, undefined, {}, [3], true]) eq(calendarNotice("changesDropped", "", none), "", String(none));
  eq(calendarNotice("changesDropped", "", 5_000_000).startsWith("999999 "), true, "a number that stays readable");
  await withLanguage("en", () => {
    eq(calendarNotice("changesDropped", "", 1), "One change made in Thunderbird was not sent: its calendar is no longer synchronized with the server. A new item stays in Thunderbird as a local copy.");
    eq(calendarNotice("changesDropped", "", 2), "2 changes made in Thunderbird were not sent: their calendar is no longer synchronized with the server. New items stay in Thunderbird as local copies.");
  });
  for (const lang of LOCALES) {
    await withLanguage(lang, () => {
      const one = calendarNotice("changesDropped", "", 1);
      const many = calendarNotice("changesDropped", "", 7);
      assert(one && many && one !== many, `${lang}: two messages`);
      assert(many.includes("7") && !/\$|COUNT/.test(many), `${lang}: the number is shown: ${many}`);
      assert(!/\$|COUNT/.test(one), `${lang}: ${one}`);
      for (const text of [one, many]) assert(/[.。]$/.test(text) && text.includes("Thunderbird"), `${lang}: ${text}`);
    });
  }
});

test("translations: the notices added after the audit, in French", () => {
  eq(calendarNotice("keptLocal", "Budget"), "« Budget » n'a pas pu être enregistré sur le serveur. Il reste dans Thunderbird comme copie locale, qui n'est plus synchronisée.");
  eq(calendarNotice("serverChanged", "Budget"), "« Budget » a été modifié sur le serveur avant l'envoi de votre modification. La version du serveur est affichée ; votre modification n'a pas été envoyée.");
  eq(calendarNotice("detached", "Budget"), "« Budget » n'est plus le même élément sur le serveur. Votre version reste dans Thunderbird comme copie locale, qui n'est plus synchronisée.");
  eq(calendarNotice("restoreUnsupported", "Budget"), "Une occurrence de « Budget » qui a été modifiée ou supprimée ne peut pas être remise dans sa série sur un serveur ActiveSync. La modification a été annulée.");
  eq(calendarNotice("replyNotSent", "Budget"), "Votre réponse à « Budget » est enregistrée dans votre agenda, mais aucune réponse n'a été envoyée à l'organisateur : l'invitation est introuvable dans cette boîte.");
  // A new item that cannot be sent stays as a local copy, and its notice keeps the reason: the first sentence of
  // the notice that undoes a change, the last sentence of keptLocal, in every language.
  eq(calendarNotice("keptLocalTooManyAttendees", "Budget", 100), "« Budget » compte plus de 100 participants : Sync443 ne peut pas envoyer ses invitations. Il reste dans Thunderbird comme copie locale, qui n'est plus synchronisée.");
  eq(calendarNotice("keptLocalRecurrence", "Budget"), "La répétition de « Budget » ne peut pas être enregistrée sur un serveur ActiveSync. Il reste dans Thunderbird comme copie locale, qui n'est plus synchronisée.");
  eq(calendarNotice("keptLocalTooLarge", "Budget"), "« Budget » est trop volumineux pour être enregistré sur le serveur. Il reste dans Thunderbird comme copie locale, qui n'est plus synchronisée.");
  for (const lang of LOCALES) {
    const first = (key) => CATALOGS[lang][key].message.split(/(?<=[.。])/)[0];
    for (const [kept, undone] of [["calendarKeptLocalTooManyAttendees", "calendarTooManyAttendees"], ["calendarKeptLocalRecurrence", "calendarRecurrenceUnsupported"], ["calendarKeptLocalTooLarge", "calendarTooLarge"]]) {
      eq(first(kept), first(undone), `${lang}: ${kept} gives the reason of ${undone}`);
      assert(CATALOGS[lang][kept].message !== CATALOGS[lang][undone].message && CATALOGS[lang][kept].message.includes("Thunderbird"), `${lang}: ${kept} says where the item stays`);
    }
    assert(CATALOGS[lang].calendarKeptLocalTooManyAttendees.message.includes("$MAX$"), lang);
  }
  eq(calendarNotice("organizerChanged", "Budget"), "L'organisateur de « Budget » a été modifié dans Thunderbird : aucun message n'a été envoyé aux participants.");
  eq(calendarNotice("notSentExpired", "Budget"), "Le message de réunion pour « Budget » n'a pas été envoyé : la demande de confirmation est restée sans réponse. L'événement est enregistré, mais les participants n'ont pas été informés.");
  eq(calendarNotice("notSentFull", "Budget"), "Le message de réunion pour « Budget » n'a pas été envoyé : trop de messages sont en attente. L'événement est enregistré, mais les participants n'ont pas été informés.");
  eq(calendarNotice("notSentOld", "Budget"), "Le message de réunion pour « Budget » n'a pas été envoyé : il attendait depuis plus d'un jour. L'événement est enregistré, mais les participants n'ont pas été informés.");
  // The three "not sent" notices open and close like sendFailed, in every language: one family of messages.
  for (const lang of LOCALES) {
    const [head, tail] = CATALOGS[lang].calendarSendFailed.message.split("$REASON$");
    for (const key of ["calendarNotSentExpired", "calendarNotSentFull", "calendarNotSentOld"]) {
      const message = CATALOGS[lang][key].message;
      assert(message.startsWith(head) && message.endsWith(tail) && message.length > head.length + tail.length + 8, `${lang}: ${key}`);
    }
  }
});

test("translations: calendar notifications, chosen by name, the title cut short", async () => {
  const reason = sentence(errorText({ code: "NETWORK", message: "Serveur injoignable." }));
  eq(calendarNotice("sendFailed", "Budget", reason), "Le message de réunion pour « Budget » n'a pas été envoyé : Serveur injoignable. L'événement est enregistré, mais les participants n'ont pas été informés.");
  eq(calendarNotice("sendUncertain", "Budget"), "Le message de réunion pour « Budget » n'a peut-être pas été envoyé : la connexion a été perdue. Vérifiez le dossier Envoyés avant de le renvoyer.");
  eq(calendarNotice("tooManyAttendees", "Budget", 100), "« Budget » compte plus de 100 participants : Sync443 ne peut pas envoyer ses invitations. La modification a été annulée.");
  eq(calendarNotice("answerFailed", "Budget", reason), "Votre réponse à « Budget » n'a pas pu être envoyée : Serveur injoignable. L'événement est revenu à son état précédent.");
  eq(calendarNotice("tooLarge", ""), "« (sans titre) » est trop volumineux pour être enregistré sur le serveur. La modification a été annulée.");
  for (const name of ["", "invite", "errorAuth", "__proto__", "constructor", "toString", null, undefined, 3]) eq(calendarNotice(name, "Budget", "x"), "", String(name));
  // What happened must stay readable after a very long title.
  const long = calendarNotice("readOnly", `${"Très long titre ".repeat(100)}`);
  assert(long.startsWith("« Très long titre Très long titre") && long.endsWith("… » ne peut pas être modifié depuis Thunderbird. La modification a été annulée."), long);
  assert(long.length < 180, String(long.length));
  eq(calendarNotice("readOnly", "x".repeat(80)).includes("…"), false, "80 characters fit");
  // A surrogate pair is never cut in two.
  const cut = calendarNotice("readOnly", `${"x".repeat(78)}${String.fromCodePoint(0x1f600)}${"y".repeat(10)}`);
  assert(cut.isWellFormed() && cut.includes(`${"x".repeat(78)}…`), cut);
  await withLanguage("en", () => {
    const why = sentence(errorText({ code: "NETWORK", message: "Serveur injoignable." }));
    eq(calendarNotice("sendFailed", "Budget review", why), "The meeting message for “Budget review” was not sent: The server cannot be reached. The event is saved, but the attendees were not informed.");
    eq(calendarNotice("tooManyAttendees", "All hands", 100), "“All hands” has more than 100 attendees: Sync443 cannot send its invitations. The change was undone.");
    eq(calendarNotice("answerNeedsMail", "Budget review"), "Your answer to “Budget review” could not be sent: answering invitations on this server requires mail to be synchronized for this mailbox.");
  });
});

test("translations: every language shows the title, the reason and the limit of each calendar notification", async () => {
  for (const lang of LOCALES) {
    await withLanguage(lang, () => {
      for (const name of Object.keys(CALENDAR_NOTICE_KEYS)) {
        const text = calendarNotice(name, "Zq-Titre", name === "tooManyAttendees" || name === "keptLocalTooManyAttendees" ? 100 : "Zq-Raison.");
        assert(text.includes("Zq-Titre"), `${lang}: ${name}: ${text}`);
        if (name === "sendFailed" || name === "answerFailed") assert(text.includes("Zq-Raison."), `${lang}: ${name}: ${text}`);
        if (name === "tooManyAttendees" || name === "keptLocalTooManyAttendees") assert(text.includes("100"), `${lang}: ${name}: ${text}`);
        assert(/[.。]$/.test(text), `${lang}: ${name}: full stop: ${text}`);
        // The title stands between the language's own quotation marks, as in the other messages (removeQuestion).
        const quotes = /(\S)Zq-Titre(\S)|(\S) Zq-Titre (\S)/.exec(text);
        const pattern = t("removeQuestion", "Zq-Titre");
        const expected = /(\S)Zq-Titre(\S)|(\S) Zq-Titre (\S)/.exec(pattern);
        eq(quotes?.slice(1).filter(Boolean), expected?.slice(1).filter(Boolean), `${lang}: ${name}: quotation marks`);
      }
      for (const kind of Object.keys(MEETING_SUBJECT_KEYS)) {
        const subject = meetingSubject(kind, "Zq-Titre");
        assert(/^\S.*: Zq-Titre$/.test(subject), `${lang}: ${kind}: ${subject}`);
      }
      eq(new Set(Object.keys(MEETING_SUBJECT_KEYS).map((kind) => meetingSubject(kind, "x"))).size, 6, `${lang}: six different subjects`);
      assert(meetingText("when", "Zq").endsWith(": Zq") && meetingText("where", "Zq").endsWith(": Zq"), lang);
    });
  }
});

test("translations: settings form in English, calendar period and task filter", async () => {
  await withLanguage("en", () => {
    eq(CALENDAR_PERIODS.map(([, label]) => label()), ["2 weeks", "1 month", "3 months", "6 months", "All"]);
    eq(TASK_FILTERS.map(([, label]) => label()), ["All tasks", "Incomplete tasks only"]);
    eq([t("fieldCalendarPeriod"), t("fieldTaskFilter")], ["Calendar period", "Tasks to synchronize"]);
    const form = validateForm({ email: "a@example.com", password: "p", server: "mail.example.com", syncMinutes: "0", filterType: "5", calendarPeriod: "1", taskFilter: "4", sync: { calendar: true, tasks: true } });
    eq(form.errors.map((x) => x.message), ["Choose the calendar period to synchronize.", "Choose which tasks to synchronize."]);
    eq(t("kindsHint"), "In this version, contacts are not synchronized yet. This choice is saved for later.");
  });
});

