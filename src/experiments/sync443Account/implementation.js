// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * sync443Account: the mail accounts and the passwords of Sync443, and
 * nothing else.
 *
 * Accounts
 *   An account of the extension is a local account: incoming server of type
 *   "none", user name = mailboxId, host name "sync443.invalid" (a name no
 *   real server can have, RFC 2606, so it cannot collide with an account of
 *   the user), carrying two preferences on its server:
 *     sync443.owner    the extension's id
 *     sync443.mailbox  the mailboxId (12 lower-case hexadecimal digits)
 *   Only such an account is ever touched. Every operation but the creation
 *   in ensureAccount() refuses an account without these marks (PERMISSION),
 *   and the "Local Folders" account is refused whatever its preferences say.
 *   ensureAccount() never adopts what it did not create: an existing server
 *   with the same name but no marks of ours is a CONFLICT.
 *
 *   "Local Folders" is the server named by the preference
 *   mail.accountmanager.localfoldersserver, read directly: when it is unset,
 *   Thunderbird's getter (MailServices.accounts.localFoldersServer) adopts
 *   the first "none" server it finds, ours included, and saves that choice.
 *   So a real "Local Folders" account is made before our first account in
 *   a profile that has none, and every account operation first puts the
 *   preference back on a real "Local Folders" server if it names one of
 *   ours (or names nothing while we have accounts).
 *
 *   Sending is closed. Each identity of an account of the extension sends
 *   through one "neutral" outgoing server, marked the same way
 *   (mail.smtpserver.<key>.sync443.owner): 127.0.0.1, port 1 (closed; no
 *   name to resolve, so no DNS answer can redirect it), TLS required, no
 *   authentication, no user name. If the extension is disabled, sending
 *   from such an identity fails instead of leaving through another
 *   provider's server. The route is checked and repaired by
 *   checkSendRoute(), by ensureAccount(), and as soon as Thunderbird reports
 *   a change that may break it (an outgoing server removed, an identity's
 *   outgoing server changed, the list or the default of outgoing servers
 *   changed, an outgoing server's host, port, security, authentication,
 *   user name, type or mark changed), once the background page has used
 *   this API.
 *   The neutral server is never made Thunderbird's default outgoing server;
 *   if Thunderbird adopts it (it does so with the first server of a profile)
 *   and the user has a server of their own, the default goes back to it.
 *
 *   Thunderbird's own moves land in synchronised folders: for every
 *   identity of our accounts, Archive files messages in the account's
 *   /Archives folder itself (archive_granularity 0, no copied folder
 *   structure, archive_folder = /Archives), and junk is never moved away
 *   (moveOnSpam false on our server). Applied at creation, on every update,
 *   and by checkSendRoute.
 *
 *   ensureAccount({mailboxId, email, name, fullName?}) -> {accountKey, identityId, created}
 *     creates the account (default folders with their special flags,
 *     identity, neutral outgoing server, archive and junk settings), or
 *     updates the account already marked for this mailboxId: name,
 *     address, full name only if the identity has none, the archive and
 *     junk settings, and the send route of every identity of the account.
 *   listAccounts() -> [{accountKey, mailboxId}]       marked accounts only
 *   accountOfIdentity(identityId) -> {accountKey, mailboxId} | null
 *     null when the identity does not exist or belongs to no marked account
 *     (the identity of another account is "not ours", not an error).
 *   checkSendRoute(identityId?) -> boolean
 *     makes sure that the identity (without an argument: every identity of
 *     every account of the extension) sends through the neutral server, with
 *     its safe values, repairing what is needed (the neutral server is made
 *     again if it was removed). Resolves to true if something was repaired,
 *     false if all was in order; resolves ONLY when, afterwards, Thunderbird
 *     itself would send each checked identity through that server. Anything
 *     else is an error, so that the caller does not send: an identity that
 *     belongs to no account of the extension is NOT_FOUND. It also puts back
 *     the archive and junk settings (not counted in its answer).
 *   removeAccount(accountKey) -> boolean
 *     false if no account has this key; removes the account, its files only
 *     if their folder is inside the profile's Mail folder and belongs to no
 *     other server (otherwise the account is removed, its files are left in
 *     place and the call fails with FILES), then the neutral outgoing server
 *     once no identity uses it.
 *
 * Passwords: Thunderbird's login manager, realm "Sync443", origin exactly
 * "https://host[:port]" as core/server.mjs writes it (lower-case name,
 * canonical IPv4 or bracketed IPv6, no default port).
 *   getPassword(origin, username) -> string | null
 *   setPassword(origin, username, password)      adds or overwrites
 *   removePassword(origin, username)
 * Logins of another realm, or saved for a form, are never read or touched.
 *
 * Who can call it: only the background page's context is accepted, as for
 * sync443Net (defence in depth: any page of the extension can reach the
 * background page).
 *
 * One operation at a time: the account operations (and the automatic
 * repairs) are queued one behind the other, and so are the password
 * operations. Thunderbird may spin its event loop inside some calls; a
 * second call made meanwhile still waits for the first to finish.
 *
 * Every refusal is an ExtensionError "CODE: reason":
 *   CONFIG       invalid argument
 *   PERMISSION   not the background page, or an account the extension did
 *                not mark, or "Local Folders"
 *   NOT_FOUND    checkSendRoute: the identity belongs to no account of ours
 *   CONFLICT     ensureAccount: a server of that name exists without our marks
 *   FILES        removeAccount: account removed, its files left in place
 *   LOCKED       Thunderbird's primary password was not entered
 *   UNSUPPORTED  this Thunderbird lacks an interface this code needs
 *   INTERNAL     Thunderbird refused the operation, or its result could not
 *                be verified
 * No message carries a password, a user name or an address.
 */

"use strict";

/* global ExtensionCommon, ChromeUtils, Services, Cc, Ci, Cr */

