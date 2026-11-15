// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * EasClient tests ([MS-ASHTTP], [MS-ASPROV], RFC 9112) over a fake
 * verified-connection module that follows the contract documented in
 * src/experiments/sync443Net/implementation.js:
 *   open({host, port, timeoutMs}) → {id, route, securityInfo}, timeoutMs an
 *     integer in [1000, 300000];
 *   write(id, bytes); read(id, {maxBytes, timeoutMs}) → bytes, or null at the
 *     end of the stream, maxBytes in [1, 1 MiB], timeoutMs in [1, 600000];
 *     a read that times out throws "TIMEOUT: …" and leaves the connection open;
 *   close(id); every error is an Error "CODE: reason".
 * Every call is recorded in order. Responses are raw HTTP/1.1 bytes, split at
 * random across reads (fixed seeds). Credentials are the example of RFC 7617
 * section 2, so the expected Authorization value is public.
 * Unusual characters are written as \u escapes, never literally.
 */

import { test, assert, eq, throws, rejects, prng } from "./harness.mjs";
import { EasClient, EasError, ERR, FATAL, DEFAULTS, retryAfter } from "../../src/transport/client.mjs";
import { serializeRequest } from "../../src/core/http1.mjs";
import { el, encode, decode, text, at, child } from "../../src/core/wbxml.mjs";
import { encodeUtf8 } from "../../src/core/utf8.mjs";
import { parseServer } from "../../src/core/server.mjs";
import { folderSyncRequest, syncRequest, changeCommand, pingRequest } from "../../src/core/protocol.mjs";

const USER = "Aladdin";
const PASSWORD = "open sesame";
const CREDENTIALS = "QWxhZGRpbjpvcGVuIHNlc2FtZQ==";
const AUTH = `Basic ${CREDENTIALS}`;
const SERVER = parseServer("mail.example.com");
const DEVICE = "SYNC443TEST01";
const PATH = "/Microsoft-Server-ActiveSync";
const MIB = 1024 * 1024;

// ── Bytes ─────────────────────────────────────────────────────────────────

const latin1 = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const toBytes = (x) => (typeof x === "string" ? encodeUtf8(x) : x);

/** A raw HTTP/1.1 response. framing: "length" (Content-Length), "chunked", or "close" (end of stream). */
function http(status, { reason = "OK", headers = [], body = null, framing = "length" } = {}) {
  const bytes = body === null ? new Uint8Array(0) : toBytes(body);
  let head = `HTTP/1.1 ${status} ${reason}\r\n`;
  for (const [k, v] of headers) head += `${k}: ${v}\r\n`;
  let payload = bytes;
  if (framing === "length") {
    head += `Content-Length: ${bytes.length}\r\n`;
  } else if (framing === "chunked") {
    head += "Transfer-Encoding: chunked\r\n";
    const parts = [];
    for (let i = 0; i < bytes.length; i += 100) {
      const piece = bytes.subarray(i, i + 100);
      parts.push(encodeUtf8(`${piece.length.toString(16)}\r\n`), piece, encodeUtf8("\r\n"));
    }
    parts.push(encodeUtf8("0\r\n\r\n"));
    payload = concat(parts);
  }
  return concat([encodeUtf8(`${head}\r\n`), payload]);
}
const WBXML_TYPE = ["Content-Type", "application/vnd.ms-sync.wbxml"];
const wbxmlHttp = (tree, options = {}) => http(200, { ...options, headers: [WBXML_TYPE, ...(options.headers ?? [])], body: encode(tree) });

/** The request as the server reads it from the written bytes. */
function parseRequest(bytes) {
  let end = -1;
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("NETWORK: requête incomplète");
  const head = latin1(bytes.subarray(0, end));
  const [requestLine, ...lines] = head.split("\r\n");
  const [method, target, version] = requestLine.split(" ");
  const headers = new Map();
  for (const line of lines) {
    const i = line.indexOf(":");
    headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
  }
  const q = target.indexOf("?");
  const query = new Map();
  if (q >= 0) {
    for (const part of target.slice(q + 1).split("&")) {
      const i = part.indexOf("=");
      query.set(part.slice(0, i), decodeURIComponent(part.slice(i + 1)));
    }
  }
  const body = bytes.slice(end + 4);
  return { method, target, version, path: q >= 0 ? target.slice(0, q) : target, query, headers, body, head, cmd: query.get("Cmd") ?? null, doc: body.length ? decode(body) : null };
}

// ── Certificates ──────────────────────────────────────────────────────────

const FP = {
  leaf: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
  inter: "11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF",
  root: "01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F:20",
};
const PIN = Object.fromEntries(Object.entries(FP).map(([k, v]) => [k, v.replace(/:/g, "")]));
const cert = (name, issuer, fp, builtIn = false) => ({ subject: `CN=${name}`, issuer: `CN=${issuer}`, fingerprint: { sha256: fp }, isBuiltInRoot: builtIn });

/** securityInfo as the connector gives it (shaped like webRequest.getSecurityInfo). */
function tlsInfo({ state = "secure", builtIn = true, certificates, ...flags } = {}) {
  return {
    state,
    protocolVersion: "TLSv1.3",
    isUntrusted: false,
    isDomainMismatch: false,
    isNotValidAtThisTime: false,
    certificates: certificates ?? [
      cert("mail.example.com", "Example CA", FP.leaf),
      cert("Example CA", "Example Root", FP.inter),
      cert("Example Root", "Example Root", FP.root, builtIn),
    ],
    ...flags,
  };
}
const PUBLIC = tlsInfo();
const PRIVATE = tlsInfo({ builtIn: false });

/** Every refusal of tls-policy.mjs, as [expected reason, securityInfo]. */
const REFUSALS = [
  ["insecure", tlsInfo({ state: "insecure", certificates: [] })],
  ["insecure", tlsInfo({ state: "weak" })],
  ["insecure", tlsInfo({ state: "broken", certificates: [] })],
  ["insecure", null],
  ["untrusted", tlsInfo({ isUntrusted: true, overridableErrorCategory: "trust_error" })],
  ["domain-mismatch", tlsInfo({ isDomainMismatch: true, overridableErrorCategory: "domain_mismatch" })],
  ["expired", tlsInfo({ isNotValidAtThisTime: true, overridableErrorCategory: "expired_or_not_yet_valid" })],
  ["exception", tlsInfo({ overridableErrorCategory: "trust_error" })],
  ["no-certificate", tlsInfo({ certificates: [] })],
  ["not-public-root", PRIVATE],
  ["not-public-root", tlsInfo({ certificates: [cert("x", "Proxy CA", FP.leaf, true), cert("Proxy CA", "Proxy CA", FP.root, false)] })],
];

// ── Fake connector and clock ──────────────────────────────────────────────

function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const intIn = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const cerr = (code, reason) => new Error(`${code}: ${reason}`);

function splitBytes(bytes, mode, rnd) {
  if (mode === "one") return bytes.length ? [bytes] : [];
  if (mode === "bytes") return Array.from(bytes, (b) => Uint8Array.of(b));
  const out = [];
  for (let i = 0; i < bytes.length; ) {
    const k = 1 + Math.floor(rnd() * (rnd() < 0.5 ? 8 : 700));
    out.push(bytes.slice(i, i + k));
    i += k;
  }
  return mode === "arrays" ? out.map((c) => Array.from(c)) : out;
}

/**
 * handler(request, ctx) gives the answer of one connection: raw bytes (or a
 * string), or an object { bytes, chunks, split, stepMs, waitMs, hang, error,
 * after, onRead }.
 */
