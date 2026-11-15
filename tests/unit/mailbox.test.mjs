// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * MailboxSync (src/sync/mailbox.mjs): whole passes against the fake
 * ActiveSync server and the fake Thunderbird account of mail-sync.test.mjs,
 * with the real Store on an in-memory storage area.
 */

import { test, assert, eq, rejects } from "./harness.mjs";
import { text, at, child } from "../../src/core/wbxml.mjs";
import { EasError, ERR } from "../../src/transport/client.mjs";
import { Store } from "../../src/sync/store.mjs";
import { MailboxSync, MASS_DELETE } from "../../src/sync/mailbox.mjs";
import { loadCollection } from "../../src/sync/mail.mjs";
import { FakeServer, FakeMailStore, mime, quietLog } from "./mail-sync.test.mjs";
import { memoryArea } from "./journal.test.mjs";
import { fakeBrowser } from "./mail-store.test.mjs";
import { MailStore } from "../../src/tb/mail-store.mjs";
import { LocalEvents } from "../../src/tb/events.mjs";
import { EchoRegistry } from "../../src/sync/echo.mjs";

const MB = "0123456789ab";

function world({ sync = { mail: true, calendar: true, contacts: true, tasks: true }, push } = {}) {
  const server = new FakeServer();
  const store = new FakeMailStore();
  const area = memoryArea();
  const st = new Store(area);
  let t = 1_000_000;
  const log = quietLog();
  const mailbox = { id: MB, accountKey: "account1", filterType: "0", sync };
  const w = {
    server,
    store,
    area,
    records: st.mailbox(MB),
    mailbox,
    log,
    clients: 0,
    advance: (ms) => (t += ms),
    now: () => t,
    make: () =>
      new MailboxSync({
        mailbox,
        store: st,
        clientFactory: async () => {
          w.clients++;
          return server;
        },
        mailStore: store,
        log,
        now: () => t,
        random: () => 0.5,
        sleep: async (ms) => {
          t += ms;
        },
        push,
      }),
  };
  w.sync = w.make();
  return w;
}

const syncedIds = (server, from = 0) => server.requests.slice(from).filter((r) => r.cmd === "Sync").map((r) => text(at(r.req, "Collections", "Collection"), "CollectionId"));
const health = (w) => w.records.get("health", null);
const ticks = async (n = 50) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

test("passage : FolderSync, dossiers locaux, collections (réception d'abord, corbeille en dernier), courrier seulement", async () => {
  const w = world();
  w.server.addMessage("1", mime("a@x"));
  w.server.addMessage("6", mime("p@x"));
  w.server.addMessage("3", mime("t@x"));
  w.server.addMessage("5", mime("envoi@x")); // Outbox: never synchronised
  const r = await w.sync.run({ reason: "user" });
  eq([r.status, r.added], ["ok", 3]);
  eq(w.store.mids("/Inbox"), ["a@x"]);
  eq(w.store.mids("/Inbox/Projets"), ["p@x"]);
  eq(w.store.mids("/Trash"), ["t@x"]);
  assert(!w.store.folders.has("/Unsent Messages"), "pas de boîte d'envoi locale");
  const ids = syncedIds(w.server);
  assert(!ids.includes("5") && !ids.includes("7"), "ni boîte d'envoi ni calendrier");
  eq(ids[0], "1");
  eq(ids.at(-1), "3");
  eq(w.server.requests[0].cmd, "FolderSync");
  const h = await health(w);
  eq([h.failures, h.blocked, h.lastSuccessAt], [0, null, w.now()]);
  eq((await loadCollection(w.records, "6")).path, "/Inbox/Projets");
});

test("passage : rien de choisi que cette version synchronise → aucune requête", async () => {
  const w = world({ sync: { mail: false, calendar: true, contacts: true, tasks: true } });
  const r = await w.sync.run({ reason: "user" });
  eq(r.status, "ok");
  eq(w.server.requests.length, 0);
});

