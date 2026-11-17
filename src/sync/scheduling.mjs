// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Meetings: what a local change to an event means for other people, and
 * the messages that follow (docs/CALENDAR-DESIGN.md, "Invitations received"
 * and "Meetings organized by the user"; security rules 21, 23 and 25).
 *
 *   planChange(change, { ownEmail, version })   pure: which flow a local change takes
 *   new Scheduler({ mailbox, records, invitations, confirm, notify, log, now, random, senderName })
 *     .plan(change, { version })                 planChange with the mailbox's own address
 *     .answer({ client, signal, change, plan })  the answer flow: MeetingResponse, then the reply queued
 *     .enqueue({ key, change, plan })            the organize flow, once the server accepted the change
 *     .deliver({ client, signal })               asks the user, then sends what is queued
 *     .notice(name, summary, detail)             a notification of i18n.mjs calendarNotice
 *     .pending(), .clear()
 *
 * Only a local change read from the calendar store ever comes here
 * (sync/pim.mjs): nothing in this module is reachable from a change the
 * server sent, so a change coming from the server never sends anything.
 * Two marks the calendar store puts on a change are read here, on the
 * entry of readLocalChanges itself:
 *  - `rewritten`: the server replaced the item while the change waited.
 *    What the change is compared with is then the server's text, not what
 *    the user saw: nothing is planned, queued or sent from it;
 *  - `replyAsked`: Thunderbird asked whether a reply to the organizer may
 *    be sent, which it does only when the user answered and wants the
 *    organizer told. Without it there is never a reply: a participation
 *    status says how an event is, not what the user did ("Do not send a
 *    response", an event added or imported with a status already in it).
 *
 * Answer flow (the user's own participation status changed on an
 * invitation). No confirmation window: one message at most goes to one
 * person, the organizer, and only when the user answered (`replyAsked`).
 *  1. MeetingResponse (1 accept, 2 tentative, 3 decline), which tells the
 *     server and nobody else: with ActiveSync 14.1 and an event already on
 *     the server, on the calendar item; otherwise on the invitation mail,
 *     when the mailbox's invitation table can name one safely (the most
 *     recent mail it knows for the event's UID that gives the event's
 *     organizer and start: sync/invitations.mjs find). When it cannot,
 *     nothing is sent: the change is an ordinary one (outcome "plain"),
 *     and the user who asked for a reply is told that none left.
 *     When the server refuses, the answer is undone with a notification.
 *  2. The caller binds an event added locally to the calendar item the
 *     server names (CalendarId), and acknowledges the change.
 *  3. If the user answered (`replyAsked`) and the organizer asked for an
 *     answer, one REPLY is queued, to the organizer of the event the user
 *     answered, and to nobody else.
 *
 * Organize flow (the user saved or deleted a meeting whose organizer is
 * the mailbox's own address). The change is synchronized first; then
 * `enqueue` records the messages worked out by planChange, and `deliver`
 * asks the user for each one in Sync443's window (the kind of message, the
 * event's title and start, every recipient):
 *  - Send: one message leaves through SendMail, a copy kept in Sent Items;
 *  - Don't send, a window closed, or a question that fails: nothing is
 *    sent, and the event stays as saved;
 *  - a question nobody answers in time, a message that finds the queue
 *    full, and one that waited more than a day for its question are not
 *    sent either, and the user is told so;
 *  - a refused sending is told in a notification and never retried;
 *  - an uncertain one (the connection was lost after the request left, or
 *    Thunderbird stopped while it was leaving) is told as uncertain and
 *    never sent again.
 * A change gives one message: an invitation, an update or a cancellation.
 * Only when attendees were removed from a meeting that goes on does it
 * give a second one, the cancellation RFC 5546 has for them; each message
 * is asked for and sent once, to all its recipients together.
 *
 * SEQUENCE travels in the description's `sequence`: raised by one for a
 * change that gives an update or a cancellation, and given back to the
 * caller, who stores it with the synchronized description.
 *
 * What is queued is written in the mailbox's record "meetingOutbox" before
 * the change is acknowledged, so that stopping Thunderbird between the two
 * loses no question; an entry is marked before its message leaves, so that
 * no message is ever sent twice. Nothing waits there for ever: an entry
 * older than MAX_WAIT_MS is dropped when the record is loaded and before
 * each delivery, and the whole record goes when the mailbox has no
 * calendar left (clear, called by the engine; and on loading, when the
 * mailbox no longer synchronizes its calendar).
 *
 * What is shown to the user, and what is written to other people, is
 * cleaned where it is shown or written (i18n.mjs cleanLine and itemTitle,
 * core/itip.mjs strictText), whatever cleaning the item went through
 * before.
 */

import { meetingResponseRequest, parseMeetingResponse, sendMailRequest, parseSendMail, topStatus } from "../core/protocol.mjs";
import { itipCalendar, itipMessage, MAX_MEETING_RECIPIENTS } from "../core/itip.mjs";
import { checkEvent } from "../core/calendar-item.mjs";
import * as v from "../core/sanitize.mjs";
import { toHex } from "../core/sha256.mjs";
import { EasError, ERR } from "../transport/client.mjs";
import { t, sendFailureReason, uiLanguage, meetingSubject, meetingText, calendarNotice, itemTitle, cleanLine } from "../i18n.mjs";
import { sendTimeout } from "../send.mjs";

/** Most messages waiting for the user's answer or for their sending. */
export const MAX_OUTBOX = 50;
/** How long a message may wait: older, it is dropped without being asked for or sent (the meeting has moved on). */
export const MAX_WAIT_MS = 24 * 3600 * 1000;
/** What `confirm` answers for a question nobody answered in time. */
export const EXPIRED = "expired";
/** Keys of the changes whose messages were settled lately: a change replayed after a stop is not asked twice. */
const MAX_SETTLED = 200;
/** Changes the user was already told of (see #once): enough for the changes of a few passes. */
const MAX_TOLD = 200;
const BOX = "meetingOutbox";
const MAX_SEQUENCE = 2147483647;
const SEND_MAX_BYTES = 64 * 1024;

/** UserResponse of each answer ([MS-ASCMD] 2.2.3.194). */
const USER_RESPONSES = new Map([["accepted", 1], ["tentative", 2], ["declined", 3]]);
const KINDS = new Set(["invite", "update", "cancel", "accepted", "tentative", "declined"]);
/** Errors after which the request may have reached the server: the message may have left (as in send.mjs). */
const UNCERTAIN = new Set([ERR.NETWORK, ERR.TIMEOUT, ERR.CANCELLED, ERR.BAD_RESPONSE, ERR.TOO_LARGE]);
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,66}[A-Za-z0-9])?$/;

