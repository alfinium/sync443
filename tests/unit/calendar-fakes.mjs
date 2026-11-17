// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Test doubles for the calendar engine (src/sync/pim.mjs, scheduling.mjs).
 *
 *   FakeCalendarApi   the privileged module sync443Calendar, in memory: it
 *                     follows the contract of docs/CALENDAR-DESIGN.md (one
 *                     change per item, revisions that never start again,
 *                     what ackLocalChange and dropLocalChange do, detached
 *                     items, `rewritten` and `replyAsked`, the op "lock",
 *                     what a put leaves as it is, the limit of a calendar).
 *                     The engine reaches it through the real wrapper,
 *                     src/tb/calendar-store.mjs. user*() methods play the
 *                     user in Thunderbird.
 *   FakePimServer     an ActiveSync server for the Calendar and Tasks
 *                     classes: Sync (Supported, Options, Add / Change /
 *                     Delete / Fetch, the answer of a request repeated with
 *                     the same SyncKey), MeetingResponse and SendMail.
 *                     Requests and answers go through the real WBXML encoder
 *                     and decoder, items through the real codecs.
 *   event(), task()   item descriptions for the tests.
 */

import { el, encode, decode, text, child, at } from "../../src/core/wbxml.mjs";
import { decodeUtf8 } from "../../src/core/utf8.mjs";
import { EasError, ERR } from "../../src/transport/client.mjs";
import { checkEvent, readEvent, writeEvent } from "../../src/core/calendar-item.mjs";
import { checkTask, readTask, writeTask } from "../../src/core/task-item.mjs";
import { readContact, writeContact } from "../../src/core/contact-item.mjs";

export const OWN = "moi@example.com";

/** An event description, complete; `over` replaces fields. */
export function event(over = {}) {
  return {
    kind: "event",
    uid: "uid-1",
    summary: "Point hebdomadaire",
    location: "Salle 2",
    description: "",
    allDay: false,
    start: "2026-12-01T09:00:00Z",
    end: "2026-12-01T10:00:00Z",
    timezone: null,
    busy: "busy",
    privacy: "public",
    reminder: null,
    categories: [],
    organizer: null,
    attendees: [],
    meeting: { role: "none", cancelled: false, responseRequested: false, response: "none", allowNewTime: true },
    recurrence: null,
    exceptions: [],
    stamp: null,
    sequence: 0,
    readOnly: null,
    ...over,
  };
}

/** A task description, complete. */
export function task(over = {}) {
  return {
    kind: "task",
    uid: "task-1",
    summary: "Rendre le rapport",
    description: "",
    categories: [],
    privacy: "public",
    start: null,
    due: "2026-12-05",
    completed: false,
    completedAt: null,
    priority: "normal",
    reminderAt: null,
    recurrence: null,
    readOnly: null,
    ...over,
  };
}

export const person = (email, over = {}) => ({ email, name: "", role: "required", status: "unknown", ...over });

/** A meeting the mailbox organizes, with these attendees. */
export function meeting(attendees, over = {}) {
  return event({
    organizer: { email: OWN, name: "" },
    attendees: attendees.map((a) => (typeof a === "string" ? person(a) : a)),
    meeting: { role: "organizer", cancelled: false, responseRequested: true, response: "none", allowNewTime: true },
    ...over,
  });
}

/** An invitation from someone else, as it sits in the calendar. */
export function invitation(over = {}, response = "not-responded") {
  return event({
    uid: "invite-1",
    organizer: { email: "chef@example.org", name: "Chef" },
    attendees: [person(OWN, { status: response === "not-responded" ? "not-responded" : response })],
    meeting: { role: "attendee", cancelled: false, responseRequested: true, response, allowNewTime: true },
    ...over,
  });
}

