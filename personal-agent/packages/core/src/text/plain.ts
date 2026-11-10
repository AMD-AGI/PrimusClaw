// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two text operations W5's features need on top of `py-text.ts` that it does not have: the one-line clip (white space
 * squashed, then `clipLine`), and JSON as `json.dumps(..., separators=(",", ":"))` writes it.
 */
import { clipLine, pyJsonDumps, squashSpaces } from "./py-text.js";

/** `" ".join(text.split())` cut to `limit` code points, a cut one ending in "…" (render._clip, approval_view._clip). */
export function clip(text: string, limit: number): string {
  return clipLine(squashSpaces(text), limit);
}

/** `json.dumps(value, ensure_ascii=False)`, with `separators=(",", ":")` when `compact`. */
export function pyJson(value: unknown, options: { readonly compact?: boolean } = {}): string {
  return options.compact ? compact(value) : pyJsonDumps(value);
}

function compact(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(compact).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${pyJsonDumps(k)}:${compact(v)}`).join(",")}}`;
  }
  return pyJsonDumps(value);
}
