// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The trigger loop.
 *
 * Each tick takes the triggers whose `next_fire_at` has passed. For each, one
 * `UPDATE ... WHERE next_fire_at = <the value read> RETURNING` moves the schedule
 * forward and is the whole of the cross-replica coordination: the replica whose
 * statement matches a row owns that firing and the others match nothing (the
 * single idempotent statement case in infra/leader-lock.ts, so no lock is
 * taken). `claw_trigger_fires (trigger_id, fire_key)` is the second line: the
 * planned time is the key, so even a path that bypassed the CAS cannot start the
 * same firing twice.
 */
import pino from "pino";
import {
  TRIGGER_DAILY_LIMIT_PER_USER, TRIGGER_MAX_CONSECUTIVE_FAILURES,
  TRIGGER_RUN_TIME_LIMIT_SECONDS, TRIGGER_STALE_AFTER_SECONDS,
} from "../config.js";
import { db } from "../infra/db.js";
import { stopSessionRuns } from "../tasks/chat-run.js";
import { fireTrigger, type TriggerRow } from "./fire.js";
import { nextFireAfter } from "./schedule.js";

const logger = pino({ name: "triggers-scheduler" });
const TICK_MS = 30_000;
const BATCH = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

async function recordFire(
  triggerId: string, key: string, owner: string, status: string, sessionId: string | null, detail: string | null,
): Promise<void> {
  await db.query(
    `UPDATE claw_trigger_fires SET status = $3, session_id = $4, detail = $5
      WHERE trigger_id = $1 AND fire_key = $2`,
    [triggerId, key, status, sessionId, detail],
  );
  void owner;
}

/** Whether the trigger's previous run is still going. */
async function previousRunOpen(triggerId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM claw_sessions
      WHERE config->>'trigger_id' = $1 AND agent_status = 'running' AND deleted_at IS NULL LIMIT 1`,
    [triggerId],
  );
  return r.rows.length > 0;
}

export async function tickTriggers(now: Date = new Date()): Promise<void> {
  const due = (await db.query(
    `SELECT trigger_id, owner_user_id, name, prompt, schedule, timezone, credential_enc, next_fire_at
       FROM claw_triggers
      WHERE enabled AND paused_reason IS NULL AND next_fire_at <= $1
      ORDER BY next_fire_at LIMIT $2`,
    [now, BATCH],
  )).rows as Array<TriggerRow & { next_fire_at: Date }>;

  for (const t of due) {
    const planned = t.next_fire_at;
    let next: Date | null = null;
    try {
      next = nextFireAfter(t.schedule, t.timezone, now);
    } catch (err) {
      logger.error({ err, triggerId: t.trigger_id }, "trigger.next_fire_failed");
    }
    // Moves to the next FUTURE time, so a long outage yields one candidate firing
    // (the planned one, judged stale below), never a burst of catch-up runs.
    const won = await db.query(
      `UPDATE claw_triggers SET next_fire_at = $3, last_fire_at = $4, updated_at = NOW()
        WHERE trigger_id = $1 AND next_fire_at = $2 AND enabled AND paused_reason IS NULL
        RETURNING trigger_id`,
      [t.trigger_id, planned, next, now],
    );
    if (!won.rows.length) continue;

    const key = planned.toISOString();
    const claimed = await db.query(
      `INSERT INTO claw_trigger_fires (trigger_id, fire_key, owner_user_id, status, fired_at)
       VALUES ($1, $2, $3, 'started', $4) ON CONFLICT DO NOTHING RETURNING fire_key`,
      [t.trigger_id, key, t.owner_user_id, now],
    );
    if (!claimed.rows.length) continue;

    if (now.getTime() - planned.getTime() > TRIGGER_STALE_AFTER_SECONDS * 1000) {
      await recordFire(t.trigger_id, key, t.owner_user_id, "skipped_stale", null, null);
      continue;
    }
    // Counted before this firing's own row is considered, so the limit is the number of runs allowed.
    const used = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM claw_trigger_fires
        WHERE owner_user_id = $1 AND status = 'started' AND session_id IS NOT NULL AND fired_at > $2`,
      [t.owner_user_id, new Date(now.getTime() - DAY_MS)],
    )).rows[0].n);
    if (used >= TRIGGER_DAILY_LIMIT_PER_USER) {
      await recordFire(t.trigger_id, key, t.owner_user_id, "skipped_quota", null, null);
      await db.query(
        `UPDATE claw_triggers SET paused_reason = 'quota', updated_at = NOW()
          WHERE owner_user_id = $1 AND paused_reason IS NULL`,
        [t.owner_user_id],
      );
      logger.warn({ triggerId: t.trigger_id }, "trigger.daily_limit_reached");
      continue;
    }
    if (await previousRunOpen(t.trigger_id)) {
      await recordFire(t.trigger_id, key, t.owner_user_id, "skipped_overlap", null, null);
      continue;
    }

    const outcome = await fireTrigger(t, planned);
    if (outcome.status === "started") {
      await recordFire(t.trigger_id, key, t.owner_user_id, "started", outcome.sessionId, null);
      await db.query("UPDATE claw_triggers SET consecutive_failures = 0 WHERE trigger_id = $1", [t.trigger_id]);
      continue;
    }
    await recordFire(t.trigger_id, key, t.owner_user_id, "failed_start", null, outcome.detail);
    if (outcome.credentialInvalid) {
      // No retry: the same credential will fail the same way.
      await db.query(
        "UPDATE claw_triggers SET paused_reason = 'credential_invalid', updated_at = NOW() WHERE trigger_id = $1",
        [t.trigger_id],
      );
    } else {
      await db.query(
        `UPDATE claw_triggers
            SET consecutive_failures = consecutive_failures + 1,
                paused_reason = CASE WHEN consecutive_failures + 1 >= $2 THEN 'failures' ELSE paused_reason END,
                updated_at = NOW()
          WHERE trigger_id = $1`,
        [t.trigger_id, TRIGGER_MAX_CONSECUTIVE_FAILURES],
      );
    }
  }
  await enforceRunTimeLimit(now);
}

/**
 * Stop trigger runs that have outlived their budget. Marking the row first is the
 * claim, so two replicas do not both stop the same run.
 */
export async function enforceRunTimeLimit(now: Date = new Date()): Promise<number> {
  const over = (await db.query(
    `UPDATE claw_trigger_fires f SET detail = 'time_limit'
      WHERE f.status = 'started' AND f.session_id IS NOT NULL
        AND f.detail IS DISTINCT FROM 'time_limit'
        AND f.fired_at < $1
        AND EXISTS (SELECT 1 FROM claw_sessions s
                     WHERE s.session_id = f.session_id AND s.agent_status = 'running')
      RETURNING f.session_id`,
    [new Date(now.getTime() - TRIGGER_RUN_TIME_LIMIT_SECONDS * 1000)],
  )).rows as Array<{ session_id: string }>;
  for (const r of over) {
    try {
      await stopSessionRuns(r.session_id);
      logger.warn({ sessionId: r.session_id }, "trigger.run_time_limit_stop");
    } catch (err) {
      logger.error({ err, sessionId: r.session_id }, "trigger.run_time_limit_stop_failed");
    }
  }
  return over.length;
}

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startTriggerScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    tickTriggers().catch((err) => logger.error({ err }, "trigger.tick_failed")).finally(() => { inFlight = false; });
  }, TICK_MS);
  logger.info({ tickMs: TICK_MS }, "trigger-scheduler.started");
}

export function stopTriggerScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
