// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Two releases of one shared workload, overlapping -- and whether anything
 * stops it.
 *
 * Reuse registers the adopting DAG's own handle against the workload the
 * creator already holds and does NOT remove the creator's, so two rows naming
 * one workload is the ordinary shape of a session, not an exotic state (T4 in
 * `sandbox-teardown-ordering` says so in its own words). Two entry points can
 * then release the same workload at the same moment without anybody clicking
 * cancel twice: `cancelTask` writes the cancelled verdict BEFORE calling
 * `stopAllHandlesForDag`, so the instant dag-b is marked cancelled the
 * sweeper's "session still live" guard stops deferring and reaps terminal
 * dag-a's orphan handle -- concurrently with dag-b's in-flight release.
 *
 * The teardown's shared-holder check reads the registry keyed by DAG to answer
 * a question keyed by workload, and the read that means "do not destroy" is
 * not atomic with the write that removes the last reference:
 *
 *   t1  A reads the registry, sees dag-b naming w   -> "somebody else holds it"
 *   t2  B reads the registry, sees dag-a naming w   -> "somebody else holds it"
 *   t3  A drops dag-a's row, records nothing, declines
 *   t4  B drops dag-b's row, records nothing, declines
 *
 * What comes out is a live SaFE workload -- a GPU -- with every reference to
 * it deleted: no mapping for `reapOrphanHandles` to start from (it enumerates
 * mappings), no record on either DAG, and `stopAllHandlesForDag` answering
 * `nothing_held`, which is the exact false assertion this whole feature exists
 * to stop inventing.
 *
 * WHAT IS REAL HERE. The decision code is the production
 * `stopSandboxByHandle`. The removal is the production `destroyHandleCas`,
 * against a bucket with real revision semantics (the same reason
 * `handle-destroy-cas.test.ts` gives: a fake without one would pass whether or
 * not a revision was sent). The reads go through the production `DagHandleMap`
 * over the production `makeKvStore`. The record is the production
 * `unreleasedRecord` SQL against a real Postgres (PGlite). What is modelled is
 * the transport, and it is modelled with the one property this fix turns on:
 * `kv.get` is a DIRECT read that may be stale, while the leader read is not.
 * So the bucket below has two surfaces -- a leader, which `destroy`,
 * `listDagRoots` and `listForDagConsistent` use, and a replica that can be
 * frozen at an old snapshot, which the direct scans read. S4 is the case that
 * needs the difference.
 *
 * `retained` is the one registry call stubbed, for the reason
 * `sandbox-teardown-ordering`'s own `beforeEach` gives: it reads
 * `infra/nats.kv` (BRAIN_REGISTRY), a module binding no seam replaces, and its
 * failure direction is refusal -- which would make every outcome here
 * `unconfirmed` for a reason none of them is about. S7 is the case that turns
 * it on, and T3 covers the retained path properly.
 *
 * HOW THE INTERLEAVING IS DRIVEN. Not with timers, and not by hoping a bare
 * `Promise.all` lands the right way: both parties are held at the exact
 * statement that commits the removal -- `handleRegistry.destroy` -- until both
 * have arrived. Each side's ownership reads necessarily precede its own
 * destroy, so a rendezvous there is precisely "every read before every write",
 * reached deterministically on every run.
 *
 * Coverage:
 *   S1 control: one DAG alone holding a workload -- the stop is issued
 *   S2 control: two DAGs releasing SEQUENTIALLY -- exactly one stop, from the
 *      last holder, and the first leaves no marker
 *   S3 the defect: both release at once -- the workload must still be stopped
 *   S4 and a stale direct read must not re-arm the mutual decline
 *   S5 a re-check that cannot be answered leaves the workload ON RECORD,
 *      because its mapping is already gone and nothing else names it
 *   S6 what the ordering move bought, still bought: a legitimately shared
 *      decline leaves no permanent `unreleased` marker
 *   S7 a retention is an older claim, not a race: no re-check, no record, no
 *      stop
 *   S8 a retention that lands DURING this release protects the container too
 *   S9 and a retention re-check that cannot be answered leaves it on record
 */
