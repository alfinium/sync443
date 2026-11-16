// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the time zone module against [MS-ASDTYPE] 2.7.6 (the TimeZone
 * structure), 2.7.2 (Compact DateTime) and 2.3 (dateTime): strict decoding
 * of hostile structures, offsets at the changes of northern and southern
 * zones, and the start of a local day around those changes.
 */

import { test, assert, eq, throws } from "./harness.mjs";
import {
  TIME_ZONE_BYTES,
  UTC_ZONE,
  MIN_YEAR,
  MAX_YEAR,
  decodeTimeZone,
  readTimeZone,
  encodeTimeZone,
  checkZone,
  offsetMinutesAt,
  localMidnightUtc,
  localDateOf,
  conversionError,
  parseDate,
  parseUtc,
  parseCompact,
  parseDateTime,
  formatDate,
  formatUtc,
  formatCompact,
  formatDateTime,
} from "../../src/core/eas-timezone.mjs";
import { ProtocolError } from "../../src/core/protocol.mjs";
import { base64 } from "../../src/core/base64.mjs";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const isBadZone = (e) => e instanceof ProtocolError && e.code === "BAD_TIMEZONE";
const isBadDate = (e) => e instanceof ProtocolError && e.code === "BAD_DATE";

// ── Building structures ───────────────────────────────────────────────────

/** SYSTEMTIME as [year, month, weekday, day, hour, minute, second, ms]. */
const NO_DATE = [0, 0, 0, 0, 0, 0, 0, 0];

function structure({ bias = 0, standardBias = 0, daylightBias = 0, standardDate = NO_DATE, daylightDate = NO_DATE, standardName = "", daylightName = "" } = {}) {
  const bytes = new Uint8Array(172);
  const int32 = (at, value) => {
    for (let k = 0; k < 4; k++) bytes[at + k] = (value >> (8 * k)) & 0xff;
  };
  const words = (at, list) => list.forEach((w, k) => {
    bytes[at + 2 * k] = w & 0xff;
    bytes[at + 2 * k + 1] = (w >> 8) & 0xff;
  });
  const name = (at, text) => words(at, [...text].slice(0, 32).map((c) => c.charCodeAt(0)));
  int32(0, bias);
  name(4, standardName);
  words(68, standardDate);
  int32(84, standardBias);
  name(88, daylightName);
  words(152, daylightDate);
  int32(168, daylightBias);
  return bytes;
}

const encoded = (fields) => base64(structure(fields));
const change = (month, week, weekday, hour, minute = 0) => ({ month, week, weekday, hour, minute });
const zone = (bias, standardChange = null, daylightChange = null, daylightBias = standardChange ? -60 : 0, standardBias = 0) => ({
  bias,
  standard: { bias: standardBias, change: standardChange },
  daylight: { bias: daylightBias, change: daylightChange },
});

// United States, Pacific: second Sunday of March 02:00 → first Sunday of November 02:00.
const PACIFIC = zone(480, change(11, 1, 0, 2), change(3, 2, 0, 2));
// Central Europe: last Sunday of March 02:00 → last Sunday of October 03:00.
const PARIS = zone(-60, change(10, 5, 0, 3), change(3, 5, 0, 2));
// Sydney: daylight time from the first Sunday of October 02:00 to the first Sunday of April 03:00.
const SYDNEY = zone(-600, change(4, 1, 0, 3), change(10, 1, 0, 2));
// Lord Howe Island: half an hour of daylight time, in the southern summer.
const LORD_HOWE = zone(-630, change(4, 1, 0, 2), change(10, 1, 0, 2), -30);
// Santiago-like: daylight time starts at local midnight (first Sunday of September) and ends at 24:00, back to 23:00.
const MIDNIGHT_CHANGES = zone(240, change(4, 1, 0, 0), change(9, 1, 0, 0));
// Havana-like: daylight time ends at 01:00, back to 00:00 (midnight comes twice).
const TWO_MIDNIGHTS = zone(300, change(11, 1, 0, 1), change(3, 2, 0, 0));
const INDIA = zone(-330);
const ZONES = [UTC_ZONE, PACIFIC, PARIS, SYDNEY, LORD_HOWE, MIDNIGHT_CHANGES, TWO_MIDNIGHTS, INDIA, zone(-840), zone(720)];

// The examples of the specifications ([MS-ASDTYPE] 3.6.6, [MS-ASCAL] 4.1 and 4.3).
const SPEC_PACIFIC = "4AEAACgARwBNAFQALQAwADgAOgAwADAAKQAgAFAAYQBjAGkAZgBpAGMAIABUAGkAbQBlACAAKABVAFMAIAAmACAAQwAAAAsAAAABAAIAAAAAAAAAAAAAACgARwBNAFQALQAwADgAOgAwADAAKQAgAFAAYQBjAGkAZgBpAGMAIABUAGkAbQBlACAAKABVAFMAIAAmACAAQwAAAAMAAAACAAIAAAAAAAAAxP///w==";
const SPEC_PACIFIC_NAMED = "4AEAAFAAYQBjAGkAZgBpAGMAIABTAHQAYQBuAGQAYQByAGQAIABUAGkAbQBlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsAAAABAAIAAAAAAAAAAAAAAFAAYQBjAGkAZgBpAGMAIABEAGEAeQBsAGkAZwBoAHQAIABUAGkAbQBlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAACAAIAAAAAAAAAxP///w==";
const SPEC_PACIFIC_2005 = "4AEAAFAAYQBjAGkAZgBpAGMAIABTAHQAYQBuAGQAYQByAGQAIABUAGkAbQBlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoAAAAFAAIAAAAAAAAAAAAAAFAAYQBjAGkAZgBpAGMAIABEAGEAeQBsAGkAZwBoAHQAIABUAGkAbQBlAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAABAAIAAAAAAAAAxP///w==";

const deepFrozen = (x) => x === null || typeof x !== "object" || (Object.isFrozen(x) && Object.values(x).every(deepFrozen));

// ── Reading a structure ───────────────────────────────────────────────────

