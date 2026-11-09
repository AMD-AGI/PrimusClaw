// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Text helpers that keep the Python worker's semantics where they differ from JavaScript's defaults: lengths and cuts count code
 * points (Python's `len`, slicing), not UTF-16 units, and JSON is written as Python's `json.dumps` writes it.
 */

/** Length in code points. */
export function cpLen(text: string): number {
  return Array.from(text).length;
}

/** The first `n` code points (Python's `text[:n]`; a negative `n` counts from the end, as Python's does). */
export function cpHead(text: string, n: number): string {
  const points = Array.from(text);
  return points.slice(0, n < 0 ? Math.max(0, points.length + n) : n).join("");
}

/** The last `n` code points (Python's `text[-n:]`). */
export function cpTail(text: string, n: number): string {
  if (n <= 0) return "";
  const points = Array.from(text);
  return points.slice(Math.max(0, points.length - n)).join("");
}

/** Every run of whitespace as one space, and none at the ends (Python's `" ".join(text.split())`). */
export function flat(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(" ");
}

/** `text` made one line and cut to `limit` code points, a cut one ending in "…". */
export function clip(text: string, limit: number): string {
  const line = flat(text);
  return cpLen(line) <= limit ? line : `${cpHead(line, limit - 1).trimEnd()}…`;
}

export interface DumpOptions {
  /** `separators=(",", ":")` as against Python's default `(", ", ": ")`. */
  readonly compact?: boolean;
}

/** `json.dumps(value, ensure_ascii=False, default=str)` as Python writes it. */
export function pyJson(value: unknown, options: DumpOptions = {}): string {
  const [item, key] = options.compact ? [",", ":"] : [", ", ": "];
  return dump(value, item, key);
}

function dump(value: unknown, item: string, key: string): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return pyNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => dump(v, item, key)).join(item)}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}${key}${dump(v, item, key)}`).join(item)}}`;
  }
  return JSON.stringify(typeof value === "bigint" || typeof value === "symbol" ? value.toString() : "");
}

function pyNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  return String(value);
}
