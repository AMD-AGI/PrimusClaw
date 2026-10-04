// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// One jobs-probe reading must not destroy a sandbox.
//
// A node-agent restart under the sandbox runtime broke the data path for a
// moment. The keepalive probe read EOF (deferred, correctly) and then, on the
// next probe that got through, destroyed every sandbox it asked about -- each
// still running a few hundred user processes. The first answer after such a
// blip can be an empty roster, or come from an EnvD with a new instance id, and
// either one used to be enough on its own.
//
// These run at the shipped defaults (3 agreeing sweeps, 300 s quiet window) and
// drive the real jobs probe through a stubbed Router, so the EnvD identity the
// roster answers from is part of what is under test.

import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import * as replicaA from "../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { registry } from "../src/infra/metrics.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider, SandboxStatus } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-confirm";
const KEY = `hands.${SESSION}`;
const SWEEP_MS = 60_000;
/** Long enough ago that the 15 minute reuse window is over. */
const LONG_AGO_MS = 60 * 60_000;

function entry(now: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ready",
    provider: "safe-workload",
    workloadId: "wl-confirm",
    platformKey: "pk",
    namespace: "ns",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok",
    keepalive: false,
    idleSince: now - LONG_AGO_MS,
    // The reuse window opened an hour ago, so the sweep is at the destroy
    // boundary and the only thing left to decide is whether to believe the probe.
    quiescedAt: now - LONG_AGO_MS,
    podUid: "pod-1",
    envdInstanceId: "envd-1",
    ...patch,
  };
}

// --- a bucket two replicas share ---

interface SharedKv {
  kv: KV;
  deleted: string[];
  current: () => Record<string, any> | null;
}

/** Runs on every read of the run lease, before it answers; see the last test. */
let onLeaseRead: (() => Promise<void>) | null = null;
/** Runs on every conditional write of the hands record, before its CAS; may throw. */
let onRecordUpdate: ((next: Record<string, any>) => void) | null = null;

function sharedKv(initial: Record<string, unknown>): SharedKv {
  const store = new Map<string, { value: Uint8Array; revision: number }>();
  let seq = 10;
  store.set(KEY, { value: sc.encode(JSON.stringify(initial)), revision: seq });
  const deleted: string[] = [];
  const kv = {
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      const matched = [...store.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      if (key === `lock.${SESSION}` && onLeaseRead) await onLeaseRead();
      const e = store.get(key);
      return e ? { key, value: e.value, revision: e.revision, operation: "PUT" } : null;
    },
    async put(key: string, value: Uint8Array) {
      store.set(key, { value, revision: ++seq });
      return seq;
    },
    async create(key: string, value: Uint8Array) {
      if (store.has(key)) throw new Error("wrong last sequence: key exists");
      store.set(key, { value, revision: ++seq });
      return seq;
    },
    async update(key: string, value: Uint8Array, rev: number) {
      if (key === KEY && onRecordUpdate) onRecordUpdate(JSON.parse(sc.decode(value)));
      const e = store.get(key);
      if (!e || e.revision !== rev) throw new Error("wrong last sequence");
      store.set(key, { value, revision: ++seq });
      return seq;
    },
    async delete(key: string, opts?: { previousSeq?: number }) {
      const e = store.get(key);
      if (opts?.previousSeq !== undefined && e && e.revision !== opts.previousSeq) {
        throw new Error("wrong last sequence");
      }
      store.delete(key);
      deleted.push(key);
    },
    async purge(key: string) { store.delete(key); deleted.push(key); },
  } as unknown as KV;
  return {
    kv,
    deleted,
    current: () => {
      const e = store.get(KEY);
      return e ? JSON.parse(sc.decode(e.value)) : null;
    },
  };
}

// --- the control plane and the EnvD roster ---

let status: SandboxStatus = { running: true, healthy: true, state: "running" };
let stops: string[] = [];
let restoreProviders: (() => void) | null = null;

function stubProvider(): void {
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return status; },
    async stop(inst: { id: string }) { stops.push(inst.id); },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
}

