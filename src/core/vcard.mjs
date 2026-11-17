// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * vCards of a Thunderbird address book ⇄ contact descriptions
 * (contact-item.mjs). Written from RFC 6350 (vCard 4.0), reading what
 * RFC 2426 (vCard 3.0) writes as well.
 *
 *   parseVCard(text)                      → [property] of the first card, or null
 *   projectVCard(text)                    → what the card says, in ActiveSync terms (a "projection"), or null
 *   buildVCard(contact, { existing? })    → the card of a contact description
 *   mergeLocal(item, base, now, uid)      → the description to send for a card the user changed
 *   sameProjection(a, b)                  → whether two projections say the same
 *   MAPPED_FIELDS                         the text properties a card can say
 *
 * A card says less than a contact holds, and more: it has no place for the
 * name of an assistant or a radio phone, and it may hold a fourth e-mail
 * address or properties of other programs. Nothing is lost either way:
 *  - what a card cannot say stays in the description last synchronized,
 *    and mergeLocal changes in it only what the user changed in the card
 *    (the projection now, compared with the projection when the card was
 *    written: `base`);
 *  - what a contact cannot hold stays in the card: buildVCard keeps, from
 *    the existing card, every property it does not write itself, and the
 *    ones that found no place in the contact.
 *
 * Places. E-mail addresses fill Email1Address to Email3Address in the
 * order of the card (a preferred one first). A telephone number goes by
 * its type: cell, fax (home or work), pager, car, work (two), home (two);
 * a number of another type, or beyond the places of its type, stays in the
 * card. An address goes by its type: work, home, any other. FN is what the
 * contact is filed as (FileAs).
 *
 * Values that come from the server are escaped before they are written:
 * a line break, a semicolon or a comma never ends a property. Nothing in a
 * card is executed or fetched here.
 */

import { checkContact, displayName, CONTACT_FIELDS } from "./contact-item.mjs";
import { parseDate, conversionError } from "./eas-timezone.mjs";
import { LIMITS } from "./calendar-item.mjs";

/** Most characters of a card that is read, most properties, and most characters kept from an existing card. */
export const VCARD_MAX = 1024 * 1024;
const PROPERTIES_MAX = 1000;
const KEPT_MAX = 256 * 1024;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const KNOWN = new Set(CONTACT_FIELDS.map((f) => f.tag));
const LIMIT_OF = new Map(CONTACT_FIELDS.map((f) => [f.tag, f.max]));
const tooLarge = () => conversionError("TOO_LARGE", "contact trop volumineux");

const NAME_PARTS = ["LastName", "FirstName", "MiddleName", "Title", "Suffix"];
const ADDRESS_KINDS = ["Business", "Home", "Other"];
const ADDRESS_PARTS = ["Street", "City", "State", "PostalCode", "Country"];
const EMAIL_TAGS = ["Email1Address", "Email2Address", "Email3Address"];
const IM_TAGS = ["IMAddress", "IMAddress2", "IMAddress3"];
const PHONE_TAGS = [
  "MobilePhoneNumber", "BusinessPhoneNumber", "Business2PhoneNumber", "BusinessFaxNumber", "HomePhoneNumber", "Home2PhoneNumber",
  "HomeFaxNumber", "PagerNumber", "CarPhoneNumber",
];

/** The text properties a card can say; every other one is kept from the description last synchronized. */
export const MAPPED_FIELDS = Object.freeze([
  "FileAs", ...NAME_PARTS, "NickName", "CompanyName", "Department", "JobTitle", ...EMAIL_TAGS, ...IM_TAGS, ...PHONE_TAGS,
  ...ADDRESS_KINDS.flatMap((kind) => ADDRESS_PARTS.map((part) => `${kind}Address${part}`)), "WebPage",
]);
for (const tag of MAPPED_FIELDS) if (!KNOWN.has(tag)) throw new Error(`vcard : propriété inconnue ${tag}`);

/** Properties buildVCard writes itself: an existing one is replaced, unless it found no place in the contact. */
const WRITTEN = new Set([
  "BEGIN", "END", "VERSION", "UID", "FN", "N", "NICKNAME", "ORG", "TITLE", "EMAIL", "IMPP", "TEL", "ADR", "URL", "NOTE", "CATEGORIES",
  "BDAY", "ANNIVERSARY", "PHOTO",
]);

