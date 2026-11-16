// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the recurrence conversion against [MS-ASCAL] 2.2.2.37 (and the
 * elements it names), [MS-ASTASK] 2.2.2.20 and RFC 5545 for the meaning of
 * the rules: every Type, every range, hostile elements, the three protocol
 * versions, and round trips in both directions.
 * Elements are encoded to WBXML and decoded again, as they come from a
 * server.
 */

import { test, assert, eq, throws, prng } from "./harness.mjs";
import { readRecurrence, writeRecurrence, checkRecurrence, recurrenceProblem, checkVersion, WEEKDAYS, PROTOCOL_VERSIONS } from "../../src/core/recurrence.mjs";
import { UTC_ZONE, decodeTimeZone, formatDate, formatUtc } from "../../src/core/eas-timezone.mjs";
import { el, encode, decode, text } from "../../src/core/wbxml.mjs";
import { ProtocolError } from "../../src/core/protocol.mjs";

const DAY = 86_400_000;
const isBad = (e) => e instanceof ProtocolError && e.code === "BAD_RECURRENCE";
const isBadVersion = (e) => e instanceof ProtocolError && e.code === "BAD_VERSION";

const PACIFIC = decodeTimeZone(
  "4AEAACgARwBNAFQALQAwADgAOgAwADAAKQAgAFAAYQBjAGkAZgBpAGMAIABUAGkAbQBlACAAKABVAFMAIAAmACAAQwAAAAsAAAABAAIAAAAAAAAAAAAAACgARwBNAFQALQAwADgAOgAwADAAKQAgAFAAYQBjAGkAZgBpAGMAIABUAGkAbQBlACAAKABVAFMAIAAmACAAQwAAAAMAAAACAAIAAAAAAAAAxP///w==",
);

/** A Recurrence element as received: `fields` is a list of [tag, value] in the item's namespace. */
function received(fields, ns = "Calendar") {
  return decode(encode(el(`${ns}:Recurrence`, fields.map(([tag, value]) => (tag.includes(":") ? el(tag, value) : el(`${ns}:${tag}`, value))))));
}
const calendar = (...fields) => readRecurrence(received(fields));
const task = (...fields) => readRecurrence(received(fields, "Tasks"), { task: true });

/** What a list of elements says, as [tag, text] pairs, to compare with what was written. */
const pairs = (elements) => elements.map((e) => [`${e.ns}:${e.tag}`, text(e)]);
const written = (rule, options) => pairs(writeRecurrence(rule, { version: "14.1", start: "2026-03-10T17:00:00Z", ...options }));

const rule = (fields) => ({ freq: "daily", interval: 1, count: null, until: null, byDay: [], bySetPos: null, byMonthDay: null, byMonth: null, weekStart: null, ...fields });
const ALL_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WORK_DAYS = ["MO", "TU", "WE", "TH", "FR"];

// ── Reading: the patterns of the specification ────────────────────────────

test("recurrence: the examples of [MS-ASCAL] 4.4", () => {
  const cases = [
    ["every day", [["Type", "0"], ["Interval", "1"]], rule({})],
    ["every other day", [["Type", "0"], ["Interval", "2"]], rule({ interval: 2 })],
    ["every weekday", [["Type", "1"], ["Interval", "1"], ["DayOfWeek", "62"]], rule({ freq: "weekly", byDay: WORK_DAYS })],
    ["every Saturday", [["Type", "1"], ["Interval", "1"], ["DayOfWeek", "64"]], rule({ freq: "weekly", byDay: ["SA"] })],
    ["first day of every month", [["Type", "2"], ["Interval", "1"], ["DayOfMonth", "1"]], rule({ freq: "monthly", byMonthDay: 1 })],
    ["last day of every month", [["Type", "3"], ["Interval", "1"], ["WeekOfMonth", "5"], ["DayOfWeek", "127"]], rule({ freq: "monthly", byDay: ALL_DAYS, bySetPos: -1 })],
    ["first Saturday of every month", [["Type", "3"], ["Interval", "1"], ["WeekOfMonth", "1"], ["DayOfWeek", "64"]], rule({ freq: "monthly", byDay: ["SA"], bySetPos: 1 })],
    ["first weekday of every month", [["Type", "3"], ["Interval", "1"], ["WeekOfMonth", "1"], ["DayOfWeek", "62"]], rule({ freq: "monthly", byDay: WORK_DAYS, bySetPos: 1 })],
    ["first weekend day of every month", [["Type", "3"], ["Interval", "1"], ["WeekOfMonth", "1"], ["DayOfWeek", "65"]], rule({ freq: "monthly", byDay: ["SU", "SA"], bySetPos: 1 })],
    ["1 June every year", [["Type", "5"], ["Interval", "1"], ["DayOfMonth", "1"], ["MonthOfYear", "6"]], rule({ freq: "yearly", byMonthDay: 1, byMonth: 6 })],
    ["first Saturday of June", [["Type", "6"], ["Interval", "1"], ["WeekOfMonth", "1"], ["DayOfWeek", "64"], ["MonthOfYear", "6"]], rule({ freq: "yearly", byDay: ["SA"], bySetPos: 1, byMonth: 6 })],
    ["last day of June", [["Type", "6"], ["Interval", "1"], ["WeekOfMonth", "5"], ["DayOfWeek", "127"], ["MonthOfYear", "6"]], rule({ freq: "yearly", byDay: ALL_DAYS, bySetPos: -1, byMonth: 6 })],
  ];
  for (const [what, fields, expected] of cases) {
    eq(calendar(...fields), { recurrence: expected, readOnly: null, exact: true }, what);
    // The same pattern written back says the same thing.
    const again = readRecurrence(received(writeRecurrence(expected, { version: "14.1", start: "2026-03-10T17:00:00Z" }).map((e) => [e.tag, text(e)])));
    eq(again.recurrence, expected, `${what}, written and read again`);
  }
});

test("recurrence: the items of [MS-ASCAL] 4.1 and 4.2", () => {
  eq(
    calendar(["Type", "3"], ["Interval", "1"], ["Until", "20090713T190000Z"], ["WeekOfMonth", "2"], ["DayOfWeek", "2"]).recurrence,
    rule({ freq: "monthly", until: "2009-07-13T19:00:00Z", byDay: ["MO"], bySetPos: 2 }),
  );
  eq(calendar(["Type", "1"], ["Interval", "1"], ["Occurrences", "3"], ["DayOfWeek", "32"]).recurrence, rule({ freq: "weekly", count: 3, byDay: ["FR"] }));
});

test("recurrence: Type 0 with DayOfWeek is a weekly rule, and Interval counts weeks", () => {
  eq(calendar(["Type", "0"], ["Interval", "2"], ["DayOfWeek", "64"]).recurrence, rule({ freq: "weekly", interval: 2, byDay: ["SA"] }));
  eq(calendar(["Type", "0"], ["DayOfWeek", "62"]).recurrence, rule({ freq: "weekly", byDay: WORK_DAYS }));
});

test("recurrence: every DayOfWeek set, in week order", () => {
  for (let mask = 1; mask <= 127; mask++) {
    const days = WEEKDAYS.filter((_, bit) => mask & (1 << bit));
    eq(calendar(["Type", "1"], ["DayOfWeek", String(mask)]).recurrence.byDay, days, `mask ${mask}`);
    eq(written(rule({ freq: "weekly", byDay: [...days].reverse() })), [["Calendar:Type", "1"], ["Calendar:Interval", "1"], ["Calendar:DayOfWeek", String(mask)]], `mask ${mask} written`);
  }
  eq(WEEKDAYS, ALL_DAYS);
});

test("recurrence: WeekOfMonth 1 to 4 is the nth, 5 the last", () => {
  for (const [week, nth] of [[1, 1], [2, 2], [3, 3], [4, 4], [5, -1]]) {
    eq(calendar(["Type", "3"], ["WeekOfMonth", String(week)], ["DayOfWeek", "16"]).recurrence, rule({ freq: "monthly", byDay: ["TH"], bySetPos: nth }));
    eq(written(rule({ freq: "monthly", byDay: ["TH"], bySetPos: nth })), [["Calendar:Type", "3"], ["Calendar:Interval", "1"], ["Calendar:WeekOfMonth", String(week)], ["Calendar:DayOfWeek", "16"]]);
  }
});

