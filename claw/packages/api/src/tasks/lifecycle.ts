// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Task lifecycle helpers consumed by the `/v1/internal/tasks/:taskId/*`
 * routes and by public cancel / retry endpoints (task-design.md §11.2).
 *
 * The implementation here is deliberately small: it only translates
 * `ExecuteResult`-shaped payloads from Brain into row updates and triggers
 * `last_user` sandbox destruction. Per-DAG aggregation and cascade failure
 * are handled by the scheduler tick (`tasks/scheduler.ts`).
 */
import { db } from "../infra/db.js";
import pino from "pino";
import { getTask, transitionStatus, updateTask } from "./db.js";
import { stopAllHandlesForDag, stopSandboxByHandle } from "./sandbox-stopper.js";
import { newTaskId } from "./ids.js";
import type { TaskStatus } from "./types.js";

const logger = pino({ name: "task-lifecycle" });

export interface AgentDonePayload {
  task_id?: string;
  final_text?: string;
  captures?: Record<string, string>;
  artifacts?: Array<Record<string, unknown>>;
  token_usage?: Record<string, unknown>;
  turns?: number;
  tool_stats?: Record<string, unknown>;
  error_count?: number;
  abort_reason?: string;
  failure_reason?: string;
  /** Only set when abort_reason='wait_external'. */
  metadata?: Record<string, unknown>;
}

function resolveTerminalStatus(p: AgentDonePayload): TaskStatus {
  const r = p.abort_reason ?? "completed";
  if (r === "completed") return "completed";
  if (r === "cancelled") return "cancelled";
  if (r === "wait_external") return "waiting_external";
  return "failed";
}

/**
 * Apply the agent_done payload to the task row and, when the task is the
 * last user of any sandbox handle, ask the SandboxStopper to tear that
 * handle down.
 */
export async function applyAgentDone(taskId: string, payload: AgentDonePayload): Promise<void> {
  const task = await getTask(taskId);
  if (!task) {
    logger.warn({ taskId }, "agent_done.task_missing");
    return;
  }
  const next = resolveTerminalStatus(payload);

  const patch: Record<string, unknown> = {
    output: payload.final_text ?? null,
    captures: JSON.stringify(payload.captures ?? {}),
    artifacts: JSON.stringify(payload.artifacts ?? []),
    tool_stats: payload.tool_stats ? JSON.stringify(payload.tool_stats) : null,
    token_usage: payload.token_usage ? JSON.stringify(payload.token_usage) : null,
    turns: payload.turns ?? null,
    failure_reason: payload.failure_reason ?? null,
    error_message: payload.failure_reason ?? null,
  };

  if (next === "waiting_external") {
    // Stash external_id under metadata.derived so the ExternalResolver
    // tick can find this row.
    const externalId = (payload.metadata?.external_id as string | undefined) ?? "";
    if (!externalId) {
      logger.warn({ taskId }, "agent_done.wait_external_missing_id");
    }
    const merged = {
      ...(task.metadata ?? {}),
      derived: {
        ...(task.metadata?.derived as Record<string, unknown> | undefined ?? {}),
        external_id: externalId,
      },
    };
    patch.metadata = JSON.stringify(merged);
  }

  // Use a CAS-safe transition so a duplicate callback can't override a
  // terminal state. The allowed source states must include every
  // non-terminal status the task can legitimately be in when a fresh
  // agent_done arrives — crucially `waiting_external` and `queued`:
  //
  // An ExternalResolver-resumed task (waiting_external → queued → dispatch)
  // can finish so fast that the agent_done callback races ahead of the
  // queued→running transition. If `waiting_external`/`queued` are not
  // accepted as source states, the CAS no-ops, the task stays in
  // `waiting_external`, and the resolver re-dispatches it every 30 s
  // FOREVER (observed: claude_code/cursor stuck looping lock_acquired →
  // completed). Accepting them lets a genuine completion land terminally
  // and break the loop. A truly duplicate callback after the task is
  // already terminal still no-ops because terminal states are excluded.
  const expected: TaskStatus[] = next === "waiting_external"
    ? ["running", "preparing", "queued"]
    : ["running", "preparing", "cancelling", "waiting_external", "queued"];
  const updated = await transitionStatus(taskId, expected, next, patch);
  if (!updated) {
    logger.info({ taskId, next, task_status: task.status }, "agent_done.transition_noop");
    return;
  }

  if (next === "completed" || next === "failed" || next === "cancelled") {
    await maybeStopHandlesForLastUser(updated.dag_root_task_id, updated.dag_node_id, updated.session_id);
  }
}

