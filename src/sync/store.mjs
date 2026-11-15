// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Persistent state, in browser.storage.local, with a schema version.
 *
 *   schema                 SCHEMA
 *   mailboxes              [Mailbox], in display order (see checkMailbox)
 *   mb/<id>/<name>         one record of a mailbox
 *   mb/<id>/#names         the record names of that mailbox (so a mailbox is
 *                          removed without reading the whole storage)
 *
 * Passwords are never stored here (Thunderbird's password manager holds
 * them). Records whose keys come from the server or from Thunderbird are
 * Maps, stored as [[key, value], ...] arrays and rebuilt as Maps: no
 * outside string ever becomes a property name of a plain object.
 */

export const SCHEMA = 1;
const MAILBOXES = "mailboxes";
const NAMES = "#names";

export class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "StoreError";
  }
}

const ID = /^[a-f0-9]{12}$/;
const RECORD = /^[a-z][a-zA-Z0-9]{0,40}(:[\x21-\x7e]{1,600})?$/; // e.g. "health", recordName("coll", serverId)

/** Record name for one server object: "<kind>:<URI-encoded id>" (ids are validated, at most 64 characters). */
export function recordName(kind, id) {
  if (!/^[a-z][a-zA-Z0-9]{0,40}$/.test(kind) || typeof id !== "string" || !id || id.length > 64) {
    throw new StoreError(`nom d'enregistrement invalide : ${kind}`);
  }
  return `${kind}:${encodeURIComponent(id)}`;
}

/**
 * What a mailbox synchronises: any combination of the four, at least one.
 * Nothing that is not chosen is ever downloaded.
 */
export const SYNC_KINDS = Object.freeze(["mail", "calendar", "contacts", "tasks"]);
export const SYNC_ALL = Object.freeze({ mail: true, calendar: true, contacts: true, tasks: true });

/** Fields of a mailbox, checked on every write. */
export function checkMailbox(mb) {
  const fail = (what) => {
    throw new StoreError(`boîte invalide : ${what}`);
  };
  if (!mb || typeof mb !== "object") fail("objet attendu");
  if (typeof mb.id !== "string" || !ID.test(mb.id)) fail("id");
  if (typeof mb.email !== "string" || !mb.email.includes("@") || mb.email.length > 254) fail("adresse");
  if (typeof mb.username !== "string" || mb.username.length > 256) fail("identifiant");
  if (typeof mb.name !== "string" || mb.name.length > 256) fail("nom");
  // Origins come from parseServer: https, a host name or IP literal, an optional port. Nothing else.
  if (typeof mb.origin !== "string" || !/^https:\/\/(?:[a-z0-9.-]{1,253}|\[[0-9a-f:]{2,39}\])(?::\d{1,5})?$/.test(mb.origin)) {
    fail("origine");
  }
  if (typeof mb.deviceId !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(mb.deviceId)) fail("identifiant d'appareil");
  if (!Number.isInteger(mb.syncMinutes) || mb.syncMinutes < 0 || mb.syncMinutes > 1440) fail("intervalle");
  if (!/^[0-8]$/.test(String(mb.filterType ?? ""))) fail("période");
  if (mb.accountKey !== null && (typeof mb.accountKey !== "string" || !/^account\d{1,6}$/.test(mb.accountKey))) fail("compte");
  if (!Array.isArray(mb.tlsPins) || mb.tlsPins.some((p) => typeof p !== "string" || !/^[0-9A-F]{64}$/.test(p))) fail("certificats");
  const sync = mb.sync ?? SYNC_ALL; // a mailbox saved without the choice synchronises everything
  if (!sync || typeof sync !== "object" || SYNC_KINDS.some((k) => typeof sync[k] !== "boolean")) fail("éléments à synchroniser");
  if (!SYNC_KINDS.some((k) => sync[k])) fail("au moins un élément à synchroniser");
  return {
    id: mb.id,
    email: mb.email,
    username: mb.username,
    name: mb.name,
    origin: mb.origin,
    deviceId: mb.deviceId,
    syncMinutes: mb.syncMinutes,
    filterType: String(mb.filterType),
    accountKey: mb.accountKey,
    tlsPins: [...mb.tlsPins],
    sync: Object.fromEntries(SYNC_KINDS.map((k) => [k, sync[k]])),
  };
}

export class Store {
  #locks = new Map();

  /** @param {object} area browser.storage.local (or a test double with get/set/remove) */
  constructor(area = globalThis.browser?.storage?.local) {
    if (!area) throw new StoreError("stockage indisponible");
    this.area = area;
  }

  async init() {
    const schema = await this.get("schema", null);
    if (schema === null) {
      await this.set("schema", SCHEMA);
    } else if (!Number.isInteger(schema) || schema > SCHEMA) {
      throw new StoreError("données enregistrées par une version plus récente de l'extension");
    }
    // Future versions migrate here, from `schema` up to SCHEMA.
  }

  async get(key, fallback = null) {
    const value = (await this.area.get(key))?.[key];
    return value === undefined ? fallback : value;
  }

  async set(key, value) {
    await this.area.set({ [key]: value });
  }

  async remove(keys) {
    await this.area.remove(keys);
  }

