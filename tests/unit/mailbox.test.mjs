// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * MailboxSync (src/sync/mailbox.mjs): whole passes against the fake
 * ActiveSync server and the fake Thunderbird account of mail-sync.test.mjs,
 * with the real Store on an in-memory storage area. The second half adds
 * the calendar part: the real PimSync, Scheduler, InvitationTable and
 * CalendarStore over the doubles of calendar-fakes.mjs.
 */

import { test, assert, eq, rejects } from "./harness.mjs";
import { el, text, at, child, encode, decode } from "../../src/core/wbxml.mjs";
import { EasError, ERR } from "../../src/transport/client.mjs";
import { Store } from "../../src/sync/store.mjs";
import { MailboxSync, MASS_DELETE } from "../../src/sync/mailbox.mjs";
import { loadCollection } from "../../src/sync/mail.mjs";
import { FakeServer, FakeMailStore, DEFAULT_FOLDERS, mime, quietLog } from "./mail-sync.test.mjs";
import { InvitationTable } from "../../src/sync/invitations.mjs";
import { Scheduler } from "../../src/sync/scheduling.mjs";
import { PimSync } from "../../src/sync/pim.mjs";
import { CalendarStore } from "../../src/tb/calendar-store.mjs";
import { FakeCalendarApi, FakePimServer, OWN, event, task, meeting } from "./calendar-fakes.mjs";
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

// ── Mail and calendar in one pass ─────────────────────────────────────────

const CAL = "7"; // the default Calendar folder of DEFAULT_FOLDERS
const TASKS = "8";
const BOTH = [...DEFAULT_FOLDERS, { id: TASKS, parentId: "0", name: "Tâches", type: 7 }];
const ALL = { mail: true, calendar: true, contacts: false, tasks: true };
const GUEST = "anne@example.org";
const range = (n) => Array.from({ length: n }, (_, i) => i);
const until = async (done, what = "the condition never came true") => {
  for (let i = 0; i < 5000 && !done(); i++) await Promise.resolve();
  assert(done(), what);
};

/**
 * A mailbox with its calendar objects, as the background page builds them.
 * `mail`: the fake server of the folder list, of mail and of Ping; `cal`:
 * the one of the Calendar and Tasks classes, MeetingResponse and SendMail.
 * One client reaches both, as one ActiveSync server would answer.
 */
function calendarWorld({ sync = ALL, folders = BOTH } = {}) {
  const area = memoryArea();
  const st = new Store(area);
  const w = {
    mail: new FakeServer({ folders }),
    cal: new FakePimServer({ folders }),
    store: new FakeMailStore(),
    api: new FakeCalendarApi(),
    area,
    records: st.mailbox(MB),
    log: quietLog(),
    t: Date.UTC(2026, 10, 16, 9, 0, 0),
    clients: 0,
    passes: [], // options of every PimSync.pass
    noted: [], // mails told to the invitation table
    asked: [], // questions of the scheduler
    notices: [],
    confirm: null, // (question) → answer; null: "Send" at once
    clientError: null, // (n) → the error the n-th client cannot be made for, or null
    seed: 0,
  };
  w.now = () => w.t;
  w.advance = (ms) => (w.t += ms);
  w.requests = () => [...w.mail.requests, ...w.cal.requests];
  /** One request, to the server that holds its collection. */
  const command = (cmd, root, opts) => {
    w.order.push(cmd === "Sync" ? `Sync ${text(at(decode(encode(root)), "Collections", "Collection"), "CollectionId")}` : cmd);
    if (cmd === "SendMail" || cmd === "MeetingResponse") return w.cal.command(cmd, root, opts);
    if (cmd === "Sync" && w.cal.classOf(w.order.at(-1).slice(5)) !== null) return w.cal.command(cmd, root, opts);
    return w.mail.command(cmd, root, opts);
  };
  w.order = []; // every request, in order: "FolderSync", "Sync 1", "Sync 7", "SendMail"…
  /** A new engine, with its calendar objects built anew, on the same storage and the same Thunderbird. */
  w.make = (over = {}) => {
    const mailbox = { id: MB, accountKey: "account1", email: OWN, name: "Travail", filterType: "0", calendarPeriod: "7", taskFilter: "0", sync, ...over };
    w.mailbox = mailbox;
    w.invitations = new InvitationTable({ records: w.records, now: w.now });
    const note = w.invitations.noteMail.bind(w.invitations);
    w.invitations.noteMail = (cid, sid, email) => {
      w.noted.push([cid, sid]);
      return note(cid, sid, email);
    };
    w.calendarStore = new CalendarStore({ mailboxId: MB, ownEmail: OWN, api: w.api });
    w.scheduler = new Scheduler({
      mailbox,
      records: w.records,
      invitations: w.invitations,
      confirm: (question) => {
        w.asked.push(question);
        return w.confirm ? w.confirm(question) : true;
      },
      notify: (message) => w.notices.push(message),
      log: w.log,
      now: w.now,
      random: (n) => Uint8Array.from({ length: n }, () => (w.seed = (w.seed * 73 + 41) % 251)),
    });
    w.pim = new PimSync({ mailbox, records: w.records, calendarStore: w.calendarStore, scheduler: w.scheduler, log: w.log, now: w.now });
    const pass = w.pim.pass.bind(w.pim);
    w.pim.pass = (o) => {
      w.passes.push(o);
      return pass(o);
    };
    w.sync = new MailboxSync({
      mailbox,
      store: st,
      clientFactory: async () => {
        w.clients++;
        const refused = w.clientError?.(w.clients) ?? null;
        if (refused) throw refused;
        return { proto: { asVersion: "14.1" }, command };
      },
      mailStore: w.store,
      log: w.log,
      now: w.now,
      random: () => 0.5,
      sleep: async (ms) => {
        w.t += ms;
      },
      invitations: w.invitations,
      scheduler: w.scheduler,
      pim: w.pim,
    });
    return w.sync;
  };
  w.make();
  w.calendar = (slot = "main") => [...w.api.calendars].find(([, c]) => c.mailboxId === MB && c.slot === slot)?.[0] ?? null;
  w.titles = (slot = "main") => (w.calendar(slot) ? w.api.summaries(w.calendar(slot)) : null);
  w.health = () => w.records.get("health", null);
  return w;
}

