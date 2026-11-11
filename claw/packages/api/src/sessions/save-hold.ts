// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The session's next turn waits, in the API's own queue, for the last turn's workspace save.
 *
 * A turn ends on the session (`exec_complete`) before Brain uploads its `/workspace`, so the session reads idle while the
 * upload runs -- for up to an hour on a turn that cloned a large repository. The run doing the upload still holds the
 * workspace lock, and a turn dispatched to Brain behind it can wait for that lock only as long as its redelivery budget
 * lasts (about 60 to 80 minutes) before it is failed. So the completion that sets the session idle also sets this hold
 * (`claw_sessions.workspace_save_id` / `workspace_save_until`), and while it is held a message is queued in
 * `claw_pending_messages` rather than dispatched, and nothing drains that queue. The save's `workspaceSave` `finished`
 * (whatever its outcome) releases it and drains at once.
 *
 * The run doing the save keeps its sandbox and its lease while the hold lasts, though the completion already closed its
 * row: the sandbox reclaimers ask `workspaceSaveHoldsSession` before they stop a session's sandbox, and the lease route
 * asks `workspaceSaveHoldsRun` before it refuses a renewal as terminal. Once the save is over (or the hold runs out) both
 * go back to treating the run as finished.
 *
 * What ends a hold whose finish never comes:
 *   - Brain itself: a run stopped during its save is redelivered and finishes the ended turn by reporting the save over
 *     (brain `finishEndedTurn`); a run that stands down on a lost lease reports it from its own `finally`;
 *   - the sweeper (`releaseFinishedWorkspaceSaves`), for a finish stored by one replica while another was still setting
 *     the hold;
 *   - and the time bound, WORKSPACE_SAVE_STALE_MS, after which the hold reads as released and the orphan drain sends the
 *     queue on.
 */
import { WORKSPACE_SAVE_EVENT, WORKSPACE_SAVE_STALE_MS } from "@claw/protocol";
import pino from "pino";
import { db } from "../infra/db.js";

const logger = pino({ name: "workspace-save-hold" });

/** Whether the session (`claw_sessions`, unaliased or aliased as the caller's FROM names it) holds its queue for a save. */
export function workspaceSaveHeldSql(alias = ""): string {
  const c = alias ? `${alias}.` : "";
  return `(${c}workspace_save_until IS NOT NULL AND ${c}workspace_save_until > NOW())`;
}

/** The hold's bound, as a SQL interval, for the statement that sets it. */
export const WORKSPACE_SAVE_HOLD_INTERVAL_SQL = `make_interval(secs => ${Math.round(WORKSPACE_SAVE_STALE_MS / 1000)})`;

/**
 * The SET clause for the completion's own UPDATE: hold for `saveParam` unless that save's finish is already stored
 * (a finish handled by another replica before this completion would otherwise find no hold to release).
 */
export function workspaceSaveHoldSet(sessionParam: string, saveParam: string, taskParam: string): string {
  const finished = `EXISTS (
    SELECT 1 FROM claw_session_events f
     WHERE f.session_id = ${sessionParam} AND f.deleted_at IS NULL AND f.event = '${WORKSPACE_SAVE_EVENT}'
       AND f.data->>'phase' = 'finished' AND f.data->>'save_id' = ${saveParam}::text
       AND f.created_at > NOW() - ${WORKSPACE_SAVE_HOLD_INTERVAL_SQL})`;
  const held = `${saveParam}::text IS NOT NULL AND NOT ${finished}`;
  return `workspace_save_id = CASE WHEN ${held} THEN ${saveParam}::text END,
          workspace_save_until = CASE WHEN ${held} THEN NOW() + ${WORKSPACE_SAVE_HOLD_INTERVAL_SQL} END,
          workspace_save_task_id = CASE WHEN ${held} THEN ${taskParam}::text END`;
}

/**
 * Release the hold the save `saveId` set, if it is still that save's.
 *
 * @returns the session's owner when this released it, for the drain that follows; null when there was nothing to release.
 */
export async function releaseWorkspaceSaveHold(sessionId: string, saveId: string): Promise<{ userId: string } | null> {
  const r = await db.query(
    `UPDATE claw_sessions SET workspace_save_id = NULL, workspace_save_until = NULL, workspace_save_task_id = NULL
      WHERE session_id = $1 AND workspace_save_id = $2
      RETURNING user_id`,
    [sessionId, saveId],
  );
  const row = r.rows[0] as { user_id: string | null } | undefined;
  return row ? { userId: row.user_id || "default" } : null;
}

/**
 * The sweeper's backstop: release every hold whose save has finished, and drain behind it.
 *
 * @returns how many holds it released.
 */
export async function releaseFinishedWorkspaceSaves(
  drain: (sessionId: string, userId: string) => Promise<void>,
  limit = 50,
): Promise<number> {
  const r = await db.query(
    `UPDATE claw_sessions s SET workspace_save_id = NULL, workspace_save_until = NULL, workspace_save_task_id = NULL
      WHERE s.session_id IN (
        SELECT c.session_id FROM claw_sessions c
         WHERE c.workspace_save_id IS NOT NULL AND c.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM claw_session_events f
              WHERE f.session_id = c.session_id AND f.deleted_at IS NULL AND f.event = $1
                AND f.data->>'phase' = 'finished' AND f.data->>'save_id' = c.workspace_save_id
                AND f.created_at > NOW() - ${WORKSPACE_SAVE_HOLD_INTERVAL_SQL})
         LIMIT $2)
      RETURNING s.session_id, s.user_id`,
    [WORKSPACE_SAVE_EVENT, limit],
  );
  for (const row of r.rows as Array<{ session_id: string; user_id: string | null }>) {
    logger.warn({ sessionId: row.session_id }, "workspace_save.hold_released_by_sweeper");
    await drain(row.session_id, row.user_id || "default").catch((err: unknown) => {
      logger.warn({ err, sessionId: row.session_id }, "workspace_save.sweeper_drain_failed");
    });
  }
  return r.rowCount ?? 0;
}

/**
 * Whether the session's sandbox is in use by a workspace save still under way: true while held.
 *
 * Read by everything that reclaims a sandbox because the run that used it is over. Unreadable is answered as held, the
 * same conservative answer the reclaimers give an unreadable liveness check: a deferred stop is retried on the next
 * sweep, and a stop made in error cuts a save short with nothing left to upload from.
 */
export async function workspaceSaveHoldsSession(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const r = await db.query(
      `SELECT ${workspaceSaveHeldSql()} AS held FROM claw_sessions WHERE session_id = $1`,
      [sessionId],
    );
    return (r.rows[0] as { held?: boolean } | undefined)?.held === true;
  } catch (err) {
    logger.warn({ err, sessionId }, "workspace_save.hold_unreadable");
    return true;
  }
}

/**
 * Whether `taskId` is the run whose save holds its session, and `brainId` the worker holding it: such a run is still
 * saving, so a renewal of its lease is answered as granted rather than refused as terminal.
 */
export async function workspaceSaveHoldsRun(taskId: string, brainId: string | undefined): Promise<boolean> {
  if (!brainId) return false;
  const r = await db.query(
    `SELECT 1 FROM claw_tasks t JOIN claw_sessions s ON s.session_id = t.session_id
      WHERE t.task_id = $1 AND t.lease_owner = $2
        AND s.workspace_save_task_id = t.task_id AND ${workspaceSaveHeldSql("s")}`,
    [taskId, brainId],
  );
  return r.rows.length > 0;
}
