// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * Tests of SHA-256 with the examples of FIPS 180-4 (NIST "Example
 * Algorithms": "abc", the 448-bit and 896-bit messages, one million "a"),
 * the empty message, and lengths around the padding boundaries.
 */

import { test, eq, throws } from "./harness.mjs";
import { sha256, toHex } from "../../src/core/sha256.mjs";
import { encodeUtf8 } from "../../src/core/utf8.mjs";

const hashOf = (s) => toHex(sha256(encodeUtf8(s)));

test("sha256 : message vide", () => {
  eq(toHex(sha256(new Uint8Array(0))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("sha256 : « abc » (FIPS 180-4)", () => {
  eq(hashOf("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("sha256 : message de 448 bits (FIPS 180-4)", () => {
  eq(
    hashOf("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("sha256 : message de 896 bits (FIPS 180-4)", () => {
  eq(
    hashOf(
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
    ),
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
  );
});

test("sha256 : un million de « a » (FIPS 180-4), en temps raisonnable", () => {
  const started = Date.now();
  eq(toHex(sha256(new Uint8Array(1_000_000).fill(0x61))), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  const ms = Date.now() - started;
  if (ms > 3000) throw new Error(`trop lent : ${ms} ms`);
});

test("sha256 : longueurs autour du remplissage (55, 56, 57, 63, 64, 65, 119, 120, 128 octets)", () => {
  const expected = new Map([
    [55, "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"],
    [56, "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"],
    [57, "f13b2d724659eb3bf47f2dd6af1accc87b81f09f59f2b75e5c0bed6589dfe8c6"],
    [63, "7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34"],
    [64, "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"],
    [65, "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0"],
    [119, "31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb"],
    [120, "2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c"],
    [128, "6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e"],
  ]);
  for (const [n, digest] of expected) eq(toHex(sha256(new Uint8Array(n).fill(0x61))), digest, `${n} octets`);
});

test("sha256 : tous les octets 0 à 255, et texte ordinaire", () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  eq(toHex(sha256(all)), "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880");
  eq(hashOf("The quick brown fox jumps over the lazy dog"), "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
});

test("sha256 : une vue partielle d'un tampon ne lit que ses propres octets", () => {
  const buffer = new Uint8Array(100).fill(0x78);
  buffer.set(encodeUtf8("abc"), 10);
  eq(toHex(sha256(buffer.subarray(10, 13))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("sha256 : résultat de 32 octets, entrée inchangée", () => {
  const input = encodeUtf8("abc");
  const digest = sha256(input);
  eq(digest.length, 32);
  eq(Array.from(input), [0x61, 0x62, 0x63]);
});

test("sha256 : entrée qui n'est pas un Uint8Array refusée", () => {
  for (const bad of [null, undefined, "abc", [1, 2, 3], 42, {}]) throws(() => sha256(bad), TypeError, String(bad));
});

test("toHex : minuscules, deux chiffres par octet", () => {
  eq(toHex(new Uint8Array([0, 1, 15, 16, 171, 255])), "00010f10abff");
  eq(toHex(new Uint8Array(0)), "");
});
