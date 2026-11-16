// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Meetings (src/sync/scheduling.mjs): which flow each shape of local change
 * takes (planChange), then the answer flow and the organize flow carried
 * out against the fake ActiveSync server of calendar-fakes.mjs.
 */

import { test, assert, eq, rejects, throws } from "./harness.mjs";
import { EasError, ERR } from "../../src/transport/client.mjs";
import { Store } from "../../src/sync/store.mjs";
import { InvitationTable } from "../../src/sync/invitations.mjs";
import { planChange, onlyAnswer, Scheduler, MAX_OUTBOX, MAX_WAIT_MS, EXPIRED } from "../../src/sync/scheduling.mjs";
import { MAX_MEETING_RECIPIENTS } from "../../src/core/itip.mjs";
import { checkEvent } from "../../src/core/calendar-item.mjs";
import { text } from "../../src/core/wbxml.mjs";
import { memoryArea } from "./journal.test.mjs";
import { quietLog } from "./mail-sync.test.mjs";
import { FakePimServer, OWN, event, task, meeting, invitation, person, readMeetingMail } from "./calendar-fakes.mjs";

const MB = "0123456789ab";
const A = "anne@example.org";
const B = "bruno@example.org";
const C = "chloe@example.org";
const CHEF = "chef@example.org";

// Entries of readLocalChanges, whole: `rewritten` and `replyAsked` are part of each one (false unless a test says otherwise).
const add = (item, over = {}) => ({ changeId: "c1", op: "add", kind: item.kind, collectionId: null, serverId: null, item, previous: null, problem: null, detached: false, rewritten: false, replyAsked: false, ...over });
const modify = (item, previous, over = {}) => ({ changeId: "c1", op: "modify", kind: item.kind, collectionId: "7", serverId: "7:1", item, previous, problem: null, detached: false, rewritten: false, replyAsked: false, ...over });
const del = (previous, over = {}) => ({ changeId: "c1", op: "delete", kind: previous?.kind ?? "event", collectionId: "7", serverId: "7:1", item: null, previous, problem: null, detached: false, rewritten: false, replyAsked: false, ...over });
/** The user answered in Thunderbird, and Thunderbird asked whether the organizer may be told. */
const ASKED = { replyAsked: true };
/** The invitation mail of invitation(), as the mail engine notes it. */
const invitationMail = (over = {}) => ({ uid: "invite-1", collectionId: "1", serverId: "1:42", organizer: CHEF, start: "2026-12-01T09:00:00Z", kind: "inbox", ...over });
const plan = (change, version = "14.1") => planChange(change, { ownEmail: OWN, version });
/** A plan, shortened: "plain", "refuse", "answer:<response>:<target>:<reply>", or its messages as "kind>recipients@occurrence". */
function brief(p) {
  if (p.flow === "answer") return `answer:${p.response}:${p.target}:${p.reply ? "reply" : "silent"}`;
  if (p.flow !== "organize") return p.flow;
  return p.messages.map((m) => `${m.kind}${m.removed ? "(removed)" : ""}>${m.recipients.map((r) => r.email.split("@")[0]).join(",")}${m.occurrence ? `@${m.occurrence}` : ""}`).join(" + ");
}

const weekly = { freq: "weekly", interval: 1, count: 10, until: null, byDay: ["TU"], bySetPos: null, byMonthDay: null, byMonth: null, weekStart: null };
const series = (attendees, exceptions = [], over = {}) => meeting(attendees, { recurrence: weekly, exceptions, ...over });
const exception = (originalStart, changes = {}, deleted = false) => ({ originalStart, deleted, changes });

// ── planChange: every shape of change ─────────────────────────────────────

test("planChange: changes that concern nobody else are plain", () => {
  const rows = [
    ["a task added", add(task())],
    ["a task changed", modify(task({ summary: "Autre" }), task())],
    ["a task deleted", del(task())],
    ["an appointment added", add(event())],
    ["an appointment moved", modify(event({ start: "2026-12-02T09:00:00Z", end: "2026-12-02T10:00:00Z" }), event())],
    ["an appointment deleted", del(event())],
    ["a delete with nothing synchronized", del(null)],
    ["a change with a problem", add(meeting([A]), { item: null, problem: "recurrence" })],
    ["my meeting without attendees", add(meeting([]))],
    ["my meeting whose only attendee is me", add(meeting([OWN]))],
    ["a meeting added already cancelled", add(meeting([A], { meeting: { ...meeting([A]).meeting, cancelled: true } }))],
    ["a cancelled meeting deleted", del(meeting([A], { meeting: { ...meeting([A]).meeting, cancelled: true } }))],
    ["attendees but no organizer", add(event({ attendees: [person(A)] }))],
  ];
  for (const [name, change] of rows) eq(brief(plan(change)), "plain", name);
});

test("planChange: a meeting I organize — invitation, update, cancellation", () => {
  const base = meeting([A, B]);
  const rows = [
    ["new meeting", add(base), "invite>anne,bruno"],
    ["deleted meeting", del(base), "cancel>anne,bruno"],
    ["time changed", modify({ ...base, start: "2026-12-01T11:00:00Z", end: "2026-12-01T12:00:00Z" }, base), "update>anne,bruno"],
    ["end changed", modify({ ...base, end: "2026-12-01T10:30:00Z" }, base), "update>anne,bruno"],
    ["location changed", modify({ ...base, location: "Salle 3" }, base), "update>anne,bruno"],
    ["subject changed", modify({ ...base, summary: "Point mensuel" }, base), "update>anne,bruno"],
    ["description changed", modify({ ...base, description: "Ordre du jour" }, base), "update>anne,bruno"],
    ["made recurring", modify({ ...base, recurrence: weekly }, base), "update>anne,bruno"],
    ["recurrence changed", modify({ ...base, recurrence: { ...weekly, count: 5 } }, { ...base, recurrence: weekly }), "update>anne,bruno"],
    ["all day now", modify({ ...base, allDay: true, start: "2026-12-01", end: "2026-12-02" }, base), "update>anne,bruno"],
    ["attendee added", modify(meeting([A, B, C]), base), "update>anne,bruno,chloe"],
    ["attendee removed", modify(meeting([A]), base), "update>anne + cancel(removed)>bruno"],
    ["attendee replaced", modify(meeting([A, C]), base), "update>anne,chloe + cancel(removed)>bruno"],
    ["every attendee removed", modify(meeting([]), base), "cancel(removed)>anne,bruno"],
    ["role changed", modify(meeting([A, person(B, { role: "optional" })]), base), "update>anne,bruno"],
    ["attendees given to an appointment of mine", modify(base, meeting([])), "invite>anne,bruno"],
    ["attendees given to a plain appointment", modify(base, event()), "invite>anne,bruno"],
    ["cancelled as a whole", modify({ ...base, meeting: { ...base.meeting, cancelled: true } }, base), "cancel>anne,bruno"],
    ["cancelled, and an attendee removed at once", modify(meeting([A], { meeting: { ...base.meeting, cancelled: true } }), base), "cancel>anne,bruno"],
    ["no longer cancelled", modify(base, { ...base, meeting: { ...base.meeting, cancelled: true } }), "update>anne,bruno"],
    ["nothing to compare with", modify(base, null), "update>anne,bruno"],
  ];
  for (const [name, change, expected] of rows) eq(brief(plan(change)), expected, name);
});

test("planChange: changes of my meeting that the attendees need not hear of give no message", () => {
  const base = meeting([A, B], { reminder: 15, categories: ["Projet"] });
  const rows = [
    ["reminder", { ...base, reminder: 30 }],
    ["no reminder", { ...base, reminder: null }],
    ["category", { ...base, categories: ["Projet", "Client"] }],
    ["free/busy", { ...base, busy: "tentative" }],
    ["privacy", { ...base, privacy: "private" }],
    ["an attendee's answer", meeting([person(A, { status: "accepted" }), B], { reminder: 15, categories: ["Projet"] })],
    ["an attendee's name", meeting([person(A, { name: "Anne" }), B], { reminder: 15, categories: ["Projet"] })],
    ["an address in another case", meeting([A.toUpperCase(), B], { reminder: 15, categories: ["Projet"] })],
    ["stamp and sequence", { ...base, stamp: "2026-11-16T10:00:00Z", sequence: 4 }],
    ["the zone of a single timed event", { ...base, timezone: { bias: -60, standard: { bias: 0, change: null }, daylight: { bias: 0, change: null } } }],
    ["nothing at all", { ...base }],
  ];
  for (const [name, item] of rows) eq(brief(plan(modify(item, base))), "plain", name);
});

test("planChange: one occurrence of a series — cancelled, changed, or the whole series when more changed", () => {
  const base = series([A, B]);
  const first = "2026-12-08T09:00:00Z";
  const second = "2026-12-15T09:00:00Z";
  const moved = exception(first, { start: "2026-12-08T14:00:00Z", end: "2026-12-08T15:00:00Z" });
  const rows = [
    ["an occurrence deleted", series([A, B], [exception(first, {}, true)]), base, `cancel>anne,bruno@${first}`],
    ["an occurrence cancelled", series([A, B], [exception(first, { cancelled: true })]), base, `cancel>anne,bruno@${first}`],
    ["an occurrence moved", series([A, B], [moved]), base, `update>anne,bruno@${first}`],
    ["an occurrence renamed", series([A, B], [exception(first, { summary: "Exceptionnel" })]), base, `update>anne,bruno@${first}`],
    ["an occurrence elsewhere", series([A, B], [exception(first, { location: "Visio" })]), base, `update>anne,bruno@${first}`],
    ["an occurrence with its own attendees", series([A, B], [exception(first, { attendees: [person(A), person(C)] })]), base, `update>anne,chloe@${first}`],
    ["an occurrence's reminder only", series([A, B], [exception(first, { reminder: 5 })]), base, "plain"],
    ["an occurrence's category only", series([A, B], [exception(first, { categories: ["Client"] })]), base, "plain"],
    ["an occurrence moved again", series([A, B], [exception(first, { start: "2026-12-08T16:00:00Z", end: "2026-12-08T17:00:00Z" })]), series([A, B], [moved]), `update>anne,bruno@${first}`],
    ["a moved occurrence now deleted", series([A, B], [exception(first, {}, true)]), series([A, B], [moved]), `cancel>anne,bruno@${first}`],
    ["a deleted occurrence stays deleted", series([A, B], [exception(first, {}, true)], { reminder: 10 }), series([A, B], [exception(first, {}, true)]), "plain"],
    ["two occurrences changed at once", series([A, B], [moved, exception(second, {}, true)]), base, "update>anne,bruno"],
    ["an occurrence changed and the series renamed", series([A, B], [moved], { summary: "Autre" }), base, "update>anne,bruno"],
    ["an occurrence back to what the series says", base, series([A, B], [moved]), "update>anne,bruno"],
    ["a second occurrence changed, the first untouched", series([A, B], [moved, exception(second, { location: "Visio" })]), series([A, B], [moved]), `update>anne,bruno@${second}`],
    ["an occurrence deleted and an attendee removed", series([A], [exception(first, {}, true)]), base, "update>anne + cancel(removed)>bruno"],
  ];
  for (const [name, item, previous, expected] of rows) eq(brief(plan(modify(item, previous))), expected, name);
});

test("planChange: the organizer is never a recipient; duplicate and invalid addresses are dropped", () => {
  const raw = meeting([]);
  raw.organizer = { email: "Moi@Example.com", name: "Moi" }; // the mailbox's address, in another case
  raw.attendees = [
    person(OWN),
    person("MOI@EXAMPLE.COM"),
    person(A),
    person(A.toUpperCase()),
    person("pas une adresse"),
    person("a@b"),
    person(""),
    { name: "sans adresse", role: "required", status: "unknown" },
    null,
    "anne@example.org",
    person(`${B} `),
  ];
  const p = plan(add(raw));
  eq(p.flow, "organize");
  eq(p.messages.map((m) => m.recipients.map((r) => r.email)), [[A, B]]);
  // A delete takes its recipients from the last synchronized description.
  eq(plan(del(raw)).messages[0].recipients.map((r) => r.email), [A, B]);
  // Nobody left once the organizer is taken out: no message.
  eq(brief(plan(add(meeting([OWN, OWN.toUpperCase()])))), "plain");
});

