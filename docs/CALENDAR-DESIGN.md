# Design — stage 4: calendar, tasks and meetings

This document sets the contracts between modules for stage 4. The rules of
[SECURITY-MODEL.md](SECURITY-MODEL.md) apply everywhere; the new rules are listed at the end. It
relies only on Microsoft's public specifications ([MS-ASCAL], [MS-ASTASK], [MS-ASCMD],
[MS-ASEMAIL], [MS-ASDTYPE]), RFC 5545 and RFC 5546 (iTIP), and Thunderbird's own calendar code
(140 ESR and 160). No code from another project is used.

## Scope

- **Events, in both directions:**
  - create, edit, move, delete;
  - all-day events, time zones, reminders, categories, free/busy status, privacy;
  - recurring series with their exceptions.
- **Tasks, in both directions:** subject, notes, start and due dates, completion, priority,
  reminder, categories.
- **Invitations received:**
  - the user accepts, accepts tentatively or declines, in Thunderbird;
  - the answer goes to the server (`MeetingResponse`);
  - when the organizer asked for one, a reply goes to the organizer.
- **Meetings organized by the user:**
  - invitations, updates and cancellations to the attendees the user chose in Thunderbird;
  - each sending confirmed by the user in a Sync443 window;
  - the attendees' answers come back from the server.
- **Every message goes through ActiveSync (`SendMail`), never through SMTP.**
- **Settings:** for each mailbox, a calendar period and a task filter. New texts are translated
  into the ten interface languages.
- **Out of scope:**
  - proposing a new time (ActiveSync 12.1–14.1 has no command for it);
  - forwarding an invitation;
  - attachments, the global address list (the availability of attendees is looked up: see
    "Availability of attendees").
- **Shown read-only:** non-Gregorian calendars, and tasks that regenerate after completion.

## Thunderbird side

### A calendar module of our own

Thunderbird has no WebExtension calendar API (140 and 160): everything goes through a new
privileged module, `sync443Calendar`.

**Not Mozilla's calendar experiment.** The experimental calendar API that extensions can bundle
(`thunderbird/webext-experiments`, used by TbSync and by the 0.7 project) is not used, for three
reasons:
- it is under the MPL, and Sync443 contains no code from another project;
- it registers fixed API names, so it would conflict with TbSync or EAS-4-TbSync when both are
  installed;
- it gives access to every calendar, while Sync443 needs only its own.

`sync443Calendar` is written for Sync443 alone. It touches only calendars that carry its marks.

**A provider type of our own:**
- Registered with `cal.manager.registerCalendarProvider("sync443", …)`, before Thunderbird loads
  calendars of that type, and unregistered at shutdown.
- Each calendar of this type wraps an inner, unregistered `storage` calendar (Thunderbird's own
  SQLite store), as Thunderbird's cached calendars do.
- The provider class extends `cal.provider.BaseClass` and never subclasses `CalStorageCalendar`.
- Our calendars are recognized by their type, their id prefix and both marks (calendar
  properties `sync443.owner` and `sync443.mailbox`), never by name.

**Why not a plain `storage` calendar:**
- it would send replies to invitations by SMTP through the default identity;
- read-only mode would also block our own writes;
- on 160, every write refreshes the views.

**Ids:** `sync443-<mailboxId>-<n>`, set before registration. They contain no dot, because
Thunderbird cuts preferences at the first dot.

**Fixed provider properties:**
- `cache.supported` false: otherwise Thunderbird copies the calendar under a new id and drops our
  marks;
- `capabilities.removeModes` empty: deleting is done from Sync443's settings;
- `requiresNetwork` false;
- `providerID` null: otherwise Thunderbird asks about our calendars when the add-on is disabled;
- `capabilities.events.supported` and `capabilities.tasks.supported`, per calendar;
- `organizerId` = `mailto:` + the mailbox's address;
- `supportsScheduling` true, and `canNotify()` true for every method, so Thunderbird never sends
  an invitation, a reply or a cancellation itself;
- `itip.transport` = an object of ours that sends nothing.

**Layout:**
- One calendar per mailbox, named after the mailbox. It holds the events of the server's default
  Calendar folder and the tasks of its default Tasks folder.
- Each further calendar or task folder of the server gets a calendar of its own, named after the
  folder.

**Removal:**
- Removing a mailbox, or unchecking both calendar and tasks, unregisters our calendars and deletes
  their data, after confirmation.
