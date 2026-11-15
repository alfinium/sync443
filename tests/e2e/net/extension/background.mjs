// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * sync443Net end-to-end scenario, run inside a headless Thunderbird by
 * tests/e2e/net/run_net_test.py. For every connection it does what the
 * extension will do: open, judge the certificate with the real
 * core/tls-policy.mjs, and write the request (with a fake password) ONLY if
 * the certificate is accepted. The runner then checks, from the logs of its
 * own TLS servers and proxies, what reached the network.
 *
 * Prints "SYNC443NET-CASE {json}" per case and "SYNC443NET-CASES [names]";
 * then keeps one connection open and has the extension disabled: the runner
 * checks that the connection is closed then, not at Thunderbird's exit.
 */

import { evaluateTls } from "./core/tls-policy.mjs";

const net = browser.sync443Net;
const helper = browser.sync443NetTest;
const AUTH = "Authorization: Basic dGVzdDp0ZXN0";
const HOST = "localhost";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const latin1 = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");
const isBytes = (v) => Object.prototype.toString.call(v) === "[object Uint8Array]";

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const escapeJson = (value) =>
  JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

async function print(kind, value) {
  await helper.print(`SYNC443NET-${kind} ${escapeJson(value)}`);
}

/**
 * The request the runner expects, byte for byte: headers with the fake
 * password, then bytes 0..255; or (get) a bare GET, which "openssl s_server
 * -www" answers.
 */
