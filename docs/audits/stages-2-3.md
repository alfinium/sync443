# Security audit — stages 2 and 3 (accounts, mail, sending)

**Scope:** everything added to stage 1 for version 0.1.0.
- `src/experiments/sync443Account/`: marked accounts, "Local Folders", neutral outgoing server, passwords (privileged code).
- `src/background.mjs`, `src/send.mjs`, `src/options/`, `src/log.mjs`: orchestration, closed sending, settings, log.
- `src/core/` (MIME, folder tree, mail items) and `src/sync/`, `src/tb/`: the mail sync engine.
- `tools/build_xpi.py` and `.github/workflows/`: build and release.

**Method:**
- Two independent audits, by reviewers who had not written the code:
  - accounts, sending, settings and release;
  - mail core and sync engine.
- An end-to-end test in a real Thunderbird, against a fake ActiveSync server over TLS, which also found defects.
- Six rounds of fix verification by an independent reviewer: each round replays all the previous proofs of concept and looks for what the fixes may have broken. The last round no longer finds any High or Medium vulnerability.
- A cleanup review before release: dead code, impossible branches, leftovers, stale comments, duplicates.
- Each finding was verified before being accepted, almost always with a proof of concept. Each fix is covered by a test that fails before it and passes after it:
  - `tests/unit/audit-engine.test.mjs` (engine), `background.test.mjs` (background script), `send.test.mjs` (sending);
  - `tests/e2e/account/` (privileged code) and `tests/e2e/mail/` (end-to-end mail).

**Summary:**
- All High and Medium vulnerabilities found are fixed. The accepted deviations are listed at the end.
- Two fixes led to removing a mechanism rather than adding one: folder aliases, and the fixed 5-second wait after an import.

## Accounts, sending, settings, release

| Severity | Finding | Fix |
|---|---|---|
| High | Profile without "Local Folders": Thunderbird adopted the Sync443 account as its "Local Folders". The extension lost it, and sending no longer went through ActiveSync | Preference read directly, never through the accessor that adopts; real "Local Folders" created before the first account; repair if the preference designates a Sync443 account |
| Medium | "Closed" sending could be bypassed: the user could remove or replace the identity's neutral outgoing server | `checkSendRoute` before each send and at startup; immediate repair when Thunderbird reports a change (server removed, identity attached elsewhere, neutral server values modified) |
| Medium | Neutral outgoing server reachable through DNS: a hostile network and an intercepting certificate authority received the message | Neutral server on 127.0.0.1, port 1, TLS required, no authentication |
| Medium | Message to be encrypted or signed sent in clear text when drafts are not encrypted | Sending refused if signing or encryption is requested; draft type checked as a second line of defense |
| Low | Compose window unlocked during sending; draft read without checking its account | Lock per window; identity and folder of the draft checked after saving |
| Low | Display name chosen by the server refused by the privileged code after the password was saved | Same character rule everywhere; account prepared before the password, everything undone on failure |
| Low | Email addresses in the log | A mailbox is designated by its identifier |
| Low | Test material and code in the published package | Build: test files refused, test blocks removed from the background script and then verified absent |
| Low | Certificate fingerprints kept after a server change | Forgotten when the origin changes |
| Low | Account removal: folder erased without checking where it is | Files erased only in the profile's Mail folder, never those of another server |
| Low | Neutral server made Thunderbird's default outgoing server | Never designated by the extension; given back to the user's server when one exists |
| Low | Server access permission kept after a failed save | Removed |
| Low | Two mailboxes with the same server and the same sign-in name shared a saved password | Refused |
| Low | Non-atomic server change; concurrent mailbox additions and removals | Old password removed only after the save; mailbox operations serialized |
| Low | Sign-in name rules that differed between modules | Aligned with the privileged code |
| Hardening | Implicit content security policy | Explicit policy in the manifest |
| Hardening | Published package with no means of verification | SHA-256 checksum and signed provenance attestation with each release |

## Mail engine

