// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The shapes a value must have to be echoed into a report. Each pattern ends like Python's `re.match(...$)`: a single
 * trailing newline is allowed, as the Python worker allowed it.
 */

/** What may be echoed from an event or a log field: an id, a status, a tool name. */
export const TOKEN = /^[A-Za-z0-9_.:@/+=-]{1,64}\n?$/;
/** An image tag. */
export const TAG = /^[A-Za-z0-9_.:@/+-]{1,100}\n?$/;
/** `owner/name` of the repository issues go to. */
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\n?$/;
/** A plain email address (nothing else may be written into the markdown). */
export const EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,253}\n?$/;

/** A value that may be echoed: a short identifier-shaped string, or an integer; undefined for anything else. */
export function tokenOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}
