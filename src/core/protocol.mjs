// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * ActiveSync commands ([MS-ASCMD], [MS-ASPROV]): building requests from
 * checked values, and reading responses into plain, validated objects.
 *
 * Readers never hand raw server strings to the rest of the extension:
 * ids, keys and statuses go through sanitize.mjs, names are cleaned, and
 * an entry that cannot be validated is left out (FolderSync counts them in
 * `rejected`, for the log).
 * Only ApplicationData (the content of an item) stays an element tree, for
 * the codecs of each item type, which validate it in turn.
 */

import { el, text, at, child } from "./wbxml.mjs";
import { tokenOf } from "./codepages.mjs";
import * as v from "./sanitize.mjs";

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Most items a single Sync response may carry for one collection; more means a broken or hostile server. */
export const MAX_COMMANDS_PER_COLLECTION = 2000;
export const MAX_FOLDERS = 5000;
/** Most collections one Sync response may carry (the client never asks for more than a few). */
const MAX_COLLECTIONS = 100;
/** Most meeting requests answered by one MeetingResponse command, and most results read from its response. */
export const MAX_MEETING_RESPONSES = 100;
/** Most element names in the Supported list of a collection: more than any class has properties. */
export const MAX_SUPPORTED = 128;
export const PING_CLASSES = new Set(["Email", "Calendar", "Contacts", "Tasks", "Notes"]);

/** Tags whose values the debug log may show: technical values only, never content. */
export const DEBUG_SHOWN = new Set([
  "Status", "SyncKey", "CollectionId", "ServerId", "ClientId", "ParentId", "Type", "Class", "FilterType",
  "WindowSize", "MIMESupport", "TruncationSize", "DeletesAsMoves", "HeartbeatInterval", "Id", "MaxFolders",
  "PolicyType", "SrcMsgId", "SrcFldId", "DstFldId", "DstMsgId", "Count", "Read", "Importance",
  "MessageClass", "InstanceType", "BusyStatus", "Sensitivity", "AllDayEvent", "MeetingStatus",
  "ResponseType", "Estimate", "Conflict", "ConversationMode", "NativeBodyType", "EstimatedDataSize",
  "Truncated", "RequestId", "CalendarId", "UserResponse",
]);

const need = (value, check, what) => {
  const ok = check(value);
  if (ok === null) throw new ProtocolError(`${what} invalide`);
  return ok;
};

/**
 * A folder name is sent exactly as given, or refused: never silently
 * rewritten, so the names in Thunderbird and on the server cannot diverge.
 */
function exactFolderName(name) {
  const checked = v.folderName(name);
  if (checked === null || checked !== name) throw new ProtocolError("nom de dossier refusé (caractères non autorisés, espaces en bord ou trop long)");
  return name;
}

function expectRoot(doc, ns, tag) {
  if (!doc || doc.ns !== ns || doc.tag !== tag) throw new ProtocolError(`réponse inattendue (${doc?.ns}:${doc?.tag})`);
}

/** Status directly under the root element (command-level status), or null. */
export function topStatus(doc) {
  const node = doc?.children.find((c) => c.tag === "Status");
  return node ? v.status(text(node)) : null;
}

// ── FolderSync ────────────────────────────────────────────────────────────

export function folderSyncRequest(syncKey) {
  return el("FolderHierarchy:FolderSync", [el("SyncKey", need(syncKey, v.syncKey, "SyncKey"))]);
}

/**
 * → { status, syncKey, changes: [{op: "add"|"update"|"delete", serverId, parentId, displayName, type}], rejected }
 * Each entry is valid on its own; the tree they form (unknown parents,
 * cycles, duplicates) is checked by the caller that builds the hierarchy.
 */
