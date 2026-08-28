// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * retryTask clones a failed row. Chat rows are a turn's shadow, not a job, and
 * the clone drops origin and workspace_id -- so a retried chat run would look
 * like a DAG-less task with no lease. Refuse that rather than mint it.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

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