type Roster =
  | { kind: "eof" }
  | { kind: "ok"; count: number; pod?: string; instance?: string };
let roster: Roster = { kind: "ok", count: 0 };
/** When set, every jobs read waits on it before answering. */
let rosterGate: Promise<void> | null = null;
/** Jobs reads made so far, answered or still waiting on the gate. */
let rosterReads = 0;
const realFetch = globalThis.fetch;

function stubRouter(): void {
  globalThis.fetch = (async (url: string | URL) => {
    if (!String(url).endsWith("/api/jobs")) throw new Error(`unexpected fetch ${String(url)}`);
    rosterReads += 1;
    if (rosterGate) await rosterGate;
    if (roster.kind === "eof") {
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("other side closed (EOF)") });
    }
    return new Response(JSON.stringify({
      user_process_count: roster.count,
      pod_uid: roster.pod ?? "pod-1",
      instance_id: roster.instance ?? "envd-1",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

beforeEach(() => {
  status = { running: true, healthy: true, state: "running" };
  stops = [];
  roster = { kind: "ok", count: 0 };
  rosterGate = null;
  rosterReads = 0;
  onLeaseRead = null;
  onRecordUpdate = null;
  stubProvider();
  stubRouter();
});

afterEach(() => {
  replicaA.resetBackgroundWorkStateForTest();
  globalThis.fetch = realFetch;
  restoreProviders?.();
  restoreProviders = null;
});

type Replica = typeof replicaA;

/** One sweep on `replica`, then let the probes it dispatched land. */
async function sweep(replica: Replica, kv: KV): Promise<void> {
  await replica.runKeepaliveTickForTest({ kv });
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

function destroyed(k: SharedKv): boolean {
  return stops.includes("wl-confirm") || k.deleted.includes(KEY);
}

async function reclaimCount(reason: string): Promise<number> {
  const m = await registry.getSingleMetric("claw_brain_keepalive_reclaim_total")?.get();
  return m?.values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

test("an empty roster read once, right after an EOF, does not destroy the sandbox", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = sharedKv(entry(Date.now()));

  roster = { kind: "eof" };
  await sweep(replicaA, k.kv);

  // The data path is back and EnvD answers -- with nothing in its roster.
  t.mock.timers.tick(SWEEP_MS);
  roster = { kind: "ok", count: 0 };
  await sweep(replicaA, k.kv);

  assert.ok(!destroyed(k), `one reading after a failed probe destroyed it; stops=${JSON.stringify(stops)}`);
  assert.equal(typeof k.current()?.lastProbeFailureAt, "number", "the failed read is on the record");
  assert.equal(k.current()?.status, "ready");
  assert.equal(k.current()?.reclaimStreak?.reason, "idle_empty");
  assert.equal(k.current()?.reclaimStreak?.count, 1, "the reading is recorded, not acted on");

  // Still inside the quiet window after the failure: three agreeing sweeps are
  // not enough until the window has passed.
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(SWEEP_MS);
    await sweep(replicaA, k.kv);
  }
  assert.ok(!destroyed(k), "the quiet window after a failed probe holds even a confirmed streak");
  assert.ok((k.current()?.reclaimStreak?.count ?? 0) >= 3, "sanity: the streak itself is confirmed");

  t.mock.timers.tick(5 * SWEEP_MS);
  await sweep(replicaA, k.kv);
  assert.ok(destroyed(k), "past the window, a confirmed empty roster is reclaimed");
});

test("an empty roster on 3 consecutive sweeps destroys it, on the third and not before", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = sharedKv(entry(Date.now()));
  const before = await reclaimCount("idle_empty");

  await sweep(replicaA, k.kv);
  assert.ok(!destroyed(k), "sweep 1 of 3");
  assert.equal(k.current()?.reclaimStreak?.count, 1);

  // A second replica, or a second visit inside the same sweep, is not a second
  // sweep: readings closer than half an interval count once.
  t.mock.timers.tick(1_000);
  await sweep(replicaA, k.kv);
  assert.equal(k.current()?.reclaimStreak?.count, 1, "same sweep, same evidence");

  t.mock.timers.tick(SWEEP_MS);
  await sweep(replicaA, k.kv);
  assert.ok(!destroyed(k), "sweep 2 of 3");
  assert.equal(k.current()?.reclaimStreak?.count, 2);

  t.mock.timers.tick(SWEEP_MS);
  await sweep(replicaA, k.kv);
  assert.ok(destroyed(k), "sweep 3 of 3 confirms it");
  assert.deepEqual(stops, ["wl-confirm"], "exactly one stop, of this workload");
  assert.equal(await reclaimCount("idle_empty"), before + 1, "counted by the evidence that authorised it");
});

test("a positive count in between restarts the count", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = sharedKv(entry(Date.now()));

  await sweep(replicaA, k.kv);
  t.mock.timers.tick(SWEEP_MS);
  await sweep(replicaA, k.kv);
  assert.equal(k.current()?.reclaimStreak?.count, 2, "sanity: one sweep short of a destroy");

  t.mock.timers.tick(SWEEP_MS);
  roster = { kind: "ok", count: 250 };
  await sweep(replicaA, k.kv);
  assert.equal(k.current()?.reclaimStreak, undefined, "the contrary reading ends the streak");
  assert.equal(typeof k.current()?.lastPositiveCountAt, "number");

  roster = { kind: "ok", count: 0 };
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(SWEEP_MS);
    await sweep(replicaA, k.kv);
  }
  assert.ok(!destroyed(k), `two old zeros plus new ones must not add up; stops=${JSON.stringify(stops)}`);
});

test("a new EnvD instance, read once, does not destroy the sandbox", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = sharedKv(entry(Date.now()));

  // The EnvD that answers is not the one the handle was bound to.
  roster = { kind: "ok", count: 0, instance: "envd-2" };
  await sweep(replicaA, k.kv);

  assert.ok(!destroyed(k), `one replaced reading destroyed it; stops=${JSON.stringify(stops)}`);
  assert.equal(k.current()?.terminalReason, undefined, "and recorded no terminal verdict either");
  assert.equal(k.current()?.status, "ready");
  assert.equal(k.current()?.reclaimStreak?.reason, "instance_replaced");
  assert.equal(k.current()?.reclaimStreak?.instanceIdAfter, "envd-2");

  // The bound instance answers again: contrary evidence, the replaced run ends.
  t.mock.timers.tick(SWEEP_MS);
  roster = { kind: "ok", count: 0 };
  await sweep(replicaA, k.kv);
  assert.notEqual(k.current()?.reclaimStreak?.reason, "instance_replaced");
  assert.ok(!destroyed(k));
});

