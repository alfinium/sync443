// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Mail synchronisation of one collection (server folder ↔ local folder).
 *
 * Identity. Thunderbird renumbers its messages at every start, so no
 * Thunderbird id is ever kept: on the server a message is a ServerId in a
 * collection, in Thunderbird a Message-ID in a folder. Each collection has
 * a table ServerId → Message-ID (record `coll:<ServerId>`), with its
 * reverse index Message-ID → {ServerId} built in memory, and for each
 * ServerId a fingerprint of the message as imported (16 hex digits of its
 * SHA-256).
 *
 * No alias. Several local copies may share a Message-ID, and several
 * ServerIds may point to the same Message-ID; the table always keeps at
 * most as many ServerIds per Message-ID as there are local copies:
 *  - a server Add whose Message-ID is already in the folder is attached to
 *    a local copy that no ServerId holds, but only when the evidence says
 *    it is that message: during a full resynchronisation, the fingerprint
 *    the table had for this Message-ID before it was emptied; otherwise
 *    the copy's Date and sender address (from Thunderbird). The item's own
 *    distinct copy (below), made by an earlier pass, is looked for too;
 *  - otherwise a distinct copy is imported: Thunderbird refuses a second
 *    message with a Message-ID the folder already holds, so it gets its
 *    own: <hex@sync443.invalid>, hex from SHA-256 of the message, the
 *    collection and the ServerId (the same item always gets the same id),
 *    the original field kept as X-Sync443-Original-Message-ID;
 *  - after an import, the Message-ID Thunderbird itself read is the one
 *    linked (a message it reads differently is imported again under an id
 *    of ours);
 *  - a local message is deleted only when no ServerId points to it any
 *    more; local deletions and moves are reconciled by count (ServerIds
 *    beyond the number of local copies left are the ones to delete or move).
 *
 * Out of the period. A SoftDelete (an item leaving the period filter) moves
 * its link to a second table, `aged`: the local copy stays, still on the
 * server, and what the user then does to it is still sent (a deletion by
 * MoveItems to the server's trash, flags by Change, moves by MoveItems).
 *
 * Server deletions: the ServerId is unlinked at once (the table follows the
 * server), and the local action waits until the collection has nothing
 * more to send (no MoreAvailable, however many passes that takes), kept
 * meanwhile in `pendingDeletes` (written before the SyncKey moves on) with
 * the size of the folder before they began. Then, below the mass-deletion
 * threshold, the local copy goes to the local trash (in the trash, it is
 * deleted), unless a ServerId points to it again (an item the server
 * re-created). The threshold: more than 50 deletions AND more than 20 % of
 * the folder, counted over the whole run of deletions and over a rolling
 * window of 24 hours (a server deleting a little at every pass is caught
 * too). Beyond it, the deletions stay in `pendingDeletes`, marked retained,
 * for the user to confirm.
 *
 * Full resynchronisation (Status 3, a local folder recreated or changed):
 * the table is emptied and rebuilt from the server's Adds. Meanwhile the
 * journal's waiting changes for the collection are respected: a message
 * the user deleted or moved out is linked without being imported again
 * (the replay then sends the deletion), and flags not sent yet are not
 * overwritten by the server's.
 *
 * A batch is processed as a whole before its SyncKey is saved. An item that
 * cannot be read is quarantined (logged, counted, skipped); an item whose
 * import fails is kept in `failed` and fetched again (Sync Fetch) at the
 * end of the collection's pass, up to MAX_FETCH_ATTEMPTS times; if every
 * local write of a batch fails, the cause is not the items: nothing is
 * saved and the error goes up (STUCK_LIMIT passes in a row at most).
 * Replaying a batch (same SyncKey after a crash or a cancellation) is
 * harmless: an Add finds its message already imported and attaches it, a
 * Delete finds nothing left.
 *
 * Storage of a table: the record `coll:<ServerId>` holds a full snapshot;
 * the changes made after it go to small segment records
 * `cseg:<ServerId>:<n>` (at most SEGMENT_MAX changes each, with the
 * current SyncKey and the other small fields), and a new snapshot is
 * written once they outgrow the table. A batch of 50 items rewrites one
 * segment, never the whole table.
 */

import { syncRequest, parseSync, changeCommand, deleteCommand, fetchCommand, moveItemsRequest, parseMoveItems, ProtocolError } from "../core/protocol.mjs";
import { readEmail, changeEmail, mailOptions } from "../core/mail-codec.mjs";
import { stripInternalHeaders, ensureMessageId, replaceMessageId, dateOf, fromAddressOf, addressOf, SYNTHETIC_DOMAIN, MAX_MESSAGE_ID } from "../core/mime.mjs";
import { sha256, toHex } from "../core/sha256.mjs";
import { encodeUtf8 } from "../core/utf8.mjs";
import * as v from "../core/sanitize.mjs";
import { EasError, ERR } from "../transport/client.mjs";
import { recordName } from "./store.mjs";
import { validPath } from "./paths.mjs";
import { errorCode } from "../log.mjs";


export const WINDOW_SIZE = 50;
/** Most Sync batches for one collection in one pass (MoreAvailable is bounded). */
export const MAX_BATCHES = 20;
/** Mass deletion: more than this many deletions… */
const MASS_DELETE_COUNT = 50;
/** …and more than this share of the folder, in one run of deletions or within MASS_DELETE_WINDOW_MS. */
const MASS_DELETE_RATIO = 0.2;
const MASS_DELETE_WINDOW_MS = 24 * 3600_000;
const QUARANTINE_MAX = 500;
/** Passes in a row a batch may fail as a whole before its items are only kept for a later fetch (see processCommands). */
const STUCK_LIMIT = 3;
/** Fetches of an item whose import failed, before it is quarantined. */
export const MAX_FETCH_ATTEMPTS = 5;
/** Items whose import failed, kept per collection for a later fetch. */
const FAILED_MAX = 1000;
/** Most items one collection table holds, in and out of the period (a hostile server cannot fill the storage). */
const MAX_ITEMS = 250_000;
/** Changes per segment record of a table. */
const SEGMENT_MAX = 1000;
/** Response size cap of a Sync request; raised when the window has shrunk to one message. */
const SYNC_MAX_BYTES = 24 * 1024 * 1024;
const SYNC_MAX_BYTES_SINGLE = 64 * 1024 * 1024;
const SYNC_TIMEOUT_MS = 180_000;

export const SYNC_ERR = Object.freeze({ SERVER: "SERVER", LOCAL: "LOCAL", MASS_DELETE: "MASS_DELETE" });

const PENDING = "pendingDeletes";
const TRANSIENT_ITEM_STATUS = new Set(["5", "16"]);
const NO_OPS = Object.freeze({ removed: new Map(), flags: new Map() });

export const collRecord = (serverId) => recordName("coll", serverId);
const segPrefix = (serverId) => `cseg:${encodeURIComponent(serverId)}:`;
const segName = (serverId, n) => `${segPrefix(serverId)}${n}`;

const validMid = (m) => typeof m === "string" && m.length >= 1 && m.length <= MAX_MESSAGE_ID && !/[\s\u0000-\u001f\u007f]/.test(m);
const validHash = (h) => typeof h === "string" && /^[0-9a-f]{16}$/.test(h);
const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);

/** Fingerprint of a message as imported: 16 hex digits of its SHA-256. */
const fingerprint = (digest) => toHex(digest.subarray(0, 8));