test("recurrence: Interval is 1 when absent or 0, FirstDayOfWeek gives weekStart", () => {
  eq(calendar(["Type", "0"]).recurrence.interval, 1, "absent");
  eq(calendar(["Type", "0"], ["Interval", "0"]).recurrence.interval, 1, "0, as servers treat it");
  eq(calendar(["Type", "0"], ["Interval", "999"]).recurrence.interval, 999);
  eq(calendar(["Type", "1"], ["DayOfWeek", "2"]).recurrence.weekStart, null);
  WEEKDAYS.forEach((day, index) => {
    eq(calendar(["Type", "1"], ["DayOfWeek", "2"], ["FirstDayOfWeek", String(index)]).recurrence.weekStart, day);
  });
});

// ── Reading: ranges and structure ─────────────────────────────────────────

test("recurrence: every value is checked against its range", () => {
  const weekly = [["Type", "1"], ["DayOfWeek", "2"]];
  const refused = (fields, what) => throws(() => calendar(...fields), isBad, what);
  for (const type of ["4", "7", "-1", "255", "", " 1", "1 ", "0x1", "1.0", "un", "1e0", "+1"]) refused([["Type", type], ["DayOfWeek", "2"]], `Type ${JSON.stringify(type)}`);
  refused([["DayOfWeek", "2"]], "no Type");
  refused([], "empty Recurrence");
  for (const bad of ["1000", "-1", "", "x", "99999999999", "1.5"]) refused([...weekly, ["Interval", bad]], `Interval ${bad}`);
  for (const bad of ["0", "1000", "-3", "", "65536"]) refused([...weekly, ["Occurrences", bad]], `Occurrences ${bad}`);
  eq(calendar(...weekly, ["Occurrences", "999"]).recurrence.count, 999);
  eq(calendar(...weekly, ["Occurrences", "1"]).recurrence.count, 1);
  for (const bad of ["0", "128", "255", "-1", "", "SU"]) refused([["Type", "1"], ["DayOfWeek", bad]], `DayOfWeek ${bad}`);
  for (const bad of ["0", "32", "-1", ""]) refused([["Type", "2"], ["DayOfMonth", bad]], `DayOfMonth ${bad}`);
  for (const bad of ["0", "6", "-1", ""]) refused([["Type", "3"], ["WeekOfMonth", bad], ["DayOfWeek", "2"]], `WeekOfMonth ${bad}`);
  for (const bad of ["0", "13", "-1", ""]) refused([["Type", "5"], ["DayOfMonth", "1"], ["MonthOfYear", bad]], `MonthOfYear ${bad}`);
  for (const bad of ["24", "-1", "", "256"]) refused([...weekly, ["CalendarType", bad]], `CalendarType ${bad}`);
  for (const bad of ["2", "-1", "", "true"]) refused([...weekly, ["IsLeapMonth", bad]], `IsLeapMonth ${bad}`);
  for (const bad of ["7", "-1", "", "MO"]) refused([...weekly, ["FirstDayOfWeek", bad]], `FirstDayOfWeek ${bad}`);
  // Leading zeros are still the number.
  eq(calendar(["Type", "01"], ["DayOfWeek", "002"], ["Interval", "003"]).recurrence, rule({ freq: "weekly", interval: 3, byDay: ["MO"] }));
});

test("recurrence: an element its Type forbids, or one it needs and lacks, is refused", () => {
  const allowed = { DayOfWeek: [0, 1, 3, 6], DayOfMonth: [2, 5], WeekOfMonth: [3, 6], MonthOfYear: [5, 6] };
  const needed = { 0: [], 1: ["DayOfWeek"], 2: ["DayOfMonth"], 3: ["WeekOfMonth", "DayOfWeek"], 5: ["DayOfMonth", "MonthOfYear"], 6: ["WeekOfMonth", "DayOfWeek", "MonthOfYear"] };
  const value = { DayOfWeek: "2", DayOfMonth: "15", WeekOfMonth: "2", MonthOfYear: "6" };
  for (const type of [0, 1, 2, 3, 5, 6]) {
    const complete = [["Type", String(type)], ...needed[type].map((tag) => [tag, value[tag]])];
    assert(calendar(...complete).recurrence !== null, `Type ${type} with what it needs`);
    for (const missing of needed[type]) {
      throws(() => calendar(...complete.filter(([tag]) => tag !== missing)), isBad, `Type ${type} without ${missing}`);
    }
    for (const extra of Object.keys(allowed)) {
      if (allowed[extra].includes(type) || needed[type].includes(extra)) continue;
      throws(() => calendar(...complete, [extra, value[extra]]), isBad, `Type ${type} with ${extra}`);
    }
  }
});

test("recurrence: a doubled element, a nested one or a crowd of them is refused", () => {
  for (const tag of ["Type", "Interval", "Occurrences", "Until", "DayOfWeek", "CalendarType", "IsLeapMonth", "FirstDayOfWeek"]) {
    const value = tag === "Until" ? "20260310T170000Z" : "1";
    throws(() => calendar(["Type", "1"], ["DayOfWeek", "2"], [tag, value], [tag, value]), isBad, `two ${tag}`);
  }
  // Two different values: no way to choose.
  throws(() => calendar(["Type", "2"], ["DayOfMonth", "1"], ["DayOfMonth", "31"]), isBad);
  const nested = decode(encode(el("Calendar:Recurrence", [el("Calendar:Type", [el("Calendar:Type", "1")]), el("Calendar:DayOfWeek", "2")])));
  throws(() => readRecurrence(nested), isBad, "an element inside Type");
  const crowd = decode(encode(el("Calendar:Recurrence", [el("Calendar:Type", "0"), ...Array.from({ length: 10_000 }, () => el("Calendar:Subject", "x"))])));
  throws(() => readRecurrence(crowd), isBad, "10,000 children");
  throws(() => calendar(["Type", "1"], ["DayOfWeek", "2".repeat(33)]), isBad, "a value of 33 characters");
});

test("recurrence: elements of other namespaces and unknown ones are ignored", () => {
  const node = decode(encode(el("Calendar:Recurrence", [
    el("Tasks:Type", "5"), // another namespace: not this recurrence's Type
    el("Calendar:Type", "1"),
    el("Email:DayOfWeek", "127"),
    el("Calendar:DayOfWeek", "2"),
    el("Tasks:Regenerate", "1"),
    el("Tasks:DeadOccur", "1"),
    el("Calendar:Subject", "not a recurrence element"),
    el("Email2:CalendarType", "8"),
  ])));
  eq(readRecurrence(node), { recurrence: rule({ freq: "weekly", byDay: ["MO"] }), readOnly: null, exact: true });
});

test("recurrence: only a Recurrence element of the right namespace is read", () => {
  const fields = [["Type", "0"]];
  throws(() => readRecurrence(received(fields, "Tasks")), isBad, "a task recurrence read as a calendar one");
  throws(() => readRecurrence(received(fields), { task: true }), isBad, "a calendar recurrence read as a task one");
  throws(() => readRecurrence(decode(encode(el("Email:Recurrence", [el("Email:Type", "0")])))), isBad, "the recurrence of a meeting request");
  throws(() => readRecurrence(decode(encode(el("Calendar:Exceptions", [el("Calendar:Type", "0")])))), isBad, "another element");
  for (const bad of [null, undefined, "Recurrence", {}, [], { ns: "Calendar", tag: "Recurrence" }]) throws(() => readRecurrence(bad), isBad, String(bad));
});

// ── Reading: end of the series ────────────────────────────────────────────

test("recurrence: Until of a timed item is the instant, of an all-day item the day in its zone", () => {
  const until = (value, options) => readRecurrence(received([["Type", "0"], ["Until", value]]), options).recurrence.until;
  eq(until("20260310T170000Z"), "2026-03-10T17:00:00Z");
  // Midnight of 10 March in Pacific time is 07:00 UTC (daylight time since the 8th).
  eq(until("20260310T070000Z", { allDay: true, zone: PACIFIC }), "2026-03-10");
  eq(until("20260310T065959Z", { allDay: true, zone: PACIFIC }), "2026-03-09");
  eq(until("20260310T070000Z", { allDay: true }), "2026-03-10", "UTC by default");
  eq(until("20260310T235959Z", { allDay: true, zone: UTC_ZONE }), "2026-03-10");
});

test("recurrence: an Until that is not a Compact DateTime is refused", () => {
  for (const bad of ["", "2026-03-10T17:00:00Z", "20260310", "20260310T170000", "20260310T170000z", "20260230T170000Z", "20261310T170000Z", "20260310T250000Z", "18991231T170000Z", "00000000T000000Z", "20260310T170000Z ", "never"]) {
    throws(() => calendar(["Type", "0"], ["Until", bad]), isBad, JSON.stringify(bad));
  }
});

