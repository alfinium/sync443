// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the task conversion against [MS-ASTASK] (elements, the pairs of
 * local and UTC dates, DateCompleted with Complete, DeadOccur and
 * Regenerate), [MS-ASAIRS] (Body) and [MS-ASCMD] (FilterType), and against
 * the task description of docs/CALENDAR-DESIGN.md.
 * ApplicationData is built, encoded to WBXML and decoded again, then read
 * through protocol.parseSync, as it arrives from a server.
 */

import { test, assert, eq, throws, prng } from "./harness.mjs";
import { TASK_FILTER_TYPES, taskOptions, readTask, writeTask, checkTask } from "../../src/core/task-item.mjs";
import { BODY_TRUNCATION_BYTES } from "../../src/core/calendar-item.mjs";
import { UTC_ZONE, decodeTimeZone, formatDate, formatUtc, parseDateTime } from "../../src/core/eas-timezone.mjs";
import { WEEKDAYS, PROTOCOL_VERSIONS } from "../../src/core/recurrence.mjs";
import { el, encode, decode, text } from "../../src/core/wbxml.mjs";
import { parseSync, syncRequest, addCommand, changeCommand, ProtocolError } from "../../src/core/protocol.mjs";

const DAY = 86_400_000;
const hasCode = (code) => (e) => e instanceof ProtocolError && e.code === code;
const isBadItem = hasCode("BAD_ITEM");
const isBadRecurrence = hasCode("BAD_RECURRENCE");
const ch = (...codes) => String.fromCharCode(...codes);
const cp = (...codes) => String.fromCodePoint(...codes);
/** A family emoji and a Persian word, spelled as they are: with the zero-width joiner and non-joiner. */
const FAMILY = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
const PERSIAN = ch(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645);
/** Characters that are removed from the content of a task, and make it "incomplete". */
const HIDDEN = [
  ch(0x00ad), ch(0x061c), ch(0x180e), ch(0x200b), ch(0x200e), ch(0x200f), ch(0x202a), ch(0x202b), ch(0x202c), ch(0x202d), ch(0x202e), ch(0x2060),
  ch(0x2066), ch(0x2067), ch(0x2068), ch(0x2069), ch(0xfeff), ch(0xfff9), ch(0xfffa), ch(0xfffb), ch(0xfffe), ch(0xffff), cp(0xe0001), cp(0xe0061), cp(0xe007f),
];

const PACIFIC = decodeTimeZone(
  "4AEAACgARwBNAFQALQAwADgAOgAwADAAKQAgAFAAYQBjAGkAZgBpAGMAIABUAGkAbQBlACAAKABVAFMAIAAmACAAQwAAAAsAAAABAAIAAAAAAAAAAAAAACgARwBNAFQALQAwADgAOgAwADAAKQAgAFAAYQBjAGkAZgBpAGMAIABUAGkAbQBlACAAKABVAFMAIAAmACAAQwAAAAMAAAACAAIAAAAAAAAAxP///w==",
);
const SYDNEY = { bias: -600, standard: { bias: 0, change: { month: 4, week: 1, weekday: 0, hour: 3, minute: 0 } }, daylight: { bias: -60, change: { month: 10, week: 1, weekday: 0, hour: 2, minute: 0 } } };

/** ApplicationData of an Add in a Sync response, as the client receives it. */
function received(children) {
  const doc = el("AirSync:Sync", [
    el("Collections", [
      el("Collection", [
        el("SyncKey", "2"),
        el("CollectionId", "9"),
        el("Status", "1"),
        el("Commands", [el("Add", [el("ServerId", "9:1"), el("ApplicationData", children)])]),
      ]),
    ]),
  ]);
  return parseSync(decode(encode(doc))).collections[0].commands[0].data;
}

const T = (tag, content) => el(`Tasks:${tag}`, content);
const A = (tag, content) => el(`AirSyncBase:${tag}`, content);
const body = (type, data) => A("Body", [A("Type", type), data === undefined ? null : A("Data", data)]);
const read = (children, options = {}) => readTask(received(children), { version: "14.1", fallbackUid: "task-1", ...options });
/**
 * A description read from the server, as Thunderbird's side then holds it and gives it back: a text the server
 * left unsaid (null) is filled in as the privileged module fills it for a new task.
 */
const held = (d) => ({ ...d, description: d.description ?? "" });

const DEFAULTS = Object.freeze({
  kind: "task",
  uid: "task-1",
  summary: "",
  description: "",
  categories: [],
  privacy: "public",
  start: null,
  due: null,
  completed: false,
  completedAt: null,
  priority: "normal",
  reminderAt: null,
  recurrence: null,
  readOnly: null,
});
const task = (fields = {}) => ({ ...DEFAULTS, ...fields });
const rule = (fields) => ({ freq: "daily", interval: 1, count: null, until: null, byDay: [], bySetPos: null, byMonthDay: null, byMonth: null, weekStart: null, ...fields });

const shape = (e) => [`${e.ns}:${e.tag}`, e.children.length ? e.children.map(shape) : e.value === null ? null : text(e)];
const written = (description, options = {}) => writeTask(description, { version: "14.1", zone: UTC_ZONE, ...options });
const names = (elements) => elements.map((e) => `${e.ns}:${e.tag}`);
const valueOf = (elements, name) => {
  const found = elements.filter((e) => `${e.ns}:${e.tag}` === name);
  assert(found.length <= 1, `${name} written once at most`);
  return found.length ? shape(found[0])[1] : undefined;
};
const deepFrozen = (x) => x === null || typeof x !== "object" || (Object.isFrozen(x) && Object.values(x).every(deepFrozen));

// ── Sync options ──────────────────────────────────────────────────────────

test("task-item: taskOptions asks for all tasks or the incomplete ones, and a plain-text body", () => {
  eq(TASK_FILTER_TYPES, ["0", "8"]);
  assert(Object.isFrozen(TASK_FILTER_TYPES));
  for (const filterType of ["0", "8", 0, 8]) {
    eq(taskOptions({ filterType }).map(shape), [
      ["AirSync:FilterType", String(filterType)],
      ["AirSyncBase:BodyPreference", [["AirSyncBase:Type", "1"], ["AirSyncBase:TruncationSize", String(BODY_TRUNCATION_BYTES)]]],
    ]);
  }
  // 1 to 7 are periods of mail and calendars ([MS-ASCMD] 2.2.3.68.2).
  for (const filterType of ["1", "2", "3", "4", "5", "6", "7", "9", "", "08", " 8", 7, 8.5, NaN, null, undefined, true, {}, ["8"]]) {
    throws(() => taskOptions({ filterType }), ProtocolError, `filter ${String(filterType)}`);
  }
  throws(() => taskOptions(), ProtocolError);
  const request = syncRequest([{ collectionId: "9", syncKey: "1", options: taskOptions({ filterType: "8" }) }]);
  assert(encode(request).length > 20, "the options encode");
});

// ── Reading ───────────────────────────────────────────────────────────────

test("task-item: the tasks of [MS-ASTASK] 4.2 and 4.3", () => {
  const changed = read([
    A("Body", [A("Type", "3"), A("EstimatedDataSize", "5731"), A("Truncated", "1")]),
    T("Subject", "Finish Q4 sales roll-up"),
    T("Importance", "1"),
    T("UtcStartDate", "2008-10-02T07:00:00.000Z"),
    T("StartDate", "2008-10-02T00:00:00.000Z"),
    T("UtcDueDate", "2008-10-10T07:00:00.000Z"),
    T("DueDate", "2008-10-10T00:00:00.000Z"),
    T("Complete", "0"),
    T("Sensitivity", "0"),
    T("ReminderTime", "2008-10-10T19:30:00.000Z"),
    T("ReminderSet", "1"),
  ]);
  // The example asked for no plain text: its body came as RTF, truncated. The description does not hold it.
  eq(changed, task({ summary: "Finish Q4 sales roll-up", start: "2008-10-02", due: "2008-10-10", reminderAt: "2008-10-10T19:30:00Z", readOnly: "incomplete" }));
  assert(deepFrozen(changed), "deeply frozen");
  const fetched = read([
    A("Body", [A("Type", "1"), A("EstimatedDataSize", "0")]),
    T("Subject", "Complete This Week's Test Run "),
    T("Importance", "2"),
    T("UtcStartDate", "2009-11-18T08:00:00.000Z"),
    T("StartDate", "2009-11-18T00:00:00.000Z"),
    T("UtcDueDate", "2009-11-27T08:00:00.000Z"),
    T("DueDate", "2009-11-27T00:00:00.000Z"),
    T("Complete", "0"),
    T("Sensitivity", "2"),
    T("ReminderTime", "2009-11-27T16:00:00.000Z"),
    T("ReminderSet", "1"),
  ]);
  eq(fetched, task({ summary: "Complete This Week's Test Run ", priority: "high", privacy: "private", start: "2009-11-18", due: "2009-11-27", reminderAt: "2009-11-27T16:00:00Z" }));
});

test("task-item: a bare task takes every default, and its uid from the caller", () => {
  eq(read([]), task());
  eq(read([T("Subject"), T("Categories"), T("StartDate"), T("DueDate"), T("Importance"), T("Sensitivity"), T("Complete"), T("ReminderSet"), T("ReminderTime"), A("Body")]), task());
  eq(read([T("Subject", "x")], { fallbackUid: "9-9:1@sync443" }).uid, "9-9:1@sync443");
  // A task has no UID on the server: without one from the caller it cannot be described.
  for (const fallbackUid of [undefined, null, "", "x".repeat(301), `a${ch(0x202e)}b`, `a${ch(0x0a)}b`, 42, ["x"]]) {
    throws(() => readTask(received([T("Subject", "x")]), { version: "14.1", fallbackUid }), isBadItem, String(fallbackUid).slice(0, 20));
  }
  throws(() => readTask(received([])), ProtocolError, "no options");
  for (const version of [undefined, "2.5", "16.1", 14.1]) throws(() => readTask(received([]), { version, fallbackUid: "x" }), hasCode("BAD_VERSION"), String(version));
  for (const version of PROTOCOL_VERSIONS) eq(readTask(received([]), { version, fallbackUid: "task-1" }), task(), version);
  for (const bad of [null, undefined, "data", {}, []]) throws(() => readTask(bad, { version: "14.1", fallbackUid: "x" }), isBadItem, String(bad));
});