test("a new EnvD instance on an idle handle still in its window is not marked terminal", async (t) => {
  // The production shape: a handle holding background work, so no reuse window
  // is open and only the background probe asks. Its replaced reading used to
  // write terminalReason + closing, and the next sweep stopped the workload.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = sharedKv(entry(Date.now(), { quiescedAt: undefined }));

  roster = { kind: "eof" };
  await sweep(replicaA, k.kv);
  t.mock.timers.tick(SWEEP_MS);
  roster = { kind: "ok", count: 0, instance: "envd-2" };
  await sweep(replicaA, k.kv);
  t.mock.timers.tick(SWEEP_MS);
  await sweep(replicaA, k.kv);

  assert.equal(k.current()?.terminalReason, undefined, `terminal on one reading; record=${JSON.stringify(k.current())}`);
  assert.equal(k.current()?.status, "ready");
  assert.ok(!destroyed(k));
});

test("a replaced instance confirmed on 3 sweeps, with no failure in the window, is reclaimed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = sharedKv(entry(Date.now()));
  roster = { kind: "ok", count: 0, instance: "envd-2" };
  const before = await reclaimCount("instance_replaced");

  for (let i = 0; i < 2; i++) {
    await sweep(replicaA, k.kv);
    t.mock.timers.tick(SWEEP_MS);
  }
  assert.ok(!destroyed(k), "two of three");
  await sweep(replicaA, k.kv);
  assert.ok(destroyed(k), "the third agreeing sweep confirms the replacement");
  assert.equal(await reclaimCount("instance_replaced"), before + 1,
    "destroyed as a replacement, not as an empty roster");
});

