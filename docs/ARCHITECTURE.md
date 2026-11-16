# Architecture and progress

## Goals

1. **Security:** see [SECURITY-MODEL.md](SECURITY-MODEL.md). Every rule in that document is guaranteed by construction and covered by tests.
2. **Integrity:** never lose or destroy data by mistake, either on the server or in Thunderbird.
3. **This project's own code**, under the MIT license, written from the public specifications. No line is taken from another project.
4. **Genericity:** any Exchange ActiveSync 14.x server. Authentication is designed to accommodate OAuth2 later.
5. **Efficiency:** synchronizations proportional to the changes, and no work for anything that does not belong to the extension.
6. **Coexistence:** no interference with other extensions, including other ActiveSync clients.
   - its own privileged API names;
   - a device ID specific to each mailbox;
   - other extensions' requests never intercepted.

7. **All operating systems:** Windows, macOS and Linux.
   - The extension's code uses only Thunderbird APIs, which are the same everywhere; the proxy is detected according to each system's settings.
   - What depends on the system is handled explicitly: folder names (Windows reserved characters and names, such as `CON` or `NUL`; case ignored by macOS and Windows), line endings (LF enforced in the repository).
   - The development tooling (tests, checks) runs on all three systems.

Thunderbird 140 ESR or later.

## Code layout

```
src/
  background.mjs          orchestration: mailboxes, engines, timers, menus, button, confirmation window
  send.mjs                closed sending: a message from a Sync443 account goes through ActiveSync or not at all
  log.mjs                 diagnostic log (no personal content), debugging limited to one hour; in French
  i18n.mjs                interface texts (browser.i18n); engine failures shown according to their code
  _locales/               translations: the ten languages most used in Thunderbird, en by default
  core/                   no Thunderbird: testable on its own
    utf8.mjs, base64.mjs  encodings, no dependencies
    codepages.mjs         ActiveSync WBXML tables [MS-ASWBXML]
    wbxml.mjs             bounded WBXML codec, complete document required
    sanitize.mjs          the single gate for values coming from outside
    server.mjs            server address, strict parsing
    protocol.mjs          requests built from verified values, responses read into validated objects
    tls-policy.mjs        decision: may this certificate carry the password?
    http1.mjs             HTTP/1.1 request built and response read by the extension, strict limits
    backoff.mjs           retry spacing
    sha256.mjs            fingerprints (synthetic Message-IDs, message fingerprints)
    mime.mjs              headers: strict Message-ID, internal headers removed, draft cleaned before sending
    mail-codec.mjs        ActiveSync mail items read into validated objects
    folder-tree.mjs       server folder tree → local paths valid on all systems
    calendar-item.mjs     ActiveSync events ↔ validated item descriptions [MS-ASCAL]
    task-item.mjs         ActiveSync tasks ↔ validated item descriptions [MS-ASTASK]
    recurrence.mjs        recurrence rules, bounded; shapes Thunderbird cannot hold are turned away
    eas-timezone.mjs      the ActiveSync time zone structure, read and written
    meeting-request.mjs   the meeting request carried by an invitation mail, read into a validated object
    itip.mjs              meeting messages written by the extension (RFC 5546, RFC 6047)
    vcard.mjs             (stage 5)
  transport/
    client.mjs            ActiveSync over a verified connection: certificate assessed before any write, typed errors
  sync/
    store.mjs             versioned storage, records in Maps
    health.mjs            blocking after a serious error, retry spacing
    mailbox.mjs           one mailbox: folders, collection order, thresholds, clean shutdown
    mail.mjs              one mail collection: receiving, sending changes, rebuilding
    journal.mjs           pending local actions, acknowledged one by one, stored in chunks
    echo.mjs              the extension's own writes recognized, so as not to send them back to the server
    push.mjs              immediate delivery (Ping), for mail, calendar and task folders
    pim.mjs               calendar and task collections: receiving, sending changes, rebuilding, deletion guard
    invitations.mjs       which invitation mail an answer names, never chosen by a sender's UID alone
    scheduling.mjs        what a local change means for other people; the queue of meeting messages
    contacts.mjs          (stage 5)
  tb/
    mail-store.mjs        writes to the mailbox's Thunderbird account, and to it only
    events.mjs            user actions in Thunderbird → intents for the journal
    calendar-store.mjs    the calendars of one mailbox, through sync443Calendar, and those only
  experiments/
    sync443Net/           verified connection: direct TCP or through the proxy, TLS, certificate information,
                          then only writing and reading bytes
    sync443Account/       marked accounts, protected "Local Folders", neutral outgoing server,
                          passwords (Thunderbird's password manager)
    sync443Calendar/      Sync443's own calendar type: items built from validated descriptions, journal of
                          local changes, no sending by Thunderbird
  options/                settings page
  confirm/                the window that asks before a meeting message is sent
tests/unit/               unit and randomized tests (JavaScriptCore or Node)
tests/e2e/                end to end in a real Thunderbird: net (connection), account (accounts), calendar
                          (the calendar module), mail (mail, then calendar, tasks and meetings, against a
                          simulated ActiveSync server)
tools/                    test runner (any system), source code and provenance checks, .xpi build
```

