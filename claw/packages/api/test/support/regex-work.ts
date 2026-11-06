// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How much work a regular expression does on a line, counted, not timed.
 *
 * A time depends on the machine and on what else it is doing: a CI runner whose CPU is shared has made a linear pattern look slow, and made
 * a quadratic one look linear, in both directions, however many rounds were taken. So the sweep runs each pattern on a backtracking matcher
 * of its own that counts its steps: one for every place in the line a match is tried from, one for every instruction it runs, and one for
 * every character a repeat reads or gives back. The count is the same on every machine and in every run. It is not V8's own count of
 * anything, but it grows as the work of a backtracking engine does, V8's included: in proportion to the line for a pattern that is linear,
 * with its square for one that scans on from every copy of its opening, and faster for worse. Like V8, it does not try a match from a
 * character that no match can start with.
 *
 * The matcher reads what V8 reads, and that is checked rather than assumed: every match it makes is compared with V8's own `exec` of the same
 * pattern on the same line (`steps` throws on a difference), so a part of the syntax it got wrong cannot pass as a cheap pattern. What it
 * does not know (back references, `\p{...}`, modifiers, the `u` and `v` flags) it refuses to compile, and the sweep fails on that rather
 * than skip the pattern.
 *
 * Single characters (a literal, an escape such as `\s` or `\w`, a class, `.`) are tested by V8 itself, each through a one-character
 * expression made from its own source and flags, so what a class or `/i` matches is V8's answer, not a copy of the specification.
 */

type Node =
  | { k: "char"; cls: CharClass }
  | { k: "seq"; items: Node[] }
  | { k: "alt"; alts: Node[] }
  | { k: "group"; index: number | null; body: Node }
  | { k: "look"; ahead: boolean; negative: boolean; body: Node }
  | { k: "assert"; what: "^" | "$" | "b" | "B" }
  | { k: "rep"; body: Node; min: number; max: number; greedy: boolean };

/** A pattern the matcher does not read the way V8 does; the sweep fails on it. */
export class UnsupportedPattern extends Error {}

/** The characters one atom matches: V8's answer for every ASCII character, read once, and V8 asked again for any other. */
interface CharClass { ascii: Uint8Array; re: RegExp }
function charClass(atom: string, flags: string): CharClass {
  const re = new RegExp(`^(?:${atom})$`, flags.replace(/[^is]/g, ""));
  const ascii = new Uint8Array(128);
  for (let c = 0; c < 128; c++) ascii[c] = re.test(String.fromCharCode(c)) ? 1 : 0;
  return { ascii, re };
}
const inClass = (cls: CharClass, c: number): boolean => (c < 128 ? cls.ascii[c] === 1 : cls.re.test(String.fromCharCode(c)));

