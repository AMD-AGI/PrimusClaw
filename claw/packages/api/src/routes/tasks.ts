// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Public task / batch routes (task-design.md §11.1, §14).
 *
 *   POST   /v1/sessions/:sessionId/tasks   create task (single or DAG)
 *   POST   /v1/batches                     create a batch of DAG instances
 *   GET    /v1/tasks/:taskId               fetch single row
 *   GET    /v1/tasks/:taskId/dag           fetch every row in this DAG
 *   GET    /v1/tasks/:taskId/events        SSE stream of events
 *   POST   /v1/tasks/:taskId/cancel        cancel task (or virtual root)
 *   POST   /v1/tasks/:taskId/retry         requeue a failed task
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { interruptSubject } from "@claw/protocol";
import pino from "pino";
import { getUser } from "../auth/middleware.js";
import {
  canAccessSession,
  canAccessSessionAsOperator,
  canWriteSessionAsOperator,
} from "../auth/models.js";
import { db, MarketplaceDb } from "../infra/db.js";
import { nc, sc } from "../infra/nats.js";
import { canExecuteTaskDag } from "../tasks/dags/authz.js";
import { getTaskDag } from "../tasks/dags/db.js";
import type { UserInfo } from "../auth/models.js";
import { MissingPlatformKeyError, stampSessionCredentials } from "../auth/session-credentials.js";
import { withAdmissionTransaction } from "../tasks/admission.js";
import { actingTurnRefusalFor } from "../github-review/acting-turns.js";
import { createAppRun } from "./app-run-create.js";
import {
  createSingleTask, expandDag, isCreateRefusal, isSandboxWorkspaceRefusal, isTopologyRefusal,
  type CreateRefusal, type ExpandResult,
} from "../tasks/dag-expander.js";
import { getTask, listTasksByDag } from "../tasks/db.js";
import { cancelTask, retryTask } from "../tasks/lifecycle.js";
import { newBatchId } from "../tasks/ids.js";
import { enrichPluginToolsInline, pluginSandboxImage } from "../marketplace/plugins.js";
import { publicTaskRow, redactPublicJson } from "../events/redaction.js";
import type { TaskDagDef } from "../tasks/dags/types.js";
import type { ClawTaskRow } from "../tasks/types.js";
import { DELETED_SESSION_TASK_READ_SEC } from "../config.js";
import { checkOverrides, hasOverrides, overrideKeys, overridesAudit, type OverrideProblem, type OverrideValues } from "../marketplace/plugin-overrides.js";

/**
 * The sandbox a plugin-less single task should get.
 *
 * This used to be the literal `"none"`, which `resolveSandboxAction` maps to
 * `{kind:"none"}` and `ensureHands` then throws on -- while the agent is still
 * handed the full tool schema. So a prompt-only task advertised every sandbox
 * tool and died on the first one that was called, and the sandboxless fast
 * path that would have excused it is gated on `mode === "script"`. The visible
 * symptom was a run ending in two turns having called nothing, and a
 * `sandbox_workload_id` that was NULL for every row ever written -- which in
 * turn left the platform-facts backfill filtering out every row it was given.
 *
 * The chat path never had this: it resolves an image through
 * request -> plugin -> marketplace default and ships it as the legacy
 * top-level field. Same precedence here, minus the per-request override a task
 * body has no field for. `"none"` survives only for the case it describes --
 * no plugin and no default image, where a sandbox genuinely cannot be built.
 */
export async function singleTaskSandboxSpec(
  plugin: { image?: string; resource?: unknown } | null | undefined,
): Promise<{ handle: string; image: string; resources?: unknown } | "none"> {
  if (plugin?.image) {
    return { handle: "main", image: plugin.image, resources: plugin.resource };
  }
  const row = await MarketplaceDb.resourceFirstByType("default").catch(() => null);
  const image = String((row as Record<string, unknown> | null)?.image ?? "").trim();
  if (!image) return "none";
  return { handle: "main", image, resources: (row as Record<string, unknown>).resource };
}

const logger = pino({ name: "tasks-routes" });