// ── Reading ───────────────────────────────────────────────────────────────

/** Split at each `separator` that is not escaped by a backslash. */
function splitRaw(value, separator) {
  const parts = [];
  let part = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && i + 1 < value.length) {
      part += c + value[++i];
    } else if (c === separator) {
      parts.push(part);
      part = "";
    } else {
      part += c;
    }
  }
  parts.push(part);
  return parts;
}

function unescapeText(value) {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c !== "\\" || i + 1 >= value.length) {
      out += c;
      continue;
    }
    const next = value[++i];
    out += next === "n" || next === "N" ? "\n" : next;
  }
  return out;
}

/** One structured value → its components, each one a list joined by spaces. */
const components = (value) => splitRaw(value, ";").map((part) => splitRaw(part, ",").map(unescapeText).map((s) => s.trim()).filter(Boolean).join(" "));

/** "NAME;PARAM=a,b;PARAM2="c":value" → { group, name, params, value, raw }, or null. */
function parseLine(raw) {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const head = [];
  let part = "";
  quoted = false;
  for (const c of raw.slice(0, colon)) {
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      head.push(part);
      part = "";
    } else {
      part += c;
    }
  }
  head.push(part);
  let name = head[0].trim();
  let group = null;
  const dot = name.lastIndexOf(".");
  if (dot >= 0) {
    group = name.slice(0, dot);
    name = name.slice(dot + 1);
  }
  if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) return null;
  const params = new Map();
  for (const p of head.slice(1)) {
    const eq = p.indexOf("=");
    // vCard 2.1 and 3.0 allow a bare type: "TEL;WORK;VOICE".
    const key = (eq < 0 ? "TYPE" : p.slice(0, eq)).trim().toUpperCase();
    const text = eq < 0 ? p : p.slice(eq + 1);
    const values = text.replace(/"/g, "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    params.set(key, [...(params.get(key) ?? []), ...values]);
  }
  return { group, name: name.toUpperCase(), params, value: raw.slice(colon + 1), raw };
}

/**
 * The properties of the first card of `text`, in order (BEGIN and END left
 * out): [{ group, name, params: Map<NAME, [lower-case values]>, value, raw }].
 * `value` is the text after the colon, still escaped. null when the text
 * is no card, or is larger than a card may be.
 */
export function parseVCard(text) {
  if (typeof text !== "string" || text.length > VCARD_MAX) return null;
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out = [];
  let inside = false;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const p = parseLine(raw);
    if (!p) continue;
    if (!inside) {
      if (p.name === "BEGIN" && p.value.trim().toUpperCase() === "VCARD") inside = true;
      continue;
    }
    if (p.name === "END" && p.value.trim().toUpperCase() === "VCARD") return out;
    if (out.length >= PROPERTIES_MAX) return null;
    out.push(p);
  }
  return null; // no card, or one that does not end
}

const types = (p) => new Set([...(p.params.get("TYPE") ?? [])]);
const preferred = (p) => p.params.has("PREF") || types(p).has("pref");

/** "19800515", "1980-05-15" or one of them followed by a time → "1980-05-15"; anything else (no year, a text) → null. */
function dayOf(value) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/.exec(value.trim());
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  return parseDate(day) === null ? null : day;
}

/** The picture a PHOTO property holds in the card itself, in base64, or null (a link is not a picture held). */
function pictureOf(p) {
  const value = p.value.trim();
  const data = /^data:image\/[a-z0-9.+-]+;base64\\?,(.*)$/i.exec(value);
  const text = data ? data[1] : (p.params.get("ENCODING") ?? []).some((e) => e === "b" || e === "base64") ? value : null;
  if (text === null) return null;
  const clean = text.replace(/\s+/g, "");
  return /^[A-Za-z0-9+/]+={0,2}$/.test(clean) && clean.length % 4 === 0 ? clean : null;
}

/** The place of a telephone number, by its types: a list of candidates, in order. */
function phonePlaces(p) {
  const t = types(p);
  if (t.has("fax")) return [t.has("home") ? "HomeFaxNumber" : "BusinessFaxNumber"];
  if (t.has("cell")) return ["MobilePhoneNumber"];
  if (t.has("pager")) return ["PagerNumber"];
  if (t.has("car")) return ["CarPhoneNumber"];
  if (t.has("work")) return ["BusinessPhoneNumber", "Business2PhoneNumber"];
  if (t.has("home")) return ["HomePhoneNumber", "Home2PhoneNumber"];
  return [];
}

