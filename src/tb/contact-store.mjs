// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * The address books of ONE mailbox in Thunderbird, through Thunderbird's
 * own `addressBooks` and `contacts` APIs. It gives the synchronization
 * engine (sync/pim.mjs) what tb/calendar-store.mjs gives it for calendars,
 * under the same names: an address book stands where a calendar does.
 *
 *   listCalendars() → [{ calendarId, slot, name, events, tasks }]     (this mailbox's books only)
 *   ensureCalendar({ slot, name }) → { calendarId, created }
 *   removeCalendar(calendarId) → boolean
 *   applyServerChanges(calendarId, changes) → [{ serverId, ok, code? }]   (put, remove, detach or lock)
 *   serverIds(calendarId, collectionId) → [ServerId]
 *   readLocalChanges(calendarId, { max }) → { changes, rejected }
 *   ackLocalChange(calendarId, changeId, { serverId?, collectionId?, item? }) → boolean
 *   dropLocalChange(calendarId, changeId) → boolean
 *   onLocalChange(listener) → stop()
 *
 * Which books. Only the books this module created for this mailbox: their
 * ids are kept in the record `abBooks`. No call ever names another book,
 * and a contact is reached only through one of them.
 *
 * What is kept for each contact of a book (records `abItems:<book>:<n>`):
 * the server's ids, the description last synchronized (`item`, without its
 * picture) and what its card said when it was last written or
 * acknowledged (`base`, a projection: core/vcard.mjs). A local change is
 * what the card says now, compared with `base`: nothing is recorded while
 * the user types, and what this module writes itself is never taken for a
 * change of the user, whatever Thunderbird does to the card it is given.
 *
 * Deletions are the exception: a contact is deleted on the server only
 * when Thunderbird said, while this module was listening, that the user
 * deleted it (record `abGone:<book>`). A contact that is simply no longer
 * there (a book emptied while the extension was off, a profile restored)
 * is forgotten here and stays on the server.
 *
 * Read-only contacts. Thunderbird cannot protect one contact of a book. A
 * change to a contact the description could not hold whole ("incomplete")
 * is reported with `problem: "read-only"`, and dropLocalChange puts the
 * server's version back.
 *
 * Pictures. The description last synchronized is kept without its
 * picture; the card holds it. A picture removed in Thunderbird is not
 * removed on the server.
 *
 * Errors are ContactStoreErrors with a `code` (CONFIG, NOT_FOUND,
 * INTERNAL). Their message never carries a name or an address.
 */

import * as v from "../core/sanitize.mjs";
import { MAILBOX_ID } from "../core/ids.mjs";
import { checkContact } from "../core/contact-item.mjs";
import { buildVCard, projectVCard, mergeLocal, sameProjection, VCARD_MAX } from "../core/vcard.mjs";
import { sha256, toHex } from "../core/sha256.mjs";
import { encodeUtf8 } from "../core/utf8.mjs";

export const MAX_BATCH = 200;
/** Most address books of one mailbox, and most contacts held in one book. */
export const MAX_BOOKS = 30;
export const MAX_CONTACTS = 20_000;
const BUCKETS = 32;
const BOOKS = "abBooks";
const MAIN_SLOT = "main";
const MAX_NAME = 256;
const BOOK_ID = /^[\x21-\x7e]{1,100}$/;
const CONTACT_ID = /^[\x21-\x39\x3b-\x7e]{1,100}$/; // no colon: it separates the parts of a change id
const CHANGE = /^([amd]):([\x21-\x39\x3b-\x7e]{1,100}):(\d{1,9})$/;
const SERVER_OPS = new Set(["put", "remove", "detach", "lock"]);
/** How long an event that follows a write of this module is taken for its echo. */
const OWN_WRITE_MS = 5000;

export class ContactStoreError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ContactStoreError";
    this.code = code;
  }
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const itemsRecord = (bookId, n) => `abItems:${bookId}:${n}`;
const goneRecord = (bookId) => `abGone:${bookId}`;
const serverKey = (collectionId, serverId) => `${collectionId}\n${serverId}`;
const hashOf = (text) => toHex(sha256(encodeUtf8(text)).subarray(0, 16));

function bucketOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % BUCKETS;
}

function nameOf(value) {
  if (typeof value !== "string") return null;
  const name = v.cut(v.cleanText(value, { max: 4 * MAX_NAME, singleLine: true, stripBidi: true }).trim(), MAX_NAME).trim();
  return name || null;
}

