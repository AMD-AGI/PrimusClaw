// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The orphan sweep must judge by WHICH workload live work holds, not by
 * whether the session has any live work at all.
 *
 * The session-wide form of the guard deferred a reap whenever any task in the
 * session was non-terminal, regardless of what that task was running on.
 * Reproduced against real Postgres/NATS: T1 completes on W1; T2 in the same
 * session changes the image, cannot reuse W1, and creates W2; T2 then sits
 * `preparing` waiting for the GPU W1 is still holding. Consecutive sweeps each
 * saw a live task and each skipped W1, Brain's keepalive kept it alive, and W1
 * was released only when T2 eventually timed out -- the deferral was what
 * prevented the work that would have ended the deferral.
 *
 * Narrowing it is only possible because `scanPrefix` no longer truncates: it
 * used to await `kv.get` inside the `for await` over `kv.keys()`, stalling the
 * ordered consumer so it ended early and silently (21 live keys in the real
 * DAG_HANDLES bucket, 1 row returned). Every registry-wide scan was built on
 * it, so a per-workload question could not be answered. Re-measured on the
 * live bucket for this change: 23 keys, `get`-inside-the-loop returns 1 row,
 * drain-then-read returns 23.
 *
 * These drive the REAL `reapOrphanHandles` over a real Postgres (PGlite runs
 * the same statements the cluster does) with the registry and the `hands`
 * bucket as substituted stores, and assert on outcomes: which workload a stop
 * was issued against, and whether the workload the live task is waiting on got
 * the GPU.
 *
 * Coverage:
 *   H1 THE DEFECT: a finished task's workload is released while a live task in
 *      the same session waits on a different one -- and that lets it run
 *   H2 CONTROL: a genuine orphan is still reaped (the P1 this must not undo)
 *   H3 a live task's own workload is not reaped, terminal owner or not
 *   H4 a still-running node of a terminal DAG root keeps the root's handle
 *   H5 a live task that holds nothing YET defers the whole session
 *   H6 a session binding still naming the workload holds it while work is live
 *   H7 a registry read that throws defers rather than reaps
 *   H8 a database that will not answer defers rather than reaps
 *   H9 the background-work guard still fires for a parked chat's shells
 *   H10 CONTROL: a live task on a different workload does not hold this one
 */
import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handsSessionKey } from "@claw/protocol";
import type { HandleInfo } from "@claw/protocol";
import type { Harness } from "./scenario-harness.js";

// Before every runtime import: SAFE_API_URL is read once at config module
// scope, and a stopper that reads it as unset answers `unconfirmed` without
// issuing a request -- indistinguishable from the defect H1 is about.
process.env.SAFE_API_URL = "http://safe.test";

const { startHarness, seedSession, seedRun } = await import("./scenario-harness.js");
const { db } = await import("../src/infra/db.js");
const {
  handleRegistry, readSessionBackgroundWork,
} = await import("../src/tasks/sandbox-stopper.js");
const { reapOrphanHandles } = await import("../src/tasks/sweeper.js");

let h: Harness;
/**
 * The harness's own `db.query`, captured AFTER it is installed.
 *
 * Not the module-scope one: `startHarness` repoints `db.query` at PGlite, so a
 * test that saves the binding at import time and restores it afterwards hands
 * every later test the real connection pool instead. There is no server behind
 * it here, so the next statement never settles and the run ends on "Promise
 * resolution is still pending but the event loop has already resolved" -- a
 * hang, not a failure, several tests after the one that caused it.
 */
let harnessQuery: typeof db.query;
before(async () => { h = await startHarness(); harnessQuery = db.query; });
after(async () => { await h.close(); });

const originalRegistry = { ...handleRegistry };
const originalFetch = globalThis.fetch;
afterEach(() => {
  Object.assign(handleRegistry, originalRegistry);
  db.query = harnessQuery;
  globalThis.fetch = originalFetch;
});

