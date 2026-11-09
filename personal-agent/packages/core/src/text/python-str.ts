// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * String operations with Python's semantics, for text whose exact shape is part of what the user sees (a cut at N
 * characters, whitespace collapsed). A JavaScript string counts UTF-16 code units and `trim` knows a different set of
 * whitespace; the Python worker counted code points and stripped what `str.isspace` says. Every limit and every cut in
 * the answer and progress views goes through here, so the two versions show the same text.
 */

/** What Python's `str.isspace` (and so `split()` / `strip()` with no argument) treats as whitespace. */
const PY_SPACE = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0                　";
const PY_SPACE_SET = new Set(PY_SPACE);
const PY_SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, "u");

export function isPySpace(char: string): boolean {
  return PY_SPACE_SET.has(char);
}

/** The code points of `text`: what Python indexes and counts a string by. */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/** `len(text)`: code points. */
export function pyLen(text: string): number {
  return codePoints(text).length;
}

/** `text[start:end]` in code points (negative indices count from the end, as in Python). */
export function pySlice(text: string, start: number, end?: number): string {
  return codePoints(text).slice(start, end).join("");
}

/** `text.split()`: the words between runs of whitespace, none empty. */
export function pySplitWords(text: string): string[] {
  return text.split(PY_SPACE_RUN).filter((word) => word !== "");
}

/** `" ".join(text.split())`: whitespace collapsed to single spaces, none at either end. */
export function collapseSpaces(text: string): string {
  return pySplitWords(text).join(" ");
}

/** `text.strip()`; with `chars`, `text.strip(chars)`. */
export function pyStrip(text: string, chars?: string): string {
  return pyRstrip(pyLstrip(text, chars), chars);
}

export function pyLstrip(text: string, chars?: string): string {
  const points = Array.from(text);
  let start = 0;
  while (start < points.length && stripped(points[start] ?? "", chars)) start += 1;
  return points.slice(start).join("");
}

export function pyRstrip(text: string, chars?: string): string {
  const points = Array.from(text);
  let end = points.length;
  while (end > 0 && stripped(points[end - 1] ?? "", chars)) end -= 1;
  return points.slice(0, end).join("");
}

function stripped(char: string, chars: string | undefined): boolean {
  return chars === undefined ? isPySpace(char) : chars.includes(char);
}

/** `text.rfind(sub)` on code points: the index of the last occurrence, or -1. */
export function pyRfind(text: string, sub: string): number {
  const at = text.lastIndexOf(sub);
  return at < 0 ? -1 : pyLen(text.slice(0, at));
}

/**
 * `text if len(text) <= limit else text[: limit - 1].rstrip() + "…"`: one line no longer than `limit`, ending in an
 * ellipsis when it was cut.
 */
export function clipWithEllipsis(text: string, limit: number): string {
  return pyLen(text) <= limit ? text : `${pyRstrip(pySlice(text, 0, limit - 1))}…`;
}
