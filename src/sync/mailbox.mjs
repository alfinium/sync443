// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Synchronisation of one mailbox: the public entry point of the engine.
 *
 *   const sync = new MailboxSync({ mailbox, store, clientFactory, mailStore, log, now });
 *   await sync.run({ reason: "user" | "timer" | "push" | …, folders, signal, confirmDeletes, round });
 *   sync.startPush(); await sync.stopPush();
 *   await sync.recordIntent(intent);   // a local change, from tb/events.mjs
 *   await sync.close();                // before another engine takes the mailbox over
 *
 * One pass, in this order:
 *   1. FolderSync (folder hierarchy); a hierarchy without an Inbox is
 *      refused;
 *   2. local folders: created, renamed or moved to match the server (paths
 *      from core/folder-tree.mjs), every move planned against every other
 *      so that no two collections ever share a local folder; folders gone
 *      from the server go to the local trash (never deleted), unless their
 *      messages or their number make it a mass deletion, which waits for
 *      the user; a local folder that disappeared is created again and its
 *      collection fully resynchronised;
 *   3. journal: local changes sent to the server, in order, each to the
 *      collection it was made in (by ServerId);
 *   4. collections: server changes applied locally (sync/mail.mjs).
 * Only mail is synchronised in this version: calendar, contacts and tasks
 * folders are ignored even when chosen. The server's Outbox is never
 * synchronised (its local counterpart is Thunderbird's queue of messages to
 * send).
 *
 * Special folders. The server's Inbox, Drafts, Deleted Items and Sent Items
 * always go to the account's default local folders "/Inbox", "/Drafts",
 * "/Trash" and "/Sent" (core/folder-tree.mjs): Thunderbird gives these
 * roles by name at the root of a local account, again at every start, so
 * no other folder can hold them. The engine never changes a folder's role,
 * never renames, moves or deletes a special folder (locally or on the
 * server), and creates a missing default folder under its default name.
 * "/Templates" has no server counterpart: local only. "/Archives", the
 * folder of Thunderbird's Archive action, gets one the first time a message
 * is archived: a server folder "Archives" at the top (created, or the
 * existing one), bound by its ServerId; archiving is then an ordinary move.
 * A move to any other local-only folder never deletes the server copy.
 *
 * Lock. One pass at a time per mailbox. A run() while another is going
 * waits for it; several such calls are merged into one pass. Nothing
 * releases the lock but the end of the pass holding it: cancel() asks the
 * pass to stop (its AbortSignal reaches every request), and the next one
 * starts only once it has really stopped. close() stops everything and
 * flushes the journal: the instance then never writes again.
 *
 * Health (sync/health.mjs). An automatic run (any reason but "user")
 * respects backoff and blocks; a "user" run clears them first. FATAL
 * errors block, others back off; a cancelled pass changes nothing. Retained
 * mass deletions (of messages or of folders) block the mailbox with code
 * MASS_DELETE until the user confirms them (run({ confirmDeletes: true }))
 * or keeps the local copies (discardPendingDeletes()); no pass runs in the
 * meantime.
 * Items whose import keeps failing are counted in health.failedItems.
 */

import { folderSyncRequest, parseFolderSync, folderCreateRequest, folderUpdateRequest, folderDeleteRequest, parseFolderChange, ProtocolError } from "../core/protocol.mjs";
import { applyChanges, buildTree, localPaths, specialFolders, specialUse, compareIds, nameKey, SPECIAL_PATHS, ARCHIVES_PATH, ROOT_ID, FOLDER_TYPE } from "../core/folder-tree.mjs";
import * as v from "../core/sanitize.mjs";
import { EasError, ERR, FATAL } from "../transport/client.mjs";
import { initialHealth, recordSuccess, recordFailure, canSyncAutomatically, clearForUser } from "./health.mjs";
import { Journal, replayJournal, touches } from "./journal.mjs";
import {
  CollectionState, MailPass, loadCollection, saveCollection, removeCollection, storedCollections, collRecord, syncBatch, syncCollection, replayMoves,
  loadPendingDeletes, savePendingDeletes, countPending, dropPendingFor, applyLocalDeletes, settleDeletes, evidenceOf, isMassDelete,
  mergeOutcome, serverError, badResponse, SYNC_ERR,
} from "./mail.mjs";
import { PushLoop } from "./push.mjs";
import { dirname, basename, join, under, rebase } from "./paths.mjs";
import { errorCode } from "../log.mjs";

export const MASS_DELETE = SYNC_ERR.MASS_DELETE;
/** Folders gone from the server in one pass: at least this many… */
const MASS_FOLDER_COUNT = 3;
/** …and at least this share of the mailbox's folders is a mass deletion too. */
const MASS_FOLDER_RATIO = 0.5;
/** Kinds synchronised by this version: mail only (calendar, contacts and tasks folders are ignored even when chosen). */
const KINDS = Object.freeze({ mail: true, calendar: false, contacts: false, tasks: false });
const { TRASH: TRASH_TYPE, INBOX: INBOX_TYPE, OUTBOX: OUTBOX_TYPE, USER_MAIL: USER_MAIL_TYPE } = FOLDER_TYPE;
const ARCHIVES_NAME = "Archives";
/** FolderCreate / FolderUpdate / FolderDelete statuses worth another try ([MS-ASCMD] 2.2.3.177.x). */
const FOLDER_TRANSIENT = new Set(["6", "8", "9", "11"]);


function closedError() {
  return new EasError("CLOSED", "Synchronisation de cette boîte arrêtée.");
}

function parseWith(fn, doc, what) {
  if (!doc) throw badResponse(what);
  try {
    return fn(doc);
  } catch (e) {
    if (e instanceof ProtocolError) throw badResponse(what, e);
    throw e;
  }
}

/** Stored folder map: ServerId → { parentId, name, type }; anything damaged → null (a fresh FolderSync follows). */
function checkFolders(map) {
  const out = new Map();
  for (const [sid, f] of map) {
    if (!v.itemId(sid) || !f || !v.itemId(f.parentId) || typeof f.name !== "string" || !Number.isInteger(f.type)) return null;
    out.set(sid, { parentId: f.parentId, name: f.name, type: f.type });
  }
  return out;
}

/** Stored layout: ServerId → { path, ready } of the synchronised collections. */
function checkLayout(map) {
  const out = new Map();
  for (const [sid, e] of map) if (v.itemId(sid) && typeof e?.path === "string" && e.path.startsWith("/")) out.set(sid, { path: e.path, ready: e.ready === true });
  return out;
}

export class MailboxSync {
  #mailbox;
  #records;
  #clientFactory;
  #mailStore;
  #log;
  #now;
  #sleep;
  #random;
  #pushSettings;
  #journal;
  #lock = Promise.resolve();
  #pending = null; // the merged request waiting for the lock
  #ctrl = null; // AbortController of the pass in progress
  #push = null;
  #stuck = new Map(); // batches that failed as a whole (sync/mail.mjs), across passes
  #paths = null; // local path → ServerId of the synchronised collections (for recordIntent)
  #gate = null; // while the local folders are set (ServerIds may change): recordIntent waits for it
  #run = 0; // current run (journal attempts are counted once per run)
  #closed = false;
  #closing = null;

  /**
   * @param {object} o
   * @param {object} o.mailbox          checked mailbox (store.mjs checkMailbox): id, accountKey, filterType, sync…
   * @param {import("./store.mjs").Store} o.store
   * @param {() => Promise<{command: Function}>} o.clientFactory   an EasClient (or a double), per pass
   * @param {object} o.mailStore        tb/mail-store.mjs for mailbox.accountKey (or a double)
   * @param {object} [o.log]            { info, warn, error, debug, debugEnabled }
   * @param {() => number} [o.now]
   * @param {(ms, signal) => Promise} [o.sleep]   for the Ping loop
   * @param {() => number} [o.random]
   * @param {object} [o.push]           Ping settings (sync/push.mjs PING_DEFAULTS)
   */
  constructor({ mailbox, store, clientFactory, mailStore, log = null, now = () => Date.now(), sleep, random = Math.random, push = {} }) {
    if (!mailbox?.id) throw new TypeError("MailboxSync : boîte manquante");
    this.#mailbox = mailbox;
    this.#records = store.mailbox(mailbox.id);
    this.#clientFactory = clientFactory;
    this.#mailStore = mailStore;
    this.#log = log;
    this.#now = now;
    this.#sleep = sleep;
    this.#random = random;
    this.#pushSettings = push;
    this.#journal = new Journal({ records: this.#records, log, now });
  }

