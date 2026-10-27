// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the API and Brain share about an app run: the states of the run row and
 * the scrubbing of secret values out of text and documents. One definition, so a
 * state added on one side cannot be missing on the other and the two sides cannot
 * disagree about what counts as a secret's appearance.
 */

export const APP_RUN_STATES = [
  "provisioning", "starting", "running", "restarting", "finishing", "ended",
] as const;
export type AppRunState = (typeof APP_RUN_STATES)[number];

/**
 * The `cloudevents/v1` event cursor's two shapes (hosting design 5.7), shared by
 * Brain, which writes the cursor, and the API, which validates it: a segment file
 * name, and a CloudEvents `id` (a decimal string).
 */
export const APP_EVENT_SEGMENT_NAME = /^\d{10}\.jsonl$/;
export const APP_EVENT_ID = /^\d{1,20}$/;

/** Secrets shorter than this are not hunted: they would shred ordinary text, and a real token is far longer. */
export const SCRUB_MIN_SECRET_LENGTH = 8;

/**
 * `text` with every occurrence of every secret replaced. The JSON-escaped form of
 * a secret (one holding a quote or a backslash) is replaced too, so the result is
 * clean whether `text` is plain or a serialised document.
 */
export function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < SCRUB_MIN_SECRET_LENGTH) continue;
    const escaped = JSON.stringify(secret).slice(1, -1);
    out = out.split(secret).join("[redacted]");
    if (escaped !== secret) out = out.split(escaped).join("[redacted]");
  }
  return out;
}

/** `value` with the secrets removed at any depth (serialised, scrubbed, read back). */
export function scrubSecrets<T>(value: T, secrets: readonly string[]): T {
  return JSON.parse(scrubText(JSON.stringify(value), secrets)) as T;
}
