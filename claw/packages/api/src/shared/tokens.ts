// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Rough token estimate: ~4 chars per token (ASCII-biased; CJK may be 2-3x). */
export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}
