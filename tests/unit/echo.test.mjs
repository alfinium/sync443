// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

import { test, assert, eq } from "./harness.mjs";
import { EchoRegistry, intentKeys, ECHO_TTL_MS } from "../../src/sync/echo.mjs";

const A = "account3";
const flags = (path, messageId, f) => ({ kind: "flags", path, messageId, flags: f });

test("écho : une écriture attendue est consommée une seule fois", () => {
  const echo = new EchoRegistry({ now: () => 0 });
  echo.expect(A, { kind: "move", path: "/Inbox", toPath: "/Trash", messageId: "m1@x" });
  eq(echo.consume(A, { kind: "move", path: "/Inbox", toPath: "/Trash", messageId: "m1@x" }), null, "écho reconnu");
  const again = { kind: "move", path: "/Inbox", toPath: "/Trash", messageId: "m1@x" };
  eq(echo.consume(A, again), again, "la même action ensuite est une vraie action");
});

test("écho : deux écritures identiques attendent deux événements", () => {
  const echo = new EchoRegistry({ now: () => 0 });
  const i = { kind: "delete", path: "/Trash", messageId: "a@b" };
  echo.expect(A, i);
  echo.expect(A, i);
  eq(echo.consume(A, i), null);
  eq(echo.consume(A, i), null);
  eq(echo.consume(A, i), i);
});

test("écho : apparié par valeur (compte, chemin, Message-ID, valeur)", () => {
  const echo = new EchoRegistry({ now: () => 0 });
  echo.expect(A, flags("/Inbox", "m@x", { read: true }));
  // Another message, another folder, another account, another value: real actions.
  const others = [
    flags("/Inbox", "autre@x", { read: true }),
    flags("/Archives", "m@x", { read: true }),
    flags("/Inbox", "m@x", { read: false }),
  ];
  for (const o of others) eq(echo.consume(A, o), o);
  const otherAccount = flags("/Inbox", "m@x", { read: true });
  eq(echo.consume("account4", otherAccount), otherAccount);
  eq(echo.consume(A, flags("/Inbox", "m@x", { read: true })), null, "l'attendu reste consommable");
});

test("écho : drapeaux appariés champ par champ, le reste est une action de l'utilisateur", () => {
  const echo = new EchoRegistry({ now: () => 0 });
  echo.expect(A, flags("/Inbox", "m@x", { read: true }));
  const rest = echo.consume(A, flags("/Inbox", "m@x", { read: true, flagged: true }));
  eq(rest, flags("/Inbox", "m@x", { flagged: true }));
  // Expected together, arriving separately.
  echo.expect(A, flags("/Inbox", "n@x", { read: false, flagged: false }));
  eq(echo.consume(A, flags("/Inbox", "n@x", { flagged: false })), null);
  eq(echo.consume(A, flags("/Inbox", "n@x", { read: false })), null);
});

test("écho : une attente expire au bout de 30 s et ne masque plus rien", () => {
  let t = 1000;
  const echo = new EchoRegistry({ now: () => t });
  echo.expect(A, { kind: "folderCreate", path: "/Projets" });
  t += ECHO_TTL_MS + 1;
  const i = { kind: "folderCreate", path: "/Projets" };
  eq(echo.consume(A, i), i);
  eq(echo.size, 0);
});

test("écho : une écriture échouée retire son attente", () => {
  const echo = new EchoRegistry({ now: () => 0 });
  const token = echo.expect(A, { kind: "folderRename", path: "/A", toPath: "/B" });
  echo.retract(token);
  const i = { kind: "folderRename", path: "/A", toPath: "/B" };
  eq(echo.consume(A, i), i);
});

test("écho : nombre plafonné, les plus anciennes partent d'abord", () => {
  const echo = new EchoRegistry({ now: () => 0, max: 3 });
  for (let n = 0; n < 5; n++) echo.expect(A, { kind: "delete", path: "/Trash", messageId: `m${n}@x` });
  eq(echo.size, 3);
  const first = { kind: "delete", path: "/Trash", messageId: "m0@x" };
  eq(echo.consume(A, first), first, "la plus ancienne a été oubliée");
  eq(echo.consume(A, { kind: "delete", path: "/Trash", messageId: "m4@x" }), null);
});

test("écho : clés sans ambiguïté (aucun séparateur forgeable)", () => {
  const a = intentKeys(A, { kind: "move", path: "/a", toPath: "/b/c", messageId: "x" });
  const b = intentKeys(A, { kind: "move", path: "/a/b", toPath: "/c", messageId: "x" });
  assert(a[0] !== b[0]);
  eq(intentKeys(A, { kind: "inconnu", path: "/a" }), []);
  eq(intentKeys(A, { kind: "flags", path: "/a", messageId: "x", flags: {} }), []);
});

test("écho : beaucoup d'attentes consommées puis expirées restent bornées en mémoire", () => {
  let t = 0;
  const echo = new EchoRegistry({ now: () => t });
  for (let n = 0; n < 5000; n++) {
    const i = { kind: "delete", path: "/Trash", messageId: `m${n}@x` };
    echo.expect(A, i);
    eq(echo.consume(A, i), null);
  }
  t += ECHO_TTL_MS + 1;
  eq(echo.size, 0);
});

test("écho : garde d'un message importé (état écrit, prêt après les écritures, durée de vie bornée)", async () => {
  let t = 0;
  const r = new EchoRegistry({ now: () => t, ttlMs: 30_000 });
  const release = r.guard("account1", "/Inbox", "m@x", { read: false, flagged: true });
  const g = r.guarded("account1", "/Inbox", "m@x");
  eq(g.state, { read: false, flagged: true });
  let ready = false;
  g.ready.then(() => (ready = true));
  await Promise.resolve();
  eq(ready, false, "pas prêt tant que les écritures continuent");
  release();
  await g.ready;
  r.reguard("account1", "/Inbox", "m@x", { read: true, flagged: true });
  eq(r.guarded("account1", "/Inbox", "m@x").state, { read: true, flagged: true });
  eq(r.guarded("account1", "/Inbox", "autre@x"), null);
  t += 30_000;
  eq(r.guarded("account1", "/Inbox", "m@x"), null, "expirée");
  eq(r.size, 0, "les gardes ne sont pas des attentes d'écho");
});
