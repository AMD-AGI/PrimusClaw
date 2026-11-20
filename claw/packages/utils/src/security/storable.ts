// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What PostgreSQL refuses to store, whatever the rest of a value is.
//
// `jsonb` takes a JSON text and refuses two escapes in it: `\u0000` ("unsupported Unicode escape sequence") and a
// surrogate that is not half of a pair (`\ud800` alone, "invalid input syntax for type json"). `JSON.stringify` writes
// both for a JS string that holds them, and such strings are ordinary in what agents print: a NUL from a terminal, half
// of an emoji left by a cut made in UTF-16 units. A `text` column refuses the NUL byte too (invalid byte sequence for
// UTF8); an unpaired surrogate is written there as U+FFFD by the driver's UTF-8 encoding already.
//
// One such character fails the whole statement, and with it every other row of the batch it was in. Here each one is
// replaced by U+FFFD, the character Unicode reserves for "something was here that could not be kept", in keys as well
// as values, so the rest of the text is stored as it was.

/** The replacement for a character that cannot be stored. */
export const UNSTORABLE_REPLACEMENT = "�";

/** U+0000, a high surrogate with no low one after it, a low surrogate with no high one before it. */
const UNSTORABLE_RE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `text` with every character PostgreSQL cannot store replaced by U+FFFD; the same string when there is none. */
export function storableText(text: string): string {
  UNSTORABLE_RE.lastIndex = 0;
  if (!UNSTORABLE_RE.test(text)) return text;
  UNSTORABLE_RE.lastIndex = 0;
  return text.replace(UNSTORABLE_RE, UNSTORABLE_REPLACEMENT);
}

/**
 * A copy of a JSON-compatible value that PostgreSQL can store as `jsonb`: {@link storableText} applied to every string,
 * object keys included, at any depth. A value with `toJSON` (a `Date`) is taken as what `JSON.stringify` would write for
 * it. Numbers, booleans and null are kept. The input is not modified.
 */
export function storableJson<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return storableText(value);
  if (Array.isArray(value)) return value.map(walk);
  if (!value || typeof value !== "object") return value;
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    const json: unknown = toJSON.call(value);
    if (json !== value) return walk(json);
  }
  // Built with fromEntries, which defines each key as the copy's own field: in parsed JSON `__proto__` is an ordinary key, and an
  // assignment under that name would set the copy's prototype instead (and the key would be lost).
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [storableText(key), walk(child)]));
}

/** `JSON.stringify` of {@link storableJson}: a parameter for a `$n::jsonb` placeholder that PostgreSQL accepts. */
export function storableJsonText(value: unknown): string {
  return JSON.stringify(storableJson(value));
}
