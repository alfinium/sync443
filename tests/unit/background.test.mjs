// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * The background page (src/background.mjs) against a fake Thunderbird: the
 * WebExtension APIs, the two experiments (sync443Account, sync443Net through
 * the fake connector of client.test.mjs) and an in-memory storage area.
 *
 * The page is loaded once, in "scenario" mode (as the end-to-end runner does),
 * so it hands its internals to background-hook.mjs instead of starting timers.
 * The tests below share that one page and run in order.
 */

import { test, assert, eq, rejects, prng } from "./harness.mjs";
import { memoryArea } from "./journal.test.mjs";
import { fakeConnector, fakeClock, server, http, wbxmlHttp, PIN } from "./client.test.mjs";
import { el } from "../../src/core/wbxml.mjs";

const HOST = "mail.example.com";
const OTHER = "mail2.example.com";
const EMAIL = "jean@example.com";
const perm = (host) => `https://${host}/*`;

// Code points the account experiment refuses in names (implementation.js, INVISIBLE).
const REFUSED = [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]];
const refusedIn = (s) =>
  [...String(s)].some((c) => {
    const n = c.codePointAt(0);
    return REFUSED.some(([a, b]) => n >= a && n <= b);
  });

function fakeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (f) => void listeners.push(f),
    removeListener: (f) => {
      const i = listeners.indexOf(f);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (f) => listeners.includes(f),
  };
}

/** A namespace whose on* events exist on demand; every other member must be given. */
const ns = (members = {}) =>
  new Proxy(members, { get: (t, k) => (k in t || typeof k !== "string" || !/^on[A-Z]/.test(k) ? t[k] : (t[k] = fakeEvent())) });

function world() {
  const w = {
    calls: [],
    accounts: new Map(), // accountKey → { accountKey, identityId, mailboxId, name, fullName }
    passwords: new Map(), // "origin|login" → password
    granted: new Set(),
    alarms: new Map(),
    failEnsure: null,
    failSetPassword: null,
    displayName: "Jean Dupont",
    nextAccount: 1,
    area: memoryArea(),
  };
  const call = (name, ...args) => w.calls.push([name, ...args]);
  const settings = () =>
    wbxmlHttp(
      el("Settings:Settings", [
        el("Status", "1"),
        el("UserInformation", [el("Status", "1"), el("Get", [el("Accounts", [el("Account", [el("UserDisplayName", w.displayName), el("EmailAddresses", [el("PrimarySmtpAddress", EMAIL)])])])])]),
      ]),
    );
  w.connector = fakeConnector({
    clock: fakeClock(),
    split: "one",
    handler: server({ Settings: settings, FolderSync: () => http(503, { reason: "Service Unavailable" }) }),
  });
  w.browser = {
    runtime: ns({
      id: "sync443@test",
      getURL: (p) => (p === "test-scenario.mjs" ? "../tests/unit/background-hook.mjs" : `moz-extension://sync443/${p}`),
      openOptionsPage: () => {},
      lastError: undefined,
    }),
    storage: ns({ local: w.area }),
    notifications: ns({ create: async () => "n" }),
    alarms: ns({
      getAll: async () => [...w.alarms.values()],
      create: (name, o) => void w.alarms.set(name, { name, ...o }),
      clear: async (name) => w.alarms.delete(name),
    }),
    permissions: ns({
      contains: async ({ origins }) => origins.every((o) => w.granted.has(o)),
      getAll: async () => ({ origins: [...w.granted] }),
      remove: async ({ origins }) => {
        for (const o of origins) w.granted.delete(o);
        return true;
      },
    }),
    accounts: ns(),
    messages: ns(),
    folders: ns(),
    compose: ns(),
    tabs: ns(),
    menus: ns({ create: (_props, done) => done?.(), update: async () => {}, refresh: () => {} }),
    browserAction: ns({ setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} }),
    sync443Net: w.connector,
    sync443Account: {
      async getPassword(origin, login) {
        call("getPassword", origin, login);
        return w.passwords.get(`${origin}|${login}`) ?? null;
      },
      async setPassword(origin, login, password) {
        call("setPassword", origin, login);
        if (w.failSetPassword) throw new Error(w.failSetPassword);
        w.passwords.set(`${origin}|${login}`, password);
      },
      async removePassword(origin, login) {
        call("removePassword", origin, login);
        w.passwords.delete(`${origin}|${login}`);
      },
      async ensureAccount(o) {
        call("ensureAccount", { ...o });
        if (w.failEnsure) throw new Error(w.failEnsure);
        if (refusedIn(o.name) || refusedIn(o.fullName ?? "")) throw new Error("CONFIG: nom invalide");
        let a = [...w.accounts.values()].find((x) => x.mailboxId === o.mailboxId);
        if (!a) {
          const n = w.nextAccount++;
          a = { accountKey: `account${n}`, identityId: `id${n}`, mailboxId: o.mailboxId };
          w.accounts.set(a.accountKey, a);
        }
        Object.assign(a, { name: o.name, fullName: o.fullName ?? null });
        return { accountKey: a.accountKey, identityId: a.identityId };
      },
      async removeAccount(accountKey) {
        call("removeAccount", accountKey);
        w.accounts.delete(accountKey);
      },
      async listAccounts() {
        return [...w.accounts.values()].map((a) => ({ accountKey: a.accountKey, mailboxId: a.mailboxId }));
      },
      async accountOfIdentity() {
        return null;
      },
      async checkSendRoute(identityId) {
        call("checkSendRoute", identityId ?? null);
        return false;
      },
    },
  };
  return w;
}

