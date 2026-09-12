// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The admission modules, booted against a private schema on a real Postgres.
 *
 * Reuses {@link startPgCluster}: PGlite has one in-process connection, and
 * nothing holding `pg_advisory_xact_lock` there can be contended by a second
 * session, so every assertion about two writers racing needs a server.
 *
 * `ADMIT_*` and `DATABASE_URL` are read once when the modules load, so they are
 * set before the dynamic imports and cannot be set by a static one.
 */

import type pg from "pg";

import { startPgCluster, type PgCluster } from "./pg-cluster.js";

export type AdmissionModules = {
  admission: typeof import("../../src/tasks/admission.js");
  chatRun: typeof import("../../src/tasks/chat-run.js");
  dagExpander: typeof import("../../src/tasks/dag-expander.js");
  lifecycle: typeof import("../../src/tasks/lifecycle.js");
  metrics: typeof import("../../src/infra/metrics.js");
  runClaim: typeof import("../../src/tasks/run-claim.js");
  sessions: typeof import("../../src/routes/sessions.js");
  scheduler: typeof import("../../src/tasks/scheduler.js");
  db: typeof import("../../src/infra/db.js");
};

export interface AdmissionCluster {
  app: AdmissionModules;
  cluster: PgCluster;
  /** A second connection, for the writer a test races against the first. */
  connect(): Promise<pg.Client>;
  stop(): Promise<void>;
}

export async function startAdmissionCluster(
  env: Record<string, string>,
): Promise<AdmissionCluster> {
  const cluster = await startPgCluster();
  process.env.DATABASE_URL = cluster.url;
  delete process.env.DB_SCHEMA;
  process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  process.env.RUN_DOORBELL_DISPATCH ??= "true";
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  let app: AdmissionModules | undefined;
  try {
    app = {
      admission: await import("../../src/tasks/admission.js"),
      chatRun: await import("../../src/tasks/chat-run.js"),
      dagExpander: await import("../../src/tasks/dag-expander.js"),
      lifecycle: await import("../../src/tasks/lifecycle.js"),
      metrics: await import("../../src/infra/metrics.js"),
      runClaim: await import("../../src/tasks/run-claim.js"),
      sessions: await import("../../src/routes/sessions.js"),
      scheduler: await import("../../src/tasks/scheduler.js"),
      db: await import("../../src/infra/db.js"),
    };
    await app.db.initDb();
  } catch (err) {
    // Open pools outlive a failed start, and node:test then waits on them
    // instead of reporting why the suite could not begin.
    await app?.db.db.pool.end().catch(() => {});
    await cluster.end().catch(() => {});
    throw err;
  }

  return {
    app,
    cluster,
    connect: () => cluster.connect(),
    async stop() {
      await app!.db.db.pool.end().catch(() => {});
      await app!.db.db.lockPool.end().catch(() => {});
      await cluster.end();
    },
  };
}

/**
 * Make the next `COMMIT` on a checked-out connection fail, having rolled back.
 *
 * A commit reported as failed whose writes survive is not a commit failure, so
 * the transaction is discarded before the caller is told. Only the argument-less
 * form is wrapped: `pool.query` reaches the same method with a callback, and a
 * wrapper that swallowed it would hang every statement in the process.
 *
 * @returns a restore function; call it before asserting on anything.
 */
export function failNextCommit(pool: pg.Pool): () => void {
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  let armed = true;
  (pool as { connect: unknown }).connect = (...args: unknown[]) => {
    if (args.length) return connect(...args);
    return (connect() as Promise<pg.PoolClient>).then((client) => {
      const query = client.query.bind(client) as (...a: unknown[]) => unknown;
      (client as { query: unknown }).query = (text: unknown, ...rest: unknown[]) => {
        if (armed && text === "COMMIT") {
          armed = false;
          return (query("ROLLBACK") as Promise<unknown>)
            .then(() => { throw new Error("forced commit failure"); });
        }
        return query(text, ...rest);
      };
      return client;
    });
  };
  return () => { (pool as { connect: unknown }).connect = connect; };
}

/** Seed one `executor='brain'` row directly, bypassing every gate under test. */
export async function seedRun(
  q: pg.Client,
  row: {
    taskId: string;
    sessionId: string;
    status: string;
    origin?: string;
    dagRoot?: string | null;
    sandbox?: boolean;
    gpuNodes?: number;
    dependsOn?: string[];
  },
): Promise<void> {
  await q.query(
    `INSERT INTO claw_tasks (
       task_id, session_id, name, status, origin, executor, dag_root_task_id,
       sandbox_spec, input, metadata, depends_on, created_at, queued_at
     ) VALUES ($1, $2, 'seed', $3, $4, 'brain', $5, $6::jsonb, $7::jsonb, '{}'::jsonb, $8, NOW(), NOW())`,
    [
      row.taskId, row.sessionId, row.status, row.origin ?? "task", row.dagRoot ?? null,
      row.sandbox ? '"default"' : null,
      JSON.stringify(row.gpuNodes ? { topology: { nodes: row.gpuNodes } } : {}),
      row.dependsOn ?? [],
    ],
  );
}
