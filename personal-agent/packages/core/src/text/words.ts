// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * More of Python's string semantics the routing rules depend on (beside `py-text.ts`): `str.split(None, 1)`,
 * `str.strip(chars)`, `isupper`, the value of a decimal digit of any script (`int()` reads `１２` as 12), and regular
 * expressions whose `\s` is Python's white space (`pyRegex`).
 */
import { isPySpace, pySplit, pyStrip } from "./py-text.js";

/** `text.split(None, 1)`: the first word and the rest (its leading white space removed), at most two parts. */
export function splitOnce(text: string): string[] {
  const chars = Array.from(text);
  let start = 0;
  while (start < chars.length && isPySpace(chars[start] ?? "")) start += 1;
  if (start === chars.length) return [];
  let end = start;
  while (end < chars.length && !isPySpace(chars[end] ?? "")) end += 1;
  let rest = end;
  while (rest < chars.length && isPySpace(chars[rest] ?? "")) rest += 1;
  const head = chars.slice(start, end).join("");
  return rest === chars.length ? [head] : [head, chars.slice(rest).join("")];
}

/** `text.strip(chars)`: every character in `chars` is removed from both ends. */
export function stripChars(text: string, chars: string): string {
  return rstripChars(lstripChars(text, chars), chars);
}

/** `text.rstrip(chars)`. */
export function rstripChars(text: string, chars: string): string {
  const parts = Array.from(text);
  while (parts.length > 0 && chars.includes(parts[parts.length - 1] ?? "")) parts.pop();
  return parts.join("");
}

/** `text.lstrip(chars)`. */
export function lstripChars(text: string, chars: string): string {
  const parts = Array.from(text);
  let start = 0;
  while (start < parts.length && chars.includes(parts[start] ?? "")) start += 1;
  return parts.slice(start).join("");
}

const DECIMAL = /^\p{Nd}$/u;

function isDecimal(codePoint: number): boolean {
  return codePoint >= 0 && DECIMAL.test(String.fromCodePoint(codePoint));
}

/** The value of one decimal digit of any script (Unicode keeps every script's 0-9 in runs of ten). */
function digitValue(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  let start = codePoint;
  while (isDecimal(start - 1)) start -= 1;
  return (codePoint - start) % 10;
}

/** `int(text)` for a string of decimal digits (`\d+` as Python's `re` matches it); NaN for anything else. */
export function decimalInt(text: string): number {
  if (!isDigits(text)) return Number.NaN;
  let value = 0;
  for (const char of text) value = value * 10 + digitValue(char);
  return value;
}

/** `text.isdigit()` for what the routing rules read: every character a decimal digit, and at least one. */
export function isDigits(text: string): boolean {
  return /^\p{Nd}+$/u.test(text);
}

/** `text.isupper()`: at least one cased character, and none in lower case. */
export function isUpper(text: string): boolean {
  return text !== text.toLowerCase() && text === text.toUpperCase();
}

/** `text.split()`. */
export const words = pySplit;
/** `text.strip()`. */
export const strip = pyStrip;

/** The characters of Python's `\s` (its `str.isspace`), as the inside of a character class. */
const PY_SPACE_CLASS = String.raw`\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;

/**
 * A regular expression from a Python pattern source: `\s` and `\d` mean what they mean in Python's `re` on a str
 * (its white space, any decimal digit), and the pattern must match the whole text (`re.fullmatch`). The `u` flag is
 * always on.
 */
export function pyFullmatch(source: string, flags = ""): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source.charAt(i);
    const next = source.charAt(i + 1);
    if (char === "\\" && (next === "s" || next === "d")) {
      const inner = next === "s" ? PY_SPACE_CLASS : String.raw`\p{Nd}`;
      out += inClass ? inner : `[${inner}]`;
      i += 1;
    } else if (char === "\\") {
      out += char + next;
      i += 1;
    } else {
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      out += char;
    }
  }
  return new RegExp(`^(?:${out})$`, `${flags}u`);
}

/** `text.lstrip()`. */
export function lstrip(text: string): string {
  const chars = Array.from(text);
  let start = 0;
  while (start < chars.length && isPySpace(chars[start] ?? "")) start += 1;
  return chars.slice(start).join("");
}