const copy = (x) => (x === null || x === undefined ? x : JSON.parse(JSON.stringify(x)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Fake privileged module ────────────────────────────────────────────────

const fail = (code, reason) => new Error(`${code}: ${reason}`);
/** A row with no change of the user waiting. Its revision stays: the next change gets the next number. */
const SETTLED = Object.freeze({ pending: null, handed: 0, handedOp: null, problem: null, rewritten: false, replyAsked: false });

export class FakeCalendarApi {
  constructor() {
    this.calendars = new Map(); // calendarId → { mailboxId, slot, name, events, tasks, organizerEmail, rows: [] }
    this.tokens = 0;
    this.calls = []; // [name, ...args] of every API call
    this.listeners = new Set();
    this.failApply = null; // (change) → code, to make a put fail
    this.maxItems = 25_000; // most items one calendar holds: a put that would add one more answers LIMIT
    this.failAll = null; // an Error thrown by every call
    this.onLocalChange = {
      addListener: (fn) => this.listeners.add(fn),
      removeListener: (fn) => this.listeners.delete(fn),
    };
  }

  // ── What the user does and sees ───────────────────────────────────────

  #calendar(calendarId) {
    const c = this.calendars.get(calendarId);
    if (!c) throw fail("NOT_FOUND", "agenda introuvable");
    return c;
  }

  #token() {
    return (++this.tokens).toString(16).padStart(32, "0");
  }

  /** A row: one item of a calendar, with what is known of the server (`synced`) and the user's change that waits (`pending`). */
  #row(kind, collectionId, serverId, item, synced) {
    return { token: this.#token(), kind, collectionId, serverId, item, synced, pending: null, rev: 0, handed: 0, handedOp: null, detached: false, problem: null, rewritten: false, replyAsked: false };
  }

  /** The items the user sees in a calendar: [{ serverId, collectionId, item, detached }]. */
  items(calendarId) {
    return this.#calendar(calendarId).rows.filter((r) => r.pending !== "d").map((r) => ({ serverId: r.serverId, collectionId: r.collectionId, item: copy(r.item), detached: r.detached }));
  }

  summaries(calendarId) {
    return this.items(calendarId).map((r) => r.item.summary).sort();
  }

  #find(calendarId, where) {
    const rows = this.#calendar(calendarId).rows;
    const row = typeof where === "function" ? rows.find((r) => r.item && where(r)) : rows.find((r) => r.serverId === where || r.item?.uid === where);
    if (!row) throw new Error(`test : élément introuvable (${String(where)})`);
    return row;
  }

  #changed(calendarId) {
    for (const fn of [...this.listeners]) fn(calendarId);
  }

  /**
   * The user creates an item. `problem`: what the privileged module will say of it ("recurrence", "too-large"…);
   * `replyAsked`: Thunderbird asked whether a reply may be sent (the user answered an invitation, and did not
   * choose "do not send a response").
   */
  userAdd(calendarId, item, { problem = null, replyAsked = false } = {}) {
    const c = this.#calendar(calendarId);
    const row = { ...this.#row(item.kind, c.slot === "main" ? null : c.slot, null, copy(item), null), pending: "c", rev: 1, problem, replyAsked: replyAsked === true };
    c.rows.push(row);
    this.#changed(calendarId);
    return row;
  }

  /** The user changes an item (found by ServerId, by uid, or by a predicate on its row). `patch`: fields, or a function of the item. */
  userModify(calendarId, where, patch, { problem = null, replyAsked = false } = {}) {
    const row = this.#find(calendarId, where);
    row.item = typeof patch === "function" ? patch(copy(row.item)) : { ...row.item, ...copy(patch) };
    if (row.pending === null) row.pending = row.serverId === null ? "c" : "m";
    row.rev++; // never starts again: a change id names one change of one item, for ever
    row.problem = problem;
    row.replyAsked ||= replyAsked === true;
    this.#changed(calendarId);
    return row;
  }

  userDelete(calendarId, where) {
    const c = this.#calendar(calendarId);
    const row = this.#find(calendarId, where);
    if (row.serverId === null && row.handed === 0) {
      c.rows.splice(c.rows.indexOf(row), 1); // never synchronized, never read: nothing is left
    } else {
      row.pending = "d";
      row.rev++;
    }
    this.#changed(calendarId);
  }

  // ── The API (docs/CALENDAR-DESIGN.md) ─────────────────────────────────

  #enter(name, ...args) {
    this.calls.push([name, ...args]);
    if (this.failAll) throw this.failAll;
  }

  async listCalendars() {
    this.#enter("listCalendars");
    return [...this.calendars].map(([calendarId, c]) => ({ calendarId, mailboxId: c.mailboxId, slot: c.slot, name: c.name, events: c.events, tasks: c.tasks }));
  }

  async ensureCalendar(options) {
    this.#enter("ensureCalendar", copy(options));
    const { mailboxId, slot, name, events, tasks, organizerEmail } = options ?? {};
    if (!/^[a-f0-9]{12}$/.test(mailboxId ?? "") || typeof slot !== "string" || !slot || typeof name !== "string" || !name || !(events || tasks)) throw fail("CONFIG", "agenda invalide");
    for (const [calendarId, c] of this.calendars) {
      if (c.mailboxId !== mailboxId || c.slot !== slot) continue;
      Object.assign(c, { name, events, tasks, organizerEmail });
      return { calendarId, created: false };
    }
    if (this.calendars.size >= 50) throw fail("LIMIT", "trop d'agendas");
    let n = 1;
    while (this.calendars.has(`sync443-${mailboxId}-${n}`)) n++;
    const calendarId = `sync443-${mailboxId}-${n}`;
    this.calendars.set(calendarId, { mailboxId, slot, name, events, tasks, organizerEmail, rows: [] });
    return { calendarId, created: true };
  }

  async removeCalendar(calendarId) {
    this.#enter("removeCalendar", calendarId);
    return this.calendars.delete(calendarId);
  }

  async applyServerChanges(calendarId, changes) {
    this.#enter("applyServerChanges", calendarId, copy(changes));
    const c = this.#calendar(calendarId);
    if (!Array.isArray(changes) || changes.length > 200) throw fail("CONFIG", "liste de modifications invalide (200 au plus)");
    const results = [];
    for (const change of changes) {
      const { op, collectionId, serverId } = change;
      const row = c.rows.find((r) => r.collectionId === collectionId && r.serverId === serverId) ?? null;
      if (op === "remove") {
        if (row) c.rows.splice(c.rows.indexOf(row), 1);
        results.push({ serverId, ok: true });
        continue;
      }
      if (op === "detach") {
        if (row && row.pending === "d") c.rows.splice(c.rows.indexOf(row), 1);
        else if (row) Object.assign(row, { serverId: null, collectionId: c.slot === "main" ? null : c.slot, synced: null, ...SETTLED, detached: true });
        results.push({ serverId, ok: true });
        continue;
      }
      if (op === "lock") {
        // The item held keeps its content and can no longer be changed from here; one that is not held: nothing.
        // A change the user had made of it is no longer made on what the server has: marked like any rewritten one.
        if (row?.synced) row.synced.readOnly = "incomplete";
        if (row && row.pending === null && row.item) row.item.readOnly = "incomplete";
        if (row && row.pending !== null) row.rewritten = true;
        results.push({ serverId, ok: true });
        continue;
      }
      let item;
      try {
        // What the server does not say (a Change without a body; the user's own answer before 14.0) stays as
        // it is held; on a new item it is empty, and "not answered" (for someone else's meeting). null is never stored.
        const said = { ...change.item };
        if (said.description === null) said.description = row?.synced?.description ?? "";
        if (said.kind === "event" && said.meeting && said.meeting.response === null) {
          said.meeting = { ...said.meeting, response: row?.synced?.meeting?.response ?? (said.meeting.role === "attendee" ? "not-responded" : "none") };
        }
        item = copy(said.kind === "task" ? checkTask(said) : checkEvent(said));
      } catch {
        results.push({ serverId, ok: false, code: "INVALID" });
        continue;
      }
      const forced = this.failApply?.(change) ?? null;
      if (forced) {
        results.push({ serverId, ok: false, code: forced });
        continue;
      }
      if (item.kind === "event" ? !c.events : !c.tasks) {
        results.push({ serverId, ok: false, code: "KIND" });
        continue;
      }
      if (row && row.pending !== null) {
        // The user changed it meanwhile: only what is known of the server moves, and the change that waits is
        // marked (the server wins: the engine drops it).
        if (!same(item, row.synced)) row.rewritten = true;
        row.synced = item;
      } else if (row) {
        Object.assign(row, { kind: item.kind, item, synced: copy(item) });
      } else if (c.rows.length >= this.maxItems) {
        results.push({ serverId, ok: false, code: "LIMIT" });
        continue;
      } else {
        c.rows.push(this.#row(item.kind, collectionId, serverId, item, copy(item)));
      }
      results.push({ serverId, ok: true });
    }
    return results;
  }

  async serverIds(calendarId, collectionId) {
    this.#enter("serverIds", calendarId, collectionId);
    return this.#calendar(calendarId).rows.filter((r) => r.collectionId === collectionId && r.serverId !== null).map((r) => r.serverId);
  }

  async readLocalChanges(calendarId, options) {
    this.#enter("readLocalChanges", calendarId, copy(options));
    const c = this.#calendar(calendarId);
    const max = options?.max ?? 200;
    const out = [];
    for (const row of [...c.rows]) {
      if (out.length >= max) break;
      if (row.pending === null) continue;
      const base = {
        changeId: `${row.token}.${row.rev}`,
        kind: row.kind,
        collectionId: row.collectionId,
        serverId: row.serverId,
        item: null,
        previous: copy(row.synced),
        detached: false,
        rewritten: row.rewritten === true,
        replyAsked: row.replyAsked === true,
      };
      let op;
      if (row.pending === "d") {
        if (row.serverId === null) continue; // its creation is on its way
        op = "delete";
        out.push({ ...base, op, problem: row.synced?.readOnly ? "read-only" : null });
      } else {
        op = row.pending === "c" ? "add" : "modify";
        if (op === "modify" && row.synced?.readOnly) {
          out.push({ ...base, op, problem: "read-only" });
        } else if (op === "modify" && !row.problem && same(row.item, row.synced)) {
          Object.assign(row, SETTLED); // changed, then changed back
          continue;
        } else {
          out.push({ ...base, op, item: row.problem ? null : copy(row.item), problem: row.problem ?? null, detached: op === "add" && row.detached });
        }
      }
      row.handed = row.rev;
      row.handedOp = op;
    }
    return out;
  }

  #handedOut(calendarId, changeId) {
    const m = /^([a-f0-9]{32})\.([1-9][0-9]{0,8})$/.exec(changeId);
    if (!m) throw fail("CONFIG", "modification invalide");
    const row = this.#calendar(calendarId).rows.find((r) => r.token === m[1]);
    if (!row || row.pending === null || row.handedOp === null || row.handed !== Number(m[2])) return null;
    return row;
  }

  async ackLocalChange(calendarId, changeId, options) {
    this.#enter("ackLocalChange", calendarId, changeId, copy(options));
    const c = this.#calendar(calendarId);
    const row = this.#handedOut(calendarId, changeId);
    if (!row) return false;
    const { serverId = null, collectionId = null } = options ?? {};
    let item = null;
    if (options?.item) {
      try {
        item = copy(options.item.kind === "task" ? checkTask(options.item) : checkEvent(options.item));
      } catch {
        throw fail("CONFIG", "description invalide");
      }
      if (item.kind !== row.kind) throw fail("CONFIG", "la description n'est pas du type de l'élément");
    }
    const current = row.rev === row.handed;
    const acknowledged = row.handedOp;
    if (serverId !== null) {
      const collection = row.collectionId ?? collectionId;
      if (collection === null) throw fail("CONFIG", "identifiant de collection requis pour lier cet élément");
      if (collectionId !== null && collectionId !== collection) throw fail("CONFIG", "l'élément appartient à une autre collection");
      if (row.serverId !== null && row.serverId !== serverId) throw fail("CONFLICT", "l'élément est déjà lié à un autre identifiant du serveur");
      if (row.serverId === null) {
        const other = c.rows.find((r) => r !== row && r.collectionId === collection && r.serverId === serverId);
        if (other) c.rows.splice(c.rows.indexOf(other), 1); // the copy the server gave under this ServerId leaves
        Object.assign(row, { serverId, collectionId: collection, detached: false });
      }
    } else if (acknowledged === "add" && row.serverId === null) {
      throw fail("CONFIG", "identifiant du serveur requis pour une création");
    }
    if (acknowledged === "delete") {
      if (row.pending === "d") {
        c.rows.splice(c.rows.indexOf(row), 1);
        return current;
      }
      Object.assign(row, { serverId: null, synced: null, ...SETTLED, pending: "c" }); // back meanwhile: a new item again
      return false;
    }
    const synced = item ?? (current && row.pending !== "d" ? copy(row.item) : undefined);
    if (synced !== undefined) row.synced = synced;
    if (current) {
      Object.assign(row, SETTLED);
      return true;
    }
    // Changed again since: what was sent is acknowledged, the newer change stays to send (a change of its own).
    Object.assign(row, { ...SETTLED, pending: row.pending === "d" ? "d" : "m" });
    return false;
  }

  async dropLocalChange(calendarId, changeId) {
    this.#enter("dropLocalChange", calendarId, changeId);
    const c = this.#calendar(calendarId);
    const row = this.#handedOut(calendarId, changeId);
    if (!row) return false;
    const gone = () => c.rows.splice(c.rows.indexOf(row), 1);
    if (row.pending === "d" && row.serverId === null) {
      gone();
      return true;
    }
    if (row.rev !== row.handed) return false; // changed since it was read
    // An item never synchronized is never deleted: it stays as a local copy, detached (a kept copy stays as it is).
    if (row.pending === "c") Object.assign(row, SETTLED, { detached: true });
    else if (!row.synced) row.pending === "d" ? gone() : Object.assign(row, SETTLED);
    else Object.assign(row, SETTLED, { item: copy(row.synced) });
    return true;
  }
}

