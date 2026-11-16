// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * The invitation table (src/sync/invitations.mjs), alone and as the mail
 * engine keeps it (src/sync/mail.mjs, through ctx.invitations), against the
 * fake server and the fake Thunderbird account of mail-sync.test.mjs.
 */

import { test, assert, eq } from "./harness.mjs";
import { el } from "../../src/core/wbxml.mjs";
import { base64 } from "../../src/core/base64.mjs";
import { encodeUtf8 } from "../../src/core/utf8.mjs";
import { Store } from "../../src/sync/store.mjs";
import { InvitationTable, invitationUid, invitationStart, folderKind, MAX_INVITATIONS, MAX_PER_UID } from "../../src/sync/invitations.mjs";
import { CollectionState, MailPass, syncCollection, replayMoves } from "../../src/sync/mail.mjs";
import { readEmail } from "../../src/core/mail-codec.mjs";
import { memoryArea } from "./journal.test.mjs";
import { FakeServer, FakeMailStore, DEFAULT_FOLDERS, mime, quietLog } from "./mail-sync.test.mjs";

const MB = "0123456789ab";
const CHEF = "chef@example.org";
const START = "2026-12-01T09:00:00Z";
/** The event the user answers, as the answer flow gives it to find(). */
const EVENT = { organizer: CHEF, start: START };

function table({ area = memoryArea(), start = 1000 } = {}) {
  const records = new Store(area).mailbox(MB);
  const clock = { now: start };
  return { area, records, clock, table: new InvitationTable({ records, now: () => clock.now++ }) };
}

/** An invitation mail as the mail engine notes it: in the inbox, from the organizer, for the start of EVENT. */
const mail = (uid, serverId, over = {}) => ({ uid, collectionId: "1", serverId, organizer: CHEF, start: START, kind: "inbox", ...over });

// ── The table ─────────────────────────────────────────────────────────────

test("invitations: note, find, forget by collection and ServerId", async () => {
  const { table: t } = table();
  eq(await t.find("uid-1", EVENT), null);
  eq(await t.note(mail("uid-1", "1:5")), true);
  eq(await t.find("uid-1", EVENT), { collectionId: "1", serverId: "1:5", at: 1000 });
  eq(await t.candidates("uid-1"), [{ collectionId: "1", serverId: "1:5", at: 1000, organizer: CHEF, start: START, kind: "inbox" }]);
  eq(await t.forget("1", "1:6"), false, "another mail: nothing forgotten");
  eq(await t.forget("2", "1:5"), false, "another collection: nothing forgotten");
  eq(await t.size(), 1);
  eq(await t.forget("1", "1:5"), true);
  eq(await t.find("uid-1", EVENT), null);
  eq([await t.size(), await t.candidates("uid-1")], [0, []]);
});

test("invitations: a mail is named only for the event it invites to — same organizer, same start", async () => {
  const { table: t } = table();
  await t.note(mail("uid-1", "1:5"));
  const found = { collectionId: "1", serverId: "1:5", at: 1000 };
  eq(await t.find("uid-1", EVENT), found);
  eq(await t.find("uid-1", { organizer: "CHEF@Example.ORG", start: START }), found, "an address is the same whatever its case");
  // Nothing is named without the event, or for an event that is not the one the mail invites to.
  eq(await t.find("uid-1"), null, "no event: no mail");
  eq(await t.find("uid-1", {}), null);
  eq(await t.find("uid-1", { organizer: CHEF }), null, "no start");
  eq(await t.find("uid-1", { start: START }), null, "no organizer");
  eq(await t.find("uid-1", { organizer: "autre@example.org", start: START }), null, "another organizer");
  eq(await t.find("uid-1", { organizer: CHEF, start: "2026-12-01T10:00:00Z" }), null, "another start");
  eq(await t.find("uid-1", { organizer: CHEF, start: "2026-12-01" }), null, "a day is not an instant");
  eq(await t.find("uid-1", { organizer: "pas une adresse", start: START }), null);
  eq(await t.find("uid-1", { organizer: CHEF, start: "demain" }), null);
  eq(await t.find("uid-2", EVENT), null, "another meeting");
  // An all-day meeting is compared by its day.
  await t.note(mail("uid-day", "1:6", { start: "2026-12-24" }));
  eq((await t.find("uid-day", { organizer: CHEF, start: "2026-12-24" })).serverId, "1:6");
  eq(await t.find("uid-day", { organizer: CHEF, start: "2026-12-24T00:00:00Z" }), null);
});