test("task-item: start and due are the days of the local elements", () => {
  const days = (...children) => {
    const description = read(children);
    return [description.start, description.due];
  };
  // Local midnight in Sydney is the previous day in UTC: the local element says which day it is.
  eq(days(T("StartDate", "2026-03-10T00:00:00.000Z"), T("UtcStartDate", "2026-03-09T13:00:00.000Z"), T("DueDate", "2026-03-12T00:00:00.000Z"), T("UtcDueDate", "2026-03-11T13:00:00.000Z")), ["2026-03-10", "2026-03-12"]);
  eq(days(T("StartDate", "2026-03-10T09:30:00.000Z"), T("DueDate", "2026-03-10T23:59:59.000Z")), ["2026-03-10", "2026-03-10"], "the time of day is dropped");
  eq(days(T("StartDate", "2026-03-10T00:00:00Z")), ["2026-03-10", null], "milliseconds are optional");
  eq(days(T("DueDate", "2026-03-12T00:00:00.000Z")), [null, "2026-03-12"]);
  // Only the UTC element of a pair: its day is taken.
  eq(days(T("UtcStartDate", "2026-03-10T08:00:00.000Z"), T("UtcDueDate", "2026-03-12T08:00:00.000Z")), ["2026-03-10", "2026-03-12"]);
  // A local element that cannot be read falls back on the UTC one, then on nothing.
  eq(days(T("StartDate", "garbage"), T("UtcStartDate", "2026-03-10T08:00:00.000Z")), ["2026-03-10", null]);
  for (const bad of ["", "2026-03-10", "20260310T000000Z", "2026-02-30T00:00:00.000Z", "2026-03-10T24:00:00.000Z", "1899-12-31T00:00:00.000Z", "2201-01-01T00:00:00.000Z", "2026-03-10T00:00:00.0Z", "2026-03-10 00:00:00", " 2026-03-10T00:00:00.000Z", "today"]) {
    eq(days(T("StartDate", bad), T("DueDate", bad)), [null, null], JSON.stringify(bad));
  }
  // A start after the due date is left out.
  eq(days(T("StartDate", "2026-03-13T00:00:00.000Z"), T("DueDate", "2026-03-12T00:00:00.000Z")), [null, "2026-03-12"]);
  eq(days(T("StartDate", "2026-03-12T00:00:00.000Z"), T("DueDate", "2026-03-12T00:00:00.000Z")), ["2026-03-12", "2026-03-12"]);
});

test("task-item: a completed task has its completion date, or is refused", () => {
  const done = read([T("Complete", "1"), T("DateCompleted", "2026-03-11T15:45:10.000Z")]);
  eq([done.completed, done.completedAt], [true, "2026-03-11T15:45:10Z"]);
  throws(() => read([T("Complete", "1")]), isBadItem, "Complete without DateCompleted");
  for (const bad of ["", "2026-03-11", "20260311T154510Z", "2026-02-30T00:00:00.000Z", "yesterday"]) {
    throws(() => read([T("Complete", "1"), T("DateCompleted", bad)]), isBadItem, `DateCompleted ${JSON.stringify(bad)}`);
  }
  // Not completed: a date left behind says nothing.
  const open = read([T("Complete", "0"), T("DateCompleted", "2026-03-11T15:45:10.000Z")]);
  eq([open.completed, open.completedAt], [false, null]);
  for (const other of ["2", "", "true", "01", "yes"]) eq(read([T("Complete", other), T("DateCompleted", "2026-03-11T15:45:10.000Z")]).completed, false, `Complete ${other}`);
  eq(read([T("DateCompleted", "2026-03-11T15:45:10.000Z")]).completed, false);
});

test("task-item: enumerations take their default out of range", () => {
  eq(["0", "1", "2"].map((code) => read([T("Importance", code)]).priority), ["low", "normal", "high"]);
  eq(["0", "1", "2", "3"].map((code) => read([T("Sensitivity", code)]).privacy), ["public", "private", "private", "confidential"]);
  for (const out of ["3", "255", "-1", "", "02", "high", "__proto__", "constructor"]) {
    eq(read([T("Importance", out)]).priority, "normal", `Importance ${JSON.stringify(out)}`);
    eq(read([T("Sensitivity", out === "3" ? "4" : out)]).privacy, "public", `Sensitivity ${JSON.stringify(out)}`);
  }
});

test("task-item: a reminder counts only when it is set and its time can be read", () => {
  const reminder = (...children) => read(children).reminderAt;
  eq(reminder(T("ReminderSet", "1"), T("ReminderTime", "2026-03-11T08:00:00.000Z")), "2026-03-11T08:00:00Z");
  eq(reminder(T("ReminderSet", "0"), T("ReminderTime", "2026-03-11T08:00:00.000Z")), null);
  eq(reminder(T("ReminderTime", "2026-03-11T08:00:00.000Z")), null, "ReminderSet absent: not set");
  eq(reminder(T("ReminderSet", "1")), null);
  for (const bad of ["", "2026-03-11", "20260311T080000Z", "2026-13-11T08:00:00.000Z", "soon"]) eq(reminder(T("ReminderSet", "1"), T("ReminderTime", bad)), null, bad);
  for (const other of ["2", "", "true"]) eq(reminder(T("ReminderSet", other), T("ReminderTime", "2026-03-11T08:00:00.000Z")), null, `ReminderSet ${other}`);
});

test("task-item: texts are cleaned and cut, lists are cut, only a plain body is read", () => {
  const dirty = `a${ch(0x01)}b${ch(0x1b)}c${ch(0x202e)}d${ch(0x2066)}e${ch(0x200b)}f`;
  const description = read([
    T("Subject", `${dirty}\r\nline two${"s".repeat(2000)}`),
    body("1", `${dirty}\r\nsecond${ch(0x2028)}third${"d".repeat(40_000)}`),
    T("Categories", [T("Category", ` ${dirty}\n `), T("Category", ""), T("Category", "Work"), T("Category", "Work"), ...Array.from({ length: 10_000 }, (_, i) => T("Category", `Category ${i}`))]),
  ]);
  eq(description.summary.length, 1024);
  assert(description.summary.startsWith("abcdef line two"), "one line");
  eq(description.description.length, 32768);
  assert(description.description.startsWith("abcdef\nsecond\nthird"));
  eq(description.categories.length, 50);
  eq(description.categories.slice(0, 3), ["abcdef", "Work", "Category 0"]);
  eq(read([body("2", "<b>html</b>")]).description, "", "HTML is never read");
  eq(read([body("3", "e1xydGYxfQ==")]).description, "");
  eq(read([body("2", "<b>html</b>"), body("1", "plain")]).description, "plain");
  // Elements of other classes are not the task's.
  eq(read([el("Calendar:Subject", "calendar"), el("Email:Subject", "mail"), el("Calendar:UID", "uid"), el("Calendar:Categories", [el("Calendar:Category", "x")])]), task());
  eq(read([T("Categories", [el("Calendar:Category", "not a task category"), T("Subject", "nor this")])]).categories, []);
});

test("task-item: the joiner and the non-joiner stay in the content of a task, any other invisible character makes it incomplete", () => {
  const subject = `${FAMILY} ${PERSIAN}`;
  const description = read([T("Subject", subject), body("1", `${PERSIAN}\r\n${FAMILY}`), T("Categories", [T("Category", FAMILY), T("Category", PERSIAN)])]);
  eq([description.summary, description.description, description.categories, description.readOnly], [subject, `${PERSIAN}\n${FAMILY}`, [FAMILY, PERSIAN], null]);
  assert(description.summary.includes(ch(0x200d)) && description.summary.includes(ch(0x200c)), "both characters are there");
  eq(checkTask(description), description, "kept in what comes back from Thunderbird");
  const sent = written(description, { previous: description });
  eq([valueOf(sent, "Tasks:Subject"), valueOf(sent, "Tasks:Categories")], [subject, [["Tasks:Category", FAMILY], ["Tasks:Category", PERSIAN]]], "and sent back as they came");
  for (const hidden of HIDDEN) {
    const dirty = `Re${hidden}port`;
    const code = hidden.codePointAt(0).toString(16);
    for (const [where, children, pick] of [
      ["Subject", [T("Subject", dirty)], (d) => d.summary],
      ["the body", [body("1", dirty)], (d) => d.description],
      ["a category", [T("Categories", [T("Category", dirty)])], (d) => d.categories[0]],
    ]) {
      const lossy = read(children);
      eq([pick(lossy), lossy.readOnly], ["Report", "incomplete"], `U+${code} in ${where}`);
      throws(() => written(lossy, { previous: lossy }), hasCode("READ_ONLY_ITEM"), `U+${code} in ${where}: never written back`);
    }
  }
  // Control characters, and a tab or a line break in one line, go without a mark.
  const controls = [0x01, 0x08, 0x0b, 0x1f, 0x7f, 0x80, 0x9f].map((i) => ch(i)).join("");
  const cleaned = read([T("Subject", `Re${controls}port\tof\r\nMarch`), body("1", `No${controls}tes\r\nline\ttwo`), T("Categories", [T("Category", ` Wo${controls}rk `)])]);
  eq([cleaned.summary, cleaned.description, cleaned.categories, cleaned.readOnly], ["Report of March", "Notes\nline\ttwo", ["Work"], null]);
});

test("task-item: bytes that are not UTF-8 are a loss", () => {
  const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
  for (const [where, children, pick] of [
    ["Subject", [T("Subject", bytes)], (d) => d.summary],
    ["the body", [body("1", bytes)], (d) => d.description],
    ["a category", [T("Categories", [T("Category", bytes)])], (d) => d.categories[0]],
  ]) {
    const description = read(children);
    eq([pick(description), description.readOnly], [`caf${ch(0xfffd)}`, "incomplete"], where);
    throws(() => written(description, { previous: description }), hasCode("READ_ONLY_ITEM"), `${where}: never sent back`);
  }
  for (const tag of ["OrdinalDate", "SubOrdinalDate", "Importance"]) eq(read([T(tag, bytes)]).readOnly, "incomplete", tag);
  eq(read([T("Subject", `a${ch(0xfffd)}b`)]), task({ summary: `a${ch(0xfffd)}b` }), "a replacement character the server wrote is its text");
  // From Thunderbird's side a lone surrogate hides nothing behind it.
  eq(checkTask(task({ summary: `a${ch(0xd800, 0xfeff)}b`, categories: [`a${ch(0xdc00, 0xffff)}b`] })), task({ summary: `a${ch(0xfffd)}b`, categories: [`a${ch(0xfffd)}b`] }));
});