test("planChange: more than 100 recipients refuses the change; 100 pass; a change without message passes whatever the number", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `p${i}@example.org`);
  eq(MAX_MEETING_RECIPIENTS, 100);
  eq(plan(add(meeting(many(100)))).messages[0].recipients.length, 100);
  eq(plan(add(meeting(many(101)))), { flow: "refuse", reason: "attendees", count: 101 });
  eq(plan(del(meeting(many(101)))).flow, "refuse", "a cancellation to 101 people is refused too");
  eq(plan(modify(meeting(many(150), { location: "Ailleurs" }), meeting(many(150)))).flow, "refuse");
  eq(plan(modify(meeting(many(150), { reminder: 5 }), meeting(many(150)))).flow, "plain", "nothing to send: nothing to refuse");
  // 100 attendees, one more removed: the update still has 100 recipients, the cancellation one.
  eq(brief(plan(modify(meeting(many(100)), meeting(many(101))))).split(" + ").length, 2);
  // An occurrence with too many attendees of its own cannot be written in an update of the series.
  const big = series([A], [exception("2026-12-08T09:00:00Z", { attendees: many(101).map((e) => person(e)) })], { location: "Ailleurs" });
  eq(plan(modify(big, series([A]))).flow, "refuse");
});

test("planChange: an invitation I answer — on the calendar item with 14.1, on the mail otherwise", () => {
  const pending = invitation();
  const rows = [
    ["accepted, 14.1", modify(invitation({}, "accepted"), pending, ASKED), "14.1", "answer:accepted:item:reply"],
    ["accepted, 14.0", modify(invitation({}, "accepted"), pending, ASKED), "14.0", "answer:accepted:mail:reply"],
    ["accepted, 12.1", modify(invitation({}, "accepted"), pending, ASKED), "12.1", "answer:accepted:mail:reply"],
    ["tentative", modify(invitation({}, "tentative"), pending, ASKED), "14.1", "answer:tentative:item:reply"],
    ["declined", modify(invitation({}, "declined"), pending, ASKED), "14.1", "answer:declined:item:reply"],
    ["an answer changed", modify(invitation({}, "declined"), invitation({}, "accepted"), ASKED), "14.1", "answer:declined:item:reply"],
    ["added from the invitation bar, 14.1", add(invitation({}, "accepted"), ASKED), "14.1", "answer:accepted:mail:reply"],
    ["added from the invitation bar, 12.1", add(invitation({}, "tentative"), ASKED), "12.1", "answer:tentative:mail:reply"],
    ["added and declined", add(invitation({}, "declined"), ASKED), "14.0", "answer:declined:mail:reply"],
    ["the organizer wants no answer", modify(invitation({ meeting: { ...invitation().meeting, responseRequested: false, response: "accepted" } }), pending, ASKED), "14.1", "answer:accepted:item:silent"],
    // The status changed and Thunderbird did not ask to reply ("Do not send a response"): the server is told, nobody else.
    ["accepted without a reply", modify(invitation({}, "accepted"), pending), "14.1", "answer:accepted:item:silent"],
    ["added with a status, no reply asked", add(invitation({}, "accepted")), "12.1", "plain"],
    ["the same answer again, a reminder set", modify(invitation({ reminder: 10 }, "accepted"), invitation({}, "accepted"), ASKED), "14.1", "plain"],
    ["only a reminder", modify(invitation({ reminder: 10 }), pending, ASKED), "14.1", "plain"],
    ["answer taken back", modify(invitation({}, "not-responded"), invitation({}, "accepted"), ASKED), "14.1", "plain"],
    ["answer taken back to none", modify(invitation({}, "none"), invitation({}, "accepted"), ASKED), "14.1", "plain"],
    ["added without an answer", add(invitation(), ASKED), "14.1", "plain"],
    ["a detached copy changed later", add(invitation({}, "accepted"), { detached: true, ...ASKED }), "14.1", "plain"],
    ["deleted", del(invitation({}, "accepted"), ASKED), "14.1", "plain"],
    ["nothing to compare with", modify(invitation({}, "accepted"), null, ASKED), "14.1", "plain"],
    ["someone else's meeting changed otherwise", modify(invitation({ location: "Ailleurs" }), pending, ASKED), "14.1", "plain"],
  ];
  for (const [name, change, version, expected] of rows) eq(brief(plan(change, version)), expected, name);
  const p = plan(modify(invitation({}, "accepted"), pending));
  eq([p.userResponse, p.organizer], [1, { email: CHEF, name: "Chef" }]);
  eq([plan(modify(invitation({}, "tentative"), pending)).userResponse, plan(modify(invitation({}, "declined"), pending)).userResponse], [2, 3]);
});

test("planChange: pure, and never thrown off by odd input", () => {
  const change = modify(meeting([A], { location: "Ailleurs" }), meeting([A, B]));
  const frozen = JSON.stringify(change);
  eq(plan(change), plan(JSON.parse(frozen)));
  eq(JSON.stringify(change), frozen, "the change is not modified");
  assert(Object.isFrozen(plan(change)) && Object.isFrozen(plan(change).messages));
  for (const odd of [null, undefined, 7, "x", [], {}, { op: "add" }, { op: "explode", kind: "event", item: meeting([A]) }, add({ kind: "event" }), add({ kind: "event", organizer: "moi", attendees: "tous" })]) {
    eq(planChange(odd, { ownEmail: OWN, version: "14.1" }), { flow: "plain" }, JSON.stringify(odd));
  }
  eq(planChange(add(meeting([A])), { ownEmail: "pas une adresse", version: "14.1" }), { flow: "plain" }, "no address of our own: no meeting of our own");
  eq(planChange(add(meeting([A]))), { flow: "plain" });
});

test("onlyAnswer: tells an answer alone from an answer with other changes", () => {
  const before = invitation();
  eq(onlyAnswer(invitation({}, "accepted"), before), true);
  eq(onlyAnswer(invitation({ stamp: "2026-11-16T10:00:00Z", sequence: 2 }, "accepted"), before), true);
  eq(onlyAnswer(invitation({ reminder: 15 }, "accepted"), before), false);
  eq(onlyAnswer(invitation({ categories: ["Client"] }, "accepted"), before), false);
  eq(onlyAnswer(invitation({}, "accepted"), null), false);
});

// ── The flows ─────────────────────────────────────────────────────────────

function world({ version = "14.1", sync = { mail: true, calendar: true, contacts: false, tasks: true }, area = memoryArea(), senderName = "" } = {}) {
  const server = new FakePimServer({ version });
  const records = new Store(area).mailbox(MB);
  const clock = { now: Date.UTC(2026, 10, 16, 9, 0, 0) };
  const log = quietLog();
  const mailbox = { id: MB, email: OWN, name: "Travail", sync };
  const invitations = new InvitationTable({ records, now: () => clock.now });
  const w = { server, records, area, clock, log, mailbox, invitations, version, asked: [], notices: [], send: true, seed: 0 };
  w.make = () =>
    new Scheduler({
      mailbox,
      records,
      invitations,
      confirm: async (question) => {
        w.asked.push(question);
        if (w.send instanceof Error) throw w.send;
        return w.send;
      },
      notify: (message) => w.notices.push(message),
      log,
      now: () => clock.now,
      random: (n) => Uint8Array.from({ length: n }, () => (w.seed = (w.seed * 73 + 41) % 251)),
      senderName,
    });
  w.scheduler = w.make();
  /** Plan a change and queue its messages, as pim.mjs does once the server accepted it. */
  w.organize = async (change, key = `7|${change.changeId}`) => {
    const p = w.scheduler.plan(change, { version });
    eq(p.flow, "organize");
    return w.scheduler.enqueue({ key, change, plan: p });
  };
  w.deliver = (o = {}) => w.scheduler.deliver({ client: server, ...o });
  w.mails = () => server.mails.map((m) => readMeetingMail(m.mime));
  return w;
}

const line = (mail, name) => mail.calendar.filter((l) => l.startsWith(name));

test("answer flow: on the calendar item with 14.1 — MeetingResponse, then one REPLY to the organizer, no question asked", async () => {
  const w = world();
  const change = modify(invitation({}, "accepted"), invitation(), ASKED);
  const p = w.scheduler.plan(change, { version: "14.1" });
  const r = await w.scheduler.answer({ client: w.server, change, plan: p });
  eq(r, { outcome: "answered", calendarId: "7:1" });
  eq(w.server.meetings, [{ userResponse: 1, collectionId: "7", requestId: "7:1", instanceId: null }]);
  eq(w.server.mails.length, 0, "the reply waits for deliver()");
  eq(await w.scheduler.pending(), 1);
  eq(await w.deliver(), { sent: 1, declined: 0, failed: 0, uncertain: 0 });
  eq(w.asked, [], "answering is the user's own action: no confirmation window");
  const [mail] = w.mails();
  eq([mail.method, mail.to, mail.from], ["REPLY", [CHEF], [OWN]]);
  eq(w.server.mails[0].saveInSentItems, true);
  assert(line(mail, "METHOD:REPLY").length === 1 && line(mail, "UID:invite-1").length === 1);
  eq(line(mail, "ATTENDEE"), [`ATTENDEE;PARTSTAT=ACCEPTED:mailto:${OWN}`], "the reply names its author only");
  eq(line(mail, "ORGANIZER"), [`ORGANIZER;CN="Chef":mailto:${CHEF}`]);
  assert(/Accepté|Accept/.test(mail.headers.get("subject")), mail.headers.get("subject"));
  assert(!mail.headers.has("cc") && !mail.headers.has("bcc"));
  eq(w.notices, []);
  eq(await w.scheduler.pending(), 0);
});

test("answer flow: tentative and declined say 2 and 3, and the reply says so", async () => {
  for (const [response, code, partstat] of [["tentative", 2, "TENTATIVE"], ["declined", 3, "DECLINED"]]) {
    const w = world();
    const change = modify(invitation({}, response), invitation(), ASKED);
    const r = await w.scheduler.answer({ client: w.server, change, plan: w.scheduler.plan(change, { version: "14.1" }) });
    eq(r.outcome, "answered");
    eq(r.calendarId, response === "declined" ? null : "7:1", "a declined meeting has no calendar item");
    eq(w.server.meetings[0].userResponse, code);
    await w.deliver();
    eq(line(w.mails()[0], "ATTENDEE"), [`ATTENDEE;PARTSTAT=${partstat}:mailto:${OWN}`]);
  }
});

test("answer flow: on the invitation mail with 12.1 and 14.0, found by the event's UID", async () => {
  for (const version of ["12.1", "14.0"]) {
    const w = world({ version });
    await w.invitations.note(invitationMail());
    w.server.meetingResults.set("1:42", { calendarId: "7:1" });
    const change = modify(invitation({}, "accepted"), invitation(), ASKED);
    const p = w.scheduler.plan(change, { version });
    eq(p.target, "mail");
    eq(await w.scheduler.answer({ client: w.server, change, plan: p }), { outcome: "answered", calendarId: "7:1" });
    eq(w.server.meetings, [{ userResponse: 1, collectionId: "1", requestId: "1:42", instanceId: null }], version);
    await w.deliver();
    eq(w.mails().map((m) => [m.method, m.to]), [["REPLY", [CHEF]]]);
  }
});

