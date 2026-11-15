// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Regression tests for the security audit of the HTTP/1.1 layer and the
 * ActiveSync client on verified connections: one test per finding.
 */

import { test, eq, assert, throws, rejects } from "./harness.mjs";
import { EasClient, EasError, ERR } from "../../src/transport/client.mjs";
import { serializeRequest, ResponseParser } from "../../src/core/http1.mjs";
import { el, encode } from "../../src/core/wbxml.mjs";
import { encodeUtf8, decodeUtf8 } from "../../src/core/utf8.mjs";

const SERVER = { host: "mail.example.com", port: null, origin: "https://mail.example.com", url: "https://mail.example.com/Microsoft-Server-ActiveSync" };
const PUBLIC = {
  state: "secure",
  certificates: [
    { subject: "CN=mail.example.com", issuer: "CN=R", fingerprint: { sha256: "11".repeat(32) } },
    { subject: "CN=R", issuer: "CN=R", fingerprint: { sha256: "22".repeat(32) }, isBuiltInRoot: true },
  ],
};
const KNOWN = { asVersion: "14.1" };
const fs0 = () => el("FolderHierarchy:FolderSync", [el("SyncKey", "0")]);

/** Connector double: `answer` is the raw response (string or bytes), or a function of the request text. */
function connector({ answer = "", open, write, readError, after } = {}) {
  const ops = [];
  let pending = null;
  return {
    ops,
    async open(options) {
      ops.push(["open", options]);
      if (open) return open(options);
      return { id: "c1", route: "direct", securityInfo: PUBLIC };
    },
    async write(id, bytes) {
      ops.push(["write", decodeUtf8(bytes)]);
      if (write) return write(id, bytes);
      const a = typeof answer === "function" ? answer(decodeUtf8(bytes)) : answer;
      pending = typeof a === "string" ? encodeUtf8(a) : a;
    },
    async read(id, options) {
      ops.push(["read", options]);
      if (readError) throw new Error(readError);
      const chunk = pending;
      pending = null;
      after?.();
      return chunk && chunk.length ? chunk : null;
    },
    async close(id) {
      ops.push(["close", id]);
    },
  };
}

const client = (c, extra = {}) =>
  new EasClient({ server: SERVER, username: "u@example.com", password: "secret", deviceId: "S443TEST", connector: c, proto: KNOWN, ...extra });
const kinds = (c) => c.ops.map((o) => o[0]);

test("audit http V1 : une réponse coupée après l'en-tête ne passe plus pour un succès vide", async () => {
  const c = connector({ answer: "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.ms-sync.wbxml\r\n\r\n" });
  await rejects(() => client(c).command("SendMail", el("ComposeMail:SendMail", [el("ClientId", "1"), el("Mime", new Uint8Array([65]))])), (e) => e.code === ERR.BAD_RESPONSE);
  const req = decodeUtf8(serializeRequest({ method: "POST", host: "h.example", path: "/", headers: [], body: new Uint8Array(1) }));
  assert(!/connection:/i.test(req), "aucun Connection: close, le serveur doit annoncer la longueur");
});

test("audit http V2 : une erreur après l'envoi le dit (sent), et n'est plus « certificat refusé »", async () => {
  const c = connector({ answer: "x", readError: "TLS: SSL_ERROR_BAD_MAC_READ" });
  const e = await rejects(() => client(c).command("FolderSync", fs0()), EasError);
  eq([e.code, e.sent], [ERR.NETWORK, true]);
  const refused = connector({ open: () => ({ id: "c2", route: "direct", securityInfo: { state: "insecure" } }) });
  const e2 = await rejects(() => client(refused).command("FolderSync", fs0()), EasError);
  eq([e2.code, Boolean(e2.sent)], [ERR.TLS, false]);
  eq(kinds(refused), ["open", "close"]);
});

test("audit http V3 : l'envoi est borné par le délai de l'échange", async () => {
  let fire = null;
  const timers = { set: (f) => ((fire = f), 1), clear: () => {} };
  let rejectWrite;
  const c = connector({ write: () => new Promise((_, reject) => (rejectWrite = reject)) });
  const origClose = c.close;
  c.close = async (id) => {
    await origClose(id);
    rejectWrite?.(new Error("CLOSED: fermée"));
  };
  const p = client(c, { timers }).command("FolderSync", fs0());
  for (let i = 0; i < 20 && !fire; i++) await Promise.resolve();
  assert(fire, "minuterie posée pour l'envoi");
  fire();
  const e = await rejects(() => p, EasError);
  eq(e.code, ERR.TIMEOUT);
});

