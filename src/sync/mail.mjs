// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Mail synchronisation of one collection (server folder ↔ local folder).
 *
 * Identity. Thunderbird renumbers its messages at every start, so no
 * Thunderbird id is ever kept: on the server a message is a ServerId in a
 * collection, in Thunderbird a Message-ID in a folder. Each collection has
 * a table ServerId → Message-ID (record `coll:<ServerId>`), with its
 * reverse index Message-ID → {ServerId} built in memory.
 *
 * No alias. Several local copies may share a Message-ID, and several
 * ServerIds may point to the same Message-ID; the table always keeps at
 * most as many ServerIds per Message-ID as there are local copies:
 *  - a server Add whose Message-ID is already in the folder is attached to
 *    the local message when one copy is still unattached; otherwise a
 *    distinct copy is imported;
 *  - Thunderbird refuses to import a second message with a Message-ID the
 *    folder already holds, so that distinct copy gets its own Message-ID:
 *    <hex@sync443.invalid>, hex from SHA-256 of the message, the
 *    collection and the ServerId (the same item always gets the same id),
 *    the original field kept as X-Sync443-Original-Message-ID;
 *  - a local message is deleted only when no ServerId points to it any
 *    more; local deletions and moves are reconciled by count (ServerIds
 *    beyond the number of local copies left are the ones to delete or move).
 *
 * Server deletions: the ServerId is unlinked at once (the table follows the
 * server), and the local action waits for the end of the collection's pass,
 * kept meanwhile in `pendingDeletes` (written before the SyncKey moves on).
 * Then, below the mass-deletion threshold, the local copy goes to the local
 * trash (in the trash, it is deleted), unless a ServerId points to it
 * again (an item the server re-created). Beyond the threshold (more than 50
 * deletions AND more than 20 % of the folder in one pass, whatever the
 * size of the batches), the deletions stay in `pendingDeletes`, marked
 * retained, for the user to confirm. Soft deletions (items leaving the
 * period filter) only unlink: the local copy stays, still on the server.
 *
 * A batch is processed as a whole before its SyncKey is saved. An item that
 * cannot be processed is quarantined (logged, counted, skipped) without
 * blocking the others; if every local write of a batch fails, the cause is
 * not the items: nothing is saved and the error goes up (STUCK_LIMIT passes
 * in a row at most; then the batch goes through, quarantined, so a batch
 * Thunderbird always refuses cannot stop the folder for ever). Replaying a
 * batch (same SyncKey after a crash or a cancellation) is harmless: an Add finds
 * its message already imported and attaches it, a Delete finds nothing left.
 */

import { syncRequest, parseSync, changeCommand, deleteCommand, moveItemsRequest, parseMoveItems, ProtocolError } from "../core/protocol.mjs";
import { readEmail, changeEmail, mailOptions } from "../core/mail-codec.mjs";
import { stripInternalHeaders, ensureMessageId, SYNTHETIC_DOMAIN } from "../core/mime.mjs";
import { sha256, toHex } from "../core/sha256.mjs";
import { encodeUtf8 } from "../core/utf8.mjs";
import * as v from "../core/sanitize.mjs";
import { EasError, ERR } from "../transport/client.mjs";
import { recordName } from "./store.mjs";

export const WINDOW_SIZE = 50;
/** Most Sync batches for one collection in one pass (MoreAvailable is bounded). */
export const MAX_BATCHES = 20;
/** Mass deletion: more than this many deletions… */
export const MASS_DELETE_COUNT = 50;
/** …and more than this share of the folder, in one pass. */
export const MASS_DELETE_RATIO = 0.2;
export const QUARANTINE_MAX = 500;
/** Passes in a row a batch may fail as a whole before its items are only quarantined (see processCommands). */
export const STUCK_LIMIT = 3;
/** Most items one collection table holds (a hostile server cannot fill the storage). */
export const MAX_ITEMS = 250_000;
/** Response size cap of a Sync request; raised when the window has shrunk to one message. */
export const SYNC_MAX_BYTES = 24 * 1024 * 1024;
export const SYNC_MAX_BYTES_SINGLE = 64 * 1024 * 1024;
export const SYNC_TIMEOUT_MS = 180_000;
/** Name of the original Message-ID field in a distinct copy. */
export const ORIGINAL_ID_FIELD = "X-Sync443-Original-Message-ID";

export const SYNC_ERR = Object.freeze({ SERVER: "SERVER", LOCAL: "LOCAL", MASS_DELETE: "MASS_DELETE" });

const PENDING = "pendingDeletes";
const MAX_MESSAGE_ID = 998;
const TRANSIENT_ITEM_STATUS = new Set(["5", "16"]);

export const collRecord = (serverId) => recordName("coll", serverId);

const validMid = (m) => typeof m === "string" && m.length >= 1 && m.length <= MAX_MESSAGE_ID && !/[\s\u0000-\u001f\u007f]/.test(m);
const validPath = (p) => typeof p === "string" && p.startsWith("/") && p.length <= 2048;

function cancelled() {
  return new EasError(ERR.CANCELLED, "Synchronisation annulée.");
}

export function serverError(what, status) {
  return new EasError(SYNC_ERR.SERVER, `${what} : refus du serveur (Status ${status ?? "absent"}).`, { status });
}

