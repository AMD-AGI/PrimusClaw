// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a session's last end-of-turn workspace save is still under way.
 *
 * A turn ends on the session before Brain uploads its `/workspace`, so the files
 * listed from the object store can trail an idle session -- by an hour, for a
 * turn that cloned a large repository. The listing says so rather than passing
 * a half-uploaded tree off as the session's files: see `WORKSPACE_SAVE_EVENT`.
 */
import {
  WORKSPACE_SAVE_EVENT, WORKSPACE_SAVE_PENDING, WORKSPACE_SAVE_PENDING_FIELD, WORKSPACE_SAVE_STALE_MS,
} from "@claw/protocol";
import { db, type Querier } from "../infra/db.js";

/** The save in progress: the turn it saves and when that turn ended. */
export interface WorkspaceSaving {
  message_id: string | null;
  since: string;
}

/**
 * The save the session's last turn left running, or null.
 *
 * Read off the session's last `exec_complete`, which says whether a save follows
 * it: that row is stored before the session is set idle, so an idle session
 * whose save has not finished always finds it. The save is over once a
 * `workspaceSave` `finished` names the same turn, wherever that row landed --
 * the two are published one after the other but may be stored by different
 * replicas, so their order in the table is not evidence. A later turn's
 * completion also ends it: that turn ran only once this save let go of the
 * workspace. And a mark older than WORKSPACE_SAVE_STALE_MS is a save whose Brain
 * died with it.
 */
export async function workspaceSaving(
  sessionId: string,
  now: number = Date.now(),
  q: Querier = db.query,
): Promise<WorkspaceSaving | null> {
  const r = await q(
    `WITH last AS (
       SELECT data, created_at
         FROM claw_session_events
        WHERE session_id = $1 AND deleted_at IS NULL AND event = 'exec_complete'
        ORDER BY id DESC
        LIMIT 1
     )
     SELECT last.data->>'message_id' AS message_id, last.created_at
       FROM last
      WHERE last.data->>$3 = $4
        AND NOT EXISTS (
          SELECT 1 FROM claw_session_events f
           WHERE f.session_id = $1 AND f.deleted_at IS NULL AND f.event = $2
             AND f.data->>'phase' = 'finished'
             AND f.data->>'message_id' IS NOT DISTINCT FROM last.data->>'message_id'
             -- Bounds the read to the session's recent rows (idx_events_session_recent),
             -- with room for the two having been stored out of order.
             AND f.created_at >= last.created_at - INTERVAL '10 minutes'
        )`,
    [sessionId, WORKSPACE_SAVE_EVENT, WORKSPACE_SAVE_PENDING_FIELD, WORKSPACE_SAVE_PENDING],
  );
  const row = r.rows[0] as { message_id: string | null; created_at: Date | string } | undefined;
  if (!row) return null;
  const since = new Date(row.created_at);
  if (!(now - since.getTime() < WORKSPACE_SAVE_STALE_MS)) return null;
  return { message_id: row.message_id, since: since.toISOString() };
}
