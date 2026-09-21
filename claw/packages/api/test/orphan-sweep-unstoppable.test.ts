// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An orphan this process cannot stop must keep the one reference to it.
 *
 * `reapOrphanHandles` reaps a handle whose DAG root row is gone -- that is what
 * makes it an orphan, and reaping it is the P1 `NoRecordHome` was added to fix:
 * before that, every orphan took `false` back from `rememberOutcome` and no
 * stop was ever issued against a bucket with no TTL.
 *
 * What that fix left open is the case where the stop ALSO cannot be issued.
 * The three states the teardown collapses are not the same:
 *
 *   (a) the stop succeeded            -- drop the mapping, nothing is owed;
 *   (b) it failed and we recorded it  -- drop the mapping, the DAG root's
 *       `sandbox_release.unreleased` names the workload and `GET /v1/tasks/:id`
 *       serves it;
 *   (c) it could not be authenticated AND there is no row to record it on --
 *       the mapping is the ONLY thing left naming a running workload.
 *
 * (c) is reachable on the live deployment, not in theory: `CLAW_DEPLOY_MODE`
 * is unset (so "safe", not "kubernetes"), the provider is safe-workload with
 * real workload ids, and `loadPlatformKeyForSession` answers "" for a session
 * whose config was never stamped, was cleared, or whose row is gone. SaFE
 * refuses an unauthenticated stop, the DAG row is absent so nothing can be
 * written down, and the mapping goes anyway -- leaving a GPU held by a
 * workload that `listAll()` no longer returns and no task row mentions.
 *
 * Driven through the REAL `reapOrphanHandles` over PGlite, with the registry
 * and the `hands` bucket substituted, and asserted on outcomes: whether SaFE
 * accepted the stop, whether the workload is still running, and whether
 * anything anywhere still names it.
 *
 * Coverage:
 *   X1 THE DEFECT: an orphan whose stop cannot be authenticated keeps its
 *      mapping, and something still names the workload
 *   X2 CONTROL: an orphan WITH a platform key is still reaped, key on the wire
 *   X3 not an orphan: no key, but the DAG row can hold the evidence, so the
 *      mapping still drops and the leak is on record
 *   X4 an unstoppable orphan is counted, so the loop it costs is a loud one
 */
import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { HandleInfo } from "@claw/protocol";
import type { Harness } from "./scenario-harness.js";

// Before every runtime import: `SAFE_API_URL` is read once at config module
// scope, and a stopper that reads it as unset skips the request entirely --
// which is a DIFFERENT unstoppable case from the one this file is about, and
// would make X2 pass without a request ever being made.
process.env.SAFE_API_URL = "http://safe.test";

const { startHarness, seedSession, seedRun } = await import("./scenario-harness.js");
const { db } = await import("../src/infra/db.js");
const {
  handleRegistry, readSessionBackgroundWork,
} = await import("../src/tasks/sandbox-stopper.js");
const { reapOrphanHandles } = await import("../src/tasks/sweeper.js");

let h: Harness;
/** The harness's own binding, captured after `startHarness` installs it. */
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
 * A SaFE that authenticates, which is the whole point of this file.
 *
 * Every other test here answers 200 to any `/stop` it is handed, so a stop sent
 * with no `Authorization` header is indistinguishable from one sent with a good
 * key -- and the real deployment tells them apart. This one refuses the
 * unauthenticated request the way the apiserver does, and keeps the workload
 * running, because that is the state the assertions are about.
 */
interface Safe {
  /** Every workload id SaFE ACCEPTED a stop for, in order. */
  accepted: string[];
  /** Every workload id a request was issued against, accepted or refused. */
  attempted: string[];
  /** The bearer each attempt carried, in the same order. */
  bearers: string[];
  state: Map<string, "running" | "stopped">;
}
let safe: Safe;

