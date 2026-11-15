// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of the folder hierarchy: FolderSync changes ([MS-ASCMD] 2.2.3.x,
 * folder types 2.2.3.186.3), tree checks (cycles, unknown parents, depth,
 * count, kinds chosen), and one-for-one local paths valid on Windows,
 * macOS and Linux.
 */

import { test, assert, eq, throws } from "./harness.mjs";
import {
  applyChanges,
  buildTree,
  localPaths,
  localFolderName,
  specialFolders,
  specialUse,
  kindOf,
  compareIds,
  MAIL_TYPES,
  CALENDAR_TYPES,
  CONTACT_TYPES,
  TASK_TYPES,
  SPECIAL_PATHS,
  RESERVED_ROOT_NAMES,
  ROOT_ID,
  MAX_DEPTH,
  MAX_TREE_FOLDERS,
  MAX_STORED_FOLDERS,
} from "../../src/core/folder-tree.mjs";

const MAIL = { mail: true, calendar: false, contacts: false, tasks: false };
const ALL = { mail: true, calendar: true, contacts: true, tasks: true };
const ch = (code) => String.fromCharCode(code);

/** Folder table from [id, parentId, name, type] rows. */
const table = (rows) => new Map(rows.map(([id, parentId, name, type]) => [id, { parentId, name, type }]));

/** A typical Exchange hierarchy. */
const EXCHANGE = [
  ["1", "0", "Inbox", 2],
  ["2", "0", "Drafts", 3],
  ["3", "0", "Deleted Items", 4],
  ["4", "0", "Sent Items", 5],
  ["5", "0", "Outbox", 6],
  ["6", "0", "Calendar", 8],
  ["7", "0", "Contacts", 9],
  ["8", "0", "Tasks", 7],
  ["9", "0", "Notes", 10],
  ["10", "0", "Journal", 11],
  ["11", "0", "Junk Email", 12],
  ["12", "1", "Clients", 12],
  ["13", "12", "Dupont", 12],
  ["14", "0", "Projets", 12],
  ["15", "14", "2026", 12],
  ["16", "6", "Anniversaires", 13],
  ["17", "0", "Recipient Cache", 19],
];

// ── Types ─────────────────────────────────────────────────────────────────

test("types de dossiers : courrier, agenda, contacts, tâches", () => {
  eq([...MAIL_TYPES], [1, 2, 3, 4, 5, 6, 12]);
  eq([...CALENDAR_TYPES], [8, 13]);
  eq([...CONTACT_TYPES], [9, 14]);
  eq([...TASK_TYPES], [7, 15]);
  for (let t = 1; t <= 19; t++) {
    const expected = MAIL_TYPES.has(t) ? "mail" : CALENDAR_TYPES.has(t) ? "calendar" : CONTACT_TYPES.has(t) ? "contacts" : TASK_TYPES.has(t) ? "tasks" : null;
    eq(kindOf(t), expected, `type ${t}`);
  }
  eq(kindOf("2"), null, "texte");
});

test("specialUse : 2 inbox, 3 drafts, 4 trash, 5 sent, 6 outbox, sinon null", () => {
  eq([2, 3, 4, 5, 6].map(specialUse), ["inbox", "drafts", "trash", "sent", "outbox"]);
  for (const t of [1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0, -1, "2", null, undefined]) eq(specialUse(t), null, String(t));
  eq(SPECIAL_PATHS.get("outbox"), "/Unsent Messages");
});

test("compareIds : plus court d'abord, puis ordre des caractères", () => {
  eq(["10", "9", "1", "a", "B", "100", "1:2"].sort(compareIds), ["1", "9", "B", "a", "10", "100", "1:2"]);
});

// ── applyChanges ──────────────────────────────────────────────────────────

test("applyChanges : ajout, mise à jour, suppression ; entrée non modifiée", () => {
  const before = table([["1", "0", "Inbox", 2], ["2", "0", "Old", 12]]);
  const after = applyChanges(before, [
    { op: "add", serverId: "3", parentId: "1", displayName: "Clients", type: 12 },
    { op: "update", serverId: "2", parentId: "1", displayName: "Renamed", type: 12 },
    { op: "delete", serverId: "1x" },
  ]);
  assert(after !== before, "nouvelle Map");
  eq(before.size, 2);
  eq(before.get("2").name, "Old", "entrée intacte");
  eq(after.get("3"), { parentId: "1", name: "Clients", type: 12 });
  eq(after.get("2"), { parentId: "1", name: "Renamed", type: 12 });
  eq(after.size, 3);
});