// Loaded into the extension's experiment global, shared with other
// experiment scripts of the same extension: only this name is defined there.
// eslint-disable-next-line no-var, no-unused-vars
var sync443Account = (() => {
  const { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
  const { ExtensionError } = ExtensionUtils;
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");

  const HOST = "sync443.invalid";
  const OWNER = "sync443.owner";
  const MAILBOX = "sync443.mailbox";
  const REALM = "Sync443";
  const LOCAL_FOLDERS_PREF = "mail.accountmanager.localfoldersserver";
  const DEFAULT_OUTGOING_PREF = "mail.smtp.defaultserver";
  // The neutral outgoing server: this machine, a closed port, TLS required.
  const NEUTRAL_HOST = "127.0.0.1";
  const NEUTRAL_PORT = 1;
  const NEUTRAL_DESCRIPTION = "Sync443 : envoi par l'extension uniquement";
  // Changes after which the send route is checked again: an identity's
  // outgoing server, the list and the default of outgoing servers, and what
  // an outgoing server's own preferences say of its route or of our mark.
  const WATCHED_BRANCHES = ["mail.identity.", DEFAULT_OUTGOING_PREF, "mail.smtpservers", "mail.smtpserver."];
  const WATCHED_PREF = new RegExp(
    "^(?:mail\\.identity\\.id[0-9]{1,9}\\.smtpServer|mail\\.smtp\\.defaultserver|mail\\.smtpservers|" +
      "mail\\.smtpserver\\.[A-Za-z0-9_-]{1,64}\\.(?:hostname|port|try_ssl|authMethod|username|type|sync443\\.owner))$",
  );

  const MAILBOX_ID = /^[a-f0-9]{12}$/;
  const ACCOUNT_KEY = /^account[0-9]{1,9}$/;
  const IDENTITY_KEY = /^id[0-9]{1,9}$/;
  const PREF_KEY = /^[A-Za-z0-9_-]{1,64}$/; // server keys used in preference names
  // C0 and C1 controls, DEL, soft hyphen, Arabic letter mark, Mongolian vowel
  // separator, zero-width and bidirectional controls, line and paragraph
  // separators, invisible operators, byte order mark, interlinear annotations.
  const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/;
  const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@(?=.{1,253}$)[^\s@<>()[\]\\,;:".]+(?:\.[^\s@<>()[\]\\,;:".]+)+$/u;
  // Origins: the same host forms as sync443Net accepts.
  const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
  const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
  const IPV6 = /^\[[0-9a-f:.]{2,45}\]$/;
  const ORIGIN = /^https:\/\/([^/:]+|\[[^\]/]+\])(?::([1-9][0-9]{0,4}))?$/;
  const NUL = String.fromCharCode(0);

  const MAX_NAME = 256;
  const MAX_USERNAME = 256;
  const MAX_PASSWORD = 1024;

  /**
   * Folders of a new account, at its root: name, nsMsgFolderFlags flag, and
   * the identity attributes that make Thunderbird use it (drafts, copies of
   * sent messages, templates, archives).
   */
  const DEFAULT_FOLDERS = [
    ["Inbox", "Inbox", null],
    ["Drafts", "Drafts", ["draftsFolderURI", "draftsFolderPickerMode"]],
    ["Templates", "Templates", ["templatesFolderURI", "templatesFolderPickerMode"]],
    ["Sent", "SentMail", ["fccFolderURI", "fccFolderPickerMode"]],
    ["Archives", "Archive", ["archivesFolderURI", "archivesFolderPickerMode"]],
    ["Trash", "Trash", null],
  ];

  const fail = (code, reason) => new ExtensionError(`${code}: ${reason}`);

  /** Name of an XPCOM error ("NS_ERROR_FAILURE") or of a JS error class, never free text. */
  function errorName(error) {
    const status = error?.result;
    if (typeof status === "number") {
      const name = ChromeUtils.getXPCOMErrorName(status);
      return /^[A-Z0-9_]{1,64}$/.test(name) ? name : `0x${(status >>> 0).toString(16)}`;
    }
    const name = error?.name;
    return typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name) ? name : "erreur";
  }

  /** Any error → ExtensionError: ours as they are, Thunderbird's as INTERNAL with its name only. */
  function internal(what, error) {
    if (error instanceof ExtensionError) return error;
    return fail("INTERNAL", `${what} : opération refusée par Thunderbird (${errorName(error)})`);
  }

  // ── Arguments ─────────────────────────────────────────────────────────

  const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  /** No lone surrogate (it would not survive a trip through UTF-8). */
  const wellFormed = (s) => s.isWellFormed();

  /** A printable string of 1 to `max` characters, not blank. */
  function text(value, what, max) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > max ||
      !wellFormed(value) ||
      INVISIBLE.test(value) ||
      value.trim() === ""
    ) {
      throw fail("CONFIG", `${what} invalide`);
    }
    return value;
  }

  function key(value, pattern, what) {
    if (typeof value !== "string" || !pattern.test(value)) throw fail("CONFIG", `${what} invalide`);
    return value;
  }

  function accountOptions(options) {
    if (!plainObject(options)) throw fail("CONFIG", "options manquantes");
    const mailboxId = key(options.mailboxId, MAILBOX_ID, "identifiant de boîte");
    const { email } = options;
    if (typeof email !== "string" || email.length > 254 || !wellFormed(email) || INVISIBLE.test(email) || !EMAIL.test(email)) {
      throw fail("CONFIG", "adresse électronique invalide");
    }
    const name = text(options.name, "nom du compte", MAX_NAME);
    // The schema hands an absent optional property over as null.
    const fullName = options.fullName === undefined || options.fullName === null ? null : text(options.fullName, "nom complet", MAX_NAME);
    return { mailboxId, email, name, fullName };
  }

  /** Exactly "https://host" or "https://host:port", in canonical form. */
  function originOf(origin) {
    const m = typeof origin === "string" ? ORIGIN.exec(origin) : null;
    if (!m) throw fail("CONFIG", "origine invalide (https://hôte[:port] attendu)");
    const host = m[1];
    if (!(HOSTNAME.test(host) || IPV4.test(host) || IPV6.test(host))) throw fail("CONFIG", "origine invalide (nom de serveur)");
    if (m[2] !== undefined) {
      const port = Number(m[2]);
      if (port > 65535) throw fail("CONFIG", "origine invalide (port)");
      if (port === 443) throw fail("CONFIG", "origine non canonique (port 443 implicite)");
    }
    // Thunderbird's URL parser must read it exactly as written: no "127.1",
    // no "[::ffff:127.0.0.1]", no "[::0001]".
    let uri;
    try {
      uri = Services.io.newURI(`${origin}/`);
    } catch {
      throw fail("CONFIG", "origine invalide");
    }
    if (uri.scheme !== "https" || uri.prePath !== origin || uri.userPass !== "" || uri.pathQueryRef !== "/") {
      throw fail("CONFIG", "origine non canonique");
    }
    return origin;
  }

  function usernameOf(username) {
    if (
      typeof username !== "string" ||
      username.length < 1 ||
      username.length > MAX_USERNAME ||
      !wellFormed(username) ||
      INVISIBLE.test(username)
    ) {
      throw fail("CONFIG", `identifiant invalide (1 à ${MAX_USERNAME} caractères, sans caractère de contrôle)`);
    }
    return username;
  }

  function passwordOf(password) {
    // A lone surrogate would not survive Thunderbird's encryption (UTF-8).
    if (
      typeof password !== "string" ||
      password.length < 1 ||
      password.length > MAX_PASSWORD ||
      password.includes(NUL) ||
      !wellFormed(password)
    ) {
      throw fail("CONFIG", `mot de passe invalide (1 à ${MAX_PASSWORD} caractères, sans caractère nul)`);
    }
    return password;
  }

  // ── Context ───────────────────────────────────────────────────────────

  function checkContext(context) {
    if (context.viewType !== "background" || context.unloaded) {
      throw fail("PERMISSION", "réservé à la page d'arrière-plan de l'extension");
    }
  }

  /** Runs each task after the previous one has settled. */
  function serial() {
    let tail = Promise.resolve();
    return (task) => {
      const run = tail.then(task);
      tail = run.catch(() => {});
      return run;
    };
  }

  // ── Marks ─────────────────────────────────────────────────────────────

  function readPref(branch, name) {
    try {
      return branch.getStringPref(name, "");
    } catch {
      return "";
    }
  }

  /** Preference branch of an incoming server ("mail.server.<key>."), or null. */
  function serverBranch(server) {
    const k = server?.key;
    return typeof k === "string" && PREF_KEY.test(k) ? Services.prefs.getBranch(`mail.server.${k}.`) : null;
  }

  /** Preference branch of an outgoing server ("mail.smtpserver.<key>."), or null. */
  function outgoingBranch(server) {
    const k = server?.key;
    return typeof k === "string" && PREF_KEY.test(k) ? Services.prefs.getBranch(`mail.smtpserver.${k}.`) : null;
  }

  /** An incoming server's host name: `hostName` in Thunderbird 140, `hostname` in later versions. */
  function hostOf(server) {
    const name = server.hostname ?? server.hostName;
    return typeof name === "string" ? name : "";
  }

  /**
   * The mailboxId this server carries the marks of this extension for, or
   * null: type "none", our host name, user name = mailboxId, both marks.
   * Says nothing about "Local Folders" (see markOf).
   */
  function marksOf(server, extensionId) {
    try {
      if (!server || server.type !== "none" || hostOf(server).toLowerCase() !== HOST) return null;
      const branch = serverBranch(server);
      if (!branch || readPref(branch, OWNER) !== extensionId) return null;
      const mailboxId = readPref(branch, MAILBOX);
      if (!MAILBOX_ID.test(mailboxId) || server.username !== mailboxId) return null;
      return mailboxId;
    } catch {
      return null;
    }
  }

  // ── Local Folders ─────────────────────────────────────────────────────

  /**
   * Key of Thunderbird's "Local Folders" server, read from its preference.
   * Never through MailServices.accounts.localFoldersServer: when the
   * preference is unset, that getter adopts the first "none" server it finds
   * as Local Folders (and saves the choice), which may be one of ours.
   */
  function localFoldersKey() {
    const k = Services.prefs.getCharPref(LOCAL_FOLDERS_PREF, "");
    return PREF_KEY.test(k) ? k : null;
  }

  function isLocalFolders(server) {
    const k = localFoldersKey();
    return k !== null && server?.key === k;
  }

  /**
   * Keeps the "Local Folders" preference on a real "Local Folders" server.
   * Repaired when it names a server carrying our marks (Thunderbird adopted
   * one of our accounts), and, when it names no existing server, if we are
   * about to create an account (`creating`) or already have one: otherwise
   * Thunderbird would adopt ours the first time it needs its Local Folders.
   * An existing "Local Folders" server is pointed to again; with none, one
   * is made, as Thunderbird's account wizard does. Returns true if repaired.
   */
  function keepLocalFolders(extensionId, creating) {
    const servers = MailServices.accounts.allServers;
    const k = localFoldersKey();
    const named = k === null ? null : (servers.find((s) => s.key === k) ?? null);
    if (named && !marksOf(named, extensionId)) return false;
    if (!named && !creating && !servers.some((s) => marksOf(s, extensionId))) return false;
    const real = servers.find((s) => s.type === "none" && hostOf(s) === "Local Folders" && !marksOf(s, extensionId));
    if (real) Services.prefs.setCharPref(LOCAL_FOLDERS_PREF, real.key);
    else MailServices.accounts.createLocalMailAccount();
    const now = localFoldersKey();
    const after = now === null ? null : MailServices.accounts.allServers.find((s) => s.key === now);
    if (!after || marksOf(after, extensionId)) {
      throw fail("INTERNAL", "le compte « Dossiers locaux » de Thunderbird n'a pas pu être rétabli");
    }
    return true;
  }

  /**
   * The mailboxId an account is marked with for this extension, or null.
   * Never "Local Folders".
   */
  function markOf(account, extensionId) {
    let server = null;
    try {
      server = account?.incomingServer ?? null;
    } catch {
      return null;
    }
    if (!server || isLocalFolders(server)) return null;
    return marksOf(server, extensionId);
  }

  /** [{account, mailboxId}] of every account marked for this extension. */
  function ownAccounts(extensionId) {
    const out = [];
    for (const account of MailServices.accounts.accounts) {
      const mailboxId = markOf(account, extensionId);
      if (mailboxId) out.push({ account, mailboxId });
    }
    return out;
  }

  /**
   * The account with this key, or null. Looked up in the list: the account
   * manager's getters by key may create what they do not find.
   */
  function accountByKey(accountKey) {
    for (const account of MailServices.accounts.accounts) {
      if (account.key === accountKey) return account;
    }
    return null;
  }

  /** The account, if it is marked for this extension; PERMISSION otherwise. */
  function owned(account, extensionId) {
    let server = null;
    try {
      server = account.incomingServer;
    } catch {
      server = null;
    }
    if (isLocalFolders(server)) throw fail("PERMISSION", "le compte « Dossiers locaux » n'appartient pas à l'extension");
    const mailboxId = markOf(account, extensionId);
    if (!mailboxId) throw fail("PERMISSION", "ce compte n'a pas été créé par l'extension");
    return { account, server, mailboxId };
  }

  // ── Neutral outgoing server ───────────────────────────────────────────

  /** Thunderbird's outgoing server service (nsIMsgOutgoingServerService). */
  function outgoingService() {
    const service = MailServices.outgoingServer;
    if (!service || typeof service.createServer !== "function" || typeof service.deleteServer !== "function") {
      throw fail("UNSUPPORTED", "service des serveurs sortants de Thunderbird introuvable");
    }
    return service;
  }

  function asSmtp(server) {
    return server.QueryInterface(Ci.nsISmtpServer);
  }

  /** Is this outgoing server the neutral one of this extension (by its mark, whatever its values)? */
  function isNeutral(server, extensionId) {
    try {
      const branch = outgoingBranch(server);
      return !!branch && readPref(branch, OWNER) === extensionId && (server.type ?? "smtp") === "smtp";
    } catch {
      return false;
    }
  }

  function neutralServers(service, extensionId) {
    return [...service.servers].filter((s) => isNeutral(s, extensionId));
  }

  const intPref = (branch, name) => {
    try {
      return branch.getIntPref(name, -1);
    } catch {
      return -1;
    }
  };

  /** Does the neutral server hold its safe values (as stored, and as Thunderbird reads them)? */
  function isSafe(server) {
    const branch = outgoingBranch(server);
    if (!branch) return false;
    const smtp = asSmtp(server);
    return (
      readPref(branch, "hostname") === NEUTRAL_HOST &&
      intPref(branch, "port") === NEUTRAL_PORT &&
      intPref(branch, "try_ssl") === Ci.nsMsgSocketType.SSL &&
      intPref(branch, "authMethod") === Ci.nsMsgAuthMethod.none &&
      readPref(branch, "username") === "" &&
      smtp.hostname === NEUTRAL_HOST &&
      smtp.port === NEUTRAL_PORT &&
      server.socketType === Ci.nsMsgSocketType.SSL &&
      server.authMethod === Ci.nsMsgAuthMethod.none
    );
  }

  /**
   * Gives the neutral server its safe values; true if any had to change.
   * Written to its preferences directly: the host name and user name
   * setters would make Thunderbird forget the saved password of whatever
   * host and user the server had (possibly one of the user's own servers).
   * The port setter is used last: it also drops the server's cached address.
   */
  function enforceNeutral(server) {
    const branch = outgoingBranch(server);
    if (!branch) throw fail("INTERNAL", "clé de serveur sortant inattendue");
    let changed = false;
    if (readPref(branch, "hostname") !== NEUTRAL_HOST) {
      branch.setStringPref("hostname", NEUTRAL_HOST);
      changed = true;
    }
    if (branch.prefHasUserValue("username")) {
      branch.clearUserPref("username");
      changed = true;
    }
    if (intPref(branch, "try_ssl") !== Ci.nsMsgSocketType.SSL) {
      branch.setIntPref("try_ssl", Ci.nsMsgSocketType.SSL);
      changed = true;
    }
    if (intPref(branch, "authMethod") !== Ci.nsMsgAuthMethod.none) {
      branch.setIntPref("authMethod", Ci.nsMsgAuthMethod.none);
      changed = true;
    }
    if (intPref(branch, "port") !== NEUTRAL_PORT) changed = true;
    if (changed || !isSafe(server)) {
      asSmtp(server).port = NEUTRAL_PORT;
      server.password = ""; // forgets a password kept in memory (never a saved one)
      changed = true;
    }
    if (readPref(branch, "description") !== NEUTRAL_DESCRIPTION) branch.setStringPref("description", NEUTRAL_DESCRIPTION);
    return changed;
  }

  /** A new neutral server, marked first, then given its safe values. Never made the default one. */
  function createNeutral(service, extensionId) {
    const server = service.createServer("smtp");
    const branch = outgoingBranch(server);
    if (!branch) {
      service.deleteServer(server);
      throw fail("INTERNAL", "clé de serveur sortant inattendue");
    }
    branch.setStringPref(OWNER, extensionId);
    enforceNeutral(server);
    return server;
  }

  /** The neutral server, with its safe values: {server, changed}. Made if missing. */
  function neutralFor(service, extensionId) {
    const existing = neutralServers(service, extensionId)[0];
    if (existing) return { server: existing, changed: enforceNeutral(existing) };
    return { server: createNeutral(service, extensionId), changed: true };
  }

  function identityUses(serverKey) {
    return MailServices.accounts.allIdentities.some((identity) => identity.smtpServerKey === serverKey);
  }

  function deleteNeutral(service, extensionId, server) {
    // Thunderbird's default outgoing server: let it pick another one.
    if (Services.prefs.getCharPref(DEFAULT_OUTGOING_PREF, "") === server.key) {
      Services.prefs.clearUserPref(DEFAULT_OUTGOING_PREF);
    }
    const { key } = server;
    service.deleteServer(server);
    clearDeletedNeutral(service, extensionId, key);
  }

  /**
   * Clears the preferences left by a deleted neutral server. Thunderbird 140
   * leaves a deleted outgoing server's preferences behind (later versions
   * clear them): the next server made takes the free key, and would inherit
   * our mark and values, then be taken for the neutral server and rewritten.
   * Only a key no server has any more, and only if it carries our mark.
   */
  function clearDeletedNeutral(service, extensionId, key) {
    if (typeof key !== "string" || !PREF_KEY.test(key)) return;
    if ([...service.servers].some((s) => s.key === key)) return;
    const branch = Services.prefs.getBranch(`mail.smtpserver.${key}.`);
    if (readPref(branch, OWNER) !== extensionId) return;
    for (const name of branch.getChildList("")) branch.clearUserPref(name);
  }

  /** The same for every such leftover (a neutral server deleted while the extension was not running). */
  function clearAllDeletedNeutral(service, extensionId) {
    const prefix = "mail.smtpserver.";
    const suffix = `.${OWNER}`;
    for (const name of Services.prefs.getChildList(prefix)) {
      if (name.endsWith(suffix)) clearDeletedNeutral(service, extensionId, name.slice(prefix.length, -suffix.length));
    }
  }

  /** Deletes every neutral server of this extension that no identity uses. */
  function dropUnusedNeutral(service, extensionId) {
    for (const server of neutralServers(service, extensionId)) {
      if (!identityUses(server.key)) deleteNeutral(service, extensionId, server);
    }
  }

  /**
   * The neutral server must not be Thunderbird's default outgoing server
   * (identities left on "the default server" would lose their route). When
   * the preference names it, or is unset while it comes first (Thunderbird
   * then adopts the first server), the default goes to the first server
   * that is not ours. If ours is the only one, nothing can be done:
   * Thunderbird may adopt it, and sending from an identity on "the default
   * server" then fails (closed) until the user adds a server of their own.
   */
  function keepDefaultAway(service, extensionId) {
    const servers = [...service.servers];
    const ours = new Set(servers.filter((s) => isNeutral(s, extensionId)).map((s) => s.key));
    if (ours.size === 0) return;
    const current = Services.prefs.getCharPref(DEFAULT_OUTGOING_PREF, "");
    const adopted = current ? ours.has(current) : servers.length > 0 && ours.has(servers[0].key);
    if (!adopted) return;
    const other = servers.find((s) => !ours.has(s.key));
    if (other) Services.prefs.setCharPref(DEFAULT_OUTGOING_PREF, other.key);
  }

  /**
   * Every identity of every account of ours (or only `identityId`) sends
   * through the neutral server with its safe values; repaired if not.
   * Verified afterwards as Thunderbird resolves it (getServerByIdentity):
   * returns whether something was repaired, throws if it cannot be sure.
   */
  function checkSendRoute(extensionId, identityId = null) {
    const service = outgoingService();
    clearAllDeletedNeutral(service, extensionId);
    const mine = ownAccounts(extensionId);
    const identities = [];
    for (const { account } of mine) {
      for (const identity of account.identities) {
        if (identityId === null || identity.key === identityId) identities.push(identity);
      }
    }
    if (identityId !== null && identities.length === 0) {
      throw fail("NOT_FOUND", "cette identité n'appartient à aucun compte de l'extension");
    }
    let repaired = false;
    if (mine.length > 0) {
      const { server: neutral, changed } = neutralFor(service, extensionId);
      repaired = changed;
      for (const { account } of mine) {
        for (const identity of account.identities) {
          if (identity.smtpServerKey !== neutral.key) {
            identity.smtpServerKey = neutral.key;
            repaired = true;
          }
        }
      }
      keepDefaultAway(service, extensionId);
      // As Thunderbird will resolve it when sending.
      for (const identity of identities) {
        let route = null;
        try {
          route = service.getServerByIdentity(identity);
        } catch {
          route = null;
        }
        if (!route || route.key !== neutral.key || !isNeutral(route, extensionId) || !isSafe(route)) {
          throw fail("INTERNAL", "le serveur sortant neutre de l'identité n'a pas pu être vérifié");
        }
      }
    }
    dropUnusedNeutral(service, extensionId);
    // The archive and junk settings too, while here (not part of the answer).
    let settled = false;
    for (const { account } of mine) {
      try {
        settled = applyMailSettings(account, account.incomingServer) || settled;
      } catch {
        // put back by the next ensureAccount
      }
    }
    if (repaired || settled) MailServices.accounts.saveAccountInfo();
    return repaired;
  }

  // ── Folders ───────────────────────────────────────────────────────────

  function childNamed(folder, name) {
    const found = folder.subFolders.filter((f) => f.name === name);
    return found.length === 1 ? found[0] : null;
  }

  /** The default folders, each with its special flag. */
  function createDefaultFolders(root) {
    // Listing the root first lets Thunderbird create its own default
    // folders of a "none" server (it may add "Unsent Messages").
    const local = root.QueryInterface(Ci.nsIMsgLocalMailFolder);
    for (const [name, flag] of DEFAULT_FOLDERS) {
      const folder = childNamed(root, name) ?? local.createLocalSubfolder(name);
      folder.setFlag(Ci.nsMsgFolderFlags[flag]);
    }
  }

  /** The identity uses the account's default folders (those that exist). */
  function defaultIdentityFolders(identity, root) {
    for (const [name, , attributes] of DEFAULT_FOLDERS) {
      const folder = attributes && childNamed(root, name);
      if (!folder) continue;
      const [uri, pickerMode] = attributes;
      identity[uri] = folder.URI;
      identity[pickerMode] = "0"; // "the folder of this account", as Thunderbird's account settings say
    }
  }

  // ── Archive and junk ──────────────────────────────────────────────────

  /** Preference branch of an identity ("mail.identity.<key>."), or null. */
  function identityBranch(identity) {
    const k = identity?.key;
    return typeof k === "string" && IDENTITY_KEY.test(k) ? Services.prefs.getBranch(`mail.identity.${k}.`) : null;
  }

  function hasBool(branch, name, value) {
    try {
      return branch.prefHasUserValue(name) && branch.getBoolPref(name) === value;
    } catch {
      return false;
    }
  }

  /**
   * Where Thunderbird's own actions put messages of this account, so that
   * they stay in synchronised folders: Archive into the account's /Archives
   * folder itself (archive_granularity 0: no yearly or monthly subfolders;
   * archive_keep_folder_structure false); junk left where it is and never
   * purged by age (moveOnSpam and purgeSpam false on the server, also in
   * Thunderbird's loaded junk settings).
   * Written explicitly, whatever Thunderbird's defaults are. True if
   * anything changed.
   */
  function applyMailSettings(account, server) {
    let changed = false;
    const root = server.rootFolder;
    const archives = childNamed(root, "Archives");
    for (const identity of account.identities) {
      const branch = identityBranch(identity);
      if (!branch) continue;
      if (!branch.prefHasUserValue("archive_granularity") || intPref(branch, "archive_granularity") !== 0) {
        branch.setIntPref("archive_granularity", 0);
        changed = true;
      }
      if (!hasBool(branch, "archive_keep_folder_structure", false)) {
        branch.setBoolPref("archive_keep_folder_structure", false);
        changed = true;
      }
      if (archives && identity.archivesFolderURI !== archives.URI) {
        identity.archivesFolderURI = archives.URI;
        identity.archivesFolderPickerMode = "0";
        changed = true;
      }
    }
    const branch = serverBranch(server);
    if (branch && !hasBool(branch, "moveOnSpam", false)) {
      branch.setBoolPref("moveOnSpam", false);
      changed = true;
    }
    // The junk folder may be the server's own (sync/mailbox.mjs): Thunderbird never empties it by age,
    // which would delete these messages on the server too.
    if (branch && !hasBool(branch, "purgeSpam", false)) {
      branch.setBoolPref("purgeSpam", false);
      changed = true;
    }
    if (changed) {
      try {
        server.spamSettings?.initialize(server); // as the account settings do after a change
      } catch {
        // read again at the next start
      }
    }
    return changed;
  }

  // ── Files ─────────────────────────────────────────────────────────────

  function normalized(file) {
    const copy = file.clone();
    try {
      copy.normalize(); // symbolic links resolved
    } catch {
      // does not exist: as it is
    }
    return copy;
  }

  /**
   * May Thunderbird delete this server's folder (recursively)? Only if it
   * lies inside the profile's Mail folder (not that folder itself), and is
   * neither the folder of another server, nor inside it, nor around it.
   */
  function filesRemovable(server) {
    try {
      const mailDir = normalized(Services.dirsvc.get("MailD", Ci.nsIFile));
      const path = normalized(server.localPath);
      if (!mailDir.contains(path)) return false;
      for (const other of MailServices.accounts.allServers) {
        if (other.key === server.key || other.type === "im") continue;
        let otherPath = null;
        try {
          otherPath = normalized(other.localPath);
        } catch {
          continue; // a server without files
        }
        if (otherPath.equals(path) || otherPath.contains(path) || path.contains(otherPath)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // ── Accounts ──────────────────────────────────────────────────────────

  /** Is a server of this name already there (any type, any owner, with or without an account)? */
  function nameTaken(mailboxId) {
    let found = null;
    try {
      found = MailServices.accounts.findServer(mailboxId, HOST, "none", 0);
    } catch {
      found = null;
    }
    if (found) return true;
    return MailServices.accounts.allServers.some(
      (s) => hostOf(s).toLowerCase() === HOST && String(s.username).toLowerCase() === mailboxId,
    );
  }

  function undoCreation({ server, identity, account }, service, extensionId) {
    try {
      if (account) MailServices.accounts.removeAccount(account, filesRemovable(server));
      else if (server) MailServices.accounts.removeIncomingServer(server, filesRemovable(server));
    } catch {
      // best effort; the original error is reported
    }
    try {
      if (identity && !account) identity.clearAllValues();
    } catch {
      // idem
    }
    try {
      dropUnusedNeutral(service, extensionId);
      keepLocalFolders(extensionId, false);
    } catch {
      // idem
    }
  }

  function createAccount(extensionId, service, { mailboxId, email, name, fullName }) {
    // A real "Local Folders" first: Thunderbird must never take ours for it.
    keepLocalFolders(extensionId, true);
    const made = { server: null, identity: null, account: null };
    try {
      const server = MailServices.accounts.createIncomingServer(mailboxId, HOST, "none");
      made.server = server;
      // Marked before anything else can fail: whatever is left is ours.
      const branch = serverBranch(server);
      if (!branch) throw fail("INTERNAL", "clé de serveur inattendue");
      branch.setStringPref(OWNER, extensionId);
      branch.setStringPref(MAILBOX, mailboxId);
      server.prettyName = name;
      server.valid = true;

      const { server: neutral } = neutralFor(service, extensionId);

      const identity = MailServices.accounts.createIdentity();
      made.identity = identity;
      identity.email = email;
      identity.fullName = fullName ?? "";
      identity.smtpServerKey = neutral.key;
      identity.valid = true;

      // As Thunderbird does: the identity first, then the server.
      const account = MailServices.accounts.createAccount();
      made.account = account;
      account.addIdentity(identity);
      account.incomingServer = server;

      const root = server.rootFolder;
      createDefaultFolders(root);
      defaultIdentityFolders(identity, root);
      applyMailSettings(account, server);
      // Thunderbird must not have taken it for its Local Folders meanwhile.
      keepLocalFolders(extensionId, false);
      if (isLocalFolders(server)) throw fail("INTERNAL", "compte pris pour « Dossiers locaux » par Thunderbird");
      keepDefaultAway(service, extensionId);
      MailServices.accounts.saveAccountInfo();
      return { accountKey: account.key, identityId: identity.key, created: true };
    } catch (e) {
      undoCreation(made, service, extensionId);
      throw internal("création du compte", e);
    }
  }

  function updateAccount(extensionId, service, account, server, { email, name, fullName }) {
    try {
      if (server.prettyName !== name) server.prettyName = name;
      let identity = account.defaultIdentity;
      if (!identity) {
        identity = MailServices.accounts.createIdentity();
        identity.valid = true;
        account.addIdentity(identity);
        defaultIdentityFolders(identity, server.rootFolder);
      }
      if (identity.email !== email) identity.email = email;
      if (!identity.fullName && fullName) identity.fullName = fullName;
      applyMailSettings(account, server);
      // Closed sending, for every identity of every account of ours.
      checkSendRoute(extensionId);
      MailServices.accounts.saveAccountInfo();
      return { accountKey: account.key, identityId: identity.key, created: false };
    } catch (e) {
      throw internal("mise à jour du compte", e);
    }
  }

  function ensureAccount(extensionId, options) {
    const wanted = accountOptions(options);
    const service = outgoingService();
    const mine = ownAccounts(extensionId).filter((a) => a.mailboxId === wanted.mailboxId);
    if (mine.length > 1) throw fail("CONFLICT", "plusieurs comptes de l'extension pour cette boîte");
    if (mine.length === 1) {
      const { account } = mine[0];
      return updateAccount(extensionId, service, account, account.incomingServer, wanted);
    }
    // Never adopt a server we did not mark (nor one left without its account).
    if (nameTaken(wanted.mailboxId)) {
      throw fail("CONFLICT", "un serveur de ce nom existe déjà sans être un compte de l'extension");
    }
    return createAccount(extensionId, service, wanted);
  }

  function removeAccount(extensionId, accountKey) {
    key(accountKey, ACCOUNT_KEY, "clé de compte");
    const account = accountByKey(accountKey);
    if (!account) return false;
    const { server } = owned(account, extensionId);
    const service = outgoingService();
    const withFiles = filesRemovable(server);
    try {
      MailServices.accounts.removeAccount(account, withFiles);
    } catch (e) {
      throw internal("suppression du compte", e);
    }
    try {
      dropUnusedNeutral(service, extensionId);
      MailServices.accounts.saveAccountInfo();
    } catch (e) {
      throw internal("suppression du serveur sortant neutre", e);
    }
    if (!withFiles) {
      throw fail(
        "FILES",
        "compte supprimé, mais ses fichiers sont restés en place : leur dossier n'est pas un dossier propre au compte dans le dossier Mail du profil",
      );
    }
    return true;
  }

  function listAccounts(extensionId) {
    return ownAccounts(extensionId).map(({ account, mailboxId }) => ({ accountKey: account.key, mailboxId }));
  }

  function accountOfIdentity(extensionId, identityId) {
    key(identityId, IDENTITY_KEY, "identifiant d'identité");
    for (const { account, mailboxId } of ownAccounts(extensionId)) {
      if (account.identities.some((identity) => identity.key === identityId)) {
        return { accountKey: account.key, mailboxId };
      }
    }
    return null;
  }

  // ── Passwords ─────────────────────────────────────────────────────────

  /** Thunderbird's login manager, with the asynchronous methods this code uses. */
  function loginManager() {
    let manager = null;
    try {
      manager = Services.logins;
    } catch {
      manager = null;
    }
    for (const method of ["searchLoginsAsync", "addLoginAsync"]) {
      if (typeof manager?.[method] !== "function") {
        throw fail("UNSUPPORTED", `gestionnaire de mots de passe de Thunderbird sans ${method}`);
      }
    }
    return manager;
  }

  /**
   * removeLoginAsync / modifyLoginAsync, or else their synchronous
   * forerunners removeLogin / modifyLogin. Thunderbird 140 ESR has only the
   * synchronous ones, Thunderbird 160 only the asynchronous ones. Neither:
   * UNSUPPORTED.
   */
  function loginMethod(manager, asyncName, syncName) {
    if (typeof manager[asyncName] === "function") return (...args) => manager[asyncName](...args);
    if (typeof manager[syncName] === "function") return async (...args) => manager[syncName](...args);
    throw fail("UNSUPPORTED", `gestionnaire de mots de passe de Thunderbird sans ${asyncName}`);
  }

  function loginFailure(error) {
    if (error instanceof ExtensionError) return error;
    if (error?.result === Cr.NS_ERROR_ABORT) return fail("LOCKED", "le mot de passe principal de Thunderbird n'a pas été saisi");
    return fail("INTERNAL", `gestionnaire de mots de passe : opération refusée (${errorName(error)})`);
  }

  function newLogin(origin, username, password) {
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    login.init(origin, null, REALM, username, password, "", "");
    return login;
  }

  /** Our logins for (origin, username): realm Sync443, not a form login, exact matches only. */
  async function ourLogins(manager, origin, username) {
    const found = await manager.searchLoginsAsync({ origin, httpRealm: REALM });
    return [...found].filter(
      (login) =>
        login.origin === origin &&
        login.httpRealm === REALM &&
        (login.formActionOrigin ?? null) === null &&
        login.username === username,
    );
  }

  // Every failure of these three goes through loginFailure() (see logins() below).

  async function getPassword(origin, username) {
    const manager = loginManager();
    const [login] = await ourLogins(manager, origin, username);
    return login ? login.password : null;
  }

  async function setPassword(origin, username, password) {
    const manager = loginManager();
    // Every method needed is there before anything is written.
    const modify = loginMethod(manager, "modifyLoginAsync", "modifyLogin");
    const remove = loginMethod(manager, "removeLoginAsync", "removeLogin");
    const [first, ...duplicates] = await ourLogins(manager, origin, username);
    const login = newLogin(origin, username, password);
    if (!first) await manager.addLoginAsync(login);
    else if (first.password !== password) await modify(first, login);
    for (const extra of duplicates) await remove(extra);
  }

  async function removePassword(origin, username) {
    const manager = loginManager();
    const remove = loginMethod(manager, "removeLoginAsync", "removeLogin");
    for (const login of await ourLogins(manager, origin, username)) await remove(login);
  }

  // ── The API ───────────────────────────────────────────────────────────

  return class extends ExtensionCommon.ExtensionAPI {
    accountQueue = serial();
    loginQueue = serial();
    watcher = null;

    /**
     * From the first use of the API on: when Thunderbird removes an
     * outgoing server, or an identity's outgoing server, the list of
     * outgoing servers, the default one, or an outgoing server's own route
     * preferences change, the send route is checked again (in the account
     * queue) and repaired if needed. A repair that changes nothing writes
     * nothing, so it does not wake itself up again.
     */
    watch(extensionId) {
      if (this.watcher) return;
      let pending = false;
      const repair = () => {
        if (pending || !this.watcher) return;
        pending = true;
        Services.tm.dispatchToMainThread(() => {
          this.accountQueue(() => {
            pending = false;
            if (!this.watcher) return;
            try {
              keepLocalFolders(extensionId, false);
              checkSendRoute(extensionId);
            } catch {
              // reported by the next explicit call (checkSendRoute, ensureAccount)
            }
          });
        });
      };
      this.watcher = {
        QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
        observe(_subject, topic, data) {
          if (topic === "message-smtpserver-removed") {
            // At once: a server made right after the removal takes its key.
            try {
              clearDeletedNeutral(outgoingService(), extensionId, String(data));
            } catch {
              // checkSendRoute clears it on its next run
            }
          } else if (topic === "nsPref:changed" && !WATCHED_PREF.test(String(data))) {
            return;
          }
          repair();
        },
      };
      Services.obs.addObserver(this.watcher, "message-smtpserver-removed");
      for (const branch of WATCHED_BRANCHES) {
        Services.prefs.addObserver(branch, this.watcher);
      }
    }

    onShutdown() {
      const watcher = this.watcher;
      this.watcher = null;
      if (!watcher) return;
      try {
        Services.obs.removeObserver(watcher, "message-smtpserver-removed");
      } catch {
        // already gone
      }
      for (const branch of WATCHED_BRANCHES) {
        try {
          Services.prefs.removeObserver(branch, watcher);
        } catch {
          // already gone
        }
      }
    }

    getAPI(context) {
      const api = this;
      const extensionId = context.extension.id;
      this.watch(extensionId);
      /**
       * An account operation (synchronous): checked when called, run in
       * turn, the context re-checked when its turn comes; "Local Folders"
       * is put back on a real Local Folders server first if Thunderbird took
       * one of ours for it.
       */
      const accounts = (what, task) => {
        checkContext(context);
        return api.accountQueue(() => {
          checkContext(context);
          try {
            keepLocalFolders(extensionId, false);
            return task();
          } catch (e) {
            throw internal(what, e);
          }
        });
      };
      /** A password operation: the same, every failure reported as a code (never ignored). */
      const logins = (task) => {
        checkContext(context);
        return api.loginQueue(async () => {
          checkContext(context);
          try {
            return await task();
          } catch (e) {
            throw loginFailure(e);
          }
        });
      };

      return {
        sync443Account: {
          async ensureAccount(options) {
            return accounts("compte", () => ensureAccount(extensionId, options));
          },

          async listAccounts() {
            return accounts("liste des comptes", () => listAccounts(extensionId));
          },

          async accountOfIdentity(identityId) {
            return accounts("recherche du compte", () => accountOfIdentity(extensionId, identityId));
          },

          async checkSendRoute(identityId) {
            return accounts("vérification de l'envoi", () => {
              const only = identityId === undefined || identityId === null ? null : key(identityId, IDENTITY_KEY, "identifiant d'identité");
              return checkSendRoute(extensionId, only);
            });
          },

          async removeAccount(accountKey) {
            return accounts("suppression du compte", () => removeAccount(extensionId, accountKey));
          },

          async getPassword(origin, username) {
            checkContext(context);
            originOf(origin);
            usernameOf(username);
            return logins(() => getPassword(origin, username));
          },

          async setPassword(origin, username, password) {
            checkContext(context);
            originOf(origin);
            usernameOf(username);
            passwordOf(password);
            return logins(() => setPassword(origin, username, password));
          },

          async removePassword(origin, username) {
            checkContext(context);
            originOf(origin);
            usernameOf(username);
            return logins(() => removePassword(origin, username));
          },
        },
      };
    }
  };
})();