/**
 * Record the caller's credentials on the session, or refuse the submission.
 *
 * 403 rather than 500: a caller with no platform key is a request this service
 * cannot honour, not a fault in it. And rather than the shared identity the
 * dispatcher used to fall back to -- a submission that runs as somebody else is
 * worse than one that does not run, because the submitter cannot stop it.
 */
async function stampCredentialsOr403(
  reply: FastifyReply,
  sessionId: string,
  user: UserInfo,
  client?: PoolClient,
): Promise<boolean> {
  try {
    await stampSessionCredentials(sessionId, user, client);
    return true;
  } catch (error) {
    if (!(error instanceof MissingPlatformKeyError)) throw error;
    logger.warn({ sessionId, userId: user.userId }, "task.submit_without_platform_key");
    await reply.status(403).send({ ok: false, error: "missing_platform_key" });
    return false;
  }
}

/**
 * The one answer every gated creation surface gives a refusal.
 *
 * `429` for every ceiling, tree caps included: a refusal means the fleet cannot
 * take this now, never that the request was malformed. A malformed topology is
 * the other thing, and gets the status that says so.
 */
async function sendCreateRefusal(reply: FastifyReply, refusal: CreateRefusal): Promise<void> {
  if (isSandboxWorkspaceRefusal(refusal)) {
    await reply.status(400).send(refusal.sandboxWorkspace);
    return;
  }
  if (isTopologyRefusal(refusal)) {
    await reply.status(400).send({
      ok: false, error: "invalid_topology", errors: refusal.invalidTopology,
    });
    return;
  }
  await reply.status(429).send({
    ok: false, error: "admission_rejected", reason: refusal.reason,
  });
}

interface CreateTaskBody {
  /** `"app"` creates a hosted application run; anything else is the task path below. */
  mode?: unknown;
  /** With `mode: "app"`: what the run gets, requested explicitly. */
  resources?: unknown;
  dag_id?: string;
  plugin_id?: number;
  input?: Record<string, unknown>;
  prompt?: string;
  /**
   * Skip the post-run /workspace upload: this task has already delivered its
   * output somewhere of its own. Only honoured on the single-task path -- a DAG
   * declares it on the template, per node or for all of them.
   */
  workspace_throwaway?: boolean;
  /**
   * Run-time overrides of the plugin (marketplace/plugin-overrides.ts): only keys
   * the plugin declares overridable. A single task takes `image` and `model`; an
   * app run (`mode: "app"`) takes those, `args` and `env`. Not with `dag_id`.
   */
  overrides?: unknown;
}

/**
 * Whether the caller may use this session; `"deleted"` when it may only read what
 * is left of a deleted one.
 *
 * `readDeletedSec` admits a session deleted at most that many seconds ago, for a
 * read and nothing else; the same owner rule applies, read off the row the delete
 * left in place.
 */
