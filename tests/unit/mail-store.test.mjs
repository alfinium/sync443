// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * tb/mail-store.mjs and tb/events.mjs against a fake `browser` shaped like
 * Thunderbird's WebExtension APIs (Manifest V2, Thunderbird 128+): string
 * folder ids, MessageList pages followed with continueList, events fired
 * while the API call is still running (as Thunderbird may), an import of a
 * Message-ID already in the folder refused.
 */

import { test, assert, eq, rejects } from "./harness.mjs";
import { encodeUtf8 } from "../../src/core/utf8.mjs";
import { messageIdOf } from "../../src/core/mime.mjs";
import { MailStore, MailStoreError } from "../../src/tb/mail-store.mjs";
import { LocalEvents } from "../../src/tb/events.mjs";
import { EchoRegistry } from "../../src/sync/echo.mjs";

const A = "account5";
const OTHER = "account9";

function event() {
  const listeners = new Set();
  return {
    addListener: (f) => listeners.add(f),
    removeListener: (f) => listeners.delete(f),
    hasListener: (f) => listeners.has(f),
    fire: (...args) => {
      for (const f of listeners) f(...args);
    },
    get size() {
      return listeners.size;
    },
  };
}

const under = (p, root) => p === root || p.startsWith(`${root}/`);

export function fakeBrowser({ pageSize = 2 } = {}) {
  const folders = new Map(); // id → { accountId, path, specialUse, isRoot }
  const messages = new Map(); // id → { headerMessageId, read, flagged, folderId }
  const lists = new Map();
  const calls = [];
  let nextMsg = 1;
  let nextList = 1;
  const fid = (accountId, path) => `${accountId}:/${path}`;
  const folderView = (id) => {
    const f = folders.get(id);
    return { id, accountId: f.accountId, path: f.path, name: f.isRoot ? "Root" : f.path.slice(f.path.lastIndexOf("/") + 1), specialUse: [...f.specialUse], isRoot: f.isRoot };
  };
  const msgView = (id) => {
    const m = messages.get(id);
    return { id, headerMessageId: m.headerMessageId, read: m.read, flagged: m.flagged, folder: folderView(m.folderId), tags: [] };
  };
  const pageOf = (items) => {
    const first = items.slice(0, pageSize);
    let rest = items.slice(pageSize);
    if (!rest.length) return { id: null, messages: first };
    const id = `list${nextList++}`;
    lists.set(id, rest);
    return { id, messages: first };
  };
  const ev = {
    messages: { onUpdated: event(), onMoved: event(), onDeleted: event(), onCopied: event() },
    folders: { onCreated: event(), onRenamed: event(), onMoved: event(), onDeleted: event() },
  };
  const need = (id) => {
    if (!folders.has(id)) throw new Error(`Folder not found: ${id}`);
    return folders.get(id);
  };
  const rebase = (accountId, from, to, toAccount = accountId) => {
    for (const [id, f] of [...folders]) {
      if (f.accountId !== accountId || !under(f.path, from)) continue;
      folders.delete(id);
      const path = to + f.path.slice(from.length);
      const nid = fid(toAccount, path);
      folders.set(nid, { ...f, accountId: toAccount, path });
      for (const m of messages.values()) if (m.folderId === id) m.folderId = nid;
    }
  };

  const browser = {
    calls,
    ev,
    addFolder(accountId, path, specialUse = []) {
      folders.set(fid(accountId, path), { accountId, path, specialUse, isRoot: path === "/" });
      return fid(accountId, path);
    },
    addMessage(accountId, path, headerMessageId, { read = false, flagged = false } = {}) {
      const id = nextMsg++;
      messages.set(id, { headerMessageId, read, flagged, folderId: fid(accountId, path) });
      return id;
    },
    view: msgView,
    folderView: (accountId, path) => folderView(fid(accountId, path)),
    inFolder: (accountId, path) => [...messages].filter(([, m]) => m.folderId === fid(accountId, path)).map(([id]) => msgView(id)),
    pageOf,
    folders: {
      ...ev.folders,
      async query(q = {}) {
        calls.push(["folders.query", q]);
        return [...folders.keys()]
          .map(folderView)
          .filter((f) => (!q.accountId || f.accountId === q.accountId) && (q.path === undefined || f.path === q.path))
          .filter((f) => (q.isRoot === undefined || f.isRoot === q.isRoot) && (!q.specialUse || q.specialUse.every((u) => f.specialUse.includes(u))));
      },
      async create(parentId, name) {
        calls.push(["folders.create", parentId, name]);
        const p = need(parentId);
        const path = p.path === "/" ? `/${name}` : `${p.path}/${name}`;
        const id = browser.addFolder(p.accountId, path);
        ev.folders.onCreated.fire(folderView(id));
        return folderView(id);
      },
      async rename(id, newName) {
        calls.push(["folders.rename", id, newName]);
        const f = need(id);
        const before = folderView(id);
        const to = `${f.path.slice(0, f.path.lastIndexOf("/"))}/${newName}`;
        rebase(f.accountId, f.path, to);
        ev.folders.onRenamed.fire(before, folderView(fid(f.accountId, to)));
        return folderView(fid(f.accountId, to));
      },
      async move(id, destId) {
        calls.push(["folders.move", id, destId]);
        const f = need(id);
        const d = need(destId);
        const before = folderView(id);
        const to = `${d.path === "/" ? "" : d.path}/${f.path.slice(f.path.lastIndexOf("/") + 1)}`;
        rebase(f.accountId, f.path, to, d.accountId);
        ev.folders.onMoved.fire(before, folderView(fid(d.accountId, to)));
        return folderView(fid(d.accountId, to));
      },
      async delete(id) {
        calls.push(["folders.delete", id]);
        const before = folderView(id);
        folders.delete(id);
        ev.folders.onDeleted.fire(before);
      },
    },
    messages: {
      ...ev.messages,
      async query(q) {
        calls.push(["messages.query", q]);
        const items = [...messages].filter(([, m]) => m.folderId === q.folderId && (!q.headerMessageId || m.headerMessageId === q.headerMessageId));
        return pageOf(items.map(([id]) => msgView(id)));
      },
      async list(folderId) {
        calls.push(["messages.list", folderId]);
        return pageOf([...messages].filter(([, m]) => m.folderId === folderId).map(([id]) => msgView(id)));
      },
      async continueList(id) {
        calls.push(["messages.continueList", id]);
        const rest = lists.get(id);
        lists.delete(id);
        return pageOf(rest);
      },
      async get(id) {
        if (!messages.has(id)) throw new Error(`Message not found: ${id}.`);
        return msgView(id);
      },
      async update(id, props) {
        calls.push(["messages.update", id, props]);
        const m = messages.get(id);
        const old = {};
        for (const k of Object.keys(props)) old[k] = m[k];
        Object.assign(m, props);
        ev.messages.onUpdated.fire(msgView(id), { ...props }, old);
      },
      async move(ids, destId, options) {
        calls.push(["messages.move", ids, destId, options]);
        need(destId);
        const before = ids.map(msgView);
        const after = [];
        for (const id of ids) {
          const m = messages.get(id);
          messages.delete(id);
          const nid = nextMsg++;
          messages.set(nid, { ...m, folderId: destId });
          after.push(msgView(nid));
        }
        ev.messages.onMoved.fire(pageOf(before), pageOf(after));
      },
      async delete(ids, options) {
        calls.push(["messages.delete", ids, options]);
        const before = ids.map(msgView);
        for (const id of ids) messages.delete(id);
        ev.messages.onDeleted.fire(pageOf(before));
      },
      import: async (file, folderId, props) => {
        calls.push(["messages.import", folderId, props]);
        if (browser.importHangs) return new Promise(() => {});
        const mid = messageIdOf(file.bytes);
        if ([...messages.values()].some((m) => m.folderId === folderId && m.headerMessageId === mid)) {
          throw new Error(`Error importing message: Destination folder already contains a message with id <${mid}>`);
        }
        const id = nextMsg++;
        messages.set(id, { headerMessageId: mid, read: props.read, flagged: props.flagged, folderId });
        return msgView(id);
      },
    },
  };
  return browser;
}

