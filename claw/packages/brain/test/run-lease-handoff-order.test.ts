// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which owner is renewing the lease, at every instant of the hand-off.
 *
 * Two things renew a fat run's lease: the delivery layer's pre-gate heartbeat,
 * which holds the row from acceptance until the handler starts, and the
 * runner's own heartbeat, which holds it for the rest of the run. They have to
 * overlap. A moment with neither renewing is a lease another pod's reaper can
 * find expired, and the user watches the turn restart -- or run twice -- for a
 * gap of a few milliseconds in a run that is otherwise healthy.
 *
 * `currentFatDelivery` is read out of an AsyncLocalStorage the delivery layer
 * owns, so the resolve hook swaps `../delivery/dispatch.js` for this file, and
 * only for the import in `tasks/runner.ts`. Everything else, this file
 * included, keeps the real module.
 */

import { registerHooks } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

export * from "../src/delivery/dispatch.js";

const RUNNER_MODULE = new URL("../src/tasks/runner.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === RUNNER_MODULE && specifier === "../delivery/dispatch.js") {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

/** Every change of renewal ownership, in the order the run made them. */
const owners: string[] = [];

export function currentFatDelivery(): { handOffRenewal(): void } {
  return { handOffRenewal(): void { owners.push("delivery_layer_stopped"); } };
}

const SESSION = "sess-handoff";
const MESSAGE = "msg-handoff";
const TASK = "task-handoff";

function fakeMsg(): JsMsg {
  return {
    seq: 7,
    info: { deliveryCount: 1 },
    ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
}

function fakeKv(): KV {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  return {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value } : null;
    },
    async put(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 1;
    },
    async delete(key: string) { store.delete(key); },
  } as unknown as KV;
}

function result(): ExecuteResult {
  return {
    finalText: "done",
    tokenUsage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
    turns: 1,
    pendingMemories: [],
    pendingSkills: [],
    skillsUsed: {},
    errorCount: 0,
    toolStats: { total_calls: 0, error_calls: 0, by_tool: {} },
    elapsedMs: 3,
  } as ExecuteResult;
}

test("the delivery layer keeps renewing until this run's own heartbeat has taken over", async () => {
  const runner = await import("../src/tasks/runner.js");
  const noop = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;
  const sideEffects = {
    ensureHands: noop({ handsUrl: "http://hands.test", created: true, token: "t" }),
    destroyHands: noop(undefined),
    reapPendingHands: noop(undefined),
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
    postRunLease: (() => {
      owners.push("run_renewed");
      return Promise.resolve("running");
    }) as never,
    runScript: noop(result()),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({ close: async () => {} })) as never,
  } as unknown as import("../src/tasks/runner.js")["TaskRunnerSideEffects"];

  const engine = { async execute() { return result(); } } as unknown as
    import("../src/agent/index.js")["Engine"];

  runner.bindTaskRunnerDeps({
    kv: fakeKv(), kvCkpt: fakeKv(),
    emitter: { async emit() {} } as never,
    engine, sideEffects,
  });

  const request = {
    session_id: SESSION, task_id: TASK, prompt: "hi", user_id: "u1",
    run_lease: { url: "http://api.test/v1/internal/tasks/t-1/lease", token: "tok" },
  } as ExecuteRequest;

  const { activeAbort } = await import("../src/tasks/abort-registry.js");
  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runner.runHandleTask(fakeMsg(), request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);

  assert.equal(
    owners[0], "run_renewed",
    "the delivery layer may only be released once this run has renewed the lease itself; "
    + "releasing it first leaves the row with nobody renewing it",
  );
  assert.ok(
    owners.includes("delivery_layer_stopped"),
    "and it must be released, or two owners renew the same lease for the whole run",
  );
});
