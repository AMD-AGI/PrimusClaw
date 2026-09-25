// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The reclaim sweeper deletes a user's GPU cluster after a session delete.
 *
 * Ordinary idle parks cascade from destroyHands after the sandbox stops. This
 * sweeper only picks sessionDeleted parks. It still must honour the run lease:
 * a reuse that left keepalive:false can look idle while a turn is in flight.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import { bindClusterReclaimForTest, sweepIdleMultiNodeClustersForTest } from "../src/sandbox/reaper.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { filterToRegExp } from "./nats-kv-stub.js";

const sc = StringCodec();
const SESSION = "sess-mn";

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

/** A session-delete park the orphan sweeper is allowed to reclaim. */
function deletedEntry(runScope?: string): Record<string, unknown> {
  return {
    ...(runScope ? { runScope } : {}),
    provider: "safe-workload",
    workloadId: "wl-1",
    platformKey: "pk",
    namespace: "ns",
    keepalive: false,
    sessionDeleted: true,
    idleSince: Date.now(),
  };
}

function kvWith(opts: {
  runLease: boolean; runScope?: string; leaseKey?: string; leaseReleased?: boolean;
  sessionDeleted?: boolean;
}): KV {
  return {
    async keys(filter = ">") {
      const key = `hands.${SESSION}`;
      const matched = filterToRegExp(filter).test(key) ? [key] : [];
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      if (opts.runLease && key === `lock.${opts.leaseKey ?? SESSION}`) {
        return opts.leaseReleased
          ? { key, value: new Uint8Array(0), revision: 2, operation: "DEL" }
          : { key, value: sc.encode("{}"), revision: 1 };
      }
      if (key !== `hands.${SESSION}`) return null;
      const entry = deletedEntry(opts.runScope);
      if (opts.sessionDeleted === false) delete entry.sessionDeleted;
      return { key, value: sc.encode(JSON.stringify(entry)), revision: 3 };
    },
    async put() { return 1; },
    async update() { return 4; },
    async delete() {},
  } as unknown as KV;
}

function recordReclaims(): { of: () => string[] } {
  const seen: string[] = [];
  restore = bindClusterReclaimForTest(async (sessionId: string) => { seen.push(sessionId); return 1; });
  return { of: () => seen };
}

test("a session-deleted handle with no run behind it is reclaimed", async () => {
  bindHandsKv(kvWith({ runLease: false }));
  const rec = recordReclaims();

  await sweepIdleMultiNodeClustersForTest();

  assert.deepEqual(rec.of(), [SESSION],
    "a deleted session is what this sweeper exists to reclaim");
});

test("an ordinary idle park is not reclaimed by the orphan sweeper", async () => {
  bindHandsKv(kvWith({ runLease: false, sessionDeleted: false }));
  const rec = recordReclaims();

  await sweepIdleMultiNodeClustersForTest();

  assert.deepEqual(rec.of(), [],
    "idle sandbox reclaim cascades from destroyHands; this sweeper must not steal");
});

test("a session with a run in flight is not reclaimed, whatever its entry says", async () => {
  bindHandsKv(kvWith({ runLease: true }));
  const rec = recordReclaims();

  await sweepIdleMultiNodeClustersForTest();

  assert.deepEqual(rec.of(), [],
    "the entry reads idle only because a reuse could not clear its markers; "
    + "reclaiming here deletes the cluster the running turn is using, and no "
    + "later pass brings it back");
});

test("a DAG run is protected by the lease under its root, not its session", async () => {
  const DAG_ROOT = "dag-root-7";
  bindHandsKv(kvWith({ runLease: true, runScope: DAG_ROOT, leaseKey: DAG_ROOT }));
  const rec = recordReclaims();

  await sweepIdleMultiNodeClustersForTest();

  assert.deepEqual(rec.of(), [],
    "the lease is under the DAG root; missing it deletes the cluster the DAG "
    + "is still training in");
});

test("an entry written before runScope existed still falls back to the session", async () => {
  bindHandsKv(kvWith({ runLease: true }));
  const rec = recordReclaims();

  await sweepIdleMultiNodeClustersForTest();

  assert.deepEqual(rec.of(), [], "the session-keyed lease still has to be seen");
});

test("a lease that was released does not keep the sweeper away", async () => {
  bindHandsKv(kvWith({ runLease: true, leaseReleased: true }));
  const rec = recordReclaims();

  await sweepIdleMultiNodeClustersForTest();

  assert.deepEqual(rec.of(), [SESSION],
    "the lease is gone; the entry left by deleting it is not a running run");
});
