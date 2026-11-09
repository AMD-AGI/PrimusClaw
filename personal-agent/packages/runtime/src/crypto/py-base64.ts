// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Base64 as Python's `base64.urlsafe_b64decode` / `urlsafe_b64encode` do it in Python 3.12, the worker image's
 * interpreter, because a Fernet key or token is read by both workers and must be accepted or refused by both alike.
 * That decoder is lenient: it maps `-_` to `+/`, skips every character outside the alphabet, stops at a completed pad
 * sequence (ignoring what follows), and refuses only a wrong amount of data. (Python 3.13 and later refuse data after
 * the padding; a token the store wrote never has any.)
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD = 61; // "="

const VALUES: ReadonlyMap<number, number> = new Map([
  ...Array.from({ length: ALPHABET.length }, (_, i): [number, number] => [ALPHABET.charCodeAt(i), i]),
  ["-".charCodeAt(0), 62],
  ["_".charCodeAt(0), 63],
]);

/** The data was not base64 Python would read (`binascii.Error`). */
export class Base64Error extends Error {
  override readonly name = "Base64Error";
}

function asBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? new TextEncoder().encode(input) : input;
}

/** Python's `base64.urlsafe_b64decode` (binascii non-strict mode). */
export function urlsafeB64Decode(input: string | Uint8Array): Uint8Array {
  const out: number[] = [];
  let quadPos = 0;
  let leftChar = 0;
  let pads = 0;
  for (const ch of asBytes(input)) {
    if (ch === PAD) {
      pads += 1;
      if (quadPos >= 2 && quadPos + pads >= 4) return Uint8Array.from(out);
      continue;
    }
    const value = VALUES.get(ch);
    if (value === undefined) continue;
    pads = 0;
    [quadPos, leftChar] = step(out, quadPos, leftChar, value);
  }
  if (quadPos === 1) throw new Base64Error("number of data characters cannot be 1 more than a multiple of 4");
  if (quadPos !== 0) throw new Base64Error("incorrect padding");
  return Uint8Array.from(out);
}

function step(out: number[], quadPos: number, leftChar: number, value: number): [number, number] {
  switch (quadPos) {
    case 0:
      return [1, value];
    case 1:
      out.push((leftChar << 2) | (value >> 4));
      return [2, value & 0x0f];
    case 2:
      out.push((leftChar << 4) | (value >> 2));
      return [3, value & 0x03];
    default:
      out.push((leftChar << 6) | value);
      return [0, 0];
  }
}

/** Python's `base64.urlsafe_b64encode`: padded, `-_` alphabet. */
export function urlsafeB64Encode(data: Uint8Array): string {
  return Buffer.from(data).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}
