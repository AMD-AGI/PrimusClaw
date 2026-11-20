// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Text Postgres will store, made at the write boundary instead of refused there.
 *
 * Two kinds of character are valid in a JavaScript string and not storable:
 *
 *   - NUL (U+0000). A TEXT column refuses the byte ("invalid byte sequence for
 *     encoding UTF8: 0x00") and jsonb refuses the escape ("unsupported Unicode
 *     escape sequence"), so a single NUL anywhere in a request fails the whole
 *     insert.
 *   - A lone surrogate, half of a UTF-16 pair with the other half missing.
 *     `JSON.stringify` writes it as a `\udXXX` escape and jsonb refuses that
 *     too; a TEXT parameter only survives because the driver's UTF-8 encoder
 *     silently swaps it for U+FFFD on the way out.
 *
 * Both become U+FFFD, the replacement character, which is what the driver
 * already does for a surrogate in TEXT. Every other character passes untouched,
 * so text that was storable before is byte-for-byte the same after.
 */

const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `text` with every NUL and lone surrogate replaced by U+FFFD. */
export function storableText(text: string): string {
  return text.replace(UNSTORABLE, "�");
}

/** The same for an optional string, passing anything else through. */
export function storableOptionalText<T>(value: T): T {
  return (typeof value === "string" ? storableText(value) : value) as T;
}

/**
 * A copy of a JSON-shaped value with every string in it, keys included, made
 * storable. Not a general deep clone: what reaches a jsonb parameter is plain
 * data, and anything that is not a string, array or plain object is returned as
 * it is for `JSON.stringify` to deal with exactly as before.
 */
export function storableJson<T>(value: T): T {
  if (typeof value === "string") return storableText(value) as T;
  if (Array.isArray(value)) return value.map((v) => storableJson(v)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[storableText(k)] = storableJson(v);
    return out as T;
  }
  return value;
}
