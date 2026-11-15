// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Local changes made in Thunderbird → intents for the journal.
 *
 * Listens to messages.onUpdated / onMoved / onDeleted and
 * folders.onCreated / onRenamed / onMoved / onDeleted, and for each event
 * about a marked account (the list is injected: `isMarked(accountKey)`)
 * produces intents:
 *
 *   { kind: "flags", path, messageId, flags: { read?, flagged? } }
 *   { kind: "move", path, toPath, messageId }
 *   { kind: "delete", path, messageId }
 *   { kind: "folderCreate", path }
 *   { kind: "folderRename" | "folderMove", path, toPath }
 *   { kind: "folderDelete", path }
 *
 * passed to `onIntent(accountKey, intent)`. Echoes of the engine's own
 * writes (sync/echo.mjs) are consumed and dropped; only what remains is a
 * user action.
 *
 * Accounts:
 *  - a message or folder that leaves a marked account for another account
 *    is, for that account, deleted (a move whose destination is unknown is
 *    ignored rather than guessed) (the journal then decides what the
 *    server may do: a message goes to the server's trash; a folder is never
 *    deleted on the server unless it was in the trash);
 *  - what arrives from another account is local only: the server cannot
 *    receive it (ActiveSync has no upload of received mail), so nothing is
 *    produced;
 *  - copies are local only, for the same reason.
 *
 * Events are handled one after the other, in the order they came, even
 * when a long message list has to be read page by page: intents keep the
 * order of the user's actions.
 */

const FLAG_FIELDS = ["read", "flagged"];
const MAX_MESSAGES = 1_000_000; // messages read from one event, at most

export class LocalEvents {
  #browser;
  #echo;
  #isMarked;
  #onIntent;
  #log;
  #queue = Promise.resolve();
  #listeners = [];

  /**
   * @param {object} o
   * @param {object} [o.browser]                          globalThis.browser
   * @param {import("../sync/echo.mjs").EchoRegistry} o.echo
   * @param {(accountKey: string) => boolean} o.isMarked  accounts of this extension
   * @param {(accountKey: string, intent: object) => any} o.onIntent
   * @param {object} [o.log]
   */
  constructor({ browser = globalThis.browser, echo, isMarked, onIntent, log = null }) {
    this.#browser = browser;
    this.#echo = echo;
    this.#isMarked = isMarked;
    this.#onIntent = onIntent;
    this.#log = log;
  }

  start() {
    if (this.#listeners.length) return;
    const m = this.#browser.messages;
    const f = this.#browser.folders;
    this.#on(m.onUpdated, (message, changed) => this.#updated(message, changed));
    this.#on(m.onMoved, (original, moved) => this.#moved(original, moved));
    this.#on(m.onDeleted, (list) => this.#deleted(list));
    this.#on(f.onCreated, (folder) => this.#folderCreated(folder));
    this.#on(f.onRenamed, (original, renamed) => this.#folderChanged("folderRename", original, renamed));
    this.#on(f.onMoved, (original, moved) => this.#folderChanged("folderMove", original, moved));
    this.#on(f.onDeleted, (folder) => this.#folderDeleted(folder));
  }

  stop() {
    for (const [event, fn] of this.#listeners) event.removeListener(fn);
    this.#listeners = [];
  }

  /** Resolves once every event received so far has been handled (for tests and orderly shutdown). */
  idle() {
    return this.#queue;
  }

  #on(event, handler) {
    if (!event?.addListener) return;
    const fn = (...args) => {
      this.#queue = this.#queue.then(() => handler(...args)).catch((e) => {
        this.#log?.warn?.(`Événement local non traité (${String(e?.code ?? e?.name ?? "erreur").slice(0, 60)}).`);
      });
    };
    event.addListener(fn);
    this.#listeners.push([event, fn]);
  }

  #ours(folder) {
    const key = folder?.accountId;
    return typeof key === "string" && typeof folder.path === "string" && this.#isMarked(key) ? key : null;
  }

  async #emit(accountKey, intent) {
    const rest = this.#echo ? this.#echo.consume(accountKey, intent) : intent;
    if (rest) await this.#onIntent(accountKey, rest);
  }

  async #all(list) {
    const out = [];
    let page = list;
    for (;;) {
      for (const m of page?.messages ?? []) {
        if (out.length >= MAX_MESSAGES) return out;
        out.push(m);
      }
      if (!page?.id) return out;
      page = await this.#browser.messages.continueList(page.id);
    }
  }

  async #updated(message, changed) {
    const key = this.#ours(message?.folder);
    if (!key || typeof message.headerMessageId !== "string") return;
    const flags = {};
    for (const f of FLAG_FIELDS) if (typeof changed?.[f] === "boolean") flags[f] = changed[f];
    if (!Object.keys(flags).length) return; // tags, junk, "new": not synchronised
    await this.#emit(key, { kind: "flags", path: message.folder.path, messageId: message.headerMessageId, flags });
  }

  async #moved(originalList, movedList) {
    const originals = await this.#all(originalList);
    const moved = await this.#all(movedList);
    const pairs = [];
    if (originals.length === moved.length) {
      for (let i = 0; i < originals.length; i++) pairs.push([originals[i], moved[i]]);
    } else {
      // Paired by Message-ID, in order, when the lists do not line up.
      const pool = new Map();
      for (const m of moved) {
        const list = pool.get(m?.headerMessageId);
        if (list) list.push(m);
        else pool.set(m?.headerMessageId, [m]);
      }
      for (const o of originals) pairs.push([o, pool.get(o?.headerMessageId)?.shift() ?? null]);
    }
    for (const [o, m] of pairs) {
      const from = this.#ours(o?.folder);
      if (!from || typeof o.headerMessageId !== "string") continue; // from elsewhere: local only
      if (typeof m?.folder?.accountId !== "string" || typeof m.folder.path !== "string") {
        this.#log?.debug?.("Déplacement local sans destination connue : ignoré.");
        continue;
      }
      if (m.folder.accountId === from) {
        if (m.folder.path !== o.folder.path) {
          await this.#emit(from, { kind: "move", path: o.folder.path, toPath: m.folder.path, messageId: o.headerMessageId });
        }
      } else {
        // Left for another account: deleted, for this account.
        await this.#emit(from, { kind: "delete", path: o.folder.path, messageId: o.headerMessageId });
      }
    }
  }

  async #deleted(list) {
    for (const m of await this.#all(list)) {
      const key = this.#ours(m?.folder);
      if (!key || typeof m.headerMessageId !== "string") continue;
      await this.#emit(key, { kind: "delete", path: m.folder.path, messageId: m.headerMessageId });
    }
  }

  async #folderCreated(folder) {
    const key = this.#ours(folder);
    if (!key || folder.isRoot) return;
    await this.#emit(key, { kind: "folderCreate", path: folder.path });
  }

  async #folderChanged(kind, original, changed) {
    const from = this.#ours(original);
    if (!from || original.isRoot) return; // from another account: local only
    if (typeof changed?.accountId !== "string" || typeof changed.path !== "string") {
      this.#log?.debug?.("Changement de dossier local sans destination connue : ignoré.");
      return;
    }
    if (changed.accountId === from) {
      if (changed.path !== original.path) await this.#emit(from, { kind, path: original.path, toPath: changed.path });
    } else {
      await this.#emit(from, { kind: "folderDelete", path: original.path }); // left for another account
    }
  }

  async #folderDeleted(folder) {
    const key = this.#ours(folder);
    if (!key || folder.isRoot) return;
    await this.#emit(key, { kind: "folderDelete", path: folder.path });
  }
}
