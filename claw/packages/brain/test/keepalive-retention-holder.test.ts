// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Letting a retention go must not take a sibling DAG's only reference with it.
 *
 * `retainInsteadOfDestroying` grew a `releaseHandles` parameter so the
 * displaced-sandbox path could hand a container to the retention store WITHOUT
 * freeing the handles naming it -- that path is reached exactly when another
 * DAG may still hold the workload, and `releaseHandlesForWorkload` frees EVERY
 * DAG's handle on it. The parameter protected the call that took the retention.
 * It protected nothing after it: when the background work in the retained
 * container finally finished and the keepalive sweep read `clear`, the sweep
 * freed the handles unconditionally. The sibling's run lease was still valid,
 * its handle was deleted, and its next `sandbox.use` node had nothing left to
 * resolve.
 *
 * So the assertions here are the sibling's outcome and not a flag: whether the
 * handle survived the sweep, and whether the node that comes next can still
 * resolve it through the very map `sandbox.use` reads. The map is the real
 * `DagHandleMap` over an in-memory bucket, so `lookup` is the production
 * resolution and not a re-implementation of it.
 *
 * The control is the other half, and it is the half a guard can silently break:
 * a retained container NOBODY holds must still be released and collected, or
 * the guard has recreated the unbounded retention the release exists to end.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import { DagHandleMap } from "@claw/protocol";
import { InMemoryKVStore } from "@claw/utils";
import { ledgerKeyForRetention, retentionKey } from "../src/sandbox/retain-container.js";
import {
  runKeepaliveTickForTest, resetBackgroundWorkStateForTest,
} from "../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { bindContainerProbeEffects } from "../src/sandbox/container-probe.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();

const GENERATION = "sb-generation-shared";
const KEY = retentionKey(GENERATION);
const LEDGER = ledgerKeyForRetention(KEY);
/** The container DAG A is running on and DAG B walked away from. */
const WORKLOAD = "wl-shared";
const SIBLING_DAG = "dag-a-root";
const SIBLING_HANDLE = "trainer";

const RETAINED = {
  status: "ready",
  provider: "safe-workload",
  workloadId: WORKLOAD,
  platformKey: "pk",
  namespace: "ns",
  handsUrl: "http://sandbox:9100/mcp",
  token: "tok",
  sandboxName: GENERATION,
  protected: true,
  reason: "protected",
  detail: "live_work_present",
  keepalive: false,
  idleSince: 0,
};

/**
 * What the container answers the live-work read with: a marker, a state dir
 * with no `scopes/` under it, and a readable process table. That is the shape
 * `countLiveWork` calls `clear` -- the verdict that lets the retention go, and
 * so the only fixture in which this defect is reachable at all.
 */
const CLEAR_STATE = [
  'MARKER {"epoch":"e-1","bearer":{"pid":1,"startToken":"tok-1"}}',
  "SUBTREE empty",
  "PROCS 1 2 3",
  "",
].join("\n");

let restore: Array<() => void> = [];

afterEach(() => {
  resetBackgroundWorkStateForTest();
  for (const undo of restore.splice(0).reverse()) undo();
});

/** Pings succeed; the live-work read answers `clear`. */
function stubContainer(): void {
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, healthy: true }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restore.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
  restore.push(bindContainerProbeEffects({
    exec: async () => ({ exitCode: 0, stdout: CLEAR_STATE, stderr: "" }),
  }));
}

/** The retention's two halves, in the keyspace the sweep walks. */
function fakeKv(): { kv: KV; deleted: string[] } {
  const deleted: string[] = [];
  const kv = {
    async keys(filter = ">") {
      const matched = filterToRegExp(filter).test(KEY) && !deleted.includes(KEY) ? [KEY] : [];
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      if (deleted.includes(key)) return null;
      if (key === KEY) {
        return { key, value: sc.encode(JSON.stringify(RETAINED)), revision: 5 };
      }
      if (key === LEDGER) {
        return { key, value: sc.encode(JSON.stringify(RETAINED)), revision: 9 };
      }
      return null;
    },
    async delete(key: string) { deleted.push(key); },
    async put() { return 1; },
    async update(_key: string, _v: unknown, revision: number) { return revision + 1; },
  } as unknown as KV;
  return { kv, deleted };
}

/**
 * The DAG handle table, and the two operations the sweep reaches it through.
 *
 * `release` is the stand-in for `releaseHandlesForWorkload` -- the real one
 * needs JetStream, which is why the sweep carries the seam -- and it matches
 * rows the same way: by `workload_id`, every DAG, unconditionally. That is the
 * behaviour under test, so the stub must not be gentler than the thing it
 * stands for.
 */
function handleTable(): {
  map: DagHandleMap;
  listDagHandles: () => Promise<Array<[string, Record<string, import("@claw/protocol").HandleInfo>]>>;
  releaseDagHandles: (workloadId: string) => Promise<void>;
  releases: string[];
} {
  const map = new DagHandleMap(new InMemoryKVStore());
  const releases: string[] = [];
  return {
    map,
    listDagHandles: () => map.listAll(),
    releaseDagHandles: async (workloadId: string) => {
      releases.push(workloadId);
      for (const [dagRoot, handles] of await map.listAll()) {
        for (const [name, info] of Object.entries(handles)) {
          if (info.workload_id === workloadId) await map.destroy(dagRoot, name);
        }
      }
    },
    releases,
  };
}

