// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Runs every unit test: tools/unit_tests.py (jsc -m run-all.mjs, or node,
 * from tests/unit). Each *.test.mjs file registers its tests on import;
 * run() executes them in order.
 */

import { run } from "./harness.mjs";

// ── Core ──────────────────────────────────────────────────────────────────
import "./utf8.test.mjs";
import "./base64.test.mjs";
import "./codepages.test.mjs";
import "./wbxml.test.mjs";
import "./sanitize.test.mjs";
import "./server.test.mjs";
import "./protocol.test.mjs";
import "./tls-policy.test.mjs";
import "./backoff.test.mjs";
import "./http1.test.mjs";

// ── Transport ─────────────────────────────────────────────────────────────
import "./client.test.mjs";

// ── TO ADD: further test files go here (store, health, net-watch) ─────────
import "./store.test.mjs";
import "./health.test.mjs";
import "./sha256.test.mjs";
import "./mime.test.mjs";
import "./mail-codec.test.mjs";
import "./folder-tree.test.mjs";
import "./log.test.mjs";
import "./send.test.mjs";
import "./options-form.test.mjs";
import "./echo.test.mjs";
import "./journal.test.mjs";
import "./mail-sync.test.mjs";
import "./push.test.mjs";
import "./mail-store.test.mjs";
import "./mailbox.test.mjs";
import "./audit-core.test.mjs";
import "./audit-transport.test.mjs";
import "./audit-http.test.mjs";

// ── Fuzzing (slowest, last) ───────────────────────────────────────────────
import "./wbxml-fuzz.test.mjs";
import "./mail-core-fuzz.test.mjs";
import "./http1-fuzz.test.mjs";

// A test that never settles would end the JavaScriptCore shell quietly, with
// exit status 0, the remaining tests skipped and no summary. The watchdog
// fails the run instead: an exception thrown from a timer gives a non-zero
// status (jsc has no clearTimeout, and quit(n) exits with 0, so it polls and
// simply stops re-arming once the run is over).
const WATCHDOG_MS = 60_000;
const startedAt = Date.now();
let finished = false;
const watch = () => {
  if (finished) return;
  if (Date.now() - startedAt > WATCHDOG_MS) {
    throw new Error(`un test ne s'est jamais terminé (plus de ${WATCHDOG_MS / 1000} s) : celui qui suit le dernier « ok » affiché`);
  }
  setTimeout(watch, 250);
};
setTimeout(watch, 250);
try {
  await run();
} finally {
  finished = true;
}
