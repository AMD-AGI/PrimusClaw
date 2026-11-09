// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What every repository of the SQLite store shares: the connection, the clock, randomness and the stored-secret keys. */
import type { Random } from "@primusclaw/personal-agent";

import { Fernet, InvalidToken, MultiFernet } from "../crypto/fernet.js";
import { hashLinkCode, linkHashKey } from "../crypto/link-code.js";
import { urlsafeB64Encode } from "../crypto/py-base64.js";
import type { Database } from "./database.js";

/** The fields a security event of the store carries (`link_attempt`, `link_lockout`); the sink filters and logs them. */
export type SecurityEventFields = Readonly<Record<string, string | number | undefined>>;
export type SecurityEventSink = (event: "link_attempt" | "link_lockout", fields: SecurityEventFields) => void;

/**
 * The keys of TEAMS_ENCRYPTION_KEYS: the first encrypts and hashes new link codes, every one decrypts and finds a code
 * (adding a key at the head does not void the codes of the last 10 minutes).
 */
export class StoreSecrets {
  readonly primary: Fernet;
  readonly all: MultiFernet;
  readonly #linkKeys: readonly Uint8Array[];

  constructor(keys: readonly string[], nowSeconds?: () => number) {
    if (keys.length === 0) throw new RangeError("at least one encryption key is required");
    this.#linkKeys = keys.map((k) => linkHashKey(k));
    const options = nowSeconds ? { nowSeconds } : {};
    this.all = new MultiFernet(keys.map((k) => new Fernet(k, options)));
    this.primary = this.all.primary;
  }

  /** A Fernet token as the store keeps it (a BLOB of the token's ASCII). */
  encrypt(text: string): Uint8Array {
    return new TextEncoder().encode(this.all.encrypt(text));
  }

  /** The text, or null when no configured key reads it. */
  decrypt(token: Uint8Array): string | null {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.all.decrypt(token));
    } catch (error) {
      if (error instanceof InvalidToken) return null;
      throw error;
    }
  }

  /** The code's stored hash under the first key. */
  primaryHash(code: string): string {
    return hashLinkCode(code, this.#linkKeys[0] as Uint8Array);
  }

  /** The code's hash under every key. */
  hashes(code: string): string[] {
    return this.#linkKeys.map((key) => hashLinkCode(code, key));
  }
}

export interface StoreContext {
  readonly db: Database;
  /** Epoch seconds. */
  readonly now: () => number;
  readonly random: Random;
  readonly secrets: StoreSecrets;
}

/** Python's `secrets.token_urlsafe(n)`: n random bytes, base64url without padding. */
export function tokenUrlsafe(random: Random, n: number): string {
  return urlsafeB64Encode(random.bytes(n)).replace(/=+$/, "");
}

/** Python's `secrets.token_hex(n)`. */
export function tokenHex(random: Random, n: number): string {
  return Buffer.from(random.bytes(n)).toString("hex");
}

/** `n` characters drawn uniformly from `alphabet` (Python's `secrets.choice` per character). */
export function drawCode(random: Random, alphabet: string, n: number): string {
  return Array.from({ length: n }, () => alphabet.charAt(random.int(alphabet.length))).join("");
}