test("recurrence: Occurrences wins over Until, and an Until from 2200 on is no end", () => {
  eq(calendar(["Type", "0"], ["Until", "20260310T170000Z"], ["Occurrences", "5"]).recurrence, rule({ count: 5 }));
  // Even then, an Until that cannot be read makes the recurrence invalid.
  throws(() => calendar(["Type", "0"], ["Until", "garbage"], ["Occurrences", "5"]), isBad);
  for (const never of ["45000831T235900Z", "99991231T235959Z", "22000101T000000Z"]) {
    eq(calendar(["Type", "0"], ["Until", never]).recurrence, rule({}), never);
  }
  eq(calendar(["Type", "0"], ["Until", "21991231T235959Z"]).recurrence.until, "2199-12-31T23:59:59Z");
  eq(task(["Type", "0"], ["Until", "4500-08-31T23:59:00.000Z"]).recurrence.until, null);
});

// ── Reading: what is shown read-only ──────────────────────────────────────

test("recurrence: a calendar that is not Gregorian is not converted", () => {
  const monthly = [["Type", "2"], ["DayOfMonth", "15"]];
  for (const gregorian of [0, 1, 2, 9, 10, 11, 12]) {
    // The localized forms have the same dates, but would not be written back: the rule is not exact.
    eq(calendar(...monthly, ["CalendarType", String(gregorian)]), { recurrence: rule({ freq: "monthly", byMonthDay: 15 }), readOnly: null, exact: gregorian < 2 }, `CalendarType ${gregorian}`);
  }
  for (const other of [3, 4, 5, 6, 7, 8, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]) {
    eq(calendar(...monthly, ["CalendarType", String(other)]), { recurrence: null, readOnly: "calendar-type", exact: false }, `CalendarType ${other}`);
  }
  eq(calendar(...monthly, ["IsLeapMonth", "1"]), { recurrence: null, readOnly: "calendar-type", exact: false });
  eq(calendar(...monthly, ["IsLeapMonth", "0"]), { recurrence: rule({ freq: "monthly", byMonthDay: 15 }), readOnly: null, exact: true });
  eq(calendar(...monthly, ["CalendarType", "15"], ["IsLeapMonth", "1"]).readOnly, "calendar-type");
  // The rest of the element is still checked.
  throws(() => calendar(["Type", "2"], ["DayOfMonth", "32"], ["CalendarType", "15"]), isBad);
  throws(() => calendar(["Type", "2"], ["CalendarType", "15"]), isBad, "DayOfMonth missing");
});

// ── Reading: tasks ────────────────────────────────────────────────────────

test("recurrence: a task recurrence, with its dateTime values and its Start", () => {
  eq(
    task(["Type", "1"], ["Start", "2026-03-10T00:00:00.000Z"], ["Until", "2026-06-30T00:00:00.000Z"], ["Interval", "2"], ["DayOfWeek", "4"], ["Regenerate", "0"], ["DeadOccur", "0"], ["FirstDayOfWeek", "1"]),
    { recurrence: rule({ freq: "weekly", interval: 2, until: "2026-06-30", byDay: ["TU"], weekStart: "MO" }), readOnly: null, exact: true, start: "2026-03-10" },
  );
  eq(task(["Type", "0"]).start, null, "Start may be left out by the server");
  eq(task(["Type", "0"], ["Until", "2026-06-30T23:59:59Z"]).recurrence.until, "2026-06-30", "the day as written");
  eq(task(["Type", "0"], ["Occurrences", "255"]).recurrence.count, 255);
  for (const bad of ["256", "0", "999"]) throws(() => task(["Type", "0"], ["Occurrences", bad]), isBad, `Occurrences ${bad}`);
  for (const bad of ["20260310T000000Z", "2026-03-10", "2026-02-30T00:00:00.000Z", "", "1899-12-31T00:00:00.000Z"]) {
    throws(() => task(["Type", "0"], ["Start", bad]), isBad, `Start ${bad}`);
    throws(() => task(["Type", "0"], ["Until", bad]), isBad, `Until ${bad}`);
  }
  // A Compact DateTime is the calendar's format, not the task's, and the reverse.
  throws(() => calendar(["Type", "0"], ["Until", "2026-06-30T00:00:00.000Z"]), isBad);
});

test("recurrence: a task that regenerates is read-only, a dead occurrence is not recurring", () => {
  const weekly = [["Type", "1"], ["DayOfWeek", "2"], ["Start", "2026-03-09T00:00:00.000Z"]];
  eq(task(...weekly, ["Regenerate", "1"]), { recurrence: null, readOnly: "regenerating", exact: false, start: "2026-03-09" });
  eq([task(...weekly, ["Regenerate", "0"]).readOnly, task(...weekly, ["Regenerate", "0"], ["DeadOccur", "0"]).exact], [null, true]);
  // The pattern of a dead occurrence is not kept: not recurring, and not exact.
  for (const dead of ["1", "2", "255"]) eq(task(...weekly, ["DeadOccur", dead]), { recurrence: null, readOnly: null, exact: false, start: "2026-03-09" }, `DeadOccur ${dead}`);
  eq(task(...weekly, ["DeadOccur", "1"], ["Regenerate", "1"]).readOnly, null, "a dead occurrence first");
  eq(task(...weekly, ["CalendarType", "6"]), { recurrence: null, readOnly: "calendar-type", exact: false, start: "2026-03-09" });
  eq(task(...weekly, ["CalendarType", "2"]).exact, false, "a localized Gregorian calendar");
  for (const bad of ["2", "-1", ""]) throws(() => task(...weekly, ["Regenerate", bad]), isBad, `Regenerate ${bad}`);
  for (const bad of ["256", "-1", "", "x"]) throws(() => task(...weekly, ["DeadOccur", bad]), isBad, `DeadOccur ${bad}`);
  // In a calendar item these are not recurrence elements at all.
  const node = decode(encode(el("Calendar:Recurrence", [el("Calendar:Type", "0"), el("Tasks:Regenerate", "1")])));
  eq(readRecurrence(node).readOnly, null);
});

// ── checkRecurrence ───────────────────────────────────────────────────────

test("recurrence: checkRecurrence accepts the shapes ActiveSync can express", () => {
  const shapes = [
    rule({}),
    rule({ interval: 999, count: 999 }),
    rule({ until: "2026-12-31T23:59:59Z" }),
    rule({ until: "2026-12-31" }),
    rule({ byDay: WORK_DAYS }), // "daily on weekdays", as Thunderbird writes "every weekday"
    rule({ freq: "weekly" }),
    rule({ freq: "weekly", interval: 2, byDay: ["MO", "WE"], weekStart: "SU" }),
    rule({ freq: "monthly" }),
    rule({ freq: "monthly", byMonthDay: 31 }),
    rule({ freq: "monthly", byDay: ["FR"], bySetPos: -1 }),
    rule({ freq: "monthly", byDay: ALL_DAYS, bySetPos: 4 }),
    rule({ freq: "yearly" }),
    rule({ freq: "yearly", byMonth: 6 }),
    rule({ freq: "yearly", byMonth: 2, byMonthDay: 29 }),
    rule({ freq: "yearly", byMonth: 11, byDay: ["TH"], bySetPos: 4 }),
  ];
  for (const shape of shapes) {
    const checked = checkRecurrence(shape);
    eq(checked, shape, JSON.stringify(shape));
    assert(checked !== shape && Object.isFrozen(checked) && Object.isFrozen(checked.byDay), "a frozen copy");
  }
  eq(checkRecurrence(rule({ freq: "weekly", byDay: ["SA", "MO", "SU"] })).byDay, ["SU", "MO", "SA"], "byDay in week order");
  eq(Object.keys(checkRecurrence({ ...rule({}), extra: 1, rrule: "FREQ=SECONDLY" })), Object.keys(rule({})), "unknown properties are left out");
});

