// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * String operations with the Python worker's semantics, for texts that must come out byte-for-byte the same as it
 * wrote them (issue titles, card lines, stored values). JavaScript differs in three places that matter here:
 *  - a length or a cut counts UTF-16 code units, Python counts code points (an emoji is 2 here, 1 there);
 *  - `\s` and `trim()` know another set of white space than Python's `str.isspace` (`\x1c`-`\x1f`, `\x85`; `\ufeff`);
 *  - there is no `str.isprintable`.
 */

/**
 * The characters Python's `str.isspace()` is true for, which is also what `\s` matches in a Python `str` pattern
 * (JavaScript's `\s` lacks `\x1c`-`\x1f` and `\x85`, and has `\ufeff`). For a pattern: `new RegExp(`[${PY_SPACE}]`, "u")`.
 */
export const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, "u");
const SPACE_ONE = new RegExp(`^[${PY_SPACE}]$`, "u");
const LEADING = new RegExp(`^[${PY_SPACE}]+`, "u");
const TRAILING = new RegExp(`[${PY_SPACE}]+$`, "u");
/** What `str.isprintable()` is false for: other (Cc, Cf, Cs, Co, Cn) and separators (Zl, Zp, Zs), except the space. */
const UNPRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/** `ch.isspace()` for one code point. */
export function isPySpace(ch: string): boolean {
  return SPACE_ONE.test(ch);
}

/** `ch.isprintable()` for one code point. */
export function isPyPrintable(ch: string): boolean {
  return ch === " " || !UNPRINTABLE.test(ch);
}

/** `text.split()`: the words between runs of white space, none empty. */
export function pySplit(text: string): string[] {
  return text.split(SPACE_RUN).filter((word) => word !== "");
}

/** `" ".join(text.split())`: one line, single spaces. */
export function squashSpaces(text: string): string {
  return pySplit(text).join(" ");
}

function charSet(chars: string): ReadonlySet<string> {
  return new Set(Array.from(chars));
}

function stripEnds(text: string, chars: string, left: boolean, right: boolean): string {
  const set = charSet(chars);
  const points = Array.from(text);
  let start = 0;
  let end = points.length;
  while (left && start < end && set.has(points[start] ?? "")) start += 1;
  while (right && end > start && set.has(points[end - 1] ?? "")) end -= 1;
  return points.slice(start, end).join("");
}

/** `text.strip()`, or `text.strip(chars)`. */
export function pyStrip(text: string, chars?: string): string {
  if (chars !== undefined) return stripEnds(text, chars, true, true);
  return text.replace(LEADING, "").replace(TRAILING, "");
}

/** `text.lstrip()`, or `text.lstrip(chars)`. */
export function pyLstrip(text: string, chars?: string): string {
  return chars === undefined ? text.replace(LEADING, "") : stripEnds(text, chars, true, false);
}

/** `text.rstrip()`, or `text.rstrip(chars)`. */
export function pyRstrip(text: string, chars?: string): string {
  return chars === undefined ? text.replace(TRAILING, "") : stripEnds(text, chars, false, true);
}

/**
 * `text.lower()`. JavaScript's `toLowerCase()` is the same full, context-sensitive mapping (final sigma, `İ` to `i̇`),
 * locale-independent as Python's; checked over every code point (they differ only where Node's Unicode is newer).
 */
export function pyLower(text: string): string {
  return text.toLowerCase();
}

const CHEROKEE_CAPITALS: readonly [number, number] = [0x13a0, 0x13f5];

/** One code point's `casefold()`: Python's full case folding, which differs from upper-then-lower in four places. */
function foldPoint(ch: string): string {
  const c = ch.codePointAt(0) ?? 0;
  if (c === 0x131) return ch; // dotless i folds to itself, not to "i"
  if (c === 0x1e9e) return "ss"; // capital sharp s folds like "ß"
  if (c >= CHEROKEE_CAPITALS[0] && c <= CHEROKEE_CAPITALS[1]) return ch; // Cherokee folds to its capitals
  if (c >= 0xab70 && c <= 0xabbf) return String.fromCodePoint(0x13a0 + (c - 0xab70));
  if (c >= 0x13f8 && c <= 0x13fd) return String.fromCodePoint(c - 8);
  return ch.toUpperCase().toLowerCase();
}

