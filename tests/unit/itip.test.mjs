// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the iTIP messages against RFC 5545 (content lines, folding,
 * TEXT, parameters, VTIMEZONE, RRULE), RFC 5546 (REQUEST, REPLY, CANCEL),
 * RFC 6047 (the text/calendar part) and RFC 5322 / 2045 to 2047 (the
 * message). The readers below are written from those RFCs, apart from the
 * module: what they find in a message is what a recipient would find.
 *
 * Hostile characters are built at run time, never written in this file.
 */

import { test, assert, eq, throws, prng } from "./harness.mjs";
import { itipCalendar, itipMessage, escapeText, strictText, foldLine, ItipError, MAX_MEETING_RECIPIENTS, MAX_CALENDAR_LENGTH, MAX_TEXT_LENGTH } from "../../src/core/itip.mjs";
import { offsetMinutesAt, UTC_ZONE } from "../../src/core/eas-timezone.mjs";
import { encodeUtf8, decodeUtf8 } from "../../src/core/utf8.mjs";
import { sendMailRequest } from "../../src/core/protocol.mjs";
import { encode, decode, bytes as rawBytes } from "../../src/core/wbxml.mjs";
import { messageIdOf, dateOf, fromAddressOf } from "../../src/core/mime.mjs";
import { topContentType } from "../../src/send.mjs";

const ch = (code) => String.fromCodePoint(code);
const NUL = ch(0);
const BEL = ch(7);
const ESC = ch(0x1b);
const DEL = ch(0x7f);
const NEL = ch(0x85);
const LSEP = ch(0x2028);
const PSEP = ch(0x2029);
const RLO = ch(0x202e);
const LRI = ch(0x2066);
const ZWSP = ch(0x200b);
const BOM = ch(0xfeff);
const E_ACUTE = ch(0xe9); // two bytes in UTF-8
const EURO = ch(0x20ac); // three
const SMILE = ch(0x1f600); // four, and two UTF-16 units
const refused = (code, fn, what) => throws(fn, (e) => e instanceof ItipError && e.code === code, what);
const octets = (s) => encodeUtf8(s).length;

// ── A reader of iCalendar (RFC 5545 3.1, 3.2, 3.3.11) ─────────────────────

/** Physical lines checked (CRLF only, at most 75 octets, whole characters), then unfolded into content lines. */
function unfold(ics) {
  assert(typeof ics === "string" && ics.endsWith("\r\n"), "ends with CRLF");
  const physical = ics.slice(0, -2).split("\r\n");
  const lines = [];
  for (const line of physical) {
    assert(!line.includes("\r") && !line.includes("\n"), "no bare CR or LF");
    assert(octets(line) <= 75, `physical line of ${octets(line)} octets`);
    assert(line.isWellFormed(), "no cut inside a character");
    for (const c of line) assert(c.codePointAt(0) >= 0x20 || c === "\t", "no control character");
    if (line.startsWith(" ")) {
      assert(lines.length > 0, "a continuation follows a line");
      lines[lines.length - 1] += line.slice(1);
    } else {
      assert(line.length > 0, "no empty line");
      lines.push(line);
    }
  }
  return lines;
}

/** name *(";" param "=" value) ":" value, a parameter value being quoted or free of ";" and ":". */
function parseLine(line) {
  const m = /^([A-Z0-9-]+)/.exec(line);
  assert(m, `property name in ${JSON.stringify(line.slice(0, 30))}`);
  let i = m[1].length;
  const params = new Map();
  while (line[i] === ";") {
    const equals = line.indexOf("=", i);
    const key = line.slice(i + 1, equals);
    assert(/^[A-Z-]+$/.test(key), `parameter name ${JSON.stringify(key)}`);
    assert(!params.has(key), `parameter ${key} twice`);
    i = equals + 1;
    let value;
    if (line[i] === '"') {
      const close = line.indexOf('"', i + 1);
      assert(close > 0, "closing quote");
      value = line.slice(i + 1, close);
      i = close + 1;
    } else {
      const end = /[;:]/.exec(line.slice(i));
      assert(end, "end of parameter");
      value = line.slice(i, i + end.index);
      assert(!value.includes('"') && !value.includes(","), "unquoted value");
      i += end.index;
    }
    params.set(key, value);
  }
  assert(line[i] === ":", `colon after the parameters of ${m[1]}`);
  return { name: m[1], params, value: line.slice(i + 1) };
}

/** A TEXT value back to its text. An escape that RFC 5545 does not define fails the test. */
function unescapeText(value) {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    assert(c !== ";" && c !== ",", "a bare separator in a TEXT value");
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = value[++i];
    assert(next === "\\" || next === ";" || next === "," || next === "n" || next === "N", `escape \\${next}`);
    out += next === "n" || next === "N" ? "\n" : next;
  }
  return out;
}

/** → { top, zone, events }: parsed lines outside components, of the VTIMEZONE, and of each VEVENT. */
function readCalendar(ics) {
  const lines = unfold(ics).map(parseLine);
  eq([lines[0].name, lines[0].value], ["BEGIN", "VCALENDAR"]);
  eq([lines[lines.length - 1].name, lines[lines.length - 1].value], ["END", "VCALENDAR"]);
  const result = { top: [], zone: [], events: [] };
  let into = result.top;
  const open = [];
  for (const line of lines.slice(1, -1)) {
    if (line.name === "BEGIN") {
      open.push(line.value);
      if (line.value === "VEVENT") {
        eq(open, ["VEVENT"]);
        result.events.push((into = []));
      } else {
        assert(open[0] === "VTIMEZONE" && ["VTIMEZONE", "STANDARD", "DAYLIGHT"].includes(line.value), `component ${line.value}`);
        into = result.zone;
        into.push(line);
      }
    } else if (line.name === "END") {
      eq(line.value, open.pop(), "components close in order");
      if (open.length) into.push(line);
      else if (line.value === "VTIMEZONE") into.push(line), (into = result.top);
      else into = result.top;
    } else {
      into.push(line);
    }
  }
  eq(open, [], "every component is closed");
  return result;
}

const all = (lines, name) => lines.filter((l) => l.name === name);
const one = (lines, name) => {
  const found = all(lines, name);
  eq(found.length, 1, `exactly one ${name}`);
  return found[0];
};
const names = (lines) => lines.map((l) => l.name);
const shape = (ics) => {
  const c = readCalendar(ics);
  return [names(c.top), names(c.zone), c.events.map(names)];
};

// ── Fixtures ──────────────────────────────────────────────────────────────

const ANA = { email: "ana@example.org", name: "Ana Ruiz" };
const BO = { email: "bo@example.org", name: "Bo Chen", role: "required", status: "unknown" };
const CY = { email: "cy@example.net", name: "", role: "optional", status: "unknown" };
const ROOM = { email: "room4@example.org", name: "Room 4", role: "resource", status: "unknown" };
const PEOPLE = [BO, CY, ROOM];
const STAMP = "2026-11-16T08:00:00Z";

const PARIS = { bias: -60, standard: { bias: 0, change: { month: 10, week: 5, weekday: 0, hour: 3, minute: 0 } }, daylight: { bias: -60, change: { month: 3, week: 5, weekday: 0, hour: 2, minute: 0 } } };
const PACIFIC = { bias: 480, standard: { bias: 0, change: { month: 11, week: 1, weekday: 0, hour: 2, minute: 0 } }, daylight: { bias: -60, change: { month: 3, week: 2, weekday: 0, hour: 2, minute: 0 } } };
const SYDNEY = { bias: -600, standard: { bias: 0, change: { month: 4, week: 1, weekday: 0, hour: 3, minute: 0 } }, daylight: { bias: -60, change: { month: 10, week: 1, weekday: 0, hour: 2, minute: 0 } } };
const KOLKATA = { bias: -330, standard: { bias: 0, change: null }, daylight: { bias: 0, change: null } };
// "Daylight" time that is behind standard time: the winter hour of a zone whose standard time is its summer time.
const DUBLIN = { bias: -60, standard: { bias: 0, change: { month: 3, week: 5, weekday: 0, hour: 1, minute: 0 } }, daylight: { bias: 60, change: { month: 10, week: 5, weekday: 0, hour: 2, minute: 0 } } };
const PARIS_TZID = "Sync443/UTC+0100/DST+0200/M3.5.0.0200/M10.5.0.0300";

const anEvent = (over = {}) => ({
  kind: "event",
  uid: "meeting-42@example.org",
  summary: "Weekly point",
  location: "Room 4",
  description: "Agenda:\n- one\n- two",
  allDay: false,
  start: "2026-11-20T09:00:00Z",
  end: "2026-11-20T10:00:00Z",
  timezone: null,
  busy: "busy",
  privacy: "public",
  reminder: 15,
  categories: ["Team"],
  organizer: ANA,
  attendees: PEOPLE,
  meeting: { role: "organizer", cancelled: false, responseRequested: true, response: "none", allowNewTime: true },
  recurrence: null,
  exceptions: [],
  stamp: null,
  sequence: 0,
  readOnly: null,
  ...over,
});
const weekly = (over = {}) => ({ freq: "weekly", interval: 1, count: null, until: null, byDay: ["FR"], bySetPos: null, byMonthDay: null, byMonth: null, weekStart: null, ...over });
const request = (over = {}, args = {}) => itipCalendar({ method: "REQUEST", event: anEvent(over), attendees: PEOPLE, stamp: STAMP, sequence: 0, ...args });
const cancel = (over = {}, args = {}) => itipCalendar({ method: "CANCEL", event: anEvent(over), attendees: PEOPLE, stamp: STAMP, sequence: 1, ...args });
const ME = { email: "me@example.com", name: "Me Myself" };
const reply = (over = {}, args = {}) => itipCalendar({ method: "REPLY", event: anEvent(over), attendees: [ME], replyStatus: "accepted", stamp: STAMP, sequence: 0, ...args });
const firstEvent = (ics) => readCalendar(ics).events[0];
const BENIGN_SHAPE = shape(request());

// ── escapeText and foldLine ───────────────────────────────────────────────

test("escapeText: backslash, semicolon, comma and line breaks, as RFC 5545 3.3.11 says", () => {
  eq(escapeText("a\\b;c,d\ne"), "a\\\\b\\;c\\,d\\ne");
  eq(escapeText("plain: \"text\" with a colon"), "plain: \"text\" with a colon", "colons and quotes are not escaped in TEXT");
  eq(escapeText("\\n"), "\\\\n", "a backslash and an n are not a line break");
  eq(escapeText("\\\\;"), "\\\\\\\\\\;");
  eq(unescapeText(escapeText("a\\b;c,d\ne\\n;,\\")), "a\\b;c,d\ne\\n;,\\");
  eq(escapeText(""), "");
  for (const notText of [null, undefined, 5, {}, ["a"], true]) eq(escapeText(notText), "", String(notText));
});

test("escapeText: every kind of line break becomes one escaped line break, or a space on one line", () => {
  const breaks = `a\r\nb\rc\nd${LSEP}e${PSEP}f`;
  eq(escapeText(breaks), "a\\nb\\nc\\nd\\ne\\nf");
  eq(escapeText(breaks, { singleLine: true }), "a b c d e f");
  eq(escapeText("a\r\n\r\n\tb", { singleLine: true }), "a b");
  eq(escapeText(`a${NEL}b`), "ab", "NEL is a control: removed");
  for (const text of [breaks, `x\r\nATTENDEE:mailto:eve@evil.example\r\n`, "\r", "\n", "\r\n", `${LSEP}`]) {
    for (const singleLine of [false, true]) {
      const out = escapeText(text, { singleLine });
      assert(!out.includes("\r") && !out.includes("\n") && !out.includes(LSEP) && !out.includes(PSEP), JSON.stringify(text));
    }
  }
});

test("escapeText: controls, bidirectional and invisible characters are removed; the text is bounded", () => {
  eq(escapeText(`a${NUL}b${BEL}c${ESC}[0m${DEL}d`), "abc[0md");
  eq(escapeText(`evil${RLO}txt.exe${LRI}x${ZWSP}y${BOM}z`), "eviltxt.exexyz");
  eq(escapeText("a\tb"), "a\tb", "a tab is allowed in TEXT");
  eq(escapeText("a\tb", { singleLine: true }), "a b");
  eq(escapeText("x".repeat(5000), { max: 1024 }).length, 1024);
  eq(escapeText(`${"x".repeat(1023)}${SMILE}`, { max: 1024 }), "x".repeat(1023), "never half a character");
  const lone = String.fromCharCode(0xd83d);
  eq(escapeText(`a${lone}b`), `a${ch(0xfffd)}b`, "a lone surrogate is replaced");
  eq(escapeText(";".repeat(1024), { max: 1024 }).length, 2048, "the limit is on the text, before escaping");
});

