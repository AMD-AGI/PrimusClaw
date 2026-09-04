// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A verdict has to outlive the sweep that took it.
//
// The background-work answer was kept only in the deciding process's memory,
// and reaped at the end of any sweep that did not see the identity. On a
// multi-replica Brain a sweep walks a rotating slice of the handles -- one per
// tick on the cluster where this was found -- so "not seen this tick" is the
// ordinary state of a live sandbox, and every answer was discarded about a
// minute after it was written, tens of minutes before the sweep that would have
// read it.
//
// `unknown` was then the permanent answer. `unknown` is the branch that keeps
// the handle, so idle sandboxes were pinged until the CR's 24h absolute
// deadline and the control plane never reclaimed one: zero idle reclaims fleet
// -wide in the four hours after the probe shipped.
//
// These pin the two halves of the repair: the answer is written where another
// process can read it, and absence from a sweep is no longer what discards it.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import {
  runKeepaliveTickForTest, unregisterSandbox, resetBackgroundWorkStateForTest,
  backgroundWorkStateSizesForTest, ageBackgroundWorkCacheForTest, markHandsIdle,
} from "../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-verdict";
const KEY = `hands.${SESSION}`;
const ENTRY = {
  status: "ready",
  provider: "safe-workload",
  workloadId: "wl-v",
  platformKey: "pk",
  namespace: "ns",
  handsUrl: "http://sandbox:9100/mcp",
  token: "tok",
  keepalive: false,
  // Long past the reuse window, so an `idle` answer is acted on immediately and
  // the test is about the answer rather than about the window.
  idleSince: 0,
};

let restoreProviders: (() => void) | null = null;

afterEach(() => {
  resetBackgroundWorkStateForTest();
  unregisterSandbox(SESSION);
  restoreProviders?.();
  restoreProviders = null;
});

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
 * A KV whose walk can be made to skip the handle without deleting it.
 *
 * That is the whole shape of the bug: the entry is present and its sandbox is
 * alive, but this tick's walk went elsewhere. A stub that could only delete
 * could not express it -- deletion is the case the old reap was written for and
 * the case it handled correctly.
 */
function fakeKv(): {
  kv: KV; deleted: string[];
  current: () => Record<string, unknown>;
  setVisible: (v: boolean) => void;
  substitute: (patch: Record<string, unknown>) => void;
} {
  const deleted: string[] = [];
  let value = sc.encode(JSON.stringify(ENTRY));
  let revision = 5;
  let visible = true;
  const kv = {
    async keys(filter = ">") {
      const matched = visible && filterToRegExp(filter).test(KEY) && !deleted.includes(KEY)
        ? [KEY] : [];
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      if (key !== KEY || deleted.includes(key)) return null;
      return { key, value, revision };
    },
    async delete(key: string) { deleted.push(key); },
    async put() { return ++revision; },
    async update(_k: string, v: unknown, rev: number) {
      if (rev !== revision) throw new Error("revision conflict");
      value = v as Uint8Array; return ++revision;
    },
  } as unknown as KV;
  return {
    kv, deleted,
    current: () => JSON.parse(sc.decode(value)) as Record<string, unknown>,
    setVisible: (v: boolean) => { visible = v; },
    // Another replica put a different sandbox behind the same key, the way a
    // failed reuse does: same session, same key, new pod, new revision.
    substitute: (patch: Record<string, unknown>) => {
      value = sc.encode(JSON.stringify({ ...ENTRY, ...patch }));
      revision += 1;
    },
  };
}

async function sweep(deps: Parameters<typeof runKeepaliveTickForTest>[0]): Promise<void> {
  await runKeepaliveTickForTest(deps);
  await new Promise((r) => setImmediate(r));
}

