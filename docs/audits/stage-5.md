# Security audit — stage 5 (contacts)

**Scope:** everything added to version 0.3.0 for version 0.4.0.
- `src/core/contact-item.mjs`, `src/core/vcard.mjs`: conversion.
- `src/tb/contact-store.mjs`: the address books of a mailbox, through Thunderbird's own
  `addressBooks` and `contacts` APIs.
- `src/sync/contacts.mjs`, and the changes to `src/sync/pim.mjs`, `src/sync/mailbox.mjs`,
  `src/background.mjs` and the settings page.

**Method:**
- One independent audit, by a reviewer who had not written the code and could not change it.
- Each finding was reproduced by the reviewer with a probe against the code before it was reported.
- Each fix is covered by a unit test named after the audit (`tests/unit/contact-store.test.mjs`,
  `contacts.test.mjs`, `contact-item.test.mjs`).
- The fixed address book module passes its end-to-end test in Thunderbird 140 ESR and 160.
- The fixes have not been replayed by the reviewer.

**Summary:**
- Found: 1 High, 2 Medium and 9 Low.
- The High, both Medium and six Low findings are fixed. The accepted deviations are listed at the
  end.
- Sound from the audit on: the writing of cards (20,000 hostile descriptions, no injected or stray
  line); the cost of reading hostile cards (1 MiB in at most 130 ms, nothing superlinear); a
  contact that is merely missing is never deleted on the server; what a card cannot say goes back
  to the server as received; the records of the contact engine and of the calendar engine never
  meet; no log line carries a name, an address or a number.

## Findings

| Severity | Finding | Fix |
|---|---|---|
| High | A deletion asked by the server could delete a contact the user had moved or copied to another address book: a contact keeps its id across books, and the deletion did not check where the contact was | A contact is located before any write. One that lies in another book is the user's: it is never deleted or rewritten, and the server's contact gets a card of its own |
| Medium | Contacts made from the server were sent back as new contacts when their records were lost or a write to storage had failed, and existed twice | A card under an id of the extension's own that is not known is never sent; the server's next version takes it back. A write that failed is tried again |
| Medium | What is kept for a book was rewritten whole at every batch, and held the notes of every contact twice | Kept in records of 64 contacts filled one after the other: a batch of new contacts writes a few records, an edit one. The notes are compared by a hash |
| Low | A card grown past what can be read (over 1 MiB) was ignored without a word, then blocked the server's changes to that contact | Reported to the user and undone; a version from the server is written over it |
| Low | A text of the user longer than a contact can hold was cut before it was sent | Refused, with a notification, never cut |
| Low | One failing call to Thunderbird made a book be taken for removed, and a second one be created | Only Thunderbird's list of books says that a book is gone |
| Low | A Birthday at exactly noon UTC was read as the next day | The half goes down |
| Low | A damaged collection record of the contact engine was read as a calendar collection: the book was fetched again and a local change dropped | An engine reads only classes of its own |
| Low | A contact whose id holds a colon was never synchronized | The id is encoded in the change id |
| Low | An end log was written for contacts, which never leave a period | Not written |

## Accepted deviations

- **An e-mail address the server holds with a display name** (`"Name" <address>`) is written back
  as the address alone when the contact is edited in Thunderbird. A card has no place for that
  form.
- **An acknowledgement that arrives after the card changed again** binds the contact and sends the
  card again as the next change. The synchronization engine never does this (a request whose
  answer was lost is replayed before anything is read), so the card and the server cannot drift
  apart through it.
- **A telephone number or an e-mail address that found no place** in a contact stays in the card,
  and may show in a place the server freed. It is not sent.
- **Undoing a change that is too large** undoes the whole edit of that contact, not only the part
  that is too large. The user is told.
- **A picture removed in Thunderbird** is not removed on the server.
- **One period for the whole mailbox:** saving a mailbox that had different periods for mail and
  for the calendar applies the closest single choice.
- **No bound on the total size kept for a book**, beyond those of each contact (20,000 contacts,
  32,768 characters of notes each, kept once).
