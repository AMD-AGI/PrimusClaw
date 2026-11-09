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
 * `json.dumps(value, ensure_ascii=False)` for a value parsed from JSON: `", "` and `": "` separators, non-ASCII kept.
 * (A float that JSON wrote with a zero fraction, `1.0`, is the number 1 once parsed, so it comes out as `1`.)
 */
export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(pyJsonDumps).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonDumps(v)}`).join(", ")}}`;
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : pyNonFinite(value);
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  return "null";
}

function pyNonFinite(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  return value > 0 ? "Infinity" : "-Infinity";
}