test("the writer's own cleaning: joiners and every invisible character are removed from what is sent, whatever was cleaned before", () => {
  // The readers of the server's items keep U+200C and U+200D in titles and places; the calendar lets the user
  // type them. Nothing written for other people keeps them, nor any other character nobody sees.
  const hidden = [0xad, 0x34f, 0x61c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0x206a, 0x206f, 0xfeff, 0xfff9, 0xfffb, 0xfffe, 0xffff, 0xe0001, 0xe0041, 0xe007f];
  for (const code of hidden) {
    const hex = code.toString(16);
    const text = `Bud${ch(code)}get`;
    eq(strictText(text), "Budget", `strictText U+${hex}`);
    eq(escapeText(text), "Budget", `escapeText U+${hex}`);
    // Half a character before or after it hides nothing.
    for (const half of [0xd83d, 0xde00, 0xdb40]) {
      const lone = String.fromCharCode(half);
      eq(strictText(`a${lone}${ch(code)}b`), `a${ch(0xfffd)}b`, `half ${half.toString(16)} then U+${hex}`);
      eq(strictText(`a${ch(code)}${lone}b`), `a${ch(0xfffd)}b`, `U+${hex} then half ${half.toString(16)}`);
    }
    // In every text of an invitation, in its names, in the subject and in the text part of its message.
    const ics = itipCalendar({
      method: "REQUEST",
      event: anEvent({ summary: text, location: text, description: `${text}\n${text}`, organizer: { ...ANA, name: `A${ch(code)}na` } }),
      attendees: [{ ...BO, name: `B${ch(code)}o` }],
      stamp: STAMP,
      sequence: 0,
    });
    assert(!ics.includes(ch(code)), `calendar U+${hex}`);
    const e = firstEvent(ics);
    eq([one(e, "SUMMARY").value, one(e, "LOCATION").value, unescapeText(one(e, "DESCRIPTION").value)], ["Budget", "Budget", "Budget\nBudget"], `U+${hex}`);
    eq([one(e, "ORGANIZER").params.get("CN"), one(e, "ATTENDEE").params.get("CN")], ["Ana", "Bo"], `names U+${hex}`);
    const m = message({ subject: `Invitation: ${text}`, text: `${text}\nWhere: ${text}`, from: { ...ANA, name: `A${ch(code)}na` } });
    eq(decodeWords(m.header("Subject")), "Invitation: Budget", `subject U+${hex}`);
    eq(m.parts[0].body, "Budget\r\nWhere: Budget", `text part U+${hex}`);
    eq(readMailboxes(m.header("From"))[0].name, "Ana", `sender U+${hex}`);
    // A UID is never rewritten: with such a character it names another meeting, and the message is refused.
    refused("ITIP_EVENT", () => request({ uid: `meeting${ch(code)}42` }), `uid U+${hex}`);
  }
  // What is visible stays, emoji and letters of every script.
  const kept = `R${E_ACUTE}union ${SMILE} ${ch(0x645)}${ch(0x6cc)} ${ch(0x4f1a)}${ch(0x8b70)}`;
  eq(strictText(kept), kept);
  eq(strictText("a\tb\r\nc"), "a\tb\nc");
  eq(strictText("a\tb\r\nc", { singleLine: true }), "a b c");
  eq(strictText(`${ch(0x200d)}`.repeat(50) + "x".repeat(20), { max: 10 }), "xxxxxxxxxx", "bounded on what is kept");
  for (const none of [null, undefined, 5, {}, ["x"]]) eq(strictText(none), "", String(none));
});

test("foldLine: 75 octets at most, the next lines starting with one space", () => {
  eq(foldLine(""), "");
  eq(foldLine("x".repeat(75)), "x".repeat(75), "75 octets fit");
  eq(foldLine("x".repeat(76)), `${"x".repeat(75)}\r\n x`);
  eq(foldLine("x".repeat(75 + 74)), `${"x".repeat(75)}\r\n ${"x".repeat(74)}`);
  eq(foldLine("x".repeat(75 + 74 + 1)), `${"x".repeat(75)}\r\n ${"x".repeat(74)}\r\n x`);
  const long = foldLine(`DESCRIPTION:${"word ".repeat(2000)}`);
  for (const line of long.split("\r\n")) assert(octets(line) <= 75);
  eq(long.split("\r\n ").join(""), `DESCRIPTION:${"word ".repeat(2000)}`, "unfolding gives the line back, spaces included");
});

test("foldLine: a multi-byte character at the fold goes whole to the next line", () => {
  for (const wide of [E_ACUTE, EURO, SMILE]) {
    const size = octets(wide);
    for (let before = 70; before <= 76; before++) {
      const line = `${"x".repeat(before)}${wide}${"y".repeat(10)}`;
      const folded = foldLine(line);
      const physical = folded.split("\r\n");
      for (const p of physical) {
        assert(octets(p) <= 75, `${before} + ${size}: ${octets(p)} octets`);
        assert(p.isWellFormed(), "a surrogate pair is never cut");
        eq(decodeUtf8(encodeUtf8(p)), p, "each physical line is valid UTF-8 on its own");
      }
      eq(physical.map((p, i) => (i ? p.slice(1) : p)).join(""), line);
      // The character stays on the first line exactly when it fits there.
      eq(physical[0].endsWith(wide) || physical[0].includes(`${wide}y`), before + size <= 75, `${before} + ${size}`);
    }
  }
  const mixed = foldLine(`SUMMARY:${(E_ACUTE + EURO + SMILE + "a").repeat(300)}`).split("\r\n");
  // A line ends when the next character does not fit: at most three octets are left unused.
  for (const p of mixed.slice(0, -1)) assert(octets(p) >= 72 && octets(p) <= 75, `a line of ${octets(p)} octets`);
});

test("foldLine: a control character is refused, CR and LF first of all", () => {
  for (const code of [0x00, 0x01, 0x07, 0x08, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x7f, 0x80, 0x85, 0x9f, 0x2028, 0x2029]) {
    refused("ITIP_ARGUMENT", () => foldLine(`SUMMARY:a${ch(code)}b`), `U+${code.toString(16)}`);
  }
  for (const code of [0x09, 0x20, 0x7e, 0xa0, 0x2027, 0x202a]) eq(foldLine(`SUMMARY:a${ch(code)}b`), `SUMMARY:a${ch(code)}b`, `U+${code.toString(16)} is not a line end`);
  refused("ITIP_ARGUMENT", () => foldLine("SUMMARY:a\r\nATTENDEE:mailto:eve@evil.example"));
  refused("ITIP_ARGUMENT", () => foldLine(`SUMMARY:${String.fromCharCode(0xdc00)}`), "a lone surrogate");
  for (const notLine of [null, undefined, 5, ["x"]]) refused("ITIP_ARGUMENT", () => foldLine(notLine));
  eq(foldLine("SUMMARY:a\tb"), "SUMMARY:a\tb");
});

// ── REQUEST ───────────────────────────────────────────────────────────────

