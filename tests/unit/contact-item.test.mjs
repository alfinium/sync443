// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the contact conversion against [MS-ASCNTC] (the properties of
 * the Contacts and Contacts2 namespaces, Children, Categories, Picture),
 * [MS-ASAIRS] (Body) and the contact description of contact-item.mjs.
 * ApplicationData is built, encoded to WBXML and decoded again, then read
 * through protocol.parseSync, as it arrives from a server.
 */

import { test, assert, eq, throws } from "./harness.mjs";
import { CONTACT_FIELDS, PICTURE_MAX, CHILDREN_MAX, contactOptions, contactSupported, readContact, writeContact, checkContact, displayName, dayOfInstant } from "../../src/core/contact-item.mjs";
import { el, encode, decode, text } from "../../src/core/wbxml.mjs";
import { parseSync, syncRequest, ProtocolError } from "../../src/core/protocol.mjs";

const hasCode = (code) => (e) => e instanceof ProtocolError && e.code === code;
const isBadItem = hasCode("BAD_ITEM");
const ch = (...codes) => String.fromCharCode(...codes);

function received(children) {
  const doc = el("AirSync:Sync", [
    el("Collections", [
      el("Collection", [
        el("SyncKey", "2"),
        el("CollectionId", "7"),
        el("Status", "1"),
        el("Commands", [el("Add", [el("ServerId", "7:1"), el("ApplicationData", children)])]),
      ]),
    ]),
  ]);
  return parseSync(decode(encode(doc))).collections[0].commands[0].data;
}

const C = (tag, content) => el(`Contacts:${tag}`, content);
const C2 = (tag, content) => el(`Contacts2:${tag}`, content);
const A = (tag, content) => el(`AirSyncBase:${tag}`, content);
const body = (type, data) => A("Body", [A("Type", type), data === undefined ? null : A("Data", data)]);
const read = (children, options = {}) => readContact(received(children), { version: "14.1", fallbackUid: "contact-1", ...options });
const names = (nodes) => nodes.map((n) => `${n.ns}:${n.tag}`);
const valueOf = (nodes, name) => {
  const node = nodes.find((n) => `${n.ns}:${n.tag}` === name);
  return node ? text(node) : undefined;
};

const EMPTY = Object.freeze({
  kind: "contact",
  uid: "contact-1",
  summary: "",
  description: "",
  categories: [],
  children: [],
  fields: {},
  birthday: null,
  birthdayAt: null,
  anniversary: null,
  anniversaryAt: null,
  picture: null,
  readOnly: null,
});

test("contact: an empty contact reads as the empty description", () => {
  eq(read([]), EMPTY);
});

test("contact: every text property of both namespaces is read and written back", () => {
  const children = CONTACT_FIELDS.map((f, i) => el(`${f.ns}:${f.tag}`, `valeur ${i}`));
  const contact = read(children);
  eq(Object.keys(contact.fields).length, CONTACT_FIELDS.length);
  for (const [i, f] of CONTACT_FIELDS.entries()) eq(contact.fields[f.tag], `valeur ${i}`);
  eq(contact.readOnly, null);
  const written = writeContact(contact, { version: "14.1", previous: contact });
  eq(names(written), CONTACT_FIELDS.map((f) => `${f.ns}:${f.tag}`));
  eq(read(written), contact);
});

test("contact: the table names each property once, and Supported lists all that is written", () => {
  eq(new Set(CONTACT_FIELDS.map((f) => f.tag)).size, CONTACT_FIELDS.length);
  const supported = contactSupported();
  eq(new Set(supported).size, supported.length);
  for (const f of CONTACT_FIELDS) assert(supported.includes(`${f.ns}:${f.tag}`));
  for (const tag of ["Categories", "Children", "Birthday", "Anniversary"]) assert(supported.includes(`Contacts:${tag}`));
  // A Change without a picture must leave the server's picture alone.
  assert(!supported.includes("Contacts:Picture"));
  // The protocol layer accepts the list as it is.
  syncRequest([{ collectionId: "7", syncKey: "0", supported }]);
});

test("contact: the name shown is made of the names, then FileAs, nickname, company, address", () => {
  eq(displayName({ FirstName: "Ada", MiddleName: "M.", LastName: "Lovelace", FileAs: "Lovelace, Ada" }), "Ada M. Lovelace");
  eq(displayName({ FileAs: "Lovelace, Ada", CompanyName: "Analytical" }), "Lovelace, Ada");
  eq(displayName({ NickName: "Ada", CompanyName: "Analytical" }), "Ada");
  eq(displayName({ CompanyName: "Analytical", Email1Address: "ada@example.com" }), "Analytical");
  eq(displayName({ Email1Address: "ada@example.com" }), "ada@example.com");
  eq(displayName({}), "");
  eq(displayName(null), "");
  eq(read([C("FirstName", "Ada"), C("LastName", "Lovelace")]).summary, "Ada Lovelace");
});

