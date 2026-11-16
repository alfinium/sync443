// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Command tests, from [MS-ASCMD] (FolderSync, FolderCreate/Update/Delete,
 * Sync, Ping, MoveItems, Settings, SendMail) and [MS-ASPROV] (Provision).
 */

import { test, assert, eq, throws } from "./harness.mjs";
import { el, encode, decode, text, child, at } from "../../src/core/wbxml.mjs";
import { namespaceOf, tokenOf, tagOf } from "../../src/core/codepages.mjs";
import {
  ProtocolError, MAX_COMMANDS_PER_COLLECTION, MAX_FOLDERS, PING_CLASSES, DEBUG_SHOWN, topStatus,
  folderSyncRequest, parseFolderSync, folderCreateRequest, folderUpdateRequest, folderDeleteRequest, parseFolderChange,
  syncRequest, changeCommand, deleteCommand, fetchCommand, parseSync,
  pingRequest, parsePing, moveItemsRequest, parseMoveItems, provisionRequest, parseProvision,
  userInformationRequest, parseUserInformation, sendMailRequest, parseSendMail,
  addCommand, meetingResponseRequest, parseMeetingResponse, MAX_MEETING_RESPONSES, MAX_SUPPORTED,
} from "../../src/core/protocol.mjs";

/** Through the wire format, as the client sees it: namespaces resolved, unknown tags impossible. */
const wire = (tree) => decode(encode(tree));
const tags = (node) => node.children.map((c) => c.tag);
const isProtocol = (e) => e instanceof ProtocolError;
const refused = (fn, what) => throws(fn, isProtocol, what);
const BAD_IDS = ["", "x".repeat(65), "a\nb", "a\u0000b", null, undefined, 5];
const BAD_KEYS = ["", "a b", "é", "x".repeat(65), null, undefined, 0];

// ── Builders ──────────────────────────────────────────────────────────────

test("folderSyncRequest : octets exacts pour SyncKey 0, clés invalides refusées", () => {
  eq(encode(folderSyncRequest("0")), new Uint8Array([0x03, 0x01, 0x6a, 0x00, 0x00, 0x07, 0x56, 0x52, 0x03, 0x30, 0x00, 0x01, 0x01]));
  eq(text(wire(folderSyncRequest("{abc-1}")), "SyncKey"), "{abc-1}");
  for (const k of BAD_KEYS) refused(() => folderSyncRequest(k), `SyncKey ${JSON.stringify(k)}`);
});

test("folderCreateRequest : ordre des éléments, nom envoyé tel quel, type par défaut 12", () => {
  refused(() => folderCreateRequest("1", "0", "  Projets\u202e\n2026 "), "un nom à nettoyer est refusé, jamais réécrit");
  const d = wire(folderCreateRequest("1", "0", "Projets 2026"));
  eq([d.ns, d.tag], ["FolderHierarchy", "FolderCreate"]);
  eq(tags(d), ["SyncKey", "ParentId", "DisplayName", "Type"]);
  eq([text(d, "SyncKey"), text(d, "ParentId"), text(d, "DisplayName"), text(d, "Type")], ["1", "0", "Projets 2026", "12"]);
  eq(text(wire(folderCreateRequest("1", "5", "Contacts pro", 14)), "Type"), "14");
  eq(text(wire(folderCreateRequest("1", "5", "Notes", "17")), "Type"), "17");
});

test("folderCreateRequest : entrées invalides refusées", () => {
  for (const k of BAD_KEYS) refused(() => folderCreateRequest(k, "0", "x"), `SyncKey ${JSON.stringify(k)}`);
  for (const id of BAD_IDS) refused(() => folderCreateRequest("1", id, "x"), `ParentId ${JSON.stringify(id)}`);
  for (const name of ["", " ", ".", "..", " .. ", "\u202e", null, 5]) refused(() => folderCreateRequest("1", "0", name), `nom ${JSON.stringify(name)}`);
  for (const type of [0, 20, -1, 1.5, "abc", "", null, NaN]) refused(() => folderCreateRequest("1", "0", "x", type), `type ${type}`);
});

test("folderUpdateRequest et folderDeleteRequest : structure et refus", () => {
  const u = wire(folderUpdateRequest("2", "7", "0", "Renommé"));
  eq([u.tag, tags(u)], ["FolderUpdate", ["SyncKey", "ServerId", "ParentId", "DisplayName"]]);
  eq(text(u, "DisplayName"), "Renommé");
  const d = wire(folderDeleteRequest("3", "7"));
  eq([d.tag, tags(d), text(d, "ServerId")], ["FolderDelete", ["SyncKey", "ServerId"], "7"]);
  for (const id of BAD_IDS) {
    refused(() => folderUpdateRequest("2", id, "0", "x"), "ServerId");
    refused(() => folderUpdateRequest("2", "7", id, "x"), "ParentId");
    refused(() => folderDeleteRequest("3", id), "ServerId");
  }
  refused(() => folderUpdateRequest("2", "7", "0", ".."), "nom");
  refused(() => folderDeleteRequest("", "7"), "SyncKey");
});

test("syncRequest : ordre des éléments de Collection ([MS-ASCMD] 2.2.3.29)", () => {
  const d = wire(syncRequest([{
    collectionId: "5", syncKey: "42", deletesAsMoves: true, getChanges: true, windowSize: 100,
    options: [el("FilterType", "3"), el("AirSyncBase:BodyPreference", [el("Type", "4")])],
    commands: [changeCommand("5:1", [el("Email:Read", "1")]), deleteCommand("5:2")],
  }]));
  eq([d.ns, d.tag], ["AirSync", "Sync"]);
  const c = at(d, "Collections", "Collection");
  eq(tags(c), ["SyncKey", "CollectionId", "DeletesAsMoves", "GetChanges", "WindowSize", "Options", "Commands"]);
  eq([text(c, "SyncKey"), text(c, "CollectionId"), text(c, "DeletesAsMoves"), text(c, "WindowSize")], ["42", "5", "1", "100"]);
  eq(child(c, "GetChanges").value, null, "GetChanges vide");
  eq(tags(child(c, "Commands")), ["Change", "Delete"]);
  eq(text(c, "Commands", "Change", "ApplicationData", "Email:Read"), "1");
  eq(at(c, "Options", "BodyPreference", "Type").ns, "AirSyncBase");
});

