// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Creating, listing and removing a user's triggers: what `/v1/triggers` and the model's trigger tools share, so
 * both hold every trigger to the same limits. Who the user is is the caller's business; nothing here takes it from
 * the input.
 */
import crypto from "node:crypto";
import { TRIGGER_MAX_PER_USER, TRIGGER_MIN_INTERVAL_MINUTES } from "../config.js";
import { encryptUserEnvValue } from "../crypto/user-env.js";
import { db } from "../infra/db.js";
import { checkSchedule, nextFireAfter } from "./schedule.js";

export const TRIGGER_PUBLIC_COLUMNS =
  "trigger_id, name, kind, prompt, schedule, timezone, enabled, paused_reason, next_fire_at, last_fire_at, consecutive_failures, ends_at, max_runs, runs, item_id, created_at, updated_at";
export const TRIGGER_MAX_PROMPT = 8000;
export const TRIGGER_MAX_NAME = 120;
/** A bound, not a budget: the daily limit is what caps spending. */
export const TRIGGER_MAX_RUNS_LIMIT = 1000;

export interface TriggerInput {
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
  endsAt: Date | null;
  maxRuns: number | null;
}

export type TriggerInputCheck = { ok: true; input: TriggerInput } | { ok: false; error: string };

/** The body of a create, as either caller receives it: `until` is an ISO time, `max_runs` a count. */
export function parseTriggerInput(b: Record<string, unknown>, now: Date = new Date()): TriggerInputCheck {
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  const schedule = typeof b.schedule === "string" ? b.schedule.trim() : "";
  const timezone = typeof b.timezone === "string" ? b.timezone : "";
  if (!name || name.length > TRIGGER_MAX_NAME) return { ok: false, error: `name required (max ${TRIGGER_MAX_NAME} characters)` };
  if (!prompt || prompt.length > TRIGGER_MAX_PROMPT) return { ok: false, error: "prompt required" };
  const check = checkSchedule(schedule, timezone, TRIGGER_MIN_INTERVAL_MINUTES, now);
  if (!check.ok) return check;
  let endsAt: Date | null = null;
  if (b.until !== undefined && b.until !== null) {
    endsAt = typeof b.until === "string" ? new Date(b.until) : new Date(NaN);
    if (Number.isNaN(endsAt.getTime())) return { ok: false, error: "until must be an ISO 8601 time" };
    const first = nextFireAfter(schedule, timezone, now);
    if (!first || first > endsAt) return { ok: false, error: "the schedule does not fire before until" };
  }
  let maxRuns: number | null = null;
  if (b.max_runs !== undefined && b.max_runs !== null) {
    if (!Number.isInteger(b.max_runs) || (b.max_runs as number) < 1 || (b.max_runs as number) > TRIGGER_MAX_RUNS_LIMIT) {
      return { ok: false, error: `max_runs must be a whole number from 1 to ${TRIGGER_MAX_RUNS_LIMIT}` };
    }
    maxRuns = b.max_runs as number;
  }
  return { ok: true, input: { name, prompt, schedule, timezone, endsAt, maxRuns } };
}

/** What a firing runs as, sealed onto the row: the run that fires later has no request to take it from. */
export function sealTriggerCredentials(c: { platformKey: string; virtualKey: string; userName: string }): string {
  return encryptUserEnvValue(JSON.stringify({ platformKey: c.platformKey, virtualKey: c.virtualKey, userName: c.userName }));
}

/** Null when the owner already has as many triggers as one user may. */
export async function insertTrigger(
  ownerUserId: string, input: TriggerInput, credentialEnc: string, itemId: string | null = null,
): Promise<Record<string, unknown> | null> {
  // One statement: the cap is counted in the same INSERT so two creates cannot both pass it.
  const r = await db.query(
    `INSERT INTO claw_triggers
       (trigger_id, owner_user_id, name, prompt, schedule, timezone, next_fire_at, credential_enc, ends_at, max_runs, item_id)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $10, $11, $12
      WHERE (SELECT COUNT(*) FROM claw_triggers WHERE owner_user_id = $2) < $9
     RETURNING ${TRIGGER_PUBLIC_COLUMNS}`,
    [crypto.randomUUID(), ownerUserId, input.name, input.prompt, input.schedule, input.timezone,
      nextFireAfter(input.schedule, input.timezone, new Date()), credentialEnc, TRIGGER_MAX_PER_USER,
      input.endsAt, input.maxRuns, itemId],
  );
  return (r.rows[0] as Record<string, unknown> | undefined) ?? null;
}

export async function listTriggers(ownerUserId: string): Promise<Array<Record<string, unknown>>> {
  return (await db.query(
    `SELECT ${TRIGGER_PUBLIC_COLUMNS} FROM claw_triggers WHERE owner_user_id = $1 ORDER BY created_at`, [ownerUserId],
  )).rows as Array<Record<string, unknown>>;
}

/** False when the owner has no trigger of that id, whoever else might. */
export async function deleteTrigger(ownerUserId: string, triggerId: string): Promise<boolean> {
  const r = await db.query(
    "DELETE FROM claw_triggers WHERE trigger_id = $1 AND owner_user_id = $2 RETURNING trigger_id", [triggerId, ownerUserId],
  );
  return (r.rowCount ?? 0) > 0;
}