test("REQUEST: the whole event, line by line", () => {
  eq(unfold(request()), [
    "BEGIN:VCALENDAR",
    "PRODID:-//Sync443//Sync443//EN",
    "VERSION:2.0",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:meeting-42@example.org",
    "SEQUENCE:0",
    "DTSTAMP:20261116T080000Z",
    "ORGANIZER;CN=\"Ana Ruiz\":mailto:ana@example.org",
    "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=\"Bo Chen\":mailto:bo@example.org",
    "ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:cy@example.net",
    "ATTENDEE;CUTYPE=RESOURCE;ROLE=NON-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=\"Room 4\":mailto:room4@example.org",
    "DTSTART:20261120T090000Z",
    "DTEND:20261120T100000Z",
    "SUMMARY:Weekly point",
    "LOCATION:Room 4",
    "DESCRIPTION:Agenda:\\n- one\\n- two",
    "TRANSP:OPAQUE",
    "CLASS:PUBLIC",
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
});

test("REQUEST: what RFC 5546 3.2.2 requires is there once; no alarm, no reminder", () => {
  const c = readCalendar(request({ reminder: 30 }, { sequence: 7 }));
  eq(names(c.top), ["PRODID", "VERSION", "METHOD"]);
  eq([one(c.top, "VERSION").value, one(c.top, "METHOD").value], ["2.0", "REQUEST"]);
  eq(c.events.length, 1);
  const e = c.events[0];
  for (const name of ["UID", "SEQUENCE", "DTSTAMP", "ORGANIZER", "DTSTART", "DTEND", "SUMMARY", "TRANSP", "CLASS"]) one(e, name);
  eq(one(e, "SEQUENCE").value, "7");
  eq(all(e, "ATTENDEE").length, 3);
  const ics = request({ reminder: 30 });
  for (const absent of ["VALARM", "TRIGGER", "X-MOZ", "CATEGORIES", "Team"]) assert(!ics.includes(absent), absent);
});

test("REQUEST: empty summary, location and description", () => {
  const e = firstEvent(request({ summary: "", location: "", description: "" }));
  eq(one(e, "SUMMARY").value, "", "SUMMARY is required, even empty");
  eq([all(e, "LOCATION").length, all(e, "DESCRIPTION").length], [0, 0]);
  const blank = firstEvent(request({ summary: ` ${ZWSP}`, location: `${RLO}`, description: `${NUL}${BEL}` }));
  eq([one(blank, "SUMMARY").value, all(blank, "LOCATION").length, all(blank, "DESCRIPTION").length], [" ", 0, 0]);
});

test("REQUEST: availability and privacy", () => {
  const status = (over) => {
    const e = firstEvent(request(over));
    return [one(e, "TRANSP").value, one(e, "CLASS").value];
  };
  eq(status({ busy: "free", privacy: "private" }), ["TRANSPARENT", "PRIVATE"]);
  eq(status({ busy: "tentative", privacy: "confidential" }), ["OPAQUE", "CONFIDENTIAL"]);
  eq(status({ busy: "away" }), ["OPAQUE", "PUBLIC"]);
  for (const over of [{ busy: "BUSY" }, { busy: "busy\r\nATTENDEE:mailto:eve@evil.example" }, { busy: null }, { privacy: "secret" }, { privacy: "__proto__" }, { privacy: undefined }, { busy: "constructor" }]) {
    refused("ITIP_EVENT", () => request(over), JSON.stringify(over));
  }
});

test("hostile summary, location and description cannot add a line, a property or a component", () => {
  const attack = "x\r\nATTENDEE;RSVP=TRUE:mailto:eve@evil.example\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:other";
  for (const field of ["summary", "location", "description"]) {
    const ics = request({ [field]: attack });
    eq(shape(ics), BENIGN_SHAPE, `${field}: same components and properties as a harmless event`);
    const e = firstEvent(ics);
    eq(all(e, "ATTENDEE").map((l) => l.value), ["mailto:bo@example.org", "mailto:cy@example.net", "mailto:room4@example.org"]);
    eq(one(e, "UID").value, "meeting-42@example.org");
    const value = unescapeText(one(e, field.toUpperCase()).value);
    eq(value, field === "description" ? attack.replace(/\r\n/g, "\n") : attack.replace(/\r\n/g, " "));
    assert(!ics.includes("\r\nATTENDEE;RSVP=TRUE:mailto:eve"), "the injected line starts no line");
  }
});

test("hostile summary: separators, quotes, escapes and every line break stay inside the value", () => {
  const cases = [
    "a;b;c", "a,b,c", "a\\b", "a\\", "\\", "\\n", "\\;", "\"quoted\"", ":colon", ";ROLE=CHAIR:mailto:eve@evil.example", "a\nb", "a\rb", `a${LSEP}b`, `a${PSEP}b`,
    "a\\\r\nb", "trailing\\", "\\\\", " leading and trailing ", "=?UTF-8?B?eA==?=", "%0D%0AATTENDEE:mailto:eve@evil.example", "\\r\\n",
  ];
  for (const summary of cases) {
    const ics = request({ summary });
    eq(shape(ics), BENIGN_SHAPE, JSON.stringify(summary));
    eq(unescapeText(one(firstEvent(ics), "SUMMARY").value), summary.replace(/\r\n?|\n/g, " ").replace(LSEP, " ").replace(PSEP, " "), JSON.stringify(summary));
  }
});

test("hostile texts: controls and bidirectional characters never reach the calendar", () => {
  const dirty = `Bud${RLO}get${NUL}${BEL}${ESC}[2J${DEL}${NEL}${ZWSP}${BOM}${LRI} 2026`;
  const ics = request({ summary: dirty, location: dirty, description: `${dirty}\n${dirty}` });
  for (const bad of [RLO, NUL, BEL, ESC, DEL, NEL, ZWSP, BOM, LRI, LSEP, PSEP]) assert(!ics.includes(bad), `U+${bad.codePointAt(0).toString(16)}`);
  const e = firstEvent(ics);
  eq(one(e, "SUMMARY").value, "Budget[2J 2026");
  eq(unescapeText(one(e, "DESCRIPTION").value), "Budget[2J 2026\nBudget[2J 2026");
});

test("very long values are bounded, folded, and read back whole", () => {
  const summary = `${E_ACUTE}${EURO}${SMILE};,\\`.repeat(400); // 2800 UTF-16 units
  const description = `line ${SMILE} ; , \\ \n`.repeat(4000);
  const ics = request({ summary, location: "L".repeat(3000), description });
  const e = firstEvent(ics);
  const cut = (s, max) => (s.length <= max ? s : s.slice(0, s.charCodeAt(max - 1) >= 0xd800 && s.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max));
  eq(unescapeText(one(e, "SUMMARY").value), cut(summary, 1024));
  eq(one(e, "LOCATION").value, "L".repeat(1024));
  eq(unescapeText(one(e, "DESCRIPTION").value), cut(description, 32768));
  assert(ics.split("\r\n").length > 500, "folded into many lines");
});

test("folding inside a calendar: multi-byte characters at every position of the fold", () => {
  for (const wide of [E_ACUTE, EURO, SMILE]) {
    for (let before = 60; before <= 70; before++) {
      const summary = `${"x".repeat(before)}${wide.repeat(40)}`;
      const ics = request({ summary });
      eq(one(firstEvent(ics), "SUMMARY").value, summary); // unfold() has checked every physical line
      eq(decodeUtf8(encodeUtf8(ics)), ics);
    }
  }
});

// ── People ────────────────────────────────────────────────────────────────

test("names: a CN is quoted, without quote, caret, control or line break", () => {
  const cn = (name) => one(firstEvent(request({ organizer: { email: "ana@example.org", name } })), "ORGANIZER");
  eq(cn("Ana Ruiz").params.get("CN"), "Ana Ruiz");
  eq(cn("Ruiz, Ana; (Sales): EMEA").params.get("CN"), "Ruiz, Ana; (Sales): EMEA", "separators are safe between quotes");
  eq(cn("Ana \"The Boss\" Ruiz").params.get("CN"), "Ana The Boss Ruiz");
  eq(cn("\"").params.has("CN"), false, "nothing left: no CN at all");
  eq(cn("").params.has("CN"), false);
  eq(cn("Ana^nRuiz^'^^").params.get("CN"), "AnanRuiz'");
  eq(cn(`Ana${RLO} Ruiz${NUL}${ZWSP}`).params.get("CN"), "Ana Ruiz");
  eq(cn("Ana\r\nATTENDEE:mailto:eve@evil.example").params.get("CN"), "Ana ATTENDEE:mailto:eve@evil.example");
  eq(cn("x".repeat(1000)).params.get("CN").length, 256);
  eq(cn(`R${E_ACUTE}union ${SMILE}`).params.get("CN"), `R${E_ACUTE}union ${SMILE}`);
  for (const notName of [null, undefined, 5, {}, ["Ana"]]) eq(cn(notName).params.has("CN"), false, String(notName));
});

test("hostile names cannot change an address, add a parameter or add an attendee", () => {
  const attacks = [
    "\":mailto:eve@evil.example\r\nATTENDEE:mailto:eve@evil.example", "x\";ROLE=CHAIR;CN=\"y", "x\":mailto:eve@evil.example", "a\"b\"c\"", "\\\"", "x\\",
    `x${LSEP}ATTENDEE:mailto:eve@evil.example`, "\";RSVP=FALSE;X=\"", "name\";PARTSTAT=ACCEPTED;CN=\"x", "\"\"\"", "a\r\n b", "a\n\"b", ";=:,",
  ];
  for (const name of attacks) {
    const people = [{ ...BO, name }, CY];
    const ics = itipCalendar({ method: "REQUEST", event: anEvent({ organizer: { ...ANA, name } }), attendees: people, stamp: STAMP, sequence: 0 });
    const e = firstEvent(ics);
    eq(one(e, "ORGANIZER").value, "mailto:ana@example.org", JSON.stringify(name));
    eq([...one(e, "ORGANIZER").params.keys()].filter((k) => k !== "CN"), []);
    const attendees = all(e, "ATTENDEE");
    eq(attendees.map((l) => l.value), ["mailto:bo@example.org", "mailto:cy@example.net"], JSON.stringify(name));
    eq([attendees[0].params.get("ROLE"), attendees[0].params.get("PARTSTAT"), attendees[0].params.get("RSVP")], ["REQ-PARTICIPANT", "NEEDS-ACTION", "TRUE"]);
    eq([...attendees[0].params.keys()].filter((k) => k !== "CN"), ["ROLE", "PARTSTAT", "RSVP"]);
    assert(!(attendees[0].params.get("CN") ?? "").includes("\""));
  }
});

test("roles: required, optional, resource; an unknown role is a required participant", () => {
  const role = (r) => {
    const line = one(firstEvent(itipCalendar({ method: "REQUEST", event: anEvent(), attendees: [{ ...BO, role: r }], stamp: STAMP, sequence: 0 })), "ATTENDEE");
    return [line.params.get("CUTYPE") ?? null, line.params.get("ROLE")];
  };
  eq(role("required"), [null, "REQ-PARTICIPANT"]);
  eq(role("optional"), [null, "OPT-PARTICIPANT"]);
  eq(role("resource"), ["RESOURCE", "NON-PARTICIPANT"]);
  for (const odd of [undefined, null, "chair", "CHAIR;X=1", "__proto__", 5]) eq(role(odd), [null, "REQ-PARTICIPANT"], String(odd));
});

test("addresses: validated, then written as mailto: URIs", () => {
  const address = (email) => one(firstEvent(itipCalendar({ method: "REQUEST", event: anEvent(), attendees: [{ ...BO, email }], stamp: STAMP, sequence: 0 })), "ATTENDEE").value;
  eq(address("Bo.Chen+cal@Example.ORG"), "mailto:Bo.Chen+cal@Example.ORG");
  eq(address("  bo@example.org "), "mailto:bo@example.org");
  eq(address(`\tbo@example.org\r\n${LSEP}`), "mailto:bo@example.org", "blanks and line breaks around an address are dropped with it validated");
  eq(address("o'neil_x-y~z!$*@example.org"), "mailto:o'neil_x-y~z!$*@example.org");
  // RFC 6068: what a URI would read as a query, a fragment, a path or an escape is percent-encoded.
  eq(address("a?to=eve@example.org"), "mailto:a%3Fto%3Deve@example.org");
  eq(address("a#b%40c&d/e@example.org"), "mailto:a%23b%2540c%26d%2Fe@example.org");
  eq(address("a^b`c{d|e}f@example.org"), "mailto:a%5Eb%60c%7Bd%7Ce%7Df@example.org");
});

const BAD_ADDRESSES = [
  "", " ", "bo", "bo@", "@example.org", "bo@localhost", "bo@example", "bo chen@example.org", "bo@exam ple.org", "bo@example.org, eve@evil.example",
  "bo@example.org;eve@evil.example", "bo@example.org\r\nATTENDEE:mailto:eve@evil.example", "bo@example.org\nBcc: eve@evil.example", "bo\r@example.org",
  "<bo@example.org>", "Bo <bo@example.org>", "mailto:bo@example.org", "bo@example.org:evil", "\"bo\"@example.org", "bo@[192.0.2.1]", "bo@@example.org",
  "bo@example..org", ".bo@example.org", "bo.@example.org", "b..o@example.org", "bo@-example.org", "bo@example-.org", "bo@exa_mple.org",
  `${"a".repeat(65)}@example.org`, `bo@${"a".repeat(64)}.org`, `bo@${"a.".repeat(130)}org`, `b${E_ACUTE}@example.org`, `bo@ex${E_ACUTE}mple.org`,
  `bo${NUL}@example.org`, `bo@example.org${NUL}`, `bo${RLO}@example.org`, `bo@exam${ZWSP}ple.org`, `bo@example.org${LSEP}x`, "bo(comment)@example.org",
  "bo,eve@example.org", "bo:eve@example.org", "bo;eve@example.org", "bo\\@example.org", "bo\"@example.org", null, undefined, 5, {}, ["bo@example.org"],
];

test("an invalid address refuses the message: attendees and organizer", () => {
  for (const email of BAD_ADDRESSES) {
    refused("ITIP_ADDRESS", () => itipCalendar({ method: "REQUEST", event: anEvent(), attendees: [BO, { ...CY, email }], stamp: STAMP, sequence: 0 }), `attendee ${JSON.stringify(email)}`);
    refused("ITIP_ADDRESS", () => cancel({}, { attendees: [{ ...BO, email }] }), `cancelled attendee ${JSON.stringify(email)}`);
    refused("ITIP_ADDRESS", () => reply({}, { attendees: [{ ...ME, email }] }), `replying attendee ${JSON.stringify(email)}`);
    refused("ITIP_ORGANIZER", () => request({ organizer: { name: "Ana", email } }), `organizer ${JSON.stringify(email)}`);
    refused("ITIP_ORGANIZER", () => reply({ organizer: { name: "Ana", email } }), `organizer of a reply ${JSON.stringify(email)}`);
  }
});

test("no organizer, no message", () => {
  for (const organizer of [null, undefined, "ana@example.org", ["ana@example.org"], {}, { name: "Ana" }, 5]) {
    for (const make of [request, cancel, reply]) refused("ITIP_ORGANIZER", () => make({ organizer }), JSON.stringify(organizer));
  }
});

test("at most MAX_MEETING_RECIPIENTS attendees, and at least one", () => {
  eq(MAX_MEETING_RECIPIENTS, 100);
  const crowd = (n) => Array.from({ length: n }, (_, i) => ({ email: `guest${i}@example.org`, name: `Guest ${i}`, role: "required" }));
  for (const method of ["REQUEST", "CANCEL"]) {
    const args = { method, event: anEvent(), stamp: STAMP, sequence: 1 };
    eq(all(firstEvent(itipCalendar({ ...args, attendees: crowd(100) })), "ATTENDEE").length, 100);
    refused("ITIP_RECIPIENTS", () => itipCalendar({ ...args, attendees: crowd(101) }), `${method}: 101`);
    refused("ITIP_RECIPIENTS", () => itipCalendar({ ...args, attendees: crowd(5000) }), `${method}: 5000`);
    for (const none of [[], null, undefined, "bo@example.org", { 0: BO, length: 1 }, [null], ["bo@example.org"], [[BO]]]) {
      refused("ITIP_RECIPIENTS", () => itipCalendar({ ...args, attendees: none }), `${method}: ${JSON.stringify(none)}`);
    }
  }
  // The attendees of one occurrence are bounded the same way.
  const exception = (n) => ({ originalStart: "2026-11-27T09:00:00Z", deleted: false, changes: { attendees: crowd(n) } });
  eq(readCalendar(request({ recurrence: weekly(), exceptions: [exception(100)] })).events.map((e) => all(e, "ATTENDEE").length), [3, 100]);
  refused("ITIP_RECIPIENTS", () => request({ recurrence: weekly(), exceptions: [exception(101)] }));
});

// ── Dates and time zones ──────────────────────────────────────────────────

test("all-day events: dates without time, zone or VTIMEZONE", () => {
  for (const timezone of [null, PARIS, UTC_ZONE]) {
    const c = readCalendar(request({ allDay: true, start: "2026-11-20", end: "2026-11-23", timezone }));
    const e = c.events[0];
    eq([one(e, "DTSTART").value, [...one(e, "DTSTART").params], one(e, "DTEND").value, [...one(e, "DTEND").params]], ["20261120", [["VALUE", "DATE"]], "20261123", [["VALUE", "DATE"]]]);
    eq(c.zone, []);
  }
  const oneDay = firstEvent(request({ allDay: true, start: "2026-11-20", end: "2026-11-20" }));
  eq([one(oneDay, "DTSTART").value, all(oneDay, "DTEND").length], ["20261120", 0], "no DTEND equal to DTSTART");
  eq(one(firstEvent(request({ allDay: true, start: "2024-02-29", end: "2024-03-01" })), "DTEND").value, "20240301");
});

test("times without a zone, or in UTC itself, are written in UTC", () => {
  for (const timezone of [null, undefined, UTC_ZONE, { bias: 0, standard: { bias: 0, change: null }, daylight: { bias: -60, change: null } }]) {
    const c = readCalendar(request({ timezone }));
    eq([one(c.events[0], "DTSTART").value, one(c.events[0], "DTSTART").params.size, one(c.events[0], "DTEND").value], ["20261120T090000Z", 0, "20261120T100000Z"]);
    eq(c.zone, []);
  }
  const instant = firstEvent(request({ start: "2026-11-20T09:00:00Z", end: "2026-11-20T09:00:00Z" }));
  eq([one(instant, "DTSTART").value, all(instant, "DTEND").length], ["20261120T090000Z", 0]);
});

test("a time zone: local times with a TZID of ours and its VTIMEZONE", () => {
  const ics = request({ timezone: PARIS });
  eq(unfold(ics).slice(4, 18), [
    "BEGIN:VTIMEZONE",
    `TZID:${PARIS_TZID}`,
    "BEGIN:STANDARD",
    "DTSTART:16011028T030000",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "BEGIN:DAYLIGHT",
    "DTSTART:16010325T020000",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
  ]);
  const c = readCalendar(ics);
  eq(names(c.top), ["PRODID", "VERSION", "METHOD"]);
  const e = c.events[0];
  eq([one(e, "DTSTART").params.get("TZID"), one(e, "DTSTART").value], [PARIS_TZID, "20261120T100000"], "winter: UTC+1");
  eq([one(e, "DTEND").params.get("TZID"), one(e, "DTEND").value], [PARIS_TZID, "20261120T110000"]);
  eq(one(e, "DTSTAMP").value, "20261116T080000Z", "the stamp stays in UTC");
  const summer = firstEvent(request({ timezone: PARIS, start: "2026-07-01T08:00:00Z", end: "2026-07-01T22:30:00Z" }));
  eq([one(summer, "DTSTART").value, one(summer, "DTEND").value], ["20260701T100000", "20260702T003000"], "summer: UTC+2");
});

test("time zones: the name and the rules come from the numbers of the zone", () => {
  const zoneOf = (timezone) => {
    const c = readCalendar(request({ timezone }));
    return [one(c.zone, "TZID").value, all(c.zone, "DTSTART").map((l) => l.value), all(c.zone, "RRULE").map((l) => l.value), all(c.zone, "TZOFFSETTO").map((l) => l.value)];
  };
  eq(zoneOf(PACIFIC), [
    "Sync443/UTC-0800/DST-0700/M3.2.0.0200/M11.1.0.0200",
    ["16011104T020000", "16010311T020000"],
    ["RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU"].map((r) => r.slice(6)),
    ["-0800", "-0700"],
  ]);
  eq(zoneOf(SYDNEY)[0], "Sync443/UTC+1000/DST+1100/M10.1.0.0200/M4.1.0.0300");
  eq(zoneOf(KOLKATA), ["Sync443/UTC+0530", ["16010101T000000"], [], ["+0530"]]);
  eq(zoneOf({ bias: 210, standard: { bias: 0, change: null }, daylight: { bias: 0, change: null } })[0], "Sync443/UTC-0330");
  // Odd rules: a change on a Wednesday at 23:45, the fourth week; the same offset on both sides is a fixed zone.
  const odd = { bias: -45, standard: { bias: 15, change: { month: 2, week: 4, weekday: 3, hour: 23, minute: 45 } }, daylight: { bias: -30, change: { month: 9, week: 1, weekday: 6, hour: 0, minute: 5 } } };
  eq(zoneOf(odd), ["Sync443/UTC+0030/DST+0115/M9.1.6.0005/M2.4.3.2345", ["16010228T234500", "16010901T000500"], ["FREQ=YEARLY;BYMONTH=2;BYDAY=4WE", "FREQ=YEARLY;BYMONTH=9;BYDAY=1SA"], ["+0030", "+0115"]]);
  eq(zoneOf({ ...PARIS, daylight: { bias: 0, change: PARIS.daylight.change } }), ["Sync443/UTC+0100", ["16010101T000000"], [], ["+0100"]]);
  // A name that came with a zone has no way in: only the numbers are read.
  const named = { ...PARIS, name: "Evil\r\nATTENDEE:mailto:eve@evil.example", standardName: "x", tzid: "y" };
  eq(request({ timezone: named }), request({ timezone: PARIS }));
});

test("an invalid time zone refuses the message", () => {
  const bad = [
    "Europe/Paris", 5, [], {}, { bias: -60 }, { ...PARIS, bias: "-60" }, { ...PARIS, bias: 841 }, { ...PARIS, bias: 1.5 },
    { ...PARIS, standard: { bias: 0, change: null } }, { ...PARIS, daylight: { bias: -60, change: { ...PARIS.daylight.change, month: 13 } } },
    { ...PARIS, standard: { bias: 0, change: { ...PARIS.standard.change, week: 0 } } }, { ...PARIS, standard: { bias: 0, change: { ...PARIS.standard.change, hour: "3\r\nX:1" } } },
  ];
  for (const timezone of bad) refused("ITIP_EVENT", () => request({ timezone }), JSON.stringify(timezone).slice(0, 60));
});

/** Reads a VTIMEZONE the way RFC 5545 3.6.5 defines it, without the module: local time → instant, the first when an hour happens twice. */
function zoneReader(zoneLines) {
  const minutes = (text) => (text[0] === "-" ? -1 : 1) * (Number(text.slice(1, 3)) * 60 + Number(text.slice(3, 5)));
  const observances = [];
  for (const line of zoneLines) {
    if (line.name === "BEGIN" && line.value !== "VTIMEZONE") observances.push({});
    const o = observances[observances.length - 1];
    if (line.name === "TZOFFSETFROM") o.from = minutes(line.value);
    if (line.name === "TZOFFSETTO") o.to = minutes(line.value);
    if (line.name === "DTSTART") Object.assign(o, { hour: Number(line.value.slice(9, 11)), minute: Number(line.value.slice(11, 13)) });
    if (line.name === "RRULE") {
      const m = /^FREQ=YEARLY;BYMONTH=(\d+);BYDAY=(-?\d)(SU|MO|TU|WE|TH|FR|SA)$/.exec(line.value);
      assert(m, `zone rule ${line.value}`);
      Object.assign(o, { month: Number(m[1]), nth: Number(m[2]), weekday: ["SU", "MO", "TU", "WE", "TH", "FR", "SA"].indexOf(m[3]) });
    }
  }
  const onset = (o, year) => {
    const days = new Date(Date.UTC(year, o.month, 0)).getUTCDate();
    const matching = [];
    for (let day = 1; day <= days; day++) if (new Date(Date.UTC(year, o.month - 1, day)).getUTCDay() === o.weekday) matching.push(day);
    const day = o.nth < 0 ? matching[matching.length + o.nth] : matching[o.nth - 1];
    return Date.UTC(year, o.month - 1, day, o.hour, o.minute) - o.from * 60_000;
  };
  const offsetAt = (utc) => {
    const ruled = observances.filter((o) => o.month);
    if (!ruled.length) return observances[0].to;
    const year = new Date(utc).getUTCFullYear();
    let best = null;
    for (let y = year - 1; y <= year + 1; y++) for (const o of ruled) {
      const at = onset(o, y);
      if (at <= utc && (best === null || at > best.at)) best = { at, to: o.to };
    }
    return best.to;
  };
  const transitions = (year) => observances.filter((o) => o.month).map((o) => onset(o, year));
  /** "YYYYMMDDTHHMMSS" in the zone → the instant, or null for a time that does not exist. */
  const resolve = (local) => {
    const wall = Date.UTC(Number(local.slice(0, 4)), Number(local.slice(4, 6)) - 1, Number(local.slice(6, 8)), Number(local.slice(9, 11)), Number(local.slice(11, 13)), Number(local.slice(13, 15)));
    const candidates = [...new Set(observances.map((o) => o.to))].map((offset) => wall - offset * 60_000).filter((utc) => wall - utc === offsetAt(utc) * 60_000);
    return candidates.length ? Math.min(...candidates) : null;
  };
  return { resolve, offsetAt, transitions };
}

const utcText = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

test("time zones: a reader of the VTIMEZONE gets back the instant of every time written", () => {
  for (const [label, timezone] of [["Paris", PARIS], ["Pacific", PACIFIC], ["Sydney", SYDNEY], ["Kolkata", KOLKATA], ["Dublin", DUBLIN]]) {
    const reader = zoneReader(readCalendar(request({ timezone })).zone);
    const instants = [];
    for (let at = Date.UTC(2026, 0, 1); at < Date.UTC(2027, 0, 1); at += 7 * 3_600_000 + 13 * 60_000) instants.push(at);
    for (const change of reader.transitions(2026)) for (let at = change - 4 * 3_600_000; at <= change + 4 * 3_600_000; at += 15 * 60_000) instants.push(at);
    let inUtc = 0;
    for (const at of instants) {
      eq(reader.offsetAt(at), offsetMinutesAt(timezone, at), `${label}: the VTIMEZONE and the zone agree at ${utcText(at)}`);
      const e = firstEvent(request({ timezone, start: utcText(at), end: utcText(at + 3_600_000) }));
      const start = one(e, "DTSTART");
      if (start.params.has("TZID")) {
        eq(reader.resolve(start.value), at, `${label}: ${start.value} is ${utcText(at)}`);
      } else {
        // Only the second pass of the hour that happens twice is written in UTC: its local time means the first pass.
        eq(start.value, `${utcText(at).replace(/[-:]/g, "")}`);
        const local = new Date(at + offsetMinutesAt(timezone, at) * 60_000).toISOString().replace(/[-:]/g, "").slice(0, 15);
        eq(reader.resolve(local), at - 3_600_000, `${label}: ${local} happens twice`);
        inUtc++;
      }
    }
    eq(inUtc, timezone.standard.change ? 4 : 0, `${label}: the four quarter-hours of the second pass`);
  }
});

// ── Recurrence and exceptions ─────────────────────────────────────────────

test("recurrence: the rule of each kind of series", () => {
  const rule = (recurrence, over = {}) => one(firstEvent(request({ recurrence, ...over })), "RRULE").value;
  eq(rule(weekly()), "FREQ=WEEKLY;BYDAY=FR");
  eq(rule(weekly({ interval: 2, count: 10, byDay: ["MO", "WE", "FR"], weekStart: "MO" })), "FREQ=WEEKLY;COUNT=10;INTERVAL=2;BYDAY=MO,WE,FR;WKST=MO");
  eq(rule({ freq: "daily", interval: 3 }), "FREQ=DAILY;INTERVAL=3");
  eq(rule({ freq: "daily" }), "FREQ=DAILY", "an absent interval is 1");
  eq(rule(weekly({ until: "2027-03-26T09:00:00Z" })), "FREQ=WEEKLY;UNTIL=20270326T090000Z;BYDAY=FR");
  eq(rule(weekly({ until: "2027-03-26" })), "FREQ=WEEKLY;UNTIL=20270326T235959Z;BYDAY=FR", "a time is needed: the end of that day");
  eq(rule(weekly({ until: "2027-03-26T09:00:00Z" }), { timezone: PARIS }), "FREQ=WEEKLY;UNTIL=20270326T090000Z;BYDAY=FR", "UNTIL stays in UTC with a zone");
  eq(rule(weekly({ until: "2027-03-26" }), { allDay: true, start: "2026-11-20", end: "2026-11-21" }), "FREQ=WEEKLY;UNTIL=20270326;BYDAY=FR", "a date for an all-day series");
  eq(rule(weekly({ until: "2027-03-26T23:00:00Z" }), { allDay: true, start: "2026-11-20", end: "2026-11-21" }), "FREQ=WEEKLY;UNTIL=20270326;BYDAY=FR");
  eq(rule({ freq: "monthly", interval: 1, byMonthDay: 20 }), "FREQ=MONTHLY;BYMONTHDAY=20");
  eq(rule({ freq: "monthly", interval: 1, byDay: ["FR"], bySetPos: 3 }), "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3");
  eq(rule({ freq: "monthly", interval: 2, byDay: ["MO", "TU", "WE", "TH", "FR"], bySetPos: -1 }), "FREQ=MONTHLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1");
  eq(rule({ freq: "yearly", interval: 1, byMonthDay: 20, byMonth: 11 }), "FREQ=YEARLY;BYMONTHDAY=20;BYMONTH=11");
  eq(rule({ freq: "yearly", interval: 1, byDay: ["SU"], bySetPos: -1, byMonth: 10, count: 999 }), "FREQ=YEARLY;COUNT=999;BYDAY=SU;BYMONTH=10;BYSETPOS=-1");
  eq(all(firstEvent(request()), "RRULE").length, 0, "no rule without a recurrence");
});

test("recurrence: nothing but checked values can be written in a rule", () => {
  const bad = [
    "FREQ=DAILY", [], 5, {}, { freq: "DAILY" }, { freq: "daily;X-EVIL=1" }, { freq: "daily\r\nATTENDEE:mailto:eve@evil.example" }, { freq: "hourly" }, { freq: "__proto__" },
    weekly({ interval: 0 }), weekly({ interval: 1000 }), weekly({ interval: "2" }), weekly({ interval: 1.5 }), weekly({ interval: "2;COUNT=1" }),
    weekly({ count: 0 }), weekly({ count: 1000 }), weekly({ count: "5" }), weekly({ count: 5, until: "2027-01-01T00:00:00Z" }),
    weekly({ until: "20270101T000000Z" }), weekly({ until: "2027-02-30" }), weekly({ until: "2027-01-01T00:00:00Z;BYDAY=MO" }), weekly({ until: 5 }),
    weekly({ byDay: "FR" }), weekly({ byDay: ["fr"] }), weekly({ byDay: ["FRI"] }), weekly({ byDay: ["FR", "FR"] }), weekly({ byDay: ["MO,TU"] }),
    weekly({ byDay: ["MO\r\nATTENDEE:mailto:eve@evil.example"] }), weekly({ byDay: ["SU", "MO", "TU", "WE", "TH", "FR", "SA", "SU"] }), weekly({ byDay: [1] }), weekly({ byDay: ["1FR"] }),
    weekly({ byMonthDay: 0 }), weekly({ byMonthDay: 32 }), weekly({ byMonthDay: "20" }), weekly({ byMonthDay: -1 }),
    weekly({ byMonth: 0 }), weekly({ byMonth: 13 }), weekly({ byMonth: "11" }),
    weekly({ bySetPos: 0 }), weekly({ bySetPos: 5 }), weekly({ bySetPos: -2 }), weekly({ bySetPos: "1" }), weekly({ byDay: [], bySetPos: 1 }),
    weekly({ weekStart: "mo" }), weekly({ weekStart: "MO;X=1" }), weekly({ weekStart: 1 }),
  ];
  for (const recurrence of bad) refused("ITIP_EVENT", () => request({ recurrence }), JSON.stringify(recurrence).slice(0, 70));
});

test("a series with exceptions: EXDATE for deleted occurrences, a VEVENT for each changed one", () => {
  const exceptions = [
    { originalStart: "2026-11-27T09:00:00Z", deleted: true, changes: {} },
    { originalStart: "2026-12-04T09:00:00Z", deleted: false, changes: { start: "2026-12-04T14:00:00Z", end: "2026-12-04T15:30:00Z", summary: "Moved; later", location: "Room 9", busy: "free", privacy: "private" } },
    { originalStart: "2026-12-11T09:00:00Z", deleted: false, changes: { description: "Only the notes change" } },
    { originalStart: "2026-12-18T09:00:00Z", deleted: true },
    { originalStart: "2026-12-25T09:00:00Z", deleted: false, changes: { cancelled: true } },
  ];
  const c = readCalendar(request({ recurrence: weekly(), exceptions }, { sequence: 3 }));
  eq(c.events.length, 4);
  const [series, moved, notes, cancelled] = c.events;
  eq(names(series), ["UID", "SEQUENCE", "DTSTAMP", "ORGANIZER", "ATTENDEE", "ATTENDEE", "ATTENDEE", "DTSTART", "DTEND", "RRULE", "EXDATE", "EXDATE", "SUMMARY", "LOCATION", "DESCRIPTION", "TRANSP", "CLASS"]);
  eq(all(series, "EXDATE").map((l) => l.value), ["20261127T090000Z", "20261218T090000Z"]);
  eq(all(series, "RECURRENCE-ID").length, 0);
  for (const e of c.events) {
    eq([one(e, "UID").value, one(e, "SEQUENCE").value, one(e, "DTSTAMP").value, one(e, "ORGANIZER").value], ["meeting-42@example.org", "3", "20261116T080000Z", "mailto:ana@example.org"], "one meeting");
    eq(all(e, "ATTENDEE").length, 3);
  }
  eq(names(moved), ["UID", "SEQUENCE", "DTSTAMP", "ORGANIZER", "ATTENDEE", "ATTENDEE", "ATTENDEE", "RECURRENCE-ID", "DTSTART", "DTEND", "SUMMARY", "LOCATION", "DESCRIPTION", "TRANSP", "CLASS"]);
  eq(
    [one(moved, "RECURRENCE-ID").value, one(moved, "DTSTART").value, one(moved, "DTEND").value, one(moved, "SUMMARY").value, one(moved, "LOCATION").value, one(moved, "TRANSP").value, one(moved, "CLASS").value],
    ["20261204T090000Z", "20261204T140000Z", "20261204T153000Z", "Moved\\; later", "Room 9", "TRANSPARENT", "PRIVATE"],
  );
  eq(one(moved, "DESCRIPTION").value, "Agenda:\\n- one\\n- two", "what the occurrence does not change comes from the series");
  eq(
    [one(notes, "RECURRENCE-ID").value, one(notes, "DTSTART").value, one(notes, "DTEND").value, one(notes, "SUMMARY").value, one(notes, "DESCRIPTION").value],
    ["20261211T090000Z", "20261211T090000Z", "20261211T100000Z", "Weekly point", "Only the notes change"],
  );
  eq([one(cancelled, "RECURRENCE-ID").value, one(cancelled, "STATUS").value], ["20261225T090000Z", "CANCELLED"]);
  eq(all(moved, "STATUS").length + all(notes, "STATUS").length + all(series, "STATUS").length, 0);
  for (const e of [moved, notes, cancelled]) eq(all(e, "RRULE").length + all(e, "EXDATE").length, 0);
});

test("a series in a time zone: local times everywhere, the rule follows the zone", () => {
  const exceptions = [
    { originalStart: "2027-03-26T09:00:00Z", deleted: true, changes: {} },
    { originalStart: "2027-04-02T08:00:00Z", deleted: false, changes: { start: "2027-04-02T12:00:00Z", end: "2027-04-02T13:00:00Z" } },
  ];
  const c = readCalendar(request({ timezone: PARIS, recurrence: weekly(), exceptions }));
  const [series, moved] = c.events;
  eq([one(series, "DTSTART").params.get("TZID"), one(series, "DTSTART").value], [PARIS_TZID, "20261120T100000"]);
  eq([one(series, "EXDATE").params.get("TZID"), one(series, "EXDATE").value], [PARIS_TZID, "20270326T100000"], "10:00 in winter");
  eq([one(moved, "RECURRENCE-ID").params.get("TZID"), one(moved, "RECURRENCE-ID").value], [PARIS_TZID, "20270402T100000"], "10:00 in summer: 08:00 UTC");
  eq([one(moved, "DTSTART").value, one(moved, "DTEND").value], ["20270402T140000", "20270402T150000"]);
  eq(all(c.zone, "TZID").length, 1, "one VTIMEZONE");
});

test("an all-day series: dates for the occurrences too", () => {
  const exceptions = [
    { originalStart: "2026-11-27", deleted: true, changes: {} },
    { originalStart: "2026-12-04", deleted: false, changes: { start: "2026-12-05", end: "2026-12-07" } },
    { originalStart: "2026-12-11", deleted: false, changes: { summary: "Same day" } },
    { originalStart: "2026-12-18", deleted: false, changes: { allDay: false, start: "2026-12-18T09:00:00Z", end: "2026-12-18T10:00:00Z" } },
  ];
  const c = readCalendar(request({ allDay: true, start: "2026-11-20", end: "2026-11-21", timezone: PARIS, recurrence: weekly(), exceptions }));
  const [series, moved, same, timed] = c.events;
  eq([one(series, "EXDATE").value, one(series, "EXDATE").params.get("VALUE")], ["20261127", "DATE"]);
  eq([one(moved, "RECURRENCE-ID").value, one(moved, "RECURRENCE-ID").params.get("VALUE"), one(moved, "DTSTART").value, one(moved, "DTEND").value], ["20261204", "DATE", "20261205", "20261207"]);
  eq([one(same, "DTSTART").value, one(same, "DTEND").value], ["20261211", "20261212"], "the length of the series");
  eq([one(timed, "RECURRENCE-ID").value, one(timed, "DTSTART").value, one(timed, "DTEND").value], ["20261218", "20261218T090000Z", "20261218T100000Z"]);
  eq(c.zone, []);
});

test("an occurrence with its own attendees lists them", () => {
  const dana = { email: "dana@example.org", name: "Dana", role: "optional" };
  const exceptions = [
    { originalStart: "2026-11-27T09:00:00Z", deleted: false, changes: { attendees: [BO, dana] } },
    { originalStart: "2026-12-04T09:00:00Z", deleted: false, changes: { attendees: [] } },
  ];
  const [series, own, shared] = readCalendar(request({ recurrence: weekly(), exceptions })).events;
  eq(all(series, "ATTENDEE").map((l) => l.value), ["mailto:bo@example.org", "mailto:cy@example.net", "mailto:room4@example.org"]);
  eq(all(own, "ATTENDEE").map((l) => [l.value, l.params.get("ROLE"), l.params.get("PARTSTAT")]), [["mailto:bo@example.org", "REQ-PARTICIPANT", "NEEDS-ACTION"], ["mailto:dana@example.org", "OPT-PARTICIPANT", "NEEDS-ACTION"]]);
  eq(all(shared, "ATTENDEE").length, 3, "an empty list changes nothing: a REQUEST names at least one attendee");
  refused("ITIP_ADDRESS", () => request({ recurrence: weekly(), exceptions: [{ originalStart: "2026-11-27T09:00:00Z", deleted: false, changes: { attendees: [{ email: "dana@example.org\r\nATTENDEE:mailto:eve@evil.example" }] } }] }));
});

test("exceptions without a recurrence are not written; invalid ones refuse the message", () => {
  const exception = { originalStart: "2026-11-27T09:00:00Z", deleted: true, changes: {} };
  eq(shape(request({ exceptions: [exception] })), BENIGN_SHAPE);
  const bad = [
    "x", {}, [null], ["2026-11-27T09:00:00Z"], [{ deleted: true }], [{ ...exception, originalStart: "2026-11-27" }], [{ ...exception, originalStart: "20261127T090000Z" }],
    [{ ...exception, originalStart: "2026-11-27T09:00:00Z\r\nATTENDEE:mailto:eve@evil.example" }], [{ ...exception, deleted: "no" }], [{ ...exception, deleted: undefined }],
    [exception, { ...exception }], [{ ...exception, changes: "x" }], [{ ...exception, changes: [] }],
    Array.from({ length: 257 }, (_, i) => ({ originalStart: utcText(Date.UTC(2027, 0, 1 + i, 9)), deleted: true, changes: {} })),
  ];
  for (const exceptions of bad) refused("ITIP_EVENT", () => request({ recurrence: weekly(), exceptions }), JSON.stringify(exceptions).slice(0, 70));
  const changed = (changes) => [{ originalStart: "2026-11-27T09:00:00Z", deleted: false, changes }];
  const badChanges = [
    { start: "2026-11-27" }, { start: "tomorrow" }, { end: "2026-11-27T08:00:00Z" }, { start: "2026-11-27T11:00:00Z", end: "2026-11-27T10:00:00Z" }, { allDay: true },
    { allDay: true, start: "2026-11-27" }, { allDay: "yes" }, { busy: "BUSY\r\nX:1" }, { privacy: "secret" }, { start: "2026-11-27T09:00:00Z\r\nX:1" },
  ];
  for (const changes of badChanges) refused("ITIP_EVENT", () => request({ recurrence: weekly(), exceptions: changed(changes) }), JSON.stringify(changes));
  eq(readCalendar(request({ recurrence: weekly(), exceptions: Array.from({ length: 256 }, (_, i) => ({ originalStart: utcText(Date.UTC(2027, 0, 1 + i, 9)), deleted: true, changes: {} })) })).events.length, 1, "256 are accepted");
});

test("REQUEST for one occurrence: that occurrence alone, with its RECURRENCE-ID", () => {
  const exceptions = [
    { originalStart: "2026-12-04T09:00:00Z", deleted: false, changes: { start: "2026-12-04T14:00:00Z", end: "2026-12-04T15:00:00Z", summary: "Moved" } },
    { originalStart: "2026-12-11T09:00:00Z", deleted: true, changes: {} },
  ];
  const changed = readCalendar(request({ recurrence: weekly(), exceptions }, { occurrence: "2026-12-04T09:00:00Z" }));
  eq(changed.events.length, 1);
  const e = changed.events[0];
  eq([one(e, "RECURRENCE-ID").value, one(e, "DTSTART").value, one(e, "SUMMARY").value, all(e, "RRULE").length, all(e, "EXDATE").length], ["20261204T090000Z", "20261204T140000Z", "Moved", 0, 0]);
  const plain = firstEvent(request({ recurrence: weekly(), exceptions }, { occurrence: "2026-12-18T09:00:00Z" }));
  eq([one(plain, "RECURRENCE-ID").value, one(plain, "DTSTART").value, one(plain, "DTEND").value, one(plain, "SUMMARY").value], ["20261218T090000Z", "20261218T090000Z", "20261218T100000Z", "Weekly point"]);
  refused("ITIP_ARGUMENT", () => request({ recurrence: weekly(), exceptions }, { occurrence: "2026-12-11T09:00:00Z" }), "a deleted occurrence is cancelled, not requested");
  for (const occurrence of ["2026-12-04", "20261204T090000Z", "x", 5, {}, "2026-12-04T09:00:00Z\r\nX:1"]) {
    refused("ITIP_ARGUMENT", () => request({ recurrence: weekly(), exceptions }, { occurrence }), JSON.stringify(occurrence));
  }
});

// ── CANCEL ────────────────────────────────────────────────────────────────

test("CANCEL: the meeting is named, cancelled for everyone listed, and nothing else is said", () => {
  eq(unfold(cancel({ description: "secret notes", location: "Room 4" })), [
    "BEGIN:VCALENDAR",
    "PRODID:-//Sync443//Sync443//EN",
    "VERSION:2.0",
    "METHOD:CANCEL",
    "BEGIN:VEVENT",
    "UID:meeting-42@example.org",
    "SEQUENCE:1",
    "DTSTAMP:20261116T080000Z",
    "ORGANIZER;CN=\"Ana Ruiz\":mailto:ana@example.org",
    "ATTENDEE;CN=\"Bo Chen\":mailto:bo@example.org",
    "ATTENDEE:mailto:cy@example.net",
    "ATTENDEE;CN=\"Room 4\":mailto:room4@example.org",
    "DTSTART:20261120T090000Z",
    "SUMMARY:Weekly point",
    "STATUS:CANCELLED",
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
});

test("CANCEL: a series as a whole, or one occurrence", () => {
  const exceptions = [{ originalStart: "2026-12-04T09:00:00Z", deleted: false, changes: { start: "2026-12-04T14:00:00Z", end: "2026-12-04T15:00:00Z" } }];
  const series = readCalendar(cancel({ timezone: PARIS, recurrence: weekly(), exceptions }));
  eq(series.events.length, 1, "one VEVENT cancels the series and its exceptions");
  eq([one(series.events[0], "DTSTART").value, all(series.events[0], "RECURRENCE-ID").length, all(series.events[0], "RRULE").length, one(series.events[0], "STATUS").value], ["20261120T100000", 0, 0, "CANCELLED"]);
  eq(all(series.zone, "TZID").length, 1, "the zone of DTSTART is defined");
  const occurrence = firstEvent(cancel({ recurrence: weekly(), exceptions }, { occurrence: "2026-11-27T09:00:00Z" }));
  eq([one(occurrence, "RECURRENCE-ID").value, one(occurrence, "DTSTART").value, one(occurrence, "STATUS").value], ["20261127T090000Z", "20261127T090000Z", "CANCELLED"]);
  const moved = firstEvent(cancel({ recurrence: weekly(), exceptions }, { occurrence: "2026-12-04T09:00:00Z" }));
  eq([one(moved, "RECURRENCE-ID").value, one(moved, "DTSTART").value], ["20261204T090000Z", "20261204T140000Z"], "where the occurrence had been moved");
  const allDay = firstEvent(cancel({ allDay: true, start: "2026-11-20", end: "2026-11-21", recurrence: weekly() }, { occurrence: "2026-11-27" }));
  eq([one(allDay, "RECURRENCE-ID").value, one(allDay, "RECURRENCE-ID").params.get("VALUE"), one(allDay, "DTSTART").value], ["20261127", "DATE", "20261127"]);
});

test("CANCEL to attendees removed from a meeting that goes on: no STATUS (RFC 5546 3.2.5)", () => {
  const dana = { email: "Dana@Example.org", name: "Dana", role: "required" };
  const removed = firstEvent(cancel({ attendees: [BO, CY] }, { attendees: [dana] }));
  eq([all(removed, "STATUS").length, all(removed, "ATTENDEE").map((l) => l.value)], [0, ["mailto:Dana@Example.org"]]);
  // Still an attendee (addresses compared without case): the event itself is cancelled.
  eq(one(firstEvent(cancel({ attendees: [BO, { ...dana, email: "dana@example.org" }] }, { attendees: [dana] })), "STATUS").value, "CANCELLED");
  eq(one(firstEvent(cancel({ attendees: [BO, CY] }, { attendees: [BO, dana] })), "STATUS").value, "CANCELLED");
  eq(all(firstEvent(cancel({ attendees: [] }, { attendees: [BO] })), "STATUS").length, 0);
  eq(all(firstEvent(cancel({ attendees: null }, { attendees: [BO] })), "STATUS").length, 0);
});

// ── REPLY ─────────────────────────────────────────────────────────────────

test("REPLY: the user's answer, to the organizer's meeting", () => {
  eq(unfold(reply({ organizer: { email: "orga@example.net", name: "Olga, the organizer" }, description: "not sent back", location: "nor this" }, { sequence: 4 })), [
    "BEGIN:VCALENDAR",
    "PRODID:-//Sync443//Sync443//EN",
    "VERSION:2.0",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    "UID:meeting-42@example.org",
    "SEQUENCE:4",
    "DTSTAMP:20261116T080000Z",
    "ORGANIZER;CN=\"Olga, the organizer\":mailto:orga@example.net",
    "ATTENDEE;PARTSTAT=ACCEPTED;CN=\"Me Myself\":mailto:me@example.com",
    "DTSTART:20261120T090000Z",
    "SUMMARY:Weekly point",
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
  const status = (replyStatus) => one(firstEvent(reply({}, { replyStatus })), "ATTENDEE").params.get("PARTSTAT");
  eq(["accepted", "tentative", "declined"].map(status), ["ACCEPTED", "TENTATIVE", "DECLINED"]);
});

test("REPLY: exactly one attendee and a known answer", () => {
  for (const replyStatus of [null, undefined, "", "ACCEPTED", "accept", "none", "not-responded", "delegated", "accepted;RSVP=TRUE", "accepted\r\nX:1", 1, true, "__proto__"]) {
    refused("ITIP_ARGUMENT", () => reply({}, { replyStatus }), JSON.stringify(replyStatus));
  }
  refused("ITIP_RECIPIENTS", () => reply({}, { attendees: [ME, BO] }), "a reply speaks for one person");
  refused("ITIP_RECIPIENTS", () => reply({}, { attendees: [] }));
  // An answer has no meaning in the other messages.
  refused("ITIP_ARGUMENT", () => request({}, { replyStatus: "accepted" }));
  refused("ITIP_ARGUMENT", () => cancel({}, { replyStatus: "declined" }));
});

test("REPLY for one occurrence: RECURRENCE-ID, in the type and zone of the series", () => {
  const exceptions = [{ originalStart: "2026-12-04T09:00:00Z", deleted: false, changes: { start: "2026-12-04T14:00:00Z", end: "2026-12-04T15:00:00Z" } }];
  const e = firstEvent(reply({ recurrence: weekly(), exceptions }, { occurrence: "2026-11-27T09:00:00Z", replyStatus: "declined" }));
  eq(names(e), ["UID", "SEQUENCE", "DTSTAMP", "ORGANIZER", "ATTENDEE", "RECURRENCE-ID", "DTSTART", "SUMMARY"]);
  eq([one(e, "RECURRENCE-ID").value, one(e, "DTSTART").value, one(e, "ATTENDEE").params.get("PARTSTAT")], ["20261127T090000Z", "20261127T090000Z", "DECLINED"]);
  const moved = firstEvent(reply({ recurrence: weekly(), exceptions }, { occurrence: "2026-12-04T09:00:00Z" }));
  eq([one(moved, "RECURRENCE-ID").value, one(moved, "DTSTART").value], ["20261204T090000Z", "20261204T140000Z"]);
  const zoned = readCalendar(reply({ timezone: PARIS, recurrence: weekly() }, { occurrence: "2027-04-02T08:00:00Z" }));
  eq([one(zoned.events[0], "RECURRENCE-ID").params.get("TZID"), one(zoned.events[0], "RECURRENCE-ID").value], [PARIS_TZID, "20270402T100000"]);
  eq(all(zoned.zone, "TZID").length, 1);
  const whole = firstEvent(reply({ recurrence: weekly() }));
  eq(all(whole, "RECURRENCE-ID").length, 0, "the whole series");
  const allDay = firstEvent(reply({ allDay: true, start: "2026-11-20", end: "2026-11-21", recurrence: weekly() }, { occurrence: "2026-11-27" }));
  eq([one(allDay, "RECURRENCE-ID").value, one(allDay, "RECURRENCE-ID").params.get("VALUE")], ["20261127", "DATE"]);
  refused("ITIP_ARGUMENT", () => reply({ recurrence: weekly() }, { occurrence: "2026-11-27" }), "a date for a series with times");
});

test("REPLY: what the organizer chose (UID, summary, names) is escaped like the rest", () => {
  const attack = "x\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:victim@example.org";
  const ics = reply({ summary: attack, uid: "a;b,c\\d", organizer: { email: "orga@example.net", name: `Olga"${attack}` } });
  eq(shape(ics), shape(reply()));
  const e = firstEvent(ics);
  eq(all(e, "ATTENDEE").map((l) => l.value), ["mailto:me@example.com"]);
  eq(unescapeText(one(e, "UID").value), "a;b,c\\d", "the UID goes back exactly as it came");
  eq(one(e, "ORGANIZER").value, "mailto:orga@example.net");
});

// ── Arguments ─────────────────────────────────────────────────────────────

test("the UID is written as it is, or the message is refused", () => {
  const uid = (value) => unescapeText(one(firstEvent(request({ uid: value })), "UID").value);
  for (const ok of ["a", "040000008200E00074C5B7101A82E008", "{81412D3C-2A24-4E9D-B20E-11F7BBE92799}", " spaced uid ", `r${E_ACUTE}union-${SMILE}`, "u".repeat(300), "a;b,c\\d:e\"f"]) eq(uid(ok), ok);
  const bad = ["", "u".repeat(301), "a\r\nb", "a\nb", "a\tb", `a${NUL}b`, `a${ESC}b`, `a${DEL}b`, `a${NEL}b`, `a${LSEP}b`, `a${RLO}b`, `a${ZWSP}b`, `a${BOM}`, String.fromCharCode(0xd800), null, undefined, 5, {}, ["a"]];
  for (const value of bad) refused("ITIP_EVENT", () => request({ uid: value }), JSON.stringify(value));
});

test("method, stamp, sequence and event are checked", () => {
  const args = { method: "REQUEST", event: anEvent(), attendees: PEOPLE, stamp: STAMP, sequence: 0 };
  for (const method of ["request", "PUBLISH", "COUNTER", "REFRESH", "ADD", "", null, undefined, "REQUEST\r\nX:1", "__proto__", 5]) refused("ITIP_ARGUMENT", () => itipCalendar({ ...args, method }), `method ${method}`);
  for (const stamp of ["2026-11-16", "20261116T080000Z", "2026-11-16T08:00:00", "2026-11-16T08:00:00Z\r\nX:1", "", null, undefined, NaN, Infinity, {}, new Date(NaN), Date.UTC(1800, 0, 1), Date.UTC(2300, 0, 1)]) {
    refused("ITIP_ARGUMENT", () => itipCalendar({ ...args, stamp }), `stamp ${String(stamp)}`);
  }
  eq(one(firstEvent(itipCalendar({ ...args, stamp: new Date(Date.UTC(2026, 10, 16, 8, 0, 0, 999)) })), "DTSTAMP").value, "20261116T080000Z");
  eq(one(firstEvent(itipCalendar({ ...args, stamp: Date.UTC(2026, 10, 16, 8, 0, 1) })), "DTSTAMP").value, "20261116T080001Z");
  for (const sequence of [-1, 1.5, 2147483648, "1", null, undefined, NaN, Infinity, "1\r\nX:1"]) refused("ITIP_ARGUMENT", () => itipCalendar({ ...args, sequence }), `sequence ${sequence}`);
  eq(one(firstEvent(itipCalendar({ ...args, sequence: 2147483647 })), "SEQUENCE").value, "2147483647");
  for (const event of [null, undefined, "x", [], {}, { ...anEvent(), kind: "task" }, { ...anEvent(), kind: undefined }]) refused("ITIP_EVENT", () => itipCalendar({ ...args, event }), "event");
  refused("ITIP_ARGUMENT", () => itipCalendar(), "no argument at all");
});

test("the dates of the event are checked", () => {
  const bad = [
    { start: "2026-11-20" }, { end: "2026-11-21" }, { start: "20261120T090000Z" }, { start: "2026-11-20T09:00:00+01:00" }, { start: "2026-11-20T09:00:00Z\r\nX:1" },
    { start: "2026-02-30T09:00:00Z" }, { start: "1899-12-31T23:00:00Z" }, { end: "2201-01-01T00:00:00Z" }, { end: "2026-11-20T08:59:59Z" }, { start: null }, { end: undefined },
    { allDay: true }, { allDay: "false" }, { allDay: 0 }, { allDay: true, start: "2026-11-20", end: "2026-11-19" }, { allDay: true, start: "2026-11-20", end: "2026-11-21T00:00:00Z" },
  ];
  for (const over of bad) {
    for (const make of [request, cancel, reply]) refused("ITIP_EVENT", () => make(over), JSON.stringify(over));
  }
});

test("a calendar beyond MAX_CALENDAR_LENGTH is refused", () => {
  const exceptions = Array.from({ length: 140 }, (_, i) => ({ originalStart: utcText(Date.UTC(2027, 0, 1 + 7 * i, 9)), deleted: false, changes: { description: "d".repeat(32768) } }));
  refused("ITIP_TOO_LARGE", () => request({ recurrence: weekly(), exceptions }));
  eq(MAX_CALENDAR_LENGTH, 4 * 1024 * 1024);
  const fits = request({ recurrence: weekly(), exceptions: exceptions.slice(0, 100) });
  assert(fits.length <= MAX_CALENDAR_LENGTH && fits.length > 3_000_000);
});

test("random hostile texts: the calendar always has the shape of a harmless one, and reads back clean", () => {
  const random = prng(0x5eed1e55);
  const pieces = [
    "\r\n", "\n", "\r", ";", ",", "\\", ":", "\"", "=", " ", "\t", "^n", "^'", "%0D%0A", "BEGIN:VEVENT", "END:VEVENT", "END:VCALENDAR", "ATTENDEE:mailto:eve@evil.example",
    "ORGANIZER:mailto:eve@evil.example", "METHOD:CANCEL", "RRULE:FREQ=SECONDLY", "x", "word", E_ACUTE, EURO, SMILE, NUL, BEL, ESC, DEL, NEL, LSEP, PSEP, RLO, LRI, ZWSP, BOM,
    String.fromCharCode(0xd83d), String.fromCharCode(0xde00), "x".repeat(80),
  ];
  const hostile = () => Array.from({ length: Math.floor(random() * 30) }, () => pieces[Math.floor(random() * pieces.length)]).join("");
  const exceptionShape = shape(request({ recurrence: weekly(), exceptions: [{ originalStart: "2026-11-27T09:00:00Z", deleted: false, changes: {} }] }));
  for (let round = 0; round < 400; round++) {
    const name = hostile();
    const texts = { summary: hostile(), location: `L${hostile()}`, description: `D${hostile()}` };
    const exceptions = [{ originalStart: "2026-11-27T09:00:00Z", deleted: false, changes: { summary: hostile(), location: `L${hostile()}`, description: `D${hostile()}` } }];
    const people = [{ ...BO, name }, { ...CY, name: hostile() }, { ...ROOM, name: hostile() }];
    const ics = itipCalendar({ method: "REQUEST", event: anEvent({ ...texts, organizer: { ...ANA, name: hostile() }, recurrence: weekly(), exceptions, timezone: round % 2 ? PARIS : null }), attendees: people, stamp: STAMP, sequence: round });
    const got = shape(ics);
    eq([got[0], got[2]], [exceptionShape[0], exceptionShape[2]], `round ${round}`);
    for (let i = 0; i < ics.length; i++) {
      const code = ics.charCodeAt(i);
      if (code === 0x0d) assert(ics.charCodeAt(i + 1) === 0x0a, "CR only before LF");
      else if (code === 0x0a) assert(ics.charCodeAt(i - 1) === 0x0d, "LF only after CR");
      else assert(code >= 0x20 || code === 0x09, "no control character");
    }
    for (const bad of [DEL, NEL, LSEP, PSEP, RLO, LRI, ZWSP, BOM]) assert(!ics.includes(bad));
    const [series, occurrence] = readCalendar(ics).events;
    for (const e of [series, occurrence]) {
      eq(all(e, "ATTENDEE").map((l) => l.value), ["mailto:bo@example.org", "mailto:cy@example.net", "mailto:room4@example.org"]);
      eq(one(e, "ORGANIZER").value, "mailto:ana@example.org");
      eq(one(e, "UID").value, "meeting-42@example.org");
    }
    eq(unescapeText(one(series, "SUMMARY").value), unescapeText(escapeText(texts.summary, { max: 1024, singleLine: true })));
    eq(unescapeText(one(series, "DESCRIPTION").value), unescapeText(escapeText(texts.description)));
    assert(!unescapeText(one(series, "SUMMARY").value).includes("\n"), "a summary is one line");
  }
});

test("junk in any field: a calendar that reads back, or an ItipError, never anything else", () => {
  const random = prng(0x0badf00d);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const junk = [
    null, undefined, 0, 1, -1, 1.5, NaN, Infinity, "", "x", "2026-11-20", "2026-11-20T09:00:00Z", "2026-11-27T09:00:00Z", true, false, [], {}, [null], [{}],
    { email: "a@example.org" }, [{ email: "a@example.org", name: "A" }], "a@example.org", PARIS, "busy", "public", "REQUEST", "accepted", weekly(),
    [{ originalStart: "2026-11-27T09:00:00Z", deleted: false, changes: null }], [{ originalStart: "2026-11-27T09:00:00Z", deleted: true }], { length: 2 },
    () => 1, Symbol.iterator, new Date(0), "__proto__", "constructor", `a\r\nX:1${RLO}`,
  ];
  const eventKeys = Object.keys(anEvent());
  const changeKeys = ["summary", "location", "description", "allDay", "start", "end", "busy", "privacy", "attendees", "cancelled"];
  let written = 0;
  let turnedDown = 0;
  for (let round = 0; round < 4000; round++) {
    const event = anEvent({ timezone: PARIS, recurrence: weekly(), exceptions: [{ originalStart: "2026-11-27T09:00:00Z", deleted: false, changes: { summary: "x" } }] });
    const args = { method: pick(["REQUEST", "CANCEL", "REPLY"]), event, attendees: [BO], stamp: STAMP, sequence: 0, occurrence: pick([null, null, "2026-11-27T09:00:00Z", "2026-12-04T09:00:00Z"]) };
    if (args.method === "REPLY") args.replyStatus = "accepted";
    for (let n = 1 + Math.floor(random() * 3); n > 0; n--) {
      const where = random();
      if (where < 0.5) event[pick(eventKeys)] = pick(junk);
      else if (where < 0.7 && Array.isArray(event.exceptions) && event.exceptions[0]?.changes) event.exceptions[0].changes[pick(changeKeys)] = pick(junk);
      else if (where < 0.8) args[pick(["method", "attendees", "stamp", "sequence", "occurrence", "replyStatus", "event"])] = pick(junk);
      else if (where < 0.9 && event.organizer && typeof event.organizer === "object") event.organizer = { ...event.organizer, [pick(["email", "name"])]: pick(junk) };
      else args.attendees = [{ email: pick(junk), name: pick(junk), role: pick(junk) }];
    }
    let ics;
    try {
      ics = itipCalendar(args);
    } catch (e) {
      assert(e instanceof ItipError && /^ITIP_[A-Z_]+$/.test(e.code), `round ${round}: ${e?.name} ${e?.message}`);
      turnedDown++;
      continue;
    }
    written++;
    const c = readCalendar(ics); // every line is checked on the way
    eq(one(c.top, "METHOD").value, args.method);
    assert(c.events.length >= 1 && c.events.every((e) => all(e, "UID").length === 1 && all(e, "ORGANIZER").length === 1 && all(e, "ATTENDEE").length >= 1));
  }
  assert(written > 500 && turnedDown > 500, `${written} written, ${turnedDown} refused`);
});

// ── A reader of the message (RFC 5322, RFC 2045 to 2047) ──────────────────

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function fromBase64(text) {
  assert(/^[A-Za-z0-9+/]*={0,2}$/.test(text) && text.length % 4 === 0, "base64");
  const out = [];
  for (let i = 0; i < text.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (text[i + k] === "=" ? 0 : BASE64.indexOf(text[i + k])));
    out.push((n[0] << 2) | (n[1] >> 4));
    if (text[i + 2] !== "=") out.push(((n[1] & 15) << 4) | (n[2] >> 2));
    if (text[i + 3] !== "=") out.push(((n[2] & 3) << 6) | n[3]);
  }
  return Uint8Array.from(out);
}

/** The unfolded header fields of a header block: [{ name, value }], every line checked. */
function readHeaders(block) {
  const fields = [];
  for (const line of block.split("\r\n")) {
    assert(!line.includes("\r") && !line.includes("\n"), "no bare CR or LF in a header");
    assert(/^[\x20-\x7e]+$/.test(line), "printable ASCII only");
    assert(line.length <= 998, "line length");
    if (line.startsWith(" ")) {
      assert(fields.length > 0 && line.trim().length > 0, "a continuation with content");
      fields[fields.length - 1].value += line;
    } else {
      const colon = line.indexOf(":");
      assert(colon > 0 && /^[A-Za-z-]+$/.test(line.slice(0, colon)), `field name in ${JSON.stringify(line.slice(0, 20))}`);
      fields.push({ name: line.slice(0, colon), value: line.slice(colon + 1).replace(/^ /, "") });
    }
  }
  return fields;
}

/** RFC 2047 section 6.2: encoded-words decoded, the blanks between two of them dropped. */
function decodeWords(value) {
  const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
  let pending = [];
  let out = "";
  let last = 0;
  for (const m of joined.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g)) {
    assert(m[0].length <= 75, "an encoded-word has at most 75 characters");
    const word = fromBase64(m[1]);
    eq(encodeUtf8(decodeUtf8(word)), word, "an encoded-word holds whole characters");
    if (m.index !== last) {
      out += decodeUtf8(Uint8Array.from(pending)) + joined.slice(last, m.index);
      pending = [];
    }
    pending.push(...word);
    last = m.index + m[0].length;
  }
  return out + decodeUtf8(Uint8Array.from(pending)) + joined.slice(last);
}

/** A list of mailboxes → [{ name, email }]: commas outside quotes separate them. */
function readMailboxes(value) {
  const parts = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && quoted) current += c + value[++i];
    else if (c === "\"") (quoted = !quoted), (current += c);
    else if (c === "," && !quoted) parts.push(current), (current = "");
    else current += c;
  }
  assert(!quoted, "quotes are closed");
  parts.push(current);
  return parts.map((part) => {
    const text = part.trim();
    const m = /^(.*)<([^<>]*)>$/.exec(text);
    if (!m) return { name: "", email: text };
    let name = m[1].trim();
    if (name.startsWith("\"")) {
      assert(name.endsWith("\"") && name.length >= 2, "a quoted name");
      name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    } else {
      assert(/^(=\?UTF-8\?B\?[A-Za-z0-9+/=]*\?=\s*)+$/.test(name), `a name is quoted or encoded: ${name}`);
      name = decodeWords(name);
    }
    return { name, email: m[2] };
  });
}

/** → { fields, header(name), boundary, parts: [{ fields, type, encoding, body, bytes }] } */
function readMessage(bytes) {
  assert(bytes instanceof Uint8Array, "bytes for SendMail");
  let text = "";
  for (const b of bytes) {
    assert(b < 0x80, "7-bit bytes only");
    text += String.fromCharCode(b);
  }
  const end = text.indexOf("\r\n\r\n");
  const fields = readHeaders(text.slice(0, end));
  const header = (name) => {
    const found = fields.filter((f) => f.name.toLowerCase() === name.toLowerCase());
    eq(found.length, 1, `exactly one ${name}`);
    return found[0].value;
  };
  const type = /^multipart\/alternative; boundary="([A-Za-z0-9-]+)"$/.exec(header("Content-Type"));
  assert(type, `Content-Type ${header("Content-Type")}`);
  const boundary = type[1];
  const body = text.slice(end + 4);
  const chunks = body.split(`--${boundary}`);
  eq(chunks[0], "", "no preamble");
  eq(chunks[chunks.length - 1], "--\r\n", "closing delimiter, nothing after it");
  const parts = chunks.slice(1, -1).map((chunk) => {
    assert(chunk.startsWith("\r\n") && chunk.endsWith("\r\n"), "delimiter lines");
    const inner = chunk.slice(2);
    const split = inner.indexOf("\r\n\r\n");
    const partFields = readHeaders(inner.slice(0, split));
    const encoded = inner.slice(split + 4);
    for (const line of encoded.split("\r\n")) assert(/^[A-Za-z0-9+/=]{0,76}$/.test(line), "base64 lines of at most 76 characters");
    const value = (name) => partFields.find((f) => f.name === name)?.value;
    eq(value("Content-Transfer-Encoding"), "base64");
    const partBytes = fromBase64(encoded.replace(/\r\n/g, ""));
    return { fields: partFields, type: value("Content-Type"), bytes: partBytes, body: decodeUtf8(partBytes) };
  });
  return { text, fields, header, boundary, parts };
}

const CALENDAR = request();
const aMessage = (over = {}) => ({
  method: "REQUEST",
  calendar: CALENDAR,
  from: ANA,
  to: [BO, CY],
  subject: "Invitation: Weekly point",
  text: "You are invited.\nWhen: Friday.\n",
  date: "2026-11-16T08:00:00Z",
  messageId: "0123456789abcdef@example.org",
  ...over,
});
const message = (over) => readMessage(itipMessage(aMessage(over)));

// ── itipMessage ───────────────────────────────────────────────────────────

test("message: headers, then a text part and the calendar part", () => {
  const bytes = itipMessage(aMessage());
  const m = readMessage(bytes);
  eq(m.fields.map((f) => f.name), ["Date", "From", "To", "Subject", "Message-ID", "MIME-Version", "Content-Type"]);
  eq(m.header("Date"), "Mon, 16 Nov 2026 08:00:00 +0000");
  eq(m.header("From"), "\"Ana Ruiz\" <ana@example.org>");
  eq(m.header("To"), "bo@example.org, cy@example.net", "addresses only: the names are in the calendar");
  eq(m.header("Subject"), "Invitation: Weekly point");
  eq(m.header("Message-ID"), "<0123456789abcdef@example.org>");
  eq(m.header("MIME-Version"), "1.0");
  eq(m.parts.length, 2);
  eq(m.parts.map((p) => p.type), ["text/plain; charset=utf-8", "text/calendar; charset=utf-8; method=REQUEST"]);
  eq(m.parts.map((p) => p.fields.map((f) => f.name)), [["Content-Type", "Content-Transfer-Encoding"], ["Content-Type", "Content-Transfer-Encoding"]]);
  eq(m.parts[0].body, "You are invited.\r\nWhen: Friday.\r\n");
  eq(m.parts[1].body, CALENDAR, "the calendar, byte for byte");
  eq(shape(m.parts[1].body), BENIGN_SHAPE);
  // The project's own readers of raw messages agree.
  eq(messageIdOf(bytes), "0123456789abcdef@example.org");
  eq(dateOf(bytes), Date.UTC(2026, 10, 16, 8));
  eq(fromAddressOf(bytes), "ana@example.org");
  eq(topContentType(bytes), "multipart/alternative");
});

test("message: SendMail takes it", () => {
  const bytes = itipMessage(aMessage());
  const doc = decode(encode(sendMailRequest("0123456789abcdef0123456789abcdef", bytes)));
  eq(rawBytes(doc, "Mime"), bytes);
});

test("message: the same for the three methods; the part says the method of the calendar", () => {
  for (const [method, calendar, to] of [["REQUEST", request(), [BO, CY]], ["CANCEL", cancel(), [BO, CY]], ["REPLY", reply(), [ANA]]]) {
    const m = message({ method, calendar, to, from: ME });
    eq(m.parts[1].type, `text/calendar; charset=utf-8; method=${method}`);
    eq(one(readCalendar(m.parts[1].body).top, "METHOD").value, method);
  }
});

test("message: a calendar that is not what the method says, or not whole, is refused", () => {
  refused("ITIP_ARGUMENT", () => itipMessage(aMessage({ method: "CANCEL" })), "REQUEST calendar sent as CANCEL");
  refused("ITIP_ARGUMENT", () => itipMessage(aMessage({ method: "REPLY", to: [ANA] })));
  refused("ITIP_ARGUMENT", () => itipMessage(aMessage({ method: "PUBLISH" })));
  refused("ITIP_ARGUMENT", () => itipMessage(aMessage({ method: "request" })));
  const bad = [
    "", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", CALENDAR.slice(0, -2), CALENDAR.replace(/\r\n/g, "\n"), `${CALENDAR}X:1\r\n`, `X:1\r\n${CALENDAR}`, CALENDAR.replace("METHOD:REQUEST\r\n", ""),
    CALENDAR.replace("METHOD:REQUEST", "METHOD:REQUEST\r\nMETHOD:REQUEST"), CALENDAR.replace("METHOD:REQUEST", "METHOD:REQUEST\r\nMETHOD:CANCEL"), CALENDAR.replace("SUMMARY:", "SUMMARY:a\rb"),
    CALENDAR.replace("SUMMARY:", "SUMMARY:a\nb"), CALENDAR.replace("SUMMARY:", `SUMMARY:${String.fromCharCode(0xd800)}`), CALENDAR.replace("METHOD:REQUEST", "method:REQUEST"),
  ];
  for (const calendar of bad) refused("ITIP_ARGUMENT", () => itipMessage(aMessage({ calendar })), JSON.stringify(calendar).slice(0, 50));
  for (const calendar of [null, undefined, 5, {}, encodeUtf8(CALENDAR), "x".repeat(MAX_CALENDAR_LENGTH + 1)]) refused("ITIP_TOO_LARGE", () => itipMessage(aMessage({ calendar })));
});

test("subject: plain ASCII as it is, anything else as encoded-words that read back whole", () => {
  const subject = (value) => {
    const m = message({ subject: value });
    return [m.header("Subject"), decodeWords(m.header("Subject"))];
  };
  eq(subject("Invitation: Weekly point (Room 4) <now> \"quoted\""), ["Invitation: Weekly point (Room 4) <now> \"quoted\"", "Invitation: Weekly point (Room 4) <now> \"quoted\""]);
  eq(subject("")[0], "");
  const accents = `R${E_ACUTE}union ${EURO} ${SMILE}`;
  eq(subject(accents)[1], accents);
  assert(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(subject(accents)[0]));
  const longWords = "word ".repeat(150).trim();
  eq(subject(longWords)[1], longWords, "a long plain subject is folded at its spaces");
  const noSpace = "x".repeat(900);
  eq(subject(noSpace)[1], noSpace, "a word too long to fold is encoded");
  assert(subject(noSpace)[0].startsWith("=?UTF-8?B?"));
  const wide = (EURO + SMILE + E_ACUTE).repeat(120);
  eq(subject(wide)[1], wide, "multi-byte characters are never split between two words");
  eq(subject("a  b   c")[1], "a  b   c", "inner spaces are kept");
  eq(subject("  padded  ")[1], "padded");
  eq(subject("=?UTF-8?B?ZXZpbA==?=")[1], "=?UTF-8?B?ZXZpbA==?=", "what looks like an encoded-word is encoded, and reads back as its own text");
  eq(subject("=?UTF-8?Q?evil?= x")[1], "=?UTF-8?Q?evil?= x");
  eq(subject("x".repeat(5000))[1].length, 1024 + 256, "bounded");
  for (const m of [message({ subject: wide }), message({ subject: longWords }), message({ subject: noSpace })]) {
    for (const line of m.text.slice(0, m.text.indexOf("\r\n\r\n")).split("\r\n")) assert(line.length <= 78, `header line of ${line.length} characters`);
  }
});

test("subject: no line break, control or bidirectional character gets through", () => {
  const attack = "Hi\r\nBcc: eve@evil.example\r\nContent-Type: text/html\r\n\r\n<script>";
  const m = message({ subject: attack });
  eq(m.fields.map((f) => f.name), ["Date", "From", "To", "Subject", "Message-ID", "MIME-Version", "Content-Type"]);
  eq(decodeWords(m.header("Subject")), "Hi Bcc: eve@evil.example Content-Type: text/html <script>");
  eq(m.parts.length, 2);
  for (const [value, clean] of [
    [`a\nb\rc${LSEP}d${PSEP}e${NEL}f`, "a b c d ef"], [`Bud${RLO}get${NUL}${BEL}${ESC}${DEL}${ZWSP}${BOM}`, "Budget"], ["a\tb", "a b"], ["\r\n", ""], [`${String.fromCharCode(0xd83d)}x`, `${ch(0xfffd)}x`],
  ]) {
    eq(decodeWords(message({ subject: value }).header("Subject")), clean, JSON.stringify(value));
  }
  for (const notText of [null, undefined, 5, {}, ["x"]]) eq(message({ subject: notText }).header("Subject"), "", String(notText));
});

test("To: addresses and nothing else — a name chosen by someone else cannot read as one more recipient", () => {
  // What the audit produced with the name of an organizer taken from an invitation: valid RFC 5322, in which a
  // server that looks for addresses finds two. The name is no longer written at all.
  const forged = "x\" <third-party@victim.example>, \"y";
  const m = message({ method: "REPLY", calendar: reply(), from: ME, to: [{ email: "organizer@example.org", name: forged }] });
  eq(m.header("To"), "organizer@example.org");
  assert(!m.text.includes("victim.example"), "the forged address is nowhere in the message's headers or parts");
  const headers = m.text.slice(0, m.text.indexOf("\r\n\r\n"));
  eq([...headers.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]+/g)].map((x) => x[0]).filter((a) => !a.startsWith("0123456789abcdef@")), ["me@example.com", "organizer@example.org"], "every address of the headers: the sender's and the recipient's");
  // Whatever the names are, To is the list of the validated addresses, separated by commas.
  const names = ["Bo Chen", "", `R${E_ACUTE}my ${SMILE}`, "a, b <eve@evil.example>,", "=?UTF-8?B?ZXZl?= <eve@evil.example>", "eve@evil.example", "x".repeat(300), `${RLO}<eve@evil.example>`, null, 5, { toString: () => "eve@evil.example" }];
  const to = names.map((name, i) => ({ email: `guest${i}@example.org`, name }));
  const sent = message({ to });
  eq(sent.header("To"), to.map((p) => p.email).join(", "));
  assert(/^[A-Za-z0-9@., -]+$/.test(sent.header("To")), "letters, digits, and the punctuation of addresses and of the list");
  assert(!sent.text.slice(0, sent.text.indexOf("\r\n\r\n")).includes("eve@"), "no name reaches a header");
  // A hundred recipients: a hundred addresses, on lines of at most 78 characters.
  const crowd = Array.from({ length: 100 }, (_, i) => ({ email: `guest${i}@example.org`, name: `Guest ${i}` }));
  const big = message({ to: crowd });
  eq(big.header("To").split(", "), crowd.map((p) => p.email));
  // The names are not lost: they are where a calendar reads them, as CN parameters.
  const ics = itipCalendar({ method: "REQUEST", event: anEvent(), attendees: [{ ...BO, name: "Bo Chen" }], stamp: STAMP, sequence: 0 });
  eq(all(firstEvent(ics), "ATTENDEE").map((l) => l.params.get("CN")), ["Bo Chen"]);
});

