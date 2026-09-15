// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Two ways the sandbox teardown would destroy a sandbox that is still in use.
 *
 * Both are older than this branch and neither has ever fired, for one reason:
 * the API read the wrong KV bucket, so every teardown it ran found an empty
 * handle map and did nothing at all. Fixing the bucket is what makes these
 * reachable, which makes them this branch's to fix — a change whose entire
 * purpose is to stop sandboxes leaking must not start killing live ones on the
 * way.
 *
 * Both are invisible to the code they live in. Each reads as a correct
 * predicate over the wrong set: one asks for a row shape half the handles do
 * not have, the other trusts a derivation that answers a subtly different
 * question than the one being asked.
 *
 * Coverage:
 *   L1 a standalone task's sandbox is not reaped as an orphan while it runs
 *   L2 a terminal standalone task's sandbox still is
 *   L3 a handle is not torn down while a sibling node is still running
 *   L4 and is torn down once the siblings are terminal
 *   L5 a sandbox the NEXT task in the session is reusing is not reaped
 *   L6 re-cancelling a finished DAG does not stop what a newer DAG reuses
 *   L7 a workload another DAG still holds is not stopped by this one's teardown
 *   L8 and one nobody else holds still is
 *   L9 a co-holder dropped by the scan does not permit the stop
 *   L10 an enumeration ended by a closed connection does not permit the stop
 *   L11 a scan that hangs does not hold the cancel open
 */
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SAFE_API_URL = "http://safe.test";

const { db } = await import("../src/infra/db.js");
const { handleRegistry, unreleasedRecord } = await import("../src/tasks/sandbox-stopper.js");
const { reapOrphanHandles } = await import("../src/tasks/sweeper.js");
const { stopAllHandlesForDag } = await import("../src/tasks/sandbox-stopper.js");
const { cancelTask } = await import("../src/tasks/lifecycle.js");
const { applyAgentDone } = await import("../src/tasks/lifecycle.js");

const originalQuery = db.query;
const originalRegistry = { ...handleRegistry };
const originalRecord = { ...unreleasedRecord };
const originalFetch = globalThis.fetch;
function restoreAll(): void {
  db.query = originalQuery;
  Object.assign(handleRegistry, originalRegistry);
  Object.assign(unreleasedRecord, originalRecord);
  globalThis.fetch = originalFetch;
}
after(restoreAll);
afterEach(restoreAll);

let stopped: string[];
beforeEach(() => {
  stopped = [];
  unreleasedRecord.mark = async () => {};
  unreleasedRecord.clear = async () => {};
  unreleasedRecord.any = async () => false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    stopped.push(/\/workloads\/([^/]+)\/stop$/.exec(url)?.[1] ?? url);
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
});

/** One handle registered for `owner`, as Brain registers it. */
function handleFor(owner: string, workloadId = "w-live"): void {
  const live = new Map([["main", workloadId]]);
  handleRegistry.listAll = async () => [
    [owner, Object.fromEntries([...live].map(([n, w]) => [n, { workload_id: w }]))],
  ];
  handleRegistry.listForDag = async () =>
    Object.fromEntries([...live].map(([n, w]) => [n, { workload_id: w }]));
  // The teardown confirms an empty read against the leader before it may
  // answer `confirmed` or `nothing_held`. The stub agrees with itself: what
  // the snapshot says, the leader says.
  handleRegistry.listForDagConsistent = async () =>
    Object.fromEntries([...live].map(([n, w]) => [n, { workload_id: w }]));
  handleRegistry.listDagRoots = async () => [owner];
  handleRegistry.lookup = async (_d: string, n: string) =>
    live.has(n) ? { workload_id: live.get(n)! } : null;
  handleRegistry.destroy = async (_d: string, n: string) => {
    const w = live.get(n) ?? null;
    live.delete(n);
    return w;
  };
}

