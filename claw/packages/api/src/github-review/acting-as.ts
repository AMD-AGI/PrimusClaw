// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `config.acting_as` of a session: the id of the user whose GitHub account the
 * session's review tools use. A reference, never a credential. The session's owner
 * is the requester; whether the named user has bound an account and allows others
 * to act for them is decided by the tools, per call, not here.
 */
export type ActingAsParse = { ok: true; actingAs: string | null } | { ok: false; error: string };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,127}$/;

export function parseActingAs(value: unknown): ActingAsParse {
  if (value === undefined || value === null) return { ok: true, actingAs: null };
  if (typeof value !== "string" || !ID_RE.test(value)) {
    return { ok: false, error: "config.acting_as must be a user id: letters, digits and . _ @ : + - only, at most 128 characters" };
  }
  return { ok: true, actingAs: value };
}

/**
 * The user a session's stored config says it acts as, or null: unset, or not a well-formed id, which makes it an ordinary session. The one
 * reading that two things share, the tools a turn is offered (`session-tools.ts`) and the gate on who may start a turn (`acting-turns.ts`),
 * so that a session that is offered the tools is a session that is gated, whatever its `acting_as` looks like.
 */
export function actingUserOf(config: unknown): string | null {
  const value = config !== null && typeof config === "object" ? (config as Record<string, unknown>).acting_as : undefined;
  const parsed = parseActingAs(value);
  return parsed.ok ? parsed.actingAs : null;
}