async function requireSessionAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  write: boolean,
  ownerOnly = false,
  startsWork = false,
  readDeletedSec = 0,
): Promise<boolean | "deleted"> {
  const within = write || startsWork ? 0 : readDeletedSec;
  const session = (within > 0
    ? await db.query(
      `SELECT user_id, deleted_at IS NOT NULL AS deleted FROM claw_sessions
        WHERE session_id = $1
          AND (deleted_at IS NULL OR deleted_at > NOW() - ($2::int * INTERVAL '1 second'))`,
      [sessionId, within],
    )
    : await db.query(
      "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0] as { user_id?: string | null; deleted?: boolean } | undefined;
  if (!session) {
    reply.status(404).send({ ok: false, error: "session_not_found" });
    return false;
  }
  const user = getUser(req);
  const allowed = ownerOnly
    ? canAccessSession(session.user_id, user?.userId)
    : write
      ? canWriteSessionAsOperator(session.user_id, user)
      : canAccessSessionAsOperator(session.user_id, user);
  if (!allowed) {
    reply.status(403).send({ ok: false, error: "access_denied" });
    return false;
  }
  // Work that is about to run in a session that acts as a user runs with the review tools in its hands (github-review/acting-turns.ts),
  // so it is the person's say, like creating that session: the key a sandbox holds must not be able to start it.
  const unattended = startsWork ? await actingTurnRefusalFor(req, sessionId) : null;
  if (unattended) {
    reply.status(403).send({ ok: false, error: unattended });
    return false;
  }
  return session.deleted ? "deleted" : true;
}

async function requireTaskAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  taskId: string,
  write: boolean,
  ownerOnly = false,
  startsWork = false,
): Promise<ClawTaskRow | null> {
  const task = await getTask(taskId);
  if (!task) {
    reply.status(404).send({ ok: false, error: "not_found" });
    return null;
  }
  if (!await requireSessionAccess(req, reply, task.session_id, write, ownerOnly, startsWork)) return null;
  return task;
}

/**
 * How a task of a recently deleted session ended, and nothing it carried.
 *
 * A session's delete closes its runs (`cancelled`, `session_deleted`) and hides the
 * session in the same transaction, so before this a caller that deleted a session
 * with a run in it could never see that run's final state: the task answered 404
 * from the moment of the delete. The prompt, input, output and the rest stay
 * behind the delete; what is answered is the outcome.
 */
export function deletedSessionTaskView(row: ClawTaskRow): Record<string, unknown> {
  // Through the same redaction as every other task answer: `error_message` is free text.
  return redactPublicJson({
    task_id: row.task_id,
    session_id: row.session_id,
    dag_root_task_id: row.dag_root_task_id,
    mode: row.mode,
    origin: row.origin,
    status: row.status,
    failure_reason: row.failure_reason,
    error_message: row.error_message,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    session_deleted: true,
  }) as Record<string, unknown>;
}

async function loadPluginRow(pluginId: number) {
  const r = await db.query(
    `SELECT id, name, version, images, resource, tools, overridable FROM plugins
     WHERE id = $1 AND deleted_at IS NULL`,
    [pluginId],
  );
  if ((r.rowCount ?? 0) === 0) return null;
  const row = r.rows[0];
  // Inline-enrich `tools` so dag-expander/admission read `name`/`config`
  // directly instead of the V1-style `{id, type, version}` ref shape that the
  // plugin row physically stores.
  row.tools = await enrichPluginToolsInline(row.tools);
  // `images` is a list, and everything downstream of here -- three sandbox_spec
  // builders and dag-expander's inheritance -- wants the one image a node runs
  // on. Resolved once here for the same reason formatPluginRow resolves it once
  // for the message path: a list left to travel would be read four times, and
  // the four readings are what drift.
  row.image = pluginSandboxImage(row.images);
  return row;
}

/**
 * Seam over interrupt delivery, in the shape `tasks/sandbox-stopper.ts` uses
 * for the handle registry and `events/consumer.ts` for the tombstone bucket.
 *
 * `nc` is a live binding on a frozen module namespace, so until this existed
 * the cancel handler could not be reached at all without a NATS server -- which
 * is why the one thing it now has to get right, the response it builds, had no
 * test that exercised it as HTTP. With the seam a test can assert the status
 * code and the whole body, and can see whether the interrupt was published,
 * rather than matching the handler's source text and hoping.
 */
export const interruptDelivery = {
  publish(interruptKey: string): void {
    nc.publish(interruptSubject(interruptKey));
  },
  flush(): Promise<void> {
    return nc.flush();
  },
};

/** The dag + plugin a create names, or the answer the route owes instead. */
type CreateTarget =
  | { dag: TaskDagDef | null; plugin: Awaited<ReturnType<typeof loadPluginRow>> }
  | { status: number; error: string };

async function resolveCreateTarget(body: CreateTaskBody, user: UserInfo): Promise<CreateTarget> {
  let dag = body.dag_id ? await getTaskDag(body.dag_id) : null;
  let plugin = body.plugin_id ? await loadPluginRow(body.plugin_id) : null;
  if (!dag && plugin?.resource?.task_dag_id) {
    dag = await getTaskDag(plugin.resource.task_dag_id as string);
  }
  if (dag && !plugin && dag.plugin_id) plugin = await loadPluginRow(dag.plugin_id);
  if (body.dag_id && !dag) return { status: 404, error: "dag_not_found" };
  if (dag && !canExecuteTaskDag(dag, user)) return { status: 404, error: "dag_not_found" };
  return { dag: (dag as unknown as TaskDagDef | null) ?? null, plugin };
}

function expandOptsFor(
  sessionId: string,
  user: UserInfo,
  dag: TaskDagDef,
  plugin: Awaited<ReturnType<typeof loadPluginRow>>,
  input: Record<string, unknown>,
  batchId?: string,
) {
  return {
    session_id: sessionId,
    user_id: user.userId,
    dag: dag as unknown as TaskDagDef & { metadata: { derived: any } },
    plugin: plugin
      ? { id: plugin.id, version: plugin.version, image: plugin.image, resource: plugin.resource, tools: plugin.tools ?? [] }
      : null,
    input,
    ...(batchId ? { batch_id: batchId } : {}),
  };
}

/**
 * A single task's overrides, checked against the plugin it names. A DAG has no
 * single sandbox or model to override, and a task with no plugin has no
 * declaration to check against: both refuse any override rather than ignore it.
 */
export function checkTaskOverrides(
  body: Pick<CreateTaskBody, "overrides" | "dag_id">,
  target: { dag: unknown; plugin: { id: unknown; version?: unknown; images?: unknown; overridable?: unknown } | null },
): { values: OverrideValues; audit?: Record<string, unknown> } | { problems: OverrideProblem[] } {
  if (body.overrides === undefined || body.overrides === null) return { values: {} };
  if (target.dag) return { problems: [{ field: "overrides", reason: "is not supported for a DAG run" }] };
  if (!target.plugin) return { problems: [{ field: "overrides", reason: "needs a plugin_id: only a plugin declares what may be overridden" }] };
  const checked = checkOverrides(body.overrides, target.plugin, "task");
  if (!checked.ok) return { problems: checked.problems };
  if (!hasOverrides(checked.values)) return { values: {} };
  return { values: checked.values, audit: overridesAudit(checked.values, target.plugin) };
}

/** The single-task sandbox spec with a checked image override applied; a task the plugin gives no sandbox gets one for the image. */
export function withImageOverride(
  spec: Awaited<ReturnType<typeof singleTaskSandboxSpec>>,
  plugin: { resource?: unknown } | null,
  image: string | undefined,
): Awaited<ReturnType<typeof singleTaskSandboxSpec>> {
  if (image === undefined) return spec;
  if (spec === "none") return { handle: "main", image, resources: plugin?.resource };
  return { ...spec, image };
}

/** What a partially admitted batch reports about the run it stopped on. */
function refusalReason(refusal: CreateRefusal): string {
  if (isSandboxWorkspaceRefusal(refusal)) return refusal.sandboxWorkspace.error;
  return isTopologyRefusal(refusal) ? "invalid_topology" : refusal.reason;
}

export async function registerTaskCreateRoute(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { sessionId: string }; Body: CreateTaskBody }>(
    "/v1/sessions/:sessionId/tasks",
    async (req, reply) => {
      const user = getUser(req);
      if (!user) return reply.status(401).send({ ok: false, error: "unauthorized" });

      const sessionId = req.params.sessionId;
      const body = req.body ?? {};

      // Submission stamps the caller's credentials onto the session. Operators
      // may inspect and stop tenant work, but submitting here would replace the
      // owner's credentials while their queued tasks still read from this row.
      if (!await requireSessionAccess(req, reply, sessionId, true, true, true)) return reply;

      // A hosted application run has its own admission (tasks/app-run.ts) and
      // its own Idempotency-Key handling; the session check above is the
      // ownership gate for it too.
      if (body.mode === "app") {
        const out = await createAppRun(req, sessionId, user, body);
        return reply.status(out.statusCode).send(out.response);
      }

      const target = await resolveCreateTarget(body, user);
      if ("status" in target) return reply.status(target.status).send({ ok: false, error: target.error });
      const overrides = checkTaskOverrides(body, target);
      if ("problems" in overrides) {
        return reply.status(400).send({ ok: false, error: "plugin_overrides_invalid", problems: overrides.problems });
      }
      // Outside the transaction: a marketplace lookup is not a decision, and
      // holding the admission lock across it would serialise the fleet on it.
      const sandboxSpec = target.dag
        ? undefined
        : withImageOverride(await singleTaskSandboxSpec(target.plugin), target.plugin, overrides.values.image);

      return await withAdmissionTransaction<unknown>(async (client) => {
        // Record the caller's own credentials before anything is queued: a task
        // is dispatched long after this request has gone, and the session row is
        // the only thing that carries the submitter that far. Rolled back with
        // the create, so a refusal does not rewrite them for a run never made.
        if (!(await stampCredentialsOr403(reply, sessionId, user, client))) {
          return { commit: false, value: reply };
        }
        const created = target.dag
          ? await expandDag(
            expandOptsFor(sessionId, user, target.dag, target.plugin, body.input ?? {}),
            client,
          )
          : await createSingleTask({
            session_id: sessionId,
            plugin_id: body.plugin_id ?? null,
            input: body.input ?? {},
            prompt: body.prompt,
            mode: "llm",
            workspace_throwaway: body.workspace_throwaway === true,
            sandbox_spec: sandboxSpec,
            ...(overrides.values.model ? { model: overrides.values.model } : {}),
            ...(overrides.audit ? { metadata: { plugin_overrides: overrides.audit } } : {}),
          }, client);
        if (isCreateRefusal(created)) {
          await sendCreateRefusal(reply, created);
          return { commit: false, value: reply };
        }
        if ("task_id" in created) {
          // Keys only: a value can be anything the plugin let the caller set.
          if (overrides.audit) {
            logger.info(
              { sessionId, taskId: created.task_id, pluginId: body.plugin_id, userId: user.userId, keys: overrideKeys(overrides.values) },
              "plugin_overrides.applied",
            );
          }
          return { commit: true, value: { ok: true, task_id: created.task_id } };
        }
        logger.info(
          { sessionId, dag_id: target.dag!.dag_id, dag_root_task_id: created.dag_root_task_id },
          "task_dag.created",
        );
        return { commit: true, value: { ok: true, ...created } };
      });
    },
  );

}

