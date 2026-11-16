// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * The texts of the interface: browser.i18n, from _locales/<language>/messages.json.
 * The ten languages Thunderbird is most used in, English first and default.
 * Thunderbird picks the catalogue of its own language (or of the same
 * language for another country: es-AR → es_ES), English when there is none.
 *
 * Every key is written out where it is used, as t("key"), data-i18n="key"
 * (pages) or __MSG_key__ (manifest), so that tests/unit/i18n.test.mjs can find
 * it; the tables of keys below are exported for the same reason.
 *
 * What stays in French: the diagnostic log (log.mjs), and the reasons the
 * engine (transport, sync, experiments) gives with its failures. A failure is
 * shown by its code (ERROR_KEYS); the French catalogue shows the engine's own
 * reason, already French and more precise, and other languages can offer it
 * as a detail (errorDetail).
 */

import { cleanText } from "./core/sanitize.mjs";
import { TLS_MESSAGE_MAX } from "./core/tls-policy.mjs";

const api = () => globalThis.browser?.i18n ?? globalThis.messenger?.i18n ?? null;

/** The text of message `key`, its placeholders filled with `subs` in order; "" when there is none. */
export function t(key, ...subs) {
  try {
    const i18n = api();
    return (i18n && i18n.getMessage(key, subs.map((s) => String(s)))) || "";
  } catch {
    return ""; // a text that cannot be built never changes what happens (sending, saving)
  }
}

/** The language of Thunderbird's interface ("fr", "en-US"…), for dates and times. */
export function uiLanguage() {
  try {
    return api()?.getUILanguage?.() || "en";
  } catch {
    return "en";
  }
}

/** `text` ending with a full stop: "." added unless it already ends a sentence (also as Japanese and Chinese do). */
export const sentence = (text) => (/[.!?。！？]$/u.test(text) ? text : `${text}.`);

/** The page's texts: data-i18n="key" (text) and data-i18n-aria-label="key" (attribute). */
export function localizePage(doc) {
  doc.documentElement.lang = t("languageTag") || "en";
  for (const node of doc.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of doc.querySelectorAll("[data-i18n-aria-label]")) node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
}

// ── Failures ──────────────────────────────────────────────────────────────

/** Message of each failure code of the engine (transport/client.mjs ERR, sync SYNC_ERR, CLOSED). */
export const ERROR_KEYS = new Map([
  ["AUTH", "errorAuth"],
  ["DENIED", "errorDenied"],
  ["WIPE_REQUESTED", "errorWipe"],
  ["CONFIG", "errorConfig"],
  ["TLS", "errorTls"],
  ["PROXY_AUTH", "errorProxyAuth"],
  ["PROVISION", "errorProvision"],
  ["HTTP", "errorHttp"],
  ["BUSY", "errorBusy"],
  ["NETWORK", "errorNetwork"],
  ["TIMEOUT", "errorTimeout"],
  ["TOO_LARGE", "errorTooLarge"],
  ["BAD_RESPONSE", "errorBadResponse"],
  ["CANCELLED", "errorCancelled"],
  ["SERVER", "errorServer"],
  ["LOCAL", "errorLocal"],
  ["CLOSED", "errorClosed"],
]);
const OTHER_ERROR = "errorOther";

/**
 * Failures the background page raises itself, with a message of their own:
 * an EasError (and the health record it leaves) may name one as `key`.
 */
export const KEYED_ERRORS = new Set(["errorUnknownMailbox", "errorPasswordLocked", "errorPasswordAbsent"]);

/** The engine's reason, cut to one clean line (a certificate refusal is written to fit: core/tls-policy.mjs). */
const reasonOf = (error) =>
  cleanText(typeof error?.message === "string" ? error.message : "", { max: TLS_MESSAGE_MAX, singleLine: true, stripBidi: true }).trim();

/**
 * What to show for a failure: an EasError, or the { code, message, key? }
 * the health of a mailbox records. Chosen by `key` when it is one of
 * KEYED_ERRORS, by `code` otherwise; `fallbackKey` when that gives nothing.
 */
export function errorText(error, fallbackKey = "unexpectedError") {
  const key = typeof error?.key === "string" && KEYED_ERRORS.has(error.key) ? error.key : null;
  if (key) return t(key);
  const code = typeof error?.code === "string" ? error.code : "";
  return t(ERROR_KEYS.get(code) ?? OTHER_ERROR, reasonOf(error)) || t(fallbackKey);
}

/** The engine's French reason, as a detail, when `shownText` does not already contain it; "" otherwise. */
export function errorDetail(error, shownText) {
  const reason = reasonOf(error);
  return reason && !String(shownText).includes(reason) ? t("errorDetail", reason) : "";
}

/** Message of each ServerAddressError code (core/server.mjs); the value typed goes in $VALUE$. */
export const SERVER_ERROR_KEYS = new Map([
  ["EMPTY", "serverEmpty"],
  ["SPACE", "serverSpace"],
  ["SCHEME", "serverNotHttps"],
  ["CREDENTIALS", "serverCredentials"],
  ["INVALID", "serverInvalidValue"],
  ["PORT", "serverPortInvalid"],
]);

/** What to show for a server address refused by parseServer (a ServerAddressError, or anything else). */
export function serverErrorText(error) {
  const key = typeof error?.code === "string" ? SERVER_ERROR_KEYS.get(error.code) : undefined;
  return key ? t(key, typeof error.value === "string" ? error.value : "") : t("serverInvalid");
}
