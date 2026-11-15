// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/** Base64 tests: RFC 4648 section 10 vectors, RFC 7617 examples, and a bit-level reference. */

import { test, assert, eq, prng } from "./harness.mjs";
import { base64 } from "../../src/core/base64.mjs";

const ascii = (s) => new Uint8Array(Array.from(s, (c) => c.charCodeAt(0)));
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Reference written from RFC 4648 section 4: groups of 6 bits, "=" padding. */
function reference(bytes) {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  while (bits.length % 6) bits += "0";
  let out = "";
  for (let i = 0; i < bits.length; i += 6) out += ALPHABET[parseInt(bits.slice(i, i + 6), 2)];
  while (out.length % 4) out += "=";
  return out;
}

test("base64 : vecteurs de la RFC 4648 (section 10)", () => {
  eq(base64(ascii("")), "");
  eq(base64(ascii("f")), "Zg==");
  eq(base64(ascii("fo")), "Zm8=");
  eq(base64(ascii("foo")), "Zm9v");
  eq(base64(ascii("foob")), "Zm9vYg==");
  eq(base64(ascii("fooba")), "Zm9vYmE=");
  eq(base64(ascii("foobar")), "Zm9vYmFy");
});

test("base64 : exemples de la RFC 7617 (authentification Basic)", () => {
  eq(base64(ascii("Aladdin:open sesame")), "QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
  // "test:123£" with the password in UTF-8 (£ = C2 A3).
  eq(base64(new Uint8Array([...ascii("test:123"), 0xc2, 0xa3])), "dGVzdDoxMjPCow==");
});

test("base64 : octets de poids fort et caractères + et /", () => {
  eq(base64(new Uint8Array([0xff, 0xff, 0xff])), "////");
  eq(base64(new Uint8Array([0xfb, 0xef, 0xbe])), "++++");
  eq(base64(new Uint8Array([0xfb, 0xff])), "+/8=");
  eq(base64(new Uint8Array([0x00])), "AA==");
  eq(base64(new Uint8Array([0x00, 0x00, 0x00])), "AAAA");
  eq(base64(new Uint8Array([0x80])), "gA==");
});

test("base64 : chaque valeur d'octet, seule et en triplet", () => {
  for (let b = 0; b < 256; b++) {
    eq(base64(new Uint8Array([b])), reference([b]), `octet ${b}`);
    eq(base64(new Uint8Array([b, 255 - b, b ^ 0x5a])), reference([b, 255 - b, b ^ 0x5a]), `triplet ${b}`);
  }
});

test("base64 : données aléatoires conformes à la référence, longueur 4·⌈n/3⌉", () => {
  const rnd = prng(4648);
  for (let round = 0; round < 500; round++) {
    const n = Math.floor(rnd() * 100);
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(rnd() * 256);
    const got = base64(bytes);
    eq(got, reference(bytes), `longueur ${n}`);
    eq(got.length, 4 * Math.ceil(n / 3), "longueur du résultat");
    assert(/^[A-Za-z0-9+/]*={0,2}$/.test(got), "alphabet de la RFC 4648 uniquement");
  }
});