test("names in From and To: quoted or encoded, never able to add an address or a header", () => {
  const attacks = [
    "Ana\r\nBcc: eve@evil.example", "Ana\nCc: eve@evil.example", "Ana\" <eve@evil.example>, \"x", "Ana <eve@evil.example>", "eve@evil.example", "a, b <eve@evil.example>,",
    "\\", "\\\"", "a\\", "\"", "\"\"\"", "Ana (comment) <eve@evil.example>", "=?UTF-8?B?ZXZl?= <eve@evil.example>", "=?x?=", `Ana${RLO}<eve@evil.example>${NUL}`,
    `R${E_ACUTE}union <eve@evil.example>, ${SMILE}`, "x".repeat(300), `${EURO}`.repeat(300), "a;b:c", "<>", ",,,,", "@", "Ana\r\n <eve@evil.example>", `x${LSEP}Bcc: eve@evil.example`,
  ];
  for (const name of attacks) {
    const m = message({ from: { email: "ana@example.org", name }, to: [{ email: "bo@example.org", name }, { email: "cy@example.net", name }] });
    eq(m.fields.map((f) => f.name), ["Date", "From", "To", "Subject", "Message-ID", "MIME-Version", "Content-Type"], JSON.stringify(name));
    eq(readMailboxes(m.header("From")).map((b) => b.email), ["ana@example.org"], JSON.stringify(name));
    // To holds the addresses alone: whatever the names are, nothing of them is written there.
    eq(m.header("To"), "bo@example.org, cy@example.net", JSON.stringify(name));
    eq(m.parts.length, 2);
  }
  const names = (name) => readMailboxes(message({ from: { email: "ana@example.org", name } }).header("From"))[0].name;
  eq(names("Ruiz, Ana \"The Boss\" \\o/"), "Ruiz, Ana \"The Boss\" \\o/", "quotes and backslashes are escaped, not lost");
  eq(names(`R${E_ACUTE}my ${SMILE}`), `R${E_ACUTE}my ${SMILE}`);
  eq(names("x".repeat(300)), "x".repeat(256));
  eq(names(`  Ana${ZWSP}  Ruiz `), "Ana Ruiz");
  eq(message({ from: { email: "ana@example.org", name: "" } }).header("From"), "ana@example.org");
  eq(message({ from: { email: "ana@example.org", name: `${RLO}${ZWSP}` } }).header("From"), "ana@example.org");
  eq(message({ from: { email: "ana@example.org" } }).header("From"), "ana@example.org");
});