test("task-item: a Change without a Body does not say that the text is gone", () => {
  const changed = (children) => read(children, { change: true });
  eq(changed([T("Subject", "Report")]), task({ summary: "Report", description: null }), "the server does not say");
  eq(read([T("Subject", "Report")]).description, "", "an Add without a Body has no text");
  for (const notTrue of [false, 1, "true", {}, null, undefined]) eq(read([], { change: notTrue }).description, "", `change: ${String(notTrue)}`);
  // With a Body, a Change is read as an Add is.
  eq(changed([body("1", "New text")]).description, "New text");
  eq(changed([A("Body")]).description, "", "an empty Body: the text was removed");
  eq(changed([body("1")]).description, "");
  const html = changed([body("2", "<p>x</p>")]);
  eq([html.description, html.readOnly], ["", "incomplete"]);
  // Only a reader may say so. What comes from Thunderbird always has a text, and a null is never written.
  const description = changed([T("Subject", "Report")]);
  eq(description.readOnly, null);
  eq(checkTask(description, { fromServer: true }), description);
  throws(() => checkTask(description), isBadItem, "a null from Thunderbird");
  throws(() => checkTask(description, { fromServer: 1 }), isBadItem);
  throws(() => written(description), isBadItem);
  for (const other of [undefined, 42, [], {}]) throws(() => checkTask(task({ description: other }), { fromServer: true }), isBadItem, `fromServer accepts null only, not ${String(other)}`);
  assert(!names(written(held(description), { previous: held(description) })).includes("AirSyncBase:Body"), "held and written back unchanged: no body");
});

// ── Reading and writing: the ordering fields ──────────────────────────────

const ORDINAL = "2026-11-01T10:00:00.000Z";

test("task-item: OrdinalDate and SubOrdinalDate are carried as they came", () => {
  const description = read([T("Subject", "Report"), T("OrdinalDate", ORDINAL), T("SubOrdinalDate", "5555555")]);
  eq(description, { ...task({ summary: "Report" }), ordinalDate: ORDINAL, subOrdinalDate: "5555555" });
  eq(description.readOnly, null);
  assert(deepFrozen(description));
  // One without the other; a task without them has no such property at all.
  eq(read([T("OrdinalDate", ORDINAL)]), { ...task(), ordinalDate: ORDINAL });
  eq(read([T("SubOrdinalDate", "a b")]), { ...task(), subOrdinalDate: "a b" });
  eq(Object.keys(read([])), Object.keys(DEFAULTS));
  eq(read([T("OrdinalDate"), T("SubOrdinalDate")]), task(), "empty elements say nothing");
  // Any visible ASCII text of 1 to 40 characters, kept exactly: not parsed, not trimmed, not cleaned.
  for (const value of ["x", " ", " 2026 ", "2026-11-01T10:00:00Z", "~!@#$%^&*()_+{}|:\"<>?", "9".repeat(40)]) {
    const one = read([T("SubOrdinalDate", value), T("OrdinalDate", value)]);
    eq([one.ordinalDate, one.subOrdinalDate, one.readOnly], [value, value, null], JSON.stringify(value));
  }
  // Anything else cannot be carried: the task is incomplete, so that no Change erases the value.
  for (const [what, value] of [
    ["41 characters", "9".repeat(41)], ["megabytes", "9".repeat(1_000_000)], ["a letter that is not ASCII", "caf" + ch(0xe9)], ["a tab", `a${ch(0x09)}b`], ["a line break", `a${ch(0x0a)}b`],
    ["a control character", `a${ch(0x07)}b`], ["a DEL", `a${ch(0x7f)}b`], ["a joiner", `a${ch(0x200d)}b`], ["a right-to-left override", `a${ch(0x202e)}b`], ["an emoji", cp(0x1f600)],
    ["elements", [T("OrdinalDate", ORDINAL)]],
  ]) {
    for (const tag of ["OrdinalDate", "SubOrdinalDate"]) {
      const lossy = read([T(tag, value)]);
      eq([lossy.ordinalDate, lossy.subOrdinalDate, lossy.readOnly], [undefined, undefined, "incomplete"], `${tag}: ${what}`);
      throws(() => written(lossy, { previous: lossy }), hasCode("READ_ONLY_ITEM"), `${tag}: ${what}, never written back`);
    }
  }
  // Once each, like every element that is read.
  for (const tag of ["OrdinalDate", "SubOrdinalDate"]) throws(() => read([T(tag, "1"), T(tag, "1")]), isBadItem, `two ${tag}`);
});

test("task-item: a Change gives OrdinalDate and SubOrdinalDate back to the server", () => {
  const server = read([T("Subject", "Report"), T("OrdinalDate", ORDINAL), T("SubOrdinalDate", "5555555")]);
  const ordering = (elements) => [valueOf(elements, "Tasks:OrdinalDate"), valueOf(elements, "Tasks:SubOrdinalDate")];
  // Thunderbird has no use for them: what it gives back has none, and they come from `previous`.
  const local = task({ summary: "Report, changed", priority: "high" });
  eq(ordering(written(local, { previous: server })), [ORDINAL, "5555555"]);
  eq(ordering(written(local, { previous: { ...task(), subOrdinalDate: "x" } })), [undefined, "x"], "one alone");
  for (const version of PROTOCOL_VERSIONS) {
    const again = readTask(received(writeTask(local, { version, previous: server, zone: UTC_ZONE })), { version, fallbackUid: "task-1" });
    eq(again, { ...local, ordinalDate: ORDINAL, subOrdinalDate: "5555555" }, `${version}: sent, and read as before`);
  }
  // A description that has them itself gives them, and they win over `previous`.
  eq(ordering(written(server)), [ORDINAL, "5555555"]);
  eq(ordering(written({ ...local, ordinalDate: "A" }, { previous: server })), ["A", "5555555"]);
  // Without them anywhere, nothing is written: an Add made in Thunderbird, a task the server never ordered.
  eq(ordering(written(local)), [undefined, undefined]);
  eq(ordering(written(local, { previous: null })), [undefined, undefined]);
  eq(ordering(written(local, { previous: task() })), [undefined, undefined]);
  // A `previous` that is not a description, or whose values are not ordering values, gives nothing.
  for (const previous of ["x", 42, [], [ORDINAL], Object.create({ ordinalDate: ORDINAL, subOrdinalDate: "1" }), { ordinalDate: 42, subOrdinalDate: null }, { ordinalDate: "", subOrdinalDate: "9".repeat(41) }, { ordinalDate: `a${ch(0x0a)}b`, subOrdinalDate: `a${ch(0x202e)}b` }, { ordinalDate: ["1"], subOrdinalDate: { toString: () => "1" } }]) {
    eq(ordering(written(local, { previous })), [undefined, undefined], JSON.stringify(previous));
  }
});

test("task-item: checkTask accepts the two optional ordering fields, and nothing else there", () => {
  const checked = checkTask({ ...FULL, ordinalDate: ORDINAL, subOrdinalDate: "5555555" });
  eq(checked, { ...FULL, ordinalDate: ORDINAL, subOrdinalDate: "5555555" });
  eq(Object.keys(checked), [...Object.keys(DEFAULTS), "ordinalDate", "subOrdinalDate"]);
  assert(deepFrozen(checked));
  eq(checkTask(checked), checked);
  // Absent, or null, is "none": the copy then has no such property.
  eq(Object.keys(checkTask({ ...FULL, ordinalDate: null, subOrdinalDate: undefined })), Object.keys(DEFAULTS));
  eq(Object.keys(checkTask({ ...FULL, subOrdinalDate: "1" })), [...Object.keys(DEFAULTS), "subOrdinalDate"]);
  // A value is taken as it is or refused: never cleaned, never cut.
  for (const key of ["ordinalDate", "subOrdinalDate"]) {
    for (const bad of ["", "9".repeat(41), `a${ch(0x09)}b`, `a${ch(0x0a)}b`, `a${ch(0)}b`, `a${ch(0x7f)}b`, `a${ch(0xe9)}`, `a${ch(0x200d)}b`, `a${ch(0x202e)}b`, cp(0x1f600), ch(0xd800), 42, 0, false, true, [], ["1"], {}, { toString: () => "1" }]) {
      throws(() => checkTask({ ...FULL, [key]: bad }), isBadItem, `${key} = ${typeof bad === "string" ? JSON.stringify(bad.slice(0, 8)) : String(bad)}`);
    }
    eq(checkTask({ ...FULL, [key]: "9".repeat(40) })[key], "9".repeat(40));
    throws(() => checkTask(Object.assign(Object.create({ [key]: "inherited" }), FULL, { [key]: 42 })), isBadItem);
    eq(checkTask(Object.assign(Object.create({ [key]: "inherited" }), FULL))[key], undefined, "an inherited value is no value");
  }
  // The reason names the field, never its content.
  const reason = throws(() => checkTask({ ...FULL, subOrdinalDate: `Secret${ch(0x0a)}` }), isBadItem).message;
  assert(reason.includes("subOrdinalDate") && !reason.includes("Secret"), reason);
});

test("task-item: an element sent twice makes the task invalid", () => {
  for (const tag of ["Subject", "Importance", "UtcStartDate", "StartDate", "UtcDueDate", "DueDate", "Categories", "Recurrence", "Complete", "DateCompleted", "Sensitivity", "ReminderTime", "ReminderSet"]) {
    throws(() => read([T(tag, "1"), T(tag, "1")]), isBadItem, `two ${tag}`);
  }
  throws(() => read([T("Complete", "0"), T("Complete", "1"), T("DateCompleted", "2026-03-11T15:45:10.000Z")]), isBadItem, "no way to choose");
});

