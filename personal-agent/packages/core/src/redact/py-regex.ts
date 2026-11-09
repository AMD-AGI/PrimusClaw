// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Pieces of Python `re` semantics for patterns ported to JavaScript (always compiled with the `u` flag). Python's `\w`,
 * `\b` and `\s` know Unicode letters, digits and white space; JavaScript's `\w` and `\b` know ASCII only.
 */

/** Python's `\w` on a str: a letter, a digit or `_` of any script. */
export const W = "[\\p{L}\\p{N}_]";
/** Python's `\s` on a str (`str.isspace`). */
export const S = "[\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
/** `\b` in front of a word character. */
export const B_START = `(?<!${W})`;
/** `\b` after a word character. */
export const B_END = `(?!${W})`;
