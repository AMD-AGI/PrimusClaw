// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Text helpers that keep the Python worker's string semantics where a review request depends on them: lengths and slices count
 * code points (not UTF-16 units), "alphanumeric" and "word" are Unicode-aware, and whitespace runs collapse as `str.split()` does.
 */

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const ALNUM = /[\p{L}\p{N}]/u;

/** The number of code points in `text` (Python's `len`). */
export function cpLength(text: string): number {
  return codePoints(text).length;
}

/** The code points of `text` (Python iterates a string by code point). */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/** The first `limit` code points of `text` (Python's `text[:limit]`). */
export function cpSlice(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (n >= limit) break;
    out += ch;
    n += 1;
  }
  return out;
}

/** `" ".join(text.split())`: every run of white space becomes one space, none at either end. */
export function collapseSpaces(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(" ");
}

/** Case left out, as names and repositories are compared. */
export function casefold(text: string): string {
  return text.toLowerCase();
}

/** Python's `str.isalnum()` for one character. */
export function isAlnum(ch: string): boolean {
  return ALNUM.test(ch);
}

/** Python's `\w` for one character. */
export function isWordChar(ch: string): boolean {
  return WORD_CHAR.test(ch);
}

/** Every character of `text` that is a letter or a digit, case left out (how a name is compared). */
export function flat(text: string): string {
  let out = "";
  for (const ch of casefold(text)) if (isAlnum(ch)) out += ch;
  return out;
}

/** The distinct values, in the order first seen (Python's `dict.fromkeys`). */
export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** Python's `str.isupper()`: at least one cased character, and every cased one upper case. */
export function isUpper(text: string): boolean {
  let cased = false;
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (lower === upper) continue;
    if (ch !== upper) return false;
    cased = true;
  }
  return cased;
}

/** Python's `str.strip(chars)`: every character of `chars` taken off both ends. */
export function stripChars(text: string, chars: string): string {
  const set = new Set(chars);
  const points = codePoints(text);
  let start = 0;
  let end = points.length;
  while (start < end && set.has(points[start] ?? "")) start += 1;
  while (end > start && set.has(points[end - 1] ?? "")) end -= 1;
  return points.slice(start, end).join("");
}

/** What a name in a request is stripped of: spaces, commas, colons and "@". */
export const NAME_PADDING = " \t,，、:：@";

/** `who` with the padding a request leaves around a name taken off ('' when nothing is left). */
export function bareName(who: string): string {
  return stripChars(who, NAME_PADDING);
}