test("audit http V4 : délais entiers, délai trop court refusé avant toute connexion", async () => {
  const c = connector({ answer: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n" });
  let t = 1000.25;
  await client(c, { now: () => (t += 0.5) }).command("FolderSync", fs0());
  const open = c.ops.find((o) => o[0] === "open")[1];
  const read = c.ops.find((o) => o[0] === "read")[1];
  assert(Number.isInteger(open.timeoutMs) && open.timeoutMs >= 1000, `ouverture : ${open.timeoutMs}`);
  assert(Number.isInteger(read.timeoutMs), `lecture : ${read.timeoutMs}`);
  const short = connector();
  await rejects(() => client(short).command("FolderSync", fs0(), { timeoutMs: 800 }), (e) => e.code === ERR.CONFIG);
  eq(short.ops.length, 0, "aucune connexion ouverte");
});

test("audit http V5 : destination et confiance figées après construction", () => {
  const c = client(connector(), { pins: ["22".repeat(32)] });
  eq(c.pins, undefined, "empreintes non exposées");
  eq(c.connector, undefined, "connecteur non exposé");
  assert(Object.isFrozen(c.server), "serveur figé");
  throws(() => {
    c.server.host = "evil.example.net";
  }, TypeError);
});

test("audit http H2 : entrées locales invalides refusées à la construction", () => {
  const isConfig = (e) => e instanceof EasError && e.code === ERR.CONFIG;
  throws(() => client(connector(), { username: `u${String.fromCharCode(0xd800)}@example.com` }), isConfig, "surrogat isolé");
  throws(() => client(connector(), { username: `${"u".repeat(300)}@example.com` }), isConfig, "identifiant trop long");
  throws(() => client(connector(), { userAgent: `Sync443${String.fromCharCode(0xe9)}` }), isConfig, "User-Agent non ASCII");
  throws(() => client(connector(), { deviceType: "Sync443\r\nX: y" }), isConfig, "type d'appareil");
});

test("audit http H4 : connexion mal formée ou fermeture qui lève : erreur propre", async () => {
  const nullConn = connector({ open: () => null });
  const e = await rejects(() => client(nullConn).command("FolderSync", fs0()), EasError);
  eq(e.code, ERR.NETWORK);
  const c = connector({ answer: "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n" });
  c.close = () => {
    throw new Error("boom");
  };
  const e2 = await rejects(() => client(c).command("FolderSync", fs0()), EasError);
  eq(e2.code, ERR.AUTH, "le vrai résultat n'est pas masqué");
});

test("audit http H5 : une annulation arrivée après la dernière lecture est respectée", async () => {
  const ctl = new AbortController();
  const ok = encode(el("FolderHierarchy:FolderSync", [el("Status", "1"), el("SyncKey", "1")]));
  const head = encodeUtf8(`HTTP/1.1 200 OK\r\nContent-Length: ${ok.length}\r\n\r\n`);
  const whole = new Uint8Array(head.length + ok.length);
  whole.set(head);
  whole.set(ok, head.length);
  const c = connector({ answer: whole, after: () => ctl.abort() });
  const e = await rejects(() => client(c).command("FolderSync", fs0(), { signal: ctl.signal }), EasError);
  eq(e.code, ERR.CANCELLED);
});

test("audit http H7 : ligne d'état sans libellé tolérée", () => {
  const p = new ResponseParser({ method: "POST" });
  p.push(encodeUtf8("HTTP/1.1 200\r\nContent-Length: 0\r\n\r\n"));
  eq([p.done, p.response.status, p.response.reason], [true, 200, ""]);
});

test("audit module A1 : gros envoi découpé en morceaux d'1 Mio, un seul à la fois", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const sizes = [];
  const pieces = [];
  const c = connector({
    write: async (id, bytes) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      sizes.push(bytes.length);
      pieces.push(bytes.slice());
      await Promise.resolve();
      inFlight--;
    },
  });
  // Answer once the whole request has been written.
  c.read = async () => {
    c.read = async () => null;
    return encodeUtf8("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
  };
  const mime = new Uint8Array(3.5 * 1024 * 1024).fill(65);
  eq(await client(c).command("SendMail", el("ComposeMail:SendMail", [el("ClientId", "1"), el("Mime", mime)])), null);
  eq(maxInFlight, 1, "une seule écriture à la fois");
  assert(sizes.length === 4 && sizes.every((n) => n <= 1024 * 1024), `morceaux : ${sizes}`);
  const total = pieces.reduce((n, p) => n + p.length, 0);
  assert(total > mime.length, "toute la requête a été écrite");
});