test("L1 a standalone task's sandbox is not reaped as an orphan while it runs", async () => {
  // Brain registers a handle under `dag_root_task_id ?? task_id`, so a
  // standalone task owns one under its own task id -- and a standalone task's
  // `dag_node_id` is NULL, never '__dag_root__'. The reaper's lookup demanded
  // that value, matched nothing, read the row as `missing`, and tore the
  // sandbox out from under a task that was still running on it.
  handleFor("t-solo");
  // Answers as the real database would for a standalone task: it HAS a row,
  // and that row's `dag_node_id` is NULL. Ordering matters -- the old predicate
  // is checked first, so restoring it makes this test fail rather than being
  // rescued by a looser prefix match on the new query.
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.includes("dag_node_id = '__dag_root__'")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT status, session_id FROM claw_tasks")) {
      return { rows: [{ status: "running", session_id: "s-1" }], rowCount: 1 };
    }
    // The session-liveness guard: this task is the live one.
    if (sql.startsWith("SELECT 1 FROM claw_tasks")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  await reapOrphanHandles();

  assert.deepEqual(
    stopped, [],
    "a running task owns its sandbox; the shape of the task does not change that",
  );
});

test("L2 a terminal standalone task's sandbox still is reaped", async () => {
  // The other half: the fix must not be "never reap a standalone task", or the
  // leak this whole branch is about simply moves.
  handleFor("t-solo");
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.includes("dag_node_id = '__dag_root__'")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT status, session_id FROM claw_tasks")) {
      return { rows: [{ status: "completed", session_id: "s-1" }], rowCount: 1 };
    }
    // Nothing live in the session either.
    if (sql.startsWith("SELECT 1 FROM claw_tasks")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  await reapOrphanHandles();

  assert.deepEqual(stopped, ["w-live"], "a finished task's sandbox is exactly what this sweep is for");
});

