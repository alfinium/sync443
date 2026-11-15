// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Expected echoes of our own writes in Thunderbird.
 *
 * When the engine writes to Thunderbird (moves a message, changes a flag,
 * renames a folder…), Thunderbird reports the change through the same
 * events as a user action. Before each write, the adapter (tb/mail-store.mjs)
 * declares the intent the event will carry; tb/events.mjs then consumes it
 * and ignores the event. Everything else is a real user action.
 *
 * So that an echo can never hide a real user action for long:
 *  - expectations are matched by value (account, kind, folder path,
 *    Message-ID, new value), never by a Thunderbird id;
 *  - each one is consumed once (two identical writes expect two events);
 *  - each one lives 30 s at most;
 *  - their number is capped (the oldest go first);
 *  - the adapter declares one only for a write that will produce an event
 *    (a flag that does not change produces none), and retracts it when the
 *    write fails.
 *
 * A flag intent is matched field by field: the event of one write may
 * carry `read` and `flagged` together or separately.
 */

export const ECHO_TTL_MS = 30_000;
export const ECHO_MAX = 10_000;

const KINDS = new Set(["flags", "move", "delete", "folderCreate", "folderRename", "folderMove", "folderDelete"]);
const FLAG_FIELDS = ["read", "flagged"];

/**
 * Keys of an intent: one per flag field for "flags", one otherwise.
 * JSON arrays, so no separator can be forged by a name or a Message-ID.
 * → string[] (empty for an intent that cannot be keyed)
 */
export function intentKeys(accountKey, intent) {
  if (typeof accountKey !== "string" || !intent || !KINDS.has(intent.kind) || typeof intent.path !== "string") return [];
  switch (intent.kind) {
    case "flags": {
      if (typeof intent.messageId !== "string" || !intent.flags) return [];
      return FLAG_FIELDS.filter((f) => typeof intent.flags[f] === "boolean").map((f) =>
        JSON.stringify(["flags", accountKey, intent.path, intent.messageId, f, intent.flags[f]]),
      );
    }
    case "move":
      if (typeof intent.messageId !== "string" || typeof intent.toPath !== "string") return [];
      return [JSON.stringify(["move", accountKey, intent.path, intent.toPath, intent.messageId])];
    case "delete":
      if (typeof intent.messageId !== "string") return [];
      return [JSON.stringify(["delete", accountKey, intent.path, intent.messageId])];
    case "folderRename":
    case "folderMove":
      if (typeof intent.toPath !== "string") return [];
      return [JSON.stringify([intent.kind, accountKey, intent.path, intent.toPath])];
    default:
      return [JSON.stringify([intent.kind, accountKey, intent.path])];
  }
}

export class EchoRegistry {
  #now;
  #ttl;
  #max;
  #byKey = new Map(); // key → [entry id, …] (oldest first)
  #queue = []; // [{ id, key, expires }] in declaration order
  #head = 0;
  #live = new Set(); // ids of expectations not yet consumed, retracted or expired
  #next = 1;

  constructor({ now = () => Date.now(), ttlMs = ECHO_TTL_MS, max = ECHO_MAX } = {}) {
    this.#now = now;
    this.#ttl = ttlMs;
    this.#max = Math.max(1, max);
  }

  /** Number of live expectations. */
  get size() {
    this.#prune();
    return this.#live.size;
  }

  /**
   * Declare the echo of a write about to be made. → a token for retract().
   */
  expect(accountKey, intent) {
    this.#prune();
    const ids = [];
    for (const key of intentKeys(accountKey, intent)) {
      while (this.#live.size >= this.#max) this.#dropOldest();
      const id = this.#next++;
      this.#live.add(id);
      this.#queue.push({ id, key, expires: this.#now() + this.#ttl });
      const list = this.#byKey.get(key);
      if (list) list.push(id);
      else this.#byKey.set(key, [id]);
      ids.push(id);
    }
    return ids;
  }

  /** The write failed: its echo will not come. */
  retract(token) {
    for (const id of Array.isArray(token) ? token : []) this.#live.delete(id);
    this.#prune();
  }

  /**
   * An event arrived, translated into an intent. Expected parts are
   * consumed; → the part that is NOT an echo (a real user action), or
   * null when the whole event was expected.
   */
  consume(accountKey, intent) {
    this.#prune();
    if (intent?.kind === "flags") {
      const rest = {};
      let any = false;
      for (const f of FLAG_FIELDS) {
        if (typeof intent.flags?.[f] !== "boolean") continue;
        const [key] = intentKeys(accountKey, { ...intent, flags: { [f]: intent.flags[f] } });
        if (!this.#take(key)) {
          rest[f] = intent.flags[f];
          any = true;
        }
      }
      return any ? { ...intent, flags: rest } : null;
    }
    const [key] = intentKeys(accountKey, intent);
    if (key !== undefined && this.#take(key)) return null;
    return intent;
  }

  #take(key) {
    const list = this.#byKey.get(key);
    if (!list) return false;
    while (list.length) {
      const id = list.shift();
      if (this.#live.delete(id)) {
        if (!list.length) this.#byKey.delete(key);
        return true;
      }
    }
    this.#byKey.delete(key);
    return false;
  }

  #dropOldest() {
    while (this.#head < this.#queue.length) {
      const e = this.#queue[this.#head++];
      if (this.#live.delete(e.id)) {
        this.#forget(e);
        break;
      }
    }
    this.#compact();
  }

  #forget(e) {
    const list = this.#byKey.get(e.key);
    if (!list) return;
    const i = list.indexOf(e.id);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.#byKey.delete(e.key);
  }

  /** Expired and dead entries leave the queue from its head (TTL is constant, so the queue is in expiry order). */
  #prune() {
    const now = this.#now();
    while (this.#head < this.#queue.length) {
      const e = this.#queue[this.#head];
      if (this.#live.has(e.id) && e.expires > now) break;
      this.#head++;
      this.#live.delete(e.id);
      this.#forget(e);
    }
    this.#compact();
  }

  #compact() {
    if (this.#head > 1024 && this.#head * 2 > this.#queue.length) {
      this.#queue = this.#queue.slice(this.#head);
      this.#head = 0;
    }
  }
}