function request(port, name, { host = HOST, get = false } = {}) {
  if (get) return ascii(`GET /test/${name} HTTP/1.0\r\nHost: ${host}:${port}\r\n${AUTH}\r\nConnection: close\r\n\r\n`);
  const body = Uint8Array.from({ length: 256 }, (_, i) => i);
  const head =
    `POST /test/${name} HTTP/1.1\r\nHost: ${host}:${port}\r\n${AUTH}\r\n` +
    `Content-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  return concat([ascii(head), body]);
}

async function failureOf(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

async function readAll(id) {
  const chunks = [];
  for (;;) {
    const chunk = await net.read(id, { maxBytes: 1048576, timeoutMs: 10000 });
    if (chunk === null) return chunks;
    if (!isBytes(chunk)) throw new Error("read() did not return a Uint8Array");
    chunks.push(chunk);
  }
}

/**
 * One connection as the extension makes it. `pin`: trust the test authority
 * (as a user who approved a private authority would); without it the
 * policy refuses the chain (not a built-in root) and nothing is written.
 */
async function exchange(name, port, { pin = true, form = "uint8", host = HOST, get = false } = {}) {
  const out = { name, port };
  if (!port) {
    out.skipped = true;
    return out;
  }
  let conn;
  out.startedAt = Date.now();
  try {
    conn = await net.open({ host, port, timeoutMs: 10000 });
  } catch (e) {
    out.openError = String(e?.message ?? e);
    out.failedAt = Date.now();
    return out;
  }
  out.openedAt = Date.now();
  out.route = conn.route;
  out.idIsUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(conn.id);
  out.securityInfo = conn.securityInfo;
  out.verdictWithoutPin = evaluateTls(conn.securityInfo).reason;
  const verdict = evaluateTls(conn.securityInfo, { pins: pin ? [CONFIG.caSha256] : [] });
  out.verdict = verdict.reason;
  if (!verdict.ok) {
    await net.close(conn.id);
    out.closedWithoutWriting = true;
    out.closedAt = Date.now();
    return out;
  }
  const bytes = request(port, name, { host, get });
  let payload = bytes;
  if (form === "buffer") payload = bytes.buffer;
  if (form === "view") {
    // A view in the middle of a larger buffer: only the viewed bytes may go out.
    const larger = new Uint8Array(bytes.length + 10).fill(0x58);
    larger.set(bytes, 5);
    payload = larger.subarray(5, 5 + bytes.length);
  }
  // A pause, so that the server's log shows unambiguously that the first
  // application byte comes from write(), not from open().
  await sleep(100);
  out.writeAt = Date.now();
  await net.write(conn.id, payload);
  const chunks = await readAll(conn.id);
  out.response = latin1(concat(chunks));
  await net.close(conn.id);
  return out;
}

let CONFIG = null;

async function caseArguments() {
  const p = CONFIG.ports;
  const out = { name: "arguments" };
  out.noPermission = await failureOf(net.open({ host: "example.com", port: 443 }));
  out.otherNameSameMachine = await failureOf(net.open({ host: "127.0.0.1", port: p.okDirect }));
  out.upperCase = await failureOf(net.open({ host: "LOCALHOST", port: p.okDirect }));
  out.path = await failureOf(net.open({ host: "localhost/x", port: p.okDirect }));
  out.userinfo = await failureOf(net.open({ host: "user@localhost", port: p.okDirect }));
  out.shortIPv4 = await failureOf(net.open({ host: "127.1", port: p.okDirect }));
  out.port0 = await failureOf(net.open({ host: HOST, port: 0 }));
  out.port70000 = await failureOf(net.open({ host: HOST, port: 70000 }));
  out.bannedPort = await failureOf(net.open({ host: HOST, port: 6697 }));
  out.timeoutOver120s = await failureOf(net.open({ host: HOST, port: p.okDirect, timeoutMs: 120001 }));
  out.portString = await failureOf(net.open({ host: HOST, port: String(p.okDirect) }));
  out.tinyTimeout = await failureOf(net.open({ host: HOST, port: p.okDirect, timeoutMs: 5 }));
  out.noOptions = await failureOf(net.open());
  out.unknownIdWrite = await failureOf(net.write("00000000-0000-0000-0000-000000000000", [1]));
  out.unknownIdRead = await failureOf(net.read("00000000-0000-0000-0000-000000000000"));
  out.unknownIdClose = await failureOf(net.close("00000000-0000-0000-0000-000000000000"));
  return out;
}

async function caseMisc() {
  const port = CONFIG.ports.misc;
  const out = { name: "misc" };
  const c = await net.open({ host: HOST, port, timeoutMs: 10000 });
  out.badBytesString = await failureOf(net.write(c.id, "texte"));
  out.badBytes256 = await failureOf(net.write(c.id, [1, 256]));
  out.badBytesArray = await failureOf(net.write(c.id, [1, 2, 3]));
  out.tooBig = await failureOf(net.write(c.id, new Uint8Array(1048577)));
  out.badMaxBytes0 = await failureOf(net.read(c.id, { maxBytes: 0 }));
  out.badMaxBytesBig = await failureOf(net.read(c.id, { maxBytes: 2 * 1048576 }));
  let t = Date.now();
  out.readTimeout = await failureOf(net.read(c.id, { timeoutMs: 300 }));
  out.readTimeoutMs = Date.now() - t;
  // A read waiting while we write; a second read at the same time is refused.
  const pending = net.read(c.id, { timeoutMs: 5000 });
  out.concurrentRead = await failureOf(net.read(c.id, { timeoutMs: 100 }));
  await net.write(c.id, request(port, "after-timeout"));
  const first = await pending;
  const rest = await readAll(c.id);
  out.response = latin1(concat([first, ...rest]));
  await net.close(c.id);
  out.writeAfterClose = await failureOf(net.write(c.id, [1, 2, 3]));
  out.readAfterClose = await failureOf(net.read(c.id));
  out.closeTwice = await failureOf(net.close(c.id));
  // At most 16 connections at once.
  const ids = [];
  for (let i = 0; i < 16; i++) ids.push((await net.open({ host: HOST, port, timeoutMs: 10000 })).id);
  out.opened16 = ids.length;
  out.seventeenth = await failureOf(net.open({ host: HOST, port, timeoutMs: 10000 }));
  for (const id of ids) await net.close(id);
  const again = await net.open({ host: HOST, port, timeoutMs: 10000 });
  out.afterClosingAll = again.route;
  await net.close(again.id);
  // Server that accepts TCP and never answers TLS.
  t = Date.now();
  out.silent = await failureOf(net.open({ host: HOST, port: CONFIG.ports.silent, timeoutMs: 1500 }));
  out.silentMs = Date.now() - t;
  // Nobody listening.
  out.refusedPort = await failureOf(net.open({ host: HOST, port: CONFIG.ports.closed, timeoutMs: 5000 }));
  return out;
}

/**
 * A server that never reads: 1 MiB writes until one stays pending (the
 * buffers are full). Then a second write at the same time is refused, and
 * close() ends the pending one.
 */
async function caseWrites() {
  const out = { name: "writes", written: 0 };
  const c = await net.open({ host: HOST, port: CONFIG.ports.sink, timeoutMs: 10000 });
  out.verdict = evaluateTls(c.securityInfo, { pins: [CONFIG.caSha256] }).reason;
  let pending = null;
  for (let i = 0; i < 64; i++) {
    const w = net.write(c.id, new Uint8Array(1048576));
    const state = await Promise.race([
      w.then(
        () => "done",
        (e) => `error ${e.message}`,
      ),
      sleep(1000).then(() => "pending"),
    ]);
    if (state === "pending") {
      pending = w;
      break;
    }
    if (state !== "done") {
      out.error = state;
      break;
    }
    out.written++;
  }
  out.blocked = pending !== null;
  out.concurrent = await failureOf(net.write(c.id, new Uint8Array(1)));
  await net.close(c.id);
  out.pendingAfterClose = pending ? await failureOf(pending) : null;
  return out;
}

/** A host permission granted at run time, then removed while a connection is open. */
async function caseRevoke() {
  const out = { name: "revoke" };
  const port = CONFIG.ports.revoke;
  const target = { host: "127.0.0.1", port, timeoutMs: 10000 };
  out.beforeGrant = await failureOf(net.open(target));
  await helper.grantOrigin("https://127.0.0.1/*");
  const c = await net.open(target);
  out.verdict = evaluateTls(c.securityInfo, { pins: [CONFIG.caSha256] }).reason;
  out.readWhileAllowed = await failureOf(net.read(c.id, { timeoutMs: 200 }));
  out.removed = await browser.permissions.remove({ origins: ["https://127.0.0.1/*"] });
  out.writeAfterRevoke = await failureOf(net.write(c.id, request(port, "revoked", { host: "127.0.0.1" })));
  out.readAfterRevoke = await failureOf(net.read(c.id, { timeoutMs: 200 }));
  out.openAfterRevoke = await failureOf(net.open(target));
  return out;
}

/**
 * A server asking for a client certificate. sync443Net never sends one, never
 * asks the user (headless: a prompt would hang), with a certificate in the
 * profile and Thunderbird set to pick one automatically. Control: Thunderbird's
 * own HTTP stack (fetch) does send it.
 */
async function caseClientCert() {
  const out = { name: "client-cert" };
  const port = CONFIG.ports.clientAuth;
  if (CONFIG.clientP12) out.imported = await helper.importPkcs12(CONFIG.clientP12, CONFIG.clientP12Password);
  out.ask = await exchange("clientcert-ask", port);
  await helper.setPrefs({ "security.default_personal_cert": "Select Automatically" });
  out.auto = await exchange("clientcert-auto", port);
  if (CONFIG.clientP12) {
    try {
      const response = await fetch(`https://${HOST}:${port}/test/fetch-control`, { credentials: "include", cache: "no-store" });
      out.fetchStatus = response.status;
      await response.text();
    } catch (e) {
      out.fetchError = String(e?.message ?? e);
    }
  }
  await helper.setPrefs({ "security.default_personal_cert": "Ask Every Time" });
  return out;
}