function cancelled() {
  return new EasError(ERR.CANCELLED, "Synchronisation annulée.");
}

export function serverError(what, status) {
  return new EasError(SYNC_ERR.SERVER, `${what} : refus du serveur (Status ${status ?? "absent"}).`);
}

export function badResponse(what, e) {
  return new EasError(ERR.BAD_RESPONSE, `${what} : réponse invalide du serveur${e?.message ? ` (${e.message})` : ""}.`);
}

/** Outcomes of journal entries: keep wins over wait, wait over drop, drop over done. */
export function mergeOutcome(map, id, outcome) {
  const rank = { done: 0, drop: 1, wait: 2, keep: 3 };
  const old = map.get(id);
  if (old === undefined || rank[outcome] > rank[old]) map.set(id, outcome);
}

// ── Collection table ─────────────────────────────────────────────────────

/** Map<key, Set<value>> helpers. */
function addTo(index, key, value) {
  const set = index.get(key);
  if (set) set.add(value);
  else index.set(key, new Set([value]));
}
function removeFrom(index, key, value) {
  const set = index.get(key);
  set?.delete(value);
  if (set && !set.size) index.delete(key);
}

export class CollectionState {
  #ops = []; // changes since the last save, for the next segment
  #tracking = false;

  /**
   * @param {string} serverId  CollectionId
   * @param {object} [state]   { syncKey, path, items: [[ServerId, MessageId, hash]], aged, quarantine, failed, prior, full, more, window, held }
   */
  constructor(serverId, { syncKey = "0", path = null, items = [], aged = [], quarantine = [], failed = [], prior = null, full = null, more = false, window = null, held = [] } = {}) {
    this.serverId = serverId;
    this.syncKey = syncKey;
    this.path = path;
    this.items = new Map();
    this.reverse = new Map();
    this.aged = new Map(); // out of the period filter: ServerId → Message-ID
    this.agedReverse = new Map();
    this.hashes = new Map(); // ServerId → fingerprint (items and aged)
    this.quarantine = quarantine.slice(-QUARANTINE_MAX);
    /** Linked without a local copy (a message the user removed, during a rebuild): the first to delete or move. */
    this.held = new Set();
    this.failed = new Map(failed.map(([sid, attempts, at]) => [sid, { attempts, at }]));
    /** Before a full resync: Message-ID → Set of fingerprints the table had for it ("?" when unknown). */
    this.prior = prior;
    /** The table is being built from SyncKey "0" (first sync or full resync), until a batch without MoreAvailable. */
    this.full = full ?? syncKey === "0";
    /** The last batch said MoreAvailable: the server has more to send. */
    this.more = more;
    /** Server deletions applied within the rolling window: { since, count, base }. */
    this.window = window;
    // Storage (see saveCollection).
    this.gen = 0;
    this.seg = 1;
    this.segOps = [];
    this.opsTotal = 0;
    this.segNames = new Set();
    this.snapshotNeeded = true; // no snapshot stored yet
    for (const [sid, mid, h] of items) this.link(sid, mid, h);
    for (const [sid, mid, h] of aged) this.#ageLink(sid, mid, h);
    for (const sid of held) if (this.items.has(sid)) this.held.add(sid);
    this.#tracking = true;
  }

  /** From a stored record; anything damaged is dropped (a damaged key restarts the collection from scratch). */
  static fromRecord(serverId, raw) {
    if (!raw || typeof raw !== "object") return new CollectionState(serverId);
    const syncKey = v.syncKey(raw.syncKey) ?? "0";
    const path = validPath(raw.path) ? raw.path : null;
    const pairs = (list, always = false) => {
      const out = [];
      if ((syncKey === "0" && !always) || !Array.isArray(list)) return out;
      for (const e of list) {
        if (Array.isArray(e) && e.length === 3 && v.itemId(e[0]) && validMid(e[1]) && validHash(e[2])) out.push([e[0], e[1], e[2]]);
      }
      return out;
    };
    const coll = new CollectionState(serverId, {
      syncKey,
      path,
      items: pairs(raw.items),
      aged: pairs(raw.aged, true), // out-of-period links outlive a full resync
      ...smallState(raw, syncKey),
      prior: readPrior(raw.prior),
    });
    coll.gen = count(raw.gen);
    coll.snapshotNeeded = false;
    return coll;
  }

  /** Full snapshot. */
  toRecord() {
    const row = (sid, mid) => [sid, mid, this.hashes.get(sid)];
    return {
      gen: this.gen,
      ...this.stateRecord(),
      items: [...this.items].map(([sid, mid]) => row(sid, mid)),
      aged: [...this.aged].map(([sid, mid]) => row(sid, mid)),
      prior: this.prior ? [...this.prior].map(([mid, hashes]) => [mid, [...hashes]]) : null,
    };
  }

  /** The small fields, written with every segment. */
  stateRecord() {
    return {
      syncKey: this.syncKey,
      path: this.path,
      quarantine: this.quarantine.map((q) => ({ ...q })),
      failed: [...this.failed].map(([sid, f]) => [sid, f.attempts, f.at]),
      full: this.full,
      more: this.more,
      window: this.window ? { ...this.window } : null,
      held: [...this.held],
    };
  }

  /** Changes made since the last call (for the next segment). */
  takeOps() {
    const ops = this.#ops;
    this.#ops = [];
    return ops;
  }

  /** Replay the changes of a segment (stored ones: checked one by one). */
  applyOps(ops) {
    const tracking = this.#tracking;
    this.#tracking = false;
    try {
      for (const op of Array.isArray(ops) ? ops : []) {
        if (!Array.isArray(op) || !v.itemId(op[1])) continue;
        if (op[0] === "+" && validMid(op[2]) && validHash(op[3])) this.link(op[1], op[2], op[3]);
        else if (op[0] === "-") this.unlink(op[1]);
        else if (op[0] === "a") this.age(op[1]);
        else if (op[0] === "x") this.unage(op[1]);
      }
    } finally {
      this.#tracking = tracking;
    }
  }

  #track(op) {
    if (this.#tracking) this.#ops.push(op);
  }

  /** Link a ServerId to a Message-ID, with the fingerprint of the message (every link has one). */
  link(sid, mid, hash) {
    if (!validHash(hash)) throw new TypeError("lien sans empreinte");
    this.unlink(sid);
    this.unage(sid);
    this.held.delete(sid);
    this.items.set(sid, mid);
    addTo(this.reverse, mid, sid);
    this.hashes.set(sid, hash);
    this.#track(["+", sid, mid, hash]);
  }

  /** → the Message-ID the ServerId pointed to (in the period), or null. */
  unlink(sid) {
    const mid = this.items.get(sid);
    if (mid === undefined) return null;
    this.items.delete(sid);
    removeFrom(this.reverse, mid, sid);
    this.held.delete(sid);
    if (!this.aged.has(sid)) this.hashes.delete(sid);
    this.#track(["-", sid]);
    return mid;
  }

