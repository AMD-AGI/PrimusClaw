// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Rough token estimate without a tokenizer: an ASCII character is about a quarter of a token, and any other
 * character (CJK above all) about one. Counting every character at a quarter undercounted Chinese text by
 * almost three times, so a budget measured with it never tripped.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text || "") {
    if (ch.charCodeAt(0) < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}
