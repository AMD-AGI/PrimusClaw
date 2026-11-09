// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The few text operations W5's features need on top of `py-text.ts` (which holds the Python semantics of lengths, cuts and white
 * space): the one-line clip with an ellipsis, a tail cut, and compact JSON as `json.dumps(..., separators=(",", ":"))` writes it.
 */
import { cpLength, cpSlice, pyJsonDumps, pyRstrip, squashSpaces } from "./py-text.js";

/** `text[-n:]`: the last `n` code points. */
export function cpTail(text: string, n: number): string {
  if (n <= 0) return "";
  const length = cpLength(text);
  return cpSlice(text, Math.max(0, length - n));
}

/** `text` made one line and cut to `limit` code points, a cut one ending in "…" (render._clip, approval_view._clip). */
export function clip(text: string, limit: number): string {
  const line = squashSpaces(text);
  return cpLength(line) <= limit ? line : `${pyRstrip(cpSlice(line, 0, limit - 1))}…`;
}

/** `json.dumps(value, ensure_ascii=False)`, with `separators=(",", ":")` when `compact`. */
export function pyJson(value: unknown, options: { readonly compact?: boolean } = {}): string {
  return options.compact ? compact(value) : pyJsonDumps(value);
}

function compact(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(compact).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${compact(v)}`).join(",")}}`;
  }
  return pyJsonDumps(value);
}

/** `text` without the run of `char` at its end (`text.rstrip(char)`), in one linear pass. */
export function trimEndOf(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === char) end -= 1;
  return text.slice(0, end);
}