test("syncRequest : sans GetChanges ni Commands quand SyncKey vaut 0", () => {
  const c = at(wire(syncRequest([{ collectionId: "5", syncKey: "0", getChanges: true, windowSize: 50, commands: [deleteCommand("5:1")] }])), "Collections", "Collection");
  eq(tags(c), ["SyncKey", "CollectionId", "WindowSize"]);
});

test("syncRequest : éléments facultatifs absents, DeletesAsMoves 0, plusieurs dossiers", () => {
  const d = wire(syncRequest([
    { collectionId: "5", syncKey: "1" },
    { collectionId: "6", syncKey: "2", deletesAsMoves: false, getChanges: false, options: [], commands: [] },
  ]));
  const [a, b] = child(d, "Collections").children;
  eq(tags(a), ["SyncKey", "CollectionId"]);
  eq(tags(b), ["SyncKey", "CollectionId", "DeletesAsMoves"]);
  eq(text(b, "DeletesAsMoves"), "0");
  eq(text(b, "CollectionId"), "6");
});

test("syncRequest : WindowSize ramené dans [1, 512]", () => {
  const ws = (windowSize) => text(at(wire(syncRequest([{ collectionId: "5", syncKey: "1", windowSize }])), "Collections", "Collection", "WindowSize"));
  eq(ws(100), "100");
  eq(ws(512), "512");
  eq(ws(513), "512");
  eq(ws(1_000_000), "512");
  eq(ws(1), "1");
  eq(ws(-3), "1");
  eq(ws(2.7), "2");
  eq(ws(0.5), "1");
  eq(ws(2 ** 32), "512", "2^32 ne doit pas « revenir » à 0");
  eq(ws(2 ** 32 + 5), "512", "2^32 + 5 ne doit pas devenir 5");
  eq(ws(Infinity), "512");
  for (const none of [0, undefined, null, NaN]) eq(ws(none), null, `absent pour ${none}`);
});

test("syncRequest : identifiants et clés invalides refusés", () => {
  for (const k of BAD_KEYS) refused(() => syncRequest([{ collectionId: "5", syncKey: k }]), `SyncKey ${JSON.stringify(k)}`);
  for (const id of BAD_IDS) refused(() => syncRequest([{ collectionId: id, syncKey: "1" }]), `CollectionId ${JSON.stringify(id)}`);
});

test("commandes Change, Delete, Fetch : structure et identifiants vérifiés", () => {
  const change = changeCommand("5:1", [el("Email:Read", "1")]);
  eq(change.children.map((c) => c.tag), ["ServerId", "ApplicationData"]);
  eq(deleteCommand("5:2").children.map((c) => c.tag), ["ServerId"]);
  eq(fetchCommand("5:3").children.map((c) => c.tag), ["ServerId"]);
  eq(fetchCommand("5:3").tag, "Fetch");
  for (const id of BAD_IDS) {
    refused(() => changeCommand(id, []), "ServerId (Change)");
    refused(() => deleteCommand(id), "ServerId (Delete)");
    refused(() => fetchCommand(id), "ServerId (Fetch)");
  }
});

test("pingRequest : intervalle 60–3540 s, classes connues, structure", () => {
  const d = wire(pingRequest(480, [{ id: "5", cls: "Email" }, { id: "6", cls: "Calendar" }]));
  eq([d.ns, d.tag, tags(d)], ["Ping", "Ping", ["HeartbeatInterval", "Folders"]]);
  eq(text(d, "HeartbeatInterval"), "480");
  const folders = child(d, "Folders").children;
  eq(folders.map((f) => [tags(f), text(f, "Id"), text(f, "Class")]), [[["Id", "Class"], "5", "Email"], [["Id", "Class"], "6", "Calendar"]]);
  eq(text(wire(pingRequest(60, [])), "HeartbeatInterval"), "60");
  eq(text(wire(pingRequest("3540", [])), "HeartbeatInterval"), "3540");
  for (const hb of [59, 3541, 0, -60, 600.5, "abc", "", null, undefined]) refused(() => pingRequest(hb, []), `intervalle ${hb}`);
  for (const cls of PING_CLASSES) eq(text(wire(pingRequest(60, [{ id: "1", cls }])), "Folders", "Folder", "Class"), cls);
  for (const cls of ["SMS", "email", "Journal", "", undefined]) refused(() => pingRequest(60, [{ id: "1", cls }]), `classe ${cls}`);
  for (const id of BAD_IDS) refused(() => pingRequest(60, [{ id, cls: "Email" }]), `Id ${JSON.stringify(id)}`);
});

test("moveItemsRequest : structure, identifiants uniques", () => {
  const d = wire(moveItemsRequest([{ serverId: "5:1", from: "5", to: "6" }, { serverId: "5:2", from: "5", to: "7" }]));
  eq([d.ns, d.tag, tags(d)], ["Move", "MoveItems", ["Move", "Move"]]);
  eq(tags(d.children[0]), ["SrcMsgId", "SrcFldId", "DstFldId"]);
  eq([text(d.children[1], "SrcMsgId"), text(d.children[1], "DstFldId")], ["5:2", "7"]);
  refused(() => moveItemsRequest([{ serverId: "5:1", from: "5", to: "6" }, { serverId: "5:1", from: "5", to: "7" }]), "doublon");
  for (const id of BAD_IDS) {
    refused(() => moveItemsRequest([{ serverId: id, from: "5", to: "6" }]), "SrcMsgId");
    refused(() => moveItemsRequest([{ serverId: "5:1", from: id, to: "6" }]), "SrcFldId");
    refused(() => moveItemsRequest([{ serverId: "5:1", from: "5", to: id }]), "DstFldId");
  }
});

test("provisionRequest : première demande, avec ou sans DeviceInformation", () => {
  const plain = wire(provisionRequest());
  eq([plain.ns, plain.tag, tags(plain)], ["Provision", "Provision", ["Policies"]]);
  eq(tags(at(plain, "Policies", "Policy")), ["PolicyType"]);
  eq(text(plain, "Policies", "Policy", "PolicyType"), "MS-EAS-Provisioning-WBXML");
  const withInfo = wire(provisionRequest({ deviceInfo: { model: "Thunderbird", friendlyName: "Sync443", userAgent: "Sync443/1.0" } }));
  eq(withInfo.children.map((c) => `${c.ns}:${c.tag}`), ["Settings:DeviceInformation", "Provision:Policies"]);
  const set = at(withInfo, "DeviceInformation", "Set");
  eq([set.ns, tags(set)], ["Settings", ["Model", "FriendlyName", "UserAgent"]]);
  eq(text(set, "UserAgent"), "Sync443/1.0");
});

