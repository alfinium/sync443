// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the contact synchronisation (src/sync/contacts.mjs: the engine
 * of pim.mjs over the address books of tb/contact-store.mjs), against the
 * simulated ActiveSync server and a double of Thunderbird's address books.
 */

import { test, assert, eq } from "./harness.mjs";
import { contactSync, contactRecords, ContactNotices } from "../../src/sync/contacts.mjs";
import { PimSync, pimCollections } from "../../src/sync/pim.mjs";
import { ContactStore } from "../../src/tb/contact-store.mjs";
import { CalendarStore } from "../../src/tb/calendar-store.mjs";
import { Store } from "../../src/sync/store.mjs";
import { projectVCard } from "../../src/core/vcard.mjs";
import { checkContact } from "../../src/core/contact-item.mjs";
import { memoryArea } from "./journal.test.mjs";
import { quietLog } from "./mail-sync.test.mjs";
import { FakePimServer, FakeCalendarApi, PIM_FOLDERS, OWN, event } from "./calendar-fakes.mjs";
import { FakeAddressBooks, contact } from "./contact-fakes.mjs";

const MB = "0123456789ab";
const AB = "9";
const FOLDERS = [...PIM_FOLDERS, { id: AB, parentId: "0", name: "Contacts", type: 9 }, { id: "12", parentId: AB, name: "Fournisseurs", type: 14 }];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function world({ sync = { mail: true, calendar: true, contacts: true, tasks: true } } = {}) {
  const server = new FakePimServer({ folders: FOLDERS });
  const tb = new FakeAddressBooks();
  const area = memoryArea();
  const records = new Store(area).mailbox(MB);
  const clock = { now: Date.UTC(2026, 10, 17, 9, 0, 0) };
  const mailbox = { id: MB, email: OWN, name: "Travail", sync: { ...sync }, calendarPeriod: "7", taskFilter: "0" };
  const w = { server, tb, area, records, clock, mailbox, notices: [] };
  w.restart = () => {
    w.store = new ContactStore({ mailboxId: MB, records, api: tb, now: () => clock.now });
    w.store.onLocalChange(() => {});
    w.engine = contactSync({ mailbox, records, contactStore: w.store, notify: (text) => w.notices.push(text), log: quietLog(), now: () => clock.now });
  };
  w.restart();
  w.pass = (o = {}) => w.engine.pass({ client: server, version: "14.1", folders: server.folders, ...o });
  w.settle = async (o = {}) => {
    let r = await w.pass(o);
    for (let i = 0; i < 30 && r.moreAvailable && !r.pendingDeletes; i++) r = await w.pass();
    await tick();
    clock.now += 10_000; // past the echo of the engine's own writes
    return r;
  };
  w.book = (slot = "main") => [...tb.books.keys()].find((id) => w.bookSlots.get(id) === slot) ?? null;
  w.bookSlots = { get: (id) => w.slots?.get(id) };
  w.books = async () => {
    w.slots = new Map((await w.store.listCalendars()).map((c) => [c.calendarId, c.slot]));
    return w.slots;
  };
  w.names = (bookId) => tb.ids(bookId).map((id) => projectVCard(tb.card(bookId, id)).fields.FileAs).sort();
  w.serverNames = (cid = AB) => [...server.items.get(cid).values()].map((i) => i.summary).sort();
  w.commands = (cid = AB) => server.syncs(cid).flatMap((s) => s.commands.map((c) => c.tag));
  return w;
}

const person = (first, last, over = {}) => checkContact(contact({ fields: { FirstName: first, LastName: last, ...(over.fields ?? {}) }, ...over, ...(over.fields ? { fields: { FirstName: first, LastName: last, ...over.fields } } : {}) }));

test("contacts: the contacts folders are collections of the contact engine only", () => {
  const folders = new Map(FOLDERS.map((f) => [f.id, f]));
  const all = { mail: true, calendar: true, contacts: true, tasks: true };
  eq([...pimCollections(folders, all, "contacts")].map(([id, c]) => [id, c.cls, c.slot]), [[AB, "Contacts", "main"], ["12", "Contacts", "12"]]);
  eq([...pimCollections(folders, all)].map(([id]) => id), ["7", "8"]);
  eq([...pimCollections(folders, { ...all, contacts: false }, "contacts")], []);
});

