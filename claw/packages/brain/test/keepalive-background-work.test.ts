// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A turn that ended is not a sandbox that is free.
//
// `stopKeepaliveAfterTask` marks the handle idle on every terminal task, and an
// idle handle is never pinged, so the control-plane GC reclaims the pod about
// fifteen minutes later. Claw's own rule for background shells says the
// opposite -- a `run_in_background` shell is expected to still be running when
// the user asks about it next turn, "which is the reason background shells
// exist at all" -- and reclaiming the pod kills it regardless of that promise.
//
// The sweep now reads the fact instead of assuming it. These pin the three
// answers that matter: work running keeps the handle, no work keeps today's
// behaviour exactly, and a probe that cannot answer is not read as "no work has
// ever been more true" but as the status quo.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import {
  runKeepaliveTickForTest, unregisterSandbox, resetBackgroundWorkStateForTest,
  registerSandbox,
} from "../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-bg";
const ENTRY = {
  status: "ready",
  provider: "safe-workload",
  workloadId: "wl-1",
  platformKey: "pk",
  namespace: "ns",
  handsUrl: "http://sandbox:9100/mcp",
  token: "tok",
  keepalive: false,
  // Long past the reuse window, so the sweep wants to expire it.
  idleSince: 0,
};

let restoreProviders: (() => void) | null = null;

afterEach(() => {
  resetBackgroundWorkStateForTest();
  unregisterSandbox(SESSION);
  restoreProviders?.();
  restoreProviders = null;
});

/** A provider whose ping succeeds, so a kept handle is not then evicted by the
 *  fail limit from a branch these tests are not about. */
function stubPingableProvider(): void {
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, healthy: true }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
}

/**
 * A KV that remembers what was written to it.
 *
 * Worth the extra few lines: the sweep writes the entry in one place and re-reads
 * it in another within the same tick, so a stub whose `get` always answers the
 * seed value hides whichever write came first -- including the one these tests
 * are about.
 */
function fakeKv(overrides: Record<string, unknown> = {}): {
  kv: KV; deleted: string[];
  current: () => Record<string, unknown>; revision: () => number;
} {
  const deleted: string[] = [];
  let value = sc.encode(JSON.stringify({ ...ENTRY, ...overrides }));
  let revision = 5;
  const kv = {
    async keys(filter = ">") {
      const key = `hands.${SESSION}`;
      const matched = filterToRegExp(filter).test(key) && !deleted.includes(key) ? [key] : [];
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      if (key !== `hands.${SESSION}` || deleted.includes(key)) return null;
      return { key, value, revision };
    },
    async delete(key: string) { deleted.push(key); },
    async put() { return ++revision; },
    async update(_k: string, v: unknown, rev: number) {
      if (rev !== revision) throw new Error("revision conflict");
      value = v as Uint8Array;
      return ++revision;
    },
  } as unknown as KV;
  return {
    kv, deleted,
    current: () => JSON.parse(sc.decode(value)) as Record<string, unknown>,
    revision: () => revision,
  };
}


/**
 * Run a sweep, let the background probe land, then run another.
 *
 * The probe deliberately does not block the sweep, so the first one decides on
 * `unknown` and the answer is there for the second. Tests that care about the
 * answer have to let it arrive.
 */
async function sweepUntilProbed(deps: Parameters<typeof runKeepaliveTickForTest>[0]): Promise<void> {
  await runKeepaliveTickForTest(deps);
  await new Promise((r) => setImmediate(r));
  await runKeepaliveTickForTest(deps);
}

/** A KV holding `n` distinct idle handles, all uncached. */
function manyIdleHandles(n: number): KV {
  const entries = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < n; i++) {
    entries.set(`hands.sess-${i}`, { ...ENTRY, workloadId: `wl-${i}` });
  }
  return {
    async keys(filter = ">") {
      const keys = [...entries.keys()].filter((k) => filterToRegExp(filter).test(k));
      return (async function* () { yield* keys; })();
    },
    async get(key: string) {
      const v = entries.get(key);
      return v ? { key, value: sc.encode(JSON.stringify(v)), revision: 1 } : null;
    },
    async delete() {}, async put() { return 1; },
    async update(_k: string, _v: unknown, rev: number) { return rev + 1; },
  } as unknown as KV;
}

