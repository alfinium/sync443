// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Stands in for the end-to-end "test-scenario.mjs" when background.test.mjs
 * loads src/background.mjs: the background page hands its internals to
 * runScenario(), and the unit test picks them up here.
 */

let resolve;
export const internals = new Promise((r) => (resolve = r));

export async function runScenario(x) {
  resolve(x);
}
