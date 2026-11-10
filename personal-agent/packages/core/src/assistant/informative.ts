// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Status lines as one informative update (teams_agent/stream.py `informative_text`). */
import { cpLength, isPySpace, pyStrip, squashSpaces } from "../text/py-text.js";

/** An informative update is at most 1000 characters and 1 KB. */
export const INFORMATIVE_MAX_CHARS = 1000;
export const INFORMATIVE_MAX_BYTES = 1024;
export const STATUS_JOIN = " · ";
const ELLIPSIS = "…";
const encoder = new TextEncoder();
const COMBINING = /^\p{Mn}$/u;

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * The lines joined by " · " (white space collapsed), cut to INFORMATIVE_MAX_CHARS and INFORMATIVE_MAX_BYTES by keeping the END
 * (the newest) after a leading "…", never starting with a combining mark.
 */
export function informativeText(lines: readonly string[]): string {
  const text = lines
    .filter((line) => line && pyStrip(line))
    .map(squashSpaces)
    .join(STATUS_JOIN);
  if (cpLength(text) <= INFORMATIVE_MAX_CHARS && byteLength(text) <= INFORMATIVE_MAX_BYTES) return text;
  const budgetChars = INFORMATIVE_MAX_CHARS - 1;
  const budgetBytes = INFORMATIVE_MAX_BYTES - byteLength(ELLIPSIS);
  const kept: string[] = [];
  let used = 0;
  for (const char of Array.from(text).reverse()) {
    const size = byteLength(char);
    if (kept.length + 1 > budgetChars || used + size > budgetBytes) break;
    kept.push(char);
    used += size;
  }
  const tail = kept.reverse();
  // (a mark without the letter it belongs to, then the blanks the cut left in front)
  while (tail.length && COMBINING.test(tail[0] ?? "")) tail.shift();
  while (tail.length && isPySpace(tail[0] ?? "")) tail.shift();
  return ELLIPSIS + tail.join("");
}