- Nothing is touched on the server.

**Startup:** `cal.manager.getCalendars()` is called before any lookup by id.

**Version differences:**
- Services are reached through `cal` from `calUtils.sys.mjs` only (`cal.manager`,
  `cal.icsService`, `cal.timezoneService`).
- On 140 they are XPCOM services; on 160 they are module singletons.
- `deleteCalendar` takes a listener on 140 and returns a promise on 160.
- On 140, recurrence rules are not capped by Thunderbird: Sync443's own bounds apply.

### Items

**Identity:**
- An item is a `ServerId` in a collection, kept in the inner store's per-item metadata.
- The iCalendar UID is chosen by whoever created the event: it never selects a local item
  (rule 21).

**Writes from the server:**
- They go to the inner store directly, in one batch per pass, so Thunderbird redraws once.
- They never produce a local change.

**Writes from the user:**
- They go through our provider's `adoptItem`, `modifyItem` and `deleteItem`. That covers the event
  dialog, drag and drop, undo, the invitation bar and reminders.
- Each one is recorded in the inner store's per-item metadata, which persists it as the local
  change journal. Thunderbird's offline flags are not used: it does not keep them current for
  recurring items.
- Purely local properties never make a change:
  - dismissed or snoozed reminders (`X-MOZ-LASTACK`, `X-MOZ-SNOOZE-TIME…`);
  - the other `X-MOZ-*` bookkeeping.

**No server data parsed as iCalendar in privileged code:**
- Unprivileged code converts ActiveSync data into an **item description**: plain, validated and
  bounded JSON (contract below).
- The privileged module builds Thunderbird items from it with Thunderbird's constructors
  (`CalEvent`, `CalTodo`, `CalRecurrenceInfo`, `CalAttendee`, `CalAlarm`).
- In the other direction it returns item descriptions, never iCalendar text.
- The privileged module checks every description again against the same bounds before using it.

**Time zones:**
- ActiveSync sends a 172-byte Windows time-zone structure, decoded strictly in unprivileged code.
- The privileged module matches it to a Thunderbird (IANA) zone that has the same offsets and
  rules in the item's year, from Thunderbird's own list.
- When none matches, it builds a zone of ours from the decoded rules.
- The names in the structure are never used as an identifier.

## Contract: the item description

All strings are cleaned (`core/sanitize.mjs`: single line where noted, no control or
bidirectional characters) and bounded.

### Dates

- `UTC`: `"YYYY-MM-DDTHH:MM:SSZ"`.
- `DATE`: `"YYYY-MM-DD"`.
- Years are between 1900 and 2200, and days are real calendar days.

### Event

```
{
  kind: "event",
  uid: string,                 1–300, single line
  summary: string,             0–1024, single line
  location: string,            0–1024, single line
  description: string,         0–32768, plain text
  allDay: boolean,
  start: UTC | DATE,           DATE when allDay
  end: UTC | DATE,             not before start (after it when allDay); DATE when allDay
  timezone: Zone | null,
  busy: "free" | "tentative" | "busy" | "away",
  privacy: "public" | "private" | "confidential",
  reminder: integer | null,    minutes before start, 0–40320
  categories: string[],        at most 50, each 1–255, single line
  organizer: Person | null,
  attendees: Attendee[],       at most 500
  meeting: {
    role: "none" | "organizer" | "attendee",
    cancelled: boolean,
    responseRequested: boolean,
    response: "none" | "tentative" | "accepted" | "declined" | "not-responded",
    allowNewTime: boolean
  },
  recurrence: Recurrence | null,
  exceptions: Exception[],     at most 256, distinct originalStart
  stamp: UTC | null,
  sequence: integer,           0–2147483647
  readOnly: null | "calendar-type" | "unsupported-recurrence" | "incomplete"
}
```

`readOnly` is "incomplete" when the server's item holds something the description cannot
carry (an attendee without a usable address, more attendees or categories than the bounds): a
change made from it would erase that on the server.

`meeting.response` is the user's own answer. `meeting.role` is "organizer" only when the
organizer's address is the mailbox's own.

### Person, attendee, zone