test("addresses in From and To are validated", () => {
  for (const email of BAD_ADDRESSES) {
    refused("ITIP_ADDRESS", () => itipMessage(aMessage({ from: { email, name: "Ana" } })), `from ${JSON.stringify(email)}`);
    refused("ITIP_ADDRESS", () => itipMessage(aMessage({ to: [BO, { email, name: "x" }] })), `to ${JSON.stringify(email)}`);
  }
  for (const person of [null, undefined, "ana@example.org", ["ana@example.org"], 5]) {
    refused("ITIP_ADDRESS", () => itipMessage(aMessage({ from: person })), `from ${JSON.stringify(person)}`);
    refused("ITIP_ADDRESS", () => itipMessage(aMessage({ to: [person] })), `to ${JSON.stringify(person)}`);
  }
  eq(readMailboxes(message({ to: [{ email: " Bo.Chen+cal@Example.ORG ", name: "" }] }).header("To")), [{ name: "", email: "Bo.Chen+cal@Example.ORG" }]);
});

test("recipients: 1 to MAX_MEETING_RECIPIENTS, exactly one for a REPLY, and no other recipient field", () => {
  const crowd = (n) => Array.from({ length: n }, (_, i) => ({ email: `guest${i}@example.org`, name: i % 3 ? `Guest ${i}` : `Invit${E_ACUTE} ${i}` }));
  const m = message({ to: crowd(100) });
  eq(readMailboxes(m.header("To")).map((b) => b.email), crowd(100).map((p) => p.email));
  eq(readMailboxes(m.header("To")).map((b) => b.name), crowd(100).map(() => ""), "no name in To");
  refused("ITIP_RECIPIENTS", () => itipMessage(aMessage({ to: crowd(101) })));
  for (const none of [[], null, undefined, "bo@example.org", BO]) refused("ITIP_RECIPIENTS", () => itipMessage(aMessage({ to: none })), JSON.stringify(none));
  const answer = { method: "REPLY", calendar: reply(), from: ME };
  eq(readMailboxes(message({ ...answer, to: [ANA] }).header("To")), [{ name: "", email: "ana@example.org" }]);
  refused("ITIP_RECIPIENTS", () => itipMessage(aMessage({ ...answer, to: [ANA, BO] })), "a reply goes to the organizer only");
  for (const sent of [m, message({ ...answer, to: [ANA] }), message({ method: "CANCEL", calendar: cancel() })]) {
    for (const f of sent.fields) assert(!["bcc", "cc", "resent-to", "resent-cc", "resent-bcc", "reply-to", "sender"].includes(f.name.toLowerCase()), f.name);
    assert(!/^(bcc|cc):/im.test(sent.text.slice(0, sent.text.indexOf("\r\n\r\n"))));
  }
});

