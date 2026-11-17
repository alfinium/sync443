// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Folder hierarchy of a mailbox ([MS-ASCMD] FolderSync) and the local
 * folders it maps to. Every structure is a Map keyed by ServerId: no
 * server string ever becomes a property name.
 *
 *   applyChanges(folders, changes) → Map<ServerId, { parentId, name, type }>
 *   buildTree(folders, { kinds })  → { nodes: Map<ServerId, { parentId, name, type, depth }>, rejected }
 *   localPaths(tree, { archives }) → Map<ServerId, path>
 *
 * Local paths are the paths of the WebExtension folder API of the
 * mailbox's local account: "/" then the folder names from the top, joined
 * with "/" ("/Inbox", "/Inbox/Clients", "/Projets/2026"). Special folders
 * go to the folders Thunderbird itself uses for that role in an account:
 * Inbox (type 2) "/Inbox", Drafts (3) "/Drafts", Deleted Items (4)
 * "/Trash", Sent Items (5) "/Sent", Outbox (6) "/Unsent Messages".
 *
 * Checked in Thunderbird 160: a local account created by the extension has
 * the root folders Inbox, Drafts, Templates, Sent, Archives, Trash and
 * Unsent Messages (the outbox, as in mail.default_sendlater_uri), and
 * Thunderbird flags these by NAME at every start; Junk is flagged by name
 * the same way when it exists (special mailboxes of a local store). So no
 * other server folder may take one of these eight names at the root,
 * whatever the case, unless the engine binds it to that folder on purpose
 * (localPaths: `archives` and `roles`). The server's own "Templates" and
 * "Junk" at the top are bound that way (sync/mailbox.mjs), the account
 * being set never to purge its junk folder (sync443Account); any other
 * folder of such a name gets " (2)".
 */

import * as v from "./sanitize.mjs";

/** ParentId of the folders at the top of the hierarchy. */
export const ROOT_ID = "0";
/** Deepest folder kept (top-level folders have depth 1). */
export const MAX_DEPTH = 32;
/** Most folders a tree keeps. */
export const MAX_TREE_FOLDERS = 5000;
/** Most folders applyChanges stores: new ones beyond are ignored (buildTree reports the excess over 5000). */
export const MAX_STORED_FOLDERS = 10_000;
/**
 * Longest local folder name, in UTF-16 code units: Thunderbird stores a
 * longer name under a hashed file name, and the folder's path (what the
 * WebExtension API gives) then no longer holds its name.
 */
export const MAX_NAME_LENGTH = 55;

/** Folder types of FolderSync ([MS-ASCMD] 2.2.3.186.3) that the engine names. */
export const FOLDER_TYPE = Object.freeze({ INBOX: 2, DRAFTS: 3, TRASH: 4, SENT: 5, OUTBOX: 6, USER_MAIL: 12 });

// Kind of each folder type: mail 1-6 and 12, calendar 8 and 13, contacts 9 and 14, tasks 7 and 15.
const KIND_OF_TYPE = new Map([
  ...[1, 2, 3, 4, 5, 6, 12].map((t) => [t, "mail"]),
  ...[8, 13].map((t) => [t, "calendar"]),
  ...[9, 14].map((t) => [t, "contacts"]),
  ...[7, 15].map((t) => [t, "tasks"]),
]);
const KINDS = ["mail", "calendar", "contacts", "tasks"];
const USE_OF_TYPE = new Map([
  [FOLDER_TYPE.INBOX, "inbox"],
  [FOLDER_TYPE.DRAFTS, "drafts"],
  [FOLDER_TYPE.TRASH, "trash"],
  [FOLDER_TYPE.SENT, "sent"],
  [FOLDER_TYPE.OUTBOX, "outbox"],
]);

