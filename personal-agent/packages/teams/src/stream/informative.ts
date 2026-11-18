// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** An informative update of a Teams stream: the status line under the person's message, within Teams' size limits. */
import { pyLstrip, squashSpaces } from "@primusclaw/personal-agent";

/** An informative update is at most 1000 characters ... */
export const INFORMATIVE_MAX_CHARS = 1000;
/** ... and 1 KB. */
export const INFORMATIVE_MAX_BYTES = 1024;
export const STATUS_JOIN = " · ";

/** A mark that belongs to the letter before it (a combining mark: never the first character of a cut text). */
const COMBINING = /^\p{Mn}$/u;

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Status lines as one informative update: whitespace collapsed, the lines joined by " · ", cut to the limits by keeping
 * the END (the newest) after a leading "…", never starting with a combining mark.
 */
export function informativeText(lines: readonly string[]): string {
  const text = lines
    .map(squashSpaces)
    .filter((line) => line !== "")
    .join(STATUS_JOIN);
  const chars = Array.from(text);
  if (chars.length <= INFORMATIVE_MAX_CHARS && utf8Length(text) <= INFORMATIVE_MAX_BYTES) return text;
  const budgetChars = INFORMATIVE_MAX_CHARS - 1;
  const budgetBytes = INFORMATIVE_MAX_BYTES - utf8Length("…");
  const kept: string[] = [];
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const char = chars[i] ?? "";
    const size = utf8Length(char);
    if (kept.length + 1 > budgetChars || used + size > budgetBytes) break;
    kept.push(char);
    used += size;
  }
  const tail = kept.reverse();
  while (tail.length && COMBINING.test(tail[0] ?? "")) tail.shift();
  return "…" + pyLstrip(tail.join(""));
}
