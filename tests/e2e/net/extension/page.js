// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

// Test page (a tab, not the background page): sync443Net must refuse it.
(async () => {
  const port = Number(new URLSearchParams(location.search).get("port"));
  const result = {};
  try {
    await browser.sync443Net.open({ host: "localhost", port, timeoutMs: 5000 });
    result.open = "resolved";
  } catch (e) {
    result.open = String(e?.message ?? e);
  }
  try {
    await browser.sync443Net.close("00000000-0000-0000-0000-000000000000");
    result.close = "resolved";
  } catch (e) {
    result.close = String(e?.message ?? e);
  }
  await browser.runtime.sendMessage({ viewTest: result });
})();