/** Local path of each special use (see the header comment). */
export const SPECIAL_PATHS = new Map([
  ["inbox", "/Inbox"],
  ["drafts", "/Drafts"],
  ["trash", "/Trash"],
  ["sent", "/Sent"],
  ["outbox", "/Unsent Messages"],
]);
/** The local account's archives folder (Thunderbird's "Archive" action), synchronised once bound (see localPaths). */
export const ARCHIVES_PATH = "/Archives";
/**
 * Local folders that hold a role of Thunderbird's by their name, and that
 * the server's folder of the same name at the top is bound to: role → path.
 */
export const ROLE_PATHS = new Map([
  ["templates", "/Templates"],
  ["junk", "/Junk"],
]);
/** Names no ordinary folder takes at the root (compared without regard to case, nor to look-alike letters). */
export const RESERVED_ROOT_NAMES = Object.freeze(["Inbox", "Drafts", "Trash", "Sent", "Unsent Messages", "Templates", "Junk", "Archives"]);

/** Special use of a folder type: 2 inbox, 3 drafts, 4 trash, 5 sent, 6 outbox, otherwise null. */
export function specialUse(type) {
  return USE_OF_TYPE.get(type) ?? null;
}

/** "mail", "calendar", "contacts", "tasks", or null for the other types (notes, journal…). */
export function kindOf(type) {
  return KIND_OF_TYPE.get(type) ?? null;
}

/** ServerId order: shorter first, then by UTF-16 code units ("9" before "10"). Total and deterministic. */
export function compareIds(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── applyChanges ──────────────────────────────────────────────────────────

/**
 * The folder table after the changes of a FolderSync response
 * (protocol.parseFolderSync), applied in order. The input Map is not
 * modified. An Add or an Update stores { parentId, name, type } (an Update
 * of an unknown folder adds it); a Delete removes the folder, and, once
 * every change is applied, every folder still below a deleted one (a
 * deleted folder takes its subfolders with it). A change that does not
 * validate is ignored, and so is a new folder once MAX_STORED_FOLDERS are
 * stored. Cycles and unknown parents are left for buildTree to report.
 */
export function applyChanges(folders, changes) {
  const out = folders instanceof Map ? new Map(folders) : new Map();
  const deleted = new Set();
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || typeof change !== "object") continue;
    const serverId = v.itemId(change.serverId);
    if (serverId === null) continue;
    if (change.op === "delete") {
      out.delete(serverId);
      deleted.add(serverId);
      continue;
    }
    if (change.op !== "add" && change.op !== "update") continue;
    const parentId = v.itemId(change.parentId);
    const name = typeof change.displayName === "string" ? v.folderName(change.displayName) : null;
    const type = change.type;
    if (parentId === null || name === null || !Number.isInteger(type) || type < 1 || type > 19) continue;
    if (!out.has(serverId) && out.size >= MAX_STORED_FOLDERS) continue;
    out.set(serverId, { parentId, name, type });
    deleted.delete(serverId);
  }
  if (deleted.size) {
    // Below a deleted folder? Each folder is decided once; a cycle is not.
    const below = new Map();
    for (const id of out.keys()) {
      if (below.has(id)) continue;
      const path = [];
      const onPath = new Set();
      let current = id;
      let verdict;
      for (;;) {
        if (below.has(current)) {
          verdict = below.get(current);
          break;
        }
        const entry = out.get(current);
        if (!entry) {
          verdict = deleted.has(current);
          break;
        }
        if (onPath.has(current)) {
          verdict = false;
          break;
        }
        onPath.add(current);
        path.push(current);
        current = entry.parentId;
      }
      for (const p of path) below.set(p, verdict);
    }
    for (const [id, gone] of below) if (gone) out.delete(id);
  }
  return out;
}

// ── buildTree ─────────────────────────────────────────────────────────────

const UNKNOWN_PARENT = Symbol("unknown parent");
const INVALID_PARENT = Symbol("invalid parent");