test("date and Message-ID are written from checked values", () => {
  eq(message({ date: "2024-02-29T23:59:59Z" }).header("Date"), "Thu, 29 Feb 2024 23:59:59 +0000");
  eq(message({ date: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)) }).header("Date"), "Thu, 01 Jan 2026 00:00:00 +0000");
  eq(message({ date: Date.UTC(2027, 11, 31, 12, 30, 15, 500) }).header("Date"), "Fri, 31 Dec 2027 12:30:15 +0000");
  for (const date of ["2026-11-16", "Mon, 16 Nov 2026 08:00:00 +0000", "2026-11-16T08:00:00Z\r\nBcc: eve@evil.example", "", null, undefined, NaN, {}, new Date(NaN), Date.UTC(1800, 0, 1)]) {
    refused("ITIP_ARGUMENT", () => itipMessage(aMessage({ date })), `date ${String(date)}`);
  }
  eq(message({ messageId: "<abc.DEF-123@mail.example.org>" }).header("Message-ID"), "<abc.DEF-123@mail.example.org>");
  eq(message({ messageId: "a!#$%&'*+/=?^_`{|}~b@example.org" }).header("Message-ID"), "<a!#$%&'*+/=?^_`{|}~b@example.org>");
  const bad = [
    "", "abc", "abc@", "@example.org", "a b@example.org", "abc@example.org\r\nBcc: eve@evil.example", "abc@example.org>\r\nX: <y", "<abc@example.org", "abc@example.org>", "<<abc@example.org>>",
    "a<b@example.org", "a>b@example.org", "a(b)@example.org", "a\"b@example.org", "a\\b@example.org", "a,b@example.org", "abc@exa_mple.org", "abc@-example.org", "abc@example.org.",
    `ab${E_ACUTE}@example.org`, `abc@example.org${NUL}`, `abc${RLO}@example.org`, `${"a".repeat(181)}@example.org`, `abc@${"a".repeat(70)}`, "a@b@example.org", null, undefined, 5, {},
  ];
  for (const messageId of bad) refused("ITIP_ARGUMENT", () => itipMessage(aMessage({ messageId })), `Message-ID ${JSON.stringify(messageId)}`);
});