```
Person   { email: string (validated address, 3–254), name: string (0–256, single line) }
Attendee { ...Person,
           role: "required" | "optional" | "resource",
           status: "unknown" | "tentative" | "accepted" | "declined" | "not-responded" }
Zone     { bias: integer (minutes, -840–840),
           standard: { bias: integer (-840–840), change: Change | null },
           daylight: { bias: integer (-840–840), change: Change | null } }
           standard.change and daylight.change are both null or both set.
Change   { month: 1–12, week: 1–5 (5 = last), weekday: 0–6 (0 = Sunday),
           hour: 0–23, minute: 0–59 }
```

### Recurrence and exceptions

```
Recurrence { freq: "daily" | "weekly" | "monthly" | "yearly",
             interval: 1–999,
             count: 1–999 | null,      tasks: 1–255; never with until
             until: UTC | DATE | null,
             byDay: ("SU"|"MO"|"TU"|"WE"|"TH"|"FR"|"SA")[],   at most 7, distinct
             bySetPos: -1 | 1–4 | null,
             byMonthDay: 1–31 | null,
             byMonth: 1–12 | null,
             weekStart: "SU" … "SA" | null }
Exception  { originalStart: UTC | DATE,
             deleted: boolean,
             changes: subset of { summary, location, description, allDay, start, end,
                                  busy, privacy, reminder, categories, attendees, cancelled } }
```

A recurrence that ActiveSync cannot express is never approximated. Sync443 refuses it on a local
change, with a clear message; an item that contains one is read-only.

### Task

```
{
  kind: "task",
  uid, summary, description, categories, privacy: as for an event,
  start: DATE | null,
  due: DATE | null,               not before start
  completed: boolean,
  completedAt: UTC | null,        set when completed
  priority: "low" | "normal" | "high",
  reminderAt: UTC | null,
  recurrence: Recurrence | null,
  readOnly: null | "regenerating" | "unsupported-recurrence" | "incomplete",
  ordinalDate, subOrdinalDate: optional text, at most 40 characters (the server's ordering of
                                  tasks, carried so that a change does not erase it)
}
```

**What the server does not say.** In a description read from the server, two fields may be
`null`: `description`, for a Change command that has no Body element, and `meeting.response`,
before ActiveSync 14.0 for someone else's meeting (`ResponseType` exists from 14.0). The
privileged module then keeps what it holds. A description that comes from Thunderbird never has
them `null`.

**Text.** Titles, places, notes and categories keep the zero-width joiner and non-joiner (U+200C,
U+200D), which some scripts and emoji need. Any other invisible or bidirectional character is
removed, and so are bytes that are not UTF-8: the item is then read-only (`"incomplete"`), so
that the cleaned text is never written back in place of the server's. Names of people and of
calendars are cleaned strictly.

## Contract: the privileged module `sync443Calendar`

All functions are asynchronous. Every argument is validated, and every refusal is an error
`"CODE: reason"`. Calendars that are not ours are invisible to every function.