function badResponse(what, e) {
  return new EasError(ERR.BAD_RESPONSE, `${what} : réponse invalide du serveur${e?.message ? ` (${e.message})` : ""}.`);
}

/** Outcomes of journal entries: keep wins over drop, drop over done. */
export function mergeOutcome(map, id, outcome) {
  const rank = { done: 0, drop: 1, keep: 2 };
  const old = map.get(id);
  if (old === undefined || rank[outcome] > rank[old]) map.set(id, outcome);
}

// ── Collection table ─────────────────────────────────────────────────────

export class CollectionState {
  /**
   * @param {string} serverId  CollectionId
   * @param {object} [state]   { syncKey, path, items: [[ServerId, MessageId]], quarantine: [{serverId, reason, at}] }
   */
  constructor(serverId, { syncKey = "0", path = null, items = [], quarantine = [] } = {}) {
    this.serverId = serverId;
    this.syncKey = syncKey;
    this.path = path;
    this.items = new Map();
    this.reverse = new Map();
    this.quarantine = quarantine.slice(-QUARANTINE_MAX);
    for (const [sid, mid] of items) this.link(sid, mid);
  }

  /** From a stored record; anything damaged is dropped (a damaged key restarts the collection from scratch). */
  static fromRecord(serverId, raw) {
    if (!raw || typeof raw !== "object") return new CollectionState(serverId);
    const syncKey = v.syncKey(raw.syncKey) ?? "0";
    const path = validPath(raw.path) ? raw.path : null;
    const items = [];
    if (syncKey !== "0" && Array.isArray(raw.items)) {
      for (const e of raw.items) {
        if (Array.isArray(e) && e.length === 2 && v.itemId(e[0]) && validMid(e[1])) items.push([e[0], e[1]]);
      }
    }
    const quarantine = Array.isArray(raw.quarantine)
      ? raw.quarantine.filter((q) => q && v.itemId(q.serverId) && typeof q.reason === "string").map((q) => ({ serverId: q.serverId, reason: q.reason.slice(0, 200), at: Number(q.at) || 0 }))
      : [];
    return new CollectionState(serverId, { syncKey, path, items, quarantine });
  }

  toRecord() {
    return { syncKey: this.syncKey, path: this.path, items: [...this.items], quarantine: this.quarantine.map((q) => ({ ...q })) };
  }

  link(sid, mid) {
    this.unlink(sid);
    this.items.set(sid, mid);
    const set = this.reverse.get(mid);
    if (set) set.add(sid);
    else this.reverse.set(mid, new Set([sid]));
  }

  /** → the Message-ID the ServerId pointed to, or null. */
  unlink(sid) {
    const mid = this.items.get(sid);
    if (mid === undefined) return null;
    this.items.delete(sid);
    const set = this.reverse.get(mid);
    set?.delete(sid);
    if (set && !set.size) this.reverse.delete(mid);
    return mid;
  }

  midOf(sid) {
    return this.items.get(sid) ?? null;
  }

  refs(mid) {
    return this.reverse.get(mid)?.size ?? 0;
  }

  /** ServerIds of a Message-ID, oldest link first. */
  serverIdsOf(mid) {
    return [...(this.reverse.get(mid) ?? [])];
  }

  /** Full resync: SyncKey "0", the table emptied (it is rebuilt from the server's Adds). */
  reset() {
    this.syncKey = "0";
    this.items.clear();
    this.reverse.clear();
  }

  addQuarantine(serverId, reason, at) {
    this.quarantine.push({ serverId, reason, at });
    if (this.quarantine.length > QUARANTINE_MAX) this.quarantine.splice(0, this.quarantine.length - QUARANTINE_MAX);
  }
}

export async function loadCollection(records, serverId) {
  return CollectionState.fromRecord(serverId, await records.get(collRecord(serverId), null));
}

export async function saveCollection(records, coll) {
  await records.set(collRecord(coll.serverId), coll.toRecord());
}

// ── Pending deletions (mass-deletion threshold) ──────────────────────────

/**
 * Record `pendingDeletes`: Map<CollectionId, { items: [[ServerId, MessageId]], at, retained }>.
 * retained: true when held by the mass-deletion threshold (waiting for the
 * user); false while the pass that received them has not decided yet (a
 * pass interrupted there leaves them for the next one to decide).
 * → the Map (damaged entries dropped)
 */
export async function loadPendingDeletes(records) {
  const raw = await records.getMap(PENDING);
  const out = new Map();
  for (const [cid, value] of raw) {
    if (!v.itemId(cid) || !value || !Array.isArray(value.items)) continue;
    const seen = new Set();
    const items = [];
    for (const e of value.items) {
      if (!Array.isArray(e) || e.length !== 2 || !v.itemId(e[0]) || !validMid(e[1]) || seen.has(e[0])) continue;
      seen.add(e[0]);
      items.push([e[0], e[1]]);
    }
    if (items.length) out.set(cid, { items, at: Number(value.at) || 0, retained: value.retained === true });
  }
  return out;
}

export async function savePendingDeletes(records, map) {
  if (map.size) await records.setMap(PENDING, map);
  else await records.remove(PENDING);
}

