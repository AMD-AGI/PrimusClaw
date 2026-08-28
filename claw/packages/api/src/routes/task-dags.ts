// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Task DAG template CRUD routes (task-design.md §11.1).
 *
 *   GET   /v1/task-dags                     list (filter by plugin_id / status)
 *   GET   /v1/task-dags/:dag_id             fetch one
 *   POST  /v1/task-dags                     upsert + admission validate
 *   DELETE /v1/task-dags/:dag_id            soft-delete (sets status='deleted')
 *
 * All routes require an authenticated SaFE user; admin token is *not* the
 * primary authn here (DAGs are owned by users / plugins like other
 * marketplace assets). Trust-level enforcement lives inside `validateDag`.
 */
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { getUser } from "../auth/middleware.js";
import { isSystemAdmin } from "../auth/models.js";
import { BadRequestError } from "../shared/errors.js";
import { validateDag } from "../tasks/dags/admission.js";
import { canReadTaskDag } from "../tasks/dags/authz.js";
import { getTaskDag, insertTaskDag, listTaskDags, softDeleteTaskDag } from "../tasks/dags/db.js";
import type { TaskDagDef } from "../tasks/dags/types.js";

const logger = pino({ name: "task-dags" });

function badRequest(message: string) {
  return { ok: false as const, error: "bad_request", message };
}

export async function registerTaskDagRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/v1/task-dags",
    async (req, reply) => {
      const user = getUser(req);
      if (!user) return reply.status(401).send({ ok: false, error: "unauthorized" });
      const q = (req.query as Record<string, string | undefined>) ?? {};
      const filters: { plugin_id?: number; status?: string; owner_user_id?: string } = {};
      if (q.plugin_id) {
        const n = Number(q.plugin_id);
        if (Number.isFinite(n)) filters.plugin_id = n;
      }
      if (q.status) filters.status = q.status;
      const rows = await listTaskDags(filters);
      return { ok: true, items: rows.filter((row) => canReadTaskDag(row, user)) };
    },
  );

  app.get<{ Params: { dagId: string } }>(
    "/v1/task-dags/:dagId",
    async (req, reply) => {
      const user = getUser(req);
      if (!user) return reply.status(401).send({ ok: false, error: "unauthorized" });
      const row = await getTaskDag(req.params.dagId);
      if (!row || !canReadTaskDag(row, user)) {
        return reply.status(404).send({ ok: false, error: "not_found" });
      }
      return { ok: true, item: row };
    },
  );

  app.post(
    "/v1/task-dags",
    async (req, reply) => {
      const user = getUser(req);
      if (!user) return reply.status(401).send({ ok: false, error: "unauthorized" });

      const body = (req.body ?? {}) as Partial<TaskDagDef>;
      const def: TaskDagDef = {
        dag_id: String(body.dag_id ?? "").trim(),
        name: String(body.name ?? "").trim(),
        version: body.version ? String(body.version).trim() : "1.0.0",
        description: body.description ? String(body.description) : undefined,
        plugin_id: body.plugin_id != null ? Number(body.plugin_id) : null,
        trust_level: body.trust_level ?? "user",
        input_schema: body.input_schema ?? {},
        nodes: Array.isArray(body.nodes) ? body.nodes : [],
        batch_aggregator: body.batch_aggregator ?? null,
        metadata: body.metadata ?? {},
        owner_user_id: isSystemAdmin(user) ? (body.owner_user_id ?? user.userId) : user.userId,
        is_public: body.is_public ?? true,
        status: body.status ?? "active",
      };

      if (!def.dag_id) return reply.status(400).send(badRequest("dag_id required"));
      if (!def.name) return reply.status(400).send(badRequest("name required"));

      // Only admins may declare `trust_level='platform'`; everyone else is
      // forced to 'user' so trust-only features (GPU / backend tools /
      // image digests) are rejected at admission below.
      if (def.trust_level === "platform" && !isSystemAdmin(user)) {
        return reply.status(403).send({
          ok: false,
          error: "forbidden",
          message: "trust_level='platform' requires admin",
        });
      }

      try {
        const { derived } = await validateDag(def);
        const row = await insertTaskDag(def, derived, user.userId, isSystemAdmin(user));
        if (!row) {
          return reply.status(403).send({
            ok: false,
            error: "forbidden",
            message: "dag_id is owned by another user",
          });
        }
        logger.info({ dag_id: def.dag_id, version: def.version }, "task_dag.upserted");
        return { ok: true, item: row };
      } catch (e) {
        if (e instanceof BadRequestError) {
          return reply.status(400).send(badRequest(e.message));
        }
        logger.error({ err: (e as Error).message }, "task_dag.upsert_failed");
        return reply.status(500).send({ ok: false, error: "internal_error", message: (e as Error).message });
      }
    },
  );

  app.delete<{ Params: { dagId: string } }>(
    "/v1/task-dags/:dagId",
    async (req, reply) => {
      const user = getUser(req);
      if (!user) return reply.status(401).send({ ok: false, error: "unauthorized" });

      const row = await getTaskDag(req.params.dagId);
      if (!row) return reply.status(404).send({ ok: false, error: "not_found" });
      // authz: ownership is enforced inside softDeleteTaskDag, which only marks
      // the row when the caller owns it or is a full system-admin, and reports
      // that as false rather than throwing.
      const ok = await softDeleteTaskDag(req.params.dagId, user.userId, isSystemAdmin(user));
      return ok ? { ok: true } : reply.status(403).send({ ok: false, error: "forbidden" });
    },
  );
}
