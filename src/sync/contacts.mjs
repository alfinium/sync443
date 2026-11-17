// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Contact synchronisation of one mailbox: the engine of sync/pim.mjs, for
 * the contacts folders of the server (types 9 and 14) and the address
 * books of tb/contact-store.mjs.
 *
 *   const contacts = contactSync({ mailbox, records, contactStore, notify, log, now });
 *   await contacts.pass({ client, version, folders, signal, confirmDeletes, only });
 *   // … and everything else a PimSync has.
 *
 * It is the same engine, with the same guards: the mass-deletion
 * threshold, the request written down before it is sent and replayed as
 * it went, the changes of an unwell server never undone. Two things
 * differ, and they are given here:
 *  - its records have names of their own (contactRecords): the calendar
 *    engine of the same mailbox never reads or removes them;
 *  - a contact concerns nobody else: no message is ever planned, queued
 *    or sent for a change (ContactNotices only tells the user).
 */

import { PimSync } from "./pim.mjs";
import { contactNotice } from "../i18n.mjs";

const PREFIX = "ct";
const OURS = /^ct[A-Z]/;
const toOurs = (name) => (typeof name === "string" && /^[a-z]/.test(name) ? PREFIX + name[0].toUpperCase() + name.slice(1) : name);
const fromOurs = (name) => name[PREFIX.length].toLowerCase() + name.slice(PREFIX.length + 1);

/**
 * The records of a mailbox (store.mailbox(id)), seen by the contact engine:
 * every name it gives is stored under a name of its own ("pimOut:7" as
 * "ctPimOut:7"), and it sees no other record.
 */
export function contactRecords(records) {
  return Object.freeze({
    get: (name, fallback = null) => records.get(toOurs(name), fallback),
    set: (name, value) => records.set(toOurs(name), value),
    setMany: (entries) => records.setMany([...(entries instanceof Map ? entries : Array.isArray(entries) ? entries : [])].map(([name, value]) => [toOurs(name), value])),
    remove: (name) => records.remove(toOurs(name)),
    removeMany: (names) => records.removeMany((Array.isArray(names) ? names : []).map(toOurs)),
    getMap: (name) => records.getMap(toOurs(name)),
    setMap: (name, map) => records.setMap(toOurs(name), map),
    names: async () => (await records.names()).filter((name) => OURS.test(name)).map(fromOurs),
  });
}

/** What the engine asks of a scheduler, for items that concern nobody else: nothing is sent, the user is told. */
export class ContactNotices {
  #notify;

  constructor({ notify = null } = {}) {
    this.#notify = typeof notify === "function" ? notify : null;
  }

  /** A change of a contact is never a message to anybody. */
  plan() {
    return PLAIN;
  }

  notice(name, summary, detail = "") {
    const text = contactNotice(name, typeof summary === "string" ? summary : "", detail);
    if (!text || !this.#notify) return;
    try {
      Promise.resolve(this.#notify(text)).catch(() => {});
    } catch {
      /* a notification that fails must not change the outcome */
    }
  }

  async clear() {}

  async deliver() {}

  async answer() {
    throw new TypeError("ContactNotices : un contact n'a pas de réponse");
  }

  async enqueue() {
    throw new TypeError("ContactNotices : un contact n'a pas de message");
  }
}

const PLAIN = Object.freeze({ flow: "plain" });

/** The contact engine of a mailbox: a PimSync of domain "contacts". */
export function contactSync({ mailbox, records, contactStore, notify = null, log = null, now = () => Date.now() }) {
  return new PimSync({
    mailbox,
    records: contactRecords(records),
    calendarStore: contactStore,
    scheduler: new ContactNotices({ notify }),
    log,
    now,
    domain: "contacts",
  });
}