test("L3 a handle is not torn down while a sibling node is still running", async () => {
  // `handle_last_user` is the last node in TOPOLOGICAL order that names the
  // handle, not the last one to finish. Siblings A and B both using a handle
  // created upstream order as [root, A, B], so the map says B -- and B
  // finishing first would tear the sandbox down with A still on it.
  handleFor("t-root");
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT * FROM claw_tasks WHERE task_id")) {
      return {
        rows: [{
          task_id: "t-b", session_id: "s-1", status: "running",
          dag_node_id: "B", dag_root_task_id: "t-root", metadata: {},
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("UPDATE claw_tasks SET status")) {
      return {
        rows: [{
          task_id: "t-b", session_id: "s-1", status: "completed",
          dag_node_id: "B", dag_root_task_id: "t-root",
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("SELECT metadata FROM claw_tasks")) {
      return { rows: [{ metadata: { derived: { handle_last_user: { main: "B" } } } }], rowCount: 1 };
    }
    // Node A, still running.
    if (sql.startsWith("SELECT 1 FROM claw_tasks")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  await applyAgentDone("t-b", { status: "completed" } as never);

  assert.deepEqual(
    stopped, [],
    "the derivation named B last; it did not promise A had finished",
  );
});

test("L4 and the handle is torn down once the siblings are terminal", async () => {
  handleFor("t-root");
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT * FROM claw_tasks WHERE task_id")) {
      return {
        rows: [{
          task_id: "t-b", session_id: "s-1", status: "running",
          dag_node_id: "B", dag_root_task_id: "t-root", metadata: {},
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("UPDATE claw_tasks SET status")) {
      return {
        rows: [{
          task_id: "t-b", session_id: "s-1", status: "completed",
          dag_node_id: "B", dag_root_task_id: "t-root",
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("SELECT metadata FROM claw_tasks")) {
      return { rows: [{ metadata: { derived: { handle_last_user: { main: "B" } } } }], rowCount: 1 };
    }
    // Nothing else live.
    if (sql.startsWith("SELECT 1 FROM claw_tasks")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  await applyAgentDone("t-b", { status: "completed" } as never);

  assert.deepEqual(
    stopped, ["w-live"],
    "with every other node finished, the last user really is the last user",
  );
});

test("L5 a sandbox the next task in the session is reusing is not reaped", async () => {
  // The registering task being terminal does not mean the sandbox is idle.
  // Brain keeps a finished task's pod warm as `hands.<session>`, and the next
  // message in the same session reuses it without moving the DAG handle's
  // ownership. So T1 completes, T2 picks up the same workload, and a sweep
  // reading only T1 stops the sandbox T2 is running on. The two are
  // sequential: this needs no race at all, it is the normal shape of a
  // session, which is why "the owner is terminal" is not enough on its own.
  handleFor("t-1");
  handleRegistry.listAll = async () => [
    ["t-1", { main: { workload_id: "w-live", session_id: "s-1" } }],
  ];
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT status, session_id FROM claw_tasks")) {
      return { rows: [{ status: "completed", session_id: "s-1" }], rowCount: 1 };
    }
    // T2, still running in the same session on the reused sandbox.
    if (sql.startsWith("SELECT 1 FROM claw_tasks")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  await reapOrphanHandles();

  assert.deepEqual(
    stopped, [],
    "the workload belongs to the session while the session still has live work",
  );
});

test("L6 re-cancelling a finished DAG does not stop what a newer DAG reuses", async () => {
  // Entirely sequential, and every step is ordinary. D1 finishes without its
  // `agent_done` teardown firing -- the topological last user deferred to a
  // live sibling, and the sibling that finished last was not the last user --
  // so D1 is marked completed with its handle still registered. D2 then reuses
  // the warm sandbox and registers its own reference to the same workload.
  //
  // A second cancel of D1 matched no rows and went on to tear that workload
  // down anyway: it killed D2, and answered `cancelled: 0, released:
  // "confirmed"` -- both halves wrong at once, and the `confirmed` is the
  // worse one, because it says the thing it just broke was cleanly released.
  handleFor("t-d1");
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT * FROM claw_tasks WHERE task_id")) {
      return {
        rows: [{
          task_id: "t-d1", session_id: "s-1", status: "completed",
          dag_node_id: "__dag_root__", dag_root_task_id: "t-d1",
        }],
        rowCount: 1,
      };
    }
    // Already terminal: the cancelling UPDATE matches nothing.
    if (sql.startsWith("UPDATE claw_tasks SET status")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  const r = await cancelTask("t-d1");

  assert.deepEqual(
    stopped, [],
    "a DAG that already finished has no sandboxes of its own left to stop",
  );
  assert.equal(r.cancelled, 0);
  assert.equal(
    "released" in r, false,
    "and it must not claim a release it did not perform -- `confirmed` here named a workload it had just killed",
  );
});

test("L7 a workload another DAG still holds is not stopped by this one's teardown", async () => {
  // Reuse registers the adopting DAG's own handle against the same workload,
  // so a sandbox can legitimately be held by two DAGs at once. D1 being
  // cancelled -- or simply finishing -- would then stop the sandbox D2 is
  // running on. Sequential, no race: it is what session reuse is for.
  db.query = (async () => ({ rows: [{ config: {} }], rowCount: 1 })) as typeof db.query;
  // The destroy really removes it, so the end-of-teardown re-read sees an
  // empty DAG. A stub that kept answering would decide the outcome for the
  // re-read's reason instead of for anything about sharing.
  handleFor("dag-1", "w-shared");
  handleRegistry.listAll = async () => [
    // D2 adopted the same workload and registered its own reference.
    ["dag-2", { main: { workload_id: "w-shared" } }],
  ];

  const released = await stopAllHandlesForDag("dag-1", "s-1");

  assert.deepEqual(stopped, [], "the sandbox D2 is running on must survive D1's teardown");
  assert.equal(
    released, "unconfirmed",
    "this DAG let go and the workload is still held -- not a failure, and not a release",
  );
});

test("L8 and one nobody else holds still is stopped", async () => {
  // The guard must not become "never stop anything": with no other holder the
  // teardown proceeds exactly as before.
  db.query = (async () => ({ rows: [{ config: {} }], rowCount: 1 })) as typeof db.query;
  handleFor("dag-1", "w-solo");
  handleRegistry.listAll = async () => [
    ["dag-2", { other: { workload_id: "w-unrelated" } }],
  ];

  const released = await stopAllHandlesForDag("dag-1", "s-1");

  assert.deepEqual(stopped, ["w-solo"]);
  assert.equal(released, "confirmed");
});

test("L9 a co-holder dropped by the scan does not permit the stop", async () => {
  // The shared-holder guard is built on direct reads, so the answer it exists
  // to give -- "nobody else holds this" -- can be wrong in the one direction
  // that kills a live sandbox.
  //
  // And the drop is total, which is what the first version of this test got
  // wrong: it left `["dag-2", {}]` in the scan, so the leader re-check still
  // had a DAG to look at. `scanPrefix` removes a row whose read came back
  // absent, tombstoned or empty -- exactly what a stale replica produces -- so
  // D2 is not in the rows at all. The re-check has to start from the enumerated
  // KEYS or it will check everything except the DAG that needed it.
  db.query = (async () => ({ rows: [{ config: {} }], rowCount: 1 })) as typeof db.query;
  handleFor("dag-1", "w-shared");
  handleRegistry.listAll = async () => [
    ["dag-1", { main: { workload_id: "w-shared" } }],
    // D2 is gone entirely: its read came back stale and the scan dropped it.
  ];
  handleRegistry.listDagRoots = async () => ["dag-1", "dag-2"];
  handleRegistry.listForDagConsistent = async (dag: string) =>
    dag === "dag-2" ? { main: { workload_id: "w-shared" } } : {};

  const released = await stopAllHandlesForDag("dag-1", "s-1");

  assert.deepEqual(stopped, [], "the sandbox D2 is running on must survive");
  assert.equal(released, "unconfirmed");
});

test("L10 an enumeration that ended on a closed connection does not permit the stop", async () => {
  // `for await` completing is not the same as the enumeration being complete.
  // A connection that exhausts its reconnects and closes ends the iterator the
  // way exhaustion does -- no error, just fewer keys -- so a truncated list
  // reads as the whole registry: zero DAGs to leader-check, and a stop issued
  // over a co-holder that was never delivered.
  db.query = (async () => ({ rows: [{ config: {} }], rowCount: 1 })) as typeof db.query;
  handleFor("dag-1", "w-shared");
  handleRegistry.listAll = async () => [["dag-1", { main: { workload_id: "w-shared" } }]];
  handleRegistry.listDagRoots = async () => {
    throw new Error("dag-handles enumeration ended on a closed connection");
  };

  const released = await stopAllHandlesForDag("dag-1", "s-1");

  assert.deepEqual(
    stopped, [],
    "an enumeration that cannot be trusted must not be read as sole ownership",
  );
  assert.equal(released, "unconfirmed");
});

test("L11 a shared-holder check that hangs does not hold the cancel open", async () => {
  // The SDK's ordered consumer rebuilds and retries indefinitely when
  // JetStream is unavailable while the core connection stays healthy, so the
  // enumeration simply never ends. Unbounded, that hangs the cancel request --
  // and with it the interrupt, which the route publishes only after
  // `cancelTask` returns. The row would read cancelled while Brain was never
  // told, which is worse than either answer this check can give.
  //
  // Expiring is the same unknown as a failed read and takes the same
  // conservative answer: decline to stop.
  db.query = (async () => ({ rows: [{ config: {} }], rowCount: 1 })) as typeof db.query;
  handleFor("dag-1", "w-shared");
  handleRegistry.listAll = async () => [["dag-1", { main: { workload_id: "w-shared" } }]];
  handleRegistry.listDagRoots = () => new Promise(() => { /* never settles */ });

  const started = process.hrtime.bigint();
  const released = await stopAllHandlesForDag("dag-1", "s-1");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(released, "unconfirmed", "an unestablished ownership declines to stop");
  assert.deepEqual(stopped, [], "and issues no stop on the strength of a scan that never finished");
  assert.ok(
    elapsedMs < 30_000,
    `the cancel must not wait on the scan indefinitely (waited ${Math.round(elapsedMs)}ms)`,
  );
});
