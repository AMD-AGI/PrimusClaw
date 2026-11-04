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
import { gateNamesEndedTurnSql, stopTurnRuns } from "../tasks/chat-run.js";
import { fireIntoItem, fireTrigger, type TriggerRow } from "./fire.js";
import { nextFireAfter } from "./schedule.js";

const logger = pino({ name: "triggers-scheduler" });
const TICK_MS = 30_000;
const BATCH = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

async function recordFire(
  triggerId: string, key: string, owner: string, status: string, sessionId: string | null, detail: string | null,
  messageId: string | null = null,
): Promise<void> {
  await db.query(
    `UPDATE claw_trigger_fires SET status = $3, session_id = $4, detail = $5, message_id = $6
      WHERE trigger_id = $1 AND fire_key = $2`,
    [triggerId, key, status, sessionId, detail, messageId],
  );
  void owner;
}

/** Whether the trigger's previous run is still going: its own session's, or the turn of the item it wakes. */
async function previousRunOpen(t: Pick<TriggerRow, "trigger_id" | "item_id">): Promise<boolean> {
  const r = t.item_id
    ? await db.query(
      `SELECT 1 FROM claw_work_items w JOIN claw_sessions s ON s.session_id = w.worker_session_id
        WHERE w.item_id = $1 AND s.agent_status = 'running'`,
      [t.item_id],
    )
    : await db.query(
      `SELECT 1 FROM claw_sessions
        WHERE config->>'trigger_id' = $1 AND agent_status = 'running' AND deleted_at IS NULL LIMIT 1`,
      [t.trigger_id],
    );
  return r.rows.length > 0;
}

/** A trigger that has had its last run stays listed, paused as `ended`, and never fires again. */
async function endTrigger(triggerId: string, reason: "ended" | "item_closed"): Promise<void> {
  await db.query(
    "UPDATE claw_triggers SET paused_reason = $2, next_fire_at = NULL, updated_at = NOW() WHERE trigger_id = $1",
    [triggerId, reason],
  );
}

export async function tickTriggers(now: Date = new Date()): Promise<void> {
  const due = (await db.query(
    `SELECT trigger_id, owner_user_id, name, prompt, schedule, timezone, credential_enc, next_fire_at,
            ends_at, max_runs, runs, item_id
       FROM claw_triggers
      WHERE enabled AND paused_reason IS NULL AND next_fire_at <= $1
      ORDER BY next_fire_at LIMIT $2`,
    [now, BATCH],
  )).rows as Array<TriggerRow & { next_fire_at: Date; ends_at: Date | null; max_runs: number | null; runs: number }>;

  for (const t of due) {
    const planned = t.next_fire_at;
    let next: Date | null = null;
    try {
      next = nextFireAfter(t.schedule, t.timezone, now);
    } catch (err) {
      logger.error({ err, triggerId: t.trigger_id }, "trigger.next_fire_failed");
    }
    // The firing after `until` is never planned: this one, if it runs, is the last.
    const pastEnd = next !== null && t.ends_at !== null && next > t.ends_at;
    if (pastEnd) next = null;
    // Moves to the next FUTURE time, so a long outage yields one candidate firing
    // (the planned one, judged stale below), never a burst of catch-up runs.
    const won = await db.query(
      `UPDATE claw_triggers SET next_fire_at = $3, last_fire_at = $4, updated_at = NOW(),
              paused_reason = CASE WHEN $5 THEN 'ended' ELSE paused_reason END
        WHERE trigger_id = $1 AND next_fire_at = $2 AND enabled AND paused_reason IS NULL
        RETURNING trigger_id`,
      [t.trigger_id, planned, next, now, pastEnd],
    );
    if (!won.rows.length) continue;

    const key = planned.toISOString();
    const claimed = await db.query(
      `INSERT INTO claw_trigger_fires (trigger_id, fire_key, owner_user_id, status, fired_at)
       VALUES ($1, $2, $3, 'started', $4) ON CONFLICT DO NOTHING RETURNING fire_key`,
      [t.trigger_id, key, t.owner_user_id, now],
    );
    if (!claimed.rows.length) continue;

    // Already had every run it was given, or planned past its end: a row from before either was set, or one a
    // resume brought back, ends here rather than running once more.
    if ((t.max_runs !== null && t.runs >= t.max_runs) || (t.ends_at !== null && planned > t.ends_at)) {
      await recordFire(t.trigger_id, key, t.owner_user_id, "skipped_ended", null, null);
      await endTrigger(t.trigger_id, "ended");
      continue;
    }
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
      // A rolling limit, not a kill switch: this firing is skipped and recorded
      // with its reason, and the next one is judged again once runs age out of
      // the 24-hour window. Nothing is paused.
      await recordFire(t.trigger_id, key, t.owner_user_id, "skipped_quota", null, "daily_limit");
      logger.warn({ triggerId: t.trigger_id }, "trigger.daily_limit_reached");
      continue;
    }
    if (await previousRunOpen(t)) {
      await recordFire(t.trigger_id, key, t.owner_user_id, "skipped_overlap", null, null);
      continue;
    }

    const outcome = t.item_id ? await fireIntoItem(t, planned) : await fireTrigger(t, planned);
    if (outcome.status === "started") {
      await recordFire(t.trigger_id, key, t.owner_user_id, "started", outcome.sessionId, null, outcome.messageId);
      await db.query(
        `UPDATE claw_triggers
            SET consecutive_failures = 0, runs = runs + 1,
                paused_reason = CASE WHEN max_runs IS NOT NULL AND runs + 1 >= max_runs THEN 'ended' ELSE paused_reason END,
                next_fire_at = CASE WHEN max_runs IS NOT NULL AND runs + 1 >= max_runs THEN NULL ELSE next_fire_at END
          WHERE trigger_id = $1`,
        [t.trigger_id],
      );
      continue;
    }
    if (outcome.status === "item_closed") {
      await recordFire(t.trigger_id, key, t.owner_user_id, "skipped_item_closed", null, null);
      await endTrigger(t.trigger_id, "item_closed");
      continue;
    }
    if (outcome.status === "item_waiting") {
      // The item is waiting for its user; the watch resumes once they answer.
      await recordFire(t.trigger_id, key, t.owner_user_id, "skipped_item_waiting", null, null);
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
        AND f.message_id IS NOT NULL
        -- The turn this trigger started, not whichever turn the session is running
        -- now: a user who continues the conversation later holds the gate under a
        -- different message id, and that turn is theirs to run for as long as they like.
        -- A gate naming a turn that ended while this one ran on is this turn's.
        AND EXISTS (SELECT 1 FROM claw_sessions s
                     WHERE s.session_id = f.session_id AND s.agent_status = 'running'
                       AND (s.agent_gate_message_id = f.message_id
                            OR (${gateNamesEndedTurnSql("s.session_id", "s.agent_gate_message_id")}
                                AND EXISTS (SELECT 1 FROM claw_tasks t
                                             WHERE t.session_id = f.session_id
                                               AND t.metadata->>'message_id' = f.message_id
                                               AND t.status IN ('queued','preparing','running','cancelling')))))
      RETURNING f.session_id, f.message_id`,
    [new Date(now.getTime() - TRIGGER_RUN_TIME_LIMIT_SECONDS * 1000)],
  )).rows as Array<{ session_id: string; message_id: string }>;
  for (const r of over) {
    try {
      // Scoped to the trigger's own turn: the gate match above can be stale by
      // now, and a session-wide stop would take out a turn the user just began.
      await stopTurnRuns(r.session_id, r.message_id);
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
