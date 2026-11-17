// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Journal: the persistent queue of local changes waiting for the server.
 *
 * Entry = { id, op, path, messageId?, flags?, toPath?, src?, dst?, at, attempts }
 *   op ∈ flags | move | delete | folderCreate | folderRename | folderMove | folderDelete
 *   src, dst: ServerIds of the collections of `path` and `toPath` when the
 *   change was made (message operations), so that the change goes to the
 *   server folder it was made in even if local folders move before it is
 *   sent (a folder renamed on the server, another folder taking its name).
 *
 * Entries never hold a Thunderbird id (they change at every start): a
 * message is a Message-ID in a folder.
 *
 * Rules:
 *  - an entry leaves the journal only once the server answered positively
 *    FOR IT ("done"), or refused it for good ("drop", logged);
 *  - a transient refusal keeps it ("keep"), with an attempt counter: after
 *    MAX_ATTEMPTS it is dropped, logged, so a poisoned entry cannot stay
 *    for ever. Attempts are counted once per run (settle's `run`): the
 *    passes of one run, back to back, count as one attempt;
 *  - an entry that could not be sent yet ("wait": its collection is being
 *    rebuilt and does not know the message again yet) stays without an
 *    attempt being counted, for MAX_WAITS runs at most (then "keep");
 *  - a failed request (network, server error) settles nothing: every entry
 *    it carried stays, and the error goes up;
 *  - entries are replayed in order (see replayJournal).
 *
 * Storage: record `journal` = { v: 2, seq } (v: the format, written for a
 * later version to recognise it), and the entries in chunks of
 * CHUNK_SIZE records `journal:<n>` = { entries }, so that one more entry
 * rewrites one chunk, never the whole journal. Writes are coalesced: a
 * write starts WRITE_DELAY_MS after the first change, one at a time, each
 * gathering everything that changed meanwhile. append() returns as soon as
 * the entry is in the journal in memory (as an event waiting in
 * tb/events.mjs was), and the entry reaches the storage a moment later
 * (flush() and close() wait for it).
 */

import { EasError, ERR } from "../transport/client.mjs";
import * as v from "../core/sanitize.mjs";
import { MAX_MESSAGE_ID } from "../core/mime.mjs";
import { errorCode } from "../log.mjs";

const OPS = Object.freeze(["flags", "move", "delete", "folderCreate", "folderRename", "folderMove", "folderDelete"]);
const FOLDER_OPS = new Set(["folderCreate", "folderRename", "folderMove", "folderDelete"]);
const JOURNAL_MAX = 50_000;
export const MAX_ATTEMPTS = 20;
/** Most commands in one replay request (Sync upload or MoveItems). */
export const MAX_PER_REQUEST = 100;
/** Entries per storage chunk. */
const CHUNK_SIZE = 500;
/** Runs an entry may wait (its collection being rebuilt) before its attempts are counted again. */
export const MAX_WAITS = 100;
/** A write waits this long for more changes (a burst of events costs one write). */
const WRITE_DELAY_MS = 20;

const RECORD = "journal";
const CHUNK = /^journal:([1-9][0-9]{0,8})$/;
const MAX_PATH = 2048;
const { hasControl } = v;

const validPath = (p) => typeof p === "string" && p.length >= 2 && p.length <= MAX_PATH && p.startsWith("/") && !p.endsWith("/") && !hasControl(p) && !p.includes("//");
const validMessageId = (m) => typeof m === "string" && m.length >= 1 && m.length <= MAX_MESSAGE_ID && !hasControl(m) && !/\s/.test(m);

/**
 * A local intent ({ kind, path, messageId?, flags?, toPath?, src?, dst? },
 * from tb/events.mjs, src and dst added by the engine) → the fields of a
 * journal entry, or null if invalid. An invalid src or dst is left out.
 */
export function checkIntent(intent) {
  if (!intent || typeof intent !== "object" || !OPS.includes(intent.kind) || !validPath(intent.path)) return null;
  const op = intent.kind;
  const out = { op, path: intent.path };
  if (op === "flags" || op === "move" || op === "delete") {
    if (!validMessageId(intent.messageId)) return null;
    out.messageId = intent.messageId;
    if (v.itemId(intent.src)) out.src = intent.src;
  }
  if (op === "flags") {
    const flags = {};
    for (const f of ["read", "flagged"]) if (typeof intent.flags?.[f] === "boolean") flags[f] = intent.flags[f];
    if (!Object.keys(flags).length) return null;
    out.flags = flags;
  }
  if (op === "move" || op === "folderRename" || op === "folderMove") {
    if (!validPath(intent.toPath) || intent.toPath === intent.path) return null;
    out.toPath = intent.toPath;
    if (op === "move" && v.itemId(intent.dst)) out.dst = intent.dst;
  }
  return out;
}

function checkEntry(e) {
  if (!e || typeof e !== "object" || !Number.isSafeInteger(e.id) || e.id < 1) return null;
  const fields = checkIntent({ ...e, kind: e.op });
  if (!fields) return null;
  return {
    id: e.id,
    ...fields,
    at: Number.isFinite(e.at) ? e.at : 0,
    attempts: Number.isSafeInteger(e.attempts) && e.attempts >= 0 ? e.attempts : 0,
    ...(Number.isSafeInteger(e.waits) && e.waits > 0 ? { waits: e.waits } : {}),
  };
}

const copyEntry = (e) => ({ ...e, ...(e.flags ? { flags: { ...e.flags } } : {}) });

export class Journal {
  #records;
  #log;
  #now;
  #max;
  #seq = 0;
  #chunks = null; // Map<n, entry[]>, n increasing; loaded lazily
  #size = 0;
  #open = 1; // chunk receiving new entries
  #openCount = 0; // entries appended to it so far
  #loading = null;
  #dirty = new Set(); // chunks to write
  #seqDirty = false;
  #writing = null;
  #timer = null; // a write about to start
  #closed = false;
  #lastRun = new Map(); // entry id → run in which its last attempt was counted (memory only)

  /**
   * @param {object} o
   * @param {{get, set, remove, names}} o.records  store.mailbox(id)
   * @param {object} [o.log]
   * @param {() => number} [o.now]
   * @param {number} [o.max]
   */
  constructor({ records, log = null, now = () => Date.now(), max = JOURNAL_MAX }) {
    this.#records = records;
    this.#log = log;
    this.#now = now;
    this.#max = max;
  }

  async #load() {
    if (this.#chunks) return;
    this.#loading ??= (async () => {
      const raw = await this.#records.get(RECORD, null);
      const found = []; // [chunk, entry]
      const numbers = (await this.#records.names()).map((n) => CHUNK.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
      for (const n of numbers) {
        const chunk = await this.#records.get(`journal:${n}`, null);
        for (const e of Array.isArray(chunk?.entries) ? chunk.entries : []) found.push([n, e]);
      }
      const chunks = new Map();
      let seq = 0;
      let damaged = 0;
      const seen = new Set();
      for (const [n, e] of found) {
        const ok = checkEntry(e);
        if (!ok || seen.has(ok.id)) {
          damaged++;
          continue;
        }
        seen.add(ok.id);
        if (!chunks.has(n)) chunks.set(n, []);
        chunks.get(n).push(ok);
        seq = Math.max(seq, ok.id);
      }
      if (damaged) this.#log?.warn?.(`Journal : ${damaged} entrée(s) illisible(s) écartée(s).`);
      const ordered = new Map([...chunks].sort((a, b) => a[0] - b[0]));
      for (const list of ordered.values()) list.sort((a, b) => a.id - b.id);
      this.#seq = Math.max(seq, Number.isSafeInteger(raw?.seq) ? raw.seq : 0);
      this.#size = seen.size;
      this.#open = Math.max(1, ...ordered.keys(), ...numbers);
      this.#openCount = ordered.get(this.#open)?.length ?? 0;
      this.#chunks = ordered;
    })();
    await this.#loading;
  }

  #entries() {
    const out = [];
    for (const list of this.#chunks.values()) for (const e of list) out.push(e);
    return out;
  }

  /** Write what changed: chunks first, then the sequence (a chunk without its sequence only loses nothing). */
  async #writeDirty() {
    const dirty = [...this.#dirty];
    const seqDirty = this.#seqDirty;
    this.#dirty.clear();
    this.#seqDirty = false;
    try {
      for (const n of dirty) {
        const list = this.#chunks.get(n);
        if (list?.length) await this.#records.set(`journal:${n}`, { entries: list.map(copyEntry) });
        else {
          if (list && n !== this.#open) this.#chunks.delete(n);
          await this.#records.remove(`journal:${n}`);
        }
      }
      if (seqDirty) await this.#records.set(RECORD, { v: 2, seq: this.#seq });
    } catch (e) {
      for (const n of dirty) this.#dirty.add(n);
      this.#seqDirty ||= seqDirty;
      throw e;
    }
  }

  /** Start writing (coalesced). → a promise of the end of every write asked so far. */
  #schedule() {
    if (!this.#writing) {
      this.#writing = (async () => {
        try {
          while (this.#dirty.size || this.#seqDirty) await this.#writeDirty();
        } finally {
          this.#writing = null;
        }
      })();
    }
    return this.#writing;
  }

  #write() {
    if (this.#timer || this.#writing) return; // the write about to start, or the next one, takes it
    const start = () => {
      if (this.#timer !== token) return; // flush() started it already
      this.#timer = null;
      this.#schedule().catch((e) => {
        this.#log?.warn?.(`Journal : écriture différée (${errorCode(e)}).`);
      });
    };
    const token = {};
    this.#timer = token;
    if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(start, WRITE_DELAY_MS);
    else Promise.resolve().then(start);
  }

  /** Resolves once everything changed so far is in the storage (throws if the storage refuses it). */
  async flush() {
    await this.#load();
    this.#timer = null; // started now, not after the delay
    while (this.#writing || this.#dirty.size || this.#seqDirty) {
      try {
        await this.#schedule();
      } catch (e) {
        if (!this.#writing && (this.#dirty.size || this.#seqDirty)) throw e;
      }
    }
  }

  /**
   * Forget every entry (the mailbox no longer synchronizes mail: what was
   * not sent never will be). The sequence stays: an id is never given twice.
   */
  async clear() {
    await this.#load();
    for (const [n, list] of this.#chunks) {
      list.length = 0;
      this.#dirty.add(n);
    }
    this.#size = 0;
    this.#openCount = 0;
    this.#lastRun.clear();
    await this.flush();
  }

  /** Flush, then refuse any further change (the engine is being replaced). */
  async close() {
    this.#closed = true;
    await this.flush();
  }

  /** Record a local intent. → the entry, or null if invalid or the journal is full. */
  async append(intent) {
    if (this.#closed) throw new EasError("CLOSED", "Journal fermé.");
    const fields = checkIntent(intent);
    if (!fields) {
      this.#log?.debug?.("Journal : intention locale invalide ignorée.");
      return null;
    }
    await this.#load();
    if (this.#closed) throw new EasError("CLOSED", "Journal fermé.");
    if (this.#size >= this.#max) {
      this.#log?.error?.(`Journal plein (${this.#max} modifications en attente) : modification locale non transmise au serveur.`);
      return null;
    }
    if (this.#openCount >= CHUNK_SIZE) {
      this.#open++;
      this.#openCount = 0;
    }
    const entry = { id: ++this.#seq, ...fields, at: this.#now(), attempts: 0 };
    if (!this.#chunks.has(this.#open)) this.#chunks.set(this.#open, []);
    this.#chunks.get(this.#open).push(entry);
    this.#openCount++;
    this.#size++;
    this.#dirty.add(this.#open);
    this.#seqDirty = true;
    this.#write();
    return copyEntry(entry);
  }

  /** Snapshot of the waiting entries, in order. */
  async list() {
    await this.#load();
    return this.#entries().map(copyEntry);
  }

  /** Number of waiting entries (tests). */
  async size() {
    await this.#load();
    return this.#size;
  }

  /**
   * Apply outcomes: Map<id, "done" | "drop" | "keep" | "wait">. "done" and
   * "drop" leave the journal; "keep" counts an attempt (dropped after
   * MAX_ATTEMPTS), at most once per `run` when one is given; "wait" (not
   * sent: its collection is being rebuilt) leaves the entry as it is.
   * → { done, dropped, kept }
   */
  async settle(outcomes, { run = null } = {}) {
    await this.#load();
    let done = 0;
    let dropped = 0;
    let kept = 0;
    for (const [n, list] of this.#chunks) {
      let changed = false;
      const next = [];
      for (const raw of list) {
        let e = raw;
        let o = outcomes.get(e.id);
        if (o === "wait" && run !== null && this.#lastRun.get(e.id) !== run) {
          // A run spent waiting: counted apart; past MAX_WAITS, waiting counts as trying (a rebuild that never ends).
          if ((e.waits ?? 0) + 1 > MAX_WAITS) o = "keep";
          else {
            this.#lastRun.set(e.id, run);
            e = { ...e, waits: (e.waits ?? 0) + 1 };
            changed = true;
          }
        }
        if (o === "done") {
          done++;
          changed = true;
          this.#lastRun.delete(e.id);
        } else if (o === "drop") {
          dropped++;
          changed = true;
          this.#lastRun.delete(e.id);
          this.#log?.warn?.(`Journal : modification locale n° ${e.id} (${e.op}) refusée par le serveur, abandonnée.`);
        } else if (o === "wait") {
          kept++;
          next.push(e);
        } else if (o === "keep") {
          kept++;
          if (run !== null && this.#lastRun.get(e.id) === run) {
            next.push(e); // already counted in this run
            continue;
          }
          changed = true;
          if (run !== null) this.#lastRun.set(e.id, run);
          if (e.attempts + 1 >= MAX_ATTEMPTS) {
            kept--;
            dropped++;
            this.#lastRun.delete(e.id);
            this.#log?.warn?.(`Journal : modification locale n° ${e.id} (${e.op}) abandonnée après ${MAX_ATTEMPTS} essais.`);
          } else {
            next.push({ ...e, attempts: e.attempts + 1 });
          }
        } else {
          next.push(e);
        }
      }
      if (changed) {
        this.#size -= list.length - next.length;
        this.#chunks.set(n, next);
        this.#dirty.add(n);
      }
    }
    if (this.#dirty.size) this.#write();
    return { done, dropped, kept };
  }

  /**
   * Collections whose folder another ServerId took over (a partnership reset
   * renumbers them): Map<old, new>, applied to every waiting entry at once
   * (src and dst rewritten; old ids may be handed to other folders, even
   * swapped). New null: the id is left out, the entry keeps only its local
   * folder (path, toPath). → number of entries changed
   */
  async rebind(ids) {
    await this.#load();
    let changed = 0;
    const set = (e, key) => {
      const to = ids.get(e[key]);
      if (to) e[key] = to;
      else delete e[key];
    };
    for (const [n, list] of this.#chunks) {
      let touched = false;
      const next = list.map((e) => {
        const src = Boolean(e.src) && ids.has(e.src);
        const dst = Boolean(e.dst) && ids.has(e.dst);
        if (!src && !dst) return e;
        touched = true;
        changed++;
        const out = { ...e };
        if (src) set(out, "src");
        if (dst) set(out, "dst");
        return out;
      });
      if (touched) {
        this.#chunks.set(n, next);
        this.#dirty.add(n);
      }
    }
    if (changed) this.#write();
    return changed;
  }

  /** Folder paths that waiting folder operations will change (the local folder pass leaves them alone). */
  async pendingFolderPaths() {
    await this.#load();
    const paths = new Set();
    for (const e of this.#entries()) {
      if (!FOLDER_OPS.has(e.op)) continue;
      paths.add(e.path);
      if (e.toPath) paths.add(e.toPath);
    }
    return paths;
  }

  /**
   * Waiting message operations made in one collection (its ServerId, or,
   * for entries without one, its local path):
   *   removed: Map<Message-ID, number of copies deleted or moved out>
   *   flags:   Map<Message-ID, { read?, flagged? }>  (the latest value of each)
   * The engine uses it so that a full resynchronisation does not bring
   * back what the user removed, nor undo flags not sent yet.
   */
  async messageOps({ serverId = null, path = null } = {}) {
    await this.#load();
    const removed = new Map();
    const flags = new Map();
    for (const e of this.#entries()) {
      if (e.op !== "flags" && e.op !== "delete" && e.op !== "move") continue;
      if (e.src ? e.src !== serverId : e.path !== path) continue;
      if (e.op === "flags") flags.set(e.messageId, { ...flags.get(e.messageId), ...e.flags });
      else removed.set(e.messageId, (removed.get(e.messageId) ?? 0) + 1);
    }
    return { removed, flags };
  }
}

/** Is `path` equal to, or inside, one of `roots`? */
export function touches(path, roots) {
  for (const r of roots) if (path === r || path.startsWith(`${r}/`) || r.startsWith(`${path}/`)) return true;
  return false;
}

/**
 * Replay the journal, in order.
 *
 * Consecutive flag and delete entries are sent together (one Sync request
 * per collection); consecutive moves go in MoveItems requests where a
 * message appears at most once (the server answers per source id, and the
 * second move of a message needs the id the first one gives it); folder
 * operations go one by one. A group is settled as soon as its answer is
 * read, so a failure later on never re-sends what the server acknowledged.
 *
 * handlers (each returns Map<entryId, "done" | "drop" | "keep" | "wait">; an entry
 * missing from the map stays untouched):
 *   uploads(path, entries, signal)   flags and deletes of one folder (all
 *                                    with the same `src`, or none and the same path)
 *   moves(entries, signal)           message moves (MoveItems)
 *   folder(entry, signal)            one folder operation
 * run: the run this replay belongs to (Journal.settle).
 *
 * → { sent, dropped, kept }   (sent: entries the server acknowledged)
 */
export async function replayJournal({ journal, handlers, signal = null, log = null, run = null }) {
  const entries = await journal.list();
  const total = { sent: 0, dropped: 0, kept: 0 };
  const settle = async (outcomes) => {
    const r = await journal.settle(outcomes, { run });
    total.sent += r.done;
    total.dropped += r.dropped;
    total.kept += r.kept;
  };
  const checkAbort = () => {
    if (signal?.aborted) throw new EasError(ERR.CANCELLED, "Synchronisation annulée.");
  };

  let i = 0;
  while (i < entries.length) {
    checkAbort();
    const kind = entries[i].op;
    if (kind === "flags" || kind === "delete") {
      // A run of uploads, grouped by collection (or folder), order kept within each.
      const byPath = new Map();
      while (i < entries.length && (entries[i].op === "flags" || entries[i].op === "delete")) {
        const e = entries[i++];
        const key = JSON.stringify(e.src ? ["s", e.src] : ["p", e.path]);
        const list = byPath.get(key);
        if (list) list.push(e);
        else byPath.set(key, [e]);
      }
      for (const list of byPath.values()) {
        const path = list[0].path;
        for (let at = 0; at < list.length; at += MAX_PER_REQUEST) {
          checkAbort();
          await settle(await handlers.uploads(path, list.slice(at, at + MAX_PER_REQUEST), signal));
        }
      }
    } else if (kind === "move") {
      let group = [];
      const inGroup = new Set();
      const flush = async () => {
        if (!group.length) return;
        checkAbort();
        const g = group;
        group = [];
        inGroup.clear();
        await settle(await handlers.moves(g, signal));
      };
      while (i < entries.length && entries[i].op === "move") {
        const e = entries[i++];
        if (inGroup.has(e.messageId) || group.length >= MAX_PER_REQUEST) await flush();
        group.push(e);
        inGroup.add(e.messageId);
      }
      await flush();
    } else {
      const e = entries[i++];
      await settle(await handlers.folder(e, signal));
    }
  }
  if (total.dropped) log?.info?.(`Journal : ${total.dropped} modification(s) locale(s) abandonnée(s).`);
  return total;
}
