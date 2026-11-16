// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Calendar items of a Sync collection ([MS-ASCAL], [MS-ASAIRS] for Body,
 * [MS-ASCMD] for FilterType and Supported) ⇄ the event description of
 * docs/CALENDAR-DESIGN.md: plain, validated and bounded data, the only
 * form in which an event reaches privileged code.
 *
 *   CALENDAR_FILTER_TYPES                          the periods a calendar may ask for
 *   calendarSupported(version)                     → element names for <Supported>
 *   calendarOptions({ filterType })                → Options children of the collection
 *   readEvent(applicationData, { version, ownEmail, fallbackUid?, change? })
 *                                                  → event description
 *   writeEvent(event, { version, previous? })      → ApplicationData children, for Add and Change
 *   checkEvent(value, { ownEmail?, fromServer? })  → clean frozen copy of a description
 *
 * Reading. The server, and through it any sender of an invitation, chooses
 * every byte:
 *  - a required value that cannot be read (StartTime, EndTime, UID, a time
 *    zone the dates depend on, a recurrence, an exception) makes the whole
 *    item invalid: a ProtocolError is thrown and the caller quarantines the
 *    item. Nothing is guessed;
 *  - an optional value that cannot be read is left out, an enumeration out
 *    of range takes its default, texts are cleaned and cut, attendees
 *    without a valid address are dropped, long lists are cut;
 *  - whenever the description then holds less than the item (anything but
 *    a text cleaned of control characters), it is marked read-only,
 *    "incomplete": a Change written from it would erase on the server what
 *    it does not hold;
 *  - a recurrence that breaks the rules of recurrence.mjs is left out: the
 *    item is read-only, "unsupported-recurrence", and shows once;
 *  - what comes out always passes checkEvent (with `fromServer`: only a
 *    reader may say "the server does not tell" with a null).
 *
 * Texts. The content of an item (Subject, Location, the body, a category)
 * goes back to the server whenever the user changes the item: it is kept
 * as the server has it, the zero-width joiner and non-joiner included.
 * Control characters are removed, and in a text of one line a tab or a
 * line break becomes a space: that is no loss. Any other invisible or
 * bidirectional character is removed too, and the item is then
 * "incomplete": written back, its text would be another one. The names of
 * people are not content: they are cleaned strictly, without a mark.
 *
 * Writing. Every property this module reads is named in <Supported>, so
 * the server deletes any of them that a Change leaves out: writeEvent
 * always writes them all, and refuses an item marked read-only, of which
 * something could not be read and would be erased. The body is the
 * exception: left out, it is kept by the server ([MS-ASCMD] 2.2.3.24),
 * and it is sent only when the description differs from `previous`.
 *
 * All-day events (12.1 to 14.1) are sent as the UTC instants of local
 * midnight in the item's time zone; the description carries days, the end
 * being the first day after the event, as in iCalendar.
 *
 * Errors are ProtocolErrors with a `code`: "INCOMPLETE_ITEM" (a Change
 * without StartTime: nothing to apply), "BAD_ITEM", "BAD_RECURRENCE",
 * "BAD_TIMEZONE", "BAD_DATE", "BAD_VERSION", "READ_ONLY_ITEM",
 * "UNSUPPORTED_CHANGE" (a change the protocol has no words for). Their
 * reason names a field, never its content.
 */

import { el } from "./wbxml.mjs";
import { decodeUtf8, encodeUtf8 } from "./utf8.mjs";
import * as v from "./sanitize.mjs";
import { ProtocolError } from "./protocol.mjs";
import {
  UTC_ZONE,
  checkZone,
  conversionError,
  readTimeZone,
  encodeTimeZone,
  offsetMinutesAt,
  localDateOf,
  localMidnightUtc,
  parseDate,
  parseUtc,
  parseCompact,
  formatDate,
  formatUtc,
  formatCompact,
} from "./eas-timezone.mjs";
import { readRecurrence, writeRecurrence, checkRecurrence, recurrenceProblem, checkVersion } from "./recurrence.mjs";

/**
 * FilterType values allowed for a calendar ([MS-ASCMD] 2.2.3.68.2): 0 all,
 * 4 two weeks back, 5 one month, 6 three months, 7 six months. Items in
 * the future are always sent.
 */
export const CALENDAR_FILTER_TYPES = Object.freeze(["0", "4", "5", "6", "7"]);

/** Bounds of the item description (docs/CALENDAR-DESIGN.md). */
export const LIMITS = Object.freeze({
  uid: 300,
  summary: 1024,
  location: 1024,
  description: 32768,
  categories: 50,
  category: 255,
  name: 256,
  attendees: 500,
  exceptions: 256,
  reminder: 40320,
  sequence: 2147483647,
});

/**
 * TruncationSize asked for the plain-text body, in bytes: three times the
 * longest description, so that a text of that length in UTF-8 is never cut
 * by the server before it is cut here.
 */
export const BODY_TRUNCATION_BYTES = 3 * LIMITS.description;

const NS = "Calendar";
const MINUTE = 60_000;
const DAY = 86_400_000;
const BODY_PLAIN = "1"; // AirSyncBase:Type of a plain-text body ([MS-ASAIRS] 2.2.2.41.1)

const badItem = (reason) => conversionError("BAD_ITEM", `élément invalide (${reason})`);
const isElement = (node) => Boolean(node) && typeof node === "object" && Array.isArray(node.children);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const get = (object, key) => (has(object, key) ? object[key] : undefined);

// ── Enumerations ──────────────────────────────────────────────────────────

const BUSY = new Map([["0", "free"], ["1", "tentative"], ["2", "busy"], ["3", "away"]]);
const BUSY_CODES = new Map([["free", "0"], ["tentative", "1"], ["busy", "2"], ["away", "3"]]);
// Sensitivity 1 ("personal") has no word in iCalendar: it is read as private, the stricter neighbour.
const PRIVACY = new Map([["0", "public"], ["1", "private"], ["2", "private"], ["3", "confidential"]]);
const PRIVACY_CODES = new Map([["public", "0"], ["private", "2"], ["confidential", "3"]]);
/** Privacy → the Sensitivity to send. */
export const privacyCode = (privacy) => PRIVACY_CODES.get(privacy);
const ATTENDEE_STATUS = new Map([["0", "unknown"], ["2", "tentative"], ["3", "accepted"], ["4", "declined"], ["5", "not-responded"]]);
const ATTENDEE_STATUS_CODES = new Map([["unknown", "0"], ["tentative", "2"], ["accepted", "3"], ["declined", "4"], ["not-responded", "5"]]);
const ATTENDEE_ROLE = new Map([["1", "required"], ["2", "optional"], ["3", "resource"]]);
const ATTENDEE_ROLE_CODES = new Map([["required", "1"], ["optional", "2"], ["resource", "3"]]);
// ResponseType 1 says "the user is the organizer": no answer of the user's own.
const RESPONSE = new Map([["0", "none"], ["1", "none"], ["2", "tentative"], ["3", "accepted"], ["4", "declined"], ["5", "not-responded"]]);
const RESPONSES = new Set(["none", "tentative", "accepted", "declined", "not-responded"]);
const MEETING_ROLES = new Set(["none", "organizer", "attendee"]);
const READ_ONLY = new Set(["calendar-type", "unsupported-recurrence", "incomplete"]);

