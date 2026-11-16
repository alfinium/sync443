# Design — stages 2 and 3: accounts and mail

This document sets the contracts between modules for the first usable version (0.1.0, mail).
Each module has a single author at a time; the interfaces below are authoritative. The rules of
[SECURITY-MODEL.md](SECURITY-MODEL.md) apply everywhere.

## Scope of 0.1.0

- **Mailboxes and configuration:** multiple mailboxes, settings page, choice of items (only mail
  is synchronized in this version; calendar, contacts and tasks are saved but ignored, marked
  "coming soon").
- **Mail, in both directions:**
  - folders (create, rename, move, delete);
  - messages (delivery, read, flag, move, deletion);
  - immediate delivery (Ping) or periodic refresh;
  - sending through ActiveSync.
- **Commands:** "Synchronize" button, menus.
- **Out of scope:** calendar, tasks, contacts (stages 4 and 5).

## Message identity

Thunderbird renumbers its messages at every startup: **no Thunderbird identifier is ever kept
from one session to the next.**

- **On the server side**, a message is a `ServerId` in a collection (folder).
- **On the Thunderbird side**, a message is a **Message-ID in a folder**.
- **Message-ID read strictly.** A message's own Message-ID is used only if Thunderbird cannot read it any other way (see `core/mime.mjs`). Otherwise the message is given a stable one before import:
  - `<hex@sync443.invalid>`, where `hex` = 32 hexadecimal characters of the message's SHA-256;
  - its former Message-ID fields are renamed `X-Sync443-Original-Message-ID`.
- **Read again after import.** The Message-ID kept is the one Thunderbird read (`headerMessageId`), the one its events carry. If it is unusable (whitespace, control characters), or if another copy in the folder already has it, this copy (ours, just imported) is permanently deleted, and the message is imported again once under a proper identifier; if that fails again, this second copy is deleted too and the item is quarantined. If kept, even in the trash, such a copy would count against the other message.
- **Mapping per collection:**
  - `items: Map<ServerId, MessageId>`, plus the reverse index `Map<MessageId, Set<ServerId>>` built in memory;
  - for each ServerId, a fingerprint of the imported message: 16 hexadecimal digits of its SHA-256.
- **No aliases.** A server addition whose Message-ID is already in the folder:
  - is linked to a local copy that no ServerId holds, only if the evidence says so. During a full resync: the fingerprint the table had for this Message-ID. Otherwise: the date and the sender address of the copy, as Thunderbird read them;
  - the Message-ID alone is never enough: any sender can reuse that of another message;
  - otherwise, a separate copy is imported under its own identifier, derived from the message, the collection and the ServerId: the same item always gets the same one. A separate copy made by an earlier pass is found again, not made again.
- **Local deletion:** a local message is deleted only if **no remaining** ServerId refers to it.
- **Outside the period.** An item that leaves the chosen period (`SoftDelete`) keeps its link in a separate table (`aged`):
  - the local copy stays, and so does the message on the server;
  - what the user does with it is still sent: deletion by `MoveItems` to the server's trash, flags by `Change`, move by `MoveItems`;
  - this link survives a full resync of the same folder (Status 3: the ServerIds remain valid); it is forgotten only if the server responds that the item no longer exists.
- **Full resync** (SyncKey "0", Status 3, local folder changed or recreated): the table is cleared, then rebuilt.
  - What it held serves as evidence (fingerprints) for linking the local copies.
  - Pending local changes are respected: a message deleted or moved by the user is linked without being imported again, and the journal then sends the deletion; flags not yet sent are not overwritten by the server's.
  - Linked without re-import: only the item whose fingerprint is the one in the previous table, never an item that reuses its Message-ID. These links without a local copy (`held`) are the first ones that the deletion or the move sends.
  - A rebuild can take several passes (a large folder). While it lasts, a change to a message not yet linked waits ("wait": neither sent, nor counted as an attempt, nor settled "as a no-op"); it is sent once the table is complete.