  /** Serialise the read-modify-write sequences touching `key`. */
  #withLock(key, fn) {
    const run = (this.#locks.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    this.#locks.set(key, tail);
    tail.then(() => {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    });
    return run;
  }

  // ── Mailboxes ───────────────────────────────────────────────────────────

  async listMailboxes() {
    const list = await this.get(MAILBOXES, []);
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const mb of list) {
      try {
        out.push(checkMailbox(mb));
      } catch {
        /* a damaged entry is skipped, never trusted */
      }
    }
    return out;
  }

  async getMailbox(id) {
    return (await this.listMailboxes()).find((m) => m.id === id) ?? null;
  }

  /** Insert or replace (by id). */
  putMailbox(mailbox) {
    const clean = checkMailbox(mailbox);
    return this.#withLock(MAILBOXES, async () => {
      const list = await this.listMailboxes();
      const i = list.findIndex((m) => m.id === clean.id);
      if (i >= 0) list[i] = clean;
      else list.push(clean);
      await this.set(MAILBOXES, list);
      return clean;
    });
  }

  /**
   * Remove a mailbox and every record it has. From the moment this is
   * called, writes for this mailbox are refused (a sync still running
   * cannot bring part of it back).
   */
  deleteMailbox(id) {
    if (typeof id !== "string" || !ID.test(id)) throw new StoreError("id de boîte invalide");
    this.#deleted.add(id);
    return this.#withLock(MAILBOXES, async () => {
      await this.set(MAILBOXES, (await this.listMailboxes()).filter((m) => m.id !== id));
      await this.#clearRecords(id);
    });
  }

  /**
   * Remove records left by mailboxes that no longer exist (an interrupted
   * deletion, a crash). Reads the whole storage once: call it at start-up.
   */
  async sweepOrphans() {
    const known = new Set((await this.listMailboxes()).map((m) => m.id));
    const all = (await this.area.get(null)) ?? {};
    const orphans = Object.keys(all).filter((k) => {
      const m = /^mb\/([^/]*)\//.exec(k);
      return m && !known.has(m[1]);
    });
    if (orphans.length) await this.remove(orphans);
    return orphans.length;
  }

  // ── Records of one mailbox ──────────────────────────────────────────────

  #deleted = new Set();

  #clearRecords(id) {
    const prefix = `mb/${id}/`;
    return this.#withLock(prefix + NAMES, async () => {
      const names = await this.get(prefix + NAMES, []);
      const keys = (Array.isArray(names) ? names : []).filter((n) => typeof n === "string" && RECORD.test(n)).map((n) => prefix + n);
      await this.remove([...keys, prefix + NAMES]);
    });
  }

  mailbox(id) {
    if (typeof id !== "string" || !ID.test(id)) throw new StoreError("id de boîte invalide");
    const prefix = `mb/${id}/`;
    const namesKey = prefix + NAMES;
    const checkName = (name) => {
      if (typeof name !== "string" || !RECORD.test(name)) throw new StoreError(`nom d'enregistrement invalide : ${name}`);
      return prefix + name;
    };
    const alive = () => {
      if (this.#deleted.has(id)) throw new StoreError("boîte supprimée");
    };
    // Writing a record and listing its name happen under one lock, so a
    // deletion running at the same time can never miss a record.
    const write = (name, value) => {
      const key = checkName(name);
      return this.#withLock(namesKey, async () => {
        alive();
        const names = new Set(await this.get(namesKey, []));
        if (!names.has(name)) {
          names.add(name);
          await this.set(namesKey, [...names]);
        }
        await this.set(key, value);
      });
    };
    const erase = (name) => {
      const key = checkName(name);
      return this.#withLock(namesKey, async () => {
        await this.remove(key);
        const names = new Set(await this.get(namesKey, []));
        if (names.delete(name)) await this.set(namesKey, [...names]);
      });
    };
    return {
      id,
      get: (name, fallback = null) => this.get(checkName(name), fallback),
      set: (name, value) => write(name, value),
      remove: (name) => erase(name),
      /** A Map record (stored as entries). A damaged record reads as an empty Map. */
      getMap: async (name) => toMap(await this.get(checkName(name), [])),
      setMap: (name, map) => write(name, fromMap(map)),
      names: async () => {
        const names = await this.get(namesKey, []);
        return Array.isArray(names) ? names.filter((n) => typeof n === "string" && RECORD.test(n)) : [];
      },
      clear: () => this.#clearRecords(id),
    };
  }
}

/** Stored entries → Map; anything unexpected gives an empty Map. */
export function toMap(entries) {
  const map = new Map();
  if (!Array.isArray(entries)) return map;
  for (const e of entries) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string") return new Map();
    map.set(e[0], e[1]);
  }
  return map;
}

/** Map → storable entries (keys must be strings). */
export function fromMap(map) {
  if (!(map instanceof Map)) throw new StoreError("Map attendue");
  const entries = [];
  for (const [k, value] of map) {
    if (typeof k !== "string") throw new StoreError("clé de Map non textuelle");
    entries.push([k, value]);
  }
  return entries;
}

/** A new mailbox id (12 hex digits) and device id (32 letters/digits), from a CSPRNG. */
export function newIds(random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { mailboxId: hex(random(6)), deviceId: `S443${hex(random(14)).toUpperCase()}` };
}
