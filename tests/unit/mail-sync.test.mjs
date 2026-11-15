// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Mail synchronisation of one collection (src/sync/mail.mjs), against a
 * fake ActiveSync server (FakeServer: requests and answers go through the
 * real WBXML encoder and decoder) and a fake Thunderbird account
 * (FakeMailStore: ids renumbered by restart(), a second import of a
 * Message-ID refused, as Thunderbird does). Both are exported for
 * mailbox.test.mjs.
 */

import { test, assert, eq, rejects } from "./harness.mjs";
import { el, encode, decode, text, child, at } from "../../src/core/wbxml.mjs";
import { encodeUtf8, decodeUtf8 } from "../../src/core/utf8.mjs";
import { messageIdOf } from "../../src/core/mime.mjs";
import { EasError, ERR } from "../../src/transport/client.mjs";
import { Store } from "../../src/sync/store.mjs";
import {
  CollectionState, MailPass, syncBatch, syncCollection, replayMoves, distinctCopy, loadCollection, loadPendingDeletes,
  collRecord, MAX_BATCHES, WINDOW_SIZE, ORIGINAL_ID_FIELD,
} from "../../src/sync/mail.mjs";
import { memoryArea } from "./journal.test.mjs";

// ── Fake ActiveSync server ────────────────────────────────────────────────

export const DEFAULT_FOLDERS = [
  { id: "1", parentId: "0", name: "Boîte de réception", type: 2 },
  { id: "2", parentId: "0", name: "Brouillons", type: 3 },
  { id: "3", parentId: "0", name: "Éléments supprimés", type: 4 },
  { id: "4", parentId: "0", name: "Éléments envoyés", type: 5 },
  { id: "5", parentId: "0", name: "Boîte d'envoi", type: 6 },
  { id: "6", parentId: "1", name: "Projets", type: 12 },
  { id: "7", parentId: "0", name: "Calendrier", type: 8 },
];

const roundTrip = (node) => (node === null ? null : decode(encode(node)));

export class FakeServer {
  constructor({ folders = DEFAULT_FOLDERS } = {}) {
    this.folders = new Map(folders.map((f) => [f.id, { parentId: f.parentId, name: f.name, type: f.type }]));
    this.items = new Map([...this.folders.keys()].map((id) => [id, new Map()]));
    this.hierKey = 0;
    this.hierPending = [];
    this.colls = new Map();
    this.seq = 100;
    this.requests = [];
    this.hooks = [];
    this.pings = [];
    this.moveStatus = new Map(); // ServerId → forced MoveItems status
    this.changeStatus = new Map(); // ServerId → forced Change status
  }

  get trashId() {
    return [...this.folders].find(([, f]) => f.type === 4)?.[0] ?? null;
  }