test("an idle handle is kept while the session still has a background shell running", async () => {
  const { kv, deleted } = fakeKv();
  stubPingableProvider();

  await sweepUntilProbed({ kv, countActiveShells: async () => 1 });

  assert.ok(
    !deleted.includes(`hands.${SESSION}`),
    "expiring here reclaims the pod out from under a shell the run was promised "
      + `would still be there; deleted ${JSON.stringify(deleted)}`,
  );
});

test("the probe is asked for the session, which is the owner Hands files shells under", async () => {
  const { kv } = fakeKv();
  stubPingableProvider();
  const asked: Array<[string, string, string]> = [];

  await sweepUntilProbed({
    kv,
    countActiveShells: async (url, token, owner) => { asked.push([url, token, owner]); return 1; },
  });

  assert.deepEqual(
    asked[0],
    [ENTRY.handsUrl, ENTRY.token, SESSION],
    "asking under runScope instead would match no owner at all -- it is the run "
      + "lease key, a workspace id under RUN_GATE_KEY=workspace",
  );
});

test("no background work leaves the existing expiry untouched", async () => {
  const { kv, deleted } = fakeKv();

  await sweepUntilProbed({ kv, countActiveShells: async () => 0 });

  assert.ok(
    deleted.includes(`hands.${SESSION}`),
    "a sandbox nobody is using still has to be reclaimed; this check must not "
      + "turn every finished turn into a held pod",
  );
});

test("a probe that cannot answer holds the handle instead of expiring it", async () => {
  const { kv, deleted } = fakeKv();
  stubPingableProvider();

  await sweepUntilProbed({
    kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  });

  assert.ok(
    !deleted.includes(`hands.${SESSION}`),
    "folding \"could not ask\" into \"no work\" is what makes this feature "
      + "unreliable: over a job long enough to need it, at one probe a minute, "
      + "a single timeout is close to certain and would delete the handle",
  );
});

test("a probe that never answers eventually stops holding the handle", async () => {
  const { kv, deleted } = fakeKv();
  stubPingableProvider();

  // Unknown is for a blip, not forever: a sandbox that has stopped answering
  // entirely would otherwise be pinned until its absolute deadline.
  for (let i = 0; i < 16; i++) {
    await runKeepaliveTickForTest({
      kv,
      countActiveShells: async () => { throw new Error("hands unreachable"); },
    });
    await new Promise((r) => setImmediate(r));
    if (deleted.includes(`hands.${SESSION}`)) break;
  }

  assert.ok(
    deleted.includes(`hands.${SESSION}`),
    "a permanently unreachable Hands must not hold a handle open indefinitely",
  );
});

test("work that outlasts the reuse window still leaves a window behind it", async () => {
  // The bug this pins: idleSince is stamped when the task ends, so a job that
  // runs longer than the window means the handle is already expired the moment
  // the job finishes -- deleted by the very next sweep, before the session can
  // reuse the pod or read what the job wrote.
  const { kv, current } = fakeKv();
  stubPingableProvider();

  await sweepUntilProbed({ kv, countActiveShells: async () => 1 });

  const idleSince = current().idleSince;
  assert.equal(typeof idleSince, "number", "the idle clock was never moved while work ran");
  assert.ok(
    Date.now() - (idleSince as number) < 60_000,
    `the stamp has to track the work, not the turn that started it; got ${idleSince}`,
  );
});

test("the probe is not repeated on every tick", async () => {
  // The sweep walks KV serially and this is a network call, so one probe per
  // handle per tick is what pushes a tick past its own interval once a few
  // handles stop answering quickly.
  const { kv } = fakeKv();
  stubPingableProvider();
  let probes = 0;
  const deps = { kv, countActiveShells: async () => { probes += 1; return 1; } };

  await sweepUntilProbed(deps);
  await runKeepaliveTickForTest(deps);

  assert.equal(probes, 1, `three sweeps asked Hands ${probes} times`);
});