test("answer flow: an event added from the invitation bar is answered on the mail, and the server names the calendar item", async () => {
  const w = world();
  await w.invitations.note(invitationMail());
  w.server.meetingResults.set("1:42", { calendarId: "7:900" });
  const change = add(invitation({}, "accepted"), ASKED);
  const p = w.scheduler.plan(change, { version: "14.1" });
  eq(await w.scheduler.answer({ client: w.server, change, plan: p }), { outcome: "answered", calendarId: "7:900" });
  eq(w.server.meetings[0], { userResponse: 1, collectionId: "1", requestId: "1:42", instanceId: null });
});

const REPLY_NOT_SENT = "Votre réponse à « Point hebdomadaire » est enregistrée dans votre agenda, mais aucune réponse n'a été envoyée à l'organisateur : l'invitation est introuvable dans cette boîte.";

test("answer flow: no invitation mail known — nothing is sent, the change is an ordinary one; the user who asked for a reply is told that none left", async () => {
  for (const change of [modify(invitation({}, "accepted"), invitation(), ASKED), modify(invitation({}, "accepted"), invitation()), add(invitation({}, "accepted"), ASKED)]) {
    const w = world({ version: "12.1" });
    const r = await w.scheduler.answer({ client: w.server, change, plan: w.scheduler.plan(change, { version: "12.1" }) });
    eq(r, { outcome: "plain" }, `${change.op}, replyAsked ${change.replyAsked}`);
    eq(w.server.requests.length, 0, "no MeetingResponse, no SendMail");
    // Told only when Thunderbird asked to reply: a status that came with the event, or "Do not send a response", says nothing.
    eq(w.notices, change.replyAsked === true ? [REPLY_NOT_SENT] : [], `${change.op}, replyAsked ${change.replyAsked}`);
    eq(await w.scheduler.pending(), 0, "no reply waits");
    eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 });
  }
  // Mails known for the UID, none for this event (another organizer, another time): the same.
  const w = world({ version: "14.0" });
  await w.invitations.note(invitationMail({ organizer: "eve@evil.example" }));
  await w.invitations.note(invitationMail({ serverId: "1:43", start: "2026-12-01T18:00:00Z" }));
  const change = modify(invitation({}, "tentative"), invitation(), ASKED);
  eq(await w.scheduler.answer({ client: w.server, change, plan: w.scheduler.plan(change, { version: "14.0" }) }), { outcome: "plain" });
  eq([w.server.requests.length, w.notices], [0, [REPLY_NOT_SENT]]);
});

test("answer flow: mail not synchronized — an answer the user gave on an event of the server is undone with an explanation; anything else is an ordinary change; with 14.1 the calendar item needs no mail", async () => {
  const noMail = { mail: false, calendar: true, contacts: false, tasks: false };
  const w = world({ version: "14.0", sync: noMail });
  await w.invitations.note(invitationMail()); // (a table left from the time mail was synchronized is not used)
  const change = modify(invitation({}, "accepted"), invitation(), ASKED);
  eq(await w.scheduler.answer({ client: w.server, change, plan: w.scheduler.plan(change, { version: "14.0" }) }), { outcome: "failed" });
  eq(w.server.requests.length, 0);
  eq(w.notices.length, 1);
  assert(/courrier/.test(w.notices[0]), w.notices[0]);
  // A status that changed without the user asking to reply: nothing to explain, an ordinary change.
  const silent = modify(invitation({}, "accepted"), invitation());
  eq(await w.scheduler.answer({ client: w.server, change: silent, plan: w.scheduler.plan(silent, { version: "14.0" }) }), { outcome: "plain" });
  eq([w.server.requests.length, w.notices.length], [0, 1]);
  const v141 = world({ version: "14.1", sync: noMail });
  eq((await v141.scheduler.answer({ client: v141.server, change, plan: v141.scheduler.plan(change, { version: "14.1" }) })).outcome, "answered");
  // An event added (from another account's mail, from a file): an ordinary Add whatever the version, never undone.
  const added = add(invitation({}, "accepted"), ASKED);
  eq(await v141.scheduler.answer({ client: v141.server, change: added, plan: v141.scheduler.plan(added, { version: "14.1" }) }), { outcome: "plain" });
  eq([v141.server.meetings.length, v141.notices], [1, [REPLY_NOT_SENT]], "told once, for the Add whose reply was asked for");
});

test("answer flow: the reply is sent only when the organizer asked for one", async () => {
  const w = world();
  const quiet = invitation({ meeting: { ...invitation().meeting, responseRequested: false, response: "accepted" } });
  const change = modify(quiet, invitation({ meeting: { ...invitation().meeting, responseRequested: false } }), ASKED);
  const p = w.scheduler.plan(change, { version: "14.1" });
  eq(p.reply, false);
  eq((await w.scheduler.answer({ client: w.server, change, plan: p })).outcome, "answered");
  eq(w.server.meetings.length, 1, "the server still learns the answer");
  eq(await w.scheduler.pending(), 0);
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 });
  eq(w.server.mails.length, 0);
});

test("answer flow: the reply goes to the organizer only, whoever else is invited", async () => {
  const w = world();
  const crowd = invitation({ attendees: [person(OWN), person(A), person(B), person(C)] }, "accepted");
  const change = modify(crowd, invitation({ attendees: [person(OWN), person(A), person(B), person(C)] }), ASKED);
  await w.scheduler.answer({ client: w.server, change, plan: w.scheduler.plan(change, { version: "14.1" }) });
  await w.deliver();
  eq(w.mails().map((m) => m.to), [[CHEF]]);
  eq(line(w.mails()[0], "ATTENDEE").length, 1);
});

test("answer flow: a refusal of the server undoes the answer; a mail that is no invitation any more is forgotten", async () => {
  const w = world({ version: "12.1" });
  await w.invitations.note(invitationMail());
  const change = modify(invitation({}, "accepted"), invitation(), ASKED);
  const p = w.scheduler.plan(change, { version: "12.1" });
  w.server.meetingResults.set("1:42", { status: "3" });
  eq(await w.scheduler.answer({ client: w.server, change, plan: p }), { outcome: "failed" });
  assert(/Status 3/.test(w.notices[0]), w.notices[0]);
  eq((await w.invitations.candidates("invite-1")).length, 1, "a server error says nothing of the mail");
  w.server.meetingResults.set("1:42", { status: "2" });
  eq(await w.scheduler.answer({ client: w.server, change, plan: p }), { outcome: "failed" });
  eq(await w.invitations.candidates("invite-1"), [], "Status 2: that mail is not a meeting request");
  eq(w.notices.length, 2, "told each time: the engine undoes the answer");
  eq(w.server.mails.length, 0);
  eq(await w.scheduler.pending(), 0, "no reply for an answer the server did not take");
});

test("answer flow: an answer the server does not give (empty, other request, command error) is a refusal", async () => {
  const change = modify(invitation({}, "accepted"), invitation(), ASKED);
  const { el } = await import("../../src/core/wbxml.mjs");
  for (const answer of [
    null,
    el("MeetingResponse:MeetingResponse", []),
    el("MeetingResponse:MeetingResponse", [el("Result", [el("RequestId", "7:999"), el("Status", "1")])]),
    el("MeetingResponse:MeetingResponse", [el("Status", "110")]),
    el("MeetingResponse:MeetingResponse", [el("Result", [el("RequestId", "7:1"), el("Status", "1")]), el("Result", [el("RequestId", "7:1"), el("Status", "1")])]),
  ]) {
    const w = world();
    w.server.hook("MeetingResponse", () => answer);
    eq(await w.scheduler.answer({ client: w.server, change, plan: w.scheduler.plan(change, { version: "14.1" }) }), { outcome: "failed" });
    eq(w.notices.length, 1);
    eq(await w.scheduler.pending(), 0);
  }
});

test("answer flow: a lost connection is thrown — the change stays to send, nothing is queued, nobody is told", async () => {
  const w = world();
  const change = modify(invitation({}, "accepted"), invitation(), ASKED);
  w.server.hook("MeetingResponse", () => {
    throw new EasError(ERR.NETWORK, "Serveur injoignable.");
  });
  await rejects(() => w.scheduler.answer({ client: w.server, change, plan: w.scheduler.plan(change, { version: "14.1" }) }), (e) => e.code === ERR.NETWORK);
  eq([w.notices.length, await w.scheduler.pending()], [0, 0]);
});

test("answer flow: refuses to run on a change that is not an answer", async () => {
  const w = world();
  const change = add(meeting([A]));
  await rejects(() => w.scheduler.answer({ client: w.server, change, plan: w.scheduler.plan(change, { version: "14.1" }) }), TypeError);
  eq(w.server.requests.length, 0);
});

test("organize flow: a new meeting — the user is asked, then one invitation goes to every attendee, with a copy in Sent Items", async () => {
  const w = world({ senderName: "Moi Même" });
  const item = meeting([A, person(B, { name: "Bruno", role: "optional" })], { summary: "Revue de budget", location: "Salle 2" });
  const r = await w.organize(add(item));
  eq([r.sequence, r.queued, r.item.sequence], [0, 1, 0], "an invitation does not raise SEQUENCE");
  eq(w.server.requests.length, 0, "nothing leaves before the user is asked");
  eq(await w.deliver(), { sent: 1, declined: 0, failed: 0, uncertain: 0 });
  eq(w.asked, [{ kind: "invite", summary: "Revue de budget", start: "2026-12-01T09:00:00Z", allDay: false, recipients: [A, B], from: OWN }], "what the window shows: the message, its recipients, and the mailbox that sends");
  eq(w.server.mails.length, 1, "one message for all the attendees");
  eq(w.server.mails[0].saveInSentItems, true);
  assert(/^[0-9a-f]{32}$/.test(w.server.mails[0].clientId));
  const [mail] = w.mails();
  eq([mail.method, mail.to, mail.from], ["REQUEST", [A, B], [OWN]]);
  assert(mail.headers.get("from").includes("Moi"), mail.headers.get("from"));
  assert(mail.headers.get("subject").includes("Revue de budget"));
  assert(/@example\.com>$/.test(mail.headers.get("message-id")), mail.headers.get("message-id"));
  eq(line(mail, "SEQUENCE"), ["SEQUENCE:0"]);
  assert(line(mail, "ORGANIZER")[0].endsWith(`mailto:${OWN}`), "the organizer is the mailbox's own address");
  eq(line(mail, "ATTENDEE").map((l) => l.slice(l.lastIndexOf("mailto:") + 7)), [A, B]);
  assert(mail.text.includes("Revue de budget") && mail.text.includes("Salle 2"), mail.text);
  eq(w.notices, []);
});

test("organize flow: Don't send, a closed window, or a question that fails — nothing is sent, nothing is said, nothing waits", async () => {
  for (const answer of [false, undefined, null, "yes", 1, new Error("fenêtre fermée")]) {
    const w = world();
    w.send = answer;
    const r = await w.organize(add(meeting([A, B])));
    eq(r.queued, 1);
    eq(await w.deliver(), { sent: 0, declined: 1, failed: 0, uncertain: 0 });
    eq(w.asked.length, 1);
    eq(w.server.requests.length, 0, `answer ${String(answer)}: only true sends`);
    eq(w.notices, []);
    eq(await w.scheduler.pending(), 0);
    w.send = true;
    eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 }, "the question is not asked again later");
    eq(w.asked.length, 1);
  }
});

test("organize flow: an update raises SEQUENCE by one, gives it back to store, and sends a REQUEST", async () => {
  const w = world();
  const before = meeting([A, B], { sequence: 4 });
  const r = await w.organize(modify({ ...before, sequence: 2, location: "Salle 9" }, before));
  eq([r.sequence, r.item.sequence, r.item.location], [5, 5, "Salle 9"], "one more than the highest known, to store as synchronized");
  checkEvent(r.item);
  await w.deliver();
  eq(w.asked[0].kind, "update");
  const [mail] = w.mails();
  eq([mail.method, line(mail, "SEQUENCE"), mail.to], ["REQUEST", ["SEQUENCE:5"], [A, B]]);
  assert(line(mail, "LOCATION")[0].includes("Salle 9"));
});