function fakeConnector({ handler, tls = PUBLIC, route = "direct", openError = null, split = "random", seed = 1, clock, hooks = {} } = {}) {
  const rnd = prng(seed);
  const ops = [];
  const conns = new Map();
  const anomalies = [];
  let opened = 0;
  const live = (id) => {
    const c = conns.get(id);
    if (!c || c.closed) throw cerr("CLOSED", "connexion inconnue ou fermée");
    return c;
  };

  function answerFor(c) {
    let request;
    let a;
    try {
      request = parseRequest(concat(c.written));
      a = handler(request, { clock, conn: c });
    } catch (e) {
      anomalies.push(String(e?.message ?? e));
      throw cerr("NETWORK", "erreur du faux serveur");
    }
    if (a instanceof Uint8Array || typeof a === "string") a = { bytes: a };
    a = { ...a, served: 0, waited: 0 };
    const bytes = a.bytes === undefined ? null : toBytes(a.bytes);
    a.queue = a.chunks ? [...a.chunks] : bytes === null ? [] : a.stepMs ? splitBytes(bytes, "bytes") : splitBytes(bytes, a.split ?? split, rnd);
    return a;
  }

  async function serve(c, timeoutMs) {
    const a = c.answer;
    a.onRead?.(a.served, c);
    if (c.closed) throw cerr("CLOSED", "connexion fermée");
    if (a.hang) {
      return new Promise((_, reject) => {
        let settled = false;
        const end = (by, error) => {
          if (settled) return;
          settled = true;
          a.endedBy = by;
          reject(error);
        };
        c.closeWaiters.push(() => end("close", cerr("CLOSED", "connexion fermée")));
        // Test guard: a read nobody closes fails after 1 s instead of stalling the whole run.
        setTimeout(() => end("garde", cerr("TIMEOUT", "garde du test : lecture jamais interrompue")), 1000);
      });
    }
    if (a.waitMs && a.waited < a.waitMs) {
      const left = a.waitMs - a.waited;
      if (left > timeoutMs) {
        clock.advance(timeoutMs); // the real module waits, then gives up this read only
        a.waited += timeoutMs;
        throw cerr("TIMEOUT", "pas de réponse du serveur");
      }
      clock.advance(left);
      a.waited = a.waitMs;
    }
    if (a.error !== undefined && a.served >= (a.after ?? 0)) throw new Error(a.error);
    if (a.stepMs) clock.advance(a.stepMs);
    return a.served < a.queue.length ? a.queue[a.served++] : null;
  }

  return {
    ops,
    conns,
    anomalies,
    async open(options) {
      const op = { op: "open", options: { ...options } };
      ops.push(op);
      const index = opened++;
      hooks.beforeOpen?.(index);
      if (hooks.openDelayMs) clock.advance(hooks.openDelayMs);
      const { host, port, timeoutMs } = options ?? {};
      if (typeof host !== "string" || !intIn(port, 1, 65535)) throw cerr("CONFIG", "nom ou port invalide");
      if (!intIn(timeoutMs, 1000, 300000)) throw cerr("CONFIG", "délai invalide");
      const err = typeof openError === "function" ? openError(index) : openError;
      if (err) throw err;
      const id = `c${index + 1}`;
      op.id = id;
      conns.set(id, { id, index, written: [], answer: null, closed: false, closeWaiters: [] });
      return { id, route, securityInfo: typeof tls === "function" ? tls(index) : tls };
    },
    async write(id, bytes) {
      ops.push({ op: "write", id, bytes: Uint8Array.from(bytes) });
      hooks.beforeWrite?.(id);
      const c = live(id);
      if (hooks.writeError) throw new Error(hooks.writeError);
      c.written.push(Uint8Array.from(bytes));
    },
    async read(id, options) {
      ops.push({ op: "read", id, options: { ...options } });
      const { maxBytes, timeoutMs } = options ?? {};
      if (!intIn(maxBytes, 1, MIB)) throw cerr("CONFIG", "taille de lecture invalide");
      if (!intIn(timeoutMs, 1, 600000)) throw cerr("CONFIG", "délai invalide");
      const c = live(id);
      if (!c.written.length) {
        anomalies.push("lecture avant toute écriture");
        throw cerr("NETWORK", "lecture avant toute requête");
      }
      c.answer ??= answerFor(c);
      return serve(c, timeoutMs);
    },
    async close(id) {
      ops.push({ op: "close", id });
      const c = conns.get(id);
      if (c && !c.closed) {
        c.closed = true;
        for (const w of c.closeWaiters) w();
      }
      if (hooks.closeRejects) throw cerr("CLOSED", "déjà fermée");
    },
  };
}

/** Like Exchange: OPTIONS → versions; POST → the handler of its Cmd. */
const VERSIONS = [["MS-ASProtocolVersions", "2.5,12.0,12.1,14.0,14.1"], ["MS-ASProtocolCommands", "Sync,FolderSync,Provision,Ping"]];
function server(handlers = {}) {
  return (req, ctx) => {
    if (req.method === "OPTIONS") return handlers.OPTIONS ? handlers.OPTIONS(req, ctx) : http(200, { headers: VERSIONS });
    const h = handlers[req.cmd];
    if (!h) throw new Error(`commande inattendue ${req.cmd}`);
    return h(req, ctx);
  };
}

function setup({ handlers = {}, tls, route, openError, split, seed, hooks, ...options } = {}) {
  const clock = fakeClock();
  const connector = fakeConnector({ handler: server(handlers), tls, route, openError, split, seed, clock, hooks });
  const saved = [];
  const client = new EasClient({
    server: SERVER, username: USER, password: PASSWORD, deviceId: DEVICE, connector,
    now: clock.now, saveProto: async (p) => saved.push(p),
    ...options,
  });
  return { client, connector, clock, saved };
}

const opsOf = (connector, kind) => connector.ops.filter((o) => o.op === kind);
const requestsOf = (connector) => [...connector.conns.values()].filter((c) => c.written.length).map((c) => parseRequest(concat(c.written)));
const cmdsOf = (connector) => requestsOf(connector).map((r) => r.cmd ?? r.method);
const isCode = (code) => (e) => e instanceof EasError && e.code === code;

/** Every opened connection was closed, and nothing was done on it afterwards. */
function checkClosed(connector, what = "") {
  for (const c of connector.conns.values()) {
    const ops = connector.ops.filter((o) => o.id === c.id);
    const first = ops.findIndex((o) => o.op === "close");
    assert(first >= 0, `${what} : connexion ${c.id} jamais fermée`);
    assert(ops.slice(first).every((o) => o.op === "close"), `${what} : opération sur ${c.id} après sa fermeture`);
  }
  eq(connector.anomalies, [], `${what} : anomalies du faux connecteur`);
}

/** Lets pending promise callbacks (asynchronous close) run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const folderSyncOk = () => wbxmlHttp(el("FolderHierarchy:FolderSync", [el("Status", "1"), el("SyncKey", "1")]));
const withStatus = (s) => wbxmlHttp(el("FolderHierarchy:FolderSync", [el("Status", s)]));
const fs0 = () => folderSyncRequest("0");
const KNOWN = { asVersion: "14.1", policyKey: null };

const TEMP_KEY = "1307199584";
const FINAL_KEY = "2950387131";
const policyResponse = ({ status = "1", policyStatus = "1", key = TEMP_KEY, extra = [] } = {}) =>
  el("Provision:Provision", [
    el("Status", status),
    el("Policies", [el("Policy", [
      el("PolicyType", "MS-EAS-Provisioning-WBXML"),
      el("Status", policyStatus),
      key === null ? null : el("PolicyKey", key),
      el("Data", [el("EASProvisionDoc", [el("DevicePasswordEnabled", "0")])]),
    ])]),
    ...extra,
  ]);
const ackResponse = ({ status = "1", key = FINAL_KEY, extra = [] } = {}) =>
  el("Provision:Provision", [
    el("Status", status),
    el("Policies", [el("Policy", [el("PolicyType", "MS-EAS-Provisioning-WBXML"), el("Status", "1"), key === null ? null : el("PolicyKey", key)])]),
    ...extra,
  ]);
/** Two-step Provision: policy (no PolicyKey in the request), then acknowledgement. */
const provisioning = ({ first = policyResponse(), second = ackResponse() } = {}) => (req) =>
  wbxmlHttp(at(req.doc, "Policies", "Policy", "PolicyKey") ? second : first);

// ── Order of operations, certificate first ────────────────────────────────

test("connexion : open, puis écriture, puis lectures, puis close, pour chaque requête", async () => {
  const { client, connector } = setup({ handlers: { FolderSync: folderSyncOk } });
  eq(text(await client.command("FolderSync", fs0()), "SyncKey"), "1");
  eq(cmdsOf(connector), ["OPTIONS", "FolderSync"]);
  for (const c of connector.conns.values()) {
    const seq = connector.ops.filter((o) => o.id === c.id).map((o) => o.op).join(" ");
    assert(/^open( write)+( read)+ close$/.test(seq), `séquence ${c.id} : ${seq}`);
  }
  const firstWrite = connector.ops.findIndex((o) => o.op === "write");
  assert(firstWrite > connector.ops.findIndex((o) => o.op === "open"), "écriture avant open");
  eq(opsOf(connector, "open").map((o) => o.options), [
    { host: "mail.example.com", port: 443, timeoutMs: 30_000 },
    { host: "mail.example.com", port: 443, timeoutMs: 30_000 },
  ]);
  for (const r of opsOf(connector, "read")) assert(r.options.maxBytes === MIB, "lecture de 1 Mio au plus");
  checkClosed(connector);
});

test("TLS : chaque motif de refus → aucune écriture, close, code TLS non fatal", async () => {
  for (const [reason, info] of REFUSALS) {
    for (const proto of [undefined, KNOWN]) {
      const what = `${reason} ${JSON.stringify(info?.state)} ${proto ? "(POST)" : "(OPTIONS)"}`;
      const { client, connector } = setup({ tls: () => info, proto, handlers: { FolderSync: folderSyncOk } });
      const e = await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.TLS), what);
      eq(e.reason, reason, what);
      eq(e.route, "direct", what);
      eq(connector.ops.map((o) => o.op), ["open", "close"], what);
      assert(!FATAL.has(e.code), "TLS n'est pas fatal : rien n'a été envoyé");
      assert(e.message.startsWith("Connexion refusée"), e.message);
      assert(!/envoy[ée]|transmis|refusé par le serveur|mot de passe refusé/i.test(e.message), `le message laisse croire à un envoi : ${e.message}`);
      checkClosed(connector, what);
    }
  }
});

