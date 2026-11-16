// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Formats of the values the extension writes and checks again wherever they
 * are read back (settings, stored records, the client, sending). One copy
 * here; the privileged experiments keep their own, being self-contained
 * scripts.
 */

/** A mailbox: 12 lower-case hexadecimal digits (sync/store.mjs newIds). */
export const MAILBOX_ID = /^[a-f0-9]{12}$/;
/** A Thunderbird account key, as the account experiment accepts it. */
export const ACCOUNT_KEY = /^account[0-9]{1,9}$/;
/** ActiveSync DeviceId: letters and digits, at most 32 ([MS-ASHTTP]). */
export const DEVICE_ID = /^[A-Za-z0-9]{1,32}$/;
/** SHA-256 certificate fingerprint: 64 upper-case hexadecimal digits. */
export const TLS_PIN = /^[0-9A-F]{64}$/;
/** An origin as core/server.mjs writes it: https, a host name or an IPv6 literal, an optional port. */
export const ORIGIN = /^https:\/\/(?:[a-z0-9.-]{1,253}|\[[0-9a-f:]{2,39}\])(?::\d{1,5})?$/;
