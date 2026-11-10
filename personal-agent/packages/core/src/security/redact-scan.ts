// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two credential rules of `redact.py` that backtrack polynomially as regular expressions (CodeQL
 * js/polynomial-redos; Python's `re` takes quadratic time on them as well), read in one linear pass each with exactly
 * the matches Python's `re.sub` makes:
 *
 *   JWT     \beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}
 *   secret  (?i)(?:token|secret|api[_-]?key|password|passwd|\bkey|JOINED(?=SEP))[\w-]*SEP\s*["']?
 *           (?=B64*\d)(?=B64*[A-Za-z])(B64{32,})          B64 = [A-Za-z0-9+/=_-]   SEP = ["']?\s*(?::|=|\bis\b)
 *           JOINED = (?-i:(?<=[a-z0-9])Key)|(?<=_)key|(?<![A-Za-z0-9])(?:account|storage(?:account)?|sharedaccess
 *                    |primary|secondary|master|private|subscription|sas|signing|encryption)key
 *
 * Texts are read by code point, as Python reads a str.
 */
import { pyRegExp } from "../text/py-regex.js";
import { isPySpace } from "../text/py-text.js";

/** What a masked value is replaced with. */
export const MASK = "[hidden]";

const WORD = /^[\p{L}\p{N}_]$/u;
const DECIMAL = /^\p{Nd}$/u;
const JWT_PART = /^[A-Za-z0-9_-]$/;
/** Under Python's `re.I` the ASCII letters also take İ ı ſ and the Kelvin sign. */
const FOLDED = new Set(["İ", "ı", "ſ", "K"]);
const LETTER_I = (ch: string): boolean => /^[A-Za-z]$/.test(ch) || FOLDED.has(ch);
const B64_I = (ch: string): boolean => /^[A-Za-z0-9+/=_-]$/.test(ch) || FOLDED.has(ch);
const isWord = (ch: string | undefined): boolean => ch !== undefined && WORD.test(ch);
const isWordOrDash = (ch: string | undefined): boolean => ch === "-" || isWord(ch);

/** The end of the run from `at` of characters `take` accepts. */
function runEnd(cps: readonly string[], at: number, take: (ch: string) => boolean): number {
  let i = at;
  while (i < cps.length && take(cps[i] ?? "")) i += 1;
  return i;
}

/** A text rebuilt with the given spans of it masked (`[from, to)` in code points, in order, not overlapping). */
function masked(cps: readonly string[], spans: ReadonlyArray<readonly [number, number]>): string {
  let out = "";
  let at = 0;
  for (const [from, to] of spans) {
    out += cps.slice(at, from).join("") + MASK;
    at = to;
  }
  return out + cps.slice(at).join("");
}

/** The end of a JWT starting at `s` ("eyJ" there, a boundary before it), or -1; and the end of its first part. */
function jwtAt(cps: readonly string[], s: number): { end: number; firstEnd: number } {
  const take = (ch: string): boolean => JWT_PART.test(ch);
  const first = runEnd(cps, s + 3, take);
  const result = { end: -1, firstEnd: first };
  if (first - (s + 3) < 5 || cps[first] !== ".") return result;
  const second = runEnd(cps, first + 1, take);
  if (second - (first + 1) < 5 || cps[second] !== ".") return result;
  const third = runEnd(cps, second + 1, take);
  return third - (second + 1) < 5 ? result : { end: third, firstEnd: first };
}

/**
 * The JWT rule. A start that fails fails for every later "eyJ" inside the same first part (they share its end, the
 * dot and the parts after it, and have fewer characters before the dot), so the scan goes on after that part.
 */
export function maskJwts(text: string): { text: string; masked: boolean } {
  const cps = Array.from(text);
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i + 3 <= cps.length) {
    const start = cps[i] === "e" && cps[i + 1] === "y" && cps[i + 2] === "J" && !isWord(cps[i - 1]);
    if (!start) {
      i += 1;
      continue;
    }
    const { end, firstEnd } = jwtAt(cps, i);
    if (end !== -1) {
      spans.push([i, end]);
      i = end;
    } else i = Math.max(i + 1, firstEnd);
  }
  return spans.length ? { text: masked(cps, spans), masked: true } : { text, masked: false };
}

/** Per position of a text, what the secret rule's value needs there, computed once from the end. */
interface ValueTable {
  /** Length of the run of B64 characters from here. */
  readonly run: Int32Array;
  /** A decimal digit in that run or right after it (`(?=B64*\d)`). */
  readonly digit: Uint8Array;
  /** A letter in that run (`(?=B64*[A-Za-z])`). */
  readonly letter: Uint8Array;
}

function valueTable(cps: readonly string[]): ValueTable {
  const n = cps.length;
  const run = new Int32Array(n + 1);
  const digit = new Uint8Array(n + 1);
  const letter = new Uint8Array(n + 1);
  for (let i = n - 1; i >= 0; i -= 1) {
    const ch = cps[i] ?? "";
    const here = DECIMAL.test(ch) ? 1 : 0;
    if (!B64_I(ch)) {
      digit[i] = here;
      continue;
    }
    run[i] = 1 + (run[i + 1] ?? 0);
    const next = cps[i + 1];
    const after = run[i + 1] ? (digit[i + 1] ?? 0) : next !== undefined && DECIMAL.test(next) ? 1 : 0;
    digit[i] = here || after;
    letter[i] = LETTER_I(ch) || (run[i + 1] ? (letter[i + 1] ?? 0) : 0) ? 1 : 0;
  }
  return { run, digit, letter };
}

/** The value's end when a value the rule takes starts at `v` (`["']?` already read), else -1. */
function valueEnd(table: ValueTable, v: number): number {
  const length = table.run[v] ?? 0;
  return length >= 32 && table.digit[v] && table.letter[v] ? v + length : -1;
}

/** `\s*["']?` then a value from `at`: the value's span, or null. The quote is taken when there is one (the regex tries it first). */
function valueAfter(cps: readonly string[], table: ValueTable, at: number): readonly [number, number] | null {
  const spaced = runEnd(cps, at, isPySpace);
  const quote = cps[spaced] === '"' || cps[spaced] === "'";
  const v = quote ? spaced + 1 : spaced;
  const end = valueEnd(table, v);
  return end === -1 ? null : [v, end];
}

/** "is" at `p` as `\bis\b` reads it under `re.I`. */
function isWordIs(cps: readonly string[], p: number): boolean {
  const i = cps[p] ?? "";
  const s = cps[p + 1] ?? "";
  return /^[iIıİ]$/u.test(i) && /^[sSſ]$/u.test(s) && !isWord(cps[p - 1]) && !isWord(cps[p + 2]);
}

/** The separator and the value after a name that ends at `p` (`["']?\s*(?::|=|\bis\b)` then the value), or null. */
function afterName(cps: readonly string[], table: ValueTable, p: number): readonly [number, number] | null {
  const quote = cps[p] === '"' || cps[p] === "'";
  const at = runEnd(cps, quote ? p + 1 : p, isPySpace);
  const sep = cps[at];
  if (sep === ":" || sep === "=") return valueAfter(cps, table, at + 1);
  return isWordIs(cps, at) ? valueAfter(cps, table, at + 2) : null;
}

/**
 * The secret rule's match from a name word ending at `e`: `[\w-]*` takes the most it can and gives back one character
 * at a time, so the first place from the right where a separator and a value follow is the one Python finds.
 */
function secretFrom(cps: readonly string[], table: ValueTable, e: number): readonly [number, number] | null {
  const end = runEnd(cps, e, isWordOrDash);
  for (let p = end; p >= e; p -= 1) {
    const found = afterName(cps, table, p);
    if (found) return found;
  }
  return null;
}

const SEP = String.raw`["']?\s*(?::|=|\b[iIıİ][sSſ]\b)`; // the separator after a name, its "is" as re.I reads it
const KEY_WORDS =
  "account|storage(?:account)?|sharedaccess|primary|secondary|master|private|subscription|sas|signing|encryption";
// A "key" joined to the word before it (AccountKey, SharedAccessKey, my_key, primaryKey) is a name only where the
// separator follows it, and only after an underscore or one of the key words, or as a camel-case "Key"; monkey, turkey
// and hotkeys are no names. Such a name ends its run of `[\w-]` characters, so the skip after a failed name below still
// holds. The camel-case branch is case-sensitive (Python's `(?-i:...)`), so it is a pattern of its own.
const NAMES = [
  pyRegExp(
    String.raw`(?i)(?:token|secret|api[_-]?key|password|passwd|\bkey|(?<=_)key(?=${SEP})|(?<![A-Za-z0-9])(?:${KEY_WORDS})key(?=${SEP}))`,
    "g",
  ),
  pyRegExp(String.raw`(?<=[a-z0-9])Key(?=${SEP})`, "g"),
];

/** The leftmost name at or after UTF-16 index `from`: its index and length, or null. */
function nameFrom(text: string, from: number): { index: number; length: number } | null {
  let first: { index: number; length: number } | null = null;
  for (const pattern of NAMES) {
    pattern.lastIndex = from;
    const found = pattern.exec(text);
    if (found && (first === null || found.index < first.index)) first = { index: found.index, length: found[0].length };
  }
  return first;
}

/**
 * The secret rule: only the value is masked (the name, the separator and a quote stay). A name that fails fails for
 * every later name in the same run of word characters (its `[\w-]*` reaches every place theirs can), so the scan goes
 * on after that run.
 */
export function maskSecretValues(text: string): { text: string; masked: boolean } {
  const cps = Array.from(text);
  const unitAt = new Int32Array(cps.length + 1);
  const cpOfUnit = new Int32Array(text.length + 1);
  let unit = 0;
  cps.forEach((cp, i) => {
    unitAt[i] = unit;
    cpOfUnit[unit] = i;
    unit += cp.length;
  });
  unitAt[cps.length] = text.length;
  cpOfUnit[text.length] = cps.length;
  const cpAt = (unit: number): number => cpOfUnit[unit] ?? cps.length;
  let table: ValueTable | null = null;
  const spans: Array<readonly [number, number]> = [];
  let from = 0;
  for (;;) {
    const name = nameFrom(text, unitAt[from] ?? text.length);
    if (name === null) break;
    const s = cpAt(name.index);
    const e = cpAt(name.index + name.length);
    table ??= valueTable(cps);
    const found = secretFrom(cps, table, e);
    if (found) {
      spans.push(found);
      from = found[1];
    } else from = Math.max(s + 1, runEnd(cps, s, isWordOrDash));
  }
  return spans.length ? { text: masked(cps, spans), masked: true } : { text, masked: false };
}