test("applyChanges : une mise à jour d'un dossier inconnu l'ajoute", () => {
  eq(applyChanges(new Map(), [{ op: "update", serverId: "5", parentId: "0", displayName: "X", type: 12 }]).get("5"), { parentId: "0", name: "X", type: 12 });
});

test("applyChanges : supprimer un dossier emporte ses sous-dossiers", () => {
  const before = table([["1", "0", "A", 12], ["2", "1", "B", 12], ["3", "2", "C", 12], ["4", "0", "D", 12], ["5", "4", "E", 12]]);
  const after = applyChanges(before, [{ op: "delete", serverId: "1" }]);
  eq([...after.keys()], ["4", "5"]);
});

test("applyChanges : un sous-dossier déplacé avant la suppression du parent reste", () => {
  const before = table([["1", "0", "A", 12], ["2", "1", "B", 12], ["3", "1", "C", 12]]);
  const after = applyChanges(before, [
    { op: "update", serverId: "2", parentId: "0", displayName: "B", type: 12 },
    { op: "delete", serverId: "1" },
  ]);
  eq([...after.keys()], ["2"]);
  eq(after.get("2").parentId, "0");
});

test("applyChanges : supprimé puis recréé dans la même réponse → gardé avec ses sous-dossiers", () => {
  const before = table([["1", "0", "A", 12], ["2", "1", "B", 12]]);
  const after = applyChanges(before, [
    { op: "delete", serverId: "1" },
    { op: "add", serverId: "1", parentId: "0", displayName: "A2", type: 12 },
  ]);
  eq([...after.keys()].sort(), ["1", "2"]);
  eq(after.get("1").name, "A2");
});

test("applyChanges : un cycle dans la table ne bloque pas la suppression en cascade", () => {
  const before = table([["1", "2", "A", 12], ["2", "1", "B", 12], ["3", "0", "C", 12], ["4", "3", "D", 12]]);
  const after = applyChanges(before, [{ op: "delete", serverId: "3" }]);
  eq([...after.keys()], ["1", "2"], "le cycle est laissé à buildTree");
});

test("applyChanges : changements invalides ignorés", () => {
  const base = table([["1", "0", "Inbox", 2]]);
  const bad = [
    null,
    "add",
    { op: "add", serverId: "", parentId: "0", displayName: "X", type: 12 },
    { op: "add", serverId: "x".repeat(65), parentId: "0", displayName: "X", type: 12 },
    { op: "add", serverId: "2", parentId: "", displayName: "X", type: 12 },
    { op: "add", serverId: "2", parentId: "0", displayName: "", type: 12 },
    { op: "add", serverId: "2", parentId: "0", displayName: "   ", type: 12 },
    { op: "add", serverId: "2", parentId: "0", displayName: 42, type: 12 },
    { op: "add", serverId: "2", parentId: "0", displayName: "X", type: 0 },
    { op: "add", serverId: "2", parentId: "0", displayName: "X", type: 20 },
    { op: "add", serverId: "2", parentId: "0", displayName: "X", type: "12" },
    { op: "move", serverId: "2", parentId: "0", displayName: "X", type: 12 },
    { op: "delete", serverId: `1${ch(0)}` },
  ];
  eq(applyChanges(base, bad), base);
  eq(applyChanges(base, "pas un tableau"), base);
  eq(applyChanges(null, [{ op: "add", serverId: "1", parentId: "0", displayName: "A", type: 12 }]).size, 1, "table absente");
});

test("applyChanges : nom nettoyé comme parseFolderSync", () => {
  const after = applyChanges(new Map(), [{ op: "add", serverId: "1", parentId: "0", displayName: `  Fac${ch(0x202e)}ture${ch(7)}  `, type: 12 }]);
  eq(after.get("1").name, "Facture");
});

test(`applyChanges : au plus ${MAX_STORED_FOLDERS} dossiers stockés`, () => {
  const changes = [];
  for (let i = 1; i <= MAX_STORED_FOLDERS + 5; i++) changes.push({ op: "add", serverId: `f${i}`, parentId: "0", displayName: `D${i}`, type: 12 });
  const after = applyChanges(new Map(), changes);
  eq(after.size, MAX_STORED_FOLDERS);
  assert(!after.has(`f${MAX_STORED_FOLDERS + 1}`), "les nouveaux au-delà sont ignorés");
  const updated = applyChanges(after, [{ op: "update", serverId: "f1", parentId: "0", displayName: "Renommé", type: 12 }]);
  eq(updated.get("f1").name, "Renommé", "un dossier connu reste modifiable");
});