test("eas-timezone: the structure is 172 bytes and UTC_ZONE is a frozen zone without changes", () => {
  eq(TIME_ZONE_BYTES, 172);
  eq(UTC_ZONE, { bias: 0, standard: { bias: 0, change: null }, daylight: { bias: 0, change: null } });
  assert(deepFrozen(UTC_ZONE), "UTC_ZONE is deeply frozen");
});

test("eas-timezone: the examples of the specifications decode to the Pacific rules", () => {
  eq(decodeTimeZone(SPEC_PACIFIC), PACIFIC, "[MS-ASDTYPE] 3.6.6");
  eq(decodeTimeZone(SPEC_PACIFIC_NAMED), PACIFIC, "[MS-ASCAL] 4.1, other names");
  // The rules in force until 2006: first Sunday of April, last Sunday of October.
  eq(decodeTimeZone(SPEC_PACIFIC_2005), zone(480, change(10, 5, 0, 2), change(4, 1, 0, 2)), "[MS-ASCAL] 4.3");
  assert(deepFrozen(decodeTimeZone(SPEC_PACIFIC)), "a decoded zone is deeply frozen");
});

test("eas-timezone: names are ignored, whatever they contain", () => {
  const plain = decodeTimeZone(encoded({ bias: -60, standardDate: [0, 10, 0, 5, 3, 0, 0, 0], daylightDate: [0, 3, 0, 5, 2, 0, 0, 0], daylightBias: -60 }));
  const hostile = String.fromCharCode(0x202e, 0x2f, 0x2e, 0x2e, 0x2f, 0, 0xd800, 0xffff).repeat(4);
  const named = decodeTimeZone(encoded({
    bias: -60, standardDate: [0, 10, 0, 5, 3, 0, 0, 0], daylightDate: [0, 3, 0, 5, 2, 0, 0, 0], daylightBias: -60, standardName: hostile, daylightName: "Europe/Paris",
  }));
  eq(named, plain);
  eq(named, PARIS);
  eq(Object.keys(named), ["bias", "standard", "daylight"], "no name in the zone");
});

test("eas-timezone: a zone without changes is its Bias; the two other biases are ignored", () => {
  eq(decodeTimeZone(encoded({ bias: -330 })), INDIA);
  // Windows leaves a daylight bias of -60 in zones that never use it, even at UTC+14 (Line Islands).
  eq(decodeTimeZone(encoded({ bias: -840, daylightBias: -60 })), zone(-840));
  eq(offsetMinutesAt(decodeTimeZone(encoded({ bias: -840, daylightBias: -60 })), Date.UTC(2026, 6, 1)), 840);
  // StandardBias is "ignored if a value for the StandardDate member is not supplied".
  eq(decodeTimeZone(encoded({ bias: 480, standardBias: 30, daylightBias: -30 })), zone(480));
  eq(decodeTimeZone(encoded({ bias: 800, standardBias: 100 })), zone(800));
  // Ignored, but not anything: every field stays in its range.
  throws(() => decodeTimeZone(encoded({ bias: 480, standardBias: 841 })), isBadZone);
  throws(() => decodeTimeZone(encoded({ bias: 480, daylightBias: -841 })), isBadZone);
  // When no month is given, the rest of a date means nothing.
  eq(decodeTimeZone(encoded({ bias: 60, standardDate: [2020, 0, 9, 40, 99, 99, 99, 9999], daylightDate: [0, 0, 6, 5, 23, 59, 59, 999] })), zone(60));
});

test("eas-timezone: seconds and milliseconds of a change are checked, then dropped", () => {
  const z = decodeTimeZone(encoded({ bias: 180, standardDate: [0, 2, 6, 3, 23, 59, 59, 999], daylightDate: [0, 10, 6, 3, 23, 59, 59, 999], daylightBias: -60 }));
  eq(z, zone(180, change(2, 3, 6, 23, 59), change(10, 3, 6, 23, 59)));
});

test("eas-timezone: a change given as the date of one year is reduced to the standard offset", () => {
  const once = [2007, 11, 0, 4, 2, 0, 0, 0];
  const onceToo = [2007, 3, 0, 11, 2, 0, 0, 0];
  const yearly = [0, 3, 0, 2, 2, 0, 0, 0];
  eq(decodeTimeZone(encoded({ bias: 480, standardDate: once, daylightDate: onceToo, daylightBias: -60 })), zone(480), "both");
  eq(decodeTimeZone(encoded({ bias: 480, standardDate: once, daylightDate: yearly, daylightBias: -60 })), zone(480), "standard only");
  eq(decodeTimeZone(encoded({ bias: 480, standardDate: [0, 11, 0, 1, 2, 0, 0, 0], daylightDate: onceToo, daylightBias: -60 })), zone(480), "daylight only");
  eq(decodeTimeZone(encoded({ bias: 480, standardBias: 30, standardDate: once, daylightDate: onceToo, daylightBias: -60 })), zone(510), "the standard bias counts: the dates were given");
  throws(() => decodeTimeZone(encoded({ bias: 830, standardBias: 30, standardDate: once, daylightDate: onceToo })), isBadZone, "a standard offset of more than 14 hours");
  // The date itself is still checked.
  for (const date of [[2007, 4, 0, 31, 2, 0, 0, 0], [2007, 2, 0, 29, 2, 0, 0, 0], [1600, 3, 0, 1, 2, 0, 0, 0], [30828, 3, 0, 1, 2, 0, 0, 0], [2007, 3, 0, 0, 2, 0, 0, 0], [2007, 3, 7, 1, 2, 0, 0, 0], [2007, 3, 0, 1, 24, 0, 0, 0]]) {
    throws(() => decodeTimeZone(encoded({ bias: 480, standardDate: once, daylightDate: date, daylightBias: -60 })), isBadZone, JSON.stringify(date));
  }
  eq(decodeTimeZone(encoded({ bias: 480, standardDate: once, daylightDate: [2008, 2, 5, 29, 2, 0, 0, 0], daylightBias: -60 })), zone(480), "29 February of a leap year");
});

