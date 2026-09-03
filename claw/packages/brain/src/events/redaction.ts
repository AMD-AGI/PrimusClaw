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
 * digits mixed with letters, punctuation, or simply long -- does not appear in
 * a transcript by accident. Casing is not one of the signals; see below.
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
 * Whether an all-letters value collides with prose. All of them do.
 *
 * `main`, `MAIN` and `Main` are one word in three casings and collide
 * identically, so exempting only the lowercase spelling exempted the wrong
 * third of them -- a `BRANCH_TOKEN=Staging` still cut "Staging" out of every
 * line that mentioned the environment.
 *
 * The obvious next step was to keep an exemption for internally-mixed casing,
 * on the theory that a generated token switches case mid-word (`XkjQmzPl`) and
 * vocabulary does not. That theory is false, and expensively so: `GitHub`,
 * `OpenAI`, `iPhone`, `macOS`, and every camelCase identifier a transcript is
 * full of switch case mid-word too. Under a name like `PROJECT_TOKEN` the
 * exemption's absence would have cut "GitHub" out of every sentence that used
 * it.
 *
 * So casing is not consulted at all. A run of nothing but letters, below the
 * length at which vocabulary runs out, is prose -- full stop. What is given up
 * is a generated all-alphabetic token of fewer than 16 characters, and it is
 * not given up to nothing: it stays masked by key name wherever it is a field,
 * which is the pass that does not need to guess. Only the blind substring hunt
 * declines it, and that hunt is the one whose mistakes cannot be undone.
 */
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
  if (secret.length < 16 && ORDINARY_WORD_RE.test(secret)) return false;
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