export async function registerBatchRoute(app: FastifyInstance): Promise<void> {
  app.post("/v1/batches", async (req, reply) => {
    const user = getUser(req);
    if (!user) return reply.status(401).send({ ok: false, error: "unauthorized" });

    const body = (req.body ?? {}) as {
      session_id?: string;
      dag_id?: string;
      plugin_id?: number;
      inputs?: Array<Record<string, unknown>>;
    };
    if (!body.session_id) return reply.status(400).send({ ok: false, error: "session_id required" });
    if (!body.dag_id) return reply.status(400).send({ ok: false, error: "dag_id required" });
    if (!Array.isArray(body.inputs) || body.inputs.length === 0) {
      return reply.status(400).send({ ok: false, error: "inputs[] required" });
    }
    if (!await requireSessionAccess(req, reply, body.session_id, true, true, true)) return reply;

    const dag = await getTaskDag(body.dag_id);
    if (!dag || !canExecuteTaskDag(dag, user)) {
      return reply.status(404).send({ ok: false, error: "dag_not_found" });
    }
    const plugin = body.plugin_id
      ? await loadPluginRow(body.plugin_id)
      : (dag.plugin_id ? await loadPluginRow(dag.plugin_id) : null);

    const batchId = newBatchId();
    try {
      return await withAdmissionTransaction<unknown>(async (client) => {
        const outcome = await submitBatch(client, {
          user, sessionId: body.session_id!, dagId: body.dag_id!, dag: dag as unknown as TaskDagDef,
          plugin, inputs: body.inputs!, batchId,
        });
        // Nothing admitted leaves no batch row and no credential stamp, so the
        // two states a crash can leave are the whole accepted prefix with a
        // matching `size`, or nothing.
        if (!outcome.roots.length) {
          await sendCreateRefusal(reply, outcome.refusal!);
          return { commit: false, value: reply };
        }
        return {
          commit: true,
          value: {
            ok: true,
            batch_id: batchId,
            dag_root_task_ids: outcome.roots,
            ...(outcome.refusal ? { refused_reason: refusalReason(outcome.refusal) } : {}),
          },
        };
      });
    } catch (error) {
      // The same refusal its sibling endpoint gives, in the same words. It
      // cannot go through stampCredentialsOr403 because the stamp belongs
      // inside this transaction, and without the branch a submission with no
      // platform key came back as an unhandled 500 -- indistinguishable from
      // Claw being broken, when it is the caller's request that cannot be
      // honoured.
      if (error instanceof MissingPlatformKeyError) {
        logger.warn(
          { sessionId: body.session_id, userId: user.userId },
          "batch.submit_without_platform_key",
        );
        return reply.status(403).send({ ok: false, error: "missing_platform_key" });
      }
      throw error;
    }
  });
}

