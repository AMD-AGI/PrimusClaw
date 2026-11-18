// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * JSON text as Python's `json.dumps` writes it by default (`", "` and `": "` separators, non-ASCII as `\uXXXX`), so a
 * `*_json` column holds the same text whichever worker wrote it. Reading back is plain `JSON.parse`.
 */
import { isJsonObject, type JsonObject } from "@primusclaw/personal-agent";

function escapeString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function dumpNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  return JSON.stringify(value);
}

export function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return escapeString(value);
  if (typeof value === "number") return dumpNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((v: unknown) => pyJsonDumps(v)).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${escapeString(k)}: ${pyJsonDumps(v)}`).join(", ")}}`;
  }
  throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
}

/** The parsed value, or `undefined` when the text is not JSON (Python's `ValueError`). */
export function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A stored list; anything else reads as an empty one (Python's `_json_list`). */
export function jsonList(text: string | null): unknown[] {
  const value = parseJson(text);
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** A stored list of strings, other entries dropped. */
export function jsonStrings(text: string | null): string[] {
  return jsonList(text).filter((v): v is string => typeof v === "string");
}

/** The stored mode id -> flag map; anything that is not one reads as nothing said (Python's `_json_flags`). */
export function jsonFlags(text: string | null): Record<string, boolean> {
  const value = parseJson(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, boolean] => typeof e[1] === "boolean"));
}

/** A stored object, or null when the text is not one. */
export function storedObject(text: string | null): JsonObject | null {
  const value = parseJson(text);
  return isJsonObject(value) ? value : null;
}
