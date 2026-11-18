// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reading one field of an untrusted JSON object (a connector's report, an agent's event, a card's data) the way the Python worker
 * read its dicts: text is what is there, nothing for a missing, empty, false or zero value.
 */
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value === 0 ? "" : String(value);
  return value === true ? "True" : "";
}

/** An object field as a record, or null for anything else. */
export function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