test("a replaced instance reporting live processes on every sweep is never reclaimed", async (t) => {
  // The instance that answers is new, but it is running the user's work: a
  // positive count is contrary evidence whichever EnvD reports it.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = sharedKv(entry(Date.now()));
  roster = { kind: "ok", count: 250, instance: "envd-2" };

  for (let i = 0; i < 4; i++) {
    await sweep(replicaA, k.kv);
    t.mock.timers.tick(SWEEP_MS);
  }
  assert.ok(!destroyed(k), `live processes on the new instance were reclaimed; stops=${JSON.stringify(stops)}`);
  assert.equal(k.current()?.reclaimStreak, undefined, "a positive count does not build a replaced streak");
  assert.equal(typeof k.current()?.lastPositiveCountAt, "number", "and opens the quiet window");

  // The work then finishes on the new instance: the replaced readings count
  // from zero and the quiet window after the last positive count still holds.
  roster = { kind: "ok", count: 0, instance: "envd-2" };
  for (let i = 0; i < 3; i++) {
    await sweep(replicaA, k.kv);
    t.mock.timers.tick(SWEEP_MS);
  }
  assert.ok(!destroyed(k), "inside the quiet window after the last positive count");
  assert.equal(k.current()?.reclaimStreak?.reason, "instance_replaced");
});

test("replaced readings from different new instances do not add up", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = sharedKv(entry(Date.now()));

  for (const instance of ["envd-2", "envd-3", "envd-2"]) {
    roster = { kind: "ok", count: 0, instance };
    await sweep(replicaA, k.kv);
    t.mock.timers.tick(SWEEP_MS);
  }
  assert.ok(!destroyed(k), `three replaced readings about different instances destroyed it; stops=${JSON.stringify(stops)}`);
  assert.equal(k.current()?.reclaimStreak?.count, 1, "each new identity starts its own run");
});

test("a workload the control plane reports terminal is still destroyed at once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // Even straight after a failed probe: the control plane's answer is authoritative.
  const k = sharedKv(entry(Date.now(), { lastProbeFailureAt: Date.now() }));
  status = { running: false, healthy: false, state: "terminal", reason: "sandbox_workload_failed" };
  const before = await reclaimCount("terminal");

  await sweep(replicaA, k.kv);

  assert.ok(destroyed(k), `terminal must not wait for confirmation; record=${JSON.stringify(k.current())}`);
  assert.equal(await reclaimCount("terminal"), before + 1);
});

test("a workload the control plane reports absent is still destroyed at once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = sharedKv(entry(Date.now(), { lastProbeFailureAt: Date.now() }));
  status = { running: false, healthy: false, state: "absent" };

  await sweep(replicaA, k.kv);

  assert.ok(destroyed(k), `absent must not wait for confirmation; record=${JSON.stringify(k.current())}`);
});

test("the streak is on the record, so sweeps on different replicas add up", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // A second, independent instance of the keepalive module: its own process
  // memory (probe cache, registry, cursors), the same bucket.
  const replicaB = await import("../src/sandbox/keepalive.js?replica=b") as Replica;
  assert.notEqual(replicaB.runKeepaliveTickForTest, replicaA.runKeepaliveTickForTest,
    "sanity: two module instances, not one imported twice");
  const k = sharedKv(entry(Date.now()));
  try {
    await sweep(replicaA, k.kv);
    t.mock.timers.tick(SWEEP_MS);
    await sweep(replicaB, k.kv);
    assert.ok(!destroyed(k), "two sweeps, one on each replica");
    assert.equal(k.current()?.reclaimStreak?.count, 2, "B continued A's count from the record");

    t.mock.timers.tick(SWEEP_MS);
    await sweep(replicaA, k.kv);
    assert.ok(destroyed(k), "the third sweep, wherever it runs, confirms it");
  } finally {
    replicaB.resetBackgroundWorkStateForTest();
  }
});

