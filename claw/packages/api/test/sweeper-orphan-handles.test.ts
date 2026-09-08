// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the orphan-handle sweep is allowed to destroy.
 *
 * It walked the registry bucket for `dag-handles.*` keys. Brain writes those
 * rows to `DAG_HANDLES`, so the walk enumerated an empty map and the sweep
 * reaped nothing -- silently, because no rows and no orphans look the same from
 * inside it. Measured on a live cluster: 103 handle rows, 96 of them naming a
 * workload that no longer existed, the oldest a week old. Those rows are a
 * keepalive census target apiece, and the roster admission is decided against
 * carried every one of them, so the fleet refused every new sandbox against a
 * count made almost entirely of rows nothing had ever been able to reap.
 *
 * Pointing it at the right bucket is most of the fix and all of the danger: the
 * criterion it reaches with -- a DAG root that reads terminal, or whose row was
 * never written and so reads `missing` -- had never once run against real rows.
 * A chat run's sandbox is held warm for reuse after the run completes, and both
 * live sandboxes on that cluster read `completed` *and* `missing`. Turning the
 * sweep on without a liveness gate would have destroyed them.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import { reapOrphanHandles, sweeperPorts } from "../src/tasks/sweeper.js";
import * as stopper from "../src/tasks/sandbox-stopper.js";
import { resetHandleMapForTest, stopperPorts } from "../src/tasks/sandbox-stopper.js";
import { dagHandlesBucket } from "../src/infra/dag-handles.js";
import type { HandleInfo } from "@claw/protocol";

const originalQuery = db.query;
const originalList = sweeperPorts.listDagHandles;
const originalLive = sweeperPorts.liveWorkloadIds;
after(() => {
  db.query = originalQuery;
  sweeperPorts.listDagHandles = originalList;
  sweeperPorts.liveWorkloadIds = originalLive;
});

const handle = (workloadId: string): Record<string, HandleInfo> => ({
  main: {
    workload_id: workloadId,
    hands_url: `http://${workloadId}:9100/mcp`,
    token: "t",
    platform_key: "pk",
    namespace: "ns",
  } as HandleInfo,
});

/** Every DAG root reads `missing`, which is the live cluster's own shape. */
function stubDbMissingRoots(): void {
  db.query = (async () => ({ rows: [], rowCount: 0 })) as unknown as typeof db.query;
}

function stubHandles(rows: Array<[string, Record<string, HandleInfo>]>, live: string[]): void {
  sweeperPorts.listDagHandles = async () => rows;
  sweeperPorts.liveWorkloadIds = async () => new Set(live);
}

/** A stand-in DAG_HANDLES bucket; returns the keys the sweep deleted from it. */
function fakeBucket(rows: Array<[string, Record<string, HandleInfo>]>): {
  deleted: string[]; restore: () => void;
} {
  const enc = new TextEncoder();
  const store = new Map<string, Uint8Array>(
    rows.map(([dag, h]) => [`dag-handles.${dag}`, enc.encode(JSON.stringify(h))]),
  );
  const deleted: string[] = [];
  const original = stopperPorts.dagHandlesBucket;
  stopperPorts.dagHandlesBucket = (async () => ({
    async get(key: string) {
      const value = store.get(key);
      return value ? { value } : null;
    },
    async put(key: string, value: Uint8Array) { store.set(key, value); return 1; },
    async delete(key: string) { deleted.push(key); store.delete(key); },
    async keys() { return store.keys(); },
  })) as unknown as typeof stopperPorts.dagHandlesBucket;
  resetHandleMapForTest();
  return {
    deleted,
    restore: () => { stopperPorts.dagHandlesBucket = original; resetHandleMapForTest(); },
  };
}

test("a handle naming a workload Brain still holds is never reaped", async () => {
  // Both of these read terminal-or-missing; only the census says which is live.
  // Reaping the live one tears a warm sandbox out from under a session that is
  // still using it -- which is what both live sandboxes on the cluster this was
  // measured on would have got, because both read `completed` and `missing`.
  stubDbMissingRoots();
  stubHandles([["dag-live", handle("wl-live")], ["dag-dead", handle("wl-dead")]], ["wl-live"]);
  const bucket = fakeBucket([["dag-live", handle("wl-live")], ["dag-dead", handle("wl-dead")]]);
  try {
    assert.equal(await reapOrphanHandles(), 1, "one orphan, and only one");
  } finally {
    bucket.restore();
  }
  assert.deepEqual(bucket.deleted, ["dag-handles.dag-dead"],
    "the live sandbox's row survives; only the orphan's is deleted");
});

test("no live workload anywhere is not evidence that none is running", async () => {
  // The registry bucket expires its rows, so a Brain that stopped renewing them
  // looks exactly like a fleet at rest. Acting on that reading destroys every
  // sandbox in the fleet; skipping costs one tick of cleanup.
  stubDbMissingRoots();
  stubHandles([["dag-a", handle("wl-a")], ["dag-b", handle("wl-b")]], []);

  assert.equal(await reapOrphanHandles(), 0,
    "a census that names nothing must reap nothing");
});

test("the handle map is built over the bucket Brain writes handle rows to", async () => {
  // The defect this file exists for. Built over the registry bucket, listAll()
  // returned an empty array on every cluster that has ever run, and the sweep
  // reported a clean pass forever -- so the assertion has to be that the reads
  // and the delete land on the bucket that was bound, not merely that the call
  // returned.
  assert.equal(stopperPorts.dagHandlesBucket, dagHandlesBucket,
    "the default port is the DAG_HANDLES binder, not the registry KV");

  const enc = new TextEncoder();
  const rows = new Map<string, Uint8Array>([
    ["dag-handles.dag-x", enc.encode(JSON.stringify(handle("wl-x")))],
  ]);
  const deleted: string[] = [];
  const original = stopperPorts.dagHandlesBucket;
  stopperPorts.dagHandlesBucket = (async () => ({
    async get(key: string) {
      const value = rows.get(key);
      return value ? { value } : null;
    },
    async put(key: string, value: Uint8Array) { rows.set(key, value); return 1; },
    async delete(key: string) { deleted.push(key); rows.delete(key); },
    async keys() { return rows.keys(); },
  })) as unknown as typeof stopperPorts.dagHandlesBucket;
  resetHandleMapForTest();
  try {
    await stopper.stopAllHandlesForDag("dag-x", "s-1");
  } finally {
    stopperPorts.dagHandlesBucket = original;
    resetHandleMapForTest();
  }

  assert.deepEqual(deleted, ["dag-handles.dag-x"],
    "the row is read and deleted through the bound bucket");
});