export function parseFolderSync(doc) {
  expectRoot(doc, "FolderHierarchy", "FolderSync");
  const changes = [];
  let rejected = 0;
  for (const node of child(doc, "Changes")?.children ?? []) {
    const op = { Add: "add", Update: "update", Delete: "delete" }[node.tag];
    if (!op) continue; // Count, or unknown
    if (changes.length >= MAX_FOLDERS) {
      rejected++;
      continue;
    }
    const serverId = v.itemId(text(node, "ServerId"));
    if (!serverId) {
      rejected++;
      continue;
    }
    if (op === "delete") {
      changes.push({ op, serverId });
      continue;
    }
    const parentId = v.itemId(text(node, "ParentId"));
    const displayName = v.folderName(text(node, "DisplayName"));
    const type = v.integer(text(node, "Type"), { min: 1, max: 19 });
    if (!parentId || !displayName || type === null || parentId === serverId) {
      rejected++;
      continue;
    }
    changes.push({ op, serverId, parentId, displayName, type });
  }
  return { status: v.status(text(doc, "Status")), syncKey: v.syncKey(text(doc, "SyncKey")), changes, rejected };
}

// ── FolderCreate / FolderUpdate / FolderDelete ───────────────────────────

export function folderCreateRequest(syncKey, parentId, displayName, type = 12) {
  return el("FolderHierarchy:FolderCreate", [
    el("SyncKey", need(syncKey, v.syncKey, "SyncKey")),
    el("ParentId", need(parentId, v.itemId, "ParentId")),
    el("DisplayName", exactFolderName(displayName)),
    el("Type", String(need(String(type), (t) => v.integer(t, { min: 1, max: 19 }), "type de dossier"))),
  ]);
}

export function folderUpdateRequest(syncKey, serverId, parentId, displayName) {
  return el("FolderHierarchy:FolderUpdate", [
    el("SyncKey", need(syncKey, v.syncKey, "SyncKey")),
    el("ServerId", need(serverId, v.itemId, "ServerId")),
    el("ParentId", need(parentId, v.itemId, "ParentId")),
    el("DisplayName", exactFolderName(displayName)),
  ]);
}

export function folderDeleteRequest(syncKey, serverId) {
  return el("FolderHierarchy:FolderDelete", [
    el("SyncKey", need(syncKey, v.syncKey, "SyncKey")),
    el("ServerId", need(serverId, v.itemId, "ServerId")),
  ]);
}

/** FolderCreate / FolderUpdate / FolderDelete → { status, syncKey, serverId } (serverId only for create). */
export function parseFolderChange(doc) {
  if (!doc || doc.ns !== "FolderHierarchy" || !["FolderCreate", "FolderUpdate", "FolderDelete"].includes(doc.tag)) {
    throw new ProtocolError(`réponse inattendue (${doc?.ns}:${doc?.tag})`);
  }
  return {
    status: v.status(text(doc, "Status")),
    syncKey: v.syncKey(text(doc, "SyncKey")),
    serverId: doc.tag === "FolderCreate" ? v.itemId(text(doc, "ServerId")) : null,
  };
}

// ── Sync ──────────────────────────────────────────────────────────────────

/**
 * The Supported element of a collection ([MS-ASCMD] 2.2.3.179): one empty
 * element per property the client manages. `names` are element names with
 * their namespace ("Calendar:Subject"), each one known to the code pages
 * and given once. An empty list gives an empty Supported element, which
 * the server reads as "every property that can be ghosted is ghosted".
 */
function supportedElement(names) {
  if (!Array.isArray(names) || names.length > MAX_SUPPORTED) throw new ProtocolError("liste Supported invalide");
  const seen = new Set();
  return el(
    "Supported",
    names.map((name) => {
      const colon = typeof name === "string" ? name.indexOf(":") : -1;
      if (colon < 1 || seen.has(name) || tokenOf(name.slice(0, colon), name.slice(colon + 1)) === undefined) {
        throw new ProtocolError("élément Supported invalide");
      }
      seen.add(name);
      return el(name);
    }),
  );
}

/**
 * collections: [{ collectionId, syncKey, supported?: string[], deletesAsMoves?, getChanges?, windowSize?,
 *                 options?: Element[], commands?: Element[] }]
 * Element order follows [MS-ASCMD] 2.2.3.29.2 (SyncKey, CollectionId, Supported, DeletesAsMoves, GetChanges,
 * WindowSize, Options, Commands): the server enforces it.
 * `supported` (element names with their namespace, see supportedElement) is checked on every call, and sent
 * only with SyncKey "0": the server keeps the list of the first Sync and ignores any later one.
 */
