// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tasks of a Sync collection ([MS-ASTASK], [MS-ASAIRS] for Body) ⇄ the
 * task description of docs/CALENDAR-DESIGN.md.
 *
 *   TASK_FILTER_TYPES                              "0" all tasks, "8" incomplete ones
 *   taskOptions({ filterType })                    → Options children of the collection
 *   readTask(applicationData, { version, fallbackUid, change? })
 *                                                  → task description
 *   writeTask(task, { version, previous?, zone? }) → ApplicationData children, for Add and Change
 *   checkTask(value, { fromServer? })              → clean frozen copy of a description
 *
 * What the protocol gives, and does not:
 *  - a task has no UID on the server: the caller names it (`fallbackUid`);
 *  - dates come twice, as local time and as UTC, both written with a "Z"
 *    (StartDate with UtcStartDate, DueDate with UtcDueDate). The
 *    description keeps the local day. Both elements of a pair are always
 *    sent together;
 *  - DateCompleted goes with Complete: a completed task has its date, in
 *    both directions;
 *  - a recurring task carries, inside Recurrence, Regenerate (the next
 *    occurrence is counted from the completion: shown read-only) and
 *    DeadOccur (this item generates no further occurrence: read as not
 *    recurring, and read-only, since its pattern is not kept). A client
 *    marking a recurring task complete sets DeadOccur ([MS-ASTASK]
 *    2.2.2.11);
 *  - Supported does not exist for tasks: a property left out of a Change
 *    is deleted on the server, so writeTask always writes them all, except
 *    the body, which the server keeps when it is left out;
 *  - OrdinalDate and SubOrdinalDate ([MS-ASTASK] 2.2.2.19 and 2.2.2.28)
 *    order the tasks in other clients. Thunderbird has no use for them,
 *    but a Change that left them out would erase them: they are read into
 *    the optional fields `ordinalDate` and `subOrdinalDate`, as short
 *    texts taken whole or not at all, and written back as they came.
 *
 * The reading and writing rules are those of calendar-item.mjs: a required
 * value that cannot be read throws (ProtocolError with a `code`), an
 * optional one is left out, nothing is guessed, and a task of which
 * something was left out is read-only ("incomplete").
 */

import { el } from "./wbxml.mjs";
import { ProtocolError } from "./protocol.mjs";
import {
  checkZone,
  conversionError,
  localMidnightUtc,
  parseDate,
  parseUtc,
  parseDateTime,
  formatDate,
  formatUtc,
  formatDateTime,
} from "./eas-timezone.mjs";
import { readRecurrence, writeRecurrence, checkRecurrence, recurrenceProblem, checkVersion } from "./recurrence.mjs";
import {
  LIMITS,
  bodyChanged,
  bodyElement,
  bodyPreference,
  boundedText,
  checkBlock,
  checkBoolean,
  checkCategories,
  checkLine,
  checkMember,
  checkPrivacy,
  checkUid,
  childrenOf,
  cleanLine,
  exactText,
  privacyCode,
  readBody,
  readCategories,
  readSensitivity,
} from "./calendar-item.mjs";

/** FilterType values allowed for tasks ([MS-ASCMD] 2.2.3.68.2): 0 all, 8 incomplete tasks only. */
export const TASK_FILTER_TYPES = Object.freeze(["0", "8"]);

const NS = "Tasks";
const DAY = 86_400_000;
const PRIORITY = new Map([["0", "low"], ["1", "normal"], ["2", "high"]]);
const PRIORITY_CODES = new Map([["low", "0"], ["normal", "1"], ["high", "2"]]);
const READ_ONLY = new Set(["regenerating", "unsupported-recurrence", "incomplete"]);
const TOP_LEVEL = new Set([
  "Subject", "Importance", "UtcStartDate", "StartDate", "UtcDueDate", "DueDate", "Categories", "Recurrence",
  "Complete", "DateCompleted", "Sensitivity", "ReminderTime", "ReminderSet", "OrdinalDate", "SubOrdinalDate",
]);
/**
 * An ordering value (OrdinalDate is a dateTime, SubOrdinalDate any string
 * used to sort): 1 to 40 visible ASCII characters or spaces, kept exactly
 * as they are. Anything else is not carried.
 */
