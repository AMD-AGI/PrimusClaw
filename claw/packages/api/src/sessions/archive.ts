// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Archiving a session: the reversible way to take it out of the default list.
 *
 * It reuses `claw_sessions.status` (`active` | `archived`) and changes nothing
 * else, so an archived session can still be read, opened and continued. The
 * activity clock is `updated_at`, which every run-gate transition and rename
 * already bumps; archiving leaves it alone and unarchiving resets it, so a
 * session someone just brought back is not swept again the next day.
 */
import pino from "pino";

import { db } from "../infra/db.js";

const logger = pino({ name: "session-archive" });

type Queryable = Pick<typeof db, "query">;

/**
 * Archive the sessions that have been idle for `days` days.
 *
 * Only `active` sessions, never one with a run in flight (`agent_status =
 * 'running'`), and never a parent whose team members are still running.
 *
 * @returns how many sessions were archived
 */
export async function archiveIdleSessions(days: number, q: Queryable = db): Promise<number> {
  if (!(days > 0)) return 0;
  const r = await q.query(
    `UPDATE claw_sessions s
        SET status = 'archived'
      WHERE s.deleted_at IS NULL
        AND COALESCE(s.status, 'active') = 'active'
        AND s.agent_status IS DISTINCT FROM 'running'
        AND s.updated_at < NOW() - ($1::int * INTERVAL '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM claw_sessions c
           WHERE c.parent_session_id = s.session_id
             AND c.deleted_at IS NULL
             AND c.agent_status = 'running'
        )`,
    [days],
  );
  const archived = r.rowCount ?? 0;
  if (archived > 0) logger.info({ archived, days }, "session_archive.idle_archived");
  return archived;
}

export type ArchiveResult = "ok" | "running" | "not_found";

/** Owner-requested archive. Refused while a run is in flight; idempotent otherwise. */
export async function archiveSession(sessionId: string, q: Queryable = db): Promise<ArchiveResult> {
  const r = await q.query(
    `UPDATE claw_sessions SET status = 'archived'
      WHERE session_id = $1 AND deleted_at IS NULL
        AND agent_status IS DISTINCT FROM 'running'`,
    [sessionId],
  );
  if ((r.rowCount ?? 0) > 0) return "ok";
  const row = (await q.query(
    "SELECT agent_status FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
    [sessionId],
  )).rows[0];
  if (!row) return "not_found";
  return "running";
}

/** Make a session active again and restart its idle clock. */
export async function unarchiveSession(sessionId: string, q: Queryable = db): Promise<boolean> {
  const r = await q.query(
    `UPDATE claw_sessions SET status = 'active', updated_at = NOW()
      WHERE session_id = $1 AND deleted_at IS NULL`,
    [sessionId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * A message is activity: an archived session it lands on becomes active again.
 * Runs on the sender's transaction connection, after the owner check.
 */
export async function reactivateIfArchived(sessionId: string, q: Queryable): Promise<void> {
  await q.query(
    "UPDATE claw_sessions SET status = 'active' WHERE session_id = $1 AND status = 'archived'",
    [sessionId],
  );
}