// ── Texts (shared with task-item.mjs) ─────────────────────────────────────

const wellFormed = (s) => (s.isWellFormed() ? s : s.toWellFormed());

/**
 * Content: what the user reads and the server gets back. The three
 * cleaners of content take, from a reader, `lossy`: it is called when the
 * text held an invisible or bidirectional character that had to go (see
 * sanitize.mjs, contentText). U+200C and U+200D stay. Control characters
 * are removed, tabs and line breaks become spaces in one line, the blanks
 * around a category go: none of that calls `lossy`.
 */
function content(value, max, singleLine, lossy) {
  if (lossy !== null && v.hasHidden(value)) lossy(); // a lone surrogate too: it becomes U+FFFD
  return v.contentText(wellFormed(value), { max, singleLine });
}

/** One line of content (a subject, a location): no line break or control character, at most `max` characters. */
export function cleanLine(value, max, lossy = null) {
  return content(value, max, true, lossy);
}

/** The name of a category: one line of content, without the blanks around it, at most `max` characters. */
export function cleanLabel(value, max, lossy = null) {
  return v.cut(content(value, Infinity, true, lossy).trim(), max).trim();
}

/** Content of several lines (a body), cleaned the same way. */
export function cleanBlock(value, max, lossy = null) {
  return content(value, max, false, lossy);
}

/**
 * One line that is not content (an identifier, the name of a person):
 * cleaned strictly, of every invisible or bidirectional character, the two
 * joiners included.
 */
function strictLine(value, max) {
  return v.contentText(v.cleanText(wellFormed(value), { max: Infinity, singleLine: true, stripBidi: true }), { max, singleLine: true });
}

/** The name of a person: one strict line, without the blanks around it, at most `max` characters. */
export function cleanName(value, max) {
  return v.cut(strictLine(value, Infinity).trim(), max).trim();
}

/**
 * Text of a leaf element that is read whole or not at all (a date, a
 * number, an address, an identifier): null when it has children or is
 * longer than `maxChars` could ever need.
 */
export function exactText(node, maxChars) {
  if (node.children.length) return null;
  if (!node.value) return "";
  if (node.value.length > 4 * maxChars) return null;
  const text = decodeUtf8(node.value);
  return isUtf8(node.value, node.value.length, text) ? text : null; // bytes that are no text are not a value
}

/**
 * Whether the first `end` bytes are the UTF-8 of `text`, which was decoded
 * from them: false when the decoder had to put U+FFFD where the bytes were
 * not UTF-8. Such a text, written back, would replace the server's bytes.
 */
function isUtf8(bytes, end, text) {
  const again = encodeUtf8(text);
  if (again.length !== end) return false;
  for (let i = 0; i < end; i++) if (again[i] !== bytes[i]) return false;
  return true;
}

/**
 * Text of a leaf element, cleaned by `clean` (cleanLine, cleanLabel,
 * cleanBlock or cleanName) and cut to `max` characters. Only the part that
 * can matter is decoded, whatever the size of the element.
 * `lossy` is called when the text had to be cut, was no text at all
 * (elements where a text is expected), was not UTF-8 (the description
 * then holds U+FFFD where the server holds other bytes: a name too), or
 * is content from which an invisible or bidirectional character was
 * removed: the description then holds less than the server, or another
 * text. Removing control characters and blanks is no loss.
 */
export function boundedText(node, max, clean, lossy) {
  if (node.children.length) {
    lossy();
    return "";
  }
  if (!node.value) return "";
  const bytes = node.value;
  let end = Math.min(bytes.length, 4 * max + 1024);
  // Not in the middle of a character: step back over its continuation bytes (three at most).
  for (let k = 0; k < 3 && end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80; k++) end--;
  const decoded = decodeUtf8(bytes, 0, end);
  const whole = clean(decoded, Infinity, lossy);
  if (end < bytes.length || whole.length > max || !isUtf8(bytes, end, decoded)) lossy();
  return clean(whole, max);
}

/**
 * The children of an item that this module reads: those of namespace `ns`
 * named in `known`, each one at most once (a second one throws), and the
 * AirSyncBase Body elements (the first eight; `bodies.more` says there
 * were others). Everything else is ignored.
 */
export function childrenOf(node, ns, known) {
  const fields = new Map();
  const bodies = [];
  bodies.more = false;
  for (const c of node.children) {
    if (!isElement(c)) continue;
    if (c.ns === "AirSyncBase" && c.tag === "Body") {
      if (bodies.length < 8) bodies.push(c);
      else bodies.more = true;
      continue;
    }
    if (c.ns !== ns || !known.has(c.tag)) continue;
    if (fields.has(c.tag)) throw badItem(`${c.tag} en double`);
    fields.set(c.tag, c);
  }
  return { fields, bodies };
}

/**
 * The plain-text body among the Body elements of an item ([MS-ASAIRS]
 * 2.2.2.9): its text, cleaned and cut; "" for an empty Body element (in an
 * exception: "no text for this occurrence"); null when there is no text in
 * plain form. A body in HTML or RTF is never read (rule 24).
 * `lossy` is called when the server holds more than what is returned, or
 * something else: a text it says it truncated, a text cut here, a text
 * that lost an invisible or bidirectional character, or a body sent in
 * another form only.
 */
export function readBody(bodies, lossy) {
  let unread = bodies.more === true;
  for (const body of bodies) {
    if (body.children.length === 0) {
      if (body.value && body.value.length) lossy(); // text where elements are expected
      return "";
    }
    const sub = (tag) => body.children.find((c) => isElement(c) && c.ns === "AirSyncBase" && c.tag === tag);
    const type = sub("Type");
    const data = sub("Data");
    const mark = sub("Truncated");
    const truncated = Boolean(mark) && exactText(mark, 4) !== "0" && exactText(mark, 4) !== "";
    if (!type || exactText(type, 4) !== BODY_PLAIN) {
      if (truncated || (data && (data.children.length > 0 || (data.value && data.value.length > 0)))) unread = true;
      continue;
    }
    if (truncated) lossy();
    return data ? boundedText(data, LIMITS.description, cleanBlock, lossy) : null;
  }
  if (unread) lossy();
  return null;
}

/** The Body element for a plain text, to send when the text changed. */
export function bodyElement(description) {
  return el("AirSyncBase:Body", [el("AirSyncBase:Type", BODY_PLAIN), el("AirSyncBase:Data", description)]);
}

/**
 * Whether a description must be sent: always for a new item that has one,
 * and for a change only when it differs from the one last synchronized
 * (`previous`, an item description). An unchanged text is left to the
 * server, which may hold a richer or longer form of it.
 */
export function bodyChanged(description, previous) {
  if (previous === null || previous === undefined) return description !== "";
  const before = isRecord(previous) ? get(previous, "description") : undefined;
  return typeof before !== "string" || cleanBlock(before, LIMITS.description) !== description;
}