test("text part: any text, as base64; no line of it can be a boundary or a header", () => {
  const first = message();
  const hostile = [
    `--${first.boundary}\r\nContent-Type: text/html\r\n\r\n<b>x</b>\r\n--${first.boundary}--\r\n`,
    `--${first.boundary}--`, "\r\n.\r\n", "From someone\nFrom: x", "x".repeat(5000), `${SMILE}`.repeat(3000), `a${NUL}b${BEL}${ESC}c`, "\r\r\n\n", "",
  ];
  for (const text of hostile) {
    const m = message({ text });
    eq(m.boundary, first.boundary, "the boundary comes from the Message-ID and the date");
    eq(m.parts.length, 2, JSON.stringify(text).slice(0, 30));
    eq(m.parts[1].body, CALENDAR);
    assert(!m.text.slice(m.text.indexOf("\r\n\r\n")).replace(new RegExp(`--${m.boundary}(--)?\r\n`, "g"), "").includes("--"), "no other line starts like a delimiter");
  }
  eq(message({ text: `a${NUL}b${BEL}${ESC}c\rd\ne${LSEP}f` }).parts[0].body, "abc\r\nd\r\ne\r\nf");
  eq(message({ text: "x\ty" }).parts[0].body, "x\ty");
  eq(message({ text: "" }).parts[0].body, "");
  eq(message({ text: `R${E_ACUTE}union ${SMILE}\n` }).parts[0].body, `R${E_ACUTE}union ${SMILE}\r\n`);
  for (const text of [null, undefined, 5, {}, ["x"], "x".repeat(MAX_TEXT_LENGTH + 1)]) refused("ITIP_ARGUMENT", () => itipMessage(aMessage({ text })), String(text).slice(0, 20));
  assert(message({ messageId: "another@example.org" }).boundary !== first.boundary, "another message, another boundary");
});

