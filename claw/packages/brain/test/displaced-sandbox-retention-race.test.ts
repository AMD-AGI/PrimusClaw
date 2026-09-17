// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two ways the retain-on-displacement hand-over acted on a snapshot that
 * had stopped being true by the time it acted.
 *
 * `displaced-sandbox-retention.test.ts` next door pins what the hand-over is
 * FOR: a sandbox the session moves off keeps the record that says work is still
 * running in it. These are about the two reads it takes on the way there.
 *
 * X1/X2 -- the session slot. `readReusableEntry` reads `hands.<session>` at a
 * revision and `retainContainer` then deletes that key. In between are two
 * store round trips (the retention ledger and its projection), and a concurrent
 * DAG C in the same session can put ITS binding on the slot inside that window
 * -- the caller's own next act is that very put, with no CAS on it. The delete
 * was unconditional, so it took C's binding instead of the one the decision was
 * about. What that costs is not bookkeeping: the API's background-work guard
 * reads that slot before an orphan sweep stops a workload, and a session with
 * no binding is `no_binding`, which is reclaimable. So B, having decided to
 * PROTECT W1, stops W2 -- a container it never looked at, running a shell that
 * was never in question.
 *
 * X3/X4 -- the container. The hand-over asks `countLiveWork` over the exec
 * channel, and a container the provider has already confirmed gone cannot
 * answer: the exec throws, which is `unknown`, which retains. The same read is
 * what `runRetentionReadPhase` repeats every sweep to decide when to let go, so
 * it answers `unknown` there too, for ever. A dead container is then a
 * permanent retention and a permanent census target, and with
 * SANDBOX_SWEEPER_EVICT_AFTER_FAILURES and SANDBOX_KEEPALIVE_FAIL_LIMIT both
 * defaulting to 0 nothing in the fleet removes it.
 *
 * Every assertion is about what happened to a container or to a record a later
 * reader will act on: which workload a stop was issued against, whether the
 * shell in it is still running, what the session slot holds, and what the
 * retention roster keeps asking about. The fleet is one variable -- a stop
 * zeroes the shells the live-work count is read from -- so a count and a stop
 * cannot drift apart in the model the way they cannot in the cluster.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import { isRetentionEntry, usableSharedVerdict } from "@claw/protocol";

import {
  bindSandboxReuseEffects,
  requestSpecFingerprint,
  tryReuseSessionSandbox,
} from "../src/sandbox/ensure-hands.js";
import { resolveSandboxAction } from "../src/sandbox/params.js";
import { handsSessionKey } from "../src/sandbox/hands-key.js";
import { retentionStore } from "../src/sandbox/registry.js";
import {
  RETENTION_LEDGER_FILTER, ledgerKeyForRetention, releaseRetention, retentionKey,
} from "../src/sandbox/retain-container.js";
import { matchesKvFilter } from "./fixtures/kv-filter.js";

const realFetch = globalThis.fetch;
let restoreEffects: (() => void) | null = null;
afterEach(() => {
  globalThis.fetch = realFetch;
  restoreEffects?.();
  restoreEffects = null;
});

/* ------------------------------------------------------------------ store */

/** JetStream's answer to a conditional write that lost, which is what the
 *  store classifies on -- verified against a live bucket: a delete carrying a
 *  stale `previousSeq` is rejected as `wrong last sequence: <n>`, the entry is
 *  left exactly as it was, and `isRevisionConflict` recognises it. */
function conflict(seq: number): Error {
  return new Error(`wrong last sequence: ${seq}`);
}

interface Store { kv: KV; map: Map<string, { value: Uint8Array; revision: number }>; }

/**
 * The registry bucket, with only the operations these paths use.
 *
 * `delete` honours `previousSeq` the way the real bucket does -- an expected
 * last sequence that does not match the entry's current revision is refused and
 * nothing is removed -- because that condition is the whole subject of X1/X2. A
 * stub that ignored the option would pass a broken fix.
 *
 * `onWrite` is how a concurrent actor is landed INSIDE a window rather than
 * before or after it: the hook runs on a write the code under test makes, so
 * the interleaving is one the real store can produce rather than one the test
 * arranges by ordering its own statements.
 */
