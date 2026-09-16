// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the teardown writes down, and when, against a real Postgres.
 *
 * Every other suite in this area replaces `unreleasedRecord` with a Map, which
 * is right for asserting what the teardown does with an answer and useless for
 * asserting WHICH answer the real statements give. Two of the defects below
 * are exactly that: the Map's `mark` cannot fail, so the branch that decides
 * what to do when the real one does was never executed by a test, and the Map
 * is discarded between tests, so a record that no code path can clear looks
 * identical to one that was cleared.
 *
 * So these run the statements, through the sweeper and the aggregate that
 * really call them, and assert on the rows and the requests that came out:
 * which workload was POSTed to SaFE, what is left in the handle map, and what
 * the DAG root row's `metadata` holds afterwards.
 *
 * Coverage:
 *   T1 an orphan handle -- the DAG row is gone -- is stopped, not skipped
 *   T2 the same sweep with the row present, which is T1's control
 *   T3 a retained container leaves no leak record, so the DAG can be clean again
 *   T4 nor does a workload a second DAG still holds
 *   T5 nor does a shared-holder check that could not be answered at all
 *   T6 a handle naming no workload keeps its mapping and writes nothing
 */
import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { HandleInfo } from "@claw/protocol";
import type { Harness } from "./scenario-harness.js";

// Before every runtime import below, and the reason none of them is a static
// one: `SAFE_API_URL` is read once at `config.ts` module scope, static imports
// are hoisted above assignments, and a stopper that reads it as unset answers
// `unconfirmed` without issuing a request -- which is indistinguishable from
// the defect T1 is about.
process.env.SAFE_API_URL = "http://safe.test";

const { startHarness, seedSession, seedRun } = await import("./scenario-harness.js");
const {
  handleRegistry, readSessionBackgroundWork, stopAllHandlesForDag,
} = await import("../src/tasks/sandbox-stopper.js");
const { reapOrphanHandles } = await import("../src/tasks/sweeper.js");

let h: Harness;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

const originalRegistry = { ...handleRegistry };
const originalFetch = globalThis.fetch;

/** Every workload id a stop was actually issued against, in order. */
let stopped: string[];

afterEach(() => {
  Object.assign(handleRegistry, originalRegistry);
  globalThis.fetch = originalFetch;
});

beforeEach(async () => {
  await h.reset();
  stopped = [];
  // Nothing is retained unless a test says so: the real `retained` reads a NATS
  // bucket no test here binds, and its failure direction is refusal, which
  // would make every outcome below `unconfirmed` for a reason none of them is
  // about.
  handleRegistry.retained = async () => false;
  // No session binding unless a test writes one. There is no NATS here, so the
  // orphan sweep's background-work read has no bucket to reach -- and its
  // failure direction is deferral, which would turn every stop below into a
  // deferred one for a reason none of these tests is about. The real reader is
  // still the one running: what is replaced is the bucket, not the answer, and
  // an empty bucket is exactly the "this session has no sandbox entry" case.
  // The read itself is covered in orphan-sweep-background-work.test.ts.
  handleRegistry.backgroundWork = (sessionId, workloadIds) =>
    readSessionBackgroundWork({ async get() { return null; } }, sessionId, workloadIds);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    stopped.push(/\/workloads\/([^/]+)\/stop$/.exec(url)?.[1] ?? url);
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
});

/**
 * A registry holding `handles` for `dagRoot`, whose destroy really removes the
 * entry -- so "was the mapping dropped" is a question the test can ask the
 * stub afterwards rather than a call it merely counted.
 */
function registryHolding(
  dagRoot: string,
  handles: Record<string, HandleInfo>,
  others: Array<[string, Record<string, HandleInfo>]> = [],
): Map<string, HandleInfo> {
  const live = new Map(Object.entries(handles));
  const rows = (): Record<string, HandleInfo> => Object.fromEntries(live);
  handleRegistry.listForDag = async (dag: string) => (dag === dagRoot ? rows() : {});
  const otherRows = new Map(others);
  handleRegistry.listForDagConsistent = async (dag: string) =>
    (dag === dagRoot ? rows() : otherRows.get(dag) ?? {});
  handleRegistry.listDagRoots = async () => [dagRoot, ...others.map(([d]) => d)];
  handleRegistry.lookup = async (dag: string, name: string) =>
    (dag === dagRoot ? live.get(name) ?? null : null);
  handleRegistry.destroy = async (dag: string, name: string) => {
    if (dag !== dagRoot) return null;
    const info = live.get(name);
    if (!info) return null;
    live.delete(name);
    return info.workload_id ?? null;
  };
  handleRegistry.listAll = async () => [[dagRoot, rows()], ...others];
  return live;
}

