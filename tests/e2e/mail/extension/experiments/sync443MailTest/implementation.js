// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * TEST ONLY: helpers for the mail end-to-end test (tests/e2e/mail). Packaged
 * by run_mail_test.py into a TEST build of the extension, never into a
 * release build (tools/build_xpi.py packages src/ only): it trusts test
 * certificate authorities, grants a host permission without a user gesture,
 * reads the login manager and quits Thunderbird, in a throw-away profile.
 *
 * Results go to <profile>/sync443mail-e2e.txt (and to stdout). Requests to
 * the runner (which drives the mock ActiveSync server) are files in the
 * profile: <name>.req written by rpc(), answered by the runner with
 * <name>.res. Files work the same on every OS.
 */

"use strict";

/* global ExtensionCommon, ChromeUtils, Services, Cc, Ci, IOUtils, PathUtils */

// eslint-disable-next-line no-var, no-unused-vars
var sync443MailTest = (() => {
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const RESULTS = "sync443mail-e2e.txt";
  const launch = Math.random().toString(16).slice(2, 10);
  let queue = Promise.resolve();
  let rpcSeq = 0;
  const errors = [];
  let listening = false;

  /** Appends one line to the results file; lines keep their order. */
  function print(line) {
    const text = `${line}\n`;
    dump(text);
    queue = queue
      .then(() => IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, RESULTS), text, { mode: "appendOrCreate" }))
      .catch((e) => dump(`sync443MailTest: cannot write the results file: ${e}\n`));
    return queue;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function describeError(m) {
    let e;
    try {
      e = m.QueryInterface(Ci.nsIScriptError);
    } catch {
      return null;
    }
    const warning = (e.flags & Ci.nsIScriptError.warningFlag) !== 0 || (e.flags & Ci.nsIScriptError.infoFlag) !== 0;
    if (warning) return null;
    return {
      message: String(e.errorMessage).slice(0, 600),
      source: String(e.sourceName ?? "").slice(0, 300),
      line: e.lineNumber,
      category: String(e.category ?? ""),
      time: e.timeStamp,
    };
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
  const accountByKey = (key) => MailServices.accounts.accounts.find((a) => a.key === key) ?? null;
  const outgoingService = () => MailServices.outgoingServer ?? MailServices.smtp;

  function real(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    try {
      file.normalize();
    } catch {
      // gone: as given
    }
    return file.path;
  }

  function walk(folder, prefix, out) {
    for (const child of folder.subFolders) {
      const path = `${prefix}/${child.name}`;
      out.push({ path, uses: usesOf(child), total: child.getTotalMessages(false) });
      walk(child, path, out);
    }
    return out;
  }

  function describeOutgoing(server) {
    const smtp = server.QueryInterface(Ci.nsISmtpServer);
    return {
      key: server.key,
      hostname: smtp.hostname,
      port: smtp.port,
      username: server.username,
      owner: Services.prefs.getBranch(`mail.smtpserver.${server.key}.`).getStringPref("sync443.owner", ""),
    };
  }

  return class extends ExtensionCommon.ExtensionAPI {
    getAPI(context) {
      const extension = context.extension;
      if (!listening) {
        listening = true;
        Services.console.registerListener({
          QueryInterface: ChromeUtils.generateQI(["nsIConsoleListener"]),
          observe(m) {
            const e = describeError(m);
            if (e) errors.push(e);
          },
        });
      }
      return {
        sync443MailTest: {
          print,

          async phase() {
            const text = await IOUtils.readUTF8(PathUtils.join(PathUtils.profileDir, "sync443mail-phase.json"));
            return JSON.parse(text);
          },

          /** One request to the runner; its answer ({ok, result} or {ok: false, error}). */
          async rpc(request, timeoutMs) {
            const name = `sync443mail-rpc-${launch}-${String(++rpcSeq).padStart(6, "0")}`;
            const dir = PathUtils.profileDir;
            const req = PathUtils.join(dir, `${name}.req`);
            const res = PathUtils.join(dir, `${name}.res`);
            await IOUtils.writeUTF8(req, JSON.stringify(request), { tmpPath: `${req}.tmp` });
            const deadline = Date.now() + (timeoutMs ?? 120_000);
            while (Date.now() < deadline) {
              if (await IOUtils.exists(res)) {
                const text = await IOUtils.readUTF8(res);
                await IOUtils.remove(res).catch(() => {});
                return JSON.parse(text);
              }
              await sleep(40);
            }
            return { ok: false, error: "RPC: no answer from the runner" };
          },

          async trustAuthority(base64Der) {
            const db = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);
            const cert = db.addCertFromBase64(base64Der, "C,,");
            return cert.sha256Fingerprint;
          },

          /** Grants a host permission at run time, as an accepted permissions.request() would. */
          async grantOrigin(origin) {
            const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
            await ExtensionPermissions.add(extension.id, { permissions: [], origins: [origin] }, extension);
          },

          async inspect(accountKey) {
            const account = accountByKey(accountKey);
            if (!account) return null;
            const server = account.incomingServer;
            const localPath = real(server.localPath.path);
            const service = outgoingService();
            return {
              accountKey,
              type: server.type,
              hostname: server.hostname ?? server.hostName, // hostName in Thunderbird 140
              username: server.username,
              prettyName: server.prettyName,
              localPath,
              localPathExists: await IOUtils.exists(localPath),
              folders: walk(server.rootFolder, "", []),
              identities: account.identities.map((identity) => {
                const smtp = service.getServerByIdentity(identity);
                return {
                  key: identity.key,
                  email: identity.email,
                  smtpServerKey: identity.smtpServerKey,
                  effectiveSmtp: smtp ? describeOutgoing(smtp) : null,
                  draftsFolderURI: identity.draftsFolderURI,
                  fccFolderURI: identity.fccFolderURI,
                };
              }),
            };
          },

          /** Creates Thunderbird's "Local Folders" account, as its account wizard does (run_mail_test.py --local-folders). */
          async createLocalFolders() {
            if (!Services.prefs.getCharPref("mail.accountmanager.localfoldersserver", "")) MailServices.accounts.createLocalMailAccount();
          },

          /** Thunderbird's "Local Folders" server, as its preference names it (read without side effect). */
          async localFolders() {
            const key = Services.prefs.getCharPref("mail.accountmanager.localfoldersserver", "");
            const server = key ? MailServices.accounts.allServers.find((s) => s.key === key) ?? null : null;
            return {
              key,
              hostname: server ? String(server.hostname ?? server.hostName) : null, // hostName in Thunderbird 140
              type: server ? server.type : null,
              owner: server ? Services.prefs.getBranch(`mail.server.${key}.`).getStringPref("sync443.owner", "") : null,
            };
          },

          async outgoing() {
            const service = outgoingService();
            return { servers: [...service.servers].map(describeOutgoing) };
          },

          async rawLogins(origin) {
            const found = await Services.logins.searchLoginsAsync({ origin });
            return [...found].map((l) => ({ origin: l.origin, httpRealm: l.httpRealm, username: l.username }));
          },

          async exists(path) {
            return IOUtils.exists(path);
          },

          /** Script errors of this session (not warnings), each marked `ours` when it comes from this extension. */
          async consoleErrors() {
            const all = [...errors];
            for (const m of Services.console.getMessageArray() ?? []) {
              const e = describeError(m);
              if (e && !all.some((x) => x.time === e.time && x.message === e.message && x.source === e.source)) all.push(e);
            }
            const base = extension.baseURL;
            const root = String(extension.rootURI?.spec ?? "");
            return all.map((e) => ({
              ...e,
              ours: e.source.startsWith(base) || (root && e.source.startsWith(root)) || /sync443/i.test(e.source) || /sync443/i.test(e.message),
            }));
          },

          async quit() {
            await queue;
            Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
          },
        },
      };
    }
  };
})();
