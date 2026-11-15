// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * src/log.mjs: privacy-safe ring log, debugging that switches itself off.
 * Storage, clock and timer are doubles. Unusual characters are written as
 * \u escapes, never literally.
 */

import { test, eq, assert } from "./harness.mjs";
import { createLog, MAX_ENTRIES, MAX_MESSAGE, MAX_DETAILS, MAX_DEBUG_MS, LOG_KEY, SETTINGS_KEY, WRITE_DELAY_MS } from "../../src/log.mjs";

/** storage.local double: JSON round trip, every set() recorded. */
function memoryArea(initial = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const sets = [];
  return {
    data,
    sets,
    failNext: 0,
    read: (k) => (data.has(k) ? JSON.parse(data.get(k)) : undefined),
    async get(keys) {
      const out = {};
      for (const k of [].concat(keys)) if (data.has(k)) out[k] = JSON.parse(data.get(k));
      return out;
    },
    async set(obj) {
      if (this.failNext > 0) {
        this.failNext--;
        throw new Error("quota");
      }
      sets.push(Object.keys(obj));
      for (const [k, v] of Object.entries(obj)) data.set(k, JSON.stringify(v));
    },
  };
}

function setup({ area = memoryArea(), start = 1_000_000 } = {}) {
  const clock = { t: start };
  const timers = [];
  const log = createLog({ area, now: () => clock.t, schedule: (fn, ms) => timers.push({ fn, ms }) });
  const fire = async () => {
    const pending = timers.splice(0);
    for (const t of pending) t.fn();
    await log.flush();
  };
  return { log, area, clock, timers, fire };
}

test("journal : niveaux, horodatage, ordre chronologique", () => {
  const { log, clock } = setup();
  log.info("Démarrage.");
  clock.t += 5;
  log.warn("Serveur occupé.");
  clock.t += 5;
  log.error("Mot de passe refusé.");
  eq(log.getLog(), [
    { t: 1_000_000, level: "info", msg: "Démarrage." },
    { t: 1_000_005, level: "warn", msg: "Serveur occupé." },
    { t: 1_000_010, level: "error", msg: "Mot de passe refusé." },
  ]);
});

test("journal : anneau de 300 entrées, les plus anciennes sortent", () => {
  const { log } = setup();
  for (let i = 0; i < MAX_ENTRIES + 25; i++) log.info(`n${i}`);
  const all = log.getLog();
  eq(all.length, MAX_ENTRIES);
  eq(all[0].msg, "n25");
  eq(all[all.length - 1].msg, `n${MAX_ENTRIES + 24}`);
});

test("journal : une ligne, sans caractère de contrôle, de sens d'écriture ni invisible, longueur plafonnée", () => {
  const { log } = setup();
  log.info("a\u0000b\u0007c\r\nd\te\u202ef\u2066g\u200bh\u00adi\u2028j");
  eq(log.getLog()[0].msg, "abc d efghi j");
  log.warn("x".repeat(5000));
  eq(log.getLog()[1].msg.length, MAX_MESSAGE);
  log.error("   ");
  eq(log.getLog()[2].msg, "(message vide)");
  log.info(undefined);
  eq(log.getLog()[3].msg, "(message vide)");
});

test("journal : getLog rend des copies", () => {
  const { log } = setup();
  log.info("un");
  const copy = log.getLog();
  copy[0].msg = "modifié";
  copy.push({ t: 0, level: "info", msg: "ajout" });
  eq(log.getLog(), [{ t: 1_000_000, level: "info", msg: "un" }]);
});

test("débogage : éteint par défaut, debug() n'enregistre rien", () => {
  const { log } = setup();
  eq(log.debugEnabled, false);
  eq(log.debugUntil, 0);
  log.debug("FolderSync", "Status 1");
  eq(log.getLog(), []);
});

test("débogage : allumé, les détails techniques sont gardés (nettoyés, plafonnés)", async () => {
  const { log, clock } = setup();
  await log.setDebugFor(10 * 60_000);
  eq(log.debugEnabled, true);
  eq(log.debugUntil, clock.t + 10 * 60_000);
  log.debug("→ Sync", "Collection\n  Status 1\u202e");
  log.debug("long", "y".repeat(10_000));
  log.debug("sans détails");
  const entries = log.getLog();
  eq(entries[0], { t: clock.t, level: "info", msg: "Débogage activé pour 10 min." });
  eq(entries[1], { t: clock.t, level: "debug", msg: "→ Sync", details: "Collection\n  Status 1" });
  eq(entries[2].details.length, MAX_DETAILS);
  eq(entries[3], { t: clock.t, level: "debug", msg: "sans détails" });
  log.debug("objet", { status: "1", n: 2 });
  eq(log.getLog()[4].details, '{"status":"1","n":2}');
});

test("débogage : jamais plus d'une heure, s'éteint seul", async () => {
  const { log, clock } = setup();
  const until = await log.setDebugFor(24 * MAX_DEBUG_MS);
  eq(until, clock.t + MAX_DEBUG_MS);
  clock.t += MAX_DEBUG_MS - 1;
  eq(log.debugEnabled, true);
  clock.t += 1;
  eq(log.debugEnabled, false);
  eq(log.debugUntil, 0);
  log.debug("après", "x");
  eq(log.getLog().filter((e) => e.level === "debug"), []);
});