test("redémarrage : identifiants renumérotés, suppression et déplacement locaux touchent le bon élément du serveur", async () => {
  const w = world();
  const sids = ["m1", "m2", "m3"].map((m) => w.server.addMessage("1", mime(`${m}@x`)));
  await w.sync.run({ reason: "user" });
  // Thunderbird and the extension restart: new ids, a new engine, the same storage.
  w.store.restart();
  const sync = w.make();
  await sync.recordIntent(w.store.userDelete("/Inbox", "m2@x"));
  await sync.recordIntent(w.store.userMove("/Inbox", "m3@x", "/Inbox/Projets"));
  const before = w.server.requests.length;
  const r = await sync.run({ reason: "timer" });
  eq(r.sent, 2);
  const upload = w.server.requests.slice(before).find((x) => x.cmd === "Sync" && child(at(x.req, "Collections", "Collection"), "Commands"));
  const c = at(upload.req, "Collections", "Collection");
  eq(text(c, "DeletesAsMoves"), "1");
  eq(child(c, "Commands").children.map((x) => [x.tag, text(x, "ServerId")]), [["Delete", sids[1]]]);
  const move = w.server.sent("MoveItems")[0];
  eq(move.children.map((m) => [text(m, "SrcMsgId"), text(m, "SrcFldId"), text(m, "DstFldId")]), [[sids[2], "1", "6"]]);
  eq([...w.server.items.get("1").keys()], [sids[0]]);
  eq(w.server.items.get("6").size, 1);
  eq(await sync.journal.size(), 0);
  const projets = await loadCollection(w.records, "6");
  eq(projets.refs("m3@x"), 1, "rattaché dans le dossier de destination");
  eq(w.store.mids("/Trash"), ["m2@x"], "filet : la suppression définitive locale revient par la corbeille du serveur");
  eq(w.store.mids("/Inbox"), ["m1@x"]);
});

test("journal : survit aux pannes, acquitté élément par élément", async () => {
  const w = world();
  const sids = ["a", "b"].map((m) => w.server.addMessage("1", mime(`${m}@x`)));
  await w.sync.run({ reason: "user" });
  await w.sync.recordIntent(w.store.userMove("/Inbox", "a@x", "/Inbox/Projets"));
  await w.sync.recordIntent(w.store.userMove("/Inbox", "b@x", "/Inbox/Projets"));
  w.server.hook("MoveItems", () => {
    throw new EasError(ERR.NETWORK, "Serveur injoignable.", { sent: true });
  });
  await rejects(w.sync.run({ reason: "timer" }), (e) => e.code === ERR.NETWORK);
  eq(await w.sync.journal.size(), 2, "rien de perdu");
  const h = await health(w);
  assert(h.failures === 1 && h.nextAttemptAt > w.now());
  const skipped = await w.sync.run({ reason: "timer" });
  eq([skipped.status, skipped.reason], ["skipped", "backoff"]);
  w.advance(60 * 60_000);
  w.server.moveStatus.set(sids[1], "7"); // locked: later
  const r = await w.sync.run({ reason: "timer" });
  eq(r.sent, 1);
  const left = await w.sync.journal.list();
  eq(left.map((e) => [e.messageId, e.attempts]), [["b@x", 1]]);
  w.server.moveStatus.clear();
  await w.sync.run({ reason: "timer" });
  eq(await w.sync.journal.size(), 0);
  eq(w.server.items.get("6").size, 2);
});

test("Status 3 : la table est vidée puis reconstruite, rien n'est importé en double", async () => {
  const w = world();
  for (const m of ["x", "y", "z"]) w.server.addMessage("1", mime(`${m}@x`));
  await w.sync.run({ reason: "user" });
  const imports = w.store.writes.filter((x) => x[0] === "import").length;
  w.server.invalidate("1");
  await w.sync.run({ reason: "user" });
  eq(w.store.writes.filter((x) => x[0] === "import").length, imports);
  eq((await loadCollection(w.records, "1")).items.size, 3);
  eq(w.store.mids("/Inbox"), ["x@x", "y@x", "z@x"]);
});

test("suppression en masse : retenue, boîte bloquée, puis confirmée", async () => {
  const w = world();
  for (let n = 0; n < 100; n++) w.server.addMessage("1", mime(`k${n}@x`));
  await w.sync.run({ reason: "user" });
  eq(w.store.messages("/Inbox").length, 100);
  for (const sid of [...w.server.items.get("1").keys()].slice(0, 60)) w.server.deleteMessage("1", sid);
  const r = await w.sync.run({ reason: "timer" });
  eq([r.status, r.reason, r.pendingDeletes], ["blocked", MASS_DELETE, 60]);
  eq(w.store.messages("/Inbox").length, 100, "rien supprimé localement");
  eq((await health(w)).blocked.code, MASS_DELETE);
  const n = w.server.requests.length;
  for (const reason of ["timer", "push", "user"]) {
    const again = await w.sync.run({ reason });
    eq([again.status, again.reason], ["blocked", MASS_DELETE], reason);
  }
  eq(w.server.requests.length, n, "aucune synchro tant que l'utilisateur n'a pas décidé");
  eq(await w.sync.pendingDeletes(), { count: 60, collections: [{ collectionId: "1", count: 60, at: w.now() }] });
  const ok = await w.sync.run({ reason: "user", confirmDeletes: true });
  eq(ok.status, "ok");
  eq(w.store.messages("/Inbox").length, 40);
  eq(w.store.messages("/Trash").length, 60, "dans la corbeille locale");
  eq((await health(w)).blocked, null);
  eq((await w.sync.pendingDeletes()).count, 0);
});