test("provisionRequest : accusé de réception avec PolicyKey puis Status 3 (règles non appliquées)", () => {
  const ack = wire(provisionRequest({ policyKey: "1307199584", deviceInfo: { model: "x", friendlyName: "y", userAgent: "z" } }));
  eq(tags(ack), ["Policies"], "pas de DeviceInformation dans l'accusé");
  const policy = at(ack, "Policies", "Policy");
  eq(tags(policy), ["PolicyType", "PolicyKey", "Status"]);
  eq([text(policy, "PolicyKey"), text(policy, "Status")], ["1307199584", "3"], "le client dit ne pas appliquer les règles");
  for (const k of ["", "abc", "4294967296", "-1", "1.0", 5]) refused(() => provisionRequest({ policyKey: k }), `clé ${JSON.stringify(k)}`);
});

test("userInformationRequest et sendMailRequest", () => {
  const u = wire(userInformationRequest());
  eq([u.ns, u.tag, tags(u), tags(child(u, "UserInformation"))], ["Settings", "Settings", ["UserInformation"], ["Get"]]);
  const mime = new Uint8Array([0x46, 0x72, 0x6f, 0x6d, 0x3a, 0x00]);
  const s = wire(sendMailRequest("c-42", mime));
  eq([s.ns, s.tag, tags(s)], ["ComposeMail", "SendMail", ["ClientId", "SaveInSentItems", "Mime"]]);
  eq([child(s, "Mime").opaque, child(s, "Mime").value], [true, mime]);
  eq(tags(wire(sendMailRequest("c-42", mime, { saveInSentItems: false }))), ["ClientId", "Mime"]);
  for (const m of [new Uint8Array(0), "From: a", null, undefined, [1, 2], new ArrayBuffer(4)]) refused(() => sendMailRequest("c-1", m), "MIME invalide");
  for (const id of BAD_IDS) refused(() => sendMailRequest(id, mime), `ClientId ${JSON.stringify(id)}`);
});

// ── Parsers ───────────────────────────────────────────────────────────────

test("parseFolderSync : ajouts, mises à jour, suppressions validés ; rejets comptés", () => {
  const add = (serverId, parentId, name, type) => el("Add", [
    serverId === undefined ? null : el("ServerId", serverId),
    parentId === undefined ? null : el("ParentId", parentId),
    name === undefined ? null : el("DisplayName", name),
    type === undefined ? null : el("Type", type),
  ]);
  const d = wire(el("FolderHierarchy:FolderSync", [
    el("Status", "1"),
    el("SyncKey", "2"),
    el("Changes", [
      el("Count", "14"),
      add("5", "0", "Boîte de réception", "2"),
      el("Update", [el("ServerId", "6"), el("ParentId", "5"), el("DisplayName", " Archives\u202e\n2026 "), el("Type", "12")]),
      el("Delete", [el("ServerId", "7")]),
      add("8", "8", "Boucle", "12"), // its own parent
      add("", "0", "Vide", "12"),
      add("x".repeat(65), "0", "Long", "12"),
      add("a\tb", "0", "Contrôle", "12"),
      add("9", "0", "..", "12"),
      add("10", "0", "Ok", "20"),
      add("11", "0", "Ok", "0"),
      add("12", undefined, "Sans parent", "12"),
      add("13", "0", undefined, "12"),
      add("14", "0", "x", "abc"),
      add("15", "0", "x", undefined),
      el("Delete", []),
      el("Status", "1"), // not a change: ignored
      add("16", "0", "Calendrier", "8"),
    ]),
  ]));
  const r = parseFolderSync(d);
  eq([r.status, r.syncKey, r.rejected], ["1", "2", 12]);
  eq(r.changes, [
    { op: "add", serverId: "5", parentId: "0", displayName: "Boîte de réception", type: 2 },
    { op: "update", serverId: "6", parentId: "5", displayName: "Archives 2026", type: 12 },
    { op: "delete", serverId: "7" },
    { op: "add", serverId: "16", parentId: "0", displayName: "Calendrier", type: 8 },
  ]);
});

test("parseFolderSync : statut d'erreur, clés invalides, racine inattendue", () => {
  eq(parseFolderSync(wire(el("FolderHierarchy:FolderSync", [el("Status", "9")]))), { status: "9", syncKey: null, changes: [], rejected: 0 });
  eq(parseFolderSync(wire(el("FolderHierarchy:FolderSync", [el("Status", "abc"), el("SyncKey", "a b")]))), { status: null, syncKey: null, changes: [], rejected: 0 });
  for (const root of [el("AirSync:Sync"), el("FolderHierarchy:FolderCreate"), el("FolderHierarchy:Changes")]) refused(() => parseFolderSync(wire(root)), root.tag);
  refused(() => parseFolderSync(null), "null");
  refused(() => parseFolderSync(undefined), "undefined");
});

test("parseFolderSync : au plus MAX_FOLDERS changements, le reste compté en rejet", () => {
  const n = MAX_FOLDERS + 3;
  const changes = Array.from({ length: n }, (_, i) => el("Add", [el("ServerId", String(i + 1)), el("ParentId", "0"), el("DisplayName", `D${i}`), el("Type", "12")]));
  const r = parseFolderSync(wire(el("FolderHierarchy:FolderSync", [el("Status", "1"), el("SyncKey", "1"), el("Changes", changes)])));
  eq([r.changes.length, r.rejected], [MAX_FOLDERS, 3]);
});

test("parseFolderChange : FolderCreate, FolderUpdate, FolderDelete", () => {
  eq(parseFolderChange(wire(el("FolderHierarchy:FolderCreate", [el("Status", "1"), el("SyncKey", "3"), el("ServerId", "15")]))), { status: "1", syncKey: "3", serverId: "15" });
  eq(parseFolderChange(wire(el("FolderHierarchy:FolderCreate", [el("Status", "1"), el("SyncKey", "3"), el("ServerId", "x".repeat(65))]))).serverId, null);
  eq(parseFolderChange(wire(el("FolderHierarchy:FolderUpdate", [el("Status", "1"), el("SyncKey", "4"), el("ServerId", "15")]))), { status: "1", syncKey: "4", serverId: null });
  eq(parseFolderChange(wire(el("FolderHierarchy:FolderDelete", [el("Status", "4")]))), { status: "4", syncKey: null, serverId: null });
  for (const root of [el("FolderHierarchy:FolderSync"), el("AirSync:Sync"), el("Move:MoveItems")]) refused(() => parseFolderChange(wire(root)), root.tag);
  refused(() => parseFolderChange(null), "null");
});