test("débogage : 0, négatif ou invalide l'éteint", async () => {
  for (const off of [0, -5, NaN, Infinity, "3600000", null, undefined]) {
    const { log } = setup();
    await log.setDebugFor(60_000);
    eq(await log.setDebugFor(off), 0, String(off));
    eq(log.debugEnabled, false);
    eq(log.getLog()[1].msg, "Débogage désactivé.");
  }
});

test("débogage : échéance enregistrée dans settings.debugUntil, autres réglages conservés", async () => {
  const area = memoryArea({ [SETTINGS_KEY]: { theme: "auto", debugUntil: 1 } });
  const { log, clock } = setup({ area });
  await log.setDebugFor(60_000);
  eq(area.read(SETTINGS_KEY), { theme: "auto", debugUntil: clock.t + 60_000 });
  await log.setDebugFor(0);
  eq(area.read(SETTINGS_KEY), { theme: "auto", debugUntil: 0 });
});

test("débogage : un réglage enregistré endommagé est remplacé par un objet propre", async () => {
  const area = memoryArea({ [SETTINGS_KEY]: ["pas", "un", "objet"] });
  const { log, clock } = setup({ area });
  await log.setDebugFor(1000);
  eq(area.read(SETTINGS_KEY), { debugUntil: clock.t + 1000 });
});

test("écritures groupées : une seule écriture après le délai, flush() écrit tout de suite", async () => {
  const { log, area, timers, fire } = setup();
  log.info("un");
  log.info("deux");
  log.warn("trois");
  eq(timers.length, 1);
  eq(timers[0].ms, WRITE_DELAY_MS);
  eq(area.sets.length, 0);
  await fire();
  eq(area.sets, [[LOG_KEY]]);
  eq(area.read(LOG_KEY).map((e) => e.msg), ["un", "deux", "trois"]);
  log.info("quatre");
  eq(timers.length, 1, "nouveau délai");
  await log.flush();
  eq(area.read(LOG_KEY).length, 4);
  await fire();
  eq(area.sets.length, 2, "rien de neuf : pas de nouvelle écriture");
});

test("écritures : un échec du stockage ne lève rien, l'écriture est retentée", async () => {
  const { log, area, fire } = setup();
  area.failNext = 1;
  log.error("un");
  await log.flush();
  eq(area.read(LOG_KEY), undefined);
  log.info("deux");
  await fire();
  eq(area.read(LOG_KEY).map((e) => e.msg), ["un", "deux"]);
});

test("clearLog vide le journal et l'enregistre aussitôt", async () => {
  const { log, area, fire } = setup();
  log.info("un");
  await fire();
  await log.clearLog();
  eq(log.getLog(), []);
  eq(area.read(LOG_KEY), []);
});

test("load : entrées enregistrées vérifiées, entrées antérieures au chargement gardées après", async () => {
  const area = memoryArea({
    [LOG_KEY]: [
      { t: 1, level: "info", msg: "ancien" },
      { t: 2, level: "bavard", msg: "niveau inconnu" },
      { t: "3", level: "info", msg: "date texte" },
      null,
      { t: 4, level: "debug", msg: "dbg", details: "Status 1\u202e" },
      { t: 5, level: "warn", msg: "a\u0000b", details: "ignoré hors débogage" },
      { t: 6, level: "error", msg: 42 },
    ],
  });
  const { log, fire } = setup({ area });
  log.info("tôt");
  await log.load();
  eq(log.getLog(), [
    { t: 1, level: "info", msg: "ancien" },
    { t: 4, level: "debug", msg: "dbg", details: "Status 1" },
    { t: 5, level: "warn", msg: "ab" },
    { t: 1_000_000, level: "info", msg: "tôt" },
  ]);
  await fire();
  eq(area.read(LOG_KEY).length, 4);
});

test("load : stockage absent ou endommagé, rien ne lève", async () => {
  const { log } = setup({ area: memoryArea({ [LOG_KEY]: "texte", [SETTINGS_KEY]: 7 }) });
  await log.load();
  eq(log.getLog(), []);
  eq(log.debugEnabled, false);
  const memory = createLog({ area: null, now: () => 0, schedule: () => assert(false, "aucune écriture prévue sans stockage") });
  memory.info("en mémoire");
  await memory.load();
  await memory.setDebugFor(1000);
  eq(memory.getLog().map((e) => e.msg), ["en mémoire", "Débogage activé pour 1 min."]);
});

test("load : échéance de débogage reprise, plafonnée à une heure, ignorée si passée", async () => {
  const cases = [
    [1_000_000 + 30 * 60_000, true, 1_000_000 + 30 * 60_000],
    [1_000_000 + 10 * MAX_DEBUG_MS, true, 1_000_000 + MAX_DEBUG_MS],
    [999_999, false, 0],
    ["1000000000", false, 0],
  ];
  for (const [stored, on, until] of cases) {
    const { log } = setup({ area: memoryArea({ [SETTINGS_KEY]: { debugUntil: stored } }) });
    await log.load();
    eq(log.debugEnabled, on, String(stored));
    eq(log.debugUntil, until, String(stored));
  }
});