interface BatchSubmission {
  user: UserInfo;
  sessionId: string;
  dagId: string;
  dag: TaskDagDef;
  plugin: Awaited<ReturnType<typeof loadPluginRow>>;
  inputs: Array<Record<string, unknown>>;
  batchId: string;
}

/**
 * Expand a batch's inputs in order, stopping at the first refusal.
 *
 * One transaction and one lock hold for the whole batch, so its runs are
 * admitted against each other as well as against the fleet, and every expansion
 * reads the rows the previous one wrote. The `size` written back is the accepted
 * count, never the requested one.
 */
async function submitBatch(
  client: PoolClient,
  submission: BatchSubmission,
): Promise<{ roots: string[]; refusal?: CreateRefusal }> {
  const { user, sessionId, batchId } = submission;
  // Inside the transaction that creates the batch: a batch whose rows exist
  // without the credential stamped would dispatch under the wrong identity,
  // and the two facts belong to the same decision.
  await stampSessionCredentials(sessionId, user, client);
  await client.query(
    `INSERT INTO claw_batches (batch_id, session_id, user_id, dag_id, size, status)
     VALUES ($1,$2,$3,$4,$5,'running')`,
    [batchId, sessionId, user.userId, submission.dagId, submission.inputs.length],
  );

  const roots: string[] = [];
  let refusal: CreateRefusal | undefined;
  for (const input of submission.inputs) {
    const r = await expandDag(
      expandOptsFor(sessionId, user, submission.dag, submission.plugin, input, batchId),
      client,
    );
    if (isCreateRefusal(r)) {
      refusal = r;
      break;
    }
    roots.push((r as ExpandResult).dag_root_task_id);
  }
  if (roots.length && roots.length !== submission.inputs.length) {
    await client.query("UPDATE claw_batches SET size = $2 WHERE batch_id = $1", [batchId, roots.length]);
  }
  return { roots, refusal };
}

