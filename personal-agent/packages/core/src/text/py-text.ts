// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * String operations with the Python worker's semantics, for texts that must come out byte-for-byte the same as it
 * wrote them (issue titles, card lines, stored values). JavaScript differs in three places that matter here:
 *  - a length or a cut counts UTF-16 code units, Python counts code points (an emoji is 2 here, 1 there);
 *  - `\s` and `trim()` know another set of white space than Python's `str.isspace` (`\x1c`-`\x1f`, `\x85`; `\ufeff`);
 *  - there is no `str.isprintable`.
 */

import { PY_SPACE, isPySpace } from "./py-chars.js";

export * from "./py-chars.js";
export * from "./py-json.js";
export * from "./py-number.js";

const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, "u");

/** `text.split()`: the words between runs of white space, none empty. */
export function pySplit(text: string): string[] {
  return text.split(SPACE_RUN).filter((word) => word !== "");
}

/** `" ".join(text.split())`: one line, single spaces. */
export function squashSpaces(text: string): string {
  return pySplit(text).join(" ");
}

/**
 * The bounds of `text` once the code units `strip` says are white space are taken off its ends, scanned from each end
 * (linear; a regular expression anchored at the end is quadratic on a long text with white space inside).
 */
function bounds(text: string, strip: (unit: string) => boolean, left: boolean, right: boolean): [number, number] {
  let start = 0;
  let end = text.length;
  while (left && start < end && strip(text.charAt(start))) start += 1;
  while (right && end > start && strip(text.charAt(end - 1))) end -= 1;
  return [start, end];
}

/** Python's white space is in the BMP, so a code unit test is a code point test (a surrogate is never space). */
function trimSpace(text: string, left: boolean, right: boolean): string {
  const [start, end] = bounds(text, isPySpace, left, right);
  return text.slice(start, end);
}

/** `chars` as a set of code points; ends are compared by code point, so an astral `chars` strips whole pairs. */
function trimChars(text: string, chars: string, left: boolean, right: boolean): string {
  const set = new Set(Array.from(chars));
  const points = Array.from(text);
  let start = 0;
  let end = points.length;
  while (left && start < end && set.has(points[start] ?? "")) start += 1;
  while (right && end > start && set.has(points[end - 1] ?? "")) end -= 1;
  return points.slice(start, end).join("");
}

/** `text.strip()`, or `text.strip(chars)`. */
export function pyStrip(text: string, chars?: string): string {
  return chars === undefined ? trimSpace(text, true, true) : trimChars(text, chars, true, true);
}

/** `text.lstrip()`, or `text.lstrip(chars)`. */
export function pyLstrip(text: string, chars?: string): string {
  return chars === undefined ? trimSpace(text, true, false) : trimChars(text, chars, true, false);
}

/** `text.rstrip()`, or `text.rstrip(chars)`. */
export function pyRstrip(text: string, chars?: string): string {
  return chars === undefined ? trimSpace(text, false, true) : trimChars(text, chars, false, true);
}

/**
 * `text.lower()`. JavaScript's `toLowerCase()` is the same full, context-sensitive mapping (final sigma, `İ` to `i̇`),
 * locale-independent as Python's; checked over every code point (they differ only where Node's Unicode is newer).
 */
export function pyLower(text: string): string {
  return text.toLowerCase();
}

const CHEROKEE_CAPITALS: readonly [number, number] = [0x13a0, 0x13f5];

/** One code point's `casefold()`: Python's full case folding, which differs from upper-then-lower in four places. */
function foldPoint(ch: string): string {
  const c = ch.codePointAt(0) ?? 0;
  if (c === 0x131) return ch; // dotless i folds to itself, not to "i"
  if (c === 0x1e9e) return "ss"; // capital sharp s folds like "ß"
  if (c >= CHEROKEE_CAPITALS[0] && c <= CHEROKEE_CAPITALS[1]) return ch; // Cherokee folds to its capitals
  if (c >= 0xab70 && c <= 0xabbf) return String.fromCodePoint(0x13a0 + (c - 0xab70));
  if (c >= 0x13f8 && c <= 0x13fd) return String.fromCodePoint(c - 8);
  return ch.toUpperCase().toLowerCase();
}

/**
 * `text.casefold()`: for comparing without case (`ß` and `ss`, `ſ` and `s` fold together; `ı` stays apart from `i`;
 * no final-sigma context, every `σ`/`ς`/`Σ` folds to `σ`). Per code point, as Python folds.
 */
export function pyCasefold(text: string): string {
  return Array.from(text, foldPoint).join("");
}