test("a sweep that does not see the handle does not discard its verdict", async () => {
  const k = fakeKv();
  stubPingableProvider();
  const deps = { kv: k.kv, countActiveShells: async () => 1 };

  await sweep(deps);
  assert.ok(
    backgroundWorkStateSizesForTest().cache > 0,
    "sanity: the probe has to have answered before absence can discard anything",
  );

  // The walk rotates away. The sandbox is untouched -- still in the bucket,
  // still running work -- and the sweep simply asks about other handles.
  k.setVisible(false);
  await sweep(deps);
  await sweep(deps);

  assert.ok(
    backgroundWorkStateSizesForTest().cache > 0,
    "the handle was not seen, which on a multi-replica Brain is most ticks for "
      + "most handles; discarding the answer on that basis is what made `unknown` "
      + "permanent and pinned every idle sandbox to its 24h deadline",
  );
});

test("the verdict is on the handle, so another replica can read it", async () => {
  const k = fakeKv();
  stubPingableProvider();

  // One replica probes and finds nothing running.
  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  assert.equal(
    k.current().bgRunning, 0,
    "the measured answer belongs on the handle, not only in the process that took it",
  );
  assert.equal(
    typeof k.current().bgCheckedAt, "number",
    "and stamped, because it is believed for a bounded time rather than forever",
  );

  // A different replica: same bucket, no memory of any of this, and a probe that
  // would fail if it were reached at all. The decision has to come off the
  // handle.
  resetBackgroundWorkStateForTest();
  const other = {
    kv: k.kv,
    countActiveShells: async () => { throw new Error("this replica cannot reach Hands"); },
  };
  await sweep(other);

  assert.ok(
    k.deleted.includes(KEY),
    "with the answer already on the handle the sweep can give the sandbox back on "
      + "sight; needing its own probe first is what no replica ever got to finish",
  );
});

test("a handle carrying running work is kept by a replica that never probed it", async () => {
  const k = fakeKv();
  stubPingableProvider();

  await sweep({ kv: k.kv, countActiveShells: async () => 2 });
  assert.equal(k.current().bgRunning, 2, "sanity: the running answer was recorded");

  // The other direction of the same read: a fresh replica must not reclaim a pod
  // that is busy just because it personally has not asked yet.
  resetBackgroundWorkStateForTest();
  await sweep({
    kv: k.kv,
    countActiveShells: async () => { throw new Error("this replica cannot reach Hands"); },
  });

  assert.ok(
    !k.deleted.includes(KEY),
    "a background shell the user expects to still be running next turn was "
      + "recorded as running; no replica may reclaim the pod out from under it",
  );
});

// --- the give-up path, under the same rotation ---

test("a run of failed probes is not restarted by the sweeps that walk elsewhere", async () => {
  // `unknown` holds the handle, which is right for a blip and wrong forever, so
  // a run longer than the tolerance of five -- the sixth consecutive failure --
  // settles it to idle locally. A failed probe caches
  // nothing on purpose -- only a measured answer is worth reusing -- and the
  // streak used to be reaped whenever no cached answer accompanied it. Under the
  // rotation this module runs under that is most ticks, so the count restarted
  // at one every time, the tolerance was never reached, and a Hands that had
  // stopped answering held its handle to the CR's absolute deadline: the same
  // failure this file is about, one map over.
  const k = fakeKv();
  stubPingableProvider();
  const deps = {
    kv: k.kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  };

  for (let i = 0; i < 8 && !k.deleted.includes(KEY); i++) {
    await sweep(deps);
    // The walk rotates away, and comes back. Nothing about the sandbox changed.
    k.setVisible(false);
    await sweep(deps);
    k.setVisible(true);
  }

  assert.ok(
    k.deleted.includes(KEY),
    "the failures were consecutive; only the ticks that did not look at this "
      + "handle came between them, and those must not be what resets the count",
  );
});

test("a streak nothing adds to is still eventually forgotten", async () => {
  // The other half: reaping by age has to actually reap, or the map grows one
  // entry per sandbox this replica has ever failed to reach.
  const k = fakeKv();
  stubPingableProvider();
  const deps = {
    kv: k.kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  };

  await sweep(deps);
  assert.equal(
    backgroundWorkStateSizesForTest().streaks, 1,
    "sanity: the failure has to have been counted before anything can drop it",
  );

  k.setVisible(false);
  await sweep(deps);
  assert.equal(
    backgroundWorkStateSizesForTest().streaks, 1,
    "absence from one tick is the ordinary state of a live handle, not evidence",
  );

  ageBackgroundWorkCacheForTest(24 * 60 * 60_000);
  await sweep(deps);
  assert.equal(
    backgroundWorkStateSizesForTest().streaks, 0,
    "a run of failures nothing has added to for a day is not a run any more",
  );
});

