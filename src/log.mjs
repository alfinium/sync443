// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * The extension's own log, shown in the settings page ("Diagnostic").
 *
 * Privacy first (docs/SECURITY-MODEL.md, rule 13):
 *  - messages are short French sentences written by the extension. Callers
 *    never put message content, subjects, addresses or names in them; this
 *    module cannot tell, but it caps every entry and strips control,
 *    bidirectional and invisible characters, so an entry is always one
 *    plain line;
 *  - debug entries (technical values only: statuses, keys, ids) are
 *    recorded only while debugging is on, and debugging switches itself off
 *    after at most one hour. The deadline is stored (`settings.debugUntil`,
 *    milliseconds since the epoch), so a restart neither extends it nor
 *    forgets it.
 *
 * Entries: { t: ms since the epoch, level: "error" | "warn" | "info" | "debug",
 * msg, details? } (details on debug entries only), oldest first, in a ring
 * of MAX_ENTRIES. The ring is stored under the key "log" of
 * browser.storage.local, written at most once per WRITE_DELAY_MS.
 *
 *   import { log } from "./log.mjs";
 *   await log.load();                    // once, at start-up
 *   log.info("Synchronisation terminée.");
 *   if (log.debugEnabled) log.debug("FolderSync", "Status 1");
 */

import { cleanText } from "./core/sanitize.mjs";

export const MAX_ENTRIES = 300;
export const MAX_MESSAGE = 300; // characters of a message
export const MAX_DETAILS = 4000; // characters of the details of a debug entry
export const MAX_DEBUG_MS = 3_600_000; // debugging never lasts more than one hour
export const WRITE_DELAY_MS = 1000;
export const LOG_KEY = "log";
export const SETTINGS_KEY = "settings";

const LEVELS = new Set(["error", "warn", "info", "debug"]);

const cleanMessage = (value) =>
  cleanText(typeof value === "string" ? value : String(value ?? ""), { max: MAX_MESSAGE, singleLine: true, stripBidi: true }).trim() ||
  "(message vide)";

function cleanDetails(value) {
  let s = value;
  if (typeof s !== "string") {
    try {
      s = JSON.stringify(s) ?? "";
    } catch {
      s = String(s);
    }
  }
  return cleanText(s, { max: MAX_DETAILS, stripBidi: true });
}

/** A stored entry, checked and cleaned again (storage is not trusted blindly), or null. */
function checkEntry(e) {
  if (!e || typeof e !== "object" || !Number.isFinite(e.t) || !LEVELS.has(e.level) || typeof e.msg !== "string") return null;
  const entry = { t: e.t, level: e.level, msg: cleanMessage(e.msg) };
  if (e.level === "debug" && typeof e.details === "string" && e.details) entry.details = cleanDetails(e.details);
  return entry;
}

const isPlainObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * @param {object} [o]
 * @param {object|null} [o.area]  browser.storage.local, or a double with get/set; by default the
 *        extension's own (looked up when needed); without one the log lives in memory only
 * @param {() => number} [o.now]
 * @param {(fn: Function, ms: number) => any} [o.schedule]  setTimeout, or a double
 */