| Function | Effect |
|---|---|
| `listCalendars()` | `[{ calendarId, mailboxId, slot, name, events, tasks }]`, our calendars only. |
| `ensureCalendar({ mailboxId, slot, name, events, tasks, organizerEmail })` | Creates or updates our calendar for this slot, and returns `{ calendarId, created }`. `slot` is `"main"` or names the server folder. A new calendar starts empty: rows left under its id in the inner store are deleted first. One that cannot be created whole (its store does not open) is not registered at all. |
| `removeCalendar(calendarId)` | Unregisters the calendar and deletes its data; returns a boolean. |
| `applyServerChanges(calendarId, changes)` | Applies a batch of `{ op: "put", collectionId, serverId, item }` and `{ op: "remove", collectionId, serverId }` (removal also covers an item leaving the period), `{ op: "detach", collectionId, serverId }`: the item stays but is no longer linked to the server, and no local change is recorded, and `{ op: "lock", collectionId, serverId }`: the item keeps its content and its synchronized description becomes read-only (`readOnly: "incomplete"`), for an item the server changed into something that cannot be read; the next `put` replaces it as usual. Returns `[{ serverId, ok, code? }]`; `code` is `INVALID` (outside the contract), `TOO_LARGE`, `KIND`, `UNSUPPORTED` (a recurrence Thunderbird must not be given: a shape ActiveSync does not have, an `until` that is not of the kind of the start, a day 29 to 31 that none of the first four periods has, an item longer than its own period, or a series Thunderbird fails to expand), `LIMIT` (the calendar holds 50,000 items and the `put` would add one) or `INTERNAL`. In the item of a `put`, `description: null` and `meeting.response: null` mean "the server does not say": what is held is kept (an empty text, and "not-responded", for an item that is new); neither is ever stored or returned. A task may carry `ordinalDate` and `subOrdinalDate` (text, at most 40 characters): they are kept with its synchronized description and returned with it. Content (title, place, notes, categories) may hold U+200C and U+200D; names of people and of calendars may not. A `put` on an item that has a pending local change only replaces its synchronized description and, when that description is no longer the same, marks the change `rewritten` in the same write. An item whose synchronized description is read-only (`readOnly` not null, or locked) is read-only in Thunderbird as well: its access entry says it cannot be modified nor answered (the editing dialog opens as a summary, the day and week views do not move it), and a change or a deletion made through the calendar object is refused (`CAL_IS_READONLY`), so nothing has to be undone later; the next readable `put` makes it an ordinary item again. |
| `serverIds(calendarId, collectionId)` | The ServerIds of the items held, for a full resync. |
| `readLocalChanges(calendarId, { max })` | `[{ changeId, op: "add" \| "modify" \| "delete", kind: "event" \| "task", collectionId, serverId \| null, item \| null, previous \| null, problem, detached, rewritten, replyAsked }]`. `previous` is the last description synchronized, so that meeting changes can be compared. `problem` is null, or says why the item cannot be described (`"recurrence"`, `"read-only"`, `"too-large"`); `item` is then null. `detached` is true for an item that was detached and that the user changed since (reported as an add). `rewritten` is true when the server changed the item while the change waited (`previous` is then the server's new description); it is kept in the journal and goes with the change. `replyAsked` is true when Thunderbird asked `canNotify("REPLY")` for the answer the item carries, which it does only when it would send that answer to the organizer itself (not after "Do not send a response", "Add to calendar" or an import); it is kept in the journal, and is always false for a delete. The user's own answer to someone else's meeting is not returned during the 2 seconds that follow it (Thunderbird asks only once the item is changed): `onLocalChange` fires again when it can be read. A `changeId` never names two changes: the revision of an item only grows. |
| `ackLocalChange(calendarId, changeId, { serverId?, collectionId?, item? })` | The server accepted the change. `serverId` and `collectionId` bind an added item; `item` is the description now synchronized. Returns false when the user changed the item again meanwhile: the binding is kept, and the newer change comes at the next read. Returns false too, changing nothing, for a change that was settled already (an acknowledgement that comes twice). An item that was created, read, then deleted keeps its journal row, also across a restart: acknowledged, its deletion is read next. |
| `dropLocalChange(calendarId, changeId)` | The change is undone locally: the last synchronized version is restored, a deleted item comes back. An item never synchronized is not deleted: it stays in the calendar as a detached local copy, with nothing to send. Returns false, undoing nothing, when the user changed the item again meanwhile. |
| `onLocalChange` (event) | `calendarId`: a user change was recorded, or a change that `readLocalChanges` held back can now be read. |

### Limits

- At most 200 changes per call, and 50 calendars of ours.
- Descriptions are checked against the contract above, and limited to 1 MiB each.
- An add made in a `"main"` calendar has no collection yet: the engine chooses it from the item's
  kind.
- A server change to an item that has a pending local change only replaces its synchronized
  description, and marks the change `rewritten`; a removal always wins, and takes the pending
  change with it.
- A calendar holds at most 50,000 items.

## Server side

### Collections

- Calendar folders (types 8 and 13) and task folders (types 7 and 15) become collections of the
  mailbox, like mail folders.
- They keep the same safeguards:
  - SyncKey;
  - local changes acknowledged one by one;
  - mass-deletion threshold, judged per collection and over 24 hours, against the size the
    collection had when the 24 hours began (items added meanwhile do not dilute it);
  - `SoftDelete` counts as a deletion: only the server says that an item left the period;
  - every removal decided from the server's folder list counts too (a folder gone, a folder
    whose type changed). Only what the user decided is removed without the threshold: a kind
    unchecked, a mailbox removed, and, after a narrowed period or filter, the items the client
    can see are out of it (an event that ended before the limit, a completed task);
  - deletions held by the threshold wait for the user, as for mail: confirmed, they are applied;
    refused ("keep the local copies"), the items stay in the calendar, detached from the server.