// ── Reading: recurrence ───────────────────────────────────────────────────

const dated = [T("StartDate", "2026-03-10T00:00:00.000Z"), T("UtcStartDate", "2026-03-10T00:00:00.000Z"), T("DueDate", "2026-03-12T00:00:00.000Z"), T("UtcDueDate", "2026-03-12T00:00:00.000Z")];
const recurring = (...fields) => read([...dated, T("Recurrence", fields)]);

test("task-item: a recurring task", () => {
  const description = recurring(T("Type", "1"), T("Start", "2026-03-10T00:00:00.000Z"), T("Until", "2026-12-29T00:00:00.000Z"), T("Interval", "2"), T("DayOfWeek", "4"), T("Regenerate", "0"), T("DeadOccur", "0"), T("FirstDayOfWeek", "1"));
  eq(description, task({ start: "2026-03-10", due: "2026-03-12", recurrence: rule({ freq: "weekly", interval: 2, until: "2026-12-29", byDay: ["TU"], weekStart: "MO" }) }));
  eq(recurring(T("Type", "2"), T("DayOfMonth", "10"), T("Occurrences", "255")).recurrence, rule({ freq: "monthly", byMonthDay: 10, count: 255 }));
  eq(recurring(T("Type", "3"), T("WeekOfMonth", "5"), T("DayOfWeek", "127")).recurrence, rule({ freq: "monthly", byDay: [...WEEKDAYS], bySetPos: -1 }));
  for (const fields of [[], [T("Type", "4")], [T("Type", "1")], [T("Type", "0"), T("Occurrences", "256")], [T("Type", "0"), T("Start", "20260310T000000Z")], [T("Type", "0"), T("Regenerate", "2")], [T("Type", "2"), T("DayOfMonth", "1"), T("DayOfMonth", "2")]]) {
    throws(() => recurring(...fields), isBadRecurrence, JSON.stringify(fields.map(shape)));
  }
  // A calendar recurrence inside a task is not a task recurrence.
  assert(read([...dated, el("Calendar:Recurrence", [el("Calendar:Type", "0")])]).recurrence === null);
});

test("task-item: a regenerating task is read-only, a dead occurrence is not recurring", () => {
  const weekly = [T("Type", "1"), T("DayOfWeek", "4"), T("Start", "2026-03-10T00:00:00.000Z")];
  const facts = (description) => [description.recurrence, description.readOnly];
  eq(facts(recurring(...weekly, T("Regenerate", "1"))), [null, "regenerating"]);
  // Not recurring, and read-only: the pattern it still carries is not in the description.
  eq(facts(recurring(...weekly, T("DeadOccur", "1"))), [null, "incomplete"]);
  eq(facts(recurring(...weekly, T("DeadOccur", "200"), T("Regenerate", "1"))), [null, "incomplete"]);
  eq(facts(recurring(...weekly, T("CalendarType", "8"))), [null, "unsupported-recurrence"], "a Hebrew lunar recurrence");
  eq(facts(recurring(...weekly, T("IsLeapMonth", "1"))), [null, "unsupported-recurrence"]);
  eq(facts(recurring(...weekly, T("CalendarType", "1"))), [rule({ freq: "weekly", byDay: ["TU"] }), null]);
  // Read-only tasks are never written back: their recurrence would be erased.
  for (const readOnly of ["regenerating", "unsupported-recurrence", "incomplete"]) throws(() => written(task({ readOnly })), hasCode("READ_ONLY_ITEM"), readOnly);
  throws(() => written(recurring(...weekly, T("Regenerate", "1"))), hasCode("READ_ONLY_ITEM"));
  // A completed dead occurrence is a completed task, shown as it is.
  const dead = read([...dated, T("Complete", "1"), T("DateCompleted", "2026-03-11T10:00:00.000Z"), T("Recurrence", [...weekly, T("DeadOccur", "1")])]);
  eq([dead.completed, dead.recurrence, dead.readOnly], [true, null, "incomplete"]);
  throws(() => written(dead), hasCode("READ_ONLY_ITEM"));
});

test("task-item: a recurrence needs a day to count from", () => {
  const daily = [T("Type", "0")];
  // Neither start nor due: the Start of the recurrence gives it.
  const fromStart = read([T("Recurrence", [...daily, T("Start", "2026-03-10T00:00:00.000Z")])]);
  eq([fromStart.start, fromStart.due, fromStart.recurrence, fromStart.readOnly], ["2026-03-10", null, rule({}), null]);
  // No day at all: the recurrence cannot be expressed.
  const none = read([T("Subject", "No dates"), T("Recurrence", daily)]);
  eq([none.start, none.due, none.recurrence, none.readOnly], [null, null, null, "unsupported-recurrence"]);
  // A due date alone is enough.
  const due = read([T("DueDate", "2026-03-12T00:00:00.000Z"), T("Recurrence", [...daily, T("Start", "2026-03-10T00:00:00.000Z")])]);
  eq([due.start, due.due, due.recurrence], [null, "2026-03-12", rule({})]);
});

test("task-item: a recurrence Thunderbird cannot be given is left out, and the task is shown once, read-only", () => {
  const dates = (start, due = start) => [T("StartDate", `${start}T00:00:00.000Z`), T("UtcStartDate", `${start}T00:00:00.000Z`), T("DueDate", `${due}T00:00:00.000Z`), T("UtcDueDate", `${due}T00:00:00.000Z`)];
  const monthly = (day, interval, ...more) => T("Recurrence", [T("Type", "2"), T("DayOfMonth", String(day)), T("Interval", String(interval)), ...more]);
  const daily = (interval = 1) => T("Recurrence", [T("Type", "0"), T("Interval", String(interval))]);
  const everyWeek = T("Recurrence", [T("Type", "1"), T("DayOfWeek", "4")]);
  const leftOut = (description, what) => {
    eq([description.recurrence, description.readOnly], [null, "unsupported-recurrence"], what);
    throws(() => written(description), hasCode("READ_ONLY_ITEM"), `${what}: never written back`);
  };
  // A day 29, 30 or 31 that none of the first four periods has.
  const blank = read([T("Subject", "Closing"), ...dates("2025-02-10"), monthly(31, 12)]);
  leftOut(blank, "day 31 every 12 months from February");
  eq([blank.summary, blank.start, blank.due], ["Closing", "2025-02-10", "2025-02-10"], "the task itself is still shown");
  leftOut(read([...dates("2025-02-10"), monthly(29, 24)]), "day 29 every 24 months from February 2025");
  leftOut(read([...dates("2025-06-10"), monthly(31, 5)]), "day 31 in June, November, April and September");
  eq(read([...dates("2025-03-10"), monthly(31, 12)]).recurrence, rule({ freq: "monthly", interval: 12, byMonthDay: 31 }), "from March");
  eq(read([...dates("2025-02-10"), monthly(31, 1)]).readOnly, null, "March has it");
  leftOut(read([...dates("2025-02-10"), T("Recurrence", [T("Type", "5"), T("DayOfMonth", "30"), T("MonthOfYear", "2")])]), "30 February");
  leftOut(read([...dates("2025-03-10"), T("Recurrence", [T("Type", "5"), T("DayOfMonth", "29"), T("MonthOfYear", "2"), T("Interval", "2")])]), "29 February every 2 years from 2025");
  // The first day is the start, or the due date of a task without a start, or the Start of the recurrence.
  leftOut(read([T("DueDate", "2025-02-10T00:00:00.000Z"), T("UtcDueDate", "2025-02-10T00:00:00.000Z"), monthly(31, 12)]), "due in February");
  eq(read([T("DueDate", "2025-03-10T00:00:00.000Z"), T("UtcDueDate", "2025-03-10T00:00:00.000Z"), monthly(31, 12)]).readOnly, null, "due in March");
  leftOut(read([monthly(31, 12, T("Start", "2025-02-10T00:00:00.000Z"))]), "no date but the Start of the recurrence, in February");
  eq(read([monthly(31, 12, T("Start", "2025-03-10T00:00:00.000Z"))]).readOnly, null);
  // A task longer, from start to due, than the period of its rule.
  eq(read([...dates("2026-03-10", "2026-03-11"), daily()]).readOnly, null, "one day, every day");
  leftOut(read([...dates("2026-03-10", "2026-03-12"), daily()]), "two days, every day");
  eq(read([...dates("2026-03-10", "2026-03-12"), daily(2)]).readOnly, null, "two days, every other day");
  eq(read([...dates("2026-03-10", "2026-03-17"), everyWeek]).readOnly, null, "seven days, every week");
  leftOut(read([...dates("2026-03-10", "2026-03-18"), everyWeek]), "eight days, every week");
  leftOut(read([...dates("1900-01-01", "2200-12-31"), daily()]), "three centuries, every day");
  eq(read([...dates("2026-03-01", "2026-03-31"), monthly(1, 1)]).recurrence, rule({ freq: "monthly", byMonthDay: 1 }), "from the 1st to the 31st, every month");
  leftOut(read([...dates("2026-03-01", "2026-04-02"), monthly(1, 1)]), "32 days, every month");
  eq(read([T("DueDate", "2200-12-31T00:00:00.000Z"), T("UtcDueDate", "2200-12-31T00:00:00.000Z"), daily()]).readOnly, null, "a due date alone is no length");
  // The reason stays, whatever else the description does not hold.
  eq(read([...dates("2025-02-10"), monthly(31, 12), T("Subject", "s".repeat(5000)), T("Sensitivity", "1")]).readOnly, "unsupported-recurrence");
});