/** BodyPreference of a calendar or task collection: plain text, with a size limit. */
export function bodyPreference() {
  return el("AirSyncBase:BodyPreference", [
    el("AirSyncBase:Type", BODY_PLAIN),
    el("AirSyncBase:TruncationSize", String(BODY_TRUNCATION_BYTES)),
  ]);
}

/**
 * Category elements under `node` → at most 50 distinct names of 1 to 255
 * characters. `ns` is the item's namespace. `lossy` is called when a
 * category is left out (empty, repeated, beyond the fiftieth), cut, or
 * cleaned of an invisible or bidirectional character.
 */
export function readCategories(node, ns, lossy) {
  const names = [];
  const seen = new Set();
  for (const c of node.children) {
    if (!isElement(c) || c.ns !== ns || c.tag !== "Category") continue;
    if (names.length >= LIMITS.categories) {
      lossy();
      break;
    }
    const name = boundedText(c, LIMITS.category, cleanLabel, lossy);
    if (!name || seen.has(name)) {
      lossy();
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Sensitivity (the text of the element, null when absent) → privacy, or
 * undefined when there is none to read. `lossy` is called for a value the
 * description cannot give back: an unknown one, and 1 ("personal"), which
 * would come back as 2.
 */
export function readSensitivity(text, lossy) {
  if (text === null || text === "") return undefined;
  const privacy = PRIVACY.get(text);
  if (privacy === undefined || text === "1") lossy();
  return privacy;
}

// ── Checking a description (shared parts first) ───────────────────────────

/** An identifier is taken as it is, or not at all: 1 to 300 characters that the strict cleaning would not change. */
export function checkUid(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > LIMITS.uid || strictLine(value, LIMITS.uid) !== value) throw badItem("uid");
  return value;
}

export function checkLine(value, max, what) {
  if (typeof value !== "string") throw badItem(what);
  return cleanLine(value, max);
}

export function checkBlock(value, max, what) {
  if (typeof value !== "string") throw badItem(what);
  return cleanBlock(value, max);
}

export function checkBoolean(value, what) {
  if (typeof value !== "boolean") throw badItem(what);
  return value;
}

export function checkMember(value, set, what) {
  if (typeof value !== "string" || !set.has(value)) throw badItem(what);
  return value;
}

export const checkPrivacy = (value, what) => checkMember(value, PRIVACY_CODES, what);

/** A list of categories: strings, cleaned, the empty and repeated ones dropped, the list cut to 50. */
export function checkCategories(value, what) {
  if (!Array.isArray(value)) throw badItem(what);
  const names = [];
  const seen = new Set();
  const scanned = Math.min(value.length, 10 * LIMITS.categories);
  for (let i = 0; i < scanned && names.length < LIMITS.categories; i++) {
    if (typeof value[i] !== "string") throw badItem(what);
    const name = cleanLabel(value[i], LIMITS.category);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return Object.freeze(names);
}

/** A DATE (`wholeDay`) or a UTC instant → its value in ms; throws when it is not exactly that. */
function checkWhen(value, wholeDay, what) {
  const ms = wholeDay ? parseDate(value) : parseUtc(value);
  if (ms === null) throw badItem(what);
  return ms;
}

/**
 * The end of an event or of an occurrence against its start: never before
 * it. A timed event may end when it starts (Exchange has such events); an
 * all-day one lasts at least a day.
 */
function endsInOrder(startMs, endMs, wholeDay) {
  return wholeDay ? endMs > startMs : endMs >= startMs;
}

function checkPerson(value, what) {
  if (!isRecord(value)) throw badItem(what);
  const email = v.emailAddress(get(value, "email"));
  if (email === null) throw badItem(`${what} : adresse`);
  const name = get(value, "name");
  if (typeof name !== "string") throw badItem(`${what} : nom`);
  return { email, name: cleanName(name, LIMITS.name) };
}

/** Attendees: every entry valid (an address is never repaired), one entry per address, the list cut to 500. */
function checkAttendees(value, what) {
  if (!Array.isArray(value)) throw badItem(what);
  const list = [];
  const seen = new Set();
  const length = Math.min(value.length, LIMITS.attendees);
  for (let i = 0; i < length; i++) {
    const person = checkPerson(value[i], what);
    const role = checkMember(get(value[i], "role"), ATTENDEE_ROLE_CODES, `${what} : rôle`);
    const status = checkMember(get(value[i], "status"), ATTENDEE_STATUS_CODES, `${what} : réponse`);
    const key = person.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(Object.freeze({ email: person.email, name: person.name, role, status }));
  }
  return Object.freeze(list);
}

function checkReminder(value, what) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > LIMITS.reminder) throw badItem(what);
  return value + 0;
}

/** The changes of one exception: any subset of the twelve fields, each checked as on the event itself. */
function checkChanges(value, allDay) {
  if (!isRecord(value)) throw badItem("exception : changes");
  const out = {};
  if (has(value, "summary")) out.summary = checkLine(value.summary, LIMITS.summary, "exception : summary");
  if (has(value, "location")) out.location = checkLine(value.location, LIMITS.location, "exception : location");
  if (has(value, "description")) out.description = checkBlock(value.description, LIMITS.description, "exception : description");
  if (has(value, "allDay")) out.allDay = checkBoolean(value.allDay, "exception : allDay");
  const wholeDay = out.allDay ?? allDay;
  if (has(value, "start")) {
    checkWhen(value.start, wholeDay, "exception : start");
    out.start = value.start;
  }
  if (has(value, "end")) {
    checkWhen(value.end, wholeDay, "exception : end");
    out.end = value.end;
  }
  if (has(out, "start") && has(out, "end") && !endsInOrder(checkWhen(out.start, wholeDay), checkWhen(out.end, wholeDay), wholeDay)) {
    throw badItem("exception : fin avant le début");
  }
  if (has(value, "busy")) out.busy = checkMember(value.busy, BUSY_CODES, "exception : busy");
  if (has(value, "privacy")) out.privacy = checkPrivacy(value.privacy, "exception : privacy");
  if (has(value, "reminder")) out.reminder = checkReminder(value.reminder, "exception : reminder");
  if (has(value, "categories")) out.categories = checkCategories(value.categories, "exception : categories");
  if (has(value, "attendees")) out.attendees = checkAttendees(value.attendees, "exception : attendees");
  if (has(value, "cancelled")) out.cancelled = checkBoolean(value.cancelled, "exception : cancelled");
  return Object.freeze(out);
}

/** Exceptions: at most 256, each for a different occurrence. One too many, or a repeated one, throws. */
function checkExceptions(value, allDay) {
  if (!Array.isArray(value) || value.length > LIMITS.exceptions) throw badItem("exceptions");
  const list = [];
  const seen = new Set();
  for (let i = 0; i < value.length; i++) {
    const x = value[i];
    if (!isRecord(x)) throw badItem("exception");
    const originalStart = get(x, "originalStart");
    checkWhen(originalStart, allDay, "exception : originalStart");
    if (seen.has(originalStart)) throw badItem("deux exceptions pour une même occurrence");
    seen.add(originalStart);
    const deleted = checkBoolean(get(x, "deleted"), "exception : deleted");
    // A deleted occurrence has nothing left to change.
    const changes = deleted ? Object.freeze({}) : checkChanges(get(x, "changes"), allDay);
    list.push(Object.freeze({ originalStart, deleted, changes }));
  }
  return Object.freeze(list);
}

/**
 * A clean, deeply frozen copy of an event description, or a ProtocolError.
 * This is what stands between Thunderbird's side and the server: it
 * enforces every bound and rule of the contract.
 *
 *  - Every field must be present, of its type and in its range;
 *    enumerations and addresses are never repaired.
 *  - Texts are cleaned and cut to their bound. `uid` is an identifier: it
 *    must already be clean (1 to 300 characters, one line).
 *  - `start` and `end` are DATEs when `allDay`, UTC instants otherwise, in
 *    exact form, real days, years 1900 to 2200; `end` is not before
 *    `start`, and after it when `allDay`.
 *  - `categories` and `attendees` are cut to 50 and 500 entries (repeated
 *    ones dropped); more than 256 exceptions, or two for one occurrence,
 *    throw, as do exceptions without a recurrence.
 *  - `recurrence` must pass checkRecurrence for this item: the five rules
 *    of recurrence.mjs, among them an `until` of the kind of `start`, a
 *    day that comes, and an event no longer than the period of its rule.
 *  - `meeting.role` "organizer" needs an organizer; with `ownEmail` (the
 *    mailbox's own address) that organizer must be that address.
 *  - `fromServer`: the description is what a reader made of a server's
 *    item. Only then may `description` be null (a Change without a Body:
 *    the server does not say, the text held is kept) and
 *    `meeting.response` be null (before 14.0 the server does not say what
 *    the user answered: the answer held is kept). A description that
 *    comes from Thunderbird never holds a null there, and is refused.
 *
 * Unknown properties are left out of the copy.
 */
export function checkEvent(value, { ownEmail = null, fromServer = false } = {}) {
  if (!isRecord(value)) throw badItem("description");
  if (get(value, "kind") !== "event") throw badItem("kind");
  const unsaid = (field) => fromServer === true && field === null;
  const uid = checkUid(get(value, "uid"));
  const summary = checkLine(get(value, "summary"), LIMITS.summary, "summary");
  const location = checkLine(get(value, "location"), LIMITS.location, "location");
  const text = get(value, "description");
  const description = unsaid(text) ? null : checkBlock(text, LIMITS.description, "description");
  const allDay = checkBoolean(get(value, "allDay"), "allDay");
  const start = get(value, "start");
  const end = get(value, "end");
  if (!endsInOrder(checkWhen(start, allDay, "start"), checkWhen(end, allDay, "end"), allDay)) throw badItem("fin avant le début");
  const zone = get(value, "timezone");
  const timezone = zone === null ? null : checkZone(zone);
  const busy = checkMember(get(value, "busy"), BUSY_CODES, "busy");
  const privacy = checkPrivacy(get(value, "privacy"), "privacy");
  const reminder = checkReminder(get(value, "reminder"), "reminder");
  const categories = checkCategories(get(value, "categories"), "categories");
  const person = get(value, "organizer");
  const organizer = person === null ? null : Object.freeze(checkPerson(person, "organizer"));
  const attendees = checkAttendees(get(value, "attendees"), "attendees");

  const m = get(value, "meeting");
  if (!isRecord(m)) throw badItem("meeting");
  const meeting = Object.freeze({
    role: checkMember(get(m, "role"), MEETING_ROLES, "meeting : role"),
    cancelled: checkBoolean(get(m, "cancelled"), "meeting : cancelled"),
    responseRequested: checkBoolean(get(m, "responseRequested"), "meeting : responseRequested"),
    response: unsaid(get(m, "response")) ? null : checkMember(get(m, "response"), RESPONSES, "meeting : response"),
    allowNewTime: checkBoolean(get(m, "allowNewTime"), "meeting : allowNewTime"),
  });
  if (meeting.role === "organizer") {
    if (organizer === null) throw badItem("organisateur absent");
    if (ownEmail !== null) {
      const mailbox = v.emailAddress(ownEmail);
      if (mailbox === null) throw badItem("adresse de la boîte");
      if (organizer.email.toLowerCase() !== mailbox.toLowerCase()) throw badItem("organisateur autre que la boîte");
    }
  }

  const rule = get(value, "recurrence");
  const recurrence = rule === null ? null : checkRecurrence(rule, { item: { allDay, start, end, zone: timezone } });
  const exceptions = checkExceptions(get(value, "exceptions"), allDay);
  if (exceptions.length && recurrence === null) throw badItem("exceptions sans récurrence");

  const stamp = get(value, "stamp");
  if (stamp !== null) checkWhen(stamp, false, "stamp");
  const sequence = get(value, "sequence");
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > LIMITS.sequence) throw badItem("sequence");
  const readOnly = get(value, "readOnly");
  if (readOnly !== null) checkMember(readOnly, READ_ONLY, "readOnly");

  return Object.freeze({
    kind: "event",
    uid,
    summary,
    location,
    description,
    allDay,
    start,
    end,
    timezone,
    busy,
    privacy,
    reminder,
    categories,
    organizer,
    attendees,
    meeting,
    recurrence,
    exceptions,
    stamp,
    sequence: sequence + 0,
    readOnly,
  });
}