test("invitations: a later mail with the same UID does not take the answer over, and cannot block it either", async () => {
  const { table: t } = table();
  // The real invitation, then a mail someone else sent under the same UID, with another time.
  await t.note(mail("uid-1", "1:5"));
  await t.note(mail("uid-1", "1:200", { start: "2026-12-01T18:00:00Z" }));
  eq((await t.candidates("uid-1")).map((m) => m.serverId), ["1:5", "1:200"], "both are known: the later one replaces nothing");
  eq((await t.find("uid-1", EVENT)).serverId, "1:5", "the later mail is not named for the event; the real one still is");
  // Another organizer under the same UID, a mail that says nothing usable: ignored too, never named, never blocking.
  await t.note(mail("uid-1", "1:201", { organizer: "eve@evil.example" }));
  for (const [sid, odd] of [["1:300", { organizer: null }], ["1:301", { start: null }], ["1:302", { organizer: "pas une adresse" }], ["1:303", { start: "2026-13-45T00:00:00Z" }]]) await t.note(mail("uid-1", sid, odd));
  eq((await t.candidates("uid-1")).length, 7);
  eq((await t.find("uid-1", EVENT)).serverId, "1:5");
  eq(await t.find("uid-1", { organizer: "eve@evil.example", start: "2026-12-01T18:00:00Z" }), null, "organizer and start must both be those of one mail");
  // A mail is only ever named for an event that has its own organizer and start: the meeting rescheduled by its
  // organizer is answered on the mail for the new time, the old one on the old.
  eq((await t.find("uid-1", { organizer: CHEF, start: "2026-12-01T18:00:00Z" })).serverId, "1:200");
  eq((await t.find("uid-1", { organizer: "eve@evil.example", start: START })).serverId, "1:201");
  // Among the mails that give the event's organizer and start, the most recent one.
  await t.note(mail("uid-1", "6:9", { collectionId: "6", kind: "mail", organizer: "Chef@Example.org" }));
  await t.note(mail("uid-1", "1:400", { start: "2026-12-02T09:00:00Z" }));
  eq((await t.find("uid-1", EVENT)).serverId, "6:9");
  // No mail for the event: none is named, whatever else is known for the UID.
  await t.forget("1", "1:5");
  await t.forget("6", "6:9");
  eq(await t.find("uid-1", EVENT), null);
});

test("invitations: mails of Junk, Sent Items, Drafts, Outbox and Deleted Items are never noted; an unknown kind neither", async () => {
  const { table: t, records } = table();
  for (const kind of ["junk", "sent", "drafts", "outbox", "trash", null, undefined, "", "INBOX", "calendar", "__proto__", 3, {}]) {
    eq(await t.note(mail("uid-1", "9:1", { kind })), false, `kind ${String(kind)}`);
  }
  eq([await t.size(), await t.find("uid-1", EVENT)], [0, null]);
  assert(!(await records.names()).includes("invitations"), "nothing written");
  eq(await t.note(mail("uid-1", "1:5", { kind: "inbox" })), true);
  eq(await t.note(mail("uid-1", "6:1", { collectionId: "6", kind: "mail" })), true);
  eq((await t.candidates("uid-1")).map((m) => m.kind), ["inbox", "mail"]);
  // A forged mail that sits in Junk cannot make the candidates disagree, nor push anything out.
  for (let i = 0; i < MAX_INVITATIONS + 10; i++) await t.note(mail(i % 2 ? "uid-1" : `flood-${i}`, `9:${i}`, { collectionId: "9", kind: "junk", start: "2026-12-01T18:00:00Z" }));
  eq(await t.size(), 2, "500 invitations in Junk evict nothing");
  eq((await t.find("uid-1", EVENT)).serverId, "6:1");
  // A mail the table knows, noted again from a folder that is not noted: forgotten.
  eq(await t.note(mail("uid-1", "6:1", { collectionId: "6", kind: "trash" })), false);
  eq((await t.candidates("uid-1")).map((m) => m.serverId), ["1:5"]);
  // The mail engine's call: the kind is required, and decides before anything else.
  const email = { messageClass: "IPM.Schedule.Meeting.Request", meetingRequest: { uid: "uid-2", messageType: null, organizer: CHEF, start: START, allDay: false, zone: null } };
  for (const kind of ["junk", "sent", "drafts", "outbox", "trash", undefined]) eq(await t.noteMail("9", "9:900", email, kind), false, `noteMail in ${kind}`);
  eq(await t.find("uid-2", EVENT), null);
  eq(await t.noteMail("1", "1:900", email, "inbox"), true);
  eq(await t.find("uid-2", EVENT), { collectionId: "1", serverId: "1:900", at: (await t.candidates("uid-2"))[0].at });
});

test("invitations: the kind of a folder, from its local path and from the mail engine's own knowledge of the trash", () => {
  const rows = [
    ["/Inbox", "inbox"], ["/Inbox/Clients", "inbox"], ["/Drafts", "drafts"], ["/Drafts/Modèles", "drafts"], ["/Sent", "sent"], ["/Sent/2025", "sent"],
    ["/Trash", "trash"], ["/Trash/Vieux", "trash"], ["/Unsent Messages", "outbox"], ["/Projets", "mail"], ["/Projets/2026", "mail"], ["/Archives", "mail"],
    ["/Sent (2)", "mail"], ["/Inbox (2)", "mail"], ["/Templates", "mail"],
    // Junk has no folder type in ActiveSync: known by its name, in the languages of the interface, wherever it is.
    ["/Junk (2)", "junk"], ["/Junk E-mail", "junk"], ["/Junk Email", "junk"], ["/JUNK E-MAIL", "junk"], ["/Junk-E-Mail", "junk"], ["/Spam", "junk"], ["/spam (3)", "junk"], ["/Bulk Mail", "junk"],
    ["/Courrier indésirable", "junk"], ["/Courrier indesirable", "junk"], ["/Correo no deseado", "junk"], ["/Posta indesiderata", "junk"], ["/Lixo Eletrônico", "junk"],
    ["/Wiadomości-śmieci", "junk"], ["/Nevyžádaná pošta", "junk"], ["/Нежелательная почта", "junk"], ["/迷惑メール", "junk"],
    ["/Lixo Eletrónico", "junk"], ["/Ongewenste e-mail", "junk"], ["/Skräppost", "junk"], ["/垃圾邮件", "junk"],
    ["/Inbox/Spam", "junk"], ["/Junk E-mail/2026", "junk"], ["/Projets/Courrier indésirable/x", "junk"],
    // Not junk: a name that only contains one of those words.
    ["/Spam reports", "mail"], ["/Anti-spam", "mail"], ["/Junkyard", "mail"], ["/Inbox/Bulky", "inbox"],
  ];
  for (const [path, kind] of rows) eq(folderKind(path), kind, path);
  // The mail engine says when a collection is the server's Deleted Items or inside it, whatever its path.
  eq(folderKind("/Projets", { inTrash: true }), "trash");
  eq(folderKind("/Inbox", { inTrash: true }), "trash");
  eq(folderKind("/Inbox", { inTrash: "oui" }), "inbox", "only a real boolean");
  // No local folder, or anything that is not a path: unknown, so never noted.
  for (const none of [null, undefined, "", "/", "Inbox", 5, {}, ["/Inbox"]]) eq(folderKind(none), null, String(none));
});

