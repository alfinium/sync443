/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 alfinium */

/**
 * TEST ONLY: helpers for the sync443Net end-to-end test. Never part of the
 * shipped extension: it trusts a certificate authority, changes Thunderbird's
 * proxy settings and disables the extension, in a throw-away profile.
 *
 * Results go to <profile>/sync443net-e2e.txt (and to stdout): a file works the
 * same on every OS, whatever happens to a GUI program's standard output.
 */

"use strict";

/* global ExtensionCommon, ChromeUtils, Services, Cc, Ci, IOUtils, PathUtils */

// eslint-disable-next-line no-var, no-unused-vars
var sync443NetTest = (() => {
  const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  let queue = Promise.resolve();

  /** Appends one line to the results file; lines keep their order. */
  function print(line) {
    const text = `${line}\n`;
    dump(text);
    queue = queue
      .then(() => IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "sync443net-e2e.txt"), text, { mode: "appendOrCreate" }))
      .catch((e) => dump(`sync443NetTest: cannot write the results file: ${e}\n`));
    return queue;
  }

  return class extends ExtensionCommon.ExtensionAPI {
    getAPI(context) {
      const extensionId = context.extension.id;
      return {
        sync443NetTest: {
          async trustAuthority(base64Der) {
            const db = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);
            const cert = db.addCertFromBase64(base64Der, "C,,");
            return cert.sha256Fingerprint;
          },

          /** Grants a host permission at run time, as an accepted permissions.request() would. */
          async grantOrigin(origin) {
            const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
            await ExtensionPermissions.add(extensionId, { permissions: [], origins: [origin] }, context.extension);
          },

          /** Imports a client certificate and its key (PKCS#12 file); returns nsIX509CertDB's error code (0: success). */
          async importPkcs12(path, password) {
            const db = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);
            const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
            file.initWithPath(path);
            return db.importPKCS12File(file, password);
          },

          /** Sets preferences: {name: boolean | integer | string}. */
          async setPrefs(prefs) {
            for (const [name, value] of Object.entries(prefs)) {
              if (typeof value === "boolean") Services.prefs.setBoolPref(name, value);
              else if (Number.isInteger(value)) Services.prefs.setIntPref(name, value);
              else Services.prefs.setStringPref(name, String(value));
            }
          },

          /** Gecko constants the test depends on (undefined if this version lacks them). */
          async probe() {
            return {
              stateCertUserOverridden: Ci.nsIWebProgressListener.STATE_CERT_USER_OVERRIDDEN,
              anonymousConnect: Ci.nsISocketTransport.ANONYMOUS_CONNECT,
              https6697Allowed: Services.io.allowPort(6697, "https"),
            };
          },

          /** A certificate exception, as a user clicking "accept the risk" would add it. */
          async addException(host, port, base64Der) {
            const db = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);
            const overrides = Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService);
            overrides.rememberValidityOverride(host, port, {}, db.constructX509FromBase64(base64Der), false);
          },

          async setProxy(mode, port) {
            const p = Services.prefs;
            // Gecko never proxies localhost unless told to.
            p.setBoolPref("network.proxy.allow_hijacking_localhost", true);
            p.setStringPref("network.proxy.no_proxies_on", "");
            p.setBoolPref("network.proxy.share_proxy_settings", false);
            p.setStringPref("network.proxy.http", "");
            p.setIntPref("network.proxy.http_port", 0);
            p.setStringPref("network.proxy.ssl", "");
            p.setIntPref("network.proxy.ssl_port", 0);
            p.setStringPref("network.proxy.socks", "");
            p.setIntPref("network.proxy.socks_port", 0);
            if (mode === "direct") {
              p.setIntPref("network.proxy.type", 0);
            } else if (mode === "http") {
              p.setStringPref("network.proxy.ssl", "127.0.0.1");
              p.setIntPref("network.proxy.ssl_port", port);
              p.setIntPref("network.proxy.type", 1);
            } else if (mode === "socks") {
              p.setStringPref("network.proxy.socks", "127.0.0.1");
              p.setIntPref("network.proxy.socks_port", port);
              p.setIntPref("network.proxy.socks_version", 5);
              p.setBoolPref("network.proxy.socks_remote_dns", true);
              p.setBoolPref("network.proxy.socks5_remote_dns", true);
              p.setIntPref("network.proxy.type", 1);
            }
          },

          print,

          /**
           * In 300 ms, disables this extension (its sockets must be closed
           * by sync443Net), then prints SYNC443NET-DONE and quits Thunderbird.
           */
          async shutdownSoon() {
            const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
            setTimeout(async () => {
              try {
                const addon = await AddonManager.getAddonByID(extensionId);
                await print(`SYNC443NET-DISABLING {"at":${Date.now()}}`);
                await addon.disable();
                await print(`SYNC443NET-DISABLED {"at":${Date.now()}}`);
              } catch (e) {
                await print(`SYNC443NET-DISABLE-FAILED {"error":${JSON.stringify(String(e))}}`);
              }
              setTimeout(async () => {
                await print(`SYNC443NET-DONE {"at":${Date.now()}}`);
                Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
              }, 1500);
            }, 300);
          },

          async quit() {
            Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
          },
        },
      };
    }
  };
})();