// --- an answer belongs to a sandbox, not to a key ---

test("a verdict is not stamped onto whatever took the key while the probe was out", async () => {
  // `hands.<session>` is a key a sandbox is put behind, not the sandbox. A
  // failed reuse builds a new pod and writes it here, and the write that files
  // the old pod's answer re-reads the key well after the probe started. Its
  // revision check is taken against that fresh read, so it succeeds -- and the
  // new sandbox carries a shell count nobody ever measured in it, believed for
  // the whole verdict TTL: kept alive on a verdict about a pod that is gone, or
  // reclaimed early while it works.
  const k = fakeKv();
  stubPingableProvider();

  await sweep({
    kv: k.kv,
    countActiveShells: async () => {
      // Mid-probe: same session, same key, different sandbox.
      k.substitute({ workloadId: "wl-replacement" });
      return 1;
    },
  });

  const after = k.current();
  assert.equal(after.workloadId, "wl-replacement", "sanity: the substitution stood");
  assert.equal(
    after.bgRunning, undefined,
    "the count was taken inside the pod this handle no longer names; writing it "
      + "here is a measurement about one sandbox filed against another",
  );
  assert.equal(
    after.bgCheckedAt, undefined,
    "and stamping it fresh is what makes every reader believe it for the TTL",
  );
});

// The interval between two probes of the same identity is the interval the
// streak has to survive, and it is not the one the shared verdict is sized for.
// A verdict is read by whichever replica sweeps next; a streak is in-process, so
// only the replica that failed can add to it, and it waits out the rotation
// multiplied by the replica count. Measured at about thirty-six minutes here
// against a thirty-minute memory: every failure aged out before the same replica
// could fail again, the count never left one, and the give-up path existed
// without ever being able to fire.
const SAME_REPLICA_REVISIT_MS = 36 * 60_000;

test("a run of failures accumulates across the interval the same replica returns on", async () => {
  const k = fakeKv();
  stubPingableProvider();
  const deps = {
    kv: k.kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  };

  // Each pass is one visit by this replica; the clock moves by a whole revisit
  // interval before the next one, which is the gap the real cadence has.
  for (let i = 0; i < 12; i++) {
    await sweep(deps);
    // Stop the clock once the give-up has settled: the answer it caches is
    // believed for the short in-process TTL, and another revisit interval on top
    // of it would age out the very thing the next sweep has to read.
    if (backgroundWorkStateSizesForTest().cache > 0) break;
    ageBackgroundWorkCacheForTest(SAME_REPLICA_REVISIT_MS);
  }

  assert.ok(
    backgroundWorkStateSizesForTest().cache > 0,
    "six failures spaced by the interval this replica actually returns on are "
      + "still six consecutive failures; a memory shorter than that gap forgets "
      + "each one before the next arrives and the tolerance is never reached",
  );

  // And the give-up has to be readable by the sweep that follows it, which is
  // the point of settling to idle at all.
  await sweep(deps);
  assert.ok(
    k.deleted.includes(KEY),
    "a Hands that has stopped answering entirely must eventually give its pod "
      + "back rather than hold it to the CR's absolute deadline",
  );
});

