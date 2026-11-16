// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/** Code page tests: structure of the tables, and spot checks against [MS-ASWBXML] 2.1.2.1. */

import { test, assert, eq } from "./harness.mjs";
import { pageOf, namespaceOf, tokenOf, tagOf } from "../../src/core/codepages.mjs";
import { el, encode, decode } from "../../src/core/wbxml.mjs";

// Every [page, namespace, tag, token] of the tables, read through the lookups:
// a page number and a token are one byte each, so every byte pair is tried.
const ALL = [];
for (let page = 0; page < 256; page++) {
  for (let token = 0; token < 256; token++) {
    const tag = tagOf(page, token);
    if (tag !== undefined) ALL.push([page, namespaceOf(page), tag, token]);
  }
}

test("codepages : chaque (page, jeton) et chaque (espace, balise) est unique", () => {
  const byToken = new Set();
  const byTag = new Set();
  for (const [page, ns, tag, token] of ALL) {
    const k1 = `${page}/${token}`;
    const k2 = `${ns}:${tag}`;
    assert(!byToken.has(k1), `jeton en double ${k1}`);
    assert(!byTag.has(k2), `balise en double ${k2}`);
    byToken.add(k1);
    byTag.add(k2);
  }
  assert(ALL.length > 400, `table complète attendue, ${ALL.length} balises seulement`);
});

test("codepages : une page par espace de noms, et réciproquement", () => {
  const pages = new Map();
  for (const [page, ns] of ALL) {
    if (pages.has(page)) eq(pages.get(page), ns, `page ${page}`);
    pages.set(page, ns);
  }
  const namespaces = new Set(pages.values());
  eq(namespaces.size, pages.size, "espaces de noms distincts");
  for (const [page, ns] of pages) {
    eq(pageOf(ns), page, `pageOf(${ns})`);
    eq(namespaceOf(page), ns, `namespaceOf(${page})`);
  }
});

test("codepages : jetons dans 0x05..0x3F, pages dans 0..24", () => {
  for (const [page, ns, tag, token] of ALL) {
    assert(Number.isInteger(token) && token >= 0x05 && token <= 0x3f, `jeton hors plage ${ns}:${tag} = ${token}`);
    assert(Number.isInteger(page) && page >= 0 && page <= 24, `page hors plage ${ns} = ${page}`);
    assert(/^[A-Za-z][A-Za-z0-9]*$/.test(tag), `nom de balise suspect ${ns}:${tag}`);
  }
});

test("codepages : tokenOf et tagOf sont réciproques pour toutes les balises", () => {
  for (const [page, ns, tag, token] of ALL) {
    eq(tokenOf(ns, tag), token, `tokenOf(${ns}, ${tag})`);
    eq(tagOf(page, token), tag, `tagOf(${page}, ${token})`);
  }
});

test("codepages : pages 3 (AirNotify) et 25 (Find) absentes, inconnus → undefined", () => {
  eq(namespaceOf(3), undefined, "page 3");
  eq(namespaceOf(25), undefined, "page 25");
  eq(namespaceOf(255), undefined, "page 255");
  eq(pageOf("AirNotify"), undefined);
  eq(pageOf("Find"), undefined);
  eq(pageOf("Inconnu"), undefined);
  eq(tokenOf("AirSync", "Inconnu"), undefined);
  eq(tokenOf("Inconnu", "Sync"), undefined);
  eq(tagOf(0, 0x11), undefined, "AirSync 0x11 (Version, retiré)");
  eq(tagOf(0, 0x04), undefined, "jeton global");
  eq(tagOf(0, 0x40), undefined, "jeton avec le bit de contenu");
  eq(tagOf(99, 0x05), undefined, "page inconnue");
  // Lookups are case-sensitive and do not see Object.prototype.
  eq(tokenOf("airsync", "Sync"), undefined, "casse de l'espace de noms");
  eq(tokenOf("AirSync", "sync"), undefined, "casse de la balise");
  eq(tokenOf("AirSync", "constructor"), undefined);
  eq(pageOf("toString"), undefined);
});