/**
 * What a card says, in ActiveSync terms, and which of its properties said
 * it:
 *
 *   { fields, categories, description, birthday, anniversary, picture, used }
 *
 * `fields` holds only MAPPED_FIELDS, the ones that have a value. `used` is
 * the set of indexes (in parseVCard's list) of the properties that found a
 * place. null when the text is no card.
 */
function project(text) {
  const props = parseVCard(text);
  if (props === null) return null;
  const fields = {};
  const used = new Set();
  const put = (tag, value, index) => {
    const clean = value.trim();
    if (clean === "" || fields[tag] !== undefined) return false;
    fields[tag] = clean;
    used.add(index);
    return true;
  };
  const categories = [];
  let description = null;
  let birthday = null;
  let anniversary = null;
  let picture = null;
  const emails = [];

  props.forEach((p, i) => {
    switch (p.name) {
      case "FN":
        put("FileAs", unescapeText(p.value), i);
        break;
      case "N": {
        if (NAME_PARTS.some((tag) => fields[tag] !== undefined)) break;
        const parts = components(p.value);
        NAME_PARTS.forEach((tag, k) => put(tag, parts[k] ?? "", i));
        used.add(i);
        break;
      }
      case "NICKNAME":
        put("NickName", components(p.value)[0] ?? "", i);
        break;
      case "ORG": {
        if (fields.CompanyName !== undefined || fields.Department !== undefined) break;
        const parts = splitRaw(p.value, ";").map(unescapeText);
        put("CompanyName", parts[0] ?? "", i);
        put("Department", parts.slice(1).map((s) => s.trim()).filter(Boolean).join(" "), i);
        used.add(i);
        break;
      }
      case "TITLE":
        put("JobTitle", unescapeText(p.value), i);
        break;
      case "EMAIL":
        if (unescapeText(p.value).trim()) emails.push([i, p]);
        break;
      case "IMPP":
        for (const tag of IM_TAGS) if (put(tag, unescapeText(p.value), i)) break;
        break;
      case "TEL": {
        const number = unescapeText(p.value).trim().replace(/^tel:/i, "");
        for (const tag of phonePlaces(p)) if (put(tag, number, i)) break;
        break;
      }
      case "ADR": {
        const t = types(p);
        const kind = t.has("work") ? "Business" : t.has("home") ? "Home" : "Other";
        if (ADDRESS_PARTS.some((part) => fields[`${kind}Address${part}`] !== undefined)) break;
        const raw = splitRaw(p.value, ";");
        const lines = (part) => splitRaw(part ?? "", ",").map(unescapeText).map((s) => s.trim()).filter(Boolean).join("\n");
        // Post office box and extended address are lines of the street: ActiveSync has no place of their own for them.
        put(`${kind}AddressStreet`, [lines(raw[0]), lines(raw[1]), lines(raw[2])].filter(Boolean).join("\n"), i);
        const parts = components(p.value);
        ADDRESS_PARTS.slice(1).forEach((part, k) => put(`${kind}Address${part}`, parts[3 + k] ?? "", i));
        used.add(i);
        break;
      }
      case "URL":
        put("WebPage", unescapeText(p.value), i);
        break;
      case "NOTE":
        if (description === null) {
          description = unescapeText(p.value);
          used.add(i);
        }
        break;
      case "CATEGORIES":
        for (const name of splitRaw(p.value, ",").map(unescapeText).map((s) => s.trim()).filter(Boolean)) categories.push(name);
        used.add(i);
        break;
      case "BDAY":
        if (birthday === null && (birthday = dayOf(p.value)) !== null) used.add(i);
        break;
      case "ANNIVERSARY":
        if (anniversary === null && (anniversary = dayOf(p.value)) !== null) used.add(i);
        break;
      case "PHOTO":
        if (picture === null && (picture = pictureOf(p)) !== null) used.add(i);
        break;
      default:
        break;
    }
  });
  // E-mail addresses: the preferred ones first, then the order of the card.
  emails.sort((a, b) => Number(preferred(b[1])) - Number(preferred(a[1])));
  emails.slice(0, EMAIL_TAGS.length).forEach(([i, p], k) => put(EMAIL_TAGS[k], unescapeText(p.value), i));
  return { props, used, fields, categories, description: description ?? "", birthday, anniversary, picture };
}