test("a failed probe on one replica holds a destroy on the other", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const replicaB = await import("../src/sandbox/keepalive.js?replica=b") as Replica;
  const k = sharedKv(entry(Date.now()));
  try {
    await sweep(replicaA, k.kv);
    t.mock.timers.tick(SWEEP_MS);
    await sweep(replicaA, k.kv);

    t.mock.timers.tick(SWEEP_MS);
    roster = { kind: "eof" };
    await sweep(replicaB, k.kv);
    assert.equal(k.current()?.reclaimStreak, undefined, "the failure ends A's streak");

    roster = { kind: "ok", count: 0 };
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(SWEEP_MS);
      await sweep(i % 2 ? replicaB : replicaA, k.kv);
    }
    assert.ok(!destroyed(k), "inside the quiet window B's failure opened, A does not destroy");
  } finally {
    replicaB.resetBackgroundWorkStateForTest();
  }
});

test("a replaced reading still in flight when the handle is taken back does not close it", async (t) => {
  // The background probe re-reads the record before it writes its reading, but
  // used to check only that the sandbox and its status were the same. A turn
  // that took the handle back on another replica while the third probe was
  // reading the roster clears the idle markers and nothing else, so the third
  // reading completed the old period's streak, the probe wrote terminalReason
  // + closing, and the next sweep stopped a sandbox the turn was using.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // Background work held, so no reuse window is open and only the probe asks.
  const k = sharedKv(entry(Date.now(), { quiescedAt: undefined }));
  roster = { kind: "ok", count: 0, instance: "envd-2" };

  for (let i = 0; i < 2; i++) {
    await sweep(replicaA, k.kv);
    t.mock.timers.tick(SWEEP_MS);
  }
  assert.equal(k.current()?.reclaimStreak?.count, 2, "sanity: one reading short of a confirmation");
  const idlePeriod = k.current()!.idleSince;

  // The third probe is reading the roster...
  let release!: () => void;
  rosterGate = new Promise<void>((r) => { release = r; });
  await sweep(replicaA, k.kv);
  assert.equal(k.current()?.reclaimStreak?.count, 2, "sanity: the third reading is still in the air");

  // ...when a turn on another replica takes the handle back. A build that
  // predates the streak clears only the markers it knows about.
  const active = { ...k.current()! };
  delete active.keepalive;
  delete active.idleSince;
  delete active.quiescedAt;
  await k.kv.put(KEY, sc.encode(JSON.stringify(active)));

  rosterGate = null;
  release();
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));

  assert.equal(k.current()?.terminalReason, undefined,
    `a reading from the old idle period closed a handle in use; record=${JSON.stringify(k.current())}`);
  assert.equal(k.current()?.status, "ready");
  assert.ok(k.current()?.keepalive === undefined && k.current()?.idleSince === undefined,
    "the turn's reactivation stands");
  assert.notEqual(k.current()?.reclaimStreak?.count, 3, "the old streak was not completed");
  assert.ok(!destroyed(k));

  // The turn ends and the handle parks again. That is a new idle period: the
  // two readings from before the turn do not count toward it.
  t.mock.timers.tick(SWEEP_MS);
  await k.kv.put(KEY, sc.encode(JSON.stringify({
    ...k.current(), keepalive: false, idleSince: Date.now(),
  })));
  assert.notEqual(Date.now(), idlePeriod, "sanity: a different period");
  await sweep(replicaA, k.kv);
  assert.equal(k.current()?.reclaimStreak?.count, 1, "the new period counts from one");
  t.mock.timers.tick(SWEEP_MS);
  await sweep(replicaA, k.kv);
  assert.ok(!destroyed(k) && k.current()?.terminalReason === undefined,
    "two readings in the new period are still two");
  t.mock.timers.tick(SWEEP_MS);
  await sweep(replicaA, k.kv);
  t.mock.timers.tick(SWEEP_MS);
  await sweep(replicaA, k.kv);
  assert.ok(destroyed(k) || k.current()?.terminalReason === "sandbox_instance_replaced",
    "sanity: three in the new period still confirm it");
});

