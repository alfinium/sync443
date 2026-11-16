// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * The MeetingRequest element of an invitation mail ([MS-ASEMAIL] 2.2.2.48),
 * read into a plain, validated record:
 *
 *   readMeetingRequest(node) → { uid, start, end, allDay, location, organizer, responseRequested,
 *                                recurrenceId, instanceType, messageType, busy, sensitivity, zone, recurring }
 *   globalObjIdUid(base64)   → the UID of the meeting, or null
 *
 * Everything here is chosen by whoever sent the invitation. Each value is
 * validated on its own; one that cannot be used becomes null (or its
 * default), and nothing throws: an odd MeetingRequest must never cost the
 * mail that carries it.
 *
 * The UID only names the meeting an invitation is about, so that the answer
 * to an event can be sent to the right invitation: it never selects a local
 * item (docs/CALENDAR-DESIGN.md, rule 21).
 */

import { child, text } from "./wbxml.mjs";
import * as v from "./sanitize.mjs";
import { decodeUtf8 } from "./utf8.mjs";
import { decodeTimeZone, parseDateTime, parseCompact, formatUtc } from "./eas-timezone.mjs";

/** Longest UID given out, in characters (the `uid` of an item description). */
export const MAX_UID = 300;
/**
 * Largest GlobalObjId decoded, in bytes: the 40-byte header, the vCal marker
 * and version (12), a UID of MAX_UID characters in UTF-8 (at most 3 bytes
 * per UTF-16 unit) and its final NUL fit; nothing bigger can give a UID.
 */
export const MAX_GLOBAL_OBJ_ID_BYTES = 40 + 12 + 3 * MAX_UID + 1;

// ── Base64 ────────────────────────────────────────────────────────────────

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Map(Array.from(BASE64_ALPHABET, (c, i) => [c, i]));
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Bytes of a base64 text (RFC 4648 section 4), read strictly: the alphabet
 * only (no blank, no line break), padded to a multiple of four, the unused
 * bits of the last group at zero. → Uint8Array, or null when the text is not
 * that or would give more than `maxBytes`.
 */
function strictBase64(value, maxBytes) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return null;
  if (value.length > Math.ceil(maxBytes / 3) * 4 || !BASE64_TEXT.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((value.length / 4) * 3 - padding);
  if (out.length > maxBytes) return null;
  let n = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = BASE64_VALUES.get(value[i]);
    const b = BASE64_VALUES.get(value[i + 1]);
    const c = BASE64_VALUES.get(value[i + 2]);
    const d = BASE64_VALUES.get(value[i + 3]);
    // Padding is only possible in the last group (checked by BASE64_TEXT and the length).
    if (a === undefined || b === undefined) return null;
    if (c === undefined) {
      if (b & 0x0f) return null; // not canonical
      out[n++] = (a << 2) | (b >> 4);
    } else if (d === undefined) {
      if (c & 0x03) return null; // not canonical
      out[n++] = (a << 2) | (b >> 4);
      out[n++] = ((b & 0x0f) << 4) | (c >> 2);
    } else {
      out[n++] = (a << 2) | (b >> 4);
      out[n++] = ((b & 0x0f) << 4) | (c >> 2);
      out[n++] = ((c & 0x03) << 6) | d;
    }
  }
  return out;
}

// ── GlobalObjId ───────────────────────────────────────────────────────────

/** CLASSID: the 16 bytes every GlobalObjId starts with ([MS-ASEMAIL] 2.2.2.37). */
const CLASS_ID = [0x04, 0x00, 0x00, 0x00, 0x82, 0x00, 0xe0, 0x00, 0x74, 0xc5, 0xb7, 0x10, 0x1a, 0x82, 0xe0, 0x08];
/** CLASSID (16), INSTDATE (4), NOW (8), RESERVED (8), BYTECOUNT (4). */
const HEADER_BYTES = 40;
const INSTANCE_DATE_AT = 16;
const BYTE_COUNT_AT = 36;
/** "vCal-Uid", then VERSION 1 as four little-endian bytes: the start of a vCal payload. */
const VCAL_MARKER = [0x76, 0x43, 0x61, 0x6c, 0x2d, 0x55, 0x69, 0x64];
const VCAL_VERSION = [0x01, 0x00, 0x00, 0x00];
const HEX = "0123456789ABCDEF";
const REPLACEMENT = String.fromCharCode(0xfffd);