export function syncRequest(collections) {
  return el("AirSync:Sync", [
    el(
      "Collections",
      collections.map((c) => {
        const key = need(c.syncKey, v.syncKey, "SyncKey");
        const supported = c.supported === undefined || c.supported === null ? null : supportedElement(c.supported);
        return el("Collection", [
          el("SyncKey", key),
          el("CollectionId", need(c.collectionId, v.itemId, "CollectionId")),
          key === "0" ? supported : null,
          c.deletesAsMoves === undefined ? null : el("DeletesAsMoves", c.deletesAsMoves ? "1" : "0"),
          c.getChanges && key !== "0" ? el("GetChanges") : null,
          // Math.trunc, not "| 0": 2^32 + 5 must clamp to 512, not wrap around to 5.
          c.windowSize ? el("WindowSize", String(Math.max(1, Math.min(512, Math.trunc(c.windowSize) || 1)))) : null,
          c.options?.length ? el("Options", c.options) : null,
          c.commands?.length && key !== "0" ? el("Commands", c.commands) : null,
        ]);
      }),
    ),
  ]);
}

export const changeCommand = (serverId, data) =>
  el("Change", [el("ServerId", need(serverId, v.itemId, "ServerId")), el("ApplicationData", data)]);
export const deleteCommand = (serverId) => el("Delete", [el("ServerId", need(serverId, v.itemId, "ServerId"))]);
export const fetchCommand = (serverId) => el("Fetch", [el("ServerId", need(serverId, v.itemId, "ServerId"))]);

/**
 * ClientId of an Add: the temporary id the client gives a new item, which
 * the server sends back with the ServerId it assigned ([MS-ASCMD] 2.2.3.7.2,
 * 2.2.3.28.2). Kept to 1 to 64 letters, digits and hyphens, the only form
 * this client writes: anything else in a response is not an answer to it.
 */
const CLIENT_ID = /^[A-Za-z0-9-]{1,64}$/;
const clientIdOf = (value) => (typeof value === "string" && CLIENT_ID.test(value) ? value : null);

/** A new item sent to the server (calendar, tasks; never e-mail). `data`: ApplicationData children. */
export const addCommand = (clientId, data) =>
  el("Add", [el("ClientId", need(clientId, clientIdOf, "ClientId")), el("ApplicationData", data)]);

const COMMANDS = { Add: "add", Change: "change", Delete: "delete", SoftDelete: "softdelete" };
// Answers handed over with their ApplicationData (the mail engine reads these two).
const RESPONSES = { Change: "change", Fetch: "fetch" };

/**
 * → { status, collections: [{ collectionId, syncKey, status, moreAvailable,
 *      commands: [{op, serverId, data}], responses: [{op: "change"|"fetch", serverId, status, data}],
 *      clientResponses: { adds: [{clientId, serverId, status}], changes: [{serverId, status}],
 *                         deletes: [{serverId, status}] } }] }
 * `status` is the command-level status (null when the response is normal).
 *
 * `clientResponses` holds what the server says about the client's own
 * commands ([MS-ASCMD] 2.2.3.154): it answers every successful Add, and a
 * Change or a Delete only when it failed; no answer means success.
 *  - adds: `serverId` is the id given to the new item, or null when the
 *    server gave none or an invalid one (a refused Add: see `status`). An
 *    answer without a valid ClientId or Status is left out. Two answers for
 *    one ClientId, or two ClientIds bound to one ServerId, make the whole
 *    response invalid (ProtocolError): which local item is which server item
 *    is never guessed;
 *  - changes, deletes: answers with a valid ServerId and Status.
 */