import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DagHandleMap, HANDLE_MAP_PREFIX, type HandleInfo } from "@claw/protocol";
import type { Harness } from "./scenario-harness.js";

// Before every runtime import below, and the reason none of them is static:
// `SAFE_API_URL` is read once at `config.ts` module scope, static imports are
// hoisted above assignments, and a stopper that reads it as unset answers
// `unconfirmed` without issuing a request -- which is indistinguishable from
// the defect S3 is about.
process.env.SAFE_API_URL = "http://safe.test";

const { startHarness, seedSession, seedRun } = await import("./scenario-harness.js");
const {
  handleRegistry, stopSandboxByHandle, stopAllHandlesForDag,
  destroyHandleCas, makeKvStore,
} = await import("../src/tasks/sandbox-stopper.js");

let h: Harness;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

const originalRegistry = { ...handleRegistry };
const originalFetch = globalThis.fetch;

/** Every workload id a stop was actually issued against, in order. */
let stopped: string[];

interface Row { value: Uint8Array | null; revision: number }

/**
 * A DAG-handle bucket with two read surfaces.
 *
 * `leader` is the authority: conditional writes are checked against it and
 * `listForDagConsistent` reads it. `replica` answers direct `kv.get`s and can
 * be frozen -- pinned at the snapshot it held when `freeze()` was called --
 * which is what a replica that has not yet seen an acknowledged delete looks
 * like from this side. Nothing else about NATS is modelled; the revision
 * semantics are, because `destroyHandleCas` is real here and turns on them.
 */
function bucket() {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const rows = new Map<string, Row>();
  let seq = 0;
  let frozen: Map<string, Row> | null = null;

  const key = (dagRoot: string): string => `${HANDLE_MAP_PREFIX}.${dagRoot}`;
  const dagOf = (k: string): string => k.slice(HANDLE_MAP_PREFIX.length + 1);
  const decode = (row: Row | undefined): Record<string, HandleInfo> => {
    if (!row || row.value === null || row.value.length === 0) return {};
    return JSON.parse(dec.decode(row.value)) as Record<string, HandleInfo>;
  };

  const leader = {
    async get(k: string) {
      const row = rows.get(k);
      if (!row || row.value === null) return null;
      return { value: row.value, revision: row.revision, operation: "PUT" as const };
    },
    async put(k: string, value: Uint8Array) {
      seq += 1; rows.set(k, { value, revision: seq }); return seq;
    },
    async update(k: string, value: Uint8Array, revision: number) {
      const row = rows.get(k);
      // NATS answers a failed `previousSeq` with "wrong last sequence"; the
      // production code matches on that text, so the fake has to speak it.
      if (!row || row.revision !== revision) throw new Error("wrong last sequence: 0");
      seq += 1; rows.set(k, { value, revision: seq }); return seq;
    },
    async delete(k: string, opts?: { previousSeq: number }) {
      const row = rows.get(k);
      if (opts && (!row || row.revision !== opts.previousSeq)) {
        throw new Error("wrong last sequence: 0");
      }
      seq += 1; rows.set(k, { value: null, revision: seq });
    },
    async keys(): Promise<AsyncIterable<string>> {
      const live = [...rows.entries()].filter(([, r]) => r.value !== null).map(([k]) => k);
      return (async function* stream() { for (const k of live) yield k; })();
    },
  };

  // The same surface, reading whatever snapshot the replica currently has.
  const replica = {
    ...leader,
    async get(k: string) {
      const row = (frozen ?? rows).get(k);
      if (!row || row.value === null) return null;
      return { value: row.value, revision: row.revision, operation: "PUT" as const };
    },
    async keys(): Promise<AsyncIterable<string>> {
      const live = [...(frozen ?? rows).entries()]
        .filter(([, r]) => r.value !== null).map(([k]) => k);
      return (async function* stream() { for (const k of live) yield k; })();
    },
  };

  return {
    leader, replica,
    /** A registration, as Brain's `replaceDagHandle` makes it. */
    register(dagRoot: string, name: string, workloadId: string, sessionId: string) {
      const row = decode(rows.get(key(dagRoot)));
      row[name] = { workload_id: workloadId, session_id: sessionId } as HandleInfo;
      seq += 1;
      rows.set(key(dagRoot), { value: enc.encode(JSON.stringify(row)), revision: seq });
    },
    /** What the row holds now, read outside the code under test. */
    rowOf(dagRoot: string): Record<string, HandleInfo> | null {
      const row = rows.get(key(dagRoot));
      return !row || row.value === null ? null : decode(row);
    },
    dagRoots(): string[] {
      return [...rows.entries()].filter(([, r]) => r.value !== null).map(([k]) => dagOf(k));
    },
    leaderRow(dagRoot: string): Record<string, HandleInfo> {
      return decode(rows.get(key(dagRoot)));
    },
    /** Pin the direct-read surface at the snapshot it holds right now. */
    freeze() { frozen = new Map([...rows.entries()].map(([k, r]) => [k, { ...r }])); },
  };
}

