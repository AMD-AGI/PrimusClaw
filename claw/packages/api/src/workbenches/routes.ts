// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Generic Workbench HTTP routes (workbench-architecture.md §4).
 *
 *   GET   /v1/workbenches
 *   GET   /v1/workbenches/:workbenchId
 *   GET   /v1/workbenches/:workbenchId/catalog
 *   GET   /v1/workbenches/:workbenchId/catalog/:itemId
 *   POST  /v1/workbenches/:workbenchId/runs
 *   GET   /v1/workbenches/:workbenchId/runs
 *   GET   /v1/workbenches/:workbenchId/leaderboard
 *
 * Run live state (snapshot, SSE, cancel, retry) intentionally lives at the
 * generic `/v1/tasks/:taskId/*` URLs (see routes/tasks.ts) — these workbench
 * routes are for *catalog / list / aggregation* concerns only so the
 * generic task abstraction stays primary.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import pino from "pino";
import { authMiddleware, getUser } from "../auth/middleware.js";
import {
  canAccessSession,
  isAdmin,
  type UserInfo,
} from "../auth/models.js";
import {
  assertSessionCredentialsForDispatch,
  MissingPlatformKeyError,
  sessionCredentialPatch,
} from "../auth/session-credentials.js";
import { db } from "../infra/db.js";
import { metrics } from "../infra/metrics.js";
import { loadUserEnvSnapshot } from "../crypto/user-env.js";
import { redactPublicJson } from "../events/redaction.js";
import { workbenchRegistry } from "./registry.js";
import { canExecuteTaskDag, canReadTaskDag } from "../tasks/dags/authz.js";
import { getTaskDag } from "../tasks/dags/db.js";
import { withAdmissionTransaction } from "../tasks/admission.js";
import {
  expandDag, isCreateRefusal, isTopologyRefusal, type CreateRefusal,
} from "../tasks/dag-expander.js";
import type { TaskDagDef } from "../tasks/dags/types.js";
import type { WorkbenchCtx, WorkbenchDef, RunsListItem } from "./types.js";

const logger = pino({ name: "workbench-routes" });

interface CreateRunBody {
  session_id?: string;
  [key: string]: unknown;
}

/**
 * The caller's session, or a fresh hidden one for this run.
 *
 * `created` is reported rather than counted here: the insert runs on the
 * transaction a later refusal rolls back, so only the committing caller knows
 * whether a session outlived the request.
 */