const PLAIN = Object.freeze({ flow: "plain" });
/** Plain, and the user is to be told why nothing was sent (Scheduler.plan tells, once). */
const ORGANIZER_CHANGED = Object.freeze({ flow: "plain", notice: "organizerChanged" });
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const lower = (s) => s.toLowerCase();

// ── planChange ────────────────────────────────────────────────────────────

/** The address of a person of a description, validated, or null. */
const addressOf = (person) => (isRecord(person) ? v.emailAddress(person.email) : null);

/**
 * The attendees a message can be written to: valid addresses only, one
 * entry per address (whatever its case), never one of `excluded` (the
 * organizer and the mailbox's own address, in lower case).
 */
function recipientsOf(attendees, excluded) {
  const out = [];
  const seen = new Set(excluded);
  for (const a of Array.isArray(attendees) ? attendees : []) {
    const email = addressOf(a);
    if (email === null || seen.has(lower(email))) continue;
    seen.add(lower(email));
    out.push({ email, name: typeof a.name === "string" ? a.name : "", role: typeof a.role === "string" ? a.role : "required" });
  }
  return out;
}

/** Who is invited, and how: what an attendee list says to the others, whatever the names and the answers. */
const attendeeKey = (list) => list.map((p) => `${lower(p.email)} ${p.role}`).sort().join("\n");
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Did what the attendees were told of the event itself change (time, recurrence, place, subject, description)? */
function eventChanged(item, previous) {
  for (const field of ["summary", "location", "description", "allDay", "start", "end"]) if (item[field] !== previous[field]) return true;
  if (!same(item.recurrence, previous.recurrence)) return true;
  // The zone alone moves no instant; it moves the days of an all-day event and the occurrences of a series.
  return (item.allDay || item.recurrence !== null) && !same(item.timezone, previous.timezone);
}

const cancelledOccurrence = (x) => Boolean(x) && (x.deleted === true || x.changes?.cancelled === true);

/** Did what the attendees were told of one occurrence change? */
function occurrenceChanged(now, before, excluded) {
  const a = now.changes ?? {};
  const b = before?.changes ?? {};
  for (const field of ["summary", "location", "description", "allDay", "start", "end"]) if (a[field] !== b[field]) return true;
  return attendeeKey(recipientsOf(a.attendees, excluded)) !== attendeeKey(recipientsOf(b.attendees, excluded));
}

/**
 * The occurrences of a series whose change concerns the attendees:
 * → { list: [{ originalStart, cancel, exception }], whole } where `whole`
 * says that an occurrence went back to what the series says (its exception
 * is gone), which only a message about the whole series can tell.
 */
function changedOccurrences(item, previous, excluded) {
  const before = new Map((Array.isArray(previous.exceptions) ? previous.exceptions : []).map((x) => [x.originalStart, x]));
  const list = [];
  const kept = new Set();
  for (const x of Array.isArray(item.exceptions) ? item.exceptions : []) {
    kept.add(x.originalStart);
    const old = before.get(x.originalStart) ?? null;
    if (cancelledOccurrence(x)) {
      if (!cancelledOccurrence(old)) list.push({ originalStart: x.originalStart, cancel: true, exception: x });
    } else if (cancelledOccurrence(old) || occurrenceChanged(x, old, excluded)) {
      list.push({ originalStart: x.originalStart, cancel: false, exception: x });
    }
  }
  let whole = false;
  for (const [originalStart, old] of before) {
    if (!kept.has(originalStart) && (cancelledOccurrence(old) || occurrenceChanged(old, null, excluded))) whole = true;
  }
  return { list, whole };
}

const message = (kind, recipients, occurrence = null, removed = false) => Object.freeze({ kind, recipients: Object.freeze(recipients), occurrence, removed });

/**
 * Which flow a local change takes. Pure: no clock, no storage, no network.
 *
 * `change`: one entry of the calendar store's readLocalChanges, whole
 * ({ op, kind, serverId, item, previous, detached, problem, rewritten,
 * replyAsked }); `ownEmail`: the mailbox's own address; `version`: "12.1",
 * "14.0" or "14.1".
 *
 * → { flow: "plain" }
 *     nothing to tell anyone: the change is only synchronized. With
 *     `notice: "organizerChanged"` when messages would have followed, had
 *     the change not replaced the organizer (see below).
 * → { flow: "answer", response: "accepted" | "tentative" | "declined", userResponse: 1 | 2 | 3,
 *     target: "item" | "mail", reply: boolean, organizer: { email, name } }
 *     the user's own status changed on an event of someone else's that is
 *     on the server, or such an event was added with a status. `target`:
 *     where MeetingResponse is sent, the calendar item (14.1, event on the
 *     server) or the invitation mail. `reply`: one REPLY goes to the
 *     organizer. It is true only when `change.replyAsked === true` (the
 *     user answered in Thunderbird, and did not choose "Do not send a
 *     response") and the organizer asked for an answer; a status alone,
 *     whatever it says, never makes a reply.
 * → { flow: "organize", messages: [{ kind: "invite" | "update" | "cancel",
 *     recipients: [{ email, name, role }], occurrence: UTC | DATE | null, removed: boolean }] }
 *     the user changed a meeting whose organizer is `ownEmail`. One
 *     message; a second one (kind "cancel", `removed` true) only for the
 *     attendees removed from a meeting that goes on. `occurrence`: the
 *     original start of the one occurrence the message is about, null for
 *     the whole event. A delete takes its recipients from `previous`.
 * → { flow: "refuse", reason: "attendees", count }
 *     a message would have more than MAX_MEETING_RECIPIENTS recipients: the
 *     change is refused before anything is sent.
 *
 * Recipients are the event's attendees as validated addresses, each one
 * once; the organizer and the mailbox's own address are never among them.
 * A change that only touches a reminder, a category, the free/busy status
 * or the privacy gives no message. A task, a change with a `problem`, and
 * an item that was detached from the server (sent as a new item) never
 * take the answer flow.
 *
 * Two changes are plain whatever they hold:
 *  - a change marked `rewritten`: the server replaced the item while the
 *    change waited, so `previous` is the server's text. An answer read
 *    from it, or attendees "removed" since it, would be the server's
 *    doing, not the user's;
 *  - a `modify` whose organizer is not the one of `previous` (another
 *    address, or none any more for someone else's meeting): an update
 *    accepted from a mail can replace the organizer, and the messages
 *    that follow would go to the attendees, or to the organizer, that
 *    mail chose. Nothing is sent; `notice` says so when the event has
 *    attendees.
 * One case is the user's own doing and is not that: the user's own meeting
 * (`previous`) left without an organizer, as Thunderbird leaves an event
 * whose attendees were all removed. It gives one cancellation, to the
 * attendees of `previous`, written from `previous` (see enqueue).
 */