test("suppression en masse : refusée par l'utilisateur, copies gardées, table reconstruite", async () => {
  const w = world();
  for (let n = 0; n < 100; n++) w.server.addMessage("1", mime(`k${n}@x`));
  await w.sync.run({ reason: "user" });
  for (const sid of [...w.server.items.get("1").keys()].slice(0, 60)) w.server.deleteMessage("1", sid);
  await w.sync.run({ reason: "timer" });
  await w.sync.discardPendingDeletes();
  eq((await health(w)).blocked, null);
  const r = await w.sync.run({ reason: "timer" });
  eq(r.status, "ok");
  eq(w.store.messages("/Inbox").length, 100, "les copies locales restent");
  eq((await loadCollection(w.records, "1")).items.size, 40, "table : ce que le serveur a vraiment");
  eq(w.store.messages("/Trash").length, 0);
});

test("suppressions sous le seuil : appliquées à la fin du passage, même réparties sur plusieurs lots", async () => {
  const w = world();
  for (let n = 0; n < 400; n++) w.server.addMessage("1", mime(`s${n}@x`));
  await w.sync.run({ reason: "user" });
  for (const sid of [...w.server.items.get("1").keys()].slice(0, 70)) w.server.deleteMessage("1", sid);
  const r = await w.sync.run({ reason: "timer" });
  eq([r.status, r.deleted], ["ok", 70]);
  eq(w.store.messages("/Trash").length, 70);
});

test("dossiers : création, renommage, mise à la corbeille puis suppression depuis la corbeille", async () => {
  const w = world();
  await w.sync.run({ reason: "user" });
  w.store.userAddFolder("/Inbox/Nouveau");
  await w.sync.recordIntent({ kind: "folderCreate", path: "/Inbox/Nouveau" });
  await w.sync.run({ reason: "timer" });
  const create = w.server.sent("FolderCreate")[0];
  eq([text(create, "ParentId"), text(create, "DisplayName"), text(create, "Type")], ["1", "Nouveau", "12"]);
  const id = [...w.server.folders].find(([, f]) => f.name === "Nouveau")[0];

  w.store.userRenameFolder("/Inbox/Nouveau", "/Inbox/Renommé");
  await w.sync.recordIntent({ kind: "folderRename", path: "/Inbox/Nouveau", toPath: "/Inbox/Renommé" });
  await w.sync.run({ reason: "timer" });
  eq(w.server.folders.get(id).name, "Renommé");

  w.store.userRenameFolder("/Inbox/Renommé", "/Trash/Renommé"); // Thunderbird "deletes" a folder into the trash
  await w.sync.recordIntent({ kind: "folderMove", path: "/Inbox/Renommé", toPath: "/Trash/Renommé" });
  await w.sync.run({ reason: "timer" });
  eq(w.server.folders.get(id).parentId, "3");

  w.store.userRemoveFolder("/Trash/Renommé");
  await w.sync.recordIntent({ kind: "folderDelete", path: "/Trash/Renommé" });
  await w.sync.run({ reason: "timer" });
  assert(!w.server.folders.has(id), "supprimé depuis la corbeille");
  eq(await w.records.get(`coll:${id}`, null), null);
  eq(await w.sync.journal.size(), 0);
  eq(w.store.folders.has("/Trash/Renommé"), false, "pas recréé");
});

test("dossiers : suppression hors corbeille jamais transmise, le dossier revient et se resynchronise", async () => {
  const w = world();
  w.server.addMessage("6", mime("p1@x"));
  await w.sync.run({ reason: "user" });
  w.store.userRemoveFolder("/Inbox/Projets");
  await w.sync.recordIntent({ kind: "folderDelete", path: "/Inbox/Projets" });
  await w.sync.run({ reason: "timer" });
  eq(w.server.sent("FolderDelete").length, 0);
  assert(w.server.folders.has("6"));
  await w.sync.run({ reason: "timer" });
  eq(w.store.mids("/Inbox/Projets"), ["p1@x"], "recréé, contenu rechargé");
  // A special folder is never renamed on the server.
  await w.sync.recordIntent({ kind: "folderRename", path: "/Inbox", toPath: "/Arrivée" });
  await w.sync.run({ reason: "timer" });
  eq(w.server.sent("FolderUpdate").length, 0);
});