test("TLS : une empreinte de confiance ne couvre aucun autre défaut du certificat", async () => {
  for (const [reason, info] of REFUSALS.filter(([r]) => r !== "not-public-root" && r !== "no-certificate")) {
    const { client, connector } = setup({ tls: () => info, pins: [PIN.leaf, PIN.root], proto: KNOWN });
    const e = await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.TLS), reason);
    eq([e.reason, opsOf(connector, "write").length], [reason, 0], reason);
  }
});

test("TLS : empreinte du certificat du serveur ou de la racine → requête écrite ; intermédiaire → refus", async () => {
  for (const pin of [PIN.leaf, PIN.root]) {
    const { client, connector } = setup({ tls: PRIVATE, pins: [pin], proto: KNOWN, handlers: { FolderSync: folderSyncOk } });
    eq(text(await client.command("FolderSync", fs0()), "Status"), "1");
    eq(opsOf(connector, "write").length > 0, true, `écriture avec l'empreinte ${pin.slice(0, 8)}`);
  }
  const { client, connector } = setup({ tls: PRIVATE, pins: [PIN.inter], proto: KNOWN, handlers: { FolderSync: folderSyncOk } });
  const e = await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.TLS));
  eq([e.reason, opsOf(connector, "write").length], ["not-public-root", 0]);
  checkClosed(connector);
});

test("TLS : message du refus avec l'émetteur nettoyé", async () => {
  const issuer = "Proxy\u202e SA\u0007\r\nfaites confiance";
  const info = tlsInfo({ builtIn: false, certificates: [cert("mail.example.com", issuer, FP.leaf), cert(issuer, issuer, FP.root)] });
  const { client } = setup({ tls: info, proto: KNOWN });
  const e = await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.TLS));
  assert(!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(e.message), JSON.stringify(e.message));
  assert(e.message.includes("Proxy SA"), e.message);
});

test("Authorization seulement dans les octets écrits sur une connexion acceptée", async () => {
  const { client, connector } = setup({
    tls: (i) => (i === 0 ? PRIVATE : PUBLIC),
    handlers: { FolderSync: folderSyncOk, Provision: provisioning() },
  });
  await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.TLS));
  await client.command("FolderSync", fs0());
  await client.provision();
  eq(connector.ops.filter((o) => o.id === "c1").map((o) => o.op), ["open", "close"], "connexion refusée");
  const writes = opsOf(connector, "write");
  eq(new Set(writes.map((w) => w.id)).size, 4, "OPTIONS, FolderSync, Provision ×2");
  for (const w of writes) {
    const s = latin1(w.bytes);
    eq(s.split(`\r\nAuthorization: ${AUTH}\r\n`).length, 2, `${w.id} : une seule fois, dans l'en-tête`);
  }
  for (const o of connector.ops.filter((x) => x.op !== "write")) {
    const s = JSON.stringify(o);
    assert(!s.includes(CREDENTIALS) && !s.includes(PASSWORD), `secret dans ${o.op}`);
  }
  checkClosed(connector);
});

test("requête POST : exactement les octets de serializeRequest (port non standard, clé de règles)", async () => {
  const srv = parseServer("mail.example.com:8443");
  const { client, connector } = setup({ server: srv, proto: { asVersion: "14.1", policyKey: "3942919513" }, handlers: { FolderSync: folderSyncOk } });
  await client.command("FolderSync", fs0());
  eq(opsOf(connector, "open")[0].options, { host: "mail.example.com", port: 8443, timeoutMs: 30_000 });
  const written = concat(opsOf(connector, "write").map((w) => w.bytes));
  const body = encode(fs0());
  const expected = serializeRequest({
    method: "POST",
    host: "mail.example.com:8443",
    path: `${PATH}?Cmd=FolderSync&User=Aladdin&DeviceId=${DEVICE}&DeviceType=Sync443`,
    headers: [["User-Agent", "Sync443/1.0"], ["Authorization", AUTH], WBXML_TYPE, ["MS-ASProtocolVersion", "14.1"], ["X-MS-PolicyKey", "3942919513"]],
    body,
  });
  eq(written, expected);
  // The same, read independently of serializeRequest.
  eq(latin1(written.subarray(0, written.length - body.length)),
    `POST ${PATH}?Cmd=FolderSync&User=Aladdin&DeviceId=${DEVICE}&DeviceType=Sync443 HTTP/1.1\r\n` +
    "Host: mail.example.com:8443\r\nUser-Agent: Sync443/1.0\r\n" +
    `Authorization: ${AUTH}\r\n` +
    "Content-Type: application/vnd.ms-sync.wbxml\r\nMS-ASProtocolVersion: 14.1\r\nX-MS-PolicyKey: 3942919513\r\n" +
    `Content-Length: ${body.length}\r\nAccept-Encoding: identity\r\n\r\n`);
  eq(written.subarray(written.length - body.length), body);
});

test("requête POST : Host sans port pour 443, sans X-MS-PolicyKey sans clé, IPv6", async () => {
  const a = setup({ server: parseServer("mail.example.com:443"), proto: KNOWN, handlers: { FolderSync: folderSyncOk } });
  await a.client.command("FolderSync", fs0());
  const ra = requestsOf(a.connector)[0];
  eq([ra.headers.get("host"), ra.headers.has("x-ms-policykey"), opsOf(a.connector, "open")[0].options.port], ["mail.example.com", false, 443]);
  const b = setup({ server: parseServer("[2001:db8::1]:8443"), proto: KNOWN, handlers: { FolderSync: folderSyncOk } });
  await b.client.command("FolderSync", fs0());
  eq(requestsOf(b.connector)[0].headers.get("host"), "[2001:db8::1]:8443");
  eq(opsOf(b.connector, "open")[0].options, { host: "[2001:db8::1]", port: 8443, timeoutMs: 30_000 });
});

test("requête POST : Cmd, User, DeviceId, DeviceType encodés dans le chemin", async () => {
  const { client, connector } = setup({ username: "DOMAINE\\jean dupont+x&y=z#é?", proto: KNOWN, handlers: { FolderSync: folderSyncOk } });
  await client.command("FolderSync", fs0());
  const r = requestsOf(connector)[0];
  eq(r.target, `${PATH}?Cmd=FolderSync&User=DOMAINE%5Cjean%20dupont%2Bx%26y%3Dz%23%C3%A9%3F&DeviceId=${DEVICE}&DeviceType=Sync443`);
  eq([...r.query.keys()], ["Cmd", "User", "DeviceId", "DeviceType"]);
  eq(r.query.get("User"), "DOMAINE\\jean dupont+x&y=z#é?");
  const custom = setup({ deviceType: "Sync 443", proto: KNOWN, handlers: { FolderSync: folderSyncOk } });
  await custom.client.command("FolderSync", fs0());
  eq(requestsOf(custom.connector)[0].query.get("DeviceType"), "Sync 443");
});

test("OPTIONS : même connexion vérifiée, requête exacte, Authorization comprise", async () => {
  const { client, connector } = setup();
  eq(await client.options(), { versions: ["2.5", "12.0", "12.1", "14.0", "14.1"], commands: ["Sync", "FolderSync", "Provision", "Ping"] });
  eq(latin1(opsOf(connector, "write")[0].bytes),
    `OPTIONS ${PATH} HTTP/1.1\r\nHost: mail.example.com\r\nUser-Agent: Sync443/1.0\r\nAuthorization: ${AUTH}\r\nAccept-Encoding: identity\r\n\r\n`);
  const refused = setup({ tls: PRIVATE });
  await rejects(() => refused.client.options(), isCode(ERR.TLS));
  eq(opsOf(refused.connector, "write").length, 0);
});

// ── close() always ────────────────────────────────────────────────────────

test("close appelé dans tous les cas (succès, erreurs HTTP, TLS, délai, annulation, erreur du connecteur)", async () => {
  const outer = new AbortController();
  const scenarios = [
    ["succès", { FolderSync: folderSyncOk }, null, {}],
    ["HTTP 500", { FolderSync: () => http(500, { reason: "Erreur" }) }, ERR.HTTP, {}],
    ["HTTP 401", { FolderSync: () => http(401) }, ERR.AUTH, {}],
    ["HTTP mal formé", { FolderSync: () => "HTTP/1.1 200 OK\nContent-Length: 0\n\n" }, ERR.BAD_RESPONSE, {}],
    ["corps non WBXML", { FolderSync: () => http(200, { body: "<html></html>" }) }, ERR.BAD_RESPONSE, {}],
    ["trop volumineux", { FolderSync: () => http(200, { body: "x".repeat(5000) }) }, ERR.TOO_LARGE, { opts: { maxBytes: 1000 } }],
    ["refus TLS", { FolderSync: folderSyncOk }, ERR.TLS, { tls: PRIVATE }],
    ["délai", { FolderSync: () => ({ bytes: http(200), stepMs: 4000 }) }, ERR.TIMEOUT, { opts: { timeoutMs: 10_000 } }],
    ["annulation", { FolderSync: () => ({ bytes: http(200), hang: true, onRead: () => outer.abort() }) }, ERR.CANCELLED, { opts: { signal: outer.signal } }],
    ["erreur du connecteur en lecture", { FolderSync: () => ({ bytes: http(200, { body: "x".repeat(100) }), split: "bytes", error: "NETWORK: connexion réinitialisée", after: 20 }) }, ERR.NETWORK, {}],
    ["erreur du connecteur en écriture", { FolderSync: folderSyncOk }, ERR.NETWORK, { hooks: { writeError: "NETWORK: tube cassé" } }],
    ["réponse tronquée", { FolderSync: () => http(200, { body: "x".repeat(100) }).subarray(0, 60) }, ERR.BAD_RESPONSE, {}],
  ];
  for (const [what, handlers, code, { opts = {}, ...more }] of scenarios) {
    const { client, connector } = setup({ handlers, proto: KNOWN, ...more });
    if (code) await rejects(() => client.command("FolderSync", fs0(), opts), isCode(code), what);
    else await client.command("FolderSync", fs0(), opts);
    assert(opsOf(connector, "close").length >= 1, `${what} : close jamais appelé`);
    checkClosed(connector, what);
  }
});