test("contacts: a first synchronisation fills an address book of the mailbox", async () => {
  const w = world();
  w.server.addItem(AB, person("Ada", "Lovelace", { fields: { Email1Address: "ada@example.com", AssistantName: "Charles" } }));
  w.server.addItem(AB, person("Grace", "Hopper"));
  w.server.addItem("12", person("Alan", "Turing"));
  const r = await w.settle();
  eq(r.errors ?? [], []);
  const slots = await w.books();
  eq([...slots.values()].sort(), ["12", "main"]);
  const main = [...slots].find(([, s]) => s === "main")[0];
  const other = [...slots].find(([, s]) => s === "12")[0];
  eq(w.names(main), ["Ada Lovelace", "Grace Hopper"]);
  eq(w.names(other), ["Alan Turing"]);
  eq(w.tb.books.get(main).name, "Travail");
  eq(w.tb.books.get(other).name, "Fournisseurs");
  // Nothing of it goes back to the server.
  await w.settle();
  eq(w.commands().filter((t) => t !== "Fetch"), []);
});

test("contacts: the first request names what is managed, and asks for no period", async () => {
  const w = world();
  await w.settle();
  const syncs = w.server.syncs(AB);
  const supported = syncs[0].supported;
  assert(supported.includes("Contacts:FirstName") && supported.includes("Contacts2:NickName") && !supported.includes("Contacts:Picture"));
  eq([syncs.at(-1).filterType, syncs.at(-1).conflict, syncs.at(-1).bodyType], [null, "1", "1"]);
});

test("contacts: changes and deletions of the server reach the book", async () => {
  const w = world();
  const ada = w.server.addItem(AB, person("Ada", "Lovelace"));
  const grace = w.server.addItem(AB, person("Grace", "Hopper"));
  await w.settle();
  const main = [...(await w.books())][0][0];
  w.server.changeItem(AB, ada, person("Ada", "King", { fields: { JobTitle: "Comtesse" } }));
  w.server.deleteItem(AB, grace);
  await w.settle();
  eq(w.names(main), ["Ada King"]);
  eq(projectVCard(w.tb.card(main, w.tb.ids(main)[0])).fields.JobTitle, "Comtesse");
  await w.settle();
  eq(w.commands().filter((t) => t !== "Fetch"), [], "the engine's own writes are not sent back");
});

test("contacts: what the user does in the book reaches the server", async () => {
  const w = world();
  const ada = w.server.addItem(AB, person("Ada", "Lovelace", { fields: { AssistantName: "Charles" }, children: ["Byron"] }));
  const grace = w.server.addItem(AB, person("Grace", "Hopper"));
  await w.settle();
  const main = [...(await w.books())].find(([, s]) => s === "main")[0];
  const idOf = (name) => w.tb.ids(main).find((id) => projectVCard(w.tb.card(main, id)).fields.FileAs === name);
  // A new contact, a change, a deletion.
  w.tb.userAdd(main, ["FN:Alan Turing", "N:Turing;Alan;;;", "EMAIL:alan@example.com"]);
  w.tb.userEdit(main, idOf("Ada Lovelace"), (l) => [...l, "TITLE:Analyste"]);
  w.tb.userDelete(main, idOf("Grace Hopper"));
  await tick();
  await w.settle();
  eq(w.commands().filter((t) => t !== "Fetch").sort(), ["Add", "Change", "Delete"]);
  eq(w.serverNames(), ["Ada Lovelace", "Alan Turing"]);
  const onServer = w.server.items.get(AB).get(ada);
  eq(onServer.fields, { FirstName: "Ada", LastName: "Lovelace", AssistantName: "Charles", JobTitle: "Analyste" }, "what the card cannot say is sent back as the server gave it");
  eq(onServer.children, ["Byron"]);
  assert(!w.server.items.get(AB).has(grace));
  // Settled: nothing more goes, and a restart changes nothing.
  w.restart();
  await w.settle();
  await w.settle();
  eq(w.commands().filter((t) => t !== "Fetch").sort(), ["Add", "Change", "Delete"]);
  eq(w.names(main), ["Ada Lovelace", "Alan Turing"]);
});

