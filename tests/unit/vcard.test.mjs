// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the vCard conversion (src/core/vcard.mjs) against RFC 6350, the
 * forms RFC 2426 writes, and the contact description of contact-item.mjs.
 */

import { test, assert, eq } from "./harness.mjs";
import { parseVCard, projectVCard, buildVCard, mergeLocal, sameProjection, uidOfVCard, MAPPED_FIELDS, VCARD_MAX } from "../../src/core/vcard.mjs";
import { checkContact, CONTACT_FIELDS } from "../../src/core/contact-item.mjs";

const contact = (over = {}) =>
  checkContact({
    kind: "contact",
    uid: "c-1",
    description: "",
    categories: [],
    children: [],
    fields: {},
    birthday: null,
    anniversary: null,
    picture: null,
    readOnly: null,
    ...over,
  });
const card = (...lines) => ["BEGIN:VCARD", "VERSION:4.0", ...lines, "END:VCARD", ""].join("\r\n");
const EMPTY = { fields: {}, categories: [], description: "", birthday: null, anniversary: null, picture: null };

test("vcard: every mapped property goes to a card and comes back", () => {
  const fields = {};
  for (const tag of MAPPED_FIELDS) fields[tag] = `v ${tag}`;
  const c = contact({
    fields,
    description: "ligne 1\nligne 2; avec, des signes \\",
    categories: ["Amis", "Tra,vail"],
    birthday: "1980-05-15",
    anniversary: "2010-06-01",
    picture: "/9j/4AAQSkZJRgABAQ==",
  });
  const p = projectVCard(buildVCard(c));
  eq(p.fields, fields);
  eq(p.description, c.description);
  eq(p.categories, ["Amis", "Tra,vail"]);
  eq(p.birthday, "1980-05-15");
  eq(p.anniversary, "2010-06-01");
  eq(p.picture, c.picture);
});

test("vcard: the card carries its UID, FN is what the contact is filed as, or its name", () => {
  const text = buildVCard(contact({ fields: { FirstName: "Ada", LastName: "Lovelace" } }));
  eq(uidOfVCard(text), "c-1");
  assert(text.includes("\r\nFN:Ada Lovelace\r\n"));
  assert(text.includes("\r\nN:Lovelace;Ada;;;\r\n"));
  assert(buildVCard(contact({ fields: { FirstName: "Ada", FileAs: "Lovelace, Ada" } })).includes("\r\nFN:Lovelace\\, Ada\r\n"));
  assert(text.startsWith("BEGIN:VCARD\r\nVERSION:4.0\r\n") && text.endsWith("END:VCARD\r\n"));
});

test("vcard: a value from the server never ends its property", () => {
  const evil = "x\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:autre";
  const text = buildVCard(contact({ fields: { FirstName: evil, HomeAddressStreet: "1 rue\nTEL:123", CompanyName: "a;b,c" }, description: evil, categories: ["a\nb"] }));
  eq(text.split("\r\n").filter((l) => l === "END:VCARD").length, 1);
  eq(text.split("\r\n").filter((l) => l.startsWith("TEL")).length, 0);
  const p = projectVCard(text);
  eq(p.fields.CompanyName, "a;b,c");
  eq(p.fields.HomeAddressStreet, "1 rue\nTEL:123");
});