test("calendar: one pass covers mail, then the calendar and the tasks, with one FolderSync and one result", async () => {
  const w = calendarWorld();
  const sid = w.mail.addMessage("1", mime("a@x"));
  w.cal.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  w.cal.addItem(TASKS, task({ uid: "t1", summary: "Rapport" }));
  const r = await w.sync.run({ reason: "user" });
  eq([r.status, r.added, r.calendar, r.failed, r.moreAvailable], ["ok", 1, { received: 2, sent: 0, failed: 0 }, 0, false]);
  eq(w.store.mids("/Inbox"), ["a@x"]);
  eq(w.titles(), ["Rapport", "Réunion"]);
  eq(w.order.filter((c) => c === "FolderSync").length, 1);
  const firstCalendar = w.order.findIndex((c) => c === `Sync ${CAL}` || c === `Sync ${TASKS}`);
  assert(firstCalendar > Math.max(...["1", "2", "3", "4", "6"].map((id) => w.order.lastIndexOf(`Sync ${id}`))), `mail first: ${w.order}`);
  assert(!w.order.includes("Sync 5"), "never the Outbox");
  eq(w.clients, 1, "one client for the pass (nothing to deliver)");
  // The calendar engine gets the pass's client, version and folder list, and never delivers under the lock.
  const [o] = w.passes;
  eq([o.version, o.deliver, o.confirmDeletes, o.only, o.folders instanceof Map && o.folders.get(CAL).type, typeof o.signal?.aborted], ["14.1", false, false, null, 8, "boolean"]);
  // The mail context got the invitation table: every mail added is shown to it.
  eq(w.noted, [["1", sid]]);
  const h = await w.health();
  eq([h.failures, h.blocked, h.lastSuccessAt, h.failedItems, h.failedCalendarItems], [0, null, w.now(), 0, undefined]);
  eq(await w.records.get("pimActive", null), true);
  assert(!w.store.folders.has("/Calendrier") && !w.store.folders.has("/Tâches"), "no mail folder for the calendar");
});

test("calendar: a mailbox without mail runs FolderSync, then the calendar and the tasks only; the folder list is saved", async () => {
  const w = calendarWorld({ sync: { mail: false, calendar: true, contacts: false, tasks: true } });
  w.mail.addMessage("1", mime("a@x"));
  w.cal.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  w.cal.addItem(TASKS, task({ uid: "t1", summary: "Rapport" }));
  const writes = w.store.writes.length;
  const r = await w.sync.run({ reason: "user" });
  eq([r.status, r.added, r.calendar.received], ["ok", 0, 2]);
  eq(w.titles(), ["Rapport", "Réunion"]);
  eq([...new Set(w.order)].sort(), ["FolderSync", `Sync ${CAL}`, `Sync ${TASKS}`], "no mail collection is asked for");
  eq([w.store.writes.length, w.store.mids("/Inbox")], [writes, []], "the mail account is left alone");
  eq(await w.records.get("hierarchy", null), { syncKey: "1" });
  const before = w.order.length;
  await w.sync.run({ reason: "timer" });
  eq(text(w.mail.sent("FolderSync").at(-1), "SyncKey"), "1", "the next pass goes on from the list as it was");
  assert(!w.order.slice(before).some((c) => /^Sync [12346]$/.test(c)));
  // Without an account of its own to write mail in, the calendar still synchronises.
  const bare = calendarWorld({ sync: { mail: false, calendar: true, contacts: false, tasks: false } });
  bare.make({ accountKey: null });
  bare.cal.addItem(CAL, event({ uid: "e1", summary: "Seul" }));
  eq((await bare.sync.run({ reason: "user" })).status, "ok");
  eq(bare.titles(), ["Seul"]);
  assert(!bare.order.includes(`Sync ${TASKS}`), "tasks are not checked");
});

test("calendar: with mail only, the calendar engine given is never called; only the calendar or the tasks checked make it run", async () => {
  const w = calendarWorld({ sync: { mail: true, calendar: false, contacts: true, tasks: false } });
  w.mail.addMessage("1", mime("a@x"));
  w.cal.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  const r = await w.sync.run({ reason: "user" });
  eq([r.status, r.added, r.calendar], ["ok", 1, undefined]);
  eq([w.passes.length, w.api.calls.length, w.api.calendars.size], [0, 0, 0], "no calendar pass, no call to Thunderbird");
  assert(!w.order.includes(`Sync ${CAL}`));
  eq(await w.records.get("pimActive", null), null);
  eq(await w.sync.pendingDeletes(), { count: 0, collections: [], calendar: 0 });
  // Contacts alone: nothing at all, as before.
  const none = calendarWorld({ sync: { mail: false, calendar: false, contacts: true, tasks: false } });
  eq((await none.sync.run({ reason: "user" })).status, "ok");
  eq([none.order.length, none.clients], [0, 0]);
});