export function planChange(change, { ownEmail, version } = {}) {
  const own = v.emailAddress(ownEmail);
  if (own === null || !isRecord(change) || change.kind !== "event" || change.problem) return PLAIN;
  if (change.rewritten === true) return PLAIN;
  const { op } = change;
  const item = isRecord(change.item) ? change.item : null;
  const previous = isRecord(change.previous) ? change.previous : null;
  const source = op === "delete" ? previous : item;
  if (!["add", "modify", "delete"].includes(op) || source === null) return PLAIN;

  const organizer = addressOf(source.organizer);
  if (op === "modify" && previous !== null) {
    const before = addressOf(previous.organizer);
    if (before !== null && (organizer === null || lower(before) !== lower(organizer))) {
      if (organizer === null && lower(before) === lower(own)) {
        // The user's own meeting is a meeting no more: Thunderbird drops the organizer of an event whose
        // attendees were all removed. Those who were invited are told that it is cancelled for them, from
        // the meeting as they knew it (`previous`), if the user agrees.
        const gone = recipientsOf(previous.attendees, [lower(own)]);
        if (!gone.length || previous.meeting?.cancelled === true) return PLAIN;
        // Only that: nobody left in the event, and the event still the one they were invited to. Anything
        // else that lost its organizer is not the user removing the attendees, and sends nothing.
        const sameEvent = ["summary", "start", "end", "allDay"].every((field) => item[field] === previous[field]) && same(item.recurrence, previous.recurrence);
        if (recipientsOf(item.attendees, [lower(own)]).length || !sameEvent) return ORGANIZER_CHANGED;
        if (gone.length > MAX_MEETING_RECIPIENTS) return Object.freeze({ flow: "refuse", reason: "attendees", count: gone.length });
        return Object.freeze({ flow: "organize", messages: Object.freeze([message("cancel", gone)]) });
      }
      const people = recipientsOf(previous.attendees, []).length + recipientsOf(item.attendees, []).length;
      return people ? ORGANIZER_CHANGED : PLAIN;
    }
  }
  if (organizer === null) return PLAIN;
  const mine = lower(organizer) === lower(own);
  const excluded = [lower(own), lower(organizer)];

  if (!mine) {
    // Someone else's meeting: the only thing to tell is the user's own answer.
    if (op === "delete" || change.detached === true) return PLAIN;
    // An event added with a status already in it, without Thunderbird asking to reply ("Add to calendar" on a
    // published event, an imported file): the status is what the sender wrote, not an answer. A plain Add.
    if (op === "add" && change.replyAsked !== true) return PLAIN;
    const response = isRecord(item.meeting) ? item.meeting.response : null;
    const userResponse = USER_RESPONSES.get(response);
    if (userResponse === undefined) return PLAIN;
    if (op === "modify") {
      if (previous === null || !isRecord(previous.meeting) || previous.meeting.response === response) return PLAIN;
      if (typeof change.serverId !== "string") return PLAIN;
    }
    return Object.freeze({
      flow: "answer",
      response,
      userResponse,
      target: version === "14.1" && op === "modify" ? "item" : "mail",
      // The user's own answer, never a status alone: Thunderbird asked to send it, and the organizer wants it.
      reply: change.replyAsked === true && item.meeting.responseRequested === true,
      organizer: Object.freeze({ email: organizer, name: typeof source.organizer.name === "string" ? source.organizer.name : "" }),
    });
  }

  // The user's own meeting.
  const current = recipientsOf(source.attendees, excluded);
  const messages = [];
  if (op === "add") {
    if (current.length && source.meeting?.cancelled !== true) messages.push(message("invite", current));
  } else if (op === "delete") {
    if (current.length && source.meeting?.cancelled !== true) messages.push(message("cancel", current));
  } else if (previous === null) {
    // Nothing to compare with: the attendees are told, if the user agrees.
    if (current.length) messages.push(message("update", current));
  } else {
    // (The organizer of `previous`, when it has one, is the user too: see above.)
    const wasMine = addressOf(previous.organizer) !== null && lower(addressOf(previous.organizer)) === lower(own);
    const before = wasMine ? recipientsOf(previous.attendees, excluded) : [];
    const now = new Set(current.map((p) => lower(p.email)));
    const removed = before.filter((p) => !now.has(lower(p.email)));
    if (item.meeting?.cancelled === true) {
      // Cancelled as a whole: one cancellation, for everyone who knew of the meeting.
      const all = [...current, ...removed];
      if (previous.meeting?.cancelled !== true && all.length) messages.push(message("cancel", all));
    } else if (!current.length) {
      if (removed.length) messages.push(message("cancel", removed, null, true));
    } else if (!before.length) {
      messages.push(message("invite", current));
    } else {
      const occurrences = changedOccurrences(item, previous, excluded);
      const whole = eventChanged(item, previous) || attendeeKey(current) !== attendeeKey(before) || occurrences.whole || previous.meeting?.cancelled === true;
      if (whole || occurrences.list.length > 1) {
        messages.push(message("update", current));
      } else if (occurrences.list.length === 1) {
        const [one] = occurrences.list;
        const invited = recipientsOf(one.exception.changes?.attendees, excluded);
        messages.push(message(one.cancel ? "cancel" : "update", invited.length ? invited : current, one.originalStart));
      }
      if (removed.length) messages.push(message("cancel", removed, null, true));
    }
  }
  if (!messages.length) return PLAIN;

  // An update of the whole event lists the attendees of each changed occurrence too.
  let most = Math.max(...messages.map((m) => m.recipients.length));
  for (const x of Array.isArray(source.exceptions) ? source.exceptions : []) most = Math.max(most, recipientsOf(x?.changes?.attendees, []).length);
  if (most > MAX_MEETING_RECIPIENTS) return Object.freeze({ flow: "refuse", reason: "attendees", count: most });
  return Object.freeze({ flow: "organize", messages: Object.freeze(messages) });
}

