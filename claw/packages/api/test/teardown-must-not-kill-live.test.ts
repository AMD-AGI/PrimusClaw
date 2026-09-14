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
 */
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SAFE_API_URL = "http://safe.test";

const { db } = await import("../src/infra/db.js");
const { handleRegistry, unreleasedRecord } = await import("../src/tasks/sandbox-stopper.js");
const { reapOrphanHandles } = await import("../src/tasks/sweeper.js");
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
  db.query = (async (text: string) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT status, session_id FROM claw_tasks")) {
      return { rows: [{ status: "running", session_id: "s-1" }], rowCount: 1 };
    }
    // The old predicate. Answering nothing here is what the real database does
    // for a standalone task, and is what made this reachable.
    if (sql.includes("dag_node_id = '__dag_root__'")) return { rows: [], rowCount: 0 };
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
    if (sql.startsWith("SELECT status, session_id FROM claw_tasks")) {
      return { rows: [{ status: "completed", session_id: "s-1" }], rowCount: 1 };
    }
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
