// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * The invitation mails of one mailbox (docs/CALENDAR-DESIGN.md, "Finding
 * the invitation mail"): a bounded table
 *
 *   UID of the meeting → [{ collectionId, serverId, at, organizer, start, kind }]
 *
 * that says which mails (ServerId in a collection) carry an invitation to
 * a meeting, and what each one says of it: the organizer's address, when
 * the meeting starts, and the kind of folder the mail is in. The mail
 * engine keeps it current (sync/mail.mjs, through `ctx.invitations`); the
 * answer flow (sync/scheduling.mjs) reads it to name, in MeetingResponse,
 * the request the user is answering.
 *
 * The UID is chosen by whoever sent the invitation, and anyone who knows
 * the UID of a meeting can send a mail that carries it. So:
 *  - a later mail never takes the place of an earlier one: every mail of a
 *    UID is kept (the most recent ones, when there are too many);
 *  - a mail is named for an answer only when the organizer and the start
 *    it gives are those of the event the user answered: the most recent
 *    of those. A mail that says otherwise is never named, and changes
 *    nothing for the others. When no mail qualifies, the answer flow
 *    answers the calendar item where the protocol allows it, or sends
 *    nothing (find);
 *  - mails in the folders where mail nobody chose to receive ends up, or
 *    where the user's own copies are (junk, sent items, drafts, outbox,
 *    deleted items), are never noted: see folderKind.
 * The UID never selects a local item (rule 21), and the reply goes to the
 * organizer of the event the user answered, whatever the table says.
 *
 * At most MAX_INVITATIONS mails in all, and MAX_PER_UID for one meeting;
 * the oldest is dropped first. Stored in the mailbox's record
 * "invitations" (a Map record: no outside string becomes a property name),
 * read once and then kept in memory; every change is written at once. One
 * instance per mailbox, shared by the mail engine and the scheduler.
 *
 * Nothing here throws on bad input, and the calls made by the mail engine
 * (noteMail, forget, moved, forgetCollection) never throw at all: a table
 * that cannot be written must not cost a mail.
 */

import * as v from "../core/sanitize.mjs";
import { parseUtc, parseDate, localDateOf, UTC_ZONE } from "../core/eas-timezone.mjs";

/** Most invitation mails known for a mailbox. */
export const MAX_INVITATIONS = 500;
/** Most mails known for one meeting. */
export const MAX_PER_UID = 8;
/** Longest UID kept (the `uid` of an item description). */
const MAX_UID = 300;
const RECORD = "invitations";
/** MeetingMessageType 6: a copy sent to a delegator, for information; it is not to be answered. */
const DELEGATED = 6;
const REQUEST_CLASS = "ipm.schedule.meeting.request";

/** The kinds of folder whose mails are noted: the inbox, and the folders the user (or a rule of theirs) files mail in. */
const NOTED_KINDS = new Set(["inbox", "mail"]);

const lower = (s) => s.toLowerCase();

/** A UID as the descriptions carry it: 1 to 300 characters on one clean line, taken as it is or not at all. */
function uidOf(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_UID || !value.isWellFormed()) return null;
  return v.cleanText(value, { max: MAX_UID, singleLine: true, stripBidi: true }) === value ? value : null;
}

/** When a meeting starts, as an item description says it: a UTC, or a DATE for an all-day meeting; null otherwise. */
const startOf = (value) => (parseUtc(value) !== null || parseDate(value) !== null ? value : null);

// ── Which mails count ─────────────────────────────────────────────────────

/**
 * The UID of the meeting a mail invites to, or null when the mail is not an
 * invitation that can be answered: `email` is what core/mail-codec.mjs
 * readEmail gives. A mail counts when it has a MeetingRequest with a UID,
 * is not a delegate's copy (MeetingMessageType 6), and its message class,
 * when the server gives one, is that of a meeting request (a cancellation
 * carries a MeetingRequest too, and must not take the place of the
 * invitation it cancels).
 */
export function invitationUid(email) {
  const request = email?.meetingRequest;
  if (!request || typeof request !== "object") return null;
  if (request.messageType === DELEGATED) return null;
  const messageClass = email.messageClass;
  if (typeof messageClass === "string" && !messageClass.toLowerCase().startsWith(REQUEST_CLASS)) return null;
  return uidOf(request.uid);
}

/**
 * When the meeting of a MeetingRequest starts (core/meeting-request.mjs
 * readMeetingRequest), in the form the `start` of an event description
 * has, so that the two can be compared: the UTC instant, or, for an
 * all-day meeting, the day that instant is in the time zone the request
 * gives (UTC when it gives none). null when the request has no usable
 * start.
 */
