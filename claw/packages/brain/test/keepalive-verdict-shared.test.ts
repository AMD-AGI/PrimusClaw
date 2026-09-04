// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A verdict has to outlive the sweep that took it.
//
// The background-work answer was kept only in the deciding process's memory,
// and reaped at the end of any sweep that did not see the identity. On a
// multi-replica Brain a sweep walks a rotating slice of the handles -- as few as
// one per tick -- so "not seen this tick" is the ordinary state of a live
// sandbox, and every answer was discarded within a tick or two of being written,
// long before the sweep that would have read it.
//
// `unknown` was then the permanent answer. `unknown` is the branch that keeps
// the handle, so idle sandboxes were pinged until the CR's absolute deadline and
// the control plane reclaimed none of them.
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
  replace: (value: Record<string, unknown>) => void;
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
    // The whole entry, exactly as given. `substitute` starts from ENTRY, which
    // is the wrong base for modelling a writer whose defining property is that
    // it carries forward fields it does not understand.
    replace: (v: Record<string, unknown>) => {
      value = sc.encode(JSON.stringify(v));
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
      + "permanent and pinned every idle sandbox to its absolute deadline",
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
// multiplied by the replica count -- tens of minutes even on a small fleet, and
// longer on a bigger one. Against a thirty-minute memory that is the bug: every
// failure aged out before the same replica could fail again, the count never
// left one, and the give-up path existed without ever being able to fire.
//
// The interval below stands for that scale rather than for any one deployment's
// number. What the test pins is the ordering -- a memory shorter than the
// revisit interval can never accumulate a streak -- not the value.
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

// --- an old binary cannot open a new idle period, and must not look like it did ---

/**
 * The entry a replica running the PREVIOUS build leaves behind after it takes an
 * idle handle for a task and idles it again.
 *
 * Both of that build's writers are re-serializations of whatever they read.
 * ensureHands' clearIdleMarkers deletes `keepalive` and `idleSince` on the way
 * in and writes the rest back; its markHandsIdle sets `keepalive:false` and a
 * fresh `idleSince` on the way out and writes the rest back. Neither has any
 * concept of `idleEpoch`, `bgEpoch` or the verdict -- those fields do not exist
 * in that binary -- so all three ride through the task untouched, and the epochs
 * still agree with each other on the far side of it.
 *
 * That is the shape this file's epoch check cannot see: it asks whether the
 * verdict names the period the handle is in, and an old replica answers "yes" by
 * simply not touching either number.
 */
function afterOldReplicaRanATask(
  entry: Record<string, unknown>,
  idledAt: number,
): Record<string, unknown> {
  const activated = { ...entry };
  delete activated.keepalive;   // ensureHands.clearIdleMarkers, on the way in
  delete activated.idleSince;
  // The old markHandsIdle, on the way out: two fields, everything else as found.
  return { ...activated, keepalive: false, idleSince: idledAt };
}

test("a verdict an old binary carried across a task is not read as current", async () => {
  // The rolling-deployment window, which the epochs opened rather than closed.
  //
  // A new replica stamps an old idle handle and files an answer against the
  // stamp. A replica still on the previous build then runs the session's next
  // message in that same pod and idles it again -- preserving stamp, scope and
  // answer, because it cannot see them -- and the task leaves a background shell
  // behind, which is the thing the whole probe exists to protect. The next new
  // replica to sweep finds `idleEpoch === bgEpoch` and an `idle` count, and gives
  // the pod back while the probe that would have found the shell is still in the
  // air.
  //
  // Nothing about the epochs can catch this: an old binary opens a new idle
  // period without touching them, so their agreement is not evidence that the
  // period they name is the current one. `idleSince` is, because every build's
  // markHandsIdle stamps it -- including the one that ran here.
  const k = fakeKv();
  stubPingableProvider();

  // A new replica: stamps the unstamped handle and records `idle` against it.
  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  const measured = k.current();
  assert.equal(typeof measured.idleEpoch, "number", "sanity: the handle was stamped");
  assert.equal(measured.bgRunning, 0, "sanity: an `idle` answer was filed");
  assert.equal(measured.bgEpoch, measured.idleEpoch, "sanity: scoped to that period");

  // Twenty minutes pass on the old replica: the next message arrives, its task
  // runs in this pod and starts a background shell, and the task ends. The
  // measurement above is untouched and still inside BG_VERDICT_TTL_MS, so every
  // replica still believes it; only the clock has moved past it. The handle has
  // then sat idle for sixteen minutes, past SANDBOX_IDLE_REUSE_MS -- which is
  // what makes an `idle` answer actionable rather than academic.
  const now = Date.now();
  k.replace(afterOldReplicaRanATask(
    { ...measured, bgCheckedAt: now - 20 * 60_000 },
    now - 16 * 60_000,
  ));

  const carried = k.current();
  assert.equal(
    carried.bgEpoch, carried.idleEpoch,
    "premise: the old build changed neither epoch, so comparing them still matches",
  );
  assert.equal(carried.bgRunning, 0, "premise: and the answer rode through with them");

  // A new replica sweeps, with no memory of any of this, and its probe would
  // find the shell the task left -- if it is given the chance to land.
  resetBackgroundWorkStateForTest();
  await sweep({ kv: k.kv, countActiveShells: async () => 1 });

  assert.ok(
    !k.deleted.includes(KEY),
    "the `idle` was measured before a task this record has a boundary for only "
      + "in `idleSince`; acting on it reclaims the pod out from under a "
      + "background shell the user expects to still be running",
  );
  assert.equal(
    k.current().bgRunning, 1,
    "and the sweep had to ask again, which is what the fresh answer proves",
  );
});

test("a working sandbox is not re-probed every tick by the stamp that protects it", async () => {
  // The cost side of anchoring the verdict to `idleSince`. The `running` branch
  // also moves that stamp -- so if it moved it to `Date.now()` it would land
  // ahead of the answer that justified moving it, and invalidate it on the very
  // next sweep: a pod with a long-running job would fall back to `unknown` every
  // other tick and be re-probed for as long as the job ran. Anchoring the stamp
  // to the measurement instead makes re-reading the same verdict idempotent.
  const k = fakeKv();
  stubPingableProvider();
  let probes = 0;
  const deps = {
    kv: k.kv,
    countActiveShells: async () => { probes += 1; return 2; },
  };

  await sweep(deps);
  assert.equal(probes, 1, "sanity: the first sweep had nothing to read and asked");

  // The next several sweeps have a `running` answer to read, on the handle and
  // in memory, and neither the stamp they write nor the one they read may
  // dislodge the other.
  for (let i = 0; i < 4; i++) await sweep(deps);

  assert.equal(
    probes, 1,
    "the answer stayed usable across the sweeps that acted on it; a stamp "
      + "written ahead of it would have expired it once per tick",
  );
  assert.ok(!k.deleted.includes(KEY), "and the working pod was kept throughout");
});

test("a stale `idle` verdict is not admitted by landing on the stamp exactly", async () => {
  // The boundary of the rule above. `idleSince` is compared against, not
  // matched, so the case where an old binary's re-idle lands on the same
  // millisecond as the verdict it carried through the task is the one reading
  // where the two are indistinguishable by time -- and the reading the test
  // above turns on is the wrong one for an `idle` answer. Same millisecond is
  // not contrived: the stamp and the measurement are written by different
  // replicas off clocks that agree only to within their skew.
  //
  // A `running` answer still gets to equal the stamp, because refreshIdleSince
  // manufactures exactly that equality on every sweep of a working sandbox --
  // the test after this one is what that costs if it is taken away.
  const k = fakeKv();
  stubPingableProvider();

  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  const measured = k.current();
  assert.equal(measured.bgRunning, 0, "sanity: an `idle` answer was filed");

  // The old replica ran the session's next message here, left a background
  // shell, and idled the handle again -- at the millisecond the answer from
  // before the task happens to carry. Sixteen minutes ago, so the answer is
  // still inside BG_VERDICT_TTL_MS and the handle is already past
  // SANDBOX_IDLE_REUSE_MS: believing it reclaims the pod on this sweep.
  const collision = Date.now() - 16 * 60_000;
  k.replace(afterOldReplicaRanATask({ ...measured, bgCheckedAt: collision }, collision));

  const carried = k.current();
  assert.equal(
    carried.bgCheckedAt, carried.idleSince,
    "premise: the re-idle stamp and the carried measurement are the same instant",
  );
  assert.equal(carried.bgEpoch, carried.idleEpoch, "premise: and the epochs still agree");

  resetBackgroundWorkStateForTest();
  await sweep({ kv: k.kv, countActiveShells: async () => 1 });

  assert.ok(
    !k.deleted.includes(KEY),
    "an `idle` answer that only just reaches the stamp cannot be told from one "
      + "carried across a task that re-idled on the same millisecond; reading it "
      + "as current reclaims the pod out from under a background shell",
  );
  assert.equal(
    k.current().bgRunning, 1,
    "and the sweep asked again instead, which is what the fresh answer proves",
  );
});

test("a sandbox that has just stopped working gets the whole reuse window", async () => {
  // What the anchor may not be allowed to cost. A verdict is believed for
  // BG_VERDICT_TTL_MS, twice the reuse window, so the `running` one a sweep acts
  // on can be far older than the window -- and anchoring means the stamp it
  // moves cannot be moved past it. Measuring the reuse window from that same
  // stamp therefore hands a sandbox whose job has just finished a window that
  // expired before it started: the fresh `idle` answer arrives and the very next
  // sweep deletes the handle, which is the case this whole branch exists to
  // prevent, arriving through the mechanism added to prevent it.
  //
  // So the window is measured from when work was last SEEN, which is now,
  // while the anchor stays at the measurement that said so.
  const k = fakeKv();
  stubPingableProvider();

  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  const stamped = k.current();

  // Another replica measured the job running sixteen minutes ago and nothing has
  // swept the handle since: inside the verdict TTL, so it is still believed, and
  // past the reuse window, so what the window counts from decides the pod.
  const measuredAt = Date.now() - 16 * 60_000;
  k.replace({
    ...stamped, bgRunning: 1, bgCheckedAt: measuredAt, idleSince: measuredAt,
  });
  resetBackgroundWorkStateForTest();

  // This replica reads that answer -- keeping the handle and moving the clocks --
  // and its own probe comes back `idle`, because the job has just finished.
  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  const answered = k.current();
  assert.equal(answered.bgRunning, 0, "sanity: the fresh probe answered `idle`");
  assert.equal(
    answered.idleSince, measuredAt,
    "premise: the anchor stayed at the measurement, as the test above requires",
  );

  // The sweep that acts on that answer is the first one to treat the handle as
  // spare, and the window it gets has to start here.
  await sweep({ kv: k.kv, countActiveShells: async () => 0 });

  assert.ok(
    !k.deleted.includes(KEY),
    "the sandbox was seen working seconds ago and its window ran from a "
      + "sixteen-minute-old measurement instead, so it was reclaimed with no "
      + "reuse time at all -- the next message in the session loses the pod",
  );
});

test("a verdict an old binary carried across a task is not read as current when the clocks disagree", async () => {
  // The same rolling-deployment window, with the one assumption removed that the
  // test above quietly relies on: that the replica which measured the verdict
  // and the replica which later re-idled the handle agree about what time it is.
  //
  // They do not have to. These are two machines, and a stamp written by one is
  // compared against a measurement written by the other; a second of ordinary
  // skew is enough to reverse them. Here the replica that files the verdict runs
  // a minute fast, so the answer it measured BEFORE the old binary's task
  // carries a LARGER number than the `idleSince` that old binary wrote when it
  // idled the sandbox again afterwards. Every "was this measured after the
  // period opened" test says yes; the answer is still from before the task, the
  // task still left a background shell, and believing it still reclaims the pod.
  //
  // So the boundary is not read as a time. The verdict records the stamp it was
  // measured under, and the old binary -- which cannot write that field, but
  // also cannot avoid replacing the value it names -- leaves an entry whose two
  // numbers no longer describe the same idle period, whichever clock was ahead.
  const k = fakeKv();
  stubPingableProvider();

  // The fast replica: it stamps the handle and files `idle` against it, and
  // every timestamp it writes is its own clock's.
  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  const measured = k.current();
  assert.equal(measured.bgRunning, 0, "sanity: an `idle` answer was filed");

  const now = Date.now();
  // Its reading of when it measured, a minute ahead of the replica below.
  k.replace(afterOldReplicaRanATask(
    { ...measured, bgCheckedAt: now - 16 * 60_000 },
    // The old replica's reading of when it handed the sandbox back, which is
    // physically later and numerically earlier.
    now - 17 * 60_000,
  ));

  const carried = k.current();
  assert.ok(
    (carried.bgCheckedAt as number) > (carried.idleSince as number),
    "premise: skew has put the pre-task measurement after the post-task stamp, "
      + "so every ordering test between them reads the stale answer as current",
  );
  assert.equal(
    carried.bgEpoch, carried.idleEpoch,
    "premise: and the old build changed neither epoch, as before",
  );

  // A new replica sweeps with no memory of any of this. Its probe would find the
  // shell the task left behind -- if the handle survives long enough to be asked.
  resetBackgroundWorkStateForTest();
  await sweep({ kv: k.kv, countActiveShells: async () => 1 });

  assert.ok(
    !k.deleted.includes(KEY),
    "the answer was measured under a stamp this entry no longer carries; "
      + "reading it as current because one replica's clock ran fast reclaims "
      + "the pod out from under a background shell",
  );
  assert.equal(
    k.current().bgRunning, 1,
    "and the sweep had to ask again, which is what the fresh answer proves",
  );
});

// --- a clock reading is not a unique name for the period it names ---

test("a verdict is not carried into a second idle period that opened on the same millisecond", async () => {
  // The ABA the stamp cannot see.
  //
  // `idleSince` was made the witness because it is a value rather than an
  // ordering, and a value cannot be skewed into the wrong answer. But it is a
  // wall-clock reading, and a wall-clock reading is not unique: two idle periods
  // fifteen minutes apart can be stamped with the same millisecond, and when
  // they are they carry the same `idleEpoch` too -- markHandsIdle copies one
  // from the other. Both halves of the check then match across the boundary they
  // exist to detect, and the `idle` answer measured during the FIRST period is
  // read as current for the second, which deletes the handle while the task that
  // ran in between is still holding the pod with a background shell.
  //
  // The entry below is that collision at its plainest: the measurement is
  // timestamped one millisecond BEFORE the idle period it is being credited to,
  // which is the proof that the two are different periods, and every field the
  // reader compares still agrees. It is also the shape a build that predates the
  // revision witness leaves behind -- no `idleRev` on the handle, none on the
  // verdict -- so it doubles as the rolling-deployment reading: an entry no
  // current writer stamped is unwitnessed, which costs one probe and never a
  // reclaim.
  const k = fakeKv();
  stubPingableProvider();

  // Sixteen minutes idle, past SANDBOX_IDLE_REUSE_MS, so an `idle` answer is
  // acted on by this very sweep rather than being academic.
  const T = Date.now() - 16 * 60_000;
  k.replace({
    ...ENTRY,
    keepalive: false,
    idleSince: T,
    idleEpoch: T,
    // Measured before this period opened -- so it is about the one before it.
    bgCheckedAt: T - 1,
    bgRunning: 0,
    bgEpoch: T,
    bgIdleSince: T,
  });

  const carried = k.current();
  assert.equal(
    carried.bgIdleSince, carried.idleSince,
    "premise: the two periods were stamped with the same millisecond, so the "
      + "witness matches across the boundary it exists to detect",
  );
  assert.equal(carried.bgEpoch, carried.idleEpoch, "premise: and so do the epochs");
  assert.ok(
    (carried.bgCheckedAt as number) < (carried.idleSince as number),
    "premise: the answer predates the period it is credited to, which is what "
      + "makes these two periods and not one",
  );

  // A replica sweeps with no memory of any of this. Its probe finds the shell
  // the task left -- if the handle survives long enough to be asked.
  await sweep({ kv: k.kv, countActiveShells: async () => 1 });

  assert.ok(
    !k.deleted.includes(KEY),
    "two idle periods that stamp the same millisecond are indistinguishable by "
      + "any reading of the clock; treating the earlier one's `idle` as current "
      + "reclaims the pod out from under a live background shell",
  );
  assert.equal(
    k.current().bgRunning, 1,
    "and the sweep asked again instead, which is what the fresh answer proves",
  );

  // The other half of the same defect, and the half that shows the revision
  // doing positive work rather than merely being absent. The verdict a replica
  // keeps in its own memory is checked by the same rule, and nothing bumps this
  // process's generation when the re-idle happens on ANOTHER replica -- so a
  // colliding millisecond carries the in-process answer across the boundary
  // exactly as it carries the entry-borne one.
  resetBackgroundWorkStateForTest();
  k.replace({ ...ENTRY, keepalive: false, idleSince: T, idleEpoch: T, idleRev: 101 });

  // This replica measures `idle` for the period named (T, 101) and caches it.
  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  assert.equal(k.current().bgRunning, 0, "sanity: an `idle` answer was cached and filed");
  assert.equal(k.current().bgIdleRev, 101, "sanity: witnessed by the period's revision");

  // Another replica then runs the session's next message in this pod, leaves a
  // background shell, and idles the handle again -- landing on the same
  // millisecond, so its `idleSince` and `idleEpoch` are the ones this replica
  // already has an answer for. Its markHandsIdle clears the verdict from the
  // entry, which is why only the in-memory copy can decide this sweep.
  k.replace({ ...ENTRY, keepalive: false, idleSince: T, idleEpoch: T, idleRev: 102 });

  await sweep({ kv: k.kv, countActiveShells: async () => 1 });

  assert.ok(
    !k.deleted.includes(KEY),
    "the cached `idle` names the period (T, 101) and the handle is in (T, 102); "
      + "the two are one period by every clock reading on the entry and two by "
      + "the revision, and only the revision is right",
  );
  assert.equal(
    k.current().bgRunning, 1,
    "and this sweep asked again too, rather than acting on the previous "
      + "period's answer",
  );
});

// --- and which of them, when the two clocks disagree ---

test("a `running` on the handle is not outranked by a local `idle` with a later stamp", async () => {
  // The choice between the two answers was made by comparing their timestamps,
  // and the timestamps come from two different machines. `bgCheckedAt` is
  // stamped by whichever replica probed the handle; the in-process `at` is
  // stamped by this one. Ordinary skew is enough to make the older measurement
  // carry the larger number -- which is the same thing
  // `measuredUnderThisIdlePeriod` refuses to do with `idleSince`, reintroduced
  // one comparison further along.
  //
  // The direction matters. A stale `running` costs one ping. A stale `idle`
  // deletes the handle, and here it deletes it while another replica's
  // measurement says a shell is running in the pod.
  const k = fakeKv();
  stubPingableProvider();

  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  const measured = k.current();
  assert.equal(measured.bgRunning, 0, "sanity: this replica measured and filed `idle`");
  assert.equal(
    backgroundWorkStateSizesForTest().cache, 1,
    "sanity: and kept its own copy of that answer to prefer",
  );

  // Another replica probed after we did and found work running. Same idle
  // period on both sides -- same epoch, same witnesses -- so the answer is
  // usable; only its clock is behind ours, by a second.
  k.replace({
    ...measured,
    bgRunning: 1,
    // Derived from the answer this replica just filed rather than from the
    // clock, so the skew under test is exactly one second no matter how long
    // the sweep above took to run.
    bgCheckedAt: (measured.bgCheckedAt as number) - 1_000,
  });

  await sweep({
    kv: k.kv,
    // Nothing new is measured on this sweep, so the decision is made entirely
    // from the two answers that already exist.
    countActiveShells: async () => { throw new Error("this replica cannot reach Hands"); },
  });

  assert.ok(
    !k.deleted.includes(KEY),
    "a live measurement saying a shell is running cannot be overruled by an "
      + "`idle` that merely carries a larger number off a different clock; "
      + "believing the clock reclaims the pod out from under the shell",
  );
});

test("an `idle` answer landing late does not overwrite a `running` one from the same period", async () => {
  // The read side prefers `running` from either copy, and that only decides
  // anything while both answers exist to be compared. One verdict is kept per
  // handle, so the write side is where an answer can be made to stop existing:
  // whichever probe persists last is what every later sweep reads, and the two
  // probes are on different replicas with no ordering between them.
  //
  // Nothing above catches it. The identity check says the entry still names the
  // sandbox that was probed, and the period checks say it is still in the idle
  // period that was probed. Both are true of the loser of this race -- it is the
  // same sandbox and the same period; it is simply the less authoritative answer
  // about them, and it arrives second.
  const k = fakeKv();
  stubPingableProvider();

  // A handle in a fully named idle period with nothing measured in it yet: the
  // sweep stamps the period, and the verdict it files is then stripped so the
  // race below starts from no answer at all.
  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  const stamped = { ...k.current() };
  for (const f of ["bgCheckedAt", "bgRunning", "bgEpoch", "bgIdleSince", "bgIdleRev", "bgRev"]) {
    delete stamped[f];
  }
  assert.equal(typeof stamped.idleEpoch, "number", "sanity: the period has to be named");
  assert.equal(typeof stamped.idleRev, "number", "sanity: on both halves of its name");
  k.replace(stamped);
  resetBackgroundWorkStateForTest();

  // This replica's probe answers `idle` and then blocks before it can file the
  // answer. The run-lease read is that suspension point in the real path, and
  // it is a KV read, so it is where the delay is injected.
  let releaseLease: (() => void) | null = null;
  const leaseInFlight = new Promise<void>((r) => { releaseLease = r; });
  let leaseAsked = false;
  const slow = {
    ...k.kv,
    async keys(filter = ">") { return k.kv.keys(filter); },
    async get(key: string) {
      if (key.startsWith("lock.")) {
        leaseAsked = true;
        await leaseInFlight;
        return null;   // no lease, so `held` is false and the `idle` would be filed
      }
      return k.kv.get(key);
    },
  } as unknown as KV;

  await runKeepaliveTickForTest({ kv: slow, countActiveShells: async () => 0 });
  await new Promise((r) => setImmediate(r));
  assert.ok(leaseAsked, "sanity: the answer has to be in flight, not already written");
  assert.equal(
    k.current().bgRunning, undefined,
    "sanity: and nothing may be on the handle while it is",
  );

  // Another replica probes the same handle in the same period, finds a shell,
  // and gets its answer onto the entry first. Everything it writes is about the
  // period the entry is still in, so it is believed by every reader.
  const publishedAt = Date.now();
  k.replace({
    ...stamped,
    bgRunning: 1,
    bgCheckedAt: publishedAt,
    bgEpoch: stamped.idleEpoch,
    bgIdleSince: stamped.idleSince,
    bgIdleRev: stamped.idleRev,
    // The revision that write was conditioned on, which is what names it.
    bgRev: (stamped.idleRev as number) + 3,
  });

  // And now the slow answer lands. Same sandbox, same period, so it clears every
  // guard that was there before this one.
  releaseLease!();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(
    k.current().bgRunning, 1,
    "an `idle` measured before another replica saw a shell must not be the last "
      + "word about the period they both measured -- one verdict is kept, and "
      + "overwriting the `running` one erases the only record that work is there",
  );
  assert.equal(
    k.current().bgCheckedAt, publishedAt,
    "and the `running` verdict has to survive intact rather than be re-stamped, "
      + "because its stamp is the anchor the reuse window is moved against",
  );

  // Which is the whole point: a third replica, with no memory of either probe,
  // reads the entry and decides the pod on it.
  resetBackgroundWorkStateForTest();
  await sweep({
    kv: k.kv,
    countActiveShells: async () => { throw new Error("this replica cannot reach Hands"); },
  });
  assert.ok(
    !k.deleted.includes(KEY),
    "the handle was reclaimed on an `idle` that lost a race it had no business "
      + "winning, with a background shell still running in the sandbox",
  );
});

// --- an inference has to survive long enough to be read ---

test("giving up on an unreachable Hands releases the handle rather than repeating", async () => {
  // The give-up answer is kept in this process only, which is right -- it is a
  // statement about one replica's reach, not a measurement to publish. But that
  // makes the replica that inferred it the only one that can read it, so it has
  // to survive until THAT replica walks the handle again: the same
  // rotation-times-replica-count gap the streak above is sized for, not the five
  // minutes a measured answer is reused for.
  //
  // Under the short lifetime the inference expired unread every time. The
  // handle was probed again, the probes failed again, the streak gave up again
  // -- six, seven, eight failures deep -- and the pod was never released, which
  // is the one thing the give-up path exists to do.
  const k = fakeKv();
  stubPingableProvider();
  const deps = {
    kv: k.kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  };

  for (let visit = 0; visit < 10 && !k.deleted.includes(KEY); visit++) {
    await sweep(deps);
    // One whole revisit interval before this replica sees the handle again --
    // the cadence the give-up answer actually has to live through, rather than
    // a second sweep arriving while it is still warm.
    ageBackgroundWorkCacheForTest(SAME_REPLICA_REVISIT_MS);
  }

  assert.ok(
    k.deleted.includes(KEY),
    "the give-up settled to `idle` and then expired before the sweep that would "
      + "have acted on it; a Hands that has stopped answering holds its pod to "
      + "the CR's absolute deadline and the tolerance means nothing",
  );
});

test("a give-up is revised by the Hands that comes back before the window ends", async () => {
  // What the longer life may not cost. The lifetime of a cached answer was also
  // how long this replica stopped asking -- `needsProbe` reads the same rule --
  // so an inference believed for hours would be an inference nothing could
  // revise: a handle inside its reuse window is not deleted and opens no new
  // idle period, so no probe means no correction. A Hands that blipped for six
  // probes and came straight back would then have its pod reclaimed at the end
  // of the window with a background shell still running in it, which is the
  // reclaim this whole file exists to prevent.
  const k = fakeKv();
  stubPingableProvider();
  // Freshly idled, so the give-up does not immediately delete the handle and
  // there is a window left for the recovery to matter in.
  k.replace({ ...ENTRY, idleSince: Date.now() });

  let reachable = false;
  let probes = 0;
  const deps = {
    kv: k.kv,
    countActiveShells: async () => {
      probes += 1;
      if (!reachable) throw new Error("hands unreachable");
      return 1;
    },
  };

  for (let visit = 0; visit < 10 && backgroundWorkStateSizesForTest().cache === 0; visit++) {
    await sweep(deps);
  }
  assert.equal(
    backgroundWorkStateSizesForTest().cache, 1,
    "sanity: the streak gave up and inferred `idle` while the window is still open",
  );
  const gaveUpAfter = probes;

  // Hands comes back, with a background shell running in the pod, and the
  // inference is older than the interval a probe is skipped for.
  reachable = true;
  ageBackgroundWorkCacheForTest(6 * 60_000);
  await sweep(deps);

  assert.ok(
    probes > gaveUpAfter,
    "believing an inference for longer is not a reason to stop asking; a "
      + "replica that never asks again can never find out it was wrong",
  );
  assert.equal(
    k.current().bgRunning, 1,
    "and the measurement that came back replaces the guess, so the shell keeps "
      + "its pod",
  );
  assert.ok(!k.deleted.includes(KEY), "sanity: nothing was reclaimed here");
});

test("a give-up inference is not reaped before the visit it exists for", async () => {
  // The reap is the other place a lifetime is decided, and it had one floor for
  // every entry. Left at the measured floor it discards the inference at thirty
  // minutes -- inside the gap the longer life was given for -- so the give-up
  // expires unread after all and the loop it was meant to break resumes one
  // level down.
  const k = fakeKv();
  stubPingableProvider();
  const deps = {
    kv: k.kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  };

  for (let visit = 0; visit < 10 && backgroundWorkStateSizesForTest().cache === 0; visit++) {
    await sweep(deps);
  }
  assert.equal(
    backgroundWorkStateSizesForTest().cache, 1,
    "sanity: there is an inference to reap",
  );

  // Walked elsewhere, so nothing can re-probe and quietly rewrite what the reap
  // removes -- the assertion is about the reap and only about the reap.
  k.setVisible(false);
  ageBackgroundWorkCacheForTest(SAME_REPLICA_REVISIT_MS);
  await sweep(deps);

  assert.equal(
    backgroundWorkStateSizesForTest().cache, 1,
    "the answer this replica is still meant to be reading cannot be reaped out "
      + "from under it by a floor sized for a different kind of answer",
  );
});

test("a give-up does not delete the handle in the same sweep it re-asks", async () => {
  // The give-up answer decides the one irreversible thing in this file, and the
  // sweep decides it during the walk -- before the probes it dispatches at the
  // end of the same tick. So an inference old enough that this very tick has
  // judged it worth re-asking was still good enough to delete on: the handle
  // was gone by the time the answer came back, and `persistVerdict` dropped a
  // measurement of live background work onto a key that no longer existed.
  //
  // A guess this replica is in the act of doubting may not reclaim a pod. It
  // has to be refused twice, one visit apart, with the handle kept and pinged
  // in between -- which costs a ping and buys the answer that makes the delete
  // correct.
  const k = fakeKv();
  stubPingableProvider();

  let reachable = false;
  const deps = {
    kv: k.kv,
    countActiveShells: async () => {
      if (!reachable) throw new Error("hands unreachable");
      return 3;
    },
  };

  for (let visit = 0; visit < 10 && backgroundWorkStateSizesForTest().cache === 0; visit++) {
    await sweep(deps);
  }
  assert.equal(
    backgroundWorkStateSizesForTest().cache, 1,
    "sanity: the streak gave up and inferred `idle` for a handle already past "
      + "its reuse window",
  );
  assert.ok(!k.deleted.includes(KEY), "sanity: the first give-up does not reclaim on its own");

  // Hands is back, with three background shells in it, and the inference is old
  // enough that this sweep re-arms a probe for it.
  reachable = true;
  ageBackgroundWorkCacheForTest(6 * 60_000);
  await sweep(deps);

  assert.ok(
    !k.deleted.includes(KEY),
    "the sweep that re-asks cannot also act on the answer it is replacing; "
      + "deleting first means the measurement lands on a deleted key and three "
      + "live shells go down with the pod",
  );
  assert.equal(
    k.current().bgRunning, 3,
    "and the probe that tick dispatched is filed against a handle that is still "
      + "there to carry it",
  );
});