const ORDERING_MAX = 40;
const ORDERING = /^[\x20-\x7e]{1,40}$/;
const isOrdering = (value) => typeof value === "string" && ORDERING.test(value);

const badItem = (reason) => conversionError("BAD_ITEM", `tâche invalide (${reason})`);
const isElement = (node) => Boolean(node) && typeof node === "object" && Array.isArray(node.children);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const get = (object, key) => (Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);

// ── Checking ──────────────────────────────────────────────────────────────

function checkDay(value, what) {
  if (value === null) return null;
  if (parseDate(value) === null) throw badItem(what);
  return value;
}

function checkInstant(value, what) {
  if (value === null) return null;
  if (parseUtc(value) === null) throw badItem(what);
  return value;
}

/** An optional ordering field: absent (or null) → null; otherwise exactly an ordering value, or a throw. */
function checkOrdering(value, what) {
  if (value === undefined || value === null) return null;
  if (!isOrdering(value)) throw badItem(what);
  return value;
}

/**
 * A clean, deeply frozen copy of a task description, or a ProtocolError.
 *
 *  - Every field must be present, of its type and in its range; texts are
 *    cleaned and cut, `uid` must already be clean, categories are cut to
 *    50.
 *  - `start` and `due` are DATEs or null, `due` not before `start`.
 *  - `completedAt` is set when, and only when, `completed`.
 *  - `recurrence` must pass checkRecurrence for this task: the five rules
 *    of recurrence.mjs (count up to 255, `until` a DATE, a day that comes,
 *    a task no longer than the period of its rule). It needs a `start` or
 *    a `due`: the first occurrence is counted from it.
 *  - `ordinalDate` and `subOrdinalDate` are optional: absent (null counts
 *    as absent), or 1 to 40 visible ASCII characters or spaces, never
 *    cleaned. The copy has them only when they are set.
 *  - `fromServer`: the description is what readTask made of a server's
 *    task. Only then may `description` be null (a Change without a Body:
 *    the server does not say, the text held is kept). A description that
 *    comes from Thunderbird never holds a null there, and is refused.
 */
export function checkTask(value, { fromServer = false } = {}) {
  if (!isRecord(value)) throw badItem("description");
  if (get(value, "kind") !== "task") throw badItem("kind");
  const uid = checkUid(get(value, "uid"));
  const summary = checkLine(get(value, "summary"), LIMITS.summary, "summary");
  const text = get(value, "description");
  const description = fromServer === true && text === null ? null : checkBlock(text, LIMITS.description, "description");
  const categories = checkCategories(get(value, "categories"), "categories");
  const privacy = checkPrivacy(get(value, "privacy"), "privacy");
  const start = checkDay(get(value, "start"), "start");
  const due = checkDay(get(value, "due"), "due");
  if (start !== null && due !== null && due < start) throw badItem("échéance avant le début");
  const completed = checkBoolean(get(value, "completed"), "completed");
  const completedAt = checkInstant(get(value, "completedAt"), "completedAt");
  if (completed !== (completedAt !== null)) throw badItem("completedAt sans completed, ou l'inverse");
  const priority = checkMember(get(value, "priority"), PRIORITY_CODES, "priority");
  const reminderAt = checkInstant(get(value, "reminderAt"), "reminderAt");
  const rule = get(value, "recurrence");
  const recurrence = rule === null ? null : checkRecurrence(rule, { task: true, item: { start, due } });
  const readOnly = get(value, "readOnly");
  if (readOnly !== null) checkMember(readOnly, READ_ONLY, "readOnly");
  const ordinalDate = checkOrdering(get(value, "ordinalDate"), "ordinalDate");
  const subOrdinalDate = checkOrdering(get(value, "subOrdinalDate"), "subOrdinalDate");
  const task = {
    kind: "task",
    uid,
    summary,
    description,
    categories,
    privacy,
    start,
    due,
    completed,
    completedAt,
    priority,
    reminderAt,
    recurrence,
    readOnly,
  };
  if (ordinalDate !== null) task.ordinalDate = ordinalDate;
  if (subOrdinalDate !== null) task.subOrdinalDate = subOrdinalDate;
  return Object.freeze(task);
}

