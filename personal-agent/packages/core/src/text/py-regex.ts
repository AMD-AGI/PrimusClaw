// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Pieces of regular expressions with Python's `re` semantics for `str` patterns, where JavaScript's differ: Python's
 * `\w`, `\d` and `\b` know every script (a Chinese character is a word character, a full-width digit is a digit), while
 * JavaScript's are ASCII even with the `u` flag. Use these inside a `u`-flagged pattern built with `new RegExp`.
 */

/** Python's `\w`: a letter, a number or `_` of any script. */
export const PY_W = "[\\p{L}\\p{N}_]";
/** The class body of `PY_W`, to put into a larger class (`[${PY_W_CHARS}.-]`). */
export const PY_W_CHARS = "\\p{L}\\p{N}_";
/** Python's `\d`: a decimal digit of any script. */
export const PY_D = "\\p{Nd}";
/** Python's `\b` in front of a word character: no word character before. */
export const PY_B_START = `(?<!${PY_W})`;
/** Python's `\b` after a word character: no word character after. */
export const PY_B_END = `(?!${PY_W})`;

const DECIMAL = /^\p{Nd}$/u;

/**
 * `int(digits)` for a run Python's `\d+` matched: every decimal digit of any script counts by its value. Unicode lays
 * out each script's digits as one run from 0 to 9, and adjacent runs start at a zero, so a digit's value is its distance
 * from the start of the run, modulo 10.
 */
export function pyInt(digits: string): number {
  let value = 0;
  for (const ch of digits) {
    const cp = ch.codePointAt(0) ?? 0;
    let start = cp;
    while (DECIMAL.test(String.fromCodePoint(start - 1))) start -= 1;
    value = value * 10 + ((cp - start) % 10);
  }
  return value;
}
