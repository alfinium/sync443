// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Recurrences: the Recurrence element of calendar items ([MS-ASCAL]
 * 2.2.2.37) and of tasks ([MS-ASTASK] 2.2.2.20) ⇄ the Recurrence of the
 * item description (docs/CALENDAR-DESIGN.md), whose words are those of
 * RFC 5545:
 *
 *   { freq: "daily" | "weekly" | "monthly" | "yearly", interval: 1-999,
 *     count: 1-999 | null (tasks: 1-255), until: UTC | DATE | null,
 *     byDay: ["SU" … "SA"], bySetPos: -1 | 1-4 | null,
 *     byMonthDay: 1-31 | null, byMonth: 1-12 | null, weekStart: day | null }
 *
 *   Type 0  every n days                  daily
 *   Type 0  with DayOfWeek                weekly, byDay (Interval counts weeks)
 *   Type 1  weekly                        weekly, byDay
 *   Type 2  monthly, on a day number      monthly, byMonthDay
 *   Type 3  monthly, on the nth day       monthly, byDay + bySetPos (week 5 = -1, the last)
 *   Type 5  yearly, on a date             yearly, byMonth + byMonthDay
 *   Type 6  yearly, on the nth day        yearly, byMonth + byDay + bySetPos
 *
 * In Types 3 and 6 the days are a set and WeekOfMonth picks the nth day of
 * the month that belongs to it: 62 with 1 is the first weekday, 127 with 5
 * the last day of the month. That is what BYDAY with BYSETPOS means.
 *
 *   readRecurrence(node, { task, allDay, zone })  → { recurrence, readOnly, exact }
 *   writeRecurrence(recurrence, { version, task, start, allDay, zone })
 *                                                 → children of <Recurrence>
 *   checkRecurrence(value, { task, item })        → clean frozen copy
 *   recurrenceProblem(value, { task, item })      → null, or why it is refused
 *
 * Nothing is guessed. An element that is not what the protocol says (a
 * value out of the range its Type allows, a missing or doubled element)
 * throws a ProtocolError (code "BAD_RECURRENCE"): the caller quarantines
 * the item. A rule that breaks the rules below is never approximated:
 * read from a server, the item is given without it, read-only; coming from
 * Thunderbird, the local change is refused ("BAD_RECURRENCE").
 *
 * ── THE RULES OF A RECURRENCE ─────────────────────────────────────────────
 *
 * A Recurrence reaches Thunderbird only when it passes the five rules
 * below. They are stated here, once, and applied three times:
 *  - by the readers, to what a server sends (readRecurrence, then readEvent
 *    and readTask with the item): a rule that breaks one is left out, and
 *    the item is read-only, "unsupported-recurrence";
 *  - by checkRecurrence, to a description that comes from Thunderbird: the
 *    change is refused;
 *  - by the privileged module, which cannot import this file and applies
 *    them from this text to every description it is handed.
 * They are not about what ActiveSync can say only: in Thunderbird 140 a
 * rule outside rules 2 and 4 makes every event of its calendar vanish, or
 * never returns, and an item outside rule 5 yields tens of thousands of
 * occurrences for each query.
 *
 * Words. "The item" is the event or the task that carries the rule. Its
 * FIRST DAY is: for an all-day event, its `start` (a DATE); for a timed
 * event, the calendar day of `start` in the item's `timezone` (in UTC when
 * `timezone` is null); for a task, its `start`, or its `due` when it has
 * no start. A task without `start` and without `due` has no first day, and
 * no rule passes for it. A day is 86,400,000 ms.
 *
 *  1. Values. `freq` is "daily", "weekly", "monthly" or "yearly";
 *     `interval` is an integer from 1 to 999; `count` is null or an
 *     integer from 1 to 999 (for a task: 1 to 255); `until` is null, a
 *     DATE or (events only) a UTC instant; `count` and `until` are never
 *     both set; `byDay` is an array without holes of at most 7 distinct
 *     names among "SU" "MO" "TU" "WE" "TH" "FR" "SA"; `bySetPos` is null,
 *     -1 or an integer from 1 to 4; `byMonthDay` is null or an integer
 *     from 1 to 31; `byMonth` is null or an integer from 1 to 12;
 *     `weekStart` is null or one of the seven names.
 *
 *  2. Shape. For each `freq`, these combinations and no other:
 *       daily    bySetPos, byMonthDay and byMonth are null; byDay is
 *                empty, or not empty with interval 1 ("every weekday").
 *       weekly   bySetPos, byMonthDay and byMonth are null; byDay is empty
 *                (the weekday of the first day) or not.
 *       monthly  byMonth is null, and one of:
 *                a. byMonthDay set, byDay empty, bySetPos null;
 *                b. byMonthDay null, byDay not empty, bySetPos set;
 *                c. byMonthDay null, byDay empty, bySetPos null (the day
 *                   number of the first day).
 *       yearly   one of:
 *                a. byMonth set, byMonthDay set and one that month can
 *                   have (at most 29 in February, 30 in April, June,
 *                   September and November), byDay empty, bySetPos null;
 *                b. byMonth set, byMonthDay null, byDay not empty,
 *                   bySetPos set;
 *                c. byMonthDay null, byDay empty, bySetPos null (the date
 *                   of the first day; byMonth is null, or names the month).
 *
 *  3. The end is of the kind of the start. `until`, when set, is a DATE
 *     for an all-day event and for a task, a UTC instant for a timed
 *     event.
 *
 *  4. The day comes. Shapes a and c of a monthly and of a yearly rule
 *     recur on a day number: `byMonthDay` or, when it is null, the day
 *     number of the first day. A yearly rule also has a month: `byMonth`
 *     or, when it is null, the month of the first day. In shape c as in
 *     shape a, a yearly rule is refused when its day number is more than
 *     its month can have (2a).
 *     A day number of 29, 30 or 31 must exist in at least one of the first
 *     four periods of the rule, k = 0, 1, 2 and 3:
 *       monthly  the month that is k x interval months after the month of
 *                the first day;
 *       yearly   the month of the rule, in the year that is k x interval
 *                years after the year of the first day.
 *     Months have their real lengths: February has 29 days in a year that
 *     4 divides, unless 100 divides it and 400 does not.
 *     Refused, for instance: day 31 every 12 months from a February or an
 *     April; day 30 every 12 months from a February; day 29 every 24
 *     months from February 2025; 29 February every 2 years from 2025; and
 *     day 31 every 5 months from a June (June, November, April and
 *     September have 30 days), although a later period has that day:
 *     Thunderbird 140 looks at four periods and gives up.
 *
 *  5. No longer than its period. The length of the item is `end` minus
 *     `start` for an event (in ms between two instants; the number of days
 *     times 86,400,000 between two DATEs), and `due` minus `start` in days
 *     times 86,400,000 for a task that has both (0 otherwise). It is at
 *     most `interval` times 1 day for a daily rule, 7 days for a weekly
 *     one, 31 days for a monthly one, 366 days for a yearly one (the
 *     longest month and the longest year: a monthly task from the 1st that
 *     is due on the 31st passes). An item exactly as long as that passes;
 *     exceptions are not looked at.
 *
 * Rules 1 and 2 need the rule alone; rules 3, 4 and 5 need the item.
 *
 * A known difference, which is not a rule: ActiveSync puts "day 29, 30 or
 * 31" on the last day of a shorter month, where the rule Thunderbird is
 * given (BYMONTHDAY) skips that month.
 */