test("vcard: what Thunderbird writes is read (types, folded lines, groups, vCard 3.0)", () => {
  const p = projectVCard(
    card(
      "FN:Ada Lovelace",
      "N:Lovelace;Ada;Augusta,King;Lady;",
      "item1.EMAIL;TYPE=work:ada@example.com",
      "EMAIL;PREF=1:first@example.com",
      "TEL;TYPE=work;VALUE=TEXT:+33 1 00 00 00 00",
      "TEL;TYPE=\"work,voice\":+33 1 00 00 00 01",
      "TEL;WORK:+33 1 00 00 00 02",
      "TEL;TYPE=cell;VALUE=uri:tel:+33600000000",
      "TEL;TYPE=fax:+33 1 00 00 00 03",
      "TEL;TYPE=HOME,FAX:+33 1 00 00 00 04",
      "TEL:+33 1 00 00 00 05",
      "ADR;TYPE=work:;;1 rue Haute\\nBât. B;Paris;IDF;75001;France",
      "ADR:PO 12;;2 rue Basse;Lyon;;69001;",
      "ORG:Analytical;Engines;Research",
      "NOTE:une note bien long",
      " ue",
      "BDAY:1815-12-10",
      "ANNIVERSARY;VALUE=DATE:19350708",
      "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ",
      "CATEGORIES:a,b",
      "CATEGORIES:c",
    ),
  );
  eq(p.fields.FileAs, "Ada Lovelace");
  eq([p.fields.LastName, p.fields.FirstName, p.fields.MiddleName, p.fields.Title], ["Lovelace", "Ada", "Augusta King", "Lady"]);
  eq([p.fields.Email1Address, p.fields.Email2Address], ["first@example.com", "ada@example.com"]);
  eq([p.fields.BusinessPhoneNumber, p.fields.Business2PhoneNumber], ["+33 1 00 00 00 00", "+33 1 00 00 00 01"]);
  eq(p.fields.MobilePhoneNumber, "+33600000000");
  eq([p.fields.BusinessFaxNumber, p.fields.HomeFaxNumber], ["+33 1 00 00 00 03", "+33 1 00 00 00 04"]);
  eq(p.fields.HomePhoneNumber, undefined);
  eq(p.fields.BusinessAddressStreet, "1 rue Haute\nBât. B");
  eq([p.fields.BusinessAddressCity, p.fields.BusinessAddressState, p.fields.BusinessAddressPostalCode, p.fields.BusinessAddressCountry], ["Paris", "IDF", "75001", "France"]);
  eq(p.fields.OtherAddressStreet, "PO 12\n2 rue Basse");
  eq([p.fields.CompanyName, p.fields.Department], ["Analytical", "Engines Research"]);
  eq(p.description, "une note bien longue");
  eq(p.birthday, null); // before 1900: not a day the description holds
  eq(p.anniversary, "1935-07-08");
  eq(p.picture, "/9j/4AAQ");
  eq(p.categories, ["a", "b", "c"]);
});