test("a turn that takes the handle back after the third reading is written still wins", async (t) => {
  // The window after the confirming reading is on the record: the probe then
  // checks the run lease and writes closing. That write used to re-read the
  // record and close whatever it found under the same sandbox identity, so a
  // reactivation landing in between was closed too.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = sharedKv(entry(Date.now(), { quiescedAt: undefined }));
  roster = { kind: "ok", count: 0, instance: "envd-2" };
  for (let i = 0; i < 2; i++) {
    await sweep(replicaA, k.kv);
    t.mock.timers.tick(SWEEP_MS);
  }
  assert.equal(k.current()?.reclaimStreak?.count, 2, "sanity: one reading short");

  // The lease read is the step between the confirming write and the close; a
  // turn on another replica takes the handle back while it is in the air.
  let reactivated = false;
  onLeaseRead = async () => {
    if (reactivated || k.current()?.reclaimStreak?.count !== 3) return;
    reactivated = true;
    const active = { ...k.current()! };
    delete active.keepalive;
    delete active.idleSince;
    delete active.quiescedAt;
    await k.kv.put(KEY, sc.encode(JSON.stringify(active)));
  };
  await sweep(replicaA, k.kv);

  assert.ok(reactivated, "sanity: the reactivation landed between the confirmation and the close");
  assert.equal(k.current()?.terminalReason, undefined,
    `closed a handle a turn had taken back; record=${JSON.stringify(k.current())}`);
  assert.equal(k.current()?.status, "ready");
  assert.ok(!destroyed(k));
});

test("a failure marker whose write lost a race still lands, and the next empty reading does not destroy", async (t) => {
  // The expiry probe takes the record's revision before it reads the roster
  // and wrote the failure marker under it once, swallowing the conflict. Any
  // write in between -- a TTL renewal, another replica -- lost the marker and
  // kept the streak it should have ended, so the next empty reading a sweep
  // later completed that streak and destroyed the sandbox inside the window.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const replicaB = await import("../src/sandbox/keepalive.js?replica=b") as Replica;
  const k = sharedKv(entry(Date.now()));
  try {
    await sweep(replicaA, k.kv);
    t.mock.timers.tick(SWEEP_MS);
    await sweep(replicaA, k.kv);
    assert.equal(k.current()?.reclaimStreak?.count, 2, "sanity: one reading short of a destroy");

    // The third probe reads EOF; while it is in the air, the record is renewed.
    t.mock.timers.tick(SWEEP_MS);
    roster = { kind: "eof" };
    let release!: () => void;
    rosterGate = new Promise<void>((r) => { release = r; });
    const reads = rosterReads;
    const inFlight = sweep(replicaA, k.kv);
    for (let i = 0; i < 200 && rosterReads === reads; i++) await new Promise((r) => setImmediate(r));
    assert.ok(rosterReads > reads, "sanity: the probe is reading the roster");
    await k.kv.put(KEY, sc.encode(JSON.stringify(k.current())));
    rosterGate = null;
    release();
    await inFlight;

    assert.equal(typeof k.current()?.lastProbeFailureAt, "number",
      `the failure marker was lost to the renewal; record=${JSON.stringify(k.current())}`);
    assert.equal(k.current()?.reclaimStreak, undefined, "and the streak it ends went with it");

    // The next empty reading, a sweep later and on the other replica -- which
    // has only the record to go on -- is inside the quiet window.
    t.mock.timers.tick(SWEEP_MS);
    roster = { kind: "ok", count: 0 };
    await sweep(replicaB, k.kv);
    assert.ok(!destroyed(k), `destroyed inside the quiet window; stops=${JSON.stringify(stops)}`);
  } finally {
    replicaB.resetBackgroundWorkStateForTest();
  }
});

