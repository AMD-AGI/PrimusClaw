// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Text Postgres can store, from text a run produced.
 *
 * Two kinds of character are valid in a JavaScript string and refused by the
 * database. U+0000 is refused by `text` (SQLSTATE 22021) and by `jsonb`, where
 * `JSON.stringify` writes it as the escape `\u0000` (22P05). A lone UTF-16
 * surrogate is written by `JSON.stringify` as an escape `jsonb` refuses
 * (22P02); in a `text` parameter the driver's UTF-8 encoding quietly turns it
 * into U+FFFD, so only the `jsonb` columns fail on it.
 *
 * Either one in a run's output -- a model echoing a binary file, a script
 * printing a C string -- failed the whole `agent_done` write, and because the
 * same body fails the same way every time, the callback was retried until the
 * delivery budget ran out and the run ended as a failure it never had. Both
 * become U+FFFD here, the character a decoder uses for what it could not read,
 * so everything else the run produced is kept.
 */

// Code units, not code points: without the `u` flag a lone surrogate is one
// match, and a valid pair is passed over by both lookarounds.
const UNSTORABLE_SOURCE = "\\u0000|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]";
const UNSTORABLE = new RegExp(UNSTORABLE_SOURCE, "g");
/** Stateless, unlike the global one: `test` on a `g` regex moves its `lastIndex`. */
const HAS_UNSTORABLE = new RegExp(UNSTORABLE_SOURCE);

/** Counts what a sanitising pass replaced, so a caller can say that it did. */
export interface Replacements {
  count: number;
}

export function storableText(value: string, tally?: Replacements): string {
  if (!HAS_UNSTORABLE.test(value)) return value;
  return value.replace(UNSTORABLE, () => {
    if (tally) tally.count++;
    return "\uFFFD";
  });
}

/**
 * The same value with every string in it, keys included, made storable.
 *
 * Only what `JSON.parse` can produce is walked: a request body is plain
 * objects, arrays and scalars. Anything else is returned as it is.
 */
export function storableJson<T>(value: T, tally?: Replacements): T {
  if (typeof value === "string") return storableText(value, tally) as T;
  if (Array.isArray(value)) return value.map((item) => storableJson(item, tally)) as T;
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    // `fromEntries` defines each key as an own property, so a `__proto__` key
    // from a request body stays a key rather than becoming the prototype.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [storableText(key, tally), storableJson(item, tally)]),
    ) as T;
  }
  return value;
}

/**
 * The SQLSTATEs a write fails with because of the values it carries.
 *
 * Retrying such a write sends the same values and fails the same way, so the
 * caller is told it was refused (422) rather than that something went wrong
 * (500), which a sender treats as worth repeating.
 *
 *   22021 character_not_in_repertoire  (U+0000 in `text`)
 *   22P05 untranslatable_character     (`\u0000` in `jsonb`)
 *   22P02 invalid_text_representation  (a lone surrogate in `jsonb`, a value of the wrong type)
 *   22003 numeric_value_out_of_range   (a count too large for its column)
 */
const UNSTORABLE_SQLSTATES = new Set(["22021", "22P05", "22P02", "22003"]);

/** The SQLSTATE when `err` is a write the database refused for its values. */
export function unstorableSqlState(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && UNSTORABLE_SQLSTATES.has(code) ? code : null;
}
