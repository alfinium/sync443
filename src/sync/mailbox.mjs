// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Synchronisation of one mailbox: the public entry point of the engine.
 *
 *   const sync = new MailboxSync({ mailbox, store, clientFactory, mailStore, log, now });
 *   await sync.run({ reason: "user" | "timer" | "push" | …, folders, signal, confirmDeletes });
 *   sync.startPush(); await sync.stopPush();
 *   await sync.recordIntent(intent);   // a local change, from tb/events.mjs
 *
 * One pass, in this order:
 *   1. FolderSync (folder hierarchy);
 *   2. local folders: created, renamed or moved to match the server (paths
 *      from core/folder-tree.mjs); folders gone from the server go to the
 *      local trash; a local folder that disappeared is created again and
 *      its collection fully resynchronised;
 *   3. journal: local changes sent to the server, in order;
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
 * "/Templates" and "/Archives" have no server counterpart: local only.
 *
 * Lock. One pass at a time per mailbox. A run() while another is going
 * waits for it; several such calls are merged into one pass. Nothing
 * releases the lock but the end of the pass holding it: cancel() asks the
 * pass to stop (its AbortSignal reaches every request), and the next one
 * starts only once it has really stopped.
 *
 * Health (sync/health.mjs). An automatic run (any reason but "user")
 * respects backoff and blocks; a "user" run clears them first. FATAL
 * errors block, others back off; a cancelled pass changes nothing. Retained
 * mass deletions block the mailbox with code MASS_DELETE until the user
 * confirms them (run({ confirmDeletes: true })) or discards them
 * (discardPendingDeletes()); no pass runs in the meantime.
 */

import { folderSyncRequest, parseFolderSync, folderCreateRequest, folderUpdateRequest, folderDeleteRequest, parseFolderChange, ProtocolError } from "../core/protocol.mjs";
import { MAIL_FILTER_TYPES } from "../core/mail-codec.mjs";
import { applyChanges, buildTree, localPaths, specialFolders, specialUse, compareIds, SPECIAL_PATHS } from "../core/folder-tree.mjs";
import * as v from "../core/sanitize.mjs";
import { EasError, ERR, FATAL } from "../transport/client.mjs";
import { initialHealth, recordSuccess, recordFailure, canSyncAutomatically, clearForUser } from "./health.mjs";
import { Journal, replayJournal, touches } from "./journal.mjs";
import {
  CollectionState, MailPass, loadCollection, saveCollection, collRecord, syncBatch, syncCollection, replayMoves,
  loadPendingDeletes, savePendingDeletes, countPending, applyLocalDeletes, settleDeletes, mergeOutcome, serverError, SYNC_ERR,
} from "./mail.mjs";
import { PushLoop } from "./push.mjs";

export const MASS_DELETE = SYNC_ERR.MASS_DELETE;
/** Kinds synchronised by this version: mail only (calendar, contacts and tasks folders are ignored even when chosen). */
const KINDS = Object.freeze({ mail: true, calendar: false, contacts: false, tasks: false });
const TRASH_TYPE = 4;
const INBOX_TYPE = 2;
const OUTBOX_TYPE = 6;
const ROOT_ID = "0";
/** FolderCreate / FolderUpdate / FolderDelete statuses worth another try ([MS-ASCMD] 2.2.3.177.x). */
const FOLDER_TRANSIENT = new Set(["6", "8", "9", "11"]);