test("calendar: its failure does not lose the mail of the pass; one failure is recorded", async () => {
  const w = calendarWorld();
  await w.sync.run({ reason: "user" });
  w.mail.addMessage("1", mime("a@x"));
  w.cal.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  w.cal.addItem(TASKS, task({ uid: "t1", summary: "Rapport" }));
  w.cal.hook("Sync", () => {
    throw new EasError(ERR.NETWORK, "Serveur injoignable.", { sent: true });
  });
  await rejects(w.sync.run({ reason: "timer" }), (e) => e.code === ERR.NETWORK);
  eq(w.store.mids("/Inbox"), ["a@x"], "the mail arrived");
  eq((await loadCollection(w.records, "1")).items.size, 1, "and its table is saved");
  eq(w.titles(), [], "nothing of the calendar in this pass");
  const h = await w.health();
  eq([h.failures, h.lastError.code, h.blocked], [1, ERR.NETWORK, null], "one failure, once");
  assert(h.nextAttemptAt > w.now());
  eq((await w.sync.run({ reason: "timer" })).reason, "backoff");
  w.advance(3600_000);
  const r = await w.sync.run({ reason: "timer" });
  eq([r.status, r.calendar.received, r.added], ["ok", 2, 0]);
  eq(w.titles(), ["Rapport", "Réunion"]);
  eq((await w.health()).failures, 0);
});

test("calendar: a failure of mail does not stop it; the error of the pass is mail's, recorded once", async () => {
  const w = calendarWorld();
  await w.sync.run({ reason: "user" });
  w.mail.addMessage("1", mime("a@x"));
  w.cal.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  w.mail.hook("Sync", () => {
    throw new EasError(ERR.HTTP, "Erreur HTTP 500.");
  });
  // Both parts fail here: the first failure is the one told, and the health counts one.
  w.cal.hook("Sync", () => {
    throw new EasError(ERR.NETWORK, "Serveur injoignable.", { sent: true });
  });
  const from = w.order.length;
  await rejects(w.sync.run({ reason: "timer" }), (e) => e.code === ERR.HTTP);
  assert(w.order.slice(from).includes(`Sync ${CAL}`), "the calendar was tried after mail failed");
  eq([w.titles(), w.store.mids("/Inbox")], [[], []]);
  eq([(await w.health()).failures, (await w.health()).lastError.code], [1, ERR.HTTP]);
  // The mail part alone failing, even outside any request (Thunderbird refuses to list the folders).
  w.advance(3600_000);
  const list = w.store.listFolders.bind(w.store);
  w.store.listFolders = async () => {
    throw new Error("Unexpected error in folders API: /Inbox/Projets");
  };
  await rejects(w.sync.run({ reason: "timer" }), (e) => e.code === "LOCAL" && !/Projets/.test(e.message));
  w.store.listFolders = list;
  eq(w.titles(), ["Réunion"], "the calendar is synchronized all the same");
  eq(w.store.mids("/Inbox"), [], "mail waits for the next pass");
  w.advance(3600_000);
  eq((await w.sync.run({ reason: "timer" })).status, "ok");
  eq(w.store.mids("/Inbox"), ["a@x"]);
});

test("calendar: a fatal error or a cancellation stops the pass at once, and the calendar is not tried", async () => {
  const w = calendarWorld();
  await w.sync.run({ reason: "user" });
  const passes = w.passes.length;
  w.mail.addMessage("1", mime("a@x"));
  w.mail.hook("Sync", () => {
    throw new EasError(ERR.AUTH, "Identifiant ou mot de passe refusé par le serveur.");
  });
  await rejects(w.sync.run({ reason: "timer" }), (e) => e.code === ERR.AUTH);
  eq([w.passes.length, (await w.health()).blocked.code], [passes, ERR.AUTH]);
  // Cancelled during the calendar part: the signal reaches its requests, nothing is recorded as a failure.
  eq((await w.sync.run({ reason: "user" })).status, "ok");
  w.cal.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  const ctrl = new AbortController();
  w.cal.hook("Sync", (req, opts) => {
    eq(opts.signal.aborted, false);
    ctrl.abort();
    return undefined;
  });
  await rejects(w.sync.run({ reason: "timer", signal: ctrl.signal }), (e) => e.code === ERR.CANCELLED);
  const h = await w.health();
  eq([h.failures, h.lastError, w.titles()], [0, null, []]);
  eq((await w.sync.run({ reason: "timer" })).status, "ok");
  eq(w.titles(), ["Réunion"]);
  // A fatal failure of the calendar part blocks the mailbox like any other.
  w.cal.hook("Sync", () => {
    throw new EasError(ERR.DENIED, "Accès refusé.");
  });
  w.cal.addItem(CAL, event({ uid: "e2", summary: "Autre" }));
  await rejects(w.sync.run({ reason: "timer" }), (e) => e.code === ERR.DENIED);
  eq((await w.health()).blocked.code, ERR.DENIED);
});

test("calendar: unreadable items are counted in the mailbox's health, apart from messages", async () => {
  const w = calendarWorld();
  w.cal.addRaw(CAL, [el("Calendar:UID", "cassé"), el("Calendar:Subject", "Illisible"), el("Calendar:StartTime", "pas une date"), el("Calendar:EndTime", "20261201T100000Z")]);
  w.cal.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  const r = await w.sync.run({ reason: "user" });
  eq([r.status, r.failed, r.calendar], ["ok", 1, { received: 1, sent: 0, failed: 1 }]);
  const h = await w.health();
  eq([h.failedItems, h.failedCalendarItems], [1, 1]);
});