// ── Reading ───────────────────────────────────────────────────────────────

const TOP_LEVEL = new Set([
  "Timezone", "AllDayEvent", "BusyStatus", "OrganizerName", "OrganizerEmail", "DtStamp", "EndTime", "Location",
  "Reminder", "Sensitivity", "Subject", "StartTime", "UID", "MeetingStatus", "Attendees", "Categories",
  "Recurrence", "Exceptions", "ResponseRequested", "ResponseType", "DisallowNewTimeProposal",
]);
const EXCEPTION_LEVEL = new Set([
  "Deleted", "ExceptionStartTime", "Subject", "StartTime", "EndTime", "Location", "Categories", "Sensitivity",
  "BusyStatus", "AllDayEvent", "Reminder", "MeetingStatus", "Attendees",
]);

/**
 * Reads the leaf children of `fields`. Each reader calls `lossy` when the
 * element holds something it does not return: the description then says
 * less than the server, and must not be written back.
 */
function reader(fields, lossy) {
  const exact = (tag, maxChars = 32) => (fields.has(tag) ? exactText(fields.get(tag), maxChars) : null);
  /** `parse(text)` of an optional value: null when absent or empty; an unreadable one is a loss. */
  const optional = (tag, parse) => {
    const text = exact(tag);
    if (!fields.has(tag) || text === "") return null;
    const value = parse(text);
    if (value === null || value === undefined) lossy();
    return value ?? null;
  };
  return {
    exact,
    optional,
    line: (tag, max) => (fields.has(tag) ? boundedText(fields.get(tag), max, cleanLine, lossy) : ""),
    name: (tag, max) => (fields.has(tag) ? boundedText(fields.get(tag), max, cleanName, lossy) : ""),
    flag: (tag) => optional(tag, v.flag),
    member: (tag, map) => optional(tag, (text) => map.get(text)) ?? undefined,
    reminder: (tag) =>
      optional(tag, (text) => {
        const minutes = v.integer(text, { min: 0, max: 4294967295 });
        if (minutes !== null && minutes > LIMITS.reminder) lossy(); // brought back to four weeks
        return minutes === null ? null : Math.min(minutes, LIMITS.reminder);
      }),
  };
}

