// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the calendar item conversion against [MS-ASCAL] (elements,
 * exceptions, MeetingStatus), [MS-ASAIRS] (Body) and [MS-ASCMD]
 * (FilterType, Supported), and against the event description of
 * docs/CALENDAR-DESIGN.md.
 * ApplicationData is built, encoded to WBXML and decoded again, then read
 * through protocol.parseSync, as it arrives from a server.
 */

import { test, assert, eq, throws, prng } from "./harness.mjs";
import {
  CALENDAR_FILTER_TYPES,
  LIMITS,
  BODY_TRUNCATION_BYTES,
  calendarSupported,
  calendarOptions,
  readEvent,
  writeEvent,
  checkEvent,
} from "../../src/core/calendar-item.mjs";
import { UTC_ZONE, decodeTimeZone, encodeTimeZone, localMidnightUtc, formatDate, formatUtc, formatCompact, parseDate, parseUtc } from "../../src/core/eas-timezone.mjs";
import { WEEKDAYS, PROTOCOL_VERSIONS } from "../../src/core/recurrence.mjs";
import { tokenOf } from "../../src/core/codepages.mjs";
import { el, encode, decode, text, child } from "../../src/core/wbxml.mjs";
import { parseSync, syncRequest, addCommand, changeCommand, ProtocolError } from "../../src/core/protocol.mjs";
import { encodeUtf8 } from "../../src/core/utf8.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const hasCode = (code) => (e) => e instanceof ProtocolError && e.code === code;
const isBadItem = hasCode("BAD_ITEM");
const isBadRecurrence = hasCode("BAD_RECURRENCE");
const isBadZone = hasCode("BAD_TIMEZONE");
const ch = (...codes) => String.fromCharCode(...codes);
const cp = (...codes) => String.fromCodePoint(...codes);
/** A family emoji and a Persian word, spelled as they are: with the zero-width joiner and non-joiner. */
const FAMILY = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const PERSIAN = ch(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645);
/** Characters that are removed from the content of an item, and make it "incomplete": [what, character]. */
const HIDDEN = [
  ["a soft hyphen", ch(0x00ad)], ["an Arabic letter mark", ch(0x061c)], ["a Mongolian vowel separator", ch(0x180e)], ["a zero-width space", ch(0x200b)],
  ["a left-to-right mark", ch(0x200e)], ["a right-to-left mark", ch(0x200f)], ["a left-to-right embedding", ch(0x202a)], ["a right-to-left embedding", ch(0x202b)],
  ["a pop directional formatting", ch(0x202c)], ["a left-to-right override", ch(0x202d)], ["a right-to-left override", ch(0x202e)], ["a word joiner", ch(0x2060)],
  ["a left-to-right isolate", ch(0x2066)], ["a right-to-left isolate", ch(0x2067)], ["a first strong isolate", ch(0x2068)], ["a pop directional isolate", ch(0x2069)],
  ["a byte order mark", ch(0xfeff)], ["an annotation anchor", ch(0xfff9)], ["an annotation separator", ch(0xfffa)], ["an annotation terminator", ch(0xfffb)],
  ["the noncharacter U+FFFE", ch(0xfffe)], ["the noncharacter U+FFFF", ch(0xffff)], ["a language tag", cp(0xe0001)], ["a tag letter", cp(0xe0061)], ["a cancel tag", cp(0xe007f)],
];

const OWN = "me@example.org";
const SPEC_PACIFIC = "4AEAAFAAYQBjAGkAZgBpAGMAIABTAHQAYQBuAGQAYQByAGQAIABUAGkAbQBlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsAAAABAAIAAAAAAAAAAAAAAFAAYQBjAGkAZgBpAGMAIABEAGEAeQBsAGkAZwBoAHQAIABUAGkAbQBlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAACAAIAAAAAAAAAxP///w==";
const PACIFIC = decodeTimeZone(SPEC_PACIFIC);
const change = (month, week, weekday, hour, minute = 0) => ({ month, week, weekday, hour, minute });
const zone = (bias, standardChange = null, daylightChange = null) => ({
  bias,
  standard: { bias: 0, change: standardChange },
  daylight: { bias: standardChange ? -60 : 0, change: daylightChange },
});
const PARIS = zone(-60, change(10, 5, 0, 3), change(3, 5, 0, 2));
const SYDNEY = zone(-600, change(4, 1, 0, 3), change(10, 1, 0, 2));
const MIDNIGHT_CHANGES = zone(240, change(4, 1, 0, 0), change(9, 1, 0, 0));
const TWO_MIDNIGHTS = zone(300, change(11, 1, 0, 1), change(3, 2, 0, 0));
const ZONES = [UTC_ZONE, PACIFIC, PARIS, SYDNEY, MIDNIGHT_CHANGES, TWO_MIDNIGHTS, zone(-840), zone(720)];

// ── Building items ────────────────────────────────────────────────────────

/** ApplicationData of an Add in a Sync response, as the client receives it. */
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

const C = (tag, content) => el(`Calendar:${tag}`, content);
const A = (tag, content) => el(`AirSyncBase:${tag}`, content);
const body = (type, data, extra = []) => A("Body", [A("Type", type), ...extra, data === undefined ? null : A("Data", data)]);

/** The three elements an item cannot do without, then `extra`. A null value leaves the element out. */
function item(extra = [], { start = "20260310T170000Z", end = "20260310T180000Z", uid = "uid-1" } = {}) {
  return [start === null ? null : C("StartTime", start), end === null ? null : C("EndTime", end), uid === null ? null : C("UID", uid), ...extra];
}
const read = (children, options = {}) => readEvent(received(children), { version: "14.1", ownEmail: OWN, ...options });
/**
 * A description read from the server, as Thunderbird's side then holds it and gives it back: the two values a
 * server may leave unsaid (null) are filled in as the privileged module fills them for a new item.
 */
const held = (d) => ({ ...d, description: d.description ?? "", meeting: { ...d.meeting, response: d.meeting.response ?? "not-responded" } });

/** The description of the bare item above, with `fields` changed. */
const DEFAULTS = Object.freeze({
  kind: "event",
  uid: "uid-1",
  summary: "",
  location: "",
  description: "",
  allDay: false,
  start: "2026-03-10T17:00:00Z",
  end: "2026-03-10T18:00:00Z",
  timezone: null,
  busy: "busy",
  privacy: "public",
  reminder: null,
  categories: [],
  organizer: null,
  attendees: [],
  meeting: { role: "none", cancelled: false, responseRequested: false, response: "none", allowNewTime: true },
  recurrence: null,
  exceptions: [],
  stamp: null,
  sequence: 0,
  readOnly: null,
});
const event = (fields = {}) => ({ ...DEFAULTS, ...fields, meeting: { ...DEFAULTS.meeting, ...(fields.meeting ?? {}) } });
const rule = (fields) => ({ freq: "daily", interval: 1, count: null, until: null, byDay: [], bySetPos: null, byMonthDay: null, byMonth: null, weekStart: null, ...fields });
const person = (email, name = "", role = "required", status = "unknown") => ({ email, name, role, status });

/** What elements say, as nested [name, text | children] pairs. */
const shape = (e) => [`${e.ns}:${e.tag}`, e.children.length ? e.children.map(shape) : e.value === null ? null : text(e)];
const written = (description, options = {}) => writeEvent(description, { version: "14.1", ...options });
const names = (elements) => elements.map((e) => `${e.ns}:${e.tag}`);
const valueOf = (elements, name) => {
  const found = elements.filter((e) => `${e.ns}:${e.tag}` === name);
  assert(found.length <= 1, `${name} written once at most`);
  return found.length ? shape(found[0])[1] : undefined;
};
const deepFrozen = (x) => x === null || typeof x !== "object" || (Object.isFrozen(x) && Object.values(x).every(deepFrozen));

// ── Sync options ──────────────────────────────────────────────────────────

test("calendar-item: calendarOptions asks for a period and a plain-text body of bounded size", () => {
  eq(CALENDAR_FILTER_TYPES, ["0", "4", "5", "6", "7"]);
  assert(Object.isFrozen(CALENDAR_FILTER_TYPES));
  for (const filterType of [...CALENDAR_FILTER_TYPES, 0, 4, 7]) {
    eq(calendarOptions({ filterType }).map(shape), [
      ["AirSync:FilterType", String(filterType)],
      ["AirSyncBase:BodyPreference", [["AirSyncBase:Type", "1"], ["AirSyncBase:TruncationSize", String(BODY_TRUNCATION_BYTES)]]],
    ]);
  }
  eq(BODY_TRUNCATION_BYTES, 98304);
  // 1 to 3 are for e-mail only, 8 for tasks, 9 for nothing ([MS-ASCMD] 2.2.3.68.2).
  for (const filterType of ["1", "2", "3", "8", "9", "", "07", " 7", "7 ", "-0", 1, 8, 4.5, NaN, null, undefined, true, {}, ["7"]]) {
    throws(() => calendarOptions({ filterType }), ProtocolError, `period ${String(filterType)}`);
  }
  throws(() => calendarOptions(), ProtocolError);
  throws(() => calendarOptions({}), ProtocolError);
});

test("calendar-item: calendarSupported names every property the module handles, per version", () => {
  // The elements a client must name ([MS-ASCMD] 2.2.3.179).
  const required = ["DtStamp", "Categories", "Sensitivity", "BusyStatus", "UID", "Timezone", "StartTime", "Subject", "Location", "EndTime", "Recurrence", "AllDayEvent", "Reminder", "Exceptions"];
  const optional = ["Attendees", "OrganizerName", "OrganizerEmail", "MeetingStatus"];
  const since14 = ["ResponseRequested", "DisallowNewTimeProposal"];
  const named = (list) => list.map((name) => `Calendar:${name}`);
  eq(calendarSupported("12.1"), named([...required, ...optional]));
  eq(calendarSupported("14.0"), named([...required, ...optional, ...since14]));
  eq(calendarSupported("14.1"), named([...required, ...optional, ...since14]));
  for (const version of PROTOCOL_VERSIONS) {
    const list = calendarSupported(version);
    assert(Object.isFrozen(list), "frozen");
    eq(new Set(list).size, list.length, "each name once");
    for (const name of list) assert(tokenOf("Calendar", name.slice(9)) !== undefined, `${name} is in the code page`);
    // What is read-only for a client, or of another version, is never named.
    for (const never of ["ResponseType", "AppointmentReplyTime", "OnlineMeetingConfLink", "ClientUid", "Body"]) assert(!list.includes(`Calendar:${never}`), never);
    // The request builder takes the list as it is.
    const request = syncRequest([{ collectionId: "7", syncKey: "0", supported: list, options: calendarOptions({ filterType: "7" }) }]);
    eq(child(child(child(decode(encode(request)), "Collections"), "Collection"), "Supported").children.length, list.length);
  }
  for (const version of ["2.5", "12.0", "16.0", "16.1", "", undefined, null, 14.1]) throws(() => calendarSupported(version), hasCode("BAD_VERSION"), String(version));
});

test("calendar-item: writeEvent writes exactly the supported properties, in every version", () => {
  const full = event({
    summary: "Subject", location: "Room", description: "Text", timezone: PACIFIC, reminder: 15, categories: ["One"], stamp: "2026-03-01T08:00:00Z",
    organizer: { email: OWN, name: "Me" }, attendees: [person("a@example.org", "A")], meeting: { role: "organizer", responseRequested: true },
    recurrence: rule({ freq: "weekly", byDay: ["TU"], weekStart: "MO" }),
    exceptions: [{ originalStart: "2026-03-17T16:00:00Z", deleted: true, changes: {} }],
  });
  for (const version of PROTOCOL_VERSIONS) {
    const list = names(writeEvent(full, { version }));
    eq(new Set(list).size, list.length, "each element once");
    eq([...list].filter((name) => name !== "AirSyncBase:Body").sort(), [...calendarSupported(version)].sort(), `version ${version}`);
    assert(list.includes("AirSyncBase:Body"), "and the body");
  }
});

// ── Reading: the examples of the specification ────────────────────────────

test("calendar-item: the appointment of [MS-ASCAL] 4.1", () => {
  const data = received([
    C("Timezone", SPEC_PACIFIC),
    C("DtStamp", "20081002T231357Z"),
    C("StartTime", "20081010T190000Z"),
    C("Subject", "Lunch meeting"),
    C("UID", "040000008200E00074C5B7101A82E008000000001027EAEDA124C901000000000000000010000000C58EA426C0CFF24AB3125200707153B1"),
    C("OrganizerName", "Anat Kerry"),
    C("OrganizerEmail", "anat@contoso.com"),
    C("Location", "Cafeteria A"),
    C("EndTime", "20081010T203000Z"),
    A("Body", [A("Type", "3"), A("EstimatedDataSize", "5669"), A("Truncated", "1")]),
    C("Sensitivity", "0"),
    C("BusyStatus", "3"),
    C("AllDayEvent", "0"),
    C("Reminder", "15"),
    C("MeetingStatus", "0"),
    A("NativeBodyType", "3"),
  ]);
  const expected = event({
    uid: "040000008200E00074C5B7101A82E008000000001027EAEDA124C901000000000000000010000000C58EA426C0CFF24AB3125200707153B1",
    summary: "Lunch meeting",
    location: "Cafeteria A",
    start: "2008-10-10T19:00:00Z",
    end: "2008-10-10T20:30:00Z",
    timezone: PACIFIC,
    busy: "away",
    reminder: 15,
    organizer: { email: "anat@contoso.com", name: "Anat Kerry" },
    stamp: "2008-10-02T23:13:57Z",
    // The example asked for no plain text: its body came as RTF, truncated. The description does not hold it.
    readOnly: "incomplete",
  });
  for (const version of PROTOCOL_VERSIONS) {
    const description = readEvent(data, { version, ownEmail: "anat@contoso.com" });
    eq(description, expected, version);
    assert(deepFrozen(description), "deeply frozen");
    // With the body as this client asks for it, nothing is missing.
    const plain = { ...data, children: data.children.map((c) => (c.tag === "Body" ? received([body("1", "Lunch at noon")]).children[0] : c)) };
    eq(readEvent(plain, { version, ownEmail: "anat@contoso.com" }), { ...expected, description: "Lunch at noon", readOnly: null }, `${version}, plain body`);
  }
});

test("calendar-item: the recurring appointment with a deleted occurrence of [MS-ASCAL] 4.2", () => {
  const description = read([
    C("Timezone", SPEC_PACIFIC),
    C("DtStamp", "20090415T165811Z"),
    C("StartTime", "20090417T170000Z"),
    C("Subject", "Recurring appointment test"),
    C("UID", "040000008200E00074C5B7101A82E00800000000B0CD1F52EBBDC901000000000000000010000000B05E442FCB2CA443BF3D99B51A729FE6"),
    C("OrganizerName", "Anat Kerry"),
    C("OrganizerEmail", "anat@contoso.com "),
    C("Location", "My office"),
    C("EndTime", "20090417T180000Z"),
    C("Recurrence", [C("Type", "1"), C("Interval", "1"), C("Occurrences", "3"), C("DayOfWeek", "32")]),
    A("Body", [A("Type", "3"), A("EstimatedDataSize", "238"), A("Truncated", "1")]),
    C("Sensitivity", "0"),
    C("BusyStatus", "2"),
    C("AllDayEvent", "0"),
    C("Reminder", "15"),
    C("Exceptions", [C("Exception", [C("Deleted", "1"), C("ExceptionStartTime", "20090424T170000Z")])]),
    C("MeetingStatus", "0"),
    A("NativeBodyType", "3"),
    C("ResponseRequested", "1"),
    C("ResponseType", "1"),
  ]);
  eq(description.recurrence, rule({ freq: "weekly", count: 3, byDay: ["FR"] }));
  eq(description.exceptions, [{ originalStart: "2009-04-24T17:00:00Z", deleted: true, changes: {} }]);
  eq(description.organizer, { email: "anat@contoso.com", name: "Anat Kerry" }, "the address without its trailing blank");
  eq(description.meeting, { role: "none", cancelled: false, responseRequested: true, response: "none", allowNewTime: true });
  eq(description.readOnly, "incomplete", "the RTF body of the example is not in the description");
});

test("calendar-item: the meeting and its attendee of [MS-ASCAL] 4.3", () => {
  const meeting = (status) => [
    C("Timezone", SPEC_PACIFIC),
    C("DtStamp", "20051103T013759Z"),
    C("StartTime", "20051103T230000Z"),
    C("Subject", "test meeting"),
    C("UID", "040000008200E00074C5B7101A82E00800000000B0FD68A212E0C5010000000000000000100000008C46B9A4960AF340871367CEC57B4543"),
    C("Attendees", [C("Attendee", [C("Email", "chris@fourthcoffee.com"), C("Name", "Chris Gray"), C("AttendeeStatus", status), C("AttendeeType", "1")])]),
    C("OrganizerName", "Anat Kerry"),
    C("OrganizerEmail", "anat@contoso.com"),
    C("Location", "34/1123"),
    C("EndTime", "20051104T000000Z"),
    A("Body", [A("Type", "1"), A("EstimatedDataSize", "28")]),
    C("Sensitivity", "0"),
    C("BusyStatus", "2"),
    C("AllDayEvent", "0"),
    C("Reminder", "15"),
    C("MeetingStatus", "1"),
  ];
  const before = readEvent(received(meeting("0")), { version: "12.1", ownEmail: "Anat@Contoso.com" });
  eq(before.attendees, [person("chris@fourthcoffee.com", "Chris Gray", "required", "unknown")]);
  eq(before.meeting, { role: "organizer", cancelled: false, responseRequested: true, response: "none", allowNewTime: true });
  eq(readEvent(received(meeting("3")), { version: "12.1", ownEmail: "anat@contoso.com" }).attendees[0].status, "accepted");
  eq(readEvent(received(meeting("3")), { version: "12.1", ownEmail: "chris@fourthcoffee.com" }).meeting.role, "attendee", "for another mailbox");
});

// ── Reading: required values ──────────────────────────────────────────────

test("calendar-item: a bare item takes every default", () => {
  eq(read(item()), event());
  assert(deepFrozen(read(item())));
  // Empty elements are no values.
  const empty = item([C("Subject"), C("Location"), C("Reminder"), C("Categories"), C("Attendees"), C("OrganizerEmail"), C("OrganizerName"), C("DtStamp"), C("BusyStatus"), C("Sensitivity"), C("MeetingStatus"), A("Body")]);
  eq(read(empty), event());
});

test("calendar-item: without StartTime the item is incomplete; without EndTime, invalid", () => {
  const thrown = throws(() => read(item([], { start: null })), hasCode("INCOMPLETE_ITEM"));
  assert(thrown instanceof ProtocolError);
  throws(() => read(item([], { start: null, end: null })), hasCode("INCOMPLETE_ITEM"), "only DtStamp or the like changed");
  throws(() => read([C("DtStamp", "20260310T170000Z")]), hasCode("INCOMPLETE_ITEM"));
  throws(() => read(item([], { end: null })), isBadItem);
  throws(() => read(item([], { start: "" })), isBadItem, "an empty StartTime is not an absent one");
  for (const bad of [null, undefined, "data", {}, [], { ns: "AirSync", tag: "ApplicationData" }]) {
    throws(() => readEvent(bad, { version: "14.1", ownEmail: OWN }), isBadItem, String(bad));
  }
});

test("calendar-item: StartTime and EndTime are exactly Compact DateTime values, of real days", () => {
  const wrong = [
    "2026-03-10T17:00:00Z", "2026-03-10T17:00:00.000Z", "20260310T170000", "20260310T170000z", "20260310t170000Z", "2026031T170000Z", "202603100T170000Z",
    "20260310T1700Z", "20260310", "20260230T170000Z", "20260431T170000Z", "20261310T170000Z", "20260010T170000Z", "20260300T170000Z", "20260310T240000Z",
    "20260310T176000Z", "20260310T170060Z", "18991231T235959Z", "22010101T000000Z", "00000101T000000Z", "99991231T235959Z", " 20260310T170000Z",
    "20260310T170000Z ", "20260310T170000Z\n", `${ch(0xff12)}0260310T170000Z`, "now", "0", "-1",
  ];
  for (const bad of wrong) {
    throws(() => read(item([], { start: bad })), isBadItem, `StartTime ${JSON.stringify(bad)}`);
    throws(() => read(item([], { end: bad })), isBadItem, `EndTime ${JSON.stringify(bad)}`);
  }
  eq(read(item([], { start: "19000101T000000Z", end: "22001231T235959Z" })).start, "1900-01-01T00:00:00Z");
  eq(read(item([], { start: "19000101T000000Z", end: "22001231T235959Z" })).end, "2200-12-31T23:59:59Z");
  eq(read(item([], { start: "20280229T120000Z", end: "20280229T130000Z" })).start, "2028-02-29T12:00:00Z");
  // A megabyte of digits is not a date either.
  throws(() => read(item([], { start: "2".repeat(1_000_000) })), isBadItem);
});

test("calendar-item: the end of a timed event is not before its start", () => {
  throws(() => read(item([], { start: "20260310T170000Z", end: "20260310T165959Z" })), isBadItem, "before");
  eq(read(item([], { start: "20260310T170000Z", end: "20260310T170001Z" })).end, "2026-03-10T17:00:01Z");
});

test("calendar-item: an event of no length is read, checked and written", () => {
  const instant = read(item([C("Subject", "Deadline")], { start: "20260310T170000Z", end: "20260310T170000Z" }));
  eq(instant, event({ summary: "Deadline", end: "2026-03-10T17:00:00Z" }));
  eq(checkEvent(event({ end: "2026-03-10T17:00:00Z" })).end, "2026-03-10T17:00:00Z");
  const elements = written(instant);
  eq([valueOf(elements, "Calendar:StartTime"), valueOf(elements, "Calendar:EndTime")], ["20260310T170000Z", "20260310T170000Z"]);
  for (const version of PROTOCOL_VERSIONS) eq(readEvent(received(writeEvent(instant, { version })), { version, ownEmail: OWN }), { ...instant, timezone: UTC_ZONE }, version);
  // An occurrence too.
  const series = event({
    end: "2026-03-10T17:00:00Z",
    recurrence: rule({}),
    exceptions: [{ originalStart: "2026-03-11T17:00:00Z", deleted: false, changes: { start: "2026-03-11T18:00:00Z", end: "2026-03-11T18:00:00Z" } }],
  });
  eq(read(written(series)).exceptions, series.exceptions);
  eq(read(item([weekly, C("Exceptions", [exception(original(), C("StartTime", "20260317T180000Z"), C("EndTime", "20260317T180000Z"))])])).exceptions[0].changes, { start: "2026-03-17T18:00:00Z", end: "2026-03-17T18:00:00Z" });
  // A day has a length: an all-day event still ends after it starts.
  throws(() => checkEvent(event({ allDay: true, start: "2026-03-10", end: "2026-03-10" })), isBadItem);
  throws(() => checkEvent(event({ recurrence: rule({}), exceptions: [{ originalStart: "2026-03-11T17:00:00Z", deleted: false, changes: { allDay: true, start: "2026-03-11", end: "2026-03-11" } }] })), isBadItem);
});