export function parseSync(doc) {
  expectRoot(doc, "AirSync", "Sync");
  const collections = [];
  const list = (child(doc, "Collections")?.children ?? []).filter((c) => c.tag === "Collection");
  if (list.length > MAX_COLLECTIONS) throw new ProtocolError(`réponse anormale : ${list.length} dossiers`);
  const seen = new Set();
  for (const c of list) {
    const collectionId = v.itemId(text(c, "CollectionId"));
    if (!collectionId) continue;
    if (seen.has(collectionId)) throw new ProtocolError("réponse anormale : un dossier apparaît deux fois");
    seen.add(collectionId);
    const commands = [];
    const responses = [];
    const list = child(c, "Commands")?.children ?? [];
    if (list.length > MAX_COMMANDS_PER_COLLECTION) {
      throw new ProtocolError(`réponse anormale : ${list.length} éléments pour un seul dossier`);
    }
    for (const cmd of list) {
      const op = COMMANDS[cmd.tag];
      if (!op) continue;
      const serverId = v.itemId(text(cmd, "ServerId"));
      if (!serverId) continue;
      commands.push({ op, serverId, data: child(cmd, "ApplicationData") });
    }
    const answers = child(c, "Responses")?.children ?? [];
    if (answers.length > MAX_COMMANDS_PER_COLLECTION) {
      throw new ProtocolError(`réponse anormale : ${answers.length} réponses pour un seul dossier`);
    }
    const clientResponses = { adds: [], changes: [], deletes: [] };
    const addedClientIds = new Set();
    const addedServerIds = new Set();
    for (const r of answers) {
      const status = v.status(text(r, "Status"));
      const serverId = v.itemId(text(r, "ServerId"));
      if (r.tag === "Add") {
        const clientId = clientIdOf(text(r, "ClientId"));
        if (!status || !clientId) continue;
        if (addedClientIds.has(clientId) || (serverId && addedServerIds.has(serverId))) {
          throw new ProtocolError("réponse anormale : deux réponses pour un même ajout");
        }
        addedClientIds.add(clientId);
        if (serverId) addedServerIds.add(serverId);
        clientResponses.adds.push({ clientId, serverId, status });
        continue;
      }
      if (!status || !serverId) continue;
      if (r.tag === "Change") clientResponses.changes.push({ serverId, status });
      else if (r.tag === "Delete") clientResponses.deletes.push({ serverId, status });
      const op = RESPONSES[r.tag];
      if (op) responses.push({ op, serverId, status, data: child(r, "ApplicationData") });
    }
    collections.push({
      collectionId,
      syncKey: v.syncKey(text(c, "SyncKey")),
      status: v.status(text(c, "Status")),
      moreAvailable: Boolean(child(c, "MoreAvailable")),
      commands,
      responses,
      clientResponses,
    });
  }
  return { status: topStatus(doc), collections };
}

// ── Ping ──────────────────────────────────────────────────────────────────

/** folders: [{ id, cls }] with cls one of PING_CLASSES. */
export function pingRequest(heartbeatSeconds, folders) {
  const hb = need(String(heartbeatSeconds), (s) => v.integer(s, { min: 60, max: 3540 }), "intervalle");
  return el("Ping:Ping", [
    el("HeartbeatInterval", String(hb)),
    el(
      "Folders",
      folders.map((f) => {
        if (!PING_CLASSES.has(f.cls)) throw new ProtocolError(`classe de dossier invalide : ${f.cls}`);
        return el("Folder", [el("Id", need(f.id, v.itemId, "Id")), el("Class", f.cls)]);
      }),
    ),
  ]);
}

/** → { status, folders: [id], heartbeat: seconds|null (status 5), maxFolders: n|null (status 6) } */
export function parsePing(doc) {
  expectRoot(doc, "Ping", "Ping");
  const folders = (child(doc, "Folders")?.children ?? []).filter((f) => f.tag === "Folder");
  if (folders.length > MAX_FOLDERS) throw new ProtocolError(`réponse anormale : ${folders.length} dossiers signalés`);
  return {
    status: v.status(text(doc, "Status")),
    folders: [...new Set(folders.map((f) => v.itemId(text(f))).filter(Boolean))],
    heartbeat: v.integer(text(doc, "HeartbeatInterval"), { min: 1, max: 3540 }),
    maxFolders: v.integer(text(doc, "MaxFolders"), { min: 1, max: 10000 }),
  };
}

