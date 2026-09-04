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
  registerSandbox, markHandsIdle, backgroundWorkStateSizesForTest,
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

/** `n` live (pinged) handles. */
function manyPingableHandles(n: number): KV {
  const entries = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < n; i++) {
    entries.set(`hands.live-${i}`, { ...ENTRY, keepalive: true, workloadId: `wl-live-${i}` });
  }
  return {
    async keys(filter = ">") {
      const keys = [...entries.keys()].filter((k) => filterToRegExp(filter).test(k));
      return (async function* () { yield* keys; })();
    },
    async get(key: string) {
      const v = entries.get(key);
      if (!v) return null;
      return { key, value: sc.encode(JSON.stringify(v)), revision: 1 };
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

test("a probe still in the air when a task takes the sandbox back is discarded", async () => {
  // The race the identity key does not cover: reuse hands the next task the
  // *same* pod, so a probe that started before it lands on the very key the
  // next sweep reads. Dropping the cached answer at registerSandbox does not
  // help -- the promise writes when it lands, not when it started. Without a
  // generation the stale `idle` sits there for the cache TTL, and a turn that
  // left a background shell behind reads as one that left nothing.
  const { kv } = fakeKv({ idleSince: Date.now() });
  stubPingableProvider();
  let release: (() => void) | null = null;
  const inFlight = new Promise<void>((r) => { release = r; });

  const deps = {
    kv,
    countActiveShells: async () => {
      await inFlight;          // still probing while the task starts
      return 0;                // the answer it would have written: "idle"
    },
  };

  await runKeepaliveTickForTest(deps);        // starts the probe
  registerSandbox(SESSION, { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" });
  release!();                                  // now it lands
  await new Promise((r) => setImmediate(r));

  // A fresh probe must be started rather than the stale answer being reused.
  let asked = false;
  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => { asked = true; return 1; },
  });
  await new Promise((r) => setImmediate(r));

  assert.ok(asked, "the sweep answered from a probe that predates the task");
});

test("a target's record is renewed before it waits its turn to be pinged", async () => {
  // Pings are bounded and take turns, and one can take its whole command
  // timeout plus transport slack. On a large enough fleet the tail waits longer
  // than the bucket's TTL, so a handle would expire before its ping arrived --
  // and the sweep guard means no other sweep is coming to renew it.
  const { kv, revision } = fakeKv({ keepalive: true });
  const before = revision();
  let revisionAtPing: number | null = null;
  const provider = {
    kind: "safe-workload",
    async exec() {
      revisionAtPing = revision();
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async get() { return { running: true, healthy: true }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });

  await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });

  assert.notEqual(revisionAtPing, null, "nothing was pinged, so the ordering was never exercised");
  assert.ok(
    (revisionAtPing as unknown as number) > before,
    "the record still had its old TTL while the ping was queued behind others",
  );
});

test("probe slots rotate, so a slow head of the list does not starve the tail", async () => {
  // The cap alone is not fair. Handing the slots to whichever candidates the KV
  // walk yields first means a handful that always time out keep the quota to
  // themselves, and everything behind them waits however many sweeps it takes
  // for those to be given up on -- which is five, by which point the tail has
  // been unpinged for as long again.
  const kv = manyIdleHandles(20);
  stubPingableProvider();
  const asked = new Set<string>();

  const deps = {
    kv,
    countActiveShells: async (_u: string, _t: string, owner: string) => {
      asked.add(owner);
      throw new Error("this one never answers");
    },
  };

  await runKeepaliveTickForTest(deps);
  await new Promise((r) => setImmediate(r));
  const afterFirst = asked.size;

  await runKeepaliveTickForTest(deps);
  await new Promise((r) => setImmediate(r));

  assert.ok(afterFirst <= 8, `${afterFirst} probes went out in one sweep`);
  assert.ok(
    asked.size > afterFirst,
    `the second sweep asked the same ${afterFirst} again instead of moving on`,
  );
});

// ── Boundaries a probe answer must not cross ────────────────────────────────
//
// The three below are the second-order faults of the tri-state probe: it makes
// an answer that outlives the question cheaper to produce, so every edge where
// the question changes has to invalidate.

test("a task ending re-opens the question the probe answered mid-task", async () => {
  // The gap markHandsIdle closes. A probe that lands while a task holds the
  // sandbox is about a moment before the task's own background shell exists,
  // so putting the handle back in the idle pool has to discard it. Otherwise
  // the shell that outlives the turn -- the entire case this file is about --
  // is invisible for the length of the cache TTL.
  stubPingableProvider();
  const { kv } = fakeKv();
  let running = 0;
  const deps = { kv, countActiveShells: async () => running };

  // The turn: registered, probed, nothing running yet.
  registerSandbox(SESSION, { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" });
  await sweepUntilProbed(deps);

  // The turn leaves a shell behind and the handle goes idle.
  running = 1;
  unregisterSandbox(SESSION);
  markHandsIdle(kv, SESSION, { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" });
  await new Promise((r) => setImmediate(r));

  const pings: string[] = [];
  await sweepUntilProbed({ ...deps, countActiveShells: async () => { pings.push("asked"); return running; } });
  assert.ok(pings.length > 0, "the question must be re-asked, not answered from before the task");
});

test("a probe in the air when a task takes the sandbox cannot report it idle", async () => {
  // registerSandbox bumps the generation, which covers a probe dispatched
  // before it. This covers the other order: the probe lands after, finds no
  // shells because the task has not started one yet, and would file `idle`
  // about a sandbox that is demonstrably in use.
  stubPingableProvider();
  const { kv } = fakeKv();
  let release: (n: number) => void = () => {};
  const deps = {
    kv,
    countActiveShells: () => new Promise<number>((r) => { release = r; }),
  };

  await runKeepaliveTickForTest(deps);          // probe dispatched, unresolved
  registerSandbox(SESSION, { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" });
  release(0);                                   // "no shells" -- but a task holds it
  await new Promise((r) => setImmediate(r));

  let asked = 0;
  await sweepUntilProbed({ ...deps, countActiveShells: async () => { asked += 1; return 0; } });
  assert.ok(asked > 0, "a verdict formed while the sandbox was held must not be cached");
});

test("a task taking the sandbox while the lease query is in flight discards the verdict", async () => {
  // The generation is checked when the probe lands, and then the landing itself
  // suspends: `held` consults the run lease, which is a KV read. Everything
  // after that await was decided before it, so a task taking the pod during the
  // query would be filed as `idle` -- about the previous occupant, believed for
  // the whole cache TTL, and the pod reclaimed out from under a live shell.
  //
  // The two tests above bump the generation before the probe promise settles,
  // which the pre-await check already caught. This one lets the probe settle,
  // clear that check, and then moves the generation while the lease read is
  // still outstanding. Only a re-check immediately before the write sees it.
  stubPingableProvider();
  const base = fakeKv();

  let releaseLease: (() => void) | null = null;
  const leaseInFlight = new Promise<void>((r) => { releaseLease = r; });
  let leaseAsked = false;

  const kv = {
    ...base.kv,
    async keys(filter = ">") { return base.kv.keys(filter); },
    async get(key: string) {
      if (key.startsWith("lock.")) {
        leaseAsked = true;
        await leaseInFlight;   // the task takes the sandbox while we are here
        return null;           // no lease -- so `held` is false and `idle` would be written
      }
      return base.kv.get(key);
    },
  } as unknown as KV;

  // Zero shells: the verdict that suppresses pinging, and the only one that is
  // dangerous to record late.
  await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });
  await new Promise((r) => setImmediate(r));
  assert.ok(leaseAsked, "sanity: the landing must actually reach the lease query");
  assert.equal(
    backgroundWorkStateSizesForTest().cache, 0,
    "sanity: nothing may be cached while the lease read is still outstanding",
  );

  // The pod is handed to a new task with the answer still mid-flight.
  registerSandbox(SESSION, { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" });
  releaseLease!();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(
    backgroundWorkStateSizesForTest().cache, 0,
    "an answer that lost its generation during the lease query must not be filed",
  );

  // And the next sweep asks again rather than reading the discarded verdict.
  let asked = false;
  await runKeepaliveTickForTest({
    kv: base.kv,
    countActiveShells: async () => { asked = true; return 1; },
  });
  await new Promise((r) => setImmediate(r));
  assert.ok(asked, "the discarded answer must not stand in for a fresh probe");
});


test("generation bookkeeping does not grow without bound", async () => {
  // bgGeneration has to outlive the cache it guards -- that is what discards a
  // late answer -- but not outlive the sandbox. Nothing in production deleted
  // from it, so a long-lived Brain kept an integer per sandbox it had ever
  // seen.
  stubPingableProvider();
  const deps = { kv: manyIdleHandles(40), countActiveShells: async () => 0 };
  await sweepUntilProbed(deps);
  // Sanity via the cache, not the generations: nothing writes a generation for
  // an identity that is behaving. The entry appears when the identity is
  // invalidated -- which for a vanishing session is the cleanup below, and is
  // exactly why the leak was one integer per sandbox ever seen rather than
  // per sandbox currently alive.
  assert.ok(
    backgroundWorkStateSizesForTest().cache > 0,
    "sanity: the sweep must have cached some answers",
  );

  // The whole fleet goes away.
  const empty = {
    kv: manyIdleHandles(0), countActiveShells: async () => 0,
  };
  await runKeepaliveTickForTest(empty);
  await new Promise((r) => setImmediate(r));
  await runKeepaliveTickForTest(empty);
  // Every map the helper exposes, not just the generations: "nothing is left
  // behind" is the claim, and each of these is a separate per-identity entry
  // that would grow with every sandbox the Brain ever saw if its own reap were
  // dropped. Asserting one of four would let the other three leak silently.
  assert.deepEqual(
    backgroundWorkStateSizesForTest(),
    { cache: 0, streaks: 0, generations: 0, inFlight: 0 },
    "identities nothing is asking about and nothing is probing must be collected, "
      + "in every map that holds them",
  );
});

test("a sweep too large to finish defers the tail instead of letting it expire", async () => {
  // Renewing a record when it is queued gives it a full TTL from that moment,
  // which is not a guarantee its ping arrives inside one: pings run bounded and
  // in turn, so a large enough fleet makes the queue longer than the TTL and
  // the tail expires still waiting. The sweep guard means no other sweep is
  // coming to renew it.
  //
  // Slow pings, so the budget is what ends the phase.
  // Recorded in the provider, not the KV: the scan reads every key before the
  // ping phase begins, so counting KV gets would count the scan.
  const asked = new Set<string>();
  const slow = {
    kind: "safe-workload",
    async exec(h: { id: string }) {
      asked.add(h.id);
      await new Promise((r) => setTimeout(r, 25));
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async get(h: { id: string }) {
      asked.add(h.id);
      await new Promise((r) => setTimeout(r, 25));
      return { running: true, healthy: true };
    },
    async stop() {},
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: slow, agentSandbox: slow });

  const kv = manyPingableHandles(200);
  // The real budget is half the record TTL -- minutes -- so it is shortened
  // here rather than slept through. The property under test is the deferral,
  // not the number.
  const BUDGET = 120;
  const deps = { kv, countActiveShells: async () => 1, pingBudgetMs: BUDGET };

  const started = Date.now();
  await runKeepaliveTickForTest(deps);
  const elapsed = Date.now() - started;

  // Generous on purpose: the budget gates when a ping may *start*, so the
  // PING_MAX_IN_FLIGHT pings already running continue past it. The bound being
  // asserted is "budget plus about one ping", not the budget itself -- what
  // must not happen is the phase running for the length of the whole queue.
  assert.ok(elapsed < BUDGET * 6, `the phase must be bounded, took ${elapsed}ms`);
  assert.ok(asked.size > 0, "sanity: it must have pinged something");
  assert.ok(asked.size < 200, `the budget must have cut the phase short, reached ${asked.size}`);

  // And the deferred tail leads the next sweep rather than being starved.
  const firstRound = new Set(asked);
  asked.clear();
  await runKeepaliveTickForTest(deps);
  const fresh = [...asked].filter((k) => !firstRound.has(k));
  assert.ok(
    fresh.length > 0,
    "the second sweep must reach targets the first one deferred, not repeat its prefix",
  );
});

test("a verdict formed while a task held the sandbox is not cached", async () => {
  // Isolates the held check from the two generation bumps around it. The task
  // leaves without markHandsIdle -- a DAG sibling, a torn-down session, any
  // path that unregisters and does not hand the handle back -- so nothing on
  // the way out invalidates, and registerSandbox's bump on the way in happened
  // before the candidate was even formed. If an `idle` answer computed while
  // the pod was in use can be cached, this is where it survives.
  stubPingableProvider();
  const { kv } = fakeKv();
  let release: (n: number) => void = () => {};
  let asked = 0;
  const deps = {
    kv,
    countActiveShells: () => {
      asked += 1;
      return new Promise<number>((r) => { release = r; });
    },
  };

  // Registered first, so the candidate the scan forms already carries the
  // current generation and the probe is dispatched about a held sandbox.
  registerSandbox(SESSION, { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" });
  await runKeepaliveTickForTest(deps);
  release(0);
  await new Promise((r) => setImmediate(r));

  unregisterSandbox(SESSION);
  asked = 0;
  await runKeepaliveTickForTest(deps);
  assert.ok(asked > 0, "an idle verdict about a held sandbox must not be believed later");
});

test("handing a handle back to the idle pool re-opens the question", async () => {
  // Isolates markHandsIdle's invalidation. A verdict cached from a clean idle
  // probe is believed for the whole TTL -- correctly, while nothing happens.
  // A task running in between changes the answer, and the handle re-entering
  // the pool is the last moment anything can say so.
  stubPingableProvider();
  // Inside the reuse window: the shared ENTRY is deliberately long expired, and
  // an expired idle handle is deleted by the sweep -- which would remove the
  // thing this test hands back.
  const { kv } = fakeKv({ idleSince: Date.now() });
  let asked = 0;
  const deps = { kv, countActiveShells: async () => { asked += 1; return 0; } };

  await sweepUntilProbed(deps);           // clean idle verdict, now cached
  asked = 0;
  await runKeepaliveTickForTest(deps);
  assert.equal(asked, 0, "sanity: a fresh verdict is believed, not re-asked every sweep");

  markHandsIdle(kv, SESSION, { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" });
  await new Promise((r) => setImmediate(r));
  await runKeepaliveTickForTest(deps);
  assert.ok(asked > 0, "the handle going back into the pool must discard the old answer");
});
