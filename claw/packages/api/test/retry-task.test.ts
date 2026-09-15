// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * retryTask clones a failed row. Chat rows are a turn's shadow, not a job, and
 * the clone drops origin and workspace_id -- so a retried chat run would look
 * like a DAG-less task with no lease. Refuse that rather than mint it.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import type { PoolClient } from "pg";

import { db } from "../src/infra/db.js";
import { retryTask } from "../src/tasks/lifecycle.js";

const originalQuery = db.query;
after(() => { db.query = originalQuery; });

test("a failed chat row is not cloned", async () => {
  const seen: string[] = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    seen.push(text.replace(/\s+/g, " ").trim());
    if (/SELECT \* FROM claw_tasks WHERE task_id/.test(text)) {
      return {
        rows: [{
          task_id: params[0],
          status: "failed",
          origin: "chat",
          dag_root_task_id: null,
          metadata: {},
        }],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected query: ${text}`);
  }) as typeof db.query;

  assert.deepEqual(await retryTask("ktsk_chat"), { ok: false });
  assert.equal(seen.length, 1, "must not INSERT a replacement after refusing");
});

/**
 * The clone and the `retried_into` pointer back at it are one unit. The route
 * runs the whole retry inside `withAdmissionTransaction`, so a marker written
 * on a connection of its own would commit ahead of the clone it names -- and
 * would have to take a second connection out of the pool the request is
 * already holding one of to do it.
 */
test("the retried_into marker rides the caller's transaction", async () => {
  db.query = (async (text: string) => {
    throw new Error(`retry took a second connection from the pool: ${text}`);
  }) as typeof db.query;

  const onClient: string[] = [];
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      onClient.push(text.replace(/\s+/g, " ").trim());
      if (/SELECT \* FROM claw_tasks WHERE task_id/.test(text)) {
        return {
          rows: [{
            task_id: params[0], status: "failed", origin: "task",
            dag_root_task_id: null, metadata: {},
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const r = await retryTask("ktsk_txn", client as unknown as PoolClient);
  assert.equal(r.ok, true);
  const marker = onClient.find((q) => /UPDATE claw_tasks SET metadata/.test(q));
  assert.ok(marker, "the marker is written on the client, not on the pool");
  // Merged server-side rather than re-written from the snapshot read at the
  // top of retryTask, so a concurrent metadata writer is not reverted.
  assert.match(marker, /\|\| jsonb_build_object\('retried_into', \$2::text\)/);
});
