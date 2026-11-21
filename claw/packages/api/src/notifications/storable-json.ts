// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A copy of a JSON value that PostgreSQL can store.
 *
 * `jsonb` (and `text`) refuse two things a JavaScript string can hold: the NUL
 * character, which `JSON.stringify` writes as `\u0000`, and a lone UTF-16
 * surrogate, which it writes as `\ud800`-style escapes. Both reach Claw inside
 * session events (a tool that read a binary file, a model that cut a pair in
 * half), and one of them in a row makes the whole statement fail. Each becomes
 * U+FFFD, the replacement character, in values and in keys alike; every other
 * character is kept as it is, so a value that was storable comes back equal.
 */
export function storableJson<T>(value: T): T {
  return clean(value) as T;
}

/** NUL, a high surrogate with no low one after it, or a low one with no high one before it. */
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function cleanString(s: string): string {
  return s.replace(UNSTORABLE, "\uFFFD");
}

function clean(value: unknown): unknown {
  if (typeof value === "string") return cleanString(value);
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") {
    // A Date, a Buffer or anything else with its own JSON form keeps it.
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[cleanString(key)] = clean(inner);
    return out;
  }
  return value;
}