- **Empty response** (HTTP 200 without a body: the server has nothing new; Exchange responds this way for a folder without changes): the SyncKey stays, and a table being rebuilt is complete (an empty folder responds this way right after its initial batch); never for a SyncKey "0", which must receive its key. The commands sent in the request are not considered received; deletions of out-of-period messages are still sent (`MoveItems`).

## Stored data (per mailbox, `store.mailbox(id)`)

| Record | Contents |
|---|---|
| `proto` | `{ asVersion, policyKey }` (client) |
| `health` | health (`sync/health.mjs`), including `failedItems`: server items whose import still fails |
| `hierarchy` | `{ syncKey }` |
| `folders` (Map) | `ServerId → { parentId, name, type }` (as validated by `protocol.parseFolderSync`) |
| `coll:<ServerId>` (via `recordName`) | snapshot of a collection's table: `{ gen, syncKey, path, items: [[ServerId, MessageId, fingerprint], …], aged, quarantine, failed, prior, full, more, window, held }`, where `path` is the path of the local folder (e.g. `/Inbox/Projets`) |
| `cseg:<ServerId>:<n>` | changes to this table since the snapshot (at most 1000 per record), with the SyncKey and the small fields up to date; a new snapshot is written when they exceed the size of the table |
| `journal` | `{ v: 2, seq }`: number of the last local change |
| `journal:<n>` | pending local changes, in chunks of 500 (see below) |
| `pendingDeletes` (Map) | `CollectionId → { items, at, retained, base }`: server deletions not yet decided, or held back by the threshold; `base` is the size of the folder before them. Held-back removal of an entire folder: `{ folder: { path }, messages, retained: true }`, `messages` counted in the local folder |
| `layout` (Map) | `ServerId → { path, ready }`: local folder of each synchronized collection (to link a local change to its collection, and for Ping) |
| `archives` | `{ serverId }`: server folder linked to the local archives folder |
| `renaming` (Map) | `ServerId → path`: temporary name chosen for a folder, recorded just before renaming it |

A table is written in pieces: a batch of 50 messages rewrites one segment, never the whole table.

## Privileged code `sync443Account` (stage 2)

Namespace `sync443Account`, background page only, every argument validated, errors
"`CODE: reason`" as in `sync443Net`.

**Accounts:**
- `ensureAccount({ mailboxId, email, name, fullName? })` → `{ accountKey, identityId, created }`.
  - If a marked account exists for this `mailboxId`, it is updated: name, address; the full name only if the identity has none.
  - Otherwise, a local account (type `none`) is created, with its default folders. It is marked by the server preferences `sync443.owner` (extension identifier) and `sync443.mailbox` (`mailboxId`).
  - **Closed sending:** the identity is attached to a neutral outgoing server, itself marked too (host `sync443.invalid`). If the extension is disabled, sending fails instead of going out through another provider.
- `listAccounts()` → `[{ accountKey, mailboxId }]`: marked accounts only.
- `accountOfIdentity(identityId)` → `{ accountKey, mailboxId } | null`.
- `removeAccount(accountKey)` → `boolean`: marked accounts only, never "Local Folders". Also removes the neutral outgoing server if it is no longer used.

