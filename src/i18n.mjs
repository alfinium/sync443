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
 * it; the tables of keys below are exported for the same reason. A message
 * chosen from a table is built here (errorText, meetingSubject,
 * calendarNotice…): everywhere else, t() takes a key written out.
 *
 * What stays in French: the diagnostic log (log.mjs), and the reasons the
 * engine (transport, sync, experiments) gives with its failures. A failure is
 * shown by its code (ERROR_KEYS); the French catalogue shows the engine's own
 * reason, already French and more precise, and other languages can offer it
 * as a detail (errorDetail).
 */

import { cleanText, cut } from "./core/sanitize.mjs";
import { TLS_MESSAGE_MAX } from "./core/tls-policy.mjs";

/**
 * Characters nobody sees, removed from everything shown here: bidirectional
 * marks, overrides and isolates, zero-width characters and joiners, the soft
 * hyphen, invisible operators, interlinear annotations, the two
 * noncharacters of the basic plane and tags. Written by their numbers, so
 * that none of them is ever in this file.
 */
const UNSEEN = (() => {
  const one = (code) => String.fromCodePoint(code);
  const span = (from, to) => `${one(from)}-${one(to)}`;
  const set = [one(0xad), one(0x34f), one(0x61c), one(0x180e), span(0x200b, 0x200f), span(0x202a, 0x202e), span(0x2060, 0x206f), one(0xfeff), span(0xfff9, 0xfffb), span(0xfffe, 0xffff), span(0xe0000, 0xe007f)];
  return new RegExp(`[${set.join("")}]`, "gu");
})();

/**
 * A text from outside (a title, a place, a reason) as it is shown: one
 * line of at most `max` characters, without control, bidirectional or
 * invisible character. This cleaning is the interface's own: what is shown
 * never relies on what the readers of the server's items let through (they
 * keep U+200C and U+200D in titles and places, which nothing here shows).
 */
export function cleanLine(value, max = 1024) {
  if (typeof value !== "string") return "";
  // Lone surrogates are replaced first: what is searched next is text, in which no half character can hide another.
  const line = cleanText(value.toWellFormed(), { max: value.length, singleLine: true }).replace(UNSEEN, "");
  return cut(line, max);
}

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
const reasonOf = (error) => cleanLine(typeof error?.message === "string" ? error.message : "", TLS_MESSAGE_MAX).trim();

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

// ── Calendar and meetings ─────────────────────────────────────────────────

/** The table's key for `name`, or null: only the table's own names answer (the tables have no prototype). */
const keyOf = (table, name) => (typeof name === "string" && Object.hasOwn(table, name) ? table[name] : null);

/**
 * Subject of each meeting message Sync443 writes, by kind: the three the
 * organizer sends to the attendees, and the three answers an attendee sends
 * to the organizer. The event's title goes in $SUMMARY$.
 */
export const MEETING_SUBJECT_KEYS = Object.freeze({
  __proto__: null,
  invite: "meetingSubjectInvite",
  update: "meetingSubjectUpdate",
  cancel: "meetingSubjectCancel",
  accepted: "meetingSubjectAccepted",
  tentative: "meetingSubjectTentative",
  declined: "meetingSubjectDeclined",
});

/** Lines of the plain-text part of a meeting message ($WHEN$, $LOCATION$), and what stands for a missing title. */
export const MEETING_TEXT_KEYS = Object.freeze({
  __proto__: null,
  when: "meetingTextWhen",
  where: "meetingTextWhere",
  noTitle: "meetingNoTitle",
});

/**
 * Notification of each calendar or meeting event the user is told of, by
 * name. Every message takes the item's title ($SUMMARY$) first; sendFailed
 * and answerFailed then take why ($REASON$, a sentence ending with a full
 * stop), tooManyAttendees and keptLocalTooManyAttendees the largest number
 * allowed ($MAX$).
 */