export function invitationStart(request) {
  const ms = parseUtc(request?.start);
  if (ms === null) return null;
  if (request.allDay !== true) return request.start;
  try {
    return localDateOf(request.zone ?? UTC_ZONE, ms);
  } catch {
    return null; // a zone that cannot be used, or a day outside the supported years
  }
}

/**
 * Names of the folder that holds junk mail, as servers give them: in the
 * ten languages of the interface, in a few other languages mailboxes are
 * often set to, and the names common to all. Compared without case,
 * accents, blanks or hyphens, and without the " (2)" a local folder gets
 * when its name is taken (core/folder-tree.mjs).
 */
const JUNK_NAMES = new Set(
  [
    "Junk", "Junk Email", "Junk E-mail", "Junk Mail", "Spam", "Bulk", "Bulk Mail",
    "Courrier indésirable", "Indésirables", "Pourriel",
    "Unerwünscht", "Unerwünschte Werbung",
    "Correo no deseado", "Correo electrónico no deseado",
    "Posta indesiderata",
    "Lixo Eletrônico", "Correio de lixo eletrônico",
    "Wiadomości-śmieci", "Niechciane",
    "Nevyžádaná pošta",
    "Нежелательная почта", "Спам",
    "迷惑メール",
    "Ongewenste e-mail", "Skräppost", "Uønsket mail", "Søppelpost", "Roskaposti", "Levélszemét", "Önemsiz E-posta", "垃圾邮件", "垃圾郵件", "정크 메일",
  ].map(junkKey),
);

function junkKey(name) {
  return name
    .replace(/ \(\d{1,3}\)$/, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s._-]/g, "");
}

const SPECIAL_ROOTS = new Map([["inbox", "inbox"], ["drafts", "drafts"], ["sent", "sent"], ["trash", "trash"], ["unsent messages", "outbox"], ["junk", "junk"]]);

/**
 * The kind of mail folder a collection is, for this table: "inbox",
 * "drafts", "sent", "outbox", "trash", "junk", or "mail" for any other
 * folder; null when it cannot be told (no local folder).
 *
 * `path`: the local path of the collection. The server's special folders
 * are recognized by their type when the folder list is read, and go to
 * fixed local folders (core/folder-tree.mjs: "/Inbox", "/Drafts", "/Sent",
 * "/Trash", "/Unsent Messages"), their subfolders below them: the first
 * part of the path says which. `inTrash`: the mail engine knows the
 * collection to be the server's Deleted Items, or inside it.
 *
 * ActiveSync has no folder type for junk mail: that folder is an ordinary
 * one for the protocol. It is recognized by its name (JUNK_NAMES), wherever
 * it is in the path; a junk folder named otherwise is not recognized, and
 * its mails are then held to the same test as any other (find).
 */
export function folderKind(path, { inTrash = false } = {}) {
  if (inTrash === true) return "trash";
  if (typeof path !== "string" || !path.startsWith("/") || path.length < 2) return null;
  const parts = path.slice(1).split("/");
  if (parts.some((part) => JUNK_NAMES.has(junkKey(part)))) return "junk";
  return SPECIAL_ROOTS.get(parts[0].toLowerCase()) ?? "mail";
}

// ── The table ─────────────────────────────────────────────────────────────

export class InvitationTable {
  #records;
  #now;
  #log;
  #mails = null; // Map<"collectionId\nserverId", { uid, collectionId, serverId, at, organizer, start, kind }>, oldest first
  #byUid = new Map(); // uid → Set of keys of #mails
  #queue = Promise.resolve();

  /**
   * @param {object} o
   * @param {object} o.records   store.mailbox(id)
   * @param {() => number} [o.now]
   * @param {object} [o.log]
   */
  constructor({ records, now = () => Date.now(), log = null }) {
    if (!records) throw new TypeError("InvitationTable : enregistrements manquants");
    this.#records = records;
    this.#now = now;
    this.#log = log;
  }

