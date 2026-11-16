// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Time zones and dates of calendar items and tasks.
 *
 * ActiveSync gives the time zone of a calendar item as a Windows structure
 * of 172 bytes, in base64 ([MS-ASDTYPE] 2.7.6):
 *
 *     0  Bias          LONG   minutes to add to local time to get UTC
 *     4  StandardName  32 WCHAR (ignored: a name is never an identifier)
 *    68  StandardDate  SYSTEMTIME, when standard time starts
 *    84  StandardBias  LONG   added to Bias during standard time
 *    88  DaylightName  32 WCHAR (ignored)
 *   152  DaylightDate  SYSTEMTIME, when daylight time starts
 *   168  DaylightBias  LONG   added to Bias during daylight time
 *
 * A SYSTEMTIME is eight little-endian WORDs ([MS-DTYP] 2.3.13): year,
 * month, day of week, day, hour, minute, second, milliseconds. The fields
 * mean what they mean in the Windows structure the name comes from
 * (TIME_ZONE_INFORMATION): with year 0 a date is a yearly rule, in which
 * "day" is the occurrence of the day of week in the month (1 to 5, 5 being
 * the last one); with a year it is the date of one change; month 0 means
 * "no change", and both biases of the changes are then ignored.
 *
 * The structure is decoded strictly into the Zone of the item description
 * (docs/CALENDAR-DESIGN.md):
 *
 *   Zone   { bias, standard: { bias, change }, daylight: { bias, change } }
 *   Change { month 1-12, week 1-5, weekday 0-6 (0 = Sunday), hour, minute }
 *
 * Biases keep the sign of the structure (UTC = local time + bias): the
 * offset in force is -(bias + standard.bias) or -(bias + daylight.bias).
 * A zone without changes is a single offset, always written with both
 * other biases at 0.
 *
 *   decodeTimeZone(base64)        → Zone; throws ProtocolError
 *   readTimeZone(base64)          → { zone, reduced }: the same, saying when a change was dropped
 *   encodeTimeZone(zone)          → base64 of exactly 172 bytes, names empty
 *   checkZone(zone)               → clean frozen copy; throws ProtocolError
 *   offsetMinutesAt(zone, utcMs)  → minutes to add to UTC (east positive)
 *   localMidnightUtc(zone, date)  → UTC ms at which that local day starts
 *   localDateOf(zone, utcMs)      → DATE of that instant in the zone
 *
 * The second half of the module holds the dates themselves: the DATE and
 * UTC strings of the item description, the Compact DateTime of calendar
 * items ([MS-ASDTYPE] 2.7.2) and the dateTime of tasks (2.3). Parsers take
 * exactly the grammar, real calendar days and years 1900 to 2200, and
 * return null for anything else.
 *
 * Every error is a ProtocolError with a `code` ("BAD_TIMEZONE",
 * "BAD_DATE"…) and a reason that names a field, never a value.
 */

import { ProtocolError } from "./protocol.mjs";
import { base64 } from "./base64.mjs";

/** Size of the TimeZone structure. */
export const TIME_ZONE_BYTES = 172;
/** Years accepted in every date of an item description. */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2200;

const MINUTE = 60_000;
/** Largest bias, and largest offset from UTC, in minutes (14 hours). */
const MAX_BIAS = 840;
/** 172 bytes are 57 groups of three bytes and one more byte: 228 characters, two more, and "==". */
const BASE64_LENGTH = 232;
const BASE64_SHAPE = /^[A-Za-z0-9+/]{230}==$/;
/** Longest text looked at as a time zone: the 232 characters, and line breaks an encoder may have added. */
const MAX_BASE64_TEXT = 512;

/** A ProtocolError with a `code`, for the callers that sort errors (quarantine, refusal, skip). */
export function conversionError(code, reason) {
  const error = new ProtocolError(reason);
  error.code = code;
  return error;
}

const badZone = (reason) => conversionError("BAD_TIMEZONE", `fuseau horaire invalide (${reason})`);
const badDate = (reason) => conversionError("BAD_DATE", `date invalide (${reason})`);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (object, key) => (Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);
const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// ── Zone descriptions ─────────────────────────────────────────────────────