test("close qui échoue (connexion déjà fermée) : le résultat ne change pas", async () => {
  const { client, connector } = setup({ proto: KNOWN, hooks: { closeRejects: true }, handlers: { FolderSync: folderSyncOk } });
  eq(text(await client.command("FolderSync", fs0()), "SyncKey"), "1");
  await settle();
  const b = setup({ proto: KNOWN, hooks: { closeRejects: true }, handlers: { FolderSync: () => http(403) } });
  await rejects(() => b.client.command("FolderSync", fs0()), isCode(ERR.DENIED));
  await settle();
  checkClosed(connector);
});

test("échec de open : rien à fermer, aucune écriture", async () => {
  const { client, connector } = setup({ openError: cerr("NETWORK", "connexion refusée"), proto: KNOWN });
  await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.NETWORK));
  eq(connector.ops.map((o) => o.op), ["open"]);
});

// ── Connector errors ──────────────────────────────────────────────────────

const CONNECTOR_ERRORS = [
  ["TLS: certificat refusé par Thunderbird (SEC_ERROR_UNKNOWN_ISSUER)", ERR.TLS],
  ["PERMISSION: l'extension n'a pas accès à ce serveur", ERR.CONFIG],
  ["PROXY_AUTH: le proxy demande une authentification", ERR.PROXY_AUTH],
  ["PROXY: le proxy refuse le tunnel", ERR.NETWORK],
  ["CONFIG: trop de connexions ouvertes (16 au plus)", ERR.BUSY],
  ["LIMIT: trop de connexions ouvertes", ERR.BUSY],
  ["TIMEOUT: le serveur ne répond pas", ERR.TIMEOUT],
  ["NETWORK: connexion impossible (NS_ERROR_CONNECTION_REFUSED)", ERR.NETWORK],
  ["CLOSED: connexion inconnue ou fermée", ERR.NETWORK],
  ["INCONNU: code inconnu", ERR.NETWORK],
  ["tls: code en minuscules", ERR.NETWORK],
  ["TLS sans deux-points", ERR.NETWORK],
  [" TLS: espace devant", ERR.NETWORK],
  ["", ERR.NETWORK],
];

test("erreurs du connecteur : chaque CODE, à l'ouverture, en écriture et en lecture", async () => {
  for (const [message, code] of CONNECTOR_ERRORS) {
    const a = setup({ openError: new Error(message), proto: KNOWN });
    const e1 = await rejects(() => a.client.command("FolderSync", fs0()), isCode(code), `open « ${message} »`);
    eq(opsOf(a.connector, "write").length, 0);
    // Once the request may have left, a TLS failure is no longer "certificate refused, nothing sent".
    const after = code === ERR.TLS ? ERR.NETWORK : code;
    const b = setup({ hooks: { writeError: message || "x" }, proto: KNOWN, handlers: { FolderSync: folderSyncOk } });
    const e2 = await rejects(() => b.client.command("FolderSync", fs0()), isCode(message ? after : ERR.NETWORK), `write « ${message} »`);
    eq(e2.sent, true, `write « ${message} » : envoi possible signalé`);
    checkClosed(b.connector, `write « ${message} »`);
    const c = setup({ proto: KNOWN, handlers: { FolderSync: () => ({ bytes: http(200, { body: "x".repeat(50) }), split: "bytes", error: message, after: 10 }) } });
    const e3 = await rejects(() => c.client.command("FolderSync", fs0()), isCode(after), `read « ${message} »`);
    eq(e3.sent, true, `read « ${message} » : envoi signalé`);
    assert(!(e1.sent), `open « ${message} » : rien n'a été envoyé`);
    checkClosed(c.connector, `read « ${message} »`);
    assert(!e1.message.includes(PASSWORD) && !e1.message.includes(CREDENTIALS));
  }
  // Something that is not an Error "CODE: reason" at all.
  for (const thrown of ["TLS: chaîne nue", undefined, null, 42, { toString: () => "TLS: objet" }]) {
    const { client } = setup({ openError: () => { throw thrown; }, proto: KNOWN });
    await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.NETWORK), `valeur levée ${String(thrown)}`);
  }
});

test("erreurs du connecteur : raison nettoyée (contrôles, bidi, longueur)", async () => {
  const dirty = `TLS: certificat\u202e refusé\u0007\r\npar le proxy\u2066 ${"x".repeat(400)}`;
  const { client } = setup({ openError: new Error(dirty), proto: KNOWN });
  const e = await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.TLS));
  assert(!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(e.message), JSON.stringify(e.message));
  assert(e.message.includes("certificat refusé par le proxy"), e.message);
  assert(e.message.length < 260, `raison non plafonnée (${e.message.length})`);
  const cfg = setup({ openError: new Error("CONFIG: délai\u0000 invalide\u202e"), proto: KNOWN });
  const e2 = await rejects(() => cfg.client.command("FolderSync", fs0()), isCode(ERR.BUSY));
  eq(e2.message, "Connexion momentanément impossible (trop de connexions ouvertes).", "aucun texte du module repris");
  const bare = setup({ openError: new Error("TLS:"), proto: KNOWN });
  eq((await rejects(() => bare.client.command("FolderSync", fs0()), isCode(ERR.TLS))).message, "Connexion refusée : certificat du serveur non valide.");
});

test("FATAL : AUTH, DENIED, WIPE_REQUESTED, CONFIG seulement", () => {
  eq([...FATAL].sort(), [ERR.AUTH, ERR.CONFIG, ERR.DENIED, ERR.WIPE_REQUESTED].sort());
  for (const code of [ERR.TLS, ERR.PROXY_AUTH, ERR.NETWORK, ERR.TIMEOUT, ERR.BUSY, ERR.HTTP, ERR.PROVISION, ERR.TOO_LARGE, ERR.BAD_RESPONSE, ERR.CANCELLED]) {
    assert(!FATAL.has(code), `${code} ne doit pas être fatal`);
  }
  assert(Object.isFrozen(ERR));
  const e = new EasError(ERR.BUSY, "occupé", { status: 503, retryAfterMs: 5, code: "AUTRE", message: "autre" });
  eq([e.name, e.code, e.message, e.status, e.retryAfterMs], ["EasError", "BUSY", "occupé", 503, 5]);
  eq([DEFAULTS.maxBytes, DEFAULTS.deviceType], [16 * MIB, "Sync443"]);
});

// ── Constructor ───────────────────────────────────────────────────────────

const NOOP = { open() {}, write() {}, read() {}, close() {} };
const BASE = { server: SERVER, username: USER, password: PASSWORD, deviceId: DEVICE, connector: NOOP };
const make = (over) => new EasClient({ ...BASE, ...over });
const config = (fn, what) => throws(fn, isCode(ERR.CONFIG), what);

test("constructeur : adresse cohérente (origine, chemin, hôte, port)", () => {
  const good = { host: "mail.example.com", port: null, origin: "https://mail.example.com", url: `https://mail.example.com${PATH}` };
  for (const srv of [good, SERVER, parseServer("mail.example.com:8443"), parseServer("mail.example.com:443"), parseServer("[2001:db8::1]:8443"), parseServer("192.0.2.10"), { ...good, port: undefined }]) {
    assert(make({ server: srv }) instanceof EasClient, JSON.stringify(srv));
  }
  for (const [what, srv] of [
    ["absent", undefined], ["null", null], ["vide", {}], ["chaîne", "https://mail.example.com"],
    ["url d'un autre chemin", { ...good, url: "https://mail.example.com/owa" }],
    ["url absente", { ...good, url: undefined }],
    ["url avec requête", { ...good, url: `https://mail.example.com${PATH}?x=1` }],
    ["http", { ...good, origin: "http://mail.example.com", url: `http://mail.example.com${PATH}` }],
    // Host, origin and URL that agree with each other, but are not what parseServer() gives.
    ["majuscules", { host: "MAIL.example.com", port: null, origin: "https://MAIL.example.com", url: `https://MAIL.example.com${PATH}` }],
    ["chemin dans l'origine", { host: "mail.example.com/x", port: null, origin: "https://mail.example.com/x", url: `https://mail.example.com/x${PATH}` }],
    ["identifiant dans l'origine", { host: "u@mail.example.com", port: null, origin: "https://u@mail.example.com", url: `https://u@mail.example.com${PATH}` }],
    ["barre oblique inverse", { host: "evil.example\\mail.example.com", port: null, origin: "https://evil.example\\mail.example.com", url: `https://evil.example\\mail.example.com${PATH}` }],
    ["espace", { host: "mail example.com", port: null, origin: "https://mail example.com", url: `https://mail example.com${PATH}` }],
    ["fin de ligne", { host: "mail.example.com\r\nX: y", port: null, origin: "https://mail.example.com\r\nX: y", url: `https://mail.example.com\r\nX: y${PATH}` }],
    ["hôte non textuel", { ...good, host: 5 }],
    ["hôte vide", { ...good, host: "" }],
    ["hôte différent de l'origine", { ...good, host: "evil.example.net" }],
    ["port différent de l'origine", { ...good, port: 8443 }],
    ["port de l'origine absent du champ port", { ...good, origin: "https://mail.example.com:8443", url: `https://mail.example.com:8443${PATH}` }],
    ["port 0", { ...good, port: 0 }],
    ["port 65536", { ...good, port: 65536 }],
    ["port décimal", { ...good, port: 1.5 }],
    ["port textuel", { ...good, port: "443" }],
  ]) {
    config(() => make({ server: srv }), what);
  }
});

