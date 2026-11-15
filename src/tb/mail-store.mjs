// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Folders and messages of ONE Thunderbird account, addressed by folder
 * path (WebExtension APIs of Thunderbird 128 and later, Manifest V2:
 * browser.folders, browser.messages). The only module of the mail engine
 * that touches Thunderbird; the engine is tested with a double of it.
 *
 *   folderExists(path) → boolean
 *   listFolders() → [{ path, name, specialUse: string[] }]   (root excluded)
 *   createFolder(parentPath, name) → path
 *   renameFolder(path, newName) → path
 *   moveFolder(path, destParentPath) → path
 *   deleteFolder(path)                                       (inside the trash only: permanent)
 *   findByMessageId(path, messageId) → [{ id, flags: { read, flagged } }]
 *   listMessages(path) → [{ id, messageId, flags }]
 *   importMessage(path, bytes, flags) → { id }               (60 s at most)
 *   setFlags(id, flags, expected?) → boolean                 (true if something changed)
 *   moveMessages(ids, path, expected?) → { moved, skipped }
 *   deleteMessages(ids, { permanent, expected? }) → { deleted, skipped }
 *
 * Message ids are Thunderbird's, valid for this session only; the engine
 * never stores them. `expected` ({ path, messageId }) guards a write made
 * with an id read a moment earlier: a message that is no longer there (the
 * user moved it meanwhile) is skipped, not touched by mistake.
 *
 * The account is checked on every operation: nothing outside it is read
 * or written. Special folders are never renamed, moved or deleted, and a
 * permanent deletion happens only inside the account's trash.
 *
 * Every write declares its echo to sync/echo.mjs before it is made (the
 * event may fire before the API call returns), and retracts it if the call
 * fails. Only writes that produce an event declare one: a flag that does
 * not change is not written at all. An import produces no event that
 * tb/events.mjs listens to.
 */

export const IMPORT_TIMEOUT_MS = 60_000;
const MAX_LIST = 1_000_000; // messages listed in one folder, at most

export class MailStoreError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "MailStoreError";
    this.code = code;
  }
}

const join = (parent, name) => (parent === "/" ? `/${name}` : `${parent}/${name}`);
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const under = (path, root) => path === root || path.startsWith(`${root}/`);
const validPath = (p) => typeof p === "string" && p.startsWith("/") && p.length <= 2048;
const validName = (n) => typeof n === "string" && n.length > 0 && n.length <= 255 && !n.includes("/") && !/[\u0000-\u001f\u007f]/.test(n);

function defaultTimers() {
  return {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (id) => {
      if (typeof clearTimeout === "function") clearTimeout(id);
    },
  };
}

export class MailStore {
  #browser;
  #accountKey;
  #echo;
  #timers;
  #makeFile;
  #importTimeoutMs;

  /**
   * @param {object} o
   * @param {string} o.accountKey      Thunderbird account of the mailbox ("account7")
   * @param {import("../sync/echo.mjs").EchoRegistry} o.echo
   * @param {object} [o.browser]       the WebExtension API (globalThis.browser)
   * @param {{set, clear}} [o.timers]
   * @param {(bytes: Uint8Array) => object} [o.makeFile]   bytes → File for messages.import
   * @param {number} [o.importTimeoutMs]
   */
  constructor({ accountKey, echo, browser = globalThis.browser, timers = defaultTimers(), makeFile, importTimeoutMs = IMPORT_TIMEOUT_MS }) {
    if (typeof accountKey !== "string" || !/^account\d{1,6}$/.test(accountKey)) throw new MailStoreError("CONFIG", "compte invalide");
    if (!browser?.folders || !browser?.messages) throw new MailStoreError("CONFIG", "API de Thunderbird indisponibles");
    this.#browser = browser;
    this.#accountKey = accountKey;
    this.#echo = echo;
    this.#timers = timers;
    this.#makeFile = makeFile ?? ((bytes) => new File([bytes], "message.eml", { type: "message/rfc822" }));
    this.#importTimeoutMs = importTimeoutMs;
  }

  get accountKey() {
    return this.#accountKey;
  }

  // ── Folders ─────────────────────────────────────────────────────────────

