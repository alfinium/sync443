// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Pure helpers of the settings page: choices, validation of the mailbox
 * form, and the texts shown for a mailbox and the log (i18n.mjs, in the
 * language of Thunderbird). No DOM here, so that everything is unit-tested.
 * The background checks everything again: these checks only give friendly
 * errors early.
 */

import { parseServer } from "../core/server.mjs";
import { cleanText } from "../core/sanitize.mjs";
import { SYNC_KINDS } from "../sync/store.mjs";
import { t, uiLanguage, errorText, errorDetail, serverErrorText, sentence } from "../i18n.mjs";

/** Sync frequency, in minutes (0 = as soon as a message arrives: Ping), and its label. */
export const FREQUENCIES = Object.freeze([
  [0, () => t("freqPush")],
  [1, () => t("freqEveryMinute")],
  [5, () => t("freqEveryMinutes", 5)],
  [15, () => t("freqEveryMinutes", 15)],
  [30, () => t("freqEveryMinutes", 30)],
  [60, () => t("freqEveryHour")],
]);

/** Period of mail kept in sync: ActiveSync FilterType ([MS-ASCMD] 2.2.3.68), and its label. */
export const PERIODS = Object.freeze([
  ["1", () => t("period1Day")],
  ["2", () => t("period3Days")],
  ["3", () => t("period1Week")],
  ["4", () => t("period2Weeks")],
  ["5", () => t("period1Month")],
  ["0", () => t("periodAll")],
]);

/** What a mailbox synchronises; `soon`: saved, not synchronised yet in this version. */
export const KINDS = Object.freeze([
  Object.freeze({ key: "mail", get label() { return t("kindMail"); }, soon: false }),
  Object.freeze({ key: "calendar", get label() { return t("kindCalendar"); }, soon: true }),
  Object.freeze({ key: "contacts", get label() { return t("kindContacts"); }, soon: true }),
  Object.freeze({ key: "tasks", get label() { return t("kindTasks"); }, soon: true }),
]);

export const DEFAULTS = Object.freeze({
  syncMinutes: 0,
  filterType: "5",
  sync: Object.freeze({ mail: true, calendar: true, contacts: true, tasks: true }),
});

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Characters that change the direction of the text, or cannot be seen.
const HIDDEN = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]/;

/** The fields in the order of the page: errors are listed (and the first one focused) in that order. */
export const FIELD_ORDER = Object.freeze(["email", "password", "name", "server", "username", "syncMinutes", "filterType", "sync"]);

/** Host permission covering one server (match patterns have no port). */
export const permissionPattern = (host) => `https://${host}/*`;

/** Error message for an e-mail address, or null when it can be used. */
export function emailError(email) {
  if (!email) return t("emailMissing");
  if (email.length > 254) return t("emailTooLong");
  if (CONTROL.test(email) || HIDDEN.test(email) || !email.isWellFormed() || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
    return t("emailInvalid");
  }
  return null;
}

/**
 * Check the form, as the user filled it.
 *
 * @param {object} values  { email, username, password, name, server, syncMinutes, filterType, sync }
 *        strings as read from the fields (syncMinutes too), sync: { mail, calendar, contacts, tasks } booleans
 * @param {object|null} existing  the mailbox being edited (as listed by the background), or null for a new one
 * @returns {{ ok: boolean, errors: {field: string, message: string}[],
 *             server: object|null, permission: string|null,
 *             request: { mailbox: object, password: string|null } | null }}
 */
