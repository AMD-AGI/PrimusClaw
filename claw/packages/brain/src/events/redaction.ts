// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// `isSensitiveKey` is shared with api's `redactPublicJson` rather than
// duplicated: both passes mask the same agent-loop events (here on the way into
// NATS, there on the way out over SSE), and a sensitive name added to one copy
// would have left the other leaking.
import { isSensitiveKey, redactSecrets } from "@claw/utils";

/**
 * Whether a credential value is distinctive enough to hunt by substring.
 *
 * Everything reaching this is already vouched for by name -- runtimeSecrets()
 * collects the run's own keys plus env vars whose name reads as a credential
 * -- so the question is not "is this secret" but "will replacing it every time
 * it appears also destroy ordinary text". The pass is a blind substring
 * replace over payloads that are logged, streamed to users, and replayed to
 * the model, and what it cuts out of a replayed payload is gone for good.
 *
 * A flat length floor answered that badly in both directions. At 16 it dropped
 * `DB_PASSWORD=hunter2`, which is a live credential and only seven characters.
 * Low enough to catch that, it would excise `true` from every command in the
 * transcript the moment someone named a boolean `FEATURE_TOKEN`.
 *
 * Distinctiveness is the property that actually separates them. A value that
 * is a bare word, a bare number, or a boolean spelling collides with prose by
 * construction and cannot be hunted safely whatever its name says -- mask the
 * field by key name and leave the substring pass out of it. Anything else --
 * mixed case, digits with letters, punctuation, or simply long -- does not
 * appear in a transcript by accident.
 *
 * Applied to every candidate, whichever rule nominated it. runtimeSecrets()
 * collects on two grounds now -- the name reads as a credential, or the value
 * itself is shaped like one -- and a value that cannot be hunted safely cannot
 * be hunted safely for either reason. The check lives at the point of use, so
 * there is one place it can be applied and no way for a new collection rule to
 * arrive without it.
 */
const ORDINARY_WORD_RE = /^[A-Za-z]+$/;
const ORDINARY_NUMBER_RE = /^[0-9]+([.,][0-9]+)?$/;
const BOOLEANISH = new Set([
  "true", "false", "yes", "no", "on", "off", "none", "null", "nil",
  "enabled", "disabled", "auto", "default", "debug", "info", "warn", "error",
]);

/**
 * Whether an all-letters value is written the way a word is written.
 *
 * `main`, `MAIN` and `Main` are one word in three casings and collide with
 * prose identically, so exempting only the lowercase spelling exempted the
 * wrong third of them -- a `BRANCH_TOKEN=Staging` still cut "Staging" out of
 * every line that mentioned the environment. Case is not evidence of anything
 * here; a shift key is not entropy.
 *
 * Casing still carries one real signal, which is why this is not simply
 * `toLowerCase()`. A generated alphabetic token switches case mid-word
 * (`XkjQmzPl`) and no vocabulary does, so an internally-mixed run stays
 * distinctive while all-lower, all-upper and Capitalized do not.
 */
function isWordCased(value: string): boolean {
  if (!ORDINARY_WORD_RE.test(value)) return false;
  const lower = value.toLowerCase();
  const upper = value.toUpperCase();
  return value === lower
    || value === upper
    || value === value[0]!.toUpperCase() + lower.slice(1);
}

export function isDistinctiveSecret(secret: string): boolean {
  // Below this, a value cannot carry enough entropy to be worth the collision
  // risk no matter what it looks like.
  if (secret.length < 4) return false;
  const lower = secret.toLowerCase();
  if (BOOLEANISH.has(lower)) return false;
  if (ORDINARY_NUMBER_RE.test(secret)) return false;
  // A short run of letters written as a word is a word ("main", "Staging",
  // "REMOTE"). Past a certain length it stops being one -- a 16-character
  // alphabetic string is a token, not vocabulary.
  if (secret.length < 16 && isWordCased(secret)) return false;
  return true;
}

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
  runtimeSecrets: readonly string[],
  key?: string,
): unknown {
  if (key && isSensitiveKey(key) && value !== null && value !== undefined && value !== "") {
    return "<redacted>";
  }
  if (typeof value === "string") {
    let text = redactSecrets(value).text;
    for (const secret of runtimeSecrets) {
      if (isDistinctiveSecret(secret)) text = text.split(secret).join("<redacted>");
    }
    return text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, runtimeSecrets));
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "<redacted:cyclic>";
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = redactValue(childValue, seen, runtimeSecrets, childKey);
  }
  seen.delete(value);
  return out;
}

/**
 * Redact any persisted event before it reaches NATS, the event database, or
 * the transcript archive. Event shape is preserved so existing UI cards keep
 * rendering, while sensitive-key fields, known secret formats, and exact
 * runtime credentials are replaced.
 */
export function redactPersistedEvent(
  evt: Record<string, unknown>,
  runtimeSecrets: readonly string[] = [],
): Record<string, unknown> {
  return redactValue(evt, new WeakSet<object>(), runtimeSecrets) as Record<string, unknown>;
}

/** Backwards-compatible name retained for existing callers and tests. */
export const redactToolEvent = redactPersistedEvent;

export function redactCheckpointState<T>(
  state: T,
  runtimeSecrets: readonly string[] = [],
): T {
  return redactValue(state, new WeakSet<object>(), runtimeSecrets) as T;
}