test("recurrence: checkRecurrence refuses every field out of its range", () => {
  const refused = (fields, what, options) => throws(() => checkRecurrence(rule(fields), options), isBad, what ?? JSON.stringify(fields));
  for (const freq of ["secondly", "minutely", "hourly", "DAILY", "", null, undefined, 0, ["daily"], { toString: () => "daily" }]) refused({ freq }, `freq ${String(freq)}`);
  for (const interval of [0, 1000, -1, 1.5, "1", null, undefined, NaN, Infinity, 2 ** 31]) refused({ interval }, `interval ${String(interval)}`);
  for (const count of [0, 1000, -1, 2.5, "3", undefined, NaN, true]) refused({ count }, `count ${String(count)}`);
  for (const until of ["", "2026-13-01", "2026-02-30", "20260310T170000Z", "2026-03-10T17:00:00", "2026-03-10T17:00:00.000Z", 20260310, undefined, {}, "1899-12-31", "2201-01-01T00:00:00Z"]) refused({ until }, `until ${String(until)}`);
  refused({ count: 3, until: "2026-12-31" }, "count with until");
  for (const byDay of [null, undefined, "MO", ["MO", "MO"], ["XX"], ["mo"], [1], [null], ALL_DAYS.concat("SU"), { 0: "MO", length: 1 }, [["MO"]]]) refused({ freq: "weekly", byDay }, `byDay ${JSON.stringify(byDay)}`);
  for (const bySetPos of [0, 5, -2, 1.5, "1", undefined, NaN]) refused({ freq: "monthly", byDay: ["MO"], bySetPos }, `bySetPos ${String(bySetPos)}`);
  for (const byMonthDay of [0, 32, -1, 1.5, "1", undefined]) refused({ freq: "monthly", byMonthDay }, `byMonthDay ${String(byMonthDay)}`);
  for (const byMonth of [0, 13, -1, 1.5, "6", undefined]) refused({ freq: "yearly", byMonth, byMonthDay: 1 }, `byMonth ${String(byMonth)}`);
  for (const weekStart of ["", "XX", "mo", 1, undefined, ["MO"]]) refused({ freq: "weekly", weekStart }, `weekStart ${String(weekStart)}`);
  for (const bad of [null, undefined, "FREQ=DAILY", 0, [], [rule({})]]) throws(() => checkRecurrence(bad), isBad, String(bad));
  // A missing property is not a default.
  for (const key of Object.keys(rule({}))) {
    const partial = rule({});
    delete partial[key];
    throws(() => checkRecurrence(partial), isBad, `without ${key}`);
  }
});

test("recurrence: tasks count up to 255 and end on a day", () => {
  eq(checkRecurrence(rule({ count: 255 }), { task: true }).count, 255);
  throws(() => checkRecurrence(rule({ count: 256 }), { task: true }), isBad);
  eq(checkRecurrence(rule({ count: 256 })).count, 256);
  eq(checkRecurrence(rule({ until: "2026-12-31" }), { task: true }).until, "2026-12-31");
  throws(() => checkRecurrence(rule({ until: "2026-12-31T00:00:00Z" }), { task: true }), isBad);
});

test("recurrence: a rule ActiveSync cannot express is refused, never approximated", () => {
  const refused = (fields, what) => {
    throws(() => checkRecurrence(rule(fields)), isBad, what);
    throws(() => writeRecurrence(rule(fields), { version: "14.1", start: "2026-03-10T17:00:00Z" }), isBad, `${what}, written`);
  };
  refused({ byDay: ["MO"], interval: 2 }, "every 2 days but only on Mondays");
  refused({ bySetPos: 1 }, "daily with a position");
  refused({ byMonthDay: 15 }, "daily with a day of the month");
  refused({ byMonth: 6 }, "daily with a month");
  refused({ freq: "weekly", byMonthDay: 15 }, "weekly with a day of the month");
  refused({ freq: "weekly", byMonth: 6 }, "weekly with a month");
  refused({ freq: "weekly", byDay: ["MO"], bySetPos: 1 }, "weekly with a position");
  refused({ freq: "monthly", byDay: ["MO"] }, "every Monday of the month");
  refused({ freq: "monthly", bySetPos: 2 }, "a position without days");
  refused({ freq: "monthly", byMonthDay: 15, byDay: ["MO"], bySetPos: 1 }, "a day number and an nth day");
  refused({ freq: "monthly", byMonthDay: 15, bySetPos: -1 }, "a day number with a position");
  refused({ freq: "monthly", byMonth: 6, byMonthDay: 15 }, "monthly with a month");
  refused({ freq: "yearly", byMonthDay: 15 }, "the 15th of every month, yearly");
  refused({ freq: "yearly", byDay: ["MO"], bySetPos: 2 }, "the second Monday of the year");
  refused({ freq: "yearly", byMonth: 6, byDay: ["MO"] }, "every Monday of June");
  refused({ freq: "yearly", byMonth: 6, bySetPos: 1 }, "a position without days, yearly");
  refused({ freq: "yearly", byMonth: 6, byMonthDay: 15, byDay: ["MO"], bySetPos: 1 }, "a date and an nth day");
  for (const [month, day] of [[2, 30], [2, 31], [4, 31], [6, 31], [9, 31], [11, 31]]) refused({ freq: "yearly", byMonth: month, byMonthDay: day }, `a date that never comes: ${month}/${day}`);
});

test("recurrence: checkRecurrence reads own properties only, and hostile names change nothing", () => {
  throws(() => checkRecurrence(Object.create(rule({}))), isBad, "inherited rule");
  const hostile = JSON.parse('{"__proto__":{"freq":"yearly","polluted":true},"constructor":{"prototype":{"polluted":true}},"freq":"daily","interval":1,"count":null,"until":null,"byDay":[],"bySetPos":null,"byMonthDay":null,"byMonth":null,"weekStart":null,"hasOwnProperty":"x","toString":null}');
  eq(checkRecurrence(hostile), rule({}));
  eq({}.polluted, undefined, "Object.prototype is untouched");
  eq(Object.getPrototypeOf(checkRecurrence(hostile)), Object.prototype);
  throws(() => checkRecurrence(JSON.parse('{"__proto__":{"freq":"daily","interval":1,"count":null,"until":null,"byDay":[],"bySetPos":null,"byMonthDay":null,"byMonth":null,"weekStart":null}}')), isBad, "a rule hidden in __proto__");
  // "__proto__" is not a day, a frequency or a week start.
  throws(() => checkRecurrence(rule({ freq: "__proto__" })), isBad);
  throws(() => checkRecurrence(rule({ freq: "constructor" })), isBad);
  throws(() => checkRecurrence(rule({ freq: "weekly", byDay: ["__proto__"] })), isBad);
  throws(() => checkRecurrence(rule({ weekStart: "toString" })), isBad);
  // A byDay with 10,000 entries is refused before it is walked.
  throws(() => checkRecurrence(rule({ freq: "weekly", byDay: Array.from({ length: 10_000 }, () => "MO") })), isBad);
});

// ── Writing ───────────────────────────────────────────────────────────────

test("recurrence: writing each shape, with the parts taken from the start of the item", () => {
  const C = (tag, value) => [`Calendar:${tag}`, String(value)];
  // 10 March 2026 is a Tuesday; 17:00 UTC is 10:00 in Pacific time, the same day.
  eq(written(rule({})), [C("Type", 0), C("Interval", 1)]);
  eq(written(rule({ interval: 3, count: 10 })), [C("Type", 0), C("Interval", 3), C("Occurrences", 10)]);
  eq(written(rule({ until: "2026-06-30T17:00:00Z" })), [C("Type", 0), C("Interval", 1), C("Until", "20260630T170000Z")]);
  eq(written(rule({ freq: "weekly" })), [C("Type", 1), C("Interval", 1), C("DayOfWeek", 4)], "weekly on the day of the start");
  eq(written(rule({ byDay: WORK_DAYS })), [C("Type", 1), C("Interval", 1), C("DayOfWeek", 62)], "daily on weekdays is the weekly rule");
  eq(written(rule({ freq: "monthly" })), [C("Type", 2), C("Interval", 1), C("DayOfMonth", 10)], "monthly on the day number of the start");
  eq(written(rule({ freq: "monthly", byMonthDay: 31, interval: 2 })), [C("Type", 2), C("Interval", 2), C("DayOfMonth", 31)]);
  eq(written(rule({ freq: "monthly", byDay: ALL_DAYS, bySetPos: -1 })), [C("Type", 3), C("Interval", 1), C("WeekOfMonth", 5), C("DayOfWeek", 127)]);
  eq(written(rule({ freq: "yearly" })), [C("Type", 5), C("Interval", 1), C("DayOfMonth", 10), C("MonthOfYear", 3)], "yearly on the date of the start");
  eq(written(rule({ freq: "yearly", byMonth: 7 })), [C("Type", 5), C("Interval", 1), C("DayOfMonth", 10), C("MonthOfYear", 7)]);
  eq(written(rule({ freq: "yearly", byMonth: 2, byMonthDay: 29 })), [C("Type", 5), C("Interval", 1), C("DayOfMonth", 29), C("MonthOfYear", 2)]);
  eq(written(rule({ freq: "yearly", byMonth: 11, byDay: ["TH"], bySetPos: 4 })), [C("Type", 6), C("Interval", 1), C("WeekOfMonth", 4), C("DayOfWeek", 16), C("MonthOfYear", 11)]);
});