- **Options:**
  - FilterType 0, 4, 5, 6 or 7 for calendars, and 0 or 8 for tasks;
  - plain-text body (`BodyPreference` type 1) with a size limit;
  - `Supported` sent with the first Sync, listing every property Sync443 handles, so that the
    properties it does not handle are kept on the server instead of being erased by a change.
- **Conflicts:**
  - the server wins (`Conflict` 1);
  - a local change the server refuses for good (item status 6, 7 or 8) is dropped, and the item
    is fetched again;
  - a change that waited while the server changed the same item (`rewritten`) is dropped: the
    server's version is shown, the user is told, and nothing is sent to anyone for it;
  - the log says so, without content.
- **A server that is unwell undoes nothing:**
  - a collection status that is not a success, an empty answer to commands, or a transient item
    status fails the pass, which is retried with the usual spacing; the change waits;
  - when a request keeps failing as a whole, its changes are sent one at a time to find the one
    refused; only then are tries counted;
  - a new item that is finally given up is never deleted: it stays in the calendar as a local
    copy that is no longer synchronized, and the user is told why.
- **Rebuilds:**
  - while a collection is rebuilt (SyncKey 0), changes and deletions of its items wait; each is
    sent only if the server sent that ServerId again for the same item (same UID for an event,
    same subject and dates for a task). Otherwise the user's version stays as a local copy;
  - after a folder list restarted from zero, calendar and task collections are matched as mail
    folders are (rules 18 and 19), and a collection whose folder has a new ServerId is rebuilt
    in its own calendar;
  - limitation: a server that numbers its items again makes the old copies go through the
    mass-deletion threshold.
- **Changes that cannot be told to the server** are refused with an explanation: an occurrence
  that was changed or deleted and is put back into its series, and an occurrence that loses its
  own text.
- **No guard on a Change from the server:** the server is the reference for content.

### Conversion

New unprivileged modules in `src/core/`:
- `eas-timezone.mjs`: the time-zone structure, decoded and encoded strictly (exactly 172 bytes,
  every field in range). It also provides the UTC offset in force at a given date.
- `recurrence.mjs`: ActiveSync recurrence ⇄ `Recurrence`.
  - Every value is range-checked by type, as [MS-ASCAL] 2.2.2.37 requires.
  - A rule ActiveSync cannot express is refused.
  - The file states five rules a recurrence must pass before Thunderbird is given it. Outside
    them, Thunderbird 140 can hide every event of the calendar or never return: a shape
    ActiveSync does not have, a monthly or yearly rule on day 29, 30 or 31 that none of its first
    four periods has, an item longer than its own period. Such an item from the server is shown
    without its recurrence, read-only; the privileged module applies the same rules again, then
    tries a bounded expansion.
  - Known difference: ActiveSync puts "day 29, 30 or 31" on the last day of a shorter month,
    Thunderbird skips that month. The first day of a series is always shown, even when it does
    not match the rule.
- `calendar-item.mjs`: calendar ApplicationData ⇄ event description.
  - Compact DateTime parsing is strict: exactly 16 characters, real dates, bounded years.
  - Enumerations are looked up through `Map`; out-of-range values become defaults.
  - Attendees are capped and their addresses validated.
- `task-item.mjs`: task ApplicationData ⇄ task description.
- `itip.mjs`: iTIP messages written by Sync443:
  - REQUEST, CANCEL and REPLY ([RFC 5546]), with RFC 5545 escaping and line folding;
  - wrapped in a MIME message for `SendMail` (`text/calendar; method=…`, plus a plain-text part).
- `meeting-request.mjs`: the `MeetingRequest` element of an invitation mail, including a strictly
  bounded `GlobalObjId`.

### Invitations received

- On the server, an invitation arrives as a mail (`MeetingRequest`) and, on Exchange, as a
  tentative event in the calendar.
- The user answers from the invitation bar of the mail, or from the event. Either way, Thunderbird
  records a change of the user's own participation status in our calendar.
- Two shapes of local change mean an answer:
  - the user's own status changes on an event already on the server;
  - an event whose organizer is someone else is added from the invitation bar, on a server that
    does not put invitations in the calendar itself, and its invitation mail is known.