// ── Fake ActiveSync server (Calendar, Tasks, meetings) ────────────────────

export const PIM_FOLDERS = [
  { id: "1", parentId: "0", name: "Boîte de réception", type: 2 },
  { id: "3", parentId: "0", name: "Éléments supprimés", type: 4 },
  { id: "7", parentId: "0", name: "Calendrier", type: 8 },
  { id: "8", parentId: "0", name: "Tâches", type: 7 },
];

const roundTrip = (node) => (node === null || node === undefined ? null : decode(encode(node)));
const CLASS_OF_TYPE = new Map([[8, "Calendar"], [13, "Calendar"], [7, "Tasks"], [15, "Tasks"], [9, "Contacts"], [14, "Contacts"]]);
const RESPONSE_TYPES = new Map([["tentative", "2"], ["accepted", "3"], ["declined", "4"], ["not-responded", "5"]]);

export class FakePimServer {
  constructor({ folders = PIM_FOLDERS, version = "14.1", ownEmail = OWN } = {}) {
    this.version = version;
    this.ownEmail = ownEmail;
    this.folders = new Map(folders.map((f) => [f.id, { parentId: f.parentId, name: f.name, type: f.type }]));
    this.items = new Map([...this.folders.keys()].map((id) => [id, new Map()])); // cid → sid → description | { raw: [elements] }
    this.colls = new Map(); // cid → { key, prev, last, pending }
    this.seq = 100;
    this.requests = [];
    this.hooks = [];
    this.adds = []; // every Add the server took: { cid, clientId, serverId }
    this.addStatus = null; // (description) → forced status of an Add, or null
    this.changeStatus = new Map(); // ServerId → forced status of a Change
    this.deleteStatus = new Map(); // ServerId → forced status of a Delete
    this.meetings = []; // MeetingResponse requests: { userResponse, collectionId, requestId, instanceId }
    this.meetingResults = new Map(); // RequestId → { status, calendarId }
    this.sendStatus = null; // Status of SendMail (null: the empty answer of a success)
    this.mails = []; // SendMail: { clientId, saveInSentItems, mime }
    this.inPeriod = () => true; // (cid, sid, item) → whether the item is in the period a first Sync gives
  }