test("invitations: persisted in the mailbox's records, read back by a new instance", async () => {
  const a = table();
  await a.table.note(mail("uid-1", "1:5"));
  await a.table.note(mail("uid-2", "6:9", { collectionId: "6", kind: "mail" }));
  await a.table.note(mail("uid-1", "1:7", { start: "2026-12-01T18:00:00Z" }));
  const again = new InvitationTable({ records: a.records });
  eq(await again.find("uid-2", EVENT), { collectionId: "6", serverId: "6:9", at: 1001 });
  eq(await again.candidates("uid-1"), [
    { collectionId: "1", serverId: "1:5", at: 1000, organizer: CHEF, start: START, kind: "inbox" },
    { collectionId: "1", serverId: "1:7", at: 1002, organizer: CHEF, start: "2026-12-01T18:00:00Z", kind: "inbox" },
  ]);
  eq([(await again.find("uid-1", EVENT)).serverId, (await again.find("uid-1", { organizer: CHEF, start: "2026-12-01T18:00:00Z" })).serverId], ["1:5", "1:7"], "each one for its own event");
  eq(await again.size(), 3);
  assert((await a.records.names()).includes("invitations"));
  await again.clear();
  eq(await new InvitationTable({ records: a.records }).size(), 0);
  assert(!(await a.records.names()).includes("invitations"), "an empty table leaves no record");
});

test("invitations: at most 500 mails in all and 8 for one meeting, the oldest dropped first", async () => {
  const { table: t, records } = table();
  eq([MAX_INVITATIONS, MAX_PER_UID], [500, 8]);
  for (let i = 0; i < MAX_INVITATIONS + 3; i++) await t.note(mail(`uid-${i}`, `1:${i}`));
  eq(await t.size(), MAX_INVITATIONS);
  eq([await t.find("uid-0", EVENT), await t.find("uid-1", EVENT), await t.find("uid-2", EVENT)], [null, null, null]);
  eq((await t.find("uid-3", EVENT)).serverId, "1:3");
  eq((await t.find(`uid-${MAX_INVITATIONS + 2}`, EVENT)).serverId, `1:${MAX_INVITATIONS + 2}`);
  // The mails of the evicted entries are no longer known either.
  eq(await t.forget("1", "1:0"), false);
  // One meeting never holds more than its share: its first mail stays with its most recent ones, the other meetings stay.
  for (let i = 0; i < MAX_PER_UID + 4; i++) await t.note(mail("crowded", `6:${i}`, { collectionId: "6", kind: "mail", ...(i ? { start: "2026-12-01T18:00:00Z" } : {}) }));
  eq((await t.candidates("crowded")).map((m) => m.serverId), ["6:0", ...Array.from({ length: MAX_PER_UID - 1 }, (_, i) => `6:${i + 5}`)]);
  eq((await t.find("crowded", EVENT)).serverId, "6:0", "eleven later mails for another time did not push the first invitation out");
  eq(await t.size(), MAX_INVITATIONS);
  eq((await t.find(`uid-${MAX_INVITATIONS + 2}`, EVENT)).serverId, `1:${MAX_INVITATIONS + 2}`, "the newest of the others is untouched");
  // The same bounds hold for what a new instance reads back.
  const again = new InvitationTable({ records });
  eq([await again.size(), (await again.candidates("crowded")).length], [MAX_INVITATIONS, MAX_PER_UID]);
});

test("invitations: an invitation noted again becomes the newest and is evicted last", async () => {
  const { table: t } = table();
  for (let i = 0; i < MAX_INVITATIONS; i++) await t.note(mail(`uid-${i}`, `1:${i}`));
  await t.note(mail("uid-0", "1:0"));
  await t.note(mail("new", "1:new"));
  assert((await t.find("uid-0", EVENT)) !== null, "refreshed: kept");
  eq(await t.find("uid-1", EVENT), null, "the oldest one left");
  eq(await t.size(), MAX_INVITATIONS);
});

