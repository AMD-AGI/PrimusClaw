// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a message asks for a review (Python `github_connect._asks_for_review`): "review" and, within 40 characters on its line, a
 * word of merging, a link or owner/repo#N; or 代审 / 帮..审. Read in one pass: as a regular expression per "review", owner/repo#N
 * was tried from every place after it, each time reading the owner's run of name characters to its end ("review-" repeated grew
 * with the square of the line). Here every place in a run shares that run's end, and whether "/repo#N" follows an end is read once.
 */
import { pyRegExp } from "../../text/py-regex.js";

const REVIEW_WORD = pyRegExp(String.raw`(?<![A-Za-z])review(?![A-Za-z])`, "gi");
const REVIEW_ELSE = pyRegExp(String.raw`代审|帮.{0,6}审`);
const MERGE_OR_LINK = pyRegExp(String.raw`合入|merge|https?://`, "iy");
const REPO_TAIL = pyRegExp(String.raw`/[A-Za-z0-9._-]+#\d`, "iy");
/** [A-Za-z0-9-] as Python's re.I reads it, which also takes İ ı ſ and the Kelvin sign. */
const OWNER_CHARS = new Set(Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-İıſK"));
/** How many characters after "review" the request's word may start at. */
const NEAR = 40;

const matchesAt = (pattern: RegExp, text: string, at: number): boolean => {
  pattern.lastIndex = at;
  return pattern.test(text);
};

export function asksForReview(text: string): boolean {
  if (REVIEW_ELSE.test(text)) return true;
  const runEnd = new Map<number, number>();
  const tailOk = new Map<number, boolean>();
  const ownerAt = (q: number): boolean => {
    if (!OWNER_CHARS.has(text[q] ?? "")) return false;
    let end = runEnd.get(q);
    if (end === undefined) {
      let k = q;
      while (k < text.length && OWNER_CHARS.has(text[k] ?? "")) k += 1;
      for (let p = q; p < k; p += 1) runEnd.set(p, k); // (every place of the run read here ends where it does)
      end = k;
    }
    let ok = tailOk.get(end);
    if (ok === undefined) {
      ok = matchesAt(REPO_TAIL, text, end);
      tailOk.set(end, ok);
    }
    return ok;
  };
  REVIEW_WORD.lastIndex = 0;
  for (const word of text.matchAll(REVIEW_WORD)) {
    const start = word.index + word[0].length;
    // (NEAR + 1 places, counted in characters as Python counts them; none after the line's end)
    for (let q = start, seen = 0; q < text.length && seen <= NEAR; seen += 1) {
      if (q > start && text[q - 1] === "\n") break;
      if (matchesAt(MERGE_OR_LINK, text, q) || ownerAt(q)) return true;
      q += (text.codePointAt(q) ?? 0) > 0xffff ? 2 : 1;
    }
  }
  return false;
}
