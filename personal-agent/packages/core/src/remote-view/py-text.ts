// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * String operations with Python's semantics, for text that must come out exactly as the Python worker wrote it: lengths and
 * cuts count code points (not UTF-16 units), and "whitespace" is Python's `str.isspace` set.
 */

const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${WS}]+`, "gu");
const LEADING = new RegExp(`^[${WS}]+`, "u");
const TRAILING = new RegExp(`[${WS}]+$`, "u");
const ASTRAL = /[\uD800-\uDFFF]/;
const LINE_BREAKS = new Set(["\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"]);

/** Python `str.strip()`. */
export function strip(text: string): string {
  return text.replace(LEADING, "").replace(TRAILING, "");
}

export function lstrip(text: string): string {
  return text.replace(LEADING, "");
}

export function rstrip(text: string): string {
  return text.replace(TRAILING, "");
}

/** Python `" ".join(text.split())`: one line, single spaces. */
export function squash(text: string): string {
  return strip(text).replace(WS_RUN, " ");
}

/** Python `str.splitlines()`. */
export function splitlines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (!LINE_BREAKS.has(ch)) continue;
    lines.push(text.slice(start, i));
    if (ch === "\r" && text.charAt(i + 1) === "\n") i += 1;
    start = i + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function isControl(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

/** Whether `text` has a control character (U+0000-U+001F or U+007F). */
export function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) if (isControl(text.charCodeAt(i))) return true;
  return false;
}

/** Python `len(text)`. */
export function length(text: string): number {
  return ASTRAL.test(text) ? Array.from(text).length : text.length;
}

/** Python `text[start:end]` for non-negative or negative bounds. */
export function slice(text: string, start: number, end?: number): string {
  if (!ASTRAL.test(text)) return text.slice(start, end);
  return Array.from(text).slice(start, end).join("");
}

/** Python `str(value)` for the JSON-ish values a connector reports (None is "None", a bool "True"/"False"). */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") return pyNumber(value);
  return JSON.stringify(value);
}

/** Python `str(text or "")`: a falsy value (None, "", 0, False, an empty list or dict) is "". */
export function orEmpty(value: unknown): string {
  return truthy(value) ? pyStr(value) : "";
}

function pyNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return String(value);
  return String(value);
}

/** Python `text.lstrip(chars)`. */
export function lstripChars(text: string, chars: string): string {
  let i = 0;
  while (i < text.length && chars.includes(text.charAt(i))) i += 1;
  return text.slice(i);
}

/** Python truthiness of a JSON value. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}