test("constructeur : identifiants", () => {
  for (const [what, over] of [
    ["sans identifiant", { username: undefined }], ["identifiant vide", { username: "" }], ["identifiant non textuel", { username: ["a"] }],
    ["sans mot de passe", { password: undefined }], ["mot de passe vide", { password: "" }], ["mot de passe non textuel", { password: 1234 }],
    ["deux-points dans l'identifiant", { username: "DOMAINE:jean" }],
  ]) {
    config(() => make(over), what);
  }
  for (const c of ["\n", "\r", "\t", "\u0000", "\u001f", "\u007f"]) {
    config(() => make({ username: `jean${c}x` }), `identifiant avec U+${c.charCodeAt(0)}`);
    config(() => make({ password: `secret${c}x` }), `mot de passe avec U+${c.charCodeAt(0)}`);
  }
  assert(make({ password: "a:b:c" }), "deux-points permis dans le mot de passe (RFC 7617)");
  assert(make({ username: "jean@example.com", password: "123£ é😀" }));
});

test("constructeur : DeviceId, connecteur, empreintes", () => {
  for (const id of ["", "abc-def", "x".repeat(33), "é", "ABC 123", "ABC_1", undefined, null, 12345]) config(() => make({ deviceId: id }), `DeviceId ${JSON.stringify(id)}`);
  assert(make({ deviceId: "x".repeat(32) }));
  for (const [what, connector] of [
    ["absent", undefined], ["null", null], ["vide", {}], ["sans close", { open() {}, write() {}, read() {} }],
    ["write non fonction", { ...NOOP, write: "x" }], ["read objet", { ...NOOP, read: {} }],
  ]) {
    config(() => make({ connector }), `connecteur ${what}`);
  }
  for (const [what, pins] of [
    ["chaîne", PIN.leaf], ["avec deux-points", [FP.leaf]], ["minuscules", [PIN.leaf.toLowerCase()]], ["63 caractères", [PIN.leaf.slice(1)]],
    ["65 caractères", [`${PIN.leaf}0`]], ["null", [null]], ["non hexadécimal", ["G".repeat(64)]], ["objet", {}],
  ]) {
    config(() => make({ pins }), `empreintes ${what}`);
  }
  assert(make({ pins: [] }) && make({ pins: [PIN.leaf, PIN.root] }));
});

test("constructeur : état enregistré nettoyé, mot de passe dans aucune propriété publique", async () => {
  eq(make({ proto: { asVersion: "14.1", policyKey: "3942919513" } }).proto, { asVersion: "14.1", policyKey: "3942919513" });
  for (const asVersion of ["16.0", "14.1 ", "14.1\r\nX-Evil: 1", 14.1, "", null]) eq(make({ proto: { asVersion } }).proto.asVersion, null, JSON.stringify(asVersion));
  for (const policyKey of ["abc", "4294967296", "1\r\nX: y", 123, "", "-1"]) eq(make({ proto: { policyKey } }).proto.policyKey, null, JSON.stringify(policyKey));
  eq(make({ proto: "n'importe quoi" }).proto, { asVersion: null, policyKey: null });
  // An unusable stored version is asked again; an unusable key is not sent.
  const { client, connector } = setup({ proto: { asVersion: "99.9", policyKey: "1\r\nX-Evil: 1" }, handlers: { FolderSync: folderSyncOk } });
  await client.command("FolderSync", fs0());
  eq(cmdsOf(connector), ["OPTIONS", "FolderSync"]);
  eq(requestsOf(connector)[1].headers.has("x-ms-policykey"), false);
  const dump = JSON.stringify(client);
  assert(!dump.includes(PASSWORD) && !dump.includes(CREDENTIALS), "secret dans une propriété publique");
});

// ── HTTP statuses and bodies ──────────────────────────────────────────────

test("HTTP 401 → AUTH, 403 → DENIED, sans nouvel essai ni secret dans l'erreur", async () => {
  for (const [status, code] of [[401, ERR.AUTH], [403, ERR.DENIED]]) {
    const { client, connector } = setup({ proto: KNOWN, handlers: { FolderSync: () => http(status, { headers: [["WWW-Authenticate", 'Basic realm="x"']] }) } });
    const e = await rejects(() => client.command("FolderSync", fs0()), isCode(code), String(status));
    eq([e.status, FATAL.has(e.code), cmdsOf(connector)], [status, true, ["FolderSync"]]);
    const dump = `${String(e)} ${JSON.stringify(e)} ${e.stack ?? ""}`;
    assert(!dump.includes(PASSWORD) && !dump.includes(CREDENTIALS), "secret dans l'erreur");
  }
});

test("HTTP 451 → HTTP : seul le nom d'hôte de X-MS-Location est montré, rien n'est suivi", async () => {
  const run = async (location) => {
    const headers = location === null ? [] : [["X-MS-Location", location]];
    const { client, connector } = setup({ proto: KNOWN, handlers: { FolderSync: () => http(451, { headers }) } });
    const e = await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.HTTP), String(location));
    eq([e.status, opsOf(connector, "open").length], [451, 1], "aucune connexion vers l'autre adresse");
    return e.message;
  };
  const shown = await run(`https://Autre.Example.com:444${PATH}?x=<script>`);
  assert(shown.includes("(autre.example.com)") && !shown.includes("444") && !shown.includes("script"), shown);
  for (const location of ["Appelez le 01 23 45 67 89 et donnez votre mot de passe", "https://user:pass@evil.example/", "http://evil.example/", "javascript:alert(1)", "https://evil.example\u202e/x", "", null]) {
    const m = await run(location);
    assert(!m.includes("(") && !/evil|Appelez|javascript|user:/.test(m), `texte du serveur montré : ${m}`);
  }
});

test("HTTP 429 et 503 → BUSY avec Retry-After (secondes ou date HTTP)", async () => {
  const busy = async (status, headers) => {
    const { client } = setup({ proto: KNOWN, handlers: { FolderSync: () => http(status, { headers }) } });
    const e = await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.BUSY));
    eq([e.status, FATAL.has(e.code)], [status, false]);
    return e.retryAfterMs;
  };
  eq(await busy(429, [["Retry-After", "120"]]), 120_000);
  eq(await busy(503, [["Retry-After", "99999"]]), 86_400_000, "plafond d'un jour");
  // HTTP dates are compared with the client's own clock (the fake clock of these tests).
  const ms = await busy(503, [["Retry-After", new Date(fakeClock().now() + 90_000).toUTCString()]]);
  eq(ms, 90_000, `date HTTP : ${ms}`);
  eq(await busy(503, []), 0, "sans Retry-After");
  eq(await busy(429, [["Retry-After", "10"], ["Retry-After", "20"]]), 0, "valeurs contradictoires");
});

test("retryAfter : secondes, date HTTP, plafond d'un jour", () => {
  const now = Date.UTC(2015, 9, 21, 7, 27, 0);
  eq(retryAfter("120", now), 120_000);
  eq(retryAfter(" 30 ", now), 30_000);
  eq(retryAfter("86401", now), 86_400_000);
  eq(retryAfter("99999999999", now), 86_400_000);
  eq(retryAfter("Wed, 21 Oct 2015 07:28:00 GMT", now), 60_000);
  eq(retryAfter("Wed, 21 Oct 2015 07:00:00 GMT", now), 0);
  eq(retryAfter("Fri, 21 Oct 2016 07:28:00 GMT", now), 86_400_000);
  for (const v of [null, undefined, "", "abc", "-5", 120]) eq(retryAfter(v, now), 0, JSON.stringify(v));
});