test("task-item: checkTask refuses, in a description from Thunderbird, the recurrences a reader leaves out", () => {
  const refused = (fields, what) => {
    throws(() => checkTask(task(fields)), isBadRecurrence, what);
    throws(() => written(task(fields)), isBadRecurrence, `${what}: not written either`);
  };
  const every12 = rule({ freq: "monthly", interval: 12, byMonthDay: 31 });
  refused({ start: "2025-02-10", recurrence: every12 }, "day 31 every 12 months from February");
  refused({ due: "2025-02-10", recurrence: every12 }, "counted from the due date");
  refused({ start: "2025-02-10", due: "2025-03-10", recurrence: every12 }, "the start decides, not the due date");
  eq(checkTask(task({ start: "2025-03-10", due: "2025-03-20", recurrence: every12 })).recurrence, every12);
  eq(checkTask(task({ due: "2025-03-10", recurrence: every12 })).recurrence, every12);
  refused({ start: "2025-01-31", recurrence: rule({ freq: "yearly", byMonth: 2 }) }, "the 31st of the start, in February");
  refused({ start: "2025-03-10", recurrence: rule({ freq: "yearly", interval: 4, byMonth: 2, byMonthDay: 29 }) }, "29 February every 4 years from 2025");
  // Longer than the period of its rule.
  refused({ start: "2026-03-10", due: "2026-03-12", recurrence: rule({}) }, "two days, every day");
  eq(checkTask(task({ start: "2026-03-10", due: "2026-03-11", recurrence: rule({}) })).due, "2026-03-11");
  eq(checkTask(task({ start: "2026-03-10", due: "2026-03-12", recurrence: rule({ interval: 2 }) })).due, "2026-03-12");
  refused({ start: "2026-03-10", due: "2026-03-18", recurrence: rule({ freq: "weekly" }) }, "eight days, every week");
  refused({ start: "2026-03-10", due: "2026-04-11", recurrence: rule({ freq: "monthly" }) }, "32 days, every month");
  eq(checkTask(task({ start: "2026-03-10", due: "2026-04-10", recurrence: rule({ freq: "monthly" }) })).due, "2026-04-10", "31 days");
  eq(checkTask(task({ start: "2026-03-01", due: "2026-03-31", recurrence: rule({ freq: "monthly" }) })).due, "2026-03-31", "from the 1st to the 31st, every month");
  refused({ start: "1900-01-01", due: "2200-12-31", recurrence: rule({}) }, "three centuries, every day");
  eq(checkTask(task({ start: "1900-01-01", due: "2200-12-31" })).recurrence, null, "a long task that does not recur");
});

// ── Reading: a task that holds more than its description ──────────────────

const startsOn = (day) => [T("StartDate", `${day}T00:00:00.000Z`), T("UtcStartDate", `${day}T08:00:00.000Z`)];
const weeklyFrom = (...more) => T("Recurrence", [T("Type", "1"), T("DayOfWeek", "4"), ...more]);

/** Tasks of which the description holds less than the server: [what, children, version]. */
const LOSSY_TASKS = [
  ["a Subject of 1025 characters", [T("Subject", "s".repeat(1025))]],
  ["megabytes of Subject", [T("Subject", "é".repeat(1_000_000))]],
  ["elements where the Subject should be", [T("Subject", [T("Subject", "nested")])]],
  ["a right-to-left override in the Subject", [T("Subject", `report${ch(0x202e)}fdp.exe`)]],
  ["a zero-width space in the body", [body("1", `No${ch(0x200b)}tes`)]],
  ["a soft hyphen in a category", [T("Categories", [T("Category", `co${ch(0x00ad)}op`)])]],
  ["an OrdinalDate of 41 characters", [T("OrdinalDate", "9".repeat(41))]],
  ["a SubOrdinalDate that is not plain ASCII", [T("SubOrdinalDate", `caf${ch(0xe9)}`)]],
  ["a text longer than the description", [body("1", "d".repeat(32769))]],
  ["a text the server truncated", [A("Body", [A("Type", "1"), A("Truncated", "1"), A("Data", "beginning")])]],
  ["a body in HTML only", [body("2", "<b>Must</b> do")]],
  ["a body in RTF, truncated to nothing", [A("Body", [A("Type", "3"), A("EstimatedDataSize", "5731"), A("Truncated", "1")])]],
  ["51 categories", [T("Categories", Array.from({ length: 51 }, (_, i) => T("Category", `c${i}`)))]],
  ["10,000 categories", [T("Categories", Array.from({ length: 10_000 }, (_, i) => T("Category", `c${i}`)))]],
  ["an empty category", [T("Categories", [T("Category")])]],
  ["the same category twice", [T("Categories", [T("Category", "Work"), T("Category", "Work")])]],
  ["a category of 256 characters", [T("Categories", [T("Category", "c".repeat(256))])]],
  ["an Importance the description has no word for", [T("Importance", "3")]],
  ["Sensitivity 1, personal", [T("Sensitivity", "1")]],
  ["a Sensitivity that does not exist", [T("Sensitivity", "7")]],
  ["an unreadable Complete", [T("Complete", "yes")]],
  ["an unreadable ReminderSet", [T("ReminderSet", "2"), T("ReminderTime", "2026-03-11T08:00:00.000Z")]],
  ["a reminder that is set, without a time", [T("ReminderSet", "1")]],
  ["a reminder that is set, with an unreadable time", [T("ReminderSet", "1"), T("ReminderTime", "20260311T080000Z")]],
  ["a start date that cannot be read", [T("StartDate", "10 March 2026"), T("UtcStartDate", "soon")]],
  ["a due date in Compact DateTime", [T("DueDate", "20260312T000000Z")]],
  ["a start date with a time of day", [T("StartDate", "2026-03-10T09:00:00.000Z"), T("UtcStartDate", "2026-03-10T16:00:00.000Z")]],
  ["a due date of which only the UTC instant came", [T("UtcDueDate", "2026-03-12T08:00:00.000Z")]],
  ["a start after the due date", [...startsOn("2026-03-13"), T("DueDate", "2026-03-12T00:00:00.000Z")]],
  ["the pattern of a dead occurrence", [...startsOn("2026-03-10"), weeklyFrom(T("DeadOccur", "1"))]],
  ["a recurrence in a localized Gregorian calendar", [...startsOn("2026-03-10"), weeklyFrom(T("CalendarType", "9"))]],
  ["FirstDayOfWeek, which 14.0 cannot write back", [...startsOn("2026-03-10"), weeklyFrom(T("FirstDayOfWeek", "1"))], "14.0"],
  ["a recurrence that started before the task does now", [...startsOn("2026-03-17"), weeklyFrom(T("Start", "2026-03-10T00:00:00.000Z"), T("Occurrences", "5"))]],
];

/** Tasks that the description holds whole. */
const WHOLE_TASKS = [
  ["a bare task", []],
  ["empty elements", [T("Subject"), T("Categories"), T("StartDate"), T("UtcStartDate"), T("DueDate"), T("Importance"), T("Sensitivity"), T("Complete"), T("ReminderSet"), T("ReminderTime"), A("Body")]],
  ["texts cleaned of control characters, tabs and line breaks", [T("Subject", `a${ch(0x01, 0x85)}b\r\nline\ttwo`), body("1", `Notes${ch(0x07)}\r\nline two`), T("Categories", [T("Category", " Work ")])]],
  ["texts spelled with the zero-width joiner and non-joiner", [T("Subject", `${FAMILY} ${PERSIAN}`), body("1", PERSIAN), T("Categories", [T("Category", FAMILY)])]],
  ["the ordering values of another client", [T("Subject", "Report"), T("OrdinalDate", "2026-11-01T10:00:00.000Z"), T("SubOrdinalDate", "5555555")]],
  ["texts exactly at their bounds", [T("Subject", "s".repeat(1024)), body("1", "d".repeat(32768)), T("Categories", Array.from({ length: 50 }, (_, i) => T("Category", `${i}`.padStart(255, "c"))))]],
  ["every value", [T("Importance", "2"), T("Sensitivity", "3"), ...startsOn("2026-03-10"), T("DueDate", "2026-03-12T00:00:00.000Z"), T("UtcDueDate", "2026-03-12T08:00:00.000Z"), T("Complete", "1"), T("DateCompleted", "2026-03-11T10:00:00.000Z"), T("ReminderSet", "1"), T("ReminderTime", "2026-03-11T08:00:00.000Z")]],
  ["local dates alone", [T("StartDate", "2026-03-10T00:00:00.000Z"), T("DueDate", "2026-03-12T00:00:00Z")]],
  ["a reminder time left behind by a reminder that is not set", [T("ReminderSet", "0"), T("ReminderTime", "2026-03-11T08:00:00.000Z")]],
  ["a completion date left behind by a task that is not completed", [T("Complete", "0"), T("DateCompleted", "2026-03-11T10:00:00.000Z")]],
  ["a recurrence that starts when the task does", [...startsOn("2026-03-10"), weeklyFrom(T("Start", "2026-03-10T00:00:00.000Z"), T("Regenerate", "0"), T("DeadOccur", "0"), T("CalendarType", "1"), T("FirstDayOfWeek", "0"))]],
  ["a recurrence without Start, as 14.0 servers send it", [...startsOn("2026-03-10"), weeklyFrom(T("Until", "4500-08-31T23:59:00.000Z"))], "14.0"],
  ["a plain body without data", [A("Body", [A("Type", "1"), A("EstimatedDataSize", "0")])]],
];

test("task-item: a task that holds more than its description is read-only, and cannot be written back", () => {
  for (const [what, children, version = "14.1"] of LOSSY_TASKS) {
    const description = readTask(received(children), { version, fallbackUid: "task-1" });
    eq(description.readOnly, "incomplete", what);
    eq(checkTask(description), description, `${what}: a valid description`);
    for (const target of PROTOCOL_VERSIONS) throws(() => writeTask(description, { version: target, zone: UTC_ZONE }), hasCode("READ_ONLY_ITEM"), `${what}: written in ${target}`);
    throws(() => writeTask(description, { version, previous: description }), hasCode("READ_ONLY_ITEM"), `${what}: written as a change`);
  }
  // The reasons that say more come first.
  eq(read([...startsOn("2026-03-10"), weeklyFrom(T("Regenerate", "1")), T("Subject", "s".repeat(5000))]).readOnly, "regenerating");
  eq(read([...startsOn("2026-03-10"), weeklyFrom(T("CalendarType", "8")), T("Sensitivity", "1")]).readOnly, "unsupported-recurrence");
});