async function caseBig() {
  const port = CONFIG.ports.big;
  const out = { name: "big" };
  const c = await net.open({ host: HOST, port, timeoutMs: 10000 });
  const verdict = evaluateTls(c.securityInfo, { pins: [CONFIG.caSha256] });
  if (!verdict.ok) {
    await net.close(c.id);
    out.error = verdict.reason;
    return out;
  }
  await net.write(c.id, ascii(`GET /big HTTP/1.1\r\nHost: ${HOST}:${port}\r\n${AUTH}\r\nConnection: close\r\n\r\n`));
  await sleep(2500); // the extension does not read: Gecko must stop reading from the network
  out.readStartedAt = Date.now();
  let total = 0;
  let maxChunk = 0;
  let chunks = 0;
  let bodyAt = -1;
  let head = "";
  let patternOk = true;
  for (;;) {
    const chunk = await net.read(c.id, { maxBytes: 1048576, timeoutMs: 10000 });
    if (chunk === null) break;
    chunks++;
    maxChunk = Math.max(maxChunk, chunk.length);
    let i = 0;
    if (bodyAt < 0) {
      head += latin1(chunk.subarray(0, 4096));
      const end = head.indexOf("\r\n\r\n");
      if (end >= 0) {
        bodyAt = total + end + 4;
        i = bodyAt - total;
      } else {
        i = chunk.length;
      }
    }
    for (; i < chunk.length; i++) {
      if (chunk[i] !== (total + i - bodyAt) % 256) {
        patternOk = false;
        break;
      }
    }
    total += chunk.length;
  }
  await net.close(c.id);
  Object.assign(out, { total, bodyBytes: total - bodyAt, maxChunk, chunks, patternOk, readEndedAt: Date.now() });
  return out;
}

