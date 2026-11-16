# Security model

This document describes what Sync443 protects, against whom, and how. It is authoritative for the code: a
rule written here that the code does not respect is a security bug.

## What must be protected

| Asset | Why it is sensitive |
|---|---|
| The mailbox password | It opens the account. With Basic authentication, it accompanies every request. |
| The contents of the mailboxes | Messages, attachments, calendars, contacts, on the server as well as in Thunderbird. |
| The ability to send on the user's behalf | Messages and invitations are sent from the user's address. |
| Thunderbird's other accounts, calendars and address books | The extension has extended privileges; it must touch only what belongs to it. |
| Thunderbird itself | Privileged code ("experiments" API) runs with all of Thunderbird's privileges. |

## Against whom

| Attacker | What they control |
|---|---|
| **The network** | The traffic, including a proxy that decrypts HTTPS with a certificate authority installed on the computer. |
| **A malicious or compromised server** | Every byte of the responses: WBXML structure, identifiers, names, policies, wipe requests. |
| **Any sender** | The content of messages and invitations, which the server relays as is. |
| **Another extension or a local program** | Whatever Thunderbird and the system allow it. |

## Rules

### Password and transport

1. **The password is sent only to the origin for which it was entered**: scheme, host and port.
   - No redirect is followed (`redirect: "error"`).
   - A 451 "use another server" response is reported, never followed.
   - Changing a mailbox's server requires typing the password again.
2. **HTTPS only**, without exception, including in test builds.
   - The server address is parsed strictly:
     - no credentials in the address;
     - no wildcard;
     - no disguised spelling of the local address (`127.1`, `[::ffff:127.0.0.1]`…).
3. **The certificate is checked before a single byte of the request is sent, on the very connection that will carry the password.**
   - The extension opens every connection itself: directly, or through the proxy that Thunderbird would use (SOCKS, or an HTTP proxy through a `CONNECT` tunnel opened by the extension). Encryption always runs end to end, up to the server.
   - Once the TLS handshake is complete, the certificate chain is evaluated. It is accepted only if it leads to a public certificate authority built into Thunderbird, or to a certificate explicitly approved for this server (pinned fingerprint). In 0.1.0, no setting allows pinning a fingerprint yet: only test builds do so, for their fake server.
   - Refused: the connection is closed without a single byte of the request having been written to it.
   - Accepted: the request is written on that same connection. Thunderbird plays no part in the HTTP exchange, which the extension builds and reads within strict limits.
   - A proxy that decrypts HTTPS is therefore detected before it has been able to read anything.
   - A connection accepted only because of a security exception added in Thunderbird is refused as well.
   - The extension's connections are anonymous: no client certificate is ever offered, and they do not share Thunderbird's TLS session cache.
   - Only the configured server and port can be reached. Ports that Thunderbird forbids for HTTPS are refused.
   - A response must declare its length: a connection cut by the network cannot pass for a complete response.
4. **Failures do not lead to relentless retries.**
   - After a rejected password, a denied access or a wipe request, no automatic attempt is made: the user must act.
   - A refused certificate is reported to the user. Since nothing was sent, attempts continue, spaced out: a hotel captive portal goes away by itself once the connection is open.
   - Other errors space out the attempts (30 s, 1 min, 2 min… 30 min), or follow the delay requested by the server.
5. **Remote wipe: always refused.**
   - Nothing is ever erased.
   - Synchronization stops until the user restarts it.
   - The server's security policies are acknowledged as "received but not applied": the extension does not claim to comply with them.

### Data received from the server

6. **A single point of entry.** Every response goes through a validation module that produces typed objects:
   - verified identifiers (1 to 64 characters, no control characters);
   - cleaned text: control, bidirectional and invisible characters removed from names;
   - bounded numbers;
   - dates in the exact format.
   - An invalid element is discarded and counted, never guessed.
7. **Everything is capped.**
   - Response size, read as a stream and cut off beyond the limit.
   - Number of elements and depth of the WBXML.
   - Number of items per folder, number of folders.
   - An incomplete WBXML document is refused, never half-applied.
8. **No string from outside ever becomes a property name** of a JavaScript object: `Map` everywhere.
9. **Formats written by the extension, with systematic escaping**: WBXML (the NUL character is refused), iCalendar, vCard.

### Thunderbird