// ── Reading ───────────────────────────────────────────────────────────────

/**
 * The ApplicationData of a task → a task description.
 *
 *  - `version`: "12.1", "14.0" or "14.1".
 *  - `fallbackUid` (required): the uid of the description, since the
 *    server has none for a task; 1 to 300 clean characters.
 *  - `change`: true when the data is that of a Change command. Without a
 *    Body element, `description` is then null: the server does not say
 *    that the text is gone, and whoever holds the task keeps its text.
 *    Otherwise (an Add, a fetched task) no Body is an empty description.
 *
 * `start` and `due` are the days of StartDate and DueDate, the local
 * elements; when the server sent only the UTC one of a pair, its day is
 * taken. A start after the due date is left out. Defaults: priority
 * "normal", privacy "public", not completed, no reminder (ReminderTime
 * counts only with ReminderSet 1).
 * Recurrence: see readRecurrence. A recurrence in a calendar that is not
 * Gregorian, on a task without any date, or that breaks the rules of
 * recurrence.mjs (a day 29, 30 or 31 that does not come in the first four
 * periods, a task longer than its period) gives `recurrence` null and
 * `readOnly` "unsupported-recurrence": the task shows once.
 * `ordinalDate` and `subOrdinalDate` are there when the server sent an
 * OrdinalDate or a SubOrdinalDate that can be carried.
 *
 * `readOnly` is "incomplete" when the task holds something the description
 * does not, which a Change written from it would erase or alter on the
 * server:
 *  - a Subject or a category cut to its bound, a category left out, a body
 *    the server truncated or sent in another form than plain text;
 *  - a Subject, a body or a category from which an invisible or
 *    bidirectional character was removed (anything but U+200C and U+200D,
 *    which stay): written back, it would be another text;
 *  - an OrdinalDate or a SubOrdinalDate that is not 1 to 40 visible ASCII
 *    characters or spaces (an empty one counts as absent);
 *  - an Importance, a Sensitivity, a Complete or a ReminderSet that is not
 *    a value the description has (Sensitivity 1, "personal", among them);
 *  - a date that cannot be read, a local date with a time of day, a pair
 *    of dates of which only the UTC one came, a start after the due date,
 *    a reminder that is set without a readable time;
 *  - a Recurrence that would not be written back the same: that of a dead
 *    occurrence, a localized Gregorian CalendarType, FirstDayOfWeek before
 *    14.1, a Start that is not the day the task starts (or is due).
 * A ReminderTime or a DateCompleted left behind by a task that is not, or
 * no longer, set or completed is not counted: it says nothing.
 *
 * Throws ProtocolError for a task that says Complete without a readable
 * DateCompleted, an invalid Recurrence, a doubled element, or no uid.
 */
