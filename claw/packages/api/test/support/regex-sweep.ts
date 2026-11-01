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
 * The most one `exec` of the pattern cost, in milliseconds, over the sample strings each with a run of `length` characters pushed in where
 * the kind of character changes, and with a character that fails the match after the run. Each slow line is timed again and the fastest of
 * the runs counts, so one pause of the process is not a slow pattern. With `stopAboveMs` it stops at the first line over that, which is how a
 * pattern that is known to be slow is shown to be without waiting for it on every line.
 */
export function worstCost(source: string, flags: string, length: number, stopAboveMs = Infinity): { ms: number; line: string } {
  const re = new RegExp(source, flags.replace(/[gy]/g, ""));
  let worst = { ms: 0, line: "" };
  const time = (line: string): number => { const t0 = performance.now(); re.exec(line); return performance.now() - t0; };
  for (const s of sampleStrings(source)) {
    // The places to push a run in: both ends, and wherever the kind of character changes.
    const cuts = Array.from({ length: s.length + 1 }, (_, k) => k).filter((k) => k === 0 || k === s.length || kindOf(s[k - 1] as string) !== kindOf(s[k] as string));
    for (const k of cuts) {
      for (const filler of new Set([" ", "a", "\t", s[k - 1] ?? "", s[k] ?? "", s.slice(Math.max(0, k - 2), k), s.slice(k, k + 2)])) {
        if (filler === "") continue;
        const room = length - s.length;
        const run = filler.repeat(Math.ceil(room / filler.length)).slice(0, room);
        const pushed = s.slice(0, k) + run + s.slice(k);
        for (const line of [pushed, `${pushed.slice(0, length - 1)}!`]) {
          let ms = time(line);
          if (ms > worst.ms) {
            ms = Math.min(ms, time(line), time(line));
            if (ms > worst.ms) worst = { ms, line: `${JSON.stringify(s)} with ${JSON.stringify(filler)} x ${run.length} at ${k}` };
            if (worst.ms > stopAboveMs) return worst;
          }
        }
      }
    }
  }
  return worst;
}