const nextDay = (date) => formatDate(parseDate(date) + DAY);

/**
 * The first day after an all-day occurrence of which only the end is
 * known: the day of that instant when it is the start of the day or a
 * local midnight, the next day when it falls inside a day.
 */
function endDay(zone, endMs) {
  const day = localDateOf(zone, endMs);
  if (endMs <= localMidnightUtc(zone, day)) return day;
  const wallClock = endMs + offsetMinutesAt(zone, endMs) * MINUTE;
  return ((wallClock % DAY) + DAY) % DAY === 0 ? day : nextDay(day);
}

/**
 * An all-day range → [first day, first day after]. The first day is the
 * day of the start in the zone; the number of days is the duration in
 * whole days, at least one. Local midnights are 23 to 25 hours apart
 * around a change of time, some servers simply add 24 hours, others end
 * the day at 23:59: all of them mean the same days.
 */
function dayRange(zone, startMs, endMs) {
  if (endMs < startMs) throw badItem("fin avant le début");
  const start = localDateOf(zone, startMs);
  const days = Math.max(1, Math.round((endMs - startMs) / DAY));
  return [start, formatDate(parseDate(start) + days * DAY)];
}

/** Whether an instant is exactly what a day is written as: its local midnight in the zone. */
const isDayStart = (zone, day, ms) => localMidnightUtc(zone, day) === ms;

function readAttendees(node, lossy) {
  const list = [];
  const seen = new Set();
  for (const a of node.children) {
    if (!isElement(a) || a.ns !== NS || a.tag !== "Attendee") continue;
    if (list.length >= LIMITS.attendees) {
      lossy();
      break;
    }
    const sub = (tag) => a.children.find((c) => isElement(c) && c.ns === NS && c.tag === tag);
    const address = sub("Email");
    const email = address ? v.emailAddress(exactText(address, 320)) : null;
    if (email === null || seen.has(email.toLowerCase())) {
      lossy(); // no usable address, or a second entry for one address: not an attendee we can name
      continue;
    }
    seen.add(email.toLowerCase());
    const name = sub("Name");
    const member = (tag, map, fallback) => {
      const text = sub(tag) ? exactText(sub(tag), 4) : "";
      if (text !== "" && !map.has(text)) lossy();
      return map.get(text) ?? fallback;
    };
    list.push({
      email,
      name: name ? boundedText(name, LIMITS.name, cleanName, lossy) : "",
      role: member("AttendeeType", ATTENDEE_ROLE, "required"),
      status: member("AttendeeStatus", ATTENDEE_STATUS, "unknown"),
    });
  }
  return list;
}

function readException(node, { allDay, zone, version, role, lossy }) {
  const { fields, bodies } = childrenOf(node, NS, EXCEPTION_LEVEL);
  const read = reader(fields, lossy);
  const originalMs = parseCompact(read.exact("ExceptionStartTime"));
  if (originalMs === null) throw badItem("ExceptionStartTime");
  const originalStart = allDay ? localDateOf(zone, originalMs) : formatUtc(originalMs);
  if (allDay && !isDayStart(zone, originalStart, originalMs)) lossy();
  if (read.exact("Deleted") === "1") return { originalStart, deleted: true, changes: {} };

  // An element that is present changes the occurrence, an empty one removes
  // the inherited value ([MS-ASCAL] 3.2.5.3.2); an absent one inherits.
  const changes = {};
  if (fields.has("Subject")) changes.summary = read.line("Subject", LIMITS.summary);
  if (fields.has("Location")) changes.location = read.line("Location", LIMITS.location);
  const body = readBody(bodies, lossy);
  if (body !== null) changes.description = body;
  const dayFlag = read.flag("AllDayEvent");
  if (dayFlag !== null) changes.allDay = dayFlag;
  const wholeDay = dayFlag ?? allDay;
  const instant = (tag) => {
    if (!fields.has(tag)) return null;
    const ms = parseCompact(read.exact(tag));
    if (ms === null) throw badItem(`exception : ${tag}`);
    return ms;
  };
  const startMs = instant("StartTime");
  const endMs = instant("EndTime");
  if (wholeDay) {
    if (startMs !== null && endMs !== null) [changes.start, changes.end] = dayRange(zone, startMs, endMs);
    else if (startMs !== null) changes.start = localDateOf(zone, startMs);
    else if (endMs !== null) changes.end = endDay(zone, endMs);
    // Days are written back as local midnights: instants that are not midnights would be moved.
    if (startMs !== null && !isDayStart(zone, changes.start, startMs)) lossy();
    if (endMs !== null && !isDayStart(zone, changes.end, endMs)) lossy();
  } else {
    if (startMs !== null && endMs !== null && endMs < startMs) throw badItem("exception : fin avant le début");
    if (startMs !== null) changes.start = formatUtc(startMs);
    if (endMs !== null) changes.end = formatUtc(endMs);
  }
  const busy = read.member("BusyStatus", BUSY);
  if (busy) changes.busy = busy;
  const privacy = readSensitivity(read.exact("Sensitivity"), lossy);
  if (privacy) changes.privacy = privacy;
  if (fields.has("Reminder")) {
    const minutes = read.reminder("Reminder");
    if (read.exact("Reminder") === "") {
      changes.reminder = null;
      if (version !== "14.1") lossy(); // an empty Reminder cannot be sent before 14.1
    } else if (minutes !== null) {
      changes.reminder = minutes;
    }
  }
  if (fields.has("Categories")) changes.categories = readCategories(fields.get("Categories"), NS, lossy);
  if (fields.has("Attendees")) {
    changes.attendees = readAttendees(fields.get("Attendees"), lossy);
    if (version === "12.1") lossy(); // the attendees of one occurrence cannot be sent in 12.1
  }
  const status = read.optional("MeetingStatus", (text) => v.integer(text, { min: 0, max: 255 }));
  if (status !== null) {
    changes.cancelled = (status & 4) !== 0;
    // What writeEvent sends for this occurrence: nothing for an appointment (the status of the series), its role otherwise.
    if ((status & 7) !== meetingStatus(role, changes.cancelled)) lossy();
  }
  return { originalStart, deleted: false, changes };
}

function readExceptions(node, context) {
  const list = node.children.filter((c) => isElement(c) && c.ns === NS && c.tag === "Exception");
  if (list.length > LIMITS.exceptions) throw badItem("trop d'exceptions");
  return list.map((exception) => readException(exception, context));
}