export async function registerTaskReadRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { taskId: string } }>(
    "/v1/tasks/:taskId",
    async (req, reply) => {
      const task = await getTask(req.params.taskId);
      if (!task) return reply.status(404).send({ ok: false, error: "not_found" });
      const access = await requireSessionAccess(
        req, reply, task.session_id, false, false, false, DELETED_SESSION_TASK_READ_SEC,
      );
      if (!access) return reply;
      return { ok: true, item: access === "deleted" ? deletedSessionTaskView(task) : publicTaskRow(task) };
    },
  );

  app.get<{ Params: { taskId: string } }>(
    "/v1/tasks/:taskId/dag",
    async (req, reply) => {
      const row = await requireTaskAccess(req, reply, req.params.taskId, false);
      if (!row) return reply;
      const rootId = row.dag_root_task_id ?? row.task_id;
      const items = await listTasksByDag(rootId);
      return { ok: true, dag_root_task_id: rootId, items: items.map(publicTaskRow) };
    },
  );

  // Events SSE: stream a root/task snapshot, then forward the session-level
  // Brain event stream. This is intentionally generic and workbench-agnostic:
  // callers only need the root task id they received from createRun/expandDag.
  app.get<{ Params: { taskId: string } }>(
    "/v1/tasks/:taskId/events",
    async (req, reply) => {
      const row = await requireTaskAccess(req, reply, req.params.taskId, false);
      if (!row) return reply;
      const rootId = row.dag_root_task_id ?? row.task_id;
      const root = rootId === row.task_id ? row : await getTask(rootId);
      if (!root) return reply.status(404).send({ ok: false, error: "not_found" });
      await streamTaskEvents(reply, root.session_id, rootId, root);
      return reply;
    },
  );
}

