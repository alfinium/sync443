// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Calendar and task synchronisation (src/sync/pim.mjs) with its scheduler
 * (src/sync/scheduling.mjs), through the real calendar-store wrapper
 * (src/tb/calendar-store.mjs), against the doubles of calendar-fakes.mjs:
 * a privileged calendar module in memory and an ActiveSync server for the
 * Calendar and Tasks classes.
 */

import { test, assert, eq, rejects, throws } from "./harness.mjs";
import { el, at, text, child } from "../../src/core/wbxml.mjs";
import { EasError, ERR } from "../../src/transport/client.mjs";
import { Store } from "../../src/sync/store.mjs";
import { InvitationTable } from "../../src/sync/invitations.mjs";
import { Scheduler } from "../../src/sync/scheduling.mjs";
import { PimSync, pimCollections, PIM_MAX_BATCHES, PIM_WINDOW_SIZE, UPLOAD_MAX, MAX_TRIES, MAX_STRIKES, MAX_PIM_COLLECTIONS, MAX_PIM_ITEMS } from "../../src/sync/pim.mjs";
import { CalendarStore, CalendarStoreError, checkChange, MAX_BATCH } from "../../src/tb/calendar-store.mjs";
import { calendarSupported } from "../../src/core/calendar-item.mjs";
import { memoryArea } from "./journal.test.mjs";
import { quietLog } from "./mail-sync.test.mjs";
import { FakeCalendarApi, FakePimServer, PIM_FOLDERS, OWN, event, task, meeting, invitation, person, readMeetingMail } from "./calendar-fakes.mjs";

const MB = "0123456789ab";
const CAL = "7"; // the default Calendar folder
const TASKS = "8"; // the default Tasks folder
const A = "anne@example.org";
const B = "bruno@example.org";
const CHEF = "chef@example.org";

function world({ version = "14.1", sync = { mail: true, calendar: true, contacts: false, tasks: true }, folders = PIM_FOLDERS, calendarPeriod = "7", taskFilter = "0" } = {}) {
  const server = new FakePimServer({ folders, version });
  const api = new FakeCalendarApi();
  const area = memoryArea();
  const records = new Store(area).mailbox(MB);
  const clock = { now: Date.UTC(2026, 10, 16, 9, 0, 0) };
  const log = quietLog();
  const mailbox = { id: MB, email: OWN, name: "Travail", sync: { ...sync }, calendarPeriod, taskFilter };
  const w = { server, api, area, records, clock, log, mailbox, version, asked: [], notices: [], named: [], send: true, seed: 0 };
  w.invitations = new InvitationTable({ records, now: () => clock.now });
  /** A new engine on the same storage and the same Thunderbird: what a restart gives. */
  w.restart = () => {
    w.store = new CalendarStore({ mailboxId: MB, ownEmail: OWN, api });
    w.scheduler = new Scheduler({
      mailbox,
      records,
      invitations: w.invitations,
      confirm: async (question) => {
        w.asked.push(question);
        return w.send;
      },
      notify: (message) => w.notices.push(message),
      log,
      now: () => clock.now,
      random: (n) => Uint8Array.from({ length: n }, () => (w.seed = (w.seed * 73 + 41) % 251)),
    });
    // The notices the engine asks for, by name: [name, title, detail] (their texts are the catalogs' business).
    const notice = w.scheduler.notice.bind(w.scheduler);
    w.scheduler.notice = (name, summary, detail = "") => {
      w.named.push([name, summary, detail]);
      return notice(name, summary, detail);
    };
    w.pim = new PimSync({ mailbox, records, calendarStore: w.store, scheduler: w.scheduler, log, now: () => clock.now });
    return w.pim;
  };
  w.restart();
  w.pass = (o = {}) => w.pim.pass({ client: server, version, folders: server.folders, ...o });
  /** The calendar of a slot ("main" by default), as Thunderbird holds it. */
  w.cal = (slot = "main") => [...api.calendars].find(([, c]) => c.mailboxId === MB && c.slot === slot)?.[0] ?? null;
  w.titles = (slot = "main") => api.summaries(w.cal(slot));
  w.serverTitles = (cid) => [...server.items.get(cid).values()].map((i) => i.summary).sort();
  w.commands = (cid) => server.syncs(cid).flatMap((s) => s.commands.map((c) => c.tag));
  w.mails = () => server.mails.map((m) => readMeetingMail(m.mime));
  w.coll = (cid) => records.get(`pim:${cid}`, null);
  return w;
}

const range = (n) => Array.from({ length: n }, (_, i) => i);
const PROBLEM_NAMES = { __proto__: null, recurrence: "recurrenceUnsupported", "too-large": "tooLarge", "read-only": "readOnly" };


/** The user answers an invitation in Thunderbird: the event's own status and the user's line among the attendees. */
const answered = (response) => (item) => ({
  ...item,
  meeting: { ...item.meeting, response },
  attendees: item.attendees.map((a) => (a.email === OWN ? { ...a, status: response } : a)),
});
/** …and Thunderbird asked whether a reply may go: the user did not choose "do not send a response". */
const ASKED = { replyAsked: true };
/** The invitation mail of invitation(), as the mail engine notes it: in the inbox, with the organizer and the start it gives. */
const noteInvitation = (w, over = {}) => w.invitations.note({ uid: "invite-1", collectionId: "1", serverId: "1:42", organizer: CHEF, start: "2026-12-01T09:00:00Z", kind: "inbox", ...over });
/** A Sync answer that says only this collection Status. */
const statusOnly = (cid, status, key = "2") => el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", key), el("CollectionId", cid), el("Status", status)])])]);
/** Passes until nothing more is announced. */
const settle = async (w, o = {}, most = 30) => {
  let r = await w.pass(o);
  for (let i = 0; i < most && r.moreAvailable && !r.pendingDeletes; i++) r = await w.pass();
  return r;
};

// ── Which folders ─────────────────────────────────────────────────────────

test("collections: default Calendar and Tasks share the slot main; every other folder has its own; nothing from the trash", () => {
  const folders = new Map([
    ["1", { parentId: "0", name: "Boîte de réception", type: 2 }],
    ["3", { parentId: "0", name: "Éléments supprimés", type: 4 }],
    ["7", { parentId: "0", name: "Calendrier", type: 8 }],
    ["8", { parentId: "0", name: "Tâches", type: 7 }],
    ["9", { parentId: "0", name: "Contacts", type: 9 }],
    ["20", { parentId: "7", name: "Équipe", type: 13 }],
    ["21", { parentId: "0", name: "Courses", type: 15 }],
    ["22", { parentId: "3", name: "Ancien agenda", type: 13 }],
    ["23", { parentId: "22", name: "Sous l'ancien", type: 13 }],
    ["24", { parentId: "0", name: "Notes", type: 10 }],
    ["main", { parentId: "0", name: "Piège", type: 13 }],
  ]);
  const both = pimCollections(folders, { calendar: true, tasks: true });
  eq([...both], [
    ["7", { cls: "Calendar", slot: "main", name: "Calendrier" }],
    ["8", { cls: "Tasks", slot: "main", name: "Tâches" }],
    ["20", { cls: "Calendar", slot: "20", name: "Équipe" }],
    ["21", { cls: "Tasks", slot: "21", name: "Courses" }],
  ]);
  eq([...pimCollections(folders, { calendar: true, tasks: false }).keys()], ["7", "20"]);
  eq([...pimCollections(folders, { calendar: false, tasks: true }).keys()], ["8", "21"]);
  eq(pimCollections(folders, { calendar: false, tasks: false }).size, 0);
  eq(pimCollections(folders, { mail: true }).size, 0);
});

test("collections: a second default folder is an ordinary one; odd folder lists are bounded and never trusted", () => {
  const two = new Map([["70", { parentId: "0", name: "B", type: 8 }], ["7", { parentId: "0", name: "A", type: 8 }]]);
  eq([...pimCollections(two, { calendar: true, tasks: true })].map(([id, w]) => [id, w.slot]), [["7", "main"], ["70", "70"]]);
  const many = new Map(range(80).map((i) => [`c${i}`, { parentId: "0", name: `Agenda ${i}`, type: 13 }]));
  eq(pimCollections(many, { calendar: true, tasks: true }).size, MAX_PIM_COLLECTIONS);
  // A cycle of parents, entries that are not folders, a list that is not a Map.
  const odd = new Map([["a", { parentId: "b", name: "A", type: 13 }], ["b", { parentId: "a", name: "B", type: 12 }], ["c", null], ["d", { type: "13" }], ["", { parentId: "0", name: "Vide", type: 13 }]]);
  eq([...pimCollections(odd, { calendar: true, tasks: true }).keys()], ["a"]);
  eq(pimCollections({ 7: { type: 8 } }, { calendar: true, tasks: true }).size, 0);
  eq(pimCollections(null, { calendar: true }).size, 0);
});

// ── From the server ───────────────────────────────────────────────────────

test("first sync: SyncKey 0 with Supported for the calendar and the Options; events and tasks arrive in the mailbox's calendar", async () => {
  const w = world();
  w.server.addItem(CAL, event({ uid: "e1", summary: "Réunion" }));
  w.server.addItem(CAL, event({ uid: "e2", summary: "Dentiste", allDay: true, start: "2026-12-03", end: "2026-12-04" }));
  w.server.addItem(TASKS, task({ uid: "t1", summary: "Rapport" }));
  const r = await w.pass();
  eq(r, { received: 3, sent: 0, failed: 0, pendingDeletes: 0, moreAvailable: false, hierarchyChanged: false });
  eq(w.titles(), ["Dentiste", "Rapport", "Réunion"]);
  eq(w.api.calendars.size, 1, "one calendar for the default Calendar and Tasks folders");
  const main = w.api.calendars.get(w.cal());
  eq([main.name, main.events, main.tasks, main.organizerEmail], ["Travail", true, true, OWN]);
  const [first, second] = w.server.syncs(CAL);
  eq([first.key, first.supported, first.filterType, first.conflict, first.bodyType], ["0", [...calendarSupported("14.1")], "7", "1", "1"]);
  eq([second.key, second.supported, second.filterType, second.conflict], ["1", null, "7", "1"], "Supported goes with the first Sync only");
  const [tasks] = w.server.syncs(TASKS);
  eq([tasks.key, tasks.supported, tasks.filterType, tasks.bodyType], ["0", null, "0", "1"], "tasks have no Supported");
  eq([(await w.coll(CAL)).syncKey, (await w.coll(TASKS)).syncKey], ["2", "2"]);
  for (const row of w.api.items(w.cal())) assert(row.serverId && [CAL, TASKS].includes(row.collectionId), "every item is a ServerId in a collection");
  eq(w.server.sent("SendMail").length + w.server.sent("MeetingResponse").length, 0);
});

test("from the server: changes, deletions below the threshold, and a second pass with nothing new asks once and changes nothing", async () => {
  const w = world();
  const a = w.server.addItem(CAL, event({ uid: "a", summary: "A" }));
  const b = w.server.addItem(CAL, event({ uid: "b", summary: "B" }));
  const t1 = w.server.addItem(TASKS, task({ uid: "t", summary: "T" }));
  await w.pass();
  const before = w.server.requests.length;
  eq((await w.pass()).received, 0);
  eq(w.server.requests.length - before, 2, "one Sync for each collection");
  w.server.changeItem(CAL, a, { summary: "A, déplacé", start: "2026-12-02T09:00:00Z", end: "2026-12-02T10:00:00Z" });
  w.server.deleteItem(CAL, b);
  w.server.changeItem(TASKS, t1, { completed: true, completedAt: "2026-11-16T08:00:00Z" });
  const c = w.server.addItem(CAL, event({ uid: "c", summary: "C" }));
  eq((await w.pass()).received, 4);
  eq(w.titles(), ["A, déplacé", "C", "T"]);
  const rows = new Map(w.api.items(w.cal()).map((r) => [r.serverId, r.item]));
  eq([rows.get(a).start, rows.get(t1).completed, rows.has(b), rows.has(c)], ["2026-12-02T09:00:00Z", true, false, true]);
  eq(await w.pim.pendingDeletes(), 0);
});

test("from the server: a SoftDelete is a deletion like any other — a few leave, many at once are held for the user", async () => {
  const w = world();
  const sids = range(70).map((i) => w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` })));
  await w.pass();
  eq(w.titles().length, 70);
  for (const sid of sids.slice(0, 5)) w.server.softDelete(CAL, sid); // five items left the period
  const few = await w.pass();
  eq([few.pendingDeletes, few.received, w.titles().length], [0, 5, 65]);
  eq((await w.coll(CAL)).window.count, 5, "counted in the rolling window, like deletions");
  for (const sid of sids.slice(5)) w.server.softDelete(CAL, sid); // "everything left the period": a server cannot empty the calendar so
  const r = await w.pass();
  eq([r.pendingDeletes, r.received, w.titles().length], [65, 0, 65], "held, nothing removed");
  eq(w.api.calls.filter((c) => c[0] === "applyServerChanges" && c[2].some((x) => x.op === "remove")).length, 1, "only the five of before were removed");
  eq((await w.pass({ confirmDeletes: true })).pendingDeletes, 0);
  eq(w.titles(), []);
});

test("from the server: an item deleted then sent again in the same run is kept", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, event({ uid: "a", summary: "A" }));
  await w.pass();
  w.server.deleteItem(CAL, sid);
  w.server.addItem(CAL, event({ uid: "a", summary: "A, recréé" }), sid);
  await w.pass();
  eq(w.titles(), ["A, recréé"]);
  eq(await w.records.get("pimDeletes", null), null);
});

test("from the server: an item without UID gets a stable one of ours; a task always does", async () => {
  const w = world();
  const sid = w.server.addRaw(CAL, [el("Calendar:StartTime", "20261201T090000Z"), el("Calendar:EndTime", "20261201T100000Z"), el("Calendar:Subject", "Sans UID")]);
  const tid = w.server.addItem(TASKS, task({ summary: "Tâche" }));
  await w.pass();
  const rows = new Map(w.api.items(w.cal()).map((r) => [r.serverId, r.item]));
  assert(/^sync443-[0-9a-f]{32}$/.test(rows.get(sid).uid), rows.get(sid).uid);
  assert(/^sync443-[0-9a-f]{32}$/.test(rows.get(tid).uid));
  assert(rows.get(sid).uid !== rows.get(tid).uid);
  const uid = rows.get(tid).uid;
  w.server.changeItem(TASKS, tid, { summary: "Tâche, suite" });
  await w.pass();
  eq(w.api.items(w.cal()).find((r) => r.serverId === tid).item.uid, uid, "the same item keeps the same uid");
});

// ── To the server ─────────────────────────────────────────────────────────

test("local changes: an added event and an added task go to the default folder of their kind, and are bound to their ServerId", async () => {
  const w = world();
  await w.pass();
  w.api.userAdd(w.cal(), event({ uid: "local-e", summary: "Dentiste" }));
  w.api.userAdd(w.cal(), task({ uid: "local-t", summary: "Acheter du pain" }));
  const r = await w.pass();
  eq([r.sent, r.received, r.moreAvailable], [2, 0, false]);
  eq([w.serverTitles(CAL), w.serverTitles(TASKS)], [["Dentiste"], ["Acheter du pain"]]);
  eq(w.server.adds.map((a) => a.cid), [CAL, TASKS]);
  const rows = w.api.items(w.cal());
  eq(rows.map((r) => [r.item.summary, r.collectionId, r.serverId]).sort(), [["Acheter du pain", TASKS, w.server.adds[1].serverId], ["Dentiste", CAL, w.server.adds[0].serverId]]);
  for (const s of w.server.syncs(CAL).flatMap((x) => x.commands)) assert(/^[A-Za-z0-9-]{1,64}$/.test(s.clientId), s.clientId);
  // The acknowledgement names the collection with the ServerId (the change had none).
  const acks = w.api.calls.filter((c) => c[0] === "ackLocalChange").map((c) => c[3]);
  eq(acks.map((o) => [o.collectionId, typeof o.serverId, o.item.summary]), [[CAL, "string", "Dentiste"], [TASKS, "string", "Acheter du pain"]]);
  // Nothing more to send, nothing sent twice.
  const before = w.server.adds.length;
  eq((await w.pass()).sent, 0);
  eq([w.server.adds.length, before, w.titles().length], [2, 2, 2]);
});

test("local changes: a modification goes as Change, a deletion as Delete; each is acknowledged from the server's answer", async () => {
  const w = world();
  const a = w.server.addItem(CAL, event({ uid: "a", summary: "A", description: "Texte du serveur" }));
  const b = w.server.addItem(CAL, event({ uid: "b", summary: "B" }));
  const t1 = w.server.addItem(TASKS, task({ uid: "t", summary: "T" }));
  await w.pass();
  w.api.userModify(w.cal(), a, { summary: "A modifié", reminder: 15 });
  w.api.userDelete(w.cal(), b);
  w.api.userModify(w.cal(), t1, { completed: true, completedAt: "2026-11-16T08:30:00Z" });
  const r = await w.pass();
  eq([r.sent, r.received], [3, 0]);
  eq(w.commands(CAL).sort(), ["Change", "Delete"]);
  eq(w.commands(TASKS), ["Change"]);
  const kept = w.server.items.get(CAL).get(a);
  eq([kept.summary, kept.reminder, kept.description], ["A modifié", 15, "Texte du serveur"], "the body was not sent again: the server keeps its own");
  eq([w.server.items.get(CAL).has(b), w.server.items.get(TASKS).get(t1).completed], [false, true]);
  eq(w.titles(), ["A modifié", "T"]);
  // Everything is settled in Thunderbird: a further read finds nothing.
  eq((await w.store.readLocalChanges(w.cal())).changes, []);
  eq((await w.pass()).sent, 0);
});

test("local changes: deleting an item the server no longer has is settled all the same", async () => {
  const w = world();
  const a = w.server.addItem(CAL, event({ uid: "a", summary: "A" }));
  await w.pass();
  w.server.items.get(CAL).delete(a); // gone on the server, and the server has not said so yet
  w.api.userDelete(w.cal(), a);
  const r = await w.pass();
  eq([r.sent, w.notices.length], [1, 0]);
  eq((await w.store.readLocalChanges(w.cal())).changes, []);
});

test("local changes: more changes than one request carries go in several, all in one pass", async () => {
  const w = world();
  await w.pass();
  for (const i of range(45)) w.api.userAdd(w.cal(), event({ uid: `l${i}`, summary: `Local ${i}` }));
  const r = await w.pass();
  eq(r.sent, 45);
  const sizes = w.server.syncs(CAL).map((s) => s.commands.length).filter(Boolean);
  eq(sizes, [UPLOAD_MAX, UPLOAD_MAX, 5]);
  eq(w.server.items.get(CAL).size, 45);
  eq(new Set(w.server.adds.map((a) => a.clientId)).size, 45, "every Add has its own ClientId");
  eq(w.api.items(w.cal()).filter((r) => r.serverId === null).length, 0);
});

test("local changes: a change made before the first sync waits for the collection's SyncKey, then goes", async () => {
  const w = world();
  w.server.addItem(CAL, event({ uid: "a", summary: "Du serveur" }));
  const cal = (await w.store.ensureCalendar({ slot: "main", name: "Travail", events: true, tasks: true })).calendarId;
  w.api.userAdd(cal, event({ uid: "l", summary: "Avant tout" }));
  const r = await w.pass();
  eq([r.sent, r.received], [1, 1]);
  eq(w.server.syncs(CAL)[0].commands, [], "no command with SyncKey 0");
  eq(w.serverTitles(CAL), ["Avant tout", "Du serveur"]);
});

test("local changes: an item changed again while its request is on its way is bound all the same, and the newer change follows", async () => {
  const w = world();
  w.server.addItem(TASKS, task({ uid: "t", summary: "T" }));
  await w.pass();
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Dentiste" }));
  w.api.userAdd(w.cal(), task({ uid: "lt", summary: "Pain" }));
  let once = true;
  const base = w.server.onSync.bind(w.server);
  w.server.onSync = (req) => {
    if (once) {
      once = false;
      // The user goes on typing while the first request travels: both new items change again.
      w.api.userModify(w.cal(), "l", { summary: "Dentiste à 15 h" });
      w.api.userModify(w.cal(), "lt", { summary: "Pain complet" });
      w.server.addItem(CAL, event({ uid: "srv", summary: "Du serveur" })); // and the server has news: a read follows it
    }
    return base(req);
  };
  const r = await w.pass();
  eq(r.moreAvailable, false);
  eq([w.server.adds.length, w.server.items.get(CAL).size, w.server.items.get(TASKS).size], [2, 2, 2], "each item created once");
  eq([w.serverTitles(CAL), w.serverTitles(TASKS)], [["Dentiste à 15 h", "Du serveur"], ["Pain complet", "T"]]);
  eq(w.api.items(w.cal()).filter((x) => x.serverId === null).length, 0);
  eq((await w.store.readLocalChanges(w.cal())).changes, []);
});

test("local changes: an Add the server took but the calendar cannot bind is not sent again — the server's item takes its place", async () => {
  const w = world();
  await w.pass();
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Dentiste" }));
  const ack = w.api.ackLocalChange.bind(w.api);
  w.api.ackLocalChange = async (calendarId, changeId, options) => {
    if (options?.serverId) throw new Error("CONFLICT: l'élément est déjà lié");
    return ack(calendarId, changeId, options);
  };
  const r = await w.pass();
  eq(r.sent, 1);
  await w.pass();
  eq([w.server.adds.length, w.server.items.get(CAL).size], [1, 1], "one item on the server, never sent again");
  const rows = w.api.items(w.cal()).map((x) => [x.serverId, x.item.summary, x.detached]);
  assert(rows.some((x) => x[0] === w.server.adds[0].serverId && x[1] === "Dentiste"), "the server's item is here, bound");
  eq(rows.filter((x) => x[0] === null), [[null, "Dentiste", true]], "the item the calendar could not bind is never deleted: it stays, detached");
  eq((await w.store.readLocalChanges(w.cal())).changes, []);
});

test("calendar gone from Thunderbird: it is made again and its collections start from scratch, whatever their SyncKey says", async () => {
  const w = world();
  w.server.addItem(CAL, event({ uid: "a", summary: "A" }));
  w.server.addItem(TASKS, task({ uid: "t", summary: "T" }));
  await w.pass();
  w.api.calendars.clear(); // a profile restored without its calendars, say
  const r = await w.pass();
  eq([r.received, w.titles()], [2, ["A", "T"]]);
  eq(w.server.syncs(CAL).filter((s) => s.key === "0").length, 2);
});

// ── A lost response ───────────────────────────────────────────────────────

test("lost response: the same request goes again, with the same SyncKey, commands and ClientId; the item is created once", async () => {
  const w = world();
  await w.pass();
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Dentiste" }));
  w.server.loseNextResponse("Sync");
  await rejects(() => w.pass(), (e) => e.code === ERR.NETWORK);
  eq(w.server.items.get(CAL).size, 1, "the server took the Add");
  eq(w.api.items(w.cal())[0].serverId, null, "and Thunderbird does not know yet");
  assert((await w.records.names()).includes("pimOut:7"), "what was sent is written down");
  const r = await w.pass();
  eq(r.sent, 1);
  const withCommands = w.server.syncs(CAL).filter((s) => s.commands.length);
  eq(withCommands.length, 2);
  eq(withCommands[0], withCommands[1], "sent again as it was");
  eq([w.server.adds.length, w.server.items.get(CAL).size], [1, 1], "no duplicate");
  eq(w.api.items(w.cal()).map((x) => x.serverId), [w.server.adds[0].serverId]);
  assert(!(await w.records.names()).includes("pimOut:7"));
  eq((await w.pass()).sent, 0);
  eq(w.server.items.get(CAL).size, 1);
});

test("lost response: the replay comes before anything is read; a change made meanwhile is bound, then sent as a Change", async () => {
  const w = world();
  await w.pass();
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Dentiste" }));
  w.server.loseNextResponse("Sync");
  await rejects(() => w.pass(), (e) => e.code === ERR.NETWORK);
  w.api.userModify(w.cal(), "l", { summary: "Dentiste à 15 h" }); // the user goes on working
  w.restart(); // and Thunderbird restarts
  const calls = w.api.calls.length;
  await w.pass();
  const after = w.api.calls.slice(calls).map((c) => c[0]);
  assert(after.indexOf("ackLocalChange") < after.indexOf("readLocalChanges"), "the lost request is settled before the calendar is read again");
  eq([w.server.adds.length, w.server.items.get(CAL).size], [1, 1], "one item on the server");
  eq(w.serverTitles(CAL), ["Dentiste à 15 h"], "and the later change reached it");
  eq(w.commands(CAL), ["Add", "Add", "Change"]);
  eq(w.api.items(w.cal()).map((x) => [x.serverId, x.item.summary]), [[w.server.adds[0].serverId, "Dentiste à 15 h"]]);
  eq((await w.store.readLocalChanges(w.cal())).changes, []);
});

test("lost response: a Change and a Delete are replayed too, and settled once", async () => {
  const w = world();
  const a = w.server.addItem(CAL, event({ uid: "a", summary: "A" }));
  const b = w.server.addItem(CAL, event({ uid: "b", summary: "B" }));
  await w.pass();
  w.api.userModify(w.cal(), a, { summary: "A modifié" });
  w.api.userDelete(w.cal(), b);
  w.server.loseNextResponse("Sync");
  await rejects(() => w.pass(), (e) => e.code === ERR.NETWORK);
  const r = await w.pass();
  eq([r.sent, w.notices.length], [2, 0]);
  eq(w.serverTitles(CAL), ["A modifié"]);
  eq(w.titles(), ["A modifié"]);
  eq((await w.store.readLocalChanges(w.cal())).changes, []);
});

test("lost response: while it is not settled, the other collection of the same calendar waits (no read in between)", async () => {
  const w = world();
  await w.pass();
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Dentiste" }));
  w.api.userAdd(w.cal(), task({ uid: "t", summary: "Pain" }));
  w.server.loseNextResponse("Sync");
  const reads = () => w.api.calls.filter((c) => c[0] === "readLocalChanges").length;
  const before = reads();
  await rejects(() => w.pass(), (e) => e.code === ERR.NETWORK);
  eq(reads() - before, 1, "nothing is read from the calendar after the request that got no answer");
  eq(w.server.syncs(TASKS).filter((s) => s.commands.length).length, 0);
  await w.pass();
  eq([w.server.items.get(CAL).size, w.server.items.get(TASKS).size], [1, 1]);
});

test("lost response: what was written down is checked when read back; damaged, it is dropped and the changes go afresh", async () => {
  const w = world();
  await w.pass();
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Dentiste" }));
  const key = (await w.coll(CAL)).syncKey;
  for (const damaged of [
    "pas un enregistrement",
    { key, cmds: [{ id: "x", op: "explode", kind: "event" }] },
    { key, cmds: [{ id: "x", op: "add", kind: "event", clientId: "pas un ClientId !", item: event() }] },
    { key, cmds: [{ id: "x", op: "modify", kind: "event", serverId: "", item: event() }] },
    { key, cmds: [{ id: "x", op: "add", kind: "event", clientId: "c1", item: { ...event(), start: "demain" } }] },
    { key: "autre-clé", cmds: [{ id: "x", op: "add", kind: "event", clientId: "c1", item: event() }] },
  ]) {
    await w.records.set("pimOut:7", damaged);
    await w.pass();
    assert(!(await w.records.names()).includes("pimOut:7"), JSON.stringify(damaged).slice(0, 60));
  }
  eq(w.server.items.get(CAL).size, 1, "the user's change went once, the damaged records never");
  eq(w.serverTitles(CAL), ["Dentiste"]);
});

// ── Status 3, period ──────────────────────────────────────────────────────

test("Status 3: full resynchronisation; local items the server no longer has are removed, the others kept, pending changes sent", async () => {
  const w = world();
  const sids = range(10).map((i) => w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` })));
  await w.pass();
  w.server.items.get(CAL).delete(sids[3]); // gone while the key is lost: no Delete will ever say so
  w.server.addItem(CAL, event({ uid: "new", summary: "Nouveau" }));
  w.api.userModify(w.cal(), sids[5], { summary: "E5 modifié" });
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Local" }));
  w.server.invalidate(CAL);
  const r = await w.pass();
  eq(r.pendingDeletes, 0);
  const expected = [...range(10).filter((i) => i !== 3 && i !== 5).map((i) => `E${i}`), "E5 modifié", "Local", "Nouveau"].sort();
  eq(w.titles(), expected);
  eq(w.serverTitles(CAL), expected);
  const keys = w.server.syncs(CAL).map((s) => s.key);
  assert(keys.includes("0") && keys.lastIndexOf("0") > 0, "started again from SyncKey 0");
  eq(w.server.syncs(CAL).filter((s) => s.key === "0").at(-1).supported, [...calendarSupported("14.1")], "Supported again with the new first Sync");
  const coll = await w.coll(CAL);
  eq([coll.full, coll.more], [null, false]);
  assert(!(await w.records.names()).some((n) => n.startsWith("pimSeen:")), "what the rebuild saw is forgotten once it is over");
  eq(w.api.items(w.cal()).filter((x) => x.serverId === null).length, 0);
});