import { el, text } from "./wbxml.mjs";
import * as v from "./sanitize.mjs";
import { ProtocolError } from "./protocol.mjs";
import {
  UTC_ZONE,
  MAX_YEAR,
  checkZone,
  conversionError,
  localDateOf,
  localMidnightUtc,
  parseDate,
  parseUtc,
  parseCompact,
  parseDateTime,
  formatDate,
  formatUtc,
  formatCompact,
  formatDateTime,
} from "./eas-timezone.mjs";

/** Days of the week in the order of the DayOfWeek bits (1 = Sunday … 64 = Saturday) and of FirstDayOfWeek (0-6). */
export const WEEKDAYS = Object.freeze(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
/** Protocol versions the conversion modules write for. */
export const PROTOCOL_VERSIONS = Object.freeze(["12.1", "14.0", "14.1"]);

const FREQUENCIES = new Set(["daily", "weekly", "monthly", "yearly"]);
/** Longest month, to refuse a yearly date that never comes (30 February). */
const DAYS_IN_MONTH = Object.freeze([0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
/**
 * CalendarType values that are the Gregorian calendar ([MS-ASCAL]
 * 2.2.2.10): default, Gregorian, and its localized or transliterated
 * forms. Every other value, reserved ones included, is shown read-only.
 */
const GREGORIAN = new Set([0, 1, 2, 9, 10, 11, 12]);
/**
 * Those a server gives back the same when CalendarType is not sent: the
 * default, and Gregorian, which it may itself report as the default. The
 * localized forms have the same dates, but written back they would be
 * replaced by the default.
 */
const GREGORIAN_PLAIN = new Set([0, 1]);
/** A Recurrence has at most 14 different children: more is not a recurrence. */
const MAX_CHILDREN = 64;

const CALENDAR_ELEMENTS = new Set([
  "Type", "Occurrences", "Interval", "WeekOfMonth", "DayOfWeek", "MonthOfYear", "Until", "DayOfMonth",
  "CalendarType", "IsLeapMonth", "FirstDayOfWeek",
]);
const TASK_ELEMENTS = new Set([...CALENDAR_ELEMENTS, "Start", "Regenerate", "DeadOccur"]);
/** Types that may carry each pattern element ([MS-ASCAL] 2.2.2.14, .15, .29, .48; same rules in [MS-ASTASK]). */
const ALLOWED_TYPES = new Map([
  ["DayOfWeek", [0, 1, 3, 6]],
  ["DayOfMonth", [2, 5]],
  ["WeekOfMonth", [3, 6]],
  ["MonthOfYear", [5, 6]],
]);
/** Pattern elements each Type cannot do without ([MS-ASCAL] 2.2.2.37.1). Type 4 does not exist. */
const REQUIRED_ELEMENTS = new Map([
  [0, []],
  [1, ["DayOfWeek"]],
  [2, ["DayOfMonth"]],
  [3, ["WeekOfMonth", "DayOfWeek"]],
  [5, ["DayOfMonth", "MonthOfYear"]],
  [6, ["WeekOfMonth", "DayOfWeek", "MonthOfYear"]],
]);

const bad = (reason) => conversionError("BAD_RECURRENCE", `récurrence invalide (${reason})`);
const isElement = (node) => Boolean(node) && typeof node === "object" && Array.isArray(node.children);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (object, key) => (Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);
const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/** The protocol version, or a ProtocolError: an element is never written for a version that does not define it. */
export function checkVersion(version) {
  if (!PROTOCOL_VERSIONS.includes(version)) throw conversionError("BAD_VERSION", "version du protocole non gérée");
  return version;
}

// ── Description ───────────────────────────────────────────────────────────

function checkDays(value) {
  if (!Array.isArray(value) || value.length > WEEKDAYS.length) throw bad("byDay");
  const picked = new Set();
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string" || !WEEKDAYS.includes(value[i]) || picked.has(value[i])) throw bad("byDay");
    picked.add(value[i]);
  }
  return Object.freeze(WEEKDAYS.filter((day) => picked.has(day)));
}

/** Rule 5: the days of the longest period of each frequency. */
const PERIOD_DAYS = new Map([["daily", 1], ["weekly", 7], ["monthly", 31], ["yearly", 366]]);
const DAY = 86_400_000;
const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
/** The length of month 1-12 in a year. */
const monthLength = (year, month) => (month === 2 && !isLeapYear(year) ? 28 : DAYS_IN_MONTH[month]);

/** Rules 1 and 2: a clean, frozen copy of the rule, or a throw. */
function ruleOf(value, task) {
  if (!isRecord(value)) throw bad("description");
  const freq = own(value, "freq");
  const interval = own(value, "interval");
  const count = own(value, "count");
  const until = own(value, "until");
  const bySetPos = own(value, "bySetPos");
  const byMonthDay = own(value, "byMonthDay");
  const byMonth = own(value, "byMonth");
  const weekStart = own(value, "weekStart");
  // 1. Values.
  if (typeof freq !== "string" || !FREQUENCIES.has(freq)) throw bad("freq");
  if (!inRange(interval, 1, 999)) throw bad("interval");
  if (count !== null && !inRange(count, 1, task ? 255 : 999)) throw bad("count");
  if (until !== null) {
    if (count !== null) throw bad("count avec until");
    if (parseDate(until) === null && (task || parseUtc(until) === null)) throw bad("until");
  }
  const byDay = checkDays(own(value, "byDay"));
  if (bySetPos !== null && bySetPos !== -1 && !inRange(bySetPos, 1, 4)) throw bad("bySetPos");
  if (byMonthDay !== null && !inRange(byMonthDay, 1, 31)) throw bad("byMonthDay");
  if (byMonth !== null && !inRange(byMonth, 1, 12)) throw bad("byMonth");
  if (weekStart !== null && (typeof weekStart !== "string" || !WEEKDAYS.includes(weekStart))) throw bad("weekStart");

  // 2. Shape.
  const days = byDay.length > 0;
  const nth = bySetPos !== null;
  switch (freq) {
    case "daily":
      if (nth || byMonthDay !== null || byMonth !== null) throw bad("règle quotidienne");
      // "Every n days, but only on Mondays" has no ActiveSync form.
      if (days && interval !== 1) throw bad("jours de la semaine avec un intervalle en jours");
      break;
    case "weekly":
      if (nth || byMonthDay !== null || byMonth !== null) throw bad("règle hebdomadaire");
      break;
    case "monthly":
      if (byMonth !== null) throw bad("règle mensuelle");
      if (byMonthDay !== null ? days || nth : days !== nth) throw bad("règle mensuelle");
      break;
    default: // yearly
      if (byMonthDay !== null) {
        if (byMonth === null || days || nth) throw bad("règle annuelle");
        if (byMonthDay > DAYS_IN_MONTH[byMonth]) throw bad("jour absent de ce mois");
      } else if (days || nth) {
        if (!days || !nth || byMonth === null) throw bad("règle annuelle");
      }
  }
  return Object.freeze({ freq, interval, count, until, byDay, bySetPos, byMonthDay, byMonth, weekStart });
}

/**
 * Rules 3, 4 and 5: why `rule`, which passed rules 1 and 2, cannot be the
 * rule of `item`, or null. `item` holds what the rules need of the item:
 * { allDay, start, end, zone } of an event (`zone` is its `timezone`, null
 * or absent for UTC), { start, due } of a task. Without `end`, or for a
 * task without both dates, the length is not looked at.
 */
function itemReason(rule, task, item) {
  if (!isRecord(item)) return "élément";
  const start = own(item, "start") ?? null;
  const end = own(item, task ? "due" : "end") ?? null;
  const dated = task || own(item, "allDay") === true;
  // The first day, as the instant at which it starts in UTC.
  let first = null;
  if (task) {
    if (start === null && end === null) return "tâche sans date";
    first = parseDate(start ?? end);
  } else if (dated) {
    first = parseDate(start);
  } else {
    const zone = own(item, "zone") ?? null;
    const z = zone === null ? UTC_ZONE : checkZone(zone);
    const startMs = parseUtc(start);
    try {
      if (startMs !== null) first = parseDate(localDateOf(z, startMs));
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e; // a day before 1900 or after 2200: no first day
    }
  }
  if (first === null) return "début de l'élément";

  // 3. The end is of the kind of the start.
  if (rule.until !== null && (parseDate(rule.until) !== null) !== dated) return "until d'un autre genre que le début";

  // 4. The day comes.
  if ((rule.freq === "monthly" || rule.freq === "yearly") && rule.byDay.length === 0) {
    const date = new Date(first);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = rule.byMonthDay ?? date.getUTCDate();
    const periods = [0, 1, 2, 3].map((k) => k * rule.interval);
    if (rule.freq === "yearly") {
      const named = rule.byMonth ?? month;
      if (day > DAYS_IN_MONTH[named]) return "jour absent de ce mois";
      if (!periods.some((years) => day <= monthLength(year + years, named))) return "jour absent des quatre premières périodes";
    } else {
      const index = year * 12 + month - 1;
      if (!periods.some((months) => day <= monthLength(Math.floor((index + months) / 12), ((index + months) % 12) + 1))) {
        return "jour absent des quatre premières périodes";
      }
    }
  }

  // 5. No longer than its period.
  if (start !== null && end !== null) {
    const from = dated ? parseDate(start) : parseUtc(start);
    const to = dated ? parseDate(end) : parseUtc(end);
    if (from === null || to === null) return "fin de l'élément";
    if (to - from > rule.interval * PERIOD_DAYS.get(rule.freq) * DAY) return "élément plus long que sa période";
  }
  return null;
}

/**
 * A clean, frozen copy of a Recurrence description that passes the rules
 * of a recurrence (at the top of this file), or a ProtocolError (code
 * "BAD_RECURRENCE"). `byDay` comes back in week order.
 *
 *  - Without `item`, rules 1 and 2: every field in its range, never
 *    `count` with `until`, and one of the shapes ActiveSync can express (a
 *    weekly rule may leave byDay empty, a monthly or yearly one may leave
 *    its day to the start of the item, and "daily on some days" stands for
 *    the weekly rule when the interval is 1). `task`: `count` up to 255,
 *    `until` a DATE.
 *  - With `item`, rules 3, 4 and 5 too. `item` is what they need of the
 *    event, { allDay, start, end, zone } (`zone`: its `timezone`; null or
 *    absent for UTC), or of the task, { start, due }. Without `end`, the
 *    length is not looked at.
 */
export function checkRecurrence(value, { task = false, item = null } = {}) {
  const rule = ruleOf(value, task);
  if (item !== null && item !== undefined) {
    const reason = itemReason(rule, task, item);
    if (reason !== null) throw bad(reason);
  }
  return rule;
}

/**
 * Why checkRecurrence refuses `value` (same arguments), or null when it
 * does not: for the readers, which then give the item without its
 * recurrence instead of refusing it whole.
 */
export function recurrenceProblem(value, options = {}) {
  try {
    checkRecurrence(value, options);
    return null;
  } catch (e) {
    if (e instanceof ProtocolError && e.code === "BAD_RECURRENCE") return e.message;
    throw e;
  }
}

// ── Reading ───────────────────────────────────────────────────────────────

/**
 * The Recurrence element of a calendar item, or of a task with `task`,
 * → { recurrence, readOnly }.
 *
 *  - Each element is read once and checked against the range its Type
 *    allows: a pattern element the Type forbids, a missing one it needs, a
 *    doubled one or a value out of range throws. Interval 0 is 1, as
 *    servers treat it ([MS-ASCAL] product behavior for 2.2.2.25).
 *  - Occurrences wins over Until, as on the server ([MS-ASCAL] 3.2.5.3).
 *    An Until in 2200 or later is "never": no end.
 *  - `until` is a UTC instant; for an all-day item (`allDay`) it is the day
 *    of that instant in `zone`, and for a task the day as written.
 *  - A calendar that is not Gregorian (CalendarType, IsLeapMonth) gives
 *    { recurrence: null, readOnly: "calendar-type" }; a task that
 *    regenerates, { recurrence: null, readOnly: "regenerating" }.
 *  - A rule that breaks rule 2 (the shapes: a yearly 30 February) gives
 *    { recurrence: null, readOnly: "unsupported-recurrence" }. Rules 3 to 5
 *    need the item: readEvent and readTask apply them to what comes out
 *    of here, with recurrenceProblem.
 *  - A task whose DeadOccur is set generates no further occurrence: it is
 *    not recurring, { recurrence: null, readOnly: null }.
 *
 * The result also says `exact`: false when the element holds something
 * that writeRecurrence would not give back (a localized Gregorian
 * CalendarType, the pattern of a dead occurrence, anything read-only): an
 * item written from the description would erase it on the server.
 * For a task the result also carries `start`, the day of the Start element
 * (DATE) or null: the server may leave it out.
 */
export function readRecurrence(node, { task = false, allDay = false, zone = UTC_ZONE } = {}) {
  const ns = task ? "Tasks" : "Calendar";
  if (!isElement(node) || node.ns !== ns || node.tag !== "Recurrence") throw bad("élément inattendu");
  if (node.children.length > MAX_CHILDREN) throw bad("trop d'éléments");
  const known = task ? TASK_ELEMENTS : CALENDAR_ELEMENTS;
  const values = new Map();
  for (const c of node.children) {
    if (!isElement(c) || c.ns !== ns || !known.has(c.tag)) continue; // other namespaces, later versions
    if (values.has(c.tag)) throw bad(`${c.tag} en double`);
    if (c.children.length || (c.value && c.value.length > 32)) throw bad(c.tag);
    values.set(c.tag, text(c));
  }
  const number = (tag, min, max) => {
    if (!values.has(tag)) return null;
    const n = v.integer(values.get(tag), { min, max });
    if (n === null) throw bad(`${tag} hors limites`);
    return n;
  };

  const type = number("Type", 0, 6);
  if (type === null || !REQUIRED_ELEMENTS.has(type)) throw bad("Type");
  for (const [tag, types] of ALLOWED_TYPES) {
    if (values.has(tag) && !types.includes(type)) throw bad(`${tag} avec ce Type`);
  }
  for (const tag of REQUIRED_ELEMENTS.get(type)) {
    if (!values.has(tag)) throw bad(`${tag} manquant`);
  }
  const interval = number("Interval", 0, 999) || 1;
  const count = number("Occurrences", 1, task ? 255 : 999);
  const dayOfWeek = number("DayOfWeek", 1, 127);
  const dayOfMonth = number("DayOfMonth", 1, 31);
  const weekOfMonth = number("WeekOfMonth", 1, 5);
  const monthOfYear = number("MonthOfYear", 1, 12);
  const calendarType = number("CalendarType", 0, 23) ?? 0;
  const leapMonth = number("IsLeapMonth", 0, 1) === 1;
  const firstDayOfWeek = number("FirstDayOfWeek", 0, 6);
  const regenerate = task && number("Regenerate", 0, 1) === 1;
  const deadOccurrence = task && (number("DeadOccur", 0, 255) ?? 0) !== 0;

  let until = null;
  if (values.has("Until")) {
    const ms = (task ? parseDateTime : parseCompact)(values.get("Until"), { maxYear: 9999 });
    if (ms === null) throw bad("Until");
    if (new Date(ms).getUTCFullYear() < MAX_YEAR && count === null) {
      until = task ? formatDate(ms) : allDay ? localDateOf(zone, ms) : formatUtc(ms);
    }
  }
  let start = null;
  if (values.has("Start")) {
    const ms = parseDateTime(values.get("Start"));
    if (ms === null) throw bad("Start");
    start = formatDate(ms);
  }
  const result = (recurrence, readOnly, exact = false) => (task ? { recurrence, readOnly, exact, start } : { recurrence, readOnly, exact });

  if (deadOccurrence) return result(null, null);
  if (regenerate) return result(null, "regenerating");
  if (!GREGORIAN.has(calendarType) || leapMonth) return result(null, "calendar-type");

  const days = dayOfWeek === null ? [] : WEEKDAYS.filter((_, bit) => dayOfWeek & (1 << bit));
  const nth = weekOfMonth === 5 ? -1 : weekOfMonth;
  const rule = { freq: "daily", interval, count, until, byDay: [], bySetPos: null, byMonthDay: null, byMonth: null };
  rule.weekStart = firstDayOfWeek === null ? null : WEEKDAYS[firstDayOfWeek];
  switch (type) {
    case 0:
      if (days.length) Object.assign(rule, { freq: "weekly", byDay: days });
      break;
    case 1:
      Object.assign(rule, { freq: "weekly", byDay: days });
      break;
    case 2:
      Object.assign(rule, { freq: "monthly", byMonthDay: dayOfMonth });
      break;
    case 3:
      Object.assign(rule, { freq: "monthly", byDay: days, bySetPos: nth });
      break;
    case 5:
      Object.assign(rule, { freq: "yearly", byMonth: monthOfYear, byMonthDay: dayOfMonth });
      break;
    default: // 6
      Object.assign(rule, { freq: "yearly", byMonth: monthOfYear, byDay: days, bySetPos: nth });
  }
  // Every element is what the protocol says, but the rule is not one of the shapes of rule 2 (a yearly
  // 30 February): it is left out, and the item is read-only.
  if (recurrenceProblem(rule, { task }) !== null) return result(null, "unsupported-recurrence");
  return result(checkRecurrence(rule, { task }), null, GREGORIAN_PLAIN.has(calendarType));
}

// ── Writing ───────────────────────────────────────────────────────────────

/**
 * The children of a Recurrence element, in the Calendar namespace or, with
 * `task`, in Tasks.
 *
 *  - `version` ("12.1", "14.0" or "14.1") decides what may be written:
 *    FirstDayOfWeek exists in 14.1 only, and CalendarType is never sent
 *    (the server then takes its default calendar, as before 14.0).
 *  - `start` is the start of the item: UTC, or DATE for an all-day item
 *    and for a task. Its day in `zone` gives the parts the rule leaves
 *    out: the day of a weekly rule without byDay, the day number of a
 *    monthly one, the date of a yearly one. For a task it is also the
 *    Start element, which the server requires.
 *  - `until` must be of the kind of the item: a UTC instant for a timed
 *    item, a DATE for an all-day item (sent as local midnight of that day
 *    in `zone`) and for a task.
 *  - The rule must pass rules 1 to 4 for an item that starts at `start`
 *    (rule 5 needs its end: checkEvent and checkTask apply it).
 *
 * Throws ProtocolError for an invalid rule (see checkRecurrence), start,
 * zone or version. DeadOccur and Regenerate of tasks are the caller's.
 */
export function writeRecurrence(recurrence, { version, task = false, start, allDay = false, zone = UTC_ZONE } = {}) {
  checkVersion(version);
  // The length of the item is not known here: rule 5 is the caller's (checkEvent, checkTask).
  const rule = checkRecurrence(recurrence, { task, item: task ? { start } : { allDay, start, zone } });
  const z = checkZone(zone);
  const dated = task || allDay;
  const startMs = dated ? parseDate(start) : parseUtc(start);
  const first = new Date(dated ? startMs : parseDate(localDateOf(z, startMs)));
  const ns = task ? "Tasks" : "Calendar";
  const leaf = (tag, value) => el(`${ns}:${tag}`, String(value));

  let end = null;
  if (rule.count !== null) {
    end = leaf("Occurrences", rule.count);
  } else if (rule.until !== null) {
    if (task) end = leaf("Until", formatDateTime(parseDate(rule.until)));
    else end = leaf("Until", formatCompact(allDay ? localMidnightUtc(z, rule.until) : parseUtc(rule.until)));
  }

  const mask = (days) => days.reduce((bits, day) => bits | (1 << WEEKDAYS.indexOf(day)), 0);
  const week = rule.bySetPos === -1 ? 5 : rule.bySetPos;
  let type;
  const pattern = [];
  if (rule.freq === "daily" && rule.byDay.length === 0) {
    type = 0;
  } else if (rule.freq === "daily" || rule.freq === "weekly") {
    // "Daily on some days" (interval 1) is the weekly rule; Type 0 with DayOfWeek is not accepted by every server.
    type = 1;
    pattern.push(leaf("DayOfWeek", rule.byDay.length ? mask(rule.byDay) : 1 << first.getUTCDay()));
  } else if (rule.byDay.length) {
    type = rule.freq === "monthly" ? 3 : 6;
    pattern.push(leaf("WeekOfMonth", week), leaf("DayOfWeek", mask(rule.byDay)));
    if (type === 6) pattern.push(leaf("MonthOfYear", rule.byMonth));
  } else {
    type = rule.freq === "monthly" ? 2 : 5;
    pattern.push(leaf("DayOfMonth", rule.byMonthDay ?? first.getUTCDate()));
    if (type === 5) pattern.push(leaf("MonthOfYear", rule.byMonth ?? first.getUTCMonth() + 1));
  }

  return [
    leaf("Type", type),
    task ? leaf("Start", formatDateTime(startMs)) : null,
    leaf("Interval", rule.interval),
    end,
    ...pattern,
    version === "14.1" && rule.weekStart !== null ? leaf("FirstDayOfWeek", WEEKDAYS.indexOf(rule.weekStart)) : null,
  ].filter(Boolean);
}