  #ageLink(sid, mid, hash) {
    this.aged.set(sid, mid);
    addTo(this.agedReverse, mid, sid);
    this.hashes.set(sid, hash);
  }

  /** The item left the period filter: its link moves to `aged`. → its Message-ID, or null. */
  age(sid) {
    const mid = this.items.get(sid);
    if (mid === undefined) return null;
    const hash = this.hashes.get(sid) ?? null;
    this.items.delete(sid);
    removeFrom(this.reverse, mid, sid);
    this.#ageLink(sid, mid, hash);
    this.#track(["a", sid]);
    return mid;
  }

  /** Forget an out-of-period link. → its Message-ID, or null. */
  unage(sid) {
    const mid = this.aged.get(sid);
    if (mid === undefined) return null;
    this.aged.delete(sid);
    removeFrom(this.agedReverse, mid, sid);
    if (!this.items.has(sid)) this.hashes.delete(sid);
    this.#track(["x", sid]);
    return mid;
  }

  midOf(sid) {
    return this.items.get(sid) ?? null;
  }

  hashOf(sid) {
    return this.hashes.get(sid) ?? null;
  }

  /** ServerIds in the period pointing to a Message-ID. */
  refs(mid) {
    return this.reverse.get(mid)?.size ?? 0;
  }

  /** Every ServerId pointing to a local copy of a Message-ID, in the period or not. */
  allRefs(mid) {
    return this.refs(mid) + (this.agedReverse.get(mid)?.size ?? 0);
  }

  /** ServerIds of a Message-ID, oldest link first. */
  serverIdsOf(mid) {
    return [...(this.reverse.get(mid) ?? [])];
  }

  /**
   * ServerIds of a Message-ID in the order a local deletion or move takes
   * them: those linked without a local copy first (the very messages the
   * user removed), then the others, newest link first, then out of period.
   */
  removalOrder(mid) {
    const sids = this.serverIdsOf(mid).reverse();
    return [...sids.filter((s) => this.held.has(s)), ...sids.filter((s) => !this.held.has(s)), ...this.agedIdsOf(mid)];
  }

  /** Out-of-period ServerIds of a Message-ID. */
  agedIdsOf(mid) {
    return [...(this.agedReverse.get(mid) ?? [])];
  }

  get size() {
    return this.items.size + this.aged.size;
  }

  /**
   * Full resync: SyncKey "0", the table emptied (it is rebuilt from the
   * server's Adds). What it held is kept as `prior`, the evidence a rebuilt
   * item needs to be attached to an existing local copy (see applyAdd).
   * Kept as they are: the rolling window of server deletions (a reset must
   * not start it again), and with `keepAged` the out-of-period links (the
   * server does not send those items again; on Status 3 their ServerIds
   * still hold, in the same local folder).
   */
  reset({ prior = null, keepAged = false } = {}) {
    const evidence = this.prior ?? new Map();
    const add = (mid, h) => addTo(evidence, mid, h);
    for (const [sid, mid] of this.items) add(mid, this.hashes.get(sid));
    for (const [sid, mid] of this.aged) add(mid, this.hashes.get(sid));
    for (const [mid, hashes] of prior ?? []) for (const h of hashes) add(mid, h);
    this.prior = evidence.size ? evidence : null;
    this.syncKey = "0";
    this.items.clear();
    this.reverse.clear();
    this.held.clear();
    if (keepAged) {
      for (const sid of [...this.hashes.keys()]) if (!this.aged.has(sid)) this.hashes.delete(sid);
    } else {
      this.aged.clear();
      this.agedReverse.clear();
      this.hashes.clear();
    }
    this.failed.clear();
    this.full = true;
    this.more = false;
    this.#ops = [];
    this.snapshotNeeded = true;
  }

  /** The rebuild is over: the evidence is no longer needed. */
  endFull() {
    this.full = false;
    if (this.prior) {
      this.prior = null;
      this.snapshotNeeded = true;
    }
  }

  addQuarantine(serverId, reason, at) {
    this.quarantine.push({ serverId, reason, at });
    if (this.quarantine.length > QUARANTINE_MAX) this.quarantine.splice(0, this.quarantine.length - QUARANTINE_MAX);
  }
}

/** What a table holds, as evidence for a rebuild elsewhere (Message-ID → fingerprints; see CollectionState.reset). */
export function evidenceOf(coll) {
  const out = new Map();
  for (const [mid, hashes] of coll.prior ?? []) for (const h of hashes) addTo(out, mid, h);
  for (const [sid, mid] of [...coll.items, ...coll.aged]) addTo(out, mid, coll.hashOf(sid));
  return out;
}

/** The small fields of a stored state (a snapshot, or a segment's `state`), checked. */
function smallState(raw, syncKey) {
  const quarantine = Array.isArray(raw?.quarantine)
    ? raw.quarantine.filter((q) => q && v.itemId(q.serverId) && typeof q.reason === "string").map((q) => ({ serverId: q.serverId, reason: q.reason.slice(0, 200), at: Number(q.at) || 0 }))
    : [];
  const failed = Array.isArray(raw?.failed) && syncKey !== "0"
    ? raw.failed.filter((f) => Array.isArray(f) && v.itemId(f[0])).slice(-FAILED_MAX).map((f) => [f[0], count(f[1]), Number(f[2]) || 0])
    : [];
  const w = raw?.window;
  const window = w && Number.isFinite(w.since) && Number.isSafeInteger(w.count) && Number.isSafeInteger(w.base) ? { since: w.since, count: w.count, base: w.base } : null;
  const held = Array.isArray(raw?.held) ? raw.held.filter((sid) => v.itemId(sid)).slice(0, MAX_ITEMS) : [];
  return { quarantine, failed, full: typeof raw?.full === "boolean" ? raw.full || syncKey === "0" : syncKey === "0", more: raw?.more === true, window, held };
}

function readPrior(raw) {
  if (!Array.isArray(raw)) return null;
  const out = new Map();
  for (const e of raw) {
    if (!Array.isArray(e) || !validMid(e[0]) || !Array.isArray(e[1])) continue;
    for (const h of e[1]) if (validHash(h)) addTo(out, e[0], h);
  }
  return out.size ? out : null;
}

/**
 * A collection as stored: its snapshot, then its segments of the same
 * generation in order (the last one's small fields win). `names`: the
 * mailbox's record names, when the caller has them already.
 */
export async function loadCollection(records, serverId, names = null) {
  const raw = await records.get(collRecord(serverId), null);
  const coll = CollectionState.fromRecord(serverId, raw);
  const list = names ?? (await records.names());
  const prefix = segPrefix(serverId);
  const segs = list
    .filter((n) => n.startsWith(prefix))
    .map((n) => [n, Number(n.slice(prefix.length))])
    .filter(([, k]) => Number.isSafeInteger(k) && k >= 1)
    .sort((a, b) => a[1] - b[1]);
  let state = null;
  for (const [name, k] of segs) {
    coll.segNames.add(name);
    const seg = await records.get(name, null);
    if (!raw || !seg || count(seg.gen) !== coll.gen || !Array.isArray(seg.ops)) continue;
    coll.applyOps(seg.ops);
    coll.opsTotal += seg.ops.length;
    coll.seg = k;
    coll.segOps = seg.ops.slice();
    state = seg.state;
  }
  if (state) {
    const syncKey = v.syncKey(state.syncKey) ?? "0";
    coll.syncKey = syncKey;
    coll.path = validPath(state.path) ? state.path : null;
    const small = smallState(state, syncKey);
    coll.quarantine = small.quarantine;
    coll.failed = new Map(small.failed.map(([sid, attempts, at]) => [sid, { attempts, at }]));
    coll.full = small.full;
    coll.more = small.more;
    coll.window = small.window;
    coll.held = new Set(small.held.filter((sid) => coll.items.has(sid)));
    if (syncKey === "0") coll.reset({ keepAged: true });
  }
  coll.takeOps();
  return coll;
}

