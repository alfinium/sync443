// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

import { test, assert, eq } from "./harness.mjs";
import { text, child } from "../../src/core/wbxml.mjs";
import { EasError, ERR } from "../../src/transport/client.mjs";
import { Heartbeat, PushLoop, PING_DEFAULTS } from "../../src/sync/push.mjs";
import { FakeServer, quietLog } from "./mail-sync.test.mjs";

// ── Heartbeat ─────────────────────────────────────────────────────────────

test("ping : l'intervalle s'allonge tant que la connexion tient, jusqu'au maximum", () => {
  const hb = new Heartbeat({ initialHeartbeat: 480, minHeartbeat: 120, maxHeartbeat: 900, step: 120, raiseAfter: 3 });
  hb.expired();
  eq(hb.value, 600);
  for (let i = 0; i < 10; i++) hb.expired();
  eq(hb.value, 900);
});

test("ping : une connexion coupée raccourcit l'intervalle et abaisse le plafond", () => {
  const hb = new Heartbeat({ initialHeartbeat: 900, minHeartbeat: 120, maxHeartbeat: 1680, step: 120, raiseAfter: 3 });
  hb.cut();
  eq(hb.value, 600);
  eq(hb.ceiling, 780);
  for (let i = 0; i < 2; i++) hb.expired();
  eq(hb.value, 780, "remonte, mais pas au-delà du plafond");
  hb.expired();
  eq(hb.value, 780);
  for (let i = 0; i < 3; i++) hb.expired();
  eq(hb.ceiling, 900, "après assez de succès au plafond, le plafond remonte (le réseau a pu changer)");
  for (let i = 0; i < 20; i++) hb.cut();
  eq(hb.value, 120, "jamais sous le minimum");
});

test("ping : statut 5, la borne du serveur est prise", () => {
  const hb = new Heartbeat({ initialHeartbeat: 1500, minHeartbeat: 120, maxHeartbeat: 1680, step: 120, raiseAfter: 10 });
  hb.serverLimit(900);
  eq([hb.value, hb.max], [900, 900]);
  hb.expired();
  eq(hb.value, 900, "le maximum du serveur tient");
  const low = new Heartbeat({ initialHeartbeat: 120, minHeartbeat: 120, maxHeartbeat: 1680, step: 120, raiseAfter: 10 });
  low.serverLimit(300);
  eq([low.value, low.min], [300, 300]);
  low.cut();
  eq(low.value, 300, "le minimum du serveur tient aussi");
  low.serverLimit("x");
  eq(low.value, 300);
});

// ── Loop ──────────────────────────────────────────────────────────────────

/** A clock that moves only when the loop sleeps or a Ping waits. */
function harness({ folders = ["1", "6"], canPing } = {}) {
  const server = new FakeServer();
  let t = 1_000_000;
  const sleeps = [];
  const changes = [];
  const fatals = [];
  const log = quietLog();
  let loop;
  const o = {
    clientFactory: async () => server,
    folders: async () => folders,
    onChanges: async (ids) => {
      changes.push(ids);
    },
    canPing: canPing ?? (async () => ({ ok: true })),
    onFatal: async (e) => {
      fatals.push(e.code);
    },
    log,
    now: () => t,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      t += ms;
      if (sleeps.length > 200) loop.stop(); // safety net
    },
    random: () => 0.5,
  };
  loop = new PushLoop(o);
  return { server, loop, sleeps, changes, fatals, log, advance: (ms) => (t += ms), now: () => t };
}

/** Script the server's Pings; the loop stops after the last one. */
function script(h, answers) {
  for (const a of answers) h.server.pings.push(a);
  h.server.pings.push(() => {
    h.loop.stop();
    return { status: "1" };
  });
}

async function finish(h) {
  h.loop.start();
  for (let i = 0; i < 1000 && h.loop.running; i++) await Promise.resolve();
  await h.loop.stop();
}

test("ping : seulement les dossiers donnés, classe Email, intervalle courant", async () => {
  const h = harness();
  script(h, [{ status: "1" }]);
  await finish(h);
  const req = h.server.sent("Ping")[0];
  eq(text(req, "HeartbeatInterval"), String(PING_DEFAULTS.initialHeartbeat));
  const folders = child(req, "Folders").children.map((f) => [text(f, "Id"), text(f, "Class")]);
  eq(folders, [["1", "Email"], ["6", "Email"]]);
  eq(text(h.server.sent("Ping")[1], "HeartbeatInterval"), String(PING_DEFAULTS.initialHeartbeat + PING_DEFAULTS.step));
  const opts = h.server.requests.find((r) => r.cmd === "Ping").opts;
  eq(opts.timeoutMs, PING_DEFAULTS.initialHeartbeat * 1000 + PING_DEFAULTS.marginMs);
  assert(opts.signal, "signal transmis");
});

test("ping : changements signalés → synchro de ces dossiers ; hiérarchie changée → synchro complète", async () => {
  const h = harness();
  script(h, [{ status: "2", folders: ["6"] }, { status: "7" }]);
  await finish(h);
  eq(h.changes, [["6"], null]);
});

