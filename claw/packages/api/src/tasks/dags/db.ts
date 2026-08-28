// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `claw_task_dags` row helpers (task-design.md §6.1).
 *
 * Thin SQL wrappers; no business logic. Admission lives in `./admission.ts`
 * and route plumbing in `../../routes/task-dags.ts`.
 */
import { db } from "../../infra/db.js";
import type { TaskDagDef, DagDerived } from "./types.js";

export interface TaskDagRow {
  dag_id: string;
  name: string;
  version: string;
  description: string | null;
  plugin_id: number | null;
  trust_level: "platform" | "user";
  input_schema: Record<string, unknown>;
  nodes: Record<string, unknown>[];
  batch_aggregator: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  owner_user_id: string | null;
  is_public: boolean;
  status: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export async function getTaskDag(dagId: string): Promise<TaskDagRow | null> {
  const r = await db.query(
    `SELECT * FROM claw_task_dags WHERE dag_id = $1 AND deleted_at IS NULL`,
    [dagId],
  );
  return (r.rowCount ?? 0) > 0 ? (r.rows[0] as TaskDagRow) : null;
}

export async function insertTaskDag(
  def: TaskDagDef,
  derived: DagDerived,
  actorUserId: string,
  fullAdmin: boolean,
): Promise<TaskDagRow | null> {
  const metadata = { ...(def.metadata ?? {}), derived };
  const r = await db.query(
    `INSERT INTO claw_task_dags
       (dag_id, name, version, description, plugin_id, trust_level,
        input_schema, nodes, batch_aggregator, metadata, owner_user_id,
        is_public, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13)
     ON CONFLICT (dag_id) DO UPDATE SET
       name = EXCLUDED.name,
       version = EXCLUDED.version,
       description = EXCLUDED.description,
       plugin_id = EXCLUDED.plugin_id,
       trust_level = EXCLUDED.trust_level,
       input_schema = EXCLUDED.input_schema,
       nodes = EXCLUDED.nodes,
       batch_aggregator = EXCLUDED.batch_aggregator,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     WHERE claw_task_dags.owner_user_id = $14 OR $15::boolean
     RETURNING *`,
    [
      def.dag_id,
      def.name,
      def.version ?? "1.0.0",
      def.description ?? null,
      def.plugin_id ?? null,
      def.trust_level ?? "user",
      JSON.stringify(def.input_schema ?? {}),
      JSON.stringify(def.nodes ?? []),
      def.batch_aggregator ? JSON.stringify(def.batch_aggregator) : null,
      JSON.stringify(metadata),
      def.owner_user_id ?? null,
      def.is_public ?? true,
      def.status ?? "active",
      actorUserId,
      fullAdmin,
    ],
  );
  return (r.rowCount ?? 0) > 0 ? (r.rows[0] as TaskDagRow) : null;
}

export async function listTaskDags(filters: {
  plugin_id?: number;
  owner_user_id?: string;
  status?: string;
}): Promise<TaskDagRow[]> {
  const where: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];
  if (filters.plugin_id !== undefined) {
    params.push(filters.plugin_id);
    where.push(`plugin_id = $${params.length}`);
  }
  if (filters.owner_user_id) {
    params.push(filters.owner_user_id);
    where.push(`owner_user_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }
  const r = await db.query(
    `SELECT * FROM claw_task_dags WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`,
    params,
  );
  return r.rows as TaskDagRow[];
}

export async function softDeleteTaskDag(
  dagId: string,
  actorUserId: string,
  fullAdmin: boolean,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE claw_task_dags SET status = 'deleted', deleted_at = NOW(), updated_at = NOW()
     WHERE dag_id = $1 AND deleted_at IS NULL
       AND (owner_user_id = $2 OR $3::boolean)`,
    [dagId, actorUserId, fullAdmin],
  );
  return (r.rowCount ?? 0) > 0;
}
