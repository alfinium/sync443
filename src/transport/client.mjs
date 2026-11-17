// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Exchange ActiveSync over HTTPS ([MS-ASHTTP]), on connections the
 * extension opens itself (see experiments/sync443Net).
 *
 * For every request:
 *  1. a TLS connection is opened to the configured server, directly or
 *     through the proxy Thunderbird would use (`connector.open`);
 *  2. once the handshake is complete, the certificate chain is judged
 *     (core/tls-policy.mjs). If it is refused, the connection is closed and
 *     NOTHING has been written on it: not one byte, so not the password;
 *  3. only then is the request written (core/http1.mjs), password included;
 *  4. the answer is read with strict limits, and the connection closed.
 *
 * The password goes to one origin only: the configured one. No redirect is
 * ever followed; a 451 "use another server" is reported, never acted upon.
 *
 * Every failure is an EasError with a code. FATAL codes must not be retried
 * automatically (wrong password, access denied, remote wipe request, bad
 * configuration). A refused certificate is not fatal: nothing was sent, and
 * a hotel's captive portal, for one, goes away by itself; it is reported,
 * and retried with growing delays.
 *
 * A remote wipe request is always refused: nothing is ever erased.
 */

import { encode, decode, looksLikeWbxml, WbxmlError, toDebugString } from "../core/wbxml.mjs";
import { encodeUtf8 } from "../core/utf8.mjs";
import { base64 } from "../core/base64.mjs";
import { cleanText, policyKey as policyKeyOf } from "../core/sanitize.mjs";
import { provisionRequest, parseProvision, topStatus, ProtocolError, DEBUG_SHOWN } from "../core/protocol.mjs";
import { evaluateTls, tlsMessage } from "../core/tls-policy.mjs";
import { serializeRequest, ResponseParser, HttpError, headerValue } from "../core/http1.mjs";
import { EAS_PATH } from "../core/server.mjs";
import { ORIGIN, DEVICE_ID, TLS_PIN } from "../core/ids.mjs";

export const ERR = Object.freeze({
  AUTH: "AUTH", // password refused
  DENIED: "DENIED", // account or device not allowed to sync
  WIPE_REQUESTED: "WIPE_REQUESTED", // refused, sync stops
  CONFIG: "CONFIG",
  TLS: "TLS", // certificate refused: nothing was sent
  PROXY_AUTH: "PROXY_AUTH", // the network's proxy wants its own credentials (not supported)
  PROVISION: "PROVISION",
  HTTP: "HTTP",
  BUSY: "BUSY", // 429/503, retry later
  NETWORK: "NETWORK",
  TIMEOUT: "TIMEOUT",
  TOO_LARGE: "TOO_LARGE",
  BAD_RESPONSE: "BAD_RESPONSE",
  CANCELLED: "CANCELLED",
});

/** No automatic retry for these: the user has to act. */
export const FATAL = new Set([ERR.AUTH, ERR.DENIED, ERR.WIPE_REQUESTED, ERR.CONFIG]);

/** A typed failure: `code` (one of ERR), a French message for the user, and optional extra fields (retryAfterMs, sent). */
export class EasError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    Object.assign(this, Object.fromEntries(Object.entries(details).filter(([key]) => key !== "code" && key !== "message")));
    this.name = "EasError";
    this.code = code;
  }
}

const PREFERRED_VERSIONS = ["14.1", "14.0", "12.1"];
const NEEDS_PROVISION = new Set(["142", "143", "144"]);
const WIPE_STATUS = "140";
// User or device not allowed: disabled for sync, blocked, access denied,
// account disabled, too many devices ([MS-ASCMD] 2.2.2).
const DENIED_STATUS = new Set(["126", "127", "129", "130", "131", "177"]);
const CONTROL = /[\x00-\x1f\x7f]/;
const MAX_READ_WAIT_MS = 600_000; // longest wait of one connector.read()
const WRITE_PIECE = 1024 * 1024; // largest connector.write() the privileged module accepts

export const DEFAULTS = Object.freeze({
  timeoutMs: 120_000,
  connectTimeoutMs: 30_000,
  maxBytes: 16 * 1024 * 1024,
  deviceType: "Sync443",
  userAgent: "Sync443/1.0",
});