test("calendar-item: the UID is taken as it is, or the item is refused", () => {
  eq(read(item([], { uid: "A".repeat(300) })).uid, "A".repeat(300));
  throws(() => read(item([], { uid: "A".repeat(301) })), isBadItem, "301 characters");
  throws(() => read(item([], { uid: "A".repeat(100_000) })), isBadItem, "100,000 characters");
  eq(read(item([], { uid: "é@example.org {x}/y?z=1" })).uid, "é@example.org {x}/y?z=1");
  for (const code of [0x01, 0x07, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x85, 0x200b, 0x200e, 0x202e, 0x2028, 0x2066, 0xfeff, 0x00ad]) {
    throws(() => read(item([], { uid: `uid${ch(code)}1` })), isBadItem, `U+${code.toString(16)}`);
  }
  // The server may send none: the caller then names the item, or the item is refused.
  throws(() => read(item([], { uid: null })), isBadItem);
  throws(() => read(item([], { uid: "" })), isBadItem);
  eq(read(item([], { uid: null }), { fallbackUid: "7-7:1@sync443" }).uid, "7-7:1@sync443");
  eq(read(item([], { uid: "" }), { fallbackUid: "7-7:1@sync443" }).uid, "7-7:1@sync443");
  eq(read(item(), { fallbackUid: "unused" }).uid, "uid-1");
  throws(() => read(item([], { uid: null }), { fallbackUid: `bad${ch(0x202e)}` }), isBadItem);
  throws(() => read(item([], { uid: null }), { fallbackUid: "" }), isBadItem);
  throws(() => read(item([], { uid: null }), { fallbackUid: 42 }), isBadItem);
  // A too long UID is not replaced by the fallback: it is not the same item any more.
  throws(() => read(item([], { uid: "A".repeat(301) }), { fallbackUid: "7-7:1@sync443" }), isBadItem);
});

test("calendar-item: a required element sent twice makes the item invalid", () => {
  for (const tag of ["StartTime", "EndTime", "UID", "Subject", "Location", "Timezone", "AllDayEvent", "BusyStatus", "Sensitivity", "Reminder", "MeetingStatus", "OrganizerEmail", "OrganizerName", "DtStamp", "Categories", "Attendees", "Recurrence", "Exceptions", "ResponseRequested", "ResponseType", "DisallowNewTimeProposal"]) {
    throws(() => read(item([C(tag, "1"), C(tag, "1")])), isBadItem, `two ${tag}`);
  }
  throws(() => read(item([C("StartTime", "20270101T000000Z")])), isBadItem, "two start times: no way to choose");
});

test("calendar-item: the mailbox's own address and the version are required", () => {
  for (const ownEmail of [undefined, null, "", "me", "me@", "@example.org", "me@example", "a b@example.org", `me@example.org${ch(0x202e)}`, 42, [OWN]]) {
    throws(() => readEvent(received(item()), { version: "14.1", ownEmail }), isBadItem, String(ownEmail));
  }
  for (const version of [undefined, null, "", "2.5", "12.0", "16.0", "16.1", 14.1]) {
    throws(() => readEvent(received(item()), { version, ownEmail: OWN }), hasCode("BAD_VERSION"), String(version));
    throws(() => writeEvent(event(), { version }), hasCode("BAD_VERSION"), `write ${String(version)}`);
  }
  throws(() => readEvent(received(item())), hasCode("BAD_VERSION"), "no options");
  throws(() => writeEvent(event()), hasCode("BAD_VERSION"), "no options");
});

// ── Reading: texts ────────────────────────────────────────────────────────

test("calendar-item: texts lose their control and bidirectional characters, and are cut", () => {
  const dirty = `a${ch(0x01)}b${ch(0x07)}c${ch(0x1b)}d${ch(0x7f)}e${ch(0x85)}f${ch(0x202e)}g${ch(0x2066)}h${ch(0x200b)}i${ch(0x200e)}j${ch(0xfeff)}k${ch(0x061c)}l`;
  const description = read(item([
    C("Subject", `${dirty}\r\nline${ch(0x2028)}two\tend`),
    C("Location", `${dirty}\nroom`),
    body("1", `${dirty}\r\nline two${ch(0x2029)}line three\ttabbed`),
    C("OrganizerEmail", "boss@example.org"),
    C("OrganizerName", ` ${dirty}\nboss `),
    C("Categories", [C("Category", ` ${dirty}\ncat `)]),
    C("Attendees", [C("Attendee", [C("Email", "a@example.org"), C("Name", `${dirty}\nname`)])]),
  ]));
  eq(description.summary, "abcdefghijkl line two end", "one line");
  eq(description.location, "abcdefghijkl room");
  eq(description.description, "abcdefghijkl\nline two\nline three\ttabbed", "several lines, cleaned");
  eq(description.organizer.name, "abcdefghijkl boss");
  eq(description.categories, ["abcdefghijkl cat"]);
  eq(description.attendees[0].name, "abcdefghijkl name");
});

test("calendar-item: a NUL in a text, which only opaque data can carry, is removed", () => {
  const bytes = encodeUtf8("abc");
  const withNul = new Uint8Array([...bytes.slice(0, 1), 0, ...bytes.slice(1), 0]);
  eq(read(item([C("Subject", withNul), C("Location", withNul)])).summary, "abc");
  throws(() => read(item([], { uid: withNul })), isBadItem, "but an identifier with a NUL is refused");
});

test("calendar-item: the joiner and the non-joiner stay in the content of an item, and go back as they came", () => {
  const subject = `${FAMILY} dinner ${PERSIAN}`;
  const description = read(item([
    C("Subject", subject),
    C("Location", `${PERSIAN} 4`),
    body("1", `${FAMILY}\r\n${PERSIAN}`),
    C("Categories", [C("Category", FAMILY), C("Category", PERSIAN)]),
    weekly,
    C("Exceptions", [exception(original(), C("Subject", subject), C("Location", PERSIAN), body("1", FAMILY), C("Categories", [C("Category", PERSIAN)]))]),
  ]));
  eq(description.readOnly, null, "nothing was lost");
  eq([description.summary, description.location, description.description, description.categories], [subject, `${PERSIAN} 4`, `${FAMILY}\n${PERSIAN}`, [FAMILY, PERSIAN]]);
  eq(description.exceptions[0].changes, { summary: subject, location: PERSIAN, description: FAMILY, categories: [PERSIAN] });
  assert(description.summary.includes(ch(0x200d)) && description.summary.includes(ch(0x200c)), "both characters are there");
  // What comes back from Thunderbird keeps them, and so does what is written: the server's own text.
  eq(checkEvent(description), description);
  const sent = written(description, { previous: description });
  eq(valueOf(sent, "Calendar:Subject"), subject);
  eq(valueOf(sent, "Calendar:Location"), `${PERSIAN} 4`);
  eq(valueOf(sent, "Calendar:Categories"), [["Calendar:Category", FAMILY], ["Calendar:Category", PERSIAN]]);
  eq(valueOf(sent, "Calendar:Exceptions")[0][1].filter(([name]) => name !== "Calendar:ExceptionStartTime"), [
    ["Calendar:Subject", subject], ["Calendar:Location", PERSIAN], ["Calendar:Categories", [["Calendar:Category", PERSIAN]]],
  ]);
  eq(valueOf(written({ ...description, description: `${PERSIAN}!` }, { previous: description }), "AirSyncBase:Body")[1], ["AirSyncBase:Data", `${PERSIAN}!`], "and a changed body");
  // Two categories that differ by a joiner are two categories.
  eq(read(item([C("Categories", [C("Category", `Ho${ch(0x200d)}me`), C("Category", "Home")])])).categories, [`Ho${ch(0x200d)}me`, "Home"]);
});

test("calendar-item: any other invisible or bidirectional character is removed from the content, and the item is incomplete", () => {
  for (const [what, hidden] of HIDDEN) {
    const dirty = `Bud${hidden}get`;
    for (const [where, children, pick] of [
      ["Subject", [C("Subject", dirty)], (d) => d.summary],
      ["Location", [C("Location", dirty)], (d) => d.location],
      ["the body", [body("1", dirty)], (d) => d.description],
      ["a category", [C("Categories", [C("Category", dirty)])], (d) => d.categories[0]],
      ["the Subject of an occurrence", [weekly, C("Exceptions", [exception(original(), C("Subject", dirty))])], (d) => d.exceptions[0].changes.summary],
      ["the Location of an occurrence", [weekly, C("Exceptions", [exception(original(), C("Location", dirty))])], (d) => d.exceptions[0].changes.location],
      ["the body of an occurrence", [weekly, C("Exceptions", [exception(original(), body("1", dirty))])], (d) => d.exceptions[0].changes.description],
      ["a category of an occurrence", [weekly, C("Exceptions", [exception(original(), C("Categories", [C("Category", dirty)]))])], (d) => d.exceptions[0].changes.categories[0]],
    ]) {
      const description = read(item(children));
      eq(pick(description), "Budget", `${what} in ${where}: removed`);
      eq(description.readOnly, "incomplete", `${what} in ${where}: the text is no longer the server's`);
      throws(() => written(description, { previous: description }), hasCode("READ_ONLY_ITEM"), `${what} in ${where}: never written back`);
    }
    // The same character with the two that stay: it alone is removed.
    eq(read(item([C("Subject", `${FAMILY}${hidden}${PERSIAN}`)])).summary, `${FAMILY}${PERSIAN}`, what);
  }
});

test("calendar-item: control characters, and tabs and line breaks in one line, are removed without a mark", () => {
  // Every C0 and C1 control but NUL, which a WBXML string cannot hold (see the test above).
  const controls = [...Array.from({ length: 31 }, (_, i) => i + 1).filter((i) => i !== 0x09 && i !== 0x0a && i !== 0x0d), 0x7f, ...Array.from({ length: 32 }, (_, i) => 0x80 + i)].map((i) => ch(i)).join("");
  const description = read(item([
    C("Subject", `Bud${controls}get\tof\r\nthe${ch(0x2028)}year${ch(0x2029)}`),
    C("Location", `Room${controls}\t4\n`),
    body("1", `Agen${controls}da\r\nline two\ttabbed${ch(0x2028)}line three`),
    C("Categories", [C("Category", ` Wo${controls}rk\t1 `)]),
    weekly,
    C("Exceptions", [exception(original(), C("Subject", `One${controls}\tday`), body("1", `No${controls}tes\r\n`))]),
  ]));
  eq(description.readOnly, null, "no loss");
  eq([description.summary, description.location, description.description, description.categories], ["Budget of the year ", "Room 4 ", "Agenda\nline two\ttabbed\nline three", ["Work 1"]]);
  eq(description.exceptions[0].changes, { summary: "One day", description: "Notes\n" });
});

test("calendar-item: names of people, and the uid, are cleaned strictly, the joiners included, without a mark", () => {
  const everything = `${ch(0x200c, 0x200d)}${HIDDEN.map(([, hidden]) => hidden).join("")}`;
  const description = read(item([
    C("MeetingStatus", "3"),
    C("OrganizerEmail", "boss@example.org"),
    C("OrganizerName", `The ${everything}Boss`),
    C("Attendees", [C("Attendee", [C("Email", "a@example.org"), C("Name", `A${everything}nn`)])]),
    weekly,
    C("Exceptions", [exception(original(), C("Attendees", [C("Attendee", [C("Email", "b@example.org"), C("Name", `B${everything}ob`)])]))]),
  ]));
  eq([description.organizer.name, description.attendees[0].name, description.exceptions[0].changes.attendees[0].name], ["The Boss", "Ann", "Bob"]);
  eq(description.readOnly, null, "a name is not content that a change would send back as another text");
  // From Thunderbird's side too.
  const checked = checkEvent(event({ organizer: { email: "boss@example.org", name: `The ${everything}Boss` }, attendees: [person("a@example.org", `A${everything}nn`)] }));
  eq([checked.organizer.name, checked.attendees[0].name], ["The Boss", "Ann"]);
  // An identifier is never repaired: with any such character it is refused.
  for (const hidden of [ch(0x200c), ch(0x200d), ...HIDDEN.map(([, character]) => character)]) {
    throws(() => read(item([], { uid: `uid${hidden}1` })), isBadItem, "a uid from the server");
    throws(() => checkEvent(event({ uid: `uid${hidden}1` })), isBadItem, "a uid from Thunderbird");
  }
});

test("calendar-item: bytes that are not UTF-8 are a loss in a text, and no identifier at all", () => {
  // "caf" then a lone Latin-1 byte, and a truncated sequence: the decoder puts U+FFFD there.
  const broken = [new Uint8Array([0x63, 0x61, 0x66, 0xe9]), new Uint8Array([0x61, 0xe2, 0x82]), new Uint8Array([0xed, 0xa0, 0x80, 0x62]), new Uint8Array([0x61, 0xc0, 0xaf])];
  for (const bytes of broken) {
    for (const [where, children, pick] of [
      ["Subject", [C("Subject", bytes)], (d) => d.summary],
      ["Location", [C("Location", bytes)], (d) => d.location],
      ["the body", [body("1", bytes)], (d) => d.description],
      ["a category", [C("Categories", [C("Category", bytes)])], (d) => d.categories[0]],
      ["the name of the organizer", [C("OrganizerEmail", "boss@example.org"), C("OrganizerName", bytes)], (d) => d.organizer.name],
      ["the name of an attendee", [C("Attendees", [C("Attendee", [C("Email", "a@example.org"), C("Name", bytes)])])], (d) => d.attendees[0].name],
      ["the Subject of an occurrence", [weekly, C("Exceptions", [exception(original(), C("Subject", bytes))])], (d) => d.exceptions[0].changes.summary],
    ]) {
      const description = read(item(children));
      assert(pick(description).includes(ch(0xfffd)), `${where}: shown with a replacement character`);
      eq(description.readOnly, "incomplete", `${where}: [${bytes}] is not the server's text`);
      throws(() => written(description, { previous: description }), hasCode("READ_ONLY_ITEM"), `${where}: never sent back`);
    }
    throws(() => read(item([], { uid: bytes })), isBadItem, "a UID is taken as it is or not at all");
    // Values read whole or not at all: not a value, so a default and a loss.
    eq(read(item([C("BusyStatus", bytes)])).readOnly, "incomplete");
    eq(read(item([C("OrganizerEmail", bytes)])).organizer, null);
  }
  // U+FFFD that the server itself wrote is its text, and so is any other valid UTF-8.
  const honest = read(item([C("Subject", `a${ch(0xfffd)}b ${cp(0x1f600)} ${ch(0xe9)}`), C("Location", ch(0xfffd)), body("1", ch(0xfffd))], { uid: `u${ch(0xfffd)}` }));
  eq([honest.summary, honest.location, honest.description, honest.uid, honest.readOnly], [`a${ch(0xfffd)}b ${cp(0x1f600)} ${ch(0xe9)}`, ch(0xfffd), ch(0xfffd), `u${ch(0xfffd)}`, null]);
  // Megabytes of text whose beginning is sound are judged on the part that is read.
  eq(read(item([C("Subject", "s".repeat(1024))])).readOnly, null);
});

test("calendar-item: next to a lone surrogate, invisible characters are still removed", () => {
  // In some engines a character class with the u flag does not match right after a lone surrogate.
  for (const [, hidden] of HIDDEN) {
    for (const lone of [ch(0xd800), ch(0xdbff), ch(0xdc00)]) {
      const dirty = `a${lone}${hidden}b`;
      const checked = checkEvent(event({ summary: dirty, location: dirty, description: dirty, categories: [dirty], organizer: { email: "boss@example.org", name: dirty }, attendees: [person("a@example.org", dirty)] }));
      const clean = `a${ch(0xfffd)}b`;
      eq([checked.summary, checked.location, checked.description, checked.categories, checked.organizer.name, checked.attendees[0].name], [clean, clean, clean, [clean], clean, clean], `U+${hidden.codePointAt(0).toString(16)}`);
      throws(() => checkEvent(event({ uid: dirty })), isBadItem);
    }
  }
  eq(checkEvent(event({ organizer: { email: "boss@example.org", name: `a${ch(0xd800, 0x200d)}b` } })).organizer.name, `a${ch(0xfffd)}b`, "a joiner in a name, too");
});

test("calendar-item: over-long texts are cut to the bounds of the contract", () => {
  eq(LIMITS, { uid: 300, summary: 1024, location: 1024, description: 32768, categories: 50, category: 255, name: 256, attendees: 500, exceptions: 256, reminder: 40320, sequence: 2147483647 });
  const description = read(item([
    C("Subject", "s".repeat(5000)),
    C("Location", "l".repeat(1025)),
    body("1", "d".repeat(100_000)),
    C("OrganizerEmail", "boss@example.org"),
    C("OrganizerName", "n".repeat(1000)),
    C("Categories", [C("Category", "c".repeat(1000)), C("Category", "c".repeat(255))]),
    C("Attendees", [C("Attendee", [C("Email", "a@example.org"), C("Name", "é".repeat(1000))])]),
  ]));
  eq(description.summary, "s".repeat(1024));
  eq(description.location, "l".repeat(1024));
  eq(description.description, "d".repeat(32768));
  eq(description.organizer.name, "n".repeat(256));
  eq(description.categories, ["c".repeat(255)], "cut to 255, then the same name twice");
  eq(description.attendees[0].name, "é".repeat(256));
  // A cut never splits a character outside the basic plane.
  const emoji = ch(0xd83d, 0xde00);
  eq(read(item([C("Subject", `${"s".repeat(1023)}${emoji}`)])).summary, "s".repeat(1023));
  eq(read(item([C("Subject", `${"s".repeat(1022)}${emoji}`)])).summary, `${"s".repeat(1022)}${emoji}`);
  // Megabytes of text cost no more than their beginning.
  eq(read(item([C("Subject", "é".repeat(2_000_000))])).summary, "é".repeat(1024));
  // Only the beginning is decoded, and never half a character: nothing is left of a text
  // whose first kilobytes are all removed.
  eq(read(item([C("Subject", `${ch(0x01).repeat(5118)}${"日".repeat(10)}`)])).summary, "");
  eq(read(item([C("Subject", `${ch(0x01).repeat(5116)}${"日".repeat(10)}`)])).summary, "日", "the last whole character of the part that is read");
});

test("calendar-item: only a plain-text body is read", () => {
  eq(read(item([body("1", "plain")])).description, "plain");
  eq(read(item([body("2", "<b>html</b>")])).description, "", "HTML is never read");
  eq(read(item([body("3", "e1xydGYxfQ==")])).description, "", "RTF");
  eq(read(item([body("4", "MIME-Version: 1.0")])).description, "", "MIME");
  eq(read(item([body("2", "<b>html</b>"), body("1", "plain")])).description, "plain", "the plain one among several");
  eq(read(item([body("1", "first"), body("1", "second")])).description, "first");
  eq(read(item([body("1", "cut by the server", [A("EstimatedDataSize", "5000"), A("Truncated", "1")])])).description, "cut by the server");
  eq(read(item([body("1")])).description, "", "no Data");
  eq(read(item([body("01", "x")])).description, "", "Type must be exactly 1");
  eq(read(item([A("Body", [A("Data", "no type")])])).description, "");
  eq(read(item([C("Subject", "s"), el("Email:Subject", "not this one"), el("Tasks:Subject", "nor this one")])).summary, "s", "elements of other classes are ignored");
  // Twenty bodies: the first eight are looked at.
  eq(read(item([...Array.from({ length: 20 }, () => body("2", "<p>x</p>")), body("1", "late")])).description, "");
});

test("calendar-item: a Change without a Body does not say that the text is gone", () => {
  const changed = (children) => read(item(children), { change: true });
  eq(changed([C("Subject", "Budget")]).description, null, "the server does not say");
  eq(read(item([C("Subject", "Budget")])).description, "", "an Add without a Body has no text");
  for (const notTrue of [false, 1, "true", {}, null, undefined]) eq(read(item(), { change: notTrue }).description, "", `change: ${String(notTrue)}`);
  // With a Body, a Change is read as an Add is.
  eq(changed([body("1", "New text")]).description, "New text");
  eq(changed([A("Body")]).description, "", "an empty Body: the text was removed");
  eq(changed([body("1")]).description, "", "a plain Body without data");
  const html = changed([body("2", "<p>x</p>")]);
  eq([html.description, html.readOnly], ["", "incomplete"], "a Body in another form is a text that was not read");
  // Nothing else of the item is unsaid, and it is no loss: the text held is kept by who holds the item.
  const description = changed([C("Subject", "Budget")]);
  eq(description, event({ summary: "Budget", description: null }));
  // In an exception, an absent Body means what it always meant: the text of the series.
  eq(changed([weekly, C("Exceptions", [exception(original(), C("Subject", "x"))])]).exceptions[0].changes, { summary: "x" });
  // Only a reader may say so. What comes from Thunderbird always has a text, and a null is never written.
  eq(checkEvent(description, { fromServer: true }), description);
  throws(() => checkEvent(description), isBadItem, "a null from Thunderbird");
  throws(() => checkEvent(description, { fromServer: 1 }), isBadItem);
  throws(() => written(description), isBadItem);
  for (const other of [undefined, 42, [], {}]) throws(() => checkEvent(event({ description: other }), { fromServer: true }), isBadItem, `fromServer accepts null only, not ${String(other)}`);
  assert(!names(written(held(description), { previous: held(description) })).includes("AirSyncBase:Body"), "held and written back unchanged: no body");
});

// ── Reading: enumerations and numbers ─────────────────────────────────────

test("calendar-item: enumerations are looked up exactly, and take their default out of range", () => {
  const one = (tag, value) => read(item([C(tag, value)]));
  eq(["0", "1", "2", "3"].map((code) => one("BusyStatus", code).busy), ["free", "tentative", "busy", "away"]);
  eq(["0", "1", "2", "3"].map((code) => one("Sensitivity", code).privacy), ["public", "private", "private", "confidential"]);
  for (const out of ["4", "5", "9", "255", "-1", "02", " 2", "2 ", "busy", "__proto__", "constructor", "toString", "2.0", ""]) {
    eq(one("BusyStatus", out).busy, "busy", `BusyStatus ${JSON.stringify(out)}`);
    eq(one("Sensitivity", out).privacy, "public", `Sensitivity ${JSON.stringify(out)}`);
  }
  for (const out of ["6", "9", "255", "-1", "02", " 2", "accepted", "__proto__", ""]) eq(one("ResponseType", out).meeting.response, "none", `ResponseType ${JSON.stringify(out)}`);
  eq(["0", "1", "2", "3", "4", "5"].map((code) => one("ResponseType", code).meeting.response), ["none", "none", "tentative", "accepted", "declined", "not-responded"]);
  eq(one("AllDayEvent", "0").allDay, false);
  for (const out of ["2", "true", "", "01", "yes"]) eq(one("AllDayEvent", out).allDay, false, `AllDayEvent ${out}`);
});

