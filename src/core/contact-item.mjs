// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Contacts of a Sync collection ([MS-ASCNTC], [MS-ASAIRS] for Body) ⇄ the
 * contact description.
 *
 *   CONTACT_FIELDS                                the text properties, in the order they are written
 *   contactOptions()                              → Options children of the collection
 *   contactSupported()                            → names for the Supported element
 *   readContact(applicationData, { version, fallbackUid, change? })
 *                                                 → contact description
 *   writeContact(contact, { version, previous? }) → ApplicationData children, for Add and Change
 *   checkContact(value, { fromServer? })          → clean frozen copy of a description
 *   displayName(fields)                           → the name a contact is shown under
 *   dayOfInstant(ms)                              → the day a Birthday or an Anniversary means
 *
 * A contact description:
 *
 *   { kind: "contact", uid, summary, description, categories, children,
 *     fields, birthday, birthdayAt, anniversary, anniversaryAt, picture,
 *     readOnly }
 *
 *  - `fields`: the text properties that have a value, by their ActiveSync
 *    name ("FirstName", "Email1Address", "BusinessAddressStreet", …). The
 *    description holds every one of them, whether Thunderbird shows it or
 *    not: a Change writes them all, so nothing the server holds is erased
 *    because this client has no place for it;
 *  - `summary`: the name the contact is shown under (displayName); never
 *    sent;
 *  - `description`: the notes, as plain text;
 *  - `children`: the names of the contact's children, as the server lists
 *    them;
 *  - `birthday`, `anniversary`: a DATE or null. The server holds an
 *    instant: for most clients, midnight of that day where the contact was
 *    written. `birthdayAt` and `anniversaryAt` keep that instant, so that
 *    a Change that does not touch the day gives it back unchanged;
 *  - `picture`: the picture as the server gives it, in base64, or null;
 *  - `readOnly`: null, or "incomplete" when the contact holds something
 *    the description does not, which a Change written from it would erase
 *    or alter on the server.
 *
 * What the protocol gives, and does not:
 *  - a contact has no UID on the server: the caller names it
 *    (`fallbackUid`);
 *  - an e-mail address may come as `"Name" <address>`: the address alone
 *    is kept, and written back;
 *  - Alias and WeightedRank are not properties of a stored contact (they
 *    belong to address-list searches): neither read nor written.
 *
 * The reading and writing rules are those of calendar-item.mjs: nothing is
 * guessed, a value that cannot be read whole is left out, and a contact of
 * which something was left out is read-only.
 */

import { el } from "./wbxml.mjs";
import { conversionError, parseDate, parseDateTime, formatDate, formatUtc, parseUtc, formatDateTime } from "./eas-timezone.mjs";
import { checkVersion } from "./recurrence.mjs";
import {
  LIMITS,
  bodyChanged,
  bodyElement,
  bodyPreference,
  boundedText,
  checkBlock,
  checkCategories,
  checkUid,
  childrenOf,
  cleanBlock,
  cleanLine,
  exactText,
  readBody,
  readCategories,
} from "./calendar-item.mjs";

const NS = "Contacts";
const NS2 = "Contacts2";
const DAY = 86_400_000;
/** Most characters of one text property; of a street (several lines); of a web page. */
const LINE_MAX = 256;
const STREET_MAX = 1024;
const URL_MAX = 2048;
/** Most children named, and most characters of a picture in base64 (about 150 KB of image). */
export const CHILDREN_MAX = 20;
export const PICTURE_MAX = 200_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const line = (ns, tag, max = LINE_MAX) => Object.freeze({ ns, tag, max, block: false });
const block = (ns, tag, max) => Object.freeze({ ns, tag, max, block: true });

