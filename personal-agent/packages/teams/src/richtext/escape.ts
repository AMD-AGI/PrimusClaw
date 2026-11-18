// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Escaping and the Python character semantics the converter reads text with: HTML escaping of text and attributes,
 * markdown backslash escapes, Python's `\s` / `isspace` / `isalnum` for one code point, and code-point offsets in a
 * UTF-16 string.
 */
import { isPySpace } from "@primusclaw/personal-agent";

/** The characters Python's `\s` (and `str.isspace`) matches, as the body of a regex character class. */
export const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
/** Python's `\s` and `\S` as regex source (use with the "u" flag). */
export const S = `[${PY_SPACE}]`;
export const NS = `[^${PY_SPACE}]`;
/** Python's `$` without MULTILINE: the end, or just before a newline that ends the string. */
export const END = "(?=\\n?$)";

const ESCAPE = /\\([!-/:-@[-`{-~])/g;
const ALNUM = /^[\p{L}\p{N}]$/u;

/** `text` with markdown's backslash escapes resolved (`\-` is `-`), the way the converter reads it. */
export function unescapeMarkdown(text: string): string {
  return text.replace(ESCAPE, "$1");
}

function escText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The one way text and code reach the output. A seam (tests replace `esc` to prove that the validator fails closed
 * when escaping is broken); production code never changes it.
 */
export const escaping: { esc: (text: string) => string } = { esc: escText };

/** Python's `html.escape(text, quote=True)`. */
export function escapeAttr(text: string): string {
  return escText(text).replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

/** The code point that starts at `i` ("" past the end). */
export function cpAt(text: string, i: number): string {
  const code = text.codePointAt(i);
  return code === undefined ? "" : String.fromCodePoint(code);
}

/** The code point that ends just before `i` ("" at the start). */
export function cpBefore(text: string, i: number): string {
  if (i <= 0) return "";
  const low = text.charCodeAt(i - 1);
  if (i >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(i - 2, i);
  }
  return text.charAt(i - 1);
}

/** `ch.isspace()` for one code point ("" is false). */
export function isSpace(ch: string): boolean {
  return ch !== "" && isPySpace(ch);
}

/** `ch.isalnum()` for one code point ("" is false); letters and numbers of the Unicode version Node knows. */
export function isAlnum(ch: string): boolean {
  return ALNUM.test(ch);
}

/** The UTF-16 offset `count` code points after offset `i`, at most `text.length`. */
export function advanceCp(text: string, i: number, count: number): number {
  let at = i;
  for (let left = count; left > 0 && at < text.length; left--) {
    const code = text.codePointAt(at) ?? 0;
    at += code > 0xffff ? 2 : 1;
  }
  return at;
}

/**
 * Python's `text.strip()`, in linear time: a regex anchored at the end (`\s+$`) retries from every position of a
 * long inner run of blanks, which is quadratic in the line.
 */
export function strip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isPySpace(text.charAt(start))) start++;
  while (end > start && isPySpace(text.charAt(end - 1))) end--;
  return text.slice(start, end);
}

/** Python's `text.lstrip(chars)`. */
export function lstripChars(text: string, chars: string): string {
  let start = 0;
  while (start < text.length && chars.includes(text.charAt(start))) start++;
  return text.slice(start);
}

/** Python's `text.rstrip(chars)`. */
export function rstripChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}
