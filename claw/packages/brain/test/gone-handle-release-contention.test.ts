// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Losing a race must not end the task.
 *
 * `releaseHandlesForGoneWorkload` (sandbox/ensure-hands.ts) frees every handle
 * naming a workload the provider has confirmed absent, so the replacement this
 * turn is about to provision can take the name. The round before this one made
 * that release PROPAGATE instead of swallowing its failure, which was right: a
 * release that cannot commit means the registration a few lines later would be
 * refused anyway, so throwing names the real cause one GPU create earlier.
 *
 * What it left open is what the task runner then does with the error. It reads
 * `isRetryable(err)` and nothing else, and the error the release throws most
 * often is a lost CAS race: the row is re-read, the handle still names the dead
 * workload, the conditional write is refused because a sibling node of the same
 * DAG just registered a second handle into the same row, five times over. That
 * error satisfied no condition in `isRetryable`, so the run was reported failed
 * and the delivery ACKED -- and an acked delivery does not come back. A
 * contention measured in milliseconds ended the task permanently.
 *
 * So these assert on the two observables that decide, and on nothing else:
 *
 *   - what NATS was told. `["nak:5000"]` is a task that will be delivered
 *     again; `["ack"]` is a task that is over. No test here looks at which
 *     error class was raised -- that is the mechanism, and a fix that changed
 *     the mechanism while still acking would pass such a test and strand the
 *     session.
 *   - what the redelivery achieves. A nak is only worth spending if the next
 *     attempt gets somewhere, so the retry is actually run and the handle table
 *     is read afterwards: the dead workload's rows are gone and the replacement
 *     owns the name.
 *
 * The handle bucket is in memory with the real conditional-write semantics, and
 * `releaseHandlesForWorkload`, `replaceDagHandle` and the gone-branch in
 * `tryReuseSessionSandbox` are the production ones over it. That is the same
 * choice `bindDagHandlesForTest` documents: the measurement harness stands up
 * real JetStream, and a unit suite that every other sandbox test runs without a
 * broker is the wrong place for that dependency. What a fake here could get
 * wrong is the conflict rule, and that is exactly what this store implements
 * and what `dag-handle-ownership.test.ts` pins independently.
 *
 * Coverage:
 *   C1 a release that loses the CAS race naks, and the redelivery rebuilds
 *   C2 the losing attempt creates no replacement workload
 *   C3 a release that cannot READ the row still ends the task
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

