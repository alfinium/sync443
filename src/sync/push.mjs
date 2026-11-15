// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Push: the Ping loop ([MS-ASCMD] 2.2.1.13).
 *
 * A Ping waits on the server until one of the watched folders changes or
 * the heartbeat interval runs out. Only the folders of the chosen kinds are
 * watched (in this version: mail; never calendar, contacts or tasks).
 *
 * The heartbeat adapts in both directions:
 *  - it runs out with nothing new (status 1): the network kept the idle
 *    connection, so the next one asks for longer, up to a ceiling;
 *  - the connection dies while waiting (a NAT or proxy dropping idle
 *    connections): the heartbeat is cut, and the ceiling lowered under the
 *    value that failed; after many quiet successes at the ceiling, the
 *    ceiling rises again (the network may have changed);
 *  - status 5: the server's own bound is taken.
 *
 * Two Pings never start less than `minIntervalMs` apart, and errors back
 * off (core/backoff.mjs). A FATAL error (wrong password…) stops the loop
 * and is reported; so does a blocked mailbox (checked before every Ping).
 * stop() really cancels: the Ping in flight is aborted (its connection
 * closed by the client) and the loop ends.
 */

import { pingRequest, parsePing, ProtocolError } from "../core/protocol.mjs";
import { retryDelay } from "../core/backoff.mjs";
import { EasError, ERR, FATAL } from "../transport/client.mjs";

export const PING_DEFAULTS = Object.freeze({
  initialHeartbeat: 480, // seconds
  minHeartbeat: 120,
  maxHeartbeat: 1680,
  step: 120,
  raiseAfter: 10, // quiet expiries at the ceiling before the ceiling rises again
  minIntervalMs: 15_000, // between the starts of two Pings
  cutAfterMs: 60_000, // a connection lost after waiting this long was cut by the network
  marginMs: 60_000, // the client waits this much longer than the heartbeat
  maxBytes: 256 * 1024,
});

const PROTOCOL_MIN = 60;
const PROTOCOL_MAX = 3540;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** The heartbeat interval, in seconds, and how it adapts. */
export class Heartbeat {
  constructor({ initialHeartbeat, minHeartbeat, maxHeartbeat, step, raiseAfter } = PING_DEFAULTS) {
    this.min = clamp(minHeartbeat, PROTOCOL_MIN, PROTOCOL_MAX);
    this.max = clamp(maxHeartbeat, this.min, PROTOCOL_MAX);
    this.step = Math.max(1, step);
    this.raiseAfter = Math.max(1, raiseAfter ?? PING_DEFAULTS.raiseAfter);
    this.ceiling = this.max;
    this.value = clamp(initialHeartbeat, this.min, this.max);
    this.quiet = 0;
  }

  /** Status 1: the interval ran out, nothing new, the connection held. */
  expired() {
    if (this.value + this.step <= this.ceiling) {
      this.value += this.step;
      this.quiet = 0;
      return;
    }
    this.value = this.ceiling;
    if (++this.quiet >= this.raiseAfter && this.ceiling < this.max) {
      this.ceiling = Math.min(this.max, this.ceiling + this.step);
      this.quiet = 0;
    }
  }

  /** The connection died while waiting: shorter from now on. */
  cut() {
    this.ceiling = Math.max(this.min, this.value - this.step);
    this.value = Math.max(this.min, Math.min(this.ceiling, Math.floor((this.value * 2) / 3)));
    this.quiet = 0;
  }

  /** Status 5: the server names the bound it accepts. */
  serverLimit(seconds) {
    if (!Number.isInteger(seconds)) return;
    const s = clamp(seconds, PROTOCOL_MIN, PROTOCOL_MAX);
    if (s < this.value) {
      this.max = Math.max(PROTOCOL_MIN, s);
      this.min = Math.min(this.min, this.max);
    } else if (s > this.value) {
      this.min = s;
      this.max = Math.max(this.max, s);
    }
    this.ceiling = clamp(this.ceiling, this.min, this.max);
    this.value = s;
  }
}

/** setTimeout-based sleep that ends early on abort. */
export function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let finished = false;
    let id = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener?.("abort", finish);
      if (id !== null && typeof clearTimeout === "function") clearTimeout(id);
      resolve();
    };
    id = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener?.("abort", finish);
  });
}

export class PushLoop {
  #o;
  #ctrl = null;
  #done = null;

