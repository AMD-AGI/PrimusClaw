import { own } from "@primusclaw/personal-agent";
// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Regular-expression pieces with the meaning Python's `re` gives them on a str, for the inbound readers' patterns.
 * JavaScript differs in three places that matter here:
 *  - `\s`: Python's is `str.isspace()` (it has `\x1c`-`\x1f` and `\x85`, not U+FEFF): use `SPACE`;
 *  - `\w` and `\b`: Python's word characters are Unicode letters and digits and `_`: use `WORD` / `NOT_WORD_NEXT`;
 *  - `re.IGNORECASE` on an ASCII literal also matches U+0130 and U+0131 for i, U+212A (Kelvin) for k and U+017F for s, which
 *    JavaScript's `i` flag does or does not depending on `u`: spell such a literal with `caseless`, never with `i`.
 */

/** The characters Python's `\s` matches, as the inside of a character class. */
export const SPACE_CHARS =
  "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/** One character Python's `\s` matches. */
export const SPACE = `[${SPACE_CHARS}]`;

/** One character Python's `\w` matches (for patterns with the `u` flag). */
export const WORD = "[\\p{L}\\p{N}_]";

/** Python's `\b` after a word: the next character is not a word character (or there is none). */
export const NOT_WORD_NEXT = `(?!${WORD})`;

/** What else Python's `re.IGNORECASE` lets an ASCII letter match (measured on CPython: these three only). */
const FOLDS: Readonly<Record<string, string>> = { i: "\\u0130\\u0131", k: "\\u212a", s: "\\u017f" };

const SYNTAX = /[\\^$.*+?()[\]{}|/]/;

/** One character of a literal as a pattern source (escaped when it is syntax). */
function literalChar(ch: string): string {
  return SYNTAX.test(ch) ? `\\${ch}` : ch;
}

/**
 * `literal` as a pattern source that matches it the way Python's `re.IGNORECASE` would (for a pattern with the `u`
 * flag and without `i`). A non-ASCII letter matches its simple lower and upper case forms.
 */
export function caseless(literal: string): string {
  let source = "";
  for (const ch of literal) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (lower === upper || Array.from(lower).length > 1 || Array.from(upper).length > 1) {
      source += literalChar(ch);
      continue;
    }
    source += `[${lower}${upper}${own(FOLDS, lower) ?? ""}]`;
  }
  return source;
}