import {
  bindTaskRunnerDeps,
  runHandleTask,
  type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { activeAbort } from "../src/tasks/abort-registry.js";
import {
  bindSandboxReuseEffects,
  makeOnProvisioned,
  requestSpecFingerprint,
  tryReuseSessionSandbox,
} from "../src/sandbox/ensure-hands.js";
import { bindDagHandlesForTest, lookupDagHandle, replaceDagHandle } from "../src/sandbox/handles.js";
import { resolveSandboxAction } from "../src/sandbox/params.js";
import { handsSessionKey } from "../src/sandbox/hands-key.js";
import { matchesKvFilter } from "./fixtures/kv-filter.js";

const realFetch = globalThis.fetch;
let restoreEffects: (() => void) | null = null;
let restoreHandles: (() => void) | null = null;
afterEach(() => {
  globalThis.fetch = realFetch;
  restoreEffects?.();
  restoreEffects = null;
  restoreHandles?.();
  restoreHandles = null;
});

/* ---------------------------------------------------------------- fixtures */

const SESSION = "s-contend";
const MESSAGE = "m-1";
const W1_URL = "http://hands-1.test:9100/mcp";
/** The workload the provider has lost. Its name is what has to come free. */
const GONE = "w-1";
/** The workload this turn provisions once the name is free. */
const REPLACEMENT = "w-2";

/** This turn's request: a different image, so the session's sandbox cannot be reused. */
const T2: ExecuteRequest = {
  session_id: SESSION,
  prompt: "carry on",
  sandbox_image: "example.io/torch:2.5",
  task_id: "t-2",
  dag_root_task_id: "dag-t2",
  user_id: "u1",
  platform_key: "pk-1",
} as ExecuteRequest;

function specOf(request: ExecuteRequest): string {
  const action = resolveSandboxAction(request);
  assert.equal(action.kind, "create", "this fixture has to describe a sandbox to build");
  return requestSpecFingerprint(request, action as never);
}

/** The session slot, as the create path recorded it for the workload now gone. */
function goneBinding(): Record<string, unknown> {
  return {
    status: "ready",
    taskId: "t-1",
    dagRootTaskId: "dag-t1",
    runScope: `lock.session.${SESSION}`,
    provider: "safe-workload",
    workloadId: GONE,
    handsUrl: W1_URL,
    sandboxImage: "example.io/torch:2.4",
    specFingerprint: specOf(T2),
    platformKey: "pk-1",
    token: "tok-1",
    namespace: "ns-1",
    createdAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------- store */

/** JetStream's answer to a conditional write that lost. */
function conflict(seq: number): Error {
  return new Error(`wrong last sequence: ${seq}`);
}

interface Store { kv: KV; map: Map<string, { value: Uint8Array; revision: number }>; }

/**
 * A bucket with the conditional-write rule the release depends on: `update`
 * and a `previousSeq` `delete` are refused unless the revision handed in is
 * still the entry's current one.
 *
 * `onRead` is what makes the race a race. It fires AFTER the entry snapshot is
 * taken and BEFORE it is returned, which is the one window a contender can
 * occupy: the release has its revision and has not spent it yet. Landing the
 * contender by ordering statements in the test instead would produce a
 * conflict, but not this conflict -- it would be a row that had already moved
 * before the read, which the release handles by re-reading and noticing.
 */
function memoryKv(
  seed: Record<string, unknown> = {},
  onRead?: (key: string) => Promise<void>,
): Store {
  const enc = new TextEncoder();
  const map = new Map<string, { value: Uint8Array; revision: number }>(
    Object.entries(seed).map(([k, v]) => [k, { value: enc.encode(JSON.stringify(v)), revision: 3 }]),
  );
  const kv = {
    async get(key: string) {
      const held = map.get(key);
      const snapshot = held
        ? { key, value: held.value, revision: held.revision, operation: "PUT" }
        : null;
      if (onRead) await onRead(key);
      return snapshot;
    },
    async put(key: string, value: Uint8Array) {
      const revision = (map.get(key)?.revision ?? 0) + 1;
      map.set(key, { value, revision });
      return revision;
    },
    async create(key: string, value: Uint8Array) {
      if (map.has(key)) throw conflict(map.get(key)!.revision);
      map.set(key, { value, revision: 1 });
      return 1;
    },
    async update(key: string, value: Uint8Array, revision: number) {
      if (map.get(key)?.revision !== revision) throw conflict(map.get(key)?.revision ?? 0);
      map.set(key, { value, revision: revision + 1 });
      return revision + 1;
    },
    async delete(key: string, opts?: { previousSeq?: number }) {
      const held = map.get(key);
      if (opts?.previousSeq && held && held.revision !== opts.previousSeq) {
        throw conflict(held.revision);
      }
      if (opts?.previousSeq && !held) throw conflict(0);
      map.delete(key);
    },
    async keys(filter = ">") {
      const matched = [...map.keys()].filter((k) => matchesKvFilter(k, filter));
      return (async function* () { for (const k of matched) yield k; })();
    },
  };
  return { kv: kv as unknown as KV, map };
}

/**
 * The other DAG, writing into the same row the release is trying to change.
 *
 * `dag-handles.<dagRoot>` holds ALL of that DAG's handles, so a sibling node
 * taking a second sandbox is a write to the row the dead workload's handle
 * lives in. The writer is the production `replaceDagHandle`, so the revision it
 * leaves behind is one the real registration path would leave.
 *
 * Armed and disarmed rather than given a count of writes. A count would have to
 * be budgeted against every read of that row the turn makes, and the turn makes
 * several before the release does: `workloadHeldByOtherDag` scans the table to
 * answer whether another DAG holds this workload, and that scan reads each row.
 * Counting them is bookkeeping about the test rather than about the defect --
 * what the scenario says is "a sibling DAG is registering handles throughout",
 * and `armed` says exactly that.
 */
function contender() {
  // Disarmed until `arm()`, because seeding the table goes through the same
  // writer: a contender live during the seed would fight the fixture instead of
  // the release, and the fixture would be what fails.
  const state = { armed: false, writes: 0, busy: false };
  const arm = () => { state.armed = true; };
  const disarm = () => { state.armed = false; };
  const onRead = async (key: string) => {
    if (state.busy || !state.armed) return;
    if (key !== "dag-handles.dag-t1") return;
    state.busy = true;      // replaceDagHandle reads too; do not recurse
    try {
      state.writes += 1;
      await replaceDagHandle("dag-t1", `sbx-${state.writes}`, {
        workload_id: `w-sibling-${state.writes}`,
        platform_key: "pk-1",
        namespace: "ns-1",
        hands_url: `http://hands-sibling-${state.writes}.test:9100/mcp`,
        token: "tok-sib",
      });
    } finally {
      state.busy = false;
    }
  };
  return { state, arm, disarm, onRead };
}

/* ------------------------------------------------- the sandbox layer below */

interface Fleet { created: string[]; stops: string[] }

/**
 * The reuse effects around the gone-branch, with the handle table left REAL.
 *
 * `probe: dead` is the provider's own answer that the workload no longer
 * exists, which is the only thing that reaches `releaseHandlesForGoneWorkload`.
 * The ownership questions are answered by the seeded rows rather than stubbed,
 * so "another DAG may hold this workload" is decided by the table this test is
 * about.
 */
function stubSandboxEffects(fleet: Fleet): void {
  restoreEffects = bindSandboxReuseEffects({
    destroyHands: (async (_s: string, known?: { workloadId?: string }) => {
      if (known?.workloadId) fleet.stops.push(known.workloadId);
    }) as never,
    registerSandbox: (() => {}) as never,
    probeSandboxContainer: async () => ({ verdict: "dead" as const, reason: "exec_sandbox_gone" as const }),
    restartHandsInSandbox: async () => ({ ok: false, detail: "kill switch off", refused: true }),
    countLiveWork: (async () => ({
      verdict: "unknown" as const, classes: {}, reason: "exec_unanswered: workload not found",
    })) as never,
  });
}

/**
 * `provisionHands` in miniature, and in its order: try to reuse the session's
 * sandbox, and only if that hands back nothing, create a workload and register
 * it under this DAG's handle.
 *
 * Both halves are the production calls -- `tryReuseSessionSandbox` runs the
 * real gone-branch and the real release, `makeOnProvisioned` runs the real
 * registration. The only thing standing in for the provider is that a create
 * appends to `fleet.created` instead of costing a GPU, which is what makes
 * "the failing attempt provisioned nothing" observable.
 */
function ensureHandsThroughReuse(kv: KV, fleet: Fleet) {
  return async () => {
    const reused = await tryReuseSessionSandbox({
      kv, sessionId: SESSION, request: T2, requestedSpec: specOf(T2),
      action: resolveSandboxAction(T2), onEvent: async () => {},
    } as Parameters<typeof tryReuseSessionSandbox>[0]);
    if (reused) return reused;

    const onProvisioned = makeOnProvisioned({
      sessionId: SESSION,
      namespace: "ns-1",
      apiKey: "pk-1",
      handsToken: "tok-new",
      sandboxImage: "example.io/torch:2.5",
      kv,
      hold: { async bind() {}, async release() {} },
      stop: async (id: string) => { fleet.stops.push(id); },
      taskId: "t-2",
      dagRootTaskId: "dag-t2",
      handleName: "sbx",
    });
    fleet.created.push(REPLACEMENT);
    await onProvisioned(REPLACEMENT);
    return {
      handsUrl: "http://hands-2.test:9100/mcp",
      created: true,
      token: "tok-new",
      identity: { provider: "safe-workload", workloadId: REPLACEMENT, platformKey: "pk-1" },
    };
  };
}

/* -------------------------------------------------------- the runner above */

/** Records the ack/nak verdict, which is the whole redelivery contract. */
function fakeMsg(deliveryCount: number) {
  const verdicts: string[] = [];
  const msg = {
    seq: 11,
    info: { deliveryCount },
    ack() { verdicts.push("ack"); },
    nak(ms?: number) { verdicts.push(`nak:${ms ?? "none"}`); },
    working() {},
    term() { verdicts.push("term"); },
  };
  return { msg: msg as unknown as JsMsg, verdicts };
}

/**
 * The checkpoint bucket, carrying a v3 checkpoint for this run.
 *
 * Present because `needsSandboxUpFront` is what decides whether this turn calls
 * `ensureHands` at all: with BRAIN_LAZY_SANDBOX defaulting true, an ordinary
 * chat turn gets its sandbox only when a tool asks for one, and a run with
 * nothing to restore never provisions. A resumed run does, before the model
 * sees a message, because its /workspace has to be rehydrated first -- and a
 * resumed run is exactly the shape of a session whose sandbox died under it,
 * which is the situation this whole branch is about.
 */
function fakeCheckpointKv(): KV {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  store.set(`task-ckpt.${SESSION}.${MESSAGE}`, enc.encode(JSON.stringify({
    version: 3,
    session_id: SESSION,
    message_id: MESSAGE,
    user_id: "u1",
    checkpointed_at: Date.now(),
    has_workspace_sync: false,
    last_sync_turn: 0,
    messages: [{ role: "user", content: "hi" }],
    turns_completed: 1,
    usage: { input_tokens: 10, output_tokens: 20, cache_read: 0, cache_create: 0 },
    text_parts: [],
    error_count: 0,
    tool_calls_by_name: {},
    total_tool_calls: 0,
    elapsed_ms_before: 1000,
    setup_commands: [],
  })));
  return {
    async get(key: string) { const v = store.get(key); return v ? { key, value: v } : null; },
    async put(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 1;
    },
    async delete(key: string) { store.delete(key); },
  } as unknown as KV;
}

function taskResult(): ExecuteResult {
  return {
    finalText: "done",
    tokenUsage: { input_tokens: 1, output_tokens: 2, cache_read: 0, cache_create: 0 },
    turns: 1,
    pendingMemories: [],
    pendingSkills: [],
    skillsUsed: {},
    errorCount: 0,
    toolStats: { total_calls: 0, error_calls: 0, by_tool: {} },
    elapsedMs: 5,
  } as ExecuteResult;
}

/**
 * Everything that leaves the process, stubbed -- except `ensureHands`, which is
 * the seam this file is about and is wired to the real reuse path above.
 */
function stubbedSideEffects(ensureHands: TaskRunnerSideEffects["ensureHands"]): TaskRunnerSideEffects {
  const noop = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;
  return {
    ensureHands,
    destroyHands: noop(undefined),
    reapPendingHands: noop(undefined),
    probeSandboxContainer: noop({ verdict: "dead", reason: "no_kv_entry" }),
    restartHandsInSandbox: noop({ ok: true, detail: "healthy" }),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => Promise.resolve({ outcome: "parked" })) as never,
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop(undefined),
    archiveRunToS3: noop(undefined),
    copyS3Prefix: noop({ copied: 0 }),
    syncWorkspace: noop({ ok: true }),
    restoreWorkspace: noop({ ok: true }),
    postAgentDone: noop(undefined),
    postTaskRunning: noop(undefined),
    runScript: noop(taskResult()),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({
      close: async () => {},
      reapShells: async () => 1,
    })) as never,
  } as TaskRunnerSideEffects;
}

/** One delivery of the task, through the real runner. */
async function deliver(kv: KV, fleet: Fleet, deliveryCount: number) {
  const { msg, verdicts } = fakeMsg(deliveryCount);
  const events: Array<Record<string, unknown>> = [];
  const emitter = {
    async emit(_s: string, evt: Record<string, unknown>) { events.push(evt); },
  } as unknown as NatsEmitter;
  const engine: Engine = { async execute() { return taskResult(); } };

  bindTaskRunnerDeps({
    kv, kvCkpt: fakeCheckpointKv(), emitter, engine,
    sideEffects: stubbedSideEffects(ensureHandsThroughReuse(kv, fleet) as never),
  });

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, T2, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  activeAbort.delete(lockKey);
  return { verdicts, events };
}

/** Both DAGs naming the workload the provider has since lost. */
async function seedHandles(onRead?: (key: string) => Promise<void>): Promise<Store> {
  const handleStore = memoryKv({}, onRead);
  restoreHandles = bindDagHandlesForTest(handleStore.kv);
  for (const dagRoot of ["dag-t1", "dag-t2"]) {
    await replaceDagHandle(dagRoot, "sbx", {
      workload_id: GONE,
      platform_key: "pk-1",
      namespace: "ns-1",
      hands_url: W1_URL,
      token: "tok-1",
    });
  }
  return handleStore;
}

/* ------------------------------------------------------------------- tests */

test("C1 a release that loses the CAS race naks, and the redelivery rebuilds", async () => {
  // Five consecutive losses is exactly REGISTER_CAS_ATTEMPTS, so the release
  // gives up with the dead workload's name still written. Nothing about the
  // fleet is broken: the contender is another DAG registering handles, and it
  // stops as soon as it has finished.
  const race = contender();
  await seedHandles(race.onRead);
  race.arm();
  const fleet: Fleet = { created: [], stops: [] };
  stubSandboxEffects(fleet);
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const session = memoryKv({ [handsSessionKey(SESSION)]: goneBinding() });

  const first = await deliver(session.kv, fleet, 1);

  assert.ok(
    race.state.writes >= 5,
    "the contender has to have actually landed inside the release's reads, "
    + `at least once per attempt; it landed ${race.state.writes} times`,
  );
  assert.deepEqual(
    first.verdicts, ["nak:5000"],
    "a lost race has to come back. Before the fix this is ['ack'] -- the task is "
    + "reported failed and the delivery is settled, and nothing redelivers it",
  );

  // The retry, which is the only reason a nak is worth spending. The sibling
  // DAG has finished registering, so the release wins its first CAS.
  race.disarm();
  const second = await deliver(session.kv, fleet, 2);

  assert.deepEqual(second.verdicts, ["ack"], "the redelivered task completes and is settled");
  assert.equal(
    (await lookupDagHandle("dag-t2", "sbx"))?.workload_id, REPLACEMENT,
    "and this DAG's handle names the replacement, which is what the nak bought",
  );
  assert.equal(
    await lookupDagHandle("dag-t1", "sbx"), null,
    "the gone workload's name was freed on the sibling's row too -- the release "
    + "this whole branch exists for still happens",
  );
  assert.equal(
    (await lookupDagHandle("dag-t1", "sbx-1"))?.workload_id, "w-sibling-1",
    "and the contender's own registrations survived the release that lost to them",
  );
  assert.deepEqual(fleet.stops, [], "nothing was created, refused and rolled back");
});

test("C2 the attempt that lost the race provisions nothing", async () => {
  // The reason the release throws instead of swallowing: a replacement created
  // here would be refused by the row still naming the dead workload, then
  // stopped. Failing before the create is the same outcome one GPU cheaper, and
  // this is the assertion that it is still BEFORE.
  const race = contender();
  await seedHandles(race.onRead);
  race.arm();
  const fleet: Fleet = { created: [], stops: [] };
  stubSandboxEffects(fleet);
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const session = memoryKv({ [handsSessionKey(SESSION)]: goneBinding() });

  const first = await deliver(session.kv, fleet, 1);

  assert.deepEqual(first.verdicts, ["nak:5000"]);
  assert.deepEqual(fleet.created, [], "no workload was provisioned on the way to the failure");
  assert.deepEqual(fleet.stops, [], "so none had to be rolled back either");
  assert.equal(
    (await lookupDagHandle("dag-t2", "sbx"))?.workload_id, GONE,
    "and the name is still where the failed release left it, for the retry to free",
  );
});

test("C3 a row that cannot be read still ends the task", async () => {
  // The half that must NOT move with the fix. A row that does not parse as an
  // object reads the same way on every redelivery, so naking it spends the
  // delivery budget on a question whose answer cannot change. It stays terminal
  // -- which is also the shape of the error the old conflated throw used to
  // hide behind the same sentence as the race.
  //
  // A JSON array in place of the row. The scan coerces its one element the way
  // it coerces any legacy bare-string entry -- a workload id under the name
  // "0" -- so the release does reach this row and try to free it; the CAS loop
  // then re-reads it, finds something that is not an object, and cannot tell
  // whether the name it was sent for is in there. That is the case that has to
  // stay terminal.
  const handleStore = await seedHandles();
  handleStore.map.set("dag-handles.dag-t1", {
    value: new TextEncoder().encode(JSON.stringify([GONE])),
    revision: 9,
  });
  const fleet: Fleet = { created: [], stops: [] };
  stubSandboxEffects(fleet);
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const session = memoryKv({ [handsSessionKey(SESSION)]: goneBinding() });

  const only = await deliver(session.kv, fleet, 1);

  assert.deepEqual(
    only.verdicts, ["ack"],
    "an unreadable row is not a race: the task is failed and settled, not retried",
  );
  assert.deepEqual(fleet.created, [], "and still nothing was provisioned first");
  const completion = only.events.find((e) => e.type === "exec_complete");
  assert.equal(completion?.failed, true, "the user is told the turn failed");
});
