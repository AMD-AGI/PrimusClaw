// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain dispatcher (task-design.md §12 / §13).
 *
 * Given a `claw_tasks.task_id` in status `queued`, this module:
 *
 *   1. Locks the row to `preparing` (CAS on status).
 *   2. Renders Backend-layer templates over `prompt` / `script` /
 *      `sandbox_spec` (`./template-renderer.ts`).
 *   3. Persists the rendered values back to `claw_tasks` so retries and
 *      future readers see the final form.
 *   4. Mints a per-task internal token, stores the SHA-256 hash on the row.
 *   5. Builds an `ExecuteRequest` and ships it to Brain via the existing
 *      NATS `tasks.execute` subject (brain consumer needs no changes).
 */
import { createHash, randomBytes } from "node:crypto";
import { taskSubject } from "@claw/protocol";
import type { ExecuteRequest, ScriptStep } from "@claw/protocol";
import {
  MissingPlatformKeyError,
  readTrustedSessionCredentials,
} from "../auth/session-credentials.js";
import { CLAW_DEPLOY_MODE } from "../config.js";
import { db } from "../infra/db.js";
import { js, sc, publishCertainlyFailed } from "../infra/nats.js";
import pino from "pino";
import { buildRenderContext, renderBackendTemplates } from "./template-renderer.js";
import { getTask, transitionStatus, updateTask } from "./db.js";
import { RUN_REQUEUE_RESET_SQL } from "./run-budget.js";
import { resolveToolMeta } from "./dags/admission.js";
import type { ClawTaskRow } from "./types.js";
import {
  ensureSessionWorkspace, isWorkspaceBindingError, requireWorkspaceBinding, takeRunRef,
} from "../workspace/store.js";

const logger = pino({ name: "task-dispatcher" });
const PUBLISH_TIMEOUT_MS = Number(process.env.TASK_DISPATCH_PUBLISH_TIMEOUT_MS || 10_000);
const DISPATCH_STAGE_TIMEOUT_MS = Number(process.env.TASK_DISPATCH_STAGE_TIMEOUT_MS || 15_000);

/**
 * How long a task may keep asking for a workspace before it is failed.
 *
 * Counted from `started_at`, which is stamped the first time the row entered
 * `preparing` and preserved by every later transition, so the window covers the
 * whole sequence of attempts instead of restarting with each one. That also
 * means no attempt counter has to be stored: the clock is already on the row,
 * and it is the same clock the run's deadline is measured from, so retrying
 * cannot buy a task more time than it was given.
 *
 * Sixty seconds against a two-second scheduler tick is tens of attempts, and
 * each one that fails on a timing-out database costs a stage timeout on top.
 * Long enough for a failover or a lock held by a migration; far short of an
 * outage, which should fail the task and say so rather than cycle until
 * someone notices.
 */
const BIND_RETRY_WINDOW_MS = Number(process.env.TASK_DISPATCH_BIND_RETRY_SEC || 60) * 1000;

