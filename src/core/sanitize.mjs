// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * The single gate for values coming from the server (or from any other
 * untrusted source). Each function returns a clean value, or null when the
 * input cannot be used: callers then skip the item instead of guessing.
 * Nothing here throws on bad input.
 */

// C0 and C1 controls and DEL, except tab, line feed and carriage return.
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// Line breaks, including the Unicode line and paragraph separators.
const LINE_BREAKS = /\r\n?|[\u2028\u2029]/g;
// Bidirectional overrides and isolates: they can disguise a name or a file extension.
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Visible-looking blanks that are letters or symbols for Unicode.
const BLANK_LOOKALIKES = new RegExp(`[${String.fromCodePoint(0x2800, 0x3164, 0xffa0, 0x115f, 0x1160)}]`, "gu");
// Invisible characters (zero-width, soft hyphen, BOM): they make two names look alike.
const INVISIBLE = /[\u00ad\u180e\u200b-\u200d\u2060\ufeff]/g;

/**
 * Characters nobody sees, removed from what is shown to the user and from
 * what is written for other people to read (a wider set than INVISIBLE,
 * which serves the names kept from the server): bidirectional marks,
 * overrides and isolates, zero-width characters and joiners, the soft
 * hyphen, invisible operators, interlinear annotations, the two
 * noncharacters of the basic plane and tags. Written by their numbers, so
 * that none of them is ever in a source file. Used with replace() only.
 */
export const UNSEEN = (() => {
  const one = (code) => String.fromCodePoint(code);
  const span = (from, to) => `${one(from)}-${one(to)}`;
  const set = [one(0xad), one(0x34f), one(0x61c), one(0x180e), span(0x200b, 0x200f), span(0x202a, 0x202e), span(0x2060, 0x206f), one(0xfeff), span(0xfff9, 0xfffb), span(0xfffe, 0xffff), span(0xe0000, 0xe007f)];
  return new RegExp(`[${set.join("")}]`, "gu");
})();

/**
 * A character class from code points and [first, last] ranges, built when
 * the module loads: such characters are never typed in a source file.
 */
const classOf = (...parts) =>
  parts.map((p) => (Array.isArray(p) ? `${String.fromCodePoint(p[0])}-${String.fromCodePoint(p[1])}` : String.fromCodePoint(p))).join("");
/**
 * What contentText removes besides controls: every character of BIDI and
 * of INVISIBLE except the two joiners U+200C and U+200D, the interlinear
 * annotation marks U+FFF9 to U+FFFB, the noncharacters U+FFFE and U+FFFF,
 * and the tag characters U+E0000 to U+E007F.
 */
const HIDDEN_CLASS = classOf(
  0x00ad, 0x061c, 0x180e, 0x200b, 0x200e, 0x200f, [0x202a, 0x202e], 0x2060, [0x2066, 0x2069], 0xfeff,
  [0xfff9, 0xfffb], 0xfffe, 0xffff, [0xe0000, 0xe007f],
);
const HIDDEN = new RegExp(`[${HIDDEN_CLASS}]`, "u");
const HIDDEN_ALL = new RegExp(`[${HIDDEN_CLASS}]`, "gu");

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
export function cut(s, max) {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

/**
 * Text for display or storage. Line breaks are normalised to "\n"; with
 * `singleLine` they become spaces. Controls are removed; with `stripBidi`,
 * so are bidirectional overrides and invisible characters (for names).
 */
export function cleanText(value, { max = 64 * 1024, singleLine = false, stripBidi = false } = {}) {
  if (typeof value !== "string") return "";
  let s = value.replace(LINE_BREAKS, "\n").replace(CONTROLS, "");
  if (singleLine) s = s.replace(/[\t\n]+/g, " ");
  if (stripBidi) s = s.replace(BIDI, "").replace(INVISIBLE, "");
  return cut(s, max);
}

/**
 * The content of a calendar item or of a task (a subject, a location, a
 * body, a category), which is written back to the server when the user
 * changes the item. Cleaned like cleanText, except that the zero-width
 * non-joiner and joiner (U+200C, U+200D) stay: Persian and Indic words and
 * emoji sequences are spelled with them, and a text read without them
 * would be sent back as another text.
 * The other invisible characters and the bidirectional ones are removed,
 * with the annotation marks, the two noncharacters of the basic plane and
 * the tag characters: hasHidden says when that happened, so that the
 * caller does not take the result for the server's text.
 * A lone surrogate becomes U+FFFD first: text it is not, and next to one
 * a character class does not match in every engine.
 */
export function contentText(value, { max = 64 * 1024, singleLine = false } = {}) {
  if (typeof value !== "string") return "";
  const text = value.isWellFormed() ? value : value.toWellFormed();
  let s = text.replace(LINE_BREAKS, "\n").replace(CONTROLS, "");
  if (singleLine) s = s.replace(/[\t\n]+/g, " ");
  return cut(s.replace(HIDDEN_ALL, ""), max);
}

/**
 * Whether contentText removes from `value` more than control characters
 * and line breaks: a character that is part of the text for the server,
 * and that the cleaned text no longer has. A lone surrogate, which
 * contentText replaces, is one.
 */
export function hasHidden(value) {
  return typeof value === "string" && (!value.isWellFormed() || HIDDEN.test(value));
}

/** No control character (including tab and line breaks) at all. */
export const hasControl = (s) => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s);