/** The DAG root's `sandbox_release` record, read outside the code under test. */
async function leakRecord(taskId: string): Promise<Record<string, unknown>> {
  const rows = await h.sql(`SELECT metadata FROM claw_tasks WHERE task_id = $1`, [taskId]);
  const meta = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
  const release = (meta.sandbox_release ?? {}) as Record<string, unknown>;
  return (release.unreleased ?? {}) as Record<string, unknown>;
}

test("T1 an orphan handle -- the DAG row is gone -- is stopped, not skipped", async () => {
  // The case `reapOrphanHandles` exists for, and the one it could not do:
  // "orphan" IS "the DAG row no longer exists" (`status = owner?.status ??
  // "missing"`), and the pre-stop record is written to that row. `mark` raises
  // when the statement matches nothing, `rememberOutcome` reported that as a
  // failed write, and the gate it guards withheld the destroy AND the stop. So
  // the sweep reached the handle, decided the DAG was over, and issued nothing
  // -- against a bucket created with no TTL, so repeating the sweep changes
  // nothing and the reference outlives the database.
  //
  // Driven through the sweeper rather than through `stopAllHandlesForDag`,
  // because the missing row is what the sweeper's own query has to see.
  const live = registryHolding("t-orphan", {
    main: { workload_id: "w-orphan", session_id: "s-gone" },
  });

  const dropped = await reapOrphanHandles();

  assert.deepEqual(
    stopped, ["w-orphan"],
    "the workload behind a handle whose DAG is gone is exactly what this sweep is for",
  );
  assert.deepEqual([...live.keys()], [], "and the mapping goes with it");
  assert.equal(dropped, 1, "the DAG was reached, so it is counted as reached");

  // Nothing about it self-heals, so a second sweep is not a second chance: the
  // point of T1 is that the first one has to act.
  await reapOrphanHandles();
  assert.deepEqual(stopped, ["w-orphan"], "and it is idempotent, not repeated");
});

test("T2 the same sweep with the row present, which is T1's control", async () => {
  // Without this, T1 passes for any reason at all -- a stub that never
  // registered the handle, a sweeper that skipped the DAG. Here the record has
  // somewhere to live, every other input is identical, and the machinery the
  // orphan case cannot reach is shown working.
  await seedSession(h, "s-1");
  await seedRun(h, "t-done", "s-1", { status: "completed" });
  const live = registryHolding("t-done", {
    main: { workload_id: "w-done", session_id: "s-1" },
  });

  await reapOrphanHandles();

  assert.deepEqual(stopped, ["w-done"]);
  assert.deepEqual([...live.keys()], []);
  assert.deepEqual(
    await leakRecord("t-done"), {},
    "a stop SaFE accepted clears its own mark rather than latching it",
  );
});

test("T3 a retained container leaves no leak record, so the DAG can be clean again", async () => {
  // Retention outranks a stale handle, so this teardown must not stop the
  // container -- and it must not report a leak either. The mark used to be
  // written before the destroy and the retention read after it, and this
  // branch returns without clearing anything, so a container Brain was
  // deliberately protecting left a permanent `unreleased` entry on the DAG
  // root: a leak reported for a sandbox that never leaked, on the one field
  // built to say when a sandbox did.
  await seedSession(h, "s-1");
  await seedRun(h, "t-root", "s-1");
  const live = registryHolding("t-root", { main: { workload_id: "w-keep" } });
  handleRegistry.retained = async (wid: string) => wid === "w-keep";

  const released = await stopAllHandlesForDag("t-root", "s-1");

  assert.deepEqual(stopped, [], "a retained container is not this teardown's to stop");
  assert.equal(released, "unconfirmed", "and nothing here established it is gone");
  assert.deepEqual(
    await leakRecord("t-root"), {},
    "nothing leaked, so nothing is on record as having leaked",
  );
  assert.deepEqual([...live.keys()], [], "this DAG still lets go of the handle");

  // The consequence, in the only form a caller can see it: with the entry
  // written, this answered `unconfirmed` for the rest of the DAG's life,
  // because no later call revisits a handle that is no longer in the map.
  assert.equal(
    await stopAllHandlesForDag("t-root", "s-1"), "nothing_held",
    "a DAG that leaked nothing reports nothing on the next call",
  );
});