/**
 * The tree of the folders to synchronise, from the folder table.
 *
 * `kinds` is the mailbox's `sync` object ({ mail, calendar, contacts,
 * tasks }): a kind is kept when its value is exactly true; folders of the
 * other kinds, and of types no kind covers (notes, journal…), are left out
 * without being reported. A missing `kinds` or a folder table that is not a
 * Map is a programming error (TypeError): an empty tree would read as
 * "every folder is gone".
 *
 * Checked on the whole server hierarchy, every kind included, and reported
 * in `rejected` (sorted by ServerId) for the folders of the chosen kinds:
 *  - "entrée invalide": malformed entry (reported whatever its kind);
 *  - "identifiant réservé": ServerId "0", which names the root;
 *  - "parent inconnu": ParentId neither "0" nor a folder of the table;
 *  - "cycle": the folder is on a cycle of ParentIds;
 *  - "parent rejeté": an ancestor is rejected for one of the reasons above;
 *  - "trop profond": deeper than MAX_DEPTH (32), as are all its subfolders;
 *  - "trop de dossiers": beyond MAX_TREE_FOLDERS (5000), the folders closest
 *    to the root being kept first (then by ServerId), so a kept folder's
 *    kept ancestors are always kept too.
 *
 * Nodes: { parentId, name, type, depth }, in order of server depth then
 * ServerId (parents first). parentId is the nearest ancestor of the SAME
 * kind that is kept, or "0": a mail folder under a calendar keeps its place
 * among mail folders, and each kind forms its own tree. depth is the depth
 * in that tree (1 at the top). name is the server name, unchanged.
 */
export function buildTree(folders, { kinds } = {}) {
  if (!(folders instanceof Map)) throw new TypeError("buildTree : Map de dossiers attendue");
  if (!kinds || typeof kinds !== "object") throw new TypeError("buildTree : kinds attendu ({ mail, calendar, contacts, tasks })");
  const chosen = new Set(KINDS.filter((k) => kinds[k] === true));
  const rejected = [];
  const valid = new Map();
  const invalid = new Set();

  for (const [id, f] of folders) {
    if (typeof id !== "string" || v.itemId(id) === null) {
      rejected.push({ serverId: typeof id === "string" ? id : null, reason: "entrée invalide" });
      continue;
    }
    if (id === ROOT_ID) {
      rejected.push({ serverId: id, reason: "identifiant réservé" });
      invalid.add(id);
      continue;
    }
    const ok =
      f && typeof f === "object" && v.itemId(f.parentId) !== null && typeof f.name === "string" && f.name.length > 0 &&
      Number.isInteger(f.type) && f.type >= 1 && f.type <= 19;
    if (!ok) {
      rejected.push({ serverId: id, reason: "entrée invalide" });
      invalid.add(id);
      continue;
    }
    valid.set(id, f);
  }

  // Server depth of each valid folder, or the reason it cannot be placed.
  // Each folder is walked once: linear in the number of folders.
  const state = new Map();
  for (const id of valid.keys()) {
    if (state.has(id)) continue;
    const path = [];
    const onPath = new Map();
    let current = id;
    let outcome; // state of the parent of path[path.length - 1]
    for (;;) {
      onPath.set(current, path.length);
      path.push(current);
      const parent = valid.get(current).parentId;
      if (parent === ROOT_ID) {
        outcome = 0;
        break;
      }
      if (state.has(parent)) {
        outcome = state.get(parent);
        break;
      }
      if (onPath.has(parent)) {
        const start = onPath.get(parent);
        for (let i = start; i < path.length; i++) state.set(path[i], "cycle");
        path.length = start;
        outcome = "cycle";
        break;
      }
      if (!valid.has(parent)) {
        outcome = invalid.has(parent) ? INVALID_PARENT : UNKNOWN_PARENT;
        break;
      }
      current = parent;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      let s;
      if (typeof outcome === "number") s = outcome + 1 > MAX_DEPTH ? "trop profond" : outcome + 1;
      else if (outcome === UNKNOWN_PARENT) s = "parent inconnu";
      else if (outcome === "trop profond") s = "trop profond";
      else s = "parent rejeté";
      state.set(path[i], s);
      outcome = s;
    }
  }

  const candidates = [];
  for (const [id, f] of valid) {
    const kind = kindOf(f.type);
    if (!chosen.has(kind)) continue;
    const s = state.get(id);
    if (typeof s === "number") candidates.push([id, f, s, kind]);
    else rejected.push({ serverId: id, reason: s });
  }
  candidates.sort((a, b) => a[2] - b[2] || compareIds(a[0], b[0]));
  for (const [id] of candidates.splice(MAX_TREE_FOLDERS)) rejected.push({ serverId: id, reason: "trop de dossiers" });

  const nodes = new Map();
  const kindOfNode = new Map();
  for (const [id, f, , kind] of candidates) {
    // Nearest kept ancestor of the same kind: at most MAX_DEPTH steps, all on valid folders.
    let parentId = ROOT_ID;
    for (let p = f.parentId; p !== ROOT_ID; p = valid.get(p).parentId) {
      if (kindOfNode.get(p) === kind) {
        parentId = p;
        break;
      }
    }
    const depth = parentId === ROOT_ID ? 1 : nodes.get(parentId).depth + 1;
    nodes.set(id, { parentId, name: f.name, type: f.type, depth });
    kindOfNode.set(id, kind);
  }
  rejected.sort((a, b) => (a.serverId === null ? 1 : b.serverId === null ? -1 : compareIds(a.serverId, b.serverId)));
  return { nodes, rejected };
}