## Choosing the items to synchronize

For each mailbox, the user chooses what is synchronized: **mail, calendar, contacts,
tasks**. One, several or all four; at least one is required.

| Behavior | Detail |
|---|---|
| Default | all four |
| What is not chosen | never requested from the server, nor stored in Thunderbird; the corresponding folders are ignored in the folder list, and left out of "As soon as mail arrives" monitoring (Ping) |
| Adding an item | creation of what is needed in Thunderbird, then a first synchronization of that item |
| Removing an item | the synchronization of that item stops at once, and local actions on its copies are no longer recorded. Calendar and tasks: after confirmation, the mailbox's calendars are removed from Thunderbird, with the changes not yet sent. Mail: the local copies stay in place (their removal is planned for stage 6). Nothing is ever touched on the server |
| Calendar without mail | supported. The mailbox keeps its Thunderbird account, with no synchronized folder, and meeting messages go through ActiveSync as always. One limit: with ActiveSync 12.1 and 14.0 an answer to an invitation names the invitation mail, so answering needs mail to be synchronized; the user is told when it is not |

The model has been in place since stage 1 (`sync` in `src/sync/store.mjs`, validated and tested for
all 15 combinations). The settings page has presented it as check boxes since
0.1.0, and every synchronization stage respects it: mail since 0.1.0, calendar and tasks since
0.3.0. Contacts are not synchronized yet.

## Stages

| Stage | Content | Status |
|---|---|---|
| **1. Foundations** | WBXML, validation, protocol, verified connection, HTTP/1.1, ActiveSync client, storage, retry spacing | **done**: 321 unit tests, 191 end-to-end checks in Thunderbird, [audit](audits/stage-1.md) carried out and addressed |
| **2. Privileged code** | marked accounts, protected "Local Folders", neutral outgoing server, passwords, identity | **done** (calendar API postponed to stage 4): 335 end-to-end checks in Thunderbird |
| **3. Mail** | message identity by Message-ID and fingerprint, deletions with a safety net, mass-deletion threshold, per-mailbox lock, local change journal, closed sending, archives; folder names valid on Windows, macOS and Linux | **done**: 722 unit tests, 158 end-to-end mail checks in Thunderbird, [audit](audits/stages-2-3.md) carried out and addressed; published in 0.1.0 |
| **4. Calendar, tasks and meetings** | Sync443's own calendar type, items built from validated descriptions, bounded recurrence, time zones, meeting messages through ActiveSync after confirmation | **done**: 1337 unit tests, 693 end-to-end checks of the calendar module and 303 of the calendar scenario in Thunderbird, [audit](audits/stage-4.md) carried out and addressed; version 0.3.0 |
| **5. Contacts** | vCard written by the extension, marked address books | to do |
| **6. Finishing** | wizard, advanced settings (including pinning a private certificate authority), deletion of the local copies of an unchecked item, validation on real servers | to do (settings page, check boxes and log delivered as early as 0.1.0) |

## Method, at each stage

1. **Parallel writing**, each file having a single author at a time.
2. **Unit and randomized tests**; end-to-end tests as soon as there is an extension to load.
3. **Independent security audit** by reviewers who did not write the code. Each finding is verified, fixed, then covered by a test.
4. **Automated checks:** invisible characters rejected, code provenance verified.
5. **Before each release:** search for secrets, review of the documents.