const input = (o = {}) => ({
  email: EMAIL,
  username: "",
  name: "",
  server: `https://${HOST}`,
  syncMinutes: 15,
  filterType: "1",
  sync: { mail: true, calendar: false, contacts: false, tasks: false },
  ...o,
});
const names = (calls) => calls.map((c) => c[0]);
const ticks = async (n = 200) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
const pause = () => new Promise((r) => setTimeout(r, 0));

let page = null;
let saved = null;

async function load() {
  if (page) return page;
  const w = world();
  saved = { browser: globalThis.browser, fetch: globalThis.fetch };
  globalThis.browser = w.browser;
  globalThis.fetch = async (url) => ({ ok: url === "moz-extension://sync443/test-config.json", json: async () => ({ scenario: true }) });
  saved.crypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    // jsc has no Web Crypto: identifiers only need to differ here.
    const rnd = prng(443);
    Object.defineProperty(globalThis, "crypto", { configurable: true, writable: true, value: { getRandomValues: (a) => a.map(() => Math.floor(rnd() * 256)) } });
  }
  await import("../../src/background.mjs");
  const x = await (await import("./background-hook.mjs")).internals;
  globalThis.fetch = saved.fetch;
  page = { w, x };
  return page;
}

/** Wait for the passes a save starts, so the next test begins from a quiet page. */
async function settle(x) {
  for (const entry of x.entries.values()) await entry.inFlight?.catch(() => {});
  await ticks();
}

test("arrière-plan : boîte ajoutée, compte Thunderbird préparé avant le mot de passe, nom du serveur nettoyé (F7)", async () => {
  const { w, x } = await load();
  w.granted.add(perm(HOST));
  w.displayName = `Jean${String.fromCodePoint(0x2061)} Dupont${String.fromCodePoint(0xfff9)}`;
  const r = await x.saveMailbox(input(), "secret");
  await settle(x);
  const order = names(w.calls);
  assert(order.indexOf("ensureAccount") >= 0 && order.indexOf("ensureAccount") < order.indexOf("setPassword"), `ordre : ${order.join(", ")}`);
  eq(w.calls.find((c) => c[0] === "ensureAccount")[1].fullName, "Jean Dupont", "nom affiché nettoyé comme l'exige l'expérience");
  const mb = await x.store.getMailbox(r.id);
  eq([mb.origin, mb.accountKey, mb.tlsPins], [`https://${HOST}`, "account1", []]);
  eq(w.passwords.get(`https://${HOST}|${EMAIL}`), "secret");
});

test("arrière-plan : compte refusé, ni mot de passe ni boîte enregistrés, autorisation rendue (F7, H6)", async () => {
  const { w, x } = await load();
  w.failEnsure = "CONFLICT: compte occupé";
  w.granted.add(perm(OTHER));
  const from = w.calls.length;
  try {
    await rejects(x.saveMailbox(input({ email: "marie@example.com", server: `https://${OTHER}` }), "pw2"), (e) => /CONFLICT/.test(e.message));
  } finally {
    w.failEnsure = null;
  }
  assert(!names(w.calls.slice(from)).includes("setPassword"), "aucun mot de passe enregistré");
  eq((await x.store.listMailboxes()).length, 1, "aucune boîte ajoutée");
  eq([w.granted.has(perm(OTHER)), w.granted.has(perm(HOST))], [false, true], "autorisation inutile rendue, celle de la boîte existante gardée");
});