export function validateForm(values, existing = null) {
  const errors = [];
  const error = (field, message) => errors.push({ field, message });
  const str = (v) => (typeof v === "string" ? v : "");

  const email = str(values.email).trim();
  const emailProblem = emailError(email);
  if (emailProblem) error("email", emailProblem);

  // The sign-in name, when it is not the address (DOMAINE\nom, for one). Empty: the address.
  const username = str(values.username).trim();
  if (username.length > 256) error("username", t("usernameTooLong"));
  else if (username.includes(":")) error("username", t("usernameColon"));
  else if (CONTROL.test(username) || HIDDEN.test(username) || !username.isWellFormed()) {
    error("username", t("usernameBadChar"));
  }

  let server = null;
  const serverText = str(values.server).trim();
  try {
    server = parseServer(serverText);
  } catch (e) {
    error("server", serverErrorText(e));
  }

  // The password goes with the origin and the sign-in name it was typed for.
  const signIn = (username || email).toLowerCase();
  const oldSignIn = existing ? String(existing.username || existing.email || "").toLowerCase() : "";
  const passwordRequired = !existing || (server !== null && server.origin !== existing.origin) || signIn !== oldSignIn;
  const password = str(values.password);
  if (!password) {
    if (passwordRequired) {
      error("password", existing ? t("passwordRetype") : t("passwordMissing"));
    }
  } else if (password.length > 1024) {
    error("password", t("passwordTooLong"));
  } else if (/[\u0000-\u001f\u007f]/.test(password) || !password.isWellFormed()) {
    error("password", t("passwordBadChar"));
  }

  const rawName = str(values.name);
  if (rawName.length > 256) error("name", t("nameTooLong"));
  const name = cleanText(rawName, { max: 256, singleLine: true, stripBidi: true }).trim() || email;

  const minutesText = String(values.syncMinutes ?? "").trim();
  const syncMinutes = minutesText === "" ? NaN : Number(minutesText);
  if (!FREQUENCIES.some(([m]) => m === syncMinutes)) {
    error("syncMinutes", t("chooseFrequency"));
  }
  const filterType = str(values.filterType);
  if (!PERIODS.some(([f]) => f === filterType)) error("filterType", t("choosePeriod"));

  const sync = Object.fromEntries(SYNC_KINDS.map((k) => [k, values.sync?.[k] === true]));
  if (!SYNC_KINDS.some((k) => sync[k])) error("sync", t("chooseKind"));

  if (errors.length) {
    errors.sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field));
    return { ok: false, errors, server, permission: null, request: null };
  }
  return {
    ok: true,
    errors,
    server,
    permission: permissionPattern(server.host),
    request: {
      mailbox: {
        id: existing?.id ?? null,
        email,
        username,
        name,
        server: server.display,
        syncMinutes,
        filterType,
        sync,
      },
      password: password || null,
    },
  };
}

/** Values of the form for a mailbox (edit), or the defaults (new). */
export function formValues(mailbox = null) {
  if (!mailbox) {
    return { email: "", username: "", password: "", name: "", server: "", syncMinutes: String(DEFAULTS.syncMinutes), filterType: DEFAULTS.filterType, sync: { ...DEFAULTS.sync } };
  }
  const sync = Object.fromEntries(SYNC_KINDS.map((k) => [k, mailbox.sync?.[k] === true]));
  return {
    email: str2(mailbox.email),
    username: str2(mailbox.username),
    password: "",
    name: str2(mailbox.name),
    server: str2(mailbox.server),
    syncMinutes: String(FREQUENCIES.some(([m]) => m === mailbox.syncMinutes) ? mailbox.syncMinutes : DEFAULTS.syncMinutes),
    filterType: PERIODS.some(([f]) => f === mailbox.filterType) ? mailbox.filterType : DEFAULTS.filterType,
    sync,
  };
}

const str2 = (v) => (typeof v === "string" ? v : "");

// ── Texts shown for a mailbox ─────────────────────────────────────────────

export const frequencyLabel = (minutes) => FREQUENCIES.find(([m]) => m === minutes)?.[1]() ?? t("freqEveryMinutes", minutes);
export const periodLabel = (filterType) => PERIODS.find(([f]) => f === filterType)?.[1]() ?? t("periodUnknown");

export function kindsLabel(sync) {
  const chosen = KINDS.filter((k) => sync?.[k.key] === true).map((k) => (k.soon ? t("kindSoon", k.label) : k.label));
  return chosen.length ? chosen.join(", ") : t("kindsNone");
}

const pad = (n) => String(n).padStart(2, "0");

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Intl formatting in the interface's language; `fallback` where Intl is missing. */
function intl(d, options, fallback) {
  try {
    return new Intl.DateTimeFormat(uiLanguage(), options).format(d);
  } catch {
    return fallback;
  }
}

/**
 * Local time, as the interface's language writes it: today, the time
 * ("14:05" in French); this year, the day and the time ("12/11 à 14:05");
 * otherwise, with the year ("12/11/2025 à 14:05").
 */
export function formatTime(ms, now = Date.now()) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const n = new Date(now);
  const time = intl(d, { hour: "2-digit", minute: "2-digit" }, `${pad(d.getHours())}:${pad(d.getMinutes())}`);
  if (sameDay(d, n)) return time;
  const day =
    d.getFullYear() === n.getFullYear()
      ? intl(d, { day: "2-digit", month: "2-digit" }, `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`)
      : intl(d, { day: "2-digit", month: "2-digit", year: "numeric" }, `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`);
  return t("dateAtTime", day, time);
}

