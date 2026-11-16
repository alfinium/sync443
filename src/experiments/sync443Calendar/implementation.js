// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * sync443Calendar: the calendars of Sync443, and nothing else.
 *
 * Calendars
 *   A calendar of the extension has the provider type "sync443", registered
 *   by this module when the extension starts (and unregistered when it stops,
 *   not when Thunderbird quits), the id "sync443-<mailboxId>-<n>", and two
 *   marks among its properties (preferences calendar.registry.<id>.*):
 *     sync443.owner    the extension's id
 *     sync443.mailbox  the mailboxId (12 lower-case hexadecimal digits)
 *   Every function ignores a calendar that lacks any of this; ensureCalendar
 *   never adopts a calendar it did not create. A calendar is never recognized
 *   by its name.
 *
 *   Each calendar wraps an inner storage calendar of Thunderbird that is not
 *   registered (file <profile>/calendar-data/sync443.sqlite, one cal_id per
 *   calendar), as Thunderbird's cached calendars do. The provider class
 *   extends cal.provider.BaseClass; it does not subclass the storage class.
 *
 *   Fixed properties: no cache (Thunderbird would copy the calendar under a
 *   new id), no removal from Thunderbird's interface, no network, providerID
 *   null, organizerId = mailto:<mailbox address>, supportsScheduling with
 *   canNotify() true for every method and a transport that sends nothing:
 *   Thunderbird never sends an invitation, a reply or a cancellation for an
 *   item of ours. Every item is stored under its calendar of ours, whatever
 *   calendar a caller left on it or on one of its occurrences.
 *
 *   A calendar created here starts empty: rows left under its id in the
 *   inner store are deleted first, and a calendar that cannot be created
 *   whole is not registered. When the extension stops while Thunderbird
 *   goes on, the calendar objects still held somewhere refuse every write.
 *
 * Items
 *   Server data never reaches this module as iCalendar: it receives item
 *   descriptions (plain JSON, see docs/CALENDAR-DESIGN.md), checks each one
 *   again against every bound of the contract, and builds Thunderbird items
 *   with Thunderbird's constructors and setters. A description that fails a
 *   single check is refused whole.
 *   An item is a ServerId in a collection. The iCalendar UID never selects a
 *   local item: a second item with a UID already present gets an id of ours
 *   ("sync443-<uuid>") and keeps its UID for the way back. An item added
 *   through the calendar object under an id the calendar already holds is
 *   refused (DUPLICATE_ID), as Thunderbird's own storage refuses it.
 *
 *   Read-only items. An item whose synchronized description says
 *   `readOnly` (or that was locked) is read-only for Thunderbird too: the
 *   calendar's `aclManager` hands out entries of ours, which Thunderbird
 *   asks before it opens its editing dialog, moves an event in the day and
 *   week views, cuts it, or stores a reminder answered; and adoptItem's
 *   siblings, modifyItem and deleteItem, refuse (CAL_IS_READONLY) what
 *   Thunderbird does not ask about: a deletion, a move in the month view,
 *   a task ticked off, an answer from the invitation bar. Nothing is
 *   registered, and the calendar's own access entry is untouched. A
 *   change that waited while its item became read-only is still read with
 *   the problem "read-only".
 *
 *   Recurrences. A rule is given to Thunderbird only if it has one of the
 *   shapes ActiveSync has (those of src/core/recurrence.mjs), if its day
 *   comes within its first four periods, and if the item is no longer than
 *   its own period; the series built is then expanded once over those
 *   periods, and refused if Thunderbird cannot do it. In that order: in
 *   Thunderbird 140 a rule of another shape may never return, and one whose
 *   day does not come makes every item of the calendar vanish from the
 *   views. Known difference: ActiveSync puts "day 29, 30 or 31" on the last
 *   day of a shorter month; the rule Thunderbird is given skips that month.
 *
 *   Text. The content of an item (title, place, notes, categories) keeps
 *   the zero-width joiner and non-joiner, which are part of words and of
 *   emoji; the names of people and of calendars do not. Controls,
 *   bidirectional controls, the other invisible characters, tag characters
 *   and U+FFF9 to U+FFFB, U+FFFE, U+FFFF are refused everywhere.
 *
 * Journal
 *   For each item, one row in the inner store's metadata table, under a key
 *   no sender can guess ("sync443:" + a random token): the item's id, its
 *   ServerId and collection, the last synchronized description, and the
 *   pending local change if any ("c" created, "m" modified, "d" deleted)
 *   with a revision counter that never restarts: a change id names one
 *   change, for ever. Changes made through the calendar object
 *   (adoptItem, modifyItem, deleteItem: the event dialog, drag and drop,
 *   undo, the invitation bar) are recorded there; writes of
 *   applyServerChanges go to the inner store directly and record nothing.
 *   Every row written is read back: one that is not stored is an error.
 *   A deleted item keeps its row in the journal (not in the calendar) until
 *   the deletion is acknowledged or dropped.
 *   An item can be detached (applyServerChanges "detach", or the dropping
 *   of the change that created it): it stays in the calendar without
 *   ServerId, synchronized description or pending change. If the user
 *   changes it later, the change is read as an "add" marked `detached`; if
 *   the user deletes it, nothing is left and nothing is read.
 *   Two marks live with a pending change. `rewritten`: the server changed
 *   the item while the change waited (written in the same row, in the same
 *   write, as the server's new description). `replyAsked`: Thunderbird
 *   asked canNotify("REPLY") for the answer the item now carries, which it
 *   does only when it would send that answer to the organizer itself.
 *   Thunderbird asks just after the change: the user's own answer to
 *   someone else's meeting is therefore not read during the two seconds
 *   that follow it (onLocalChange fires again when it can be).
 *   The storage calendar's own offline flags are not used: Thunderbird keeps
 *   a copy of them in memory for recurring items and never updates it, so a
 *   recurring item flagged as deleted stays visible until the next start.
 *
 * Time zones
 *   A description gives a zone as offsets and two yearly changes (the
 *   content of a Windows time-zone structure, never its names). The zone of
 *   Thunderbird used for an item is Thunderbird's default zone if it has
 *   these offsets and changes in the item's year, else a zone of
 *   Thunderbird's list that has them (a short list of well-known zones
 *   first, then alphabetical order), else a zone of ours made from the rules
 *   ("Sync443/UTC+0545/…", kept by the storage with the item, as a zone
 *   received in an invitation is). Local times are worked out here from the
 *   rules, and each date is checked: one that the zone does not give back to
 *   the second stays in UTC. In the other direction, the zone of an item is
 *   described by asking Thunderbird for its offsets along the year. A whole
 *   day always says a zone: the one it came with, or Thunderbird's default.
 *
 * Functions (all asynchronous)
 *   listCalendars() -> [{calendarId, mailboxId, slot, name, events, tasks}]
 *   ensureCalendar({mailboxId, slot, name, events, tasks, organizerEmail})
 *     -> {calendarId, created}
 *   removeCalendar(calendarId) -> boolean
 *   applyServerChanges(calendarId, changes) -> [{serverId, ok, code?}]
 *     changes: {op: "put", collectionId, serverId, item}
 *            | {op: "remove", collectionId, serverId}
 *            | {op: "detach", collectionId, serverId}
 *            | {op: "lock", collectionId, serverId}
 *     In the item of a put, `description: null` and `meeting.response:
 *     null` mean "the server does not say": what is held is kept (nothing,
 *     and "not answered", for an item that is new). A task may carry
 *     `ordinalDate` and `subOrdinalDate` (text, 40 characters at most),
 *     kept with its synchronized description and said again with it.
 *   serverIds(calendarId, collectionId) -> [serverId]
 *   readLocalChanges(calendarId, {max}?) -> [{changeId, op, kind,
 *     collectionId, serverId, item, previous, problem, detached,
 *     rewritten, replyAsked}]
 *   ackLocalChange(calendarId, changeId, {serverId?, collectionId?, item?})
 *     -> boolean
 *   dropLocalChange(calendarId, changeId) -> boolean
 *   onLocalChange(calendarId)                        event
 *
 * Who can call it: only the background page's context, as for sync443Net and
 * sync443Account. One operation at a time: API calls and the changes made
 * through the calendar objects wait in one queue.
 *
 * Known limits
 *   - No total budget: a description is at most 1 MiB and a calendar holds
 *     at most 50,000 items, each stored as an item and, for what the server
 *     said of it, in the journal.
 *   - What a description cannot carry stays local, is never sent, and is
 *     overwritten by the next change from the server: the time of day of a
 *     task, its percentage done, a second reminder.
 *   - An invitation addressed to another address of the user: Thunderbird
 *     asks for no reply that this module could record (only the answer of
 *     the mailbox's own address is one), so none is sent.
 *   - Moving an event out of a calendar of another kind into one of ours is
 *     an addition here and a deletion there: that other calendar may send
 *     its own cancellation.
 *   - When the extension is disabled or removed, Thunderbird keeps our
 *     calendars as disabled stand-ins, with the store file
 *     (calendar-data/sync443.sqlite) and their preferences, the mailbox's
 *     address among them. removeCalendar is what deletes them.
 *   - Thunderbird 140 hands an item id to a calendar it took from its
 *     calendar manager as a narrow string: there, an item whose id has a
 *     character above U+00FF is listed and shown but not found by its id
 *     (the invitation bar does not find it). This module itself reaches
 *     its store without that loss.
 *
 * Every refusal of a call is an ExtensionError "CODE: reason":
 *   CONFIG       invalid argument
 *   PERMISSION   not the background page
 *   NOT_FOUND    no calendar of the extension has this id
 *   CONFLICT     several calendars for one slot; an id or a ServerId already
 *                taken
 *   LIMIT        too many calendars
 *   UNSUPPORTED  the provider could not be registered in this Thunderbird
 *   INTERNAL     Thunderbird refused the operation
 * applyServerChanges answers for each change { serverId, ok, code? } with the
 * codes INVALID (description outside the contract), TOO_LARGE, KIND (the
 * calendar does not hold this kind of item), UNSUPPORTED (a recurrence
 * Thunderbird must not be given), LIMIT (the calendar holds 50,000 items)
 * and INTERNAL.
 * No message carries a subject, a name, an address or a location.
 */

"use strict";

/* global ExtensionCommon, ChromeUtils, Services, Cc, Ci, Cr, Components */

// Loaded into the extension's experiment global, shared with other
// experiment scripts of the same extension: only this name is defined there.
// eslint-disable-next-line no-var, no-unused-vars
var sync443Calendar = (() => {
  const { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
  const { ExtensionError } = ExtensionUtils;
  // Thunderbird's calendar services are reached through `cal` only: they are
  // XPCOM services in 140 and module singletons in later versions.
  const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
  const { CalEvent } = ChromeUtils.importESModule("resource:///modules/CalEvent.sys.mjs");
  const { CalTodo } = ChromeUtils.importESModule("resource:///modules/CalTodo.sys.mjs");
  const { CalAttendee } = ChromeUtils.importESModule("resource:///modules/CalAttendee.sys.mjs");
  const { CalAlarm } = ChromeUtils.importESModule("resource:///modules/CalAlarm.sys.mjs");
  const { CalRecurrenceInfo } = ChromeUtils.importESModule("resource:///modules/CalRecurrenceInfo.sys.mjs");

  const TYPE = "sync443";
  const OWNER = "sync443.owner";
  const MAILBOX = "sync443.mailbox";
  const SLOT = "sync443.slot";
  const EVENTS = "sync443.events";
  const TASKS = "sync443.tasks";
  const ADDRESS = "sync443.email";
  const REGISTRY = "calendar.registry.";
  const SORT_ORDER_PREF = "calendar.list.sortOrder";
  const STORE_FILE = "sync443.sqlite";
  const META_KEY = "sync443:"; // + token: key of a journal row in the inner store's metadata
  const LOCAL_ID = "sync443-"; // + uuid: id of an item whose UID another item already has

  const MAILBOX_ID = /^[a-f0-9]{12}$/;
  const CALENDAR_ID = /^sync443-([a-f0-9]{12})-([1-9][0-9]{0,3})$/;
  const TOKEN = /^[a-f0-9]{32}$/;
  const CHANGE_ID = /^([a-f0-9]{32})\.([1-9][0-9]{0,8})$/;
  const EMAIL =
    /^([A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/;
  const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
  const UTC = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/;
  const SNOOZE = /^X-MOZ-SNOOZE-TIME(?:-[0-9]{1,20})?$/;

  const MAX_CALENDARS = 50;
  const MAX_CHANGES = 200;
  // Items of one calendar, the user's own included: more than the engine ever keeps (20,000 for each collection,
  // and a main calendar has two). A put that would add one more answers LIMIT.
  const MAX_ITEMS = 50000;
  const MAX_NAME = 256;
  const MAX_JSON = 1024 * 1024; // a whole description, written as JSON
  const MAX_ITEM_ID = 4096; // id of an item added through Thunderbird
  const MAX_REVISION = 999999999;
  const MAX_ORDINAL = 40; // OrdinalDate, SubOrdinalDate of a task: text kept for the server, never read here
  // An answer to an invitation is not read sooner after the user gave it: Thunderbird asks canNotify("REPLY")
  // only once the item is changed, and what it asked belongs to the change.
  const SETTLE_MS = 2000;
  const MAX_ASKED = 256; // answers Thunderbird asked to send that are not recorded yet
  const MIN_YEAR = 1900;
  const MAX_YEAR = 2200;
  const MINUTE = 60000;
  const DAY = 86400000;

  const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const DAY_INDEX = new Map(DAYS.map((name, index) => [name, index]));
  const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // the most days each month has
  // The period of a rule, in days for an interval of 1 (the longest a month and a year get): an item is not
  // longer than its own period.
  const PERIOD_DAYS = new Map([
    ["daily", 1],
    ["weekly", 7],
    ["monthly", 31],
    ["yearly", 366],
  ]);
  const FREQUENCIES = new Map([
    ["daily", "DAILY"],
    ["weekly", "WEEKLY"],
    ["monthly", "MONTHLY"],
    ["yearly", "YEARLY"],
  ]);
  const FREQUENCY_NAMES = new Map([...FREQUENCIES].map(([name, value]) => [value, name]));
  const BUSY = new Set(["free", "tentative", "busy", "away"]);
  const PRIVACY = new Map([
    ["public", "PUBLIC"],
    ["private", "PRIVATE"],
    ["confidential", "CONFIDENTIAL"],
  ]);
  const ROLES = new Map([
    ["required", "REQ-PARTICIPANT"],
    ["optional", "OPT-PARTICIPANT"],
    ["resource", "NON-PARTICIPANT"],
  ]);
  const STATUSES = new Map([
    ["unknown", "NEEDS-ACTION"],
    ["tentative", "TENTATIVE"],
    ["accepted", "ACCEPTED"],
    ["declined", "DECLINED"],
    ["not-responded", "NEEDS-ACTION"],
  ]);
  const RESPONSES = new Map([
    ["none", "NEEDS-ACTION"],
    ["tentative", "TENTATIVE"],
    ["accepted", "ACCEPTED"],
    ["declined", "DECLINED"],
    ["not-responded", "NEEDS-ACTION"],
  ]);
  const ANSWERS = new Map([
    ["TENTATIVE", "tentative"],
    ["ACCEPTED", "accepted"],
    ["DECLINED", "declined"],
  ]);
  const ANSWER_NAMES = new Set(ANSWERS.values());
  const MEETING_ROLES = new Set(["none", "organizer", "attendee"]);
  const PRIORITIES = new Map([
    ["low", 9],
    ["normal", 5],
    ["high", 1],
  ]);
  const EVENT_READ_ONLY = new Set(["calendar-type", "unsupported-recurrence", "incomplete"]);
  const TASK_READ_ONLY = new Set(["regenerating", "unsupported-recurrence", "incomplete"]);

  const EVENT_KEYS = [
    "kind",
    "uid",
    "summary",
    "location",
    "description",
    "allDay",
    "start",
    "end",
    "timezone",
    "busy",
    "privacy",
    "reminder",
    "categories",
    "organizer",
    "attendees",
    "meeting",
    "recurrence",
    "exceptions",
    "stamp",
    "sequence",
    "readOnly",
  ];
  const TASK_KEYS = [
    "kind",
    "uid",
    "summary",
    "description",
    "categories",
    "privacy",
    "start",
    "due",
    "completed",
    "completedAt",
    "priority",
    "reminderAt",
    "recurrence",
    "readOnly",
  ];
  const TASK_OPTIONAL_KEYS = ["ordinalDate", "subOrdinalDate"];
  const MEETING_KEYS = ["role", "cancelled", "responseRequested", "response", "allowNewTime"];
  const RECURRENCE_KEYS = ["freq", "interval", "count", "until", "byDay", "bySetPos", "byMonthDay", "byMonth", "weekStart"];
  const EXCEPTION_KEYS = ["originalStart", "deleted", "changes"];
  const CHANGE_KEYS = [
    "summary",
    "location",
    "description",
    "allDay",
    "start",
    "end",
    "busy",
    "privacy",
    "reminder",
    "categories",
    "attendees",
    "cancelled",
  ];
  const PERSON_KEYS = ["email", "name"];
  const ATTENDEE_KEYS = ["email", "name", "role", "status"];
  const ZONE_KEYS = ["bias", "standard", "daylight"];
  const ZONE_PART_KEYS = ["bias", "change"];
  const ZONE_CHANGE_KEYS = ["month", "week", "weekday", "hour", "minute"];

  /**
   * What Thunderbird may read of a calendar of ours but never change: these
   * names are answered by the provider itself and are never stored.
   */
  const FIXED_PROPERTIES = new Set([
    "cache.supported",
    "cache.enabled",
    "cache.always",
    "capabilities.removeModes",
    "requiresNetwork",
    "capabilities.events.supported",
    "capabilities.tasks.supported",
    "organizerId",
    "organizerCN",
    "itip.transport",
    "imip.identity",
    "imip.account",
    "imip.identity.disabled",
    "capabilities.autoschedule.supported",
    "capabilities.attachments.supported",
    "capabilities.alarms.maxCount",
    "capabilities.alarms.actionValues",
    "capabilities.categories.maxCount",
    "capabilities.privacy.supported",
    "capabilities.privacy.values",
    "capabilities.priority.supported",
    "capabilities.timezones.floating.supported",
    "capabilities.timezones.UTC.supported",
    "refreshInterval",
  ]);

  /**
   * Zones tried first, after Thunderbird's default zone, when several zones
   * of Thunderbird's list have the offsets and rules of a server zone: one
   * well-known zone for each common rule set, so that the choice does not
   * depend on the alphabet.
   */
  const PREFERRED_ZONES = [
    "Europe/London",
    "Europe/Lisbon",
    "Europe/Berlin",
    "Europe/Paris",
    "Europe/Athens",
    "Europe/Helsinki",
    "Europe/Istanbul",
    "Europe/Moscow",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Phoenix",
    "America/Los_Angeles",
    "America/Anchorage",
    "Pacific/Honolulu",
    "America/Halifax",
    "America/St_Johns",
    "America/Mexico_City",
    "America/Bogota",
    "America/Sao_Paulo",
    "America/Argentina/Buenos_Aires",
    "America/Buenos_Aires",
    "America/Santiago",
    "Africa/Johannesburg",
    "Africa/Cairo",
    "Africa/Lagos",
    "Africa/Nairobi",
    "Asia/Jerusalem",
    "Asia/Dubai",
    "Asia/Tehran",
    "Asia/Karachi",
    "Asia/Kolkata",
    "Asia/Calcutta",
    "Asia/Dhaka",
    "Asia/Bangkok",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Asia/Seoul",
    "Australia/Perth",
    "Australia/Adelaide",
    "Australia/Brisbane",
    "Australia/Sydney",
    "Pacific/Auckland",
  ];

  // ── Errors ────────────────────────────────────────────────────────────

  const fail = (code, reason) => new ExtensionError(`${code}: ${reason}`);

  /** Name of an XPCOM error ("NS_ERROR_FAILURE") or of a JS error class, never free text. */
  function errorName(error) {
    const status = error?.result;
    if (typeof status === "number") {
      const name = ChromeUtils.getXPCOMErrorName(status);
      return /^[A-Z0-9_]{1,64}$/.test(name) ? name : `0x${(status >>> 0).toString(16)}`;
    }
    const name = error?.name;
    return typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name) ? name : "erreur";
  }

  /** Any error → ExtensionError: ours as they are, Thunderbird's as INTERNAL with its name only. */
  function internal(what, error) {
    if (error instanceof ExtensionError) return error;
    return fail("INTERNAL", `${what} : opération refusée par Thunderbird (${errorName(error)})`);
  }

  /** A description refused whole (applyServerChanges answers with its code). */
  class Refusal extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }
  const refuse = (code = "INVALID") => {
    throw new Refusal(code);
  };

  /** An item of Thunderbird that no description can hold. */
  class Problem extends Error {
    constructor(problem) {
      super(problem);
      this.problem = problem;
    }
  }
  const problem = (kind) => {
    throw new Problem(kind);
  };

  // ── Text ──────────────────────────────────────────────────────────────

  /**
   * Is this UTF-16 unit refused in a string of a description? Controls
   * (C0, DEL, C1), the line and paragraph separators, the bidirectional
   * controls, the invisible characters (soft hyphen, Mongolian vowel
   * separator, zero-width space, word joiner, byte order mark), the
   * interlinear annotation marks and the non-characters U+FFFE and U+FFFF.
   * A line feed and a tab pass in a text of several lines (`lines`). The
   * zero-width non-joiner and joiner (U+200C, U+200D) are part of words in
   * several scripts and of emoji: they pass in the content of an item
   * (`joiners`), never in the name of a person or of a calendar.
   */
  function forbidden(code, lines, joiners) {
    if (code < 0x20) return !(lines && (code === 0x0a || code === 0x09));
    if (code < 0x7f) return false;
    if (code <= 0x9f) return true;
    if (code < 0x200b) return code === 0x00ad || code === 0x061c || code === 0x180e;
    if (code === 0x200c || code === 0x200d) return !joiners;
    if (code <= 0x200f || code === 0x2028 || code === 0x2029 || code === 0x2060 || code === 0xfeff) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
    return (code >= 0xfff9 && code <= 0xfffb) || code === 0xfffe || code === 0xffff;
  }

  /** The first unit of a tag character (U+E0000 to U+E007F), written as two units: refused everywhere. */
  const tagAt = (value, i) => value.charCodeAt(i) === 0xdb40 && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdc7f;

  function hasForbidden(value, lines, joiners = false) {
    for (let i = 0; i < value.length; i++) {
      if (forbidden(value.charCodeAt(i), lines, joiners) || tagAt(value, i)) return true;
    }
    return false;
  }

  /**
   * A string of a description: bounded, well formed, without a refused
   * character. `joiners`: the content of an item (true) or a name (false).
   */
  function str(value, min, max, lines = false, joiners = true) {
    if (typeof value !== "string" || value.length < min || value.length > max) refuse();
    if (!value.isWellFormed() || hasForbidden(value, lines, joiners)) refuse();
    return value;
  }

  /** The name of a person: no invisible character at all. */
  const personName = (value) => str(value, 0, 256, false, false);

  /**
   * Text typed in Thunderbird, on its way to a description: the refused
   * characters are removed; line breaks become "\n", or a space on a single
   * line.
   */
  function tidy(value, lines = false, joiners = true) {
    let text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
    if (!text.isWellFormed()) text = text.toWellFormed();
    if (!hasForbidden(text, lines, joiners)) return text;
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (tagAt(text, i)) {
        i++; // both units of a tag character
      } else if (!forbidden(code, lines, joiners)) {
        out += text[i];
      } else if (code === 0x0d || code === 0x0a || code === 0x09 || code === 0x2028 || code === 0x2029) {
        if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) continue; // CR LF: the LF speaks
        if (lines) out += "\n";
        else if (!out.endsWith(" ")) out += " ";
      }
    }
    return out;
  }

  /** Cut to `max` UTF-16 units without splitting a surrogate pair. */
  function cut(text, max) {
    if (text.length <= max) return text;
    const last = text.charCodeAt(max - 1);
    return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
  }

  /** ServerId, CollectionId: 1 to 64 characters, no control ([MS-ASCMD]). */
  function isItemId(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 64 || !value.isWellFormed()) return false;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return false;
    }
    return true;
  }

  function isEmail(value) {
    if (typeof value !== "string" || value.length < 3 || value.length > 254) return false;
    const m = EMAIL.exec(value);
    return !!m && m[1].length <= 64;
  }

  // ── Arguments of the API ──────────────────────────────────────────────

  const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  function calendarIdOf(value) {
    if (typeof value !== "string" || !CALENDAR_ID.test(value)) throw fail("CONFIG", "identifiant d'agenda invalide");
    return value;
  }

  function itemIdOf(value, what) {
    if (!isItemId(value)) throw fail("CONFIG", `${what} invalide`);
    return value;
  }

  function changeIdOf(value) {
    const m = typeof value === "string" ? CHANGE_ID.exec(value) : null;
    if (!m) throw fail("CONFIG", "identifiant de modification invalide");
    return { token: m[1], revision: Number(m[2]) };
  }

  function calendarOptions(options) {
    if (!plainObject(options)) throw fail("CONFIG", "options manquantes");
    const { mailboxId, slot, name, events, tasks, organizerEmail } = options;
    if (typeof mailboxId !== "string" || !MAILBOX_ID.test(mailboxId)) throw fail("CONFIG", "identifiant de boîte invalide");
    if (slot !== "main" && !isItemId(slot)) throw fail("CONFIG", "emplacement invalide");
    if (
      typeof name !== "string" ||
      name.length < 1 ||
      name.length > MAX_NAME ||
      !name.isWellFormed() ||
      hasForbidden(name, false, false) ||
      name.trim() === ""
    ) {
      throw fail("CONFIG", "nom d'agenda invalide");
    }
    if (typeof events !== "boolean" || typeof tasks !== "boolean" || !(events || tasks)) {
      throw fail("CONFIG", "types d'éléments invalides");
    }
    if (!isEmail(organizerEmail)) throw fail("CONFIG", "adresse électronique invalide");
    return { mailboxId, slot, name, events, tasks, organizerEmail };
  }

  // ── Context and queue ─────────────────────────────────────────────────

  function checkContext(context) {
    if (context.viewType !== "background" || context.unloaded) {
      throw fail("PERMISSION", "réservé à la page d'arrière-plan de l'extension");
    }
  }

  /** Runs each task after the previous one has settled. */
  function serial() {
    let tail = Promise.resolve();
    return (task) => {
      const run = tail.then(task);
      tail = run.catch(() => {});
      return run;
    };
  }

  // ── Dates ─────────────────────────────────────────────────────────────

  const pad = (n, width = 2) => String(n).padStart(width, "0");

  function realDay(year, month, day) {
    if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return false;
    return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  /** "YYYY-MM-DD" → milliseconds of that day at 00:00 UTC, or null. */
  function dateMs(value) {
    const m = typeof value === "string" ? DATE.exec(value) : null;
    if (!m || !realDay(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  /** "YYYY-MM-DDTHH:MM:SSZ" → milliseconds, or null. */
  function utcMs(value) {
    const m = typeof value === "string" ? UTC.exec(value) : null;
    if (!m || !realDay(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
    const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6])];
    if (hour > 23 || minute > 59 || second > 59) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute, second);
  }

  /** Milliseconds of a DATE or a UTC value already checked. */
  const instant = (value) => (value.length === 10 ? dateMs(value) : utcMs(value));

  /** Does an end follow its start? A whole day ends after it starts; a time may end when it starts. */
  const ordered = (start, end) => (start.length === 10 ? instant(end) > instant(start) : instant(end) >= instant(start));

  const dateText = (year, month, day) => `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  const dayText = (ms) => new Date(ms).toISOString().slice(0, 10);

  function utcText(ms) {
    const d = new Date(ms);
    return (
      `${dateText(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())}` +
      `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
    );
  }

  /** A date and time of Thunderbird at this UTC instant. */
  function utcDateTime(ms) {
    const d = new Date(ms);
    const dt = cal.createDateTime();
    dt.resetTo(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      cal.timezoneService.UTC,
    );
    return dt;
  }

  /**
   * A whole day of Thunderbird (no time, no zone) from a DATE. A day worked
   * out here (the end of a changed occurrence) may fall after the last year
   * of the contract: refused, never turned into another date.
   */
  function dayDateTime(value) {
    const ms = dateMs(value);
    if (ms === null) refuse();
    const d = new Date(ms);
    const dt = cal.createDateTime();
    dt.resetTo(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, cal.timezoneService.floating);
    dt.isDate = true;
    return dt;
  }

  function defaultZone() {
    return cal.timezoneService.defaultTimezone ?? cal.timezoneService.UTC;
  }

  /** Milliseconds of a date and time of Thunderbird; a time without a zone is read in the default zone. */
  function msOf(dt) {
    const anchored = dt.timezone.isFloating && !dt.isDate ? dt.getInTimezone(defaultZone()) : dt;
    return Math.round(anchored.nativeTime / 1000);
  }

  /** The value of a description for a date of Thunderbird: DATE for a whole day, UTC otherwise. */
  function momentOf(dt) {
    if (dt.isDate) {
      if (!realDay(dt.year, dt.month + 1, dt.day)) problem("too-large");
      return dateText(dt.year, dt.month + 1, dt.day);
    }
    const ms = msOf(dt);
    const year = new Date(ms).getUTCFullYear();
    if (!Number.isFinite(ms) || year < MIN_YEAR || year > MAX_YEAR) problem("too-large");
    return utcText(ms);
  }

  /** The day of a task's date as the user sees it. */
  function dayOf(dt) {
    if (!realDay(dt.year, dt.month + 1, dt.day)) problem("too-large");
    return dateText(dt.year, dt.month + 1, dt.day);
  }

  // ── Descriptions: validation ──────────────────────────────────────────
  //
  // Each function checks a value against the contract and returns a copy
  // made here, with the keys in a fixed order: nothing of the object
  // received is kept. Enumerations are looked up in Map and Set.

  /** A plain object with exactly these own keys, and any of the `optional` ones. */
  function record(value, keys, optional = []) {
    if (!plainObject(value)) refuse();
    const own = Object.keys(value);
    const allowed = new Set(keys);
    const more = new Set(optional);
    let required = 0;
    for (const key of own) {
      if (allowed.has(key)) required++;
      else if (!more.has(key)) refuse();
    }
    if (required !== keys.length) refuse();
    return value;
  }

  function int(value, min, max) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) refuse();
    return value;
  }

  function bool(value) {
    if (typeof value !== "boolean") refuse();
    return value;
  }

  function oneOf(value, set) {
    if (typeof value !== "string" || !set.has(value)) refuse();
    return value;
  }

  /** A DATE (whole === true), a UTC (false) or either (undefined). */
  function moment(value, whole) {
    if (typeof value !== "string") refuse();
    const isDate = value.length === 10;
    if (whole !== undefined && whole !== isDate) refuse();
    if ((isDate ? dateMs(value) : utcMs(value)) === null) refuse();
    return value;
  }

  /** An array within its bound, every element present: map() and for…of would not read a hole the same way. */
  function list(value, max) {
    if (!Array.isArray(value) || value.length > max) refuse();
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) refuse();
    }
    return value;
  }

  function address(value) {
    if (!isEmail(value)) refuse();
    return value;
  }

  function checkPerson(value) {
    record(value, PERSON_KEYS);
    return { email: address(value.email), name: personName(value.name) };
  }

  function checkAttendee(value) {
    record(value, ATTENDEE_KEYS);
    return {
      email: address(value.email),
      name: personName(value.name),
      role: oneOf(value.role, ROLES),
      status: oneOf(value.status, STATUSES),
    };
  }

  const checkAttendees = (value) => list(value, 500).map(checkAttendee);
  const checkCategories = (value) => list(value, 50).map((name) => str(name, 1, 255));
  const checkReminder = (value) => (value === null ? null : int(value, 0, 40320));

  function checkZoneChange(value) {
    record(value, ZONE_CHANGE_KEYS);
    return {
      month: int(value.month, 1, 12),
      week: int(value.week, 1, 5),
      weekday: int(value.weekday, 0, 6),
      hour: int(value.hour, 0, 23),
      minute: int(value.minute, 0, 59),
    };
  }

  function checkZonePart(value) {
    record(value, ZONE_PART_KEYS);
    return { bias: int(value.bias, -840, 840), change: value.change === null ? null : checkZoneChange(value.change) };
  }

  function checkZone(value) {
    record(value, ZONE_KEYS);
    const zone = { bias: int(value.bias, -840, 840), standard: checkZonePart(value.standard), daylight: checkZonePart(value.daylight) };
    if ((zone.standard.change === null) !== (zone.daylight.change === null)) refuse();
    const facts = zoneFacts(zone);
    if (Math.abs(facts.std) > 840 || Math.abs(facts.dst) > 840) refuse();
    return zone;
  }

  /** `unsaid`: the user's own answer may be null, "the server does not say" (a put only). */
  function checkMeeting(value, unsaid) {
    record(value, MEETING_KEYS);
    return {
      role: oneOf(value.role, MEETING_ROLES),
      cancelled: bool(value.cancelled),
      responseRequested: bool(value.responseRequested),
      response: unsaid && value.response === null ? null : oneOf(value.response, RESPONSES),
      allowNewTime: bool(value.allowNewTime),
    };
  }

  const leapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  /** The number of days of month 1-12 of a year. */
  const monthLength = (year, month) => (month === 2 && !leapYear(year) ? 28 : MONTH_DAYS[month - 1]);

  /**
   * Is this rule one of the shapes ActiveSync has (rule 2 of
   * src/core/recurrence.mjs)? Thunderbird is given no other: in
   * Thunderbird 140, expanding some of the others never ends.
   *   daily    nothing but days of the week, and those with interval 1
   *   weekly   nothing but days of the week
   *   monthly  a day number, or days of the week with a rank, or neither
   *   yearly   a month with a day number that month can have, or a month
   *            with days of the week and a rank, or neither of them
   */
  function knownShape(rule) {
    const days = rule.byDay.length > 0;
    const ranked = rule.bySetPos !== null;
    switch (rule.freq) {
      case "daily":
        return !ranked && rule.byMonthDay === null && rule.byMonth === null && (!days || rule.interval === 1);
      case "weekly":
        return !ranked && rule.byMonthDay === null && rule.byMonth === null;
      case "monthly":
        if (rule.byMonth !== null) return false;
        return rule.byMonthDay !== null ? !days && !ranked : days === ranked;
      default: // yearly
        if (rule.byMonthDay !== null) return rule.byMonth !== null && !days && !ranked && rule.byMonthDay <= MONTH_DAYS[rule.byMonth - 1];
        return days || ranked ? days && ranked && rule.byMonth !== null : true;
    }
  }

  /**
   * Does the day of a monthly or yearly rule come? `year`, `month` (1-12)
   * and `day`: the first day of the item, as Thunderbird will read it. The
   * rule recurs on a day number (its own, or that of the first day), a
   * yearly one in a month (its own, or that of the first day): that day
   * must exist in one of the first four periods, the month that is 0, 1, 2
   * or 3 intervals after the first one, or that month of the year that is
   * as many intervals later. Thunderbird 140 looks no further, and fails
   * for the whole calendar when it finds none.
   */
  function dayComes(rule, year, month, day) {
    if ((rule.freq !== "monthly" && rule.freq !== "yearly") || rule.byDay.length > 0) return true;
    const wanted = rule.byMonthDay ?? day;
    for (let k = 0; k < 4; k++) {
      if (rule.freq === "yearly") {
        const named = rule.byMonth ?? month;
        if (wanted > MONTH_DAYS[named - 1]) return false;
        if (wanted <= monthLength(year + k * rule.interval, named)) return true;
      } else {
        const index = year * 12 + (month - 1) + k * rule.interval;
        if (wanted <= monthLength(Math.floor(index / 12), (index % 12) + 1)) return true;
      }
    }
    return false;
  }

  /**
   * The Recurrence of an item. `whole`: its first day is a DATE (a whole
   * day, a task); `length`: how long the item is, in milliseconds. Values
   * out of their range make the description invalid; a rule that is well
   * formed but that Thunderbird must not be given is UNSUPPORTED: a shape
   * ActiveSync does not have, an `until` that is not of the kind of the
   * start, an item longer than its own period (its occurrences would pile
   * up without end).
   */
  function checkRecurrence(value, task, whole, length) {
    record(value, RECURRENCE_KEYS);
    const out = {
      freq: oneOf(value.freq, FREQUENCIES),
      interval: int(value.interval, 1, 999),
      count: value.count === null ? null : int(value.count, 1, task ? 255 : 999),
      until: value.until === null ? null : moment(value.until),
      byDay: list(value.byDay, 7).map((day) => oneOf(day, DAY_INDEX)),
      bySetPos: value.bySetPos === null ? null : int(value.bySetPos, -1, 4),
      byMonthDay: value.byMonthDay === null ? null : int(value.byMonthDay, 1, 31),
      byMonth: value.byMonth === null ? null : int(value.byMonth, 1, 12),
      weekStart: value.weekStart === null ? null : oneOf(value.weekStart, DAY_INDEX),
    };
    if (out.count !== null && out.until !== null) refuse();
    if (out.bySetPos === 0 || new Set(out.byDay).size !== out.byDay.length) refuse();
    if (!knownShape(out)) refuse("UNSUPPORTED");
    if (out.until !== null && (out.until.length === 10) !== whole) refuse("UNSUPPORTED");
    if (length > out.interval * PERIOD_DAYS.get(out.freq) * DAY) refuse("UNSUPPORTED");
    return out;
  }

  /** The changes of one occurrence: any of the twelve keys, nothing else. */
  function checkChanges(value, master) {
    if (!plainObject(value)) refuse();
    const allowed = new Set(CHANGE_KEYS);
    const own = new Set(Object.keys(value));
    for (const key of own) {
      if (!allowed.has(key)) refuse();
    }
    const out = {};
    if (own.has("summary")) out.summary = str(value.summary, 0, 1024);
    if (own.has("location")) out.location = str(value.location, 0, 1024);
    if (own.has("description")) out.description = str(value.description, 0, 32768, true);
    const whole = own.has("allDay") ? bool(value.allDay) : master.allDay;
    if (own.has("allDay")) {
      // A change of nature comes with both of its dates.
      if (!own.has("start") || !own.has("end")) refuse();
      out.allDay = whole;
    }
    if (own.has("start")) out.start = moment(value.start, whole);
    if (own.has("end")) out.end = moment(value.end, whole);
    if (own.has("start") && own.has("end") && !ordered(out.start, out.end)) refuse();
    if (own.has("busy")) out.busy = oneOf(value.busy, BUSY);
    if (own.has("privacy")) out.privacy = oneOf(value.privacy, PRIVACY);
    if (own.has("reminder")) out.reminder = checkReminder(value.reminder);
    if (own.has("categories")) out.categories = checkCategories(value.categories);
    if (own.has("attendees")) out.attendees = checkAttendees(value.attendees);
    if (own.has("cancelled")) out.cancelled = bool(value.cancelled);
    return out;
  }

  function checkExceptions(value, master) {
    const seen = new Set();
    return list(value, 256).map((entry) => {
      record(entry, EXCEPTION_KEYS);
      const originalStart = moment(entry.originalStart, master.allDay);
      if (seen.has(originalStart)) refuse();
      seen.add(originalStart);
      const deleted = bool(entry.deleted);
      const changes = checkChanges(entry.changes, master);
      return { originalStart, deleted, changes: deleted ? {} : changes };
    });
  }

  /**
   * `unsaid`: the description comes in a put, where `description` and
   * `meeting.response` may be null for "the server does not say" (applyPut
   * then keeps what is held). Nowhere else, and never in what is stored or
   * returned.
   */
  function checkEvent(value, unsaid) {
    record(value, EVENT_KEYS);
    const allDay = bool(value.allDay);
    const out = {
      kind: "event",
      uid: str(value.uid, 1, 300),
      summary: str(value.summary, 0, 1024),
      location: str(value.location, 0, 1024),
      description: unsaid && value.description === null ? null : str(value.description, 0, 32768, true),
      allDay,
      start: moment(value.start, allDay),
      end: moment(value.end, allDay),
      timezone: value.timezone === null ? null : checkZone(value.timezone),
      busy: oneOf(value.busy, BUSY),
      privacy: oneOf(value.privacy, PRIVACY),
      reminder: checkReminder(value.reminder),
      categories: checkCategories(value.categories),
      organizer: value.organizer === null ? null : checkPerson(value.organizer),
      attendees: checkAttendees(value.attendees),
      meeting: checkMeeting(value.meeting, unsaid),
      recurrence: null,
      exceptions: null,
      stamp: value.stamp === null ? null : moment(value.stamp, false),
      sequence: int(value.sequence, 0, 2147483647),
      readOnly: value.readOnly === null ? null : oneOf(value.readOnly, EVENT_READ_ONLY),
    };
    if (!ordered(out.start, out.end)) refuse();
    if (value.recurrence !== null) out.recurrence = checkRecurrence(value.recurrence, false, allDay, instant(out.end) - instant(out.start));
    out.exceptions = checkExceptions(value.exceptions, out);
    if (out.exceptions.length > 0 && out.recurrence === null) refuse();
    return out;
  }

  /** OrdinalDate, SubOrdinalDate of a task: a short text or nothing (null is nothing). */
  const checkOrdinal = (value) => (value === undefined || value === null ? undefined : str(value, 0, MAX_ORDINAL));

  function checkTask(value, unsaid) {
    record(value, TASK_KEYS, TASK_OPTIONAL_KEYS);
    const out = {
      kind: "task",
      uid: str(value.uid, 1, 300),
      summary: str(value.summary, 0, 1024),
      description: unsaid && value.description === null ? null : str(value.description, 0, 32768, true),
      categories: checkCategories(value.categories),
      privacy: oneOf(value.privacy, PRIVACY),
      start: value.start === null ? null : moment(value.start, true),
      due: value.due === null ? null : moment(value.due, true),
      completed: bool(value.completed),
      completedAt: value.completedAt === null ? null : moment(value.completedAt, false),
      priority: oneOf(value.priority, PRIORITIES),
      reminderAt: value.reminderAt === null ? null : moment(value.reminderAt, false),
      recurrence: null,
      readOnly: value.readOnly === null ? null : oneOf(value.readOnly, TASK_READ_ONLY),
    };
    if (out.start !== null && out.due !== null && instant(out.due) < instant(out.start)) refuse();
    if (out.completed && out.completedAt === null) refuse();
    if (!out.completed) out.completedAt = null;
    if (value.recurrence !== null) {
      // A series needs a first day.
      if (out.start === null && out.due === null) refuse();
      const length = out.start !== null && out.due !== null ? instant(out.due) - instant(out.start) : 0;
      out.recurrence = checkRecurrence(value.recurrence, true, true, length);
    }
    // What the server orders its tasks by: kept with the description, last, and only when said.
    for (const key of TASK_OPTIONAL_KEYS) {
      const ordinal = Object.hasOwn(value, key) ? checkOrdinal(value[key]) : undefined;
      if (ordinal !== undefined) out[key] = ordinal;
    }
    return out;
  }

  /**
   * A description checked whole → { description, json }; a Refusal
   * otherwise. `unsaid`: see checkEvent.
   */
  function checkDescription(value, unsaid = false) {
    if (!plainObject(value)) refuse();
    const kind = Object.hasOwn(value, "kind") ? value.kind : null;
    const description = kind === "event" ? checkEvent(value, unsaid) : kind === "task" ? checkTask(value, unsaid) : refuse();
    const json = JSON.stringify(description);
    if (json.length > MAX_JSON) refuse("TOO_LARGE");
    return { description, json };
  }

  /** SHA-256 of a text (its UTF-16 units), in base64. */
  function digest(text) {
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      bytes[2 * i] = code >> 8;
      bytes[2 * i + 1] = code & 0xff;
    }
    const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hasher.init(Ci.nsICryptoHash.SHA256);
    hasher.update(bytes, bytes.length);
    return hasher.finish(true);
  }

  // ── Time zones ────────────────────────────────────────────────────────
  //
  // A Zone of a description is the content of a Windows time-zone structure:
  // UTC = local time + bias. Its `standard.change` says when standard time
  // begins, in local daylight time; `daylight.change` says when daylight
  // time begins, in local standard time. Without changes, only `bias`
  // counts. The names of the structure never reach this module.

  /** Offsets east of UTC in minutes, and the two changes (null without daylight time). */
  function zoneFacts(zone) {
    const hasChanges = zone.standard.change !== null && zone.daylight.change !== null;
    const std = -(zone.bias + (hasChanges ? zone.standard.bias : 0));
    const dst = hasChanges ? -(zone.bias + zone.daylight.bias) : std;
    if (!hasChanges || dst === std) return { std, dst: std, toDaylight: null, toStandard: null };
    return { std, dst, toDaylight: zone.daylight.change, toStandard: zone.standard.change };
  }

  /** Day of the month of a change in a year: the week-th weekday, 5 meaning the last one. */
  function changeDay(year, change) {
    const first = new Date(Date.UTC(year, change.month - 1, 1)).getUTCDay();
    const days = new Date(Date.UTC(year, change.month, 0)).getUTCDate();
    let day = 1 + ((change.weekday - first + 7) % 7) + (change.week - 1) * 7;
    while (day > days) day -= 7;
    return day;
  }

  /** UTC instant of a change in a year; `before` is the offset in force until then. */
  function changeInstant(year, change, before) {
    return Date.UTC(year, change.month - 1, changeDay(year, change), change.hour, change.minute) - before * MINUTE;
  }

  /** The two changes of a year: [start of daylight time, start of standard time]. */
  function factsChanges(facts, year) {
    return [changeInstant(year, facts.toDaylight, facts.std), changeInstant(year, facts.toStandard, facts.dst)];
  }

  function factsOffset(facts, ms) {
    if (!facts.toDaylight) return facts.std;
    const [toDaylight, toStandard] = factsChanges(facts, new Date(ms).getUTCFullYear());
    if (toDaylight < toStandard) return ms >= toDaylight && ms < toStandard ? facts.dst : facts.std;
    return ms >= toStandard && ms < toDaylight ? facts.std : facts.dst;
  }

  /**
   * Offset east of UTC, in seconds, of a zone of Thunderbird at a local time
   * of that zone (milliseconds whose UTC fields are the local fields). Asked
   * in local time on purpose: Thunderbird's conversion from UTC is not exact
   * in the hours around a change of time.
   */
  function offsetAtLocal(zone, local) {
    const d = new Date(local);
    const dt = cal.createDateTime();
    dt.resetTo(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), zone);
    return dt.timezoneOffset;
  }

  /**
   * The two changes of a year on the wall clock, earliest first: each one
   * with the offsets before and after it, the last local time that is
   * certainly before it and the first one that is certainly after it (an
   * hour is skipped when the clock goes forward, lived twice when it goes
   * back).
   */
  function wallChanges(facts, year) {
    const wall = (change) => Date.UTC(year, change.month - 1, changeDay(year, change), change.hour, change.minute);
    const one = (change, from, to) => {
      const at = wall(change);
      const jump = (to - from) * MINUTE;
      return { from, to, instant: at - from * MINUTE, before: jump > 0 ? at : at + jump, after: jump > 0 ? at + jump : at };
    };
    return [one(facts.toDaylight, facts.std, facts.dst), one(facts.toStandard, facts.dst, facts.std)].sort((a, b) => a.instant - b.instant);
  }

  /**
   * Does a zone of Thunderbird have these offsets and changes during this
   * year? Asked twice a month, at both ends of the year, and two minutes
   * before and after each change (a Windows rule may say 23:59 for
   * midnight).
   */
  function zoneMatches(zone, facts, year) {
    const points = [[Date.UTC(year, 0, 1), null], [Date.UTC(year, 11, 31, 23, 59), null]];
    for (let month = 0; month < 12; month++) points.push([Date.UTC(year, month, 1, 12), null], [Date.UTC(year, month, 15, 12), null]);
    const expected = wallOffsets(facts, year);
    if (facts.toDaylight) {
      const [first, second] = wallChanges(facts, year);
      points.push(
        [first.before - 2 * MINUTE, first.from],
        [first.after + 2 * MINUTE, first.to],
        [second.before - 2 * MINUTE, second.from],
        [second.after + 2 * MINUTE, second.to],
      );
    }
    try {
      return points.every(([local, known]) => {
        const minutes = known ?? expected(local);
        return minutes === null || offsetAtLocal(zone, local) === minutes * 60;
      });
    } catch {
      return false;
    }
  }

  /** local time → the offset the rules give then, in minutes; null in the hour skipped or lived twice. */
  function wallOffsets(facts, year) {
    if (!facts.toDaylight) return () => facts.std;
    const [first, second] = wallChanges(facts, year);
    return (local) => {
      if (local < first.before) return first.from;
      if (local >= second.after) return second.to;
      return local >= first.after && local < second.before ? first.to : null;
    };
  }

  const factsKey = (facts) =>
    [facts.std, facts.dst, ...(facts.toDaylight ? [facts.toDaylight, facts.toStandard] : []).flatMap((c) => Object.values(c))].join(".");

  const offsetName = (minutes) => `${minutes < 0 ? "-" : "+"}${pad(Math.trunc(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`;
  const changeName = (c) => `M${c.month}.${c.week}.${c.weekday}T${pad(c.hour)}${pad(c.minute)}`;

  /**
   * A zone of ours for rules that no zone of Thunderbird's list has: a
   * VTIMEZONE made with Thunderbird's own iCalendar objects from the checked
   * numbers (no text is parsed), which the storage keeps with the item as it
   * does for a zone received in an invitation. Null if it cannot be made, or
   * does not give the expected offsets.
   */
  function customZone(facts, year) {
    try {
      const ICAL = ChromeUtils.importESModule("resource:///modules/calendar/Ical.sys.mjs").default;
      const { CalTimezone } = ChromeUtils.importESModule("resource:///modules/CalTimezone.sys.mjs");
      const origin = 1899; // before the first year a description may hold
      let tzid = `Sync443/UTC${offsetName(facts.std)}`;
      if (facts.toDaylight) tzid += `/${offsetName(facts.dst)}/${changeName(facts.toDaylight)}/${changeName(facts.toStandard)}`;
      const component = new ICAL.Component("vtimezone");
      component.addPropertyWithValue("tzid", tzid);
      const part = (name, change, from, to) => {
        const sub = new ICAL.Component(name);
        const first = change
          ? { year: origin, month: change.month, day: changeDay(origin, change), hour: change.hour, minute: change.minute }
          : { year: origin, month: 1, day: 1, hour: 0, minute: 0 };
        sub.addPropertyWithValue("dtstart", ICAL.Time.fromData({ ...first, second: 0, isDate: false }));
        sub.addPropertyWithValue("tzoffsetfrom", ICAL.UtcOffset.fromSeconds(from * 60));
        sub.addPropertyWithValue("tzoffsetto", ICAL.UtcOffset.fromSeconds(to * 60));
        if (change) {
          const day = `${change.week === 5 ? "-1" : change.week}${DAYS[change.weekday]}`;
          sub.addPropertyWithValue("rrule", ICAL.Recur.fromData({ freq: "YEARLY", bymonth: [change.month], byday: [day] }));
        }
        component.addSubcomponent(sub);
      };
      if (facts.toDaylight) {
        part("standard", facts.toStandard, facts.dst, facts.std);
        part("daylight", facts.toDaylight, facts.std, facts.dst);
      } else {
        part("standard", null, facts.std, facts.std);
      }
      const zone = new CalTimezone(ICAL.Timezone.fromData({ component, tzid }));
      return zoneMatches(zone, facts, year) ? zone : null;
    } catch {
      return null;
    }
  }

  const zoneCache = new Map(); // rules and year → zone of Thunderbird
  const zoneDescriptions = new Map(); // tzid and year → Zone
  const zoneGroups = new Map(); // year → Map(offsets in mid-January and mid-July → ids of Thunderbird's list)
  let knownZones = null; // ids of Thunderbird's list, sorted

  function knownZoneIds() {
    if (!knownZones) {
      const ids = [...cal.timezoneService.timezoneIds].filter((id) => typeof id === "string");
      knownZones = { set: new Set(ids), sorted: ids.sort() };
    }
    return knownZones;
  }

  /**
   * The zones of Thunderbird's list that may have these rules in this year:
   * those with the same offsets in the middle of January and of July (the
   * whole list is asked once per year, then kept), in alphabetical order.
   */
  function candidateZones(facts, year) {
    const [winter, summer] = [Date.UTC(year, 0, 15, 12), Date.UTC(year, 6, 15, 12)];
    let groups = zoneGroups.get(year);
    if (!groups) {
      groups = new Map();
      for (const id of knownZoneIds().sorted) {
        try {
          const zone = cal.timezoneService.getTimezone(id);
          if (!zone) continue;
          const key = `${offsetAtLocal(zone, winter)}/${offsetAtLocal(zone, summer)}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(id);
        } catch {
          // a zone Thunderbird cannot compute is no candidate
        }
      }
      if (zoneGroups.size >= 8) zoneGroups.clear();
      zoneGroups.set(year, groups);
    }
    const expected = wallOffsets(facts, year);
    const [a, b] = [expected(winter), expected(summer)];
    if (a === null || b === null) return knownZoneIds().sorted;
    return groups.get(`${a * 60}/${b * 60}`) ?? [];
  }

  /**
   * The zone of Thunderbird for a Zone of a description, for an item of this
   * year: Thunderbird's default zone when it has these offsets and rules,
   * UTC for UTC, then the first of the preferred zones, then the first of
   * Thunderbird's list in alphabetical order; a zone of ours otherwise, and
   * UTC as the last resort (the instants stay right).
   */
  function zoneFor(zone, year) {
    if (zone === null) return defaultZone();
    const facts = zoneFacts(zone);
    // Rules of years to come are today's: a far year is not asked of every zone of the list (each one would be
    // computed up to it and kept in memory).
    const asked = Math.min(year, new Date().getUTCFullYear() + 5);
    const key = `${factsKey(facts)}@${asked}`;
    const cached = zoneCache.get(key);
    if (cached) return cached;
    const service = cal.timezoneService;
    const usual = defaultZone();
    let found = null;
    if (zoneMatches(usual, facts, asked)) {
      found = usual;
    } else if (!facts.toDaylight && facts.std === 0) {
      found = service.UTC;
    } else {
      const candidates = candidateZones(facts, asked);
      const among = new Set(candidates);
      for (const id of [...PREFERRED_ZONES.filter((name) => among.has(name)), ...candidates]) {
        const candidate = service.getTimezone(id);
        if (candidate && zoneMatches(candidate, facts, asked)) {
          found = candidate;
          break;
        }
      }
    }
    found ??= customZone(facts, asked) ?? service.UTC;
    if (zoneCache.size >= 512) zoneCache.clear();
    zoneCache.set(key, found);
    return found;
  }

  const fixedZone = (std) => ({ bias: -std, standard: { bias: 0, change: null }, daylight: { bias: 0, change: null } });

  /** The change of a description for a local time (milliseconds read as UTC fields). */
  function changeOf(localMs) {
    const d = new Date(localMs);
    const day = d.getUTCDate();
    const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return {
      month: d.getUTCMonth() + 1,
      week: day + 7 > days ? 5 : Math.ceil(day / 7),
      weekday: d.getUTCDay(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    };
  }

  /**
   * The Zone of a zone of Thunderbird for one year, found by asking for its
   * UTC offset along the wall clock of that year: no change, or the two
   * changes of the year. Anything else (a zone that changed its rules that
   * year) is described by the offset `fallback` (minutes), without changes.
   */
  function probeZone(zone, year, fallback) {
    const minutes = (local) => Math.round(offsetAtLocal(zone, local) / 60);
    const points = [];
    for (let month = 0; month < 12; month++) points.push(Date.UTC(year, month, 1, 12), Date.UTC(year, month, 16, 12));
    points.push(Date.UTC(year + 1, 0, 1, 12));
    const offsets = points.map(minutes);
    const changes = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const [from, to] = [offsets[i], offsets[i + 1]];
      if (from === to) continue;
      let [low, high] = [points[i], points[i + 1]]; // the answer changes in ]low, high]
      while (high - low > MINUTE) {
        const middle = low + Math.floor((high - low) / (2 * MINUTE)) * MINUTE;
        if (minutes(middle) === from) low = middle;
        else high = middle;
      }
      // Thunderbird answers with the new offset from the change on when the clock goes forward, and from the
      // start of the hour lived twice when it goes back: the change itself is then that much later on the clock.
      changes.push({ at: to > from ? high : high + (from - to) * MINUTE, from, to });
    }
    if (changes.length === 0) return fixedZone(offsets[0]);
    const [first, second] = changes;
    if (changes.length !== 2 || first.to !== second.from || first.from !== second.to) return fixedZone(fallback);
    const std = Math.min(first.from, first.to);
    const dst = Math.max(first.from, first.to);
    const [toDaylight, toStandard] = first.to === dst ? [first, second] : [second, first];
    return {
      bias: -std,
      standard: { bias: 0, change: changeOf(toStandard.at) },
      daylight: { bias: std - dst, change: changeOf(toDaylight.at) },
    };
  }

  /** The Zone of a zone of Thunderbird for an item of this year; `fallback`: the offset of the item's start, in minutes. */
  function describeZone(zone, year, fallback) {
    if (zone.isUTC) return fixedZone(0);
    const tzid = zone.tzid;
    // Only a zone of Thunderbird's own list is the same for every item that names it.
    const known = typeof tzid === "string" && knownZoneIds().set.has(tzid);
    const key = `${tzid}@${year}`;
    let described = known ? zoneDescriptions.get(key) : undefined;
    if (!described) {
      try {
        described = probeZone(zone, year, fallback);
      } catch {
        described = fixedZone(fallback);
      }
      // A zone with its two changes is the same for the whole year; one described by a single offset is not.
      if (known && described.standard.change !== null) {
        if (zoneDescriptions.size >= 512) zoneDescriptions.clear();
        zoneDescriptions.set(key, described);
      }
    }
    if (Math.abs(described.bias) > 840 || Math.abs(described.bias + described.daylight.bias) > 840) problem("too-large");
    return JSON.parse(JSON.stringify(described));
  }

  /**
   * A date and time of Thunderbird in a zone, for a UTC instant. The local
   * time is worked out here from the rules (`facts`), not by Thunderbird's
   * conversion from UTC; and since the instant is what counts, a zone that
   * does not give it back (an hour lived twice, a rule that differs that
   * day) is not used for this date: it stays in UTC.
   */
  function zonedDateTime(ms, zone, facts) {
    if (zone.isUTC) return utcDateTime(ms);
    const wall = new Date(ms + factsOffset(facts, ms) * MINUTE);
    const dt = cal.createDateTime();
    dt.resetTo(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds(), zone);
    return Math.round(dt.nativeTime / 1000) === ms ? dt : utcDateTime(ms);
  }

  /** Do two Zones give the same offsets and the same changes (to the minute) in this year? */
  function sameZone(a, b, year) {
    const [fa, fb] = [zoneFacts(a), zoneFacts(b)];
    if (fa.std !== fb.std || fa.dst !== fb.dst || !fa.toDaylight !== !fb.toDaylight) return false;
    if (!fa.toDaylight) return true;
    const [ca, cb] = [factsChanges(fa, year), factsChanges(fb, year)];
    return Math.abs(ca[0] - cb[0]) <= MINUTE && Math.abs(ca[1] - cb[1]) <= MINUTE;
  }

  // ── Description → item ────────────────────────────────────────────────

  const mailto = (email) => `mailto:${email}`;

  function attendeeFor(person, { role, partstat, rsvp, resource }) {
    const attendee = new CalAttendee();
    attendee.id = mailto(person.email);
    if (person.name) attendee.commonName = person.name;
    attendee.role = role;
    attendee.userType = resource ? "RESOURCE" : "INDIVIDUAL";
    attendee.participationStatus = partstat;
    attendee.rsvp = rsvp ? "TRUE" : "FALSE";
    return attendee;
  }

  /**
   * The attendees of a meeting on an item (the series or one occurrence),
   * each address once. In a meeting the user was invited to, the user's own
   * attendee carries the user's answer, and is added if the list lacks it:
   * Thunderbird then offers to accept or decline.
   */
  function setAttendees(item, attendees, meeting, own) {
    item.removeAllAttendees();
    const seen = new Set();
    for (const person of attendees) {
      const lower = person.email.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      const mine = meeting.role === "attendee" && lower === own;
      item.addAttendee(
        attendeeFor(person, {
          role: ROLES.get(person.role),
          partstat: mine ? RESPONSES.get(meeting.response) : STATUSES.get(person.status),
          rsvp: meeting.responseRequested,
          resource: person.role === "resource",
        }),
      );
    }
    if (meeting.role === "attendee" && !seen.has(own)) {
      item.addAttendee(
        attendeeFor(
          { email: own, name: "" },
          { role: "REQ-PARTICIPANT", partstat: RESPONSES.get(meeting.response), rsvp: meeting.responseRequested, resource: false },
        ),
      );
    }
  }

  function setReminder(item, minutes) {
    item.clearAlarms();
    if (minutes === null) return;
    const alarm = new CalAlarm();
    alarm.action = "DISPLAY";
    alarm.related = Ci.calIAlarm.ALARM_RELATED_START;
    const offset = cal.createDuration();
    offset.inSeconds = -minutes * 60;
    alarm.offset = offset;
    item.addAlarm(alarm);
  }

  function ruleFor(recurrence) {
    const rule = cal.createRecurrenceRule();
    rule.type = FREQUENCIES.get(recurrence.freq);
    rule.interval = recurrence.interval;
    if (recurrence.count !== null) rule.count = recurrence.count;
    else if (recurrence.until !== null) {
      rule.untilDate = recurrence.until.length === 10 ? dayDateTime(recurrence.until) : utcDateTime(utcMs(recurrence.until));
    }
    const days = recurrence.byDay.map((day) => DAY_INDEX.get(day) + 1); // Thunderbird: 1 = Sunday
    if (days.length === 1 && recurrence.bySetPos !== null) {
      // "The second Tuesday": the form Thunderbird's own dialog writes and reads.
      rule.setComponent("BYDAY", [Math.sign(recurrence.bySetPos) * (8 * Math.abs(recurrence.bySetPos) + days[0])]);
    } else {
      if (days.length > 0) rule.setComponent("BYDAY", days);
      if (recurrence.bySetPos !== null) rule.setComponent("BYSETPOS", [recurrence.bySetPos]);
    }
    if (recurrence.byMonthDay !== null) rule.setComponent("BYMONTHDAY", [recurrence.byMonthDay]);
    if (recurrence.byMonth !== null) rule.setComponent("BYMONTH", [recurrence.byMonth]);
    if (recurrence.weekStart !== null) rule.weekStart = DAY_INDEX.get(recurrence.weekStart);
    return rule;
  }

  /** The dates Thunderbird sets by itself, written last: DTSTAMP, then LAST-MODIFIED (which settles the item). */
  function stampItem(item, stamp) {
    item.setProperty("DTSTAMP", stamp.clone());
    item.setProperty("LAST-MODIFIED", stamp.clone());
  }

  /** What only Thunderbird knows of an item, kept when the item is built again: reminders answered or snoozed. */
  function keepLocalState(from, to) {
    const created = from.getProperty("CREATED");
    if (created) to.setProperty("CREATED", created.clone());
    if (from.alarmLastAck) to.alarmLastAck = from.alarmLastAck.clone();
    for (const [name, value] of from.properties) {
      if (SNOOZE.test(name) && value !== null && value !== undefined) to.setProperty(name, value);
    }
  }

  function buildEvent(d, id, own, existing) {
    const item = new CalEvent();
    item.id = id;
    if (existing) keepLocalState(existing, item);
    if (d.summary) item.title = d.summary;
    if (d.location) item.setProperty("LOCATION", d.location);
    if (d.description) item.setProperty("DESCRIPTION", d.description);
    // A whole day has no zone; a time is in the zone of the series (found once, for the year it starts in).
    // Without a zone in the description, Thunderbird's default zone, with the rules it has that year.
    const zoneIn = (year) => {
      const zone = zoneFor(d.timezone, year);
      return { zone, facts: zoneFacts(d.timezone ?? describeZone(zone, year, 0)) };
    };
    const usual = d.allDay ? null : zoneIn(new Date(utcMs(d.start)).getUTCFullYear());
    const eventDate = (value) => {
      if (value.length === 10) return dayDateTime(value);
      const ms = utcMs(value);
      if (ms === null) refuse(); // worked out here, and after the last year of the contract
      const { zone, facts } = usual ?? zoneIn(new Date(ms).getUTCFullYear());
      return zonedDateTime(ms, zone, facts);
    };
    item.startDate = eventDate(d.start);
    item.endDate = eventDate(d.end);
    // Before the rule is given to Thunderbird: its day must come, counted from the first day as Thunderbird reads it.
    if (d.recurrence !== null && !dayComes(d.recurrence, item.startDate.year, item.startDate.month + 1, item.startDate.day)) refuse("UNSUPPORTED");
    item.setProperty("TRANSP", d.busy === "free" ? "TRANSPARENT" : "OPAQUE");
    item.privacy = PRIVACY.get(d.privacy);
    if (d.meeting.cancelled) item.status = "CANCELLED";
    if (d.sequence > 0) item.setProperty("SEQUENCE", d.sequence);
    setReminder(item, d.reminder);
    item.setCategories(d.categories);
    // An appointment that is not a meeting has neither organizer nor attendees.
    if (d.meeting.role !== "none") {
      const organizer = d.organizer ?? (d.meeting.role === "organizer" ? { email: own, name: "" } : null);
      if (organizer) {
        const chair = new CalAttendee();
        chair.id = mailto(organizer.email);
        if (organizer.name) chair.commonName = organizer.name;
        chair.isOrganizer = true;
        item.organizer = chair;
      }
      setAttendees(item, d.attendees, d.meeting, own);
    }
    const stamp = d.stamp === null ? utcDateTime(Date.now()) : utcDateTime(utcMs(d.stamp));
    if (d.recurrence !== null) {
      const info = new CalRecurrenceInfo(item);
      info.appendRecurrenceItem(ruleFor(d.recurrence));
      item.recurrenceInfo = info;
      for (const exception of d.exceptions) {
        const original = eventDate(exception.originalStart);
        if (exception.deleted) {
          info.removeOccurrenceAt(original);
          continue;
        }
        // The occurrence as the series gives it, then what this one changes.
        const occurrence = info.getOccurrenceFor(original);
        const c = exception.changes;
        if (c.summary !== undefined) occurrence.title = c.summary;
        if (c.location !== undefined) occurrence.setProperty("LOCATION", c.location);
        if (c.description !== undefined) occurrence.setProperty("DESCRIPTION", c.description);
        if (c.start !== undefined || c.end !== undefined) {
          // A date that is not said follows the series: the same start, the same length.
          const start = c.start ?? exception.originalStart;
          const whole = start.length === 10;
          const startMs = instant(start);
          const text = (ms) => (whole ? dayText(ms) : utcText(ms));
          let end = c.end ?? text(startMs + instant(d.end) - instant(d.start));
          // An end worked out from the length of the series may fall after the last year of the contract: the
          // occurrence is then refused, not given another end.
          if (instant(end) === null) refuse();
          if (end.length !== start.length || !ordered(start, end)) end = text(startMs + (whole ? DAY : 0));
          occurrence.startDate = eventDate(start);
          occurrence.endDate = eventDate(end);
        }
        if (c.busy !== undefined) occurrence.setProperty("TRANSP", c.busy === "free" ? "TRANSPARENT" : "OPAQUE");
        if (c.privacy !== undefined) occurrence.privacy = PRIVACY.get(c.privacy);
        if (c.reminder !== undefined) setReminder(occurrence, c.reminder);
        if (c.categories !== undefined) occurrence.setCategories(c.categories);
        if (c.attendees !== undefined && d.meeting.role !== "none") setAttendees(occurrence, c.attendees, d.meeting, own);
        if (c.cancelled !== undefined) occurrence.status = c.cancelled ? "CANCELLED" : d.meeting.cancelled ? "CONFIRMED" : null;
        stampItem(occurrence, stamp);
        info.modifyException(occurrence, true);
      }
    }
    stampItem(item, stamp);
    return item;
  }

  function buildTask(d, id, existing) {
    const item = new CalTodo();
    item.id = id;
    if (existing) keepLocalState(existing, item);
    if (d.summary) item.title = d.summary;
    if (d.description) item.setProperty("DESCRIPTION", d.description);
    if (d.start !== null) item.entryDate = dayDateTime(d.start);
    if (d.due !== null) item.dueDate = dayDateTime(d.due);
    item.privacy = PRIVACY.get(d.privacy);
    item.priority = PRIORITIES.get(d.priority);
    item.setCategories(d.categories);
    if (d.completed) {
      item.completedDate = utcDateTime(utcMs(d.completedAt));
      item.status = "COMPLETED";
      item.percentComplete = 100;
    }
    if (d.reminderAt !== null) {
      const alarm = new CalAlarm();
      alarm.action = "DISPLAY";
      alarm.related = Ci.calIAlarm.ALARM_RELATED_ABSOLUTE;
      alarm.alarmDate = utcDateTime(utcMs(d.reminderAt));
      item.addAlarm(alarm);
    }
    if (d.recurrence !== null) {
      const first = dateMs(d.start ?? d.due);
      const day = new Date(first);
      if (!dayComes(d.recurrence, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())) refuse("UNSUPPORTED");
      const info = new CalRecurrenceInfo(item);
      info.appendRecurrenceItem(ruleFor(d.recurrence));
      item.recurrenceInfo = info;
    }
    stampItem(item, utcDateTime(Date.now()));
    return item;
  }

  /**
   * The last check of a series built from a description, once its shape
   * and its day are known to be sound: Thunderbird expands it over its
   * first four periods, as its views and its reminders will. A rule
   * Thunderbird cannot expand is refused here, where the failure harms
   * nothing: stored, it would make every item of the calendar disappear
   * from the views. Never called on a rule that did not pass knownShape:
   * in Thunderbird 140 such an expansion may not return.
   */
  function expandable(item, recurrence) {
    try {
      const start = item.recurrenceStartDate ?? item.startDate ?? item.entryDate ?? item.dueDate;
      if (!start) return true; // nothing recurs without a first day
      const end = start.clone();
      const span = cal.createDuration();
      span.days = 4 * recurrence.interval * (PERIOD_DAYS.get(recurrence.freq) + 3) + 1;
      end.addDuration(span);
      item.recurrenceInfo.getOccurrenceDates(start, end, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** A new item of Thunderbird for a checked description; `existing` gives its local state. */
  function buildItem(d, id, own, existing) {
    return d.kind === "event" ? buildEvent(d, id, own, existing) : buildTask(d, id, existing);
  }

  // ── Item → description ────────────────────────────────────────────────
  //
  // `previous` is the last synchronized description of the item, if any. A
  // description says more than an item of Thunderbird can hold (the answer
  // "not responded" or "unknown", "tentative" or "away"…): where the item
  // does not contradict it, the previous value is kept, so that describing
  // an item built from a description gives that description back. X-MOZ-*
  // properties are never read into a description.

  const kindOf = (item) => (item.isEvent() ? "event" : item.isTodo() ? "task" : null);

  function bounded(text, max, shorten = false) {
    if (text.length <= max) return text;
    return shorten ? cut(text, max).trimEnd() : problem("too-large");
  }

  function personOf(attendee) {
    const id = attendee?.id;
    if (typeof id !== "string" || !/^mailto:/i.test(id)) return null;
    const email = id.slice(7);
    if (!isEmail(email)) return null;
    return { email, name: bounded(tidy(attendee.commonName, false, false).trim(), 256, true) };
  }

  function categoriesOf(item) {
    const all = item.getCategories();
    if (all.length > 500) problem("too-large");
    const names = all
      .map((name) => bounded(tidy(name).trim(), 255, true))
      .filter((name) => name !== "");
    if (names.length > 50) problem("too-large");
    return names;
  }

  function privacyOf(item) {
    const value = item.privacy;
    if (value === "PRIVATE" || value === "CONFIDENTIAL") return value.toLowerCase();
    return value === null || value === undefined || value === "" || value === "PUBLIC" ? "public" : "private";
  }

  /** Minutes before the start of the first reminder of an event, or null. */
  function reminderOf(item, startMs, endMs) {
    const [alarm] = item.getAlarms();
    if (!alarm) return null;
    let minutes = 0;
    if (alarm.related === Ci.calIAlarm.ALARM_RELATED_ABSOLUTE) {
      if (!alarm.alarmDate) return null;
      minutes = (startMs - msOf(alarm.alarmDate)) / MINUTE;
    } else {
      const seconds = alarm.offset ? alarm.offset.inSeconds : 0;
      const base = alarm.related === Ci.calIAlarm.ALARM_RELATED_END ? endMs : startMs;
      minutes = (startMs - (base + seconds * 1000)) / MINUTE;
    }
    return Number.isFinite(minutes) ? Math.min(40320, Math.max(0, Math.round(minutes))) : null;
  }

  /**
   * The attendees of an item (series or occurrence). `before` holds the
   * attendees of the previous description; `env` the meeting's role and the
   * user's own address.
   */
  function attendeesOf(item, before, env) {
    if (env.role === "none") return [];
    const known = new Map((before ?? []).map((a) => [a.email.toLowerCase(), a.status]));
    const out = [];
    const seen = new Set();
    const listed = item.getAttendees();
    if (listed.length > 5000) problem("too-large"); // far beyond what a description holds, whatever is skipped below
    for (const attendee of listed) {
      const person = personOf(attendee);
      if (!person) continue; // not an address a message can reach
      const lower = person.email.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      const mine = env.role === "attendee" && lower === env.own;
      // The user's own entry was added here if the previous list lacked it.
      if (mine && env.wasAttendee && before && !known.has(lower)) continue;
      const kind = String(attendee.userType ?? "").toUpperCase();
      const part = String(attendee.role ?? "").toUpperCase();
      const role = kind === "RESOURCE" || kind === "ROOM" || part === "NON-PARTICIPANT" ? "resource" : part === "OPT-PARTICIPANT" ? "optional" : "required";
      const was = known.get(lower);
      let status = ANSWERS.get(String(attendee.participationStatus ?? "").toUpperCase());
      // The user's own answer is in `meeting.response`; this entry keeps what the server said.
      if (mine && was !== undefined) status = was;
      status ??= was === "unknown" || was === "not-responded" ? was : "not-responded";
      out.push({ email: person.email, name: person.name, role, status });
    }
    if (out.length > 500) problem("too-large");
    // In the order the previous description gave them (Thunderbird moves an attendee whose answer changes); new ones last.
    if (before) {
      const rank = new Map();
      for (const a of before) if (!rank.has(a.email.toLowerCase())) rank.set(a.email.toLowerCase(), rank.size);
      const place = (a) => rank.get(a.email.toLowerCase()) ?? rank.size;
      out.sort((a, b) => place(a) - place(b));
    }
    return out;
  }

  /**
   * What a series and each of its occurrences have: the twelve values an
   * exception may change. `before` is the same for the previous description.
   */
  function coreOf(item, before, env) {
    const start = item.startDate;
    const end = item.endDate;
    if (!start || !end) problem("too-large");
    const startText = momentOf(start);
    const startMs = instant(startText);
    let endText = momentOf(end);
    if (endText.length !== startText.length) problem("too-large");
    // A whole day ends after it starts; a time ends when it starts at the earliest.
    if (!ordered(startText, endText)) endText = start.isDate ? dayText(startMs + DAY) : startText;
    const opaque = before && before.busy !== "free" ? before.busy : "busy";
    return {
      summary: bounded(tidy(item.title), 1024),
      location: bounded(tidy(item.getProperty("LOCATION")), 1024),
      description: bounded(tidy(item.getProperty("DESCRIPTION"), true), 32768),
      allDay: start.isDate,
      start: startText,
      end: endText,
      busy: String(item.getProperty("TRANSP") ?? "").toUpperCase() === "TRANSPARENT" ? "free" : opaque,
      privacy: privacyOf(item),
      reminder: reminderOf(item, startMs, instant(endText)),
      categories: categoriesOf(item),
      attendees: attendeesOf(item, before?.attendees, env),
      cancelled: String(item.status ?? "").toUpperCase() === "CANCELLED",
    };
  }

  const coreOfDescription = (d) => ({ ...Object.fromEntries(CHANGE_KEYS.slice(0, 11).map((key) => [key, d[key]])), cancelled: d.meeting.cancelled });

  /** The value of a list of numbers of a rule ([] if absent); a Problem if it cannot be read. */
  function component(rule, name) {
    try {
      const values = rule.getComponent(name);
      return Array.isArray(values) ? values : [...values];
    } catch {
      return problem("recurrence");
    }
  }

  /** The Recurrence of a rule of Thunderbird; a Problem if the contract cannot hold it. */
  function recurrenceOf(rule, task, before) {
    const freq = FREQUENCY_NAMES.get(String(rule.type).toUpperCase());
    const interval = rule.interval;
    if (!freq || !Number.isInteger(interval) || interval < 1 || interval > 999) problem("recurrence");
    for (const name of ["BYSECOND", "BYMINUTE", "BYHOUR", "BYWEEKNO", "BYYEARDAY"]) {
      if (component(rule, name).length > 0) problem("recurrence");
    }
    let count = null;
    let until = null;
    if (rule.isByCount) {
      count = rule.count;
      if (!Number.isInteger(count) || count < 1 || count > (task ? 255 : 999)) problem("recurrence");
    } else if (rule.untilDate) {
      try {
        until = momentOf(rule.untilDate);
      } catch {
        problem("recurrence");
      }
    }
    // Days as Thunderbird gives them: 1 to 7 from Sunday, or ±(8 × n + day) for "the n-th".
    const days = component(rule, "BYDAY");
    const positions = component(rule, "BYSETPOS");
    let byDay = [];
    let bySetPos = null;
    if (days.some((v) => !Number.isInteger(v) || v === 0)) problem("recurrence");
    if (days.some((v) => Math.abs(v) > 7)) {
      if (days.length !== 1 || positions.length > 0) problem("recurrence");
      bySetPos = Math.trunc(days[0] / 8);
      byDay = [Math.abs(days[0]) % 8];
    } else {
      byDay = [...new Set(days)].sort((a, b) => a - b);
      if (positions.length > 1 || (positions.length === 1 && byDay.length === 0)) problem("recurrence");
      if (positions.length === 1) bySetPos = positions[0];
    }
    if (byDay.some((v) => v < 1 || v > 7)) problem("recurrence");
    if (bySetPos !== null && !(bySetPos === -1 || (Number.isInteger(bySetPos) && bySetPos >= 1 && bySetPos <= 4))) problem("recurrence");
    const single = (name, max) => {
      const values = component(rule, name);
      if (values.length === 0) return null;
      if (values.length > 1 || !Number.isInteger(values[0]) || values[0] < 1 || values[0] > max) problem("recurrence");
      return values[0];
    };
    const byMonthDay = single("BYMONTHDAY", 31);
    const byMonth = single("BYMONTH", 12);
    let names = byDay.map((v) => DAYS[v - 1]);
    // The same days as before, in the order the previous description gave them.
    if (before && before.byDay.length === names.length && before.byDay.every((day) => names.includes(day))) names = [...before.byDay];
    const first = rule.weekStart;
    if (!Number.isInteger(first) || first < 0 || first > 6) problem("recurrence");
    // Monday is what a rule says when it says nothing.
    const weekStart = first === 1 && (!before || before.weekStart === null) ? null : DAYS[first];
    const described = { freq, interval, count, until, byDay: names, bySetPos, byMonthDay, byMonth, weekStart };
    if (!knownShape(described)) problem("recurrence"); // a shape ActiveSync does not have
    return described;
  }

  /**
   * What a description cannot say of a series although its rule can be
   * written (checkRecurrence, dayComes): an `until` that is not of the kind
   * of the start, an item longer than its period, a day that does not come.
   * `first`: { year, month (1-12), day } of the first day.
   */
  function soundSeries(recurrence, whole, length, first) {
    if (recurrence.until !== null && (recurrence.until.length === 10) !== whole) problem("recurrence");
    if (length > recurrence.interval * PERIOD_DAYS.get(recurrence.freq) * DAY) problem("recurrence");
    if (!dayComes(recurrence, first.year, first.month, first.day)) problem("recurrence");
  }

  /** The rule and the removed dates of a series: { rule, removed } or null; a Problem for RDATE or several rules. */
  function seriesOf(item) {
    const info = item.recurrenceInfo;
    if (!info) return null;
    const rules = [];
    const removed = [];
    for (const entry of info.getRecurrenceItems()) {
      const one = entry.wrappedJSObject ?? entry;
      if (typeof one.getComponent === "function") {
        if (one.isNegative) problem("recurrence");
        rules.push(one);
      } else if (one.date && one.isNegative) {
        removed.push(one.date);
      } else {
        problem("recurrence");
      }
    }
    if (rules.length === 0 && removed.length === 0) return null;
    if (rules.length !== 1) problem("recurrence");
    return { info, rule: rules[0], removed };
  }

  function describeEvent(item, previous, env) {
    const before = previous && previous.kind === "event" ? previous : null;
    const organizer = personOf(item.organizer);
    const role = !organizer ? "none" : organizer.email.toLowerCase() === env.own ? "organizer" : "attendee";
    const scope = { own: env.own, role, wasAttendee: before?.meeting.role === "attendee" };
    const core = coreOf(item, before ? coreOfDescription(before) : null, scope);
    const start = item.startDate;
    const year = Number(core.start.slice(0, 4));

    let timezone;
    if (core.allDay) {
      // A whole day has no zone in Thunderbird: the one it came with, or else the user's (the default zone). Never none.
      timezone = before?.timezone ?? describeZone(defaultZone(), year, 0);
    } else {
      const zone = start.timezone.isFloating ? defaultZone() : start.timezone;
      const anchored = start.timezone.isFloating ? start.getInTimezone(zone) : start;
      timezone = describeZone(zone, year, Math.round(anchored.timezoneOffset / 60));
      if (before?.timezone && sameZone(before.timezone, timezone, year)) timezone = before.timezone;
      else if (before && before.timezone === null && !zone.isUTC && zone.tzid === defaultZone().tzid) timezone = null;
    }

    const sameRole = before?.meeting.role === role;
    const mine = role === "attendee" ? item.getAttendeeById(mailto(env.own)) : null;
    let response = sameRole ? before.meeting.response : "none";
    let responseRequested = sameRole ? before.meeting.responseRequested : role !== "none";
    if (role === "attendee") {
      const kept = sameRole && (response === "none" || response === "not-responded") ? response : "not-responded";
      response = ANSWERS.get(String(mine?.participationStatus ?? "").toUpperCase()) ?? kept;
      if (mine) responseRequested = String(mine.rsvp).toUpperCase() === "TRUE";
    } else if (role === "organizer") {
      const guests = item.getAttendees();
      if (guests.length > 0) responseRequested = guests.some((a) => String(a.rsvp).toUpperCase() === "TRUE");
    }

    let recurrence = null;
    const exceptions = [];
    const series = seriesOf(item);
    if (series) {
      recurrence = recurrenceOf(series.rule, false, before?.recurrence ?? null);
      const length = instant(core.end) - instant(core.start);
      soundSeries(recurrence, core.allDay, length, { year: start.year, month: start.month + 1, day: start.day });
      // What the series gives each of its occurrences, written once: only the dates of an occurrence (always said)
      // and a reminder counted from its own start are its own.
      const given = new Map(CHANGE_KEYS.map((key) => [key, JSON.stringify(core[key])]));
      const changedIds = series.info.getExceptionIds();
      if (series.removed.length + changedIds.length > 512) problem("too-large"); // before any of them is looked at
      const earlier = new Map((before?.exceptions ?? []).map((e) => [e.originalStart, e]));
      const gone = new Set();
      for (const date of series.removed) {
        const originalStart = momentOf(date);
        if (originalStart.length !== core.start.length) problem("recurrence");
        if (gone.has(originalStart)) continue;
        gone.add(originalStart);
        exceptions.push({ originalStart, deleted: true, changes: {} });
      }
      const base = before ? coreOfDescription(before) : null;
      for (const id of changedIds) {
        const originalStart = momentOf(id);
        if (originalStart.length !== core.start.length) problem("recurrence");
        if (gone.has(originalStart)) continue;
        gone.add(originalStart);
        const changed = series.info.getExceptionFor(id);
        const was = earlier.get(originalStart);
        const mineCore = coreOf(changed, base && was && !was.deleted ? { ...base, ...was.changes } : base, scope);
        const originalMs = instant(originalStart);
        const changes = {};
        for (const key of CHANGE_KEYS) {
          // Its dates are always said; the rest only where it differs from what the series gives at that date.
          const plain = key === "reminder" ? JSON.stringify(reminderOf(item, originalMs, originalMs + length)) : given.get(key);
          if (key === "start" || key === "end" || JSON.stringify(mineCore[key]) !== plain) changes[key] = mineCore[key];
        }
        exceptions.push({ originalStart, deleted: false, changes });
      }
      if (exceptions.length > 256) problem("too-large");
      exceptions.sort((a, b) => (a.originalStart < b.originalStart ? -1 : a.originalStart > b.originalStart ? 1 : 0));
    }

    let stamp = null;
    try {
      const stamped = item.getProperty("DTSTAMP");
      if (stamped && !stamped.isDate) stamp = momentOf(stamped);
    } catch {
      stamp = null;
    }
    const sequence = Number.parseInt(String(item.getProperty("SEQUENCE") ?? "0"), 10);
    const uid = env.uid ?? tidy(item.id);
    if (uid.length < 1 || uid.length > 300) problem("too-large");
    return {
      kind: "event",
      uid,
      summary: core.summary,
      location: core.location,
      description: core.description,
      allDay: core.allDay,
      start: core.start,
      end: core.end,
      timezone,
      busy: core.busy,
      privacy: core.privacy,
      reminder: core.reminder,
      categories: core.categories,
      organizer: role === "none" ? null : organizer,
      attendees: core.attendees,
      meeting: {
        role,
        cancelled: core.cancelled,
        responseRequested,
        response,
        allowNewTime: before ? before.meeting.allowNewTime : true,
      },
      recurrence,
      exceptions,
      stamp,
      sequence: Number.isInteger(sequence) && sequence > 0 && sequence <= 2147483647 ? sequence : 0,
      readOnly: before ? before.readOnly : null,
    };
  }

  function describeTask(item, previous, env) {
    const before = previous && previous.kind === "task" ? previous : null;
    const start = item.entryDate ? dayOf(item.entryDate) : null;
    let due = item.dueDate ? dayOf(item.dueDate) : null;
    if (start !== null && due !== null && due < start) due = start;
    const completed = !!item.isCompleted;
    let completedAt = null;
    if (completed) {
      const done = item.completedDate ?? item.getProperty("LAST-MODIFIED") ?? item.getProperty("DTSTAMP");
      completedAt = done ? (done.isDate ? `${momentOf(done)}T00:00:00Z` : momentOf(done)) : utcText(Date.now());
    }
    const priority = Number.parseInt(String(item.priority ?? "0"), 10);
    let reminderAt = null;
    const [alarm] = item.getAlarms();
    if (alarm) {
      let at = null;
      if (alarm.related === Ci.calIAlarm.ALARM_RELATED_ABSOLUTE) at = alarm.alarmDate ? msOf(alarm.alarmDate) : null;
      else {
        const base = alarm.related === Ci.calIAlarm.ALARM_RELATED_END ? item.dueDate : item.entryDate;
        if (base) at = msOf(base.isDate ? base.getInTimezone(defaultZone()) : base) + (alarm.offset ? alarm.offset.inSeconds * 1000 : 0);
      }
      if (at !== null && Number.isFinite(at)) {
        const year = new Date(at).getUTCFullYear();
        if (year < MIN_YEAR || year > MAX_YEAR) problem("too-large");
        reminderAt = utcText(at);
      }
    }
    let recurrence = null;
    const series = seriesOf(item);
    if (series) {
      // A task of a description has no exception: an occurrence changed or removed cannot be said.
      if (series.removed.length > 0 || series.info.getExceptionIds().length > 0) problem("recurrence");
      if (start === null && due === null) problem("recurrence");
      recurrence = recurrenceOf(series.rule, true, before?.recurrence ?? null);
      const first = new Date(dateMs(start ?? due));
      const length = start !== null && due !== null ? dateMs(due) - dateMs(start) : 0;
      soundSeries(recurrence, true, length, { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, day: first.getUTCDate() });
    }
    const uid = env.uid ?? tidy(item.id);
    if (uid.length < 1 || uid.length > 300) problem("too-large");
    const described = {
      kind: "task",
      uid,
      summary: bounded(tidy(item.title), 1024),
      description: bounded(tidy(item.getProperty("DESCRIPTION"), true), 32768),
      categories: categoriesOf(item),
      privacy: privacyOf(item),
      start,
      due,
      completed,
      completedAt,
      priority: priority >= 1 && priority <= 4 ? "high" : priority >= 6 && priority <= 9 ? "low" : "normal",
      reminderAt,
      recurrence,
      readOnly: before ? before.readOnly : null,
    };
    // What the server orders its tasks by is no part of an item of Thunderbird: said again as last synchronized.
    for (const key of TASK_OPTIONAL_KEYS) {
      if (before && typeof before[key] === "string") described[key] = before[key];
    }
    return described;
  }

  /**
   * The description of an item of Thunderbird → { description, problem }:
   * one of them is null. `env`: { own: the mailbox's address in lower case,
   * uid: the item's true UID when its id is one of ours }.
   */
  function describe(item, previous, env) {
    try {
      const description = item.isTodo() ? describeTask(item, previous, env) : describeEvent(item, previous, env);
      if (JSON.stringify(description).length > MAX_JSON) problem("too-large");
      return { description, problem: null };
    } catch (e) {
      if (e instanceof Problem) return { description: null, problem: e.problem };
      throw e;
    }
  }

  /** What is compared to tell whether a change is worth sending: everything but the date Thunderbird stamps. */
  function comparable(description) {
    return description === null ? null : JSON.stringify(description.kind === "event" ? { ...description, stamp: null } : description);
  }

  // ── Journal ───────────────────────────────────────────────────────────
  //
  // One row per item in the inner store's metadata table: a first line with
  // the head (JSON), then the last synchronized description (JSON, or
  // nothing). A head:
  //   n  token (the row's key is META_KEY + n)     i  id of the item
  //   k  "event" | "task"                          u  true UID if i is ours
  //   s  ServerId | null                           c  collection | null
  //   h  digest of the description last applied    p  pending "c"|"m"|"d"|null
  //   r  revision of the item's last change        t  revision handed out
  //   o  operation handed out with t               f  revision last settled
  //   x  detached from the server (kept as a local copy)
  //   q  rank of the pending change among those of the calendar (0 if none)
  //   w  the server rewrote the item while the pending change waited
  //   a  the answer Thunderbird asked to send to the organizer | null
  //   g  revision of the change that answer was asked for (0 if none)
  //   l  the synchronized description is read-only (written with it)
  // The revision of an item only grows, for as long as its row lives: a
  // change id (token.revision) never names two changes. `t` is 0 when
  // nothing of the pending change was handed out; an id at or below `f`
  // names a change that was settled, and is unknown. `w`, `a` and `g` say
  // something of the pending change and go with it.

  function newToken() {
    const token = Services.uuid.generateUUID().toString().toLowerCase().replace(/[^a-f0-9]/g, "");
    if (!TOKEN.test(token)) throw fail("INTERNAL", "identifiant aléatoire inattendu");
    return token;
  }

  const newHead = (id, kind, more) => ({
    n: newToken(),
    i: id,
    k: kind,
    u: null,
    s: null,
    c: null,
    h: null,
    p: null,
    r: 0,
    t: 0,
    o: null,
    f: 0,
    x: false,
    q: 0,
    w: false,
    a: null,
    g: 0,
    l: false,
    ...more,
  });

  /** A head whose pending change is settled: nothing waits, nothing is handed out, and its ids are spent. */
  const settledHead = (head, more) => ({ ...head, p: null, t: 0, o: null, f: head.r, w: false, a: null, g: 0, ...more });

  /** The next revision of an item: one more, never less. */
  const nextRevision = (head) => Math.min(head.r + 1, MAX_REVISION);

  /** A head read from the store, checked; null if it is not one of ours. */
  function parseHead(value) {
    if (typeof value !== "string") return null;
    const end = value.indexOf("\n");
    if (end < 2 || end > 3 * MAX_ITEM_ID) return null;
    let head = null;
    try {
      head = JSON.parse(value.slice(0, end));
    } catch {
      return null;
    }
    const text = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
    const number = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_REVISION;
    if (!plainObject(head) || head.v !== 1 || typeof head.n !== "string" || !TOKEN.test(head.n) || !text(head.i, MAX_ITEM_ID)) return null;
    if ((head.k !== "event" && head.k !== "task") || !(head.u === null || text(head.u, 300))) return null;
    if (!(head.s === null || isItemId(head.s)) || !(head.c === null || isItemId(head.c)) || (head.s !== null && head.c === null)) return null;
    if (!(head.h === null || text(head.h, 64)) || !(head.p === null || head.p === "c" || head.p === "m" || head.p === "d")) return null;
    if (!number(head.r) || !number(head.t) || !(head.o === null || head.o === "add" || head.o === "modify" || head.o === "delete")) return null;
    const { n, i, k, u, s, c, h, p, r, t, o } = head;
    const asked = p !== null && p !== "d" && typeof head.a === "string" && ANSWER_NAMES.has(head.a) && number(head.g) && head.g >= 1 && head.g <= r;
    return {
      n,
      i,
      k,
      u,
      s,
      c,
      h,
      p,
      r,
      t: t <= r ? t : 0,
      o,
      f: number(head.f) && head.f <= r ? head.f : 0,
      x: head.x === true && s === null,
      q: p !== null && number(head.q) ? head.q : 0,
      w: p !== null && head.w === true,
      a: asked ? head.a : null,
      g: asked ? head.g : 0,
      l: head.l === true && s !== null,
    };
  }

  class Journal {
    constructor(store) {
      this.store = store; // the inner storage calendar
      this.heads = new Map(); // item id → head
      this.tokens = new Map(); // token → item id
      this.servers = new Map(); // collection → Map(ServerId → item id)
      this.pending = new Set(); // item ids with a pending change, oldest first
      this.rank = 0; // the last rank given to a pending change
      this.loaded = false;
    }

    load() {
      if (this.loaded) return;
      const stale = [];
      const waiting = [];
      for (const value of this.store.getAllMetaDataValues()) {
        const head = parseHead(value);
        if (!head || this.heads.has(head.i) || this.tokens.has(head.n)) continue;
        // An item added then deleted before anyone read its creation: nothing waits for it. One whose creation
        // was read is kept: the server may have it by now, and its deletion follows the acknowledgement.
        if (head.p === "d" && head.s === null && head.t === 0) stale.push(head);
        else if (head.p !== null) waiting.push(head);
        else this.index(head);
      }
      // The pending changes in the order they were made.
      for (const head of waiting.sort((a, b) => a.q - b.q)) this.index(head);
      this.rank = waiting.reduce((max, head) => Math.max(max, head.q), 0);
      for (const head of stale) this.store.deleteMetaData(META_KEY + head.n);
      this.loaded = true;
    }

    index(head) {
      this.heads.set(head.i, head);
      this.tokens.set(head.n, head.i);
      if (head.s !== null) {
        if (!this.servers.has(head.c)) this.servers.set(head.c, new Map());
        this.servers.get(head.c).set(head.s, head.i);
      }
      if (head.p !== null) this.pending.add(head.i);
    }

    unindex(head, stillPending = false) {
      this.heads.delete(head.i);
      this.tokens.delete(head.n);
      if (head.s !== null) {
        const held = this.servers.get(head.c);
        if (held?.get(head.s) === head.i) held.delete(head.s);
        if (held?.size === 0) this.servers.delete(head.c);
      }
      if (!stillPending) this.pending.delete(head.i);
    }

    head(id) {
      return this.heads.get(id) ?? null;
    }

    byToken(token) {
      const id = this.tokens.get(token);
      return id === undefined ? null : this.head(id);
    }

    byServer(collectionId, serverId) {
      const id = this.servers.get(collectionId)?.get(serverId);
      return id === undefined ? null : this.head(id);
    }

    /** The JSON of the last synchronized description ("" if none). */
    tail(head) {
      const value = this.store.getMetaData(META_KEY + head.n);
      if (typeof value !== "string") return "";
      const end = value.indexOf("\n");
      return end < 0 ? "" : value.slice(end + 1);
    }

    /** The last synchronized description of an item, checked again, or null. */
    synced(head) {
      const json = this.tail(head);
      if (json === "") return null;
      try {
        return checkDescription(JSON.parse(json)).description;
      } catch {
        return null;
      }
    }

    /**
     * Writes a head (a new object: heads are never changed in place).
     * `synced`: a description, null for none, undefined to keep the one stored.
     * The row is read back: Thunderbird's storage deletes the old row, then
     * inserts the new one, and only logs an insertion that failed. A row
     * that is not there as written is an error for the caller, and what
     * this journal knows stays as it was.
     */
    put(given, synced) {
      const old = this.heads.get(given.i);
      // The pending changes are read in the order they were first made: one that stays pending keeps its place.
      const stays = given.p !== null && !!old && old.p !== null;
      const q = given.p === null ? 0 : stays ? old.q : Math.min(this.rank + 1, MAX_REVISION);
      // Whether the item is read-only is said by the synchronized description, and kept beside it in the head:
      // Thunderbird asks at every turn (views, dialogs), and must not make the whole description be read again.
      const l = synced === undefined ? given.l === true && given.s !== null : synced !== null && synced.readOnly !== null && given.s !== null;
      const head = { ...given, q, l };
      const key = META_KEY + head.n;
      const before = this.store.getMetaData(key);
      const json = synced !== undefined ? (synced === null ? "" : JSON.stringify(synced)) : typeof before === "string" && before.includes("\n") ? before.slice(before.indexOf("\n") + 1) : "";
      const row = `${JSON.stringify({ v: 1, ...head })}\n${json}`;
      this.store.setMetaData(key, row);
      if (this.store.getMetaData(key) !== row) {
        // The old row may be gone with the failed write: put back if the storage takes it.
        if (typeof before === "string") {
          try {
            this.store.setMetaData(key, before);
          } catch {
            // nothing more can be done here; the caller is told
          }
        }
        throw new Components.Exception("", Cr.NS_ERROR_FAILURE);
      }
      if (q > this.rank) this.rank = q;
      if (old) this.unindex(old, stays);
      this.index(head);
      return head;
    }

    remove(head) {
      this.store.deleteMetaData(META_KEY + head.n);
      this.unindex(head);
    }
  }

  // ── The provider ──────────────────────────────────────────────────────

  /** What Thunderbird asks to send its scheduling messages: an object that sends nothing. */
  function silentTransport() {
    return {
      QueryInterface: ChromeUtils.generateQI(["calIItipTransport"]),
      scheme: "mailto",
      type: "sync443",
      senderAddress: null,
      // Never reached: canNotify() answers for every method. Nothing is sent
      // from here; Sync443 sends through ActiveSync, after the user's consent.
      sendItems() {
        return true;
      },
    };
  }

  /** Milliseconds on a clock that only goes forward (the settle delay is counted on it). */
  function clock() {
    try {
      return Components.utils.now();
    } catch {
      return Date.now();
    }
  }

  /**
   * The class of our calendars. `shared`: { queue: the operations' queue,
   * changed(calendarId): a user change was recorded, closed: the extension
   * stopped (set at shutdown; calendar objects that outlive it, in an open
   * dialog or in Thunderbird's undo list, then refuse every write) }.
   */
  function providerClass(shared) {
    const OFFLINE_FILTERS =
      Ci.calICalendar.ITEM_FILTER_OFFLINE_CREATED | Ci.calICalendar.ITEM_FILTER_OFFLINE_MODIFIED | Ci.calICalendar.ITEM_FILTER_OFFLINE_DELETED;
    const readOnlyError = () => new Components.Exception("Calendar is readonly", Ci.calIErrors.CAL_IS_READONLY);
    const refused = () => new Components.Exception("", Cr.NS_ERROR_FAILURE);
    const duplicate = () => new Components.Exception("ID already exists for addItem", Ci.calIErrors.DUPLICATE_ID);

    return class Sync443Calendar extends cal.provider.BaseClass {
      constructor() {
        super();
        this.initProviderBase();
        this.store = null; // the inner storage calendar
        this.journal = null;
        this.transport = silentTransport();
        this.asked = new Map(); // item id → the answer Thunderbird asked to send, not recorded yet
        this.touched = new Map(); // item id → when the user last changed it (clock()), while that is recent
        this.access = this.accessManager();
      }

      /**
       * What Thunderbird asks before it lets the user edit an item (its
       * dialogs, the day and week views, cut, reminders): an item whose
       * synchronized description is read-only cannot be modified, nor
       * answered; every other item is as free as in a calendar without
       * access control. The entries are objects of ours, handed over by
       * this calendar's `aclManager`: nothing is registered, and the
       * calendar's own entry (`aclEntry`: who the user is, what may be
       * added or deleted) stays what it is for any calendar of Thunderbird.
       * An entry answers when it is asked, not when it was made:
       * Thunderbird keeps it with the item and with every copy of it.
       * Thunderbird does not ask for everything (a deletion, a move in the
       * month view, a task ticked off): userModify and userDelete refuse
       * those themselves.
       */
      accessManager() {
        const calendar = this;
        const free = { QueryInterface: ChromeUtils.generateQI(["calICalendarACLEntry"]), hasAccessControl: false, userIsOwner: true, userCanAddItems: true, userCanDeleteItems: true };
        const guarded = { QueryInterface: ChromeUtils.generateQI(["calICalendarACLEntry"]), hasAccessControl: true, userIsOwner: false, userCanAddItems: true, userCanDeleteItems: true };
        for (const entry of [free, guarded]) {
          entry.getUserAddresses = () => (calendar.ownAddress ? [calendar.ownAddress] : []);
          entry.getUserIdentities = () => [];
          entry.getOwnerIdentities = () => [];
          entry.refresh = () => {};
        }
        const manager = {
          QueryInterface: ChromeUtils.generateQI(["calICalendarACLManager"]),
          getCalendarEntry(asked, listener) {
            listener?.onOperationComplete(asked, Cr.NS_OK, Ci.calIOperationListener.GET, null, free);
          },
          getItemEntry(item) {
            const id = item?.parentItem?.id ?? item?.id;
            return {
              QueryInterface: ChromeUtils.generateQI(["calIItemACLEntry"]),
              get calendarEntry() {
                return calendar.locked(id) ? guarded : free;
              },
              get userCanModify() {
                return !calendar.locked(id);
              },
              get userCanRespond() {
                return !calendar.locked(id);
              },
              userCanViewAll: true,
              userCanViewDateAndTime: true,
            };
          },
        };
        for (const entry of [free, guarded]) entry.aclManager = manager;
        return manager;
      }

      get aclManager() {
        return this.access;
      }

      /** Is the item with this id one whose synchronized description is read-only? Never throws; in doubt, no. */
      locked(id) {
        try {
          if (typeof id !== "string" || !this.store || shared.closed) return false;
          this.journal.load();
          return this.journal.head(id)?.l === true;
        } catch {
          return false;
        }
      }

      get type() {
        return TYPE;
      }

      get providerID() {
        return null;
      }

      get canRefresh() {
        return false;
      }

      get supportsScheduling() {
        return true;
      }

      getSchedulingSupport() {
        return this;
      }

      /**
       * Thunderbird asks: "do you tell the attendees yourself?" Always: it
       * then sends nothing. The question itself is kept for a REPLY: it
       * comes only when Thunderbird would send the user's answer to the
       * organizer, once the item is changed (not after "Do not send a
       * response", "Add to calendar" or the import of a file).
       */
      canNotify(method, item) {
        try {
          if (method === "REPLY" && item) this.noteAnswer(item);
        } catch {
          // the answer to Thunderbird never depends on it
        }
        return true;
      }

      /**
       * A reply Thunderbird would send: remembered until the next operation
       * of the queue records it with the change it belongs to. Only the
       * answer of the mailbox's own address to a whole event or series; in
       * doubt, nothing is remembered and no reply is asked for.
       */
      noteAnswer(item) {
        if (shared.closed || !this.store || item.recurrenceId || item.parentItem !== item) return;
        const id = item.id;
        const own = this.ownAddress;
        if (typeof id !== "string" || id.length < 1 || id.length > MAX_ITEM_ID || !own) return;
        // The item of a reply carries one attendee: the one who answers.
        const who = item.getAttendees();
        if (who.length !== 1 || String(who[0].id ?? "").toLowerCase() !== mailto(own)) return;
        const answer = ANSWERS.get(String(who[0].participationStatus ?? "").toUpperCase());
        if (!answer) return;
        if (this.asked.size >= MAX_ASKED && !this.asked.has(id)) this.asked.clear();
        this.asked.set(id, answer);
        // Recorded soon, whatever is called next; every operation records what is remembered before anything else.
        shared.queue(() => this.recordAnswers()).catch(() => {});
      }

      /**
       * What Thunderbird asked since the last operation, written with the
       * pending change of each item: the change the user just made. Without
       * a pending change (nothing worth sending was changed) or for a
       * deletion, nothing is kept.
       */
      recordAnswers() {
        if (this.asked.size === 0 || !this.store || shared.closed) return;
        const asked = [...this.asked];
        this.asked.clear();
        this.journal.load();
        for (const [id, answer] of asked) {
          const head = this.journal.head(id);
          if (!head || head.p === null || head.p === "d" || (head.a === answer && head.g === head.r)) continue;
          try {
            this.journal.put({ ...head, a: answer, g: head.r });
          } catch {
            // not recorded: no reply is asked for
          }
        }
      }

      /** A change by the user that is worth sending was just recorded for this item. */
      touch(id) {
        const now = clock();
        if (this.touched.size >= 4 * MAX_ASKED) {
          for (const [key, at] of this.touched) {
            if (!(now - at < SETTLE_MS)) this.touched.delete(key);
          }
        }
        this.touched.set(id, now);
      }

      /** Tells the listeners of onLocalChange again in `ms` milliseconds: a change held back can then be read. */
      recall(ms) {
        shared.later(this.id, ms);
      }

      /**
       * Milliseconds for which a change of this item is still too young to
       * be read as an answer (0: read it now). Thunderbird asks
       * canNotify("REPLY") just after the change: it is read once that had
       * the time to come.
       */
      settling(id) {
        const at = this.touched.get(id);
        if (at === undefined) return 0;
        const age = clock() - at;
        if (age >= 0 && age < SETTLE_MS) return SETTLE_MS - age;
        this.touched.delete(id);
        return 0;
      }

      get id() {
        return super.id;
      }

      set id(value) {
        super.id = value;
        this.open();
      }

      get uri() {
        return super.uri;
      }

      set uri(value) {
        super.uri = value;
        this.open();
      }

      /** The inner store, as soon as the calendar has its id (of our form) and its address. */
      open() {
        if (this.store || !this.mUri || typeof this.mID !== "string" || !CALENDAR_ID.test(this.mID)) return;
        try {
          const file = cal.provider.getCalendarDirectory();
          file.append(STORE_FILE);
          // As Thunderbird's cached calendars set up theirs: never registered,
          // without preferences of its own, and reporting to this calendar.
          const created = Cc["@mozilla.org/calendar/calendar;1?type=storage"].createInstance(Ci.calICalendar);
          created.QueryInterface(Ci.calISyncWriteCalendar);
          created.QueryInterface(Ci.calICalendarProvider);
          // The storage calendar itself, not its XPCOM face: through that face an item id is a narrow string
          // (calICalendar.getItem), and an id with a character above U+00FF, which a sender may choose, would
          // never find its item.
          const store = created.wrappedJSObject ?? created;
          store.uri = Services.io.newFileURI(file);
          store.id = this.mID;
          store.transientProperties = true;
          store.setProperty("relaxedMode", true);
          store.superCalendar = this;
          this.store = store;
          this.journal = new Journal(store);
        } catch {
          // Without its store the calendar stays empty and refuses every write; our functions do not see it.
          this.store = null;
          this.journal = null;
        }
      }

      /** One of our own values, as stored in the preferences. */
      own(name) {
        return super.getProperty(name);
      }

      setOwn(name, value) {
        return super.setProperty(name, value);
      }

      getProperty(name) {
        switch (name) {
          case "cache.supported":
          case "cache.enabled":
          case "cache.always":
          case "requiresNetwork":
          case "capabilities.autoschedule.supported":
          case "capabilities.attachments.supported":
          case "capabilities.timezones.floating.supported":
            return false;
          case "capabilities.privacy.supported":
          case "capabilities.priority.supported":
          case "capabilities.timezones.UTC.supported":
          case "imip.identity.disabled":
            return true;
          case "capabilities.removeModes":
            return [];
          case "capabilities.privacy.values":
            return ["PUBLIC", "CONFIDENTIAL", "PRIVATE"];
          case "capabilities.alarms.actionValues":
            return ["DISPLAY"];
          case "capabilities.alarms.maxCount":
            return 1;
          case "capabilities.categories.maxCount":
            return 50;
          case "refreshInterval":
            return 0;
          case "capabilities.events.supported":
            return this.own(EVENTS) === true;
          case "capabilities.tasks.supported":
            return this.own(TASKS) === true;
          case "organizerId": {
            const email = this.own(ADDRESS);
            return isEmail(email) ? mailto(email) : null;
          }
          case "organizerCN":
          case "imip.identity":
          case "imip.account":
            return null;
          case "itip.transport":
            return this.transport;
        }
        return super.getProperty(name);
      }

      setProperty(name, value) {
        if (FIXED_PROPERTIES.has(name) || String(name).startsWith("sync443.")) return value;
        return super.setProperty(name, value);
      }

      deleteProperty(name) {
        if (FIXED_PROPERTIES.has(name) || String(name).startsWith("sync443.")) return;
        super.deleteProperty(name);
      }

      /** Tells Thunderbird that a value it reads from us changed. */
      announce(name, value, old) {
        this.observers.notify("onPropertyChanged", [this.superCalendar, name, value, old]);
      }

      get ownAddress() {
        const email = this.own(ADDRESS);
        return isEmail(email) ? email.toLowerCase() : "";
      }

      holds(kind) {
        return this.getProperty(kind === "event" ? "capabilities.events.supported" : "capabilities.tasks.supported");
      }

      /** The collection of an item added here: the slot's folder; the main calendar has one per kind, known to the engine. */
      get collectionOfSlot() {
        const slot = this.own(SLOT);
        return slot !== "main" && isItemId(slot) ? slot : null;
      }

      /** The journal, for one operation of the queue; what Thunderbird asked meanwhile is recorded first. */
      loadedJournal() {
        if (!this.store || shared.closed) throw refused();
        this.journal.load();
        this.recordAnswers();
        return this.journal;
      }

      /**
       * The series as it is stored: under this calendar, whatever calendar
       * the caller left on it or on one of its changed occurrences (each
       * keeps a calendar of its own). Thunderbird asks the calendar of an
       * item whether to send its messages: it must be this one.
       */
      claim(series) {
        const mine = (calendar) => !!calendar && (calendar.wrappedJSObject ?? calendar) === this;
        if (!mine(series.calendar)) series.calendar = this.superCalendar;
        const info = series.recurrenceInfo;
        if (!info) return;
        for (const id of info.getExceptionIds()) {
          const occurrence = info.getExceptionFor(id);
          if (occurrence && !mine(occurrence.calendar)) {
            const own = occurrence.clone();
            own.calendar = this.superCalendar;
            info.modifyException(own, true);
          }
        }
      }

      env(head) {
        return { own: this.ownAddress, uid: head?.u ?? undefined };
      }

      // ── What Thunderbird calls ──────────────────────────────────────

      async getItem(id) {
        return this.store ? this.store.getItem(id) : null;
      }

      getItems(itemFilter, count, rangeStart, rangeEnd) {
        if (!this.store) return super.getItems();
        return this.store.getItems(itemFilter & ~OFFLINE_FILTERS, count, rangeStart, rangeEnd);
      }

      addItem(item) {
        return this.adoptItem(item.clone());
      }

      adoptItem(item) {
        return shared.queue(() => this.userAdd(item));
      }

      modifyItem(newItem, oldItem) {
        return shared.queue(() => this.userModify(newItem, oldItem));
      }

      deleteItem(item) {
        return shared.queue(() => this.userDelete(item));
      }

      // ── Changes made by the user ────────────────────────────────────

      async userAdd(item) {
        const journal = this.loadedJournal();
        if (this.readOnly) throw readOnlyError();
        if (!item) throw new Components.Exception("", Cr.NS_ERROR_INVALID_ARG);
        if (!item.isMutable) item = item.clone();
        const parent = item.parentItem;
        const kind = kindOf(parent);
        if (!kind || !this.holds(kind)) throw refused();
        if (parent.id === null || parent.id === undefined) parent.id = cal.getUUID();
        const id = parent.id;
        if (typeof id !== "string" || id.length < 1 || id.length > MAX_ITEM_ID) throw refused();
        const head = journal.head(id);
        // An item of the user is never replaced: an id the calendar holds is refused, as Thunderbird's own
        // storage refuses it (an import then skips the item; an id is chosen by whoever wrote the file). Only an
        // item whose deletion still waits comes back that way: "undo" in Thunderbird.
        if (head?.p !== "d" && (await this.store.getItem(id))) throw duplicate();
        if (parent === item) this.claim(item);
        else if (item.calendar !== this.superCalendar) item.calendar = this.superCalendar;
        // New here, or back after a deletion.
        const next = head
          ? { ...head, k: kind, p: head.s === null ? "c" : "m", r: nextRevision(head), a: null, g: 0 }
          : newHead(id, kind, { c: this.collectionOfSlot, p: "c", r: 1 });
        journal.put(next); // the journal first: a change is never forgotten
        let added = null;
        try {
          added = await this.store.adoptItem(item);
        } catch (e) {
          if (head) journal.put(head);
          else journal.remove(next);
          throw e;
        }
        this.touch(id);
        this.observers.notify("onAddItem", [added]);
        shared.changed(this.id);
        return added;
      }

      async userModify(newItem, oldItem) {
        const journal = this.loadedJournal();
        if (this.readOnly) throw readOnlyError();
        if (!newItem) throw new Components.Exception("", Cr.NS_ERROR_INVALID_ARG);
        const id = newItem.parentItem.id;
        const before = typeof id === "string" ? await this.store.getItem(id) : null;
        if (!before) {
          if (newItem.parentItem !== newItem) throw refused();
          return this.userAdd(newItem);
        }
        const kind = kindOf(before);
        const head = journal.head(id);
        // The series as it will be stored, to tell whether anything a server holds changes.
        let after = newItem;
        if (newItem.parentItem !== newItem) {
          after = before.clone();
          if (!after.recurrenceInfo) throw refused();
          after.recurrenceInfo.modifyException(newItem, false);
        }
        if (kindOf(after) !== kind) throw refused();
        const synced = head ? journal.synced(head) : null;
        const env = this.env(head);
        const was = comparable(describe(before, synced, env).description);
        const now = describe(after, synced, env).description;
        const will = comparable(now);
        // Reminders answered or snoozed, and Thunderbird's own marks, change nothing to send.
        const significant = !head || was === null || will === null || was !== will;
        // A read-only item is not changed here: Thunderbird is told at once, instead of the change being undone
        // later. What only Thunderbird keeps of it (a reminder answered) is still stored.
        if (significant && head?.l) throw readOnlyError();
        let next = null;
        if (significant) {
          // An answer Thunderbird asked to send stays asked for as long as the item says that answer.
          const answers = !!head && head.a !== null && now?.kind === "event" && now.meeting.response === head.a;
          next = head
            ? { ...head, p: head.p === "c" || head.s === null ? "c" : "m", r: nextRevision(head), ...(answers ? {} : { a: null, g: 0 }) }
            : newHead(id, kind, { c: this.collectionOfSlot, p: "c", r: 1 });
          journal.put(next);
        }
        // Stored under this calendar, whatever calendar the caller left on the item: Thunderbird sends its own
        // messages for an item whose calendar does not answer canNotify().
        let stored = newItem;
        const mine = (calendar) => !!calendar && (calendar.wrappedJSObject ?? calendar) === this;
        const strays = (item) => !mine(item.calendar) || (item.recurrenceInfo?.getExceptionIds() ?? []).some((rid) => !mine(item.recurrenceInfo.getExceptionFor(rid)?.calendar));
        if (!mine(newItem.calendar) || strays(newItem.parentItem)) {
          stored = (newItem.parentItem === newItem ? newItem : after).clone();
          this.claim(stored);
        }
        let modified = null;
        try {
          modified = await this.store.modifyItem(stored, oldItem ?? before);
        } catch (e) {
          if (next && head) journal.put(head);
          else if (next) journal.remove(next);
          throw e;
        }
        if (significant) this.touch(id);
        this.observers.notify("onModifyItem", [modified, before]);
        if (significant) shared.changed(this.id);
        return modified;
      }

      async userDelete(item) {
        const journal = this.loadedJournal();
        if (this.readOnly) throw readOnlyError();
        if (!item) throw new Components.Exception("", Cr.NS_ERROR_INVALID_ARG);
        if (item.parentItem !== item) {
          // One occurrence: the series loses that date.
          const series = await this.store.getItem(item.parentItem.id);
          if (!series?.recurrenceInfo || !item.recurrenceId) return null;
          const shorter = series.clone();
          shorter.recurrenceInfo.removeOccurrenceAt(item.recurrenceId);
          await this.userModify(shorter, series);
          return null;
        }
        const id = item.id;
        if (typeof id !== "string") throw refused();
        const head = journal.head(id);
        if (head?.l && head.p !== "d") throw readOnlyError(); // a read-only item is not deleted here either
        const stored = await this.store.getItem(id);
        if (head?.p === "d") return null;
        // Bound to the server, or its creation is on its way there: the deletion waits in the journal.
        const waits = !!head && (head.s !== null || head.t !== 0);
        if (waits) journal.put({ ...head, p: "d", r: nextRevision(head), a: null, g: 0 });
        if (stored) await this.store.deleteItem(stored);
        // Never sent: nothing remains of it.
        if (head && !waits) journal.remove(head);
        this.observers.notify("onDeleteItem", [stored ?? item]);
        if (waits) shared.changed(this.id);
        return null;
      }
    };
  }

  // ── Calendars ─────────────────────────────────────────────────────────

  function readPref(branch, name) {
    try {
      return branch.getStringPref(name, "");
    } catch {
      return "";
    }
  }

  /**
   * { calendar, mailboxId, slot } if this calendar is ours: our type and
   * class, an id of our form, both marks for this extension, a valid slot.
   * Null otherwise.
   */
  function ours(calendar, extensionId, Provider) {
    try {
      if (!calendar || calendar.type !== TYPE) return null;
      const id = calendar.id;
      const m = typeof id === "string" ? CALENDAR_ID.exec(id) : null;
      if (!m) return null;
      const branch = Services.prefs.getBranch(`${REGISTRY}${id}.`);
      if (readPref(branch, OWNER) !== extensionId || readPref(branch, MAILBOX) !== m[1]) return null;
      const provider = calendar.wrappedJSObject;
      if (!(provider instanceof Provider) || !provider.store) return null;
      const slot = provider.own(SLOT);
      if (slot !== "main" && !isItemId(slot)) return null;
      return { calendar: provider, mailboxId: m[1], slot };
    } catch {
      return null;
    }
  }

  /** Every calendar of ours. getCalendars() first: Thunderbird's lookups by id need its list built. */
  function ownCalendars(extensionId, Provider) {
    const out = [];
    for (const calendar of cal.manager.getCalendars()) {
      const mine = ours(calendar, extensionId, Provider);
      if (mine) out.push(mine);
    }
    return out;
  }

  /** Our calendar with this id; NOT_FOUND otherwise (a calendar that is not ours does not exist for us). */
  function ownCalendar(extensionId, Provider, calendarId) {
    calendarIdOf(calendarId);
    const found = ownCalendars(extensionId, Provider).find((c) => c.calendar.id === calendarId);
    if (!found) throw fail("NOT_FOUND", "aucun agenda de l'extension n'a cet identifiant");
    return found.calendar;
  }

  function listCalendars(extensionId, Provider) {
    return ownCalendars(extensionId, Provider)
      .map(({ calendar, mailboxId, slot }) => ({
        calendarId: calendar.id,
        mailboxId,
        slot,
        name: String(calendar.name ?? ""),
        events: calendar.holds("event"),
        tasks: calendar.holds("task"),
      }))
      .sort((a, b) => (a.calendarId < b.calendarId ? -1 : a.calendarId > b.calendarId ? 1 : 0));
  }

  function clearRegistry(calendarId) {
    for (const name of Services.prefs.getChildList(`${REGISTRY}${calendarId}.`)) Services.prefs.clearUserPref(name);
  }

  /** Removes one id from Thunderbird's saved order of calendars. */
  function forgetOrder(calendarId) {
    const order = Services.prefs.getStringPref(SORT_ORDER_PREF, "");
    const kept = order.split(" ").filter((id) => id !== calendarId);
    if (kept.join(" ") !== order) Services.prefs.setStringPref(SORT_ORDER_PREF, kept.join(" "));
  }

  function updateCalendar(calendar, wanted) {
    if (calendar.name !== wanted.name) calendar.name = wanted.name;
    for (const [kind, name, capability] of [
      ["events", EVENTS, "capabilities.events.supported"],
      ["tasks", TASKS, "capabilities.tasks.supported"],
    ]) {
      if (calendar.own(name) !== wanted[kind]) {
        calendar.setOwn(name, wanted[kind]);
        calendar.announce(capability, wanted[kind], !wanted[kind]);
      }
    }
    if (calendar.own(ADDRESS) !== wanted.organizerEmail) {
      const old = calendar.getProperty("organizerId");
      calendar.setOwn(ADDRESS, wanted.organizerEmail);
      calendar.announce("organizerId", calendar.getProperty("organizerId"), old);
    }
  }

  /** Takes back a calendar that could not be created whole: not registered, nothing of it in the preferences. */
  function undoCreation(calendar, id) {
    try {
      if (cal.manager.getCalendars().some((c) => c.id === id)) cal.manager.unregisterCalendar(calendar);
    } catch {
      // the preferences are cleared all the same
    }
    calendar.store = null;
    calendar.journal = null;
    clearRegistry(id);
    forgetOrder(id);
  }

  async function createCalendar(extensionId, Provider, wanted, count) {
    if (count >= MAX_CALENDARS) throw fail("LIMIT", `trop d'agendas (${MAX_CALENDARS} au plus)`);
    // The first free number: no calendar of any kind has this id, and nothing is left of it in the preferences.
    const taken = new Set(cal.manager.getCalendars().map((c) => c.id));
    let id = null;
    for (let n = 1; n <= 9999 && id === null; n++) {
      const candidate = `${TYPE}-${wanted.mailboxId}-${n}`;
      if (!taken.has(candidate) && Services.prefs.getChildList(`${REGISTRY}${candidate}.`).length === 0) id = candidate;
    }
    if (id === null) throw fail("CONFLICT", "aucun identifiant d'agenda libre pour cette boîte");
    const uri = Services.io.newURI(`${TYPE}://${wanted.mailboxId}/${id.slice(id.lastIndexOf("-") + 1)}`);
    const created = cal.manager.createCalendar(TYPE, uri);
    const calendar = created?.wrappedJSObject;
    if (!(calendar instanceof Provider)) throw fail("INTERNAL", "Thunderbird n'a pas créé l'agenda");
    try {
      calendar.id = id;
      // Marked before anything else can fail: whatever is left is ours.
      calendar.setOwn(OWNER, extensionId);
      calendar.setOwn(MAILBOX, wanted.mailboxId);
      calendar.setOwn(SLOT, wanted.slot);
      calendar.setOwn(EVENTS, wanted.events);
      calendar.setOwn(TASKS, wanted.tasks);
      calendar.setOwn(ADDRESS, wanted.organizerEmail);
      calendar.name = wanted.name;
      // Without its store, the calendar would stay in Thunderbird's list empty, refusing everything, and
      // invisible to removeCalendar: it is not registered at all.
      if (!calendar.store) throw fail("INTERNAL", "la base des agendas de l'extension ne s'ouvre pas");
      // A new calendar starts empty. Rows may be left under this id by a calendar that went away without
      // removeCalendar (removed from Thunderbird's list while the extension was disabled, or a removal that
      // was interrupted): items, and a journal that would bind them to the server again.
      await calendar.store.deleteCalendar(calendar.store, null);
      cal.manager.registerCalendar(calendar);
    } catch (e) {
      undoCreation(calendar, id);
      throw internal("création de l'agenda", e);
    }
    if (!ours(calendar, extensionId, Provider)) {
      undoCreation(calendar, id);
      throw fail("INTERNAL", "l'agenda créé n'a pas pu être vérifié");
    }
    return { calendarId: id, created: true };
  }

  async function ensureCalendar(extensionId, Provider, options) {
    const wanted = calendarOptions(options);
    const all = ownCalendars(extensionId, Provider);
    const mine = all.filter((c) => c.mailboxId === wanted.mailboxId && c.slot === wanted.slot);
    if (mine.length > 1) throw fail("CONFLICT", "plusieurs agendas de l'extension pour cet emplacement");
    if (mine.length === 1) {
      updateCalendar(mine[0].calendar, wanted);
      return { calendarId: mine[0].calendar.id, created: false };
    }
    return createCalendar(extensionId, Provider, wanted, all.length);
  }

  async function removeCalendar(extensionId, Provider, calendarId) {
    calendarIdOf(calendarId);
    const found = ownCalendars(extensionId, Provider).find((c) => c.calendar.id === calendarId);
    if (!found) return false;
    const { calendar } = found;
    // Thunderbird's own removal is closed for our calendars (no remove mode): unregistered here, then emptied.
    cal.manager.unregisterCalendar(calendar);
    clearRegistry(calendarId);
    forgetOrder(calendarId);
    const store = calendar.store;
    calendar.store = null;
    calendar.journal = null;
    // Every row of this calendar in the inner store: items and journal. The
    // second argument is read by Thunderbird 140 only.
    await store.deleteCalendar(store, null);
    return true;
  }

  // ── Changes from the server ───────────────────────────────────────────

  function serverChanges(changes) {
    if (!Array.isArray(changes) || changes.length > MAX_CHANGES) {
      throw fail("CONFIG", `liste de modifications invalide (${MAX_CHANGES} au plus)`);
    }
    const operations = new Set(["put", "remove", "detach", "lock"]);
    return changes.map((change) => {
      if (!plainObject(change)) throw fail("CONFIG", "modification invalide");
      const op = change.op;
      if (typeof op !== "string" || !operations.has(op)) throw fail("CONFIG", "opération invalide");
      const keys = new Set(Object.keys(change));
      const expected = op === "put" ? ["op", "collectionId", "serverId", "item"] : ["op", "collectionId", "serverId"];
      if (keys.size !== expected.length || !expected.every((key) => keys.has(key))) throw fail("CONFIG", "modification invalide");
      return {
        op,
        collectionId: itemIdOf(change.collectionId, "identifiant de collection"),
        serverId: itemIdOf(change.serverId, "identifiant d'élément"),
        item: op === "put" ? change.item : null,
      };
    });
  }

  /** The description an item built from `d` gives back: what is kept as synchronized. */
  function canonical(d, item, own) {
    const { description } = describe(item, d, { own, uid: d.uid });
    if (description === null) refuse();
    return description;
  }

  /** A series Thunderbird can expand, or the description is refused (see expandable). */
  function builtItem(d, id, own, existing) {
    const item = buildItem(d, id, own, existing);
    if (d.recurrence !== null && !expandable(item, d.recurrence)) refuse("UNSUPPORTED");
    return item;
  }

  async function applyPut(calendar, journal, change, notes) {
    const { description: said } = checkDescription(change.item, true);
    if (!calendar.holds(said.kind)) refuse("KIND");
    const own = calendar.ownAddress;
    const store = calendar.store;
    let head = journal.byServer(change.collectionId, change.serverId);
    // The description held for this item, read when it is needed only.
    let known;
    const held = () => (known === undefined ? (known = head && head.k === said.kind ? journal.synced(head) : null) : known);
    // What the server does not say (a Change without a body; a version of the protocol that does not give the
    // user's own answer) stays as it is held; on an item that is new here, it is empty, or not answered.
    const d = { ...said };
    if (d.description === null) d.description = held() ? held().description : "";
    if (d.kind === "event" && d.meeting.response === null) {
      d.meeting = { ...d.meeting, response: held() ? held().meeting.response : d.meeting.role === "attendee" ? "not-responded" : "none" };
    }
    const json = JSON.stringify(d);
    if (json.length > MAX_JSON) refuse("TOO_LARGE");
    const hash = digest(json);
    let existing = head && head.p !== "d" ? await store.getItem(head.i) : null;
    if (head && head.p !== null) {
      // The user changed this item meanwhile: only what is known of the server moves. The change stays in the
      // journal, marked in the same write when the server's version is no longer the one it was made from:
      // the engine then lets the server win, and sends nothing for it.
      if (head.k !== d.kind) {
        if (!head.w) journal.put({ ...head, w: true });
      } else if (head.h !== hash) {
        const synced = canonical(d, builtItem(d, head.i, own, null), own);
        journal.put({ ...head, h: hash, w: head.w || comparable(synced) !== comparable(held()) }, synced);
      }
      return;
    }
    if (head && head.h === hash && head.k === d.kind && existing) return; // already there, as described
    if (head && head.k !== d.kind) {
      // An item of another kind under the same ServerId: the old one leaves.
      if (existing) {
        await store.deleteItem(existing);
        notes.push(["onDeleteItem", [existing]]);
      }
      journal.remove(head);
      head = null;
      existing = null;
    }
    // A calendar holds so many items and no more: what would add one is refused, the rest of the batch goes on.
    if (!head && journal.heads.size >= MAX_ITEMS) refuse("LIMIT");
    // The UID never selects a local item: taken, the new item gets an id of ours.
    let id = head ? head.i : d.uid;
    if (!head && (journal.head(id) || (await store.getItem(id)))) id = LOCAL_ID + cal.getUUID();
    const item = builtItem(d, id, own, existing);
    item.calendar = calendar;
    const synced = canonical(d, item, own);
    const base = head ?? newHead(id, d.kind);
    const next = settledHead(base, { k: d.kind, u: id === d.uid ? null : d.uid, s: change.serverId, c: change.collectionId, h: hash, x: false });
    journal.put(next, synced);
    try {
      if (existing) {
        const stored = await store.modifyItem(item, existing);
        notes.push(["onModifyItem", [stored, existing]]);
      } else {
        const stored = await store.adoptItem(item);
        notes.push(["onAddItem", [stored]]);
      }
    } catch (e) {
      journal.put({ ...next, h: null }); // not as described: the next time writes it again
      throw e;
    }
  }

  async function applyRemove(calendar, journal, change, notes) {
    const head = journal.byServer(change.collectionId, change.serverId);
    if (!head) return;
    const existing = await calendar.store.getItem(head.i);
    if (existing) {
      await calendar.store.deleteItem(existing);
      notes.push(["onDeleteItem", [existing]]);
    }
    journal.remove(head);
  }

  /**
   * The item stays in the calendar and is no longer linked to the server: no
   * ServerId, no synchronized description, no pending change (one the user
   * had made is forgotten; an item the user had deleted is simply gone).
   */
  async function applyDetach(calendar, journal, change) {
    const head = journal.byServer(change.collectionId, change.serverId);
    if (!head) return;
    if (head.p === "d") {
      journal.remove(head);
      return;
    }
    journal.put(settledHead(head, { s: null, c: calendar.collectionOfSlot, h: null, x: true }), null);
  }

  /**
   * The server changed the item into something the engine cannot read: the
   * item stays as it is and becomes read-only ("incomplete"), so that
   * nothing made from what is held is ever written back. A change the user
   * had made is then reported with the problem "read-only", and marked as
   * rewritten. The next description of the item replaces it as usual, even
   * one that was applied before.
   */
  async function applyLock(calendar, journal, change) {
    const head = journal.byServer(change.collectionId, change.serverId);
    if (!head) return;
    let synced = journal.synced(head);
    if (!synced) {
      // Nothing known of the server's version: what the item says now stands for it.
      const item = await calendar.store.getItem(head.i);
      synced = item ? describe(item, null, calendar.env(head)).description : null;
      if (!synced || synced.kind !== head.k) throw new Components.Exception("", Cr.NS_ERROR_FAILURE);
    }
    journal.put({ ...head, h: null, w: head.p !== null }, { ...synced, readOnly: "incomplete" });
  }

  async function applyServerChanges(calendar, changes) {
    const list = serverChanges(changes);
    const journal = calendar.loadedJournal();
    const results = [];
    const notes = [];
    for (const change of list) {
      try {
        if (change.op === "put") await applyPut(calendar, journal, change, notes);
        else if (change.op === "remove") await applyRemove(calendar, journal, change, notes);
        else if (change.op === "lock") await applyLock(calendar, journal, change);
        else await applyDetach(calendar, journal, change);
        results.push({ serverId: change.serverId, ok: true });
      } catch (e) {
        results.push({ serverId: change.serverId, ok: false, code: e instanceof Refusal ? e.code : "INTERNAL" });
      }
    }
    // One batch and one "loaded" for the whole pass: views follow each item, reminders are read once.
    if (notes.length > 0) {
      calendar.startBatch();
      try {
        for (const [name, args] of notes) calendar.observers.notify(name, args);
      } finally {
        calendar.endBatch();
      }
      calendar.observers.notify("onLoad", [calendar]);
    }
    return results;
  }

  function serverIds(calendar, collectionId) {
    itemIdOf(collectionId, "identifiant de collection");
    const journal = calendar.loadedJournal();
    return [...(journal.servers.get(collectionId)?.keys() ?? [])];
  }

  // ── Changes from the user ─────────────────────────────────────────────

  const changeId = (head) => `${head.n}.${head.r}`;

  async function readLocalChanges(calendar, options) {
    let max = MAX_CHANGES;
    if (options !== undefined && options !== null) {
      if (!plainObject(options)) throw fail("CONFIG", "options invalides");
      if (options.max !== undefined && options.max !== null) {
        if (!Number.isInteger(options.max) || options.max < 1 || options.max > MAX_CHANGES) {
          throw fail("CONFIG", `nombre de modifications invalide (1 à ${MAX_CHANGES})`);
        }
        max = options.max;
      }
    }
    const journal = calendar.loadedJournal();
    const out = [];
    let wait = 0; // milliseconds until the first change held back can be read
    for (const id of [...journal.pending]) {
      if (out.length >= max) break;
      let head = journal.head(id);
      if (!head || head.p === null) continue;
      const previous = journal.synced(head);
      const base = {
        changeId: changeId(head),
        kind: head.k,
        collectionId: head.c,
        serverId: head.s,
        item: null,
        previous,
        detached: false,
        rewritten: head.w,
        replyAsked: false, // never for a deletion: deleting an invitation is not an answer
      };
      // Deleted, read as such, then put back by the user: nothing is said of it until that deletion is settled.
      if (head.p !== "d" && head.o === "delete" && head.t !== 0) continue;
      if (head.p === "d") {
        if (head.s === null) continue; // its creation is on its way: nothing to say until it is acknowledged
        out.push({ ...base, op: "delete", problem: previous?.readOnly ? "read-only" : null });
        if (head.t !== head.r || head.o !== "delete") journal.put({ ...head, t: head.r, o: "delete" });
        continue;
      }
      const item = await calendar.store.getItem(id);
      if (!item) {
        // The journal was written, the item was not (Thunderbird stopped in between).
        if (head.s === null) journal.remove(head);
        else journal.put(settledHead(head));
        continue;
      }
      const op = head.p === "c" ? "add" : "modify";
      if (op === "modify" && previous?.readOnly) {
        out.push({ ...base, op, problem: "read-only" });
      } else {
        const described = describe(item, previous, calendar.env(head));
        const d = described.description;
        if (op === "modify" && head.t === 0 && d && comparable(d) === comparable(previous)) {
          // Changed, then changed back, and nothing of it is on its way: nothing to send.
          journal.put(settledHead(head));
          continue;
        }
        // Only the user's own answer to someone else's meeting can come with a reply asked by Thunderbird. Such
        // a change is not read while that question may still come: nothing is handed out, and the listeners
        // of onLocalChange are told again when it can be read.
        const answers = d !== null && d.kind === "event" && d.meeting.role === "attendee";
        if (answers) {
          const left = calendar.settling(id);
          if (left > 0) {
            wait = wait === 0 ? left : Math.min(wait, left);
            continue;
          }
          if (calendar.asked.has(id)) {
            calendar.recordAnswers(); // asked while this very call was reading
            head = journal.head(id) ?? head;
          }
        }
        const replyAsked = answers && head.a !== null && head.a === d.meeting.response;
        out.push({ ...base, op, item: d, problem: described.problem, detached: op === "add" && head.x, replyAsked });
      }
      if (head.t !== head.r || head.o !== op) journal.put({ ...head, t: head.r, o: op });
    }
    if (wait > 0) calendar.recall(wait);
    return out;
  }

  /**
   * The change handed out under this id → { head, last, revision }; null
   * if the journal does not know it (any more): never handed out, or
   * settled since. `last` is false for a change read before the one handed
   * out last for the same item.
   */
  function handedOut(journal, id) {
    const { token, revision } = changeIdOf(id);
    const head = journal.byToken(token);
    if (!head || head.p === null || head.o === null || head.t === 0 || revision > head.t || revision <= head.f) return null;
    return { head, last: revision === head.t, revision };
  }

  async function removeRow(calendar, head) {
    const row = await calendar.store.getItem(head.i);
    if (row) {
      await calendar.store.deleteItem(row);
      calendar.observers.notify("onDeleteItem", [row]);
    }
  }

  async function ackLocalChange(calendar, id, options) {
    const journal = calendar.loadedJournal();
    let serverId = null;
    let collectionId = null;
    let item = null;
    if (options !== undefined && options !== null) {
      if (!plainObject(options)) throw fail("CONFIG", "options invalides");
      if (options.serverId !== undefined && options.serverId !== null) serverId = itemIdOf(options.serverId, "identifiant d'élément");
      if (options.collectionId !== undefined && options.collectionId !== null) {
        collectionId = itemIdOf(options.collectionId, "identifiant de collection");
      }
      if (options.item !== undefined && options.item !== null) {
        try {
          item = checkDescription(options.item).description;
        } catch (e) {
          if (e instanceof Refusal) throw fail("CONFIG", "description invalide");
          throw e;
        }
      }
    }
    const given = handedOut(journal, id);
    if (!given) return false;
    let { head } = given;
    if (item && item.kind !== head.k) throw fail("CONFIG", "la description n'est pas du type de l'élément");
    // The UID now synchronized is the one said from here on (a task gets its UID from the engine, not from Thunderbird).
    if (item) head = { ...head, u: item.uid === head.i ? null : item.uid };
    const current = given.last && head.r === head.t; // nothing changed since the change was read
    // An older reading of the same item was a creation or a modification (a deletion read is never read over).
    const acknowledged = given.last ? head.o : head.s === null ? "add" : "modify";

    if (serverId !== null) {
      const collection = head.c ?? collectionId;
      if (collection === null) throw fail("CONFIG", "identifiant de collection requis pour lier cet élément");
      if (collectionId !== null && collectionId !== collection) throw fail("CONFIG", "l'élément appartient à une autre collection");
      if (head.s !== null && head.s !== serverId) throw fail("CONFLICT", "l'élément est déjà lié à un autre identifiant du serveur");
      if (head.s === null) {
        // The copy the server already gave us under this ServerId, if any, leaves: this item is that one.
        const other = journal.byServer(collection, serverId);
        if (other && other.i !== head.i) {
          await removeRow(calendar, other);
          journal.remove(other);
        }
        head = { ...head, s: serverId, c: collection, x: false };
      }
    } else if (acknowledged === "add" && head.s === null) {
      throw fail("CONFIG", "identifiant du serveur requis pour une création");
    }

    // The id acknowledged is spent, with those before it: an acknowledgement that comes twice finds nothing.
    const spent = Math.max(head.f, given.revision);
    // An answer Thunderbird asked to send was part of what is acknowledged, unless it was asked for a later change.
    const asked = head.a !== null && head.g > given.revision ? {} : { a: null, g: 0 };

    if (acknowledged === "delete") {
      if (head.p === "d") {
        await removeRow(calendar, head); // normally gone already
        journal.remove(head);
        return current;
      }
      // Deleted on the server, but back here meanwhile: it is a new item again.
      journal.put({ ...head, s: null, h: null, p: "c", t: 0, o: null, f: Math.max(spent, head.t), w: false, ...asked }, null);
      return false;
    }

    let synced = item ?? undefined;
    if (synced === undefined && current && head.p !== "d") {
      const row = await calendar.store.getItem(head.i);
      synced = (row && describe(row, journal.synced(head), calendar.env(head)).description) ?? undefined;
    }
    if (current) {
      journal.put(settledHead(head, { h: null }), synced);
      return true;
    }
    // Changed again since: what was sent is acknowledged, the rest stays to send. A later reading is still on its way.
    const settled = given.last ? { t: 0, o: null } : {};
    journal.put({ ...head, h: null, p: head.p === "d" ? "d" : "m", f: spent, ...asked, ...settled }, synced);
    return false;
  }

  async function dropLocalChange(calendar, id) {
    const journal = calendar.loadedJournal();
    const given = handedOut(journal, id);
    if (!given || !given.last) return false;
    const { head } = given;
    const store = calendar.store;
    if (head.p === "d" && head.s === null) {
      // Its creation was refused, and the user had deleted it meanwhile.
      journal.remove(head);
      return true;
    }
    if (head.o === "delete" && head.p !== "d") {
      // The deletion was refused, and the user had put the item back meanwhile: what it is now is read next.
      journal.put({ ...head, t: 0, o: null, f: head.t });
      return true;
    }
    if (head.r !== head.t) return false; // changed since it was read: read it again
    const row = head.p === "d" ? null : await store.getItem(head.i);
    if (head.p === "c") {
      // Never synchronized, or a copy the user chose to keep: an item of the user is not deleted because a server
      // would not take it. It stays as it is, detached, with nothing to send; changed again, it is read as an
      // "add" marked detached.
      if (row) journal.put(settledHead(head, { x: true }));
      else journal.remove(head);
      return true;
    }
    const synced = journal.synced(head);
    const settled = settledHead(head);
    if (!synced) {
      // Nothing to restore: a deleted item stays deleted, a modified one stays as it is.
      if (head.p === "d") journal.remove(head);
      else journal.put(settled);
      return true;
    }
    // The last synchronized version comes back.
    const restored = buildItem(synced, head.i, calendar.ownAddress, row);
    restored.calendar = calendar;
    journal.put(settled);
    if (row) {
      const stored = await store.modifyItem(restored, row);
      calendar.observers.notify("onModifyItem", [stored, row]);
    } else {
      const stored = await store.adoptItem(restored);
      calendar.observers.notify("onAddItem", [stored]);
    }
    return true;
  }

  // ── The API ───────────────────────────────────────────────────────────

  return class extends ExtensionCommon.ExtensionAPI {
    queue = serial();
    Provider = null;
    shared = null; // what the calendar objects of this run of the extension share
    registration = false; // attempted
    listeners = new Set();
    announced = new Set();
    timers = new Map(); // calendar id → the timer that tells again once a change held back can be read

    /** A user change was recorded: told once per calendar and per turn of the event loop. */
    changed(calendarId) {
      if (this.announced.has(calendarId)) return;
      this.announced.add(calendarId);
      Services.tm.dispatchToMainThread(() => {
        this.announced.delete(calendarId);
        for (const listener of [...this.listeners]) {
          try {
            listener(calendarId);
          } catch {
            // a context that went away
          }
        }
      });
    }

    /**
     * Tells the listeners again in `ms` milliseconds (a little more): a
     * change held back by readLocalChanges can then be read. One timer for
     * each calendar: the reading it leads to sets the next one if needed.
     */
    later(calendarId, ms) {
      if (this.timers.has(calendarId) || !this.Provider) return;
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      this.timers.set(calendarId, timer);
      timer.initWithCallback(
        () => {
          this.timers.delete(calendarId);
          this.changed(calendarId);
        },
        Math.min(Math.ceil(ms), SETTLE_MS) + 50,
        Ci.nsITimer.TYPE_ONE_SHOT,
      );
    }

    /**
     * When the extension starts ("events": ["startup"] in the manifest):
     * the provider is registered before the background page asks for
     * anything. Calendars of our type that Thunderbird had to replace by
     * disabled stand-ins come back as ours at that moment.
     */
    onStartup() {
      this.register();
    }

    /** Once: at startup, or at the first call if this module was loaded without its startup event. */
    register() {
      if (this.registration) return;
      this.registration = true;
      try {
        cal.manager.getCalendars(); // Thunderbird's list of calendars is built before anything is looked up in it
        const shared = {
          queue: this.queue,
          changed: (calendarId) => this.changed(calendarId),
          later: (calendarId, ms) => this.later(calendarId, ms),
          closed: false,
        };
        const Provider = providerClass(shared);
        cal.manager.registerCalendarProvider(TYPE, Provider);
        this.Provider = Provider;
        this.shared = shared;
      } catch {
        this.Provider = null; // every call answers UNSUPPORTED
      }
    }

    onShutdown(isAppShutdown) {
      this.listeners.clear();
      for (const timer of this.timers.values()) timer.cancel();
      this.timers.clear();
      // Thunderbird is quitting: nothing to undo, and nothing to write in the preferences.
      if (isAppShutdown || !this.Provider) return;
      // The extension stops (disabled, updated, removed) and Thunderbird goes on. A calendar object may outlive
      // it, in an open event dialog or in the undo list: from now on it refuses every write, so that nothing is
      // recorded in a journal the next start of the extension would not know of.
      if (this.shared) this.shared.closed = true;
      this.Provider = null;
      try {
        cal.manager.unregisterCalendarProvider(TYPE, true);
      } catch {
        // already gone
      }
    }

    getAPI(context) {
      const api = this;
      const extensionId = context.extension.id;
      /** An operation: checked when called, run in turn, the context re-checked when its turn comes. */
      const run = (what, task) => {
        checkContext(context);
        return api.queue(async () => {
          checkContext(context);
          api.register();
          const Provider = api.Provider;
          if (!Provider) throw fail("UNSUPPORTED", "le type d'agenda de l'extension n'a pas pu être enregistré dans Thunderbird");
          try {
            return await task(Provider);
          } catch (e) {
            throw internal(what, e);
          }
        });
      };
      const on = (what, calendarId, task) => run(what, (Provider) => task(ownCalendar(extensionId, Provider, calendarId)));

      return {
        sync443Calendar: {
          async listCalendars() {
            return run("liste des agendas", (Provider) => listCalendars(extensionId, Provider));
          },

          async ensureCalendar(options) {
            return run("agenda", (Provider) => ensureCalendar(extensionId, Provider, options));
          },

          async removeCalendar(calendarId) {
            return run("suppression de l'agenda", (Provider) => removeCalendar(extensionId, Provider, calendarId));
          },

          async applyServerChanges(calendarId, changes) {
            return on("modifications du serveur", calendarId, (calendar) => applyServerChanges(calendar, changes));
          },

          async serverIds(calendarId, collectionId) {
            return on("éléments détenus", calendarId, (calendar) => serverIds(calendar, collectionId));
          },

          async readLocalChanges(calendarId, options) {
            return on("modifications locales", calendarId, (calendar) => readLocalChanges(calendar, options));
          },

          async ackLocalChange(calendarId, id, options) {
            return on("acquittement", calendarId, (calendar) => ackLocalChange(calendar, id, options));
          },

          async dropLocalChange(calendarId, id) {
            return on("annulation", calendarId, (calendar) => dropLocalChange(calendar, id));
          },

          onLocalChange: new ExtensionCommon.EventManager({
            context,
            name: "sync443Calendar.onLocalChange",
            register: (fire) => {
              // Only the background page is told.
              if (context.viewType !== "background") return () => {};
              const listener = (calendarId) => fire.async(calendarId);
              api.listeners.add(listener);
              return () => api.listeners.delete(listener);
            },
          }).api(),
        },
      };
    }
  };
})();