const startsWith = (bytes, at, word) => word.every((b, i) => bytes[at + i] === b);

/**
 * A UID as the item descriptions carry it: 1 to MAX_UID characters on one
 * line, well-formed, with no control, bidirectional or invisible character.
 * It is taken as it is or refused, never rewritten: a rewritten UID would
 * name another meeting.
 */
function uidText(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_UID) return null;
  if (!value.isWellFormed() || value.includes(REPLACEMENT)) return null;
  if (v.cleanText(value, { max: MAX_UID, singleLine: true, stripBidi: true }) !== value) return null;
  return value.trim() === "" ? null : value;
}

/**
 * The UID of the meeting a GlobalObjId names ([MS-ASEMAIL] 2.2.2.37 for the
 * structure, 3.1.4.7 and 4.3 for the conversion), or null.
 *
 * The value is base64 of: CLASSID (16 bytes, fixed), INSTDATE (4: zeros, or
 * the year on two bytes, the month and the day of one occurrence), NOW (8),
 * RESERVED (8), BYTECOUNT (4, little-endian) and BYTECOUNT bytes of data.
 *  - Data starting with "vCal-Uid": a UID set by a foreign calendar. It must
 *    go on with the version 1, the UID and one final NUL; the UID (UTF-8,
 *    without NUL) is the result.
 *  - Any other data (an identifier of the organizer's own calendar): the result
 *    is the whole structure in upper-case hexadecimal with the four INSTDATE
 *    bytes at zero, which is the UID the server gives the calendar item, the
 *    same for a series and for each of its occurrences.
 *
 * Read strictly: canonical base64, at most MAX_GLOBAL_OBJ_ID_BYTES bytes,
 * the exact CLASSID, a plausible INSTDATE, a BYTECOUNT equal to what
 * follows. The result has 1 to MAX_UID characters on one line (so the
 * hexadecimal form exists up to 150 bytes); anything else gives null.
 */
export function globalObjIdUid(base64) {
  const bytes = strictBase64(base64, MAX_GLOBAL_OBJ_ID_BYTES);
  if (!bytes || bytes.length < HEADER_BYTES || !startsWith(bytes, 0, CLASS_ID)) return null;

  const year = bytes[INSTANCE_DATE_AT] * 256 + bytes[INSTANCE_DATE_AT + 1];
  const month = bytes[INSTANCE_DATE_AT + 2];
  const day = bytes[INSTANCE_DATE_AT + 3];
  const wholeSeries = year === 0 && month === 0 && day === 0;
  if (!wholeSeries && (year < 1601 || year > 4500 || month < 1 || month > 12 || day < 1 || day > 31)) return null;

  // Multiplications, not shifts: a count above 2^31 must not turn negative.
  const count = bytes[BYTE_COUNT_AT] + bytes[BYTE_COUNT_AT + 1] * 0x100 + bytes[BYTE_COUNT_AT + 2] * 0x10000 + bytes[BYTE_COUNT_AT + 3] * 0x1000000;
  if (count !== bytes.length - HEADER_BYTES) return null;

  if (count >= VCAL_MARKER.length && startsWith(bytes, HEADER_BYTES, VCAL_MARKER)) {
    const from = HEADER_BYTES + VCAL_MARKER.length + VCAL_VERSION.length;
    const to = bytes.length - 1; // the final NUL
    if (to <= from || !startsWith(bytes, HEADER_BYTES + VCAL_MARKER.length, VCAL_VERSION) || bytes[to] !== 0) return null;
    if (bytes.subarray(from, to).includes(0)) return null; // a NUL inside: where the UID ends would be a guess
    return uidText(decodeUtf8(bytes, from, to));
  }

  if (bytes.length * 2 > MAX_UID) return null;
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = i >= INSTANCE_DATE_AT && i < INSTANCE_DATE_AT + 4 ? 0 : bytes[i];
    hex += HEX[b >> 4] + HEX[b & 0x0f];
  }
  return hex;
}

