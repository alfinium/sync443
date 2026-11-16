// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the MeetingRequest reader against [MS-ASEMAIL] 2.2.2.48 (the
 * element), 2.2.2.37, 3.1.4.7 and 4.3 (GlobalObjId and its conversion to a
 * UID) and [MS-ASDTYPE] 2.3 (dates). Everything read here is chosen by the
 * sender of an invitation: the tests are mostly hostile values.
 */

import { test, assert, eq, prng } from "./harness.mjs";
import { readMeetingRequest, globalObjIdUid, MAX_UID, MAX_GLOBAL_OBJ_ID_BYTES } from "../../src/core/meeting-request.mjs";
import { decodeTimeZone } from "../../src/core/eas-timezone.mjs";
import { el, encode, decode } from "../../src/core/wbxml.mjs";
import { base64 } from "../../src/core/base64.mjs";
import { encodeUtf8 } from "../../src/core/utf8.mjs";

const ch = (code) => String.fromCodePoint(code);
const wire = (tree) => decode(encode(tree));

// ── GlobalObjId ───────────────────────────────────────────────────────────

const CLASS_ID = [0x04, 0x00, 0x00, 0x00, 0x82, 0x00, 0xe0, 0x00, 0x74, 0xc5, 0xb7, 0x10, 0x1a, 0x82, 0xe0, 0x08];
const NOW = [0xe0, 0x40, 0xc9, 0xc1, 0x26, 0x85, 0xc4, 0x01];
const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");

/** The bytes of a GlobalObjId; every field can be given wrong. */
function structure({ classId = CLASS_ID, instance = [0, 0, 0, 0], now = NOW, reserved = [0, 0, 0, 0, 0, 0, 0, 0], data = [], count = data.length } = {}) {
  return Uint8Array.from([...classId, ...instance, ...now, ...reserved, ...le32(count), ...data]);
}
const globalObjId = (fields) => base64(structure(fields));
const vcal = (uidBytes, { version = [1, 0, 0, 0], end = [0] } = {}) => [...ascii("vCal-Uid"), ...version, ...uidBytes, ...end];
const OUTLOOK_DATA = [0x0b, 0xf0, 0xed, 0x4b, 0x6e, 0x4e, 0xe9, 0x4e, 0x9e, 0x39, 0xe3, 0x86, 0x7b, 0x37, 0x8e, 0xf3];

test("globalObjIdUid: the two examples of [MS-ASEMAIL] 4.3", () => {
  eq(
    globalObjIdUid("BAAAAIIA4AB0xbcQGoLgCAfUCRDgQMnBJoXEAQAAAAAAAAAAEAAAAAvw7UtuTulOnjnjhns3jvM="),
    "040000008200E00074C5B7101A82E00800000000E040C9C12685C4010000000000000000100000000BF0ED4B6E4EE94E9E39E3867B378EF3",
  );
  eq(
    globalObjIdUid("BAAAAIIA4AB0xbcQGoLgCAAAAAAAAAAAAAAAAAAAAAAAAAAAMwAAAHZDYWwtVWlkAQAAAHs4MTQxMkQzQy0yQTI0LTRFOUQtQjIwRS0xMUY3QkJFOTI3OTl9AA=="),
    "{81412D3C-2A24-4E9D-B20E-11F7BBE92799}",
  );
});

test("globalObjIdUid: the hexadecimal form zeroes the instance date, and nothing else", () => {
  const series = globalObjIdUid(globalObjId({ data: OUTLOOK_DATA }));
  const occurrence = globalObjIdUid(globalObjId({ instance: [0x07, 0xea, 11, 20], data: OUTLOOK_DATA }));
  eq(occurrence, series, "an occurrence names the meeting of its series");
  eq(series, hex(structure({ data: OUTLOOK_DATA })));
  eq(series.length, 2 * 56);
  assert(/^[0-9A-F]+$/.test(series), "upper-case hexadecimal");
  // The other fields are part of the identifier.
  assert(globalObjIdUid(globalObjId({ now: [1, 2, 3, 4, 5, 6, 7, 8], data: OUTLOOK_DATA })) !== series, "NOW");
  assert(globalObjIdUid(globalObjId({ reserved: [9, 0, 0, 0, 0, 0, 0, 0], data: OUTLOOK_DATA })) !== series, "RESERVED");
  assert(globalObjIdUid(globalObjId({ data: [...OUTLOOK_DATA.slice(1), 0] })) !== series, "DATA");
});

