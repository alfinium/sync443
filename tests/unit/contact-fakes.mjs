// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Test doubles for the contact part.
 *
 *   FakeAddressBooks   Thunderbird's `addressBooks` and `contacts` APIs, in
 *                      memory, as far as src/tb/contact-store.mjs uses them:
 *                      books and contacts with a vCard, ids taken from the
 *                      card's UID, events for every change (those of the
 *                      extension included, as in Thunderbird). user*()
 *                      methods play the user.
 *   contact()          a contact description for the tests.
 */

import { uidOfVCard } from "../../src/core/vcard.mjs";

export function contact(over = {}) {
  return {
    kind: "contact",
    uid: "c-1",
    description: "",
    categories: [],
    children: [],
    fields: {},
    birthday: null,
    anniversary: null,
    picture: null,
    readOnly: null,
    ...over,
  };
}

class FakeEvent {
  listeners = new Set();
  addListener(fn) {
    this.listeners.add(fn);
  }
  removeListener(fn) {
    this.listeners.delete(fn);
  }
  fire(...args) {
    for (const fn of [...this.listeners]) fn(...args);
  }
}

export class FakeAddressBooks {
  books = new Map(); // id → { name, contacts: Map<id, vCard> }
  calls = [];
  #n = 0;
  /** When set, Thunderbird changes each card it is given (as a real one may): the text is passed through it. */
  normalize = (text) => text;

  constructor() {
    const self = this;
    this.addressBooks = {
      onDeleted: new FakeEvent(),
      async create({ name }) {
        const id = `book-${++self.#n}`;
        self.books.set(id, { name, contacts: new Map() });
        self.calls.push(["addressBooks.create", id]);
        return id;
      },
      async get(id) {
        const book = self.books.get(id);
        if (!book) throw new Error("no such book");
        return { id, name: book.name, type: "addressBook" };
      },
      async delete(id) {
        if (!self.books.delete(id)) throw new Error("no such book");
        self.calls.push(["addressBooks.delete", id]);
        self.addressBooks.onDeleted.fire(id);
      },
      async list() {
        return [...self.books].map(([id, b]) => ({ id, name: b.name, type: "addressBook" }));
      },
    };
    this.contacts = {
      onCreated: new FakeEvent(),
      onUpdated: new FakeEvent(),
      onDeleted: new FakeEvent(),
      async list(parentId) {
        const book = self.books.get(parentId);
        if (!book) throw new Error("no such book");
        return [...book.contacts].map(([id, vCard]) => self.#node(parentId, id, vCard));
      },
      async get(id) {
        for (const [parentId, book] of self.books) if (book.contacts.has(id)) return self.#node(parentId, id, book.contacts.get(id));
        throw new Error("no such contact");
      },
      async create(parentId, id, properties) {
        return self.#create(parentId, id, properties.vCard);
      },
      async update(id, properties) {
        for (const [parentId, book] of self.books) {
          if (!book.contacts.has(id)) continue;
          book.contacts.set(id, self.normalize(properties.vCard));
          self.calls.push(["contacts.update", id]);
          self.contacts.onUpdated.fire(self.#node(parentId, id, book.contacts.get(id)), {});
          return;
        }
        throw new Error("no such contact");
      },
      async delete(id) {
        for (const [parentId, book] of self.books) {
          if (!book.contacts.delete(id)) continue;
          self.calls.push(["contacts.delete", id]);
          self.contacts.onDeleted.fire(parentId, id);
          return;
        }
        throw new Error("no such contact");
      },
    };
  }

  #node(parentId, id, vCard) {
    return { id, parentId, type: "contact", properties: { vCard } };
  }

  #create(parentId, id, vCard) {
    const book = this.books.get(parentId);
    if (!book) throw new Error("no such book");
    const uid = id ?? uidOfVCard(vCard) ?? `tb-${++this.#n}`;
    for (const b of this.books.values()) if (b.contacts.has(uid)) throw new Error("duplicate id");
    book.contacts.set(uid, this.normalize(vCard));
    this.calls.push(["contacts.create", uid]);
    this.contacts.onCreated.fire(this.#node(parentId, uid, book.contacts.get(uid)));
    return uid;
  }

  card(bookId, id) {
    return this.books.get(bookId)?.contacts.get(id) ?? null;
  }

  ids(bookId) {
    return [...(this.books.get(bookId)?.contacts.keys() ?? [])];
  }

  // ── The user ────────────────────────────────────────────────────────────

  /** The user makes a contact from the lines of a card. → its id */
  userAdd(bookId, lines, id = null) {
    const uid = id ?? `tb-${++this.#n}`;
    return this.#create(bookId, uid, ["BEGIN:VCARD", "VERSION:4.0", `UID:${uid}`, ...lines, "END:VCARD", ""].join("\r\n"));
  }

  /** The user edits a contact: `edit(lines)` → lines (BEGIN and END left out). */
  userEdit(bookId, id, edit) {
    const book = this.books.get(bookId);
    const lines = book.contacts.get(id).split("\r\n").filter((l) => l && l !== "BEGIN:VCARD" && l !== "END:VCARD");
    book.contacts.set(id, ["BEGIN:VCARD", ...edit(lines), "END:VCARD", ""].join("\r\n"));
    this.contacts.onUpdated.fire(this.#node(bookId, id, book.contacts.get(id)), {});
  }

  userDelete(bookId, id) {
    this.books.get(bookId).contacts.delete(id);
    this.contacts.onDeleted.fire(bookId, id);
  }

  /** A contact disappears without Thunderbird saying so (the extension was not listening). */
  vanish(bookId, id) {
    this.books.get(bookId).contacts.delete(id);
  }

  userDeleteBook(bookId) {
    this.books.delete(bookId);
    this.addressBooks.onDeleted.fire(bookId);
  }
}
