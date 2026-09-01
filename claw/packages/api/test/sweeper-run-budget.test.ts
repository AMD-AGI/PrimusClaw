// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the sweeper does to a run that outlived its budget.
 *
 * It used to write `failed / brain_timeout` onto the row and stop. Nothing told
 * the Brain process, which carried on calling the model and holding its
 * sandbox while the UI showed the run as failed -- and for DAG rows,
 * reapOrphanHandles then destroyed that sandbox within a tick, leaving the live
 * process to die on its next tool call with an error mentioning neither a
 * timeout nor a budget. Two properties are pinned here: the row is judged
 * against its own deadline, and something is actually told to stop.
 *
 * `db.query` and the sweeper's interrupt publisher are both replaceable, so
 * stubs drive the whole function without a database or a broker.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import { interruptPublisher, reapStaleTasks } from "../src/tasks/sweeper.js";
import { RUN_BUDGET_BACKSTOP_GRACE_SEC } from "../src/tasks/run-budget.js";

interface SeenQuery { sql: string; params: unknown[] }

const originalQuery = db.query;
const originalPublisher = { ...interruptPublisher };
after(() => {
  db.query = originalQuery;
  Object.assign(interruptPublisher, originalPublisher);
});

function stubDb(reaped: Array<Record<string, unknown>>): SeenQuery[] {
  const seen: SeenQuery[] = [];
  db.query = (async (text: string, params: unknown[] = []) => {
    seen.push({ sql: text.replace(/\s+/g, " ").trim(), params });
    return { rows: reaped, rowCount: reaped.length };
  }) as typeof db.query;
  return seen;
}

function stubBus(): { published: string[]; flushes: number } {
  const state = { published: [] as string[], flushes: 0 };
  Object.assign(interruptPublisher, {
    available: () => true,
    publish: (subject: string) => { state.published.push(subject); },
    flush: async () => { state.flushes++; },
  });
  return state;
}

const CHAT_RUN = {
  task_id: "t-chat", session_id: "s-1",
  dag_root_task_id: null, deadline_at: "2026-01-01T00:00:00.000Z",
};
const DAG_NODE = {
  task_id: "t-node", session_id: "s-2",
  dag_root_task_id: "t-root", deadline_at: "2026-01-01T00:00:00.000Z",
};

test("a reaped run is told to stop, not merely marked failed", async () => {
  stubDb([CHAT_RUN]);
  const bus = stubBus();

  assert.equal(await reapStaleTasks(), 1);
  assert.deepEqual(bus.published, ["interrupt.s-1"],
    "writing a row does not reach the process that is still burning compute");
  assert.equal(bus.flushes, 1, "an unflushed publish can be lost when the tick ends");
});

test("chat runs are out of reach while their rows are only being shadowed", async () => {
  // Chat turns write rows here now, but as a record to be compared against the
  // sessions they shadow -- not yet as something to act on. Acting on one is
  // worse than a wrong row: reaping publishes an interrupt keyed by session,
  // and a session outlives any single turn, so a row left open by a bug and
  // reaped an hour later would abort whatever the user is running by then.
  const seen = stubDb([]);
  stubBus();
  await reapStaleTasks();

  assert.match(
    seen[0].sql,
    /origin IS DISTINCT FROM 'chat'/,
    "the exclusion has to survive; without it the shadow phase has teeth",
  );
  assert.equal(
    seen[0].params[3], false,
    "and is on by default, so enabling it is a deliberate act",
  );
  // IS DISTINCT FROM rather than <>, because rows written before `origin`
  // existed have NULL there and `NULL <> 'chat'` is NULL, which would quietly
  // exclude every legacy row from the backstop.
  assert.doesNotMatch(seen[0].sql, /origin <> 'chat'/);
});