test("eas-timezone: readTimeZone says when a dated change was dropped, and only then", () => {
  const once = [2007, 11, 0, 4, 2, 0, 0, 0];
  const yearly = [0, 3, 0, 2, 2, 0, 0, 0];
  eq(readTimeZone(SPEC_PACIFIC), { zone: PACIFIC, reduced: false });
  eq(readTimeZone(encoded({ bias: 480, standardDate: once, daylightDate: [2007, 3, 0, 11, 2, 0, 0, 0], daylightBias: -60 })), { zone: zone(480), reduced: true });
  eq(readTimeZone(encoded({ bias: 480, standardDate: once, daylightDate: yearly, daylightBias: -60 })), { zone: zone(480), reduced: true });
  // What a Zone never keeps is not a loss: names, seconds, the biases of a zone without changes.
  eq(readTimeZone(encoded({ bias: -840, daylightBias: -60, standardName: "Line Islands Standard Time" })), { zone: zone(-840), reduced: false });
  eq(readTimeZone(encoded({ bias: 180, standardDate: [0, 2, 6, 3, 23, 59, 59, 999], daylightDate: [0, 10, 6, 3, 23, 59, 59, 999], daylightBias: -60 })).reduced, false);
  eq(readTimeZone(encodeTimeZone(UTC_ZONE)), { zone: UTC_ZONE, reduced: false });
  for (const bad of [null, "", "AAAA", encoded({ bias: 900 }), encoded({ standardDate: yearly })]) throws(() => readTimeZone(bad), isBadZone, String(bad).slice(0, 12));
});

test("eas-timezone: wrong lengths and wrong encodings are refused", () => {
  const good = encoded({ bias: 480 });
  eq(good.length, 232);
  for (const size of [0, 1, 4, 100, 170, 171, 173, 174, 344, 1000]) {
    throws(() => decodeTimeZone(base64(new Uint8Array(size))), isBadZone, `${size} bytes`);
  }
  for (const value of [undefined, null, 172, {}, [], new Uint8Array(172), structure(), true]) {
    throws(() => decodeTimeZone(value), isBadZone, `not a text: ${typeof value}`);
  }
  throws(() => decodeTimeZone(""), isBadZone, "empty");
  throws(() => decodeTimeZone(good.slice(0, 231)), isBadZone, "one character short");
  throws(() => decodeTimeZone(`${good}A`), isBadZone, "one character more");
  throws(() => decodeTimeZone(good.slice(0, 230)), isBadZone, "no padding");
  throws(() => decodeTimeZone(`${good.slice(0, 230)}=A`), isBadZone, "padding in the wrong place");
  throws(() => decodeTimeZone(`${good.slice(0, 229)}===`), isBadZone, "three padding characters");
  throws(() => decodeTimeZone(`=${good.slice(1)}`), isBadZone, "padding at the start");
  for (const intruder of ["-", "_", "*", "%", "é", String.fromCharCode(0), String.fromCharCode(0x202e), String.fromCharCode(0xff21)]) {
    throws(() => decodeTimeZone(good.slice(0, 50) + intruder + good.slice(51)), isBadZone, `character ${intruder.charCodeAt(0)}`);
  }
  // Bits that belong to no byte: "AB==" and "AA==" would be the same last byte.
  eq(good.slice(228), "AA==");
  throws(() => decodeTimeZone(`${good.slice(0, 228)}AB==`), isBadZone, "non-canonical ending");
  throws(() => decodeTimeZone(`${good.slice(0, 228)}AP==`), isBadZone, "non-canonical ending");
  throws(() => decodeTimeZone("A".repeat(100_000)), isBadZone, "very long text");
  throws(() => decodeTimeZone(`${" ".repeat(300)}${good}`), isBadZone, "more blanks than text");
});

test("eas-timezone: line breaks an encoder added are skipped, nothing else", () => {
  const good = encoded({ bias: 480, standardDate: [0, 11, 0, 1, 2, 0, 0, 0], daylightDate: [0, 3, 0, 2, 2, 0, 0, 0], daylightBias: -60 });
  const wrapped = good.match(/.{1,76}/g).join("\r\n");
  eq(decodeTimeZone(wrapped), PACIFIC);
  eq(decodeTimeZone(`${good.slice(0, 100)} \t\n${good.slice(100)}`), PACIFIC);
  throws(() => decodeTimeZone(`${good.slice(0, 100)}${String.fromCharCode(0x0b)}${good.slice(100)}`), isBadZone, "vertical tab");
  throws(() => decodeTimeZone(`${good.slice(0, 100)}${String.fromCharCode(0xa0)}${good.slice(100)}`), isBadZone, "no-break space");
});

test("eas-timezone: every field must be in its range", () => {
  const std = [0, 10, 0, 5, 3, 0, 0, 0];
  const dst = [0, 3, 0, 5, 2, 0, 0, 0];
  const ok = { bias: -60, standardDate: std, daylightDate: dst, daylightBias: -60 };
  eq(decodeTimeZone(encoded(ok)), PARIS);
  const refused = (fields, what) => throws(() => decodeTimeZone(encoded({ ...ok, ...fields })), isBadZone, what);
  for (const bias of [841, -841, 1440, 0x7fffffff, -0x80000000, 65536 + 60]) {
    refused({ bias }, `bias ${bias}`);
    refused({ standardBias: bias }, `standard bias ${bias}`);
    refused({ daylightBias: bias }, `daylight bias ${bias}`);
  }
  eq(decodeTimeZone(encoded({ bias: 840 })).bias, 840);
  eq(decodeTimeZone(encoded({ bias: -840 })).bias, -840);
  const with_ = (index, value) => std.map((x, i) => (i === index ? value : x));
  refused({ standardDate: with_(1, 13) }, "month 13");
  refused({ standardDate: with_(1, 0xffff) }, "month 65535");
  refused({ standardDate: with_(2, 7) }, "weekday 7");
  refused({ standardDate: with_(3, 0) }, "week 0");
  refused({ standardDate: with_(3, 6) }, "week 6");
  refused({ standardDate: with_(4, 24) }, "hour 24");
  refused({ standardDate: with_(5, 60) }, "minute 60");
  refused({ standardDate: with_(6, 60) }, "second 60");
  refused({ standardDate: with_(7, 1000) }, "millisecond 1000");
  refused({ daylightDate: dst.map((x, i) => (i === 3 ? 6 : x)) }, "daylight week 6");
  // The high byte of a WORD counts: 0x0103 is not March.
  refused({ daylightDate: dst.map((x, i) => (i === 1 ? 0x0103 : x)) }, "month 259");
});