test("ping : délai minimal entre deux Ping, même si le serveur répond aussitôt", async () => {
  const h = harness();
  script(h, [{ status: "2", folders: ["1"] }, { status: "2", folders: ["1"] }]);
  await finish(h);
  eq(h.sleeps.filter((ms) => ms > 0).length >= 2, true);
  for (const ms of h.sleeps) assert(ms <= PING_DEFAULTS.minIntervalMs);
  eq(h.sleeps[0], PING_DEFAULTS.minIntervalMs);
});

test("ping : connexion coupée en attente → intervalle raccourci, nouvel essai sans recul", async () => {
  const h = harness();
  script(h, [
    () => {
      h.advance(5 * 60_000); // waited five minutes, then the network dropped the connection
      throw new EasError(ERR.NETWORK, "coupé", { sent: true });
    },
  ]);
  await finish(h);
  const hbs = h.server.sent("Ping").map((r) => Number(text(r, "HeartbeatInterval")));
  eq(hbs[0], 480);
  eq(hbs[1], 320);
  assert(!h.sleeps.some((ms) => ms >= 30_000 && ms !== PING_DEFAULTS.minIntervalMs), "pas de recul d'erreur");
});

test("ping : erreur rapide → recul croissant, intervalle inchangé", async () => {
  const h = harness();
  const fail = () => {
    throw new EasError(ERR.BUSY, "occupé", { retryAfterMs: 0 });
  };
  script(h, [fail, fail]);
  await finish(h);
  const backoffs = h.sleeps.filter((ms) => ms >= 15_000 && ms !== PING_DEFAULTS.minIntervalMs);
  eq(backoffs, [30_000, 60_000]);
  const hbs = h.server.sent("Ping").map((r) => Number(text(r, "HeartbeatInterval")));
  eq(hbs.slice(0, 3), [480, 480, 480]);
});

test("ping : statuts 5 et 6 (bornes du serveur)", async () => {
  const h = harness({ folders: ["1", "6", "2"] });
  script(h, [{ status: "5", heartbeat: 600 }, { status: "6", maxFolders: 2 }]);
  await finish(h);
  const pings = h.server.sent("Ping");
  eq(text(pings[1], "HeartbeatInterval"), "600");
  eq(child(pings[2], "Folders").children.length, 2);
});

test("ping : erreur fatale → signalée, boucle arrêtée", async () => {
  const h = harness();
  h.server.pings.push(() => {
    throw new EasError(ERR.AUTH, "refusé");
  });
  await finish(h);
  eq(h.fatals, ["AUTH"]);
  eq(h.server.sent("Ping").length, 1);
  assert(!h.loop.running);
});

test("ping : boîte bloquée → arrêt ; espacement en cours → attente", async () => {
  let calls = 0;
  const h = harness({
    canPing: async () => {
      calls++;
      if (calls === 1) return { ok: false, until: h.now() + 120_000 };
      if (calls === 2) return { ok: true };
      return { ok: false, stop: true };
    },
  });
  await finish(h);
  eq(h.sleeps[0], 120_000);
  eq(h.server.sent("Ping").length, 1);
  assert(!h.loop.running);
});

test("ping : stop() annule le Ping en cours (signal), et la boucle s'arrête vraiment", async () => {
  const h = harness();
  let started;
  const waiting = new Promise((resolve) => (started = resolve));
  h.server.pings.push((req, opts) =>
    new Promise((resolve, reject) => {
      started(opts.signal);
      opts.signal.addEventListener("abort", () => reject(new EasError(ERR.CANCELLED, "annulé")));
    }),
  );
  h.loop.start();
  const signal = await waiting;
  assert(!signal.aborted);
  await h.loop.stop();
  assert(signal.aborted, "la requête a reçu l'annulation");
  assert(!h.loop.running);
  eq(h.server.sent("Ping").length, 1);
});

test("ping : aucun dossier → une synchro complète, puis arrêt si toujours rien", async () => {
  const h = harness({ folders: [] });
  await finish(h);
  eq(h.changes, [null]);
  eq(h.server.sent("Ping").length, 0);
});

test("ping : une synchro en échec n'arrête pas la boucle", async () => {
  const h = harness();
  h.loop = new PushLoop({
    clientFactory: async () => h.server,
    folders: async () => ["1"],
    onChanges: async () => {
      throw new EasError(ERR.NETWORK, "panne");
    },
    now: () => h.now(),
    sleep: async (ms) => h.advance(ms),
    log: quietLog(),
  });
  script(h, [{ status: "2", folders: ["1"] }]);
  await finish(h);
  eq(h.server.sent("Ping").length, 2);
});

test("ping : options absentes (undefined) → valeurs par défaut", async () => {
  const server = new FakeServer();
  let stop;
  server.pings.push(() => {
    stop();
    return { status: "1" };
  });
  const loop = new PushLoop({ clientFactory: async () => server, folders: async () => ["1"], onChanges: async () => {}, sleep: undefined, now: undefined, log: undefined });
  stop = () => loop.stop();
  loop.start();
  for (let i = 0; i < 100 && loop.running; i++) await Promise.resolve();
  await loop.stop();
  eq(server.sent("Ping").length, 1);
});