test("calendar-item: the reminder is a number of minutes, at most four weeks", () => {
  const reminder = (value) => read(item([C("Reminder", value)])).reminder;
  eq(reminder("0"), 0);
  eq(reminder("15"), 15);
  eq(reminder("40320"), 40320);
  eq(reminder("40321"), 40320, "a longer one is brought back to four weeks");
  eq(reminder("4294967295"), 40320);
  for (const none of ["", "-15", "15.5", "soon", "4294967296", "99999999999", "1e3", "0x10"]) eq(reminder(none), null, `Reminder ${JSON.stringify(none)}`);
  eq(read(item()).reminder, null, "absent");
});

test("calendar-item: MeetingStatus is read as bits, and the address decides who organizes", () => {
  const meeting = (status, organizer = OWN) => read(item([C("MeetingStatus", status), organizer === null ? null : C("OrganizerEmail", organizer)])).meeting;
  const facts = (m) => [m.role, m.cancelled];
  eq(facts(meeting("0")), ["none", false]);
  eq(facts(meeting("1")), ["organizer", false]);
  eq(facts(meeting("3")), ["organizer", false], "received bit set, but the organizer is the mailbox");
  eq(facts(meeting("5")), ["organizer", true]);
  eq(facts(meeting("7")), ["organizer", true]);
  eq(facts(meeting("9")), ["organizer", false], "same as 1");
  eq(facts(meeting("13")), ["organizer", true], "same as 5");
  eq(facts(meeting("255")), ["organizer", true], "unused bits are ignored");
  for (const status of ["2", "4", "6", "8", "254"]) eq(facts(meeting(status)), ["none", false], `${status}: not a meeting`);
  for (const status of ["", "256", "-1", "meeting", "1.0", "0x1"]) eq(facts(meeting(status)), ["none", false], `${JSON.stringify(status)}: unreadable`);
  // Someone else's meeting, whatever the "received" bit says.
  for (const status of ["1", "3", "9", "11"]) eq(facts(meeting(status, "boss@example.org")), ["attendee", false], status);
  for (const status of ["5", "7", "13", "15"]) eq(facts(meeting(status, "boss@example.org")), ["attendee", true], status);
  eq(facts(meeting("0", "boss@example.org")), ["none", false], "an appointment has no role");
  // No organizer, or one whose address cannot be read: never "organizer".
  eq(facts(meeting("1", null)), ["attendee", false]);
  eq(facts(meeting("1", "not an address")), ["attendee", false]);
  eq(facts(meeting("1", `me@example.org${ch(0x200b)}`)), ["attendee", false], "an address that only looks like the mailbox's");
  eq(facts(meeting("1", "me@example.org.evil.example")), ["attendee", false]);
  eq(facts(meeting("1", "ME@Example.ORG")), ["organizer", false], "letter case does not matter");
  eq(facts(meeting("1", " me@example.org ")), ["organizer", false]);
  eq(read(item([C("MeetingStatus", "1"), C("OrganizerEmail", "ME@Example.ORG")]), { ownEmail: "Me@example.org" }).meeting.role, "organizer");
});

test("calendar-item: ResponseRequested and DisallowNewTimeProposal", () => {
  const meeting = (extra, status = "3") => read(item([C("MeetingStatus", status), C("OrganizerEmail", "boss@example.org"), ...extra])).meeting;
  eq(meeting([]).responseRequested, true, "a meeting asks for an answer unless it says otherwise");
  eq(meeting([], "0").responseRequested, false, "an appointment does not");
  eq(meeting([C("ResponseRequested", "0")]).responseRequested, false);
  eq(meeting([C("ResponseRequested", "1")], "0").responseRequested, true);
  eq(meeting([C("ResponseRequested", "2")]).responseRequested, true, "unreadable: the default");
  eq(meeting([]).allowNewTime, true);
  eq(meeting([C("DisallowNewTimeProposal", "1")]).allowNewTime, false);
  eq(meeting([C("DisallowNewTimeProposal", "0")]).allowNewTime, true);
  eq(meeting([C("DisallowNewTimeProposal", "yes")]).allowNewTime, true);
  eq(meeting([C("ResponseType", "3")]).response, "accepted");
});

test("calendar-item: before 14.0 the server does not say what the user answered to someone else's meeting", () => {
  // ResponseType exists from 14.0 on ([MS-ASCAL] 2.2.2.40).
  const meeting = (version, status, organizer, ...extra) => read(item([C("MeetingStatus", status), C("OrganizerEmail", organizer), ...extra]), { version }).meeting;
  eq(meeting("12.1", "3", "boss@example.org").response, null, "someone else's meeting in 12.1: not said");
  eq(meeting("12.1", "7", "boss@example.org").response, null, "cancelled or not");
  eq(meeting("12.1", "3", "boss@example.org", C("ResponseType", "3")).response, null, "an element 12.1 does not define is not read");
  eq(meeting("12.1", "1", OWN).response, "none", "the user's own meeting: no answer of the user's own");
  eq(meeting("12.1", "0", "boss@example.org").response, "none", "an appointment");
  for (const version of ["14.0", "14.1"]) {
    eq(meeting(version, "3", "boss@example.org").response, "none", `${version}: ResponseType absent`);
    eq(meeting(version, "3", "boss@example.org", C("ResponseType", "3")).response, "accepted", `${version}: read as ever`);
    eq(meeting(version, "3", "boss@example.org", C("ResponseType", "5")).response, "not-responded");
  }
  // Not a loss: the item stays writable, and the answer held by Thunderbird's side is kept there.
  const description = read(item([C("MeetingStatus", "3"), C("OrganizerEmail", "boss@example.org"), C("Subject", "Budget")]), { version: "12.1" });
  eq([description.readOnly, description.meeting.role, description.meeting.response], [null, "attendee", null]);
  eq(checkEvent(description, { ownEmail: OWN, fromServer: true }), description, "what a reader may say");
  // What comes from Thunderbird always says it: null is refused there, and never written.
  throws(() => checkEvent(description), isBadItem, "a null from Thunderbird");
  throws(() => checkEvent(description, { ownEmail: OWN }), isBadItem);
  throws(() => writeEvent(description, { version: "12.1" }), isBadItem);
  for (const other of [undefined, "", "needs-action", 0]) throws(() => checkEvent(event({ meeting: { response: other } }), { fromServer: true }), isBadItem, `fromServer accepts null only, not ${String(other)}`);
  eq(valueOf(writeEvent(held(description), { version: "12.1", previous: held(description) }), "Calendar:MeetingStatus"), "3");
});

test("calendar-item: the organizer needs a valid address", () => {
  const organizer = (email, name) => read(item([email === undefined ? null : C("OrganizerEmail", email), name === undefined ? null : C("OrganizerName", name)])).organizer;
  eq(organizer("boss@example.org", "The Boss"), { email: "boss@example.org", name: "The Boss" });
  eq(organizer("boss@example.org"), { email: "boss@example.org", name: "" });
  eq(organizer(undefined, "A name alone"), null);
  for (const bad of ["", "boss", "boss@", "/O=ORG/OU=GROUP/CN=RECIPIENTS/CN=BOSS", "boss@example.org, other@example.org", "Boss <boss@example.org>", `boss@example.org${ch(0x0a)}Bcc: x@example.org`, `${"b".repeat(250)}@example.org`, "b".repeat(100_000)]) {
    eq(organizer(bad, "Name"), null, JSON.stringify(bad.slice(0, 40)));
  }
});

// ── Reading: lists ────────────────────────────────────────────────────────

test("calendar-item: attendees are read with their role and status, and dropped without a valid address", () => {
  const attendee = (email, name, status, type) => C("Attendee", [email === null ? null : C("Email", email), name === null ? null : C("Name", name), status === null ? null : C("AttendeeStatus", status), type === null ? null : C("AttendeeType", type)]);
  const list = (...attendees) => read(item([C("Attendees", attendees)])).attendees;
  eq(list(attendee("a@example.org", "Ann", "0", "1"), attendee("b@example.org", "Bob", "2", "2"), attendee("c@example.org", "Cy", "3", "3"), attendee("d@example.org", "Di", "4", "1"), attendee("e@example.org", "Ed", "5", "1")), [
    person("a@example.org", "Ann", "required", "unknown"),
    person("b@example.org", "Bob", "optional", "tentative"),
    person("c@example.org", "Cy", "resource", "accepted"),
    person("d@example.org", "Di", "required", "declined"),
    person("e@example.org", "Ed", "required", "not-responded"),
  ]);
  eq(list(attendee("a@example.org", null, null, null)), [person("a@example.org")], "defaults");
  for (const out of ["1", "6", "-1", "", "accepted", "03"]) eq(list(attendee("a@example.org", "A", out, "1"))[0].status, "unknown", `AttendeeStatus ${out}`);
  for (const out of ["0", "4", "-1", "", "optional", "02"]) eq(list(attendee("a@example.org", "A", "0", out))[0].role, "required", `AttendeeType ${out}`);
  eq(list(attendee(null, "No address", "3", "1"), attendee("", "Empty", "3", "1"), attendee("not an address", "Bad", "3", "1"), attendee("placeholder text", "Bad", "3", "1"), attendee("ok@example.org", "Ok", "3", "1")), [
    person("ok@example.org", "Ok", "required", "accepted"),
  ]);
  eq(list(attendee("A@Example.org", "First", "3", "1"), attendee("a@example.ORG", "Second", "4", "2")), [person("A@Example.org", "First", "required", "accepted")], "one entry per address");
  eq(list(attendee(" a@example.org ", "Trimmed", "0", "1"))[0].email, "a@example.org");
  eq(list(attendee(`a@example.org${ch(0x202e)}`, "Bidi", "0", "1")), [], "an address is never repaired");
  eq(list(attendee(`${"a".repeat(65)}@example.org`, "Long local part", "0", "1")), []);
  // What is not an Attendee, or sits in the wrong place, is not one.
  eq(read(item([C("Attendees", [C("Email", "a@example.org"), C("Attendee", [C("Attendee", [C("Email", "b@example.org")])]), el("Email:To", "c@example.org")])])).attendees, []);
});

test("calendar-item: 10,000 attendees are cut to 500, 10,000 categories to 50", () => {
  const attendees = Array.from({ length: 10_000 }, (_, i) => C("Attendee", [C("Email", `a${i}@example.org`), C("Name", `N${i}`)]));
  const categories = Array.from({ length: 10_000 }, (_, i) => C("Category", `Category ${i}`));
  const description = read(item([C("Attendees", attendees), C("Categories", categories)]));
  eq(description.attendees.length, 500);
  eq(description.attendees[499], person("a499@example.org", "N499"));
  eq(description.categories.length, 50);
  eq(description.categories[49], "Category 49");
  // Entries that do not count do not use up the room.
  const mostlyBad = Array.from({ length: 10_000 }, (_, i) => C("Attendee", [C("Email", i % 2 ? `a${i}@example.org` : "nobody"), C("Name", "x")]));
  eq(read(item([C("Attendees", mostlyBad)])).attendees.length, 500);
  const repeated = Array.from({ length: 10_000 }, (_, i) => C("Category", i % 100 ? "Same" : `Other ${i}`));
  eq(read(item([C("Categories", repeated)])).categories.length, 50);
});

test("calendar-item: categories are distinct, non-empty names", () => {
  const categories = (...list) => read(item([C("Categories", list.map((name) => C("Category", name)))])).categories;
  eq(categories("Work", "Home", "Work", "", "  ", " Travel ", "home"), ["Work", "Home", "Travel", "home"]);
  eq(categories("__proto__", "constructor", "toString"), ["__proto__", "constructor", "toString"], "names that are property names elsewhere are just names");
  eq(read(item([C("Categories", [C("Subject", "not a category"), el("Tasks:Category", "nor this")])])).categories, []);
});

// ── Reading: time zone ────────────────────────────────────────────────────

test("calendar-item: the time zone is decoded strictly", () => {
  eq(read(item([C("Timezone", SPEC_PACIFIC)])).timezone, PACIFIC);
  eq(read(item([C("Timezone", encodeTimeZone(UTC_ZONE))])).timezone, UTC_ZONE);
  eq(read(item()).timezone, null, "absent");
  const invalid = ["", "AAAA", SPEC_PACIFIC.slice(4), `${SPEC_PACIFIC}AAAA`, "Pacific Standard Time", "Europe/Paris", "A".repeat(100_000)];
  for (const bad of invalid) {
    // A timed event without recurrence does not depend on its zone: it is read without it.
    eq(read(item([C("Timezone", bad)])).timezone, null, `ignored: ${bad.slice(0, 20)}`);
    // Days and recurrences do: the item is refused.
    throws(() => read(item([C("Timezone", bad), C("AllDayEvent", "1")], { end: "20260311T170000Z" })), isBadZone, `all-day: ${bad.slice(0, 20)}`);
    throws(() => read(item([C("Timezone", bad), C("Recurrence", [C("Type", "0")])])), isBadZone, `recurring: ${bad.slice(0, 20)}`);
  }
});

// ── All-day events ────────────────────────────────────────────────────────

test("calendar-item: an all-day event is read as days in its time zone", () => {
  const days = (zoneText, start, end) => {
    const description = read(item([zoneText === null ? null : C("Timezone", zoneText), C("AllDayEvent", "1")], { start, end }));
    assert(description.allDay);
    return [description.start, description.end];
  };
  const pacific = SPEC_PACIFIC;
  // 10 March 2026 in Pacific daylight time: midnight is 07:00 UTC.
  eq(days(pacific, "20260310T070000Z", "20260311T070000Z"), ["2026-03-10", "2026-03-11"]);
  eq(days(pacific, "20260310T070000Z", "20260313T070000Z"), ["2026-03-10", "2026-03-13"], "three days");
  // The day daylight time starts has 23 hours, the day it ends 25.
  eq(days(pacific, "20260308T080000Z", "20260309T070000Z"), ["2026-03-08", "2026-03-09"]);
  eq(days(pacific, "20261101T070000Z", "20261102T080000Z"), ["2026-11-01", "2026-11-02"]);
  eq(days(pacific, "20260307T080000Z", "20260310T070000Z"), ["2026-03-07", "2026-03-10"], "across the change");
  // Southern hemisphere.
  const sydney = encodeTimeZone(SYDNEY);
  eq(days(sydney, "20260404T130000Z", "20260405T140000Z"), ["2026-04-05", "2026-04-06"], "25 hours in Sydney");
  eq(days(sydney, "20261003T140000Z", "20261004T130000Z"), ["2026-10-04", "2026-10-05"], "23 hours in Sydney");
  eq(days(sydney, "20251231T130000Z", "20260101T130000Z"), ["2026-01-01", "2026-01-02"], "new year's day");
  // Without a time zone the days are those of UTC.
  eq(days(null, "20260310T000000Z", "20260311T000000Z"), ["2026-03-10", "2026-03-11"]);
  eq(days(encodeTimeZone(UTC_ZONE), "20260310T000000Z", "20260312T000000Z"), ["2026-03-10", "2026-03-12"]);
});

test("calendar-item: an all-day event lasts whole days from the day it starts, and at least one", () => {
  const days = (start, end, zoneText = SPEC_PACIFIC) => {
    const description = read(item([C("Timezone", zoneText), C("AllDayEvent", "1")], { start, end }));
    return [description.start, description.end];
  };
  eq(days("20260310T070000Z", "20260310T070000Z"), ["2026-03-10", "2026-03-11"], "end equal to start: that day");
  eq(days("20260310T070000Z", "20260311T065959Z"), ["2026-03-10", "2026-03-11"], "an end at 23:59:59");
  eq(days("20260310T070000Z", "20260312T065900Z"), ["2026-03-10", "2026-03-12"], "23:59 of the second day");
  eq(days("20260310T180000Z", "20260310T190000Z"), ["2026-03-10", "2026-03-11"], "inside one day");
  eq(days("20260310T180000Z", "20260311T190000Z"), ["2026-03-10", "2026-03-11"], "25 hours from the afternoon: one day");
  eq(days("20260310T000000Z", "20260311T000000Z"), ["2026-03-09", "2026-03-10"], "UTC midnights seen from Pacific time: one day");
  // A server that adds 24 hours to a day of 23 or 25 hours still means one day.
  eq(days("20260308T080000Z", "20260309T080000Z"), ["2026-03-08", "2026-03-09"], "24 hours on the day daylight time starts");
  eq(days("20261101T070000Z", "20261102T070000Z"), ["2026-11-01", "2026-11-02"], "24 hours on the day it ends");
  eq(days("20260308T080000Z", "20260311T080000Z"), ["2026-03-08", "2026-03-11"], "three times 24 hours");
  eq(days("20260310T070000Z", "20260310T185959Z"), ["2026-03-10", "2026-03-11"], "half a day");
  throws(() => days("20260310T070000Z", "20260310T065959Z"), isBadItem, "end before start");
  // Where midnight comes twice, the second one is a midnight too.
  const twice = encodeTimeZone(TWO_MIDNIGHTS);
  eq(days("20261031T040000Z", "20261101T040000Z", twice), ["2026-10-31", "2026-11-01"], "first midnight of 1 November");
  eq(days("20261031T040000Z", "20261101T050000Z", twice), ["2026-10-31", "2026-11-01"], "second midnight of 1 November");
  eq(days("20261101T050000Z", "20261102T050000Z", twice), ["2026-11-01", "2026-11-02"], "starting at the second midnight");
  // Where midnight is skipped, the day starts at the change (01:00 local).
  const skipped = encodeTimeZone(MIDNIGHT_CHANGES);
  eq(days("20260905T040000Z", "20260906T040000Z", skipped), ["2026-09-05", "2026-09-06"]);
  eq(days("20260906T040000Z", "20260907T030000Z", skipped), ["2026-09-06", "2026-09-07"]);
  // Days outside 1900-2200 are refused, not shifted.
  throws(() => days("19000101T000000Z", "19000102T080000Z"), hasCode("BAD_DATE"), "31 December 1899 in Pacific time");
  throws(() => days("22001231T080000Z", "22001231T235959Z"), hasCode("BAD_DATE"), "the day after the last one");
  eq(days("22001230T080000Z", "22001231T080000Z"), ["2200-12-30", "2200-12-31"], "the last day that can end");
});

test("calendar-item: an all-day event is written as local midnights in its time zone", () => {
  const times = (description) => {
    const elements = written(description);
    return [valueOf(elements, "Calendar:AllDayEvent"), valueOf(elements, "Calendar:StartTime"), valueOf(elements, "Calendar:EndTime")];
  };
  const day = (fields) => event({ allDay: true, start: "2026-03-10", end: "2026-03-11", ...fields });
  eq(times(day({ timezone: PACIFIC })), ["1", "20260310T070000Z", "20260311T070000Z"]);
  eq(times(day({ timezone: PACIFIC, start: "2026-03-08", end: "2026-03-09" })), ["1", "20260308T080000Z", "20260309T070000Z"], "23 hours");
  eq(times(day({ timezone: PACIFIC, start: "2026-11-01", end: "2026-11-02" })), ["1", "20261101T070000Z", "20261102T080000Z"], "25 hours");
  eq(times(day({ timezone: SYDNEY, start: "2026-01-01", end: "2026-01-03" })), ["1", "20251231T130000Z", "20260102T130000Z"]);
  eq(times(day({ timezone: null })), ["1", "20260310T000000Z", "20260311T000000Z"], "no zone: UTC");
  eq(times(day({ timezone: MIDNIGHT_CHANGES, start: "2026-09-06", end: "2026-09-07" })), ["1", "20260906T040000Z", "20260907T030000Z"], "a day that starts at 01:00");
  eq(times(event({ timezone: PACIFIC })), ["0", "20260310T170000Z", "20260310T180000Z"], "a timed event is sent as it is");
});

test("calendar-item: every day of a year, in every zone, survives writing and reading", () => {
  for (const z of ZONES) {
    for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += DAY) {
      const length = 1 + ((ms / DAY) % 3);
      const description = event({ allDay: true, timezone: z, start: formatDate(ms), end: formatDate(ms + length * DAY) });
      const back = read(written(description));
      eq([back.start, back.end, back.allDay], [description.start, description.end, true], `${description.start} in zone ${z.bias}`);
      eq(back.timezone, z);
    }
  }
});

// ── Recurrence and exceptions ─────────────────────────────────────────────

const weekly = C("Recurrence", [C("Type", "1"), C("DayOfWeek", "4")]);
const exception = (...children) => C("Exception", children);
const original = (value = "20260317T170000Z") => C("ExceptionStartTime", value);
const exceptions = (...list) => read(item([weekly, C("Exceptions", list)])).exceptions;

test("calendar-item: a recurrence is read with its exceptions", () => {
  const description = read(item([
    C("Timezone", SPEC_PACIFIC),
    C("Recurrence", [C("Type", "1"), C("Interval", "2"), C("DayOfWeek", "4"), C("Until", "20260630T170000Z"), C("FirstDayOfWeek", "1")]),
    C("Exceptions", [exception(C("Deleted", "1"), original("20260324T170000Z")), exception(original("20260407T170000Z"), C("Subject", "Moved"), C("StartTime", "20260408T170000Z"), C("EndTime", "20260408T183000Z"))]),
  ]));
  eq(description.recurrence, rule({ freq: "weekly", interval: 2, until: "2026-06-30T17:00:00Z", byDay: ["TU"], weekStart: "MO" }));
  eq(description.exceptions, [
    { originalStart: "2026-03-24T17:00:00Z", deleted: true, changes: {} },
    { originalStart: "2026-04-07T17:00:00Z", deleted: false, changes: { summary: "Moved", start: "2026-04-08T17:00:00Z", end: "2026-04-08T18:30:00Z" } },
  ]);
});

test("calendar-item: an invalid recurrence makes the item invalid", () => {
  for (const fields of [[], [C("Type", "4")], [C("Type", "1")], [C("Type", "2"), C("DayOfMonth", "32")], [C("Type", "0"), C("Type", "0")], [C("Type", "0"), C("Until", "tomorrow")], [C("Type", "5"), C("DayOfMonth", "30")]]) {
    throws(() => read(item([C("Recurrence", fields)])), isBadRecurrence, JSON.stringify(fields.map(shape)));
  }
  throws(() => read(item([C("Recurrence", "daily")])), isBadRecurrence, "text instead of elements");
});

test("calendar-item: a recurrence in another calendar is not converted, and the item is read-only", () => {
  const lunar = read(item([
    C("Subject", "Lunar new year"),
    C("Recurrence", [C("Type", "5"), C("DayOfMonth", "1"), C("MonthOfYear", "1"), C("CalendarType", "15")]),
    C("Exceptions", [exception(C("Deleted", "1"), original())]),
  ]));
  eq([lunar.recurrence, lunar.exceptions, lunar.readOnly], [null, [], "calendar-type"]);
  eq(lunar.summary, "Lunar new year", "the first occurrence is still shown");
  throws(() => written(lunar), hasCode("READ_ONLY_ITEM"), "and never written back: its recurrence would be erased");
  eq(read(item([C("Recurrence", [C("Type", "5"), C("DayOfMonth", "1"), C("MonthOfYear", "1"), C("IsLeapMonth", "1")])])).readOnly, "calendar-type");
});