async function streamTaskEvents(
  reply: FastifyReply,
  sessionId: string,
  rootId: string,
  root: ClawTaskRow,
): Promise<void> {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.write(`: connected ${new Date().toISOString()}\n\n`);
  const items = await listTasksByDag(rootId);
  const taskIds = new Set(items.map((it) => it.task_id));
  reply.raw.write(
    `data: ${JSON.stringify({ type: "snapshot", root: publicTaskRow(root), items: items.map(publicTaskRow) })}\n\n`,
  );

  const sub = nc.subscribe(`events.${sessionId}`);
  const keepalive = setInterval(() => {
    try { reply.raw.write(`: keepalive ${Date.now()}\n\n`); } catch { /* socket closed */ }
  }, 15_000);
  const cleanup = async () => {
    clearInterval(keepalive);
    try { sub.unsubscribe(); } catch { /* ignore */ }
  };
  reply.raw.on("close", cleanup);
  reply.raw.on("error", cleanup);
  (async () => {
    try {
      for await (const m of sub) {
        try {
          const evt = JSON.parse(sc.decode(m.data)) as Record<string, unknown>;
          const evtTaskId = typeof evt.task_id === "string" ? evt.task_id : undefined;
          const evtMessageId = typeof evt.message_id === "string" ? evt.message_id : undefined;
          const evtRootId = typeof evt.dag_root_task_id === "string" ? evt.dag_root_task_id : undefined;
          if (
            (evtRootId && evtRootId !== rootId) ||
            (evtTaskId && !taskIds.has(evtTaskId)) ||
            (evtMessageId && !taskIds.has(evtMessageId))
          ) {
            continue;
          }
          if (!evtRootId && !evtTaskId && !evtMessageId) continue;
          reply.raw.write(`data: ${JSON.stringify(redactPublicJson(evt))}\n\n`);
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* sub closed */
    }
  })();
}

export async function registerTaskLifecycleRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { taskId: string } }>(
    "/v1/tasks/:taskId/cancel",
    async (req, reply) => {
      if (!await requireTaskAccess(req, reply, req.params.taskId, true)) return reply;
      const r = await cancelTask(req.params.taskId);
      if (!r.ok) return reply.status(404).send({ ok: false, error: "not_found_or_terminal" });
      if (r.interrupt_key) {
        interruptDelivery.publish(r.interrupt_key);
        try {
          await Promise.race([
            interruptDelivery.flush(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("interrupt flush timed out")), 2_000)
            ),
          ]);
        } catch (error) {
          logger.warn(
            { err: error, taskId: req.params.taskId, interruptKey: r.interrupt_key },
            "task.cancel.interrupt_delivery_unconfirmed",
          );
        }
      }
      // `released` says whether the sandbox teardown that cancellation triggers
      // was actually acknowledged -- "confirmed" / "unconfirmed" / "nothing_held";
      // see ReleaseOutcome. Without it an accepted cancel and a silently failed
      // release are the same response, and a GPU workload that outlives its task
      // is invisible to the caller.
      //
      // Added, never substituted: the status code and `ok` / `cancelled` keep
      // exactly the values they had, and the field is omitted rather than
      // guessed when the branch taken established nothing, so a client that
      // does not know about it reads an unchanged response.
      return {
        ok: true,
        cancelled: r.cancelled,
        ...(r.released ? { released: r.released } : {}),
      };
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/v1/tasks/:taskId/retry",
    async (req, reply) => {
      const task = await requireTaskAccess(req, reply, req.params.taskId, true, true, true);
      if (!task) return reply;
      const user = getUser(req);
      if (!user) return reply.status(401).send({ ok: false, error: "unauthorized" });
      return await withAdmissionTransaction<unknown>(async (client) => {
        if (!(await stampCredentialsOr403(reply, task.session_id, user, client))) {
          return { commit: false, value: reply };
        }
        const r = await retryTask(req.params.taskId, client);
        // A quota refusal is not an invalid retry, and it must not survive the
        // credential stamp the same transaction rolls back.
        if ("admitted" in r) {
          await sendCreateRefusal(reply, r);
          return { commit: false, value: reply };
        }
        if (!r.ok) {
          await reply.status(409).send({ ok: false, error: "not_retryable" });
          return { commit: false, value: reply };
        }
        return { commit: true, value: { ok: true, new_task_id: r.new_task_id } };
      });
    },
  );
}

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  await registerTaskCreateRoute(app);
  await registerBatchRoute(app);
  await registerTaskReadRoutes(app);
  await registerTaskLifecycleRoutes(app);
}
