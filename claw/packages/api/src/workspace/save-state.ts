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
import { WORKSPACE_SAVE_EVENT, WORKSPACE_SAVE_STALE_MS } from "@claw/protocol";
import { db, type Querier } from "../infra/db.js";

/** The save in progress: the turn it saves and when it began. */
export interface WorkspaceSaving {
  message_id: string | null;
  since: string;
}

/**
 * The save the session's last `workspaceSave` event says is running, or null.
 *
 * Only the last event counts: a `finished` after a `started` is a save that is
 * over, and a `started` after it is the next turn's. A `started` that never
 * finished stops counting after WORKSPACE_SAVE_STALE_MS, the save of a Brain that
 * died with it.
 */
export async function workspaceSaving(
  sessionId: string,
  now: number = Date.now(),
  q: Querier = db.query,
): Promise<WorkspaceSaving | null> {
  const r = await q(
    `SELECT data->>'phase' AS phase, data->>'message_id' AS message_id, created_at
       FROM claw_session_events
      WHERE session_id = $1 AND deleted_at IS NULL AND event = $2
      ORDER BY id DESC
      LIMIT 1`,
    [sessionId, WORKSPACE_SAVE_EVENT],
  );
  const row = r.rows[0] as { phase: string | null; message_id: string | null; created_at: Date | string } | undefined;
  if (!row || row.phase !== "started") return null;
  const since = new Date(row.created_at);
  if (!(now - since.getTime() < WORKSPACE_SAVE_STALE_MS)) return null;
  return { message_id: row.message_id, since: since.toISOString() };
}