test("calendar-item: a recurrence Thunderbird cannot be given is left out, and the event is shown once, read-only", () => {
  const monthly = (day, interval) => C("Recurrence", [C("Type", "2"), C("DayOfMonth", String(day)), C("Interval", String(interval))]);
  const yearly = (day, month, interval) => C("Recurrence", [C("Type", "5"), C("DayOfMonth", String(day)), C("MonthOfYear", String(month)), C("Interval", String(interval))]);
  const from = (day, ...children) => read(item(children, { start: `${day}T090000Z`, end: `${day}T100000Z` }));
  const leftOut = (description, what) => {
    eq([description.recurrence, description.exceptions, description.readOnly], [null, [], "unsupported-recurrence"], what);
    throws(() => written(held(description)), hasCode("READ_ONLY_ITEM"), `${what}: never written back`);
  };
  // The item that blanks a whole calendar in Thunderbird 140: day 31 every 12 months, from a February.
  const blank = from("20250210", C("Subject", "Closing"), monthly(31, 12), C("Exceptions", [exception(C("Deleted", "1"), original("20260210T090000Z"))]));
  leftOut(blank, "day 31 every 12 months from February");
  eq([blank.summary, blank.start, blank.end], ["Closing", "2025-02-10T09:00:00Z", "2025-02-10T10:00:00Z"], "its first occurrence is still shown");
  // A day 29, 30 or 31 that none of the first four periods has.
  for (const [day, number, interval] of [["20250210", 31, 24], ["20250210", 30, 12], ["20250210", 30, 24], ["20250210", 29, 24], ["20250410", 31, 12], ["20250610", 31, 36], ["20970210", 29, 12]]) {
    leftOut(from(day, monthly(number, interval)), `day ${number} every ${interval} months from ${day}`);
  }
  // The same rules, where one of them has it.
  for (const [day, number, interval] of [["20250310", 31, 12], ["20250210", 31, 1], ["20250210", 31, 2], ["20250610", 31, 10], ["20250210", 29, 12], ["20260210", 29, 24], ["20250210", 30, 11], ["20250210", 28, 12], ["20240210", 29, 48]]) {
    const description = from(day, monthly(number, interval));
    eq([description.recurrence?.byMonthDay, description.recurrence?.interval, description.readOnly], [number, interval, null], `day ${number} every ${interval} months from ${day}`);
  }
  // A yearly date: one the month never has, or a 29 February that does not come.
  leftOut(from("20250210", yearly(30, 2, 1)), "30 February");
  leftOut(from("20250210", yearly(31, 4, 1)), "31 April");
  leftOut(from("20250310", yearly(29, 2, 2)), "29 February every 2 years from 2025");
  leftOut(from("20250310", yearly(29, 2, 4)), "29 February every 4 years from 2025");
  leftOut(from("20970310", yearly(29, 2, 1)), "29 February every year from 2097: 2100 is not a leap year");
  eq(from("20250310", yearly(29, 2, 1)).recurrence, rule({ freq: "yearly", byMonth: 2, byMonthDay: 29 }), "29 February every year");
  eq(from("20260310", yearly(29, 2, 2)).readOnly, null, "2028 is the second period");
  eq(from("20240310", yearly(29, 2, 4)).readOnly, null, "2024 itself");
  // The first day is the day the event starts in its own zone: 1 March 02:00 UTC is still February on the Pacific.
  const late = (...zoned) => read(item([...zoned, monthly(31, 12)], { start: "20250301T020000Z", end: "20250301T030000Z" }));
  leftOut(late(C("Timezone", SPEC_PACIFIC)), "February in its zone");
  eq(late().readOnly, null, "March in UTC");

  // An event longer than the period of its rule: Thunderbird would find thousands of occurrences at once.
  const lasting = (ms, ...fields) => read(item([C("Recurrence", fields)], { end: formatCompact(Date.UTC(2026, 2, 10, 17) + ms) }));
  for (const [what, unit, fields] of [
    ["daily", DAY, [C("Type", "0")]],
    ["weekly", 7 * DAY, [C("Type", "1"), C("DayOfWeek", "4")]],
    ["monthly", 31 * DAY, [C("Type", "2"), C("DayOfMonth", "10")]],
    ["monthly on the nth day", 31 * DAY, [C("Type", "3"), C("WeekOfMonth", "2"), C("DayOfWeek", "4")]],
    ["yearly", 366 * DAY, [C("Type", "5"), C("DayOfMonth", "10"), C("MonthOfYear", "3")]],
    ["yearly on the nth day", 366 * DAY, [C("Type", "6"), C("WeekOfMonth", "2"), C("DayOfWeek", "4"), C("MonthOfYear", "3")]],
  ]) {
    for (const interval of [1, 3]) {
      eq(lasting(interval * unit, ...fields, C("Interval", String(interval))).readOnly, null, `${what}, every ${interval}: exactly as long as its period`);
      leftOut(lasting(interval * unit + 1000, ...fields, C("Interval", String(interval))), `${what}, every ${interval}: one second longer`);
    }
  }
  leftOut(read(item([C("Subject", "For ever"), C("Recurrence", [C("Type", "0")])], { start: "19000101T000000Z", end: "22001231T000000Z" })), "a daily event of three centuries");
  const days = (count, ...fields) => read(item([C("AllDayEvent", "1"), C("Recurrence", fields)], { start: "20260310T000000Z", end: formatCompact(Date.UTC(2026, 2, 10 + count)) }));
  eq(days(1, C("Type", "0")).readOnly, null, "one day, every day");
  leftOut(days(2, C("Type", "0")), "two days, every day");
  eq(days(2, C("Type", "0"), C("Interval", "2")).readOnly, null, "two days, every other day");
  eq(days(7, C("Type", "1"), C("DayOfWeek", "4")).readOnly, null, "seven days, every week");
  leftOut(days(8, C("Type", "1"), C("DayOfWeek", "4")), "eight days, every week");
  // The reason stays, whatever else the description does not hold.
  eq(from("20250210", monthly(31, 12), C("Subject", "s".repeat(2000)), C("Sensitivity", "1")).readOnly, "unsupported-recurrence");
  // A known difference, which is not refused: day 31 of every month skips the shorter months in Thunderbird.
  eq(from("20250131", monthly(31, 1)).recurrence, rule({ freq: "monthly", byMonthDay: 31 }));
});

test("calendar-item: checkEvent refuses, in a description from Thunderbird, the recurrences a reader leaves out", () => {
  const at = (day, recurrence, fields = {}) => event({ start: `${day}T09:00:00Z`, end: `${day}T10:00:00Z`, recurrence, ...fields });
  const refused = (description, what) => {
    throws(() => checkEvent(description), isBadRecurrence, what);
    throws(() => checkEvent(description, { fromServer: true }), isBadRecurrence, `${what}: from a reader too`);
    throws(() => written(description), isBadRecurrence, `${what}: not written either`);
  };
  // A day that does not come in the first four periods.
  refused(at("2025-02-10", rule({ freq: "monthly", interval: 12, byMonthDay: 31 })), "day 31 every 12 months from February");
  refused(at("2025-04-10", rule({ freq: "monthly", interval: 12, byMonthDay: 31 })), "day 31 every 12 months from April");
  refused(at("2025-02-10", rule({ freq: "monthly", interval: 24, byMonthDay: 29 })), "day 29 every 24 months from February 2025");
  refused(at("2025-03-10", rule({ freq: "yearly", interval: 2, byMonth: 2, byMonthDay: 29 })), "29 February every 2 years from 2025");
  eq(checkEvent(at("2025-03-10", rule({ freq: "monthly", interval: 12, byMonthDay: 31 }))).recurrence.byMonthDay, 31, "from March");
  eq(checkEvent(at("2026-03-10", rule({ freq: "yearly", interval: 2, byMonth: 2, byMonthDay: 29 }))).recurrence.interval, 2, "from 2026");
  // The day and the month that a rule leaves to the start of the event.
  refused(at("2025-01-31", rule({ freq: "yearly", byMonth: 2 })), "the 31st of the start, in February");
  refused(at("2025-01-29", rule({ freq: "yearly", interval: 2, byMonth: 2 })), "the 29th of the start, in the February of odd years");
  eq(checkEvent(at("2025-01-29", rule({ freq: "yearly", byMonth: 2 }))).recurrence.byMonth, 2, "the 29th of the start, in every February: 2028 has it");
  eq(checkEvent(at("2025-01-31", rule({ freq: "monthly", interval: 12 }))).recurrence.interval, 12, "the day of the start comes in its own month");
  eq(checkEvent(at("2024-02-29", rule({ freq: "yearly", interval: 3 }))).recurrence.freq, "yearly", "the date of the start comes in its own year");
  // In the zone of the event: 1 March 02:00 UTC is February on the Pacific, March in Paris and in UTC.
  const late = (timezone) => event({ start: "2025-03-01T02:00:00Z", end: "2025-03-01T03:00:00Z", timezone, recurrence: rule({ freq: "monthly", interval: 12, byMonthDay: 31 }) });
  refused(late(PACIFIC), "February in its zone");
  eq(checkEvent(late(null)).readOnly, null);
  eq(checkEvent(late(PARIS)).readOnly, null);
  // All-day: the day itself.
  refused(event({ allDay: true, start: "2025-02-28", end: "2025-03-01", recurrence: rule({ freq: "monthly", interval: 12, byMonthDay: 30 }) }), "an all-day event of February");
  // Longer than the period of its rule.
  refused(event({ end: "2026-03-11T17:00:01Z", recurrence: rule({}) }), "a day and a second, every day");
  eq(checkEvent(event({ end: "2026-03-11T17:00:00Z", recurrence: rule({}) })).end, "2026-03-11T17:00:00Z", "exactly a day");
  eq(checkEvent(event({ end: "2026-03-12T17:00:00Z", recurrence: rule({ interval: 2 }) })).recurrence.interval, 2, "two days, every other day");
  refused(event({ allDay: true, start: "2026-03-10", end: "2026-03-12", recurrence: rule({}) }), "two days, every day");
  refused(event({ allDay: true, start: "2026-03-10", end: "2026-03-12", recurrence: rule({ byDay: ["MO", "TU", "WE", "TH", "FR"] }) }), "two days, every weekday");
  refused(event({ allDay: true, start: "2026-03-10", end: "2026-03-18", recurrence: rule({ freq: "weekly" }) }), "eight days, every week");
  eq(checkEvent(event({ allDay: true, start: "2026-03-10", end: "2026-03-17", recurrence: rule({ freq: "weekly" }) })).end, "2026-03-17", "seven days");
  refused(event({ allDay: true, start: "2026-03-10", end: "2026-04-11", recurrence: rule({ freq: "monthly" }) }), "32 days, every month");
  eq(checkEvent(event({ allDay: true, start: "2026-03-10", end: "2026-04-10", recurrence: rule({ freq: "monthly" }) })).end, "2026-04-10", "31 days");
  refused(event({ allDay: true, start: "2026-03-10", end: "2027-03-12", recurrence: rule({ freq: "yearly" }) }), "367 days, every year");
  eq(checkEvent(event({ allDay: true, start: "2026-03-10", end: "2027-03-11", recurrence: rule({ freq: "yearly" }) })).end, "2027-03-11", "366 days");
  refused(event({ start: "1900-01-01T00:00:00Z", end: "2200-12-31T00:00:00Z", recurrence: rule({}) }), "three centuries, every day");
  // An occurrence may be as long as it likes: it is one item, not a rule. And so may an event that does not recur.
  const long = { originalStart: "2026-03-17T17:00:00Z", deleted: false, changes: { start: "2026-03-17T17:00:00Z", end: "2026-03-27T17:00:00Z" } };
  eq(checkEvent(event({ recurrence: rule({}), exceptions: [long] })).exceptions.length, 1);
  eq(checkEvent(event({ start: "1900-01-01T00:00:00Z", end: "2200-12-31T00:00:00Z" })).recurrence, null);
  // The reason names the rule that was broken, never a date.
  const reason = throws(() => checkEvent(event({ end: "2026-03-12T17:00:00Z", recurrence: rule({}) })), isBadRecurrence).message;
  assert(!/2026/.test(reason) && reason.length < 120, reason);
});

test("calendar-item: exceptions without a recurrence are not read", () => {
  eq(read(item([C("Exceptions", [exception(C("Deleted", "1"), original())])])).exceptions, []);
  // Not even checked: they belong to nothing.
  eq(read(item([C("Exceptions", [exception(C("Subject", "no start"))])])).exceptions, []);
});

test("calendar-item: each element of an exception changes the occurrence", () => {
  const one = (...children) => exceptions(exception(original(), ...children))[0].changes;
  eq(one(), {}, "nothing but the occurrence itself");
  eq(one(C("Subject", "Other")), { summary: "Other" });
  eq(one(C("Location", "Elsewhere")), { location: "Elsewhere" });
  eq(one(body("1", "Notes for that day")), { description: "Notes for that day" });
  eq(one(body("2", "<p>html</p>")), {}, "an HTML body is not read");
  eq(one(body("1")), {}, "a body without data says nothing");
  eq(one(C("StartTime", "20260317T180000Z"), C("EndTime", "20260317T190000Z")), { start: "2026-03-17T18:00:00Z", end: "2026-03-17T19:00:00Z" });
  eq(one(C("StartTime", "20260317T180000Z")), { start: "2026-03-17T18:00:00Z" });
  eq(one(C("EndTime", "20260317T190000Z")), { end: "2026-03-17T19:00:00Z" });
  eq(one(C("BusyStatus", "0")), { busy: "free" });
  eq(one(C("BusyStatus", "9")), {}, "out of range: inherited");
  eq(one(C("Sensitivity", "3")), { privacy: "confidential" });
  eq(one(C("Sensitivity", "x")), {});
  eq(one(C("Reminder", "30")), { reminder: 30 });
  eq(one(C("Reminder", "99999")), { reminder: 40320 });
  eq(one(C("Reminder", "soon")), {});
  eq(one(C("Categories", [C("Category", "Once")])), { categories: ["Once"] });
  eq(one(C("Attendees", [C("Attendee", [C("Email", "a@example.org"), C("Name", "A"), C("AttendeeStatus", "4")])])), { attendees: [person("a@example.org", "A", "required", "declined")] });
  eq(one(C("MeetingStatus", "5")), { cancelled: true });
  eq(one(C("MeetingStatus", "1")), { cancelled: false });
  eq(one(C("MeetingStatus", "x")), {});
  eq(one(C("AllDayEvent", "0")), { allDay: false });
  eq(one(C("DtStamp", "20260301T000000Z"), C("UID", "other"), C("Timezone", "x"), C("Recurrence", [C("Type", "0")]), C("Exceptions", [])), {}, "what an exception cannot carry is ignored");
});

test("calendar-item: an empty element in an exception removes the inherited value", () => {
  const changes = exceptions(exception(original(), C("Subject"), C("Location"), C("Reminder"), C("Categories"), C("Attendees"), A("Body")))[0].changes;
  eq(changes, { summary: "", location: "", description: "", reminder: null, categories: [], attendees: [] });
});

test("calendar-item: a deleted occurrence carries nothing else", () => {
  eq(exceptions(exception(original(), C("Deleted", "1"), C("Subject", "ignored"), C("StartTime", "not even a date"))), [{ originalStart: "2026-03-17T17:00:00Z", deleted: true, changes: {} }]);
  for (const notDeleted of ["0", "2", "", "true"]) eq(exceptions(exception(original(), C("Deleted", notDeleted)))[0].deleted, false, `Deleted ${notDeleted}`);
});

test("calendar-item: an exception that cannot be read makes the item invalid", () => {
  throws(() => exceptions(exception(C("Subject", "no original start"))), isBadItem);
  throws(() => exceptions(exception(C("Deleted", "1"))), isBadItem, "not even a deleted one");
  for (const bad of ["", "2026-03-17T17:00:00Z", "20260230T170000Z", "18990101T000000Z", "x"]) throws(() => exceptions(exception(original(bad))), isBadItem, `ExceptionStartTime ${bad}`);
  throws(() => exceptions(exception(original(), C("StartTime", "x"))), isBadItem);
  throws(() => exceptions(exception(original(), C("EndTime", "20260230T170000Z"))), isBadItem);
  throws(() => exceptions(exception(original(), C("StartTime", "20260317T180000Z"), C("EndTime", "20260317T175959Z"))), isBadItem, "end before start");
  throws(() => exceptions(exception(original(), original())), isBadItem, "two original starts");
  throws(() => exceptions(exception(original(), C("Subject", "a"), C("Subject", "b"))), isBadItem);
  throws(() => exceptions(exception(original()), exception(original())), isBadItem, "two exceptions for one occurrence");
  throws(() => exceptions(exception(original()), exception(original(), C("Deleted", "1"))), isBadItem);
});

test("calendar-item: 256 exceptions are read, one more is refused, and so are 10,000", () => {
  const many = (count, step = 7 * DAY) => Array.from({ length: count }, (_, i) => exception(C("Deleted", "1"), original(formatCompact(Date.UTC(2026, 2, 17, 17) + i * step))));
  const list = exceptions(...many(256));
  eq(list.length, 256);
  eq(list[255].originalStart, formatUtc(Date.UTC(2026, 2, 17, 17) + 255 * 7 * DAY));
  throws(() => exceptions(...many(257)), isBadItem, "257");
  throws(() => exceptions(...many(10_000, HOUR)), isBadItem, "10,000");
  // Other elements among them do not count.
  eq(read(item([weekly, C("Exceptions", [...many(256), C("Subject", "x"), el("Tasks:Subject", "y")])])).exceptions.length, 256);
});

test("calendar-item: exceptions of an all-day series are days in its zone", () => {
  const description = read(item([
    C("Timezone", SPEC_PACIFIC),
    C("AllDayEvent", "1"),
    C("Recurrence", [C("Type", "0"), C("Until", "20260320T070000Z")]),
    C("Exceptions", [
      exception(C("Deleted", "1"), original("20260312T070000Z")),
      exception(original("20260307T080000Z"), C("Subject", "Before the change")),
      exception(original("20260314T070000Z"), C("StartTime", "20260315T070000Z"), C("EndTime", "20260317T070000Z")),
      exception(original("20260316T070000Z"), C("AllDayEvent", "0"), C("StartTime", "20260316T170000Z"), C("EndTime", "20260316T180000Z")),
    ]),
  ], { start: "20260306T080000Z", end: "20260307T080000Z" }));
  eq([description.start, description.end, description.recurrence.until], ["2026-03-06", "2026-03-07", "2026-03-20"]);
  eq(description.exceptions, [
    { originalStart: "2026-03-12", deleted: true, changes: {} },
    { originalStart: "2026-03-07", deleted: false, changes: { summary: "Before the change" } },
    { originalStart: "2026-03-14", deleted: false, changes: { start: "2026-03-15", end: "2026-03-17" } },
    { originalStart: "2026-03-16", deleted: false, changes: { allDay: false, start: "2026-03-16T17:00:00Z", end: "2026-03-16T18:00:00Z" } },
  ]);
  // Written back, each one is the midnight of its day: 08:00 UTC before 8 March, 07:00 after.
  const sent = valueOf(written(description), "Calendar:Exceptions").map(([, children]) => children.filter(([name]) => /Time$/.test(name)));
  eq(sent, [
    [["Calendar:ExceptionStartTime", "20260312T070000Z"]],
    [["Calendar:ExceptionStartTime", "20260307T080000Z"]],
    [["Calendar:ExceptionStartTime", "20260314T070000Z"], ["Calendar:StartTime", "20260315T070000Z"], ["Calendar:EndTime", "20260317T070000Z"]],
    [["Calendar:ExceptionStartTime", "20260316T070000Z"], ["Calendar:StartTime", "20260316T170000Z"], ["Calendar:EndTime", "20260316T180000Z"]],
  ]);
  // Two occurrences of the same day are one too many.
  throws(() => read(item([C("AllDayEvent", "1"), weekly, C("Exceptions", [exception(original("20260317T000000Z")), exception(original("20260317T120000Z"))])], { end: "20260311T170000Z" })), isBadItem);
});

// ── Reading: an item that holds more than its description ─────────────────

const attendeeOf = (email, ...more) => C("Attendee", [email === null ? null : C("Email", email), C("Name", "N"), ...more]);
const meetingOf = (status, organizer) => [C("MeetingStatus", status), organizer === null ? null : C("OrganizerEmail", organizer)];
const allDayIn = (zoneText, start, end, extra = []) => item([C("Timezone", zoneText), C("AllDayEvent", "1"), ...extra], { start, end });
const oneYearZone = (() => {
  // The Pacific rules as the dates of 2007 only: nothing that applies to another year.
  const bytes = new Uint8Array(172);
  const words = (at, list) => list.forEach((w, k) => {
    bytes[at + 2 * k] = w & 0xff;
    bytes[at + 2 * k + 1] = w >> 8;
  });
  bytes[0] = 0xe0;
  bytes[1] = 0x01;
  words(68, [2007, 11, 0, 4, 2, 0, 0, 0]);
  words(152, [2007, 3, 0, 11, 2, 0, 0, 0]);
  bytes.set([0xc4, 0xff, 0xff, 0xff], 168);
  let text = "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < 171; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    text += alphabet[n >> 18] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  return `${text}${alphabet[bytes[171] >> 2]}${alphabet[(bytes[171] & 3) << 4]}==`;
})();