test("calendar part: hostile event texts cannot leave their part", () => {
  const first = message();
  const attack = `x\r\n--${first.boundary}\r\nContent-Type: text/calendar; method=CANCEL\r\n\r\nBEGIN:VCALENDAR\r\n--${first.boundary}--\r\n`;
  const calendar = request({ summary: attack, location: attack, description: attack });
  const m = message({ calendar });
  eq(m.boundary, first.boundary);
  eq(m.parts.length, 2);
  eq(m.parts[1].body, calendar);
  eq(shape(m.parts[1].body), BENIGN_SHAPE);
  const big = request({ description: `${SMILE} ${E_ACUTE} `.repeat(8000) });
  eq(message({ calendar: big }).parts[1].body, big, "non-ASCII content, byte for byte");
});

test("message: every byte is ASCII, lines end with CRLF and are short", () => {
  const bytes = itipMessage(aMessage({ subject: `R${E_ACUTE}union`, text: `${SMILE}\n`.repeat(500), to: Array.from({ length: 100 }, (_, i) => ({ email: `guest${i}@example.org`, name: `Invit${E_ACUTE} num${E_ACUTE}ro ${i}` })) }));
  let line = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    assert(b === 0x0d || b === 0x0a || (b >= 0x20 && b <= 0x7e), `byte ${b}`);
    if (b === 0x0d) assert(bytes[i + 1] === 0x0a, "CR only before LF");
    if (b === 0x0a) {
      assert(bytes[i - 1] === 0x0d, "LF only after CR");
      assert(line <= 78 + 1, `line of ${line} characters`);
      line = 0;
    } else {
      line++;
    }
  }
  eq(bytes[bytes.length - 2], 0x0d);
  eq(bytes[bytes.length - 1], 0x0a);
});

test("from the event to SendMail: an invitation in a time zone, read back by a recipient", () => {
  const event = anEvent({ timezone: PARIS, summary: `R${E_ACUTE}union; budget, 2027`, recurrence: weekly({ count: 10 }), exceptions: [{ originalStart: "2026-11-27T09:00:00Z", deleted: true, changes: {} }] });
  const calendar = itipCalendar({ method: "REQUEST", event, attendees: event.attendees, stamp: STAMP, sequence: 2 });
  const bytes = itipMessage({ method: "REQUEST", calendar, from: event.organizer, to: event.attendees, subject: `Invitation : ${event.summary}`, text: "Voir le calendrier.\n", date: STAMP, messageId: "<f00@example.org>" });
  const m = readMessage(bytes);
  eq(decodeWords(m.header("Subject")), `Invitation : R${E_ACUTE}union; budget, 2027`);
  eq(readMailboxes(m.header("To")).map((b) => b.email), ["bo@example.org", "cy@example.net", "room4@example.org"]);
  const c = readCalendar(m.parts[1].body);
  const e = c.events[0];
  eq(unescapeText(one(e, "SUMMARY").value), `R${E_ACUTE}union; budget, 2027`);
  eq([one(e, "RRULE").value, one(e, "EXDATE").value, one(e, "SEQUENCE").value], ["FREQ=WEEKLY;COUNT=10;BYDAY=FR", "20261127T100000", "2"]);
  eq(zoneReader(c.zone).resolve(one(e, "DTSTART").value), Date.UTC(2026, 10, 20, 9));
  eq(all(e, "ATTENDEE").map((l) => l.value.replace("mailto:", "")), readMailboxes(m.header("To")).map((b) => b.email), "the recipients are the attendees");
});