test("organize flow: a deleted meeting gives a CANCEL with a higher SEQUENCE, from the last synchronized description", async () => {
  const w = world();
  const r = await w.organize(del(meeting([A, B], { sequence: 2, summary: "Comité" })));
  eq([r.item, r.sequence], [null, 3]);
  await w.deliver();
  eq(w.asked, [{ kind: "cancel", summary: "Comité", start: "2026-12-01T09:00:00Z", allDay: false, recipients: [A, B], from: OWN }]);
  const [mail] = w.mails();
  eq([mail.method, mail.to, line(mail, "SEQUENCE"), line(mail, "STATUS")], ["CANCEL", [A, B], ["SEQUENCE:3"], ["STATUS:CANCELLED"]]);
});

test("organize flow: a removed attendee gets the cancellation, the others the update — two messages, each asked for, each sent once", async () => {
  const w = world();
  const before = meeting([A, B, C]);
  const r = await w.organize(modify(meeting([A, C], { location: "Salle 9" }), before));
  eq([r.queued, r.sequence], [2, 1]);
  eq(await w.deliver(), { sent: 2, declined: 0, failed: 0, uncertain: 0 });
  eq(w.asked.map((q) => [q.kind, q.recipients]), [["update", [A, C]], ["cancel", [B]]]);
  const [update, cancel] = w.mails();
  eq([update.method, update.to, cancel.method, cancel.to], ["REQUEST", [A, C], "CANCEL", [B]]);
  eq(line(cancel, "ATTENDEE").map((l) => l.slice(l.lastIndexOf("mailto:") + 7)), [B], "the cancellation names the removed attendee only");
  eq(line(cancel, "STATUS"), [], "the meeting goes on: it is not cancelled for everyone");
  eq([line(update, "SEQUENCE"), line(cancel, "SEQUENCE")], [["SEQUENCE:1"], ["SEQUENCE:1"]]);
  eq(w.server.mails.length, 2);
});

test("organize flow: the user may send the update and not the cancellation (each message is its own question)", async () => {
  const w = world();
  await w.organize(modify(meeting([A]), meeting([A, B])));
  const answers = [true, false];
  w.scheduler = new Scheduler({ mailbox: w.mailbox, records: w.records, invitations: w.invitations, confirm: async (q) => (w.asked.push(q), answers.shift()), notify: (m) => w.notices.push(m), now: () => w.clock.now, random: (n) => new Uint8Array(n).fill(7) });
  eq(await w.deliver(), { sent: 1, declined: 1, failed: 0, uncertain: 0 });
  eq(w.mails().map((m) => [m.method, m.to]), [["REQUEST", [A]]]);
});

test("organize flow: one occurrence — the message names it (RECURRENCE-ID) and the question shows its start", async () => {
  const w = world();
  const first = "2026-12-08T09:00:00Z";
  const base = series([A, B]);
  await w.organize(modify(series([A, B], [exception(first, { start: "2026-12-08T14:00:00Z", end: "2026-12-08T15:00:00Z" })]), base));
  await w.organize(modify(series([A, B], [exception(first, {}, true)]), base, { changeId: "c2" }));
  eq(await w.deliver(), { sent: 2, declined: 0, failed: 0, uncertain: 0 });
  eq(w.asked.map((q) => [q.kind, q.start]), [["update", "2026-12-08T14:00:00Z"], ["cancel", first]]);
  const [moved, cancelled] = w.mails();
  eq([moved.method, line(moved, "RECURRENCE-ID"), line(moved, "DTSTART")], ["REQUEST", ["RECURRENCE-ID:20261208T090000Z"], ["DTSTART:20261208T140000Z"]]);
  eq(line(moved, "RRULE"), [], "the occurrence alone, not the series");
  eq([cancelled.method, line(cancelled, "RECURRENCE-ID"), line(cancelled, "STATUS")], ["CANCEL", ["RECURRENCE-ID:20261208T090000Z"], ["STATUS:CANCELLED"]]);
});

test("organize flow: an all-day meeting is asked for with its day", async () => {
  const w = world();
  await w.organize(add(meeting([A], { allDay: true, start: "2026-12-24", end: "2026-12-25" })));
  await w.deliver();
  eq([w.asked[0].start, w.asked[0].allDay], ["2026-12-24", true]);
  eq(line(w.mails()[0], "DTSTART"), ["DTSTART;VALUE=DATE:20261224"]);
});

test("organize flow: a sending the server refuses is told once and never retried", async () => {
  const w = world();
  w.server.sendStatus = "120";
  await w.organize(add(meeting([A, B], { summary: "Revue de budget" })));
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 1, uncertain: 0 });
  eq(w.notices.length, 1);
  assert(w.notices[0].includes("Revue de budget") && w.notices[0].includes("Status 120"), w.notices[0]);
  w.server.sendStatus = null;
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 });
  eq(await w.make().deliver({ client: w.server }), { sent: 0, declined: 0, failed: 0, uncertain: 0 }, "nor after a restart");
  eq([w.server.mails.length, w.asked.length, w.notices.length], [1, 1, 1]);
});

test("organize flow: a failure before anything left is told as not sent, and not retried", async () => {
  const w = world();
  w.server.hook("SendMail", () => {
    throw new EasError(ERR.TLS, "Certificat refusé.");
  });
  await w.organize(add(meeting([A])));
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 1, uncertain: 0 });
  assert(/n'a pas été envoyé|not sent/.test(w.notices[0]), w.notices[0]);
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 });
  eq(w.server.sent("SendMail").length, 1);
});

test("organize flow: a connection lost after the request left is told as uncertain, and never sent again", async () => {
  for (const code of [ERR.NETWORK, ERR.TIMEOUT, ERR.BAD_RESPONSE, ERR.CANCELLED]) {
    const w = world();
    w.server.loseNextResponse("SendMail");
    if (code !== ERR.NETWORK) {
      w.server.hooks.length = 0;
      w.server.hook("SendMail", () => {
        throw new EasError(code, "Coupure.", { sent: true });
      });
    }
    await w.organize(add(meeting([A, B])));
    eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 1 }, code);
    eq(w.notices.length, 1);
    assert(/peut-être|may not/.test(w.notices[0]), w.notices[0]);
    eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 });
    eq(await w.make().deliver({ client: w.server }), { sent: 0, declined: 0, failed: 0, uncertain: 0 });
    eq(w.server.sent("SendMail").length, 1, "one attempt, whatever happened to it");
  }
});

test("organize flow: an answer of the server that cannot be read is uncertain too", async () => {
  const w = world();
  const { el } = await import("../../src/core/wbxml.mjs");
  w.server.hook("SendMail", () => el("ComposeMail:SendMail", [el("Status", "pas un nombre")]));
  await w.organize(add(meeting([A])));
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 1 });
});

test("organize flow: Thunderbird stopped while a message was leaving — told as uncertain at the next start, never sent again", async () => {
  const w = world();
  await w.organize(add(meeting([A, B], { summary: "Comité" })));
  let during = null;
  w.server.hook("SendMail", async () => {
    during = await w.records.get("meetingOutbox", null); // what a crash at this instant would leave
    return undefined;
  });
  await w.deliver();
  eq(during.entries.map((e) => e.state), ["sending"], "marked before the request leaves");
  eq(w.server.mails.length, 1);
  // The same storage as it was during the sending, read by a new instance.
  const area = memoryArea();
  const crashed = world({ area });
  await crashed.records.set("meetingOutbox", during);
  eq(await crashed.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 1 });
  eq(crashed.server.requests.length, 0, "not sent a second time");
  eq(crashed.asked.length, 0, "and not asked for again");
  assert(crashed.notices[0].includes("Comité"));
  eq(await crashed.scheduler.pending(), 0);
});

test("organize flow: what waits survives a restart, and is asked for then", async () => {
  const w = world();
  await w.organize(add(meeting([A])));
  const later = w.make();
  eq(await later.pending(), 1);
  eq(await later.deliver({ client: w.server }), { sent: 1, declined: 0, failed: 0, uncertain: 0 });
  eq(w.asked.length, 1);
});

test("organize flow: the same change queued again (a replayed request) gives no second message, before or after it was settled", async () => {
  const w = world();
  const change = add(meeting([A]));
  eq((await w.organize(change)).queued, 1);
  eq((await w.organize(change)).queued, 0, "already waiting");
  eq(await w.scheduler.pending(), 1);
  await w.deliver();
  eq((await w.organize(change)).queued, 0, "already sent");
  eq((await w.make().enqueue({ key: "7|c1", change, plan: w.scheduler.plan(change, { version: "14.1" }) })).queued, 0, "even after a restart");
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 });
  eq([w.server.mails.length, w.asked.length], [1, 1]);
  eq((await w.organize(change, "7|c2")).queued, 1, "another change is another message");
});

test("organize flow: cancelled before the message left — it stays queued and is asked for again; nothing is sent meanwhile", async () => {
  const w = world();
  await w.organize(add(meeting([A])));
  const ctrl = new AbortController();
  w.server.hook("SendMail", () => {
    throw new EasError(ERR.CANCELLED, "Requête annulée.");
  });
  await rejects(() => w.deliver({ signal: ctrl.signal }), (e) => e.code === ERR.CANCELLED);
  eq(await w.scheduler.pending(), 1);
  eq(w.notices, []);
  ctrl.abort();
  await rejects(() => w.deliver({ signal: ctrl.signal }), (e) => e.code === ERR.CANCELLED);
  eq(await w.deliver(), { sent: 1, declined: 0, failed: 0, uncertain: 0 });
  eq(w.asked.length, 2, "asked again: the first yes was for a sending that did not happen");
  eq(w.server.mails.length, 1);
});

test("organize flow: cancelled while its question is open — no answer, the message stays queued, whatever the window says later", async () => {
  const w = world();
  await w.organize(add(meeting([A])));
  const answers = [];
  const scheduler = new Scheduler({
    mailbox: w.mailbox,
    records: w.records,
    invitations: w.invitations,
    confirm: (question) => new Promise((resolve) => answers.push({ question, resolve })), // a window the user leaves open
    notify: (m) => w.notices.push(m),
    now: () => w.clock.now,
  });
  for (const late of [false, true]) {
    const ctrl = new AbortController();
    const delivery = scheduler.deliver({ client: w.server, signal: ctrl.signal });
    for (let i = 0; i < 50 && !answers.length; i++) await Promise.resolve();
    eq(answers.length, 1, "the question is open");
    ctrl.abort(); // the engine stops (the mailbox is edited, Thunderbird quits)
    await rejects(() => delivery, (e) => e.code === ERR.CANCELLED, "given up at once: nobody waits for the window");
    answers.pop().resolve(late); // what the window says once it is closed, or even "Send", counts for nothing
    for (let i = 0; i < 50; i++) await Promise.resolve();
    eq([await scheduler.pending(), w.server.mails.length, w.notices.length], [1, 0, 0], `still queued, nothing sent (late answer: ${late})`);
  }
  eq(await w.deliver(), { sent: 1, declined: 0, failed: 0, uncertain: 0 }, "the next engine asks again, and the user's yes sends it once");
  eq(w.server.mails.length, 1);
});

test("organize flow: a message that cannot be written is told as not sent (no request)", async () => {
  const w = world();
  w.scheduler = new Scheduler({ mailbox: w.mailbox, records: w.records, invitations: w.invitations, confirm: async () => true, notify: (m) => w.notices.push(m), now: () => w.clock.now, random: () => new Uint8Array(3) });
  await w.organize(add(meeting([A])));
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 1, uncertain: 0 });
  eq([w.server.requests.length, w.notices.length], [0, 1]);
});