// ── MoveItems ─────────────────────────────────────────────────────────────

/** moves: [{ serverId, from, to }]. The server answers by SrcMsgId only, so ids must be unique in a request. */
export function moveItemsRequest(moves) {
  const seen = new Set();
  return el(
    "Move:MoveItems",
    moves.map((m) => {
      const id = need(m.serverId, v.itemId, "SrcMsgId");
      if (seen.has(id)) throw new ProtocolError("deux déplacements du même élément dans une requête");
      seen.add(id);
      return el("Move", [
        el("SrcMsgId", id),
        el("SrcFldId", need(m.from, v.itemId, "SrcFldId")),
        el("DstFldId", need(m.to, v.itemId, "DstFldId")),
      ]);
    }),
  );
}

/** → [{ srcMsgId, status, dstMsgId }] */
export function parseMoveItems(doc) {
  expectRoot(doc, "Move", "MoveItems");
  const answers = doc.children.filter((r) => r.tag === "Response");
  if (answers.length > MAX_COMMANDS_PER_COLLECTION) throw new ProtocolError(`réponse anormale : ${answers.length} réponses`);
  return answers
    .map((r) => ({
      srcMsgId: v.itemId(text(r, "SrcMsgId")),
      status: v.status(text(r, "Status")),
      dstMsgId: v.itemId(text(r, "DstMsgId")),
    }))
    .filter((r) => r.srcMsgId && r.status); // an answer we cannot match to a request is ignored
}

// ── MeetingResponse ───────────────────────────────────────────────────────

/** UserResponse values ([MS-ASCMD] 2.2.3.194): 1 accepted, 2 tentatively accepted, 3 declined. */
const USER_RESPONSES = new Set([1, 2, 3]);
const INSTANCE_ID = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.000)?Z$/;

/**
 * InstanceId of a MeetingResponse request ([MS-ASCMD] 2.2.3.92.1): the
 * original UTC start of one occurrence, written with separators and
 * milliseconds, 24 characters ("2010-04-08T18:16:00.000Z"). Accepted as
 * that, or as a UTC date of the item descriptions ("2010-04-08T18:16:00Z");
 * it must be a real date.
 */
function instanceIdOf(value) {
  const m = typeof value === "string" ? INSTANCE_ID.exec(value) : null;
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 1900 || year > 2200 || hour > 23 || minute > 59 || second > 59) return null;
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

/**
 * requests: [{ userResponse: 1|2|3, collectionId, requestId, instanceId? }], 1 to MAX_MEETING_RESPONSES.
 * `collectionId` and `requestId` name the invitation mail, or the calendar
 * item (14.1 only). `instanceId` answers one occurrence of a series; it only
 * exists in 14.1 (an older server refuses the request): the caller decides.
 * The server answers by RequestId alone, so a RequestId may appear once.
 */
export function meetingResponseRequest(requests) {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > MAX_MEETING_RESPONSES) {
    throw new ProtocolError("nombre de réponses à des invitations invalide");
  }
  const seen = new Set();
  return el(
    "MeetingResponse:MeetingResponse",
    requests.map((r) => {
      if (!USER_RESPONSES.has(r?.userResponse)) throw new ProtocolError("UserResponse invalide");
      const collectionId = need(r.collectionId, v.itemId, "CollectionId");
      const requestId = need(r.requestId, v.itemId, "RequestId");
      if (seen.has(requestId)) throw new ProtocolError("deux réponses à la même invitation dans une requête");
      seen.add(requestId);
      const instanceId = r.instanceId === undefined || r.instanceId === null ? null : need(r.instanceId, instanceIdOf, "InstanceId");
      return el("Request", [
        el("UserResponse", String(r.userResponse)),
        el("CollectionId", collectionId),
        el("RequestId", requestId),
        instanceId === null ? null : el("InstanceId", instanceId),
      ]);
    }),
  );
}