/**
 * @param {object} o
 * @param {{host: string, port: number|null, origin: string, url: string}} o.server  from parseServer()
 * @param {string} o.username
 * @param {string} o.password
 * @param {string} o.deviceId    1-32 letters or digits
 * @param {string} [o.deviceType]  DeviceType of every request: 1-32 printable ASCII characters (DEFAULTS.deviceType)
 * @param {string} [o.userAgent]   User-Agent header, also sent in the Provision device information:
 *        1-128 printable ASCII characters, no space at either end (DEFAULTS.userAgent)
 * @param {{open: Function, write: Function, read: Function, close: Function}} o.connector
 *        verified connections (browser.sync443Net, or a test double)
 * @param {string[]} [o.pins]    SHA-256 fingerprints (64 upper-case hex digits) trusted for this
 *        server's certificate or root (core/tls-policy.mjs): the fingerprint the user typed in
 *        the settings of the mailbox, none by default.
 * @param {{set(f: Function, ms: number): any, clear(id: any): void}|null} [o.timers]
 *        bound the write phase (default: setTimeout and clearTimeout when the engine has them;
 *        without timers, writes rely on the connector's own stall limit)
 * @param {{asVersion?: string|null, policyKey?: string|null}} [o.proto]
 * @param {(proto) => Promise<void>} [o.saveProto]
 * @param {{debugEnabled: boolean, debug(m, d?): void}} [o.log]
 * @param {() => number} [o.now]
 */
export class EasClient {
  // Where the password goes and whom to trust: private, fixed at construction.
  #authorization;
  #server;
  #hostHeader;
  #pins;
  #connector;
  #timers;

  constructor(o) {
    const server = o?.server;
    if (!server || typeof server.origin !== "string" || !ORIGIN.test(server.origin) || server.url !== server.origin + EAS_PATH) {
      throw new EasError(ERR.CONFIG, "Adresse du serveur invalide.");
    }
    if (typeof server.host !== "string" || !server.host) throw new EasError(ERR.CONFIG, "Adresse du serveur invalide.");
    if (server.port !== null && server.port !== undefined && !(Number.isInteger(server.port) && server.port > 0 && server.port < 65536)) {
      throw new EasError(ERR.CONFIG, "Port du serveur invalide.");
    }
    // host and port are where the connection goes: they must be the origin's own.
    const hostPort = server.port && server.port !== 443 ? `${server.host}:${server.port}` : server.host;
    if (server.origin !== `https://${hostPort}`) throw new EasError(ERR.CONFIG, "Adresse du serveur invalide.");
    if (typeof o.username !== "string" || typeof o.password !== "string" || !o.username || !o.password) {
      throw new EasError(ERR.CONFIG, "Identifiant ou mot de passe manquant.");
    }
    // Refused here rather than discovered later as a "server error" retried for ever.
    if (o.username.includes(":") || CONTROL.test(o.username + o.password) || !o.username.isWellFormed() || !o.password.isWellFormed()) {
      throw new EasError(ERR.CONFIG, "Identifiant ou mot de passe contenant un caractère non autorisé.");
    }
    if (o.username.length > 256 || o.password.length > 1024) throw new EasError(ERR.CONFIG, "Identifiant ou mot de passe trop long.");
    if (typeof o.deviceId !== "string" || !DEVICE_ID.test(o.deviceId)) {
      throw new EasError(ERR.CONFIG, "Identifiant d'appareil invalide.");
    }
    const deviceType = o.deviceType ?? DEFAULTS.deviceType;
    const userAgent = o.userAgent ?? DEFAULTS.userAgent;
    if (typeof deviceType !== "string" || !/^[\x20-\x7e]{1,32}$/.test(deviceType)) throw new EasError(ERR.CONFIG, "Type d'appareil invalide.");
    if (typeof userAgent !== "string" || !/^[\x21-\x7e]([\x20-\x7e]{0,126}[\x21-\x7e])?$/.test(userAgent)) {
      throw new EasError(ERR.CONFIG, "User-Agent invalide.");
    }
    const c = o.connector;
    if (!c || !["open", "write", "read", "close"].every((f) => typeof c[f] === "function")) {
      throw new EasError(ERR.CONFIG, "Connexion vérifiée indisponible : aucune requête ne sera envoyée.");
    }
    const pins = o.pins ?? [];
    if (!Array.isArray(pins) || pins.some((p) => typeof p !== "string" || !TLS_PIN.test(p))) {
      throw new EasError(ERR.CONFIG, "Empreinte de certificat invalide.");
    }
    this.#server = Object.freeze({ host: server.host, port: server.port ?? null, origin: server.origin, url: server.url });
    this.#hostHeader = hostPort;
    this.#connector = c;
    this.#pins = Object.freeze([...pins]);
    // Timers bound the write phase; without both functions (some test shells), writes rely on the connector's own stall limit.
    const t = o.timers ?? (typeof setTimeout === "function" && typeof clearTimeout === "function"
      ? { set: (f, ms) => setTimeout(f, ms), clear: (id) => clearTimeout(id) }
      : null);
    this.#timers = t;
    this.username = o.username;
    this.deviceId = o.deviceId;
    this.deviceType = deviceType;
    this.userAgent = userAgent;
    // Stored protocol state is checked like anything read back from storage.
    this.proto = {
      asVersion: PREFERRED_VERSIONS.includes(o.proto?.asVersion) ? o.proto.asVersion : null,
      policyKey: policyKeyOf(o.proto?.policyKey ?? null),
    };
    this.saveProto = o.saveProto ?? (async () => {});
    this.log = o.log ?? null;
    this.now = o.now ?? (() => Date.now());
    this.#authorization = `Basic ${base64(encodeUtf8(`${o.username}:${o.password}`))}`;
  }

