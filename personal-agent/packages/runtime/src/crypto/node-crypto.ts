// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The Crypto port on `node:crypto`. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { Bytes, Crypto } from "@primusclaw/personal-agent";

function buffer(data: Bytes): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}

export const nodeCrypto: Crypto = {
  sha256Hex: (data) => createHash("sha256").update(buffer(data)).digest("hex"),
  sha1Hex: (data) => createHash("sha1").update(buffer(data)).digest("hex"),
  hmacSha256Hex: (key, data) => createHmac("sha256", buffer(key)).update(buffer(data)).digest("hex"),
  timingSafeEqual: (a, b) => {
    const left = buffer(a);
    const right = buffer(b);
    return left.length === right.length && timingSafeEqual(left, right);
  },
};
