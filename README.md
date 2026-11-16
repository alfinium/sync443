# Sync443 – EAS Client for Thunderbird

[![Tests](https://github.com/alfinium/sync443/actions/workflows/tests.yml/badge.svg)](https://github.com/alfinium/sync443/actions/workflows/tests.yml)

Sync443 is a Thunderbird extension that provides native support for the **Exchange ActiveSync**
(EAS) protocol. Each ActiveSync mailbox becomes a regular Thunderbird account, with no gateway
and no IMAP or SMTP configuration: all traffic goes over a single HTTPS connection to the server.

**Current version: 0.3.0.** It supports mail (folders, messages and sending), calendars, tasks
and meeting invitations, with an interface in ten languages. Contacts are planned for a later
version ([roadmap](docs/ARCHITECTURE.md)).

## Features

| Feature | Availability |
|---|---|
| Mail: folders, messages, read and flag status, moves and deletions, in both directions | 0.1.0 |
| Immediate delivery (push) or periodic synchronization | 0.1.0 |
| Sending through ActiveSync, with a copy in the server's Sent Items | 0.1.0 |
| Multiple mailboxes; per-mailbox choice of the items to synchronize | 0.1.0 (mail), 0.3.0 (calendar, tasks) |
| Settings page, manual synchronization, diagnostic log | 0.1.0 |
| Interface in ten languages ([Languages](#languages)) | 0.2.0 |
| Calendar and tasks, in both directions, in Thunderbird's own calendar ([details](#calendar-tasks-and-meetings)) | 0.3.0 |
| Meeting invitations: answering those received, sending those of the meetings you organize | 0.3.0 |
| Contacts | planned |

## Compatibility

| | |
|---|---|
| Thunderbird | 140 ESR and later (verified on 140.17 ESR and 160) |
| Operating systems | Windows, macOS, Linux |
| Servers | Exchange Server (on-premises), and any Exchange ActiveSync 12.1 to 14.1 server that accepts user name and password authentication |
| Not supported | Microsoft 365 / Exchange Online (OAuth2); proxies that require their own authentication; certificates issued by a private authority |

## Languages

The interface follows Thunderbird's language. It is available in the ten languages most used in
Thunderbird, according to [Thunderbird's public statistics](https://stats.thunderbird.net):

| Language | Locale |
|---|---|
| Czech | `cs` |
| English | `en` |
| French | `fr` |
| German | `de` |
| Italian | `it` |
| Japanese | `ja` |
| Polish | `pl` |
| Portuguese (Brazil) | `pt_BR` |
| Russian | `ru` |
| Spanish | `es_ES` |

Any other language falls back to English. Regional variants use the closest translation (for
example, Latin American Spanish uses Spanish, European Portuguese uses Brazilian Portuguese). The
diagnostic log is written in French.

## Calendar, tasks and meetings

The calendars and task lists of each mailbox appear in Thunderbird's Calendar and Tasks tabs.
Events and tasks are synchronized in both directions, with recurring series and their exceptions,
time zones, reminders, categories, free/busy status and privacy.

| | |
|---|---|
| Invitations received | Accepting, accepting tentatively or declining in Thunderbird is recorded on the server. A reply is sent to the organizer only when you choose to send one. |
| Meetings you organize | Invitations, updates and cancellations are sent to the attendees you chose, each one after you confirm it in a Sync443 window that lists every recipient. A meeting has at most 100 attendees. |
| Sending | Every meeting message goes through ActiveSync. Thunderbird never sends one by SMTP for a Sync443 calendar. |
| Shown read-only | Items that ActiveSync stores in a form Thunderbird cannot edit without loss: recurrences of non-Gregorian calendars, tasks that regenerate after completion, and a few rare recurrence patterns. |
| Not supported | Proposing a new time, forwarding an invitation, attachments of events, free/busy lookup. |

Design and limits: [docs/CALENDAR-DESIGN.md](docs/CALENDAR-DESIGN.md).

## Installation

1. Download `sync443-<version>.xpi` from the
   [Releases](https://github.com/alfinium/sync443/releases) page.
2. In Thunderbird: **Tools → Add-ons and Themes**, gear icon, **Install Add-on From File…**.
3. Accept the requested permissions ([details](docs/PERMISSIONS.md)). Network access is requested
   only when a mailbox is added, and only for that mailbox's server.

The extension is not yet distributed on addons.thunderbird.net.

Each published file is built by GitHub Actions, reproducibly. It can be verified:
- against its checksum, published in `SHA256SUMS.txt`;
- with its provenance attestation:
  `gh attestation verify sync443-<version>.xpi --repo alfinium/sync443`;
- by rebuilding it from the matching tag: `python3 -I tools/build_xpi.py`.

## Configuration

**Tools → Sync443 settings… → Add a mailbox**, then enter:
- the email address, the password and, if different from the address, the login name;
- the account name shown in Thunderbird;
- the server, as `mail.example.com`;
- the items to synchronize: mail, calendar, contacts, tasks;
- the synchronization frequency, the period of mail and of calendar to keep, and whether completed
  tasks are synchronized.

The connection (server, certificate, credentials) is verified before anything is saved. Where the
server allows it, an application password dedicated to ActiveSync is recommended.

## Network

No configuration is required. The extension uses the route Thunderbird would use: direct
connection, HTTP proxy or SOCKS proxy, according to Thunderbird's or the system's settings.
Encryption remains end to end. A proxy that decrypts HTTPS traffic is detected, and the
connection is refused before anything is sent.

## Security

- The server certificate is verified before any data is sent, on the very connection that
  carries the credentials. A Thunderbird security exception is not sufficient.
- The password is sent only to the server it was entered for. Redirects are never followed.
- Remote wipe requests are always refused.
- Data received from the server is validated and bounded before use.
- After an authentication failure, no further automatic attempt is made.
- No meeting message is sent without your own action, and none is sent because of a change coming
  from the server.
- A large number of deletions requested by the server at once (messages, events or tasks) is
  applied only after your confirmation.

ActiveSync usually relies on "Basic" authentication, in which the password accompanies every
request. This risk is reduced by the measures above and by the use of an application password.

Security model: [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md). Audits: [docs/audits/](docs/audits/).
Reporting a vulnerability: [SECURITY.md](SECURITY.md).

## Privacy

No telemetry. Only the configured ActiveSync server is contacted, and only the selected items
are downloaded. Passwords are stored in Thunderbird's password manager. The diagnostic log
contains no message content, subject or address, and no title, place, attendee or description of
an event or a task.

## Development

Requirements: Python 3.9 or later; Node.js 18 or later (on macOS, the system JavaScript engine is
sufficient); Thunderbird 140 or later for the end-to-end tests. On Windows, replace `python3`
with `py -3`.

| Command | Purpose |
|---|---|
| `python3 -I tools/unit_tests.py` | unit tests |
| `python3 -I tests/e2e/net/run_net_test.py` | end-to-end tests: connection |
| `python3 -I tests/e2e/account/run_account_test.py` | end-to-end tests: accounts and passwords |
| `python3 -I tests/e2e/mail/run_mail_test.py` | end-to-end tests: mail, against a simulated ActiveSync server |
| `python3 -I tests/e2e/calendar/run_calendar_test.py` | end-to-end tests: the calendar module, in Thunderbird |
| `python3 -I tests/e2e/mail/run_calendar_sync_test.py` | end-to-end tests: calendar, tasks and meetings, against the simulated server |
| `python3 -I tools/build_xpi.py` | reproducible build of `dist/sync443-<version>.xpi` |
| `python3 -I tools/check_source_chars.py` | rejects invisible or bidirectional characters |
| `python3 -I tools/provenance_check.py --ref <directory>` | checks that no code was taken from another project |

The end-to-end tests use a throw-away profile. The Thunderbird executable can be set with the
`THUNDERBIRD` variable, and the interface language of the mail test with `--locale=en-US` (or
`fr`).

The code is written from the public specifications (Microsoft MS-ASCMD, MS-ASWBXML, MS-ASPROV,
MS-ASHTTP, MS-ASDTYPE, MS-ASEMAIL, MS-ASCAL and MS-ASTASK; IETF RFC 9110, 9112, 5322, 5545, 5546
and 6047), without code from other projects. Architecture and method: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE).

Exchange and ActiveSync are trademarks of Microsoft; Thunderbird is a trademark of the Mozilla
Foundation. Sync443 is not affiliated with Microsoft, Mozilla, or the TbSync and EAS-4-TbSync
projects.
