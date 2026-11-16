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
 *    the French catalogue showing the engine's own reason.
 */

import { test, eq, assert } from "./harness.mjs";
import { CATALOGS, LOCALES, DEFAULT_LOCALE, readText, render, withLanguage, tagOf } from "./i18n-fake.mjs";
import { t, errorText, errorDetail, serverErrorText, ERROR_KEYS, KEYED_ERRORS, SERVER_ERROR_KEYS } from "../../src/i18n.mjs";
import { statusView, formatTime, frequencyLabel, periodLabel, kindsLabel, logText, validateForm, debugText } from "../../src/options/form.mjs";
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
  for (const path of ["background.mjs", "send.mjs", "i18n.mjs", "options/options.html", "options/options.mjs", "options/form.mjs", "core/server.mjs", "log.mjs"]) {
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
  eq(t("removeQuestion", "Travail"), "Supprimer la boîte « Travail » ? Son compte, ses dossiers locaux et son mot de passe seront retirés de Thunderbird. Rien n'est supprimé sur le serveur.");
  await withLanguage("en", () => {
    eq(t("addMailbox"), "Add a mailbox");
    eq(t("removeQuestion", "Work"), "Remove the mailbox “Work”? Its account, its local folders and its password will be removed from Thunderbird. Nothing is deleted on the server.");
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
    eq(kindsLabel({ mail: true, calendar: true }), "Mail, Calendar (coming soon)");
    eq(statusView({}, now).text, "Not synchronized yet.");
    eq(statusView({ running: true }, now).text, "Synchronizing…");
    eq(statusView({ blocked: { code: "MASS_DELETE" }, pendingDeletes: 120 }, now).text.startsWith("Synchronization paused: the server deleted 120 messages at once."), true);
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
        t("sendReasonRefused", t("sendStatus116"), "116"),
        t("sendFailedDraft", t("sendReasonTooLarge", 50)),
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
