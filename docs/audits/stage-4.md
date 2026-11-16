# Security audit — stage 4 (calendar, tasks, meetings)

**Scope:** everything added to version 0.2.0 for version 0.3.0.
- `src/experiments/sync443Calendar/`: Sync443's own calendar type (privileged code).
- `src/sync/pim.mjs`, `src/tb/calendar-store.mjs`: the calendar and task synchronization engine.
- `src/core/calendar-item.mjs`, `task-item.mjs`, `recurrence.mjs`, `eas-timezone.mjs`: conversion.
- `src/sync/scheduling.mjs`, `invitations.mjs`, `src/core/itip.mjs`, `meeting-request.mjs`,
  `src/confirm/`: meeting messages and the confirmation window.
- The changes to `src/background.mjs`, `src/sync/mailbox.mjs` and the settings page.

**Method:**
- Three independent audits, by reviewers who had not written the code: the privileged module;
  meeting messages and confirmation; conversion and engine.
- Each finding was reproduced before being accepted, with a probe against the code or, for the
  privileged module, in Thunderbird 140 ESR and 160.
- Each fix is covered by a test that fails without it: every fix was removed in turn on a copy of
  the tree to check that a test then fails.
- The reviewers of meeting messages and of the engine replayed their probes against the fixed code
  and attacked the new code; what they found then is listed below and fixed as well.
- The fixes of the privileged module are verified by the module's own test in Thunderbird 140 and
  160. Its independent re-verification has not been replayed yet.
- An end-to-end scenario in a real Thunderbird, against a simulated ActiveSync server over TLS,
  covers the fixed behaviour on both versions.

**Summary:**
- Found: 5 High, 9 Medium and about 20 Low. Almost all are losses of data or of service that a
  faulty or hostile server could cause; one concerned a message sent without the user's choice.
- All High and Medium findings are fixed. The accepted deviations are listed at the end.
- Sound from the first audit on: no path by which Thunderbird itself sends a meeting message for
  a Sync443 calendar; no call that reaches a calendar that is not Sync443's; the confirmation
  window (what is asked is what is sent, no double sending); the generation of meeting messages
  (no injection); the readers under 150,000 hostile inputs; a local removal never becomes a
  deletion on the server.

## Privileged calendar module

| Severity | Finding | Fix |
|---|---|---|
| High | One item from the server (for instance "day 31 every 12 months" starting in February) made every event of its calendar vanish in Thunderbird 140, and stopped reminders | Five rules a recurrence must pass before Thunderbird is given it, stated once in `src/core/recurrence.mjs` and applied by the readers and again by the module; such an item is shown without its recurrence, read-only |
| High | The privileged check accepted recurrence shapes ActiveSync does not have; some never returned in Thunderbird 140 | Shape rules applied before anything is built, then a bounded expansion inside the module as a backstop |
| Medium | A recurring item longer than its own period produced tens of thousands of overlapping occurrences | Refused (rule 5) |
| Medium | Adding an item with an id the calendar already held silently replaced the user's item | Refused as a duplicate, as Thunderbird's own storage does |
| Medium | A new item never synchronized was deleted when its change was dropped | It stays as a local copy that is no longer synchronized, and the user is told why |
| Low | Change identifiers reused; a deletion forgotten across a restart; a new calendar inheriting rows of an earlier one; no rollback of a failed creation; writes accepted after shutdown; arrays with holes; a journal write not verified | Each fixed; revisions only grow, journal writes are read back |
| Found while fixing | An item whose UID has a character above U+00FF was never found again: its local changes were forgotten | The store is reached without the narrowing interface |
| Hardening | Read-only items could be edited in Thunderbird, then were restored a few seconds later | Thunderbird itself now refuses to edit or delete them (access entries, and refusal by the calendar) |

## Meeting messages and confirmation

