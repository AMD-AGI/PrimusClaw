// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a caller reads about an app run (`mode: "app"`) beside the task's own
 * fields: the state of the run's sandbox, and, once the run has ended, how it
 * ended, as stable fields.
 *
 * Both are read from the run's `claw_app_runs` row, which the Brain driving the
 * run writes at every move it makes (see brain `apps/app-runner.ts`), so they say
 * what the run is doing rather than what the task row was told when it started.
 * The task row reads `running` from the moment a Brain accepts the run, while its
 * sandbox may still be queued for capacity or pulling a large image; and the
 * task's `failure_reason` is prose for a person, whose wording may change.
 *
 * The answer is `app` on `GET /v1/tasks/:id` and on every run of `GET /v1/runs`:
 *
 *   {
 *     "sandbox": { "state": "pending" | "running" | "ended", "workload_id": string, "since": ISO time | null },
 *     "outcome": null | { "cause": AppRunCause, "returncode": int | null, "final": bool, "error": string | null }
 *   }
 */
import { redactSecrets } from "@claw/utils";
import { db } from "../infra/db.js";

/** The sandbox's state as {@link AppRunStatus.sandbox} reports it. */
export const APP_SANDBOX_STATES = ["pending", "running", "ended"] as const;
export type AppSandboxState = typeof APP_SANDBOX_STATES[number];

/**
 * Why an app run ended. A closed list: a value outside it is never sent. See
 * `docs/run-api.md` ("App runs") for what each one means.
 */
export const APP_RUN_CAUSES = [
  "exited",
  "restarts_exhausted",
  "start_failed",
  "deadline",
  "cancelled",
  "task_closed",
  "no_exit_record",
  "sandbox_rejected",
  "sandbox_create_failed",
  "sandbox_unschedulable",
  "sandbox_start_timeout",
  "sandbox_failed",
] as const;
export type AppRunCause = typeof APP_RUN_CAUSES[number];

/** The longest `error` sent, in characters. */
export const APP_RUN_ERROR_MAX = 300;

export interface AppRunOutcomeView {
  cause: AppRunCause;
  /** The application's return code from `exit.json`; null when it wrote none or the run ended another way. */
  returncode: number | null;
  /** `exit.json` `final`: the application said it was done. False for every other ending. */
  final: boolean;
  /**
   * The application's own `exit.json` `error`, or, for a `sandbox_*` cause, what the
   * platform said about the sandbox it did not provide. Secrets masked, one line, at
   * most {@link APP_RUN_ERROR_MAX} characters; null when there is nothing.
   */
  error: string | null;
}

export interface AppRunStatus {
  sandbox: {
    state: AppSandboxState;
    /** The run's current (or, once ended, last) sandbox workload; `""` before one was created. */
    workload_id: string;
    /** When the sandbox entered `state`; null for a run created before this was recorded. */
    since: string | null;
  };
  /** How the run ended; null until it has. */
  outcome: AppRunOutcomeView | null;
}

/**
 * The sandbox state a run's state means, as SQL over the run's next `state`
 * (`next`, a SQL expression) and its row as it was (`r`).
 *
 *   provisioning                    -> pending (no sandbox yet, or one not yet Running)
 *   starting, running, restarting   -> running (the Brain saw the sandbox Running)
 *   finishing                       -> what it was: a run cancelled while its sandbox
 *                                      was queued never had one running
 *   ended                           -> ended (the finish stopped the sandbox)
 *
 * The move out of provisioning is made exactly when the Brain's sandbox `ensure`
 * returns, which is when SaFE reports the workload Running.
 */
export function sandboxStateSql(next: string): string {
  return `(CASE ${next}
             WHEN 'provisioning' THEN 'pending'
             WHEN 'ended' THEN 'ended'
             WHEN 'finishing' THEN COALESCE(r.sandbox_state, ${LEGACY_SANDBOX_STATE_SQL})
             ELSE 'running' END)`;
}

/** For a row written before `sandbox_state` was: what its run state says. */
const LEGACY_SANDBOX_STATE_SQL = "(CASE r.state WHEN 'provisioning' THEN 'pending' WHEN 'ended' THEN 'ended' ELSE 'running' END)";

function sandboxStateOf(stored: string | null, runState: string): AppSandboxState {
  if (stored === "pending" || stored === "running" || stored === "ended") return stored;
  return runState === "provisioning" ? "pending" : runState === "ended" ? "ended" : "running";
}

