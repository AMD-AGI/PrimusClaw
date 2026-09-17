// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox the session has MOVED OFF is the one the background-work guard
 * cannot speak about, and the retention ledger is the only thing that can.
 *
 * The shape, reproduced here against real Postgres (PGlite runs the same
 * statements) driving the real `reapOrphanHandles`: T1 finishes on W1 with a
 * background shell still running in it. T2 changes the image, cannot reuse W1,
 * and creates W2 -- and writing W2's binding puts it over W1's at the one key a
 * session has, `hands.<session>`. From that moment the verdict that said
 * "shells are running in W1" does not exist anywhere. `readSessionBackgroundWork`
 * answers `other_sandbox` about W1, which is the truth (the binding it found is
 * about W2) and is not an answer about W1 at all, and the sweep stops W1 with
 * the user's shell alive inside it.
 *
 * Nothing in this package can fix that, and the tests below are shaped around
 * why. Per-workload evidence has one durable home -- a retention record, keyed
 * by the container's own generation rather than by session, which
 * `handleRegistry.retained` reads and `stopSandboxByHandle` refuses on. The
 * write is missing: Brain retains a container it RELEASES
 * (`retainInsteadOfDestroying` in brain/src/sandbox/ensure-hands.ts) and writes
 * nothing on the path that merely abandons one for a replacement. So what is
 * pinned here is the half that is this package's: that a retention record over
 * a displaced workload really does keep it, through the same code path that
 * stops it without one.
 *
 * D2 is the honest half of D1. Without it, D1 would pass equally well for a
 * harness that never reached the stop at all -- and a test that passed for
 * exactly that reason has shipped on this branch. Same fixture, same sweep,
 * retention the only difference, opposite outcomes.
 *
 * Coverage:
 *   D1 a retention record over the displaced workload keeps its shells alive
 *   D2 CONTROL: without one the same sweep stops it -- which is also the
 *      deadlock fix (a displaced orphan must still be reaped) still standing
 */
import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handsSessionKey } from "@claw/protocol";
import type { HandleInfo } from "@claw/protocol";
import type { Harness } from "./scenario-harness.js";

// Before every runtime import: SAFE_API_URL is read once at config module
// scope, and a stopper that reads it as unset answers `unconfirmed` without
// issuing a request -- which would make D1 pass with nothing proved.
process.env.SAFE_API_URL = "http://safe.test";

const { startHarness, seedSession, seedRun } = await import("./scenario-harness.js");
const { db } = await import("../src/infra/db.js");
const {
  handleRegistry, readSessionBackgroundWork,
} = await import("../src/tasks/sandbox-stopper.js");
const { reapOrphanHandles } = await import("../src/tasks/sweeper.js");

let h: Harness;
/** The harness's own `db.query`, captured AFTER it is installed. */
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
 * The fleet, and what the user left running inside each sandbox.
 *
 * The claim under test is not "a stop was issued" but "the background work
 * survived", so the shell count is modelled and a stop takes the container's
 * shells with it -- which is what stopping a SaFE workload does.
 */
interface Fleet {
  /** Every workload id a stop was actually issued against, in order. */
  stops: string[];
  /** Background shells still running, per workload. */
  shells: Map<string, number>;
}
let fleet: Fleet;