test("parseSync : commandes, réponses, MoreAvailable, rejets", () => {
  const d = wire(el("AirSync:Sync", [
    el("Collections", [
      el("Collection", [
        el("SyncKey", "43"), el("CollectionId", "5"), el("Status", "1"), el("MoreAvailable"),
        el("Commands", [
          el("Add", [el("ServerId", "5:1"), el("ApplicationData", [el("Email:Subject", "Bonjour")])]),
          el("Change", [el("ServerId", "5:2"), el("ApplicationData", [el("Email:Read", "1")])]),
          el("Delete", [el("ServerId", "5:3")]),
          el("SoftDelete", [el("ServerId", "5:4")]),
          el("Add", [el("ApplicationData", [])]),
          el("Delete", [el("ServerId", "a\nb")]),
          el("Change", [el("ServerId", "x".repeat(65))]),
          el("Fetch", [el("ServerId", "5:9")]),
        ]),
        el("Responses", [
          el("Add", [el("ClientId", "c1"), el("ServerId", "5:10"), el("Status", "1")]),
          el("Change", [el("ServerId", "5:2"), el("Status", "7")]),
          el("Fetch", [el("ServerId", "5:11"), el("Status", "1"), el("ApplicationData", [el("Email:Subject", "Lu")])]),
          el("Add", [el("ClientId", "a\u0001"), el("Status", "6")]),
          el("Delete", [el("ServerId", "5:12")]),
        ]),
      ]),
      el("Collection", [el("SyncKey", "7"), el("CollectionId", "6"), el("Status", "3")]),
      el("Status", "1"), // not a Collection: ignored
    ]),
  ]));
  const r = parseSync(d);
  eq(r.status, null, "pas de statut global");
  eq(r.collections.length, 2);
  const [a, b] = r.collections;
  eq([a.collectionId, a.syncKey, a.status, a.moreAvailable], ["5", "43", "1", true]);
  // 3 invalid commands are left out; Fetch is not a command; Add and Delete are not answers we read (no Add is ever sent).
  eq(a.commands.map((c) => [c.op, c.serverId]), [["add", "5:1"], ["change", "5:2"], ["delete", "5:3"], ["softdelete", "5:4"]]);
  eq(text(a.commands[0].data, "Subject"), "Bonjour", "ApplicationData reste un arbre");
  eq([a.commands[2].data, a.commands[3].data], [null, null]);
  eq(a.responses.map(({ op, serverId, status }) => [op, serverId, status]), [
    ["change", "5:2", "7"],
    ["fetch", "5:11", "1"],
  ]);
  eq(text(a.responses[1].data, "Subject"), "Lu");
  eq(b, {
    collectionId: "6", syncKey: "7", status: "3", moreAvailable: false, commands: [], responses: [],
    clientResponses: { adds: [], changes: [], deletes: [] },
  });
});

test("parseSync : statut global, racine inattendue", () => {
  eq(parseSync(wire(el("AirSync:Sync", [el("Status", "3")]))), { status: "3", collections: [] });
  eq(parseSync(wire(el("AirSync:Sync"))), { status: null, collections: [] });
  for (const root of [el("FolderHierarchy:FolderSync"), el("AirSync:Collections"), el("Ping:Ping")]) refused(() => parseSync(wire(root)), root.tag);
  refused(() => parseSync(null), "null");
});

test("parseSync : refus au-delà de MAX_COMMANDS_PER_COLLECTION", () => {
  const sync = (n) => wire(el("AirSync:Sync", [el("Collections", [el("Collection", [
    el("SyncKey", "2"), el("CollectionId", "5"), el("Status", "1"),
    el("Commands", Array.from({ length: n }, (_, i) => el("Delete", [el("ServerId", `5:${i}`)]))),
  ])])]));
  eq(parseSync(sync(MAX_COMMANDS_PER_COLLECTION)).collections[0].commands.length, MAX_COMMANDS_PER_COLLECTION);
  refused(() => parseSync(sync(MAX_COMMANDS_PER_COLLECTION + 1)), "une commande de trop");
});

test("parsePing : statut, dossiers modifiés, intervalle et maximum proposés", () => {
  eq(parsePing(wire(el("Ping:Ping", [el("Status", "2"), el("Folders", [el("Folder", "5"), el("Folder", "x".repeat(65)), el("Folder", "6"), el("Folder", "")])]))), {
    status: "2", folders: ["5", "6"], heartbeat: null, maxFolders: null,
  });
  eq(parsePing(wire(el("Ping:Ping", [el("Status", "5"), el("HeartbeatInterval", "480")]))).heartbeat, 480);
  for (const bad of ["0", "3541", "-1", "abc"]) eq(parsePing(wire(el("Ping:Ping", [el("Status", "5"), el("HeartbeatInterval", bad)]))).heartbeat, null, bad);
  eq(parsePing(wire(el("Ping:Ping", [el("Status", "6"), el("MaxFolders", "200")]))).maxFolders, 200);
  eq(parsePing(wire(el("Ping:Ping", [el("Status", "6"), el("MaxFolders", "10001")]))).maxFolders, null);
  eq(parsePing(wire(el("Ping:Ping", [el("Status", "1")]))), { status: "1", folders: [], heartbeat: null, maxFolders: null });
  refused(() => parsePing(wire(el("AirSync:Sync"))), "racine");
});

test("parseMoveItems : réponses validées", () => {
  const r = parseMoveItems(wire(el("Move:MoveItems", [
    el("Response", [el("SrcMsgId", "5:1"), el("Status", "3"), el("DstMsgId", "6:1")]),
    el("Response", [el("SrcMsgId", "5:2"), el("Status", "1"), el("DstMsgId", "x".repeat(65))]),
    el("Response", [el("Status", "abcde")]),
  ])));
  eq(r, [
    { srcMsgId: "5:1", status: "3", dstMsgId: "6:1" },
    { srcMsgId: "5:2", status: "1", dstMsgId: null },
  ], "une réponse qu'on ne peut rattacher à aucune demande est écartée");
  refused(() => parseMoveItems(wire(el("Move:Move"))), "racine");
});