test("invitations: one mail names one meeting (a mail noted again under another UID leaves the first)", async () => {
  const { table: t } = table();
  await t.note(mail("uid-1", "1:5"));
  await t.note(mail("uid-2", "1:5"));
  eq([await t.find("uid-1", EVENT), (await t.find("uid-2", EVENT)).serverId], [null, "1:5"]);
  eq([await t.size(), await t.candidates("uid-1")], [1, []]);
});

test("invitations: a moved mail is followed under its new ids, with its age; moved where mails are not noted, or nowhere known, it is forgotten", async () => {
  const { table: t, records } = table();
  await t.note(mail("uid-1", "1:5"));
  await t.note(mail("uid-2", "1:6"));
  await t.note(mail("uid-1", "1:7"));
  eq(await t.moved("1", "1:5", "6", "6:1", "mail"), true);
  eq(await t.candidates("uid-1"), [
    { collectionId: "6", serverId: "6:1", at: 1000, organizer: CHEF, start: START, kind: "mail" },
    { collectionId: "1", serverId: "1:7", at: 1002, organizer: CHEF, start: START, kind: "inbox" },
  ], "the same rank among the mails of its meeting");
  eq((await t.find("uid-1", EVENT)).serverId, "1:7");
  eq(await t.forget("1", "1:5"), false);
  eq(await new InvitationTable({ records }).candidates("uid-1"), await t.candidates("uid-1"), "written at once");
  // Without a new ServerId the mail is forgotten (the destination's next sync tells of it again).
  eq(await t.moved("1", "1:6", "6", null, "mail"), true);
  eq(await t.find("uid-2", EVENT), null);
  eq(await t.moved("1", "1:404", "6", "6:2", "mail"), false, "not an invitation: nothing");
  // To the trash, to Junk, or to a folder whose kind is not told: forgotten.
  for (const [sid, kind] of [["1:7", "trash"], ["6:1", undefined]]) {
    eq(await t.moved(sid.split(":")[0], sid, "3", `3:${sid}`, kind), true, String(kind));
  }
  eq([await t.size(), await t.find("uid-1", EVENT)], [0, null]);
  await t.note(mail("uid-3", "1:8"));
  eq(await t.moved("1", "1:8", "9", "9:1", "junk"), true);
  eq(await t.size(), 0);
});

test("invitations: forgetCollection drops every mail of a collection, and only those", async () => {
  const { table: t } = table();
  await t.note(mail("a", "1:1"));
  await t.note(mail("b", "6:1", { collectionId: "6", kind: "mail" }));
  await t.note(mail("c", "1:2"));
  await t.note(mail("b", "1:3"));
  eq(await t.forgetCollection("1"), 3);
  eq([await t.find("a", EVENT), await t.find("c", EVENT), (await t.find("b", EVENT)).serverId], [null, null, "6:1"]);
  eq(await t.forgetCollection("1"), 0);
});

test("invitations: hostile values are refused (UIDs, ids), never stored", async () => {
  const { table: t, records } = table();
  const bidi = String.fromCharCode(0x202e);
  const loneSurrogate = String.fromCharCode(0xd800);
  const bell = String.fromCharCode(7);
  for (const uid of ["", "x".repeat(301), "a\nb", `a${bidi}b`, `a${String.fromCharCode(0)}b`, null, 7, { toString: () => "x" }, loneSurrogate]) {
    eq(await t.note(mail(uid, "1:1")), false, `uid ${JSON.stringify(uid)}`);
    eq(await t.find(uid, EVENT), null);
    eq(await t.candidates(uid), []);
  }
  for (const id of ["", "x".repeat(65), `a${bell}b`, null, 5]) {
    eq(await t.note(mail("ok", "1:1", { collectionId: id })), false);
    eq(await t.note(mail("ok", id)), false);
  }
  eq(await t.size(), 0);
  // Property names of objects are not special: a Map record holds them.
  for (const uid of ["__proto__", "constructor", "toString"]) await t.note(mail(uid, `1:${uid}`));
  eq((await t.find("__proto__", EVENT)).serverId, "1:__proto__");
  eq(await new InvitationTable({ records }).size(), 3);
});