test("organize flow: at most MAX_OUTBOX messages wait; beyond, the user is told and nothing is queued", async () => {
  const w = world();
  for (let i = 0; i < MAX_OUTBOX; i++) eq((await w.organize(add(meeting([A]), { changeId: `c${i}` }))).queued, 1);
  const r = await w.organize(add(meeting([A], { summary: "De trop" }), { changeId: "last" }));
  eq(r.queued, 0);
  eq(w.notices, ["Le message de réunion pour « De trop » n'a pas été envoyé : trop de messages sont en attente. L'événement est enregistré, mais les participants n'ont pas été informés."]);
  eq(await w.scheduler.pending(), MAX_OUTBOX);
  // A reply that finds the queue full is not dropped without a word either: the server took the answer, the organizer was not told.
  const answer = modify(invitation({ summary: "Réponse de trop" }, "accepted"), invitation({ summary: "Réponse de trop" }), ASKED);
  eq((await w.scheduler.answer({ client: w.server, change: answer, plan: w.scheduler.plan(answer, { version: "14.1" }) })).outcome, "answered");
  eq(w.notices.length, 2);
  assert(w.notices[1].includes("Réponse de trop") && /trop de messages sont en attente/.test(w.notices[1]), w.notices[1]);
  eq(await w.scheduler.pending(), MAX_OUTBOX);
});

test("organize flow: stored entries are checked like anything read back — no message to more than 100 people, none in someone else's name, no reply to anyone but the organizer", async () => {
  const at = Date.UTC(2026, 10, 16, 8, 0, 0); // an hour before the clock of world()
  const good = { key: "k", kind: "invite", recipients: [{ email: A, name: "", role: "required" }], occurrence: null, event: meeting([A]), sequence: 0, state: "new", at };
  const hostile = [
    { ...good, key: "many", recipients: Array.from({ length: 101 }, (_, i) => ({ email: `p${i}@example.org`, name: "", role: "required" })) },
    { ...good, key: "none", recipients: [] },
    { ...good, key: "bad-address", recipients: [{ email: "pas une adresse", name: "", role: "required" }] },
    { ...good, key: "other-organizer", event: invitation() },
    { ...good, key: "no-organizer", event: event() },
    { ...good, key: "bad-event", event: { ...meeting([A]), start: "demain" } },
    { ...good, key: "bad-kind", kind: "forward" },
    { ...good, key: "bad-sequence", sequence: -1 },
    { ...good, key: "reply-elsewhere", kind: "accepted", recipients: [{ email: A, name: "", role: "required" }], event: invitation({}, "accepted") },
    { ...good, key: "reply-to-two", kind: "accepted", recipients: [{ email: CHEF, name: "" }, { email: A, name: "" }], event: invitation({}, "accepted") },
    "pas une entrée",
    null,
  ];
  const w = world();
  await w.records.set("meetingOutbox", { v: 1, entries: [...hostile, good], settled: [] });
  eq(await w.scheduler.pending(), 1, "only the valid entry is kept");
  eq(await w.deliver(), { sent: 1, declined: 0, failed: 0, uncertain: 0 });
  eq(w.mails().map((m) => m.to), [[A]]);
  const broken = world();
  await broken.records.set("meetingOutbox", "n'importe quoi");
  eq(await broken.scheduler.pending(), 0);
});

test("organize flow: enqueue refuses a change that has no message", async () => {
  const w = world();
  const change = add(event());
  await rejects(() => w.scheduler.enqueue({ key: "k", change, plan: w.scheduler.plan(change, { version: "14.1" }) }), TypeError);
});

// ── After the security audit (stage 4) ────────────────────────────────────

test("audit B-1, planChange: a reply needs the user's answer — never a status alone, whatever the statuses say", () => {
  const pending = invitation();
  const statuses = ["accepted", "tentative", "declined"];
  for (const version of ["12.1", "14.0", "14.1"]) {
    for (const response of statuses) {
      // Every shape of change that says "the user's status is now this": changed on an event of the server, or added with it.
      const shapes = [modify(invitation({}, response), pending), modify(invitation({}, response), invitation({}, "none")), add(invitation({}, response))];
      for (const base of shapes) {
        for (const replyAsked of [undefined, false, null, 0, 1, "true", "yes", {}, []]) {
          const change = { ...base, replyAsked };
          if (replyAsked === undefined) delete change.replyAsked;
          const p = plan(change, version);
          // On an event the server holds, the server is told and nobody else. An event added with a status
          // already in it is not an answer at all: a plain Add, without MeetingResponse.
          if (base.op === "add") eq(p, { flow: "plain" }, `${version} add ${response}, replyAsked ${JSON.stringify(replyAsked)}: a plain Add`);
          else eq([p.flow, p.reply], ["answer", false], `${version} ${base.op} ${response}, replyAsked ${JSON.stringify(replyAsked)}: no reply`);
        }
        eq(plan({ ...base, replyAsked: true }, version).reply, true, `${version} ${base.op} ${response}: the user answered`);
      }
    }
  }
  // Asked, but the organizer wants no answer: no reply either.
  const quiet = { ...invitation().meeting, responseRequested: false };
  for (const responseRequested of [false, undefined, null, "true", 1]) {
    const item = invitation({ meeting: { ...quiet, responseRequested, response: "accepted" } });
    eq(plan(modify(item, invitation({ meeting: quiet }), ASKED)).reply, false, `responseRequested ${JSON.stringify(responseRequested)}`);
    eq(plan(add(item, ASKED)).reply, false);
  }
  // Asked on a change that is no answer (the status did not change): nothing at all.
  eq(plan(modify(invitation({ reminder: 5 }, "accepted"), invitation({}, "accepted"), ASKED)), { flow: "plain" });
  eq(plan(add(invitation(), ASKED)), { flow: "plain" });
});

test("audit B-1, flow: without replyAsked the server is told and nobody else — no REPLY, no question, whatever the statuses say", async () => {
  for (const version of ["12.1", "14.1"]) {
    for (const replyAsked of [undefined, false]) {
      const w = world({ version });
      await w.invitations.note(invitationMail());
      w.server.meetingResults.set("1:42", { calendarId: "7:1" });
      const change = modify(invitation({}, "accepted"), invitation(), { replyAsked });
      if (replyAsked === undefined) delete change.replyAsked;
      const p = w.scheduler.plan(change, { version });
      eq(p.reply, false);
      eq((await w.scheduler.answer({ client: w.server, change, plan: p })).outcome, "answered");
      eq(w.server.meetings.length, 1, "MeetingResponse: the user's calendar on the server follows (it sends nothing to anyone)");
      eq(await w.scheduler.pending(), 0, "no reply is queued");
      eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 });
      eq([w.server.mails.length, w.server.sent("SendMail").length, w.asked.length, w.notices.length], [0, 0, 0, 0], `${version}, replyAsked ${replyAsked}`);
    }
  }
});

test("audit B-1, flow: a plan that says reply is not enough — the change itself must say that the user answered", async () => {
  const w = world();
  const asked = modify(invitation({}, "accepted"), invitation(), ASKED);
  const plan = w.scheduler.plan(asked, { version: "14.1" });
  eq(plan.reply, true);
  // The same plan, given with a change that does not carry the mark (a caller that lost it, or made the plan from another entry).
  for (const change of [modify(invitation({}, "accepted"), invitation()), { ...asked, replyAsked: "true" }, { ...asked, replyAsked: undefined }]) {
    eq((await w.scheduler.answer({ client: w.server, change, plan })).outcome, "answered");
    eq(await w.scheduler.pending(), 0);
  }
  await w.deliver();
  eq(w.server.mails.length, 0);
});

test("audit B-1 / N1, flow: an event added with a status already in it is a plain Add, even when a matching invitation mail is known — no MeetingResponse, no REPLY", async () => {
  // "Add to calendar" on a published event, or an imported file: the sender wrote the user as having accepted,
  // with an organizer of their choice who asks for an answer; an ordinary invitation with the same UID,
  // organizer and start was sent first, so that a mail is known for it.
  const published = invitation({ uid: "publié-1", organizer: { email: "third-party@victim.example", name: "Victime" } }, "accepted");
  for (const version of ["12.1", "14.0", "14.1"]) {
    for (const replyAsked of [undefined, false, "true", 1]) {
      const w = world({ version });
      await w.invitations.note(invitationMail({ uid: "publié-1", organizer: "third-party@victim.example" }));
      const change = add(published, { replyAsked });
      const p = w.scheduler.plan(change, { version });
      eq(p, { flow: "plain" }, `${version}, replyAsked ${JSON.stringify(replyAsked)}`);
      // The flows refuse it: there is no answer to give.
      await rejects(() => w.scheduler.answer({ client: w.server, change, plan: p }), TypeError);
      await w.deliver();
      eq([w.server.requests.length, w.server.meetings.length, w.server.mails.length, w.asked.length, w.notices.length, await w.scheduler.pending()], [0, 0, 0, 0, 0, 0]);
    }
  }
  // Added from the invitation bar with an answer (Thunderbird asked to reply): the answer flow, as before.
  const w = world({ version: "12.1" });
  await w.invitations.note(invitationMail());
  const change = add(invitation({}, "accepted"), ASKED);
  eq((await w.scheduler.answer({ client: w.server, change, plan: w.scheduler.plan(change, { version: "12.1" }) })).outcome, "answered");
  eq(w.server.meetings.length, 1);
});

test("audit B-1, flow: exactly one REPLY, to the organizer only, when the user answered and a response was requested", async () => {
  for (const version of ["12.1", "14.0", "14.1"]) {
    for (const base of [modify(invitation({ attendees: [person(OWN), person(A), person(B)] }, "accepted"), invitation({ attendees: [person(OWN), person(A), person(B)] })), add(invitation({ attendees: [person(OWN), person(A), person(B)] }, "accepted"))]) {
      const w = world({ version });
      await w.invitations.note(invitationMail());
      w.server.meetingResults.set("1:42", { calendarId: "7:1" });
      const change = { ...base, replyAsked: true };
      const p = w.scheduler.plan(change, { version });
      eq(p.reply, true);
      eq((await w.scheduler.answer({ client: w.server, change, plan: p })).outcome, "answered");
      eq(await w.scheduler.pending(), 1);
      eq(await w.deliver(), { sent: 1, declined: 0, failed: 0, uncertain: 0 });
      eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 }, "once");
      eq(w.server.sent("SendMail").length, 1, `${version} ${base.op}: one SendMail`);
      const [mail] = w.mails();
      eq([mail.method, mail.to, mail.headers.get("to")], ["REPLY", [CHEF], CHEF], "to the organizer, by address alone");
      assert(!mail.headers.has("cc") && !mail.headers.has("bcc"));
      eq(line(mail, "ATTENDEE"), [`ATTENDEE;PARTSTAT=ACCEPTED:mailto:${OWN}`]);
      eq(w.asked, [], "no question: answering was the user's own act");
    }
  }
});

