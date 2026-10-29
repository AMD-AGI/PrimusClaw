// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What Brain's AppRunner reads and writes of a run: the `claw_app_runs` row.
 *
 * Brain has no database. The AppRunner keeps its working state in this row so
 * that a Brain which takes the run over after a failure reads where the run
 * had got to and carries on (hosting design 5.3.2); everything it persists
 * goes through `patchAppRun`.
 *
 * Two rules live here rather than in the route, because they are about the
 * data and not about HTTP:
 *
 *  - A write is fenced. It lands only if the caller holds the run's lease NOW:
 *    `lease_owner` is the caller, the lease has not expired, and the row's
 *    `claim_count` is the epoch the caller was given when it took the run. The
 *    epoch is quoted by the caller, never read from the row, so a Brain that lost
 *    the run (even to a second attempt of its own pod) and has not noticed yet
 *    cannot move the state of a run another attempt now drives. A released lease
 *    (no owner) lets nobody write. An optional `expectState` makes a transition
 *    compare-and-set, and `restarts` can only move forward.
 *  - `ended` is final. Nothing moves a run out of it.
 *
 * The plaintext of the run's secrets is read here and handed to the caller
 * (`readAppRunSecrets`) and is also what `last_exit` is scrubbed of before it
 * is stored, so a value the application printed into its own exit record cannot
 * end up in the database.
 */
import { APP_RUN_STATES, scrubSecrets, type AppRunState } from "@claw/protocol";
import pino from "pino";
import { db } from "../infra/db.js";
import { openAppRunSecret, sealAppRunSecret } from "../crypto/app-run-secrets.js";
import { dropSessionAppMcpOfRun } from "./session-app-mcp.js";

const logger = pino({ name: "app-run-state" });

export { APP_RUN_STATES, type AppRunState };

/** Largest `last_exit` document stored, serialised. */
export const LAST_EXIT_MAX_BYTES = 4096;

export interface AppRunView {
  run_id: string;
  session_id: string;
  state: AppRunState;
  restarts: number;
  last_exit: Record<string, unknown> | null;
  /** Where event forwarding stopped (5.7); `{}` before the first event. */
  events_cursor: Record<string, unknown>;
  state_dir: string | null;
  sandbox_workload_id: string | null;
  manifest: Record<string, unknown>;
  grant_id: string | null;
  grant_limits: Record<string, unknown> | null;
  grant_templates: Record<string, Record<string, string>> | null;
  /** ISO time the grant lapses, when one was issued with an expiry. */
  grant_expires_at: string | null;
  /** ISO time the grant was revoked; set means it must not be extended. */
  grant_revoked_at: string | null;
  created_at: string;
  /** From the task row: what the run was asked to do and where. */
  input: Record<string, unknown>;
  sandbox_spec: Record<string, unknown> | null;
  workspace_id: string | null;
  /** The user the grant is signed for (`claw_app_runs.created_by`). */
  user_id: string | null;
}

interface RunRow {
  task_id: string;
  session_id: string;
  state: AppRunState;
  restarts: number;
  last_exit: Record<string, unknown> | null;
  events_cursor: Record<string, unknown> | null;
  state_dir: string | null;
  sandbox_workload_id: string | null;
  manifest: Record<string, unknown>;
  grant_id: string | null;
  grant_limits: Record<string, unknown> | null;
  grant_templates: Record<string, Record<string, string>> | null;
  grant_expires_at: Date | null;
  grant_revoked_at: Date | null;
  created_at: Date;
  input: Record<string, unknown>;
  sandbox_spec: Record<string, unknown> | null;
  workspace_id: string | null;
  created_by: string | null;
}

const VIEW_SQL = `
  SELECT r.task_id, r.session_id, r.state, r.restarts, r.last_exit, r.events_cursor, r.state_dir,
         r.sandbox_workload_id, r.manifest, r.grant_id, r.grant_limits, r.grant_templates, r.grant_expires_at, r.grant_revoked_at, r.created_at,
         r.created_by, t.input, t.sandbox_spec, t.workspace_id
    FROM claw_app_runs r JOIN claw_tasks t ON t.task_id = r.task_id`;