test("task-item: a hostile, oversized task is read within the bounds, as incomplete, and never written back", () => {
  const hostile = read([
    T("Subject", "s".repeat(100_000)),
    body("1", "d".repeat(500_000)),
    T("Categories", Array.from({ length: 10_000 }, (_, i) => T("Category", `${i} `.padEnd(1000, "c")))),
    T("Importance", "255"),
    T("Sensitivity", "1"),
    T("StartDate", "2026-03-10T23:59:59.000Z"),
    T("UtcDueDate", "2026-03-12T08:00:00.000Z"),
    T("ReminderSet", "1"),
    T("ReminderTime", "never"),
    weeklyFrom(T("Start", "1999-01-01T00:00:00.000Z"), T("CalendarType", "12"), T("FirstDayOfWeek", "6")),
  ]);
  eq(hostile.readOnly, "incomplete");
  eq([hostile.summary.length, hostile.description.length, hostile.categories.length], [1024, 32768, 50]);
  eq([hostile.priority, hostile.privacy, hostile.start, hostile.due, hostile.reminderAt], ["normal", "private", "2026-03-10", "2026-03-12", null]);
  for (const version of PROTOCOL_VERSIONS) throws(() => writeTask(hostile, { version, zone: UTC_ZONE }), hasCode("READ_ONLY_ITEM"), version);
});

test("task-item: a task the description holds whole stays writable", () => {
  for (const [what, children, version = "14.1"] of WHOLE_TASKS) {
    const description = readTask(received(children), { version, fallbackUid: "task-1" });
    eq(description.readOnly, null, what);
    // Written back, it reads as the same thing: nothing was lost on the way.
    const again = readTask(received(writeTask(description, { version, zone: PACIFIC })), { version, fallbackUid: "task-1" });
    eq(again, description, `${what}: written and read again`);
  }
});

test("task-item: a task read from the server and written back unchanged asks the server to change nothing", () => {
  const bodiesIn = (elements) => elements.flatMap((e) => [...(e.ns === "AirSyncBase" && e.tag === "Body" ? [e] : []), ...bodiesIn(e.children)]);
  for (const [what, children, version = "14.1"] of WHOLE_TASKS) {
    const server = readTask(received(children), { version, fallbackUid: "task-1" });
    eq(server.readOnly, null, what);
    // What Thunderbird's side gives back when the user changed nothing: the same task, without the ordering
    // values, which it keeps with the description last synchronized only.
    const { ordinalDate, subOrdinalDate, ...local } = held(server);
    const sent = writeTask(local, { version, previous: held(server), zone: PACIFIC });
    eq(bodiesIn(sent).length, 0, `${what}: no text is sent, the server keeps the one it has`);
    // Everything else is what the server sent: read again, it is the same task.
    const again = readTask(received(sent), { version, fallbackUid: "task-1" });
    eq({ ...again, description: server.description }, server, `${what}: the same task`);
    eq([again.ordinalDate, again.subOrdinalDate], [ordinalDate, subOrdinalDate], `${what}: with the order it had`);
    // The texts that are sent are the server's, character for character.
    eq([valueOf(sent, "Tasks:Subject") ?? "", (valueOf(sent, "Tasks:Categories") ?? []).map(([, name]) => name)], [server.summary, server.categories], `${what}: the same texts`);
  }
  // The cases this property was once broken by, against the server's own bytes.
  const subject = `${FAMILY} ${PERSIAN}`;
  const joined = read([T("Subject", subject), T("Categories", [T("Category", PERSIAN)])]);
  const sentJoined = written(held(joined), { previous: held(joined) });
  eq([valueOf(sentJoined, "Tasks:Subject"), valueOf(sentJoined, "Tasks:Categories")], [subject, [["Tasks:Category", PERSIAN]]], "the joiner and the non-joiner are still there");
  const ordered = read([T("Subject", "Report"), T("OrdinalDate", "2026-11-01T10:00:00.000Z"), T("SubOrdinalDate", "5555555")]);
  const sentOrdered = written(task({ summary: "Report" }), { previous: ordered });
  eq([valueOf(sentOrdered, "Tasks:OrdinalDate"), valueOf(sentOrdered, "Tasks:SubOrdinalDate")], ["2026-11-01T10:00:00.000Z", "5555555"], "the order is not erased");
});

// ── Writing ───────────────────────────────────────────────────────────────

test("task-item: writeTask writes a simple task, and never a uid", () => {
  eq(written(task()).map(shape), [["Tasks:Importance", "1"], ["Tasks:Complete", "0"], ["Tasks:Sensitivity", "0"], ["Tasks:ReminderSet", "0"]]);
  const full = task({
    summary: "Report", description: "Line one\nline two", categories: ["Work", "Urgent"], privacy: "confidential", start: "2026-03-10", due: "2026-03-12",
    completed: true, completedAt: "2026-03-11T15:45:10Z", priority: "high", reminderAt: "2026-03-11T08:00:00Z",
  });
  eq(written(full).map(shape), [
    ["AirSyncBase:Body", [["AirSyncBase:Type", "1"], ["AirSyncBase:Data", "Line one\nline two"]]],
    ["Tasks:Subject", "Report"],
    ["Tasks:Importance", "2"],
    ["Tasks:UtcStartDate", "2026-03-10T00:00:00.000Z"],
    ["Tasks:StartDate", "2026-03-10T00:00:00.000Z"],
    ["Tasks:UtcDueDate", "2026-03-12T00:00:00.000Z"],
    ["Tasks:DueDate", "2026-03-12T00:00:00.000Z"],
    ["Tasks:Categories", [["Tasks:Category", "Work"], ["Tasks:Category", "Urgent"]]],
    ["Tasks:Complete", "1"],
    ["Tasks:DateCompleted", "2026-03-11T15:45:10.000Z"],
    ["Tasks:Sensitivity", "3"],
    ["Tasks:ReminderTime", "2026-03-11T08:00:00.000Z"],
    ["Tasks:ReminderSet", "1"],
  ]);
  for (const version of PROTOCOL_VERSIONS) {
    const all = (elements) => elements.flatMap((e) => [e.tag, ...all(e.children)]);
    const tags = all(writeTask({ ...full, uid: "secret-uid" }, { version, zone: UTC_ZONE }));
    for (const never of ["UID", "ClientUid", "Regenerate", "CalendarType", "IsLeapMonth", "OrdinalDate", "SubOrdinalDate"]) assert(!tags.includes(never), `${never} in ${version}`);
  }
  eq(["low", "normal", "high"].map((priority) => valueOf(written(task({ priority })), "Tasks:Importance")), ["0", "1", "2"]);
  eq(["public", "private", "confidential"].map((privacy) => valueOf(written(task({ privacy })), "Tasks:Sensitivity")), ["0", "2", "3"]);
});

test("task-item: both elements of a pair of dates are always sent together", () => {
  for (const start of [null, "2026-03-10"]) {
    for (const due of [null, "2026-03-12"]) {
      for (const zone of [UTC_ZONE, PACIFIC, SYDNEY, undefined]) {
        const list = names(writeTask(task({ start, due }), { version: "14.1", zone }));
        eq(list.includes("Tasks:StartDate"), start !== null, "StartDate");
        eq(list.includes("Tasks:UtcStartDate"), start !== null, "UtcStartDate with StartDate, never alone");
        eq(list.includes("Tasks:DueDate"), due !== null, "DueDate");
        eq(list.includes("Tasks:UtcDueDate"), due !== null, "UtcDueDate with DueDate, never alone");
      }
    }
  }
});

test("task-item: the UTC date is the local midnight of the day in the given zone", () => {
  const dates = (zone, start, due) => {
    const elements = written(task({ start, due }), { zone });
    return ["StartDate", "UtcStartDate", "DueDate", "UtcDueDate"].map((tag) => valueOf(elements, `Tasks:${tag}`));
  };
  eq(dates(PACIFIC, "2026-01-15", "2026-07-15"), ["2026-01-15T00:00:00.000Z", "2026-01-15T08:00:00.000Z", "2026-07-15T00:00:00.000Z", "2026-07-15T07:00:00.000Z"]);
  eq(dates(SYDNEY, "2026-01-15", "2026-07-15"), ["2026-01-15T00:00:00.000Z", "2026-01-14T13:00:00.000Z", "2026-07-15T00:00:00.000Z", "2026-07-14T14:00:00.000Z"]);
  eq(dates(UTC_ZONE, "2026-01-15", "2026-01-15"), ["2026-01-15T00:00:00.000Z", "2026-01-15T00:00:00.000Z", "2026-01-15T00:00:00.000Z", "2026-01-15T00:00:00.000Z"]);
  throws(() => written(task({ start: "2026-01-15" }), { zone: { bias: 9000 } }), hasCode("BAD_TIMEZONE"));
  throws(() => written(task({ start: "2026-01-15" }), { zone: "Europe/Paris" }), hasCode("BAD_TIMEZONE"));
});

test("task-item: without a zone, the UTC date is the local midnight on this computer", () => {
  for (const date of ["2026-01-15", "2026-07-15", "2028-02-29", "2026-03-29", "2026-10-25"]) {
    const elements = writeTask(task({ start: date, due: date }), { version: "14.1" });
    const [year, month, day] = date.split("-").map(Number);
    const expected = new Date(year, month - 1, day).getTime();
    eq(parseDateTime(valueOf(elements, "Tasks:UtcStartDate")), expected, `${date}: start`);
    eq(parseDateTime(valueOf(elements, "Tasks:UtcDueDate")), expected, `${date}: due`);
    eq(valueOf(elements, "Tasks:StartDate"), `${date}T00:00:00.000Z`);
    assert(Math.abs(expected - Date.UTC(year, month - 1, day)) <= 14 * 3_600_000, "within 14 hours of the day in UTC");
    eq(valueOf(writeTask(task({ start: date }), { version: "14.1", zone: null }), "Tasks:UtcStartDate"), valueOf(elements, "Tasks:UtcStartDate"), "zone null is no zone");
  }
});

