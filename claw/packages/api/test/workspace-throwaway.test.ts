// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `workspace_throwaway` from the request that declares it to the row that
 * carries it.
 *
 * The flag turns off the post-run upload of /workspace to S3 for a task that has
 * already delivered its output somewhere of its own. It has one job on this side
 * -- survive intact from the DAG template to `claw_tasks` -- and one place it can
 * quietly stop doing it: `retryTask` clones a failed row column by column, so a
 * column left out of that list is a flag that holds until the first retry and
 * then silently reverts to uploading gigabytes.
 *
 * Coverage:
 *   R1 a non-boolean on the DAG is refused
 *   R2 a non-boolean on a node is refused
 *   R3 a retry clone carries the flag rather than defaulting it
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import { retryTask } from "../src/tasks/lifecycle.js";
import { validateDag } from "../src/tasks/dags/admission.js";
import type { TaskDagDef } from "../src/tasks/dags/types.js";

const originalQuery = db.query;
after(() => { db.query = originalQuery; });

function dagWith(over: Record<string, unknown>): TaskDagDef {
  return {
    dag_id: "dag-throwaway",
    name: "throwaway",
    nodes: [{ id: "n1", executor: "brain", mode: "llm", sandbox: "none" }],
    ...over,
  } as TaskDagDef;
}

test("R1 a non-boolean workspace_throwaway on the DAG is refused", async () => {
  await assert.rejects(
    () => validateDag(dagWith({ workspace_throwaway: "yes" })),
    /workspace_throwaway must be a boolean/,
  );
});

test("R2 a non-boolean workspace_throwaway on a node is refused", async () => {
  await assert.rejects(
    () => validateDag(dagWith({
      nodes: [{
        id: "n1", executor: "brain", mode: "llm", sandbox: "none",
        workspace_throwaway: 1,
      }],
    })),
    /node n1: workspace_throwaway must be a boolean/,
  );
});

test("R3 a retry clone carries workspace_throwaway", async () => {
  // The clone is one INSERT ... SELECT, so the evidence is in its column list:
  // a name missing from both halves takes the column default, which is false.
  let insert = "";
  db.query = (async (text: string, params: unknown[] = []) => {
    if (/SELECT \* FROM claw_tasks WHERE task_id/.test(text)) {
      return {
        rows: [{
          task_id: params[0], status: "failed", origin: "dag_node",
          dag_root_task_id: null, metadata: {},
        }],
        rowCount: 1,
      };
    }
    if (/INSERT INTO claw_tasks/.test(text)) { insert = text; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  assert.equal((await retryTask("ktsk_retry")).ok, true);
  const [columns, select] = insert.split(/\bSELECT\b/);
  assert.match(columns, /workspace_throwaway/, "named in the INSERT column list");
  assert.match(select, /workspace_throwaway/, "and read from the row being cloned");
});