test("contacts: a contact that vanished without a word is not deleted on the server", async () => {
  const w = world();
  w.server.addItem(AB, person("Ada", "Lovelace"));
  await w.settle();
  const main = [...(await w.books())][0][0];
  w.tb.vanish(main, w.tb.ids(main)[0]);
  await w.settle();
  eq(w.commands().filter((t) => t !== "Fetch"), []);
  eq(w.serverNames(), ["Ada Lovelace"]);
});

test("contacts: a mass deletion by the server is held until the user confirms", async () => {
  const w = world();
  const ids = Array.from({ length: 60 }, (_, i) => w.server.addItem(AB, person("Contact", String(i).padStart(2, "0"))));
  await w.settle();
  const main = [...(await w.books())][0][0];
  eq(w.tb.ids(main).length, 60);
  for (const sid of ids) w.server.deleteItem(AB, sid);
  const r = await w.settle();
  assert(r.pendingDeletes > 0, "held");
  eq(w.tb.ids(main).length, 60);
  eq(await w.engine.pendingDeletes(), 60);
  await w.settle({ confirmDeletes: true });
  eq(w.tb.ids(main).length, 0);
});

test("contacts: unchecked, the books go and the records are forgotten; the calendar's stay", async () => {
  const w = world();
  const cal = new FakeCalendarApi();
  const calendarStore = new CalendarStore({ mailboxId: MB, ownEmail: OWN, api: cal });
  const pim = new PimSync({ mailbox: w.mailbox, records: w.records, calendarStore, scheduler: new ContactNotices(), log: quietLog(), now: () => w.clock.now });
  w.server.addItem("7", event());
  w.server.addItem(AB, person("Ada", "Lovelace"));
  await pim.pass({ client: w.server, version: "14.1", folders: w.server.folders });
  await w.settle();
  const before = (await w.records.names()).filter((n) => n.startsWith("pim"));
  assert(before.length > 0);
  assert((await w.records.names()).some((n) => n.startsWith("ctPim")));
  w.mailbox.sync.contacts = false;
  await w.settle();
  eq(w.tb.books.size, 0);
  eq((await w.records.names()).filter((n) => n.startsWith("ct") || n.startsWith("ab")), []);
  eq((await w.records.names()).filter((n) => n.startsWith("pim")), before);
  // And the calendar engine never took the contacts' records for its own.
  w.mailbox.sync.contacts = true;
  await w.settle();
  await pim.pass({ client: w.server, version: "14.1", folders: w.server.folders });
  eq(w.tb.books.size, 2);
});

test("contacts: the records of the contact engine have names of their own", async () => {
  const area = memoryArea();
  const records = new Store(area).mailbox(MB);
  const view = contactRecords(records);
  await view.set("pim:7", { a: 1 });
  await view.setMany([["pimOut:7", { b: 2 }]]);
  await view.setMap("pimDeletes", new Map([["x", 1]]));
  await records.set("pim:8", { other: true });
  eq((await records.names()).sort(), ["ctPim:7", "ctPimDeletes", "ctPimOut:7", "pim:8"]);
  eq((await view.names()).sort(), ["pim:7", "pimDeletes", "pimOut:7"]);
  eq(await view.get("pim:7"), { a: 1 });
  eq(await view.get("pim:8", null), null);
  eq([...(await view.getMap("pimDeletes"))], [["x", 1]]);
  await view.removeMany(["pim:7", "pimOut:7"]);
  await view.remove("pimDeletes");
  eq(await records.names(), ["pim:8"]);
});

test("contacts: a change of a contact is never a message", async () => {
  const told = [];
  const notices = new ContactNotices({ notify: (text) => told.push(text) });
  eq(notices.plan({ op: "modify" }), { flow: "plain" });
  notices.notice("readOnly", "Ada", "");
  notices.notice("changesDropped", "", 3);
  notices.notice("inconnu", "Ada");
  eq(told.length, 2);
  await notices.clear();
  await notices.deliver();
});