export interface DispatchResult {
  ok: boolean;
  reason?: string;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Extract `namespace` from a sandbox_spec if present. DAG authors can set
 * `"sandbox": { "handle": "ws", "namespace": "example-hyperloom" }` to
 * control which SaFE workspace (K8s namespace) the sandbox lands in,
 * without relying on session-level or deployment-wide defaults.
 */
function extractSandboxNamespace(spec: unknown): string | undefined {
  if (spec && typeof spec === "object" && "namespace" in spec) {
    const ns = (spec as Record<string, unknown>).namespace;
    if (typeof ns === "string" && ns.trim()) return ns.trim();
  }
  return undefined;
}

/**
 * Bound each dispatch stage. A stuck stage is worse than a failed task because
 * it holds the scheduler loop and leaves the row in `preparing` with no owner.
 */
async function withTimeout<T>(label: string, work: Promise<T>, timeoutMs = DISPATCH_STAGE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Seam over the connection the task goes out on.
 *
 * Same shape as `interruptPublisher` in tasks/sweeper.ts and for the same reason:
 * `js` and `sc` are live bindings on a frozen module namespace, so a test
 * cannot substitute them. Without a seam the only failure a test can produce
 * here is an uninitialised client, which is a publish that certainly did not
 * happen -- and the branch that matters is the other one.
 */
export const taskPublisher = {
  async publish(payload: string): Promise<void> {
    await js.publish(taskSubject(), sc.encode(payload));
  },
};

/**
 * Publish an already-serialised task to Brain with a finite timeout. JetStream
 * publish should be fast; when it hangs the scheduler loop would otherwise
 * stall after the row has already moved to `preparing`, leaving the DAG with
 * no owner.
 *
 * Serialised by the caller so that everything reachable from here is a publish
 * that may have landed -- see the flag in dispatchTask.
 */
async function publishExecuteRequest(payload: string): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`tasks.execute publish timed out after ${PUBLISH_TIMEOUT_MS}ms`)),
      PUBLISH_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([taskPublisher.publish(payload), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadSessionCredentials(sessionId: string): Promise<{
  user_id: string;
  platform_key: string;
  workspace_id: string;
  llm_api_key: string;
}> {
  // `claw_sessions` only ships `user_id` in the canonical schema; the legacy
  // `platform_key` / `workspace_id` columns are optional add-ons in some
  // deployments. We SELECT user_id + config and read platform_key /
  // workspace_id from the config JSONB.
  //
  // There is deliberately no fallback to the cluster-wide `SAFE_PLATFORM_KEY`.
  // There used to be, and it applied silently: every DAG-driven workload ran
  // under a shared identity, because the only entry point that recorded the
  // caller's key was the workbench one. SaFE takes the workload's `user.id`
  // label from the bearer's subject and grants update/delete/resume to the
  // owner, so the submitter of a run could not stop or delete it -- and nothing
  // anywhere said why.
  //
  // Failing here in SaFE mode is the point. Every entry point stamps the
  // caller's credentials before queueing; Kubernetes mode legitimately has no
  // platform key and uses the stamped LLM key instead.
  const r = await db.query(
    `SELECT user_id, config FROM claw_sessions WHERE session_id = $1`,
    [sessionId],
  );
  if (r.rowCount === 0) throw new Error(`session ${sessionId} not found`);
  const row = r.rows[0] as { user_id: string; config: Record<string, unknown> | null };
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  const credentials = readTrustedSessionCredentials(cfg);
  const sessionWorkspaceId = typeof cfg.workspace_id === "string" ? cfg.workspace_id : "";
  // Only SaFE creates a workload with this credential. Kubernetes/BYOK uses the
  // caller's LLM key and the agent-sandbox provider, so requiring platformKey
  // here made every task-system dispatch fail on the shipped default mode.
  if (CLAW_DEPLOY_MODE !== "kubernetes" && !credentials.platformKey) {
    throw new MissingPlatformKeyError(`session ${sessionId}`);
  }
  return {
    user_id: row.user_id ?? "",
    platform_key: credentials.platformKey,
    // The namespace is not a credential: it names where the work runs, not who
    // it runs as, and a deployment-wide default for it grants nothing.
    workspace_id: sessionWorkspaceId || process.env.SANDBOX_NAMESPACE || "",
    llm_api_key: credentials.llmApiKey,
  };
}

/**
 * Put a task back on the queue after its workspace could not be bound.
 *
 * The refusal itself is right -- dispatching anyway gives the run a gate key
 * that lets siblings over one directory overwrite each other. What it must not
 * do is end the task. A DAG node has no retry of its own: `retryTask` rejects
 * anything carrying a `dag_root_task_id`, and `cascadeFailures` marks every
 * downstream row `deps_failed`, so a database that was unavailable for a second
 * used to cost the whole graph, unrecoverably, with `agent_error` on the row as
 * the only explanation.
 *
 * Requeueing re-runs the render, which is idempotent, and the CAS on
 * `preparing` means a row someone else has since moved is left alone.
 *
 * @returns false when the window has run out and the caller should fail the row.
 */
async function requeueAfterBindFailure(
  taskId: string,
  startedAt: string | Date | null | undefined,
  reason: string,
): Promise<boolean> {
  const firstAttemptMs = startedAt ? new Date(startedAt).getTime() : Number.NaN;
  // An unreadable or absent `started_at` is treated as this attempt being the
  // first, which is what it means on a row that has never been dispatched.
  const elapsedMs = Number.isFinite(firstAttemptMs) ? Date.now() - firstAttemptMs : 0;
  if (elapsedMs >= BIND_RETRY_WINDOW_MS) {
    logger.error({ taskId, elapsedMs }, "task.workspace_bind_window_exhausted");
    return false;
  }
  const requeued = await transitionStatus(taskId, ["preparing"], "queued", {
    // Explicitly cleared: the row is going back on the queue, and a queued row
    // carrying a failure_reason reads as one that has already given up.
    failure_reason: null,
    error_message: reason.slice(0, 2000),
  });
  if (!requeued) return false;
  logger.warn({ taskId, elapsedMs, err: reason }, "task.workspace_bind_requeued");
  return true;
}

/** What the Backend-layer templates render to, before it is persisted. */
interface RenderedTask {
  prompt: string | null;
  script: unknown[] | null;
  sandbox_spec: unknown;
}

/**
 * Render the task's own content, and tell each script step where it runs.
 *
 * Both halves are properties of the task rather than of this dispatch, and both
 * are idempotent -- which is what lets a row that was requeued after a binding
 * failure come back through here and get the same answer.
 */
async function renderTaskForDispatch(
  taskId: string,
  locked: ClawTaskRow,
  started: number,
): Promise<RenderedTask> {
  const ctx = await withTimeout("buildRenderContext", buildRenderContext(taskId));
  logger.info({ taskId, elapsedMs: Date.now() - started }, "task.dispatch_stage.render_context");
  const rendered: RenderedTask = {
    prompt: locked.prompt ? (renderBackendTemplates(locked.prompt, ctx) as string) : null,
    script: locked.script ? (renderBackendTemplates(locked.script, ctx) as unknown[]) : null,
    sandbox_spec: locked.sandbox_spec
      ? renderBackendTemplates(locked.sandbox_spec, ctx)
      : locked.sandbox_spec,
  };
  logger.info(
    {
      taskId,
      hasPrompt: !!rendered.prompt,
      scriptSteps: Array.isArray(rendered.script) ? rendered.script.length : 0,
      sandboxKind: typeof rendered.sandbox_spec === "string" ? rendered.sandbox_spec : "object",
      elapsedMs: Date.now() - started,
    },
    "task.dispatch_stage.rendered",
  );

  // Stamp `scope` on every script step so Brain's script-runner can route the
  // call without re-running admission. Default is `hands`.
  if (Array.isArray(rendered.script)) {
    const enriched: ScriptStep[] = [];
    for (const raw of rendered.script as ScriptStep[]) {
      if (!raw.scope) {
        try {
          const meta = await resolveToolMeta(raw.name, locked.plugin_id ?? null);
          raw.scope = meta.scope;
        } catch { raw.scope = "hands"; }
      }
      enriched.push(raw);
    }
    rendered.script = enriched as unknown as unknown[];
  }
  logger.info({ taskId, elapsedMs: Date.now() - started }, "task.dispatch_stage.scope_enriched");
  return rendered;
}

/**
 * Name the files this run writes, and record that it is using them.
 *
 * The workspace is created here if this session has never had one, because a
 * DAG-only session -- a workbench run, say -- never goes through the chat path
 * that would otherwise create it, and those are exactly the runs the workspace
 * gate exists to serialise: siblings under different DAG roots writing one
 * directory.
 *
 * Refused when it cannot be created: dispatching anyway produces a run whose
 * gate falls back to the DAG root, which is the key that lets those siblings
 * overwrite each other. Refusing here puts the reason on the task row;
 * dispatching there loses files and says nothing. The refusal is retried within
 * a window rather than being terminal -- see requeueAfterBindFailure for why a
 * DAG node cannot afford to end here.
 *
 * A stage timeout is folded into the same refusal rather than left to escape as
 * a plain Error: `ensureSessionWorkspace` swallows a database that is merely
 * unwell and answers null, so a database slow enough to hit the stage timeout
 * instead is the same transient failure arriving a second later -- and the only
 * difference in the old shape was that one of them was retried and the other
 * failed the node and cascaded to its whole downstream.
 *
 * @throws {WorkspaceBindingError} when the run cannot be told which files it
 *         writes.
 */
async function bindRunFiles(
  sessionId: string,
  userId: string,
  taskId: string,
): Promise<string> {
  const bound = await withTimeout(
    "ensureSessionWorkspace",
    ensureSessionWorkspace(sessionId, userId),
  ).catch((err: unknown) => {
    logger.warn({ taskId, err: (err as Error)?.message }, "task.workspace_bind_timeout");
    return null;
  });
  const filesWorkspaceId = requireWorkspaceBinding(bound?.workspace_id, { sessionId, runId: taskId });
  // The same reference a chat turn takes, for the same reason: while a run
  // holds one, the files it is writing cannot be released and collected out
  // from under it. Taken after the binding rather than with it because a run
  // that is about to be refused has nothing to reference. Released by
  // `releaseRefsOfFinishedRuns` when the row reaches a terminal state, which
  // is the one path every way a DAG node can end goes through.
  //
  // The reference alone, without the writer claim the chat path takes. Nothing
  // is written here: the message is only being published, and the run reaches
  // the files later, once Brain lets it through the gate. Siblings are
  // dispatched in a batch, so claiming now would have the first hold the claim
  // and the rest report contention over runs that never overlap -- see
  // recordRunUse.
  await takeRunRef(sessionId, userId, taskId, filesWorkspaceId);
  return filesWorkspaceId;
}

/**
 * Assemble the message Brain executes.
 *
 * On the legacy NATS subject, so Brain's existing consumer picks it up without
 * code changes; the new task-system fields travel alongside the legacy ones.
 */
function buildExecuteRequest(opts: {
  updated: ClawTaskRow;
  rendered: RenderedTask;
  session: Awaited<ReturnType<typeof loadSessionCredentials>>;
  internalToken: string;
  filesWorkspaceId: string;
}): ExecuteRequest {
  const { updated, rendered, session, internalToken, filesWorkspaceId } = opts;
  const sandboxSpecForBrain = (rendered.sandbox_spec ?? "none") as ExecuteRequest["sandbox_spec"];
  // Lift per-user env snapshot from task.input back to the top-level
  // ExecuteRequest field Brain expects. expandDag embedded it under
  // input.user_env at workbench POST /runs time (workbenches/routes.ts).
  const rawUserEnv = ((updated.input ?? {}) as Record<string, unknown>).user_env;
  const userEnvForReq =
    rawUserEnv && typeof rawUserEnv === "object" && !Array.isArray(rawUserEnv)
      ? (rawUserEnv as Record<string, string>)
      : undefined;
  return {
    task_id: updated.task_id,
    session_id: updated.session_id,
    message_id: updated.task_id,
    dag_id: updated.dag_id ?? undefined,
    dag_node_id: updated.dag_node_id ?? undefined,
    dag_root_task_id: updated.dag_root_task_id ?? undefined,
    // Stamped by transitionStatus when this row entered `preparing`. Brain
    // stops itself on it and reports why, which is the difference between a
    // run that ends with a reason and one the sweeper marks failed while it
    // carries on burning.
    deadline_at: updated.deadline_at ?? undefined,
    callback_url: updated.callback_url ?? undefined,
    backend_mcp_url: updated.backend_mcp_url ?? undefined,
    backend_internal_token: internalToken,
    // The same per-task token authenticates callbacks, backend MCP calls, and
    // this task's lease endpoint. Brain renews immediately and then
    // periodically, so a long budget controls policy while the lease answers
    // the independent question of whether a worker is still alive.
    run_lease: updated.callback_url
      ? { url: `${updated.callback_url}/lease`, token: internalToken }
      : undefined,
    mode: (updated.mode as "llm" | "script") ?? "llm",
    workspace_throwaway: updated.workspace_throwaway === true ? true : undefined,
    sandbox_spec: sandboxSpecForBrain,
    workspace_id: extractSandboxNamespace(sandboxSpecForBrain) || session.workspace_id || undefined,
    platform_key: session.platform_key || "",
    llm_api_key: session.llm_api_key || undefined,
    user_id: session.user_id || "",
    user_env: userEnvForReq,
    plugin_id: updated.plugin_id ?? undefined,
    plugin_tools: null,
    prompt: rendered.prompt ?? undefined,
    history: [],
    script: rendered.script as ExecuteRequest["script"] | undefined,
    tools_allowlist: (updated.tools_allowlist as string[]) ?? undefined,
    model: updated.model ?? undefined,
    files_workspace_id: filesWorkspaceId,
    files_workspace_required: true,
    // Legacy fields removed -- new schema uses sandbox_spec exclusively.
  };
}

/**
 * Decide what a dispatch that threw leaves behind on the row.
 *
 * Three outcomes, and which one applies is the whole of this function: back on
 * the queue, left open, or failed.
 *
 * @param publishAttempted whether the failure could have been a message that
 *        reached the server. False for everything before the publish, which
 *        includes serialising the payload.
 */
async function resolveDispatchFailure(
  taskId: string,
  locked: ClawTaskRow,
  e: unknown,
  publishAttempted: boolean,
): Promise<DispatchResult> {
  const msg = e instanceof Error ? e.message : String(e);
  logger.error({ taskId, err: msg }, "task.dispatch_failed");
  const bindFailure = isWorkspaceBindingError(e);
  const credentialFailure = e instanceof MissingPlatformKeyError;
  // The one failure here that is worth another attempt on its own. Everything
  // else is either the task's own fault (an unrenderable template, a session
  // that does not exist) or already covered: a NATS publish that failed leaves
  // a row the sweeper reclaims.
  if (bindFailure && await requeueAfterBindFailure(taskId, locked.started_at, msg)) {
    return { ok: false, reason: msg };
  }
  // A publish that merely might have failed must not be recorded as one that
  // did -- the same distinction the replay path draws, and here it decides the
  // fate of the reference this run holds rather than only the row's wording. A
  // timeout says the ack did not arrive, not that the message did not: the run
  // may be executing. Marked failed, `releaseRefsOfFinishedRuns` lets go of its
  // workspace reference on the next tick, and the files it is still writing can
  // be released and collected under it -- which is exactly what leaving the
  // reference alone in this catch was for.
  //
  // Left at `preparing` instead, where it is the case the deadline backstop
  // already covers: no lease is ever written for a run nobody claimed, so
  // `reapStaleTasks` closes it and publishes the interrupt that stops it.
  if (publishAttempted && !publishCertainlyFailed(e)) {
    logger.warn({ taskId, err: msg }, "task.publish_uncertain_row_left_open");
    return { ok: false, reason: msg };
  }
  // Roll back to failed with an actionable reason so the caller can decide
  // whether to retry (admission errors are non-retriable; transient
  // NATS / DB errors will be picked up by sweeper). The binding gets its own
  // reason rather than sharing `agent_error`: no agent ran, nothing was
  // dispatched, and the two need different alerts.
  // A missing credential gets its own reason for the same reason the binding
  // failure does: no agent ran, nothing was dispatched, and the fix is a
  // configuration one. Filed under `agent_error` it would be counted among the
  // failures that are the workload's own.
  await transitionStatus(taskId, ["preparing"], "failed", {
    failure_reason: credentialFailure
      ? "missing_platform_key"
      : bindFailure
        ? "workspace_bind_failed"
        : "agent_error",
    error_message: msg,
  });
  return { ok: false, reason: msg };
}

/**
 * Give a chat row back to claim-next, but only if nobody has claimed it.
 *
 * The scheduler should never pick chat, so this is the defence if it does.
 * A status-only CAS back to queued would also move a row a Brain already
 * took in the window after we CAS-ed to preparing: takeClaim accepts
 * preparing with a null lease. Requiring `lease_owner IS NULL` leaves that
 * holder alone.
 */
async function putBackUnclaimedChatRun(taskId: string): Promise<void> {
  await db.query(
    `UPDATE claw_tasks
        SET status = 'queued',
            ${RUN_REQUEUE_RESET_SQL}
      WHERE task_id = $1
        AND status = 'preparing'
        AND origin = 'chat'
        AND lease_owner IS NULL`,
    [taskId],
  );
}

/**
 * Attempt to dispatch one task. Idempotent: if the row is no longer
 * `queued` (e.g. another dispatcher beat us, or it was cancelled), we
 * return `{ ok: false }` without throwing.
 *
 * The steps are in the order they are for the reasons each of them gives, and
 * the last two are the pair worth reading together: the row is persisted before
 * the message goes out, so a process that dies between them leaves something
 * the sweeper can close rather than a run nothing recorded.
 */
export async function dispatchTask(taskId: string): Promise<DispatchResult> {
  // 1. CAS into preparing.
  const locked = await transitionStatus(taskId, ["queued"], "preparing");
  if (!locked) return { ok: false, reason: "not_queued" };
  // Chat runs are claimed, not published. The scheduler should not have
  // picked this row; putting it back is cheaper than a fat message that
  // bypasses the doorbell and arrives without credentials.
  if (locked.origin === "chat") {
    logger.info({ taskId }, "scheduler.skipped_chat_run");
    await putBackUnclaimedChatRun(taskId);
    return { ok: false, reason: "chat_run_not_scheduled" };
  }

  let publishAttempted = false;
  try {
    const started = Date.now();
    logger.info(
      { taskId, dag_id: locked.dag_id, dag_node_id: locked.dag_node_id, mode: locked.mode },
      "task.dispatch_stage.locked",
    );

    // 2. Render templates and stamp each script step's scope.
    const rendered = await renderTaskForDispatch(taskId, locked, started);

    // 3. Persist rendered values + per-task token.
    const internalToken = randomBytes(32).toString("hex");
    const updated = await withTimeout(
      "updateTask(rendered)",
      updateTask(taskId, {
        prompt: rendered.prompt,
        script: rendered.script === null ? null : JSON.stringify(rendered.script),
        sandbox_spec: rendered.sandbox_spec === null || rendered.sandbox_spec === undefined
          ? null
          : JSON.stringify(rendered.sandbox_spec),
        internal_token_hash: sha256Hex(internalToken),
      }),
    );
    if (!updated) throw new Error(`failed to persist render for task ${taskId}`);
    logger.info(
      { taskId, status: updated.status, started_at: updated.started_at, elapsedMs: Date.now() - started },
      "task.dispatch_stage.persisted",
    );

    // 4. Build the ExecuteRequest, over the files this run is bound to.
    const session = await withTimeout(
      "loadSessionCredentials", loadSessionCredentials(updated.session_id),
    );
    logger.info(
      {
        taskId,
        hasPlatformKey: !!session.platform_key,
        workspace_id: session.workspace_id,
        elapsedMs: Date.now() - started,
      },
      "task.dispatch_stage.session_loaded",
    );
    const filesWorkspaceId = await bindRunFiles(
      updated.session_id, session.user_id || "", taskId,
    );
    const req = buildExecuteRequest({
      updated, rendered, session, internalToken, filesWorkspaceId,
    });

    // 5. Publish. Serialised first, and the flag set only once there is
    // something to send: a payload that will not serialise never reaches the
    // connection, and counting it as a publish that may have landed leaves the
    // row at `preparing` until the deadline backstop reaches it an hour later,
    // with the whole DAG waiting behind it and its workspace reference held.
    const payload = JSON.stringify(req);
    logger.info({ taskId, subject: taskSubject(), elapsedMs: Date.now() - started }, "task.dispatch_stage.publish_start");
    publishAttempted = true;
    await publishExecuteRequest(payload);
    logger.info({ taskId, mode: req.mode, dag_id: req.dag_id, elapsedMs: Date.now() - started }, "task.dispatched");
    return { ok: true };
  } catch (e) {
    return resolveDispatchFailure(taskId, locked, e, publishAttempted);
  }
}

export { getTask };
export type { ClawTaskRow };
