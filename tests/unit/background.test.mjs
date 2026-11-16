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
 *
 * The second half is the calendar: the privileged calendar module is the
 * double of calendar-fakes.mjs, windows.create records the confirmation
 * windows asked for, and the fake HTTP server answers FolderSync, Sync,
 * SendMail and MeetingResponse from the fake ActiveSync servers of the
 * engine's tests.
 */

import { test, assert, eq, rejects, prng } from "./harness.mjs";
import { memoryArea } from "./journal.test.mjs";
import { fakeConnector, fakeClock, server, http, wbxmlHttp, PIN } from "./client.test.mjs";
import { el, text, at } from "../../src/core/wbxml.mjs";
import { fakeI18n } from "./i18n-fake.mjs";
import { FakeServer } from "./mail-sync.test.mjs";
import { FakeCalendarApi, FakePimServer, OWN, event, task, meeting, readMeetingMail } from "./calendar-fakes.mjs";
import { checkInfo } from "../../src/confirm/confirm.mjs";

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
    calendarApi: new FakeCalendarApi(), // browser.sync443Calendar
    windows: [], // every window asked for: { id, url, type, width, height, closed }
    windowMode: "open", // "open" | "fail" (windows.create rejects) | "hang" (it never answers, as without a screen)
    notifications: [],
    handlers: null, // the fake HTTP server's answers, by command (changed by the calendar tests)
  };
  // A calendar left by a mailbox that no longer exists: swept when the page starts.
  w.calendarApi.calendars.set("sync443-aaaaaaaaaaaa-1", { mailboxId: "aaaaaaaaaaaa", slot: "main", name: "Orpheline", events: true, tasks: true, organizerEmail: "x@example.com", rows: [] });
  const call = (name, ...args) => w.calls.push([name, ...args]);
  const settings = () =>
    wbxmlHttp(
      el("Settings:Settings", [
        el("Status", "1"),
        el("UserInformation", [el("Status", "1"), el("Get", [el("Accounts", [el("Account", [el("UserDisplayName", w.displayName), el("EmailAddresses", [el("PrimarySmtpAddress", EMAIL)])])])])]),
      ]),
    );
  w.handlers = { Settings: settings, FolderSync: () => http(503, { reason: "Service Unavailable" }) };
  w.connector = fakeConnector({
    clock: fakeClock(),
    split: "one",
    handler: (req, ctx) => server(w.handlers)(req, ctx),
  });
  w.browser = {
    runtime: ns({
      id: "sync443@test",
      getURL: (p) => (p === "test-scenario.mjs" ? "../tests/unit/background-hook.mjs" : `moz-extension://sync443/${p}`),
      openOptionsPage: () => {},
      lastError: undefined,
    }),
    storage: ns({ local: w.area }),
    i18n: fakeI18n("fr"),
    notifications: ns({
      create: async (o) => {
        w.notifications.push(o);
        return "n";
      },
    }),
    windows: ns({
      create: (o) => {
        const win = { id: 100 + w.windows.length, ...o, closed: false };
        w.windows.push(win);
        if (w.windowMode === "fail") {
          win.closed = true;
          return Promise.reject(new Error("Illegal URL"));
        }
        return w.windowMode === "hang" ? new Promise(() => {}) : Promise.resolve({ id: win.id });
      },
      remove: async (id) => {
        const win = w.windows.find((x) => x.id === id && !x.closed);
        if (!win) throw new Error(`Invalid window ID: ${id}`);
        win.closed = true;
        for (const f of [...w.browser.windows.onRemoved.listeners]) f(id); // as Thunderbird tells of any window that goes
      },
    }),
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
    accounts: ns({
      get: async (accountKey) => {
        const a = w.accounts.get(accountKey);
        return a ? { id: a.accountKey, identities: [{ id: a.identityId, name: a.fullName ?? "" }] } : null;
      },
    }),
    messages: ns(),
    folders: ns(),
    compose: ns(),
    tabs: ns(),
    menus: ns({ create: (_props, done) => done?.(), update: async () => {}, refresh: () => {} }),
    browserAction: ns({ setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} }),
    sync443Net: w.connector,
    sync443Calendar: w.calendarApi,
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

// ── Calendar, tasks and meetings ──────────────────────────────────────────

const CAL = "7";
const TASKS = "8";
const GUEST = "anne@example.org";
const OPTIONS_PAGE = { id: "sync443@test", url: "moz-extension://sync443/options/options.html" };
const PIM_ONLY = { mail: false, calendar: true, contacts: false, tasks: true };
const CALENDAR_FOLDERS = [
  { id: "1", parentId: "0", name: "Boîte de réception", type: 2 },
  { id: "3", parentId: "0", name: "Éléments supprimés", type: 4 },
  { id: CAL, parentId: "0", name: "Calendrier", type: 8 },
  { id: TASKS, parentId: "0", name: "Tâches", type: 7 },
];
const QUESTION = { kind: "invite", summary: "Budget", start: "2026-12-01T09:00:00Z", allDay: false, recipients: [GUEST, "bruno@example.org"], from: OWN };

