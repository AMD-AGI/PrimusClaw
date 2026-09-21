// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * D1 from the brain side: the sandbox a session MOVES OFF keeps the evidence
 * that work is still running in it.
 *
 * The shape, which reproduced against real Postgres/NATS with a background
 * shell genuinely running when the stop went out: T1 finishes on W1 with a
 * background shell still in it. T2 changes the image, so `evaluateReuse` says
 * rebuild; `entryOwnedByAnother` says W1 is not T2's to stop, which is right;
 * and the branch then answered that with a bare `return null`. The caller goes
 * on to create W2 and writes ITS binding over `hands.<session>` with an
 * unconditional put -- one slot per session -- and from that instant nothing
 * can answer for W1. The API's background-work guard reads the slot, is handed
 * a binding about W2, says `other_sandbox`, and the orphan sweep stops W1 with
 * the user's shell inside it.
 *
 * What the API side pins is the other half of the same claim:
 * `packages/api/test/orphan-sweep-displaced-sandbox.test.ts` (D1/D2) drives the
 * real `reapOrphanHandles` and shows that a retention record over the displaced
 * workload is what keeps it, and that without one the same sweep stops it. That
 * test cannot write the record -- Brain writes it -- which is what these tests
 * are: the record really is written, by the production reuse path, keyed so
 * that the reader over there finds it.
 *
 * Every assertion below is about what happened to the container, never about a
 * branch: whether a stop was issued against W1, and whether the background
 * shell that was running in it is still running afterwards. The fleet models a
 * stop the way stopping a SaFE workload behaves -- it takes the container's
 * shells with it -- and the live-work count is read out of that same modelled
 * state, so the thing the count reports and the thing a stop destroys are one
 * variable and cannot drift apart.
 *
 * Coverage:
 *   R1 a displaced sandbox with a shell running in it survives the sweep
 *   R2 CONTROL: one with nothing running is still discarded (the rebuild that
 *      legitimately should let go of the old sandbox still does)
 *   R3 the same, on the unhealthy-rebuild branch
 *   R4 the hand-over does not take a handle this turn was told it may not touch
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import { isRetentionEntry } from "@claw/protocol";

import {
  bindSandboxReuseEffects,
  requestSpecFingerprint,
  tryReuseSessionSandbox,
} from "../src/sandbox/ensure-hands.js";
import { resolveSandboxAction } from "../src/sandbox/params.js";
import { handsSessionKey } from "../src/sandbox/hands-key.js";
import { retentionStore } from "../src/sandbox/registry.js";
import { RETENTION_LEDGER_FILTER, retentionKey } from "../src/sandbox/retain-container.js";
import { matchesKvFilter } from "./fixtures/kv-filter.js";

const realFetch = globalThis.fetch;
let restoreEffects: (() => void) | null = null;
afterEach(() => {
  globalThis.fetch = realFetch;
  restoreEffects?.();
  restoreEffects = null;
});

/* ------------------------------------------------------------------ store */

/** JetStream's answer to a conditional write that lost, which is what the
 *  retention store's own `create` classifies on. A stub that threw anything
 *  else would turn a routine collision into a failed retention. */
function conflict(): Error {
  return new Error("wrong last sequence: 3");
}

interface Store { kv: KV; map: Map<string, { value: Uint8Array; revision: number }>; }

/** The registry bucket, with only the operations these paths actually use. */
function memoryKv(seed: Record<string, unknown> = {}): Store {
  const enc = new TextEncoder();
  const map = new Map<string, { value: Uint8Array; revision: number }>(
    Object.entries(seed).map(([k, v]) => [k, { value: enc.encode(JSON.stringify(v)), revision: 3 }]),
  );
  const kv = {
    async get(key: string) {
      const held = map.get(key);
      return held ? { key, value: held.value, revision: held.revision, operation: "PUT" } : null;
    },
    async put(key: string, value: Uint8Array) {
      const revision = (map.get(key)?.revision ?? 0) + 1;
      map.set(key, { value, revision });
      return revision;
    },
    async create(key: string, value: Uint8Array) {
      if (map.has(key)) throw conflict();
      map.set(key, { value, revision: 1 });
      return 1;
    },
    async update(key: string, value: Uint8Array, revision: number) {
      if (map.get(key)?.revision !== revision) throw conflict();
      map.set(key, { value, revision: revision + 1 });
      return revision + 1;
    },
    async delete(key: string) { map.delete(key); },
    async keys(filter = ">") {
      const matched = [...map.keys()].filter((k) => matchesKvFilter(k, filter));
      return (async function* () { for (const k of matched) yield k; })();
    },
  };
  return { kv: kv as unknown as KV, map };
}