test("arrière-plan : mot de passe non enregistré, le compte créé est retiré (F7)", async () => {
  const { w, x } = await load();
  w.failSetPassword = "LOCKED: mot de passe principal";
  w.granted.add(perm(OTHER));
  const from = w.calls.length;
  try {
    await rejects(x.saveMailbox(input({ email: "marie@example.com", server: `https://${OTHER}` }), "pw2"), (e) => e.field === "password");
  } finally {
    w.failSetPassword = null;
  }
  const created = w.calls.slice(from).find((c) => c[0] === "ensureAccount");
  assert(created, "compte demandé");
  assert(names(w.calls.slice(from)).includes("removeAccount"), "compte créé retiré");
  eq([w.accounts.size, (await x.store.listMailboxes()).length, w.granted.has(perm(OTHER))], [1, 1, false]);
});

test("arrière-plan : changement de serveur, empreintes oubliées, ancien mot de passe et ancienne autorisation retirés (H1)", async () => {
  const { w, x } = await load();
  const [mb] = await x.store.listMailboxes();
  await x.store.putMailbox({ ...mb, tlsPins: [PIN.leaf.toUpperCase()] });
  w.granted.add(perm(OTHER));
  await x.saveMailbox(input({ id: mb.id, server: `https://${OTHER}` }), "pw3");
  await settle(x);
  const now = await x.store.getMailbox(mb.id);
  eq([now.origin, now.tlsPins, now.accountKey], [`https://${OTHER}`, [], mb.accountKey]);
  eq([w.passwords.has(`https://${HOST}|${EMAIL}`), w.passwords.get(`https://${OTHER}|${EMAIL}`)], [false, "pw3"]);
  eq([w.granted.has(perm(HOST)), w.granted.has(perm(OTHER))], [false, true]);
  await rejects(x.saveMailbox(input({ id: mb.id, server: `https://${HOST}` }), null), (e) => e.field === "password", "nouveau serveur sans mot de passe : refusé");
});

test("arrière-plan : moteur remplacé seulement une fois l'ancien arrêté, actions locales transmises dans l'ordre (#13)", async () => {
  const { x } = await load();
  const [mb] = await x.store.listMailboxes();
  const old = x.entries.get(mb.id);
  const engine = Object.getPrototypeOf(old.sync);
  const recorded = [];
  const record = engine.recordIntent;
  engine.recordIntent = function (intent) {
    recorded.push([this, intent.messageId]);
    return record.call(this, intent);
  };
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const close = old.sync.close.bind(old.sync);
  old.sync.close = async () => {
    order.push("début");
    await gate;
    await close();
    order.push("fin");
  };
  try {
    const saving = x.saveMailbox(input({ id: mb.id, server: `https://${OTHER}`, syncMinutes: 30 }), null);
    for (let i = 0; i < 500 && !order.length; i++) await pause();
    eq(order, ["début"], "l'ancien moteur s'arrête");
    const intent = (mid) => ({ kind: "flags", path: "/Inbox", messageId: mid, flags: { read: true } });
    await x.onLocalIntent(mb.accountKey, intent("a@x"));
    await x.onLocalIntent(mb.accountKey, intent("b@x"));
    eq(recorded.length, 0, "rien n'est confié à un moteur qui s'arrête");
    eq(x.entries.get(mb.id), old, "pas de nouveau moteur avant la fin de l'arrêt");
    release();
    await saving;
    await settle(x);
    const fresh = x.entries.get(mb.id);
    assert(fresh !== old && fresh.sync !== old.sync, "nouveau moteur");
    eq(order, ["début", "fin"]);
    eq(recorded.map(([who, mid]) => [who === fresh.sync, mid]), [[true, "a@x"], [true, "b@x"]], "actions transmises au nouveau moteur, dans l'ordre");
    eq(fresh.mailbox.syncMinutes, 30);
  } finally {
    engine.recordIntent = record;
    release();
  }
});

test("arrière-plan : le journal ne contient ni adresse ni nom (F8)", async () => {
  const { x } = await load();
  const text = JSON.stringify(x.log.getLog());
  for (const secret of [EMAIL, "marie@example.com", "Jean", "Dupont"]) assert(!text.includes(secret), `journal : ${secret}`);
  assert(/boîte [0-9a-f]{12}/.test(text), "la boîte est désignée par son identifiant");
});

