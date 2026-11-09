// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The scanners inline markdown is read with: where code spans run, which delimiter runs can open or close an emphasis,
 * how far a `[label](destination "title")` link reaches, and where a bare URL ends. Offsets are UTF-16 offsets; every
 * limit that Python counts in characters is counted here in code points.
 */
import { LINK_SCAN, MAX_URL_CHARS } from "./constants.js";
import { advanceCp, cpAt, cpBefore, isAlnum, isSpace, unescapeMarkdown } from "./escape.js";

/** Start of a code span -> [end, content start, content end]. */
export type CodeSpans = ReadonlyMap<number, readonly [number, number, number]>;

const BACKTICKS = /`+/g;

function backtickRuns(text: string): [number, number][] {
  return Array.from(text.matchAll(BACKTICKS), (m) => [m.index, m.index + m[0].length]);
}

/** Python's `bisect_right(sorted, value)`. */
function bisectRight(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (value < (sorted[mid] ?? 0)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The code spans of `text`: a backtick run closes at the next run of the same length, found left to right, so a lone
 * backtick stays a backtick.
 */
export function codeSpans(text: string): CodeSpans {
  const runs = backtickRuns(text);
  const byLength = new Map<number, number[]>();
  runs.forEach(([start, end], index) => {
    const same = byLength.get(end - start) ?? [];
    same.push(index);
    byLength.set(end - start, same);
  });
  const spans = new Map<number, readonly [number, number, number]>();
  let index = 0;
  while (index < runs.length) {
    const [start, end] = runs[index] ?? [0, 0];
    const same = byLength.get(end - start) ?? [];
    const closingIndex = same[bisectRight(same, index)];
    const closing = closingIndex === undefined ? undefined : runs[closingIndex];
    if (closingIndex !== undefined && closing) {
      spans.set(start, [closing[1], end, closing[0]]);
      index = closingIndex + 1;
    } else {
      index += 1;
    }
  }
  return spans;
}

/** How many backtick runs in `text` neither open nor close a code span. */
export function unmatchedTicks(text: string): number {
  const spans = codeSpans(text);
  const matched = new Set<number>([...spans.keys(), ...Array.from(spans.values(), (s) => s[2])]);
  return backtickRuns(text).filter(([start]) => !matched.has(start)).length;
}

/** Whether the run text[start:end] of `ch` can close an emphasis of `size` delimiters. */
function closes(text: string, start: number, end: number, ch: string, size: number, floor: number): boolean {
  const run = end - start;
  if (start <= floor || isSpace(cpBefore(text, start))) return false;
  const runOk = (ch === "*" || ch === "_") && size === 1 ? run === 1 : run >= size;
  if (!runOk) return false;
  return !(ch === "_" && end < text.length && isAlnum(cpAt(text, end)));
}

/** Where the emphasis opened before `begin` closes (the offset of its closing delimiters), or null. */
export function findCloser(text: string, begin: number, ch: string, size: number, spans: CodeSpans): number | null {
  const n = text.length;
  let i = begin;
  while (i < n) {
    const c = text.charAt(i);
    const span = c === "`" ? spans.get(i) : undefined;
    if (c === "\\") {
      i += 2;
    } else if (span) {
      i = span[0];
    } else if (c === ch) {
      let j = i;
      while (j < n && text.charAt(j) === ch) j += 1;
      if (closes(text, i, j, ch, size, begin)) return j - size;
      i = j;
    } else {
      i += 1;
    }
  }
  return null;
}

/** Whether `size` delimiters `ch` at text[i] can open an emphasis. */
export function canOpen(text: string, i: number, ch: string, size: number): boolean {
  const after = cpAt(text, i + size);
  if (!after || isSpace(after)) return false;
  const before = cpBefore(text, i);
  if (ch === "_") return !isAlnum(before);
  if (ch === "+") return !(isAlnum(before) || before === "+") && after !== "+";
  return true;
}

function count(text: string, ch: string): number {
  return text.split(ch).length - 1;
}

/** A bare URL without the punctuation that ends the sentence around it. */
export function trimUrl(raw: string): string {
  let url = raw;
  while (url) {
    const last = url.charAt(url.length - 1);
    if (".,;:!?'*_~}]>".includes(last) || (last === ")" && count(url, ")") > count(url, "("))) url = url.slice(0, -1);
    else break;
  }
  return url;
}

/** The offset of the "]" that closes the label opened at text[i], or null within LINK_SCAN code points. */
function labelEnd(text: string, i: number, spans: CodeSpans): number | null {
  const limit = advanceCp(text, i, LINK_SCAN);
  let depth = 0;
  let j = i;
  while (j < limit) {
    const c = text.charAt(j);
    const span = c === "`" ? spans.get(j) : undefined;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (span) {
      j = span[0];
      continue;
    }
    if (c === "[") depth += 1;
    else if (c === "]") {
      depth -= 1;
      if (depth === 0) return j;
    }
    j += 1;
  }
  return null;
}

function skipBlanks(text: string, k: number, limit: number): number {
  let at = k;
  while (at < limit && (text.charAt(at) === " " || text.charAt(at) === "\t")) at += 1;
  return at;
}

/** The end of a bare destination from `start`: up to a blank or the ")" that closes the link. */
function bareEnd(text: string, start: number, limit: number): number {
  let k = start;
  let parens = 0;
  while (k < limit) {
    const c = text.charAt(k);
    if (c === " " || c === "\t") break;
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === "(") parens += 1;
    else if (c === ")") {
      if (!parens) break;
      parens -= 1;
    }
    k += 1;
  }
  return k;
}

/** `text.find(ch, from, limit)`. */
function findBefore(text: string, ch: string, from: number, limit: number): number {
  const at = text.indexOf(ch, from);
  return at >= 0 && at + ch.length <= limit ? at : -1;
}

/** The destination after "(" at `open`, and the offset after it and its optional title; null when it is not one. */
function destination(text: string, open: number): [string, number] | null {
  const limit = advanceCp(text, open, MAX_URL_CHARS + LINK_SCAN);
  let k = skipBlanks(text, open, limit);
  let dest: string;
  if (k < text.length && text.charAt(k) === "<") {
    const end = findBefore(text, ">", k + 1, limit);
    if (end < 0) return null;
    dest = text.slice(k + 1, end);
    k = end + 1;
  } else {
    const start = k;
    k = bareEnd(text, start, limit);
    dest = text.slice(start, k);
  }
  k = skipBlanks(text, k, limit);
  const quote = k < limit ? text.charAt(k) : "";
  if (quote === '"' || quote === "'" || quote === "(") {
    const end = findBefore(text, quote === "(" ? ")" : quote, k + 1, limit);
    if (end < 0) return null;
    k = skipBlanks(text, end + 1, limit);
  }
  return [dest, k];
}

/** `[label](destination "title")` at text[i] === "[": [label, destination, end offset] or null. */
export function parseLink(text: string, i: number, spans: CodeSpans): [string, string, number] | null {
  const j = labelEnd(text, i, spans);
  if (j === null || j + 1 >= text.length || text.charAt(j + 1) !== "(") return null;
  const parsed = destination(text, j + 2);
  if (!parsed) return null;
  const [dest, k] = parsed;
  if (k >= text.length || text.charAt(k) !== ")") return null;
  return [text.slice(i + 1, j), unescapeMarkdown(dest), k + 1];
}
