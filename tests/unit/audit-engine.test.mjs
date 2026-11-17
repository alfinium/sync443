// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Regression tests of the security and data-integrity audit of the mail
 * engine (steps 2 and 3): one or more tests per finding, each the audit's
 * proof of concept turned into an assertion (it failed before the fix).
 */

import { test, assert, eq, rejects } from "./harness.mjs";
import { el, at, text } from "../../src/core/wbxml.mjs";
import { encodeUtf8, decodeUtf8 } from "../../src/core/utf8.mjs";
import { messageIdOf, ensureMessageId, cleanDraft, ORIGINAL_ID_FIELD } from "../../src/core/mime.mjs";
import { Store } from "../../src/sync/store.mjs";
import { MailboxSync, MASS_DELETE } from "../../src/sync/mailbox.mjs";
import { Journal, MAX_ATTEMPTS, MAX_WAITS } from "../../src/sync/journal.mjs";
import { loadCollection, saveCollection, distinctCopy, MAX_FETCH_ATTEMPTS } from "../../src/sync/mail.mjs";
import { MailStore } from "../../src/tb/mail-store.mjs";
import { LocalEvents } from "../../src/tb/events.mjs";
import { EchoRegistry } from "../../src/sync/echo.mjs";
import { FakeServer, FakeMailStore, DEFAULT_FOLDERS, mime, quietLog } from "./mail-sync.test.mjs";
import { memoryArea } from "./journal.test.mjs";
import { fakeBrowser } from "./mail-store.test.mjs";

const MB = "0123456789ab";
const MAIL = { mail: true, calendar: false, contacts: false, tasks: false };

function world({ folders, store, server } = {}) {
  const w = {
    server: server ?? new FakeServer(folders ? { folders } : {}),
    store: store ?? new FakeMailStore(),
    area: memoryArea(),
    log: quietLog(),
    t: 1_000_000,
  };
  const st = new Store(w.area);
  w.records = st.mailbox(MB);
  w.mailbox = { id: MB, accountKey: "account1", filterType: "0", sync: MAIL };
  w.make = () =>
    new MailboxSync({
      mailbox: w.mailbox,
      store: st,
      clientFactory: async () => w.server,
      mailStore: w.store,
      log: w.log,
      now: () => w.t,
      random: () => 0.5,
      sleep: async (ms) => {
        w.t += ms;
      },
    });
  w.sync = w.make();
  w.runAll = async (o = { reason: "user" }) => {
    let r;
    for (let round = 0; round < 30; round++) {
      r = await w.sync.run({ ...o, round });
      if (!r.moreAvailable) break;
    }
    return r;
  };
  w.imports = () => w.store.writes.filter((x) => x[0] === "import").length;
  w.locate = (mid) => [...w.store.folders.keys()].filter((p) => w.store.mids(p).includes(mid));
  return w;
}

const subjectOf = (bytes) => /Subject: ([^\r\n]*)/.exec(decodeUtf8(bytes))?.[1] ?? null;
const extra = (rows) => [...DEFAULT_FOLDERS, ...rows.map(([id, parentId, name, type = 12]) => ({ id, parentId, name, type }))];

// ── #1 Folder moves planned together: never two collections on one folder ─

test("audit #1 : renommages en chaîne sur le serveur (Projets → Projets 2025, Projets 2026 → Projets) suivis sans mélange", async () => {
  const w = world({ folders: extra([["8", "0", "Projets 2026"], ["9", "0", "Projets"]]) });
  const n1 = w.server.addMessage("8", mime("new-1@x"));
  w.server.addMessage("8", mime("new-2@x"));
  const o1 = w.server.addMessage("9", mime("old-a@x"));
  w.server.addMessage("9", mime("old-b@x"));
  await w.runAll();
  const imports = w.imports();
  w.server.updateFolder("9", { name: "Projets 2025" });
  w.server.updateFolder("8", { name: "Projets" });
  await w.runAll({ reason: "timer" });
  eq((await loadCollection(w.records, "8")).path, "/Projets");
  eq((await loadCollection(w.records, "9")).path, "/Projets 2025");
  eq(w.store.mids("/Projets"), ["new-1@x", "new-2@x"]);
  eq(w.store.mids("/Projets 2025"), ["old-a@x", "old-b@x"]);
  assert(!w.store.folders.has("/Projets 2026"), "aucun dossier périmé");
  eq(w.imports(), imports, "rien de retéléchargé");
  await w.sync.recordIntent(w.store.userDelete("/Projets 2025", "old-a@x"));
  await w.runAll({ reason: "timer" });
  assert(!w.server.items.get("9").has(o1), "la suppression atteint le bon dossier du serveur");
  w.server.deleteMessage("8", n1);
  await w.runAll({ reason: "timer" });
  eq(w.store.mids("/Projets"), ["new-2@x"]);
  eq(w.store.mids("/Projets 2025"), ["old-b@x"]);
});

test("audit #1 : deux dossiers qui échangent leurs noms (cycle) : un nom temporaire, contenus suivis", async () => {
  const w = world({ folders: extra([["8", "0", "Alpha"], ["9", "0", "Beta"]]) });
  w.server.addMessage("8", mime("a@x"));
  w.server.addMessage("9", mime("b@x"));
  await w.runAll();
  const imports = w.imports();
  w.server.updateFolder("8", { name: "Beta" });
  w.server.updateFolder("9", { name: "Alpha" });
  await w.runAll({ reason: "timer" });
  eq(w.store.mids("/Beta"), ["a@x"]);
  eq(w.store.mids("/Alpha"), ["b@x"]);
  eq(w.imports(), imports);
  assert(![...w.store.folders.keys()].some((p) => p.includes("Sync443")), "nom temporaire rendu");
});

test("audit #1 : un second dossier de type Boîte de réception ne partage jamais /Inbox avec le premier", async () => {
  const w = world();
  for (let i = 0; i < 10; i++) w.server.addMessage("1", mime(`m${i}@x`));
  await w.runAll();
  w.server.addFolder("!", "0", "Inbox", 2); // sorts before "1": it becomes the Inbox by ServerId order
  for (let i = 0; i < 10; i++) w.server.addMessage("!", mime(`m${i}@x`));
  await w.runAll({ reason: "timer" });
  const a = await loadCollection(w.records, "1");
  const b = await loadCollection(w.records, "!");
  assert(a.path && b.path && a.path !== b.path, `chemins distincts : ${a.path} / ${b.path}`);
  for (const sid of [...w.server.items.get("!").keys()]) w.server.deleteMessage("!", sid);
  await w.runAll({ reason: "timer" });
  eq(w.server.items.get("1").size, 10);
  const c1 = await loadCollection(w.records, "1");
  eq(c1.items.size, 10);
  eq(w.store.messages(c1.path).length, 10, "les copies du dossier 1 restent dans son dossier local");
});

test("audit #1 : deux collections enregistrées sur un même dossier local (état laissé par une version antérieure) : séparées", async () => {
  const w = world({ folders: extra([["8", "0", "Projets"], ["9", "0", "Autre"]]) });
  w.server.addMessage("8", mime("p@x"));
  w.server.addMessage("9", mime("q@x"));
  await w.runAll();
  // Damage: collection 9 says it lives in /Projets too.
  const c9 = await loadCollection(w.records, "9");
  await w.records.set("coll:9", { ...c9.toRecord(), path: "/Projets" });
  for (const n of await w.records.names()) if (n.startsWith("cseg:9:")) await w.records.remove(n);
  await w.runAll({ reason: "timer" });
  eq((await loadCollection(w.records, "8")).path, "/Projets");
  eq((await loadCollection(w.records, "9")).path, "/Autre");
  eq(w.store.mids("/Projets"), ["p@x"]);
});

// ── #2 Full resync keeps the user's waiting changes ───────────────────────

test("audit #2 : Status 3 avec une suppression et un drapeau en attente : rien ne revient, rien ne se perd", async () => {
  const w = world();
  const sids = ["a", "b", "c"].map((m) => w.server.addMessage("1", mime(`${m}@x`)));
  await w.runAll();
  await w.sync.recordIntent(w.store.userDelete("/Inbox", "b@x"));
  await w.sync.recordIntent(w.store.userFlags("/Inbox", "a@x", { read: true }));
  w.server.invalidate("1");
  await w.runAll({ reason: "timer" });
  eq(w.store.mids("/Inbox"), ["a@x", "c@x"], "b@x pas réimporté");
  assert(!w.server.items.get("1").has(sids[1]), "la suppression a atteint le serveur");
  eq(w.server.items.get("1").get(sids[0]).read, true);
  eq(w.store.messages("/Inbox").find((m) => m.mid === "a@x").read, true, "le drapeau local n'est pas écrasé");
  eq(await w.sync.journal.size(), 0);
});

test("audit #2 : les essais d'une entrée se comptent par série de passages, pas par passage", async () => {
  const j = new Journal({ records: new Store(memoryArea()).mailbox(MB), log: quietLog() });
  const e = await j.append({ kind: "delete", path: "/Inbox", messageId: "x@y" });
  for (let pass = 0; pass < 10; pass++) await j.settle(new Map([[e.id, "keep"]]), { run: 1 });
  eq((await j.list())[0].attempts, 1, "dix passages d'une même série : un essai");
  for (let run = 2; run <= MAX_ATTEMPTS; run++) await j.settle(new Map([[e.id, "keep"]]), { run });
  eq(await j.size(), 0, "abandonnée après MAX_ATTEMPTS séries");
});

// ── #3 Journal entries follow their collection by ServerId ────────────────

test("audit #3 : suppression locale puis dossier renommé sur le serveur avant l'envoi : la suppression part au bon dossier", async () => {
  const w = world();
  const sids = ["a", "b"].map((m) => w.server.addMessage("6", mime(`${m}@x`)));
  await w.runAll();
  const entry = await w.sync.recordIntent(w.store.userDelete("/Inbox/Projets", "a@x"));
  eq(entry.src, "6", "ServerId du dossier gardé avec l'entrée");
  w.server.updateFolder("6", { name: "Archive 2025" });
  await w.runAll({ reason: "timer" });
  assert(!w.server.items.get("6").has(sids[0]), "supprimée sur le serveur");
  eq(w.store.mids("/Inbox/Archive 2025"), ["b@x"]);
  eq(await w.sync.journal.size(), 0);
});

test("audit #3 : l'ancien chemin repris par un nouveau dossier du même nom : sa copie n'est pas touchée", async () => {
  const w = world();
  const old = w.server.addMessage("6", mime("report@x", "v1"));
  await w.runAll();
  await w.sync.recordIntent(w.store.userDelete("/Inbox/Projets", "report@x"));
  w.server.updateFolder("6", { name: "Projets 2025" });
  w.server.addFolder("8", "1", "Projets", 12);
  const other = w.server.addMessage("8", mime("report@x", "copie gardée"));
  await w.runAll({ reason: "timer" });
  assert(!w.server.items.get("6").has(old), "supprimé là où l'utilisateur l'a supprimé");
  assert(w.server.items.get("8").has(other), "la copie de l'autre dossier reste");
});