  #close(id) {
    try {
      Promise.resolve(this.#connector.close(id)).catch(() => {});
    } catch {
      /* a close that throws must not hide the request's own result */
    }
  }

  // ── One HTTP exchange on a verified connection ──────────────────────────

  async #exchange(method, { query = "", headers = [], body = null, timeoutMs = DEFAULTS.timeoutMs, signal, maxBytes = DEFAULTS.maxBytes } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new EasError(ERR.CONFIG, "Délai de requête invalide.");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new EasError(ERR.CONFIG, "Taille de réponse invalide.");
    if (signal?.aborted) throw new EasError(ERR.CANCELLED, "Requête annulée.");
    // Everything that cannot fail on the network is prepared first: a request
    // that cannot be built never opens a connection.
    const request = serializeRequest({
      method,
      host: this.#hostHeader,
      path: query ? `${EAS_PATH}?${query}` : EAS_PATH,
      headers: [["User-Agent", this.userAgent], ["Authorization", this.#authorization], ...headers],
      body,
    });
    // The parser requires every body to announce its length: a connection cut
    // by the network cannot pass for a complete, empty answer.
    const parser = new ResponseParser({ method, limits: { maxBodyBytes: maxBytes } });
    const deadline = this.now() + timeoutMs;
    const remaining = () => {
      const left = Math.ceil(deadline - this.now());
      if (!(left > 0)) throw new EasError(ERR.TIMEOUT, `Pas de réponse du serveur après ${Math.round(timeoutMs / 1000)} s.`);
      return left;
    };

    let conn;
    try {
      conn = await this.#connector.open({
        host: this.#server.host,
        port: this.#server.port ?? 443,
        timeoutMs: Math.max(1000, Math.min(remaining(), DEFAULTS.connectTimeoutMs)),
      });
    } catch (e) {
      throw e instanceof EasError ? e : connectorError(e);
    }
    if (!conn || typeof conn.id !== "string" || !conn.id) throw new EasError(ERR.NETWORK, "Connexion au serveur impossible.");

