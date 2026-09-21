// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The failure path's reap runs against THIS run's ask, end to end.
 *
 * `reap-pending-ownership.test.ts` pins the rule; this pins the wiring, because
 * the rule is worth nothing if the runner keeps calling the reap without its
 * threshold. The real `reapPendingHands` is installed here rather than a stub,
 * and the assertion is the one the incident was reported as: whether a stop was
 * issued against the predecessor's workload.
 *
 * Both turns of the same session are exercised. The chat turn under
 * BRAIN_LAZY_SANDBOX that answers from context and then fails on a provider
 * error -- `ensureHands` never called, so nothing of the entry in the bucket is
 * its own -- and the turn where a tool does ask, which must still clean up
 * after itself or every failed provision leaks a workload for 24 hours.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import { handsSessionKey } from "@claw/protocol";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

import {
  bindTaskRunnerDeps, runHandleTask, type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";
import { reapPendingHands } from "../src/sandbox/reaper.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";
import type { Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { activeAbort } from "../src/tasks/abort-registry.js";

const SESSION = "sess-reap-wiring";
const MESSAGE = "msg-reap-wiring";
/** Still queueing for the message before this one. */
const PREDECESSOR = "workload-previous-run";
/** Minted inside this run's own ensureHands, then abandoned by it. */
const OWN = "workload-this-run";

let restoreProviders: (() => void) | null = null;
afterEach(() => { restoreProviders?.(); restoreProviders = null; });

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

function pendingValue(
  workloadId: string,
  createdAtMs: number,
  /**
   * Who wrote the entry. Defaulted to the PREDECESSOR's task because that is
   * what the bucket really holds in the case under test: every pending entry
   * this build writes names its task (ensure-hands.ts), so a predecessor's
   * entry is identified by its own task id rather than by its age.
   */
  taskId = "task-predecessor",
): string {
  return JSON.stringify({
    status: "pending",
    taskId,
    provider: "safe-workload",
    workloadId,
    platformKey: "pk",
    namespace: "ns",
    token: "hands-token",
    runScope: SESSION,
    createdAt: new Date(createdAtMs).toISOString(),
  });
}

async function runTurn(provisions: "none" | "own") {
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async stop(inst: { id: string }) { stopped.push(inst.id); },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });

  const msg = {
    seq: 1, info: { deliveryCount: 1 },
    ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
  const noop = <T>(v: T) => (() => Promise.resolve(v)) as never;

  // Left behind by an earlier message whose provision died before its own reap.
  const { kv, store } = fakeKv({
    [handsSessionKey(SESSION)]: pendingValue(PREDECESSOR, Date.now() - 600_000),
  });
  const { kv: kvCkpt } = fakeKv();
  bindHandsKv(kv);

  const sideEffects = {
    ensureHands: (async () => {
      // This run's own `onProvisioned`, replacing the leftover entry, followed
      // by the pod dying before it ever reaches READY.
      await kv.put(handsSessionKey(SESSION), pendingValue(OWN, Date.now(), "task-reap-wiring"));
      throw new Error("workload pod terminated before becoming ready");
    }) as never,
    destroyHands: noop(undefined),
    // The real one: this test exists to check what the runner hands it.
    reapPendingHands,
    probeSandboxContainer: noop({ verdict: "dead", reason: "x" }),
    fetchPlatformFacts: noop(null),
    restartHandsInSandbox: noop({ ok: true, detail: "" }),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => Promise.resolve({ outcome: "parked" })) as never,
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop(undefined),
    archiveRunToS3: noop(undefined),
    copyS3Prefix: noop({ copied: 0 }),
    syncWorkspace: noop({ ok: true }),
    restoreWorkspace: noop({ ok: true }),
    postAgentDone: (() => Promise.resolve()) as never,
    postTaskRunning: (() => Promise.resolve()) as never,
    postRunLease: (() => Promise.resolve("running")) as never,
    settleRunAttempt: noop(undefined),
    runScript: noop({} as ExecuteResult),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({ close: async () => {} })) as never,
  } as unknown as TaskRunnerSideEffects;

  const engine: Engine = {
    async execute(_r, _e, _s, _h, extras?: ExecuteExtras) {
      if (provisions === "own") {
        return await extras!.attachHands!() as unknown as ExecuteResult;
      }
      throw new Error("401 {\"error\":{\"message\":\"invalid x-api-key\"}}");
    },
  };
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });

  const request = {
    session_id: SESSION, task_id: "task-reap-wiring", prompt: "hi", user_id: "u1",
    platform_key: "pk",
    callback_url: "http://api.test/v1/internal/tasks",
    run_lease: { url: "http://api.test/v1/internal/tasks/task-reap-wiring/lease", token: "tok" },
  } as unknown as ExecuteRequest;

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  return { stopped, store };
}

test("a failed turn that provisioned nothing leaves the predecessor's workload running", async () => {
  const { stopped, store } = await runTurn("none");

  assert.deepEqual(stopped, [],
    `this turn stopped ${JSON.stringify(stopped)} on its way out, and the run that is `
    + "still waiting on it will read its own sandbox as preempted");
  assert.ok(store.has(handsSessionKey(SESSION)),
    "and the binding that names that workload is gone with it");
});

test("a failed turn that provisioned its own still stops it", async () => {
  const { stopped, store } = await runTurn("own");

  assert.deepEqual(stopped, [OWN],
    "the orphan this run minted must still be reaped -- that is the common case");
  assert.equal(store.has(handsSessionKey(SESSION)), false);
});