/** Number of deletions waiting (retained only, by default). */
export function countPending(map, { retainedOnly = true } = {}) {
  let n = 0;
  for (const value of map.values()) if (value.retained || !retainedOnly) n += value.items.length;
  return n;
}

/** Beyond the mass-deletion threshold? */
export function isMassDelete(count, folderSize) {
  return count > MASS_DELETE_COUNT && count > MASS_DELETE_RATIO * folderSize;
}

// ── Local folder index (per pass, in memory only) ────────────────────────

/**
 * Local copies by Message-ID in one folder, for one pass: either the whole
 * folder listed once (big batches), or looked up one Message-ID at a time.
 * Kept up to date with the engine's own writes. Ids are only valid during
 * this session; every write checks them again (mail-store `expected`).
 */
export class FolderIndex {
  constructor(mailStore, path) {
    this.mailStore = mailStore;
    this.path = path;
    this.full = null; // Map<mid, copies> once the folder has been listed
    this.cache = new Map();
  }

  async prefetch() {
    if (this.full || typeof this.mailStore.listMessages !== "function") return;
    const map = new Map();
    for (const m of await this.mailStore.listMessages(this.path)) {
      if (!validMid(m.messageId)) continue;
      const list = map.get(m.messageId);
      const copy = { id: m.id, read: Boolean(m.flags?.read), flagged: Boolean(m.flags?.flagged) };
      if (list) list.push(copy);
      else map.set(m.messageId, [copy]);
    }
    this.full = map;
  }

  async get(mid) {
    if (this.full) return [...(this.full.get(mid) ?? [])];
    let list = this.cache.get(mid);
    if (!list) {
      list = (await this.mailStore.findByMessageId(this.path, mid)).map((m) => ({ id: m.id, read: Boolean(m.flags?.read), flagged: Boolean(m.flags?.flagged) }));
      this.cache.set(mid, list);
    }
    return [...list];
  }

  /** Forget what is known about a Message-ID (asked again next time). */
  invalidate(mid) {
    if (this.full) this.full.delete(mid);
    this.cache.delete(mid);
  }

  add(mid, copy) {
    const map = this.full ?? this.cache;
    if (!this.full && !this.cache.has(mid)) return; // unknown yet: will be looked up
    const list = map.get(mid);
    if (list) list.push(copy);
    else map.set(mid, [copy]);
  }

  remove(mid, ids) {
    const map = this.full ?? this.cache;
    const list = map.get(mid);
    if (!list) return;
    const gone = new Set(ids);
    const rest = list.filter((c) => !gone.has(c.id));
    if (rest.length) map.set(mid, rest);
    else if (this.full) this.full.delete(mid);
    else this.cache.set(mid, []);
  }

  update(mid, id, flags) {
    const list = (this.full ?? this.cache).get(mid);
    const copy = list?.find((c) => c.id === id);
    if (copy) Object.assign(copy, flags);
  }
}

// ── One pass over the mailbox ────────────────────────────────────────────

/** State shared by the collections of one pass: counters, indexes, mass-deletion tallies. */
export class MailPass {
  constructor() {
    this.counts = { added: 0, changed: 0, deleted: 0, skipped: 0 };
    this.per = new Map();
    this.indexes = new Map();
    this.trashed = new Set(); // Message-IDs sent to the local trash by server deletions in this pass
    this.retained = 0; // deletions held by the mass-deletion threshold in this pass
    this.bounded = false; // a collection still had more to give when its batch budget ran out
    this.hierarchyChanged = false;
  }

  of(coll) {
    let st = this.per.get(coll.serverId);
    if (!st) {
      st = { batches: 0, initial: coll.items.size, deferred: [], window: WINDOW_SIZE };
      this.per.set(coll.serverId, st);
    }
    return st;
  }

  index(mailStore, path) {
    let idx = this.indexes.get(path);
    if (!idx) {
      idx = new FolderIndex(mailStore, path);
      this.indexes.set(path, idx);
    }
    return idx;
  }
}

/**
 * Context of one collection sync:
 *   client       { command(cmd, root, { signal, timeoutMs, maxBytes }) }
 *   records      store.mailbox(id)
 *   mailStore    tb/mail-store.mjs (or a double)
 *   log, now, signal
 *   filterType   "0".."8"
 *   trashPath    local trash folder path, or null
 *   serverTrash(collectionId) → boolean   the collection is the server's trash or inside it
 *   collectionOf(path) → CollectionState | null   synchronised collection of a local folder
 *   stuck        Map kept across passes: batches that failed as a whole, and how often (optional)
 *   pass         MailPass
 */

const inLocalTrash = (ctx, path) => Boolean(ctx.trashPath) && (path === ctx.trashPath || path.startsWith(`${ctx.trashPath}/`));

function checkAbort(ctx) {
  if (ctx.signal?.aborted) throw cancelled();
}