test("autres statuts non 2xx → HTTP ; 2xx sans corps → null ; réponses 1xx ignorées", async () => {
  for (const status of [300, 302, 304, 400, 404, 409, 500, 502, 599]) {
    const { client } = setup({ proto: KNOWN, handlers: { FolderSync: () => http(status) } });
    eq((await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.HTTP), String(status))).status, status);
  }
  for (const [what, answer] of [
    ["200 vide", http(200)], ["204", http(204, { framing: "none" })], ["299", http(299)],
    ["200 en blocs vides", http(200, { framing: "chunked" })],
  ]) {
    const { client } = setup({ proto: KNOWN, handlers: { FolderSync: () => answer } });
    eq(await client.command("FolderSync", fs0()), null, what);
  }
  // Without an announced length, a cut connection would pass for an empty success: refused.
  const unframed = setup({ proto: KNOWN, handlers: { FolderSync: () => http(200, { framing: "close" }) } });
  const eu = await rejects(() => unframed.client.command("FolderSync", fs0()), isCode(ERR.BAD_RESPONSE), "200 délimité par la fermeture");
  assert(/longueur/.test(eu.message), eu.message);
  const interim = concat([encodeUtf8("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 102 Processing\r\n\r\n"), folderSyncOk()]);
  const { client } = setup({ proto: KNOWN, handlers: { FolderSync: () => interim } });
  eq(text(await client.command("FolderSync", fs0()), "SyncKey"), "1");
});

test("corps WBXML en blocs (chunked) ou de longueur annoncée ; délimité par la fermeture refusé", async () => {
  const tree = el("FolderHierarchy:FolderSync", [el("Status", "1"), el("SyncKey", "k".repeat(300))]);
  for (const framing of ["chunked", "length"]) {
    const { client } = setup({ proto: KNOWN, handlers: { FolderSync: () => wbxmlHttp(tree, { framing }) } });
    eq(text(await client.command("FolderSync", fs0()), "SyncKey"), "k".repeat(300), framing);
  }
  const { client } = setup({ proto: KNOWN, handlers: { FolderSync: () => wbxmlHttp(tree, { framing: "close" }) } });
  await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.BAD_RESPONSE), "close");
});

test("réponse découpée au hasard, octet par octet ou en tableaux : même résultat", async () => {
  const tree = el("FolderHierarchy:FolderSync", [el("Status", "1"), el("SyncKey", "s".repeat(2000)), el("Changes", [el("Count", "0")])]);
  for (const [split, seeds] of [["random", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]], ["bytes", [1]], ["one", [1]], ["arrays", [11, 12]]]) {
    for (const seed of seeds) {
      const { client, connector } = setup({ split, seed, handlers: { FolderSync: () => wbxmlHttp(tree, { framing: seed % 2 ? "chunked" : "length" }) } });
      eq(text(await client.command("FolderSync", fs0()), "SyncKey"), "s".repeat(2000), `${split} ${seed}`);
      checkClosed(connector, `${split} ${seed}`);
    }
  }
});

test("corps non WBXML ou WBXML invalide → BAD_RESPONSE", async () => {
  const valid = encode(el("FolderHierarchy:FolderSync", [el("Status", "1")]));
  for (const [what, body] of [
    ["HTML", "<html><body>Connexion</body></html>"],
    ["3 octets", new Uint8Array([0x03, 0x01, 0x6a])],
    ["WBXML tronqué", valid.subarray(0, valid.length - 1)],
    ["attributs", new Uint8Array([0x03, 0x01, 0x6a, 0x00, 0x85, 0x01])],
    ["deux racines", new Uint8Array([0x03, 0x01, 0x6a, 0x00, 0x05, 0x05])],
  ]) {
    const { client } = setup({ proto: KNOWN, handlers: { FolderSync: () => http(200, { headers: [WBXML_TYPE], body }) } });
    const e = await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.BAD_RESPONSE), what);
    assert(e.message.startsWith("FolderSync"), e.message);
  }
});

test("HTTP mal formé → BAD_RESPONSE, message nettoyé", async () => {
  for (const [what, raw] of [
    ["LF seul", "HTTP/1.1 200 OK\nContent-Length: 0\n\n"],
    ["HTTP/2", "HTTP/2 200 OK\r\n\r\n"],
    ["code sur 4 chiffres", "HTTP/1.1 2000 OK\r\n\r\n"],
    ["pas du HTTP", "SSH-2.0-OpenSSH_9.6\r\n"],
    ["en-tête replié", "HTTP/1.1 200 OK\r\nX: a\r\n b\r\nContent-Length: 0\r\n\r\n"],
    ["Content-Length et Transfer-Encoding", "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"],
    ["deux Content-Length différents", "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\nabcd"],
    ["Transfer-Encoding gzip", "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n"],
    ["Content-Encoding gzip", "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n"],
    ["contrôle dans un en-tête", "HTTP/1.1 200 OK\r\nX: a\u0001b\r\nContent-Length: 0\r\n\r\n"],
    ["101", "HTTP/1.1 101 Switching Protocols\r\nUpgrade: h2c\r\n\r\n"],
    ["données après la réponse", "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nHTTP/1.1 200 OK\r\n\r\n"],
  ]) {
    const { client, connector } = setup({ proto: KNOWN, split: "one", handlers: { FolderSync: () => raw } });
    const e = await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.BAD_RESPONSE), what);
    assert(!/[\u0000-\u001f\u007f\u202a-\u202e]/.test(e.message), `${what} : ${JSON.stringify(e.message)}`);
    checkClosed(connector, what);
  }
});

test("réponse terminée trop tôt → BAD_RESPONSE", async () => {
  for (const [what, raw] of [
    ["rien du tout", new Uint8Array(0)],
    ["ligne d'état incomplète", "HTTP/1.1 20"],
    ["en-têtes incomplets", "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n"],
    ["corps incomplet", "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc"],
    ["dernier bloc absent", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n"],
  ]) {
    const { client, connector } = setup({ proto: KNOWN, handlers: { FolderSync: () => raw } });
    await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.BAD_RESPONSE), what);
    checkClosed(connector, what);
  }
});

test("corps au-delà de maxBytes → TOO_LARGE, lecture arrêtée", async () => {
  for (const [what, answer] of [
    ["Content-Length", { bytes: http(200, { body: "x".repeat(5000) }) }],
    ["chunked", { bytes: http(200, { body: "x".repeat(5000), framing: "chunked" }) }],
  ]) {
    const { client, connector } = setup({ proto: KNOWN, split: "one", handlers: { FolderSync: () => answer } });
    const e = await rejects(() => client.command("FolderSync", fs0(), { maxBytes: 1000 }), isCode(ERR.TOO_LARGE), what);
    assert(!FATAL.has(e.code));
    eq(opsOf(connector, "read").length, 1, `${what} : lecture poursuivie`);
    checkClosed(connector, what);
  }
  const exact = encode(el("FolderHierarchy:FolderSync", [el("Status", "1"), el("SyncKey", "k".repeat(40))]));
  const ok = setup({ proto: KNOWN, handlers: { FolderSync: () => http(200, { headers: [WBXML_TYPE], body: exact }) } });
  eq(text(await ok.client.command("FolderSync", fs0(), { maxBytes: exact.length }), "Status"), "1", "taille exacte acceptée");
  const huge = setup({ proto: KNOWN, handlers: { FolderSync: () => `HTTP/1.1 200 OK\r\nContent-Length: ${DEFAULTS.maxBytes + 1}\r\n\r\n` } });
  await rejects(() => huge.client.command("FolderSync", fs0()), isCode(ERR.TOO_LARGE), "limite par défaut");
  const opts = setup({ handlers: { OPTIONS: () => http(200, { headers: VERSIONS, body: "x".repeat(70_000) }) } });
  await rejects(() => opts.client.options(), isCode(ERR.TOO_LARGE), "OPTIONS limité à 64 Kio");
});

// ── Command-level statuses ────────────────────────────────────────────────

test("Status 140 → WIPE_REQUESTED, rien n'est effacé ni provisionné", async () => {
  const { client, connector } = setup({ proto: KNOWN, handlers: { FolderSync: () => withStatus("140"), Provision: provisioning() } });
  const e = await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.WIPE_REQUESTED));
  assert(FATAL.has(e.code) && e.message.includes("rien n'a été effacé"), e.message);
  eq(cmdsOf(connector), ["FolderSync"]);
});

test("Status 126, 127, 129, 130, 131, 177 → DENIED ; autres statuts rendus", async () => {
  for (const s of ["126", "127", "129", "130", "131", "177"]) {
    const { client, connector } = setup({ proto: KNOWN, handlers: { FolderSync: () => withStatus(s), Provision: provisioning() } });
    await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.DENIED), s);
    eq(cmdsOf(connector), ["FolderSync"], `pas de nouvel essai pour ${s}`);
  }
  for (const s of ["1", "128", "141", "145", "176"]) {
    const { client } = setup({ proto: KNOWN, handlers: { FolderSync: () => withStatus(s) } });
    eq(text(await client.command("FolderSync", fs0()), "Status"), s);
  }
});

test("Status 142, 143, 144 et HTTP 449 → provisionnement puis un seul nouvel essai", async () => {
  for (const refusal of [() => withStatus("142"), () => withStatus("143"), () => withStatus("144"), () => http(449)]) {
    let n = 0;
    const { client, connector, saved } = setup({ proto: KNOWN, handlers: { FolderSync: () => (++n === 1 ? refusal() : folderSyncOk()), Provision: provisioning() } });
    eq(text(await client.command("FolderSync", fs0()), "SyncKey"), "1");
    eq(cmdsOf(connector), ["FolderSync", "Provision", "Provision", "FolderSync"]);
    eq(requestsOf(connector)[3].headers.get("x-ms-policykey"), FINAL_KEY, "nouvelle clé utilisée");
    eq(saved.at(-1), { asVersion: "14.1", policyKey: FINAL_KEY });
    checkClosed(connector);
  }
});