| Severity | Finding | Fix |
|---|---|---|
| High | A chain of renames on the server attached two server folders to a single local folder; the user's deletions were lost | Global planning of moves, temporary names recorded to break cycles, never two collections on one folder |
| Medium | Local changes lost during a full resync, including over several passes | The journal waits for the rebuild to finish; nothing that the user deleted or moved is re-imported |
| Medium | Changes bound to paths, which were reassigned before the changes were replayed | Changes bound to the server's folder identifiers, rewritten when folders are taken over |
| Medium | Mass-deletion threshold ineffective beyond 5,000 messages | Threshold assessed over the whole series, plus a 24-hour window |
| Medium | Folder disappearances outside the threshold; empty folder list accepted | Disappearances counted and held back; list without an inbox refused; no local folder permanently deleted by the server |
| Medium | "Archive" deleted the message on the server | Archives bound to an "Archives" folder on the server; a move to a local-only folder deletes nothing on the server |
| Medium | Messages that left the synchronized period: user actions lost | Links kept separately, actions sent |
| Medium | A reused Message-ID hijacked a local copy during a resync | Matched only on proof (message fingerprint) |
| Medium | Journal rewritten in full on every action (quadratic cost) | Journal in chunks, writes batched |
| Medium | Device reset on the server side: pending actions lost, or sent to a folder whose number the server had reused | Folder mapping rewritten in the journal at takeover time; reused number treated as a new folder |
| Medium | Flags set by Thunderbird during an import taken for user actions | Imported message assessed on its state once the engine's writes are complete, with no guessed delay |
| Low | Message-ID read differently by Thunderbird; duplicate copies | Identifier read again after import; conflicting copy removed |
| Low | Folder names that Thunderbird stores under a different file name | Names limited to 55 characters, reserved characters and suffixes handled |
| Low | An import failure lost the message | Message requested again from the server, failures shown in the settings |
| Low | Engine replaced during a pass | Old engine fully stopped before the new one, actions handed over in order |
| Low | Held-back deletions kept after a folder change | Dropped at every reset |
| Low | An existing "Archives" folder on the server created duplicates ("Archives (2)") | Linked from the first sync |
| Low | Folder file: unread message saved as read | Marked again after the import |
| Medium | Folders renumbered by the server (reset, migration): two folders that swapped their numbers mixed up their local copies | On a folder list restarted from scratch, each folder is matched first by its location, then by its number |
| Medium | Empty response from the server (folder with no changes, as Exchange sends it): the rebuild of an empty folder never finished; local changes pending forever, ten passes at every sync | The empty response ends the rebuild (never for a first sync); unacknowledged commands kept |

## Thunderbird 140 ESR

All end-to-end tests were run again on Thunderbird 140.17.0 ESR. Three differences from 160 appeared, all fixed and covered by a test:

| Severity | Finding | Fix |
|---|---|---|
| Medium | In Thunderbird 140, a deleted outgoing server keeps its preferences, and the next server created takes over its key. A user's server created after the neutral server was deleted therefore inherited Sync443's marker: it was taken for the neutral server and rewritten to point to 127.0.0.1, or even deleted | Neutral server preferences cleared as soon as it is deleted, whether by Sync443 or by the user; at startup, those of a neutral server deleted while the extension was not running |
| Compatibility | Server host name exposed under another name (`hostName`): no Sync443 account recognized, "Local Folders" not found, account creation refused | Both names are read |
| Compatibility | Refused certificate reported as an interrupted connection: the connection was indeed refused, but with a misleading message | Error read from the connection's TLS layer |

## Known issues, to be fixed in a later version

Found by the last verification round and by the tests on Thunderbird 140; none of them deletes a message.
- **Chain of renames seen on a folder list restarted from scratch** ("Projects" renamed "Projects 2025", then "Projects 2026" renamed "Projects"): the local folder moves to the wrong server folder, and the other one is downloaded again. Without a restart from scratch, the same sequence is followed correctly.
- **Non-compliant server that returns an empty response while it still has items left** in the middle of a rebuild: a pending local deletion may be considered done without having been sent.
- **Item requested again (Fetch) for which the server returns an empty response:** requested again on every pass.
- **Thunderbird 140, extension stopped:** if the user deletes the neutral outgoing server and then creates an outgoing server before the extension runs again, that server takes over the key and the marker of the old one. When the extension comes back, it is taken for the neutral server: sending through this server fails, and nothing goes anywhere else.

## Accepted deviations

- **ActiveSync "Basic" authentication:** the password accompanies every request. Risk reduced by the verified connection, origin binding and an application password; it can be closed only by a different authentication on the server side.
- **Blind copy (Bcc):** the header travels with the message to the server, which removes it (ActiveSync has no envelope).
- **Password stored as an HTTP login** (realm "Sync443") in Thunderbird's password manager.
- **Actions taken while the extension is not running:** not seen.
- **Message moved to a local-only folder:** also stays in its server folder, and may come back after a full resync.
- **Mail unchecked:** synchronization stops, the local account stays in place.
- **Import guard (30 s):** edge cases documented in [SECURITY-MODEL.md](../SECURITY-MODEL.md), with no loss.
- **Matching by date and sender** when no fingerprint is available: fields controlled by the sender.
- **Read receipts (MDN):** would go through the neutral outgoing server, and therefore fail.
- **Private certificate authority:** no setting yet to pin a certificate.
- **Release:** the protection of `v*` tags is a GitHub repository setting.
- **Platforms:** the unit tests run on Windows, macOS and Linux. The end-to-end tests have been run only on macOS, with Thunderbird 140.17.0 ESR and Thunderbird 160.