/** Text shown, cut to one line of reasonable length (it may come from the server, already cleaned). */
export const shown = (s, max = 300) => cleanText(typeof s === "string" ? s : "", { max, singleLine: true, stripBidi: true }).trim();

/** Asked before "Keep the local copies" (discardDeletes). */
export const discardConfirm = () => t("discardConfirm");

/** "3 messages could not be imported…", or "" for none. */
export function failedText(count) {
  if (!Number.isSafeInteger(count) || count <= 0) return "";
  return count === 1 ? t("failedOne") : t("failedMany", count);
}

/**
 * Status of a mailbox, from the `status` the background lists, followed by
 * the number of messages whose import keeps failing (status.failedItems).
 * → { tone: "ok" | "running" | "error" | "blocked" | "idle", text, massDelete: number | null, detail? }
 * massDelete: number of deletions held back by the mass-deletion threshold, waiting for the user.
 * detail: after a failure, the engine's French reason when the text does not show it (a tooltip).
 */
export function statusView(status, now = Date.now()) {
  const s = status && typeof status === "object" ? status : {};
  const view = baseView(s, now);
  const failed = failedText(s.failedItems);
  return failed ? { ...view, text: `${view.text} ${failed}` } : view;
}

/** `view` with the failure's French reason as `detail`, when its text does not show it already. */
function withDetail(view, failure) {
  const detail = errorDetail(failure, view.text);
  return detail ? { ...view, detail } : view;
}

function baseView(s, now) {
  const count = Number.isSafeInteger(s.pendingDeletes) && s.pendingDeletes > 0 ? s.pendingDeletes : 0;
  if (s.blocked && typeof s.blocked === "object") {
    if (s.blocked.code === "MASS_DELETE") {
      return { tone: "blocked", text: count ? t("statusMassDelete", count) : t("statusMassDeleteMany"), massDelete: count };
    }
    const why = sentence(errorText(s.blocked, "statusSeriousError"));
    return withDetail({ tone: "blocked", text: t("statusBlocked", why), massDelete: null }, s.blocked);
  }
  if (s.running === true) return { tone: "running", text: t("syncRunning"), massDelete: null };
  if (s.lastError && typeof s.lastError === "object") {
    const why = sentence(errorText(s.lastError, "statusErrorUnknown"));
    const retry = Number.isFinite(s.nextAttemptAt) && s.nextAttemptAt > now ? ` ${t("statusRetryAt", formatTime(s.nextAttemptAt, now))}` : "";
    return withDetail({ tone: "error", text: `${t("statusError", why)}${retry}`, massDelete: null }, s.lastError);
  }
  if (Number.isFinite(s.lastSuccessAt) && s.lastSuccessAt > 0) {
    const at = formatTime(s.lastSuccessAt, now);
    return { tone: "ok", text: sameDay(new Date(s.lastSuccessAt), new Date(now)) ? t("statusSyncedAt", at) : t("statusSyncedOn", at), massDelete: null };
  }
  return { tone: "idle", text: t("statusNever"), massDelete: null };
}

// ── Log ───────────────────────────────────────────────────────────────────

/** Name of a log level, in the interface's language (the entries themselves are French). */
function levelName(level) {
  switch (level) {
    case "error":
      return t("levelError");
    case "warn":
      return t("levelWarn");
    case "debug":
      return t("levelDebug");
    default:
      return t("levelInfo");
  }
}

/** The log as text, newest first: "2026-11-15 14:05:09  error     Mot de passe refusé." */
export function logText(entries) {
  if (!Array.isArray(entries) || !entries.length) return t("logEmpty");
  const lines = [];
  for (const e of [...entries].reverse()) {
    if (!e || typeof e !== "object" || !Number.isFinite(e.t)) continue;
    const d = new Date(e.t);
    const day = [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n, k) => (k ? pad(n) : String(n))).join("-");
    const time = [d.getHours(), d.getMinutes(), d.getSeconds()].map(pad).join(":");
    const stamp = `${day} ${time}`;
    lines.push(`${stamp}  ${levelName(e.level).padEnd(8)}  ${shown(e.msg)}`);
    if (typeof e.details === "string" && e.details) {
      const details = cleanText(e.details, { max: 4000, stripBidi: true });
      for (const line of details.split("\n")) lines.push(`      ${line}`);
    }
  }
  return lines.join("\n");
}

/** "Active until 15:05." or "" when debugging is off. */
export function debugText(debugUntil, now = Date.now()) {
  if (!Number.isFinite(debugUntil) || debugUntil <= now) return "";
  return t("debugActiveUntil", formatTime(debugUntil, now));
}
