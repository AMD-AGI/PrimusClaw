// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What cancelling a task inside a DAG is allowed to write.
 *
 * Two properties are pinned here, both of which look like omissions until the
 * reason is stated, and both of which someone will eventually "fix" by widening
 * a status list:
 *
 *   1. A row that is executing goes to `cancelling`, never straight to
 *      `cancelled`. It owns a Brain run and a sandbox, and a terminal status
 *      written behind Brain's back stops neither -- the work keeps burning a GPU
 *      and a late `agent_done` overwrites the outcome. `cancelling` is the state
 *      that waits for Brain to acknowledge.
 *   2. The downstream cascade therefore only closes rows that cannot be
 *      executing. It does not need to reach further: `promoteReadyTasks` leaves
 *      `waiting_deps` only when EVERY dependency is `completed`, and the row we
 *      just cancelled is not, so nothing downstream of it can have started.
 *
 * `db.query` is a property on an exported object, so a stub drives the whole
 * function without a database.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import { cancelTask } from "../src/tasks/lifecycle.js";

interface SeenQuery { sql: string; params: unknown[] }

const originalQuery = db.query;
after(() => { db.query = originalQuery; });

/** Answers as if `task` were the only row, and every UPDATE matched it. */
function stubDb(task: Record<string, unknown>): SeenQuery[] {
  const seen: SeenQuery[] = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    seen.push({ sql, params });
    if (sql.startsWith("SELECT * FROM claw_tasks WHERE task_id")) {
      return params[0] === task.task_id ? { rows: [task], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("UPDATE claw_tasks SET status")) {
      return { rows: [{ ...task, status: params[0] }], rowCount: 1 };
    }
    if (sql.startsWith("WITH RECURSIVE downstream")) return { rows: [], rowCount: 0 };
    throw new Error(`stubDb: unexpected query ${sql.slice(0, 80)}`);
  }) as typeof db.query;
  return seen;
}

const RUNNING_IN_DAG = {
  task_id: "t-mid",
  session_id: "s-1",
  status: "running",
  dag_node_id: "n-mid",
  dag_root_task_id: "t-root",
};

test("cancelling a running task hands it to Brain instead of closing it", async () => {
  const seen = stubDb(RUNNING_IN_DAG);
  const r = await cancelTask("t-mid");

  assert.deepEqual(r, { ok: true, cancelled: 1, interrupt_key: "t-root" });

  const transition = seen.find((q) => q.sql.startsWith("UPDATE claw_tasks SET status"));
  assert.ok(transition);
  assert.equal(
    transition!.params[0], "cancelling",
    "a running row must not be marked terminal while Brain and its sandbox are still live",
  );
  // The interrupt is published against the DAG root, which is also the key Brain
  // serialises a DAG's execution under, so the abort reaches the running node.
  assert.equal(r.interrupt_key, RUNNING_IN_DAG.dag_root_task_id);
});

test("the downstream cascade closes only rows that cannot be executing", async () => {
  const seen = stubDb(RUNNING_IN_DAG);
  await cancelTask("t-mid");

  const cascade = seen.find((q) => q.sql.startsWith("WITH RECURSIVE downstream"));
  assert.ok(cascade, "a task inside a DAG must close its transitive tail");
  assert.match(
    cascade!.sql,
    /status IN \('waiting_deps','waiting_external','queued'\)/,
    "the cascade targets the pre-execution states",
  );
  assert.doesNotMatch(
    cascade!.sql,
    /'preparing'|'running'|'cancelling'/,
    "widening this to rows that may be executing would mark live work terminal without stopping it",
  );
});

test("a queued task is closed outright, since nothing is executing yet", async () => {
  const seen = stubDb({ ...RUNNING_IN_DAG, status: "queued" });
  await cancelTask("t-mid");

  const transition = seen.find((q) => q.sql.startsWith("UPDATE claw_tasks SET status"));
  assert.equal(transition!.params[0], "cancelled");
  // The expected-status guard still admits `running`: the row may have started
  // between the read and the write, and losing that race must not silently skip
  // the cancel.
  assert.deepEqual(
    transition!.params[transition!.params.length - 1],
    ["waiting_deps", "waiting_external", "queued", "preparing", "running"],
  );
});

test("a preparing task is handed to Brain too, because it may already be executing", async () => {
  // The case this whole distinction existed for and never covered. The
  // dispatcher sets `preparing` at the moment it publishes the execution
  // message, so such a row can already own a sandbox and a Brain run. While
  // nothing moved rows on to `running`, every executing task looked pending
  // here and was closed outright -- precisely what the `cancelling` state
  // exists to prevent.
  const seen = stubDb({ ...RUNNING_IN_DAG, status: "preparing" });
  const r = await cancelTask("t-mid");

  const transition = seen.find((q) => q.sql.startsWith("UPDATE claw_tasks SET status"));
  assert.equal(
    transition!.params[0], "cancelling",
    "a preparing row may be executing, so it must wait for Brain to acknowledge",
  );
  assert.equal(r.interrupt_key, "t-root");
});

test("a standalone task cancels without a cascade and interrupts by session", async () => {
  const seen = stubDb({
    task_id: "t-solo", session_id: "s-1", status: "running",
    dag_node_id: null, dag_root_task_id: null,
  });
  const r = await cancelTask("t-solo");

  assert.equal(r.interrupt_key, "s-1", "with no DAG the session is the interrupt scope");
  assert.equal(
    seen.some((q) => q.sql.startsWith("WITH RECURSIVE downstream")), false,
    "a task with no DAG has no edges to walk",
  );
});

test("cancelling an unknown task reports failure without writing", async () => {
  const seen = stubDb(RUNNING_IN_DAG);
  assert.deepEqual(await cancelTask("t-missing"), { ok: false, cancelled: 0 });
  assert.equal(seen.length, 1, "only the lookup runs");
});
