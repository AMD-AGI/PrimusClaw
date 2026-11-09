// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Python string semantics the core's `text/py-text.ts` does not have yet (asked for there; this file goes once it does):
 * `str.lstrip()` and `str(value or "")`.
 */
import { pyRstrip, pyStrip } from "@primusclaw/personal-agent";

/** `text.lstrip()`. */
export function pyLstrip(text: string): string {
  const stripped = pyStrip(text);
  if (!stripped) return "";
  return text.slice(text.indexOf(stripped));
}

/** `text.rstrip()`, re-exported beside `pyLstrip` for one import. */
export { pyRstrip };

/**
 * Python's `str(value or "")` for the scalar values a card or a message is built from: a falsy value is "", `true` is
 * "True". An object or an array is never shown as text here, so it is "" too (Python would print its repr).
 */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value === 0 || Number.isNaN(value) ? "" : String(value);
  if (typeof value === "bigint") return value === 0n ? "" : value.toString();
  if (typeof value === "boolean") return value ? "True" : "";
  return "";
}