/** The text properties of a contact, in the order they are written. */
export const CONTACT_FIELDS = Object.freeze([
  line(NS, "FileAs"), line(NS, "Title"), line(NS, "FirstName"), line(NS, "MiddleName"), line(NS, "LastName"), line(NS, "Suffix"),
  line(NS2, "NickName"), line(NS, "YomiFirstName"), line(NS, "YomiLastName"), line(NS, "YomiCompanyName"),
  line(NS, "CompanyName"), line(NS, "Department"), line(NS, "JobTitle"), line(NS, "OfficeLocation"),
  line(NS2, "ManagerName"), line(NS, "AssistantName"), line(NS, "Spouse"),
  line(NS, "Email1Address"), line(NS, "Email2Address"), line(NS, "Email3Address"),
  line(NS2, "IMAddress"), line(NS2, "IMAddress2"), line(NS2, "IMAddress3"),
  line(NS, "MobilePhoneNumber"), line(NS, "BusinessPhoneNumber"), line(NS, "Business2PhoneNumber"), line(NS, "BusinessFaxNumber"),
  line(NS, "HomePhoneNumber"), line(NS, "Home2PhoneNumber"), line(NS, "HomeFaxNumber"),
  line(NS, "PagerNumber"), line(NS, "CarPhoneNumber"), line(NS, "RadioPhoneNumber"), line(NS, "AssistantPhoneNumber"),
  line(NS2, "CompanyMainPhone"), line(NS2, "MMS"),
  block(NS, "BusinessAddressStreet", STREET_MAX), line(NS, "BusinessAddressCity"), line(NS, "BusinessAddressState"),
  line(NS, "BusinessAddressPostalCode"), line(NS, "BusinessAddressCountry"),
  block(NS, "HomeAddressStreet", STREET_MAX), line(NS, "HomeAddressCity"), line(NS, "HomeAddressState"),
  line(NS, "HomeAddressPostalCode"), line(NS, "HomeAddressCountry"),
  block(NS, "OtherAddressStreet", STREET_MAX), line(NS, "OtherAddressCity"), line(NS, "OtherAddressState"),
  line(NS, "OtherAddressPostalCode"), line(NS, "OtherAddressCountry"),
  line(NS, "WebPage", URL_MAX),
  line(NS2, "CustomerId"), line(NS2, "GovernmentId"), line(NS2, "AccountName"),
]);

const FIELD = new Map(CONTACT_FIELDS.map((f) => [f.tag, f]));
const EMAILS = new Set(["Email1Address", "Email2Address", "Email3Address"]);
const OTHER = ["Categories", "Children", "Birthday", "Anniversary", "Picture"];
const TOP_LEVEL = new Set([...CONTACT_FIELDS.filter((f) => f.ns === NS).map((f) => f.tag), ...OTHER]);
const TOP_LEVEL_2 = new Set(CONTACT_FIELDS.filter((f) => f.ns === NS2).map((f) => f.tag));

const badItem = (reason) => conversionError("BAD_ITEM", `contact invalide (${reason})`);
const isElement = (node) => Boolean(node) && typeof node === "object" && Array.isArray(node.children);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const get = (object, key) => (Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);
const cleanField = (field, value, lossy = null) => (field.block ? cleanBlock(value, field.max, lossy) : cleanLine(value, field.max, lossy)).trim();

/** The address of `"Name" <address>` or `Name <address>`; any other text as it is. */
function bareAddress(text) {
  const m = /^[^<>]*<([^<>\s]+)>\s*$/.exec(text);
  return m ? m[1] : text;
}

/**
 * The day a Birthday or an Anniversary means. The server holds an instant:
 * most clients write midnight of the day in their own time zone. Midnight
 * on this computer is that day; otherwise the nearest midnight in UTC
 * (22:00 the day before, east of Greenwich, is the day; 05:00, west of it,
 * is the day too).
 */
export function dayOfInstant(ms) {
  const local = new Date(ms);
  if (local.getHours() === 0 && local.getMinutes() === 0) {
    return formatDate(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
  }
  // Noon exactly is the day it is in UTC: the half goes down.
  const shifted = ms + DAY / 2 - 1;
  return formatDate(shifted - ((shifted % DAY) + DAY) % DAY);
}

/** The instant written for a day that has none kept: midnight of that day on this computer. */
function instantOfDay(date) {
  const day = new Date(parseDate(date));
  return new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()).getTime();
}

/**
 * The name a contact is shown under: its given, middle and family names;
 * failing that what it is filed as, its nickname, its company, its first
 * e-mail address; "" when it has none of these.
 */
export function displayName(fields) {
  const f = isRecord(fields) ? fields : {};
  const text = (tag) => (typeof get(f, tag) === "string" ? get(f, tag) : "");
  const names = [text("FirstName"), text("MiddleName"), text("LastName")].filter(Boolean).join(" ");
  return (names || text("FileAs") || text("NickName") || text("CompanyName") || text("Email1Address")).slice(0, LINE_MAX);
}

// ── Checking ──────────────────────────────────────────────────────────────

function checkDay(value, what) {
  if (value === null) return null;
  if (parseDate(value) === null) throw badItem(what);
  return value;
}

/** The instant kept beside a day: null, or a UTC instant that means that day. Any other one is dropped, not refused. */
function checkKept(value, day, what) {
  if (value === undefined || value === null) return null;
  const ms = parseUtc(value);
  if (ms === null) throw badItem(what);
  return day !== null && dayOfInstant(ms) === day ? value : null;
}

