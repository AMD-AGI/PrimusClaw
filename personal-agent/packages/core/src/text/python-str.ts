// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * INTERIM (W4b): the Python string operations the answer and progress views need beyond `py-text.ts` (strip with a set
 * of characters, lstrip, negative slices, rfind, the ellipsis clip, `:.0f`). Asked of py-text's owner (W8); this file
 * goes when py-text has them.
 */

import { cpLength, cpSlice, isPySpace, pySplit, squashSpaces } from "./py-text.js";

/** The code points of `text`: what Python indexes and counts a string by. */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

export const pyLen = cpLength;
export const pySplitWords = pySplit;
export const collapseSpaces = squashSpaces;

/** `text[start:end]` in code points; negative indices count from the end, as in Python. */
export function pySlice(text: string, start: number, end?: number): string {
  if (start >= 0 && (end === undefined || end >= 0)) return cpSlice(text, start, end);
  return codePoints(text).slice(start, end).join("");
}

function stripped(char: string, chars: string | undefined): boolean {
  return chars === undefined ? isPySpace(char) : chars.includes(char);
}

/** `text.lstrip()`; with `chars`, `text.lstrip(chars)`. */
export function pyLstrip(text: string, chars?: string): string {
  const points = codePoints(text);
  let start = 0;
  while (start < points.length && stripped(points[start] ?? "", chars)) start += 1;
  return points.slice(start).join("");
}

/** `text.rstrip()`; with `chars`, `text.rstrip(chars)`. */
export function pyRstrip(text: string, chars?: string): string {
  const points = codePoints(text);
  let end = points.length;
  while (end > 0 && stripped(points[end - 1] ?? "", chars)) end -= 1;
  return points.slice(0, end).join("");
}

/** `text.strip()`; with `chars`, `text.strip(chars)`. */
export function pyStrip(text: string, chars?: string): string {
  return pyRstrip(pyLstrip(text, chars), chars);
}

/** `text.rfind(sub)` on code points: the index of the last occurrence, or -1. */
export function pyRfind(text: string, sub: string): number {
  const at = text.lastIndexOf(sub);
  return at < 0 ? -1 : cpLength(text.slice(0, at));
}

/** `text if len(text) <= limit else text[: limit - 1].rstrip() + "…"`. */
export function clipWithEllipsis(text: string, limit: number): string {
  return cpLength(text) <= limit ? text : `${pyRstrip(cpSlice(text, 0, limit - 1))}…`;
}