async function maybeStopHandlesForLastUser(
  dagRootTaskId: string | null,
  dagNodeId: string | null,
  sessionId: string,
): Promise<void> {
  if (!dagRootTaskId || !dagNodeId || dagNodeId === "__dag_root__") return;
  const r = await db.query(
    `SELECT metadata FROM claw_tasks WHERE task_id = $1 AND dag_node_id = '__dag_root__'`,
    [dagRootTaskId],
  );
  if (r.rowCount === 0) return;
  const root = r.rows[0] as { metadata: Record<string, unknown> };
  const lastUser = ((root.metadata?.derived as Record<string, unknown>)?.handle_last_user
    ?? {}) as Record<string, string>;
  for (const [handle, nodeId] of Object.entries(lastUser)) {
    if (nodeId === dagNodeId) {
      await stopSandboxByHandle(dagRootTaskId, handle, sessionId).catch((e) => {
        logger.warn({ dagRootTaskId, handle, err: (e as Error).message }, "stop_handle_failed");
      });
    }
  }
}

/**
 * Cancel a task (or virtual DAG root). For execution tasks we set
 * `cancelling` and trust Brain's NATS interrupt channel to react. For
 * the virtual root we directly cascade to every peer.
 */
export async function cancelTask(
  taskId: string,
): Promise<{ ok: boolean; cancelled: number; interrupt_key?: string }> {
  const task = await getTask(taskId);
  if (!task) return { ok: false, cancelled: 0 };

  if (task.dag_node_id === "__dag_root__") {
    const r = await db.query(
      `UPDATE claw_tasks
       SET status = 'cancelled', failure_reason = 'cancelled', completed_at = NOW()
       WHERE dag_root_task_id = $1
         AND status IN ('waiting_deps','waiting_external','queued','preparing','running','cancelling')
       RETURNING task_id`,
      [task.task_id],
    );
    await stopAllHandlesForDag(task.task_id, task.session_id);
    return { ok: true, cancelled: r.rowCount ?? 0, interrupt_key: task.task_id };
  }

  // `preparing` counts as executing, not as pending. The dispatcher sets it at
  // the moment it publishes the execution message, so by the time anyone can
  // cancel such a row Brain may well have picked it up, built a sandbox and
  // started burning compute -- exactly the case the comment below says must
  // not be closed straight in the database. Treating it as pending was safe
  // only while `running` was reachable, and it never was: nothing moved rows
  // out of `preparing`, so every executing task took the wrong branch here.
  //
  // The remaining ambiguity is a row published but not yet consumed, which has
  // nothing to acknowledge the cancellation. That one sits in `cancelling`
  // until the sweeper closes it, which is what the sweeper's `cancelling`
  // branch is for.
  const executing = task.status === "preparing" || task.status === "running";
  const updated = await transitionStatus(
    task.task_id,
    ["waiting_deps", "waiting_external", "queued", "preparing", "running"],
    executing ? "cancelling" : "cancelled",
  );
  if (updated && task.dag_root_task_id) {
    // A cancelled dependency can never satisfy downstream readiness. Close its
    // entire transitive tail so the virtual root can eventually aggregate.
    //
    // The status list deliberately stops short of the executing states, and
    // that is not an oversight in two separate ways:
    //
    //   - It cannot matter. `promoteReadyTasks` only leaves `waiting_deps` when
    //     EVERY dep is `completed`, and the row we just cancelled is not, so no
    //     transitive downstream can have started. `queued` / `waiting_external`
    //     are in the list defensively, not because the graph can reach them
    //     from here. `preparing` used to be listed for the same defensive
    //     reason and no longer is: it means the row may already be executing,
    //     so closing one here would be the mistake described below. If the
    //     invariant above is ever broken, leaving such a row for the sweeper is
    //     slower but not wrong, whereas closing it under a live run is wrong.
    //   - It would be wrong anyway. A row that is executing owns a Brain run and
    //     a sandbox, and marking it `cancelled` straight in the database stops
    //     neither: the work keeps burning a GPU and a late `agent_done` would
    //     write over the terminal state. Execution is stopped by going through
    //     `cancelling` and waiting for Brain to acknowledge, which is exactly
    //     what the single-task transition above does. The DAG-root branch may
    //     list `running` because it pairs the UPDATE with `stopAllHandlesForDag`
    //     plus an interrupt publish; this recursive tail has no such pairing.
    await db.query(
      `WITH RECURSIVE downstream(task_id) AS (
         SELECT to_task_id FROM claw_task_edges WHERE from_task_id = $1
         UNION
         SELECT e.to_task_id
           FROM claw_task_edges e
           JOIN downstream d ON e.from_task_id = d.task_id
       )
       UPDATE claw_tasks
          SET status = 'cancelled', failure_reason = 'cancelled',
              error_message = $2, completed_at = NOW()
        WHERE task_id IN (SELECT task_id FROM downstream)
          AND status IN ('waiting_deps','waiting_external','queued')`,
      [task.task_id, `upstream ${task.task_id} cancelled`],
    );
  }
  return {
    ok: !!updated,
    cancelled: updated ? 1 : 0,
    interrupt_key: updated ? (task.dag_root_task_id ?? task.session_id) : undefined,
  };
}

