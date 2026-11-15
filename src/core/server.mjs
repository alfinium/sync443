// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * The server address the user types ("mail.example.com"). The ActiveSync
 * endpoint is always https://<host>[:port]/Microsoft-Server-ActiveSync.
 *
 * Strict on purpose: the password will be sent to this origin and only to
 * it. HTTPS only, no credentials in the address, no wildcard, and never
 * this machine itself (except, in test builds, the local test server, still
 * over HTTPS with a test certificate the test mailbox pins explicitly).
 *
 * Limit: a public DNS name may resolve to this machine (e.g. *.nip.io);
 * that cannot be seen from the name. The certificate check still applies.
 */

export const EAS_PATH = "/Microsoft-Server-ActiveSync";

export class ServerAddressError extends Error {
  constructor(message) {
    super(message);
    this.name = "ServerAddressError";
  }
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isIPv4(host) {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && String(Number(p)) === p);
}

/**
 * The URL parser reads a host whose last label is a number as an IPv4
 * address, in any old notation ("127.1", "0x7f.0.0.1", "0177.0.0.1"): such
 * a host is accepted only in the canonical dotted-quad form.
 */
const endsInNumber = (host) => /^(?:\d+|0x[0-9a-f]*)$/i.test(host.slice(host.lastIndexOf(".") + 1));

/** The eight 16-bit groups of an IPv6 literal "[…]", or null if it is not a valid one. */
function ipv6Groups(literal) {
  let s = literal.slice(1, -1);
  let v4 = [];
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    if (!isIPv4(m[2])) return null;
    const [a, b, c, d] = m[2].split(".").map(Number);
    v4 = [(a << 8) | b, (c << 8) | d];
    s = m[1].endsWith("::") ? m[1] : m[1].slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const [head, tail = []] = halves.map((h) => (h ? h.split(":") : []));
  if (![...head, ...tail].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  const missing = 8 - head.length - tail.length - v4.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const hex = (list) => list.map((g) => parseInt(g, 16));
  return [...hex(head), ...Array(halves.length === 2 ? missing : 0).fill(0), ...hex(tail), ...v4];
}

/**
 * Canonical text of an IPv6 address (RFC 5952, as the WHATWG URL parser
 * writes it): lower case, no leading zeros, the first longest run of two or
 * more zero groups as "::", never an embedded IPv4 form. Thunderbird gives
 * request URLs in this form, so the origin must be written the same way for
 * the certificate check to recognise the server.
 */
function ipv6Text(g) {
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (list) => list.map((x) => x.toString(16)).join(":");
  if (bestLen < 2) return hex(g);
  return `${hex(g.slice(0, best))}::${hex(g.slice(best + bestLen))}`;
}

/** Names that the usual hosts files map to this machine. */
const LOCAL_ALIASES = /^(?:localhost[46]?|ip6-localhost|ip6-loopback)(?:\.localdomain[46]?)?$/;

/** ::, ::1, and IPv4-mapped or -compatible forms of 0.x.x.x and 127.x.x.x. */
const isLocalIPv6 = (g) => g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff) && [0, 127].includes(g[6] >> 8);

function toAsciiHost(host) {
  if (/^[\x00-\x7f]*$/.test(host)) return host.toLowerCase();
  // Internationalised name: Thunderbird's URL parser gives the punycode form.
  if (typeof URL !== "function") return null;
  try {
    return new URL(`https://${host}/`).hostname;
  } catch {
    return null;
  }
}

/**
 * @param {string} input what the user typed
 * @param {{allowLocal?: boolean}} options test builds only: accept this machine as server
 * @returns {{host: string, port: number|null, origin: string, url: string, display: string}}
 */
export function parseServer(input, { allowLocal = false } = {}) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new ServerAddressError("Indiquez le serveur, par exemple mail.exemple.com.");
  if (/\s/.test(raw)) throw new ServerAddressError("L'adresse du serveur ne doit pas contenir d'espace.");

  let rest = raw;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (scheme) {
    if (scheme[1].toLowerCase() !== "https") throw new ServerAddressError("Le serveur doit être joignable en HTTPS.");
    rest = rest.slice(scheme[0].length);
  }
  const authority = rest.split(/[/?#]/, 1)[0];
  if (authority.includes("@")) {
    throw new ServerAddressError("L'adresse du serveur ne doit pas contenir d'identifiant ni de mot de passe.");
  }

  let host;
  let portText = null;
  let groups = null;
  const v6 = /^(\[[0-9a-f:.]+\])(?::(\d+))?$/i.exec(authority);
  if (v6) {
    host = v6[1].toLowerCase();
    portText = v6[2] ?? null;
    groups = ipv6Groups(host);
    if (!groups) throw new ServerAddressError(`Serveur invalide : ${raw}`);
    host = `[${ipv6Text(groups)}]`;
  } else {
    const m = /^([^:]+)(?::(\d+))?$/.exec(authority);
    if (!m) throw new ServerAddressError(`Serveur invalide : ${raw}`);
    host = toAsciiHost(m[1]);
    portText = m[2] ?? null;
    if (!host) throw new ServerAddressError(`Serveur invalide : ${raw}`);
    host = host.replace(/\.$/, "");
    const labels = host.split(".");
    const valid =
      isIPv4(host) ||
      (!endsInNumber(host) && host.length <= 253 && labels.every((l) => LABEL.test(l)) && (labels.length >= 2 || host === "localhost"));
    if (!valid) throw new ServerAddressError(`Serveur invalide : ${raw}`);
  }

  let port = null;
  if (portText !== null) {
    port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ServerAddressError(`Port invalide : ${portText}`);
  }
  // This machine itself is never a mail server outside tests: a local
  // program listening there would receive the password.
  // "*.localhost" resolves to this machine too, and so does 0.0.0.0.
  const loopback =
    LOCAL_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    LOCAL_ALIASES.test(host) ||
    (isIPv4(host) && (host.startsWith("127.") || host.startsWith("0."))) ||
    (groups !== null && isLocalIPv6(groups));
  if (loopback && !allowLocal) throw new ServerAddressError(`Serveur invalide : ${raw}`);

  const hostPort = port && port !== 443 ? `${host}:${port}` : host;
  const origin = `https://${hostPort}`;
  // Where Thunderbird's URL parser is available, it must read the origin
  // exactly as written here: the certificate check matches requests by origin.
  if (typeof URL === "function") {
    let parsed = null;
    try {
      parsed = new URL(origin + EAS_PATH).origin;
    } catch {
      parsed = null;
    }
    if (parsed !== origin) throw new ServerAddressError(`Serveur invalide : ${raw}`);
  }
  return { host, port, origin, url: origin + EAS_PATH, display: hostPort };
}