type Bucket = ReturnType<typeof bucket>;
let kvb: Bucket;

/** Bind every registry call on the teardown path to `kvb`. */
function bindRegistry(b: Bucket): void {
  const map = new DagHandleMap(makeKvStore(b.replica as never));
  handleRegistry.lookup = (dag, name) => map.lookup(dag, name);
  handleRegistry.listForDag = (dag) => map.listForDag(dag);
  handleRegistry.listAll = () => map.listAll();
  handleRegistry.destroy = (dag, name, wid) =>
    destroyHandleCas(b.leader as never, dag, name, wid);
  handleRegistry.listDagRoots = async () => b.dagRoots();
  handleRegistry.listForDagConsistent = async (dag) => b.leaderRow(dag);
  handleRegistry.retained = async () => false;
}

afterEach(() => {
  Object.assign(handleRegistry, originalRegistry);
  globalThis.fetch = originalFetch;
});

beforeEach(async () => {
  await h.reset();
  stopped = [];
  kvb = bucket();
  bindRegistry(kvb);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    stopped.push(/\/workloads\/([^/]+)\/stop$/.exec(url)?.[1] ?? url);
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
});

/** The DAG root's `sandbox_release.unreleased` map, read outside the code. */
async function leakRecord(taskId: string): Promise<Record<string, unknown>> {
  const rows = await h.sql(`SELECT metadata FROM claw_tasks WHERE task_id = $1`, [taskId]);
  const meta = (rows[0]?.metadata ?? {}) as Record<string, unknown>;
  const release = (meta.sandbox_release ?? {}) as Record<string, unknown>;
  return (release.unreleased ?? {}) as Record<string, unknown>;
}

/**
 * Hold every party at the statement that commits the removal until all of them
 * have reached it.
 *
 * This is the whole interleaving: each side's ownership reads happen before
 * its own destroy, so parking both sides on entry to `destroy` puts every read
 * before every write, on every run, with nothing racing and no sleep anywhere.
 */
function rendezvousOnDestroy(parties: number): { arrivals: string[] } {
  const arrivals: string[] = [];
  const real = handleRegistry.destroy;
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  handleRegistry.destroy = async (dag, name, wid) => {
    arrivals.push(dag);
    arrived += 1;
    if (arrived >= parties) open();
    await gate;
    return real(dag, name, wid);
  };
  return { arrivals };
}

async function twoDagsSharing(workloadId: string): Promise<void> {
  await seedSession(h, "s-1");
  await seedRun(h, "dag-a", "s-1");
  await seedRun(h, "dag-b", "s-1");
  kvb.register("dag-a", "main", workloadId, "s-1");
  kvb.register("dag-b", "main", workloadId, "s-1");
}