10. **The extension touches only what belongs to it.**
    - The accounts, calendars and address books it creates carry a marker, checked by the privileged code before any operation.
    - Requests from other extensions to the same server are never intercepted.
11. **Minimal privileged code.**
    - Only the necessary functions, each one validating its arguments and bounding its resources (connections, writes, memory).
    - They are reserved for the background page. This is a secondary safeguard: any page of the extension can reach the background page. All pages are therefore treated as equally sensitive: a strict content policy, and server data is never inserted as HTML.
    - No test functions in published builds: `tools/build_xpi.py` refuses any test file and removes from `background.mjs` the blocks marked `// <test-hooks>`, then checks that none remain.
12. **"Closed" sending.** If the extension cannot send a message through ActiveSync, the message is not sent through another path.

### Privacy

13. **The log contains no personal content.**
    - In debug mode, only technical values (statuses, keys, identifiers) appear.
    - The synchronization engine refers to a mailbox by its identifier, to a folder by its ServerId, and to a local change by its number: never by a mailbox name, an address, a folder name, a Message-ID or a subject. A Thunderbird error appears in the log only as its code.
    - Debugging turns itself off.
14. **No telemetry.** The only server contacted is the configured ActiveSync server.
15. **Minimization.** Only the items the user has chosen for the mailbox (mail, calendar, contacts, tasks) are requested from the server and stored in Thunderbird.

### Mail integrity