/**
 * One GPU, two workloads, and the scheduler that stands between them.
 *
 * H1's claim is not "a stop was issued" but "the live task got to run", and
 * the only thing in the reproduction that connects those is the GPU W1 is
 * sitting on. So the fake SaFE holds a single slot: W2 stays `queued` until
 * whoever holds it is stopped. A guard that defers W1 leaves W2 queued, which
 * is exactly what the timeout in the field was.
 */
interface Gpu {
  /** Every workload id a stop was actually issued against, in order. */
  stops: string[];
  state: Map<string, "running" | "queued" | "stopped">;
}
let gpu: Gpu;

beforeEach(async () => {
  await h.reset();
  gpu = { stops: [], state: new Map() };
  // Nothing is retained unless a test says so: the real `retained` reads a NATS
  // bucket no test here binds, and its failure direction is refusal, which
  // would make every outcome below `unconfirmed` for a reason none of them is
  // about.
  handleRegistry.retained = async () => false;
  // No session binding unless a test writes one. The real reader still runs;
  // what is replaced is the bucket, not the answer.
  bucketHolding({});
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const id = /\/workloads\/([^/]+)\/stop$/.exec(url)?.[1];
    if (!id) return new Response("", { status: 404 });
    gpu.stops.push(id);
    if (gpu.state.get(id) === "running") {
      gpu.state.set(id, "stopped");
      // The slot is free; whatever was queued for it starts.
      for (const [other, state] of gpu.state) {
        if (state === "queued") { gpu.state.set(other, "running"); break; }
      }
    } else {
      gpu.state.set(id, "stopped");
    }
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
});

/** The `hands.<session>` bucket the real reader reads, as a plain object. */
function bucketHolding(entries: Record<string, unknown>): void {
  const enc = new TextEncoder();
  const kv = {
    async get(key: string) {
      const value = entries[key];
      if (value === undefined) return null;
      return { value: enc.encode(JSON.stringify(value)), revision: 3 };
    },
  };
  handleRegistry.backgroundWork = (sessionId, workloadIds) =>
    readSessionBackgroundWork(kv, sessionId, workloadIds);
}

/**
 * A DAG-handle registry keyed by DAG root, the way the real bucket is.
 *
 * Keyed properly on purpose: the whole question under test is per-DAG-root, so
 * a stub that answered the same handles for every root would make every test
 * here pass for the wrong reason.
 */
function registryHolding(
  rows: Record<string, Record<string, HandleInfo>>,
  opts: { throwsFor?: string } = {},
): Map<string, Map<string, HandleInfo>> {
  const live = new Map(
    Object.entries(rows).map(([dag, handles]) => [dag, new Map(Object.entries(handles))]),
  );
  const asRecord = (dag: string): Record<string, HandleInfo> =>
    Object.fromEntries(live.get(dag) ?? new Map());
  handleRegistry.listAll = async () => [...live.keys()].map(
    (dag) => [dag, asRecord(dag)] as [string, Record<string, HandleInfo>],
  );
  handleRegistry.listForDag = async (dag: string) => asRecord(dag);
  handleRegistry.listForDagConsistent = async (dag: string) => {
    if (opts.throwsFor === dag) throw new Error("no responders for leader read");
    return asRecord(dag);
  };
  handleRegistry.listDagRoots = async () => [...live.keys()];
  handleRegistry.lookup = async (dag: string, name: string) => live.get(dag)?.get(name) ?? null;
  handleRegistry.destroy = async (dag: string, name: string) => {
    const info = live.get(dag)?.get(name);
    if (!info) return null;
    live.get(dag)!.delete(name);
    return info.workload_id ?? null;
  };
  return live;
}

/** Attach the ownership facts a run reports when it starts executing. */
async function owns(taskId: string, workloadId: string | null, dagRoot?: string): Promise<void> {
  await h.sql(
    `UPDATE claw_tasks SET sandbox_workload_id = $2, dag_root_task_id = $3 WHERE task_id = $1`,
    [taskId, workloadId, dagRoot ?? null],
  );
}