/** Items of which the description holds less than the server: [what, children, version]. */
const LOSSY_ITEMS = [
  ["a Subject of 1025 characters", item([C("Subject", "s".repeat(1025))])],
  ["a Location of 1025 characters", item([C("Location", "l".repeat(1025))])],
  ["megabytes of Subject", item([C("Subject", "é".repeat(1_000_000))])],
  ["a Subject hidden behind kilobytes of control characters", item([C("Subject", `${ch(0x01).repeat(6000)}hidden`)])],
  ["elements where the Subject should be", item([C("Subject", [C("Subject", "nested")])])],
  ["a right-to-left override in the Subject", item([C("Subject", `invoice${ch(0x202e)}fdp.exe`)])],
  ["a zero-width space in the Location", item([C("Location", `Room${ch(0x200b)}4`)])],
  ["a byte order mark in the body", item([body("1", `Agenda${ch(0xfeff)}`)])],
  ["a soft hyphen in a category", item([C("Categories", [C("Category", `co${ch(0x00ad)}op`)])])],
  ["a tag character after a flag in the Subject", item([C("Subject", `${cp(0x1f3f4, 0xe0067, 0xe0062, 0xe007f)} match`)])],
  ["a text longer than the description", item([body("1", "d".repeat(32769))])],
  ["a text the server truncated", item([body("1", "beginning", [A("EstimatedDataSize", "500000"), A("Truncated", "1")])])],
  ["a truncated text sent without its data", item([A("Body", [A("Type", "1"), A("EstimatedDataSize", "5000"), A("Truncated", "1")])])],
  ["a body in HTML only", item([body("2", "<p>Agenda</p>")])],
  ["a body in RTF, truncated to nothing", item([A("Body", [A("Type", "3"), A("EstimatedDataSize", "5669"), A("Truncated", "1")])])],
  ["more bodies than are looked at, none in plain text", item(Array.from({ length: 9 }, () => A("Body", [A("Type", "2")])))],
  ["text where the body should hold elements", item([A("Body", "just text")])],
  ["an attendee without an address", item([C("Attendees", [attendeeOf("a@example.org"), attendeeOf(null)])])],
  ["an attendee whose address is a placeholder", item([C("Attendees", [attendeeOf("Unknown recipient")])])],
  ["an attendee whose address is a directory name", item([C("Attendees", [attendeeOf("/O=ORG/OU=GROUP/CN=RECIPIENTS/CN=ANN")])])],
  ["two attendees with one address", item([C("Attendees", [attendeeOf("a@example.org"), attendeeOf("A@EXAMPLE.ORG")])])],
  ["501 attendees", item([C("Attendees", Array.from({ length: 501 }, (_, i) => attendeeOf(`a${i}@example.org`)))])],
  ["10,000 attendees", item([C("Attendees", Array.from({ length: 10_000 }, (_, i) => attendeeOf(`a${i}@example.org`)))])],
  ["an attendee name of 257 characters", item([C("Attendees", [C("Attendee", [C("Email", "a@example.org"), C("Name", "n".repeat(257))])])])],
  ["an attendee status that does not exist", item([C("Attendees", [attendeeOf("a@example.org", C("AttendeeStatus", "1"))])])],
  ["an attendee type that does not exist", item([C("Attendees", [attendeeOf("a@example.org", C("AttendeeType", "9"))])])],
  ["51 categories", item([C("Categories", Array.from({ length: 51 }, (_, i) => C("Category", `c${i}`)))])],
  ["10,000 categories", item([C("Categories", Array.from({ length: 10_000 }, (_, i) => C("Category", `c${i}`)))])],
  ["an empty category", item([C("Categories", [C("Category", "Work"), C("Category")])])],
  ["a category of blanks", item([C("Categories", [C("Category", "   ")])])],
  ["the same category twice", item([C("Categories", [C("Category", "Work"), C("Category", "Work")])])],
  ["a category of 256 characters", item([C("Categories", [C("Category", "c".repeat(256))])])],
  ["BusyStatus 4, working elsewhere", item([C("BusyStatus", "4")])],
  ["an unreadable BusyStatus", item([C("BusyStatus", "busy")])],
  ["Sensitivity 1, personal", item([C("Sensitivity", "1")])],
  ["a Sensitivity that does not exist", item([C("Sensitivity", "9")])],
  ["a reminder of more than four weeks", item([C("Reminder", "40321")])],
  ["an unreadable reminder", item([C("Reminder", "soon")])],
  ["an unreadable AllDayEvent", item([C("AllDayEvent", "2")])],
  ["an unreadable DtStamp", item([C("DtStamp", "2026-03-01")])],
  ["an unreadable MeetingStatus", item([C("MeetingStatus", "meeting")])],
  ["a meeting the server says is the user's, organized by another address (an alias)", item(meetingOf("1", "alias@example.org"))],
  ["a meeting the server says was received, organized by the mailbox", item(meetingOf("3", OWN))],
  ["a meeting the user organizes, without an organizer", item(meetingOf("1", null))],
  ["a cancelled appointment", item(meetingOf("4", OWN))],
  ["an organizer whose address is a directory name", item([C("OrganizerEmail", "/O=ORG/CN=BOSS"), C("OrganizerName", "Boss")])],
  ["an organizer name without an address", item([C("OrganizerName", "Boss")])],
  ["an organizer name of 257 characters", item([C("OrganizerEmail", "boss@example.org"), C("OrganizerName", "n".repeat(257))])],
  ["an unreadable ResponseRequested", item([C("ResponseRequested", "2")])],
  ["an unreadable DisallowNewTimeProposal", item([C("DisallowNewTimeProposal", "no")])],
  ["a time zone that cannot be decoded", item([C("Timezone", "Pacific Standard Time")])],
  ["a time zone with the changes of one year", item([C("Timezone", oneYearZone)])],
  ["an all-day event that starts in the afternoon", allDayIn(SPEC_PACIFIC, "20260310T180000Z", "20260311T070000Z")],
  ["an all-day event that ends at 23:59:59", allDayIn(SPEC_PACIFIC, "20260310T070000Z", "20260311T065959Z")],
  ["an all-day event of no length", allDayIn(SPEC_PACIFIC, "20260310T070000Z", "20260310T070000Z")],
  ["an all-day event at UTC midnights, in another zone", allDayIn(SPEC_PACIFIC, "20260310T000000Z", "20260311T000000Z")],
  ["an all-day event of 24 hours on a day of 23", allDayIn(SPEC_PACIFIC, "20260308T080000Z", "20260309T080000Z")],
  ["a recurrence in the Gregorian calendar of the United States", item([C("Recurrence", [C("Type", "2"), C("DayOfMonth", "10"), C("CalendarType", "2")])])],
  ["a recurrence in a transliterated Gregorian calendar", item([C("Recurrence", [C("Type", "2"), C("DayOfMonth", "10"), C("CalendarType", "11")])])],
  ["FirstDayOfWeek, which 12.1 cannot write back", item([C("Recurrence", [C("Type", "1"), C("DayOfWeek", "4"), C("FirstDayOfWeek", "1")])]), "12.1"],
  ["FirstDayOfWeek, which 14.0 cannot write back", item([C("Recurrence", [C("Type", "1"), C("DayOfWeek", "4"), C("FirstDayOfWeek", "1")])]), "14.0"],
];
const inException = (...children) => item([weekly, C("Exceptions", [exception(original(), ...children)])]);
const LOSSY_EXCEPTIONS = [
  ["a Subject of 1025 characters", inException(C("Subject", "s".repeat(1025)))],
  ["a Location of 1025 characters", inException(C("Location", "l".repeat(1025)))],
  ["a body in HTML only", inException(body("2", "<p>Notes</p>"))],
  ["a left-to-right mark in the Subject", inException(C("Subject", `Other${ch(0x200e)}`))],
  ["a word joiner in the body", inException(body("1", `No${ch(0x2060)}tes`))],
  ["a right-to-left isolate in a category", inException(C("Categories", [C("Category", `${ch(0x2067)}Once`)]))],
  ["a text the server truncated", inException(body("1", "beginning", [A("Truncated", "1")]))],
  ["BusyStatus 4", inException(C("BusyStatus", "4"))],
  ["Sensitivity 1, personal", inException(C("Sensitivity", "1"))],
  ["an unreadable Sensitivity", inException(C("Sensitivity", "private"))],
  ["a reminder of more than four weeks", inException(C("Reminder", "99999"))],
  ["an unreadable reminder", inException(C("Reminder", "soon"))],
  ["no reminder for one occurrence, which 14.0 cannot write back", inException(C("Reminder")), "14.0"],
  ["no reminder for one occurrence, which 12.1 cannot write back", inException(C("Reminder")), "12.1"],
  ["attendees of one occurrence, which 12.1 cannot write back", inException(C("Attendees", [attendeeOf("a@example.org")])), "12.1"],
  ["an attendee without a usable address", inException(C("Attendees", [attendeeOf("nobody")]))],
  ["an empty category", inException(C("Categories", [C("Category")]))],
  ["an unreadable AllDayEvent", inException(C("AllDayEvent", "yes"))],
  ["an unreadable MeetingStatus", inException(C("MeetingStatus", "cancelled"))],
  ["a cancelled occurrence of an appointment", inException(C("MeetingStatus", "5"))],
  ["an occurrence that is a meeting, in a series that is not", inException(C("MeetingStatus", "1"))],
  ["an all-day occurrence that does not start at midnight", inException(C("AllDayEvent", "1"), C("StartTime", "20260317T090000Z"), C("EndTime", "20260318T000000Z"))],
  ["an all-day occurrence that does not end at midnight", inException(C("AllDayEvent", "1"), C("EndTime", "20260318T235959Z"))],
  [
    "an occurrence of an all-day series that is not at midnight",
    allDayIn(SPEC_PACIFIC, "20260310T070000Z", "20260311T070000Z", [C("Recurrence", [C("Type", "0")]), C("Exceptions", [exception(original("20260312T090000Z"), C("Subject", "x"))])]),
  ],
];

test("calendar-item: an item that holds more than its description is read-only, and cannot be written back", () => {
  for (const [what, children, version = "14.1"] of [...LOSSY_ITEMS, ...LOSSY_EXCEPTIONS.map(([what, ...rest]) => [`in an exception: ${what}`, ...rest])]) {
    const description = readEvent(received(children.filter(Boolean)), { version, ownEmail: OWN });
    eq(description.readOnly, "incomplete", what);
    eq(checkEvent(description), description, `${what}: a valid description`);
    for (const target of PROTOCOL_VERSIONS) throws(() => writeEvent(description, { version: target }), hasCode("READ_ONLY_ITEM"), `${what}: written in ${target}`);
    throws(() => writeEvent(description, { version, previous: description }), hasCode("READ_ONLY_ITEM"), `${what}: written as a change`);
  }
});

test("calendar-item: a hostile, oversized item is read within the bounds, as incomplete, and never written back", () => {
  const hostile = read(item([
    C("Subject", "s".repeat(100_000)),
    C("Location", ch(0x202e).repeat(5000)),
    body("2", "<script>alert(1)</script>"),
    C("Attendees", Array.from({ length: 10_000 }, (_, i) => attendeeOf(i % 3 ? `a${i}@example.org` : `nobody ${i}`, C("AttendeeStatus", "9")))),
    C("Categories", Array.from({ length: 10_000 }, (_, i) => C("Category", `${i} `.padEnd(1000, "c")))),
    C("BusyStatus", "255"),
    C("Sensitivity", "1"),
    C("Reminder", "4294967295"),
    C("MeetingStatus", "7"),
    C("OrganizerEmail", "/O=ORG/CN=BOSS"),
    C("OrganizerName", "n".repeat(10_000)),
    C("Timezone", oneYearZone),
    C("Recurrence", [C("Type", "1"), C("DayOfWeek", "127"), C("CalendarType", "12"), C("FirstDayOfWeek", "6")]),
    C("Exceptions", Array.from({ length: 256 }, (_, i) => exception(original(formatCompact(Date.UTC(2026, 2, 11, 17) + i * DAY)), C("Subject", "x".repeat(5000)), C("Sensitivity", "1"), body("2", "<p>x</p>")))),
  ]));
  eq(hostile.readOnly, "incomplete");
  eq([hostile.summary.length, hostile.location, hostile.description, hostile.attendees.length, hostile.categories.length], [1024, "", "", 500, 50]);
  eq([hostile.busy, hostile.privacy, hostile.reminder, hostile.organizer, hostile.meeting.role, hostile.meeting.cancelled], ["busy", "private", 40320, null, "attendee", true]);
  eq(hostile.timezone, { bias: 480, standard: { bias: 0, change: null }, daylight: { bias: 0, change: null } });
  eq(hostile.exceptions.length, 256);
  eq(hostile.exceptions[255].changes, { summary: "x".repeat(1024), privacy: "private" });
  assert(JSON.stringify(hostile).length < 500_000, "a bounded description");
  for (const version of PROTOCOL_VERSIONS) throws(() => writeEvent(hostile, { version }), hasCode("READ_ONLY_ITEM"), version);
  // Not even by taking the mark off: the description is what would be written, and it is not the item.
  const forced = writeEvent({ ...hostile, readOnly: null }, { version: "14.1" });
  eq(valueOf(forced, "Calendar:Subject").length, 1024, "which is why the mark is there");
});

test("calendar-item: a recurrence that cannot be converted keeps its own reason", () => {
  const lunar = [C("Recurrence", [C("Type", "5"), C("DayOfMonth", "1"), C("MonthOfYear", "1"), C("CalendarType", "15")])];
  eq(read(item(lunar)).readOnly, "calendar-type");
  eq(read(item([...lunar, C("Subject", "s".repeat(2000)), C("Sensitivity", "1")])).readOnly, "calendar-type", "even when something else is missing too");
});

/** Items that the description holds whole: [what, children, version]. */
const WHOLE_ITEMS = [
  ["a bare item", item()],
  ["texts cleaned of control characters, tabs and line breaks, and of the blanks around names; names cleaned of anything invisible", item([
    C("Subject", `a${ch(0x01, 0x07, 0x85)}b\r\nline\ttwo`),
    C("Location", `${ch(0x1b)}Room\t4`),
    body("1", `Agenda${ch(0x9f)}\r\nline two`),
    C("OrganizerEmail", " boss@example.org "),
    C("OrganizerName", `  The ${ch(0x202e, 0x200d)}Boss  `),
    C("Categories", [C("Category", " Work "), C("Category", `Ho${ch(0x07)}me`)]),
    C("Attendees", [C("Attendee", [C("Email", " a@example.org "), C("Name", ` Ann${ch(0x07, 0x200b, 0x2066)} `)])]),
  ])],
  ["texts spelled with the zero-width joiner and non-joiner", item([
    C("Subject", `${FAMILY} ${PERSIAN}`), C("Location", PERSIAN), body("1", `${PERSIAN}\n${FAMILY}`), C("Categories", [C("Category", FAMILY), C("Category", PERSIAN)]),
  ])],
  ["texts exactly at their bounds", item([C("Subject", "s".repeat(1024)), C("Location", "l".repeat(1024)), body("1", "d".repeat(32768)), C("Categories", Array.from({ length: 50 }, (_, i) => C("Category", `${i}`.padStart(255, "c"))))])],
  ["1024 characters once 500 control characters are removed", item([C("Subject", `${ch(0x01).repeat(500)}${"s".repeat(1024)}`)])],
  ["500 attendees", item([C("Attendees", Array.from({ length: 500 }, (_, i) => attendeeOf(`a${i}@example.org`, C("AttendeeStatus", "3"), C("AttendeeType", "2"))))])],
  ["empty elements", item([C("Subject"), C("Location"), C("Reminder"), C("Categories"), C("Attendees"), C("OrganizerEmail"), C("OrganizerName"), C("DtStamp"), C("BusyStatus"), C("Sensitivity"), C("MeetingStatus"), C("AllDayEvent"), A("Body")])],
  ["a plain text that is not truncated", item([body("1", "Agenda", [A("EstimatedDataSize", "6"), A("Truncated", "0")])])],
  ["a plain body without data, as in [MS-ASCAL] 4.3", item([A("Body", [A("Type", "1"), A("EstimatedDataSize", "28")])])],
  ["an empty body in another form", item([A("Body", [A("Type", "2"), A("EstimatedDataSize", "0")])])],
  ["every value of an appointment", item([C("BusyStatus", "3"), C("Sensitivity", "3"), C("Reminder", "40320"), C("DtStamp", "20260301T080000Z"), C("MeetingStatus", "0"), C("AllDayEvent", "0"), C("ResponseRequested", "0"), C("DisallowNewTimeProposal", "1")])],
  ["a meeting of the mailbox, status 9 (same as 1)", item(meetingOf("9", "ME@example.org"))],
  ["a cancelled meeting of the mailbox, status 13 (same as 5)", item(meetingOf("13", OWN))],
  ["a received meeting, status 11 (same as 3)", item(meetingOf("11", "boss@example.org"))],
  ["a cancelled received meeting, status 15, with unused bits", item(meetingOf("255", "boss@example.org"))],
  ["what a client cannot send anyway", item([C("ResponseType", "9"), C("AppointmentReplyTime", "x"), C("OnlineMeetingExternalLink", "https://example.org/x"), A("NativeBodyType", "2")])],
  ["a time zone with names", item([C("Timezone", SPEC_PACIFIC)])],
  ["a time zone without changes, with the daylight bias Windows leaves there", item([C("Timezone", `${"A".repeat(224)}xP///w==`)])],
  ["an all-day event at local midnights, on a day of 23 hours", allDayIn(SPEC_PACIFIC, "20260308T080000Z", "20260309T070000Z")],
  ["an all-day event at local midnights, on a day of 25 hours", allDayIn(SPEC_PACIFIC, "20261101T070000Z", "20261102T080000Z")],
  ["an all-day event in UTC, without a time zone", item([C("AllDayEvent", "1")], { start: "20260310T000000Z", end: "20260312T000000Z" })],
  ["a recurrence written another way: Interval 0, Type 0 with days, Occurrences and Until, the default calendar", item([C("Recurrence", [C("Type", "0"), C("Interval", "0"), C("DayOfWeek", "62"), C("Occurrences", "5"), C("Until", "20270101T000000Z"), C("CalendarType", "1"), C("IsLeapMonth", "0")])])],
  ["a recurrence that never ends, written as a far date", item([C("Recurrence", [C("Type", "0"), C("Until", "45000831T235900Z")])])],
  ["FirstDayOfWeek in 14.1", item([C("Recurrence", [C("Type", "1"), C("DayOfWeek", "4"), C("FirstDayOfWeek", "1")])])],
  ["ResponseRequested in 12.1, where it is not written but kept by the server", item([...meetingOf("3", "boss@example.org"), C("ResponseRequested", "0"), C("DisallowNewTimeProposal", "1")]), "12.1"],
  ["an occurrence changed in every way", inException(
    C("Subject", "Other"), C("Location"), body("1", "Notes"), C("StartTime", "20260317T180000Z"), C("EndTime", "20260317T190000Z"), C("BusyStatus", "0"), C("Sensitivity", "2"),
    C("Reminder", "5"), C("Categories", [C("Category", "Once")]), C("Attendees", [attendeeOf("a@example.org")]), C("MeetingStatus", "0"), C("DtStamp", "20260301T000000Z"), C("Deleted", "0"),
  )],
  ["no reminder for one occurrence, in 14.1", inException(C("Reminder"))],
  ["attendees of one occurrence, in 14.0", inException(C("Attendees", [attendeeOf("a@example.org")])), "14.0"],
  [
    "an all-day series with occurrences at their midnights",
    allDayIn(SPEC_PACIFIC, "20260306T080000Z", "20260307T080000Z", [C("Recurrence", [C("Type", "0"), C("Until", "20260320T070000Z")]), C("Exceptions", [exception(original("20260307T080000Z"), C("Subject", "x")), exception(original("20260314T070000Z"), C("StartTime", "20260315T070000Z"), C("EndTime", "20260317T070000Z"))])]),
  ],
];

test("calendar-item: an item the description holds whole stays writable", () => {
  for (const [what, children, version = "14.1"] of WHOLE_ITEMS) {
    const description = readEvent(received(children.filter(Boolean)), { version, ownEmail: OWN });
    eq(description.readOnly, null, what);
    // And written back, it reads as the same thing: nothing was lost on the way.
    const again = readEvent(received(writeEvent(held(description), { version })), { version, ownEmail: OWN });
    eq(again.readOnly, null, `${what}: written and read again`);
    eq({ ...again, timezone: description.timezone, meeting: description.meeting, exceptions: description.exceptions }, description, `${what}: the same description`);
  }
  eq(read(item([], { uid: null }), { fallbackUid: "7-7:1@sync443" }).readOnly, null, "a uid given by the caller");
});

/** Further server items that a Change must leave as they are: [what, children, version]. */
const UNCHANGED_ITEMS = [
  ["zero-width joiners in a subject", item([C("Subject", `${FAMILY} ${PERSIAN}`), C("Location", PERSIAN), body("1", FAMILY), C("Categories", [C("Category", FAMILY), C("Category", PERSIAN)])])],
  ["occurrences with a text of their own, or without any", item([
    C("Subject", "Series"), body("1", "Text of the series"), weekly,
    C("Exceptions", [exception(original(), body("1", "Text of this occurrence")), exception(original("20260324T170000Z"), C("Subject", "Other"), A("Body")), exception(C("Deleted", "1"), original("20260331T170000Z"))]),
  ])],
  ["someone else's meeting in 12.1, where the answer is not said", item([...meetingOf("3", "boss@example.org"), C("Subject", "Budget"), body("1", "Agenda")]), "12.1"],
];

test("calendar-item: an item read from the server and written back unchanged asks the server to change nothing", () => {
  const bodiesIn = (elements) => elements.flatMap((e) => [...(e.ns === "AirSyncBase" && e.tag === "Body" ? [e] : []), ...bodiesIn(e.children)]);
  /**
   * A description without what a Change never sends: the texts, which the server keeps, what only the server
   * says, and the "not cancelled" of one occurrence of an appointment, which has no meeting status to send.
   */
  const withoutTexts = (d) => ({
    ...d,
    description: "",
    timezone: d.timezone ?? UTC_ZONE,
    meeting: { role: d.meeting.role, cancelled: d.meeting.cancelled },
    exceptions: d.exceptions.map((x) => ({
      ...x,
      changes: Object.fromEntries(Object.entries(x.changes).filter(([key]) => key !== "description" && !(key === "cancelled" && d.meeting.role === "none"))),
    })),
  });
  for (const [what, children, version = "14.1"] of [...WHOLE_ITEMS, ...UNCHANGED_ITEMS]) {
    const server = readEvent(received(children.filter(Boolean)), { version, ownEmail: OWN });
    eq(server.readOnly, null, what);
    const local = held(server); // what Thunderbird's side gives back when the user changed nothing
    const sent = writeEvent(local, { version, previous: local });
    eq(bodiesIn(sent).length, 0, `${what}: no text is sent, the server keeps those it has`);
    // Everything else is what the server sent: read again, it is the same item.
    const again = readEvent(received(sent), { version, ownEmail: OWN });
    eq(withoutTexts(again), withoutTexts(server), `${what}: the same item`);
    // The texts that are sent are the server's, character for character.
    const texts = [valueOf(sent, "Calendar:Subject") ?? "", valueOf(sent, "Calendar:Location") ?? "", (valueOf(sent, "Calendar:Categories") ?? []).map(([, name]) => name)];
    eq(texts, [server.summary, server.location, server.categories], `${what}: the same texts`);
  }
  // The cases this property was once broken by, against the server's own bytes.
  const [[, joinedChildren], [, seriesChildren]] = UNCHANGED_ITEMS;
  const joined = held(read(joinedChildren));
  const sentJoined = written(joined, { previous: joined });
  eq([valueOf(sentJoined, "Calendar:Subject"), valueOf(sentJoined, "Calendar:Location")], [`${FAMILY} ${PERSIAN}`, PERSIAN], "the joiner and the non-joiner are still there");
  eq(valueOf(sentJoined, "Calendar:Categories"), [["Calendar:Category", FAMILY], ["Calendar:Category", PERSIAN]]);
  const series = held(read(seriesChildren));
  eq(valueOf(written(series, { previous: series }), "Calendar:Exceptions"), [
    ["Calendar:Exception", [["Calendar:ExceptionStartTime", "20260317T170000Z"]]],
    ["Calendar:Exception", [["Calendar:ExceptionStartTime", "20260324T170000Z"], ["Calendar:Subject", "Other"]]],
    ["Calendar:Exception", [["Calendar:Deleted", "1"], ["Calendar:ExceptionStartTime", "20260331T170000Z"]]],
  ], "the text of an occurrence is not sent again");
});