test("invitations: a damaged record is read as far as it is valid, and bounded; a record of the earlier shape names nothing", async () => {
  const area = memoryArea();
  const records = new Store(area).mailbox(MB);
  const good = { collectionId: "1", serverId: "1:1", at: 5, organizer: CHEF, start: START, kind: "inbox" };
  const entries = [
    ["good", [good, "pas un courrier", null, { ...good, serverId: "1:9", kind: "junk" }, { ...good, serverId: "1:8", kind: "sent" }]],
    ["no-ids", [{ at: 1, organizer: CHEF, start: START, kind: "inbox" }]],
    ["bad\nuid", [{ ...good, serverId: "1:2" }]],
    ["twin", [{ ...good, at: 9 }]], // a second entry for the same mail
    ["later", [{ ...good, serverId: "1:3", at: "demain", organizer: "pas une adresse", start: "bientôt" }]],
    ["no-kind", [{ ...good, serverId: "1:4", kind: undefined }]],
    // What a build from before kept: one mail per UID, and nothing of what it said.
    ["old-shape", { collectionId: "1", serverId: "1:5", at: 3 }],
    ["not-a-list", "1:6"],
  ];
  for (let i = 0; i < 600; i++) entries.push([`fill-${i}`, [{ ...good, collectionId: "9", serverId: `9:${i}`, at: 10 + i }]]);
  entries.push(["crowded", Array.from({ length: 40 }, (_, i) => ({ ...good, collectionId: "6", serverId: `6:${i}`, at: 1000 + i }))]);
  await records.set("invitations", entries);
  const t = new InvitationTable({ records });
  eq(await t.size(), MAX_INVITATIONS);
  eq((await t.candidates("crowded")).map((m) => m.serverId), ["6:8", ...Array.from({ length: MAX_PER_UID - 1 }, (_, i) => `6:${i + 33}`)], "of a crowded meeting, the first of what is read and the most recent");
  eq(await t.candidates("fill-599"), [{ ...good, collectionId: "9", serverId: "9:599", at: 609 }]);
  eq([await t.candidates("no-ids"), await t.candidates("twin"), await t.candidates("no-kind"), await t.candidates("old-shape"), await t.candidates("not-a-list")], [[], [], [], [], []]);
  // Read alone, the damaged entries give what is valid in them.
  await records.set("invitations", entries.slice(0, 8));
  const small = new InvitationTable({ records });
  eq(await small.candidates("good"), [good], "the mails of folders that are not noted are not taken back");
  eq(await small.candidates("later"), [{ ...good, serverId: "1:3", at: 0, organizer: null, start: null }]);
  eq(await small.find("later", EVENT), null, "a mail that says nothing usable agrees with nothing");
  eq(await small.size(), 2);
  await records.set("invitations", "pas une table");
  eq(await new InvitationTable({ records }).size(), 0);
});

test("invitations: a storage failure never reaches the mail engine's calls", async () => {
  const area = memoryArea();
  const t = new InvitationTable({ records: new Store(area).mailbox(MB), log: quietLog() });
  await t.note(mail("uid-1", "1:1"));
  await t.note(mail("uid-3", "1:3"));
  area.failNext = 4;
  const email = { messageClass: "IPM.Schedule.Meeting.Request", meetingRequest: { uid: "uid-2", messageType: null, organizer: CHEF, start: START } };
  eq(await t.noteMail("1", "1:2", email, "inbox"), false);
  eq(await t.forget("1", "1:1"), false);
  eq(await t.moved("1", "1:3", "6", "6:3", "mail"), false);
  eq(await t.forgetCollection("1"), 0);
});

// ── Which mails count ─────────────────────────────────────────────────────

test("invitations: a mail counts when it carries a meeting request with a UID, and can be answered", () => {
  const request = (over = {}) => ({ uid: "uid-1", messageType: null, ...over });
  eq(invitationUid({ messageClass: "IPM.Schedule.Meeting.Request", meetingRequest: request() }), "uid-1");
  eq(invitationUid({ messageClass: "ipm.schedule.meeting.request.custom", meetingRequest: request() }), "uid-1");
  eq(invitationUid({ messageClass: null, meetingRequest: request() }), "uid-1", "a server that gives no class");
  eq(invitationUid({ messageClass: "IPM.Note", meetingRequest: null }), null, "an ordinary mail");
  eq(invitationUid({ messageClass: "IPM.Schedule.Meeting.Request", meetingRequest: request({ uid: null }) }), null, "no UID");
  eq(invitationUid({ messageClass: "IPM.Schedule.Meeting.Canceled", meetingRequest: request() }), null, "a cancellation does not take the invitation's place");
  eq(invitationUid({ messageClass: "IPM.Schedule.Meeting.Resp.Pos", meetingRequest: request() }), null);
  eq(invitationUid({ messageClass: "IPM.Schedule.Meeting.Request", meetingRequest: request({ messageType: 6 }) }), null, "a delegate's copy is not answered");
  for (const odd of [null, undefined, 3, "x", {}, { meetingRequest: "oui" }]) eq(invitationUid(odd), null);
});

test("invitations: the start of a meeting request, in the form an event's start has (an instant, or the day of an all-day meeting)", () => {
  const PARIS = { bias: -60, standard: { bias: 0, change: { month: 10, week: 5, weekday: 0, hour: 3, minute: 0 } }, daylight: { bias: -60, change: { month: 3, week: 5, weekday: 0, hour: 2, minute: 0 } } };
  const TOKYO = { bias: -540, standard: { bias: 0, change: null }, daylight: { bias: 0, change: null } };
  const LIMA = { bias: 300, standard: { bias: 0, change: null }, daylight: { bias: 0, change: null } };
  eq(invitationStart({ start: "2026-12-01T09:00:00Z", allDay: false, zone: PARIS }), "2026-12-01T09:00:00Z");
  eq(invitationStart({ start: "2026-12-01T09:00:00Z", allDay: false, zone: null }), "2026-12-01T09:00:00Z");
  // All day: the day the instant is in, in the zone the request gives (midnight there is another day in UTC).
  eq(invitationStart({ start: "2026-12-23T23:00:00Z", allDay: true, zone: PARIS }), "2026-12-24", "winter: UTC+1");
  eq(invitationStart({ start: "2026-07-13T22:00:00Z", allDay: true, zone: PARIS }), "2026-07-14", "summer: UTC+2");
  eq(invitationStart({ start: "2026-12-23T15:00:00Z", allDay: true, zone: TOKYO }), "2026-12-24");
  eq(invitationStart({ start: "2026-12-24T05:00:00Z", allDay: true, zone: LIMA }), "2026-12-24");
  eq(invitationStart({ start: "2026-12-24T00:00:00Z", allDay: true, zone: null }), "2026-12-24", "no zone: the day in UTC");
  eq(invitationStart({ start: "2026-12-24T00:00:00Z", allDay: true }), "2026-12-24");
  // Nothing usable: no start (such a mail agrees with no event).
  for (const request of [null, undefined, {}, { start: null }, { start: "demain" }, { start: "2026-12-24" }, { start: 5 }, { start: "2026-02-30T09:00:00Z" }, { start: "2026-12-24T00:00:00Z", allDay: true, zone: { bias: "x" } }]) {
    eq(invitationStart(request), null, JSON.stringify(request));
  }
});

