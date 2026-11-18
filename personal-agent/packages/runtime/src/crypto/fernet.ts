// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Fernet (https://github.com/fernet/spec) and MultiFernet, byte for byte the tokens Python's `cryptography` makes and
 * reads: base64url( 0x80 | timestamp 8B big-endian | IV 16B | AES-128-CBC(PKCS7) | HMAC-SHA256 32B ). The key is
 * base64url(32 bytes): the first 16 sign, the last 16 encrypt.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { urlsafeB64Decode, urlsafeB64Encode } from "./py-base64.js";

const VERSION = 0x80;
const HEADER = 1 + 8 + 16;
const MAC = 32;
const MAX_CLOCK_SKEW = 60;

/** The token is not one of these keys' (or is malformed, tampered with, or out of its ttl). */
export class InvalidToken extends Error {
  override readonly name = "InvalidToken";
}

/** What a token is made of, before it is verified. */
interface TokenData {
  readonly timestamp: number;
  readonly data: Uint8Array;
}

export interface FernetOptions {
  /** Wall-clock seconds, for the token's timestamp and a ttl check (default: the system clock). */
  readonly nowSeconds?: () => number;
  /** IV bytes (default: `node:crypto` randomBytes). */
  readonly randomBytes?: (n: number) => Uint8Array;
}

function systemSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function bytesOf(input: string | Uint8Array): Uint8Array {
  return typeof input === "string" ? new TextEncoder().encode(input) : input;
}

/** Python's `Fernet._get_unverified_token_data`. */
function unverified(token: string | Uint8Array): TokenData {
  let data: Uint8Array;
  try {
    data = urlsafeB64Decode(token);
  } catch {
    throw new InvalidToken("not base64");
  }
  if (data.length < 9 || data[0] !== VERSION) throw new InvalidToken("not a Fernet token");
  return { timestamp: Number(Buffer.from(data.subarray(1, 9)).readBigUInt64BE()), data };
}

export class Fernet {
  readonly #signingKey: Buffer;
  readonly #encryptionKey: Buffer;
  readonly #now: () => number;
  readonly #random: (n: number) => Uint8Array;

  constructor(key: string | Uint8Array, options: FernetOptions = {}) {
    let raw: Uint8Array;
    try {
      raw = urlsafeB64Decode(key);
    } catch {
      raw = new Uint8Array();
    }
    if (raw.length !== 32) throw new RangeError("Fernet key must be 32 url-safe base64-encoded bytes.");
    this.#signingKey = Buffer.from(raw.subarray(0, 16));
    this.#encryptionKey = Buffer.from(raw.subarray(16));
    this.#now = options.nowSeconds ?? systemSeconds;
    this.#random = options.randomBytes ?? ((n) => randomBytes(n));
  }

  /** A new key, as Python's `Fernet.generate_key()` gives it. */
  static generateKey(): string {
    return urlsafeB64Encode(randomBytes(32));
  }

  /** The signing half of the key (for tests that check a derived key is not it). */
  get signingKey(): Uint8Array {
    return Uint8Array.from(this.#signingKey);
  }

  encrypt(data: string | Uint8Array): string {
    return this.encryptAtTime(data, Math.floor(this.#now()));
  }

  encryptAtTime(data: string | Uint8Array, currentTime: number): string {
    return this.encryptFromParts(bytesOf(data), currentTime, this.#random(16));
  }

  /** The token for exactly these parts (the spec's generate vectors fix the IV). */
  encryptFromParts(data: Uint8Array, currentTime: number, iv: Uint8Array): string {
    const cipher = createCipheriv("aes-128-cbc", this.#encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const stamp = Buffer.alloc(8);
    stamp.writeBigUInt64BE(BigInt(currentTime));
    const basic = Buffer.concat([Buffer.from([VERSION]), stamp, Buffer.from(iv), ciphertext]);
    const mac = createHmac("sha256", this.#signingKey).update(basic).digest();
    return urlsafeB64Encode(Buffer.concat([basic, mac]));
  }

  /** The plaintext. Without `ttl` (how the store decrypts) the token's age is not checked. */
  decrypt(token: string | Uint8Array, ttl?: number): Uint8Array {
    const { timestamp, data } = unverified(token);
    return this.decryptData(data, timestamp, ttl === undefined ? undefined : [ttl, Math.floor(this.#now())]);
  }

  decryptAtTime(token: string | Uint8Array, ttl: number, currentTime: number): Uint8Array {
    const { timestamp, data } = unverified(token);
    return this.decryptData(data, timestamp, [ttl, currentTime]);
  }

  /** @internal Shared with MultiFernet.rotate, which must not re-parse the token per key. */
  decryptData(data: Uint8Array, timestamp: number, timeInfo?: readonly [number, number]): Uint8Array {
    if (timeInfo) {
      const [ttl, now] = timeInfo;
      if (timestamp + ttl < now || now + MAX_CLOCK_SKEW < timestamp) throw new InvalidToken("out of its ttl");
    }
    this.verifySignature(data);
    if (data.length < HEADER + MAC) throw new InvalidToken("too short");
    try {
      const decipher = createDecipheriv("aes-128-cbc", this.#encryptionKey, data.subarray(9, HEADER));
      return Uint8Array.from(Buffer.concat([decipher.update(data.subarray(HEADER, -MAC)), decipher.final()]));
    } catch {
      throw new InvalidToken("bad ciphertext or padding");
    }
  }

  private verifySignature(data: Uint8Array): void {
    const body = data.subarray(0, Math.max(0, data.length - MAC));
    const given = data.subarray(Math.max(0, data.length - MAC));
    const expected = createHmac("sha256", this.#signingKey).update(body).digest();
    if (given.length !== MAC || !timingSafeEqual(expected, given)) throw new InvalidToken("bad signature");
  }
}

/** Encrypts with the first key, decrypts with any, and rotates a token to the first key keeping its timestamp. */
export class MultiFernet {
  readonly #fernets: readonly Fernet[];

  constructor(fernets: readonly Fernet[]) {
    if (fernets.length === 0) throw new RangeError("MultiFernet requires at least one Fernet instance");
    this.#fernets = fernets;
  }

  get primary(): Fernet {
    return this.#fernets[0] as Fernet;
  }

  encrypt(data: string | Uint8Array): string {
    return this.primary.encrypt(data);
  }

  decrypt(token: string | Uint8Array, ttl?: number): Uint8Array {
    for (const fernet of this.#fernets) {
      try {
        return fernet.decrypt(token, ttl);
      } catch (error) {
        if (!(error instanceof InvalidToken)) throw error;
      }
    }
    throw new InvalidToken("no key reads it");
  }

  rotate(token: string | Uint8Array, randomIv: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
    const { timestamp, data } = unverified(token);
    for (const fernet of this.#fernets) {
      let plain: Uint8Array;
      try {
        plain = fernet.decryptData(data, timestamp);
      } catch (error) {
        if (error instanceof InvalidToken) continue;
        throw error;
      }
      return this.primary.encryptFromParts(plain, timestamp, randomIv(16));
    }
    throw new InvalidToken("no key reads it");
  }
}