function toView(row: RunRow): AppRunView {
  return {
    run_id: row.task_id,
    session_id: row.session_id,
    state: row.state,
    restarts: Number(row.restarts),
    last_exit: row.last_exit,
    events_cursor: row.events_cursor ?? {},
    state_dir: row.state_dir,
    sandbox_workload_id: row.sandbox_workload_id,
    manifest: row.manifest,
    grant_id: row.grant_id,
    grant_limits: row.grant_limits,
    grant_templates: row.grant_templates ?? null,
    grant_expires_at: row.grant_expires_at ? row.grant_expires_at.toISOString() : null,
    grant_revoked_at: row.grant_revoked_at ? row.grant_revoked_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    input: row.input ?? {},
    sandbox_spec: row.sandbox_spec,
    workspace_id: row.workspace_id,
    user_id: row.created_by,
  };
}

export async function readAppRun(taskId: string): Promise<AppRunView | null> {
  const r = await db.query(`${VIEW_SQL} WHERE r.task_id = $1`, [taskId]);
  return r.rows[0] ? toView(r.rows[0] as RunRow) : null;
}

export interface AppRunSecrets {
  mcp_token: string;
  /** The grant's keys by role, when a grant was issued. */
  grant_keys: Record<string, string> | null;
}

export async function readAppRunSecrets(taskId: string): Promise<AppRunSecrets | null> {
  const r = await db.query(
    "SELECT mcp_token_enc, grant_keys_enc FROM claw_app_runs WHERE task_id = $1",
    [taskId],
  );
  const row = r.rows[0] as { mcp_token_enc: string; grant_keys_enc: string | null } | undefined;
  if (!row) return null;
  return {
    mcp_token: openAppRunSecret(row.mcp_token_enc, taskId, "mcp_token"),
    grant_keys: row.grant_keys_enc
      ? JSON.parse(openAppRunSecret(row.grant_keys_enc, taskId, "grant_keys")) as Record<string, string>
      : null,
  };
}

/** The fields Brain may change. Absent means unchanged; null clears where the column allows it. */
export interface AppRunPatch {
  state?: AppRunState;
  restarts?: number;
  last_exit?: Record<string, unknown> | null;
  /** Event forwarding's cursor (5.7): replaced as a whole. */
  events_cursor?: Record<string, unknown>;
  state_dir?: string;
  sandbox_workload_id?: string | null;
  /**
   * ISO time; written when the grant hook extends the grant (never cleared here).
   * Only a later time than the stored one, only for a grant that exists, has an
   * expiry and is not revoked: the rule is enforced here, not left to the caller.
   */
  grant_expires_at?: string;
  /** Record that the grant was revoked (stamps `grant_revoked_at` once). Only for a run that has a grant. */
  grant_revoked?: true;
  /** Replacement keys after the same grant id is signed again. Sealed before they are stored. */
  grant_keys?: Record<string, string>;
}

export type PatchOutcome =
  | { ok: true; run: AppRunView }
  | { ok: false; reason: "not_found" | "not_holder" | "state_mismatch" | "ended" | "empty" | "grant_refused"; current?: AppRunState };

async function secretValues(taskId: string): Promise<string[]> {
  const secrets = await readAppRunSecrets(taskId);
  if (!secrets) return [];
  return [secrets.mcp_token, ...Object.values(secrets.grant_keys ?? {})];
}

/** Who is writing: the lease holder and the epoch (`claw_tasks.claim_count`) it was given when it took the run. */
export interface AppRunFence {
  brainId: string;
  claimCount: number;
}

