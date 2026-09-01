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
import { interruptSubject } from "@claw/protocol";
import pino from "pino";
import { getUser } from "../auth/middleware.js";
import {
  canAccessSessionAsOperator,
  canWriteSessionAsOperator,
} from "../auth/models.js";
import { db } from "../infra/db.js";
import { nc, sc } from "../infra/nats.js";
import { canExecuteTaskDag } from "../tasks/dags/authz.js";
import { getTaskDag } from "../tasks/dags/db.js";
import type { UserInfo } from "../auth/models.js";
import { MissingPlatformKeyError, stampSessionCredentials } from "../auth/session-credentials.js";
import { createSingleTask, expandDag } from "../tasks/dag-expander.js";
import { getTask, listTasksByDag } from "../tasks/db.js";
import { cancelTask, retryTask } from "../tasks/lifecycle.js";
import { newBatchId } from "../tasks/ids.js";
import { enrichPluginToolsInline, pluginSandboxImage } from "../marketplace/plugins.js";
import { publicTaskRow, redactPublicJson } from "../events/redaction.js";
import type { TaskDagDef } from "../tasks/dags/types.js";
import type { ClawTaskRow } from "../tasks/types.js";

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
): Promise<boolean> {
  try {
    await stampSessionCredentials(sessionId, user);
    return true;
  } catch (error) {
    if (!(error instanceof MissingPlatformKeyError)) throw error;
    logger.warn({ sessionId, userId: user.userId }, "task.submit_without_platform_key");
    await reply.status(403).send({ ok: false, error: "missing_platform_key" });
    return false;
  }
}

interface CreateTaskBody {
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
}

async function requireSessionAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  write: boolean,
): Promise<boolean> {
  const session = (await db.query(
    "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
    [sessionId],
  )).rows[0] as { user_id?: string | null } | undefined;
  if (!session) {
    reply.status(404).send({ ok: false, error: "session_not_found" });
    return false;
  }
  const user = getUser(req);
  const allowed = write
    ? canWriteSessionAsOperator(session.user_id, user)
    : canAccessSessionAsOperator(session.user_id, user);
  if (!allowed) {
    reply.status(403).send({ ok: false, error: "access_denied" });
    return false;
  }
  return true;
}

async function requireTaskAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  taskId: string,
  write: boolean,
): Promise<ClawTaskRow | null> {
  const task = await getTask(taskId);
  if (!task) {
    reply.status(404).send({ ok: false, error: "not_found" });
    return null;
  }
  if (!await requireSessionAccess(req, reply, task.session_id, write)) return null;
  return task;
}

