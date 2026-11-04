// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Finding a regular expression that costs more than its input is long, without a list of the expressions to look at.
 *
 * A list that someone keeps by hand is the hole the last fix fell through: it named three patterns and a fourth stood next to them. So the
 * sweep starts from the source files: it reads every regular expression literal in them (`regexLiterals`), makes strings that each one
 * matches (`sampleStrings`), and times it on those strings with one run of repeated characters pushed in at every place where the kind of
 * character changes (`worstCost`). A pattern that backtracks super-linearly is slow on such a line however it is written, because what makes it
 * slow is two parts that can both match the same run, and a run of the right character in the right place divides between them in as many
 * ways as it is long.
 *
 * Not a parser of JavaScript: a regular expression literal is told from a division by what stands before it, which is enough for source that
 * is written the way this repository's is, and `regexLiterals` is itself tested on that (see the sweep test).
 */

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
  | { t: "group"; look: boolean; branches: Item[][] };

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
      if (src[i] === "?") {
        if (src[i + 1] === ":") i += 2;
        else if (src[i + 1] === "=" || src[i + 1] === "!") { look = true; i += 2; }
        else if (src[i + 1] === "<" && (src[i + 2] === "=" || src[i + 2] === "!")) { look = true; i += 3; }
        else if (src[i + 1] === "<") i = src.indexOf(">", i) + 1;
      }
      const branches = alternation();
      i++; // the closing bracket
      return { t: "group", look, branches };
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