async function hundredEach(w) {
  for (const n of range(100)) w.mail.addMessage("1", mime(`k${n}@x`));
  const sids = range(100).map((i) => w.cal.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` })));
  for (let round = 0; round < 10; round++) if (!(await w.sync.run({ reason: "user", round })).moreAvailable) break;
  eq([w.store.messages("/Inbox").length, w.titles().length], [100, 100]);
  return sids;
}

test("calendar: mass deletions are held with mail's, in one block, and confirmed together", async () => {
  const w = calendarWorld();
  const sids = await hundredEach(w);
  for (const sid of [...w.mail.items.get("1").keys()].slice(0, 60)) w.mail.deleteMessage("1", sid);
  for (const sid of sids.slice(0, 70)) w.cal.deleteItem(CAL, sid);
  const r = await w.sync.run({ reason: "timer" });
  eq([r.status, r.reason, r.pendingDeletes], ["blocked", MASS_DELETE, 130]);
  eq([w.store.messages("/Inbox").length, w.titles().length], [100, 100], "nothing removed, neither messages nor events");
  const h = await w.health();
  eq(h.blocked.code, MASS_DELETE);
  assert(h.blocked.message.startsWith("130 suppression(s)"), h.blocked.message);
  eq(await w.sync.pendingDeletes(), { count: 130, collections: [{ collectionId: "1", count: 60, at: w.now() }], calendar: 70 });
  const n = w.order.length;
  for (const reason of ["timer", "push", "user"]) eq((await w.sync.run({ reason })).pendingDeletes, 130, reason);
  eq(w.order.length, n, "no request until the user has decided");
  w.sync.startPush();
  await ticks(200);
  eq([w.mail.sent("Ping").length, w.sync.pushing], [0, false], "and no Ping");
  const ok = await w.sync.run({ reason: "user", confirmDeletes: true });
  eq([ok.status, ok.pendingDeletes, w.passes.at(-1).confirmDeletes], ["ok", 0, true]);
  eq([w.store.messages("/Inbox").length, w.store.messages("/Trash").length, w.titles().length], [40, 60, 30]);
  eq([(await w.health()).blocked, await w.sync.pendingDeletes()], [null, { count: 0, collections: [], calendar: 0 }]);
});

test("calendar: deletions held on one side only; the mail of the pass is kept, and the confirmation covers that side alone", async () => {
  const w = calendarWorld();
  const sids = await hundredEach(w);
  // The calendar's alone: the mail of that pass is imported, then the mailbox waits.
  for (const sid of sids.slice(0, 60)) w.cal.deleteItem(CAL, sid);
  w.mail.addMessage("1", mime("nouveau@x"));
  const r = await w.sync.run({ reason: "timer" });
  eq([r.status, r.reason, r.pendingDeletes, r.added], ["blocked", MASS_DELETE, 60, 1]);
  assert(w.store.mids("/Inbox").includes("nouveau@x"));
  eq(await w.sync.pendingDeletes(), { count: 60, collections: [], calendar: 60 });
  eq((await w.health()).blocked.code, MASS_DELETE);
  const ok = await w.sync.run({ reason: "user", confirmDeletes: true });
  eq([ok.status, w.titles().length, w.store.messages("/Trash").length], ["ok", 40, 0]);
  // The mail's alone: the confirmation is not handed to the calendar, which held nothing.
  for (const sid of [...w.mail.items.get("1").keys()].slice(0, 60)) w.mail.deleteMessage("1", sid);
  eq((await w.sync.run({ reason: "timer" })).pendingDeletes, 60);
  eq(await w.sync.pendingDeletes(), { count: 60, collections: [{ collectionId: "1", count: 60, at: w.now() }], calendar: 0 });
  await w.sync.run({ reason: "user", confirmDeletes: true });
  eq([w.passes.at(-1).confirmDeletes, w.store.messages("/Trash").length, w.titles().length], [false, 60, 40]);
});

test("calendar: keeping the local copies holds for messages and for events alike", async () => {
  const w = calendarWorld();
  const sids = await hundredEach(w);
  for (const sid of [...w.mail.items.get("1").keys()].slice(0, 60)) w.mail.deleteMessage("1", sid);
  for (const sid of sids.slice(0, 70)) w.cal.deleteItem(CAL, sid);
  eq((await w.sync.run({ reason: "timer" })).pendingDeletes, 130);
  await w.sync.discardPendingDeletes();
  eq([(await w.health()).blocked, (await w.sync.pendingDeletes()).count], [null, 0]);
  const r = await w.sync.run({ reason: "timer" });
  eq([r.status, r.pendingDeletes], ["ok", 0]);
  eq([w.store.messages("/Inbox").length, w.store.messages("/Trash").length], [100, 0], "the messages stay");
  const rows = w.api.items(w.calendar());
  eq([rows.length, rows.filter((x) => x.detached).length, rows.filter((x) => x.serverId !== null).length], [100, 70, 30], "the events stay, detached from the server");
  // The calendar refuses: the mailbox stays blocked, and the user can ask again.
  for (const sid of sids.slice(70, 100)) w.cal.deleteItem(CAL, sid);
  for (const i of range(60)) w.cal.addItem(TASKS, task({ uid: `t${i}`, summary: `T${i}` }));
  await w.sync.run({ reason: "timer" });
  for (const sid of [...w.cal.items.get(TASKS).keys()]) w.cal.deleteItem(TASKS, sid);
  eq((await w.sync.run({ reason: "timer" })).pendingDeletes, 60);
  w.api.failAll = new Error("INTERNAL: agendas indisponibles");
  await rejects(w.sync.discardPendingDeletes());
  w.api.failAll = null;
  eq([(await w.health()).blocked.code, (await w.sync.pendingDeletes()).count], [MASS_DELETE, 60]);
  await w.sync.discardPendingDeletes();
  eq((await w.health()).blocked, null);
});

test("mail unchecked: the copies of server messages leave Thunderbird, what is only local stays, and mail checked again starts over", async () => {
  const w = calendarWorld();
  await hundredEach(w);
  w.mail.addMessage("6", mime("p@x"));
  await w.sync.run({ reason: "user" });
  // A message of the user's own in a synchronized folder, one that copies a server message, and a folder of their own.
  w.store.folders.get("/Inbox").msgs.set(9001, { mid: "local@x", read: true, flagged: false, bytes: new Uint8Array(1) });
  const first = w.store.messages("/Inbox")[0];
  w.store.folders.get("/Inbox").msgs.set(9002, { ...first, id: undefined });
  w.store.userAddFolder("/Perso");
  w.store.folders.get("/Perso").msgs.set(9003, { mid: "perso@x", read: true, flagged: false, bytes: new Uint8Array(1) });
  // Held deletions and a waiting local action: they go with the mail.
  for (const sid of [...w.mail.items.get("1").keys()].slice(0, 60)) w.mail.deleteMessage("1", sid);
  eq((await w.sync.run({ reason: "timer" })).pendingDeletes, 60);
  const serverBefore = w.mail.items.get("1").size;

  // Mail unchecked without the user's yes (a mailbox unchecked before the question existed, an upgrade):
  // nothing is removed.
  w.make({ sync: { mail: false, calendar: true, contacts: false, tasks: true } });
  const before = w.store.messages("/Inbox").length;
  await w.sync.run({ reason: "timer" });
  eq([w.store.messages("/Inbox").length, w.store.writes.filter((x) => x[0] === "purge").length], [before, 0], "no yes, no removal");
  assert((await w.records.names()).some((n) => n.startsWith("coll:")), "the tables stay");

  // With the yes of the settings page.
  await w.records.set("mailRemoval", true);
  w.cal.addItem(CAL, event({ uid: "plus", summary: "Plus tard" }));
  const r = await w.sync.run({ reason: "timer" });
  eq([r.status, r.pendingDeletes, (await w.health()).blocked], ["ok", 0, null]);
  assert(w.titles().includes("Plus tard"), "the calendar goes on");
  const held = Array.from({ length: 60 }, (_, i) => `k${i}@x`);
  eq(w.store.mids("/Inbox"), [...held, first.mid, "local@x"].sort(), "the messages whose deletion was held, one copy too many and the user's own message stay");
  eq(w.store.mids("/Perso"), ["perso@x"]);
  assert(!w.store.folders.has("/Inbox/Projets"), "a folder left empty is removed");
  assert(w.store.folders.has("/Inbox") && w.store.folders.has("/Sent"), "special folders stay");
  eq(w.mail.items.get("1").size, serverBefore, "nothing is touched on the server");
  const names = await w.records.names();
  eq(names.filter((n) => n.startsWith("coll:") || n.startsWith("journal:") || ["layout", "pendingDeletes", "archives", "renaming", "foldersBefore", "mailRemoval", "mailRemovalAt"].includes(n)), []);
  // A second pass has nothing more to remove.
  const writes = w.store.writes.length;
  await w.sync.run({ reason: "timer" });
  eq(w.store.writes.length, writes);

  // Mail checked again: a first synchronization.
  w.make();
  const again = await w.sync.run({ reason: "user" });
  eq([again.status, again.pendingDeletes], ["ok", 0]);
  eq(w.store.messages("/Inbox").length, serverBefore + 62, "what the server holds, and what had stayed");
  eq(w.store.mids("/Inbox/Projets"), ["p@x"]);
});

test("calendar: Ping also watches the calendar and the tasks, each with its class; a change reported there starts a pass for that folder", async () => {
  const w = calendarWorld();
  await w.sync.run({ reason: "user" });
  let pings = 0;
  w.mail.pings.push(() => {
    pings++;
    return { status: "2", folders: [CAL] };
  });
  w.mail.pings.push((req, opts) => {
    pings++;
    return new Promise((resolve, reject) => opts.signal.addEventListener("abort", () => reject(new EasError(ERR.CANCELLED, "annulé"))));
  });
  w.cal.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  w.cal.addItem(TASKS, task({ uid: "t1", summary: "Rapport" }));
  const before = w.order.length;
  w.sync.startPush();
  for (let i = 0; i < 3000 && pings < 2; i++) await Promise.resolve();
  eq(pings, 2);
  await w.sync.stopPush();
  const watched = child(w.mail.sent("Ping")[0], "Folders").children.map((f) => [text(f, "Id"), text(f, "Class")]);
  eq(watched, [["1", "Email"], ["2", "Email"], ["3", "Email"], ["4", "Email"], ["6", "Email"], [CAL, "Calendar"], [TASKS, "Tasks"]]);
  eq([w.passes.at(-1).only, w.titles()], [[CAL], ["Réunion"]], "only the folder reported is asked for");
  eq(w.order.slice(before).filter((c) => c.startsWith("Sync ")), [`Sync ${CAL}`]);
  // A mail folder reported: the calendar is told which, and asks for nothing.
  const from = w.order.length;
  await w.sync.run({ reason: "push", folders: ["6"] });
  eq([w.order.slice(from).filter((c) => c.startsWith("Sync ")), w.passes.at(-1).only, w.titles()], [["Sync 6"], ["6"], ["Réunion"]]);
  // No mail: only the calendar and the tasks are watched.
  const only = calendarWorld({ sync: { mail: false, calendar: true, contacts: false, tasks: false } });
  await only.sync.run({ reason: "user" });
  let seen = null;
  only.mail.pings.push((req) => {
    seen = child(req, "Folders").children.map((f) => [text(f, "Id"), text(f, "Class")]);
    only.sync.stopPush();
    return { status: "1" };
  });
  only.sync.startPush();
  await until(() => seen !== null);
  await only.sync.stopPush();
  eq(seen, [[CAL, "Calendar"]]);
});

/** A question the user has not answered yet: w.questions[i].resolve(true | false). */
function openQuestions(w) {
  w.questions = [];
  w.confirm = (question) => new Promise((resolve) => w.questions.push({ question, resolve }));
}

test("calendar: meeting messages are delivered after the pass, outside the lock, with a client of their own; an open question holds no pass back", async () => {
  const w = calendarWorld();
  await w.sync.run({ reason: "user" });
  openQuestions(w);
  w.api.userAdd(w.calendar(), meeting([GUEST], { uid: "m1", summary: "Budget" }));
  const clients = w.clients;
  const r = await w.sync.run({ reason: "local" });
  eq([r.status, r.calendar.sent], ["ok", 1], "the pass ends without waiting for the question");
  assert(!w.order.includes("SendMail") && w.questions.length === 0, "nothing is asked or sent under the lock");
  await until(() => w.questions.length === 1, "the question was never asked");
  eq([w.clients, w.sync.delivering, w.sync.running, w.cal.mails.length], [clients + 2, true, false, 0], "one client for the pass, one for the delivery");
  eq(w.questions[0].question, { kind: "invite", summary: "Budget", start: "2026-12-01T09:00:00Z", allDay: false, recipients: [GUEST], from: OWN });
  // While the window is open, passes run as usual: mail arrives, and a second meeting joins the queue.
  w.mail.addMessage("1", mime("pendant@x"));
  w.api.userAdd(w.calendar(), meeting([GUEST], { uid: "m2", summary: "Bilan" }));
  const during = await w.sync.run({ reason: "timer" });
  eq([during.status, w.store.mids("/Inbox"), during.calendar.sent], ["ok", ["pendant@x"], 1]);
  eq([w.questions.length, await w.scheduler.pending()], [1, 2], "one question at a time");
  w.questions[0].resolve(true);
  await until(() => w.questions.length === 2, "the second question was never asked");
  eq(w.cal.mails.length, 1);
  w.questions[1].resolve(false);
  await until(() => !w.sync.delivering);
  eq([w.cal.mails.length, await w.scheduler.pending(), w.notices], [1, 0, []], "the first one left, the second did not: the user did not want it");
  assert(w.cal.mails[0].saveInSentItems);
  eq(w.order.filter((c) => c === "SendMail").length, 1);
});

test("calendar: nothing to deliver, no client and no question; a delivery that cannot start leaves the message queued", async () => {
  const w = calendarWorld();
  await w.sync.run({ reason: "user" });
  const clients = w.clients;
  await w.sync.run({ reason: "timer" });
  await ticks(200);
  eq([w.clients, w.asked.length, w.sync.delivering], [clients + 1, 0, false]);
  // The client of the delivery cannot be made (the password is locked away): nothing is asked, the message waits.
  w.api.userAdd(w.calendar(), meeting([GUEST], { uid: "m1", summary: "Budget" }));
  const second = w.clients + 2; // the pass takes the next client, the delivery the one after
  w.clientError = (n) => (n === second ? new EasError(ERR.NETWORK, "Mot de passe inaccessible pour le moment.") : null);
  const r = await w.sync.run({ reason: "local" });
  eq([r.status, r.calendar.sent], ["ok", 1]);
  await until(() => w.clients === second && !w.sync.delivering);
  eq([w.asked.length, w.cal.mails.length, await w.scheduler.pending()], [0, 0, 1]);
  assert(w.log.lines.some(([level, line]) => level === "warn" && line.startsWith("Messages de réunion non traités")), "said in the log");
  eq((await w.health()).lastError, null, "not a failure of the synchronization");
  // The next pass delivers.
  await w.sync.run({ reason: "timer" });
  await until(() => !w.sync.delivering && w.cal.mails.length === 1, "delivered at the next pass");
  eq([w.asked.length, await w.scheduler.pending()], [1, 0]);
});

test("calendar: close() stops the delivery without waiting for the window; the question is withdrawn, the message stays, the next engine asks again", async () => {
  const w = calendarWorld();
  await w.sync.run({ reason: "user" });
  openQuestions(w);
  w.api.userAdd(w.calendar(), meeting([GUEST], { uid: "m1", summary: "Budget" }));
  await w.sync.run({ reason: "local" });
  await until(() => w.questions.length === 1);
  const old = w.sync;
  await old.close(); // resolves although nobody answered
  eq([old.delivering, await w.scheduler.pending(), w.cal.mails.length], [false, 1, 0]);
  w.questions[0].resolve(true); // the window of the engine that stopped: its yes counts for nothing
  await ticks(200);
  eq(w.cal.mails.length, 0);
  eq((await old.run({ reason: "user" })).reason, "CLOSED");
  // The engine that takes the mailbox over asks again, and this yes sends the message once.
  w.make();
  w.confirm = null;
  await w.sync.run({ reason: "user" });
  await until(() => !w.sync.delivering && w.cal.mails.length === 1, "asked again, then sent");
  eq([w.asked.length, await w.scheduler.pending()], [2, 0]);
  // close() during the calendar part: the pass is cancelled and awaited like any other.
  w.cal.addItem(CAL, event({ uid: "e9", summary: "Tard" }));
  let release;
  w.cal.hook("Sync", async () => {
    await new Promise((resolve) => (release = resolve));
    return undefined;
  });
  const running = w.sync.run({ reason: "timer" });
  await until(() => typeof release === "function");
  const closing = w.sync.close();
  await ticks(100);
  assert(w.sync.running, "the pass gets control back before close() ends");
  release();
  await rejects(running, (e) => e.code === ERR.CANCELLED);
  await closing;
  assert(!w.sync.running);
});

test("calendar: calendar and tasks unchecked, one more pass removes their calendars, then the calendar engine is no longer called", async () => {
  const w = calendarWorld();
  w.cal.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  w.cal.addItem(TASKS, task({ uid: "t1", summary: "Rapport" }));
  await w.sync.run({ reason: "user" });
  eq(w.api.calendars.size, 1);
  // Tasks alone unchecked: the calendar part still runs, and takes the tasks away.
  w.make({ sync: { mail: true, calendar: true, contacts: false, tasks: false } });
  await w.sync.run({ reason: "user" });
  eq([w.titles(), await w.records.get("pimActive", null)], [["Réunion"], true]);
  // Both unchecked.
  w.make({ sync: { mail: true, calendar: false, contacts: false, tasks: false } });
  const passes = w.passes.length;
  const r = await w.sync.run({ reason: "user" });
  eq([r.status, w.api.calendars.size, w.passes.length, await w.records.get("pimActive", null)], ["ok", 0, passes + 1, null]);
  eq((await w.records.names()).filter((n) => n.startsWith("pim")), [], "no calendar record is left");
  const calls = w.api.calls.length;
  await w.sync.run({ reason: "timer" });
  eq([w.passes.length, w.api.calls.length], [passes + 1, calls], "nothing more afterwards");
  // Nothing else chosen that is synchronised (contacts only): one pass tidies all the same, then none asks anything.
  const c = calendarWorld();
  c.cal.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  await c.sync.run({ reason: "user" });
  c.make({ sync: { mail: false, calendar: false, contacts: true, tasks: false } });
  await c.sync.run({ reason: "user" });
  eq([c.api.calendars.size, await c.records.get("pimActive", null)], [0, null]);
  const n = c.order.length;
  await c.sync.run({ reason: "user" });
  eq(c.order.length, n);
});

test("audit: a removal stopped in the middle does not count the same messages twice", async () => {
  const w = calendarWorld();
  for (let i = 0; i < 250; i++) w.mail.addMessage("1", mime(`m${String(i).padStart(3, "0")}@x`));
  await w.sync.run({ reason: "user" });
  // The user's own second copy of the first message.
  const first = w.store.messages("/Inbox").find((m) => m.mid === "m000@x");
  w.store.folders.get("/Inbox").msgs.set(9002, { ...first, id: undefined });
  w.make({ sync: { mail: false, calendar: true, contacts: false, tasks: true } });
  await w.records.set("mailRemoval", true);
  const purge = w.store.purgeMessages.bind(w.store);
  let calls = 0;
  w.store.purgeMessages = async (ids) => {
    if (++calls === 2) throw new Error("coupé");
    return purge(ids);
  };
  await rejects(() => w.sync.run({ reason: "timer" }));
  assert(w.store.messages("/Inbox").length < 251 && w.store.mids("/Inbox").includes("m000@x"), "stopped after the first batch");
  assert((await w.records.names()).includes("mailRemoval"), "still asked for");
  const again = await w.sync.run({ reason: "user" });
  eq([again.status, w.store.mids("/Inbox")], ["ok", ["m000@x"]], "the copy that was the user's own is still there");
});

test("audit: a folder the server no longer lists keeps its messages when mail is unchecked", async () => {
  const w = calendarWorld();
  for (let i = 0; i < 80; i++) w.mail.addMessage("6", mime(`p${i}@x`));
  w.mail.addMessage("1", mime("i@x"));
  await w.sync.run({ reason: "user" });
  eq(w.store.messages("/Inbox/Projets").length, 80);
  w.mail.deleteFolder("6");
  w.make({ sync: { mail: false, calendar: true, contacts: false, tasks: true } });
  await w.records.set("mailRemoval", true);
  eq((await w.sync.run({ reason: "timer" })).status, "ok");
  eq([w.store.messages("/Inbox/Projets").length, w.store.mids("/Inbox")], [80, []], "gone from the server: left alone; still there: removed");
});

test("mail unchecked: the folder list starts over meanwhile; when mail comes back it is a first synchronization of the new list", async () => {
  const w = calendarWorld();
  w.mail.addMessage("6", mime("p@x"));
  w.cal.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  await w.sync.run({ reason: "user" });
  eq([w.store.mids("/Inbox/Projets"), (await loadCollection(w.records, "6")).path], [["p@x"], "/Inbox/Projets"]);
  // Mail unchecked. The server then renumbers its folders (a partnership reset): "6" now names another
  // folder, and "Projets" is "9".
  w.make({ sync: { mail: false, calendar: true, contacts: false, tasks: true } });
  await w.records.set("mailRemoval", true);
  w.mail = new FakeServer({ folders: [...BOTH.map((f) => (f.id === "6" ? { id: "6", parentId: "0", name: "Autre", type: 12 } : f)), { id: "9", parentId: "1", name: "Projets", type: 12 }] });
  w.mail.addMessage("9", mime("p@x"));
  w.mail.addMessage("6", mime("autre@x"));
  await w.records.set("hierarchy", { syncKey: "999" }); // refused: Status 9, then the whole list again
  eq((await w.sync.run({ reason: "timer" })).status, "ok");
  eq([text(w.mail.sent("FolderSync").at(-1), "SyncKey"), (await w.records.getMap("folders")).get("6").name], ["0", "Autre"], "the new list is saved");
  // The mail tables are gone with the copies: no older list has to be kept for them.
  assert(!(await w.records.names()).includes("foldersBefore"));
  assert(!w.store.folders.has("/Inbox/Projets"));
  // Mail checked again: each folder of the new list gets its messages.
  w.make();
  eq((await w.sync.run({ reason: "user" })).status, "ok");
  eq([w.store.mids("/Inbox/Projets"), w.store.mids("/Autre")], [["p@x"], ["autre@x"]]);
  eq([(await loadCollection(w.records, "9")).path, (await loadCollection(w.records, "6")).path], ["/Inbox/Projets", "/Autre"]);
  // A mailbox that never had mail keeps nothing.
  const bare = calendarWorld({ sync: { mail: false, calendar: true, contacts: false, tasks: false } });
  await bare.sync.run({ reason: "user" });
  await bare.records.set("hierarchy", { syncKey: "999" });
  await bare.sync.run({ reason: "timer" });
  assert(!(await bare.records.names()).includes("foldersBefore"));
});

test("calendar: the folder list starts over and the calendar folder has another ServerId — the calendar part is told before the list is saved, and nothing is doubled", async () => {
  const w = calendarWorld();
  w.mail.addMessage("1", mime("a@x"));
  for (const i of range(5)) w.cal.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }), `i${i}`);
  await w.sync.run({ reason: "user" });
  w.api.userAdd(w.calendar(), event({ uid: "l", summary: "Local" }));
  // A partnership reset: the key of the folder list is refused, and in the new list the calendar folder is "12".
  w.mail = new FakeServer({ folders: BOTH.map((f) => (f.id === CAL ? { ...f, id: "12" } : f)) });
  w.mail.addMessage("1", mime("a@x"));
  const items = w.cal.items.get(CAL);
  w.cal.removeFolder(CAL);
  w.cal.addFolder("12", "0", "Calendrier", 8);
  w.cal.items.set("12", items);
  await w.records.set("hierarchy", { syncKey: "999" });
  const told = [];
  const listRestarted = w.pim.listRestarted.bind(w.pim);
  w.pim.listRestarted = async () => {
    told.push((await w.records.getMap("folders")).has(CAL)); // the list stored when the calendar part is told
    return listRestarted();
  };
  const from = w.order.length;
  let r = await w.sync.run({ reason: "timer" });
  for (let i = 0; i < 5 && r.moreAvailable; i++) r = await w.sync.run({ reason: "suite" });
  eq([r.status, r.pendingDeletes], ["ok", 0]);
  eq(told, [true], "told once, while the list stored is still the one before");
  eq([(await w.records.getMap("folders")).has(CAL), (await w.records.getMap("folders")).get("12").type], [false, 8], "the new list is saved");
  eq([w.titles(), w.api.calendars.size], [["E0", "E1", "E2", "E3", "E4", "Local"], 1], "no event twice, no second calendar");
  eq(w.cal.adds.map((a) => a.cid), ["12"], "the new event went to the calendar folder under the ServerId it has now");
  assert(w.order.slice(from).includes("Sync 12") && !w.order.slice(from).includes(`Sync ${CAL}`), "the old ServerId is not asked");
  eq(w.store.mids("/Inbox"), ["a@x"], "mail is matched as before");
  // A pass that goes on from the key of the list tells nothing.
  await w.sync.run({ reason: "timer" });
  eq(told.length, 1);
  // Mail only: no calendar engine, nothing to tell (and nothing fails).
  const plain = world({ sync: { mail: true, calendar: false, contacts: false, tasks: false } });
  await plain.sync.run({ reason: "user" });
  await plain.records.set("hierarchy", { syncKey: "999" });
  eq((await plain.sync.run({ reason: "timer" })).status, "ok");
});

test("calendar: a server that leaves the user's change unanswered pass after pass is a failure the mailbox shows, with its backoff — the change is not undone, and mail goes on", async () => {
  const w = calendarWorld();
  w.cal.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  await w.sync.run({ reason: "user" });
  w.api.userAdd(w.calendar(), event({ uid: "l", summary: "Nouveau" }));
  // The calendar collection answers "server error" to every request, for an hour.
  const real = w.cal.onSync.bind(w.cal);
  w.cal.onSync = (req) => {
    const c = at(req, "Collections", "Collection");
    if (text(c, "CollectionId") !== CAL) return real(req);
    return el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", text(c, "SyncKey")), el("CollectionId", CAL), el("Status", "5")])])]);
  };
  let failures = 0;
  let skipped = 0;
  for (let minute = 0; minute < 60; minute++) {
    w.mail.addMessage("1", mime(`m${minute}@x`));
    try {
      const r = await w.sync.run({ reason: "timer" });
      if (r.reason === "backoff") skipped++;
    } catch (e) {
      eq(e.code, "SERVER");
      failures++;
    }
    w.advance(60_000);
  }
  assert(failures >= 3 && skipped > failures, `${failures} failures, ${skipped} passes held back by the backoff`);
  const h = await w.health();
  eq([h.failures, h.lastError.code, h.blocked], [failures, "SERVER", null], "shown as a failure of the mailbox");
  eq([w.titles(), w.notices, w.api.calls.filter((c) => c[0] === "dropLocalChange").length], [["Nouveau", "Réunion"], [], 0], "nothing is undone");
  assert(w.store.mids("/Inbox").length >= failures, "the mail of each pass that ran arrived");
  // The server is back.
  w.cal.onSync = real;
  w.advance(3600_000);
  let r = await w.sync.run({ reason: "timer" });
  for (let i = 0; i < 5 && r.moreAvailable; i++) r = await w.sync.run({ reason: "suite" });
  eq([r.status, w.cal.adds.length, (await w.health()).failures], ["ok", 1, 0]);
  eq([...w.cal.items.get(CAL).values()].map((x) => x.summary).sort(), ["Nouveau", "Réunion"]);
});
