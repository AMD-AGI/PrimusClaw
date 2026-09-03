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
 */
const ORDINARY_WORD_RE = /^[a-z]+$/;
const ORDINARY_NUMBER_RE = /^[0-9]+([.,][0-9]+)?$/;
const BOOLEANISH = new Set([
  "true", "false", "yes", "no", "on", "off", "none", "null", "nil",
  "enabled", "disabled", "auto", "default", "debug", "info", "warn", "error",
]);

export function isDistinctiveSecret(secret: string): boolean {
  // Below this, a value cannot carry enough entropy to be worth the collision
  // risk no matter what it looks like.
  if (secret.length < 4) return false;
  const lower = secret.toLowerCase();
  if (BOOLEANISH.has(lower)) return false;
  if (ORDINARY_NUMBER_RE.test(secret)) return false;
  // A short run of plain lowercase letters is a word ("main", "remote",
  // "staging"). Past a certain length it stops being one -- a 16-character
  // lowercase string is a token, not vocabulary.
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

/**
 * Mask a value on its way OUT of this process -- into NATS, the event
 * database, the transcript archive, the SSE stream, or the ExecuteResult that
 * becomes a downstream node's prompt.
 *
 * Previously called redactEgressPayload, which is how it came to be applied
 * to the checkpoint: a name that says "checkpoint" makes redacting one look
 * like the intended use. It never was. A checkpoint is the conversation a
 * resumed run replays to the model, and mutating it deletes content the agent
 * then no longer has. The five callers that use this are all genuine egress;
 * the checkpoint writer takes it as an explicit parameter for the v3 format
 * only, and cannot import it at all (see checkpoint-codec.ts).
 *
 * `runtimeSecrets` is required rather than defaulted. An optional parameter is
 * one a caller can omit and still typecheck, and `redactEgressPayload(x)` with
 * no secrets does no exact-value replacement at all while looking like it did.
 */
export function redactEgressPayload<T>(
  value: T,
  runtimeSecrets: readonly string[],
): T {
  return redactValue(value, new WeakSet<object>(), runtimeSecrets) as T;
}