/** What DAG A's next node does: resolve its handle and run on what it names. */
async function siblingNextNodeSandboxUse(map: DagHandleMap): Promise<string> {
  const info = await map.lookup(SIBLING_DAG, SIBLING_HANDLE);
  if (!info) throw new Error("sandbox.use: handle 'trainer' is not registered for this DAG");
  if (!info.workload_id) throw new Error("sandbox.use: handle names no workload");
  return info.workload_id;
}

test("a retained container a live sibling still holds keeps its handle", async () => {
  // DAG B displaced this container and retained it rather than dropping the
  // evidence; DAG A holds a handle on the same workload and is between nodes,
  // so nothing is running inside the container and the live-work read answers
  // `clear`. That verdict is about processes, not about holders.
  const { kv, deleted } = fakeKv();
  const table = handleTable();
  await table.map.create(SIBLING_DAG, SIBLING_HANDLE, {
    workload_id: WORKLOAD, hands_url: "http://sandbox:9100/mcp", token: "tok",
    platform_key: "pk", namespace: "ns", provider: "safe-workload",
  });
  stubContainer();

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => 0,
    listDagHandles: table.listDagHandles,
    releaseDagHandles: table.releaseDagHandles,
  });

  assert.equal(
    await siblingNextNodeSandboxUse(table.map), WORKLOAD,
    "the sibling's next sandbox.use node must still resolve the sandbox it is running on",
  );
  assert.deepEqual(
    table.releases, [],
    "a release that frees every DAG's handle must not be issued for a container a DAG holds",
  );
  // The ledger is what `mayTakeFrom`/`retainedTaker` reads to let a later
  // registration take the name back from a handed-over workload. Deleting it
  // while a handle still names the workload strands that handle with nothing
  // behind it, so the records stay with the handle they back.
  assert.ok(
    !deleted.includes(LEDGER) && !deleted.includes(KEY),
    `the retention backing a held handle was released; deleted=${JSON.stringify(deleted)}`,
  );
});

test("a retained container nobody holds is still released and collected", async () => {
  // The control. A guard that never releases recreates the leak the retention
  // scheme exists to bound: the container is held against admission by a record
  // no sweep retires, which is the state this phase was added to end.
  const { kv, deleted } = fakeKv();
  const table = handleTable();
  stubContainer();

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => 0,
    listDagHandles: table.listDagHandles,
    releaseDagHandles: table.releaseDagHandles,
  });

  assert.deepEqual(
    table.releases, [WORKLOAD],
    "with nobody holding it the handle release still runs",
  );
  assert.deepEqual(
    deleted, [LEDGER, KEY],
    `the unheld retention was not released; deleted=${JSON.stringify(deleted)}`,
  );
});

test("a handle held by another DAG defers the release rather than refusing it", async () => {
  // The kept retention is not a permanent one. The holder set shrinks -- the
  // DAG's own teardown frees its handle, and api's `reapOrphanHandles` destroys
  // the mapping of a terminal DAG without stopping a retained container -- and
  // the first sweep that finds the last handle gone releases both halves.
  const { kv, deleted } = fakeKv();
  const table = handleTable();
  await table.map.create(SIBLING_DAG, SIBLING_HANDLE, {
    workload_id: WORKLOAD, hands_url: "http://sandbox:9100/mcp", token: "tok",
    platform_key: "pk", namespace: "ns", provider: "safe-workload",
  });
  stubContainer();
  const deps = {
    kv,
    countActiveShells: async () => 0,
    listDagHandles: table.listDagHandles,
    releaseDagHandles: table.releaseDagHandles,
  };

  await runKeepaliveTickForTest(deps);
  assert.deepEqual(deleted, [], "held: nothing released on the first sweep");

  // DAG A lets go, by whichever of the two paths gets there first.
  await table.map.destroy(SIBLING_DAG, SIBLING_HANDLE);
  await runKeepaliveTickForTest(deps);

  assert.deepEqual(
    deleted, [LEDGER, KEY],
    `the retention was not released once its last holder let go; deleted=${JSON.stringify(deleted)}`,
  );
});

test("a handle table that cannot be read is not a table with nothing in it", async () => {
  // Unreadable is not unheld. A scan that threw used to be the one thing that
  // could not licence a delete, and it still is: the retention stands and the
  // next sweep asks again.
  const { kv, deleted } = fakeKv();
  const table = handleTable();
  stubContainer();

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => 0,
    listDagHandles: async () => { throw new Error("JetStream unavailable"); },
    releaseDagHandles: table.releaseDagHandles,
  });

  assert.deepEqual(table.releases, [], "no release is issued on a question that was not answered");
  assert.deepEqual(deleted, [], `the retention was released anyway; deleted=${JSON.stringify(deleted)}`);
});