test("contact: an address given with a name keeps the address only", () => {
  const contact = read([C("Email1Address", '"Ada Lovelace" <ada@example.com>'), C("Email2Address", "Ada <ada2@example.com>"), C("Email3Address", "ada3@example.com")]);
  eq(contact.fields, { Email1Address: "ada@example.com", Email2Address: "ada2@example.com", Email3Address: "ada3@example.com" });
  eq(contact.readOnly, null);
  eq(valueOf(writeContact(contact, { version: "14.1", previous: contact }), "Contacts:Email1Address"), "ada@example.com");
});

test("contact: an address that is not an e-mail address is kept as it is", () => {
  const x500 = "/o=Example/ou=Exchange/cn=Recipients/cn=ada";
  eq(read([C("Email1Address", x500)]).fields.Email1Address, x500);
});

test("contact: notes, categories and children", () => {
  const contact = read([
    body("1", "Première ligne\nseconde ligne"),
    C("Categories", [C("Category", "Amis"), C("Category", "Travail")]),
    C("Children", [C("Child", "Byron"), C("Child", "Anne")]),
  ]);
  eq(contact.description, "Première ligne\nseconde ligne");
  eq(contact.categories, ["Amis", "Travail"]);
  eq(contact.children, ["Byron", "Anne"]);
  const written = writeContact(contact, { version: "14.1" });
  eq(read(written), contact);
});

test("contact: the notes are sent only when they changed", () => {
  const contact = read([body("1", "notes"), C("FirstName", "Ada")]);
  assert(!names(writeContact(contact, { version: "14.1", previous: contact })).includes("AirSyncBase:Body"));
  assert(names(writeContact({ ...contact, description: "autres" }, { version: "14.1", previous: contact })).includes("AirSyncBase:Body"));
  assert(names(writeContact(contact, { version: "14.1" })).includes("AirSyncBase:Body"));
});

test("contact: a Change without a Body leaves the notes unsaid", () => {
  eq(read([C("FirstName", "Ada")], { change: true }).description, null);
  eq(read([C("FirstName", "Ada")]).description, "");
  eq(read([C("FirstName", "Ada"), body("1", "x")], { change: true }).description, "x");
});

test("contact: a street keeps its lines, any other property is one line", () => {
  const contact = read([C("HomeAddressStreet", "1 rue Haute\r\nBâtiment B"), C("HomeAddressCity", "Ville\nBasse")]);
  assert(contact.fields.HomeAddressStreet.includes("\n"));
  assert(!contact.fields.HomeAddressCity.includes("\n"));
});

test("contact: a birthday is the day meant, and its instant is given back unchanged", () => {
  // Midnight UTC, and midnight two hours east of Greenwich: both mean the 15th.
  for (const instant of ["1980-05-15T00:00:00.000Z", "1980-05-14T22:00:00.000Z", "1980-05-15T05:00:00.000Z"]) {
    const contact = read([C("Birthday", instant), C("Anniversary", "2010-06-01T00:00:00.000Z")]);
    eq(contact.birthday, "1980-05-15");
    eq(contact.anniversary, "2010-06-01");
    const written = writeContact(contact, { version: "14.1", previous: contact });
    eq(valueOf(written, "Contacts:Birthday"), instant);
    eq(valueOf(written, "Contacts:Anniversary"), "2010-06-01T00:00:00.000Z");
  }
});

test("contact: an instant at noon UTC is the day it is in UTC", () => {
  eq(dayOfInstant(Date.UTC(1980, 4, 15, 12, 0, 0)) >= "1980-05-15", true);
  // Unless noon UTC is midnight on this computer, noon is that day, and one minute later the next.
  if (new Date(Date.UTC(1980, 4, 15, 12, 0, 0)).getHours() !== 0) eq(dayOfInstant(Date.UTC(1980, 4, 15, 12, 0, 0)), "1980-05-15");
});

test("contact: a day changed here is written as midnight of that day on this computer", () => {
  const contact = read([C("Birthday", "1980-05-14T22:00:00.000Z")]);
  const changed = checkContact({ ...contact, birthday: "1980-05-20" });
  eq(changed.birthdayAt, null); // the instant kept meant another day
  const written = valueOf(writeContact(changed, { version: "14.1", previous: contact }), "Contacts:Birthday");
  const ms = Date.parse(written);
  eq(new Date(ms).getHours(), 0);
  eq(dayOfInstant(ms), "1980-05-20");
  eq(read([C("Birthday", written)]).birthday, "1980-05-20");
});