test("vcard: what is no card is refused", () => {
  for (const bad of [null, 3, "", "FN:Ada", "BEGIN:VCARD\r\nFN:Ada\r\n", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", `BEGIN:VCARD\r\nNOTE:${"x".repeat(VCARD_MAX)}\r\nEND:VCARD\r\n`]) {
    eq(parseVCard(bad), null);
    eq(projectVCard(bad), null);
  }
  eq(projectVCard(card()), EMPTY);
});

test("vcard: only the first card of a text is read", () => {
  const p = projectVCard(`${card("FN:Une")}${card("FN:Deux", "TITLE:x")}`);
  eq(p.fields, { FileAs: "Une" });
});

test("vcard: a picture given as a link, a birthday without a year, are not values of the contact", () => {
  const p = projectVCard(card("PHOTO:https://example.com/a.jpg", "BDAY:--0515", "PHOTO;VALUE=URL:data:image/png;base64,iVBORw0KGgo="));
  eq(p.birthday, null);
  eq(p.picture, "iVBORw0KGgo=");
});

test("vcard: an existing card keeps what the contact has no place for", () => {
  const existing = card(
    "FN:Ancien nom",
    "N:Ancien;Nom;;;",
    "EMAIL:1@example.com",
    "EMAIL:2@example.com",
    "EMAIL:3@example.com",
    "EMAIL:4@example.com",
    "TEL;TYPE=cell:061",
    "TEL;TYPE=cell:062",
    "TEL;TYPE=voice:063",
    "X-CUSTOM1:à moi",
    "TZ:Europe/Paris",
    "BDAY:--0515",
    "PHOTO:https://example.com/a.jpg",
    "NOTE:ancienne note",
  );
  const text = buildVCard(contact({ fields: { FirstName: "Ada", Email1Address: "new@example.com", MobilePhoneNumber: "07" } }), { existing });
  const lines = text.split("\r\n");
  eq(lines.filter((l) => l.startsWith("FN")), ["FN:Ada"]);
  eq(lines.filter((l) => l.startsWith("N:")), ["N:;Ada;;;"]);
  eq(lines.filter((l) => l.startsWith("EMAIL")), ["EMAIL;PREF=1:new@example.com", "EMAIL:4@example.com"]);
  eq(lines.filter((l) => l.startsWith("TEL")), ["TEL;TYPE=cell;VALUE=TEXT:07", "TEL;TYPE=cell:062", "TEL;TYPE=voice:063"]);
  for (const kept of ["X-CUSTOM1:à moi", "TZ:Europe/Paris", "BDAY:--0515", "PHOTO:https://example.com/a.jpg"]) assert(lines.includes(kept), kept);
  assert(!text.includes("ancienne note"));
  eq(lines.filter((l) => l === "END:VCARD").length, 1);
  eq(uidOfVCard(text), "c-1");
});

test("vcard: mergeLocal changes only what the user changed in the card", () => {
  const item = contact({
    fields: { FirstName: "Ada", LastName: "Lovelace", AssistantName: "Charles", Email1Address: "ada@example.com", JobTitle: "Analyste" },
    children: ["Byron"],
    description: "note du serveur",
    birthday: "1980-05-15",
    birthdayAt: "1980-05-14T22:00:00Z",
  });
  const base = projectVCard(buildVCard(item));
  // Nothing changed: the description last synchronized comes back whole.
  eq(mergeLocal(item, base, base, "c-1"), item);
  // The user changes the title and removes the e-mail address.
  const now = { ...base, fields: { ...base.fields, JobTitle: "Mathématicienne" } };
  delete now.fields.Email1Address;
  const merged = mergeLocal(item, base, now, "c-1");
  eq(merged.fields, { FirstName: "Ada", LastName: "Lovelace", AssistantName: "Charles", JobTitle: "Mathématicienne" });
  eq(merged.children, ["Byron"]);
  eq(merged.birthdayAt, "1980-05-14T22:00:00Z");
  eq(merged.description, "note du serveur");
  // A day that changed loses the instant kept with it.
  const moved = mergeLocal(item, base, { ...base, birthday: "1980-05-20" }, "c-1");
  eq([moved.birthday, moved.birthdayAt], ["1980-05-20", null]);
  eq(mergeLocal(item, base, { ...base, birthday: null }, "c-1").birthday, null);
});

test("vcard: mergeLocal keeps what the server says in another way than the card", () => {
  // The server has no FileAs: the card shows the name as FN, and that is no change.
  const item = contact({ fields: { FirstName: "Ada" } });
  const base = projectVCard(buildVCard(item));
  eq(base.fields.FileAs, "Ada");
  eq(mergeLocal(item, base, base, "c-1").fields, { FirstName: "Ada" });
  eq(mergeLocal(item, base, { ...base, fields: { ...base.fields, FileAs: "Comtesse" } }, "c-1").fields, { FirstName: "Ada", FileAs: "Comtesse" });
});

test("vcard: a new card gives a whole description", () => {
  const now = projectVCard(card("FN:Ada Lovelace", "N:Lovelace;Ada;;;", "EMAIL:ada@example.com", "NOTE:bonjour", "CATEGORIES:Amis", "BDAY:19800515"));
  const merged = mergeLocal(null, null, now, "c-9");
  eq(merged.uid, "c-9");
  eq(merged.fields, { FileAs: "Ada Lovelace", FirstName: "Ada", LastName: "Lovelace", Email1Address: "ada@example.com" });
  eq([merged.description, merged.categories, merged.birthday, merged.readOnly], ["bonjour", ["Amis"], "1980-05-15", null]);
});

test("vcard: sameProjection", () => {
  const a = projectVCard(card("FN:Ada", "EMAIL:a@example.com", "CATEGORIES:x"));
  assert(sameProjection(a, projectVCard(card("EMAIL:a@example.com", "FN:Ada", "X-AUTRE:1", "CATEGORIES:x"))));
  assert(!sameProjection(a, projectVCard(card("FN:Ada", "EMAIL:b@example.com", "CATEGORIES:x"))));
  assert(!sameProjection(a, projectVCard(card("FN:Ada", "EMAIL:a@example.com"))));
  assert(!sameProjection(a, { ...a, picture: "AAAA" }));
  assert(!sameProjection(a, null));
});

test("vcard: every mapped property is one the contact holds", () => {
  const known = new Set(CONTACT_FIELDS.map((f) => f.tag));
  for (const tag of MAPPED_FIELDS) assert(known.has(tag));
  eq(new Set(MAPPED_FIELDS).size, MAPPED_FIELDS.length);
});
