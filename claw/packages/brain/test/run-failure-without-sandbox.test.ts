// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A run whose sandbox the platform could not provide is recorded as failed, with why.
//
// The open of a lazy sandbox fails inside a tool call; the model is told and writes
// its answer without one, so the turn ends as usual. It used to end the run as
// usual too: `GET /v1/runs` said `exited` with no exit code and no reason, and the
// session read idle, so a caller could not tell "the agent finished" from "the
// sandbox never started" (2026-11-17, `sandbox_unschedulable` after 300s). The
// conversation keeps its normal ending; the completion now carries the run's
// failure beside it, and a task's callback reports it as an error.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import { RUN_FAILURE_MESSAGE_FIELD, RUN_FAILURE_REASON_FIELD } from "@claw/protocol";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

import { SandboxAttachError } from "../src/agent/attach-error.js";
import { SandboxProvisionTerminalError } from "../src/sandbox/errors.js";
import { bindTaskRunnerDeps, runHandleTask, type TaskRunnerSideEffects } from "../src/tasks/runner.js";
import { reapPendingHands } from "../src/sandbox/reaper.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";
import type { Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { activeAbort } from "../src/tasks/abort-registry.js";

const SESSION = "sess-run-failure";
const MESSAGE = "msg-run-failure";
const TASK = "task-run-failure";
/** The provider's message for the 2026-11-17 sandbox, as the run received it. */
const WHY = "workload claw-1-sandbox-m2c89 could not be scheduled: no node can take the sandbox right now, and no new node "
  + "is being added (admitted by the platform, but no node took its pod for 302s; phase=notready)";

let restoreProviders: (() => void) | null = null;
afterEach(() => { restoreProviders?.(); restoreProviders = null; });

function fakeKv() {
  const enc = new TextEncoder();
  const store = new Map<string, Uint8Array>();
  return {
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
    async keys() { return (async function* () {})(); },
  } as unknown as KV;
}

const ANSWER: ExecuteResult = {
  finalText: "I could not start anything: the sandbox could not be scheduled.",
  tokenUsage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
  turns: 2, pendingSkills: [], skillsUsed: {}, errorCount: 1,
  toolStats: { total_calls: 1, error_calls: 1, by_tool: { bash: 1 } }, elapsedMs: 10,
};

/**
 * One run whose engine asks for the sandbox (or not), reads what the open said,
 * and ends with an answer, as the agent loop does once the model has been told.
 */
async function runTurn(o: { open: (() => unknown) | null; callback?: boolean }) {
  const provider = {
    kind: "safe-workload",
    async stop() {},
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const msg = { seq: 1, info: { deliveryCount: 1 }, ack() {}, nak() {}, working() {}, term() {} } as unknown as JsMsg;
  const noop = <T>(v: T) => (() => Promise.resolve(v)) as never;
  const kv = fakeKv();
  bindHandsKv(kv);
  const delivered: ExecuteResult[] = [];
  const events: Array<Record<string, unknown>> = [];
  const sideEffects = {
    ensureHands: (async () => { throw o.open!(); }) as never,
    destroyHands: noop(undefined),
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
    postAgentDone: ((req: ExecuteRequest, res: ExecuteResult) => {
      if (req.task_id && req.callback_url) delivered.push(res);
      return Promise.resolve();
    }) as never,
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
      if (o.open) await extras!.attachHands!().then(() => assert.fail("the open was meant to fail"), () => {});
      return { ...ANSWER };
    },
  };
  const emitter = { async emit(_sid: string, evt: Record<string, unknown>) { events.push(evt); } } as unknown as NatsEmitter;
  bindTaskRunnerDeps({ kv, kvCkpt: fakeKv(), emitter, engine, sideEffects });

  const request = {
    session_id: SESSION, task_id: TASK, prompt: "start the session", user_id: "u1", platform_key: "pk",
    timeout: 25_200,
    ...(o.callback ? { callback_url: "http://api.test/v1/internal/tasks" } : {}),
    run_lease: { url: `http://api.test/v1/internal/tasks/${TASK}/lease`, token: "tok" },
  } as unknown as ExecuteRequest;
  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  const completion = events.find((e) => e.type === "exec_complete");
  assert.ok(completion, "the turn ended");
  return { completion: completion!, delivered };
}

const refused = (reason: string) => () => new SandboxAttachError(new SandboxProvisionTerminalError(reason, WHY));

for (const reason of ["sandbox_unschedulable", "sandbox_pending_timeout", "sandbox_start_timeout"]) {
  test(`${reason}: the turn answers, and the run is failed with the reason and the platform's account`, async () => {
    const { completion, delivered } = await runTurn({ open: refused(reason), callback: true });
    // The conversation's ending is unchanged: the answer stands.
    assert.equal(completion.failed, false);
    assert.equal(completion.final_text, ANSWER.finalText);
    // The run's is not.
    assert.equal(completion[RUN_FAILURE_REASON_FIELD], reason);
    assert.equal(completion[RUN_FAILURE_MESSAGE_FIELD], WHY);
    // A task's callback says the same: an error, for that reason, with the account.
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.abortReason, "error");
    assert.equal(delivered[0]!.failureReason, reason);
    assert.equal(delivered[0]!.failureMessage, WHY);
    assert.equal(delivered[0]!.finalText, ANSWER.finalText);
  });
}

test("a run that never asked for a sandbox ends as it always did", async () => {
  const { completion, delivered } = await runTurn({ open: null, callback: true });
  assert.equal(completion.failed, false);
  assert.equal(completion[RUN_FAILURE_REASON_FIELD], undefined);
  assert.equal(completion[RUN_FAILURE_MESSAGE_FIELD], undefined);
  assert.equal(delivered[0]!.abortReason, undefined);
  assert.equal(delivered[0]!.failureReason, undefined);
});

test("an account the platform refuses a sandbox to carries on, and the run is not failed for it", async () => {
  for (const reason of ["sandbox_workspace_forbidden", "sandbox_workspace_not_allowed"]) {
    const { completion, delivered } = await runTurn({ open: refused(reason), callback: true });
    assert.equal(completion[RUN_FAILURE_REASON_FIELD], undefined, reason);
    assert.equal(delivered[0]!.abortReason, undefined, reason);
  }
});

test("an open that failed for a reason the run may retry past does not fail the run", async () => {
  // Not one of the endings that say the platform has no sandbox for this run: the
  // next tool gets a fresh open, so the run is not over for want of one.
  const { completion, delivered } = await runTurn({
    open: () => new SandboxAttachError(new SandboxProvisionTerminalError("sandbox_gone", "workload wl-1 disappeared")),
    callback: true,
  });
  assert.equal(completion[RUN_FAILURE_REASON_FIELD], undefined);
  assert.equal(delivered[0]!.abortReason, undefined);
});