async function ensureSession(
  workbench: WorkbenchDef,
  user: UserInfo,
  body: Record<string, unknown>,
  client: PoolClient,
): Promise<{ sessionId: string; created: boolean }> {
  assertSessionCredentialsForDispatch(
    (body.session_id as string | undefined) ?? "new workbench session",
    user,
  );
  // The shared patch, not a second copy of it. This route was the only one that
  // recorded the caller's key, and the bug was the other paths not doing what it
  // did -- keeping two spellings of it is how they drift apart again.
  const runConfigPatch = sessionCredentialPatch(user);
  const provided = (body.session_id as string | undefined) ?? undefined;
  if (provided) {
    const r = await client.query(
      `SELECT session_id, user_id
         FROM claw_sessions
        WHERE session_id = $1 AND deleted_at IS NULL`,
      [provided],
    );
    if ((r.rowCount ?? 0) > 0) {
      // This call replaces session credentials before queueing work. Support
      // operators may inspect and stop a tenant run, but must not make the
      // tenant's already-queued nodes execute under the operator's identity.
      if (!canAccessSession(r.rows[0].user_id, user.userId)) {
        throw new Error("session_access_denied");
      }
      await client.query(
        `UPDATE claw_sessions
            SET config = COALESCE(config, '{}'::jsonb) || $2::jsonb
          WHERE session_id = $1`,
        [provided, JSON.stringify(runConfigPatch)],
      );
      return { sessionId: provided, created: false };
    }
  }
  const sid = (await import("node:crypto")).randomUUID();
  const sessionName = workbench.runs.sessionName
    ? workbench.runs.sessionName(body)
    : `${workbench.id}-run`;
  await client.query(
    `INSERT INTO claw_sessions (session_id, name, user_id, mode, config)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      sid,
      sessionName,
      user.userId,
      workbench.id,
      JSON.stringify({
        source: workbench.id,
        hidden: true,
        // Workbench runs create hidden sessions server-side, so the session
        // would otherwise lose the caller's SaFE platform key. Dispatcher
        // reads this value and forwards it to Brain for sandbox creation.
        // Do not rely on cluster-wide SAFE_PLATFORM_KEY in deployed envs.
        //
        // Same for the caller's virtual key: Brain needs it as llm_api_key
        // when a workbench reaches an LLM-backed authoring step.
        ...runConfigPatch,
      }),
    ],
  );
  return { sessionId: sid, created: true };
}

/** The wording every gated creation surface uses, so one refusal reads the same everywhere. */
async function sendRunRefusal(reply: FastifyReply, refusal: CreateRefusal): Promise<void> {
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

function buildCtx(req: FastifyRequest): WorkbenchCtx {
  const u = getUser(req);
  return { user_id: u?.userId ?? "anonymous", workspace_id: "default", log: logger };
}

async function publicAgentOptions(d: WorkbenchDef) {
  if (!d.public_plugins) return d.agent_options;
  return await Promise.all(Object.entries(d.public_plugins).map(async ([id, ref]) => {
    const base = d.agent_options?.find((a) => a.id === id);
    if (base?.ready === false) return base;
    try {
      await workbenchRegistry.resolvePluginRef(ref, `${d.id}:${id}`);
      return { id, label: base?.label ?? id, ready: true };
    } catch (e) {
      return {
        id,
        label: base?.label ?? id,
        ready: false,
        reason: (e as Error)?.message ?? "plugin_missing",
      };
    }
  }));
}

export async function registerWorkbenchCatalogRoutes(app: FastifyInstance): Promise<void> {
  // ── List + detail ────────────────────────────────────────────────────
  app.get("/v1/workbenches", { preHandler: authMiddleware }, async () => {
    return { workbenches: workbenchRegistry.list() };
  });

  app.get<{ Params: { workbenchId: string } }>(
    "/v1/workbenches/:workbenchId",
    { preHandler: authMiddleware },
    async (req, reply) => {
      const d = workbenchRegistry.get(req.params.workbenchId);
      if (!d) return reply.status(404).send({ ok: false, error: "workbench_not_found" });
      const dag = await getTaskDag(d.dag_id);
      const user = getUser(req);
      let pluginReady = false;
      try {
        await workbenchRegistry.resolvePlugin(d.id, {});
        pluginReady = true;
      } catch {
        pluginReady = false;
      }
      const agentOptions = await publicAgentOptions(d);
      return {
        ok: true,
        workbench: {
          id: d.id,
          title: d.title,
          description: d.description,
          plugin_ref: d.plugin_ref,
          plugins_by_agent: d.public_plugins,
          agent_options: agentOptions,
          dag_id: d.dag_id,
          batch_dag_id: d.batch_dag_id,
          ui: d.ui,
          dag_ready: !!dag && canReadTaskDag(dag, user),
          plugin_ready: pluginReady,
        },
      };
    },
  );

  // ── Catalog ──────────────────────────────────────────────────────────
  app.get<{ Params: { workbenchId: string } }>(
    "/v1/workbenches/:workbenchId/catalog",
    { preHandler: authMiddleware },
    async (req, reply) => {
      const d = workbenchRegistry.get(req.params.workbenchId);
      if (!d) return reply.status(404).send({ ok: false, error: "workbench_not_found" });
      const filters = (req.query as Record<string, unknown>) ?? {};
      return await d.catalog.list(buildCtx(req), filters);
    },
  );

  app.get<{ Params: { workbenchId: string; itemId: string } }>(
    "/v1/workbenches/:workbenchId/catalog/:itemId",
    { preHandler: authMiddleware },
    async (req, reply) => {
      const d = workbenchRegistry.get(req.params.workbenchId);
      if (!d) return reply.status(404).send({ ok: false, error: "workbench_not_found" });
      const item = await d.catalog.get(buildCtx(req), req.params.itemId);
      if (!item) return reply.status(404).send({ ok: false, error: "item_not_found" });
      return item;
    },
  );

}

export async function registerWorkbenchRunRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { workbenchId: string }; Body: CreateRunBody }>(
    "/v1/workbenches/:workbenchId/runs",
    { preHandler: authMiddleware },
    async (req, reply) => {
      const user = getUser(req);
      if (!user) return reply.status(401).send({ ok: false, error: "unauthorized" });
      const d = workbenchRegistry.get(req.params.workbenchId);
      if (!d) return reply.status(404).send({ ok: false, error: "workbench_not_found" });

      const dagRow = await getTaskDag(d.dag_id);
      if (!dagRow) {
        return reply.status(500).send({
          ok: false,
          error: "dag_missing",
          message: `seed ${d.dag_id} into /v1/task-dags first`,
        });
      }
      if (!canExecuteTaskDag(dagRow, user)) {
        return reply.status(404).send({ ok: false, error: "workbench_not_found" });
      }

      const body = req.body ?? {};
      let normalised: Record<string, unknown>;
      try {
        normalised = d.runs.normaliseInput(body, buildCtx(req));
      } catch (e) {
        return reply.status(400).send({ ok: false, error: String((e as Error)?.message || e) });
      }

      // Resolve plugin row referenced by the workbench. The expanded tasks
      // inherit sandbox image / resources / tool list from this row so DAG
      // JSON does not need to repeat them per node.
      let plugin;
      try {
        plugin = await workbenchRegistry.resolvePlugin(d.id, normalised);
      } catch (e) {
        return reply.status(500).send({
          ok: false,
          error: "plugin_missing",
          message: String((e as Error)?.message || e),
        });
      }

      // Snapshot per-user env at run-create time and embed under
      // `input.user_env`. dag-expander writes it onto every task.input
      // verbatim, so dispatcher (claw_tasks → ExecuteRequest) can lift it
      // back out and inject into Brain's sandbox podSpec.env. Sweep parity
      // with chat /messages path (routes/sessions.ts).
      const userEnvSnapshot = await loadUserEnvSnapshot(db, user.userId, logger);
      const inputWithEnv = Object.keys(userEnvSnapshot).length
        ? { ...normalised, user_env: userEnvSnapshot }
        : normalised;

      // `ensureSession` may create a session outright, and a refusal must not
      // leave it behind: it runs on the transaction the refusal rolls back,
      // whose first statement is the admission lock.
      return await withAdmissionTransaction<unknown>(
        (client) => submitWorkbenchRun(client, {
          workbench: d, user, body, reply, dagRow, plugin, input: inputWithEnv,
        }),
      );
    },
  );
}

interface WorkbenchRunSubmission {
  workbench: WorkbenchDef;
  user: UserInfo;
  body: CreateRunBody;
  reply: FastifyReply;
  dagRow: unknown;
  plugin: { id: number; version: string; image: string; resource: Record<string, unknown>; tools: unknown[] };
  input: Record<string, unknown>;
}

async function submitWorkbenchRun(
  client: PoolClient,
  run: WorkbenchRunSubmission,
): Promise<{ commit: boolean; value: unknown }> {
  const { reply } = run;
  let session: { sessionId: string; created: boolean };
  try {
    session = await ensureSession(run.workbench, run.user, run.body, client);
  } catch (e) {
    if ((e as Error)?.message === "session_access_denied") {
      await reply.status(403).send({ ok: false, error: "session_access_denied" });
      return { commit: false, value: reply };
    }
    if (e instanceof MissingPlatformKeyError) {
      await reply.status(403).send({ ok: false, error: "missing_platform_key" });
      return { commit: false, value: reply };
    }
    throw e;
  }
  const { sessionId } = session;

  const result = await expandDag({
    session_id: sessionId,
    user_id: run.user.userId,
    dag: run.dagRow as TaskDagDef & { metadata: { derived: any } },
    plugin: run.plugin,
    input: run.input,
  }, client);
  if (isCreateRefusal(result)) {
    await sendRunRefusal(reply, result);
    return { commit: false, value: reply };
  }
  logger.info(
    {
      workbench_id: run.workbench.id,
      run_id: result.dag_root_task_id,
      session_id: sessionId,
      plugin_id: run.plugin.id,
      plugin_version: run.plugin.version,
    },
    "workbench.run.created",
  );
  if (session.created) metrics.onSessionCreated("ok");
  return {
    commit: true,
    value: { ok: true, run_id: result.dag_root_task_id, session_id: sessionId },
  };
}

export async function registerWorkbenchRunListRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { workbenchId: string } }>(
    "/v1/workbenches/:workbenchId/runs",
    { preHandler: authMiddleware },
    async (req, reply) => {
      const user = getUser(req);
      if (!user) return reply.status(401).send({ ok: false, error: "unauthorized" });
      const d = workbenchRegistry.get(req.params.workbenchId);
      if (!d) return reply.status(404).send({ ok: false, error: "workbench_not_found" });
      const q = (req.query as Record<string, unknown>) ?? {};
      const limit = Math.min(Math.max(Number(q.limit ?? "50"), 1), 200);
      const offset = Math.max(Number(q.offset ?? "0"), 0);
      const where: string[] = [
        `r.dag_node_id = '__dag_root__'`,
        `r.dag_id = $1`,
      ];
      const params: unknown[] = [d.dag_id];
      if (!isAdmin(user)) {
        params.push(user.userId);
        where.push(
          `EXISTS (
             SELECT 1 FROM claw_sessions s
              WHERE s.session_id = r.session_id
                AND s.deleted_at IS NULL
                AND s.user_id = $${params.length}
           )`,
        );
      }
      if (q.status && q.status !== "all") {
        params.push(q.status);
        where.push(`r.status = $${params.length}`);
      }
      if (d.runs.extraWhere) {
        const extra = d.runs.extraWhere(q, params.length + 1);
        if (extra) {
          where.push(extra.fragment);
          params.push(...extra.params);
        }
      }

      const cnt = await db.query(
        `SELECT COUNT(*)::int AS n FROM claw_tasks r WHERE ${where.join(" AND ")}`,
        params,
      );
      const total = Number(cnt.rows[0]?.n ?? 0);
      const summaryNodeId = d.runs.summary_node_id;
      const summaryNodeExpr = summaryNodeId ? `$${params.length + 1}` : "''";
      if (summaryNodeId) params.push(summaryNodeId);
      params.push(limit, offset);
      const r = await db.query(
        `SELECT r.task_id, r.session_id, r.dag_id, r.status, r.failure_reason, r.error_message,
                r.input, r.metadata, r.created_at, r.completed_at,
                e.metadata AS evaluate_metadata,
                e.captures AS evaluate_captures,
                e.status   AS evaluate_status
           FROM claw_tasks r
           LEFT JOIN claw_tasks e
             ON e.dag_root_task_id = r.task_id AND e.dag_node_id = ${summaryNodeExpr}
          WHERE ${where.join(" AND ")}
          ORDER BY r.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      const runs: RunsListItem[] = r.rows.map((row) => {
        // Reuse the workbench-declared summary node id so `rowToSummary`'s
        // `c.dag_node_id === <expected>` lookup works for workbenches whose
        // child node is not literally named "evaluate".
        const evalChild = row.evaluate_metadata
          ? {
              dag_node_id: summaryNodeId ?? "evaluate",
              metadata: row.evaluate_metadata,
              captures: row.evaluate_captures,
              status: row.evaluate_status,
            }
          : undefined;
        const summary = d.runs.rowToSummary(row, evalChild ? [evalChild] : []);
        return {
          run_id: row.task_id,
          session_id: row.session_id,
          dag_id: row.dag_id,
          status: row.status,
          failure_reason: row.failure_reason,
          error_message: row.error_message,
          input: redactPublicJson(row.input) as Record<string, unknown>,
          summary: redactPublicJson(summary) as typeof summary,
          created_at: row.created_at,
          completed_at: row.completed_at,
        };
      });
      return { runs, total };
    },
  );

}

export async function registerWorkbenchLeaderboardRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { workbenchId: string } }>(
    "/v1/workbenches/:workbenchId/leaderboard",
    { preHandler: authMiddleware },
    async (req, reply) => {
      const d = workbenchRegistry.get(req.params.workbenchId);
      if (!d) return reply.status(404).send({ ok: false, error: "workbench_not_found" });
      const filters = (req.query as Record<string, unknown>) ?? {};
      return await d.leaderboard.query(buildCtx(req), filters);
    },
  );
}

export async function registerWorkbenchRoutes(app: FastifyInstance): Promise<void> {
  await registerWorkbenchCatalogRoutes(app);
  await registerWorkbenchRunRoutes(app);
  await registerWorkbenchRunListRoutes(app);
  await registerWorkbenchLeaderboardRoutes(app);
}
