// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Pure helpers of the settings page: choices, validation of the mailbox
 * form, and the French texts shown for a mailbox and the log. No DOM here,
 * so that everything is unit-tested. The background checks everything
 * again: these checks only give friendly errors early.
 */

import { parseServer, ServerAddressError } from "../core/server.mjs";
import { cleanText } from "../core/sanitize.mjs";
import { SYNC_KINDS } from "../sync/store.mjs";

/** Sync frequency, in minutes; 0 = as soon as a message arrives (Ping). */
export const FREQUENCIES = Object.freeze([
  [0, "Dès réception"],
  [1, "Toutes les minutes"],
  [5, "Toutes les 5 minutes"],
  [15, "Toutes les 15 minutes"],
  [30, "Toutes les 30 minutes"],
  [60, "Toutes les heures"],
]);

/** Period of mail kept in sync: ActiveSync FilterType ([MS-ASCMD] 2.2.3.68). */
export const PERIODS = Object.freeze([
  ["1", "1 jour"],
  ["2", "3 jours"],
  ["3", "1 semaine"],
  ["4", "2 semaines"],
  ["5", "1 mois"],
  ["0", "Tout"],
]);

/** What a mailbox synchronises; `soon`: saved, not synchronised yet in this version. */
export const KINDS = Object.freeze([
  { key: "mail", label: "Courrier", soon: false },
  { key: "calendar", label: "Agenda", soon: true },
  { key: "contacts", label: "Contacts", soon: true },
  { key: "tasks", label: "Tâches", soon: true },
]);

export const DEFAULTS = Object.freeze({
  syncMinutes: 0,
  filterType: "5",
  sync: Object.freeze({ mail: true, calendar: true, contacts: true, tasks: true }),
});

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /\p{Cs}/u;
// Characters that change the direction of the text, or cannot be seen.
const HIDDEN = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]/;

/** Host permission covering one server (match patterns have no port). */
export const permissionPattern = (host) => `https://${host}/*`;

/** Error message for an e-mail address, or null when it can be used. */
export function emailError(email) {
  if (!email) return "Indiquez l'adresse e-mail.";
  if (email.length > 254) return "Adresse e-mail trop longue.";
  if (CONTROL.test(email) || HIDDEN.test(email) || LONE_SURROGATE.test(email) || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
    return "Adresse e-mail invalide, par exemple : prenom.nom@exemple.com.";
  }
  return null;
}

/**
 * Check the form, as the user filled it.
 *
 * @param {object} values  { email, username, password, name, server, syncMinutes, filterType, sync }
 *        strings as read from the fields (syncMinutes too), sync: { mail, calendar, contacts, tasks } booleans
 * @param {object|null} existing  the mailbox being edited (as listed by the background), or null for a new one
 * @returns {{ ok: boolean, errors: {field: string, message: string}[], passwordRequired: boolean,
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
  if (username.length > 256) error("username", "Identifiant trop long (256 caractères au plus).");
  else if (username.includes(":")) error("username", "L'identifiant ne doit pas contenir de deux-points ( : ).");
  else if (CONTROL.test(username) || HIDDEN.test(username) || LONE_SURROGATE.test(username)) {
    error("username", "L'identifiant contient un caractère non autorisé.");
  }

  let server = null;
  const serverText = str(values.server).trim();
  try {
    server = parseServer(serverText);
  } catch (e) {
    error("server", e instanceof ServerAddressError ? e.message : "Serveur invalide.");
  }

  // The password goes with the origin and the sign-in name it was typed for.
  const signIn = (username || email).toLowerCase();
  const oldSignIn = existing ? String(existing.username || existing.email || "").toLowerCase() : "";
  const passwordRequired = !existing || (server !== null && server.origin !== existing.origin) || signIn !== oldSignIn;
  const password = str(values.password);
  if (!password) {
    if (passwordRequired) {
      error(
        "password",
        existing ? "Le serveur ou l'identifiant a changé : retapez le mot de passe." : "Indiquez le mot de passe.",
      );
    }
  } else if (password.length > 1024) {
    error("password", "Mot de passe trop long.");
  } else if (/[\u0000-\u001f\u007f]/.test(password) || LONE_SURROGATE.test(password)) {
    error("password", "Le mot de passe contient un caractère non autorisé.");
  }

  const rawName = str(values.name);
  if (rawName.length > 256) error("name", "Nom trop long (256 caractères au plus).");
  const name = cleanText(rawName, { max: 256, singleLine: true, stripBidi: true }).trim() || email;

  const minutesText = String(values.syncMinutes ?? "").trim();
  const syncMinutes = minutesText === "" ? NaN : Number(minutesText);
  if (!FREQUENCIES.some(([m]) => m === syncMinutes)) {
    error("syncMinutes", "Choisissez une fréquence de synchronisation.");
  }
  const filterType = str(values.filterType);
  if (!PERIODS.some(([f]) => f === filterType)) error("filterType", "Choisissez la période de courrier à synchroniser.");

  const sync = Object.fromEntries(SYNC_KINDS.map((k) => [k, values.sync?.[k] === true]));
  if (!SYNC_KINDS.some((k) => sync[k])) error("sync", "Choisissez au moins un élément à synchroniser.");

  if (errors.length) return { ok: false, errors, passwordRequired, server, permission: null, request: null };
  return {
    ok: true,
    errors,
    passwordRequired,
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
    server: str2(mailbox.server) || hostOf(mailbox.origin),
    syncMinutes: String(FREQUENCIES.some(([m]) => m === mailbox.syncMinutes) ? mailbox.syncMinutes : DEFAULTS.syncMinutes),
    filterType: PERIODS.some(([f]) => f === mailbox.filterType) ? mailbox.filterType : DEFAULTS.filterType,
    sync,
  };
}

const str2 = (v) => (typeof v === "string" ? v : "");
const hostOf = (origin) => (typeof origin === "string" ? origin.replace(/^https:\/\//, "") : "");

// ── Texts shown for a mailbox ─────────────────────────────────────────────

export const frequencyLabel = (minutes) => FREQUENCIES.find(([m]) => m === minutes)?.[1] ?? `Toutes les ${minutes} minutes`;
export const periodLabel = (filterType) => PERIODS.find(([f]) => f === filterType)?.[1] ?? "Inconnue";

export function kindsLabel(sync) {
  const chosen = KINDS.filter((k) => sync?.[k.key] === true).map((k) => (k.soon ? `${k.label} (bientôt)` : k.label));
  return chosen.length ? chosen.join(", ") : "Rien";
}

const pad = (n) => String(n).padStart(2, "0");

/** "14:05" today, "12/11 à 14:05" this year, "12/11/2025 à 14:05" otherwise (local time). */
export function formatTime(ms, now = Date.now()) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const n = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return time;
  const day = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  return d.getFullYear() === n.getFullYear() ? `${day} à ${time}` : `${day}/${d.getFullYear()} à ${time}`;
}

