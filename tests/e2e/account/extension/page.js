// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

// Test page (a tab, not the background page): every function of
// sync443Account must refuse it, even with valid arguments.
(async () => {
  const params = new URLSearchParams(location.search);
  const accountKey = params.get("accountKey");
  const identityId = params.get("identityId");
  const api = browser.sync443Account;
  const origin = "https://mail.example.com:8443";
  const calls = {
    ensureAccount: () => api.ensureAccount({ mailboxId: "a1b2c3d4e5f6", email: "page@example.com", name: "Page" }),
    listAccounts: () => api.listAccounts(),
    accountOfIdentity: () => api.accountOfIdentity(identityId),
    removeAccount: () => api.removeAccount(accountKey),
    setSpecialUse: () => api.setSpecialUse(accountKey, "/Inbox", "inbox"),
    getPassword: () => api.getPassword(origin, "alice"),
    setPassword: () => api.setPassword(origin, "alice", "depuis-la-page"),
    removePassword: () => api.removePassword(origin, "alice"),
  };
  const result = {};
  for (const [name, call] of Object.entries(calls)) {
    try {
      const value = await call();
      result[name] = `résolu : ${JSON.stringify(value)}`;
    } catch (e) {
      result[name] = String(e?.message ?? e);
    }
  }
  await browser.runtime.sendMessage({ viewTest: result });
})();
