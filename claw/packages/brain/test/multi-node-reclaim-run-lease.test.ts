// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The reclaim sweeper deletes a user's GPU cluster, and nothing undoes it.
 *
 * It decides from the session entry alone: `keepalive:false` plus an `idleSince`
 * older than MULTI_NODE_IDLE_RECLAIM_MS (5 minutes by default, and the sweeper
 * runs unconditionally). That is a sound reading of a handle nobody is using --
 * but it is also the exact shape left behind when a reuse could not clear its
 * idle markers, and in that case a turn is running inside the sandbox right now.
 * clearIdleMarkers gives up on five different exits, every one of them logging
 * and returning, so the state is reachable without anything going badly wrong.
 *
 * The local registry cannot settle it: `registeredSandboxCount` is per-process,
 * and the replicas that are not running the session read zero. `lock.<sessionId>`
 * is the run lease, lives in this same bucket, and is the fleet-wide answer.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import { bindClusterReclaimForTest, sweepIdleMultiNodeClustersForTest } from "../src/sandbox/reaper.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { MULTI_NODE_IDLE_RECLAIM_MS } from "../src/config.js";
import { filterToRegExp } from "./nats-kv-stub.js";

const sc = StringCodec();
const SESSION = "sess-mn";

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

/** An entry that has been idle long enough to be reclaimable. */
function idleEntry(runScope?: string): Record<string, unknown> {
  return {
    ...(runScope ? { runScope } : {}),
    provider: "safe-workload",
    workloadId: "wl-1",
    platformKey: "pk",
    namespace: "ns",
    keepalive: false,
    idleSince: Date.now() - (MULTI_NODE_IDLE_RECLAIM_MS + 60_000),
  };
}

function kvWith(opts: {
  runLease: boolean; runScope?: string; leaseKey?: string; leaseReleased?: boolean;
}): KV {
  return {
    async keys(filter = ">") {
      const key = `hands.${SESSION}`;
      const matched = filterToRegExp(filter).test(key) ? [key] : [];
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      if (opts.runLease && key === `lock.${opts.leaseKey ?? SESSION}`) {
        // A released lease is deleted, and NATS answers a deleted key with a
        // readable entry carrying an empty value.
        return opts.leaseReleased
          ? { key, value: new Uint8Array(0), revision: 2, operation: "DEL" }
          : { key, value: sc.encode("{}"), revision: 1 };
      }
      if (key !== `hands.${SESSION}`) return null;
      return { key, value: sc.encode(JSON.stringify(idleEntry(opts.runScope))), revision: 3 };
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

test("an idle handle with no run behind it is reclaimed", async () => {
  // The negative half: without this the guard below could be passing because
  // the sweeper never reclaims anything.
  bindHandsKv(kvWith({ runLease: false }));
  const rec = recordReclaims();

  await sweepIdleMultiNodeClustersForTest();

  assert.deepEqual(rec.of(), [SESSION],
    "a genuinely idle session is what this sweeper exists to reclaim");
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
  // pickRunScope keys the lease by `dag_root_task_id` when there is one, so a
  // guard that looks under the session id finds nothing for exactly the runs
  // that own multi-node clusters -- the ones this sweeper deletes. The entry
  // carries the scope so the sweeper can ask the right question.
  const DAG_ROOT = "dag-root-7";
  bindHandsKv(kvWith({ runLease: true, runScope: DAG_ROOT, leaseKey: DAG_ROOT }));
  const rec = recordReclaims();

  await sweepIdleMultiNodeClustersForTest();

  assert.deepEqual(rec.of(), [],
    "the lease is under the DAG root; missing it deletes the cluster the DAG "
    + "is still training in");
});

test("an entry written before runScope existed still falls back to the session", async () => {
  // Older entries have no scope. Reading the session is what a single-node run
  // uses anyway, so the fallback must keep working rather than fail open.
  bindHandsKv(kvWith({ runLease: true }));
  const rec = recordReclaims();

  await sweepIdleMultiNodeClustersForTest();

  assert.deepEqual(rec.of(), [], "the session-keyed lease still has to be seen");
});

test("a lease that was released does not keep the sweeper away", async () => {
  // Every finished run leaves a tombstone behind, so reading `!!entry` as "a
  // run holds this" would put the sweeper to sleep after every task -- and the
  // guard exists to protect running work, not to switch reclaim off.
  bindHandsKv(kvWith({ runLease: true, leaseReleased: true }));
  const rec = recordReclaims();

  await sweepIdleMultiNodeClustersForTest();

  assert.deepEqual(rec.of(), [SESSION],
    "the lease is gone; the entry left by deleting it is not a running run");
});
