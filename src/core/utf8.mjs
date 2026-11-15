// SPDX-License-Identifier: MIT
// Copyright (c) 2026 alfinium

/**
 * UTF-8 without TextEncoder/TextDecoder, so the core runs the same in
 * Thunderbird and in the JavaScriptCore shell used by the unit tests.
 *
 * Decoding never throws: an invalid sequence becomes one U+FFFD per
 * "maximal subpart", exactly like the WHATWG decoder (and Thunderbird).
 * Encoding turns a lone surrogate into U+FFFD.
 */

export function encodeUtf8(str) {
  const s = String(str);
  const out = new Uint8Array(s.length * 3);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      out[n++] = cp;
    } else if (cp < 0x800) {
      out[n++] = 0xc0 | (cp >> 6);
      out[n++] = 0x80 | (cp & 0x3f);
    } else if (cp < 0x10000) {
      out[n++] = 0xe0 | (cp >> 12);
      out[n++] = 0x80 | ((cp >> 6) & 0x3f);
      out[n++] = 0x80 | (cp & 0x3f);
    } else {
      out[n++] = 0xf0 | (cp >> 18);
      out[n++] = 0x80 | ((cp >> 12) & 0x3f);
      out[n++] = 0x80 | ((cp >> 6) & 0x3f);
      out[n++] = 0x80 | (cp & 0x3f);
    }
  }
  return out.slice(0, n);
}

export function decodeUtf8(bytes, start = 0, end = bytes.length) {
  let out = "";
  const chunk = [];
  let i = start;
  while (i < end) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      chunk.push(b0);
      i++;
    } else {
      let need;
      let cp;
      if (b0 >= 0xc2 && b0 <= 0xdf) {
        need = 1;
        cp = b0 & 0x1f;
      } else if (b0 >= 0xe0 && b0 <= 0xef) {
        need = 2;
        cp = b0 & 0x0f;
      } else if (b0 >= 0xf0 && b0 <= 0xf4) {
        need = 3;
        cp = b0 & 0x07;
      } else {
        chunk.push(0xfffd);
        i++;
        need = 0;
      }
      if (need) {
        // Allowed range of the second byte (excludes overlongs, surrogates, > U+10FFFF).
        let lower = b0 === 0xe0 ? 0xa0 : b0 === 0xf0 ? 0x90 : 0x80;
        let upper = b0 === 0xed ? 0x9f : b0 === 0xf4 ? 0x8f : 0xbf;
        let j = i + 1;
        let ok = true;
        for (let k = 0; k < need; k++) {
          const b = j < end ? bytes[j] : -1;
          if (b < lower || b > upper) {
            ok = false;
            break;
          }
          cp = (cp << 6) | (b & 0x3f);
          j++;
          lower = 0x80;
          upper = 0xbf;
        }
        chunk.push(ok ? cp : 0xfffd);
        i = j; // on failure, the offending byte is examined again
      }
    }
    if (chunk.length >= 8192) {
      out += String.fromCodePoint(...chunk);
      chunk.length = 0;
    }
  }
  if (chunk.length) out += String.fromCodePoint(...chunk);
  return out;
}