test("T4 nor does a workload a second DAG still holds", async () => {
  // Reuse registers the adopting DAG's own handle against the same workload,
  // so this is the ordinary shape of session reuse rather than a race. D1's
  // teardown must skip the stop, and -- like T3 -- must not leave D1 reporting
  // a leak for a sandbox D2 is happily running on.
  await seedSession(h, "s-1");
  await seedRun(h, "dag-1", "s-1");
  registryHolding(
    "dag-1",
    { main: { workload_id: "w-shared" } },
    [["dag-2", { main: { workload_id: "w-shared" } }]],
  );

  const released = await stopAllHandlesForDag("dag-1", "s-1");

  assert.deepEqual(stopped, [], "the sandbox D2 is running on must survive D1's teardown");
  assert.equal(released, "unconfirmed");
  assert.deepEqual(
    await leakRecord("dag-1"), {},
    "a workload that is still legitimately held is not a workload that escaped",
  );
  assert.equal(
    await stopAllHandlesForDag("dag-1", "s-1"), "nothing_held",
    "so D1 is not marked as leaking for the rest of its life",
  );
});

test("T5 nor does a shared-holder check that could not be answered at all", async () => {
  // The same ordering, reached by the failure path: an enumeration that ends
  // on a closed connection is an unknown, the teardown declines to stop, and
  // the mark written before it was ever consulted stayed behind. A check that
  // established nothing is not evidence that a workload escaped.
  await seedSession(h, "s-1");
  await seedRun(h, "dag-1", "s-1");
  const live = registryHolding("dag-1", { main: { workload_id: "w-1" } });
  handleRegistry.listDagRoots = async () => {
    throw new Error("dag-handles enumeration ended on a closed connection");
  };

  const released = await stopAllHandlesForDag("dag-1", "s-1");

  assert.equal(released, "unconfirmed", "an ownership it could not establish declines to stop");
  assert.deepEqual(stopped, []);
  assert.deepEqual(
    [...live.keys()], ["main"],
    "and the mapping stays, because nothing established the workload was anyone else's",
  );
  assert.deepEqual(
    await leakRecord("dag-1"), {},
    "a read that failed before the mapping was touched leaks nothing to report",
  );
});

test("T6 a handle naming no workload keeps its mapping and writes nothing", async () => {
  // agent-sandbox handles carry `workload_id: ""`, and this path cannot stop
  // one. It used to write the record anyway and drop the mapping -- a record
  // `clear` can never remove, since clearing needs a confirmed stop of the
  // workload it names and that workload is the empty string. The DAG then
  // reported `unconfirmed` for life, naming an empty id nobody could act on.
  //
  // The mapping is the honest reference: it says the same true thing, it stops
  // the next caller inventing `nothing_held`, and it goes when whoever owns
  // that sandbox lets it go.
  await seedSession(h, "s-1");
  await seedRun(h, "t-agent", "s-1");
  const live = registryHolding("t-agent", {
    main: { workload_id: "", provider: "agent-sandbox", session_id: "router-1" },
  });

  const released = await stopAllHandlesForDag("t-agent", "s-1");

  assert.equal(released, "unconfirmed", "something is held and this code did not release it");
  assert.deepEqual(stopped, [], "there is no workload id to issue a stop against");
  assert.deepEqual(
    [...live.keys()], ["main"],
    "so the mapping stays: it is the only reference to a sandbox this path cannot stop",
  );
  assert.deepEqual(
    await leakRecord("t-agent"), {},
    "and nothing is latched onto the DAG that no later call could ever clear",
  );
});
