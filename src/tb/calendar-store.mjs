// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * The calendars of ONE mailbox in Thunderbird: a thin wrapper over the
 * privileged module `sync443Calendar` (docs/CALENDAR-DESIGN.md, "Contract:
 * the privileged module"). The only module of the calendar engine that
 * touches Thunderbird; the engine is tested with a double of it
 * (tests/unit/calendar-fakes.mjs).
 *
 *   listCalendars() → [{ calendarId, slot, name, events, tasks }]     (this mailbox's only)
 *   ensureCalendar({ slot, name, events, tasks }) → { calendarId, created }
 *   removeCalendar(calendarId) → boolean
 *   applyServerChanges(calendarId, changes) → [{ serverId, ok, code? }]   (one result per change, same order;
 *                                                  put, remove, detach or lock)
 *   serverIds(calendarId, collectionId) → [ServerId]
 *   readLocalChanges(calendarId, { max }) → [change]                    (see checkChange)
 *   ackLocalChange(calendarId, changeId, { serverId?, collectionId?, item? }) → boolean
 *   dropLocalChange(calendarId, changeId) → boolean
 *   onLocalChange(listener) → stop()                                    (listener(calendarId), this mailbox's only)
 *
 * What comes back from privileged code is checked again before the engine
 * uses it: ids and enumerations one by one, item descriptions with
 * checkEvent and checkTask (core/calendar-item.mjs, core/task-item.mjs).
 * A description the checks refuse is never handed over: the change then
 * says `problem: "invalid"` (or "recurrence"), with `item` null. The marks
 * `rewritten` and `replyAsked` of a change are true only when privileged
 * code said exactly `true`.
 *
 * Calls are cut into batches of at most MAX_BATCH changes, the limit of
 * the privileged module. A calendar id that is not one of this mailbox's
 * ("sync443-<mailboxId>-<n>") is refused before any call.
 *
 * Errors are CalendarStoreErrors with a `code`: that of the privileged
 * module's refusal ("CODE: reason": CONFIG, PERMISSION, NOT_FOUND,
 * CONFLICT, LIMIT, UNSUPPORTED, INTERNAL), CONFIG for an argument refused
 * here, INTERNAL for an answer that is not what the contract says. Their
 * message never carries a title, a name, an address or a location.
 */

import * as v from "../core/sanitize.mjs";
import { MAILBOX_ID } from "../core/ids.mjs";
import { checkEvent } from "../core/calendar-item.mjs";
import { checkTask } from "../core/task-item.mjs";

/** Most changes in one call of the privileged module. */
export const MAX_BATCH = 200;
/** Most calendars one mailbox may show (the privileged module holds 50 in all). */
export const MAX_CALENDARS = 50;
const MAX_NAME = 256;
const CHANGE_ID = /^[\x21-\x7e]{1,128}$/;
const OPS = new Set(["add", "modify", "delete"]);
const KINDS = new Set(["event", "task"]);
const PROBLEMS = new Set(["recurrence", "read-only", "too-large"]);
const SERVER_OPS = new Set(["put", "remove", "detach", "lock"]);
const RESULT_CODES = new Set(["INVALID", "TOO_LARGE", "KIND", "LIMIT", "UNSUPPORTED", "INTERNAL"]);
const MAIN_SLOT = "main";

export class CalendarStoreError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "CalendarStoreError";
    this.code = code;
  }
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The code of a privileged refusal ("CODE: reason"), or INTERNAL: the reason itself is never passed on. */
function codeOf(e) {
  return /^([A-Z][A-Z_]{1,23}):/.exec(String(e?.message ?? ""))?.[1] ?? "INTERNAL";
}

/** "main", or the ServerId of a server folder. */
const slotOf = (value) => (value === MAIN_SLOT ? MAIN_SLOT : v.itemId(value));

/** A calendar name: one clean line of 1 to 256 characters, or null. */
function nameOf(value) {
  if (typeof value !== "string") return null;
  const name = v.cut(v.cleanText(value, { max: 4 * MAX_NAME, singleLine: true, stripBidi: true }).trim(), MAX_NAME).trim();
  return name || null;
}

/**
 * One item description from privileged code, checked: → { item, problem }.
 * `item` is the clean frozen copy, or null with the reason: "recurrence"
 * when the checks refuse its recurrence, "invalid" otherwise.
 */
function describe(value, kind, ownEmail) {
  try {
    if (kind === "event") return { item: checkEvent(value, { ownEmail }), problem: null };
    return { item: checkTask(value), problem: null };
  } catch (e) {
    return { item: null, problem: e?.code === "BAD_RECURRENCE" ? "recurrence" : "invalid" };
  }
}

/**
 * One entry of readLocalChanges, checked. → the change, or null when it
 * cannot even be named (no usable changeId, operation or kind): such an
 * entry is left out, and counted by the caller.
 *
 *   { changeId, op: "add" | "modify" | "delete", kind: "event" | "task",
 *     collectionId: string | null, serverId: string | null,
 *     item: description | null, previous: description | null,
 *     problem: null | "recurrence" | "read-only" | "too-large" | "invalid",
 *     detached: boolean, rewritten: boolean, replyAsked: boolean }
 *
 * `item` is null for a delete and whenever `problem` is set; a `previous`
 * that fails the checks is given as null (it only serves comparisons).
 * `rewritten`: the server changed the item while this change waited (the
 * server wins: nothing is sent for it). `replyAsked`: Thunderbird asked to
 * send the user's answer to the organizer; never for a delete, and never
 * without the item it is about.
 */
export function checkChange(raw, { ownEmail = null } = {}) {
  if (!isRecord(raw)) return null;
  const { changeId, op, kind } = raw;
  if (typeof changeId !== "string" || !CHANGE_ID.test(changeId)) return null;
  if (typeof op !== "string" || !OPS.has(op) || typeof kind !== "string" || !KINDS.has(kind)) return null;
  const collectionId = raw.collectionId === null || raw.collectionId === undefined ? null : v.itemId(raw.collectionId);
  const serverId = raw.serverId === null || raw.serverId === undefined ? null : v.itemId(raw.serverId);
  if ((raw.collectionId ?? null) !== null && collectionId === null) return null;
  if ((raw.serverId ?? null) !== null && serverId === null) return null;
  let problem = typeof raw.problem === "string" ? (PROBLEMS.has(raw.problem) ? raw.problem : "invalid") : null;
  let item = null;
  if (op !== "delete" && problem === null) {
    const described = describe(raw.item, kind, ownEmail);
    item = described.item;
    problem = described.problem;
  }
  let previous = null;
  if (raw.previous !== null && raw.previous !== undefined) previous = describe(raw.previous, kind, ownEmail).item;
  // An item that is linked to the server was not just added, and the reverse.
  if (op === "add" && serverId !== null) return null;
  if (op !== "add" && serverId === null) return null;
  return {
    changeId,
    op,
    kind,
    collectionId,
    serverId,
    item,
    previous,
    problem,
    detached: op === "add" && raw.detached === true,
    rewritten: raw.rewritten === true,
    // An answer is the user's own, on an event someone else organizes, and the item says it.
    replyAsked: raw.replyAsked === true && op !== "delete" && kind === "event" && item !== null && item.meeting.role === "attendee",
  };
}

export class CalendarStore {
  #api;
  #mailboxId;
  #ownEmail;
  #calendarId;

  /**
   * @param {object} o
   * @param {string} o.mailboxId   12 lower-case hexadecimal digits
   * @param {string} o.ownEmail    the mailbox's own address (the organizer of its meetings)
   * @param {object} [o.api]       browser.sync443Calendar (or a double)
   */
  constructor({ mailboxId, ownEmail, api = globalThis.browser?.sync443Calendar ?? globalThis.messenger?.sync443Calendar }) {
    if (typeof mailboxId !== "string" || !MAILBOX_ID.test(mailboxId)) throw new CalendarStoreError("CONFIG", "boîte invalide");
    const email = v.emailAddress(ownEmail);
    if (email === null) throw new CalendarStoreError("CONFIG", "adresse de la boîte invalide");
    if (!api || typeof api.listCalendars !== "function") throw new CalendarStoreError("UNSUPPORTED", "agendas de Thunderbird indisponibles");
    this.#api = api;
    this.#mailboxId = mailboxId;
    this.#ownEmail = email;
    this.#calendarId = new RegExp(`^sync443-${mailboxId}-[1-9][0-9]{0,3}$`);
  }

  /** One privileged call; its refusal becomes a CalendarStoreError that keeps the code and drops the reason. */
  async #call(name, ...args) {
    try {
      return await this.#api[name](...args);
    } catch (e) {
      const code = codeOf(e);
      throw new CalendarStoreError(code, `${name} refusé par Thunderbird`);
    }
  }

  #own(calendarId) {
    if (typeof calendarId !== "string" || !this.#calendarId.test(calendarId)) throw new CalendarStoreError("CONFIG", "agenda d'une autre boîte, ou invalide");
    return calendarId;
  }

  /** The calendars of this mailbox: [{ calendarId, slot, name, events, tasks }], sorted by calendarId. */
  async listCalendars() {
    const list = await this.#call("listCalendars");
    if (!Array.isArray(list)) throw new CalendarStoreError("INTERNAL", "liste d'agendas invalide");
    const out = [];
    const seen = new Set();
    for (const c of list) {
      if (!isRecord(c) || c.mailboxId !== this.#mailboxId) continue;
      if (typeof c.calendarId !== "string" || !this.#calendarId.test(c.calendarId) || seen.has(c.calendarId)) continue;
      const slot = slotOf(c.slot);
      if (slot === null) continue;
      seen.add(c.calendarId);
      out.push({ calendarId: c.calendarId, slot, name: nameOf(c.name) ?? "", events: c.events === true, tasks: c.tasks === true });
      if (out.length >= MAX_CALENDARS) break;
    }
    return out.sort((a, b) => (a.calendarId < b.calendarId ? -1 : a.calendarId > b.calendarId ? 1 : 0));
  }

  /**
   * Creates or updates this mailbox's calendar for `slot` ("main", or the
   * ServerId of a server folder). `name`: what Thunderbird shows; `events`,
   * `tasks`: the kinds of items it holds, at least one.
   * → { calendarId, created }
   */
  async ensureCalendar({ slot, name, events, tasks } = {}) {
    const place = slotOf(slot);
    const shown = nameOf(name);
    if (place === null || shown === null || typeof events !== "boolean" || typeof tasks !== "boolean" || !(events || tasks)) {
      throw new CalendarStoreError("CONFIG", "agenda invalide");
    }
    const r = await this.#call("ensureCalendar", { mailboxId: this.#mailboxId, slot: place, name: shown, events, tasks, organizerEmail: this.#ownEmail });
    if (!isRecord(r) || typeof r.calendarId !== "string" || !this.#calendarId.test(r.calendarId)) {
      throw new CalendarStoreError("INTERNAL", "agenda créé invalide");
    }
    return { calendarId: r.calendarId, created: r.created === true };
  }

  /** Unregisters the calendar and deletes its data in Thunderbird (nothing on the server). → boolean */
  async removeCalendar(calendarId) {
    return (await this.#call("removeCalendar", this.#own(calendarId))) === true;
  }

  /**
   * Applies changes that come from the server:
   *   { op: "put", collectionId, serverId, item }, { op: "remove", collectionId, serverId },
   *   { op: "detach", collectionId, serverId }, { op: "lock", collectionId, serverId }
   * in batches of MAX_BATCH. They never produce a local change. In the item
   * of a put, `description: null` and `meeting.response: null` mean "the
   * server does not say": what is held is kept. A lock makes the held item
   * read-only ("incomplete") and keeps its content.
   * → [{ serverId, ok, code? }], one per change, in the same order; `code`
   * is INVALID, TOO_LARGE, KIND, LIMIT (the calendar is full), UNSUPPORTED
   * (a recurrence Thunderbird must not be given) or INTERNAL. A change that
   * is not one of the four shapes is refused before any call.
   */
  async applyServerChanges(calendarId, changes) {
    this.#own(calendarId);
    if (!Array.isArray(changes)) throw new CalendarStoreError("CONFIG", "liste de modifications invalide");
    const clean = changes.map((c) => {
      const collectionId = v.itemId(c?.collectionId);
      const serverId = v.itemId(c?.serverId);
      if (!isRecord(c) || !SERVER_OPS.has(c.op) || !collectionId || !serverId) throw new CalendarStoreError("CONFIG", "modification invalide");
      if (c.op !== "put") return { op: c.op, collectionId, serverId };
      if (!isRecord(c.item)) throw new CalendarStoreError("CONFIG", "description absente");
      return { op: "put", collectionId, serverId, item: c.item };
    });
    const results = [];
    for (let from = 0; from < clean.length; from += MAX_BATCH) {
      const batch = clean.slice(from, from + MAX_BATCH);
      const answers = await this.#call("applyServerChanges", calendarId, batch);
      if (!Array.isArray(answers) || answers.length !== batch.length) throw new CalendarStoreError("INTERNAL", "résultats invalides");
      for (let i = 0; i < batch.length; i++) {
        const a = answers[i];
        // Results come in the order of the changes; one that names another item is not an answer to this one.
        if (!isRecord(a) || a.serverId !== batch[i].serverId) throw new CalendarStoreError("INTERNAL", "résultats invalides");
        if (a.ok === true) results.push({ serverId: batch[i].serverId, ok: true });
        else results.push({ serverId: batch[i].serverId, ok: false, code: typeof a.code === "string" && RESULT_CODES.has(a.code) ? a.code : "INTERNAL" });
      }
    }
    return results;
  }

  /** The ServerIds of the items held for a collection (those whose local deletion is not acknowledged yet included). */
  async serverIds(calendarId, collectionId) {
    const cid = v.itemId(collectionId);
    if (!cid) throw new CalendarStoreError("CONFIG", "collection invalide");
    const list = await this.#call("serverIds", this.#own(calendarId), cid);
    if (!Array.isArray(list)) throw new CalendarStoreError("INTERNAL", "liste d'identifiants invalide");
    const out = new Set();
    for (const id of list) if (v.itemId(id)) out.add(id);
    return [...out];
  }

  /**
   * The user's changes not sent yet, oldest first, at most `max` (1 to
   * MAX_BATCH), each one checked (checkChange). → { changes, rejected }:
   * `rejected` counts the entries that could not even be named. An answer
   * to an invitation is held back for about two seconds after the user gave
   * it (Thunderbird says only then whether a reply is wanted): the
   * listeners of onLocalChange are called again when it can be read.
   */
  async readLocalChanges(calendarId, { max = MAX_BATCH } = {}) {
    const limit = Number.isInteger(max) ? Math.max(1, Math.min(MAX_BATCH, max)) : MAX_BATCH;
    const list = await this.#call("readLocalChanges", this.#own(calendarId), { max: limit });
    if (!Array.isArray(list)) throw new CalendarStoreError("INTERNAL", "liste de modifications invalide");
    const changes = [];
    const seen = new Set();
    let rejected = 0;
    for (const raw of list.slice(0, limit)) {
      const change = checkChange(raw, { ownEmail: this.#ownEmail });
      if (!change || seen.has(change.changeId)) {
        rejected++;
        continue;
      }
      seen.add(change.changeId);
      changes.push(change);
    }
    return { changes, rejected };
  }

  /**
   * The server accepted a change. `serverId` (with `collectionId`) binds an
   * added item; `item` is the description now synchronized.
   * → true when the change is settled; false when it is unknown, or when
   * the user changed the item again since it was read (what was
   * acknowledged is recorded, the rest stays to send).
   */
  async ackLocalChange(calendarId, changeId, { serverId = null, collectionId = null, item = null } = {}) {
    this.#own(calendarId);
    if (typeof changeId !== "string" || !CHANGE_ID.test(changeId)) throw new CalendarStoreError("CONFIG", "modification invalide");
    const options = {};
    if (serverId !== null) {
      if (!v.itemId(serverId)) throw new CalendarStoreError("CONFIG", "identifiant d'élément invalide");
      options.serverId = serverId;
    }
    if (collectionId !== null) {
      if (!v.itemId(collectionId)) throw new CalendarStoreError("CONFIG", "collection invalide");
      options.collectionId = collectionId;
    }
    if (item !== null) {
      if (!isRecord(item)) throw new CalendarStoreError("CONFIG", "description invalide");
      options.item = item;
    }
    return (await this.#call("ackLocalChange", calendarId, changeId, options)) === true;
  }

  /**
   * Undo a change in Thunderbird: the last synchronized version comes
   * back, a deleted item returns; an item never synchronized stays in the
   * calendar as a detached local copy, with nothing to send.
   * → true; false when the change is unknown or was changed again since it
   * was read (nothing is undone).
   */
  async dropLocalChange(calendarId, changeId) {
    this.#own(calendarId);
    if (typeof changeId !== "string" || !CHANGE_ID.test(changeId)) throw new CalendarStoreError("CONFIG", "modification invalide");
    return (await this.#call("dropLocalChange", calendarId, changeId)) === true;
  }

  /**
   * `listener(calendarId)` is called when the user changed an item of one
   * of this mailbox's calendars. → a function that stops listening.
   */
  onLocalChange(listener) {
    const event = this.#api.onLocalChange;
    if (!event || typeof event.addListener !== "function" || typeof listener !== "function") return () => {};
    const wrapped = (calendarId) => {
      if (typeof calendarId !== "string" || !this.#calendarId.test(calendarId)) return;
      try {
        const r = listener(calendarId);
        if (r && typeof r.catch === "function") r.catch(() => {});
      } catch {
        /* a listener that fails must not reach privileged code */
      }
    };
    event.addListener(wrapped);
    return () => {
      try {
        event.removeListener(wrapped);
      } catch {
        /* already gone */
      }
    };
  }
}
