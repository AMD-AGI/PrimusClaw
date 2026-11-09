// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { InvariantError } from "../errors.js";
import { PY_SPACE } from "./py-text.js";

/**
 * Python `re` patterns (on a `str`) as JavaScript regular expressions, for the rules the worker matches text with.
 * Where the two engines read the same pattern differently, the translation makes JavaScript read it as Python does:
 *  - `\s` is Python's white space (`\x1c`-`\x1f` and `\x85` in, `\ufeff` out), `\S` the rest;
 *  - `\d` is a decimal digit of any script (`\p{Nd}`), `\D` the rest;
 *  - `\w` is a letter, a number or `_` of any script, `\W` the rest, and `\b`/`\B` are boundaries of that `\w`;
 *  - with the `i` flag, `i` and `I` also match `ı` and `İ` (Python folds them together, JavaScript does not).
 * The `u` flag is always on. A negated class escape inside a class (`[\S]`, `[\D]`, `[\W]`) has no JavaScript form
 * and is refused when the pattern is built.
 */

const WORD = String.raw`\p{L}\p{N}_`;
const DIGIT = String.raw`\p{Nd}`;
const DOTTED_I = "ıİ";

const OUTSIDE: Readonly<Record<string, string>> = {
  s: `[${PY_SPACE}]`,
  S: `[^${PY_SPACE}]`,
  d: `[${DIGIT}]`,
  D: `[^${DIGIT}]`,
  w: `[${WORD}]`,
  W: `[^${WORD}]`,
  b: `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`,
  B: `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`,
};

const INSIDE: Readonly<Record<string, string>> = { s: PY_SPACE, d: DIGIT, w: WORD };

/** The escape that starts at `source[i]` (a backslash): its whole text, `\p{..}` and `\u{..}` included. */
function escapeAt(source: string, i: number): string {
  const next = source.charAt(i + 1);
  if ((next === "p" || next === "P" || next === "u") && source.charAt(i + 2) === "{") {
    const close = source.indexOf("}", i + 3);
    if (close !== -1) return source.slice(i, close + 1);
  }
  if (next === "x") return source.slice(i, i + 4);
  if (next === "u") return source.slice(i, i + 6);
  return source.slice(i, i + 2);
}

interface State {
  out: string;
  inClass: boolean;
  classStart: number;
}

function translateEscape(escape: string, state: State): string {
  const letter = escape.length === 2 ? escape.charAt(1) : "";
  if (!state.inClass) return OUTSIDE[letter] ?? escape;
  const inner = INSIDE[letter];
  if (inner !== undefined) return inner;
  if (letter === "S" || letter === "D" || letter === "W") {
    throw new InvariantError(`a negated class escape \\${letter} inside a character class has no JavaScript form`);
  }
  return escape;
}

/**
 * With `i`: a class that takes `i` or `I` takes `ı` and `İ` as well (a negated one then refuses them too). They go
 * first in the class, so a class ending in a literal `-` keeps it literal.
 */
function closeClass(state: State, ignoreCase: boolean): void {
  const body = state.out.slice(state.classStart);
  const negated = body.startsWith("[^");
  if (ignoreCase && new RegExp(negated ? `[${body.slice(2)}]` : `${body}]`, "iu").test("i")) {
    const at = state.classStart + (negated ? 2 : 1);
    state.out = state.out.slice(0, at) + DOTTED_I + state.out.slice(at);
  }
  state.out += "]";
  state.inClass = false;
}

function translate(source: string, ignoreCase: boolean): string {
  const state: State = { out: "", inClass: false, classStart: 0 };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      const escape = escapeAt(source, i);
      state.out += translateEscape(escape, state);
      i += escape.length - 1;
    } else if (ch === "[" && !state.inClass) {
      state.inClass = true;
      state.classStart = state.out.length;
      state.out += ch;
    } else if (ch === "]" && state.inClass) {
      const opened = state.out.slice(state.classStart);
      if (opened === "[" || opened === "[^")
        state.out += "\\]"; // a "]" first in a class is the character itself
      else closeClass(state, ignoreCase);
    } else if (ignoreCase && !state.inClass && (ch === "i" || ch === "I") && !inGroupName(source, i)) {
      state.out += `[iI${DOTTED_I}]`;
    } else {
      state.out += ch;
    }
  }
  return state.out;
}

/** Whether `source[i]` is inside a group's name (`(?<name>` or `\k<name>`), which is not text to match. */
function inGroupName(source: string, i: number): boolean {
  const open = source.lastIndexOf("<", i);
  if (open < 2) return false;
  const lead = source.slice(open - 2, open);
  return (lead === "(?" || lead === "\\k") && !source.slice(open, i).includes(">");
}

/** `re.fullmatch(source, text, flags)` as a RegExp: `regex.test(text)` / `regex.exec(text)` match the whole text. */
export function pyFullmatch(source: string, flags = ""): RegExp {
  const ignoreCase = flags.includes("i");
  return new RegExp(`^(?:${translate(source, ignoreCase)})$`, `${flags.replaceAll("u", "")}u`);
}