test("arrière-plan : identifiant de connexion refusé (deux-points, caractère invisible), comme l'expérience le refuse (N5)", async () => {
  const { x } = await load();
  const [mb] = await x.store.listMailboxes();
  for (const username of ["jean:dupont", `jean${String.fromCodePoint(0x200b)}`, `jean${String.fromCodePoint(0x2064)}`, `jean${String.fromCharCode(0xd800)}`]) {
    await rejects(x.saveMailbox(input({ id: mb.id, server: `https://${OTHER}`, username }), "pw"), (e) => e.field === "username", JSON.stringify(username));
  }
});

test("arrière-plan : une seule boîte par serveur et identifiant (le mot de passe enregistré serait partagé) (N1)", async () => {
  const { w, x } = await load();
  w.granted.add(perm(OTHER));
  await rejects(
    x.saveMailbox(input({ email: "marie@example.com", server: `https://${OTHER}`, username: EMAIL.toUpperCase() }), "pw"),
    (e) => e.field === "username" && /autre boîte/.test(e.message),
  );
  eq((await x.store.listMailboxes()).length, 1);
});

test("arrière-plan : changement de serveur dont l'enregistrement échoue, l'ancienne boîte reste entière (N2)", async () => {
  const { w, x } = await load();
  const [mb] = await x.store.listMailboxes();
  w.granted.add(perm(HOST));
  const put = x.store.putMailbox;
  x.store.putMailbox = async () => {
    throw new Error("stockage indisponible");
  };
  try {
    await rejects(x.saveMailbox(input({ id: mb.id, server: `https://${HOST}` }), "pw4"), (e) => /pas pu être enregistrée/.test(e.message));
  } finally {
    x.store.putMailbox = put;
  }
  await settle(x);
  const now = await x.store.getMailbox(mb.id);
  eq(now.origin, `https://${OTHER}`, "la boîte désigne toujours l'ancien serveur");
  eq([w.passwords.get(`https://${OTHER}|${EMAIL}`), w.passwords.has(`https://${HOST}|${EMAIL}`)], ["pw3", false], "ancien mot de passe gardé, nouveau retiré");
  assert(x.entries.get(mb.id)?.sync && !x.entries.get(mb.id).closing, "son moteur est reparti");
  eq(w.granted.has(perm(HOST)), false, "autorisation inutile rendue");
});

test("arrière-plan : « Garder les copies locales » (discardDeletes) réservé aux pages de l'extension, boîte connue seulement", async () => {
  const { w, x } = await load();
  const [mb] = await x.store.listMailboxes();
  const [listener] = w.browser.runtime.onMessage.listeners;
  const page = { id: "sync443@test", url: "moz-extension://sync443/options/options.html" };
  const engine = x.entries.get(mb.id).sync;
  let discarded = 0;
  const discard = engine.discardPendingDeletes;
  engine.discardPendingDeletes = async function () {
    discarded++;
    return discard.call(this);
  };
  try {
    eq(listener({ type: "discardDeletes", id: mb.id }, { id: "autre@extension", url: page.url }), undefined, "autre expéditeur ignoré");
    eq(await listener({ type: "discardDeletes", id: "000000000000" }, page), { ok: false, error: "Boîte inconnue.", field: undefined });
    eq(await listener({ type: "discardDeletes", id: mb.id }, page), { ok: true });
    eq(discarded, 1);
  } finally {
    engine.discardPendingDeletes = discard;
  }
  await settle(x);
});

test("arrière-plan : boîte supprimée pendant un enregistrement, après lui ; moteur, compte, mot de passe et autorisation retirés (N3)", async () => {
  const { w, x } = await load();
  const [mb] = await x.store.listMailboxes();
  const saving = x.saveMailbox(input({ id: mb.id, server: `https://${OTHER}`, syncMinutes: 60 }), null);
  const removing = x.removeMailbox(mb.id);
  await saving;
  await removing;
  await settle(x);
  eq([(await x.store.listMailboxes()).length, w.accounts.size, w.passwords.size, w.granted.size, x.entries.has(mb.id)], [0, 0, 0, 0, false]);
});

test("arrière-plan : fin (globales rétablies)", async () => {
  await load();
  globalThis.browser = saved.browser;
  if (saved.crypto) Object.defineProperty(globalThis, "crypto", saved.crypto);
  else delete globalThis.crypto;
});