test("dossiers : renommé puis supprimé sur le serveur → suivi localement, copie mise à la corbeille", async () => {
  const w = world();
  w.server.addMessage("6", mime("p@x"));
  await w.sync.run({ reason: "user" });
  const imports = w.store.writes.filter((x) => x[0] === "import").length;
  w.server.updateFolder("6", { name: "Projets 2026" });
  await w.sync.run({ reason: "timer" });
  eq(w.store.mids("/Inbox/Projets 2026"), ["p@x"]);
  assert(!w.store.folders.has("/Inbox/Projets"));
  eq(w.store.writes.filter((x) => x[0] === "import").length, imports, "messages gardés, pas rechargés");
  eq((await loadCollection(w.records, "6")).path, "/Inbox/Projets 2026");
  w.server.deleteFolder("6");
  await w.sync.run({ reason: "timer" });
  eq(w.store.mids("/Trash/Projets 2026"), ["p@x"]);
  eq(await w.records.get("coll:6", null), null);
});

test("verrou : un passage à la fois, demandes en attente fusionnées, cancel() ne libère rien de force", async () => {
  const w = world();
  await w.sync.run({ reason: "user" });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let seen = null;
  w.server.hook("FolderSync", async (req, opts) => {
    seen = opts.signal;
    await gate; // ignores the abort: the pass stops only when it gets control back
    return undefined;
  });
  const first = w.sync.run({ reason: "user" });
  await ticks();
  assert(w.sync.running);
  const second = w.sync.run({ reason: "timer", folders: ["1"] });
  const third = w.sync.run({ reason: "push", folders: ["6"] });
  eq(second, third, "fusionnées");
  w.sync.cancel();
  assert(seen.aborted, "annulation transmise à la requête en cours");
  const n = w.server.requests.length;
  await ticks(200);
  eq(w.server.requests.length, n, "le passage suivant attend la fin réelle du premier");
  assert(w.sync.running);
  release();
  await rejects(first, (e) => e.code === ERR.CANCELLED);
  const r = await second;
  eq(r.status, "ok");
  const ids = syncedIds(w.server, n);
  assert(ids.includes("1") && ids.includes("6") && !ids.includes("2"), `dossiers fusionnés : ${ids}`);
});

test("annulation : signal transmis, SyncKey non avancée, santé inchangée", async () => {
  const w = world();
  w.server.addMessage("1", mime("a@x"));
  await w.sync.run({ reason: "user" });
  const key = (await loadCollection(w.records, "1")).syncKey;
  w.server.addMessage("1", mime("b@x"));
  const ctrl = new AbortController();
  w.server.hook("Sync", (req, opts) => {
    eq(opts.signal.aborted, false);
    ctrl.abort();
    return undefined; // the fake server then sees the aborted signal
  });
  await rejects(w.sync.run({ reason: "timer", signal: ctrl.signal }), (e) => e.code === ERR.CANCELLED);
  eq((await loadCollection(w.records, "1")).syncKey, key);
  const h = await health(w);
  eq([h.failures, h.lastError], [0, null]);
  assert(!w.sync.running);
  await w.sync.run({ reason: "timer" });
  eq(w.store.mids("/Inbox"), ["a@x", "b@x"]);
});

test("santé : erreur fatale bloque, automatique ignoré, l'utilisateur relance", async () => {
  const w = world();
  w.server.hook("FolderSync", () => {
    throw new EasError(ERR.AUTH, "Identifiant ou mot de passe refusé par le serveur.");
  });
  await rejects(w.sync.run({ reason: "timer" }), (e) => e.code === ERR.AUTH);
  eq((await health(w)).blocked.code, "AUTH");
  const n = w.server.requests.length;
  const r = await w.sync.run({ reason: "timer" });
  eq([r.status, r.reason], ["skipped", "AUTH"]);
  eq(w.server.requests.length, n);
  eq((await w.sync.run({ reason: "user" })).status, "ok");
  eq((await health(w)).blocked, null);
});