function memoryKv(
  seed: Record<string, unknown> = {},
  onWrite?: (key: string, kv: KV) => Promise<void>,
): Store {
  const enc = new TextEncoder();
  const map = new Map<string, { value: Uint8Array; revision: number }>(
    Object.entries(seed).map(([k, v]) => [k, { value: enc.encode(JSON.stringify(v)), revision: 3 }]),
  );
  const kv = {
    async get(key: string) {
      const held = map.get(key);
      return held ? { key, value: held.value, revision: held.revision, operation: "PUT" } : null;
    },
    async put(key: string, value: Uint8Array) {
      const revision = (map.get(key)?.revision ?? 0) + 1;
      map.set(key, { value, revision });
      return revision;
    },
    async create(key: string, value: Uint8Array) {
      if (map.has(key)) throw conflict(map.get(key)!.revision);
      map.set(key, { value, revision: 1 });
      if (onWrite) await onWrite(key, kv as unknown as KV);
      return 1;
    },
    async update(key: string, value: Uint8Array, revision: number) {
      if (map.get(key)?.revision !== revision) throw conflict(map.get(key)?.revision ?? 0);
      map.set(key, { value, revision: revision + 1 });
      return revision + 1;
    },
    async delete(key: string, opts?: { previousSeq?: number }) {
      const held = map.get(key);
      // `previousSeq: 0` is not a condition in the client either -- it tests the
      // option for truthiness before setting the expected-sequence header.
      if (opts?.previousSeq && held && held.revision !== opts.previousSeq) {
        throw conflict(held.revision);
      }
      if (opts?.previousSeq && !held) throw conflict(0);
      map.delete(key);
    },
    async keys(filter = ">") {
      const matched = [...map.keys()].filter((k) => matchesKvFilter(k, filter));
      return (async function* () { for (const k of matched) yield k; })();
    },
  };
  return { kv: kv as unknown as KV, map };
}

/* ------------------------------------------------------------------ fleet */

/**
 * The sandboxes, what is running in each, and which of them the provider has
 * already lost.
 *
 * `stops` is every workload a stop was issued against, in order; a stop zeroes
 * that workload's shells. `gone` is a container the control plane no longer
 * has -- an exec into one throws, which is how `countLiveWork` comes back
 * `unknown` rather than `clear` for a dead sandbox. `liveWorkReads` is every
 * container a live-work read was addressed to, which is what makes "this
 * container is still being asked, sweep after sweep" an observable.
 */
interface Fleet {
  stops: string[];
  shells: Map<string, number>;
  gone: Set<string>;
  liveWorkReads: string[];
}

function newFleet(shells: Record<string, number>, gone: string[] = []): Fleet {
  return {
    stops: [],
    shells: new Map(Object.entries(shells)),
    gone: new Set(gone),
    liveWorkReads: [],
  };
}

function stop(fleet: Fleet, workloadId: string): void {
  fleet.stops.push(workloadId);
  fleet.shells.set(workloadId, 0);
}

/** The live-work count, as the exec channel answers it. */
function countInFleet(fleet: Fleet, workloadId: string) {
  fleet.liveWorkReads.push(workloadId);
  if (fleet.gone.has(workloadId)) {
    // What `countLiveWork` returns when the exec throws: a container that could
    // not be asked never answered zero.
    return {
      verdict: "unknown" as const, classes: {},
      reason: "exec_unanswered: workload not found",
    };
  }
  const alive = fleet.shells.get(workloadId) ?? 0;
  return alive > 0
    ? { verdict: "protected" as const, classes: { background: alive }, reason: "live_work_present" }
    : { verdict: "clear" as const, classes: {}, reason: "no_live_work" };
}

/* ------------------------------------------------- the readers next door */

/** Whether a retention record protects this workload -- `handleRegistry.retained`
 *  in api/src/tasks/sandbox-stopper.ts, over the records this side writes. */
async function retained(kv: KV, workloadId: string): Promise<boolean> {
  const store = retentionStore(kv);
  const keys = [
    ...await store.keys(RETENTION_LEDGER_FILTER),
    ...(await store.keys("hands.*")).filter((k) => k.startsWith("hands.retained-")),
  ];
  for (const key of keys) {
    const held = await store.read(key);
    if (!held) continue;
    const record = JSON.parse(held.value) as { workloadId?: string };
    if (isRetentionEntry(record) && record.workloadId === workloadId) return true;
  }
  return false;
}