/**
 * Retry a failed task by re-creating a fresh row with the same intent. We
 * do *not* mutate the original row so retries are auditable. Retries are
 * only allowed for terminal failure / cancelled tasks.
 */
export async function retryTask(taskId: string): Promise<{ ok: boolean; new_task_id?: string }> {
  const task = await getTask(taskId);
  if (!task) return { ok: false };
  if (task.status !== "failed" && task.status !== "cancelled") return { ok: false };
  // Chat rows are a turn's shadow, not a job the caller retries. Cloning one
  // would drop `origin` and `workspace_id`, and the replacement would look like
  // a DAG-less task with no lease. Refuse rather than mint that row.
  if (task.origin === "chat") return { ok: false };
  // A replacement row does not rewire downstream depends_on IDs or reopen the
  // virtual root. Until attempts are modelled explicitly, reject DAG retries
  // instead of returning a task that can never repair the graph.
  if (task.dag_root_task_id) return { ok: false };

  const newId = newTaskId();
  await db.query(
    `INSERT INTO claw_tasks
       (task_id, session_id, parent_task_id, batch_id,
        dag_id, dag_node_id, dag_root_task_id, plugin_id, name,
        input, prompt, script, depends_on, priority,
        executor, mode, model, tools_allowlist, skills, rules_text, agent_hooks,
        sandbox_spec, callback_url, backend_mcp_url,
        status, metadata)
     SELECT $1, session_id, task_id, batch_id,
            dag_id, dag_node_id, dag_root_task_id, plugin_id, name,
            input, prompt, script, depends_on, priority,
            executor, mode, model, tools_allowlist, skills, rules_text, agent_hooks,
            sandbox_spec,
            -- rewrite callback_url + backend_mcp_url to reference the NEW
            -- task id; the old task's URLs no longer authenticate (auth
            -- uses internal_token_hash keyed by the task_id in the path).
            replace(callback_url,    task_id, $1),
            replace(backend_mcp_url, task_id, $1),
            CASE WHEN coalesce(array_length(depends_on,1),0) = 0 THEN 'queued' ELSE 'waiting_deps' END,
            metadata
     FROM claw_tasks WHERE task_id = $2`,
    [newId, taskId],
  );
  await updateTask(taskId, { metadata: JSON.stringify({ ...(task.metadata ?? {}), retried_into: newId }) });
  return { ok: true, new_task_id: newId };
}
