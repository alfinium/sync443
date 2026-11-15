// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Journal: the persistent queue of local changes waiting for the server.
 *
 * Record `journal` of the mailbox: { seq, entries: [entry, …] }, with
 *   entry = { id, op, path, messageId?, flags?, toPath?, at, attempts }
 *   op ∈ flags | move | delete | folderCreate | folderRename | folderMove | folderDelete
 *
 * Entries never hold a Thunderbird id (they change at every start): a
 * message is a Message-ID in a folder path.
 *
 * Rules:
 *  - an entry leaves the journal only once the server answered positively
 *    FOR IT ("done"), or refused it for good ("drop", logged);
 *  - a transient refusal keeps it ("keep"), with an attempt counter: after
 *    MAX_ATTEMPTS it is dropped, logged, so a poisoned entry cannot stay
 *    for ever;
 *  - a failed request (network, server error) settles nothing: every entry
 *    it carried stays, and the error goes up;
 *  - entries are replayed in order (see replayJournal).
 *
 * Writes are coalesced: many events in a row cost a few writes, not one per
 * event, and an entry is acknowledged to the caller only once written.
 */

import { EasError, ERR } from "../transport/client.mjs";

export const OPS = Object.freeze(["flags", "move", "delete", "folderCreate", "folderRename", "folderMove", "folderDelete"]);
export const FOLDER_OPS = new Set(["folderCreate", "folderRename", "folderMove", "folderDelete"]);
export const JOURNAL_MAX = 50_000;
export const MAX_ATTEMPTS = 20;
/** Most commands in one replay request (Sync upload or MoveItems). */
export const MAX_PER_REQUEST = 100;

const RECORD = "journal";
const MAX_PATH = 2048;
const MAX_MESSAGE_ID = 998; // the longest line RFC 5322 allows

const hasControl = (s) => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s);
const validPath = (p) => typeof p === "string" && p.length >= 2 && p.length <= MAX_PATH && p.startsWith("/") && !p.endsWith("/") && !hasControl(p) && !p.includes("//");
const validMessageId = (m) => typeof m === "string" && m.length >= 1 && m.length <= MAX_MESSAGE_ID && !hasControl(m) && !/\s/.test(m);

/**
 * A local intent ({ kind, path, messageId?, flags?, toPath? }, from
 * tb/events.mjs) → the fields of a journal entry, or null if invalid.
 */
export function checkIntent(intent) {
  if (!intent || typeof intent !== "object" || !OPS.includes(intent.kind) || !validPath(intent.path)) return null;
  const op = intent.kind;
  const out = { op, path: intent.path };
  if (op === "flags" || op === "move" || op === "delete") {
    if (!validMessageId(intent.messageId)) return null;
    out.messageId = intent.messageId;
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
  };
}

export class Journal {
  #records;
  #log;
  #now;
  #max;
  #seq = 0;
  #entries = null; // loaded lazily
  #loading = null;
  #writing = null; // the write in progress
  #dirty = false;

  /**
   * @param {object} o
   * @param {{get, set}} o.records  store.mailbox(id)
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
    if (this.#entries) return;
    this.#loading ??= (async () => {
      const raw = await this.#records.get(RECORD, null);
      const entries = [];
      let seq = 0;
      let damaged = 0;
      const seen = new Set();
      for (const e of Array.isArray(raw?.entries) ? raw.entries : []) {
        const ok = checkEntry(e);
        if (!ok || seen.has(ok.id)) {
          damaged++;
          continue;
        }
        seen.add(ok.id);
        entries.push(ok);
        seq = Math.max(seq, ok.id);
      }
      if (damaged) this.#log?.warn?.(`Journal : ${damaged} entrée(s) illisible(s) écartée(s).`);
      this.#seq = Math.max(seq, Number.isSafeInteger(raw?.seq) ? raw.seq : 0);
      this.#entries = entries;
    })();
    await this.#loading;
  }

  /** Write the current state; concurrent callers share writes (at most one running, one queued). */
  async #flush() {
    this.#dirty = true;
    while (this.#dirty) {
      if (this.#writing) {
        await this.#writing.catch(() => {});
        continue;
      }
      this.#dirty = false;
      const snapshot = { seq: this.#seq, entries: this.#entries.map((e) => ({ ...e })) };
      this.#writing = this.#records.set(RECORD, snapshot);
      try {
        await this.#writing;
      } finally {
        this.#writing = null;
      }
    }
  }