export function createLog({ area, now = () => Date.now(), schedule } = {}) {
  const storage = () => (area !== undefined ? area : globalThis.browser?.storage?.local ?? globalThis.messenger?.storage?.local ?? null);
  const later = schedule ?? (typeof globalThis.setTimeout === "function" ? (fn, ms) => globalThis.setTimeout(fn, ms) : null);

  let entries = [];
  let debugUntil = 0;
  let dirty = false;
  let scheduled = false;
  let chain = Promise.resolve(); // storage writes, in order

  const trim = () => {
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  };

  /** Write the ring now (if it changed), after any write already under way. */
  const persist = () => {
    chain = chain.then(async () => {
      const s = storage();
      if (!dirty || !s) return;
      dirty = false;
      try {
        await s.set({ [LOG_KEY]: entries.map((e) => ({ ...e })) });
      } catch {
        dirty = true; // kept for the next attempt; logging never throws
      }
    });
    return chain;
  };

  const touch = () => {
    dirty = true;
    if (scheduled || !storage()) return;
    if (!later) {
      persist();
      return;
    }
    scheduled = true;
    later(() => {
      scheduled = false;
      persist();
    }, WRITE_DELAY_MS);
  };

  const add = (level, message, details) => {
    const entry = { t: now(), level, msg: cleanMessage(message) };
    if (level === "debug" && details !== undefined && details !== null && details !== "") {
      const d = cleanDetails(details);
      if (d) entry.details = d;
    }
    entries.push(entry);
    trim();
    touch();
  };

  const debugOn = () => now() < debugUntil;

  async function saveDebugUntil(value) {
    const s = storage();
    if (!s) return;
    // Read-modify-write of the settings object: other fields are kept.
    const current = (await s.get(SETTINGS_KEY))?.[SETTINGS_KEY];
    await s.set({ [SETTINGS_KEY]: { ...(isPlainObject(current) ? current : {}), debugUntil: value } });
  }

  return {
    error: (message) => add("error", message),
    warn: (message) => add("warn", message),
    info: (message) => add("info", message),
    /** Recorded only while debugging is on; `details`: technical values only. */
    debug: (message, details) => {
      if (debugOn()) add("debug", message, details);
    },

    get debugEnabled() {
      return debugOn();
    },
    /** When debugging switches itself off (ms since the epoch), or 0 when it is off. */
    get debugUntil() {
      return debugOn() ? debugUntil : 0;
    },

    /**
     * Debugging on for `ms` milliseconds (at most one hour), or off when `ms`
     * is 0 or not a positive number. → the new deadline (0: off).
     */
    async setDebugFor(ms) {
      const span = Number.isFinite(ms) && ms > 0 ? Math.min(Math.floor(ms), MAX_DEBUG_MS) : 0;
      const wasOn = debugOn();
      debugUntil = span ? now() + span : 0;
      if (span) add("info", `Débogage activé pour ${Math.max(1, Math.round(span / 60_000))} min.`);
      else if (wasOn) add("info", "Débogage désactivé.");
      await saveDebugUntil(debugUntil);
      return debugUntil;
    },

    /**
     * Read the stored ring and debugging deadline (start-up). Entries logged
     * before this are kept, after the stored ones.
     */
    async load() {
      const s = storage();
      if (!s) return;
      let stored = [];
      let settings = null;
      try {
        const got = (await s.get([LOG_KEY, SETTINGS_KEY])) ?? {};
        stored = Array.isArray(got[LOG_KEY]) ? got[LOG_KEY] : [];
        settings = got[SETTINGS_KEY];
      } catch {
        return;
      }
      const early = entries;
      entries = [...stored.map(checkEntry).filter(Boolean), ...early];
      trim();
      const until = isPlainObject(settings) && typeof settings.debugUntil === "number" ? settings.debugUntil : 0;
      // A deadline further than one hour away was not written by setDebugFor (or the clock went back).
      debugUntil = Number.isFinite(until) && until > now() ? Math.min(until, now() + MAX_DEBUG_MS) : 0;
      if (early.length) touch();
    },

    /** Copies of the entries, oldest first. */
    getLog() {
      return entries.map((e) => ({ ...e }));
    },

    async clearLog() {
      entries = [];
      dirty = true;
      await persist();
    },

    /** Write pending entries now (tests). */
    flush() {
      return persist();
    },
  };
}

/**
 * The code of an error, for a log line: its `code`, else the "CODE:" prefix
 * of its message (the experiments' errors), else its name. Never the
 * message itself, which may carry server text.
 */
export function errorCode(e, max = 40) {
  const code = e?.code ?? /^[A-Z][A-Z_]{1,23}(?=:)/.exec(String(e?.message ?? ""))?.[0] ?? e?.name ?? "erreur";
  return cleanText(String(code), { max, singleLine: true, stripBidi: true }) || "erreur";
}

/** The extension's log. */
export const log = createLog();

export const setDebugFor = (ms) => log.setDebugFor(ms);
export const getLog = () => log.getLog();
export const clearLog = () => log.clearLog();
export const loadLog = () => log.load();
