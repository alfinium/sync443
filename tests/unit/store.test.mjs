// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

import { test, eq, assert, rejects, throws } from "./harness.mjs";
import { Store, StoreError, SCHEMA, checkMailbox, toMap, fromMap, newIds, recordName, SYNC_KINDS } from "../../src/sync/store.mjs";

/** storage.local double: values go through a JSON round trip, like a real store would serialise them. */
function memoryArea() {
  const data = new Map();
  return {
    data,
    async get(key) {
      if (key === null) return Object.fromEntries([...data].map(([k, v]) => [k, JSON.parse(v)]));
      return data.has(key) ? { [key]: JSON.parse(data.get(key)) } : {};
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, JSON.stringify(v));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) data.delete(k);
    },
  };
}

const mailbox = (over = {}) => ({
  id: "a1b2c3d4e5f6",
  email: "user@example.com",
  username: "",
  name: "Travail",
  origin: "https://mail.example.com",
  deviceId: "S443ABCDEF0123456789ABCDEF012345".slice(0, 32),
  syncMinutes: 0,
  filterType: "5",
  accountKey: null,
  tlsPins: [],
  sync: { mail: true, calendar: true, contacts: true, tasks: true },
  ...over,
});

test("stockage : version du schéma posée au premier démarrage", async () => {
  const area = memoryArea();
  await new Store(area).init();
  eq(JSON.parse(area.data.get("schema")), SCHEMA);
});

test("stockage : refuse des données d'une version plus récente", async () => {
  const area = memoryArea();
  await area.set({ schema: SCHEMA + 1 });
  await rejects(() => new Store(area).init(), StoreError);
});

test("boîtes : ajout, remplacement, ordre conservé", async () => {
  const store = new Store(memoryArea());
  await store.putMailbox(mailbox());
  await store.putMailbox(mailbox({ id: "0000000000aa", email: "b@example.com" }));
  await store.putMailbox(mailbox({ name: "Renommée" }));
  const list = await store.listMailboxes();
  eq(list.map((m) => m.id), ["a1b2c3d4e5f6", "0000000000aa"]);
  eq(list[0].name, "Renommée");
});

test("boîtes : champs invalides refusés à l'écriture", () => {
  throws(() => checkMailbox(mailbox({ id: "../etc" })), StoreError, "id");
  throws(() => checkMailbox(mailbox({ origin: "https://a.example/chemin" })), StoreError, "origine avec chemin");
  throws(() => checkMailbox(mailbox({ deviceId: "x-y" })), StoreError, "deviceId");
  throws(() => checkMailbox(mailbox({ syncMinutes: 1.5 })), StoreError, "intervalle");
  throws(() => checkMailbox(mailbox({ filterType: "9" })), StoreError, "période");
  throws(() => checkMailbox(mailbox({ filterType: "6" })), StoreError, "période de calendrier, pas de courrier");
  throws(() => checkMailbox(mailbox({ accountKey: "Local Folders" })), StoreError, "compte");
  throws(() => checkMailbox(mailbox({ tlsPins: ["abc"] })), StoreError, "empreinte");
});

test("boîtes : champs inconnus non conservés (pas d'injection de propriétés)", () => {
  const clean = checkMailbox({ ...mailbox(), __proto__: { evil: 1 }, extra: "x" });
  eq(Object.keys(clean).sort(), ["accountKey", "deviceId", "email", "filterType", "id", "name", "origin", "sync", "syncMinutes", "tlsPins", "username"]);
});

test("boîtes : une entrée endommagée est ignorée à la lecture", async () => {
  const area = memoryArea();
  await area.set({ mailboxes: [mailbox(), { id: "zz", email: 3 }] });
  eq((await new Store(area).listMailboxes()).length, 1);
});

test("enregistrements : Map stockée en entrées, relue en Map", async () => {
  const store = new Store(memoryArea());
  const st = store.mailbox("a1b2c3d4e5f6");
  const m = new Map([["__proto__", { a: 1 }], ["constructor", 2], ["normal", 3]]);
  await st.setMap("items", m);
  const back = await st.getMap("items");
  assert(back instanceof Map, "une Map");
  eq(back.get("__proto__"), { a: 1 });
  eq(back.get("constructor"), 2);
  eq(back.size, 3);
  eq(({}).a, undefined, "aucun prototype modifié");
});