/** The provisioning codes (brain `sandbox/errors.ts`) a sandbox the platform did not provide is reported under. */
const SANDBOX_CAUSE_OF: Readonly<Record<string, AppRunCause>> = {
  sandbox_rejected: "sandbox_rejected",
  sandbox_workspace_forbidden: "sandbox_rejected",
  sandbox_workspace_not_allowed: "sandbox_rejected",
  sandbox_placement_invalid: "sandbox_rejected",
  sandbox_create_failed: "sandbox_create_failed",
  sandbox_unschedulable: "sandbox_unschedulable",
  sandbox_pending_timeout: "sandbox_unschedulable",
  sandbox_start_timeout: "sandbox_start_timeout",
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/**
 * `cause` from the run's `last_exit` (brain `AppLastExit`) as the run ended.
 *
 * `sandbox_reason` is set by the Brain while the run has no sandbox because the
 * platform did not provide one (refused the create, never scheduled it, ...),
 * and cleared once a sandbox is running. A run that ended on its restart budget
 * with that set ended because it never got a sandbox, and says which way; one
 * that reached its deadline while every create was failing says
 * `sandbox_create_failed`, as a task run does.
 */
export function appRunCauseOf(lastExit: Record<string, unknown> | null): AppRunCause {
  if (!lastExit) return "no_exit_record";
  const sandboxReason = str(lastExit.sandbox_reason);
  switch (lastExit.cause) {
    case "exit": return "exited";
    case "cancelled": return "cancelled";
    case "row_terminal": return "task_closed";
    case "start_failed": return "start_failed";
    case "deadline": return sandboxReason === "sandbox_create_failed" ? "sandbox_create_failed" : "deadline";
    case "restarts_exhausted":
    case "sandbox_lost":
      if (sandboxReason) return SANDBOX_CAUSE_OF[sandboxReason] ?? "sandbox_failed";
      return "restarts_exhausted";
    default: return "no_exit_record";
  }
}

/** Masked, on one line, then cut: masking first, so a cut never leaves part of a secret behind. */
export function appRunErrorText(raw: unknown): string | null {
  const text = str(raw);
  if (text === null) return null;
  const masked = redactSecrets(text).text.replace(/(Bearer\s+)[^\s"',;]+/gi, "$1<redacted>");
  // eslint-disable-next-line no-control-regex
  const line = masked.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > APP_RUN_ERROR_MAX ? `${line.slice(0, APP_RUN_ERROR_MAX - 1)}…` : line;
}

/** The outcome of an ended run; null while it is not ended. */
export function appRunOutcomeOf(state: string, lastExit: Record<string, unknown> | null): AppRunOutcomeView | null {
  if (state !== "ended") return null;
  const cause = appRunCauseOf(lastExit);
  const rc = lastExit?.returncode;
  return {
    cause,
    returncode: typeof rc === "number" && Number.isInteger(rc) ? rc : null,
    final: lastExit?.final === true,
    error: appRunErrorText(cause.startsWith("sandbox_") ? lastExit?.sandbox_message : lastExit?.error),
  };
}

interface StatusRow {
  task_id: string;
  state: string;
  last_exit: Record<string, unknown> | null;
  sandbox_workload_id: string | null;
  sandbox_state: string | null;
  sandbox_since: Date | string | null;
}

export function appRunStatusOf(row: StatusRow): AppRunStatus {
  const since = row.sandbox_since instanceof Date ? row.sandbox_since.toISOString() : row.sandbox_since ?? null;
  return {
    sandbox: {
      state: sandboxStateOf(row.sandbox_state, row.state),
      workload_id: row.sandbox_workload_id ?? "",
      since,
    },
    outcome: appRunOutcomeOf(row.state, row.last_exit),
  };
}

/**
 * The status of each of `taskIds` that is an app run, by task id. Asks nothing when
 * the list is empty, so a deployment without app runs (and possibly without the
 * table) is never touched by it.
 */
export async function readAppRunStatuses(taskIds: readonly string[]): Promise<Map<string, AppRunStatus>> {
  const out = new Map<string, AppRunStatus>();
  if (taskIds.length === 0) return out;
  const r = await db.query(
    `SELECT task_id, state, last_exit, sandbox_workload_id, sandbox_state, sandbox_since
       FROM claw_app_runs WHERE task_id = ANY($1::text[])`,
    [[...taskIds]],
  );
  for (const row of r.rows as StatusRow[]) out.set(row.task_id, appRunStatusOf(row));
  return out;
}