// ── Kept current by the mail engine ───────────────────────────────────────

/** GlobalObjId of a foreign UID ("vCal-Uid"), as [MS-ASEMAIL] 2.2.2.37 lays it out. */
function globalObjId(uid) {
  const data = [...encodeUtf8("vCal-Uid"), 1, 0, 0, 0, ...encodeUtf8(uid), 0];
  const head = [0x04, 0x00, 0x00, 0x00, 0x82, 0x00, 0xe0, 0x00, 0x74, 0xc5, 0xb7, 0x10, 0x1a, 0x82, 0xe0, 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return base64(Uint8Array.from([...head, data.length & 0xff, (data.length >> 8) & 0xff, 0, 0, ...data]));
}

/** The folders of the fake server, and one more where junk mail goes (an ordinary mail folder for the protocol). */
const JUNK = "9";
const FOLDERS = [...DEFAULT_FOLDERS, { id: JUNK, parentId: "0", name: "Courrier indésirable", type: 12 }];

/** A fake server whose mails may carry a MeetingRequest. */
class InvitingServer extends FakeServer {
  constructor() {
    super({ folders: FOLDERS });
    this.requests443 = new Map(); // ServerId → { uid, messageClass, messageType, organizer, start }
    const base = this.command.bind(this);
    this.command = async (cmd, root, opts) => {
      const doc = await base(cmd, root, opts);
      if (cmd !== "Sync" || !doc) return doc;
      // The answer as decoded: the MeetingRequest is added to the Adds of invitation mails.
      for (const coll of doc.children.find((c) => c.tag === "Collections")?.children ?? []) {
        for (const add of coll.children.find((c) => c.tag === "Commands")?.children ?? []) {
          const sid = add.children.find((c) => c.tag === "ServerId");
          const meta = sid ? this.requests443.get(new TextDecoderLite().decode(sid.value)) : null;
          const data = add.children.find((c) => c.tag === "ApplicationData");
          if (!meta || !data) continue;
          const extra = el("AirSync:ApplicationData", [
            meta.messageClass ? el("Email:MessageClass", meta.messageClass) : null,
            el("Email:MeetingRequest", [
              el("Email:GlobalObjId", globalObjId(meta.uid)),
              meta.start ? el("Email:StartTime", meta.start.replace("Z", ".000Z")) : null,
              meta.organizer ? el("Email:Organizer", meta.organizer) : null,
              meta.messageType === undefined ? null : el("Email2:MeetingMessageType", String(meta.messageType)),
            ]),
          ]);
          for (const node of extra.children) {
            node.ns ??= "Email";
            fixNamespaces(node);
            data.children.push(node);
          }
        }
      }
      return doc;
    };
  }
  addInvitation(cid, mid, uid, { messageClass = "IPM.Schedule.Meeting.Request", messageType, organizer = `"Chef" <${CHEF}>`, start = START } = {}) {
    const sid = this.addMessage(cid, mime(mid, "Invitation"));
    this.requests443.set(sid, { uid, messageClass, messageType, organizer, start });
    return sid;
  }
}

/** Decoded trees carry a namespace on every node: built ones get their parent's. */
function fixNamespaces(node) {
  for (const c of node.children) {
    c.ns ??= node.ns;
    fixNamespaces(c);
  }
}

class TextDecoderLite {
  decode(bytes) {
    return String.fromCharCode(...bytes);
  }
}

function mailWorld() {
  const server = new InvitingServer();
  const store = new FakeMailStore({ folders: [["/Inbox", ["inbox"]], ["/Trash", ["trash"]], ["/Inbox/Projets", []], ["/Drafts", ["drafts"]], ["/Sent", ["sent"]], ["/Courrier indésirable", []]] });
  const records = new Store(memoryArea()).mailbox(MB);
  const invitations = new InvitationTable({ records, now: () => 1_000_000 });
  const colls = new Map([
    ["1", new CollectionState("1", { path: "/Inbox" })],
    ["2", new CollectionState("2", { path: "/Drafts" })],
    ["3", new CollectionState("3", { path: "/Trash" })],
    ["4", new CollectionState("4", { path: "/Sent" })],
    ["6", new CollectionState("6", { path: "/Inbox/Projets" })],
    [JUNK, new CollectionState(JUNK, { path: "/Courrier indésirable" })],
  ]);
  const ctx = {
    client: server,
    records,
    mailStore: store,
    log: quietLog(),
    now: () => 1_000_000,
    signal: null,
    filterType: "0",
    trashPath: "/Trash",
    serverTrash: (cid) => cid === "3",
    serverTrashId: "3",
    collectionOf: (p) => [...colls.values()].find((c) => c.path === p) ?? null,
    invitations,
    pass: new MailPass(),
  };
  return { server, store, records, invitations, colls, ctx, inbox: colls.get("1"), newPass: () => (ctx.pass = new MailPass()) };
}

test("mail engine: the fake invitation is read as one by the mail codec", async () => {
  const w = mailWorld();
  w.server.addInvitation("1", "inv@x", "uid-réunion");
  await w.server.command("Sync", (await import("../../src/core/protocol.mjs")).syncRequest([{ collectionId: "1", syncKey: "0" }]));
  const doc = await w.server.command("Sync", (await import("../../src/core/protocol.mjs")).syncRequest([{ collectionId: "1", syncKey: "1", getChanges: true }]));
  const add = doc.children[0].children[0].children.find((c) => c.tag === "Commands").children[0];
  const email = readEmail(add.children.find((c) => c.tag === "ApplicationData"));
  eq([email.messageClass, email.meetingRequest.uid, email.meetingRequest.organizer, email.meetingRequest.start], ["IPM.Schedule.Meeting.Request", "uid-réunion", CHEF, START]);
});

test("mail engine: an invitation mail added is noted; ordinary mails, cancellations and delegates' copies are not", async () => {
  const w = mailWorld();
  const sid = w.server.addInvitation("1", "inv@x", "uid-1");
  w.server.addMessage("1", mime("plain@x"));
  w.server.addInvitation("1", "cancel@x", "uid-2", { messageClass: "IPM.Schedule.Meeting.Canceled" });
  w.server.addInvitation("1", "delegate@x", "uid-3", { messageType: 6 });
  await syncCollection(w.ctx, w.inbox);
  eq(w.store.mids("/Inbox").length, 4, "every mail is imported all the same");
  // Noted with what it says of its meeting, and the kind of its folder.
  eq(await w.invitations.candidates("uid-1"), [{ collectionId: "1", serverId: sid, at: 1_000_000, organizer: CHEF, start: START, kind: "inbox" }]);
  eq(await w.invitations.find("uid-1", EVENT), { collectionId: "1", serverId: sid, at: 1_000_000 });
  eq([await w.invitations.candidates("uid-2"), await w.invitations.candidates("uid-3")], [[], []]);
  eq(await w.invitations.size(), 1);
});

test("mail engine: invitation mails in Junk, Sent Items, Drafts and Deleted Items are imported, and never noted", async () => {
  const w = mailWorld();
  const real = w.server.addInvitation("1", "real@x", "uid-1");
  // The same UID in the folders where nobody is being asked anything: a forged invitation the server filed as
  // junk, the user's own copies, what was deleted. Each one gives another time for the meeting.
  for (const [cid, mid] of [[JUNK, "junk@x"], ["4", "sent@x"], ["2", "draft@x"], ["3", "deleted@x"]]) {
    w.server.addInvitation(cid, mid, "uid-1", { start: "2026-12-01T18:00:00Z", organizer: "eve@evil.example" });
  }
  for (const cid of ["1", JUNK, "4", "2", "3"]) await syncCollection(w.ctx, w.colls.get(cid));
  eq([w.store.mids("/Courrier indésirable"), w.store.mids("/Sent"), w.store.mids("/Drafts"), w.store.mids("/Trash")], [["junk@x"], ["sent@x"], ["draft@x"], ["deleted@x"]], "the mails themselves are there");
  eq((await w.invitations.candidates("uid-1")).map((m) => m.serverId), [real], "only the invitation of the inbox is a candidate");
  eq((await w.invitations.find("uid-1", EVENT)).serverId, real, "and it is the one named, whatever the others say");
  // A subfolder of the server's trash is the trash too (the engine says so, whatever the folder is called).
  w.colls.set("31", new CollectionState("31", { path: "/Projets archivés" }));
  w.server.folders.set("31", { parentId: "3", name: "Projets archivés", type: 12 });
  w.server.items.set("31", new Map());
  w.store.folders.set("/Projets archivés", { specialUse: [], msgs: new Map() });
  w.ctx.serverTrash = (cid) => cid === "3" || cid === "31";
  w.server.addInvitation("31", "deep@x", "uid-1", { start: "2026-12-01T18:00:00Z" });
  w.newPass();
  await syncCollection(w.ctx, w.colls.get("31"));
  eq(w.store.mids("/Projets archivés"), ["deep@x"]);
  eq(await w.invitations.size(), 1);
});

test("mail engine: a later invitation with the same UID does not replace the earlier one; a mail for another time is not named, and blocks nothing", async () => {
  const w = mailWorld();
  const first = w.server.addInvitation("1", "inv1@x", "uid-1");
  await syncCollection(w.ctx, w.inbox);
  // The organizer sends the invitation again, unchanged: both are known, the latest one is named.
  const second = w.server.addInvitation("1", "inv2@x", "uid-1");
  w.newPass();
  await syncCollection(w.ctx, w.inbox);
  eq((await w.invitations.candidates("uid-1")).map((m) => m.serverId), [first, second]);
  eq((await w.invitations.find("uid-1", EVENT)).serverId, second);
  // Someone who knows the UID sends a mail of their own for it, with another time: it is not the one named for the
  // event, and the event's invitation can still be answered.
  const forged = w.server.addInvitation("1", "forged@x", "uid-1", { start: "2026-12-01T18:00:00Z" });
  w.newPass();
  await syncCollection(w.ctx, w.inbox);
  eq((await w.invitations.candidates("uid-1")).map((m) => m.serverId), [first, second, forged]);
  eq((await w.invitations.find("uid-1", EVENT)).serverId, second);
  // The invitations for the event's own time gone from the server, nothing is named for it: never the other mail.
  w.server.deleteMessage("1", first);
  w.server.deleteMessage("1", second);
  w.newPass();
  await syncCollection(w.ctx, w.inbox);
  eq([await w.invitations.find("uid-1", EVENT), (await w.invitations.candidates("uid-1")).map((m) => m.serverId)], [null, [forged]]);
});

test("mail engine: an invitation the server deletes is forgotten; one that leaves the period is kept", async () => {
  const w = mailWorld();
  const gone = w.server.addInvitation("1", "gone@x", "uid-gone");
  const aged = w.server.addInvitation("1", "aged@x", "uid-aged");
  await syncCollection(w.ctx, w.inbox);
  eq(await w.invitations.size(), 2);
  w.server.deleteMessage("1", gone);
  w.server.softDelete("1", aged);
  w.newPass();
  await syncCollection(w.ctx, w.inbox);
  eq(await w.invitations.find("uid-gone", EVENT), null);
  eq((await w.invitations.find("uid-aged", EVENT)).serverId, aged, "still on the server: it can still be answered");
});

test("mail engine: an invitation the user deletes is forgotten once the server took the deletion", async () => {
  const w = mailWorld();
  const sid = w.server.addInvitation("1", "inv@x", "uid-1");
  await syncCollection(w.ctx, w.inbox);
  w.store.userDelete("/Inbox", "inv@x");
  w.newPass();
  const { syncBatch } = await import("../../src/sync/mail.mjs");
  await syncBatch(w.ctx, w.inbox, { uploads: [{ id: 1, op: "delete", path: "/Inbox", messageId: "inv@x" }] });
  eq(w.server.items.get("1").has(sid), false);
  eq([await w.invitations.find("uid-1", EVENT), await w.invitations.size()], [null, 0]);
});

test("mail engine: an invitation the user moves to another folder follows the mail", async () => {
  const w = mailWorld();
  w.server.addInvitation("1", "inv@x", "uid-1");
  await syncCollection(w.ctx, w.inbox);
  w.store.userMove("/Inbox", "inv@x", "/Inbox/Projets");
  w.newPass();
  w.colls.get("6").syncKey = "1";
  await replayMoves(w.ctx, [{ id: 1, op: "move", path: "/Inbox", toPath: "/Inbox/Projets", messageId: "inv@x" }], w.ctx.collectionOf);
  const found = await w.invitations.find("uid-1", EVENT);
  eq(found.collectionId, "6");
  assert(w.server.items.get("6").has(found.serverId), "the entry names the mail where it is now");
  eq((await w.invitations.candidates("uid-1")).map((m) => [m.collectionId, m.kind]), [["6", "inbox"]], "a folder of the inbox: still a place where invitations are answered");
});

test("mail engine: an invitation the user moves to Junk or to the trash is forgotten", async () => {
  for (const [cid, path] of [[JUNK, "/Courrier indésirable"], ["3", "/Trash"]]) {
    const w = mailWorld();
    w.server.addInvitation("1", "inv@x", "uid-1");
    await syncCollection(w.ctx, w.inbox);
    eq(await w.invitations.size(), 1);
    w.store.userMove("/Inbox", "inv@x", path);
    w.newPass();
    w.colls.get(cid).syncKey = "1";
    await replayMoves(w.ctx, [{ id: 1, op: "move", path: "/Inbox", toPath: path, messageId: "inv@x" }], w.ctx.collectionOf);
    eq(w.server.items.get(cid).size, 1, `moved on the server to ${path}`);
    eq([await w.invitations.size(), await w.invitations.find("uid-1", EVENT)], [0, null], path);
  }
});

test("mail engine: a collection rebuilt from scratch (Status 3) has its invitations noted again, the vanished ones forgotten", async () => {
  const w = mailWorld();
  const kept = w.server.addInvitation("1", "kept@x", "uid-kept");
  const lost = w.server.addInvitation("1", "lost@x", "uid-lost");
  w.server.addInvitation("6", "other@x", "uid-other");
  await syncCollection(w.ctx, w.inbox);
  await syncCollection(w.ctx, w.colls.get("6"));
  eq(await w.invitations.size(), 3);
  w.server.items.get("1").delete(lost); // gone while the key is lost: no Delete will ever say so
  w.server.invalidate("1");
  w.newPass();
  await syncCollection(w.ctx, w.inbox);
  eq(w.inbox.full, false, "rebuilt");
  eq((await w.invitations.find("uid-kept", EVENT)).serverId, kept);
  eq(await w.invitations.find("uid-lost", EVENT), null);
  eq((await w.invitations.find("uid-other", EVENT)).collectionId, "6", "the other collection is untouched");
});

test("mail engine: without ctx.invitations nothing changes (the table is optional)", async () => {
  const w = mailWorld();
  delete w.ctx.invitations;
  w.server.addInvitation("1", "inv@x", "uid-1");
  await syncCollection(w.ctx, w.inbox);
  eq(w.store.mids("/Inbox"), ["inv@x"]);
  eq(await w.invitations.size(), 0);
});
