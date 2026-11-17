// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Calendar and task synchronisation of one mailbox
 * (docs/CALENDAR-DESIGN.md, "Server side").
 *
 *   const pim = new PimSync({ mailbox, records, calendarStore, scheduler, log, now });
 *   await pim.listRestarted();   // the server gave its whole folder list again (before the list is saved)
 *   await pim.pass({ client, version, folders, signal, confirmDeletes, only });
 *   pim.pingFolders(folders);
 *   await pim.pendingDeletes(); await pim.discardPendingDeletes(); await pim.removeLocal();
 *
 * Collections. Calendar folders (types 8 and 13) when the mailbox
 * synchronizes its calendar, task folders (types 7 and 15) when it
 * synchronizes its tasks; never one that lies in the server's Deleted
 * Items. The default Calendar and the default Tasks folder share the
 * calendar of slot "main"; every other folder has a calendar of its own.
 * A collection has an id of ours, given once (the folder's ServerId when it
 * is free): it names the records, the calendar of a folder of its own and
 * the items in the calendar store. The server's CollectionId is kept beside
 * it and may change (see "The folder list starts over").
 *
 * What leaves Thunderbird, and who decided. A kind the user unchecked has
 * its local items (or its calendar) removed and its records forgotten,
 * without a question. Every other removal comes from what the server says
 * and is judged by the mass-deletion threshold, with the number of items
 * held: a folder gone from the list, a folder whose type changed, a folder
 * that is no longer the default one, a calendar of ours no collection uses,
 * a Delete or a SoftDelete, an item the server does not send again after a
 * full resynchronisation. More than 50 and more than 20 % is held until the
 * user confirms it (pass with confirmDeletes) or keeps the local copies
 * (discardPendingDeletes: the items stay, detached from the server). The
 * share is taken of the size the collection had when its 24-hour window
 * opened: what the server adds meanwhile does not make room for deletions.
 * Nothing guards a Change: the server is the reference for content.
 *
 * Identity. An item is a ServerId in a collection, kept by the calendar
 * store; this module keeps no table of items (only, for each one, when it
 * ends or whether it is completed: record `pimEnds`, to tell after a change
 * of period that an item left the period by itself). An iCalendar UID
 * never selects anything here (rule 21).
 *
 * One request (#batch), in this order:
 *  1. local changes go as Add, Change and Delete commands, at most
 *     UPLOAD_MAX in a request, written down first (record `pimOut:<id>`:
 *     the SyncKey, and each command with its description and ClientId);
 *  2. the server's answer to each one is read: accepted (acknowledged in
 *     the calendar store, an added item bound to its ServerId), refused for
 *     good (statuses 6, 7 and 8: undone locally with a notification, the
 *     server's version fetched again), or neither (see "An unwell server");
 *  3. the server's own changes are applied through the calendar store, in
 *     one batch; an item that cannot be read is counted and skipped, never
 *     fatal, and not asked for again; the copy already held of it becomes
 *     read-only (op "lock"), so that no local change is made from a version
 *     the server no longer has;
 *  4. the SyncKey is saved, and only then.
 * A request whose answer was lost is sent again at the next pass with the
 * same SyncKey, the same commands and the same ClientIds, before anything
 * else is read from the calendar store and before a change of period
 * starts the collection again: the server answers as it did, and no item
 * is created twice.
 *
 * An unwell server never undoes a change of the user. A request the server
 * does not answer (a collection or command status that is not a success,
 * an empty or unreadable answer to commands) fails the pass for that
 * collection: the request stays written down and is replayed. Nothing is
 * held against its changes. After MAX_STRIKES such failures in a row its
 * changes are sent one at a time, to find the one the server chokes on. A
 * try is counted against a change only when it went alone and the answer
 * was not that of an unwell server (statuses 5, 16, 110, 111 never count);
 * after MAX_TRIES it is given up. An item status that says nothing final
 * leaves the change waiting. A new item given up, refused, or that the
 * server did not answer is never deleted: it stays as a local copy,
 * detached, and the user is told. A server that refuses the SyncKey, says
 * the folder is gone, or leaves changes unanswered MAX_STRIKES times in a
 * row fails the pass: nothing "succeeds" for ever without synchronizing.
 *
 * Full resynchronisation (first sync, Status 3, a change of period, a
 * folder that got another ServerId): the collection starts again at
 * SyncKey "0". The ServerIds the server sends are remembered (records
 * `pimSeen:<id>:<n>`); once it has nothing more, local items it did not
 * send again are deletions like any other, judged by the threshold. After
 * a change of period, the items this module can see left the period (an
 * event that does not recur and ended before the new limit; a completed
 * task when only incomplete ones are asked for) leave without counting.
 * Meanwhile the user's changes and deletions of items wait: a ServerId is
 * not trusted across a rebuild. Such a change goes only if the server sent
 * that ServerId again with the same item (same UID for an event, same
 * subject and dates for a task); otherwise the local item is detached and
 * stays as a local copy, and the server's item comes as any other.
 *
 * The folder list starts over (FolderSync from "0": a refused key, a
 * partnership reset; folders may be renumbered). No ServerId is taken at
 * face value (rule 18): each collection is matched first by its place (the
 * default folder of its kind; for another folder, its type, name and
 * parents), then by its ServerId if that folder kept its type and was not
 * matched to another collection. A collection whose folder has another
 * ServerId is bound to it and rebuilt in its own calendar, where its
 * waiting new items go (rule 19); one that matches nothing is a folder
 * gone.
 *
 * Changes of the user that nothing can receive (their folder is gone) wait
 * while the removal of that folder waits for the user. Once it is final
 * they are dropped, a new item staying as a local copy, and the user gets
 * one notice per pass with their number.
 *
 * Meetings. Every local change is given to the scheduler's planChange
 * (sync/scheduling.mjs): an answer to an invitation goes through
 * MeetingResponse before anything else (unless no invitation can be named:
 * the change is then synchronized as any other); a change to a meeting the
 * user organizes is synchronized first, then its messages are queued, to
 * be confirmed by the user. Only local changes take these paths: what the
 * server sends is applied to the calendar store and nothing else. A change
 * whose item the server rewrote while it waited (`rewritten`, recorded by
 * the calendar store) is dropped before anything is planned: the server
 * wins, and nothing is ever sent for it. The messages that wait are
 * forgotten when the mailbox has no calendar collection left.
 *
 * The log names collections by ServerId and gives counts and codes: never
 * a title, a name, an address or a location.
 */

import { syncRequest, parseSync, addCommand, changeCommand, deleteCommand, fetchCommand, ProtocolError } from "../core/protocol.mjs";
import { el } from "../core/wbxml.mjs";
import { readEvent, writeEvent, calendarSupported, calendarOptions } from "../core/calendar-item.mjs";
import { readTask, writeTask, taskOptions } from "../core/task-item.mjs";
import { readContact, writeContact, contactOptions, contactSupported } from "../core/contact-item.mjs";
import { PROTOCOL_VERSIONS } from "../core/recurrence.mjs";
import { MAX_MEETING_RECIPIENTS } from "../core/itip.mjs";
import { compareIds, nameKey, ROOT_ID, FOLDER_TYPE } from "../core/folder-tree.mjs";
import * as v from "../core/sanitize.mjs";
import { sha256, toHex } from "../core/sha256.mjs";
import { encodeUtf8 } from "../core/utf8.mjs";
import { EasError, ERR, FATAL } from "../transport/client.mjs";
import { recordName, CALENDAR_PERIODS, DEFAULT_CALENDAR_PERIOD, TASK_FILTERS, DEFAULT_TASK_FILTER } from "./store.mjs";
import { isMassDelete, MASS_DELETE_WINDOW_MS, serverError, badResponse, SYNC_ERR } from "./mail.mjs";
import { onlyAnswer } from "./scheduling.mjs";
import { errorCode } from "../log.mjs";

/** Items asked for in one Sync response. */
export const PIM_WINDOW_SIZE = 50;
/** Most Sync requests for one collection in one pass. */
export const PIM_MAX_BATCHES = 20;
/** Most local changes sent in one request. */
export const UPLOAD_MAX = 20;
/** Most characters of descriptions written down for one request (the first change always goes). */
const UPLOAD_MAX_CHARS = 2 * 1024 * 1024;
/** Most calendar and task collections of one mailbox. */
export const MAX_PIM_COLLECTIONS = 30;
/** Most items one collection holds (a hostile server cannot fill the calendar). */
export const MAX_PIM_ITEMS = 20_000;
/** Times a local change sent alone may fail, the server not being unwell, before it is given up. */
export const MAX_TRIES = 3;
/**
 * Answers in a row that synchronize nothing (a request left unanswered, a SyncKey refused, a folder said to be
 * gone, a change left waiting): at this many, a request is cut into single changes and the pass fails.
 */
export const MAX_STRIKES = 3;
/** Passes in a row a batch may fail to be written as a whole (see mail.mjs). */
const STUCK_LIMIT = 3;
const QUARANTINE_MAX = 200;
const REFETCH_MAX = 200;
const GUARDS_MAX = 500;
const TRIES_MAX = 200;
const SEQUENCES_MAX = 1000;
const SEEN_SEGMENT = 1000;
const END_SEGMENT = 1000;
/** Most segments of `pimEnds` for one collection: beyond, the oldest go (their items then count as deletions). */
const END_SEGMENTS_MAX = 3 * (MAX_PIM_ITEMS / END_SEGMENT);
const READ_MAX = 200;
const APPLY_MAX = 200;
/** Response size cap of a Sync request; raised when the batches have shrunk to one item (as for mail). */
const SYNC_MAX_BYTES = 24 * 1024 * 1024;
const SYNC_MAX_BYTES_SINGLE = 64 * 1024 * 1024;
const SYNC_TIMEOUT_MS = 180_000;

const MAIN = "main";
const CALENDAR = "Calendar";
const TASKS = "Tasks";
const CONTACTS = "Contacts";
/** What an engine synchronizes: the calendars and task lists of a mailbox, or its address books. */
export const DOMAINS = Object.freeze(["calendar", "contacts"]);
const DEFAULT_CALENDAR_TYPE = 8;
const USER_CALENDAR_TYPE = 13;
const DEFAULT_TASKS_TYPE = 7;
const USER_TASKS_TYPE = 15;
const CLASS_OF_TYPE = new Map([[DEFAULT_CALENDAR_TYPE, CALENDAR], [USER_CALENDAR_TYPE, CALENDAR], [DEFAULT_TASKS_TYPE, TASKS], [USER_TASKS_TYPE, TASKS]]);
const DEFAULT_CONTACTS_TYPE = 9;
const USER_CONTACTS_TYPE = 14;
const CONTACT_CLASS_OF_TYPE = new Map([[DEFAULT_CONTACTS_TYPE, CONTACTS], [USER_CONTACTS_TYPE, CONTACTS]]);
const DEFAULT_TYPES = new Set([DEFAULT_CALENDAR_TYPE, DEFAULT_TASKS_TYPE, DEFAULT_CONTACTS_TYPE]);
const CLASS_OF_KIND = new Map([["event", CALENDAR], ["task", TASKS], ["contact", CONTACTS]]);
/** Whether the mailbox synchronizes the items of a class. */
const wanted = (sync, cls) => (cls === CALENDAR ? sync?.calendar === true : cls === TASKS ? sync?.tasks === true : sync?.contacts === true);
/** Item statuses that settle a change for good ([MS-ASCMD] 2.2.3.177.17: 6 conversion error, 7 conflict, 8 not found). */
const DEFINITIVE = new Set(["6", "7", "8"]);
/** Statuses of a server that is unwell (5 server error, 16 retry; 110 and 111, the same for a whole command): never held against a change. */
const UNWELL = new Set(["5", "16", "110", "111"]);
const GONE = "8";
/** The notice of each `problem` of a local change; any other problem is told as an item that cannot be changed. */
const PROBLEM_NOTICE = new Map([["recurrence", "recurrenceUnsupported"], ["read-only", "readOnly"], ["too-large", "tooLarge"]]);
/** The notice of a new item that is not sent for a cause the user can act on: it stays as a local copy, and the notice says why. */
const ADD_NOTICE = new Map([["tooManyAttendees", "keptLocalTooManyAttendees"], ["recurrenceUnsupported", "keptLocalRecurrence"], ["tooLarge", "keptLocalTooLarge"]]);
const FULL = new Set(["initial", "status3", "period", "moved"]);
/** How far back each calendar period reaches, in days, never less than the server counts (FilterType 4 to 7). */
const PERIOD_DAYS = new Map([["4", 14], ["5", 31], ["6", 92], ["7", 184]]);
const INCOMPLETE_TASKS = "8";
/** How long the sizes a collection had when its windows opened are remembered, and how many of them at most. */
const SIZES_MS = 7 * MASS_DELETE_WINDOW_MS;
const SIZES_MAX = 16;
/** State of a guard (see collState): the server sent the same item again, or another one. */
const SAME = "=";
const OTHER = "!";

const DELETES = "pimDeletes";
const SEQUENCES = "pimSequences";
const KEPT = "pimKept";
const RESTART = "pimRestart";
const collRecord = (id) => recordName("pim", id);
const outRecord = (id) => recordName("pimOut", id);
const wasRecord = (id) => recordName("pimWas", id);
const seenPrefix = (id) => `pimSeen:${encodeURIComponent(id)}:`;
const endsPrefix = (id) => `pimEnds:${encodeURIComponent(id)}:`;

const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function cancelled() {
  return new EasError(ERR.CANCELLED, "Synchronisation annulée.");
}

function checkAbort(signal) {
  if (signal?.aborted) throw cancelled();
}

/** An id of ours made from a collection and an item of the server: the same parts always give the same one. */
function derivedId(prefix, ...parts) {
  return `${prefix}${toHex(sha256(encodeUtf8(parts.join("\n"))).subarray(0, 16))}`;
}

/**
 * Where a folder is in its list: its type and the names from the top, as
 * one short id of ours. null when its parents cannot be followed.
 */
function placeOf(folders, id) {
  const type = folders.get(id)?.type;
  if (!Number.isInteger(type)) return null;
  const names = [];
  let at = id;
  for (let depth = 0; at !== ROOT_ID; depth++) {
    const f = folders.get(at);
    if (!f || depth >= 64 || typeof f.name !== "string") return null;
    names.unshift(nameKey(f.name));
    at = f.parentId;
  }
  return derivedId("p", JSON.stringify([type, names]));
}

/**
 * What tells the same item again after a full resynchronisation: the UID
 * of an event, the subject and the dates of a task (it has no UID on the
 * server). → a short id of ours, or null.
 */
function identityOf(item) {
  if (!isRecord(item)) return null;
  if (item.kind === "task") return derivedId("i", JSON.stringify(["task", item.summary ?? "", item.start ?? null, item.due ?? null]));
  if (item.kind === "contact") return derivedId("i", JSON.stringify(["contact", item.summary ?? "", item.fields?.Email1Address ?? "", item.fields?.CompanyName ?? ""]));
  return typeof item.uid === "string" ? derivedId("i", JSON.stringify(["event", item.uid])) : null;
}

/**
 * What is remembered of an item to tell, after a change of period, that it
 * left the period by itself: for an event that does not recur, the minute
 * it ends (2 at least); for a task, 1 when it is completed; 0 for anything
 * that never leaves by itself.
 */
function leaveMark(item) {
  if (!isRecord(item)) return 0;
  if (item.kind === "contact") return 0;
  if (item.kind === "task") return item.completed === true ? 1 : 0;
  if (item.recurrence) return 0;
  const end = typeof item.end === "string" ? Date.parse(item.end) : NaN;
  return Number.isFinite(end) ? Math.max(2, Math.floor(end / 60_000)) : 0;
}

// ── Which folders ─────────────────────────────────────────────────────────

/**
 * The calendar and task collections of a folder list, for what the mailbox
 * synchronizes. `folders`: Map<ServerId, { parentId, name, type }>, as
 * sync/mailbox.mjs holds it; `sync`: { calendar, tasks }.
 * → Map<ServerId, { cls: "Calendar" | "Tasks", slot, name }> in the order
 * they are synchronized: the default folders first (slot "main": the first
 * folder of type 8 and the first of type 7, in ServerId order), then the
 * others (slot = their ServerId), at most MAX_PIM_COLLECTIONS in all. A
 * folder in the server's Deleted Items is left out: it was deleted.
 */
export function pimCollections(folders, sync, domain = "calendar") {
  const classes = domain === "contacts" ? CONTACT_CLASS_OF_TYPE : CLASS_OF_TYPE;
  const out = new Map();
  if (!(folders instanceof Map)) return out;
  const inTrash = (id) => {
    for (let depth = 0; id && id !== ROOT_ID && depth < 64; depth++) {
      const f = folders.get(id);
      if (!f) return false;
      if (f.type === FOLDER_TYPE.TRASH) return true;
      id = f.parentId;
    }
    return false;
  };
  const list = [];
  for (const [id, f] of folders) {
    const cls = classes.get(f?.type);
    if (!cls || !v.itemId(id) || id === MAIN) continue; // "main" names the shared calendar: never a folder's own
    if (!wanted(sync, cls)) continue;
    if (inTrash(f.parentId)) continue;
    list.push([id, f, cls]);
  }
  list.sort((a, b) => Number(DEFAULT_TYPES.has(b[1].type)) - Number(DEFAULT_TYPES.has(a[1].type)) || compareIds(a[0], b[0]));
  const defaults = new Set();
  for (const [id, f, cls] of list) {
    if (out.size >= MAX_PIM_COLLECTIONS) break;
    // One default folder of each kind: a second one of type 8 or 7 is an ordinary folder.
    const main = DEFAULT_TYPES.has(f.type) && !defaults.has(cls);
    if (main) defaults.add(cls);
    out.set(id, { cls, slot: main ? MAIN : id, name: typeof f.name === "string" ? f.name : "" });
  }
  return out;
}

// ── Stored state ──────────────────────────────────────────────────────────

/** The state of one collection, from its record; anything damaged starts the collection again. */
function collState(id, raw, domain = "calendar") {
  const syncKey = v.syncKey(raw?.syncKey) ?? "0";
  const ids = (list, max) => new Set((Array.isArray(list) ? list : []).filter((x) => v.itemId(x)).slice(-max));
  const w = raw?.window;
  return {
    /** Ours, given once: names the records, the calendar of a folder of its own, and the items in the calendar store. */
    id,
    /** The server's CollectionId, today (another one after a folder list that started over). */
    serverId: v.itemId(raw?.serverId) ?? id,
    // A class of this engine's own, whatever a damaged record says.
    cls: domain === "contacts" ? CONTACTS : raw?.cls === TASKS ? TASKS : CALENDAR,
    slot: raw?.slot === MAIN ? MAIN : id,
    /** Where the folder was in the list last seen (placeOf), and its type: what it is matched by when the list starts over. */
    place: typeof raw?.place === "string" && raw.place.length <= 64 ? raw.place : null,
    type: Number.isInteger(raw?.type) ? raw.type : null,
    /** Matched to no folder when the list started over: a folder gone, whatever its ServerId names now. */
    lost: raw?.lost === true,
    syncKey,
    /** FilterType the SyncKey was obtained with (a change of period starts the collection again). */
    filter: typeof raw?.filter === "string" && syncKey !== "0" ? raw.filter : null,
    /** Being rebuilt from SyncKey "0", and why: "initial", "status3", "period" or "moved"; null otherwise. */
    full: syncKey === "0" ? (FULL.has(raw?.full) ? raw.full : "initial") : FULL.has(raw?.full) ? raw.full : null,
    /** The server said MoreAvailable. */
    more: raw?.more === true || syncKey === "0",
    /** Server deletions applied within the rolling window: { since, count, base }; `base`: the items held when it opened. */
    window: w && Number.isFinite(w.since) && Number.isSafeInteger(w.count) && Number.isSafeInteger(w.base) ? { since: w.since, count: w.count, base: w.base } : null,
    /**
     * The items held each time a window opened, over the last seven days: [[when, how many]]. The share of
     * deletions is taken of the smallest: what the server added less than a week ago makes no room for them.
     */
    sizes: (Array.isArray(raw?.sizes) ? raw.sizes : []).filter((e) => Array.isArray(e) && Number.isFinite(e[0]) && Number.isSafeInteger(e[1]) && e[1] >= 0).slice(-SIZES_MAX).map((e) => [e[0], e[1]]),
    /** A request cut into single changes is remembered (record `pimWas:<id>`): the server may have taken it. */
    was: raw?.was === true,
    /** Server items that could not be read or written: ServerId → code. Skipped, counted, not asked for again. */
    quarantine: new Map((Array.isArray(raw?.quarantine) ? raw.quarantine : []).filter((e) => Array.isArray(e) && v.itemId(e[0]) && typeof e[1] === "string").slice(-QUARANTINE_MAX).map((e) => [e[0], e[1].slice(0, 40)])),
    /** Items to fetch again (a local change of theirs was refused, or the calendar no longer has them). */
    refetch: syncKey === "0" ? new Set() : ids(raw?.refetch, REFETCH_MAX),
    /**
     * Items whose change or deletion by the user waits across a rebuild: ServerId → what the item was (identityOf),
     * then the same with "=" in front once the server sent that item again, with "!" once it sent another one.
     */
    guards: new Map((Array.isArray(raw?.guards) ? raw.guards : []).filter((e) => Array.isArray(e) && v.itemId(e[0]) && typeof e[1] === "string" && e[1].length <= 64).slice(-GUARDS_MAX)),
    /** Local changes that go alone in their request: changeId → tries counted against them. The least recently tried first. */
    tries: new Map((Array.isArray(raw?.tries) ? raw.tries : []).filter((e) => Array.isArray(e) && typeof e[0] === "string" && e[0].length <= 128 && Number.isSafeInteger(e[1]) && e[1] >= 0).slice(-TRIES_MAX)),
    /** Answers to invitations the server took, whose change is not settled yet: changeId → [response, CalendarId | null]. Never given twice. */
    answered: new Map(
      (Array.isArray(raw?.answered) ? raw.answered : [])
        .filter((e) => Array.isArray(e) && typeof e[0] === "string" && e[0].length <= 128 && typeof e[1] === "string" && (e[2] === null || v.itemId(e[2])))
        .slice(-TRIES_MAX)
        .map((e) => [e[0], { response: e[1].slice(0, 20), calendarId: e[2] }]),
    ),
    /** Answers in a row that synchronized nothing (see MAX_STRIKES). */
    strikes: Math.min(count(raw?.strikes), 1000),
    /** Items held, at most (exact after a full resynchronisation, and whenever the limit is near). */
    count: count(raw?.count),
    /** The rebuild saw more items than are remembered: nothing is removed at its end. */
    overflow: raw?.overflow === true,
    stored: Boolean(raw),
  };
}

function collRaw(coll) {
  return {
    v: 1,
    serverId: coll.serverId,
    cls: coll.cls,
    slot: coll.slot === MAIN ? MAIN : coll.id,
    place: coll.place,
    type: coll.type,
    lost: coll.lost,
    syncKey: coll.syncKey,
    filter: coll.filter,
    full: coll.full,
    more: coll.more,
    window: coll.window ? { ...coll.window } : null,
    sizes: coll.sizes.map((e) => [...e]),
    was: coll.was,
    quarantine: [...coll.quarantine],
    refetch: [...coll.refetch],
    guards: [...coll.guards],
    tries: [...coll.tries],
    answered: [...coll.answered].map(([id, a]) => [id, a.response, a.calendarId]),
    strikes: coll.strikes,
    count: coll.count,
    overflow: coll.overflow,
  };
}

/** The commands of a request, as they are written down. */
const storedCmds = (cmds) => cmds.map((c) => ({ id: c.id, op: c.op, kind: c.kind, clientId: c.clientId, serverId: c.serverId, item: c.item, previous: c.previous, detached: c.detached }));

/** Ids of the collections that have a stored state, from the mailbox's record names. */
function storedCollections(names) {
  const out = [];
  for (const name of names) {
    if (!name.startsWith("pim:")) continue;
    let id;
    try {
      id = decodeURIComponent(name.slice(4));
    } catch {
      continue;
    }
    if (v.itemId(id)) out.push(id);
  }
  return out;
}

/**
 * Record `pimDeletes`: Map<collection id, entry>.
 *   { ids: [ServerId], at, retained, base }       deletions of items: waiting for the end of the collection's run
 *                                                 (retained false), or held by the threshold (retained true)
 *   { folder: true, count, at, retained: true }   a collection the server's folder list no longer has as it was (or
 *                                                 a calendar no collection uses), with `count` items: held
 */
function checkDeletes(raw) {
  const out = new Map();
  for (const [cid, value] of raw) {
    if (!v.itemId(cid) || !isRecord(value)) continue;
    const at = Number.isFinite(value.at) ? value.at : 0;
    if (value.folder === true) {
      out.set(cid, { folder: true, count: count(value.count), at, retained: true });
      continue;
    }
    const ids = [...new Set((Array.isArray(value.ids) ? value.ids : []).filter((id) => v.itemId(id)))].slice(0, MAX_PIM_ITEMS);
    if (ids.length) out.set(cid, { ids, at, retained: value.retained === true, base: count(value.base) });
  }
  return out;
}

function countRetained(map) {
  let n = 0;
  for (const e of map.values()) if (e.retained) n += e.folder ? Math.max(1, e.count) : e.ids.length;
  return n;
}

/** The numbers of the segment records `<prefix><n>` there are, in order. */
function segmentNumbers(names, prefix) {
  return names
    .filter((n) => n.startsWith(prefix))
    .map((n) => Number(n.slice(prefix.length)))
    .filter((k) => Number.isSafeInteger(k) && k >= 1)
    .sort((a, b) => a - b);
}

/** ServerIds seen during a rebuild, stored in segments so that a batch rewrites one small record. */
class SeenIds {
  constructor(records, cid) {
    this.records = records;
    this.prefix = seenPrefix(cid);
    this.ids = new Set();
    this.segments = [[]];
    this.names = new Set();
  }

  static async load(records, cid, names) {
    const seen = new SeenIds(records, cid);
    seen.segments = [];
    for (const k of segmentNumbers(names, seen.prefix)) {
      const name = `${seen.prefix}${k}`;
      seen.names.add(name);
      const ids = (await records.get(name, [])) ?? [];
      const segment = [];
      for (const id of Array.isArray(ids) ? ids.slice(0, SEEN_SEGMENT) : []) {
        if (!v.itemId(id) || seen.ids.has(id)) continue;
        seen.ids.add(id);
        segment.push(id);
      }
      seen.segments[k - 1] = segment;
    }
    for (let i = 0; i < seen.segments.length; i++) seen.segments[i] ??= [];
    if (!seen.segments.length) seen.segments.push([]);
    return seen;
  }

  /** Remember more ids; only the segments that changed are written. */
  async add(list) {
    const touched = new Set();
    for (const id of list) {
      if (this.ids.has(id)) continue;
      this.ids.add(id);
      if (this.segments[this.segments.length - 1].length >= SEEN_SEGMENT) this.segments.push([]);
      this.segments[this.segments.length - 1].push(id);
      touched.add(this.segments.length);
    }
    for (const k of touched) {
      const name = `${this.prefix}${k}`;
      await this.records.set(name, this.segments[k - 1]);
      this.names.add(name);
    }
  }

  async clear() {
    const names = [...this.names];
    this.ids = new Set();
    this.segments = [[]];
    this.names = new Set();
    if (names.length) await this.records.removeMany(names);
  }
}

/**
 * The leaveMark of each item of a collection, as a log: entries
 * [ServerId, mark] are added at the end (records `pimEnds:<id>:<n>`), the
 * last word on an item wins, and the oldest segments go when there are too
 * many. Read as a whole only when a change of period ends.
 */
class EndLog {
  constructor(records, cid) {
    this.records = records;
    this.prefix = endsPrefix(cid);
    this.numbers = [];
    this.tail = null;
  }

  static clean(list) {
    return (Array.isArray(list) ? list : []).filter((e) => Array.isArray(e) && v.itemId(e[0]) && Number.isSafeInteger(e[1]) && e[1] >= 0).slice(0, END_SEGMENT);
  }

  /** The log, ready to be added to (only its last segment is read). */
  static async open(records, cid, names) {
    const log = new EndLog(records, cid);
    log.numbers = segmentNumbers(names, log.prefix);
    if (log.numbers.length) log.tail = EndLog.clean(await records.get(`${log.prefix}${log.numbers.at(-1)}`, []));
    return log;
  }

  async add(entries) {
    const touched = new Map();
    for (const e of entries) {
      if (!this.tail || this.tail.length >= END_SEGMENT) {
        this.numbers.push((this.numbers.at(-1) ?? 0) + 1);
        this.tail = [];
      }
      this.tail.push(e);
      touched.set(this.numbers.at(-1), this.tail);
    }
    for (const [k, segment] of touched) await this.records.set(`${this.prefix}${k}`, segment);
    const doomed = [];
    while (this.numbers.length > END_SEGMENTS_MAX) doomed.push(`${this.prefix}${this.numbers.shift()}`);
    if (doomed.length) await this.records.removeMany(doomed);
  }

  /** → Map<ServerId, mark> */
  static async load(records, cid, names) {
    const prefix = endsPrefix(cid);
    const out = new Map();
    for (const k of segmentNumbers(names, prefix)) for (const [sid, mark] of EndLog.clean(await records.get(`${prefix}${k}`, []))) out.set(sid, mark);
    return out;
  }
}

// ── The engine ────────────────────────────────────────────────────────────

export class PimSync {
  #mailbox;
  #records;
  #store;
  #scheduler;
  #log;
  #now;
  #lock = Promise.resolve();
  #ready = new Set(); // ServerIds of the collections with a SyncKey of their own, as the last pass left them
  #stuck = new Map();
  #outboxCleared = false; // the scheduler was told that no calendar collection is left
  #domain;
  #what; // how the log names what this engine synchronizes

  /**
   * @param {object} o
   * @param {object} o.mailbox         checked mailbox (store.mjs checkMailbox): id, email, name, sync, calendarPeriod, taskFilter
   * @param {object} o.records         store.mailbox(id)
   * @param {object} o.calendarStore   tb/calendar-store.mjs CalendarStore of the mailbox (or a double)
   * @param {object} o.scheduler       sync/scheduling.mjs Scheduler of the mailbox
   * @param {object} [o.log]           { info, warn, error, debug }
   * @param {() => number} [o.now]
   */
  constructor({ mailbox, records, calendarStore, scheduler, log = null, now = () => Date.now(), domain = "calendar" }) {
    if (!DOMAINS.includes(domain)) throw new TypeError("PimSync : domaine invalide");
    this.#domain = domain;
    this.#what = domain === "contacts" ? "Contacts" : "Agenda";
    if (!mailbox?.id || v.emailAddress(mailbox.email) === null) throw new TypeError("PimSync : boîte invalide");
    if (!records || !calendarStore || !scheduler) throw new TypeError("PimSync : dépendance manquante");
    this.#mailbox = mailbox;
    this.#records = records;
    this.#store = calendarStore;
    this.#scheduler = scheduler;
    this.#log = log;
    this.#now = now;
  }

  /** One operation at a time on this mailbox's calendars and records. */
  #exclusive(fn) {
    const run = this.#lock.then(fn);
    this.#lock = run.catch(() => {});
    return run;
  }

  /**
   * One pass over the calendar and task collections of the mailbox.
   *
   * @param {object} o
   * @param {{command: Function}} o.client   the EasClient of the pass (or a double)
   * @param {string} o.version               ActiveSync version in use: "12.1", "14.0" or "14.1" (client.proto.asVersion)
   * @param {Map} o.folders                  the server's folders: ServerId → { parentId, name, type }, after FolderSync
   * @param {AbortSignal} [o.signal]
   * @param {boolean} [o.confirmDeletes]     apply the deletions held by the threshold
   * @param {string[]|null} [o.only]         CollectionIds the server reported (Ping): the others are only asked when
   *                                         they have something to send or to finish; null: all
   * @param {boolean} [o.deliver]            ask and send the meeting messages at the end of the pass (default); false
   *                                         when the caller runs scheduler.deliver() itself, outside its lock
   * @returns {Promise<{received, sent, failed, pendingDeletes, moreAvailable, hierarchyChanged}>}
   *   received: server changes applied; sent: local changes the server took; failed: server items that cannot be
   *   read or written, as they stand; pendingDeletes: deletions held by the threshold (the caller blocks the
   *   mailbox, as for mail); moreAvailable: another pass is worth running soon; hierarchyChanged: a collection is
   *   gone or the folder list changed (FolderSync first).
   *   Throws EasError: CANCELLED when cancelled, a FATAL one at once, otherwise the first failure of a
   *   collection once the others were synchronized.
   */
  pass({ client, version, folders, signal = null, confirmDeletes = false, only = null, deliver = true } = {}) {
    return this.#exclusive(() => this.#pass({ client, version, folders, signal, confirmDeletes: confirmDeletes === true, only, deliver: deliver !== false }));
  }

  /**
   * The server gave its whole folder list again (FolderSync from "0"):
   * its folders may be renumbered. To be called before the new list is
   * saved; the next pass then matches every collection again before it
   * trusts a ServerId (see the module comment). Written down, so that a
   * pass that stops in between changes nothing to it.
   * → whether there was anything to match
   */
  listRestarted() {
    return this.#exclusive(async () => {
      if (!storedCollections(await this.#records.names()).length) return false;
      await this.#records.set(RESTART, true);
      return true;
    });
  }

  /**
   * The collections to watch with Ping: [{ id, class }] ("Calendar" or
   * "Tasks"), those of `folders` that the last pass of this instance left
   * with a SyncKey of their own.
   */
  pingFolders(folders) {
    const out = [];
    for (const [id, w] of pimCollections(folders, this.#mailbox.sync, this.#domain)) if (this.#ready.has(id)) out.push({ id, class: w.cls });
    return out;
  }

  /** Number of deletions held by the mass-deletion threshold, waiting for the user. */
  async pendingDeletes() {
    return countRetained(checkDeletes(await this.#records.getMap(DELETES)));
  }

  /**
   * The user keeps the local copies: the items whose deletion was held
   * stay in the calendar, detached from the server (no longer linked, no
   * change recorded), and the held deletions are forgotten. The calendar
   * of a folder gone from the server stays as a local calendar.
   * → number of items detached
   */
  discardPendingDeletes() {
    return this.#exclusive(async () => {
      const deletes = checkDeletes(await this.#records.getMap(DELETES));
      const cals = new Map((await this.#store.listCalendars()).map((c) => [c.slot, c]));
      const names = await this.#records.names();
      const kept = await this.#records.getMap(KEPT);
      let detached = 0;
      let keptChanged = false;
      for (const [cid, entry] of [...deletes]) {
        if (!entry.retained) continue;
        const coll = collState(cid, await this.#records.get(collRecord(cid), null), this.#domain);
        const cal = cals.get(coll.slot);
        const ids = !cal ? [] : entry.folder ? await this.#store.serverIds(cal.calendarId, cid) : entry.ids;
        if (cal && ids.length) {
          await this.#store.applyServerChanges(cal.calendarId, ids.map((serverId) => ({ op: "detach", collectionId: cid, serverId })));
          detached += ids.length;
        }
        if (entry.folder) {
          await this.#forget(cid, names);
          if (coll.slot !== MAIN) {
            kept.set(coll.slot, { at: this.#now() });
            keptChanged = true;
          }
        }
        deletes.delete(cid);
        await this.#saveDeletes(deletes);
      }
      if (keptChanged) await this.#records.setMap(KEPT, kept);
      this.#log?.info?.(`${this.#what} : suppressions retenues abandonnées, ${detached} élément(s) gardé(s) localement, détaché(s) du serveur.`);
      return detached;
    });
  }

  /**
   * Remove this mailbox's calendars from Thunderbird and forget every
   * calendar record (collections, held deletions, messages waiting to be
   * confirmed). Nothing is touched on the server.
   * → number of calendars removed
   */
  removeLocal() {
    return this.#exclusive(async () => {
      let removed = 0;
      for (const cal of await this.#store.listCalendars()) if (await this.#store.removeCalendar(cal.calendarId)) removed++;
      const names = await this.#records.names();
      const doomed = names.filter((n) => ["pim:", "pimOut:", "pimWas:", "pimSeen:", "pimEnds:"].some((p) => n.startsWith(p)) || [DELETES, SEQUENCES, KEPT, RESTART].includes(n));
      if (doomed.length) await this.#records.removeMany(doomed);
      await this.#scheduler.clear();
      this.#outboxCleared = true;
      this.#ready.clear();
      this.#stuck.clear();
      this.#log?.info?.(`${this.#what} : ${removed} agenda(s) retiré(s) de Thunderbird.`);
      return removed;
    });
  }

  // ── Records ─────────────────────────────────────────────────────────────

  async #saveColl(coll) {
    await this.#records.set(collRecord(coll.id), collRaw(coll));
    coll.stored = true;
    coll.dirty = false;
  }

  async #saveDeletes(map) {
    if (map.size) await this.#records.setMap(DELETES, map);
    else await this.#records.remove(DELETES);
  }

  /** Forget a collection: its state, its request in flight, what its rebuild saw, what is remembered of its items. */
  async #forget(cid, names = null) {
    const list = names ?? (await this.#records.names());
    const prefixes = [seenPrefix(cid), endsPrefix(cid)];
    const doomed = [collRecord(cid), outRecord(cid), wasRecord(cid), ...list.filter((n) => prefixes.some((p) => n.startsWith(p)))].filter((n) => list.includes(n));
    if (doomed.length) await this.#records.removeMany(doomed);
  }

  /** The request in flight of a collection, checked: { key, cmds }, or null. */
  async #loadOut(cid, name = outRecord(cid)) {
    const raw = await this.#records.get(name, null);
    const key = v.syncKey(raw?.key);
    if (!key || key === "0" || !Array.isArray(raw.cmds)) return null;
    const cmds = [];
    for (const c of raw.cmds.slice(0, UPLOAD_MAX)) {
      if (!isRecord(c) || typeof c.id !== "string" || !["add", "modify", "delete"].includes(c.op)) return null;
      if (c.op === "add" ? !/^[A-Za-z0-9-]{1,64}$/.test(c.clientId ?? "") : !v.itemId(c.serverId)) return null;
      if (!CLASS_OF_KIND.has(c.kind)) return null;
      cmds.push({
        id: c.id,
        changeId: c.id,
        op: c.op,
        kind: c.kind,
        clientId: c.op === "add" ? c.clientId : null,
        serverId: c.op === "add" ? null : c.serverId,
        collectionId: cid,
        item: isRecord(c.item) ? c.item : null,
        previous: isRecord(c.previous) ? c.previous : null,
        detached: c.detached === true,
        problem: null,
      });
    }
    return cmds.length ? { key, cmds } : null;
  }

  async #removeOut(cid) {
    await this.#records.remove(outRecord(cid));
  }

  /**
   * The commands of a request that was cut into single changes after
   * answers that could not be read (#unanswered): the server may have
   * taken it all the same. Each new item keeps the ClientId it went with,
   * and the first answer that can be read is searched for all of them
   * (#batch): no item is created twice. Read once per pass.
   */
  async #wasOf(coll) {
    if (!coll.was) return [];
    coll.wasCmds ??= (await this.#loadOut(coll.id, wasRecord(coll.id)))?.cmds ?? [];
    return coll.wasCmds;
  }

  /** What is left to remember of such a request: the changes that still wait to go alone. */
  async #saveWas(coll, list) {
    coll.wasCmds = list;
    if (list.length) {
      await this.#records.set(wasRecord(coll.id), { key: "was", cmds: storedCmds(list) });
    } else if (coll.was) {
      await this.#records.remove(wasRecord(coll.id));
    }
    if (coll.was !== list.length > 0) {
      coll.was = list.length > 0;
      coll.dirty = true;
    }
  }

  // ── A pass ──────────────────────────────────────────────────────────────

  async #pass({ client, version, folders, signal, confirmDeletes, only, deliver }) {
    if (!PROTOCOL_VERSIONS.includes(version)) throw new EasError(ERR.CONFIG, "Version ActiveSync inconnue : agenda non synchronisé.");
    if (!(folders instanceof Map)) throw new TypeError("PimSync.pass : liste des dossiers attendue");
    const run = {
      client,
      version,
      signal,
      folders,
      only: Array.isArray(only) ? new Set(only.filter((id) => v.itemId(id))) : null,
      counts: { received: 0, sent: 0 },
      errors: [],
      more: false,
      hierarchyChanged: false,
      kept: new Set(), // local changes left for a later pass, which is worth running soon
      later: new Set(), // local changes the server left waiting: not sent again in this pass
      held: new Set(), // slots where the removal of a collection waits for the user
      orphans: new Set(), // items of collections nobody knows, detached in this pass
      dropped: 0, // changes of the user that nothing can receive any more
      calendars: true, // a calendar collection is left
      deletes: null,
      sequences: null,
      sequencesDirty: false,
      names: null,
    };
    checkAbort(signal);
    let groups = null;
    try {
      run.deletes = checkDeletes(await this.#records.getMap(DELETES));
      run.sequences = await this.#loadSequences();
      groups = await this.#layout(run, pimCollections(folders, this.#mailbox.sync, this.#domain), confirmDeletes);
      // Messages of meetings that have no calendar any more are neither asked for nor sent.
      if (run.calendars) {
        this.#outboxCleared = false;
      } else if (!this.#outboxCleared) {
        await this.#scheduler.clear();
        this.#outboxCleared = true;
      }
      for (const group of groups) {
        checkAbort(signal);
        try {
          await this.#syncGroup(run, group);
        } catch (e) {
          if (signal?.aborted || e?.code === ERR.CANCELLED) throw cancelled();
          if (FATAL.has(e?.code)) throw e;
          run.errors.push(e);
          this.#log?.warn?.(`${this.#what} ${group.slot} : ${e instanceof EasError ? String(e.message).slice(0, 300) : errorCode(e, 60)}`);
        }
      }
    } catch (e) {
      if (signal?.aborted || e?.code === ERR.CANCELLED) throw cancelled();
      throw e instanceof EasError ? e : new EasError(SYNC_ERR.LOCAL, `${this.#what} : erreur locale (${errorCode(e, 60)}).`, { cause: e });
    } finally {
      // (A pass that could not even look at the calendars leaves the Ping list as it was.)
      if (groups) this.#ready = new Set(groups.flatMap((g) => g.colls).filter((c) => c.syncKey !== "0").map((c) => c.serverId));
      // One notice for all the changes dropped in this pass, whatever became of the pass.
      if (run.dropped) {
        this.#log?.warn?.(`${this.#what} : ${run.dropped} modification(s) locale(s) non envoyée(s), leur dossier n'est plus sur le serveur.`);
        this.#scheduler.notice("changesDropped", "", run.dropped);
      }
    }

    // The messages the changes of this pass call for: asked and sent once the collections are synchronized.
    if (deliver) {
      try {
        await this.#scheduler.deliver({ client, signal });
      } catch (e) {
        if (signal?.aborted || e?.code === ERR.CANCELLED) throw cancelled();
        this.#log?.warn?.(`${this.#what} : messages de réunion non traités (${errorCode(e, 60)}).`);
      }
    }

    const colls = groups.flatMap((g) => g.colls);
    const result = {
      received: run.counts.received,
      sent: run.counts.sent,
      failed: colls.reduce((n, c) => n + c.quarantine.size, 0),
      pendingDeletes: countRetained(run.deletes),
      moreAvailable: run.more || run.hierarchyChanged || run.kept.size > 0 || colls.some((c) => c.more && !this.#blocked(run, c)),
      hierarchyChanged: run.hierarchyChanged,
    };
    if (run.errors.length) {
      const e = run.errors[0];
      throw e instanceof EasError ? e : new EasError(SYNC_ERR.LOCAL, `${this.#what} : erreur locale (${errorCode(e, 60)}).`, { cause: e });
    }
    return result;
  }

  #blocked(run, coll) {
    return run.deletes.get(coll.id)?.retained === true;
  }

  #kindWanted(cls) {
    return wanted(this.#mailbox.sync, cls);
  }

  #filterOf(cls) {
    if (cls === CONTACTS) return "0"; // contacts have no period
    if (cls === CALENDAR) return CALENDAR_PERIODS.includes(this.#mailbox.calendarPeriod) ? this.#mailbox.calendarPeriod : DEFAULT_CALENDAR_PERIOD;
    return TASK_FILTERS.includes(this.#mailbox.taskFilter) ? this.#mailbox.taskFilter : DEFAULT_TASK_FILTER;
  }

  async #loadSequences() {
    const out = new Map();
    for (const [cid, list] of await this.#records.getMap(SEQUENCES)) {
      if (!v.itemId(cid) || !Array.isArray(list)) continue;
      const map = new Map();
      for (const e of list.slice(-SEQUENCES_MAX)) if (Array.isArray(e) && v.itemId(e[0]) && Number.isInteger(e[1]) && e[1] > 0 && e[1] <= 2147483647) map.set(e[0], e[1]);
      if (map.size) out.set(cid, map);
    }
    return out;
  }

  async #saveSequences(run) {
    if (!run.sequencesDirty) return;
    const map = new Map();
    for (const [cid, list] of run.sequences) if (list.size) map.set(cid, [...list].slice(-SEQUENCES_MAX));
    if (map.size) await this.#records.setMap(SEQUENCES, map);
    else await this.#records.remove(SEQUENCES);
    run.sequencesDirty = false;
  }

  /** The SEQUENCE of a meeting the user organizes: ActiveSync carries none, so it is kept here across the server's changes. */
  #rememberSequence(run, cid, sid, sequence) {
    let list = run.sequences.get(cid);
    if (!(sequence > 0)) {
      if (list?.delete(sid)) run.sequencesDirty = true;
      return;
    }
    if (!list) run.sequences.set(cid, (list = new Map()));
    if (list.get(sid) === sequence) return;
    list.delete(sid);
    list.set(sid, sequence);
    while (list.size > SEQUENCES_MAX) list.delete(list.keys().next().value);
    run.sequencesDirty = true;
  }

  // ── Calendars and collections ───────────────────────────────────────────

  /**
   * Thunderbird's calendars made to match the wanted collections: what is
   * no longer wanted is removed (or held), every wanted folder has its
   * collection and its calendar. → the groups to synchronize:
   * [{ slot, calendarId, colls }].
   */
  async #layout(run, wanted, confirm) {
    const store = this.#store;
    const records = this.#records;
    const cals = await store.listCalendars();
    const bySlot = new Map();
    for (const c of cals) if (!bySlot.has(c.slot)) bySlot.set(c.slot, c);
    const names = await records.names();
    run.names = names;
    const stored = new Map();
    for (const id of storedCollections(names)) stored.set(id, collState(id, await records.get(collRecord(id), null), this.#domain));
    const kept = await records.getMap(KEPT);
    let keptChanged = false;
    const held = run.held;
    const heldNow = new Set(); // collections whose removal is held by this very pass: no confirmation covers them
    const anyKind = this.#domain === "contacts" ? this.#kindWanted(CONTACTS) : this.#kindWanted(CALENDAR) || this.#kindWanted(TASKS);
    const hold = async (id, slot, n, before) => {
      if (!before?.folder) {
        run.deletes.set(id, { folder: true, count: n, at: this.#now(), retained: true });
        heldNow.add(id);
        await this.#saveDeletes(run.deletes);
        this.#log?.warn?.(`${this.#what} ${id} : dossier disparu ou changé sur le serveur avec ${n} élément(s) ; suppression retenue jusqu'à confirmation.`);
      }
      held.add(slot);
    };

    // 0. The folder list started over: no ServerId is taken at face value.
    if (names.includes(RESTART) && (await records.get(RESTART, null)) === true) await this.#rematch(run, stored, wanted);

    // 1. Collections that are no longer wanted, or no longer what they were.
    const byServer = new Map(); // ServerId → the stored collection of that folder
    for (const [id, coll] of stored) {
      checkAbort(run.signal);
      const w = coll.lost || byServer.has(coll.serverId) ? null : wanted.get(coll.serverId);
      if (w && w.cls === coll.cls && (w.slot === MAIN) === (coll.slot === MAIN)) {
        byServer.set(coll.serverId, coll);
        // A folder that was gone and is there again: nothing is left to decide about its removal.
        if (run.deletes.get(id)?.folder && run.deletes.delete(id)) await this.#saveDeletes(run.deletes);
        continue;
      }
      const cal = bySlot.get(coll.slot) ?? null;
      // Unchecked by the user: removed without a question. Anything else is the server's doing (the folder is
      // gone, changed its type, is no longer the default one), judged like any deletion.
      const chosen = !this.#kindWanted(coll.cls);
      const before = run.deletes.get(id);
      // The user's confirmation covers what was held when it was given: a folder that goes in the very pass
      // that applies it is judged like any other.
      if (!chosen && cal && !(confirm && before?.folder)) {
        const n = before?.folder ? before.count : (await store.serverIds(cal.calendarId, id)).length;
        if (before?.folder || isMassDelete(n, n)) {
          await hold(id, coll.slot, n, before);
          continue;
        }
      }
      if (cal) {
        const waiting = chosen ? { count: 0, adds: 0 } : await this.#waitingIn(cal.calendarId, coll.slot === MAIN ? id : null);
        run.dropped += waiting.count;
        if (coll.slot === MAIN) {
          await this.#remove(run, cal.calendarId, id, await store.serverIds(cal.calendarId, id));
        } else if (waiting.adds) {
          // New items of the user that were never sent are the only copies there are: the calendar stays, as a
          // local one, without the server's items.
          await this.#remove(run, cal.calendarId, id, await store.serverIds(cal.calendarId, id));
          kept.set(coll.slot, { at: this.#now() });
          keptChanged = true;
        } else {
          await store.removeCalendar(cal.calendarId);
          bySlot.delete(coll.slot);
        }
      }
      await this.#forget(id, names);
      stored.delete(id);
      if (run.sequences.delete(id)) run.sequencesDirty = true;
      if (run.deletes.delete(id)) await this.#saveDeletes(run.deletes);
      this.#log?.info?.(`${this.#what} ${coll.serverId} : ${chosen ? "élément décoché" : "dossier disparu ou changé sur le serveur"}, copies locales retirées.`);
    }

    // 2. A collection for each wanted folder. A new one takes the folder's ServerId as its id, unless something
    // of ours already goes by it (a collection whose removal waits, a calendar the user kept).
    const free = (id) => !stored.has(id) && !kept.has(id) && !run.deletes.get(id)?.folder;
    const groups = new Map();
    for (const [sid, w] of wanted) {
      let coll = byServer.get(sid);
      if (!coll) {
        let id = sid;
        for (let k = 2; !free(id); k++) id = derivedId("k", sid, String(k));
        coll = collState(id, null, this.#domain);
        coll.serverId = sid;
        coll.cls = w.cls;
        coll.slot = w.slot === MAIN ? MAIN : id;
        stored.set(id, coll);
      }
      const place = coll.slot === MAIN ? null : placeOf(run.folders, sid);
      const type = run.folders.get(sid)?.type;
      if (coll.place !== place || coll.type !== type) {
        coll.place = place;
        coll.type = Number.isInteger(type) ? type : null;
        coll.dirty = true;
      }
      let g = groups.get(coll.slot);
      if (!g) groups.set(coll.slot, (g = { slot: coll.slot, name: coll.slot === MAIN ? this.#mailbox.name || this.#mailbox.email : w.name || sid, events: false, tasks: false, calendarId: null, colls: [] }));
      if (coll.cls === CALENDAR) g.events = true;
      else g.tasks = true;
      g.colls.push(coll);
    }
    run.calendars = [...stored.values()].some((c) => c.cls === CALENDAR);

    // 3. Calendars no collection uses (a calendar kept by the user's choice stays).
    const used = new Set([...stored.values()].map((c) => c.slot));
    for (const cal of cals) {
      if (!bySlot.has(cal.slot)) continue; // removed above
      const twin = bySlot.get(cal.slot) !== cal; // a second calendar for one slot: only the first is kept
      if (!twin && (used.has(cal.slot) || kept.has(cal.slot))) continue;
      checkAbort(run.signal);
      if (!twin && anyKind) {
        // Nobody chose this: the mailbox's own calendar stays (it may hold local copies), another one is judged
        // by the items it holds.
        if (cal.slot === MAIN) continue;
        const before = run.deletes.get(cal.slot);
        if (!(confirm && before?.folder)) {
          const n = before?.folder ? before.count : (await store.serverIds(cal.calendarId, cal.slot)).length;
          if (before?.folder || isMassDelete(n, n)) {
            await hold(cal.slot, cal.slot, n, before);
            continue;
          }
        }
        const waiting = await this.#waitingIn(cal.calendarId, null);
        run.dropped += waiting.count;
        if (run.deletes.delete(cal.slot)) await this.#saveDeletes(run.deletes);
        if (waiting.adds) {
          // (As above: what the user made there and never sent stays, in a calendar that is local from now on.)
          await this.#remove(run, cal.calendarId, cal.slot, await store.serverIds(cal.calendarId, cal.slot));
          kept.set(cal.slot, { at: this.#now() });
          keptChanged = true;
          continue;
        }
      }
      await store.removeCalendar(cal.calendarId);
      if (!twin) bySlot.delete(cal.slot);
    }
    for (const slot of [...kept.keys()]) if (!bySlot.has(slot) && kept.delete(slot)) keptChanged = true;
    if (keptChanged) {
      if (kept.size) await records.setMap(KEPT, kept);
      else await records.remove(KEPT);
    }
    await this.#saveSequences(run);

    // 4. One calendar for each slot in use.
    const out = [];
    for (const g of groups.values()) {
      checkAbort(run.signal);
      try {
        const made = await store.ensureCalendar({ slot: g.slot, name: g.name, events: g.events, tasks: g.tasks });
        g.calendarId = made.calendarId;
        // A calendar Thunderbird no longer had holds nothing: its collections start again, whatever their SyncKey says.
        if (made.created) for (const coll of g.colls) if (coll.syncKey !== "0") await this.#reset(run, coll, "initial");
        out.push(g);
      } catch (e) {
        // One calendar that cannot be made (too many, a conflict) does not stop the others.
        run.errors.push(new EasError(SYNC_ERR.LOCAL, `${this.#what} ${g.slot} : agenda impossible à préparer dans Thunderbird (${errorCode(e)}).`));
        this.#log?.warn?.(`${this.#what} ${g.slot} : agenda impossible à préparer dans Thunderbird (${errorCode(e)}).`);
      }
    }

    // 5. Deletions of items the user confirmed.
    if (confirm) {
      let applied = 0;
      let confirmed = 0;
      for (const [cid, entry] of [...run.deletes]) {
        if (!entry.retained || heldNow.has(cid)) continue;
        confirmed++;
        const group = out.find((g) => g.colls.some((c) => c.id === cid));
        const coll = group?.colls.find((c) => c.id === cid);
        if (coll && !entry.folder) {
          applied += await this.#remove(run, group.calendarId, cid, entry.ids);
          coll.count = (await store.serverIds(group.calendarId, cid)).length;
          coll.sizes = []; // confirmed: the rolling window starts again, from what is left
          this.#open(coll, coll.count);
          await this.#saveColl(coll);
        }
        run.deletes.delete(cid);
        await this.#saveDeletes(run.deletes);
      }
      await this.#saveSequences(run);
      if (confirmed) this.#log?.info?.(`${this.#what} : suppressions confirmées par l'utilisateur (${applied} élément(s) retiré(s)).`);
    }
    return out;
  }

  /**
   * The folder list started over: each stored collection is matched to a
   * folder of the new list, by place, then by ServerId (see the module
   * comment). One whose folder has another ServerId is bound to it and
   * rebuilt; one that matches nothing is marked lost. Written in one go.
   */
  async #rematch(run, stored, wanted) {
    const folders = run.folders;
    const defaultOf = (cls) => `main ${cls}`;
    const places = new Map(); // place → ServerIds of the wanted folders there
    for (const [sid, w] of wanted) {
      const p = w.slot === MAIN ? defaultOf(w.cls) : placeOf(folders, sid);
      if (p) places.set(p, [...(places.get(p) ?? []), sid]);
    }
    const before = new Map(); // place → the stored collections that were there
    for (const coll of stored.values()) {
      const p = coll.lost ? null : coll.slot === MAIN ? defaultOf(coll.cls) : coll.place;
      if (p) before.set(p, [...(before.get(p) ?? []), coll]);
    }
    const match = new Map(); // collection → ServerId of its folder in the new list
    const taken = new Set();
    for (const [p, list] of before) {
      const there = places.get(p);
      // Two folders in one place, then or now: which is which is not guessed.
      if (list.length !== 1 || there?.length !== 1) continue;
      match.set(list[0], there[0]);
      taken.add(there[0]);
    }
    for (const coll of stored.values()) {
      if (coll.lost || match.has(coll)) continue;
      const w = wanted.get(coll.serverId);
      if (!w || taken.has(coll.serverId) || coll.type === null || folders.get(coll.serverId)?.type !== coll.type) continue;
      if (w.cls !== coll.cls || (w.slot === MAIN) !== (coll.slot === MAIN)) continue;
      match.set(coll, coll.serverId);
      taken.add(coll.serverId);
    }
    const writes = [[RESTART, false]];
    const rebound = [];
    for (const coll of stored.values()) {
      if (coll.lost) continue;
      const sid = match.get(coll);
      if (sid === undefined) {
        coll.lost = true;
        writes.push([collRecord(coll.id), collRaw(coll)]);
        this.#log?.info?.(`${this.#what} ${coll.serverId} : dossier introuvable dans la nouvelle liste du serveur.`);
        continue;
      }
      if (sid === coll.serverId) continue; // (should its SyncKey be refused, Status 3 rebuilds it)
      this.#log?.info?.(`${this.#what} ${coll.serverId} : dossier renuméroté par le serveur (${sid}), entièrement resynchronisé.`);
      coll.serverId = sid;
      this.#restart(coll, "moved");
      coll.full = "moved";
      coll.strikes = 0;
      writes.push([collRecord(coll.id), collRaw(coll)]);
      rebound.push(coll);
    }
    await this.#records.setMany(writes);
    await this.#records.remove(RESTART).catch(() => {}); // (written as done above: what is left of it says nothing)
    for (const coll of rebound) {
      coll.stored = true;
      await this.#saveWas(coll, []);
      if (coll.dirty) await this.#saveColl(coll);
      await this.#removeOut(coll.id);
      await (await this.#seen(coll)).clear();
      // Deletions that waited named items by ServerIds of before: the rebuild decides again what is there.
      const entry = run.deletes.get(coll.id);
      if (entry && !entry.folder) {
        run.deletes.delete(coll.id);
        await this.#saveDeletes(run.deletes);
      }
    }
  }

  /**
   * The changes of the user that wait in a calendar (`cid` null), or on
   * the items of one of its collections: → { count, adds }, `adds` being
   * the new items among them (never sent: the only copies there are).
   */
  async #waitingIn(calendarId, cid) {
    const { changes } = await this.#store.readLocalChanges(calendarId, { max: READ_MAX });
    const list = changes.filter((c) => cid === null || (c.collectionId === cid && c.serverId !== null));
    return { count: list.length, adds: list.filter((c) => c.op === "add").length };
  }

  /** Remove items from a calendar, in batches. → number removed */
  async #remove(run, calendarId, cid, ids) {
    let removed = 0;
    for (let from = 0; from < ids.length; from += APPLY_MAX) {
      checkAbort(run.signal);
      const part = ids.slice(from, from + APPLY_MAX);
      const results = await this.#store.applyServerChanges(calendarId, part.map((serverId) => ({ op: "remove", collectionId: cid, serverId })));
      removed += results.filter((r) => r.ok).length;
    }
    const sequences = run.sequences.get(cid);
    if (sequences) for (const sid of ids) if (sequences.delete(sid)) run.sequencesDirty = true;
    return removed;
  }

  /** A collection is to start again from SyncKey "0" (in memory). */
  #restart(coll, reason) {
    coll.syncKey = "0";
    // A rebuild already going on for another reason keeps it: only after a change of period do items leave without counting.
    coll.full = coll.full && coll.full !== "period" ? coll.full : reason;
    coll.more = true;
    coll.filter = null;
    coll.refetch.clear();
    coll.overflow = false;
    // What the user's waiting changes were made on is compared again with what this rebuild brings.
    for (const [sid, guard] of coll.guards) if (guard.startsWith(SAME) || guard.startsWith(OTHER)) coll.guards.set(sid, guard.slice(1));
  }

  /** Start a collection again from SyncKey "0". */
  async #reset(run, coll, reason) {
    this.#restart(coll, reason);
    await this.#saveWas(coll, []); // (ClientIds mean nothing to a server that starts again)
    await this.#saveColl(coll);
    await this.#removeOut(coll.id);
    await (await this.#seen(coll)).clear();
    const entry = run.deletes.get(coll.id);
    if (entry && !entry.retained) {
      run.deletes.delete(coll.id); // the rebuild decides again what is there
      await this.#saveDeletes(run.deletes);
    }
  }

  /** The ServerIds the rebuild of a collection has seen, read once per pass. */
  async #seen(coll) {
    coll.seen ??= await SeenIds.load(this.#records, coll.id, await this.#records.names());
    return coll.seen;
  }

  /** The log of what is remembered of a collection's items (EndLog), opened once per pass. */
  async #ends(coll) {
    coll.ends ??= await EndLog.open(this.#records, coll.id, await this.#records.names());
    return coll.ends;
  }

  /**
   * The rolling window of the server's deletions. It opens with the
   * number of items held then: what the server adds while it is open does
   * not make room for deletions.
   */
  async #openWindow(group, coll) {
    const now = this.#now();
    const w = coll.window;
    if (w && now - w.since < MASS_DELETE_WINDOW_MS && now >= w.since) return;
    if (!w && coll.full === "initial") return; // being filled for the first time: opened once it is complete (#finishFull)
    this.#open(coll, (await this.#store.serverIds(group.calendarId, coll.id)).length);
  }

  /** A window of deletions opens now, the collection holding `size` items: remembered for a week. */
  #open(coll, size) {
    const now = this.#now();
    coll.window = { since: now, count: 0, base: size };
    coll.sizes = [...coll.sizes.filter((e) => now - e[0] < SIZES_MS && now >= e[0]), [now, size]].slice(-SIZES_MAX);
    coll.dirty = true;
  }

  // ── One calendar ────────────────────────────────────────────────────────

  async #syncGroup(run, group) {
    try {
      await this.#syncCalendar(run, group);
    } finally {
      // What changed outside a request (tries, items to fetch again, guards, strikes).
      for (const coll of group.colls) if (coll.dirty && coll.stored) await this.#saveColl(coll).catch(() => {});
    }
  }

  async #syncCalendar(run, group) {
    const active = () => group.colls.filter((c) => !this.#blocked(run, c) && !c.stale);
    for (const coll of group.colls) {
      if (this.#blocked(run, coll)) continue;
      if (!coll.stored) await this.#saveColl(coll);
      await this.#openWindow(group, coll);
    }

    // 1. Requests whose answer was lost: sent again as they were, before anything is read from the calendar and
    // before a change of period starts the collection again.
    for (const coll of active()) {
      const out = await this.#loadOut(coll.id);
      if (!out) continue;
      // (A change that went alone and is given up is not sent once more: #triage settles it.)
      if (out.key !== coll.syncKey || (out.cmds.length === 1 && (coll.tries.get(out.cmds[0].changeId) ?? 0) >= MAX_TRIES)) {
        await this.#removeOut(coll.id);
        continue;
      }
      checkAbort(run.signal);
      this.#log?.info?.(`${this.#what} ${coll.serverId} : requête sans réponse renvoyée à l'identique (${out.cmds.length} commande(s)).`);
      await this.#batch(run, group, coll, { replay: out.cmds });
    }
    for (const coll of active()) {
      if (coll.syncKey !== "0" && coll.filter !== null && coll.filter !== this.#filterOf(coll.cls)) {
        this.#log?.info?.(`${this.#what} ${coll.serverId} : période changée, dossier entièrement resynchronisé.`);
        await this.#reset(run, coll, "period");
      }
    }

    // 2. Local changes out, server changes in, one request at a time.
    const asked = new Map(group.colls.map((c) => [c, 0]));
    let rounds = PIM_MAX_BATCHES * group.colls.length + 10;
    let turn = 0;
    for (;;) {
      checkAbort(run.signal);
      const { uploads, settled } = await this.#triage(run, group, await this.#read(group));
      const wants = (c) =>
        uploads.get(c).length > 0 ||
        (asked.get(c) < PIM_MAX_BATCHES && (c.refetch.size > 0 || c.more || (asked.get(c) === 0 && (run.only === null || run.only.has(c.serverId) || c.full !== null))));
      const list = active();
      let next = null;
      for (let i = 0; i < list.length && !next; i++) {
        const c = list[(turn + i) % list.length];
        if (wants(c)) next = c;
      }
      if (rounds-- <= 0) {
        if (next || settled) run.more = true;
        break;
      }
      if (!next) {
        if (settled) continue; // changes were settled without a request: the calendar may have more to say
        break;
      }
      if (asked.get(next) >= PIM_MAX_BATCHES) {
        run.more = true;
        this.#log?.debug?.(`${this.#what} ${next.serverId} : ${PIM_MAX_BATCHES} lots dans ce passage, la suite au prochain.`);
        for (const u of uploads.get(next)) run.kept.add(u.change.changeId);
        continue;
      }
      turn = list.indexOf(next) + 1;
      asked.set(next, asked.get(next) + 1);
      await this.#batch(run, group, next, { uploads: uploads.get(next) });
    }

    // 3. The server's deletions, once each collection has nothing more to send.
    for (const coll of active()) await this.#settle(run, group, coll);
  }

  /** The user's changes of a calendar that are waiting. Changes it could not even name are counted. */
  async #read(group) {
    const { changes, rejected } = await this.#store.readLocalChanges(group.calendarId, { max: READ_MAX });
    if (rejected) this.#log?.warn?.(`${this.#what} ${group.slot} : ${rejected} modification(s) locale(s) illisible(s), ignorée(s).`);
    // What is known of changes that no longer wait is forgotten: the tries of a change that is gone do not count
    // against the next one, and an item nothing waits on needs no guard.
    if (changes.length < READ_MAX) {
      const ids = new Set(changes.map((c) => c.changeId));
      for (const coll of group.colls) {
        for (const id of [...coll.tries.keys()]) if (!ids.has(id) && coll.tries.delete(id)) coll.dirty = true;
        for (const id of [...coll.answered.keys()]) if (!ids.has(id) && coll.answered.delete(id)) coll.dirty = true;
        if (coll.was && !coll.tries.size) await this.#saveWas(coll, []);
        // (While a rebuild lasts its guards stay, even those of a change that is not read for now: what the item
        // was is compared all the same.)
        if (!coll.guards.size || coll.full) continue;
        const waiting = new Set(changes.filter((c) => c.collectionId === coll.id && c.serverId !== null).map((c) => c.serverId));
        for (const [sid, guard] of [...coll.guards]) {
          if (waiting.has(sid)) continue;
          coll.guards.delete(sid);
          coll.dirty = true;
          // Left out of the rebuild's verdict while its change waited: what the server has of it is asked.
          if (!guard.startsWith(SAME)) this.#refetch(coll, sid);
        }
      }
    }
    return changes;
  }

  /** The collection a local change belongs to, or null (its kind is not synchronized here, or its folder is gone). */
  #collectionOf(group, change) {
    const cls = CLASS_OF_KIND.get(change.kind);
    if (change.collectionId !== null) {
      const coll = group.colls.find((c) => c.id === change.collectionId);
      return coll && coll.cls === cls ? coll : null;
    }
    const list = group.colls.filter((c) => c.cls === cls);
    return list.length === 1 ? list[0] : null;
  }

  /** ApplicationData of a local change (null for a delete). Throws when the item cannot be written. */
  #write(run, coll, change) {
    if (change.op === "delete") return null;
    const previous = change.op === "modify" ? change.previous : null;
    if (coll.cls === CONTACTS) return writeContact(change.item, { version: run.version, previous });
    return coll.cls === CALENDAR ? writeEvent(change.item, { version: run.version, previous }) : writeTask(change.item, { version: run.version, previous });
  }

  /**
   * Undo a local change in Thunderbird, and tell the user why (`notice`: a
   * name of i18n.mjs calendarNotice, or null). An item never synchronized
   * is not removed by this: the calendar store keeps it as a local copy,
   * and the notice of a new item says so, whatever the reason.
   */
  async #drop(run, group, coll, change, notice, detail = "") {
    let done = false;
    try {
      done = await this.#store.dropLocalChange(group.calendarId, change.changeId);
    } catch (e) {
      this.#log?.warn?.(`${this.#what} ${coll?.serverId ?? group.slot} : annulation locale impossible (${errorCode(e)}).`);
    }
    if (coll?.tries.delete(change.changeId)) coll.dirty = true;
    if (coll?.answered.delete(change.changeId)) coll.dirty = true;
    if (change.serverId && coll?.guards.delete(change.serverId)) coll.dirty = true;
    if (!done) {
      run.kept.add(change.changeId); // changed again meanwhile: read again at the next pass
      return false;
    }
    if (notice) {
      const kept = change.op === "add" ? (ADD_NOTICE.get(notice) ?? "keptLocal") : null;
      this.#scheduler.notice(kept ?? notice, (change.item ?? change.previous)?.summary ?? "", kept === null || kept === "keptLocalTooManyAttendees" ? detail : "");
    }
    return true;
  }

  /** A local change waits for a later pass, where it goes alone, after the others; `counted`: a try is held against it. */
  #wait(run, coll, change, counted) {
    run.later.add(change.changeId);
    const n = (coll.tries.get(change.changeId) ?? 0) + (counted ? 1 : 0);
    coll.tries.delete(change.changeId);
    coll.tries.set(change.changeId, n);
    while (coll.tries.size > TRIES_MAX) coll.tries.delete(coll.tries.keys().next().value);
    coll.dirty = true;
  }

  /** An item is asked for again with the next request. */
  #refetch(coll, sid) {
    if (coll.syncKey === "0") return; // a rebuild brings everything
    coll.refetch.delete(sid);
    coll.refetch.add(sid);
    while (coll.refetch.size > REFETCH_MAX) coll.refetch.delete(coll.refetch.values().next().value);
    coll.dirty = true;
  }

  /**
   * What each waiting change needs: undone (a problem, a refusal), an
   * answer to an invitation (given here), or a place in the next request
   * of its collection. → { uploads: Map<coll, [{ change, data }]>, settled }
   */
  async #triage(run, group, changes) {
    const uploads = new Map(group.colls.map((c) => [c, []]));
    const chars = new Map(group.colls.map((c) => [c, 0]));
    let settled = 0;
    // Changes that go alone come after the others, the least recently tried first: one the server chokes on
    // does not hold the others back.
    const rank = new Map();
    for (const coll of group.colls) for (const id of coll.tries.keys()) rank.set(id, rank.size + 1);
    const ordered = [...changes].sort((a, b) => (rank.get(a.changeId) ?? 0) - (rank.get(b.changeId) ?? 0));
    for (const change of ordered) {
      checkAbort(run.signal);
      if (run.kept.has(change.changeId) || run.later.has(change.changeId)) continue;
      const coll = this.#collectionOf(group, change);
      if (!coll) {
        if (await this.#homeless(run, group, change)) settled++;
        continue;
      }
      if (this.#blocked(run, coll) || coll.stale) {
        run.kept.add(change.changeId);
        continue;
      }

      if (change.op !== "add") {
        if (coll.full) {
          // A ServerId is not trusted across a rebuild: the change waits until the server has sent everything
          // again. What the item was is written down before the server's version replaces it.
          if (!coll.guards.has(change.serverId) && !(await this.#seen(coll)).ids.has(change.serverId)) {
            coll.guards.set(change.serverId, identityOf(change.previous) ?? "?");
            while (coll.guards.size > GUARDS_MAX) coll.guards.delete(coll.guards.keys().next().value);
            coll.dirty = true;
          }
          continue;
        }
        const guard = coll.guards.get(change.serverId);
        if (guard !== undefined && !guard.startsWith(SAME)) {
          if (await this.#stray(run, group, coll, change, guard.startsWith(OTHER))) settled++;
          continue;
        }
        if (change.rewritten === true) {
          // The server changed the item while this change waited: the server wins, and nothing is sent for it.
          this.#log?.info?.(`${this.#what} ${coll.serverId} : élément ${change.serverId} modifié par le serveur entre-temps, modification locale abandonnée.`);
          if (await this.#drop(run, group, coll, change, "serverChanged")) settled++;
          continue;
        }
      }

      const list = uploads.get(coll);
      if (list.length >= UPLOAD_MAX || (list.length && coll.tries.has(change.changeId))) continue; // the next request
      if (list.length && coll.tries.has(list[0].change.changeId)) continue; // a change that goes alone

      if (change.problem) {
        this.#log?.info?.(`${this.#what} ${coll.serverId} : modification locale impossible à envoyer (${change.problem}), annulée.`);
        if (await this.#drop(run, group, coll, change, PROBLEM_NOTICE.get(change.problem) ?? "readOnly")) settled++;
        continue;
      }
      if ((coll.tries.get(change.changeId) ?? 0) >= MAX_TRIES) {
        this.#log?.warn?.(`${this.#what} ${coll.serverId} : modification locale abandonnée après ${MAX_TRIES} essais.`);
        if (await this.#refuse(run, group, coll, change)) settled++;
        continue;
      }

      const plan = this.#scheduler.plan(change, { version: run.version });
      if (plan.flow === "refuse") {
        this.#log?.warn?.(`${this.#what} ${coll.serverId} : réunion de ${plan.count} participants, modification annulée (au plus ${MAX_MEETING_RECIPIENTS}).`);
        if (await this.#drop(run, group, coll, change, "tooManyAttendees", MAX_MEETING_RECIPIENTS)) settled++;
        continue;
      }
      if (plan.flow === "answer") {
        const outcome = await this.#answer(run, group, coll, change, plan);
        if (outcome !== "upload") {
          settled++;
          continue;
        }
      }

      let data;
      try {
        data = this.#write(run, coll, change);
      } catch (e) {
        const code = e instanceof ProtocolError ? e.code : null;
        this.#log?.info?.(`${this.#what} ${coll.serverId} : modification locale impossible à écrire (${code ?? errorCode(e)}), annulée.`);
        if (code === "UNSUPPORTED_CHANGE" && change.op !== "add") {
          // What the user did cannot be told to the server (a deleted occurrence put back): the server's version comes again.
          if (await this.#drop(run, group, coll, change, "restoreUnsupported")) {
            this.#refetch(coll, change.serverId);
            settled++;
          }
        } else if (await this.#drop(run, group, coll, change, code === "BAD_RECURRENCE" ? "recurrenceUnsupported" : "readOnly")) {
          settled++;
        }
        continue;
      }
      const size = JSON.stringify(change.item ?? null).length + JSON.stringify(change.previous ?? null).length;
      if (list.length && chars.get(coll) + size > UPLOAD_MAX_CHARS) continue;
      chars.set(coll, chars.get(coll) + size);
      list.push({ change, data });
    }
    return { uploads, settled };
  }

  /**
   * A change that no collection of its calendar can receive. → true when
   * it is settled. It waits while the removal of a collection of this
   * calendar waits for the user. Otherwise it is dropped: an item never
   * sent stays as a local copy, and the user is told once per pass how many
   * changes went (not when the user unchecked the kind: that was asked).
   * Items of a collection nobody knows stay too, detached.
   */
  async #homeless(run, group, change) {
    if (run.held.has(group.slot)) {
      run.kept.add(change.changeId);
      return false;
    }
    const told = this.#kindWanted(CLASS_OF_KIND.get(change.kind));
    if (told && change.collectionId !== null && change.serverId !== null && !group.colls.some((c) => c.id === change.collectionId)) {
      const key = `${group.slot}\n${change.collectionId}`;
      if (!run.orphans.has(key)) {
        run.orphans.add(key);
        const ids = await this.#store.serverIds(group.calendarId, change.collectionId);
        for (let from = 0; from < ids.length; from += APPLY_MAX) {
          await this.#store.applyServerChanges(group.calendarId, ids.slice(from, from + APPLY_MAX).map((serverId) => ({ op: "detach", collectionId: change.collectionId, serverId })));
        }
        this.#log?.warn?.(`${this.#what} ${group.slot} : ${ids.length} élément(s) d'un dossier inconnu, gardé(s) localement, détaché(s) du serveur.`);
      }
      run.dropped++; // (detaching forgets the change: the copy keeps what the user wrote)
      run.later.add(change.changeId); // (and should the calendar still name it, it is not looked at twice)
      return true;
    }
    const done = await this.#drop(run, group, null, change, null);
    if (done && told) run.dropped++;
    return done;
  }

  /**
   * After a rebuild, a change or a deletion whose item the server did not
   * send again (`other` false), or whose ServerId now names another item
   * (`other` true): it is not sent. The user's version stays as a local
   * copy, detached; a deleted item simply leaves. A deletion aimed at an
   * item that is now another one is undone: that item is shown.
   * → true when the change is settled
   */
  async #stray(run, group, coll, change, other) {
    this.#log?.warn?.(`${this.#what} ${coll.serverId} : élément ${change.serverId} ${other ? "différent" : "absent"} sur le serveur après resynchronisation, modification locale non envoyée.`);
    if (other && change.op === "delete") return this.#drop(run, group, coll, change, "serverChanged");
    const [r] = await this.#store.applyServerChanges(group.calendarId, [{ op: "detach", collectionId: coll.id, serverId: change.serverId }]);
    if (!r?.ok) {
      run.kept.add(change.changeId);
      return false;
    }
    run.later.add(change.changeId); // (the change went with the link: it is not looked at twice)
    coll.guards.delete(change.serverId);
    coll.tries.delete(change.changeId);
    coll.answered.delete(change.changeId);
    coll.count = Math.max(0, coll.count - 1);
    coll.dirty = true;
    this.#rememberSequence(run, coll.id, change.serverId, 0);
    if (other) this.#refetch(coll, change.serverId); // the server's item comes as any other
    if (change.op === "modify") this.#scheduler.notice("detached", (change.item ?? change.previous)?.summary ?? "");
    return true;
  }

  /**
   * The user answered an invitation. → "done" (acknowledged or undone
   * here), or "upload" (the server took the answer, or no invitation can
   * be named and nothing was sent: what the change holds goes with the
   * next request, as any other change).
   */
  async #answer(run, group, coll, change, plan) {
    const cal = group.calendarId;
    // An answer the server already took (the change could not be settled then) is not given a second time.
    let given = coll.answered.get(change.changeId);
    if (!given || given.response !== plan.response) {
      const r = await this.#scheduler.answer({ client: run.client, signal: run.signal, change: { ...change, collectionId: coll.serverId }, plan });
      if (r?.outcome === "plain") return "upload"; // synchronized as it is; the item is never removed
      if (r?.outcome !== "answered") {
        await this.#drop(run, group, coll, change, null); // the scheduler told the user
        return "done";
      }
      run.counts.sent++;
      given = { response: plan.response, calendarId: r.calendarId };
      coll.answered.delete(change.changeId);
      coll.answered.set(change.changeId, given);
      while (coll.answered.size > TRIES_MAX) coll.answered.delete(coll.answered.keys().next().value);
      await this.#saveColl(coll); // written down before anything else is tried
    }
    const settled = () => {
      if (coll.answered.delete(change.changeId)) coll.dirty = true;
    };
    if (change.op === "modify") {
      if (!onlyAnswer(change.item, change.previous)) return "upload";
      await this.#store.ackLocalChange(cal, change.changeId, { item: change.item });
      settled();
      return "done";
    }
    // Added from the invitation bar: bound to the calendar item the server names, which lives in the default calendar.
    const inDefault = group.slot === MAIN && coll.cls === CALENDAR;
    if (given.calendarId && inDefault) {
      await this.#store.ackLocalChange(cal, change.changeId, { serverId: given.calendarId, collectionId: coll.id, item: change.item });
      settled();
      return "done";
    }
    // Declined (the server keeps no item), or added to another calendar than the server's: nothing more is sent
    // for it, and the calendar store keeps it as a local copy.
    if (plan.response === "declined" || !inDefault) {
      await this.#drop(run, group, coll, change, null);
      return "done";
    }
    return "upload"; // accepted, and the server named no item: sent as a new one rather than lost
  }

  /**
   * A local change is given up: undone, and the user told. A new item
   * stays as a local copy; for any other change the server's version is
   * fetched again.
   */
  async #refuse(run, group, coll, change) {
    const done = await this.#drop(run, group, coll, change, "changeRefused");
    if (change.op !== "add" && change.serverId) this.#refetch(coll, change.serverId);
    return done;
  }

  #options(coll, replay) {
    // A request sent again goes as it went: with the period it had.
    const filterType = replay && coll.filter !== null ? coll.filter : this.#filterOf(coll.cls);
    // Contacts have no period: Conflict 1, then the body preference.
    if (coll.cls === CONTACTS) return [el("AirSync:Conflict", "1"), ...contactOptions()];
    const base = coll.cls === CALENDAR ? calendarOptions({ filterType }) : taskOptions({ filterType });
    // FilterType, then Conflict 1 (the server wins), then the body preference.
    return [base[0], el("AirSync:Conflict", "1"), ...base.slice(1)];
  }

  /** Send one Sync request, with smaller batches when the answer is too big or too slow. */
  async #send(run, coll, commands, replay) {
    for (;;) {
      checkAbort(run.signal);
      const root = syncRequest([
        {
          collectionId: coll.serverId,
          syncKey: coll.syncKey,
          supported: coll.cls === CALENDAR ? calendarSupported(run.version) : coll.cls === CONTACTS ? contactSupported() : undefined,
          deletesAsMoves: true,
          getChanges: true,
          windowSize: coll.windowSize ?? PIM_WINDOW_SIZE,
          options: this.#options(coll, replay),
          commands,
        },
      ]);
      try {
        const single = (coll.windowSize ?? PIM_WINDOW_SIZE) === 1;
        return await run.client.command("Sync", root, { signal: run.signal, timeoutMs: SYNC_TIMEOUT_MS, maxBytes: single ? SYNC_MAX_BYTES_SINGLE : SYNC_MAX_BYTES });
      } catch (e) {
        const size = coll.windowSize ?? PIM_WINDOW_SIZE;
        if (size > 1 && (e?.code === ERR.TOO_LARGE || (e?.code === ERR.TIMEOUT && e?.sent))) {
          coll.windowSize = Math.max(1, Math.floor(size / 2));
          this.#log?.info?.(`${this.#what} ${coll.serverId} : réponse trop lourde, lots réduits à ${coll.windowSize} élément(s).`);
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * A server item → its description. Throws ProtocolError when it cannot
   * be read. From a Change command the description may leave out what the
   * server did not say (a body that did not change): the calendar store
   * keeps what it holds.
   */
  #describe(run, coll, cmd) {
    const fallbackUid = derivedId("sync443-", coll.id, cmd.serverId);
    const change = cmd.op === "change" && cmd.fetched !== true;
    if (coll.cls === TASKS) return readTask(cmd.data, { version: run.version, fallbackUid, change });
    if (coll.cls === CONTACTS) return readContact(cmd.data, { version: run.version, fallbackUid, change });
    const item = readEvent(cmd.data, { version: run.version, ownEmail: this.#mailbox.email, fallbackUid, change });
    const sequence = run.sequences.get(coll.id)?.get(cmd.serverId);
    return sequence ? { ...item, sequence } : item;
  }

  #quarantine(coll, sid, code) {
    coll.quarantine.delete(sid);
    coll.quarantine.set(sid, String(code).slice(0, 40));
    while (coll.quarantine.size > QUARANTINE_MAX) coll.quarantine.delete(coll.quarantine.keys().next().value);
    this.#log?.warn?.(`${this.#what} ${coll.serverId} : élément ${sid} illisible ou refusé (${String(code).slice(0, 40)}), ignoré.`);
  }

  /**
   * The server did not answer our commands: a collection or command
   * status that is not a success (`status`), an empty or unreadable answer
   * (null). → the error that fails the pass for this collection. What was
   * written down stays, to be sent again as it was; after MAX_STRIKES
   * failures in a row each change goes alone. Only a change that went
   * alone, to a server that does not say it is unwell, has a try counted.
   * A change that went alone and that the server says it did not take is
   * no longer kept as a request in flight: another change may go first
   * next time. (After an answer that says nothing, the server may have
   * taken it: that request is sent again as it was.)
   */
  async #unanswered(run, coll, cmds, status) {
    const error = status === null ? badResponse("Sync") : serverError(`Sync ${coll.serverId}`, status);
    if (!cmds.length) return error;
    coll.strikes++;
    if (cmds.length === 1) {
      this.#wait(run, coll, cmds[0], status === null || !UNWELL.has(status));
      if (status !== null) await this.#removeOut(coll.id);
    } else if (coll.strikes >= MAX_STRIKES) {
      for (const c of cmds) this.#wait(run, coll, c, false);
      await this.#saveWas(coll, cmds);
      await this.#removeOut(coll.id);
      this.#log?.warn?.(`${this.#what} ${coll.serverId} : requête sans réponse ${coll.strikes} fois de suite, ses ${cmds.length} modifications partiront une à une.`);
    }
    await this.#saveColl(coll);
    return error;
  }

  /**
   * One Sync request for one collection and its whole answer: `uploads`
   * (from #triage) or `replay` (the commands of a request whose answer was
   * lost).
   */
  async #batch(run, group, coll, { uploads = [], replay = null } = {}) {
    const cal = group.calendarId;
    const cid = coll.id;
    const initial = coll.syncKey === "0";

    // 1. Our commands, written down before they leave.
    let cmds = [];
    const elements = [];
    if (replay) {
      try {
        for (const c of replay) {
          const data = this.#write(run, coll, c);
          elements.push(c.op === "add" ? addCommand(c.clientId, data) : c.op === "modify" ? changeCommand(c.serverId, data) : deleteCommand(c.serverId));
        }
        cmds = replay;
      } catch {
        // What was written down cannot be sent again as it was: the changes are read and sent afresh.
        await this.#removeOut(cid);
        run.more = true;
        return;
      }
    } else if (!initial) {
      // (Commands cannot go with an initial SyncKey: they wait for the next request.)
      const was = await this.#wasOf(coll);
      for (const { change, data } of uploads) {
        // A new item that already went once goes under the ClientId it had: the server may know it by that one.
        const first = change.op === "add" ? was.find((x) => x.op === "add" && x.changeId === change.changeId)?.clientId : null;
        const c = {
          id: change.changeId,
          changeId: change.changeId,
          op: change.op,
          kind: change.kind,
          clientId: change.op === "add" ? first ?? derivedId("c", cid, coll.syncKey, change.changeId) : null,
          serverId: change.op === "add" ? null : change.serverId,
          collectionId: cid,
          item: change.item,
          previous: change.previous,
          detached: change.detached === true,
          problem: null,
        };
        cmds.push(c);
        elements.push(c.op === "add" ? addCommand(c.clientId, data) : c.op === "modify" ? changeCommand(c.serverId, data) : deleteCommand(c.serverId));
      }
      if (cmds.length) {
        await this.#records.set(outRecord(cid), { key: coll.syncKey, cmds: storedCmds(cmds) });
      }
    }
    const fetches = initial || replay ? [] : [...coll.refetch].slice(0, PIM_WINDOW_SIZE);

    // 2. The request. A failure of the connection leaves what was written down: sent again at the next pass.
    const doc = await this.#send(run, coll, [...elements, ...fetches.map(fetchCommand)], Boolean(replay));

    if (doc === null) {
      // An empty answer: nothing new, the SyncKey unchanged. Never to an initial SyncKey, and no answer to commands.
      if (initial) throw badResponse("Sync");
      if (cmds.length) throw await this.#unanswered(run, coll, cmds, null);
      await this.#removeOut(cid); // (nothing is in flight: what a damaged record says is forgotten)
      for (const sid of fetches) coll.refetch.delete(sid); // asked once: an item the server says nothing of is not asked for ever
      if ((coll.strikes && !coll.tries.size) || fetches.length) {
        if (!coll.tries.size) coll.strikes = 0;
        coll.dirty = true;
      }
      if (coll.more || coll.full) {
        const rebuilt = Boolean(coll.full);
        coll.more = false;
        if (rebuilt) await this.#finishFull(run, group, coll);
        await this.#saveColl(coll);
        if (rebuilt) await (await this.#seen(coll)).clear();
      }
      return;
    }
    let parsed;
    try {
      parsed = parseSync(doc);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      await this.#unanswered(run, coll, cmds, null);
      throw badResponse("Sync", e);
    }
    if (parsed.status && parsed.status !== "1") throw await this.#unanswered(run, coll, cmds, parsed.status);
    const c = parsed.collections.find((x) => x.collectionId === coll.serverId);
    if (!c) throw await this.#unanswered(run, coll, cmds, null);
    if (c.status === "3") {
      this.#log?.warn?.(`${this.#what} ${coll.serverId} : clé de synchronisation refusée, resynchronisation complète du dossier.`);
      coll.strikes++;
      await this.#reset(run, coll, "status3");
      run.more = true;
      // A server that refuses every key it gave is not followed for ever.
      if (coll.strikes >= MAX_STRIKES) throw serverError(`Sync ${coll.serverId}`, c.status);
      return;
    }
    if (c.status === "8" || c.status === "12") {
      // The folder is gone or the hierarchy changed: FolderSync first (next pass). Said at every pass, it is a failure.
      await this.#removeOut(cid);
      for (const x of cmds) run.kept.add(x.changeId);
      coll.stale = true;
      run.hierarchyChanged = true;
      coll.strikes++;
      await this.#saveColl(coll);
      if (coll.strikes >= MAX_STRIKES) throw serverError(`Sync ${coll.serverId}`, c.status);
      return;
    }
    if (c.status !== "1") throw await this.#unanswered(run, coll, cmds, c.status);
    if (!c.syncKey) throw await this.#unanswered(run, coll, cmds, null);

    // 3. The server's answer to each of our commands.
    const added = new Map(c.clientResponses.adds.map((a) => [a.clientId, a]));
    const changeErrors = new Map(c.clientResponses.changes.map((x) => [x.serverId, x.status]));
    const deleteErrors = new Map(c.clientResponses.deletes.map((x) => [x.serverId, x.status]));
    const ends = []; // what is remembered of the items written in this batch
    let waiting = null; // the first status that left a change waiting
    for (const cmd of cmds) {
      checkAbort(run.signal);
      let status;
      let serverId = cmd.serverId;
      if (cmd.op === "add") {
        const a = added.get(cmd.clientId);
        status = a ? (a.status === "1" && !a.serverId ? null : a.status) : null; // no answer, or no ServerId: not accepted
        serverId = a?.serverId ?? null;
      } else if (cmd.op === "modify") {
        status = changeErrors.get(cmd.serverId) ?? "1";
      } else {
        status = deleteErrors.get(cmd.serverId) ?? "1";
        if (status === GONE) status = "1"; // already gone from the server: deleted all the same
      }
      if (status === "1") {
        await this.#accepted(run, group, coll, cmd, serverId, ends);
      } else if (status === null || DEFINITIVE.has(status)) {
        this.#log?.warn?.(`${this.#what} ${coll.serverId} : modification locale refusée par le serveur (Status ${status ?? "absent"}).`);
        await this.#refuse(run, group, coll, cmd);
      } else {
        // "Server error", "retry", or a status that says nothing final: the change waits, and goes alone next
        // time. A try is held against it only if it went alone and the server does not say it is unwell.
        this.#log?.warn?.(`${this.#what} ${coll.serverId} : modification locale laissée en attente par le serveur (Status ${status}).`);
        waiting ??= status;
        this.#wait(run, coll, cmd, cmds.length === 1 && !UNWELL.has(status));
      }
    }

    // The first answer that can be read after a request was cut into single changes: the server may have taken
    // that request whole, and then says here what became of each of its new items, by the ClientId it went with.
    if (coll.was) {
      const mine = new Set(cmds.map((x) => x.changeId));
      for (const old of await this.#wasOf(coll)) {
        const a = old.op === "add" && !mine.has(old.changeId) ? added.get(old.clientId) : null;
        if (a?.status === "1" && a.serverId) await this.#accepted(run, group, coll, old, a.serverId, ends);
      }
      await this.#saveWas(coll, (await this.#wasOf(coll)).filter((old) => coll.tries.has(old.changeId)));
    }

    // 4. The server's own changes, and the items fetched again. The last word on an item wins.
    const wanted = new Set(fetches);
    const commands = [...c.commands];
    for (const r of c.responses) {
      if (r.op !== "fetch" || !coll.refetch.has(r.serverId)) continue;
      coll.refetch.delete(r.serverId);
      wanted.delete(r.serverId);
      if (r.status === "1" && r.data) commands.push({ op: "change", serverId: r.serverId, data: r.data, fetched: true });
      else if (r.status === GONE) commands.push({ op: "delete", serverId: r.serverId });
    }
    for (const sid of wanted) coll.refetch.delete(sid); // asked once: an item the server says nothing of is not asked for ever

    const last = new Map(); // ServerId → { op: "put", item } | { op: "lock" } | { op: "delete" }
    const seenNow = [];
    for (const cmd of commands) {
      const sid = cmd.serverId;
      if (cmd.op === "add" || cmd.op === "change") {
        seenNow.push(sid); // on the server, whatever becomes of it here
        let item;
        try {
          item = this.#describe(run, coll, cmd);
        } catch (e) {
          if (!(e instanceof ProtocolError)) throw e;
          // A Change with nothing for us to apply is not a bad item.
          if (cmd.op === "change" && e.code === "INCOMPLETE_ITEM") continue;
          this.#quarantine(coll, sid, e.code ?? "BAD_ITEM");
          // The copy held, if there is one, no longer says what the server has: nothing is changed from it.
          last.delete(sid);
          last.set(sid, { op: "lock" });
          continue;
        }
        last.delete(sid);
        last.set(sid, { op: "put", item });
      } else if (cmd.op === "delete" || cmd.op === "softdelete") {
        // An item the server says left the period is a deletion like any other for the threshold, unless this
        // side can see that it did leave (below).
        last.delete(sid);
        last.set(sid, { op: "delete", soft: cmd.op === "softdelete" });
        coll.quarantine.delete(sid);
      }
    }
    // A rebuild: is the item the server sends under a ServerId the one the user's waiting change was made on?
    const rebuilding = Boolean(coll.full);
    if (rebuilding) {
      for (const [sid, a] of last) {
        const guard = coll.guards.get(sid);
        if (a.op !== "put" || guard === undefined || guard.startsWith(SAME) || guard.startsWith(OTHER)) continue;
        coll.guards.set(sid, `${identityOf(a.item) === guard ? SAME : OTHER}${guard}`);
      }
    }
    // The collection never holds more than MAX_PIM_ITEMS items, however they come (an Add, or a Change for an
    // item not held). Near the limit, what is held is counted for good.
    let held = null;
    let room = 0;
    const putCount = [...last.values()].filter((a) => a.op === "put").length;
    if (putCount && coll.count + putCount > MAX_PIM_ITEMS) {
      held = new Set(await this.#store.serverIds(cal, cid));
      coll.count = held.size;
      room = Math.max(0, MAX_PIM_ITEMS - held.size);
    }
    // SoftDelete: what was remembered of each item (as after a change of period) tells those that are out of
    // the period by themselves. They leave without counting: an honest server after an absence holds nothing.
    const soft = [...last].filter(([, a]) => a.op === "delete" && a.soft).map(([sid]) => sid);
    const left = soft.length ? await this.#left(coll, soft) : new Set();
    const changes = [];
    const deleted = [];
    for (const [sid, a] of last) {
      if (a.op === "delete" && left.has(sid)) {
        changes.push({ op: "remove", collectionId: cid, serverId: sid });
      } else if (a.op === "delete") {
        deleted.push(sid);
      } else if (a.op === "lock") {
        changes.push({ op: "lock", collectionId: cid, serverId: sid });
      } else if (held && !held.has(sid) && room <= 0) {
        this.#quarantine(coll, sid, "LIMIT");
      } else {
        if (held && !held.has(sid)) room--;
        changes.push({ op: "put", collectionId: cid, serverId: sid, item: a.item });
      }
    }
    checkAbort(run.signal);
    const results = changes.length ? await this.#store.applyServerChanges(cal, changes) : [];
    let puts = 0;
    let internal = 0;
    const putIds = new Set();
    const refused = [];
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      const r = results[i];
      if (change.op === "remove") {
        if (r.ok) {
          run.counts.received++;
          coll.count = Math.max(0, coll.count - 1);
          this.#rememberSequence(run, cid, change.serverId, 0);
        }
        continue;
      }
      if (change.op !== "put") continue; // a lock: nothing to count
      puts++;
      if (r.ok) {
        putIds.add(change.serverId);
        coll.quarantine.delete(change.serverId);
        run.counts.received++;
        if (!held || !held.has(change.serverId)) coll.count++;
        if (coll.cls !== CONTACTS) ends.push([change.serverId, leaveMark(change.item)]); // a contact never leaves by itself
      } else {
        if (r.code === "INTERNAL") internal++;
        this.#quarantine(coll, change.serverId, r.code);
        refused.push(change.serverId);
      }
    }
    if (puts >= 2 && internal === puts) {
      // Every write failed: the cause is not the items. Nothing is saved, the batch comes again, but not for ever.
      const key = `${cid}\n${coll.syncKey}`;
      const n = (this.#stuck.get(key) ?? 0) + 1;
      if (n < STUCK_LIMIT) {
        this.#stuck.set(key, n);
        throw new EasError(SYNC_ERR.LOCAL, `${this.#what} ${coll.serverId} : écriture impossible dans Thunderbird (${puts} échecs).`);
      }
      this.#stuck.delete(key);
    }
    // An item the calendar refused: the copy held, if there is one, is no longer what the server has.
    if (refused.length) await this.#store.applyServerChanges(cal, refused.map((serverId) => ({ op: "lock", collectionId: cid, serverId })));

    // A server deletion waits for the end of the collection's run; an item sent again is no longer deleted.
    const entry = run.deletes.get(cid);
    let deletesChanged = false;
    if (entry && !entry.retained && !entry.folder && putIds.size) {
      const before = entry.ids.length;
      entry.ids = entry.ids.filter((sid) => !putIds.has(sid));
      if (entry.ids.length !== before) deletesChanged = true;
      if (!entry.ids.length) run.deletes.delete(cid);
    }
    if (deleted.length) {
      let e = run.deletes.get(cid);
      if (!e) {
        e = { ids: [], at: this.#now(), retained: false, base: 0 };
        run.deletes.set(cid, e);
      }
      // (Bounded: a server that never stops deleting does not fill the memory.)
      const known = new Set(e.ids);
      for (const sid of deleted) {
        if (known.has(sid) || e.ids.length >= MAX_PIM_ITEMS) continue;
        known.add(sid);
        e.ids.push(sid);
      }
      deletesChanged = true;
    }
    if (deletesChanged) await this.#saveDeletes(run.deletes); // written before the SyncKey moves on

    // What the rebuild has seen so far.
    if (rebuilding && seenNow.length) {
      const seen = await this.#seen(coll);
      if (seen.ids.size + seenNow.length > MAX_PIM_ITEMS) coll.overflow = true;
      else await seen.add(seenNow);
    }
    if (ends.length) await (await this.#ends(coll)).add(ends);

    // 5. The SyncKey, once everything it covers is applied.
    coll.syncKey = c.syncKey;
    coll.filter = replay && coll.filter !== null ? coll.filter : this.#filterOf(coll.cls);
    coll.more = initial || c.moreAvailable;
    // (An answer that carried none of our commands says nothing of a change that still waits to go alone.)
    if (!initial) coll.strikes = waiting !== null ? coll.strikes + 1 : cmds.length || !coll.tries.size ? 0 : coll.strikes;
    if (!coll.more && coll.full) await this.#finishFull(run, group, coll);
    await this.#saveSequences(run);
    await this.#saveColl(coll);
    await this.#removeOut(cid);
    if (rebuilding && !coll.full) await (await this.#seen(coll)).clear();
    // Changes the server leaves waiting pass after pass are a failure the user must see.
    if (waiting !== null && coll.strikes >= MAX_STRIKES) throw serverError(`Sync ${coll.serverId}`, waiting);
  }

  /** The server accepted a local change: its messages are queued, then it is acknowledged in the calendar store. */
  async #accepted(run, group, coll, cmd, serverId, ends) {
    const cid = coll.id;
    let item = cmd.item;
    try {
      const plan = this.#scheduler.plan(cmd, { version: run.version });
      if (plan.flow === "organize") {
        // Before the acknowledgement: stopped in between, the request is replayed and the messages are still there.
        // Named by the SyncKey the change went with: a replayed request names the same change, a later
        // change of the same item another one.
        const r = await this.#scheduler.enqueue({ key: `${cid}|${coll.syncKey}|${cmd.changeId}`, change: cmd, plan });
        if (r.item) item = r.item;
        if (cmd.op !== "delete" && serverId) this.#rememberSequence(run, cid, serverId, r.sequence);
      }
      const options = cmd.op === "add" ? { serverId, collectionId: cid, item } : cmd.op === "modify" ? { item } : {};
      const done = await this.#store.ackLocalChange(group.calendarId, cmd.changeId, options);
      // A new item the calendar no longer has (deleted here before the answer came, and Thunderbird restarted
      // since): it is on the server all the same, and is fetched to be seen. (One the user only changed again is
      // bound, and its newer change follows.)
      if (!done && cmd.op === "add" && serverId && !(await this.#store.serverIds(group.calendarId, cid)).includes(serverId)) this.#refetch(coll, serverId);
    } catch (e) {
      this.#log?.warn?.(`${this.#what} ${coll.serverId} : accusé local impossible (${errorCode(e)}).`);
      // The server has the change; the calendar could not record it. A new item the calendar could not bind
      // would be created again on the server if it were sent again: the server's item is written in its
      // place instead. Anything else is left as it is, and sent again a few times.
      let replaced = false;
      if (cmd.op === "add" && serverId) {
        try {
          const [r] = await this.#store.applyServerChanges(group.calendarId, [{ op: "put", collectionId: cid, serverId, item }]);
          replaced = r.ok && (await this.#store.dropLocalChange(group.calendarId, cmd.changeId));
        } catch {
          replaced = false;
        }
      }
      if (!replaced) {
        this.#wait(run, coll, cmd, true);
        return;
      }
    }
    run.counts.sent++;
    coll.tries.delete(cmd.changeId);
    coll.answered.delete(cmd.changeId);
    // During a rebuild the server does not send back what it just took from us: it is there all the same.
    if (coll.full && cmd.op !== "delete" && serverId) {
      const seen = await this.#seen(coll);
      if (seen.ids.size >= MAX_PIM_ITEMS) coll.overflow = true;
      else await seen.add([serverId]);
    }
    if (cmd.op === "add") coll.count++;
    if (cmd.op === "delete") {
      coll.count = Math.max(0, coll.count - 1);
      coll.quarantine.delete(serverId);
      this.#rememberSequence(run, cid, serverId, 0);
    } else if (serverId && coll.cls !== CONTACTS) {
      ends.push([serverId, leaveMark(item)]);
    }
    if (serverId) coll.guards.delete(serverId);
  }

  /**
   * The items among `stale` that this module can see left the period by
   * themselves (see leaveMark): → Set<ServerId>. An event that does not
   * recur and ended before the limit of the calendar period; a completed
   * task when only incomplete ones are asked for. From what was remembered
   * when each item was last written, never from what the server says now.
   */
  async #left(coll, stale) {
    const filter = this.#filterOf(coll.cls);
    const days = coll.cls === CALENDAR ? PERIOD_DAYS.get(filter) : null;
    const out = new Set();
    if (coll.cls === CONTACTS) return out; // a contact never leaves by itself
    if (coll.cls === CALENDAR ? !days : filter !== INCOMPLETE_TASKS) return out;
    const marks = await EndLog.load(this.#records, coll.id, await this.#records.names());
    const limit = Math.floor((this.#now() - (days ?? 0) * 86_400_000) / 60_000);
    for (const sid of stale) {
      const mark = marks.get(sid) ?? 0;
      if (coll.cls === CALENDAR ? mark >= 2 && mark < limit : mark === 1) out.add(sid);
    }
    return out;
  }

  /**
   * The rebuild of a collection is over: local items the server did not
   * send again are no longer there. They are deletions like any other,
   * judged by the threshold (#settle); after a change of period, those
   * this module can see left the period are removed without counting. An
   * item the user's change waits on is left to #triage (#stray).
   */
  async #finishFull(run, group, coll) {
    const cal = group.calendarId;
    const cid = coll.id;
    const local = await this.#store.serverIds(cal, cid);
    coll.count = local.length;
    if (coll.overflow) {
      this.#log?.warn?.(`${this.#what} ${coll.serverId} : trop d'éléments pour comparer avec le serveur, rien n'est retiré.`);
    } else {
      const seen = await this.#seen(coll);
      let stale = local.filter((sid) => !seen.ids.has(sid) && !coll.guards.has(sid));
      if (stale.length && coll.full === "period") {
        const left = await this.#left(coll, stale);
        const gone = stale.filter((sid) => left.has(sid));
        stale = stale.filter((sid) => !left.has(sid));
        if (gone.length) {
          const removed = await this.#remove(run, cal, cid, gone);
          run.counts.received += removed;
          coll.count = Math.max(0, coll.count - removed);
          this.#log?.info?.(`${this.#what} ${coll.serverId} : ${removed} élément(s) hors de la période retiré(s).`);
        }
      }
      if (stale.length) {
        const entry = run.deletes.get(cid) ?? { ids: [], at: this.#now(), retained: false, base: 0 };
        if (!entry.folder && !entry.retained) {
          const known = new Set(entry.ids);
          for (const sid of stale) if (!known.has(sid)) entry.ids.push(sid);
          run.deletes.set(cid, entry);
          await this.#saveDeletes(run.deletes);
        }
      }
    }
    // A collection filled for the first time: its window of deletions opens with what it holds now.
    if (!coll.window) this.#open(coll, coll.count);
    coll.full = null;
    coll.overflow = false;
  }

  /**
   * End of a collection's run of deletions: applied, or, beyond the
   * mass-deletion threshold, held for the user. The threshold is taken
   * over the rolling window, against the items held when it opened (or
   * now, if there are fewer): never against what the server added since.
   */
  async #settle(run, group, coll) {
    if (coll.more || coll.full) return;
    const cid = coll.id;
    const entry = run.deletes.get(cid);
    if (!entry || entry.retained || entry.folder) return;
    const local = new Set(await this.#store.serverIds(group.calendarId, cid));
    entry.ids = entry.ids.filter((sid) => local.has(sid)); // only what is held can be deleted
    const n = entry.ids.length;
    if (!n) {
      run.deletes.delete(cid);
      await this.#saveDeletes(run.deletes);
      return;
    }
    const now = this.#now();
    const open = coll.window && now - coll.window.since < MASS_DELETE_WINDOW_MS && now >= coll.window.since;
    const window = open ? coll.window : { since: now, count: 0, base: local.size };
    // Against the fewest items held at the opening of a window this week, or now: never against what was added since.
    const base = Math.min(window.base, local.size, ...coll.sizes.filter((e) => now - e[0] < SIZES_MS && now >= e[0]).map((e) => e[1]));
    if (isMassDelete(window.count + n, base)) {
      entry.retained = true;
      await this.#saveDeletes(run.deletes);
      this.#log?.warn?.(`${this.#what} ${coll.serverId} : ${n} suppressions demandées par le serveur sur ${base} éléments ; suppressions retenues jusqu'à confirmation.`);
      return;
    }
    const removed = await this.#remove(run, group.calendarId, cid, entry.ids);
    run.counts.received += removed;
    coll.count = Math.max(0, local.size - removed);
    coll.window = { ...window, count: window.count + n };
    await this.#saveSequences(run);
    await this.#saveColl(coll);
    run.deletes.delete(cid);
    await this.#saveDeletes(run.deletes);
  }
}