test("toujours refusé après provisionnement → PROVISION", async () => {
  for (const refusal of [() => withStatus("142"), () => http(449)]) {
    const { client, connector } = setup({ proto: KNOWN, handlers: { FolderSync: refusal, Provision: provisioning() } });
    const e = await rejects(() => client.command("FolderSync", fs0()), isCode(ERR.PROVISION));
    assert(!FATAL.has(e.code));
    eq(cmdsOf(connector), ["FolderSync", "Provision", "Provision", "FolderSync"]);
  }
});

// ── Provision ─────────────────────────────────────────────────────────────

test("provision : demande avec X-MS-PolicyKey 0, accusé avec Status 3 et la clé temporaire", async () => {
  const { client, connector, saved } = setup({ handlers: { Provision: provisioning() } });
  await client.provision();
  const [options, first, second] = requestsOf(connector);
  eq(options.method, "OPTIONS");
  eq(first.headers.get("x-ms-policykey"), "0");
  eq(first.doc.children.map((c) => `${c.ns}:${c.tag}`), ["Settings:DeviceInformation", "Provision:Policies"]);
  eq([text(first.doc, "DeviceInformation", "Set", "Model"), text(first.doc, "DeviceInformation", "Set", "UserAgent")], ["Thunderbird", DEFAULTS.userAgent]);
  eq(at(first.doc, "Policies", "Policy", "PolicyKey"), null);
  eq(second.headers.get("x-ms-policykey"), TEMP_KEY, "clé temporaire dans l'en-tête");
  const policy = at(second.doc, "Policies", "Policy");
  eq(policy.children.map((c) => c.tag), ["PolicyType", "PolicyKey", "Status"]);
  eq([text(policy, "PolicyKey"), text(policy, "Status")], [TEMP_KEY, "3"], "règles non appliquées, dit honnêtement");
  eq(child(second.doc, "DeviceInformation"), null);
  eq(client.proto.policyKey, FINAL_KEY);
  eq(saved.at(-1), { asVersion: "14.1", policyKey: FINAL_KEY }, "saveProto reçoit la clé finale");
  assert(saved.at(-1) !== client.proto, "saveProto reçoit une copie");
  checkClosed(connector);
});

test("provision : pas de DeviceInformation avant 14.1", async () => {
  const { client, connector } = setup({ proto: { asVersion: "14.0" }, handlers: { Provision: provisioning() } });
  await client.provision();
  const [first] = requestsOf(connector);
  eq([first.doc.children.map((c) => c.tag), first.headers.get("ms-asprotocolversion")], [["Policies"], "14.0"]);
});

test("provision : RemoteWipe ou AccountOnlyRemoteWipe, dans l'une ou l'autre réponse → WIPE_REQUESTED", async () => {
  for (const tag of ["RemoteWipe", "AccountOnlyRemoteWipe"]) {
    const a = setup({ proto: KNOWN, handlers: { Provision: provisioning({ first: policyResponse({ extra: [el(tag)] }) }) } });
    await rejects(() => a.client.provision(), isCode(ERR.WIPE_REQUESTED), `${tag}, première réponse`);
    eq(cmdsOf(a.connector), ["Provision"], "pas d'accusé de réception");
    const b = setup({ proto: KNOWN, handlers: { Provision: provisioning({ second: ackResponse({ extra: [el(tag)] }) }) } });
    await rejects(() => b.client.provision(), isCode(ERR.WIPE_REQUESTED), `${tag}, seconde réponse`);
    eq(b.client.proto.policyKey, null, "clé finale non retenue");
    assert(!b.saved.some((p) => p.policyKey === FINAL_KEY), "clé finale non enregistrée");
    const c = setup({ proto: KNOWN, handlers: { Provision: () => wbxmlHttp(el("Provision:Provision", [el(tag)])) } });
    await rejects(() => c.client.provision(), isCode(ERR.WIPE_REQUESTED), `${tag} seul`);
  }
});

test("provision : statut de règle 2 (aucune règle) → policyKey null", async () => {
  const { client, connector, saved } = setup({
    proto: { asVersion: "14.1", policyKey: "12345" },
    handlers: { Provision: provisioning({ first: policyResponse({ policyStatus: "2", key: null }) }) },
  });
  await client.provision();
  eq([client.proto.policyKey, saved.at(-1), cmdsOf(connector)], [null, { asVersion: "14.1", policyKey: null }, ["Provision"]]);
});

test("provision : clé ou statuts invalides → PROVISION ; vide → PROVISION ; racine inattendue → BAD_RESPONSE", async () => {
  for (const [what, first] of [
    ["clé non numérique", policyResponse({ key: "abc" })],
    ["clé ≥ 2^32", policyResponse({ key: "4294967296" })],
    ["clé absente", policyResponse({ key: null })],
    ["statut de règle 3", policyResponse({ policyStatus: "3" })],
    ["statut global 2", policyResponse({ status: "2" })],
  ]) {
    const { client, connector } = setup({ proto: KNOWN, handlers: { Provision: provisioning({ first }) } });
    await rejects(() => client.provision(), isCode(ERR.PROVISION), what);
    eq(cmdsOf(connector), ["Provision"], `${what} : pas d'accusé`);
  }
  for (const [what, second] of [["clé finale absente", ackResponse({ key: null })], ["clé finale invalide", ackResponse({ key: "-1" })], ["accusé refusé", ackResponse({ status: "3" })]]) {
    const { client, saved } = setup({ proto: KNOWN, handlers: { Provision: provisioning({ second }) } });
    await rejects(() => client.provision(), isCode(ERR.PROVISION), what);
    assert(client.proto.policyKey === null && !saved.some((p) => p.policyKey), `${what} : clé retenue`);
  }
  const empty = setup({ proto: KNOWN, handlers: { Provision: () => http(200) } });
  await rejects(() => empty.client.provision(), isCode(ERR.PROVISION), "réponse vide");
  const wrong = setup({ proto: KNOWN, handlers: { Provision: () => wbxmlHttp(el("AirSync:Sync", [el("Status", "1")])) } });
  await rejects(() => wrong.client.provision(), isCode(ERR.BAD_RESPONSE), "racine inattendue");
});

// ── Version ───────────────────────────────────────────────────────────────

test("ensureVersion : 14.1 > 14.0 > 12.1, valeurs parasites ignorées, valeur enregistrée", async () => {
  for (const [lines, expected] of [
    [["2.5,12.0,12.1,14.0,14.1"], "14.1"], [["14.1,14.0,12.1"], "14.1"], [["12.1, 14.0"], "14.0"], [["2.5,12.0,12.1"], "12.1"],
    [["16.1,16.0,14.1"], "14.1"], [["14.1x,14.0"], "14.0"], [["14.1;q=1, <14.0>, 12.1"], "12.1"], [["2.5,12.1", "14.0"], "14.0"],
  ]) {
    const { client, saved, connector } = setup({ handlers: { OPTIONS: () => http(200, { headers: lines.map((v) => ["MS-ASProtocolVersions", v]) }) } });
    eq(await client.ensureVersion(), expected, lines.join(" | "));
    eq([client.proto.asVersion, saved.at(-1)], [expected, { asVersion: expected, policyKey: null }]);
    eq(cmdsOf(connector), ["OPTIONS"]);
  }
});

test("ensureVersion : aucune version gérée → CONFIG ; version connue → aucune connexion", async () => {
  for (const headers of [[], [["MS-ASProtocolVersions", ""]], [["MS-ASProtocolVersions", "2.5,12.0"]], [["MS-ASProtocolVersions", "16.0,16.1"]], [["MS-ASProtocolVersions", "14.1.0, v14.1, 14,1"]]]) {
    const { client, saved } = setup({ handlers: { OPTIONS: () => http(200, { headers }) } });
    const e = await rejects(() => client.ensureVersion(), isCode(ERR.CONFIG), JSON.stringify(headers));
    assert(FATAL.has(e.code));
    eq([client.proto.asVersion, saved.length], [null, 0]);
  }
  const known = setup({ proto: { asVersion: "14.0" } });
  eq(await known.client.ensureVersion(), "14.0");
  eq(known.connector.ops, []);
  const refused = setup({ handlers: { OPTIONS: () => http(401) } });
  await rejects(() => refused.client.ensureVersion(), isCode(ERR.AUTH), "OPTIONS 401");
});

// ── Time and cancellation ─────────────────────────────────────────────────

test("délai : now() avance pendant les lectures → TIMEOUT, délais de lecture décroissants", async () => {
  const { client, connector } = setup({ proto: KNOWN, handlers: { FolderSync: () => ({ bytes: folderSyncOk(), stepMs: 2000 }) } });
  const e = await rejects(() => client.command("FolderSync", fs0(), { timeoutMs: 5000 }), isCode(ERR.TIMEOUT));
  assert(!FATAL.has(e.code) && e.message.includes("5 s"), e.message);
  eq(opsOf(connector, "open")[0].options.timeoutMs, 5000, "ouverture bornée par le délai restant");
  eq(opsOf(connector, "read").map((r) => r.options.timeoutMs), [5000, 3000, 1000]);
  checkClosed(connector);
});

