# Security audit — stage 6 (finishing)

**Scope:** everything added to version 0.4.0 for versions 0.4.1 and 0.5.0.
- The removal of the local copies of unchecked mail (`src/sync/mailbox.mjs`,
  `src/tb/mail-store.mjs`, `src/sync/journal.mjs`, the settings page).
- The fingerprint of a private certificate authority (`src/core/tls-policy.mjs`, the settings page,
  `src/background.mjs`, `src/sync/store.mjs`).
- The availability of attendees and the handling of a Ping cut by a reverse proxy, published in
  0.4.1 before this audit (`src/sync/availability.mjs`, `src/sync/push.mjs`, the free/busy part of
  the privileged calendar module and of `src/background.mjs`).

**Method:**
- One independent audit, by a reviewer who had not written the code and could not change it.
- Each finding was reproduced by the reviewer with a probe against the code, except two read from
  the code (marked below).
- Each fix is covered by a unit test; the mail scenario runs in Thunderbird 140 ESR and 160.
- The fixes have not been replayed by the reviewer.

**Summary:**
- Found: 2 High, 3 Medium and 4 Low. All of them concerned code that was not published yet, except
  the two Low findings on the availability lookup of 0.4.1.
- Both High and the three Medium findings are fixed, and three of the Low ones. The accepted
  deviations are listed at the end.
- Sound from the audit on: a pinned fingerprint never makes an invalid chain accepted, is never set
  by anything but the user, never follows a mailbox to another server from the settings page, and
  the fingerprint a connection shows is never displayed or logged; an address is looked up for
  availability only for a meeting of a Sync443 calendar, and a hostile answer can only falsify what
  is displayed; a Ping answered by a gateway cannot be made to loop faster than one in 20 seconds,
  and a real failure still surfaces.

## Findings

| Severity | Finding | Fix |
|---|---|---|
| High | The removal of local mail copies ran for any mailbox whose mail was unchecked, whoever had unchecked it and when: a mailbox unchecked under an earlier version would have lost its local copies at the first pass after the update, without a question | The removal runs only on a record the background writes when the settings page sends the user's yes with a change from checked to unchecked. Without it nothing is removed, as before 0.5.0 |
| High | Copies that were no longer on the server were deleted for good: messages whose deletion by the server was held for the user's answer, and the messages of a folder the server had just stopped listing | Neither is touched: a message whose deletion was held is no longer linked and stays; only the folders of collections the server still lists, as mail folders, are emptied |
| Medium | A removal stopped in the middle counted the same messages again at the next pass, and could then delete a copy that was the user's own | Messages go Message-ID by Message-ID, in order, and how far the removal got is written after each batch |
| Medium | Removing an empty folder also deleted a folder of the same name in the trash, even one the user already had there, with its subfolders | A folder in the trash is deleted in turn only when it was not there before, holds no message and has no subfolder |
| Medium (read from the code) | A mailbox with a fingerprint could never move to another server under the same authority: the fingerprint typed again was taken for one left as it was | The settings page says when the field was typed in; a fingerprint typed again is accepted for the new server |
| Low | When the last steps of a removal failed, records of mail stayed for ever and were used again when mail was checked again | The record that asks for the removal goes last: the next pass finishes |
| Low (read from the code) | A failed availability lookup was tried again for every attendee and every scroll, sending the password each time, and ignored the waiting time of the mailbox | A mailbox whose lookup failed is not asked again for 15 minutes; the waiting time of the mailbox is respected; identical lookups under way are shared |
| Low | A ligature was read as two hexadecimal digits of a fingerprint; up to four fingerprints could be stored while the settings page shows one | Tested before the letters are made capitals; one fingerprint at most from the settings page |

## Accepted deviations

- **Copies left after a table was reset:** mail unchecked just after the user refused held
  deletions leaves the copies of that folder in Thunderbird. Nothing is lost; they are counted in
  the log as the user's own.
- **A batch of deletions that fails halfway** (Thunderbird deletes some of 200 messages, then
  fails) is counted again at the next pass: a second copy of one of those messages, if the user
  had made one, could be deleted. The progress is written between batches, not inside one.
- **The removal waits for the server:** it needs the folder list of the pass, to know which
  folders the server still has. While the server cannot be reached, the copies stay.
- **A gateway that answers 504 after 20 seconds or more, for ever,** keeps the mailbox watched at
  about three Pings a minute, without backing off: the same order as a server that reports changes
  at every Ping.
- **The fingerprint flag "typed again"** comes from the settings page, which is the user's own
  page: the background does not check it otherwise.
- Not verifiable without Thunderbird: that its attendee window still has the window type and the
  arguments the availability lookup reads. A change there disables the lookup; it cannot make an
  address leave. The calendar module test checks it on Thunderbird 140 and 160.