  /** A pass is in progress (tests). */
  get running() {
    return this.#ctrl !== null;
  }

  /** The journal (tests). */
  get journal() {
    return this.#journal;
  }

  /**
   * A local change (tb/events.mjs intent) to send at the next pass. The
   * ServerIds of the collections it was made in are recorded with it.
   * → the journal entry, or null. Rejects with code CLOSED after close().
   */
  async recordIntent(intent) {
    if (this.#closed) throw closedError();
    const extra = {};
    if (intent && (intent.kind === "flags" || intent.kind === "move" || intent.kind === "delete")) {
      while (this.#gate) await this.#gate;
      const paths = await this.#pathIndex();
      const src = paths.get(intent.path);
      if (src) extra.src = src;
      if (intent.kind === "move") {
        const dst = paths.get(intent.toPath);
        if (dst) extra.dst = dst;
      }
    }
    if (this.#closed) throw closedError();
    return this.#journal.append({ ...intent, ...extra });
  }

  /** Local path → ServerId of the synchronised collections, as the last pass left them. */
  async #pathIndex() {
    if (!this.#paths) {
      const layout = checkLayout(await this.#records.getMap("layout"));
      this.#paths = MailboxSync.#index(layout);
    }
    return this.#paths;
  }

  static #index(layout) {
    const out = new Map();
    const shared = new Set();
    for (const [sid, e] of layout) {
      if (out.has(e.path)) shared.add(e.path);
      out.set(e.path, sid);
    }
    for (const p of shared) out.delete(p);
    return out;
  }

  /** Ask the pass in progress to stop. It stops at the next request or item; the lock is released only then. */
  cancel() {
    this.#ctrl?.abort();
  }

  /**
   * Stop for good: the pass in progress is cancelled and awaited, the Ping
   * loop stopped, the journal written out. Once this resolves, the
   * instance never writes to the storage again; run() then resolves at
   * once without a pass, recordIntent() rejects with code CLOSED.
   */
  close() {
    if (!this.#closing) {
      this.#closed = true;
      this.#closing = (async () => {
        this.cancel();
        await this.stopPush().catch(() => {});
        await this.#lock;
        await this.#journal.close();
      })();
    }
    return this.#closing;
  }

  /**
   * One pass (see the module comment).
   * @param {object} [o]
   * @param {string} [o.reason]          "user" for a user action; anything else is automatic
   * @param {string[]|null} [o.folders]  CollectionIds to synchronise in step 4 (null: all)
   * @param {AbortSignal} [o.signal]
   * @param {boolean} [o.confirmDeletes] apply the retained mass deletions
   * @param {number} [o.round]           index of this pass in the caller's run of passes (0: a new run);
   *                                     without it, reason "suite" means a pass of the same run
   * @returns {Promise<{added, changed, deleted, sent, skipped, failed, pendingDeletes, status, reason, moreAvailable}>}
   *   status: "ok" | "skipped" (backoff, blocked, closed) | "blocked" (MASS_DELETE waiting for confirmation).
   *   Throws the error of a failed pass (after recording it in the health), EasError CANCELLED when cancelled.
   */
  run({ reason = "timer", folders = null, signal = null, confirmDeletes = false, round = null } = {}) {
    if (this.#closed) return Promise.resolve({ ...emptyResult(), status: "skipped", reason: "CLOSED" });
    const ids = Array.isArray(folders) ? folders.filter((f) => v.itemId(f)) : null;
    const newRun = Number.isInteger(round) ? round <= 0 : reason !== "suite";
    if (this.#pending) {
      const p = this.#pending.opts;
      if (reason === "user") p.reason = "user";
      p.folders = p.folders === null || ids === null ? null : [...new Set([...p.folders, ...ids])];
      p.confirmDeletes ||= confirmDeletes === true;
      p.newRun ||= newRun;
      if (signal) p.signals.push(signal);
      return this.#pending.promise;
    }
    const pending = { opts: { reason: String(reason), folders: ids, confirmDeletes: confirmDeletes === true, newRun, signals: signal ? [signal] : [] } };
    pending.promise = this.#lock.then(() => {
      if (this.#pending === pending) this.#pending = null;
      return this.#pass(pending.opts);
    });
    this.#pending = pending;
    this.#lock = pending.promise.catch(() => {});
    return pending.promise;
  }