test("Status 3: when the server lost most items, their removal is a mass deletion and waits for the user", async () => {
  const w = world();
  const sids = range(80).map((i) => w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` })));
  await w.pass();
  for (const sid of sids.slice(0, 70)) w.server.items.get(CAL).delete(sid);
  w.server.invalidate(CAL);
  const r = await w.pass();
  eq(r.pendingDeletes, 70);
  eq(w.titles().length, 80, "nothing removed");
  eq((await w.pass({ confirmDeletes: true })).pendingDeletes, 0);
  eq(w.titles().length, 10);
});

test("period change: the collection starts again; items out of the new period leave without counting as deletions", async () => {
  const w = world({ calendarPeriod: "0" });
  for (const i of range(70)) w.server.addItem(CAL, event({ uid: `old${i}`, summary: `Ancien ${i}`, start: "2020-01-01T09:00:00Z", end: "2020-01-01T10:00:00Z" }));
  for (const i of range(6)) w.server.addItem(CAL, event({ uid: `new${i}`, summary: `Récent ${i}` }));
  await w.pass();
  eq(w.titles().length, 76);
  eq(w.server.syncs(CAL).at(-1).filterType, "0");
  w.mailbox.calendarPeriod = "4";
  w.server.inPeriod = (cid, sid, item) => item.summary.startsWith("Récent");
  const r = await w.pass();
  eq([r.pendingDeletes, r.received], [0, 6 + 70], "70 of 76 left the period: removed, not held");
  eq(w.titles(), range(6).map((i) => `Récent ${i}`));
  eq(w.server.syncs(CAL).at(-1).filterType, "4");
  eq((await w.coll(CAL)).filter, "4");
  eq((await w.coll(CAL)).window.count, 0, "nothing counted in the rolling window");
  eq(w.server.items.get(CAL).size, 76, "nothing is deleted on the server");
  // The same period again: no restart.
  const before = w.server.syncs(CAL).filter((s) => s.key === "0").length;
  await w.pass();
  eq(w.server.syncs(CAL).filter((s) => s.key === "0").length, before);
});

test("task filter change: the task collection starts again with the new filter; the calendar is left alone", async () => {
  const w = world();
  w.server.addItem(TASKS, task({ uid: "done", summary: "Faite", completed: true, completedAt: "2026-11-01T08:00:00Z" }));
  w.server.addItem(TASKS, task({ uid: "todo", summary: "À faire" }));
  w.server.addItem(CAL, event());
  await w.pass();
  w.mailbox.taskFilter = "8";
  w.server.inPeriod = (cid, sid, item) => cid !== TASKS || !item.completed;
  await w.pass();
  eq(w.titles(), ["Point hebdomadaire", "À faire"].sort());
  eq(w.server.syncs(TASKS).at(-1).filterType, "8");
  eq(w.server.syncs(CAL).filter((s) => s.key === "0").length, 1);
});

// ── Mass-deletion threshold ───────────────────────────────────────────────

async function hundred(w = world()) {
  const sids = range(100).map((i) => w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` })));
  w.server.addItem(TASKS, task({ uid: "t", summary: "T" }));
  await w.pass();
  eq(w.titles().length, 101);
  return { w, sids };
}

test("threshold: more than 50 deletions and more than 20 % of the collection are held; nothing is removed; the other collection goes on", async () => {
  const { w, sids } = await hundred();
  for (const sid of sids.slice(0, 60)) w.server.deleteItem(CAL, sid);
  const r = await w.pass();
  eq([r.pendingDeletes, await w.pim.pendingDeletes()], [60, 60]);
  eq(w.titles().length, 101);
  eq(w.api.calls.filter((c) => c[0] === "applyServerChanges" && c[2].some((x) => x.op === "remove")).length, 0);
  // Until the user decides: the held collection is not synchronized, the tasks are.
  w.server.addItem(CAL, event({ uid: "later", summary: "Plus tard" }));
  w.server.addItem(TASKS, task({ uid: "t2", summary: "T2" }));
  w.api.userModify(w.cal(), sids[80], { summary: "E80 modifié" });
  const calSyncs = w.server.syncs(CAL).length;
  const again = await w.pass();
  eq([again.pendingDeletes, again.moreAvailable], [60, true]);
  eq(w.server.syncs(CAL).length, calSyncs, "no request for the held collection");
  assert(w.titles().includes("T2") && !w.titles().includes("Plus tard"));
  eq(w.restart() && (await w.pim.pendingDeletes()), 60, "held across a restart");
});

test("threshold: confirmed, the held deletions are applied and the collection goes on", async () => {
  const { w, sids } = await hundred();
  for (const sid of sids.slice(0, 60)) w.server.deleteItem(CAL, sid);
  await w.pass();
  w.api.userModify(w.cal(), sids[80], { summary: "E80 modifié" });
  const r = await w.pass({ confirmDeletes: true });
  eq([r.pendingDeletes, r.sent], [0, 1]);
  eq(w.titles().length, 41);
  eq(await w.pim.pendingDeletes(), 0);
  eq(w.server.items.get(CAL).get(sids[80]).summary, "E80 modifié");
  const window = (await w.coll(CAL)).window;
  eq([window.count, window.since], [0, w.clock.now], "confirmed: the rolling window starts again");
});

test("threshold: discarded, the items stay in the calendar, detached from the server; a later change sends a detached copy as a new item", async () => {
  const { w, sids } = await hundred();
  for (const sid of sids.slice(0, 60)) w.server.deleteItem(CAL, sid);
  await w.pass();
  eq(await w.pim.discardPendingDeletes(), 60);
  eq(await w.pim.pendingDeletes(), 0);
  eq(w.titles().length, 101, "the local copies are kept");
  const rows = w.api.items(w.cal());
  eq([rows.filter((r) => r.detached).length, rows.filter((r) => r.serverId !== null).length], [60, 41]);
  eq((await w.store.serverIds(w.cal(), CAL)).length, 40);
  eq((await w.store.readLocalChanges(w.cal())).changes, [], "detaching records no local change");
  const r = await w.pass();
  eq([r.pendingDeletes, r.sent, w.titles().length], [0, 0, 101]);
  eq(w.server.items.get(CAL).size, 40, "nothing is sent back by itself");
  // The user changes one of the kept copies: it becomes a new item of the server.
  w.api.userModify(w.cal(), (r0) => r0.item.uid === "e7", { summary: "E7 gardé" });
  eq((await w.pass()).sent, 1);
  eq(w.commands(CAL).filter((c) => c === "Add").length, 1);
  assert(w.serverTitles(CAL).includes("E7 gardé"));
  eq(w.api.items(w.cal()).find((x) => x.item.uid === "e7").detached, false);
});

test("threshold: 50 deletions pass, and so do many deletions that are a small share of a large collection", async () => {
  const { w, sids } = await hundred();
  for (const sid of sids.slice(0, 50)) w.server.deleteItem(CAL, sid);
  eq((await w.pass()).pendingDeletes, 0);
  eq(w.titles().length, 51);
  const big = world();
  const many = range(400).map((i) => big.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` })));
  await big.pass();
  for (const sid of many.slice(0, 70)) big.server.deleteItem(CAL, sid); // 70 > 50, but 17.5 % of 400
  eq((await big.pass()).pendingDeletes, 0);
  eq(big.titles().length, 330);
});

test("threshold: counted over 24 hours — a server deleting a little at every pass is stopped the same", async () => {
  const w = world();
  const sids = range(200).map((i) => w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` })));
  await w.pass();
  for (const sid of sids.slice(0, 30)) w.server.deleteItem(CAL, sid);
  eq((await w.pass()).pendingDeletes, 0);
  eq(w.titles().length, 170);
  w.clock.now += 3600_000;
  for (const sid of sids.slice(30, 60)) w.server.deleteItem(CAL, sid);
  const r = await w.pass();
  eq(r.pendingDeletes, 30, "60 in a day, more than 50 and more than 20 % of the 200 there were");
  eq(w.titles().length, 170);
  // A day later the window is over; a Status 3 in between does not start it again.
  const other = world();
  const more = range(200).map((i) => other.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` })));
  await other.pass();
  for (const sid of more.slice(0, 30)) other.server.deleteItem(CAL, sid);
  await other.pass();
  other.server.invalidate(CAL);
  await other.pass();
  eq((await other.coll(CAL)).window.count, 30, "kept through the full resynchronisation");
  other.clock.now += 25 * 3600_000;
  for (const sid of more.slice(30, 60)) other.server.deleteItem(CAL, sid);
  eq((await other.pass()).pendingDeletes, 0);
});

test("threshold: deletions spread over several batches are judged as one run, at its end", async () => {
  const w = world();
  const sids = range(120).map((i) => w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` })));
  await w.pass();
  for (const sid of sids.slice(0, 110)) w.server.deleteItem(CAL, sid); // three batches of 50 at most
  const r = await w.pass();
  eq(r.pendingDeletes, 110);
  eq(w.titles().length, 120);
});

// ── Problems, refusals, unreadable items ──────────────────────────────────

test("problems: a change that cannot be described is undone with its notice, and nothing is sent; a new item stays as a local copy", async () => {
  // Each problem: the wording of the notice of a change, and the name of the notice of a new item (which says why
  // when the user can do something about it).
  const cases = [
    ["recurrence", /répétition|repetition/i, "keptLocalRecurrence"],
    ["too-large", /volumineux|too large/i, "keptLocalTooLarge"],
    ["read-only", /ne peut pas être modifié|cannot be changed/i, "keptLocal"],
    ["something-new", /ne peut pas être modifié|cannot be changed/i, "keptLocal"],
  ];
  for (const [problem, wording, kept] of cases) {
    const w = world();
    const sid = w.server.addItem(CAL, event({ uid: "a", summary: "Du serveur" }));
    await w.pass();
    w.api.userAdd(w.cal(), event({ uid: "l", summary: "Impossible" }), { problem });
    w.api.userModify(w.cal(), sid, { summary: "Modifié à tort" }, { problem });
    const r = await w.pass();
    eq([r.sent, w.commands(CAL)], [0, []], problem);
    eq(w.api.items(w.cal()).map((x) => [x.item.summary, x.serverId, x.detached]), [["Du serveur", sid, false], ["Impossible", null, true]], `${problem}: the changed item is restored, the new one is never deleted`);
    eq(w.named.map((x) => x[0]).sort(), [kept, PROBLEM_NAMES[problem] ?? "readOnly"].sort(), problem);
    assert(w.notices.some((n) => wording.test(n) && n.includes("Du serveur")), "a change without description is named by the last synchronized title");
    if (kept === "keptLocal") assert(w.notices.some((n) => /copie locale/.test(n) && !/annulée/.test(n)), "the notice of a new item says it stays as a local copy");
    eq(w.api.calls.filter((c) => c[0] === "dropLocalChange").length, 2);
    eq((await w.pass()).sent, 0);
    eq(w.named.length, 2, "told once");
  }
});

test("problems: a read-only item of the server cannot be changed or deleted from Thunderbird", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, event({ uid: "ro", summary: "Lecture seule" }));
  await w.pass();
  // As the server sent it: a recurrence in a calendar that is not Gregorian.
  w.api.calendars.get(w.cal()).rows[0].synced.readOnly = "calendar-type";
  w.api.calendars.get(w.cal()).rows[0].item.readOnly = "calendar-type";
  w.api.userModify(w.cal(), sid, { summary: "Changé" });
  await w.pass();
  eq([w.titles(), w.commands(CAL), w.notices.length], [["Lecture seule"], [], 1]);
  w.api.userDelete(w.cal(), sid);
  await w.pass();
  eq([w.titles(), w.commands(CAL), w.notices.length], [["Lecture seule"], [], 2], "the deleted item comes back");
});

test("problems: a description the checks refuse never reaches the server (invalid item, or one the conversion cannot write)", async () => {
  const w = world();
  await w.pass();
  w.api.userAdd(w.cal(), { ...event({ uid: "bad", summary: "Invalide" }), start: "demain" });
  w.api.userAdd(w.cal(), { ...event({ uid: "ro", summary: "Lecture seule" }), readOnly: "unsupported-recurrence" });
  w.api.userAdd(w.cal(), event({ uid: "ok", summary: "Valable" }));
  const r = await w.pass();
  eq([r.sent, w.serverTitles(CAL), w.titles()], [1, ["Valable"], ["Invalide", "Lecture seule", "Valable"]]);
  eq(w.api.items(w.cal()).filter((x) => x.detached).map((x) => x.item.summary).sort(), ["Invalide", "Lecture seule"], "what could not be sent stays, as local copies");
  eq(w.notices.length, 2);
});

test("refusals: a Change the server refuses is undone, the user told, and the server's version fetched again", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, event({ uid: "a", summary: "Version du serveur" }));
  await w.pass();
  w.server.changeStatus.set(sid, "6");
  w.server.items.get(CAL).get(sid).location = "Changé entre-temps"; // the server's item moved on, silently
  w.api.userModify(w.cal(), sid, { summary: "Version locale" });
  const r = await w.pass();
  eq(r.sent, 0);
  eq(w.commands(CAL), ["Change", "Fetch"]);
  const [row] = w.api.items(w.cal());
  eq([row.item.summary, row.item.location], ["Version du serveur", "Changé entre-temps"], "the server's version is restored, as it is now");
  eq(w.notices.length, 1);
  assert(/serveur a refusé|server refused/i.test(w.notices[0]) && w.notices[0].includes("Version locale"), w.notices[0]);
  eq((await w.store.readLocalChanges(w.cal())).changes, []);
  eq((await w.coll(CAL)).refetch, []);
  const requests = w.server.requests.length;
  await w.pass();
  eq(w.commands(CAL), ["Change", "Fetch"], "not sent again, not fetched again");
  eq(w.server.requests.length - requests, 2);
});

test("refusals: a Change to an item the server no longer has is undone, and the local copy leaves like any deleted item", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, event({ uid: "a", summary: "Parti" }));
  w.server.addItem(CAL, event({ uid: "b", summary: "Resté" }));
  await w.pass();
  w.server.items.get(CAL).delete(sid);
  w.api.userModify(w.cal(), sid, { summary: "Modifié trop tard" });
  await w.pass();
  eq(w.titles(), ["Resté"]);
  eq(w.notices.length, 1);
});

test("refusals: an Add the server refuses for good, or does not answer, is never deleted — it stays as a local copy, and the user is told so", async () => {
  for (const status of ["6", "7", "none"]) {
    const w = world();
    await w.pass();
    w.server.addStatus = (item) => (item.summary === "Refusé" ? status : null);
    w.api.userAdd(w.cal(), event({ uid: "no", summary: "Refusé" }));
    w.api.userAdd(w.cal(), event({ uid: "yes", summary: "Accepté" }));
    const r = await w.pass();
    eq([r.sent, w.titles(), w.serverTitles(CAL)], [1, ["Accepté", "Refusé"], ["Accepté"]], status);
    eq(w.api.items(w.cal()).find((x) => x.item.uid === "no").detached, true, "detached: a local copy");
    eq(w.notices.length, 1);
    assert(w.notices[0].includes("Refusé") && /copie locale/.test(w.notices[0]), w.notices[0]);
    assert(!/version du serveur/.test(w.notices[0]), "there is no server version of a new item to restore");
    await w.pass();
    eq(w.commands(CAL).filter((c) => c === "Add").length, 2, "never sent again by itself");
    eq(w.titles(), ["Accepté", "Refusé"]);
    // Changed by the user later, the copy is sent as a new item.
    w.server.addStatus = null;
    w.api.userModify(w.cal(), "no", { summary: "Refusé, corrigé" });
    eq((await w.pass()).sent, 1);
    eq(w.serverTitles(CAL), ["Accepté", "Refusé, corrigé"]);
  }
});

test("refusals: a Delete the server refuses brings the item back", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, event({ uid: "a", summary: "Indestructible" }));
  await w.pass();
  w.server.deleteStatus.set(sid, "6");
  w.api.userDelete(w.cal(), sid);
  await w.pass();
  eq([w.titles(), w.notices.length], [["Indestructible"], 1]);
});

// ── An unwell server ──────────────────────────────────────────────────────

const collectionOf = (req) => at(req, "Collections", "Collection");
const CAL_ONLY = { mail: true, calendar: true, contacts: false, tasks: false };