export const CALENDAR_NOTICE_KEYS = Object.freeze({
  __proto__: null,
  sendFailed: "calendarSendFailed",
  sendUncertain: "calendarSendUncertain",
  tooManyAttendees: "calendarTooManyAttendees",
  answerFailed: "calendarAnswerFailed",
  answerNoInvitation: "calendarAnswerNoInvitation",
  answerNeedsMail: "calendarAnswerNeedsMail",
  changeRefused: "calendarChangeRefused",
  recurrenceUnsupported: "calendarRecurrenceUnsupported",
  readOnly: "calendarReadOnly",
  tooLarge: "calendarTooLarge",
  keptLocal: "calendarKeptLocal",
  serverChanged: "calendarServerChanged",
  detached: "calendarDetached",
  restoreUnsupported: "calendarRestoreUnsupported",
  organizerChanged: "calendarOrganizerChanged",
  notSentExpired: "calendarNotSentExpired",
  notSentFull: "calendarNotSentFull",
  notSentOld: "calendarNotSentOld",
  replyNotSent: "calendarReplyNotSent",
  keptLocalTooManyAttendees: "calendarKeptLocalTooManyAttendees",
  keptLocalRecurrence: "calendarKeptLocalRecurrence",
  keptLocalTooLarge: "calendarKeptLocalTooLarge",
});

/**
 * Notifications that tell a number of items and name none, by name: the
 * message for one, and the message for several, which takes the number
 * ($COUNT$).
 */
export const CALENDAR_COUNT_NOTICE_KEYS = Object.freeze({
  __proto__: null,
  changesDropped: Object.freeze({ __proto__: null, one: "calendarChangesDroppedOne", many: "calendarChangesDroppedMany" }),
});

/** Largest number a notification tells. */
const NOTICE_COUNT_MAX = 999_999;

/** A title in a notification: short enough for what follows it to be read. */
const NOTICE_TITLE_MAX = 80;
/** Longest reason a notification gives (the reasons of the engine are far shorter). */
const NOTICE_DETAIL_MAX = 400;

/** The title shown for an event or a task: one clean line of at most `max` characters, "(no title)" when it has none. */
export function itemTitle(summary, max = 1024) {
  return cleanLine(summary, max).trim() || t("meetingNoTitle");
}

/** Subject of a meeting message, "Invitation: Budget review"; "" when `kind` is not one of MEETING_SUBJECT_KEYS. */
export function meetingSubject(kind, summary) {
  const key = keyOf(MEETING_SUBJECT_KEYS, kind);
  return key ? t(key, itemTitle(summary)) : "";
}

/**
 * A text of MEETING_TEXT_KEYS: meetingText("when", "16/11/2026 14:30"), meetingText("where", "Room 2"), meetingText("noTitle");
 * "" for another name. The value is shown as one clean line (cleanLine).
 */
export function meetingText(name, value = "") {
  const key = keyOf(MEETING_TEXT_KEYS, name);
  return key ? t(key, cleanLine(String(value ?? ""))) : "";
}

/** The number of a notification: a whole number from 1 on, given as a number or in digits; null otherwise. */
function noticeCount(value) {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 ? Math.min(n, NOTICE_COUNT_MAX) : null;
}

/**
 * Text of a calendar notification: calendarNotice("sendFailed", summary, reason),
 * calendarNotice("tooManyAttendees", summary, 100), calendarNotice("readOnly", summary).
 * The title is cut to one short line, and so is the detail.
 *
 * A notification of CALENDAR_COUNT_NOTICE_KEYS takes no title and a number:
 * calendarNotice("changesDropped", "", 3). One has a message of its own;
 * a number that is not a whole number from 1 on tells nothing.
 *
 * → "" when `name` is in neither table, or when there is nothing to tell.
 */
export function calendarNotice(name, summary, detail = "") {
  const counted = keyOf(CALENDAR_COUNT_NOTICE_KEYS, name);
  if (counted) {
    const count = noticeCount(detail);
    if (count === null) return "";
    return count === 1 ? t(counted.one) : t(counted.many, count);
  }
  const key = keyOf(CALENDAR_NOTICE_KEYS, name);
  if (!key) return "";
  const title = itemTitle(summary);
  const shown = title.length > NOTICE_TITLE_MAX ? `${cut(title, NOTICE_TITLE_MAX - 1).trimEnd()}…` : title;
  return t(key, shown, cleanLine(String(detail ?? ""), NOTICE_DETAIL_MAX));
}