/**
 * The ApplicationData of a calendar item, as it comes out of
 * protocol.parseSync → an event description.
 *
 *  - `version`: "12.1", "14.0" or "14.1".
 *  - `ownEmail`: the mailbox's own address. `meeting.role` is "organizer"
 *    when the item is a meeting (MeetingStatus, read as bits: 1 meeting,
 *    2 received, 4 cancelled) and OrganizerEmail is that address, whatever
 *    the case of its letters; "attendee" for any other meeting; "none" for
 *    an appointment. The address decides, not the "received" bit.
 *  - `fallbackUid`: the uid to use when the server sends none (it may: only
 *    the client has to create one). Without it such an item is refused.
 *  - `change`: true when the data is that of a Change command. A Change
 *    may leave the body out because it did not change ([MS-ASCMD]
 *    2.2.3.24): without a Body element, `description` is then null, "the
 *    server does not say", and whoever holds the item keeps its text.
 *    Otherwise (an Add, a fetched item) no Body is an empty description.
 *
 * Defaults: busy "busy", privacy "public", no reminder, attendee
 * "required" and "unknown". `responseRequested` is true for a meeting
 * unless the server says otherwise (always, before 14.0, which has no such
 * element); `sequence` is 0, ActiveSync has none.
 * `meeting.response` is the user's own answer, as ResponseType gives it.
 * That element exists from 14.0 on: before, for a meeting organized by
 * someone else, it is null, "the server does not say" (whoever holds the
 * item keeps the answer it holds; for a new item it means no answer yet).
 * A recurrence in a calendar that is not Gregorian gives `recurrence`
 * null, no exceptions, and `readOnly` "calendar-type". One that breaks the
 * rules of recurrence.mjs (a shape Thunderbird cannot be given, a day 29,
 * 30 or 31 that does not come in the first four periods, an event longer
 * than its period) gives `recurrence` null, no exceptions, and `readOnly`
 * "unsupported-recurrence": the event shows once, where it starts.
 *
 * `readOnly` is "incomplete" when the item holds something the description
 * does not, which a Change written from it would therefore erase or alter
 * on the server:
 *  - a text cut to its bound (Subject, Location, a name, a category), a
 *    body the server truncated or sent in another form than plain text;
 *  - a Subject, a Location, a body or a category from which an invisible
 *    or bidirectional character was removed (anything but U+200C and
 *    U+200D, which stay): written back, it would be another text;
 *  - an attendee left out (no usable address, a second entry for one
 *    address, beyond the 500th), a category left out (empty, repeated,
 *    beyond the 50th);
 *  - a value that is not one the description has: an enumeration, a flag,
 *    a reminder or a date out of range or unreadable, Sensitivity 1
 *    ("personal"), an organizer without a usable address, a MeetingStatus
 *    that contradicts the role the address gives;
 *  - a time zone that could not be decoded (accepted only for a timed
 *    event without recurrence, whose instants do not depend on it;
 *    otherwise the item is refused) or that holds a change of one year;
 *  - an all-day event, or one of its occurrences, that does not start and
 *    end at local midnights of its zone: its days would be written back
 *    as other instants;
 *  - a localized Gregorian CalendarType, and what `version` cannot write
 *    back (FirstDayOfWeek before 14.1, the attendees of an occurrence in
 *    12.1, an occurrence without reminder before 14.1).
 * Cleaning a text of control characters or blanks is no loss, nor is the
 * strict cleaning of the name of a person.
 *
 * Throws ProtocolError: code "INCOMPLETE_ITEM" when StartTime is absent (a
 * Change that carries nothing to apply, [MS-ASCAL] 2.2.2.42), or one of
 * the codes of an invalid item.
 */
export function readEvent(applicationData, { version, ownEmail, fallbackUid = null, change = false } = {}) {
  checkVersion(version);
  const mailbox = v.emailAddress(ownEmail);
  if (mailbox === null) throw badItem("adresse de la boîte");
  if (!isElement(applicationData)) throw badItem("données absentes");
  const { fields, bodies } = childrenOf(applicationData, NS, TOP_LEVEL);
  let incomplete = false;
  const lossy = () => {
    incomplete = true;
  };
  const read = reader(fields, lossy);

  if (!fields.has("StartTime")) throw conversionError("INCOMPLETE_ITEM", "élément incomplet (StartTime absent)");
  const startMs = parseCompact(read.exact("StartTime"));
  if (startMs === null) throw badItem("StartTime");
  const endMs = parseCompact(read.exact("EndTime"));
  if (endMs === null) throw badItem("EndTime");
  const allDay = read.flag("AllDayEvent") === true;
  const recurring = fields.has("Recurrence");

  let timezone = null;
  if (fields.has("Timezone")) {
    try {
      const decoded = readTimeZone(read.exact("Timezone", 512));
      timezone = decoded.zone;
      if (decoded.reduced) lossy();
    } catch (e) {
      if (!(e instanceof ProtocolError) || allDay || recurring) throw e;
      lossy(); // written back, the item would get the UTC zone instead of this one
    }
  }
  const zone = timezone ?? UTC_ZONE;

  let start;
  let end;
  if (allDay) {
    [start, end] = dayRange(zone, startMs, endMs);
    // Days are written back as local midnights: instants that are not midnights would be moved.
    if (!isDayStart(zone, start, startMs) || !isDayStart(zone, end, endMs)) lossy();
  } else {
    if (endMs < startMs) throw badItem("fin avant le début");
    start = formatUtc(startMs);
    end = formatUtc(endMs);
  }

  let uid = read.exact("UID", LIMITS.uid);
  if (uid === null && fields.has("UID")) throw badItem("UID");
  if (uid === null || uid === "") {
    if (fallbackUid === null || fallbackUid === undefined) throw badItem("UID absent");
    uid = fallbackUid;
  }

  const organizerEmail = read.optional("OrganizerEmail", () => v.emailAddress(read.exact("OrganizerEmail", 320)));
  const organizerName = read.name("OrganizerName", LIMITS.name);
  const organizer = organizerEmail === null ? null : { email: organizerEmail, name: organizerName };
  if (organizer === null && organizerName !== "") lossy(); // a name without an address is not an organizer
  const status = read.optional("MeetingStatus", (text) => v.integer(text, { min: 0, max: 255 })) ?? 0;
  const isMeeting = (status & 1) !== 0;
  const isOrganizer = organizer !== null && organizer.email.toLowerCase() === mailbox.toLowerCase();
  const role = !isMeeting ? "none" : isOrganizer ? "organizer" : "attendee";
  const cancelled = isMeeting && (status & 4) !== 0;
  // The server and the address disagree on who organizes (an alias, say), or the status is not one of a meeting.
  if ((status & 7) !== meetingStatus(role, cancelled)) lossy();

  let recurrence = null;
  let readOnly = null;
  let exceptions = [];
  if (recurring) {
    const rule = readRecurrence(fields.get("Recurrence"), { allDay, zone });
    ({ recurrence, readOnly } = rule);
    if (!rule.exact) lossy();
    // The rules that need the item (recurrence.mjs, rules 3 to 5): a day that never comes, an event longer
    // than its period. Thunderbird is not given such a rule: the event is shown once, read-only.
    if (recurrence !== null && recurrenceProblem(recurrence, { item: { allDay, start, end, zone } }) !== null) {
      recurrence = null;
      readOnly = "unsupported-recurrence";
    }
    if (recurrence !== null && recurrence.weekStart !== null && version !== "14.1") lossy(); // FirstDayOfWeek is 14.1 only
    if (recurrence !== null && fields.has("Exceptions")) {
      exceptions = readExceptions(fields.get("Exceptions"), { allDay, zone, version, role, lossy });
    }
  }

  const description = {
    kind: "event",
    uid,
    summary: read.line("Subject", LIMITS.summary),
    location: read.line("Location", LIMITS.location),
    // A Change without a Body element does not say that the text is gone.
    description: change === true && bodies.length === 0 ? null : readBody(bodies, lossy) ?? "",
    allDay,
    start,
    end,
    timezone,
    busy: read.member("BusyStatus", BUSY) ?? "busy",
    privacy: readSensitivity(read.exact("Sensitivity"), lossy) ?? "public",
    reminder: read.reminder("Reminder"),
    categories: fields.has("Categories") ? readCategories(fields.get("Categories"), NS, lossy) : [],
    organizer,
    attendees: fields.has("Attendees") ? readAttendees(fields.get("Attendees"), lossy) : [],
    meeting: {
      role,
      cancelled,
      responseRequested: read.flag("ResponseRequested") ?? isMeeting,
      // ResponseType exists from 14.0 on: before, nothing says what the user answered to someone else's meeting.
      response: version === "12.1" && role === "attendee" ? null : RESPONSE.get(read.exact("ResponseType")) ?? "none",
      allowNewTime: read.flag("DisallowNewTimeProposal") !== true,
    },
    recurrence,
    exceptions,
    stamp: null,
    sequence: 0,
    readOnly,
  };
  const stampMs = read.optional("DtStamp", parseCompact);
  if (stampMs !== null) description.stamp = formatUtc(stampMs);
  if (description.readOnly === null && incomplete) description.readOnly = "incomplete";
  return checkEvent(description, { ownEmail: mailbox, fromServer: true });
}