| Severity | Finding | Fix |
|---|---|---|
| High | A reply left for the organizer although the user chose "Do not send a response", or only because a status changed | A reply needs Thunderbird's own question to the calendar (`canNotify("REPLY")`), recorded by the privileged module; checked twice before anything is queued |
| Medium | A later mail carrying the same UID took over the user's answer | The invitation table keeps each mail's organizer and start; only a mail that gives those of the event answered can be named; Junk, Sent Items, Drafts, Outbox and Deleted Items are never used |
| Low | A change the server rewrote while it waited could still produce an answer or a message | Marked in the journal in the same write; nothing is ever sent for it |
| Low | An organizer changed by a local change taken at face value | Nothing sent, user told |
| Low | Messages waiting for confirmation outlived an unchecked calendar and never expired | Cleared with the calendar; 24 hours at most; the user is told |
| Low | Display names placed in `To` | Addresses only |
| Low | Silent expiry of a question; time zone of the computer in a reply; sending mailbox not shown | Notifications; times in UTC; "From" line in the window |
| Re-audit, Low | An added event with a preset answer told the server "accepted"; a cancellation proposed too widely when a meeting lost its organizer; a question still open after its calendar was removed | An added event is an answer only when Thunderbird asked to reply; the cancellation requires that nothing else changed; nothing is sent once the queue is cleared |

## Conversion and synchronization engine

| Severity | Finding | Fix |
|---|---|---|
| High | A transient server failure undid the user's changes and deleted new events | A failing answer fails the pass and is retried; tries are counted only for a change sent alone; a new item given up stays as a local copy |
| High | The mass-deletion threshold could be bypassed four ways (SoftDelete, a folder changing type, a period rebuild, padding the collection) | SoftDelete and removals decided from the folder list count; only what the user decided, or what the client can see left the period, is uncounted; the ratio is taken against the smallest size of the last seven days |
| High | A removal held for confirmation destroyed changes not yet sent | Kept while the removal is held; a new item finally dropped becomes a local copy; one notification gives the number |
| Medium | A server change that cannot be read left a stale, writable copy | The copy becomes read-only until a readable version arrives |
| Medium | A concurrent server change was overwritten by the waiting local change | The server wins; the user is told; nothing is sent |
| Medium | ServerIds trusted across a rebuild or a restarted folder list | A waiting change is sent only if the server sent the same item again under that id; collections matched as mail folders are |
| Medium | Text cleaning rewrote titles, places and categories on the server | Joiners kept; any other removal makes the item read-only, so that it is never written back |
| Medium | Changing the server of a mailbox kept the old server's calendars | Removed first, after a confirmation |
| Low | Item cap only on additions; silent endless "success"; a deleted or changed occurrence put back could not be told; a Change without body blanked the notes; task ordering fields erased | Each fixed or refused with an explanation |
| Re-audit, Medium | Padding still beat the threshold when the server waited a day | Seven-day base |
| Re-audit, Low | Honest SoftDeletes after an absence held the whole mailbox; duplicates after unreadable answers; a rule refusing a monthly task due on the 31st | Fixed |

## Accepted deviations

- **No threshold on changes from the server:** the server is the reference for content.
- **Slow deletion:** a server that deletes fewer than 50 items a day in a collection is not held.
- **Lost answer followed by a refused SyncKey:** the protocol gives no way to match a new item
  already created on the server; it may then exist twice.
- **A server that renumbers its items:** the old copies go through the threshold, and the user
  sees doubles until confirming.
- **A hostile server can keep changes waiting** (a rebuild that never ends); nothing is lost or
  sent.
- **A forged invitation that copies the organizer and the start of a real one** can be the mail
  named in an answer. The reply still goes only to the organizer of the event the user answered.
- **Junk is recognized by folder name:** ActiveSync has no type for it.
- **Day 29, 30 or 31:** ActiveSync places it on the last day of a shorter month, Thunderbird skips
  that month.
- **Read-only items:** a reminder dismissed or snoozed is so for the session only.
- **`MeetingResponse` on a status alone:** it tells the server and writes to nobody.