test("S1 control: a workload one DAG holds alone is stopped", async () => {
  await seedSession(h, "s-1");
  await seedRun(h, "dag-solo", "s-1");
  kvb.register("dag-solo", "main", "w-solo", "s-1");

  const released = await stopSandboxByHandle("dag-solo", "main", "s-1");

  assert.equal(released, "confirmed");
  assert.deepEqual(stopped, ["w-solo"], "the wiring can issue a stop at all");
  assert.equal(kvb.rowOf("dag-solo"), null, "and the mapping goes with it");
  assert.deepEqual(await leakRecord("dag-solo"), {}, "a confirmed release clears its mark");
});

test("S2 control: two DAGs releasing SEQUENTIALLY -- the last holder stops it", async () => {
  await twoDagsSharing("w-shared");

  const first = await stopSandboxByHandle("dag-a", "main", "s-1");
  const afterA = [...stopped];
  const second = await stopSandboxByHandle("dag-b", "main", "s-1");

  assert.equal(first, "unconfirmed", "A declines: B demonstrably still holds it");
  assert.deepEqual(afterA, [], "and issues nothing against a sandbox B is running on");
  assert.equal(second, "confirmed", "B is the last holder");
  assert.deepEqual(stopped, ["w-shared"], "exactly one stop, from the last holder");
  assert.deepEqual(
    await leakRecord("dag-a"), {},
    "A's decline is not a leak, so it leaves no marker",
  );
});

test("S3 both release at once: the shared workload must still be stopped", { timeout: 30_000 }, async () => {
  // A test-runner timeout only, so a party that never reaches the statement
  // fails instead of hanging the suite. Nothing about the interleaving depends
  // on it: the rendezvous is what orders the reads and the writes.
  await twoDagsSharing("w-shared");
  const { arrivals } = rendezvousOnDestroy(2);

  const [a, b] = await Promise.all([
    stopSandboxByHandle("dag-a", "main", "s-1"),
    stopSandboxByHandle("dag-b", "main", "s-1"),
  ]);

  assert.deepEqual(
    [...arrivals].sort(), ["dag-a", "dag-b"],
    "both sides really did reach the removal before either committed it",
  );
  // THE PROPERTY. Before the last-holder re-check both sides declined, both
  // rows went, and `stopped` was empty -- a live GPU with nothing naming it.
  assert.ok(
    stopped.includes("w-shared"),
    `a workload both holders let go of has to be stopped by one of them, got ${JSON.stringify(stopped)}`,
  );
  assert.ok(
    [a, b].includes("confirmed"),
    `and somebody has to be able to say so, got ${JSON.stringify([a, b])}`,
  );
  assert.equal(kvb.rowOf("dag-a"), null, "both DAGs have let go");
  assert.equal(kvb.rowOf("dag-b"), null);
  // Stopping it twice is fine and is what a raced release does: the module
  // documents both the KV destroy and the SaFE stop as idempotent. Stopping it
  // zero times is the defect.
  assert.deepEqual(
    [...new Set(stopped)], ["w-shared"],
    "and nothing else was stopped on the way",
  );
  // Nothing outstanding to report, because the workload really was released --
  // which is a different sentence from the `nothing_held` this used to invent
  // over a running GPU.
  assert.deepEqual(await leakRecord("dag-a"), {});
  assert.deepEqual(await leakRecord("dag-b"), {});
});

test("S4 a stale direct read must not re-arm the mutual decline", { timeout: 30_000 }, async () => {
  // The re-check asks "does anybody still hold this" of a registry it has just
  // removed its own row from, and a direct read is allowed to be behind an
  // acknowledged delete. If the re-check believed one, both sides would see
  // the other's already-deleted row and decline again -- the same lost stop,
  // reached through the layer that was supposed to close it. So the replica is
  // frozen at the moment both rows still exist, and the leader is the only
  // surface that knows they are gone.
  await twoDagsSharing("w-shared");
  const { arrivals } = rendezvousOnDestroy(2);
  kvb.freeze();

  const [a, b] = await Promise.all([
    stopSandboxByHandle("dag-a", "main", "s-1"),
    stopSandboxByHandle("dag-b", "main", "s-1"),
  ]);

  assert.deepEqual([...arrivals].sort(), ["dag-a", "dag-b"]);
  assert.ok(
    stopped.includes("w-shared"),
    `a replica that never caught up is not a co-holder, got ${JSON.stringify(stopped)}`,
  );
  assert.ok([a, b].includes("confirmed"));
  assert.equal(kvb.rowOf("dag-a"), null);
  assert.equal(kvb.rowOf("dag-b"), null);
});