test("globalObjIdUid: data that does not start with the vCal marker is an identifier in hexadecimal", () => {
  for (const data of [[], [0], ascii("vCal-Ui"), [...ascii("vcal-uid"), 1, 0, 0, 0, 0x61, 0], ascii("xvCal-Uid"), [0xff, 0xfe, 0xfd]]) {
    eq(globalObjIdUid(globalObjId({ data })), hex(structure({ data })), `data of ${data.length} bytes`);
  }
});

test("globalObjIdUid: wrong lengths are refused", () => {
  const whole = structure({ data: OUTLOOK_DATA });
  for (let length = 0; length < 40; length++) eq(globalObjIdUid(base64(whole.subarray(0, length))), null, `${length} bytes`);
  for (const count of [0, 1, 15, 17, 0x100, 0x10000, 0x1000010, 0x7fffffff, 0x80000000, 0xffffffff, 0xfffffff0]) {
    eq(globalObjIdUid(globalObjId({ data: OUTLOOK_DATA, count })), null, `BYTECOUNT ${count} for 16 bytes`);
  }
  eq(globalObjIdUid(base64(Uint8Array.from([...whole, 0]))), null, "a byte after the data");
  eq(globalObjIdUid(base64(whole.subarray(0, whole.length - 1))), null, "a byte missing");
});

test("globalObjIdUid: the result has at most 300 characters", () => {
  const dataOf = (total) => Array.from({ length: total - 40 }, (_, i) => (i * 7 + 1) & 0xff);
  eq(globalObjIdUid(globalObjId({ data: dataOf(150) })).length, MAX_UID, "150 bytes: 300 hexadecimal characters");
  eq(globalObjIdUid(globalObjId({ data: dataOf(151) })), null, "151 bytes");
  eq(globalObjIdUid(globalObjId({ data: dataOf(MAX_GLOBAL_OBJ_ID_BYTES) })), null, "the largest structure decoded");
  eq(globalObjIdUid(globalObjId({ data: dataOf(MAX_GLOBAL_OBJ_ID_BYTES + 1) })), null, "beyond the limit");
  eq(globalObjIdUid("A".repeat(4 * 1024 * 1024)), null, "megabytes of base64");

  eq(globalObjIdUid(globalObjId({ data: vcal(ascii("u".repeat(MAX_UID))) })), "u".repeat(MAX_UID));
  eq(globalObjIdUid(globalObjId({ data: vcal(ascii("u".repeat(MAX_UID + 1))) })), null);
  const wide = ch(0x20ac).repeat(MAX_UID); // three bytes each: the largest UID in bytes
  eq(globalObjIdUid(globalObjId({ data: vcal(Array.from(encodeUtf8(wide))) })), wide);
  eq(structure({ data: vcal(Array.from(encodeUtf8(wide))) }).length, MAX_GLOBAL_OBJ_ID_BYTES);
  eq(globalObjIdUid(globalObjId({ data: vcal(Array.from(encodeUtf8(`${wide}x`))) })), null);
});

test("globalObjIdUid: a wrong CLASSID or instance date is refused", () => {
  for (let i = 0; i < 16; i++) {
    const classId = [...CLASS_ID];
    classId[i] ^= 0x01;
    eq(globalObjIdUid(globalObjId({ classId, data: OUTLOOK_DATA })), null, `CLASSID byte ${i}`);
  }
  const good = [[0x07, 0xd4, 9, 16], [0x06, 0x41, 1, 1], [0x08, 0x98, 12, 31]];
  for (const instance of good) assert(globalObjIdUid(globalObjId({ instance, data: OUTLOOK_DATA })) !== null, `instance ${instance}`);
  const bad = [[0x07, 0xd4, 0, 16], [0x07, 0xd4, 13, 16], [0x07, 0xd4, 9, 0], [0x07, 0xd4, 9, 32], [0, 0, 9, 16], [0x06, 0x40, 1, 1], [0xff, 0xff, 1, 1], [0, 0, 0, 1], [0, 1, 0, 0]];
  for (const instance of bad) eq(globalObjIdUid(globalObjId({ instance, data: OUTLOOK_DATA })), null, `instance ${instance}`);
});

