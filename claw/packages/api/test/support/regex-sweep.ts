// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Finding a regular expression that costs more than its input is long, without a list of the expressions to look at.
 *
 * A list that someone keeps by hand is the hole the last fix fell through: it named three patterns and a fourth stood next to them. So the
 * sweep starts from the source files: it reads every regular expression literal in them (`regexLiterals`), makes strings that each one
 * matches (`sampleStrings`), makes lines of them that a pattern which backtracks super-linearly is slow on (`sweepLines`), and counts the
 * work one `exec` does on each line at three lengths (`workOf`), in steps of a matcher that counts them (`./regex-work.ts`), not in
 * milliseconds: a count is the same on every machine, so how fast the work grows with the line is a number with no noise in it.
 *
 * Not a parser of JavaScript: a regular expression literal is told from a division by what stands before it, which is enough for source that
 * is written the way this repository's is, and `regexLiterals` is itself tested on that (see the sweep test).
 */

import { counted } from "./regex-work.js";

export interface RegexLiteral { source: string; flags: string; line: number }

const REGEX_CAN_FOLLOW = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "yield", "await"]);

/** Every regular expression literal in a TypeScript source, in order. */
export function regexLiterals(src: string): RegexLiteral[] {
  const out: RegexLiteral[] = [];
  let i = 0;
  let prev = ""; // the last token that counts: a punctuator, or "w" for a word, a literal or a closing bracket
  let lastWord = "";
  const lineOf = (pos: number): number => src.slice(0, pos).split("\n").length;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === "\\") i++; i++; }
      i++; prev = "w"; lastWord = ""; continue;
    }
    if (c === "`") {
      i++;
      let depth = 0;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (depth === 0 && src[i] === "`") break;
        if (src[i] === "$" && src[i + 1] === "{") { depth++; i += 2; continue; }
        if (depth > 0 && src[i] === "}") { depth--; i++; continue; }
        i++;
      }
      i++; prev = "w"; lastWord = ""; continue;
    }
    if (c === "/") {
      if (REGEX_CAN_FOLLOW.has(prev) || (prev === "w" && KEYWORDS_BEFORE_REGEX.has(lastWord))) {
        const start = i;
        i++;
        let inClass = false;
        while (i < src.length && (inClass || src[i] !== "/") && src[i] !== "\n") {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "[") inClass = true; else if (src[i] === "]") inClass = false;
          i++;
        }
        const source = src.slice(start + 1, i);
        i++;
        const flagsAt = i;
        while (i < src.length && /[a-z]/.test(src[i] as string)) i++;
        out.push({ source, flags: src.slice(flagsAt, i), line: lineOf(start) });
        prev = "w"; lastWord = "";
        continue;
      }
      prev = "/"; i++; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z0-9_$]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i] as string)) i++;
      lastWord = src.slice(start, i); prev = "w"; continue;
    }
    if (c === ")" || c === "]") { prev = "w"; lastWord = ""; i++; continue; }
    prev = c; i++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- strings a pattern matches

type Item = { atom: Atom; min: number; max: number };
type Atom =
  | { t: "lit"; ch: string } | { t: "any" } | { t: "anchor" } | { t: "esc"; e: string }
  | { t: "class"; neg: boolean; set: Array<{ ch?: string; range?: [string, string]; esc?: string }> }
  | { t: "group"; look: boolean; behind?: boolean; branches: Item[][] };