// ── buildTree ─────────────────────────────────────────────────────────────

test("buildTree : courrier seul, hiérarchie Exchange", () => {
  const { nodes, rejected } = buildTree(table(EXCHANGE), { kinds: MAIL });
  eq(rejected, []);
  eq([...nodes.keys()], ["1", "2", "3", "4", "5", "11", "14", "12", "15", "13"], "profondeur puis ServerId");
  eq(nodes.get("13"), { parentId: "12", name: "Dupont", type: 12, depth: 3 });
  eq(nodes.get("1"), { parentId: "0", name: "Inbox", type: 2, depth: 1 });
});

test("buildTree : tous les éléments, notes et journal jamais", () => {
  const { nodes, rejected } = buildTree(table(EXCHANGE), { kinds: ALL });
  eq(rejected, []);
  eq([...nodes.keys()].sort(compareIds), ["1", "2", "3", "4", "5", "6", "7", "8", "11", "12", "13", "14", "15", "16"]);
  eq(nodes.get("16"), { parentId: "6", name: "Anniversaires", type: 13, depth: 2 });
});

test("buildTree : un élément n'est choisi que si sa valeur est exactement true", () => {
  const { nodes } = buildTree(table(EXCHANGE), { kinds: { mail: "true", calendar: 1, contacts: true } });
  eq([...nodes.keys()], ["7"]);
});

test("buildTree : chaque élément forme son propre arbre", () => {
  const rows = [
    ["1", "0", "Inbox", 2],
    ["2", "1", "Agenda perso", 13], // calendar under the inbox
    ["3", "2", "Courrier dans l'agenda", 12], // mail under that calendar
    ["4", "0", "Calendar", 8],
    ["5", "4", "Mail sous Calendar", 12],
  ];
  const mailOnly = buildTree(table(rows), { kinds: MAIL }).nodes;
  eq(mailOnly.get("3"), { parentId: "1", name: "Courrier dans l'agenda", type: 12, depth: 2 }, "remonte au dossier de courrier le plus proche");
  eq(mailOnly.get("5"), { parentId: "0", name: "Mail sous Calendar", type: 12, depth: 1 }, "à la racine");
  const all = buildTree(table(rows), { kinds: ALL }).nodes;
  eq(all.get("2"), { parentId: "0", name: "Agenda perso", type: 13, depth: 1 }, "agenda : à la racine des agendas");
  eq(all.get("3").parentId, "1", "le courrier ne passe pas par l'agenda");
  eq(all.get("5").parentId, "0");
});

test("buildTree : cycles rejetés, descendants aussi", () => {
  const rows = [
    ["1", "2", "A", 12],
    ["2", "1", "B", 12],
    ["3", "1", "C", 12],
    ["4", "4", "Moi-même", 12],
    ["5", "0", "Sain", 12],
  ];
  const { nodes, rejected } = buildTree(table(rows), { kinds: MAIL });
  eq([...nodes.keys()], ["5"]);
  eq(rejected, [
    { serverId: "1", reason: "cycle" },
    { serverId: "2", reason: "cycle" },
    { serverId: "3", reason: "parent rejeté" },
    { serverId: "4", reason: "cycle" },
  ]);
});

test("buildTree : parent inconnu, entrée invalide, identifiant réservé", () => {
  const folders = table([
    ["1", "99", "Orphelin", 12],
    ["2", "1", "Sous orphelin", 12],
    ["3", "0", "", 12],
    ["4", "3", "Sous invalide", 12],
    ["0", "0", "Racine", 12],
    ["5", "0", "Type inconnu", 42],
    ["6", "0", "Sain", 12],
  ]);
  folders.set("7", null);
  folders.set(8, { parentId: "0", name: "clé numérique", type: 12 });
  const { nodes, rejected } = buildTree(folders, { kinds: MAIL });
  eq([...nodes.keys()], ["6"]);
  eq(rejected, [
    { serverId: "0", reason: "identifiant réservé" },
    { serverId: "1", reason: "parent inconnu" },
    { serverId: "2", reason: "parent rejeté" },
    { serverId: "3", reason: "entrée invalide" },
    { serverId: "4", reason: "parent rejeté" },
    { serverId: "5", reason: "entrée invalide" },
    { serverId: "7", reason: "entrée invalide" },
    { serverId: null, reason: "entrée invalide" },
  ]);
});