beforeEach(async () => {
  await h.reset();
  fleet = { stops: [], shells: new Map() };
  // Nothing is retained unless a test says so: the real `retained` reads a NATS
  // bucket no test here binds, and its failure direction is refusal, which
  // would make every outcome below `unconfirmed` for a reason none of them is
  // about.
  handleRegistry.retained = async () => false;
  bucketHolding({});
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const id = /\/workloads\/([^/]+)\/stop$/.exec(url)?.[1];
    if (!id) return new Response("", { status: 404 });
    fleet.stops.push(id);
    fleet.shells.set(id, 0);
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

/** A DAG-handle registry keyed by DAG root, the way the real bucket is. */
function registryHolding(
  rows: Record<string, Record<string, HandleInfo>>,
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
  handleRegistry.listForDagConsistent = async (dag: string) => asRecord(dag);
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
async function owns(taskId: string, workloadId: string | null): Promise<void> {
  await h.sql(
    `UPDATE claw_tasks SET sandbox_workload_id = $2 WHERE task_id = $1`,
    [taskId, workloadId],
  );
}

/**
 * T1 finished on W1; T2 changed the image, could not reuse it, and bound W2.
 *
 * `shellsInW1` is the whole variable: the rows, the registry and the binding are
 * identical either way, because the system keeps no record that distinguishes
 * them once the binding has moved. That is the defect, and it is why the
 * retention record has to be what decides.
 */
async function seedDisplaced(shellsInW1: number): Promise<Map<string, Map<string, HandleInfo>>> {
  await seedSession(h, "s-1");
  await seedRun(h, "t-1", "s-1", { status: "completed" });
  await seedRun(h, "t-2", "s-1", { status: "preparing" });
  // `sandbox_workload_id` is written when a run reports itself RUNNING, so it
  // is still NULL for the preparing T2. Its handle is not: Brain registers one
  // the moment SaFE assigns an id, `pending` until the pod can serve.
  await owns("t-1", "w-1");
  await owns("t-2", null);
  const live = registryHolding({
    "t-1": {
      main: {
        workload_id: "w-1", session_id: "s-1", image: "img-a",
        // The endpoint a retention would be keyed by, recorded on the handle
        // exactly as Brain's registration writes it.
        hands_url: "http://hands-1.test", token: "tok-1",
      },
    },
    "t-2": { main: { workload_id: "w-2", session_id: "s-1", image: "img-b", pending: true } },
  });
  // The session's one slot names the sandbox T2 created. W1's binding -- the
  // only place a verdict about W1's shells could have lived -- was written over
  // by this one.
  bucketHolding({
    [handsSessionKey("s-1")]: { status: "pending", workloadId: "w-2", dagRootTaskId: "t-2" },
  });
  fleet.shells.set("w-1", shellsInW1);
  fleet.shells.set("w-2", 0);
  return live;
}

test("D1 a retention record over the displaced workload keeps its shells alive", async () => {
  const live = await seedDisplaced(1);
  // What Brain's retention ledger answers once a record naming W1 exists. The
  // real `retained` matches a record's `workloadId` against the one asked
  // about, over both the ledger and its projection, so this is that answer and
  // not a stub of the branch.
  const retained = new Set(["w-1"]);
  handleRegistry.retained = async (workloadId: string) => retained.has(workloadId);

  await reapOrphanHandles();

  assert.deepEqual(
    fleet.stops, [],
    "a retained container is an older claim than the stale handle naming it",
  );
  assert.equal(
    fleet.shells.get("w-1"), 1,
    "and the user's background shell is still running in it",
  );
  assert.deepEqual(
    [...(live.get("t-1") ?? new Map()).keys()], [],
    "the finished DAG still lets go of its reference -- the retention is the container's "
    + "reference from here on",
  );
  assert.deepEqual(
    [...(live.get("t-2") ?? new Map()).keys()], ["main"],
    "and the live task's own handle is untouched",
  );
});

test("D2 CONTROL: without one the same sweep stops the displaced sandbox", async () => {
  // Same fixture, nothing retained, no shells to lose. The stop has to be
  // issued: a displaced sandbox that really is finished is the orphan this
  // sweep exists to reap, and deferring on it is the leak -- and the deadlock
  // where the live task waits on the GPU the finished one is sitting on.
  //
  // It is also what makes D1 mean something. The two differ in one input.
  const live = await seedDisplaced(0);

  await reapOrphanHandles();

  assert.deepEqual(
    fleet.stops, ["w-1"],
    "nothing holds W1: T1 is terminal, T2 is on W2, and no retention was taken",
  );
  assert.deepEqual([...(live.get("t-1") ?? new Map()).keys()], [], "and its mapping goes with it");
});