/** The projection of a card (see the module comment), or null when the text is no card. */
export function projectVCard(text) {
  const p = project(text);
  if (p === null) return null;
  return { fields: p.fields, categories: p.categories, description: p.description, birthday: p.birthday, anniversary: p.anniversary, picture: p.picture };
}

/** The UID a card gives itself, or null. */
export function uidOfVCard(text) {
  const uid = parseVCard(text)?.find((p) => p.name === "UID");
  return uid ? unescapeText(uid.value).trim() || null : null;
}

export function sameProjection(a, b) {
  if (!isRecord(a) || !isRecord(b)) return false;
  const list = (x) => JSON.stringify(Array.isArray(x) ? x : []);
  for (const tag of MAPPED_FIELDS) if ((a.fields?.[tag] ?? "") !== (b.fields?.[tag] ?? "")) return false;
  return (
    list(a.categories) === list(b.categories) &&
    (a.description ?? "") === (b.description ?? "") &&
    (a.birthday ?? null) === (b.birthday ?? null) &&
    (a.anniversary ?? null) === (b.anniversary ?? null) &&
    (a.picture ?? null) === (b.picture ?? null)
  );
}

// ── Writing ───────────────────────────────────────────────────────────────

/**
 * A text value: backslash, line break and comma are escaped. A semicolon is
 * not: it separates nothing in a value that is one text, and Thunderbird
 * keeps a backslash written before it.
 */
const escapeText = (value) => String(value).replace(/\\/g, "\\\\").replace(/\r\n?|\n/g, "\\n").replace(/,/g, "\\,");
/** One component of a structured value (N, ADR, ORG): the semicolon separates the components, and is escaped. */
const escapePart = (value) => escapeText(value).replace(/;/g, "\\;");
const structured = (parts) => parts.map((part) => escapePart(part ?? "")).join(";");

/** The media type of a picture, from its first bytes in base64; JPEG when it is not told. */
function pictureType(base64) {
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("R0lG")) return "image/gif";
  return "image/jpeg";
}

/**
 * The card of a contact description (checked first: checkContact), as
 * vCard 4.0 with CRLF line ends. Its UID is the uid of the description.
 *
 * `existing`: the card Thunderbird holds for this contact. Kept from it:
 * the properties this function does not write, and those of its own kinds
 * that found no place in a contact (a fourth e-mail address, a telephone
 * number of another type, a picture given as a link, a birthday without a
 * year); at most 256 KiB of them.
 */
export function buildVCard(contact, { existing = null } = {}) {
  const c = checkContact(contact, { fromServer: true });
  const f = c.fields;
  const has = (tag) => f[tag] !== undefined;
  const lines = ["BEGIN:VCARD", "VERSION:4.0", `UID:${escapeText(c.uid)}`];
  const add = (name, value) => lines.push(`${name}:${value}`);

  add("FN", escapeText(f.FileAs ?? displayName(f)));
  if (NAME_PARTS.some(has)) add("N", structured(NAME_PARTS.map((tag) => f[tag])));
  if (has("NickName")) add("NICKNAME", escapeText(f.NickName));
  if (has("CompanyName") || has("Department")) add("ORG", structured(has("Department") ? [f.CompanyName, f.Department] : [f.CompanyName]));
  if (has("JobTitle")) add("TITLE", escapeText(f.JobTitle));
  EMAIL_TAGS.filter(has).forEach((tag, k) => add(k === 0 ? "EMAIL;PREF=1" : "EMAIL", escapeText(f[tag])));
  for (const tag of IM_TAGS) if (has(tag)) add("IMPP", escapeText(f[tag]));
  const phone = (tag, type) => has(tag) && add(`TEL;TYPE=${type};VALUE=TEXT`, escapeText(f[tag]));
  phone("MobilePhoneNumber", "cell");
  phone("BusinessPhoneNumber", "work");
  phone("Business2PhoneNumber", "work");
  phone("BusinessFaxNumber", "fax");
  phone("HomePhoneNumber", "home");
  phone("Home2PhoneNumber", "home");
  phone("HomeFaxNumber", "fax,home");
  phone("PagerNumber", "pager");
  phone("CarPhoneNumber", "car");
  for (const [kind, type] of [["Business", ";TYPE=work"], ["Home", ";TYPE=home"], ["Other", ""]]) {
    const parts = ADDRESS_PARTS.map((part) => f[`${kind}Address${part}`]);
    if (parts.some((part) => part !== undefined)) add(`ADR${type}`, structured(["", "", ...parts]));
  }
  if (has("WebPage")) add("URL", escapeText(f.WebPage));
  if (c.description) add("NOTE", escapeText(c.description));
  if (c.categories.length) add("CATEGORIES", c.categories.map(escapeText).join(","));
  if (c.birthday !== null) add("BDAY;VALUE=DATE", c.birthday.replace(/-/g, ""));
  if (c.anniversary !== null) add("ANNIVERSARY;VALUE=DATE", c.anniversary.replace(/-/g, ""));
  if (c.picture !== null) add("PHOTO;VALUE=URL", `data:${pictureType(c.picture)};base64,${c.picture}`);

  const before = typeof existing === "string" ? project(existing) : null;
  if (before !== null) {
    let kept = 0;
    before.props.forEach((p, i) => {
      if (p.name === "BEGIN" || p.name === "END" || p.name === "VERSION" || p.name === "UID") return;
      if (WRITTEN.has(p.name) && before.used.has(i)) return;
      // A second FN, N or NOTE would be read instead of ours by another reader.
      if (p.name === "FN" || p.name === "N" || p.name === "NOTE" || p.name === "ORG") return;
      const line = p.raw.replace(/[\r\n]/g, "");
      kept += line.length;
      if (kept <= KEPT_MAX) lines.push(line);
    });
  }
  lines.push("END:VCARD");
  return `${lines.join("\r\n")}\r\n`;
}