/* ------------------------------------------------------------------ fleet */

/**
 * The sandboxes and what the user left running inside each one.
 *
 * `stops` is every workload a stop was actually issued against, in order.
 * `shells` is the background work still alive per workload, and a stop zeroes
 * it -- so "the work survived" is a fact about the fleet rather than a fact
 * about which branch ran.
 */
interface Fleet { stops: string[]; shells: Map<string, number>; }

function stop(fleet: Fleet, workloadId: string): void {
  fleet.stops.push(workloadId);
  fleet.shells.set(workloadId, 0);
}

/**
 * What the API's orphan sweep does with a workload whose DAG is over.
 *
 * Not a re-implementation of that sweep -- it is driven for real next door, in
 * `packages/api/test/orphan-sweep-displaced-sandbox.test.ts` -- but of the ONE
 * question it asks before the stop, over the real records this side writes:
 * `handleRegistry.retained` (api/src/tasks/sandbox-stopper.ts) scans the
 * retention ledger and its projection, keeps the entries that are retention
 * records, and matches their `workloadId` against the one it was asked about.
 * Read through the same `retentionStore` and the same `isRetentionEntry` the
 * two sides share, so a record written under a key or a shape that reader does
 * not accept fails here too rather than passing on a stub's say-so.
 */
async function sweepOrphan(kv: KV, fleet: Fleet, workloadId: string): Promise<void> {
  const store = retentionStore(kv);
  const seen: string[] = [
    ...await store.keys(RETENTION_LEDGER_FILTER),
    ...(await store.keys("hands.*")).filter((k) => k.startsWith("hands.retained-")),
  ];
  for (const key of seen) {
    const held = await store.read(key);
    if (!held) continue;
    const record = JSON.parse(held.value) as { workloadId?: string };
    if (isRetentionEntry(record) && record.workloadId === workloadId) return;
  }
  stop(fleet, workloadId);
}

/* --------------------------------------------------------------- fixtures */

const SESSION = "s-1";
/** T2's request: a different image from the one W1 was built to. */
const T2: ExecuteRequest = {
  session_id: SESSION,
  prompt: "carry on",
  sandbox_image: "example.io/torch:2.5",
  task_id: "t-2",
  dag_root_task_id: "dag-t2",
};

function specOf(request: ExecuteRequest): string {
  const action = resolveSandboxAction(request);
  assert.equal(action.kind, "create", "this fixture has to describe a sandbox to build");
  return requestSpecFingerprint(request, action as never);
}

/** The endpoint W1's shells record as their generation, and so the only key a
 *  retention over it may take -- see `retentionGeneration`. */
const W1_URL = "http://hands-1.test:9100/mcp";

/**
 * T1's sandbox, as the create path recorded it: READY, T1's DAG, and built to
 * an image T2 is no longer asking for.
 */
function w1Binding(): Record<string, unknown> {
  return {
    status: "ready",
    taskId: "t-1",
    dagRootTaskId: "dag-t1",
    runScope: "lock.session.s-1",
    provider: "safe-workload",
    workloadId: "w-1",
    handsUrl: W1_URL,
    sandboxImage: "example.io/torch:2.4",
    // Parses, and does not match what T2 asks for: the shape `evaluateReuse`
    // actually refuses on. A non-fingerprint string reads as unknown and reuses.
    specFingerprint: specOf(T2).replace(/:[0-9a-f]+$/, ":ffffffffffffffff"),
    platformKey: "pk-1",
    token: "tok-1",
    namespace: "ns-1",
    createdAt: new Date().toISOString(),
  };
}