test("buildTree : un dossier d'un élément non choisi n'est pas signalé", () => {
  const { nodes, rejected } = buildTree(table([["1", "99", "Agenda orphelin", 13], ["2", "0", "Courrier", 12]]), { kinds: MAIL });
  eq([...nodes.keys()], ["2"]);
  eq(rejected, []);
});

test(`buildTree : profondeur au plus ${MAX_DEPTH}`, () => {
  const rows = [];
  for (let i = 1; i <= MAX_DEPTH + 3; i++) rows.push([`d${i}`, i === 1 ? "0" : `d${i - 1}`, `N${i}`, 12]);
  const { nodes, rejected } = buildTree(table(rows), { kinds: MAIL });
  eq(nodes.size, MAX_DEPTH);
  eq(nodes.get(`d${MAX_DEPTH}`).depth, MAX_DEPTH);
  eq(rejected, [33, 34, 35].map((i) => ({ serverId: `d${i}`, reason: "trop profond" })));
});

test("buildTree : longue chaîne, en temps linéaire", () => {
  const rows = [];
  for (let i = 1; i <= 100_000; i++) rows.push([`c${i}`, i === 1 ? "0" : `c${i - 1}`, "x", 12]);
  rows.push(["loop1", "loop100000", "x", 12]);
  for (let i = 2; i <= 100_000; i++) rows.push([`loop${i}`, `loop${i - 1}`, "x", 12]);
  const started = Date.now();
  const { nodes, rejected } = buildTree(table(rows), { kinds: MAIL });
  assert(Date.now() - started < 3000, "trop lent");
  eq(nodes.size, MAX_DEPTH);
  eq(rejected.length, 200_000 - MAX_DEPTH);
  eq(rejected.filter((r) => r.reason === "cycle").length, 100_000);
});

test(`buildTree : au plus ${MAX_TREE_FOLDERS} dossiers, les plus proches de la racine d'abord`, () => {
  const rows = [["top", "0", "Haut", 12], ["deep", "top", "Profond", 12]];
  for (let i = 1; i <= MAX_TREE_FOLDERS; i++) rows.push([`r${String(i).padStart(4, "0")}`, "0", `R${i}`, 12]);
  const { nodes, rejected } = buildTree(table(rows), { kinds: MAIL });
  eq(nodes.size, MAX_TREE_FOLDERS);
  assert(nodes.has("top") && !nodes.has("deep"), "le sous-dossier passe après la racine");
  eq(rejected, [
    { serverId: "deep", reason: "trop de dossiers" },
    { serverId: `r${MAX_TREE_FOLDERS}`, reason: "trop de dossiers" },
  ]);
});

test("buildTree : arguments invalides → TypeError", () => {
  throws(() => buildTree(table(EXCHANGE)), TypeError, "sans kinds");
  throws(() => buildTree(table(EXCHANGE), { kinds: null }), TypeError);
  throws(() => buildTree(null, { kinds: MAIL }), TypeError, "pas une Map");
  throws(() => buildTree([["1", {}]], { kinds: MAIL }), TypeError, "tableau");
});

test("buildTree : même résultat quel que soit l'ordre de la table", () => {
  const forward = buildTree(table(EXCHANGE), { kinds: ALL });
  const backward = buildTree(table([...EXCHANGE].reverse()), { kinds: ALL });
  eq([...forward.nodes], [...backward.nodes]);
  eq(localPaths(forward), localPaths(backward));
});

// ── localFolderName ───────────────────────────────────────────────────────