export function readTask(applicationData, { version, fallbackUid = null, change = false } = {}) {
  checkVersion(version);
  if (fallbackUid === null || fallbackUid === undefined) throw badItem("uid absent");
  if (!isElement(applicationData)) throw badItem("données absentes");
  const { fields, bodies } = childrenOf(applicationData, NS, TOP_LEVEL);
  let incomplete = false;
  const lossy = () => {
    incomplete = true;
  };
  const exact = (tag) => (fields.has(tag) ? exactText(fields.get(tag), 32) : null);
  /** `parse(text)` of an optional element: null when absent or empty; an unreadable one is a loss. */
  const optional = (tag, parse) => {
    const text = exact(tag);
    if (!fields.has(tag) || text === "") return null;
    const value = parse(text);
    if (value === null || value === undefined) lossy();
    return value ?? null;
  };
  const instant = (tag) => optional(tag, parseDateTime);
  /** The day of a pair of dates: that of the local element, which must be a day and nothing more. */
  const day = (local, utc) => {
    const localMs = instant(local);
    const utcMs = instant(utc);
    if (localMs === null) {
      if (utcMs !== null) lossy(); // an instant, of which the local day is not known
      return utcMs === null ? null : formatDate(utcMs);
    }
    if (localMs % DAY !== 0) lossy(); // the time of day would be written back as 00:00
    return formatDate(localMs);
  };
  const flag = (tag) => optional(tag, (text) => (text === "1" ? true : text === "0" ? false : null)) === true;
  /** An ordering element: its text exactly, or null with a loss when it cannot be carried as it is. */
  const ordering = (tag) => {
    if (!fields.has(tag)) return null;
    const text = exactText(fields.get(tag), ORDERING_MAX);
    if (text === "" || isOrdering(text)) return text || null;
    lossy(); // too long, not plain ASCII, or elements where a text is expected: a Change would erase it
    return null;
  };

  let start = day("StartDate", "UtcStartDate");
  const due = day("DueDate", "UtcDueDate");
  if (start !== null && due !== null && due < start) {
    start = null;
    lossy();
  }

  const completed = flag("Complete");
  let completedAt = null;
  if (completed) {
    const ms = parseDateTime(exact("DateCompleted"));
    if (ms === null) throw badItem("DateCompleted"); // required with Complete ([MS-ASTASK] 2.2.2.8)
    completedAt = formatUtc(ms);
  }
  let reminderMs = null;
  if (flag("ReminderSet")) {
    reminderMs = parseDateTime(exact("ReminderTime"));
    if (reminderMs === null) lossy(); // set, but for when?
  }

  let recurrence = null;
  let readOnly = null;
  if (fields.has("Recurrence")) {
    const read = readRecurrence(fields.get("Recurrence"), { task: true });
    recurrence = read.recurrence;
    readOnly = read.readOnly === "calendar-type" ? "unsupported-recurrence" : read.readOnly;
    if (!read.exact) lossy();
    if (recurrence !== null && recurrence.weekStart !== null && version !== "14.1") lossy(); // FirstDayOfWeek is 14.1 only
    if (recurrence !== null && start === null && due === null) {
      // Nothing to count the occurrences from but the Start of the recurrence itself.
      if (read.start !== null) {
        start = read.start;
      } else {
        recurrence = null;
        readOnly = "unsupported-recurrence";
      }
    }
    // The Start that would be written back is the day the task starts, or is due.
    if (recurrence !== null && read.start !== null && read.start !== (start ?? due)) lossy();
    // The rules that need the task (recurrence.mjs, rules 3 to 5): a day that never comes, a task longer
    // than its period. Thunderbird is not given such a rule: the task is shown once, read-only.
    if (recurrence !== null && recurrenceProblem(recurrence, { task: true, item: { start, due } }) !== null) {
      recurrence = null;
      readOnly = "unsupported-recurrence";
    }
  }

  const description = {
    kind: "task",
    uid: fallbackUid,
    summary: fields.has("Subject") ? boundedText(fields.get("Subject"), LIMITS.summary, cleanLine, lossy) : "",
    // A Change without a Body element does not say that the text is gone.
    description: change === true && bodies.length === 0 ? null : readBody(bodies, lossy) ?? "",
    categories: fields.has("Categories") ? readCategories(fields.get("Categories"), NS, lossy) : [],
    privacy: readSensitivity(exact("Sensitivity"), lossy) ?? "public",
    start,
    due,
    completed,
    completedAt,
    priority: optional("Importance", (text) => PRIORITY.get(text)) ?? "normal",
    reminderAt: reminderMs === null ? null : formatUtc(reminderMs),
    recurrence,
    readOnly,
  };
  const ordinalDate = ordering("OrdinalDate");
  const subOrdinalDate = ordering("SubOrdinalDate");
  if (ordinalDate !== null) description.ordinalDate = ordinalDate;
  if (subOrdinalDate !== null) description.subOrdinalDate = subOrdinalDate;
  if (description.readOnly === null && incomplete) description.readOnly = "incomplete";
  return checkTask(description, { fromServer: true });
}

// ── Writing ───────────────────────────────────────────────────────────────

const leaf = (tag, value) => el(`${NS}:${tag}`, String(value));

/** UTC instant at which a day starts on this computer: the "local" of a task is the user's own time. */
function systemMidnight(date) {
  const day = new Date(parseDate(date));
  return new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()).getTime();
}