async function loadPluginRow(pluginId: number) {
  const r = await db.query(
    `SELECT id, name, version, images, resource, tools FROM plugins
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

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { sessionId: string }; Body: CreateTaskBody }>(
    "/v1/sessions/:sessionId/tasks",
    async (req, reply) => {
      const user = getUser(req);
      if (!user) return reply.status(401).send({ ok: false, error: "unauthorized" });

      const sessionId = req.params.sessionId;
      const body = req.body ?? {};

      if (!await requireSessionAccess(req, reply, sessionId, true)) return reply;

      let dag = body.dag_id ? await getTaskDag(body.dag_id) : null;
      let plugin = body.plugin_id ? await loadPluginRow(body.plugin_id) : null;
      if (!dag && plugin?.resource?.task_dag_id) {
        dag = await getTaskDag(plugin.resource.task_dag_id as string);
      }
      if (dag && !plugin && dag.plugin_id) plugin = await loadPluginRow(dag.plugin_id);
      if (body.dag_id && !dag) {
        return reply.status(404).send({ ok: false, error: "dag_not_found" });
      }
      if (dag && !canExecuteTaskDag(dag, user)) {
        return reply.status(404).send({ ok: false, error: "dag_not_found" });
      }

      if (!dag) {
        if (!(await stampCredentialsOr403(reply, sessionId, user))) return reply;
        const single = await createSingleTask({
          session_id: sessionId,
          plugin_id: body.plugin_id ?? null,
          input: body.input ?? {},
          prompt: body.prompt,
          mode: "llm",
          workspace_throwaway: body.workspace_throwaway === true,
          sandbox_spec: plugin
            ? { handle: "main", image: plugin.image, resources: plugin.resource }
            : "none",
        });
        return { ok: true, task_id: single.task_id };
      }

      // Record the caller's own credentials on the session before anything is
      // queued. A task is dispatched long after this request has gone, and the
      // session row is the only thing that carries the submitter that far --
      // which is why the path that skipped this ran every workload under the
      // cluster's shared identity.
      if (!(await stampCredentialsOr403(reply, sessionId, user))) return reply;

      const result = await expandDag({
        session_id: sessionId,
        user_id: user.userId,
        dag: dag as unknown as TaskDagDef & { metadata: { derived: any } },
        plugin: plugin
          ? { id: plugin.id, version: plugin.version, image: plugin.image, resource: plugin.resource, tools: plugin.tools ?? [] }
          : null,
        input: body.input ?? {},
        prompt: body.prompt,
      });
      logger.info({ sessionId, dag_id: dag.dag_id, dag_root_task_id: result.dag_root_task_id }, "task_dag.created");
      return { ok: true, ...result };
    },
  );

  app.post(
    "/v1/batches",
    async (req, reply) => {
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
      if (!await requireSessionAccess(req, reply, body.session_id, true)) return reply;

      const dag = await getTaskDag(body.dag_id);
      if (!dag || !canExecuteTaskDag(dag, user)) {
        return reply.status(404).send({ ok: false, error: "dag_not_found" });
      }
      const plugin = body.plugin_id ? await loadPluginRow(body.plugin_id) : (dag.plugin_id ? await loadPluginRow(dag.plugin_id) : null);

      const batchId = newBatchId();
      const client = await db.pool.connect();
      const roots: string[] = [];
      try {
        await client.query("BEGIN");
        // Inside the transaction that creates the batch: a batch whose rows exist
        // without the credential stamped would dispatch under the wrong identity,
        // and the two facts belong to the same decision.
        await stampSessionCredentials(body.session_id, user, client);
        await client.query(
          `INSERT INTO claw_batches (batch_id, session_id, user_id, dag_id, size, status)
           VALUES ($1,$2,$3,$4,$5,'running')`,
          [batchId, body.session_id, user.userId, body.dag_id, body.inputs.length],
        );
        for (const input of body.inputs) {
          const r = await expandDag({
            session_id: body.session_id,
            user_id: user.userId,
            dag: dag as unknown as TaskDagDef & { metadata: { derived: any } },
            plugin: plugin
              ? { id: plugin.id, version: plugin.version, image: plugin.image, resource: plugin.resource, tools: plugin.tools ?? [] }
              : null,
            input,
            batch_id: batchId,
          }, client);
          roots.push(r.dag_root_task_id);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      return { ok: true, batch_id: batchId, dag_root_task_ids: roots };
    },
  );

  app.get<{ Params: { taskId: string } }>(
    "/v1/tasks/:taskId",
    async (req, reply) => {
      const row = await requireTaskAccess(req, reply, req.params.taskId, false);
      if (!row) return reply;
      return { ok: true, item: publicTaskRow(row) };
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

  app.post<{ Params: { taskId: string } }>(
    "/v1/tasks/:taskId/cancel",
    async (req, reply) => {
      if (!await requireTaskAccess(req, reply, req.params.taskId, true)) return reply;
      const r = await cancelTask(req.params.taskId);
      if (!r.ok) return reply.status(404).send({ ok: false, error: "not_found_or_terminal" });
      if (r.interrupt_key) {
        nc.publish(interruptSubject(r.interrupt_key));
        try {
          await Promise.race([
            nc.flush(),
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
      return { ok: true, cancelled: r.cancelled };
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/v1/tasks/:taskId/retry",
    async (req, reply) => {
      if (!await requireTaskAccess(req, reply, req.params.taskId, true)) return reply;
      const r = await retryTask(req.params.taskId);
      if (!r.ok) return reply.status(409).send({ ok: false, error: "not_retryable" });
      return { ok: true, new_task_id: r.new_task_id };
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
      const sessionId = root.session_id;
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
      return reply;
    },
  );
}
