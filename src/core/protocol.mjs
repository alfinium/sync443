// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * ActiveSync commands ([MS-ASCMD], [MS-ASPROV]): building requests from
 * checked values, and reading responses into plain, validated objects.
 *
 * Readers never hand raw server strings to the rest of the extension:
 * ids, keys and statuses go through sanitize.mjs, names are cleaned, and
 * an entry that cannot be validated is counted in `rejected` and left out.
 * Only ApplicationData (the content of an item) stays an element tree, for
 * the codecs of each item type, which validate it in turn.
 */

import { el, text, at, child } from "./wbxml.mjs";
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
export const MAX_COLLECTIONS = 100;
export const PING_CLASSES = new Set(["Email", "Calendar", "Contacts", "Tasks", "Notes"]);

/** Tags whose values the debug log may show: technical values only, never content. */
export const DEBUG_SHOWN = new Set([
  "Status", "SyncKey", "CollectionId", "ServerId", "ClientId", "ParentId", "Type", "Class", "FilterType",
  "WindowSize", "MIMESupport", "TruncationSize", "DeletesAsMoves", "HeartbeatInterval", "Id", "MaxFolders",
  "PolicyType", "SrcMsgId", "SrcFldId", "DstFldId", "DstMsgId", "Count", "Read", "Importance",
  "MessageClass", "InstanceType", "BusyStatus", "Sensitivity", "AllDayEvent", "MeetingStatus",
  "ResponseType", "Estimate", "Conflict", "ConversationMode", "NativeBodyType", "EstimatedDataSize",
  "Truncated",
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
 * collections: [{ collectionId, syncKey, deletesAsMoves?, getChanges?, windowSize?, options?: Element[], commands?: Element[] }]
 * Element order follows the schema of [MS-ASCMD] 2.2.3.29.
 */
export function syncRequest(collections) {
  return el("AirSync:Sync", [
    el(
      "Collections",
      collections.map((c) => {
        const key = need(c.syncKey, v.syncKey, "SyncKey");
        return el("Collection", [
          el("SyncKey", key),
          el("CollectionId", need(c.collectionId, v.itemId, "CollectionId")),
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

export const addCommand = (clientId, data) =>
  el("Add", [el("ClientId", need(clientId, v.itemId, "ClientId")), el("ApplicationData", data)]);
export const changeCommand = (serverId, data) =>
  el("Change", [el("ServerId", need(serverId, v.itemId, "ServerId")), el("ApplicationData", data)]);
export const deleteCommand = (serverId) => el("Delete", [el("ServerId", need(serverId, v.itemId, "ServerId"))]);
export const fetchCommand = (serverId) => el("Fetch", [el("ServerId", need(serverId, v.itemId, "ServerId"))]);

const COMMANDS = { Add: "add", Change: "change", Delete: "delete", SoftDelete: "softdelete" };
const RESPONSES = { Add: "add", Change: "change", Fetch: "fetch" };

/**
 * → { status, collections: [{ collectionId, syncKey, status, moreAvailable,
 *      commands: [{op, serverId, data}], responses: [{op, clientId, serverId, status, data}], rejected }] }
 * `status` is the command-level status (null when the response is normal).
 */
export function parseSync(doc) {
  expectRoot(doc, "AirSync", "Sync");
  const collections = [];
  let rejectedCollections = 0;
  const list = (child(doc, "Collections")?.children ?? []).filter((c) => c.tag === "Collection");
  if (list.length > MAX_COLLECTIONS) throw new ProtocolError(`réponse anormale : ${list.length} dossiers`);
  const seen = new Set();
  for (const c of list) {
    const collectionId = v.itemId(text(c, "CollectionId"));
    if (!collectionId) {
      rejectedCollections++;
      continue;
    }
    if (seen.has(collectionId)) throw new ProtocolError("réponse anormale : un dossier apparaît deux fois");
    seen.add(collectionId);
    const commands = [];
    const responses = [];
    let rejected = 0;
    const list = child(c, "Commands")?.children ?? [];
    if (list.length > MAX_COMMANDS_PER_COLLECTION) {
      throw new ProtocolError(`réponse anormale : ${list.length} éléments pour un seul dossier`);
    }
    for (const cmd of list) {
      const op = COMMANDS[cmd.tag];
      if (!op) continue;
      const serverId = v.itemId(text(cmd, "ServerId"));
      if (!serverId) {
        rejected++;
        continue;
      }
      commands.push({ op, serverId, data: child(cmd, "ApplicationData") });
    }
    const answers = child(c, "Responses")?.children ?? [];
    if (answers.length > MAX_COMMANDS_PER_COLLECTION) {
      throw new ProtocolError(`réponse anormale : ${answers.length} réponses pour un seul dossier`);
    }
    for (const r of answers) {
      const op = RESPONSES[r.tag];
      if (!op) continue;
      const answer = {
        op,
        clientId: v.itemId(text(r, "ClientId")),
        serverId: v.itemId(text(r, "ServerId")),
        status: v.status(text(r, "Status")),
        data: child(r, "ApplicationData"),
      };
      // An answer to an Add names our ClientId; the others name the ServerId.
      if (!answer.status || (op === "add" ? !answer.clientId : !answer.serverId)) {
        rejected++;
        continue;
      }
      responses.push(answer);
    }
    collections.push({
      collectionId,
      syncKey: v.syncKey(text(c, "SyncKey")),
      status: v.status(text(c, "Status")),
      moreAvailable: Boolean(child(c, "MoreAvailable")),
      commands,
      responses,
      rejected,
    });
  }
  return { status: topStatus(doc), collections, rejected: rejectedCollections };
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

/** → { status, displayName, primarySmtpAddress } (cleaned, or null) */
export function parseUserInformation(doc) {
  expectRoot(doc, "Settings", "Settings");
  const info = child(doc, "UserInformation");
  let displayName = null;
  let primarySmtpAddress = null;
  if (v.status(text(info, "Status")) === "1") {
    for (const account of at(info, "Get", "Accounts")?.children ?? []) {
      if (account.tag !== "Account") continue;
      const name = v.cleanText(text(account, "UserDisplayName") ?? "", { max: 256, singleLine: true, stripBidi: true }).trim();
      if (name && !displayName) displayName = name;
      // [MS-ASCMD] 14.1: Account/EmailAddresses/PrimarySmtpAddress (older servers put it directly under Account).
      primarySmtpAddress ??= v.emailAddress(text(account, "EmailAddresses", "PrimarySmtpAddress") ?? text(account, "PrimarySmtpAddress") ?? "");
    }
  }
  return { status: v.status(text(doc, "Status")), displayName, primarySmtpAddress };
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
