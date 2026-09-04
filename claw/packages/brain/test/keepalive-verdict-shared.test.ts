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
  backgroundWorkStateSizesForTest, ageBackgroundWorkCacheForTest,
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
  // five consecutive failures settle it to idle locally. A failed probe caches
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