    let cancelled = false;
    let written = false;
    const onAbort = () => {
      cancelled = true;
      this.#close(conn.id);
    };
    signal?.addEventListener?.("abort", onAbort);
    try {
      // Aborted while the connection was being opened: the event has already fired.
      if (signal?.aborted) {
        cancelled = true;
        throw new EasError(ERR.CANCELLED, "Requête annulée.");
      }
      // The certificate first. Refused: nothing has been written, nothing will be.
      const verdict = evaluateTls(conn.securityInfo, { pins: this.#pins });
      if (!verdict.ok) {
        throw new EasError(ERR.TLS, tlsMessage(verdict.reason, verdict.issuer));
      }
      written = true; // from here on, the request (with the password) may have left
      await this.#write(conn.id, request, remaining());
      let capped = 0;
      while (!parser.done) {
        let chunk;
        const wait = remaining();
        try {
          chunk = await this.#connector.read(conn.id, { maxBytes: 1024 * 1024, timeoutMs: Math.min(wait, MAX_READ_WAIT_MS) });
        } catch (e) {
          // The connector waits at most 10 minutes per read, then leaves the
          // connection open: a longer deadline (Ping) reads again, a bounded number of times.
          const cut = wait > MAX_READ_WAIT_MS && /^TIMEOUT:/.test(String(e?.message ?? ""));
          if (!cancelled && cut && capped++ < Math.ceil(timeoutMs / MAX_READ_WAIT_MS)) continue;
          throw e;
        }
        if (chunk === null) {
          parser.end(); // throws if the answer is incomplete
          break;
        }
        parser.push(chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk));
      }
      if (cancelled) throw new EasError(ERR.CANCELLED, "Requête annulée.");
      return parser.response;
    } catch (e) {
      // `sent`: the request may have reached the server (its outcome is unknown).
      const sent = written;
      if (cancelled) throw new EasError(ERR.CANCELLED, "Requête annulée.", { sent });
      if (e instanceof EasError) {
        if (sent) e.sent = true;
        throw e;
      }
      if (e instanceof HttpError) {
        if (e.code === "TOO_LARGE") {
          throw new EasError(ERR.TOO_LARGE, `Réponse du serveur trop volumineuse (plus de ${Math.round(maxBytes / 1048576)} Mo).`, { sent });
        }
        throw new EasError(ERR.BAD_RESPONSE, `Réponse HTTP invalide du serveur : ${cleanText(e.message, { max: 160, singleLine: true, stripBidi: true })}`, { sent });
      }
      const err = connectorError(e);
      // After the request left, a TLS failure is no longer "certificate refused, nothing sent".
      if (sent && err.code === ERR.TLS) {
        throw new EasError(ERR.NETWORK, "Connexion interrompue après l'envoi de la requête.", { sent });
      }
      err.sent = sent;
      throw err;
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
      this.#close(conn.id);
    }
  }