/** Zones built here: already checked and frozen, they are not checked again. */
const CHECKED = new WeakSet();

function makeChange(month, week, weekday, hour, minute) {
  return Object.freeze({ month, week, weekday, hour, minute });
}

function makeZone(bias, standardBias, standardChange, daylightBias, daylightChange) {
  const zone = Object.freeze({
    bias,
    standard: Object.freeze({ bias: standardBias, change: standardChange }),
    daylight: Object.freeze({ bias: daylightBias, change: daylightChange }),
  });
  CHECKED.add(zone);
  return zone;
}

/** UTC: all biases 0, no changes. */
export const UTC_ZONE = makeZone(0, 0, null, 0, null);

/**
 * The rules that hold between the parts of a zone, whatever it was read
 * from: both changes or none, and offsets within 14 hours of UTC. Without
 * changes the zone is one offset, kept in `bias` alone: the structure has
 * no other place for it that its readers would not ignore.
 */
function assemble(bias, standardBias, standardChange, daylightBias, daylightChange) {
  if ((standardChange === null) !== (daylightChange === null)) throw badZone("un seul changement d'heure");
  if (Math.abs(bias + standardBias) > MAX_BIAS) throw badZone("décalage de l'heure d'hiver");
  if (standardChange === null) return makeZone(bias + standardBias, 0, null, 0, null);
  if (Math.abs(bias + daylightBias) > MAX_BIAS) throw badZone("décalage de l'heure d'été");
  return makeZone(bias, standardBias, standardChange, daylightBias, daylightChange);
}

function checkBias(value, what) {
  if (!inRange(value, -MAX_BIAS, MAX_BIAS)) throw badZone(what);
  return value + 0; // never -0
}

function checkChange(value, what) {
  if (value === null) return null;
  if (!isRecord(value)) throw badZone(what);
  const month = own(value, "month");
  const week = own(value, "week");
  const weekday = own(value, "weekday");
  const hour = own(value, "hour");
  const minute = own(value, "minute");
  if (!inRange(month, 1, 12) || !inRange(week, 1, 5) || !inRange(weekday, 0, 6) || !inRange(hour, 0, 23) || !inRange(minute, 0, 59)) {
    throw badZone(what);
  }
  return makeChange(month, week, weekday + 0, hour + 0, minute + 0);
}

function checkPart(value, what) {
  if (!isRecord(value)) throw badZone(what);
  const change = own(value, "change");
  if (change === undefined) throw badZone(what);
  return { bias: checkBias(own(value, "bias"), what), change: checkChange(change, what) };
}

/**
 * A clean, deeply frozen copy of a Zone description, whatever its origin
 * (Thunderbird's side, storage): every field is an integer in its range,
 * both changes are set or both are null, and the offsets stay within 14
 * hours of UTC. Anything else throws (ProtocolError, code "BAD_TIMEZONE").
 * A zone without changes comes back as its single offset: `bias` holds
 * bias + standard.bias, and the two other biases are 0.
 */
export function checkZone(zone) {
  if (CHECKED.has(zone)) return zone;
  if (!isRecord(zone)) throw badZone("description");
  const bias = checkBias(own(zone, "bias"), "bias");
  const standard = checkPart(own(zone, "standard"), "heure d'hiver");
  const daylight = checkPart(own(zone, "daylight"), "heure d'été");
  return assemble(bias, standard.bias, standard.change, daylight.bias, daylight.change);
}

// ── The TimeZone structure ────────────────────────────────────────────────

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const SEXTET = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) SEXTET[ALPHABET.charCodeAt(i)] = i;

