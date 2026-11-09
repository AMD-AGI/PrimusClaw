// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { randomBytes, randomInt } from "node:crypto";
import type { Random } from "@primusclaw/personal-agent";

/** Randomness from the operating system's CSPRNG (`node:crypto`). */
export const cryptoRandom: Random = {
  bytes: (n) => new Uint8Array(randomBytes(n)),
  hexId: () => randomBytes(16).toString("hex"),
  int: (maxExclusive) => randomInt(maxExclusive),
  // 53 random bits over 2^53: uniform in [0, 1).
  fraction: () => Number(randomBytes(8).readBigUInt64BE() >> 11n) / 2 ** 53,
};