/** A projection with its picture replaced by a short hash: what is stored, and compared. */
function slim(projection) {
  return { ...projection, picture: typeof projection.picture === "string" ? `h:${hashOf(projection.picture)}` : null };
}

/** A description without its picture, as it is stored. */
function stored(item) {
  return checkContact({ ...item, picture: null }, { fromServer: true });
}

export class ContactStore {
  #mailboxId;
  #records;
  #books;
  #contacts;
  #now;
  #owned = null; // Map<bookId, { slot, name }>, from the record
  #state = new Map(); // bookId → { entries, byServer, gone, dirty: Set<bucket>, scan }
  #mine = new Map(); // contact id → until when an event about it is our own echo
  #listeners = new Set();
  #stop = null;
  #chain = Promise.resolve();

  /**
   * @param {object} o
   * @param {string} o.mailboxId
   * @param {object} o.records     store.mailbox(id)
   * @param {object} [o.api]       { addressBooks, contacts }: Thunderbird's APIs, or doubles
   * @param {() => number} [o.now]
   */
  constructor({ mailboxId, records, api = globalThis.browser ?? globalThis.messenger, now = () => Date.now() }) {
    if (typeof mailboxId !== "string" || !MAILBOX_ID.test(mailboxId)) throw new ContactStoreError("CONFIG", "id de boîte invalide");
    if (!records || !api?.addressBooks || !api?.contacts) throw new ContactStoreError("CONFIG", "carnets d'adresses indisponibles");
    this.#mailboxId = mailboxId;
    this.#records = records;
    this.#books = api.addressBooks;
    this.#contacts = api.contacts;
    this.#now = now;
  }

  /** One operation on the kept state at a time (the engine's calls and Thunderbird's events). */
  #serial(fn) {
    const run = this.#chain.then(fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  // ── Books ───────────────────────────────────────────────────────────────

  async #ownedBooks() {
    if (this.#owned) return this.#owned;
    const map = new Map();
    for (const [id, raw] of await this.#records.getMap(BOOKS)) {
      const slot = raw?.slot === MAIN_SLOT ? MAIN_SLOT : v.itemId(raw?.slot);
      if (!BOOK_ID.test(id) || !slot || map.size >= MAX_BOOKS) continue;
      map.set(id, { slot, name: nameOf(raw?.name) ?? "" });
    }
    this.#owned = map;
    return map;
  }

  async #saveBooks() {
    if (this.#owned.size) await this.#records.setMap(BOOKS, this.#owned);
    else await this.#records.remove(BOOKS);
  }

  async #own(calendarId) {
    if (typeof calendarId !== "string" || !(await this.#ownedBooks()).has(calendarId)) throw new ContactStoreError("CONFIG", "carnet d'une autre boîte, ou invalide");
    return calendarId;
  }

  async #exists(bookId) {
    try {
      return Boolean(await this.#books.get(bookId));
    } catch {
      return false;
    }
  }

  /** Forget a book and everything kept for it (Thunderbird's book is not touched here). */
  async #forget(bookId) {
    this.#state.delete(bookId);
    const names = [goneRecord(bookId)];
    for (let n = 0; n < BUCKETS; n++) names.push(itemsRecord(bookId, n));
    await this.#records.removeMany(names);
    if (this.#owned?.delete(bookId)) await this.#saveBooks();
  }

  /** The books of this mailbox that Thunderbird still has; one it no longer has is forgotten. */
  listCalendars() {
    return this.#serial(async () => {
      const out = [];
      for (const [id, book] of [...(await this.#ownedBooks())]) {
        if (!(await this.#exists(id))) {
          await this.#forget(id);
          continue;
        }
        out.push({ calendarId: id, slot: book.slot, name: book.name, events: false, tasks: false });
      }
      return out.sort((a, b) => (a.calendarId < b.calendarId ? -1 : a.calendarId > b.calendarId ? 1 : 0));
    });
  }

  /** This mailbox's book for `slot`, created when there is none. → { calendarId, created } */
  ensureCalendar({ slot, name } = {}) {
    const place = slot === MAIN_SLOT ? MAIN_SLOT : v.itemId(slot);
    const shown = nameOf(name);
    if (!place || shown === null) throw new ContactStoreError("CONFIG", "carnet invalide");
    return this.#serial(async () => {
      const owned = await this.#ownedBooks();
      for (const [id, book] of [...owned]) {
        if (book.slot !== place) continue;
        if (await this.#exists(id)) return { calendarId: id, created: false };
        await this.#forget(id);
      }
      if (owned.size >= MAX_BOOKS) throw new ContactStoreError("LIMIT", "trop de carnets d'adresses");
      const id = await this.#books.create({ name: shown });
      if (typeof id !== "string" || !BOOK_ID.test(id) || owned.has(id)) throw new ContactStoreError("INTERNAL", "carnet créé invalide");
      owned.set(id, { slot: place, name: shown });
      await this.#saveBooks();
      return { calendarId: id, created: true };
    });
  }

  /** Deletes the book in Thunderbird, with what is kept for it (nothing on the server). → boolean */
  removeCalendar(calendarId) {
    return this.#serial(async () => {
      await this.#own(calendarId);
      // Forgotten first: the events of this deletion are then those of a book that is not ours.
      await this.#forget(calendarId);
      try {
        await this.#books.delete(calendarId);
      } catch {
        return !(await this.#exists(calendarId));
      }
      return true;
    });
  }