/**
 * A task description → the children of ApplicationData, for an Add as for
 * a Change.
 *
 *  - The description is checked first (checkTask); a read-only task is
 *    refused (code "READ_ONLY_ITEM"): what could not be read would be
 *    erased.
 *  - Every property is written, or left out when it has no value, which
 *    deletes it on the server. The uid is not sent: tasks have none there.
 *  - StartDate and DueDate are the day at 00:00; UtcStartDate and
 *    UtcDueDate, the UTC instant of that local midnight: in `zone` (a Zone
 *    of eas-timezone.mjs) when it is given, in the time zone of this
 *    computer otherwise.
 *  - A completed task carries DateCompleted, and its Recurrence carries
 *    DeadOccur 1. A recurrence starts from `start`, or from `due`.
 *  - `previous`: for a Change, the description last synchronized; the body
 *    is sent only when the description differs from it.
 *  - OrdinalDate and SubOrdinalDate are written from the task's own
 *    `ordinalDate` and `subOrdinalDate` or, when it has none (Thunderbird
 *    does not keep them), from those of `previous`: a Change gives the
 *    server back what it sent. A value of `previous` that is not an
 *    ordering value is not written.
 */
export function writeTask(task, { version, previous = null, zone = null } = {}) {
  checkVersion(version);
  const t = checkTask(task);
  if (t.readOnly !== null) throw conversionError("READ_ONLY_ITEM", "tâche en lecture seule");
  const z = zone === null || zone === undefined ? null : checkZone(zone);
  const local = (date) => formatDateTime(parseDate(date));
  const utc = (date) => formatDateTime(z === null ? systemMidnight(date) : localMidnightUtc(z, date));
  const instant = (value) => formatDateTime(parseUtc(value));
  const before = (key) => (isRecord(previous) && isOrdering(get(previous, key)) ? get(previous, key) : null);
  const ordinalDate = t.ordinalDate ?? before("ordinalDate");
  const subOrdinalDate = t.subOrdinalDate ?? before("subOrdinalDate");
  return [
    bodyChanged(t.description, previous) ? bodyElement(t.description) : null,
    t.summary === "" ? null : leaf("Subject", t.summary),
    leaf("Importance", PRIORITY_CODES.get(t.priority)),
    t.start === null ? null : leaf("UtcStartDate", utc(t.start)),
    t.start === null ? null : leaf("StartDate", local(t.start)),
    t.due === null ? null : leaf("UtcDueDate", utc(t.due)),
    t.due === null ? null : leaf("DueDate", local(t.due)),
    t.categories.length ? el(`${NS}:Categories`, t.categories.map((name) => leaf("Category", name))) : null,
    t.recurrence === null
      ? null
      : el(`${NS}:Recurrence`, [
          ...writeRecurrence(t.recurrence, { version, task: true, start: t.start ?? t.due }),
          leaf("DeadOccur", t.completed ? "1" : "0"),
        ]),
    leaf("Complete", t.completed ? "1" : "0"),
    t.completed ? leaf("DateCompleted", instant(t.completedAt)) : null,
    leaf("Sensitivity", privacyCode(t.privacy)),
    t.reminderAt === null ? null : leaf("ReminderTime", instant(t.reminderAt)),
    leaf("ReminderSet", t.reminderAt === null ? "0" : "1"),
    ordinalDate === null ? null : leaf("OrdinalDate", ordinalDate),
    subOrdinalDate === null ? null : leaf("SubOrdinalDate", subOrdinalDate),
  ].filter(Boolean);
}

// ── Sync options ──────────────────────────────────────────────────────────

/**
 * Options children of a Sync collection of tasks: the filter (FilterType,
 * see TASK_FILTER_TYPES; given as a string or a number) and the body as
 * plain text of bounded size. Any other filter is refused (ProtocolError).
 */
export function taskOptions({ filterType } = {}) {
  const filter = typeof filterType === "string" || typeof filterType === "number" ? String(filterType) : "";
  if (!TASK_FILTER_TYPES.includes(filter)) throw new ProtocolError("filtre invalide pour les tâches");
  return [el("AirSync:FilterType", filter), bodyPreference()];
}