  /** Record a local intent. → the entry, or null if invalid or the journal is full. */
  async append(intent) {
    const fields = checkIntent(intent);
    if (!fields) {
      this.#log?.debug?.("Journal : intention locale invalide ignorée.");
      return null;
    }
    await this.#load();
    if (this.#entries.length >= this.#max) {
      this.#log?.error?.(`Journal plein (${this.#max} modifications en attente) : modification locale non transmise au serveur.`);
      return null;
    }
    const entry = { id: ++this.#seq, ...fields, at: this.#now(), attempts: 0 };
    this.#entries.push(entry);
    await this.#flush();
    return { ...entry };
  }

  /** Snapshot of the waiting entries, in order. */
  async list() {
    await this.#load();
    return this.#entries.map((e) => ({ ...e, flags: e.flags ? { ...e.flags } : undefined }));
  }

  async size() {
    await this.#load();
    return this.#entries.length;
  }

  /**
   * Apply outcomes: Map<id, "done" | "drop" | "keep">. "done" and "drop"
   * leave the journal; "keep" counts an attempt (dropped after MAX_ATTEMPTS).
   * → { done, dropped, kept }
   */
  async settle(outcomes) {
    await this.#load();
    let done = 0;
    let dropped = 0;
    let kept = 0;
    let changed = false;
    const next = [];
    for (const e of this.#entries) {
      const o = outcomes.get(e.id);
      if (o === "done") {
        done++;
        changed = true;
      } else if (o === "drop") {
        dropped++;
        changed = true;
        this.#log?.warn?.(`Journal : modification locale n° ${e.id} (${e.op}) refusée par le serveur, abandonnée.`);
      } else if (o === "keep") {
        changed = true;
        if (e.attempts + 1 >= MAX_ATTEMPTS) {
          dropped++;
          this.#log?.warn?.(`Journal : modification locale n° ${e.id} (${e.op}) abandonnée après ${MAX_ATTEMPTS} essais.`);
        } else {
          kept++;
          next.push({ ...e, attempts: e.attempts + 1 });
        }
      } else {
        next.push(e);
      }
    }
    if (changed) {
      this.#entries = next;
      await this.#flush();
    }
    return { done, dropped, kept };
  }

  /** Folder paths that waiting folder operations will change (the local folder pass leaves them alone). */
  async pendingFolderPaths() {
    await this.#load();
    const paths = new Set();
    for (const e of this.#entries) {
      if (!FOLDER_OPS.has(e.op)) continue;
      paths.add(e.path);
      if (e.toPath) paths.add(e.toPath);
    }
    return paths;
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
 * handlers (each returns Map<entryId, "done" | "drop" | "keep">; an entry
 * missing from the map stays untouched):
 *   uploads(path, entries, signal)   flags and deletes of one folder
 *   moves(entries, signal)           message moves (MoveItems)
 *   folder(entry, signal)            one folder operation
 *
 * → { sent, dropped, kept }   (sent: entries the server acknowledged)
 */
export async function replayJournal({ journal, handlers, signal = null, log = null }) {
  const entries = await journal.list();
  const total = { sent: 0, dropped: 0, kept: 0 };
  const settle = async (outcomes) => {
    const r = await journal.settle(outcomes);
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
      // A run of uploads, grouped by folder (order kept within each folder).
      const byPath = new Map();
      while (i < entries.length && (entries[i].op === "flags" || entries[i].op === "delete")) {
        const e = entries[i++];
        const list = byPath.get(e.path);
        if (list) list.push(e);
        else byPath.set(e.path, [e]);
      }
      for (const [path, list] of byPath) {
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
