// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model a session asks for, as a client states it and as a turn reads it.
 *
 * `claw_sessions.model` is NULL for "whatever the deployment's default is",
 * which is what every session had before the column existed. A value is the
 * name of a model the LLM gateway serves; this module does not know which names
 * those are and must not learn them. The gateway decides, so a model added to it
 * is selectable without a release here, and a name it refuses reaches the user
 * as the gateway's own error on the turn, shown like any other LLM failure.
 *
 * What is checked is the shape of the string only: it ends up in a request body,
 * a log line and a metrics label, and a client is not trusted to keep it short or
 * printable.
 */

export const SESSION_MODEL_MAX_LENGTH = 128;

/** A gateway model name: letters, digits and the separators real names use. */
const SESSION_MODEL_PATTERN = /^[A-Za-z0-9._:/-]+$/;

export type SessionModelParse =
  | { ok: true; model: string | null }
  | { ok: false; error: string };

/**
 * Check a `model` field a client sent.
 *
 * `null` is a valid value and means "no choice": on create it is the same as
 * leaving the field out, and on update it clears an earlier choice. An absent
 * field is not a value and is not decided here -- on create it means no choice,
 * on update it means leave the current one alone, and only the caller knows
 * which request it is serving.
 *
 * The string is taken as it is, not trimmed. A name with a space around it is
 * not a name the gateway has, and quietly correcting it would make the stored
 * value differ from what the client sent and will compare against.
 */
export function parseSessionModel(raw: unknown): SessionModelParse {
  if (raw === null) return { ok: true, model: null };
  if (typeof raw !== "string") {
    return { ok: false, error: "model must be a string or null" };
  }
  if (raw.length === 0) return { ok: false, error: "model must not be empty" };
  if (raw.length > SESSION_MODEL_MAX_LENGTH) {
    return { ok: false, error: `model must be at most ${SESSION_MODEL_MAX_LENGTH} characters` };
  }
  if (!SESSION_MODEL_PATTERN.test(raw)) {
    return { ok: false, error: "model may contain only letters, digits and . _ : / -" };
  }
  return { ok: true, model: raw };
}

/**
 * The model to put on a turn's execute request, from a `claw_sessions` row.
 *
 * Undefined, not an empty string, when the session has no choice: Brain falls
 * back on a falsy `model` either way, but an absent field is what keeps a run's
 * persisted spec byte-identical to what it was for a session that never chose.
 */
export function sessionModelFromRow(row: { model?: unknown } | null | undefined): string | undefined {
  const model = row?.model;
  return typeof model === "string" && model !== "" ? model : undefined;
}
