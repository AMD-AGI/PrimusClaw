// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { InvariantError } from "../errors.js";
import { PY_SPACE } from "./py-text.js";

/**
 * Python `re` escapes (in a `str` pattern) as JavaScript `u`-mode pattern text: the classes, anchors and character
 * escapes Python knows, each read as Python reads it. An escape Python refuses ("bad escape") is refused here too.
 */

/** Python's `\w` (letters, numbers and `_` of any script) as a character class. */
export const PY_W = String.raw`[\p{L}\p{N}_]`;
/** The inside of `PY_W`, to put in a class of one's own (`[${PY_W_CHARS}.-]`). */
export const PY_W_CHARS = String.raw`\p{L}\p{N}_`;
/** Python's `\d` (a decimal digit of any script), to put in a class. */
export const PY_D = String.raw`\p{Nd}`;
/** Python's `\b` before a word: not preceded by a word character. */
export const PY_B_START = `(?<!${PY_W})`;
/** Python's `\b` after a word: not followed by a word character. */
export const PY_B_END = `(?!${PY_W})`;

export const START = String.raw`(?<![\s\S])`;
export const END = String.raw`(?![\s\S])`;
/** Python folds these four together under IGNORECASE; JavaScript's case folding keeps the dotless and dotted apart. */
export const I_VARIANTS = "iIıİ";
const I_SET: ReadonlySet<string> = new Set(Array.from(I_VARIANTS));

const OUTSIDE: Readonly<Record<string, string>> = {
  s: `[${PY_SPACE}]`,
  S: `[^${PY_SPACE}]`,
  d: `[${PY_D}]`,
  D: `[^${PY_D}]`,
  w: PY_W,
  W: `[^${PY_W_CHARS}]`,
  b: `(?:(?<=${PY_W})${PY_B_END}|${PY_B_START}(?=${PY_W}))`,
  B: `(?:(?<=${PY_W})(?=${PY_W})|${PY_B_START}${PY_B_END})`,
  A: START,
  Z: END,
};

const INSIDE: Readonly<Record<string, string>> = { s: PY_SPACE, d: PY_D, w: PY_W_CHARS, b: "\\x08" };

/** Escapes JavaScript reads as Python does, kept as written. */
const SAME = new Set(["n", "t", "r", "f", "v"]);
const HEX: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

export interface EscapeContext {
  readonly inClass: boolean;
  readonly ignoreCase: boolean;
}

export interface Escape {
  /** The JavaScript pattern text. */
  readonly text: string;
  /** How many characters of the Python source it took. */
  readonly length: number;
}

/** One character as a JavaScript literal; under IGNORECASE, outside a class, `i`, `I`, `ı`, `İ` are one another. */
export function literal(ch: string, context: EscapeContext): string {
  if (context.ignoreCase && !context.inClass && I_SET.has(ch)) return `[${I_VARIANTS}]`;
  return `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`;
}

function refuse(what: string): never {
  throw new InvariantError(`${what} has no JavaScript form here`);
}

/** `\xhh`, `\uhhhh`, `\Uhhhhhhhh`: the character they name. */
function hexEscape(source: string, i: number, context: EscapeContext): Escape {
  const kind = source.charAt(i + 1);
  const digits = HEX[kind] ?? 0;
  const hex = source.slice(i + 2, i + 2 + digits);
  if (!new RegExp(`^[0-9a-fA-F]{${String(digits)}}$`).test(hex)) refuse(`the escape \\${kind}${hex}`);
  return { text: literal(String.fromCodePoint(parseInt(hex, 16)), context), length: 2 + digits };
}

/** `\0`, `\012`, `\101` (octal) and, outside a class, `\1`-`\99` (a group's text again). */
function digitEscape(source: string, i: number, context: EscapeContext): Escape {
  const rest = source.slice(i + 1);
  const octal = /^(?:0[0-7]{0,2}|[0-3][0-7]{2})/.exec(rest) ?? (context.inClass ? /^[0-7]{1,3}/.exec(rest) : null);
  if (octal)
    return { text: literal(String.fromCodePoint(parseInt(octal[0], 8)), context), length: 1 + octal[0].length };
  const group = /^[1-9][0-9]?/.exec(rest);
  if (!group || context.inClass) refuse(`the escape \\${rest.charAt(0)}`);
  // JavaScript compares a group's text again with its own case folding, which keeps ı and İ apart from i
  if (context.ignoreCase) refuse("a backreference under IGNORECASE");
  return { text: `\\${group[0]}`, length: 1 + group[0].length };
}

/** A JavaScript property escape `\p{..}`/`\P{..}` (not Python syntax: accepted for hand-built patterns). */
function propertyEscape(source: string, i: number): Escape | undefined {
  if (source.charAt(i + 2) !== "{") return undefined;
  const close = source.indexOf("}", i + 3);
  return close === -1 ? undefined : { text: source.slice(i, close + 1), length: close + 1 - i };
}

function letterEscape(letter: string, context: EscapeContext): string | undefined {
  if (SAME.has(letter)) return `\\${letter}`;
  if (letter === "a") return "\\x07";
  return (context.inClass ? INSIDE : OUTSIDE)[letter];
}

/** The escape that starts at `source[i]` (a backslash), as JavaScript pattern text. */
export function translateEscape(source: string, i: number, context: EscapeContext): Escape {
  const next = source.charAt(i + 1);
  if (next === "") refuse("a trailing backslash");
  if (next in HEX) return hexEscape(source, i, context);
  if (/[0-9]/.test(next)) return digitEscape(source, i, context);
  if (next === "p" || next === "P") return propertyEscape(source, i) ?? refuse(`the escape \\${next}`);
  if (next === "N") refuse("a named character \\N{...}");
  if (/[A-Za-z]/.test(next)) {
    const text = letterEscape(next, context);
    if (text === undefined) refuse(`the escape \\${next}`);
    return { text, length: 2 };
  }
  // A backslash before anything else is that character itself (what Python's re.escape writes: \- \  \# \& \~)
  const ch = String.fromCodePoint(source.codePointAt(i + 1) ?? 0);
  return { text: literal(ch, context), length: 1 + ch.length };
}