  classOf(cid) {
    return CLASS_OF_TYPE.get(this.folders.get(cid)?.type) ?? null;
  }

  // Server-side changes (another device, the webmail, a hostile server).
  #notify(cid, change) {
    const st = this.colls.get(cid);
    if (st?.key) st.pending.push(change);
  }
  addItem(cid, item, sid = `${cid}:${++this.seq}`) {
    this.items.get(cid).set(sid, copy(item));
    this.#notify(cid, { op: "add", sid });
    return sid;
  }
  /** An item given as raw ApplicationData children (to send what no codec would write). */
  addRaw(cid, elements, sid = `${cid}:${++this.seq}`) {
    this.items.get(cid).set(sid, { raw: elements });
    this.#notify(cid, { op: "add", sid });
    return sid;
  }
  changeItem(cid, sid, patch) {
    const before = this.items.get(cid).get(sid);
    this.items.get(cid).set(sid, patch.raw ? patch : before?.raw ? copy(patch) : { ...before, ...copy(patch) });
    this.#notify(cid, { op: "change", sid });
  }
  deleteItem(cid, sid) {
    this.items.get(cid).delete(sid);
    this.#notify(cid, { op: "delete", sid });
  }
  softDelete(cid, sid) {
    this.#notify(cid, { op: "softdelete", sid });
  }
  /** The server forgets the collection's SyncKey: the next Sync gets Status 3. */
  invalidate(cid) {
    const st = this.colls.get(cid);
    if (st) Object.assign(st, { key: 9999, prev: null, last: null });
  }
  removeFolder(id) {
    this.folders.delete(id);
    this.items.delete(id);
    this.colls.delete(id);
  }
  addFolder(id, parentId, name, type) {
    this.folders.set(id, { parentId, name, type });
    this.items.set(id, new Map());
  }

  /** Requests of one command, decoded. */
  sent(cmd) {
    return this.requests.filter((r) => r.cmd === cmd).map((r) => r.req);
  }

  /** The Sync requests of a collection, summed up: { key, supported, filterType, conflict, commands: [{ tag, clientId, serverId }] }. */
  syncs(cid) {
    return this.sent("Sync")
      .map((req) => at(req, "Collections", "Collection"))
      .filter((c) => text(c, "CollectionId") === cid)
      .map((c) => ({
        key: text(c, "SyncKey"),
        supported: child(c, "Supported") ? child(c, "Supported").children.map((x) => `${x.ns}:${x.tag}`) : null,
        filterType: text(c, "Options", "FilterType"),
        conflict: text(c, "Options", "Conflict"),
        bodyType: text(c, "Options", "AirSyncBase:BodyPreference", "AirSyncBase:Type"),
        commands: (child(c, "Commands")?.children ?? []).map((x) => ({ tag: x.tag, clientId: text(x, "ClientId"), serverId: text(x, "ServerId") })),
      }));
  }

  /** One-shot hook on the next request of `cmd`: fn(req, opts) → element, null, or undefined (the default answer). It may throw. */
  hook(cmd, fn) {
    this.hooks.push({ cmd, fn });
  }

  /** The next request of `cmd` is processed, and its answer never arrives. */
  loseNextResponse(cmd) {
    this.hook(cmd, async (req, opts) => {
      await this[`on${cmd}`](req, opts);
      throw new EasError(ERR.NETWORK, "Connexion interrompue.", { sent: true });
    });
  }

  async command(cmd, root, opts = {}) {
    if (opts.signal?.aborted) throw new EasError(ERR.CANCELLED, "Requête annulée.");
    const req = roundTrip(root);
    this.requests.push({ cmd, req, opts });
    const i = this.hooks.findIndex((h) => h.cmd === cmd);
    if (i >= 0) {
      const [h] = this.hooks.splice(i, 1);
      const r = await h.fn(req, opts);
      if (r !== undefined) return roundTrip(r);
    }
    if (opts.signal?.aborted) throw new EasError(ERR.CANCELLED, "Requête annulée.", { sent: true });
    return roundTrip(await this[`on${cmd}`](req, opts));
  }

  #data(cid, item) {
    if (item.raw) return item.raw;
    if (item.kind === "task") return writeTask(item, { version: this.version });
    if (item.kind === "contact") return writeContact(item, { version: this.version });
    // The user's own answer is the server's to say (ResponseType, from 14.0 on): a client never writes it.
    const response = RESPONSE_TYPES.get(item.meeting.response);
    return [...writeEvent(item, { version: this.version }), this.version !== "12.1" && response ? el("Calendar:ResponseType", response) : null].filter(Boolean);
  }

  #read(cid, data) {
    const node = roundTrip(el("AirSync:ApplicationData", data.children));
    if (this.classOf(cid) === "Contacts") return copy(readContact(node, { version: this.version, fallbackUid: "serveur" }));
    return copy(this.classOf(cid) === "Tasks" ? readTask(node, { version: this.version, fallbackUid: "serveur" }) : readEvent(node, { version: this.version, ownEmail: this.ownEmail, fallbackUid: "serveur" }));
  }

  onSync(req) {
    const c = at(req, "Collections", "Collection");
    const cid = text(c, "CollectionId");
    const key = text(c, "SyncKey");
    const reply = (status, extra = []) =>
      el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", key), el("CollectionId", cid), el("Status", status), ...extra])])]);
    if (!this.items.has(cid)) return reply("8");
    let st = this.colls.get(cid);
    const items = this.items.get(cid);
    if (key === "0") {
      st = { key: 1, prev: null, last: null, pending: [...items].filter(([sid, item]) => this.inPeriod(cid, sid, item)).map(([sid]) => ({ op: "add", sid })) };
      this.colls.set(cid, st);
      return el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", "1"), el("CollectionId", cid), el("Status", "1")])])]);
    }
    if (!st || key !== String(st.key)) {
      if (st && key === String(st.prev) && st.last) return st.last; // the same request again: the same answer
      return reply("3");
    }
    const responses = [];
    const sent = child(c, "Commands")?.children ?? [];
    for (const cmd of sent) {
      const sid = text(cmd, "ServerId");
      const item = sid === null ? null : items.get(sid);
      if (cmd.tag === "Add") {
        const clientId = text(cmd, "ClientId");
        const described = this.#read(cid, child(cmd, "ApplicationData"));
        const forced = this.addStatus?.(described) ?? null;
        if (forced === "none") continue; // the server says nothing of this Add
        if (forced) {
          responses.push(el("Add", [el("ClientId", clientId), el("Status", forced)]));
          continue;
        }
        const serverId = `${cid}:${++this.seq}`;
        items.set(serverId, described);
        this.adds.push({ cid, clientId, serverId });
        responses.push(el("Add", [el("ClientId", clientId), el("ServerId", serverId), el("Status", "1")]));
      } else if (cmd.tag === "Change") {
        const forced = this.changeStatus.get(sid);
        if (!item || forced) {
          responses.push(el("Change", [el("ServerId", sid), el("Status", forced ?? "8")]));
          continue;
        }
        const described = this.#read(cid, child(cmd, "ApplicationData"));
        // A Change without a body leaves the server's body as it is; the user's answer is never the client's to write.
        if (!child(child(cmd, "ApplicationData"), "AirSyncBase:Body")) described.description = item.description ?? "";
        if (described.meeting && item.meeting) described.meeting.response = item.meeting.response;
        items.set(sid, described);
      } else if (cmd.tag === "Delete") {
        const forced = this.deleteStatus.get(sid);
        if (forced || !item) {
          responses.push(el("Delete", [el("ServerId", sid), el("Status", forced ?? "8")]));
          continue;
        }
        items.delete(sid);
      } else if (cmd.tag === "Fetch") {
        responses.push(
          item ? el("Fetch", [el("ServerId", sid), el("Status", "1"), el("ApplicationData", this.#data(cid, item))]) : el("Fetch", [el("ServerId", sid), el("Status", "8")]),
        );
      }
    }
    const window = Number(text(c, "WindowSize") ?? "100");
    const commands = [];
    while (st.pending.length && commands.length < window) {
      const ch = st.pending.shift();
      const item = items.get(ch.sid);
      if (ch.op === "add" || ch.op === "change") {
        if (item) commands.push(el(ch.op === "add" ? "Add" : "Change", [el("ServerId", ch.sid), el("ApplicationData", this.#data(cid, item))]));
      } else {
        commands.push(el(ch.op === "delete" ? "Delete" : "SoftDelete", [el("ServerId", ch.sid)]));
      }
    }
    if (!sent.length && !commands.length && !responses.length) return null; // nothing new: an empty answer
    st.prev = st.key;
    st.key++;
    st.last = el("AirSync:Sync", [
      el("Collections", [
        el("Collection", [
          el("SyncKey", String(st.key)),
          el("CollectionId", cid),
          el("Status", "1"),
          commands.length ? el("Commands", commands) : null,
          responses.length ? el("Responses", responses) : null,
          st.pending.length ? el("MoreAvailable") : null,
        ]),
      ]),
    ]);
    return st.last;
  }

  onMeetingResponse(req) {
    const results = [];
    for (const r of req.children) {
      const request = { userResponse: Number(text(r, "UserResponse")), collectionId: text(r, "CollectionId"), requestId: text(r, "RequestId"), instanceId: text(r, "InstanceId") };
      this.meetings.push(request);
      const forced = this.meetingResults.get(request.requestId) ?? {};
      const status = forced.status ?? "1";
      // The calendar item the server names: given by the test, or the item itself when the answer was made on it.
      const calendarId = forced.calendarId ?? (this.classOf(request.collectionId) === "Calendar" ? request.requestId : null);
      results.push(el("Result", [el("RequestId", request.requestId), el("Status", status), status === "1" && calendarId && request.userResponse !== 3 ? el("CalendarId", calendarId) : null]));
    }
    return el("MeetingResponse:MeetingResponse", results);
  }

  onSendMail(req) {
    const mime = child(req, "Mime");
    this.mails.push({ clientId: text(req, "ClientId"), saveInSentItems: Boolean(child(req, "SaveInSentItems")), mime: decodeUtf8(mime.value) });
    return this.sendStatus === null ? null : el("ComposeMail:SendMail", [el("Status", this.sendStatus)]);
  }
}

// ── Reading a meeting message ─────────────────────────────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function unbase64(textValue) {
  const clean = textValue.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = [];
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (i + k < clean.length ? B64.indexOf(clean[i + k]) : 0));
    bytes.push((n[0] << 2) | (n[1] >> 4));
    if (i + 2 < clean.length) bytes.push(((n[1] & 15) << 4) | (n[2] >> 2));
    if (i + 3 < clean.length) bytes.push(((n[2] & 3) << 6) | n[3]);
  }
  return decodeUtf8(Uint8Array.from(bytes));
}

/** A header value with its RFC 2047 encoded-words decoded (adjacent words joined, as readers do). */
const decodeWords = (value) => value.replace(/(=\?UTF-8\?B\?[A-Za-z0-9+/=]*\?=)(\s+(?==\?UTF-8\?B\?))?/g, (_, word) => unbase64(word.slice(10, -2)));

/**
 * What a message sent with SendMail says: { headers: Map (lower-case names, unfolded and decoded values), to: [addresses],
 * text, calendar (unfolded iCalendar lines), method }.
 */
export function readMeetingMail(mime) {
  const [head, ...rest] = mime.split("\r\n\r\n");
  const headers = new Map();
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    headers.set(line.slice(0, colon).toLowerCase(), decodeWords(line.slice(colon + 1).trim()));
  }
  const boundary = /boundary="([^"]+)"/.exec(headers.get("content-type"))[1];
  const parts = rest.join("\r\n\r\n").split(`--${boundary}`).slice(1, -1).map((part) => {
    const [partHead, ...body] = part.replace(/^\r\n/, "").split("\r\n\r\n");
    return { head: partHead, body: unbase64(body.join("\r\n\r\n")) };
  });
  const calendarPart = parts.find((p) => /text\/calendar/.test(p.head));
  const calendar = calendarPart.body.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
  const addresses = (value) => [...value.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g)].map((m) => m[0]);
  return {
    headers,
    to: addresses(headers.get("to") ?? ""),
    from: addresses(headers.get("from") ?? ""),
    text: parts.find((p) => /text\/plain/.test(p.head)).body,
    calendar,
    method: /method=([A-Z]+)/.exec(calendarPart.head)[1],
  };
}