test("unwell server: a collection or a command that answers \"server error\" for an hour undoes nothing — the changes wait, and go when the server is back", async () => {
  const answers = [
    ["collection 5", (key) => statusOnly(CAL, "5", key)],
    ["collection 16", (key) => statusOnly(CAL, "16", key)],
    ["command 111", () => el("AirSync:Sync", [el("Status", "111")])],
  ];
  for (const [name, answer] of answers) {
    const w = world();
    const a = w.server.addItem(CAL, event({ uid: "a", summary: "Existant" }));
    await w.pass();
    w.api.userAdd(w.cal(), event({ uid: "n1", summary: "Nouveau", description: "long texte saisi par l'utilisateur" }));
    w.api.userAdd(w.cal(), event({ uid: "n2", summary: "Deuxième" }));
    w.api.userModify(w.cal(), a, { location: "Salle 9" });
    const base = w.server.onSync.bind(w.server);
    w.server.onSync = (req) => (text(collectionOf(req), "CollectionId") === CAL ? answer(text(collectionOf(req), "SyncKey")) : base(req));
    for (let pass = 0; pass < 40; pass++) {
      // A pass every minute and a half, for an hour; the user even asks by hand.
      await rejects(() => w.pass(), (e) => e.code === "SERVER", `${name}, pass ${pass}`);
      w.clock.now += 90_000;
    }
    eq(w.titles(), ["Deuxième", "Existant", "Nouveau"], name);
    eq(w.api.items(w.cal()).find((x) => x.serverId === a).item.location, "Salle 9", "the edit is not reverted");
    eq([w.notices, w.api.calls.filter((c) => c[0] === "dropLocalChange").length], [[], 0], "nothing undone, nothing told");
    eq((await w.coll(CAL)).tries.map((x) => x[1]), [0, 0, 0], "no try is held against any change");
    assert(w.server.syncs(CAL).length <= 45, "one request per pass, no more");
    // The server is back.
    w.server.onSync = base;
    const r = await settle(w);
    eq([r.sent, w.serverTitles(CAL), w.server.adds.length], [3, ["Deuxième", "Existant", "Nouveau"], 2], "each new item is created once");
    eq(w.server.items.get(CAL).get(a).location, "Salle 9");
    eq([(await w.coll(CAL)).tries, (await w.coll(CAL)).strikes, w.notices], [[], 0, []]);
    eq((await w.store.readLocalChanges(w.cal())).changes, []);
  }
});

test("unwell server: a request refused as a whole is replayed as it was; after MAX_STRIKES its changes go one at a time, and the one the server chokes on is found", async () => {
  const w = world({ sync: CAL_ONLY });
  const a = w.server.addItem(CAL, event({ uid: "a", summary: "A" }));
  const b = w.server.addItem(CAL, event({ uid: "b", summary: "B" }));
  const c = w.server.addItem(CAL, event({ uid: "c", summary: "C" }));
  await w.pass();
  w.api.userModify(w.cal(), a, { summary: "A modifié" });
  w.api.userModify(w.cal(), b, { summary: "B indigeste" });
  w.api.userModify(w.cal(), c, { summary: "C modifié" });
  // Any request that carries the change of B is refused whole (Status 4: the server cannot read it).
  const base = w.server.onSync.bind(w.server);
  w.server.onSync = (req) => ((child(collectionOf(req), "Commands")?.children ?? []).some((x) => x.tag === "Change" && text(x, "ServerId") === b) ? statusOnly(CAL, "4", text(collectionOf(req), "SyncKey")) : base(req));
  for (let i = 0; i < MAX_STRIKES; i++) {
    assert(i === 0 || (await w.records.names()).includes("pimOut:7"), "what was sent stays written down");
    await rejects(() => w.pass(), (e) => e.code === "SERVER");
  }
  const whole = w.server.syncs(CAL).filter((x) => x.commands.length === 3);
  eq(whole.length, MAX_STRIKES);
  eq(whole[0], whole.at(-1), "sent again as it was");
  eq([(await w.coll(CAL)).tries.map((x) => x[1]), w.notices, w.titles()], [[0, 0, 0], [], ["A modifié", "B indigeste", "C modifié"]], "nothing held against any change yet");
  // One at a time: A and C pass, B fails alone and is the one counted.
  await rejects(() => w.pass(), (e) => e.code === "SERVER");
  await rejects(() => w.pass(), (e) => e.code === "SERVER");
  eq(w.serverTitles(CAL), ["A modifié", "B", "C modifié"], "the others are not held back by it");
  eq((await w.coll(CAL)).tries, [[(await w.store.readLocalChanges(w.cal())).changes[0].changeId, 2]]);
  await rejects(() => w.pass(), (e) => e.code === "SERVER");
  const alone = w.server.syncs(CAL).filter((x) => x.commands.length === 1 && x.commands[0].serverId === b);
  eq(alone.length, MAX_TRIES);
  await w.pass();
  eq(w.server.syncs(CAL).filter((x) => x.commands.some((y) => y.tag === "Change" && y.serverId === b)).length, MAX_STRIKES + MAX_TRIES, "given up: not sent again");
  eq([w.titles(), w.notices.length], [["A modifié", "B", "C modifié"], 1], "the server's version is restored");
  assert(/serveur a refusé/.test(w.notices[0]) && w.notices[0].includes("B indigeste"), w.notices[0]);
});

test("unwell server: an item status 5 or 16 leaves the change waiting and holds nothing against it; said pass after pass, it fails the pass", async () => {
  for (const status of ["5", "16"]) {
    const w = world();
    const a = w.server.addItem(CAL, event({ uid: "a", summary: "A" }));
    const b = w.server.addItem(CAL, event({ uid: "b", summary: "B" }));
    await w.pass();
    w.server.changeStatus.set(a, status);
    w.api.userModify(w.cal(), a, { summary: "A modifié" });
    w.api.userModify(w.cal(), b, { summary: "B modifié" });
    const first = await w.pass();
    eq([first.sent, first.moreAvailable, w.notices.length], [1, false, 0], "the other change went; this one waits for the next pass");
    eq(w.titles(), ["A modifié", "B modifié"], "the change waits, it is not undone");
    // (The server has news of its own at every pass: answers that carry none of our commands change nothing to it.)
    const news = (i) => range(PIM_WINDOW_SIZE + 1).forEach((k) => w.server.addItem(CAL, event({ uid: `n${i}-${k}`, summary: "Autre" })));
    news("x");
    eq((await w.pass()).received, PIM_WINDOW_SIZE + 1);
    for (let i = 0; i < 12; i++) {
      news(i);
      await rejects(() => w.pass(), (e) => e.code === "SERVER", "the third time in a row, and from then on: a failure the user sees");
    }
    const sent = w.server.syncs(CAL).filter((x) => x.commands.some((y) => y.serverId === a));
    eq(sent.length, 14, "once per pass");
    assert(sent.slice(1).every((x) => x.commands.length === 1), "alone");
    eq([w.titles().filter((x) => x !== "Autre"), w.notices, (await w.coll(CAL)).tries.map((x) => x[1])], [["A modifié", "B modifié"], [], [0]], "never undone, nothing counted");
    // The status goes away: the change passes at the next try.
    w.server.changeStatus.delete(a);
    eq((await w.pass()).sent, 1);
    eq([w.serverTitles(CAL).filter((x) => x !== "Autre"), w.notices, (await w.coll(CAL)).tries, (await w.coll(CAL)).strikes], [["A modifié", "B modifié"], [], [], 0]);
  }
});

test("unwell server: a status that says nothing final counts only against a change that went alone; after MAX_TRIES a new item is given up, and stays as a local copy", async () => {
  const w = world();
  await w.pass();
  w.server.addStatus = (item) => (item.summary === "Indigeste" ? "4" : null);
  w.api.userAdd(w.cal(), event({ uid: "bad", summary: "Indigeste" }));
  w.api.userAdd(w.cal(), event({ uid: "ok", summary: "Bon" }));
  eq((await w.pass()).sent, 1);
  eq((await w.coll(CAL)).tries.map((x) => x[1]), [0], "it did not go alone: nothing is counted");
  await w.pass();
  await rejects(() => w.pass(), (e) => e.code === "SERVER");
  await rejects(() => w.pass(), (e) => e.code === "SERVER");
  eq((await w.coll(CAL)).tries.map((x) => x[1]), [MAX_TRIES]);
  eq(w.notices, []);
  const adds = () => w.commands(CAL).filter((x) => x === "Add").length;
  eq(adds(), 2 + MAX_TRIES);
  await w.pass();
  eq(adds(), 2 + MAX_TRIES, "given up: not sent again");
  eq(w.api.items(w.cal()).map((x) => [x.item.summary, x.detached]).sort(), [["Bon", false], ["Indigeste", true]], "never deleted");
  eq(w.notices.length, 1);
  assert(w.notices[0].includes("Indigeste") && /copie locale/.test(w.notices[0]), w.notices[0]);
});

test("unwell server: a change sent alone that the server refuses whole, without saying it is unwell, is given up after MAX_TRIES passes", async () => {
  const w = world();
  const a = w.server.addItem(CAL, event({ uid: "a", summary: "A" }));
  await w.pass();
  w.api.userModify(w.cal(), a, { summary: "A modifié" });
  for (let i = 0; i < MAX_TRIES; i++) {
    w.server.hook("Sync", () => statusOnly(CAL, "6"));
    await rejects(() => w.pass(), (e) => e.code === "SERVER");
    eq(w.titles(), ["A modifié"], "not undone while it is tried");
  }
  await w.pass();
  eq([w.titles(), w.notices.length], [["A"], 1], "given up after a few passes, never in a loop");
});

test("unwell server: an empty answer to a request that carried commands is no answer — the pass fails, and nothing loops for ever", async () => {
  const w = world({ sync: CAL_ONLY });
  await w.pass();
  w.api.userAdd(w.cal(), event({ uid: "n1", summary: "Nouveau" }));
  let carried = 0;
  const base = w.server.onSync.bind(w.server);
  w.server.onSync = (req) => {
    if (!child(collectionOf(req), "Commands")) return base(req);
    carried++;
    return null;
  };
  for (let i = 0; i < MAX_TRIES; i++) await rejects(() => w.pass(), (e) => e.code === ERR.BAD_RESPONSE);
  eq([carried, w.titles(), w.notices], [MAX_TRIES, ["Nouveau"], []]);
  const asSent = w.server.syncs(CAL).filter((s) => s.commands.length);
  eq([asSent.length, asSent[0], asSent[0]], [MAX_TRIES, asSent[1], asSent[2]], "sent again as it was each time: the server may have taken it");
  for (let i = 0; i < 9; i++) await w.pass();
  eq(carried, MAX_TRIES, "sent alone and left unanswered MAX_TRIES times: given up, not sent in every pass for ever");
  eq(w.api.items(w.cal()).map((x) => [x.item.summary, x.serverId, x.detached]), [["Nouveau", null, true]], "the new item is never deleted: a local copy");
  eq(w.notices.length, 1);
  assert(/copie locale/.test(w.notices[0]), w.notices[0]);
  // Several changes: the request is replayed as it was, then cut.
  const two = world({ sync: CAL_ONLY });
  await two.pass();
  two.api.userAdd(two.cal(), event({ uid: "n1", summary: "Un" }));
  two.api.userAdd(two.cal(), event({ uid: "n2", summary: "Deux" }));
  const real = two.server.onSync.bind(two.server);
  two.server.onSync = (req) => (child(collectionOf(req), "Commands") ? null : real(req));
  for (let i = 0; i < MAX_STRIKES; i++) await rejects(() => two.pass(), (e) => e.code === ERR.BAD_RESPONSE);
  eq((await two.coll(CAL)).tries.map((x) => x[1]), [0, 0]);
  two.server.onSync = real;
  eq((await settle(two)).sent, 2);
  eq([two.serverTitles(CAL), two.notices], [["Deux", "Un"], []]);
});

test("unwell server: a request the server took but whose answers cannot be read is cut into single changes that keep their ClientIds — no new item is created twice", async () => {
  const w = world({ sync: CAL_ONLY });
  await w.pass();
  for (const i of range(3)) w.api.userAdd(w.cal(), event({ uid: `n${i}`, summary: `Nouveau ${i}` }));
  const base = w.server.onSync.bind(w.server);
  let bad = MAX_STRIKES;
  w.server.onSync = (req) => {
    const out = base(req); // the server takes the request…
    return child(collectionOf(req), "Commands") && bad-- > 0 ? el("AirSync:Sync", [el("Collections", [])]) : out; // …and its answer says nothing
  };
  for (let i = 0; i < MAX_STRIKES; i++) await rejects(() => w.pass(), (e) => e.code === ERR.BAD_RESPONSE);
  eq([w.server.adds.length, (await w.coll(CAL)).was, (await w.records.names()).includes("pimWas:7")], [3, true, true], "taken by the server; remembered here");
  const r = await settle(w);
  eq([r.sent, w.server.adds.length, w.serverTitles(CAL), w.titles()], [3, 3, ["Nouveau 0", "Nouveau 1", "Nouveau 2"], ["Nouveau 0", "Nouveau 1", "Nouveau 2"]], "each one once, here and there");
  const ids = w.server.syncs(CAL).flatMap((x) => x.commands).filter((x) => x.tag === "Add").map((x) => x.clientId);
  eq([ids.length, new Set(ids).size], [3 * MAX_STRIKES + 1, 3], "the one that went alone went under the ClientId it had");
  eq(w.api.items(w.cal()).map((x) => x.serverId).sort(), w.server.adds.map((a) => a.serverId).sort(), "all three bound from the first answer that could be read");
  eq([(await w.coll(CAL)).was, (await w.records.names()).includes("pimWas:7"), (await w.coll(CAL)).tries, w.notices], [false, false, [], []]);
  // A server that had not taken them: each goes alone, still under its first ClientId, and is created once.
  const not = world({ sync: CAL_ONLY });
  await not.pass();
  for (const i of range(3)) not.api.userAdd(not.cal(), event({ uid: `n${i}`, summary: `Nouveau ${i}` }));
  const real = not.server.onSync.bind(not.server);
  let refused = MAX_STRIKES;
  not.server.onSync = (req) => (child(collectionOf(req), "Commands") && refused-- > 0 ? el("AirSync:Sync", [el("Collections", [])]) : real(req));
  for (let i = 0; i < MAX_STRIKES; i++) await rejects(() => not.pass(), (e) => e.code === ERR.BAD_RESPONSE);
  eq((await settle(not)).sent, 3);
  const sent = not.server.syncs(CAL).flatMap((x) => x.commands).filter((x) => x.tag === "Add").map((x) => x.clientId);
  eq([not.server.adds.length, new Set(sent).size, not.serverTitles(CAL).length, (await not.coll(CAL)).was], [3, 3, 3, false]);
});

test("unwell server: a folder said gone (8), a changed hierarchy (12) or a refused SyncKey (3), at every pass, fails the pass at the third in a row", async () => {
  for (const status of ["8", "12"]) {
    const w = world({ sync: CAL_ONLY });
    w.server.addItem(CAL, event());
    await w.pass();
    w.api.userAdd(w.cal(), event({ uid: "n1", summary: "Nouveau" }));
    const base = w.server.onSync.bind(w.server);
    w.server.onSync = (req) => statusOnly(CAL, status, text(collectionOf(req), "SyncKey"));
    for (let i = 1; i < MAX_STRIKES; i++) eq((await w.pass()).hierarchyChanged, true, "the folder list is asked first");
    for (let i = 0; i < 5; i++) await rejects(() => w.pass(), (e) => e.code === "SERVER", `Status ${status} for ever`);
    eq([w.titles().length, w.notices], [2, []], "the user's change waits");
    w.server.onSync = base;
    eq((await w.pass()).sent, 1);
    eq((await w.coll(CAL)).strikes, 0);
  }
  // A server that refuses every SyncKey it gave.
  const w = world({ sync: CAL_ONLY });
  w.server.addItem(CAL, event());
  await w.pass();
  let requests = 0;
  const base = w.server.onSync.bind(w.server);
  w.server.onSync = (req) => {
    requests++;
    return text(collectionOf(req), "SyncKey") === "0" ? base(req) : statusOnly(CAL, "3", text(collectionOf(req), "SyncKey"));
  };
  await rejects(() => w.pass(), (e) => e.code === "SERVER");
  assert(requests <= 2 * MAX_STRIKES, `${requests} requests in one pass`);
  for (let i = 0; i < 5; i++) await rejects(() => w.pass(), (e) => e.code === "SERVER");
  assert(requests <= 2 * MAX_STRIKES + 10, `${requests} requests in six passes: two at most in each of the later ones`);
  eq(w.titles().length, 1, "nothing is removed meanwhile");
  w.server.onSync = base;
  const r = await settle(w);
  eq([r.pendingDeletes, w.titles().length, (await w.coll(CAL)).strikes, (await w.coll(CAL)).full], [0, 1, 0, null]);
});

test("unreadable items: counted and skipped, never fatal, not asked for again; a later change of the server repairs them", async () => {
  const w = world();
  w.server.addItem(CAL, event({ uid: "a", summary: "Avant" }));
  const bad = w.server.addRaw(CAL, [el("Calendar:UID", "cassé"), el("Calendar:Subject", "Illisible"), el("Calendar:StartTime", "pas une date"), el("Calendar:EndTime", "20261201T100000Z")]);
  const noEnd = w.server.addRaw(CAL, [el("Calendar:UID", "sans-fin"), el("Calendar:StartTime", "20261201T090000Z")]);
  w.server.addItem(CAL, event({ uid: "z", summary: "Après" }));
  w.server.addRaw(TASKS, [el("Tasks:Subject", "Tâche cassée"), el("Tasks:Complete", "1")]); // complete without a date
  const r = await w.pass();
  eq([r.failed, r.received], [3, 2]);
  eq(w.titles(), ["Après", "Avant"], "the others are applied");
  eq((await w.coll(CAL)).syncKey, "2", "the SyncKey moves on: the batch does not come again");
  eq((await w.coll(CAL)).quarantine.map((q) => q[0]).sort(), [bad, noEnd].sort());
  const requests = w.server.requests.length;
  const again = await w.pass();
  eq([again.failed, again.received, w.server.requests.length - requests], [3, 0, 2], "still counted, nothing asked again");
  w.server.changeItem(CAL, bad, event({ uid: "cassé", summary: "Réparé" }));
  w.server.deleteItem(CAL, noEnd);
  const fixed = await w.pass();
  eq([fixed.failed, w.titles()], [1, ["Après", "Avant", "Réparé"]]);
});

test("unreadable items: a Change with nothing to apply (no StartTime) is not a bad item, and the item is not lost", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, event({ uid: "a", summary: "Intact" }));
  await w.pass();
  w.server.changeItem(CAL, sid, { raw: [el("Calendar:Subject", "Fragment")] });
  const r = await w.pass();
  eq([r.failed, r.received, w.titles()], [0, 0, ["Intact"]]);
  eq((await w.coll(CAL)).quarantine, []);
});

test("unreadable items: an item the calendar refuses is counted; when every write fails, nothing is saved and the batch comes again, a few times", async () => {
  const w = world();
  w.server.addItem(CAL, event({ uid: "a", summary: "A" }));
  w.server.addItem(CAL, event({ uid: "b", summary: "B" }));
  w.api.failApply = (change) => (change.item.summary === "B" ? "TOO_LARGE" : null);
  const r = await w.pass();
  eq([r.failed, r.received, w.titles()], [1, 1, ["A"]]);
  // Every write fails for a reason that is not the items'.
  const down = world();
  for (const i of range(3)) down.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }));
  down.api.failApply = () => "INTERNAL";
  await rejects(() => down.pass(), (e) => e.code === "LOCAL");
  eq((await down.coll(CAL)).syncKey, "1", "the SyncKey did not move");
  down.api.failApply = null;
  const ok = await down.pass();
  eq([ok.received, ok.failed, down.titles().length], [3, 0, 3]);
  // …but not for ever.
  const stuck = world();
  for (const i of range(3)) stuck.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }));
  stuck.api.failApply = () => "INTERNAL";
  await rejects(() => stuck.pass(), (e) => e.code === "LOCAL");
  await rejects(() => stuck.pass(), (e) => e.code === "LOCAL");
  eq((await stuck.pass()).failed, 3);
});