// ── MeetingRequest ────────────────────────────────────────────────────────

/**
 * A date of the Email class ([MS-ASDTYPE] 2.3: "2000-12-25T08:35:00.000Z",
 * the milliseconds being optional; the compact form of the Calendar class,
 * "20001225T083500Z", is accepted too) → "YYYY-MM-DDTHH:MM:SSZ", or null.
 * Exact formats only, a real calendar day, a year from 1900 to 2200
 * (eas-timezone.mjs, the parsers of every date of an item description).
 */
function utcDate(value) {
  const ms = parseDateTime(value) ?? parseCompact(value);
  return ms === null ? null : formatUtc(ms);
}

/**
 * The organizer's address. The server gives an address alone, or a display
 * name followed by the address in angle brackets; the name is not used.
 * With brackets, the address is what the last pair holds, and that pair must
 * end the value: text after it, or a bracket left open, gives null.
 */
function organizerAddress(value) {
  if (typeof value !== "string" || value.length > MAX_ORGANIZER_TEXT || v.hasControl(value)) return null;
  const s = value.trim();
  if (!s.includes("<") && !s.includes(">")) return v.emailAddress(s);
  const open = s.lastIndexOf("<");
  if (open < 0 || !s.endsWith(">") || s.indexOf(">", open) !== s.length - 1) return null;
  return v.emailAddress(s.slice(open + 1, -1));
}

/** Longest location kept, in characters (the `location` of an item description). */
const MAX_LOCATION = 1024;
/** Longest values looked at, in bytes; a longer one is treated as absent. */
const MAX_DATE_TEXT = 24; // "2000-12-25T08:35:00.000Z"
const MAX_ORGANIZER_TEXT = 2048; // a display name and an address
const MAX_ZONE_TEXT = 512; // 232 characters of base64, and the line breaks an encoder may have added
const MAX_GLOBAL_OBJ_ID_TEXT = Math.ceil(MAX_GLOBAL_OBJ_ID_BYTES / 3) * 4;
/** BusyStatus ([MS-ASEMAIL] 2.2.2.14); 2 when absent. 4 ("working elsewhere") does not exist before 16.0. */
const BUSY = new Map([[0, "free"], [1, "tentative"], [2, "busy"], [3, "away"]]);
/** Sensitivity ([MS-ASEMAIL] 2.2.2.71); 0 when absent. "Personal" is kept from other readers like "private". */
const SENSITIVITY = new Map([[0, "public"], [1, "private"], [2, "private"], [3, "confidential"]]);

const blank = () => ({
  uid: null,
  start: null,
  end: null,
  allDay: false,
  location: "",
  organizer: null,
  responseRequested: false,
  recurrenceId: null,
  instanceType: null,
  messageType: null,
  busy: "busy",
  sensitivity: "public",
  zone: null,
  recurring: false,
});

const isElement = (node) => Boolean(node) && typeof node === "object" && Array.isArray(node.children);

/**
 * Text of the first child named `name`: null when there is none, or when
 * its value is longer than `maxBytes`, which is then not even decoded (a
 * sender can make any element as large as a whole response).
 */
function shortText(node, name, maxBytes) {
  const target = child(node, name);
  if (!target || (target.value && target.value.length > maxBytes)) return null;
  return text(target);
}