test("the virtual DAG root is exempt by rule, not by luck", async () => {
  // The root is inserted at 'running' and never dispatched, so it has no lease
  // and no started_at, and both arms of the backstop miss it -- which is a
  // protection that lasts exactly as long as nobody stamps one of those columns
  // on an insert. reapStuckDagRoots is what judges the root, against its
  // children; the hour this backstop uses would close a healthy graph.
  const seen = stubDb([]);
  stubBus();
  await reapStaleTasks();

  assert.match(seen[0].sql, /executor IS DISTINCT FROM 'dag'/);
  assert.doesNotMatch(
    seen[0].sql,
    /executor <> 'dag'/,
    "rows written before executor was always set have NULL there",
  );
});

test("the interrupt goes to the key Brain registered its abort under", async () => {
  stubDb([DAG_NODE]);
  const bus = stubBus();
  await reapStaleTasks();

  assert.deepEqual(bus.published, ["interrupt.t-root"],
    "graph nodes are keyed by DAG root, the same way cancelTask derives it");
});

test("a whole DAG timing out produces one interrupt, not one per node", async () => {
  stubDb([
    DAG_NODE,
    { ...DAG_NODE, task_id: "t-node-2" },
    { ...DAG_NODE, task_id: "t-node-3" },
  ]);
  const bus = stubBus();
  await reapStaleTasks();

  assert.deepEqual(bus.published, ["interrupt.t-root"], "every node of a DAG shares one abort key");
});

test("nothing reaped means nothing published", async () => {
  stubDb([]);
  const bus = stubBus();

  assert.equal(await reapStaleTasks(), 0);
  assert.deepEqual(bus.published, []);
});

test("a broker that is gone does not undo the rows already committed", async () => {
  stubDb([CHAT_RUN]);
  Object.assign(interruptPublisher, { available: () => false });

  // The tick can outlive a NATS reconnect. The run is terminal either way; the
  // interrupt only closes the gap where the process is still alive.
  assert.equal(await reapStaleTasks(), 1);
});

test("a publish that throws does not abandon the remaining runs", async () => {
  stubDb([CHAT_RUN, { ...DAG_NODE }]);
  const published: string[] = [];
  Object.assign(interruptPublisher, {
    available: () => true,
    publish: (subject: string) => {
      published.push(subject);
      if (subject === "interrupt.s-1") throw new Error("connection draining");
    },
    flush: async () => {},
  });

  assert.equal(await reapStaleTasks(), 2);
  assert.deepEqual(published, ["interrupt.s-1", "interrupt.t-root"],
    "one unreachable run must not silently strand the others");
});

test("a run is judged against its own deadline, with the grace period applied", async () => {
  const seen = stubDb([]);
  stubBus();
  await reapStaleTasks();

  const sql = seen[0]!.sql;
  assert.match(sql, /deadline_at IS NOT NULL\s+AND deadline_at < NOW\(\)/,
    "a run that declared a longer budget must actually get it");
  assert.ok(seen[0]!.params.includes(RUN_BUDGET_BACKSTOP_GRACE_SEC),
    "the grace period is what lets the run report its own ending first");
});

test("a run no worker ever claimed falls back to the old global timeout", async () => {
  const seen = stubDb([]);
  stubBus();
  await reapStaleTasks();

  // The lease is written by whoever executes the run, so a row the API moved to
  // `preparing` and nothing picked up has none to expire -- and its deadline is
  // a whole budget away, which for a graph node is a day of a stalled DAG. Rows
  // predating `deadline_at`, and rows run by a worker too old to take a lease,
  // reach this arm for the same reason and get the ceiling they always had.
  assert.match(
    seen[0]!.sql,
    /lease_expires_at IS NULL\s+AND started_at IS NOT NULL/,
    "a row nothing ever claimed must not wait out a budget it never started spending",
  );
});

test("cancellation intent survives the reap", async () => {
  const seen = stubDb([]);
  stubBus();
  await reapStaleTasks();

  assert.match(seen[0]!.sql, /WHEN status = 'cancelling' THEN 'cancelled'/,
    "a run the user already stopped must not be reported as a budget failure");
});