async function caseViewType() {
  const out = { name: "view-type" };
  const answer = new Promise((resolve) => {
    browser.runtime.onMessage.addListener((message) => {
      if (message?.viewTest) resolve(message.viewTest);
    });
  });
  try {
    const tab = await browser.tabs.create({ url: `page.html?port=${CONFIG.ports.okDirect}` });
    out.tabCreated = true;
    out.page = await Promise.race([answer, sleep(8000).then(() => null)]);
    await browser.tabs.remove(tab.id).catch(() => {});
  } catch (e) {
    out.tabError = String(e?.message ?? e);
  }
  return out;
}

async function run() {
  CONFIG = await (await fetch(browser.runtime.getURL("test-config.json"))).json();
  const p = CONFIG.ports;
  const trusted = await helper.trustAuthority(CONFIG.caBase64);
  await print("SETUP", { trustedAuthority: trusted, probe: await helper.probe() });

  const cases = [];
  const step = async (fn) => {
    let result;
    try {
      result = await fn();
    } catch (e) {
      result = { name: fn.name || "?", crashed: String(e?.message ?? e) };
    }
    cases.push(result.name);
    await print("CASE", result);
  };

  await helper.setProxy("direct");
  await step(caseArguments);
  await step(() => exchange("direct-ok", p.okDirect));
  await step(() => exchange("direct-ok-again", p.okDirect, { form: "view" }));
  await step(() => exchange("direct-refused", p.refuseDirect, { pin: false }));
  await step(() => exchange("direct-mismatch", p.mismatchDirect));
  await step(() => exchange("direct-untrusted", p.untrustedDirect));
  await helper.addException(HOST, p.exceptionDirect, CONFIG.wrongNameBase64);
  await step(() => exchange("direct-exception", p.exceptionDirect));
  await step(() => exchange("tls13-ok", p.tls13, { get: true }));
  await step(() => exchange("tls13-refused", p.tls13, { pin: false }));
  await step(() => exchange("ipv6-ok", p.ipv6, { host: "[::1]" }));
  await step(caseMisc);
  await step(caseWrites);
  await step(caseRevoke);
  await step(caseClientCert);
  await helper.setPrefs({ "security.tls.version.min": 1, "security.tls.version.enable-deprecated": true });
  await step(() => exchange("weak-tls10", p.weak));
  await helper.setPrefs({ "security.tls.version.min": 3, "security.tls.version.enable-deprecated": false });
  await step(caseBig);

  await helper.setProxy("http", CONFIG.httpProxyPort);
  await step(() => exchange("proxy-ok", p.okProxy, { form: "buffer" }));
  await step(() => exchange("ipv6-proxy-ok", p.ipv6Proxy, { host: "[::1]" }));
  await step(() => exchange("proxy-refused", p.refuseProxy, { pin: false }));
  await step(() => exchange("proxy-mismatch", p.mismatchProxy));
  await step(() => exchange("proxy-auth", p.proxyAuth));
  await step(() => exchange("proxy-deny", p.proxyDeny));
  await step(() => exchange("proxy-junk", p.proxyJunk));
  await helper.setProxy("http", CONFIG.ports.closed);
  await step(() => exchange("proxy-down", p.okProxy));

  await helper.setProxy("socks", CONFIG.socksProxyPort);
  await step(() => exchange("socks-ok", p.okSocks));
  await step(() => exchange("socks-refused", p.refuseSocks, { pin: false }));
  await step(() => exchange("socks-mismatch", p.mismatchSocks));

  await helper.setProxy("direct");
  await step(caseViewType);

  await print("CASES", cases);

  // A connection left open: disabling the extension must close it.
  const hold = await net.open({ host: HOST, port: p.hold, timeoutMs: 10000 });
  await print("HOLD", { route: hold.route, openedAt: Date.now() });
  await helper.shutdownSoon();
}

run().catch(async (e) => {
  await print("CRASH", { error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  await helper.quit();
});
