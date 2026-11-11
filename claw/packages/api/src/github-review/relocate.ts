// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where a finding goes, from the code it is about rather than from a line number alone, and which findings a re-review already has.
 *
 * A model counts lines badly in a long diff: a finding about the right code lands a few lines off, or on a line outside the diff,
 * which GitHub refuses with the whole review. Each finding may carry `existing_code`, the line or lines of the head it is about,
 * copied; the service finds that code among the lines the diff shows on the head side and puts the finding there when the given
 * line does not show it. The idea is open-code-review's `existing_code` and its re-location (alibaba/open-code-review,
 * `diff/relocation.go`); the matching here is plain text, with no model call.
 *
 * A re-review that says again what an open thread of the last review says would open a second thread on the same code: an inline
 * finding within a few lines of a finding of the last review whose thread is still open, and that says much the same (most of its
 * words are the recorded note's), is said in the body instead. A new problem near an old one says other things and keeps its thread.
 */
import { HUNK_RE } from "./diff.js";

/** The head-side lines a patch shows (added and context), by line number in the new file. */
export function headLines(patch: string | undefined | null): Map<number, string> {
  const out = new Map<number, string>();
  if (!patch) return out;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) { newLine = Number(hunk[2]); inHunk = true; continue; }
    if (!inHunk) continue;
    const c = line[0];
    if (c === "+" || c === " ") out.set(newLine++, line.slice(1));
    else if (line === "" && newLine !== 0) out.set(newLine++, "");
  }
  return out;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
/** At most this many lines of `existing_code` are matched: the first ones place the finding. */
const MAX_SNIPPET_LINES = 6;
/** A line this short (`}`, `return`) matches too much to place anything by itself. */
const MIN_FIRST_LINE_CHARS = 4;

/**
 * The head-side line where `existing_code` is shown in this patch, nearest to `line`, or null when it is not there (or too short to
 * place anything). The snippet's non-blank lines must follow one another among the shown lines, blank lines aside; a `+` or `-`
 * mark copied from the diff is ignored.
 */
export function locateCode(patch: string | undefined | null, code: string, line: number): number | null {
  const want = code.split("\n").map(norm).filter(Boolean).slice(0, MAX_SNIPPET_LINES);
  if (!want.length || (want[0] as string).length < MIN_FIRST_LINE_CHARS) return null;
  const all = headLines(patch);
  const shown = [...all.entries()].filter(([, t]) => norm(t) !== "");
  // Two shown lines follow one another in the file when every line between them is shown and blank (not in another hunk).
  const adjacent = (a: number, b: number): boolean => {
    for (let n = a + 1; n < b; n++) if (norm(all.get(n) ?? "x") !== "") return false;
    return true;
  };
  // A line copied from the diff with its `+` or `-` mark is the same line without it.
  const same = (shownText: string, w: string): boolean => {
    const t = norm(shownText);
    return t === w || ((w[0] === "+" || w[0] === "-") && t === norm(w.slice(1)));
  };
  let best: number | null = null;
  for (let i = 0; i < shown.length; i++) {
    if (!want.every((w, k) => {
      const here = shown[i + k];
      if (here === undefined || !same(here[1], w)) return false;
      return k === 0 || adjacent((shown[i + k - 1] as [number, string])[0], here[0]);
    })) continue;
    const at = (shown[i] as [number, string])[0];
    if (best === null || Math.abs(at - line) < Math.abs(best - line)) best = at;
  }
  return best;
}

export interface Placed { line: number; movedFrom: number | null }

/**
 * Where an inline comment on the head side goes: its own line when that line shows the start of `existing_code` (or it gave none),
 * else the nearest place the diff shows that code. Code that is not in the diff leaves the line as given (the review's own check
 * then refuses a line outside the diff, naming it).
 */
export function placeComment(patch: string | undefined | null, line: number, code: string | undefined): Placed {
  if (!code || !code.trim()) return { line, movedFrom: null };
  const at = locateCode(patch, code, line);
  if (at === null || at === line) return { line, movedFrom: null };
  // The given line inside the snippet's span is the same code: a finding about its third line stays there.
  const span = code.split("\n").filter((l) => l.trim()).length;
  if (line > at && line < at + span && headLines(patch).has(line)) return { line, movedFrom: null };
  return { line: at, movedFrom: line };
}

/** A finding of the last review, as a re-review is given it (`note`: the start of what it said). */
export interface OpenFinding { path: string; line: number | null; thread_id: string | null; resolved: boolean; note?: string }

/** Within this many lines of an open finding of the last review on the same file, a new inline finding is the same place. */
export const SAME_PLACE_LINES = 3;

/** At least this share of the words of the shorter of two texts must be in the other for them to say much the same. */
export const SAME_WORDS_SHARE = 0.6;

const segmenter = new Intl.Segmenter("en", { granularity: "word" });
const words = (t: string): Set<string> => new Set([...segmenter.segment(t.toLowerCase())].filter((s) => s.isWordLike && s.segment.length > 1).map((s) => s.segment));

/** Whether two findings say much the same: most words of the shorter (the recorded note is cut) are in the other. */
export function saysTheSame(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  if (small.size === 0) return false;
  let shared = 0;
  for (const w of small) if (big.has(w)) shared++;
  return shared / small.size >= SAME_WORDS_SHARE;
}

/** The open finding of the last review that an inline comment at `path:line` saying `body` would repeat, or null. */
export function repeatsOpenFinding(open: readonly OpenFinding[], path: string, line: number, body: string): OpenFinding | null {
  return open.find((f) => !f.resolved && f.thread_id !== null && f.path === path && f.line !== null && Math.abs(f.line - line) <= SAME_PLACE_LINES
    && typeof f.note === "string" && saysTheSame(f.note, body.slice(0, 400))) ?? null;
}