16. **The server destroys nothing in one go.**
    - A folder list without an inbox is refused: nothing is changed.
    - Mass-deletion threshold: more than 50 deletions and more than 20% of the folder, counted over the whole series of deletions in a folder (even when spread over several passes), and over a sliding 24-hour window, which neither a full resync nor a folder restart resets. Beyond it, nothing is applied: the mailbox is blocked until the user confirms or refuses.
    - Folders that disappear from the server are counted too: by the messages in their local folders, and by their number (at least three, and at least half of the mailbox's folders, at once).
    - What the server deletes goes to the local trash. The only messages deleted permanently are those already in the local trash, or a copy that the engine itself has just imported as a duplicate (never the user's mail); a local folder is never deleted permanently because of the server.
    - Held-back deletions are abandoned if their folder's table is reset: they never apply to other copies.
17. **A Message-ID is not enough to identify a message.** Any sender can reuse another message's Message-ID.
    - It is parsed strictly; a message whose Message-ID can be read in more than one way is given its own, and its former Message-ID fields are renamed.
    - After import, the Message-ID as read by Thunderbird is what counts.
    - A server item is linked to an existing local copy only on proof: the content fingerprint known before a full resync, or the date and the sender's address. Otherwise it is imported separately: it never takes the place of another message.
    - During a resync, only the item with the known fingerprint takes over a message that the user has deleted or moved; the deletion or move is sent to that item, never to an item that reuses its Message-ID.
    - A Message-ID that Thunderbird reads differently and that another copy in the folder already carries is not linked: the message is given its own identifier.
18. **One server folder, one local folder.**
    - Never two server folders on the same local folder, even during a series of renames made at once on the server (planned, with a temporary name if needed).
    - Local names are such that Thunderbird stores each folder under its own name; a name that resembles a name reserved at the root ("Inbox" written in letters of another alphabet) is given a suffix.
    - A special folder is chosen by its type, never by its name; the archive folder is linked by its ServerId.
    - After a folder list restarted from scratch (key refused, partnership reset), no ServerId is taken at face value: each table is matched first by its place (the local folder that a server folder wants), then by its ServerId if that folder has not taken over any other table and keeps its type. A table whose ServerId now designates another folder is dropped; its local folder remains, unsynchronized. The list is saved only once this matching is done.
19. **A user action goes to where it was made.**
    - Each local change keeps the ServerIds of the folders concerned: it is never applied to another server folder that may have taken the same name. After a partnership reset, it follows the folder under its new ServerId; if that folder could not be matched, it keeps only its local folder and is sent to no other.
    - It leaves the journal only after a positive response from the server for that change, or a definitive refusal (logged). While a folder is being rebuilt, it waits: it is never settled without anything being sent.
    - A message that has left the period keeps its link, even after a full resync: what the user does with it is sent to the server.
    - A message moved to a purely local folder is never deleted on the server.
    - The flags that Thunderbird sets by itself on import are not sent back to the server: an imported message is judged on its state once the engine's writes are finished, so that a change made by the user is never mistaken for one of these marks, nor swallowed.

### Calendar, tasks and meetings

20. **No server text is parsed as iCalendar in privileged code.** Privileged code builds Thunderbird items only from validated, bounded descriptions.
21. **An iCalendar UID is not an identity.** Items are linked by ServerId. A UID or a GlobalObjId chosen by a sender never selects a local item. It only names, to the server, which invitation the user is answering.
22. **Recurrences and exceptions are bounded** when read, and never expanded eagerly.
23. **No message is sent without the user's own action.**
    - A reply goes only to the organizer, after the user answered in Thunderbird.
    - Invitations, updates and cancellations go only to the meeting's attendees, after the user saved or deleted the meeting and confirmed the sending in Sync443's window.
    - Everything goes through ActiveSync. Thunderbird itself never sends a meeting message for a Sync443 calendar.
    - A change coming from the server never sends anything.
24. **Bodies are plain text, links are text.** A body or location is never shown as HTML, and a link is never opened automatically.
25. **Meeting messages are bounded:** at most 100 recipients, one message of each kind per change, the mailbox's own address as organizer, no automatic resending.

## Known limitation, accepted risk

**Basic authentication** is a limitation of the protocol as most servers offer it. The residual risk is reduced by three measures:
- a dedicated, restricted-scope and revocable credential: an application password limited to ActiveSync, on the server side;
- strict TLS transport (rules 2 and 3);
- binding to the origin (rule 1).

**Linux with the system's certificate authorities (p11-kit):** on some distributions, Thunderbird reads the system's certificate authorities instead of its own. It must then be checked that a locally added certificate authority is not presented there as "built-in"; this point must be verified on those distributions.

**Accepted deviations in mail** (nothing is lost, but Thunderbird and the server may differ):
- a message moved to a purely local folder also remains in its server folder; a full resync of that folder can make it reappear;
- what the user does while the extension is not running is not seen;
- on Windows, a folder name with characters outside the system code page may be stored by Thunderbird under a hashed file name: the engine compares the names of folders, not their paths, but this case is verified only by the unit tests;
- a newly imported message is watched by a guard for 30 s. Within those 30 s: a message with the same Message-ID moved into that folder shares the guard; a change made by the user during the import itself is undone by the engine (the message keeps the server's state); the events of a slow import wait for it to finish. After 30 s, a Thunderbird mark arriving very late would be taken for a user change and would send back to the server the state it already has;
- after a folder list restarted from scratch, folders are matched by their place, then by their ServerId: a folder renamed or moved at the very moment the server renumbers its folders is downloaded again (the old local folder remains unsynchronized, or goes to the trash if it has disappeared); a new folder created in place of a renamed folder takes over the local folder (its messages remain there as local copies) and the renamed folder is downloaded again; two folders that swap their ServerIds and are both renamed or moved at that moment, or two folders that swap their names at that moment (nothing distinguishes them from swapped ServerIds), may mix up their local copies;
- during the local folders stage, local events wait in memory: a Thunderbird call on the folders that never returned would hold them back (nothing is lost as long as Thunderbird is running);
- outside a full resync, a server item is linked to a local copy that no item holds if the date and the sender's address match (the case of a batch replayed after a stop). These two fields are chosen by the sender: a sender who reused the Message-ID, the date and the sender of a message that the user had copied into this folder themselves would make their item pass for that copy, and it would not be shown separately. Copies that the engine has linked (including outside the period) are never affected.

**Corporate proxy requiring its own authentication:** not supported yet. The extension reports it and sends nothing, rather than going through a path whose certificate it would not control.

This finding will be fully closed only with a stronger authentication supported by the server (OAuth2, client certificate).

## Verification

- **Tests:** each rule has its own unit tests (`tools/unit_tests.py`), including randomized tests of the WBXML decoder.
- **Audit at each stage:** an independent security audit closes each development stage. Each finding is verified, fixed and covered by a test (for the mail engine: `tests/unit/audit-engine.test.mjs`, one or more tests per finding).
- **Source code:** no invisible or bidirectional character is accepted in it (`tools/check_source_chars.py`).
- **Provenance:** no line is taken from a third-party project (`tools/provenance_check.py`).