test("globalObjIdUid: a vCal payload gives its UID, exactly", () => {
  const uid = (text, options) => globalObjIdUid(globalObjId({ data: vcal(Array.from(encodeUtf8(text)), options) }));
  eq(uid("event-1@example.org"), "event-1@example.org");
  eq(uid("a;b,c\\d:e \"f\""), "a;b,c\\d:e \"f\"", "punctuation is kept as it is");
  eq(uid(`r${ch(0xe9)}union-${ch(0x1f600)}`), `r${ch(0xe9)}union-${ch(0x1f600)}`, "UTF-8");
  eq(uid(" x "), " x ", "not trimmed: the UID is taken as it is");
  // The instance date does not change it.
  eq(globalObjIdUid(globalObjId({ instance: [0x07, 0xea, 11, 20], data: vcal(ascii("abc")) })), "abc");
});

test("globalObjIdUid: a malformed vCal payload is refused, never read as something else", () => {
  const uid = (uidBytes, options) => globalObjIdUid(globalObjId({ data: vcal(uidBytes, options) }));
  eq(uid([]), null, "empty UID");
  eq(uid(ascii("   ")), null, "blank UID");
  eq(uid(ascii("abc"), { end: [] }), null, "no final NUL");
  eq(uid(ascii("abc"), { end: [0x20] }), null, "another final byte");
  eq(uid(ascii("abc"), { end: [0, 0] }), null, "two NULs: one is inside the UID");
  eq(uid([0x61, 0x00, 0x62]), null, "NUL inside");
  for (const version of [[0, 0, 0, 0], [2, 0, 0, 0], [1, 0, 0, 1], [0, 0, 0, 1], [0x31, 0, 0, 0]]) eq(uid(ascii("abc"), { version }), null, `version ${version}`);
  for (let cut = 8; cut <= 13; cut++) {
    eq(globalObjIdUid(globalObjId({ data: vcal(ascii("a")).slice(0, cut) })), null, `payload cut to ${cut} bytes`);
  }
  for (const code of [0x01, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f]) eq(uid([0x61, code, 0x62]), null, `control ${code}`);
  for (const code of [0x85, 0x9f, 0x2028, 0x2029, 0x202e, 0x202a, 0x2066, 0x200b, 0x200e, 0x200f, 0x061c, 0xfeff, 0xad]) {
    eq(uid(Array.from(encodeUtf8(`a${ch(code)}b`))), null, `U+${code.toString(16)}`);
  }
  for (const bytes of [[0xff], [0xc3], [0xc3, 0x28], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xc0, 0xaf], [0xef, 0xbf, 0xbd]]) {
    eq(uid([0x61, ...bytes, 0x62]), null, `bytes ${bytes} are not a UID`);
  }
});

test("globalObjIdUid: base64 is read strictly", () => {
  const good = globalObjId({ data: OUTLOOK_DATA });
  assert(globalObjIdUid(good) !== null);
  eq(good.length % 4, 0);
  const bad = [
    "", " ", `${good} `, ` ${good}`, `${good}\n`, `${good}\r\n`, `${good.slice(0, 20)}\r\n${good.slice(20)}`, `${good.slice(0, 20)} ${good.slice(20)}`,
    good.slice(0, -1), good.replace(/=+$/, ""), `${good}=`, `${good}====`, `=${good.slice(1)}`, good.replace("A", "-"), good.replace("A", "_"),
    good.replace("A", "*"), good.replace("A", ch(0xe9)), `${good}${ch(0)}`, good.slice(0, 40) + "=" + good.slice(41),
  ];
  for (const value of bad) eq(globalObjIdUid(value), null, JSON.stringify(value).slice(0, 40));
  for (const value of [null, undefined, 5, {}, [], true, new Uint8Array(56), ["BAAA"]]) eq(globalObjIdUid(value), null, String(value));
  // Unused bits of the last group must be zero: one identifier, one spelling.
  const oneLeft = globalObjId({ data: [...OUTLOOK_DATA, 1, 2] }); // 58 bytes: one byte in the last group
  assert(oneLeft.endsWith("==") && globalObjIdUid(oneLeft) !== null);
  eq(globalObjIdUid(`${oneLeft.slice(0, -3)}h==`), null, "four stray bits");
  const twoLeft = globalObjId({ data: [...OUTLOOK_DATA, 1, 2, 3] }); // 59 bytes
  assert(twoLeft.endsWith("=") && !twoLeft.endsWith("==") && globalObjIdUid(twoLeft) !== null);
  eq(globalObjIdUid(`${twoLeft.slice(0, -2)}N=`), null, "two stray bits");
});

