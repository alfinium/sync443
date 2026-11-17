// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the address books of a mailbox (src/tb/contact-store.mjs),
 * against a double of Thunderbird's addressBooks and contacts APIs.
 */

import { test, assert, eq, rejects } from "./harness.mjs";
import { ContactStore, ContactStoreError } from "../../src/tb/contact-store.mjs";
import { Store } from "../../src/sync/store.mjs";
import { projectVCard } from "../../src/core/vcard.mjs";
import { memoryArea } from "./journal.test.mjs";
import { FakeAddressBooks, contact } from "./contact-fakes.mjs";

const MB = "0123456789ab";
const COLL = "9";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function world() {
  const tb = new FakeAddressBooks();
  const area = memoryArea();
  const records = new Store(area).mailbox(MB);
  const clock = { now: 1_800_000_000_000 };
  const make = () => new ContactStore({ mailboxId: MB, records, api: tb, now: () => clock.now });
  const store = make();
  const told = [];
  store.onLocalChange((id) => told.push(id));
  const { calendarId: book } = await store.ensureCalendar({ slot: "main", name: "Travail" });
  const put = (serverId, over = {}) => ({ op: "put", collectionId: COLL, serverId, item: contact(over) });
  /** The events of the extension's own writes are over, and the clock is past their echo. */
  const calm = async () => {
    await settle();
    clock.now += 10_000;
    told.length = 0;
  };
  return { tb, area, records, clock, make, store, told, book, put, calm };
}

test("contact store: a book is created once for a slot, and found again after a restart", async () => {
  const w = await world();
  eq(await w.store.ensureCalendar({ slot: "main", name: "Travail" }), { calendarId: w.book, created: false });
  const again = w.make();
  eq(await again.listCalendars(), [{ calendarId: w.book, slot: "main", name: "Travail", events: false, tasks: false }]);
  const other = await again.ensureCalendar({ slot: "12", name: "Fournisseurs" });
  assert(other.created && other.calendarId !== w.book);
  eq((await again.listCalendars()).length, 2);
});

test("contact store: a book that is not this mailbox's is never touched", async () => {
  const w = await world();
  const foreign = await w.tb.addressBooks.create({ name: "Personnel" });
  const id = w.tb.userAdd(foreign, ["FN:Privé"]);
  for (const call of [
    () => w.store.removeCalendar(foreign),
    () => w.store.applyServerChanges(foreign, [w.put("9:1")]),
    () => w.store.readLocalChanges(foreign),
    () => w.store.serverIds(foreign, COLL),
    () => w.store.ackLocalChange(foreign, `a:${id}:0`, {}),
    () => w.store.dropLocalChange(foreign, `a:${id}:0`),
  ]) {
    await rejects(call, (e) => e instanceof ContactStoreError && e.code === "CONFIG");
  }
  eq(w.tb.ids(foreign), [id]);
  // Its events are nobody's here.
  w.tb.userEdit(foreign, id, (l) => [...l, "TITLE:x"]);
  w.tb.userDelete(foreign, id);
  await settle();
  eq(w.told, []);
});