**Passwords** (realm `Sync443` of Thunderbird's password manager; `origin` strictly `https://host[:port]`):
- `getPassword(origin, username)` → `string | null`
- `setPassword(origin, username, password)`
- `removePassword(origin, username)`

## Mail core (pure, testable on its own)

**`core/sha256.mjs`**: `sha256(bytes) → Uint8Array(32)` (FIPS 180-4).

**`core/mime.mjs`** — everything in bytes, in linear time:
- `messageIdOf(bytes)` → `string | null`: Message-ID of the top-level header block, without angle brackets, read strictly so as to be the value Thunderbird keeps (`headerMessageId`) whichever parser it uses. `null` unless:
  - the header block ends within the first MiB;
  - up to the field, the block does not start with a continuation line, has neither NUL nor a lone CR, and every line has a colon after a well-formed name ("Message-ID :" is refused);
  - only one field is named Message-ID in the whole block;
  - its value, unfolded, is exactly `<id>` or a single word (no comment, no second word): 1 to 998 visible ASCII characters, except `< > ( ) " \`.
- `ensureMessageId(bytes)` → `{ bytes, messageId, synthetic }`: without a readable Message-ID, the message is given one by `replaceMessageId`.
- `replaceMessageId(bytes, id)`: the message under another Message-ID.
  - Every Message-ID field of the top-level block is renamed `X-Sync443-Original-Message-ID`, whatever the size of the block: no parser can pick up an old one.
  - The new field is placed first.
  - If the message starts with whitespace, an empty `X-Sync443-Continuation` field follows ours: that line folds into it, never into the Message-ID.
- `dateOf(bytes)`, `fromAddressOf(bytes)`, `addressOf(text)`: date (in milliseconds) and sender address, to compare a server item with a local copy.
- `stripInternalHeaders(bytes)`: removes from **received** messages the headers that Thunderbird interprets (`X-Mozilla-Status`, `X-Mozilla-Status2`, `X-Mozilla-Keys`, `X-Account-Key`, `X-Identity-Key`…), so that a sender cannot set flags or tags.
- `cleanDraft(bytes)`: removes Thunderbird's internal headers from a draft **to be sent**, at the top **and in every MIME part** (`X-Mozilla-*`, `X-Account-Key`, `X-Identity-Key`, `Fcc`, `X-Mozilla-Cloud-Part`…), whatever the size of the headers. A delimiter line costs at most the length of the longest boundary, whatever the nesting depth.

**`core/mail-codec.mjs`**:
- `readEmail(applicationData)` → `{ read, flagged, mime, truncated }`.
  - `read`, `flagged`: `true`, `false`, or `null` if absent.
  - `mime`: `Uint8Array | null`.
- `changeEmail({ read?, flagged? })` → `ApplicationData` elements of a `Change`.
- `mailOptions({ filterType })` → `Options` elements (period, full MIME body).

**`core/folder-tree.mjs`**:
- **Folder types:**
  - `MAIL_TYPES`: 1, 2, 3, 4, 5, 6, 12;
  - `CALENDAR_TYPES`: 8, 13;
  - `CONTACT_TYPES`: 9, 14;
  - `TASK_TYPES`: 7, 15;
  - `specialUse(type)`: 2 → inbox, 3 → drafts, 4 → trash, 5 → sent, 6 → outbox, otherwise `null`.
- `applyChanges(folders, changes)` → new `Map`, from `protocol.parseFolderSync`.
- `buildTree(folders, { kinds })` → `{ nodes: Map<ServerId, { parentId, name, type, depth }>, rejected: [{ serverId, reason }] }`.
  - Keeps only the types of the chosen items.
  - Rejects cycles, unknown parents, a depth beyond 32, and more than 5000 folders.
- `localPaths(tree, { archives })` → `Map<ServerId, path>`, local paths **one-to-one**:
  - Special folders map onto the local special folders (by flag, never by name).
  - `archives`: the ServerId of the folder linked to the archives (`archives` record, never chosen by its name). It maps onto `/Archives`, with its subfolders.
  - Elsewhere, names are made valid on Windows, macOS and Linux, and such that Thunderbird stores the folder under its name (otherwise it uses a hashed file name, and the folder's path no longer carries its name):
    - `/ \ : * ? " < > | ; #` become `_`;
    - a leading `.` becomes `_`;
    - trailing dots and spaces are removed, a trailing `~` becomes `_`;
    - Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`…`COM9`, `LPT1`…`LPT9`, extension included) are suffixed with `_`;
    - a name ending in `.msf` or `.sbd` (case-insensitive), like Thunderbird's files next to a folder, is suffixed with `_`;
    - at most 55 UTF-16 units.
  - Collisions between siblings (case-insensitive), and with the names of the special folders at the root, receive a suffix ` (2)`, ` (3)`… in ServerId order: the result is deterministic.
  - At the root, a name that resembles a reserved name also receives a suffix: case, width, accents, letters from other alphabets that look like Latin letters ("Inbox" written with a Cyrillic I), `I l 1`, `0 o`.

## Sync engine (stage 3)

**Adapters** (`tb/`), the only part that touches Thunderbird's APIs, replaceable by test doubles in tests:
- **`tb/mail-store.mjs`** — an account's folders and messages, by path:
  - folders: `folderExists`, `createFolder(parentPath, name)`, `renameFolder`, `moveFolder`, `listFolders()` → `[{ path, name, specialUse }]` (`name`: the name Thunderbird shows, which may differ from the last segment of the path);
  - messages: `findByMessageId(path, mid)` → `[{ id, flags, date, author }]`, `listMessages(path)`, `importMessage(path, bytes, flags, { messageId })` → `{ id, messageId }` (the Message-ID Thunderbird read), `setFlags(id, flags)`, `moveMessages(ids, path)`, `deleteMessages(ids, { permanent })`, `discardImport(id)` (permanent deletion of a copy this session has just imported, and of nothing else);
  - import deadline (60 s);
  - each write declares its expected echo (see `sync/echo.mjs`);
  - an unread import is then marked read and then unread, so that the folder's file records it as unread;
  - an imported message is guarded in full (see `sync/echo.mjs`) with the flags written, before the import: Thunderbird changes its flags on its own after the copy (marked read to clear "new", unread again, flagged), a number of times that depends on its version.
- **`tb/events.mjs`**: subscribes to `messages.onUpdated/onMoved/onDeleted` and `folders.onCreated/onRenamed/onMoved/onDeleted`. It translates each event of a marked account into a local intent (`{ kind, path, messageId?, flags?, toPath? }`), unless it is an echo of our own writes.

**`sync/echo.mjs`**: echo expectations, matched by value, consumed once, 30 s lifetime, capped in number.
- **Guard of an imported message**: the state of its flags as the engine wrote it, for 30 s at most.
  - A flag event on this message waits for the engine's writes to finish, then compares the message's state at that moment with the guarded state.
  - Equal: nothing to send (marks by Thunderbird or by the engine, or a change already undone). Different: it is a user change, which is sent, and the guard retains this new state.
  - No delay to guess: a real change is never swallowed, even if the event queue falls behind.

**`sync/journal.mjs`**: persistent queue of local changes.
- `{ id, op: "flags" | "move" | "delete" | "folderCreate" | "folderRename" | "folderMove" | "folderDelete", path, messageId?, flags?, toPath?, src?, dst?, … }`
- **Originating collection.** A change to a message keeps the ServerIds of the collections where it was made: `src`, and `dst` for a move. It is sent to that server folder even if the local folders have moved in the meantime (folder renamed on the server, another folder taking its name).
- An entry is removed only after a **positive response from the server for it**; a permanent refusal is logged and removed.
- A transient refusal keeps the entry. Its attempts are counted once per series of passes (`run({ round })`), not per pass; after 20 series, it is abandoned and logged.
- An entry that could not be sent ("wait": folder being rebuilt, initial SyncKey) stays without an attempt being counted, for 100 series at most; beyond that, its attempts are counted again.
- Folders taken over under new ServerIds (partnership reset): `rebind` rewrites `src` and `dst` of the pending entries in one go (ServerIds may move to other folders, or even be swapped), written before the old tables go away. The ServerId of a table that goes away while that ServerId designates another folder is removed: the entry keeps only its local folder (`path`, `toPath`). During the local folders step, `recordIntent` waits: a change made at that moment already receives the new ServerIds.
- **Written in chunks** of 500 entries (`journal:<n>`): one more change rewrites one chunk, never the whole journal.
  - Writes are batched: a write starts 20 ms after the first change and carries everything that changed in the meantime.
  - `append` returns as soon as the entry is in memory, like a pending event; `flush()` and `close()` wait for the write.
  - `{ v: 2 }` in the `journal` record marks the format, so that a later version recognizes it.
- **Permanent local deletion:** `Delete` with `DeletesAsMoves=1` (to the server's Deleted Items), except from the trash.
- **Folder deletion:** a folder is deleted on the server only if it was in the trash, and never a special folder.

**`sync/mail.mjs`**: synchronization of one collection.
- Sync with `WindowSize` 50 and bounded `MoreAvailable` (at most 20 batches per pass).
- Additions are imported after `stripInternalHeaders` and `ensureMessageId`, then linked to the Message-ID that Thunderbird read.
- **Failed import:** the item is kept (`failed`) and requested again (`Fetch`) at the end of the collection's pass, at most 5 times, then quarantined. Their count is in the health state (`failedItems`). An unreadable, empty or truncated item is quarantined immediately.
- **Deletions from the server:**
  - outside the trash, the local copy goes to the local trash;
  - in the trash, it is deleted.
- **Mass-deletion threshold:** more than 50 deletions and more than 20% of the folder.
  - Counted over the whole series of deletions of a collection, until the server has nothing more to send (over several passes if needed), relative to the size of the folder before them. Nothing is applied before then.
  - Also counted over a 24-hour sliding window: a server that deletes a little on each pass is stopped the same way. The window survives a full resync and passes to the collection that takes over a folder; only a confirmation by the user restarts it.
  - Beyond that, the deletions are held back in `pendingDeletes`, the mailbox is blocked (`MASS_DELETE`), and the user confirms in the settings.
- **Table reset** (Status 3, local folder changed or recreated, deletions refused): its held-back deletions are discarded, as they would act on other copies.
- **Local moves:**
  - to a synchronized folder: `MoveItems`;
  - to a folder with no counterpart on the server (local-only folder): the server copy stays where it is, only the link is forgotten. **Never a deletion**;
  - `MoveItems` accepted without `DstMsgId`: the source loses the link, the destination will link the message at its next sync.
- **The SyncKey advances** only if the whole batch is processed; an item that fails does not block the others.

**`sync/push.mjs`**: Ping loop.
- Only on the folders of the chosen items, already synchronized (`layout` record).
- The interval adapts in both directions.
- Minimum delay between two Pings, and backoff on error.

**`sync/mailbox.mjs`**: orchestration of one mailbox.
- One lock per mailbox that nothing forcibly releases, and real cancellation (`AbortController`).
- Health and retry spacing (`sync/health.mjs`).
- Order of a pass:
  1. FolderSync; a folder list without an inbox (type 2) is refused and nothing is changed. A list restarted from scratch (key refused, partnership reset) is saved only at the end of step 2: a pass stopped in between restarts it from scratch and redoes the reconciliation;
  2. local folders;
  3. journal;
  4. collections.
- **Local folders** (step 2):
  - Each collection has its own local folder, or none during this pass: **never two collections on the same folder**. If that happened nonetheless, neither of the two is synchronized.
  - Moves and renames are planned together: a folder takes a place only once it has been freed; a cycle (two folders swapping their names) goes through a temporary name "Sync443 n"; a local special folder never moves, and its collection gives up the place if another one needs it.
  - Folders are designated by their name (the one Thunderbird shows), never by the last segment of their path.
  - A folder that the journal is about to change (local creation, rename or move not yet sent) is left as is.
  - Each local move or rename is saved immediately. The temporary name is recorded before the rename (`renaming` record): a pass stopped right after finds the folder again under that name, and only that one (never a user folder with a similar name). The collection is then rebuilt with its own table as evidence: whatever is missing comes back.
- **Folders gone from the server:**
  - if a new collection is to be at the same place (new ServerIds after a device reset), it takes over the local folder: nothing to the trash, nothing downloaded again. It receives the old table as evidence and its sliding window, and the pending local changes follow it (journal rewritten before the old table goes away);
  - when the folder list is restarted from scratch, no ServerId is taken at face value (the server may have renumbered its folders, or even swapped their ServerIds). Each table is matched again:
    1. by its place: the server folder that wants this local folder takes it over, as above (if it has the same ServerId, the table stays as it is);
    2. otherwise by its ServerId, if that server folder has taken over no other table and keeps its type (simple rename or move: the local folder follows);
    3. otherwise, if its ServerId now designates another folder, the table goes away and its local folder stays in place, unsynchronized; its pending changes keep only their local folder and never reach the other folder;
    4. a table whose ServerId no longer exists is a vanished folder, as usual;
  - otherwise the local folder goes to the local trash; if it is already there, it stays there: **never deleted because of the server**;
  - threshold: if the vanished folders contain enough messages for a mass deletion, or if at least three folders and at least half of the mailbox's folders disappear at once, the removal is held back and confirmed like a mass deletion. Messages are counted in the local folders (local subfolders included), not in the tables, which a server can empty first through a resync. If refused, the folders stay local, without synchronization.
- **Archives:** the local archives folder (`/Archives`, the one used by the "Archive" action) is linked by its ServerId (`archives` record) to a server folder; archiving becomes an ordinary move (`MoveItems`).
  - The "Archives" folder at the root of the server (an ordinary folder, name compared case-insensitively) is linked as early as the folder list: it maps onto `/Archives`, never next to it as "/Archives (2)".
  - If it does not exist, it is created on the server the first time a synchronized message is archived.
  - Held as "/Archives (2)" by an earlier version: its messages join `/Archives` (moved, not downloaded again), its table is kept, its subfolders follow, and the old folder, once emptied, goes to the local trash.
  - The link is dropped if this folder leaves the root or goes to the server's trash (deleted in webmail): `/Archives` becomes local again, the server folder receives its own local folder, and the next archiving creates a new "Archives" folder at the root. It is also dropped when, in a list restarted from scratch, its ServerId designates a folder with another name (renumbered): the "Archives" folder at the root is then linked again.
- **Names sent to the server:** a folder created or renamed locally is sent with the name the user gave it; a moved folder keeps its server name, never a decorated local name ("X (2)", "CON_").
- **`close()`**: stops the current pass and waits for it, stops Ping, writes the journal. After that, the instance writes nothing more: `run()` returns without a pass, `recordIntent()` is refused (code `CLOSED`). The background page calls it before replacing a mailbox's engine, so that two engines never work on the same records.

## Background, sending, settings

**`background.mjs`**: mailboxes, timers (`alarms`), Ping, menus, "Synchronize" button (badge "…" or "!"), messages from the settings page.

**`send.mjs` — closed sending:**
1. For an identity of a marked account, Thunderbird's sending is always canceled.
2. The extension saves the draft, reads it (`messages.getRaw`), applies `cleanDraft`, sends it with `SendMail` (copy in the server's Sent Items), deletes the local draft and closes the window.
3. A second click during sending is ignored.
4. On failure, the window stays open and a notification explains why.
5. Sending by another route is never attempted.

**Settings** (`options/`):
- **Mailbox list:** status, "Synchronize", "Edit", "Remove" with confirmation.
- **Form:**
  - email, password, name, server;
  - frequency (as soon as mail arrives, 1, 5, 15, 30, 60 min);
  - period (1 day to all);
  - **mail, calendar, contacts, tasks checkboxes** (at least one; calendar, contacts and tasks marked "coming soon").
- **Change of origin:** the password must be typed again.
- **Host permission:** requested for the server's origin only, withdrawn when no mailbox uses it any longer.
- **Log:** no personal content. Debugging turns itself off after one hour.
- **Interface:** no data inserted as HTML (`textContent` only), default content policy.

**Manifest:**
- identifier `sync443@alfinium.github.io`, version `0.1.0`;
- `strict_min_version` `140.0`;
- strictly necessary permissions;
- `optional_permissions` `https://*/*`;
- experiments `sync443Net` and `sync443Account`.

**Build and release:**
- `tools/build_xpi.py` produces `dist/sync443-<version>.xpi`, reproducibly (sorted files, fixed dates).
- A `v<version>` tag pushed to GitHub starts the `release.yml` workflow: unit tests, build, publication of the `.xpi` in the Releases.

## Tests

- **Unit**: every module of the core and the engine, with test doubles of the adapters.
- **End-to-end** (`tests/e2e/mail/`):
  - headless Thunderbird, built extension, fake ActiveSync server **over TLS** with a test certificate authority pinned by the test mailbox;
  - scenario: adding mailboxes, first sync, local actions, push, sending, Thunderbird restart, held-back mass deletion, mailbox removal.