interface Effects {
  /** Workloads whose DAG handles were released by the reuse path. */
  released: string[];
}

/**
 * Bind the effects, with the live-work count read out of the fleet.
 *
 * `retainContainer` is deliberately NOT stubbed: the record it writes, and the
 * key it writes it under, are the whole claim.
 */
function stubEffects(fleet: Fleet, over: {
  probe?: "alive" | "dead" | "unknown";
  restartRefused?: boolean;
} = {}): Effects {
  const effects: Effects = { released: [] };
  restoreEffects = bindSandboxReuseEffects({
    destroyHands: (async (_sessionId: string, known?: { workloadId?: string }) => {
      if (known?.workloadId) stop(fleet, known.workloadId);
    }) as never,
    registerSandbox: (() => {}) as never,
    probeSandboxContainer: async () => ({
      verdict: over.probe ?? "alive", reason: "exec_ok" as const,
    }),
    restartHandsInSandbox: async () => (over.restartRefused
      ? { ok: false, detail: "kill switch off", refused: true }
      : { ok: true, detail: "healthy" }),
    releaseHandlesForWorkload: (async (id: string) => { effects.released.push(id); }) as never,
    // T2's DAG holds no handle on W1 and never did; T1's DAG still does, which
    // is what makes W1 "not this turn's to stop".
    dagHoldsWorkload: (async () => false) as never,
    workloadHeldByOtherDag: (async () => true) as never,
    // The count the gate takes, over the container rather than over Hands --
    // and out of the same shell tally a stop would destroy.
    countLiveWork: (async (inst: { id?: string }) => {
      const alive = fleet.shells.get(inst?.id ?? "") ?? 0;
      return alive > 0
        ? { verdict: "protected" as const, classes: { background: alive }, reason: "live_work_present" }
        : { verdict: "clear" as const, classes: {}, reason: "no_live_work" };
    }) as never,
  });
  return effects;
}

function attempt(kv: KV, request: ExecuteRequest = T2) {
  return {
    kv,
    sessionId: SESSION,
    request,
    requestedSpec: specOf(request),
    onEvent: async () => {},
  } as Parameters<typeof tryReuseSessionSandbox>[0];
}

/** The caller's very next act once reuse says no: create W2 and put its
 *  binding on the session's one slot. Unconditional, exactly as the create
 *  path's own write is. */
async function bindW2(store: Store): Promise<void> {
  await store.kv.put(
    handsSessionKey(SESSION),
    new TextEncoder().encode(JSON.stringify({
      status: "ready", taskId: "t-2", dagRootTaskId: "dag-t2",
      workloadId: "w-2", handsUrl: "http://hands-2.test:9100/mcp",
    })),
  );
}

/* ------------------------------------------------------------------ tests */

test("R1 a displaced sandbox keeps the shell running in it when the slot moves", async () => {
  const fleet: Fleet = { stops: [], shells: new Map([["w-1", 1], ["w-2", 0]]) };
  const effects = stubEffects(fleet);
  const store = memoryKv({ [handsSessionKey(SESSION)]: w1Binding() });

  assert.equal(
    await tryReuseSessionSandbox(attempt(store.kv)), null,
    "T2 cannot reuse a sandbox built to another image, and builds its own",
  );
  await bindW2(store);
  await sweepOrphan(store.kv, fleet, "w-1");

  assert.deepEqual(
    fleet.stops, [],
    "W1 still holds the user's background shell, and the record that says so "
    + "outlived the session slot that used to carry it",
  );
  assert.equal(fleet.shells.get("w-1"), 1, "so the shell is still running");
  assert.deepEqual(
    effects.released, [],
    "and the handle T1's DAG still holds on W1 was not taken from it: this turn "
    + "was just told the workload is not its to stop",
  );

  // Addressability, which is what the key is for: a shell's row records the
  // endpoint as its generation, so a retention under any other key is a
  // container no poll, wait or kill can route back to.
  const held = await retentionStore(store.kv).read(retentionKey(W1_URL));
  assert.ok(held, "the retention is keyed by the generation W1's shells record");
  const record = JSON.parse(held.value) as Record<string, unknown>;
  assert.equal(record.workloadId, "w-1");
  assert.equal(record.handsUrl, W1_URL, "with the address its shells are routed through");
  assert.equal(record.token, "tok-1", "and the credential anything reaching it needs");
  assert.equal(record.reason, "protected", "recording why it is being kept");

  const slot = await store.kv.get(handsSessionKey(SESSION));
  assert.equal(
    JSON.parse(new TextDecoder().decode(slot!.value)).workloadId, "w-2",
    "the session slot is W2's now -- which is the point: it cannot answer for W1, "
    + "and no longer has to",
  );
});