/** Send a Sync request, shrinking the window when the answer is too big or too slow. */
async function sendSync(ctx, coll, st, commands) {
  for (;;) {
    checkAbort(ctx);
    const root = syncRequest([
      {
        collectionId: coll.serverId,
        syncKey: coll.syncKey,
        deletesAsMoves: !ctx.serverTrash(coll.serverId),
        getChanges: true,
        windowSize: st.window,
        options: coll.syncKey === "0" ? [] : mailOptions({ filterType: ctx.filterType }),
        commands,
      },
    ]);
    try {
      return await ctx.client.command("Sync", root, {
        signal: ctx.signal,
        timeoutMs: SYNC_TIMEOUT_MS,
        maxBytes: st.window === 1 ? SYNC_MAX_BYTES_SINGLE : SYNC_MAX_BYTES,
      });
    } catch (e) {
      if (st.window > 1 && (e?.code === ERR.TOO_LARGE || (e?.code === ERR.TIMEOUT && e?.sent))) {
        st.window = Math.max(1, Math.floor(st.window / 2));
        ctx.log?.info?.(`Sync ${coll.serverId} : réponse trop lourde, lots réduits à ${st.window} message(s).`);
        continue;
      }
      throw e;
    }
  }
}

/** Number of local copies of a Message-ID in a folder (a folder that is gone holds none). */
async function localCopies(ctx, path, mid) {
  try {
    return (await ctx.mailStore.findByMessageId(path, mid)).length;
  } catch (e) {
    if (e?.code === "NOT_FOUND") return 0;
    throw e;
  }
}

/**
 * Local flags and deletions of one folder → Sync commands.
 * Deletions are reconciled by count: as many ServerIds as there are
 * ServerIds beyond the local copies left.
 * → { commands, changes: Map<sid, entryIds>, deletes: Map<sid, entryIds>, outcomes }
 */
async function planUploads(ctx, coll, entries) {
  const outcomes = new Map();
  const changes = new Map(); // sid → { flags, ids: Set }
  const deletes = new Map(); // sid → { mid, ids: Set }
  const plannedDeletes = new Map(); // mid → count
  for (const e of entries) {
    if (e.op === "flags") {
      const sids = coll.serverIdsOf(e.messageId);
      if (!sids.length) {
        outcomes.set(e.id, "done"); // not on the server (or not attached): nothing to send
        continue;
      }
      for (const sid of sids) {
        const del = deletes.get(sid);
        if (del) {
          del.ids.add(e.id);
          continue;
        }
        const c = changes.get(sid);
        if (c) {
          Object.assign(c.flags, e.flags);
          c.ids.add(e.id);
        } else {
          changes.set(sid, { flags: { ...e.flags }, ids: new Set([e.id]) });
        }
      }
      continue;
    }
    // delete
    const copies = await localCopies(ctx, coll.path, e.messageId);
    const planned = plannedDeletes.get(e.messageId) ?? 0;
    const excess = coll.refs(e.messageId) - planned - copies;
    if (excess <= 0) {
      outcomes.set(e.id, "done");
      continue;
    }
    const candidates = coll.serverIdsOf(e.messageId).filter((sid) => !deletes.has(sid));
    for (const sid of candidates.slice(-excess)) {
      const ids = new Set([e.id]);
      const c = changes.get(sid);
      if (c) {
        for (const id of c.ids) ids.add(id);
        changes.delete(sid);
      }
      deletes.set(sid, { mid: e.messageId, ids });
    }
    plannedDeletes.set(e.messageId, planned + Math.min(excess, candidates.length));
  }
  const commands = [
    ...[...changes].map(([sid, c]) => changeCommand(sid, changeEmail(c.flags))),
    ...[...deletes.keys()].map((sid) => deleteCommand(sid)),
  ];
  return { commands, changes, deletes, outcomes };
}

/**
 * One Sync request for one collection, local uploads included, and the
 * whole answer processed.
 * → { moreAvailable, reset, stale, outcomes: Map<entryId, outcome> }
 */
