// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * iTIP messages written by Sync443 (RFC 5546): the invitation, the
 * cancellation and the reply, as an iCalendar object (RFC 5545) and as the
 * Internet message that carries it (RFC 6047, RFC 5322, RFC 2045 to 2047),
 * ready for SendMail.
 *
 *   itipCalendar({ method, event, attendees, replyStatus, stamp, sequence, occurrence }) → string
 *   itipMessage({ method, calendar, from, to, subject, text, date, messageId })          → Uint8Array
 *
 * What goes in comes from an event description (docs/CALENDAR-DESIGN.md),
 * whose texts were typed by the user or, for a reply, chosen by the
 * organizer of a meeting. Nothing of it can change the structure of what
 * goes out:
 *  - every text is cleaned here, whatever was cleaned before it came (see
 *    strictText): no control, bidirectional or invisible character goes out;
 *  - every TEXT value is escaped (backslash, semicolon, comma, line break);
 *  - a parameter value (CN) is quoted, without quote, caret or control;
 *  - an address is validated, then written as a mailto: URI;
 *  - numbers, dates and enumerations are written from checked values, never
 *    copied from the description;
 *  - every content line goes through foldLine, which refuses a control
 *    character: no CR or LF from data can reach the output;
 *  - in the message, header values are printable ASCII (names and subject
 *    as RFC 2047 encoded-words when they are not), and both parts are
 *    base64, in which no boundary line can be written;
 *  - the To field holds addresses and nothing else: no display name, which
 *    whoever invited the user could have written to look like more
 *    recipients (the names stay in the calendar, as CN parameters).
 *
 * Refusals are ItipError, with a `code`: ITIP_ARGUMENT, ITIP_EVENT,
 * ITIP_ORGANIZER, ITIP_ADDRESS, ITIP_RECIPIENTS, ITIP_TOO_LARGE.
 */

import * as v from "./sanitize.mjs";
import { encodeUtf8 } from "./utf8.mjs";
import { base64 } from "./base64.mjs";
import { sha256, toHex } from "./sha256.mjs";
import { checkZone, offsetMinutesAt, parseUtc, parseDate } from "./eas-timezone.mjs";

/** Most attendees a meeting message lists, and most recipients it is sent to (docs/CALENDAR-DESIGN.md, rule 25). */
export const MAX_MEETING_RECIPIENTS = 100;
/** Largest iCalendar text written or wrapped, in characters. */
export const MAX_CALENDAR_LENGTH = 4 * 1024 * 1024;
/** Longest plain-text part of a message, in characters. */
export const MAX_TEXT_LENGTH = 64 * 1024;

const MAX_UID = 300;
const MAX_SUMMARY = 1024;
const MAX_LOCATION = 1024;
const MAX_DESCRIPTION = 32768;
const MAX_NAME = 256;
const MAX_EXCEPTIONS = 256;
const MAX_SEQUENCE = 2147483647;
const PRODID = "-//Sync443//Sync443//EN";
const METHODS = new Set(["REQUEST", "CANCEL", "REPLY"]);
const MINUTE = 60_000;

export class ItipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ItipError";
    this.code = code;
  }
}

const fail = (code, reason) => {
  throw new ItipError(code, reason);
};

const isObject = (x) => Boolean(x) && typeof x === "object" && !Array.isArray(x);
const isInteger = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;
const pad = (n, width = 2) => String(n).padStart(width, "0");

// ── Text, parameters, lines ───────────────────────────────────────────────

/**
 * A text as this module writes it, for other people to read: controls
 * removed, every kind of line break made one line feed (or a space with
 * `singleLine`), bidirectional and invisible characters removed, lone
 * surrogates replaced, and the whole cut to `max` characters.
 *
 * This cleaning is the writer's own. It does not rely on what the readers
 * of the server's items let through (they keep U+200C and U+200D in titles
 * and places, which are removed here like every character nobody sees),
 * nor on what the calendar let the user type.
 */
export function strictText(value, { max = MAX_DESCRIPTION, singleLine = false } = {}) {
  if (typeof value !== "string") return "";
  // Lone surrogates are replaced first: what is searched next is text, in which no half character can hide another.
  const clean = v.cleanText(value.toWellFormed(), { max: value.length, singleLine }).replace(v.UNSEEN, "");
  return v.cut(clean, max);
}

/**
 * A TEXT value (RFC 5545 3.3.11): backslash, semicolon and comma escaped
 * with a backslash, a line break written "\n" (backslash, letter n). Before
 * that the text is cleaned and cut to `max` characters (strictText).
 */
export function escapeText(value, { max = MAX_DESCRIPTION, singleLine = false } = {}) {
  return strictText(value, { max, singleLine }).replace(/[\\;,]/g, "\\$&").replace(/\n/g, "\\n");
}

/**
 * One content line folded (RFC 5545 3.1): at most 75 octets of UTF-8 per
 * physical line, the next ones starting with a space that counts among
 * their 75. A line is cut between characters only, never inside a UTF-8
 * sequence or a surrogate pair. → the physical lines joined by CRLF, without
 * a final CRLF.
 *
 * Every line of the calendar goes through here, and a control character
 * is refused (C0 and C1, CR and LF first of all; the tab is allowed, as in
 * TEXT values), like the Unicode line and paragraph separators, which some
 * readers take for line ends: whatever a value holds, it cannot start a
 * line of its own.
 */