/**
 * The orphan sweep's decision about one workload, over the two records Brain
 * writes for it.
 *
 * `readSessionBackgroundWork` (api/src/tasks/sandbox-stopper.ts) reads
 * `hands.<session>` through both names, and three of its answers decide this:
 * no binding at all is `no_binding`, a binding naming a different workload is
 * `other_sandbox`, and both are `clear` -- which `bindingNamesOneOf` in
 * api/src/tasks/sweeper.ts reads as "nothing on record holds this", and the
 * stop goes out. A binding that DOES name the workload is judged by the shared
 * verdict rule, imported here rather than restated so a binding this test calls
 * protected is one the real reader would also protect.
 */
async function sweepOrphan(
  kv: KV, fleet: Fleet, sessionId: string, workloadId: string, now = Date.now(),
): Promise<void> {
  if (await retained(kv, workloadId)) return;
  const entry = await kv.get(handsSessionKey(sessionId));
  const info = entry && entry.value.length > 0
    ? JSON.parse(new TextDecoder().decode(entry.value)) as Record<string, unknown>
    : null;
  if (!info || info.workloadId !== workloadId) {
    stop(fleet, workloadId); // no_binding / other_sandbox -> reclaimable
    return;
  }
  const verdict = usableSharedVerdict(info as never, now);
  if (verdict?.state === "running") return;
  stop(fleet, workloadId);
}

/**
 * One pass of the keepalive retention phase, as `runRetentionReadPhase` runs it
 * (brain/src/sandbox/keepalive.ts): every retention is a census target, the
 * live-work read is re-run inside the container, and only `clear` releases --
 * handles first, records second. The release is the real `releaseRetention`
 * over the real store, so a record this leaves standing is one the production
 * sweep would also leave standing.
 */
async function retentionSweep(kv: KV, fleet: Fleet): Promise<void> {
  const store = retentionStore(kv);
  for (const key of await store.keys("hands.*")) {
    if (!key.startsWith("hands.retained-")) continue;
    const held = await store.read(key);
    if (!held) continue;
    const record = JSON.parse(held.value) as { workloadId?: string };
    if (!isRetentionEntry(record)) continue;
    const live = countInFleet(fleet, record.workloadId ?? "");
    if (live.verdict !== "clear") continue;
    await releaseRetention(store, key, ledgerKeyForRetention(key));
  }
}

/* --------------------------------------------------------------- fixtures */

const SESSION = "s-race";
const W1_URL = "http://hands-1.test:9100/mcp";

/** T2's request: a different image from the one W1 was built to. */
const T2: ExecuteRequest = {
  session_id: SESSION,
  prompt: "carry on",
  sandbox_image: "example.io/torch:2.5",
  task_id: "t-2",
  dag_root_task_id: "dag-t2",
};

function specOf(request: ExecuteRequest): string {
  const action = resolveSandboxAction(request);
  assert.equal(action.kind, "create", "this fixture has to describe a sandbox to build");
  return requestSpecFingerprint(request, action as never);
}

/** T1's sandbox, as the create path recorded it. */
function w1Binding(): Record<string, unknown> {
  return {
    status: "ready",
    taskId: "t-1",
    dagRootTaskId: "dag-t1",
    runScope: "lock.session.s-race",
    provider: "safe-workload",
    workloadId: "w-1",
    handsUrl: W1_URL,
    sandboxImage: "example.io/torch:2.4",
    specFingerprint: specOf(T2).replace(/:[0-9a-f]+$/, ":ffffffffffffffff"),
    platformKey: "pk-1",
    token: "tok-1",
    namespace: "ns-1",
    createdAt: new Date().toISOString(),
  };
}

/**
 * C's sandbox on the same session, parked with a background shell running in
 * it and the verdict that says so -- the fields `usableSharedVerdict` requires,
 * stamped against the idle period the entry is actually in.
 */