function parsePattern(src: string): Item[][] {
  let i = 0;
  const alternation = (): Item[][] => {
    const branches = [sequence()];
    while (src[i] === "|") { i++; branches.push(sequence()); }
    return branches;
  };
  const sequence = (): Item[] => {
    const items: Item[] = [];
    while (i < src.length && src[i] !== "|" && src[i] !== ")") {
      const atom = atomAt();
      let min = 1;
      let max = 1;
      const q = src[i];
      if (q === "?") { min = 0; max = 1; i++; }
      else if (q === "*") { min = 0; max = Infinity; i++; }
      else if (q === "+") { min = 1; max = Infinity; i++; }
      else if (q === "{") {
        const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(i));
        if (m) { min = Number(m[1]); max = m[2] ? (m[3] === "" ? Infinity : Number(m[3])) : min; i += m[0].length; }
      }
      if (src[i] === "?" && (min !== 1 || max !== 1)) i++; // lazy
      items.push({ atom, min, max });
    }
    return items;
  };
  const atomAt = (): Atom => {
    const c = src[i++] as string;
    if (c === "(") {
      let look = false;
      let behind = false;
      if (src[i] === "?") {
        if (src[i + 1] === ":") i += 2;
        else if (src[i + 1] === "=" || src[i + 1] === "!") { look = true; i += 2; }
        else if (src[i + 1] === "<" && (src[i + 2] === "=" || src[i + 2] === "!")) { look = true; behind = src[i + 2] === "="; i += 3; }
        else if (src[i + 1] === "<") i = src.indexOf(">", i) + 1;
      }
      const branches = alternation();
      i++; // the closing bracket
      return { t: "group", look, behind, branches };
    }
    if (c === "[") {
      let neg = false;
      if (src[i] === "^") { neg = true; i++; }
      const set: Array<{ ch?: string; range?: [string, string]; esc?: string }> = [];
      let first = true;
      while (i < src.length && (src[i] !== "]" || first)) {
        first = false;
        const ch = src[i++] as string;
        if (ch === "\\") { set.push({ esc: src[i++] as string }); continue; }
        if (src[i] === "-" && src[i + 1] !== "]") { const hi = src[i + 1] as string; i += 2; set.push({ range: [ch, hi] }); continue; }
        set.push({ ch });
      }
      i++;
      return { t: "class", neg, set };
    }
    if (c === "\\") return { t: "esc", e: src[i++] as string };
    if (c === "^" || c === "$") return { t: "anchor" };
    if (c === ".") return { t: "any" };
    return { t: "lit", ch: c };
  };
  return alternation();
}

const CANDIDATES = ["a", " ", "x", "1", "_", "-", ".", ",", ":", "=", "(", ")", '"', "'", "/", "*", "<", ">", "[", "]", "\t", "@", "!", ";", "$", "#"];
function classHas(c: string, cls: Extract<Atom, { t: "class" }>): boolean {
  let hit = false;
  for (const m of cls.set) {
    if (m.ch !== undefined && m.ch === c) hit = true;
    else if (m.range && c >= m.range[0] && c <= m.range[1]) hit = true;
    else if (m.esc === "s" && /\s/.test(c)) hit = true;
    else if (m.esc === "w" && /\w/.test(c)) hit = true;
    else if (m.esc === "d" && /\d/.test(c)) hit = true;
    else if (m.esc === c) hit = true;
  }
  return cls.neg ? !hit : hit;
}