test("S5 a re-check that cannot be answered leaves the workload on record", async () => {
  // Every other declining exit keeps the mapping, and the mapping is its
  // evidence -- the sweeper comes back to it. This one cannot: the row is
  // already gone by the time the re-check is asked, so if the answer never
  // arrives, `unreleased` is the only place the workload can still be named.
  await twoDagsSharing("w-shared");
  const roots = handleRegistry.listDagRoots;
  handleRegistry.listDagRoots = async () => {
    // Hooked on the statement, not on a call count. The check that PERMITS or
    // forbids the stop short-circuits on the direct scan here -- dag-b's row
    // plainly names the workload -- so the only enumeration this path reaches
    // is the re-check's, and the re-check is by construction the one asked
    // after dag-a's own row is gone. That is the condition below.
    if (kvb.rowOf("dag-a") === null) {
      throw new Error("dag-handles enumeration ended on a closed connection");
    }
    return roots();
  };

  const released = await stopSandboxByHandle("dag-a", "main", "s-1");

  assert.equal(released, "unconfirmed", "nothing here established a release");
  assert.deepEqual(stopped, [], "and none was attempted");
  assert.equal(kvb.rowOf("dag-a"), null, "A's mapping is gone -- it let go before asking");
  const record = await leakRecord("dag-a");
  assert.deepEqual(
    Object.values(record).map((e) => (e as { workload_id?: string }).workload_id),
    ["w-shared"],
    "so the record is the only thing left naming the workload, and it does",
  );
  assert.equal(
    await stopAllHandlesForDag("dag-a", "s-1"), "unconfirmed",
    "and the DAG must not go on to claim it held nothing",
  );
});

test("S6 a legitimately shared decline still leaves no permanent marker", async () => {
  // What moving the shared-holder and retention checks ahead of the record and
  // the destroy bought, and what the re-check must not give back: before the
  // move, A's decline left an `unreleased` entry on a container B was happily
  // running on, and it was still there after B's CONFIRMED stop -- a leak
  // reported for a sandbox that never leaked.
  await twoDagsSharing("w-shared");

  await stopSandboxByHandle("dag-a", "main", "s-1");
  const afterA = await leakRecord("dag-a");
  await stopSandboxByHandle("dag-b", "main", "s-1");
  const afterB = await leakRecord("dag-a");

  assert.deepEqual(afterA, {}, "A declined without reporting a leak");
  assert.deepEqual(afterB, {}, "and none appears later either");
  assert.deepEqual(stopped, ["w-shared"]);
  assert.equal(
    await stopAllHandlesForDag("dag-a", "s-1"), "nothing_held",
    "so A is not marked as leaking for the rest of its life",
  );
});

test("S7 a retention is an older claim, not a race: no re-check, no record", async () => {
  // The re-check exists because a co-holder can let go microseconds after
  // being seen. A retention cannot be let go of by anything this call does --
  // it is discharged by Brain's own keepalive sweep -- so re-asking would only
  // create a way to stop a container somebody's background work is running in.
  await seedSession(h, "s-1");
  await seedRun(h, "dag-a", "s-1");
  kvb.register("dag-a", "main", "w-retained", "s-1");
  handleRegistry.retained = async () => true;
  let leaderReads = 0;
  const consistent = handleRegistry.listForDagConsistent;
  handleRegistry.listForDagConsistent = async (dag) => { leaderReads += 1; return consistent(dag); };

  const released = await stopSandboxByHandle("dag-a", "main", "s-1");

  assert.equal(released, "unconfirmed");
  assert.deepEqual(stopped, [], "a retained container is not this teardown's to stop");
  assert.equal(kvb.rowOf("dag-a"), null, "the mapping still goes -- this DAG is done with it");
  assert.deepEqual(
    await leakRecord("dag-a"), {},
    "and a container retention is protecting is not a workload that escaped",
  );
  assert.equal(leaderReads, 0, "nothing re-asked the registry about a claim it cannot discharge");
});