/**
 * → [{ requestId, status, calendarId }]
 * `calendarId` is the ServerId of the calendar item the server names
 * (accepted or tentative answers; absent after a decline), validated, or
 * null. A result without a valid RequestId or Status cannot be matched to a
 * request and is left out. More results than a request may hold, or two
 * results for one RequestId, make the response invalid (ProtocolError). A
 * command-level error comes as a Status under the root: see topStatus.
 */
export function parseMeetingResponse(doc) {
  expectRoot(doc, "MeetingResponse", "MeetingResponse");
  const results = doc.children.filter((r) => r.tag === "Result");
  if (results.length > MAX_MEETING_RESPONSES) throw new ProtocolError(`réponse anormale : ${results.length} résultats`);
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const requestId = v.itemId(text(r, "RequestId"));
    const status = v.status(text(r, "Status"));
    if (!requestId || !status) continue;
    if (seen.has(requestId)) throw new ProtocolError("réponse anormale : deux résultats pour une même invitation");
    seen.add(requestId);
    out.push({ requestId, status, calendarId: v.itemId(text(r, "CalendarId")) });
  }
  return out;
}

// ── ResolveRecipients: free/busy ──────────────────────────────────────────

/** Most addresses asked in one request, and the longest span asked (the server refuses a longer one with Status 5). */
export const MAX_AVAILABILITY_RECIPIENTS = 20;
export const MAX_AVAILABILITY_MS = 31 * 86_400_000;
const HALF_HOUR = 1_800_000;
/** One digit per half hour ([MS-ASCMD] 2.2.3.107): at most 32 KB of them. */
const MERGED = /^[0-4]{1,32768}$/;

const availabilityTime = (ms) => new Date(ms).toISOString();

/**
 * The free/busy data of e-mail addresses between two instants
 * ([MS-ASCMD] 2.2.1.15 with Availability; protocol 14.0 and later).
 * `addresses`: 1 to MAX_AVAILABILITY_RECIPIENTS e-mail addresses, each one
 * once; `startMs`, `endMs`: instants in milliseconds, at least half an hour
 * and at most MAX_AVAILABILITY_MS apart. No certificate and no picture is
 * asked for, and an ambiguous name is not suggested: only what was asked.
 */
export function availabilityRequest(addresses, startMs, endMs) {
  if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > MAX_AVAILABILITY_RECIPIENTS) {
    throw new ProtocolError("nombre d'adresses invalide");
  }
  const seen = new Set();
  const to = addresses.map((address) => {
    const clean = need(address, v.emailAddress, "adresse");
    if (seen.has(clean.toLowerCase())) throw new ProtocolError("adresse en double");
    seen.add(clean.toLowerCase());
    return el("To", clean);
  });
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs > 8_000_000_000_000) throw new ProtocolError("période invalide");
  if (endMs - startMs < HALF_HOUR || endMs - startMs > MAX_AVAILABILITY_MS) throw new ProtocolError("période invalide");
  return el("ResolveRecipients:ResolveRecipients", [
    ...to,
    el("Options", [
      el("MaxAmbiguousRecipients", "0"),
      el("Availability", [el("StartTime", availabilityTime(startMs)), el("EndTime", availabilityTime(endMs))]),
    ]),
  ]);
}

/**
 * The answer to availabilityRequest: Map<address asked, lower case →
 * { status, merged }>. `status` is that of the Availability element ("1":
 * data; "160" to "163": none for this recipient), or null when the
 * recipient was not resolved to exactly one entry, or carries no
 * Availability. `merged` is the MergedFreeBusy string (digits 0 to 4, one
 * per half hour from the start asked), or null.
 * Throws ProtocolError when the command itself failed.
 */