/**
 * `text.casefold()`: for comparing without case (`ß` and `ss`, `ſ` and `s` fold together; `ı` stays apart from `i`;
 * no final-sigma context, every `σ`/`ς`/`Σ` folds to `σ`). Per code point, as Python folds.
 */
export function pyCasefold(text: string): string {
  return Array.from(text, foldPoint).join("");
}

/** `text.split(None, 1)`: the first word and the rest (its leading white space removed); at most two parts. */
export function splitOnce(text: string): string[] {
  const rest = pyLstrip(text);
  if (rest === "") return [];
  const match = new RegExp(`^([^${PY_SPACE}]+)[${PY_SPACE}]*`, "u").exec(rest);
  const head = match?.[1] ?? rest;
  const tail = rest.slice(match?.[0].length ?? rest.length);
  return tail === "" ? [head] : [head, tail];
}

const DECIMAL_DIGIT = /^\p{Nd}$/u;

/** The value of one decimal digit of any script: Unicode keeps every script's 0-9 in a run of ten. */
function digitValue(ch: string): number {
  let start = ch.codePointAt(0) ?? 0;
  const at = start;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return (at - start) % 10;
}

/**
 * At least one character, each a decimal digit of any script (`\p{Nd}`: what `\d` matches in Python's `re`, and what
 * `int()` reads). NOT Python's `str.isdigit()`, which also takes superscripts and circled digits (`pyIsdigit`).
 */
export function isDigits(text: string): boolean {
  return /^\p{Nd}+$/u.test(text);
}

/** Numeric_Type=Digit (superscripts, circled and parenthesized digits, ...): the Unicode 16 table of the worker's Python. */
const DIGIT_NOT_DECIMAL =
  "\\u{b2}-\\u{b3}\\u{b9}\\u{1369}-\\u{1371}\\u{19da}\\u{2070}\\u{2074}-\\u{2079}\\u{2080}-\\u{2089}\\u{2460}-\\u{2468}" +
  "\\u{2474}-\\u{247c}\\u{2488}-\\u{2490}\\u{24ea}\\u{24f5}-\\u{24fd}\\u{24ff}\\u{2776}-\\u{277e}\\u{2780}-\\u{2788}" +
  "\\u{278a}-\\u{2792}\\u{10a40}-\\u{10a43}\\u{10e60}-\\u{10e68}\\u{11052}-\\u{1105a}\\u{1f100}-\\u{1f10a}";
const PY_DIGITS = new RegExp(`^[\\p{Nd}${DIGIT_NOT_DECIMAL}]+$`, "u");

/** `text.isdigit()`: at least one character, each of Numeric_Type Decimal or Digit (`²` and `①` are digits). */
export function pyIsdigit(text: string): boolean {
  return PY_DIGITS.test(text);
}

/** `int(text)` for a run of decimal digits of any script (`１２` is 12, `٣` is 3); NaN for anything else. */
export function decimalInt(text: string): number {
  if (!isDigits(text)) return Number.NaN;
  let value = 0;
  for (const ch of text) value = value * 10 + digitValue(ch);
  return value;
}

/** `text.isupper()`: at least one cased character, and none in lower case. */
export function isUpper(text: string): boolean {
  return text !== text.toLowerCase() && text === text.toUpperCase();
}

/** `len(text)`: code points. */
export function cpLength(text: string): number {
  return Array.from(text).length;
}

function sliceIndex(index: number, length: number): number {
  return index < 0 ? Math.max(0, length + index) : Math.min(index, length);
}

/** `text[start:end]`, counted in code points; a negative bound counts from the end, as in Python. */
export function cpSlice(text: string, start: number, end?: number): string {
  const points = Array.from(text);
  const from = sliceIndex(start, points.length);
  const to = end === undefined ? points.length : sliceIndex(end, points.length);
  return from < to ? points.slice(from, to).join("") : "";
}

/** `text.rfind(sub)`: the code-point index of the last occurrence, -1 when there is none. */
export function cpRfind(text: string, sub: string): number {
  const at = text.lastIndexOf(sub);
  return at === -1 ? -1 : cpLength(text.slice(0, at));
}

