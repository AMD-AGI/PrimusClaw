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
  backgroundWorkStateSizesForTest, ageBackgroundWorkCacheForTest, markHandsIdle, registerSandbox,
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

function stubPingableProvider(overrides: Partial<SandboxProvider> = {}): void {
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, healthy: true }; },
    async stop() {},
    ...overrides,
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
    async delete(key: string, opts?: { previousSeq?: number }) {
      if (opts?.previousSeq !== undefined && opts.previousSeq !== revision) {
        throw new Error("revision conflict");
      }
      deleted.push(key);
    },
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

test("the verdict is on the handle, so another replica can read it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
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

  t.mock.timers.tick(16 * 60_000);

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

const CLEAR_WORK = 'MARKER {"epoch":"e1","bearer":{"pid":7,"startToken":"t7"}}\nSUBTREE ok\nPROCS 7';

function stubClearWork(): void {
  stubPingableProvider({
    async exec() { return { exitCode: 0, stdout: CLEAR_WORK, stderr: "" }; },
  });
}

test("positive idle evidence reclaims a handle despite failed Hands probes and rotating sweeps", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = fakeKv();
  stubClearWork();
  const deps = {
    kv: k.kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  };

  for (let i = 0; i < 8 && !k.deleted.includes(KEY); i++) {
    await sweep(deps);
    k.setVisible(false);
    await sweep(deps);
    k.setVisible(true);
    t.mock.timers.tick(3 * 60_000);
  }

  assert.equal(k.current().bgRunning, 0, "the complete record read supplies positive idle evidence");
  assert.ok(k.deleted.includes(KEY), "observed idle work is reclaimed after the reuse window");
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

const SAME_REPLICA_REVISIT_MS = 36 * 60_000;

test("repeated failures across long revisit intervals never authorize reclaim", async () => {
  const k = fakeKv();
  stubPingableProvider();
  const deps = {
    kv: k.kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  };
  for (let i = 0; i < 12; i++) {
    await sweep(deps);
    ageBackgroundWorkCacheForTest(SAME_REPLICA_REVISIT_MS);
    assert.equal(backgroundWorkStateSizesForTest().streaks, 1);
  }
  assert.equal(k.current().bgRunning, undefined, "a failure count cannot supply evidence");
  assert.ok(!k.deleted.includes(KEY));
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
      + "reaping it here loses the recent failures needed for reporting",
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

test("a working sandbox is not re-probed every tick by the stamp that protects it", async (t) => {
  // The cost side of anchoring the verdict to `idleSince`. The `running` branch
  // also moves that stamp -- so if it moved it to `Date.now()` it would land
  // ahead of the answer that justified moving it, and invalidate it on the very
  // next sweep: a pod with a long-running job would fall back to `unknown` every
  // other tick and be re-probed for as long as the job ran. Anchoring the stamp
  // to the measurement instead makes re-reading the same verdict idempotent.
  // Cache and KV writes may straddle milliseconds in production.
  let now = Date.now();
  t.mock.method(Date, "now", () => now++);
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

test("an `idle` answer landing late does not overwrite a `running` one from the same period", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
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

test("a `running` answer is not dropped by an `idle` one decided against the same revision", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // The guard above settles the race it can see: an answer already published on
  // the entry against one that arrives after it. This is the same race one step
  // earlier, where there is nothing published for the guard to compare against.
  //
  // Two replicas probe the same handle in the same idle period. Both read the
  // entry before either writes to it, so both read the same revision and both
  // read no verdict at all -- the `running`-wins guard has nothing to find and
  // permits either write. Both then condition their update on that one revision
  // and exactly one of them can land. Which one is decided by arrival order,
  // which is the single thing about these two answers that says nothing about
  // the sandbox, and the loser's failure is indistinguishable from every other
  // best-effort failure in this path.
  const k = fakeKv();
  stubPingableProvider();

  // A handle in a fully named idle period with no answer measured in it yet, so
  // the race starts from the state that makes the guard blind: nothing to
  // compare against.
  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  const stamped = { ...k.current() };
  for (const f of ["bgCheckedAt", "bgRunning", "bgEpoch", "bgIdleSince", "bgIdleRev", "bgRev"]) {
    delete stamped[f];
  }
  assert.equal(typeof stamped.idleEpoch, "number", "sanity: the period has to be named");
  assert.equal(typeof stamped.idleRev, "number", "sanity: on both halves of its name");
  k.replace(stamped);
  resetBackgroundWorkStateForTest();

  // This replica finds a shell. The other replica's `idle` write is landed at
  // the moment this one's update is issued and against the revision it read,
  // which is what "both decided against the same revision" means -- it is not a
  // verdict this replica could have seen at the guard, and it takes the one
  // update that revision allows.
  let idleLanded = false;
  const idleAt = Date.now();
  const racing = {
    ...k.kv,
    async keys(filter = ">") { return k.kv.keys(filter); },
    async get(key: string) { return k.kv.get(key); },
    async update(key: string, v: Uint8Array, rev: number) {
      const writing = JSON.parse(sc.decode(v)) as Record<string, unknown>;
      if (!idleLanded && key === KEY && writing.bgRunning === 1) {
        idleLanded = true;
        k.replace({
          ...stamped,
          bgRunning: 0,
          bgCheckedAt: idleAt,
          bgEpoch: stamped.idleEpoch,
          bgIdleSince: stamped.idleSince,
          bgIdleRev: stamped.idleRev,
          // Conditioned on the same revision this replica read, and so named by
          // it: the two answers are about one revision, not one after the other.
          bgRev: rev,
        });
      }
      return k.kv.update(key, v, rev);
    },
  } as unknown as KV;

  await runKeepaliveTickForTest({ kv: racing, countActiveShells: async () => 1 });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.ok(idleLanded, "sanity: the two writes have to actually have raced");

  assert.equal(
    k.current().bgRunning, 1,
    "an `idle` answer that wins the conditional update erases the only record "
      + "that a shell is running, and it wins it by arriving first -- which is "
      + "the one thing about these two answers that is not about the sandbox",
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
    "the handle was reclaimed on an `idle` that won a coin toss, with a "
      + "background shell still running in the sandbox",
  );
});

test("a `running` answer is not given up on because the contention outlasted its retries", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = fakeKv();
  stubPingableProvider();

  // Same starting state as the single-race test: a fully named idle period
  // carrying no answer yet.
  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  const stamped = { ...k.current() };
  for (const f of ["bgCheckedAt", "bgRunning", "bgEpoch", "bgIdleSince", "bgIdleRev", "bgRev"]) {
    delete stamped[f];
  }
  assert.equal(typeof stamped.idleEpoch, "number", "sanity: the period has to be named");
  assert.equal(typeof stamped.idleRev, "number", "sanity: on both halves of its name");
  k.replace(stamped);
  resetBackgroundWorkStateForTest();

  // One distinct contending `idle` per attempt, each landed against the very
  // revision that attempt read, so every conditional update this replica issues
  // is beaten by a different writer rather than by one writer over and over.
  // Four of them, which is what the old counter allowed; the contention then
  // stops, so a replica whose retries outlast it lands on the next attempt and
  // one whose retries do not has already given up.
  const CONTENDERS = 4;
  const idleAt = Date.now();
  let contended = 0;
  let runningLanded = 0;
  const racing = {
    ...k.kv,
    async keys(filter = ">") { return k.kv.keys(filter); },
    async get(key: string) { return k.kv.get(key); },
    async update(key: string, v: Uint8Array, rev: number) {
      const writing = JSON.parse(sc.decode(v)) as Record<string, unknown>;
      if (key === KEY && writing.bgRunning === 1) {
        if (contended < CONTENDERS) {
          contended += 1;
          k.replace({
            ...stamped,
            bgRunning: 0,
            // Distinct per contender, on both halves of what names a verdict, so
            // these are four separate answers and not one replayed.
            bgCheckedAt: idleAt + contended,
            bgEpoch: stamped.idleEpoch,
            bgIdleSince: stamped.idleSince,
            bgIdleRev: stamped.idleRev,
            bgRev: rev,
          });
        } else {
          runningLanded += 1;
        }
      }
      return k.kv.update(key, v, rev);
    },
  } as unknown as KV;

  await runKeepaliveTickForTest({ kv: racing, countActiveShells: async () => 1 });
  for (let i = 0; i < 80; i++) await new Promise((r) => setImmediate(r));

  assert.equal(
    contended, CONTENDERS,
    "sanity: every one of the contending writes has to have actually raced a "
      + "conditional update, or the exhaustion being tested never happened",
  );
  assert.equal(
    runningLanded, 1,
    "the `running` answer stopped trying while a contending `idle` was still "
      + "winning, which is the one way this write is not allowed to end",
  );
  assert.equal(
    k.current().bgRunning, 1,
    "a shell is running and the handle says it is idle, because the `idle` "
      + "answers outnumbered the retries rather than outranked them",
  );

  // And the same consequence the coin-toss race has: whatever is left on the
  // entry is what a replica that never probed decides the pod on.
  resetBackgroundWorkStateForTest();
  await sweep({
    kv: k.kv,
    countActiveShells: async () => { throw new Error("this replica cannot reach Hands"); },
  });
  assert.ok(
    !k.deleted.includes(KEY),
    "the handle was reclaimed on an `idle` that outlasted the retries, with a "
      + "background shell still running in the sandbox",
  );
});


test("a `running` answer is not lost to a reclaim decided on the `idle` it is contesting", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = fakeKv();
  stubPingableProvider();

  // Same starting state as the two races above: a fully named idle period
  // carrying no answer yet, and no question outstanding about it either -- so
  // what defers the reclaim below is the probe this test starts, not one left
  // over from the setup.
  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  const stamped = { ...k.current() };
  for (const f of ["bgCheckedAt", "bgRunning", "bgEpoch", "bgIdleSince", "bgIdleRev", "bgRev"]) {
    delete stamped[f];
  }
  delete stamped.bgProbes;
  assert.equal(typeof stamped.idleEpoch, "number", "sanity: the period has to be named");
  assert.equal(typeof stamped.idleRev, "number", "sanity: on both halves of its name");
  k.replace(stamped);
  resetBackgroundWorkStateForTest();

  // This replica finds a shell. The other replica's `idle` lands against the
  // very revision this one read, taking the one update that revision allows --
  // and is published the way persistVerdict publishes one, onto the entry it
  // read, carrying forward every field it does not itself set.
  //
  // The retry is then held at its next read, which is where the reclaim gets in.
  let idleLanded = false;
  let holdRetry = false;
  let releaseRetry: () => void = () => {};
  const retryHeld = new Promise<void>((r) => { releaseRetry = r; });
  const idleAt = Date.now();
  const racing = {
    ...k.kv,
    async keys(filter = ">") { return k.kv.keys(filter); },
    async get(key: string) {
      if (holdRetry) { holdRetry = false; await retryHeld; }
      return k.kv.get(key);
    },
    async update(key: string, v: Uint8Array, rev: number) {
      const writing = JSON.parse(sc.decode(v)) as Record<string, unknown>;
      if (!idleLanded && key === KEY && writing.bgRunning === 1) {
        idleLanded = true;
        holdRetry = true;
        k.replace({
          ...k.current(),
          bgRunning: 0,
          bgCheckedAt: idleAt,
          bgEpoch: stamped.idleEpoch,
          bgIdleSince: stamped.idleSince,
          bgIdleRev: stamped.idleRev,
          bgRev: rev,
        });
      }
      return k.kv.update(key, v, rev);
    },
  } as unknown as KV;

  await runKeepaliveTickForTest({ kv: racing, countActiveShells: async () => 1 });
  for (let i = 0; i < 40 && !idleLanded; i++) await new Promise((r) => setImmediate(r));
  assert.ok(idleLanded, "sanity: the two answers have to actually have raced");

  // A third replica, with no memory of either probe, sweeps while the `running`
  // answer is still on its way round. All it can see is the `idle` that just
  // won, on a handle long past its reuse window that nothing here is running.
  resetBackgroundWorkStateForTest();
  await sweep({
    kv: k.kv,
    countActiveShells: async () => { throw new Error("this replica cannot reach Hands"); },
  });
  assert.ok(
    !k.deleted.includes(KEY),
    "the handle was reclaimed on a verdict that was still being contested, and "
      + "the `running` answer contesting it now has no entry to land on",
  );

  // And the retry, released, still has somewhere to file what it measured.
  releaseRetry();
  for (let i = 0; i < 80; i++) await new Promise((r) => setImmediate(r));
  assert.equal(
    k.current().bgRunning, 1,
    "a shell is running and the measurement that says so was dropped, because "
      + "the key it was about went out from under it mid-retry",
  );
  assert.ok(
    !k.deleted.includes(KEY),
    "sanity: nothing reclaimed the handle after the answer landed either",
  );
});


/**
 * A named idle period carrying no verdict and no outstanding question.
 *
 * The reservation tests are about the write that publishes a question, so the
 * entry they start from has to have nothing on it that would defer a reclaim by
 * itself -- otherwise a handle kept for the wrong reason reads as a handle kept.
 */
function idlePeriodWithNothingOutstanding(k: ReturnType<typeof fakeKv>): Record<string, unknown> {
  const stamped = { ...k.current() };
  for (const f of ["bgCheckedAt", "bgRunning", "bgEpoch", "bgIdleSince", "bgIdleRev", "bgRev"]) {
    delete stamped[f];
  }
  delete stamped.bgProbes;
  assert.equal(typeof stamped.idleEpoch, "number", "sanity: the period has to be named");
  assert.equal(typeof stamped.idleRev, "number", "sanity: on both halves of its name");
  k.replace(stamped);
  resetBackgroundWorkStateForTest();
  return stamped;
}

test("a reservation that loses a revision is republished before Hands is asked", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // The reservation was written the way every other value in this sweep is:
  // one read, one conditional update, and silence if it did not land. That is
  // the right shape for a verdict, where losing means somebody else's answer is
  // on the entry, and the wrong shape for this, where losing means NO question
  // is on the entry -- and the probe went out anyway.
  //
  // Which is the original loss reached by a different route. An unprotected
  // answer in the air is exactly what the third replica below cannot see, so it
  // reads a spare handle past its reuse window and reclaims it, and the
  // measurement of live work arrives to find no key to be about.
  //
  // Losing the revision is not the exceptional case either. Every replica that
  // publishes a verdict, reserves its own probe, or releases one moves the
  // revision on this key, so a single-attempt reservation is only reliable on a
  // handle nothing else is interested in.
  const k = fakeKv();
  stubPingableProvider();

  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  const stamped = idlePeriodWithNothingOutstanding(k);

  // Another replica's verdict lands against the very revision this replica's
  // reservation read, taking the one update that revision allows. Once, so the
  // question is whether the reservation comes back rather than whether it can
  // be starved.
  let bumped = false;
  let reservedWhenAsked: Record<string, unknown> | undefined;
  let asked = false;
  // The answer is held while the third replica below sweeps, which is the
  // window the whole mechanism is about: the probe has been sent, nothing has
  // come back, and the only thing that can tell another replica a question is
  // open is what is on the entry.
  let releaseAnswer: () => void = () => {};
  const answerHeld = new Promise<void>((r) => { releaseAnswer = r; });
  const racing = {
    ...k.kv,
    async keys(filter = ">") { return k.kv.keys(filter); },
    async get(key: string) { return k.kv.get(key); },
    async update(key: string, v: Uint8Array, rev: number) {
      const writing = JSON.parse(sc.decode(v)) as Record<string, unknown>;
      if (!bumped && key === KEY && writing.bgProbes) {
        bumped = true;
        k.replace({
          ...k.current(),
          bgRunning: 0,
          bgCheckedAt: Date.now(),
          bgEpoch: stamped.idleEpoch,
          bgIdleSince: stamped.idleSince,
          bgIdleRev: stamped.idleRev,
          bgRev: rev,
        });
      }
      return k.kv.update(key, v, rev);
    },
  } as unknown as KV;

  await runKeepaliveTickForTest({
    kv: racing,
    countActiveShells: async () => {
      asked = true;
      reservedWhenAsked = k.current().bgProbes as Record<string, unknown> | undefined;
      await answerHeld;
      return 1;
    },
  });
  for (let i = 0; i < 40 && !asked; i++) await new Promise((r) => setImmediate(r));
  assert.ok(bumped, "sanity: the reservation has to have actually lost a revision");
  assert.ok(
    reservedWhenAsked && Object.keys(reservedWhenAsked).length > 0,
    "Hands was asked about this handle with no reservation on the entry, so the "
      + "answer is in the air with nothing anywhere saying a question is open",
  );

  // A third replica, with no memory of the question, sweeps while the answer is
  // still on its way. All it can read is the `idle` verdict that won above, on a
  // handle long past its reuse window that nothing here is running.
  resetBackgroundWorkStateForTest();
  await sweep({
    kv: k.kv,
    countActiveShells: async () => { throw new Error("this replica cannot reach Hands"); },
  });
  assert.ok(
    !k.deleted.includes(KEY),
    "the handle was reclaimed while a probe about it was outstanding, because "
      + "the reservation that would have said so lost its revision and was dropped",
  );

  // And the measurement, let through, has somewhere to land.
  releaseAnswer();
  for (let i = 0; i < 80; i++) await new Promise((r) => setImmediate(r));
  assert.equal(
    k.current().bgRunning, 1,
    "a shell is running and the measurement that says so never reached the entry",
  );
});

test("a probe nothing can reserve is not asked at all", async () => {
  // The other half of the same rule. Retrying makes the reservation reliable
  // against contention, not against a store that refuses every conditional
  // update, and the budget is finite by design -- so there is still a path where
  // the token cannot be published.
  //
  // What that path may not do is ask anyway. An unreserved probe is the
  // unprotected probe above with no revision race needed to produce it, so the
  // question is skipped instead: the handle stays `unknown`, which is kept and
  // pinged, and the next sweep asks again.
  const k = fakeKv();
  stubPingableProvider();

  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  idlePeriodWithNothingOutstanding(k);

  // Every reservation write loses, because the entry moves between each
  // attempt's read and its update.
  let reservations = 0;
  let asked = false;
  const contended = {
    ...k.kv,
    async keys(filter = ">") { return k.kv.keys(filter); },
    async get(key: string) { return k.kv.get(key); },
    async update(key: string, v: Uint8Array, rev: number) {
      const writing = JSON.parse(sc.decode(v)) as Record<string, unknown>;
      if (key === KEY && writing.bgProbes) {
        reservations += 1;
        k.replace({ ...k.current() });
      }
      return k.kv.update(key, v, rev);
    },
  } as unknown as KV;

  await runKeepaliveTickForTest({
    kv: contended,
    countActiveShells: async () => { asked = true; return 1; },
  });
  for (let i = 0; i < 80; i++) await new Promise((r) => setImmediate(r));

  assert.equal(
    asked, false,
    "Hands was asked without a reservation ever reaching the entry, which is the "
      + "unprotected answer the reservation exists to prevent",
  );
  assert.ok(reservations > 1, "sanity: the reservation has to have been retried");
  assert.equal(
    k.current().bgProbes, undefined,
    "sanity: no reservation is left behind by a question that was never asked",
  );
});

test("shared idle evidence survives a local cache expiring between visits", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = fakeKv();
  stubClearWork();
  const deps = {
    kv: k.kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  };
  for (let visit = 0; visit < 5 && !k.deleted.includes(KEY); visit++) {
    await sweep(deps);
    t.mock.timers.tick(6 * 60_000);
  }
  assert.ok(k.deleted.includes(KEY), "positive idle evidence permits eventual reclamation");
});

test("idle record evidence is revised when Hands returns with running work", async () => {
  const k = fakeKv();
  stubClearWork();
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
  await sweep(deps);
  assert.equal(k.current().bgRunning, 0);
  reachable = true;
  ageBackgroundWorkCacheForTest(6 * 60_000);
  await sweep(deps);
  assert.equal(probes, 2, "cached evidence must not prevent a later measurement");
  assert.equal(k.current().bgRunning, 1);
  assert.ok(!k.deleted.includes(KEY));
});

test("an evidence verdict is not reaped while a rotating sweep walks elsewhere", async () => {
  const k = fakeKv();
  stubClearWork();
  const deps = {
    kv: k.kv,
    countActiveShells: async () => { throw new Error("hands unreachable"); },
  };
  await sweep(deps);
  assert.equal(k.current().bgRunning, 0);
  k.setVisible(false);
  ageBackgroundWorkCacheForTest(6 * 60_000);
  await sweep(deps);
  assert.equal(backgroundWorkStateSizesForTest().cache, 1);
});

test("a refresh can revise idle evidence before the reuse window ends", async () => {
  const k = fakeKv();
  stubClearWork();
  let reachable = false;
  const deps = {
    kv: k.kv,
    countActiveShells: async () => {
      if (!reachable) throw new Error("hands unreachable");
      return 3;
    },
  };
  await sweep(deps);
  assert.equal(k.current().bgRunning, 0);
  reachable = true;
  ageBackgroundWorkCacheForTest(6 * 60_000);
  await sweep(deps);
  assert.ok(!k.deleted.includes(KEY));
  assert.equal(k.current().bgRunning, 3);
});

test("positive provider absence releases a gone identity without idle aging", async (t) => {
  for (const state of ["absent", "terminal"] as const) {
    await t.test(state, async () => {
      resetBackgroundWorkStateForTest();
      restoreProviders?.();
      const k = fakeKv();
      let statusReads = 0;
      let workReads = 0;
      stubPingableProvider({
        async get(inst) {
          assert.equal(inst.id, ENTRY.workloadId);
          statusReads += 1;
          return { state, running: false, healthy: false };
        },
        async exec(_inst, command) {
          if (command.includes("epoch.json")) workReads += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      const deps = { kv: k.kv, countActiveShells: async () => { throw new Error("unreachable"); } };
      await sweep(deps);
      assert.ok(!k.deleted.includes(KEY), "the first sweep holds unknown until evidence arrives");
      assert.ok(Date.now() - Number(k.current().idleSince) < 60_000);
      await sweep(deps);
      assert.equal(statusReads, 1);
      assert.equal(workReads, 0, "positive absence does not require a container read");
      assert.ok(k.deleted.includes(KEY), "gone bypasses the ordinary idle reuse window");
    });
  }
});

test("a failed evidence read stays unknown even when provider running is false", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = fakeKv();
  let reads = 0;
  stubPingableProvider({
    async get() { return { running: false, healthy: false }; },
    async exec(_inst, command) {
      if (!command.includes("epoch.json")) return { exitCode: 0, stdout: "", stderr: "" };
      reads += 1;
      return { exitCode: 1, stdout: CLEAR_WORK, stderr: "record read failed" };
    },
  });
  const deps = { kv: k.kv, countActiveShells: async () => { throw new Error("unreachable"); } };
  await sweep(deps);
  t.mock.timers.tick(16 * 60_000);
  await sweep(deps);
  assert.equal(reads, 2, "each failed Hands probe reaches the independent record reader");
  assert.equal(k.current().bgRunning, undefined, "partial stdout is not a zero count");
  assert.equal(k.current().idleSince, Date.now(), "unknown resets the idle clock");
  assert.ok(!k.deleted.includes(KEY));
});

test("evidence arriving after local reuse cannot publish idle or gone", async (t) => {
  for (const channel of ["provider", "records"] as const) {
    await t.test(channel, async () => {
      resetBackgroundWorkStateForTest();
      restoreProviders?.();
      const k = fakeKv();
      const pending = Promise.withResolvers<void>();
      let reading = false;
      stubPingableProvider({
        async get() {
          if (channel === "provider") {
            reading = true;
            await pending.promise;
            return { running: false, healthy: false, state: "absent" };
          }
          return { running: true, healthy: true, state: "running" };
        },
        async exec(_inst, command) {
          if (command.includes("epoch.json")) {
            reading = true;
            await pending.promise;
          }
          return { exitCode: 0, stdout: CLEAR_WORK, stderr: "" };
        },
      });
      const deps = { kv: k.kv, countActiveShells: async () => { throw new Error("unreachable"); } };
      await sweep(deps);
      assert.ok(reading);
      registerSandbox(SESSION, { provider: "safe-workload", workloadId: ENTRY.workloadId });
      pending.resolve();
      await new Promise((r) => setImmediate(r));
      assert.equal(backgroundWorkStateSizesForTest().cache, 0);
      assert.equal(k.current().bgRunning, undefined);
      unregisterSandbox(SESSION);
    });
  }
});

test("gone reclamation respects an active run lease and a competing revision", async (t) => {
  for (const guard of ["lease", "revision"] as const) {
    await t.test(guard, async () => {
      resetBackgroundWorkStateForTest();
      restoreProviders?.();
      const k = fakeKv();
      stubPingableProvider({
        async get() { return { running: false, healthy: false, state: "absent" }; },
      });
      const countActiveShells = async () => { throw new Error("unreachable"); };
      await sweep({ kv: k.kv, countActiveShells });
      const kv = {
        ...k.kv,
        async get(key: string) {
          if (guard === "lease" && key === `lock.${SESSION}`) {
            return { value: sc.encode("{}"), revision: 1 };
          }
          return k.kv.get(key);
        },
        async delete(key: string, opts: { previousSeq?: number }) {
          k.replace({ ...k.current(), keepalive: true });
          return k.kv.delete(key, opts);
        },
      } as unknown as KV;
      await sweep({ kv, countActiveShells });
      assert.ok(!k.deleted.includes(KEY), `${guard} must prevent a gone verdict from deleting ownership`);
    });
  }
});

test("positive verdicts refresh before expiry without restarting the idle window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = fakeKv();
  stubPingableProvider();
  let probes = 0;
  const refresh = Promise.withResolvers<void>();
  const deps = {
    kv: k.kv,
    countActiveShells: async () => {
      probes += 1;
      if (probes === 2) await refresh.promise;
      return 0;
    },
  };
  await sweep(deps);
  const idleSince = k.current().idleSince;
  const firstMeasurement = k.current().bgCheckedAt;
  t.mock.timers.tick(4 * 60_000);
  try {
    await sweep(deps);
    assert.equal(probes, 2, "refresh must start while the five-minute verdict is still valid");
    assert.equal(k.current().bgCheckedAt, firstMeasurement, "the asynchronous refresh is pending");
    t.mock.timers.tick(30_000);
    await sweep(deps);
    assert.equal(k.current().idleSince, idleSince, "pending refresh keeps a valid positive verdict");
  } finally {
    refresh.resolve();
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(k.current().bgCheckedAt, Date.now());
  for (let minute = 0; minute < 12 && !k.deleted.includes(KEY); minute++) {
    t.mock.timers.tick(60_000);
    await sweep(deps);
    assert.equal(k.current().idleSince, idleSince);
  }
  assert.ok(k.deleted.includes(KEY), "repeated zero replies must complete the fifteen-minute window");
});

test("a failed refresh invalidates local and shared idle evidence immediately", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const k = fakeKv();
  stubPingableProvider();
  await sweep({ kv: k.kv, countActiveShells: async () => 0 });
  assert.equal(k.current().bgRunning, 0);
  t.mock.timers.tick(4 * 60_000);
  const pendingEvidence = Promise.withResolvers<void>();
  restoreProviders?.();
  stubPingableProvider({
    async get() {
      await pendingEvidence.promise;
      return { running: false, healthy: false, state: "unknown" };
    },
  });
  const deps = { kv: k.kv, countActiveShells: async () => { throw new Error("refresh failed"); } };
  try {
    await sweep(deps);
    assert.equal(k.current().bgRunning, undefined, "the failed refresh invalidates the shared zero");
    assert.equal(k.current().bgCheckedAt, undefined);
    await sweep(deps);
    assert.equal(k.current().idleSince, Date.now(), "the local zero cannot survive a failed refresh");
    assert.ok(!k.deleted.includes(KEY));
  } finally {
    pendingEvidence.resolve();
    await new Promise((r) => setImmediate(r));
  }
  resetBackgroundWorkStateForTest();
  t.mock.timers.tick(16 * 60_000);
  await sweep(deps);
  assert.ok(!k.deleted.includes(KEY), "a restarted replica must also see the failure as unknown");
});