/** A small deterministic generator, so that the same pattern is always timed on the same strings. */
function generator(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Up to `count` short strings the pattern matches (all or most of the time: lookarounds and anchors are not enforced). */
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
      case "group": return a.look ? "" : sequence(pick(a.branches));
    }
  };
  const sequence = (items: Item[]): string => {
    let out = "";
    for (const { atom: a, min, max } of items) {
      const most = Math.min(max, min + 2);
      const n = min + Math.floor(rnd() * (most - min + 1));
      for (let k = 0; k < n; k++) out += atom(a);
    }
    return out;
  };
  const tree = parsePattern(source);
  const out = new Set<string>();
  for (let k = 0; k < count * 12 && out.size < count; k++) {
    const s = sequence(pick(tree));
    if (s.length <= 60) out.add(s);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------------- timing

const kindOf = (c: string): string => (/\w/.test(c) ? "w" : /\s/.test(c) ? "s" : c);

/**
 * The lines made of one opening of a sample string said over and over (`#[arg(#[arg(#[arg(` ...): the first 1 to 40 characters of a sample,
 * alone and with a space after, with and without a character that fails the match at the end, each as a recipe for a line of any length.
 * A pattern that scans on from its opening to the end of the line (`#\[arg\([^\]]*long`) starts again at every copy of the opening and reads
 * the rest of the line each time, so it costs the square of the line however short the run of one character it can divide is; a run of
 * one character pushed in (`worstCost` below) never says its opening twice and does not find that.
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
    lines.push({ what, at }, { what: `${what}, then "!"`, at: (length) => `${at(length).slice(0, length - 1)}!` });
  }
  return lines;
}

/** A line the sweep times a pattern on, as a recipe: the same line at any length, so that how its cost grows with the length can be asked. */
export interface Line { what: string; at: (length: number) => string }

/**
 * The most one `exec` of the pattern cost, in milliseconds, over the sample strings each with a run of characters pushed in where the kind of
 * character changes, and with a character that fails the match after the run, and over lines that say one opening of a sample over and over
 * (`repeatedOpenings`), every line `length` characters long. Each slow line is timed again and the fastest of the runs counts, so one pause of
 * the process is not a slow pattern. With `stopAboveMs` it stops at the first line over that, which is how a pattern that is known to be slow
 * is shown to be without waiting for it on every line. `line` is the line that cost the most, and `over` every line that cost more than
 * `overMs`, which `growth` times again at other lengths: the line that cost the most can be one the pattern reads in linear time while
 * another, that cost less, is read in the square of its length.
 */
export function worstCost(
  source: string, flags: string, length: number, stopAboveMs = Infinity, overMs = Infinity,
): { ms: number; line: Line; over: Line[] } {
  const re = new RegExp(source, flags.replace(/[gy]/g, ""));
  let worst: { ms: number; line: Line; over: Line[] } = { ms: 0, line: { what: "", at: () => "" }, over: [] };
  const time = (line: string): number => { const t0 = performance.now(); re.exec(line); return performance.now() - t0; };
  const samples = sampleStrings(source);
  const slowest = (line: Line): boolean => {
    const text = line.at(length);
    let ms = time(text);
    if (ms > worst.ms || ms > overMs) {
      ms = Math.min(ms, time(text), time(text));
      if (ms > overMs) worst.over.push(line);
      if (ms > worst.ms) worst = { ms, line, over: worst.over };
    }
    return worst.ms > stopAboveMs;
  };
  for (const line of repeatedOpenings(samples)) if (slowest(line)) return worst;
  for (const s of samples) {
    // The places to push a run in: both ends, and wherever the kind of character changes.
    const cuts = Array.from({ length: s.length + 1 }, (_, k) => k).filter((k) => k === 0 || k === s.length || kindOf(s[k - 1] as string) !== kindOf(s[k] as string));
    for (const k of cuts) {
      for (const filler of new Set([" ", "a", "\t", s[k - 1] ?? "", s[k] ?? "", s.slice(Math.max(0, k - 2), k), s.slice(k, k + 2)])) {
        if (filler === "") continue;
        const pushed = (length: number): string => {
          const room = Math.max(0, length - s.length);
          return s.slice(0, k) + filler.repeat(Math.ceil(room / filler.length)).slice(0, room) + s.slice(k);
        };
        const what = `${JSON.stringify(s)} with ${JSON.stringify(filler)} repeated at ${k}`;
        for (const line of [{ what, at: pushed }, { what: `${what}, then "!"`, at: (length: number) => `${pushed(length).slice(0, length - 1)}!` }]) {
          if (slowest(line)) return worst;
        }
      }
    }
  }
  return worst;
}

/**
 * How many times as long an `exec` of the pattern takes on the line at `length` as on the same line at a quarter of it (`ratio`): about 4 for a
 * pattern whose cost is linear in its line, about 16 for one that costs the square of it, and more for worse; what one `exec` on the line
 * at `length` cost (`ms`); and the part of that cost that grows faster than the line (`excessMs`), whatever the rest of it is and however
 * fast the machine is: what it costs over four times the cost at a quarter of the length is three quarters of a part that grows with the
 * square of the line (`bn²` less `4b(n/4)²`), so that is taken as four thirds of it, which is more than the part when it grows faster still. The ratio is only telling where that is well over the resolution of the clock: a pattern that costs a microsecond
 * or two can take eight times as long on four times the line for reasons that have nothing to do with backtracking. A ratio of two times taken on the same
 * machine in the same moments, not a number of milliseconds: a busy or slow machine slows both alike. The two are timed in turn, `rounds`
 * times, and the least of each is the one compared, since a pause only ever makes a run slower. Each time is of as many `exec`s as make the
 * one on the long line last some tens of microseconds: enough that a pattern that costs a microsecond is not timed at the resolution of the
 * clock, and short enough that most runs fit between two of the pauses of a machine whose CPU is shared (a time of a millisecond is cut by
 * one in almost every round on a CPU quota of a quarter, and the least of them is no longer a time nothing touched).
 */
export function growth(source: string, flags: string, line: Line, length: number, rounds = 15): { ratio: number; ms: number; excessMs: number } {
  const re = new RegExp(source, flags.replace(/[gy]/g, ""));
  const short = line.at(Math.floor(length / 4));
  const long = line.at(length);
  const time = (text: string, runs: number): number => {
    const t0 = performance.now();
    for (let k = 0; k < runs; k++) re.exec(text);
    return performance.now() - t0;
  };
  time(short, 1);
  const once = Math.min(time(long, 1), time(long, 1));
  const runs = Math.min(100, Math.max(1, Math.ceil(0.05 / Math.max(once, 0.0005))));
  let leastShort = Infinity;
  let leastLong = Infinity;
  for (let round = 0; round < rounds; round++) {
    leastShort = Math.min(leastShort, time(short, runs));
    leastLong = Math.min(leastLong, time(long, runs));
  }
  return { ratio: leastLong / leastShort, ms: leastLong / runs, excessMs: ((leastLong - 4 * leastShort) * 4) / 3 / runs };
}