test("délai : dépassé pendant l'ouverture → TIMEOUT avant toute lecture", async () => {
  const { client, connector } = setup({ proto: KNOWN, hooks: { openDelayMs: 6000 }, handlers: { FolderSync: folderSyncOk } });
  await rejects(() => client.command("FolderSync", fs0(), { timeoutMs: 5000 }), isCode(ERR.TIMEOUT));
  eq(opsOf(connector, "read").length, 0);
  checkClosed(connector);
});

test("délai : TIMEOUT du connecteur → TIMEOUT ; délai par défaut 120 s", async () => {
  const a = setup({ proto: KNOWN, handlers: { FolderSync: () => ({ bytes: folderSyncOk(), waitMs: 200_000 }) } });
  await rejects(() => a.client.command("FolderSync", fs0()), isCode(ERR.TIMEOUT));
  eq(opsOf(a.connector, "read")[0].options.timeoutMs, DEFAULTS.timeoutMs);
  checkClosed(a.connector);
  const b = setup({ proto: KNOWN, handlers: { FolderSync: () => ({ bytes: folderSyncOk(), waitMs: 100_000 }) } });
  eq(text(await b.client.command("FolderSync", fs0()), "Status"), "1", "réponse dans le délai");
});

test("Ping longue durée : un délai au-delà de 10 min reste dans les bornes du connecteur", async () => {
  const ping = pingRequest(3540, [{ id: "5", cls: "Email" }]);
  const answer = wbxmlHttp(el("Ping:Ping", [el("Status", "1")]));
  const { client, connector, clock } = setup({ proto: KNOWN, handlers: { Ping: () => ({ bytes: answer, waitMs: 3_500_000 }) } });
  const started = clock.now();
  const doc = await client.command("Ping", ping, { timeoutMs: 3_600_000 });
  eq(text(doc, "Status"), "1");
  for (const r of opsOf(connector, "read")) assert(r.options.timeoutMs <= 600_000, `lecture de ${r.options.timeoutMs} ms`);
  assert(clock.now() - started >= 3_500_000, "la réponse est bien arrivée après 58 min");
  const late = setup({ proto: KNOWN, handlers: { Ping: () => ({ bytes: answer, waitMs: 4_000_000 }) } });
  await rejects(() => late.client.command("Ping", ping, { timeoutMs: 3_600_000 }), isCode(ERR.TIMEOUT), "au-delà du délai global");
  checkClosed(late.connector);
  // A connector that gives up at once (its clock and ours disagree) is not retried forever.
  const eager = setup({ proto: KNOWN, handlers: { Ping: () => ({ bytes: answer, error: "TIMEOUT: tout de suite" }) } });
  await rejects(() => eager.client.command("Ping", ping, { timeoutMs: 3_600_000 }), isCode(ERR.TIMEOUT), "sans attente réelle");
  assert(opsOf(eager.connector, "read").length <= 7, `lectures répétées sans fin (${opsOf(eager.connector, "read").length})`);
  // A read that timed out with the whole remaining delay is not retried.
  const short = setup({ proto: KNOWN, handlers: { FolderSync: () => ({ bytes: folderSyncOk(), error: "TIMEOUT: tout de suite" }) } });
  await rejects(() => short.client.command("FolderSync", fs0()), isCode(ERR.TIMEOUT));
  eq(opsOf(short.connector, "read").length, 1);
});

test("annulation pendant la lecture → CANCELLED, connexion fermée, écouteur retiré", async () => {
  const outer = new AbortController();
  // The read is pending (it would never end) when the signal fires.
  const { client, connector } = setup({ proto: KNOWN, handlers: { FolderSync: () => ({ bytes: folderSyncOk(), hang: true, onRead: () => setTimeout(() => outer.abort(), 0) }) } });
  const e = await rejects(() => client.command("FolderSync", fs0(), { signal: outer.signal }), isCode(ERR.CANCELLED));
  assert(!FATAL.has(e.code));
  eq(connector.conns.get("c1").answer.endedBy, "close", "la lecture en cours doit être interrompue par close()");
  checkClosed(connector);
  if (outer.signal.listeners) eq(outer.signal.listeners.size, 0, "écouteur d'abandon laissé en place");
});

test("annulation entre deux lectures ou pendant l'écriture → CANCELLED", async () => {
  const a = new AbortController();
  const ra = setup({ proto: KNOWN, handlers: { FolderSync: () => ({ bytes: folderSyncOk(), split: "bytes", onRead: (n) => n === 5 && a.abort() }) } });
  await rejects(() => ra.client.command("FolderSync", fs0(), { signal: a.signal }), isCode(ERR.CANCELLED), "entre deux lectures");
  checkClosed(ra.connector, "lecture");
  const b = new AbortController();
  const rb = setup({ proto: KNOWN, hooks: { beforeWrite: () => b.abort() }, handlers: { FolderSync: folderSyncOk } });
  await rejects(() => rb.client.command("FolderSync", fs0(), { signal: b.signal }), isCode(ERR.CANCELLED), "pendant l'écriture");
  checkClosed(rb.connector, "écriture");
});

test("annulation pendant l'ouverture → CANCELLED, rien n'est écrit", async () => {
  const outer = new AbortController();
  const { client, connector } = setup({ proto: KNOWN, hooks: { beforeOpen: () => outer.abort() }, handlers: { FolderSync: folderSyncOk } });
  await rejects(() => client.command("FolderSync", fs0(), { signal: outer.signal }), isCode(ERR.CANCELLED));
  eq(opsOf(connector, "write").length, 0, "requête écrite malgré l'annulation");
  checkClosed(connector);
});

test("signal déjà abandonné → CANCELLED sans aucune connexion", async () => {
  const outer = new AbortController();
  outer.abort();
  for (const proto of [undefined, KNOWN]) {
    const { client, connector } = setup({ proto, handlers: { FolderSync: folderSyncOk } });
    await rejects(() => client.command("FolderSync", fs0(), { signal: outer.signal }), isCode(ERR.CANCELLED));
    eq(connector.ops, []);
  }
});

test("nom de commande invalide → CONFIG avant toute connexion", async () => {
  for (const cmd of ["Sync&Evil=1", "", "Folder Sync", "Sync1", "a".repeat(33), "Synç", "../x", "Sync\r\n", "Sync HTTP/1.1", null, undefined, 42]) {
    const { client, connector } = setup({ handlers: { FolderSync: folderSyncOk } });
    await rejects(() => client.command(cmd, fs0()), isCode(ERR.CONFIG), JSON.stringify(cmd));
    eq(connector.ops, [], JSON.stringify(cmd));
  }
});

// ── Debug log ─────────────────────────────────────────────────────────────

test("journal de débogage : ni mot de passe, ni Authorization, ni contenu", async () => {
  const lines = [];
  const log = { debugEnabled: true, debug: (m, d) => lines.push(`${m}\n${d ?? ""}`), info: (m) => lines.push(m) };
  let n = 0;
  const { client } = setup({
    log,
    handlers: {
      Provision: provisioning(),
      Sync: () => (++n === 1
        ? wbxmlHttp(el("AirSync:Sync", [el("Status", "142")]))
        : wbxmlHttp(el("AirSync:Sync", [el("Collections", [el("Collection", [
          el("SyncKey", "2"), el("CollectionId", "5"), el("Status", "1"),
          el("Commands", [el("Add", [el("ServerId", "5:9"), el("ApplicationData", [
            el("Email:Subject", "Réponse secrète du serveur"), el("Email:From", "espion@example.com"),
            el("AirSyncBase:Body", [el("Type", "1"), el("Data", "Corps secret")]),
          ])])]),
        ])])]))),
    },
  });
  const request = syncRequest([{ collectionId: "5", syncKey: "1", commands: [changeCommand("5:1", [el("Email:Subject", "Projet Hermès confidentiel"), el("Email:Read", "1")])] }]);
  await client.command("Sync", request);
  const all = lines.join("\n");
  for (const secret of [PASSWORD, AUTH, CREDENTIALS, "Authorization", "Projet Hermès", "Réponse secrète", "espion@example.com", "Corps secret"]) {
    assert(!all.includes(secret), `« ${secret} » dans le journal`);
  }
  assert(all.includes("→ Sync") && all.includes("← Sync") && all.includes("→ Provision"), "commandes journalisées");
  assert(all.includes("<AirSync:SyncKey> 1") && all.includes("<AirSync:SyncKey> 2"), "valeurs techniques montrées");
  assert(/<Email:Subject> \[\d+ octets\]/.test(all), "longueur à la place du contenu");
});

test("journal désactivé : debug() jamais appelé", async () => {
  const log = { debugEnabled: false, debug: () => { throw new Error("debug appelé"); }, info: () => {} };
  const { client } = setup({ log, handlers: { FolderSync: folderSyncOk } });
  await client.command("FolderSync", fs0());
});
