// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the two ownership questions cost, driven by a populated registry.
 *
 * Before a stop, this module asks the registry twice: does another DAG hold
 * this workload, and is it retained. Both are keyed by workload and the
 * registry is not, so both are answered by reading every candidate key. Both
 * are bounded by `SHARED_CHECK_TIMEOUT_MS`, and both take the same answer when
 * that bound expires -- decline to stop.
 *
 * That makes the cost a correctness property, not a performance note: past the
 * bound, every cancel in the fleet refuses to stop anything, the refusal is
 * indistinguishable from a real co-holder, and the workloads it refused to
 * stop keep their GPUs. The size that triggers it is the size of the registry,
 * which nothing announces -- the DAG handle bucket is created with `ttl: 0`
 * and the retention scan walks a key per live session.
 *
 * So these tests populate a registry instead of describing one, and assert on
 * what the teardown DID: whether the POST to SaFE was issued, and whether
 * every key that would have been read still was. A deadline that expires
 * proves itself -- the stop simply does not happen.
 *
 * The retention store is `infra/nats.kv`, a module binding `initNats` assigns
 * and no seam replaces, so the resolve hook swaps the nats module for this
 * file's fakes, for the import in `tasks/sandbox-stopper.ts` only.
 *
 * Coverage:
 *   C1 a shared-holder check over a large registry still issues the stop
 *   C2 a retention check over a large ledger still issues the stop
 *   C3 and a co-holder at the far end of that registry is still found
 *   C4 and a leader read that fails is still an unknown, not a "nobody"
 */
import { registerHooks } from "node:module";
import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { HandleInfo } from "@claw/protocol";