/** ServerId, CollectionId, ParentId, ClientId: 1 to 64 characters, no control ([MS-ASCMD]). */
export function itemId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || hasControl(value)) return null;
  if (!value.isWellFormed()) return null; // lone surrogate: not text
  return value;
}

/** SyncKey: 1 to 64 visible ASCII characters. */
export function syncKey(value) {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,64}$/.test(value)) return null;
  return value;
}

/** Status code: 1 to 4 digits. */
export function status(value) {
  // Normalised ("0140" → "140") so a status cannot dodge the code that handles it.
  return typeof value === "string" && /^\d{1,4}$/.test(value) ? String(Number(value)) : null;
}

/** Integer written in decimal, within [min, max]. */
export function integer(value, { min = 0, max = 2 ** 31 - 1 } = {}) {
  if (typeof value !== "string" || !/^-?\d{1,10}$/.test(value)) return null;
  const n = Number(value) || 0; // never -0
  return n >= min && n <= max ? n : null;
}

/** "0" or "1" → false or true. */
export function flag(value) {
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}

/**
 * E-mail address (addr-spec, dot-atom form only), at most 254 characters.
 * Enough for ordinary mailbox addresses; anything else is refused.
 */
export function emailAddress(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s.length > 254) return null;
  const m = /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/.exec(s);
  if (!m || m[1].length > 64) return null;
  return s;
}

/** Folder name shown in Thunderbird: one line, no bidi trick, not "." or "..", 1 to 255 characters. */
export function folderName(value) {
  if (typeof value !== "string") return null;
  let s = cleanText(value.normalize("NFC"), { max: 1024, singleLine: true, stripBidi: true });
  // Format and default-ignorable characters (zero-width, fillers, tags, variation selectors…).
  s = s.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");
  // Lone surrogates, private use, unassigned code points and noncharacters: refused.
  if (/[\p{Cs}\p{Co}\p{Cn}]/u.test(s)) return null;
  s = s.replace(/(\p{M}{4})\p{M}+/gu, "$1"); // at most four stacked combining marks
  s = cut(s.trim(), 255).trim();
  // Something visible must remain (a blank braille pattern does not count).
  if (!/[\p{L}\p{N}\p{P}\p{S}]/u.test(s.replace(BLANK_LOOKALIKES, ""))) return null;
  if (s === "." || s === "..") return null;
  return s;
}

/**
 * A person's or a mailbox's display name (typed by the user, or the
 * UserDisplayName sent by the server): one line, NFC, at most `max`
 * characters, without controls, bidirectional or format characters,
 * default-ignorable, private-use, unassigned or lone-surrogate code points
 * (the account experiment refuses all of them). → the name, or null when
 * nothing visible remains.
 */
export function personName(value, { max = 256 } = {}) {
  if (typeof value !== "string") return null;
  let s = cleanText(value.normalize("NFC"), { max: 4 * max, singleLine: true, stripBidi: true });
  s = s.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\p{Cn}\p{Cs}]/gu, "");
  s = s.replace(/(\p{M}{4})\p{M}+/gu, "$1");
  s = cut(s.replace(/\s+/gu, " ").trim(), max).trim();
  if (!/[\p{L}\p{N}\p{P}\p{S}]/u.test(s.replace(BLANK_LOOKALIKES, ""))) return null;
  return s;
}

/** Policy key from Provision: a 32-bit unsigned number. */
export function policyKey(value) {
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value) || Number(value) > 0xffffffff) return null;
  return value;
}