test("eas-timezone: both changes or none, and offsets within 14 hours", () => {
  const std = [0, 10, 0, 5, 3, 0, 0, 0];
  const dst = [0, 3, 0, 5, 2, 0, 0, 0];
  throws(() => decodeTimeZone(encoded({ standardDate: std })), isBadZone, "standard change alone");
  throws(() => decodeTimeZone(encoded({ daylightDate: dst })), isBadZone, "daylight change alone");
  throws(() => decodeTimeZone(encoded({ standardDate: [2020, 10, 0, 5, 3, 0, 0, 0] })), isBadZone, "one dated change alone");
  throws(() => decodeTimeZone(encoded({ bias: 800, standardBias: 100, standardDate: std, daylightDate: dst, daylightBias: 0 })), isBadZone, "standard offset of 15 hours");
  throws(() => decodeTimeZone(encoded({ bias: -800, standardDate: std, daylightDate: dst, daylightBias: -100 })), isBadZone, "daylight offset of 15 hours");
  eq(offsetMinutesAt(decodeTimeZone(encoded({ bias: -780, standardDate: std, daylightDate: dst, daylightBias: -60 })), Date.UTC(2026, 6, 1)), 840, "UTC+14 in summer");
});

// ── Writing a structure ───────────────────────────────────────────────────

test("eas-timezone: encodeTimeZone writes exactly 172 bytes, names empty, fields at their place", () => {
  eq(encodeTimeZone(UTC_ZONE), base64(new Uint8Array(172)), "UTC is 172 zero bytes");
  eq(encodeTimeZone(PACIFIC), encoded({ bias: 480, standardDate: [0, 11, 0, 1, 2, 0, 0, 0], daylightDate: [0, 3, 0, 2, 2, 0, 0, 0], daylightBias: -60 }));
  eq(encodeTimeZone(LORD_HOWE), encoded({ bias: -630, standardDate: [0, 4, 0, 1, 2, 0, 0, 0], daylightDate: [0, 10, 0, 1, 2, 0, 0, 0], daylightBias: -30 }));
  // Without changes only Bias is written: a reader ignores the two other biases.
  eq(encodeTimeZone(zone(-840, null, null, -60, 0)), encoded({ bias: -840 }));
  eq(encodeTimeZone(zone(480, null, null, 0, 30)), encoded({ bias: 510 }));
  for (const z of ZONES) {
    const text = encodeTimeZone(z);
    eq(text.length, 232, "232 characters");
    assert(/^[A-Za-z0-9+/]{230}==$/.test(text), "canonical base64");
    eq(decodeTimeZone(text), z, "decode(encode(zone))");
    eq(encodeTimeZone(decodeTimeZone(text)), text, "encode(decode(text))");
  }
});

test("eas-timezone: encodeTimeZone refuses what is not a valid zone", () => {
  for (const bad of [null, undefined, "UTC", 0, [], {}, { bias: 0 }, zone(841), zone(0, change(10, 5, 0, 3), null), zone(0, change(13, 5, 0, 3), change(3, 5, 0, 2))]) {
    throws(() => encodeTimeZone(bad), isBadZone, JSON.stringify(bad));
  }
});

// ── checkZone ─────────────────────────────────────────────────────────────

test("eas-timezone: checkZone returns a clean frozen copy", () => {
  const input = JSON.parse(JSON.stringify(PARIS));
  input.name = "Europe/Paris";
  input.standard.name = "CET";
  input.standard.change.second = 30;
  const checked = checkZone(input);
  eq(checked, PARIS, "unknown properties are left out");
  assert(checked !== input && deepFrozen(checked), "a frozen copy");
  assert(!Object.isFrozen(input) && input.name === "Europe/Paris", "the input is untouched");
  assert(checkZone(checked) === checked, "a checked zone is returned as it is");
  assert(checkZone(UTC_ZONE) === UTC_ZONE);
  const negativeZero = checkZone({ bias: -0, standard: { bias: -0, change: null }, daylight: { bias: -0, change: null } });
  assert(Object.is(negativeZero.bias, 0) && Object.is(negativeZero.standard.bias, 0) && Object.is(negativeZero.daylight.bias, 0), "never -0");
  assert(Object.is(offsetMinutesAt(negativeZero, Date.UTC(2026, 0, 1)), 0), "offset never -0");
  // A zone without changes is one offset, whatever the fields it was spread over.
  eq(checkZone(zone(480, null, null, -60, 30)), zone(510));
  eq(checkZone(zone(-840, null, null, -60, 0)), zone(-840));
  throws(() => checkZone(zone(800, null, null, 0, 100)), isBadZone, "an offset of 15 hours");
});

test("eas-timezone: checkZone refuses every field out of its range or of the wrong type", () => {
  const variants = [];
  const base = () => JSON.parse(JSON.stringify(PARIS));
  const set = (path, value) => {
    const z = base();
    let at = z;
    for (const key of path.slice(0, -1)) at = at[key];
    at[path[path.length - 1]] = value;
    variants.push([`${path.join(".")} = ${JSON.stringify(value) ?? String(value)}`, z]);
  };
  for (const bad of [841, -841, 1.5, NaN, Infinity, "60", null, undefined, true, [], {}, 2 ** 31]) {
    set(["bias"], bad);
    set(["standard", "bias"], bad);
    set(["daylight", "bias"], bad);
  }
  for (const [field, values] of [["month", [0, 13, 1.5, "3", null]], ["week", [0, 6, -1, "1", null]], ["weekday", [-1, 7, 0.5, "0", null]], ["hour", [-1, 24, "2", null]], ["minute", [-1, 60, "0", null, undefined]]]) {
    for (const bad of values) {
      set(["standard", "change", field], bad);
      set(["daylight", "change", field], bad);
    }
  }
  set(["standard", "change"], null); // one change only
  set(["daylight", "change"], null);
  set(["standard", "change"], undefined);
  set(["standard", "change"], "none");
  set(["standard", "change"], [10, 5, 0, 3, 0]);
  set(["standard"], null);
  set(["daylight"], undefined);
  set(["daylight"], []);
  set(["bias"], -800); // with the daylight bias, an offset of more than 14 hours
  for (const [what, z] of variants) throws(() => checkZone(z), isBadZone, what);
  for (const bad of [null, undefined, 0, "zone", [], [PARIS], () => PARIS]) throws(() => checkZone(bad), isBadZone, String(bad));
});