export async function syncBatch(ctx, coll, { uploads = [] } = {}) {
  const st = ctx.pass.of(coll);
  const outcomes = new Map();
  const keepAll = () => {
    for (const e of uploads) outcomes.set(e.id, "keep");
  };
  let plan = null;
  if (uploads.length) {
    if (coll.syncKey === "0") {
      keepAll(); // commands cannot go with an initial SyncKey: next pass
      return { moreAvailable: true, reset: false, stale: false, outcomes };
    }
    plan = await planUploads(ctx, coll, uploads);
    for (const [id, o] of plan.outcomes) outcomes.set(id, o);
  }
  const initial = coll.syncKey === "0";
  const doc = await sendSync(ctx, coll, st, plan?.commands ?? []);
  st.batches++;

  if (doc === null) {
    // Empty answer: nothing new, and nothing acknowledged.
    if (plan) for (const e of uploads) if (!outcomes.has(e.id)) outcomes.set(e.id, "keep");
    return { moreAvailable: false, reset: false, stale: false, outcomes };
  }
  let parsed;
  try {
    parsed = parseSync(doc);
  } catch (e) {
    if (e instanceof ProtocolError) throw badResponse("Sync", e);
    throw e;
  }
  if (parsed.status && parsed.status !== "1") throw serverError("Sync", parsed.status);
  const c = parsed.collections.find((x) => x.collectionId === coll.serverId);
  if (!c) throw badResponse("Sync");
  if (c.status === "3") {
    // Invalid SyncKey: full resync, the table is emptied and rebuilt.
    ctx.log?.warn?.(`Sync ${coll.serverId} : clé de synchronisation refusée, resynchronisation complète du dossier.`);
    coll.reset();
    await saveCollection(ctx.records, coll);
    await dropPending(ctx, coll.serverId); // the full resync decides again what is there
    st.initial = 0;
    st.deferred = [];
    keepAll();
    return { moreAvailable: true, reset: true, stale: false, outcomes };
  }
  if (c.status === "8" || c.status === "12") {
    // The folder is gone or the hierarchy changed: FolderSync first (next pass).
    ctx.pass.hierarchyChanged = true;
    keepAll();
    return { moreAvailable: false, reset: false, stale: true, outcomes };
  }
  if (c.status !== "1") throw serverError(`Sync ${coll.serverId}`, c.status);
  if (!c.syncKey) throw badResponse("Sync");

  // Answers to our own commands.
  if (plan) {
    const errors = new Map();
    for (const r of c.responses) if (r.op === "change" && r.serverId && r.status !== "1") errors.set(r.serverId, r.status);
    for (const [sid, ch] of plan.changes) {
      const status = errors.get(sid);
      const o = status === undefined ? "done" : TRANSIENT_ITEM_STATUS.has(status) ? "keep" : "drop";
      for (const id of ch.ids) mergeOutcome(outcomes, id, o);
    }
    for (const [sid, del] of plan.deletes) {
      coll.unlink(sid);
      ctx.pass.index(ctx.mailStore, coll.path).invalidate(del.mid);
      for (const id of del.ids) mergeOutcome(outcomes, id, "done");
    }
  }

  await processCommands(ctx, coll, st, c.commands);
  coll.syncKey = c.syncKey;
  await saveCollection(ctx.records, coll);
  return { moreAvailable: initial || c.moreAvailable, reset: false, stale: false, outcomes };
}

/**
 * Sync one collection: batches until the server has nothing more, at most
 * MAX_BATCHES in this pass; then its server deletions are settled
 * (settleDeletes). → { stale }
 */
export async function syncCollection(ctx, coll) {
  const st = ctx.pass.of(coll);
  let stale = false;
  for (;;) {
    if (st.batches >= MAX_BATCHES) {
      ctx.pass.bounded = true;
      ctx.log?.debug?.(`Sync ${coll.serverId} : ${MAX_BATCHES} lots dans ce passage, la suite au prochain.`);
      break;
    }
    const r = await syncBatch(ctx, coll);
    if (r.stale) {
      stale = true;
      break;
    }
    if (!r.moreAvailable) break;
  }
  await settleDeletes(ctx, coll);
  return { stale };
}

// ── Server commands ──────────────────────────────────────────────────────

class Quarantine extends Error {
  constructor(reason) {
    super(reason);
    this.name = "Quarantine";
  }
}

async function processCommands(ctx, coll, st, commands) {
  if (!commands.length) return;
  const index = ctx.pass.index(ctx.mailStore, coll.path);
  if (commands.length > 10) await index.prefetch();
  const deferred = [];
  let attempts = 0;
  let failures = 0;
  let lastError = null;
  for (const cmd of commands) {
    checkAbort(ctx);
    const sid = cmd.serverId;
    try {
      switch (cmd.op) {
        case "add":
          attempts++;
          await applyAdd(ctx, coll, cmd, index);
          break;
        case "change":
          attempts++;
          await applyChange(ctx, coll, cmd, index);
          break;
        case "delete": {
          const mid = coll.unlink(sid); // the local action waits for the end of the pass (threshold)
          if (mid !== null) deferred.push([sid, mid]);
          break;
        }
        case "softdelete":
          coll.unlink(sid); // out of the period filter: still on the server, the local copy stays
          break;
        default:
          break;
      }
    } catch (e) {
      if (ctx.signal?.aborted || e?.code === ERR.CANCELLED) throw cancelled();
      if (e instanceof Quarantine) {
        attempts--;
        quarantine(ctx, coll, sid, e.message);
        continue;
      }
      failures++;
      lastError = e;
      quarantine(ctx, coll, sid, `échec local (${String(e?.code ?? e?.name ?? "erreur").slice(0, 40)})`);
    }
  }
  if (failures >= 2 && failures === attempts) {
    // Every local write failed: the cause is not the items. Nothing is saved, the batch comes again…
    const key = `${coll.serverId}\n${coll.syncKey}`;
    const n = (ctx.stuck?.get(key) ?? 0) + 1;
    if (n < STUCK_LIMIT) {
      ctx.stuck?.set(key, n);
      throw new EasError(SYNC_ERR.LOCAL, `Écriture impossible dans Thunderbird (${failures} échecs, ${String(lastError?.code ?? lastError?.name ?? "erreur").slice(0, 40)}).`);
    }
    // …but not for ever: the same batch failing again is let through, its items quarantined.
    ctx.stuck?.delete(key);
    ctx.log?.error?.(`Sync ${coll.serverId} : le même lot a échoué ${n} fois, ses éléments restent en quarantaine.`);
  }
  if (deferred.length) {
    st.deferred.push(...deferred);
    // Written before the SyncKey moves on: an interrupted pass loses none.
    const pending = await loadPendingDeletes(ctx.records);
    const entry = pending.get(coll.serverId) ?? { items: [], at: ctx.now(), retained: false };
    const known = new Set(entry.items.map((e) => e[0]));
    for (const e of deferred) if (!known.has(e[0])) entry.items.push(e);
    pending.set(coll.serverId, entry);
    await savePendingDeletes(ctx.records, pending);
  }
}