test("localFolderName : caractères interdits sous Windows → _", () => {
  eq(localFolderName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  eq(localFolderName(`a${ch(0)}b${ch(9)}c${ch(0x1f)}d${ch(0x7f)}e${ch(0x85)}f`), "a_b_c_d_e_f", "contrôles");
  eq(localFolderName(`a${ch(0xd800)}b`), "a_b", "demi-paire");
  eq(localFolderName("Réunions 📅 été"), "Réunions 📅 été", "texte ordinaire inchangé");
});

test("localFolderName : points et espaces finaux retirés", () => {
  eq(localFolderName("Archive. . ."), "Archive");
  eq(localFolderName("Notes  "), "Notes");
  eq(localFolderName("...x"), "...x", "points en tête conservés");
  eq(localFolderName("..."), "_", "rien ne reste");
  eq(localFolderName(""), "_");
  eq(localFolderName(null), "_");
});

test("localFolderName : noms de périphériques de Windows suffixés de _", () => {
  const cases = [
    ["CON", "CON_"],
    ["con", "con_"],
    ["Nul", "Nul_"],
    ["PRN", "PRN_"],
    ["aux", "aux_"],
    ["COM1", "COM1_"],
    ["com9", "com9_"],
    ["COM0", "COM0_"],
    ["LPT1", "LPT1_"],
    ["lpt9", "lpt9_"],
    [`COM${ch(0xb9)}`, `COM${ch(0xb9)}_`],
    [`LPT${ch(0xb3)}`, `LPT${ch(0xb3)}_`],
    ["CONIN$", "CONIN$_"],
    ["conout$", "conout$_"],
    ["con.txt", "con_.txt"],
    ["NUL.tar.gz", "NUL_.tar.gz"],
    ["Com1 .x", "Com1_ .x"],
    ["NUL.", "NUL_"],
    ["CON ", "CON_"],
  ];
  for (const [name, expected] of cases) eq(localFolderName(name), expected, name);
  for (const fine of ["CONSOLE", "COM10", "LPT", "COM", "xCON", "CON_", "Aux-Comptes", ".con", "con-txt"]) eq(localFolderName(fine), fine, fine);
});

test("localFolderName : 100 caractères au plus", () => {
  eq(localFolderName("x".repeat(150)), "x".repeat(100));
  eq(localFolderName("😀".repeat(150)), "😀".repeat(100), "caractères, pas unités UTF-16");
  eq(localFolderName(`${"x".repeat(99)}. y`), "x".repeat(99), "point final après la coupe retiré");
  eq(localFolderName(`CON.${"x".repeat(150)}`), `CON_.${"x".repeat(95)}`);
});

// ── localPaths ────────────────────────────────────────────────────────────

test("localPaths : hiérarchie Exchange", () => {
  const paths = localPaths(buildTree(table(EXCHANGE), { kinds: ALL }));
  eq(
    paths,
    new Map([
      ["1", "/Inbox"],
      ["2", "/Drafts"],
      ["3", "/Trash"],
      ["4", "/Sent"],
      ["5", "/Unsent Messages"],
      ["11", "/Junk Email"],
      ["14", "/Projets"],
      ["12", "/Inbox/Clients"],
      ["15", "/Projets/2026"],
      ["13", "/Inbox/Clients/Dupont"],
    ]),
  );
});

test("localPaths : dossier spécial par type, jamais par nom, où qu'il soit", () => {
  const rows = [
    ["1", "0", "Boîte de réception", 2],
    ["2", "0", "Inbox", 12],
    ["3", "0", "Classement", 12],
    ["4", "3", "Éléments envoyés", 5],
    ["5", "4", "2025", 12],
    ["6", "3", "Autre", 12],
  ];
  const paths = localPaths(buildTree(table(rows), { kinds: MAIL }));
  eq(paths.get("1"), "/Inbox");
  eq(paths.get("2"), "/Inbox (2)", "un dossier ordinaire nommé Inbox");
  eq(paths.get("4"), "/Sent", "spécial imbriqué sur le serveur");
  eq(paths.get("5"), "/Sent/2025", "ses sous-dossiers le suivent");
  eq(paths.get("6"), "/Classement/Autre");
});

test("localPaths : un second dossier du même type spécial est ordinaire", () => {
  const rows = [["20", "0", "Inbox", 2], ["3", "0", "Inbox", 2], ["4", "3", "Sous", 12]];
  const tree = buildTree(table(rows), { kinds: MAIL });
  eq(specialFolders(tree), new Map([["3", "inbox"]]));
  const paths = localPaths(tree);
  eq(paths.get("3"), "/Inbox");
  eq(paths.get("20"), "/Inbox (2)");
  eq(paths.get("4"), "/Inbox/Sous");
});

test("localPaths : noms réservés à la racine, quelle que soit la casse", () => {
  eq(RESERVED_ROOT_NAMES, ["Inbox", "Drafts", "Trash", "Sent", "Unsent Messages", "Templates", "Junk", "Archives"]);
  const names = ["inbox", "DRAFTS", "Trash", "sent", "Unsent messages", "Templates", "junk", "ARCHIVES"];
  const rows = names.map((n, i) => [String(i + 1), "0", n, 12]);
  rows.push(["20", "1", "Junk", 12]);
  const paths = localPaths(buildTree(table(rows), { kinds: MAIL }));
  names.forEach((n, i) => eq(paths.get(String(i + 1)), `/${n} (2)`, n));
  eq(paths.get("20"), "/inbox (2)/Junk", "réservé à la racine seulement");
});

test("localPaths : collisions entre frères, casse ignorée, dans l'ordre des ServerId", () => {
  const rows = [
    ["10", "0", "Projets", 12],
    ["9", "0", "projets", 12],
    ["11", "0", "PROJETS", 12],
    ["12", "0", "Projets (2)", 12],
    ["13", "0", "a/b", 12],
    ["14", "0", "a_b", 12],
    ["15", "0", "x.", 12],
    ["16", "0", "X", 12],
  ];
  const paths = localPaths(buildTree(table(rows), { kinds: MAIL }));
  eq(paths.get("9"), "/projets");
  eq(paths.get("10"), "/Projets (3)", "« (2) » est pris par le nom d'origine de 12");
  eq(paths.get("11"), "/PROJETS (4)");
  eq(paths.get("12"), "/Projets (2)");
  eq(paths.get("13"), "/a_b");
  eq(paths.get("14"), "/a_b (2)");
  eq(paths.get("15"), "/x");
  eq(paths.get("16"), "/X (2)");
});

test("localPaths : suffixe sous 100 caractères", () => {
  const long = "L".repeat(120);
  const rows = [];
  for (let i = 1; i <= 12; i++) rows.push([String(i), "0", long, 12]);
  const paths = localPaths(buildTree(table(rows), { kinds: MAIL }));
  eq(paths.get("1"), `/${"L".repeat(100)}`);
  eq(paths.get("2"), `/${"L".repeat(96)} (2)`);
  eq(paths.get("12"), `/${"L".repeat(95)} (12)`);
  for (const p of paths.values()) assert(p.length - 1 <= 100, p);
});

test("localPaths : un pour un sur une grande fratrie de noms qui se ressemblent", () => {
  const rows = [];
  for (let i = 1; i <= 3000; i++) rows.push([String(i), "0", i % 3 === 0 ? `${"p".repeat(97)}${i % 7}` : i % 3 === 1 ? "Dup" : `dup (${i % 50})`, 12]);
  const started = Date.now();
  const paths = localPaths(buildTree(table(rows), { kinds: MAIL }));
  assert(Date.now() - started < 3000, "trop lent");
  eq(paths.size, 3000);
  eq(new Set([...paths.values()].map((p) => p.toLowerCase())).size, 3000);
});

test("localPaths : seuls les dossiers de courrier ont un chemin", () => {
  const paths = localPaths(buildTree(table(EXCHANGE), { kinds: ALL }));
  for (const id of ["6", "7", "8", "16"]) assert(!paths.has(id), id);
  eq(localPaths(buildTree(table(EXCHANGE), { kinds: { mail: false, calendar: true } })).size, 0);
});

test("localPaths : arbre mal formé (hors buildTree) sans boucle ni chemin inventé", () => {
  const nodes = new Map([
    ["1", { parentId: "2", name: "A", type: 12, depth: 1 }],
    ["2", { parentId: "1", name: "B", type: 12, depth: 1 }],
    ["3", { parentId: "0", name: "C", type: 12, depth: 1 }],
    ["4", { parentId: "99", name: "D", type: 12, depth: 1 }],
    ["5", null],
    ["6", { parentId: "3", name: 7, type: 12 }],
  ]);
  eq(localPaths(nodes), new Map([["3", "/C"]]));
  eq(localPaths(null), new Map());
  eq(localPaths({}), new Map());
  const chain = new Map();
  for (let i = 1; i <= 50; i++) chain.set(`k${i}`, { parentId: i === 1 ? ROOT_ID : `k${i - 1}`, name: "n", type: 12 });
  eq(localPaths(chain).size, MAX_DEPTH, "profondeur bornée");
});