test("a failure marker that cannot be written at all still holds the destroy on this replica", async (t) => {
  // The retry is bounded; past it the reading is held in process memory, so a
  // write that never lands cannot shorten the quiet window here.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = sharedKv(entry(Date.now()));
  await sweep(replicaA, k.kv);
  t.mock.timers.tick(SWEEP_MS);
  await sweep(replicaA, k.kv);
  assert.equal(k.current()?.reclaimStreak?.count, 2, "sanity: one reading short of a destroy");

  // Every write that would record the failure loses its CAS.
  let refused = 0;
  onRecordUpdate = (next) => {
    if (typeof next.lastProbeFailureAt === "number") {
      refused += 1;
      throw new Error("wrong last sequence");
    }
  };
  t.mock.timers.tick(SWEEP_MS);
  roster = { kind: "eof" };
  await sweep(replicaA, k.kv);
  assert.ok(refused > 0, "sanity: the failure was refused");
  assert.equal(k.current()?.lastProbeFailureAt, undefined, "sanity: nothing reached the record");
  assert.equal(k.current()?.reclaimStreak?.count, 2, "sanity: the stale streak is still on it");

  roster = { kind: "ok", count: 0 };
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(SWEEP_MS);
    await sweep(replicaA, k.kv);
    assert.ok(!destroyed(k),
      `sweep ${i + 1} after an unrecorded failure destroyed it; stops=${JSON.stringify(stops)}`);
  }

  // The hold is the quiet window, not a veto: once the record can be written
  // and the window has passed, a confirmed empty roster is reclaimed.
  onRecordUpdate = null;
  for (let i = 0; i < 4 && !destroyed(k); i++) {
    t.mock.timers.tick(SWEEP_MS);
    await sweep(replicaA, k.kv);
  }
  assert.ok(destroyed(k), "sanity: past the window the sandbox is reclaimed");
});

test("a positive count whose write lost a race still ends the streak", async (t) => {
  // Same shape as the failure marker: live work read by the expiry probe is
  // contrary evidence and must not be dropped with a lost CAS.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const replicaB = await import("../src/sandbox/keepalive.js?replica=b") as Replica;
  const k = sharedKv(entry(Date.now()));
  try {
    await sweep(replicaA, k.kv);
    t.mock.timers.tick(SWEEP_MS);
    await sweep(replicaA, k.kv);
    assert.equal(k.current()?.reclaimStreak?.count, 2, "sanity: one reading short of a destroy");

    t.mock.timers.tick(SWEEP_MS);
    roster = { kind: "ok", count: 250 };
    let release!: () => void;
    rosterGate = new Promise<void>((r) => { release = r; });
    const reads = rosterReads;
    const inFlight = sweep(replicaA, k.kv);
    for (let i = 0; i < 200 && rosterReads === reads; i++) await new Promise((r) => setImmediate(r));
    assert.ok(rosterReads > reads, "sanity: the probe is reading the roster");
    await k.kv.put(KEY, sc.encode(JSON.stringify(k.current())));
    rosterGate = null;
    release();
    await inFlight;

    assert.equal(typeof k.current()?.lastPositiveCountAt, "number",
      `the positive count was lost to the renewal; record=${JSON.stringify(k.current())}`);
    assert.equal(k.current()?.reclaimStreak, undefined, "and the streak it ends went with it");

    t.mock.timers.tick(SWEEP_MS);
    roster = { kind: "ok", count: 0 };
    await sweep(replicaB, k.kv);
    assert.ok(!destroyed(k), `destroyed right after live work was seen; stops=${JSON.stringify(stops)}`);
  } finally {
    replicaB.resetBackgroundWorkStateForTest();
  }
});

/** Run one sweep on replica A while the record is renewed under its probe. */
async function sweepWithRenewalUnderProbe(k: SharedKv): Promise<void> {
  let release!: () => void;
  rosterGate = new Promise<void>((r) => { release = r; });
  const reads = rosterReads;
  const inFlight = sweep(replicaA, k.kv);
  for (let i = 0; i < 200 && rosterReads === reads; i++) await new Promise((r) => setImmediate(r));
  assert.ok(rosterReads > reads, "sanity: the probe is reading the roster");
  await k.kv.put(KEY, sc.encode(JSON.stringify(k.current())));
  rosterGate = null;
  release();
  await inFlight;
}

