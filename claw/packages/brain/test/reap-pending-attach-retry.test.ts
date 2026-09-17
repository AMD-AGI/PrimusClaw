// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run that asked for a sandbox twice still owns what the FIRST ask minted.
 *
 * `attachHands` does not cache a failure: the tool that hit it reports the
 * error and a later tool call gets a fresh `openSandbox`. So a lazy run can
 * enter the provision path more than once, and the first entry can already have
 * written a PENDING entry -- `onProvisioned` writes it the moment the workload
 * is minted, before the pod is waited on -- while the second fails earlier than
 * that and writes nothing.
 *
 * Ownership of that entry is decided by `sandboxAskedAt`, and a marker that is
 * re-stamped on every ask reads the run's own workload as somebody else's: the
 * entry was created before the second ask, so the failure path's reap skips it
 * and the workload runs on. Nothing later collects it either -- BRAIN_REGISTRY
 * carries a 5-minute TTL (DEFAULT_BRAIN_REGISTRY_TTL_MS) and the delivery
 * heartbeat that was holding the entry open stops with the run, so the entry is
 * gone long before the sweeper's 2-hour abandonment horizon can look at it, and
 * with it the only record of workloadId + platformKey.
 *
 * The assertion is the workload the provider was asked to stop, not a flag.
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

const SESSION = "sess-attach-retry";
const MESSAGE = "msg-attach-retry";
/** Minted by the first ask of THIS run, then abandoned when the attach failed. */
const OWN = "workload-first-ask";

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

function pendingValue(workloadId: string, createdAtMs: number): string {
  return JSON.stringify({
    status: "pending",
    provider: "safe-workload",
    workloadId,
    platformKey: "pk",
    namespace: "ns",
    token: "hands-token",
    runScope: SESSION,
    createdAt: new Date(createdAtMs).toISOString(),
  });
}

/**
 * Two tool calls ask for the sandbox. The first provision mints a workload,
 * records it, and then dies before the sandbox is usable; the second is refused
 * before `onProvisioned` runs, which is the ordinary shape of a KV or admission
 * failure -- nothing of this run's is written the second time round.
 */
async function runRetriedAttach() {
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

  const { kv, store } = fakeKv();
  const { kv: kvCkpt } = fakeKv();
  bindHandsKv(kv);

  let asks = 0;
  const sideEffects = {
    ensureHands: (async () => {
      asks += 1;
      if (asks === 1) {
        await kv.put(handsSessionKey(SESSION), pendingValue(OWN, Date.now()));
        throw new Error("hands health check failed after workload was minted");
      }
      throw new Error("hands KV unavailable");
    }) as never,
    destroyHands: noop(undefined),
    // The real one: what this test is about is the threshold the runner hands it.
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
      // First tool call: the attach fails and the agent loop keeps going.
      await assert.rejects(extras!.attachHands!());
      // A later tool call in the same turn asks again. Real time passes between
      // two tool calls; without it the two asks can share a millisecond and the
      // ownership comparison would pass for a reason the fleet does not have.
      await new Promise((r) => setTimeout(r, 25));
      return await extras!.attachHands!() as unknown as ExecuteResult;
    },
  };
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });

  const request = {
    session_id: SESSION, task_id: "task-attach-retry", prompt: "hi", user_id: "u1",
    platform_key: "pk",
    callback_url: "http://api.test/v1/internal/tasks",
    run_lease: { url: "http://api.test/v1/internal/tasks/task-attach-retry/lease", token: "tok" },
  } as unknown as ExecuteRequest;

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  return { stopped, store, asks };
}

test("the workload the first ask minted is reaped after a second ask fails", async () => {
  const { stopped, store, asks } = await runRetriedAttach();

  assert.equal(asks, 2, "the run has to have asked twice for this to be the case under test");
  assert.deepEqual(stopped, [OWN],
    `stopped ${JSON.stringify(stopped)}: this run minted ${OWN} and left it behind, and `
    + "nothing else will ever name it -- the entry recording it expires on the 5-minute "
    + "bucket TTL, hours before the sweeper's abandonment horizon");
  assert.equal(store.has(handsSessionKey(SESSION)), false,
    "and its entry must go with it, so no later reuse attaches to a stopped workload");
});
