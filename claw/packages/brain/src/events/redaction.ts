// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// `isSensitiveKey` is shared with api's `redactPublicJson` rather than
// duplicated: both passes mask the same agent-loop events (here on the way into
// NATS, there on the way out over SSE), and a sensitive name added to one copy
// would have left the other leaking.
import { isSensitiveKey, redactSecrets } from "@claw/utils";

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
      // The floor matches redactSecrets()'s own guard on extraSecrets, and for
      // the same reason: this is a blind substring replace, so a short value
      // does not identify a credential, it just matches prose. A config var
      // holding "true", "main" or "8080" would otherwise excise that word from
      // every command, path and log line in the payload -- and these payloads
      // are replayed to the model, so what is cut is gone for good. Sixteen
      // characters is short enough to still catch a real token and long enough
      // that a collision with ordinary text is a deliberate act.
      if (secret.length >= 16) text = text.split(secret).join("<redacted>");
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
