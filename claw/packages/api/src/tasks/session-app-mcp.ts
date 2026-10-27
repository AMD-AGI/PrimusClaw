// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `claw_session_app_mcp`: where a running application's session-level MCP
 * answers (hosting design 5.8). One row per (session, server name); the name is
 * the application's manifest name.
 *
 * The row holds an address and a sandbox session id and nothing that is a
 * credential. The MCP token stays sealed in `claw_app_runs.mcp_token_enc` and is
 * opened only when a turn is dispatched (`sessions/app-mcp.ts`).
 *
 * Writes are fenced like `patchAppRun`: the caller must hold the run's lease now
 * at the epoch it quotes. The row goes when the run ends, by the AppRunner's
 * unregister step, by `patchAppRun` moving the run to `ended`, and, as the last
 * line, by the dispatch read ignoring rows of ended runs.
 */
import { db } from "../infra/db.js";
import type { AppRunFence } from "./app-run-state.js";

export const MCP_URL_MAX = 2048;
export const SANDBOX_SESSION_ID_MAX = 200;

export interface SessionAppMcp {
  session_id: string;
  name: string;
  app_task_id: string;
  url: string;
  sandbox_session_id: string;
}

export type McpWriteOutcome =
  | { ok: true; row?: SessionAppMcp; removed?: number }
  | { ok: false; reason: "not_found" | "not_holder" | "ended" | "no_mcp" };

/** The reason the fence did not pass, read after the write matched nothing. */
async function refusal(taskId: string, fence: AppRunFence): Promise<Exclude<McpWriteOutcome, { ok: true }>> {
  const r = await db.query(
    `SELECT r.state, (r.manifest ? 'mcp') AS has_mcp, t.lease_owner, t.claim_count, (t.lease_expires_at > NOW()) AS lease_live
       FROM claw_app_runs r JOIN claw_tasks t ON t.task_id = r.task_id WHERE r.task_id = $1`,
    [taskId],
  );
  const row = r.rows[0] as { state: string; has_mcp: boolean; lease_owner: string | null; claim_count: number; lease_live: boolean | null } | undefined;
  if (!row) return { ok: false, reason: "not_found" };
  if (row.lease_owner !== fence.brainId || row.lease_live !== true || Number(row.claim_count) !== fence.claimCount) {
    return { ok: false, reason: "not_holder" };
  }
  if (row.state === "ended") return { ok: false, reason: "ended" };
  return { ok: false, reason: "no_mcp" };
}

/** Upsert the run's record. The session and name come from the run row, never from the caller. */
export async function recordSessionAppMcp(
  taskId: string,
  fence: AppRunFence,
  mcp: { url: string; sandbox_session_id: string },
): Promise<McpWriteOutcome> {
  const r = await db.query(
    `INSERT INTO claw_session_app_mcp (session_id, name, app_task_id, url, sandbox_session_id)
     SELECT r.session_id, r.manifest->>'name', r.task_id, $4, $5
       FROM claw_tasks t JOIN claw_app_runs r ON r.task_id = t.task_id
      WHERE t.task_id = $1
        AND t.lease_owner = $2 AND t.lease_expires_at > NOW() AND t.claim_count = $3::int
        AND r.state <> 'ended'
        AND r.manifest ? 'mcp'
        FOR UPDATE OF t
     ON CONFLICT (session_id, name) DO UPDATE
       SET app_task_id = EXCLUDED.app_task_id, url = EXCLUDED.url,
           sandbox_session_id = EXCLUDED.sandbox_session_id, updated_at = NOW()
     RETURNING session_id, name, app_task_id, url, sandbox_session_id`,
    [taskId, fence.brainId, fence.claimCount, mcp.url, mcp.sandbox_session_id],
  );
  if (r.rowCount === 1) return { ok: true, row: r.rows[0] as SessionAppMcp };
  return refusal(taskId, fence);
}

/** Remove this run's record (another run's record of the same name is left alone). */
export async function removeSessionAppMcp(taskId: string, fence: AppRunFence): Promise<McpWriteOutcome> {
  const r = await db.query(
    `WITH held AS (
       SELECT task_id FROM claw_tasks
        WHERE task_id = $1 AND lease_owner = $2 AND lease_expires_at > NOW() AND claim_count = $3::int
          FOR UPDATE
     ), gone AS (
       DELETE FROM claw_session_app_mcp WHERE app_task_id = $1 AND EXISTS (SELECT 1 FROM held)
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM held)::int AS held, (SELECT count(*) FROM gone)::int AS removed`,
    [taskId, fence.brainId, fence.claimCount],
  );
  const row = r.rows[0] as { held: number; removed: number };
  if (row.held === 1) return { ok: true, removed: row.removed };
  return refusal(taskId, fence);
}

/** The run ended: drop its record whoever holds the lease. */
export async function dropSessionAppMcpOfRun(taskId: string): Promise<void> {
  await db.query("DELETE FROM claw_session_app_mcp WHERE app_task_id = $1", [taskId]);
}