function checkFields(value) {
  if (!isRecord(value)) throw badItem("fields");
  const out = {};
  for (const field of CONTACT_FIELDS) {
    const raw = get(value, field.tag);
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") throw badItem(field.tag);
    const text = cleanField(field, EMAILS.has(field.tag) ? bareAddress(raw) : raw);
    if (text !== "") out[field.tag] = text;
  }
  for (const key of Object.keys(value)) if (!FIELD.has(key)) throw badItem("propriété inconnue");
  return Object.freeze(out);
}

function checkChildren(value) {
  if (!Array.isArray(value)) throw badItem("children");
  const names = [];
  for (const raw of value.slice(0, 10 * CHILDREN_MAX)) {
    if (typeof raw !== "string") throw badItem("children");
    const name = cleanLine(raw, LINE_MAX).trim();
    if (name && names.length < CHILDREN_MAX) names.push(name);
  }
  return Object.freeze(names);
}

function checkPicture(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 4 || value.length > PICTURE_MAX || value.length % 4 !== 0 || !BASE64.test(value)) throw badItem("picture");
  return value;
}

/**
 * A clean, deeply frozen copy of a contact description, or a ProtocolError.
 *
 *  - `fields` holds only known properties, as strings; each is cleaned and
 *    cut, an empty one is left out, an unknown name is refused.
 *  - `summary` is not taken from the value: it is displayName(fields).
 *  - `birthday` and `anniversary` are DATEs or null; `birthdayAt` and
 *    `anniversaryAt` are optional, and kept only when they mean that day.
 *  - `picture` is null or base64 text of at most PICTURE_MAX characters.
 *  - `fromServer`: only then may `description` be null (a Change without a
 *    Body: the notes held are kept).
 */
export function checkContact(value, { fromServer = false } = {}) {
  if (!isRecord(value)) throw badItem("description");
  if (get(value, "kind") !== "contact") throw badItem("kind");
  const uid = checkUid(get(value, "uid"));
  const fields = checkFields(get(value, "fields"));
  const text = get(value, "description");
  const description = fromServer === true && text === null ? null : checkBlock(text, LIMITS.description, "description");
  const categories = checkCategories(get(value, "categories"), "categories");
  const children = checkChildren(get(value, "children"));
  const birthday = checkDay(get(value, "birthday"), "birthday");
  const anniversary = checkDay(get(value, "anniversary"), "anniversary");
  const birthdayAt = checkKept(get(value, "birthdayAt"), birthday, "birthdayAt");
  const anniversaryAt = checkKept(get(value, "anniversaryAt"), anniversary, "anniversaryAt");
  const picture = checkPicture(get(value, "picture"));
  const readOnly = get(value, "readOnly");
  if (readOnly !== null && readOnly !== "incomplete") throw badItem("readOnly");
  return Object.freeze({
    kind: "contact",
    uid,
    summary: displayName(fields),
    description,
    categories,
    children,
    fields,
    birthday,
    birthdayAt,
    anniversary,
    anniversaryAt,
    picture,
    readOnly,
  });
}

// ── Reading ───────────────────────────────────────────────────────────────

/**
 * The ApplicationData of a contact → a contact description.
 *
 *  - `version`: "12.1", "14.0" or "14.1".
 *  - `fallbackUid` (required): the uid of the description.
 *  - `change`: true when the data is that of a Change command. Without a
 *    Body element, `description` is then null: whoever holds the contact
 *    keeps its notes.
 *
 * `readOnly` is "incomplete" when the contact holds something the
 * description does not: a text cut to its bound or cleaned of an invisible
 * or bidirectional character, a category or a child left out, notes the
 * server truncated or sent in another form than plain text, a date that
 * cannot be read, a picture that is too large or is not base64.
 *
 * Throws ProtocolError for a doubled element, or no uid.
 */
