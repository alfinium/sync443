<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (c) 2026 alfinium -->

# Changelog

One section per published version, most recent first. The section of a version serves as the
release notes of its `.xpi` file on the [Releases](https://github.com/alfinium/sync443/releases)
page.

## Unreleased

### New

- **Interface in ten languages,** following Thunderbird's language: English, Russian, German,
  Spanish, Japanese, Polish, French, Italian, Brazilian Portuguese and Czech. These are the ten
  languages most used in Thunderbird (stats.thunderbird.net, 52 weeks to 15 November 2026). Any
  other language shows English; Latin American Spanish shows Spanish, and European Portuguese
  shows Brazilian Portuguese.
- Translated: the settings page, sending notifications, the **Synchronize** button, the menus, and
  the extension's name and description. The French texts are unchanged.
- Engine errors are shown according to their code. In French, the detailed reason is still shown
  as is; in other languages, it appears as a tooltip.

### Fixed

- **Thunderbird 140:** closing the settings page no longer logs an internal Thunderbird error in
  the console.

### Changed

- The extension's description no longer names specific server products.

### Unchanged

- The diagnostic log is still written in French.

### Development

- `tools/build_xpi.py` checks the translations (`src/_locales`): the default language's catalogue
  is present, no message is empty, the manifest's `__MSG_…__` keys exist, and every language has
  the same messages with the same parameters.
- New unit test `tests/unit/i18n.test.mjs`, for all ten languages: same keys and parameters, every
  key used exists, every message is used, composed texts leave no parameter unfilled.
- `tests/e2e/mail/run_mail_test.py --locale=en-US`: the scenario checks the language of the
  settings page, the button and the manifest.
- End-to-end test of a change of the mail period (1 month, all, 1 month, then all on a server that
  starts over), on Thunderbird 140 and 160.

## 0.1.0

First usable version: **mail** for an Exchange ActiveSync mailbox, in both directions. Verified
on Thunderbird 140.17 ESR and Thunderbird 160. The interface of this version is in French only.

### New

- **Exchange ActiveSync mailboxes:** as many as needed, each in its own Thunderbird account.
  Passwords are stored in Thunderbird's password manager.
- **Folders:** creation, renaming, moving and deletion, in both directions. Names are made valid
  on Windows, macOS and Linux.
- **Messages:** delivery, read status, flag, moves and deletions, in both directions.
- **Archive** (A key) files the message in the server's "Archives" folder, created if needed.
- **Immediate delivery** of messages (push), or refresh every 1, 5, 15, 30 or 60 minutes. Mail
  period of your choice, from one day to everything.
- **Sending through ActiveSync,** without SMTP, with a copy in the server's Sent Items.
- **"Closed" sending:** a message from a Sync443 account is sent through ActiveSync or not at
  all. If sending fails, the compose window stays open, the message is kept as a draft and a
  notification explains why.
- **Synchronize button** in the toolbar.
- **Settings page:** status of each mailbox, synchronization on demand, editing, removal with
  confirmation; choice of the items to synchronize (mail, calendar, contacts, tasks); diagnostic
  log.
- **Safety net against mass deletions:** if the server deletes many messages from a folder (at
  once, or little by little over 24 hours), or removes several folders at once, these deletions
  are held back. In the settings, you either confirm them or keep the local copies. A folder list
  without an inbox is refused.

### Security and privacy

- The server certificate is checked **before a single byte is sent**, on the very connection that
  carries the password; an interception is refused before anything leaves.
- The password is sent only to the server it was entered for. Changing the server requires typing
  it again.
- Network access is requested only for each mailbox's own server, and withdrawn when no mailbox
  uses it any more.
- A remote wipe requested by the server is always refused.
- The log contains no message content, subject or address. Debug logging stops on its own after
  one hour.
- **Blind copy (Bcc):** ActiveSync has no envelope. The `Bcc` header therefore travels with the
  message to the server, which takes the recipients from it and removes it before delivery, as
  Exchange does. Sync443 cannot remove it itself without losing those recipients.
- No telemetry.

### Known limitations

- **Calendar, contacts and tasks:** the choice is saved but not synchronized yet ("coming soon").
- **Certificates from a private authority:** not supported yet; the server certificate must be
  issued by a public authority trusted by Thunderbird (such as Let's Encrypt).
- **Microsoft 365 / Exchange Online** (OAuth2): not supported yet.
- **Proxies that require their own authentication:** not supported yet; the extension reports it
  and sends nothing.
- **Unchecking mail** stops its synchronization, but the local account and its messages stay in
  place; removing them after confirmation will come later.
- **A message moved to a folder of the account that exists only in Thunderbird** (Templates, for
  example) is detached from the server: the server copy stays where it was, and nothing is
  deleted there. Moved to another account ("Local Folders", for example), it leaves the mailbox:
  on the server, it goes to Deleted Items, as with IMAP.
- **Rare server-side cases** (folders renumbered and renamed at the same time, non-compliant
  servers): a folder may be downloaded a second time, without anything being deleted. Details are
  in [docs/audits/etape-2-3.md](https://github.com/alfinium/sync443/blob/main/docs/audits/etape-2-3.md)
  (in French).
- **Signing and encryption** (OpenPGP, S/MIME): not supported yet. A message for which signing or
  encryption is requested is not sent: the compose window stays open and a notification explains
  why.
