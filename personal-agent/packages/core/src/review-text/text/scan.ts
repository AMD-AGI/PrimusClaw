// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { isPySpace } from "../../text/py-text.js";

/**
 * Linear scans for the few patterns of the Python worker whose regular expressions backtrack polynomially on hostile input
 * (a run of "<" with no ">", a long word with no ":"). Each gives exactly the matches Python's `re` gives (leftmost first,
 * non-overlapping); the differential tests against the Python worker hold them to that.
 */

const WORD = /[\p{L}\p{N}_]/u;
const DIGIT = /\p{Nd}/u;
const isWord = (ch: string | undefined): boolean => ch !== undefined && WORD.test(ch);
const isDigit = (ch: string | undefined): boolean => ch !== undefined && DIGIT.test(ch);

/** One match: where it starts and ends (UTF-16 offsets). */
export type Span = readonly [number, number];

/** The spans of an opener, the shortest run to the first closer after it: `[(（][^)）]*[)）]` and `<[^>]*>`. */
export function bracketSpans(text: string, openers: string, closers: string): Span[] {
  const spans: Span[] = [];
  let at = 0;
  while (at < text.length) {
    let open = -1;
    for (let i = at; i < text.length; i += 1) {
      if (openers.includes(text.charAt(i))) {
        open = i;
        break;
      }
    }
    if (open < 0) break;
    let close = -1;
    for (let i = open + 1; i < text.length; i += 1) {
      if (closers.includes(text.charAt(i))) {
        close = i;
        break;
      }
    }
    // (no closer after this opener: none after any later one either)
    if (close < 0) break;
    spans.push([open, close + 1]);
    at = close + 1;
  }
  return spans;
}

/** `text` with every span replaced by what `by` gives for its text. */
export function replaceSpans(text: string, spans: readonly Span[], by: (matched: string) => string): string {
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    out += text.slice(at, start) + by(text.slice(start, end));
    at = end;
  }
  return out + text.slice(at);
}

/** `re.sub(r"[(（][^)）]*[)）]", "", text)`. */
export function withoutBracketed(text: string): string {
  return replaceSpans(text, bracketSpans(text, "(（", ")）"), () => "");
}

/** `path.ext:line` somewhere in the line (`[\w./-]+\.\w{1,8}:\d+`), how a finding is written. */
export function hasFileLine(line: string): boolean {
  for (let colon = line.indexOf(":"); colon >= 0; colon = line.indexOf(":", colon + 1)) {
    if (!isDigit(line[colon + 1])) continue;
    let n = 0;
    while (n < 9 && isWord(line[colon - 1 - n])) n += 1;
    if (n < 1 || n > 8 || line[colon - 1 - n] !== ".") continue;
    const before = line[colon - 2 - n];
    if (before !== undefined && (isWord(before) || "./-".includes(before))) return true;
  }
  return false;
}

/** The match of one alternative of the hidden parts at `at`, or 0 when none starts there. */
type Alternative = (text: string, at: number) => number;

const tagAt =
  (nextClose: () => (from: number) => number): Alternative =>
  (text, at) => {
    if (text[at] !== "<") return 0;
    const close = nextClose()(at + 1);
    return close < 0 ? 0 : close + 1 - at;
  };

const entityAt: Alternative = (text, at) => {
  if (text[at] !== "&") return 0;
  let i = at + 1;
  if (text[i] === "#") i += 1;
  const start = i;
  while (isWord(text[i])) i += 1;
  // (`#` may be a word of its own: "&#;" is no entity, "&#x;" is, and so is "&x;")
  if (i === start || text[i] !== ";") return 0;
  return i + 1 - at;
};

const urlAt: Alternative = (text, at) => {
  const rest = text.startsWith("https://", at) ? 8 : text.startsWith("http://", at) ? 7 : 0;
  if (!rest) return 0;
  let i = at + rest;
  while (i < text.length && !isPySpace(text.charAt(i))) i += 1; // Python's \S: \x1c-\x1f and \x85 are white space
  return i > at + rest ? i - at : 0;
};

const markerAt =
  (open: string, close: string): Alternative =>
  (text, at) => {
    if (text[at] !== open) return 0;
    let i = at + 1;
    while (isDigit(text[i])) i += 1;
    return i > at + 1 && text[i] === close ? i + 1 - at : 0;
  };

/**
 * The spans of `<[^>]*>|&#?\w+;|https?://\S+|⟦\d+⟧`: leftmost first, the alternatives tried in that order at each place,
 * non-overlapping.
 */
export function hiddenSpans(text: string, markOpen: string, markClose: string): Span[] {
  let gt = -2;
  const nextClose = () => (from: number) => {
    if (gt !== -1 && gt < from) gt = text.indexOf(">", from);
    return gt;
  };
  const alternatives: Alternative[] = [tagAt(nextClose), entityAt, urlAt, markerAt(markOpen, markClose)];
  const spans: Span[] = [];
  let at = 0;
  while (at < text.length) {
    let length = 0;
    for (const alternative of alternatives) {
      length = alternative(text, at);
      if (length) break;
    }
    if (length) {
      spans.push([at, at + length]);
      at += length;
    } else {
      at += 1;
    }
  }
  return spans;
}

/**
 * The matches of `([A-Za-z][A-Za-z0-9._-]{0,99})#(\d{1,7})(?!\d)`: (the word, the number's digits), leftmost first.
 */
export function wordHashNumbers(text: string): (readonly [string, string])[] {
  const found: (readonly [string, string])[] = [];
  const inRun = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9._-]/u.test(ch);
  let from = 0;
  for (let hash = text.indexOf("#"); hash >= 0; hash = text.indexOf("#", hash + 1)) {
    const digits = /^\p{Nd}+/u.exec(text.slice(hash + 1))?.[0] ?? "";
    const end = hash + 1 + digits.length;
    if (!digits || Array.from(digits).length > 7) continue;
    let start = hash;
    while (start > from && hash - start < 100 && inRun(text[start - 1])) start -= 1;
    while (start < hash && !/[A-Za-z]/u.test(text.charAt(start))) start += 1;
    if (start >= hash) continue;
    found.push([text.slice(start, hash), digits]);
    from = end;
  }
  return found;
}