test("contact: a date that cannot be read or held makes the contact read-only", () => {
  eq(read([C("Birthday", "hier")]).readOnly, "incomplete");
  eq(read([C("Birthday", "hier")]).birthday, null);
  const old = read([C("Birthday", "1604-01-01T00:00:00.000Z")]);
  eq(old.birthday, null);
  eq(old.readOnly, "incomplete");
  eq(read([C("Birthday", "")]).readOnly, null);
});

test("contact: a picture is carried as it came", () => {
  const picture = "/9j/4AAQSkZJRgABAQ==";
  const contact = read([C("Picture", picture)]);
  eq(contact.picture, picture);
  eq(valueOf(writeContact(contact, { version: "14.1", previous: contact }), "Contacts:Picture"), picture);
});

test("contact: a picture that is not base64, or too large, makes the contact read-only", () => {
  for (const bad of ["pas du base64 !", "abc", "A".repeat(PICTURE_MAX + 4)]) {
    const contact = read([C("Picture", bad)]);
    eq(contact.picture, null);
    eq(contact.readOnly, "incomplete");
  }
});

test("contact: a text cut or cleaned of a hidden character makes the contact read-only", () => {
  eq(read([C("FirstName", "A".repeat(300))]).readOnly, "incomplete");
  eq(read([C("FirstName", "A".repeat(300))]).fields.FirstName.length, 256);
  eq(read([C("LastName", `Love${ch(0x202e)}lace`)]).readOnly, "incomplete");
  eq(read([C("LastName", `Love${ch(0x202e)}lace`)]).fields.LastName, "Lovelace");
  eq(read([C("Children", Array.from({ length: CHILDREN_MAX + 1 }, (_, i) => C("Child", `e${i}`)))]).readOnly, "incomplete");
  eq(read([body("2", "<p>html</p>")]).readOnly, "incomplete");
});

test("contact: a read-only contact is never written", () => {
  const contact = read([C("FirstName", "A".repeat(300))]);
  throws(() => writeContact(contact, { version: "14.1" }), hasCode("READ_ONLY_ITEM"));
});

test("contact: a doubled property is refused, unknown ones are ignored", () => {
  throws(() => read([C("FirstName", "a"), C("FirstName", "b")]), isBadItem);
  throws(() => read([C2("NickName", "a"), C2("NickName", "b")]), isBadItem);
  eq(read([C("Alias", "ada"), C("WeightedRank", "3"), el("Tasks:Subject", "x")]), EMPTY);
});

test("contact: checkContact refuses what is not a contact description", () => {
  const good = read([C("FirstName", "Ada")]);
  eq(checkContact(good), good);
  for (const bad of [
    null,
    { ...good, kind: "task" },
    { ...good, uid: "" },
    { ...good, fields: null },
    { ...good, fields: { FirstName: 3 } },
    { ...good, fields: { Unknown: "x" } },
    { ...good, description: null },
    { ...good, categories: "a" },
    { ...good, children: [3] },
    { ...good, birthday: "15 mai" },
    { ...good, picture: "pas du base64" },
    { ...good, readOnly: "other" },
  ]) {
    throws(() => checkContact(bad), isBadItem);
  }
  eq(checkContact({ ...good, description: null }, { fromServer: true }).description, null);
});

test("contact: checkContact drops empty properties and computes the summary itself", () => {
  const contact = checkContact({ ...EMPTY, summary: "autre chose", fields: { FirstName: "  Ada ", LastName: "", Email1Address: "Ada <ada@example.com>" } });
  eq(contact.fields, { FirstName: "Ada", Email1Address: "ada@example.com" });
  eq(contact.summary, "Ada");
  assert(Object.isFrozen(contact) && Object.isFrozen(contact.fields) && Object.isFrozen(contact.categories) && Object.isFrozen(contact.children));
});

test("contact: an empty property deletes it: it is left out of what is written", () => {
  const before = read([C("FirstName", "Ada"), C("JobTitle", "Analyste")]);
  const after = checkContact({ ...before, fields: { FirstName: "Ada" } });
  eq(names(writeContact(after, { version: "14.1", previous: before })), ["Contacts:FirstName"]);
});

test("contact: the options ask for the notes as plain text, with no period", () => {
  eq(names(contactOptions()), ["AirSyncBase:BodyPreference"]);
});

test("contact: a version that is not supported is refused", () => {
  throws(() => read([], { version: "2.5" }));
  throws(() => writeContact(EMPTY, { version: "16.1" }));
});