// ── Local names and paths ─────────────────────────────────────────────────

// Characters Windows refuses in a file name, the path separator, and the
// characters for which Thunderbird hashes a folder's file name (";", "#").
const FORBIDDEN = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|", ";", "#"]);
// Names of Thunderbird's own files next to a folder's ("Name.msf" index, "Name.sbd" subfolders).
const STORAGE_SUFFIX = /\.(?:msf|sbd)$/i;
// Device names of Windows, with or without an extension (superscript digits included).
const SUPERSCRIPTS = String.fromCharCode(0xb9, 0xb2, 0xb3);
const DEVICE = new RegExp(`^(?:CON|PRN|AUX|NUL|CONIN\\$|CONOUT\\$|COM[0-9${SUPERSCRIPTS}]|LPT[0-9${SUPERSCRIPTS}])$`, "i");

// Trailing dots and spaces (Windows drops them), and a trailing "~" (Thunderbird hashes such a name).
const trimEnd = (s) => s.replace(/[. ]+$/, "").replace(/~$/, "_");

/**
 * A folder name valid on Windows, macOS and Linux, that Thunderbird stores
 * under the name itself (so the folder's path ends with it):
 *  - / \ : * ? " < > | ; #, control characters and lone surrogates
 *    become "_";
 *  - a leading "." becomes "_" (hidden file, hashed by Thunderbird);
 *  - trailing dots and spaces are removed, a trailing "~" becomes "_";
 *  - a Windows device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9, CONIN$,
 *    CONOUT$), alone or before an extension, gets "_" after it ("NUL_",
 *    "con_.txt"), since Windows reads "NUL.txt" as the device too;
 *  - a name ending in ".msf" or ".sbd" (any case), the names of
 *    Thunderbird's own files next to a folder's, gets "_" after it;
 *  - at most MAX_NAME_LENGTH (55) UTF-16 code units;
 *  - nothing left: "_".
 */
export function localFolderName(name) {
  const source = typeof name === "string" ? name.normalize("NFC") : "";
  let s = "";
  for (const c of source) {
    if (s.length + c.length > MAX_NAME_LENGTH) break;
    const code = c.codePointAt(0);
    const bad = code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff) || FORBIDDEN.has(c);
    s += bad ? "_" : c;
  }
  if (s.startsWith(".")) s = `_${s.slice(1)}`;
  s = trimEnd(s);
  const dot = s.indexOf(".");
  const stem = (dot < 0 ? s : s.slice(0, dot)).replace(/ +$/, "");
  if (DEVICE.test(stem)) s = trimEnd(v.cut(`${stem}_${s.slice(stem.length)}`, MAX_NAME_LENGTH));
  if (STORAGE_SUFFIX.test(s)) s = `${v.cut(s, MAX_NAME_LENGTH - 1)}_`;
  return s || "_";
}