test("a streak is not dropped by an unrelated verdict aging out", async () => {
  // The two are remembered on different clocks and for different reasons, and a
  // failed probe caches no verdict at all -- so a verdict crossing its own TTL
  // says nothing about a run of failures recorded minutes ago. Clearing both
  // from one place meant an answer about work that finished half an hour ago
  // erased the evidence that Hands has been unreachable since.
  const k = fakeKv();
  stubPingableProvider();

  // A measured answer first, so there is something with its own TTL to expire.
  await sweep({ kv: k.kv, countActiveShells: async () => 1 });
  assert.equal(
    backgroundWorkStateSizesForTest().cache, 1,
    "sanity: the verdict has to be cached before it can age out",
  );

  // Old enough to be re-probed, not old enough to be reaped.
  ageBackgroundWorkCacheForTest(25 * 60_000);

  const failing = {
    kv: k.kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  };
  for (let i = 0; i < 4; i++) await sweep(failing);
  assert.equal(
    backgroundWorkStateSizesForTest().streaks, 1,
    "sanity: four recent failures are on the books",
  );

  // The old verdict crosses its TTL. The failures are minutes old.
  ageBackgroundWorkCacheForTest(6 * 60_000);
  // Walked elsewhere, so nothing can quietly recreate what the reap removes.
  k.setVisible(false);
  await sweep(failing);

  assert.equal(
    backgroundWorkStateSizesForTest().cache, 0,
    "sanity: the verdict did age out, which is what the reap is being asked to do",
  );
  assert.equal(
    backgroundWorkStateSizesForTest().streaks, 1,
    "the run of failures is fresh and unrelated to the answer that expired; "
      + "reaping it here restarts the count and the give-up never arrives",
  );
});

// --- two answers, and which of them is the newer one ---

test("a newer answer on the handle outranks this replica's older one", async () => {
  // The in-process copy is usually the newer one, and the code took that for a
  // rule. It is not: another replica probes the same handle on its own
  // rotation, so a local answer from four minutes ago is still inside its TTL
  // while a `running` measured elsewhere two minutes ago sits unread on the
  // entry. Preferring the local one reclaims a pod that the more recent
  // measurement says is busy.
  const k = fakeKv();
  stubPingableProvider();

  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  assert.equal(
    backgroundWorkStateSizesForTest().cache, 1,
    "sanity: this replica has its own `idle` answer to prefer",
  );

  // Time passes, and another replica asks after we did and finds work running.
  // Same idle period on both sides -- an answer scoped to a different one, or to
  // none, is rejected before any of this, and the question here is which of two
  // usable answers is the newer.
  ageBackgroundWorkCacheForTest(2 * 60_000);
  k.substitute({ idleEpoch: 0, bgEpoch: 0, bgCheckedAt: Date.now(), bgRunning: 3 });

  await sweep({
    kv: k.kv,
    countActiveShells: async () => { throw new Error("this replica cannot reach Hands"); },
  });

  assert.ok(
    !k.deleted.includes(KEY),
    "the freshest measurement of the sandbox says three shells are running in "
      + "it; an older local answer is not a reason to take the pod away",
  );
});

// --- an answer belongs to an idle period, not just to a sandbox ---

test("a new idle period does not inherit the last one's verdict", async () => {
  // Identity does not change when the same pod is handed back to a task and
  // idled again -- same session, same workload, same key -- so the identity
  // guard cannot see this. The verdict is re-serialized onto the entry by the
  // very write that opens the next idle period, which republishes an answer
  // about the period before it to the whole fleet at the moment the sweep
  // starts acting on it.
  const k = fakeKv();
  stubPingableProvider();
  k.substitute({ idleEpoch: 1_000 });

  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  assert.equal(k.current().bgRunning, 0, "sanity: the idle answer was recorded");
  assert.equal(k.current().bgEpoch, 1_000, "and against the period it measured");

  // The next message arrives, the task runs, and it ends: markHandsIdle puts the
  // same handle back into the idle pool. Whatever that task started, nothing
  // measured before it ran knows about.
  markHandsIdle(k.kv, SESSION, "wl-v");
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(
    k.current().bgCheckedAt, undefined,
    "the answer was taken about the idle period before the task; carrying it "
      + "over suppresses pinging a pod whose new task may have left a shell running",
  );
  assert.equal(k.current().bgRunning, undefined, "and the count with it");
  assert.notEqual(
    k.current().idleEpoch, 1_000,
    "the new idle period has to be distinguishable from the old one at all",
  );
});