test("parseProvision : clé, statuts, RemoteWipe et AccountOnlyRemoteWipe", () => {
  const prov = (extra = [], key = "1307199584", policyStatus = "1") => wire(el("Provision:Provision", [
    el("Status", "1"),
    el("Policies", [el("Policy", [el("PolicyType", "MS-EAS-Provisioning-WBXML"), el("Status", policyStatus), el("PolicyKey", key)])]),
    ...extra,
  ]));
  eq(parseProvision(prov()), { status: "1", remoteWipe: false, policyStatus: "1", policyKey: "1307199584" });
  eq(parseProvision(prov([el("RemoteWipe")])).remoteWipe, true, "RemoteWipe");
  eq(parseProvision(prov([el("AccountOnlyRemoteWipe")])).remoteWipe, true, "AccountOnlyRemoteWipe");
  eq(parseProvision(prov([], "4294967296")).policyKey, null, "clé au-delà de 2^32−1");
  eq(parseProvision(prov([], "4294967295")).policyKey, "4294967295");
  eq(parseProvision(prov([], "abc")).policyKey, null);
  eq(parseProvision(prov([], "1", "2")).policyStatus, "2");
  eq(parseProvision(wire(el("Provision:Provision", [el("Status", "2")]))), { status: "2", remoteWipe: false, policyStatus: null, policyKey: null });
  eq(parseProvision(wire(el("Provision:Provision", [el("RemoteWipe")]))).remoteWipe, true, "RemoteWipe seul");
  refused(() => parseProvision(wire(el("Provision:Policies"))), "racine");
  refused(() => parseProvision(null), "null");
});

test("parseUserInformation : nom nettoyé", () => {
  const info = (status, accounts) => wire(el("Settings:Settings", [el("Status", "1"), el("UserInformation", [el("Status", status), el("Get", [el("Accounts", accounts)])])]));
  const account = (name) => el("Account", [name === null ? null : el("UserDisplayName", name)]);
  eq(parseUserInformation(info("1", [account("  Jean\u202e Dupont\n"), account("Autre")])), { status: "1", displayName: "Jean Dupont" });
  eq(parseUserInformation(info("1", [account(null), account(" \u202e "), account("Marie")])), { status: "1", displayName: "Marie" }, "premiers comptes sans nom");
  eq(parseUserInformation(info("1", [account("x".repeat(300))])).displayName.length, 256, "nom coupé à 256");
  eq(parseUserInformation(info("2", [account("Jean")])), { status: "1", displayName: null }, "statut 2");
  refused(() => parseUserInformation(wire(el("Settings:UserInformation"))), "racine");
});

test("parseSendMail : réponse vide = succès, sinon le statut", () => {
  eq(parseSendMail(null), "1");
  eq(parseSendMail(wire(el("ComposeMail:SendMail", [el("Status", "120")]))), "120");
  eq(parseSendMail(wire(el("ComposeMail:SendMail"))), null);
  refused(() => parseSendMail(wire(el("ComposeMail:SmartReply", [el("Status", "1")]))), "racine");
  refused(() => parseSendMail(undefined), "undefined n'est pas une réponse vide");
});

test("topStatus : seulement le Status placé directement sous la racine", () => {
  eq(topStatus(wire(el("AirSync:Sync", [el("Status", "140")]))), "140");
  eq(topStatus(wire(el("AirSync:Sync", [el("Collections", [el("Collection", [el("Status", "140")])])]))), null);
  eq(topStatus(wire(el("AirSync:Sync", [el("Status", "abc")]))), null);
  eq(topStatus(null), null);
  eq(topStatus(undefined), null);
});

test("DEBUG_SHOWN : uniquement des balises techniques, jamais de contenu", () => {
  // A page number is one byte: every namespace is tried.
  const namespaces = Array.from({ length: 256 }, (_, page) => namespaceOf(page)).filter(Boolean);
  for (const tag of DEBUG_SHOWN) {
    assert(namespaces.some((ns) => tokenOf(ns, tag) !== undefined), `balise inconnue dans DEBUG_SHOWN : ${tag}`);
  }
  for (const tag of [
    "Subject", "Body", "Data", "DisplayName", "To", "From", "Cc", "Bcc", "ReplyTo", "DisplayTo", "Sender", "Mime",
    "Location", "Name", "Email", "Email1Address", "UserDisplayName", "PrimarySmtpAddress", "EmailAddress", "SMTPAddress",
    "Password", "UserName", "Organizer", "OrganizerName", "OrganizerEmail", "FileAs", "FirstName", "LastName", "Picture",
    "Preview", "Content", "Categories", "Category", "ThreadTopic", "OofMessage", "ReplyMessage", "Query", "FreeText",
    "Value", "Alias", "MobilePhoneNumber", "HomePhoneNumber", "Notes", "UmUserNotes", "Attendee", "Recipient", "Certificate",
    "DevicePassword", "IMEI", "PhoneNumber", "FriendlyName", "Model", "UserAgent", "AccountName", "ForwardeeEmail",
    "ForwardeeName", "ConversationId", "ConversationIndex", "GlobalObjId", "UID", "ClientUid",
  ]) {
    assert(!DEBUG_SHOWN.has(tag), `${tag} ne doit jamais apparaître dans le journal`);
  }
});

test("constantes : limites et classes de Ping", () => {
  eq(MAX_COMMANDS_PER_COLLECTION, 2000);
  eq(MAX_FOLDERS, 5000);
  eq([...PING_CLASSES].sort(), ["Calendar", "Contacts", "Email", "Notes", "Tasks"]);
});

// ── Stage 4: Add, Supported, answers to client commands, MeetingResponse ──

const collectionOf = (c) => at(wire(syncRequest([c])), "Collections", "Collection");
/** A Sync response for one collection with the given Responses children. */
const answered = (responses) => wire(el("AirSync:Sync", [el("Collections", [el("Collection", [
  el("SyncKey", "9"), el("CollectionId", "7"), el("Status", "1"), el("Responses", responses),
])])]));
const control = (code) => String.fromCharCode(code);

