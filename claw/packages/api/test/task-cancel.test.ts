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

interface SeenQuery {
  sql: string;
  params: unknown[];
  rows?: Array<Record<string, unknown>>;
}

const originalQuery = db.query;
const originalConnect = db.pool.connect;
after(() => { db.query = originalQuery; db.pool.connect = originalConnect; });

/**
 * The statement that moved the row.
 *
 * Every writer of `status` is the one transition function now, so this is a
 * single shape -- but the single-task path writes a per-row CASE where the
 * cascade writes a literal, and the selection is about which statement it is
 * rather than about how the status happens to be spelled.
 */
function transitionOf(seen: SeenQuery[]): SeenQuery | undefined {
  return seen.find((q) => q.sql.startsWith("UPDATE claw_tasks SET status"));
}

/**
 * Answers as if `task` were the only row, and every UPDATE matched it.
 *
 * Both database paths, because the single-task transition takes a connection
 * of its own: the prior state has to be read under the row's lock in the same
 * transaction that writes over it, and a `db.query` stub never sees that.
 */
function stubDb(task: Record<string, unknown>): SeenQuery[] {
  const seen: SeenQuery[] = [];
  const answer = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [], rowCount: 0 };
    const query: SeenQuery = { sql, params };
    seen.push(query);
    if (sql.startsWith("SELECT * FROM claw_tasks WHERE task_id")) {
      return params[0] === task.task_id ? { rows: [task], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // The status the row is leaving, plus the dispatch marker and sojourn
    // stamp the queue-exit metric is measured from. It cannot come off the
    // UPDATE: RETURNING answers with what the row became.
    if (sql.startsWith("SELECT status AS prior_status")) {
      const metadata = task.metadata as Record<string, unknown> | undefined;
      const cancellable = params[1] as string[];
      if (!cancellable.includes(String(task.status))) return { rows: [], rowCount: 0 };
      query.rows = [{
        prior_status: task.status,
        prior_dispatch: metadata?.dispatch ?? null,
        prior_queued_since: metadata?.queued_since ?? null,
      }];
      return { rows: query.rows, rowCount: 1 };
    }
    if (sql.startsWith("UPDATE claw_tasks SET status")) {
      // A literal for the cascade, a per-row CASE for the single task: the
      // conditional is what a Stop on a row that may be executing writes.
      const literal = /SET status = '(\w+)'/.exec(sql)?.[1];
      const parked = (params[2] as string[] | undefined) ?? [];
      const status = literal
        ?? (parked.includes(String(task.status)) ? "cancelling" : "cancelled");
      query.rows = [{ ...task, status }];
      return { rows: query.rows, rowCount: 1 };
    }
    throw new Error(`stubDb: unexpected query ${sql.slice(0, 80)}`);
  };
  db.query = answer as typeof db.query;
  db.pool.connect = (async () => ({
    query: answer, release: () => {},
  })) as unknown as typeof db.pool.connect;
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

  const transition = transitionOf(seen);
  assert.ok(transition);
  // The status is a per-row expression here -- executing rows go to
  // `cancelling`, the rest close outright -- so the property is what the row
  // actually became, which the SQL text cannot show.
  assert.equal(
    transition!.rows?.[0]?.status, "cancelling",
    "a running row must not be marked terminal while Brain and its sandbox are still live",
  );
  // The interrupt is published against the DAG root, which is also the key Brain
  // serialises a DAG's execution under, so the abort reaches the running node.
  assert.equal(r.interrupt_key, RUNNING_IN_DAG.dag_root_task_id);
});

test("the downstream cascade closes only rows that cannot be executing", async () => {
  const seen = stubDb(RUNNING_IN_DAG);
  await cancelTask("t-mid");

  // The recursion is inside the predicate now: one statement writes a status,
  // so a CTE cannot prefix it.
  const cascade = seen.find((q) => /WITH RECURSIVE downstream/.test(q.sql) && q !== seen[1]);
  assert.ok(cascade, "a task inside a DAG must close its transitive tail");
  assert.match(
    cascade!.sql,
    /status IN \('waiting_deps','waiting_external','queued'\)/,
    "the cascade targets the pre-execution states",
  );
  assert.doesNotMatch(
    cascade!.sql.replace(/^UPDATE claw_tasks SET status = 'cancelled'/, ""),
    /'preparing'|'running'|'cancelling'/,
    "widening this to rows that may be executing would mark live work terminal without stopping it",
  );
});

test("a queued task is closed outright, since nothing is executing yet", async () => {
  const seen = stubDb({ ...RUNNING_IN_DAG, status: "queued" });
  await cancelTask("t-mid");

  const transition = transitionOf(seen);
  assert.equal(transition!.rows?.[0]?.status, "cancelled",
    "nothing is executing, so the row closes outright");
  // The expected-status guard still admits `running`: the row may have started
  // between the read and the write, and losing that race must not silently skip
  // the cancel.
  assert.deepEqual(
    transition!.params[1],
    ["waiting_deps", "waiting_external", "queued", "preparing", "running"],
    "the write decides from the status it locks, including a concurrent start",
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

  const transition = transitionOf(seen);
  assert.equal(
    transition!.rows?.[0]?.status, "cancelling",
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