/** The fake HTTP server answers as an ActiveSync server with a calendar and tasks; → the two fakes behind it. */
function calendarServer(w) {
  const mail = new FakeServer({ folders: CALENDAR_FOLDERS }); // the folder list
  const pim = new FakePimServer({ folders: CALENDAR_FOLDERS }); // Calendar and Tasks, MeetingResponse, SendMail
  const answer = (node) => (node ? wbxmlHttp(node) : http(200));
  const asked = []; // commands, in order
  Object.assign(w.handlers, {
    FolderSync: (req) => (asked.push("FolderSync"), answer(mail.onFolderSync(req.doc))),
    Sync: (req) => {
      const cid = text(at(req.doc, "Collections", "Collection"), "CollectionId");
      asked.push(`Sync ${cid}`);
      pim.requests.push({ cmd: "Sync", req: req.doc, opts: {} });
      return answer((pim.classOf(cid) ? pim : mail).onSync(req.doc));
    },
    SendMail: (req) => (asked.push("SendMail"), answer(pim.onSendMail(req.doc))),
    MeetingResponse: (req) => (asked.push("MeetingResponse"), answer(pim.onMeetingResponse(req.doc))),
  });
  return { mail, pim, asked };
}

/**
 * Long timers (the delay of local actions, the life of a question, the late
 * closing of its window) are held, not armed: a test fires them itself.
 * Held from the first calendar test to the last test of this file, whatever
 * fails in between: a question asked by a pass that outlives a failed test
 * would otherwise keep the shell waiting for its ten minutes.
 * → { held: the timers asked for since this call, restore() }
 */
const realSetTimeout = globalThis.setTimeout;
const heldTimers = [];
function holdTimers() {
  heldTimers.length = 0;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (!(ms >= 2000)) return realSetTimeout(fn, ms, ...rest);
    heldTimers.push({ fn, ms });
    return 0;
  };
  return { held: heldTimers, restore: () => {} }; // (really restored by the last test)
}

const openWindows = (w) => w.windows.filter((x) => !x.closed);
const tokenOf = (win) => /^moz-extension:\/\/sync443\/confirm\/confirm\.html\?token=([0-9a-f]{64})$/.exec(win.url)?.[1] ?? null;
/** The confirmation page of a window, as the sender of its messages. */
const pageOf = (win, tabId = win.id + 1000) => ({ id: "sync443@test", url: win.url, tab: { id: tabId, windowId: win.id } });
/** The page closes its own window once the background has answered it (confirm.mjs), as any window closes. */
const closesItself = (w, win) => w.browser.windows.remove(win.id);
const calendarsOf = (w, id) => [...w.calendarApi.calendars].filter(([, c]) => c.mailboxId === id).map(([calendarId]) => calendarId);
const until = async (done, what) => {
  for (let i = 0; i < 400 && !done(); i++) await pause();
  assert(done(), what);
};

let calendarWorld = null;

/** The mailbox of the calendar tests: no mail, calendar and tasks, on a server that answers. */
async function calendarMailbox() {
  const { w, x } = await load();
  if (calendarWorld) return calendarWorld;
  const servers = calendarServer(w);
  holdTimers();
  w.granted.add(perm(HOST));
  w.displayName = "Marie Curie";
  const [listener] = w.browser.runtime.onMessage.listeners;
  calendarWorld = { w, x, listener, ...servers, id: null };
  return calendarWorld;
}