function parse(src: string, flags: string): { node: Node; groups: number } {
  let i = 0;
  let groups = 0;
  const fail = (why: string): never => { throw new UnsupportedPattern(`/${src}/${flags}: ${why} at ${i}`); };
  const escapeLength = (at: number): number => {
    const e = src[at + 1];
    if (e === undefined) return fail("a trailing backslash");
    if (e === "u") return /^[0-9a-fA-F]{4}$/.test(src.slice(at + 2, at + 6)) ? 6 : 2;
    if (e === "x") return /^[0-9a-fA-F]{2}$/.test(src.slice(at + 2, at + 4)) ? 4 : 2;
    if (e === "c" || e === "p" || e === "P" || e === "k") return fail(`\\${e}`);
    if (/[1-9]/.test(e)) return fail("a back reference");
    return 2;
  };
  const alternation = (): Node => {
    const alts = [sequence()];
    while (src[i] === "|") { i++; alts.push(sequence()); }
    return alts.length === 1 ? alts[0]! : { k: "alt", alts };
  };
  const sequence = (): Node => {
    const items: Node[] = [];
    while (i < src.length && src[i] !== "|" && src[i] !== ")") {
      const atom = atomAt();
      let min = 1;
      let max = 1;
      let quantified = true;
      const q = src[i];
      if (q === "?") { min = 0; max = 1; i++; }
      else if (q === "*") { min = 0; max = Infinity; i++; }
      else if (q === "+") { min = 1; max = Infinity; i++; }
      else if (q === "{" && /^\{\d+(?:,\d*)?\}/.test(src.slice(i))) {
        const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(i))!;
        min = Number(m[1]);
        max = m[2] ? (m[3] === "" ? Infinity : Number(m[3])) : min;
        i += m[0].length;
      } else quantified = false;
      if (!quantified) { items.push(atom); continue; }
      if (atom.k === "assert" || (atom.k === "look" && !atom.ahead)) fail("a quantified assertion");
      let greedy = true;
      if (src[i] === "?") { greedy = false; i++; }
      items.push({ k: "rep", body: atom, min, max, greedy });
    }
    return items.length === 1 ? items[0]! : { k: "seq", items };
  };
  const atomAt = (): Node => {
    const c = src[i] as string;
    if (c === "(") {
      i++;
      let node: Node;
      if (src[i] === "?") {
        const head = src.slice(i, i + 3);
        if (head.startsWith("?:")) { i += 2; node = { k: "group", index: null, body: alternation() }; }
        else if (head.startsWith("?=") || head.startsWith("?!")) { i += 2; node = { k: "look", ahead: true, negative: head[1] === "!", body: alternation() }; }
        else if (head === "?<=" || head === "?<!") { i += 3; node = { k: "look", ahead: false, negative: head[2] === "!", body: alternation() }; }
        else if (head.startsWith("?<")) {
          const end = src.indexOf(">", i);
          if (end < 0) fail("an unterminated group name");
          i = end + 1;
          const index = ++groups;
          node = { k: "group", index, body: alternation() };
        } else return fail("a group modifier");
      } else {
        const index = ++groups;
        node = { k: "group", index, body: alternation() };
      }
      if (src[i] !== ")") fail("an unclosed group");
      i++;
      return node;
    }
    if (c === "^" || c === "$") { i++; return { k: "assert", what: c }; }
    if (c === "\\" && (src[i + 1] === "b" || src[i + 1] === "B")) { const what = src[i + 1] as "b" | "B"; i += 2; return { k: "assert", what }; }
    const start = i;
    if (c === "[") {
      i++;
      if (src[i] === "^") i++;
      while (i < src.length && src[i] !== "]") i += src[i] === "\\" ? escapeLength(i) : 1;
      if (src[i] !== "]") fail("an unclosed class");
      i++;
    } else if (c === "\\") i += escapeLength(i);
    else if (c === "*" || c === "+" || c === "?") fail("a quantifier with nothing to repeat");
    else i++;
    return { k: "char", cls: charClass(src.slice(start, i), flags) };
  };
  if (/[uv]/.test(flags)) fail("the u and v flags");
  const node = alternation();
  if (i !== src.length) fail("an unmatched closing bracket");
  return { node, groups };
}

// ------------------------------------------------------------------------------------------------------------ the program

const CHAR = 0, BACK = 1, SPLIT = 2, JMP = 3, SAVE = 4, ASSERT = 5, LOOK = 6, NOT = 7, MARK = 8, PROGRESS = 9, CLEAR = 10, MATCH = 11, STAR = 12;
const BOL = 0, EOL = 1, WORD_EDGE = 2, NOT_WORD_EDGE = 3;
/**
 * One instruction, all of one shape (what `a` and `b` are depends on `op`), so that the loop that runs them reads one kind of object. `STAR`
 * is a repeat of one character, `a` to `b` times, `greedy` or not, read from the right when `back`: it is what `SPLIT`, `CHAR` and `JMP` in a
 * loop would do, one step for every character it reads and one for every one it gives back, without an entry on the stack for each.
 */
interface Ins { op: number; a: number; b: number; cls: CharClass; prog: Ins[]; greedy: boolean; back: boolean }
const NO_CLASS: CharClass = { ascii: new Uint8Array(128), re: /[^\s\S]/ };
const ins = (op: number, a = 0, b = 0, cls = NO_CLASS, prog: Ins[] = [], greedy = true, back = false): Ins => ({ op, a, b, cls, prog, greedy, back });

/** Most instructions a program may have: `{n,m}` is unrolled, and an unrolled repeat inside another could make one that is far too big. */
const MAX_PROGRAM = 200_000;