const STOPPER_MODULE = new URL("../src/tasks/sandbox-stopper.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === STOPPER_MODULE && specifier === "../infra/nats.js") {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

process.env.SAFE_API_URL = "http://safe.test";

const encoder = new TextEncoder();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** The retention ledger this file's fake bucket answers with. */
let ledgerKeys: string[] = [];
/** Round trip charged to every read, standing in for a network hop. */
let readLatencyMs = 0;
/** Every ledger key actually read, so a faster scan cannot be a shorter one. */
let ledgerReads: string[] = [];

export const kv = {
  async keys(filter: string): Promise<AsyncIterable<string>> {
    const keys = filter.startsWith("retention.") ? [...ledgerKeys] : [];
    return (async function* stream() { for (const key of keys) yield key; })();
  },
  async get(key: string): Promise<{ value: Uint8Array; revision: number }> {
    ledgerReads.push(key);
    await delay(readLatencyMs);
    // A retention protecting some OTHER container: the scan has to read every
    // one of these before it can answer "not retained" about ours.
    return {
      value: encoder.encode(JSON.stringify({ protected: true, workloadId: `w-other-${key}` })),
      revision: 1,
    };
  },
};
export const kvDagHandles = {} as Record<string, unknown>;
export const jsm = {} as Record<string, unknown>;
export const nc = { isClosed: (): boolean => false };
export const DAG_HANDLES_BUCKET = "DAG_HANDLES";

type Stopper = typeof import("../src/tasks/sandbox-stopper.js");
let stopper: Stopper;
let db: typeof import("../src/infra/db.js")["db"];

let originalRegistry: Record<string, unknown>;
const originalFetch = globalThis.fetch;
let stopped: string[];

before(async () => {
  ({ db } = await import("../src/infra/db.js"));
  stopper = await import("../src/tasks/sandbox-stopper.js");
  originalRegistry = { ...stopper.handleRegistry };
});

after(() => {
  Object.assign(stopper.handleRegistry, originalRegistry);
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  Object.assign(stopper.handleRegistry, originalRegistry);
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  ledgerKeys = [];
  ledgerReads = [];
  readLatencyMs = 0;
  stopped = [];
  // The record is not what these tests are about, and its real statements
  // would need a database. `mark` succeeding is the uninteresting case, which
  // is the one that lets the teardown reach the stop.
  stopper.unreleasedRecord.mark = async () => {};
  stopper.unreleasedRecord.clear = async () => {};
  stopper.unreleasedRecord.any = async () => false;
  db.query = (async () => ({ rows: [], rowCount: 0 })) as typeof db.query;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    stopped.push(/\/workloads\/([^/]+)\/stop$/.exec(url)?.[1] ?? url);
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
});

/** One handle, `w-1`, held by `dag-1` and destroyed for real when asked. */
function oneHandle(): void {
  let held: HandleInfo | null = { workload_id: "w-1" };
  stopper.handleRegistry.lookup = async () => held;
  stopper.handleRegistry.destroy = async () => {
    const wid = held?.workload_id ?? null;
    held = null;
    return wid;
  };
  stopper.handleRegistry.listAll = async () => [];
  stopper.handleRegistry.listForDag = async () => (held ? { main: held } : {});
  stopper.handleRegistry.listForDagConsistent = async () => ({});
  stopper.handleRegistry.listDagRoots = async () => ["dag-1"];
}

test("C1 a shared-holder check over a large registry still issues the stop", async () => {
  // 2000 DAG roots at 8ms a leader read is 16s of reads issued one after
  // another, against a ceiling of 10s -- so the check never finished, the
  // deadline expired, and the teardown declined to stop a workload nobody else
  // held. Nothing about that is visible as a failure: it is the same
  // `unconfirmed` a genuine co-holder produces.
  //
  // The bucket gets there on its own. It is created with no TTL, its rows go
  // only when a teardown removes them, and the orphan sweep -- the one path
  // that removes rows for DAGs nobody will cancel again -- could not remove
  // any at all until the `NoRecordHome` fix.
  oneHandle();
  const others = Array.from({ length: 2000 }, (_, i) => `dag-other-${i}`);
  const leaderReads: string[] = [];
  stopper.handleRegistry.listDagRoots = async () => ["dag-1", ...others];
  stopper.handleRegistry.listForDagConsistent = async (dag: string) => {
    leaderReads.push(dag);
    await delay(8);
    return {};
  };

  const started = process.hrtime.bigint();
  const released = await stopper.stopSandboxByHandle("dag-1", "main", "s-1");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.deepEqual(
    stopped, ["w-1"],
    `the stop has to be issued: nobody else holds this workload (check took ${Math.round(elapsedMs)}ms)`,
  );
  assert.equal(released, "confirmed");
  assert.equal(
    leaderReads.length, others.length,
    "and every other DAG is still leader-read -- faster must not mean fewer",
  );
});

test("C2 a retention check over a large ledger still issues the stop", async () => {
  // The same shape, one gate along: `retained` reads every retention record
  // there is, per handle, per stop, under the same ten seconds. 1500 records
  // at 8ms is 12s of reads, and the catch above it turns an expired deadline
  // into a teardown that issues nothing -- here, on the provider this fleet
  // actually runs, a real SaFE workload left running.
  //
  // `retained` is NOT stubbed here: it is the code under test, reading the
  // fake bucket this file exports in place of `infra/nats`.
  oneHandle();
  ledgerKeys = Array.from({ length: 1500 }, (_, i) => `retention.gen-${i}`);
  readLatencyMs = 8;

  const started = process.hrtime.bigint();
  const released = await stopper.stopSandboxByHandle("dag-1", "main", "s-1");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.deepEqual(
    stopped, ["w-1"],
    `nothing retained names this workload, so it is this teardown's to stop `
      + `(check took ${Math.round(elapsedMs)}ms)`,
  );
  assert.equal(released, "confirmed");
  assert.deepEqual(
    [...new Set(ledgerReads)].sort(), [...ledgerKeys].sort(),
    "and every retention record is still read -- a scan that answers by reading less is not the same scan",
  );
});

test("C3 and a co-holder at the far end of that registry is still found", async () => {
  // The control the other two need. Both assert that a stop DID happen, so
  // both would pass just as well if the check had been deleted; this is the
  // half that fails if the parallel scan ever loses an answer. The holder is
  // the LAST root enumerated, which is the one a short-circuit reaches last.
  oneHandle();
  const others = Array.from({ length: 40 }, (_, i) => `dag-other-${i}`);
  const holder = others[others.length - 1] as string;
  stopper.handleRegistry.listDagRoots = async () => ["dag-1", ...others];
  stopper.handleRegistry.listForDagConsistent = async (dag: string) => {
    await delay(1);
    return dag === holder ? { main: { workload_id: "w-1" } } : {};
  };

  const released = await stopper.stopSandboxByHandle("dag-1", "main", "s-1");

  assert.deepEqual(stopped, [], "a workload another DAG holds is not this one's to stop");
  assert.equal(released, "unconfirmed");
});

test("C4 and a leader read that fails is still an unknown, not a nobody", async () => {
  // The other half of what running the reads together must not change. A read
  // that fails is no evidence a workload was released, so it has to reach the
  // caller as a rejection -- not be swallowed by a sibling read that came back
  // empty and happened to finish first.
  oneHandle();
  const others = Array.from({ length: 40 }, (_, i) => `dag-other-${i}`);
  stopper.handleRegistry.listDagRoots = async () => ["dag-1", ...others];
  stopper.handleRegistry.listForDagConsistent = async (dag: string) => {
    await delay(1);
    if (dag === others[20]) throw new Error("nats: no responders");
    return {};
  };

  const released = await stopper.stopSandboxByHandle("dag-1", "main", "s-1");

  assert.deepEqual(
    stopped, [],
    "one unreadable DAG means sole ownership was not established, whoever else answered",
  );
  assert.equal(released, "unconfirmed");
});