/** Timers whose callbacks run when the test says so. */
function manualTimers() {
  const pending = new Map();
  let next = 1;
  return {
    set: (fn, ms) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clear: (id) => pending.delete(id),
    fireAll: () => {
      for (const [id, t] of [...pending]) {
        pending.delete(id);
        t.fn();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

function account() {
  const browser = fakeBrowser();
  browser.addFolder(A, "/", []);
  for (const [p, u] of [["/Inbox", ["inbox"]], ["/Trash", ["trash"]], ["/Sent", ["sent"]], ["/Projets", []]]) browser.addFolder(A, p, u);
  browser.addFolder(OTHER, "/", []);
  browser.addFolder(OTHER, "/Inbox", ["inbox"]);
  browser.addFolder(OTHER, "/Projets", []);
  const echo = new EchoRegistry({ now: () => 0 });
  const timers = manualTimers();
  const store = new MailStore({ accountKey: A, echo, browser, timers, makeFile: (bytes) => ({ bytes }) });
  const intents = [];
  const events = new LocalEvents({ browser, echo, isMarked: (k) => k === A, onIntent: (k, i) => intents.push([k, i]) });
  events.start();
  return { browser, echo, timers, store, intents, events };
}

const mime = (mid) => encodeUtf8(`Message-ID: <${mid}>\r\nSubject: t\r\n\r\ncorps\r\n`);

// ── MailStore ─────────────────────────────────────────────────────────────

test("magasin : dossiers de ce compte seulement, racine exclue", async () => {
  const { store } = account();
  const list = await store.listFolders();
  eq(list.map((f) => f.path).sort(), ["/Inbox", "/Projets", "/Sent", "/Trash"]);
  eq(list.find((f) => f.path === "/Trash").specialUse, ["trash"]);
  assert(await store.folderExists("/Projets"));
  assert(!(await store.folderExists("/Absent")));
  assert(!(await store.folderExists("Inbox")), "chemin invalide");
});

test("magasin : jamais un message d'un autre compte, même chemin", async () => {
  const { store, browser } = account();
  browser.addMessage(OTHER, "/Inbox", "m@x");
  eq(await store.findByMessageId("/Inbox", "m@x"), []);
  const foreign = browser.addMessage(OTHER, "/Inbox", "n@x");
  eq(await store.setFlags(foreign, { read: true }), false);
  eq((await store.moveMessages([foreign], "/Projets")).moved, []);
  eq(browser.view(foreign).folder.accountId, OTHER);
});

test("magasin : recherche par Message-ID et liste, pages suivies jusqu'au bout", async () => {
  const { store, browser } = account();
  for (let i = 0; i < 3; i++) browser.addMessage(A, "/Inbox", "dup@x", { read: i === 1 });
  browser.addMessage(A, "/Inbox", "seul@x");
  browser.addMessage(A, "/Projets", "dup@x");
  const found = await store.findByMessageId("/Inbox", "dup@x");
  eq(found.length, 3);
  eq(found.map((m) => m.flags.read), [false, true, false]);
  const all = await store.listMessages("/Inbox");
  eq(all.length, 4);
  assert(browser.calls.some((c) => c[0] === "messages.continueList"));
  await rejects(store.findByMessageId("/Absent", "x"), (e) => e instanceof MailStoreError && e.code === "NOT_FOUND");
});

test("magasin : import avec drapeaux, jamais « nouveau » ; échéance de 60 s", async () => {
  const { store, browser, timers } = account();
  const { id } = await store.importMessage("/Inbox", mime("i@x"), { read: true, flagged: false });
  eq(browser.view(id).headerMessageId, "i@x");
  eq(browser.calls.find((c) => c[0] === "messages.import")[2], { read: true, flagged: false, new: false });
  eq(timers.size, 0, "minuterie levée");
  browser.importHangs = true;
  const p = store.importMessage("/Inbox", mime("j@x"), {});
  for (let i = 0; i < 100 && !timers.size; i++) await Promise.resolve();
  eq(timers.size, 1, "échéance armée");
  timers.fireAll();
  await rejects(p, (e) => e.code === "TIMEOUT");
  await rejects(store.importMessage("/Inbox", new Uint8Array(0), {}), (e) => e.code === "REFUSED");
});

test("magasin : drapeaux écrits seulement s'ils changent, écho déclaré pour ce qui change", async () => {
  const { store, browser, echo, intents, events } = account();
  const id = browser.addMessage(A, "/Inbox", "f@x", { read: false, flagged: true });
  eq(await store.setFlags(id, { read: true, flagged: true }), true);
  eq(browser.calls.filter((c) => c[0] === "messages.update").map((c) => c[2]), [{ read: true }]);
  eq(await store.setFlags(id, { read: true }), false, "rien ne change : rien n'est écrit");
  eq(browser.calls.filter((c) => c[0] === "messages.update").length, 1);
  await events.idle();
  eq(intents, [], "écho de notre écriture ignoré");
  eq(echo.size, 0, "aucune attente ne traîne");
});

test("magasin : identifiant périmé (message déplacé par l'utilisateur) → ignoré, pas touché", async () => {
  const { store, browser } = account();
  const id = browser.addMessage(A, "/Inbox", "p@x");
  const other = browser.addMessage(A, "/Projets", "p@x");
  eq(await store.setFlags(other, { read: true }, { path: "/Inbox", messageId: "p@x" }), false);
  eq(browser.view(other).read, false);
  const r = await store.moveMessages([id, other], "/Trash", { path: "/Inbox", messageId: "p@x" });
  eq([r.moved, r.skipped], [[id], [other]]);
  eq(await store.setFlags(424242, { read: true }), false, "message disparu");
});

test("magasin : déplacements et suppressions déclarent leurs échos ; suppression définitive dans la corbeille seulement", async () => {
  const { store, browser, intents, events } = account();
  const a = browser.addMessage(A, "/Inbox", "a@x");
  const b = browser.addMessage(A, "/Inbox", "b@x");
  await store.moveMessages([a, b], "/Trash");
  const inTrash = browser.inFolder(A, "/Trash");
  eq(inTrash.map((m) => m.headerMessageId).sort(), ["a@x", "b@x"]);
  const c = browser.addMessage(A, "/Inbox", "c@x");
  const r = await store.deleteMessages([inTrash[0].id, c], { permanent: true });
  eq([r.deleted, r.skipped], [[inTrash[0].id], [c]], "hors corbeille : jamais définitif");
  eq(browser.calls.find((x) => x[0] === "messages.delete")[2], { deletePermanently: true, isUserAction: false });
  const r2 = await store.deleteMessages([c]);
  eq(r2.deleted, [c]);
  eq(browser.inFolder(A, "/Inbox"), []);
  await events.idle();
  eq(intents, []);
});

test("magasin : dossiers créés, renommés, déplacés sans écho résiduel ; dossiers spéciaux protégés", async () => {
  const { store, browser, intents, events, echo } = account();
  eq(await store.createFolder("/", "Clients"), "/Clients");
  eq(await store.createFolder("/Clients", "2026"), "/Clients/2026");
  eq(await store.renameFolder("/Clients", "Pros"), "/Pros");
  eq(await store.moveFolder("/Pros", "/Projets"), "/Projets/Pros");
  assert(await store.folderExists("/Projets/Pros/2026"));
  await rejects(store.renameFolder("/Inbox", "X"), (e) => e.code === "REFUSED");
  await rejects(store.moveFolder("/Trash", "/Projets"), (e) => e.code === "REFUSED");
  await rejects(store.moveFolder("/Projets", "/Projets/Pros"), (e) => e.code === "REFUSED");
  await rejects(store.deleteFolder("/Projets/Pros"), (e) => e.code === "REFUSED", "hors corbeille");
  await rejects(store.createFolder("/", "a/b"), (e) => e.code === "REFUSED");
  await store.moveFolder("/Projets/Pros", "/Trash");
  await store.deleteFolder("/Trash/Pros");
  assert(!(await store.folderExists("/Trash/Pros")));
  await events.idle();
  eq(intents, []);
  eq(echo.size, 0);
});

test("magasin : une écriture qui échoue retire son écho (l'action suivante de l'utilisateur passe)", async () => {
  const { store, browser, intents, events } = account();
  const id = browser.addMessage(A, "/Inbox", "e@x");
  const update = browser.messages.update;
  browser.messages.update = async () => {
    throw new Error("échec");
  };
  await rejects(store.setFlags(id, { read: true }));
  browser.messages.update = update;
  await browser.messages.update(id, { read: true }); // the user marks it read
  await events.idle();
  eq(intents, [[A, { kind: "flags", path: "/Inbox", messageId: "e@x", flags: { read: true } }]]);
});

// ── Local events ──────────────────────────────────────────────────────────

test("événements : actions de l'utilisateur → intentions, comptes marqués seulement", async () => {
  const { browser, intents, events } = account();
  const id = browser.addMessage(A, "/Inbox", "u@x");
  const foreign = browser.addMessage(OTHER, "/Inbox", "v@x");
  await browser.messages.update(id, { read: true, flagged: true });
  await browser.messages.update(id, { tags: ["$label1"] });
  await browser.messages.update(foreign, { read: true });
  await events.idle();
  eq(intents, [[A, { kind: "flags", path: "/Inbox", messageId: "u@x", flags: { read: true, flagged: true } }]]);
});

test("événements : l'écho ne masque pas une vraie action de l'utilisateur", async () => {
  const { store, browser, intents, events } = account();
  const id = browser.addMessage(A, "/Inbox", "r@x");
  await store.setFlags(id, { read: true }); // the engine (from the server)
  await browser.messages.update(id, { read: false }); // the user
  await browser.messages.update(id, { read: true }); // the user again: same value as our earlier write
  await events.idle();
  eq(intents.map(([, i]) => i.flags), [{ read: false }, { read: true }]);
});

test("événements : déplacements suivis page par page, dans l'ordre", async () => {
  const { browser, intents, events } = account();
  const ids = ["1@x", "2@x", "3@x"].map((m) => browser.addMessage(A, "/Inbox", m));
  await browser.messages.move(ids, browser.folderView(A, "/Projets").id);
  const last = browser.addMessage(A, "/Inbox", "4@x");
  await browser.messages.update(last, { read: true });
  await events.idle();
  eq(intents.map(([, i]) => [i.kind, i.messageId, i.path, i.toPath]), [
    ["move", "1@x", "/Inbox", "/Projets"],
    ["move", "2@x", "/Inbox", "/Projets"],
    ["move", "3@x", "/Inbox", "/Projets"],
    ["flags", "4@x", "/Inbox", undefined],
  ]);
});

test("événements : vers un autre compte → suppression ; depuis un autre compte → rien ; destination inconnue → rien", async () => {
  const { browser, intents, events } = account();
  const out = browser.addMessage(A, "/Inbox", "out@x");
  await browser.messages.move([out], browser.folderView(OTHER, "/Projets").id);
  const inc = browser.addMessage(OTHER, "/Inbox", "in@x");
  await browser.messages.move([inc], browser.folderView(A, "/Projets").id);
  const lost = browser.addMessage(A, "/Inbox", "lost@x");
  browser.ev.messages.onMoved.fire(browser.pageOf([browser.view(lost)]), browser.pageOf([]));
  await events.idle();
  eq(intents, [[A, { kind: "delete", path: "/Inbox", messageId: "out@x" }]]);
});

test("événements : suppressions et dossiers", async () => {
  const { browser, intents, events } = account();
  const ids = ["d1@x", "d2@x", "d3@x"].map((m) => browser.addMessage(A, "/Trash", m));
  await browser.messages.delete(ids, { deletePermanently: true });
  const root = browser.folderView(A, "/").id;
  await browser.folders.create(root, "Neuf");
  await browser.folders.rename(browser.folderView(A, "/Neuf").id, "Renommé");
  await browser.folders.move(browser.folderView(A, "/Renommé").id, browser.folderView(A, "/Trash").id);
  await browser.folders.delete(browser.folderView(A, "/Trash/Renommé").id);
  await browser.folders.move(browser.folderView(A, "/Projets").id, browser.folderView(OTHER, "/").id);
  await browser.folders.create(browser.folderView(OTHER, "/").id, "Ailleurs");
  await events.idle();
  eq(intents.map(([, i]) => i), [
    { kind: "delete", path: "/Trash", messageId: "d1@x" },
    { kind: "delete", path: "/Trash", messageId: "d2@x" },
    { kind: "delete", path: "/Trash", messageId: "d3@x" },
    { kind: "folderCreate", path: "/Neuf" },
    { kind: "folderRename", path: "/Neuf", toPath: "/Renommé" },
    { kind: "folderMove", path: "/Renommé", toPath: "/Trash/Renommé" },
    { kind: "folderDelete", path: "/Trash/Renommé" },
    { kind: "folderDelete", path: "/Projets" },
  ]);
});

test("événements : stop() retire tous les écouteurs", async () => {
  const { browser, events } = account();
  eq(browser.ev.messages.onUpdated.size, 1);
  events.stop();
  for (const e of [...Object.values(browser.ev.messages), ...Object.values(browser.ev.folders)]) eq(e.size, 0);
});

test("magasin : compte invalide ou API absentes refusés", () => {
  let thrown = 0;
  for (const o of [{ accountKey: "x", echo: null, browser: fakeBrowser() }, { accountKey: A, echo: null, browser: {} }]) {
    try {
      new MailStore(o);
    } catch (e) {
      if (e instanceof MailStoreError && e.code === "CONFIG") thrown++;
    }
  }
  eq(thrown, 2);
});
