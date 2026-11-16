/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 alfinium */

/**
 * sync443Net: a TLS connection the extension inspects BEFORE it writes.
 *
 * With fetch(), the certificate can only be looked at once the request,
 * password included, has been written. Here the extension gets the verified
 * certificate chain first and decides, in its unprivileged background page,
 * whether to write anything at all.
 *
 *   open({host, port, timeoutMs}) -> {id, route, securityInfo}
 *     1. checks the arguments (a port Gecko bans for https is refused) and
 *        that the extension holds the host permission for https://host/*
 *        (never an arbitrary host or port);
 *     2. asks Thunderbird which proxy it would use for https://host:port/
 *        (its own settings, the system's, PAC);
 *     3. connects: directly, through SOCKS (handled by Gecko), or through an
 *        HTTP proxy tunnel (CONNECT request written and its answer read here,
 *        strictly bounded);
 *     4. completes the TLS handshake, verified by Gecko against `host` (the
 *        target, also through a tunnel), and waits for it to be COMPLETE.
 *        Only a connection Gecko itself judges secure, with a verified
 *        chain, is handed over. Anything else is a "TLS:" rejection, never a
 *        connection: a chain Gecko refuses, one it accepts only through a
 *        certificate exception, a "broken"/"weak" connection, no verified
 *        chain. Connections are anonymous (ANONYMOUS_CONNECT): no client
 *        certificate is ever sent or asked for, and their TLS sessions are
 *        kept apart from Thunderbird's own;
 *     5. returns the verified chain, shaped like
 *        webRequest.getSecurityInfo(id, {certificateChain: true}).
 *     Not one application byte has been written at that point.
 *   write(id, bytes): at most 1 MiB per call, one write at a time per
 *     connection (larger bodies are written in sequence).
 *   read(id, {maxBytes, timeoutMs}): the next bytes, or null at the end of
 *     the stream. null only means the peer closed the connection (possibly
 *     without a TLS close_notify): it is NOT an authenticated end of message.
 *     The HTTP client must frame the body (Content-Length or chunked) and
 *     refuse one cut short; core/http1.mjs does.
 *   close(id).
 *   The host permission is checked again on every write() and read(): once
 *   it is gone, the connection is closed.
 *
 * Who can call it: only the background page's context is accepted. That is
 * defence in depth, not a boundary: any page of the extension can reach the
 * background page's `browser` object (runtime.getBackgroundPage(), or a
 * message the background acts upon). The trust boundary is the extension
 * as a whole, as for its host permissions.
 *
 * All socket I/O happens on Gecko's socket thread: the streams are the
 * buffered ones (pipes filled and drained by Gecko's stream copiers), as in
 * Thunderbird's own modules. Their sizes bound memory and give backpressure:
 * at most 2 MiB received and not yet read by the extension (Gecko stops
 * reading from the network beyond that), at most 256 KiB written and not
 * yet sent.
 *
 * Every refusal is an ExtensionError "CODE: reason" (codes: CONFIG,
 * PERMISSION, PROXY_AUTH, PROXY, TLS, NETWORK, TIMEOUT, CLOSED). No message
 * carries anything the extension wrote, or anything secret.
 */

"use strict";

/* global ExtensionCommon, ChromeUtils, Services, Cc, Ci, Cr */

