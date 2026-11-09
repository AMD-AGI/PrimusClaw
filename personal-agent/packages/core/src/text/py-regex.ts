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
 *  - `^`, `$`, `\A`, `\Z` and `.` are Python's: `$` also matches before a final "\n" (with `m`, before any "\n" only, not
 *    "\r"), and `.` is anything but "\n" (with `s`, anything);
 *  - `(?P<name>...)` and `(?P=name)` are Python's named groups; a leading `(?i)`, `(?m)` or `(?s)` is the flag;
 *  - with the `i` flag, `i` and `I` also match `ı` and `İ` (Python folds them together, JavaScript does not).
 * The `u` flag is always on. A negated class escape inside a class (`[\S]`, `[\D]`, `[\W]`) and inline flags other than
 * a leading `i`, `m`, `s` have no JavaScript form and are refused when the pattern is built.
 */

/** Python's `\w` (letters, numbers and `_` of any script) as a character class. */
export const PY_W = String.raw`[\p{L}\p{N}_]`;
/** The inside of `PY_W`, to put in a class of one's own (`[${PY_W_CHARS}.-]`). */
export const PY_W_CHARS = String.raw`\p{L}\p{N}_`;
/** Python's `\d` (a decimal digit of any script), to put in a class. */
export const PY_D = String.raw`\p{Nd}`;
/** Python's `\b` before a word: not preceded by a word character. */
export const PY_B_START = `(?<!${PY_W})`;
/** Python's `\b` after a word: not followed by a word character. */
export const PY_B_END = `(?!${PY_W})`;

/** `ch.isalnum()` for one character: a letter or a number of any script. */
export function pyIsAlnum(ch: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(ch);
}

/** Letters A-Z and a-z only, at least one: what `re`'s `[A-Za-z]+` takes (`str.isalpha` would take any script). */
export function isAsciiAlpha(word: string): boolean {
  return /^[A-Za-z]+$/.test(word);
}

const DOTTED_I = "ıİ";
const START = String.raw`(?<![\s\S])`;
const END = String.raw`(?![\s\S])`;

const OUTSIDE: Readonly<Record<string, string>> = {
  s: `[${PY_SPACE}]`,
  S: `[^${PY_SPACE}]`,
  d: `[${PY_D}]`,
  D: `[^${PY_D}]`,
  w: PY_W,
  W: `[^${PY_W_CHARS}]`,
  b: `(?:(?<=${PY_W})${PY_B_END}|${PY_B_START}(?=${PY_W}))`,
  B: `(?:(?<=${PY_W})(?=${PY_W})|${PY_B_START}${PY_B_END})`,
  A: START,
  Z: END,
};

const INSIDE: Readonly<Record<string, string>> = { s: PY_SPACE, d: PY_D, w: PY_W_CHARS };

interface Flags {
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
  readonly dotAll: boolean;
}

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

/** `^`, `$` and `.` outside a class, as Python reads them under `flags`. */
function anchorOrDot(ch: string, flags: Flags): string | undefined {
  if (ch === "^") return flags.multiline ? String.raw`(?:(?<![\s\S])|(?<=\n))` : START;
  if (ch === "$") return flags.multiline ? String.raw`(?=\n|(?![\s\S]))` : String.raw`(?=\n?(?![\s\S]))`;
  if (ch === ".") return flags.dotAll ? String.raw`[\s\S]` : String.raw`[^\n]`;
  return undefined;
}

/** A Python group spelling at `source[i]`: `(?P<name>` (JavaScript `(?<name>`) or `(?P=name)` (`\k<name>`). */
function groupAt(source: string, i: number): { text: string; length: number } | undefined {
  if (!source.startsWith("(?P", i)) return undefined;
  if (source.charAt(i + 3) === "<") return { text: "(?<", length: 4 };
  const named = /^\(\?P=(\w+)\)/.exec(source.slice(i));
  return named ? { text: `\\k<${named[1] ?? ""}>`, length: named[0].length } : undefined;
}

function plainChar(source: string, i: number, state: State, flags: Flags): string {
  const ch = source.charAt(i);
  if (state.inClass) return ch;
  const special = anchorOrDot(ch, flags);
  if (special !== undefined) return special;
  if (flags.ignoreCase && (ch === "i" || ch === "I") && !inGroupName(state.out)) return `[iI${DOTTED_I}]`;
  return ch;
}

function translate(source: string, flags: Flags): string {
  const state: State = { out: "", inClass: false, classStart: 0 };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charAt(i);
    const group = state.inClass ? undefined : groupAt(source, i);
    if (group !== undefined) {
      state.out += group.text;
      i += group.length - 1;
    } else if (ch === "\\") {
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
      else closeClass(state, flags.ignoreCase);
    } else {
      state.out += plainChar(source, i, state, flags);
    }
  }
  return state.out;
}

/** Whether what was written so far ends inside a group's name (`(?<name` or `\k<name`), which is not text to match. */
function inGroupName(out: string): boolean {
  const open = out.lastIndexOf("<");
  if (open < 2) return false;
  const lead = out.slice(open - 2, open);
  return (lead === "(?" || lead === "\\k") && !out.slice(open).includes(">");
}

/** A leading `(?ims)` of the source as flags; the rest of the source. */
function leadingFlags(source: string, flags: string): { source: string; flags: Flags } {
  const inline = /^\(\?([a-zA-Z]+)\)/.exec(source);
  const letters = flags + (inline?.[1] ?? "");
  const unknown = Array.from(letters).filter((f) => !"imsgy".includes(f));
  if (unknown.length) throw new InvariantError(`the flags ${unknown.join("")} have no JavaScript form here`);
  return {
    source: inline ? source.slice(inline[0].length) : source,
    flags: { ignoreCase: letters.includes("i"), multiline: letters.includes("m"), dotAll: letters.includes("s") },
  };
}

/** The JavaScript flags beside a translated pattern: `m` and `s` are in the pattern itself now. */
function jsFlags(flags: string, read: Flags): string {
  const kept = Array.from(new Set(Array.from(flags.replace(/[ims]/g, "")))).join("");
  return `${kept}${read.ignoreCase ? "i" : ""}u`;
}

/** `re.compile(source, flags)` used with `search`: `regex.exec(text)` finds the first match anywhere. */
export function pyRegExp(source: string, flags = ""): RegExp {
  const read = leadingFlags(source, flags.replaceAll("u", ""));
  return new RegExp(translate(read.source, read.flags), jsFlags(flags.replaceAll("u", ""), read.flags));
}

/** `re.fullmatch(source, text, flags)` as a RegExp: `regex.test(text)` / `regex.exec(text)` match the whole text. */
export function pyFullmatch(source: string, flags = ""): RegExp {
  const read = leadingFlags(source, flags.replaceAll("u", ""));
  const pattern = `${START}(?:${translate(read.source, read.flags)})${END}`;
  return new RegExp(pattern, jsFlags(flags.replaceAll("u", ""), read.flags));
}