// ── Reading: what is ignored ──────────────────────────────────────────────

test("calendar-item: unknown elements, and elements read-only for a client, change nothing", () => {
  const data = received(item([
    C("AppointmentReplyTime", "20260301T000000Z"),
    C("OnlineMeetingConfLink", "sip:x@example.org;gruu"),
    C("OnlineMeetingExternalLink", "https://example.org/meet"),
    C("ClientUid", "another id"),
    A("NativeBodyType", "2"),
    el("Email:Subject", "mail subject"),
    el("Email:MeetingRequest", [el("Email:StartTime", "20270101T000000Z"), el("Email:Organizer", "x@example.org")]),
    el("Tasks:Complete", "1"),
    el("Contacts:Email1Address", "x@example.org"),
  ]));
  // Elements of pages or tokens this client does not know decode under placeholder names.
  data.children.push({ ns: "#page30", tag: "#0x05", children: [], value: encodeUtf8("x"), opaque: false });
  data.children.push({ ns: "Calendar", tag: "#0x3f", children: [{ ns: "Calendar", tag: "StartTime", children: [], value: encodeUtf8("20270101T000000Z"), opaque: false }], value: null, opaque: false });
  data.children.push({ ns: "Calendar", tag: "__proto__", children: [], value: encodeUtf8("x"), opaque: false });
  data.children.push({ ns: "__proto__", tag: "constructor", children: [], value: null, opaque: false });
  data.children.push(null, "text", 42);
  eq(readEvent(data, { version: "14.1", ownEmail: OWN }), event());
  eq({}.polluted, undefined);
});

test("calendar-item: a leaf that holds elements is not a value", () => {
  // And since the server holds something there, the description is not all of the item.
  eq(read(item([C("Subject", [C("Subject", "nested")]), C("Location", [C("Location", "nested")]), C("Reminder", [C("Reminder", "15")]), C("BusyStatus", [C("BusyStatus", "0")])])), event({ readOnly: "incomplete" }));
  throws(() => read(item([], { uid: null }).concat([C("UID", [C("UID", "nested")])])), isBadItem);
  throws(() => read([C("StartTime", [C("StartTime", "20260310T170000Z")]), C("EndTime", "20260310T180000Z"), C("UID", "u")]), isBadItem);
});

// ── Writing ───────────────────────────────────────────────────────────────

test("calendar-item: writeEvent writes a simple appointment", () => {
  eq(written(event()).map(shape), [
    ["Calendar:Timezone", encodeTimeZone(UTC_ZONE)],
    ["Calendar:StartTime", "20260310T170000Z"],
    ["Calendar:UID", "uid-1"],
    ["Calendar:EndTime", "20260310T180000Z"],
    ["Calendar:Sensitivity", "0"],
    ["Calendar:BusyStatus", "2"],
    ["Calendar:AllDayEvent", "0"],
    ["Calendar:MeetingStatus", "0"],
    ["Calendar:ResponseRequested", "0"],
    ["Calendar:DisallowNewTimeProposal", "0"],
  ]);
  eq(names(written(event(), { version: "12.1" })), ["Calendar:Timezone", "Calendar:StartTime", "Calendar:UID", "Calendar:EndTime", "Calendar:Sensitivity", "Calendar:BusyStatus", "Calendar:AllDayEvent", "Calendar:MeetingStatus"]);
});

test("calendar-item: writeEvent writes a meeting with everything", () => {
  const meeting = event({
    summary: "Budget",
    location: "Room 4",
    description: "Agenda\nline two",
    timezone: PARIS,
    busy: "tentative",
    privacy: "confidential",
    reminder: 0,
    categories: ["Work", "Money"],
    organizer: { email: OWN, name: "Me Myself" },
    attendees: [person("a@example.org", "Ann", "required", "accepted"), person("room@example.org", "", "resource", "not-responded")],
    meeting: { role: "organizer", cancelled: false, responseRequested: true, response: "accepted", allowNewTime: false },
    stamp: "2026-03-01T08:00:00Z",
    sequence: 7,
  });
  eq(written(meeting).map(shape), [
    ["Calendar:Timezone", encodeTimeZone(PARIS)],
    ["Calendar:DtStamp", "20260301T080000Z"],
    ["Calendar:StartTime", "20260310T170000Z"],
    ["Calendar:Subject", "Budget"],
    ["Calendar:UID", "uid-1"],
    ["Calendar:Attendees", [
      ["Calendar:Attendee", [["Calendar:Email", "a@example.org"], ["Calendar:Name", "Ann"], ["Calendar:AttendeeStatus", "3"], ["Calendar:AttendeeType", "1"]]],
      ["Calendar:Attendee", [["Calendar:Email", "room@example.org"], ["Calendar:Name", ""], ["Calendar:AttendeeStatus", "5"], ["Calendar:AttendeeType", "3"]]],
    ]],
    ["Calendar:OrganizerName", "Me Myself"],
    ["Calendar:OrganizerEmail", OWN],
    ["Calendar:Location", "Room 4"],
    ["Calendar:EndTime", "20260310T180000Z"],
    ["AirSyncBase:Body", [["AirSyncBase:Type", "1"], ["AirSyncBase:Data", "Agenda\nline two"]]],
    ["Calendar:Sensitivity", "3"],
    ["Calendar:BusyStatus", "1"],
    ["Calendar:AllDayEvent", "0"],
    ["Calendar:Reminder", "0"],
    ["Calendar:MeetingStatus", "1"],
    ["Calendar:ResponseRequested", "1"],
    ["Calendar:DisallowNewTimeProposal", "1"],
    ["Calendar:Categories", [["Calendar:Category", "Work"], ["Calendar:Category", "Money"]]],
  ]);
});

test("calendar-item: what a client must not send is never sent", () => {
  const meeting = event({
    organizer: { email: "boss@example.org", name: "Boss" }, attendees: [person(OWN, "Me", "required", "accepted")],
    meeting: { role: "attendee", response: "accepted", responseRequested: true },
    recurrence: rule({ freq: "monthly", byMonthDay: 10, weekStart: "MO" }),
    exceptions: [{ originalStart: "2026-04-10T16:00:00Z", deleted: false, changes: { attendees: [person(OWN, "Me", "required", "declined")], reminder: null } }],
  });
  const all = (elements) => elements.flatMap((e) => [`${e.ns}:${e.tag}`, ...all(e.children)]);
  for (const version of PROTOCOL_VERSIONS) {
    const sent = all(writeEvent(meeting, { version }));
    for (const never of ["ResponseType", "AppointmentReplyTime", "CalendarType", "IsLeapMonth", "OnlineMeetingConfLink", "OnlineMeetingExternalLink", "ClientUid"]) {
      assert(!sent.includes(`Calendar:${never}`), `${never} in ${version}`);
    }
    eq(sent.includes("Calendar:FirstDayOfWeek"), version === "14.1", `FirstDayOfWeek in ${version}`);
    eq(sent.includes("Calendar:ResponseRequested"), version !== "12.1", `ResponseRequested in ${version}`);
    eq(sent.includes("Calendar:DisallowNewTimeProposal"), version !== "12.1", `DisallowNewTimeProposal in ${version}`);
    eq(sent.filter((name) => name === "Calendar:Attendees").length, version === "12.1" ? 1 : 2, `Attendees of an exception in ${version}`);
    eq(sent.filter((name) => name === "Calendar:Reminder").length, version === "14.1" ? 1 : 0, `empty Reminder of an exception in ${version}`);
  }
  eq(valueOf(written(meeting), "Calendar:MeetingStatus"), "3");
});

test("calendar-item: MeetingStatus is written from the role", () => {
  const status = (role, cancelled) => valueOf(written(event({ organizer: { email: OWN, name: "" }, meeting: { role, cancelled } })), "Calendar:MeetingStatus");
  eq([status("none", false), status("organizer", false), status("attendee", false), status("organizer", true), status("attendee", true)], ["0", "1", "3", "5", "7"]);
  eq(status("none", true), "0", "an appointment cannot be a cancelled meeting");
});

test("calendar-item: timezone null is sent as UTC", () => {
  eq(valueOf(written(event({ timezone: null })), "Calendar:Timezone"), encodeTimeZone(UTC_ZONE));
  eq(valueOf(written(event({ timezone: null })), "Calendar:Timezone"), "A".repeat(230) + "==");
  eq(valueOf(written(event({ timezone: PACIFIC })), "Calendar:Timezone"), encodeTimeZone(PACIFIC));
  eq(read(written(event({ timezone: null }))).timezone, UTC_ZONE);
});

test("calendar-item: the body is sent only when the description changed", () => {
  const sent = (description, previous) => valueOf(written(event({ description }), previous === undefined ? {} : { previous }), "AirSyncBase:Body");
  const data = (value) => [["AirSyncBase:Type", "1"], ["AirSyncBase:Data", value]];
  // An Add: nothing to send for an empty text.
  eq(sent("New text"), data("New text"));
  eq(sent(""), undefined);
  eq(sent("New text", null), data("New text"));
  // A Change: the server keeps the body that is not sent ([MS-ASCMD] 2.2.3.24).
  eq(sent("Same text", event({ description: "Same text" })), undefined, "unchanged");
  eq(sent("", event({ description: "" })), undefined);
  eq(sent("New text", event({ description: "Old text" })), data("New text"));
  eq(sent("", event({ description: "Old text" })), data(""), "a removed text is sent empty");
  eq(sent("Text", event({ description: "" })), data("Text"));
  // The comparison is between cleaned texts: a previous description as the server sent it compares equal.
  eq(sent("a\nb", { description: `a\r\nb${ch(0x202e)}` }), undefined);
  eq(sent("x".repeat(40_000), { description: "x".repeat(50_000) }), undefined, "both cut to the bound");
  // A previous description that cannot be read is no proof that nothing changed.
  for (const previous of [{}, { description: 42 }, [], "Same text", 0, Object.create({ description: "Same text" })]) eq(sent("Same text", previous), data("Same text"), JSON.stringify(previous));
});

test("calendar-item: an empty value is left out, which deletes it on the server", () => {
  const list = names(written(event({ summary: "", location: "", description: "", reminder: null, categories: [], attendees: [], organizer: null, stamp: null })));
  for (const absent of ["Subject", "Location", "Reminder", "Categories", "Attendees", "OrganizerName", "OrganizerEmail", "DtStamp", "Recurrence", "Exceptions"]) assert(!list.includes(`Calendar:${absent}`), absent);
  assert(!list.includes("AirSyncBase:Body"));
  const named = names(written(event({ organizer: { email: "boss@example.org", name: "" } })));
  assert(named.includes("Calendar:OrganizerEmail") && !named.includes("Calendar:OrganizerName"), "an organizer without a name");
});

test("calendar-item: exceptions are written with what they change, and empty elements for removed values", () => {
  const series = event({
    organizer: { email: OWN, name: "Me" }, attendees: [person("a@example.org", "Ann")], meeting: { role: "organizer" },
    recurrence: rule({ freq: "weekly", byDay: ["TU"] }),
    exceptions: [
      { originalStart: "2026-03-17T17:00:00Z", deleted: true, changes: {} },
      { originalStart: "2026-03-24T17:00:00Z", deleted: false, changes: {} },
      {
        originalStart: "2026-03-31T17:00:00Z", deleted: false,
        changes: { summary: "Other", location: "Elsewhere", description: "Notes", allDay: false, start: "2026-03-31T18:00:00Z", end: "2026-03-31T19:00:00Z", busy: "free", privacy: "private", reminder: 5, categories: ["Once"], attendees: [person("b@example.org", "Bob", "optional", "tentative")], cancelled: true },
      },
      { originalStart: "2026-04-07T17:00:00Z", deleted: false, changes: { summary: "", location: "", description: "", reminder: null, categories: [], attendees: [], cancelled: false } },
    ],
  });
  eq(valueOf(written(series), "Calendar:Exceptions"), [
    ["Calendar:Exception", [["Calendar:Deleted", "1"], ["Calendar:ExceptionStartTime", "20260317T170000Z"]]],
    ["Calendar:Exception", [["Calendar:ExceptionStartTime", "20260324T170000Z"]]],
    ["Calendar:Exception", [
      ["Calendar:ExceptionStartTime", "20260331T170000Z"],
      ["Calendar:Subject", "Other"],
      ["Calendar:StartTime", "20260331T180000Z"],
      ["Calendar:EndTime", "20260331T190000Z"],
      ["AirSyncBase:Body", [["AirSyncBase:Type", "1"], ["AirSyncBase:Data", "Notes"]]],
      ["Calendar:Location", "Elsewhere"],
      ["Calendar:Categories", [["Calendar:Category", "Once"]]],
      ["Calendar:Sensitivity", "2"],
      ["Calendar:BusyStatus", "0"],
      ["Calendar:AllDayEvent", "0"],
      ["Calendar:Reminder", "5"],
      ["Calendar:MeetingStatus", "5"],
      ["Calendar:Attendees", [["Calendar:Attendee", [["Calendar:Email", "b@example.org"], ["Calendar:Name", "Bob"], ["Calendar:AttendeeStatus", "2"], ["Calendar:AttendeeType", "2"]]]]],
    ]],
    ["Calendar:Exception", [
      ["Calendar:ExceptionStartTime", "20260407T170000Z"],
      ["Calendar:Subject", null],
      ["AirSyncBase:Body", null],
      ["Calendar:Location", null],
      ["Calendar:Categories", null],
      ["Calendar:Reminder", null],
      ["Calendar:MeetingStatus", "1"],
      ["Calendar:Attendees", null],
    ]],
  ]);
  // The same through WBXML and back.
  eq(read(written(series)).exceptions, checkEvent(series).exceptions);
  // An appointment has no meeting status to cancel for one day.
  const plain = event({ recurrence: rule({}), exceptions: [{ originalStart: "2026-03-17T17:00:00Z", deleted: false, changes: { cancelled: true } }] });
  eq(valueOf(written(plain), "Calendar:Exceptions"), [["Calendar:Exception", [["Calendar:ExceptionStartTime", "20260317T170000Z"]]]]);
});

test("calendar-item: the text of a changed occurrence is sent only when it changed, as that of the series", () => {
  // As the server sent it: a series, and occurrences with and without a text of their own.
  const server = read(item([
    C("Subject", "Series"),
    body("1", "Text of the series"),
    weekly,
    C("Exceptions", [
      exception(original("20260317T170000Z"), body("1", "Text of this occurrence, richer on the server")),
      exception(original("20260324T170000Z"), C("Subject", "Other")),
      exception(original("20260331T170000Z"), A("Body")),
    ]),
  ]));
  eq(server.exceptions.map((x) => x.changes.description), ["Text of this occurrence, richer on the server", undefined, ""]);
  const data = (value) => [["AirSyncBase:Type", "1"], ["AirSyncBase:Data", value]];
  /** The Body sent for the series, then for each exception: undefined when none is, null for an empty element. */
  const bodies = (description, options) => {
    const elements = written(description, options);
    const inException = ([, children]) => (children.some(([name]) => name === "AirSyncBase:Body") ? children.find(([name]) => name === "AirSyncBase:Body")[1] : undefined);
    return [valueOf(elements, "AirSyncBase:Body"), ...valueOf(elements, "Calendar:Exceptions").map(inException)];
  };
  const changing = (index, changes) => ({ ...server, exceptions: server.exceptions.map((x, i) => (i === index ? { ...x, changes: { ...x.changes, ...changes } } : x)) });
  // The user sets a reminder: no text is sent, and the server keeps those it has.
  eq(bodies({ ...server, reminder: 15 }, { previous: server }), [undefined, undefined, undefined, undefined]);
  // A text that changed is sent, and it alone.
  eq(bodies(changing(0, { description: "New text" }), { previous: server }), [undefined, data("New text"), undefined, undefined]);
  eq(bodies(changing(0, { description: "" }), { previous: server }), [undefined, null, undefined, undefined], "a removed text is an empty element");
  eq(bodies(changing(1, { description: "A text where the series' was" }), { previous: server }), [undefined, undefined, data("A text where the series' was"), undefined]);
  eq(bodies(changing(1, { description: "" }), { previous: server }), [undefined, undefined, null, undefined], "no text for this occurrence, where it had that of the series");
  eq(bodies(changing(2, { description: "Text" }), { previous: server }), [undefined, undefined, undefined, data("Text")]);
  eq(bodies({ ...server, description: "New text of the series" }, { previous: server }), [data("New text of the series"), undefined, undefined, undefined]);
  // The comparison is between cleaned texts, as for the series.
  eq(bodies(changing(0, { description: "a\nb" }), { previous: changing(0, { description: `a\r\nb${ch(0x07)}` }) })[1], undefined);
  // A new exception, an Add, a previous description that says nothing of this occurrence: the text is sent.
  const added = { ...server, exceptions: [...server.exceptions, { originalStart: "2026-04-07T17:00:00Z", deleted: false, changes: { description: "Once" } }] };
  eq(bodies(added, { previous: server }), [undefined, undefined, undefined, undefined, data("Once")]);
  const all = [data("Text of the series"), data("Text of this occurrence, richer on the server"), undefined, null];
  eq(bodies(server), all, "an Add sends them all");
  eq(bodies(server, { previous: null }), all);
  const first = server.exceptions[0];
  for (const exceptionsBefore of [
    undefined, "x", [], [null, 42, "x", []], [{ ...first, originalStart: "2026-03-18T17:00:00Z" }], [{ ...first, deleted: true }], [{ ...first, deleted: "false" }], [{ ...first, changes: null }],
    [{ ...first, changes: {} }], [{ ...first, changes: { description: 42 } }], [{ ...first, changes: Object.create({ description: first.changes.description }) }], [{ ...first, changes: { description: "Another text" } }],
  ]) {
    eq(bodies(server, { previous: { ...server, start: "2026-03-03T17:00:00Z", exceptions: exceptionsBefore } })[1], all[1], `no proof that nothing changed: ${JSON.stringify(exceptionsBefore)}`);
  }
  // In every version, and through WBXML: nothing but the occurrence itself is sent for an untouched text.
  for (const version of PROTOCOL_VERSIONS) {
    const again = readEvent(received(writeEvent({ ...server, reminder: 15 }, { version, previous: server })), { version, ownEmail: OWN });
    eq(again.exceptions.map((x) => x.changes), [{}, { summary: "Other" }, {}], version);
  }
});

test("calendar-item: a deleted occurrence that the user restored cannot be told to the server", () => {
  const isUnsupported = hasCode("UNSUPPORTED_CHANGE");
  const deleted = (originalStart) => ({ originalStart, deleted: true, changes: {} });
  const series = (fields = {}) => event({ recurrence: rule({ freq: "weekly", byDay: ["TU"] }), exceptions: [deleted("2026-03-17T17:00:00Z"), deleted("2026-03-24T17:00:00Z")], ...fields });
  const synced = series();
  const sentExceptions = (description, previous) => valueOf(written(description, { previous }), "Calendar:Exceptions")?.length ?? 0;
  // Nothing restored: written as ever.
  eq(sentExceptions(series({ reminder: 15 }), synced), 2);
  eq(sentExceptions(series({ exceptions: [...synced.exceptions, deleted("2026-03-31T17:00:00Z")] }), synced), 3, "one more deleted");
  // One is back (the undo of its deletion). A Change that leaves an exception out leaves it as it is
  // ([MS-ASCAL] 3.2.5.3.1): the change is refused, instead of a calendar that silently differs from the server.
  const thrown = throws(() => written(series({ exceptions: [deleted("2026-03-24T17:00:00Z")] }), { previous: synced }), isUnsupported, "one restored");
  assert(thrown instanceof ProtocolError && !/2026/.test(thrown.message), "the reason names no date");
  throws(() => written(series({ exceptions: [] }), { previous: synced }), isUnsupported, "both restored");
  const back = { originalStart: "2026-03-24T17:00:00Z", deleted: false, changes: { summary: "Back, and changed" } };
  throws(() => written(series({ exceptions: [deleted("2026-03-17T17:00:00Z"), back] }), { previous: synced }), isUnsupported, "restored and changed");
  for (const version of PROTOCOL_VERSIONS) throws(() => writeEvent(series({ exceptions: [] }), { version, previous: synced }), isUnsupported, version);
  // An all-day series, and a zone that is UTC said two ways.
  const wholeDays = (exceptionsNow) => event({ allDay: true, start: "2026-03-10", end: "2026-03-11", timezone: PARIS, recurrence: rule({ freq: "weekly" }), exceptions: exceptionsNow });
  throws(() => written(wholeDays([]), { previous: wholeDays([deleted("2026-03-17")]) }), isUnsupported, "all-day");
  eq(sentExceptions(wholeDays([deleted("2026-03-17")]), wholeDays([deleted("2026-03-17")])), 1);
  throws(() => written(series({ exceptions: [], timezone: UTC_ZONE }), { previous: series({ timezone: null }) }), isUnsupported, "no zone is UTC");
  // A read-only item is refused for that first.
  throws(() => written(series({ exceptions: [], readOnly: "incomplete" }), { previous: synced }), hasCode("READ_ONLY_ITEM"));
  // An Add, or a previous description that cannot be read: nothing to compare with.
  eq(sentExceptions(series({ exceptions: [] })), 0);
  for (const previous of [null, undefined, {}, [], "x", 42, { ...synced, exceptions: "x" }, { ...synced, exceptions: [null, 42, {}, { deleted: true }, { originalStart: 42, deleted: true }] }, { ...synced, recurrence: "weekly" }, { ...synced, recurrence: null }, { ...synced, timezone: { bias: 9000 } }]) {
    eq(sentExceptions(series({ exceptions: [] }), previous), 0, JSON.stringify(previous));
  }
  // A series that was moved or changed has other occurrences: its exceptions are sent as they are.
  for (const [what, fields] of [
    ["moved", { start: "2026-03-10T18:00:00Z", end: "2026-03-10T19:00:00Z" }],
    ["all-day now", { allDay: true, start: "2026-03-10", end: "2026-03-11" }],
    ["another day of the week", { recurrence: rule({ freq: "weekly", byDay: ["WE"] }) }],
    ["an end", { recurrence: rule({ freq: "weekly", byDay: ["TU"], count: 3 }) }],
    ["another zone", { timezone: PACIFIC }],
    ["no longer a series", { recurrence: null }],
  ]) {
    eq(sentExceptions(series({ exceptions: [], ...fields }), synced), 0, what);
  }
});