function w2Binding(now: number): Record<string, unknown> {
  return {
    status: "ready",
    taskId: "t-3",
    dagRootTaskId: "dag-t3",
    provider: "safe-workload",
    workloadId: "w-2",
    handsUrl: "http://hands-2.test:9100/mcp",
    platformKey: "pk-1",
    token: "tok-2",
    idleSince: now,
    idleEpoch: 1,
    idleRev: 1,
    bgCheckedAt: now,
    bgRunning: 1,
    bgEpoch: 1,
    bgIdleSince: now,
    bgIdleRev: 1,
  };
}

interface Effects { released: string[] }

function stubEffects(fleet: Fleet, over: {
  probe?: "alive" | "dead" | "unknown";
  restartRefused?: boolean;
} = {}): Effects {
  const effects: Effects = { released: [] };
  restoreEffects = bindSandboxReuseEffects({
    destroyHands: (async (_sessionId: string, known?: { workloadId?: string }) => {
      if (known?.workloadId) stop(fleet, known.workloadId);
    }) as never,
    registerSandbox: (() => {}) as never,
    probeSandboxContainer: async () => ({
      verdict: over.probe ?? "alive",
      reason: over.probe === "dead" ? "exec_sandbox_gone" as const : "exec_ok" as const,
    }),
    restartHandsInSandbox: async () => (over.restartRefused
      ? { ok: false, detail: "kill switch off", refused: true }
      : { ok: true, detail: "healthy" }),
    releaseHandlesForWorkload: (async (id: string) => { effects.released.push(id); }) as never,
    // T2's DAG holds no handle on W1; T1's DAG still does, which is what makes
    // W1 "not this turn's to stop".
    dagHoldsWorkload: (async () => false) as never,
    workloadHeldByOtherDag: (async () => true) as never,
    countLiveWork: (async (inst: { id?: string }) => countInFleet(fleet, inst?.id ?? "")) as never,
  });
  return effects;
}

function attempt(kv: KV, request: ExecuteRequest = T2) {
  return {
    kv,
    sessionId: SESSION,
    request,
    requestedSpec: specOf(request),
    onEvent: async () => {},
  } as Parameters<typeof tryReuseSessionSandbox>[0];
}

/* ------------------------------------------------------------------ tests */

test("X1 the hand-over does not delete the binding of a sandbox it never looked at", async () => {
  // B is T2: it cannot reuse W1 (different image), W1 is not its to stop, so it
  // hands W1 over to retention. C is another DAG on the same session that
  // finishes a turn on W2 and parks it while B is mid-hand-over. C's put is
  // landed on B's first retention write, which is inside the window between B
  // reading the slot at revision 3 and B deleting it.
  const now = Date.now();
  const fleet = newFleet({ "w-1": 1, "w-2": 1 });
  stubEffects(fleet);
  let moved = false;
  const store = memoryKv({ [handsSessionKey(SESSION)]: w1Binding() }, async (key, kv) => {
    if (moved || !key.startsWith("retention.")) return;
    moved = true;
    await kv.put(
      handsSessionKey(SESSION),
      new TextEncoder().encode(JSON.stringify(w2Binding(now))),
    );
  });

  assert.equal(await tryReuseSessionSandbox(attempt(store.kv)), null);
  assert.ok(moved, "the concurrent put has to have landed inside the hand-over");

  // Nothing about W2 was in question, so nothing about W2 may change.
  await sweepOrphan(store.kv, fleet, SESSION, "w-2", now);
  assert.deepEqual(
    fleet.stops, [],
    "the orphan sweep still reads a binding that names W2 and a verdict that says "
    + "a shell is running in it, instead of the `no_binding` a stolen delete leaves",
  );
  assert.equal(fleet.shells.get("w-2"), 1, "C's background shell is still running");

  const slot = await store.kv.get(handsSessionKey(SESSION));
  assert.ok(slot && slot.value.length > 0, "C's binding is still on the session slot");
  assert.equal(
    JSON.parse(new TextDecoder().decode(slot!.value)).workloadId, "w-2",
    "and it is still C's, not a tombstone left by B's delete",
  );

  // And B's own hand-over still happened: the point is not to skip the work.
  assert.equal(await retained(store.kv, "w-1"), true, "W1 is retained");
  const record = await retentionStore(store.kv).read(retentionKey(W1_URL));
  assert.equal(
    JSON.parse(record!.value).workloadId, "w-1",
    "under the generation W1's shells record, so it is still addressable",
  );
  await sweepOrphan(store.kv, fleet, SESSION, "w-1", now);
  assert.deepEqual(fleet.stops, [], "and W1 is not stopped either");
  assert.equal(fleet.shells.get("w-1"), 1, "its shell is still running too");
});

