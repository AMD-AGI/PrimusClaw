// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Python built-ins the Bot Connector client relied on, with their semantics: `urllib.parse.quote`, `float(text)`,
 * `int(value)`, truthiness, and `str.rstrip("/")`.
 */
import { pyRstrip, pyStrip } from "@primusclaw/personal-agent";

const ALWAYS_SAFE = /[A-Za-z0-9_.\-~]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** `quote(text, safe=safe)`: UTF-8, `%XX` upper case; letters, digits, `_.-~` and the `safe` characters stay. */
export function pyQuote(text: string, safe = "/"): string {
  if (LONE_SURROGATE.test(text)) throw new RangeError("the text is not valid Unicode");
  let out = "";
  for (const ch of text) {
    if (ch.length === 1 && (ALWAYS_SAFE.test(ch) || safe.includes(ch))) {
      out += ch;
      continue;
    }
    for (const byte of Buffer.from(ch, "utf8")) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const DIGITS = String.raw`\d(?:_?\d)*`;
const FLOAT = new RegExp(
  String.raw`^[+-]?(?:(?:${DIGITS}(?:\.(?:${DIGITS})?)?|\.${DIGITS})(?:[eE][+-]?${DIGITS})?|inf|infinity|nan)$`,
  "i",
);
const INT = new RegExp(String.raw`^[+-]?${DIGITS}$`);

/** `float(text)`, or undefined where Python raises ValueError. */
export function pyFloat(text: string): number | undefined {
  const stripped = pyStrip(text);
  if (!FLOAT.test(stripped)) return undefined;
  const lower = stripped.toLowerCase().replace(/^\+/, "");
  if (lower === "nan" || lower === "-nan") return Number.NaN;
  if (/^-?inf(inity)?$/.test(lower)) return lower.startsWith("-") ? -Infinity : Infinity;
  return Number(stripped.replaceAll("_", ""));
}

/** `int(value)` for a JSON value, or undefined where Python raises (ValueError, TypeError, OverflowError). */
export function pyInt(value: unknown): number | undefined {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : undefined;
  if (typeof value !== "string") return undefined;
  const stripped = pyStrip(value);
  return INT.test(stripped) ? Number(stripped.replaceAll("_", "")) : undefined;
}

/** Python's truthiness of a JSON value. */
export function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** `text.rstrip("/")`. */
export function rstripSlash(text: string): string {
  return pyRstrip(text, "/");
}