test("codepages : valeurs de référence de [MS-ASWBXML]", () => {
  const known = [
    ["AirSync", 0, "Sync", 0x05], ["AirSync", 0, "SyncKey", 0x0b], ["AirSync", 0, "Status", 0x0e],
    ["AirSync", 0, "Collections", 0x1c], ["AirSync", 0, "ApplicationData", 0x1d], ["AirSync", 0, "WindowSize", 0x15],
    ["AirSync", 0, "HeartbeatInterval", 0x29], ["AirSync", 0, "SoftDelete", 0x21],
    ["Contacts", 1, "Anniversary", 0x05], ["Contacts", 1, "Email1Address", 0x1b], ["Contacts", 1, "WeightedRank", 0x3e],
    ["Email", 2, "DateReceived", 0x0f], ["Email", 2, "Subject", 0x14], ["Email", 2, "Status", 0x3b],
    ["Email", 2, "DisallowNewTimeProposal", 0x3f],
    ["Calendar", 4, "Timezone", 0x05], ["Calendar", 4, "UID", 0x28], ["Calendar", 4, "ClientUid", 0x3c],
    ["Move", 5, "MoveItems", 0x05], ["Move", 5, "DstMsgId", 0x0c],
    ["GetItemEstimate", 6, "Estimate", 0x0c],
    ["FolderHierarchy", 7, "DisplayName", 0x07], ["FolderHierarchy", 7, "FolderSync", 0x16], ["FolderHierarchy", 7, "Count", 0x17],
    ["MeetingResponse", 8, "UserResponse", 0x0c], ["MeetingResponse", 8, "SendResponse", 0x12],
    ["Tasks", 9, "Categories", 0x08], ["Tasks", 9, "FirstDayOfWeek", 0x26],
    ["ResolveRecipients", 10, "ResolveRecipients", 0x05], ["ValidateCert", 11, "Status", 0x0a],
    ["Contacts2", 12, "MMS", 0x0e],
    ["Ping", 13, "Ping", 0x05], ["Ping", 13, "Folder", 0x0a], ["Ping", 13, "MaxFolders", 0x0d],
    ["Provision", 14, "Provision", 0x05], ["Provision", 14, "PolicyKey", 0x09], ["Provision", 14, "RemoteWipe", 0x0c],
    ["Provision", 14, "AccountOnlyRemoteWipe", 0x3b],
    ["Search", 15, "Store", 0x07], ["Search", 15, "MaxPictures", 0x23],
    ["GAL", 16, "DisplayName", 0x05], ["GAL", 16, "Data", 0x12],
    ["AirSyncBase", 17, "BodyPreference", 0x05], ["AirSyncBase", 17, "Body", 0x0a], ["AirSyncBase", 17, "InstanceId", 0x2d],
    ["Settings", 18, "Settings", 0x05], ["Settings", 18, "DeviceInformation", 0x16], ["Settings", 18, "UserAgent", 0x20],
    ["Settings", 18, "PrimarySmtpAddress", 0x23], ["Settings", 18, "RightsManagementInformation", 0x2b],
    ["DocumentLibrary", 19, "LinkId", 0x05], ["ItemOperations", 20, "ItemOperations", 0x05], ["ItemOperations", 20, "MoveAlways", 0x19],
    ["ComposeMail", 21, "SendMail", 0x05], ["ComposeMail", 21, "Mime", 0x10], ["ComposeMail", 21, "ForwardeeEmail", 0x18],
    ["Email2", 22, "UmCallerID", 0x05], ["Email2", 22, "Send", 0x17],
    ["Notes", 23, "Subject", 0x05], ["Notes", 23, "Category", 0x09],
    ["RightsManagement", 24, "RightsManagementSupport", 0x05], ["RightsManagement", 24, "RemoveRightsManagementProtection", 0x18],
  ];
  for (const [ns, page, tag, token] of known) {
    eq(pageOf(ns), page, `page de ${ns}`);
    eq(tokenOf(ns, tag), token, `jeton de ${ns}:${tag}`);
    eq(tagOf(page, token), tag, `balise ${page}/0x${token.toString(16)}`);
  }
});

test("codepages : chaque balise passe par encode puis decode", () => {
  for (const [page, ns, tag] of ALL) {
    const one = decode(encode(el(`${ns}:${tag}`, "v")));
    eq([one.ns, one.tag], [ns, tag], `${ns}:${tag} (page ${page})`);
    const empty = decode(encode(el(`${ns}:${tag}`)));
    eq([empty.ns, empty.tag, empty.value], [ns, tag, null], `${ns}:${tag} vide`);
  }
});

