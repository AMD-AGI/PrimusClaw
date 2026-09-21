// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A chat run the cluster kills during its own provisioning still leaves the
 * handle its ending can be attributed with.
 *
 * The lease heartbeat resolves the sandbox every RUN_LEASE_HEARTBEAT_MS (15s)
 * and the opening renewal deliberately carries none, so a run that dies inside
 * its first fifteen seconds sends one renewal that names nothing -- and the
 * pre-ready family (sandbox_exited_before_ready, sandbox_gone,
 * sandbox_pending_timeout) is a pod dying during provisioning, which is over
 * well inside one tick.
 *
 * A DAG task survives that: `agent_done` carries the platform account itself.
 * A chat run has no `callback_url`, so `postAgentDone` returns on its first
 * line, `platformFacts` is read and dropped, and `exec_complete` has no field
 * for it. The row's `sandbox_workload_id` is the only thing left for
 * platform-backfill to ask SaFE with, and backfill's own KV fallback cannot
 * stand in because `reapPendingHands` deletes the entry on the failure path.
 *
 * Driven through the real `runHandleTask`; only the outside world is stubbed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import { handsSessionKey } from "@claw/protocol";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import {
  bindTaskRunnerDeps, runHandleTask, type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";
import type { Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { activeAbort } from "../src/tasks/abort-registry.js";
import { SandboxProvisionTerminalError } from "../src/sandbox/errors.js";
import type { LeaseRenewal } from "../src/tasks/callback.js";

const SESSION = "sess-chat-preready";
const MESSAGE = "msg-chat-preready";
const WORKLOAD = "workload-chat-preempted";
const PLATFORM_KEY = "pk";

/** What SaFE says about a pod the cluster reclaimed on its way up. */
const PREEMPTED = {
  message: "Preempted, the node was reclaimed",
  node: "node-7",
  containerReason: "Error",
  exitCode: 137,
};

function fakeKv(seed: Record<string, string> = {}) {
  const enc = new TextEncoder();
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(seed)) store.set(k, enc.encode(v));
  return {
    store,
    kv: {
      async get(key: string) {
        const value = store.get(key);
        return value ? { key, value, revision: 1, operation: "PUT" } : null;
      },
      async put(key: string, value: Uint8Array | string) {
        store.set(key, typeof value === "string" ? enc.encode(value) : value);
        return 1;
      },
      async update(key: string, value: Uint8Array | string) {
        store.set(key, typeof value === "string" ? enc.encode(value) : value);
        return 2;
      },
      async delete(key: string) { store.delete(key); },
    } as unknown as KV,
  };
}

/**
 * Drive one chat run whose provision dies before the sandbox is ready.
 *
 * `entryWritten` is what the bucket holds by the time the run fails -- by
 * default the entry this run's own `onProvisioned` would have written, and for
 * the ownership tests below, one belonging to somebody else.
 */
async function runPreadyChat(entryWritten?: Record<string, unknown>) {
  const renewals: LeaseRenewal[] = [];
  const events: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const delivered: ExecuteResult[] = [];
  let entryAtRenewal: string | undefined;

  const msg = {
    seq: 1, info: { deliveryCount: 1 },
    ack() { order.push("ack"); }, nak() { order.push("nak"); },
    working() {}, term() {},
  } as unknown as JsMsg;

  const noop = <T>(name: string, v: T) =>
    (() => { order.push(name); return Promise.resolve(v); }) as never;

  const { kv, store } = fakeKv();
  const { kv: kvCkpt } = fakeKv();

  const sideEffects = {
    ensureHands: (async () => {
      // `onProvisioned`, field for field: SaFE has minted the id and the
      // provision records it before it starts waiting on the pod. Written from
      // inside the call because that is the only place it is ever written from
      // -- an entry that predates this run belongs to an earlier message.
      await kv.put(handsSessionKey(SESSION), JSON.stringify(entryWritten ?? {
        status: "pending",
        // The task that asked. `makeOnProvisioned` always records it, and both
        // the reap and the report establish ownership by it -- a fixture that
        // omitted it was modelling an entry this build cannot write.
        taskId: "task-chat-preready",
        workloadId: WORKLOAD,
        platformKey: PLATFORM_KEY,
        token: "hands-token",
        namespace: "claw",
        createdAt: new Date().toISOString(),
      }));
      order.push("ensureHands.threw");
      throw new SandboxProvisionTerminalError(
        "sandbox_exited_before_ready",
        `workload ${WORKLOAD} pod terminated (phase=Failed) before becoming ready`,
      );
    }) as never,
    destroyHands: noop("destroyHands", undefined),
    reapPendingHands: (async () => {
      order.push("reapPendingHands");
      // What the real one does once it has stopped the workload: the id stops
      // existing anywhere this fleet can read it.
      store.delete(handsSessionKey(SESSION));
    }) as never,
    probeSandboxContainer: noop("probe", { verdict: "dead", reason: "x" }),
    fetchPlatformFacts: ((...a: unknown[]) =>
      Promise.resolve(a[0] === WORKLOAD ? { ...PREEMPTED } : null)) as never,
    restartHandsInSandbox: noop("restart", { ok: true, detail: "" }),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => Promise.resolve({ outcome: "parked" })) as never,
    markRetryPending: noop("markRetryPending", undefined),
    syncWorkspaceToS3: noop("s3up", { uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop("s3down", undefined),
    archiveRunToS3: noop("archive", undefined),
    copyS3Prefix: noop("copy", { copied: 0 }),
    syncWorkspace: noop("syncWs", { ok: true }),
    restoreWorkspace: noop("restoreWs", { ok: true }),
    // The real guard, so nothing in here can pretend a chat run has a callback:
    // `postAgentDone` returns on its first line without a `callback_url`.
    postAgentDone: ((req: ExecuteRequest, res: ExecuteResult) => {
      order.push("postAgentDone");
      if (req.task_id && req.callback_url) delivered.push(res);
      return Promise.resolve();
    }) as never,
    postTaskRunning: (() => Promise.resolve()) as never,
    postRunLease: ((_req: unknown, renewal: LeaseRenewal) => {
      order.push("postRunLease");
      renewals.push(renewal);
      if (renewal.sandbox) {
        const entry = store.get(handsSessionKey(SESSION));
        entryAtRenewal = entry ? new TextDecoder().decode(entry) : undefined;
      }
      return Promise.resolve("running");
    }) as never,
    settleRunAttempt: noop("settle", undefined),
    runScript: noop("runScript", {} as ExecuteResult),
    refreshTaskLock: noop("refreshLock", undefined),
    releaseTaskLock: noop("releaseLock", undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({ close: async () => {} })) as never,
  } as unknown as TaskRunnerSideEffects;

  const engine: Engine = {
    async execute(_r, _e, _s, _h, extras?: ExecuteExtras) {
      // A chat turn under BRAIN_LAZY_SANDBOX: the sandbox opens on the first
      // tool call, and this is where the cluster takes it away.
      return await extras!.attachHands!() as unknown as ExecuteResult;
    },
  };
  const emitter = {
    async emit(_sid: string, evt: Record<string, unknown>) { events.push(evt); },
  } as unknown as NatsEmitter;
  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });

  // A doorbell-claimed chat run: a lease to renew, and no callback_url at all.
  const request = {
    session_id: SESSION, task_id: "task-chat-preready", prompt: "hi", user_id: "u1",
    platform_key: PLATFORM_KEY,
    run_lease: { url: "http://api.test/v1/internal/tasks/task-chat-preready/lease", token: "tok" },
  } as unknown as ExecuteRequest;

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  return { renewals, events, order, delivered, entryAtRenewal, store };
}