- Sync443 then:
  1. sends `MeetingResponse` (1 accept, 2 tentative, 3 decline), which tells the server and
     writes to nobody:
     - with ActiveSync 14.1 and an event already on the server, on the calendar item;
     - otherwise on the invitation mail, which requires mail to be synchronized for that
       mailbox;
  2. binds the event to the calendar item the server names (`CalendarId`), when it was added
     locally;
  3. sends one REPLY, to the organizer only, when the organizer asked for an answer **and the
     user chose to send one**;
  4. synchronizes the calendar.
- **A reply needs the user's choice, not a status.** Thunderbird asks the calendar whether it
  sends the reply itself (`canNotify("REPLY")`) only when the user answered with a response to
  send. The privileged module records that question on the change (`replyAsked`). "Do not send a
  response", "Add to calendar", an imported file or a status changed by any other means never
  give a reply.
- **Finding the invitation mail:**
  - the mail engine keeps, for each mailbox, a bounded table of the invitations it holds (at
    most 500, and 8 for one meeting), each with its organizer and its start;
  - mails in Junk, Sent Items, Drafts, Outbox and Deleted Items are never noted;
  - the mail answered is the most recent one that gives the organizer and the start of the
    event the user answered. A mail that gives another organizer or another start is ignored,
    whatever UID it carries;
  - this choice only names which request the server is asked to process: the server checks it,
    and the reply still goes to the organizer of the event the user answered.
- **When no mail can be named** (none known, or mail not synchronized): the change is
  synchronized as a plain change and the event stays. If the user had asked for a reply, a
  notification says that none was sent. An event with attendees that was simply added is a plain
  event: never answered, never removed.
- **ActiveSync 12.1:** the server cannot say what the user answered; the answer given in
  Thunderbird is kept locally.
- **Deleting** an invitation's event deletes it on the server, and sends nothing.
- No confirmation window: answering is already the user's explicit action, and only one message
  goes to one person.
- With 14.1, `MeetingMessageType` 6 ("delegated"): no answer is sent.

### Meetings organized by the user

- **What counts:** a local change, by the user, to an event whose organizer is the mailbox's own
  address and which has attendees.
- **What Sync443 does:**
  1. synchronizes the change with the server first;
  2. works out the messages:
     - new meeting: REQUEST to every attendee;
     - change of time, recurrence, location, subject, description or attendees: REQUEST with
       a higher SEQUENCE to the current attendees, and CANCEL to removed attendees;
     - deleted meeting or cancelled occurrence: CANCEL to the attendees;
     - every attendee removed: CANCEL to those who were invited;
     - organizer changed to another address: no message, and the user is told;
     - any other change (reminder, category…): no message;
  3. asks the user in a Sync443 window: the sending mailbox's address, the event's subject and
     date, the kind of message, and the number and list of recipients, with the buttons **Send**
     and **Don't send**;
  4. on **Send**, sends one message through `SendMail` (copy in Sent Items) with the attendees as
     recipients. On **Don't send**, or when the window is closed, nothing is sent, and the event
     stays as saved.
- **Limits:**
  - at most 100 attendees per meeting: beyond that, the change is refused before anything is
    sent;
  - at most one message of each kind per change: one update to the attendees who stay, one
    cancellation to those removed, each confirmed separately;
  - the organizer is always the mailbox's own address;
  - recipients are the event's attendees, as validated addresses only (a display name never
    goes into `To`);
  - a change coming from the server never leads to a message, and neither does a change of the
    user that the server rewrote meanwhile;
  - a message waits at most 24 hours for its confirmation, and a question stays open 10
    minutes: in both cases the user is told that nothing was sent.
- **Failures:**
  - a refused sending is shown in a notification and is not retried by itself;
  - an uncertain one (connection lost after sending) is reported as uncertain, and never sent
    again automatically.

### Background messages for the confirmation window

- The background opens `confirm/confirm.html?token=<random>` with `windows.create` (type popup).
- The page asks `{ type: "meetingConfirmInfo", token }` and receives
  `{ kind: "invite" | "update" | "cancel", from, summary, start, allDay, recipients: [email] }`.
- It answers `{ type: "meetingConfirm", token, send: boolean }`.
- The token is usable once, and expires after 10 minutes.

### Availability of attendees

Thunderbird's attendee window shows when each attendee is busy, from whatever its free/busy
providers answer. The privileged module registers one, and the mailbox's server is asked
(`ResolveRecipients` with `Availability`, [MS-ASCMD] 2.2.1.15; ActiveSync 14.0 and 14.1).