test("eas-timezone: checkZone reads own properties only, and hostile names change nothing", () => {
  // Properties inherited from a prototype are not the zone's.
  throws(() => checkZone(Object.create(PARIS)), isBadZone, "inherited zone");
  const inheritedChange = { bias: 0, standard: { bias: 0, change: Object.create({ month: 10, week: 5, weekday: 0, hour: 3, minute: 0 }) }, daylight: { bias: -60, change: { month: 3, week: 5, weekday: 0, hour: 2, minute: 0 } } };
  throws(() => checkZone(inheritedChange), isBadZone, "inherited change");
  const hostile = JSON.parse('{"__proto__":{"bias":0,"polluted":true},"constructor":{"prototype":{"polluted":true}},"bias":-60,"standard":{"__proto__":{"bias":500},"bias":0,"change":null},"daylight":{"bias":0,"change":null,"toString":"x"}}');
  const checked = checkZone(hostile);
  eq(checked, zone(-60));
  eq(Object.getPrototypeOf(checked), Object.prototype);
  eq({}.polluted, undefined, "Object.prototype is untouched");
  throws(() => checkZone(JSON.parse('{"__proto__":{"bias":0,"standard":{"bias":0,"change":null},"daylight":{"bias":0,"change":null}}}')), isBadZone, "a zone hidden in __proto__");
});

// ── Offsets ───────────────────────────────────────────────────────────────

test("eas-timezone: offsets around the changes of a northern zone", () => {
  // Pacific 2026: daylight time from 8 March 10:00 UTC to 1 November 09:00 UTC.
  const start = Date.UTC(2026, 2, 8, 10);
  const end = Date.UTC(2026, 10, 1, 9);
  eq(offsetMinutesAt(PACIFIC, start - 1), -480);
  eq(offsetMinutesAt(PACIFIC, start), -420);
  eq(offsetMinutesAt(PACIFIC, end - 1), -420);
  eq(offsetMinutesAt(PACIFIC, end), -480);
  eq(offsetMinutesAt(PACIFIC, Date.UTC(2026, 0, 1)), -480, "1 January");
  eq(offsetMinutesAt(PACIFIC, Date.UTC(2026, 11, 31, 23, 59, 59)), -480, "31 December");
  // Paris: last Sunday of March and of October, at 01:00 UTC both.
  for (const [year, march, october] of [[2024, 31, 27], [2025, 30, 26], [2026, 29, 25], [2027, 28, 31], [2030, 31, 27], [1999, 28, 31], [2100, 28, 31]]) {
    const spring = Date.UTC(year, 2, march, 1);
    const autumn = Date.UTC(year, 9, october, 1);
    eq(offsetMinutesAt(PARIS, spring - 1), 60, `${year} before spring`);
    eq(offsetMinutesAt(PARIS, spring), 120, `${year} spring`);
    eq(offsetMinutesAt(PARIS, autumn - 1), 120, `${year} before autumn`);
    eq(offsetMinutesAt(PARIS, autumn), 60, `${year} autumn`);
  }
});

test("eas-timezone: offsets of southern zones, where daylight time spans the new year", () => {
  // Sydney 2026: daylight time ends 4 April 16:00 UTC, starts again 3 October 16:00 UTC.
  const end = Date.UTC(2026, 3, 4, 16);
  const start = Date.UTC(2026, 9, 3, 16);
  eq(offsetMinutesAt(SYDNEY, Date.UTC(2026, 0, 1)), 660, "1 January: summer");
  eq(offsetMinutesAt(SYDNEY, Date.UTC(2025, 11, 31, 23, 59, 59)), 660, "31 December: summer");
  eq(offsetMinutesAt(SYDNEY, end - 1), 660);
  eq(offsetMinutesAt(SYDNEY, end), 600);
  eq(offsetMinutesAt(SYDNEY, Date.UTC(2026, 5, 21)), 600, "June: winter");
  eq(offsetMinutesAt(SYDNEY, start - 1), 600);
  eq(offsetMinutesAt(SYDNEY, start), 660);
  eq(offsetMinutesAt(SYDNEY, Date.UTC(2026, 11, 25)), 660, "December: summer");
  // Lord Howe: 10:30 in winter, 11:00 in summer.
  eq(offsetMinutesAt(LORD_HOWE, Date.UTC(2026, 0, 15)), 660);
  eq(offsetMinutesAt(LORD_HOWE, Date.UTC(2026, 6, 15)), 630);
  eq(offsetMinutesAt(LORD_HOWE, Date.UTC(2026, 9, 3, 15, 29, 59)), 630, "just before 02:00 local");
  eq(offsetMinutesAt(LORD_HOWE, Date.UTC(2026, 9, 3, 15, 30)), 660, "02:00 local, first Sunday of October");
});

test("eas-timezone: offsets of zones without changes, and of every decoded form", () => {
  for (const [z, minutes] of [[UTC_ZONE, 0], [INDIA, 330], [zone(-840), 840], [zone(720), -720], [zone(480, null, null, 0, 30), -510]]) {
    for (const at of [Date.UTC(1900, 0, 1), Date.UTC(1970, 0, 1), Date.UTC(2026, 6, 4, 12), Date.UTC(2200, 11, 31, 23, 59, 59)]) {
      eq(offsetMinutesAt(z, at), minutes);
    }
  }
  eq(offsetMinutesAt(decodeTimeZone(SPEC_PACIFIC), Date.UTC(2026, 6, 4)), -420);
  // A plain description (as it comes back from Thunderbird's side) is checked, then used.
  eq(offsetMinutesAt(JSON.parse(JSON.stringify(SYDNEY)), Date.UTC(2026, 0, 1)), 660);
});