// ── #4 Mass-deletion threshold judged on the whole run ────────────────────

test("audit #4 : le serveur vide un dossier de plus de 5 000 messages : rien n'est supprimé localement avant confirmation", async () => {
  const w = world();
  const sids = [];
  for (let i = 0; i < 5100; i++) sids.push(w.server.addMessage("1", mime(`m${i}@x`)));
  await w.runAll();
  eq(w.store.messages("/Inbox").length, 5100);
  for (const s of sids) w.server.deleteMessage("1", s);
  let r;
  for (let round = 0; round < 12; round++) {
    r = await w.sync.run({ reason: "timer", round });
    eq(w.store.messages("/Trash").length, 0, `passage ${round + 1} : rien à la corbeille`);
    if (r.status === "blocked" || !r.moreAvailable) break;
  }
  eq([r.status, r.reason, r.pendingDeletes], ["blocked", MASS_DELETE, 5100]);
  eq(w.store.messages("/Inbox").length, 5100);
});

test("audit #4 : suppressions au compte-gouttes (45 par passage) arrêtées par la fenêtre glissante", async () => {
  const w = world();
  const sids = [];
  for (let i = 0; i < 400; i++) sids.push(w.server.addMessage("1", mime(`d${i}@x`)));
  await w.runAll();
  let blocked = null;
  for (let k = 0; k < 6 && !blocked; k++) {
    for (const s of sids.splice(0, 45)) w.server.deleteMessage("1", s);
    w.t += 60_000;
    const r = await w.sync.run({ reason: "timer" });
    if (r.status === "blocked") blocked = k;
  }
  assert(blocked !== null && blocked <= 2, `retenu au plus tard au troisième passage (${blocked})`);
  assert(w.store.messages("/Trash").length <= 90, "au plus 20 % du dossier appliqué sans confirmation");
});

// ── #5 Folder removals: threshold, never permanent, hierarchy sanity ──────

test("audit #5 : une liste de dossiers vide (sans boîte de réception) est refusée, rien ne bouge", async () => {
  const w = world({ folders: extra([["8", "3", "Gardé"], ["9", "0", "Clients"]]) });
  for (let i = 0; i < 30; i++) w.server.addMessage("9", mime(`client${i}@x`));
  await w.runAll();
  w.server.hook("FolderSync", () => el("FolderHierarchy:FolderSync", [el("Status", "9")]));
  w.server.hook("FolderSync", () => el("FolderHierarchy:FolderSync", [el("Status", "1"), el("SyncKey", "77"), el("Changes", [el("Count", "0")])]));
  await rejects(w.sync.run({ reason: "timer" }), (e) => e.code === "SERVER");
  eq(w.store.messages("/Clients").length, 30);
  assert(w.store.folders.has("/Trash/Gardé"));
  eq((await loadCollection(w.records, "9")).items.size, 30, "tables gardées");
});

test("audit #5 : un dossier supprimé sur le serveur n'est jamais supprimé définitivement en local, même dans la corbeille", async () => {
  const w = world();
  for (let i = 0; i < 10; i++) w.server.addMessage("6", mime(`proj${i}@x`));
  await w.runAll();
  w.server.updateFolder("6", { parentId: "3" });
  await w.runAll({ reason: "timer" });
  eq(w.store.messages("/Trash/Projets").length, 10);
  w.server.deleteFolder("6");
  await w.runAll({ reason: "timer" });
  eq(w.store.messages("/Trash/Projets").length, 10, "laissé dans la corbeille locale");
  assert(!w.store.writes.some((x) => x[0] === "deleteFolder"));
});

test("audit #5 : suppression d'un dossier de 400 messages : retenue jusqu'à confirmation, puis mise à la corbeille", async () => {
  const w = world();
  for (let i = 0; i < 400; i++) w.server.addMessage("6", mime(`proj${i}@x`));
  for (let i = 0; i < 5; i++) w.server.addMessage("1", mime(`in${i}@x`));
  await w.runAll();
  w.server.deleteFolder("6");
  const r = await w.sync.run({ reason: "timer" });
  eq([r.status, r.reason], ["blocked", MASS_DELETE]);
  eq(w.store.messages("/Inbox/Projets").length, 400, "rien n'a bougé");
  eq((await w.sync.pendingDeletes()).count, 400);
  const ok = await w.sync.run({ reason: "user", confirmDeletes: true });
  eq(ok.status, "ok");
  eq(w.store.messages("/Trash/Projets").length, 400, "à la corbeille locale, pas supprimé");
  eq((await w.sync.pendingDeletes()).count, 0);
});

test("audit #5 : la plupart des dossiers disparaissent d'un coup : retenu ; refusé par l'utilisateur, ils restent en local", async () => {
  const w = world({ folders: extra([["8", "0", "A"], ["9", "0", "B"], ["10", "0", "C"]]) });
  for (const id of ["8", "9", "10"]) w.server.addMessage(id, mime(`m${id}@x`));
  await w.runAll();
  for (const id of ["8", "9", "10", "6"]) w.server.deleteFolder(id);
  const r = await w.sync.run({ reason: "timer" });
  eq([r.status, r.reason], ["blocked", MASS_DELETE]);
  await w.sync.discardPendingDeletes();
  const again = await w.sync.run({ reason: "timer" });
  eq(again.status, "ok");
  for (const p of ["/A", "/B", "/C"]) eq(w.store.messages(p).length, 1, `${p} gardé`);
  eq(w.store.messages("/Trash").length, 0);
});

test("audit #5 : réinitialisation du partenariat (nouveaux ServerId partout) : rien à la corbeille, rien de retéléchargé", async () => {
  const w = world({ folders: extra([["9", "0", "Clients"]]) });
  for (let i = 0; i < 20; i++) w.server.addMessage("9", mime(`c${i}@x`));
  for (let i = 0; i < 5; i++) w.server.addMessage("1", mime(`i${i}@x`));
  await w.runAll();
  const imports = w.imports();
  const server = new FakeServer({ folders: DEFAULT_FOLDERS.map((f) => ({ ...f, id: `n${f.id}`, parentId: f.parentId === "0" ? "0" : `n${f.parentId}` })).concat([{ id: "n9", parentId: "0", name: "Clients", type: 12 }]) });
  for (let i = 0; i < 20; i++) server.addMessage("n9", mime(`c${i}@x`));
  for (let i = 0; i < 5; i++) server.addMessage("n1", mime(`i${i}@x`));
  w.server = server;
  await w.records.set("hierarchy", { syncKey: "999" }); // refused: Status 9, everything again under new ids
  await w.runAll({ reason: "timer" });
  eq(w.store.messages("/Clients").length, 20);
  eq(w.store.messages("/Trash").length, 0);
  assert(!w.store.folders.has("/Trash/Clients"));
  eq(w.imports(), imports, "les copies locales sont reprises, pas retéléchargées");
  eq((await loadCollection(w.records, "n9")).items.size, 20);
});

// ── #6 Archive never deletes on the server ────────────────────────────────

function archiveStore() {
  return new FakeMailStore({ folders: [["/Inbox", ["inbox"]], ["/Trash", ["trash"]], ["/Sent", ["sent"]], ["/Drafts", ["drafts"]], ["/Templates", ["templates"]], ["/Archives", ["archives"]]] });
}

test("audit #6 : « Archiver » : le dossier d'archives devient un dossier du serveur, le message y est déplacé, jamais supprimé", async () => {
  const w = world({ store: archiveStore() });
  const sid = w.server.addMessage("1", mime("invoice-2025@x", "Facture"));
  await w.runAll();
  await w.sync.recordIntent(w.store.userMove("/Inbox", "invoice-2025@x", "/Archives"));
  await w.runAll({ reason: "timer" });
  assert(!w.server.items.get("1").has(sid));
  eq(w.server.items.get("3").size, 0, "rien dans les éléments supprimés du serveur");
  const archives = [...w.server.folders].find(([, f]) => f.name === "Archives" && f.parentId === "0");
  assert(archives, "dossier Archives créé sur le serveur");
  eq(w.server.items.get(archives[0]).size, 1, "le message y est");
  eq(w.store.mids("/Archives"), ["invoice-2025@x"]);
  eq(w.store.mids("/Trash"), []);
  eq(await w.records.get("archives", null), { serverId: archives[0] });
  // Next passes: the archives folder stays bound to /Archives, nothing duplicated.
  await w.runAll({ reason: "timer" });
  eq(w.store.mids("/Archives"), ["invoice-2025@x"]);
  eq((await loadCollection(w.records, archives[0])).path, "/Archives");
});

test("audit #6 : le serveur a déjà un dossier « Archives » : lié à /Archives dès la première synchro, archiver = un MoveItems vers lui", async () => {
  const w = world({ store: archiveStore(), folders: extra([["8", "0", "Archives"]]) });
  w.server.addMessage("8", mime("deja-archive@x"));
  const sid = w.server.addMessage("1", mime("facture@x"));
  await w.runAll();
  assert(!w.store.folders.has("/Archives (2)"), "pas de « /Archives (2) » à côté du dossier d'archives");
  eq(w.store.mids("/Archives"), ["deja-archive@x"]);
  eq((await loadCollection(w.records, "8")).path, "/Archives");
  eq(await w.records.get("archives", null), { serverId: "8" });
  const imports = w.imports();
  await w.sync.recordIntent(w.store.userMove("/Inbox", "facture@x", "/Archives"));
  await w.runAll({ reason: "timer" });
  const moves = w.server.sent("MoveItems");
  eq(moves.length, 1);
  eq(moves[0].children.map((m) => [text(m, "SrcMsgId"), text(m, "DstFldId")]), [[sid, "8"]]);
  eq(w.server.items.get("1").size, 0);
  eq(w.server.items.get("8").size, 2);
  eq(w.server.folders.size, DEFAULT_FOLDERS.length + 1, "aucun dossier créé sur le serveur");
  await w.runAll({ reason: "timer" });
  eq(w.store.mids("/Archives"), ["deja-archive@x", "facture@x"], "sans doublon");
  eq(w.imports(), imports, "rien de retéléchargé");
  assert(!w.store.folders.has("/Archives (2)"));
});

