// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Address book end-to-end scenario, run inside a headless Thunderbird by
 * tests/e2e/contacts/run_contacts_test.py, in two phases (two launches on
 * the same throw-away profile). The real src/tb/contact-store.mjs works on
 * Thunderbird's own addressBooks and contacts APIs, with the real record
 * store (src/sync/store.mjs) on the extension's storage.
 *
 * The user is played through the same APIs, as Thunderbird's address book
 * window uses the same cards. Lines are printed as the calendar test
 * prints them (its helper experiment is reused for print, phase and quit).
 */

import { ContactStore } from "./src/tb/contact-store.mjs";
import { Store } from "./src/sync/store.mjs";
import { projectVCard, MAPPED_FIELDS } from "./src/core/vcard.mjs";

const T = browser.sync443CalendarTest;
const MB = "a1b2c3d4e5f6";
const COLL = "9";
const PICTURE = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeJson = (value) => JSON.stringify(value ?? null).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
let failures = 0;
const emit = (kind, value) => T.print(`SYNC443CALENDAR-${kind} ${escapeJson(value)}`);
async function check(label, ok, detail) {
  if (!ok) failures++;
  await emit("CHECK", { label, ok: !!ok, detail: detail === undefined ? null : detail });
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const contact = (over = {}) => ({ kind: "contact", uid: "x", description: "", categories: [], children: [], fields: {}, birthday: null, anniversary: null, picture: null, readOnly: null, ...over });
const put = (serverId, over) => ({ op: "put", collectionId: COLL, serverId, item: contact(over) });
const cardOf = async (id) => (await browser.contacts.get(id)).properties.vCard;
const said = async (id) => projectVCard(await cardOf(id));
const card = (...lines) => ["BEGIN:VCARD", "VERSION:4.0", ...lines, "END:VCARD", ""].join("\r\n");

function world() {
  const records = new Store(browser.storage.local).mailbox(MB);
  const store = new ContactStore({ mailboxId: MB, records });
  const told = [];
  store.onLocalChange((id) => told.push(id));
  return { records, store, told };
}

async function phase1() {
  const info = await browser.runtime.getBrowserInfo();
  await emit("INFO", { probe: { version: info.version } });
  const w = world();
  const foreign = await browser.addressBooks.create({ name: "Carnet personnel" });
  const mine = await browser.contacts.create(foreign, null, { vCard: card("FN:Privé", "EMAIL:prive@example.org") });
  const before = (await browser.addressBooks.list()).map((b) => b.id);

  const made = await w.store.ensureCalendar({ slot: "main", name: "Travail (Sync443)" });
  const book = made.calendarId;
  const listed = await browser.addressBooks.list();
  await check("a book is made for the mailbox, under its name", made.created === true && listed.find((b) => b.id === book)?.name === "Travail (Sync443)" && !before.includes(book), listed.map((b) => b.name));
  await check("asked again, the same book is given", same(await w.store.ensureCalendar({ slot: "main", name: "Travail (Sync443)" }), { calendarId: book, created: false }));

  // A contact that fills every place a card has.
  const fields = {};
  for (const tag of MAPPED_FIELDS) fields[tag] = tag.includes("Email") ? `${tag.toLowerCase()}@example.com` : tag.includes("Phone") || tag.includes("Fax") || tag.includes("Pager") ? `+33 1 00 ${MAPPED_FIELDS.indexOf(tag)}` : `v ${tag}`;
  fields.WebPage = "https://example.com/ada";
  fields.HomeAddressStreet = "1 rue Haute\nBâtiment B";
  fields.CompanyName = "Analytical; Engines, Ltd";
  fields.JobTitle = "Analyste; mathématicienne, comtesse";
  const full = { fields: { ...fields, AssistantName: "Charles", Spouse: "William" }, children: ["Byron"], description: "ligne 1\nligne 2; avec, des signes", categories: ["Amis", "Travail"], birthday: "1980-05-15", anniversary: "2010-06-01", picture: PICTURE };
  const results = await w.store.applyServerChanges(book, [put("9:1", full), put("9:2", { fields: { FirstName: "Grace", LastName: "Hopper" } }), put("9:3", { fields: { CompanyName: "Analytical Engines" } })]);
  await check("three contacts of the server are written", same(results.map((r) => r.ok), [true, true, true]), results);
  const nodes = await browser.contacts.list(book);
  await check("they are in the book, under ids of ours", nodes.length === 3 && nodes.every((n) => n.id.startsWith("sync443-") && n.parentId === book), nodes.map((n) => n.id));
  const byName = async (name) => (await browser.contacts.list(book)).find((n) => projectVCard(n.properties.vCard)?.fields.FileAs === name)?.id ?? null;
  const ada = await byName("v FileAs");
  const p = ada ? await said(ada) : null;
  const lost = p ? MAPPED_FIELDS.filter((tag) => p.fields[tag] !== fields[tag]) : ["?"];
  await check("Thunderbird keeps every property a card can say", lost.length === 0, lost.map((tag) => [tag, p?.fields[tag]]));
  await check("… and the notes, the categories, the dates and the picture", p && p.description === full.description && same(p.categories, full.categories) && p.birthday === full.birthday && p.anniversary === full.anniversary && p.picture === PICTURE,
    p && { d: p.description, c: p.categories, b: p.birthday, a: p.anniversary, pic: p.picture === PICTURE });
  await check("a contact without a name is shown under its company", (await byName("Analytical Engines")) !== null);
  await sleep(600);
  const quiet = await w.store.readLocalChanges(book);
  await check("what the store wrote is not a change of the user, whatever Thunderbird made of the cards", quiet.changes.length === 0 && quiet.rejected === 0, quiet.changes.map((c) => [c.op, c.item?.fields]));
  await check("… and its own writes were not told as the user's", w.told.length === 0, w.told);
  await check("the ids of the server are held", same((await w.store.serverIds(book, COLL)).sort(), ["9:1", "9:2", "9:3"]));

  // The user edits a contact.
  await sleep(5200); // past the echo of the store's own writes
  const grace = await byName("Grace Hopper");
  await browser.contacts.update(grace, { vCard: (await cardOf(grace)).replace("END:VCARD", "TITLE:Amirale\r\nX-CUSTOM1:à moi\r\nEND:VCARD") });
  await sleep(600);
  await check("a change of the user is told", w.told.includes(book), w.told);
  let { changes } = await w.store.readLocalChanges(book);
  await check("… and read as one modification, with what the server holds", changes.length === 1 && changes[0].op === "modify" && changes[0].serverId === "9:2" && same(changes[0].item.fields, { FirstName: "Grace", LastName: "Hopper", JobTitle: "Amirale" }), changes.map((c) => [c.op, c.serverId, c.item?.fields]));
  await check("acknowledged, it is read no more", (await w.store.ackLocalChange(book, changes[0].changeId, { item: changes[0].item })) === true && (await w.store.readLocalChanges(book)).changes.length === 0);

  // The server changes the same contact: what the card holds beyond the contact stays.
  await w.store.applyServerChanges(book, [put("9:2", { fields: { FirstName: "Grace", LastName: "Hopper", JobTitle: "Contre-amirale" } })]);
  const after = await cardOf(grace);
  await check("a change of the server rewrites the card and keeps the user's own properties", projectVCard(after).fields.JobTitle === "Contre-amirale" && /X-CUSTOM1:/.test(after), after);
  await check("… without a local change", (await w.store.readLocalChanges(book)).changes.length === 0);

  // The user makes a contact.
  const alan = await browser.contacts.create(book, null, { vCard: card("FN:Alan Turing", "N:Turing;Alan;;;", "EMAIL:alan@example.com", "TEL;TYPE=work:123") });
  await sleep(600);
  changes = (await w.store.readLocalChanges(book)).changes;
  await check("a contact the user makes is an addition", changes.length === 1 && changes[0].op === "add" && changes[0].item.uid === alan && same(changes[0].item.fields, { FileAs: "Alan Turing", FirstName: "Alan", LastName: "Turing", Email1Address: "alan@example.com", BusinessPhoneNumber: "123" }), changes.map((c) => [c.op, c.item?.fields]));
  await check("bound to the server's id, it is followed", (await w.store.ackLocalChange(book, changes[0].changeId, { serverId: "9:7", collectionId: COLL, item: changes[0].item })) === true && (await w.store.serverIds(book, COLL)).includes("9:7") && (await w.store.readLocalChanges(book)).changes.length === 0);

  // The user deletes a contact; the server refuses: it comes back.
  const company = await byName("Analytical Engines");
  await browser.contacts.delete(company);
  await sleep(600);
  changes = (await w.store.readLocalChanges(book)).changes;
  await check("a contact the user deletes is a deletion", changes.length === 1 && changes[0].op === "delete" && changes[0].serverId === "9:3", changes.map((c) => [c.op, c.serverId]));
  await check("undone, the contact is back under its id", (await w.store.dropLocalChange(book, changes[0].changeId)) === true && (await said(company))?.fields.CompanyName === "Analytical Engines");
  await sleep(600);
  await check("… and nothing is left to send", (await w.store.readLocalChanges(book)).changes.length === 0);

  // A removal by the server.
  await w.store.applyServerChanges(book, [{ op: "remove", collectionId: COLL, serverId: "9:3" }]);
  await sleep(600);
  await check("a removal by the server deletes the contact, and is not a deletion of the user", (await byName("Analytical Engines")) === null && (await w.store.readLocalChanges(book)).changes.length === 0);

  // A read-only contact.
  await w.store.applyServerChanges(book, [put("9:8", { fields: { FirstName: "Lecture", LastName: "Seule" }, readOnly: "incomplete" })]);
  const locked = await byName("Lecture Seule");
  await sleep(5200);
  await browser.contacts.update(locked, { vCard: (await cardOf(locked)).replace("END:VCARD", "TITLE:interdit\r\nEND:VCARD") });
  changes = (await w.store.readLocalChanges(book)).changes;
  await check("a change to a read-only contact is reported as a problem", changes.length === 1 && changes[0].problem === "read-only" && changes[0].item === null, changes.map((c) => [c.op, c.problem]));
  await check("… and undone: the server's version is back", (await w.store.dropLocalChange(book, changes[0].changeId)) === true && (await said(locked)).fields.JobTitle === undefined && (await w.store.readLocalChanges(book)).changes.length === 0);

  // Left for the second phase: a modification and a deletion that wait.
  await sleep(5200);
  await browser.contacts.update(ada, { vCard: (await cardOf(ada)).replace(/TITLE:[^\r\n]*/, "TITLE:Comtesse") });
  await browser.contacts.delete(alan);
  await sleep(600);
  changes = (await w.store.readLocalChanges(book)).changes;
  await check("two changes wait when Thunderbird quits", same(changes.map((c) => c.op).sort(), ["delete", "modify"]), changes.map((c) => c.op));
  const modify = changes.find((c) => c.op === "modify");
  await check("the modification keeps what the card cannot say", modify?.item.fields.AssistantName === "Charles" && modify.item.fields.Spouse === "William" && same(modify.item.children, ["Byron"]) && modify.item.fields.JobTitle === "Comtesse" && modify.item.picture === PICTURE,
    modify && { f: modify.item.fields.JobTitle, a: modify.item.fields.AssistantName, pic: modify.item.picture === PICTURE });
  await browser.storage.local.set({ e2e: { book, foreign, mine, ids: changes.map((c) => c.changeId).sort() } });
}

async function phase2() {
  const { e2e } = await browser.storage.local.get("e2e");
  const { book, foreign, mine } = e2e;
  const w = world();
  await check("after a restart the book is still the mailbox's", same((await w.store.listCalendars()).map((c) => [c.calendarId, c.slot]), [[book, "main"]]));
  const { changes } = await w.store.readLocalChanges(book);
  await check("the changes that waited are read again under the same ids", same(changes.map((c) => c.changeId).sort(), e2e.ids), [changes.map((c) => c.changeId), e2e.ids]);
  for (const c of changes) await w.store.ackLocalChange(book, c.changeId, c.op === "delete" ? {} : { item: c.item });
  await check("acknowledged, nothing waits", (await w.store.readLocalChanges(book)).changes.length === 0);
  await check("the deleted contact is no longer held", !(await w.store.serverIds(book, COLL)).includes("9:7"));

  // The user removes a contact while nothing listens: it is forgotten, never deleted on the server.
  await check("a book that is not the mailbox's is refused", (await w.store.readLocalChanges(foreign).then(() => "read", (e) => e.code)) === "CONFIG");
  await check("removing the mailbox's books deletes the book", (await w.store.removeCalendar(book)) === true && !(await browser.addressBooks.list()).some((b) => b.id === book));
  await sleep(600);
  await check("… and tells nobody of a change", w.told.length === 0, w.told);
  const names = await w.records.names();
  await check("nothing is kept for it", names.filter((n) => n.startsWith("ab")).length === 0, names);
  const left = await browser.contacts.list(foreign);
  await check("the user's own book and its contact are untouched", left.length === 1 && left[0].id === mine && /prive@example\.org/.test(left[0].properties.vCard), left.map((n) => n.id));
}

async function run() {
  const phase = await T.phase();
  try {
    if (phase === 1) await phase1();
    else await phase2();
  } catch (e) {
    await emit("CRASH", { phase, error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  }
  await emit("DONE", { phase, failures });
  await T.quit();
}

run().catch(async (e) => {
  await emit("CRASH", { error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  await T.quit();
});