test("eas-timezone: two changes at the same instant leave standard time", () => {
  // Both rules on the same day and hour: daylight time never lasts.
  const stuck = zone(0, change(3, 5, 0, 3), change(3, 5, 0, 2));
  for (let month = 0; month < 12; month++) eq(offsetMinutesAt(stuck, Date.UTC(2026, month, 15)), 0, `month ${month + 1}`);
  eq(offsetMinutesAt(stuck, Date.UTC(2026, 2, 29, 2)), 0, "at the change itself");
});

test("eas-timezone: offsetMinutesAt refuses what is not an instant or not a zone", () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, "2026-01-01", new Date(), Date.UTC(1800, 0, 1), Date.UTC(2300, 0, 1), 8.64e15, -8.64e15, Number.MAX_VALUE]) {
    throws(() => offsetMinutesAt(PARIS, bad), isBadDate, String(bad));
    throws(() => offsetMinutesAt(UTC_ZONE, bad), isBadDate, `UTC ${String(bad)}`);
    throws(() => localDateOf(PARIS, bad), isBadDate, `localDateOf ${String(bad)}`);
  }
  for (const bad of [null, undefined, "Europe/Paris", {}, zone(900)]) {
    throws(() => offsetMinutesAt(bad, Date.UTC(2026, 0, 1)), isBadZone, JSON.stringify(bad));
    throws(() => localDateOf(bad, Date.UTC(2026, 0, 1)), isBadZone);
    throws(() => localMidnightUtc(bad, "2026-01-01"), isBadZone);
  }
});

// ── Local days ────────────────────────────────────────────────────────────

test("eas-timezone: local midnight and local day, in ordinary cases", () => {
  eq(localMidnightUtc(UTC_ZONE, "2026-03-10"), Date.UTC(2026, 2, 10));
  eq(localMidnightUtc(PACIFIC, "2026-01-15"), Date.UTC(2026, 0, 15, 8));
  eq(localMidnightUtc(PACIFIC, "2026-07-15"), Date.UTC(2026, 6, 15, 7));
  eq(localMidnightUtc(INDIA, "2026-07-15"), Date.UTC(2026, 6, 14, 18, 30));
  eq(localMidnightUtc(SYDNEY, "2026-01-15"), Date.UTC(2026, 0, 14, 13));
  eq(localMidnightUtc(SYDNEY, "2026-07-15"), Date.UTC(2026, 6, 14, 14));
  eq(localDateOf(UTC_ZONE, Date.UTC(2026, 2, 10, 23, 59, 59)), "2026-03-10");
  eq(localDateOf(PACIFIC, Date.UTC(2026, 0, 15, 7, 59, 59)), "2026-01-14");
  eq(localDateOf(PACIFIC, Date.UTC(2026, 0, 15, 8)), "2026-01-15");
  eq(localDateOf(SYDNEY, Date.UTC(2026, 0, 14, 13)), "2026-01-15");
  eq(localDateOf(zone(-840), Date.UTC(2026, 0, 14, 10)), "2026-01-15", "UTC+14");
  eq(localDateOf(zone(720), Date.UTC(2026, 0, 15, 11, 59)), "2026-01-14", "UTC-12");
});

test("eas-timezone: days of 23 and 25 hours around the changes", () => {
  // Pacific, 8 March 2026: the day starts in winter time and ends in summer time.
  eq(localMidnightUtc(PACIFIC, "2026-03-08"), Date.UTC(2026, 2, 8, 8));
  eq(localMidnightUtc(PACIFIC, "2026-03-09"), Date.UTC(2026, 2, 9, 7));
  eq(localMidnightUtc(PACIFIC, "2026-03-09") - localMidnightUtc(PACIFIC, "2026-03-08"), 23 * HOUR);
  eq(localMidnightUtc(PACIFIC, "2026-11-02") - localMidnightUtc(PACIFIC, "2026-11-01"), 25 * HOUR);
  // Sydney: 25 hours on 5 April 2026, 23 hours on 4 October 2026.
  eq(localMidnightUtc(SYDNEY, "2026-04-06") - localMidnightUtc(SYDNEY, "2026-04-05"), 25 * HOUR);
  eq(localMidnightUtc(SYDNEY, "2026-10-05") - localMidnightUtc(SYDNEY, "2026-10-04"), 23 * HOUR);
  // Lord Howe: half an hour more or less.
  eq(localMidnightUtc(LORD_HOWE, "2026-04-06") - localMidnightUtc(LORD_HOWE, "2026-04-05"), 24.5 * HOUR);
  eq(localMidnightUtc(LORD_HOWE, "2026-10-05") - localMidnightUtc(LORD_HOWE, "2026-10-04"), 23.5 * HOUR);
});

test("eas-timezone: a midnight that does not exist is the instant of the change", () => {
  // Daylight time starts at 00:00 on Sunday 6 September 2026: the clock goes from 23:59:59 to 01:00.
  const jump = Date.UTC(2026, 8, 6, 4);
  eq(offsetMinutesAt(MIDNIGHT_CHANGES, jump - 1), -240);
  eq(offsetMinutesAt(MIDNIGHT_CHANGES, jump), -180);
  eq(localMidnightUtc(MIDNIGHT_CHANGES, "2026-09-06"), jump, "the day starts at 01:00 local");
  eq(localDateOf(MIDNIGHT_CHANGES, jump), "2026-09-06");
  eq(localDateOf(MIDNIGHT_CHANGES, jump - 1), "2026-09-05");
  eq(localMidnightUtc(MIDNIGHT_CHANGES, "2026-09-07") - jump, 23 * HOUR);
  // A change that jumps over midnight from 23:30 to 00:30.
  const over = zone(0, change(10, 5, 0, 3), change(3, 5, 6, 23, 30));
  const at = Date.UTC(2026, 2, 28, 23, 30);
  eq(localMidnightUtc(over, "2026-03-29"), at, "the day starts at 00:30 local");
  eq(localDateOf(over, at), "2026-03-29");
  eq(localDateOf(over, at - 1), "2026-03-28");
});

