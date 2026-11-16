// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

import { test, assert, eq, rejects } from "./harness.mjs";
import { Journal, replayJournal, checkIntent, MAX_ATTEMPTS, MAX_PER_REQUEST } from "../../src/sync/journal.mjs";
import { Store } from "../../src/sync/store.mjs";

/** storage.local double, values copied as the real one does. */
export function memoryArea() {
  const data = new Map();
  const copy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  return {
    data,
    writes: 0,
    failNext: 0,
    async get(key) {
      if (key === null) return Object.fromEntries([...data].map(([k, val]) => [k, copy(val)]));
      return data.has(key) ? { [key]: copy(data.get(key)) } : {};
    },
    async set(obj) {
      if (this.failNext > 0) {
        this.failNext--;
        throw new Error("stockage indisponible");
      }
      this.writes++;
      for (const [k, val] of Object.entries(obj)) data.set(k, copy(val));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

const MB = "0123456789ab";
const records = (area = memoryArea()) => new Store(area).mailbox(MB);

test("journal : intentions validées (chemins, Message-ID, drapeaux)", () => {
  eq(checkIntent({ kind: "flags", path: "/Inbox", messageId: "a@b", flags: { read: true, junk: true } }), {
    op: "flags",
    path: "/Inbox",
    messageId: "a@b",
    flags: { read: true },
  });
  for (const bad of [
    null,
    { kind: "flags", path: "/Inbox", messageId: "a@b", flags: {} },
    { kind: "flags", path: "Inbox", messageId: "a@b", flags: { read: true } },
    { kind: "delete", path: "/Inbox", messageId: "a b" },
    { kind: "delete", path: "/Inbox", messageId: "a\u0000b" },
    { kind: "move", path: "/Inbox", messageId: "a@b", toPath: "/Inbox" },
    { kind: "folderRename", path: "/A" },
    { kind: "delete", path: "/", messageId: "x" },
    { kind: "autre", path: "/A" },
  ]) {
    eq(checkIntent(bad), null, JSON.stringify(bad));
  }
});

test("journal : les entrées survivent à un redémarrage (rien d'un identifiant Thunderbird)", async () => {
  const area = memoryArea();
  const j1 = new Journal({ records: records(area), now: () => 5 });
  const e = await j1.append({ kind: "delete", path: "/Inbox", messageId: "m1@x", id: 42 });
  eq(e.id, 1);
  await j1.append({ kind: "move", path: "/Inbox", toPath: "/Archives", messageId: "m2@x" });
  await j1.flush(); // append() returns once in memory; the storage follows a moment later
  const j2 = new Journal({ records: records(area) });
  const list = await j2.list();
  eq(list.map((x) => [x.id, x.op, x.messageId]), [[1, "delete", "m1@x"], [2, "move", "m2@x"]]);
  assert(!("tbId" in list[0]) && list[0].id === 1);
  const e3 = await j2.append({ kind: "folderCreate", path: "/Nouveau" });
  eq(e3.id, 3, "les numéros continuent");
});

test("journal : rebind réécrit les ServerId d'un coup (échangés), ou les retire (l'entrée garde son dossier local)", async () => {
  const area = memoryArea();
  const j = new Journal({ records: records(area) });
  await j.append({ kind: "flags", path: "/A", messageId: "a@x", flags: { read: true }, src: "8" });
  await j.append({ kind: "move", path: "/B", toPath: "/A", messageId: "b@x", src: "9", dst: "8" });
  await j.append({ kind: "delete", path: "/C", messageId: "c@x", src: "7" });
  eq(await j.rebind(new Map([["8", "9"], ["9", null]])), 2);
  await j.flush();
  const list = await new Journal({ records: records(area) }).list();
  eq(list.map((e) => [e.path, e.src ?? null, e.dst ?? null]), [["/A", "9", null], ["/B", null, "9"], ["/C", "7", null]]);
});

test("journal : une entrée ne part qu'après une réponse positive pour elle", async () => {
  const j = new Journal({ records: records() });
  for (const m of ["a", "b", "c"]) await j.append({ kind: "flags", path: "/Inbox", messageId: `${m}@x`, flags: { read: true } });
  const r = await j.settle(new Map([[1, "done"], [2, "keep"]]));
  eq(r, { done: 1, dropped: 0, kept: 1 });
  const list = await j.list();
  eq(list.map((e) => [e.id, e.attempts]), [[2, 1], [3, 0]]);
});

test("journal : un refus définitif est journalisé et retiré ; un refus passager l'est au bout de MAX_ATTEMPTS", async () => {
  const logs = [];
  const log = { warn: (m) => logs.push(m), info() {}, debug() {}, error() {} };
  const j = new Journal({ records: records(), log });
  await j.append({ kind: "delete", path: "/Inbox", messageId: "a@x" });
  await j.append({ kind: "delete", path: "/Inbox", messageId: "b@x" });
  await j.settle(new Map([[1, "drop"]]));
  assert(logs.some((m) => m.includes("n° 1")), "refus journalisé");
  for (let k = 0; k < MAX_ATTEMPTS; k++) await j.settle(new Map([[2, "keep"]]));
  eq(await j.size(), 0);
  assert(logs.some((m) => m.includes("n° 2") && m.includes("essais")));
});

test("journal : écritures regroupées, aucune entrée perdue en rafale", async () => {
  const area = memoryArea();
  const j = new Journal({ records: records(area) });
  const all = [];
  for (let n = 0; n < 200; n++) all.push(j.append({ kind: "flags", path: "/Inbox", messageId: `m${n}@x`, flags: { read: n % 2 === 0 } }));
  await Promise.all(all);
  await j.flush();
  const again = new Journal({ records: records(area) });
  eq(await again.size(), 200);
  assert(area.writes < 20, `écritures regroupées (${area.writes})`);
});

test("journal : plein, une intention de plus est refusée et signalée", async () => {
  const errors = [];
  const j = new Journal({ records: records(), max: 2, log: { error: (m) => errors.push(m) } });
  assert(await j.append({ kind: "delete", path: "/A", messageId: "1@x" }));
  assert(await j.append({ kind: "delete", path: "/A", messageId: "2@x" }));
  eq(await j.append({ kind: "delete", path: "/A", messageId: "3@x" }), null);
  eq(errors.length, 1);
});

test("journal : enregistrement abîmé, entrées illisibles écartées", async () => {
  const area = memoryArea();
  await area.set({ [`mb/${MB}/journal`]: { v: 2, seq: 9 } });
  await area.set({ [`mb/${MB}/journal:1`]: { entries: [{ id: 4, op: "delete", path: "/A", messageId: "x@y" }, { id: "5", op: "delete" }, 7, { id: 4, op: "delete", path: "/B", messageId: "doublon@y" }] } });
  await area.set({ [`mb/${MB}/#names`]: ["journal", "journal:1"] });
  const j = new Journal({ records: records(area), log: { warn() {} } });
  eq((await j.list()).map((e) => e.id), [4]);
  eq((await j.append({ kind: "folderDelete", path: "/A" })).id, 10);
});

test("journal : identifiants de collection gardés avec les opérations sur les messages, invalides écartés", () => {
  eq(checkIntent({ kind: "move", path: "/A", toPath: "/B", messageId: "m@x", src: "1", dst: "6" }), { op: "move", path: "/A", messageId: "m@x", src: "1", toPath: "/B", dst: "6" });
  eq(checkIntent({ kind: "delete", path: "/A", messageId: "m@x", src: "a\u0000b" }), { op: "delete", path: "/A", messageId: "m@x" });
  eq(checkIntent({ kind: "folderCreate", path: "/A", src: "1" }), { op: "folderCreate", path: "/A" });
});

test("journal : chemins des opérations de dossier en attente", async () => {
  const j = new Journal({ records: records() });
  await j.append({ kind: "folderRename", path: "/A", toPath: "/B" });
  await j.append({ kind: "delete", path: "/C", messageId: "x@y" });
  eq([...(await j.pendingFolderPaths())].sort(), ["/A", "/B"]);
});

// ── Replay ────────────────────────────────────────────────────────────────

function recorder(answer = () => "done") {
  const calls = [];
  const settleAll = (entries) => new Map(entries.map((e) => [e.id, answer(e)]));
  return {
    calls,
    handlers: {
      uploads: async (path, entries) => {
        calls.push(["uploads", path, entries.map((e) => e.id)]);
        return settleAll(entries);
      },
      moves: async (entries) => {
        calls.push(["moves", entries.map((e) => e.id)]);
        return settleAll(entries);
      },
      folder: async (entry) => {
        calls.push(["folder", entry.id]);
        return settleAll([entry]);
      },
    },
  };
}

test("rejeu : dans l'ordre, groupes par nature, envois par dossier", async () => {
  const j = new Journal({ records: records() });
  await j.append({ kind: "flags", path: "/A", messageId: "1@x", flags: { read: true } }); // 1
  await j.append({ kind: "delete", path: "/B", messageId: "2@x" }); // 2
  await j.append({ kind: "flags", path: "/A", messageId: "3@x", flags: { flagged: true } }); // 3
  await j.append({ kind: "move", path: "/A", toPath: "/B", messageId: "1@x" }); // 4
  await j.append({ kind: "folderRename", path: "/B", toPath: "/C" }); // 5
  await j.append({ kind: "flags", path: "/C", messageId: "1@x", flags: { read: false } }); // 6
  const r = recorder();
  const total = await replayJournal({ journal: j, handlers: r.handlers });
  eq(r.calls, [
    ["uploads", "/A", [1, 3]],
    ["uploads", "/B", [2]],
    ["moves", [4]],
    ["folder", 5],
    ["uploads", "/C", [6]],
  ]);
  eq(total, { sent: 6, dropped: 0, kept: 0 });
  eq(await j.size(), 0);
});

test("rejeu : jamais deux déplacements du même message dans une requête", async () => {
  const j = new Journal({ records: records() });
  await j.append({ kind: "move", path: "/A", toPath: "/B", messageId: "1@x" });
  await j.append({ kind: "move", path: "/A", toPath: "/B", messageId: "2@x" });
  await j.append({ kind: "move", path: "/B", toPath: "/C", messageId: "1@x" });
  const r = recorder();
  await replayJournal({ journal: j, handlers: r.handlers });
  eq(r.calls, [["moves", [1, 2]], ["moves", [3]]]);
});

test("rejeu : requêtes plafonnées", async () => {
  const j = new Journal({ records: records() });
  for (let n = 0; n < MAX_PER_REQUEST + 5; n++) await j.append({ kind: "move", path: "/A", toPath: "/B", messageId: `${n}@x` });
  const r = recorder();
  await replayJournal({ journal: j, handlers: r.handlers });
  eq(r.calls.map((c) => c[1].length), [MAX_PER_REQUEST, 5]);
});

test("rejeu : une panne garde tout ce qui n'a pas été acquitté, acquittement par élément", async () => {
  const j = new Journal({ records: records() });
  await j.append({ kind: "delete", path: "/A", messageId: "1@x" });
  await j.append({ kind: "move", path: "/A", toPath: "/B", messageId: "2@x" });
  await j.append({ kind: "delete", path: "/A", messageId: "3@x" });
  const handlers = {
    uploads: async (path, entries) => new Map(entries.map((e) => [e.id, "done"])),
    moves: async () => {
      throw Object.assign(new Error("réseau"), { code: "NETWORK" });
    },
    folder: async () => new Map(),
  };
  await rejects(replayJournal({ journal: j, handlers }), (e) => e.code === "NETWORK");
  eq((await j.list()).map((e) => e.id), [2, 3], "l'entrée acquittée est partie, les autres restent");
  // Next pass: the server answers.
  const r = recorder((e) => (e.id === 2 ? "keep" : "done"));
  await replayJournal({ journal: j, handlers: r.handlers });
  eq((await j.list()).map((e) => [e.id, e.attempts]), [[2, 1]]);
});

test("rejeu : annulation entre deux groupes", async () => {
  const j = new Journal({ records: records() });
  await j.append({ kind: "folderCreate", path: "/A" });
  await j.append({ kind: "folderCreate", path: "/B" });
  const ctrl = new AbortController();
  const handlers = {
    uploads: async () => new Map(),
    moves: async () => new Map(),
    folder: async (e) => {
      ctrl.abort();
      return new Map([[e.id, "done"]]);
    },
  };
  await rejects(replayJournal({ journal: j, handlers, signal: ctrl.signal }), (e) => e.code === "CANCELLED");
  eq((await j.list()).map((e) => e.id), [2]);
});

test("rejeu : les entrées ajoutées pendant le rejeu attendent le suivant", async () => {
  const j = new Journal({ records: records() });
  await j.append({ kind: "folderCreate", path: "/A" });
  const handlers = {
    uploads: async () => new Map(),
    moves: async () => new Map(),
    folder: async (e) => {
      await j.append({ kind: "folderCreate", path: "/B" });
      return new Map([[e.id, "done"]]);
    },
  };
  const r = await replayJournal({ journal: j, handlers });
  eq(r.sent, 1);
  eq((await j.list()).map((e) => e.path), ["/B"]);
});