test("a chat run killed before its first heartbeat leaves its workload on the row", async () => {
  const { renewals, events, order, delivered, entryAtRenewal, store } = await runPreadyChat();

  // 1. Nothing else carried the account anywhere. The chat run has no callback,
  //    so the facts Brain read are delivered to nobody, and the completion the
  //    API does see has no platform field on it to put them in.
  assert.deepEqual(delivered, [], "a chat run posts no agent_done");
  const completion = events.find((e) => e.type === "exec_complete");
  assert.ok(completion, "the run still reports a completion");
  assert.equal(completion!.failure_reason, "sandbox_exited_before_ready");
  assert.equal(
    Object.keys(completion!).some((k) => k.startsWith("platform")), false,
    `exec_complete has nowhere to carry the account: ${JSON.stringify(completion)}`,
  );

  // 2. So the row's own handle is the whole of what platform-backfill will have
  //    to ask SaFE with, and this run has to have left it there.
  assert.deepEqual(
    renewals.at(-1)?.sandbox,
    { provider: "safe-workload", handle: WORKLOAD },
    `the row must learn which workload the cluster killed: ${
      JSON.stringify(renewals.map((r) => r.sandbox))}`,
  );

  // 3. And left it before the reap, which is what makes it the last copy:
  //    backfill's KV fallback reads the same entry this deletes.
  assert.ok(
    entryAtRenewal?.includes(WORKLOAD),
    "the handle is reported while the PENDING entry still exists",
  );
  assert.equal(store.get(handsSessionKey(SESSION)), undefined,
    "and the reap still runs afterwards");
  assert.deepEqual(order.filter((o) => o === "ack"), ["ack"]);
});

test("a sibling DAG's newer entry is not reported as this run's workload", async () => {
  // The gap between the two readers of one question. `reapPendingHands` was
  // taught to match the task the entry names; this path was left comparing
  // timestamps, and the weaker test was the one on the reporting side.
  //
  // No skewed clock is needed. This run's create is refused before
  // `onProvisioned` writes anything; a sibling DAG then writes its own PENDING
  // entry, which is genuinely NEWER than this run's ask. On the old test this
  // run adopted it -- reporting the sibling's workload, node and preemption
  // reason as its own ending, on a task that never had a sandbox. The reap
  // correctly refuses to destroy it, which does not unsay the report.
  const { renewals } = await runPreadyChat({
    status: "pending",
    provider: "safe-workload",
    workloadId: "workload-sibling-dag",
    platformKey: PLATFORM_KEY,
    token: "hands-token",
    namespace: "claw",
    taskId: "task-sibling-dag",
    createdAt: new Date(Date.now() + 1_000).toISOString(),
  });

  assert.equal(
    renewals.some((r) => r.sandbox), false,
    `an entry naming another task is not this run's to report: ${
      JSON.stringify(renewals.map((r) => r.sandbox))}`,
  );
});

test("and neither is one that names no task at all", async () => {
  // `makeOnProvisioned` always records the task, so an entry without one was
  // written by a build older than the field and cannot be this run's.
  const { renewals } = await runPreadyChat({
    status: "pending",
    provider: "safe-workload",
    workloadId: "workload-unnamed",
    platformKey: PLATFORM_KEY,
    token: "hands-token",
    namespace: "claw",
    createdAt: new Date(Date.now() + 1_000).toISOString(),
  });

  assert.equal(renewals.some((r) => r.sandbox), false);
});