test("eas-timezone: a midnight that comes twice", () => {
  // Standard time comes back at 24:00 on Saturday (00:00 Sunday 5 April 2026), back to 23:00:
  // the Sunday starts an hour later, at its only midnight.
  const back = Date.UTC(2026, 3, 5, 3);
  eq(offsetMinutesAt(MIDNIGHT_CHANGES, back - 1), -180);
  eq(offsetMinutesAt(MIDNIGHT_CHANGES, back), -240);
  eq(localDateOf(MIDNIGHT_CHANGES, back), "2026-04-04", "23:00 again, still Saturday");
  eq(localMidnightUtc(MIDNIGHT_CHANGES, "2026-04-05"), back + HOUR);
  eq(localMidnightUtc(MIDNIGHT_CHANGES, "2026-04-04"), Date.UTC(2026, 3, 4, 3));
  // Back from 01:00 to 00:00 on Sunday 1 November 2026: two midnights that day, the first one starts it.
  const first = Date.UTC(2026, 10, 1, 4);
  eq(localMidnightUtc(TWO_MIDNIGHTS, "2026-11-01"), first);
  eq(offsetMinutesAt(TWO_MIDNIGHTS, first), -240, "the first midnight is in daylight time");
  eq(offsetMinutesAt(TWO_MIDNIGHTS, first + HOUR), -300, "the second one in standard time");
  eq(localDateOf(TWO_MIDNIGHTS, first + HOUR), "2026-11-01");
  eq(localMidnightUtc(TWO_MIDNIGHTS, "2026-11-02") - first, 25 * HOUR);
});

test("eas-timezone: every day of four years, in every zone, starts where the previous one ends", () => {
  for (const z of ZONES) {
    let previous = null;
    for (let day = Date.UTC(2025, 11, 31); day <= Date.UTC(2029, 0, 1); day += DAY) {
      const date = formatDate(day);
      const midnight = localMidnightUtc(z, date);
      eq(localDateOf(z, midnight), date, `first instant of ${date}`);
      eq(localDateOf(z, midnight - 1), formatDate(day - DAY), `instant before ${date}`);
      eq(localDateOf(z, midnight + 12 * HOUR), date, `noon of ${date}`);
      if (previous !== null) {
        const length = midnight - previous;
        assert(length >= 23 * HOUR && length <= 25 * HOUR, `${date}: a day of ${length / HOUR} hours`);
      }
      previous = midnight;
    }
  }
});

test("eas-timezone: localMidnightUtc takes exactly a DATE", () => {
  for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-1-5", "20260105", "2026-01-05T00:00:00Z", " 2026-01-05", "2026-01-05\n", "1899-12-31", "2201-01-01", "", null, undefined, 20260105, new Date()]) {
    throws(() => localMidnightUtc(PARIS, bad), isBadDate, String(bad));
    throws(() => localMidnightUtc(UTC_ZONE, bad), isBadDate, `UTC ${String(bad)}`);
  }
  eq(localMidnightUtc(PARIS, "2028-02-29"), Date.UTC(2028, 1, 28, 23), "29 February of a leap year");
  eq(localMidnightUtc(zone(-840), "1900-01-01"), Date.UTC(1899, 11, 31, 10), "the first day, east of Greenwich");
  eq(localMidnightUtc(zone(720), "2200-12-31"), Date.UTC(2200, 11, 31, 12), "the last day, west of Greenwich");
});

test("eas-timezone: localDateOf never gives a day outside 1900-2200", () => {
  eq(localDateOf(UTC_ZONE, Date.UTC(1900, 0, 1)), "1900-01-01");
  eq(localDateOf(UTC_ZONE, Date.UTC(2200, 11, 31, 23, 59, 59)), "2200-12-31");
  throws(() => localDateOf(PACIFIC, Date.UTC(1900, 0, 1)), isBadDate, "31 December 1899 in Pacific time");
  throws(() => localDateOf(SYDNEY, Date.UTC(2200, 11, 31, 20)), isBadDate, "1 January 2201 in Sydney");
  throws(() => localDateOf(UTC_ZONE, Date.UTC(1899, 11, 31, 23, 59, 59)), isBadDate);
});

// ── Dates ─────────────────────────────────────────────────────────────────

test("eas-timezone: parsers take exactly their grammar", () => {
  eq(parseDate("2026-03-10"), Date.UTC(2026, 2, 10));
  eq(parseUtc("2026-03-10T17:05:09Z"), Date.UTC(2026, 2, 10, 17, 5, 9));
  eq(parseCompact("20260310T170509Z"), Date.UTC(2026, 2, 10, 17, 5, 9));
  eq(parseDateTime("2026-03-10T17:05:09.000Z"), Date.UTC(2026, 2, 10, 17, 5, 9));
  eq(parseDateTime("2026-03-10T17:05:09.999Z"), Date.UTC(2026, 2, 10, 17, 5, 9), "milliseconds dropped");
  eq(parseDateTime("2026-03-10T17:05:09Z"), Date.UTC(2026, 2, 10, 17, 5, 9), "milliseconds optional");
  eq(parseCompact("20130722T090000Z"), Date.UTC(2013, 6, 22, 9), "[MS-ASDTYPE] 3.6.2");
  const fullWidthTwo = String.fromCharCode(0xff12);
  const arabicTwo = String.fromCharCode(0x0662);
  const wrong = {
    date: ["2026-3-10", "2026-03-1", "26-03-10", "02026-03-10", "2026/03/10", "2026-03-10 ", " 2026-03-10", "2026-03-10\n", "2026-03-10T00:00:00Z", "20260310", `${fullWidthTwo}026-03-10`, `${arabicTwo}026-03-10`, "+026-03-10", "-026-03-10", "2026-03-1e"],
    utc: ["2026-03-10T17:05:09", "2026-03-10T17:05:09z", "2026-03-10t17:05:09Z", "2026-03-10 17:05:09Z", "2026-03-10T17:05Z", "2026-03-10T17:05:09.000Z", "2026-03-10T17:05:09+00:00", "2026-03-10T17:05:09Z ", "2026-03-10", "20260310T170509Z"],
    compact: ["20260310T170509", "20260310T170509z", "20260310t170509Z", "20260310170509Z", "2026-03-10T17:05:09Z", "20260310T1705Z", "20260310T170509ZZ", "20260310T170509Z ", " 20260310T170509Z", "20260310T170509.000Z", "20260310T17:05:09Z", `${fullWidthTwo}0260310T170509Z`, "20260310T170509Z\n", "0260310T170509Z"],
    dateTime: ["2026-03-10T17:05:09.0Z", "2026-03-10T17:05:09.00Z", "2026-03-10T17:05:09.0000Z", "2026-03-10T17:05:09.Z", "2026-03-10T17:05:09,000Z", "2026-03-10T17:05:09.000", "2026-03-10T17:05:09.000z", "20260310T170509Z", "2026-03-10", "2026-03-10T17:05:09.000+01:00"],
  };
  for (const text of wrong.date) eq(parseDate(text), null, JSON.stringify(text));
  for (const text of wrong.utc) eq(parseUtc(text), null, JSON.stringify(text));
  for (const text of wrong.compact) eq(parseCompact(text), null, JSON.stringify(text));
  for (const text of wrong.dateTime) eq(parseDateTime(text), null, JSON.stringify(text));
  for (const parse of [parseDate, parseUtc, parseCompact, parseDateTime]) {
    for (const bad of [null, undefined, 20260310, {}, [], ["2026-03-10"], new Date(), "", "x".repeat(100_000)]) eq(parse(bad), null, String(bad).slice(0, 20));
  }
});