test("calendar-item: a changed occurrence put back into its series cannot be told to the server", () => {
  const isUnsupported = hasCode("UNSUPPORTED_CHANGE");
  const changed = (originalStart, changes = { summary: "Other" }) => ({ originalStart, deleted: false, changes });
  const gone = (originalStart) => ({ originalStart, deleted: true, changes: {} });
  const series = (fields = {}) => event({ recurrence: rule({ freq: "weekly", byDay: ["TU"] }), exceptions: [changed("2026-03-17T17:00:00Z"), changed("2026-03-24T17:00:00Z", {})], ...fields });
  const synced = series();
  const sentExceptions = (description, previous) => valueOf(written(description, { previous }), "Calendar:Exceptions")?.length ?? 0;
  eq(sentExceptions(series({ reminder: 15 }), synced), 2, "nothing put back");
  // The exception is gone from the description (an undo): the server would keep the occurrence as it was changed.
  const thrown = throws(() => written(series({ exceptions: [changed("2026-03-24T17:00:00Z", {})] }), { previous: synced }), isUnsupported, "one put back");
  assert(!/2026/.test(thrown.message), "the reason names no date");
  throws(() => written(series({ exceptions: [changed("2026-03-17T17:00:00Z")] }), { previous: synced }), isUnsupported, "one that changed nothing but existed");
  throws(() => written(series({ exceptions: [] }), { previous: synced }), isUnsupported, "both");
  for (const version of PROTOCOL_VERSIONS) throws(() => writeEvent(series({ exceptions: [] }), { version, previous: synced }), isUnsupported, version);
  // What can be said is said: changed again, deleted now, one more.
  eq(sentExceptions(series({ exceptions: [changed("2026-03-17T17:00:00Z", { summary: "Again" }), gone("2026-03-24T17:00:00Z")] }), synced), 2);
  eq(sentExceptions(series({ exceptions: [...synced.exceptions, changed("2026-03-31T17:00:00Z")] }), synced), 3);
  // The same narrowing as for a restored occurrence: another series, an Add, an unreadable previous.
  for (const [what, fields] of [
    ["moved", { start: "2026-03-10T18:00:00Z", end: "2026-03-10T19:00:00Z" }],
    ["another rule", { recurrence: rule({ freq: "weekly", byDay: ["WE"] }) }],
    ["another zone", { timezone: PACIFIC }],
    ["no longer a series", { recurrence: null }],
  ]) {
    eq(sentExceptions(series({ exceptions: [], ...fields }), synced), 0, what);
  }
  for (const previous of [null, undefined, {}, "x", { ...synced, exceptions: "x" }, { ...synced, exceptions: [{ ...synced.exceptions[0], deleted: "no" }, { deleted: false }] }, { ...synced, recurrence: "weekly" }]) {
    eq(sentExceptions(series({ exceptions: [] }), previous), 0, JSON.stringify(previous));
  }
});

test("calendar-item: an occurrence that lost its own text for that of the series cannot be told, unless nothing differs", () => {
  const isUnsupported = hasCode("UNSUPPORTED_CHANGE");
  const at = "2026-03-17T17:00:00Z";
  const series = (description, changes, fields = {}) => event({ description, recurrence: rule({ freq: "weekly", byDay: ["TU"] }), exceptions: [{ originalStart: at, deleted: false, changes }], ...fields });
  const synced = series("Text of the series", { summary: "Other", description: "Text of this occurrence" });
  const bodiesOf = (description, previous) => {
    const elements = written(description, { previous });
    return [valueOf(elements, "AirSyncBase:Body") !== undefined, valueOf(elements, "Calendar:Exceptions")[0][1].some(([name]) => name === "AirSyncBase:Body")];
  };
  // The occurrence takes the text of the series again: no element says so (an empty Body means "no text"),
  // and left out, the server would keep the old text.
  const thrown = throws(() => written(series("Text of the series", { summary: "Other" }), { previous: synced }), isUnsupported);
  assert(!thrown.message.includes("Text"), "the reason holds no content");
  throws(() => written(series("Another text for all", { summary: "Other" }), { previous: synced }), isUnsupported, "with the series' text changed to something else");
  throws(() => written(series("Text of the series", { summary: "Other" }, { start: "2026-03-10T17:00:00Z", reminder: 5 }), { previous: synced }), isUnsupported);
  throws(() => written(series("Text of the series", {}), { previous: series("Text of the series", { description: "" }) }), isUnsupported, "it had no text, and has that of the series now");
  // The text the server keeps for the occurrence is the text of the series as it is now: nothing differs.
  eq(bodiesOf(series("Text of this occurrence", { summary: "Other" }), synced), [true, false], "the series took the occurrence's text");
  eq(bodiesOf(series("Same", { summary: "Other" }), series("Same", { summary: "Other", description: `Same${ch(0x07)}` })), [false, false], "the server sent the occurrence the series' own text");
  eq(bodiesOf(series("", {}), series("", { description: "" })), [false, false]);
  // What can be said is said: another text, no text, the occurrence deleted, the text kept.
  eq(bodiesOf(series("Text of the series", { description: "New" }), synced), [false, true]);
  eq(bodiesOf(series("Text of the series", { description: "" }), synced), [false, true]);
  eq(bodiesOf(synced, synced), [false, false]);
  eq(valueOf(written(event({ description: "Text of the series", recurrence: rule({ freq: "weekly", byDay: ["TU"] }), exceptions: [{ originalStart: at, deleted: true, changes: {} }] }), { previous: synced }), "Calendar:Exceptions").length, 1);
  // An occurrence that never had a text of its own, an Add, a previous that says nothing: written as ever.
  eq(bodiesOf(series("Text of the series", { summary: "Again" }), series("Text of the series", { summary: "Other" })), [false, false]);
  eq(bodiesOf(series("Text of the series", { summary: "Other" })), [true, false]);
  for (const previous of [null, {}, "x", { ...synced, exceptions: [{ originalStart: at, deleted: false, changes: { description: 42 } }] }]) eq(bodiesOf(series("Text of the series", { summary: "Other" }), previous)[1], false);
});

test("calendar-item: a read-only item is never written", () => {
  for (const readOnly of ["calendar-type", "unsupported-recurrence", "incomplete"]) {
    const thrown = throws(() => written(event({ readOnly })), hasCode("READ_ONLY_ITEM"), readOnly);
    assert(thrown instanceof ProtocolError);
  }
});

test("calendar-item: writeEvent checks the description first", () => {
  throws(() => written(event({ end: "2026-03-10T16:59:59Z" })), isBadItem);
  throws(() => written(event({ uid: `x${ch(0x202e)}` })), isBadItem);
  throws(() => written(event({ recurrence: rule({ freq: "monthly", byDay: ["MO"] }) })), isBadRecurrence);
  throws(() => written(event({ timezone: { bias: 9000 } })), isBadZone);
  throws(() => written(null), isBadItem);
  // What is written is the cleaned description, never the raw one.
  const elements = written(event({ summary: `Clean${ch(0x202e, 0x07)}ed\nline`, location: ch(0), description: `a${ch(0)}b` }));
  eq(valueOf(elements, "Calendar:Subject"), "Cleaned line");
  eq(valueOf(elements, "Calendar:Location"), undefined, "a location that is nothing once cleaned");
  eq(valueOf(elements, "AirSyncBase:Body")[1], ["AirSyncBase:Data", "ab"]);
});

test("calendar-item: everything written can be sent, as an Add and as a Change", () => {
  const meeting = event({
    summary: "Budget", location: "Room", description: "Text", timezone: SYDNEY, reminder: 15, categories: ["Work"], stamp: "2026-03-01T08:00:00Z",
    organizer: { email: OWN, name: "Me" }, attendees: [person("a@example.org", "Ann")], meeting: { role: "organizer", responseRequested: true },
    recurrence: rule({ freq: "yearly", byMonth: 3, byDay: ["TU"], bySetPos: 2, until: "2030-03-12T17:00:00Z", weekStart: "SU" }),
    exceptions: [{ originalStart: "2027-03-09T17:00:00Z", deleted: false, changes: { summary: "", description: "x", reminder: null, attendees: [] } }],
  });
  for (const version of PROTOCOL_VERSIONS) {
    const data = writeEvent(meeting, { version });
    for (const command of [addCommand("c-1", data), changeCommand("7:1", data)]) {
      const request = syncRequest([{ collectionId: "7", syncKey: "5", commands: [command] }]);
      assert(encode(request).length > 300, `${version} encodes`);
    }
  }
});

// ── Round trips ───────────────────────────────────────────────────────────

/** A random description that the given version can carry without loss. */
function randomEvent(random, version) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const int = (min, max) => min + Math.floor(random() * (max - min + 1));
  const words = ["Réunion", "budget", "équipe", "point", "hebdo", "Zoë", "naïve", "日本語", "meeting", "x"];
  const phrase = () => Array.from({ length: int(1, 4) }, () => pick(words)).join(" ");
  const maybe = (value, other = "") => (random() < 0.6 ? value() : other);
  const allDay = random() < 0.4;
  const startMs = Date.UTC(2021, 0, 1) + int(0, 4000) * DAY + (allDay ? 0 : int(0, 86399) * 1000);
  const when = (ms) => (allDay ? formatDate(ms) : formatUtc(ms));
  const role = pick(["none", "organizer", "attendee"]);
  const people = (count) => Array.from({ length: count }, (_, i) => person(`p${i}.${int(0, 999)}@example.org`, maybe(phrase), pick(["required", "optional", "resource"]), pick(["unknown", "tentative", "accepted", "declined", "not-responded"])));
  const description = event({
    uid: `uid-${int(0, 1e9)}@example.org`,
    summary: maybe(phrase),
    location: maybe(phrase),
    description: maybe(() => `${phrase()}\n${phrase()}`),
    allDay,
    start: when(startMs),
    end: when(startMs + (allDay ? int(1, 5) * DAY : int(1, 200_000) * 1000)),
    timezone: pick(ZONES),
    busy: pick(["free", "tentative", "busy", "away"]),
    privacy: pick(["public", "private", "confidential"]),
    reminder: random() < 0.5 ? null : int(0, 40320),
    categories: [...new Set(Array.from({ length: int(0, 4) }, phrase))],
    organizer: role === "organizer" ? { email: OWN, name: maybe(phrase) } : role === "attendee" || random() < 0.5 ? { email: "boss@example.org", name: maybe(phrase) } : null,
    attendees: people(int(0, 5)),
    meeting: {
      role,
      cancelled: role !== "none" && random() < 0.3,
      responseRequested: version === "12.1" ? role !== "none" : random() < 0.5,
      response: "none",
      allowNewTime: version === "12.1" ? true : random() < 0.5,
    },
    stamp: random() < 0.5 ? null : formatUtc(Date.UTC(2026, 0, 1) + int(0, 1e7) * 1000),
  });
  if (random() < 0.5) {
    const untilMs = startMs + int(1, 2000) * DAY;
    description.recurrence = rule({
      interval: int(1, 30),
      count: random() < 0.3 ? int(1, 999) : null,
      weekStart: version === "14.1" && random() < 0.5 ? pick(WEEKDAYS) : null,
      ...pick([
        {},
        { freq: "weekly", byDay: [pick(WEEKDAYS)] },
        { freq: "monthly", byMonthDay: int(1, 31) },
        { freq: "monthly", byDay: ["MO", "TU", "WE", "TH", "FR"], bySetPos: pick([1, 2, 3, 4, -1]) },
        { freq: "yearly", byMonth: int(1, 12), byMonthDay: int(1, 28) },
        { freq: "yearly", byMonth: int(1, 12), byDay: [pick(WEEKDAYS)], bySetPos: pick([1, 2, 3, 4, -1]) },
      ]),
    });
    if (description.recurrence.count === null && random() < 0.5) description.recurrence.until = when(untilMs);
    // Within the rules of a recurrence: a day number that comes (every month has it, or one of the next three),
    // and an event no longer than the period of its rule (exactly as long, when it was longer).
    const r = description.recurrence;
    if (r.freq === "monthly" && r.byMonthDay > 28) r.interval = 1;
    const period = r.interval * { daily: 1, weekly: 7, monthly: 31, yearly: 366 }[r.freq] * DAY;
    const length = (allDay ? parseDate(description.end) : parseUtc(description.end)) - startMs;
    if (length > period) description.end = when(startMs + period);
    const used = new Set();
    description.exceptions = Array.from({ length: int(0, 4) }, () => {
      let offset = int(1, 300);
      while (used.has(offset)) offset++;
      used.add(offset);
      const originalStart = when(startMs + offset * DAY);
      if (random() < 0.3) return { originalStart, deleted: true, changes: {} };
      const changes = {};
      if (random() < 0.5) changes.summary = maybe(phrase);
      if (random() < 0.3) changes.location = maybe(phrase);
      if (random() < 0.3) changes.description = maybe(phrase);
      const wholeDay = random() < 0.2 ? (changes.allDay = !allDay) : allDay;
      const at = startMs - (startMs % DAY) + int(1, 300) * DAY + (wholeDay ? 0 : int(0, 86399) * 1000);
      const stamp = (ms) => (wholeDay ? formatDate(ms) : formatUtc(ms));
      const times = random();
      if (times < 0.5) changes.start = stamp(at);
      if (times > 0.25 && times < 0.75) changes.end = stamp(at + (wholeDay ? int(1, 3) * DAY : int(1, 9000) * 1000));
      if (random() < 0.3) changes.busy = pick(["free", "tentative", "busy", "away"]);
      if (random() < 0.3) changes.privacy = pick(["public", "private", "confidential"]);
      if (random() < 0.3) changes.reminder = version === "14.1" && random() < 0.3 ? null : int(0, 40320);
      if (random() < 0.3) changes.categories = [...new Set(Array.from({ length: int(0, 3) }, phrase))];
      if (version !== "12.1" && random() < 0.3) changes.attendees = people(int(0, 3));
      if (role !== "none" && random() < 0.3) changes.cancelled = random() < 0.5;
      return { originalStart, deleted: false, changes };
    });
  }
  return description;
}

test("calendar-item: random events survive description → elements → WBXML → description", () => {
  const random = prng(4430);
  for (let i = 0; i < 900; i++) {
    const version = PROTOCOL_VERSIONS[i % 3];
    const description = randomEvent(random, version);
    const checked = checkEvent(description, { ownEmail: OWN });
    // Before 14.0 nothing says what the user answered to someone else's meeting.
    const unsaid = version === "12.1" && checked.meeting.role === "attendee";
    const expected = { ...checked, meeting: { ...checked.meeting, response: unsaid ? null : checked.meeting.response } };
    const back = readEvent(received(writeEvent(description, { version })), { version, ownEmail: OWN });
    eq(back, expected, `${version} #${i} ${JSON.stringify(description)}`);
    assert(deepFrozen(back), "frozen");
    // Reading what was written and writing it again gives the same elements.
    eq(writeEvent(held(back), { version }).map(shape), writeEvent(description, { version }).map(shape), `${version} #${i} written twice`);
  }
});

// ── checkEvent ────────────────────────────────────────────────────────────

const FULL = event({
  summary: "Budget",
  location: "Room 4",
  description: "Agenda",
  timezone: PARIS,
  reminder: 15,
  categories: ["Work"],
  organizer: { email: OWN, name: "Me" },
  attendees: [person("a@example.org", "Ann", "optional", "accepted")],
  meeting: { role: "organizer", cancelled: false, responseRequested: true, response: "none", allowNewTime: true },
  recurrence: rule({ freq: "weekly", byDay: ["TU"], until: "2026-12-31T17:00:00Z" }),
  exceptions: [
    { originalStart: "2026-03-17T17:00:00Z", deleted: true, changes: {} },
    { originalStart: "2026-03-24T17:00:00Z", deleted: false, changes: { summary: "Other", start: "2026-03-24T18:00:00Z", end: "2026-03-24T19:00:00Z" } },
  ],
  stamp: "2026-03-01T08:00:00Z",
  sequence: 3,
});

/** A deep copy of FULL with the value at `path` replaced (or removed, with REMOVE). */
const REMOVE = Symbol("remove");
function mutated(path, value) {
  const copy = JSON.parse(JSON.stringify(FULL));
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key];
  if (value === REMOVE) delete at[path[path.length - 1]];
  else at[path[path.length - 1]] = value;
  return copy;
}

test("calendar-item: checkEvent returns a clean, deeply frozen copy", () => {
  const input = JSON.parse(JSON.stringify(FULL));
  const checked = checkEvent(input);
  eq(checked, FULL);
  assert(checked !== input && deepFrozen(checked), "a deeply frozen copy");
  assert(!Object.isFrozen(input) && !Object.isFrozen(input.attendees), "the input is untouched");
  eq(checkEvent(checked), checked, "checking twice changes nothing");
  eq(checkEvent(event()), event(), "the simplest event");
  eq(Object.keys(checked), Object.keys(DEFAULTS), "the properties of the contract, in its order");
  // Unknown properties are left out, wherever they are.
  const extra = mutated(["x-unknown"], { anything: true });
  extra.meeting.extra = 1;
  extra.organizer.photo = "x";
  extra.attendees[0].rsvp = true;
  extra.exceptions[1].extra = 1;
  extra.exceptions[1].changes.organizer = { email: "evil@example.org" };
  extra.recurrence.rrule = "FREQ=SECONDLY";
  eq(checkEvent(extra), FULL);
});

test("calendar-item: checkEvent refuses every property that is missing or of the wrong type", () => {
  for (const key of Object.keys(DEFAULTS)) throws(() => checkEvent(mutated([key], REMOVE)), ProtocolError, `without ${key}`);
  for (const key of ["role", "cancelled", "responseRequested", "response", "allowNewTime"]) throws(() => checkEvent(mutated(["meeting", key], REMOVE)), isBadItem, `without meeting.${key}`);
  for (const key of ["email", "name"]) throws(() => checkEvent(mutated(["organizer", key], REMOVE)), isBadItem, `without organizer.${key}`);
  for (const key of ["email", "name", "role", "status"]) throws(() => checkEvent(mutated(["attendees", 0, key], REMOVE)), isBadItem, `without attendee.${key}`);
  for (const key of ["originalStart", "deleted", "changes"]) throws(() => checkEvent(mutated(["exceptions", 1, key], REMOVE)), isBadItem, `without exception.${key}`);
  const wrong = [
    [["kind"], ["task", "EVENT", "", null, 1]],
    [["uid"], ["", "x".repeat(301), null, 42, ["uid"], `a${ch(0x0a)}b`, `a${ch(0x09)}b`, `a${ch(0)}b`, `a${ch(0x202e)}b`, `a${ch(0x200b)}b`, ch(0xd800)]],
    [["summary"], [null, 42, ["s"], {}]],
    [["location"], [null, 42, undefined]],
    [["description"], [null, 42, ["d"]]],
    [["allDay"], [0, 1, "true", null, undefined]],
    [["start"], ["2026-03-10", "20260310T170000Z", "2026-03-10T17:00:00.000Z", "2026-02-30T17:00:00Z", "1899-12-31T23:59:59Z", "2201-01-01T00:00:00Z", "2026-03-10T17:00:00+01:00", null, 0, new Date(0), 1773162000000]],
    [["end"], ["2026-03-11", "2026-03-10T16:59:59Z", "2026-03-10T25:00:00Z", null]],
    [["timezone"], ["Europe/Paris", 0, [], {}, { bias: 0 }, undefined]],
    [["timezone", "bias"], [841, "0", null]],
    [["timezone", "daylight", "change"], [null]],
    [["timezone", "standard", "change", "month"], [13, 0]],
    [["busy"], ["BUSY", "oof", "", null, 2, "__proto__", "constructor"]],
    [["privacy"], ["personal", "normal", "", null, 0, "toString"]],
    [["reminder"], [-1, 40321, 1.5, "15", NaN, Infinity, undefined, true]],
    [["categories"], [null, "Work", { 0: "Work", length: 1 }, [1], [null], [["Work"]], undefined]],
    [["organizer"], ["me@example.org", [], undefined, {}]],
    [["organizer", "email"], ["", "me", "me@", "a b@example.org", "Me <me@example.org>", `me@example.org${ch(0x0d, 0x0a)}Bcc: x@example.org`, `${"m".repeat(250)}@example.org`, null, 42]],
    [["organizer", "name"], [null, 42]],
    [["attendees"], [null, {}, "a@example.org", undefined, [null], ["a@example.org"], [[]]]],
    [["attendees", 0, "email"], ["", "nobody", "a@example.org, b@example.org", "mailto:a@example.org", null]],
    [["attendees", 0, "role"], ["chair", "REQUIRED", "", null, 1]],
    [["attendees", 0, "status"], ["needs-action", "ACCEPTED", "", null, 3]],
    [["meeting"], [null, [], "organizer", undefined]],
    [["meeting", "role"], ["chair", "", null, "ORGANIZER"]],
    [["meeting", "cancelled"], [0, "false", null]],
    [["meeting", "responseRequested"], [1, null]],
    [["meeting", "response"], ["needs-action", "", null, "organizer"]],
    [["meeting", "allowNewTime"], ["yes", null]],
    [["recurrence"], ["FREQ=WEEKLY", [], {}, undefined, 0]],
    [["recurrence", "freq"], ["hourly"]],
    [["recurrence", "interval"], [0, 1000]],
    [["recurrence", "until"], ["2026-12-31", "garbage"]],
    [["exceptions"], [null, {}, undefined, [null], ["2026-03-17T17:00:00Z"], [[]]]],
    [["exceptions", 0, "originalStart"], ["2026-03-17", "20260317T170000Z", null, "2026-03-24T17:00:00Z"]],
    [["exceptions", 0, "deleted"], [1, "true", null]],
    [["exceptions", 1, "changes"], [null, [], "summary", undefined]],
    [["exceptions", 1, "changes", "summary"], [null, 42, undefined]],
    [["exceptions", 1, "changes", "start"], ["2026-03-24", "2026-03-24T19:00:01Z", "2026-03-24T20:00:00Z", null]],
    [["exceptions", 1, "changes", "end"], ["2026-03-25", "2026-03-24T17:59:59Z", null]],
    [["exceptions", 1, "changes", "allDay"], ["no", null, true]],
    [["exceptions", 1, "changes", "busy"], ["oof", null]],
    [["exceptions", 1, "changes", "privacy"], ["personal", null]],
    [["exceptions", 1, "changes", "reminder"], [-1, 40321, "5", undefined]],
    [["exceptions", 1, "changes", "categories"], [null, "x", [1]]],
    [["exceptions", 1, "changes", "attendees"], [null, [{}], [{ email: "x", name: "", role: "required", status: "unknown" }]]],
    [["exceptions", 1, "changes", "cancelled"], [0, null, "yes"]],
    [["exceptions", 1, "changes", "location"], [null, 7]],
    [["exceptions", 1, "changes", "description"], [null, []]],
    [["stamp"], ["2026-03-01", "20260301T080000Z", 0, undefined, "2026-03-01T08:00:00.000Z"]],
    [["sequence"], [-1, 2147483648, 1.5, "3", null, NaN, undefined]],
    [["readOnly"], ["", "yes", true, "regenerating", "read-only", "INCOMPLETE", undefined]],
  ];
  for (const [path, values] of wrong) {
    for (const value of values) {
      throws(() => checkEvent(mutated(path, value)), ProtocolError, `${path.join(".")} = ${typeof value === "string" ? JSON.stringify(value.slice(0, 40)) : String(value)}`);
    }
  }
  for (const bad of [null, undefined, "event", 0, [], [FULL], () => FULL]) throws(() => checkEvent(bad), isBadItem, String(bad));
});