test("recurrence: the day of the start is its day in the item's zone", () => {
  // 03:00 UTC on Tuesday 10 March is 20:00 on Monday 9 March in Pacific time.
  const start = "2026-03-10T03:00:00Z";
  eq(written(rule({ freq: "weekly" }), { start })[2], ["Calendar:DayOfWeek", "4"], "Tuesday in UTC");
  eq(written(rule({ freq: "weekly" }), { start, zone: PACIFIC })[2], ["Calendar:DayOfWeek", "2"], "Monday in Pacific time");
  eq(written(rule({ freq: "monthly" }), { start, zone: PACIFIC })[2], ["Calendar:DayOfMonth", "9"]);
  // 1 March 05:00 UTC is still 28 February in Pacific time.
  eq(written(rule({ freq: "yearly" }), { start: "2026-03-01T05:00:00Z", zone: PACIFIC }).slice(2), [["Calendar:DayOfMonth", "28"], ["Calendar:MonthOfYear", "2"]]);
  // An all-day item gives its day itself.
  eq(written(rule({ freq: "weekly" }), { start: "2026-03-08", allDay: true, zone: PACIFIC })[2], ["Calendar:DayOfWeek", "1"], "Sunday");
  // A yearly rule in a month where the day of the start does not exist is refused.
  throws(() => writeRecurrence(rule({ freq: "yearly", byMonth: 2 }), { version: "14.1", start: "2026-03-30T12:00:00Z" }), isBad, "30 February");
  eq(written(rule({ freq: "yearly", byMonth: 2 }), { start: "2028-02-29T12:00:00Z" }).slice(2), [["Calendar:DayOfMonth", "29"], ["Calendar:MonthOfYear", "2"]]);
});

test("recurrence: until is written in the kind of the item", () => {
  const dated = { start: "2026-03-10", allDay: true, zone: PACIFIC };
  // The last day of an all-day series, sent as its local midnight: 30 June in Pacific daylight time.
  eq(written(rule({ until: "2026-06-30" }), dated)[2], ["Calendar:Until", "20260630T070000Z"]);
  eq(written(rule({ until: "2026-12-25" }), dated)[2], ["Calendar:Until", "20261225T080000Z"], "in winter time");
  eq(written(rule({ until: "2026-06-30" }), { start: "2026-03-10", allDay: true })[2], ["Calendar:Until", "20260630T000000Z"], "UTC by default");
  throws(() => writeRecurrence(rule({ until: "2026-06-30" }), { version: "14.1", start: "2026-03-10T17:00:00Z" }), isBad, "a day for a timed item");
  throws(() => writeRecurrence(rule({ until: "2026-06-30T17:00:00Z" }), { version: "14.1", ...dated }), isBad, "an instant for an all-day item");
  throws(() => writeRecurrence(rule({ until: "2026-06-30T17:00:00Z" }), { version: "14.1", task: true, start: "2026-03-10" }), isBad, "an instant for a task");
});

test("recurrence: no element is written for a version that does not define it", () => {
  const weekly = rule({ freq: "weekly", interval: 2, byDay: ["MO", "TH"], weekStart: "MO" });
  const common = [["Calendar:Type", "1"], ["Calendar:Interval", "2"], ["Calendar:DayOfWeek", "18"]];
  eq(written(weekly, { version: "12.1" }), common);
  eq(written(weekly, { version: "14.0" }), common);
  eq(written(weekly, { version: "14.1" }), [...common, ["Calendar:FirstDayOfWeek", "1"]]);
  eq(written({ ...weekly, weekStart: "SU" }, { version: "14.1" })[3], ["Calendar:FirstDayOfWeek", "0"]);
  eq(written({ ...weekly, weekStart: null }, { version: "14.1" }), common);
  eq(PROTOCOL_VERSIONS, ["12.1", "14.0", "14.1"]);
  for (const version of PROTOCOL_VERSIONS) {
    for (const shape of [rule({}), weekly, rule({ freq: "monthly", byMonthDay: 5 }), rule({ freq: "yearly", byMonth: 11, byDay: ["TH"], bySetPos: 4 })]) {
      const tags = writeRecurrence(shape, { version, start: "2026-03-10T17:00:00Z" }).map((e) => e.tag);
      assert(!tags.includes("CalendarType") && !tags.includes("IsLeapMonth"), `no CalendarType in ${version}`);
      assert(version === "14.1" || !tags.includes("FirstDayOfWeek"), `no FirstDayOfWeek in ${version}`);
      eq(checkVersion(version), version);
    }
  }
  for (const version of [undefined, null, "", "2.5", "12.0", "16.0", "16.1", "14.10", 14.1, 12.1, "14.1 ", ["14.1"]]) {
    throws(() => writeRecurrence(rule({}), { version, start: "2026-03-10T17:00:00Z" }), isBadVersion, `version ${String(version)}`);
    throws(() => checkVersion(version), isBadVersion);
  }
  throws(() => writeRecurrence(rule({})), isBadVersion, "no options");
});

test("recurrence: a task recurrence is written in the Tasks namespace, with its Start", () => {
  const T = (tag, value) => [`Tasks:${tag}`, String(value)];
  const options = { task: true, start: "2026-03-10" };
  eq(written(rule({}), options), [T("Type", 0), T("Start", "2026-03-10T00:00:00.000Z"), T("Interval", 1)]);
  eq(written(rule({ freq: "weekly", until: "2026-06-30", weekStart: "SA" }), options), [
    T("Type", 1), T("Start", "2026-03-10T00:00:00.000Z"), T("Interval", 1), T("Until", "2026-06-30T00:00:00.000Z"), T("DayOfWeek", 4), T("FirstDayOfWeek", 6),
  ]);
  eq(written(rule({ freq: "monthly", count: 255 }), options), [T("Type", 2), T("Start", "2026-03-10T00:00:00.000Z"), T("Interval", 1), T("Occurrences", 255), T("DayOfMonth", 10)]);
  throws(() => writeRecurrence(rule({ count: 256 }), { version: "14.1", ...options }), isBad);
  const tags = writeRecurrence(rule({ freq: "weekly" }), { version: "14.1", ...options }).map((e) => e.tag);
  assert(!tags.includes("DeadOccur") && !tags.includes("Regenerate"), "DeadOccur and Regenerate are the caller's");
  // Every element can be encoded: its tag exists in the code page.
  for (const ns of ["Calendar", "Tasks"]) {
    const children = writeRecurrence(rule({ freq: "yearly", byMonth: 11, byDay: ["TH"], bySetPos: 4, until: ns === "Tasks" ? "2030-01-01" : "2030-01-01T00:00:00Z", weekStart: "MO" }), {
      version: "14.1", task: ns === "Tasks", start: ns === "Tasks" ? "2026-03-10" : "2026-03-10T17:00:00Z",
    });
    assert(encode(el(`${ns}:Recurrence`, children)).length > 20, `${ns} recurrence encodes`);
  }
});

test("recurrence: writeRecurrence refuses an invalid start, zone or rule", () => {
  const ok = { version: "14.1", start: "2026-03-10T17:00:00Z" };
  for (const start of [undefined, null, "", "2026-03-10", "20260310T170000Z", "2026-02-30T17:00:00Z", 0, new Date()]) {
    throws(() => writeRecurrence(rule({}), { ...ok, start }), isBad, `timed start ${String(start)}`);
  }
  for (const start of [undefined, null, "", "2026-03-10T17:00:00Z", "2026-02-30", 20260310]) {
    throws(() => writeRecurrence(rule({}), { ...ok, allDay: true, start }), isBad, `all-day start ${String(start)}`);
    throws(() => writeRecurrence(rule({}), { ...ok, task: true, start }), isBad, `task start ${String(start)}`);
  }
  throws(() => writeRecurrence(rule({}), { ...ok, zone: { bias: 5000 } }), ProtocolError, "invalid zone");
  throws(() => writeRecurrence(rule({}), { ...ok, zone: null }), ProtocolError, "no zone");
  for (const bad of [null, undefined, "FREQ=DAILY", rule({ interval: 0 }), rule({ freq: "hourly" })]) throws(() => writeRecurrence(bad, ok), isBad);
});