test("H1 a finished task's workload is released while a live task waits on another", async () => {
  // The reproduction, in rows. T1 finished on W1 and its handle still names it
  // -- reuse registers the adopting DAG but never removes the creating task's
  // reference, which is why this sweep reaches W1 at all. T2 could not reuse W1
  // (the image changed), created W2, and is `preparing` while W2 queues for the
  // GPU W1 is holding. Nothing anywhere is using W1.
  await seedSession(h, "s-1");
  await seedRun(h, "t-1", "s-1", { status: "completed" });
  await seedRun(h, "t-2", "s-1", { status: "preparing" });
  // `sandbox_workload_id` is written when the run reports itself RUNNING, which
  // is after ensureHands returns -- so it is still NULL for T2 here. The handle
  // is not: Brain registers it the moment SaFE assigns an id, `pending` until
  // the pod can serve. That row is the whole reason the narrow question is
  // answerable while T2 is still preparing.
  await owns("t-1", "w-1");
  await owns("t-2", null);
  const live = registryHolding({
    "t-1": { main: { workload_id: "w-1", session_id: "s-1" } },
    "t-2": { main: { workload_id: "w-2", session_id: "s-1", pending: true } },
  });
  // The session slot already names the sandbox T2 created, not the one it
  // could not reuse.
  bucketHolding({
    [handsSessionKey("s-1")]: { status: "pending", workloadId: "w-2", dagRootTaskId: "t-2" },
  });
  gpu.state.set("w-1", "running");
  gpu.state.set("w-2", "queued");

  await reapOrphanHandles();

  assert.deepEqual(
    gpu.stops, ["w-1"],
    "W1 is held by nothing: T1 is terminal and T2 is on W2",
  );
  assert.equal(
    gpu.state.get("w-2"), "running",
    "and releasing it is what lets the live task's sandbox start -- the outcome "
    + "the session-wide guard denied until T2 timed out",
  );
  assert.deepEqual(
    [...(live.get("t-2") ?? new Map()).keys()], ["main"],
    "the live task's own handle is untouched",
  );
  assert.deepEqual([...(live.get("t-1") ?? new Map()).keys()], [], "and W1's mapping goes with it");
});

test("H2 CONTROL: a genuine orphan is still reaped", async () => {
  // The sweep's own primary case. Being dead for it was a P1 on this branch
  // once already, and every guard added since has to be shown not to have
  // re-killed it.
  await seedSession(h, "s-1");
  await seedRun(h, "t-1", "s-1", { status: "completed" });
  await owns("t-1", "w-1");
  registryHolding({ "t-1": { main: { workload_id: "w-1", session_id: "s-1" } } });
  gpu.state.set("w-1", "running");

  await reapOrphanHandles();

  assert.deepEqual(gpu.stops, ["w-1"], "nothing in the session is live and nothing claims it");
});

test("H3 a live task's own workload is not reaped, terminal owner or not", async () => {
  // The case the coarse guard existed for, and the one the narrowing must keep:
  // T1 completed and its handle still names the sandbox, T2 reused that very
  // sandbox and is running on it. Stopping it pulls the pod out from under a
  // running task, which is the severe failure of the two.
  await seedSession(h, "s-1");
  await seedRun(h, "t-1", "s-1", { status: "completed" });
  await seedRun(h, "t-2", "s-1", { status: "running" });
  await owns("t-1", "w-1");
  await owns("t-2", "w-1");
  registryHolding({ "t-1": { main: { workload_id: "w-1", session_id: "s-1" } } });
  gpu.state.set("w-1", "running");

  await reapOrphanHandles();

  assert.deepEqual(gpu.stops, [], "the reusing task is running on exactly this workload");
  assert.equal(gpu.state.get("w-1"), "running");
});