test("audit B-2: a later mail with the same UID cannot take the user's answer over, nor block it", async () => {
  for (const version of ["12.1", "14.0"]) {
    const w = world({ version });
    await w.invitations.note(invitationMail()); // the real invitation
    await w.invitations.note(invitationMail({ serverId: "1:200", start: "2026-12-01T18:00:00Z" })); // forged: same UID, another time
    await w.invitations.note(invitationMail({ serverId: "1:201", organizer: "eve@evil.example" })); // forged: another organizer
    w.server.meetingResults.set("1:42", { calendarId: "7:1" });
    w.server.meetingResults.set("1:200", { calendarId: "7:666" });
    w.server.meetingResults.set("1:201", { calendarId: "7:667" });
    const change = modify(invitation({}, "accepted"), invitation(), ASKED);
    const p = w.scheduler.plan(change, { version });
    eq(await w.scheduler.answer({ client: w.server, change, plan: p }), { outcome: "answered", calendarId: "7:1" }, "the later mails neither receive the answer nor keep it from the real one");
    eq(w.server.meetings, [{ userResponse: 1, collectionId: "1", requestId: "1:42", instanceId: null }], version);
    eq(w.notices, []);
    // The real invitation gone, no mail is named: never one of the others.
    await w.invitations.forget("1", "1:42");
    eq(await w.scheduler.answer({ client: w.server, change, plan: p }), { outcome: "plain" });
    eq([w.server.meetings.length, w.notices.length], [1, 1], "nothing more was sent; the user who answered is told that no reply left");
  }
  // A mail that agrees with the event on the UID alone is not named for it: another organizer, or another start than the event's.
  for (const over of [{ organizer: "eve@evil.example" }, { start: "2026-12-01T18:00:00Z" }, { organizer: null }, { start: null }]) {
    const w = world({ version: "12.1" });
    await w.invitations.note(invitationMail(over));
    const added = add(invitation({}, "accepted"), ASKED);
    eq(await w.scheduler.answer({ client: w.server, change: added, plan: w.scheduler.plan(added, { version: "12.1" }) }), { outcome: "plain" }, JSON.stringify(over));
    eq(w.server.requests.length, 0);
  }
  // A meeting its organizer moved: the answer to the event at its new time names the mail for that time, not the first one.
  const moved = world({ version: "12.1" });
  await moved.invitations.note(invitationMail());
  await moved.invitations.note(invitationMail({ serverId: "1:50", start: "2026-12-03T09:00:00Z" }));
  moved.server.meetingResults.set("1:50", { calendarId: "7:1" });
  const later = (response) => invitation({ start: "2026-12-03T09:00:00Z", end: "2026-12-03T10:00:00Z" }, response);
  const again = modify(later("accepted"), later("not-responded"), ASKED);
  eq((await moved.scheduler.answer({ client: moved.server, change: again, plan: moved.scheduler.plan(again, { version: "12.1" }) })).outcome, "answered");
  eq(moved.server.meetings.map((m) => m.requestId), ["1:50"]);
  // With 14.1 an event the server holds is answered on the calendar item itself: no mail is involved, forged or not.
  const w = world({ version: "14.1" });
  await w.invitations.note(invitationMail({ serverId: "1:200", start: "2026-12-01T18:00:00Z" }));
  const change = modify(invitation({}, "accepted"), invitation(), ASKED);
  eq(await w.scheduler.answer({ client: w.server, change, plan: w.scheduler.plan(change, { version: "14.1" }) }), { outcome: "answered", calendarId: "7:1" });
  eq(w.server.meetings[0].requestId, "7:1");
  // An all-day meeting: the event's day against the day the mail gives.
  const day = world({ version: "12.1" });
  await day.invitations.note(invitationMail({ start: "2026-12-24" }));
  day.server.meetingResults.set("1:42", { calendarId: "7:1" });
  const allDay = (response) => invitation({ allDay: true, start: "2026-12-24", end: "2026-12-25" }, response);
  const whole = modify(allDay("accepted"), allDay("not-responded"), ASKED);
  eq((await day.scheduler.answer({ client: day.server, change: whole, plan: day.scheduler.plan(whole, { version: "12.1" }) })).outcome, "answered");
});

test("audit B-3, B-4: nothing is planned, queued or sent from a change the server rewrote while it waited", async () => {
  const REWRITTEN = { rewritten: true };
  // Every flow: an answer (the server put "not answered" back under an unrelated change of the user's), and every
  // message of a meeting the user organizes (the server added attendees to its copy under the user's reminder).
  const many = Array.from({ length: 40 }, (_, i) => `inconnu${i}@example.org`);
  const rows = [
    ["an answer", modify(invitation({ reminder: 10 }, "accepted"), invitation(), { ...ASKED })],
    ["an answer added", add(invitation({}, "accepted"), { ...ASKED })],
    ["attendees the server added, read as removed by the user", modify(meeting([A, B], { reminder: 10 }), meeting([A, B, ...many]))],
    ["an invitation", add(meeting([A, B]))],
    ["an update", modify(meeting([A, B], { location: "Salle 9" }), meeting([A, B]))],
    ["a cancellation", del(meeting([A, B]))],
    ["a refusal for too many attendees", modify(meeting([...many, ...many.map((m) => `x${m}`), ...many.map((m) => `y${m}`)], { location: "Ailleurs" }), meeting([A]))],
  ];
  for (const [name, change] of rows) {
    assert(plan(change).flow !== "plain", `${name}: without the mark, this change has something to send`);
    eq(plan({ ...change, ...REWRITTEN }), { flow: "plain" }, name);
    for (const version of ["12.1", "14.0", "14.1"]) eq(plan({ ...change, ...REWRITTEN }, version), { flow: "plain" }, `${name}, ${version}`);
  }
  // Only the mark itself counts.
  for (const rewritten of [false, undefined, null, 0, "true", 1]) assert(plan({ ...rows[4][1], rewritten }).flow === "organize", `rewritten ${JSON.stringify(rewritten)}`);

  // Second line of defence: a caller that still comes with a plan made before the mark (or from another entry).
  const w = world();
  const answer = modify(invitation({ summary: "Comité" }, "accepted"), invitation({ summary: "Comité" }), ASKED);
  const answerPlan = w.scheduler.plan(answer, { version: "14.1" });
  eq(await w.scheduler.answer({ client: w.server, change: { ...answer, ...REWRITTEN }, plan: answerPlan }), { outcome: "failed" }, "the engine undoes it: the server's version is shown");
  eq(w.server.requests.length, 0, "no MeetingResponse");
  eq(w.notices, ["« Comité » a été modifié sur le serveur avant l'envoi de votre modification. La version du serveur est affichée ; votre modification n'a pas été envoyée."]);
  const update = modify(meeting([A], { location: "Salle 9", sequence: 3 }), meeting([A, B], { sequence: 3 }));
  const updatePlan = w.scheduler.plan(update, { version: "14.1" });
  eq(updatePlan.messages.length, 2);
  const r = await w.scheduler.enqueue({ key: "7|k1|c1", change: { ...update, ...REWRITTEN }, plan: updatePlan });
  eq([r.queued, r.sequence, r.item.sequence], [0, 3, 3], "nothing recorded, SEQUENCE not raised");
  eq(await w.scheduler.pending(), 0);
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 });
  eq([w.asked.length, w.server.requests.length], [0, 0], "the user is asked nothing, nothing leaves");
});

test("audit B-5: a change that replaces the organizer sends nothing, and the user is told once", async () => {
  const forger = { email: "eve@evil.example", name: "Eve" };
  const victims = Array.from({ length: 30 }, (_, i) => `victime${i}@example.org`);
  const theirs = invitation();
  const rows = [
    // An update accepted from a mail made the user the organizer, with the sender's list of attendees: no invitation to them.
    ["someone else's meeting becomes mine", modify(meeting(victims, { uid: "invite-1" }), theirs)],
    // The organizer becomes the sender while the user accepts: no reply to that address, no MeetingResponse.
    ["the organizer is replaced while I accept", modify(invitation({ organizer: forger }, "accepted"), theirs, ASKED)],
    ["my meeting is given to someone else", modify(invitation({ organizer: forger, attendees: [person(OWN), person(A)] }), meeting([A]))],
    ["someone else's meeting loses its organizer", modify(event({ uid: "invite-1", attendees: [person(OWN)] }), theirs)],
  ];
  for (const [name, change] of rows) {
    eq(plan(change), { flow: "plain", notice: "organizerChanged" }, name);
    for (const version of ["12.1", "14.0"]) eq(plan(change, version).flow, "plain", `${name}, ${version}`);
  }
  // The same organizer, whatever the case of the address or the name given with it: nothing changed.
  const renamed = modify(invitation({ organizer: { email: "CHEF@Example.org", name: "Le Chef" } }, "accepted"), theirs, ASKED);
  eq(brief(plan(renamed)), "answer:accepted:item:reply");
  eq(brief(plan(modify(meeting([A, B], { organizer: { email: OWN.toUpperCase(), name: "Moi" }, location: "Salle 9" }), meeting([A, B])))), "update>anne,bruno");
  // No organizer before: attendees given to an appointment is the user's own invitation, as ever.
  eq(brief(plan(modify(meeting([A, B]), event()))), "invite>anne,bruno");
  eq(brief(plan(modify(meeting([A, B]), event({ organizer: { email: "pas une adresse", name: "" } })))), "invite>anne,bruno", "an organizer that is no address was none");
  // The user's own meeting left without an organizer is the user's own doing, not a replaced organizer (next test).
  assert(plan(modify(event({ reminder: 5 }), meeting([A, B]))).notice === undefined);
  // An event nobody else is part of: nothing would have been sent, nothing to tell.
  eq(plan(modify(event({ reminder: 5 }), meeting([]))), { flow: "plain" });
  // Adds and deletes are not concerned (nothing to compare an Add with; a delete names the organizer the server knew).
  eq(brief(plan(del(theirs))), "plain");

  // The scheduler tells the user, once for a change however often it is planned (triage, then the acknowledgement, then the next passes).
  const w = world();
  const change = { ...rows[0][1], changeId: "c7" };
  for (let i = 0; i < 4; i++) eq(w.scheduler.plan(change, { version: "14.1" }).flow, "plain");
  eq(w.notices, ["L'organisateur de « Point hebdomadaire » a été modifié dans Thunderbird : aucun message n'a été envoyé aux participants."]);
  w.scheduler.plan({ ...change, changeId: "c8" }, { version: "14.1" });
  eq(w.notices.length, 2, "another change of the same event is told too");
  w.scheduler.plan(rows[1][1], { version: "12.1" });
  eq(w.notices.length, 3);
  // Nothing was queued, asked or sent, and the flows refuse such a plan.
  eq([await w.scheduler.pending(), w.asked.length, w.server.requests.length], [0, 0, 0]);
  await rejects(() => w.scheduler.answer({ client: w.server, change: rows[1][1], plan: w.scheduler.plan(rows[1][1], { version: "12.1" }) }), TypeError);
  await rejects(() => w.scheduler.enqueue({ key: "k", change, plan: w.scheduler.plan(change, { version: "14.1" }) }), TypeError);
  eq(w.server.requests.length, 0);
  // The log says what happened without naming anyone.
  const logged = w.log.lines.map(([, m]) => m).join("\n");
  assert(/organisateur/.test(logged) && !/Point hebdomadaire|evil|victime|example/.test(logged), logged);
});