// ── Writing ───────────────────────────────────────────────────────────────

const leaf = (tag, value) => el(`${NS}:${tag}`, String(value));
/** A text of an exception: an empty one is sent as an empty element, which removes the inherited value. */
const leafOrEmpty = (tag, value) => (value === "" ? el(`${NS}:${tag}`) : leaf(tag, value));

function attendeesElement(attendees) {
  return el(
    `${NS}:Attendees`,
    attendees.map((a) =>
      el(`${NS}:Attendee`, [
        leaf("Email", a.email),
        leaf("Name", a.name), // required, even empty ([MS-ASCAL] 2.2.2.3)
        leaf("AttendeeStatus", ATTENDEE_STATUS_CODES.get(a.status)),
        leaf("AttendeeType", ATTENDEE_ROLE_CODES.get(a.role)),
      ]),
    ),
  );
}

const categoriesElement = (categories) => el(`${NS}:Categories`, categories.map((name) => leaf("Category", name)));

/** MeetingStatus ([MS-ASCAL] 2.2.2.28): 1 meeting, 2 received from someone else, 4 cancelled. */
function meetingStatus(role, cancelled) {
  if (role === "none") return 0;
  return 1 | (role === "attendee" ? 2 : 0) | (cancelled ? 4 : 0);
}

/**
 * The texts of the changed occurrences in the description last
 * synchronized: originalStart → description, cleaned as checkEvent cleans.
 */
function occurrenceTexts(previous) {
  const texts = new Map();
  const list = isRecord(previous) ? get(previous, "exceptions") : undefined;
  if (!Array.isArray(list)) return texts;
  for (let i = 0; i < list.length && i < LIMITS.exceptions; i++) {
    const x = list[i];
    if (!isRecord(x) || get(x, "deleted") !== false || !isRecord(get(x, "changes"))) continue;
    const at = get(x, "originalStart");
    const text = get(x.changes, "description");
    if (typeof at === "string" && typeof text === "string") texts.set(at, cleanBlock(text, LIMITS.description));
  }
  return texts;
}

/**
 * Why the change from `previous`, the description last synchronized, to
 * the event cannot be told to the server, or null. The server keeps an
 * exception that a Change leaves out ([MS-ASCAL] 3.2.5.3.1), and keeps
 * the text of an occurrence that is not sent:
 *  - an occurrence that `previous` says is deleted and that the event has
 *    again, or one that was changed and is back in its series (no
 *    exception for it any more): nothing that can be sent undoes the
 *    server's exception. Only a series that is otherwise the same is
 *    judged (same start, same kind, same rule, same zone): moved or
 *    changed, its occurrences are no longer those of `previous`, and its
 *    exceptions are sent as they are;
 *  - a changed occurrence that had a text of its own and has none now: it
 *    takes the text of the series again, which no element says (an empty
 *    Body means "no text"). When the text the server keeps for it is the
 *    text of the series as it is now, nothing differs and nothing is
 *    refused.
 */
function untold(event, previous, texts) {
  if (event.recurrence === null || !isRecord(previous)) return null;
  for (const x of event.exceptions) {
    if (!x.deleted && !has(x.changes, "description") && texts.has(x.originalStart) && texts.get(x.originalStart) !== event.description) {
      return "texte propre à une occurrence retiré";
    }
  }
  const before = get(previous, "exceptions");
  if (!Array.isArray(before)) return null;
  if (get(previous, "start") !== event.start || get(previous, "allDay") !== event.allDay) return null;
  try {
    if (JSON.stringify(checkRecurrence(get(previous, "recurrence"))) !== JSON.stringify(event.recurrence)) return null;
    if (JSON.stringify(checkZone(get(previous, "timezone") ?? UTC_ZONE)) !== JSON.stringify(event.timezone ?? UTC_ZONE)) return null;
  } catch (e) {
    if (!(e instanceof ProtocolError)) throw e;
    return null; // a `previous` that cannot be read says nothing
  }
  const now = new Map(event.exceptions.map((x) => [x.originalStart, x.deleted]));
  for (let i = 0; i < before.length && i < LIMITS.exceptions; i++) {
    const x = before[i];
    if (!isRecord(x) || typeof get(x, "originalStart") !== "string") continue;
    if (get(x, "deleted") === true && now.get(x.originalStart) !== true) return "occurrence supprimée rétablie";
    if (get(x, "deleted") === false && !now.has(x.originalStart)) return "occurrence modifiée remise dans sa série";
  }
  return null;
}