test("rôles : « Templates » et « Junk » du serveur sont liés aux dossiers Modèles et Indésirables dès la première synchro", async () => {
  const w = world({ store: archiveStore(), folders: extra([["8", "0", "Templates"], ["9", "0", "Junk"], ["10", "9", "Vu"]]) });
  w.store.folders.get("/Templates").msgs.set("local-1", { id: "local-1", mid: "modele-local@x", flags: {} });
  w.server.addMessage("8", mime("modele-serveur@x"));
  w.server.addMessage("9", mime("pub@x"));
  w.server.addMessage("10", mime("pub-vue@x"));
  await w.runAll();
  assert(!w.store.folders.has("/Templates (2)") && !w.store.folders.has("/Junk (2)"), "aucun dossier « (2) »");
  eq([(await loadCollection(w.records, "8")).path, (await loadCollection(w.records, "9")).path, (await loadCollection(w.records, "10")).path], ["/Templates", "/Junk", "/Junk/Vu"]);
  assert(w.store.mids("/Templates").includes("modele-serveur@x"), "le modèle du serveur est là");
  assert(w.store.folders.get("/Templates").msgs.has("local-1"), "le modèle écrit dans Thunderbird reste");
  eq(w.store.mids("/Junk"), ["pub@x"]);
  eq(w.store.mids("/Junk/Vu"), ["pub-vue@x"]);
  eq(w.server.folders.size, DEFAULT_FOLDERS.length + 3, "aucun dossier créé sur le serveur");
  // A message put in the junk folder by the user: an ordinary move on the server.
  const sid = w.server.addMessage("1", mime("arnaque@x"));
  await w.runAll({ reason: "timer" });
  await w.sync.recordIntent(w.store.userMove("/Inbox", "arnaque@x", "/Junk"));
  await w.runAll({ reason: "timer" });
  eq(w.server.sent("MoveItems").map((r) => [text(r.children[0], "SrcMsgId"), text(r.children[0], "DstFldId")]), [[sid, "9"]]);
  eq(w.server.items.get("8").size, 1, "rien de supprimé dans les modèles du serveur");
});

test("rôles : « Templates (2) » et « Junk (2) » laissés par une version antérieure rejoignent les dossiers de rôle sans retéléchargement", async () => {
  const w = world({ store: archiveStore(), folders: extra([["8", "0", "Templates"], ["9", "0", "Junk"]]) });
  w.server.addMessage("8", mime("m1@x"));
  w.server.addMessage("9", mime("j1@x"));
  w.server.addMessage("9", mime("j2@x"));
  await w.runAll();
  // What an earlier version left: both synchronised beside the role folders; no local "/Junk".
  for (const [id, role, old] of [["8", "/Templates", "/Templates (2)"], ["9", "/Junk", "/Junk (2)"]]) {
    w.store.folders.set(old, { specialUse: [], msgs: new Map(w.store.folders.get(role).msgs) });
    w.store.folders.get(role).msgs.clear();
    const c = await loadCollection(w.records, id);
    c.path = old;
    c.snapshotNeeded = true;
    await saveCollection(w.records, c);
  }
  w.store.folders.delete("/Junk");
  const imports = w.imports();
  await w.runAll({ reason: "timer" });
  eq(w.store.mids("/Templates"), ["m1@x"]);
  eq(w.store.mids("/Junk"), ["j1@x", "j2@x"]);
  assert(!w.store.folders.has("/Templates (2)") && !w.store.folders.has("/Junk (2)"), "les anciens dossiers ne sont plus à côté");
  eq(w.store.mids("/Trash"), [], "aucun message à la corbeille");
  eq(w.imports(), imports, "rien de retéléchargé");
  eq([w.server.items.get("8").size, w.server.items.get("9").size], [1, 2], "rien de supprimé sur le serveur");
  const c9 = await loadCollection(w.records, "9");
  eq([c9.path, c9.items.size, c9.syncKey === "0"], ["/Junk", 2, false], "table gardée, pas de resynchro complète");
});

test("rôles : « Templates » renommé sur le serveur quitte le dossier Modèles, qui reste local", async () => {
  const w = world({ store: archiveStore(), folders: extra([["8", "0", "Templates"]]) });
  w.server.addMessage("8", mime("m1@x"));
  await w.runAll();
  eq((await loadCollection(w.records, "8")).path, "/Templates");
  w.server.updateFolder("8", { name: "Gabarits" });
  await w.runAll({ reason: "timer" });
  await w.runAll({ reason: "timer" });
  eq((await loadCollection(w.records, "8")).path, "/Gabarits");
  eq(w.store.mids("/Gabarits"), ["m1@x"]);
  assert(w.store.folders.has("/Templates"), "le dossier Modèles de Thunderbird reste");
  // As for the archives folder: a special local folder is never emptied nor renamed, its copies stay, local.
  eq(w.store.mids("/Templates"), ["m1@x"]);
  eq(w.server.items.get("8").size, 1, "rien de supprimé sur le serveur");
});

test("audit #6 : « Archives » du serveur tenu en « /Archives (2) » par une version antérieure : regroupé dans /Archives sans retéléchargement", async () => {
  const w = world({ store: archiveStore(), folders: extra([["8", "0", "Archives"], ["9", "8", "2025"]]) });
  w.server.addMessage("8", mime("a1@x"));
  w.server.addMessage("8", mime("a2@x"));
  w.server.addMessage("9", mime("b1@x"));
  const sid = w.server.addMessage("1", mime("facture@x"));
  await w.runAll();
  // What an earlier version left: the server's "Archives" synchronised as "/Archives (2)", not bound.
  w.store.userAddFolder("/Archives (2)");
  for (const m of w.store.messages("/Archives")) w.store.folders.get("/Archives (2)").msgs.set(m.id, w.store.folders.get("/Archives").msgs.get(m.id));
  w.store.folders.get("/Archives").msgs.clear();
  w.store.folders.set("/Archives (2)/2025", w.store.folders.get("/Archives/2025"));
  w.store.folders.delete("/Archives/2025");
  for (const [id, path] of [["8", "/Archives (2)"], ["9", "/Archives (2)/2025"]]) {
    const c = await loadCollection(w.records, id);
    c.path = path;
    c.snapshotNeeded = true;
    await saveCollection(w.records, c);
  }
  await w.records.remove("archives");
  const imports = w.imports();
  await w.runAll({ reason: "timer" });
  eq(w.store.mids("/Archives"), ["a1@x", "a2@x"]);
  eq(w.store.mids("/Archives/2025"), ["b1@x"]);
  assert(!w.store.folders.has("/Archives (2)"), "l'ancien dossier, vidé, n'est plus à côté");
  eq(w.store.mids("/Trash"), [], "aucun message à la corbeille");
  eq(w.imports(), imports, "rien de retéléchargé");
  const c8 = await loadCollection(w.records, "8");
  eq([c8.path, c8.items.size, c8.syncKey === "0"], ["/Archives", 2, false], "table gardée, pas de resynchro complète");
  await w.sync.recordIntent(w.store.userMove("/Inbox", "facture@x", "/Archives"));
  await w.runAll({ reason: "timer" });
  eq(w.server.sent("MoveItems").map((r) => text(r.children[0], "DstFldId")), ["8"]);
  assert(!w.server.items.get("1").has(sid));
  eq(w.store.mids("/Archives"), ["a1@x", "a2@x", "facture@x"]);
});

test("audit #6 : seul un dossier ordinaire « Archives » à la racine est lié, jamais un dossier spécial ni un sous-dossier", async () => {
  const w = world({ store: archiveStore(), folders: extra([["8", "6", "Archives"], ["9", "0", "Archives à trier"]]) });
  w.server.addMessage("8", mime("x@x"));
  await w.runAll();
  eq(await w.records.get("archives", null), null);
  eq((await loadCollection(w.records, "8")).path, "/Inbox/Projets/Archives");
  eq(w.store.mids("/Archives"), []);
});

test("audit #6 : déplacement vers un dossier purement local : la copie du serveur reste", async () => {
  const w = world({ store: archiveStore() });
  const sid = w.server.addMessage("1", mime("modele@x"));
  await w.runAll();
  await w.sync.recordIntent(w.store.userMove("/Inbox", "modele@x", "/Templates"));
  await w.runAll({ reason: "timer" });
  assert(w.server.items.get("1").has(sid), "toujours sur le serveur");
  eq(w.server.items.get("3").size, 0);
  eq(w.server.sent("MoveItems").length, 0);
  eq(await w.sync.journal.size(), 0);
});

// ── #7 Out-of-period messages: the user's actions still reach the server ──

test("audit #7 : message sorti de la période puis supprimé par l'utilisateur : déplacé vers la corbeille du serveur", async () => {
  const w = world();
  const old = w.server.addMessage("1", mime("old-newsletter@x"));
  await w.runAll();
  w.server.softDelete("1", old);
  await w.runAll({ reason: "timer" });
  eq((await loadCollection(w.records, "1")).aged.size, 1, "lien gardé à part");
  await w.sync.recordIntent(w.store.userDelete("/Inbox", "old-newsletter@x"));
  await w.runAll({ reason: "timer" });
  assert(!w.server.items.get("1").has(old), "plus dans la boîte de réception du serveur");
  eq(w.server.items.get("3").size, 1, "dans la corbeille du serveur");
  eq(await w.sync.journal.size(), 0);
});

test("audit #7 : message sorti de la période marqué lu par l'utilisateur : le serveur le reçoit", async () => {
  const w = world();
  const old = w.server.addMessage("1", mime("old@x"));
  await w.runAll();
  w.server.softDelete("1", old);
  await w.runAll({ reason: "timer" });
  await w.sync.recordIntent(w.store.userFlags("/Inbox", "old@x", { read: true }));
  await w.runAll({ reason: "timer" });
  eq(w.server.items.get("1").get(old).read, true);
});

// ── #8 Attaching by Message-ID needs more than the Message-ID ────────────

for (const cleanup of [true, false]) {
  test(`audit #8 : resynchro complète, un message qui reprend le Message-ID d'un autre ne prend pas sa copie${cleanup ? "" : " (copie distincte déjà là)"}`, async () => {
    const w = world();
    const victim = w.server.addMessage("1", mime("contract-2026@corp.example", "Contrat signé"));
    await w.runAll();
    const evil = w.server.addMessage("1", mime("contract-2026@corp.example", "Faux"));
    await w.runAll({ reason: "timer" });
    const items = w.server.items.get("1");
    w.server.items.set("1", new Map([[evil, items.get(evil)], [victim, items.get(victim)]])); // the server lists the newer first
    if (cleanup) for (const m of w.store.messages("/Inbox")) if (m.mid !== "contract-2026@corp.example") w.store.folders.get("/Inbox").msgs.delete(m.id);
    const imports = w.imports();
    w.server.invalidate("1");
    await w.runAll({ reason: "timer" });
    const coll = await loadCollection(w.records, "1");
    eq(coll.midOf(victim), "contract-2026@corp.example", "la copie d'origine reste à son élément");
    eq(w.store.messages("/Inbox").length, 2, "ni doublon ni orpheline");
    eq(w.imports() - imports, cleanup ? 1 : 0, "seule la copie distincte effacée revient");
    w.server.deleteMessage("1", evil);
    await w.runAll({ reason: "timer" });
    const left = w.store.messages("/Inbox");
    eq(left.map((m) => subjectOf(m.bytes)), ["Contrat signé"]);
  });
}

