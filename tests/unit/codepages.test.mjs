// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/** Code page tests: structure of the tables, and spot checks against [MS-ASWBXML] 2.1.2.1. */

import { test, assert, eq } from "./harness.mjs";
import { pageOf, namespaceOf, tokenOf, tagOf, allTags } from "../../src/core/codepages.mjs";
import { el, encode, decode } from "../../src/core/wbxml.mjs";

const ALL = [...allTags()];

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
    ["Calendar", 4, "TimeZone", 0x05], ["Calendar", 4, "UID", 0x28], ["Calendar", 4, "ClientUid", 0x3c],
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
