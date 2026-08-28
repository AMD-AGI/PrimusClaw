// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * `a === b` on a shared secret short-circuits at the first differing byte, which
 * lets a caller recover the secret one byte at a time by measuring response
 * latency. Use this for every bearer token / shared-secret check.
 *
 * Comparing the SHA-256 digests rather than the raw bytes keeps this independent
 * of length: the digests are always 32 bytes, so `timingSafeEqual` never throws
 * on a length mismatch and the length of the expected secret does not leak
 * either. Digest equality implies input equality for any realistic attacker,
 * since forging a match means finding a SHA-256 collision, and learning how many
 * leading digest bytes agree reveals nothing about the secret behind them.
 *
 * An empty presented or expected value never matches, so a missing
 * `AUTH_INTERNAL_TOKEN` fails closed instead of accepting "".
 */
export function constantTimeEquals(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