// Loaded into the extension's experiment global, shared with other
// experiment scripts of the same extension: only this name is defined there.
// eslint-disable-next-line no-var, no-unused-vars
var sync443Net = (() => {
  const { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
  const { ExtensionError } = ExtensionUtils;
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

  const MAX_SOCKETS = 16; // per extension
  const IN_SEGMENT = 64 * 1024;
  const IN_SEGMENTS = 32; // 2 MiB received and not yet read
  const OUT_SEGMENT = 64 * 1024;
  const OUT_SEGMENTS = 4; // 256 KiB written and not yet sent
  const MAX_READ = 1024 * 1024;
  const MAX_WRITE = 1024 * 1024; // per call; the client writes larger bodies in sequence
  const MAX_PROXY_ANSWER = 16 * 1024; // status line and headers of the proxy's answer to CONNECT
  const DEFAULT_OPEN_MS = 30000;
  const MAX_OPEN_MS = 120000;
  const DEFAULT_READ_MS = 60000;
  const WRITE_STALL_MS = 60000; // a write that makes no progress for this long fails
  const POLL_FIRST_MS = 15; // handshake polling: 15 ms, growing to 250 ms
  const POLL_MAX_MS = 250;

  const socketService = Cc["@mozilla.org/network/socket-transport-service;1"].getService(Ci.nsISocketTransportService);
  const proxyService = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(Ci.nsIProtocolProxyService);
  const nssErrors = Cc["@mozilla.org/nss_errors_service;1"].getService(Ci.nsINSSErrorsService);
  const binaryReader = (stream) => {
    const reader = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    reader.setInputStream(stream);
    return reader;
  };
  /** A stream over a COPY of the bytes (setData copies them): the only private copy. */
  const bytesStream = ({ buffer, offset, length }) => {
    const stream = Cc["@mozilla.org/io/arraybuffer-input-stream;1"].createInstance(Ci.nsIArrayBufferInputStream);
    try {
      stream.setData(buffer, offset, length);
    } catch {
      throw fail("CONFIG", "octets invalides");
    }
    return stream;
  };

  const fail = (code, reason) => new ExtensionError(`${code}: ${reason}`);
  const closedError = () => fail("CLOSED", "connexion inconnue ou fermée");
  const failed = (status) => status >>> 31 === 1;

  /** Name of an XPCOM error ("NS_ERROR_CONNECTION_REFUSED"), never free text. */
  function errorName(status) {
    try {
      const name = ChromeUtils.getXPCOMErrorName(status);
      if (/^[A-Z0-9_]{1,64}$/.test(name)) return name;
    } catch {
      // older versions: the code alone
    }
    return `0x${(status >>> 0).toString(16)}`;
  }

  /** NSS error class of an XPCOM status (bad certificate or other), or null when it is not a TLS error. */
  function errorClassOf(status) {
    try {
      return nssErrors.getErrorClass(status);
    } catch {
      return null;
    }
  }

  // ── Arguments ─────────────────────────────────────────────────────────

  const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
  const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
  const IPV6 = /^\[[0-9a-f:.]{2,45}\]$/;

  const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const intIn = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

  /** → {host, socketHost, port, authority, uri, timeoutMs}, or CONFIG. */
  function openOptions(options) {
    if (!plainObject(options)) throw fail("CONFIG", "options manquantes");
    const { host, port } = options;
    const timeoutMs = options.timeoutMs ?? DEFAULT_OPEN_MS;
    if (typeof host !== "string" || !(HOSTNAME.test(host) || IPV4.test(host) || IPV6.test(host))) {
      throw fail("CONFIG", "nom de serveur invalide");
    }
    if (!intIn(port, 1, 65535)) throw fail("CONFIG", "port invalide");
    // Ports Gecko bans for https (other protocols' ports, such as 25 or 6667).
    if (!Services.io.allowPort(port, "https")) throw fail("CONFIG", "port interdit par Thunderbird");
    if (!intIn(timeoutMs, 1000, MAX_OPEN_MS)) throw fail("CONFIG", "délai invalide");
    // The name must already be in the canonical form an https:// origin has:
    // no "127.1", no "[::ffff:127.0.0.1]", no "0x7f.0.0.1", no IDN.
    let uri;
    try {
      uri = Services.io.newURI(`https://${host}:${port}/`);
    } catch {
      throw fail("CONFIG", "nom de serveur invalide");
    }
    const hostPort = port === 443 ? host : `${host}:${port}`;
    if (uri.scheme !== "https" || uri.hostPort !== hostPort || uri.pathQueryRef !== "/" || uri.userPass !== "") {
      throw fail("CONFIG", "nom de serveur non canonique");
    }
    const socketHost = host.startsWith("[") ? host.slice(1, -1) : host;
    return { host, socketHost, port, authority: `${host}:${port}`, uri, timeoutMs };
  }

  function readOptions(options) {
    if (options !== undefined && options !== null && !plainObject(options)) throw fail("CONFIG", "options invalides");
    const maxBytes = options?.maxBytes ?? MAX_READ;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_READ_MS;
    if (!intIn(maxBytes, 1, MAX_READ)) throw fail("CONFIG", "taille de lecture invalide");
    if (!intIn(timeoutMs, 1, 600000)) throw fail("CONFIG", "délai invalide");
    return { maxBytes, timeoutMs };
  }

  /** The bytes to write: a Uint8Array or an ArrayBuffer of at most MAX_WRITE bytes (no copy yet). */
  function bytesToWrite(value) {
    const tag = Object.prototype.toString.call(value);
    let chunk;
    if (tag === "[object Uint8Array]") chunk = { buffer: value.buffer, offset: value.byteOffset, length: value.byteLength };
    else if (tag === "[object ArrayBuffer]") chunk = { buffer: value, offset: 0, length: value.byteLength };
    else throw fail("CONFIG", "octets invalides (Uint8Array ou ArrayBuffer attendu)");
    if (Object.prototype.toString.call(chunk.buffer) !== "[object ArrayBuffer]") throw fail("CONFIG", "octets invalides");
    if (!intIn(chunk.length, 0, MAX_WRITE)) throw fail("CONFIG", `écriture trop grande (${MAX_WRITE} octets au plus par appel)`);
    return chunk;
  }

  // ── Context and permission ────────────────────────────────────────────

  function checkContext(context) {
    if (context.viewType !== "background" || context.unloaded) {
      throw fail("PERMISSION", "réservé à la page d'arrière-plan de l'extension");
    }
  }

  /** Does the extension hold, right now, the host permission for this https:// origin? */
  function holdsPermission(context, uri) {
    try {
      const policy = context.extension?.policy;
      return !!policy && policy.active && policy.allowedOrigins.matches(uri);
    } catch {
      return false;
    }
  }

  // ── Proxy ─────────────────────────────────────────────────────────────

  /** The proxy Thunderbird would use for https://host:port/: nsIProxyInfo, or null for none. */
  function resolveProxy(uri, ms) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let request = null;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          request?.cancel(Cr.NS_ERROR_ABORT);
        } catch {
          // already finished
        }
        reject(fail("TIMEOUT", "le choix du proxy n'aboutit pas"));
      }, ms);
      const callback = {
        QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyCallback"]),
        onProxyAvailable(_request, _target, proxyInfo, status) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (failed(status)) reject(fail("PROXY", `configuration du proxy inutilisable (${errorName(status)})`));
          else resolve(proxyInfo ?? null);
        },
      };
      try {
        request = proxyService.asyncResolve(uri, 0, callback);
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(fail("PROXY", `configuration du proxy inutilisable (${errorName(e?.result ?? Cr.NS_ERROR_FAILURE)})`));
      }
    });
  }

  /** → {route, proxyInfo} for the transport. Only the first proxy is used (no failover). */
  function routeOf(proxyInfo) {
    const type = proxyInfo?.type ?? "direct";
    if (type === "direct") return { route: "direct", proxyInfo: null };
    if (type === "socks" || type === "socks4") return { route: "socks", proxyInfo };
    if (type === "http") return { route: "http-proxy", proxyInfo };
    if (type === "https") throw fail("PROXY", "proxy HTTPS non pris en charge");
    throw fail("PROXY", "type de proxy non pris en charge");
  }

  // ── Certificate information ───────────────────────────────────────────

  /**
   * Fail closed: only a connection Gecko judges secure, whose chain it
   * verified itself, goes to the extension. Refused: a chain accepted only
   * through a certificate exception (overridable error, or the
   * "user overridden" flag), a connection Gecko calls broken or weak (an
   * obsolete TLS version, for one), no verified chain.
   */
  function refuseUnlessVerified(info) {
    const wpl = Ci.nsIWebProgressListener;
    const state = info.securityState;
    if (info.overridableErrorCategory || state & wpl.STATE_CERT_USER_OVERRIDDEN) {
      throw fail("TLS", "certificat accepté seulement par une exception de sécurité de Thunderbird");
    }
    if (!(state & wpl.STATE_IS_SECURE) || state & wpl.STATE_IS_BROKEN) {
      throw fail("TLS", "connexion jugée non sûre par Thunderbird (version ou paramètres TLS obsolètes)");
    }
    if (!(info.succeededCertChain?.length > 0)) throw fail("TLS", "aucune chaîne de certificats vérifiée");
  }

  /**
   * A verified nsITransportSecurityInfo → plain data, the shape
   * webRequest.getSecurityInfo gives with {certificateChain: true}. Only the
   * VERIFIED chain is returned; isBuiltInRoot is true only on its last
   * certificate, and only when Gecko reports that root as one of its
   * built-in roots. The other fields are fixed by refuseUnlessVerified().
   */
  function describe(info) {
    const T = Ci.nsITransportSecurityInfo;
    const chain = Array.from(info.succeededCertChain);
    const rootIsBuiltIn = info.isBuiltCertChainRootBuiltInRoot === true;
    return {
      state: "secure",
      isUntrusted: false,
      isDomainMismatch: false,
      isNotValidAtThisTime: false,
      protocolVersion:
        info.protocolVersion === T.TLS_VERSION_1_3 ? "TLSv1.3" : info.protocolVersion === T.TLS_VERSION_1_2 ? "TLSv1.2" : "unknown",
      certificates: chain.map((cert, i) => ({
        subject: String(cert.subjectName ?? ""),
        issuer: String(cert.issuerName ?? ""),
        fingerprint: { sha256: String(cert.sha256Fingerprint ?? "") },
        isBuiltInRoot: rootIsBuiltIn && i === chain.length - 1,
      })),
    };
  }

  // ── One connection ────────────────────────────────────────────────────

  class Connection {
    constructor(owner, context, id, target) {
      this.owner = owner;
      this.context = context;
      this.id = id;
      this.target = target;
      this.state = "opening"; // → "open" → "closed"
      this.transport = null;
      this.input = null; // nsIAsyncInputStream (pipe filled from the socket)
      this.output = null; // nsIAsyncOutputStream (pipe drained to the socket)
      this.reader = null;
      this.waiters = new Set(); // rejecters of pending waits, called on close
      this.reading = false;
      this.writing = false;
    }

    alive() {
      if (this.state === "closed") throw closedError();
    }

    /** Still open, and the extension still holds the host permission (else: closed). */
    allowed() {
      this.alive();
      if (!holdsPermission(this.context, this.target.uri)) {
        this.close();
        throw fail("PERMISSION", "l'extension n'a plus accès à ce serveur");
      }
    }

    connect(route, ms) {
      const { socketHost, port } = this.target;
      // "ssl": TLS from the first byte (direct, or above Gecko's SOCKS layer).
      // "starttls": plain until asyncStartTLS(), for the CONNECT exchange.
      // Either way the TLS layer is given `socketHost` (the target), so
      // Gecko verifies the certificate against it and sends it as SNI.
      const types = route.route === "http-proxy" ? ["starttls"] : ["ssl"];
      const transport = socketService.createTransport(types, socketHost, port, route.proxyInfo, null);
      // No client certificate (and so no prompt), and a TLS session cache
      // separate from Thunderbird's own connections.
      transport.connectionFlags = Ci.nsISocketTransport.ANONYMOUS_CONNECT;
      this.transport = transport;
      transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_CONNECT, Math.max(1, Math.ceil(ms / 1000)));
      this.output = transport.openOutputStream(0, OUT_SEGMENT, OUT_SEGMENTS).QueryInterface(Ci.nsIAsyncOutputStream);
      this.input = transport.openInputStream(0, IN_SEGMENT, IN_SEGMENTS).QueryInterface(Ci.nsIAsyncInputStream);
      this.reader = binaryReader(this.input);
    }

    /** Resolves when the stream is ready (true) or after `ms` (false); rejects if closed meanwhile. */
    wait(stream, ms) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (value, error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.waiters.delete(onClose);
          if (error) reject(error);
          else resolve(value);
        };
        const onClose = (error) => done(false, error);
        const timer = setTimeout(() => {
          try {
            stream.asyncWait(null, 0, 0, null);
          } catch {
            // closed
          }
          done(false);
        }, Math.max(0, ms));
        this.waiters.add(onClose);
        const callback =
          stream === this.input
            ? { onInputStreamReady: () => done(true) }
            : { onOutputStreamReady: () => done(true) };
        try {
          stream.asyncWait(callback, 0, 0, Services.tm.mainThread);
        } catch {
          done(true); // closed: the caller finds out why
        }
      });
    }

    /** {avail} or {status} (NS_BASE_STREAM_CLOSED at the end of the stream). */
    peek() {
      try {
        return { avail: this.input.available() };
      } catch (e) {
        return { status: e?.result ?? Cr.NS_ERROR_FAILURE };
      }
    }

    take(count) {
      const buffer = new ArrayBuffer(count);
      const got = this.reader.readArrayBuffer(count, buffer);
      return new Uint8Array(buffer, 0, Number(got));
    }

    /** The error for a failed stream status: TLS (Gecko refused the certificate or the handshake), proxy, network. */
    async failure(status, viaProxy = false) {
      if (status === Cr.NS_BASE_STREAM_CLOSED) {
        return fail(viaProxy ? "PROXY" : "NETWORK", "connexion fermée par l'autre partie");
      }
      if (status === Cr.NS_ERROR_NET_TIMEOUT) return fail("TIMEOUT", "le serveur ne répond pas");
      let info = null;
      try {
        info = await this.transport?.tlsSocketControl?.asyncGetSecurityInfo();
      } catch {
        info = null;
      }
      let errorClass = errorClassOf(status);
      // Thunderbird 140 reports a refused certificate as a reset connection;
      // the TLS layer keeps the real error.
      if (errorClass === null && info?.errorCode && nssErrors.isNSSErrorCode(info.errorCode)) {
        errorClass = errorClassOf(nssErrors.getXPCOMFromNSSError(info.errorCode));
      }
      if (errorClass !== null) {
        const code = /^[A-Z0-9_]{1,64}$/.test(info?.errorCodeString ?? "") ? info.errorCodeString : "";
        const what =
          errorClass === Ci.nsINSSErrorsService.ERROR_CLASS_BAD_CERT
            ? "certificat du serveur refusé par Thunderbird"
            : "échec de la négociation TLS";
        return fail("TLS", code ? `${what} (${code})` : what);
      }
      const name = errorName(status);
      if (/PROXY|SOCKS/.test(name)) return fail("PROXY", `proxy injoignable ou refusant la connexion (${name})`);
      if (status === Cr.NS_ERROR_UNKNOWN_HOST) return fail("NETWORK", "nom du serveur introuvable");
      if (status === Cr.NS_ERROR_CONNECTION_REFUSED) return fail(viaProxy ? "PROXY" : "NETWORK", "connexion refusée");
      return fail("NETWORK", `connexion interrompue (${name})`);
    }

    /** Writes all of `chunk` into the outgoing pipe, waiting for room as needed. */
    async put(chunk, deadline = 0) {
      const source = bytesStream(chunk);
      let left = chunk.length;
      let stall = Date.now() + WRITE_STALL_MS;
      while (left > 0) {
        if (deadline) this.alive();
        else this.allowed();
        let written = 0;
        try {
          written = this.output.writeFrom(source, left);
        } catch (e) {
          const status = e?.result ?? Cr.NS_ERROR_FAILURE;
          if (status !== Cr.NS_BASE_STREAM_WOULD_BLOCK) throw await this.failure(status);
        }
        if (written > 0) {
          left -= written;
          stall = Date.now() + WRITE_STALL_MS;
          continue;
        }
        const until = deadline || stall;
        const ms = until - Date.now();
        if (ms <= 0) throw fail("TIMEOUT", "le serveur ne reçoit plus les données");
        await this.wait(this.output, ms);
      }
    }

    /** HTTP proxy: the CONNECT request, then its answer (strictly bounded), before any TLS byte. */
    async tunnel(deadline) {
      const { authority } = this.target;
      const request = Uint8Array.from(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`, (c) => c.charCodeAt(0));
      await this.put({ buffer: request.buffer, offset: 0, length: request.length }, deadline);
      let answer = new Uint8Array(0);
      for (;;) {
        this.alive();
        const s = this.peek();
        if (s.status !== undefined) throw await this.failure(s.status, true);
        if (s.avail > 0) {
          const room = MAX_PROXY_ANSWER - answer.length;
          const chunk = this.take(Math.min(s.avail, room));
          const joined = new Uint8Array(answer.length + chunk.length);
          joined.set(answer);
          joined.set(chunk, answer.length);
          answer = joined;
          const end = endOfHead(answer);
          if (end >= 0) {
            // Nothing may follow the answer before our TLS ClientHello.
            if (end !== answer.length || this.peek().avail > 0) throw fail("PROXY", "données inattendues du proxy");
            return proxyVerdict(answer);
          }
          if (answer.length >= MAX_PROXY_ANSWER) throw fail("PROXY", "réponse du proxy trop longue");
          continue;
        }
        const ms = deadline - Date.now();
        if (ms <= 0) throw fail("TIMEOUT", "le proxy ne répond pas");
        await this.wait(this.input, ms);
      }
    }

    async startTls(deadline) {
      const control = this.transport.tlsSocketControl;
      if (!control) throw fail("NETWORK", "connexion TLS indisponible");
      const ms = deadline - Date.now();
      if (ms <= 0) throw fail("TIMEOUT", "négociation TLS trop longue");
      let timer;
      try {
        await Promise.race([
          control.asyncStartTLS(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(fail("TIMEOUT", "négociation TLS trop longue")), ms);
          }),
        ]);
      } catch (e) {
        if (e instanceof ExtensionError) throw e;
        throw fail("TLS", "échec du démarrage de TLS");
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * Waits until the handshake is COMPLETE (Gecko has verified the chain and
     * the TLS session is established), the connection fails, or the deadline.
     * The handshake is driven by Gecko on its socket thread (the stream copier
     * reads from the socket); its end is observed through the security info.
     */
    async handshake(deadline) {
      const wpl = Ci.nsIWebProgressListener;
      let pause = POLL_FIRST_MS;
      for (;;) {
        this.alive();
        const s = this.peek();
        if (s.status !== undefined) throw await this.failure(s.status);
        if (s.avail > 0) throw fail("TLS", "données reçues avant toute requête");
        const control = this.transport.tlsSocketControl;
        let info = null;
        if (control) {
          try {
            info = await control.asyncGetSecurityInfo();
          } catch {
            info = null;
          }
          this.alive();
        }
        if (info && info.errorCode && nssErrors.isNSSErrorCode(info.errorCode)) {
          const code = /^[A-Z0-9_]{1,64}$/.test(info.errorCodeString ?? "") ? ` (${info.errorCodeString})` : "";
          throw fail("TLS", `certificat ou négociation TLS refusés par Thunderbird${code}`);
        }
        if (info && info.securityState & (wpl.STATE_IS_SECURE | wpl.STATE_IS_BROKEN)) {
          // Complete: is it a connection Gecko verified and judges secure?
          refuseUnlessVerified(info);
          // Bytes already waiting would have come before our first byte,
          // possibly in clear before TLS started: refused.
          const after = this.peek();
          if (after.avail > 0) throw fail("TLS", "données reçues avant toute requête");
          if (after.status !== undefined) throw await this.failure(after.status);
          return info;
        }
        const ms = deadline - Date.now();
        if (ms <= 0) throw fail("TIMEOUT", "négociation TLS trop longue");
        await this.wait(this.input, Math.min(ms, pause));
        pause = Math.min(POLL_MAX_MS, Math.ceil(pause * 1.5));
      }
    }

    async read({ maxBytes, timeoutMs }) {
      if (this.reading) throw fail("CONFIG", "une lecture est déjà en cours sur cette connexion");
      this.reading = true;
      try {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          this.allowed();
          const s = this.peek();
          if (s.status === Cr.NS_BASE_STREAM_CLOSED) return null;
          if (s.status !== undefined) {
            const error = await this.failure(s.status);
            this.close();
            throw error;
          }
          if (s.avail > 0) return this.take(Math.min(s.avail, maxBytes));
          const ms = deadline - Date.now();
          if (ms <= 0) throw fail("TIMEOUT", "pas de réponse du serveur");
          await this.wait(this.input, ms);
        }
      } finally {
        this.reading = false;
      }
    }

    /** One write at a time: memory held for writes stays bounded (one 1 MiB copy, the 256 KiB pipe). */
    async write(chunk) {
      if (this.writing) throw fail("CONFIG", "une écriture est déjà en cours sur cette connexion");
      this.writing = true;
      try {
        await this.put(chunk);
      } catch (e) {
        if (!(e instanceof ExtensionError) || !/^(?:TIMEOUT|CLOSED|PERMISSION):/.test(e.message)) this.close();
        throw e instanceof ExtensionError ? e : fail("NETWORK", "écriture impossible");
      } finally {
        this.writing = false;
      }
    }

    close() {
      if (this.state === "closed") return;
      this.state = "closed";
      this.owner.connections.delete(this.id);
      for (const reject of [...this.waiters]) reject(closedError());
      this.waiters.clear();
      for (const stream of [this.input, this.output]) {
        try {
          stream?.close();
        } catch {
          // already closed
        }
      }
      try {
        this.transport?.close(Cr.NS_BINDING_ABORTED);
      } catch {
        // already closed
      }
    }
  }

  /** Index just past "\r\n\r\n", or -1. */
  function endOfHead(bytes) {
    for (let i = 3; i < bytes.length; i++) {
      if (bytes[i] === 10 && bytes[i - 1] === 13 && bytes[i - 2] === 10 && bytes[i - 3] === 13) return i + 1;
    }
    return -1;
  }

  /** The proxy's answer to CONNECT: only "200" opens the tunnel. */
  function proxyVerdict(head) {
    let lineEnd = head.indexOf(13);
    if (lineEnd < 0) lineEnd = head.length;
    let line = "";
    for (let i = 0; i < lineEnd; i++) line += String.fromCharCode(head[i]);
    const m = /^HTTP\/1\.[01] ([0-9]{3})(?: [\t\x20-\x7e\x80-\xff]*)?$/.exec(line);
    if (!m) throw fail("PROXY", "réponse du proxy invalide");
    const status = Number(m[1]);
    if (status === 200) return;
    if (status === 407) throw fail("PROXY_AUTH", "le proxy demande une authentification, non prise en charge");
    throw fail("PROXY", `le proxy refuse la connexion (HTTP ${status})`);
  }

  // ── The API ───────────────────────────────────────────────────────────

  return class extends ExtensionCommon.ExtensionAPI {
    connections = new Map();

    onShutdown() {
      for (const connection of [...this.connections.values()]) connection.close();
    }

    getAPI(context) {
      const api = this;
      context.callOnClose({
        close() {
          for (const connection of [...api.connections.values()]) {
            if (connection.context === context) connection.close();
          }
        },
      });

      const find = (id) => {
        checkContext(context);
        const connection = typeof id === "string" ? api.connections.get(id) : undefined;
        if (!connection || connection.context !== context || connection.state !== "open") throw closedError();
        connection.allowed();
        return connection;
      };

      return {
        sync443Net: {
          async open(options) {
            checkContext(context);
            const target = openOptions(options);
            if (!holdsPermission(context, target.uri)) {
              throw fail("PERMISSION", "l'extension n'a pas accès à ce serveur");
            }
            if (api.connections.size >= MAX_SOCKETS) {
              throw fail("CONFIG", `trop de connexions ouvertes (${MAX_SOCKETS} au plus)`);
            }
            const id = Services.uuid.generateUUID().toString().slice(1, -1);
            const connection = new Connection(api, context, id, target);
            api.connections.set(id, connection);
            const deadline = Date.now() + target.timeoutMs;
            try {
              const route = routeOf(await resolveProxy(target.uri, deadline - Date.now()));
              connection.alive();
              connection.connect(route, deadline - Date.now());
              if (route.route === "http-proxy") {
                await connection.tunnel(deadline);
                connection.alive();
                await connection.startTls(deadline);
              }
              const info = await connection.handshake(deadline);
              connection.allowed();
              const securityInfo = describe(info);
              connection.state = "open";
              return { id, route: route.route, securityInfo };
            } catch (e) {
              connection.close();
              if (e instanceof ExtensionError) throw e;
              throw fail("NETWORK", `connexion impossible (${errorName(e?.result ?? Cr.NS_ERROR_FAILURE)})`);
            }
          },

          async write(id, bytes) {
            const connection = find(id);
            const chunk = bytesToWrite(bytes);
            if (!chunk.length) return;
            await connection.write(chunk);
          },

          async read(id, options) {
            const connection = find(id);
            return connection.read(readOptions(options));
          },

          async close(id) {
            checkContext(context);
            const connection = typeof id === "string" ? api.connections.get(id) : undefined;
            if (connection && connection.context === context) connection.close();
          },
        },
      };
    }
  };
})();