  /**
   * Write, bounded by the exchange deadline (past it, the connection is
   * closed), in pieces of at most WRITE_PIECE bytes, one after the other: the
   * privileged module accepts one write at a time per connection, and never
   * more than 1 MiB in one call.
   */
  async #write(id, bytes, timeoutMs) {
    let timedOut = false;
    const timer = this.#timers?.set(() => {
      timedOut = true;
      this.#close(id);
    }, timeoutMs);
    try {
      for (let at = 0; at < bytes.length; at += WRITE_PIECE) {
        await this.#connector.write(id, bytes.subarray(at, Math.min(at + WRITE_PIECE, bytes.length)));
      }
    } catch (e) {
      if (timedOut) throw new EasError(ERR.TIMEOUT, "Envoi de la requête trop lent.");
      throw e;
    } finally {
      if (this.#timers) this.#timers.clear(timer);
    }
  }

  #checkHttp(resp, what) {
    const s = resp.status;
    if (s === 401) throw new EasError(ERR.AUTH, "Identifiant ou mot de passe refusé par le serveur.");
    if (s === 403) throw new EasError(ERR.DENIED, "Le serveur refuse l'accès ActiveSync à ce compte (HTTP 403).");
    if (s === 451) {
      // Only the host name is shown, never free text from the server.
      const m = /^https:\/\/([a-z0-9.-]{1,253})(?::\d{1,5})?(?:[/?#]|$)/i.exec(headerValue(resp.headers, "x-ms-location") ?? "");
      const where = m ? m[1].toLowerCase() : "";
      throw new EasError(
        ERR.HTTP,
        `Le serveur indique une autre adresse${where ? ` (${where})` : ""}. Vérifiez-la, puis modifiez la boîte : le mot de passe ne lui est pas envoyé automatiquement.`,
      );
    }
    if (s === 429 || s === 503) {
      throw new EasError(ERR.BUSY, `${what} : serveur occupé (HTTP ${s}).`, {
        retryAfterMs: retryAfter(headerValue(resp.headers, "retry-after"), this.now()),
      });
    }
    if ((s < 200 || s > 299) && s !== 449) throw new EasError(ERR.HTTP, `${what} : erreur HTTP ${s}.`, { status: s });
  }

  // ── Version ─────────────────────────────────────────────────────────────

  /** OPTIONS: the protocol versions the server offers. */
  async options({ signal } = {}) {
    const resp = await this.#exchange("OPTIONS", { signal, timeoutMs: 30_000, maxBytes: 64 * 1024 });
    this.#checkHttp(resp, "OPTIONS");
    const versions = (resp.headers.get("ms-asprotocolversions") ?? [])
      .join(",")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z0-9.]{1,32}$/.test(s));
    return { versions };
  }

  async ensureVersion({ signal } = {}) {
    if (this.proto.asVersion) return this.proto.asVersion;
    const { versions } = await this.options({ signal });
    const chosen = PREFERRED_VERSIONS.find((x) => versions.includes(x));
    if (!chosen) {
      throw new EasError(ERR.CONFIG, `Le serveur ne propose aucune version ActiveSync gérée (${PREFERRED_VERSIONS.join(", ")}).`);
    }
    this.proto.asVersion = chosen;
    await this.saveProto({ ...this.proto });
    return chosen;
  }

  // ── Commands ────────────────────────────────────────────────────────────

  async #send(cmd, root, { policyKey, timeoutMs, signal, maxBytes } = {}) {
    const query = [
      ["Cmd", cmd],
      ["User", this.username],
      ["DeviceId", this.deviceId],
      ["DeviceType", this.deviceType],
    ]
      .map(([k, value]) => `${k}=${encodeURIComponent(value)}`)
      .join("&");
    const headers = [
      ["Content-Type", "application/vnd.ms-sync.wbxml"],
      ["MS-ASProtocolVersion", this.proto.asVersion],
    ];
    const key = policyKey ?? this.proto.policyKey;
    if (key) headers.push(["X-MS-PolicyKey", key]);
    const body = root ? encode(root) : null;
    if (this.log?.debugEnabled) this.log.debug(`→ ${cmd}`, root ? toDebugString(root, { shown: DEBUG_SHOWN }) : "");

    const resp = await this.#exchange("POST", { query, headers, body, timeoutMs, signal, maxBytes });
    this.#checkHttp(resp, cmd);
    if (resp.status === 449) return { needsProvision: true, doc: null };
    const buf = resp.body;
    if (buf.length === 0) return { needsProvision: false, doc: null };
    if (!looksLikeWbxml(buf)) throw new EasError(ERR.BAD_RESPONSE, `${cmd} : réponse inattendue du serveur.`);
    let doc;
    try {
      doc = decode(buf, { maxBytes: maxBytes ?? DEFAULTS.maxBytes });
    } catch (e) {
      if (e instanceof WbxmlError) throw new EasError(ERR.BAD_RESPONSE, `${cmd} : ${e.message}`);
      throw e;
    }
    if (this.log?.debugEnabled) this.log.debug(`← ${cmd}`, toDebugString(doc, { shown: DEBUG_SHOWN }));
    const status = topStatus(doc);
    if (status === WIPE_STATUS) throw wipeRefused();
    if (DENIED_STATUS.has(status)) {
      throw new EasError(ERR.DENIED, `Le serveur refuse la synchronisation de cet appareil ou de ce compte (Status ${status}).`);
    }
    const needsProvision = status !== null && NEEDS_PROVISION.has(status);
    return { needsProvision, doc };
  }

  /**
   * One command. Provisions transparently (once) when the server asks.
   * Returns the decoded response, or null for an empty body (which
   * ActiveSync uses for "nothing new").
   */
  async command(cmd, root, opts = {}) {
    if (typeof cmd !== "string" || !/^[A-Za-z]{1,32}$/.test(cmd)) throw new EasError(ERR.CONFIG, `Commande invalide : ${cmd}`);
    await this.ensureVersion(opts);
    let result = await this.#send(cmd, root, opts);
    if (result.needsProvision) {
      await this.provision(opts);
      result = await this.#send(cmd, root, opts);
      if (result.needsProvision) throw new EasError(ERR.PROVISION, "Le serveur refuse toujours l'appareil après l'échange de ses règles.");
    }
    return result.doc;
  }

  /** Provision handshake ([MS-ASPROV]): get the policy, acknowledge it, keep the final key. */
  async provision(opts = {}) {
    await this.ensureVersion(opts);
    const deviceInfo =
      this.proto.asVersion === "14.1" ? { model: "Thunderbird", friendlyName: "Sync443", userAgent: this.userAgent } : null;
    const first = await this.#send("Provision", provisionRequest({ deviceInfo }), { ...opts, policyKey: "0" });
    const p1 = parseOrThrow(first.doc);
    if (p1.remoteWipe) throw wipeRefused();
    if (p1.status !== "1") throw new EasError(ERR.PROVISION, `Règles de sécurité refusées par le serveur (Status ${p1.status ?? "absent"}).`);
    if (p1.policyStatus === "2") {
      // No policy for this device.
      this.proto.policyKey = null;
      await this.saveProto({ ...this.proto });
      return;
    }
    if (p1.policyStatus !== "1" || !p1.policyKey) {
      throw new EasError(ERR.PROVISION, `Règles de sécurité inutilisables (Status ${p1.policyStatus ?? "absent"}).`);
    }
    const second = await this.#send("Provision", provisionRequest({ policyKey: p1.policyKey }), { ...opts, policyKey: p1.policyKey });
    const p2 = parseOrThrow(second.doc);
    if (p2.remoteWipe) throw wipeRefused();
    if (p2.status !== "1" || !p2.policyKey) throw new EasError(ERR.PROVISION, "Le serveur n'a pas confirmé l'échange de ses règles de sécurité.");
    this.proto.policyKey = p2.policyKey;
    await this.saveProto({ ...this.proto });
  }
}

