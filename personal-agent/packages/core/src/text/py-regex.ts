// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { InvariantError } from "../errors.js";
import { END, I_VARIANTS, START, literal, translateEscape, type EscapeContext } from "./py-regex-escapes.js";

export { PY_B_END, PY_B_START, PY_D, PY_W, PY_W_CHARS } from "./py-regex-escapes.js";

/**
 * Python `re` patterns (on a `str`) as JavaScript regular expressions, for the rules the worker matches text with.
 * Where the two engines read the same pattern differently, the translation makes JavaScript read it as Python does:
 *  - `\s` is Python's white space (`\x1c`-`\x1f` and `\x85` in, `\ufeff` out), `\S` the rest;
 *  - `\d` is a decimal digit of any script (`\p{Nd}`), `\D` the rest;
 *  - `\w` is a letter, a number or `_` of any script, `\W` the rest, and `\b`/`\B` are boundaries of that `\w`;
 *  - `^`, `$`, `\A`, `\Z` and `.` are Python's: `$` also matches before a final "\n" (with `m`, before any "\n" only, not
 *    "\r"), and `.` is anything but "\n" (with `s`, anything);
 *  - `(?P<name>...)` and `(?P=name)` are Python's named groups; a leading `(?ims)` is the flag; `(?#...)` is a comment;
 *  - `\-`, `\ `, `\#` (what `re.escape` writes) are the characters themselves, as are `\x..`, `\u....`, `\U........`,
 *    octal escapes and `\a`; a `{` or `}` that is no quantifier and a `]` outside a class are literal; `{,n}` is `{0,n}`;
 *  - with the `i` flag, `i`, `I`, `ı` and `İ` all match one another, as Python folds them (JavaScript does not).
 * The `u` flag is always on. What has no JavaScript form is refused when the pattern is built, with an InvariantError:
 * an escape Python refuses, `\N{...}`, a negated class escape inside a class (`[\S]`), inline flags anywhere but at the
 * start or scoped to a group (`(?s:...)`), a backreference under `i` (JavaScript folds it without `ı`/`İ`), and any
 * other syntax JavaScript cannot read.
 */

/** `ch.isalnum()` for one character: a letter or a number of any script. */
export function pyIsAlnum(ch: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(ch);
}

/** Letters A-Z and a-z only, at least one: what `re`'s `[A-Za-z]+` takes (`str.isalpha` would take any script). */
export function isAsciiAlpha(word: string): boolean {
  return /^[A-Za-z]+$/.test(word);
}

interface Flags {
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
  readonly dotAll: boolean;
}

interface State {
  out: string;
  inClass: boolean;
  classStart: number;
}

interface Step {
  readonly text: string;
  readonly length: number;
}

/**
 * With `i`: a class that takes any of `i`, `I`, `ı`, `İ` takes all four (a negated one then refuses them all). They go
 * first in the class, so a class ending in a literal `-` keeps it literal.
 */