test("background, calendar: nothing depends on it at load time; a calendar without a mailbox is removed", async () => {
  const { w, x } = await load();
  eq(w.calendarApi.calls.filter((c) => !["listCalendars", "removeCalendar"].includes(c[0])), [], "no calendar made or read before a pass");
  assert(!w.calendarApi.calendars.has("sync443-aaaaaaaaaaaa-1"), "the calendar of a mailbox that is gone was removed");
  assert(x.log.getLog().some((e) => /agenda\(s\) d'une boîte disparue retiré/.test(e.msg)));
  eq(w.windows, [], "no window");
  eq(w.browser.windows.onRemoved.listeners.length, 1, "closed windows are watched");
});

test("background, calendar: period and filter saved (refusals name the field) and returned in the view; the mailbox's calendar objects are built and handed to the engine", async () => {
  const c = await calendarMailbox();
  const { w, x, listener } = c;
  c.pim.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  c.pim.addItem(TASKS, task({ uid: "t1", summary: "Rapport" }));
  const base = input({ email: OWN, sync: PIM_ONLY });
  await rejects(x.saveMailbox({ ...base, calendarPeriod: "3" }, "pw"), (e) => e.field === "calendarPeriod" && e.message === "Choisissez la période d'agenda à synchroniser.");
  await rejects(x.saveMailbox({ ...base, calendarPeriod: "7", taskFilter: "1" }, "pw"), (e) => e.field === "taskFilter");
  await rejects(x.saveMailbox({ ...base, calendarPeriod: { toString: () => "7" } }, "pw"), (e) => e.field === "calendarPeriod");
  eq((await x.store.listMailboxes()).length, 0, "nothing saved after a refusal");
  w.granted.add(perm(HOST)); // (given back after each refusal)
  const before = w.calendarApi.calls.length;
  const r = await x.saveMailbox({ ...base, calendarPeriod: "5", taskFilter: "8" }, "pw");
  c.id = r.id;
  await settle(x);
  const mb = await x.store.getMailbox(r.id);
  eq([mb.calendarPeriod, mb.taskFilter, mb.sync], ["5", "8", PIM_ONLY]);
  // The objects of the mailbox, in the entry (for the engine, and for the end-to-end scenario).
  const entry = x.entries.get(r.id);
  eq(Object.keys(entry.calendar), ["invitations", "calendarStore", "scheduler", "pim"]);
  eq([typeof entry.calendar.pim.pass, typeof entry.calendar.scheduler.deliver, typeof entry.calendar.calendarStore.readLocalChanges, typeof entry.calendar.invitations.find], ["function", "function", "function", "function"]);
  // Its first pass made its calendar, with the period and the filter chosen.
  const [calendarId] = calendarsOf(w, r.id);
  eq([calendarsOf(w, r.id).length, w.calendarApi.summaries(calendarId)], [1, ["Rapport", "Réunion"]]);
  eq(w.calendarApi.calls.slice(before).map((x) => x[0]).indexOf("ensureCalendar") >= 0, true);
  eq([c.pim.syncs(CAL)[0].filterType, c.pim.syncs(TASKS)[0].filterType], ["5", "8"]);
  eq(c.asked[0], "FolderSync");
  // The view the settings page lists.
  const view = (await listener({ type: "listMailboxes" }, OPTIONS_PAGE)).mailboxes.find((m) => m.id === r.id);
  eq([view.calendarPeriod, view.taskFilter, view.sync.calendar, view.status.pendingDeletes, view.status.failedItems, view.status.failedCalendarItems], ["5", "8", true, 0, 0, 0]);
  assert(view.status.lastSuccessAt > 0 && view.status.lastError === null, "the first pass succeeded");
  // Absent from a request (a page from before): both are kept.
  await x.saveMailbox({ ...base, id: r.id }, null);
  await settle(x);
  eq([(await x.store.getMailbox(r.id)).calendarPeriod, (await x.store.getMailbox(r.id)).taskFilter], ["5", "8"]);
});

test("background, calendar: changing the period or the filter replaces the engine and its objects, and starts a synchronization that restarts the collections", async () => {
  const c = await calendarMailbox();
  const { x } = c;
  const old = x.entries.get(c.id);
  const requests = c.pim.syncs(CAL).length;
  await x.saveMailbox(input({ id: c.id, email: OWN, sync: PIM_ONLY, calendarPeriod: "4", taskFilter: "0" }), null);
  await settle(x);
  const fresh = x.entries.get(c.id);
  assert(fresh !== old && fresh.sync !== old.sync, "new engine");
  for (const part of ["invitations", "calendarStore", "scheduler", "pim"]) assert(fresh.calendar[part] !== old.calendar[part], `${part} rebuilt`);
  const after = c.pim.syncs(CAL).slice(requests);
  eq([after[0].key, after[0].filterType, c.pim.syncs(TASKS).at(-1).filterType], ["0", "4", "0"], "the collection starts over with the new period");
  eq(c.w.calendarApi.summaries(calendarsOf(c.w, c.id)[0]), ["Rapport", "Réunion"]);
});

test("background, calendar: a change the user makes in the calendar leaves shortly after; the old engine no longer listens", async () => {
  const c = await calendarMailbox();
  const { w, x } = c;
  eq(w.calendarApi.listeners.size, 1, "one listener only after the engine was replaced");
  const [calendarId] = calendarsOf(w, c.id);
  const timers = holdTimers();
  try {
    w.calendarApi.userAdd(calendarId, event({ uid: "local", summary: "Dentiste" }));
    eq(timers.held.map((t) => t.ms), [3000], "a pass is scheduled, as after a local mail action");
    w.calendarApi.userAdd(calendarId, task({ uid: "local-t", summary: "Pain" }));
    eq(timers.held.length, 2, "put off at each change");
    timers.held.at(-1).fn();
    await settle(x);
    eq([c.pim.adds.length, [...c.pim.items.get(CAL).values()].map((i) => i.summary).sort()], [2, ["Dentiste", "Réunion"]], "sent to the server");
    // A calendar of another mailbox tells nothing to this one.
    const n = timers.held.length;
    for (const f of [...w.calendarApi.listeners]) f("sync443-bbbbbbbbbbbb-1");
    eq(timers.held.length, n);
  } finally {
    timers.restore();
  }
});

test("background, confirmation: one window per question, under a random token; only its page gets the question and answers it, once", async () => {
  const c = await calendarMailbox();
  const { w, x, listener } = c;
  const timers = holdTimers();
  try {
    const answered = x.meetings.ask(c.id, QUESTION);
    await ticks();
    const [win] = openWindows(w);
    eq([openWindows(w).length, win.type, win.width, win.height], [1, "popup", 520, 440]);
    const token = tokenOf(win);
    assert(token, `address of the window: ${win.url}`);
    eq(timers.held.at(-1).ms, 600_000, "ten minutes");
    eq(x.meetings.current(), { mailboxId: c.id, token, url: win.url, ...QUESTION });
    const page = pageOf(win);
    // What the window is told: exactly what its own checks accept.
    const info = await listener({ type: "meetingConfirmInfo", token }, page);
    eq(info, { ok: true, ...QUESTION });
    eq(checkInfo(info).recipients, QUESTION.recipients);
    // Forged: another extension, another page of this one, a wrong token, a copy of the page elsewhere, no token.
    eq(listener({ type: "meetingConfirm", token, send: true }, { ...page, id: "autre@extension" }), undefined);
    for (const [msg, sender] of [
      [{ type: "meetingConfirm", token, send: true }, { ...OPTIONS_PAGE, tab: page.tab }],
      [{ type: "meetingConfirm", token, send: true }, { ...page, url: `moz-extension://sync443/options/options.html?token=${token}` }],
      [{ type: "meetingConfirm", token, send: true }, { ...page, url: `${win.url}&x=1` }],
      [{ type: "meetingConfirm", token: token.replace(/.$/, (d) => (d === "0" ? "1" : "0")), send: true }, page],
      [{ type: "meetingConfirm", send: true }, page],
      [{ type: "meetingConfirm", token: [token], send: true }, page],
      [{ type: "meetingConfirm", token, send: true }, { ...page, tab: { id: 77, windowId: win.id } }],
      [{ type: "meetingConfirm", token, send: true }, { ...page, tab: { id: page.tab.id, windowId: 999 } }],
      [{ type: "meetingConfirmInfo", token }, { ...OPTIONS_PAGE }],
    ]) {
      eq(await listener(msg, sender), { ok: false }, JSON.stringify([msg, sender.url, sender.tab]));
    }
    let settled = false;
    answered.then(() => (settled = true));
    await ticks();
    eq([settled, openWindows(w).length], [false, 1], "no forged answer counted");
    // The real answer, once.
    eq(await listener({ type: "meetingConfirm", token, send: true }, page), { ok: true });
    eq(await answered, true);
    await ticks();
    eq(x.meetings.current(), null);
    // The token is dead: neither a second answer nor the question again.
    eq(await listener({ type: "meetingConfirm", token, send: true }, page), { ok: false });
    eq(await listener({ type: "meetingConfirmInfo", token }, page), { ok: false });
    // Its window is left to its page, which closes it once it has the reply (closed under that reply, its message
    // would stay unanswered: an error in Thunderbird's console). Still there a moment later, it is closed for it.
    eq([openWindows(w).length, timers.held.at(-1).ms], [1, 2000], "not closed under the reply");
    timers.held.at(-1).fn();
    await ticks();
    eq(openWindows(w).length, 0, "closed for its page when the page did not");
    // A window its page did close is no error for that safety net.
    const second = x.meetings.ask(c.id, QUESTION);
    await ticks();
    const win2 = openWindows(w)[0];
    eq(await listener({ type: "meetingConfirm", token: tokenOf(win2), send: false }, pageOf(win2)), { ok: true });
    eq(await second, false);
    await closesItself(w, win2);
    timers.held.at(-1).fn();
    await ticks();
    eq(openWindows(w).length, 0);
  } finally {
    timers.restore();
  }
});

test("background, confirmation: only true sends; a closed window, an expired token or a window that cannot open mean Don't send", async () => {
  const c = await calendarMailbox();
  const { w, x, listener } = c;
  const timers = holdTimers();
  const ask = async () => {
    const answered = x.meetings.ask(c.id, QUESTION);
    await ticks();
    const win = openWindows(w).at(-1);
    return { answered, win, token: win ? tokenOf(win) : null };
  };
  try {
    // Anything but true.
    for (const send of [false, "true", 1, undefined, { valueOf: () => true }]) {
      const q = await ask();
      eq(await listener({ type: "meetingConfirm", token: q.token, send }, pageOf(q.win)), { ok: true }, String(send));
      eq(await q.answered, false, String(send));
      await closesItself(w, q.win);
    }
    // The window is closed without an answer.
    let q = await ask();
    for (const f of [...w.browser.windows.onRemoved.listeners]) f(999); // another window: nothing
    eq(x.meetings.current()?.token, q.token);
    await w.browser.windows.remove(q.win.id);
    eq(await q.answered, false);
    eq(await listener({ type: "meetingConfirm", token: q.token, send: true }, pageOf(q.win)), { ok: false }, "its token died with it");
    // Ten minutes without an answer: the timer closes the question and its window. Not a yes; told apart from
    // "Don't send", so that the scheduler can tell the user that the message did not leave.
    q = await ask();
    eq(await listener({ type: "meetingConfirmInfo", token: q.token }, pageOf(q.win)), { ok: true, ...QUESTION });
    timers.held.at(-1).fn();
    eq(await q.answered, "expired");
    await ticks();
    eq([q.win.closed, await listener({ type: "meetingConfirm", token: q.token, send: true }, pageOf(q.win))], [true, { ok: false }]);
    // The same, when the answer arrives before the timer could run: the token's own date decides.
    x.testConfig.confirmTtlMs = 0;
    q = await ask();
    eq(await listener({ type: "meetingConfirm", token: q.token, send: true }, pageOf(q.win)), { ok: false }, "expired token");
    eq(await q.answered, "expired");
    delete x.testConfig.confirmTtlMs;
    // Nothing a page says is "expired": from the window, anything but true is Don't send.
    q = await ask();
    eq(await listener({ type: "meetingConfirm", token: q.token, send: "expired" }, pageOf(q.win)), { ok: true });
    eq(await q.answered, false);
    await closesItself(w, q.win);
    // The window cannot be opened: not a yes, and the user is told that nothing was sent.
    w.windowMode = "fail";
    const notices = w.notifications.length;
    const failed = x.meetings.ask(c.id, QUESTION);
    eq(await failed, false);
    eq(w.notifications.length, notices + 1);
    assert(w.notifications.at(-1).message.includes("Budget") && /n'a pas été envoyé/.test(w.notifications.at(-1).message), w.notifications.at(-1).message);
    // What a notification quotes is cleaned where it is shown: no joiner, nothing invisible or bidirectional, one line.
    const hidden = [0x200c, 0x200d, 0x200b, 0x202e, 0x2066, 0xfeff].map((code) => String.fromCodePoint(code));
    eq(await x.meetings.ask(c.id, { ...QUESTION, summary: `Bud${hidden.join("")}get\nligne 2` }), false);
    eq(w.notifications.length, notices + 2);
    assert(w.notifications.at(-1).message.includes("« Budget ligne 2 »") && !hidden.some((h) => w.notifications.at(-1).message.includes(h)), w.notifications.at(-1).message);
    w.windowMode = "open";
    // A question that is not one (the scheduler only gives checked ones) is never shown: without the address of
    // the mailbox that sends, in particular, there is nothing to confirm.
    const shown = w.windows.length;
    const noSender = { ...QUESTION };
    delete noSender.from;
    for (const bad of [
      null, { ...QUESTION, kind: "reply" }, { ...QUESTION, recipients: [] }, { ...QUESTION, recipients: Array.from({ length: 101 }, (_, i) => `p${i}@example.org`) }, { ...QUESTION, allDay: "non" },
      noSender, { ...QUESTION, from: "" }, { ...QUESTION, from: "Moi <moi@example.com>" }, { ...QUESTION, from: "moi@example.com, eve@evil.example" }, { ...QUESTION, from: ["moi@example.com"] }, { ...QUESTION, from: " moi@example.com" },
    ]) {
      eq(await x.meetings.ask(c.id, bad), false);
    }
    eq(w.windows.length, shown);
    eq([openWindows(w).length, x.meetings.current(), x.meetings.waiting()], [0, null, []]);
  } finally {
    w.windowMode = "open";
    delete x.testConfig.confirmTtlMs;
    timers.restore();
  }
});

test("background: a notification is one clean line of at most 300 characters, whatever the text it is given", async () => {
  const { w, x } = await load();
  const c = (code) => String.fromCodePoint(code);
  const shown = async (message) => {
    const before = w.notifications.length;
    await x.meetings.notify(message);
    eq(w.notifications.length, before + 1);
    const n = w.notifications.at(-1);
    eq([n.type, n.title], ["basic", "Sync443"]);
    return n.message;
  };
  // A text nobody cleaned before (a module that would forget to): joiners, zero-width, bidirectional, tags, controls.
  for (const code of [0xad, 0x34f, 0x61c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff, 0xfff9, 0xfffe, 0xe0041, 0x00, 0x07, 0x1b, 0x7f, 0x9f]) {
    eq(await shown(`Envoi${c(code)} refusé`), "Envoi refusé", `U+${code.toString(16)}`);
    eq(await shown(`Envoi${String.fromCharCode(0xd83d)}${c(code)}`), `Envoi${c(0xfffd)}`, `half a character, then U+${code.toString(16)}`);
  }
  eq(await shown(`ligne 1\r\nligne 2\tsuite${c(0x2028)}fin`), "ligne 1 ligne 2 suite fin", "one line");
  eq(await shown(`${c(0x202e)}exe.tnemucod`), "exe.tnemucod", "no override of the reading direction");
  const long = await shown(`${"x".repeat(299)}${c(0x1f600)}${"y".repeat(500)}`);
  assert(long.length <= 300 && long.isWellFormed() && long === "x".repeat(299), `cut at 300, never inside a character: ${long.length}`);
  eq(await shown(`${c(0x200d)}`.repeat(400) + "visible"), "visible", "what is removed does not count in the 300");
  eq(await shown(42), "42");
});

test("background, confirmation: two questions at once, one window; the next one waits its turn under another token", async () => {
  const c = await calendarMailbox();
  const { w, x, listener } = c;
  const timers = holdTimers();
  try {
    const first = x.meetings.ask(c.id, QUESTION);
    const second = x.meetings.ask("cccccccccccc", { ...QUESTION, kind: "cancel", summary: "Bilan" });
    const third = x.meetings.ask(c.id, { ...QUESTION, kind: "update", summary: "Budget (2)" });
    await ticks();
    eq([openWindows(w).length, x.meetings.waiting().map((q) => q.summary)], [1, ["Bilan", "Budget (2)"]]);
    const win1 = openWindows(w)[0];
    const token1 = tokenOf(win1);
    eq((await listener({ type: "meetingConfirmInfo", token: token1 }, pageOf(win1))).summary, "Budget");
    eq(await listener({ type: "meetingConfirm", token: token1, send: true }, pageOf(win1)), { ok: true });
    eq(await first, true);
    await ticks();
    const win2 = w.windows.at(-1);
    const token2 = tokenOf(win2);
    assert(win2 !== win1 && token2 && token2 !== token1, "the next one has a window and a token of its own");
    await closesItself(w, win1); // (closing the first window does nothing to the second question)
    eq([openWindows(w), x.meetings.current()?.token], [[win2], token2]);
    eq(timers.held.filter((t) => t.ms === 600_000).length, 2, "its ten minutes start when its window opens");
    // The first window's token, or the first page, cannot answer the second question.
    eq(await listener({ type: "meetingConfirm", token: token1, send: true }, pageOf(win2)), { ok: false });
    eq(await listener({ type: "meetingConfirm", token: token2, send: true }, pageOf(win1)), { ok: false });
    eq((await listener({ type: "meetingConfirmInfo", token: token2 }, pageOf(win2))).kind, "cancel");
    // Thunderbird has no screen (windows.create never answers): the page still asks and answers, and closing it still counts.
    w.windowMode = "hang";
    eq(await listener({ type: "meetingConfirm", token: token2, send: false }, pageOf(win2)), { ok: true });
    eq(await second, false);
    await ticks();
    await closesItself(w, win2);
    const win3 = w.windows.at(-1);
    const token3 = tokenOf(win3);
    eq((await listener({ type: "meetingConfirmInfo", token: token3 }, pageOf(win3))).summary, "Budget (2)");
    await w.browser.windows.remove(win3.id); // closed by the user; its id is known from its page's first message
    eq(await third, false);
    eq(await listener({ type: "meetingConfirm", token: token3, send: true }, pageOf(win3)), { ok: false });
    // The test hook answers the open question as its window would.
    w.windowMode = "open";
    const hooked = x.meetings.ask(c.id, QUESTION);
    await ticks();
    eq([x.meetings.answer(true), await hooked, x.meetings.answer(true)], [true, true, false]);
    await ticks();
    eq(openWindows(w).length, 0);
  } finally {
    w.windowMode = "open";
    timers.restore();
  }
});

test("background, meeting: from Thunderbird's calendar to the sending, through the confirmation window; the identity's name signs the message", async () => {
  const c = await calendarMailbox();
  const { w, x, listener } = c;
  const [calendarId] = calendarsOf(w, c.id);
  const timers = holdTimers();
  try {
    w.calendarApi.userAdd(calendarId, meeting([GUEST], { uid: "m1", summary: "Comité" }));
    timers.held.at(-1).fn(); // the pass that follows a local change
    await settle(x);
    await until(() => openWindows(w).length === 1, "the confirmation window never opened");
    const entry = x.entries.get(c.id);
    eq([entry.inFlight, entry.sync.running, entry.sync.delivering, c.pim.mails.length], [null, false, true, 0], "the pass is over, nothing has left");
    const win = openWindows(w)[0];
    const token = tokenOf(win);
    const shown = await listener({ type: "meetingConfirmInfo", token }, pageOf(win));
    eq(shown, { ok: true, kind: "invite", summary: "Comité", start: "2026-12-01T09:00:00Z", allDay: false, recipients: [GUEST], from: OWN }, "with the address of the mailbox that sends");
    eq(checkInfo(shown)?.from, OWN, "exactly what the window's own checks accept");
    // While the window waits, the mailbox synchronises as usual.
    c.pim.addItem(CAL, event({ uid: "pendant", summary: "Pendant" }));
    await x.runSync(c.id, { reason: "user" });
    assert(w.calendarApi.summaries(calendarId).includes("Pendant"), "the pass is not held back by the window");
    eq(await listener({ type: "meetingConfirm", token, send: true }, pageOf(win)), { ok: true });
    await closesItself(w, win);
    await until(() => c.pim.mails.length === 1 && !entry.sync.delivering, "the message was never sent");
    const mail = readMeetingMail(c.pim.mails[0].mime);
    eq([mail.method, mail.to, mail.from], ["REQUEST", [GUEST], [OWN]]);
    assert(mail.headers.get("from").includes("Marie Curie"), `sender: ${mail.headers.get("from")}`);
    eq(c.asked.filter((cmd) => cmd === "SendMail").length, 1);
    eq(await entry.calendar.scheduler.pending(), 0);
  } finally {
    timers.restore();
  }
});

test("background, meeting: engine replaced while the question is open; it is withdrawn, the message stays and the new engine asks again", async () => {
  const c = await calendarMailbox();
  const { w, x } = c;
  const [calendarId] = calendarsOf(w, c.id);
  const timers = holdTimers();
  try {
    w.calendarApi.userModify(calendarId, "m1", { summary: "Comité déplacé", start: "2026-12-02T09:00:00Z", end: "2026-12-02T10:00:00Z" });
    timers.held.at(-1).fn();
    await settle(x);
    await until(() => openWindows(w).length === 1, "the question was never asked");
    const win = openWindows(w)[0];
    const token = tokenOf(win);
    eq(x.meetings.current().kind, "update");
    const old = x.entries.get(c.id);
    const mails = c.pim.mails.length;
    // The user edits the mailbox while the window is open.
    const waiting = x.meetings.ask(c.id, { ...QUESTION, summary: "En file" }); // and one more was waiting its turn
    await x.saveMailbox(input({ id: c.id, email: OWN, sync: PIM_ONLY, syncMinutes: 30 }), null);
    eq(await waiting, false, "the one waiting its turn is never asked");
    assert(win.closed, "the old engine's window is closed");
    eq(await c.listener({ type: "meetingConfirm", token, send: true }, pageOf(win)), { ok: false }, "its token is worth nothing any more");
    eq(old.sync.delivering, false, "the old engine was done before the new one started");
    // The new engine finds the message, and asks again in a window of its own.
    await settle(x);
    await until(() => openWindows(w).length === 1, "the new engine does not ask again");
    const again = openWindows(w)[0];
    assert(again !== win && tokenOf(again) !== token);
    eq([c.pim.mails.length, x.meetings.current().summary], [mails, "Comité déplacé"]);
    eq(x.meetings.answer(true), true);
    const fresh = x.entries.get(c.id);
    await until(() => c.pim.mails.length === mails + 1 && !fresh.sync.delivering, "the message was never sent");
    eq(readMeetingMail(c.pim.mails.at(-1).mime).calendar.some((line) => /^SEQUENCE:1$/.test(line)), true, "an update, sent once");
  } finally {
    timers.restore();
  }
});

test("background, meeting: a question nobody answers for ten minutes — nothing is sent, and the user is told that the attendees were not informed", async () => {
  const c = await calendarMailbox();
  const { w, x, listener } = c;
  const [calendarId] = calendarsOf(w, c.id);
  const timers = holdTimers();
  try {
    w.calendarApi.userModify(calendarId, "m1", { summary: "Comité sans réponse", location: "Salle 4" });
    timers.held.at(-1).fn();
    await settle(x);
    await until(() => openWindows(w).length === 1, "the question was never asked");
    const win = openWindows(w)[0];
    const entry = x.entries.get(c.id);
    const [mails, notices] = [c.pim.mails.length, w.notifications.length];
    eq(x.meetings.current().summary, "Comité sans réponse");
    const life = timers.held.filter((t) => t.ms === 600_000).at(-1);
    life.fn(); // ten minutes later
    await until(() => !entry.sync.delivering, "the delivery never ended");
    eq([x.meetings.current(), win.closed, c.pim.mails.length - mails], [null, true, 0], "the question is closed, nothing left");
    eq(w.notifications.length, notices + 1);
    eq(w.notifications.at(-1).message, "Le message de réunion pour « Comité sans réponse » n'a pas été envoyé : la demande de confirmation est restée sans réponse. L'événement est enregistré, mais les participants n'ont pas été informés.");
    eq(await listener({ type: "meetingConfirm", token: tokenOf(win), send: true }, pageOf(win)), { ok: false }, "a late Send is worth nothing");
    eq(await entry.calendar.scheduler.pending(), 0, "not asked again");
    await x.runSync(c.id, { reason: "user" });
    await ticks();
    eq([openWindows(w).length, c.pim.mails.length - mails, w.notifications.length], [0, 0, notices + 1]);
  } finally {
    timers.restore();
  }
});

test("background, calendar: mass deletions counted in the view, confirmed or set aside by the same two decisions", async () => {
  const c = await calendarMailbox();
  const { w, x, listener } = c;
  const [calendarId] = calendarsOf(w, c.id);
  const view = async () => (await listener({ type: "listMailboxes" }, OPTIONS_PAGE)).mailboxes.find((m) => m.id === c.id);
  const sids = Array.from({ length: 100 }, (_, i) => c.pim.addItem(CAL, event({ uid: `masse${i}`, summary: `Masse ${i}` })));
  c.pim.addRaw(CAL, [el("Calendar:UID", "cassé"), el("Calendar:Subject", "Illisible"), el("Calendar:StartTime", "pas une date"), el("Calendar:EndTime", "20261201T100000Z")]);
  for (let i = 0; i < 5; i++) await x.runSync(c.id, { reason: "user" });
  const held = w.calendarApi.items(calendarId).length;
  eq([(await view()).status.failedItems, (await view()).status.failedCalendarItems], [1, 1], "the unreadable item is counted, on the calendar's side");
  for (const sid of sids.slice(0, 60)) c.pim.deleteItem(CAL, sid);
  await x.runSync(c.id, { reason: "user" });
  let v = await view();
  eq([v.status.blocked?.code, v.status.pendingDeletes, w.calendarApi.items(calendarId).length], ["MASS_DELETE", 60, held]);
  // "Keep the local copies": the events stay, detached from the server.
  eq(await listener({ type: "discardDeletes", id: c.id }, OPTIONS_PAGE), { ok: true });
  await settle(x);
  v = await view();
  eq([v.status.blocked, v.status.pendingDeletes, w.calendarApi.items(calendarId).filter((r) => r.detached).length], [null, 0, 60]);
  // "Confirm the deletions": of tasks, this time.
  for (const i of Array.from({ length: 60 }, (_, k) => k)) c.pim.addItem(TASKS, task({ uid: `tm${i}`, summary: `TM ${i}` }));
  await x.runSync(c.id, { reason: "user" });
  for (const sid of [...c.pim.items.get(TASKS).keys()].filter((sid) => c.pim.items.get(TASKS).get(sid).summary.startsWith("TM "))) c.pim.deleteItem(TASKS, sid);
  await x.runSync(c.id, { reason: "user" });
  eq((await view()).status.pendingDeletes, 60);
  const before = w.calendarApi.items(calendarId).length;
  eq(await listener({ type: "syncMailbox", id: c.id, confirmDeletes: true }, OPTIONS_PAGE), { ok: true });
  await settle(x);
  v = await view();
  eq([v.status.blocked, v.status.pendingDeletes, w.calendarApi.items(calendarId).length], [null, 0, before - 60]);
});

test("background, calendar (audit C-M5): another sign-in name or server removes the mailbox's calendars before the new one is read", async () => {
  const c = await calendarMailbox();
  const { w, x } = c;
  await settle(x);
  const [old] = calendarsOf(w, c.id);
  const before = w.calendarApi.summaries(old);
  assert(before.length > 5, "the calendar holds the items of the old server");
  // What the server no longer has, and what only Thunderbird has: both would stay beside the new server's items.
  const kept = w.calendarApi.items(old).filter((r) => r.detached).length;
  assert(kept > 0, "copies the user kept, detached from the server");
  const timers = holdTimers();
  try {
    w.calendarApi.userAdd(old, event({ uid: "jamais-envoyé", summary: "Jamais envoyé" })); // (its pass is held: not sent yet)
    const records = async () => Object.keys(await w.area.get(null)).filter((k) => k.startsWith(`mb/${c.id}/`));
    assert((await records()).some((k) => /\/pim/.test(k)), "calendar records of the old server");
    const from = w.calendarApi.calls.length;
    const syncs = c.asked.length;
    w.granted.add(perm(HOST));
    await x.saveMailbox(input({ id: c.id, email: OWN, sync: PIM_ONLY, username: "DOMAINE\\moi" }), "pw-domaine");
    // Before anything is read from the new sign-in: the calendar is removed, as when a mailbox is removed.
    const calls = w.calendarApi.calls.slice(from).map((call) => call[0]);
    const removed = calls.indexOf("removeCalendar");
    assert(removed >= 0, `removeCalendar among ${calls.join(", ")}`);
    for (const later of ["ensureCalendar", "applyServerChanges", "readLocalChanges"]) {
      const at = calls.indexOf(later);
      assert(at < 0 || at > removed, `${later} before the calendar was removed`);
    }
    assert(x.log.getLog().some((e) => /agenda\(s\) retiré\(s\) de Thunderbird/.test(e.msg)));
    await settle(x);
    await ticks();
    // The new engine starts from nothing (FolderSync, then every collection from its first key) and builds the calendar again.
    const after = c.asked.slice(syncs);
    eq(after[0], "FolderSync");
    eq(c.pim.syncs(CAL).filter((r) => r.key === "0").length >= 2, true, "the calendar collection starts over");
    const [fresh] = calendarsOf(w, c.id);
    eq(calendarsOf(w, c.id).length, 1);
    const now = w.calendarApi.summaries(fresh);
    // (The server also holds one item nobody can read, from the test before: it has no description to compare.)
    eq(now, [...c.pim.items.get(CAL).values(), ...c.pim.items.get(TASKS).values()].map((i) => i.summary).filter((title) => typeof title === "string").sort(), "exactly what the server has");
    eq(w.calendarApi.items(fresh).filter((r) => r.detached).length, 0, "no item of the old server is left under a collection nobody knows");
    assert(!now.includes("Jamais envoyé"), "the change not yet sent went with the calendar (the settings page says so before saving)");
    assert(![...c.pim.items.get(CAL).values()].some((i) => i.summary === "Jamais envoyé"), "and was not sent to the new sign-in");
    eq((await x.store.getMailbox(c.id)).username, "DOMAINE\\moi");
  } finally {
    timers.restore();
  }
});

test("background, calendar: without the calendar module the mailbox synchronizes without it; a mailbox removed takes its calendars and its questions with it", async () => {
  const c = await calendarMailbox();
  const { w, x } = c;
  const mb = await x.store.getMailbox(c.id);
  // Without Thunderbird's calendars (another build, a module that failed to load): an engine all the same.
  const calendars = w.browser.sync443Calendar;
  w.browser.sync443Calendar = undefined;
  try {
    await x.attach(mb);
    const bare = x.entries.get(c.id);
    assert(bare.sync && bare.calendar === null && bare.stopCalendar === null, "an engine without a calendar");
    assert(x.log.getLog().some((e) => e.level === "warn" && /^Agenda indisponible \(boîte [0-9a-f]{12}\) : UNSUPPORTED\.$/.test(e.msg)));
  } finally {
    w.browser.sync443Calendar = calendars;
  }
  await x.attach(mb);
  await settle(x);
  eq([w.calendarApi.listeners.size, calendarsOf(w, c.id).length], [1, 1]);
  // Removal, with a question open.
  const timers = holdTimers();
  try {
    const open = x.meetings.ask(c.id, QUESTION);
    await ticks();
    const win = openWindows(w)[0];
    await x.removeMailbox(c.id);
    eq(await open, false);
    assert(win.closed, "window closed");
  } finally {
    timers.restore();
  }
  eq([calendarsOf(w, c.id).length, w.calendarApi.listeners.size, x.entries.has(c.id), (await x.store.listMailboxes()).length], [0, 0, false, 0]);
  eq(Object.keys(await w.area.get(null)).filter((k) => k.startsWith(`mb/${c.id}/`)), [], "no record left, of the calendar or of anything else");
  assert(x.log.getLog().some((e) => /agenda\(s\) retiré\(s\) de Thunderbird/.test(e.msg)));
  await settle(x);
});

test("arrière-plan : fin (globales rétablies)", async () => {
  await load();
  globalThis.setTimeout = realSetTimeout;
  globalThis.browser = saved.browser;
  if (saved.crypto) Object.defineProperty(globalThis, "crypto", saved.crypto);
  else delete globalThis.crypto;
});
