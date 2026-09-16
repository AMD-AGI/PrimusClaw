// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox preempted during its own provisioning still gets a platform account.
 *
 * The shape the cluster actually produces: SaFE mints the workload id and the
 * provision records it as a PENDING KV entry, then the pod is reclaimed before
 * it ever becomes ready, so `ensureHands` throws
 * SandboxProvisionTerminalError("sandbox_exited_before_ready") and never
 * returns an identity. Everything that names the workload downstream --
 * `handsIdentity`, the row's `sandbox_workload_id` -- is written from that
 * return value, so the only surviving copy of the id is the PENDING entry,
 * and `reapPendingHands` on the failure path deletes it.
 *
 * Without the fix the run asks SaFE about `undefined` (and asks it after the
 * reap has already stopped the workload), the completion carries no
 * platformFacts, and a node reclaim is booked as an ordinary run failure.
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
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { activeAbort } from "../src/tasks/abort-registry.js";
import { SandboxProvisionTerminalError } from "../src/sandbox/errors.js";

const SESSION = "sess-preempt-before-ready";
const MESSAGE = "msg-preempt-before-ready";
const WORKLOAD = "workload-preempted-1";
const PLATFORM_KEY = "pk";

/** What the platform says about a pod the cluster reclaimed on its way up. */
const PREEMPTED = {
  message: "Preempted, reclaimed during startup",
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

test("preempted before ready: the platform is asked about the minted workload, before the reap", async () => {
  const order: string[] = [];
  const factsAsked: Array<unknown[]> = [];
  const delivered: ExecuteResult[] = [];
  const verdicts: string[] = [];

  const msg = {
    seq: 1, info: { deliveryCount: 1 },
    ack() { verdicts.push("ack"); }, nak(ms?: number) { verdicts.push(`nak:${ms}`); },
    working() {}, term() { verdicts.push("term"); },
  } as unknown as JsMsg;

  const noop = <T>(name: string, v: T) => (() => { order.push(name); return Promise.resolve(v); }) as never;

  // The durable record `onProvisioned` writes the moment SaFE answers with an
  // id: status pending, no handsUrl yet, and the platform key the workload was
  // created with. This is the state of the bucket when the pod is reclaimed.
  const { kv } = fakeKv({
    [handsSessionKey(SESSION)]: JSON.stringify({
      status: "pending",
      provider: "safe-workload",
      workloadId: WORKLOAD,
      platformKey: PLATFORM_KEY,
      token: "hands-token",
      namespace: "claw",
      createdAt: new Date().toISOString(),
    }),
  });
  const { kv: kvCkpt } = fakeKv();

  const sideEffects = {
    ensureHands: (async () => {
      order.push("ensureHands.threw");
      throw new SandboxProvisionTerminalError(
        "sandbox_exited_before_ready",
        `workload ${WORKLOAD} pod terminated (phase=Failed) before becoming ready`,
      );
    }) as never,
    destroyHands: noop("destroyHands", undefined),
    // The real one stops the workload and deletes the PENDING entry. Standing
    // in for that here is enough: what the assertions care about is that the
    // platform was asked before this ran, not how thoroughly it cleans up.
    reapPendingHands: (async () => { order.push("reapPendingHands"); }) as never,
    probeSandboxContainer: noop("probe", { verdict: "dead", reason: "x" }),
    fetchPlatformFacts: ((...a: unknown[]) => {
      order.push("fetchPlatformFacts");
      factsAsked.push(a);
      // Answers as SaFE does for a preempted pod -- but only when actually
      // asked about a workload, so the single thing that can keep the account
      // away from the run is the argument the runner passes.
      return Promise.resolve(a[0] === WORKLOAD ? { ...PREEMPTED } : null);
    }) as never,
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
    postAgentDone: ((_r: unknown, res: ExecuteResult) => {
      order.push("postAgentDone"); delivered.push(res); return Promise.resolve();
    }) as never,
    postTaskRunning: (() => { order.push("postTaskRunning"); return Promise.resolve(); }) as never,
    postRunLease: (() => { order.push("postRunLease"); return Promise.resolve("running"); }) as never,
    settleRunAttempt: noop("settle", undefined),
    runScript: noop("runScript", {} as ExecuteResult),
    refreshTaskLock: noop("refreshLock", undefined),
    releaseTaskLock: noop("releaseLock", undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({ close: async () => {} })) as never,
  } as unknown as TaskRunnerSideEffects;

  const engine: Engine = { async execute() { order.push("engine"); return {} as ExecuteResult; } };
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });

  const request = {
    session_id: SESSION, task_id: "task-preempt", prompt: "hi", user_id: "u1",
    platform_key: PLATFORM_KEY, mode: "script",
    callback_url: "http://api.test/v1/internal/tasks",
    run_lease: { url: "http://api.test/v1/internal/tasks/task-preempt/lease", token: "tok" },
  } as unknown as ExecuteRequest;

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);

  // 1. The platform is asked about the workload SaFE really minted, not about
  //    `undefined` -- the id is recovered from the PENDING record.
  assert.deepEqual(
    factsAsked.map((a) => [a[0], a[1]]),
    [[WORKLOAD, PLATFORM_KEY]],
    `the platform read must name the minted workload: ${JSON.stringify(factsAsked)}`,
  );

  // 2. And asked while it still exists: the reap stops the workload and drops
  //    the only record of its id, so a read after it can never succeed.
  const asked = order.indexOf("fetchPlatformFacts");
  const reaped = order.indexOf("reapPendingHands");
  assert.ok(asked >= 0 && reaped >= 0, `both must happen: ${order}`);
  assert.ok(asked < reaped, `the platform read must precede the reap: ${order}`);

  // 3. The account reaches the run, which is the whole point: the row records
  //    a cluster preemption rather than an unexplained failure.
  assert.equal(delivered.length, 1);
  assert.deepEqual((delivered[0] as { platformFacts?: unknown }).platformFacts, PREEMPTED);

  // 4. The reap still runs, and still runs before the run is declared over.
  const done = order.indexOf("postAgentDone");
  assert.ok(reaped < done, `the orphan workload is still reaped: ${order}`);
  assert.deepEqual(verdicts, ["ack"]);
});