export function foldLine(line) {
  if (typeof line !== "string" || !line.isWellFormed()) fail("ITIP_ARGUMENT", "ligne iCalendar invalide");
  const parts = [];
  let from = 0;
  let width = 0;
  let room = 75;
  for (let i = 0; i < line.length; ) {
    const cp = line.codePointAt(i);
    if ((cp < 0x20 && cp !== 0x09) || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) {
      fail("ITIP_ARGUMENT", "caractère de contrôle dans une ligne iCalendar");
    }
    const octets = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (width + octets > room) {
      parts.push(line.slice(from, i));
      from = i;
      width = 0;
      room = 74; // the leading space takes one
    }
    width += octets;
    i += cp > 0xffff ? 2 : 1;
  }
  parts.push(line.slice(from));
  return parts.join("\r\n ");
}

/**
 * A display name for a CN parameter or a message header: one line, without
 * control, bidirectional or invisible character (sanitize.personName, then
 * this module's own cleaning), "" when nothing visible remains.
 */
const displayName = (name) => strictText(v.personName(typeof name === "string" ? name : "", { max: MAX_NAME }) ?? "", { max: MAX_NAME, singleLine: true }).trim();

/**
 * The CN parameter of a person, or "". The value is always quoted (RFC 5545
 * 3.2: a quoted value may hold colons, semicolons and commas), so the name
 * loses its double quotes, which nothing can escape there. It loses its
 * carets too: readers that know RFC 6868 turn "^n" into a line break and
 * "^'" into a quote.
 */