test("enregistrements : données endommagées → Map vide", () => {
  eq(toMap("x").size, 0);
  eq(toMap([["a", 1], ["b"]]).size, 0);
  eq(toMap([[1, 2]]).size, 0);
  eq(toMap([["a", 1]]).get("a"), 1);
  throws(() => fromMap({ a: 1 }), StoreError);
  throws(() => fromMap(new Map([[1, 2]])), StoreError);
});

test("enregistrements : noms contrôlés, identifiants serveur encodés", async () => {
  const st = new Store(memoryArea()).mailbox("a1b2c3d4e5f6");
  await rejects(() => st.set("../schema", 1), StoreError);
  await rejects(() => st.set("Health", 1), StoreError);
  eq(recordName("coll", "mail/INBOX é"), "coll:mail%2FINBOX%20%C3%A9");
  throws(() => recordName("coll", ""), StoreError);
  throws(() => recordName("coll", "x".repeat(65)), StoreError);
  throws(() => recordName("Coll", "a"), StoreError);
  await st.set(recordName("coll", "mail/INBOX"), { syncKey: "1" });
  eq(await st.get(recordName("coll", "mail/INBOX")), { syncKey: "1" });
});

test("suppression d'une boîte : tous ses enregistrements, et rien d'autre", async () => {
  const area = memoryArea();
  const store = new Store(area);
  await store.putMailbox(mailbox());
  await store.putMailbox(mailbox({ id: "0000000000aa", email: "b@example.com" }));
  const a = store.mailbox("a1b2c3d4e5f6");
  const b = store.mailbox("0000000000aa");
  await a.set("health", { ok: 1 });
  await a.setMap(recordName("coll", "1"), new Map());
  await b.set("health", { ok: 2 });
  await store.deleteMailbox("a1b2c3d4e5f6");
  eq([...area.data.keys()].filter((k) => k.startsWith("mb/a1b2c3d4e5f6/")), []);
  eq(await b.get("health"), { ok: 2 });
  eq((await store.listMailboxes()).map((m) => m.id), ["0000000000aa"]);
});

test("écritures concurrentes : l'index des enregistrements ne perd rien", async () => {
  const store = new Store(memoryArea());
  const st = store.mailbox("a1b2c3d4e5f6");
  await Promise.all(Array.from({ length: 40 }, (_, i) => st.set(`r${i}`, i)));
  eq((await st.names()).length, 40);
});

test("ajouts concurrents de boîtes : aucune perdue", async () => {
  const store = new Store(memoryArea());
  const ids = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(12, "0"));
  await Promise.all(ids.map((id) => store.putMailbox(mailbox({ id, email: `u${id}@example.com` }))));
  eq((await store.listMailboxes()).length, 20);
});

test("identifiants : formats attendus", () => {
  let n = 0;
  const random = (len) => Uint8Array.from({ length: len }, () => n++ & 0xff);
  const { mailboxId, deviceId } = newIds(random);
  assert(/^[a-f0-9]{12}$/.test(mailboxId), mailboxId);
  assert(/^S443[0-9A-F]{28}$/.test(deviceId), deviceId);
});

test("éléments à synchroniser : un, plusieurs ou les quatre, jamais aucun", () => {
  throws(() => checkMailbox(mailbox({ sync: undefined })), StoreError, "le choix est obligatoire");
  // Every non-empty combination of the four is accepted, exactly as chosen.
  for (let mask = 1; mask < 16; mask++) {
    const sync = Object.fromEntries(SYNC_KINDS.map((k, i) => [k, Boolean(mask & (1 << i))]));
    eq(checkMailbox(mailbox({ sync })).sync, sync, JSON.stringify(sync));
  }
  throws(() => checkMailbox(mailbox({ sync: { mail: false, calendar: false, contacts: false, tasks: false } })), StoreError, "aucun");
  throws(() => checkMailbox(mailbox({ sync: { mail: true, calendar: "oui", contacts: true, tasks: true } })), StoreError, "valeur non booléenne");
  throws(() => checkMailbox(mailbox({ sync: { mail: true } })), StoreError, "choix incomplet");
  throws(() => checkMailbox(mailbox({ sync: "tout" })), StoreError, "pas un objet");
  eq(Object.keys(checkMailbox(mailbox({ sync: { mail: true, calendar: false, contacts: false, tasks: false, notes: true } })).sync), SYNC_KINDS.slice(), "clés inconnues écartées");
});