function compile(root: Node, src: string): { prog: Ins[]; regs: number } {
  let regs = 0;
  const groupsIn = (n: Node): number[] => {
    switch (n.k) {
      case "group": return [...(n.index === null ? [] : [n.index]), ...groupsIn(n.body)];
      case "seq": return n.items.flatMap(groupsIn);
      case "alt": return n.alts.flatMap(groupsIn);
      case "look": case "rep": return groupsIn(n.body);
      default: return [];
    }
  };
  const emit = (n: Node, back: boolean, out: Ins[]): void => {
    if (out.length > MAX_PROGRAM) throw new UnsupportedPattern(`/${src}/: the program is over ${MAX_PROGRAM} instructions`);
    switch (n.k) {
      case "char": out.push(ins(back ? BACK : CHAR, 0, 0, n.cls)); return;
      case "assert": out.push(ins(ASSERT, { "^": BOL, $: EOL, b: WORD_EDGE, B: NOT_WORD_EDGE }[n.what])); return;
      case "seq": for (const item of back ? [...n.items].reverse() : n.items) emit(item, back, out); return;
      case "alt": {
        const jumps: Ins[] = [];
        n.alts.forEach((alt, k) => {
          if (k < n.alts.length - 1) {
            const split = ins(SPLIT, out.length + 1, -1);
            out.push(split);
            emit(alt, back, out);
            const jmp = ins(JMP, -1);
            jumps.push(jmp);
            out.push(jmp);
            split.b = out.length;
          } else emit(alt, back, out);
        });
        for (const j of jumps) j.a = out.length;
        return;
      }
      case "group":
        if (n.index === null) { emit(n.body, back, out); return; }
        // Read from the right inside a lookbehind, a group is entered at its end.
        out.push(ins(SAVE, 2 * n.index + (back ? 1 : 0)));
        emit(n.body, back, out);
        out.push(ins(SAVE, 2 * n.index + (back ? 0 : 1)));
        return;
      case "look": {
        const prog: Ins[] = [];
        emit(n.body, !n.ahead, prog);
        prog.push(ins(MATCH));
        out.push(ins(n.negative ? NOT : LOOK, 0, 0, NO_CLASS, prog));
        return;
      }
      case "rep": {
        if (n.body.k === "char") {
          out.push(ins(STAR, n.min, n.max, n.body.cls, [], n.greedy, back));
          return;
        }
        const inner = groupsIn(n.body);
        const clear = (): void => { if (inner.length > 0) out.push(ins(CLEAR, 2 * Math.min(...inner), 2 * Math.max(...inner) + 1)); };
        for (let k = 0; k < n.min; k++) { clear(); emit(n.body, back, out); }
        if (n.max === n.min) return;
        // An iteration past the minimum that matches nothing fails (the specification's RepeatMatcher), or `(a*)*` would never end.
        const reg = regs++;
        const optional = (): Ins => {
          const split = ins(SPLIT, -1, -1);
          out.push(split);
          if (n.greedy) split.a = out.length; else split.b = out.length;
          clear();
          out.push(ins(MARK, reg));
          emit(n.body, back, out);
          out.push(ins(PROGRESS, reg));
          return split;
        };
        if (n.max === Infinity) {
          const top = out.length;
          const split = optional();
          out.push(ins(JMP, top));
          if (n.greedy) split.b = out.length; else split.a = out.length;
          return;
        }
        const splits = Array.from({ length: n.max - n.min }, optional);
        for (const split of splits) { if (n.greedy) split.b = out.length; else split.a = out.length; }
        return;
      }
    }
  };
  const prog: Ins[] = [];
  emit(root, false, prog);
  prog.push(ins(MATCH));
  return { prog, regs };
}

/**
 * The characters a match can start with, or `null` when it can be empty: a start where none of them is costs the search one step, as it
 * does V8, which looks at the first character before it runs the pattern. An assertion or a lookaround consumes nothing and is passed over.
 */
function firstChars(n: Node): { tests: CharClass[]; empty: boolean } {
  switch (n.k) {
    case "char": return { tests: [n.cls], empty: false };
    case "assert": case "look": return { tests: [], empty: true };
    case "group": return firstChars(n.body);
    case "rep": { const f = firstChars(n.body); return { tests: f.tests, empty: f.empty || n.min === 0 }; }
    case "alt": { const fs = n.alts.map(firstChars); return { tests: fs.flatMap((f) => f.tests), empty: fs.some((f) => f.empty) }; }
    case "seq": {
      const tests: CharClass[] = [];
      for (const item of n.items) { const f = firstChars(item); tests.push(...f.tests); if (!f.empty) return { tests, empty: false }; }
      return { tests, empty: true };
    }
  }
}

// ------------------------------------------------------------------------------------------------------------ the counter

const isWord = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isLineEnd = (c: number): boolean => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

export interface CountedPattern {
  /** The pattern as V8 runs it, without `g` and `y`. */
  native: RegExp;
  /**
   * Steps of one `exec` of the pattern on `text` (searching from its start), or `Infinity` when that is over `budget`. A pattern with `g`
   * is run as a caller that wants every match runs it (`matchAll`, `replace`): on from where the last match ended, to the end of the text.
   * A pattern with `y` is run from wherever the caller sets `lastIndex`, so from every place in the text, each a sticky `exec` of its own,
   * a match found or not. Either way a match early in the line does not end the count.
   */
  steps: (text: string, budget?: number) => number;
}