function wipeRefused() {
  return new EasError(
    ERR.WIPE_REQUESTED,
    "Le serveur demande l'effacement à distance de cet appareil. Demande refusée : rien n'a été effacé, la synchronisation est arrêtée.",
  );
}

function parseOrThrow(doc) {
  if (!doc) throw new EasError(ERR.PROVISION, "Réponse vide à l'échange des règles de sécurité.");
  try {
    return parseProvision(doc);
  } catch (e) {
    if (e instanceof ProtocolError) throw new EasError(ERR.BAD_RESPONSE, `Provision : ${e.message}`);
    throw e;
  }
}

/**
 * Errors from the verified-connection module: "CODE: reason". Only the
 * code is trusted; the reason is cleaned before it is shown.
 */
function connectorError(e) {
  const m = /^([A-Z_]{2,20}):\s*([\s\S]*)$/.exec(String(e?.message ?? ""));
  const code = m ? m[1] : "";
  const reason = m ? cleanText(m[2], { max: 160, singleLine: true, stripBidi: true }) : "";
  switch (code) {
    case "TLS":
      return new EasError(ERR.TLS, `Connexion refusée : certificat du serveur non valide${reason ? ` (${reason})` : ""}.`);
    case "PERMISSION":
      return new EasError(ERR.CONFIG, "Accès au serveur non autorisé : modifiez la boîte et enregistrez-la.");
    case "PROXY_AUTH":
      return new EasError(ERR.PROXY_AUTH, "Le proxy de ce réseau demande sa propre authentification, ce qui n'est pas encore pris en charge.");
    case "PROXY":
      return new EasError(ERR.NETWORK, "Le proxy de ce réseau refuse la connexion au serveur.");
    case "CONFIG":
      // The client checks every argument it passes: what remains is the
      // connection limit shared by all mailboxes. Temporary: retried later.
      return new EasError(ERR.BUSY, "Connexion momentanément impossible (trop de connexions ouvertes).");
    case "TIMEOUT":
      return new EasError(ERR.TIMEOUT, "Pas de réponse du serveur.");
    default:
      return new EasError(ERR.NETWORK, "Serveur injoignable.");
  }
}

/** Retry-After in seconds or as an HTTP date → milliseconds (capped at one day), or 0. */
export function retryAfter(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return 0;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v), 86_400) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.min(86_400_000, at - now));
}