test("task-item: DateCompleted goes with Complete, and DeadOccur with a completed recurring task", () => {
  const open = written(task({ start: "2026-03-10", recurrence: rule({ freq: "weekly" }) }));
  eq(valueOf(open, "Tasks:Complete"), "0");
  eq(valueOf(open, "Tasks:DateCompleted"), undefined);
  eq(valueOf(open, "Tasks:Recurrence"), [["Tasks:Type", "1"], ["Tasks:Start", "2026-03-10T00:00:00.000Z"], ["Tasks:Interval", "1"], ["Tasks:DayOfWeek", "4"], ["Tasks:DeadOccur", "0"]]);
  const done = written(task({ start: "2026-03-10", completed: true, completedAt: "2026-03-10T18:00:00Z", recurrence: rule({ freq: "weekly" }) }));
  eq(valueOf(done, "Tasks:Complete"), "1");
  eq(valueOf(done, "Tasks:DateCompleted"), "2026-03-10T18:00:00.000Z");
  eq(valueOf(done, "Tasks:Recurrence")[4], ["Tasks:DeadOccur", "1"], "marking a recurring task complete ([MS-ASTASK] 2.2.2.11)");
  // The recurrence starts from the start date, or from the due date.
  eq(valueOf(written(task({ due: "2026-03-12", recurrence: rule({ freq: "monthly" }) })), "Tasks:Recurrence"), [["Tasks:Type", "2"], ["Tasks:Start", "2026-03-12T00:00:00.000Z"], ["Tasks:Interval", "1"], ["Tasks:DayOfMonth", "12"], ["Tasks:DeadOccur", "0"]]);
  eq(valueOf(written(task({ start: "2026-03-10", due: "2026-03-12", recurrence: rule({ freq: "yearly", until: "2030-03-10", weekStart: "SU" }) })), "Tasks:Recurrence"), [
    ["Tasks:Type", "5"], ["Tasks:Start", "2026-03-10T00:00:00.000Z"], ["Tasks:Interval", "1"], ["Tasks:Until", "2030-03-10T00:00:00.000Z"], ["Tasks:DayOfMonth", "10"], ["Tasks:MonthOfYear", "3"], ["Tasks:FirstDayOfWeek", "0"], ["Tasks:DeadOccur", "0"],
  ]);
  assert(!shape(el("x", writeTask(task({ start: "2026-03-10", recurrence: rule({ freq: "weekly", weekStart: "SU" }) }), { version: "14.0", zone: UTC_ZONE })))[1].flat(3).includes("Tasks:FirstDayOfWeek"), "no FirstDayOfWeek before 14.1");
});

test("task-item: the body is sent only when the description changed", () => {
  const sent = (description, previous) => valueOf(written(task({ description }), previous === undefined ? {} : { previous }), "AirSyncBase:Body");
  const data = (value) => [["AirSyncBase:Type", "1"], ["AirSyncBase:Data", value]];
  eq(sent("New"), data("New"));
  eq(sent(""), undefined);
  eq(sent("Same", task({ description: "Same" })), undefined);
  eq(sent("New", task({ description: "Old" })), data("New"));
  eq(sent("", task({ description: "Old" })), data(""));
  eq(sent("Same", { description: 42 }), data("Same"));
});

test("task-item: everything written can be sent, as an Add and as a Change", () => {
  const full = task({
    summary: "Report", description: "Text", categories: ["Work"], privacy: "private", start: "2026-03-10", due: "2026-03-12", completed: true, completedAt: "2026-03-11T15:45:10Z",
    priority: "low", reminderAt: "2026-03-11T08:00:00Z", recurrence: rule({ freq: "yearly", byMonth: 3, byDay: ["TU"], bySetPos: 2, until: "2030-03-12", weekStart: "MO" }),
  });
  for (const version of PROTOCOL_VERSIONS) {
    const data = writeTask(full, { version, zone: PACIFIC });
    for (const command of [addCommand("c-1", data), changeCommand("9:1", data)]) {
      assert(encode(syncRequest([{ collectionId: "9", syncKey: "5", commands: [command] }])).length > 150, `${version} encodes`);
    }
  }
});

// ── Round trips ───────────────────────────────────────────────────────────

test("task-item: random tasks survive description → elements → WBXML → description", () => {
  const random = prng(9090);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const int = (min, max) => min + Math.floor(random() * (max - min + 1));
  const words = ["Rapport", "à", "rendre", "tâche", "日本語", "x", "Zoë"];
  const phrase = () => Array.from({ length: int(1, 4) }, () => pick(words)).join(" ");
  for (let i = 0; i < 900; i++) {
    const version = PROTOCOL_VERSIONS[i % 3];
    const startMs = Date.UTC(2021, 0, 1) + int(0, 4000) * DAY;
    const start = random() < 0.7 ? formatDate(startMs) : null;
    const due = random() < 0.7 ? formatDate(startMs + int(0, 30) * DAY) : null;
    const completed = random() < 0.4;
    const description = task({
      uid: `task-${int(0, 1e9)}`,
      summary: random() < 0.8 ? phrase() : "",
      description: random() < 0.5 ? `${phrase()}\n${phrase()}` : "",
      categories: [...new Set(Array.from({ length: int(0, 4) }, phrase))],
      privacy: pick(["public", "private", "confidential"]),
      start,
      due,
      completed,
      completedAt: completed ? formatUtc(startMs + int(0, 1e6) * 1000) : null,
      priority: pick(["low", "normal", "high"]),
      reminderAt: random() < 0.4 ? formatUtc(startMs + int(0, 1e6) * 1000) : null,
    });
    // A completed recurring task is sent as a dead occurrence, and read back as not recurring.
    if ((start !== null || due !== null) && !completed && random() < 0.5) {
      description.recurrence = rule({
        interval: int(1, 99),
        count: random() < 0.3 ? int(1, 255) : null,
        weekStart: version === "14.1" && random() < 0.5 ? pick(WEEKDAYS) : null,
        ...pick([
          {},
          { freq: "weekly", byDay: [pick(WEEKDAYS)] },
          { freq: "monthly", byMonthDay: int(1, 31) },
          { freq: "monthly", byDay: [pick(WEEKDAYS)], bySetPos: pick([1, 2, 3, 4, -1]) },
          { freq: "yearly", byMonth: int(1, 12), byMonthDay: int(1, 28) },
          { freq: "yearly", byMonth: int(1, 12), byDay: [pick(WEEKDAYS)], bySetPos: pick([1, 2, 3, 4, -1]) },
        ]),
      });
      if (description.recurrence.count === null && random() < 0.5) description.recurrence.until = formatDate(startMs + int(1, 3000) * DAY);
      // Within the rules of a recurrence: a day number that comes (every month has it, or one of the next
      // three), and a task no longer than the period of its rule (exactly as long, when it was longer).
      const r = description.recurrence;
      if (r.freq === "monthly" && r.byMonthDay > 28) r.interval = 1;
      const period = r.interval * { daily: 1, weekly: 7, monthly: 31, yearly: 366 }[r.freq];
      if (start !== null && due !== null && (Date.parse(due) - Date.parse(start)) / DAY > period) description.due = formatDate(startMs + period * DAY);
    }
    const zone = pick([UTC_ZONE, PACIFIC, SYDNEY]);
    const back = readTask(received(writeTask(description, { version, zone })), { version, fallbackUid: description.uid });
    eq(back, checkTask(description), `${version} #${i} ${JSON.stringify(description)}`);
    assert(deepFrozen(back), "frozen");
  }
});

// ── Fuzzing ───────────────────────────────────────────────────────────────

test("task-item: random tasks are read into a valid description, or refused with a ProtocolError", () => {
  const random = prng(3141);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const tags = [
    "Categories", "Category", "Complete", "DateCompleted", "DueDate", "UtcDueDate", "Importance", "Recurrence", "Type", "Start", "Until", "Occurrences",
    "Interval", "DayOfMonth", "DayOfWeek", "WeekOfMonth", "MonthOfYear", "Regenerate", "DeadOccur", "ReminderSet", "ReminderTime", "Sensitivity",
    "StartDate", "UtcStartDate", "Subject", "CalendarType", "IsLeapMonth", "FirstDayOfWeek", "OrdinalDate", "SubOrdinalDate",
  ];
  const texts = [
    "", "0", "1", "2", "3", "5", "8", "62", "127", "255", "256", "-1", "x", "2026-03-10T00:00:00.000Z", "2026-03-12T00:00:00.000Z", "2026-03-09T13:00:00Z",
    "2026-02-30T00:00:00.000Z", "4500-08-31T23:59:00.000Z", "20260310T000000Z", "é".repeat(700), `x${ch(0x202e)}y${ch(0x07)}z`, "__proto__",
  ];
  const node = (depth) => {
    const tag = pick(tags);
    if (depth < 2 && random() < 0.25) return T(tag, Array.from({ length: Math.floor(random() * 5) }, () => node(depth + 1)));
    return random() < 0.1 ? T(tag) : T(tag, pick(texts));
  };
  let described = 0;
  let refused = 0;
  for (let i = 0; i < 3000; i++) {
    const children = Array.from({ length: Math.floor(random() * 7) }, () => node(0));
    if (random() < 0.3) children.push(T("Recurrence", [T("Type", pick(["0", "1", "2"])), T("DayOfWeek", "4"), node(1)]));
    if (random() < 0.3) children.push(T("StartDate", "2026-03-10T00:00:00.000Z"));
    const version = PROTOCOL_VERSIONS[i % 3];
    let description;
    try {
      description = readTask(received(children), { version, fallbackUid: "task-1" });
    } catch (e) {
      assert(e instanceof ProtocolError && typeof e.code === "string", `#${i}: ${e?.name}: ${e?.message}`);
      refused++;
      continue;
    }
    described++;
    eq(checkTask(description, { fromServer: true }), description, `#${i}: what is read passes the check`);
    eq(checkTask(description), description, `#${i}: and, an Add always having a text, the check of what comes from Thunderbird`);
    assert(deepFrozen(description), "frozen");
    if (description.readOnly !== null) {
      throws(() => writeTask(description, { version, zone: PACIFIC }), hasCode("READ_ONLY_ITEM"));
      continue;
    }
    // What was read can be written, sent, and read again as the same thing.
    const again = readTask(received(writeTask(description, { version, zone: PACIFIC })), { version, fallbackUid: "task-1" });
    // A completed recurring task is sent as a dead occurrence, which reads back without its pattern, read-only.
    const dead = description.completed && description.recurrence !== null;
    eq(again, { ...description, recurrence: dead ? null : description.recurrence, readOnly: dead ? "incomplete" : null }, `#${i}: written and read again`);
    // Written back unchanged, as a Change: the same elements, without the text, which the server keeps.
    const unchanged = writeTask(description, { version, previous: description, zone: PACIFIC });
    eq(unchanged.map(shape), writeTask(description, { version, zone: PACIFIC }).filter((e) => e.tag !== "Body").map(shape), `#${i}: unchanged, nothing but the text is left out`);
  }
  assert(described > 500 && refused > 500, `both outcomes are exercised (${described} read, ${refused} refused)`);
});