test("addCommand: ClientId then ApplicationData, inside Commands", () => {
  const add = addCommand("c-1", [el("Calendar:Subject", "Point")]);
  eq([add.tag, add.children.map((c) => c.tag)], ["Add", ["ClientId", "ApplicationData"]]);
  const c = collectionOf({ collectionId: "7", syncKey: "4", commands: [add, changeCommand("7:1", [el("Calendar:Subject", "x")])] });
  eq(tags(child(c, "Commands")), ["Add", "Change"]);
  eq(text(c, "Commands", "Add", "ClientId"), "c-1");
  eq(text(c, "Commands", "Add", "ApplicationData", "Calendar:Subject"), "Point");
  eq(at(c, "Commands", "Add", "ClientId").ns, "AirSync");
});

test("addCommand: only 1 to 64 letters, digits and hyphens make a ClientId", () => {
  for (const ok of ["a", "0", "-", "A1b2-C3", "x".repeat(64), "0123456789abcdef0123456789abcdef"]) {
    eq(text(addCommand(ok, []), "ClientId"), ok);
  }
  const bad = [
    "", "x".repeat(65), "a b", "a_b", "a:b", "a.b", "é", "a/b", "a\nb", `a${control(0)}`, `a${control(0x202e)}b`,
    " a", "a ", null, undefined, 5, {}, ["a"],
  ];
  for (const id of bad) refused(() => addCommand(id, []), `ClientId ${JSON.stringify(id)}`);
});

test("syncRequest: Supported comes after CollectionId, as empty elements with their namespace", () => {
  const supported = ["Calendar:Subject", "Calendar:Timezone", "Calendar:StartTime", "Calendar:Attendees"];
  const c = collectionOf({ collectionId: "7", syncKey: "0", supported, deletesAsMoves: true, windowSize: 10, options: [el("FilterType", "4")] });
  eq(tags(c), ["SyncKey", "CollectionId", "Supported", "DeletesAsMoves", "WindowSize", "Options"]);
  const list = child(c, "Supported");
  eq(list.ns, "AirSync");
  eq(list.children.map((x) => `${x.ns}:${x.tag}`), supported);
  for (const x of list.children) eq([x.value, x.children.length], [null, 0], "an empty element");
});

test("syncRequest: Supported is only sent with SyncKey 0", () => {
  const supported = ["Calendar:Subject", "Calendar:Location"];
  for (const syncKey of ["1", "00", "01", "{0}", "42", "O"]) {
    eq(child(collectionOf({ collectionId: "7", syncKey, supported }), "Supported"), null, `SyncKey ${syncKey}`);
  }
  assert(child(collectionOf({ collectionId: "7", syncKey: "0", supported }), "Supported"), "SyncKey 0");
  // Several collections: each one on its own key.
  const d = wire(syncRequest([
    { collectionId: "7", syncKey: "0", supported },
    { collectionId: "8", syncKey: "5", supported },
    { collectionId: "9", syncKey: "0" },
  ]));
  eq(child(d, "Collections").children.map((c) => tags(c)), [["SyncKey", "CollectionId", "Supported"], ["SyncKey", "CollectionId"], ["SyncKey", "CollectionId"]]);
});

test("syncRequest: an empty Supported list gives an empty element; none gives no element", () => {
  const empty = child(collectionOf({ collectionId: "7", syncKey: "0", supported: [] }), "Supported");
  eq([empty.tag, empty.children.length, empty.value], ["Supported", 0, null]);
  for (const none of [undefined, null]) eq(child(collectionOf({ collectionId: "7", syncKey: "0", supported: none }), "Supported"), null);
});

test("syncRequest: a Supported list that is not known element names is refused, whatever the SyncKey", () => {
  const bad = [
    "Calendar", ["Subject"], [":Subject"], ["Calendar:"], ["Calendar:NoSuchTag"], ["NoSuchPage:Subject"], ["Calendar:Subject:x"],
    ["Calendar:Subject", "Calendar:Subject"], [5], [null], [["Calendar:Subject"]], ["calendar:Subject"], ["Calendar:subject"],
    ["__proto__:toString"], ["constructor:constructor"], [`Calendar:Subject${control(0)}`], {}, 7,
  ];
  for (const supported of bad) {
    refused(() => syncRequest([{ collectionId: "7", syncKey: "0", supported }]), `Supported ${JSON.stringify(supported)?.slice(0, 60)}`);
    refused(() => syncRequest([{ collectionId: "7", syncKey: "3", supported }]), "checked even when it is not sent");
  }
});

test("syncRequest: a Supported list holds at most MAX_SUPPORTED names", () => {
  // Every element name the code pages know, as many distinct valid names as needed.
  const known = [];
  for (let page = 0; page < 32; page++) {
    for (let token = 0x05; token <= 0x3f; token++) if (tagOf(page, token)) known.push(`${namespaceOf(page)}:${tagOf(page, token)}`);
  }
  eq(MAX_SUPPORTED, 128);
  assert(known.length > MAX_SUPPORTED + 1);
  const sent = child(collectionOf({ collectionId: "7", syncKey: "0", supported: known.slice(0, MAX_SUPPORTED) }), "Supported");
  eq(sent.children.length, MAX_SUPPORTED);
  eq(sent.children.map((x) => `${x.ns}:${x.tag}`), known.slice(0, MAX_SUPPORTED));
  refused(() => syncRequest([{ collectionId: "7", syncKey: "0", supported: known.slice(0, MAX_SUPPORTED + 1) }]), "one name too many");
  refused(() => syncRequest([{ collectionId: "7", syncKey: "0", supported: Array.from({ length: 100_000 }, () => "Calendar:Subject") }]), "a huge list");
});

test("parseSync: answers to Add give the ClientId, the ServerId and the status", () => {
  const r = parseSync(answered([
    el("Add", [el("ClientId", "c-1"), el("ServerId", "7:10"), el("Status", "1")]),
    el("Add", [el("ClientId", "c-2"), el("Status", "6")]),
    el("Add", [el("ClientId", "c-3"), el("ServerId", "x".repeat(65)), el("Status", "1")]),
    el("Add", [el("ClientId", "c-4"), el("ServerId", "7:11"), el("Status", "0001")]),
  ])).collections[0];
  eq(r.clientResponses.adds, [
    { clientId: "c-1", serverId: "7:10", status: "1" },
    { clientId: "c-2", serverId: null, status: "6" },
    { clientId: "c-3", serverId: null, status: "1" },
    { clientId: "c-4", serverId: "7:11", status: "1" },
  ]);
  eq([r.clientResponses.changes, r.clientResponses.deletes, r.responses], [[], [], []]);
});