test("every attendee removed from my own meeting (Thunderbird then drops the organizer): one cancellation to those who were invited, through the window", async () => {
  const mine = meeting([A, B], { summary: "Comité", sequence: 2 });
  // What Thunderbird saves once the last attendee is removed: a personal event, without organizer or attendees.
  const personal = event({ summary: "Comité", sequence: 2 });
  const rows = [
    ["attendees and organizer gone", modify(personal, mine), "cancel>anne,bruno"],
    ["a place, a reminder, a category changed too", modify(event({ summary: "Comité", sequence: 2, location: "Ailleurs", reminder: 5, categories: ["x"] }), mine), "cancel>anne,bruno"],
    ["the organizer kept, the attendees gone (as before)", modify(meeting([]), mine), "cancel(removed)>anne,bruno"],
    ["my meeting had no attendee", modify(personal, meeting([])), "plain"],
    ["my meeting had only me", modify(personal, meeting([OWN])), "plain"],
    ["it was cancelled already", modify(personal, meeting([A], { meeting: { ...mine.meeting, cancelled: true } })), "plain"],
    ["rewritten by the server meanwhile", modify(personal, mine, { rewritten: true }), "plain"],
  ];
  for (const [name, change, expected] of rows) eq(brief(plan(change)), expected, name);
  eq(plan(modify(personal, mine)).notice, undefined, "not a replaced organizer");
  // N2: only that. An item that still has attendees, or is no longer the event they were invited to (title,
  // start, end, all day, recurrence), is not "the user removed everyone": nothing is sent, the user is told.
  const not = [
    ["attendees left in the item", { attendees: [person(A), person(C)] }],
    ["one attendee left", { attendees: [person(C)] }],
    ["another title", { summary: "Autre" }],
    ["another start", { start: "2026-12-01T08:00:00Z" }],
    ["another end", { end: "2026-12-01T11:00:00Z" }],
    ["all day now", { allDay: true, start: "2026-12-01", end: "2026-12-02" }],
    ["a recurrence now", { recurrence: weekly }],
  ];
  for (const [name, over] of not) eq(plan(modify({ ...personal, ...over }, mine)), { flow: "plain", notice: "organizerChanged" }, name);
  eq(brief(plan(modify(event({ summary: "Comité", sequence: 2, attendees: [person(OWN)] }), mine))), "cancel>anne,bruno", "the user alone left in the list is nobody left");
  eq(brief(plan(modify({ ...personal, recurrence: weekly }, { ...mine, recurrence: weekly }))), "cancel>anne,bruno", "the same series");
  // Someone else's meeting that loses its organizer, and my meeting given to another address, are still told and send nothing.
  eq(plan(modify(event({ uid: "invite-1", attendees: [person(OWN)] }), invitation())), { flow: "plain", notice: "organizerChanged" });
  eq(plan(modify(invitation({ organizer: { email: "eve@evil.example", name: "" }, attendees: [person(A)] }), mine)), { flow: "plain", notice: "organizerChanged" });
  // More than 100 people to tell: refused, like any message to that many.
  const crowd = Array.from({ length: 101 }, (_, i) => `p${i}@example.org`);
  eq(plan(modify(personal, meeting(crowd, { summary: "Comité" }))), { flow: "refuse", reason: "attendees", count: 101 });

  // The flow: asked in the window, then one CANCEL in the user's name, written from the meeting as the attendees knew it.
  const w = world();
  const r = await w.organize(modify(personal, mine));
  eq([r.queued, r.sequence, r.item.organizer, r.item.attendees, r.item.sequence], [1, 3, null, [], 3], "what is stored as synchronized is the event as it is now, with the raised SEQUENCE");
  eq(w.server.requests.length, 0, "nothing leaves before the user is asked");
  eq(await w.deliver(), { sent: 1, declined: 0, failed: 0, uncertain: 0 });
  eq(w.asked, [{ kind: "cancel", summary: "Comité", start: "2026-12-01T09:00:00Z", allDay: false, recipients: [A, B], from: OWN }]);
  const [mail] = w.mails();
  eq([mail.method, mail.to, line(mail, "SEQUENCE"), line(mail, "STATUS")], ["CANCEL", [A, B], ["SEQUENCE:3"], ["STATUS:CANCELLED"]], "cancelled for everyone who was invited");
  eq(line(mail, "ORGANIZER"), [`ORGANIZER:mailto:${OWN}`]);
  eq(line(mail, "ATTENDEE").map((l) => l.slice(l.lastIndexOf("mailto:") + 7)), [A, B]);
  eq(w.notices, []);
  // Don't send: nothing leaves, nothing is said.
  const no = world();
  no.send = false;
  await no.organize(modify(personal, mine));
  eq(await no.deliver(), { sent: 0, declined: 1, failed: 0, uncertain: 0 });
  eq([no.server.requests.length, no.notices.length], [0, 0]);
});

test("audit B-6: what waited more than a day is dropped when the outbox is loaded — never asked, never sent; the user is told for the messages that needed their yes", async () => {
  const w = world();
  await w.organize(add(meeting([A, B], { summary: "Comité" })));
  await w.organize(del(meeting([C], { summary: "Bilan" })), "7|c2");
  const answer = modify(invitation({ summary: "Invitation ancienne" }, "accepted"), invitation({ summary: "Invitation ancienne" }), ASKED);
  await w.scheduler.answer({ client: w.server, change: answer, plan: w.scheduler.plan(answer, { version: "14.1" }) });
  eq(await w.scheduler.pending(), 3);
  const requests = w.server.requests.length;
  // Thunderbird is closed, and opened again a day later.
  w.clock.now += MAX_WAIT_MS + 1000;
  const later = w.make();
  eq(await later.pending(), 0, "dropped on loading, before any delivery");
  eq(w.notices, [
    "Le message de réunion pour « Comité » n'a pas été envoyé : il attendait depuis plus d'un jour. L'événement est enregistré, mais les participants n'ont pas été informés.",
    "Le message de réunion pour « Bilan » n'a pas été envoyé : il attendait depuis plus d'un jour. L'événement est enregistré, mais les participants n'ont pas été informés.",
  ], "one notice for each message that waited for a yes; none for the reply");
  eq(await later.deliver({ client: w.server }), { sent: 0, declined: 0, failed: 0, uncertain: 0 });
  eq([w.asked.length, w.server.requests.length - requests, w.server.mails.length], [0, 0, 0], "no question, no reply leaving days later");
  assert(!(await w.records.names()).includes("meetingOutbox") || (await w.records.get("meetingOutbox", null)).entries.length === 0, "written down");
  // The changes they came from, replayed, do not bring them back; once told is enough.
  eq((await later.enqueue({ key: "7|c1", change: add(meeting([A, B], { summary: "Comité" })), plan: later.plan(add(meeting([A, B])), { version: "14.1" }) })).queued, 0);
  eq(await w.make().pending(), 0);
  eq(w.notices.length, 2);
});

test("audit B-6: a message that grows old while Thunderbird runs is dropped before the next delivery; younger ones are delivered; a damaged date is an old one", async () => {
  const w = world();
  await w.organize(add(meeting([A], { summary: "Vieux" })));
  w.clock.now += MAX_WAIT_MS - 60_000;
  await w.organize(add(meeting([B], { summary: "Récent" })), "7|c2");
  w.clock.now += 120_000; // the first one is now a day and a minute old; the mailbox was unreachable all that time
  eq(await w.deliver(), { sent: 1, declined: 0, failed: 0, uncertain: 0 });
  eq(w.asked.map((q) => q.summary), ["Récent"]);
  eq(w.mails().map((m) => m.to), [[B]]);
  eq(w.notices.length, 1);
  assert(w.notices[0].includes("Vieux") && /plus d'un jour/.test(w.notices[0]), w.notices[0]);
  // Exactly a day is not yet too old.
  const edge = world();
  await edge.organize(add(meeting([A])));
  edge.clock.now += MAX_WAIT_MS;
  eq(await edge.deliver(), { sent: 1, declined: 0, failed: 0, uncertain: 0 });
  // Stored dates that cannot be believed: none, not a number, or far in the future (a clock that was wrong).
  const entry = (key, at) => ({ key, kind: "invite", recipients: [{ email: A, name: "", role: "required" }], occurrence: null, event: meeting([A], { summary: key }), sequence: 0, state: "new", at });
  const odd = world();
  await odd.records.set("meetingOutbox", { v: 1, entries: [entry("sans-date", undefined), entry("texte", "hier"), entry("zéro", 0), entry("futur", odd.clock.now + 2 * MAX_WAIT_MS), entry("bon", odd.clock.now - 5000), entry("demain-matin", odd.clock.now + 3600_000)], settled: [] });
  eq(await odd.scheduler.pending(), 2);
  eq(odd.notices.length, 4);
  eq(await odd.deliver(), { sent: 2, declined: 0, failed: 0, uncertain: 0 });
  eq(odd.asked.map((q) => q.summary), ["bon", "demain-matin"]);
});

test("audit B-6: a message that was leaving when Thunderbird stopped is still told as uncertain, however old", async () => {
  const w = world();
  await w.organize(add(meeting([A, B], { summary: "Comité" })));
  const box = await w.records.get("meetingOutbox", null);
  box.entries[0].state = "sending";
  await w.records.set("meetingOutbox", box);
  w.clock.now += 3 * MAX_WAIT_MS;
  const later = w.make();
  eq(await later.pending(), 1, "not dropped as 'not sent': it may have been");
  eq(await later.deliver({ client: w.server }), { sent: 0, declined: 0, failed: 0, uncertain: 1 });
  eq(w.notices.length, 1);
  assert(/peut-être/.test(w.notices[0]) && !/plus d'un jour/.test(w.notices[0]), w.notices[0]);
  eq([w.server.requests.length, w.asked.length], [0, 0]);
});

test("audit B-6: the outbox does not outlive an unchecked calendar — nothing of it is asked or sent, whoever forgets to clear it", async () => {
  const w = world();
  await w.organize(add(meeting([A, B], { summary: "Comité" })));
  const answer = modify(invitation({}, "accepted"), invitation(), ASKED);
  await w.scheduler.answer({ client: w.server, change: answer, plan: w.scheduler.plan(answer, { version: "14.1" }) });
  eq(await w.scheduler.pending(), 2);
  const requests = w.server.requests.length;
  // The user unchecks Calendar (and Tasks): the engine and its scheduler are built anew from the mailbox as it is now.
  for (const sync of [{ mail: true, calendar: false, contacts: false, tasks: false }, { mail: true, calendar: false, contacts: false, tasks: true }, { mail: true }]) {
    const area = memoryArea();
    const again = world({ area, sync });
    await again.records.set("meetingOutbox", await w.records.get("meetingOutbox", null));
    eq(await again.scheduler.pending(), 0, JSON.stringify(sync));
    eq(await again.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 });
    eq([again.asked.length, again.server.requests.length, again.notices.length], [0, 0, 0], "no question, no reply leaving on its own");
    assert(!(await again.records.names()).includes("meetingOutbox"), "the record is gone, with the descriptions it held");
  }
  // What was leaving when Thunderbird stopped may have left: it is not dropped as if it had not, and is told as uncertain.
  const crashed = world({ area: memoryArea(), sync: { mail: true, calendar: false, contacts: false, tasks: false } });
  const box = await w.records.get("meetingOutbox", null);
  box.entries[0].state = "sending";
  await crashed.records.set("meetingOutbox", box);
  eq(await crashed.scheduler.pending(), 1);
  eq(await crashed.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 1 });
  eq([crashed.asked.length, crashed.server.requests.length, crashed.notices.length], [0, 0, 1]);
  // With the calendar still synchronized, the same record is delivered.
  const kept = world({ area: memoryArea() });
  await kept.records.set("meetingOutbox", await w.records.get("meetingOutbox", null));
  eq(await kept.deliver(), { sent: 2, declined: 0, failed: 0, uncertain: 0 });
  eq(w.server.requests.length, requests);
});

test("audit N3: the outbox cleared while a question is open — Send sends nothing, and the user is told", async () => {
  const w = world();
  await w.organize(add(meeting([A, B], { summary: "Comité" })));
  await w.organize(add(meeting([C], { summary: "Suivant" })), "7|c2");
  // The window is open; meanwhile the mailbox's calendar goes (unchecked, folder gone): the engine clears the outbox.
  w.scheduler = new Scheduler({
    mailbox: w.mailbox, records: w.records, invitations: w.invitations, notify: (m) => w.notices.push(m), log: w.log, now: () => w.clock.now, random: (n) => new Uint8Array(n).fill(5),
    confirm: async (question) => {
      w.asked.push(question);
      await w.scheduler.clear();
      return true; // and the user clicks Send
    },
  });
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 1, uncertain: 0 });
  eq([w.server.requests.length, w.server.mails.length], [0, 0], "nothing left for a calendar that is gone");
  eq(w.asked.length, 1, "the next message, cleared too, is not even asked for");
  eq(w.notices.length, 1);
  assert(w.notices[0].includes("« Comité »") && /n'a pas été envoyé/.test(w.notices[0]), w.notices[0]);
  eq(await w.scheduler.pending(), 0);
  assert(!(await w.records.names()).includes("meetingOutbox"), "the cleared outbox is not written back");
});