// ── The rules of a recurrence ─────────────────────────────────────────────

test("recurrence: a well-formed element whose rule has no valid shape is left out, not refused", () => {
  // Every value is in the range its Type allows, but the date never comes: rule 2.
  for (const [day, month] of [[30, 2], [31, 2], [31, 4], [31, 6], [31, 9], [31, 11]]) {
    eq(calendar(["Type", "5"], ["DayOfMonth", String(day)], ["MonthOfYear", String(month)]), { recurrence: null, readOnly: "unsupported-recurrence", exact: false }, `${day}/${month}`);
    eq(task(["Type", "5"], ["DayOfMonth", String(day)], ["MonthOfYear", String(month)], ["Start", "2026-03-10T00:00:00.000Z"]), { recurrence: null, readOnly: "unsupported-recurrence", exact: false, start: "2026-03-10" }, `${day}/${month}, task`);
  }
  eq(calendar(["Type", "5"], ["DayOfMonth", "29"], ["MonthOfYear", "2"]).readOnly, null, "29 February is a date");
  // Another calendar may have that date: its own reason comes first.
  eq(calendar(["Type", "5"], ["DayOfMonth", "30"], ["MonthOfYear", "2"], ["CalendarType", "6"]).readOnly, "calendar-type");
  // An element that is not what the protocol says is still refused.
  throws(() => calendar(["Type", "5"], ["DayOfMonth", "32"], ["MonthOfYear", "2"]), isBad);
  throws(() => calendar(["Type", "5"], ["DayOfMonth", "30"]), isBad);
});

const timed = (day, fields = {}) => ({ allDay: false, start: `${day}T09:00:00Z`, end: `${day}T10:00:00Z`, ...fields });
const wholeDay = (day, days = 1) => ({ allDay: true, start: day, end: formatDate(Date.parse(`${day}T00:00:00Z`) + days * DAY) });
const fits = (fields, item, options = {}) => recurrenceProblem(rule(fields), { ...options, item }) === null;

test("recurrence: with the item, until must be of the kind of its start (rule 3)", () => {
  assert(fits({ until: "2026-12-31T17:00:00Z" }, timed("2026-03-10")), "an instant for a timed event");
  assert(!fits({ until: "2026-12-31" }, timed("2026-03-10")), "a day for a timed event");
  assert(fits({ until: "2026-12-31" }, wholeDay("2026-03-10")), "a day for an all-day event");
  assert(!fits({ until: "2026-12-31T00:00:00Z" }, wholeDay("2026-03-10")), "an instant for an all-day event");
  assert(fits({ until: "2026-12-31" }, { start: "2026-03-10", due: null }, { task: true }), "a day for a task");
  // Without the item, both kinds are values of rule 1.
  eq(recurrenceProblem(rule({ until: "2026-12-31" })), null);
  eq(recurrenceProblem(rule({ until: "2026-12-31T17:00:00Z" })), null);
  throws(() => checkRecurrence(rule({ until: "2026-12-31" }), { item: timed("2026-03-10") }), isBad);
});

test("recurrence: a day 29, 30 or 31 must come in one of the first four periods (rule 4)", () => {
  const monthly = (day, interval, first) => fits({ freq: "monthly", interval, byMonthDay: day }, timed(first));
  // The months of a rule that counts in twelves are one month: February never has a 30th, April never a 31st.
  for (const interval of [12, 24, 36, 120, 996]) {
    assert(!monthly(31, interval, "2025-02-10"), `31, every ${interval} months from February`);
    assert(!monthly(30, interval, "2025-02-10"), `30, every ${interval} months from February`);
    for (const first of ["2025-04-10", "2025-06-10", "2025-09-10", "2025-11-10"]) assert(!monthly(31, interval, first), `31, every ${interval} months from ${first}`);
    for (const first of ["2025-01-10", "2025-03-10", "2025-05-10", "2025-07-10", "2025-08-10", "2025-10-10", "2025-12-10"]) assert(monthly(31, interval, first), `31, every ${interval} months from ${first}`);
    for (const first of ["2025-01-10", "2025-04-10", "2025-12-10"]) assert(monthly(30, interval, first), `30, every ${interval} months from ${first}`);
    for (const day of [1, 15, 28]) assert(monthly(day, interval, "2025-02-10"), `${day} is in every month`);
  }
  // Not only the multiples of twelve: June, November, April and September are four months of 30 days.
  assert(!monthly(31, 5, "2025-06-10"), "31, every 5 months from June, though July 2027 has it");
  assert(monthly(31, 5, "2025-05-10") && monthly(30, 5, "2025-06-10"));
  // Every interval and every first month, against the calendar itself: the months k x interval after the first.
  const lengthOf = (index) => new Date(Date.UTC(Math.floor(index / 12), (index % 12) + 1, 0)).getUTCDate();
  let refused = 0;
  for (let interval = 1; interval <= 999; interval++) {
    for (let month = 1; month <= 12; month++) {
      for (const day of [28, 29, 30, 31]) {
        const comes = [0, 1, 2, 3].some((k) => lengthOf(2025 * 12 + month - 1 + k * interval) >= day);
        eq(monthly(day, interval, `2025-${String(month).padStart(2, "0")}-10`), comes, `${day}, every ${interval} months from month ${month}`);
        if (!comes) refused++;
      }
    }
  }
  assert(refused > 300, `some are refused (${refused})`);
  // The 29th and February: leap years, by the Gregorian rule.
  assert(monthly(29, 12, "2025-02-10"), "2025, 2026, 2027, 2028: the fourth has it");
  assert(monthly(29, 12, "2028-02-10"), "the first has it");
  assert(!monthly(29, 24, "2025-02-10"), "2025, 2027, 2029, 2031");
  assert(monthly(29, 24, "2026-02-10"), "2026, 2028");
  assert(!monthly(29, 48, "2026-02-10"), "2026, 2030, 2034, 2038");
  assert(monthly(29, 48, "2024-02-10"));
  assert(!monthly(29, 12, "2097-02-10"), "2097 to 2100: 2100 is not a leap year");
  assert(monthly(29, 12, "2096-02-10") && monthly(29, 12, "2101-02-10"), "2096 is; 2104 is the fourth from 2101");
  assert(monthly(29, 12, "1997-02-10"), "2000 is a leap year");
  assert(monthly(29, 1, "2025-02-10") && monthly(29, 11, "2025-02-10"), "another month has it");
  // Exactly four periods: 31 every 2 months from February is February, April, June, August.
  assert(monthly(31, 2, "2025-02-10"));

  // Yearly: the month is that of the rule, the years those of the item.
  const yearly = (day, month, interval, first) => fits({ freq: "yearly", interval, byMonth: month, byMonthDay: day }, timed(first));
  assert(yearly(29, 2, 1, "2025-03-10"), "2028");
  assert(yearly(29, 2, 4, "2024-03-10") && yearly(29, 2, 2, "2026-03-10") && yearly(29, 2, 3, "2025-03-10"));
  assert(!yearly(29, 2, 2, "2025-03-10") && !yearly(29, 2, 4, "2025-03-10") && !yearly(29, 2, 4, "2026-03-10") && !yearly(29, 2, 100, "2001-03-10"));
  assert(!yearly(29, 2, 1, "2097-03-10"), "2097 to 2100");
  assert(yearly(29, 2, 100, "1900-03-10"), "1900, 2000, 2100, 2200: 2000 is a leap year");
  assert(yearly(31, 12, 999, "2025-01-10") && yearly(30, 4, 7, "2025-01-10") && yearly(28, 2, 5, "2025-01-10"), "a date every year has");

  // The day, and for a yearly rule the month, that the rule leaves to the first day of the item.
  assert(fits({ freq: "monthly", interval: 12 }, timed("2025-01-31")), "the 31st of the start, every 12 months");
  assert(fits({ freq: "monthly", interval: 12 }, timed("2024-02-29")), "its own month has it");
  assert(fits({ freq: "yearly", interval: 3 }, timed("2024-02-29")));
  assert(fits({ freq: "yearly", byMonth: 2 }, timed("2025-01-29")), "the 29th of the start in February: 2028");
  assert(!fits({ freq: "yearly", byMonth: 2 }, timed("2025-01-30")), "the 30th of the start in February");
  assert(!fits({ freq: "yearly", byMonth: 4 }, timed("2025-01-31")), "the 31st of the start in April");
  assert(!fits({ freq: "yearly", interval: 2, byMonth: 2 }, timed("2025-01-29")));
  // Rules on the nth day of the week, and daily and weekly ones, have no day number.
  assert(fits({ freq: "monthly", interval: 12, byDay: ["FR"], bySetPos: -1 }, timed("2025-02-10")));
  assert(fits({ freq: "yearly", interval: 2, byMonth: 2, byDay: ALL_DAYS, bySetPos: -1 }, timed("2025-02-10")));
  assert(fits({ interval: 12 }, timed("2025-02-28")) && fits({ freq: "weekly", interval: 12 }, timed("2025-02-28")));
});

