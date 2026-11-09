// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Random } from "@primusclaw/personal-agent";

/** A deterministic `Random` (mulberry32): the same seed gives the same ids, so test output is stable. Not for secrets. */
export class SeededRandom implements Random {
  private state: number;

  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  private next32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  bytes(n: number): Uint8Array {
    return Uint8Array.from({ length: n }, () => this.next32() & 0xff);
  }

  hexId(): string {
    return Array.from(this.bytes(16), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  int(maxExclusive: number): number {
    return Math.floor(this.fraction() * maxExclusive);
  }

  fraction(): number {
    return this.next32() / 2 ** 32;
  }
}
