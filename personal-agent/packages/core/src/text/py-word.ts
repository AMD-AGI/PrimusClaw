// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Pieces of Python `re` word semantics for `u`-flagged patterns (Python's `\w`, `\d` and `\b` know every script;
 * JavaScript's are ASCII). Kept here until they move into `py-regex.ts`, where they belong.
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

const ALNUM = /^[\p{L}\p{N}]$/u;

/** `ch.isalnum()` for one code point. */
export function pyIsAlnum(ch: string): boolean {
  return ALNUM.test(ch);
}

const ASCII_ALPHA = /^[A-Za-z]+$/;

/** `word.isascii() and word.isalpha()`. */
export function isAsciiAlpha(word: string): boolean {
  return ASCII_ALPHA.test(word);
}