/** Write a collection: one segment with its latest changes, or a new snapshot once they outgrow the table. */
export async function saveCollection(records, coll) {
  const ops = coll.takeOps();
  try {
    if (coll.snapshotNeeded || coll.opsTotal + ops.length > Math.max(SEGMENT_MAX, coll.size)) {
      await writeSnapshot(records, coll);
      return;
    }
    if (coll.segOps.length >= SEGMENT_MAX) {
      coll.seg++;
      coll.segOps = [];
    }
    coll.segOps.push(...ops);
    coll.opsTotal += ops.length;
    const name = segName(coll.serverId, coll.seg);
    await records.set(name, { gen: coll.gen, ops: coll.segOps, state: coll.stateRecord() });
    coll.segNames.add(name);
  } catch (e) {
    coll.snapshotNeeded = true; // what was taken is still in memory: the next save writes it all
    throw e;
  }
}

async function writeSnapshot(records, coll) {
  coll.gen++;
  coll.snapshotNeeded = true;
  await records.set(collRecord(coll.serverId), coll.toRecord());
  const old = [...coll.segNames];
  coll.segNames.clear();
  coll.seg = 1;
  coll.segOps = [];
  coll.opsTotal = 0;
  coll.snapshotNeeded = false;
  await removeRecords(records, old);
}

async function removeRecords(records, names) {
  if (!names.length) return;
  await records.removeMany(names);
}

/** Remove a collection's table (snapshot and segments). */
export async function removeCollection(records, serverId, names = null) {
  const list = names ?? (await records.names());
  const prefix = segPrefix(serverId);
  await removeRecords(records, [collRecord(serverId), ...list.filter((n) => n.startsWith(prefix))]);
}

/** Collection ServerIds that have a stored table, from the mailbox's record names. */
export function storedCollections(names) {
  const out = [];
  for (const name of names) {
    if (!name.startsWith("coll:")) continue;
    let sid;
    try {
      sid = decodeURIComponent(name.slice(5));
    } catch {
      continue;
    }
    if (v.itemId(sid)) out.push(sid);
  }
  return out;
}

// ── Pending deletions (mass-deletion threshold) ──────────────────────────

/**
 * Record `pendingDeletes`: Map<CollectionId, { items: [[ServerId, MessageId, hash?]], at, retained, base, folder? }>.
 * retained: true when held by the mass-deletion threshold (waiting for the
 * user); false while the collection's run of deletions is not over (a pass
 * interrupted there leaves them for the next one to decide).
 * base: the size of the folder before the deletions began.
 * folder: { path } for the removal of a whole folder (sync/mailbox.mjs),
 * retained for the user like a mass deletion; `messages` is then the
 * number of messages its table held (and `items` is empty).
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
      if (!Array.isArray(e) || e.length !== 3 || !v.itemId(e[0]) || !validMid(e[1]) || !validHash(e[2]) || seen.has(e[0])) continue;
      seen.add(e[0]);
      items.push([e[0], e[1], e[2]]);
    }
    const folder = value.folder && validPath(value.folder.path) ? { path: value.folder.path } : null;
    if (folder && value.retained === true) {
      out.set(cid, { items: [], at: Number(value.at) || 0, retained: true, base: count(value.base), folder, messages: count(value.messages) });
    } else if (items.length && !folder) {
      out.set(cid, { items, at: Number(value.at) || 0, retained: value.retained === true, base: count(value.base) });
    }
  }
  return out;
}

export async function savePendingDeletes(records, map) {
  if (map.size) await records.setMap(PENDING, map);
  else await records.remove(PENDING);
}

/** Number of deletions waiting (retained only, by default); a folder removal counts its messages, at least one. */
export function countPending(map, { retainedOnly = true } = {}) {
  let n = 0;
  for (const value of map.values()) if (value.retained || !retainedOnly) n += value.folder ? Math.max(1, value.messages ?? 0) : value.items.length;
  return n;
}

/** Beyond the mass-deletion threshold? */
export function isMassDelete(deletions, folderSize) {
  return deletions > MASS_DELETE_COUNT && deletions > MASS_DELETE_RATIO * folderSize;
}

/** Forget the deletions waiting for some collections (their tables were reset or remapped: they would act on other copies). */
export async function dropPendingFor(records, ids) {
  const pending = await loadPendingDeletes(records);
  let changed = false;
  for (const id of ids) changed = pending.delete(id) || changed;
  if (changed) await savePendingDeletes(records, pending);
  return changed;
}

// ── Local folder index (per pass, in memory only) ────────────────────────

const copyOf = (m) => ({
  id: m.id,
  read: Boolean(m.flags?.read),
  flagged: Boolean(m.flags?.flagged),
  date: typeof m.date === "number" && Number.isFinite(m.date) ? m.date : null,
  from: typeof m.author === "string" ? addressOf(m.author) : null,
});

/**
 * Local copies by Message-ID in one folder, for one pass: either the whole
 * folder listed once (big batches), or looked up one Message-ID at a time.
 * Kept up to date with the engine's own writes. Ids are only valid during
 * this session; every write checks them again (mail-store `expected`).
 */
class FolderIndex {
  constructor(mailStore, path) {
    this.mailStore = mailStore;
    this.path = path;
    this.full = null; // Map<mid, copies> once the folder has been listed
    this.cache = new Map();
  }

  async prefetch() {
    if (this.full) return;
    const map = new Map();
    for (const m of await this.mailStore.listMessages(this.path)) {
      if (!validMid(m.messageId)) continue;
      const list = map.get(m.messageId);
      if (list) list.push(copyOf(m));
      else map.set(m.messageId, [copyOf(m)]);
    }
    this.full = map;
  }