// ── A card the user changed ───────────────────────────────────────────────

/**
 * The description to send for a card the user changed.
 *
 *  - `item`: the description last synchronized (null for a new contact);
 *  - `base`: the projection of the card when it was last written or
 *    acknowledged (null for a new contact);
 *  - `now`: the projection of the card as it is;
 *  - `uid`: the uid of the description;
 *  - `said`: `now` in the form `base` is kept in, when that is not the
 *    form of `now` (the caller may keep hashes of the notes and of the
 *    picture): what is compared with `base`.
 *
 * Throws (code "TOO_LARGE") when a text the user changed is longer than
 * the contact can hold.
 *
 * Only what differs between `base` and `now` is changed in `item`: a
 * property the card cannot say, or says in another way than the server,
 * goes back as the server gave it. A day that changed loses the instant
 * kept with it. The picture is the one the card holds.
 * → a checked contact description (checkContact), `readOnly` as in `item`.
 */
export function mergeLocal(item, base, now, uid, said = now) {
  const before = isRecord(item) ? item : null;
  const b = isRecord(base) ? base : { fields: {}, categories: [], description: "", birthday: null, anniversary: null, picture: null };
  const fields = { ...(before?.fields ?? {}) };
  for (const tag of MAPPED_FIELDS) {
    const value = now.fields?.[tag] ?? "";
    if (value === (b.fields?.[tag] ?? "")) continue;
    if (value === "") delete fields[tag];
    else fields[tag] = value;
  }
  // Nothing the user wrote is cut without a word: a text over its bound is refused, and the caller tells the user.
  for (const tag of MAPPED_FIELDS) {
    const value = now.fields?.[tag] ?? "";
    if (value !== (b.fields?.[tag] ?? "") && value.length > LIMIT_OF.get(tag)) throw tooLarge();
  }
  if ((now.description ?? "").length > LIMITS.description) throw tooLarge();
  const changed = (key) => JSON.stringify(said[key] ?? null) !== JSON.stringify(b[key] ?? null);
  const day = (key) => (changed(key) || !before ? [now[key] ?? null, null] : [before[key] ?? null, before[`${key}At`] ?? null]);
  const [birthday, birthdayAt] = day("birthday");
  const [anniversary, anniversaryAt] = day("anniversary");
  return checkContact({
    kind: "contact",
    uid,
    description: changed("description") || !before || typeof before.description !== "string" ? now.description ?? "" : before.description,
    categories: changed("categories") || !before ? now.categories ?? [] : before.categories ?? [],
    children: before?.children ?? [],
    fields,
    birthday,
    birthdayAt,
    anniversary,
    anniversaryAt,
    picture: now.picture ?? null,
    readOnly: before?.readOnly ?? null,
  });
}
