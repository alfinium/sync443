// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * browser.i18n for the unit tests, from the extension's own catalogues
 * (src/_locales/<language>/messages.json), so that the tests check the
 * texts users really see. getMessage follows the WebExtension rules:
 * message names are case-insensitive, $NAME$ is replaced by its
 * placeholder's content, $1…$9 by the substitutions, $$ by $. Unlike
 * Thunderbird, it throws when a key is unknown or a substitution is missing:
 * a test then fails instead of showing an empty text.
 *
 *   installI18n("fr");                       // globalThis.browser.i18n, for src/i18n.mjs
 *   await withLanguage("en", async () => { … });
 */

/** Text of a file, relative to tests/unit (jsc: readFile; Node, Bun: fs; Deno: Deno.readTextFileSync). */
export async function readText(path) {
  if (typeof globalThis.readFile === "function") return globalThis.readFile(path);
  if (typeof globalThis.Deno?.readTextFileSync === "function") return globalThis.Deno.readTextFileSync(path);
  const fs = await import("node:fs");
  return fs.readFileSync(path, "utf8");
}

/**
 * The translations (folders of src/_locales, Thunderbird's locale codes): the ten
 * languages Thunderbird is most used in (stats.thunderbird.net, locales.json),
 * English first, the default. tools/build_xpi.py checks every folder there is
 * against English as well (this engine cannot list a directory).
 */
export const LOCALES = Object.freeze(["en", "ru", "de", "es_ES", "ja", "pl", "fr", "it", "pt_BR", "cs"]);
export const DEFAULT_LOCALE = "en";

/** "pt_BR" → "pt-BR": the BCP 47 tag of a folder. */
export const tagOf = (folder) => folder.replace("_", "-");

/** { language: { key: { message, placeholders?, description? } } }, as written in the files. */
export const CATALOGS = {};
for (const lang of LOCALES) CATALOGS[lang] = JSON.parse(await readText(`../../src/_locales/${lang}/messages.json`));

/** The message `entry` with its placeholders and substitutions filled in (in one pass: a substitution is never read again). */
export function render(entry, subs = []) {
  const args = (Array.isArray(subs) ? subs : [subs]).map((s) => String(s));
  const placeholders = new Map(Object.entries(entry.placeholders ?? {}).map(([name, p]) => [name.toLowerCase(), String(p.content)]));
  const arg = (n) => {
    if (Number(n) > args.length) throw new Error(`substitution $${n} manquante`);
    return args[Number(n) - 1];
  };
  const positional = (text) => text.replace(/\$(\$|[1-9])/g, (_, n) => (n === "$" ? "$" : arg(n)));
  return String(entry.message).replace(/\$([A-Za-z0-9_@]+)\$|\$(\$|[1-9])/g, (whole, name, n) => {
    if (n !== undefined) return n === "$" ? "$" : arg(n);
    const content = placeholders.get(name.toLowerCase());
    if (content === undefined) throw new Error(`paramètre ${whole} non déclaré`);
    return positional(content);
  });
}

/** A browser.i18n of one language, by its folder (the default language fills in missing keys, as Thunderbird does). */
export function fakeI18n(lang = "fr") {
  const index = (catalog) => new Map(Object.entries(catalog).map(([k, v]) => [k.toLowerCase(), v]));
  const own = index(CATALOGS[lang]);
  const fallback = index(CATALOGS[DEFAULT_LOCALE]);
  return {
    getUILanguage: () => tagOf(lang),
    getMessage(key, subs = []) {
      const entry = own.get(String(key).toLowerCase()) ?? fallback.get(String(key).toLowerCase());
      if (!entry) throw new Error(`message inconnu : ${key}`);
      return render(entry, subs);
    },
  };
}

/** browser.i18n of `lang` for src/i18n.mjs (globalThis.browser is created if there is none). */
export function installI18n(lang = "fr") {
  if (!globalThis.browser || typeof globalThis.browser !== "object") globalThis.browser = {};
  globalThis.browser.i18n = fakeI18n(lang);
}

/** Run `fn` with the interface in `lang`, then go back to French. */
export async function withLanguage(lang, fn) {
  installI18n(lang);
  try {
    return await fn();
  } finally {
    installI18n("fr");
  }
}