  /** The MailFolder at `path` in this account, or null. */
  async #find(path) {
    if (!validPath(path)) return null;
    const query = path === "/" ? { accountId: this.#accountKey, isRoot: true } : { accountId: this.#accountKey, path };
    const list = await this.#browser.folders.query(query);
    const f = (list ?? []).find((x) => x?.accountId === this.#accountKey && x.path === path);
    return f ?? null;
  }

  async #folder(path) {
    const f = await this.#find(path);
    if (!f) throw new MailStoreError("NOT_FOUND", "dossier introuvable");
    return f;
  }

  #special(f) {
    return Array.isArray(f.specialUse) && f.specialUse.length > 0;
  }

  async #trashPath() {
    const list = await this.#browser.folders.query({ accountId: this.#accountKey, specialUse: ["trash"] });
    const f = (list ?? []).find((x) => x?.accountId === this.#accountKey && x.specialUse?.includes("trash"));
    return f?.path ?? null;
  }

  async folderExists(path) {
    return (await this.#find(path)) !== null;
  }

  async listFolders() {
    const list = await this.#browser.folders.query({ accountId: this.#accountKey });
    return (list ?? [])
      .filter((f) => f?.accountId === this.#accountKey && !f.isRoot && validPath(f.path) && f.path !== "/")
      .map((f) => ({ path: f.path, name: String(f.name ?? basename(f.path)), specialUse: Array.isArray(f.specialUse) ? [...f.specialUse] : [] }));
  }

  /** Run a write whose echo is `intent`: declared first, retracted if the write fails. */
  async #withEcho(intents, write) {
    const tokens = intents.map((i) => this.#echo?.expect(this.#accountKey, i));
    try {
      return await write();
    } catch (e) {
      for (const t of tokens) this.#echo?.retract(t);
      throw e;
    }
  }

  async createFolder(parentPath, name) {
    if (!validName(name)) throw new MailStoreError("REFUSED", "nom de dossier invalide");
    const parent = await this.#folder(parentPath);
    const path = join(parentPath, name);
    const created = await this.#withEcho([{ kind: "folderCreate", path }], () => this.#browser.folders.create(parent.id, name));
    return validPath(created?.path) ? created.path : path;
  }

  async renameFolder(path, newName) {
    if (!validName(newName)) throw new MailStoreError("REFUSED", "nom de dossier invalide");
    const f = await this.#folder(path);
    if (this.#special(f) || f.isRoot) throw new MailStoreError("REFUSED", "dossier spécial");
    const toPath = join(path.slice(0, path.lastIndexOf("/")) || "/", newName);
    const renamed = await this.#withEcho([{ kind: "folderRename", path, toPath }], () => this.#browser.folders.rename(f.id, newName));
    return validPath(renamed?.path) ? renamed.path : toPath;
  }

  async moveFolder(path, destParentPath) {
    const f = await this.#folder(path);
    if (this.#special(f) || f.isRoot) throw new MailStoreError("REFUSED", "dossier spécial");
    if (under(destParentPath, path)) throw new MailStoreError("REFUSED", "dossier déplacé dans lui-même");
    const dest = await this.#folder(destParentPath);
    const toPath = join(destParentPath, basename(path));
    const moved = await this.#withEcho([{ kind: "folderMove", path, toPath }], () => this.#browser.folders.move(f.id, dest.id));
    return validPath(moved?.path) ? moved.path : toPath;
  }

  /** Permanent deletion of a folder inside the trash (Thunderbird's folders.delete moves to the trash anywhere else). */
  async deleteFolder(path) {
    const f = await this.#folder(path);
    const trash = await this.#trashPath();
    if (this.#special(f) || f.isRoot || !trash || path === trash || !under(path, trash)) {
      throw new MailStoreError("REFUSED", "suppression de dossier hors de la corbeille");
    }
    await this.#withEcho([{ kind: "folderDelete", path }], () => this.#browser.folders.delete(f.id));
  }

  // ── Messages ────────────────────────────────────────────────────────────

  /** Every message of a MessageList, following its pages. */
  async *#pages(first) {
    let list = first;
    let n = 0;
    for (;;) {
      for (const m of list?.messages ?? []) {
        if (++n > MAX_LIST) throw new MailStoreError("LIMIT", "trop de messages");
        yield m;
      }
      if (!list?.id) return;
      list = await this.#browser.messages.continueList(list.id);
    }
  }

  #mine(m) {
    return m?.folder?.accountId === this.#accountKey && validPath(m.folder.path);
  }

  async findByMessageId(path, messageId) {
    if (typeof messageId !== "string" || !messageId) return [];
    const f = await this.#folder(path);
    const out = [];
    const first = await this.#browser.messages.query({ folderId: f.id, headerMessageId: messageId, includeSubFolders: false });
    for await (const m of this.#pages(first)) {
      if (this.#mine(m) && m.folder.path === path && m.headerMessageId === messageId) {
        out.push({ id: m.id, flags: { read: Boolean(m.read), flagged: Boolean(m.flagged) } });
      }
    }
    return out;
  }

  async listMessages(path) {
    const f = await this.#folder(path);
    const out = [];
    for await (const m of this.#pages(await this.#browser.messages.list(f.id))) {
      if (this.#mine(m) && m.folder.path === path && typeof m.headerMessageId === "string") {
        out.push({ id: m.id, messageId: m.headerMessageId, flags: { read: Boolean(m.read), flagged: Boolean(m.flagged) } });
      }
    }
    return out;
  }

  async importMessage(path, bytes, flags = {}) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new MailStoreError("REFUSED", "message vide");
    const f = await this.#folder(path);
    const properties = { read: flags.read === true, flagged: flags.flagged === true, new: false };
    const file = this.#makeFile(bytes);
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = this.#timers.set(() => reject(new MailStoreError("TIMEOUT", `import non terminé après ${Math.round(this.#importTimeoutMs / 1000)} s`)), this.#importTimeoutMs);
    });
    try {
      const header = await Promise.race([this.#browser.messages.import(file, f.id, properties), timeout]);
      if (!Number.isInteger(header?.id)) throw new MailStoreError("FAILED", "import sans message");
      return { id: header.id };
    } finally {
      this.#timers.clear(timer);
    }
  }

  /** The message `id`, if it is still in this account (and where `expected` says). */
  async #message(id, expected) {
    let m;
    try {
      m = await this.#browser.messages.get(id);
    } catch {
      return null; // gone
    }
    if (!this.#mine(m)) return null;
    if (expected && (m.folder.path !== expected.path || m.headerMessageId !== expected.messageId)) return null;
    return m;
  }

  async setFlags(id, flags, expected = null) {
    const m = await this.#message(id, expected);
    if (!m) return false;
    const diff = {};
    for (const k of ["read", "flagged"]) if (typeof flags?.[k] === "boolean" && Boolean(m[k]) !== flags[k]) diff[k] = flags[k];
    if (!Object.keys(diff).length) return false;
    await this.#withEcho([{ kind: "flags", path: m.folder.path, messageId: m.headerMessageId, flags: diff }], () => this.#browser.messages.update(id, diff));
    return true;
  }

  async moveMessages(ids, path, expected = null) {
    const dest = await this.#folder(path);
    const moved = [];
    const skipped = [];
    const intents = [];
    for (const id of ids) {
      const m = await this.#message(id, expected);
      if (!m || m.folder.path === path) {
        skipped.push(id);
        continue;
      }
      moved.push(id);
      intents.push({ kind: "move", path: m.folder.path, toPath: path, messageId: m.headerMessageId });
    }
    if (moved.length) await this.#withEcho(intents, () => this.#browser.messages.move(moved, dest.id, { isUserAction: false }));
    return { moved, skipped };
  }

  /**
   * Not permanent: a move to the account's trash. Permanent: only for
   * messages inside the trash (any other is skipped).
   */
  async deleteMessages(ids, { permanent = false, expected = null } = {}) {
    if (!permanent) {
      const trash = await this.#trashPath();
      if (!trash) throw new MailStoreError("NOT_FOUND", "pas de corbeille");
      const r = await this.moveMessages(ids, trash, expected);
      return { deleted: r.moved, skipped: r.skipped };
    }
    const trash = await this.#trashPath();
    const deleted = [];
    const skipped = [];
    const intents = [];
    for (const id of ids) {
      const m = await this.#message(id, expected);
      if (!m || !trash || !under(m.folder.path, trash)) {
        skipped.push(id);
        continue;
      }
      deleted.push(id);
      intents.push({ kind: "delete", path: m.folder.path, messageId: m.headerMessageId });
    }
    if (deleted.length) {
      await this.#withEcho(intents, () => this.#browser.messages.delete(deleted, { deletePermanently: true, isUserAction: false }));
    }
    return { deleted, skipped };
  }
}