  /**
   * @param {object} o
   * @param {() => Promise<{command: Function}>} o.clientFactory
   * @param {() => Promise<string[]>} o.folders        CollectionIds to watch (chosen kinds only)
   * @param {(ids: string[]|null) => Promise<any>} o.onChanges   sync these collections (null: everything)
   * @param {() => Promise<{ok: boolean, stop?: boolean, until?: number}>} [o.canPing]   mailbox health
   * @param {(e: Error) => Promise<void>} [o.onFatal]
   * @param {object} [o.log]
   * @param {() => number} [o.now]
   * @param {(ms: number, signal: AbortSignal) => Promise<void>} [o.sleep]
   * @param {object} [o.settings]   overrides of PING_DEFAULTS
   * @param {() => number} [o.random]
   */
  constructor(o) {
    const settings = { ...PING_DEFAULTS, ...(o.settings ?? {}) };
    this.#o = {
      canPing: async () => ({ ok: true }),
      onFatal: async () => {},
      log: null,
      now: () => Date.now(),
      sleep: defaultSleep,
      random: Math.random,
      ...Object.fromEntries(Object.entries(o).filter(([, value]) => value !== undefined)), // undefined: the default
      settings,
    };
    this.heartbeat = new Heartbeat(settings);
    this.maxFolders = Infinity;
  }

  get running() {
    return this.#ctrl !== null;
  }

  start() {
    if (this.#ctrl) return;
    const ctrl = new AbortController();
    this.#ctrl = ctrl;
    this.#done = this.#loop(ctrl.signal)
      .catch((e) => this.#o.log?.error?.(`Ping : arrêt sur erreur inattendue (${String(e?.code ?? e?.name ?? "erreur").slice(0, 60)}).`))
      .finally(() => {
        if (this.#ctrl === ctrl) this.#ctrl = null;
      });
  }

  /** Stop and wait for the loop to end (the Ping in flight is aborted). */
  async stop() {
    const done = this.#done;
    this.#ctrl?.abort();
    await done;
  }

  async #loop(signal) {
    const { clientFactory, folders, canPing, onFatal, log, now, sleep, settings, random } = this.#o;
    let failures = 0;
    let lastStart = -Infinity;
    let emptyRounds = 0;
    while (!signal.aborted) {
      const gate = await canPing();
      if (signal.aborted) break;
      if (!gate?.ok) {
        if (gate?.stop || !Number.isFinite(gate?.until)) {
          log?.info?.("Ping : boîte bloquée, surveillance arrêtée.");
          break;
        }
        await sleep(Math.max(1000, gate.until - now()), signal);
        continue;
      }
      const wait = lastStart + settings.minIntervalMs - now();
      if (wait > 0) {
        await sleep(wait, signal);
        continue;
      }
      let ids = (await folders()).slice(0, this.maxFolders);
      if (!ids.length) {
        // Nothing to watch yet: one full sync to learn the folders, then give up if there is still nothing.
        if (emptyRounds++ >= 1) {
          log?.info?.("Ping : aucun dossier à surveiller, surveillance arrêtée.");
          break;
        }
        lastStart = now();
        await this.#changes(null, signal);
        continue;
      }
      emptyRounds = 0;
      lastStart = now();
      const hb = this.heartbeat.value;
      try {
        const client = await clientFactory();
        const doc = await client.command("Ping", pingRequest(hb, ids.map((id) => ({ id, cls: "Email" }))), {
          signal,
          timeoutMs: hb * 1000 + settings.marginMs,
          maxBytes: settings.maxBytes,
        });
        if (!doc) throw new EasError(ERR.BAD_RESPONSE, "Ping : réponse vide.");
        let r;
        try {
          r = parsePing(doc);
        } catch (e) {
          if (e instanceof ProtocolError) throw new EasError(ERR.BAD_RESPONSE, `Ping : ${e.message}`);
          throw e;
        }
        switch (r.status) {
          case "1":
            this.heartbeat.expired();
            failures = 0;
            break;
          case "2":
            failures = 0;
            await this.#changes(r.folders.length ? r.folders : null, signal);
            break;
          case "3": // parameters missing on the server's side: the next request carries them all again
            failures = 0;
            break;
          case "5":
            this.heartbeat.serverLimit(r.heartbeat);
            log?.debug?.(`Ping : intervalle imposé par le serveur, ${this.heartbeat.value} s.`);
            failures = 0;
            break;
          case "6":
            if (r.maxFolders) this.maxFolders = r.maxFolders;
            log?.info?.(`Ping : le serveur limite la surveillance à ${r.maxFolders ?? "?"} dossiers.`);
            failures = 0;
            break;
          case "7": // folder hierarchy changed
            failures = 0;
            await this.#changes(null, signal);
            break;
          default:
            throw new EasError("SERVER", `Ping : refus du serveur (Status ${r.status ?? "absent"}).`, { status: r.status });
        }
      } catch (e) {
        if (signal.aborted || e?.code === ERR.CANCELLED) break;
        if (FATAL.has(e?.code)) {
          await onFatal(e);
          break;
        }
        const cut = (e?.code === ERR.TIMEOUT || e?.code === ERR.NETWORK) && e?.sent && now() - lastStart >= settings.cutAfterMs;
        if (cut) {
          this.heartbeat.cut();
          log?.info?.(`Ping : connexion coupée en attente, intervalle ramené à ${this.heartbeat.value} s.`);
          failures = 0;
          continue; // retried at once (after the minimal interval), shorter
        }
        failures++;
        log?.info?.(`Ping : ${e instanceof EasError ? String(e.message).slice(0, 200) : String(e?.code ?? e?.name ?? "erreur").slice(0, 60)}`);
        await sleep(retryDelay(failures, { retryAfterMs: e?.retryAfterMs, random }), signal);
      }
    }
  }

  async #changes(ids, signal) {
    if (signal.aborted) return;
    try {
      await this.#o.onChanges(ids);
    } catch (e) {
      // The sync records its own failures (mailbox health); the next gate decides what follows.
      if (e?.code !== ERR.CANCELLED) this.#o.log?.debug?.(`Ping : synchronisation en échec (${e?.code ?? "erreur"}).`);
    }
  }
}