test("recurrence: the first day of an item is its day in its own zone, or its date", () => {
  const rule31 = { freq: "monthly", interval: 12, byMonthDay: 31 };
  // 1 March 2025, 02:00 UTC: 28 February on the Pacific coast.
  const late = (zone) => ({ allDay: false, start: "2025-03-01T02:00:00Z", end: "2025-03-01T03:00:00Z", zone });
  assert(fits(rule31, late(UTC_ZONE)) && fits(rule31, late(null)) && fits(rule31, late(undefined)), "March in UTC, and without a zone");
  assert(!fits(rule31, late(PACIFIC)), "February in the Pacific zone");
  // 31 January 2025, 23:00 UTC: 1 February in a zone ten hours east.
  const east = { bias: -600, standard: { bias: 0, change: null }, daylight: { bias: 0, change: null } };
  assert(!fits(rule31, { allDay: false, start: "2025-01-31T23:00:00Z", zone: east }), "February ten hours east");
  assert(fits(rule31, { allDay: false, start: "2025-01-31T23:00:00Z" }));
  // An all-day event and a task are their dates, whatever the zone.
  assert(!fits(rule31, { allDay: true, start: "2025-02-28", end: "2025-03-01", zone: east }));
  assert(fits(rule31, { allDay: true, start: "2025-03-01", end: "2025-03-02", zone: PACIFIC }));
  // A task: its start, or its due date when it has no start.
  const task31 = (item) => fits(rule31, item, { task: true });
  assert(!task31({ start: "2025-02-10", due: "2025-03-10" }), "a start in February");
  assert(task31({ start: "2025-03-10", due: "2025-03-20" }));
  assert(!task31({ start: null, due: "2025-02-10" }), "no start: due in February");
  assert(task31({ start: null, due: "2025-03-10" }) && task31({ due: "2025-03-10" }) && task31({ start: "2025-03-10" }));
  // An item whose first day cannot be told has no rule that fits.
  for (const item of [42, "x", [], {}, { start: null, due: null }, { start: "2025-03-10T00:00:00Z" }, { due: "soon" }]) {
    assert(!fits({}, item, { task: true }), `task ${JSON.stringify(item)}`);
  }
  for (const item of [42, "x", [], {}, { allDay: false, start: "2025-03-10" }, { allDay: true, start: "2025-03-10T09:00:00Z" }, { allDay: false, start: "2025-02-30T09:00:00Z" }, { allDay: false, start: 0 }]) {
    assert(!fits({}, item), `event ${JSON.stringify(item)}`);
  }
  assert(!fits({}, { allDay: false, start: "1900-01-01T00:00:00Z", zone: PACIFIC }), "a first day before 1900");
  assert(fits({}, { allDay: false, start: "1900-01-01T00:00:00Z" }));
  // An invalid zone is not a matter of recurrence: its own error.
  throws(() => recurrenceProblem(rule({}), { item: { allDay: false, start: "2025-03-10T09:00:00Z", zone: { bias: 9000 } } }), (e) => e instanceof ProtocolError && e.code === "BAD_TIMEZONE");
});

test("recurrence: a recurring item is no longer than the period of its rule (rule 5)", () => {
  const HOUR = 3_600_000;
  const lasting = (ms) => ({ allDay: false, start: "2026-03-10T17:00:00Z", end: formatUtc(Date.UTC(2026, 2, 10, 17) + ms) });
  for (const [fields, unit] of [
    [{}, DAY],
    [{ byDay: WORK_DAYS }, DAY],
    [{ freq: "weekly" }, 7 * DAY],
    [{ freq: "weekly", byDay: ALL_DAYS }, 7 * DAY],
    [{ freq: "monthly" }, 31 * DAY],
    [{ freq: "monthly", byMonthDay: 10 }, 31 * DAY],
    [{ freq: "monthly", byDay: ["TU"], bySetPos: 2 }, 31 * DAY],
    [{ freq: "yearly" }, 366 * DAY],
    [{ freq: "yearly", byMonth: 3, byMonthDay: 10 }, 366 * DAY],
    [{ freq: "yearly", byMonth: 3, byDay: ["TU"], bySetPos: 2 }, 366 * DAY],
  ]) {
    for (const interval of fields.byDay === WORK_DAYS ? [1] : [1, 2, 7, 60]) {
      const what = `${JSON.stringify(fields)} every ${interval}`;
      if (interval * unit > 100 * 365 * DAY) continue; // beyond the years of a description
      assert(fits({ ...fields, interval }, lasting(0)), `${what}: no length`);
      assert(fits({ ...fields, interval }, lasting(HOUR)), `${what}: an hour`);
      assert(fits({ ...fields, interval }, lasting(interval * unit)), `${what}: exactly its period`);
      assert(!fits({ ...fields, interval }, lasting(interval * unit + 1000)), `${what}: a second more`);
      assert(!fits({ ...fields, interval }, lasting(2 * interval * unit)), `${what}: twice its period`);
    }
  }
  // All-day events count in days.
  assert(fits({}, wholeDay("2026-03-10", 1)) && !fits({}, wholeDay("2026-03-10", 2)));
  assert(fits({ interval: 3 }, wholeDay("2026-03-10", 3)) && !fits({ interval: 3 }, wholeDay("2026-03-10", 4)));
  assert(fits({ freq: "weekly" }, wholeDay("2026-03-10", 7)) && !fits({ freq: "weekly" }, wholeDay("2026-03-10", 8)));
  assert(fits({ freq: "monthly" }, wholeDay("2026-03-10", 31)) && !fits({ freq: "monthly" }, wholeDay("2026-03-10", 32)));
  assert(fits({ freq: "yearly" }, wholeDay("2026-03-10", 366)) && !fits({ freq: "yearly" }, wholeDay("2026-03-10", 367)));
  // The event that makes Thunderbird return every occurrence since 1900 for each month it shows.
  assert(!fits({}, { allDay: false, start: "1900-01-01T00:00:00Z", end: "2200-12-31T00:00:00Z" }));
  assert(!fits({ interval: 999 }, { allDay: true, start: "1900-01-01", end: "2200-12-31" }));
  // Tasks: from start to due, when they have both.
  const task = (fields, start, due) => fits(fields, { start, due }, { task: true });
  assert(task({}, "2026-03-10", "2026-03-11") && !task({}, "2026-03-10", "2026-03-12"));
  assert(task({ freq: "weekly" }, "2026-03-10", "2026-03-17") && !task({ freq: "weekly" }, "2026-03-10", "2026-03-18"));
  assert(task({}, "2026-03-10", null) && task({}, null, "2026-03-10") && task({}, "2026-03-10", "2026-03-10"));
  // A monthly task from the 1st that is due on the 31st, a yearly one from 1 January due on 31 December of a leap year.
  assert(task({ freq: "monthly" }, "2026-03-01", "2026-03-31") && task({ freq: "monthly", byMonthDay: 1 }, "2026-01-01", "2026-02-01") && !task({ freq: "monthly" }, "2026-03-01", "2026-04-02"));
  assert(task({ freq: "yearly" }, "2028-01-01", "2028-12-31") && task({ freq: "yearly" }, "2028-01-01", "2029-01-01") && !task({ freq: "yearly" }, "2028-01-01", "2029-01-03"));
  // An end that cannot be read is not "no end".
  assert(!fits({}, { allDay: false, start: "2026-03-10T17:00:00Z", end: "2026-03-11" }));
  assert(!fits({}, { start: "2026-03-10", due: "tomorrow" }, { task: true }));
  // Without an end (writeRecurrence does not know it), the length is not judged.
  assert(fits({}, { allDay: false, start: "2026-03-10T17:00:00Z" }));
});

