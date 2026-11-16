<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) 2026 alfinium -->

# Permissions

Sync443 requests only what it needs (the "strictly necessary permissions" rule of
[MAIL-DESIGN.md](MAIL-DESIGN.md)). This document explains each permission in the
manifest (`src/manifest.json`); any added permission must be justified here.

## Permissions requested at installation

| Permission | What it allows | Why Sync443 needs it |
|---|---|---|
| `storage` | the extension's local storage | Mailbox settings, synchronization state (keys, message mapping, local change journal), calendar and task changes waiting for the server, meeting messages waiting for the user's confirmation, diagnostic log. Never any password. |
| `alarms` | timers that survive sleep mode | Periodic refresh (1, 5, 15, 30 or 60 min) and spaced-out retries after an error. |
| `menus` | context menu items | "Synchronize" command on Sync443 accounts and folders. |
| `notifications` | system notifications | Explain why a message was not sent (closed sending), report a stopped mailbox, tell why a change to an event or a task was undone or why a meeting message was not sent. |
| `accountsRead` | reading accounts, identities and folders; folder events | Find each mailbox's account and its folders; track folders created, renamed, moved or deleted by the user. |
| `accountsFolders` | creating, renaming, moving and deleting folders | Reproduce the server's folder tree in Thunderbird. |
| `messagesRead` | reading messages (headers, raw content); message events | Track messages read, flagged, moved or deleted, to apply these changes on the server; check that the draft to be sent is in the sender's account (`messages.get`) and read it (`messages.getRaw`). |
| `messagesImport` | adding messages to a folder | Import the messages received from the server. |
| `messagesUpdate` | changing message properties | Apply "read" and "flag" changes coming from the server. |
| `messagesMove` | moving and copying messages | Apply moves made on the server; move messages deleted on the server to the trash. |
| `messagesDelete` | permanently deleting messages | Delete a message in the trash when it is deleted on the server, and the draft of a sent message. |
| `compose` | compose window events and state | Intercept sending (`compose.onBeforeSend`) for the identities of Sync443 accounts: sending through ActiveSync, never by any other path. Read back the sender and the signing and encryption state (`compose.getComposeDetails`). |
| `compose.save` | saving a message being composed | Save the message as a draft before sending it through ActiveSync (`compose.saveMessage`). |

### What sending transmits to the server

For an identity of a Sync443 account, the message saved as a draft is sent as is to the
ActiveSync server (`SendMail` command), without Thunderbird's internal headers. ActiveSync has
no envelope: the `Bcc` header (blind copy) travels with the message to the server, which takes
the recipients from it and removes it before delivery, as Exchange does. Sync443 cannot
remove it itself without losing those recipients.

A message for which signing or encryption (OpenPGP, S/MIME) is requested, or whose state
cannot be verified, is not sent: Thunderbird signs and encrypts at the time of its own
sending, which never takes place here.

Thunderbird's other accounts are not modified: the privileged code checks for Sync443's mark on
an account before any operation (rule 10 of [SECURITY-MODEL.md](SECURITY-MODEL.md)). Two
exceptions, which protect Thunderbird itself:
- if the profile has no "Local Folders", Sync443 creates them before its first account. Without
  them, Thunderbird would take a Sync443 account for its "Local Folders";
- Sync443's neutral outgoing server is never the default outgoing server as long as one of the
  user's servers exists: if Thunderbird chooses it, the user's first server becomes the default
  again.

Messages and folders, on the other hand, are written through the WebExtension APIs (`messagesImport`,
`messagesUpdate`, `messagesMove`, `messagesDelete`, `accountsFolders`), which cover all accounts. Each write
is limited to the mailbox's account by `src/tb/mail-store.mjs`, which checks the account of every
folder and every message before touching it.

## Permission requested when needed

| Permission | When | Why |
|---|---|---|
| `https://*/*` (optional) | when a mailbox is saved, for that mailbox's server **only** (`https://host/*`) | Reach the ActiveSync server. The verified connection (`sync443Net`) refuses any host for which the extension does not have this permission, and checks it again on every read and write. The permission is withdrawn when no mailbox uses that server any more. |

A host permission's pattern contains no port: `https://mail.example.com/*` covers
every port of that server. The password, however, is sent only to the exact origin (scheme,
host and port) for which it was entered.

## Privileged code ("experiments")

| API | Role |
|---|---|
| `sync443Net` | TLS connection whose certificate is assessed before a single byte is written, either direct or through Thunderbird's proxy. |
| `sync443Account` | Sync443's marked local accounts and their neutral outgoing server (closed sending), passwords in Thunderbird's password manager (`Sync443` realm). |
| `sync443Calendar` | Sync443's own calendar type and the calendars of each mailbox. It builds Thunderbird items from validated, bounded descriptions only (no calendar text from outside is parsed), records the user's changes for the engine, and answers Thunderbird that the provider handles meeting messages itself, so that Thunderbird sends none. Calendars that are not Sync443's are invisible to it (rules 20 to 25 of [SECURITY-MODEL.md](SECURITY-MODEL.md)). |

These APIs run with all of Thunderbird's privileges: they are reduced to the strict minimum,
validate every argument and are accepted only from the background page
(rule 11 of [SECURITY-MODEL.md](SECURITY-MODEL.md)). At installation, Thunderbird announces them as
full, unrestricted access to Thunderbird and the computer: hence their minimal size
and the audit at each stage.

## Content security policy

The manifest sets a strict policy for all of the extension's pages:
`default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
Only the extension's own files can be loaded, no form is submitted to any address,
and no page can be embedded elsewhere.

## Not requested

- `compose.send`: Sync443 never sends through Thunderbird's own path.
- `accountsIdentities`, `addressBooks`, `tabs`, `webRequest`, `<all_urls>`: not needed.
  Calendar, tasks and meetings added no WebExtension permission: Thunderbird has no calendar
  permission, and the confirmation window is opened with `windows.create`, which needs none.
  Contacts (stage 5) will add their own permissions where needed, justified here.