async function dropPending(ctx, cid) {
  const pending = await loadPendingDeletes(ctx.records);
  if (pending.delete(cid)) await savePendingDeletes(ctx.records, pending);
}

/**
 * End of a collection's pass: the server deletions it received are applied
 * locally, or, beyond the mass-deletion threshold, retained for the user.
 * Also settles what an interrupted pass left undecided. → number retained
 */
export async function settleDeletes(ctx, coll) {
  const st = ctx.pass.of(coll);
  const pending = await loadPendingDeletes(ctx.records);
  const entry = pending.get(coll.serverId);
  if (!entry || entry.retained) return 0;
  const count = entry.items.length;
  // A pass's own deletions are measured against the folder as it began; leftovers against the folder they came from.
  const size = st.deferred.length ? st.initial : coll.items.size + count;
  if (isMassDelete(count, size)) {
    entry.retained = true;
    await savePendingDeletes(ctx.records, pending);
    ctx.pass.retained += count;
    ctx.log?.warn?.(`Sync ${coll.serverId} : ${count} suppressions demandées par le serveur sur ${size} messages ; suppressions retenues jusqu'à confirmation.`);
    return count;
  }
  await applyLocalDeletes(ctx, coll, entry.items);
  await dropPending(ctx, coll.serverId);
  st.deferred = [];
  return 0;
}

function quarantine(ctx, coll, sid, reason) {
  coll.addQuarantine(sid, reason, ctx.now());
  ctx.pass.counts.skipped++;
  ctx.log?.warn?.(`Sync ${coll.serverId} : élément ${sid} mis en quarantaine (${reason}).`);
}

function readItem(data) {
  try {
    return readEmail(data);
  } catch {
    throw new Quarantine("élément illisible");
  }
}

/** Server flags (null = not given) → flags to set. */
function serverFlags(email) {
  const flags = {};
  if (typeof email.read === "boolean") flags.read = email.read;
  if (typeof email.flagged === "boolean") flags.flagged = email.flagged;
  return flags;
}

async function setFlagsOnCopies(ctx, coll, mid, copies, flags, index) {
  if (!Object.keys(flags).length) return false;
  let changed = false;
  for (const copy of copies) {
    if (Object.keys(flags).every((f) => copy[f] === flags[f])) continue;
    if (await ctx.mailStore.setFlags(copy.id, flags, { path: coll.path, messageId: mid })) changed = true;
    index.update(mid, copy.id, flags);
  }
  return changed;
}

async function attach(ctx, coll, sid, mid, copies, email, index) {
  coll.link(sid, mid);
  await setFlagsOnCopies(ctx, coll, mid, copies, serverFlags(email), index);
  ctx.pass.counts.added++;
}

async function applyAdd(ctx, coll, cmd, index) {
  const sid = cmd.serverId;
  if (coll.items.has(sid)) {
    await applyChange(ctx, coll, cmd, index); // already known (a replayed batch, a server echo of our move)
    return;
  }
  if (coll.items.size >= MAX_ITEMS) throw new Quarantine("dossier trop grand");
  const email = readItem(cmd.data);
  if (!(email.mime instanceof Uint8Array) || !email.mime.length) throw new Quarantine("sans contenu MIME");
  if (email.truncated) throw new Quarantine("contenu tronqué par le serveur");
  let prepared;
  try {
    prepared = ensureMessageId(stripInternalHeaders(email.mime));
  } catch {
    throw new Quarantine("message illisible");
  }
  let { bytes, messageId } = prepared;
  if (!validMid(messageId)) throw new Quarantine("Message-ID inutilisable");

  let copies = await index.get(messageId);
  if (copies.length > coll.refs(messageId)) {
    await attach(ctx, coll, sid, messageId, copies, email, index);
    return;
  }
  // Moved here on the server: the copy a deletion just sent to the local trash comes back.
  if (!copies.length && (await reuseTrashed(ctx, coll, sid, messageId, email, index))) return;

  if (copies.length) {
    // All local copies are taken: a distinct copy, under its own Message-ID.
    ({ bytes, messageId } = distinctCopy(bytes, coll.serverId, sid));
    copies = await index.get(messageId);
    if (copies.length > coll.refs(messageId)) {
      await attach(ctx, coll, sid, messageId, copies, email, index);
      return;
    }
    if (copies.length) throw new Quarantine("copie distincte impossible");
  }
  const flags = { read: email.read ?? false, flagged: email.flagged ?? false };
  let id;
  try {
    ({ id } = await ctx.mailStore.importMessage(coll.path, bytes, flags));
  } catch (e) {
    // The folder may have received the message in the meantime (a user action): attach it if so.
    index.invalidate(messageId);
    const again = await index.get(messageId);
    if (again.length > coll.refs(messageId)) {
      await attach(ctx, coll, sid, messageId, again, email, index);
      return;
    }
    throw e;
  }
  index.add(messageId, { id, ...flags });
  coll.link(sid, messageId);
  ctx.pass.counts.added++;
}