test("parseSync: an Add answer without a usable ClientId or Status is left out", () => {
  const hostile = [
    "", "x".repeat(65), "a b", "a\nb", `a${control(1)}`, `a${control(0x202e)}`, "c_1", "c.1", "é", "__proto__",
  ];
  const r = parseSync(answered([
    ...hostile.map((id, i) => el("Add", [el("ClientId", id), el("ServerId", `7:${i}`), el("Status", "1")])),
    el("Add", [el("ServerId", "7:50"), el("Status", "1")]),
    el("Add", [el("ClientId", "c-1"), el("ServerId", "7:51")]),
    el("Add", [el("ClientId", "c-2"), el("ServerId", "7:52"), el("Status", "abc")]),
    el("Add", [el("ClientId", "c-3"), el("ServerId", "7:53"), el("Status", "12345")]),
    el("Add", [el("ClientId", "ok"), el("ServerId", "7:54"), el("Status", "1")]),
  ])).collections[0];
  eq(r.clientResponses.adds, [{ clientId: "ok", serverId: "7:54", status: "1" }]);
});

test("parseSync: two answers for one ClientId, or one ServerId for two ClientIds, refuse the response", () => {
  refused(() => parseSync(answered([
    el("Add", [el("ClientId", "c-1"), el("ServerId", "7:10"), el("Status", "1")]),
    el("Add", [el("ClientId", "c-1"), el("ServerId", "7:11"), el("Status", "1")]),
  ])), "same ClientId");
  refused(() => parseSync(answered([
    el("Add", [el("ClientId", "c-1"), el("Status", "6")]),
    el("Add", [el("ClientId", "c-1"), el("ServerId", "7:11"), el("Status", "1")]),
  ])), "same ClientId, one of them refused");
  refused(() => parseSync(answered([
    el("Add", [el("ClientId", "c-1"), el("ServerId", "7:10"), el("Status", "1")]),
    el("Add", [el("ClientId", "c-2"), el("ServerId", "7:10"), el("Status", "1")]),
  ])), "same ServerId");
  // Two refused Adds have no ServerId to share.
  eq(parseSync(answered([
    el("Add", [el("ClientId", "c-1"), el("Status", "6")]),
    el("Add", [el("ClientId", "c-2"), el("Status", "6")]),
  ])).collections[0].clientResponses.adds.length, 2);
});

test("parseSync: answers to Change and Delete, when the server gives one", () => {
  const r = parseSync(answered([
    el("Change", [el("ServerId", "7:2"), el("Status", "6")]),
    el("Delete", [el("ServerId", "7:3"), el("Status", "8")]),
    el("Delete", [el("ServerId", "7:4")]),
    el("Change", [el("ServerId", "a\nb"), el("Status", "6")]),
    el("Delete", [el("Status", "8")]),
    el("Fetch", [el("ServerId", "7:5"), el("Status", "1"), el("ApplicationData", [el("Calendar:Subject", "x")])]),
    el("SoftDelete", [el("ServerId", "7:6"), el("Status", "1")]),
  ])).collections[0];
  eq(r.clientResponses, { adds: [], changes: [{ serverId: "7:2", status: "6" }], deletes: [{ serverId: "7:3", status: "8" }] });
  // What the mail engine reads is what it was: Change and Fetch, with their data.
  eq(r.responses.map(({ op, serverId, status }) => [op, serverId, status]), [["change", "7:2", "6"], ["fetch", "7:5", "1"]]);
  eq(Object.keys(r.responses[0]), ["op", "serverId", "status", "data"]);
  eq(text(r.responses[1].data, "Subject"), "x");
});

test("parseSync: client answers are bounded like the rest", () => {
  const many = (n) => answered(Array.from({ length: n }, (_, i) => el("Add", [el("ClientId", `c-${i}`), el("ServerId", `7:${i}`), el("Status", "1")])));
  eq(parseSync(many(MAX_COMMANDS_PER_COLLECTION)).collections[0].clientResponses.adds.length, MAX_COMMANDS_PER_COLLECTION);
  refused(() => parseSync(many(MAX_COMMANDS_PER_COLLECTION + 1)), "one answer too many");
});

test("meetingResponseRequest: structure and element order", () => {
  const d = wire(meetingResponseRequest([
    { userResponse: 1, collectionId: "5", requestId: "5:12" },
    { userResponse: 3, collectionId: "7", requestId: "7:4", instanceId: "2026-11-20T09:00:00Z" },
    { userResponse: 2, collectionId: "7", requestId: "7:5", instanceId: "2026-11-27T09:00:00.000Z" },
    { userResponse: 2, collectionId: "7", requestId: "7:6", instanceId: null },
  ]));
  eq([d.ns, d.tag, tags(d)], ["MeetingResponse", "MeetingResponse", ["Request", "Request", "Request", "Request"]]);
  const [a, b, c, e] = d.children;
  eq(tags(a), ["UserResponse", "CollectionId", "RequestId"]);
  eq([text(a, "UserResponse"), text(a, "CollectionId"), text(a, "RequestId")], ["1", "5", "5:12"]);
  eq(tags(b), ["UserResponse", "CollectionId", "RequestId", "InstanceId"]);
  eq([text(b, "UserResponse"), text(b, "InstanceId")], ["3", "2026-11-20T09:00:00.000Z"]);
  eq(text(c, "InstanceId"), "2026-11-27T09:00:00.000Z");
  eq(text(c, "InstanceId").length, 24, "the length the schema requires");
  eq(tags(e), ["UserResponse", "CollectionId", "RequestId"]);
  for (const x of [a, b, c]) for (const y of x.children) eq(y.ns, "MeetingResponse");
});