export function readContact(applicationData, { version, fallbackUid = null, change = false } = {}) {
  checkVersion(version);
  if (fallbackUid === null || fallbackUid === undefined) throw badItem("uid absent");
  if (!isElement(applicationData)) throw badItem("données absentes");
  const first = childrenOf(applicationData, NS, TOP_LEVEL);
  const second = childrenOf(applicationData, NS2, TOP_LEVEL_2);
  let incomplete = false;
  const lossy = () => {
    incomplete = true;
  };

  const fields = {};
  for (const field of CONTACT_FIELDS) {
    const node = (field.ns === NS ? first : second).fields.get(field.tag);
    if (!node) continue;
    // Read twice as long as kept: a text over the bound is cut, and counted as a loss.
    let text = boundedText(node, 2 * field.max, field.block ? cleanBlock : cleanLine, lossy);
    if (EMAILS.has(field.tag)) text = bareAddress(text);
    const kept = cleanField(field, text);
    if (kept.length < text.trim().length) lossy();
    if (kept !== "") fields[field.tag] = kept;
  }

  const children = [];
  if (first.fields.has("Children")) {
    for (const c of first.fields.get("Children").children) {
      if (!isElement(c) || c.ns !== NS || c.tag !== "Child") continue;
      const name = boundedText(c, LINE_MAX, cleanLine, lossy).trim();
      if (!name || children.length >= CHILDREN_MAX) {
        lossy();
        continue;
      }
      children.push(name);
    }
  }

  /** A date element → [day, instant kept]; unreadable is a loss. */
  const day = (tag) => {
    if (!first.fields.has(tag)) return [null, null];
    const text = exactText(first.fields.get(tag), 32);
    if (text === "") return [null, null];
    const ms = text === null ? null : parseDateTime(text);
    if (ms === null) {
      lossy();
      return [null, null];
    }
    try {
      return [dayOfInstant(ms), formatUtc(ms)];
    } catch {
      lossy(); // a year the description cannot hold
      return [null, null];
    }
  };
  const [birthday, birthdayAt] = day("Birthday");
  const [anniversary, anniversaryAt] = day("Anniversary");

  let picture = null;
  if (first.fields.has("Picture")) {
    const text = exactText(first.fields.get("Picture"), PICTURE_MAX);
    if (text === null || text.length > PICTURE_MAX || (text !== "" && (text.length % 4 !== 0 || !BASE64.test(text)))) lossy();
    else if (text !== "") picture = text;
  }

  const description = {
    kind: "contact",
    uid: fallbackUid,
    description: change === true && first.bodies.length === 0 ? null : readBody(first.bodies, lossy) ?? "",
    categories: first.fields.has("Categories") ? readCategories(first.fields.get("Categories"), NS, lossy) : [],
    children,
    fields,
    birthday,
    birthdayAt,
    anniversary,
    anniversaryAt,
    picture,
    readOnly: incomplete ? "incomplete" : null,
  };
  return checkContact(description, { fromServer: true });
}

// ── Writing ───────────────────────────────────────────────────────────────

/**
 * A contact description → the children of ApplicationData, for an Add as
 * for a Change.
 *
 *  - The description is checked first (checkContact); a read-only contact
 *    is refused (code "READ_ONLY_ITEM").
 *  - Every property that has a value is written; one that has none is left
 *    out, which deletes it on the server (see contactSupported), except
 *    the picture, which the server then keeps.
 *  - Birthday and Anniversary: the instant kept with the day when there is
 *    one, otherwise midnight of that day on this computer.
 *  - `previous`: for a Change, the description last synchronized; the
 *    notes are sent only when they differ from it.
 */
export function writeContact(contact, { version, previous = null } = {}) {
  checkVersion(version);
  const c = checkContact(contact);
  if (c.readOnly !== null) throw conversionError("READ_ONLY_ITEM", "contact en lecture seule");
  const instant = (date, kept) => (date === null ? null : formatDateTime(kept === null ? instantOfDay(date) : parseUtc(kept)));
  const birthday = instant(c.birthday, c.birthdayAt);
  const anniversary = instant(c.anniversary, c.anniversaryAt);
  return [
    bodyChanged(c.description, previous) ? bodyElement(c.description) : null,
    ...CONTACT_FIELDS.map((f) => (get(c.fields, f.tag) === undefined ? null : el(`${f.ns}:${f.tag}`, c.fields[f.tag]))),
    c.categories.length ? el(`${NS}:Categories`, c.categories.map((name) => el(`${NS}:Category`, name))) : null,
    c.children.length ? el(`${NS}:Children`, c.children.map((name) => el(`${NS}:Child`, name))) : null,
    birthday === null ? null : el(`${NS}:Birthday`, birthday),
    anniversary === null ? null : el(`${NS}:Anniversary`, anniversary),
    c.picture === null ? null : el(`${NS}:Picture`, c.picture),
  ].filter(Boolean);
}

// ── Sync options ──────────────────────────────────────────────────────────

/**
 * The names for the Supported element of a contacts collection: every
 * property this module reads and writes back, but the picture. A Change
 * that leaves one of them out deletes it on the server; writeContact
 * always writes them all. The picture is not named: a Change that carries
 * none (Thunderbird's card lost it, or the user removed it) leaves the
 * server's picture as it is. A picture is replaced, never removed, from
 * here.
 */
export function contactSupported() {
  return Object.freeze([...CONTACT_FIELDS.map((f) => `${f.ns}:${f.tag}`), ...OTHER.filter((tag) => tag !== "Picture").map((tag) => `${NS}:${tag}`)]);
}

/** Options children of a Sync collection of contacts: the notes as plain text of bounded size. Contacts have no period. */
export function contactOptions() {
  return [bodyPreference()];
}
