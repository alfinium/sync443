// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Regression tests for the security audit of transport and storage
 * (step 1), for the findings fixed in this step.
 */

import { test, eq, assert, throws, rejects } from "./harness.mjs";
import { Store, StoreError, checkMailbox } from "../../src/sync/store.mjs";
import { EasClient, EasError, ERR } from "../../src/transport/client.mjs";

function memoryArea() {
  const data = new Map();
  const tick = () => new Promise((r) => setTimeout(r, 0)); // real storage is asynchronous
  return {
    data,
    async get(key) {
      await tick();
      if (key === null) return Object.fromEntries([...data].map(([k, v]) => [k, JSON.parse(v)]));
      return data.has(key) ? { [key]: JSON.parse(data.get(key)) } : {};
    },
    async set(obj) {
      await tick();
      for (const [k, v] of Object.entries(obj)) data.set(k, JSON.stringify(v));
    },
    async remove(keys) {
      await tick();
      for (const k of [].concat(keys)) data.delete(k);
    },
  };
}

const mailbox = (over = {}) => ({
  id: "0123456789ab",
  email: "u@example.com",
  username: "",
  name: "Boîte",
  origin: "https://mail.example.com",
  deviceId: "S443ABCDEF",
  syncMinutes: 0,
  filterType: "5",
  accountKey: null,
  tlsPins: [],
  ...over,
});

test("audit transport V5 : une boîte supprimée pendant des écritures ne laisse rien derrière elle", async () => {
  const area = memoryArea();
  const store = new Store(area);
  await store.putMailbox(mailbox());
  const st = store.mailbox("0123456789ab");
  await st.set("health", { a: 1 });
  const writes = Array.from({ length: 20 }, (_, i) => st.set(`r${i}`, i).catch((e) => e));
  const removal = st.remove("health");
  await store.deleteMailbox("0123456789ab");
  const results = await Promise.all([...writes, removal.catch((e) => e)]);
  eq([...area.data.keys()].filter((k) => k.startsWith("mb/0123456789ab/")), [], "aucun enregistrement restant");
  assert(results.some((r) => r instanceof StoreError), "les écritures arrivées après la suppression sont refusées");
  await rejects(() => st.set("late", 1), StoreError, "écriture après suppression");
});

test("audit transport V5 : nettoyage au démarrage des restes de boîtes disparues", async () => {
  const area = memoryArea();
  const store = new Store(area);
  await store.putMailbox(mailbox());
  await area.set({ "mb/ffffffffffff/messages": [1], "mb/ffffffffffff/#names": ["messages"], "mb/0123456789ab/health": {} });
  eq(await store.sweepOrphans(), 2);
  assert(area.data.has("mb/0123456789ab/health"), "les données d'une boîte existante restent");
});

test("audit transport H2 : identifiants et origines contrôlés strictement", () => {
  throws(() => checkMailbox(mailbox({ id: ["0123456789ab"] })), StoreError, "tableau à la place d'un identifiant");
  throws(() => checkMailbox(mailbox({ deviceId: ["S443ABCDEF"] })), StoreError, "tableau à la place d'un identifiant d'appareil");
  throws(() => checkMailbox(mailbox({ origin: "https://evil.example\\mail.example.com" })), StoreError, "barre oblique inverse");
  throws(() => checkMailbox(mailbox({ origin: "http://127.0.0.1:8080" })), StoreError, "http jamais accepté");
  checkMailbox(mailbox({ origin: "https://[2001:db8::1]:8443" }));
});

test("audit transport H2 : le client n'accepte que l'adresse construite par l'analyse du serveur", () => {
  const connector = { open() {}, write() {}, read() {}, close() {} };
  const make = (server) => new EasClient({ server, username: "u", password: "p", deviceId: "S443TEST", connector });
  const isConfig = (e) => e instanceof EasError && e.code === ERR.CONFIG;
  const good = { host: "mail.example.com", port: null, origin: "https://mail.example.com", url: "https://mail.example.com/Microsoft-Server-ActiveSync" };
  throws(() => make({ ...good, url: "https://evil.example\\mail.example.com/Microsoft-Server-ActiveSync" }), isConfig, "barre oblique inverse");
  throws(() => make({ ...good, origin: "https://other.example.com" }), isConfig, "adresse et origine différentes");
  throws(() => make({ ...good, origin: "http://mail.example.com", url: "http://mail.example.com/Microsoft-Server-ActiveSync" }), isConfig, "http");
  throws(() => make({ ...good, host: "" }), isConfig, "hôte vide");
  throws(() => make({ ...good, port: 70000 }), isConfig, "port hors limites");
  make(good);
});

test("audit transport V1 : sans connexion vérifiée, aucun client", () => {
  const good = { host: "mail.example.com", port: null, origin: "https://mail.example.com", url: "https://mail.example.com/Microsoft-Server-ActiveSync" };
  throws(() => new EasClient({ server: good, username: "u", password: "p", deviceId: "S443TEST" }), (e) => e.code === ERR.CONFIG);
  throws(() => new EasClient({ server: good, username: "u", password: "p", deviceId: "S443TEST", connector: { open() {} } }), (e) => e.code === ERR.CONFIG);
});