test("audit B-7: the To field of a reply holds the organizer's address and nothing of the name the invitation gave", async () => {
  const w = world();
  // The organizer's name comes from the invitation: written so that a quoted display name reads as two mailboxes.
  const hostile = { email: CHEF, name: "x\" <third-party@victim.example>, \"y" };
  const change = modify(invitation({ organizer: hostile }, "accepted"), invitation({ organizer: hostile }), ASKED);
  const p = w.scheduler.plan(change, { version: "14.1" });
  eq((await w.scheduler.answer({ client: w.server, change, plan: p })).outcome, "answered");
  eq(await w.deliver(), { sent: 1, declined: 0, failed: 0, uncertain: 0 });
  const [mail] = w.mails();
  eq(mail.headers.get("to"), CHEF, "the address alone");
  eq(mail.to, [CHEF], "the repository's own reader of meeting mails finds one recipient");
  const head = w.server.mails[0].mime.split("\r\n\r\n")[0];
  assert(!head.includes("victim.example") && !head.includes("third-party"), head);
  // The name is still where a calendar reads it, quoted and without its quotes.
  eq(line(mail, "ORGANIZER"), [`ORGANIZER;CN="x <third-party@victim.example>, y":mailto:${CHEF}`]);
  // The organize flow too: addresses only, the names in the calendar.
  await w.organize(add(meeting([person(A, { name: "Anne, \"A\" <eve@evil.example>" }), person(B, { name: "Bruno" })])));
  await w.deliver();
  const invite = w.mails()[1];
  eq(invite.headers.get("to"), `${A}, ${B}`);
  eq(line(invite, "ATTENDEE").map((l) => /CN="([^"]*)"/.exec(l)?.[1]), ["Anne, A <eve@evil.example>", "Bruno"]);
});

test("audit, info: a question nobody answers in time is not sent, and the user is told so; Don't send says nothing", async () => {
  const w = world();
  w.send = EXPIRED;
  await w.organize(add(meeting([A, B], { summary: "Comité" })));
  eq(await w.deliver(), { sent: 0, declined: 1, failed: 0, uncertain: 0 });
  eq(w.notices, ["Le message de réunion pour « Comité » n'a pas été envoyé : la demande de confirmation est restée sans réponse. L'événement est enregistré, mais les participants n'ont pas été informés."]);
  eq([w.server.requests.length, await w.scheduler.pending()], [0, 0]);
  w.send = true;
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 }, "not asked again: the change is saved, the user knows");
  eq(await w.make().deliver({ client: w.server }), { sent: 0, declined: 0, failed: 0, uncertain: 0 }, "nor after a restart");
  eq([w.asked.length, w.server.mails.length, w.notices.length], [1, 0, 1]);
  // Only that very answer means "expired": anything else that is not true is the user's Don't send.
  for (const answer of ["Expired", "EXPIRED", " expired", ["expired"], { expired: true }]) {
    const other = world();
    other.send = answer;
    await other.organize(add(meeting([A])));
    eq(await other.deliver(), { sent: 0, declined: 1, failed: 0, uncertain: 0 });
    eq([other.notices.length, other.server.requests.length], [0, 0], JSON.stringify(answer));
  }
});

test("audit, info: the text part of a reply gives its time in UTC, marked as such; an invitation keeps the day and time in full", async () => {
  const { withLanguage, LOCALES } = await import("./i18n-fake.mjs");
  for (const lang of LOCALES) {
    await withLanguage(lang, async () => {
      const w = world();
      const change = modify(invitation({}, "accepted"), invitation(), ASKED);
      await w.scheduler.answer({ client: w.server, change, plan: w.scheduler.plan(change, { version: "14.1" }) });
      await w.deliver();
      const text = w.mails()[0].text;
      // 09:00 UTC, whatever the computer's time zone (the tests run in any): the hour of the event as UTC, and the word.
      assert(/\b0?9[:.h]00/.test(text) && /UTC/.test(text), `${lang}: ${text}`);
      assert(!/GMT[+-]|UTC[+-−]\d|[+-]\d{2}:?\d{2}\b/.test(text), `${lang}: no offset of the computer: ${text}`);
    });
  }
  const w = world();
  const change = modify(invitation({}, "accepted"), invitation(), ASKED);
  await w.scheduler.answer({ client: w.server, change, plan: w.scheduler.plan(change, { version: "14.1" }) });
  await w.deliver();
  const lines = w.mails()[0].text.split("\r\n");
  eq(lines[0], "Point hebdomadaire");
  assert(/^Quand : mardi 1 décembre 2026 à 09:00:00 UTC$/.test(lines[1]), lines[1]);
  // An all-day meeting has a day and no time: nothing to mark.
  const day = modify(invitation({ allDay: true, start: "2026-12-24", end: "2026-12-25" }, "accepted"), invitation({ allDay: true, start: "2026-12-24", end: "2026-12-25" }), ASKED);
  await w.scheduler.answer({ client: w.server, change: day, plan: w.scheduler.plan(day, { version: "14.1" }) });
  await w.deliver();
  eq(w.mails()[1].text.split("\r\n")[1], "Quand : jeudi 24 décembre 2026");
});

test("audit, D7: what is shown and what is sent is cleaned where it is shown or sent — joiners and invisible characters the readers let through never leave", async () => {
  const c = (code) => String.fromCodePoint(code);
  // The readers keep U+200C and U+200D in a title and a place; the calendar lets the user type anything.
  for (const code of [0x200c, 0x200d, 0x200b, 0x202e, 0x2066, 0xfeff, 0xad, 0xe0041]) {
    const hidden = c(code);
    const hex = code.toString(16);
    const texts = { summary: `Comi${hidden}té`, location: `Salle${hidden} 2`, description: `Ordre${hidden} du jour` };
    const w = world({ senderName: `Moi${hidden} Même` });
    w.server.sendStatus = "120";
    await w.organize(add(meeting([person(A, { name: `An${hidden}ne` })], texts)));
    await w.deliver();
    const sent = w.server.mails[0];
    const mail = readMeetingMail(sent.mime);
    for (const part of [mail.calendar.join("\n"), mail.text, [...mail.headers.values()].join("\n")]) assert(!part.includes(hidden), `U+${hex} in what was sent`);
    eq([line(mail, "SUMMARY"), line(mail, "LOCATION"), line(mail, "DESCRIPTION")], [["SUMMARY:Comité"], ["LOCATION:Salle 2"], ["DESCRIPTION:Ordre du jour"]], `U+${hex}`);
    eq(mail.text.split("\r\n").filter((l, i) => i !== 1), ["Comité", "Où : Salle 2"], `U+${hex}`);
    assert(mail.headers.get("subject").endsWith("Comité"), `U+${hex}: ${mail.headers.get("subject")}`);
    assert(mail.headers.get("from").includes("Moi Même"), mail.headers.get("from"));
    // The notification of the refusal, and the notices the engine asks for by name.
    eq(w.notices.length, 1);
    assert(w.notices[0].includes("« Comité »") && !w.notices[0].includes(hidden), `U+${hex}: ${w.notices[0]}`);
    w.scheduler.notice("keptLocal", texts.summary);
    assert(w.notices[1].startsWith("« Comité »") && !w.notices[1].includes(hidden));
    // The question carries the title as the outbox holds it, joiners included when the event's own check keeps
    // them: the window cleans what it shows (confirm.mjs checkInfo, tested there).
    eq(w.asked[0].summary.split(hidden).join(""), "Comité");
  }
  // A place made of nothing visible is no place: the text part has no line for it.
  const w = world();
  await w.organize(add(meeting([A], { location: `${c(0x200d)}${c(0x200c)} ${c(0x200d)}` })));
  await w.deliver();
  eq(w.mails()[0].text.split("\r\n").length, 2, w.mails()[0].text);
  assert(!w.mails()[0].text.includes("Où"), w.mails()[0].text);
  eq(line(w.mails()[0], "LOCATION"), [], "nor has the calendar");
});

test("scheduler: notices by name — a title, or a number and no title", async () => {
  const w = world();
  w.scheduler.notice("changesDropped", "", 1);
  w.scheduler.notice("changesDropped", "", 4);
  w.scheduler.notice("changesDropped", "", 0); // nothing to tell
  w.scheduler.notice("changesDropped", "", undefined);
  w.scheduler.notice("changesDropped");
  w.scheduler.notice("serverChanged", "Budget");
  w.scheduler.notice("detached", "Budget");
  w.scheduler.notice("restoreUnsupported", "Budget");
  w.scheduler.notice("keptLocal", null);
  w.scheduler.notice("inconnu", "Budget");
  w.scheduler.notice("__proto__", "Budget");
  eq(w.notices.length, 6);
  assert(w.notices[0].startsWith("Une modification faite dans Thunderbird n'a pas été envoyée"), w.notices[0]);
  assert(w.notices[1].startsWith("4 modifications faites dans Thunderbird n'ont pas été envoyées"), w.notices[1]);
  assert(w.notices[2].startsWith("« Budget » a été modifié sur le serveur"), w.notices[2]);
  assert(w.notices[5].startsWith("« (sans titre) » n'a pas pu être enregistré"), w.notices[5]);
});

test("scheduler: clear() forgets what waits; nothing of it is asked or sent", async () => {
  const w = world();
  await w.organize(add(meeting([A])));
  await w.scheduler.clear();
  eq(await w.scheduler.pending(), 0);
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 0, uncertain: 0 });
  eq([w.asked.length, w.server.requests.length], [0, 0]);
  assert(!(await w.records.names()).includes("meetingOutbox"));
});

test("scheduler: the constructor refuses a mailbox without a valid address, or a missing dependency", () => {
  const records = new Store(memoryArea()).mailbox(MB);
  const invitations = new InvitationTable({ records });
  const ok = { mailbox: { id: MB, email: OWN, sync: {} }, records, invitations, confirm: async () => true, notify: () => {} };
  new Scheduler(ok);
  throws(() => new Scheduler({ ...ok, mailbox: { id: MB, email: "moi" } }), TypeError);
  throws(() => new Scheduler({ ...ok, confirm: null }), TypeError);
  throws(() => new Scheduler({ ...ok, notify: undefined }), TypeError);
  throws(() => new Scheduler({ ...ok, invitations: null }), TypeError);
});

test("scheduler: a notification that fails changes nothing", async () => {
  const w = world();
  w.server.sendStatus = "110";
  w.scheduler = new Scheduler({
    mailbox: w.mailbox, records: w.records, invitations: w.invitations, confirm: async () => true, now: () => w.clock.now, random: (n) => new Uint8Array(n).fill(9),
    notify: () => {
      throw new Error("notifications indisponibles");
    },
  });
  await w.organize(add(meeting([A])));
  eq(await w.deliver(), { sent: 0, declined: 0, failed: 1, uncertain: 0 });
  w.scheduler.notice("readOnly", "Titre");
});

test("scheduler: the log never holds a title, a name, an address or a location", async () => {
  const w = world({ version: "12.1" });
  const secret = { summary: "Fusion Zébulon", location: "Tour Kérozène" };
  await w.invitations.note(invitationMail());
  const answer = modify(invitation({ ...secret }, "accepted"), invitation({ ...secret }), ASKED);
  await w.scheduler.answer({ client: w.server, change: answer, plan: w.scheduler.plan(answer, { version: "12.1" }) });
  await w.organize(add(meeting([A, person(B, { name: "Bruno Quidam" })], secret)));
  await w.organize(del(meeting([A], secret)), "7|gone");
  w.server.hook("SendMail", () => undefined);
  w.server.sendStatus = null;
  await w.deliver();
  w.send = false;
  await w.organize(modify(meeting([A], { ...secret, location: "Hangar Xylophone" }), meeting([A, B], secret)), "7|next");
  await w.deliver();
  w.server.sendStatus = "120";
  w.send = true;
  await w.organize(add(meeting([C], secret)), "7|refused");
  await w.deliver();
  const all = w.log.lines.map(([, m]) => m).join("\n");
  assert(w.log.lines.length >= 5, "the flows are logged");
  for (const word of ["Zébulon", "Kérozène", "Xylophone", "Quidam", "anne", "bruno", "chloe", "chef", "example", "invite-1", "@"]) {
    assert(!all.includes(word), `the log holds ${word}: ${all}`);
  }
});