beforeEach(async () => {
  await h.reset();
  safe = { accepted: [], attempted: [], bearers: [], state: new Map() };
  handleRegistry.retained = async () => false;
  bucketHolding({});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const id = /\/workloads\/([^/]+)\/stop$/.exec(url)?.[1];
    if (!id) return new Response("", { status: 404 });
    const auth = new Headers(init?.headers ?? {}).get("authorization") ?? "";
    safe.attempted.push(id);
    safe.bearers.push(auth);
    if (!auth.startsWith("Bearer ")) {
      // What the cluster answers, and the reason this whole case exists: the
      // workload keeps running.
      return new Response("unauthorized", { status: 401 });
    }
    safe.accepted.push(id);
    safe.state.set(id, "stopped");
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

/** Stamp the credentials `stampSessionCredentials` writes on every submission. */
async function withPlatformKey(sessionId: string, key: string): Promise<void> {
  await h.sql(
    `UPDATE claw_sessions
        SET config = config || $2::jsonb
      WHERE session_id = $1`,
    [sessionId, JSON.stringify({ _server_managed_credentials: true, platform_key: key })],
  );
}

/** Everywhere a running workload can still be named after a sweep. */
async function namesOf(
  live: Map<string, Map<string, HandleInfo>>,
  workloadId: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const [dag, handles] of live) {
    for (const [name, info] of handles) {
      if (info.workload_id === workloadId) found.push(`handle:${dag}/${name}`);
    }
  }
  const rows = await h.sql(
    `SELECT task_id FROM claw_tasks
      WHERE metadata::text LIKE $1 OR sandbox_workload_id = $2`,
    [`%${workloadId}%`, workloadId],
  );
  for (const r of rows) found.push(`task:${r.task_id as string}`);
  return found;
}

test("X1 an orphan whose stop cannot be authenticated keeps its mapping", async () => {
  // The orphan, in rows: a session that is still there, no `claw_tasks` row for
  // the DAG root at all (`status` reads `missing`, which is what makes this the
  // sweep's own primary case), a handle naming a running workload, and a
  // session whose config carries no platform key.
  await seedSession(h, "s-1");
  const live = registryHolding({
    "t-orphan": { main: { workload_id: "w-1", session_id: "s-1" } },
  });
  safe.state.set("w-1", "running");

  await reapOrphanHandles();

  assert.deepEqual(
    safe.accepted, [],
    "SaFE refuses a stop with no bearer -- the premise, and what makes this (c)",
  );
  assert.equal(
    safe.state.get("w-1"), "running",
    "so the workload is still holding its GPU when the sweep returns",
  );
  assert.deepEqual(
    await namesOf(live, "w-1"), ["handle:t-orphan/main"],
    "and the mapping is the only thing left that names it, so it must still be "
    + "there: dropping it leaves a running workload nothing in the system can reach",
  );
});

test("X2 CONTROL: an orphan with a platform key is still reaped", async () => {
  // The P1 this must not undo. Same orphan, one difference: the session carries
  // the key the stop needs, so the stop is attemptable, SaFE accepts it, and
  // the mapping goes exactly as it did before.
  await seedSession(h, "s-1");
  await withPlatformKey("s-1", "pk-live");
  const live = registryHolding({
    "t-orphan": { main: { workload_id: "w-1", session_id: "s-1" } },
  });
  safe.state.set("w-1", "running");

  await reapOrphanHandles();

  assert.deepEqual(safe.accepted, ["w-1"], "the orphan is still reaped");
  assert.deepEqual(
    safe.bearers, ["Bearer pk-live"],
    "with the session's own key on the wire, not the cluster's identity",
  );
  assert.equal(safe.state.get("w-1"), "stopped");
  assert.deepEqual(
    await namesOf(live, "w-1"), [],
    "and nothing is owed, so nothing is left naming it",
  );
});

test("X3 not an orphan: no key, but the row can hold the evidence", async () => {
  // (b), and the reason the gate is on "nothing can be recorded" rather than on
  // "the stop cannot be authenticated". The DAG root row is there and terminal,
  // so the failed release is written to `sandbox_release.unreleased` where
  // `GET /v1/tasks/:id` serves it. That record is a reference, so the mapping is
  // free to go -- this is unchanged behaviour and pinned so the gate cannot
  // quietly widen onto it.
  await seedSession(h, "s-1");
  await seedRun(h, "t-1", "s-1", { status: "completed" });
  await h.sql(
    `UPDATE claw_tasks SET dag_node_id = '__dag_root__', dag_root_task_id = $1 WHERE task_id = $1`,
    ["t-1"],
  );
  const live = registryHolding({ "t-1": { main: { workload_id: "w-1", session_id: "s-1" } } });
  safe.state.set("w-1", "running");

  await reapOrphanHandles();

  assert.deepEqual(safe.accepted, [], "SaFE still refuses it");
  assert.deepEqual(
    [...(live.get("t-1") ?? new Map()).keys()], [],
    "and the mapping still drops, because it is no longer the only reference",
  );
  const rows = await h.sql(
    `SELECT metadata -> 'sandbox_release' -> 'unreleased' AS unreleased
       FROM claw_tasks WHERE task_id = 't-1'`,
  );
  const entries = Object.values(
    (rows[0].unreleased ?? {}) as Record<string, { workload_id: string }>,
  );
  assert.deepEqual(
    entries.map((e) => e.workload_id), ["w-1"],
    "the leak is on the row an operator can read, which is what replaces the mapping",
  );
});

test("X4 the loop it costs is loud, and it ends when the key arrives", async () => {
  // The cost of keeping the mapping, stated as an outcome rather than argued.
  // The sweep reaches the same handle every tick and declines again -- the same
  // trade `stop_unsupported_handle` already makes one branch up, and the same
  // one the branch chose when it preferred a loud loop to silent abandonment.
  //
  // The half that makes it better than that branch's is the ending: a missing
  // platform key is not permanent. `stampSessionCredentials` rewrites
  // `platform_key` onto the session row on every submission, so the next tick
  // after the session is used again issues a stop that can actually work.
  await seedSession(h, "s-1");
  const live = registryHolding({
    "t-orphan": { main: { workload_id: "w-1", session_id: "s-1" } },
  });
  safe.state.set("w-1", "running");

  await reapOrphanHandles();
  await reapOrphanHandles();

  assert.deepEqual(
    await namesOf(live, "w-1"), ["handle:t-orphan/main"],
    "tick after tick, the workload is still named -- the loop IS the reference",
  );
  assert.deepEqual(safe.accepted, [], "and nothing has been released yet");

  // The session is submitted to again and the key lands on the row.
  await withPlatformKey("s-1", "pk-late");

  await reapOrphanHandles();

  assert.deepEqual(safe.accepted, ["w-1"], "the very next tick stops it for real");
  assert.deepEqual(
    await namesOf(live, "w-1"), [],
    "and only then does the mapping go, because only then is nothing owed",
  );
});