test("codepages : un document contenant toutes les balises (changements de page)", () => {
  const children = ALL.map(([, ns, tag], i) => el(`${ns}:${tag}`, i % 3 ? String(i) : undefined));
  const root = el("AirSync:Sync", children);
  const back = decode(encode(root));
  eq(back.children.length, ALL.length, "nombre d'enfants");
  back.children.forEach((c, i) => {
    const [, ns, tag] = ALL[i];
    eq([c.ns, c.tag], [ns, tag], `enfant ${i}`);
  });
});

// ── Calendar, tasks and meetings (stage 4) ────────────────────────────────

/**
 * The pages the calendar, task and meeting code relies on, copied whole
 * from [MS-ASWBXML] 2.1.2.1.3, .5, .9, .10, .18 and .23. Tags that only
 * protocol version 2.5 defines are left out, as in the tables themselves.
 */
const STAGE4_PAGES = [
  [2, "Email", {
    0x0f: "DateReceived", 0x11: "DisplayTo", 0x12: "Importance", 0x13: "MessageClass", 0x14: "Subject", 0x15: "Read",
    0x16: "To", 0x17: "Cc", 0x18: "From", 0x19: "ReplyTo", 0x1a: "AllDayEvent", 0x1b: "Categories", 0x1c: "Category",
    0x1d: "DtStamp", 0x1e: "EndTime", 0x1f: "InstanceType", 0x20: "BusyStatus", 0x21: "Location",
    0x22: "MeetingRequest", 0x23: "Organizer", 0x24: "RecurrenceId", 0x25: "Reminder", 0x26: "ResponseRequested",
    0x27: "Recurrences", 0x28: "Recurrence", 0x29: "Type", 0x2a: "Until", 0x2b: "Occurrences", 0x2c: "Interval",
    0x2d: "DayOfWeek", 0x2e: "DayOfMonth", 0x2f: "WeekOfMonth", 0x30: "MonthOfYear", 0x31: "StartTime",
    0x32: "Sensitivity", 0x33: "TimeZone", 0x34: "GlobalObjId", 0x35: "ThreadTopic", 0x39: "InternetCPID",
    0x3a: "Flag", 0x3b: "Status", 0x3c: "ContentClass", 0x3d: "FlagType", 0x3e: "CompleteTime",
    0x3f: "DisallowNewTimeProposal",
  }],
  [4, "Calendar", {
    0x05: "Timezone", 0x06: "AllDayEvent", 0x07: "Attendees", 0x08: "Attendee", 0x09: "Email", 0x0a: "Name",
    0x0d: "BusyStatus", 0x0e: "Categories", 0x0f: "Category", 0x11: "DtStamp", 0x12: "EndTime", 0x13: "Exception",
    0x14: "Exceptions", 0x15: "Deleted", 0x16: "ExceptionStartTime", 0x17: "Location", 0x18: "MeetingStatus",
    0x19: "OrganizerEmail", 0x1a: "OrganizerName", 0x1b: "Recurrence", 0x1c: "Type", 0x1d: "Until",
    0x1e: "Occurrences", 0x1f: "Interval", 0x20: "DayOfWeek", 0x21: "DayOfMonth", 0x22: "WeekOfMonth",
    0x23: "MonthOfYear", 0x24: "Reminder", 0x25: "Sensitivity", 0x26: "Subject", 0x27: "StartTime", 0x28: "UID",
    0x29: "AttendeeStatus", 0x2a: "AttendeeType", 0x33: "DisallowNewTimeProposal", 0x34: "ResponseRequested",
    0x35: "AppointmentReplyTime", 0x36: "ResponseType", 0x37: "CalendarType", 0x38: "IsLeapMonth",
    0x39: "FirstDayOfWeek", 0x3a: "OnlineMeetingConfLink", 0x3b: "OnlineMeetingExternalLink", 0x3c: "ClientUid",
  }],
  [8, "MeetingResponse", {
    0x05: "CalendarId", 0x06: "CollectionId", 0x07: "MeetingResponse", 0x08: "RequestId", 0x09: "Request",
    0x0a: "Result", 0x0b: "Status", 0x0c: "UserResponse", 0x0e: "InstanceId", 0x10: "ProposedStartTime",
    0x11: "ProposedEndTime", 0x12: "SendResponse",
  }],
  [9, "Tasks", {
    0x08: "Categories", 0x09: "Category", 0x0a: "Complete", 0x0b: "DateCompleted", 0x0c: "DueDate",
    0x0d: "UtcDueDate", 0x0e: "Importance", 0x0f: "Recurrence", 0x10: "Type", 0x11: "Start", 0x12: "Until",
    0x13: "Occurrences", 0x14: "Interval", 0x15: "DayOfMonth", 0x16: "DayOfWeek", 0x17: "WeekOfMonth",
    0x18: "MonthOfYear", 0x19: "Regenerate", 0x1a: "DeadOccur", 0x1b: "ReminderSet", 0x1c: "ReminderTime",
    0x1d: "Sensitivity", 0x1e: "StartDate", 0x1f: "UtcStartDate", 0x20: "Subject", 0x22: "OrdinalDate",
    0x23: "SubOrdinalDate", 0x24: "CalendarType", 0x25: "IsLeapMonth", 0x26: "FirstDayOfWeek",
  }],
  [17, "AirSyncBase", {
    0x05: "BodyPreference", 0x06: "Type", 0x07: "TruncationSize", 0x08: "AllOrNone", 0x0a: "Body", 0x0b: "Data",
    0x0c: "EstimatedDataSize", 0x0d: "Truncated", 0x0e: "Attachments", 0x0f: "Attachment", 0x10: "DisplayName",
    0x11: "FileReference", 0x12: "Method", 0x13: "ContentId", 0x14: "ContentLocation", 0x15: "IsInline",
    0x16: "NativeBodyType", 0x17: "ContentType", 0x18: "Preview", 0x19: "BodyPartPreference", 0x1a: "BodyPart",
    0x1b: "Status", 0x1c: "Add", 0x1d: "Delete", 0x1e: "ClientId", 0x1f: "Content", 0x20: "Location",
    0x21: "Annotation", 0x22: "Street", 0x23: "City", 0x24: "State", 0x25: "Country", 0x26: "PostalCode",
    0x27: "Latitude", 0x28: "Longitude", 0x29: "Accuracy", 0x2a: "Altitude", 0x2b: "AltitudeAccuracy",
    0x2c: "LocationUri", 0x2d: "InstanceId",
  }],
  [22, "Email2", {
    0x05: "UmCallerID", 0x06: "UmUserNotes", 0x07: "UmAttDuration", 0x08: "UmAttOrder", 0x09: "ConversationId",
    0x0a: "ConversationIndex", 0x0b: "LastVerbExecuted", 0x0c: "LastVerbExecutionTime", 0x0d: "ReceivedAsBcc",
    0x0e: "Sender", 0x0f: "CalendarType", 0x10: "IsLeapMonth", 0x11: "AccountId", 0x12: "FirstDayOfWeek",
    0x13: "MeetingMessageType", 0x15: "IsDraft", 0x16: "Bcc", 0x17: "Send",
  }],
];