/**
 * B's hand-over, landing in the one window the last-holder re-check looks at:
 * after A's own row is gone, and before A re-asks who holds the workload.
 *
 * In the same order production writes it (`retainInsteadOfDestroying`): the
 * retention record replaces the handle, so it is written FIRST and the handle
 * is released after -- "retaining first means the reference that replaces the
 * handle exists before the handle can go". The removal is the production
 * `destroyHandleCas` against the leader, which is what
 * `releaseHandlesForWorkload` issues.
 *
 * Hooked on `handleRegistry.destroy` rather than on a timer: A's own removal
 * is by construction after every read A made and before the re-check, so this
 * is that window, reached on every run.
 */
function retainOnceAHasLetGo(workloadId: string, flag: { retained: boolean }): void {
  const real = handleRegistry.destroy;
  handleRegistry.destroy = async (dag, name, wid) => {
    const removed = await real(dag, name, wid);
    if (dag === "dag-a" && removed !== null) {
      flag.retained = true;
      await destroyHandleCas(kvb.leader as never, "dag-b", "main", workloadId);
    }
    return removed;
  };
}

test("S8 a retention that lands during this release protects the container too", async () => {
  // The re-check asks the registry whether any DAG still holds the workload.
  // That is not the only claim that forbids a stop, and between A's first read
  // and this one the claim can change KIND: B parks the container with
  // background shells still running in it, which writes a retention record and
  // then frees the last handle. So the re-check sees no holder, promotes A to
  // last holder -- and stops a sandbox somebody's work is running in. The
  // `retained` value A reads at the top is from before any of that happened.
  await twoDagsSharing("w-shared");
  const flag = { retained: false };
  handleRegistry.retained = async (workloadId: string) =>
    flag.retained && workloadId === "w-shared";
  retainOnceAHasLetGo("w-shared", flag);

  const released = await stopSandboxByHandle("dag-a", "main", "s-1");

  assert.deepEqual(
    stopped, [],
    "a container retention took over while this release was in flight is not this one's to stop",
  );
  assert.equal(released, "unconfirmed", "and nothing here established a release");
  assert.equal(kvb.rowOf("dag-a"), null, "A still let go -- it is done with the workload");
  assert.deepEqual(
    await leakRecord("dag-a"), {},
    "and a container retention is protecting is not a workload that escaped",
  );
});

test("S9 a retention re-check that cannot be answered leaves the workload on record", async () => {
  // The same shape S5 has for the holder half. A retention read that fails is
  // no evidence the container is unprotected, so it cannot license a stop --
  // and A's row is already gone, so `unreleased` is the only place the
  // workload can still be named.
  await twoDagsSharing("w-shared");
  const flag = { retained: false };
  handleRegistry.retained = async () => {
    if (kvb.rowOf("dag-a") === null) throw new Error("nats: no responders");
    return false;
  };
  retainOnceAHasLetGo("w-shared", flag);

  const released = await stopSandboxByHandle("dag-a", "main", "s-1");

  assert.equal(released, "unconfirmed");
  assert.deepEqual(stopped, [], "an unreadable retention ledger is not a licence to stop");
  assert.equal(kvb.rowOf("dag-a"), null);
  const record = await leakRecord("dag-a");
  assert.deepEqual(
    Object.values(record).map((e) => (e as { workload_id?: string }).workload_id),
    ["w-shared"],
    "so the record is the only thing left naming the workload, and it does",
  );
});