test("ping : dossiers de courrier seulement (ni boîte d'envoi ni calendrier), changements → passage ciblé", async () => {
  const w = world();
  await w.sync.run({ reason: "user" });
  const before = w.server.requests.length;
  let pings = 0;
  w.server.pings.push(() => {
    pings++;
    return { status: "2", folders: ["6"] };
  });
  w.server.pings.push((req, opts) => {
    pings++;
    return new Promise((resolve, reject) => opts.signal.addEventListener("abort", () => reject(new EasError(ERR.CANCELLED, "annulé"))));
  });
  w.sync.startPush();
  for (let i = 0; i < 2000 && pings < 2; i++) await Promise.resolve();
  eq(pings, 2);
  await w.sync.stopPush();
  assert(!w.sync.pushing);
  const ping = w.server.sent("Ping")[0];
  const ids = child(ping, "Folders").children.map((f) => text(f, "Id")).sort();
  eq(ids, ["1", "2", "3", "4", "6"]);
  eq(syncedIds(w.server, before), ["6"], "seulement le dossier signalé");
});

test("ping : boîte bloquée → pas de Ping", async () => {
  const w = world();
  w.server.hook("FolderSync", () => {
    throw new EasError(ERR.DENIED, "refusé");
  });
  await rejects(w.sync.run({ reason: "user" }));
  w.sync.startPush();
  await ticks(200);
  eq(w.server.sent("Ping").length, 0);
  assert(!w.sync.pushing);
});

test("bout à bout : vrai adaptateur et vrais événements, nos écritures ne reviennent pas au journal, celles de l'utilisateur partent", async () => {
  const server = new FakeServer();
  const browser = fakeBrowser();
  const A = "account1";
  browser.addFolder(A, "/");
  for (const [p, u] of [["/Inbox", ["inbox"]], ["/Trash", ["trash"]], ["/Sent", ["sent"]], ["/Drafts", ["drafts"]], ["/Templates", ["templates"]]]) browser.addFolder(A, p, u);
  let t = 5_000_000;
  const echo = new EchoRegistry({ now: () => t });
  const mailStore = new MailStore({ accountKey: A, echo, browser, timers: { set: () => 0, clear() {} }, makeFile: (bytes) => ({ bytes }) });
  const st = new Store(memoryArea());
  const sync = new MailboxSync({
    mailbox: { id: MB, accountKey: A, filterType: "0", sync: { mail: true, calendar: false, contacts: false, tasks: false } },
    store: st,
    clientFactory: async () => server,
    mailStore,
    log: quietLog(),
    now: () => t,
  });
  const events = new LocalEvents({ browser, echo, isMarked: (k) => k === A, onIntent: (k, i) => sync.recordIntent(i) });
  events.start();
  const a = server.addMessage("1", mime("a@x"));
  const b = server.addMessage("1", mime("b@x"));
  server.addMessage("6", mime("p@x"));
  await sync.run({ reason: "user" });
  await events.idle();
  eq(browser.inFolder(A, "/Inbox").map((m) => m.headerMessageId).sort(), ["a@x", "b@x"]);
  eq(browser.inFolder(A, "/Inbox/Projets").map((m) => m.headerMessageId), ["p@x"]);
  eq(await sync.journal.size(), 0, "création de dossier et imports : rien au journal");

  // From the server: a flag, a deletion (to the server's trash), a folder renamed.
  server.changeFlags("1", a, { read: true });
  server.serverMove("1", b, "3");
  server.updateFolder("6", { name: "Clients" });
  await sync.run({ reason: "timer" });
  await events.idle();
  eq(browser.inFolder(A, "/Trash").map((m) => m.headerMessageId), ["b@x"]);
  assert(browser.inFolder(A, "/Inbox").find((m) => m.headerMessageId === "a@x").read);
  eq(browser.inFolder(A, "/Inbox/Clients").length, 1);
  eq(await sync.journal.size(), 0, "nos écritures sont des échos");
  eq(echo.size, 0);

  // The user, now.
  const local = browser.inFolder(A, "/Inbox").find((m) => m.headerMessageId === "a@x");
  await browser.messages.update(local.id, { read: false, flagged: true });
  await browser.messages.move([local.id], browser.folderView(A, "/Inbox/Clients").id);
  await events.idle();
  eq((await sync.journal.list()).map((e) => e.op), ["flags", "move"]);
  await sync.run({ reason: "timer" });
  await events.idle();
  eq(await sync.journal.size(), 0);
  eq(server.items.get("1").size, 0);
  const moved = [...server.items.get("6").values()].find((i) => !i.read && i.flagged);
  assert(moved, "drapeaux puis déplacement reçus par le serveur");
  t += 60_000;
  eq(echo.size, 0);
});