/** Base64 of exactly 172 bytes, in its canonical form; spaces and line breaks between characters are skipped. */
function structureBytes(value) {
  if (typeof value !== "string" || value.length > MAX_BASE64_TEXT) throw badZone("longueur");
  const text = value.length === BASE64_LENGTH ? value : value.replace(/[ \t\r\n]+/g, "");
  if (text.length !== BASE64_LENGTH || !BASE64_SHAPE.test(text)) throw badZone("longueur ou codage");
  const bytes = new Uint8Array(TIME_ZONE_BYTES);
  const six = (i) => SEXTET[text.charCodeAt(i)];
  let n = 0;
  for (let i = 0; i < BASE64_LENGTH - 4; i += 4) {
    const group = (six(i) << 18) | (six(i + 1) << 12) | (six(i + 2) << 6) | six(i + 3);
    bytes[n++] = group >> 16;
    bytes[n++] = (group >> 8) & 0xff;
    bytes[n++] = group & 0xff;
  }
  const low = six(BASE64_LENGTH - 3);
  if (low & 0x0f) throw badZone("codage"); // bits that belong to no byte: one text per structure
  bytes[n] = (six(BASE64_LENGTH - 4) << 2) | (low >> 4);
  return bytes;
}

const int32 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24);
const word = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);

/**
 * One SYSTEMTIME of the structure → null (month 0: no change), "once" (a
 * year is given: one date, not a yearly rule) or a Change. Every field is
 * range-checked in both forms. Seconds and milliseconds are checked, then
 * dropped: a Change is exact to the minute.
 */
function readSystemTime(bytes, at, what) {
  const year = word(bytes, at);
  const month = word(bytes, at + 2);
  const weekday = word(bytes, at + 4);
  const day = word(bytes, at + 6);
  const hour = word(bytes, at + 8);
  const minute = word(bytes, at + 10);
  const second = word(bytes, at + 12);
  const millisecond = word(bytes, at + 14);
  if (month === 0) return null;
  if (month > 12 || weekday > 6 || hour > 23 || minute > 59 || second > 59 || millisecond > 999) throw badZone(what);
  if (year !== 0) {
    // The date of one year (a SYSTEMTIME holds the years 1601 to 30827).
    if (year < 1601 || year > 30827 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw badZone(what);
    return "once";
  }
  if (day < 1 || day > 5) throw badZone(what);
  return makeChange(month, day, weekday, hour, minute);
}

/**
 * The TimeZone structure of a calendar item or a meeting request → Zone.
 * Strict: exactly 172 bytes of canonical base64, every field in its range,
 * both changes present or both absent. The names are not read.
 * Without changes the zone is its Bias: StandardBias and DaylightBias are
 * ignored, as Windows ignores them (they must still be in range).
 * A change given as the date of a single year cannot be applied to other
 * years: such a structure is reduced to its standard offset (Bias +
 * StandardBias), without changes.
 * Throws ProtocolError (code "BAD_TIMEZONE").
 */
export function decodeTimeZone(value) {
  return readTimeZone(value).zone;
}

/**
 * decodeTimeZone, with what it had to leave out → { zone, reduced }.
 * `reduced` is true when a change dated to a single year was dropped: the
 * zone then says less than the structure, and written back it would erase
 * that change. (Names, the seconds of a change and the biases of a zone
 * without changes are never kept; they do not count.)
 */
export function readTimeZone(value) {
  const bytes = structureBytes(value);
  const bias = checkBias(int32(bytes, 0), "bias");
  const standardBias = checkBias(int32(bytes, 84), "bias de l'heure d'hiver");
  const daylightBias = checkBias(int32(bytes, 168), "bias de l'heure d'été");
  const standard = readSystemTime(bytes, 68, "passage à l'heure d'hiver");
  const daylight = readSystemTime(bytes, 152, "passage à l'heure d'été");
  if ((standard === null) !== (daylight === null)) throw badZone("un seul changement d'heure");
  if (standard === null) return { zone: assemble(bias, 0, null, 0, null), reduced: false };
  if (standard === "once" || daylight === "once") return { zone: assemble(bias, standardBias, null, 0, null), reduced: true };
  return { zone: assemble(bias, standardBias, standard, daylightBias, daylight), reduced: false };
}

function writeInt32(bytes, at, value) {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >> 8) & 0xff;
  bytes[at + 2] = (value >> 16) & 0xff;
  bytes[at + 3] = (value >> 24) & 0xff;
}

function writeSystemTime(bytes, at, change) {
  if (change === null) return;
  bytes[at + 2] = change.month; // every value fits in the low byte of its WORD
  bytes[at + 4] = change.weekday;
  bytes[at + 6] = change.week;
  bytes[at + 8] = change.hour;
  bytes[at + 10] = change.minute;
}

