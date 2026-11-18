// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { InvariantError } from "../errors.js";

/** The characters Python calls white space and printable (`str.isspace`, `str.isprintable`). */

/** The code point at `at` of `text`, which must have one there (`ord(text[at])`). */
export function pointAt(text: string, at = 0): number {
  const point = text.codePointAt(at);
  if (point === undefined) throw new InvariantError("no code point at that position");
  return point;
}

/**
 * The characters Python's `str.isspace()` is true for, which is also what `\s` matches in a Python `str` pattern
 * (JavaScript's `\s` lacks `\x1c`-`\x1f` and `\x85`, and has `\ufeff`). For a pattern: `new RegExp(`[${PY_SPACE}]`, "u")`.
 */
export const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** The same set, as code points (what `isPySpace` looks up: one hash lookup per character). */
const SPACE_POINTS: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
/** What `str.isprintable()` is false for: other (Cc, Cf, Cs, Co, Cn) and separators (Zl, Zp, Zs), except the space. */
const UNPRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/** `ch.isspace()` for one code point. */
export function isPySpace(ch: string): boolean {
  return ch.length === 1 && SPACE_POINTS.has(ch.charCodeAt(0));
}

/** `ch.isprintable()` for one code point. */
export function isPyPrintable(ch: string): boolean {
  return ch === " " || !UNPRINTABLE.test(ch);
}
