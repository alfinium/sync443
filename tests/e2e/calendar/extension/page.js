// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

// Test page (a tab, not the background page): every function of
// sync443Calendar must refuse it, even with valid arguments.
(async () => {
  const calendarId = new URLSearchParams(location.search).get("calendarId");
  const api = browser.sync443Calendar;
  const calls = {
    listCalendars: () => api.listCalendars(),
    ensureCalendar: () =>
      api.ensureCalendar({ mailboxId: "a1b2c3d4e5f6", slot: "main", name: "Page", events: true, tasks: true, organizerEmail: "page@example.com" }),
    removeCalendar: () => api.removeCalendar(calendarId),
    applyServerChanges: () => api.applyServerChanges(calendarId, []),
    serverIds: () => api.serverIds(calendarId, "1"),
    readLocalChanges: () => api.readLocalChanges(calendarId, { max: 10 }),
    ackLocalChange: () => api.ackLocalChange(calendarId, `${"0".repeat(32)}.1`, {}),
    dropLocalChange: () => api.dropLocalChange(calendarId, `${"0".repeat(32)}.1`),
  };
  const result = {};
  for (const [name, call] of Object.entries(calls)) {
    try {
      const value = await call();
      result[name] = `resolved: ${JSON.stringify(value)}`;
    } catch (e) {
      result[name] = String(e?.message ?? e);
    }
  }
  await browser.runtime.sendMessage({ viewTest: result });
})();