- **For which meetings.** Thunderbird does not say for which calendar it asks. Its attendee
  window, the only place it asks from, knows its calendar: the provider answers only while such a
  window is open on a calendar of ours, and names the mailbox of that calendar. With no such
  window, with the window of another calendar, or with windows of several mailboxes, nothing is
  asked and Thunderbird is answered at once with nothing. The addresses of a meeting of another
  calendar never leave Thunderbird.
- **What leaves.** The address of the attendee and the span of time, to the server of the mailbox:
  what an invitation to that attendee would give it. Nothing is sent to the attendee or to
  anybody else. No certificate, no picture and no suggestion of other names is asked for.
- **What comes back** is checked twice: the digits of `MergedFreeBusy` (one per half hour: free,
  tentative, busy, out of office, no data) by `core/protocol.mjs`, then each interval by the
  privileged module before Thunderbird is given it. A request is answered once; one that is not
  answered within 30 seconds counts as answered with nothing.
- **When nothing is asked of the server:** the mailbox does not synchronize its calendar, is
  blocked (after an authentication failure nothing is tried again by itself), or speaks a
  protocol before 14.0. An answer is kept two minutes, since the window asks again at every
  scroll.
- The log names no address.

## Settings and texts

- **New mailbox fields** (`src/sync/store.mjs`, validated like the others):
  - `calendarPeriod`: "0", "4", "5", "6" or "7"; default "7" (6 months back; future items are
    always kept);
  - `taskFilter`: "0" (all tasks) or "8" (incomplete tasks only); default "0".
- They are shown in the form only when calendar or tasks are checked.
- Unchecking calendar or tasks, removing a mailbox, and changing its server or sign-in name
  remove its calendars from Thunderbird, after a confirmation that says that changes not yet
  sent are lost. Nothing is deleted on the server.
- The "coming soon" mark goes away for calendar and tasks; contacts keep it (stage 5).
- Every new text is translated into the ten languages, with the existing catalog checks.

## Module ownership during the writing

Each file has a single author; the contracts above are authoritative.

| Part | Files |
|---|---|
| Conversion | `src/core/eas-timezone.mjs`, `recurrence.mjs`, `calendar-item.mjs`, `task-item.mjs`, `src/core/codepages.mjs`, and their tests |
| Meeting messages | `src/core/itip.mjs`, `meeting-request.mjs`, `src/core/mail-codec.mjs` (MeetingRequest only), and their tests |
| Privileged module | `src/experiments/sync443Calendar/`, `src/manifest.json`, `tests/e2e/calendar/` |
| Engine | `src/sync/pim.mjs`, `src/sync/scheduling.mjs`, `src/sync/mailbox.mjs`, `src/sync/store.mjs`, `src/background.mjs`, and their tests |
| Interface | `src/options/`, `src/confirm/`, `src/_locales/*/messages.json`, `src/i18n.mjs` |
| Fake server and scenario | `tests/e2e/mail/mock_eas.py`, `test_mock_eas.py`, `run_mail_test.py`, `test-scenario.mjs` |

## Tests

- **Unit tests:** every conversion, in both directions:
  - hostile time-zone structures;
  - every recurrence type and range;
  - exceptions, attendees, all-day events;
  - iTIP escaping and folding.
- **Engine tests:**
  - local changes, conflicts, mass deletion;
  - the meeting messages worked out for each kind of change;
  - no message from a server change.
- **Fake server:**
  - Sync of calendar and task classes with `Supported`;
  - MeetingRequest mails, `MeetingResponse`;
  - `SendMail` recording its calendar parts.
- **End to end,** in Thunderbird 140 and 160:
  - events and tasks in both directions, a series with exceptions;
  - an invitation accepted, then declined;
  - a meeting organized, changed, then cancelled, with **Send** and with **Don't send**;
  - nothing sent through SMTP;
  - period change, mass deletion held back, removal of the mailbox.
- **Security audit** by an independent reviewer at the end of the stage.
- **Provenance check** against the earlier projects, including the 0.7 project's calendar module,
  which must not be used.

## Security rules

Stage 4 added rules 20 to 25 to [SECURITY-MODEL.md](SECURITY-MODEL.md), under "Calendar, tasks and
meetings". The audit of the stage and what it changed are in
[audits/stage-4.md](audits/stage-4.md).