/** `text.split(None, 1)`: the first word and the rest (its leading white space removed); at most two parts. */
export function splitOnce(text: string): string[] {
  const rest = pyLstrip(text);
  if (rest === "") return [];
  const match = new RegExp(`^([^${PY_SPACE}]+)[${PY_SPACE}]*`, "u").exec(rest);
  const head = match?.[1] ?? rest;
  const tail = rest.slice(match?.[0].length ?? rest.length);
  return tail === "" ? [head] : [head, tail];
}

const DECIMAL_DIGIT = /^\p{Nd}$/u;

/** The value of one decimal digit of any script: Unicode keeps every script's 0-9 in a run of ten. */
function digitValue(ch: string): number {
  let start = ch.codePointAt(0) ?? 0;
  const at = start;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return (at - start) % 10;
}

/**
 * At least one character, each a decimal digit of any script (`\p{Nd}`: what `\d` matches in Python's `re`, and what
 * `int()` reads). NOT Python's `str.isdigit()`, which also takes
 * superscripts and circled digits (every caller reads ASCII or `\d` input, where the two agree).
 */
export function isDigits(text: string): boolean {
  return /^\p{Nd}+$/u.test(text);
}

/**
 * `int(text)` for a run of decimal digits of any script (`１２` is 12, `٣` is 3), exactly, of any size; undefined for
 * anything else.
 */
export function decimalBigInt(text: string): bigint | undefined {
  if (!isDigits(text)) return undefined;
  let value = 0n;
  for (const ch of text) value = value * 10n + BigInt(digitValue(ch));
  return value;
}

/**
 * `int(text)` as a number: exact up to 2^53, which the counts, hours and ids the rules read are far below; NaN for
 * anything that is no run of decimal digits, and refused (RangeError) past 2^53 rather than rounded (use
 * `decimalBigInt` for that).
 */
export function decimalInt(text: string): number {
  const value = decimalBigInt(text);
  if (value === undefined) return Number.NaN;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("an integer past 2^53 (use decimalBigInt)");
  return Number(value);
}

/**
 * `text.isupper()`: at least one uppercase character, and none that is lowercase or titlecase (the Unicode properties
 * Python reads: `ℂ` is upper though it has no lowercase form; `ĸ` and `ª` are lowercase though they have no uppercase).
 */
export function isUpper(text: string): boolean {
  let cased = false;
  for (const ch of text) {
    if (/[\p{Lowercase}\p{Lt}]/u.test(ch)) return false;
    if (/\p{Uppercase}/u.test(ch)) cased = true;
  }
  return cased;
}

/** `len(text)`: code points. */
export function cpLength(text: string): number {
  return Array.from(text).length;
}

function sliceIndex(index: number, length: number): number {
  return index < 0 ? Math.max(0, length + index) : Math.min(index, length);
}

/** `text[start:end]`, counted in code points; a negative bound counts from the end, as in Python. */
export function cpSlice(text: string, start: number, end?: number): string {
  const points = Array.from(text);
  const from = sliceIndex(start, points.length);
  const to = end === undefined ? points.length : sliceIndex(end, points.length);
  return from < to ? points.slice(from, to).join("") : "";
}

/** `text.rfind(sub)`: the code-point index of the last occurrence, -1 when there is none. */
export function cpRfind(text: string, sub: string): number {
  let at = text.lastIndexOf(sub);
  while (at > 0 && splitsPair(text, at, sub.length)) at = text.lastIndexOf(sub, at - 1);
  if (at === 0 && splitsPair(text, 0, sub.length)) at = -1;
  return at === -1 ? -1 : cpLength(text.slice(0, at));
}

function isHigh(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLow(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** Whether `text[at:at+length]` starts or ends inside a surrogate pair (half a code point, which Python never finds). */
function splitsPair(text: string, at: number, length: number): boolean {
  if (length === 0) return false;
  const end = at + length;
  return (
    (at > 0 && isLow(text.charCodeAt(at)) && isHigh(text.charCodeAt(at - 1))) ||
    (end < text.length && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end)))
  );
}

/** `text if len(text) <= limit else text[: limit - 1].rstrip() + "…"`. */
export function clipLine(text: string, limit: number): string {
  return cpLength(text) <= limit ? text : `${pyRstrip(cpSlice(text, 0, limit - 1))}\u2026`;
}

/** `text[:limit]`, without splitting a string that is short enough. */
export function cpHead(text: string, limit: number): string {
  return text.length <= limit ? text : cpSlice(text, 0, limit);
}