/** Whether this caller holds the run now. A finished run is not signed again. */
export async function appRunHeldBy(taskId: string, fence: AppRunFence): Promise<"ok" | "not_found" | "not_holder" | "ended"> {
  const why = await db.query(
    `SELECT r.state, t.lease_owner, t.claim_count, (t.lease_expires_at > NOW()) AS lease_live
       FROM claw_app_runs r JOIN claw_tasks t ON t.task_id = r.task_id
      WHERE r.task_id = $1`,
    [taskId],
  );
  const row = why.rows[0] as { state: AppRunState; lease_owner: string | null; claim_count: number; lease_live: boolean | null } | undefined;
  if (!row) return "not_found";
  if (row.lease_owner !== fence.brainId || row.lease_live !== true || Number(row.claim_count) !== fence.claimCount) return "not_holder";
  if (row.state === "ended" || row.state === "finishing") return "ended";
  return "ok";
}

/** The `last_exit` fields that carry free text, the only ones a secret can ride in. */
const LAST_EXIT_TEXT_FIELDS = ["stop_reason", "error"] as const;

/**
 * `last_exit` with secrets removed. The secrets are opened only when there is text
 * to scrub, and a failure to open them does not block the write: the free-text
 * fields are dropped instead (a value that cannot be checked is not stored) and the
 * fact is logged. A state move that cannot be made because a key will not open
 * would leave the run stuck.
 */
async function scrubbedLastExit(taskId: string, lastExit: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!LAST_EXIT_TEXT_FIELDS.some((f) => typeof lastExit[f] === "string")) return lastExit;
  try {
    return scrubSecrets(lastExit, await secretValues(taskId));
  } catch (err) {
    logger.error({ taskId, errorClass: (err as Error)?.constructor?.name }, "app_run.last_exit_scrub_unavailable");
    const kept = { ...lastExit };
    for (const f of LAST_EXIT_TEXT_FIELDS) delete kept[f];
    return kept;
  }
}

/**
 * Apply `patch` as `fence.brainId` at epoch `fence.claimCount`.
 *
 * One conditional UPDATE does the fencing, the compare-and-set, the `ended` rule
 * and the monotonic `restarts` together, and returns the new row, so there is no
 * window between checking and writing and no second read. When it matches
 * nothing, a read says which rule refused, for the caller's benefit only: the
 * decision was already made by the UPDATE.
 */