test("a replica does not trust a verdict from before the handle was reactivated", async () => {
  // The clearing above is one writer's cooperation. The read has to be able to
  // reject the answer on its own too: an entry written by a Brain from before
  // this existed, or a probe from the previous period that landed after the
  // reactivation, both leave a fresh-looking verdict scoped to a period that has
  // ended.
  const k = fakeKv();
  stubPingableProvider();
  k.substitute({
    idleSince: 0, idleEpoch: 2_000,
    bgCheckedAt: Date.now(), bgRunning: 0, bgEpoch: 1_000,
  });

  await sweep({
    kv: k.kv,
    countActiveShells: async () => { throw new Error("this replica cannot reach Hands"); },
  });

  assert.ok(
    !k.deleted.includes(KEY),
    "an `idle` measured before the task ran is not evidence about the sandbox "
      + "after it; the sweep has to ask again rather than reclaim on it",
  );
});

test("an answer is not filed against the idle period that started while it was out", async () => {
  // The mirror of the substitution guard, for the case where the sandbox is the
  // same one: the probe is in the air, the pod is handed to a task and idled
  // again, and the answer lands on an entry whose period it never looked at.
  const k = fakeKv();
  stubPingableProvider();
  k.substitute({ idleEpoch: 1_000 });

  await sweep({
    kv: k.kv,
    countActiveShells: async () => {
      // Reactivated and idled again while the probe was outstanding.
      k.substitute({ idleEpoch: 2_000 });
      return 0;
    },
  });

  assert.equal(k.current().idleEpoch, 2_000, "sanity: the new period stood");
  assert.equal(
    k.current().bgCheckedAt, undefined,
    "the shell count was taken during the previous idle period; stamping it "
      + "fresh here makes every replica believe it for the whole verdict TTL",
  );
});

test("an unstamped verdict is not read as one about the period the handle is in", async () => {
  // The epoch check let two absent fields match, and an entry that has not been
  // through the new markHandsIdle has exactly that shape -- no idleEpoch, and a
  // verdict persisted onto it inherits no bgEpoch either, because there is none
  // to record. So the check passed without ever establishing which idle period
  // the answer came from, and nothing about being probed fixed that: the entry
  // stayed unstamped until its session got another message, which for a handle
  // sitting in the idle pool may be never. For those the original bug was not a
  // rollout window, it was permanent.
  const k = fakeKv();
  stubPingableProvider();
  // A handle from before any of this: past the reuse window, carrying an `idle`
  // answer from before that -- and a task ran in between that the record has no
  // boundary for, leaving a background shell behind.
  k.substitute({
    idleSince: Date.now() - 16 * 60_000,
    bgCheckedAt: Date.now() - 17 * 60_000,
    bgRunning: 0,
  });

  await sweep({ kv: k.kv, countActiveShells: async () => 1 });

  assert.ok(
    !k.deleted.includes(KEY),
    "an answer with no period attached is not evidence about this one; acting "
      + "on it reclaims the pod before the probe that finds the shell can land",
  );
  assert.equal(
    k.current().bgRunning, 1,
    "and the sweep had to ask, which is what the fresh answer proves",
  );
  assert.equal(
    typeof k.current().idleEpoch, "number",
    "the entry is stamped on the way through, so it is only unusable once",
  );
  assert.equal(
    k.current().bgEpoch, k.current().idleEpoch,
    "and the answer it just took is scoped to the period it measured",
  );
});

test("a handle with no verdict at all is still just unprobed", async () => {
  // The strictness above is about not trusting an unscoped answer, not about
  // treating a handle nobody has asked about yet as anything new: that one has
  // always read `unknown`, which keeps it and probes it.
  const k = fakeKv();
  stubPingableProvider();
  let asked = 0;

  await sweep({ kv: k.kv, countActiveShells: async () => { asked += 1; return 0; } });

  assert.equal(asked, 1, "a handle with no answer on it is a handle to ask about");
  assert.ok(!k.deleted.includes(KEY), "and it is kept until the answer arrives");
});