test("globalObjIdUid: random and damaged values give null or a UID on one line, and never throw", () => {
  const random = prng(0x61c88647);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  const good = structure({ data: vcal(ascii("meeting-42@example.org")) });
  let uids = 0;
  for (let round = 0; round < 4000; round++) {
    let value;
    const kind = round % 4;
    if (kind === 0) {
      value = Array.from({ length: Math.floor(random() * 120) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    } else if (kind === 1) {
      value = base64(Uint8Array.from({ length: Math.floor(random() * 200) }, () => Math.floor(random() * 256)));
    } else {
      const bytes = Uint8Array.from(good);
      for (let n = 0; n <= kind - 2; n++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
      value = base64(bytes.subarray(0, kind === 3 && random() < 0.3 ? Math.floor(random() * bytes.length) : bytes.length));
    }
    const uid = globalObjIdUid(value);
    if (uid === null) continue;
    uids++;
    assert(typeof uid === "string" && uid.length >= 1 && uid.length <= MAX_UID, "bounded");
    assert(!/[\r\n\t]/.test(uid) && uid.isWellFormed(), "one line of text");
    for (const c of uid) assert(c.codePointAt(0) >= 0x20 && c.codePointAt(0) !== 0x7f, "no control character");
  }
  assert(uids > 100, "some damaged values still name a meeting");
});

// ── MeetingRequest ────────────────────────────────────────────────────────

/** A TimeZone value ([MS-ASDTYPE] 2.7.6): 172 bytes in base64. Dates are [month, weekday, week, hour]. */
function timeZone({ bias = 0, standardDate = null, standardBias = 0, daylightDate = null, daylightBias = 0 } = {}) {
  const bytes = new Uint8Array(172);
  const put32 = (at, n) => bytes.set(le32(n >>> 0), at);
  const putDate = (at, date) => {
    if (!date) return;
    const [month, weekday, week, hour] = date;
    bytes.set([0, 0, month, 0, weekday, 0, week, 0, hour, 0], at);
  };
  put32(0, bias);
  putDate(68, standardDate);
  put32(84, standardBias);
  putDate(152, daylightDate);
  put32(168, daylightBias);
  return base64(bytes);
}
const PARIS = timeZone({ bias: -60, standardDate: [10, 0, 5, 3], daylightDate: [3, 0, 5, 2], daylightBias: -60 });
const UID_VALUE = globalObjId({ data: vcal(ascii("meeting-42@example.org")) });

const request = (children) => wire(el("Email:MeetingRequest", children));
const read = (children) => readMeetingRequest(request(children));
const BLANK = {
  uid: null, start: null, end: null, allDay: false, location: "", organizer: null, responseRequested: false, recurrenceId: null,
  instanceType: null, messageType: null, busy: "busy", sensitivity: "public", zone: null, recurring: false,
};

test("readMeetingRequest: a complete invitation", () => {
  const r = read([
    el("AllDayEvent", "0"),
    el("StartTime", "2026-11-20T09:00:00.000Z"),
    el("DtStamp", "2026-11-16T08:00:00.000Z"),
    el("EndTime", "2026-11-20T10:30:00.000Z"),
    el("InstanceType", "0"),
    el("Location", "Room 4"),
    el("Organizer", "\"Ana Ruiz\" <ana.ruiz@example.org>"),
    el("Reminder", "900"),
    el("ResponseRequested", "1"),
    el("Sensitivity", "2"),
    el("BusyStatus", "1"),
    el("TimeZone", PARIS),
    el("GlobalObjId", UID_VALUE),
    el("Email2:MeetingMessageType", "1"),
  ]);
  eq(r, {
    uid: "meeting-42@example.org",
    start: "2026-11-20T09:00:00Z",
    end: "2026-11-20T10:30:00Z",
    allDay: false,
    location: "Room 4",
    organizer: "ana.ruiz@example.org",
    responseRequested: true,
    recurrenceId: null,
    instanceType: 0,
    messageType: 1,
    busy: "tentative",
    sensitivity: "private",
    zone: decodeTimeZone(PARIS),
    recurring: false,
  });
  eq(r.zone.bias, -60);
  eq(Object.keys(r), Object.keys(BLANK), "the same keys, in the same order, whatever the element holds");
});

test("readMeetingRequest: an empty element, or anything that is not an element, gives the blank record", () => {
  eq(read([]), BLANK);
  for (const bad of [null, undefined, "x", 42, {}, { children: "x" }, [], true]) eq(readMeetingRequest(bad), BLANK, String(bad));
  // Elements of other namespaces with the same names are not read.
  eq(read([
    el("Calendar:StartTime", "20261120T090000Z"), el("Calendar:Location", "x"), el("Calendar:AllDayEvent", "1"),
    el("Calendar:Sensitivity", "3"), el("Calendar:BusyStatus", "0"), el("Calendar:ResponseRequested", "1"),
    el("Calendar:Timezone", PARIS), el("Email2:Sender", "a@example.org"), el("Tasks:Recurrence", [el("Tasks:Type", "0")]),
  ]), BLANK);
});

test("readMeetingRequest: dates in the exact formats only", () => {
  const start = (value) => read([el("StartTime", value)]).start;
  eq(start("2026-11-20T09:00:00.000Z"), "2026-11-20T09:00:00Z");
  eq(start("2026-11-20T09:00:00Z"), "2026-11-20T09:00:00Z", "milliseconds are optional");
  eq(start("2026-11-20T09:00:00.999Z"), "2026-11-20T09:00:00Z");
  eq(start("20261120T090000Z"), "2026-11-20T09:00:00Z", "compact form");
  eq(start("2024-02-29T23:59:59.000Z"), "2024-02-29T23:59:59Z", "leap day");
  eq(start("1900-01-01T00:00:00Z"), "1900-01-01T00:00:00Z");
  eq(start("2200-12-31T23:59:59Z"), "2200-12-31T23:59:59Z");
  const bad = [
    "", "2026-11-20", "2026-11-20T09:00:00", "2026-11-20T09:00Z", "2026-11-20T09:00:00.0Z", "2026-11-20T09:00:00.0000Z",
    "2026-11-20T09:00:00+01:00", "2026-11-20 09:00:00Z", "2026-11-20t09:00:00z", " 2026-11-20T09:00:00Z", "2026-11-20T09:00:00Z ",
    "2026-11-20T09:00:00Z\n", "2026-02-29T09:00:00Z", "2026-02-30T09:00:00Z", "2026-04-31T09:00:00Z", "2026-00-10T09:00:00Z",
    "2026-13-10T09:00:00Z", "2026-11-00T09:00:00Z", "2026-11-32T09:00:00Z", "2026-11-20T24:00:00Z", "2026-11-20T09:60:00Z",
    "2026-11-20T09:00:60Z", "1899-12-31T23:59:59Z", "2201-01-01T00:00:00Z", "0000-00-00T00:00:00Z", "9999-12-31T23:59:59Z",
    "20261120T090000", "20261120090000Z", "2026-1120T090000Z", "+02026-11-20T09:00:00Z", "2026-11-20T09:00:00Z2026-11-20T09:00:00Z",
    `2026-11-20T09:00:00Z${ch(0x200b)}`, "x".repeat(5000),
  ];
  for (const value of bad) eq(start(value), null, JSON.stringify(value).slice(0, 40));
  const r = read([el("EndTime", "2026-11-20T10:00:00Z"), el("RecurrenceId", "20261120T090000Z"), el("DtStamp", "nonsense")]);
  eq([r.start, r.end, r.recurrenceId], [null, "2026-11-20T10:00:00Z", "2026-11-20T09:00:00Z"]);
});

test("readMeetingRequest: an end before the start is not kept", () => {
  const span = (start, end) => {
    const r = read([el("StartTime", start), el("EndTime", end)]);
    return [r.start, r.end];
  };
  eq(span("2026-11-20T09:00:00Z", "2026-11-20T08:59:59Z"), ["2026-11-20T09:00:00Z", null]);
  eq(span("2026-11-20T09:00:00Z", "20251120T090000Z"), ["2026-11-20T09:00:00Z", null]);
  eq(span("2026-11-20T09:00:00Z", "2026-11-20T09:00:00.000Z"), ["2026-11-20T09:00:00Z", "2026-11-20T09:00:00Z"], "an instant");
  eq(span("bad", "2026-11-20T08:00:00Z"), [null, "2026-11-20T08:00:00Z"]);
});

test("readMeetingRequest: the organizer is a validated address or nothing", () => {
  const organizer = (value) => read([el("Organizer", value)]).organizer;
  eq(organizer("ana@example.org"), "ana@example.org");
  eq(organizer("  ana@example.org  "), "ana@example.org");
  eq(organizer("<ana@example.org>"), "ana@example.org");
  eq(organizer("Ana Ruiz <ana@example.org>"), "ana@example.org");
  eq(organizer("\"Ruiz, Ana\" <Ana.Ruiz+cal@Example.ORG>"), "Ana.Ruiz+cal@Example.ORG", "kept as written");
  eq(organizer("\"<eve@evil.example>\" <ana@example.org>"), "ana@example.org", "the last pair of brackets, which ends the value");
  eq(organizer("eve@evil.example <ana@example.org>"), "ana@example.org", "a name that looks like an address is a name");
  const bad = [
    "", " ", "ana", "ana@", "@example.org", "ana@localhost", "ana@example.org, eve@evil.example", "ana@example.org eve@evil.example",
    "<ana@example.org> eve@evil.example", "<ana@example.org", "ana@example.org>", "<<ana@example.org>>", "<ana@example.org><eve@evil.example",
    "Ana <ana@example.org> (eve@evil.example)", "Ana <>", "Ana <ana ruiz@example.org>", "mailto:ana@example.org", "ana@example.org\nBcc: eve@evil.example",
    "ana@example.org\r\n", "Ana\n<ana@example.org>", `ana@example.org${ch(1)}`, `ana${ch(0x202e)}@example.org`, `ana@exam${ch(0x200b)}ple.org`,
    `Ana <ana@example.org>${ch(0x2028)}`, "ana@exa_mple.org", "ana@-example.org", "a..b@example.org", ".ana@example.org", `${"a".repeat(65)}@example.org`,
    `ana@${"a".repeat(250)}.org`, `${"x".repeat(3000)} <ana@example.org>`, "ana@[192.0.2.1]", "\"ana\"@example.org", `an${ch(0xe9)}@example.org`,
  ];
  for (const value of bad) eq(organizer(value), null, JSON.stringify(value).slice(0, 50));
});

test("readMeetingRequest: the location is one clean, bounded line", () => {
  const location = (value) => read([el("Location", value)]).location;
  eq(location("  Room 4, 2nd floor  "), "Room 4, 2nd floor");
  eq(location(`Room${ch(0x202e)} 4\r\nBEGIN:VEVENT\n${ch(7)}x${ch(0x200b)}y${ch(0x2028)}z${ch(0x85)}`), "Room 4 BEGIN:VEVENT xy z");
  eq(location(`\t${ch(0x1b)}[31m`), "[31m");
  eq(location("x".repeat(5000)).length, 1024);
  eq(location(`${"x".repeat(1023)}${ch(0x1f600)}`), "x".repeat(1023), "never half a character");
  eq(location(" ".repeat(2000) + "x"), "x");
  eq(location(""), "");
  // A huge value is only read at its start, cut between two characters.
  for (let lead = 0; lead < 4; lead++) {
    const huge = location("x".repeat(lead) + ch(0x20ac).repeat(200_000));
    eq(huge, "x".repeat(lead) + ch(0x20ac).repeat(1024 - lead), `${lead} leading bytes`);
  }
  eq(location(`${ch(7).repeat(16 * 1024 - 1)}${ch(0x1f600)}tail`), "", "what is past the part read is not looked at");
  eq(location(`${ch(7).repeat(16 * 1024 - 4)}${ch(0x1f600)}tail`), ch(0x1f600));
});

test("readMeetingRequest: flags and enumerations; anything else is the default", () => {
  const field = (name, value, key) => read([el(name, value)])[key];
  eq([field("AllDayEvent", "1", "allDay"), field("AllDayEvent", "0", "allDay")], [true, false]);
  eq([field("ResponseRequested", "1", "responseRequested"), field("ResponseRequested", "0", "responseRequested")], [true, false]);
  for (const bad of ["", "2", "true", "01", " 1", "1 ", "-1", "yes", "1\n"]) {
    eq(field("AllDayEvent", bad, "allDay"), false, `AllDayEvent ${JSON.stringify(bad)}`);
    eq(field("ResponseRequested", bad, "responseRequested"), false, `ResponseRequested ${JSON.stringify(bad)}`);
  }
  eq(["0", "1", "2", "3", "4"].map((x) => field("InstanceType", x, "instanceType")), [0, 1, 2, 3, 4]);
  eq(["0", "1", "2", "3", "4", "5", "6"].map((x) => field("Email2:MeetingMessageType", x, "messageType")), [0, 1, 2, 3, 4, 5, 6]);
  eq(["0", "1", "2", "3"].map((x) => field("BusyStatus", x, "busy")), ["free", "tentative", "busy", "away"]);
  eq(["0", "1", "2", "3"].map((x) => field("Sensitivity", x, "sensitivity")), ["public", "private", "private", "confidential"]);
  for (const bad of ["", "-1", "5", "7", "255", "256", "1.0", "1e0", "0x1", " 1", "one", "99999999999", "__proto__", "constructor"]) {
    eq(field("InstanceType", bad, "instanceType"), null, `InstanceType ${JSON.stringify(bad)}`);
    eq(field("BusyStatus", bad, "busy"), "busy", `BusyStatus ${JSON.stringify(bad)}`);
    eq(field("Sensitivity", bad, "sensitivity"), "public", `Sensitivity ${JSON.stringify(bad)}`);
    if (bad !== "5") eq(field("Email2:MeetingMessageType", bad, "messageType"), null, `MeetingMessageType ${JSON.stringify(bad)}`);
  }
  eq(field("BusyStatus", "4", "busy"), "busy", "working elsewhere does not exist before 16.0");
  eq(field("Email:Importance", "6", "messageType"), null, "the type is read in the Email2 namespace only");
});

test("readMeetingRequest: the time zone is decoded or left out", () => {
  eq(read([el("TimeZone", PARIS)]).zone, decodeTimeZone(PARIS));
  const utc = timeZone();
  eq(read([el("TimeZone", utc)]).zone, decodeTimeZone(utc));
  const bad = ["", "AAAA", PARIS.slice(0, -4), `${PARIS}AAAA`, PARIS.replace("==", "="), "!".repeat(232), "x".repeat(100_000)];
  for (const value of bad) eq(read([el("TimeZone", value)]).zone, null, JSON.stringify(value).slice(0, 30));
  // A month 13 is no change at all: the structure is refused, the rest of the request is read.
  const r = read([el("TimeZone", timeZone({ bias: -60, standardDate: [13, 0, 5, 3], daylightDate: [3, 0, 5, 2], daylightBias: -60 })), el("Location", "x")]);
  eq([r.zone, r.location], [null, "x"]);
});

test("readMeetingRequest: recurring when the request carries a recurrence or says it is a series", () => {
  const recurrence = el("Recurrences", [el("Recurrence", [el("Type", "1"), el("Interval", "1"), el("DayOfWeek", "2")])]);
  eq(read([recurrence]).recurring, true);
  eq(read([el("InstanceType", "1")]).recurring, true);
  eq(read([el("Recurrences")]).recurring, false, "an empty list");
  eq(read([el("Recurrences", [el("Type", "1")])]).recurring, false);
  eq(read([el("InstanceType", "2"), el("RecurrenceId", "2026-11-20T09:00:00Z")]).recurring, false, "one occurrence");
  eq(read([el("InstanceType", "0")]).recurring, false);
});

test("readMeetingRequest: the UID comes from GlobalObjId only, and an invalid one is null", () => {
  eq(read([el("GlobalObjId", UID_VALUE)]).uid, "meeting-42@example.org");
  eq(read([el("GlobalObjId", globalObjId({ data: OUTLOOK_DATA }))]).uid, hex(structure({ data: OUTLOOK_DATA })));
  for (const value of ["", "meeting-42@example.org", "AAAA", `${UID_VALUE}\n`, UID_VALUE.slice(4)]) eq(read([el("GlobalObjId", value)]).uid, null, value.slice(0, 20));
  eq(read([el("Calendar:UID", "meeting-42@example.org")]).uid, null);
  // Opaque data is read like text: the same strict decoding applies.
  eq(read([el("GlobalObjId", encodeUtf8(UID_VALUE))]).uid, "meeting-42@example.org");
  eq(read([el("GlobalObjId", Uint8Array.from([0xff, 0xfe, 0x00, 0x41]))]).uid, null);
});

test("readMeetingRequest: an oversized value is treated as absent, whatever it holds", () => {
  const pad = " ".repeat(3000);
  const r = read([
    el("StartTime", `2026-11-20T09:00:00Z${pad}`),
    el("Organizer", `ana@example.org${pad}`),
    el("AllDayEvent", `1${pad}`),
    el("InstanceType", `1${pad}`),
    el("BusyStatus", `0${pad}`),
    el("TimeZone", `${PARIS}${pad}`),
    el("GlobalObjId", `${UID_VALUE}${pad}`),
    el("Location", `Room 4${pad}`),
  ]);
  eq(r, { ...BLANK, location: "Room 4" });
});

test("readMeetingRequest: the first element of each name counts, and containers are not values", () => {
  const r = read([
    el("StartTime", "2026-11-20T09:00:00Z"), el("StartTime", "2027-01-01T00:00:00Z"),
    el("Organizer", "ana@example.org"), el("Organizer", "eve@evil.example"),
    el("Location", [el("Location", "nested")]),
    el("InstanceType", [el("InstanceType", "1")]),
  ]);
  eq([r.start, r.organizer, r.location, r.instanceType], ["2026-11-20T09:00:00Z", "ana@example.org", "", null]);
});

test("readMeetingRequest: hostile elements never throw and always give a well-formed record", () => {
  const random = prng(0x9e3779b9);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const names = [
    "AllDayEvent", "StartTime", "DtStamp", "EndTime", "InstanceType", "Location", "Organizer", "RecurrenceId", "Reminder", "ResponseRequested",
    "Recurrences", "Recurrence", "Sensitivity", "BusyStatus", "TimeZone", "GlobalObjId", "Categories",
  ].map((name) => `Email:${name}`).concat(["Email2:MeetingMessageType", "Calendar:UID"]);
  const values = [
    "", "0", "1", "2", "7", "-1", "2026-11-20T09:00:00.000Z", "20261120T090000Z", "ana@example.org", "Ana <ana@example.org>", PARIS, UID_VALUE,
    "x".repeat(3000), `a${ch(1)}b`, `${ch(0x202e)}${ch(0x200b)}\r\n`, "__proto__", "constructor", "toString", "=".repeat(64),
  ];
  const element = (depth) => {
    const name = pick(names);
    const kind = random();
    if (kind < 0.15) return el(name);
    if (kind < 0.3 && depth < 3) return el(name, Array.from({ length: Math.floor(random() * 4) }, () => element(depth + 1)));
    if (kind < 0.4) return el(name, Uint8Array.from({ length: Math.floor(random() * 40) }, () => Math.floor(random() * 256)));
    return el(name, pick(values));
  };
  const busy = new Set(["free", "tentative", "busy", "away"]);
  const sensitivity = new Set(["public", "private", "confidential"]);
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  for (let round = 0; round < 1500; round++) {
    const r = read(Array.from({ length: Math.floor(random() * 14) }, () => element(0)));
    eq(Object.keys(r), Object.keys(BLANK));
    for (const key of ["start", "end", "recurrenceId"]) assert(r[key] === null || utc.test(r[key]), key);
    for (const key of ["allDay", "responseRequested", "recurring"]) assert(typeof r[key] === "boolean", key);
    assert(r.uid === null || (r.uid.length >= 1 && r.uid.length <= MAX_UID && !/[\r\n]/.test(r.uid)), "uid");
    assert(typeof r.location === "string" && r.location.length <= 1024 && !/[\r\n\t]/.test(r.location), "location");
    assert(r.organizer === null || /^[^\s<>]+@[^\s<>]+$/.test(r.organizer), "organizer");
    assert(r.instanceType === null || (Number.isInteger(r.instanceType) && r.instanceType >= 0 && r.instanceType <= 4), "instanceType");
    assert(r.messageType === null || (Number.isInteger(r.messageType) && r.messageType >= 0 && r.messageType <= 6), "messageType");
    assert(busy.has(r.busy) && sensitivity.has(r.sensitivity), "enumerations");
    assert(r.zone === null || Number.isInteger(r.zone.bias), "zone");
  }
});