/** A Zone → the TimeZone structure in base64: exactly 172 bytes, both names left empty. */
export function encodeTimeZone(zone) {
  const z = checkZone(zone);
  const bytes = new Uint8Array(TIME_ZONE_BYTES);
  writeInt32(bytes, 0, z.bias);
  writeSystemTime(bytes, 68, z.standard.change);
  writeInt32(bytes, 84, z.standard.bias);
  writeSystemTime(bytes, 152, z.daylight.change);
  writeInt32(bytes, 168, z.daylight.bias);
  return base64(bytes);
}

// ── Offsets ───────────────────────────────────────────────────────────────

// Instants handled by the offset functions: the years of the item
// description, with a margin for the offset itself. Date.UTC misreads
// years below 100, and nothing here needs them.
const MIN_INSTANT = Date.UTC(MIN_YEAR - 2, 0, 1);
const MAX_INSTANT = Date.UTC(MAX_YEAR + 3, 0, 1);

function checkInstant(utcMs) {
  if (typeof utcMs !== "number" || !Number.isFinite(utcMs) || utcMs < MIN_INSTANT || utcMs > MAX_INSTANT) throw badDate("instant hors limites");
  return utcMs;
}

/**
 * UTC instant of a yearly change in `year`. The change is given in the
 * local time in force just before it: `offsetBefore` minutes from UTC.
 */
function changeInstant(change, year, offsetBefore) {
  const firstWeekday = new Date(Date.UTC(year, change.month - 1, 1)).getUTCDay();
  let day = 1 + ((change.weekday - firstWeekday + 7) % 7) + 7 * (change.week - 1);
  // Week 5 is the last one: a fifth occurrence that does not exist is the fourth.
  if (day > new Date(Date.UTC(year, change.month, 0)).getUTCDate()) day -= 7;
  return Date.UTC(year, change.month - 1, day, change.hour, change.minute) - offsetBefore * MINUTE;
}

/** The changes of three years around an instant, as [{ at, offset, before }] (offsets after and before the change). */
function changesAround(zone, utcMs) {
  const standardOffset = 0 - (zone.bias + zone.standard.bias);
  const daylightOffset = 0 - (zone.bias + zone.daylight.bias);
  const year = new Date(utcMs).getUTCFullYear();
  const list = [];
  for (let y = year - 1; y <= year + 1; y++) {
    list.push({ at: changeInstant(zone.daylight.change, y, standardOffset), offset: daylightOffset, before: standardOffset });
    list.push({ at: changeInstant(zone.standard.change, y, daylightOffset), offset: standardOffset, before: daylightOffset });
  }
  return list;
}

function offsetOf(zone, utcMs) {
  const standardOffset = 0 - (zone.bias + zone.standard.bias);
  if (zone.daylight.change === null) return standardOffset;
  // The rule in force is the one of the latest change at or before the
  // instant, which also covers zones where daylight time spans the new
  // year. Two changes at the same instant: standard time wins.
  let latest = -Infinity;
  let offset = standardOffset;
  for (const change of changesAround(zone, utcMs)) {
    if (change.at > utcMs) continue;
    if (change.at > latest || (change.at === latest && change.offset === standardOffset)) {
      latest = change.at;
      offset = change.offset;
    }
  }
  return offset;
}

/**
 * Minutes to add to a UTC instant to get local time in the zone (east of
 * Greenwich is positive), with the rule in force at that instant.
 */
export function offsetMinutesAt(zone, utcMs) {
  return offsetOf(checkZone(zone), checkInstant(utcMs));
}

/**
 * UTC instant (ms) at which the day `date` ("YYYY-MM-DD") starts in the
 * zone: local midnight. When the clock is set back over midnight, it is
 * the first of the two midnights; when midnight is skipped by a change to
 * daylight time, the instant of that change, which is when the day starts.
 */