test("an unanswered probe also keeps the record from expiring underneath it", async () => {
  // Holding the handle in memory is not holding it: the bucket drops entries on
  // its own after BRAIN_REGISTRY_TTL_MS, which is the same five minutes as the
  // unknown tolerance. Without a write here the handle would be kept by this
  // code and expired by the store at the same moment, and the tolerance would
  // buy nothing at all.
  const { kv, revision } = fakeKv();
  stubPingableProvider();
  const before = revision();

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  });

  assert.ok(
    revision() > before,
    "the entry was never re-put, so its TTL is still counting down from the "
      + "moment the task ended",
  );
});

// --- cold start, and answers that outlive what they were about ---

test("a cold start does not open one socket per handle at once", async () => {
  // Per-session de-duplication is not a bound. On a restart every idle handle
  // is uncached in the same tick, and a replica with a few hundred of them --
  // times the replica count, into one control plane -- is the burst this cap
  // exists for. Skipped, not queued: the handle stays `unknown`, which keeps
  // it, and the next tick continues down the list.
  const kv = manyIdleHandles(50);
  stubPingableProvider();
  let peak = 0;
  let live = 0;

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setImmediate(r));
      live -= 1;
      return 0;
    },
  });
  await new Promise((r) => setImmediate(r));

  assert.ok(peak > 0, "nothing was probed at all");
  assert.ok(peak <= 8, `${peak} probes were in flight at once`);
});

test("a task taking the sandbox back throws away the last verdict", async () => {
  // Reuse hands the next task the same pod, so identity alone would carry an
  // `idle` answer across the boundary -- and a turn that leaves a background
  // shell behind would be read as one that left nothing, for as long as the
  // cache holds.
  // Inside the reuse window, so the sweep keeps the handle instead of expiring
  // it -- this is about the answer, not about the expiry.
  const { kv } = fakeKv({ idleSince: Date.now() });
  stubPingableProvider();
  let probes = 0;
  const deps = { kv, countActiveShells: async () => { probes += 1; return 0; } };

  await sweepUntilProbed(deps);
  const afterFirst = probes;

  registerSandbox(SESSION, { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" });
  await runKeepaliveTickForTest(deps);
  await new Promise((r) => setImmediate(r));

  assert.ok(
    probes > afterFirst,
    "the sweep answered from a verdict formed before the task ran",
  );
});

test("an answer about a replaced sandbox does not land on its successor", async () => {
  // The cache is keyed by sandbox identity, so an answer formed about one pod
  // cannot be read as an answer about the pod that replaced it -- and a probe
  // still in flight when the swap happens writes under the key it started with,
  // which nothing reads any more, instead of overwriting the new pod's state.
  let workloadId = "wl-1";
  const kv = {
    async keys(filter = ">") {
      const key = `hands.${SESSION}`;
      const matched = filterToRegExp(filter).test(key) ? [key] : [];
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      if (key !== `hands.${SESSION}`) return null;
      const v = { ...ENTRY, workloadId, idleSince: Date.now() };
      return { key, value: sc.encode(JSON.stringify(v)), revision: 1 };
    },
    async delete() {}, async put() { return 1; },
    async update(_k: string, _v: unknown, rev: number) { return rev + 1; },
  } as unknown as KV;
  stubPingableProvider();
  const asked: string[] = [];
  const deps = {
    kv,
    countActiveShells: async () => { asked.push(workloadId); return 0; },
  };

  await sweepUntilProbed(deps);
  workloadId = "wl-2";                       // reuse failed; a new pod took over
  await runKeepaliveTickForTest(deps);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(
    asked,
    ["wl-1", "wl-2"],
    "the replacement was answered from the pod it replaced",
  );
});

test("the ping fan-out is bounded too, not just the probes", async () => {
  // The two share a connection pool, so bounding one and not the other moves
  // the burst rather than removing it: an uncached handle answers `unknown`,
  // and `unknown` is pinged, so the same cold start that would flood the probes
  // floods the pings behind them.
  const kv = manyIdleHandles(50);
  let peak = 0;
  let live = 0;
  const provider = {
    kind: "safe-workload",
    async exec() {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setImmediate(r));
      live -= 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async get() { return { running: true, healthy: true }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });

  // Every handle is uncached, so every one answers `unknown` and is pinged.
  await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });

  assert.ok(peak > 0, "nothing was pinged at all");
  assert.ok(peak <= 16, `${peak} pings were in flight at once`);
});