/** A small deterministic generator, so that the same pattern is always read on the same strings. */
function generator(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * The longest a sample string is. A pattern whose shortest match is longer than this has no sample and so no line of the sweep, which the
 * sweep test fails on (a pattern it read on no line is not a pattern it found cheap); and the lines of the sweep are at least twice this
 * long (`workOf`), so that at least half of each is the part it repeats.
 */
export const SAMPLE_MAX = 120;

/**
 * Short strings the pattern matches (all or most of the time: lookaheads, negative lookbehinds and anchors are not enforced): up to `count` made by random
 * choices, and then one for every branch of every alternation, so that a branch is never left out because the random choices did not reach
 * it (a pattern of many branches, one of them catastrophic, is read on lines made from that one too).
 */
export function sampleStrings(source: string, count = 12): string[] {
  const rnd = generator(seedOf(source));
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const atom = (a: Atom): string => {
    switch (a.t) {
      case "lit": return a.ch;
      case "anchor": return "";
      case "any": return pick(["a", " ", "x"]);
      case "esc":
        if (a.e === "s") return pick([" ", "\t"]);
        if (a.e === "w") return pick(["a", "b", "_", "1"]);
        if (a.e === "W") return pick([" ", "-"]);
        if (a.e === "d") return "1";
        if (a.e === "S" || a.e === "D") return "a";
        if (a.e === "b" || a.e === "B") return "";
        if (a.e === "n") return "\n";
        if (a.e === "t") return "\t";
        return a.e;
      case "class": {
        const fits = CANDIDATES.filter((c) => classHas(c, a));
        if (fits.length > 0) return pick(fits);
        const first = a.set.find((m) => m.ch !== undefined || m.range);
        return first?.ch ?? first?.range?.[0] ?? "a";
      }
      // What a positive lookbehind asks for is written where it stands, since it is read from there backwards; other lookarounds are not.
      case "group": return a.look && !a.behind ? "" : alternation(a.branches);
    }
  };
  // A branch to take, when one is forced: `forced` is the alternation and the branch, and an alternation that holds it somewhere inside one
  // of its branches takes that branch, and a repeat that holds it repeats at least once, so that the forced branch is reached.
  let forced: { alts: Item[][]; branch: number } | null = null;
  const holds = new Map<Item[][], boolean>();
  const reaches = (alts: Item[][]): boolean => {
    if (forced === null) return false;
    if (alts === forced.alts) return true;
    let r = holds.get(alts);
    if (r === undefined) {
      r = alts.some((items) => items.some(({ atom: a }) => a.t === "group" && reaches(a.branches)));
      holds.set(alts, r);
    }
    return r;
  };
  const alternation = (alts: Item[][]): string => {
    if (forced !== null && alts === forced.alts) return sequence(alts[forced.branch]!);
    if (forced !== null) {
      const on = alts.find((items) => items.some(({ atom: a }) => a.t === "group" && reaches(a.branches)));
      if (on !== undefined) return sequence(on);
    }
    return sequence(pick(alts));
  };
  const sequence = (items: Item[]): string => {
    let out = "";
    for (const { atom: a, min, max } of items) {
      const most = Math.min(max, min + 2);
      let n = min + Math.floor(rnd() * (most - min + 1));
      if (n === 0 && max > 0 && a.t === "group" && reaches(a.branches)) n = 1;
      for (let k = 0; k < n; k++) out += atom(a);
    }
    return out;
  };
  const tree = parsePattern(source);
  const out = new Set<string>();
  for (let k = 0; k < count * 12 && out.size < count; k++) {
    const s = alternation(tree);
    if (s.length <= SAMPLE_MAX) out.add(s);
  }
  // Every alternation of the pattern, the whole of it included, and every branch of each.
  const alternations: Item[][][] = [];
  const collect = (alts: Item[][]): void => {
    if (alts.length > 1) alternations.push(alts);
    for (const items of alts) for (const { atom: a } of items) if (a.t === "group") collect(a.branches);
  };
  collect(tree);
  for (const alts of alternations) {
    for (let branch = 0; branch < alts.length; branch++) {
      forced = { alts, branch };
      holds.clear();
      for (let tries = 0; tries < 12; tries++) {
        const s = alternation(tree);
        if (s.length <= SAMPLE_MAX) { out.add(s); break; }
      }
    }
  }
  forced = null;
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------------- lines

const kindOf = (c: string): string => (/\w/.test(c) ? "w" : /\s/.test(c) ? "s" : c);

/**
 * The lines made of one opening of a sample string said over and over (`#[arg(#[arg(#[arg(` ...): the first 1 to 40 characters of a sample,
 * alone and with a space after, with and without a character that fails the match at the end, each as a recipe for a line of any length.
 * A pattern that scans on from its opening to the end of the line (`#\[arg\([^\]]*long`) starts again at every copy of the opening and reads
 * the rest of the line each time, so it costs the square of the line however short the run of one character it can divide is; a run of
 * one character pushed in (`sweepLines` below) never says its opening twice and does not find that.
 */
function repeatedOpenings(samples: string[]): Line[] {
  const units = new Set<string>();
  for (const s of samples) {
    for (let end = 1; end <= Math.min(s.length, 40); end++) { units.add(s.slice(0, end)); units.add(`${s.slice(0, end)} `); }
  }
  const lines: Line[] = [];
  for (const unit of units) {
    const at = (length: number): string => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
    const what = `${JSON.stringify(unit.repeat(Math.ceil(24 / unit.length)).slice(0, 24))}... (an opening said over and over)`;
    const period = unit.length;
    lines.push({ what, at, period }, { what: `${what}, then "!"`, at: (length) => `${at(length).slice(0, length - 1)}!`, period });
  }
  return lines;
}

/** A line the sweep reads a pattern on, as a recipe: the same line at any length, so that how its work grows with the length can be asked. */
export interface Line {
  what: string;
  at: (length: number) => string;
  /** How many characters the line repeats: two lengths that differ by a multiple of it end alike, so they are the same line, longer or shorter. */
  period: number;
}

/**
 * Every line the sweep reads a pattern on, as recipes: the lines that say one opening of a sample over and over (`repeatedOpenings`), and
 * each sample string with a run of characters pushed in where the kind of character changes (both ends, and wherever a word character meets
 * a space or a punctuation mark), with and without a character that fails the match after the run. A pattern that backtracks super-linearly
 * is slow on one of them however it is written, because what makes it slow is two parts that can both match the same run, and a run of the
 * right character in the right place divides between them in as many ways as it is long.
 */
export function sweepLines(source: string): Line[] {
  const samples = sampleStrings(source);
  const lines = repeatedOpenings(samples);
  for (const s of samples) {
    const cuts = Array.from({ length: s.length + 1 }, (_, k) => k).filter((k) => k === 0 || k === s.length || kindOf(s[k - 1] as string) !== kindOf(s[k] as string));
    for (const k of cuts) {
      for (const filler of new Set([" ", "a", "\t", s[k - 1] ?? "", s[k] ?? "", s.slice(Math.max(0, k - 2), k), s.slice(k, k + 2)])) {
        if (filler === "") continue;
        const pushed = (length: number): string => {
          const room = Math.max(0, length - s.length);
          return s.slice(0, k) + filler.repeat(Math.ceil(room / filler.length)).slice(0, room) + s.slice(k);
        };
        const what = `${JSON.stringify(s)} with ${JSON.stringify(filler)} repeated at ${k}`;
        const period = filler.length;
        lines.push({ what, at: pushed, period }, { what: `${what}, then "!"`, at: (length: number) => `${pushed(length).slice(0, length - 1)}!`, period });
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------- work

/** What a pattern does on one line of the sweep, in steps of the counting matcher (`./regex-work.ts`), not in milliseconds. */
export interface Work {
  line: Line;
  /** Steps of one `exec` on the line at the length asked, or `Infinity` when that was over the budget (`perChar` times the length). */
  steps: number;
  /**
   * The coefficient of the square of the line in the steps (`q` of `a + b·n + q·n²`), from the steps on the same line at three lengths
   * equally far apart (`n`, `n - d`, `n - 2d`, with `d` about a quarter of `n` and a whole number of the line's periods, so that the three
   * end alike): their second difference over `2d²`. Exactly zero for a pattern whose work on the line is linear in it, however much work
   * that is per character, since a count has no noise; the coefficient itself for one whose work is the square of the line; and more than
   * it for one whose work grows faster still. `0` when it was not measured: on a line where all of the steps are too few for a part
   * that grows with the square of the line to be over the bound (see `workOf`), and on one that was over the budget.
   */
  quadratic: number;
}

/**
 * The lines of the sweep (`sweepLines`) that the pattern is slow on at `length`: where one `exec` takes more than `perChar` steps per
 * character of the line, or where the part of its steps that grows with the square of the line has a coefficient over `quadratic`. A line
 * on which one `exec` takes no more than `quadratic` times the square of half the line is not measured at the two shorter lengths: the steps
 * at a length include that part, which is at least the coefficient times the square of the part of the line that repeats, and no line of
 * the sweep has less than half of itself repeating once it is at least twice as long as the longest sample (SAMPLE_MAX). With
 * `stopAtFirst` it returns at the first slow line. Also the line the pattern did the most work on, and the one whose work grew fastest.
 */
export function workOf(
  source: string, flags: string, length: number, bounds: { perChar: number; quadratic: number; stopAtFirst?: boolean },
): { slow: Work[]; most: Work; fastest: Work; lines: number } {
  if (length < 2 * SAMPLE_MAX) throw new Error(`a length of ${length} is too short for the lines of the sweep to repeat over half of it`);
  const pattern = counted(source, flags);
  const none: Work = { line: { what: "", at: () => "", period: 1 }, steps: 0, quadratic: 0 };
  const out = { slow: [] as Work[], most: none, fastest: none, lines: 0 };
  const seen = new Set<string>();
  for (const line of sweepLines(source)) {
    const text = line.at(length);
    if (seen.has(text)) continue;
    seen.add(text);
    out.lines += 1;
    const steps = pattern.steps(text, bounds.perChar * length);
    let quadratic = 0;
    if (steps !== Infinity && steps > bounds.quadratic * (length / 2) ** 2) {
      const d = line.period * Math.max(1, Math.round(length / 4 / line.period));
      quadratic = (steps - 2 * pattern.steps(line.at(length - d)) + pattern.steps(line.at(length - 2 * d))) / (2 * d * d);
    }
    const work: Work = { line, steps, quadratic };
    if (steps > out.most.steps) out.most = work;
    if (quadratic > out.fastest.quadratic) out.fastest = work;
    if (steps === Infinity || quadratic > bounds.quadratic) {
      out.slow.push(work);
      if (bounds.stopAtFirst) return out;
    }
  }
  return out;
}

/** A slow line, said: what the line was and what the pattern did on it. */
export const describeWork = (w: Work, length: number, perChar: number): string => (w.steps === Infinity
  ? `over ${perChar * length} steps (${perChar} a character) on ${w.line.what} at ${length} characters`
  : `${w.steps} steps on ${w.line.what} at ${length} characters, ${w.quadratic.toFixed(3)} of them per square of a character`);