test("H4 a still-running node of a terminal DAG root keeps the root's handle", async () => {
  // The registry half on its own, with nothing else able to rescue it. The
  // handle is registered under the DAG ROOT, the root's own row is terminal,
  // and a node of that DAG is still running on the sandbox with no workload on
  // its row yet -- the whole of `preparing` looks like this, because
  // `sandbox_workload_id` is written only when a run reports itself running.
  //
  // Nothing else in the chain covers it. The stopper's co-holder check asks
  // whether ANOTHER DAG root holds the workload, and this holder is the same
  // DAG root, so that check returns "nobody" and permits the stop. If this
  // sweep does not resolve the live node to its root's handles, the pod goes
  // out from under a running node.
  await seedSession(h, "s-1");
  await seedRun(h, "t-1", "s-1", { status: "completed" });
  await seedRun(h, "t-1b", "s-1", { status: "running" });
  await owns("t-1", "w-1");
  await owns("t-1b", null, "t-1");
  registryHolding({ "t-1": { main: { workload_id: "w-1", session_id: "s-1" } } });
  gpu.state.set("w-1", "running");

  await reapOrphanHandles();

  assert.deepEqual(gpu.stops, [], "the live node's DAG root is the one holding this handle");
  assert.equal(gpu.state.get("w-1"), "running");
});

test("H5 a live task that holds nothing YET defers the whole session", async () => {
  // The window between "a task is live" and "anything has been created for
  // it". No handle under its DAG root, no workload on its row -- and it is one
  // step from either creating a sandbox or ADOPTING the session's existing one,
  // which may be the very workload in hand. "Holds nothing" must not read as
  // "so reap everything": the answer is unknown, and unknown defers.
  await seedSession(h, "s-1");
  await seedRun(h, "t-1", "s-1", { status: "completed" });
  await seedRun(h, "t-2", "s-1", { status: "preparing" });
  await owns("t-1", "w-1");
  await owns("t-2", null);
  registryHolding({ "t-1": { main: { workload_id: "w-1", session_id: "s-1" } } });
  gpu.state.set("w-1", "running");

  await reapOrphanHandles();

  assert.deepEqual(
    gpu.stops, [],
    "a task about to adopt a sandbox looks exactly like a task holding none",
  );
});

test("H6 a session binding still naming the workload holds it while work is live", async () => {
  // The backstop for the registry being read late. The live task's own row and
  // its DAG root both name a different sandbox -- but `hands.<session>` still
  // points at this one, and that slot is what a reuse reads. A live task can be
  // one read away from adopting it, and adoption registers its handle only
  // afterwards.
  await seedSession(h, "s-1");
  await seedRun(h, "t-1", "s-1", { status: "completed" });
  await seedRun(h, "t-2", "s-1", { status: "running" });
  await owns("t-1", "w-1");
  await owns("t-2", "w-2");
  registryHolding({
    "t-1": { main: { workload_id: "w-1", session_id: "s-1" } },
    "t-2": { main: { workload_id: "w-2", session_id: "s-1" } },
  });
  bucketHolding({
    [handsSessionKey("s-1")]: {
      status: "ready", workloadId: "w-1", handsUrl: "http://hands.test", token: "tok-1",
    },
  });
  gpu.state.set("w-1", "running");

  await reapOrphanHandles();

  assert.deepEqual(gpu.stops, [], "the session's reuse slot still names this sandbox");
});

test("H7 a registry read that throws defers rather than reaps", async () => {
  // The live task's DAG root cannot be read from the leader. That is not "it
  // holds nothing" -- it is the one answer this question may never collapse to,
  // because the row that would not load is the one that might name the workload
  // about to be stopped.
  //
  // The live task's root is deliberately NOT a key in the registry listing, so
  // the stopper's own co-holder scan never leader-reads it and cannot be what
  // declines: the only call that throws is this sweep's own.
  await seedSession(h, "s-1");
  await seedRun(h, "t-1", "s-1", { status: "completed" });
  await seedRun(h, "t-2", "s-1", { status: "running" });
  await owns("t-1", "w-1");
  await owns("t-2", null, "t-2");
  registryHolding(
    { "t-1": { main: { workload_id: "w-1", session_id: "s-1" } } },
    { throwsFor: "t-2" },
  );
  gpu.state.set("w-1", "running");

  await reapOrphanHandles();

  assert.deepEqual(gpu.stops, [], "an unreadable holder is an unknown, not an absent one");
});