export function parseAvailability(doc) {
  expectRoot(doc, "ResolveRecipients", "ResolveRecipients");
  const top = topStatus(doc);
  if (top !== "1") throw new ProtocolError(`ResolveRecipients refusé (Status ${top})`);
  const out = new Map();
  const responses = doc.children.filter((c) => c.tag === "Response");
  if (responses.length > MAX_AVAILABILITY_RECIPIENTS) throw new ProtocolError(`réponse anormale : ${responses.length} réponses`);
  for (const r of responses) {
    const asked = v.emailAddress(text(r, "To"));
    if (!asked || out.has(asked.toLowerCase())) continue;
    const recipients = r.children.filter((c) => c.tag === "Recipient");
    const entry = { status: null, merged: null };
    // Data only for the one entry the address resolved to; a list of suggestions is nobody's availability.
    if (v.status(text(r, "Status")) === "1" && recipients.length === 1) {
      const availability = child(recipients[0], "Availability");
      if (availability) {
        entry.status = v.status(text(availability, "Status"));
        const merged = text(availability, "MergedFreeBusy");
        if (entry.status === "1" && typeof merged === "string" && MERGED.test(merged)) entry.merged = merged;
      }
    }
    out.set(asked.toLowerCase(), entry);
  }
  return out;
}

// ── Provision ─────────────────────────────────────────────────────────────

/**
 * First request (no key): asks for the policy, with the device information
 * in 14.1. Acknowledgement (key given): status 3 = "the client did not apply
 * the policy" ([MS-ASPROV]). This client does not enforce device policies
 * (PIN, encryption, wipe) and says so instead of claiming compliance; a
 * server that requires enforcement then refuses the device, as it should.
 */
export function provisionRequest({ policyKey = null, deviceInfo = null } = {}) {
  const ack = policyKey !== null;
  return el("Provision:Provision", [
    !ack && deviceInfo
      ? el("Settings:DeviceInformation", [
          el("Set", [
            el("Model", deviceInfo.model),
            el("FriendlyName", deviceInfo.friendlyName),
            el("UserAgent", deviceInfo.userAgent),
          ]),
        ])
      : null,
    el("Provision:Policies", [
      el("Policy", [
        el("PolicyType", "MS-EAS-Provisioning-WBXML"),
        ack ? el("PolicyKey", need(policyKey, v.policyKey, "PolicyKey")) : null,
        ack ? el("Status", "3") : null,
      ]),
    ]),
  ]);
}

/** → { status, remoteWipe, policyStatus, policyKey } (policyKey validated, or null) */
export function parseProvision(doc) {
  expectRoot(doc, "Provision", "Provision");
  const policy = at(doc, "Policies", "Policy");
  return {
    status: v.status(text(doc, "Status")),
    remoteWipe: Boolean(child(doc, "RemoteWipe") || child(doc, "AccountOnlyRemoteWipe")),
    policyStatus: v.status(text(policy, "Status")),
    policyKey: v.policyKey(text(policy, "PolicyKey")),
  };
}

// ── Settings (user information) ───────────────────────────────────────────

export function userInformationRequest() {
  return el("Settings:Settings", [el("UserInformation", [el("Get")])]);
}

/** → { status, displayName } (the first UserDisplayName not empty once cleaned, or null) */
export function parseUserInformation(doc) {
  expectRoot(doc, "Settings", "Settings");
  const info = child(doc, "UserInformation");
  let displayName = null;
  if (v.status(text(info, "Status")) === "1") {
    for (const account of at(info, "Get", "Accounts")?.children ?? []) {
      if (account.tag !== "Account") continue;
      const name = v.cleanText(text(account, "UserDisplayName") ?? "", { max: 256, singleLine: true, stripBidi: true }).trim();
      if (name) {
        displayName = name;
        break;
      }
    }
  }
  return { status: v.status(text(doc, "Status")), displayName };
}

// ── SendMail ──────────────────────────────────────────────────────────────

export function sendMailRequest(clientId, mime, { saveInSentItems = true } = {}) {
  if (!(mime instanceof Uint8Array) || mime.length === 0) throw new ProtocolError("message vide");
  return el("ComposeMail:SendMail", [
    el("ClientId", need(clientId, v.itemId, "ClientId")),
    saveInSentItems ? el("SaveInSentItems") : null,
    el("Mime", mime),
  ]);
}

/** An empty response means success. → status ("1" on success) */
export function parseSendMail(doc) {
  if (doc === null) return "1";
  expectRoot(doc, "ComposeMail", "SendMail");
  return v.status(text(doc, "Status"));
}