  /** Run fn under the mailbox lock (after the passes already queued). */
  #exclusive(fn) {
    if (this.#closed) return Promise.reject(closedError());
    const p = this.#lock.then(() => {
      if (this.#closed) throw closedError();
      return fn();
    });
    this.#lock = p.catch(() => {});
    return p;
  }

  /** Retained mass deletions: → { count, collections: [{ collectionId, count, at, folder? }] } */
  async pendingDeletes() {
    const map = await loadPendingDeletes(this.#records);
    return {
      count: countPending(map),
      collections: [...map]
        .filter(([, e]) => e.retained)
        .map(([collectionId, e]) => ({ collectionId, count: e.folder ? Math.max(1, e.messages) : e.items.length, at: e.at, ...(e.folder ? { folder: true } : {}) })),
    };
  }

  /**
   * The user refuses the retained deletions: they are forgotten, the local
   * copies kept, and the collections concerned fully resynchronised (their
   * tables rebuilt from what the server really holds). A folder the server
   * removed stays as a local folder, no longer synchronised. Unblocks the
   * mailbox.
   */
  discardPendingDeletes() {
    return this.#exclusive(async () => {
      const records = this.#records;
      const map = await loadPendingDeletes(records);
      const names = await records.names();
      let folders = 0;
      for (const [cid, entry] of map) {
        if (!(await records.get(collRecord(cid), null))) continue;
        if (entry.folder) {
          await removeCollection(records, cid, names);
          folders++;
          continue;
        }
        const coll = await loadCollection(records, cid, names);
        coll.reset({ keepAged: true });
        await saveCollection(records, coll);
      }
      await savePendingDeletes(records, new Map());
      const health = await this.#health();
      if (health.blocked?.code === MASS_DELETE) await records.set("health", { ...health, blocked: null });
      this.#log?.info?.(`Suppressions retenues abandonnées ; ${map.size - folders} dossier(s) entièrement resynchronisé(s) au prochain passage, ${folders} dossier(s) gardé(s) localement.`);
    });
  }

  async #health() {
    return { ...initialHealth(), ...((await this.#records.get("health", null)) ?? {}) };
  }


  // ── A pass ──────────────────────────────────────────────────────────────

  async #pass(opts) {
    if (this.#closed) return { ...emptyResult(), status: "skipped", reason: "CLOSED" };
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    for (const s of opts.signals) {
      if (s.aborted) ctrl.abort();
      else s.addEventListener?.("abort", abort);
    }
    this.#ctrl = ctrl;
    try {
      return await this.#execute(opts, ctrl.signal);
    } finally {
      for (const s of opts.signals) s.removeEventListener?.("abort", abort);
      this.#ctrl = null;
    }
  }

  async #execute(opts, signal) {
    const records = this.#records;
    const result = emptyResult();
    let health = await this.#health();
    const user = opts.reason === "user";
    if (user) health = clearForUser(health);

    // Retained mass deletions: nothing runs until the user decides.
    const pending = await loadPendingDeletes(records);
    const pendingCount = countPending(pending);
    if (!pendingCount && health.blocked?.code === MASS_DELETE) health = { ...health, blocked: null };
    if (pendingCount && !opts.confirmDeletes) {
      health = this.#blockMassDelete(health, pendingCount);
      await records.set("health", health);
      return { ...result, status: "blocked", reason: MASS_DELETE, pendingDeletes: pendingCount };
    }
    if (!user && !(opts.confirmDeletes && pendingCount)) {
      const gate = canSyncAutomatically(health, this.#now());
      if (!gate.ok) {
        await records.set("health", health);
        return { ...result, status: "skipped", reason: gate.reason === "blocked" ? health.blocked?.code ?? "blocked" : "backoff" };
      }
    }
    await records.set("health", health);
    if (!this.#mailbox.sync?.mail) return result; // nothing chosen that this version synchronises
    if (opts.newRun || !this.#run) this.#run++;
    const confirm = Boolean(opts.confirmDeletes && pendingCount);

    try {
      if (signal.aborted) throw new EasError(ERR.CANCELLED, "Synchronisation annulée.");
      if (!this.#mailbox.accountKey) throw new EasError(ERR.CONFIG, "Compte local de la boîte absent.");
      const client = await this.#clientFactory();
      const pass = new MailPass();
      const state = await this.#folderSync(client, signal); // 1
      let open;
      this.#gate = new Promise((resolve) => (open = resolve));
      let layout;
      try {
        layout = await this.#localFolders(state, { confirm }); // 2
        if (state.previous) {
          await this.#saveHierarchy(state);
          state.previous = null;
        }
      } finally {
        this.#gate = null;
        open();
      }
      const ctx = this.#context(client, signal, pass, state, layout);

      if (confirm) {
        const now = await loadPendingDeletes(records); // step 2 may have dropped some (a folder reset, a removal applied)
        let applied = 0;
        for (const [cid, entry] of now) {
          if (!entry.retained || entry.folder) continue;
          const coll = layout.colls.get(cid);
          if (coll && layout.local.has(coll.path)) {
            await applyLocalDeletes(ctx, coll, entry.items);
            coll.window = { since: this.#now(), count: 0, base: coll.size }; // confirmed: the rolling window starts again
            await saveCollection(records, coll);
            applied += entry.items.length;
          }
          now.delete(cid);
        }
        await savePendingDeletes(records, now);
        this.#log?.info?.(`${pendingCount} suppression(s) confirmée(s) par l'utilisateur (${applied} message(s) mis à la corbeille locale).`);
      }

      const replay = await replayJournal({ journal: this.#journal, handlers: this.#handlers(ctx, client, state, layout), signal, log: this.#log, run: this.#run }); // 3
      result.sent = replay.sent;
      for (const st of pass.per.values()) st.ops = null; // what is left of the journal now

      // 4. Collections: the inbox first, the trash last (a message moved on the server comes out of the trash).
      const errors = [];
      for (const coll of this.#syncOrder(state, layout, opts.folders)) {
        if (signal.aborted) throw new EasError(ERR.CANCELLED, "Synchronisation annulée.");
        try {
          await syncCollection(ctx, coll);
        } catch (e) {
          if (signal.aborted || e?.code === ERR.CANCELLED || FATAL.has(e?.code)) throw e;
          errors.push(e);
          this.#log?.warn?.(`Sync ${coll.serverId} : ${describe(e)}`);
        }
      }
      // Server deletions received by an earlier pass for collections not synchronised in this one, once their run is over.
      for (const [cid, entry] of await loadPendingDeletes(records)) {
        const coll = layout.colls.get(cid);
        if (!entry.retained && !entry.folder && coll && layout.syncable.has(cid)) await settleDeletes(ctx, coll);
      }
      await this.#saveLayout(layout);
      Object.assign(result, pass.counts);
      result.failed = [...layout.colls.values()].reduce((n, c) => n + c.failed.size, 0);
      result.moreAvailable = pass.bounded || pass.hierarchyChanged || pass.waiting || [...layout.colls.values()].some((c) => layout.syncable.has(c.serverId) && c.more);
      if (errors.length) throw errors[0];

      health = recordSuccess(this.#now(), { failedItems: result.failed });
      const stillPending = countPending(await loadPendingDeletes(records));
      result.pendingDeletes = stillPending;
      if (stillPending) {
        health = this.#blockMassDelete(health, stillPending);
        result.status = "blocked";
        result.reason = MASS_DELETE;
      }
      await records.set("health", health);
      return result;
    } catch (e) {
      if (signal.aborted || e?.code === ERR.CANCELLED) throw new EasError(ERR.CANCELLED, "Synchronisation annulée.");
      // Errors of Thunderbird's APIs may quote folder names or Message-IDs: only their code goes further.
      const err = e instanceof EasError ? e : new EasError(SYNC_ERR.LOCAL, `Erreur locale (${describe(e)}).`, { cause: e });
      await records.set("health", recordFailure(health, err, this.#now(), { random: this.#random }));
      throw err;
    }
  }

  #blockMassDelete(health, count) {
    return {
      ...health,
      blocked: {
        code: MASS_DELETE,
        message: `${count} suppression(s) demandée(s) par le serveur en une fois : confirmez-les ou gardez les copies locales dans les réglages.`,
        at: this.#now(),
      },
    };
  }

  #context(client, signal, pass, state, layout) {
    return {
      client,
      records: this.#records,
      mailStore: this.#mailStore,
      log: this.#log,
      now: this.#now,
      signal,
      filterType: this.#mailbox.filterType, // a mail period, "0" to "5" (store.mjs checkMailbox)
      trashPath: layout.trashPath,
      serverTrash: (cid) => this.#inServerTrash(state.folders, cid),
      serverTrashId: serverTrashId(state.folders),
      collectionOf: (path) => this.#collectionOf(layout, path),
      journalOps: (coll) => this.#journal.messageOps({ serverId: coll.serverId, path: coll.path }),
      stuck: this.#stuck,
      pass,
    };
  }

  /** The collection is the server's trash (the first Deleted Items folder, as core/folder-tree.mjs decides) or inside it. */
  #inServerTrash(folders, cid) {
    const trashId = serverTrashId(folders);
    let id = cid;
    for (let depth = 0; trashId && id && id !== ROOT_ID && depth < 64; depth++) {
      if (id === trashId) return true;
      const f = folders.get(id);
      if (!f) return false;
      id = f.parentId;
    }
    return false;
  }

  /** The synchronised collection of a local folder path (mail, not the Outbox), or null. */
  #collectionOf(layout, path) {
    for (const coll of layout.colls.values()) if (coll.path === path && layout.syncable.has(coll.serverId)) return coll;
    return null;
  }

  #syncOrder(state, layout, only) {
    const list = [];
    for (const sid of layout.order) {
      const coll = layout.colls.get(sid);
      if (!coll || !layout.syncable.has(sid) || !layout.local.has(coll.path)) continue;
      if (only && !only.includes(sid)) continue;
      list.push(coll);
    }
    const rank = (c) => {
      const type = state.folders.get(c.serverId)?.type;
      return type === INBOX_TYPE ? 0 : this.#inServerTrash(state.folders, c.serverId) ? 2 : 1;
    };
    return list.map((c, i) => [rank(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  }

  /** Where the collections are, for recordIntent (paths) and Ping (ready ones). */
  async #saveLayout(layout) {
    const map = new Map();
    for (const sid of layout.syncable) {
      const coll = layout.colls.get(sid);
      if (coll?.path) map.set(sid, { path: coll.path, ready: coll.syncKey !== "0" });
    }
    this.#paths = MailboxSync.#index(map);
    await this.#records.setMap("layout", map);
  }

  // ── 1. FolderSync ───────────────────────────────────────────────────────

  async #folderSync(client, signal) {
    const records = this.#records;
    let syncKey = v.syncKey((await records.get("hierarchy", null))?.syncKey) ?? "0";
    let folders = checkFolders(await records.getMap("folders"));
    if (!folders) {
      syncKey = "0";
      folders = new Map();
    }
    for (let attempt = 0; ; attempt++) {
      const doc = await client.command("FolderSync", folderSyncRequest(syncKey), { signal });
      const parsed = parseWith(parseFolderSync, doc, "FolderSync");
      if (parsed.status === "9" && syncKey !== "0" && attempt === 0) {
        this.#log?.warn?.("FolderSync : clé refusée, liste des dossiers reprise de zéro.");
        syncKey = "0";
        continue;
      }
      if (parsed.status !== "1") throw serverError("FolderSync", parsed.status);
      if (!parsed.syncKey) throw badResponse("FolderSync");
      if (parsed.rejected) this.#log?.warn?.(`FolderSync : ${parsed.rejected} dossier(s) invalide(s) écarté(s).`);
      const next = applyChanges(syncKey === "0" ? new Map() : folders, parsed.changes);
      // Every mailbox has an Inbox: a hierarchy without one is a server fault (or worse), never applied.
      if (![...next.values()].some((f) => f.type === INBOX_TYPE)) {
        throw new EasError(SYNC_ERR.SERVER, "Liste des dossiers du serveur sans boîte de réception : refusée, rien n'est changé.");
      }
      // The whole list again (a partnership reset may renumber the folders): no ServerId is trusted until the
      // local folder pass has matched the tables again (`previous`: the list before), and the new list is stored
      // only then (#execute), so a pass stopped in between does it all again.
      if (syncKey === "0") return { syncKey: parsed.syncKey, folders: next, previous: folders };
      await records.setMap("folders", next);
      await records.set("hierarchy", { syncKey: parsed.syncKey });
      return { syncKey: parsed.syncKey, folders: next, previous: null };
    }
  }

  // ── 2. Local folders ────────────────────────────────────────────────────

  /**
   * Local folders made to match the server. Every collection ends on a
   * local folder of its own, or none in this pass; no two ever share one.
   * → { colls, local, trashPath, order, syncable, tree, archivesLocal }
   */
  async #localFolders(state, { confirm = false } = {}) {
    const records = this.#records;
    const ms = this.#mailStore;
    const log = this.#log;
    const local = new Map((await ms.listFolders()).map((f) => [f.path, { ...f }]));
    const isSpecialLocal = (p) => Boolean(local.get(p)?.specialUse?.length);

    const tree = buildTree(state.folders, { kinds: KINDS });
    if (tree.rejected?.length) log?.warn?.(`Dossiers : ${tree.rejected.length} dossier(s) écarté(s) (arborescence invalide).`);
    let archivesId = v.itemId((await records.get("archives", null))?.serverId);
    // Unbound when the folder is gone, moved below the top level, or put in the server's trash (deleted on the webmail);
    // after the whole list again (folders perhaps renumbered), also when its id now names a folder of another name.
    const renumbered = (sid) => Boolean(state.previous) && state.previous.get(sid)?.name !== state.folders.get(sid)?.name;
    if (archivesId && (!tree.nodes.has(archivesId) || tree.nodes.get(archivesId).parentId !== ROOT_ID || this.#inServerTrash(state.folders, archivesId) || renumbered(archivesId))) {
      log?.info?.(`Archives : dossier ${archivesId} du serveur supprimé, déplacé ou renuméroté, le dossier d'archives local n'y est plus lié.`);
      archivesId = null;
      await records.remove("archives");
    }
    if (!archivesId) {
      // The server's own "Archives" at the top (an ordinary mail folder, never a special one) is the
      // archives folder from the start: bound to "/Archives", never synchronised beside it as
      // "/Archives (2)". One already synchronised elsewhere (a folder renamed "Archives" on the server)
      // joins "/Archives" below (merge).
      const found = [...tree.nodes]
        .filter(([, n]) => n.parentId === ROOT_ID && n.type === USER_MAIL_TYPE && nameKey(n.name) === nameKey(ARCHIVES_NAME))
        .map(([sid]) => sid)
        .sort(compareIds)[0];
      if (found) {
        archivesId = found;
        await records.set("archives", { serverId: found });
        log?.info?.(`Archives : dossier local lié au dossier ${found} du serveur.`);
      }
    }
    const paths = localPaths(tree, { archives: archivesId });
    const specials = specialFolders(tree);
    const names = await records.names();
    const colls = new Map();
    for (const sid of storedCollections(names)) colls.set(sid, await loadCollection(records, sid, names));
    const busy = await this.#journal.pendingFolderPaths();
    const trashPath = localTrash(local);
    const pending = await loadPendingDeletes(records);
    let pendingChanged = false;
    const dirty = new Set();

    // Local folders by place and name (Thunderbird may store a folder under another name than it shows).
    let children = null;
    const kids = () => {
      if (!children) {
        children = new Map();
        for (const f of local.values()) {
          const parent = dirname(f.path);
          if (!children.has(parent)) children.set(parent, []);
          children.get(parent).push(f);
        }
      }
      return children;
    };
    const touched = () => {
      children = null;
    };
    /** The local folder named `name` in `parent` (exactly), or null. */
    const childNamed = (parent, name) => {
      if (local.has(join(parent, name))) return join(parent, name);
      return kids().get(parent)?.find((f) => (f.name ?? basename(f.path)) === name)?.path ?? null;
    };
    /** A local folder in `parent` whose name equals `name` without regard to case (it takes the place), or null. */
    const childLike = (parent, name) => {
      const exact = childNamed(parent, name);
      if (exact) return exact;
      const key = nameKey(name);
      return kids().get(parent)?.find((f) => nameKey(f.name ?? basename(f.path)) === key)?.path ?? null;
    };
    /** The local folder at a desired path (folder names from the top), or null. */
    const resolve = (desired) => {
      if (desired === "/") return "/";
      if (local.has(desired)) return desired;
      const parent = resolve(dirname(desired));
      return parent === null ? null : childNamed(parent, basename(desired));
    };
    const moved = (from, to, name) => {
      this.#movedLocally(local, from, to);
      if (local.has(to) && name) local.get(to).name = name;
      const rebased = [];
      for (const c of colls.values()) {
        if (!c.path || !under(c.path, from)) continue;
        c.path = rebase(c.path, from, to);
        dirty.add(c);
        rebased.push(c);
      }
      touched();
      return rebased;
    };

    // Present: the mail folders of the tree that get a local folder (never the Outbox).
    const order = [...tree.nodes].sort((a, b) => a[1].depth - b[1].depth || compareIds(a[0], b[0])).map(([sid]) => sid)
      .filter((sid) => paths.has(sid) && tree.nodes.get(sid).type !== OUTBOX_TYPE);
    const want = new Map(order.map((sid) => [sid, paths.get(sid)]));
    // The mailbox before this hierarchy: folders known, and messages in them (for the mass-deletion threshold).
    const known = colls.size;
    const total = [...colls.values()].reduce((n, c) => n + c.size, 0);
    // The whole list again (a partnership reset may renumber the folders): no ServerId is trusted. Every table is
    // matched again, first by place (the local folder a server folder wants, below), then by id.
    const restart = state.previous ? [...colls.values()].filter((c) => state.folders.has(c.serverId)) : [];
    for (const c of restart) colls.delete(c.serverId);
    const fresh = new Set();
    for (const sid of order) {
      if (!colls.has(sid)) {
        colls.set(sid, new CollectionState(sid));
        fresh.add(sid);
      }
    }
    const remap = new Map(); // sid → evidence to rebuild with (its local folder changed)
    const hasFolder = (c) => Boolean(c.path) && local.has(c.path);

    // A removal retained earlier for a folder that is back on the server: nothing to decide any more.
    for (const [cid, entry] of pending) {
      if (entry.folder && state.folders.has(cid)) {
        pending.delete(cid);
        pendingChanged = true;
      }
    }

    // ── Gone from the server ──
    const gone = [...[...colls.values()].filter((c) => !state.folders.has(c.serverId)), ...restart];
    const forgotten = new Set();
    const forget = async (c) => {
      forgotten.add(c);
      await removeCollection(records, c.serverId, names);
      if (colls.get(c.serverId) === c) colls.delete(c.serverId);
      if (pending.delete(c.serverId)) pendingChanged = true;
    };
    // A new collection whose folder is where a gone one's was takes it over (new ServerIds after a device reset).
    // After the whole list again, this is how every table is matched first: by place.
    const adopted = new Set();
    const renamedIds = new Map(); // old ServerId → the new one that took its folder over (null: none, see below)
    for (const g of gone) {
      if (!hasFolder(g) || pending.get(g.serverId)?.retained) continue;
      const taker = order.find((sid) => !hasFolder(colls.get(sid)) && !adopted.has(sid) && resolve(want.get(sid)) === g.path);
      if (!taker) continue;
      if (taker === g.serverId) {
        // The same folder in the same place (whole list again): its table stays as it is.
        colls.set(taker, g);
        fresh.delete(taker);
        continue;
      }
      const c = colls.get(taker);
      c.path = g.path;
      c.window ??= g.window; // the rolling window of server deletions goes on
      remap.set(taker, evidenceOf(g));
      adopted.add(taker);
      renamedIds.set(g.serverId, taker);
      dirty.add(c);
      log?.info?.(`Dossier ${taker} : reprend le dossier local de l'ancien dossier ${g.serverId}.`);
    }
    // Then by id (whole list again): a table not matched by place keeps its id when that server folder took no
    // other table and has the type it had (a rename or a move). Otherwise its id now names another folder: the
    // table goes and its local folder stays, out of the synchronisation (its waiting changes keep only their
    // local folder, so none reaches the other folder).
    for (const g of restart) {
      const sid = g.serverId;
      if (colls.get(sid) === g || renamedIds.has(sid)) continue;
      if (!adopted.has(sid) && state.previous.get(sid)?.type === state.folders.get(sid).type) {
        colls.set(sid, g);
        fresh.delete(sid);
        continue;
      }
      renamedIds.set(sid, null);
      log?.info?.(`Dossier ${sid} : identifiant repris par un autre dossier du serveur, l'ancien dossier local reste hors synchronisation.`);
    }
    if (renamedIds.size) {
      // The waiting changes made in the old folders go to the new ServerIds (all at once: ids may be handed to
      // other folders, even swapped), written before the old tables go. Changes recorded meanwhile wait for the
      // end of this step (recordIntent), so none keeps an old id.
      if (await this.#journal.rebind(renamedIds)) await this.#journal.flush();
      for (const g of gone) if (renamedIds.has(g.serverId)) await forget(g);
    }
    const left = gone.filter((g) => !forgotten.has(g) && !state.folders.has(g.serverId));
    // Retained earlier and confirmed now: applied. Retained and not confirmed: kept as it is (the pass is blocked anyway).
    const decided = [];
    const fresher = [];
    for (const g of left) {
      const entry = pending.get(g.serverId);
      if (entry?.folder) {
        if (confirm) decided.push(g);
      } else {
        fresher.push(g);
      }
    }
    // New removals: a mass deletion (messages, or most folders at once) waits for the user.
    const withFolder = fresher.filter((g) => hasFolder(g) && !isSpecialLocal(g.path) && !touches(g.path, busy));
    // What would go to the trash: the messages in those local folders (and their local-only subfolders),
    // not the tables, which a server can empty first (a full resync that brings nothing back).
    const localCount = new Map();
    const countIn = async (p) => {
      try {
        return (await ms.listMessages(p)).length;
      } catch {
        return 0;
      }
    };
    for (const g of withFolder) localCount.set(g.serverId, Math.max(g.size, await countIn(g.path)));
    const goneTops = withFolder.map((g) => g.path);
    for (const p of local.keys()) {
      if (goneTops.includes(p) || !goneTops.some((t) => under(p, t)) || withFolder.some((g) => g.path === p)) continue;
      const top = withFolder.find((g) => under(p, g.path));
      localCount.set(top.serverId, localCount.get(top.serverId) + (await countIn(p)));
    }
    const messages = withFolder.reduce((n, g) => n + localCount.get(g.serverId), 0);
    const massive = isMassDelete(messages, total) || (withFolder.length >= MASS_FOLDER_COUNT && withFolder.length >= MASS_FOLDER_RATIO * known);
    if (massive && withFolder.length) {
      for (const g of withFolder) {
        pending.set(g.serverId, { items: [], at: this.#now(), retained: true, base: total, folder: { path: g.path }, messages: localCount.get(g.serverId) });
      }
      pendingChanged = true;
      log?.warn?.(`${withFolder.length} dossier(s) supprimé(s) sur le serveur (${messages} message(s)) : suppression retenue jusqu'à confirmation.`);
      for (const g of fresher) if (!withFolder.includes(g)) await forget(g);
    } else {
      decided.push(...fresher);
    }
    // Applied: the local folder goes to the local trash; inside the trash it stays (never deleted because of the server).
    const decidedPaths = decided.filter(hasFolder).map((g) => g.path);
    for (const g of decided) {
      const p = g.path;
      const topmost = hasFolder(g) && !decidedPaths.some((q) => q !== p && under(p, q));
      if (topmost && !isSpecialLocal(p) && !touches(p, busy)) {
        if (trashPath && under(p, trashPath)) {
          log?.info?.(`Dossier ${g.serverId} supprimé sur le serveur : copie locale laissée dans la corbeille locale.`);
        } else if (trashPath) {
          try {
            const to = await ms.moveFolder(p, trashPath);
            moved(p, to);
            log?.info?.(`Dossier ${g.serverId} supprimé sur le serveur : copie locale mise à la corbeille.`);
          } catch (e) {
            log?.warn?.(`Dossier ${g.serverId} supprimé sur le serveur : copie locale laissée en place (${errorCode(e)}).`);
          }
        }
      }
      await forget(g);
    }
    if (pendingChanged) await savePendingDeletes(records, pending);

    // ── Present on the server: each collection on its own local folder ──
    // A folder renamed to a temporary name ("Sync443 n", recorded before the rename) by a pass that stopped in a
    // cycle of renames: its collection takes it again, rebuilt with its own table as evidence (what is missing comes
    // back). Only names recorded so: never a folder of the user's that happens to have such a name.
    const renaming = await records.getMap("renaming");
    for (const [sid, temp] of renaming) {
      const c = colls.get(sid);
      if (!c || !want.has(sid) || hasFolder(c) || typeof temp !== "string" || !local.has(temp)) continue;
      if ([...colls.values()].some((x) => x !== c && x.path === temp)) continue;
      log?.info?.(`Dossier ${sid} : retrouvé sous son nom temporaire, reprise du renommage.`);
      c.path = temp;
      remap.set(sid, remap.get(sid) ?? null);
      dirty.add(c);
    }
    if (renaming.size) await records.remove("renaming");

    const owner = new Map(); // local path → ServerId holding it
    // Folders the journal changes first (a local creation, rename or move not sent yet): left as they are.
    const frozen = new Set(order.filter((sid) => touches(want.get(sid), busy) || (colls.get(sid).path && touches(colls.get(sid).path, busy))));
    for (const sid of order) {
      const c = colls.get(sid);
      if (frozen.has(sid)) {
        if (hasFolder(c) && !owner.has(c.path)) owner.set(c.path, sid);
        continue;
      }
      if (!hasFolder(c)) {
        if (c.path) dirty.add(c);
        if (c.path && !fresh.has(sid)) remap.set(sid, remap.get(sid) ?? null); // its folder is gone: rebuilt where it lands
        c.path = null;
        continue;
      }
      const other = owner.get(c.path);
      if (other === undefined) {
        owner.set(c.path, sid);
        continue;
      }
      // Two collections on one local folder (only a damaged record can say so): the one it is meant for keeps it.
      const keep = resolve(want.get(sid)) === c.path ? sid : other;
      const lose = keep === sid ? other : sid;
      log?.warn?.(`Dossiers ${other} et ${sid} sur un même dossier local : le dossier ${lose} en reçoit un autre.`);
      owner.set(c.path, keep);
      colls.get(lose).path = null;
      remap.set(lose, null);
      dirty.add(colls.get(lose));
    }
    for (const [cid, entry] of pending) if (entry.folder && colls.get(cid)?.path && local.has(colls.get(cid).path)) owner.set(colls.get(cid).path, cid);

    const movable = (sid) => {
      const c = colls.get(sid);
      return hasFolder(c) && !isSpecialLocal(c.path) && !specials.has(sid) && !touches(c.path, busy);
    };
    const take = (sid, path) => {
      const c = colls.get(sid);
      if (c.path && c.path !== path && hasFolder(c)) log?.info?.(`Dossier ${sid} : son ancien dossier local reste en place, hors synchronisation.`);
      if (c.path && owner.get(c.path) === sid) owner.delete(c.path);
      if (c.path !== path && !fresh.has(sid) && !adopted.has(sid)) remap.set(sid, remap.get(sid) ?? null);
      c.path = path;
      owner.set(path, sid);
      dirty.add(c);
    };
    const relocate = async (sid, parent, name) => {
      const c = colls.get(sid);
      const from = c.path;
      const rebased = new Set();
      const keep = async () => {
        // Written at once: a pass that stops in the middle of a cycle of renames finds every folder again.
        for (const x of rebased) if (!fresh.has(x.serverId)) await saveCollection(records, x);
      };
      try {
        let at = from;
        if (dirname(at) !== parent) {
          const to = await ms.moveFolder(at, parent);
          for (const x of moved(at, to)) rebased.add(x);
          at = to;
        }
        if ((local.get(at)?.name ?? basename(at)) !== name) {
          const to = await ms.renameFolder(at, name);
          for (const x of moved(at, to, name)) rebased.add(x);
          at = to;
        }
        for (const [p, o] of [...owner]) {
          if (!under(p, from)) continue;
          owner.delete(p);
          owner.set(rebase(p, from, at), o);
        }
        await keep();
        return true;
      } catch (e) {
        log?.warn?.(`Dossier ${sid} : déplacement local impossible (${errorCode(e)}).`);
        return false;
      }
    };

    // The archives collection synchronised elsewhere until now (a folder renamed "Archives" on the server): its
    // messages join the local archives folder (moved, not downloaded again), the table stays, the emptied folder
    // goes to the local trash.
    const emptied = new Set();
    const merge = async (sid, from, to) => {
      try {
        const ids = (await ms.listMessages(from)).map((m) => m.id);
        for (let i = 0; i < ids.length; i += 500) {
          const r = await ms.moveMessages(ids.slice(i, i + 500), to);
          if (r?.skipped?.length) return false; // some stayed: rebuilt there instead (take)
        }
      } catch (e) {
        log?.warn?.(`Dossier ${sid} : messages non regroupés (${errorCode(e)}).`);
        return false;
      }
      const c = colls.get(sid);
      if (owner.get(from) === sid) owner.delete(from);
      c.path = to;
      owner.set(to, sid);
      dirty.add(c);
      emptied.add(from);
      log?.info?.(`Dossier ${sid} : ses messages rejoignent son dossier local, sans nouveau téléchargement.`);
      return true;
    };

    const placed = new Set();
    let temp = 0;
    for (let round = 0; round < order.length * 3 + 8 && placed.size < order.length; round++) {
      let progress = false;
      const stalled = [];
      for (const sid of order) {
        if (placed.has(sid)) continue;
        const c = colls.get(sid);
        const desired = want.get(sid);
        const cur = hasFolder(c) ? c.path : null;
        if (frozen.has(sid)) {
          // The journal changes it first: left where it is (a new collection may take a free folder already there).
          const at = resolve(desired);
          if (!c.path && at && !owner.has(at)) take(sid, at);
          placed.add(sid);
          continue;
        }
        const target = resolve(desired);
        if (cur && target === cur) {
          placed.add(sid);
          continue;
        }
        const parent = resolve(dirname(desired));
        if (parent === null) continue; // its parent is not there yet
        const occupant = target ?? childLike(parent, basename(desired));
        if (occupant && occupant !== cur) {
          const o = owner.get(occupant);
          if (o === undefined) {
            if (sid === archivesId && cur && movable(sid) && isSpecialLocal(occupant) && (await merge(sid, cur, occupant))) {
              progress = true;
            } else if (!cur || isSpecialLocal(occupant) || !movable(sid)) {
              // A local folder no collection holds, in its place: taken (its table is rebuilt there).
              take(sid, occupant);
              progress = true;
            } else {
              log?.warn?.(`Dossier ${sid} : le dossier local garde son nom (place occupée).`);
            }
            placed.add(sid);
          } else {
            stalled.push([sid, o]);
          }
          continue;
        }
        if (cur && movable(sid)) {
          // Renamed or moved on the server: the local folder follows, with its messages.
          if (await relocate(sid, parent, basename(desired))) progress = true;
          placed.add(sid);
          continue;
        }
        if (cur && cur === ARCHIVES_PATH && sid !== archivesId && !specials.has(sid)) {
          // The local archives folder, no longer bound to this server folder (moved or deleted there): it gets a
          // folder of its own where the server has it; "/Archives" stays as it is, local.
          log?.info?.(`Dossier ${sid} : n'est plus le dossier d'archives, il reçoit son propre dossier local.`);
          owner.delete(cur);
          c.path = null;
          remap.set(sid, remap.get(sid) ?? null);
          dirty.add(c);
          progress = true;
          continue;
        }
        if (cur) {
          placed.add(sid); // cannot move (a special folder): stays, unless another needs its place (below)
          continue;
        }
        // No local folder yet: created (a special folder too: Thunderbird gives the role to these names at the root).
        try {
          const path = await ms.createFolder(parent, basename(desired));
          local.set(path, { path, name: basename(desired), specialUse: [] });
          touched();
          take(sid, path);
          progress = true;
        } catch (e) {
          log?.warn?.(`Dossier ${sid} : création locale impossible (${errorCode(e)}).`);
        }
        placed.add(sid);
      }
      if (progress) continue;
      // Nothing moved: free a place someone waits for.
      let freed = false;
      for (const [sid, o] of stalled) {
        if (o === sid || !want.has(o)) continue;
        const oc = colls.get(o);
        if (!placed.has(o) && movable(o)) {
          // A cycle of renames: the holder steps aside under a temporary name.
          const parent = dirname(oc.path);
          let name;
          do name = `Sync443 ${++temp}`;
          while (childLike(parent, name));
          // Recorded first: a pass stopped right after the rename still knows whose folder it is.
          await records.setMap("renaming", new Map([[o, join(parent, name)]]));
          if (await relocate(o, parent, name)) freed = true;
          await records.remove("renaming");
        } else if (hasFolder(oc) && isSpecialLocal(oc.path) && resolve(want.get(o)) !== oc.path && !touches(oc.path, busy)) {
          // A special local folder cannot move: its collection gives it up and gets a folder of its own.
          log?.info?.(`Dossier ${o} : son dossier local revient au dossier ${sid}.`);
          owner.delete(oc.path);
          oc.path = null;
          remap.set(o, remap.get(o) ?? null);
          dirty.add(oc);
          placed.delete(o);
          freed = true;
        }
        if (freed) break;
      }
      if (!freed) break;
    }
    for (const sid of order) {
      if (placed.has(sid)) continue;
      const c = colls.get(sid);
      if (hasFolder(c)) log?.warn?.(`Dossier ${sid} : le dossier local garde son nom (place occupée).`);
      else log?.warn?.(`Dossier ${sid} : pas de dossier local dans ce passage (place occupée).`);
    }
    for (const p of emptied) {
      const inside = [...local.keys()].some((q) => q !== p && under(q, p));
      if (!local.has(p) || owner.has(p) || inside || !trashPath || under(p, trashPath) || touches(p, busy)) continue;
      try {
        if ((await ms.listMessages(p)).length) continue;
        const to = await ms.moveFolder(p, trashPath);
        moved(p, to);
      } catch (e) {
        log?.warn?.(`Dossier local vidé laissé en place (${errorCode(e)}).`);
      }
    }

    // Collections whose local folder changed: rebuilt (their retained deletions would act on other copies).
    const syncable = new Set(order.filter((sid) => hasFolder(colls.get(sid))));
    for (const [sid, evidence] of remap) {
      const c = colls.get(sid);
      if (!c || (fresh.has(sid) && !evidence)) continue;
      if (c.syncKey !== "0" || evidence) {
        // A new collection taking a gone one's folder over gets that table as its evidence (and keeps its window).
        if (hasFolder(c) && !fresh.has(sid)) log?.info?.(`Dossier ${sid} : dossier local changé ou recréé, resynchronisation complète.`);
        c.reset({ prior: evidence });
        dirty.add(c);
      }
    }
    if (remap.size) await dropPendingFor(records, [...remap.keys()]);
    // Never two collections on one folder: any left are not synchronised.
    const holders = new Map();
    for (const sid of syncable) {
      const p = colls.get(sid).path;
      holders.set(p, [...(holders.get(p) ?? []), sid]);
    }
    for (const [, list] of holders) {
      if (list.length < 2) continue;
      log?.error?.(`Dossiers ${list.join(", ")} sur un même dossier local : non synchronisés.`);
      for (const sid of list) syncable.delete(sid);
    }
    for (const c of dirty) if (colls.has(c.serverId) && (c.path || !fresh.has(c.serverId))) await saveCollection(records, c);

    const archivesLocal = [...local.values()].find((f) => f.specialUse?.includes("archives"))?.path ?? (local.has(ARCHIVES_PATH) ? ARCHIVES_PATH : null);
    const layout = { colls, local, trashPath: localTrash(local), order, syncable, tree, archivesLocal };
    await this.#saveLayout(layout);
    return layout;
  }

  #movedLocally(local, from, to) {
    for (const p of [...local.keys()]) {
      if (!under(p, from)) continue;
      const f = local.get(p);
      local.delete(p);
      const np = rebase(p, from, to);
      local.set(np, { ...f, path: np });
    }
  }

  /** Move and/or rename a local folder from `from` to the path `to`. → the path it ends at. */
  async #relocate(from, to) {
    let at = from;
    if (dirname(from) !== dirname(to)) at = await this.#mailStore.moveFolder(from, dirname(to));
    if (basename(at) !== basename(to)) at = await this.#mailStore.renameFolder(at, basename(to));
    return at;
  }

  // ── 3. Journal ──────────────────────────────────────────────────────────

  #handlers(ctx, client, state, layout) {
    const all = (entries, o) => new Map(entries.map((e) => [e.id, o]));
    /** The collection an entry was made in: by its ServerId, else by path. → coll, "gone" (not on the server) or "wait". */
    const sourceOf = (e) => {
      const src = e.src ?? null;
      if (src) {
        if (!state.folders.has(src)) return "gone";
        return layout.syncable.has(src) ? layout.colls.get(src) : "wait";
      }
      return this.#collectionOf(layout, e.path) ?? "gone";
    };
    const onServer = (sid) => (state.folders.has(sid) && state.folders.get(sid).type !== OUTBOX_TYPE && layout.colls.get(sid)) || null;
    const destinationOf = (e) => {
      if (e.dst) return onServer(e.dst);
      const c = [...layout.colls.values()].find((x) => x.path === e.toPath && onServer(x.serverId));
      return c ?? null;
    };
    return {
      uploads: async (path, entries) => {
        const src = sourceOf(entries[0]);
        if (src === "gone") return all(entries, "done"); // not a synchronised folder (or gone from the server): nothing to send
        if (src === "wait") {
          ctx.pass.waiting = true;
          return all(entries, "keep");
        }
        return (await syncBatch(ctx, src, { uploads: entries })).outcomes;
      },
      moves: async (entries, signal) => {
        const outcomes = new Map();
        const ready = [];
        for (const e of entries) {
          const src = sourceOf(e);
          if (src === "wait") outcomes.set(e.id, "keep");
          else ready.push(e);
        }
        // Archiving: the archives folder gets its server folder the first time a message goes there. The
        // collection returned is the move's destination, wherever its local folder is for now.
        const archived = new Map();
        if (layout.archivesLocal && ready.some((e) => !destinationOf(e) && under(e.toPath, layout.archivesLocal) && sourceOf(e) !== "gone")) {
          for (const e of ready) {
            if (destinationOf(e) || !under(e.toPath, layout.archivesLocal)) continue;
            const c = await this.#ensureServerFolder(client, signal, state, layout, e.toPath);
            if (c) archived.set(e.id, c);
          }
        }
        const r = await replayMoves(ctx, ready, (p, e) => {
          const s = sourceOf(e);
          return typeof s === "string" ? null : s;
        }, (p, e) => archived.get(e.id) ?? destinationOf(e));
        for (const [id, o] of r.outcomes) mergeOutcome(outcomes, id, o);
        return outcomes;
      },
      folder: async (entry, signal) => new Map([[entry.id, await this.#folderOp(client, signal, state, layout, entry)]]),
    };
  }

  async #saveHierarchy(state, syncKey) {
    if (syncKey) state.syncKey = syncKey;
    await this.#records.setMap("folders", state.folders);
    await this.#records.set("hierarchy", { syncKey: state.syncKey });
  }

  /** Collections at `path` or below it get their new path. */
  async #rebaseColls(layout, from, to) {
    for (const coll of layout.colls.values()) {
      if (!coll.path || !under(coll.path, from)) continue;
      coll.path = rebase(coll.path, from, to);
      await saveCollection(this.#records, coll);
    }
    this.#movedLocally(layout.local, from, to);
    await this.#saveLayout(layout);
  }

  async #forgetFolder(state, layout, sid) {
    const doomed = new Set([sid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, f] of state.folders) {
        if (!doomed.has(id) && doomed.has(f.parentId)) {
          doomed.add(id);
          grew = true;
        }
      }
    }
    const names = await this.#records.names();
    for (const id of doomed) {
      state.folders.delete(id);
      layout.colls.delete(id);
      layout.syncable.delete(id);
      await removeCollection(this.#records, id, names);
    }
    await dropPendingFor(this.#records, doomed);
    await this.#saveLayout(layout);
  }

  /** Undo a local rename or move the server refused: the server's name and place are the truth. */
  async #revert(entry) {
    try {
      if (!(await this.#mailStore.folderExists(entry.toPath)) || (await this.#mailStore.folderExists(entry.path))) return;
      await this.#relocate(entry.toPath, entry.path);
      this.#log?.info?.(`Journal n° ${entry.id} : modification du dossier annulée localement.`);
    } catch (e) {
      this.#log?.warn?.(`Journal n° ${entry.id} : annulation locale impossible (${errorCode(e)}).`);
    }
  }

  /** Name of a local folder as Thunderbird shows it (its path may hold another, hashed one). */
  async #localName(layout, path) {
    const known = layout.local.get(path)?.name;
    if (typeof known === "string" && known) return known;
    const f = (await this.#mailStore.listFolders()).find((x) => x.path === path);
    return typeof f?.name === "string" && f.name ? f.name : basename(path);
  }

  /** FolderCreate of a user folder; the collection is set up locally. → "done" | "drop" | "keep" (and the ServerId when done). */
  async #createOnServer(client, signal, state, layout, { path, parentId, name, id }) {
    const command = async (cmd, root) => parseWith(parseFolderChange, await client.command(cmd, root, { signal }), cmd);
    let req;
    try {
      req = folderCreateRequest(state.syncKey, parentId, name, USER_MAIL_TYPE);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      this.#log?.warn?.(`${id ? `Journal n° ${id}` : "Dossier"} : nom de dossier refusé, dossier gardé localement.`);
      return { outcome: "drop" };
    }
    const r = await command("FolderCreate", req);
    if (r.status !== "1" || !r.serverId) return { outcome: FOLDER_TRANSIENT.has(r.status) ? "keep" : "drop", status: r.status };
    state.folders.set(r.serverId, { parentId, name, type: USER_MAIL_TYPE });
    await this.#saveHierarchy(state, r.syncKey);
    const coll = new CollectionState(r.serverId, { path });
    layout.colls.set(r.serverId, coll);
    layout.syncable.add(r.serverId);
    if (!layout.order.includes(r.serverId)) layout.order.push(r.serverId);
    if (!layout.local.has(path) && (await this.#mailStore.folderExists(path))) layout.local.set(path, { path, name, specialUse: [] });
    await saveCollection(this.#records, coll);
    await this.#saveLayout(layout);
    return { outcome: "done", serverId: r.serverId };
  }

  /**
   * The local archives folder (and the subfolder `path` of it) gets a
   * server folder: "Archives" at the top, created or found, bound by its
   * ServerId; subfolders created under it. → the collection, or null.
   */
  async #ensureServerFolder(client, signal, state, layout, path) {
    const collAt = (p) => [...layout.colls.values()].find((c) => c.path === p && state.folders.has(c.serverId) && layout.syncable.has(c.serverId)) ?? null;
    const base = layout.archivesLocal;
    if (!base || !under(path, base)) return null;
    const existing = collAt(path);
    if (existing) return existing;
    if (path !== base) {
      const parent = await this.#ensureServerFolder(client, signal, state, layout, dirname(path));
      if (!parent || !(layout.local.has(path) || (await this.#mailStore.folderExists(path)))) return null;
      const r = await this.#createOnServer(client, signal, state, layout, { path, parentId: parent.serverId, name: await this.#localName(layout, path) });
      return r.outcome === "done" ? layout.colls.get(r.serverId) : null;
    }
    // The archives folder itself: the existing top-level "Archives" (one no collection holds first), or a new one.
    // One synchronised elsewhere ("/Archives (2)") comes to the archives folder at the next pass.
    const existing2 = [...state.folders]
      .filter(([, f]) => f.parentId === ROOT_ID && f.type === USER_MAIL_TYPE && nameKey(f.name) === nameKey(ARCHIVES_NAME))
      .map(([sid]) => sid)
      .sort((a, b) => Number(layout.syncable.has(a)) - Number(layout.syncable.has(b)) || compareIds(a, b));
    let serverId = existing2[0] ?? null;
    if (!serverId) {
      const r = await this.#createOnServer(client, signal, state, layout, { path: base, parentId: ROOT_ID, name: ARCHIVES_NAME });
      if (r.outcome !== "done") {
        this.#log?.warn?.(`Archives : dossier du serveur non créé (Status ${r.status ?? "absent"}).`);
        return null;
      }
      serverId = r.serverId;
    } else if (!layout.syncable.has(serverId)) {
      const coll = layout.colls.get(serverId) ?? new CollectionState(serverId);
      coll.reset({ prior: evidenceOf(coll) });
      coll.path = base;
      layout.colls.set(serverId, coll);
      layout.syncable.add(serverId);
      if (!layout.order.includes(serverId)) layout.order.push(serverId);
      await saveCollection(this.#records, coll);
      await this.#saveLayout(layout);
    }
    await this.#records.set("archives", { serverId });
    this.#log?.info?.(`Archives : dossier local lié au dossier ${serverId} du serveur.`);
    return layout.colls.get(serverId);
  }

  /** One folder operation of the journal. → "done" | "drop" | "keep" */
  async #folderOp(client, signal, state, layout, entry) {
    const log = this.#log;
    const collAt = (p) => [...layout.colls.values()].find((c) => c.path === p && state.folders.has(c.serverId)) ?? null;
    const command = async (cmd, root) => parseWith(parseFolderChange, await client.command(cmd, root, { signal }), cmd);
    const settleStatus = (status, what) => {
      if (FOLDER_TRANSIENT.has(status)) return "keep";
      log?.warn?.(`Journal n° ${entry.id} : ${what} refusé par le serveur (Status ${status ?? "absent"}).`);
      return "drop";
    };
    const build = (fn) => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof ProtocolError) return null;
        throw e;
      }
    };

    switch (entry.op) {
      case "folderCreate": {
        if (collAt(entry.path)) return "done";
        const parentPath = dirname(entry.path);
        let parent = parentPath === "/" ? null : collAt(parentPath);
        if (parentPath !== "/" && !parent && layout.archivesLocal && under(parentPath, layout.archivesLocal)) {
          parent = await this.#ensureServerFolder(client, signal, state, layout, parentPath);
        }
        if (parentPath !== "/" && !parent) {
          log?.info?.(`Journal n° ${entry.id} : dossier parent non synchronisé, dossier gardé localement.`);
          return "drop";
        }
        // The name the user gave, as Thunderbird shows it (never a stored file name).
        const name = await this.#localName(layout, entry.path);
        const r = await this.#createOnServer(client, signal, state, layout, { path: entry.path, parentId: parent ? parent.serverId : ROOT_ID, name, id: entry.id });
        if (r.outcome === "drop" && r.status !== undefined) return settleStatus(r.status, "création de dossier");
        return r.outcome;
      }
      case "folderRename":
      case "folderMove": {
        const coll = collAt(entry.path);
        if (!coll) return "done"; // not on the server (or already done)
        const folder = state.folders.get(coll.serverId);
        if (specialUse(folder.type) !== null) {
          log?.warn?.(`Journal n° ${entry.id} : un dossier spécial ne se renomme ni ne se déplace.`);
          await this.#revert(entry);
          return "drop";
        }
        let parentId = folder.parentId;
        if (entry.op === "folderMove" || dirname(entry.toPath) !== dirname(entry.path)) {
          const np = dirname(entry.toPath);
          const parent = np === "/" ? null : collAt(np);
          if (np !== "/" && !parent) {
            log?.warn?.(`Journal n° ${entry.id} : destination non synchronisée.`);
            await this.#revert(entry);
            return "drop";
          }
          parentId = parent ? parent.serverId : ROOT_ID;
        }
        // A move keeps the server's name (never the local one, which may carry " (2)" or "_");
        // a rename sends the name the user typed, as Thunderbird shows it.
        const name = entry.op === "folderMove" ? folder.name : await this.#localName(layout, entry.toPath);
        const req = build(() => folderUpdateRequest(state.syncKey, coll.serverId, parentId, name));
        if (!req) {
          log?.warn?.(`Journal n° ${entry.id} : nom de dossier refusé.`);
          await this.#revert(entry);
          return "drop";
        }
        const r = await command("FolderUpdate", req);
        if (r.status !== "1") {
          const o = settleStatus(r.status, entry.op === "folderMove" ? "déplacement de dossier" : "renommage de dossier");
          if (o === "drop") await this.#revert(entry);
          return o;
        }
        state.folders.set(coll.serverId, { ...folder, parentId, name });
        await this.#saveHierarchy(state, r.syncKey);
        await this.#rebaseColls(layout, entry.path, entry.toPath);
        return "done";
      }
      case "folderDelete": {
        const coll = collAt(entry.path);
        if (!coll) return "done";
        const folder = state.folders.get(coll.serverId);
        const inTrash = Boolean(layout.trashPath) && entry.path !== layout.trashPath && under(entry.path, layout.trashPath)
          && this.#inServerTrash(state.folders, folder.parentId);
        if (specialUse(folder.type) !== null || !inTrash) {
          // Never on the server: the folder comes back locally at the next pass, fully resynchronised.
          log?.warn?.(`Journal n° ${entry.id} : suppression de dossier refusée (seulement depuis la corbeille, jamais un dossier spécial).`);
          return "drop";
        }
        const req = build(() => folderDeleteRequest(state.syncKey, coll.serverId));
        if (!req) return "drop";
        const r = await command("FolderDelete", req);
        if (r.status === "1" || r.status === "4") {
          await this.#forgetFolder(state, layout, coll.serverId);
          await this.#saveHierarchy(state, r.syncKey);
          return "done";
        }
        return settleStatus(r.status, "suppression de dossier");
      }
      default:
        return "drop";
    }
  }

  // ── Push ────────────────────────────────────────────────────────────────

  /** Start the Ping loop (idempotent). Changes reported by the server start passes (reason "push"). */
  startPush() {
    if (this.#closed || this.#push?.running) return;
    this.#push = new PushLoop({
      clientFactory: this.#clientFactory,
      folders: () => this.#pingFolders(),
      onChanges: (ids) => this.run({ reason: "push", folders: ids }),
      canPing: async () => {
        if (this.#closed || !this.#mailbox.sync?.mail) return { ok: false, stop: true };
        const health = await this.#health();
        if (health.blocked) return { ok: false, stop: true };
        if (countPending(await loadPendingDeletes(this.#records))) return { ok: false, stop: true };
        const gate = canSyncAutomatically(health, this.#now());
        return gate.ok ? { ok: true } : { ok: false, until: gate.until };
      },
      onFatal: (e) =>
        this.#exclusive(async () => {
          await this.#records.set("health", recordFailure(await this.#health(), e, this.#now(), { random: this.#random }));
        }).catch(() => {}),
      log: this.#log,
      now: this.#now,
      sleep: this.#sleep,
      random: this.#random,
      settings: this.#pushSettings,
    });
    this.#push.start();
  }

  /** Stop the Ping loop; resolves once it has stopped. */
  async stopPush() {
    const p = this.#push;
    this.#push = null;
    await p?.stop();
  }

  /** The Ping loop runs (tests). */
  get pushing() {
    return Boolean(this.#push?.running);
  }

  /** Collections to watch: mail of the chosen kinds, synchronised, not the Outbox. */
  async #pingFolders() {
    if (!this.#mailbox.sync?.mail) return [];
    const folders = checkFolders(await this.#records.getMap("folders"));
    if (!folders) return [];
    const tree = buildTree(folders, { kinds: KINDS });
    const layout = checkLayout(await this.#records.getMap("layout"));
    const out = [];
    for (const [sid, node] of tree.nodes) {
      if (node.type === OUTBOX_TYPE) continue;
      if (layout.get(sid)?.ready) out.push(sid);
    }
    return out;
  }
}

function emptyResult() {
  return { added: 0, changed: 0, deleted: 0, sent: 0, skipped: 0, failed: 0, pendingDeletes: 0, status: "ok", reason: null, moreAvailable: false };
}

/** What a log line may say about an error: our own messages, or only the code of anyone else's. */
function describe(e) {
  if (e instanceof EasError) return String(e.message).slice(0, 300);
  return errorCode(e, 60);
}

/**
 * The local trash: the account's default "/Trash" (Thunderbird gives the
 * role to that name at the root of a local account, again at every start),
 * else the folder flagged as trash.
 */
function localTrash(local) {
  const fixed = SPECIAL_PATHS.get("trash");
  if (local.has(fixed)) return fixed;
  return [...local.values()].find((f) => f.specialUse?.includes("trash"))?.path ?? null;
}

/** ServerId of the server's trash: the first Deleted Items folder in ServerId order, or null. */
function serverTrashId(folders) {
  let best = null;
  for (const [id, f] of folders) if (f.type === TRASH_TYPE && (best === null || compareIds(id, best) < 0)) best = id;
  return best;
}