/**
 * The pattern, compiled to a counting matcher. Every run that finishes is compared with V8's `exec` of the same pattern on the same text: a
 * different match, or a match where V8 found none, throws, since the count of a matcher that read something else says nothing about V8.
 */
export function counted(source: string, flags: string): CountedPattern {
  const runFlags = flags.replace(/[gyd]/g, "");
  const native = new RegExp(source, runFlags);
  const everyStart = flags.includes("y");
  const global = !everyStart && flags.includes("g");
  const sticky = new RegExp(source, `${runFlags}y`);
  const nativeGlobal = new RegExp(source, `${runFlags}g`);
  const { node, groups } = parse(source, runFlags);
  const { prog, regs } = compile(node, source);
  const first = firstChars(node);
  const canStart: CharClass | null = first.empty ? null : {
    ascii: Uint8Array.from({ length: 128 }, (_, c) => (first.tests.some((t) => t.ascii[c] === 1) ? 1 : 0)),
    re: { test: (ch: string) => first.tests.some((t) => t.re.test(ch)) } as RegExp,
  };
  const multiline = runFlags.includes("m");
  const caps = new Int32Array(2 * (groups + 1));
  const reg = new Int32Array(Math.max(regs, 1));
  // The backtracking stack, entries of four numbers, and how much of it is in use (`sp`); it grows as a search needs it to.
  let stack = new Int32Array(1 << 12);
  let sp = 0;
  const push = (kind: number, slot: number, value: number, more: number): void => {
    if (sp + 4 > stack.length) { const bigger = new Int32Array(stack.length * 2); bigger.set(stack); stack = bigger; }
    stack[sp] = kind; stack[sp + 1] = slot; stack[sp + 2] = value; stack[sp + 3] = more; sp += 4;
  };

  const steps = (text: string, budget = Infinity): number => {
    const len = text.length;
    let count = 0;
    // One thread of the backtracking search, from `at`. The stack holds entries of four: kind 0 (go to pc at pos), 1 (restore a capture),
    // 2 (restore a register), 3 (a greedy STAR at pc gives back one more character: pos, and how many more it may give back) and 4 (a lazy
    // STAR at pc takes one more: pos, and how many it has taken). Returns where the match ends, -1 when there is none, or -2 when the budget
    // ran out.
    const run = (p: Ins[], at: number): number => {
      const floor = sp;
      let n = count; // the steps, counted in a local and handed back to `count` whenever the run returns or looks around
      let pc = 0;
      let pos = at;
      for (;;) {
        if (++n > budget) { count = n; return -2; }
        const i = p[pc]!;
        let ok = true;
        switch (i.op) {
          case CHAR: if (pos < len && inClass(i.cls, text.charCodeAt(pos))) { pos++; pc++; } else ok = false; break;
          case BACK: if (pos > 0 && inClass(i.cls, text.charCodeAt(pos - 1))) { pos--; pc++; } else ok = false; break;
          case SPLIT: push(0, i.b, pos, 0); pc = i.a; break;
          case JMP: pc = i.a; break;
          case SAVE: push(1, i.a, caps[i.a]!, 0); caps[i.a] = pos; pc++; break;
          case MARK: push(2, i.a, reg[i.a]!, 0); reg[i.a] = pos; pc++; break;
          case PROGRESS: if (pos === reg[i.a]) ok = false; else pc++; break;
          case CLEAR:
            for (let s = i.a; s <= i.b; s++) { if (caps[s] !== -1) { push(1, s, caps[s]!, 0); caps[s] = -1; } }
            pc++;
            break;
          case ASSERT: {
            const before = pos > 0 ? text.charCodeAt(pos - 1) : -1;
            const after = pos < len ? text.charCodeAt(pos) : -1;
            if (i.a === BOL) ok = pos === 0 || (multiline && isLineEnd(before));
            else if (i.a === EOL) ok = pos === len || (multiline && isLineEnd(after));
            else ok = ((before >= 0 && isWord(before)) !== (after >= 0 && isWord(after))) === (i.a === WORD_EDGE);
            if (ok) pc++;
            break;
          }
          case LOOK: case NOT: {
            const saved = caps.slice();
            count = n;
            const end = run(i.prog, pos);
            n = count;
            if (end === -2) { count = n; return -2; }
            if ((end >= 0) !== (i.op === LOOK)) { caps.set(saved); ok = false; break; }
            // A lookaround that matched keeps what its groups captured, and gives it back when the search backtracks past it.
            if (i.op === LOOK) { for (let s = 0; s < caps.length; s++) if (caps[s] !== saved[s]) push(1, s, saved[s]!, 0); }
            pc++;
            break;
          }
          case STAR: {
            const step = i.back ? -1 : 1;
            let taken = 0;
            const most = i.greedy ? i.b : i.a;
            while (taken < most) {
              const at = i.back ? pos - 1 : pos;
              if (at < 0 || at >= len) break;
              if (++n > budget) { count = n; return -2; }
              if (!inClass(i.cls, text.charCodeAt(at))) break;
              pos += step;
              taken++;
            }
            if (taken < i.a) { ok = false; break; }
            if (i.greedy) { if (taken > i.a) push(3, pc, pos, taken - i.a); }
            else if (i.b > i.a) push(4, pc, pos, taken);
            pc++;
            break;
          }
          case MATCH: sp = floor; count = n; return pos;
        }
        if (ok) continue;
        // Back to the most recent alternative, undoing what was captured since.
        for (;;) {
          if (sp === floor) { count = n; return -1; }
          sp -= 4;
          const kind = stack[sp]!;
          const slot = stack[sp + 1]!;
          const value = stack[sp + 2]!;
          const more = stack[sp + 3]!;
          if (kind === 1) caps[slot] = value;
          else if (kind === 2) reg[slot] = value;
          else if (kind === 0) { pc = slot; pos = value; break; }
          else {
            if (++n > budget) { count = n; return -2; }
            const star = p[slot]!;
            const step = star.back ? -1 : 1;
            if (kind === 3) {
              pos = value - step;
              if (more > 1) push(3, slot, pos, more - 1);
              pc = slot + 1;
              break;
            }
            const at = star.back ? value - 1 : value;
            if (more < star.b && at >= 0 && at < len && inClass(star.cls, text.charCodeAt(at))) {
              pos = value + step;
              if (more + 1 < star.b) push(4, slot, pos, more + 1);
              pc = slot + 1;
              break;
            }
          }
        }
      }
    };
    let found: number[] | null = null;
    // A run that finds nothing has gone back over everything it did, and so has given back every capture and register it set.
    caps.fill(-1);
    reg.fill(-1);
    nativeGlobal.lastIndex = 0;
    for (let start = 0; start <= len; start++) {
      if (++count > budget) { sp = 0; return Infinity; }
      if (canStart !== null && (start === len || !inClass(canStart, text.charCodeAt(start)))) continue;
      const end = run(prog, start);
      if (end === -2) { sp = 0; return Infinity; }
      if (end >= 0) { caps[0] = start; caps[1] = end; }
      if (everyStart) {
        // Each start is one sticky `exec`, and is compared with V8's at that `lastIndex`.
        sticky.lastIndex = start;
        same(text, end >= 0 ? Array.from(caps) : null, sticky.exec(text), start);
        caps.fill(-1);
        reg.fill(-1);
        continue;
      }
      if (end >= 0 && global) {
        // Every match in turn, each compared with V8's next one; the next search starts where this match ended (one on, if it was empty).
        const next = nativeGlobal.exec(text);
        // As `matchAll` and `replace` do: an empty match moves the next search on by one.
        if (next !== null && next[0] === "") nativeGlobal.lastIndex += 1;
        same(text, Array.from(caps), next, start);
        caps.fill(-1);
        reg.fill(-1);
        start = end > start ? end - 1 : start;
        continue;
      }
      if (end >= 0) { found = Array.from(caps); break; }
    }
    if (global) same(text, null, nativeGlobal.exec(text), len);
    else if (!everyStart) same(text, found, native.exec(text), 0);
    return count;
  };
  const same = (text: string, found: number[] | null, expected: RegExpExecArray | null, from: number): void => {
    const len = text.length;
    const agree = expected === null ? found === null
      : found !== null && Array.from({ length: groups + 1 }, (_, g) => g).every((g) => {
        const mine = found![2 * g]! < 0 || found![2 * g + 1]! < 0 ? undefined : text.slice(found![2 * g]!, found![2 * g + 1]!);
        return mine === expected[g] && (g > 0 || found![0] === expected.index);
      });
    if (!agree) {
      throw new UnsupportedPattern(`/${source}/${flags} on ${JSON.stringify(text.slice(0, 60))}... (${len} characters, from ${from}): the counter matched ${found === null ? "nothing" : JSON.stringify(text.slice(found[0], found[1]).slice(0, 60))} at ${found?.[0]}, V8 ${expected === null ? "nothing" : `${JSON.stringify(expected[0].slice(0, 60))} at ${expected.index}`}`);
    }
  };
  return { native, steps };
}