async function reuseTrashed(ctx, coll, sid, mid, email, index) {
  if (!ctx.pass.trashed.has(mid) || !ctx.trashPath || inLocalTrash(ctx, coll.path)) return false;
  const trashIndex = ctx.pass.index(ctx.mailStore, ctx.trashPath);
  const inTrash = await trashIndex.get(mid);
  // Only a copy no trash item is attached to may leave the trash.
  const trashColl = ctx.collectionOf?.(ctx.trashPath) ?? null;
  if (!inTrash.length || (trashColl && trashColl.refs(mid) >= inTrash.length)) return false;
  const r = await ctx.mailStore.moveMessages([inTrash[inTrash.length - 1].id], coll.path, { path: ctx.trashPath, messageId: mid });
  trashIndex.invalidate(mid);
  if (!r?.moved?.length) return false;
  if (inTrash.length <= 1) ctx.pass.trashed.delete(mid);
  index.invalidate(mid);
  const copies = await index.get(mid);
  await attach(ctx, coll, sid, mid, copies, email, index);
  return true;
}

async function applyChange(ctx, coll, cmd, index) {
  const mid = coll.midOf(cmd.serverId);
  if (mid === null) {
    ctx.pass.counts.skipped++; // unknown here (quarantined earlier, or never attached)
    return;
  }
  const email = readItem(cmd.data);
  const flags = serverFlags(email);
  if (!Object.keys(flags).length) return;
  const copies = await index.get(mid);
  if (await setFlagsOnCopies(ctx, coll, mid, copies, flags, index)) ctx.pass.counts.changed++;
}

/**
 * Local side of a server deletion (the ServerId is already unlinked): once
 * no ServerId points to the message, its local copies go to the local
 * trash (in the trash: deleted).
 */
async function deleteLocally(ctx, coll, sid, mid, index = ctx.pass.index(ctx.mailStore, coll.path)) {
  if (coll.refs(mid) > 0) return; // another ServerId points to it (or again)
  ctx.pass.counts.deleted++;
  const copies = await index.get(mid);
  const ids = copies.map((c) => c.id);
  if (!ids.length) return;
  const expected = { path: coll.path, messageId: mid };
  if (inLocalTrash(ctx, coll.path)) {
    const r = await ctx.mailStore.deleteMessages(ids, { permanent: true, expected });
    index.remove(mid, r?.deleted ?? ids);
    return;
  }
  if (!ctx.trashPath) {
    ctx.log?.warn?.(`Sync ${coll.serverId} : pas de corbeille locale, la copie locale de l'élément ${sid} est conservée.`);
    return;
  }
  const r = await ctx.mailStore.moveMessages(ids, ctx.trashPath, expected);
  const moved = r?.moved ?? ids;
  index.remove(mid, moved);
  ctx.pass.index(ctx.mailStore, ctx.trashPath).invalidate(mid);
  if (moved.length) ctx.pass.trashed.add(mid); // may come back elsewhere in this pass (a move on the server)
}

/** Server deletions decided (below the threshold, or confirmed by the user): applied locally. */
export async function applyLocalDeletes(ctx, coll, items) {
  for (const [sid, mid] of items) {
    checkAbort(ctx);
    try {
      await deleteLocally(ctx, coll, sid, mid);
    } catch (e) {
      if (ctx.signal?.aborted || e?.code === ERR.CANCELLED) throw cancelled();
      quarantine(ctx, coll, sid, `suppression locale impossible (${String(e?.code ?? e?.name ?? "erreur").slice(0, 40)})`);
    }
  }
  await saveCollection(ctx.records, coll);
}

// ── Local moves (journal) ────────────────────────────────────────────────

const MOVE_DONE = "3";
const MOVE_GONE = "1";
const MOVE_TRANSIENT = new Set(["5", "7"]);

/**
 * Journal moves → one MoveItems request. A move is reconciled by count,
 * like a deletion: the ServerIds beyond the local copies left in the source
 * folder move to the destination. A ServerId appears at most once in the
 * request (the server answers per source id).
 *
 * collectionOf(path) → CollectionState of a synchronised folder, or null.
 * destinationOf(path) → the same for a destination: any folder that exists
 *   on the server will do, even if its local folder is missing right now.
 * → { outcomes, unmapped: entries whose destination is not on the server (to be deleted instead) }
 */