test("contact store: a put creates the contact, a second one rewrites it, and neither is a local change", async () => {
  const w = await world();
  eq(await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada", LastName: "Lovelace", AssistantName: "Charles" } })]), [{ serverId: "9:1", ok: true }]);
  const [id] = w.tb.ids(w.book);
  assert(id.startsWith("sync443-"));
  eq(projectVCard(w.tb.card(w.book, id)).fields.FirstName, "Ada");
  eq(await w.store.serverIds(w.book, COLL), ["9:1"]);
  await settle();
  eq(w.told, [], "the store's own writes are not told as the user's");
  eq(await w.store.readLocalChanges(w.book), { changes: [], rejected: 0 });
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada", LastName: "King" } })]);
  eq(w.tb.ids(w.book), [id]);
  eq(projectVCard(w.tb.card(w.book, id)).fields.LastName, "King");
  eq((await w.store.readLocalChanges(w.book)).changes, []);
});

test("contact store: what Thunderbird does to a card it is given is never a local change", async () => {
  const w = await world();
  // This Thunderbird drops the nickname and rewrites the telephone type.
  w.tb.normalize = (text) => text.split("\r\n").filter((l) => !l.startsWith("NICKNAME")).join("\r\n").replace("TEL;TYPE=cell;VALUE=TEXT", "TEL;VALUE=TEXT");
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada", NickName: "Adi", MobilePhoneNumber: "06" } })]);
  eq((await w.store.readLocalChanges(w.book)).changes, []);
  // A change of the user then sends back what the server holds for what the card lost.
  await w.calm();
  const [id] = w.tb.ids(w.book);
  w.tb.userEdit(w.book, id, (l) => [...l, "TITLE:Analyste"]);
  const { changes } = await w.store.readLocalChanges(w.book);
  eq(changes.length, 1);
  eq(changes[0].item.fields, { FirstName: "Ada", NickName: "Adi", MobilePhoneNumber: "06", JobTitle: "Analyste" });
});

test("contact store: a change of the user is read, acknowledged, and read no more", async () => {
  const w = await world();
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada", Spouse: "William" }, children: ["Byron"] })]);
  await w.calm();
  const [id] = w.tb.ids(w.book);
  w.tb.userEdit(w.book, id, (l) => [...l, "EMAIL:ada@example.com"]);
  await settle();
  eq(w.told, [w.book]);
  const { changes } = await w.store.readLocalChanges(w.book);
  eq(changes.length, 1);
  const c = changes[0];
  eq([c.op, c.kind, c.serverId, c.collectionId, c.problem], ["modify", "contact", "9:1", COLL, null]);
  eq(c.item.fields, { FirstName: "Ada", Spouse: "William", Email1Address: "ada@example.com" });
  eq(c.item.children, ["Byron"]);
  eq(c.previous.fields, { FirstName: "Ada", Spouse: "William" });
  // Read again before the answer: the same change, under the same id.
  eq((await w.store.readLocalChanges(w.book)).changes[0].changeId, c.changeId);
  eq(await w.store.ackLocalChange(w.book, c.changeId, { item: c.item }), true);
  eq((await w.store.readLocalChanges(w.book)).changes, []);
  eq(await w.store.ackLocalChange(w.book, c.changeId, { item: c.item }), false);
});

test("contact store: a contact the user makes is added, bound, then followed", async () => {
  const w = await world();
  await w.calm();
  const id = w.tb.userAdd(w.book, ["FN:Grace Hopper", "N:Hopper;Grace;;;", "TEL;TYPE=work:123"]);
  const { changes } = await w.store.readLocalChanges(w.book);
  eq(changes.length, 1);
  eq([changes[0].op, changes[0].serverId, changes[0].collectionId, changes[0].previous], ["add", null, null, null]);
  eq(changes[0].item.fields, { FileAs: "Grace Hopper", FirstName: "Grace", LastName: "Hopper", BusinessPhoneNumber: "123" });
  eq(changes[0].item.uid, id);
  eq(await w.store.serverIds(w.book, COLL), []);
  eq(await w.store.ackLocalChange(w.book, changes[0].changeId, { serverId: "9:7", collectionId: COLL, item: changes[0].item }), true);
  eq(await w.store.serverIds(w.book, COLL), ["9:7"]);
  eq((await w.store.readLocalChanges(w.book)).changes, []);
  // The server changes it: the same contact is rewritten.
  await w.store.applyServerChanges(w.book, [w.put("9:7", { fields: { FirstName: "Grace", LastName: "Hopper", JobTitle: "Amirale" } })]);
  eq(w.tb.ids(w.book), [id]);
  eq(projectVCard(w.tb.card(w.book, id)).fields.JobTitle, "Amirale");
});

test("contact store: a contact changed again before the answer stays to send", async () => {
  const w = await world();
  await w.calm();
  const id = w.tb.userAdd(w.book, ["FN:Grace"]);
  const first = (await w.store.readLocalChanges(w.book)).changes[0];
  w.tb.userEdit(w.book, id, (l) => [...l, "TITLE:Amirale"]);
  const second = (await w.store.readLocalChanges(w.book)).changes[0];
  assert(second.changeId !== first.changeId, "another change, another id");
  eq(await w.store.ackLocalChange(w.book, first.changeId, { serverId: "9:7", collectionId: COLL, item: first.item }), false);
  eq(await w.store.serverIds(w.book, COLL), ["9:7"], "bound all the same");
  const next = (await w.store.readLocalChanges(w.book)).changes;
  eq([next.length, next[0].op, next[0].serverId], [1, "modify", "9:7"]);
  eq(next[0].item.fields.JobTitle, "Amirale");
  eq(await w.store.ackLocalChange(w.book, next[0].changeId, { item: next[0].item }), true);
  eq((await w.store.readLocalChanges(w.book)).changes, []);
});

test("contact store: a pending change survives a restart with its id, and is acknowledged after it", async () => {
  const w = await world();
  await w.calm();
  w.tb.userAdd(w.book, ["FN:Grace"]);
  const change = (await w.store.readLocalChanges(w.book)).changes[0];
  const again = w.make();
  eq(await again.ackLocalChange(w.book, change.changeId, { serverId: "9:7", collectionId: COLL, item: change.item }), true);
  eq((await again.readLocalChanges(w.book)).changes, []);
  eq(await again.serverIds(w.book, COLL), ["9:7"]);
});

test("contact store: a deletion is sent only when Thunderbird said the user deleted", async () => {
  const w = await world();
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada" } }), w.put("9:2", { fields: { FirstName: "Grace" } })]);
  await w.calm();
  const [ada, grace] = w.tb.ids(w.book);
  w.tb.userDelete(w.book, ada);
  w.tb.vanish(w.book, grace);
  await settle();
  const { changes } = await w.store.readLocalChanges(w.book);
  eq(changes.map((c) => [c.op, c.serverId]), [["delete", "9:1"]]);
  eq(changes[0].previous.fields, { FirstName: "Ada" });
  eq(await w.store.serverIds(w.book, COLL), ["9:1"], "the vanished one is forgotten, the deleted one waits");
  // The deletion survives a restart.
  const again = w.make();
  const replay = (await again.readLocalChanges(w.book)).changes;
  eq(replay.map((c) => c.changeId), [changes[0].changeId]);
  eq(await again.ackLocalChange(w.book, replay[0].changeId), true);
  eq(await again.serverIds(w.book, COLL), []);
  eq((await again.readLocalChanges(w.book)).changes, []);
});

test("contact store: a server removal deletes the contact and is not a deletion of the user", async () => {
  const w = await world();
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada" } })]);
  eq(await w.store.applyServerChanges(w.book, [{ op: "remove", collectionId: COLL, serverId: "9:1" }, { op: "remove", collectionId: COLL, serverId: "9:404" }]), [
    { serverId: "9:1", ok: true },
    { serverId: "9:404", ok: true },
  ]);
  await settle();
  eq(w.tb.ids(w.book), []);
  eq(await w.store.readLocalChanges(w.book), { changes: [], rejected: 0 });
  eq(w.told, []);
});

test("contact store: dropping a change puts the server's version back", async () => {
  const w = await world();
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada", JobTitle: "Analyste" }, picture: "/9j/4AAQSkZJRgABAQ==" }), w.put("9:2", { fields: { FirstName: "Grace" } })]);
  await w.calm();
  const [ada, grace] = w.tb.ids(w.book);
  // A modification.
  w.tb.userEdit(w.book, ada, (l) => l.map((x) => (x.startsWith("TITLE") ? "TITLE:Comtesse" : x)));
  const modify = (await w.store.readLocalChanges(w.book)).changes[0];
  eq(await w.store.dropLocalChange(w.book, modify.changeId), true);
  const back = projectVCard(w.tb.card(w.book, ada));
  eq([back.fields.JobTitle, back.picture], ["Analyste", "/9j/4AAQSkZJRgABAQ=="]);
  eq((await w.store.readLocalChanges(w.book)).changes, []);
  // A deletion.
  await w.calm();
  w.tb.userDelete(w.book, grace);
  await settle();
  const del = (await w.store.readLocalChanges(w.book)).changes[0];
  eq(await w.store.dropLocalChange(w.book, del.changeId), true);
  eq(projectVCard(w.tb.card(w.book, grace)).fields.FirstName, "Grace");
  await settle();
  eq((await w.store.readLocalChanges(w.book)).changes, []);
  eq((await w.store.serverIds(w.book, COLL)).sort(), ["9:1", "9:2"]);
  // An addition: it stays, as a local copy that is no longer followed.
  await w.calm();
  const local = w.tb.userAdd(w.book, ["FN:Locale"]);
  const add = (await w.store.readLocalChanges(w.book)).changes[0];
  eq(await w.store.dropLocalChange(w.book, add.changeId), true);
  assert(w.tb.ids(w.book).includes(local));
  w.tb.userEdit(w.book, local, (l) => [...l, "TITLE:x"]);
  eq((await w.store.readLocalChanges(w.book)).changes, []);
});

test("contact store: a read-only contact, or a locked one, reports its change as a problem", async () => {
  const w = await world();
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada" }, readOnly: "incomplete" }), w.put("9:2", { fields: { FirstName: "Grace" } })]);
  await w.store.applyServerChanges(w.book, [{ op: "lock", collectionId: COLL, serverId: "9:2" }]);
  await w.calm();
  for (const id of w.tb.ids(w.book)) w.tb.userEdit(w.book, id, (l) => [...l, "TITLE:x"]);
  const { changes } = await w.store.readLocalChanges(w.book);
  eq(changes.map((c) => [c.op, c.problem, c.item]), [["modify", "read-only", null], ["modify", "read-only", null]]);
  for (const c of changes) eq(await w.store.dropLocalChange(w.book, c.changeId), true);
  eq((await w.store.readLocalChanges(w.book)).changes, []);
  // A new version from the server unlocks.
  await w.store.applyServerChanges(w.book, [w.put("9:2", { fields: { FirstName: "Grace" } })]);
  await w.calm();
  w.tb.userEdit(w.book, w.tb.ids(w.book)[1], (l) => [...l, "TITLE:y"]);
  eq((await w.store.readLocalChanges(w.book)).changes.map((c) => c.problem), [null]);
});

test("contact store: a detached contact stays in the book and is followed no more", async () => {
  const w = await world();
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada" } })]);
  await w.store.applyServerChanges(w.book, [{ op: "detach", collectionId: COLL, serverId: "9:1" }]);
  await w.calm();
  const [id] = w.tb.ids(w.book);
  eq(await w.store.serverIds(w.book, COLL), []);
  w.tb.userEdit(w.book, id, (l) => [...l, "TITLE:x"]);
  eq((await w.store.readLocalChanges(w.book)).changes, []);
  w.tb.userDelete(w.book, id);
  await settle();
  eq((await w.store.readLocalChanges(w.book)).changes, []);
});

test("contact store: a Change without notes keeps the notes held", async () => {
  const w = await world();
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada" }, description: "à rappeler" })]);
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada", JobTitle: "x" }, description: null })]);
  const [id] = w.tb.ids(w.book);
  eq(projectVCard(w.tb.card(w.book, id)).description, "à rappeler");
});

test("contact store: a put keeps what the user's card holds beyond the contact, and a waiting change gives way", async () => {
  const w = await world();
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada" } })]);
  await w.calm();
  const [id] = w.tb.ids(w.book);
  w.tb.userEdit(w.book, id, (l) => [...l, "X-CUSTOM1:à moi", "TITLE:locale"]);
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada", JobTitle: "serveur" } })]);
  assert(w.tb.card(w.book, id).includes("X-CUSTOM1:à moi"));
  eq(projectVCard(w.tb.card(w.book, id)).fields.JobTitle, "serveur");
  eq((await w.store.readLocalChanges(w.book)).changes, []);
});

test("contact store: a card too large for a contact is a problem, not a crash", async () => {
  const w = await world();
  await w.calm();
  w.tb.userAdd(w.book, ["FN:Photo", `PHOTO;VALUE=URL:data:image/jpeg;base64,${"A".repeat(200_004)}`]);
  w.tb.userAdd(w.book, ["FN:Normale"]);
  const { changes } = await w.store.readLocalChanges(w.book);
  eq(changes.map((c) => c.problem).sort(), [null, "too-large"].sort());
});

test("contact store: removing a book forgets everything kept for it", async () => {
  const w = await world();
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada" } })]);
  eq(await w.store.removeCalendar(w.book), true);
  await settle();
  eq(w.tb.books.has(w.book), false);
  eq((await w.records.names()).filter((n) => n.startsWith("ab")), []);
  eq(await w.store.listCalendars(), []);
  eq(w.told, []);
});

test("contact store: a book the user deleted is forgotten, and made again when asked", async () => {
  const w = await world();
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada" } })]);
  await w.calm();
  w.tb.userDeleteBook(w.book);
  await settle();
  eq(w.told, [w.book]);
  eq(await w.store.listCalendars(), []);
  const made = await w.store.ensureCalendar({ slot: "main", name: "Travail" });
  assert(made.created && made.calendarId !== w.book);
  eq(await w.store.serverIds(made.calendarId, COLL), []);
});

test("contact store: damaged records are read as far as they are valid", async () => {
  const w = await world();
  await w.store.applyServerChanges(w.book, [w.put("9:1", { fields: { FirstName: "Ada" } })]);
  for (const name of await w.records.names()) if (name.startsWith("abItems:")) await w.records.set(name, [["x", { s: "9:9", c: null }], ["y", 3], "z"]);
  const again = w.make();
  eq(await again.serverIds(w.book, COLL), []);
  eq((await again.readLocalChanges(w.book)).changes.length, 1, "the contact is there, and no longer known: it is the user's");
});

test("contact store: invalid arguments are refused", async () => {
  const w = await world();
  await rejects(() => w.store.ensureCalendar({ slot: "", name: "x" }));
  await rejects(() => w.store.ensureCalendar({ slot: "main", name: "" }));
  await rejects(() => w.store.applyServerChanges(w.book, [{ op: "put", collectionId: COLL, serverId: "9:1" }]));
  await rejects(() => w.store.applyServerChanges(w.book, [{ op: "erase", collectionId: COLL, serverId: "9:1" }]));
  await rejects(() => w.store.ackLocalChange(w.book, "x", {}));
  await rejects(() => w.store.dropLocalChange(w.book, "m:id"));
  eq(await w.store.applyServerChanges(w.book, [{ op: "put", collectionId: COLL, serverId: "9:1", item: { kind: "task" } }]), [{ serverId: "9:1", ok: false, code: "INVALID" }]);
});
