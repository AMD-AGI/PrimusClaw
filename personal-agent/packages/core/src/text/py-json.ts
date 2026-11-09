// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { isPyPrintable, pointAt } from "./py-chars.js";
import { pyNumber } from "./py-number.js";

/** Values parsed from JSON as Python writes them: `str(value or "")`, `repr(value)`, `json.dumps(value, ...)`. */

function isEmpty(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
}

/**
 * `str(value or "")` for a value read from JSON: a falsy value (none, false, 0, "", an empty list or object) is "", a
 * string is itself, `true` is "True", a number is its digits (or float repr), a list or object is Python's `repr`.
 */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined || value === false || value === 0 || value === 0n || isEmpty(value))
    return "";
  if (typeof value === "bigint") return value.toString();
  return pyRepr(value);
}

/** Python's `repr` of a string: single quotes unless it holds one and no double quote; unprintables escaped. */
function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  const body = Array.from(text, (ch) => {
    if (ch === "\\" || ch === quote) return `\\${ch}`;
    if (ch === "\t") return "\\t";
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (isPyPrintable(ch)) return ch;
    const code = pointAt(ch);
    if (code < 0x100) return `\\x${code.toString(16).padStart(2, "0")}`;
    return code < 0x10000 ? `\\u${code.toString(16).padStart(4, "0")}` : `\\U${code.toString(16).padStart(8, "0")}`;
  });
  return `${quote}${body.join("")}${quote}`;
}

/**
 * `repr(value)` for a value parsed from JSON (`None`, `True`, `'text'`, `[1, 2]`, `{'a': 1}`). An object's keys are in
 * its order, which JavaScript keeps for every key but integer-like ones ("2", "10"): those come first, ascending.
 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return pyNumber(value, "str");
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return reprString(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${reprString(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  return "None";
}

export interface JsonDumpsOptions {
  /** `indent=`: each nesting level on its own lines, this many spaces deeper (items then end in "," alone). */
  readonly indent?: number;
  /** `sort_keys=True`: keys in code-point order, as Python sorts `str`. */
  readonly sortKeys?: boolean;
}

/**
 * `json.dumps(value, ensure_ascii=False, ...)` for a value parsed from JSON: non-ASCII kept (a lone surrogate too);
 * `", "` and `": "` separators, or `","` and newlines with `indent`. A key whose value is undefined is left out.
 * Without `sortKeys`, keys are in the object's order, which JavaScript keeps for every key except integer-like ones
 * ("2", "10"): those come first, ascending (Python would keep them where JSON had them).
 */
export function pyJsonDumps(value: unknown, options: JsonDumpsOptions = {}): string {
  return encode(value, options, 0);
}

function isLoneSurrogate(ch: string): boolean {
  return ch.length === 1 && /[\ud800-\udfff]/.test(ch);
}

/** A JSON string as Python writes it with `ensure_ascii=False`: as JavaScript does, but a lone surrogate raw. */
function jsonString(text: string): string {
  return `"${Array.from(text, (ch) => (isLoneSurrogate(ch) ? ch : JSON.stringify(ch).slice(1, -1))).join("")}"`;
}

function encode(value: unknown, options: JsonDumpsOptions, depth: number): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return container(
      "[",
      "]",
      value.map((v) => encode(v, options, depth + 1)),
      options,
      depth,
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (options.sortKeys) entries.sort(([a], [b]) => byCodePoint(a, b));
    const items = entries.map(([k, v]) => `${jsonString(k)}: ${encode(v, options, depth + 1)}`);
    return container("{", "}", items, options, depth);
  }
  if (typeof value === "number") return pyNumber(value, "json");
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return jsonString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
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
  const x = Array.from(a, (ch) => pointAt(ch));
  const y = Array.from(b, (ch) => pointAt(ch));
  for (let i = 0; ; i += 1) {
    const p = x[i];
    const q = y[i];
    if (p === undefined || q === undefined) return x.length - y.length;
    if (p !== q) return p - q;
  }
}