test("a cancelled run's two columns agree about what happened to it", async () => {
  // `failure_reason` had the cancelling branch and `error_message` did not, so a
  // row the user stopped, reaped once its deadline had passed, was archived as
  // `cancelled / cancelled` carrying "run budget exhausted at ..." -- the one
  // field an operator reads first, saying the one thing that did not happen.
  const seen = stubDb([]);
  stubBus();
  await reapStaleTasks();

  const errorMessage = /error_message = CASE (.*?) END, completed_at/.exec(seen[0]!.sql)?.[1];
  assert.ok(errorMessage, "the error_message CASE has moved; this test is reading the wrong text");
  // Position, not prose. Asserting how the branch is introduced pins the
  // comment above it as well, so deleting a comment fails a test about
  // precedence -- and rewording one looks like a behaviour change.
  const cancelledAt = errorMessage.indexOf("WHEN status = 'cancelling'");
  const budgetAt = errorMessage.indexOf("WHEN deadline_at IS NOT NULL");
  assert.ok(cancelledAt >= 0, "a run the user already stopped needs a branch of its own");
  assert.ok(budgetAt >= 0, "and the budget branch is what it has to take precedence over");
  assert.ok(cancelledAt < budgetAt,
    "first, so it takes precedence over the budget branch the way the reason does");
  assert.match(errorMessage, /THEN 'the run was cancelled/,
    "and it says the run was cancelled, which is the whole point of the branch");
  assert.match(errorMessage, /run budget exhausted at/,
    "the budget wording is still what a row that really ran out of budget gets");
});

test("a budget failure is labelled as one, distinct from the legacy timeout", async () => {
  const seen = stubDb([]);
  stubBus();
  await reapStaleTasks();

  assert.match(seen[0]!.sql, /THEN 'run_budget_exhausted'/);
  assert.match(seen[0]!.sql, /ELSE 'brain_timeout'/,
    "the two have different causes and should not be greppable as one");
});

test("a run reaped for never being claimed is not called a budget failure", async () => {
  const seen = stubDb([]);
  stubBus();
  await reapStaleTasks();

  // Such a row does have a `deadline_at` -- hours in the future, which is why
  // the second arm exists -- so the label has to follow the condition that
  // fired rather than the presence of the column.
  assert.match(
    seen[0]!.sql,
    /deadline_at < NOW\(\)[^)]*\)\s+THEN 'run_budget_exhausted'/,
    "the budget label belongs to rows that actually spent their budget",
  );
  assert.doesNotMatch(
    seen[0]!.sql,
    /deadline_at IS NOT NULL\s+THEN 'run_budget_exhausted'/,
    "a row nobody ever picked up would be reported as having burned a budget it never started",
  );
});

test("a run with a budget of its own is not closed by the legacy timeout", () => {
  // REGRESSION GUARD.
  //
  // A DAG node is dispatched by a path that issues no run_lease, so
  // `lease_expires_at` stays NULL for its whole life. That made the never-claimed
  // arm decisive for every graph node, and RUN_BUDGET_DAG_NODE_SEC therefore only
  // worked downwards: a node given three days was closed as `brain_timeout` after
  // BRAIN_TASK_TIMEOUT_SEC -- an hour by default -- with the budget above it dead
  // letter. A Kernel Arena run is an hour to three days, so every one of them
  // would have died in the first hour.
  const seen = stubDb([]);
  stubBus();
  return reapStaleTasks().then(() => {
    const sql = seen[0]?.sql ?? "";
    assert.match(
      sql,
      /deadline_at IS NULL AND lease_expires_at IS NULL/,
      "the never-claimed arm still fires on rows that carry an explicit budget",
    );
    // The budget arm is untouched: a row past its own deadline is still reaped.
    assert.match(sql, /deadline_at IS NOT NULL AND deadline_at < NOW\(\)/);
  });
});

test("a run with no budget still gets the legacy backstop", async () => {
  // The case the never-claimed arm was written for: nothing holds a lease, nothing
  // stamped a deadline, and without it the row would sit at `running` forever.
  const seen = stubDb([{ task_id: "t-old", session_id: "s-3", dag_root_task_id: null, deadline_at: null }]);
  stubBus();
  assert.equal(await reapStaleTasks(), 1);
  assert.match(seen[0].sql, /started_at < NOW\(\) - \(\$1::int/);
});