/** Comparison key: names equal for a case-insensitive file system get the same key. */
export const nameKey = (name) => name.toUpperCase().toLowerCase().normalize("NFC");

// Letters of other scripts drawn like Latin ones (common look-alikes), and Latin letters drawn alike.
const LOOKALIKES = new Map(
  [
    ["a", "\u0430\u03b1\u0251"], ["b", "\u0432\u044c\u03b2"], ["c", "\u0441\u03f2"], ["d", "\u0501"], ["e", "\u0435\u03b5\u0454"],
    ["h", "\u04bb\u043d\u0570"], ["j", "\u0458\u03f3"], ["k", "\u043a\u03ba"], ["m", "\u043c"], ["n", "\u043f\u03b7\u0578"],
    ["o", "\u043e\u03bf\u03c3\u0585\u0030"], ["p", "\u0440\u03c1"], ["q", "\u051b"], ["r", "\u0433"], ["s", "\u0455\u03c2"],
    ["t", "\u0442\u03c4"], ["u", "\u03c5\u057d\u03bc"], ["v", "\u03bd"], ["w", "\u051d\u0461"], ["x", "\u0445\u03c7"],
    ["y", "\u0443\u03b3"], ["l", "il1|\u0456\u03b9\u0131\u0269\u04cf\u0399\u0406"],
  ].flatMap(([latin, others]) => [...others].map((c) => [c, latin])),
);

/**
 * Look-alike key: names a reader may take for one another (case, width,
 * accents, letters of other scripts drawn like Latin ones, I l 1 and 0 o)
 * get the same key. Used against the reserved root names only.
 */
function lookalikeKey(name) {
  let out = "";
  for (const c of name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()) out += LOOKALIKES.get(c) ?? c;
  return out;
}

const RESERVED_KEYS = RESERVED_ROOT_NAMES.map(nameKey);
const RESERVED_LOOKALIKES = new Set(RESERVED_ROOT_NAMES.map(lookalikeKey));
const SUFFIX_ROOM = 6; // " (999)"

/**
 * Names for siblings given in ServerId order, unique without regard to case
 * and distinct from `reserved` keys. The first holder of a name keeps it;
 * the others get " (2)", " (3)"… (the first free one, shortening the name
 * to stay within MAX_NAME_LENGTH). A counter per name keeps the work linear.
 */
function uniqueNames(rawNames, reserved, { root = false } = {}) {
  const bases = rawNames.map(localFolderName);
  const used = new Set(reserved);
  const names = new Array(bases.length);
  bases.forEach((base, i) => {
    const key = nameKey(base);
    // At the root, a name a reader may take for a reserved one ("Іnbox" in Cyrillic, "lnbox") is suffixed too.
    if (root && RESERVED_LOOKALIKES.has(lookalikeKey(base))) return;
    if (!used.has(key)) {
      used.add(key);
      names[i] = base;
    }
  });
  const counters = new Map();
  bases.forEach((base, i) => {
    if (names[i] !== undefined) return;
    const counterKey = nameKey(v.cut(base, MAX_NAME_LENGTH - SUFFIX_ROOM));
    let k = counters.get(counterKey) ?? 2;
    let candidate;
    do {
      const suffix = ` (${k++})`;
      candidate = v.cut(base, MAX_NAME_LENGTH - suffix.length) + suffix;
    } while (used.has(nameKey(candidate)));
    counters.set(counterKey, k);
    used.add(nameKey(candidate));
    names[i] = candidate;
  });
  return names;
}

/**
 * Which mail folder holds each special use: for each type 2 to 6, the first
 * folder of that type in ServerId order (by type, never by name). Another
 * folder of the same type is an ordinary folder. → Map<ServerId, use>
 */