/** `text if len(text) <= limit else text[: limit - 1].rstrip() + "…"`. */
export function clipLine(text: string, limit: number): string {
  return cpLength(text) <= limit ? text : `${pyRstrip(cpSlice(text, 0, Math.max(0, limit - 1)))}\u2026`;
}

/** `text[:limit]`, without splitting a string that is short enough. */
export function cpHead(text: string, limit: number): string {
  return text.length <= limit ? text : cpSlice(text, 0, limit);
}

/**
 * `f"{value:.{digits}f}"`. `toFixed` rounds an exact tie (on the binary value) up, Python to even; the two agree on
 * everything else. A tie is told by the exact decimal expansion, which `toFixed` gives to 40 digits past the cut
 * (more than any double below 1e21 needs to show a non-tie's difference at these magnitudes).
 */
export function fixedN(value: number, digits: number): string {
  if (!Number.isFinite(value)) return pyNonFiniteFormat(value);
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  const magnitude = Math.abs(value);
  const exact = magnitude.toFixed(Math.min(100, digits + 40));
  const point = exact.indexOf(".");
  const cut = point + 1 + digits;
  const rest = exact.slice(cut);
  const tie = rest.startsWith("5") && /^50*$/.test(rest);
  const truncated = digits === 0 ? exact.slice(0, point) : exact.slice(0, cut);
  const lastDigit = Number(truncated.at(-1));
  const shown = tie && lastDigit % 2 === 0 ? truncated : magnitude.toFixed(digits);
  return sign + shown;
}

/** `f"{value:.1f}"`. */
export function fixed1(value: number): string {
  return fixedN(value, 1);
}

function pyNonFiniteFormat(value: number): string {
  if (Number.isNaN(value)) return "nan";
  return value > 0 ? "inf" : "-inf";
}

/**
 * `str(value or "")` for a value read from JSON: a missing or false value is "", a string is itself, a number is its
 * digits, `true` is "True". An object or a list is "" (the Python worker never shows one this way).
 */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === true) return "True";
  if (typeof value === "number") return value === 0 || Number.isNaN(value) ? "" : String(value);
  if (typeof value === "bigint") return value === 0n ? "" : value.toString();
  return "";
}

export interface JsonDumpsOptions {
  /** `indent=`: each nesting level on its own lines, this many spaces deeper (items then end in "," alone). */
  readonly indent?: number;
  /** `sort_keys=True`: keys in code-point order, as Python sorts `str`. */
  readonly sortKeys?: boolean;
}

/**
 * `json.dumps(value, ensure_ascii=False, ...)` for a value parsed from JSON: non-ASCII kept; `", "` and `": "` separators,
 * or `","` and newlines with `indent`. A key whose value is undefined is left out. (A float that JSON wrote with a zero
 * fraction, `1.0`, is the number 1 once parsed, so it comes out as `1`.)
 */
export function pyJsonDumps(value: unknown, options: JsonDumpsOptions = {}): string {
  return encode(value, options, 0);
}

function encode(value: unknown, options: JsonDumpsOptions, depth: number): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value))
    return container(
      "[",
      "]",
      value.map((v) => encode(v, options, depth + 1)),
      options,
      depth,
    );
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((k) => record[k] !== undefined);
    if (options.sortKeys) keys.sort(byCodePoint);
    const items = keys.map((k) => `${JSON.stringify(k)}: ${encode(record[k], options, depth + 1)}`);
    return container("{", "}", items, options, depth);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : pyNonFinite(value);
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  return "null";
}

function container(open: string, close: string, items: string[], options: JsonDumpsOptions, depth: number): string {
  if (items.length === 0) return open + close;
  if (options.indent === undefined) return `${open}${items.join(", ")}${close}`;
  const inner = `\n${" ".repeat(options.indent * (depth + 1))}`;
  return `${open}${inner}${items.join(`,${inner}`)}\n${" ".repeat(options.indent * depth)}${close}`;
}

/** Python orders `str` by code point; JavaScript's default sort compares UTF-16 units (they differ past U+FFFF). */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function pyNonFinite(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  return value > 0 ? "Infinity" : "-Infinity";
}