/**
 * Whether a change that is an answer changes nothing else: the user's own
 * answer aside (meeting.response, the attendees' statuses, the stamp and
 * the sequence), `item` says what `previous` said. Such a change needs no
 * Change command once MeetingResponse was accepted.
 */
export function onlyAnswer(item, previous) {
  if (!isRecord(item) || !isRecord(previous)) return false;
  const strip = (e) => ({
    ...e,
    stamp: null,
    sequence: 0,
    meeting: { ...e.meeting, response: "" },
    attendees: (Array.isArray(e.attendees) ? e.attendees : []).map((a) => ({ ...a, status: "" })),
  });
  return same(strip(item), strip(previous));
}

// ── Texts ─────────────────────────────────────────────────────────────────

/** Why the server refused a SendMail: its status ([MS-ASCMD] 2.2.2, common status codes), as in send.mjs. */
function statusReason(status) {
  switch (status) {
    case "107":
      return t("sendStatus107");
    case "110":
      return t("sendStatus110");
    case "111":
      return t("sendStatus111");
    case "113":
      return t("sendStatus113");
    case "114":
      return t("sendStatus114");
    case "115":
      return t("sendStatus115");
    case "116":
      return t("sendStatus116");
    case "118":
      return t("sendStatus118");
    case "119":
      return t("sendStatus119");
    case "120":
      return t("sendStatus120");
    case "122":
      return t("sendStatus122");
    default:
      return t("sendStatusOther");
  }
}

/** A refusal by its status: a sentence that ends with a full stop. */
const refusedReason = (status, reason = t("sendStatusOther")) => t("sendReasonRefused", reason, status);

/** The reason of a failure of the client, chosen by its code; never free text from an unknown error. */
function failureReason(e) {
  const code = typeof e?.code === "string" && /^[A-Z_]{2,20}$/.test(e.code) ? e.code : "";
  return sendFailureReason(code, e);
}

/**
 * When an event starts, for the plain-text part: the day in full, and the
 * time with its zone. `utc`: the time is given in UTC, and marked as such,
 * instead of in the computer's time zone: a reply goes to an address the
 * sender of an invitation chose, and tells it nothing of where the user's
 * computer is.
 */
function whenText(start, allDay, utc = false) {
  try {
    const time = Date.parse(allDay ? `${start}T00:00:00Z` : start);
    const options = allDay ? { dateStyle: "full", timeZone: "UTC" } : { dateStyle: "full", timeStyle: "long", ...(utc ? { timeZone: "UTC" } : {}) };
    const text = new Intl.DateTimeFormat(uiLanguage(), options).format(new Date(time));
    // Marked as UTC whatever the language calls it.
    return utc && !allDay && !/UTC|GMT/.test(text) ? `${text} (UTC)` : text;
  } catch {
    return String(start);
  }
}

/** Start and kind of what a message is about: the occurrence it names, or the event. */
function subjectOf(event, occurrence) {
  if (occurrence !== null) {
    const x = (Array.isArray(event.exceptions) ? event.exceptions : []).find((e) => e.originalStart === occurrence);
    const allDay = typeof x?.changes?.allDay === "boolean" ? x.changes.allDay : event.allDay;
    if (typeof x?.changes?.start === "string") return { start: x.changes.start, allDay, summary: x.changes.summary ?? event.summary, location: x.changes.location ?? event.location };
    return { start: occurrence, allDay: event.allDay, summary: x?.changes?.summary ?? event.summary, location: x?.changes?.location ?? event.location };
  }
  return { start: event.start, allDay: event.allDay, summary: event.summary, location: event.location };
}

// ── Outbox ────────────────────────────────────────────────────────────────

/** One stored entry, checked like anything read back from storage; null when it cannot be used. */
function checkEntry(raw, ownEmail) {
  if (!isRecord(raw) || typeof raw.key !== "string" || raw.key.length < 1 || raw.key.length > 400) return null;
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind)) return null;
  const reply = USER_RESPONSES.has(raw.kind);
  if (!Array.isArray(raw.recipients) || raw.recipients.length < 1 || raw.recipients.length > MAX_MEETING_RECIPIENTS) return null;
  if (reply && raw.recipients.length !== 1) return null;
  const recipients = [];
  for (const p of raw.recipients) {
    const email = addressOf(p);
    if (email === null) return null;
    recipients.push({ email, name: typeof p.name === "string" ? p.name : "", role: typeof p.role === "string" ? p.role : "required" });
  }
  let event;
  try {
    event = checkEvent(raw.event);
  } catch {
    return null;
  }
  const organizer = addressOf(event.organizer);
  if (organizer === null) return null;
  // Rule 25: the organizer of a message the user organizes is the mailbox's own address; a reply goes to the organizer only.
  if (reply ? lower(recipients[0].email) !== lower(organizer) : lower(organizer) !== lower(ownEmail)) return null;
  if (!Number.isInteger(raw.sequence) || raw.sequence < 0 || raw.sequence > MAX_SEQUENCE) return null;
  const occurrence = typeof raw.occurrence === "string" && raw.occurrence.length <= 20 ? raw.occurrence : null;
  return {
    key: raw.key,
    kind: raw.kind,
    recipients,
    occurrence,
    event,
    sequence: raw.sequence,
    state: raw.state === "sending" ? "sending" : "new",
    at: Number.isFinite(raw.at) ? raw.at : 0,
  };
}

function cancelled() {
  return new EasError(ERR.CANCELLED, "Envoi annulé.");
}

/** Whether an entry is the user's reply to an organizer (sent without a question), not a message of the organize flow. */
const isReply = (entry) => USER_RESPONSES.has(entry.kind);

export class Scheduler {
  #mailbox;
  #own;
  #records;
  #invitations;
  #confirm;
  #notify;
  #log;
  #now;
  #random;
  #senderName;
  #box = null; // { entries, settled }
  #boxQueue = Promise.resolve();
  #delivery = Promise.resolve();
  #told = new Set(); // changes the user was told of already (see #once)