  // ── Kept state of a book ────────────────────────────────────────────────

  #entry(raw) {
    if (!isRecord(raw)) return null;
    const entry = {
      s: v.itemId(raw.s) ?? null,
      c: v.itemId(raw.c) ?? null,
      item: null,
      base: isRecord(raw.base) ? raw.base : null,
      p: isRecord(raw.p) ? raw.p : null,
      rev: Number.isSafeInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0,
      detached: raw.detached === true,
      locked: raw.locked === true,
    };
    if (raw.item !== null && raw.item !== undefined) {
      try {
        entry.item = checkContact(raw.item, { fromServer: true });
      } catch {
        return null;
      }
    }
    // Bound to the server with its description, or not at all.
    if ((entry.s === null) !== (entry.c === null) || (entry.s !== null && entry.item === null)) return null;
    return entry;
  }

  async #load(bookId) {
    let state = this.#state.get(bookId);
    if (state) return state;
    state = { entries: new Map(), byServer: new Map(), gone: new Set(), dirty: new Set(), scan: true };
    for (let n = 0; n < BUCKETS; n++) {
      for (const [id, raw] of await this.#records.getMap(itemsRecord(bookId, n))) {
        const entry = CONTACT_ID.test(id) ? this.#entry(raw) : null;
        if (!entry || state.entries.size >= MAX_CONTACTS) continue;
        state.entries.set(id, entry);
        if (entry.s !== null) state.byServer.set(serverKey(entry.c, entry.s), id);
      }
    }
    const gone = await this.#records.get(goneRecord(bookId), []);
    for (const id of Array.isArray(gone) ? gone : []) if (typeof id === "string" && state.entries.has(id)) state.gone.add(id);
    this.#state.set(bookId, state);
    return state;
  }

  #touch(state, id) {
    state.dirty.add(bucketOf(id));
  }

  async #save(bookId, state) {
    if (!state.dirty.size) return;
    const buckets = new Map([...state.dirty].map((n) => [n, []]));
    for (const [id, e] of state.entries) buckets.get(bucketOf(id))?.push([id, e]);
    const writes = [];
    const removals = [];
    for (const [n, list] of buckets) {
      if (list.length) writes.push([itemsRecord(bookId, n), list]);
      else removals.push(itemsRecord(bookId, n));
    }
    state.dirty.clear();
    if (writes.length) await this.#records.setMany(writes);
    if (removals.length) await this.#records.removeMany(removals);
  }

  async #saveGone(bookId, state) {
    if (state.gone.size) await this.#records.set(goneRecord(bookId), [...state.gone]);
    else await this.#records.remove(goneRecord(bookId));
  }

  #unbind(state, entry) {
    if (entry.s !== null) state.byServer.delete(serverKey(entry.c, entry.s));
  }

  // ── Thunderbird's contacts ──────────────────────────────────────────────

  #wrote(id) {
    this.#mine.set(id, this.#now() + OWN_WRITE_MS);
    if (this.#mine.size > 4 * MAX_BATCH) for (const [k, until] of this.#mine) if (until < this.#now()) this.#mine.delete(k);
  }

  /** The card of a contact of `bookId`, or null when it is not there (or lies in another book). */
  async #card(bookId, id) {
    let node;
    try {
      node = await this.#contacts.get(id);
    } catch {
      return null;
    }
    const text = node?.properties?.vCard;
    return node?.parentId === bookId && typeof text === "string" && text.length <= VCARD_MAX ? text : null;
  }

  /** Writes the card of `description` over the contact `id`, and reads back what Thunderbird made of it. → slim projection */
  async #rewrite(bookId, id, description, existing) {
    this.#wrote(id);
    await this.#contacts.update(id, { vCard: buildVCard({ ...description, uid: id }, { existing }) });
    return this.#readBack(bookId, id);
  }

  async #readBack(bookId, id) {
    const now = projectVCard((await this.#card(bookId, id)) ?? "");
    if (now === null) throw new ContactStoreError("INTERNAL", "fiche illisible après écriture");
    return slim(now);
  }

  /** Creates the contact `id` with the card of `description`. → slim projection */
  async #create(bookId, id, description) {
    this.#wrote(id);
    const made = await this.#contacts.create(bookId, null, { vCard: buildVCard({ ...description, uid: id }) });
    if (made !== id) {
      // Thunderbird named it otherwise: not a contact this module can find again.
      if (typeof made === "string") await this.#contacts.delete(made).catch(() => {});
      throw new ContactStoreError("INTERNAL", "contact créé sous un autre identifiant");
    }
    return this.#readBack(bookId, id);
  }

  // ── Changes from the server ─────────────────────────────────────────────

  /**
   * Applies changes that come from the server, in order. They never
   * produce a local change, and a change the user had made to the same
   * contact gives way: the server wins. In the item of a put,
   * `description: null` means "the server does not say": the notes held
   * are kept.
   * → [{ serverId, ok, code? }]; `code` is INVALID, LIMIT or INTERNAL.
   */
  applyServerChanges(calendarId, changes) {
    if (!Array.isArray(changes)) throw new ContactStoreError("CONFIG", "liste de modifications invalide");
    const clean = changes.map((c) => {
      const collectionId = v.itemId(c?.collectionId);
      const serverId = v.itemId(c?.serverId);
      if (!isRecord(c) || !SERVER_OPS.has(c.op) || !collectionId || !serverId) throw new ContactStoreError("CONFIG", "modification invalide");
      if (c.op === "put" && !isRecord(c.item)) throw new ContactStoreError("CONFIG", "description absente");
      return { op: c.op, collectionId, serverId, item: c.op === "put" ? c.item : null };
    });
    return this.#serial(async () => {
      const bookId = await this.#own(calendarId);
      const state = await this.#load(bookId);
      const results = [];
      try {
        for (const c of clean) {
          try {
            results.push({ serverId: c.serverId, ...(await this.#applyOne(bookId, state, c)) });
          } catch (e) {
            results.push({ serverId: c.serverId, ok: false, code: e instanceof ContactStoreError && e.code === "LIMIT" ? "LIMIT" : e?.code === "BAD_ITEM" ? "INVALID" : "INTERNAL" });
          }
        }
      } finally {
        await this.#save(bookId, state);
        await this.#saveGone(bookId, state);
      }
      return results;
    });
  }

  async #applyOne(bookId, state, c) {
    const key = serverKey(c.collectionId, c.serverId);
    const id = state.byServer.get(key) ?? null;
    const entry = id === null ? null : state.entries.get(id);
    if (c.op === "remove") {
      if (!entry) return { ok: true };
      this.#unbind(state, entry);
      state.entries.delete(id);
      state.gone.delete(id);
      this.#touch(state, id);
      this.#wrote(id);
      await this.#contacts.delete(id).catch(() => {}); // already gone is as good
      return { ok: true };
    }
    if (c.op === "detach") {
      if (!entry) return { ok: true };
      this.#unbind(state, entry);
      if (state.gone.delete(id)) state.entries.delete(id); // deleted here already: nothing is left to keep
      else Object.assign(entry, { s: null, c: null, detached: true, p: null });
      this.#touch(state, id);
      return { ok: true };
    }
    if (c.op === "lock") {
      if (entry && !entry.locked) {
        entry.locked = true;
        this.#touch(state, id);
      }
      return { ok: true };
    }
    // put
    let item = checkContact(c.item, { fromServer: true });
    if (item.description === null) item = checkContact({ ...item, description: entry?.item?.description ?? "" }, { fromServer: true });
    if (entry) {
      const existing = await this.#card(bookId, id);
      const base = existing === null ? await this.#create(bookId, id, item) : await this.#rewrite(bookId, id, item, existing);
      Object.assign(entry, { item: stored(item), base, p: null, locked: false, detached: false });
      state.gone.delete(id); // the server sent it again: the deletion waiting here gives way
      this.#touch(state, id);
      return { ok: true };
    }
    if (state.entries.size >= MAX_CONTACTS) throw new ContactStoreError("LIMIT", "carnet plein");
    // An id of ours, the same for the same item of the same mailbox: never the id of a contact of another book.
    let fresh = `sync443-${hashOf([this.#mailboxId, bookId, c.collectionId, c.serverId].join("\n"))}`;
    for (let k = 2; state.entries.has(fresh); k++) fresh = `sync443-${hashOf([this.#mailboxId, bookId, c.collectionId, c.serverId, String(k)].join("\n"))}`;
    const base = await this.#create(bookId, fresh, item);
    state.entries.set(fresh, { s: c.serverId, c: c.collectionId, item: stored(item), base, p: null, rev: 0, detached: false, locked: false });
    state.byServer.set(key, fresh);
    this.#touch(state, fresh);
    return { ok: true };
  }

  /** The ServerIds held for a collection (those whose local deletion is not acknowledged yet included). */
  serverIds(calendarId, collectionId) {
    const cid = v.itemId(collectionId);
    if (!cid) throw new ContactStoreError("CONFIG", "collection invalide");
    return this.#serial(async () => {
      const state = await this.#load(await this.#own(calendarId));
      const out = [];
      for (const e of state.entries.values()) if (e.c === cid && e.s !== null) out.push(e.s);
      return out;
    });
  }

  // ── Changes of the user ─────────────────────────────────────────────────

  /**
   * The user's changes not sent yet, at most `max`: deletions first, then
   * what the cards say that `base` does not.
   *
   *   { changeId, op: "add" | "modify" | "delete", kind: "contact",
   *     collectionId, serverId, item, previous, problem, detached: false,
   *     rewritten: false, replyAsked: false }
   *
   * `problem` is "read-only" for a change to a contact that is read-only
   * (`item` null), "too-large" for a card the description cannot hold (a
   * picture over the bound); null otherwise.
   * → { changes, rejected }: `rejected` counts the cards that cannot be
   * read or named.
   */
  readLocalChanges(calendarId, { max = MAX_BATCH } = {}) {
    const limit = Number.isInteger(max) ? Math.max(1, Math.min(MAX_BATCH, max)) : MAX_BATCH;
    return this.#serial(async () => {
      const bookId = await this.#own(calendarId);
      const state = await this.#load(bookId);
      const changes = [];
      let rejected = 0;
      const change = (op, id, entry, item, problem = null) => ({
        changeId: `${op[0]}:${id}:${entry.rev}`,
        op,
        kind: "contact",
        collectionId: entry.c,
        serverId: entry.s,
        item,
        previous: entry.item,
        problem,
        detached: false,
        rewritten: false,
        replyAsked: false,
      });
      let nodes;
      try {
        nodes = await this.#contacts.list(bookId);
      } catch {
        throw new ContactStoreError("NOT_FOUND", "carnet illisible");
      }
      if (!Array.isArray(nodes)) throw new ContactStoreError("INTERNAL", "liste de contacts invalide");
      const present = new Map();
      for (const node of nodes) if (isRecord(node) && typeof node.id === "string" && node.parentId === bookId) present.set(node.id, node);

      try {
        // Deletions the user made while this module listened.
        for (const id of [...state.gone]) {
          const entry = state.entries.get(id);
          if (!entry || entry.s === null || present.has(id)) {
            state.gone.delete(id); // nothing to delete on the server, or the contact is back
            if (entry && entry.s === null && !present.has(id)) {
              state.entries.delete(id);
              this.#touch(state, id);
            }
            continue;
          }
          if (changes.length < limit) changes.push(change("delete", id, entry, null));
        }
        // Contacts that are no longer there, and nobody said why: forgotten, never deleted on the server.
        for (const [id, entry] of [...state.entries]) {
          if (present.has(id) || state.gone.has(id)) continue;
          this.#unbind(state, entry);
          state.entries.delete(id);
          this.#touch(state, id);
        }
        for (const [id, node] of present) {
          let entry = state.entries.get(id);
          if (entry?.detached) continue;
          const text = node.properties?.vCard;
          const now = typeof text === "string" && text.length <= VCARD_MAX && CONTACT_ID.test(id) ? projectVCard(text) : null;
          if (now === null) {
            if (!entry) rejected++;
            continue;
          }
          const said = slim(now);
          if (entry && entry.s !== null && sameProjection(said, entry.base)) {
            if (entry.p !== null) {
              entry.p = null; // changed, then put back as it was
              this.#touch(state, id);
            }
            continue;
          }
          if (!entry) {
            if (state.entries.size >= MAX_CONTACTS) {
              rejected++;
              continue;
            }
            entry = { s: null, c: null, item: null, base: null, p: null, rev: 0, detached: false, locked: false };
            state.entries.set(id, entry);
            this.#touch(state, id);
          }
          if (changes.length >= limit) continue;
          // What this change says is kept until it is acknowledged; a change that says something else is another change.
          if (entry.p === null || !sameProjection(said, entry.p)) {
            if (entry.p !== null) entry.rev++;
            entry.p = said;
            this.#touch(state, id);
          }
          const op = entry.s === null ? "add" : "modify";
          if (entry.locked || entry.item?.readOnly) {
            changes.push(change(op, id, entry, null, "read-only"));
            continue;
          }
          try {
            changes.push(change(op, id, entry, mergeLocal(entry.item, entry.base, now, id)));
          } catch {
            changes.push(change(op, id, entry, null, "too-large"));
          }
        }
      } finally {
        await this.#save(bookId, state);
        await this.#saveGone(bookId, state);
      }
      return { changes, rejected };
    });
  }

  #parse(changeId) {
    const m = typeof changeId === "string" ? CHANGE.exec(changeId) : null;
    if (!m) throw new ContactStoreError("CONFIG", "modification invalide");
    return { op: m[1], id: m[2], rev: Number(m[3]) };
  }

  /**
   * The server accepted a change. `serverId` (with `collectionId`) binds an
   * added contact; `item` is the description now synchronized.
   * → true when the change is settled; false when it is unknown, or when
   * the user changed the contact again since it was read (the contact is
   * bound all the same, and what the card says now is the next change).
   */
  ackLocalChange(calendarId, changeId, { serverId = null, collectionId = null, item = null } = {}) {
    const { op, id, rev } = this.#parse(changeId);
    const sid = serverId === null ? null : v.itemId(serverId);
    const cid = collectionId === null ? null : v.itemId(collectionId);
    if ((serverId !== null && !sid) || (collectionId !== null && !cid)) throw new ContactStoreError("CONFIG", "identifiant invalide");
    if (item !== null && !isRecord(item)) throw new ContactStoreError("CONFIG", "description invalide");
    return this.#serial(async () => {
      const bookId = await this.#own(calendarId);
      const state = await this.#load(bookId);
      const entry = state.entries.get(id);
      if (!entry) return false;
      try {
        if (op === "d") {
          if (!state.gone.has(id)) return false;
          this.#unbind(state, entry);
          state.entries.delete(id);
          state.gone.delete(id);
          this.#touch(state, id);
          return true;
        }
        if (op === "a") {
          if (entry.s !== null || !sid || !cid || item === null) return false;
          const key = serverKey(cid, sid);
          if (state.byServer.has(key)) return false;
          entry.s = sid;
          entry.c = cid;
          state.byServer.set(key, id);
        } else if (entry.s === null) {
          return false;
        }
        if (item !== null) entry.item = stored({ ...item, uid: id });
        this.#touch(state, id);
        if (entry.rev !== rev || entry.p === null) {
          // Changed again since: what was sent is not what the card says. `base` stays; an added contact gets
          // one that says nothing, so that the whole card is the next change.
          if (entry.base === null) entry.base = slim(projectVCard("BEGIN:VCARD\r\nEND:VCARD\r\n"));
          entry.p = null;
          return false;
        }
        entry.base = entry.p;
        entry.p = null;
        return true;
      } finally {
        await this.#save(bookId, state);
        await this.#saveGone(bookId, state);
      }
    });
  }

  /**
   * Undo a change in Thunderbird: the last synchronized version comes
   * back, a deleted contact returns (without its picture: the server keeps
   * it); a contact never synchronized stays in the book as a detached
   * local copy, with nothing to send.
   * → true; false when the change is unknown or was changed again since
   * it was read.
   */
  dropLocalChange(calendarId, changeId) {
    const { op, id, rev } = this.#parse(changeId);
    return this.#serial(async () => {
      const bookId = await this.#own(calendarId);
      const state = await this.#load(bookId);
      const entry = state.entries.get(id);
      if (!entry || entry.rev !== rev) return false;
      try {
        if (op === "d") {
          if (!state.gone.has(id) || entry.item === null) return false;
          entry.base = (await this.#card(bookId, id)) === null ? await this.#create(bookId, id, entry.item) : await this.#readBack(bookId, id);
          entry.p = null;
          state.gone.delete(id);
          this.#touch(state, id);
          return true;
        }
        if (op === "a") {
          if (entry.s !== null) return false;
          Object.assign(entry, { detached: true, p: null, item: null, base: null });
          this.#touch(state, id);
          return true;
        }
        if (entry.s === null || entry.item === null) return false;
        const existing = await this.#card(bookId, id);
        if (existing === null) return false;
        // The picture the card holds stays when it is the one that was synchronized; the description kept has none.
        const now = projectVCard(existing);
        const picture = now !== null && now.picture !== null && slim(now).picture === entry.base?.picture ? now.picture : null;
        entry.base = await this.#rewrite(bookId, id, { ...entry.item, picture }, existing);
        entry.p = null;
        this.#touch(state, id);
        return true;
      } finally {
        await this.#save(bookId, state);
        await this.#saveGone(bookId, state);
      }
    });
  }

  // ── Thunderbird's events ────────────────────────────────────────────────

  #echo(id) {
    const until = this.#mine.get(id);
    return until !== undefined && until >= this.#now();
  }

  #tell(bookId) {
    for (const listener of this.#listeners) {
      try {
        const r = listener(bookId);
        if (r && typeof r.catch === "function") r.catch(() => {});
      } catch {
        /* a listener that fails must not stop the others */
      }
    }
  }

  #listen() {
    if (this.#stop) return;
    const changed = (node) => {
      const bookId = node?.parentId;
      const id = node?.id;
      if (typeof bookId !== "string" || typeof id !== "string") return;
      this.#serial(async () => {
        if (!(await this.#ownedBooks()).has(bookId) || this.#echo(id)) return;
        this.#tell(bookId);
      }).catch(() => {});
    };
    const deleted = (bookId, id) => {
      if (typeof bookId !== "string" || typeof id !== "string") return;
      this.#serial(async () => {
        if (!(await this.#ownedBooks()).has(bookId)) return;
        const state = await this.#load(bookId);
        const entry = state.entries.get(id);
        if (!entry || entry.detached) {
          if (entry) {
            state.entries.delete(id);
            this.#touch(state, id);
            await this.#save(bookId, state);
          }
          return;
        }
        state.gone.add(id);
        await this.#saveGone(bookId, state);
        this.#tell(bookId);
      }).catch(() => {});
    };
    const bookDeleted = (bookId) => {
      if (typeof bookId !== "string") return;
      this.#serial(async () => {
        if (!(await this.#ownedBooks()).has(bookId)) return;
        await this.#forget(bookId); // the user removed the book: its contacts stay on the server
        this.#tell(bookId);
      }).catch(() => {});
    };
    const pairs = [
      [this.#contacts.onCreated, changed],
      [this.#contacts.onUpdated, changed],
      [this.#contacts.onDeleted, deleted],
      [this.#books.onDeleted, bookDeleted],
    ].filter(([event]) => event && typeof event.addListener === "function");
    for (const [event, fn] of pairs) event.addListener(fn);
    this.#stop = () => {
      for (const [event, fn] of pairs) {
        try {
          event.removeListener(fn);
        } catch {
          /* already gone */
        }
      }
      this.#stop = null;
    };
  }

  /**
   * `listener(calendarId)` is called when the user changed a contact of
   * one of this mailbox's books. Deletions are recorded from the first
   * call on: listen as soon as the mailbox starts.
   * → a function that stops listening.
   */
  onLocalChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.#listeners.add(listener);
    this.#listen();
    return () => {
      this.#listeners.delete(listener);
      if (!this.#listeners.size) this.#stop?.();
    };
  }
}
