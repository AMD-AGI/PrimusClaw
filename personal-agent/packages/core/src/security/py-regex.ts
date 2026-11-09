// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Python `re` semantics for patterns ported to JavaScript (always compiled with the `u` flag). On a str, Python's `\w`,
 * `\b`, `\d` and `\s` know every script; JavaScript's `\w`, `\b` and `\d` know ASCII only, and its `\s` is another set.
 * `pyRegExp` rewrites a Python pattern so that it means what it meant there.
 */

/** Python's `\w` on a str: a letter, a digit or `_` of any script (the class's content, without brackets). */
const WORD = "\\p{L}\\p{N}_";
/** Python's `\s` on a str (`str.isspace`), the class's content. */
const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

export const W = `[${WORD}]`;
export const S = `[${SPACE}]`;
/** `\b` in front of a word character. */
export const B_START = `(?<!${W})`;
/** `\b` after a word character. */
export const B_END = `(?!${W})`;
const BOUNDARY = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const NOT_BOUNDARY = `(?:(?<=${W})(?=${W})|(?<!${W})(?!${W}))`;

/** Characters a `u`-mode pattern may escape; any other escaped punctuation is written as itself. */
const SYNTAX = new Set(Array.from("^$\\.*+?()[]{}|/-"));

/** What `\<c>` becomes outside a character class (undefined: kept as it is). */
const OUTSIDE: Readonly<Record<string, string>> = {
  b: BOUNDARY,
  B: NOT_BOUNDARY,
  w: W,
  W: `[^${WORD}]`,
  d: "\\p{Nd}",
  D: "\\P{Nd}",
  s: S,
  S: `[^${SPACE}]`,
  A: "^",
  Z: "$",
};

/** What `\<c>` becomes inside a character class. */
const INSIDE: Readonly<Record<string, string>> = { w: WORD, d: "\\p{Nd}", s: SPACE };

function escape(c: string, inClass: boolean): string {
  const mapped = inClass ? INSIDE[c] : OUTSIDE[c];
  if (mapped !== undefined) return mapped;
  if (/[A-Za-z0-9]/.test(c) || SYNTAX.has(c)) return `\\${c}`;
  return c;
}

/**
 * `source`, a Python pattern, as a JavaScript RegExp with the same meaning on a str: `\b \B \w \W \d \D \s \S \A \Z`
 * rewritten (`\W` and `\S` only outside a class), a leading `(?i)` turned into the `i` flag, an escaped punctuation mark
 * that `u` mode refuses written as itself. `$` keeps its JavaScript meaning (end of input): ported patterns use `\Z`.
 */
export function pyRegExp(source: string, flags = ""): RegExp {
  let rest = source;
  let allFlags = `u${flags}`;
  if (rest.startsWith("(?i)")) {
    rest = rest.slice(4);
    allFlags += "i";
  }
  let out = "";
  let inClass = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest.charAt(i);
    if (c === "\\") {
      out += escape(rest.charAt(++i), inClass);
      continue;
    }
    if (c === "[" && !inClass) inClass = true;
    else if (c === "]" && inClass) inClass = false;
    out += c;
  }
  return new RegExp(out, allFlags);
}