/**
 * Start of the text of the first child named `name`: at most `maxBytes`
 * bytes are decoded, cut between two characters; "" when there is none.
 */
function startOfText(node, name, maxBytes) {
  const value = child(node, name)?.value;
  if (!value) return "";
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && end < value.length && (value[end] & 0xc0) === 0x80) end--; // not inside a UTF-8 sequence
  return decodeUtf8(value, 0, end);
}

const small = (node, name, max) => v.integer(shortText(node, name, 16), { min: 0, max });

/**
 * The MeetingRequest element of an e-mail ([MS-ASEMAIL] 2.2.2.48), for
 * protocol versions 12.1 to 14.1:
 *  - uid: the UID of the meeting, from GlobalObjId (see globalObjIdUid), or null;
 *  - start, end: "YYYY-MM-DDTHH:MM:SSZ" or null; an end before the start is null;
 *  - allDay: AllDayEvent is 1;
 *  - location: one line, at most 1024 characters, "" when absent;
 *  - organizer: the organizer's address, validated (sanitize.emailAddress), or null;
 *  - responseRequested: ResponseRequested is 1 (absent: false, so that no
 *    answer is sent to an organizer who did not ask for one);
 *  - recurrenceId: the original start of the occurrence this request is about, or null;
 *  - instanceType: 0 single, 1 series, 2 occurrence, 3 exception, 4 orphan occurrence, or null;
 *  - messageType: MeetingMessageType 0 to 6 (14.1; 6 = delegated, not to be answered), or null;
 *  - busy: "free" | "tentative" | "busy" | "away" (absent or unknown: "busy");
 *  - sensitivity: "public" | "private" | "confidential" (absent or unknown: "public");
 *  - zone: the time zone as eas-timezone.mjs decodes it, or null;
 *  - recurring: the request is for a series (it carries a recurrence, or InstanceType is 1).
 * Never throws; anything that is not an element gives the record of an empty element.
 */
export function readMeetingRequest(node) {
  const result = blank();
  if (!isElement(node)) return result;

  result.uid = globalObjIdUid(shortText(node, "Email:GlobalObjId", MAX_GLOBAL_OBJ_ID_TEXT));
  result.start = utcDate(shortText(node, "Email:StartTime", MAX_DATE_TEXT));
  result.end = utcDate(shortText(node, "Email:EndTime", MAX_DATE_TEXT));
  if (result.start && result.end && result.end < result.start) result.end = null; // same format: text order is time order
  result.allDay = v.flag(shortText(node, "Email:AllDayEvent", 16)) === true;
  const location = v.cleanText(startOfText(node, "Email:Location", 16 * MAX_LOCATION), { max: 4 * MAX_LOCATION, singleLine: true, stripBidi: true });
  result.location = v.cut(location.trim(), MAX_LOCATION).trim();
  result.organizer = organizerAddress(shortText(node, "Email:Organizer", MAX_ORGANIZER_TEXT));
  result.responseRequested = v.flag(shortText(node, "Email:ResponseRequested", 16)) === true;
  result.recurrenceId = utcDate(shortText(node, "Email:RecurrenceId", MAX_DATE_TEXT));
  result.instanceType = small(node, "Email:InstanceType", 4);
  result.messageType = small(node, "Email2:MeetingMessageType", 6);
  result.busy = BUSY.get(small(node, "Email:BusyStatus", 255)) ?? "busy";
  result.sensitivity = SENSITIVITY.get(small(node, "Email:Sensitivity", 255)) ?? "public";
  try {
    const zone = shortText(node, "Email:TimeZone", MAX_ZONE_TEXT);
    result.zone = zone === null ? null : decodeTimeZone(zone);
  } catch {
    result.zone = null; // not the 172-byte structure, or a field out of range
  }
  result.recurring = result.instanceType === 1 || Boolean(child(child(node, "Email:Recurrences"), "Email:Recurrence"));
  return result;
}
