// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * String operations with the Python worker's semantics, for texts that must come out byte-for-byte the same as it
 * wrote them (issue titles, card lines, stored values). JavaScript differs in three places that matter here:
 *  - a length or a cut counts UTF-16 code units, Python counts code points (an emoji is 2 here, 1 there);
 *  - `\s` and `trim()` know another set of white space than Python's `str.isspace` (`\x1c`-`\x1f`, `\x85`; `\ufeff`);
 *  - there is no `str.isprintable`.
 */

/** The characters Python's `str.isspace()` is true for. */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
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

/** `text.strip()`. */
export function pyStrip(text: string): string {
  return text.replace(LEADING, "").replace(TRAILING, "");
}

/** `text.lstrip()`. */
export function pyLstrip(text: string): string {
  return text.replace(LEADING, "");
}

/** `text.rstrip()`. */
export function pyRstrip(text: string): string {
  return text.replace(TRAILING, "");
}

/** `len(text)`: code points. */
export function cpLength(text: string): number {
  return Array.from(text).length;
}

/** `text[start:end]` for non-negative bounds, counted in code points. */
export function cpSlice(text: string, start: number, end?: number): string {
  return Array.from(text).slice(start, end).join("");
}

/** `text[:limit]`, without splitting a string that is short enough. */
export function cpHead(text: string, limit: number): string {
  return text.length <= limit ? text : cpSlice(text, 0, limit);
}

/** `f"{value:.1f}"`: one decimal, a tie on the exact binary value rounded to even as Python does. */
export function fixed1(value: number): string {
  const scaled = value * 10;
  const floor = Math.floor(scaled);
  if (scaled - floor === 0.5 && Number.isFinite(scaled)) {
    const even = floor % 2 === 0 ? floor : floor + 1;
    return (even / 10).toFixed(1);
  }
  return value.toFixed(1);
}

/**
 * `str(value or "")` for a value read from JSON: a missing or false value is "", a string is itself, a number is its
 * digits, `true` is "True". An object or a list is "" (the Python worker never shows one this way).
 */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === true) return "True";
  if (typeof value === "number") return value === 0 || Number.isNaN(value) ? "" : String(value);
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