test("codepages: pages 2, 4, 8, 9, 17 and 22 hold exactly the tags of [MS-ASWBXML]", () => {
  for (const [page, ns, tags] of STAGE4_PAGES) {
    eq(namespaceOf(page), ns, `page ${page}`);
    for (let token = 0; token < 256; token++) {
      eq(tagOf(page, token), tags[token], `${ns} 0x${token.toString(16)}`);
      if (tags[token] !== undefined) eq(tokenOf(ns, tags[token]), token, `${ns}:${tags[token]}`);
    }
  }
});

test("codepages: the calendar page says Timezone, the e-mail page TimeZone", () => {
  eq(tokenOf("Calendar", "Timezone"), 0x05);
  eq(tokenOf("Calendar", "TimeZone"), undefined, "not the spelling of page 4");
  eq(tokenOf("Email", "TimeZone"), 0x33);
  eq(tokenOf("Email", "Timezone"), undefined, "not the spelling of page 2");
  // The same names live on several pages, each with its own token.
  eq([tokenOf("Email", "Recurrence"), tokenOf("Calendar", "Recurrence"), tokenOf("Tasks", "Recurrence")], [0x28, 0x1b, 0x0f]);
  eq([tokenOf("Email", "Type"), tokenOf("Calendar", "Type"), tokenOf("Tasks", "Type"), tokenOf("AirSyncBase", "Type")], [0x29, 0x1c, 0x10, 0x06]);
  eq([tokenOf("Calendar", "CalendarType"), tokenOf("Tasks", "CalendarType"), tokenOf("Email2", "CalendarType")], [0x37, 0x24, 0x0f]);
  eq([tokenOf("Calendar", "FirstDayOfWeek"), tokenOf("Tasks", "FirstDayOfWeek"), tokenOf("Email2", "FirstDayOfWeek")], [0x39, 0x26, 0x12]);
});