// ── #9 Journal and tables written in proportion to the change ─────────────

test("audit #9 : 8 000 suppressions locales d'un coup : quelques écritures, pas une par action", async () => {
  const area = memoryArea();
  let bytes = 0;
  const set = area.set.bind(area);
  area.set = async (obj) => {
    for (const val of Object.values(obj)) bytes += JSON.stringify(val).length;
    return set(obj);
  };
  const journal = new Journal({ records: new Store(area).mailbox(MB) });
  const listeners = {};
  const ev = (name) => ({ addListener: (fn) => (listeners[name] = fn), removeListener() {} });
  const browser = {
    messages: { onUpdated: ev("u"), onMoved: ev("m"), onDeleted: ev("d"), continueList: async () => null },
    folders: { onCreated: ev("fc"), onRenamed: ev("fr"), onMoved: ev("fm"), onDeleted: ev("fd") },
  };
  const events = new LocalEvents({ browser, echo: new EchoRegistry(), isMarked: () => true, onIntent: async (_, i) => journal.append(i) });
  events.start();
  const N = 8000;
  const msgs = Array.from({ length: N }, (_, i) => ({ headerMessageId: `msg${i}-abcdefghijklmnop@example.org`, folder: { accountId: "account1", path: "/Inbox/Clients/2025" } }));
  const started = Date.now();
  listeners.d({ messages: msgs, id: null });
  await events.idle();
  await journal.flush();
  assert(area.writes < 100, `écritures : ${area.writes}`);
  assert(bytes < 5e6, `octets écrits : ${bytes}`);
  assert(Date.now() - started < 3000, "rapide");
  eq(await new Journal({ records: new Store(area).mailbox(MB) }).size(), N, "tout est enregistré");
});

test("audit #9 : la table d'un dossier s'écrit par morceaux pendant la première synchro (coût linéaire)", async () => {
  const cost = async (n) => {
    const w = world();
    for (let i = 0; i < n; i++) w.server.addMessage("1", mime(`m${i}@x`));
    let bytes = 0;
    const set = w.area.set.bind(w.area);
    w.area.set = async (o) => {
      for (const [k, val] of Object.entries(o)) if (/\/(coll|cseg):/.test(k)) bytes += JSON.stringify(val).length;
      return set(o);
    };
    await w.runAll();
    eq((await loadCollection(w.records, "1")).items.size, n, "table relue entière");
    return bytes;
  };
  const small = await cost(1000);
  const big = await cost(4000);
  assert(big < small * 6, `quatre fois plus de messages, au plus six fois plus d'octets (${small} → ${big})`);
});

// ── #10 The Message-ID Thunderbird reads is the one linked ────────────────

test("audit #10 : formes de Message-ID lues différemment selon le lecteur : un identifiant propre, l'ancien renommé", () => {
  const cases = [
    "Message-ID: <a@b> (copie de liste)\r\nSubject: x\r\n\r\ncorps",
    "Message-ID: (c) <a@b>\r\nSubject: x\r\n\r\ncorps",
    "Message-ID : <a@b>\r\nSubject: x\r\n\r\ncorps",
    "ligne parasite\r\nMessage-ID: <a@b>\r\n\r\ncorps",
    `X${String.fromCharCode(0)}y: z\r\nMessage-ID: <a@b>\r\n\r\ncorps`,
  ];
  for (const raw of cases) {
    const r = ensureMessageId(encodeUtf8(raw));
    eq(r.synthetic, true, JSON.stringify(raw));
    const out = decodeUtf8(r.bytes);
    assert(out.startsWith(`Message-ID: <${r.messageId}>\r\n`), "notre champ en tête");
    assert(out.includes(`${ORIGINAL_ID_FIELD}`) && !/\nMessage-ID ?:/.test(out), "l'ancien champ renommé");
    eq(messageIdOf(r.bytes), r.messageId);
  }
});

test("audit #10 : message qui commence par un blanc : jamais replié sur notre Message-ID", () => {
  const raw = encodeUtf8("\tsuite\r\nSubject: x\r\n\r\ncorps");
  const r = ensureMessageId(raw);
  assert(decodeUtf8(r.bytes).startsWith(`Message-ID: <${r.messageId}>\r\nX-Sync443-Continuation:\r\n\tsuite\r\n`), decodeUtf8(r.bytes));
  eq(messageIdOf(r.bytes), r.messageId);
  const d = distinctCopy(encodeUtf8("\tdébut\r\nMessage-ID: <a@b>\r\nSubject: x\r\n\r\ncorps"), "1", "1:5");
  const s = decodeUtf8(d.bytes);
  assert(s.startsWith(`Message-ID: <${d.messageId}>\r\nX-Sync443-Continuation:\r\n\tdébut\r\n`), s);
  eq(messageIdOf(d.bytes), d.messageId);
});

/** A store that reads Message-IDs as Thunderbird's mailbox parser does (first field, one < and one > stripped). */
class TbLikeStore extends FakeMailStore {
  async importMessage(path, bytes, flags, o) {
    const r = await super.importMessage(path, bytes, flags, o);
    const head = decodeUtf8(bytes).split(/\r\n\r\n|\n\n/)[0].replace(/\r?\n[ \t]+/g, " ");
    let read = null;
    for (const line of head.split(/\r\n|\n|\r/)) {
      const i = line.indexOf(":");
      if (i > 0 && line.slice(0, i).toLowerCase() === "message-id") {
        read = line.slice(i + 1).trim().replace(/^</, "").replace(/>$/, "");
        break;
      }
    }
    if (this.override) read = this.override(read);
    for (const f of this.folders.values()) if (f.msgs.has(r.id)) f.msgs.get(r.id).mid = read;
    return { ...r, messageId: read };
  }
}

test("audit #10 : Message-ID suivi d'un commentaire : Thunderbird et le moteur lisent le même, suppressions dans les deux sens", async () => {
  const w = world({ store: new TbLikeStore() });
  const raw = encodeUtf8("Message-ID: <promo-77@spam.example> (sent by bulk mailer)\r\nSubject: Promo\r\nFrom: x@spam.example\r\n\r\ncorps\r\n");
  const sid = w.server.addMessage("1", raw);
  await w.runAll();
  const [local] = w.store.messages("/Inbox");
  eq((await loadCollection(w.records, "1")).midOf(sid), local.mid, "lien sur ce que Thunderbird a lu");
  await w.sync.recordIntent(w.store.userDelete("/Inbox", local.mid));
  await w.runAll({ reason: "timer" });
  assert(!w.server.items.get("1").has(sid), "la suppression de l'utilisateur part");
  const sid2 = w.server.addMessage("1", encodeUtf8("Message-ID: <n2@x> trailing\r\nSubject: deux\r\n\r\nb\r\n"));
  await w.runAll({ reason: "timer" });
  w.server.deleteMessage("1", sid2);
  await w.runAll({ reason: "timer" });
  eq(w.store.mids("/Inbox"), [], "la suppression du serveur atteint la copie locale");
});

test("audit #10 : Thunderbird lit un autre identifiant que le nôtre : sa lecture est liée (ou le message réimporté s'il est inutilisable)", async () => {
  const store = new TbLikeStore();
  store.override = (read) => (read === "ok@x" ? "ok-lu-autrement@x" : read === "blanc@x" ? "blanc @x" : read);
  const w = world({ store });
  const a = w.server.addMessage("1", mime("ok@x"));
  const b = w.server.addMessage("1", mime("blanc@x"));
  await w.runAll();
  const coll = await loadCollection(w.records, "1");
  eq(coll.midOf(a), "ok-lu-autrement@x");
  assert(/@sync443\.invalid$/.test(coll.midOf(b)), `réimporté sous notre identifiant : ${coll.midOf(b)}`);
  eq(w.store.mids("/Inbox").filter((m) => m.includes(" ")), [], "la copie illisible est retirée");
  eq(w.store.mids("/Trash"), [], "et pas gardée à la corbeille");
  await w.sync.recordIntent(w.store.userDelete("/Inbox", "ok-lu-autrement@x"));
  await w.runAll({ reason: "timer" });
  assert(!w.server.items.get("1").has(a));
});

// ── #11 Folder names, never path segments ─────────────────────────────────