test("X2 CONTROL: with nobody else on the slot the hand-over still clears it", async () => {
  // The other half of X1: refusing to delete is not the fix. When the slot
  // still holds the binding the decision was taken on, it goes -- that is what
  // stops the session being handed a container it has given up, and what
  // `retainedTaker` and the reuse gate are written against.
  const fleet = newFleet({ "w-1": 1 });
  stubEffects(fleet);
  const store = memoryKv({ [handsSessionKey(SESSION)]: w1Binding() });

  assert.equal(await tryReuseSessionSandbox(attempt(store.kv)), null);

  assert.equal(
    store.map.has(handsSessionKey(SESSION)), false,
    "the session no longer names the container it moved off",
  );
  assert.equal(await retained(store.kv, "w-1"), true, "which the retention now names instead");
  await sweepOrphan(store.kv, fleet, SESSION, "w-1");
  assert.deepEqual(fleet.stops, [], "and that record is what keeps it");
});

test("X3 a container the provider has lost is not retained, and not asked about for ever", async () => {
  // Hands is not answering, the probe comes back `dead` -- for a safe-workload
  // sandbox that is the provider's own confirmation that the workload is gone,
  // never a failed request -- and W1 is somebody else's DAG's. There is no
  // container left to protect: a stop cannot reach it and no shell can be
  // running in it.
  const fleet = newFleet({ "w-1": 0 }, ["w-1"]);
  stubEffects(fleet, { probe: "dead" });
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const store = memoryKv({
    [handsSessionKey(SESSION)]: { ...w1Binding(), specFingerprint: specOf(T2) },
  });

  assert.equal(await tryReuseSessionSandbox(attempt(store.kv)), null);

  assert.equal(
    await retained(store.kv, "w-1"), false,
    "a workload the control plane no longer has is not protected work",
  );
  assert.deepEqual(
    (await retentionStore(store.kv).keys(RETENTION_LEDGER_FILTER)), [],
    "so no ledger entry is left for the sweep to walk",
  );

  // The sweep that would have to let go of it cannot: it re-runs the same
  // live-work read, and a container that cannot answer never says `clear`.
  const before = fleet.liveWorkReads.length;
  for (let i = 0; i < 3; i++) await retentionSweep(store.kv, fleet);
  assert.equal(
    fleet.liveWorkReads.length - before, 0,
    "three sweeps later the dead container is not still being queried once per sweep",
  );
});

test("X4 CONTROL: a container that is merely unreachable is retained, and released when its work ends", async () => {
  // The distinction the fix turns on. Hands is down and cannot be restarted,
  // but the container itself answered the probe: the shells in it are real
  // processes and the hand-over must keep them. And the census CAN reach
  // `clear` here, which is what makes "never clear" the defect in X3 rather
  // than the normal course of things.
  const fleet = newFleet({ "w-1": 2 });
  stubEffects(fleet, { probe: "alive", restartRefused: true });
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const store = memoryKv({
    [handsSessionKey(SESSION)]: { ...w1Binding(), specFingerprint: specOf(T2) },
  });

  assert.equal(await tryReuseSessionSandbox(attempt(store.kv)), null);
  assert.equal(await retained(store.kv, "w-1"), true, "the live container is kept");

  await retentionSweep(store.kv, fleet);
  assert.equal(await retained(store.kv, "w-1"), true, "and kept while the shells run");
  assert.equal(fleet.shells.get("w-1"), 2, "the shells were not touched");

  fleet.shells.set("w-1", 0); // the user's background work finishes
  await retentionSweep(store.kv, fleet);
  assert.equal(
    await retained(store.kv, "w-1"), false,
    "the retention is released once the work it was taken for is over",
  );
});