export async function patchAppRun(
  taskId: string,
  fence: AppRunFence,
  patch: AppRunPatch,
  expectState?: AppRunState,
): Promise<PatchOutcome> {
  const sets: string[] = [];
  const params: unknown[] = [taskId, fence.brainId, expectState ?? null, fence.claimCount, patch.restarts ?? null];
  const add = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (patch.state !== undefined) add("state", patch.state);
  if (patch.restarts !== undefined) add("restarts", patch.restarts);
  if (patch.events_cursor !== undefined) add("events_cursor", JSON.stringify(patch.events_cursor), "::jsonb");
  if (patch.state_dir !== undefined) add("state_dir", patch.state_dir);
  if (patch.sandbox_workload_id !== undefined) add("sandbox_workload_id", patch.sandbox_workload_id);
  let grantExpiryParam = "NULL";
  if (patch.grant_expires_at !== undefined) {
    add("grant_expires_at", patch.grant_expires_at, "::timestamptz");
    grantExpiryParam = `$${params.length}::timestamptz`;
  }
  if (patch.grant_revoked === true) sets.push("grant_revoked_at = COALESCE(r.grant_revoked_at, NOW())");
  if (patch.grant_keys !== undefined) {
    add("grant_keys_enc", sealAppRunSecret(JSON.stringify(patch.grant_keys), taskId, "grant_keys"));
  }
  if (patch.last_exit !== undefined) {
    const scrubbed = patch.last_exit === null ? null : await scrubbedLastExit(taskId, patch.last_exit);
    add("last_exit", scrubbed === null ? null : JSON.stringify(scrubbed), "::jsonb");
  }
  if (sets.length === 0) return { ok: false, reason: "empty" };
  sets.push("updated_at = NOW()");

  // The task row is locked FIRST (`FOR UPDATE` in the CTE) and its lease is checked
  // after the lock is held: a takeover that commits a new claim while this write
  // waits is seen, because Postgres re-evaluates the locked row's condition once the
  // lock is granted. Checking the lease through a plain join would test a snapshot
  // from before the wait, and a stale holder could still write.
  const updated = await db.query(
    `WITH t AS (
       SELECT task_id, input, sandbox_spec, workspace_id
         FROM claw_tasks
        WHERE task_id = $1
          AND lease_owner = $2
          AND lease_expires_at > NOW()
          AND claim_count = $4::int
          FOR UPDATE
     )
     UPDATE claw_app_runs r SET ${sets.join(", ")}
       FROM t
      WHERE r.task_id = t.task_id
        AND r.state <> 'ended'
        AND ($3::text IS NULL OR r.state = $3)
        AND ($5::int IS NULL OR $5::int >= r.restarts)
        -- A grant's expiry only moves later, and only while the grant exists, has an
        -- expiry and is not revoked; a revoke is recorded only for a run that has a grant.
        AND (${grantExpiryParam} IS NULL OR (
              r.grant_id IS NOT NULL AND r.grant_revoked_at IS NULL
              AND r.grant_expires_at IS NOT NULL AND r.grant_expires_at < ${grantExpiryParam}))
        AND (${patch.grant_revoked === true ? "r.grant_id IS NOT NULL" : "TRUE"})
        AND (${patch.grant_keys !== undefined ? "r.grant_id IS NOT NULL" : "TRUE"})
      RETURNING r.task_id, r.session_id, r.state, r.restarts, r.last_exit, r.events_cursor, r.state_dir,
                r.sandbox_workload_id, r.manifest, r.grant_id, r.grant_limits, r.grant_templates, r.grant_expires_at, r.grant_revoked_at, r.created_at,
                r.created_by, t.input, t.sandbox_spec, t.workspace_id`,
    params,
  );
  if (updated.rowCount === 1) {
    // The session's MCP of an ended run is gone with it, whoever ended it.
    // Best effort: the state change has committed, so a failed delete must not turn
    // the answer into a 500 for a write that landed. A record left behind is never
    // served (the dispatch and claim reads ignore ended runs) and holds no token.
    if (patch.state === "ended") {
      await dropSessionAppMcpOfRun(taskId).catch((err: unknown) => {
        logger.warn({ taskId, code: (err as { code?: string })?.code ?? "" }, "app_run.session_mcp_drop_failed");
      });
    }
    return { ok: true, run: toView(updated.rows[0] as RunRow) };
  }
  const why = await db.query(
    `SELECT r.state, r.restarts, t.lease_owner, t.claim_count,
            (t.lease_expires_at > NOW()) AS lease_live
       FROM claw_app_runs r JOIN claw_tasks t ON t.task_id = r.task_id
      WHERE r.task_id = $1`,
    [taskId],
  );
  const row = why.rows[0] as
    { state: AppRunState; restarts: number; lease_owner: string | null; claim_count: number; lease_live: boolean | null } | undefined;
  if (!row) return { ok: false, reason: "not_found" };
  if (row.lease_owner !== fence.brainId || row.lease_live !== true || Number(row.claim_count) !== fence.claimCount) {
    return { ok: false, reason: "not_holder", current: row.state };
  }
  if (row.state === "ended") return { ok: false, reason: "ended", current: row.state };
  if (patch.grant_expires_at !== undefined || patch.grant_revoked === true || patch.grant_keys !== undefined) {
    // Not the state (a state mismatch would have been the same query): the grant rule refused it.
    const g = await db.query("SELECT grant_id, grant_revoked_at, grant_expires_at FROM claw_app_runs WHERE task_id = $1", [taskId]);
    const grant = g.rows[0] as { grant_id: string | null; grant_revoked_at: Date | null; grant_expires_at: Date | null } | undefined;
    const stateOk = expectState === undefined || expectState === row.state;
    if (stateOk && grant) return { ok: false, reason: "grant_refused", current: row.state };
  }
  return { ok: false, reason: "state_mismatch", current: row.state };
}