export function specialFolders(tree) {
  const nodes = tree instanceof Map ? tree : tree?.nodes;
  const out = new Map();
  if (!(nodes instanceof Map)) return out;
  const taken = new Set();
  const ids = [...nodes.keys()].filter((id) => typeof id === "string").sort(compareIds);
  for (const id of ids) {
    const use = specialUse(nodes.get(id)?.type);
    if (use && !taken.has(use)) {
      taken.add(use);
      out.set(id, use);
    }
  }
  return out;
}

/**
 * Local path of every mail folder of a tree (the buildTree result, or its
 * nodes Map), one for one: no two folders share a path, even without
 * regard to case. Folders of other kinds get no path (they become
 * calendars, address books or task lists, not folders).
 *  - Special folders (see specialFolders) go to their special path at the
 *    root (SPECIAL_PATHS), wherever they are on the server; their
 *    subfolders follow them ("/Inbox/Clients").
 *  - Other folders go under their parent's path, with localFolderName.
 *    Siblings whose names collide without regard to case, and folders at
 *    the root named like RESERVED_ROOT_NAMES, get " (2)", " (3)"… in
 *    ServerId order: the same tree always gives the same paths.
 *  - A folder that does not hang from the root through mail folders, or
 *    deeper than MAX_DEPTH, gets no path (never the case for a tree from
 *    buildTree).
 *  - `archives` (optional): the ServerId of the folder the mailbox keeps
 *    its archives in (created by the engine for Thunderbird's "Archive"
 *    action, never chosen by name). Unless it is a special folder, it goes
 *    to "/Archives", the local account's archives folder, with its
 *    subfolders.
 *  - `roles` (optional): { templates?, junk? }, the ServerId of the folder
 *    bound to each role of ROLE_PATHS. Unless it is a special folder or
 *    the archives folder, it goes to the role's path, with its subfolders.
 */
export function localPaths(tree, { archives = null, roles = null } = {}) {
  const nodes = tree instanceof Map ? tree : tree?.nodes;
  const paths = new Map();
  if (!(nodes instanceof Map)) return paths;
  const mail = new Map();
  for (const id of [...nodes.keys()].filter((k) => typeof k === "string").sort(compareIds)) {
    const n = nodes.get(id);
    if (n && typeof n === "object" && kindOf(n.type) === "mail" && typeof n.name === "string") mail.set(id, n);
  }
  const special = specialFolders(mail);
  const pinned = new Map([...special].map(([id, use]) => [id, SPECIAL_PATHS.get(use)]));
  if (typeof archives === "string" && mail.has(archives) && !special.has(archives)) pinned.set(archives, ARCHIVES_PATH);
  for (const [role, path] of ROLE_PATHS) {
    const id = roles?.[role];
    if (typeof id === "string" && mail.has(id) && !special.has(id) && !pinned.has(id)) pinned.set(id, path);
  }
  const children = new Map(); // parentId → ids in ServerId order
  for (const [id, n] of mail) {
    if (pinned.has(id)) continue;
    if (!children.has(n.parentId)) children.set(n.parentId, []);
    children.get(n.parentId).push(id);
  }
  const queue = [[ROOT_ID, "", 0, RESERVED_KEYS]];
  for (const [id, path] of pinned) {
    paths.set(id, path);
    queue.push([id, path, 1, []]);
  }
  for (let i = 0; i < queue.length; i++) {
    const [parentId, parentPath, depth, reserved] = queue[i];
    const ids = children.get(parentId);
    if (!ids || depth >= MAX_DEPTH) continue;
    children.delete(parentId); // each list is placed once, even if a malformed tree names a parent twice
    const names = uniqueNames(
      ids.map((id) => mail.get(id).name),
      reserved,
      { root: parentId === ROOT_ID },
    );
    ids.forEach((id, k) => {
      const path = `${parentPath}/${names[k]}`;
      paths.set(id, path);
      queue.push([id, path, depth + 1, []]);
    });
  }
  return paths;
}