  /**
   * @param {object} o
   * @param {object} o.mailbox       checked mailbox (store.mjs): id, email, sync
   * @param {object} o.records       store.mailbox(id)
   * @param {object} o.invitations   sync/invitations.mjs InvitationTable of the mailbox ({ find, forget })
   * @param {(q: {kind, summary, start, allDay, recipients, from}) => Promise<boolean | "expired">} o.confirm
   *        asks the user in Sync443's window; true for Send, "expired" (EXPIRED) when nobody answered in time,
   *        anything else (or a rejection) for Don't send.
   *        kind: "invite" | "update" | "cancel"; summary: the title ("" when none); start: UTC, or DATE when
   *        allDay; recipients: 1 to 100 validated addresses; from: the address of the mailbox that sends.
   * @param {(text: string) => any} o.notify   shows a sentence to the user (in the interface's language)
   * @param {object} [o.log]
   * @param {() => number} [o.now]
   * @param {(n: number) => Uint8Array} [o.random]   CSPRNG, for the ids of the messages
   * @param {string} [o.senderName]  the user's name for the From field ("" for the address alone)
   */
  constructor({ mailbox, records, invitations, confirm, notify, log = null, now = () => Date.now(), random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)), senderName = "" }) {
    const own = v.emailAddress(mailbox?.email);
    if (!mailbox?.id || own === null) throw new TypeError("Scheduler : boîte invalide");
    if (!records || !invitations || typeof confirm !== "function" || typeof notify !== "function") throw new TypeError("Scheduler : dépendance manquante");
    this.#mailbox = mailbox;
    this.#own = own;
    this.#records = records;
    this.#invitations = invitations;
    this.#confirm = confirm;
    this.#notify = notify;
    this.#log = log;
    this.#now = now;
    this.#random = random;
    this.#senderName = typeof senderName === "string" ? senderName : "";
  }

  /**
   * planChange for this mailbox. When the plan says the user is to be told
   * why nothing is sent (`notice`), the user is told here, once for a
   * change however often it is planned.
   */
  plan(change, { version } = {}) {
    const plan = planChange(change, { ownEmail: this.#own, version });
    if (plan.notice) this.#once(change, plan.notice);
    return plan;
  }

  /** Tell the user of `notice` for this change, unless it was told already (a change is planned at each pass until it is settled). */
  #once(change, notice) {
    const about = isRecord(change.item) ? change.item : isRecord(change.previous) ? change.previous : {};
    const key = `${notice}|${typeof about.uid === "string" ? about.uid : ""}|${String(change.changeId ?? "")}`;
    if (this.#told.has(key)) return;
    this.#told.add(key);
    while (this.#told.size > MAX_TOLD) this.#told.delete(this.#told.values().next().value);
    if (notice === "organizerChanged") this.#log?.info?.("Réunion : organisateur modifié localement, aucun message envoyé.");
    this.#tell(calendarNotice(notice, about.summary));
  }

  #tell(text) {
    if (!text) return;
    try {
      Promise.resolve(this.#notify(text)).catch(() => {});
    } catch {
      /* a notification that fails must not change the outcome */
    }
  }

  /**
   * Tell the user of a calendar or meeting event: one of the notices of
   * i18n.mjs, with the item's title and its detail (CALENDAR_NOTICE_KEYS),
   * or with no title and a number, as notice("changesDropped", "", 3)
   * (CALENDAR_COUNT_NOTICE_KEYS). An unknown name, or a number that is not
   * a whole number from 1 on, tells nothing. Never throws.
   */
  notice(name, summary, detail = "") {
    this.#tell(calendarNotice(name, typeof summary === "string" ? summary : "", detail));
  }

  #hex(bytes) {
    const r = this.#random(bytes);
    if (!(r instanceof Uint8Array) || r.length !== bytes) throw new Error("random");
    return toHex(r);
  }

  // ── Answer flow ─────────────────────────────────────────────────────────

  /**
   * The user's own status changed on an invitation: `change` is the local
   * change (the entry of readLocalChanges, whole, with the collection the
   * engine sends it to as `collectionId`), `plan` its plan (flow "answer").
   * Sends MeetingResponse, then queues the reply when the user answered
   * and the organizer asked for an answer.
   * → { outcome: "answered", calendarId }: the server took the answer;
   *   `calendarId` is the ServerId of the calendar item it names, or null.
   *   The caller acknowledges the change (and binds an added event).
   * → { outcome: "plain" }: no invitation can be named safely (mail is not
   *   synchronized, no mail is known for this meeting, or the mails known
   *   give another organizer or another start than the event's). Nothing
   *   was sent; the user is told (replyNotSent) only when a reply was asked
   *   for (`replyAsked`). The caller synchronizes the change as an
   *   ordinary Add or Change, and never removes the item.
   * → { outcome: "failed" }: the answer could not be given (a refusal of
   *   the server; a server that needs the invitation mail when mail is not
   *   synchronized, for an answer the user gave on an event it holds); the
   *   user was told, and the caller undoes the change (dropLocalChange).
   * A failure of the connection is thrown (EasError): the change stays to
   * send, and the next pass answers.
   */
  async answer({ client, signal = null, change, plan }) {
    const item = change?.item;
    if (plan?.flow !== "answer" || !isRecord(item)) throw new TypeError("Scheduler.answer : ce changement n'est pas une réponse");
    const summary = item.summary;
    const failed = (notice, detail) => {
      this.#tell(calendarNotice(notice, summary, detail));
      return { outcome: "failed" };
    };
    // Second line of defence (planChange gives no answer for such a change): the server wins, nothing is sent.
    if (change.rewritten === true) {
      this.#log?.warn?.("Réponse à une invitation non envoyée : l'élément a été modifié par le serveur entre-temps.");
      return failed("serverChanged");
    }
    const asked = change.replyAsked === true;

    let request;
    let mail = null;
    if (plan.target === "item") {
      request = { userResponse: plan.userResponse, collectionId: change.collectionId, requestId: change.serverId };
    } else {
      // No mail can be named: an ordinary change. The user who asked for a reply is told that none left.
      const plain = () => {
        if (asked) this.#tell(calendarNotice("replyNotSent", summary));
        return { outcome: "plain" };
      };
      if (this.#mailbox.sync?.mail !== true) {
        // An answer the user gave on an event the server holds, which this server only takes on the invitation mail.
        if (asked && change.op === "modify") {
          this.#log?.info?.("Réponse à une invitation annulée : le courrier de cette boîte n'est pas synchronisé.");
          return failed("answerNeedsMail");
        }
        this.#log?.info?.("Invitation : courrier non synchronisé, changement traité comme un changement ordinaire.");
        return plain();
      }
      mail = await this.#invitations.find(item.uid, { organizer: plan.organizer?.email, start: item.start });
      if (!mail) {
        this.#log?.info?.("Invitation : aucun courrier d'invitation sûr pour cet événement, changement traité comme un changement ordinaire.");
        return plain();
      }
      request = { userResponse: plan.userResponse, collectionId: mail.collectionId, requestId: mail.serverId };
    }

    let root;
    try {
      root = meetingResponseRequest([request]);
    } catch {
      return failed("answerFailed", t("sendReasonUnexpected"));
    }
    const doc = await client.command("MeetingResponse", root, { signal });
    let result = null;
    let status = null;
    try {
      status = doc ? topStatus(doc) : null;
      result = doc ? (parseMeetingResponse(doc).find((r) => r.requestId === request.requestId) ?? null) : null;
    } catch {
      result = null;
    }
    if (status === null || status === "1") status = result?.status ?? null;
    if (status !== "1") {
      this.#log?.warn?.(`Réponse à une invitation refusée par le serveur (Status ${status ?? "absent"}).`);
      // Status 2: not a meeting request (any more). The table no longer names that mail.
      if (mail && status === "2") {
        await this.#invitations.forget(mail.collectionId, mail.serverId);
        return failed("answerNoInvitation");
      }
      return failed("answerFailed", status === null ? t("sendReasonUnexpected") : refusedReason(status));
    }
    this.#log?.info?.(`Réponse à une invitation enregistrée par le serveur (${plan.userResponse}).`);

    // The reply: the plan and the change itself must both say that the user answered.
    if (plan.reply === true && asked) {
      let queued = null;
      try {
        queued = await this.#queue([{
          key: `r|${change.collectionId ?? ""}|${change.changeId}|${plan.response}`,
          kind: plan.response,
          recipients: [{ email: plan.organizer.email, name: plan.organizer.name, role: "required" }],
          occurrence: null,
          event: item,
          sequence: item.sequence,
        }]);
      } catch {
        queued = null;
      }
      if (queued === null) this.#tell(calendarNotice("sendFailed", summary, t("sendReasonUnexpected")));
      else if (queued < 0) this.#tell(calendarNotice("notSentFull", summary));
    }
    return { outcome: "answered", calendarId: result?.calendarId ?? null };
  }

  // ── Organize flow ───────────────────────────────────────────────────────

  /**
   * The server accepted a change to a meeting the user organizes: the
   * messages of its `plan` (flow "organize") are recorded, to be asked for
   * and sent by deliver(). Call it BEFORE acknowledging the change.
   *
   * `key` names the change, once and for all (the caller builds it from
   * the collection, the SyncKey the change was sent with and its changeId):
   * a change that is queued or was settled already is not queued again.
   * → { item, sequence, queued }: `item` is the description to store as
   * synchronized (the change's item with its SEQUENCE raised by one when an
   * update or a cancellation is to be sent; null for a delete), `sequence`
   * that number, `queued` how many messages were recorded.
   *
   * A change marked `rewritten` has no message, whatever plan comes with it
   * (planChange gives it none): nothing is recorded, and its item is given
   * back as it is.
   */
  async enqueue({ key, change, plan }) {
    if (plan?.flow !== "organize" || typeof key !== "string" || !key) throw new TypeError("Scheduler.enqueue : ce changement n'a pas de message");
    // What the messages say: the deleted meeting as it was; and, for a meeting that lost its organizer with its
    // attendees, the meeting as the attendees knew it (the event as it is now is nobody's meeting).
    const source = change.op === "delete" || addressOf(change.item?.organizer) === null ? change.previous : change.item;
    const base = Math.max(Number.isInteger(change.item?.sequence) ? change.item.sequence : 0, Number.isInteger(change.previous?.sequence) ? change.previous.sequence : 0);
    if (change.rewritten === true) {
      this.#log?.warn?.("Messages de réunion : élément modifié par le serveur entre-temps, aucun message enregistré.");
      return { item: change.op === "delete" ? null : change.item, sequence: base, queued: 0 };
    }
    const raise = plan.messages.some((m) => m.kind !== "invite");
    const sequence = raise ? Math.min(base + 1, MAX_SEQUENCE) : base;
    const event = { ...source, sequence };
    const entries = plan.messages.map((m, i) => ({
      key: `${key}|${i}`,
      kind: m.kind,
      recipients: m.recipients.map((p) => ({ email: p.email, name: p.name, role: p.role })),
      occurrence: m.occurrence,
      event,
      sequence,
    }));
    let queued = null;
    try {
      queued = await this.#queue(entries);
    } catch {
      queued = null;
    }
    // Not recorded: the user is told that nothing will be sent (no room, or a message that cannot be stored).
    if (queued === null) this.#tell(calendarNotice("sendFailed", source.summary, t("sendReasonUnexpected")));
    else if (queued < 0) this.#tell(calendarNotice("notSentFull", source.summary));
    return { item: change.op === "delete" ? null : { ...change.item, sequence }, sequence, queued: Math.max(queued ?? 0, 0) };
  }

  #serialBox(fn) {
    const run = this.#boxQueue.then(fn);
    this.#boxQueue = run.catch(() => {});
    return run;
  }

  async #load() {
    if (this.#box) return this.#box;
    let raw = null;
    try {
      raw = await this.#records.get(BOX, null);
    } catch {
      raw = null;
    }
    const entries = [];
    const keys = new Set();
    for (const e of Array.isArray(raw?.entries) ? raw.entries.slice(0, MAX_OUTBOX) : []) {
      const entry = checkEntry(e, this.#own);
      if (!entry || keys.has(entry.key)) continue;
      keys.add(entry.key);
      entries.push(entry);
    }
    const settled = (Array.isArray(raw?.settled) ? raw.settled : []).filter((k) => typeof k === "string" && k.length <= 400).slice(-MAX_SETTLED);
    this.#box = { entries, settled };
    try {
      if (this.#mailbox.sync?.calendar !== true) {
        // The mailbox no longer synchronizes its calendar (the scheduler is built anew when the mailbox is
        // edited): its events left Thunderbird, and nothing about them is asked or sent any more. The engine
        // clears the outbox too, when its last calendar collection goes; this does not wait for it.
        // (A message that was leaving when Thunderbird stopped stays, to be told as uncertain: it may have left.)
        const leaving = entries.filter((e) => e.state === "sending");
        if (entries.length > leaving.length || settled.length) {
          this.#log?.info?.(`Messages de réunion : agenda non synchronisé, ${entries.length - leaving.length} message(s) en attente abandonné(s).`);
          this.#box = { entries: leaving, settled: [] };
          await this.#save();
        }
      } else {
        // What waited too long while Thunderbird was closed goes before anything is asked or sent.
        await this.#expire();
      }
    } catch {
      /* not written: the same entries are dropped again at the next load or delivery */
    }
    return this.#box;
  }

  /**
   * Drop the entries that have waited more than MAX_WAIT_MS (and those
   * whose date cannot be believed: none, or one far in the future). Nothing
   * of them is asked or sent. The user is told for each message that needed
   * their confirmation; a reply to an organizer is dropped without a word.
   * A message of the organize flow is remembered as settled, so that its
   * change, replayed, does not bring it back. An entry that was leaving
   * when Thunderbird stopped is not touched: it may have left, and
   * #deliver says so.
   * Runs inside #serialBox, or from #load. → number dropped
   */
  async #expire() {
    const box = this.#box;
    const now = this.#now();
    const old = box.entries.filter((e) => e.state !== "sending" && (!(e.at > 0) || now - e.at > MAX_WAIT_MS || e.at - now > MAX_WAIT_MS));
    if (!old.length) return 0;
    box.entries = box.entries.filter((e) => !old.includes(e));
    for (const entry of old) {
      if (isReply(entry)) continue;
      box.settled.push(entry.key);
      this.#tell(calendarNotice("notSentOld", subjectOf(entry.event, entry.occurrence).summary));
    }
    if (box.settled.length > MAX_SETTLED) box.settled.splice(0, box.settled.length - MAX_SETTLED);
    this.#log?.warn?.(`Messages de réunion : ${old.length} message(s) en attente depuis plus d'un jour, abandonné(s) sans envoi.`);
    await this.#save();
    return old.length;
  }

  async #save() {
    const { entries, settled } = this.#box;
    if (entries.length || settled.length) await this.#records.set(BOX, { v: 1, entries, settled });
    else await this.#records.remove(BOX);
  }

  /** Record new entries (those whose key is queued or settled already are left out). → number recorded; -1 when there is no room. */
  #queue(list) {
    return this.#serialBox(async () => {
      const box = await this.#load();
      const fresh = list.filter((e) => !box.settled.includes(e.key) && !box.entries.some((x) => x.key === e.key));
      if (!fresh.length) return 0;
      if (box.entries.length + fresh.length > MAX_OUTBOX) {
        this.#log?.warn?.("Messages de réunion : file pleine, message non enregistré.");
        return -1;
      }
      const checked = [];
      for (const e of fresh) {
        const entry = checkEntry({ ...e, state: "new", at: this.#now() }, this.#own);
        if (!entry) throw new Error("entrée invalide");
        checked.push(entry);
      }
      box.entries.push(...checked);
      try {
        await this.#save();
      } catch (e) {
        box.entries.splice(box.entries.length - checked.length, checked.length);
        throw e;
      }
      return checked.length;
    });
  }

  /**
   * An entry is over (sent, not wanted, failed): it leaves the queue. The
   * key of a message of the organize flow is remembered for a while, so
   * that the same change, replayed, is not asked for again; a reply is not
   * (the same invitation may be answered again later).
   */
  #settle(key) {
    return this.#serialBox(async () => {
      const box = await this.#load();
      const i = box.entries.findIndex((e) => e.key === key);
      const reply = i >= 0 && isReply(box.entries[i]);
      if (i >= 0) box.entries.splice(i, 1);
      if (!reply) box.settled.push(key);
      if (box.settled.length > MAX_SETTLED) box.settled.splice(0, box.settled.length - MAX_SETTLED);
      await this.#save();
    });
  }

  #mark(key, state) {
    return this.#serialBox(async () => {
      const box = await this.#load();
      const entry = box.entries.find((e) => e.key === key);
      if (!entry) return false;
      entry.state = state;
      await this.#save();
      return true;
    });
  }

  /** Number of messages waiting (for the user's answer, or to be sent). */
  pending() {
    return this.#serialBox(async () => (await this.#load()).entries.length);
  }

  /** Forget everything that waits: nothing of it will be asked or sent (the mailbox's calendars are removed). */
  clear() {
    return this.#serialBox(async () => {
      this.#box = { entries: [], settled: [] };
      await this.#records.remove(BOX);
    });
  }

  /** The bytes of one message, ready for SendMail. Throws when it cannot be written (an ItipError, mostly). */
  #compose(entry) {
    const reply = isReply(entry);
    const method = reply ? "REPLY" : entry.kind === "cancel" ? "CANCEL" : "REQUEST";
    const stamp = this.#now();
    const about = subjectOf(entry.event, entry.occurrence);
    const calendar = itipCalendar({
      method,
      event: entry.event,
      // A reply names its author only; an invitation or a cancellation, the people it is written to.
      attendees: reply ? [{ email: this.#own, name: this.#senderName }] : entry.recipients,
      replyStatus: reply ? entry.kind : null,
      stamp,
      sequence: entry.sequence,
      occurrence: entry.occurrence,
    });
    // The text part, cleaned here like everything shown: a reply gives its times in UTC (see whenText).
    const lines = [itemTitle(about.summary), meetingText("when", whenText(about.start, about.allDay, reply))];
    const where = cleanLine(about.location).trim();
    if (where) lines.push(meetingText("where", where));
    const domain = this.#own.slice(this.#own.lastIndexOf("@") + 1);
    return itipMessage({
      method,
      calendar,
      from: { email: this.#own, name: this.#senderName },
      // Addresses only: the names are in the calendar (CN), never in the To field.
      to: entry.recipients.map((p) => ({ email: p.email })),
      subject: meetingSubject(entry.kind, about.summary),
      text: lines.filter(Boolean).join("\n"),
      date: stamp,
      messageId: `${this.#hex(16)}@${HOST.test(domain) ? domain : "sync443.invalid"}`,
    });
  }

  /**
   * Ask and send what is queued, oldest first, one message at a time:
   * an invitation, an update or a cancellation is first asked for
   * (`confirm`); a reply to an organizer is sent without a question. Each
   * message goes through SendMail once, with a copy in Sent Items.
   * → { sent, declined, failed, uncertain }
   * A question nobody answered in time counts as declined, and the user is
   * told that its message was not sent. Entries that waited more than
   * MAX_WAIT_MS are dropped first (see #expire).
   * Throws only when cancelled (`signal`) before a message left: that
   * message stays queued, and is asked for again next time. A cancellation
   * while a question is open is no answer: the question is given up at
   * once, whatever becomes of `confirm`, and its message stays queued too.
   */
  deliver({ client, signal = null } = {}) {
    const run = this.#delivery.then(() => this.#deliver(client, signal));
    this.#delivery = run.catch(() => {});
    return run;
  }

  /** `confirm`, given up as soon as `signal` is aborted (its answer, should one still come, is then ignored). */
  #ask(question, signal) {
    const asked = Promise.resolve().then(() => this.#confirm(question));
    if (typeof signal?.addEventListener !== "function") return asked;
    return new Promise((resolve, reject) => {
      const stop = () => resolve(false);
      signal.addEventListener("abort", stop);
      asked.then(resolve, reject).finally(() => signal.removeEventListener?.("abort", stop));
    });
  }

  async #deliver(client, signal) {
    const stats = { sent: 0, declined: 0, failed: 0, uncertain: 0 };
    const skipped = new Set();
    for (;;) {
      if (signal?.aborted) throw cancelled();
      // Checked before each message: a reply never leaves, and no question is asked, for a meeting of days ago.
      const box = await this.#serialBox(async () => {
        await this.#load();
        await this.#expire().catch(() => {});
        return this.#box;
      });
      const entry = box.entries.find((e) => !skipped.has(e.key));
      if (!entry) return stats;
      skipped.add(entry.key);
      const summary = subjectOf(entry.event, entry.occurrence).summary;

      // Thunderbird stopped while this message was leaving: it may have left. Never sent again.
      if (entry.state === "sending") {
        await this.#settle(entry.key);
        this.#log?.warn?.("Message de réunion : envoi interrompu, incertain ; il n'est pas renvoyé.");
        this.#tell(calendarNotice("sendUncertain", summary));
        stats.uncertain++;
        continue;
      }

      const reply = isReply(entry);
      if (!reply) {
        const about = subjectOf(entry.event, entry.occurrence);
        let answer = false;
        try {
          answer = await this.#ask({ kind: entry.kind, summary: about.summary, start: about.start, allDay: about.allDay, recipients: entry.recipients.map((p) => p.email), from: this.#own }, signal);
        } catch {
          answer = false; // a question that cannot be asked is not a yes
        }
        // Stopped while the question was open: the user decided nothing. Asked again next time.
        if (signal?.aborted) throw cancelled();
        if (answer !== true) {
          await this.#settle(entry.key);
          if (answer === EXPIRED) {
            // Nobody answered: nothing is sent, and the user learns that the attendees were not told.
            this.#log?.info?.(`Message de réunion non envoyé : question restée sans réponse (${entry.recipients.length} destinataire(s)).`);
            this.#tell(calendarNotice("notSentExpired", summary));
          } else {
            this.#log?.info?.(`Message de réunion non envoyé : l'utilisateur ne l'a pas voulu (${entry.recipients.length} destinataire(s)).`);
          }
          stats.declined++;
          continue;
        }
      }

      let request;
      let size = 0;
      try {
        const mime = this.#compose(entry);
        size = mime.length;
        request = sendMailRequest(this.#hex(16), mime, { saveInSentItems: true });
      } catch (e) {
        await this.#settle(entry.key);
        this.#log?.warn?.(`Message de réunion non préparé (${typeof e?.code === "string" ? e.code : "erreur"}).`);
        this.#tell(calendarNotice("sendFailed", summary, t("sendReasonMime")));
        stats.failed++;
        continue;
      }

      // Marked before it leaves: whatever happens from here on, this message is never sent a second time.
      // No longer in the outbox (cleared while its question was open: the mailbox's calendar is gone): not sent.
      if (!(await this.#mark(entry.key, "sending"))) {
        this.#log?.warn?.("Message de réunion non envoyé : il n'est plus en attente (file vidée entre-temps).");
        this.#tell(calendarNotice("sendFailed", summary, t("sendReasonUnexpected")));
        stats.failed++;
        continue;
      }
      let doc;
      try {
        doc = await client.command("SendMail", request, { timeoutMs: sendTimeout(size), maxBytes: SEND_MAX_BYTES, signal });
      } catch (e) {
        const code = typeof e?.code === "string" ? e.code : "";
        if (e?.sent !== true && (code === ERR.CANCELLED || signal?.aborted)) {
          await this.#mark(entry.key, "new"); // nothing left: asked again next time
          throw cancelled();
        }
        await this.#settle(entry.key);
        if (e?.sent === true && UNCERTAIN.has(code)) {
          this.#log?.warn?.(`Message de réunion : envoi incertain (${code}).`);
          this.#tell(calendarNotice("sendUncertain", summary));
          stats.uncertain++;
        } else {
          this.#log?.warn?.(`Message de réunion non envoyé (${/^[A-Z_]{2,20}$/.test(code) ? code : "erreur"}).`);
          this.#tell(calendarNotice("sendFailed", summary, failureReason(e)));
          stats.failed++;
        }
        continue;
      }
      let status = null;
      try {
        status = parseSendMail(doc ?? null);
      } catch {
        status = null;
      }
      await this.#settle(entry.key);
      if (status === "1") {
        this.#log?.info?.(`Message de réunion envoyé (${entry.kind}, ${entry.recipients.length} destinataire(s)).`);
        stats.sent++;
      } else if (status === null) {
        this.#log?.warn?.("Message de réunion : réponse inattendue du serveur, envoi incertain.");
        this.#tell(calendarNotice("sendUncertain", summary));
        stats.uncertain++;
      } else {
        this.#log?.warn?.(`Message de réunion refusé par le serveur (Status ${status}).`);
        this.#tell(calendarNotice("sendFailed", summary, refusedReason(status, statusReason(status))));
        stats.failed++;
      }
    }
  }
}