/** A store that keeps some folders under another file name than their name (as Thunderbird hashes some names). */
class HashingStore extends FakeMailStore {
  async createFolder(parentPath, name) {
    const hashed = /[é#]/.test(name) ? `h${[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1e9, 7)}` : name;
    const path = await super.createFolder(parentPath, hashed);
    this.names.set(path, name);
    return path;
  }
  get names() {
    this._names ??= new Map();
    return this._names;
  }
  async listFolders() {
    return (await super.listFolders()).map((f) => ({ ...f, name: this.names.get(f.path) ?? f.name }));
  }
}

test("audit #11 : dossier stocké sous un autre nom de fichier : pas de renommage à chaque passage, sous-dossiers synchronisés", async () => {
  const w = world({ store: new HashingStore(), folders: extra([["8", "0", "Café"], ["9", "8", "Sous"]]) });
  w.server.addMessage("8", mime("c@x"));
  w.server.addMessage("9", mime("s@x"));
  await w.runAll();
  await w.runAll({ reason: "timer" });
  const path8 = (await loadCollection(w.records, "8")).path;
  assert(path8 && !path8.includes("Café"), path8);
  eq(w.store.mids(path8), ["c@x"]);
  eq(w.store.mids(`${path8}/Sous`), ["s@x"], "le sous-dossier existe et se synchronise");
  eq(w.store.writes.filter((x) => x[0] === "renameFolder" || x[0] === "moveFolder"), [], "aucun renommage répété");
  assert(!w.log.lines.some(([, m]) => m.includes("déplacement local impossible")));
});

test("audit #11 : un dossier créé localement part avec son nom, jamais son nom de fichier", async () => {
  const w = world({ store: new HashingStore() });
  await w.runAll();
  const path = await w.store.createFolder("/", "Thé");
  await w.sync.recordIntent({ kind: "folderCreate", path });
  await w.runAll({ reason: "timer" });
  eq(text(w.server.sent("FolderCreate")[0], "DisplayName"), "Thé");
});

test("audit B : déplacer localement un dossier au nom décoré (« Projets (2) ») garde le nom du serveur", async () => {
  const w = world({ folders: extra([["8", "0", "Projets"], ["9", "0", "projets"]]) });
  await w.runAll();
  const p9 = (await loadCollection(w.records, "9")).path;
  eq(p9, "/projets (2)", "nom décoré localement");
  w.store.userRenameFolder(p9, `/Inbox${p9}`);
  await w.sync.recordIntent({ kind: "folderMove", path: p9, toPath: `/Inbox${p9}` });
  await w.runAll({ reason: "timer" });
  const update = w.server.sent("FolderUpdate")[0];
  eq([text(update, "ParentId"), text(update, "DisplayName")], ["1", "projets"]);
  eq(w.server.folders.get("9").name, "projets");
});

// ── #12 A failed import is fetched again ──────────────────────────────────

test("audit #12 : un import qui échoue une fois est redemandé (Fetch) et arrive", async () => {
  const w = world();
  await w.runAll();
  ["a", "b", "c"].forEach((m) => w.server.addMessage("1", mime(`${m}@x`)));
  w.store.failImport = 1;
  const r = await w.runAll({ reason: "timer" });
  eq(w.store.mids("/Inbox"), ["a@x", "b@x", "c@x"]);
  eq(r.failed, 0);
  eq((await w.records.get("health", null)).failedItems, 0);
});

test("audit #12 : un import qui échoue toujours est signalé dans la santé, puis mis en quarantaine", async () => {
  const w = world();
  await w.runAll();
  w.server.addMessage("1", mime("bad@x"));
  w.store.failImport = 1000;
  await w.sync.run({ reason: "timer" });
  eq((await w.records.get("health", null)).failedItems, 1);
  for (let k = 0; k < MAX_FETCH_ATTEMPTS + 1; k++) await w.sync.run({ reason: "timer" });
  const coll = await loadCollection(w.records, "1");
  eq(coll.failed.size, 0);
  assert(coll.quarantine.some((q) => q.reason.includes("abandonné")), "quarantaine après les essais");
  eq((await w.records.get("health", null)).failedItems, 0);
});

// ── #14 Flags set by an import are not sent back ──────────────────────────

test("audit #14 : les drapeaux posés par l'import (lu, suivi) ne reviennent pas au journal", async () => {
  const server = new FakeServer();
  const browser = fakeBrowser();
  const A = "account1";
  browser.addFolder(A, "/");
  for (const [p, u] of [["/Inbox", ["inbox"]], ["/Trash", ["trash"]], ["/Sent", ["sent"]], ["/Drafts", ["drafts"]]]) browser.addFolder(A, p, u);
  const echo = new EchoRegistry({ now: () => 0 });
  const mailStore = new MailStore({ accountKey: A, echo, browser, timers: { set: () => 0, clear() {} }, makeFile: (bytes) => ({ bytes }) });
  const sync = new MailboxSync({ mailbox: { id: MB, accountKey: A, filterType: "0", sync: MAIL }, store: new Store(memoryArea()), clientFactory: async () => server, mailStore, log: quietLog(), now: () => 0 });
  const events = new LocalEvents({ browser, echo, isMarked: (k) => k === A, onIntent: (k, i) => sync.recordIntent(i) });
  events.start();
  server.addMessage("1", mime("lu@x"), { read: true, flagged: true });
  await sync.run({ reason: "user" });
  await events.idle();
  const [m] = browser.inFolder(A, "/Inbox");
  eq([m.read, m.flagged], [true, true]);
  eq(await sync.journal.size(), 0, "aucun Change renvoyé au serveur");
  eq(echo.size, 0);
});

// ── #15 MoveItems without DstMsgId ────────────────────────────────────────

test("audit #15 : déplacement accepté sans DstMsgId : la destination n'hérite pas du ServerId de la source", async () => {
  const w = world();
  const sid = w.server.addMessage("1", mime("m@x"));
  await w.runAll();
  w.server.hook("MoveItems", (req) => {
    const src = text(req.children[0], "SrcMsgId");
    const item = w.server.items.get("1").get(src);
    w.server.items.get("1").delete(src);
    w.server.items.get("6").set("6:900", item);
    return el("Move:MoveItems", [el("Response", [el("SrcMsgId", src), el("Status", "3")])]);
  });
  await w.sync.recordIntent(w.store.userMove("/Inbox", "m@x", "/Inbox/Projets"));
  await w.sync.run({ reason: "timer" });
  const projets = await loadCollection(w.records, "6");
  assert(!projets.items.has(sid), "pas de lien vers le ServerId de la source");
  eq((await loadCollection(w.records, "1")).items.has(sid), false);
});

// ── #16 Retained deletions do not survive a remap ─────────────────────────

test("audit #16 : suppressions retenues puis dossier local recréé : abandonnées, jamais appliquées aux nouvelles copies", async () => {
  const w = world();
  for (let n = 0; n < 100; n++) w.server.addMessage("6", mime(`k${n}@x`));
  await w.runAll();
  for (const sid of [...w.server.items.get("6").keys()].slice(0, 60)) w.server.deleteMessage("6", sid);
  const r = await w.sync.run({ reason: "timer" });
  eq(r.status, "blocked");
  w.store.userRemoveFolder("/Inbox/Projets"); // the local folder disappears: recreated and rebuilt
  const confirmed = await w.sync.run({ reason: "user", confirmDeletes: true });
  eq(confirmed.deleted, 0, "les suppressions retenues de l'ancienne table ne s'appliquent pas au dossier recréé");
  await w.runAll({ reason: "timer" });
  eq(w.store.messages("/Inbox/Projets").length, 40, "ce que le serveur a vraiment");
  eq(w.store.messages("/Trash").length, 0, "aucune copie recréée mise à la corbeille");
  eq((await w.sync.pendingDeletes()).count, 0);
});

// ── close() (for background.mjs: one engine at a time per mailbox) ────────

test("close : pendant un passage, il l'annule, l'attend ; ensuite plus aucune écriture", async () => {
  const w = world();
  w.server.addMessage("1", mime("a@x"));
  await w.runAll();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  w.server.hook("FolderSync", async () => {
    await gate;
    return undefined;
  });
  const pass = w.sync.run({ reason: "timer" });
  for (let i = 0; i < 50; i++) await Promise.resolve();
  assert(w.sync.running);
  const closing = w.sync.close();
  release();
  await rejects(pass, (e) => e.code === "CANCELLED");
  await closing;
  assert(!w.sync.running);
  const writes = w.area.writes;
  eq((await w.sync.run({ reason: "user" })).reason, "CLOSED");
  w.sync.startPush();
  eq(w.sync.pushing, false);
  await rejects(w.sync.discardPendingDeletes(), (e) => e.code === "CLOSED");
  eq(w.area.writes, writes, "aucune écriture après close()");
});

test("close : les écritures du journal en attente sont faites avant qu'il ne rende la main", async () => {
  const w = world();
  await w.runAll();
  await w.sync.recordIntent({ kind: "delete", path: "/Inbox", messageId: "x@y" });
  await w.sync.close();
  const again = new Journal({ records: new Store(w.area).mailbox(MB) });
  eq((await again.list()).map((e) => e.messageId), ["x@y"]);
});

test("close : recordIntent ensuite est refusé (code CLOSED), pour que l'arrière-plan le garde pour le moteur suivant", async () => {
  const w = world();
  await w.sync.close();
  await rejects(w.sync.recordIntent({ kind: "delete", path: "/Inbox", messageId: "x@y" }), (e) => e.code === "CLOSED");
  const next = w.make();
  eq((await next.recordIntent({ kind: "delete", path: "/Inbox", messageId: "x@y" })).messageId, "x@y");
});

// ── B: cleanDraft cost bounded ────────────────────────────────────────────

test("audit B : cleanDraft, 32 frontières au long préfixe commun et des milliers de lignes « -- » : temps linéaire", () => {
  const prefix = "p".repeat(190);
  const lines = [];
  for (let i = 0; i < 32; i++) lines.push(`Content-Type: multipart/mixed; boundary="${prefix}${i}"`, "", `--${prefix}${i}`);
  lines.push("Content-Type: text/plain", "", "");
  const filler = `--${prefix}X`;
  for (let i = 0; i < 20_000; i++) lines.push(filler);
  const input = encodeUtf8(lines.join("\r\n"));
  const started = Date.now();
  cleanDraft(input);
  const ms = Date.now() - started;
  assert(ms < 1500, `${ms} ms`);
});

// ── Verification audit (second round) ─────────────────────────────────────

for (const act of ["delete", "move", "flags"]) {
  test(`vérif. 1 : resynchro complète sur plusieurs passages (1 500 messages), ${act} en attente : envoyé, jamais « envoyé » à vide`, async () => {
    const w = world();
    const sids = [];
    for (let i = 0; i < 1500; i++) sids.push(w.server.addMessage("1", mime(`m${i}@x`)));
    await w.runAll();
    const target = "m1400@x";
    const sid = sids[1400];
    if (act === "delete") await w.sync.recordIntent(w.store.userDelete("/Inbox", target));
    else if (act === "move") await w.sync.recordIntent(w.store.userMove("/Inbox", target, "/Inbox/Projets"));
    else await w.sync.recordIntent(w.store.userFlags("/Inbox", target, { read: true }));
    w.server.invalidate("1"); // Status 3 on the Sync that carries the change
    await w.runAll({ reason: "timer" });
    await w.runAll({ reason: "timer" });
    eq(await w.sync.journal.size(), 0);
    if (act === "flags") {
      eq(w.server.items.get("1").get(sid).read, true, "lu sur le serveur");
      eq(w.store.messages("/Inbox").find((m) => m.mid === target).read, true, "toujours lu localement");
    } else {
      assert(!w.server.items.get("1").has(sid), "plus dans la boîte de réception du serveur");
      eq(w.store.mids("/Inbox").includes(target), false, "pas revenu localement");
      if (act === "move") eq(w.server.items.get("6").size, 1, "dans Projets sur le serveur");
    }
  });
}

test("vérif. 1 : actions de l'utilisateur pendant une reconstruction en cours : attendues, puis envoyées", async () => {
  const w = world();
  const sids = [];
  for (let i = 0; i < 1500; i++) sids.push(w.server.addMessage("1", mime(`m${i}@x`)));
  await w.runAll();
  w.server.invalidate("1");
  await w.sync.run({ reason: "timer", round: 0 }); // the rebuild starts (about 1 000 items)
  await w.sync.recordIntent(w.store.userDelete("/Inbox", "m1400@x"));
  await w.sync.recordIntent(w.store.userFlags("/Inbox", "m1450@x", { read: true }));
  await w.runAll({ reason: "local" });
  await w.runAll({ reason: "timer" });
  assert(!w.server.items.get("1").has(sids[1400]));
  eq(w.store.mids("/Inbox").includes("m1400@x"), false);
  eq(w.server.items.get("1").get(sids[1450]).read, true);
  eq(w.store.messages("/Inbox").find((m) => m.mid === "m1450@x").read, true);
});

test("vérif. 2 : réinitialisation du partenariat avec des actions en attente : elles suivent les nouveaux ServerId", async () => {
  const folders = extra([["8", "0", "Clients"]]);
  const w = world({ folders });
  for (let i = 0; i < 5; i++) w.server.addMessage("1", mime(`in${i}@x`));
  for (let i = 0; i < 5; i++) w.server.addMessage("8", mime(`cl${i}@x`));
  await w.runAll();
  await w.sync.recordIntent(w.store.userDelete("/Inbox", "in0@x"));
  await w.sync.recordIntent(w.store.userMove("/Inbox", "in1@x", "/Clients"));
  await w.sync.recordIntent(w.store.userFlags("/Clients", "cl0@x", { read: true }));
  const map = new Map(folders.map((f) => [f.id, `n${f.id}`]));
  const server = new FakeServer({ folders: folders.map((f) => ({ ...f, id: map.get(f.id), parentId: f.parentId === "0" ? "0" : map.get(f.parentId) })) });
  for (const [cid, items] of w.server.items) for (const it of items.values()) if (server.items.has(map.get(cid))) server.addMessage(map.get(cid), it.mime, it);
  w.server = server;
  await w.records.set("hierarchy", { syncKey: "0" });
  await w.runAll({ reason: "timer" });
  await w.runAll({ reason: "timer" });
  const find = (cid, mid) => [...server.items.get(cid).values()].find((it) => decodeUtf8(it.mime).includes(`<${mid}>`));
  eq(await w.sync.journal.size(), 0);
  assert(!find("n1", "in0@x"), "suppression reçue");
  assert(!find("n1", "in1@x") && find("n8", "in1@x"), "déplacement reçu");
  eq(find("n8", "cl0@x").read, true, "drapeau reçu");
  eq(w.store.mids("/Inbox").filter((m) => m === "in0@x" || m === "in1@x"), [], "rien ne revient");
});

test("vérif. 3 : import (Thunderbird 160 : « nouveau » → lu → non lu, puis drapeau) : aucune action de l'utilisateur inventée", async () => {
  const browser = fakeBrowser();
  const A = "account5";
  browser.addFolder(A, "/", []);
  for (const [p, u] of [["/Inbox", ["inbox"]], ["/Trash", ["trash"]]]) browser.addFolder(A, p, u);
  const echo = new EchoRegistry({ now: () => 0 });
  const pending = [];
  const timers = { set: (fn) => pending.push(fn), clear() {} };
  const store = new MailStore({ accountKey: A, echo, browser, timers, makeFile: (bytes) => ({ bytes }) });
  const intents = [];
  const events = new LocalEvents({ browser, echo, isMarked: (k) => k === A, onIntent: (k, i) => intents.push(i) });
  events.start();
  const m = (mid) => encodeUtf8(`Message-ID: <${mid}>\r\nSubject: t\r\nFrom: a@b.c\r\n\r\ncorps\r\n`);
  await store.importMessage("/Inbox", m("unread@x"), { read: false, flagged: false });
  await store.importMessage("/Inbox", m("read@x"), { read: true, flagged: false });
  await store.importMessage("/Inbox", m("flag@x"), { read: false, flagged: true });
  await events.idle();
  eq(intents, [], "aucune intention");
  for (const fn of pending.splice(0)) fn();
  eq(echo.size, 0, "aucune attente ne traîne");
  eq(browser.inFolder(A, "/Inbox").map((x) => [x.headerMessageId, x.read, x.flagged]), [["unread@x", false, false], ["read@x", true, false], ["flag@x", false, true]]);
});

test("vérif. 4 : la fenêtre glissante des suppressions survit à une resynchro complète (Status 3)", async () => {
  const w = world();
  const sids = [];
  for (let i = 0; i < 200; i++) sids.push(w.server.addMessage("1", mime(`m${i}@x`)));
  await w.runAll();
  let blocked = false;
  for (let cycle = 0; cycle < 3 && !blocked; cycle++) {
    for (const sid of sids.slice(cycle * 50, cycle * 50 + 50)) w.server.deleteMessage("1", sid);
    const r = await w.runAll({ reason: "timer" });
    blocked = r.status === "blocked";
    w.t += 60_000;
    if (!blocked) {
      w.server.invalidate("1");
      await w.runAll({ reason: "timer" });
      w.t += 60_000;
    }
  }
  assert(blocked, "retenu malgré les resynchros");
  eq(w.store.mids("/Trash").length, 50, "seule la première salve est appliquée");
});

test("vérif. 5 : dossier vidé par une resynchro puis supprimé : compté par ses messages locaux, retenu", async () => {
  const w = world({ folders: extra([["8", "0", "Clients"]]) });
  for (let i = 0; i < 400; i++) w.server.addMessage("8", mime(`cl${i}@x`));
  await w.runAll();
  w.server.items.set("8", new Map());
  w.server.invalidate("8");
  await w.runAll({ reason: "timer" });
  eq((await loadCollection(w.records, "8")).size, 0, "table vide");
  w.server.deleteFolder("8");
  const r = await w.runAll({ reason: "timer" });
  eq([r.status, r.reason], ["blocked", MASS_DELETE]);
  eq(w.store.mids("/Clients").length, 400, "rien n'a bougé");
  eq((await w.sync.pendingDeletes()).count, 400);
});

test("vérif. 6 : liens hors période gardés par une resynchro complète ; la suppression de l'utilisateur part", async () => {
  const w = world();
  const out = new Set();
  const onSync = w.server.onSync.bind(w.server);
  w.server.onSync = (req) => {
    const r = onSync(req);
    for (const st of w.server.colls.values()) st.pending = st.pending.filter((c) => !(c.op === "add" && out.has(c.sid)));
    return r;
  };
  w.server.addMessage("1", mime("recent@x"));
  const old = w.server.addMessage("1", mime("old@x"));
  await w.runAll();
  out.add(old);
  w.server.softDelete("1", old);
  await w.runAll({ reason: "timer" });
  w.server.invalidate("1");
  await w.runAll({ reason: "timer" });
  eq([...(await loadCollection(w.records, "1")).aged.keys()], [old], "lien hors période gardé");
  await w.sync.recordIntent(w.store.userDelete("/Inbox", "old@x"));
  await w.runAll({ reason: "local" });
  assert(!w.server.items.get("1").has(old));
  eq(w.server.items.get("3").size, 1, "dans la corbeille du serveur");
});

test("vérif. 7 : « Archives » du serveur mis à la corbeille sur le webmail : délié, l'archivage suivant va dans un dossier « Archives » à la racine", async () => {
  const w = world({ store: archiveStore(), folders: extra([["9", "0", "Archives"]]) });
  const contract = w.server.addMessage("1", mime("contract@x"));
  w.server.addMessage("9", mime("old@x"));
  await w.runAll();
  w.server.updateFolder("9", { parentId: "3" });
  await w.runAll({ reason: "timer" });
  eq(await w.records.get("archives", null), null, "lien retiré");
  await w.sync.recordIntent(w.store.userMove("/Inbox", "contract@x", "/Archives"));
  await w.runAll({ reason: "local" });
  assert(!w.server.items.get("1").has(contract));
  eq(w.server.items.get("9").size, 1, "rien de nouveau dans le dossier mis à la corbeille");
  const top = [...w.server.folders].find(([id, f]) => id !== "9" && f.parentId === "0" && f.name === "Archives");
  assert(top, "un nouveau dossier Archives à la racine");
  eq(w.server.items.get(top[0]).size, 1);
});

test("vérif. 8 : passage arrêté juste après un renommage temporaire : le nom noté d'avance est repris, rien de retéléchargé", async () => {
  const w = world({ folders: extra([["8", "0", "A"], ["9", "0", "B"]]) });
  for (let i = 0; i < 3; i++) {
    w.server.addMessage("8", mime(`a${i}@x`));
    w.server.addMessage("9", mime(`b${i}@x`));
  }
  await w.runAll();
  w.server.updateFolder("8", { name: "B" });
  w.server.updateFolder("9", { name: "A" });
  const rename = w.store.renameFolder.bind(w.store);
  let n = 0;
  w.store.renameFolder = async (...a) => {
    const r = await rename(...a);
    if (++n === 1) await new Promise(() => {}); // the process dies right after the first rename
    return r;
  };
  w.sync.run({ reason: "timer", round: 0 }); // never ends
  for (let i = 0; i < 2000 && n === 0; i++) await Promise.resolve();
  for (let i = 0; i < 200; i++) await Promise.resolve();
  eq([...w.store.folders.keys()].filter((p) => p.includes("Sync443")).length, 1, "arrêté avec un dossier au nom temporaire");
  w.store.renameFolder = rename;
  w.sync = w.make(); // a new start, on the storage as the pass left it
  const imports = w.imports();
  await w.runAll({ reason: "timer" });
  eq(w.store.mids("/B"), ["a0@x", "a1@x", "a2@x"]);
  eq(w.store.mids("/A"), ["b0@x", "b1@x", "b2@x"]);
  eq([...w.store.folders.keys()].filter((p) => p.includes("Sync443")), [], "aucun nom temporaire ne reste");
  eq(w.imports(), imports, "rien de retéléchargé");
});

test("vérif. 8 : un dossier de l'utilisateur nommé « Sync443 1 » n'est jamais pris pour un dossier temporaire", async () => {
  const w = world();
  for (let i = 0; i < 10; i++) w.server.addMessage("6", mime(`p${i}@x`));
  await w.runAll();
  w.store.userAddFolder("/Sync443 1");
  let id = 5000;
  for (const m of w.store.messages("/Inbox/Projets").slice(0, 5)) w.store.folders.get("/Sync443 1").msgs.set(id++, { mid: m.mid, read: false, flagged: false });
  w.store.folders.get("/Sync443 1").msgs.set(id++, { mid: "note@x", read: false, flagged: false });
  w.store.userRemoveFolder("/Inbox/Projets");
  await w.runAll({ reason: "timer" });
  eq(w.store.messages("/Sync443 1").length, 6, "le dossier de l'utilisateur reste tel quel");
  eq(w.store.mids("/Inbox/Projets").length, 10, "le dossier du serveur est recréé et rechargé");
  eq((await loadCollection(w.records, "6")).items.size, 10);
});

for (const fakeFirst of [true, false]) {
  test(`vérif. 9 : resynchro complète, un élément qui reprend le Message-ID d'un message supprimé ne prend pas sa suppression (${fakeFirst ? "l'imposteur d'abord" : "l'original d'abord"})`, async () => {
    const w = world();
    const original = w.server.addMessage("1", mime("m@x", "Original"));
    await w.runAll();
    await w.sync.recordIntent(w.store.userDelete("/Inbox", "m@x"));
    const fake = w.server.addMessage("1", mime("m@x", "Faux"));
    const items = w.server.items.get("1");
    const order = fakeFirst ? [fake, original] : [original, fake];
    w.server.items.set("1", new Map(order.map((sid) => [sid, items.get(sid)])));
    w.server.invalidate("1");
    await w.runAll({ reason: "timer" });
    await w.runAll({ reason: "timer" });
    assert(!w.server.items.get("1").has(original), "l'original supprimé sur le serveur, comme voulu");
    assert(w.server.items.get("1").has(fake), "l'autre élément n'est pas supprimé à sa place");
    eq(w.store.messages("/Inbox").map((m) => subjectOf(m.bytes)), ["Faux"], "l'original ne revient pas");
  });
}

test("vérif. 10 : Thunderbird lit un Message-ID déjà présent dans le dossier : réimporté sous un identifiant propre, jamais deux éléments sur un même identifiant", async () => {
  const store = new TbLikeStore();
  store.override = (read) => (read === "ok@x" ? "copie@x" : read);
  const w = world({ store });
  await w.runAll();
  await w.store.importMessage("/Inbox", mime("copie@x", "copie de l'utilisateur"), {});
  const sid = w.server.addMessage("1", mime("ok@x"));
  await w.runAll({ reason: "timer" });
  const coll = await loadCollection(w.records, "1");
  assert(/@sync443\.invalid$/.test(coll.midOf(sid)), coll.midOf(sid));
  eq(coll.refs("copie@x"), 0);
  eq(w.store.messages("/Inbox").filter((m) => m.mid === "copie@x").map((m) => subjectOf(m.bytes)), ["copie de l'utilisateur"], "la copie de l'utilisateur reste seule");
});

// ── Verification audit (third round) ──────────────────────────────────────

function importWorld({ toggles = true, gate = null } = {}) {
  const browser = fakeBrowser();
  const A = "account5";
  browser.addFolder(A, "/", []);
  browser.addFolder(A, "/Inbox", ["inbox"]);
  let t = 0;
  const echo = new EchoRegistry({ now: () => t });
  const due = []; // timers that run when the clock passes them
  const timers = { set: (fn, ms) => due.push({ fn, at: t + ms }), clear() {} };
  const store = new MailStore({ accountKey: A, echo, browser, timers, makeFile: (bytes) => ({ bytes }) });
  const intents = [];
  const events = new LocalEvents({
    browser,
    echo,
    isMarked: (k) => k === A,
    onIntent: async (k, i) => {
      if (gate) await gate.p;
      intents.push(i);
    },
  });
  events.start();
  if (!toggles) {
    // A Thunderbird whose import marks nothing on its own (the copy does not arrive "new").
    browser.messages.import = async (file, folderId, props) => {
      const id = browser.addMessage(A, "/Inbox", messageIdOf(file.bytes), { read: props.read, flagged: props.flagged });
      return browser.view(id);
    };
  }
  const m = (mid) => encodeUtf8(`Message-ID: <${mid}>\r\nSubject: t\r\nFrom: a@b.c\r\n\r\ncorps\r\n`);
  const advance = (ms) => {
    t += ms;
    for (const d of due.splice(0)) if (d.at <= t) d.fn();
    else due.push(d);
  };
  return { browser, store, intents, events, echo, m, advance };
}

test("vérif. R1 : import sans marques de Thunderbird : l'utilisateur qui marque lu le message une seconde après n'est pas avalé", async () => {
  const s = importWorld({ toggles: false });
  const { id } = await s.store.importMessage("/Inbox", s.m("new@x"), { read: false, flagged: false });
  await s.events.idle();
  s.advance(1000);
  await s.browser.messages.update(id, { read: true });
  await s.events.idle();
  eq(s.intents, [{ kind: "flags", path: "/Inbox", messageId: "new@x", flags: { read: true } }]);
});

test("vérif. R1 : marques de l'import traitées plus de 5 s après (file d'événements occupée) : toujours reconnues", async () => {
  let release;
  const gate = { p: new Promise((r) => (release = r)) };
  const s = importWorld({ gate });
  await s.store.importMessage("/Inbox", s.m("unread@x"), { read: false, flagged: false });
  await s.store.importMessage("/Inbox", s.m("flag@x"), { read: false, flagged: true });
  s.advance(20_000);
  release();
  await s.events.idle();
  eq(s.intents, [], "aucune action inventée");
});

test("vérif. R1 : l'utilisateur marque lu avant que les marques de l'import soient traitées : son changement part, une fois et à la bonne valeur", async () => {
  let release;
  const gate = { p: new Promise((r) => (release = r)) };
  const s = importWorld({ gate });
  const { id } = await s.store.importMessage("/Inbox", s.m("u@x"), { read: false, flagged: false });
  await s.browser.messages.update(id, { read: true }); // queued behind the import's own marks
  release();
  await s.events.idle();
  eq(s.intents, [{ kind: "flags", path: "/Inbox", messageId: "u@x", flags: { read: true } }]);
  await s.browser.messages.update(id, { read: false });
  await s.events.idle();
  eq(s.intents.at(-1).flags, { read: false }, "et le suivant aussi");
});

test("vérif. R3 : Message-ID lu en collision deux fois : la copie de trop est retirée avant la quarantaine, sans rien laisser à la corbeille", async () => {
  class Divergent extends FakeMailStore {
    async importMessage(path, bytes, flags, o) {
      const r = await super.importMessage(path, bytes, flags, o);
      if (decodeUtf8(bytes).includes("X-Hidden")) {
        for (const f of this.folders.values()) if (f.msgs.has(r.id)) f.msgs.get(r.id).mid = "victim@x";
        return { id: r.id, messageId: "victim@x" };
      }
      return r;
    }
  }
  const w = world({ store: new Divergent() });
  const v = w.server.addMessage("1", mime("victim@x", "Contrat"));
  await w.runAll();
  w.server.addMessage("1", mime("evil@x", "Pub", "X-Hidden: 1\r\n"));
  await w.runAll({ reason: "timer" });
  eq(w.store.messages("/Inbox").map((m) => [m.mid, subjectOf(m.bytes)]), [["victim@x", "Contrat"]], "une seule copie sous cet identifiant");
  eq((await loadCollection(w.records, "1")).quarantine.length, 1);
  eq(w.store.mids("/Trash"), [], "aucune copie en collision à la corbeille (elle y compterait contre les autres)");
  w.store.userDelete("/Inbox", "victim@x");
  await w.sync.recordIntent({ kind: "delete", path: "/Inbox", messageId: "victim@x" });
  await w.runAll({ reason: "local" });
  assert(!w.server.items.get("1").has(v), "la suppression de l'utilisateur atteint le serveur");
});

test("vérif. R4 : action enregistrée pendant la reprise des dossiers (ancien ServerId) : elle part vers le nouveau", async () => {
  const w = world();
  for (let i = 0; i < 3; i++) w.server.addMessage("1", mime(`in${i}@x`));
  await w.runAll();
  const map = new Map(DEFAULT_FOLDERS.map((f) => [f.id, `n${f.id}`]));
  const server = new FakeServer({ folders: DEFAULT_FOLDERS.map((f) => ({ ...f, id: map.get(f.id), parentId: f.parentId === "0" ? "0" : map.get(f.parentId) })) });
  for (const [cid, items] of w.server.items) for (const it of items.values()) if (server.items.has(map.get(cid))) server.addMessage(map.get(cid), it.mime, it);
  w.server = server;
  await w.records.set("hierarchy", { syncKey: "0" });
  let recorded = null;
  const set = w.area.set.bind(w.area);
  w.area.set = async (obj) => {
    const r = await set(obj);
    if (!recorded && Object.keys(obj).some((k) => k.endsWith("/coll:n1"))) {
      recorded = w.sync.recordIntent(w.store.userDelete("/Inbox", "in0@x")); // the user acts while the folders are taken over
    }
    return r;
  };
  await w.runAll({ reason: "timer" });
  await w.runAll({ reason: "timer" });
  eq((await recorded).src, "n1", "enregistrée une fois les dossiers repris, avec le nouveau ServerId");
  assert(![...server.items.get("n1").values()].some((it) => decodeUtf8(it.mime).includes("<in0@x>")), "supprimée sur le serveur");
  eq(w.store.mids("/Inbox").includes("in0@x"), false);
  eq(await w.sync.journal.size(), 0);
});

test("vérif. : une entrée qui attend trop longtemps (reconstruction sans fin) compte de nouveau ses essais", async () => {
  const j = new Journal({ records: new Store(memoryArea()).mailbox(MB), log: quietLog() });
  const e = await j.append({ kind: "delete", path: "/Inbox", messageId: "x@y" });
  for (let run = 1; run <= MAX_WAITS; run++) await j.settle(new Map([[e.id, "wait"]]), { run });
  eq((await j.list())[0].attempts, 0, "attendre ne compte pas…");
  await j.settle(new Map([[e.id, "wait"]]), { run: MAX_WAITS + 1 });
  eq((await j.list())[0].attempts, 1, "…jusqu'à la limite");
});

// ── Verification audit (fourth round) ─────────────────────────────────────

/** A partnership reset: the same folders under new ServerIds (`idOf`), with their messages. */
function resetServer(w, folders, idOf) {
  const server = new FakeServer({ folders: folders.map((f) => ({ ...f, id: idOf(f.id), parentId: f.parentId === "0" ? "0" : idOf(f.parentId) })) });
  for (const [cid, items] of w.server.items) for (const it of items.values()) if (server.items.has(idOf(cid))) server.addMessage(idOf(cid), it.mime, it);
  w.server = server;
  return server;
}

test("vérif. A1 : après une reprise, un ancien ServerId redonné à un autre dossier : les actions vont à ce dossier", async () => {
  const folders = extra([["8", "0", "Clients"]]);
  const w = world({ folders });
  w.server.addMessage("1", mime("in0@x"));
  w.server.addMessage("8", mime("cl0@x"));
  await w.runAll();
  const server = resetServer(w, folders, (id) => `n${id}`);
  await w.records.set("hierarchy", { syncKey: "0" });
  await w.runAll({ reason: "timer" });
  server.addFolder("8", "0", "Factures", 12); // the server gives the old id to a new folder
  server.addMessage("8", mime("fa0@x"));
  await w.runAll({ reason: "timer" });
  await w.sync.recordIntent(w.store.userMove("/Inbox", "in0@x", "/Factures"));
  await w.sync.recordIntent(w.store.userDelete("/Factures", "fa0@x"));
  await w.runAll({ reason: "local" });
  const where = (mid) => [...server.items].filter(([, m]) => [...m.values()].some((it) => decodeUtf8(it.mime).includes(`<${mid}>`))).map(([cid]) => cid);
  eq(where("in0@x"), ["8"], "déplacé dans Factures");
  eq(where("fa0@x"), ["n3"], "supprimé (corbeille du serveur)");
  eq(w.store.mids("/Clients"), ["cl0@x"]);
});

test("vérif. A2 : réinitialisation qui redonne d'anciens ServerId à d'autres dossiers : chaque dossier local garde le sien", async () => {
  const folders = extra([["8", "0", "Clients"]]);
  const w = world({ folders });
  for (let i = 0; i < 3; i++) w.server.addMessage("6", mime(`pr${i}@x`));
  for (let i = 0; i < 3; i++) w.server.addMessage("8", mime(`cl${i}@x`));
  await w.runAll();
  w.store.folders.get("/Clients").msgs.set(9999, { mid: "note-locale@x", read: false, flagged: false });
  await w.sync.recordIntent(w.store.userDelete("/Clients", "cl0@x"));
  const swap = new Map([["6", "8"], ["8", "6"]]);
  const server = resetServer(w, folders, (id) => swap.get(id) ?? id);
  await w.records.set("hierarchy", { syncKey: "0" });
  const imports = w.imports();
  await w.runAll({ reason: "timer" });
  await w.runAll({ reason: "timer" });
  eq(w.store.mids("/Clients"), ["cl1@x", "cl2@x", "note-locale@x"]);
  eq(w.store.mids("/Inbox/Projets"), ["pr0@x", "pr1@x", "pr2@x"]);
  eq(w.store.writes.filter((x) => x[0] === "import" && x[1] !== "/Trash").length, imports, "rien de retéléchargé (le message supprimé revient seulement par la corbeille du serveur)");
  assert(![...server.items.get("6").values()].some((it) => decodeUtf8(it.mime).includes("<cl0@x>")), "la suppression atteint Clients sous son nouveau ServerId");
  eq(server.items.get("8").size, 3, "Projets intact");
});

test("vérif. A2 : simple renommage pendant une liste reprise de zéro : toujours suivi, sans retéléchargement", async () => {
  const w = world({ folders: extra([["8", "0", "Clients"]]) });
  for (let i = 0; i < 3; i++) w.server.addMessage("8", mime(`cl${i}@x`));
  await w.runAll();
  w.server.updateFolder("8", { name: "Clients 2026" });
  await w.records.set("hierarchy", { syncKey: "999" }); // refused: the whole list again
  const imports = w.imports();
  await w.runAll({ reason: "timer" });
  eq(w.store.mids("/Clients 2026"), ["cl0@x", "cl1@x", "cl2@x"]);
  eq(w.imports(), imports);
});

// ── Empty Sync answers (Exchange: a folder with no changes answers HTTP 200 without a body) ──

test("dossiers vides : leur table est complète dès le premier passage, une suppression locale y est réglée, un passage suffit", async () => {
  const w = world();
  w.server.addMessage("1", mime("in0@x"));
  let r = await w.sync.run({ reason: "user" });
  eq(r.moreAvailable, false, "la première synchro tient en un passage");
  for (const cid of ["2", "3", "4", "6"]) {
    const c = await loadCollection(w.records, cid);
    eq([cid, c.full, c.more], [cid, false, false]);
  }
  // A draft saved locally (never on the server), deleted after the message is sent.
  w.store.folders.get("/Drafts").msgs.set(9999, { mid: "brouillon@x", read: true, flagged: false });
  await w.sync.recordIntent(w.store.userDelete("/Drafts", "brouillon@x"));
  const folderSyncs = w.server.sent("FolderSync").length;
  r = await w.sync.run({ reason: "local" });
  eq(r.moreAvailable, false);
  eq(await w.sync.journal.size(), 0, "réglée « done », sans attendre");
  eq(w.server.sent("FolderSync").length, folderSyncs + 1, "un seul passage");
  // Nothing to do: one pass, one Sync per folder.
  const syncs = w.server.sent("Sync").length;
  r = await w.sync.run({ reason: "timer" });
  eq(r.moreAvailable, false);
  eq(w.server.sent("Sync").length, syncs + 5);
});

// ── Final verification: the whole list again, tables matched by place, then by id ──

const holding = (server, cid, mid) => [...server.items.get(cid).values()].find((it) => decodeUtf8(it.mime).includes(`<${mid}>`));

test("vérif. finale (a) : deux dossiers de premier niveau échangent leurs ServerId : chacun garde son contenu", async () => {
  const folders = extra([["8", "0", "Clients"], ["9", "0", "Factures"]]);
  const w = world({ folders });
  for (let i = 0; i < 3; i++) {
    w.server.addMessage("8", mime(`cl${i}@x`));
    w.server.addMessage("9", mime(`fa${i}@x`));
  }
  await w.runAll();
  w.store.folders.get("/Clients").msgs.set(9999, { mid: "note-locale@x", read: false, flagged: false });
  await w.sync.recordIntent(w.store.userFlags("/Factures", "fa0@x", { read: true }));
  const swap = new Map([["8", "9"], ["9", "8"]]);
  const server = resetServer(w, folders, (id) => swap.get(id) ?? id);
  await w.records.set("hierarchy", { syncKey: "0" });
  const imports = w.imports();
  await w.runAll({ reason: "timer" });
  await w.runAll({ reason: "timer" });
  eq(w.store.mids("/Clients"), ["cl0@x", "cl1@x", "cl2@x", "note-locale@x"]);
  eq(w.store.mids("/Factures"), ["fa0@x", "fa1@x", "fa2@x"]);
  eq(w.imports(), imports, "rien de retéléchargé");
  eq(w.store.messages("/Trash").length, 0);
  eq(holding(server, "8", "fa0@x").read, true, "le drapeau atteint Factures sous son nouveau ServerId");
  eq((await loadCollection(w.records, "9")).path, "/Clients");
});

test("vérif. finale (b) : renommé ET déplacé, vu par une liste reprise de zéro : suivi, rien à la corbeille, rien de retenu", async () => {
  const w = world({ folders: extra([["8", "0", "Clients"]]) });
  for (let i = 0; i < 300; i++) w.server.addMessage("8", mime(`cl${i}@x`));
  await w.runAll();
  w.store.folders.get("/Clients").msgs.set(9999, { mid: "note-locale@x", read: false, flagged: false });
  w.server.updateFolder("8", { name: "Clients 2025", parentId: "1" });
  await w.records.set("hierarchy", { syncKey: "999" }); // refused: Status 9, the whole list again
  const imports = w.imports();
  const r = await w.runAll({ reason: "timer" });
  eq(r.status, "ok");
  eq(r.pendingDeletes, 0);
  assert(!w.store.folders.has("/Clients"));
  eq(w.store.messages("/Inbox/Clients 2025").length, 301, "suivi, la note locale aussi");
  eq(w.store.messages("/Trash").length, 0);
  assert(![...w.store.folders.keys()].some((p) => p.startsWith("/Trash/")));
  eq(w.imports(), imports, "rien de retéléchargé");
  // Nothing retained: keeping the local copies changes nothing.
  await w.sync.discardPendingDeletes();
  eq((await w.runAll({ reason: "user" })).status, "ok");
  const c = await loadCollection(w.records, "8");
  eq([c.path, c.items.size], ["/Inbox/Clients 2025", 300]);
  eq(w.imports(), imports);
});

test("vérif. finale : identifiant repris par un autre dossier dont le dossier local est pris ailleurs : l'ancien dossier reste, hors synchronisation", async () => {
  const folders = extra([["8", "0", "Clients"], ["9", "0", "Factures"]]);
  const w = world({ folders });
  for (let i = 0; i < 3; i++) {
    w.server.addMessage("8", mime(`cl${i}@x`));
    w.server.addMessage("9", mime(`fa${i}@x`));
  }
  await w.runAll();
  await w.sync.recordIntent(w.store.userFlags("/Factures", "fa0@x", { read: true }));
  // After the reset, "Clients" has id 9 and "Factures", renamed meanwhile, id 8.
  const swap = new Map([["8", "9"], ["9", "8"]]);
  const server = resetServer(w, folders, (id) => swap.get(id) ?? id);
  server.updateFolder("8", { name: "Factures 2025" });
  await w.records.set("hierarchy", { syncKey: "0" });
  const imports = w.imports();
  const r = await w.runAll({ reason: "timer" });
  await w.runAll({ reason: "timer" });
  eq(r.status, "ok");
  eq(w.store.mids("/Clients"), ["cl0@x", "cl1@x", "cl2@x"], "repris à sa place");
  eq(w.store.mids("/Factures"), ["fa0@x", "fa1@x", "fa2@x"], "gardé tel quel, pas mis à la corbeille");
  eq(w.store.mids("/Factures 2025"), ["fa0@x", "fa1@x", "fa2@x"]);
  eq(w.imports(), imports + 3, "seul le dossier renommé est téléchargé");
  eq(w.store.messages("/Trash").length, 0);
  assert([...server.items.get("9").values()].every((it) => !it.read), "rien n'atteint Clients");
  eq(await w.sync.journal.size(), 0);
});

test("vérif. finale : passage arrêté entre la liste reprise de zéro et les dossiers locaux : le suivant refait la correspondance", async () => {
  const folders = extra([["8", "0", "Clients"]]);
  const w = world({ folders });
  for (let i = 0; i < 3; i++) w.server.addMessage("6", mime(`pr${i}@x`));
  for (let i = 0; i < 3; i++) w.server.addMessage("8", mime(`cl${i}@x`));
  await w.runAll();
  const swap = new Map([["6", "8"], ["8", "6"]]);
  resetServer(w, folders, (id) => swap.get(id) ?? id);
  await w.records.set("hierarchy", { syncKey: "0" });
  const list = w.store.listFolders.bind(w.store);
  let once = true;
  w.store.listFolders = async () => {
    if (once) {
      once = false;
      throw new Error("arrêt");
    }
    return list();
  };
  const imports = w.imports();
  await rejects(() => w.runAll({ reason: "timer" }));
  eq((await w.runAll({ reason: "user" })).status, "ok");
  await w.runAll({ reason: "user" });
  eq(w.store.mids("/Clients"), ["cl0@x", "cl1@x", "cl2@x"]);
  eq(w.store.mids("/Inbox/Projets"), ["pr0@x", "pr1@x", "pr2@x"]);
  eq(w.imports(), imports, "rien de retéléchargé");
  eq((await loadCollection(w.records, "6")).path, "/Clients");
});

test("vérif. finale : dossier d'archives lié dont le ServerId passe à un autre dossier : chaque dossier local garde le sien", async () => {
  const folders = extra([["8", "0", "Archives"], ["9", "0", "Clients"]]);
  const w = world({ store: archiveStore(), folders });
  for (let i = 0; i < 3; i++) {
    w.server.addMessage("8", mime(`ar${i}@x`));
    w.server.addMessage("9", mime(`cl${i}@x`));
  }
  await w.runAll();
  eq(await w.records.get("archives", null), { serverId: "8" });
  const swap = new Map([["8", "9"], ["9", "8"]]);
  resetServer(w, folders, (id) => swap.get(id) ?? id);
  await w.records.set("hierarchy", { syncKey: "0" });
  const imports = w.imports();
  await w.runAll({ reason: "timer" });
  await w.runAll({ reason: "timer" });
  eq(await w.records.get("archives", null), { serverId: "9" });
  eq(w.store.mids("/Archives"), ["ar0@x", "ar1@x", "ar2@x"]);
  eq(w.store.mids("/Clients"), ["cl0@x", "cl1@x", "cl2@x"]);
  eq(w.imports(), imports, "rien de retéléchargé");
});