  // Server-side changes (another device, the webmail…).
  addMessage(cid, mime, { read = false, flagged = false } = {}) {
    const sid = `${cid}:${++this.seq}`;
    this.items.get(cid).set(sid, { mime, read, flagged });
    this.#notify(cid, { op: "add", sid });
    return sid;
  }
  deleteMessage(cid, sid) {
    this.items.get(cid).delete(sid);
    this.#notify(cid, { op: "delete", sid });
  }
  softDelete(cid, sid) {
    this.#notify(cid, { op: "softdelete", sid });
  }
  changeFlags(cid, sid, flags) {
    Object.assign(this.items.get(cid).get(sid), flags);
    this.#notify(cid, { op: "change", sid });
  }
  serverMove(cid, sid, dst) {
    const item = this.items.get(cid).get(sid);
    this.deleteMessage(cid, sid);
    return this.addMessage(dst, item.mime, item);
  }
  invalidate(cid) {
    const st = this.colls.get(cid);
    if (st) st.key = 9999;
  }
  addFolder(id, parentId, name, type) {
    this.folders.set(id, { parentId, name, type });
    this.items.set(id, new Map());
    if (this.hierKey) this.hierPending.push(["Add", id]);
  }
  updateFolder(id, changes) {
    Object.assign(this.folders.get(id), changes);
    if (this.hierKey) this.hierPending.push(["Update", id]);
  }
  deleteFolder(id) {
    this.folders.delete(id);
    this.items.delete(id);
    this.colls.delete(id);
    if (this.hierKey) this.hierPending.push(["Delete", id]);
  }
  #notify(cid, change) {
    const st = this.colls.get(cid);
    if (st?.key) st.pending.push(change);
  }

  /** Requests of one command, decoded. */
  sent(cmd) {
    return this.requests.filter((r) => r.cmd === cmd).map((r) => r.req);
  }

  /** One-shot hook on the next request of `cmd`: fn(req, opts) → element, null, or undefined (default answer). */
  hook(cmd, fn) {
    this.hooks.push({ cmd, fn });
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

  #folderNode(tag, id) {
    const f = this.folders.get(id);
    if (tag === "Delete") return el("Delete", [el("ServerId", id)]);
    return el(tag, [el("ServerId", id), el("ParentId", f.parentId), el("DisplayName", f.name), el("Type", String(f.type))]);
  }

  onFolderSync(req) {
    const key = text(req, "SyncKey");
    let changes;
    if (key === "0") {
      changes = [...this.folders.keys()].map((id) => this.#folderNode("Add", id));
      this.hierKey = 1;
      this.hierPending = [];
    } else if (key === String(this.hierKey)) {
      changes = this.hierPending.splice(0).map(([tag, id]) => this.#folderNode(tag, id));
      if (changes.length) this.hierKey++;
    } else {
      return el("FolderHierarchy:FolderSync", [el("Status", "9")]);
    }
    return el("FolderHierarchy:FolderSync", [
      el("Status", "1"),
      el("SyncKey", String(this.hierKey)),
      el("Changes", [el("Count", String(changes.length)), ...changes]),
    ]);
  }

  #hierStatus(tag, req) {
    if (text(req, "SyncKey") !== String(this.hierKey)) return el(`FolderHierarchy:${tag}`, [el("Status", "9")]);
    return null;
  }

  onFolderCreate(req) {
    const bad = this.#hierStatus("FolderCreate", req);
    if (bad) return bad;
    const id = `f${++this.seq}`;
    this.folders.set(id, { parentId: text(req, "ParentId"), name: text(req, "DisplayName"), type: Number(text(req, "Type")) });
    this.items.set(id, new Map());
    this.hierKey++;
    return el("FolderHierarchy:FolderCreate", [el("Status", "1"), el("SyncKey", String(this.hierKey)), el("ServerId", id)]);
  }

  onFolderUpdate(req) {
    const bad = this.#hierStatus("FolderUpdate", req);
    if (bad) return bad;
    const id = text(req, "ServerId");
    const f = this.folders.get(id);
    if (!f) return el("FolderHierarchy:FolderUpdate", [el("Status", "4")]);
    if (f.type >= 2 && f.type <= 6) return el("FolderHierarchy:FolderUpdate", [el("Status", "3")]);
    f.parentId = text(req, "ParentId");
    f.name = text(req, "DisplayName");
    this.hierKey++;
    return el("FolderHierarchy:FolderUpdate", [el("Status", "1"), el("SyncKey", String(this.hierKey))]);
  }

  onFolderDelete(req) {
    const bad = this.#hierStatus("FolderDelete", req);
    if (bad) return bad;
    const id = text(req, "ServerId");
    const f = this.folders.get(id);
    if (!f) return el("FolderHierarchy:FolderDelete", [el("Status", "4")]);
    if (f.type >= 2 && f.type <= 6) return el("FolderHierarchy:FolderDelete", [el("Status", "3")]);
    this.folders.delete(id);
    this.items.delete(id);
    this.hierKey++;
    return el("FolderHierarchy:FolderDelete", [el("Status", "1"), el("SyncKey", String(this.hierKey))]);
  }

  #appData(item, withBody = true) {
    return [
      el("Email:Read", item.read ? "1" : "0"),
      item.flagged ? el("Email:Flag", [el("Email:Status", "2"), el("Email:FlagType", "for Follow Up")]) : el("Email:Flag"),
      withBody && item.mime ? el("AirSyncBase:Body", [el("AirSyncBase:Type", "4"), el("AirSyncBase:Data", item.mime)]) : null,
      withBody && item.truncated ? el("AirSyncBase:Body", [el("AirSyncBase:Type", "4"), el("AirSyncBase:Truncated", "1")]) : null,
    ];
  }

  onSync(req) {
    const c = at(req, "Collections", "Collection");
    const cid = text(c, "CollectionId");
    const key = text(c, "SyncKey");
    const reply = (status, extra = []) =>
      el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", key), el("CollectionId", cid), el("Status", status), ...extra])])]);
    if (!this.items.has(cid)) return reply("8");
    let st = this.colls.get(cid);
    if (key === "0") {
      st = { key: 1, prev: null, last: null, pending: [...this.items.get(cid).keys()].map((sid) => ({ op: "add", sid })) };
      this.colls.set(cid, st);
      return el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", "1"), el("CollectionId", cid), el("Status", "1")])])]);
    }
    if (!st || key !== String(st.key)) {
      if (st && key === String(st.prev) && st.last) return st.last; // the same request again: the same answer
      return reply("3");
    }
    const items = this.items.get(cid);
    const responses = [];
    const deletesAsMoves = text(c, "DeletesAsMoves") === "1";
    for (const cmd of child(c, "Commands")?.children ?? []) {
      const sid = text(cmd, "ServerId");
      const item = items.get(sid);
      if (cmd.tag === "Change") {
        const forced = this.changeStatus.get(sid);
        if (!item || forced) {
          responses.push(el("Change", [el("ServerId", sid), el("Status", forced ?? "8")]));
          continue;
        }
        const data = child(cmd, "ApplicationData");
        const read = text(data, "Email:Read");
        if (read !== null) item.read = read === "1";
        const flag = child(data, "Email:Flag");
        if (flag) item.flagged = text(flag, "Email:Status") === "2";
      } else if (cmd.tag === "Delete") {
        if (!item) continue;
        items.delete(sid);
        if (deletesAsMoves && this.trashId && cid !== this.trashId) this.addMessage(this.trashId, item.mime, item);
      }
    }
    const window = Number(text(c, "WindowSize") ?? "100");
    const commands = [];
    while (st.pending.length && commands.length < window) {
      const ch = st.pending.shift();
      const item = items.get(ch.sid);
      if (ch.op === "add") {
        if (item) commands.push(el("Add", [el("ServerId", ch.sid), el("ApplicationData", this.#appData(item))]));
      } else if (ch.op === "change") {
        if (item) commands.push(el("Change", [el("ServerId", ch.sid), el("ApplicationData", this.#appData(item, false))]));
      } else if (ch.op === "delete") {
        commands.push(el("Delete", [el("ServerId", ch.sid)]));
      } else if (ch.op === "softdelete") {
        commands.push(el("SoftDelete", [el("ServerId", ch.sid)]));
      }
    }
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

  onMoveItems(req) {
    const answers = [];
    for (const m of req.children) {
      const src = text(m, "SrcMsgId");
      const from = text(m, "SrcFldId");
      const to = text(m, "DstFldId");
      const forced = this.moveStatus.get(src);
      const item = this.items.get(from)?.get(src);
      if (forced) {
        answers.push(el("Response", [el("SrcMsgId", src), el("Status", forced)]));
      } else if (!item) {
        answers.push(el("Response", [el("SrcMsgId", src), el("Status", "1")]));
      } else if (!this.items.has(to)) {
        answers.push(el("Response", [el("SrcMsgId", src), el("Status", "2")]));
      } else {
        this.items.get(from).delete(src);
        const dst = `${to}:${++this.seq}`;
        this.items.get(to).set(dst, item);
        answers.push(el("Response", [el("SrcMsgId", src), el("Status", "3"), el("DstMsgId", dst)]));
      }
    }
    return el("Move:MoveItems", answers);
  }

  async onPing(req, opts) {
    const next = this.pings.shift();
    const r = typeof next === "function" ? await next(req, opts) : next ?? { status: "1" };
    if (r === undefined || r === null || r.children) return r ?? null;
    return el("Ping:Ping", [
      el("Status", r.status),
      r.folders ? el("Folders", r.folders.map((id) => el("Folder", id))) : null,
      r.heartbeat ? el("HeartbeatInterval", String(r.heartbeat)) : null,
      r.maxFolders ? el("MaxFolders", String(r.maxFolders)) : null,
    ]);
  }
}

// ── Fake Thunderbird account ──────────────────────────────────────────────

const under = (p, root) => p === root || p.startsWith(`${root}/`);

export class FakeMailStore {
  constructor({ folders = [["/Inbox", ["inbox"]], ["/Trash", ["trash"]], ["/Sent", ["sent"]], ["/Drafts", ["drafts"]]] } = {}) {
    this.folders = new Map();
    this.nextId = 1;
    this.writes = [];
    this.failImport = 0;
    this.failAll = false;
    this.beforeImport = null;
    for (const [path, specialUse] of folders) this.folders.set(path, { specialUse, msgs: new Map() });
  }

  // Test helpers (what the user sees and does).
  messages(path) {
    return [...(this.folders.get(path)?.msgs ?? new Map())].map(([id, m]) => ({ id, ...m }));
  }
  mids(path) {
    return this.messages(path).map((m) => m.mid).sort();
  }
  idsOf(path, mid) {
    return this.messages(path).filter((m) => m.mid === mid).map((m) => m.id);
  }
  /** Thunderbird restarted: every message gets a new id. */
  restart() {
    for (const f of this.folders.values()) {
      const renumbered = new Map();
      for (const m of f.msgs.values()) renumbered.set((this.nextId += 7), m);
      f.msgs = renumbered;
    }
  }
  #locate(id) {
    for (const [path, f] of this.folders) if (f.msgs.has(id)) return { path, f, m: f.msgs.get(id) };
    return null;
  }
  userDelete(path, mid) {
    const [id] = this.idsOf(path, mid);
    this.folders.get(path).msgs.delete(id);
    return { kind: "delete", path, messageId: mid };
  }
  userMove(path, mid, toPath) {
    const [id] = this.idsOf(path, mid);
    const m = this.folders.get(path).msgs.get(id);
    this.folders.get(path).msgs.delete(id);
    this.folders.get(toPath).msgs.set(this.nextId++, m);
    return { kind: "move", path, toPath, messageId: mid };
  }
  userFlags(path, mid, flags) {
    for (const id of this.idsOf(path, mid)) Object.assign(this.folders.get(path).msgs.get(id), flags);
    return { kind: "flags", path, messageId: mid, flags };
  }
  userAddFolder(path) {
    this.folders.set(path, { specialUse: [], msgs: new Map() });
  }
  #rebase(from, to) {
    for (const p of [...this.folders.keys()]) {
      if (!under(p, from)) continue;
      const f = this.folders.get(p);
      this.folders.delete(p);
      this.folders.set(to + p.slice(from.length), f);
    }
  }
  userRenameFolder(path, toPath) {
    this.#rebase(path, toPath);
  }
  userRemoveFolder(path) {
    for (const p of [...this.folders.keys()]) if (under(p, path)) this.folders.delete(p);
  }

  #folder(path) {
    const f = this.folders.get(path);
    if (!f) throw Object.assign(new Error("NOT_FOUND: dossier introuvable"), { code: "NOT_FOUND" });
    return f;
  }
  #check() {
    if (this.failAll) throw Object.assign(new Error("FAILED: Thunderbird indisponible"), { code: "FAILED" });
  }

  // The adapter's API (tb/mail-store.mjs).
  async folderExists(path) {
    return this.folders.has(path);
  }
  async listFolders() {
    return [...this.folders].map(([path, f]) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), specialUse: [...f.specialUse] }));
  }
  async createFolder(parentPath, name) {
    this.#check();
    if (parentPath !== "/") this.#folder(parentPath);
    const path = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
    if (this.folders.has(path)) throw new Error("REFUSED: existe déjà");
    this.folders.set(path, { specialUse: [], msgs: new Map() });
    this.writes.push(["createFolder", path]);
    return path;
  }
  async renameFolder(path, newName) {
    this.#check();
    const f = this.#folder(path);
    if (f.specialUse.length) throw new Error("REFUSED: dossier spécial");
    const to = `${path.slice(0, path.lastIndexOf("/"))}/${newName}`;
    if (this.folders.has(to)) throw new Error("REFUSED: existe déjà");
    this.#rebase(path, to);
    this.writes.push(["renameFolder", path, to]);
    return to;
  }
  async moveFolder(path, destParent) {
    this.#check();
    const f = this.#folder(path);
    if (f.specialUse.length) throw new Error("REFUSED: dossier spécial");
    if (destParent !== "/") this.#folder(destParent);
    const to = `${destParent === "/" ? "" : destParent}/${path.slice(path.lastIndexOf("/") + 1)}`;
    if (this.folders.has(to)) throw new Error("REFUSED: existe déjà");
    this.#rebase(path, to);
    this.writes.push(["moveFolder", path, to]);
    return to;
  }
  async deleteFolder(path) {
    this.#check();
    const trash = [...this.folders].find(([, f]) => f.specialUse.includes("trash"))?.[0];
    if (!trash || path === trash || !under(path, trash)) throw new Error("REFUSED: hors corbeille");
    for (const p of [...this.folders.keys()]) if (under(p, path)) this.folders.delete(p);
    this.writes.push(["deleteFolder", path]);
  }
  async findByMessageId(path, mid) {
    const f = this.#folder(path);
    return [...f.msgs].filter(([, m]) => m.mid === mid).map(([id, m]) => ({ id, flags: { read: m.read, flagged: m.flagged } }));
  }
  async listMessages(path) {
    const f = this.#folder(path);
    return [...f.msgs].map(([id, m]) => ({ id, messageId: m.mid, flags: { read: m.read, flagged: m.flagged } }));
  }
  async importMessage(path, bytes, flags) {
    this.#check();
    const f = this.#folder(path);
    if (this.beforeImport) await this.beforeImport(path, bytes);
    if (this.failImport > 0) {
      this.failImport--;
      throw Object.assign(new Error("TIMEOUT: import trop long"), { code: "TIMEOUT" });
    }
    const mid = messageIdOf(bytes);
    if (mid === null) throw new Error("test : message sans Message-ID importé");
    if ([...f.msgs.values()].some((m) => m.mid === mid)) throw new Error("FAILED: Destination folder already contains a message with this id");
    const id = this.nextId++;
    f.msgs.set(id, { mid, read: flags.read === true, flagged: flags.flagged === true, bytes });
    this.writes.push(["import", path, mid]);
    return { id };
  }
  async setFlags(id, flags, expected) {
    this.#check();
    const at = this.#locate(id);
    if (!at || (expected && (at.path !== expected.path || at.m.mid !== expected.messageId))) return false;
    let changed = false;
    for (const k of ["read", "flagged"]) {
      if (typeof flags[k] === "boolean" && at.m[k] !== flags[k]) {
        at.m[k] = flags[k];
        changed = true;
      }
    }
    if (changed) this.writes.push(["setFlags", at.path, at.m.mid, { ...flags }]);
    return changed;
  }
  async moveMessages(ids, path, expected) {
    this.#check();
    const dest = this.#folder(path);
    const moved = [];
    const skipped = [];
    for (const id of ids) {
      const at = this.#locate(id);
      if (!at || at.path === path || (expected && (at.path !== expected.path || at.m.mid !== expected.messageId))) {
        skipped.push(id);
        continue;
      }
      at.f.msgs.delete(id);
      dest.msgs.set(this.nextId++, at.m); // a moved message gets a new id, as in Thunderbird
      moved.push(id);
      this.writes.push(["move", at.path, path, at.m.mid]);
    }
    return { moved, skipped };
  }
  async deleteMessages(ids, { permanent = false, expected = null } = {}) {
    this.#check();
    const trash = [...this.folders].find(([, f]) => f.specialUse.includes("trash"))?.[0];
    if (!permanent) {
      const r = await this.moveMessages(ids, trash, expected);
      return { deleted: r.moved, skipped: r.skipped };
    }
    const deleted = [];
    const skipped = [];
    for (const id of ids) {
      const at = this.#locate(id);
      if (!at || !trash || !under(at.path, trash) || (expected && (at.path !== expected.path || at.m.mid !== expected.messageId))) {
        skipped.push(id);
        continue;
      }
      at.f.msgs.delete(id);
      deleted.push(id);
      this.writes.push(["delete", at.path, at.m.mid]);
    }
    return { deleted, skipped };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

export const mime = (mid, subject = "Bonjour", extra = "") =>
  encodeUtf8(`${mid === null ? "" : `Message-ID: <${mid}>\r\n`}${extra}Subject: ${subject}\r\nFrom: a@example.org\r\n\r\nCorps du message ${subject}.\r\n`);

export function quietLog() {
  const lines = [];
  const add = (level) => (m) => lines.push([level, String(m)]);
  return { lines, info: add("info"), warn: add("warn"), error: add("error"), debug: add("debug"), debugEnabled: false };
}

const MB = "0123456789ab";

/** A context for mail.mjs functions, around one collection mapped to a local folder. */
function setup({ server = new FakeServer(), store = new FakeMailStore(), cid = "1", path = "/Inbox", area = memoryArea() } = {}) {
  const records = new Store(area).mailbox(MB);
  const log = quietLog();
  const colls = new Map();
  const ctx = {
    client: server,
    records,
    mailStore: store,
    log,
    now: () => 1000,
    signal: null,
    filterType: "0",
    trashPath: "/Trash",
    serverTrash: (id) => id === "3",
    collectionOf: (p) => [...colls.values()].find((c) => c.path === p) ?? null,
    pass: new MailPass(),
  };
  const coll = new CollectionState(cid, { path });
  colls.set(cid, coll);
  const trash = new CollectionState("3", { path: "/Trash" });
  colls.set("3", trash);
  return { server, store, records, ctx, coll, trash, log, colls, newPass: () => (ctx.pass = new MailPass()) };
}

const commandsOf = (req) => at(req, "Collections", "Collection", "Commands")?.children ?? [];

// ── Collection table ──────────────────────────────────────────────────────

test("table : correspondance ServerId → Message-ID et index inverse", () => {
  const c = new CollectionState("1", { syncKey: "5", path: "/Inbox", items: [["a", "m@x"], ["b", "m@x"], ["c", "n@x"]] });
  eq(c.refs("m@x"), 2);
  eq(c.serverIdsOf("m@x"), ["a", "b"]);
  eq(c.unlink("a"), "m@x");
  eq(c.refs("m@x"), 1);
  c.link("b", "n@x"); // relinked: never two targets
  eq(c.refs("m@x"), 0);
  eq(c.serverIdsOf("n@x"), ["c", "b"]);
  c.reset();
  eq([c.syncKey, c.items.size, c.refs("n@x")], ["0", 0, 0]);
});

test("table : enregistrement abîmé, éléments invalides écartés ; clé invalide → tout reprendre", () => {
  const c = CollectionState.fromRecord("1", { syncKey: "7", path: "/Inbox", items: [["a", "m@x"], ["", "z"], ["b", "a b"], 3, ["c", "ok@x"]] });
  eq([...c.items], [["a", "m@x"], ["c", "ok@x"]]);
  const d = CollectionState.fromRecord("1", { syncKey: "clé\u0000", path: "/Inbox", items: [["a", "m@x"]] });
  eq([d.syncKey, d.items.size], ["0", 0]);
  eq(CollectionState.fromRecord("1", null).syncKey, "0");
});

// ── Distinct copies ───────────────────────────────────────────────────────

test("copie distincte : nouveau Message-ID en tête, l'original renommé, corps intact", () => {
  const original = encodeUtf8("Subject: x\r\nmessage-ID : <a@b>\r\nMessage-Id:\r\n <c@d>\r\n\r\nMessage-ID: <corps@x>\r\n");
  const r = distinctCopy(original, "1", "1:7");
  assert(/^[0-9a-f]{32}@sync443\.invalid$/.test(r.messageId), r.messageId);
  eq(messageIdOf(r.bytes), r.messageId);
  const s = decodeUtf8(r.bytes);
  assert(s.startsWith(`Message-ID: <${r.messageId}>\r\n`));
  eq(s.split(`${ORIGINAL_ID_FIELD} :`).length, 2, "nom avec blanc avant les deux-points");
  eq(s.split(`${ORIGINAL_ID_FIELD}:\r\n <c@d>`).length, 2, "champ replié");
  assert(s.endsWith("\r\n\r\nMessage-ID: <corps@x>\r\n"), "le corps n'est pas touché");
  eq(distinctCopy(original, "1", "1:7").messageId, r.messageId, "même élément, même identifiant");
  assert(distinctCopy(original, "1", "1:8").messageId !== r.messageId);
  assert(distinctCopy(original, "6", "1:7").messageId !== r.messageId);
  const lf = decodeUtf8(distinctCopy(encodeUtf8("Message-ID: <a@b>\nSubject: y\n\nz\n"), "1", "x").bytes);
  assert(/^Message-ID: <[0-9a-f]{32}@sync443\.invalid>\nX-Sync443-Original-Message-ID: <a@b>\n/.test(lf), "fins de ligne LF gardées");
});

// ── Server changes ────────────────────────────────────────────────────────

test("synchro : première synchro, messages importés, SyncKey avancée", async () => {
  const t = setup();
  for (const n of [1, 2, 3]) t.server.addMessage("1", mime(`m${n}@x`), { read: n === 2, flagged: n === 3 });
  await syncCollection(t.ctx, t.coll);
  eq(t.store.mids("/Inbox"), ["m1@x", "m2@x", "m3@x"]);
  const byMid = new Map(t.store.messages("/Inbox").map((m) => [m.mid, m]));
  eq([byMid.get("m2@x").read, byMid.get("m3@x").flagged, byMid.get("m1@x").read], [true, true, false]);
  const stored = await loadCollection(t.records, "1");
  eq(stored.items.size, 3);
  eq(stored.syncKey, "2");
  eq(t.ctx.pass.counts.added, 3);
  const opts = at(t.server.sent("Sync")[1], "Collections", "Collection", "Options");
  eq(text(opts, "FilterType"), "0");
  eq(text(at(t.server.sent("Sync")[1], "Collections", "Collection"), "WindowSize"), String(WINDOW_SIZE));
});

test("synchro : en-têtes internes retirés, Message-ID synthétique stable pour un message qui n'en a pas", async () => {
  const t = setup();
  t.server.addMessage("1", mime(null, "Sans id", "X-Mozilla-Status: 0001\r\nX-Mozilla-Keys: $label1\r\n"));
  await syncCollection(t.ctx, t.coll);
  const [m] = t.store.messages("/Inbox");
  assert(/^[0-9a-f]{32}@sync443\.invalid$/.test(m.mid), m.mid);
  const s = decodeUtf8(m.bytes);
  assert(!s.includes("X-Mozilla"), "en-têtes de Thunderbird retirés");
  // The same batch again (SyncKey not saved, e.g. after a crash): attached, not imported twice.
  t.coll.syncKey = "1";
  t.coll.reset();
  t.coll.syncKey = "1";
  t.newPass();
  await syncBatch(t.ctx, t.coll);
  eq(t.store.messages("/Inbox").length, 1);
  eq(t.coll.items.size, 1);
});

test("aucun alias : deux éléments du serveur au même Message-ID → deux copies locales distinctes", async () => {
  const t = setup();
  const s1 = t.server.addMessage("1", mime("dup@x"));
  const s2 = t.server.addMessage("1", mime("dup@x"));
  await syncCollection(t.ctx, t.coll);
  const local = t.store.messages("/Inbox");
  eq(local.length, 2);
  const mids = local.map((m) => m.mid);
  assert(mids.includes("dup@x"));
  const other = mids.find((m) => m !== "dup@x");
  assert(/@sync443\.invalid$/.test(other));
  eq(t.coll.midOf(s1), "dup@x");
  eq(t.coll.midOf(s2), other);
  eq([t.coll.refs("dup@x"), t.coll.refs(other)], [1, 1], "chaque copie, un seul ServerId");
  assert(decodeUtf8(local.find((m) => m.mid === other).bytes).includes(`${ORIGINAL_ID_FIELD}: <dup@x>`));
});

test("aucun alias : une copie locale non rattachée est rattachée au lieu d'importer", async () => {
  const t = setup();
  await t.store.importMessage("/Inbox", mime("deja@x"), { read: true });
  const sid = t.server.addMessage("1", mime("deja@x"), { read: false, flagged: true });
  await syncCollection(t.ctx, t.coll);
  eq(t.store.messages("/Inbox").length, 1);
  eq(t.coll.midOf(sid), "deja@x");
  const [m] = t.store.messages("/Inbox");
  eq([m.read, m.flagged], [false, true], "état du serveur appliqué");
  // A second server item with the same Message-ID: the only copy is taken, a distinct one is imported.
  t.server.addMessage("1", mime("deja@x"));
  await syncCollection(t.ctx, t.coll);
  eq(t.store.messages("/Inbox").length, 2);
});

test("synchro : changements de drapeaux appliqués ; élément inconnu ignoré", async () => {
  const t = setup();
  const sid = t.server.addMessage("1", mime("f@x"));
  await syncCollection(t.ctx, t.coll);
  t.server.changeFlags("1", sid, { read: true, flagged: true });
  t.newPass();
  await syncCollection(t.ctx, t.coll);
  const [m] = t.store.messages("/Inbox");
  eq([m.read, m.flagged], [true, true]);
  eq(t.ctx.pass.counts.changed, 1);
  t.server.hook("Sync", (req) => {
    const c = at(req, "Collections", "Collection");
    return el("AirSync:Sync", [el("Collections", [el("Collection", [
      el("SyncKey", "99"), el("CollectionId", "1"), el("Status", "1"),
      el("Commands", [el("Change", [el("ServerId", "inconnu"), el("ApplicationData", [el("Email:Read", "0")])])]),
    ])])]);
  });
  t.newPass();
  await syncBatch(t.ctx, t.coll);
  eq(t.ctx.pass.counts.skipped, 1);
  eq(t.coll.syncKey, "99");
});

test("suppressions du serveur : hors corbeille vers la corbeille locale, dans la corbeille supprimées", async () => {
  const t = setup();
  const sid = t.server.addMessage("1", mime("d@x"));
  await syncCollection(t.ctx, t.coll);
  t.server.serverMove("1", sid, "3"); // deleted in the webmail: moved to the server's trash
  t.newPass();
  await syncCollection(t.ctx, t.coll);
  eq(t.store.mids("/Inbox"), []);
  eq(t.store.mids("/Trash"), ["d@x"], "filet : la copie est dans la corbeille locale");
  eq(t.coll.items.size, 0);
  eq(t.ctx.pass.counts.deleted, 1);
  // The server's trash now holds it: attached to the copy in the local trash, not imported again.
  t.newPass();
  await syncCollection(t.ctx, t.trash);
  eq(t.store.mids("/Trash"), ["d@x"]);
  eq(t.trash.refs("d@x"), 1);
  // Deleted from the server's trash: deleted locally.
  t.server.deleteMessage("3", t.trash.serverIdsOf("d@x")[0]);
  t.newPass();
  await syncCollection(t.ctx, t.trash);
  eq(t.store.mids("/Trash"), []);
});

test("suppressions du serveur : un message encore désigné par un autre ServerId reste", async () => {
  const t = setup();
  await t.store.importMessage("/Inbox", mime("deux@x"), {});
  await t.store.importMessage("/Inbox", mime("autre@x"), {});
  t.coll.syncKey = "1";
  t.server.colls.set("1", { key: 1, prev: null, last: null, pending: [] });
  // Two server items attached to the same Message-ID (two local copies existed: here, simulated in the table).
  t.coll.link("1:a", "deux@x");
  t.coll.link("1:b", "deux@x");
  t.server.items.get("1").set("1:a", { mime: mime("deux@x") });
  t.server.items.get("1").set("1:b", { mime: mime("deux@x") });
  t.server.deleteMessage("1", "1:a");
  await syncCollection(t.ctx, t.coll);
  eq(t.store.mids("/Inbox"), ["autre@x", "deux@x"], "encore désigné : gardé");
  t.server.deleteMessage("1", "1:b");
  t.newPass();
  await syncCollection(t.ctx, t.coll);
  eq(t.store.mids("/Inbox"), ["autre@x"]);
});

test("déplacement sur le serveur : la copie revient de la corbeille au lieu d'être réimportée", async () => {
  const t = setup();
  const archive = new CollectionState("6", { path: "/Inbox/Projets" });
  t.store.userAddFolder("/Inbox/Projets");
  const sid = t.server.addMessage("1", mime("mv@x"), { flagged: true });
  await syncCollection(t.ctx, t.coll);
  await syncCollection(t.ctx, archive);
  t.server.serverMove("1", sid, "6");
  t.newPass();
  await syncCollection(t.ctx, t.coll);
  await syncCollection(t.ctx, archive);
  eq(t.store.mids("/Trash"), []);
  eq(t.store.mids("/Inbox/Projets"), ["mv@x"]);
  assert(!t.store.writes.some((w) => w[0] === "import" && w[1] === "/Inbox/Projets"), "pas de réimport");
  eq(archive.refs("mv@x"), 1);
});

test("suppression douce (hors période) : détaché, la copie locale reste", async () => {
  const t = setup();
  const sid = t.server.addMessage("1", mime("old@x"));
  await syncCollection(t.ctx, t.coll);
  t.server.softDelete("1", sid);
  t.newPass();
  await syncCollection(t.ctx, t.coll);
  eq(t.store.mids("/Inbox"), ["old@x"]);
  eq(t.coll.items.size, 0);
});

test("Status 3 : resynchro complète, table reconstruite, sans doublon local", async () => {
  const t = setup();
  for (const n of [1, 2, 3]) t.server.addMessage("1", mime(`r${n}@x`));
  await syncCollection(t.ctx, t.coll);
  const gone = [...t.coll.items.keys()][0];
  t.server.items.get("1").delete(gone); // removed on the server while the key is invalid
  t.server.invalidate("1");
  t.newPass();
  await syncCollection(t.ctx, t.coll);
  eq(t.coll.items.size, 2, "table reconstruite depuis le serveur");
  assert(!t.coll.items.has(gone));
  eq(t.store.mids("/Inbox"), ["r1@x", "r2@x", "r3@x"], "rien n'est supprimé ni importé en double");
  assert(!t.store.writes.slice(3).some((w) => w[0] === "import"));
  const keys = t.server.sent("Sync").map((r) => text(at(r, "Collections", "Collection"), "SyncKey"));
  assert(keys.includes("0") && keys.lastIndexOf("0") > 1, "SyncKey 0 renvoyée");
});

test("MoreAvailable borné : au plus 20 lots par passage, la suite au suivant", async () => {
  const t = setup();
  for (let n = 0; n < 1100; n++) t.server.addMessage("1", mime(`b${n}@x`, `n${n}`));
  await syncCollection(t.ctx, t.coll);
  eq(t.server.sent("Sync").length, MAX_BATCHES);
  eq(t.store.messages("/Inbox").length, (MAX_BATCHES - 1) * WINDOW_SIZE);
  assert(t.ctx.pass.bounded);
  t.newPass();
  await syncCollection(t.ctx, t.coll);
  eq(t.store.messages("/Inbox").length, 1100);
});

test("seuil de suppression en masse : suppressions retenues, rien de touché localement", async () => {
  const t = setup();
  for (let n = 0; n < 100; n++) t.server.addMessage("1", mime(`k${n}@x`));
  for (let b = 0; b < 3; b++) await syncCollection(t.ctx, t.coll);
  eq(t.store.messages("/Inbox").length, 100);
  const sids = [...t.coll.items.keys()].slice(0, 60);
  for (const sid of sids) t.server.deleteMessage("1", sid);
  t.newPass();
  await syncCollection(t.ctx, t.coll);
  eq(t.store.messages("/Inbox").length, 100, "aucune suppression locale");
  eq(t.store.mids("/Trash"), []);
  const pending = await loadPendingDeletes(t.records);
  eq(pending.get("1").items.length, 60);
  eq(t.ctx.pass.retained, 60);
  assert(pending.get("1").retained);
  eq(t.coll.items.size, 40, "la table suit le serveur");
  const stored = await loadCollection(t.records, "1");
  assert(stored.syncKey !== "0" && Number(stored.syncKey) > 3, "la SyncKey avance");
});

test("seuil de suppression en masse : sous 20 % du dossier, appliqué", async () => {
  const t = setup();
  for (let n = 0; n < 400; n++) t.server.addMessage("1", mime(`s${n}@x`));
  for (let b = 0; b < 2; b++) {
    t.newPass();
    await syncCollection(t.ctx, t.coll);
  }
  eq(t.coll.items.size, 400);
  for (const sid of [...t.coll.items.keys()].slice(0, 60)) t.server.deleteMessage("1", sid);
  t.newPass();
  await syncCollection(t.ctx, t.coll);
  eq(t.store.messages("/Trash").length, 60);
  eq((await loadPendingDeletes(t.records)).size, 0);
});

test("quarantaine : un élément illisible ou un import en échec n'empêche pas les autres", async () => {
  const t = setup();
  t.server.addMessage("1", mime("q1@x"));
  const bad = t.server.addMessage("1", null); // no MIME body
  const cut = t.server.addMessage("1", mime("q3@x"));
  t.server.items.get("1").get(cut).truncated = true;
  t.server.items.get("1").get(cut).mime = null;
  t.server.addMessage("1", mime("q4@x"));
  t.server.addMessage("1", mime("q5@x"));
  t.store.failImport = 1; // q1 fails
  await syncCollection(t.ctx, t.coll);
  eq(t.store.mids("/Inbox"), ["q4@x", "q5@x"]);
  eq(t.ctx.pass.counts.skipped, 3);
  const stored = await loadCollection(t.records, "1");
  eq(stored.quarantine.map((q) => q.serverId).includes(bad), true);
  eq(stored.quarantine.length, 3);
  assert(stored.syncKey === "2", "la SyncKey avance malgré la quarantaine");
  assert(t.log.lines.some(([lvl, m]) => lvl === "warn" && m.includes("quarantaine") && !m.includes("q4@x")), "journalisé sans contenu");
});

test("échec général d'écriture locale : rien n'est enregistré, le lot reviendra", async () => {
  const t = setup();
  for (const n of [1, 2, 3]) t.server.addMessage("1", mime(`e${n}@x`));
  await syncBatch(t.ctx, t.coll); // initial key
  t.store.failAll = true;
  await rejects(syncBatch(t.ctx, t.coll), (e) => e.code === "LOCAL");
  eq((await loadCollection(t.records, "1")).syncKey, "1", "SyncKey inchangée");
  t.store.failAll = false;
  t.newPass();
  await syncCollection(t.ctx, t.coll);
  eq(t.store.mids("/Inbox"), ["e1@x", "e2@x", "e3@x"]);
});

test("annulation au milieu d'un lot : SyncKey non enregistrée, reprise sans doublon", async () => {
  const t = setup();
  for (const n of [1, 2, 3, 4]) t.server.addMessage("1", mime(`c${n}@x`));
  await syncBatch(t.ctx, t.coll);
  const ctrl = new AbortController();
  t.ctx.signal = ctrl.signal;
  let imports = 0;
  t.store.beforeImport = () => {
    if (++imports === 2) ctrl.abort();
  };
  await rejects(syncBatch(t.ctx, t.coll), (e) => e.code === ERR.CANCELLED);
  eq((await loadCollection(t.records, "1")).syncKey, "1");
  eq(t.store.messages("/Inbox").length, 2);
  t.store.beforeImport = null;
  t.ctx.signal = null;
  const again = await loadCollection(t.records, "1");
  t.newPass();
  await syncCollection(t.ctx, again);
  eq(t.store.mids("/Inbox"), ["c1@x", "c2@x", "c3@x", "c4@x"]);
  eq(again.items.size, 4);
});

test("réponse trop lourde : lots réduits, puis repris", async () => {
  const t = setup();
  t.server.addMessage("1", mime("big@x"));
  await syncBatch(t.ctx, t.coll);
  t.server.hook("Sync", () => {
    throw new EasError(ERR.TOO_LARGE, "trop gros", { sent: true });
  });
  await syncCollection(t.ctx, t.coll);
  const windows = t.server.sent("Sync").map((r) => text(at(r, "Collections", "Collection"), "WindowSize"));
  eq(windows.slice(1), ["50", "25"]);
  eq(t.store.mids("/Inbox"), ["big@x"]);
});

// ── Local changes sent (journal uploads and moves) ────────────────────────

test("envoi : drapeaux en Change, suppression en Delete avec DeletesAsMoves=1 (0 depuis la corbeille)", async () => {
  const t = setup();
  const a = t.server.addMessage("1", mime("a@x"));
  const b = t.server.addMessage("1", mime("b@x"));
  await syncCollection(t.ctx, t.coll);
  t.store.userFlags("/Inbox", "a@x", { read: true });
  t.store.userDelete("/Inbox", "b@x");
  t.newPass();
  const r = await syncBatch(t.ctx, t.coll, {
    uploads: [
      { id: 1, op: "flags", path: "/Inbox", messageId: "a@x", flags: { read: true } },
      { id: 2, op: "delete", path: "/Inbox", messageId: "b@x" },
      { id: 3, op: "flags", path: "/Inbox", messageId: "inconnu@x", flags: { read: true } },
    ],
  });
  eq([...r.outcomes].sort(), [[1, "done"], [2, "done"], [3, "done"]]);
  const req = t.server.sent("Sync").at(-1);
  eq(text(at(req, "Collections", "Collection"), "DeletesAsMoves"), "1");
  eq(commandsOf(req).map((c) => [c.tag, text(c, "ServerId")]), [["Change", a], ["Delete", b]]);
  eq(t.server.items.get("1").get(a).read, true);
  assert(!t.server.items.get("1").has(b));
  eq(t.server.items.get("3").size, 1, "vers les éléments supprimés du serveur");
  assert(!t.coll.items.has(b));
  // From the trash: DeletesAsMoves=0.
  await syncCollection(t.ctx, t.trash);
  t.store.userDelete("/Trash", "b@x");
  t.newPass();
  await syncBatch(t.ctx, t.trash, { uploads: [{ id: 4, op: "delete", path: "/Trash", messageId: "b@x" }] });
  eq(text(at(t.server.sent("Sync").at(-1), "Collections", "Collection"), "DeletesAsMoves"), "0");
  eq(t.server.items.get("3").size, 0);
});

test("envoi : suppression rapprochée par nombre de copies (une copie restante → rien à supprimer)", async () => {
  const t = setup();
  t.server.addMessage("1", mime("c@x"));
  await syncCollection(t.ctx, t.coll);
  // The user had a local copy (not attached), and deletes one of the two: one copy left, one ServerId: nothing to delete.
  t.store.folders.get("/Inbox").msgs.set(999, { mid: "c@x", read: false, flagged: false });
  t.store.userDelete("/Inbox", "c@x");
  t.newPass();
  const r = await syncBatch(t.ctx, t.coll, { uploads: [{ id: 1, op: "delete", path: "/Inbox", messageId: "c@x" }] });
  eq(r.outcomes.get(1), "done");
  eq(commandsOf(t.server.sent("Sync").at(-1)).length, 0);
  eq(t.coll.refs("c@x"), 1);
});

test("envoi : un refus par élément est définitif ou passager selon son statut", async () => {
  const t = setup();
  const a = t.server.addMessage("1", mime("a@x"));
  const b = t.server.addMessage("1", mime("b@x"));
  await syncCollection(t.ctx, t.coll);
  t.server.changeStatus.set(a, "6");
  t.server.changeStatus.set(b, "5");
  t.newPass();
  const r = await syncBatch(t.ctx, t.coll, {
    uploads: [
      { id: 1, op: "flags", path: "/Inbox", messageId: "a@x", flags: { read: true } },
      { id: 2, op: "flags", path: "/Inbox", messageId: "b@x", flags: { read: true } },
    ],
  });
  eq(r.outcomes.get(1), "drop");
  eq(r.outcomes.get(2), "keep");
});

test("envoi : réponse vide ou SyncKey initiale → rien d'acquitté", async () => {
  const t = setup();
  const up = [{ id: 1, op: "flags", path: "/Inbox", messageId: "a@x", flags: { read: true } }];
  let r = await syncBatch(t.ctx, t.coll, { uploads: up });
  eq(r.outcomes.get(1), "keep", "SyncKey 0 : impossible d'envoyer");
  t.server.addMessage("1", mime("a@x"));
  await syncCollection(t.ctx, t.coll);
  t.server.hook("Sync", () => null);
  t.newPass();
  r = await syncBatch(t.ctx, t.coll, { uploads: up });
  eq(r.outcomes.get(1), "keep");
});

test("déplacements : MoveItems avec le bon SrcMsgId, tables mises à jour, statuts par élément", async () => {
  const t = setup();
  const projets = new CollectionState("6", { path: "/Inbox/Projets", syncKey: "1" });
  t.colls.set("6", projets);
  t.store.userAddFolder("/Inbox/Projets");
  const sids = ["a", "b", "c"].map((m) => t.server.addMessage("1", mime(`${m}@x`)));
  await syncCollection(t.ctx, t.coll);
  for (const m of ["a", "b", "c"]) t.store.userMove("/Inbox", `${m}@x`, "/Inbox/Projets");
  t.server.moveStatus.set(sids[1], "7"); // locked: try again later
  t.server.items.get("1").delete(sids[2]); // gone from the server meanwhile
  const entries = ["a", "b", "c"].map((m, i) => ({ id: i + 1, op: "move", path: "/Inbox", toPath: "/Inbox/Projets", messageId: `${m}@x` }));
  const r = await replayMoves(t.ctx, entries, t.ctx.collectionOf);
  const req = t.server.sent("MoveItems")[0];
  eq(req.children.map((m) => text(m, "SrcMsgId")), sids);
  eq(req.children.map((m) => [text(m, "SrcFldId"), text(m, "DstFldId")]), [["1", "6"], ["1", "6"], ["1", "6"]]);
  eq([r.outcomes.get(1), r.outcomes.get(2), r.outcomes.get(3)], ["done", "keep", "drop"]);
  eq(t.coll.refs("a@x"), 0);
  eq(projets.refs("a@x"), 1);
  assert(t.server.items.get("6").has(projets.serverIdsOf("a@x")[0]), "DstMsgId gardé");
  eq(t.coll.refs("b@x"), 1, "gardé pour le prochain essai");
  eq(t.coll.refs("c@x"), 0);
  const saved = await loadCollection(t.records, "6");
  eq(saved.refs("a@x"), 1);
});

test("déplacements : vers un dossier non synchronisé → suppression ; rien à faire si la copie est revenue", async () => {
  const t = setup();
  t.server.addMessage("1", mime("a@x"));
  t.server.addMessage("1", mime("b@x"));
  await syncCollection(t.ctx, t.coll);
  t.store.userAddFolder("/Local");
  t.store.userMove("/Inbox", "a@x", "/Local");
  const r = await replayMoves(
    t.ctx,
    [
      { id: 1, op: "move", path: "/Inbox", toPath: "/Local", messageId: "a@x" },
      { id: 2, op: "move", path: "/Inbox", toPath: "/Inbox/Projets", messageId: "b@x" }, // moved, then moved back
    ],
    t.ctx.collectionOf,
  );
  eq(r.unmapped.map((e) => e.id), [1]);
  eq(r.outcomes.get(2), "done");
  eq(t.server.sent("MoveItems").length, 0);
});

test("synchro : le serveur ne reçoit jamais de requête sans signal transmis", async () => {
  const t = setup();
  const ctrl = new AbortController();
  t.ctx.signal = ctrl.signal;
  t.server.addMessage("1", mime("s@x"));
  await syncCollection(t.ctx, t.coll);
  assert(t.server.requests.every((r) => r.opts.signal === ctrl.signal));
  assert(t.server.requests.every((r) => Number.isInteger(r.opts.timeoutMs) && Number.isInteger(r.opts.maxBytes)));
});

test("synchro : statut de dossier 12 (hiérarchie changée) → rien d'appliqué, FolderSync attendu", async () => {
  const t = setup();
  await syncBatch(t.ctx, t.coll);
  t.server.hook("Sync", (req) => el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", "1"), el("CollectionId", "1"), el("Status", "12")])])]));
  const r = await syncCollection(t.ctx, t.coll);
  eq(r.stale, true);
  assert(t.ctx.pass.hierarchyChanged);
  t.server.hook("Sync", () => el("AirSync:Sync", [el("Status", "110")]));
  await rejects(syncBatch(t.ctx, t.coll), (e) => e.code === "SERVER");
  eq(collRecord("1"), "coll:1");
});

test("suppression puis ajout du même message dans un lot (élément recréé) : aucune copie en plus, rien à la corbeille", async () => {
  const t = setup();
  const sid = t.server.addMessage("1", mime("re@x"));
  await syncCollection(t.ctx, t.coll);
  const item = t.server.items.get("1").get(sid);
  t.server.deleteMessage("1", sid);
  const again = t.server.addMessage("1", item.mime, { read: true });
  t.newPass();
  await syncCollection(t.ctx, t.coll);
  eq(t.store.mids("/Inbox"), ["re@x"]);
  eq(t.store.mids("/Trash"), []);
  eq(t.coll.serverIdsOf("re@x"), [again]);
  eq(t.store.messages("/Inbox")[0].read, true);
});

test("suppressions laissées en suspens par un passage interrompu : décidées au passage suivant", async () => {
  const t = setup();
  const sids = ["l1", "l2"].map((m) => t.server.addMessage("1", mime(`${m}@x`)));
  await syncCollection(t.ctx, t.coll);
  // The pass received the deletion, wrote it, moved the SyncKey on… and stopped before deciding.
  t.server.deleteMessage("1", sids[0]);
  t.newPass();
  await syncBatch(t.ctx, t.coll);
  const pending = await loadPendingDeletes(t.records);
  eq(pending.get("1"), { items: [[sids[0], "l1@x"]], at: 1000, retained: false });
  eq(t.store.mids("/Inbox"), ["l1@x", "l2@x"], "pas encore appliquée");
  t.newPass();
  await syncCollection(t.ctx, t.coll);
  eq(t.store.mids("/Inbox"), ["l2@x"]);
  eq(t.store.mids("/Trash"), ["l1@x"]);
  eq((await loadPendingDeletes(t.records)).size, 0);
});

test("lot refusé en entier plusieurs passages de suite : laissé passer en quarantaine, le dossier n'est pas bloqué à jamais", async () => {
  const t = setup();
  t.ctx.stuck = new Map();
  for (const n of [1, 2]) t.server.addMessage("1", mime(`z${n}@x`));
  await syncBatch(t.ctx, t.coll);
  t.store.failAll = true;
  for (let k = 0; k < 2; k++) {
    t.newPass();
    await rejects(syncBatch(t.ctx, await loadCollection(t.records, "1")), (e) => e.code === "LOCAL");
  }
  t.newPass();
  const coll = await loadCollection(t.records, "1");
  await syncBatch(t.ctx, coll);
  eq(coll.syncKey, "2");
  eq(coll.quarantine.length, 2);
  assert(t.log.lines.some(([lvl]) => lvl === "error"));
});