test("meetingResponseRequest: invalid values are refused", () => {
  const ok = { userResponse: 1, collectionId: "5", requestId: "5:12" };
  for (const userResponse of [0, 4, -1, 1.5, "1", "accepted", null, undefined, true, NaN]) {
    refused(() => meetingResponseRequest([{ ...ok, userResponse }]), `UserResponse ${userResponse}`);
  }
  for (const id of BAD_IDS) {
    refused(() => meetingResponseRequest([{ ...ok, collectionId: id }]), "CollectionId");
    refused(() => meetingResponseRequest([{ ...ok, requestId: id }]), "RequestId");
  }
  const badInstances = [
    "", "2026-11-20", "20261120T090000Z", "2026-11-20T09:00:00", "2026-11-20T09:00:00+01:00", "2026-11-20 09:00:00Z",
    "2026-11-20T09:00:00.123Z", "2026-11-20T09:00:00.0Z", "2026-02-30T09:00:00Z", "2026-13-01T09:00:00Z", "2026-11-20T24:00:00Z",
    "2026-11-20T09:60:00Z", "2026-11-20T09:00:60Z", "1899-12-31T23:59:59Z", "2201-01-01T00:00:00Z", " 2026-11-20T09:00:00Z",
    "2026-11-20T09:00:00Z\n", `2026-11-20T09:00:00Z${control(0)}`, 5, {}, new Date(0),
  ];
  for (const instanceId of badInstances) refused(() => meetingResponseRequest([{ ...ok, instanceId }]), `InstanceId ${JSON.stringify(instanceId)}`);
  for (const list of [null, undefined, {}, "x", [], [null], [5]]) refused(() => meetingResponseRequest(list), `list ${JSON.stringify(list)}`);
});

test("meetingResponseRequest: 1 to 100 requests, a RequestId only once", () => {
  const list = (n) => Array.from({ length: n }, (_, i) => ({ userResponse: 1, collectionId: "5", requestId: `5:${i}` }));
  eq(MAX_MEETING_RESPONSES, 100);
  eq(meetingResponseRequest(list(MAX_MEETING_RESPONSES)).children.length, MAX_MEETING_RESPONSES);
  refused(() => meetingResponseRequest(list(MAX_MEETING_RESPONSES + 1)), "one too many");
  refused(() => meetingResponseRequest([
    { userResponse: 1, collectionId: "5", requestId: "5:1" },
    { userResponse: 3, collectionId: "6", requestId: "5:1" },
  ]), "the server answers by RequestId alone");
});

test("parseMeetingResponse: results validated; CalendarId only when it is an id", () => {
  const r = parseMeetingResponse(wire(el("MeetingResponse:MeetingResponse", [
    el("Result", [el("RequestId", "5:12"), el("Status", "1"), el("CalendarId", "7:33")]),
    el("Result", [el("RequestId", "5:13"), el("Status", "1")]),
    el("Result", [el("RequestId", "5:14"), el("Status", "2")]),
    el("Result", [el("RequestId", "5:15"), el("Status", "1"), el("CalendarId", "x".repeat(65))]),
    el("Result", [el("RequestId", "5:16"), el("Status", "1"), el("CalendarId", "a\nb")]),
    el("Result", [el("RequestId", "5:17"), el("Status", "1"), el("CalendarId", "")]),
    el("Result", [el("RequestId", "5:18"), el("Status", "0003"), el("CalendarId", `7:${control(0x1b)}`)]),
  ])));
  eq(r, [
    { requestId: "5:12", status: "1", calendarId: "7:33" },
    { requestId: "5:13", status: "1", calendarId: null },
    { requestId: "5:14", status: "2", calendarId: null },
    { requestId: "5:15", status: "1", calendarId: null },
    { requestId: "5:16", status: "1", calendarId: null },
    { requestId: "5:17", status: "1", calendarId: null },
    { requestId: "5:18", status: "3", calendarId: null },
  ]);
});

test("parseMeetingResponse: a result that cannot be matched or read is left out", () => {
  const r = parseMeetingResponse(wire(el("MeetingResponse:MeetingResponse", [
    el("Result", [el("Status", "1"), el("CalendarId", "7:1")]),
    el("Result", [el("RequestId", ""), el("Status", "1")]),
    el("Result", [el("RequestId", "x".repeat(65)), el("Status", "1")]),
    el("Result", [el("RequestId", `5:${control(7)}`), el("Status", "1")]),
    el("Result", [el("RequestId", "5:20")]),
    el("Result", [el("RequestId", "5:21"), el("Status", "ok")]),
    el("Result", [el("RequestId", "5:22"), el("Status", "-1")]),
    el("Result", [el("RequestId", "5:23"), el("Status", "99999")]),
    el("Request", [el("RequestId", "5:24"), el("Status", "1")]), // not a Result
    el("Result", [el("RequestId", "5:25"), el("Status", "1"), el("CalendarId", "7:9")]),
  ])));
  eq(r, [{ requestId: "5:25", status: "1", calendarId: "7:9" }]);
  eq(parseMeetingResponse(wire(el("MeetingResponse:MeetingResponse"))), []);
});

test("parseMeetingResponse: unexpected root, too many results, a RequestId twice", () => {
  for (const root of [el("AirSync:Sync"), el("Move:MoveItems"), el("MeetingResponse:Result"), el("MeetingResponse:Request")]) {
    refused(() => parseMeetingResponse(wire(root)), `${root.ns}:${root.tag}`);
  }
  refused(() => parseMeetingResponse(null), "null");
  const results = (n) => wire(el("MeetingResponse:MeetingResponse", Array.from({ length: n }, (_, i) => el("Result", [el("RequestId", `5:${i}`), el("Status", "1")]))));
  eq(parseMeetingResponse(results(MAX_MEETING_RESPONSES)).length, MAX_MEETING_RESPONSES);
  refused(() => parseMeetingResponse(results(MAX_MEETING_RESPONSES + 1)), "more results than a request can hold");
  refused(() => parseMeetingResponse(wire(el("MeetingResponse:MeetingResponse", [
    el("Result", [el("RequestId", "5:1"), el("Status", "1"), el("CalendarId", "7:1")]),
    el("Result", [el("RequestId", "5:1"), el("Status", "1"), el("CalendarId", "7:2")]),
  ]))), "which calendar item it is would be a guess");
});

test("parseMeetingResponse: a command-level status is read with topStatus", () => {
  const d = wire(el("MeetingResponse:MeetingResponse", [el("Status", "3")]));
  eq(parseMeetingResponse(d), []);
  eq(topStatus(d), "3");
});

test("DEBUG_SHOWN: the ids and the answer of a MeetingResponse, never the date of an occurrence", () => {
  for (const tag of ["RequestId", "CalendarId", "UserResponse"]) assert(DEBUG_SHOWN.has(tag), tag);
  for (const tag of ["InstanceId", "StartTime", "EndTime", "TimeZone", "Timezone", "GlobalObjId", "Organizer"]) assert(!DEBUG_SHOWN.has(tag), tag);
});
