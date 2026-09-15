// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A key-value-safe, injective encoding for the parts of an address.
 *
 * The record subtree's own encoding escapes with `~`, which the key-value
 * client refuses in a key, so an address carrying any byte it escapes would be
 * unwritable exactly where it is needed. Base32 emits only `A`-`Z` and `2`-`7`,
 * so every part lies inside the accepted set whatever bytes it holds, and it
 * carries no `.` to split a key the walkers match on.
 *
 * Injective, which two callers depend on: two run identities under one owner
 * scope can never present one qualified wire id, and two addresses can never
 * present one key.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Unpadded base32 of a part's UTF-8 bytes. */
export function encodeKeyPart(part: string): string {
  const bytes = new TextEncoder().encode(part);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function decodeKeyPart(encoded: string): string {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of encoded) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error(`bg key: character '${ch}' is outside the accepted set`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
