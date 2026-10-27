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
 *
 * A run starting on an archived session reactivates it in the run-gate take
 * (applySessionGateTransition in tasks/chat-run.ts), so every entry point does.
 */
import pino from "pino";

import { db } from "../infra/db.js";

const logger = pino({ name: "session-archive" });

type Queryable = Pick<typeof db, "query">;

/** True for a session no run is in flight on, itself or in a team member. */
const NO_RUN_IN_FLIGHT = `
  s.agent_status IS DISTINCT FROM 'running'
  AND NOT EXISTS (
    SELECT 1 FROM claw_sessions c
     WHERE c.parent_session_id = s.session_id
       AND c.deleted_at IS NULL
       AND c.agent_status = 'running'
  )`;

/**
 * Archive the sessions that have been idle for `days` days.
 *
 * Only `active` sessions, never one with a run in flight (`agent_status =
 * 'running'`), never a parent whose team members are still running, and never
 * a session made through the Anthropic-compatible API: for those `archived`
 * already means `terminated` and hides the session from that API's list, which
 * an automatic sweep must not do to a client that never asked for it.
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
        AND NOT COALESCE(s.config ? 'primus_anthropic_compat', false)
        AND s.updated_at < NOW() - ($1::int * INTERVAL '1 day')
        AND ${NO_RUN_IN_FLIGHT}`,
    [days],
  );
  const archived = r.rowCount ?? 0;
  if (archived > 0) logger.info({ archived, days }, "session_archive.idle_archived");
  return archived;
}

export type ArchiveResult = "ok" | "running" | "not_found";

/** Owner-requested archive. Refused while a run is in flight (here or in a team member); idempotent otherwise. */
export async function archiveSession(sessionId: string, q: Queryable = db): Promise<ArchiveResult> {
  const r = await q.query(
    `UPDATE claw_sessions s SET status = 'archived'
      WHERE s.session_id = $1 AND s.deleted_at IS NULL
        AND ${NO_RUN_IN_FLIGHT}`,
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