export function localMidnightUtc(zone, date) {
  const z = checkZone(zone);
  const wall = parseDate(date);
  if (wall === null) throw badDate("jour");
  const standardOffset = 0 - (z.bias + z.standard.bias);
  if (z.daylight.change === null) return wall - standardOffset * MINUTE;
  let first = Infinity;
  // Midnight read with each offset, kept when that offset is the one in force then.
  for (const offset of [standardOffset, 0 - (z.bias + z.daylight.bias)]) {
    const instant = wall - offset * MINUTE;
    if (instant < first && offsetOf(z, instant) === offset) first = instant;
  }
  // A change that jumps over midnight: the local clock is before midnight
  // just before it, and at or after midnight from it on.
  for (const change of changesAround(z, wall)) {
    if (change.at < first && change.at + change.before * MINUTE <= wall && wall <= change.at + change.offset * MINUTE) first = change.at;
  }
  return Number.isFinite(first) ? first : wall - standardOffset * MINUTE;
}

/** The day ("YYYY-MM-DD") of a UTC instant in the zone. Throws when that day is outside 1900-2200. */
export function localDateOf(zone, utcMs) {
  const z = checkZone(zone);
  return formatDate(checkInstant(utcMs) + offsetOf(z, utcMs) * MINUTE);
}

// ── Dates ─────────────────────────────────────────────────────────────────

const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const COMPACT_SHAPE = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/;
const DATETIME_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?Z$/;

function parse(shape, value, maxYear) {
  if (typeof value !== "string" || value.length > 24) return null;
  const m = shape.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4] ?? 0);
  const minute = Number(m[5] ?? 0);
  const second = Number(m[6] ?? 0);
  if (year < MIN_YEAR || year > maxYear || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return new Date(ms).getUTCDate() === day ? ms : null; // 31 April would be 1 May
}

/** DATE of the item description, "YYYY-MM-DD" → UTC ms of 00:00 that day, or null. */
export const parseDate = (value) => parse(DATE_SHAPE, value, MAX_YEAR);
/** UTC of the item description, "YYYY-MM-DDTHH:MM:SSZ" → ms, or null. */
export const parseUtc = (value) => parse(UTC_SHAPE, value, MAX_YEAR);
/**
 * Compact DateTime of calendar items ([MS-ASDTYPE] 2.7.2), exactly the 16
 * characters of "YYYYMMDDTHHMMSSZ" → ms, or null. `maxYear` lets a caller
 * recognise a date far in the future (an end "never") without accepting it
 * as a date.
 */
export const parseCompact = (value, { maxYear = MAX_YEAR } = {}) => parse(COMPACT_SHAPE, value, maxYear);
/**
 * dateTime of tasks ([MS-ASDTYPE] 2.3), "YYYY-MM-DDTHH:MM:SS.MSSZ" with
 * optional milliseconds (dropped) → ms, or null.
 */
export const parseDateTime = (value, { maxYear = MAX_YEAR } = {}) => parse(DATETIME_SHAPE, value, maxYear);

const two = (n) => String(n).padStart(2, "0");

function fields(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) throw badDate("instant");
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (!(year >= MIN_YEAR && year <= MAX_YEAR)) throw badDate("année hors limites");
  return {
    date: [String(year), two(d.getUTCMonth() + 1), two(d.getUTCDate())],
    time: [two(d.getUTCHours()), two(d.getUTCMinutes()), two(d.getUTCSeconds())],
  };
}

/** ms → "YYYY-MM-DD". These four throw (ProtocolError, "BAD_DATE") outside 1900-2200. */
export function formatDate(ms) {
  return fields(ms).date.join("-");
}

/** ms → "YYYY-MM-DDTHH:MM:SSZ". */
export function formatUtc(ms) {
  const f = fields(ms);
  return `${f.date.join("-")}T${f.time.join(":")}Z`;
}

/** ms → "YYYYMMDDTHHMMSSZ". */
export function formatCompact(ms) {
  const f = fields(ms);
  return `${f.date.join("")}T${f.time.join("")}Z`;
}

/** ms → "YYYY-MM-DDTHH:MM:SS.000Z". */
export function formatDateTime(ms) {
  const f = fields(ms);
  return `${f.date.join("-")}T${f.time.join(":")}.000Z`;
}