function closeClass(state: State, ignoreCase: boolean): void {
  const body = state.out.slice(state.classStart);
  const negated = body.startsWith("[^");
  const positive = new RegExp(negated ? `[${body.slice(2)}]` : `${body}]`, "iu");
  if (ignoreCase && Array.from(I_VARIANTS).some((ch) => positive.test(ch))) {
    const at = state.classStart + (negated ? 2 : 1);
    state.out = state.out.slice(0, at) + I_VARIANTS + state.out.slice(at);
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

const NAME = String.raw`[\p{L}_][\p{L}\p{N}_]*`;

/**
 * A group opening or reference at `source[i]` (outside a class): Python's `(?P<name>` (JavaScript `(?<name>`) and
 * `(?P=name)` (`\k<name>`), JavaScript's own `(?<name>` and `\k<name>`, a comment `(?#...)` (dropped), and a flag group
 * anywhere but the start (refused). A lookbehind `(?<=`/`(?<!` is no name and is read as the pattern it is.
 */
function groupAt(source: string, i: number, flags: Flags): Step | undefined {
  const rest = source.slice(i);
  if (rest.startsWith("(?#")) {
    const close = rest.indexOf(")");
    return { text: "", length: close === -1 ? rest.length : close + 1 };
  }
  if (/^\(\?[aiLmsux-]+[:)]/.test(rest))
    throw new InvariantError("inline flags not at the start have no JavaScript form here");
  const python = new RegExp(`^\\(\\?P<(${NAME})>`, "u").exec(rest);
  if (python) return { text: `(?<${python[1] ?? ""}>`, length: python[0].length };
  const reference = new RegExp(`^(?:\\(\\?P=(${NAME})\\)|\\\\k<(${NAME})>)`, "u").exec(rest);
  if (reference) {
    if (flags.ignoreCase) throw new InvariantError("a backreference under IGNORECASE has no JavaScript form here");
    return { text: `\\k<${reference[1] ?? reference[2] ?? ""}>`, length: reference[0].length };
  }
  const own = new RegExp(`^\\(\\?<(?![=!])${NAME}>`, "u").exec(rest);
  return own ? { text: own[0], length: own[0].length } : undefined;
}

/** A `{` that begins a quantifier (`{,n}` written `{0,n}`), or the literal `{`. */
function braceAt(source: string, i: number): Step {
  const quantifier = /^\{(\d*)(,(\d*))?\}/.exec(source.slice(i));
  if (quantifier && (quantifier[1] || quantifier[3])) {
    const text = quantifier[2] === undefined ? quantifier[0] : `{${quantifier[1] || "0"},${quantifier[3] ?? ""}}`;
    return { text, length: quantifier[0].length };
  }
  return { text: "\\{", length: 1 };
}

function outsideClass(source: string, i: number, flags: Flags): Step {
  const ch = source.charAt(i);
  if (ch === "(") return groupAt(source, i, flags) ?? { text: ch, length: 1 };
  if (ch === "{") return braceAt(source, i);
  if (ch === "}" || ch === "]") return { text: `\\${ch}`, length: 1 };
  const special = anchorOrDot(ch, flags);
  if (special !== undefined) return { text: special, length: 1 };
  const point = String.fromCodePoint(source.codePointAt(i) ?? 0);
  if (flags.ignoreCase && I_VARIANTS.includes(point))
    return { text: literal(point, context(false, flags)), length: point.length };
  return { text: point, length: point.length };
}

function context(inClass: boolean, flags: Flags): EscapeContext {
  return { inClass, ignoreCase: flags.ignoreCase };
}

function translate(source: string, flags: Flags): string {
  const state: State = { out: "", inClass: false, classStart: 0 };
  for (let i = 0; i < source.length;) {
    const ch = source.charAt(i);
    let step: Step;
    if (ch === "\\") step = translateEscape(source, i, context(state.inClass, flags));
    else if (state.inClass && ch === "]") {
      const opened = state.out.slice(state.classStart);
      if (opened === "[" || opened === "[^")
        step = { text: "\\]", length: 1 }; // a "]" first in a class is itself
      else {
        closeClass(state, flags.ignoreCase);
        step = { text: "", length: 1 };
      }
    } else if (!state.inClass && ch === "[") {
      state.inClass = true;
      state.classStart = state.out.length;
      step = { text: "[", length: 1 };
    } else step = state.inClass ? { text: ch, length: 1 } : outsideClass(source, i, flags);
    state.out += step.text;
    i += step.length;
  }
  return state.out;
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

/** The JavaScript flags beside a translated pattern: `i` stays; `m` and `s` are in the pattern itself now. */
function jsFlags(flags: string, read: Flags): string {
  const kept = Array.from(new Set(Array.from(flags.replace(/[imsu]/g, "")))).join("");
  return `${kept}${read.ignoreCase ? "i" : ""}u`;
}

function compile(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new InvariantError(`a pattern JavaScript cannot read: ${error instanceof Error ? error.message : "?"}`);
  }
}

/** `re.compile(source, flags)` used with `search`: `regex.exec(text)` finds the first match anywhere. */
export function pyRegExp(source: string, flags = ""): RegExp {
  const read = leadingFlags(source, flags.replaceAll("u", ""));
  return compile(translate(read.source, read.flags), jsFlags(flags, read.flags));
}

/** `re.fullmatch(source, text, flags)` as a RegExp: `regex.test(text)` / `regex.exec(text)` match the whole text. */
export function pyFullmatch(source: string, flags = ""): RegExp {
  const read = leadingFlags(source, flags.replaceAll("u", ""));
  return compile(`${START}(?:${translate(read.source, read.flags)})${END}`, jsFlags(flags, read.flags));
}
