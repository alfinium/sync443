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
 *   Sending is closed. Each identity of an account of the extension sends
 *   through one "neutral" outgoing server, marked the same way, whose host
 *   name (sync443.invalid) never resolves, over TLS, without credentials.
 *   If the extension is disabled, sending from such an identity fails
 *   instead of leaving through another provider's server.
 *
 *   ensureAccount({mailboxId, email, name, fullName?}) -> {accountKey, identityId, created}
 *     creates the account (default folders with their special flags,
 *     identity, neutral outgoing server), or updates the account already
 *     marked for this mailboxId: name, address, full name only if the
 *     identity has none, and every identity of the account sent back to
 *     the neutral server.
 *   listAccounts() -> [{accountKey, mailboxId}]       marked accounts only
 *   accountOfIdentity(identityId) -> {accountKey, mailboxId} | null
 *     null when the identity does not exist or belongs to no marked account
 *     (the identity of another account is "not ours", not an error).
 *   removeAccount(accountKey) -> boolean
 *     false if no account has this key; removes the account and its files,
 *     then the neutral outgoing server once no identity uses it.
 *   setSpecialUse(accountKey, folderPath, use)
 *     folderPath: absolute path in the account ("/Inbox/Sub"), resolved one
 *     folder name at a time; use: inbox, drafts, trash, sent, junk,
 *     archives, templates or outbox. The folder gets this special use and
 *     no other; no other folder of the account keeps it; the identities of
 *     the account use the folder for drafts, sent, templates and archives.
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
 * One operation at a time: the account operations are queued one behind the
 * other, and so are the password operations. Thunderbird may spin its event
 * loop inside some calls; a second call made meanwhile still waits for the
 * first to finish.
 *
 * Every refusal is an ExtensionError "CODE: raison":
 *   CONFIG       invalid argument
 *   PERMISSION   not the background page, or an account the extension did
 *                not mark, or "Local Folders"
 *   NOT_FOUND    no such account (setSpecialUse) or folder
 *   CONFLICT     ensureAccount: a server of that name exists without our marks
 *   LOCKED       Thunderbird's primary password was not entered
 *   UNSUPPORTED  this Thunderbird lacks an interface this code needs
 *   INTERNAL     Thunderbird refused the operation
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
  const NEUTRAL_PORT = 465;
  const NEUTRAL_DESCRIPTION = "Sync443 : envoi par l'extension uniquement";

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

  const MAX_NAME = 256;
  const MAX_USERNAME = 256;
  const MAX_PASSWORD = 1024;
  const MAX_PATH = 4096;
  const MAX_SEGMENT = 255;
  const MAX_DEPTH = 64;

  const flags = () => Ci.nsMsgFolderFlags;
  /** Special use → nsMsgFolderFlags name. */
  const USES = new Map([
    ["inbox", "Inbox"],
    ["drafts", "Drafts"],
    ["trash", "Trash"],
    ["sent", "SentMail"],
    ["junk", "Junk"],
    ["archives", "Archive"],
    ["templates", "Templates"],
    ["outbox", "Queue"],
  ]);
  /** Special use → identity attributes that name the folder Thunderbird uses for it. */
  const IDENTITY_FOLDERS = new Map([
    ["drafts", ["draftsFolderURI", "draftsFolderPickerMode"]],
    ["sent", ["fccFolderURI", "fccFolderPickerMode"]],
    ["templates", ["templatesFolderURI", "templatesFolderPickerMode"]],
    ["archives", ["archivesFolderURI", "archivesFolderPickerMode"]],
  ]);
  /** Folders of a new account, at its root. */
  const DEFAULT_FOLDERS = [
    ["Inbox", "inbox"],
    ["Drafts", "drafts"],
    ["Templates", "templates"],
    ["Sent", "sent"],
    ["Archives", "archives"],
    ["Trash", "trash"],
  ];

  const fail = (code, reason) => new ExtensionError(`${code}: ${reason}`);

  /** Name of an XPCOM error ("NS_ERROR_FAILURE") or of a JS error class, never free text. */
  function errorName(error) {
    const status = error?.result;
    if (typeof status === "number") {
      try {
        const name = ChromeUtils.getXPCOMErrorName(status);
        if (/^[A-Z0-9_]{1,64}$/.test(name)) return name;
      } catch {
        // older versions: the code alone
      }
      return `0x${(status >>> 0).toString(16)}`;
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
  const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  /** No lone surrogate (it would not survive a trip through UTF-8). */
  const wellFormed = (s) => (typeof s.isWellFormed === "function" ? s.isWellFormed() : !LONE_SURROGATE.test(s));

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

  /** "/Inbox/Sub" → ["Inbox", "Sub"]: absolute, no empty, "." or ".." segment. */
  function folderSegments(path) {
    if (
      typeof path !== "string" ||
      path.length < 2 ||
      path.length > MAX_PATH ||
      path[0] !== "/" ||
      !wellFormed(path) ||
      INVISIBLE.test(path)
    ) {
      throw fail("CONFIG", "chemin de dossier invalide (chemin absolu attendu, par exemple /Inbox)");
    }
    const segments = path.slice(1).split("/");
    if (segments.length > MAX_DEPTH || segments.some((s) => s === "" || s === "." || s === ".." || s.length > MAX_SEGMENT)) {
      throw fail("CONFIG", "chemin de dossier invalide");
    }
    return segments;
  }

  function useOf(use) {
    if (typeof use !== "string" || !USES.has(use)) {
      throw fail("CONFIG", `usage spécial inconnu (attendu : ${[...USES.keys()].join(", ")})`);
    }
    return use;
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
      password.includes("\u0000") ||
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

  function localFoldersKey() {
    try {
      return MailServices.accounts.localFoldersServer?.key ?? null;
    } catch {
      return null; // no Local Folders account
    }
  }

  function isLocalFolders(server) {
    const k = localFoldersKey();
    return k !== null && server?.key === k;
  }

  /**
   * The mailboxId an account is marked with for this extension, or null:
   * type "none", our host name, user name = mailboxId, both marks, and never
   * "Local Folders".
   */
  function markOf(account, extensionId) {
    let server = null;
    try {
      server = account?.incomingServer ?? null;
      if (!server || isLocalFolders(server)) return null;
      if (server.type !== "none" || String(server.hostname).toLowerCase() !== HOST) return null;
      const branch = serverBranch(server);
      if (!branch || readPref(branch, OWNER) !== extensionId) return null;
      const mailboxId = readPref(branch, MAILBOX);
      if (!MAILBOX_ID.test(mailboxId) || server.username !== mailboxId) return null;
      return mailboxId;
    } catch {
      return null;
    }
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

  /** Thunderbird's outgoing server service (nsIMsgOutgoingServerService; nsISmtpService before). */
  function outgoingService() {
    let service = null;
    try {
      service = MailServices.outgoingServer ?? MailServices.smtp ?? null;
    } catch {
      service = null;
    }
    if (!service || typeof service.createServer !== "function" || typeof service.deleteServer !== "function") {
      throw fail("UNSUPPORTED", "service des serveurs sortants de Thunderbird introuvable");
    }
    return service;
  }

  function asSmtp(server) {
    return server.QueryInterface(Ci.nsISmtpServer);
  }

  function isNeutral(server, extensionId) {
    try {
      const branch = outgoingBranch(server);
      if (!branch || readPref(branch, OWNER) !== extensionId) return false;
      if ((server.type ?? "smtp") !== "smtp") return false;
      return String(asSmtp(server).hostname).toLowerCase() === HOST;
    } catch {
      return false;
    }
  }

  function neutralServers(service, extensionId) {
    return [...service.servers].filter((s) => isNeutral(s, extensionId));
  }

  /** A new outgoing server that cannot send: unresolvable name, TLS, no credentials. Marked first. */
  function createNeutral(service, extensionId) {
    const server = service.createServer("smtp");
    const branch = outgoingBranch(server);
    if (!branch) {
      service.deleteServer(server);
      throw fail("INTERNAL", "clé de serveur sortant inattendue");
    }
    branch.setStringPref(OWNER, extensionId);
    const smtp = asSmtp(server);
    smtp.hostname = HOST;
    smtp.port = NEUTRAL_PORT;
    server.socketType = Ci.nsMsgSocketType.SSL;
    server.authMethod = Ci.nsMsgAuthMethod.none;
    server.description = NEUTRAL_DESCRIPTION;
    return server;
  }

  function identityUses(serverKey) {
    return MailServices.accounts.allIdentities.some((identity) => identity.smtpServerKey === serverKey);
  }

  function deleteNeutral(service, server) {
    // Thunderbird's default outgoing server: let it pick another one.
    if (Services.prefs.getCharPref("mail.smtp.defaultserver", "") === server.key) {
      try {
        service.defaultServer = null;
      } catch {
        Services.prefs.clearUserPref("mail.smtp.defaultserver");
      }
    }
    service.deleteServer(server);
  }

  /** Deletes every neutral server of this extension that no identity uses. */
  function dropUnusedNeutral(service, extensionId) {
    for (const server of neutralServers(service, extensionId)) {
      if (!identityUses(server.key)) deleteNeutral(service, server);
    }
  }

  // ── Folders ───────────────────────────────────────────────────────────

  const flagOf = (use) => flags()[USES.get(use)];

  function childNamed(folder, name) {
    const found = folder.subFolders.filter((f) => f.name === name);
    return found.length === 1 ? found[0] : null;
  }

  /** The default folders, each with its special flag. */
  function createDefaultFolders(root) {
    // Listing the root first lets Thunderbird create its own default
    // folders of a "none" server (it may add "Unsent Messages").
    const local = root.QueryInterface(Ci.nsIMsgLocalMailFolder);
    for (const [name, use] of DEFAULT_FOLDERS) {
      const folder = childNamed(root, name) ?? local.createLocalSubfolder(name);
      folder.setFlag(flagOf(use));
    }
  }

  function pointIdentityTo(identity, use, folder, pickerMode) {
    const attributes = IDENTITY_FOLDERS.get(use);
    if (!attributes) return;
    const [uri, mode] = attributes;
    identity[uri] = folder.URI;
    identity[mode] = pickerMode;
  }

  /** The identity uses the account's default folders (those that exist). */
  function defaultIdentityFolders(identity, root) {
    for (const [name, use] of DEFAULT_FOLDERS) {
      const folder = childNamed(root, name);
      if (folder) pointIdentityTo(identity, use, folder, "0");
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
      (s) => String(s.hostname).toLowerCase() === HOST && String(s.username).toLowerCase() === mailboxId,
    );
  }

  function undoCreation({ server, identity, account }, service, extensionId) {
    try {
      if (account) MailServices.accounts.removeAccount(account, true);
      else if (server) MailServices.accounts.removeIncomingServer(server, true);
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
    } catch {
      // idem
    }
  }

  function createAccount(extensionId, service, { mailboxId, email, name, fullName }) {
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

      const neutral = neutralServers(service, extensionId)[0] ?? createNeutral(service, extensionId);

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
      const neutral = neutralServers(service, extensionId)[0] ?? createNeutral(service, extensionId);
      let identity = account.defaultIdentity;
      if (!identity) {
        identity = MailServices.accounts.createIdentity();
        identity.valid = true;
        account.addIdentity(identity);
        defaultIdentityFolders(identity, server.rootFolder);
      }
      if (identity.email !== email) identity.email = email;
      if (!identity.fullName && fullName) identity.fullName = fullName;
      // Closed sending, for every identity of the account.
      for (const each of account.identities) {
        if (each.smtpServerKey !== neutral.key) each.smtpServerKey = neutral.key;
      }
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
    owned(account, extensionId);
    const service = outgoingService();
    try {
      MailServices.accounts.removeAccount(account, true);
    } catch (e) {
      throw internal("suppression du compte", e);
    }
    try {
      dropUnusedNeutral(service, extensionId);
      MailServices.accounts.saveAccountInfo();
    } catch (e) {
      throw internal("suppression du serveur sortant neutre", e);
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

  function setSpecialUse(extensionId, accountKey, folderPath, use) {
    key(accountKey, ACCOUNT_KEY, "clé de compte");
    const segments = folderSegments(folderPath);
    useOf(use);
    const account = accountByKey(accountKey);
    if (!account) throw fail("NOT_FOUND", "compte introuvable");
    const { server } = owned(account, extensionId);
    try {
      const root = server.rootFolder;
      let folder = root;
      for (const segment of segments) {
        folder = childNamed(folder, segment);
        if (!folder) throw fail("NOT_FOUND", "dossier introuvable dans ce compte");
      }
      if (folder.getFlag(flags().Virtual)) throw fail("CONFIG", "un dossier virtuel ne peut pas avoir d'usage spécial");
      const flag = flagOf(use);
      for (const other of root.descendants) {
        if (other.URI !== folder.URI && other.getFlag(flag)) other.clearFlag(flag);
      }
      for (const otherUse of USES.keys()) {
        const otherFlag = flagOf(otherUse);
        if (otherFlag !== flag && folder.getFlag(otherFlag)) folder.clearFlag(otherFlag);
      }
      folder.setFlag(flag);
      for (const identity of account.identities) pointIdentityTo(identity, use, folder, "1");
      MailServices.accounts.saveAccountInfo();
    } catch (e) {
      throw internal("usage spécial du dossier", e);
    }
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
   * removeLoginAsync / modifyLoginAsync, or, where only they exist (older
   * versions), their synchronous forerunners. Neither: UNSUPPORTED.
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

    getAPI(context) {
      const api = this;
      const extensionId = context.extension.id;
      /**
       * An account operation (synchronous): checked when called, run in
       * turn, the context re-checked when its turn comes.
       */
      const accounts = (what, task) => {
        checkContext(context);
        return api.accountQueue(() => {
          checkContext(context);
          try {
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

          async removeAccount(accountKey) {
            return accounts("suppression du compte", () => removeAccount(extensionId, accountKey));
          },

          async setSpecialUse(accountKey, folderPath, use) {
            return accounts("usage spécial du dossier", () => {
              setSpecialUse(extensionId, accountKey, folderPath, use);
            });
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