test("unreadable items: a response the protocol refuses, or without the collection, fails the pass and saves nothing", async () => {
  const w = world();
  w.server.addItem(CAL, event());
  await w.pass();
  const key = (await w.coll(CAL)).syncKey;
  w.server.addItem(CAL, event({ uid: "b", summary: "B" }));
  w.server.hook("Sync", () => el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", "9"), el("CollectionId", "999"), el("Status", "1")])])]));
  await rejects(() => w.pass(), (e) => e.code === ERR.BAD_RESPONSE);
  w.server.hook("Sync", () => el("AirSync:Sync", [el("Collections", [el("Collection", [el("CollectionId", CAL), el("Status", "1")])])]));
  await rejects(() => w.pass(), (e) => e.code === ERR.BAD_RESPONSE);
  w.server.hook("Sync", () => el("FolderHierarchy:FolderSync", [el("Status", "1")]));
  await rejects(() => w.pass(), (e) => e.code === ERR.BAD_RESPONSE);
  eq((await w.coll(CAL)).syncKey, key);
  await w.pass();
  eq(w.titles().length, 2);
});

// ── Kinds, folders, removal ───────────────────────────────────────────────

test("unchecked kind: its local items are removed and its records forgotten; the other kind stays", async () => {
  const w = world();
  w.server.addItem(CAL, event({ uid: "e", summary: "Événement" }));
  w.server.addItem(TASKS, task({ uid: "t", summary: "Tâche" }));
  await w.pass();
  w.api.userAdd(w.cal(), task({ uid: "l", summary: "Tâche jamais envoyée" }));
  w.mailbox.sync.tasks = false;
  const requests = w.server.syncs(TASKS).length;
  await w.pass();
  eq(w.api.items(w.cal()).map((x) => [x.item.summary, x.serverId === null, x.detached]), [["Événement", false, false], ["Tâche jamais envoyée", true, true]], "the server's task is removed; the one never sent is the only copy there is, and stays");
  eq(w.server.syncs(TASKS).length, requests, "nothing is asked for a kind that is not chosen");
  eq(await w.coll(TASKS), null);
  const main = w.api.calendars.get(w.cal());
  eq([main.events, main.tasks], [true, false]);
  eq(w.server.items.get(TASKS).size, 1, "nothing is touched on the server");
  eq(w.notices, [], "the user chose it, and was asked before");
  // Checked again: synchronized from scratch.
  w.mailbox.sync.tasks = true;
  await w.pass();
  eq(w.titles(), ["Tâche", "Tâche jamais envoyée", "Événement"].sort());
  eq(w.server.items.get(TASKS).size, 1, "the copy kept is not sent by itself");
});

test("unchecked kinds: with neither calendar nor tasks, the calendar itself goes", async () => {
  const w = world();
  w.server.addItem(CAL, event());
  w.server.addItem(TASKS, task());
  await w.pass();
  w.mailbox.sync.calendar = false;
  w.mailbox.sync.tasks = false;
  const requests = w.server.requests.length;
  const r = await w.pass();
  eq(r, { received: 0, sent: 0, failed: 0, pendingDeletes: 0, moreAvailable: false, hierarchyChanged: false });
  eq([w.api.calendars.size, w.server.requests.length - requests], [0, 0]);
  eq((await w.records.names()).filter((n) => n.startsWith("pim")), []);
});

const WITH_TEAM = [...PIM_FOLDERS, { id: "20", parentId: "7", name: "Équipe", type: 13 }, { id: "21", parentId: "0", name: "Courses", type: 15 }];

test("other folders: each has a calendar of its own, named after the folder; a local add goes to its folder", async () => {
  const w = world({ folders: WITH_TEAM });
  w.server.addItem("20", event({ uid: "team", summary: "Point d'équipe" }));
  w.server.addItem("21", task({ uid: "milk", summary: "Lait" }));
  w.server.addItem(CAL, event({ uid: "mine", summary: "Perso" }));
  await w.pass();
  eq(w.api.calendars.size, 3);
  const team = w.api.calendars.get(w.cal("20"));
  const shopping = w.api.calendars.get(w.cal("21"));
  eq([team.name, team.events, team.tasks], ["Équipe", true, false]);
  eq([shopping.name, shopping.events, shopping.tasks], ["Courses", false, true]);
  eq([w.titles("20"), w.titles("21"), w.titles()], [["Point d'équipe"], ["Lait"], ["Perso"]]);
  w.api.userAdd(w.cal("20"), event({ uid: "l", summary: "Revue d'équipe" }));
  await w.pass();
  eq(w.serverTitles("20"), ["Point d'équipe", "Revue d'équipe"]);
  eq(w.serverTitles(CAL), ["Perso"]);
  // An item of a kind the calendar does not hold is refused by the calendar itself, and counted.
  w.server.addItem("21", task({ uid: "ok", summary: "Œufs" }));
  await w.pass();
  eq(w.titles("21"), ["Lait", "Œufs"]);
});

test("folder gone: its calendar is removed and its records forgotten; a folder moved to the trash is gone too", async () => {
  const w = world({ folders: WITH_TEAM });
  w.server.addItem("20", event({ uid: "team", summary: "Point d'équipe" }));
  w.server.addItem("21", task({ uid: "milk", summary: "Lait" }));
  await w.pass();
  w.server.removeFolder("20");
  w.server.folders.get("21").parentId = "3"; // deleted on the webmail: it lies in Deleted Items
  const r = await w.pass();
  eq(r.pendingDeletes, 0);
  eq([...w.api.calendars.values()].map((c) => c.slot), ["main"]);
  eq([await w.coll("20"), await w.coll("21")], [null, null]);
  eq(w.server.syncs("21").length, 2, "no request for a folder in the trash");
});

test("folder gone: with enough items to be a mass deletion, its removal waits for the user — confirmed, or kept as a local calendar", async () => {
  for (const decision of ["confirm", "discard"]) {
    const w = world({ folders: WITH_TEAM });
    for (const i of range(60)) w.server.addItem("20", event({ uid: `e${i}`, summary: `E${i}` }));
    await w.pass();
    w.server.removeFolder("20");
    const r = await w.pass();
    eq([r.pendingDeletes, await w.pim.pendingDeletes(), w.titles("20").length], [60, 60, 60], "held, nothing removed");
    eq((await w.pass()).pendingDeletes, 60, "and held at every pass");
    if (decision === "confirm") {
      eq((await w.pass({ confirmDeletes: true })).pendingDeletes, 0);
      eq(w.cal("20"), null);
    } else {
      eq(await w.pim.discardPendingDeletes(), 60);
      eq((await w.pass()).pendingDeletes, 0);
      eq(w.titles("20").length, 60, "the calendar stays, local");
      eq(w.api.items(w.cal("20")).filter((x) => x.serverId !== null || !x.detached).length, 0);
      await w.pass();
      eq(w.titles("20").length, 60, "and no later pass removes it");
      await w.pim.removeLocal();
      eq(w.api.calendars.size, 0, "until the mailbox's calendars are removed");
    }
    eq(await w.coll("20"), null);
    eq(await w.pim.pendingDeletes(), 0);
  }
});

test("folder gone in the very pass that applies a confirmation: the confirmation covers what was held, not this folder", async () => {
  const w = world({ folders: WITH_TEAM });
  const sids = range(100).map((i) => w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` })));
  for (const i of range(60)) w.server.addItem("20", event({ uid: `team${i}`, summary: `Équipe ${i}` }));
  await w.pass();
  for (const sid of sids.slice(0, 60)) w.server.deleteItem(CAL, sid);
  eq((await w.pass()).pendingDeletes, 60, "what the user is shown, and confirms");
  w.server.removeFolder("20"); // meanwhile, on the server
  const r = await w.pass({ confirmDeletes: true });
  eq(w.titles().length, 40, "the 60 deletions confirmed are applied");
  eq([r.pendingDeletes, w.titles("20").length], [60, 60], "the folder gone since is held in its turn: nobody confirmed it");
  eq((await w.pass({ confirmDeletes: true })).pendingDeletes, 0, "confirmed in its turn");
  eq(w.cal("20"), null);
});

test("folder gone, then back before the user decided: nothing is left to decide, and the collection goes on", async () => {
  const w = world({ folders: WITH_TEAM });
  for (const i of range(60)) w.server.addItem("20", event({ uid: `e${i}`, summary: `E${i}` }));
  await w.pass();
  const folder = w.server.folders.get("20");
  w.server.folders.delete("20");
  eq((await w.pass()).pendingDeletes, 60);
  w.server.folders.set("20", folder); // the folder list was wrong for a moment
  w.server.addItem("20", event({ uid: "new", summary: "Nouveau" }));
  const r = await w.pass();
  eq([r.pendingDeletes, w.titles("20").length], [0, 61]);
});

test("pass: a response too large is asked again in smaller batches", async () => {
  const w = world();
  for (const i of range(8)) w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }));
  let refused = 0;
  const base = w.server.command.bind(w.server);
  w.server.command = async (cmd, root, opts) => {
    const window = Number(at(root, "Collections", "Collection", "WindowSize") ? text(at(root, "Collections", "Collection"), "WindowSize") : "0");
    if (cmd === "Sync" && window > 4 && text(at(root, "Collections", "Collection"), "SyncKey") !== "0") {
      refused++;
      throw new EasError(ERR.TOO_LARGE, "Réponse trop volumineuse.", { sent: true });
    }
    return base(cmd, root, opts);
  };
  const r = await w.pass();
  eq([r.received, w.titles().length], [8, 8]);
  assert(refused >= 4, "50, 25, 12, 6 are refused; 3 passes");
  eq(w.server.syncs(CAL).length >= 3, true);
});

test("folder list: a collection the server no longer knows (Status 8) or a changed hierarchy (12) asks for FolderSync and changes nothing", async () => {
  for (const status of ["8", "12"]) {
    const w = world();
    w.server.addItem(CAL, event());
    await w.pass();
    w.api.userAdd(w.cal(), event({ uid: "l", summary: "Local" }));
    w.server.hook("Sync", () => el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", "2"), el("CollectionId", CAL), el("Status", status)])])]));
    const r = await w.pass();
    eq([r.hierarchyChanged, r.moreAvailable, r.sent], [true, true, 0]);
    eq(w.titles().length, 2, "the local change waits");
    eq((await w.pass()).sent, 1);
  }
});

test("removeLocal: the mailbox's calendars are removed and every calendar record forgotten; another mailbox's calendars are not touched", async () => {
  const w = world({ folders: WITH_TEAM });
  w.server.addItem(CAL, event());
  w.server.addItem("20", event({ uid: "team", summary: "Équipe" }));
  await w.pass();
  await w.api.ensureCalendar({ mailboxId: "ffffffffffff", slot: "main", name: "Autre boîte", events: true, tasks: true, organizerEmail: "autre@example.com" });
  w.api.userAdd(w.cal(), meeting([A]));
  w.send = false;
  await w.pass({ deliver: false });
  eq(await w.scheduler.pending(), 1);
  eq(await w.pim.removeLocal(), 3);
  eq([...w.api.calendars.values()].map((c) => c.mailboxId), ["ffffffffffff"]);
  eq((await w.records.names()).filter((n) => n.startsWith("pim") || n === "meetingOutbox"), []);
  eq(await w.scheduler.pending(), 0, "nothing of it will be asked or sent");
  eq(w.pim.pingFolders(w.server.folders), []);
  eq(w.server.items.get(CAL).size, 2, "nothing is touched on the server");
});

test("pingFolders: the calendar and task collections that have a SyncKey of their own, with their class", async () => {
  const w = world({ folders: WITH_TEAM });
  eq(w.pim.pingFolders(w.server.folders), [], "nothing before the first pass");
  await w.pass();
  eq(w.pim.pingFolders(w.server.folders), [{ id: "7", class: "Calendar" }, { id: "8", class: "Tasks" }, { id: "20", class: "Calendar" }, { id: "21", class: "Tasks" }]);
  w.mailbox.sync.tasks = false;
  eq(w.pim.pingFolders(w.server.folders), [{ id: "7", class: "Calendar" }, { id: "20", class: "Calendar" }]);
});

test("pass: `only` limits the server requests to the collections named, unless another has something to send", async () => {
  const w = world();
  w.server.addItem(CAL, event());
  await w.pass();
  const count = () => [w.server.syncs(CAL).length, w.server.syncs(TASKS).length];
  const before = count();
  w.server.addItem(TASKS, task());
  await w.pass({ only: [CAL] });
  eq(count(), [before[0] + 1, before[1]]);
  eq(w.titles().length, 1);
  await w.pass({ only: ["1"] }); // a mail folder changed: nothing for the calendar
  eq(count(), [before[0] + 1, before[1]]);
  w.api.userAdd(w.cal(), task({ uid: "l", summary: "Locale" }));
  await w.pass({ only: [CAL] });
  eq(w.server.syncs(TASKS).length, before[1] + 1, "a local change is always sent");
  eq(w.titles().length, 3, "and the server's change came with the answer");
});

test("pass: bounded — a server that always has more is left after PIM_MAX_BATCHES requests, and the next pass goes on", async () => {
  const w = world();
  const total = PIM_WINDOW_SIZE * (PIM_MAX_BATCHES + 3);
  for (const i of range(total)) w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }));
  const r = await w.pass();
  eq(w.server.syncs(CAL).length, PIM_MAX_BATCHES);
  eq([r.moreAvailable, r.received], [true, PIM_WINDOW_SIZE * (PIM_MAX_BATCHES - 1)]);
  eq((await w.coll(CAL)).full, "initial", "the rebuild is not over: nothing is judged missing yet");
  const next = await w.pass();
  eq([next.moreAvailable, w.titles().length], [false, total]);
});

test("pass: cancelled in the middle — CANCELLED, the SyncKey is not saved, and the next pass has no duplicate", async () => {
  const w = world();
  for (const i of range(5)) w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }));
  await w.pass();
  w.server.addItem(CAL, event({ uid: "late", summary: "Tardif" }));
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Local" }));
  const key = (await w.coll(CAL)).syncKey;
  const ctrl = new AbortController();
  w.server.hook("Sync", () => {
    ctrl.abort();
    return undefined;
  });
  await rejects(() => w.pass({ signal: ctrl.signal }), (e) => e.code === ERR.CANCELLED);
  eq((await w.coll(CAL)).syncKey, key);
  const aborted = new AbortController();
  aborted.abort();
  const requests = w.server.requests.length;
  await rejects(() => w.pass({ signal: aborted.signal }), (e) => e.code === ERR.CANCELLED);
  eq(w.server.requests.length, requests, "an aborted pass asks nothing");
  await w.pass();
  eq(w.titles(), ["E0", "E1", "E2", "E3", "E4", "Local", "Tardif"]);
  eq(w.server.items.get(CAL).size, 7);
});

test("pass: every request carries the pass's signal; a fatal error stops the pass at once", async () => {
  const w = world();
  w.server.addItem(CAL, event());
  const ctrl = new AbortController();
  await w.pass({ signal: ctrl.signal });
  for (const r of w.server.requests) assert(r.opts.signal === ctrl.signal, `${r.cmd} without the signal`);
  w.server.hook("Sync", () => {
    throw new EasError(ERR.AUTH, "Mot de passe refusé.");
  });
  const before = w.server.requests.length;
  await rejects(() => w.pass(), (e) => e.code === ERR.AUTH);
  eq(w.server.requests.length - before, 1, "the other collection is not even asked");
});

test("pass: one collection that fails does not stop the others; its error comes out at the end", async () => {
  const w = world({ folders: WITH_TEAM });
  w.server.addItem(CAL, event());
  w.server.addItem("20", event({ uid: "team", summary: "Équipe" }));
  await w.pass();
  w.server.addItem("20", event({ uid: "team2", summary: "Équipe 2" }));
  w.server.hook("Sync", () => {
    throw new EasError(ERR.NETWORK, "Coupure.");
  });
  await rejects(() => w.pass(), (e) => e.code === ERR.NETWORK);
  eq(w.titles("20"), ["Équipe", "Équipe 2"], "the other calendar was synchronized");
});

test("pass: refuses to run without a known protocol version or a folder list", async () => {
  const w = world();
  await rejects(() => w.pim.pass({ client: w.server, version: null, folders: w.server.folders }), (e) => e.code === ERR.CONFIG);
  await rejects(() => w.pim.pass({ client: w.server, version: "16.1", folders: w.server.folders }), (e) => e.code === ERR.CONFIG);
  await rejects(() => w.pim.pass({ client: w.server, version: "14.1", folders: [] }), TypeError);
  eq(w.server.requests.length, 0);
  throws(() => new PimSync({ mailbox: { id: MB, email: "moi" }, records: w.records, calendarStore: w.store, scheduler: w.scheduler }), TypeError);
  throws(() => new PimSync({ mailbox: w.mailbox, records: w.records, calendarStore: null, scheduler: w.scheduler }), TypeError);
});

test("pass: the calendars of Thunderbird cannot be reached — a local error, nothing asked of the server", async () => {
  const w = world();
  w.api.failAll = new Error("UNSUPPORTED: agendas indisponibles — Jean Dupont <jean@example.org>");
  const e = await rejects(() => w.pass(), (x) => x.code === "LOCAL");
  assert(!/Dupont|jean/.test(e.message), "the reason of a privileged error is never passed on");
  eq(w.server.requests.length, 0);
});

test("pass: a damaged collection record starts the collection again instead of trusting it", async () => {
  const w = world();
  w.server.addItem(CAL, event());
  await w.pass();
  await w.records.set("pim:7", { v: 1, cls: "Calendar", slot: "main", syncKey: "clé avec espace", quarantine: "x", tries: [["a"]], window: { since: "hier" }, refetch: [7, null] });
  const r = await w.pass();
  eq([r.received, w.titles()], [1, ["Point hebdomadaire"]], "the item is already there: put again, not doubled");
  eq((await w.coll(CAL)).syncKey, "2");
});

test("pass: damaged records of held deletions, sequences and kept calendars are read as far as they are valid", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, event());
  await w.pass();
  await w.records.set("pimDeletes", [["7", { ids: [sid, "", 7, sid], at: "hier", retained: "oui", base: -3 }], ["", { ids: ["x"] }], ["9", "rien"], ["8", { ids: [] }]]);
  await w.records.set("pimSequences", [["7", [[sid, 3], [sid, -1], ["", 2], "x", [sid, 2.5]]], ["8", "rien"], [7, []]]);
  await w.records.set("pimKept", "n'importe quoi");
  eq(await w.pim.pendingDeletes(), 0, "a deletion is held only when the record says exactly so");
  const r = await w.pass();
  eq([r.pendingDeletes, w.titles()], [0, []], "the one valid deletion, below the threshold, is applied");
  eq(await w.records.get("pimDeletes", null), null);
  eq(await w.pim.discardPendingDeletes(), 0);
});

test("pass: a calendar Thunderbird cannot make does not stop the others; a second calendar for one slot is removed", async () => {
  const w = world({ folders: WITH_TEAM });
  w.server.addItem(CAL, event({ uid: "a", summary: "Perso" }));
  w.server.addItem("20", event({ uid: "team", summary: "Équipe" }));
  const ensure = w.api.ensureCalendar.bind(w.api);
  w.api.ensureCalendar = async (options) => {
    if (options.slot === "20") throw new Error("LIMIT: trop d'agendas (50 au plus)");
    return ensure(options);
  };
  const e = await rejects(() => w.pass(), (x) => x.code === "LOCAL");
  assert(e.message.includes("LIMIT") && !e.message.includes("Équipe"), e.message);
  eq(w.titles(), ["Perso"], "the mailbox's own calendar is synchronized all the same");
  w.api.ensureCalendar = ensure;
  // Two calendars of ours for the slot main (which the privileged module refuses to choose between).
  w.api.calendars.set(`sync443-${MB}-9`, { mailboxId: MB, slot: "main", name: "Doublon", events: true, tasks: true, organizerEmail: OWN, rows: [] });
  await w.pass();
  eq([...w.api.calendars.values()].map((c) => c.slot).sort(), ["20", "21", "main"]);
  eq([w.titles(), w.titles("20")], [["Perso"], ["Équipe"]]);
});

// ── Meetings organized by the user ────────────────────────────────────────

test("organize: a new meeting is synchronized first, then the user is asked, then one invitation leaves", async () => {
  const w = world();
  await w.pass();
  w.api.userAdd(w.cal(), meeting([A, B], { uid: "m1", summary: "Revue de budget" }));
  const from = w.server.requests.length;
  const r = await w.pass();
  eq(r.sent, 1);
  const order = w.server.requests.slice(from).map((x) => x.cmd);
  eq(order.at(-1), "SendMail");
  assert(order.indexOf("Sync") < order.indexOf("SendMail"), "the change reaches the server before any message");
  eq(w.asked, [{ kind: "invite", summary: "Revue de budget", start: "2026-12-01T09:00:00Z", allDay: false, recipients: [A, B], from: OWN }]);
  eq(w.mails().map((m) => [m.method, m.to]), [["REQUEST", [A, B]]]);
  const stored = [...w.server.items.get(CAL).values()][0];
  eq([stored.summary, stored.attendees.map((a) => a.email), stored.meeting.role], ["Revue de budget", [A, B], "organizer"]);
  assert(w.api.items(w.cal())[0].serverId !== null);
  await w.pass();
  eq([w.asked.length, w.server.mails.length], [1, 1], "asked once, sent once");
});

test("organize: Don't send — nothing is sent, and the event stays as saved, here and on the server", async () => {
  const w = world();
  await w.pass();
  w.send = false;
  w.api.userAdd(w.cal(), meeting([A, B], { uid: "m1", summary: "Revue de budget" }));
  await w.pass();
  eq([w.asked.length, w.server.sent("SendMail").length, w.notices.length], [1, 0, 0]);
  eq([w.titles(), w.serverTitles(CAL)], [["Revue de budget"], ["Revue de budget"]]);
  assert(w.api.items(w.cal())[0].serverId !== null, "synchronized all the same");
  w.send = true;
  await w.pass();
  eq([w.asked.length, w.server.sent("SendMail").length], [1, 0], "never asked again, never sent later");
});

test("organize: an update raises SEQUENCE, which survives the server's own changes to the meeting; a deletion cancels", async () => {
  const w = world();
  await w.pass();
  w.api.userAdd(w.cal(), meeting([A, B], { uid: "m1", summary: "Comité" }));
  await w.pass();
  const sid = w.server.adds[0].serverId;
  w.api.userModify(w.cal(), sid, { location: "Salle 9" });
  await w.pass();
  // An attendee answered: the server changes the item (ActiveSync carries no SEQUENCE).
  w.server.changeItem(CAL, sid, { attendees: [person(A, { status: "accepted" }), person(B)] });
  await w.pass();
  eq(w.api.items(w.cal())[0].item.attendees[0].status, "accepted");
  eq(w.api.items(w.cal())[0].item.sequence, 1, "the number sent is kept through the server's change");
  w.api.userModify(w.cal(), sid, { start: "2026-12-01T14:00:00Z", end: "2026-12-01T15:00:00Z" });
  await w.pass();
  w.api.userDelete(w.cal(), sid);
  await w.pass();
  eq(w.asked.map((q) => q.kind), ["invite", "update", "update", "cancel"]);
  const sequence = (m) => m.calendar.find((l) => l.startsWith("SEQUENCE:"));
  eq(w.mails().map((m) => [m.method, sequence(m)]), [["REQUEST", "SEQUENCE:0"], ["REQUEST", "SEQUENCE:1"], ["REQUEST", "SEQUENCE:2"], ["CANCEL", "SEQUENCE:3"]]);
  eq(w.commands(CAL), ["Add", "Change", "Change", "Delete"]);
  eq([w.server.items.get(CAL).size, w.titles()], [0, []]);
  eq(await w.records.get("pimSequences", null), null, "nothing is remembered of a deleted meeting");
  // A change that concerns nobody else: synchronized, no question, no message.
  const quiet = world();
  await quiet.pass();
  quiet.api.userAdd(quiet.cal(), meeting([A], { uid: "m2" }));
  await quiet.pass();
  quiet.api.userModify(quiet.cal(), quiet.server.adds[0].serverId, { reminder: 30, categories: ["Client"] });
  eq((await quiet.pass()).sent, 1);
  eq([quiet.asked.length, quiet.server.mails.length], [1, 1]);
});

test("organize: a removed attendee and one occurrence, through a whole pass", async () => {
  const w = world();
  await w.pass();
  const weekly = { freq: "weekly", interval: 1, count: 10, until: null, byDay: ["TU"], bySetPos: null, byMonthDay: null, byMonth: null, weekStart: null };
  w.api.userAdd(w.cal(), meeting([A, B], { uid: "m1", summary: "Hebdo", recurrence: weekly }));
  await w.pass();
  const sid = w.server.adds[0].serverId;
  w.api.userModify(w.cal(), sid, (item) => ({ ...item, attendees: [person(A)] }));
  await w.pass();
  eq(w.asked.slice(1).map((q) => [q.kind, q.recipients]), [["update", [A]], ["cancel", [B]]]);
  w.api.userModify(w.cal(), sid, (item) => ({ ...item, exceptions: [{ originalStart: "2026-12-08T09:00:00Z", deleted: true, changes: {} }] }));
  await w.pass();
  eq(w.asked.at(-1), { kind: "cancel", summary: "Hebdo", start: "2026-12-08T09:00:00Z", allDay: false, recipients: [A], from: OWN });
  const last = w.mails().at(-1);
  eq([last.method, last.to], ["CANCEL", [A]]);
  assert(last.calendar.includes("RECURRENCE-ID:20261208T090000Z"));
  eq(w.server.mails.length, 4);
});

test("organize: more than 100 attendees — nothing is sent, even to the server; a new meeting stays as a local copy, a change is undone", async () => {
  const w = world();
  await w.pass();
  const crowd = range(101).map((i) => `p${i}@example.org`);
  w.api.userAdd(w.cal(), meeting(crowd, { uid: "big", summary: "Assemblée" }));
  const r = await w.pass();
  eq([r.sent, w.commands(CAL), w.asked.length, w.server.sent("SendMail").length], [0, [], 0, 0]);
  eq(w.api.items(w.cal()).map((x) => [x.item.summary, x.serverId, x.detached]), [["Assemblée", null, true]], "never sent, never deleted");
  eq(w.named, [["keptLocalTooManyAttendees", "Assemblée", 100]], "the notice of a new meeting says why, with the limit");
  // 100 attendees pass.
  w.api.userAdd(w.cal(), meeting(crowd.slice(0, 100), { uid: "ok", summary: "Grande réunion" }));
  await w.pass();
  eq([w.asked[0].recipients.length, w.mails()[0].to.length], [100, 100]);
  // One more on a meeting the server has: the change is undone, and the user is told why.
  const sid = w.server.adds[0].serverId;
  w.api.userModify(w.cal(), sid, (item) => ({ ...item, attendees: crowd.map((e) => person(e)) }));
  await w.pass();
  eq([w.api.items(w.cal()).find((x) => x.serverId === sid).item.attendees.length, w.server.items.get(CAL).get(sid).attendees.length, w.asked.length], [100, 100, 1]);
  eq(w.named.at(-1), ["tooManyAttendees", "Grande réunion", 100]);
  assert(w.notices.at(-1).includes("Grande réunion") && w.notices.at(-1).includes("100"), w.notices.at(-1));
});

test("organize: a refused and an uncertain sending are told, the event stays, and nothing is sent again by a later pass", async () => {
  const w = world();
  await w.pass();
  w.server.sendStatus = "120";
  w.api.userAdd(w.cal(), meeting([A], { uid: "m1", summary: "Refusée" }));
  await w.pass();
  assert(w.notices[0].includes("Refusée") && w.notices[0].includes("Status 120"));
  w.server.sendStatus = null;
  w.server.loseNextResponse("SendMail");
  w.api.userAdd(w.cal(), meeting([B], { uid: "m2", summary: "Incertaine" }));
  const r = await w.pass();
  eq(r.sent, 1, "the pass itself succeeds: the event is synchronized");
  assert(w.notices[1].includes("Incertaine") && /peut-être/.test(w.notices[1]), w.notices[1]);
  eq(w.titles(), ["Incertaine", "Refusée"]);
  await w.pass();
  await w.pass();
  eq([w.server.sent("SendMail").length, w.asked.length, w.notices.length], [2, 2, 2]);
});

test("organize: with a lost Sync response, the meeting is created once and its invitation asked for once", async () => {
  const w = world();
  await w.pass();
  w.api.userAdd(w.cal(), meeting([A, B], { uid: "m1", summary: "Comité" }));
  w.server.loseNextResponse("Sync");
  await rejects(() => w.pass(), (e) => e.code === ERR.NETWORK);
  eq([w.asked.length, w.server.sent("SendMail").length], [0, 0], "nothing is asked before the server's answer is known");
  await w.pass();
  await w.pass();
  eq([w.asked.length, w.server.mails.length, w.server.items.get(CAL).size], [1, 1, 1]);
});

test("organize: with deliver false the pass sends nothing; the caller's deliver() does", async () => {
  const w = world();
  await w.pass();
  w.api.userAdd(w.cal(), meeting([A], { uid: "m1" }));
  await w.pass({ deliver: false });
  eq([w.asked.length, w.server.mails.length, await w.scheduler.pending()], [0, 0, 1]);
  eq(await w.scheduler.deliver({ client: w.server }), { sent: 1, declined: 0, failed: 0, uncertain: 0 });
});

// ── Invitations answered ──────────────────────────────────────────────────

test("answer: on the calendar item with 14.1 — MeetingResponse, no Change for the answer alone, one REPLY to the organizer", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, invitation());
  await w.pass();
  w.api.userModify(w.cal(), sid, answered("accepted"), ASKED);
  const from = w.server.requests.length;
  const r = await w.pass();
  eq(r.sent, 1);
  eq(w.server.meetings, [{ userResponse: 1, collectionId: CAL, requestId: sid, instanceId: null }]);
  eq(w.commands(CAL), [], "the answer is not a Change");
  const order = w.server.requests.slice(from).map((x) => x.cmd);
  eq([order[0], order.at(-1)], ["MeetingResponse", "SendMail"]);
  eq(w.asked, [], "no confirmation window for an answer");
  eq(w.mails().map((m) => [m.method, m.to]), [["REPLY", [CHEF]]]);
  eq(w.api.items(w.cal())[0].item.meeting.response, "accepted");
  eq((await w.store.readLocalChanges(w.cal())).changes, []);
  await w.pass();
  eq([w.server.meetings.length, w.server.mails.length], [1, 1]);
});

test("answer: with something else changed too, the rest goes as a Change after the answer", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, invitation());
  await w.pass();
  w.api.userModify(w.cal(), sid, (item) => ({ ...answered("tentative")(item), reminder: 15 }), ASKED);
  await w.pass();
  eq(w.server.meetings.map((m) => m.userResponse), [2]);
  eq(w.commands(CAL), ["Change"]);
  eq(w.server.items.get(CAL).get(sid).reminder, 15);
  eq(w.mails().length, 1);
  eq((await w.store.readLocalChanges(w.cal())).changes, []);
});

test("answer: on the invitation mail with 12.1 and 14.0; when no invitation can be named, the change is synchronized as any other and nothing is undone", async () => {
  for (const version of ["12.1", "14.0"]) {
    const w = world({ version });
    const sid = w.server.addItem(CAL, invitation());
    await w.pass();
    eq(w.api.items(w.cal())[0].item.meeting.response, "not-responded", "(12.1 has no ResponseType: what the server does not say is \"not answered\" on a new item)");
    // No invitation mail is known: nothing is sent to anyone, and the event stays as the user left it. The user
    // asked for a reply: the scheduler says that none went.
    w.api.userModify(w.cal(), sid, answered("accepted"), ASKED);
    eq((await w.pass()).sent, 1);
    eq([w.server.meetings.length, w.server.mails.length, w.notices.length, w.commands(CAL)], [0, 0, 1, ["Change"]], version);
    assert(/aucune réponse n'a été envoyée/.test(w.notices[0]) && w.notices[0].includes("Point hebdomadaire"), w.notices[0]);
    eq(w.api.items(w.cal())[0].item.meeting.response, "accepted", "nothing is undone");
    eq((await w.store.readLocalChanges(w.cal())).changes, []);
    await w.pass();
    eq(w.notices.length, 1, "told once");
    // The same without a reply asked for ("do not send a response"): synchronized as any change, in silence.
    const quiet = world({ version });
    const other = quiet.server.addItem(CAL, invitation());
    await quiet.pass();
    quiet.api.userModify(quiet.cal(), other, answered("tentative"));
    eq((await quiet.pass()).sent, 1);
    eq([quiet.server.meetings.length, quiet.server.mails.length, quiet.notices, quiet.commands(CAL)], [0, 0, [], ["Change"]], version);
    eq(quiet.api.items(quiet.cal())[0].item.meeting.response, "tentative");
    // The invitation is known: answered on the mail.
    await noteInvitation(w);
    w.server.meetingResults.set("1:42", { calendarId: sid });
    w.api.userModify(w.cal(), sid, answered("declined"), ASKED);
    await w.pass();
    eq(w.server.meetings, [{ userResponse: 3, collectionId: "1", requestId: "1:42", instanceId: null }]);
    eq(w.mails().map((m) => m.to), [[CHEF]]);
    eq(w.api.items(w.cal())[0].item.meeting.response, "declined");
  }
  // The user answered on an event the server holds, and this server takes answers on the mail only: mail must be synchronized.
  const noMail = world({ version: "14.0", sync: { mail: false, calendar: true, contacts: false, tasks: true } });
  const sid = noMail.server.addItem(CAL, invitation());
  await noMail.pass();
  await noteInvitation(noMail);
  noMail.api.userModify(noMail.cal(), sid, answered("accepted"), ASKED);
  await noMail.pass();
  eq([noMail.server.meetings.length, noMail.server.mails.length, noMail.notices.length], [0, 0, 1]);
  assert(/courrier/.test(noMail.notices[0]));
  eq(noMail.api.items(noMail.cal())[0].item.meeting.response, "not-responded");
});

test("answer: a status that came with the data is not an answer — an event added with attendees and no invitation known is a plain Add, never answered, never removed", async () => {
  for (const version of ["12.1", "14.0", "14.1"]) {
    const w = world({ version });
    await w.pass();
    // "Add to calendar" on a published event, or a file imported: the sender wrote "accepted" for the user.
    w.api.userAdd(w.cal(), invitation({ organizer: { email: "cible@example.net", name: "" } }, "accepted"));
    const r = await w.pass();
    eq([r.sent, w.server.meetings.length, w.server.mails.length, w.commands(CAL), w.notices], [1, 0, 0, ["Add"], []], version);
    eq(w.api.items(w.cal()).map((x) => [x.item.uid, x.serverId !== null]), [["invite-1", true]], "synchronized like any event, and still there");
    await w.pass();
    eq([w.server.meetings.length, w.server.mails.length, w.titles().length], [0, 0, 1]);
  }
});

test("answer: without Thunderbird having asked to send a reply, the server is told and nobody else — \"do not send a response\" is respected", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, invitation());
  await w.pass();
  w.api.userModify(w.cal(), sid, answered("accepted")); // Accept ▸ Do not send a response
  await w.pass();
  eq([w.server.meetings.map((m) => m.userResponse), w.server.mails.length, await w.scheduler.pending()], [[1], 0, 0]);
  eq(w.api.items(w.cal())[0].item.meeting.response, "accepted");
});

test("answer: an event added from the invitation bar is bound to the calendar item the server names — no Add, no duplicate", async () => {
  const w = world({ version: "12.1" });
  await w.pass();
  await noteInvitation(w);
  w.server.meetingResults.set("1:42", { calendarId: "7:500" });
  // The server makes the calendar item when it takes the answer.
  w.server.hook("MeetingResponse", () => {
    w.server.addItem(CAL, invitation({}, "accepted"), "7:500");
    return undefined;
  });
  w.api.userAdd(w.cal(), invitation({}, "accepted"), ASKED);
  const r = await w.pass();
  eq(r.sent, 1);
  eq(w.server.meetings, [{ userResponse: 1, collectionId: "1", requestId: "1:42", instanceId: null }]);
  eq(w.commands(CAL), [], "the event is not sent as a new item");
  eq(w.api.items(w.cal()).map((x) => [x.serverId, x.collectionId, x.item.uid]), [["7:500", CAL, "invite-1"]]);
  eq(w.server.items.get(CAL).size, 1);
  eq(w.mails().map((m) => [m.method, m.to]), [["REPLY", [CHEF]]]);
  await w.pass();
  eq(w.api.items(w.cal()).length, 1);
});

test("answer: an invitation declined from the bar is not sent as an item and stays as a local copy; one the server names no item for is sent as a new item, not lost", async () => {
  const declined = world({ version: "14.0" });
  await declined.pass();
  await noteInvitation(declined);
  declined.api.userAdd(declined.cal(), invitation({}, "declined"), ASKED);
  await declined.pass();
  eq([declined.server.meetings.map((m) => m.userResponse), declined.commands(CAL)], [[3], []]);
  eq(declined.api.items(declined.cal()).map((x) => [x.item.uid, x.serverId, x.detached]), [["invite-1", null, true]], "never deleted by the engine");
  eq(declined.mails().map((m) => m.to), [[CHEF]]);
  eq(declined.notices, []);
  await declined.pass();
  eq([declined.server.meetings.length, declined.commands(CAL)], [1, []], "and nothing more is said of it");
  const unnamed = world({ version: "14.0" });
  await unnamed.pass();
  await noteInvitation(unnamed);
  unnamed.api.userAdd(unnamed.cal(), invitation({}, "accepted"), ASKED);
  await unnamed.pass();
  eq([unnamed.server.meetings.length, unnamed.commands(CAL), unnamed.titles().length], [1, ["Add"], 1]);
  assert(unnamed.api.items(unnamed.cal())[0].serverId !== null);
});

test("answer: a refusal of the server undoes the answer and sends no reply; a lost connection leaves it to the next pass", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, invitation());
  await w.pass();
  w.server.meetingResults.set(sid, { status: "3" });
  w.api.userModify(w.cal(), sid, answered("accepted"), ASKED);
  await w.pass();
  eq([w.server.mails.length, w.notices.length, w.api.items(w.cal())[0].item.meeting.response], [0, 1, "not-responded"]);
  w.server.meetingResults.delete(sid);
  w.api.userModify(w.cal(), sid, answered("accepted"), ASKED);
  w.server.hook("MeetingResponse", () => {
    throw new EasError(ERR.NETWORK, "Coupure.");
  });
  await rejects(() => w.pass(), (e) => e.code === ERR.NETWORK);
  eq(w.api.items(w.cal())[0].item.meeting.response, "accepted", "the answer waits");
  await w.pass();
  eq([w.server.meetings.map((m) => m.userResponse), w.mails().map((m) => m.to)], [[1, 1], [[CHEF]]], "the refused one, then the one that passed");
});

test("answer: never given twice — the calendar fails to record it, or the rest of the change has to wait: one MeetingResponse, one reply", async () => {
  // The answer is taken by the server, then Thunderbird refuses the acknowledgement.
  const w = world();
  const sid = w.server.addItem(CAL, invitation());
  await w.pass();
  w.api.userModify(w.cal(), sid, answered("accepted"), ASKED);
  const ack = w.api.ackLocalChange.bind(w.api);
  w.api.ackLocalChange = async () => {
    throw new Error("INTERNAL: Thunderbird a refusé");
  };
  await rejects(() => w.pass(), (e) => e.code === "LOCAL");
  eq([w.server.meetings.length, w.server.mails.length], [1, 1], "the server took the answer, and the organizer has the reply");
  w.api.ackLocalChange = ack;
  w.restart();
  eq((await w.pass()).sent, 0);
  eq([w.server.meetings.length, w.server.mails.length], [1, 1], "not answered again, no second reply");
  eq((await w.store.readLocalChanges(w.cal())).changes, [], "and the change is settled now");
  eq((await w.coll(CAL)).answered, []);
  // The answer is taken, and the Change that carries the rest of the change gets a transient status.
  const t = world();
  const other = t.server.addItem(CAL, invitation());
  await t.pass();
  t.server.changeStatus.set(other, "5");
  t.api.userModify(t.cal(), other, (item) => ({ ...answered("accepted")(item), reminder: 15 }), ASKED);
  await t.pass();
  eq((await t.coll(CAL)).answered.map((a) => a.slice(1)), [["accepted", other]]);
  t.server.changeStatus.delete(other);
  await t.pass();
  eq([t.server.meetings.length, t.server.mails.length, t.commands(CAL)], [1, 1, ["Change", "Change"]]);
  eq([t.server.items.get(CAL).get(other).reminder, (await t.coll(CAL)).answered], [15, []]);
  // Answered again later: a new answer, a new reply.
  t.api.userModify(t.cal(), other, answered("declined"), ASKED);
  await t.pass();
  eq([t.server.meetings.map((m) => m.userResponse), t.mails().map((m) => m.calendar.find((l) => l.startsWith("ATTENDEE")).includes("DECLINED"))], [[1, 3], [false, true]]);
});

test("answer: deleting an invitation's event deletes it on the server and sends nothing", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, invitation({}, "accepted"));
  await w.pass();
  w.api.userDelete(w.cal(), sid);
  await w.pass();
  eq([w.commands(CAL), w.server.meetings.length, w.server.mails.length, w.asked.length], [["Delete"], 0, 0, 0]);
});

// ── Nothing is ever sent for what comes from the server ───────────────────

test("server changes never send anything: meetings organized by the user with 100 attendees, added, changed, deleted", async () => {
  const w = world();
  const crowd = range(100).map((i) => `victime${i}@example.net`);
  const mine = (i, over = {}) => meeting(crowd, { uid: `piege-${i}`, summary: `Piège ${i}`, ...over });
  const sids = range(30).map((i) => w.server.addItem(CAL, mine(i)));
  // Invitations "already answered", from an organizer of the server's choice, asking for a reply.
  const answeredOnes = range(10).map((i) => w.server.addItem(CAL, invitation({ uid: `faux-${i}`, organizer: { email: `cible${i}@example.net`, name: "" } }, "accepted")));
  await w.pass();
  eq(w.titles().length, 40);
  // Everything a meeting message is made of changes: time, place, attendees, cancellation, answers.
  for (const [i, sid] of sids.entries()) {
    w.server.changeItem(CAL, sid, mine(i, { location: "Ailleurs", start: "2026-12-02T09:00:00Z", end: "2026-12-02T10:00:00Z", attendees: crowd.slice(0, 50).map((e) => person(e)) }));
  }
  for (const sid of answeredOnes) w.server.changeItem(CAL, sid, { meeting: { role: "attendee", cancelled: false, responseRequested: true, response: "declined", allowNewTime: true } });
  await w.pass();
  for (const [i, sid] of sids.slice(0, 10).entries()) w.server.changeItem(CAL, sid, mine(i, { meeting: { role: "organizer", cancelled: true, responseRequested: true, response: "none", allowNewTime: true } }));
  await w.pass();
  for (const sid of sids.slice(0, 15)) w.server.deleteItem(CAL, sid);
  for (const sid of sids.slice(15, 20)) w.server.softDelete(CAL, sid);
  await w.pass();
  w.server.invalidate(CAL);
  await w.pass();
  await w.pass({ confirmDeletes: true });
  w.restart();
  await w.pass();
  eq(w.server.sent("SendMail").length, 0, "zero SendMail");
  eq(w.server.sent("MeetingResponse").length, 0, "zero MeetingResponse");
  eq(w.asked.length, 0, "the user is never asked");
  eq(await w.scheduler.pending(), 0);
  eq(await w.records.get("meetingOutbox", null), null);
  eq(w.api.calls.filter((c) => c[0] === "ackLocalChange" || c[0] === "dropLocalChange").length, 0, "no change of the user's was ever involved");
  eq(new Set(w.server.requests.map((r) => r.cmd)), new Set(["Sync"]));
  eq(w.notices, []);
});

test("server changes never send anything: a put that rewrites what the user's change is compared with cannot fake an answer", async () => {
  const w = world();
  // The server says the user accepted a meeting of an organizer of its choice.
  const sid = w.server.addItem(CAL, invitation({ uid: "piege", organizer: { email: "cible@example.net", name: "" } }, "accepted"));
  await w.pass();
  // During the next pass the user sets a reminder — nothing more — just before the server's
  // rewritten item (now "not answered") arrives.
  w.server.changeItem(CAL, sid, { meeting: { role: "attendee", cancelled: false, responseRequested: true, response: "not-responded", allowNewTime: true } });
  w.server.hook("Sync", () => {
    w.api.userModify(w.cal(), sid, { reminder: 10 });
    return undefined;
  });
  await w.pass();
  await w.pass();
  eq(w.server.sent("MeetingResponse").length, 0, "the difference was made by the server, not by the user");
  eq(w.server.sent("SendMail").length, 0, "and no reply goes to the address it chose");
  eq(await w.scheduler.pending(), 0);
  eq(w.commands(CAL), [], "nothing of a change the server rewrote under it is sent at all");
  eq(w.notices.length, 1, "the user is told, and may answer again");
  assert(/modifié sur le serveur/.test(w.notices[0]), w.notices[0]);
  eq([w.api.items(w.cal())[0].item.meeting.response, w.api.items(w.cal())[0].item.reminder], ["not-responded", null], "the server's version is shown");
  eq((await w.store.readLocalChanges(w.cal())).changes, []);
  // The user's own answer, made once the calendar is at rest, goes.
  w.api.userModify(w.cal(), sid, answered("accepted"), ASKED);
  await w.pass();
  eq([w.server.meetings.length, w.mails().map((m) => m.to)], [1, [["cible@example.net"]]]);
});

test("server changes never send anything: an invitation the server puts in the calendar, then answered by the user in a later pass, is answered normally", async () => {
  const w = world();
  const sid = w.server.addItem(CAL, invitation());
  await w.pass();
  w.server.changeItem(CAL, sid, { location: "Salle 4" });
  await w.pass(); // the server's change is applied while nothing waits: nothing is marked
  w.api.userModify(w.cal(), sid, answered("declined"), ASKED);
  await w.pass();
  eq(w.server.meetings.map((m) => m.userResponse), [3]);
});

// ── The threshold covers every removal the server causes ──────────────────

/** A mailbox whose default calendar (and each folder of `extra`) holds `n` events, synchronized. */
async function filled(n, extra = [], options = {}) {
  const w = world({ folders: [...PIM_FOLDERS, ...extra], sync: CAL_ONLY, ...options });
  for (const i of range(n)) w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }), `7:${i + 1}`);
  for (const f of extra) for (const i of range(n)) w.server.addItem(f.id, event({ uid: `x${i}`, summary: `X${i}` }), `${f.id}:${i + 1}`);
  await settle(w);
  eq(w.titles().length, n);
  return w;
}

test("threshold: a default calendar that becomes an ordinary folder, a folder that changes its kind, a new default folder — each removal is held", async () => {
  // The default calendar becomes an ordinary folder (type 8 → 13): its events would leave the mailbox's calendar.
  const a = await filled(120);
  a.server.folders.set(CAL, { parentId: "0", name: "Calendrier", type: 13 });
  a.server.items.set(CAL, new Map());
  a.server.invalidate(CAL);
  let r = await settle(a);
  eq([r.pendingDeletes, a.titles().length], [120, 120], "8 → 13: held, nothing removed");
  eq(await a.pim.discardPendingDeletes(), 120);
  r = await settle(a);
  eq([r.pendingDeletes, a.titles().length, a.api.items(a.cal()).every((x) => x.detached)], [0, 120, true], "kept: local copies");

  // A calendar folder becomes a task folder (13 → 15): its calendar would be removed and made again.
  const b = await filled(120, [{ id: "20", parentId: "0", name: "Équipe", type: 13 }]);
  const team = b.cal("20");
  b.server.folders.set("20", { parentId: "0", name: "Équipe", type: 15 });
  b.server.items.set("20", new Map());
  b.server.colls.delete("20");
  b.mailbox.sync.tasks = true;
  b.server.addItem("20", task({ uid: "t", summary: "Tâche d'équipe" }));
  r = await settle(b);
  eq([r.pendingDeletes, b.api.summaries(team).length], [120, 120], "13 → 15: held, the calendar and its events stay");
  assert([...b.api.calendars.values()].some((c) => c.tasks && c.rows.some((x) => x.item.summary === "Tâche d'équipe")), "the task folder it is now has a calendar of its own meanwhile");
  r = await settle(b, { confirmDeletes: true });
  eq([r.pendingDeletes, b.api.calendars.has(team), b.titles().length], [0, false, 120], "confirmed: that calendar goes, the others are untouched");

  // A new default folder whose ServerId sorts first: the old default one is no longer "main".
  const c = await filled(120);
  c.server.addFolder("2", "0", "Autre", 8);
  c.server.addItem("2", event({ uid: "other", summary: "De l'autre dossier" }));
  c.server.items.set(CAL, new Map());
  c.server.invalidate(CAL);
  r = await settle(c);
  eq([r.pendingDeletes, c.titles().filter((x) => /^E/.test(x)).length], [120, 120], "a second default folder: held");
  r = await settle(c, { confirmDeletes: true });
  eq([r.pendingDeletes, c.titles()], [0, ["De l'autre dossier"]]);
});

test("threshold: after a change of period, only what this side can see left the period leaves without counting", async () => {
  // The user widens the period, and the server sends nothing back.
  const wide = await filled(120);
  wide.mailbox.calendarPeriod = "0";
  wide.server.inPeriod = () => false;
  let r = await settle(wide);
  eq([r.pendingDeletes, wide.titles().length], [120, 120], "nothing can have left a period that grew: held");
  eq((await settle(wide, { confirmDeletes: true })).pendingDeletes, 0);
  eq(wide.titles(), []);

  // The user narrows it, and the server sends nothing back at all.
  const weekly = { freq: "weekly", interval: 1, count: null, until: null, byDay: ["TU"], bySetPos: null, byMonthDay: null, byMonth: null, weekStart: null };
  const narrow = world({ sync: CAL_ONLY, calendarPeriod: "0" });
  for (const i of range(70)) narrow.server.addItem(CAL, event({ uid: `old${i}`, summary: `Ancien ${i}`, start: "2020-01-01T09:00:00Z", end: "2020-01-01T10:00:00Z" }));
  for (const i of range(60)) narrow.server.addItem(CAL, event({ uid: `next${i}`, summary: `À venir ${i}`, start: "2027-03-01T09:00:00Z", end: "2027-03-01T10:00:00Z" }));
  narrow.server.addItem(CAL, event({ uid: "series", summary: "Série ancienne", start: "2019-01-01T09:00:00Z", end: "2019-01-01T10:00:00Z", recurrence: weekly }));
  narrow.server.addItem(CAL, event({ uid: "day", summary: "Journée ancienne", allDay: true, start: "2020-02-03", end: "2020-02-04" }));
  await settle(narrow);
  eq(narrow.titles().length, 132);
  narrow.mailbox.calendarPeriod = "4";
  narrow.server.inPeriod = () => false;
  r = await settle(narrow);
  eq([r.pendingDeletes, narrow.titles().length], [61, 61], "the 71 that ended long ago leave; events to come and a series that goes on are deletions, held");
  assert(narrow.titles().includes("Série ancienne") && !narrow.titles().includes("Journée ancienne"));

  // Tasks: "incomplete only". Completed tasks leave; incomplete ones the server does not send again are deletions.
  const tasks = world({ sync: { mail: true, calendar: false, contacts: false, tasks: true } });
  for (const i of range(60)) tasks.server.addItem(TASKS, task({ uid: `done${i}`, summary: `Faite ${i}`, completed: true, completedAt: "2026-11-01T08:00:00Z" }));
  for (const i of range(55)) tasks.server.addItem(TASKS, task({ uid: `todo${i}`, summary: `À faire ${i}` }));
  await settle(tasks);
  tasks.mailbox.taskFilter = "8";
  tasks.server.inPeriod = () => false;
  r = await settle(tasks);
  eq([r.pendingDeletes, tasks.titles().length], [55, 55]);
  assert(tasks.titles().every((x) => x.startsWith("À faire")));
});

test("threshold: the share is taken of what the collection held when its 24-hour window opened — items added first make no room for deletions", async () => {
  const w = await filled(100);
  for (const i of range(450)) w.server.addItem(CAL, event({ uid: `j${i}`, summary: "Remplissage" }), `7:j${i}`);
  await settle(w);
  eq(w.titles().length, 550);
  for (const i of range(100)) w.server.deleteItem(CAL, `7:${i + 1}`); // 100 of 550 would be 18 %; of the 100 there were, all
  const r = await settle(w);
  eq([r.pendingDeletes, w.titles().filter((x) => x !== "Remplissage").length], [100, 100], "held");
  // Days later the window is over: a new one opens before the server is heard, with what is held then. Filling
  // and deleting in one run makes no more room.
  const late = await filled(100);
  late.clock.now += 3 * 24 * 3600_000;
  for (const i of range(450)) late.server.addItem(CAL, event({ uid: `j${i}`, summary: "Remplissage" }), `7:j${i}`);
  for (const i of range(100)) late.server.deleteItem(CAL, `7:${i + 1}`);
  eq([(await settle(late)).pendingDeletes, late.titles().length], [100, 550]);
  // Waiting for the next window does not help: the share is taken of the fewest items held when a window opened
  // in the last seven days. Only what has been there for a week is part of what the collection holds.
  for (const [days, held] of [[1.05, 100], [3, 100], [6.5, 100], [8, 0]]) {
    const slow = await filled(100);
    for (const i of range(450)) slow.server.addItem(CAL, event({ uid: `j${i}`, summary: "Remplissage" }), `7:j${i}`);
    await settle(slow);
    for (let day = 1; day < days; day++) {
      slow.clock.now += 24 * 3600_000;
      await slow.pass(); // (a pass a day: a window opens each time, on the padded size)
    }
    slow.clock.now += (days % 1 || 1) * 24 * 3600_000;
    for (const i of range(100)) slow.server.deleteItem(CAL, `7:${i + 1}`);
    eq([(await settle(slow)).pendingDeletes, slow.titles().length], [held, held ? 550 : 450], `${days} day(s) after the padding`);
    assert((await slow.coll(CAL)).sizes.length <= 8, "a short history");
  }
  // Deletions of items that are not held count for nothing.
  const ghosts = await filled(60);
  for (const i of range(200)) ghosts.server.deleteItem(CAL, `7:fantome${i}`);
  eq([(await settle(ghosts)).pendingDeletes, ghosts.titles().length, await ghosts.records.get("pimDeletes", null)], [0, 60, null]);
});

test("threshold: a SoftDelete of an item this side can see is out of the period leaves without counting — an honest server after an absence holds nothing", async () => {
  // Two weeks back; the user was away: 120 events that ended more than two weeks ago are said to have left.
  const w = world({ sync: CAL_ONLY, calendarPeriod: "4" });
  const old = range(120).map((i) => w.server.addItem(CAL, event({ uid: `o${i}`, summary: `Passé ${i}`, start: "2026-10-20T09:00:00Z", end: "2026-10-20T10:00:00Z" })));
  const next = range(120).map((i) => w.server.addItem(CAL, event({ uid: `n${i}`, summary: `À venir ${i}` })));
  await settle(w);
  for (const sid of old) w.server.softDelete(CAL, sid);
  let r = await settle(w);
  eq([r.pendingDeletes, r.received, w.titles().length, (await w.coll(CAL)).window.count], [0, 120, 120, 0], "they left by themselves: removed, not counted");
  // A server that says the same of events to come is not believed: those count, and are held.
  for (const sid of next) w.server.softDelete(CAL, sid);
  r = await settle(w);
  eq([r.pendingDeletes, w.titles().length], [120, 120]);
  // Tasks: a completed one under "incomplete only" leaves; an incomplete one counts.
  const t = world({ sync: { mail: true, calendar: false, contacts: false, tasks: true }, taskFilter: "8" });
  const done = range(60).map((i) => t.server.addItem(TASKS, task({ uid: `d${i}`, summary: `Faite ${i}`, completed: true, completedAt: "2026-11-01T08:00:00Z" })));
  const todo = range(60).map((i) => t.server.addItem(TASKS, task({ uid: `t${i}`, summary: `À faire ${i}` })));
  await settle(t);
  for (const sid of done) t.server.softDelete(TASKS, sid);
  eq([(await settle(t)).pendingDeletes, t.titles().length], [0, 60]);
  for (const sid of todo) t.server.softDelete(TASKS, sid);
  eq([(await settle(t)).pendingDeletes, t.titles().length], [60, 60]);
});

test("threshold: a calendar of ours that no collection uses is judged by what it holds; the mailbox's own calendar is never removed for the server", async () => {
  const w = world({ sync: CAL_ONLY });
  w.server.addItem(CAL, event());
  await w.pass();
  const big = (await w.store.ensureCalendar({ slot: "55", name: "Sans dossier", events: true, tasks: false })).calendarId;
  await w.store.applyServerChanges(big, range(60).map((i) => ({ op: "put", collectionId: "55", serverId: `55:${i}`, item: event({ uid: `b${i}`, summary: `B${i}` }) })));
  const small = (await w.store.ensureCalendar({ slot: "56", name: "Petit", events: true, tasks: false })).calendarId;
  await w.store.applyServerChanges(small, [{ op: "put", collectionId: "56", serverId: "56:1", item: event({ uid: "s", summary: "S" }) }]);
  const r = await w.pass();
  eq([r.pendingDeletes, w.api.calendars.has(big), w.api.calendars.has(small)], [60, true, false]);
  eq(await w.pim.discardPendingDeletes(), 60);
  await w.pass();
  eq([w.api.summaries(big).length, await w.pim.pendingDeletes()], [60, 0], "kept as a local calendar");
  // No default folder any more on the server: the main calendar stays, with what the user holds in it.
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Jamais envoyé" }));
  w.server.removeFolder(CAL);
  await w.pass();
  await w.pass();
  assert(w.cal() !== null && w.titles().includes("Jamais envoyé"), "the only copy of an item never sent is not destroyed with its calendar");
});

// ── Changes of the user that nothing can receive ──────────────────────────

/** 60 events and a task; the user makes a new event and edits one; then the Calendar folder is gone from the list. */
async function calendarGone() {
  const w = world();
  for (const i of range(60)) w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }), `7:${i + 1}`);
  w.server.addItem(TASKS, task({ uid: "t1", summary: "Tâche" }));
  await settle(w);
  w.api.userAdd(w.cal(), event({ uid: "mine", summary: "Mon nouvel événement" }));
  w.api.userModify(w.cal(), "7:1", { location: "Lieu modifié" });
  w.server.removeFolder(CAL);
  return w;
}

test("held folder: while its removal waits for the user, so do the changes nothing can receive — nothing is undone before the user decides", async () => {
  const w = await calendarGone();
  const r = await w.pass();
  eq(r.pendingDeletes, 60);
  await w.pass();
  await w.pass();
  eq(w.api.calls.filter((c) => c[0] === "dropLocalChange").length, 0, "no change is dropped");
  assert(w.titles().includes("Mon nouvel événement"));
  eq(w.api.items(w.cal()).find((x) => x.serverId === "7:1").item.location, "Lieu modifié");
  eq(w.notices, []);
  eq((await w.store.readLocalChanges(w.cal())).changes.length, 2, "both still wait");
  // The user keeps the local copies: the new event is one of them.
  eq(await w.pim.discardPendingDeletes(), 60);
  await w.pass();
  const rows = w.api.items(w.cal()).filter((x) => x.item.kind === "event");
  eq([rows.length, rows.every((x) => x.detached && x.serverId === null)], [61, true]);
  eq(rows.find((x) => x.item.uid === "e0").item.location, "Lieu modifié", "the copy keeps what the user wrote");
  eq(w.notices.length, 1, "one notice");
  assert(/^Une modification faite dans Thunderbird n'a pas été envoyée/.test(w.notices[0]), w.notices[0]);
  await w.pass();
  eq(w.notices.length, 1, "told once");
});

test("held folder: once the removal is confirmed, the changes it leaves without a folder are dropped with one notice for all; a new item stays as a local copy", async () => {
  const w = await calendarGone();
  w.api.userAdd(w.cal(), event({ uid: "mine2", summary: "Un autre" }));
  eq((await w.pass()).pendingDeletes, 60);
  const r = await w.pass({ confirmDeletes: true });
  eq(r.pendingDeletes, 0);
  eq(w.api.items(w.cal()).map((x) => [x.item.summary, x.detached]).sort(), [["Mon nouvel événement", true], ["Tâche", false], ["Un autre", true]]);
  eq(w.notices.length, 1, "one notice for the pass, not one per change");
  assert(/^3 modifications faites dans Thunderbird/.test(w.notices[0]), w.notices[0]);
  await w.pass();
  eq(w.notices.length, 1);
  eq((await w.store.readLocalChanges(w.cal())).changes, []);
});

test("folder gone: a few items leave with it, but not what the user made there and never sent — its calendar stays, local, and the user is told", async () => {
  const w = world({ folders: WITH_TEAM });
  for (const i of range(3)) w.server.addItem("20", event({ uid: `t${i}`, summary: `Équipe ${i}` }));
  w.server.addItem("21", task({ uid: "milk", summary: "Lait" }));
  await w.pass();
  const [team, shopping] = [w.cal("20"), w.cal("21")];
  w.api.userAdd(team, event({ uid: "l", summary: "Jamais envoyé" }));
  w.api.userModify(team, (x) => x.item.uid === "t0", { location: "Ailleurs" });
  w.server.removeFolder("20");
  w.server.removeFolder("21");
  const r = await w.pass();
  eq([r.pendingDeletes, w.api.calendars.has(shopping)], [0, false], "three items: under the threshold; a calendar nothing waits in goes with its folder");
  eq(w.api.items(team).map((x) => [x.item.summary, x.serverId]), [["Jamais envoyé", null]], "the server's items left; the only copy of the new one did not");
  eq(w.notices.length, 1);
  assert(/^2 modifications faites dans Thunderbird/.test(w.notices[0]), w.notices[0]);
  await w.pass();
  await w.pass();
  eq([w.api.summaries(team), w.notices.length, await w.coll("20")], [["Jamais envoyé"], 1, null], "no later pass removes it, or tells again");
  // A folder that comes back under that ServerId gets a calendar of its own: nothing of the kept one is sent there.
  w.server.addFolder("20", "0", "Autre", 13);
  w.server.addItem("20", event({ uid: "o", summary: "De l'autre" }));
  await w.pass();
  eq([w.api.summaries(team), w.api.calendars.size, w.server.adds], [["Jamais envoyé"], 3, []]);
});

test("orphans: an item whose collection is neither stored nor wanted is not reverted in silence when the user edits it — it stays as a local copy", async () => {
  const w = world({ sync: CAL_ONLY });
  for (const i of range(3)) w.server.addItem(CAL, event({ uid: `old${i}`, summary: `Ancien ${i}` }));
  await w.pass();
  // The records are gone and the calendars are not (a mailbox pointed at another server, before its calendars
  // were removed with it); the default calendar has another ServerId there.
  await w.records.clear();
  const next = new FakePimServer({ folders: [{ id: "1", parentId: "0", name: "Boîte de réception", type: 2 }, { id: "12", parentId: "0", name: "Calendrier", type: 8 }] });
  for (const i of range(2)) next.addItem("12", event({ uid: `new${i}`, summary: `Nouveau ${i}` }));
  w.restart();
  const pass = () => w.pim.pass({ client: next, version: "14.1", folders: next.folders });
  await pass();
  eq(w.titles().length, 5);
  w.api.userModify(w.cal(), (x) => x.item.summary === "Ancien 0", { location: "Ailleurs" });
  await pass();
  const old = w.api.items(w.cal()).filter((x) => x.item.summary.startsWith("Ancien"));
  eq(old.map((x) => [x.detached, x.serverId]), [[true, null], [true, null], [true, null]], "all the items of that unknown collection are local copies now");
  eq(old.find((x) => x.item.summary === "Ancien 0").item.location, "Ailleurs", "the user's edit is not reverted");
  eq(w.notices.length, 1);
  eq(next.items.get("12").size, 2, "nothing of it reaches the other server by itself");
  await pass();
  eq(w.notices.length, 1);
});

// ── The server wins ───────────────────────────────────────────────────────

test("server wins: a change whose item the server rewrote while it waited is dropped before anything is planned or sent, and the user is told", async () => {
  // Another device moves the meeting; the request that brings it is on its way when the user adds a category here.
  const w = world({ sync: CAL_ONLY });
  const sid = w.server.addItem(CAL, event({ uid: "e1", summary: "Point", location: "Salle 2" }));
  await w.pass();
  w.server.changeItem(CAL, sid, { start: "2026-12-02T14:00:00Z", end: "2026-12-02T15:00:00Z", location: "Salle 9" });
  w.server.hook("Sync", () => {
    w.api.userModify(w.cal(), sid, { categories: ["Important"] });
    return undefined;
  });
  await settle(w);
  const onServer = w.server.items.get(CAL).get(sid);
  eq([onServer.start, onServer.location, onServer.categories], ["2026-12-02T14:00:00Z", "Salle 9", []], "the other device's change is not overwritten");
  const local = w.api.items(w.cal())[0].item;
  eq([local.start, local.location, local.categories], ["2026-12-02T14:00:00Z", "Salle 9", []], "the server's version is shown");
  eq([w.commands(CAL), w.notices.length], [[], 1]);
  assert(/modifié sur le serveur/.test(w.notices[0]) && w.notices[0].includes("Point"), w.notices[0]);
  eq([(await w.store.readLocalChanges(w.cal())).changes, "tainted" in (await w.coll(CAL))], [[], false]);
  // A deletion made meanwhile: the item comes back as the server has it.
  w.server.changeItem(CAL, sid, { summary: "Point, reporté" });
  w.server.hook("Sync", () => {
    w.api.userDelete(w.cal(), sid);
    return undefined;
  });
  await settle(w);
  eq([w.titles(), w.server.items.get(CAL).has(sid), w.commands(CAL), w.notices.length], [["Point, reporté"], true, [], 2]);
});

test("server wins: the mark is the calendar's own — a pass that stops before it saved anything changes nothing to it, and no message ever leaves", async () => {
  // The server says the user accepted a meeting of an organizer of its choice, then rewrites it to "not answered"
  // while a reminder set by the user waits; the pass stops right after the calendar was written.
  const w = world({ sync: CAL_ONLY });
  const sid = w.server.addItem(CAL, invitation({ uid: "piege", organizer: { email: "cible@example.net", name: "" } }, "accepted"));
  await w.pass();
  w.server.changeItem(CAL, sid, { meeting: { role: "attendee", cancelled: false, responseRequested: true, response: "not-responded", allowNewTime: true } });
  w.server.hook("Sync", () => {
    w.api.userModify(w.cal(), sid, { reminder: 10 }, ASKED);
    return undefined;
  });
  const apply = w.api.applyServerChanges.bind(w.api);
  w.api.applyServerChanges = async (...args) => {
    const results = await apply(...args);
    w.area.failNext = 1; // the very next write to the storage fails
    return results;
  };
  await rejects(() => w.pass(), (e) => e.code === "LOCAL");
  w.api.applyServerChanges = apply;
  w.restart();
  await settle(w);
  eq([w.server.sent("MeetingResponse").length, w.server.sent("SendMail").length, await w.scheduler.pending(), w.asked.length], [0, 0, 0, 0]);
  eq([w.commands(CAL), w.api.items(w.cal())[0].item.reminder, w.notices.length], [[], null, 1]);
});

test("server wins: attendees the server added while a change of the user waited are never asked about", async () => {
  const w = world({ sync: CAL_ONLY });
  await w.pass();
  w.api.userAdd(w.cal(), meeting([A, B], { uid: "m1", summary: "Comité" }));
  await w.pass();
  const sid = w.server.adds[0].serverId;
  eq(w.asked.length, 1);
  const strangers = range(40).map((i) => `inconnu${i}@example.net`);
  w.server.changeItem(CAL, sid, { attendees: [A, ...strangers].map((e) => person(e)) }); // B is gone, 40 strangers are in
  w.server.hook("Sync", () => {
    w.api.userModify(w.cal(), sid, { reminder: 10 });
    return undefined;
  });
  await settle(w);
  eq([w.asked.length, w.server.mails.length, await w.scheduler.pending()], [1, 1, 0], "no update to people the server chose, no cancellation to the one it removed");
  eq([w.notices.length, w.api.items(w.cal())[0].item.attendees.length], [1, 41]);
});

// ── A ServerId is not trusted across a rebuild ────────────────────────────

const rowsOf = (w, slot = "main") => w.api.items(w.cal(slot)).map((x) => [x.serverId, x.item.summary, x.item.location ?? null, x.detached]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || a[1].localeCompare(b[1]));

/** Two events; then the server loses its state and numbers them again: B is 7:1 now, A is 7:2. */
async function renumbered(change, before = () => {}) {
  const w = world({ sync: CAL_ONLY });
  w.server.addItem(CAL, event({ uid: "ua", summary: "A (dentiste)" }), "7:1");
  w.server.addItem(CAL, event({ uid: "ub", summary: "B (conseil)" }), "7:2");
  await w.pass();
  change(w);
  before(w);
  const [a, b] = [w.server.items.get(CAL).get("7:1"), w.server.items.get(CAL).get("7:2")];
  w.server.items.set(CAL, new Map([["7:1", b], ["7:2", a]]));
  w.server.invalidate(CAL);
  await settle(w);
  return w;
}

test("rebuild: a change made on one item never reaches the item that took its ServerId — the user's version stays as a local copy", async () => {
  const w = await renumbered((x) => x.api.userModify(x.cal(), "7:1", { location: "Cabinet" }));
  eq([...w.server.items.get(CAL)].map(([sid, i]) => [sid, i.summary, i.location]), [["7:1", "B (conseil)", "Salle 2"], ["7:2", "A (dentiste)", "Salle 2"]], "nothing is changed on the server");
  eq(rowsOf(w), [["7:1", "B (conseil)", "Salle 2", false], ["7:2", "A (dentiste)", "Salle 2", false], [null, "A (dentiste)", "Cabinet", true]], "the server's items as they are, and the user's version beside them");
  eq(w.notices.length, 1);
  assert(/n'est plus le même élément/.test(w.notices[0]) && w.notices[0].includes("A (dentiste)"), w.notices[0]);
  eq([(await w.coll(CAL)).guards, (await w.store.readLocalChanges(w.cal())).changes], [[], []]);
  // The change cannot be read for a moment while the rebuild lasts (the user is still at it): what the item was
  // is compared all the same.
  const busy = await renumbered((x) => x.api.userModify(x.cal(), "7:1", { location: "Cabinet" }), (x) => {
    const read = x.api.readLocalChanges.bind(x.api);
    let calls = 0;
    x.api.readLocalChanges = async (...args) => (++calls === 3 ? [] : read(...args));
  });
  eq([...busy.server.items.get(CAL)].map(([sid, i]) => [sid, i.summary, i.location]), [["7:1", "B (conseil)", "Salle 2"], ["7:2", "A (dentiste)", "Salle 2"]]);
  eq(rowsOf(busy), [["7:1", "B (conseil)", "Salle 2", false], ["7:2", "A (dentiste)", "Salle 2", false], [null, "A (dentiste)", "Cabinet", true]]);
});

test("rebuild: a deletion made on one item never deletes the item that took its ServerId", async () => {
  const w = await renumbered((x) => x.api.userDelete(x.cal(), "7:1"));
  eq([...w.server.items.get(CAL).keys()], ["7:1", "7:2"], "nothing is deleted on the server");
  eq(rowsOf(w), [["7:1", "B (conseil)", "Salle 2", false], ["7:2", "A (dentiste)", "Salle 2", false]], "what the server has is shown");
  eq(w.notices.length, 1);
  eq((await w.store.readLocalChanges(w.cal())).changes, []);
});

test("rebuild: an item the server does not send again — the user's change stays in a local copy, a deletion is simply done; the same item again, and the change goes", async () => {
  const w = world({ sync: CAL_ONLY });
  for (const [sid, name] of [["7:1", "A"], ["7:2", "B"], ["7:3", "C"], ["7:4", "D"]]) w.server.addItem(CAL, event({ uid: `u${name}`, summary: name }), sid);
  await w.pass();
  w.api.userModify(w.cal(), "7:1", { location: "Cabinet" });
  w.api.userDelete(w.cal(), "7:2");
  w.api.userModify(w.cal(), "7:3", { location: "Salle 9" });
  w.api.userDelete(w.cal(), "7:4");
  w.server.items.get(CAL).delete("7:1"); // gone while the key was lost
  w.server.items.get(CAL).delete("7:2");
  w.server.invalidate(CAL);
  const r = await settle(w);
  eq(r.pendingDeletes, 0);
  eq(rowsOf(w), [["7:3", "C", "Salle 9", false], [null, "A", "Cabinet", true]]);
  eq([...w.server.items.get(CAL)].map(([sid, i]) => [sid, i.location]), [["7:3", "Salle 9"]], "the change and the deletion of the items that are the same went");
  eq(w.notices.length, 1, "told of the one whose version stays as a local copy");
  assert(w.notices[0].includes("« A »"), w.notices[0]);
  // A change taken back by the user while the rebuild lasted: its item, which the rebuild left alone, is asked
  // of the server, and leaves as any item the server no longer has.
  const back = world({ sync: CAL_ONLY });
  back.server.addItem(CAL, event({ uid: "uA", summary: "A" }), "7:1");
  back.server.addItem(CAL, event({ uid: "uC", summary: "C" }), "7:3");
  await back.pass();
  back.api.userModify(back.cal(), "7:1", { location: "Cabinet" });
  back.server.items.get(CAL).delete("7:1");
  back.server.invalidate(CAL);
  let once = true;
  const onSync = back.server.onSync.bind(back.server);
  back.server.onSync = (req) => {
    if (text(collectionOf(req), "SyncKey") === "0" && once) {
      once = false;
      back.api.userModify(back.cal(), "7:1", { location: "Salle 2" }); // as it was: nothing waits any more
    }
    return onSync(req);
  };
  await settle(back);
  eq([rowsOf(back), back.notices, (await back.coll(CAL)).guards], [[["7:3", "C", "Salle 2", false]], [], []]);
  // The calendar cannot detach the item for now: it is not removed as an item the server no longer has either
  // (the user's change would go with it); the next pass does it.
  const stuck = world({ sync: CAL_ONLY });
  stuck.server.addItem(CAL, event({ uid: "uA", summary: "A" }), "7:1");
  stuck.server.addItem(CAL, event({ uid: "uC", summary: "C" }), "7:3");
  await stuck.pass();
  stuck.api.userModify(stuck.cal(), "7:1", { location: "Cabinet" });
  stuck.server.items.get(CAL).delete("7:1");
  stuck.server.invalidate(CAL);
  const apply = stuck.api.applyServerChanges.bind(stuck.api);
  stuck.api.applyServerChanges = async (id, changes) => (changes.some((c) => c.op === "detach") ? changes.map((c) => ({ serverId: c.serverId, ok: false, code: "INTERNAL" })) : apply(id, changes));
  const first = await stuck.pass();
  eq([first.moreAvailable, first.pendingDeletes, rowsOf(stuck), stuck.notices], [true, 0, [["7:1", "A", "Cabinet", false], ["7:3", "C", "Salle 2", false]], []]);
  eq((await stuck.store.readLocalChanges(stuck.cal())).changes.length, 1, "the change still waits");
  stuck.api.applyServerChanges = apply;
  await settle(stuck);
  eq([rowsOf(stuck), stuck.notices.length], [[["7:3", "C", "Salle 2", false], [null, "A", "Cabinet", true]], 1]);
});

test("rebuild: tasks have no UID on the server — the same subject and dates tell the same task", async () => {
  const w = world({ sync: { mail: true, calendar: false, contacts: false, tasks: true } });
  w.server.addItem(TASKS, task({ summary: "Rapport", due: "2026-12-05" }), "8:1");
  w.server.addItem(TASKS, task({ summary: "Courses", due: "2026-12-06" }), "8:2");
  await w.pass();
  w.api.userModify(w.cal(), "8:1", { priority: "high" });
  const [a, b] = [w.server.items.get(TASKS).get("8:1"), w.server.items.get(TASKS).get("8:2")];
  w.server.items.set(TASKS, new Map([["8:1", b], ["8:2", a]]));
  w.server.invalidate(TASKS);
  await settle(w);
  eq([...w.server.items.get(TASKS).values()].map((x) => [x.summary, x.priority]), [["Courses", "normal"], ["Rapport", "normal"]], "the other task is not changed");
  eq(w.api.items(w.cal()).map((x) => [x.serverId, x.item.summary, x.item.priority]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))), [["8:1", "Courses", "normal"], ["8:2", "Rapport", "normal"], [null, "Rapport", "high"]]);
  // The same task under the same ServerId: the change goes once the rebuild is over.
  const same = world({ sync: { mail: true, calendar: false, contacts: false, tasks: true } });
  const sid = same.server.addItem(TASKS, task({ summary: "Rapport" }));
  await same.pass();
  same.api.userModify(same.cal(), sid, { priority: "high" });
  same.server.invalidate(TASKS);
  await settle(same);
  eq([same.server.items.get(TASKS).get(sid).priority, same.notices, same.titles()], ["high", [], ["Rapport"]]);
});

test("rebuild: while it lasts, changes and deletions of items wait, whatever stops the pass — new items go; then each goes to the item it was made on", async () => {
  const w = world({ sync: CAL_ONLY });
  for (const i of range(120)) w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }), `x${i + 1}`);
  await settle(w);
  w.api.userModify(w.cal(), "x100", { summary: "E99 modifié" });
  w.api.userDelete(w.cal(), "x101");
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Local" }));
  w.server.invalidate(CAL);
  // The connection drops in the middle of the rebuild.
  let syncs = 0;
  const base = w.server.command.bind(w.server);
  w.server.command = async (cmd, root, opts) => {
    if (cmd === "Sync" && ++syncs === 4) throw new EasError(ERR.NETWORK, "Coupure.");
    return base(cmd, root, opts);
  };
  await rejects(() => w.pass(), (e) => e.code === ERR.NETWORK);
  eq((await w.coll(CAL)).full, "status3", "the rebuild is not over");
  eq([w.server.items.get(CAL).get("x100").summary, w.server.items.get(CAL).has("x101")], ["E99", true], "nothing reached an item meanwhile");
  assert(w.serverTitles(CAL).includes("Local"), "a new item names no ServerId: it does not wait");
  eq([w.api.calls.filter((c) => c[0] === "dropLocalChange").length, w.notices], [0, []]);
  eq((await w.coll(CAL)).guards.map((g) => g[0]).sort(), ["x100", "x101"]);
  w.server.command = base;
  w.restart();
  const r = await settle(w);
  eq([r.pendingDeletes, w.server.items.get(CAL).get("x100").summary, w.server.items.get(CAL).has("x101"), w.notices], [0, "E99 modifié", false, []]);
  eq([w.titles().length, (await w.coll(CAL)).guards], [120, []]);
});

// ── The folder list starts over ───────────────────────────────────────────

test("folder list restarted: the default calendar under another ServerId is the same collection — bound to it, rebuilt in place, nothing doubled; a waiting new item follows", async () => {
  const w = world({ sync: CAL_ONLY });
  for (const i of range(5)) w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }), `i${i}`);
  await w.pass();
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Local" }));
  w.api.userModify(w.cal(), "i3", { location: "Salle 9" });
  // A partnership reset: the folders are numbered again.
  const items = w.server.items.get(CAL);
  w.server.removeFolder(CAL);
  w.server.addFolder("12", "0", "Agenda", 8);
  w.server.items.set("12", items);
  eq(await w.pim.listRestarted(), true);
  const r = await settle(w);
  eq([r.pendingDeletes, w.titles(), w.api.calendars.size], [0, ["E0", "E1", "E2", "E3", "E4", "Local"], 1], "no item twice, no second calendar");
  eq(w.server.adds.map((x) => x.cid), ["12"], "the new item went to the same folder, under the ServerId it has now");
  eq(w.server.items.get("12").get("i3").location, "Salle 9", "the change went too, once the server had sent that item again");
  const coll = await w.coll(CAL);
  eq([coll.serverId, coll.full, coll.syncKey === "0"], ["12", null, false], "the collection keeps its id of ours, and knows the server's");
  eq([w.server.syncs("12")[0].key, w.server.syncs(CAL).filter((s) => s.key !== "0").length], ["0", 1], "rebuilt; the old ServerId is never asked again");
  eq(w.pim.pingFolders(w.server.folders), [{ id: "12", class: "Calendar" }]);
  eq([await w.records.get("pimRestart", null), w.notices], [null, []], "matched once");
  // Later passes go on as usual.
  w.server.addItem("12", event({ uid: "late", summary: "Tardif" }));
  await w.pass();
  eq(w.titles().length, 7);
});

test("folder list restarted: when the items are numbered again too, the old copies are deletions for the threshold — the user is asked, nothing is removed before", async () => {
  const w = world({ sync: CAL_ONLY });
  for (const i of range(60)) w.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }));
  await settle(w);
  w.server.removeFolder(CAL);
  w.server.addFolder("12", "0", "Calendrier", 8);
  for (const i of range(60)) w.server.addItem("12", event({ uid: `e${i}`, summary: `E${i}` }));
  await w.pim.listRestarted();
  let r = await settle(w);
  eq([r.pendingDeletes, w.titles().length, w.api.calendars.size], [60, 120, 1]);
  r = await settle(w, { confirmDeletes: true });
  eq([r.pendingDeletes, w.titles().length, w.api.items(w.cal()).every((x) => x.serverId.startsWith("12:"))], [0, 60, true]);
});

const TEAMS = [...PIM_FOLDERS, { id: "20", parentId: "0", name: "Équipe", type: 13 }, { id: "21", parentId: "0", name: "Projets", type: 13 }, { id: "22", parentId: "0", name: "Perso", type: 13 }];

test("folder list restarted: folders numbered again among themselves are matched by place — a waiting new item never goes to the folder that took its calendar's old ServerId", async () => {
  const w = world({ folders: TEAMS, sync: CAL_ONLY });
  w.server.addItem("20", event({ uid: "t1", summary: "Point d'équipe" }), "a1");
  w.server.addItem("21", event({ uid: "p1", summary: "Revue de projet" }), "b1");
  await w.pass();
  const [team, projects] = [w.cal("20"), w.cal("21")];
  w.api.userAdd(team, event({ uid: "l", summary: "Nouveau pour l'équipe" }));
  // "20" is Projets now, "21" is Équipe.
  const [was20, was21] = [w.server.items.get("20"), w.server.items.get("21")];
  w.server.folders.set("20", { parentId: "0", name: "Projets", type: 13 });
  w.server.folders.set("21", { parentId: "0", name: "Équipe", type: 13 });
  w.server.items.set("20", was21);
  w.server.items.set("21", was20);
  w.server.colls.clear();
  await w.pim.listRestarted();
  const r = await settle(w);
  eq(r.pendingDeletes, 0);
  eq([w.api.summaries(team), w.api.summaries(projects), w.api.calendars.size], [["Nouveau pour l'équipe", "Point d'équipe"], ["Revue de projet"], 4], "each calendar keeps its folder's items");
  eq(w.server.adds.map((x) => x.cid), ["21"], "sent to Équipe, which is 21 now — never to the folder called 20 today");
  eq([w.serverTitles("21"), w.serverTitles("20")], [["Nouveau pour l'équipe", "Point d'équipe"], ["Revue de projet"]]);
  eq([(await w.coll("20")).serverId, (await w.coll("21")).serverId], ["21", "20"]);
  eq([w.api.calendars.get(team).name, w.api.calendars.get(projects).name], ["Équipe", "Projets"]);
  eq(w.pim.pingFolders(w.server.folders).map((f) => f.id).sort(), ["20", "21", "22", "7"]);
});

test("folder list restarted: a collection that matches no folder is a folder gone, whatever its old ServerId names now; a folder that kept ServerId and type is the same, renamed", async () => {
  const w = world({ folders: TEAMS, sync: CAL_ONLY });
  for (const i of range(60)) w.server.addItem("20", event({ uid: `t${i}`, summary: `Équipe ${i}` }));
  w.server.addItem("21", event({ uid: "p1", summary: "Revue de projet" }), "b1");
  await settle(w);
  const [team, projects] = [w.cal("20"), w.cal("21")];
  w.api.userAdd(team, event({ uid: "l", summary: "Nouveau pour l'équipe" }));
  // Équipe is nowhere in the new list; Projets is "20" now; the default calendar is called otherwise.
  const was21 = w.server.items.get("21");
  w.server.removeFolder("21");
  w.server.folders.set("20", { parentId: "0", name: "Projets", type: 13 });
  w.server.items.set("20", was21);
  w.server.folders.get(CAL).name = "Agenda";
  w.server.folders.get("22").name = "Personnel"; // renamed: found by no place, but its ServerId and type are those it had
  w.server.colls.delete("20");
  const firstSyncs = (cid) => w.server.syncs(cid).filter((s) => s.key === "0").length;
  const before = [firstSyncs(CAL), firstSyncs("22")];
  await w.pim.listRestarted();
  let r = await settle(w);
  eq([r.pendingDeletes, w.api.summaries(team).length, w.api.summaries(projects)], [60, 61, ["Revue de projet"]], "Équipe: held, with its 60 events; Projets keeps its calendar");
  eq([w.server.adds, w.serverTitles("20")], [[], ["Revue de projet"]], "what waited for Équipe is not sent to the folder that is 20 now");
  eq([firstSyncs(CAL), firstSyncs("22")], before, "the default calendar and the folder that kept its ServerId and type, both renamed, go on as they were");
  eq([w.api.calendars.get(w.cal("22")).name, (await w.coll("22")).lost], ["Personnel", false]);
  eq([(await w.coll("20")).lost, (await w.coll("21")).serverId], [true, "20"]);
  // The user keeps the local copies: Équipe stays as a local calendar, and no later pass binds it to "20".
  eq(await w.pim.discardPendingDeletes(), 60);
  r = await settle(w);
  eq([r.pendingDeletes, w.api.summaries(team).length, w.api.summaries(projects), w.server.adds], [0, 61, ["Revue de projet"], []]);
  // Without the restart being told (the list only changed), ServerIds are followed as before.
  const plain = world({ folders: TEAMS, sync: CAL_ONLY });
  plain.server.addItem("20", event({ uid: "t1", summary: "Point d'équipe" }));
  await plain.pass();
  plain.server.folders.get("20").name = "Équipe, renommée";
  await plain.pass();
  eq([plain.api.calendars.get(plain.cal("20")).name, plain.server.syncs("20").filter((s) => s.key === "0").length], ["Équipe, renommée", 1]);
});

// ── A server change that cannot be read ───────────────────────────────────

test("unreadable change: the copy already held becomes read-only and keeps its content; nothing is written back from it; a readable version repairs it", async () => {
  const w = world({ sync: CAL_ONLY });
  const sid = w.server.addItem(CAL, event({ uid: "e1", summary: "Point", location: "Salle 2" }));
  const other = w.server.addItem(CAL, event({ uid: "e2", summary: "Refusé par l'agenda" }));
  await w.pass();
  // On the server the first becomes something the reader refuses; the second, something the calendar refuses.
  w.server.changeItem(CAL, sid, { raw: [el("Calendar:UID", "e1"), el("Calendar:Subject", "Point déplacé en janvier"), el("Calendar:StartTime", "pas une date"), el("Calendar:EndTime", "20270105T150000Z")] });
  w.server.changeItem(CAL, other, { summary: "Refusé par l'agenda, bis" });
  w.api.failApply = (change) => (change.item.summary === "Refusé par l'agenda, bis" ? "UNSUPPORTED" : null);
  const r = await w.pass();
  eq(r.failed, 2);
  eq(w.api.items(w.cal()).map((x) => [x.item.summary, x.item.start, x.item.readOnly]), [["Point", "2026-12-01T09:00:00Z", "incomplete"], ["Refusé par l'agenda", "2026-12-01T09:00:00Z", "incomplete"]], "what was held is kept, and locked");
  eq(w.api.calls.filter((c) => c[0] === "applyServerChanges").flatMap((c) => c[2]).filter((x) => x.op === "lock").map((x) => x.serverId).sort(), [sid, other].sort());
  eq((await w.coll(CAL)).quarantine.map((q) => q[0]).sort(), [sid, other].sort(), "both stay counted");
  // The user, who sees the old event, adds a reminder: refused, and nothing is sent.
  w.api.userModify(w.cal(), sid, { reminder: 15 });
  w.api.userDelete(w.cal(), other);
  await w.pass();
  eq([w.commands(CAL), w.notices.length, w.titles()], [[], 2, ["Point", "Refusé par l'agenda"]]);
  assert(w.notices.every((n) => /ne peut pas être modifié/.test(n)), w.notices.join(" | "));
  assert(Array.isArray(w.server.items.get(CAL).get(sid).raw), "the server's item is not overwritten by the old copy");
  // A later readable version replaces it normally.
  w.api.failApply = null;
  w.server.changeItem(CAL, sid, event({ uid: "e1", summary: "Point de janvier" }));
  w.server.changeItem(CAL, other, { summary: "Accepté" });
  const fixed = await w.pass();
  eq([fixed.failed, w.api.items(w.cal()).map((x) => [x.item.summary, x.item.readOnly])], [0, [["Point de janvier", null], ["Accepté", null]]]);
  w.api.userModify(w.cal(), sid, { reminder: 15 });
  eq((await w.pass()).sent, 1);
});

// ── What a Change does not say; what cannot be told ───────────────────────

test("from the server: a Change that says nothing of the body leaves the description as it is", async () => {
  const w = world({ sync: CAL_ONLY });
  const sid = w.server.addItem(CAL, event({ uid: "a", summary: "Ordre du jour", description: "Point 1, point 2" }));
  await w.pass();
  w.server.changeItem(CAL, sid, { raw: [el("Calendar:UID", "a"), el("Calendar:Subject", "Ordre du jour, bis"), el("Calendar:StartTime", "20261201T090000Z"), el("Calendar:EndTime", "20261201T100000Z")] });
  await w.pass();
  eq(w.api.items(w.cal()).map((x) => [x.item.summary, x.item.description]), [["Ordre du jour, bis", "Point 1, point 2"]]);
  const put = w.api.calls.filter((c) => c[0] === "applyServerChanges").at(-1)[2][0];
  eq(put.item.description, null, "a Change is read as one: what the server did not say is not said");
  // An item fetched again is whole: no body there is an empty description.
  const first = w.api.calls.filter((c) => c[0] === "applyServerChanges")[0][2][0];
  eq(first.item.description, "Point 1, point 2");
});

test("local changes: a deleted occurrence put back cannot be told to the server — the change is undone, the user told, the item fetched again", async () => {
  const weekly = { freq: "weekly", interval: 1, count: 10, until: null, byDay: ["TU"], bySetPos: null, byMonthDay: null, byMonth: null, weekStart: null };
  const w = world({ sync: CAL_ONLY });
  const sid = w.server.addItem(CAL, event({ uid: "w", summary: "Hebdo", recurrence: weekly, exceptions: [{ originalStart: "2026-12-08T09:00:00Z", deleted: true, changes: {} }] }));
  await w.pass();
  eq(w.api.items(w.cal())[0].item.exceptions.length, 1);
  w.api.userModify(w.cal(), sid, (item) => ({ ...item, exceptions: [] })); // the deletion of that occurrence is undone
  const r = await w.pass();
  eq([r.sent, w.commands(CAL)], [0, ["Fetch"]], "nothing is sent for it; the server's version is asked again");
  eq([w.api.items(w.cal())[0].item.exceptions.length, w.server.items.get(CAL).get(sid).exceptions.length], [1, 1]);
  eq([w.named, w.notices.length], [[["restoreUnsupported", "Hebdo", ""]], 1]);
  assert(w.notices[0].includes("Hebdo"), w.notices[0]);
  eq((await w.pass()).sent, 0);
  eq(w.named.length, 1);
  // The same for an occurrence that was changed and is put back as the series has it.
  const moved = world({ sync: CAL_ONLY });
  const changed = { originalStart: "2026-12-08T09:00:00Z", deleted: false, changes: { summary: "Hebdo, déplacé", start: "2026-12-08T14:00:00Z", end: "2026-12-08T15:00:00Z" } };
  const other = moved.server.addItem(CAL, event({ uid: "w2", summary: "Hebdo", recurrence: weekly, exceptions: [changed] }));
  await moved.pass();
  eq(moved.api.items(moved.cal())[0].item.exceptions.length, 1);
  moved.api.userModify(moved.cal(), other, (item) => ({ ...item, exceptions: [] }));
  eq([(await moved.pass()).sent, moved.commands(CAL), moved.named], [0, ["Fetch"], [["restoreUnsupported", "Hebdo", ""]]]);
  eq([moved.api.items(moved.cal())[0].item.exceptions.length, moved.server.items.get(CAL).get(other).exceptions.length], [1, 1]);
});

// ── Messages that wait ────────────────────────────────────────────────────

test("outbox: the messages that wait are forgotten when the mailbox has no calendar collection left", async () => {
  const waiting = async (w) => {
    await w.pass();
    w.api.userAdd(w.cal(), meeting([A], { uid: "m1", summary: "Comité" }));
    await w.pass({ deliver: false });
    eq(await w.scheduler.pending(), 1);
  };
  // The calendar is unchecked; the tasks stay.
  const unchecked = world();
  await waiting(unchecked);
  unchecked.mailbox.sync.calendar = false;
  await unchecked.pass();
  eq([await unchecked.scheduler.pending(), await unchecked.records.get("meetingOutbox", null), unchecked.asked.length, unchecked.server.mails.length], [0, null, 0, 0], "neither asked nor sent");
  // The calendar folder is gone from the server.
  const gone = world();
  await waiting(gone);
  gone.server.removeFolder(CAL);
  await gone.pass();
  eq([await gone.scheduler.pending(), gone.asked.length, gone.server.mails.length], [0, 0, 0]);
  // While its removal waits for the user, so do the messages; and while a calendar is left, they are kept.
  const held = world();
  for (const i of range(60)) held.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }));
  await waiting(held);
  await held.pass({ deliver: false });
  eq(await held.scheduler.pending(), 1, "a calendar is there: nothing is forgotten");
  held.server.removeFolder(CAL);
  eq((await held.pass({ deliver: false })).pendingDeletes, 61);
  eq(await held.scheduler.pending(), 1);
  await held.pass({ confirmDeletes: true, deliver: false });
  eq(await held.scheduler.pending(), 0);
});

// ── Limits and replays ────────────────────────────────────────────────────

test("limits: MAX_PIM_ITEMS counts every item that would be created, by an Add or by a Change; a calendar that says it is full is heard", async () => {
  const w = world({ sync: CAL_ONLY });
  await w.pass();
  let key = 2;
  let n = 0;
  let left = 0;
  let tag = "Add";
  const data = (i) => [el("Calendar:StartTime", "20261201T090000Z"), el("Calendar:EndTime", "20261201T100000Z"), el("Calendar:UID", `u${i}`), el("Calendar:Subject", `S${i}`)];
  w.server.onSync = () => {
    const cmds = left > 0 ? range(2000).map(() => el(tag, [el("ServerId", `7:${++n}`), el("ApplicationData", data(n))])) : [];
    left--;
    return el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", String(++key)), el("CollectionId", CAL), el("Status", "1"), cmds.length ? el("Commands", cmds) : null, left > 0 ? el("MoreAvailable") : null])])]);
  };
  // (The calendar double is quadratic: a stand-in that only counts, for this test; the engine is the real one.)
  const index = new Set();
  w.api.applyServerChanges = async (calendarId, changes) =>
    changes.map((ch) => {
      if (ch.op === "put") index.add(ch.serverId);
      else if (ch.op === "remove") index.delete(ch.serverId);
      return { serverId: ch.serverId, ok: true };
    });
  w.api.serverIds = async () => [...index];
  left = 11;
  await w.pass();
  eq(index.size, MAX_PIM_ITEMS, "22 000 Adds: no more than the limit are held");
  left = 2;
  tag = "Change";
  await w.pass();
  eq(index.size, MAX_PIM_ITEMS, "4 000 Changes for items never seen: not one more");
  assert((await w.coll(CAL)).quarantine.every((q) => q[1] === "LIMIT"));
  // A Change of an item that is held still passes at the limit.
  n = 0;
  left = 1;
  await w.pass();
  eq(index.size, MAX_PIM_ITEMS);
  // The calendar's own limit.
  const full = world({ sync: CAL_ONLY });
  full.api.maxItems = 3;
  for (const i of range(5)) full.server.addItem(CAL, event({ uid: `e${i}`, summary: `E${i}` }));
  const r = await full.pass();
  eq([r.received, r.failed, full.titles().length, (await full.coll(CAL)).quarantine.map((q) => q[1])], [3, 2, 3, ["LIMIT", "LIMIT"]]);
});

test("limits: the deletions that wait for the end of a run are bounded while the run lasts", async () => {
  const w = world({ sync: CAL_ONLY });
  w.server.addItem(CAL, event());
  await w.pass();
  let key = 2;
  let n = 0;
  let left = 12;
  let most = 0;
  w.server.onSync = async () => {
    most = Math.max(most, (await w.records.getMap("pimDeletes")).get(CAL)?.ids.length ?? 0);
    left--;
    const cmds = left > 0 ? range(2000).map(() => el("Delete", [el("ServerId", `7:x${++n}`)])) : [];
    return el("AirSync:Sync", [el("Collections", [el("Collection", [el("SyncKey", String(++key)), el("CollectionId", CAL), el("Status", "1"), cmds.length ? el("Commands", cmds) : null, left > 0 ? el("MoreAvailable") : null])])]);
  };
  const r = await w.pass();
  eq([n, most, r.pendingDeletes, w.titles().length], [22_000, MAX_PIM_ITEMS, 0, 1]);
});

test("lost response, then the period is changed: the request is replayed first, with the period it had — the item is not created twice", async () => {
  const w = world({ sync: CAL_ONLY });
  await w.pass();
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Nouveau" }));
  w.server.loseNextResponse("Sync");
  await rejects(() => w.pass(), (e) => e.code === ERR.NETWORK);
  w.mailbox.calendarPeriod = "0";
  await settle(w);
  eq([w.serverTitles(CAL), w.server.adds.length, w.titles()], [["Nouveau"], 1, ["Nouveau"]]);
  const carrying = w.server.syncs(CAL).filter((s) => s.commands.length);
  eq([carrying.length, carrying[0]], [2, carrying[1]], "sent again as it was, period included");
  eq([w.server.syncs(CAL).at(-1).filterType, (await w.coll(CAL)).filter, (await w.coll(CAL)).full], ["0", "0", null], "then the collection starts again with the new period");
  eq(w.api.items(w.cal()).map((x) => x.serverId), [w.server.adds[0].serverId]);
});

test("lost response: a new item the calendar no longer has when the answer comes is on the server all the same — it is fetched, to be seen", async () => {
  const w = world({ sync: CAL_ONLY });
  await w.pass();
  w.api.userAdd(w.cal(), event({ uid: "l", summary: "Fantôme" }));
  w.server.loseNextResponse("Sync");
  await rejects(() => w.pass(), (e) => e.code === ERR.NETWORK);
  // The user deletes it, and Thunderbird restarts: the calendar knows nothing of that change any more.
  w.api.calendars.get(w.cal()).rows.length = 0;
  w.restart();
  await settle(w);
  eq(w.server.items.get(CAL).size, 1);
  eq(w.api.items(w.cal()).map((x) => [x.serverId, x.item.summary]), [[w.server.adds[0].serverId, "Fantôme"]], "what is on the server is shown, and can be deleted for good");
  // One the user only changed again is bound; nothing is fetched over the newer change.
  const again = world({ sync: CAL_ONLY });
  await again.pass();
  again.api.userAdd(again.cal(), event({ uid: "l", summary: "Dentiste" }));
  again.server.hook("Sync", () => {
    again.api.userModify(again.cal(), "l", { summary: "Dentiste à 15 h" });
    return undefined;
  });
  await settle(again);
  eq([again.commands(CAL), again.serverTitles(CAL), again.notices], [["Add", "Change"], ["Dentiste à 15 h"], []]);
});

test("records: several records written together are all written, or none is", async () => {
  const area = memoryArea();
  const records = new Store(area).mailbox(MB);
  await records.set("pim:1", { v: 1 });
  const writes = area.writes;
  await records.setMany([["pim:1", { v: 2 }], ["pim:2", { v: 2 }], ["pimRestart", false]]);
  eq(area.writes - writes, 1, "one call to the storage");
  eq([await records.get("pim:1"), await records.get("pim:2"), await records.get("pimRestart"), (await records.names()).sort()], [{ v: 2 }, { v: 2 }, false, ["pim:1", "pim:2", "pimRestart"]]);
  area.failNext = 1;
  await rejects(() => records.setMany(new Map([["pim:1", { v: 3 }], ["pim:3", { v: 3 }]])));
  eq([await records.get("pim:1"), await records.get("pim:3", null), (await records.names()).includes("pim:3")], [{ v: 2 }, null, false]);
  await rejects(async () => records.setMany([["nom invalide !", 1]]));
  await records.setMany([]);
  await records.clear();
  eq(await records.names(), []);
});

// ── Privacy of the log ────────────────────────────────────────────────────

test("log: ServerIds, counts and codes only — never a title, a name, an address or a location", async () => {
  const w = world({ folders: WITH_TEAM });
  const secret = { summary: "Fusion Zébulon", location: "Tour Kérozène" };
  const a = w.server.addItem(CAL, event({ uid: "uid-Wxyz", ...secret }));
  const b = w.server.addItem(CAL, invitation({ ...secret, organizer: { email: "quidam@example.org", name: "Jean Quidam" } }));
  w.server.addItem("20", meeting([A, person(B, { name: "Bruno Quidam" })], { uid: "m", ...secret }));
  w.server.addItem(TASKS, task({ summary: "Fusion Zébulon" }));
  w.server.addRaw(CAL, [el("Calendar:Subject", "Fusion Zébulon"), el("Calendar:StartTime", "Kérozène")]);
  await w.pass();
  w.api.userAdd(w.cal(), meeting([A], { uid: "l1", ...secret }));
  w.api.userAdd(w.cal(), event({ uid: "l2", ...secret }), { problem: "recurrence" });
  w.api.userModify(w.cal(), a, { summary: "Zébulon bis" });
  w.api.userModify(w.cal(), b, answered("accepted"));
  w.server.changeStatus.set(a, "6");
  await w.pass();
  w.server.loseNextResponse("Sync");
  w.api.userAdd(w.cal(), task({ uid: "l3", summary: "Zébulon ter" }));
  await w.pass().catch(() => {});
  await w.pass();
  w.server.invalidate(CAL);
  w.server.removeFolder("20");
  w.mailbox.calendarPeriod = "5";
  await w.pass();
  for (const i of range(70)) w.server.addItem(TASKS, task({ uid: `t${i}`, summary: `Zébulon ${i}` }));
  await w.pass();
  for (const sid of [...w.server.items.get(TASKS).keys()]) w.server.deleteItem(TASKS, sid);
  await w.pass();
  await w.pim.discardPendingDeletes();
  await w.pim.removeLocal();
  const all = w.log.lines.map(([, m]) => m).join("\n");
  assert(w.log.lines.length >= 10, `the scenario is logged (${w.log.lines.length} lines)`);
  for (const word of ["Zébulon", "Kérozène", "Quidam", "Équipe", "Travail", "anne", "bruno", "chef", "quidam", "example", "uid-Wxyz", "@"]) {
    assert(!all.includes(word), `the log holds ${word}:\n${all}`);
  }
});

// ── The calendar store wrapper ────────────────────────────────────────────

test("calendar store: one mailbox only — other mailboxes' calendars are invisible, and refused by id before any call", async () => {
  const api = new FakeCalendarApi();
  const store = new CalendarStore({ mailboxId: MB, ownEmail: OWN, api });
  const other = (await api.ensureCalendar({ mailboxId: "ffffffffffff", slot: "main", name: "Autre", events: true, tasks: true, organizerEmail: "x@example.com" })).calendarId;
  const mine = (await store.ensureCalendar({ slot: "main", name: "Travail", events: true, tasks: false })).calendarId;
  eq(await store.listCalendars(), [{ calendarId: mine, slot: "main", name: "Travail", events: true, tasks: false }]);
  eq(api.calls.at(-2)[1].organizerEmail, OWN, "the organizer of the mailbox's calendars is its own address");
  const calls = api.calls.length;
  for (const id of [other, "sync443-0123456789ab-0", "sync443-0123456789ab-1x", "autre", "", null, 7]) {
    await rejects(() => store.removeCalendar(id), (e) => e instanceof CalendarStoreError && e.code === "CONFIG");
    await rejects(() => store.applyServerChanges(id, []), (e) => e.code === "CONFIG");
    await rejects(() => store.serverIds(id, "7"), (e) => e.code === "CONFIG");
    await rejects(() => store.readLocalChanges(id), (e) => e.code === "CONFIG");
    await rejects(() => store.ackLocalChange(id, "a.1"), (e) => e.code === "CONFIG");
    await rejects(() => store.dropLocalChange(id, "a.1"), (e) => e.code === "CONFIG");
  }
  eq(api.calls.length, calls, "nothing reached the privileged module");
  throws(() => new CalendarStore({ mailboxId: "pas un id", ownEmail: OWN, api }), (e) => e.code === "CONFIG");
  throws(() => new CalendarStore({ mailboxId: MB, ownEmail: "moi", api }), (e) => e.code === "CONFIG");
  throws(() => new CalendarStore({ mailboxId: MB, ownEmail: OWN, api: {} }), (e) => e.code === "UNSUPPORTED");
});

test("calendar store: changes go in batches of 200 at most, results come back one per change and in order", async () => {
  const api = new FakeCalendarApi();
  const store = new CalendarStore({ mailboxId: MB, ownEmail: OWN, api });
  const cal = (await store.ensureCalendar({ slot: "main", name: "Travail", events: true, tasks: true })).calendarId;
  eq(MAX_BATCH, 200);
  const changes = range(450).map((i) => ({ op: "put", collectionId: "7", serverId: `7:${i}`, item: i === 300 ? { ...event(), start: "demain" } : event({ uid: `e${i}` }) }));
  const results = await store.applyServerChanges(cal, changes);
  eq(api.calls.filter((c) => c[0] === "applyServerChanges").map((c) => c[2].length), [200, 200, 50]);
  eq(results.length, 450);
  eq(results.map((r) => r.serverId), changes.map((c) => c.serverId));
  eq(results[300], { serverId: "7:300", ok: false, code: "INVALID" });
  eq(results.filter((r) => r.ok).length, 449);
  eq((await store.serverIds(cal, "7")).length, 449);
  // A change that is not one of the three shapes is refused before any call.
  const calls = api.calls.length;
  for (const bad of [{ op: "wipe", collectionId: "7", serverId: "7:1" }, { op: "put", collectionId: "7", serverId: "7:1" }, { op: "remove", collectionId: "", serverId: "7:1" }, null]) {
    await rejects(() => store.applyServerChanges(cal, [bad]), (e) => e.code === "CONFIG");
  }
  await rejects(() => store.applyServerChanges(cal, "tout"), (e) => e.code === "CONFIG");
  eq(api.calls.length, calls);
});

test("calendar store: what privileged code returns is checked again — results, ids, lists", async () => {
  const api = new FakeCalendarApi();
  const store = new CalendarStore({ mailboxId: MB, ownEmail: OWN, api });
  const cal = (await store.ensureCalendar({ slot: "main", name: "Travail", events: true, tasks: true })).calendarId;
  const put = [{ op: "put", collectionId: "7", serverId: "7:1", item: event() }];
  for (const answer of [null, [], [{ serverId: "7:2", ok: true }], [{ serverId: "7:1", ok: true }, { serverId: "7:1", ok: true }], ["ok"]]) {
    api.applyServerChanges = async () => answer;
    await rejects(() => store.applyServerChanges(cal, put), (e) => e.code === "INTERNAL");
  }
  api.applyServerChanges = async () => [{ serverId: "7:1", ok: false, code: "Jean Dupont <jean@example.org>" }];
  eq(await store.applyServerChanges(cal, put), [{ serverId: "7:1", ok: false, code: "INTERNAL" }], "an unknown code is not passed on");
  api.serverIds = async () => ["7:1", "", 7, null, "7:1", "x".repeat(65), "7:2"];
  eq(await store.serverIds(cal, "7"), ["7:1", "7:2"]);
  api.serverIds = async () => "7:1";
  await rejects(() => store.serverIds(cal, "7"), (e) => e.code === "INTERNAL");
  api.listCalendars = async () => [
    { calendarId: cal, mailboxId: MB, slot: "main", name: "Travail", events: true, tasks: 1 },
    { calendarId: cal, mailboxId: MB, slot: "20", name: "Doublon", events: true, tasks: true },
    { calendarId: "sync443-0123456789ab-2", mailboxId: MB, slot: "", name: "Sans emplacement", events: true, tasks: true },
    { calendarId: "sync443-ffffffffffff-1", mailboxId: MB, slot: "main", name: "Faux", events: true, tasks: true },
    { calendarId: "sync443-0123456789ab-3", mailboxId: "ffffffffffff", slot: "main", name: "Autre", events: true, tasks: true },
    null,
  ];
  eq(await store.listCalendars(), [{ calendarId: cal, slot: "main", name: "Travail", events: true, tasks: false }]);
  api.ensureCalendar = async () => ({ calendarId: "sync443-ffffffffffff-1", created: true });
  await rejects(() => store.ensureCalendar({ slot: "main", name: "Travail", events: true, tasks: true }), (e) => e.code === "INTERNAL");
  for (const bad of [{ slot: "", name: "x", events: true, tasks: true }, { slot: "main", name: "", events: true, tasks: true }, { slot: "main", name: "x", events: false, tasks: false }, { slot: "main", name: "x", events: 1, tasks: true }]) {
    await rejects(() => store.ensureCalendar(bad), (e) => e.code === "CONFIG");
  }
});

test("calendar store: local changes are checked one by one; a description the checks refuse is never handed over", () => {
  const good = { changeId: "ab.1", op: "modify", kind: "event", collectionId: "7", serverId: "7:1", item: event({ summary: "Bon" }), previous: event(), problem: null, detached: false };
  const checked = checkChange(good, { ownEmail: OWN });
  eq([checked.changeId, checked.item.summary, checked.previous.summary, checked.problem, checked.detached], ["ab.1", "Bon", "Point hebdomadaire", null, false]);
  assert(Object.isFrozen(checked.item), "a clean frozen copy, not the object privileged code gave");
  // An item that fails the checks: named as a problem, never passed on.
  eq(checkChange({ ...good, item: { ...event(), start: "demain" } }).problem, "invalid");
  eq(checkChange({ ...good, item: { ...event(), start: "demain" } }).item, null);
  eq(checkChange({ ...good, item: { ...event(), recurrence: { freq: "hourly" } } }).problem, "recurrence");
  eq(checkChange({ ...good, item: null }).problem, "invalid");
  eq(checkChange({ ...good, kind: "task" }).problem, "invalid", "an event given as a task");
  eq(checkChange({ ...good, previous: { ...event(), end: "hier" } }).previous, null, "a previous that fails is only missing");
  eq(checkChange({ ...good, problem: "too-large", item: event() }).item, null, "a problem always comes without item");
  eq(checkChange({ ...good, problem: "autre chose" }).problem, "invalid");
  // A meeting whose organizer is said to be the mailbox must name the mailbox's address.
  const forged = { ...meeting([A]), organizer: { email: "autre@example.org", name: "" } };
  eq(checkChange({ ...good, item: forged }, { ownEmail: OWN }).problem, "invalid");
  // Text is cleaned on the way.
  const bidi = String.fromCharCode(0x202e);
  eq(checkChange({ ...good, item: event({ summary: `Bon${bidi}jour` }) }).item.summary, "Bonjour");
  // Entries that cannot even be named.
  for (const bad of [
    null, "x", [], { ...good, changeId: "" }, { ...good, changeId: "a b" }, { ...good, changeId: "x".repeat(129) }, { ...good, changeId: 7 },
    { ...good, op: "explode" }, { ...good, kind: "contact" }, { ...good, collectionId: "" }, { ...good, serverId: 7 },
    { ...good, op: "add" }, { ...good, serverId: null }, { ...good, op: "delete", serverId: null },
  ]) eq(checkChange(bad), null, JSON.stringify(bad)?.slice(0, 80));
  eq(checkChange({ ...good, op: "add", serverId: null, collectionId: null, detached: true }).detached, true);
  eq(checkChange({ ...good, detached: true }).detached, false, "only an add can be a detached copy changed later");
  eq(checkChange({ ...good, op: "delete", item: event() }).item, null);
});

test("calendar store: readLocalChanges counts what it had to leave out; privileged errors keep their code and lose their reason", async () => {
  const api = new FakeCalendarApi();
  const store = new CalendarStore({ mailboxId: MB, ownEmail: OWN, api });
  const cal = (await store.ensureCalendar({ slot: "main", name: "Travail", events: true, tasks: true })).calendarId;
  api.userAdd(cal, event({ uid: "a" }));
  api.userAdd(cal, event({ uid: "b" }));
  const real = api.readLocalChanges.bind(api);
  api.readLocalChanges = async (...args) => {
    const list = await real(...args);
    return [list[0], { ...list[1], changeId: list[0].changeId }, { changeId: "n'importe quoi" }, ...range(300).map(() => list[1])];
  };
  const read = await store.readLocalChanges(cal, { max: 5000 });
  eq([read.changes.length, read.rejected], [2, 198], "a repeated changeId is one change; never more than 200 entries are looked at");
  eq(api.calls.filter((c) => c[0] === "readLocalChanges").at(-1)[2], { max: 200 });
  api.readLocalChanges = async () => {
    throw new Error("LIMIT: trop d'agendas pour Jean Dupont <jean@example.org>");
  };
  const e = await rejects(() => store.readLocalChanges(cal), (x) => x instanceof CalendarStoreError && x.code === "LIMIT");
  assert(!/Dupont|jean/.test(e.message), e.message);
  api.readLocalChanges = async () => {
    throw new Error("quelque chose d'inattendu à propos de jean@example.org");
  };
  eq((await rejects(() => store.readLocalChanges(cal))).code, "INTERNAL");
  api.readLocalChanges = async () => ({ length: 3 });
  await rejects(() => store.readLocalChanges(cal), (x) => x.code === "INTERNAL");
});

test("calendar store: acknowledging and dropping pass checked values only; onLocalChange tells of this mailbox's calendars only", async () => {
  const api = new FakeCalendarApi();
  const store = new CalendarStore({ mailboxId: MB, ownEmail: OWN, api });
  const cal = (await store.ensureCalendar({ slot: "main", name: "Travail", events: true, tasks: true })).calendarId;
  const other = (await api.ensureCalendar({ mailboxId: "ffffffffffff", slot: "main", name: "Autre", events: true, tasks: true, organizerEmail: "x@example.com" })).calendarId;
  const heard = [];
  const stop = store.onLocalChange((id) => {
    heard.push(id);
    throw new Error("un écouteur qui échoue ne remonte pas");
  });
  api.userAdd(cal, event({ uid: "a" }));
  api.userAdd(other, event({ uid: "b" }));
  eq(heard, [cal]);
  const { changes } = await store.readLocalChanges(cal);
  for (const bad of [{ serverId: "" }, { serverId: "7:1", collectionId: 7 }, { item: "x" }]) {
    await rejects(() => store.ackLocalChange(cal, changes[0].changeId, bad), (e) => e.code === "CONFIG");
  }
  await rejects(() => store.ackLocalChange(cal, "pas un id", {}), (e) => e.code === "CONFIG");
  await rejects(() => store.dropLocalChange(cal, ""), (e) => e.code === "CONFIG");
  eq(await store.ackLocalChange(cal, changes[0].changeId, { serverId: "7:1", collectionId: "7", item: changes[0].item }), true);
  eq(await store.ackLocalChange(cal, changes[0].changeId, { serverId: "7:1", collectionId: "7" }), false, "settled already");
  eq(await store.dropLocalChange(cal, changes[0].changeId), false);
  stop();
  api.userAdd(cal, event({ uid: "c" }));
  eq(heard.length, 1);
});
