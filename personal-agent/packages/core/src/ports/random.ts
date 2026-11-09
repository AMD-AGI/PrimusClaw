// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Randomness, injected: ids, nonces and jitter. The runtime's implementation is cryptographically strong
 * (`node:crypto`), so a value from here may be used where it must not be guessed (a link code, an ack id).
 * Tests use a seeded one (`test-support/random.ts`) so their output is the same on every run.
 */
export interface Random {
  /** `n` random bytes. */
  bytes(n: number): Uint8Array;
  /** A random id: 32 lowercase hex characters (the shape of Python's `uuid.uuid4().hex`). */
  hexId(): string;
  /** A uniformly distributed integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** A float in [0, 1), for jitter only. */
  fraction(): number;
}