test("live work read from a replaced instance whose write lost a race still holds the other replica", async (t) => {
  // The replaced branch of the expiry probe observed the reading and handed it
  // to the confirmation, which wrote it once under the pre-probe revision and
  // swallowed the conflict. A replaced answer with live processes is a positive
  // count: lost, it left the other replica a clear record to destroy from.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const replicaB = await import("../src/sandbox/keepalive.js?replica=b") as Replica;
  const k = sharedKv(entry(Date.now()));
  try {
    await sweep(replicaA, k.kv);
    t.mock.timers.tick(SWEEP_MS);
    await sweep(replicaA, k.kv);
    assert.equal(k.current()?.reclaimStreak?.count, 2, "sanity: one reading short of a destroy");

    t.mock.timers.tick(SWEEP_MS);
    const busyAt = Date.now();
    roster = { kind: "ok", count: 250, instance: "envd-2" };
    await sweepWithRenewalUnderProbe(k);
    assert.equal(k.current()?.lastPositiveCountAt, busyAt,
      `the replaced positive count was lost to the renewal; record=${JSON.stringify(k.current())}`);
    assert.equal(k.current()?.reclaimStreak, undefined, "and the streak it ends went with it");

    roster = { kind: "ok", count: 0 };
    for (let i = 0; i < 4; i++) {
      t.mock.timers.tick(SWEEP_MS);
      await sweep(replicaB, k.kv);
      assert.ok(!destroyed(k),
        `empty sweep ${i + 1} on the other replica destroyed it inside the window; stops=${JSON.stringify(stops)}`);
    }
  } finally {
    replicaB.resetBackgroundWorkStateForTest();
  }
});

test("an answer from the bound instance whose write lost a race still ends a replaced run", async (t) => {
  // An empty roster from the bound instance is contrary to a replacement run.
  // Written once and lost, the run stayed on the record and the next replaced
  // reading on the other replica completed it.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const replicaB = await import("../src/sandbox/keepalive.js?replica=b") as Replica;
  const k = sharedKv(entry(Date.now()));
  try {
    roster = { kind: "ok", count: 0, instance: "envd-2" };
    await sweep(replicaA, k.kv);
    t.mock.timers.tick(SWEEP_MS);
    await sweep(replicaA, k.kv);
    assert.equal(k.current()?.reclaimStreak?.reason, "instance_replaced", "sanity: a replaced run");
    assert.equal(k.current()?.reclaimStreak?.count, 2, "sanity: one reading short of a destroy");

    // The background verdict also carries the bound answer to the record; it
    // is kept from landing here, so what is under test is the expiry path's
    // own write and not the other writer covering for it.
    let verdictsRefused = 0;
    onRecordUpdate = (next) => {
      if (next.bgCheckedAt !== k.current()?.bgCheckedAt) {
        verdictsRefused += 1;
        throw new Error("wrong last sequence");
      }
    };
    t.mock.timers.tick(SWEEP_MS);
    roster = { kind: "ok", count: 0 };
    await sweepWithRenewalUnderProbe(k);
    onRecordUpdate = null;
    assert.notEqual(k.current()?.reclaimStreak?.reason, "instance_replaced",
      `the bound answer was lost to the renewal; record=${JSON.stringify(k.current())}`);

    t.mock.timers.tick(SWEEP_MS);
    roster = { kind: "ok", count: 0, instance: "envd-2" };
    await sweep(replicaB, k.kv);
    assert.ok(!destroyed(k), `a replaced run the bound instance ended was completed; stops=${JSON.stringify(stops)}`);
    assert.ok(verdictsRefused > 0, "sanity: the background verdict did not carry it");
  } finally {
    replicaB.resetBackgroundWorkStateForTest();
  }
});