export async function replayMoves(ctx, entries, collectionOf, destinationOf = collectionOf) {
  const outcomes = new Map();
  const unmapped = [];
  const moves = [];
  const used = new Set();
  for (const e of entries) {
    const src = collectionOf(e.path);
    if (!src) {
      outcomes.set(e.id, "done"); // the source is not on the server: nothing to do there
      continue;
    }
    const copies = await localCopies(ctx, e.path, e.messageId);
    const planned = moves.filter((m) => m.from === src && m.mid === e.messageId).length;
    const excess = src.refs(e.messageId) - planned - copies;
    if (excess <= 0) {
      outcomes.set(e.id, "done");
      continue;
    }
    const dst = destinationOf(e.toPath);
    if (dst === src) {
      outcomes.set(e.id, "done");
      continue;
    }
    if (!dst) {
      unmapped.push(e);
      continue;
    }
    const sids = src.serverIdsOf(e.messageId).filter((s) => !used.has(`${src.serverId}\n${s}`)).slice(-excess);
    if (!sids.length) {
      outcomes.set(e.id, "done");
      continue;
    }
    for (const sid of sids) {
      used.add(`${src.serverId}\n${sid}`);
      moves.push({ serverId: sid, from: src, to: dst, entryId: e.id, mid: e.messageId });
    }
  }
  if (!moves.length) return { outcomes, unmapped };

  // The server answers by source id only: a ServerId used in two source folders goes in separate requests.
  const batches = [];
  for (const m of moves) {
    let b = batches.find((x) => !x.ids.has(m.serverId));
    if (!b) {
      b = { ids: new Set(), list: [] };
      batches.push(b);
    }
    b.ids.add(m.serverId);
    b.list.push(m);
  }
  const touched = new Set();
  for (const b of batches) {
    checkAbort(ctx);
    const doc = await ctx.client.command(
      "MoveItems",
      moveItemsRequest(b.list.map((m) => ({ serverId: m.serverId, from: m.from.serverId, to: m.to.serverId }))),
      { signal: ctx.signal },
    );
    if (!doc) throw badResponse("MoveItems");
    let answers;
    try {
      answers = parseMoveItems(doc);
    } catch (e) {
      if (e instanceof ProtocolError) throw badResponse("MoveItems", e);
      throw e;
    }
    const byId = new Map();
    for (const a of answers) if (!byId.has(a.srcMsgId)) byId.set(a.srcMsgId, a);
    for (const m of b.list) {
      const a = byId.get(m.serverId);
      let o;
      if (!a) {
        o = "keep";
      } else if (a.status === MOVE_DONE) {
        m.from.unlink(m.serverId);
        m.to.link(a.dstMsgId ?? m.serverId, m.mid);
        touched.add(m.from).add(m.to);
        o = "done";
      } else if (a.status === MOVE_GONE) {
        m.from.unlink(m.serverId); // no longer in the source folder on the server
        touched.add(m.from);
        o = "drop";
      } else {
        o = MOVE_TRANSIENT.has(a.status) ? "keep" : "drop";
      }
      mergeOutcome(outcomes, m.entryId, o);
    }
  }
  for (const coll of touched) await saveCollection(ctx.records, coll);
  return { outcomes, unmapped };
}

// ── Distinct copy ────────────────────────────────────────────────────────

const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const MESSAGE_ID_NAME = ascii("message-id");
const lower = (b) => (b >= 0x41 && b <= 0x5a ? b + 0x20 : b);

/**
 * The same message under its own Message-ID, for a second copy in a folder
 * that already holds its Message-ID (Thunderbird refuses to import it as
 * it is). Every Message-ID field of the top-level header block is renamed
 * X-Sync443-Original-Message-ID (whatever the size of the block), and
 * "Message-ID: <hex@sync443.invalid>" is put first. hex: the first 16
 * bytes of SHA-256(message, 0, collection, 0, ServerId), so the same item
 * always gets the same id. → { bytes, messageId }
 */
export function distinctCopy(bytes, collectionId, serverId) {
  const salt = encodeUtf8(`\u0000${collectionId}\u0000${serverId}`);
  const all = new Uint8Array(bytes.length + salt.length);
  all.set(bytes);
  all.set(salt, bytes.length);
  const messageId = `${toHex(sha256(all).subarray(0, 16))}@${SYNTHETIC_DOMAIN}`;

  // Lines end at LF, CRLF or a lone CR (as core/mime.mjs reads them).
  const renamed = [];
  let crlf = true;
  let first = true;
  let pos = 0;
  while (pos < bytes.length) {
    let ce = pos;
    while (ce < bytes.length && bytes[ce] !== 0x0a && bytes[ce] !== 0x0d) ce++;
    if (first) {
      crlf = !(ce < bytes.length && bytes[ce] === 0x0a);
      first = false;
    }
    if (ce === pos) break; // empty line: end of the header block
    if (bytes[pos] !== 0x20 && bytes[pos] !== 0x09) {
      let colon = pos;
      while (colon < ce && bytes[colon] !== 0x3a) colon++;
      if (colon < ce) {
        let end = colon;
        while (end > pos && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09)) end--;
        if (end - pos === MESSAGE_ID_NAME.length && MESSAGE_ID_NAME.every((b, i) => lower(bytes[pos + i]) === b)) renamed.push([pos, end]);
      }
    }
    pos = ce < bytes.length && bytes[ce] === 0x0d && bytes[ce + 1] === 0x0a ? ce + 2 : ce + 1;
  }
  const head = encodeUtf8(`Message-ID: <${messageId}>${crlf ? "\r\n" : "\n"}`);
  const name = encodeUtf8(ORIGINAL_ID_FIELD);
  const out = new Uint8Array(head.length + bytes.length + renamed.length * (name.length - MESSAGE_ID_NAME.length));
  out.set(head);
  let n = head.length;
  let copied = 0;
  for (const [from, to] of renamed) {
    out.set(bytes.subarray(copied, from), n);
    n += from - copied;
    out.set(name, n);
    n += name.length;
    copied = to;
  }
  out.set(bytes.subarray(copied), n);
  return { bytes: out, messageId };
}