test("recurrence: recurrenceProblem says why, and checkRecurrence throws the same", () => {
  const cases = [
    [rule({ freq: "hourly" }), {}],
    [rule({ freq: "monthly", byMonth: 2 }), {}],
    [rule({ freq: "yearly", byMonth: 2, byMonthDay: 30 }), {}],
    [rule({ freq: "monthly", interval: 12, byMonthDay: 31 }), { item: timed("2025-02-10") }],
    [rule({}), { item: wholeDay("2026-03-10", 2) }],
    [rule({ until: "2026-12-31" }), { item: timed("2026-03-10") }],
    [rule({}), { task: true, item: { start: null, due: null } }],
  ];
  for (const [value, options] of cases) {
    const reason = recurrenceProblem(value, options);
    assert(typeof reason === "string" && reason.length > 0 && reason.length < 120 && !/\d{4}/.test(reason), `a short reason without a date: ${reason}`);
    eq(throws(() => checkRecurrence(value, options), isBad).message, reason);
  }
  // What passes is returned by checkRecurrence as a clean frozen copy, with or without the item.
  const good = rule({ freq: "monthly", interval: 12, byMonthDay: 31 });
  eq(recurrenceProblem(good), null, "without the item, rules 1 and 2 only");
  eq(recurrenceProblem(good, { item: null }), null);
  eq(checkRecurrence(good, { item: timed("2025-03-10") }), good);
  assert(Object.isFrozen(checkRecurrence(good, { item: timed("2025-03-10") })));
});

test("recurrence: writeRecurrence applies the rules that the start of the item decides", () => {
  const write = (fields, options) => writeRecurrence(rule(fields), { version: "14.1", ...options });
  throws(() => write({ freq: "monthly", interval: 12, byMonthDay: 31 }, { start: "2025-02-10T09:00:00Z" }), isBad, "a day that does not come");
  eq(pairs(write({ freq: "monthly", interval: 12, byMonthDay: 31 }, { start: "2025-03-10T09:00:00Z" }))[2], ["Calendar:DayOfMonth", "31"]);
  throws(() => write({ freq: "monthly", interval: 12, byMonthDay: 31 }, { start: "2025-03-01T02:00:00Z", zone: PACIFIC }), isBad, "in the zone of the item");
  throws(() => write({ freq: "yearly", interval: 2, byMonth: 2, byMonthDay: 29 }, { start: "2025-03-10", allDay: true }), isBad);
  throws(() => write({ freq: "monthly", interval: 24, byMonthDay: 29 }, { start: "2025-02-10", task: true }), isBad, "a task");
  throws(() => write({ until: "2026-12-31" }, { start: "2026-03-10T17:00:00Z" }), isBad, "until of another kind");
});

// ── Round trips ───────────────────────────────────────────────────────────

/** A random rule in one of the shapes reading produces (so that a round trip gives it back). */
function randomRule(random, { task = false, allDay = false } = {}) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const days = () => {
    const mask = 1 + Math.floor(random() * 127);
    return WEEKDAYS.filter((_, bit) => mask & (1 << bit));
  };
  const out = rule({ interval: 1 + Math.floor(random() * 999) });
  const end = random();
  if (end < 0.3) {
    out.count = 1 + Math.floor(random() * (task ? 255 : 999));
  } else if (end < 0.6) {
    const ms = Date.UTC(2027, 0, 1) + Math.floor(random() * 3000) * DAY + (task || allDay ? 0 : Math.floor(random() * 86400) * 1000);
    out.until = task || allDay ? formatDate(ms) : formatUtc(ms);
  }
  if (random() < 0.5) out.weekStart = pick(WEEKDAYS);
  switch (pick(["daily", "weekly", "monthly-day", "monthly-nth", "yearly-date", "yearly-nth"])) {
    case "daily":
      break;
    case "weekly":
      Object.assign(out, { freq: "weekly", byDay: days() });
      break;
    case "monthly-day":
      Object.assign(out, { freq: "monthly", byMonthDay: 1 + Math.floor(random() * 31) });
      break;
    case "monthly-nth":
      Object.assign(out, { freq: "monthly", byDay: days(), bySetPos: pick([1, 2, 3, 4, -1]) });
      break;
    case "yearly-date":
      Object.assign(out, { freq: "yearly", byMonth: 1 + Math.floor(random() * 12), byMonthDay: 1 + Math.floor(random() * 28) });
      break;
    default:
      Object.assign(out, { freq: "yearly", byMonth: 1 + Math.floor(random() * 12), byDay: days(), bySetPos: pick([1, 2, 3, 4, -1]) });
  }
  return out;
}

test("recurrence: random rules survive description → elements → WBXML → description", () => {
  const random = prng(443);
  for (let i = 0; i < 1500; i++) {
    const version = PROTOCOL_VERSIONS[i % 3];
    const kind = ["timed", "all-day", "task"][Math.floor(i / 3) % 3];
    const isTask = kind === "task";
    const allDay = kind === "all-day";
    const zone = i % 2 ? PACIFIC : UTC_ZONE;
    const original = randomRule(random, { task: isTask, allDay });
    const start = kind === "timed" ? "2026-03-10T17:00:00Z" : "2026-03-10";
    const children = writeRecurrence(original, { version, task: isTask, start, allDay, zone });
    const node = decode(encode(el(`${isTask ? "Tasks" : "Calendar"}:Recurrence`, children)));
    const back = readRecurrence(node, { task: isTask, allDay, zone });
    const expected = { ...original, weekStart: version === "14.1" ? original.weekStart : null };
    eq(back.recurrence, expected, `${kind} ${version} ${JSON.stringify(original)}`);
    eq([back.readOnly, back.exact], [null, true], "what is written reads back exact");
    if (isTask) eq(back.start, "2026-03-10");
  }
});

test("recurrence: random elements are read into a valid rule, or refused", () => {
  const random = prng(2026);
  const values = ["", "0", "1", "2", "3", "4", "5", "6", "7", "12", "13", "31", "32", "62", "65", "127", "128", "255", "999", "1000", "-1", "x", "20260310T170000Z", "2026-03-10T00:00:00.000Z", "45000831T235900Z"];
  const tags = ["Type", "Interval", "Occurrences", "Until", "DayOfWeek", "DayOfMonth", "WeekOfMonth", "MonthOfYear", "CalendarType", "IsLeapMonth", "FirstDayOfWeek", "Start", "Regenerate", "DeadOccur", "Subject"];
  let read = 0;
  let refused = 0;
  for (let i = 0; i < 4000; i++) {
    const isTask = i % 2 === 1;
    // Most of the time a pattern that holds together, then up to two elements drawn at random.
    const type = Math.floor(random() * 8);
    const fields = [["Type", String(type)]];
    if (random() < 0.9) {
      if ([1, 3, 6].includes(type)) fields.push(["DayOfWeek", String(1 + Math.floor(random() * 127))]);
      if ([2, 5].includes(type)) fields.push(["DayOfMonth", String(1 + Math.floor(random() * 28))]);
      if ([3, 6].includes(type)) fields.push(["WeekOfMonth", String(1 + Math.floor(random() * 5))]);
      if ([5, 6].includes(type)) fields.push(["MonthOfYear", String(1 + Math.floor(random() * 12))]);
    }
    const extra = Math.floor(random() * 3);
    for (let k = 0; k < extra; k++) fields.push([tags[Math.floor(random() * tags.length)], values[Math.floor(random() * values.length)]]);
    const known = fields.filter(([tag]) => isTask || !["Start", "Regenerate", "DeadOccur"].includes(tag));
    try {
      const result = readRecurrence(received(known, isTask ? "Tasks" : "Calendar"), { task: isTask });
      read++;
      if (result.recurrence !== null) {
        eq(checkRecurrence(result.recurrence, { task: isTask }), result.recurrence, "what is read is a valid rule");
        writeRecurrence(result.recurrence, { version: "14.1", task: isTask, start: isTask ? "2026-03-10" : "2026-03-10T17:00:00Z" });
      } else {
        assert(["calendar-type", "regenerating", "unsupported-recurrence", null].includes(result.readOnly), "a known reason");
      }
    } catch (e) {
      assert(isBad(e), `only BAD_RECURRENCE is thrown, not ${e?.name}: ${e?.message}`);
      refused++;
    }
  }
  assert(read > 800 && refused > 800, `both outcomes are exercised (${read} read, ${refused} refused)`);
});