test("H8 a database that will not answer defers rather than reaps", async () => {
  // And it must not take the sweep down with it either: the remaining DAGs in
  // the tick are other sessions' and have nothing to do with this failure.
  await seedSession(h, "s-1");
  await seedRun(h, "t-1", "s-1", { status: "completed" });
  await owns("t-1", "w-1");
  registryHolding({ "t-1": { main: { workload_id: "w-1", session_id: "s-1" } } });
  gpu.state.set("w-1", "running");
  const real = db.query;
  db.query = (async (text: string, params?: unknown[]) => {
    if (text.replace(/\s+/g, " ").includes("SELECT task_id, dag_root_task_id, sandbox_workload_id")) {
      throw new Error("connection terminated unexpectedly");
    }
    return await real.call(db, text as never, params as never);
  }) as typeof db.query;

  await reapOrphanHandles();

  assert.deepEqual(gpu.stops, [], "a question that could not be asked is not a licence to stop");
});

test("H9 the background-work guard still fires for a parked chat's shells", async () => {
  // Added immediately after the guard this change narrows, and reachable only
  // once the session has no live task at all -- which is precisely the path the
  // narrowing widens traffic onto. Ending a chat parks the sandbox with its
  // background shells deliberately still running and writes no retention
  // record, so this verdict is the only thing on file that says "do not stop".
  await seedSession(h, "s-1");
  await seedRun(h, "t-1", "s-1", { status: "completed" });
  await owns("t-1", "w-1");
  registryHolding({ "t-1": { main: { workload_id: "w-1", session_id: "s-1" } } });
  const idleSince = Date.now() - 60_000;
  bucketHolding({
    [handsSessionKey("s-1")]: {
      status: "ready", workloadId: "w-1", handsUrl: "http://hands.test", token: "tok-1",
      keepalive: false, idleSince, idleEpoch: idleSince, idleRev: 7,
      bgCheckedAt: Date.now() - 1_000, bgRunning: 1,
      bgEpoch: idleSince, bgIdleSince: idleSince, bgIdleRev: 7, bgRev: 6,
    },
  });
  gpu.state.set("w-1", "running");

  await reapOrphanHandles();

  assert.deepEqual(gpu.stops, [], "a measured live background shell still holds the sandbox");
});

test("H10 CONTROL: a live task on a different workload does not hold this one", async () => {
  // The other direction of H3, and what keeps the narrowing from collapsing
  // back into the coarse guard: the session IS busy, and this workload is
  // still reaped, because the busy task is demonstrably somewhere else. The
  // evidence here is only the task row -- no registry entry for its DAG root
  // at all -- which is the half that lets a sweep act while the registry is
  // behind rather than deferring on it.
  await seedSession(h, "s-1");
  await seedRun(h, "t-1", "s-1", { status: "completed" });
  await seedRun(h, "t-2", "s-1", { status: "running" });
  await owns("t-1", "w-1");
  await owns("t-2", "w-2");
  registryHolding({ "t-1": { main: { workload_id: "w-1", session_id: "s-1" } } });
  gpu.state.set("w-1", "running");
  gpu.state.set("w-2", "running");

  await reapOrphanHandles();

  assert.deepEqual(gpu.stops, ["w-1"], "a live task elsewhere is not a claim on this sandbox");
  assert.equal(gpu.state.get("w-2"), "running", "and the live task's own sandbox is untouched");
});