test("R2 CONTROL: a displaced sandbox with nothing running in it is still discarded", async () => {
  // The same fixture with one input changed. A rebuild that legitimately should
  // let go of the old sandbox must still let go of it: a displaced sandbox that
  // really is finished is the orphan the sweep exists to reap, and the GPU the
  // live task is queued behind. Retaining everything is not a fix -- and this
  // is also what stops R1 passing for a harness that never reached the stop.
  const fleet: Fleet = { stops: [], shells: new Map([["w-1", 0], ["w-2", 0]]) };
  stubEffects(fleet);
  const store = memoryKv({ [handsSessionKey(SESSION)]: w1Binding() });

  assert.equal(await tryReuseSessionSandbox(attempt(store.kv)), null);
  await bindW2(store);
  await sweepOrphan(store.kv, fleet, "w-1");

  assert.deepEqual(fleet.stops, ["w-1"], "nothing was running in it, so nothing holds it");
  assert.equal(
    (await retentionStore(store.kv).keys(RETENTION_LEDGER_FILTER)).length, 0,
    "and no record was left behind to keep it alive on paper",
  );
});

test("R3 the same hand-over on the unhealthy-rebuild branch", async () => {
  // Hands is not answering and cannot be restarted here, so the turn cannot use
  // W1 -- and W1 is still not this turn's to stop. A dead Hands does not end the
  // background shells: they are processes in the container, and the count that
  // says so is taken over the exec channel rather than over Hands.
  const fleet: Fleet = { stops: [], shells: new Map([["w-1", 2], ["w-2", 0]]) };
  const effects = stubEffects(fleet, { probe: "alive", restartRefused: true });
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  // Spec unchanged this time, so the turn reaches the health check rather than
  // the rebuild branch above.
  const binding = { ...w1Binding(), specFingerprint: specOf(T2) };
  const store = memoryKv({ [handsSessionKey(SESSION)]: binding });

  assert.equal(await tryReuseSessionSandbox(attempt(store.kv)), null);
  await bindW2(store);
  await sweepOrphan(store.kv, fleet, "w-1");

  assert.deepEqual(fleet.stops, [], "an unanswering Hands is not a licence over the work");
  assert.equal(fleet.shells.get("w-1"), 2, "both shells are still running");
  assert.deepEqual(effects.released, [], "and the holder's handle is still the holder's");
});

test("R4 CONTROL: an unhealthy displaced sandbox holding nothing is still discarded", async () => {
  const fleet: Fleet = { stops: [], shells: new Map([["w-1", 0], ["w-2", 0]]) };
  stubEffects(fleet, { probe: "alive", restartRefused: true });
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const store = memoryKv({
    [handsSessionKey(SESSION)]: { ...w1Binding(), specFingerprint: specOf(T2) },
  });

  assert.equal(await tryReuseSessionSandbox(attempt(store.kv)), null);
  await bindW2(store);
  await sweepOrphan(store.kv, fleet, "w-1");

  assert.deepEqual(fleet.stops, ["w-1"], "an idle sandbox nobody is bound to is an orphan");
});