test("eas-timezone: only real days and times, in years 1900 to 2200", () => {
  eq(MIN_YEAR, 1900);
  eq(MAX_YEAR, 2200);
  eq(parseDate("1900-01-01"), Date.UTC(1900, 0, 1));
  eq(parseDate("2200-12-31"), Date.UTC(2200, 11, 31));
  eq(parseUtc("2200-12-31T23:59:59Z"), Date.UTC(2200, 11, 31, 23, 59, 59));
  eq(parseDate("2028-02-29"), Date.UTC(2028, 1, 29), "leap year");
  eq(parseDate("2000-02-29"), Date.UTC(2000, 1, 29), "2000 is a leap year");
  for (const text of ["1899-12-31", "2201-01-01", "0000-01-01", "9999-12-31", "0099-01-01", "2026-02-29", "2100-02-29", "1900-02-29", "2026-02-30", "2026-04-31", "2026-06-31", "2026-00-10", "2026-13-10", "2026-01-00", "2026-01-32", "2026-99-99"]) {
    eq(parseDate(text), null, text);
    eq(parseUtc(`${text}T12:00:00Z`), null, `${text} as UTC`);
    eq(parseCompact(`${text.replace(/-/g, "")}T120000Z`), null, `${text} as compact`);
    eq(parseDateTime(`${text}T12:00:00.000Z`), null, `${text} as dateTime`);
  }
  for (const time of ["24:00:00", "23:60:00", "23:59:60", "99:99:99", "25:00:00"]) {
    eq(parseUtc(`2026-03-10T${time}Z`), null, time);
    eq(parseCompact(`20260310T${time.replace(/:/g, "")}Z`), null, `${time} compact`);
    eq(parseDateTime(`2026-03-10T${time}.000Z`), null, `${time} dateTime`);
  }
  // A later bound, to recognise "never" without accepting it as a date of an item.
  eq(parseCompact("45000831T235900Z"), null);
  eq(parseCompact("45000831T235900Z", { maxYear: 9999 }), Date.UTC(4500, 7, 31, 23, 59));
  eq(parseDateTime("4500-08-31T23:59:00.000Z", { maxYear: 9999 }), Date.UTC(4500, 7, 31, 23, 59));
  eq(parseCompact("18991231T235900Z", { maxYear: 9999 }), null, "the lower bound stays");
  eq(parseCompact("45000231T235900Z", { maxYear: 9999 }), null, "still a real day");
});

test("eas-timezone: formatters, and what they refuse", () => {
  const at = Date.UTC(2026, 2, 5, 7, 8, 9);
  eq(formatDate(at), "2026-03-05");
  eq(formatUtc(at), "2026-03-05T07:08:09Z");
  eq(formatCompact(at), "20260305T070809Z");
  eq(formatDateTime(at), "2026-03-05T07:08:09.000Z");
  eq(formatUtc(at + 999), "2026-03-05T07:08:09Z", "milliseconds dropped");
  for (const ms of [Date.UTC(1900, 0, 1), Date.UTC(1969, 11, 31, 23, 59, 59), 0, Date.UTC(2000, 1, 29, 12), Date.UTC(2200, 11, 31, 23, 59, 59)]) {
    eq(parseDate(formatDate(ms)), ms - (((ms % DAY) + DAY) % DAY), "date round trip");
    eq(parseUtc(formatUtc(ms)), ms, "UTC round trip");
    eq(parseCompact(formatCompact(ms)), ms, "compact round trip");
    eq(parseDateTime(formatDateTime(ms)), ms, "dateTime round trip");
  }
  for (const format of [formatDate, formatUtc, formatCompact, formatDateTime]) {
    for (const bad of [NaN, Infinity, undefined, null, "2026", Date.UTC(1899, 11, 31, 23, 59, 59), Date.UTC(2201, 0, 1), -8.64e15, 8.64e15, 1e20]) {
      throws(() => format(bad), isBadDate, String(bad));
    }
  }
});

test("eas-timezone: conversionError is a ProtocolError with a code", () => {
  const error = conversionError("BAD_ITEM", "raison");
  assert(error instanceof ProtocolError && error instanceof Error);
  eq([error.code, error.message, error.name], ["BAD_ITEM", "raison", "ProtocolError"]);
  // Reasons name a field, never a value.
  const secret = "A".repeat(231);
  const thrown = throws(() => decodeTimeZone(secret), isBadZone);
  assert(!thrown.message.includes("AAAA"), "no content in the reason");
  eq(MINUTE, 60_000);
});