function cnParameter(name) {
  const clean = displayName(name).replace(/["^]/g, "").replace(/ {2,}/g, " ").trim();
  return clean ? `;CN="${clean}"` : "";
}

/** Characters of a local part that a mailto: URI cannot hold as they are (RFC 6068 section 2). */
const MAILTO_ENCODED = /[#%&/=?^`{|}]/g;

/**
 * The calendar address of a person: "mailto:" and the address, validated by
 * sanitize.emailAddress (dot-atom local part, host name: no blank, no
 * colon, semicolon, comma or quote can be in it). Refused with `code`
 * otherwise.
 */
function calendarAddress(email, code) {
  const address = v.emailAddress(email);
  if (address === null) fail(code, "adresse invalide dans un message de réunion");
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at).replace(MAILTO_ENCODED, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `mailto:${local}${address.slice(at)}`;
}

// ── Dates ─────────────────────────────────────────────────────────────────

/**
 * A UTC ("YYYY-MM-DDTHH:MM:SSZ") or a DATE ("YYYY-MM-DD") of an item
 * description → { ms, date }: the instant (midnight UTC for a DATE) and
 * whether it is a DATE; null when it is neither, not a real day, or outside
 * the years 1900 to 2200 (eas-timezone.mjs, parseUtc and parseDate).
 */
function moment(value) {
  const utc = parseUtc(value);
  if (utc !== null) return { ms: utc, date: false };
  const day = parseDate(value);
  return day === null ? null : { ms: day, date: true };
}

/**
 * The instant of a message (DTSTAMP, Date): a UTC of the item descriptions,
 * a Date or a number of milliseconds → milliseconds on a whole second, or
 * null (not a date, or outside the years 1900 to 2200).
 */
function instant(value) {
  if (typeof value === "string") {
    const m = moment(value);
    return m && !m.date ? m.ms : null;
  }
  const ms = value instanceof Date ? value.getTime() : value;
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  return year >= 1900 && year <= 2200 ? Math.floor(ms / 1000) * 1000 : null;
}

/** "YYYYMMDD" of an instant, read in UTC. */
function dayText(ms) {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** "YYYYMMDDTHHMMSS" of an instant, read in UTC. */
function timeText(ms) {
  const d = new Date(ms);
  const clock = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((part) => pad(part));
  return `${dayText(ms)}T${clock.join("")}`;
}

// ── Time zone ─────────────────────────────────────────────────────────────

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
/** Year of the first onset written in a VTIMEZONE: before any date an event can have. */
const ZONE_BASE_YEAR = 1601;

/** "+HHMM" or "-HHMM" of an offset in minutes east of UTC (never "-0000", which RFC 5545 forbids). */
const offsetText = (minutes) => `${minutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`;

/** A change of a zone as "M<month>.<week>.<weekday>.<HHMM>", for the name of the zone. */
const changeName = (c) => `M${c.month}.${c.week}.${c.weekday}.${pad(c.hour)}${pad(c.minute)}`;

/** "YYYYMMDDTHHMMSS" of the first time a yearly change happens from ZONE_BASE_YEAR on (local time before the change). */
function firstOnset(change) {
  const first = new Date(Date.UTC(ZONE_BASE_YEAR, change.month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(ZONE_BASE_YEAR, change.month, 0)).getUTCDate();
  let day = 1 + ((change.weekday - first + 7) % 7) + (change.week - 1) * 7;
  while (day > daysInMonth) day -= 7; // week 5 is the last one the month has
  return `${pad(ZONE_BASE_YEAR, 4)}${pad(change.month)}${pad(day)}T${pad(change.hour)}${pad(change.minute)}00`;
}

/** RRULE of a yearly change: the n-th (or last) given weekday of a month. */
const changeRule = (c) => `RRULE:FREQ=YEARLY;BYMONTH=${c.month};BYDAY=${c.week === 5 ? -1 : c.week}${WEEKDAYS[c.weekday]}`;

/**
 * What writing local times in the zone of an event needs, or null when the
 * times are to be written in UTC: no zone, or UTC itself. (checkZone keeps
 * offsets within 14 hours: "+HHMM" can always say them.)
 *
 *  - tzid: a name of ours made of the numbers of the zone ("Sync443/UTC+0100"
 *    for a fixed offset; with the daylight offset and both changes
 *    otherwise). Names received with a zone are never used.
 *  - lines: the VTIMEZONE, with the standard and daylight offsets
 *    -(bias + standard.bias) and -(bias + daylight.bias) and one yearly rule
 *    for each change.
 *  - local(ms) → { text, exact }: the local time of an instant, and whether
 *    a reader gets that instant back from it. Not when the offset in force
 *    is not one the VTIMEZONE states, nor for the second pass of an hour
 *    that happens twice when clocks go back, which RFC 5545 3.3.5 reads as
 *    the first pass: such a time is written in UTC instead.
 *  - used: set once a line refers to the zone; only then is the VTIMEZONE written.
 */
function zoneClock(description) {
  if (description === null || description === undefined) return null;
  let zone;
  try {
    zone = checkZone(description);
  } catch {
    fail("ITIP_EVENT", "fuseau horaire invalide");
  }
  const standard = -(zone.bias + zone.standard.bias);
  const changes = zone.standard.change !== null && zone.daylight.change !== null;
  const daylight = changes ? -(zone.bias + zone.daylight.bias) : standard;
  const fixed = standard === daylight;
  if (fixed && standard === 0) return null;

  const tzid = fixed
    ? `Sync443/UTC${offsetText(standard)}`
    : `Sync443/UTC${offsetText(standard)}/DST${offsetText(daylight)}/${changeName(zone.daylight.change)}/${changeName(zone.standard.change)}`;
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tzid}`];
  if (fixed) {
    lines.push("BEGIN:STANDARD", `DTSTART:${pad(ZONE_BASE_YEAR, 4)}0101T000000`, `TZOFFSETFROM:${offsetText(standard)}`, `TZOFFSETTO:${offsetText(standard)}`, "END:STANDARD");
  } else {
    lines.push(
      "BEGIN:STANDARD",
      `DTSTART:${firstOnset(zone.standard.change)}`,
      `TZOFFSETFROM:${offsetText(daylight)}`,
      `TZOFFSETTO:${offsetText(standard)}`,
      changeRule(zone.standard.change),
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      `DTSTART:${firstOnset(zone.daylight.change)}`,
      `TZOFFSETFROM:${offsetText(standard)}`,
      `TZOFFSETTO:${offsetText(daylight)}`,
      changeRule(zone.daylight.change),
      "END:DAYLIGHT",
    );
  }
  lines.push("END:VTIMEZONE");

  const local = (ms) => {
    const offset = offsetMinutesAt(zone, ms);
    const wall = ms + offset * MINUTE;
    let exact = offset === standard || offset === daylight;
    for (const other of [standard, daylight]) {
      if (other === offset) continue;
      const twin = wall - other * MINUTE; // the other instant that shows the same local time, if that offset is in force then
      if (twin < ms && offsetMinutesAt(zone, twin) === other) exact = false;
    }
    return { text: timeText(wall), exact };
  };
  return { tzid, lines, local, used: false };
}

/**
 * A property holding one date: VALUE=DATE for a DATE; local time with TZID
 * when the event has a zone and that form is exact (see zoneClock) or
 * `forceLocal` is set; UTC otherwise.
 */
function momentLine(name, at, clock, forceLocal = false) {
  if (at.date) return `${name};VALUE=DATE:${dayText(at.ms)}`;
  if (clock) {
    const local = clock.local(at.ms);
    if (local.exact || forceLocal) {
      clock.used = true;
      return `${name};TZID=${clock.tzid}:${local.text}`;
    }
  }
  return `${name}:${timeText(at.ms)}Z`;
}

// ── Recurrence ────────────────────────────────────────────────────────────

const FREQUENCIES = new Map([["daily", "DAILY"], ["weekly", "WEEKLY"], ["monthly", "MONTHLY"], ["yearly", "YEARLY"]]);
const absent = (x) => x === null || x === undefined;

/**
 * RRULE of a Recurrence description. Every part is written from a checked
 * value. UNTIL takes the form RFC 5545 3.3.10 requires: a DATE when the
 * series starts on a DATE, a UTC time otherwise (the end of the day for an
 * `until` given as a DATE).
 */
function recurrenceLine(rule, allDay) {
  const bad = () => fail("ITIP_EVENT", "récurrence invalide");
  if (!isObject(rule)) bad();
  const freq = FREQUENCIES.get(rule.freq);
  const interval = absent(rule.interval) ? 1 : rule.interval;
  if (!freq || !isInteger(interval, 1, 999)) bad();
  const parts = [`FREQ=${freq}`];
  if (!absent(rule.count) && !absent(rule.until)) bad();
  if (!absent(rule.count)) {
    if (!isInteger(rule.count, 1, 999)) bad();
    parts.push(`COUNT=${rule.count}`);
  }
  if (!absent(rule.until)) {
    const until = moment(rule.until);
    if (!until) bad();
    if (allDay) parts.push(`UNTIL=${dayText(until.ms)}`);
    else parts.push(`UNTIL=${until.date ? `${dayText(until.ms)}T235959` : timeText(until.ms)}Z`);
  }
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  const byDay = absent(rule.byDay) ? [] : rule.byDay;
  if (!Array.isArray(byDay) || byDay.length > 7 || new Set(byDay).size !== byDay.length || byDay.some((d) => !WEEKDAYS.includes(d))) bad();
  if (byDay.length) parts.push(`BYDAY=${byDay.join(",")}`);
  if (!absent(rule.byMonthDay)) {
    if (!isInteger(rule.byMonthDay, 1, 31)) bad();
    parts.push(`BYMONTHDAY=${rule.byMonthDay}`);
  }
  if (!absent(rule.byMonth)) {
    if (!isInteger(rule.byMonth, 1, 12)) bad();
    parts.push(`BYMONTH=${rule.byMonth}`);
  }
  if (!absent(rule.bySetPos)) {
    // A position chooses among the days of BYDAY: alone it means nothing.
    if (!(rule.bySetPos === -1 || isInteger(rule.bySetPos, 1, 4)) || !byDay.length) bad();
    parts.push(`BYSETPOS=${rule.bySetPos}`);
  }
  if (!absent(rule.weekStart)) {
    if (!WEEKDAYS.includes(rule.weekStart)) bad();
    parts.push(`WKST=${rule.weekStart}`);
  }
  return `RRULE:${parts.join(";")}`;
}

// ── People ────────────────────────────────────────────────────────────────

const ROLES = new Map([
  ["required", ";ROLE=REQ-PARTICIPANT"],
  ["optional", ";ROLE=OPT-PARTICIPANT"],
  ["resource", ";CUTYPE=RESOURCE;ROLE=NON-PARTICIPANT"],
]);
const REPLIES = new Map([["accepted", "ACCEPTED"], ["tentative", "TENTATIVE"], ["declined", "DECLINED"]]);

/** The list of people a message names: 1 to MAX_MEETING_RECIPIENTS objects. */
function peopleOf(list) {
  if (!Array.isArray(list) || list.length < 1) fail("ITIP_RECIPIENTS", "aucun participant");
  if (list.length > MAX_MEETING_RECIPIENTS) fail("ITIP_RECIPIENTS", `plus de ${MAX_MEETING_RECIPIENTS} participants`);
  if (!list.every(isObject)) fail("ITIP_RECIPIENTS", "liste de participants invalide");
  return list;
}

/** ATTENDEE lines: `parameters(person)` gives what comes before the CN. */
const attendeeLines = (people, parameters) =>
  people.map((p) => `ATTENDEE${parameters(p)}${cnParameter(p.name)}:${calendarAddress(p.email, "ITIP_ADDRESS")}`);

/** ATTENDEE parameters of an invitation: the role, no answer yet, an answer wanted. */
const invited = (p) => `${ROLES.get(p.role) ?? ROLES.get("required")};PARTSTAT=NEEDS-ACTION;RSVP=TRUE`;

// ── Event ─────────────────────────────────────────────────────────────────

const TRANSPARENCY = new Map([["free", "TRANSPARENT"], ["tentative", "OPAQUE"], ["busy", "OPAQUE"], ["away", "OPAQUE"]]);
const CLASSES = new Map([["public", "PUBLIC"], ["private", "PRIVATE"], ["confidential", "CONFIDENTIAL"]]);

/** Start and end of an event or of an exception: both of the type `allDay` says, the end not before the start. */
function span(allDay, startValue, endValue) {
  const start = moment(startValue);
  const end = moment(endValue);
  if (typeof allDay !== "boolean" || !start || !end || start.date !== allDay || end.date !== allDay || end.ms < start.ms) {
    fail("ITIP_EVENT", "dates de l'événement invalides");
  }
  return { allDay, start, end };
}

/** DTSTART and DTEND. An end equal to the start is left out, as RFC 5545 3.6.1 has it (DTEND is later than DTSTART). */
function spanLines({ start, end }, clock, forceLocal) {
  const lines = [momentLine("DTSTART", start, clock, forceLocal)];
  if (end.ms > start.ms) lines.push(momentLine("DTEND", end, clock));
  return lines;
}

/**
 * SUMMARY (always: RFC 5546 wants it in a REQUEST, even empty), LOCATION and DESCRIPTION when they hold something
 * once cleaned (a place or a text made of blanks and of characters nobody sees holds nothing).
 */
function textLines(summary, location, description) {
  const lines = [`SUMMARY:${escapeText(summary, { max: MAX_SUMMARY, singleLine: true })}`];
  const where = escapeText(location, { max: MAX_LOCATION, singleLine: true });
  if (where.trim()) lines.push(`LOCATION:${where}`);
  const what = escapeText(description, { max: MAX_DESCRIPTION });
  if (what.trim()) lines.push(`DESCRIPTION:${what}`);
  return lines;
}

function statusLines(busy, privacy) {
  const transparency = TRANSPARENCY.get(busy);
  const classification = CLASSES.get(privacy);
  if (!transparency || !classification) fail("ITIP_EVENT", "disponibilité ou confidentialité invalide");
  return [`TRANSP:${transparency}`, `CLASS:${classification}`];
}

/**
 * The exceptions of a series, checked: at most MAX_EXCEPTIONS, each with an
 * original start of the type of the series (a DATE for an all-day series, a
 * UTC time otherwise: RECURRENCE-ID and EXDATE must have the type of
 * DTSTART), no two for the same occurrence.
 */
function exceptionsOf(event, allDay) {
  const list = absent(event.exceptions) ? [] : event.exceptions;
  if (!Array.isArray(list) || list.length > MAX_EXCEPTIONS) fail("ITIP_EVENT", "exceptions invalides");
  const seen = new Set();
  return list.map((x) => {
    const original = isObject(x) ? moment(x.originalStart) : null;
    if (!original || original.date !== allDay || seen.has(original.ms) || typeof x.deleted !== "boolean") fail("ITIP_EVENT", "exception invalide");
    if (!absent(x.changes) && !isObject(x.changes)) fail("ITIP_EVENT", "exception invalide");
    seen.add(original.ms);
    return { original, deleted: x.deleted, changes: x.changes ?? {} };
  });
}

/** Start and end of one occurrence: what its exception changes, the original start and the length of the series otherwise. */
function occurrenceSpan(master, original, changes) {
  const allDay = absent(changes.allDay) ? master.allDay : changes.allDay;
  if (allDay !== master.allDay && (absent(changes.start) || absent(changes.end))) fail("ITIP_EVENT", "exception invalide");
  const start = absent(changes.start) ? original : moment(changes.start);
  if (!start) fail("ITIP_EVENT", "exception invalide");
  const end = absent(changes.end) ? { ms: start.ms + (master.end.ms - master.start.ms), date: start.date } : moment(changes.end);
  if (typeof allDay !== "boolean" || !end || start.date !== allDay || end.date !== allDay || end.ms < start.ms) fail("ITIP_EVENT", "exception invalide");
  return { allDay, start, end };
}

/**
 * The iCalendar object of one iTIP message (RFC 5546 3.2), as text: CRLF
 * line ends, lines folded at 75 octets.
 *
 *  - method: "REQUEST", "CANCEL" or "REPLY".
 *  - event: an event description. Its organizer is required (ITIP_ORGANIZER).
 *  - attendees: the people the message lists, 1 to MAX_MEETING_RECIPIENTS
 *    ({ email, name, role? }); for a REPLY exactly one, the user.
 *  - replyStatus: "accepted", "tentative" or "declined" (REPLY only).
 *  - stamp: when the message is written (a UTC of the descriptions, a Date
 *    or milliseconds).
 *  - sequence: SEQUENCE, 0 to 2147483647.
 *  - occurrence: null, or the original start of the one occurrence the
 *    message is about (RECURRENCE-ID).
 *
 * REQUEST without `occurrence` carries the whole event: the series (RRULE,
 * one EXDATE for each deleted occurrence) and one more VEVENT for each
 * changed occurrence. With `occurrence`, it carries that occurrence alone.
 * Reminders are left out: an alarm is each attendee's own business.
 *
 * CANCEL carries UID, SEQUENCE, DTSTAMP, ORGANIZER, the attendees, DTSTART
 * and SUMMARY, and STATUS:CANCELLED, which RFC 5546 3.2.5 keeps for an event
 * (or an occurrence) cancelled for everyone. It is left out when none of the
 * listed attendees is among the attendees of `event` any more: they are
 * being removed from a meeting that goes on, for which the same section
 * forbids it.
 *
 * REPLY carries UID, SEQUENCE, DTSTAMP, ORGANIZER, the user's ATTENDEE line
 * with PARTSTAT, DTSTART and SUMMARY.
 *
 * Times: VALUE=DATE for an all-day event; local time with a TZID and a
 * VTIMEZONE of ours when the event has a zone (see zoneClock); UTC
 * otherwise. The DTSTART of a series keeps its zone in every case, since
 * the rule is unfolded in local time.
 *
 * Throws ItipError: more than MAX_MEETING_RECIPIENTS attendees or none
 * (ITIP_RECIPIENTS), an invalid address (ITIP_ADDRESS), no valid organizer
 * (ITIP_ORGANIZER), an event that does not follow the contract (ITIP_EVENT),
 * another invalid argument (ITIP_ARGUMENT), a result above
 * MAX_CALENDAR_LENGTH (ITIP_TOO_LARGE).
 */
export function itipCalendar({ method, event, attendees, replyStatus = null, stamp, sequence, occurrence = null } = {}) {
  if (!METHODS.has(method)) fail("ITIP_ARGUMENT", "méthode iTIP invalide");
  if (!isObject(event) || event.kind !== "event") fail("ITIP_EVENT", "description d'événement invalide");
  const stampMs = instant(stamp);
  if (stampMs === null) fail("ITIP_ARGUMENT", "date du message invalide");
  if (!isInteger(sequence, 0, MAX_SEQUENCE)) fail("ITIP_ARGUMENT", "numéro de séquence invalide");
  const reply = REPLIES.get(replyStatus);
  if (method === "REPLY" ? !reply : !absent(replyStatus)) fail("ITIP_ARGUMENT", "réponse invalide");

  // The UID is written as it is (escaped) or not at all: a cleaned UID would name another meeting.
  const { uid } = event;
  if (typeof uid !== "string" || uid.length < 1 || uid.length > MAX_UID || !uid.isWellFormed()) fail("ITIP_EVENT", "identifiant de réunion invalide");
  if (strictText(uid, { max: MAX_UID, singleLine: true }) !== uid) fail("ITIP_EVENT", "identifiant de réunion invalide");
  if (!isObject(event.organizer)) fail("ITIP_ORGANIZER", "réunion sans organisateur");
  const organizer = `ORGANIZER${cnParameter(event.organizer.name)}:${calendarAddress(event.organizer.email, "ITIP_ORGANIZER")}`;
  const people = peopleOf(attendees);
  if (method === "REPLY" && people.length !== 1) fail("ITIP_RECIPIENTS", "une réponse ne nomme que son auteur");

  const master = span(event.allDay, event.start, event.end);
  const clock = master.allDay ? null : zoneClock(event.timezone);
  const recurring = !absent(event.recurrence);
  const exceptions = exceptionsOf(event, master.allDay);
  let target = null;
  if (!absent(occurrence)) {
    target = moment(occurrence);
    if (!target || target.date !== master.allDay) fail("ITIP_ARGUMENT", "occurrence invalide");
  }
  const exceptionAt = (original) => exceptions.find((x) => x.original.ms === original.ms) ?? null;

  const head = [`UID:${escapeText(uid, { max: MAX_UID, singleLine: true })}`, `SEQUENCE:${sequence}`, `DTSTAMP:${timeText(stampMs)}Z`, organizer];
  const events = [];

  /** One occurrence of a REQUEST: what its exception changes, the rest from the series. */
  const occurrenceEvent = (original, changes, listed) => {
    const own = Array.isArray(changes.attendees) && changes.attendees.length ? attendeeLines(peopleOf(changes.attendees), invited) : listed;
    events.push([
      "BEGIN:VEVENT",
      ...head,
      ...own,
      momentLine("RECURRENCE-ID", original, clock),
      ...spanLines(occurrenceSpan(master, original, changes), clock, false),
      ...textLines(changes.summary ?? event.summary, changes.location ?? event.location, changes.description ?? event.description),
      ...statusLines(changes.busy ?? event.busy, changes.privacy ?? event.privacy),
      ...(changes.cancelled === true ? ["STATUS:CANCELLED"] : []),
      "END:VEVENT",
    ]);
  };

  if (method === "REQUEST") {
    const listed = attendeeLines(people, invited);
    if (target) {
      const exception = exceptionAt(target);
      if (exception?.deleted) fail("ITIP_ARGUMENT", "occurrence supprimée");
      occurrenceEvent(target, exception?.changes ?? {}, listed);
    } else {
      events.push([
        "BEGIN:VEVENT",
        ...head,
        ...listed,
        ...spanLines(master, clock, recurring),
        ...(recurring ? [recurrenceLine(event.recurrence, master.allDay)] : []),
        ...(recurring ? exceptions.filter((x) => x.deleted).map((x) => momentLine("EXDATE", x.original, clock)) : []),
        ...textLines(event.summary, event.location, event.description),
        ...statusLines(event.busy, event.privacy),
        "END:VEVENT",
      ]);
      if (recurring) for (const x of exceptions) if (!x.deleted) occurrenceEvent(x.original, x.changes, listed);
    }
  } else {
    // CANCEL and REPLY say which meeting, or which occurrence, and when it starts.
    let start = master.start;
    if (target) {
      const exception = exceptionAt(target);
      start = exception && !exception.deleted ? occurrenceSpan(master, target, exception.changes).start : target;
    }
    let listed;
    let status = [];
    if (method === "REPLY") {
      listed = attendeeLines(people, () => `;PARTSTAT=${reply}`);
    } else {
      listed = attendeeLines(people, () => "");
      const current = new Set((Array.isArray(event.attendees) ? event.attendees : []).map((a) => (typeof a?.email === "string" ? a.email.trim().toLowerCase() : "")));
      const removedOnly = people.every((p) => !current.has(p.email.trim().toLowerCase()));
      if (!removedOnly) status = ["STATUS:CANCELLED"];
    }
    events.push([
      "BEGIN:VEVENT",
      ...head,
      ...listed,
      ...(target ? [momentLine("RECURRENCE-ID", target, clock)] : []),
      momentLine("DTSTART", start, clock, recurring && !target),
      `SUMMARY:${escapeText(event.summary, { max: MAX_SUMMARY, singleLine: true })}`,
      ...status,
      "END:VEVENT",
    ]);
  }

  const lines = ["BEGIN:VCALENDAR", `PRODID:${PRODID}`, "VERSION:2.0", `METHOD:${method}`, ...(clock?.used ? clock.lines : []), ...events.flat(), "END:VCALENDAR"];
  let length = 0;
  const folded = lines.map((line) => {
    const out = foldLine(line);
    length += out.length + 2;
    if (length > MAX_CALENDAR_LENGTH) fail("ITIP_TOO_LARGE", "message de réunion trop volumineux");
    return out;
  });
  return `${folded.join("\r\n")}\r\n`;
}

// ── Message ───────────────────────────────────────────────────────────────

const PRINTABLE = /^[\x20-\x7e]*$/;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A Message-ID without its angle brackets: dot-atom characters, "@", a host name; at most 250 characters. */
const MESSAGE_ID = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,180}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,66}[A-Za-z0-9])?$/;
/** UTF-8 bytes in one encoded-word: 52 base64 characters, 64 in all, so "Subject: " and one word stay within 76. */
const ENCODED_WORD_BYTES = 39;

/**
 * RFC 2047 encoded-words ("B", UTF-8) for a text: each within 75
 * characters, each holding whole characters (section 5: a multi-octet
 * character is never split between two words). Readers join adjacent words
 * without the blank that separates them.
 */
function encodedWords(text) {
  const words = [];
  let bytes = [];
  for (const ch of text) {
    const more = encodeUtf8(ch);
    if (bytes.length + more.length > ENCODED_WORD_BYTES) {
      words.push(`=?UTF-8?B?${base64(bytes)}?=`);
      bytes = [];
    }
    bytes.push(...more);
  }
  if (bytes.length) words.push(`=?UTF-8?B?${base64(bytes)}?=`);
  return words;
}

/** Plain ASCII that can stand in a header as it is: printable, and nothing a reader could take for an encoded-word. */
const isPlain = (s) => PRINTABLE.test(s) && !s.includes("=?");

/** The address of a mailbox, validated (sanitize.emailAddress); refused with `code` otherwise. */
function mailboxAddress(person, code) {
  if (!isObject(person)) fail(code, "adresse invalide dans un message de réunion");
  const address = v.emailAddress(person.email);
  if (address === null) fail(code, "adresse invalide dans un message de réunion");
  return address;
}

/**
 * The words of the user's own mailbox, for the From field (RFC 5322 3.4):
 * the display name, when there is one, as a quoted string (short ASCII) or
 * as encoded-words, then the address in angle brackets; the address alone
 * otherwise.
 */
function mailboxWords(person, code) {
  const address = mailboxAddress(person, code);
  const name = displayName(person.name);
  if (!name) return [address];
  const words = isPlain(name) && name.length <= 60 ? [`"${name.replace(/[\\"]/g, "\\$&")}"`] : encodedWords(name);
  return [...words, `<${address}>`];
}

/**
 * One header field: its words separated by a space, on a new line (CRLF and
 * a space) when the line would pass 76 characters. A word is never cut. A
 * word that is not printable ASCII is refused: nothing but the folding
 * written here can put a line break in a header.
 */
function headerField(name, words) {
  let out = `${name}:`;
  let width = out.length;
  for (const word of words) {
    if (!PRINTABLE.test(word)) fail("ITIP_ARGUMENT", "en-tête invalide");
    if (width + 1 + word.length > 76 && width > name.length + 1) {
      out += `\r\n ${word}`;
      width = 1 + word.length;
    } else {
      out += ` ${word}`;
      width += 1 + word.length;
    }
  }
  return out;
}

/** The words of a Subject: the text itself when it is plain ASCII made of short words, encoded-words otherwise. */
function subjectWords(subject) {
  const clean = strictText(subject, { max: MAX_SUMMARY + 256, singleLine: true }).trim();
  const words = clean ? clean.split(" ") : [];
  return isPlain(clean) && words.every((w) => w.length <= 60) ? words : encodedWords(clean);
}

/** A date for the Date field (RFC 5322 3.3), in UTC. */
function dateField(ms) {
  const d = new Date(ms);
  return `${WEEKDAY_NAMES[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTH_NAMES[d.getUTCMonth()]} ${pad(d.getUTCFullYear(), 4)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/** Base64 of bytes in lines of 76 characters (RFC 2045 6.8), each ended by CRLF. */
function base64Lines(bytes) {
  const all = base64(bytes);
  const lines = [];
  for (let i = 0; i < all.length; i += 76) lines.push(all.slice(i, i + 76));
  return lines.length ? `${lines.join("\r\n")}\r\n` : "";
}

/**
 * The Internet message that carries an iTIP calendar (RFC 6047), as bytes
 * for SendMail.
 *
 *  - method: "REQUEST", "CANCEL" or "REPLY"; `calendar` must say the same
 *    (RFC 6047 2.4), and be a whole iCalendar object as itipCalendar writes it.
 *  - from: { email, name }, the user.
 *  - to: [{ email }], 1 to MAX_MEETING_RECIPIENTS; exactly one for a REPLY,
 *    which only goes to the organizer. They are the only recipients: the
 *    message has no Cc and no Bcc field. Only the addresses are written: a
 *    name given with one is ignored (in a reply it would be a text chosen
 *    by whoever sent the invitation, and a name such as
 *    "x" <other@example.org>, "y" reads as one more recipient to a server
 *    that looks for addresses in the field).
 *  - subject: one line; text: the plain-text part, at most MAX_TEXT_LENGTH
 *    characters. Both are cleaned here (strictText).
 *  - date: a UTC of the descriptions, a Date or milliseconds.
 *  - messageId: with or without angle brackets.
 *
 * Headers: Date, From, To, Subject, Message-ID, MIME-Version, Content-Type.
 * Body: multipart/alternative, a text/plain part then the text/calendar
 * part with its method, both in UTF-8.
 *
 * Both parts are base64. For the calendar the other choice was 8bit, which
 * is legal here (folded lines, CRLF) but leaves the bytes of the part
 * exposed to whatever relays the message: lines re-wrapped or trimmed,
 * "From " escaped, 8-bit content re-encoded by a relay that is not 8-bit
 * clean. And base64 lines hold letters, digits, "+", "/" and "=" only: no
 * line of a part can start with "--", so no text of the event can be read
 * as a boundary and add or end a part, whatever the boundary is. The
 * boundary is still checked against both parts.
 *
 * Throws ItipError: ITIP_ARGUMENT, ITIP_ADDRESS, ITIP_RECIPIENTS, ITIP_TOO_LARGE.
 */
export function itipMessage({ method, calendar, from, to, subject, text, date, messageId } = {}) {
  if (!METHODS.has(method)) fail("ITIP_ARGUMENT", "méthode iTIP invalide");
  if (typeof calendar !== "string" || calendar.length > MAX_CALENDAR_LENGTH) fail("ITIP_TOO_LARGE", "message de réunion trop volumineux");
  const calendarLines = calendar.split("\r\n");
  const methods = calendarLines.filter((line) => line.startsWith("METHOD:"));
  if (
    calendarLines.length < 4 ||
    calendarLines[0] !== "BEGIN:VCALENDAR" ||
    calendarLines[calendarLines.length - 2] !== "END:VCALENDAR" ||
    calendarLines[calendarLines.length - 1] !== "" ||
    methods.length !== 1 ||
    methods[0] !== `METHOD:${method}` ||
    !calendar.isWellFormed() ||
    calendarLines.some((line) => line.includes("\r") || line.includes("\n"))
  ) {
    fail("ITIP_ARGUMENT", "calendrier iTIP invalide");
  }
  if (typeof text !== "string" || text.length > MAX_TEXT_LENGTH) fail("ITIP_ARGUMENT", "texte du message invalide");
  const dateMs = instant(date);
  if (dateMs === null) fail("ITIP_ARGUMENT", "date du message invalide");
  const id = typeof messageId === "string" ? messageId.replace(/^<(.*)>$/, "$1") : "";
  if (id.length > 250 || !MESSAGE_ID.test(id)) fail("ITIP_ARGUMENT", "identifiant de message invalide");
  if (!Array.isArray(to) || to.length < 1) fail("ITIP_RECIPIENTS", "aucun destinataire");
  if (to.length > MAX_MEETING_RECIPIENTS) fail("ITIP_RECIPIENTS", `plus de ${MAX_MEETING_RECIPIENTS} destinataires`);
  if (method === "REPLY" && to.length !== 1) fail("ITIP_RECIPIENTS", "une réponse ne va qu'à l'organisateur");

  // Addresses alone, each one validated: no blank, comma, quote or angle bracket can be in one.
  const recipients = to.map((person, i) => `${mailboxAddress(person, "ITIP_ADDRESS")}${i < to.length - 1 ? "," : ""}`);
  const plain = base64Lines(encodeUtf8(strictText(text, { max: MAX_TEXT_LENGTH }).replace(/\n/g, "\r\n")));
  const ics = base64Lines(encodeUtf8(calendar));
  const boundary = `sync443-${toHex(sha256(encodeUtf8(`${id} ${dateMs}`))).slice(0, 32)}`;
  if (plain.includes(`--${boundary}`) || ics.includes(`--${boundary}`)) fail("ITIP_ARGUMENT", "frontière MIME présente dans une partie");

  const message = [
    headerField("Date", [dateField(dateMs)]),
    headerField("From", mailboxWords(from, "ITIP_ADDRESS")),
    headerField("To", recipients),
    headerField("Subject", subjectWords(subject)),
    headerField("Message-ID", [`<${id}>`]),
    headerField("MIME-Version", ["1.0"]),
    headerField("Content-Type", ["multipart/alternative;", `boundary="${boundary}"`]),
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    `${plain}--${boundary}`,
    `Content-Type: text/calendar; charset=utf-8; method=${method}`,
    "Content-Transfer-Encoding: base64",
    "",
    `${ics}--${boundary}--`,
    "",
  ].join("\r\n");

  const out = new Uint8Array(message.length);
  for (let i = 0; i < message.length; i++) {
    const code = message.charCodeAt(i);
    if (code > 0x7e || (code < 0x20 && code !== 0x0d && code !== 0x0a)) fail("ITIP_ARGUMENT", "message invalide");
    out[i] = code;
  }
  return out;
}
