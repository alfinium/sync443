// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * SHA-256 (FIPS 180-4, sections 4.1.2, 4.2.2, 5.1.1, 5.3.3 and 6.2), for
 * the JavaScriptCore shell and Thunderbird alike: no crypto.subtle (which
 * is asynchronous and absent from jsc). Used to name messages that arrive
 * without a Message-ID, not for any security decision.
 *
 *   sha256(bytes: Uint8Array) → Uint8Array(32)
 *
 * Words are kept as signed 32-bit integers (`| 0`); additions wrap modulo
 * 2^32 as the standard requires.
 */

// First 32 bits of the fractional parts of the cube roots of the first 64 primes (4.2.2).
const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// First 32 bits of the fractional parts of the square roots of the first 8 primes (5.3.3).
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** Processes the 64-byte block of `data` starting at `offset` into the state `h` (6.2.2). */
function compress(h, w, data, offset) {
  for (let t = 0; t < 16; t++) {
    const i = offset + t * 4;
    w[t] = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
  }
  for (let t = 16; t < 64; t++) {
    const x = w[t - 15];
    const y = w[t - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[t] = (s1 + w[t - 7] + s0 + w[t - 16]) | 0;
  }
  let a = h[0];
  let b = h[1];
  let c = h[2];
  let d = h[3];
  let e = h[4];
  let f = h[5];
  let g = h[6];
  let k = h[7];
  for (let t = 0; t < 64; t++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (k + S1 + ch + K[t] + w[t]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    k = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  h[0] = (h[0] + a) | 0;
  h[1] = (h[1] + b) | 0;
  h[2] = (h[2] + c) | 0;
  h[3] = (h[3] + d) | 0;
  h[4] = (h[4] + e) | 0;
  h[5] = (h[5] + f) | 0;
  h[6] = (h[6] + g) | 0;
  h[7] = (h[7] + k) | 0;
}

/** SHA-256 digest of `bytes` (a Uint8Array), as 32 bytes. */
export function sha256(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("sha256 : Uint8Array attendu");
  const h = new Int32Array(H0);
  const w = new Int32Array(64);
  const length = bytes.length;
  const full = length - (length % 64);
  for (let offset = 0; offset < full; offset += 64) compress(h, w, bytes, offset);

  // Padding (5.1.1): the remaining bytes, 0x80, zeros, then the length in bits
  // as a 64-bit big-endian number; one or two final blocks.
  const rest = length - full;
  const tail = new Uint8Array(rest < 56 ? 64 : 128);
  tail.set(bytes.subarray(full));
  tail[rest] = 0x80;
  const high = Math.floor(length / 0x20000000); // length * 8 / 2^32
  const low = (length * 8) >>> 0; // exact: length < 2^53 / 8 for any real array
  const end = tail.length;
  tail[end - 8] = high >>> 24;
  tail[end - 7] = high >>> 16;
  tail[end - 6] = high >>> 8;
  tail[end - 5] = high;
  tail[end - 4] = low >>> 24;
  tail[end - 3] = low >>> 16;
  tail[end - 2] = low >>> 8;
  tail[end - 1] = low;
  for (let offset = 0; offset < end; offset += 64) compress(h, w, tail, offset);

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = h[i] >>> 24;
    out[i * 4 + 1] = h[i] >>> 16;
    out[i * 4 + 2] = h[i] >>> 8;
    out[i * 4 + 3] = h[i];
  }
  return out;
}

/** Lowercase hexadecimal form of bytes (helper for digests). */
export function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  return s;
}
