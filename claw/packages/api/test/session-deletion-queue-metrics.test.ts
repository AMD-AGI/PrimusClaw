// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

const skip = postgresSkipReason();

let cluster: PgCluster;
let endPools: () => Promise<void>;
let commitSessionDeletion: (sessionId: string) => Promise<void>;
let registry: import("prom-client").Registry;
let query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;

function sample(text: string): number {
  const line = text.split("\n").find((entry) =>
    entry.startsWith("claw_api_run_queue_exited_total{")
    && entry.includes('outcome="cancelled"'));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}

before(async () => {
  if (skip) return;
  cluster = await startPgCluster();
  process.env.DATABASE_URL = cluster.url;
  delete process.env.DB_SCHEMA;
  const dbModule = await import("../src/infra/db.js");
  await dbModule.initDb();
  query = (text, params) => dbModule.db.query(text, params);
  endPools = async () => {
    await dbModule.db.pool.end();
    await dbModule.db.lockPool.end();
  };
  ({ commitSessionDeletion } = await import("../src/sessions/teardown.js"));
  ({ registry } = await import("../src/infra/metrics.js"));
});

after(async () => {
  if (skip) return;
  await endPools();
  await cluster.end();
});

describe("session deletion closes the queue accounting after commit", { skip }, () => {
  test("only a queued chat doorbell contributes a cancelled queue exit", async () => {
    await query(
      "INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('s-delete','s','u1','claw')",
    );
    await query(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, metadata)
       VALUES
         ('queued-doorbell','s-delete','q','queued','chat','brain',
          '{"dispatch":"doorbell","queued_since":"2026-01-01T00:00:00.000Z"}'::jsonb),
         ('preparing-doorbell','s-delete','p','preparing','chat','brain',
          '{"dispatch":"doorbell"}'::jsonb),
         ('queued-task','s-delete','t','queued','task','brain','{}'::jsonb)`,
    );
    const before = sample(await registry.metrics());

    await commitSessionDeletion("s-delete");

    assert.equal(sample(await registry.metrics()) - before, 1);
    const rows = await query(
      "SELECT task_id, status FROM claw_tasks WHERE session_id = 's-delete' ORDER BY task_id",
    );
    assert.deepEqual(
      (rows.rows as Array<{ task_id: string; status: string }>).map((row) => [row.task_id, row.status]),
      [
        ["preparing-doorbell", "cancelled"],
        ["queued-doorbell", "cancelled"],
        ["queued-task", "cancelled"],
      ],
    );
  });
});