/** Text shown, cut to one line of reasonable length (it may come from the server, already cleaned). */
const shown = (s, max = 300) => cleanText(typeof s === "string" ? s : "", { max, singleLine: true, stripBidi: true }).trim();

/**
 * Status of a mailbox, from the `status` the background lists.
 * → { tone: "ok" | "running" | "error" | "blocked" | "idle", text, massDelete: number | null }
 * massDelete: number of deletions held back by the mass-deletion threshold, waiting for the user.
 */
export function statusView(status, now = Date.now()) {
  const s = status && typeof status === "object" ? status : {};
  const count = Number.isSafeInteger(s.pendingDeletes) && s.pendingDeletes > 0 ? s.pendingDeletes : 0;
  if (s.blocked && typeof s.blocked === "object") {
    if (s.blocked.code === "MASS_DELETE") {
      return {
        tone: "blocked",
        text: `Synchronisation suspendue : le serveur a supprimé ${count || "beaucoup de"} messages d'un coup. Ces suppressions ne seront appliquées qu'après votre confirmation.`,
        massDelete: count,
      };
    }
    const why = shown(s.blocked.message) || "erreur grave.";
    const end = /[.!?]$/.test(why) ? "" : ".";
    return { tone: "blocked", text: `Arrêtée : ${why}${end} Rien ne sera tenté automatiquement : cliquez sur « Synchroniser » pour reprendre.`, massDelete: null };
  }
  if (s.running === true) return { tone: "running", text: "Synchronisation en cours…", massDelete: null };
  if (s.lastError && typeof s.lastError === "object") {
    const why = shown(s.lastError.message) || "erreur";
    const retry = Number.isFinite(s.nextAttemptAt) && s.nextAttemptAt > now ? ` Nouvel essai à ${formatTime(s.nextAttemptAt, now)}.` : "";
    return { tone: "error", text: `Erreur : ${why}${/[.!?]$/.test(why) ? "" : "."}${retry}`, massDelete: null };
  }
  if (Number.isFinite(s.lastSuccessAt) && s.lastSuccessAt > 0) {
    const t = formatTime(s.lastSuccessAt, now);
    return { tone: "ok", text: /^\d\d:\d\d$/.test(t) ? `Synchronisée à ${t}.` : `Synchronisée le ${t}.`, massDelete: null };
  }
  return { tone: "idle", text: "Pas encore synchronisée.", massDelete: null };
}

// ── Log ───────────────────────────────────────────────────────────────────

const LEVEL_NAMES = new Map([
  ["error", "erreur"],
  ["warn", "alerte"],
  ["info", "info"],
  ["debug", "débogage"],
]);

/** The log as text, newest first: "2026-11-15 14:05:09  erreur  Mot de passe refusé." */
export function logText(entries) {
  if (!Array.isArray(entries) || !entries.length) return "Le journal est vide.";
  const lines = [];
  for (const e of [...entries].reverse()) {
    if (!e || typeof e !== "object" || !Number.isFinite(e.t)) continue;
    const d = new Date(e.t);
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    lines.push(`${stamp}  ${(LEVEL_NAMES.get(e.level) ?? "info").padEnd(8)}  ${shown(e.msg)}`);
    if (typeof e.details === "string" && e.details) {
      const details = cleanText(e.details, { max: 4000, stripBidi: true });
      for (const line of details.split("\n")) lines.push(`      ${line}`);
    }
  }
  return lines.join("\n");
}

/** "Actif jusqu'à 15:05." or "" when debugging is off. */
export function debugText(debugUntil, now = Date.now()) {
  if (!Number.isFinite(debugUntil) || debugUntil <= now) return "";
  return `Actif jusqu'à ${formatTime(debugUntil, now)}.`;
}