const dirname = (p) => {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const under = (path, root) => path === root || path.startsWith(`${root}/`);
const rebase = (path, from, to) => (path === from ? to : `${to}${path.slice(from.length)}`);

function badResponse(what, e) {
  return new EasError(ERR.BAD_RESPONSE, `${what} : réponse invalide du serveur${e?.message ? ` (${e.message})` : ""}.`);
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

  get mailboxId() {
    return this.#mailbox.id;
  }

  /** A pass is in progress. */
  get running() {
    return this.#ctrl !== null;
  }

  get journal() {
    return this.#journal;
  }

  /** A local change (tb/events.mjs intent) to send at the next pass. → the journal entry, or null. */
  recordIntent(intent) {
    return this.#journal.append(intent);
  }

  /** Ask the pass in progress to stop. It stops at the next request or item; the lock is released only then. */
  cancel() {
    this.#ctrl?.abort();
  }

  /**
   * One pass (see the module comment).
   * @param {object} [o]
   * @param {string} [o.reason]          "user" for a user action; anything else is automatic
   * @param {string[]|null} [o.folders]  CollectionIds to synchronise in step 4 (null: all)
   * @param {AbortSignal} [o.signal]
   * @param {boolean} [o.confirmDeletes] apply the retained mass deletions
   * @returns {Promise<{added, changed, deleted, sent, skipped, pendingDeletes, status, reason, moreAvailable}>}
   *   status: "ok" | "skipped" (backoff, blocked) | "blocked" (MASS_DELETE waiting for confirmation).
   *   Throws the error of a failed pass (after recording it in the health), EasError CANCELLED when cancelled.
   */
  run({ reason = "timer", folders = null, signal = null, confirmDeletes = false } = {}) {
    const ids = Array.isArray(folders) ? folders.filter((f) => v.itemId(f)) : null;
    if (this.#pending) {
      const p = this.#pending.opts;
      if (reason === "user") p.reason = "user";
      p.folders = p.folders === null || ids === null ? null : [...new Set([...p.folders, ...ids])];
      p.confirmDeletes ||= confirmDeletes === true;
      if (signal) p.signals.push(signal);
      return this.#pending.promise;
    }
    const pending = { opts: { reason: String(reason), folders: ids, confirmDeletes: confirmDeletes === true, signals: signal ? [signal] : [] } };
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
    const p = this.#lock.then(fn);
    this.#lock = p.catch(() => {});
    return p;
  }

  /** Retained mass deletions: → { count, collections: [{ collectionId, count, at }] } */
  async pendingDeletes() {
    const map = await loadPendingDeletes(this.#records);
    return {
      count: countPending(map),
      collections: [...map].filter(([, e]) => e.retained).map(([collectionId, e]) => ({ collectionId, count: e.items.length, at: e.at })),
    };
  }

  /**
   * The user refuses the retained deletions: they are forgotten, the local
   * copies kept, and the collections concerned fully resynchronised (their
   * tables rebuilt from what the server really holds). Unblocks the mailbox.
   */
  discardPendingDeletes() {
    return this.#exclusive(async () => {
      const map = await loadPendingDeletes(this.#records);
      for (const cid of map.keys()) {
        if (!(await this.#records.get(collRecord(cid), null))) continue;
        const coll = await loadCollection(this.#records, cid);
        coll.reset();
        await saveCollection(this.#records, coll);
      }
      await savePendingDeletes(this.#records, new Map());
      const health = await this.#health();
      if (health.blocked?.code === MASS_DELETE) await this.#records.set("health", { ...health, blocked: null });
      this.#log?.info?.(`Suppressions retenues abandonnées ; ${map.size} dossier(s) entièrement resynchronisé(s) au prochain passage.`);
    });
  }

  async #health() {
    return { ...initialHealth(), ...((await this.#records.get("health", null)) ?? {}) };
  }

  // ── A pass ──────────────────────────────────────────────────────────────

  async #pass(opts) {
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
    const result = { added: 0, changed: 0, deleted: 0, sent: 0, skipped: 0, pendingDeletes: 0, status: "ok", reason: null, moreAvailable: false };
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

    try {
      if (signal.aborted) throw new EasError(ERR.CANCELLED, "Synchronisation annulée.");
      if (!this.#mailbox.accountKey) throw new EasError(ERR.CONFIG, "Compte local de la boîte absent.");
      const client = await this.#clientFactory();
      const pass = new MailPass();
      const state = await this.#folderSync(client, signal); // 1
      const layout = await this.#localFolders(state); // 2
      const ctx = this.#context(client, signal, pass, state, layout);

      if (opts.confirmDeletes && pendingCount) {
        const now = await loadPendingDeletes(records);
        for (const [cid, entry] of pending) {
          if (!entry.retained) continue;
          const coll = layout.colls.get(cid);
          if (coll && layout.local.has(coll.path)) await applyLocalDeletes(ctx, coll, entry.items);
          now.delete(cid);
        }
        await savePendingDeletes(records, now);
        this.#log?.info?.(`${pendingCount} suppression(s) confirmée(s) par l'utilisateur.`);
      }

      const replay = await replayJournal({ journal: this.#journal, handlers: this.#handlers(ctx, client, state, layout), signal, log: this.#log }); // 3
      result.sent = replay.sent;

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
      // Server deletions received in this pass (or left by an interrupted one) for collections not synchronised above.
      for (const [cid, entry] of await loadPendingDeletes(records)) {
        const coll = layout.colls.get(cid);
        if (!entry.retained && coll && layout.syncable.has(cid)) await settleDeletes(ctx, coll);
      }
      Object.assign(result, pass.counts);
      result.moreAvailable = pass.bounded || pass.hierarchyChanged;
      if (errors.length) throw errors[0];

      health = recordSuccess(health, this.#now());
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
        message: `${count} suppression(s) demandée(s) par le serveur en une fois : confirmez-les ou annulez-les dans les réglages.`,
        at: this.#now(),
      },
    };
  }

  #context(client, signal, pass, state, layout) {
    const ft = String(this.#mailbox.filterType ?? "0");
    return {
      client,
      records: this.#records,
      mailStore: this.#mailStore,
      log: this.#log,
      now: this.#now,
      signal,
      filterType: MAIL_FILTER_TYPES.includes(ft) ? ft : "0", // 3 and 6 months exist for calendars only: all mail then
      trashPath: layout.trashPath,
      serverTrash: (cid) => this.#inServerTrash(state.folders, cid),
      collectionOf: (path) => this.#collectionOf(layout, path),
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
      folders = applyChanges(syncKey === "0" ? new Map() : folders, parsed.changes);
      await records.setMap("folders", folders);
      await records.set("hierarchy", { syncKey: parsed.syncKey });
      return { syncKey: parsed.syncKey, folders };
    }
  }

  // ── 2. Local folders ────────────────────────────────────────────────────

  async #localFolders(state) {
    const records = this.#records;
    const ms = this.#mailStore;
    const log = this.#log;
    const localList = await ms.listFolders();
    const local = new Map(localList.map((f) => [f.path, f]));
    const isSpecialLocal = (p) => Boolean(local.get(p)?.specialUse?.length);

    const tree = buildTree(state.folders, { kinds: KINDS });
    if (tree.rejected?.length) log?.warn?.(`Dossiers : ${tree.rejected.length} dossier(s) écarté(s) (arborescence invalide).`);
    const paths = localPaths(tree);
    const specials = specialFolders(tree);

    // Collections known so far.
    const colls = new Map();
    for (const name of await records.names()) {
      if (!name.startsWith("coll:")) continue;
      let sid;
      try {
        sid = decodeURIComponent(name.slice(5));
      } catch {
        continue;
      }
      if (v.itemId(sid)) colls.set(sid, await loadCollection(records, sid));
    }
    const busy = await this.#journal.pendingFolderPaths();
    const trashPath = localTrash(local);

    // Gone from the server: the local folder goes to the local trash (in the trash: deleted), the table is forgotten.
    const gone = [...colls.values()].filter((c) => !state.folders.has(c.serverId));
    const gonePaths = gone.map((c) => c.path).filter(Boolean);
    let pendingDeletes = null;
    for (const coll of gone) {
      const p = coll.path;
      const topmost = p && !gonePaths.some((q) => q !== p && under(p, q));
      if (topmost && local.has(p) && !isSpecialLocal(p) && !touches(p, busy)) {
        try {
          if (trashPath && under(p, trashPath)) {
            if (p !== trashPath) await ms.deleteFolder(p);
          } else if (trashPath) {
            const moved = await ms.moveFolder(p, trashPath);
            this.#movedLocally(local, p, moved);
          }
          log?.info?.(`Dossier ${coll.serverId} supprimé sur le serveur : copie locale mise à la corbeille.`);
        } catch (e) {
          log?.warn?.(`Dossier ${coll.serverId} supprimé sur le serveur : copie locale laissée en place (${e?.code ?? e?.name ?? "erreur"}).`);
        }
      }
      await records.remove(collRecord(coll.serverId));
      colls.delete(coll.serverId);
      pendingDeletes ??= await loadPendingDeletes(records);
      pendingDeletes.delete(coll.serverId);
    }
    if (pendingDeletes) await savePendingDeletes(records, pendingDeletes);

    // Present on the server: the local folder at its place (never the Outbox).
    const order = [...tree.nodes].sort((a, b) => a[1].depth - b[1].depth).map(([sid]) => sid);
    const syncable = new Set();
    for (const sid of order) {
      const node = tree.nodes.get(sid);
      const desired = paths.get(sid);
      if (!desired || node.type === OUTBOX_TYPE) continue;
      let coll = colls.get(sid);
      const fresh = !coll;
      if (fresh) {
        coll = new CollectionState(sid, { path: desired });
        colls.set(sid, coll);
      }
      syncable.add(sid);
      const current = coll.path ?? desired;
      if (touches(current, busy) || touches(desired, busy)) continue; // the journal changes it first
      const special = specials.has(sid);
      let path = current;
      let remapped = false;
      if (current !== desired) {
        if (local.has(current) && !local.has(desired) && !special && !isSpecialLocal(current)) {
          // Renamed or moved on the server: the local folder follows, with its messages.
          try {
            path = await this.#relocate(current, desired);
            this.#movedLocally(local, current, path);
            for (const other of colls.values()) {
              if (other === coll || !other.path || !under(other.path, current)) continue;
              other.path = rebase(other.path, current, path);
              await saveCollection(records, other);
            }
          } catch (e) {
            log?.warn?.(`Dossier ${sid} : déplacement local impossible (${e?.code ?? e?.name ?? "erreur"}).`);
          }
        } else if (local.has(desired) || !local.has(current)) {
          // Mapped to another local folder (special folders changed, the old one gone): its table is rebuilt.
          path = desired;
          remapped = !fresh;
        } else {
          log?.warn?.(`Dossier ${sid} : le dossier local garde son nom (place occupée).`);
        }
      }
      if (!local.has(path)) {
        // Created (a special folder too: Thunderbird gives the role to these names at the root of a local account).
        const parent = dirname(path);
        if (parent !== "/" && !local.has(parent)) {
          syncable.delete(sid);
          continue;
        }
        try {
          path = await this.#mailStore.createFolder(parent, basename(path));
          local.set(path, { path, name: basename(path), specialUse: [] });
        } catch (e) {
          log?.warn?.(`Dossier ${sid} : création locale impossible (${e?.code ?? e?.name ?? "erreur"}).`);
          syncable.delete(sid);
          continue;
        }
        remapped = !fresh; // the local copies are gone with the folder
      }
      let dirty = fresh || coll.path !== path;
      coll.path = path;
      if (remapped && coll.syncKey !== "0") {
        log?.info?.(`Dossier ${sid} : dossier local changé ou recréé, resynchronisation complète.`);
        coll.reset();
        dirty = true;
      }
      if (dirty) await saveCollection(records, coll);
    }
    // Collections whose local folder is not there (yet) are not synchronised in this pass.
    for (const sid of [...syncable]) {
      const coll = colls.get(sid);
      if (!coll?.path || !local.has(coll.path)) syncable.delete(sid);
    }
    // The local trash: by its flag; else the folder the server's trash maps to.
    return { colls, local, trashPath: localTrash(local), order, syncable, tree };
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

  /** Move and/or rename a local folder from `from` to `to`. → the path it ends at. */
  async #relocate(from, to) {
    let at = from;
    if (dirname(from) !== dirname(to)) at = await this.#mailStore.moveFolder(from, dirname(to));
    if (basename(at) !== basename(to)) at = await this.#mailStore.renameFolder(at, basename(to));
    return at;
  }

  // ── 3. Journal ──────────────────────────────────────────────────────────

  #handlers(ctx, client, state, layout) {
    const uploads = async (path, entries, signal) => {
      const coll = this.#collectionOf(layout, path);
      if (!coll) return new Map(entries.map((e) => [e.id, "done"])); // not a synchronised folder: nothing to send
      const r = await syncBatch(ctx, coll, { uploads: entries });
      return r.outcomes;
    };
    return {
      uploads,
      moves: async (entries, signal) => {
        const r = await replayMoves(
          ctx,
          entries,
          (p) => this.#collectionOf(layout, p),
          (p) => [...layout.colls.values()].find((c) => c.path === p && state.folders.has(c.serverId) && state.folders.get(c.serverId).type !== OUTBOX_TYPE) ?? null,
        );
        const outcomes = r.outcomes;
        // Moved out of the synchronised folders: a deletion on the server (to its trash, DeletesAsMoves).
        for (const e of r.unmapped) {
          const o = await uploads(e.path, [{ ...e, op: "delete" }], signal);
          for (const [id, x] of o) mergeOutcome(outcomes, id, x);
        }
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
    for (const id of doomed) {
      state.folders.delete(id);
      layout.colls.delete(id);
      layout.syncable.delete(id);
      await this.#records.remove(collRecord(id));
    }
    const pending = await loadPendingDeletes(this.#records);
    let changed = false;
    for (const id of doomed) changed = pending.delete(id) || changed;
    if (changed) await savePendingDeletes(this.#records, pending);
  }

  /** Undo a local rename or move the server refused: the server's name and place are the truth. */
  async #revert(entry) {
    try {
      if (!(await this.#mailStore.folderExists(entry.toPath)) || (await this.#mailStore.folderExists(entry.path))) return;
      await this.#relocate(entry.toPath, entry.path);
      this.#log?.info?.(`Journal n° ${entry.id} : modification du dossier annulée localement.`);
    } catch (e) {
      this.#log?.warn?.(`Journal n° ${entry.id} : annulation locale impossible (${e?.code ?? e?.name ?? "erreur"}).`);
    }
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
        const parent = parentPath === "/" ? null : collAt(parentPath);
        if (parentPath !== "/" && !parent) {
          log?.info?.(`Journal n° ${entry.id} : dossier parent non synchronisé, dossier gardé localement.`);
          return "drop";
        }
        const parentId = parent ? parent.serverId : ROOT_ID;
        const name = basename(entry.path);
        const req = build(() => folderCreateRequest(state.syncKey, parentId, name, 12));
        if (!req) {
          log?.warn?.(`Journal n° ${entry.id} : nom de dossier refusé, dossier gardé localement.`);
          return "drop";
        }
        const r = await command("FolderCreate", req);
        if (r.status !== "1" || !r.serverId) return settleStatus(r.status, "création de dossier");
        state.folders.set(r.serverId, { parentId, name, type: 12 });
        await this.#saveHierarchy(state, r.syncKey);
        const coll = new CollectionState(r.serverId, { path: entry.path });
        layout.colls.set(r.serverId, coll);
        layout.syncable.add(r.serverId);
        if (!layout.order.includes(r.serverId)) layout.order.push(r.serverId);
        if (!layout.local.has(entry.path) && (await this.#mailStore.folderExists(entry.path))) {
          layout.local.set(entry.path, { path: entry.path, name, specialUse: [] });
        }
        await saveCollection(this.#records, coll);
        return "done";
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
        const name = basename(entry.toPath);
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
    if (this.#push?.running) return;
    this.#push = new PushLoop({
      clientFactory: this.#clientFactory,
      folders: () => this.#pingFolders(),
      onChanges: (ids) => this.run({ reason: "push", folders: ids }),
      canPing: async () => {
        if (!this.#mailbox.sync?.mail) return { ok: false, stop: true };
        const health = await this.#health();
        if (health.blocked) return { ok: false, stop: true };
        if (countPending(await loadPendingDeletes(this.#records))) return { ok: false, stop: true };
        const gate = canSyncAutomatically(health, this.#now());
        return gate.ok ? { ok: true } : { ok: false, until: gate.until };
      },
      onFatal: (e) =>
        this.#exclusive(async () => {
          await this.#records.set("health", recordFailure(await this.#health(), e, this.#now(), { random: this.#random }));
        }),
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

  get pushing() {
    return Boolean(this.#push?.running);
  }

  /** Collections to watch: mail of the chosen kinds, synchronised, not the Outbox. */
  async #pingFolders() {
    if (!this.#mailbox.sync?.mail) return [];
    const folders = checkFolders(await this.#records.getMap("folders"));
    if (!folders) return [];
    const tree = buildTree(folders, { kinds: KINDS });
    const out = [];
    for (const [sid, node] of tree.nodes) {
      if (node.type === OUTBOX_TYPE) continue;
      const coll = await loadCollection(this.#records, sid);
      if (coll.path && coll.syncKey !== "0") out.push(sid);
    }
    return out;
  }
}

/** What a log line may say about an error: our own messages, or only the code of anyone else's. */
function describe(e) {
  if (e instanceof EasError) return String(e.message).slice(0, 300);
  return String(e?.code ?? e?.name ?? "erreur").slice(0, 60);
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
