// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * TEST ONLY: helpers for the sync443Account end-to-end test. Never part of
 * the shipped extension: it creates accounts the extension does not own,
 * forges marks, reads the login manager and quits Thunderbird, in a
 * throw-away profile.
 *
 * Results go to <profile>/sync443account-e2e.txt (and to stdout): a file
 * works the same on every OS, whatever happens to a GUI program's output.
 */

"use strict";

/* global ExtensionCommon, ChromeUtils, Services, Cc, Ci, Cr, Components, IOUtils, PathUtils */

// eslint-disable-next-line no-var, no-unused-vars
var sync443AccountTest = (() => {
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  let queue = Promise.resolve();
  let originalOutgoing; // MailServices.outgoingServer, while a stub replaces it
  let realLogins; // Services.logins, while a proxy replaces it

  /** Appends one line to the results file; lines keep their order. */
  function print(line) {
    const text = `${line}\n`;
    dump(text);
    queue = queue
      .then(() => IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "sync443account-e2e.txt"), text, { mode: "appendOrCreate" }))
      .catch((e) => dump(`sync443AccountTest: cannot write the results file: ${e}\n`));
    return queue;
  }

  const USES = [
    ["Inbox", "inbox"],
    ["Drafts", "drafts"],
    ["SentMail", "sent"],
    ["Trash", "trash"],
    ["Templates", "templates"],
    ["Archive", "archives"],
    ["Junk", "junk"],
    ["Queue", "outbox"],
  ];
  const usesOf = (folder) => USES.filter(([flag]) => folder.getFlag(Ci.nsMsgFolderFlags[flag])).map(([, use]) => use);

  /** The path with symbolic links resolved (macOS: /var is /private/var). */
  function real(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    try {
      file.normalize();
    } catch {
      // does not exist (any more): as given
    }
    return file.path;
  }

  const accountByKey = (key) => MailServices.accounts.accounts.find((a) => a.key === key) ?? null;
  const identityByKey = (key) => MailServices.accounts.allIdentities.find((i) => i.key === key) ?? null;
  const outgoing = () => MailServices.outgoingServer;

  function folderAt(root, path) {
    let folder = root;
    for (const name of path.split("/").filter(Boolean)) {
      folder = folder.subFolders.find((f) => f.name === name);
      if (!folder) throw new Error(`no folder ${path}`);
    }
    return folder;
  }

  function walk(folder, prefix, out) {
    for (const child of folder.subFolders) {
      const path = `${prefix}/${child.name}`;
      out.push({ path, uri: child.URI, uses: usesOf(child) });
      walk(child, path, out);
    }
    return out;
  }

  function marks(prefix, key) {
    const branch = Services.prefs.getBranch(`${prefix}.${key}.`);
    return { owner: branch.getStringPref("sync443.owner", ""), mailbox: branch.getStringPref("sync443.mailbox", "") };
  }

  function describeOutgoing(server) {
    const smtp = server.QueryInterface(Ci.nsISmtpServer);
    return {
      key: server.key,
      hostname: smtp.hostname,
      port: smtp.port,
      socketType: server.socketType,
      authMethod: server.authMethod,
      username: server.username,
      description: server.description,
      owner: marks("mail.smtpserver", server.key).owner,
    };
  }

  return class extends ExtensionCommon.ExtensionAPI {
    getAPI() {
      return {
        sync443AccountTest: {
          print,

          async quit() {
            await queue;
            Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
          },

          /** The phase the runner asked for (<profile>/sync443account-phase.json). */
          async phase() {
            const text = await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, "sync443account-phase.json"));
            return JSON.parse(text).phase;
          },

          async probe() {
            const logins = Services.logins;
            const methods = {};
            for (const name of ["searchLoginsAsync", "addLoginAsync", "modifyLoginAsync", "removeLoginAsync", "removeLogin", "modifyLogin"]) {
              methods[name] = typeof logins[name] === "function";
            }
            return {
              version: Services.appinfo.version,
              profileDir: PathUtils.profileDir,
              // Where Thunderbird puts the files of local accounts.
              mailDir: real(Services.dirsvc.get("MailD", Ci.nsIFile).path),
              logins: methods,
              outgoingServerService: !!MailServices.outgoingServer,
              rustLogins: Services.prefs.getBoolPref("signon.storage.rust.active", false),
            };
          },

          /**
           * "Local Folders" as the preference names it (never through
           * Thunderbird's getter, which adopts any "none" server when the
           * preference is unset); made only if the preference is unset.
           */
          async ensureLocalFolders() {
            if (!Services.prefs.getCharPref("mail.accountmanager.localfoldersserver", "")) {
              MailServices.accounts.createLocalMailAccount();
            }
            const key = Services.prefs.getCharPref("mail.accountmanager.localfoldersserver", "");
            const server = MailServices.accounts.allServers.find((s) => s.key === key);
            return { accountKey: MailServices.accounts.findAccountForServer(server).key, localPath: real(server.localPath.path) };
          },

          /** The "Local Folders" preference and the server it names (or null). */
          async localFolders() {
            const pref = Services.prefs.getCharPref("mail.accountmanager.localfoldersserver", "");
            const server = MailServices.accounts.allServers.find((s) => s.key === pref) ?? null;
            return {
              pref,
              server: server && {
                key: server.key,
                type: server.type,
                hostname: server.hostname ?? server.hostName, // hostName in Thunderbird 140
                username: server.username,
                marks: marks("mail.server", server.key),
                accountKey: MailServices.accounts.findAccountForServer(server)?.key ?? null,
              },
            };
          },

          /** What Thunderbird's own getter answers (it adopts a "none" server if the preference is unset). */
          async localFoldersViaGetter() {
            try {
              return MailServices.accounts.localFoldersServer?.key ?? null;
            } catch {
              return null;
            }
          },

          /** Sets the "Local Folders" preference ("" clears it), as Thunderbird's getter would save its choice. */
          async setLocalFoldersPref(value) {
            if (value) Services.prefs.setCharPref("mail.accountmanager.localfoldersserver", value);
            else Services.prefs.clearUserPref("mail.accountmanager.localfoldersserver");
          },

          /** A "none" account the extension did not create, with optional (forged) marks. */
          async createForeignAccount({ username, hostname, owner, mailbox }) {
            const server = MailServices.accounts.createIncomingServer(username, hostname, "none");
            const branch = Services.prefs.getBranch(`mail.server.${server.key}.`);
            if (owner) branch.setStringPref("sync443.owner", owner);
            if (mailbox) branch.setStringPref("sync443.mailbox", mailbox);
            server.prettyName = `Compte étranger ${username}@${hostname}`;
            const identity = MailServices.accounts.createIdentity();
            identity.email = `${username}@example.net`;
            identity.valid = true;
            const account = MailServices.accounts.createAccount();
            account.addIdentity(identity);
            account.incomingServer = server;
            void server.rootFolder.subFolders;
            MailServices.accounts.saveAccountInfo();
            return { accountKey: account.key, identityId: identity.key, localPath: server.localPath.path };
          },

          /** Sets (or, with null, clears) the marks on an account's incoming server. */
          async setMarks(accountKey, owner, mailbox) {
            const server = accountByKey(accountKey).incomingServer;
            const branch = Services.prefs.getBranch(`mail.server.${server.key}.`);
            for (const [name, value] of [["sync443.owner", owner], ["sync443.mailbox", mailbox]]) {
              if (value === null) branch.clearUserPref(name);
              else branch.setStringPref(name, value);
            }
          },

          /** Everything the test checks about an account, or null if it does not exist. */
          async inspect(accountKey) {
            const account = accountByKey(accountKey);
            if (!account) return null;
            const server = account.incomingServer;
            const localPath = real(server.localPath.path);
            const service = outgoing();
            return {
              accountKey,
              serverKey: server.key,
              type: server.type,
              hostname: server.hostname ?? server.hostName, // hostName in Thunderbird 140
              username: server.username,
              prettyName: server.prettyName,
              marks: marks("mail.server", server.key),
              localPath,
              localPathExists: await IOUtils.exists(localPath),
              rootURI: server.rootFolder.URI,
              moveOnSpamLoaded: server.spamSettings?.moveOnSpam ?? null,
              folders: walk(server.rootFolder, "", []),
              identities: account.identities.map((identity) => ({
                key: identity.key,
                email: identity.email,
                fullName: identity.fullName,
                smtpServerKey: identity.smtpServerKey,
                effectiveSmtpKey: service.getServerByIdentity(identity)?.key ?? null,
                draftsFolderURI: identity.draftsFolderURI,
                fccFolderURI: identity.fccFolderURI,
                templatesFolderURI: identity.templatesFolderURI,
                archivesFolderURI: identity.archivesFolderURI,
              })),
            };
          },

          async accountKeys() {
            return MailServices.accounts.accounts.map((a) => a.key);
          },

          async identityKeys() {
            return MailServices.accounts.allIdentities.map((i) => i.key);
          },

          /** Outgoing servers and the default one. */
          async outgoing() {
            const service = outgoing();
            return {
              servers: [...service.servers].map(describeOutgoing),
              defaultKey: Services.prefs.getCharPref("mail.smtp.defaultserver", ""),
            };
          },

          /** Makes this outgoing server Thunderbird's default one (as Thunderbird does when it is the only one). */
          async setDefaultSmtp(key) {
            Services.prefs.setCharPref("mail.smtp.defaultserver", key);
          },

          /** The outgoing server Thunderbird uses by default (asking it, as Thunderbird does). */
          async effectiveDefaultSmtp() {
            return outgoing().defaultServer?.key ?? null;
          },

          /** A user's own outgoing server; made the default one unless makeDefault is false. */
          async createUserSmtp(hostname, makeDefault) {
            const service = outgoing();
            const server = service.createServer("smtp");
            const smtp = server.QueryInterface(Ci.nsISmtpServer);
            smtp.hostname = hostname;
            smtp.port = 587;
            server.socketType = Ci.nsMsgSocketType.alwaysSTARTTLS;
            if (makeDefault !== false) service.defaultServer = server;
            return server.key;
          },

          /** An identity added to an account, as the account settings do (no outgoing server chosen). */
          async addIdentity(accountKey, email) {
            const identity = MailServices.accounts.createIdentity();
            identity.email = email;
            identity.valid = true;
            accountByKey(accountKey).addIdentity(identity);
            return identity.key;
          },

          /**
           * Preferences left under an outgoing server key no server has, as
           * Thunderbird 140 leaves them when it deletes a server: the host
           * name, and our mark when `owner` is given.
           */
          async leaveOutgoingPrefs(key, owner) {
            const branch = Services.prefs.getBranch(`mail.smtpserver.${key}.`);
            branch.setStringPref("hostname", "127.0.0.1");
            if (owner) branch.setStringPref("sync443.owner", owner);
          },

          /** Names of the preferences under an outgoing server key. */
          async outgoingPrefNames(key) {
            return Services.prefs.getBranch(`mail.smtpserver.${key}.`).getChildList("").sort();
          },

          async clearOutgoingPrefs(key) {
            const branch = Services.prefs.getBranch(`mail.smtpserver.${key}.`);
            for (const name of branch.getChildList("")) branch.clearUserPref(name);
          },

          /** Edits an outgoing server's preferences, as a user (or anything else) might. */
          async editOutgoing(key, { hostname, port, username, authMethod, socketType }) {
            const branch = Services.prefs.getBranch(`mail.smtpserver.${key}.`);
            if (typeof hostname === "string") branch.setStringPref("hostname", hostname);
            if (typeof username === "string") branch.setStringPref("username", username);
            if (Number.isInteger(authMethod)) branch.setIntPref("authMethod", authMethod);
            if (Number.isInteger(socketType)) branch.setIntPref("try_ssl", socketType);
            if (Number.isInteger(port)) {
              const server = outgoing().servers.find((s) => s.key === key);
              server.QueryInterface(Ci.nsISmtpServer).port = port;
            }
          },

          /**
           * Account Settings › Outgoing Server › Remove: the server is deleted,
           * then the identities that used it are left on "the default server".
           */
          async removeOutgoingLikeSettings(key) {
            const service = outgoing();
            service.deleteServer(service.servers.find((s) => s.key === key));
            for (const identity of MailServices.accounts.allIdentities) {
              if (identity.smtpServerKey === key) identity.smtpServerKey = "";
            }
          },

          /** Deletes an outgoing server, then adds a user's one at once (it may take the freed key). */
          async replaceOutgoing(key, hostname) {
            const service = outgoing();
            service.deleteServer(service.servers.find((s) => s.key === key));
            const server = service.createServer("smtp");
            server.QueryInterface(Ci.nsISmtpServer).hostname = hostname;
            return server.key;
          },

          /** Points an account's server at another folder (its "directory" preference). */
          async setLocalPath(accountKey, path) {
            const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            file.initWithPath(path);
            accountByKey(accountKey).incomingServer.localPath = file;
          },

          /** A folder in the profile with one file in it; its path. */
          async makeCanaryDir(name) {
            const dir = PathUtils.join(PathUtils.profileDir, name);
            await IOUtils.makeDirectory(dir, { ignoreExisting: true });
            await IOUtils.writeUTF8(PathUtils.join(dir, "canari.txt"), "ne pas supprimer\n");
            return real(dir);
          },

          /** The preferences of a branch ("mail.identity.id3.", "mail.server.server2."), as {name: value}. */
          async prefsOf(prefix) {
            const branch = Services.prefs.getBranch(prefix);
            const out = {};
            for (const name of branch.getChildList("").sort()) {
              const type = branch.getPrefType(name);
              if (type === branch.PREF_STRING) out[name] = branch.getStringPref(name);
              else if (type === branch.PREF_INT) out[name] = branch.getIntPref(name);
              else if (type === branch.PREF_BOOL) out[name] = branch.getBoolPref(name);
            }
            return out;
          },

          /** Writes preferences of a branch ({name: boolean | integer | string}). */
          async setBranchPrefs(prefix, values) {
            const branch = Services.prefs.getBranch(prefix);
            for (const [name, value] of Object.entries(values)) {
              if (typeof value === "boolean") branch.setBoolPref(name, value);
              else if (Number.isInteger(value)) branch.setIntPref(name, value);
              else branch.setStringPref(name, String(value));
            }
          },

          /** Thunderbird's loaded junk settings of an account read again from its preferences, as the account settings do. */
          async reloadSpamSettings(accountKey) {
            const server = accountByKey(accountKey).incomingServer;
            server.spamSettings.initialize(server);
            return server.spamSettings.moveOnSpam;
          },

          async dirEntries(path) {
            return (await IOUtils.getChildren(path)).map((p) => PathUtils.filename(p)).sort();
          },

          /** As a user editing the identity in the account settings would. */
          async setIdentity(identityId, { fullName, smtpServerKey }) {
            const identity = identityByKey(identityId);
            if (typeof fullName === "string") identity.fullName = fullName;
            if (typeof smtpServerKey === "string") identity.smtpServerKey = smtpServerKey;
          },

          async createFolder(accountKey, parentPath, name) {
            const root = accountByKey(accountKey).incomingServer.rootFolder;
            const parent = folderAt(root, parentPath);
            return parent.QueryInterface(Ci.nsIMsgLocalMailFolder).createLocalSubfolder(name).URI;
          },

          /** Every login saved for this origin, whatever its realm. */
          async rawLogins(origin) {
            const found = await Services.logins.searchLoginsAsync({ origin });
            return [...found].map((l) => ({
              origin: l.origin,
              httpRealm: l.httpRealm,
              formActionOrigin: l.formActionOrigin,
              username: l.username,
              password: l.password,
            }));
          },

          /** A login of someone else for the same origin (another realm, or a form). */
          async addForeignLogin(origin, username, password, realm, formActionOrigin) {
            const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
            login.init(origin, formActionOrigin ?? null, realm ?? null, username, password, "", "");
            await Services.logins.addLoginAsync(login);
          },

          async exists(path) {
            return IOUtils.exists(path);
          },

          /** Names in Thunderbird's directory for local accounts. */
          async mailDirEntries() {
            const dir = Services.dirsvc.get("MailD", Ci.nsIFile).path;
            return (await IOUtils.getChildren(dir)).map((p) => PathUtils.filename(p)).sort();
          },

          /** Is there a server (with or without an account) of this name? */
          async serverExists(username, hostname) {
            return !!MailServices.accounts.findServer(username, hostname, "none", 0);
          },

          /**
           * Replaces MailServices.outgoingServer, for this process, by: null
           * ("missing"), a service whose createServer() fails ("failing"),
           * or the real one again ("restore"). Returns whether it took effect.
           */
          async stubOutgoing(mode) {
            if (originalOutgoing === undefined) originalOutgoing = MailServices.outgoingServer;
            let value = originalOutgoing;
            if (mode === "missing") value = null;
            if (mode === "failing") {
              value = {
                servers: [],
                createServer() {
                  throw Components.Exception("échec simulé", Cr.NS_ERROR_FAILURE);
                },
                deleteServer() {},
              };
            }
            Object.defineProperty(MailServices, "outgoingServer", { value, configurable: true, writable: true, enumerable: true });
            return MailServices.outgoingServer === value;
          },

          /**
           * Replaces, for the experiment scripts of this extension (they
           * share one global, hence one Services object), Thunderbird's
           * login manager by a proxy that overrides one method: "locked"
           * (searching fails as when the primary password is not entered),
           * "removeFails", "noRemove", "noSearch"; "restore" puts the real
           * one back. Returns whether the change is seen.
           */
          async breakLogins(mode) {
            if (realLogins === undefined) realLogins = Services.logins;
            const fail = (status) => async () => {
              throw Components.Exception("échec simulé", status);
            };
            // Removal: the asynchronous method and its synchronous forerunner
            // (Thunderbird 140 has only the latter).
            const overrides = {
              locked: [["searchLoginsAsync"], fail(Cr.NS_ERROR_ABORT)],
              removeFails: [["removeLoginAsync", "removeLogin"], fail(Cr.NS_ERROR_FAILURE)],
              noRemove: [["removeLoginAsync", "removeLogin"], undefined],
              noSearch: [["searchLoginsAsync"], undefined],
            };
            let value = realLogins;
            if (mode !== "restore") {
              const [names, replacement] = overrides[mode];
              // An empty target: the real service's methods are fixed
              // properties, which a proxy over it could not report otherwise.
              value = new Proxy(
                {},
                {
                  get(_, property) {
                    if (names.includes(property)) return replacement;
                    const member = realLogins[property];
                    return typeof member === "function" ? member.bind(realLogins) : member;
                  },
                },
              );
            }
            try {
              Object.defineProperty(Services, "logins", { value, configurable: true, writable: true, enumerable: true });
            } catch {
              return false;
            }
            return Services.logins === value;
          },
        },
      };
    }
  };
})();