test("task-item: a description with anything anywhere is checked, or refused with a ProtocolError", () => {
  const random = prng(2718);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const junk = () => pick([
    null, undefined, 0, -1, 1.5, NaN, Infinity, "", "x", "2026-03-10", "2026-03-11", "2026-03-10T17:00:00Z", "__proto__", "x".repeat(70_000), true, false,
    [], {}, [null], [[]], { a: 1 }, ["Work", "Home"], () => 1, Symbol("s"), new Date(0), Object.create(null), "low", "public", "weekly", "TU", 1, 5, 255, 256,
  ]);
  const paths = (value, prefix = []) => {
    if (value === null || typeof value !== "object") return [prefix];
    return [prefix, ...Object.keys(value).flatMap((key) => paths(value[key], [...prefix, Array.isArray(value) ? Number(key) : key]))];
  };
  const all = paths(FULL).filter((path) => path.length > 0);
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 6000; i++) {
    let description = JSON.parse(JSON.stringify(FULL));
    const path = pick(all);
    let at = description;
    for (const key of path.slice(0, -1)) at = at[key];
    if (random() < 0.15) delete at[path[path.length - 1]];
    else at[path[path.length - 1]] = junk();
    if (random() < 0.02) description = junk();
    let checked;
    try {
      checked = checkTask(description);
    } catch (e) {
      assert(e instanceof ProtocolError && typeof e.code === "string", `#${i}: ${e?.name}: ${e?.message}`);
      refused++;
      continue;
    }
    accepted++;
    assert(deepFrozen(checked), "frozen");
    eq(checkTask(checked), checked, `#${i}: checking twice changes nothing`);
    eq(JSON.parse(JSON.stringify(checked)), checked, `#${i}: plain data`);
    const data = writeTask(checked, { version: PROTOCOL_VERSIONS[i % 3], zone: SYDNEY });
    eq(readTask(received(data), { version: PROTOCOL_VERSIONS[i % 3], fallbackUid: checked.uid }).summary, checked.summary, `#${i}: written, sent and read`);
  }
  assert(accepted > 150 && refused > 3000, `both outcomes are exercised (${accepted} accepted, ${refused} refused)`);
  eq({}.polluted, undefined);
});

// ── checkTask ─────────────────────────────────────────────────────────────

const FULL = task({
  summary: "Report",
  description: "Text",
  categories: ["Work"],
  privacy: "private",
  start: "2026-03-10",
  due: "2026-03-12",
  completed: true,
  completedAt: "2026-03-11T15:45:10Z",
  priority: "high",
  reminderAt: "2026-03-11T08:00:00Z",
  recurrence: rule({ freq: "weekly", byDay: ["TU"], until: "2026-12-29" }),
});
const REMOVE = Symbol("remove");
function mutated(path, value) {
  const copy = JSON.parse(JSON.stringify(FULL));
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key];
  if (value === REMOVE) delete at[path[path.length - 1]];
  else at[path[path.length - 1]] = value;
  return copy;
}

test("task-item: checkTask returns a clean, deeply frozen copy", () => {
  const input = JSON.parse(JSON.stringify(FULL));
  const checked = checkTask(input);
  eq(checked, FULL);
  assert(checked !== input && deepFrozen(checked), "a deeply frozen copy");
  assert(!Object.isFrozen(input), "the input is untouched");
  eq(checkTask(checked), checked);
  eq(checkTask(task()), task(), "the simplest task");
  eq(Object.keys(checked), Object.keys(DEFAULTS), "the properties of the contract, in its order");
  eq(checkTask({ ...FULL, extra: 1, percent: 50, location: "x" }), FULL, "unknown properties are left out");
});

test("task-item: checkTask refuses every property that is missing, of the wrong type or out of range", () => {
  for (const key of Object.keys(DEFAULTS)) throws(() => checkTask(mutated([key], REMOVE)), ProtocolError, `without ${key}`);
  const wrong = [
    [["kind"], ["event", "TASK", "", null]],
    [["uid"], ["", "x".repeat(301), null, 42, `a${ch(0x0a)}b`, `a${ch(0)}b`, `a${ch(0x202e)}b`, ch(0xdc00)]],
    [["summary"], [null, 42, ["s"]]],
    [["description"], [null, 42]],
    [["categories"], [null, "Work", [1], [null], undefined]],
    [["privacy"], ["personal", "", null, 2, "__proto__"]],
    [["start"], ["2026-03-10T00:00:00Z", "20260310", "2026-02-30", "1899-12-31", "2201-01-01", "2026-3-10", 0, undefined, "2026-03-13"]],
    [["due"], ["2026-03-12T00:00:00Z", "2026-13-01", "tomorrow", 0, undefined, "2026-03-09"]],
    [["completed"], [0, 1, "true", null]],
    [["completed"], [false]], // with a completion date
    [["completedAt"], [null, "2026-03-11", "20260311T154510Z", "2026-03-11T15:45:10.000Z", 0, undefined]],
    [["priority"], ["urgent", "HIGH", "", null, 2, "constructor"]],
    [["reminderAt"], ["2026-03-11", "2026-03-11T08:00:00.000Z", "2026-03-11T24:00:00Z", 0, undefined]],
    [["recurrence"], ["FREQ=DAILY", [], {}, undefined]],
    [["recurrence", "count"], [256, 0]],
    [["recurrence", "until"], ["2026-12-29T00:00:00Z", "garbage"]],
    [["recurrence", "freq"], ["hourly"]],
    [["readOnly"], ["", "calendar-type", true, "yes", "Incomplete", undefined]],
  ];
  for (const [path, values] of wrong) {
    for (const value of values) {
      throws(() => checkTask(mutated(path, value)), ProtocolError, `${path.join(".")} = ${typeof value === "string" ? JSON.stringify(value.slice(0, 40)) : String(value)}`);
    }
  }
  for (const bad of [null, undefined, "task", 0, [], [FULL]]) throws(() => checkTask(bad), isBadItem, String(bad));
});

test("task-item: checkTask enforces the rules that hold between properties", () => {
  // due not before start.
  eq(checkTask(task({ start: "2026-03-10", due: "2026-03-10" })).due, "2026-03-10");
  throws(() => checkTask(task({ start: "2026-03-10", due: "2026-03-09" })), isBadItem, "due before start");
  // completedAt when, and only when, completed.
  throws(() => checkTask(task({ completed: true })), isBadItem, "completed without a date");
  throws(() => checkTask(task({ completedAt: "2026-03-11T15:45:10Z" })), isBadItem, "a completion date without completed");
  eq(checkTask(task({ completed: true, completedAt: "2026-03-11T15:45:10Z" })).completed, true);
  // A recurrence needs a start or a due date, counts to 255 and ends on a day.
  throws(() => checkTask(task({ recurrence: rule({}) })), isBadRecurrence, "a recurrence without any date");
  eq(checkTask(task({ due: "2026-03-12", recurrence: rule({}) })).recurrence, rule({}));
  throws(() => checkTask(task({ start: "2026-03-10", recurrence: rule({ count: 256 }) })), isBadRecurrence);
  throws(() => checkTask(task({ start: "2026-03-10", recurrence: rule({ until: "2026-12-29T00:00:00Z" }) })), isBadRecurrence);
  throws(() => checkTask(task({ start: "2026-03-10", recurrence: rule({ count: 3, until: "2026-12-29" }) })), isBadRecurrence);
  throws(() => checkTask(task({ start: "2026-03-10", recurrence: rule({ freq: "monthly", byDay: ["MO"] }) })), isBadRecurrence, "a rule ActiveSync cannot express");
  for (const readOnly of [null, "regenerating", "unsupported-recurrence", "incomplete"]) eq(checkTask(task({ readOnly })).readOnly, readOnly);
});

test("task-item: checkTask cleans texts, cuts lists, and hostile names do nothing", () => {
  const dirty = `a${ch(0)}b${ch(0x07)}c${ch(0x202e)}d`;
  const checked = checkTask(task({
    summary: `${dirty}\nline${"s".repeat(2000)}`,
    description: `${dirty}\r\nsecond${"d".repeat(40_000)}`,
    categories: [` ${dirty} `, "", "Work", "Work", ...Array.from({ length: 10_000 }, (_, i) => `Category ${i}`)],
  }));
  eq(checked.summary.length, 1024);
  assert(checked.summary.startsWith("abcd line"));
  eq(checked.description.length, 32768);
  assert(checked.description.startsWith("abcd\nsecond"));
  eq(checked.categories.length, 50);
  eq(checked.categories.slice(0, 3), ["abcd", "Work", "Category 0"]);
  const hostile = JSON.parse(JSON.stringify(FULL).replace("{", '{"__proto__":{"polluted":true,"kind":"task"},"constructor":{"prototype":{"polluted":true}},"hasOwnProperty":1,'));
  hostile.categories = ["__proto__", "constructor"];
  eq(checkTask(hostile), { ...FULL, categories: ["__proto__", "constructor"] });
  eq(Object.getPrototypeOf(checkTask(hostile)), Object.prototype);
  eq({}.polluted, undefined, "Object.prototype is untouched");
  throws(() => checkTask(Object.create(FULL)), isBadItem, "an inherited description");
  throws(() => checkTask(JSON.parse(`{"__proto__":${JSON.stringify(FULL)}}`)), isBadItem, "a description hidden in __proto__");
  // The reason of an error names a field, never its content.
  const reason = throws(() => checkTask(task({ uid: `Secret-Task${ch(0x0a)}`, summary: "Secret-Subject" })), isBadItem).message;
  assert(!reason.includes("Secret") && reason.length < 80, reason);
});
