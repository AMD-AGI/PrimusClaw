// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Hashing and message authentication for the domain (ids derived from text, signed callbacks). Encryption at rest is
 * the store's own business and is not offered here.
 */
export type Bytes = string | Uint8Array;

export interface Crypto {
  /** Hex SHA-256 of `data` (a string is taken as UTF-8). */
  sha256Hex(data: Bytes): string;
  /** Hex SHA-1, for ids that are already SHA-1 derived elsewhere; never for security. */
  sha1Hex(data: Bytes): string;
  /** Hex HMAC-SHA256 of `data` under `key`. */
  hmacSha256Hex(key: Bytes, data: Bytes): string;
  /** Constant-time equality; false for different lengths. */
  timingSafeEqual(a: Bytes, b: Bytes): boolean;
}