  async get(mid) {
    if (this.full) return [...(this.full.get(mid) ?? [])];
    let list = this.cache.get(mid);
    if (!list) {
      list = (await this.mailStore.findByMessageId(this.path, mid)).map(copyOf);
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

/** State shared by the collections of one pass: counters, indexes. */
export class MailPass {
  constructor() {
    this.counts = { added: 0, changed: 0, deleted: 0, skipped: 0 };
    this.per = new Map();
    this.indexes = new Map();
    this.trashed = new Map(); // Message-ID → fingerprints of what server deletions sent to the local trash in this pass
    this.retained = 0; // deletions held by the mass-deletion threshold in this pass
    this.bounded = false; // a collection still had more to give when its batch budget ran out
    this.hierarchyChanged = false;
    this.waiting = false; // journal entries kept because their collection was being rebuilt: another pass soon
  }

  of(coll) {
    let st = this.per.get(coll.serverId);
    if (!st) {
      st = { batches: 0, window: WINDOW_SIZE, ops: null };
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
 *   serverTrashId   ServerId of the server's trash, or null (optional)
 *   collectionOf(path) → CollectionState | null   synchronised collection of a local folder
 *   journalOps(coll) → { removed, flags }   waiting local changes of the collection (Journal.messageOps; optional)
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

/** Waiting journal changes of a collection, read once per pass. */
async function journalOps(ctx, coll, st = ctx.pass.of(coll)) {
  if (!st.ops) st.ops = typeof ctx.journalOps === "function" ? await ctx.journalOps(coll) : NO_OPS;
  return st.ops;
}

/**
 * Local flags and deletions of one folder → Sync commands (and MoveItems
 * for out-of-period items deleted outside the server's trash).
 * Deletions are reconciled by count: as many ServerIds as there are
 * ServerIds beyond the local copies left, those in the period first.
 * → { commands, changes: Map<sid, …>, deletes: Map<sid, …>, agedMoves: Map<sid, …>, outcomes }
 */
async function planUploads(ctx, coll, entries) {
  const outcomes = new Map();
  const changes = new Map(); // sid → { flags, ids: Set }
  const deletes = new Map(); // sid → { mid, ids: Set, aged }
  const plannedDeletes = new Map(); // mid → count
  const trashId = ctx.serverTrash(coll.serverId) ? null : ctx.serverTrashId ?? null;
  // While the table is rebuilt (over several passes, maybe), a message not relinked yet is not "nothing to send":
  // the entry waits for the end of the rebuild instead of being settled with nothing sent.
  const wait = (e) => {
    outcomes.set(e.id, "wait");
    ctx.pass.waiting = true;
  };
  for (const e of entries) {
    if (e.op === "flags") {
      const sids = [...coll.serverIdsOf(e.messageId), ...coll.agedIdsOf(e.messageId)];
      if (coll.full && sids.length < (await localCopies(ctx, coll.path, e.messageId))) {
        wait(e);
        continue;
      }
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
    const excess = coll.allRefs(e.messageId) - planned - copies;
    if (excess <= 0) {
      if (coll.full) wait(e);
      else outcomes.set(e.id, "done");
      continue;
    }
    const candidates = coll.removalOrder(e.messageId).filter((sid) => !deletes.has(sid));
    const chosen = candidates.slice(0, excess);
    for (const sid of chosen) {
      const ids = new Set([e.id]);
      const c = changes.get(sid);
      if (c) {
        for (const id of c.ids) ids.add(id);
        changes.delete(sid);
      }
      deletes.set(sid, { mid: e.messageId, ids, aged: coll.aged.has(sid) && trashId !== null });
    }
    plannedDeletes.set(e.messageId, planned + chosen.length);
  }
  const commands = [
    ...[...changes].map(([sid, c]) => changeCommand(sid, changeEmail(c.flags))),
    ...[...deletes].filter(([, d]) => !d.aged).map(([sid]) => deleteCommand(sid)),
  ];
  const agedMoves = new Map([...deletes].filter(([, d]) => d.aged));
  for (const sid of agedMoves.keys()) deletes.delete(sid);
  return { commands, changes, deletes, agedMoves, trashId, outcomes };
}

/** Out-of-period items deleted by the user: moved to the server's trash (they cannot be deleted by Sync once out of the filter). */
async function sendAgedMoves(ctx, coll, plan, outcomes) {
  if (!plan.agedMoves.size) return;
  const list = [...plan.agedMoves];
  const doc = await ctx.client.command("MoveItems", moveItemsRequest(list.map(([sid]) => ({ serverId: sid, from: coll.serverId, to: plan.trashId }))), { signal: ctx.signal });
  const answers = readMoveItems(doc);
  for (const [sid, d] of list) {
    const a = answers.get(sid);
    let o;
    if (!a) o = "keep";
    else if (a.status === MOVE_DONE || a.status === MOVE_GONE) {
      coll.unage(sid);
      o = "done";
    } else o = MOVE_TRANSIENT.has(a.status) ? "keep" : "drop";
    for (const id of d.ids) mergeOutcome(outcomes, id, o);
  }
}

/**
 * One Sync request for one collection, local uploads (and fetches of items
 * whose import failed) included, and the whole answer processed.
 * → { moreAvailable, reset, stale, outcomes: Map<entryId, outcome> }
 */
export async function syncBatch(ctx, coll, { uploads = [], fetch = [] } = {}) {
  const st = ctx.pass.of(coll);
  const outcomes = new Map();
  // Not sent: "wait" while the collection is (being) rebuilt (no attempt counted), "keep" otherwise.
  const keepAll = (o = "keep") => {
    for (const e of uploads) outcomes.set(e.id, o);
    if (uploads.length) ctx.pass.waiting = true;
  };
  let plan = null;
  if (uploads.length) {
    if (coll.syncKey === "0") {
      keepAll("wait"); // commands cannot go with an initial SyncKey: next pass
      return { moreAvailable: true, reset: false, stale: false, outcomes };
    }
    plan = await planUploads(ctx, coll, uploads);
    for (const [id, o] of plan.outcomes) outcomes.set(id, o);
  }
  for (const sid of fetch) if (coll.items.has(sid)) coll.failed.delete(sid); // linked meanwhile
  const fetches = coll.syncKey === "0" ? [] : fetch.filter((sid) => !coll.items.has(sid));
  const initial = coll.syncKey === "0";
  const doc = await sendSync(ctx, coll, st, [...(plan?.commands ?? []), ...fetches.map(fetchCommand)]);
  st.batches++;

  if (doc === null) {
    // Empty answer: nothing new, nothing acknowledged, the SyncKey unchanged. The server has nothing more to send,
    // so a table being rebuilt is complete (a folder with no changes answers so, an empty one right after its
    // initial batch). Never to an initial SyncKey: without a key of its own, the table is not built yet.
    if (plan) for (const d of [...plan.changes.values(), ...plan.deletes.values()]) for (const id of d.ids) mergeOutcome(outcomes, id, "keep");
    if (!initial && (coll.more || coll.full)) {
      coll.more = false;
      if (coll.full) coll.endFull();
      await saveCollection(ctx.records, coll);
    }
    // Out-of-period items do not depend on the Sync answer: moved all the same.
    if (plan?.agedMoves.size) await sendAgedMoves(ctx, coll, plan, outcomes).finally(() => saveCollection(ctx.records, coll));
    for (const e of uploads) if (!outcomes.has(e.id)) outcomes.set(e.id, "keep");
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
    coll.reset({ keepAged: true });
    await saveCollection(ctx.records, coll);
    await dropPendingFor(ctx.records, [coll.serverId]); // the full resync decides again what is there
    keepAll("wait");
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
      if (coll.unlink(sid) === null) coll.unage(sid);
      ctx.pass.index(ctx.mailStore, coll.path).invalidate(del.mid);
      for (const id of del.ids) mergeOutcome(outcomes, id, "done");
    }
  }

  // Items fetched again: imported like Adds.
  const fetched = new Map();
  for (const r of c.responses) if (r.op === "fetch" && r.serverId && fetches.includes(r.serverId)) fetched.set(r.serverId, r);
  const commands = [...c.commands];
  const unanswered = [];
  for (const sid of fetches) {
    const r = fetched.get(sid);
    if (r?.status === "1" && r.data) commands.push({ op: "add", serverId: sid, data: r.data, fetched: true });
    else if (r) coll.failed.delete(sid); // not there any more (Status 8) or refused: nothing to fetch
    else unanswered.push(sid);
  }

  await processCommands(ctx, coll, st, commands);
  for (const sid of unanswered) failedAgain(ctx, coll, sid, "sans réponse du serveur", true);
  coll.syncKey = c.syncKey;
  coll.more = initial || c.moreAvailable;
  if (!coll.more && coll.full) coll.endFull();
  await saveCollection(ctx.records, coll);
  if (plan?.agedMoves.size) await sendAgedMoves(ctx, coll, plan, outcomes).finally(() => saveCollection(ctx.records, coll));
  return { moreAvailable: coll.more, reset: false, stale: false, outcomes };
}

/**
 * Sync one collection: batches until the server has nothing more, at most
 * MAX_BATCHES in this pass; then items whose import failed are fetched
 * again, and its server deletions are settled once its run is over
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
  if (!stale && !coll.more && coll.failed.size && coll.syncKey !== "0") {
    await syncBatch(ctx, coll, { fetch: [...coll.failed.keys()].slice(0, WINDOW_SIZE) });
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
  const ops = commands.some((c) => c.op === "add" || c.op === "change") ? await journalOps(ctx, coll, st) : NO_OPS;
  const deferred = [];
  let attempts = 0;
  let failures = 0;
  let lastError = null;
  const failedNow = [];
  for (const cmd of commands) {
    checkAbort(ctx);
    const sid = cmd.serverId;
    try {
      switch (cmd.op) {
        case "add":
          attempts++;
          await applyAdd(ctx, coll, cmd, index, ops);
          coll.failed.delete(sid);
          break;
        case "change":
          attempts++;
          await applyChange(ctx, coll, cmd, index, ops);
          break;
        case "delete": {
          const hash = coll.hashOf(sid);
          const mid = coll.unlink(sid) ?? coll.unage(sid); // the local action waits for the end of the run (threshold)
          coll.failed.delete(sid);
          if (mid !== null) deferred.push([sid, mid, hash]);
          break;
        }
        case "softdelete":
          coll.age(sid); // out of the period filter: still on the server, the local copy stays, its link kept apart
          coll.failed.delete(sid);
          break;
        default:
          break;
      }
    } catch (e) {
      if (ctx.signal?.aborted || e?.code === ERR.CANCELLED) throw cancelled();
      if (e instanceof Quarantine) {
        attempts--;
        coll.failed.delete(sid);
        quarantine(ctx, coll, sid, e.message);
        continue;
      }
      failures++;
      lastError = e;
      if (cmd.op === "add") failedNow.push([sid, e, cmd.fetched === true]);
      else quarantine(ctx, coll, sid, `échec local (${errorCode(e)})`);
    }
  }
  if (failures >= 2 && failures === attempts) {
    // Every local write failed: the cause is not the items. Nothing is saved, the batch comes again…
    const key = `${coll.serverId}\n${coll.syncKey}`;
    const n = (ctx.stuck?.get(key) ?? 0) + 1;
    if (n < STUCK_LIMIT) {
      ctx.stuck?.set(key, n);
      throw new EasError(SYNC_ERR.LOCAL, `Écriture impossible dans Thunderbird (${failures} échecs, ${errorCode(lastError)}).`);
    }
    // …but not for ever: the same batch failing again is let through, its items fetched again later.
    ctx.stuck?.delete(key);
    ctx.log?.error?.(`Sync ${coll.serverId} : le même lot a échoué ${n} fois, ses éléments seront redemandés plus tard.`);
  }
  for (const [sid, e, wasFetch] of failedNow) {
    ctx.pass.counts.skipped++;
    failedAgain(ctx, coll, sid, `échec local (${errorCode(e)})`, wasFetch);
  }
  if (deferred.length) {
    // Written before the SyncKey moves on: an interrupted pass loses none.
    const pending = await loadPendingDeletes(ctx.records);
    const entry = pending.get(coll.serverId) ?? { items: [], at: ctx.now(), retained: false, base: coll.size + deferred.length };
    if (!entry.base) entry.base = coll.size + entry.items.length + deferred.length;
    const known = new Set(entry.items.map((e) => e[0]));
    for (const e of deferred) if (!known.has(e[0])) entry.items.push(e);
    pending.set(coll.serverId, entry);
    await savePendingDeletes(ctx.records, pending);
  }
}

/**
 * End of a collection's run of deletions (the server has nothing more to
 * send): the server deletions it received are applied locally, or, beyond
 * the mass-deletion threshold, retained for the user. Judged on the whole
 * run, against the folder as it was before the deletions began, and over
 * the rolling window. While the run goes on (MoreAvailable), nothing is
 * decided. Also settles what an interrupted pass left undecided.
 * → number retained
 */
export async function settleDeletes(ctx, coll) {
  if (coll.more) return 0;
  const pending = await loadPendingDeletes(ctx.records);
  const entry = pending.get(coll.serverId);
  if (!entry || entry.retained || entry.folder) return 0;
  const n = entry.items.length;
  const now = ctx.now();
  const base = entry.base || coll.size + n;
  let window = coll.window;
  if (!window || !(now - window.since < MASS_DELETE_WINDOW_MS) || now < window.since) window = { since: now, count: 0, base };
  if (isMassDelete(n, base) || isMassDelete(window.count + n, Math.max(window.base, 1))) {
    entry.retained = true;
    await savePendingDeletes(ctx.records, pending);
    ctx.pass.retained += n;
    ctx.log?.warn?.(`Sync ${coll.serverId} : ${n} suppressions demandées par le serveur sur ${base} messages ; suppressions retenues jusqu'à confirmation.`);
    return n;
  }
  coll.window = { ...window, count: window.count + n };
  await applyLocalDeletes(ctx, coll, entry.items);
  await dropPendingFor(ctx.records, [coll.serverId]);
  return 0;
}

/** An item could not be imported (or fetched): kept for a later fetch, quarantined after MAX_FETCH_ATTEMPTS fetches. */
function failedAgain(ctx, coll, sid, reason, wasFetch) {
  const f = coll.failed.get(sid) ?? { attempts: 0, at: ctx.now() };
  const attempts = f.attempts + (wasFetch ? 1 : 0);
  coll.failed.delete(sid);
  if (attempts >= MAX_FETCH_ATTEMPTS) {
    quarantine(ctx, coll, sid, `${reason}, abandonné après ${MAX_FETCH_ATTEMPTS} essais`, { counted: true });
    return;
  }
  coll.failed.set(sid, { attempts, at: f.at });
  while (coll.failed.size > FAILED_MAX) coll.failed.delete(coll.failed.keys().next().value);
  ctx.log?.warn?.(`Sync ${coll.serverId} : élément ${sid} non importé (${reason}), redemandé plus tard.`);
}

function quarantine(ctx, coll, sid, reason, { counted = false } = {}) {
  coll.addQuarantine(sid, reason, ctx.now());
  if (!counted) ctx.pass.counts.skipped++;
  ctx.log?.warn?.(`Sync ${coll.serverId} : élément ${sid} mis en quarantaine (${reason}).`);
}

function readItem(data) {
  try {
    return readEmail(data);
  } catch {
    throw new Quarantine("élément illisible");
  }
}

/** Server flags (null = not given) → flags to set, without those the user changed and the journal has not sent yet. */
function serverFlags(email, pendingFlags = null) {
  const flags = {};
  if (typeof email.read === "boolean" && pendingFlags?.read === undefined) flags.read = email.read;
  if (typeof email.flagged === "boolean" && pendingFlags?.flagged === undefined) flags.flagged = email.flagged;
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

async function attach(ctx, coll, sid, mid, hash, copies, email, index, ops) {
  coll.link(sid, mid, hash);
  await setFlagsOnCopies(ctx, coll, mid, copies, serverFlags(email, ops.flags.get(mid)), index);
  ctx.pass.counts.added++;
}

/**
 * May a server item be attached to an existing local copy of its
 * Message-ID (one that no ServerId holds)? Never on the Message-ID alone,
 * which any sender can reuse:
 *  - during a full resync, when the table had fingerprints for this
 *    Message-ID before it was emptied, only an item with one of them;
 *  - otherwise, when a copy has the item's Date and sender address (as
 *    Thunderbird read them): a batch replayed after a crash, a copy the
 *    user put there.
 */
function mayAttach(coll, mid, hash, item, copies) {
  const known = coll.prior?.get(mid);
  if (known) return known.has(hash);
  return copies.some((c) => {
    const sameDate = c.date === item.date || (c.date !== null && item.date !== null && Math.abs(c.date - item.date) < 1000);
    return sameDate && c.from === item.from;
  });
}

async function applyAdd(ctx, coll, cmd, index, ops) {
  const sid = cmd.serverId;
  if (coll.items.has(sid)) {
    await applyChange(ctx, coll, cmd, index, ops); // already known (a replayed batch, a server echo of our move)
    return;
  }
  if (coll.size >= MAX_ITEMS && !coll.aged.has(sid)) throw new Quarantine("dossier trop grand");
  const email = readItem(cmd.data);
  if (!(email.mime instanceof Uint8Array) || !email.mime.length) throw new Quarantine("sans contenu MIME");
  if (email.truncated) throw new Quarantine("contenu tronqué par le serveur");
  let prepared;
  let hash;
  let item;
  try {
    const stripped = stripInternalHeaders(email.mime);
    const digest = sha256(stripped);
    hash = fingerprint(digest);
    prepared = ensureMessageId(stripped, { hash: digest });
    item = { date: dateOf(stripped), from: fromAddressOf(stripped) };
  } catch {
    throw new Quarantine("message illisible");
  }
  let { bytes, messageId } = prepared;
  if (!validMid(messageId)) throw new Quarantine("Message-ID inutilisable");
  const back = coll.aged.get(sid) === messageId && coll.hashOf(sid) === hash; // back in the period: the same item
  coll.unage(sid);

  let copies = await index.get(messageId);
  const free = copies.length - coll.allRefs(messageId);
  // A copy a server deletion of this pass just put in the local trash, with this very content (moved there on the server).
  const trashedHere = inLocalTrash(ctx, coll.path) && Boolean(ctx.pass.trashed.get(messageId)?.has(hash));
  if (free > 0 && (back || trashedHere || mayAttach(coll, messageId, hash, item, copies))) {
    await attach(ctx, coll, sid, messageId, hash, copies, email, index, ops);
    return;
  }
  // Full resync: a message the user deleted or moved out (journal not sent yet) is linked, not brought back,
  // but only the very message the table held (its fingerprint): never an item that reuses its Message-ID.
  const removed = ops.removed.get(messageId) ?? 0;
  const known = coll.prior?.get(messageId);
  const same = Boolean(known?.has(hash));
  if (coll.full && same && free <= 0 && coll.allRefs(messageId) - copies.length < removed) {
    coll.link(sid, messageId, hash);
    coll.held.add(sid);
    return;
  }
  // Moved here on the server: the copy a deletion just sent to the local trash comes back.
  if (!copies.length && (await reuseTrashed(ctx, coll, sid, messageId, hash, email, index, ops))) return;

  if (copies.length) {
    // The local copies are not this item's: a distinct copy, under its own Message-ID (maybe there already).
    ({ bytes, messageId } = distinctCopy(bytes, coll.serverId, sid));
    copies = await index.get(messageId);
    if (copies.length > coll.allRefs(messageId)) {
      await attach(ctx, coll, sid, messageId, hash, copies, email, index, ops);
      return;
    }
    if (copies.length) throw new Quarantine("copie distincte impossible");
  }
  await importItem(ctx, coll, sid, bytes, messageId, hash, email, index, ops, item);
}

/**
 * Import, then link the Message-ID Thunderbird read (`headerMessageId`).
 * If Thunderbird read another id than ours, a usable one is linked as it
 * is; an unusable one (blanks, controls) means the message is imported
 * again under an id of ours, the first copy going to the local trash.
 */
async function importItem(ctx, coll, sid, bytes, messageId, hash, email, index, ops, item, again = false) {
  const flags = { read: email.read ?? false, flagged: email.flagged ?? false };
  const pending = ops.flags.get(messageId);
  if (pending?.read !== undefined) flags.read = pending.read;
  if (pending?.flagged !== undefined) flags.flagged = pending.flagged;
  let r;
  try {
    r = await ctx.mailStore.importMessage(coll.path, bytes, flags, { messageId });
  } catch (e) {
    // The folder may have received the message in the meantime (a user action): attach it if so.
    index.invalidate(messageId);
    const now = await index.get(messageId);
    if (now.length > coll.allRefs(messageId)) {
      await attach(ctx, coll, sid, messageId, hash, now, email, index, ops);
      return;
    }
    throw e;
  }
  const read = typeof r?.messageId === "string" ? r.messageId : messageId;
  if (read === messageId) {
    index.add(messageId, { id: r.id, ...flags, date: item.date, from: item.from });
    coll.link(sid, messageId, hash);
    ctx.pass.counts.added++;
    return;
  }
  index.invalidate(read);
  // Another copy already under that id in the folder: two items would share it (deletions are matched by
  // count): not linked as it is, imported again under an id of ours instead.
  const clash = validMid(read) && ((await index.get(read)).length > 1 || coll.allRefs(read) > 0);
  if (validMid(read) && !clash) {
    ctx.log?.warn?.(`Sync ${coll.serverId} : élément ${sid}, Message-ID lu autrement par Thunderbird ; sa lecture est gardée.`);
    coll.link(sid, read, hash);
    ctx.pass.counts.added++;
    return;
  }
  // Unusable as Thunderbird reads it (or already taken there): this copy, ours and just made, goes for good (kept
  // anywhere, its id would count against the other copy), then the message comes again under an id of ours, once.
  await ctx.mailStore.discardImport(r.id);
  index.invalidate(read);
  if (again) throw new Quarantine("Message-ID illisible par Thunderbird");
  ctx.log?.warn?.(`Sync ${coll.serverId} : élément ${sid}, Message-ID ${clash ? "déjà présent dans le dossier" : "illisible"} selon Thunderbird ; message réimporté sous un identifiant propre.`);
  const own = distinctCopy(bytes, coll.serverId, sid);
  await importItem(ctx, coll, sid, own.bytes, own.messageId, hash, email, index, ops, item, true);
}

async function reuseTrashed(ctx, coll, sid, mid, hash, email, index, ops) {
  const known = ctx.pass.trashed.get(mid);
  if (!known?.has(hash) || !ctx.trashPath || inLocalTrash(ctx, coll.path)) return false;
  const trashIndex = ctx.pass.index(ctx.mailStore, ctx.trashPath);
  const inTrash = await trashIndex.get(mid);
  // Only a copy no trash item is attached to may leave the trash.
  const trashColl = ctx.collectionOf?.(ctx.trashPath) ?? null;
  if (!inTrash.length || (trashColl && trashColl.allRefs(mid) >= inTrash.length)) return false;
  const r = await ctx.mailStore.moveMessages([inTrash[inTrash.length - 1].id], coll.path, { path: ctx.trashPath, messageId: mid });
  trashIndex.invalidate(mid);
  if (!r?.moved?.length) return false;
  if (inTrash.length <= 1) ctx.pass.trashed.delete(mid);
  index.invalidate(mid);
  const copies = await index.get(mid);
  await attach(ctx, coll, sid, mid, hash, copies, email, index, ops);
  return true;
}

async function applyChange(ctx, coll, cmd, index, ops) {
  const mid = coll.midOf(cmd.serverId);
  if (mid === null) {
    ctx.pass.counts.skipped++; // unknown here (quarantined earlier, or never attached)
    return;
  }
  const email = readItem(cmd.data);
  const flags = serverFlags(email, ops.flags.get(mid));
  if (!Object.keys(flags).length) return;
  const copies = await index.get(mid);
  if (await setFlagsOnCopies(ctx, coll, mid, copies, flags, index)) ctx.pass.counts.changed++;
}

/**
 * Local side of a server deletion (the ServerId is already unlinked): once
 * no ServerId points to the message, its local copies go to the local
 * trash (in the trash: deleted).
 */
async function deleteLocally(ctx, coll, sid, mid, hash, index = ctx.pass.index(ctx.mailStore, coll.path)) {
  if (coll.allRefs(mid) > 0) return; // another ServerId points to it (or again)
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
  if (moved.length) addTo(ctx.pass.trashed, mid, hash); // may come back elsewhere in this pass (a move on the server)
}

/** Server deletions decided (below the threshold, or confirmed by the user): applied locally. */
export async function applyLocalDeletes(ctx, coll, items) {
  for (const [sid, mid, hash] of items) {
    checkAbort(ctx);
    try {
      await deleteLocally(ctx, coll, sid, mid, hash);
    } catch (e) {
      if (ctx.signal?.aborted || e?.code === ERR.CANCELLED) throw cancelled();
      quarantine(ctx, coll, sid, `suppression locale impossible (${errorCode(e)})`);
    }
  }
  await saveCollection(ctx.records, coll);
}

// ── Local moves (journal) ────────────────────────────────────────────────

const MOVE_DONE = "3";
const MOVE_GONE = "1";
const MOVE_TRANSIENT = new Set(["5", "7"]);

/** MoveItems answer → Map<SrcMsgId, answer> (the first answer for each). */
function readMoveItems(doc) {
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
  return byId;
}

/**
 * Journal moves → MoveItems requests. A move is reconciled by count, like
 * a deletion: the ServerIds beyond the local copies left in the source
 * folder move to the destination (in the period first, then out of it). A
 * ServerId appears at most once in a request (the server answers per
 * source id).
 *
 * collectionOf(path, entry) → CollectionState of the synchronised source, or null.
 * destinationOf(path, entry) → the same for a destination: any folder that
 *   exists on the server will do, even if its local folder is missing.
 * A move to a folder with no server counterpart (a local folder) changes
 * nothing on the server: the server copy stays where it is, the source's
 * link is only forgotten (counted in `unlinked`). Never a deletion.
 * A success without DstMsgId only unlinks the source: the destination's
 * next sync attaches the message by its Message-ID.
 * → { outcomes, unlinked }
 */
export async function replayMoves(ctx, entries, collectionOf, destinationOf = collectionOf) {
  const outcomes = new Map();
  const moves = [];
  const used = new Set();
  const planned = new Map(); // source ServerId + Message-ID → ServerIds taken
  const unlinkedFrom = new Set();
  let unlinked = 0;
  for (const e of entries) {
    const src = collectionOf(e.path, e);
    if (!src) {
      outcomes.set(e.id, "done"); // the source is not on the server: nothing to do there
      continue;
    }
    const key = `${src.serverId}\n${e.messageId}`;
    const copies = await localCopies(ctx, src.path, e.messageId);
    const taken = planned.get(key) ?? 0;
    const excess = src.allRefs(e.messageId) - taken - copies;
    if (excess <= 0) {
      if (src.full) {
        outcomes.set(e.id, "wait"); // the source is being rebuilt: the message may not be relinked yet
        ctx.pass.waiting = true;
      } else outcomes.set(e.id, "done");
      continue;
    }
    const dst = destinationOf(e.toPath, e);
    if (dst === src) {
      outcomes.set(e.id, "done");
      continue;
    }
    const sids = src.removalOrder(e.messageId).filter((s) => !used.has(`${src.serverId}\n${s}`)).slice(0, excess);
    planned.set(key, taken + sids.length);
    if (!dst) {
      // Moved to a local folder: the server keeps its copy; only the link goes.
      for (const sid of sids) {
        used.add(`${src.serverId}\n${sid}`);
        if (src.unlink(sid) === null) src.unage(sid);
        unlinked++;
      }
      if (sids.length) unlinkedFrom.add(src);
      outcomes.set(e.id, "done");
      continue;
    }
    if (!sids.length) {
      outcomes.set(e.id, "done");
      continue;
    }
    for (const sid of sids) {
      used.add(`${src.serverId}\n${sid}`);
      moves.push({ serverId: sid, from: src, to: dst, entryId: e.id, mid: e.messageId, hash: src.hashOf(sid) });
    }
  }
  const touched = new Set(unlinkedFrom);
  if (unlinked) ctx.log?.info?.(`Journal : ${unlinked} message(s) déplacé(s) vers un dossier local ; leur copie sur le serveur est gardée.`);

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
  try {
    for (const b of batches) {
      checkAbort(ctx);
      const byId = readMoveItems(
        await ctx.client.command("MoveItems", moveItemsRequest(b.list.map((m) => ({ serverId: m.serverId, from: m.from.serverId, to: m.to.serverId }))), { signal: ctx.signal }),
      );
      for (const m of b.list) {
        const a = byId.get(m.serverId);
        let o;
        if (!a) {
          o = "keep";
        } else if (a.status === MOVE_DONE) {
          if (m.from.unlink(m.serverId) === null) m.from.unage(m.serverId);
          if (a.dstMsgId) m.to.link(a.dstMsgId, m.mid, m.hash);
          touched.add(m.from).add(m.to);
          o = "done";
        } else if (a.status === MOVE_GONE) {
          if (m.from.unlink(m.serverId) === null) m.from.unage(m.serverId); // no longer in the source folder on the server
          touched.add(m.from);
          o = "drop";
        } else {
          o = MOVE_TRANSIENT.has(a.status) ? "keep" : "drop";
        }
        mergeOutcome(outcomes, m.entryId, o);
      }
    }
  } finally {
    for (const coll of touched) await saveCollection(ctx.records, coll);
  }
  return { outcomes, unlinked };
}

// ── Distinct copy ────────────────────────────────────────────────────────

/**
 * The same message under its own Message-ID, for a second copy in a folder
 * that already holds its Message-ID (Thunderbird refuses to import it as
 * it is): see core/mime.mjs replaceMessageId (every Message-ID field
 * renamed X-Sync443-Original-Message-ID, the new one first, never folded
 * onto a first line that starts with a blank). hex: the first 16 bytes of
 * SHA-256(message, 0, collection, 0, ServerId), so the same item always
 * gets the same id. → { bytes, messageId }
 */
export function distinctCopy(bytes, collectionId, serverId) {
  const salt = encodeUtf8(`\u0000${collectionId}\u0000${serverId}`);
  const all = new Uint8Array(bytes.length + salt.length);
  all.set(bytes);
  all.set(salt, bytes.length);
  const messageId = `${toHex(sha256(all).subarray(0, 16))}@${SYNTHETIC_DOMAIN}`;
  return { bytes: replaceMessageId(bytes, messageId), messageId };
}
