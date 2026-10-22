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
 *  - A write is fenced. It lands only if the caller is the run's lease holder
 *    (or nobody holds it), so a Brain that lost the run and has not noticed yet
 *    cannot move the state of a run another Brain now drives; and an optional
 *    `expectState` makes a transition compare-and-set.
 *  - `ended` is final. Nothing moves a run out of it.
 *
 * The plaintext of the run's secrets is read here and handed to the caller
 * (`readAppRunSecrets`) and is also what `last_exit` is scrubbed of before it
 * is stored, so a value the application printed into its own exit record cannot
 * end up in the database.
 */
import { db } from "../infra/db.js";
import { openAppRunSecret } from "../crypto/app-run-secrets.js";

export const APP_RUN_STATES = [
  "provisioning", "starting", "running", "restarting", "finishing", "ended",
] as const;
export type AppRunState = (typeof APP_RUN_STATES)[number];

/** Largest `last_exit` document stored, serialised. */
export const LAST_EXIT_MAX_BYTES = 4096;

export interface AppRunView {
  run_id: string;
  session_id: string;
  state: AppRunState;
  restarts: number;
  last_exit: Record<string, unknown> | null;
  state_dir: string | null;
  sandbox_workload_id: string | null;
  manifest: Record<string, unknown>;
  grant_id: string | null;
  grant_limits: Record<string, unknown> | null;
  created_at: string;
  /** From the task row: what the run was asked to do and where. */
  input: Record<string, unknown>;
  sandbox_spec: Record<string, unknown> | null;
  workspace_id: string | null;
}

interface RunRow {
  task_id: string;
  session_id: string;
  state: AppRunState;
  restarts: number;
  last_exit: Record<string, unknown> | null;
  state_dir: string | null;
  sandbox_workload_id: string | null;
  manifest: Record<string, unknown>;
  grant_id: string | null;
  grant_limits: Record<string, unknown> | null;
  created_at: Date;
  input: Record<string, unknown>;
  sandbox_spec: Record<string, unknown> | null;
  workspace_id: string | null;
}

const VIEW_SQL = `
  SELECT r.task_id, r.session_id, r.state, r.restarts, r.last_exit, r.state_dir,
         r.sandbox_workload_id, r.manifest, r.grant_id, r.grant_limits, r.created_at,
         t.input, t.sandbox_spec, t.workspace_id
    FROM claw_app_runs r JOIN claw_tasks t ON t.task_id = r.task_id`;

function toView(row: RunRow): AppRunView {
  return {
    run_id: row.task_id,
    session_id: row.session_id,
    state: row.state,
    restarts: Number(row.restarts),
    last_exit: row.last_exit,
    state_dir: row.state_dir,
    sandbox_workload_id: row.sandbox_workload_id,
    manifest: row.manifest,
    grant_id: row.grant_id,
    grant_limits: row.grant_limits,
    created_at: row.created_at.toISOString(),
    input: row.input ?? {},
    sandbox_spec: row.sandbox_spec,
    workspace_id: row.workspace_id,
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
  state_dir?: string;
  sandbox_workload_id?: string | null;
}

export type PatchOutcome =
  | { ok: true; run: AppRunView }
  | { ok: false; reason: "not_found" | "not_holder" | "state_mismatch" | "ended" | "empty"; current?: AppRunState };

/**
 * Replace every occurrence of a secret's plaintext in `value`, which is
 * serialised, scrubbed and read back, so it works at any depth. Secrets
 * shorter than eight characters are not hunted: they would shred ordinary text
 * and a real token is far longer.
 */
export function scrubSecrets<T>(value: T, secrets: string[]): T {
  let text = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    // JSON-escaped form too: a secret with a quote or backslash does not appear
    // verbatim inside a serialised string.
    const escaped = JSON.stringify(secret).slice(1, -1);
    text = text.split(secret).join("[redacted]");
    if (escaped !== secret) text = text.split(escaped).join("[redacted]");
  }
  return JSON.parse(text) as T;
}

async function secretValues(taskId: string): Promise<string[]> {
  const secrets = await readAppRunSecrets(taskId);
  if (!secrets) return [];
  return [secrets.mcp_token, ...Object.values(secrets.grant_keys ?? {})];
}

/**
 * Apply `patch` as `brainId`.
 *
 * One conditional UPDATE does the fencing, the compare-and-set and the
 * `ended` rule together, so there is no window between checking and writing.
 * When it matches nothing, a second read says which rule refused, for the
 * caller's benefit only: the decision was already made by the UPDATE.
 */
export async function patchAppRun(
  taskId: string,
  brainId: string,
  patch: AppRunPatch,
  expectState?: AppRunState,
): Promise<PatchOutcome> {
  const sets: string[] = [];
  const params: unknown[] = [taskId, brainId, expectState ?? null];
  const add = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (patch.state !== undefined) add("state", patch.state);
  if (patch.restarts !== undefined) add("restarts", patch.restarts);
  if (patch.state_dir !== undefined) add("state_dir", patch.state_dir);
  if (patch.sandbox_workload_id !== undefined) add("sandbox_workload_id", patch.sandbox_workload_id);
  if (patch.last_exit !== undefined) {
    const scrubbed = patch.last_exit === null
      ? null
      : scrubSecrets(patch.last_exit, await secretValues(taskId));
    add("last_exit", scrubbed === null ? null : JSON.stringify(scrubbed), "::jsonb");
  }
  if (sets.length === 0) return { ok: false, reason: "empty" };
  sets.push("updated_at = NOW()");

  const updated = await db.query(
    `UPDATE claw_app_runs r SET ${sets.join(", ")}
       FROM claw_tasks t
      WHERE r.task_id = $1 AND t.task_id = r.task_id
        AND (t.lease_owner = $2 OR t.lease_owner IS NULL)
        AND r.state <> 'ended'
        AND ($3::text IS NULL OR r.state = $3)
      RETURNING r.task_id`,
    params,
  );
  if (updated.rowCount === 1) {
    const run = await readAppRun(taskId);
    return run ? { ok: true, run } : { ok: false, reason: "not_found" };
  }
  const why = await db.query(
    `SELECT r.state, t.lease_owner FROM claw_app_runs r JOIN claw_tasks t ON t.task_id = r.task_id
      WHERE r.task_id = $1`,
    [taskId],
  );
  const row = why.rows[0] as { state: AppRunState; lease_owner: string | null } | undefined;
  if (!row) return { ok: false, reason: "not_found" };
  if (row.lease_owner !== null && row.lease_owner !== brainId) return { ok: false, reason: "not_holder", current: row.state };
  if (row.state === "ended") return { ok: false, reason: "ended", current: row.state };
  return { ok: false, reason: "state_mismatch", current: row.state };
}