function exceptionElement(exception, event, zone, version, texts) {
  const original = event.allDay ? localMidnightUtc(zone, exception.originalStart) : parseUtc(exception.originalStart);
  const originalStart = leaf("ExceptionStartTime", formatCompact(original));
  if (exception.deleted) return el(`${NS}:Exception`, [leaf("Deleted", "1"), originalStart]);
  const changes = exception.changes;
  const wholeDay = changes.allDay ?? event.allDay;
  const instant = (value) => formatCompact(wholeDay ? localMidnightUtc(zone, value) : parseUtc(value));
  const sent = (key) => has(changes, key);
  // The text of an occurrence is sent as that of the series is: only when it is not the one last synchronized.
  const text = sent("description") && texts.get(exception.originalStart) !== changes.description;
  return el(`${NS}:Exception`, [
    originalStart,
    sent("summary") ? leafOrEmpty("Subject", changes.summary) : null,
    sent("start") ? leaf("StartTime", instant(changes.start)) : null,
    sent("end") ? leaf("EndTime", instant(changes.end)) : null,
    text ? (changes.description === "" ? el("AirSyncBase:Body") : bodyElement(changes.description)) : null,
    sent("location") ? leafOrEmpty("Location", changes.location) : null,
    sent("categories") ? categoriesElement(changes.categories) : null,
    sent("privacy") ? leaf("Sensitivity", PRIVACY_CODES.get(changes.privacy)) : null,
    sent("busy") ? leaf("BusyStatus", BUSY_CODES.get(changes.busy)) : null,
    sent("allDay") ? leaf("AllDayEvent", changes.allDay ? "1" : "0") : null,
    // "No reminder for this occurrence" is an empty element, which exists in 14.1 only ([MS-ASCAL] 2.2.2.38).
    sent("reminder") && changes.reminder !== null ? leaf("Reminder", changes.reminder) : null,
    sent("reminder") && changes.reminder === null && version === "14.1" ? el(`${NS}:Reminder`) : null,
    sent("cancelled") && event.meeting.role !== "none" ? leaf("MeetingStatus", meetingStatus(event.meeting.role, changes.cancelled)) : null,
    // Attendees of one occurrence exist from 14.0 on ([MS-ASCAL] 2.2.2.4).
    sent("attendees") && version !== "12.1" ? attendeesElement(changes.attendees) : null,
  ]);
}

/**
 * An event description → the children of ApplicationData, for an Add as
 * for a Change.
 *
 *  - The description is checked first (checkEvent); a read-only item is
 *    refused (code "READ_ONLY_ITEM").
 *  - Every property named in calendarSupported(version) is written, or
 *    left out when it has no value, which deletes it on the server.
 *    ResponseType and AppointmentReplyTime are never sent, nor is any
 *    element `version` does not define.
 *  - `timezone` null is sent as UTC. All-day events are sent as local
 *    midnights in that zone: for an event made in Thunderbird, give it the
 *    user's zone.
 *  - `previous`: for a Change, the description last synchronized. The body
 *    is sent only when the description differs from it; for an Add (no
 *    `previous`), when there is one. The same holds for the text of each
 *    changed occurrence, against the text that occurrence had in
 *    `previous`: left out, a text is kept by the server, which may hold a
 *    richer form of it.
 *  - Exceptions: each one is sent; one that is no longer in the
 *    description stays on the server, the protocol has no way to remove it
 *    ([MS-ASCAL] 3.2.5.3.1). An occurrence that `previous` says is deleted
 *    and that the event has again, or one that was changed and is back in
 *    its series, can therefore not be told: the change is refused, code
 *    "UNSUPPORTED_CHANGE". That is judged only while the series itself is
 *    the same (start, kind, rule and zone). So is refused a changed
 *    occurrence that lost its own text for that of the series, unless the
 *    text the server keeps for it is the series' text as it is now.
 */
export function writeEvent(event, { version, previous = null } = {}) {
  checkVersion(version);
  const e = checkEvent(event);
  if (e.readOnly !== null) throw conversionError("READ_ONLY_ITEM", "élément en lecture seule");
  const texts = occurrenceTexts(previous);
  const reason = untold(e, previous, texts);
  if (reason !== null) throw conversionError("UNSUPPORTED_CHANGE", `modification impossible à transmettre (${reason})`);
  const zone = e.timezone ?? UTC_ZONE;
  const instant = (value) => formatCompact(e.allDay ? localMidnightUtc(zone, value) : parseUtc(value));
  const since14 = version !== "12.1";
  return [
    leaf("Timezone", encodeTimeZone(zone)),
    e.stamp === null ? null : leaf("DtStamp", formatCompact(parseUtc(e.stamp))),
    leaf("StartTime", instant(e.start)),
    e.summary === "" ? null : leaf("Subject", e.summary),
    leaf("UID", e.uid),
    e.attendees.length ? attendeesElement(e.attendees) : null,
    e.organizer === null || e.organizer.name === "" ? null : leaf("OrganizerName", e.organizer.name),
    e.organizer === null ? null : leaf("OrganizerEmail", e.organizer.email),
    e.location === "" ? null : leaf("Location", e.location),
    leaf("EndTime", instant(e.end)),
    e.recurrence === null
      ? null
      : el(`${NS}:Recurrence`, writeRecurrence(e.recurrence, { version, start: e.start, allDay: e.allDay, zone })),
    bodyChanged(e.description, previous) ? bodyElement(e.description) : null,
    leaf("Sensitivity", PRIVACY_CODES.get(e.privacy)),
    leaf("BusyStatus", BUSY_CODES.get(e.busy)),
    leaf("AllDayEvent", e.allDay ? "1" : "0"),
    e.reminder === null ? null : leaf("Reminder", e.reminder),
    e.exceptions.length ? el(`${NS}:Exceptions`, e.exceptions.map((x) => exceptionElement(x, e, zone, version, texts))) : null,
    leaf("MeetingStatus", meetingStatus(e.meeting.role, e.meeting.cancelled)),
    since14 ? leaf("ResponseRequested", e.meeting.responseRequested ? "1" : "0") : null,
    since14 ? leaf("DisallowNewTimeProposal", e.meeting.allowNewTime ? "0" : "1") : null,
    e.categories.length ? categoriesElement(e.categories) : null,
  ].filter(Boolean);
}

// ── Sync options ──────────────────────────────────────────────────────────

/** Elements a client must name in Supported to synchronize a calendar ([MS-ASCMD] 2.2.3.179). */
const SUPPORTED_REQUIRED = [
  "DtStamp", "Categories", "Sensitivity", "BusyStatus", "UID", "Timezone", "StartTime", "Subject", "Location",
  "EndTime", "Recurrence", "AllDayEvent", "Reminder", "Exceptions",
];
/** Optional ones this module reads and writes; the last two cannot be named before 14.0. */
const SUPPORTED_OPTIONAL = ["Attendees", "OrganizerName", "OrganizerEmail", "MeetingStatus"];
const SUPPORTED_SINCE_14 = ["ResponseRequested", "DisallowNewTimeProposal"];

/**
 * The element names for the Supported element of a calendar collection,
 * with their namespace ("Calendar:Subject"): every property this module
 * reads and writes back. What is not named (and can be ghosted) is kept by
 * the server when a Change leaves it out.
 */
export function calendarSupported(version) {
  checkVersion(version);
  const names = [...SUPPORTED_REQUIRED, ...SUPPORTED_OPTIONAL, ...(version === "12.1" ? [] : SUPPORTED_SINCE_14)];
  return Object.freeze(names.map((name) => `${NS}:${name}`));
}

/**
 * Options children of a Sync collection of calendar items: the period
 * (FilterType, see CALENDAR_FILTER_TYPES; given as a string or a number)
 * and the body as plain text of bounded size. Any other period is refused
 * (ProtocolError).
 */
export function calendarOptions({ filterType } = {}) {
  const period = typeof filterType === "string" || typeof filterType === "number" ? String(filterType) : "";
  if (!CALENDAR_FILTER_TYPES.includes(period)) throw new ProtocolError("période invalide pour le calendrier");
  return [el("AirSync:FilterType", period), bodyPreference()];
}