  static #key(collectionId, serverId) {
    return `${collectionId}\n${serverId}`;
  }

  /** One operation at a time: a read-modify-write never crosses another. */
  #serial(fn) {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** One stored mail, checked like anything read back from storage; null when it cannot be used. */
  static #check(uid, value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const collectionId = v.itemId(value.collectionId);
    const serverId = v.itemId(value.serverId);
    if (!collectionId || !serverId || typeof value.kind !== "string" || !NOTED_KINDS.has(value.kind)) return null;
    return {
      uid,
      collectionId,
      serverId,
      at: Number.isFinite(value.at) ? value.at : 0,
      organizer: v.emailAddress(value.organizer),
      start: startOf(value.start),
      kind: value.kind,
    };
  }

  #insert(mail) {
    const key = InvitationTable.#key(mail.collectionId, mail.serverId);
    this.#mails.set(key, mail);
    let keys = this.#byUid.get(mail.uid);
    if (!keys) this.#byUid.set(mail.uid, (keys = new Set()));
    keys.add(key);
  }

  #delete(key) {
    const mail = this.#mails.get(key);
    if (!mail) return false;
    this.#mails.delete(key);
    const keys = this.#byUid.get(mail.uid);
    keys?.delete(key);
    if (keys && !keys.size) this.#byUid.delete(mail.uid);
    return true;
  }

  /** The bounds: MAX_PER_UID mails for the meeting `uid` (its first and its most recent), MAX_INVITATIONS in all (the oldest going first). */
  #bound(uid) {
    const keys = this.#byUid.get(uid);
    // Of one meeting, the first mail noted stays with the most recent ones: mails sent later under its UID
    // cannot push the first invitation out.
    while (keys && keys.size > MAX_PER_UID) this.#delete([...keys][1]);
    while (this.#mails.size > MAX_INVITATIONS) this.#delete(this.#mails.keys().next().value);
  }

  async #load() {
    if (this.#mails) return this.#mails;
    let raw = new Map();
    try {
      raw = await this.#records.getMap(RECORD);
    } catch {
      raw = new Map(); // unreadable: an empty table
    }
    // Read in the stored order, then put back in the order they were noted in (a stable sort: ties keep their order).
    const read = [];
    const seen = new Set();
    for (const [uid, list] of raw) {
      if (read.length >= 4 * MAX_INVITATIONS) break;
      // A value that is not a list is not of this table (a record of an earlier build named one mail and
      // said nothing of its meeting): nothing is taken from it.
      if (uidOf(uid) === null || !Array.isArray(list)) continue;
      for (const value of list.slice(-4 * MAX_PER_UID)) {
        const mail = InvitationTable.#check(uid, value);
        const key = mail && InvitationTable.#key(mail.collectionId, mail.serverId);
        if (!mail || seen.has(key)) continue; // one mail, one meeting
        seen.add(key);
        read.push(mail);
      }
    }
    read.sort((a, b) => a.at - b.at);
    this.#mails = new Map();
    this.#byUid = new Map();
    for (const mail of read) {
      this.#insert(mail);
      this.#bound(mail.uid);
    }
    return this.#mails;
  }

  async #save() {
    if (!this.#mails.size) {
      await this.#records.remove(RECORD);
      return;
    }
    const stored = new Map();
    for (const [uid, keys] of this.#byUid) {
      stored.set(uid, [...keys].map((key) => {
        const { collectionId, serverId, at, organizer, start, kind } = this.#mails.get(key);
        return { collectionId, serverId, at, organizer, start, kind };
      }));
    }
    await this.#records.setMap(RECORD, stored);
  }

  /**
   * The mail `serverId` of `collectionId` invites to the meeting `uid`: it
   * is noted, as the newest mail of the table, with what it says of the
   * meeting (`organizer`: an address; `start`: a UTC, or a DATE for an
   * all-day meeting; either may be null, and such a mail agrees with no
   * event) and the `kind` of its folder (folderKind). The other mails of
   * that meeting stay. → true when it was noted.
   *
   * A mail in a folder whose kind is not noted, or cannot be told, is not
   * noted; if the table knew it, it is forgotten.
   */
  note({ uid, collectionId, serverId, organizer = null, start = null, kind } = {}) {
    const id = uidOf(uid);
    const cid = v.itemId(collectionId);
    const sid = v.itemId(serverId);
    if (id === null || !cid || !sid) return Promise.resolve(false);
    return this.#serial(async () => {
      await this.#load();
      const key = InvitationTable.#key(cid, sid);
      const known = this.#delete(key); // noted again: the newest; it may now say another meeting
      if (typeof kind !== "string" || !NOTED_KINDS.has(kind)) {
        if (known) await this.#save();
        return false;
      }
      this.#insert({ uid: id, collectionId: cid, serverId: sid, at: this.#now(), organizer: v.emailAddress(organizer), start: startOf(start), kind });
      this.#bound(id);
      await this.#save();
      return true;
    });
  }

  /**
   * For the mail engine: a mail was added to a collection. `email` is what
   * readEmail gave; `kind`, the kind of the collection's folder
   * (folderKind). Anything that is not an answerable invitation is ignored
   * (invitationUid), and so is any mail of a folder that is not noted
   * (note). Never throws.
   */
  async noteMail(collectionId, serverId, email, kind) {
    try {
      const uid = invitationUid(email);
      if (uid === null) return false;
      const request = email.meetingRequest;
      return await this.note({ uid, collectionId, serverId, organizer: request.organizer, start: invitationStart(request), kind });
    } catch {
      this.#log?.warn?.("Invitations : table non enregistrée.");
      return false;
    }
  }

  /** The mail is gone from its collection (deleted, moved away): it is forgotten, if it was known. Never throws. */
  async forget(collectionId, serverId) {
    try {
      return await this.#serial(async () => {
        await this.#load();
        if (!this.#delete(InvitationTable.#key(collectionId, serverId))) return false; // most mails are not invitations: nothing is written
        await this.#save();
        return true;
      });
    } catch {
      this.#log?.warn?.("Invitations : table non enregistrée.");
      return false;
    }
  }

  /**
   * The mail was moved on the server to another collection, where it is
   * `toServerId` (MoveItems DstMsgId): what the table knows of it follows
   * it, keeping its age, with the `kind` of its new folder. Without a new
   * ServerId, or in a folder whose mails are not noted (deleted items,
   * junk…), it is forgotten. Never throws.
   */
  async moved(collectionId, serverId, toCollectionId, toServerId, kind) {
    const cid = v.itemId(toCollectionId);
    const sid = v.itemId(toServerId);
    if (!cid || !sid || typeof kind !== "string" || !NOTED_KINDS.has(kind)) return this.forget(collectionId, serverId);
    try {
      return await this.#serial(async () => {
        const mails = await this.#load();
        const from = InvitationTable.#key(collectionId, serverId);
        const mail = mails.get(from);
        if (!mail) return false;
        const to = InvitationTable.#key(cid, sid);
        if (to !== from) {
          this.#delete(to); // whatever was known under the new ids is not this mail
          // In place: the mail keeps its age, and its rank among the mails of its meeting.
          const entries = [...mails].map(([key, value]) => (key === from ? [to, { ...value, collectionId: cid, serverId: sid, kind }] : [key, value]));
          this.#mails = new Map();
          this.#byUid = new Map();
          for (const [, value] of entries) this.#insert(value);
        } else {
          mail.kind = kind;
        }
        await this.#save();
        return true;
      });
    } catch {
      this.#log?.warn?.("Invitations : table non enregistrée.");
      return false;
    }
  }

  /** The collection is rebuilt from scratch, or gone: every mail of it is forgotten. Never throws. → number forgotten */
  async forgetCollection(collectionId) {
    try {
      return await this.#serial(async () => {
        const mails = await this.#load();
        const doomed = [...mails].filter(([, mail]) => mail.collectionId === collectionId).map(([key]) => key);
        if (!doomed.length) return 0;
        for (const key of doomed) this.#delete(key);
        await this.#save();
        return doomed.length;
      });
    } catch {
      this.#log?.warn?.("Invitations : table non enregistrée.");
      return 0;
    }
  }

  /** Every mail known for the meeting `uid`, oldest first: [{ collectionId, serverId, at, organizer, start, kind }]. */
  candidates(uid) {
    if (uidOf(uid) === null) return Promise.resolve([]);
    return this.#serial(async () => {
      const mails = await this.#load();
      return [...(this.#byUid.get(uid) ?? [])].map((key) => {
        const { collectionId, serverId, at, organizer, start, kind } = mails.get(key);
        return { collectionId, serverId, at, organizer, start, kind };
      });
    });
  }

  /**
   * The invitation mail to name when the user answers the event `event`
   * ({ organizer: the organizer's address, start: the event's `start` }) of
   * the meeting `uid`: { collectionId, serverId, at }, or null.
   *
   * Among the mails known for that UID, only those that give that
   * organizer (whatever the case of the address) and that start are
   * candidates: the most recent of them is the one to answer. A mail that
   * says otherwise (another organizer, another start, or none that could
   * be read) is ignored: it is never named, and it does not keep the
   * others from being named, so that knowing a UID is not enough to block
   * the user's answers, and an invitation sent again for another time
   * leaves the one for the event's own time answerable. No candidate, and
   * no mail is named.
   */
  find(uid, event = {}) {
    const organizer = v.emailAddress(event?.organizer);
    const start = startOf(event?.start);
    if (uidOf(uid) === null || organizer === null || start === null) return Promise.resolve(null);
    return this.#serial(async () => {
      const mails = await this.#load();
      const agrees = (mail) => mail.organizer !== null && lower(mail.organizer) === lower(organizer) && mail.start === start && NOTED_KINDS.has(mail.kind);
      const list = [...(this.#byUid.get(uid) ?? [])].map((key) => mails.get(key)).filter(agrees);
      if (!list.length) return null;
      const { collectionId, serverId, at } = list[list.length - 1];
      return { collectionId, serverId, at };
    });
  }

  /** Number of invitation mails known. */
  size() {
    return this.#serial(async () => (await this.#load()).size);
  }

  /** Forget everything (the mailbox no longer synchronizes mail, or is removed). */
  clear() {
    return this.#serial(async () => {
      this.#mails = new Map();
      this.#byUid = new Map();
      await this.#records.remove(RECORD);
    });
  }
}
