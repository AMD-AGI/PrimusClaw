// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { pyLstrip, pyStrip, squashSpaces } from "../../text/py-text.js";

/** A status update is at most this many characters ... */
export const STATUS_MAX_CHARS = 1000;
/** ... and this many bytes of UTF-8. */
export const STATUS_MAX_BYTES = 1024;
export const STATUS_JOIN = " · ";
const ENCODER = new TextEncoder();
const COMBINING = /^\p{Mn}/u;

function bytes(text: string): number {
  return ENCODER.encode(text).length;
}

/**
 * Status lines as one status update: whitespace collapsed, the lines joined by " · ", cut to the limits by keeping the
 * END (the newest) after a leading "…", never in the middle of a character's combining marks.
 */
export function statusText(lines: readonly string[]): string {
  const text = lines
    .filter((line) => line && pyStrip(line))
    .map(squashSpaces)
    .join(STATUS_JOIN);
  const chars = Array.from(text);
  if (chars.length <= STATUS_MAX_CHARS && bytes(text) <= STATUS_MAX_BYTES) return text;
  const budgetChars = STATUS_MAX_CHARS - 1;
  const budgetBytes = STATUS_MAX_BYTES - bytes("…");
  const kept: string[] = [];
  let used = 0;
  for (const char of [...chars].reverse()) {
    const size = bytes(char);
    if (kept.length + 1 > budgetChars || used + size > budgetBytes) break;
    kept.push(char);
    used += size;
  }
  let tail = kept.reverse().join("");
  while (tail && COMBINING.test(tail)) tail = Array.from(tail).slice(1).join(""); // (a mark without the letter it belongs to)
  return `…${pyLstrip(tail)}`;
}