test("calendar-item: checkEvent accepts every value of the contract", () => {
  const accepted = [
    [["busy"], ["free", "tentative", "busy", "away"]],
    [["privacy"], ["public", "private", "confidential"]],
    [["reminder"], [null, 0, 40320]],
    [["attendees", 0, "role"], ["required", "optional", "resource"]],
    [["attendees", 0, "status"], ["unknown", "tentative", "accepted", "declined", "not-responded"]],
    [["meeting", "response"], ["none", "tentative", "accepted", "declined", "not-responded"]],
    [["meeting", "cancelled"], [true, false]],
    [["sequence"], [0, 2147483647]],
    [["stamp"], [null, "1900-01-01T00:00:00Z", "2200-12-31T23:59:59Z"]],
    [["timezone"], [null, UTC_ZONE, PACIFIC, SYDNEY]],
    [["uid"], ["x", "x".repeat(300), "A B", "é@ü {} <> & \" '"]],
    [["summary"], ["", "x".repeat(1024)]],
    [["organizer", "name"], [""]],
    [["exceptions"], [[]]],
    [["categories"], [[]]],
    [["attendees"], [[]]],
  ];
  for (const [path, values] of accepted) {
    for (const value of values) {
      const input = mutated(path, value);
      let expected = input;
      for (const key of path) expected = expected[key];
      let got = checkEvent(input);
      for (const key of path) got = got[key];
      eq(got, expected, `${path.join(".")} = ${JSON.stringify(value)?.slice(0, 40)}`);
    }
  }
  for (const readOnly of [null, "calendar-type", "unsupported-recurrence", "incomplete"]) eq(checkEvent(event({ readOnly })).readOnly, readOnly);
});

test("calendar-item: checkEvent enforces the rules that hold between properties", () => {
  const refused = (fields, what, check = ProtocolError) => throws(() => checkEvent(event(fields)), check, what);
  // DATE with allDay, UTC without; end after start.
  eq(checkEvent(event({ allDay: true, start: "2026-03-10", end: "2026-03-11" })).end, "2026-03-11");
  refused({ allDay: true }, "all-day with instants");
  refused({ allDay: true, start: "2026-03-10", end: "2026-03-10T18:00:00Z" }, "all-day with one instant");
  refused({ allDay: true, start: "2026-03-10", end: "2026-03-10" }, "all-day ending the day it starts");
  refused({ allDay: true, start: "2026-03-10", end: "2026-03-09" }, "all-day ending before it starts");
  refused({ start: "2026-03-10", end: "2026-03-11" }, "timed with days");
  eq(checkEvent(event({ end: "2026-03-10T17:00:00Z" })).end, "2026-03-10T17:00:00Z", "a timed event may end when it starts");
  refused({ end: "2026-03-10T16:59:59Z" }, "end before start");
  // until is of the kind of the start, and never comes with count.
  refused({ recurrence: rule({ until: "2026-12-31" }) }, "a day as until of a timed event", isBadRecurrence);
  refused({ allDay: true, start: "2026-03-10", end: "2026-03-11", recurrence: rule({ until: "2026-12-31T00:00:00Z" }) }, "an instant as until of an all-day event", isBadRecurrence);
  eq(checkEvent(event({ allDay: true, start: "2026-03-10", end: "2026-03-11", recurrence: rule({ until: "2026-12-31" }) })).recurrence.until, "2026-12-31");
  refused({ recurrence: rule({ count: 5, until: "2026-12-31T17:00:00Z" }) }, "count with until", isBadRecurrence);
  // Exceptions: of a recurrence, one per occurrence, of the kind of the start, at most 256.
  const deleted = (originalStart) => ({ originalStart, deleted: true, changes: {} });
  refused({ exceptions: [deleted("2026-03-17T17:00:00Z")] }, "exceptions without a recurrence", isBadItem);
  refused({ recurrence: rule({}), exceptions: [deleted("2026-03-17T17:00:00Z"), deleted("2026-03-17T17:00:00Z")] }, "two exceptions for one occurrence", isBadItem);
  refused({ recurrence: rule({}), exceptions: [deleted("2026-03-17")] }, "a day as original start of a timed series", isBadItem);
  refused({ allDay: true, start: "2026-03-10", end: "2026-03-11", recurrence: rule({}), exceptions: [deleted("2026-03-17T00:00:00Z")] }, "an instant as original start of an all-day series", isBadItem);
  const many = (count) => Array.from({ length: count }, (_, i) => deleted(formatUtc(Date.UTC(2026, 2, 11, 17) + i * DAY)));
  eq(checkEvent(event({ recurrence: rule({}), exceptions: many(256) })).exceptions.length, 256);
  refused({ recurrence: rule({}), exceptions: many(257) }, "257 exceptions", isBadItem);
  refused({ recurrence: rule({}), exceptions: many(10_000) }, "10,000 exceptions", isBadItem);
  // The times of an exception follow its own allDay.
  const changed = (changes, fields = {}) => checkEvent(event({ recurrence: rule({}), exceptions: [{ originalStart: fields.allDay ? "2026-03-17" : "2026-03-17T17:00:00Z", deleted: false, changes }], ...fields })).exceptions[0].changes;
  eq(changed({ allDay: true, start: "2026-03-17", end: "2026-03-18" }), { allDay: true, start: "2026-03-17", end: "2026-03-18" });
  throws(() => changed({ allDay: true, start: "2026-03-17T10:00:00Z" }), isBadItem, "an instant in an all-day exception");
  throws(() => changed({ start: "2026-03-17" }), isBadItem, "a day in a timed exception");
  eq(changed({ start: "2026-03-17T10:00:00Z", end: "2026-03-17T10:00:00Z" }), { start: "2026-03-17T10:00:00Z", end: "2026-03-17T10:00:00Z" }, "an occurrence of no length");
  throws(() => changed({ start: "2026-03-17T10:00:00Z", end: "2026-03-17T09:59:59Z" }), isBadItem, "exception ending before it starts");
  throws(() => changed({ allDay: true, start: "2026-03-17", end: "2026-03-17" }), isBadItem, "an all-day exception of no length");
  eq(changed({ end: "2026-03-17T10:00:00Z" }), { end: "2026-03-17T10:00:00Z" }, "an end alone is not compared");
  eq(changed({ allDay: false, start: "2026-03-17T10:00:00Z" }, { allDay: true, start: "2026-03-10", end: "2026-03-11" }), { allDay: false, start: "2026-03-17T10:00:00Z" });
  // A deleted occurrence keeps nothing, whatever it was given.
  eq(checkEvent(event({ recurrence: rule({}), exceptions: [{ originalStart: "2026-03-17T17:00:00Z", deleted: true, changes: { summary: 42, anything: [] } }] })).exceptions[0].changes, {});
});

test("calendar-item: the organizer role needs an organizer, and with ownEmail the mailbox itself", () => {
  const organized = (email) => event({ organizer: email === null ? null : { email, name: "" }, meeting: { role: "organizer" } });
  throws(() => checkEvent(organized(null)), isBadItem, "organizer role without an organizer");
  eq(checkEvent(organized("anyone@example.org")).meeting.role, "organizer", "without ownEmail the address is not compared");
  eq(checkEvent(organized(OWN), { ownEmail: OWN }).meeting.role, "organizer");
  eq(checkEvent(organized("ME@EXAMPLE.ORG"), { ownEmail: OWN }).meeting.role, "organizer", "letter case does not matter");
  throws(() => checkEvent(organized("anyone@example.org"), { ownEmail: OWN }), isBadItem, "someone else as organizer");
  throws(() => checkEvent(organized("me@example.org.evil.example"), { ownEmail: OWN }), isBadItem);
  throws(() => checkEvent(organized(OWN), { ownEmail: "not an address" }), isBadItem);
  // Other roles say nothing about the organizer.
  eq(checkEvent(event({ meeting: { role: "attendee" } }), { ownEmail: OWN }).organizer, null);
  eq(checkEvent(event({ organizer: { email: "boss@example.org", name: "" }, meeting: { role: "none" } }), { ownEmail: OWN }).meeting.role, "none");
});

test("calendar-item: checkEvent cleans and cuts texts, and cuts long lists", () => {
  const dirty = `a${ch(0)}b${ch(0x07)}c${ch(0x202e)}d${ch(0x200b)}e`;
  const checked = checkEvent(event({
    summary: `${dirty}\r\nsecond line${"s".repeat(2000)}`,
    location: `${dirty}\ttab`,
    description: `${dirty}\r\nsecond${ch(0x2028)}third${"d".repeat(40_000)}`,
    categories: [` ${dirty} `, "Work", "Work", "", "   ", "c".repeat(300), ...Array.from({ length: 10_000 }, (_, i) => `Category ${i}`)],
    organizer: { email: " boss@example.org ", name: ` ${dirty}\nBoss${"n".repeat(500)} ` },
    attendees: [person("A@example.org", ` ${dirty} `), person("a@EXAMPLE.org", "twice"), ...Array.from({ length: 10_000 }, (_, i) => person(`p${i}@example.org`, "x"))],
  }));
  eq(checked.summary.length, 1024);
  assert(checked.summary.startsWith("abcde second line"), "one line");
  eq(checked.location, "abcde tab");
  eq(checked.description.length, 32768);
  assert(checked.description.startsWith("abcde\nsecond\nthird"), "several lines");
  eq(checked.categories.length, 50);
  eq(checked.categories.slice(0, 4), ["abcde", "Work", "c".repeat(255), "Category 0"]);
  eq(checked.organizer.email, "boss@example.org");
  eq(checked.organizer.name.length, 256);
  assert(checked.organizer.name.startsWith("abcde Boss"));
  eq(checked.attendees.length, 499, "500 entries looked at, one of them twice");
  eq(checked.attendees[0], person("A@example.org", "abcde"));
  eq(checked.attendees[1], person("p0@example.org", "x"));
  // Lone surrogates become the replacement character rather than travel on.
  eq(checkEvent(event({ summary: `a${ch(0xd800)}b` })).summary, `a${ch(0xfffd)}b`);
  // An invalid entry within the part that is kept is fatal; beyond it, it is not looked at.
  throws(() => checkEvent(event({ attendees: [person("nobody")] })), isBadItem);
  throws(() => checkEvent(event({ categories: ["a", 42] })), isBadItem);
  const padded = [...Array.from({ length: 500 }, (_, i) => person(`p${i}@example.org`)), person("nobody")];
  eq(checkEvent(event({ attendees: padded })).attendees.length, 500);
});

test("calendar-item: hostile property names in a description do nothing", () => {
  const hostile = JSON.parse(JSON.stringify(FULL).replace("{", '{"__proto__":{"polluted":true,"kind":"event"},"constructor":{"prototype":{"polluted":true}},"toString":"x","hasOwnProperty":"x",'));
  hostile.meeting = JSON.parse('{"__proto__":{"role":"organizer"},"role":"organizer","cancelled":false,"responseRequested":true,"response":"none","allowNewTime":true,"valueOf":1}');
  hostile.exceptions[1].changes = JSON.parse('{"__proto__":{"summary":"from the prototype"},"constructor":"x","start":"2026-03-24T18:00:00Z","end":"2026-03-24T19:00:00Z","summary":"Other"}');
  hostile.categories = ["__proto__", "constructor", "prototype"];
  const checked = checkEvent(hostile);
  eq(checked, { ...FULL, categories: ["__proto__", "constructor", "prototype"] });
  eq(Object.getPrototypeOf(checked), Object.prototype);
  eq(Object.getPrototypeOf(checked.exceptions[1].changes), Object.prototype);
  eq(Object.keys(checked.exceptions[1].changes), ["summary", "start", "end"]);
  eq({}.polluted, undefined, "Object.prototype is untouched");
  eq([].polluted, undefined);
  // Values inherited from a prototype are not the description's.
  throws(() => checkEvent(Object.create(FULL)), isBadItem, "an inherited description");
  throws(() => checkEvent(JSON.parse(`{"__proto__":${JSON.stringify(FULL)}}`)), isBadItem, "a description hidden in __proto__");
  const inheritedChanges = mutated(["exceptions", 1, "changes"], {});
  inheritedChanges.exceptions[1].changes = Object.create({ summary: "inherited", start: "garbage" });
  eq(checkEvent(inheritedChanges).exceptions[1].changes, {}, "inherited changes are not changes");
  // Such names as values of enumerations are refused like any other unknown value.
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    throws(() => checkEvent(mutated(["busy"], name)), isBadItem, `busy ${name}`);
    throws(() => checkEvent(mutated(["privacy"], name)), isBadItem);
    throws(() => checkEvent(mutated(["meeting", "role"], name)), isBadItem);
    throws(() => checkEvent(mutated(["attendees", 0, "role"], name)), isBadItem);
    throws(() => checkEvent(mutated(["attendees", 0, "status"], name)), isBadItem);
    throws(() => checkEvent(mutated(["readOnly"], name)), isBadItem);
    throws(() => checkEvent(mutated(["recurrence", "freq"], name)), isBadRecurrence);
  }
});

// ── Fuzzing ───────────────────────────────────────────────────────────────

const CALENDAR_TAGS = [
  "Timezone", "AllDayEvent", "Attendees", "Attendee", "Email", "Name", "BusyStatus", "Categories", "Category", "DtStamp", "EndTime", "Exception",
  "Exceptions", "Deleted", "ExceptionStartTime", "Location", "MeetingStatus", "OrganizerEmail", "OrganizerName", "Recurrence", "Type", "Until",
  "Occurrences", "Interval", "DayOfWeek", "DayOfMonth", "WeekOfMonth", "MonthOfYear", "Reminder", "Sensitivity", "Subject", "StartTime", "UID",
  "AttendeeStatus", "AttendeeType", "DisallowNewTimeProposal", "ResponseRequested", "AppointmentReplyTime", "ResponseType", "CalendarType",
  "IsLeapMonth", "FirstDayOfWeek",
];
const FUZZ_TEXTS = [
  "", "0", "1", "2", "3", "5", "7", "15", "62", "127", "255", "999", "-1", "x", "true", "20260310T170000Z", "20260310T180000Z", "20260311T000000Z",
  "20260312T070000Z", "20260317T170000Z", "20260230T170000Z", "45000831T235900Z", "18990101T000000Z", "2026-03-10T17:00:00.000Z", "a@example.org",
  OWN, "not an address", "uid-1", SPEC_PACIFIC, "A".repeat(232), "é".repeat(700), `x${ch(0x202e)}y${ch(0x07)}z`, "__proto__", "constructor",
];

test("calendar-item: random items are read into a valid description, or refused with a ProtocolError", () => {
  const random = prng(1207);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const node = (depth) => {
    const tag = pick(CALENDAR_TAGS);
    if (depth < 3 && random() < 0.25) return C(tag, Array.from({ length: Math.floor(random() * 5) }, () => node(depth + 1)));
    return random() < 0.1 ? C(tag) : C(tag, pick(FUZZ_TEXTS));
  };
  let described = 0;
  let refused = 0;
  for (let i = 0; i < 3000; i++) {
    // Most items have what an item needs; the rest is drawn at random.
    const children = random() < 0.85 ? item([], { uid: random() < 0.9 ? "uid-1" : null }) : [];
    if (random() < 0.3) children.push(C("AllDayEvent", "1"), C("Timezone", SPEC_PACIFIC));
    if (random() < 0.3) children.push(C("Recurrence", [C("Type", "0")]), C("Exceptions", [C("Exception", [C("ExceptionStartTime", "20260317T170000Z"), node(2), node(2)])]));
    const extra = Math.floor(random() * 6);
    for (let k = 0; k < extra; k++) children.push(node(0));
    if (random() < 0.2) children.push(body(pick(["1", "2", "x"]), pick(FUZZ_TEXTS)));
    const version = PROTOCOL_VERSIONS[i % 3];
    let description;
    try {
      description = readEvent(received(children.filter(Boolean)), { version, ownEmail: OWN, fallbackUid: random() < 0.5 ? "fallback" : null });
    } catch (e) {
      assert(e instanceof ProtocolError && typeof e.code === "string", `#${i}: ${e?.name}: ${e?.message}`);
      refused++;
      continue;
    }
    described++;
    eq(checkEvent(description, { ownEmail: OWN, fromServer: true }), description, `#${i}: what is read passes the check`);
    eq(checkEvent(held(description), { ownEmail: OWN }), held(description), `#${i}: and, once held, the check of what comes from Thunderbird`);
    assert(deepFrozen(description), "frozen");
    if (description.readOnly === null) {
      // What was read can be written, sent, and read again as the same thing.
      const again = readEvent(received(writeEvent(held(description), { version })), { version, ownEmail: OWN });
      const expected = {
        ...description,
        timezone: description.timezone ?? UTC_ZONE,
        sequence: 0,
        meeting: {
          ...description.meeting,
          response: version === "12.1" && description.meeting.role === "attendee" ? null : "none",
          responseRequested: version === "12.1" ? description.meeting.role !== "none" : description.meeting.responseRequested,
          allowNewTime: version === "12.1" ? true : description.meeting.allowNewTime,
          cancelled: description.meeting.cancelled,
        },
        recurrence: description.recurrence && { ...description.recurrence, weekStart: version === "14.1" ? description.recurrence.weekStart : null },
        exceptions: again.exceptions,
      };
      eq(again, expected, `#${i}: written and read again`);
      eq(again.exceptions.map((x) => [x.originalStart, x.deleted]), description.exceptions.map((x) => [x.originalStart, x.deleted]), `#${i}: the same occurrences`);
      // Written back unchanged, as a Change: the same elements, without any text, which the server keeps.
      const noBody = (e) => !(e.ns === "AirSyncBase" && e.tag === "Body");
      const bare = (elements) => elements.filter(noBody).map((e) => ({ ...e, children: e.children.map((x) => ({ ...x, children: x.children.filter(noBody) })) })).map(shape);
      eq(writeEvent(held(description), { version, previous: held(description) }).map(shape), bare(writeEvent(held(description), { version })), `#${i}: unchanged, nothing but the texts is left out`);
    } else {
      throws(() => writeEvent(held(description), { version }), hasCode("READ_ONLY_ITEM"));
    }
  }
  assert(described > 500 && refused > 500, `both outcomes are exercised (${described} read, ${refused} refused)`);
});

test("calendar-item: a description with anything anywhere is checked, or refused with a ProtocolError", () => {
  const random = prng(7021);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const junk = () => pick([
    null, undefined, 0, -1, 1.5, NaN, Infinity, 2 ** 53, "", "x", "2026-03-10", "2026-03-10T17:00:00Z", "a@example.org", "__proto__", "x".repeat(70_000), true, false,
    "free", "private", "optional", "declined", "none", "monthly", "MO", 1, 5, 15, 255, "Text\nof two lines", "2026-12-31T23:59:59Z", "b@example.org", ["Work", "Home"],
    [], {}, [null], [[]], [{}], { a: 1 }, { length: 3 }, ["x", 1], () => 1, Symbol("s"), new Date(0), new Map(), Object.create(null), JSON.parse('{"__proto__":{"x":1}}'),
  ]);
  /** Every path of a description, as lists of keys. */
  const paths = (value, prefix = []) => {
    if (value === null || typeof value !== "object") return [prefix];
    return [prefix, ...Object.keys(value).flatMap((key) => paths(value[key], [...prefix, Array.isArray(value) ? Number(key) : key]))];
  };
  const all = paths(FULL).filter((path) => path.length > 0);
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 6000; i++) {
    let description = JSON.parse(JSON.stringify(FULL));
    const changes = 1 + Math.floor(random() * 2);
    for (let k = 0; k < changes; k++) {
      const path = pick(all);
      let at = description;
      for (const key of path.slice(0, -1)) at = at === null || typeof at !== "object" ? {} : at[key];
      if (at !== null && typeof at === "object") {
        if (random() < 0.15) delete at[path[path.length - 1]];
        else at[path[path.length - 1]] = junk();
      }
    }
    if (random() < 0.02) description = junk();
    let checked;
    try {
      checked = checkEvent(description, random() < 0.5 ? { ownEmail: OWN } : {});
    } catch (e) {
      assert(e instanceof ProtocolError && typeof e.code === "string", `#${i}: ${e?.name}: ${e?.message}`);
      refused++;
      continue;
    }
    accepted++;
    assert(deepFrozen(checked), "frozen");
    eq(checkEvent(checked), checked, `#${i}: checking twice changes nothing`);
    eq(JSON.parse(JSON.stringify(checked)), checked, `#${i}: plain data`);
    // What passes the check can always be written and sent.
    const data = writeEvent(checked, { version: PROTOCOL_VERSIONS[i % 3] });
    eq(readEvent(received(data), { version: PROTOCOL_VERSIONS[i % 3], ownEmail: OWN }).uid, checked.uid, `#${i}: written, sent and read`);
  }
  assert(accepted > 150 && refused > 3000, `both outcomes are exercised (${accepted} accepted, ${refused} refused)`);
  eq({}.polluted, undefined);
});

test("calendar-item: the reason of an error names a field, never its content", () => {
  const secrets = ["Secret-Subject-1234", "secret.person@example.org", "Secret Location"];
  const reasons = [
    throws(() => read(item([C("Subject", secrets[0]), C("Location", secrets[2]), C("OrganizerEmail", secrets[1])], { end: "20260310T160000Z" })), isBadItem),
    throws(() => read(item([C("Subject", secrets[0])], { uid: `${secrets[0]}${ch(0x202e)}` })), isBadItem),
    throws(() => read(item([C("Subject", secrets[0]), C("Recurrence", [C("Type", "9")])])), isBadRecurrence),
    throws(() => checkEvent(event({ summary: secrets[0], organizer: { email: `${secrets[1]} x`, name: secrets[2] } })), isBadItem),
    throws(() => checkEvent(event({ uid: `${secrets[0]}\n` })), isBadItem),
    throws(() => checkEvent(event({ attendees: [person(`${secrets[1]},`, secrets[2])] })), isBadItem),
    throws(() => checkEvent(event({ categories: [secrets[0], 1] })), isBadItem),
  ].map((e) => e.message);
  for (const reason of reasons) {
    for (const secret of secrets) assert(!reason.includes(secret) && !reason.toLowerCase().includes("secret"), `"${reason}" holds no content`);
    assert(reason.length < 120, "a short reason");
  }
  eq(parseDate("2026-03-10"), Date.UTC(2026, 2, 10));
  eq(parseUtc("2026-03-10T17:00:00Z"), Date.UTC(2026, 2, 10, 17));
  eq(localMidnightUtc(PACIFIC, "2026-03-10"), Date.UTC(2026, 2, 10, 7));
  eq(HOUR, 3_600_000);
});
