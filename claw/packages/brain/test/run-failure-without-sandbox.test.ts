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
import { TASK_POISON_DELIVERY_COUNT } from "../src/config.js";

const SESSION = "sess-run-failure";
/** The run's platform key: what a failure message must never carry out of the run. */
const PLATFORM_KEY = "safe-key-7f3a9c2e41b8d605";
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
async function runTurn(o: {
  open: (() => unknown) | null;
  /** Each open the engine makes, in order, when it makes more than one: an error to fail with, or "ok". */
  opens?: Array<(() => unknown) | "ok">;
  callback?: boolean;
  /** A script task, which opens its sandbox up front and fails when it cannot. */
  script?: boolean;
  /** Which delivery of the task this is. */
  deliveryCount?: number;
  /** The run's deadline (`deadline_at`). */
  deadlineAt?: string;
  /** The run is expected to nak for a redelivery rather than end. */
  expectRetry?: boolean;
}) {
  const opens = o.opens ?? (o.open ? [o.open] : []);
  let opened = 0;
  const provider = {
    kind: "safe-workload",
    async stop() {},
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const naks: number[] = [];
  const msg = {
    seq: 1, info: { deliveryCount: o.deliveryCount ?? 1 }, ack() {}, nak(ms: number) { naks.push(ms); }, working() {}, term() {},
  } as unknown as JsMsg;
  const noop = <T>(v: T) => (() => Promise.resolve(v)) as never;
  const kv = fakeKv();
  bindHandsKv(kv);
  const delivered: ExecuteResult[] = [];
  const events: Array<Record<string, unknown>> = [];
  const sideEffects = {
    ensureHands: (async () => {
      const next = opens[opened++];
      if (next === "ok") return { handsUrl: "http://hands.test", created: true, token: "t" };
      throw next!();
    }) as never,
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
      for (const next of opens) {
        await extras!.attachHands!().then(
          () => { if (next !== "ok") assert.fail("the open was meant to fail"); },
          (err) => { if (next === "ok") throw err; },
        );
      }
      return { ...ANSWER };
    },
  };
  const emitter = { async emit(_sid: string, evt: Record<string, unknown>) { events.push(evt); } } as unknown as NatsEmitter;
  bindTaskRunnerDeps({ kv, kvCkpt: fakeKv(), emitter, engine, sideEffects });

  const request = {
    session_id: SESSION, task_id: TASK, prompt: "start the session", user_id: "u1", platform_key: PLATFORM_KEY,
    timeout: 25_200,
    ...(o.callback ? { callback_url: "http://api.test/v1/internal/tasks" } : {}),
    ...(o.script ? { mode: "script", script: { steps: [{ kind: "bash", command: "make" }] } } : {}),
    ...(o.deadlineAt ? { deadline_at: o.deadlineAt } : {}),
    run_lease: { url: `http://api.test/v1/internal/tasks/${TASK}/lease`, token: "tok" },
  } as unknown as ExecuteRequest;
  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  const completion = events.find((e) => e.type === "exec_complete");
  if (o.expectRetry) {
    assert.equal(completion, undefined, "the run was meant to be retried, not ended");
    assert.equal(naks.length, 1, "naked once for a redelivery");
    return { completion: {} as Record<string, unknown>, delivered, naks };
  }
  assert.ok(completion, "the turn ended");
  return { completion: completion!, delivered, naks };
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

/** SaFE's answer to the 2026-11-20 create, as the provider reports it. */
const REJECTED = "The platform refused to create the sandbox (HTTP 400): admission webhook \"vworkload.kb.io\" denied the request: "
  + "Bad request. timeout 64800 exceeds the qos limit of 10800 seconds for scope Sandbox";

test("a create the platform refused fails the run with sandbox_rejected and the platform's words", async () => {
  const { completion, delivered } = await runTurn({ open: refused("sandbox_rejected"), callback: true });
  assert.equal(completion.failed, false);
  assert.equal(completion[RUN_FAILURE_REASON_FIELD], "sandbox_rejected");
  assert.equal(delivered[0]!.failureReason, "sandbox_rejected");
  assert.equal(delivered[0]!.abortReason, "error");
  // Opened once: a refusal is latched, and a second tool is told without asking the platform again.
  const again = await runTurn({ opens: [refused("sandbox_rejected"), () => assert.fail("asked again")], callback: true });
  assert.equal(again.completion[RUN_FAILURE_REASON_FIELD], "sandbox_rejected");
});

test("an open the run could have retried past, that it never got past, fails the run with its code", async () => {
  // A workload that failed before it was ready (AdminFailed), one that vanished, a
  // create the platform answered 5xx: the next tool may get a fresh open, but a
  // run that ends having never had its sandbox did not do the work it needed it for.
  const cases: Array<[() => unknown, string, string]> = [
    [
      () => new SandboxAttachError(new SandboxProvisionTerminalError(
        "sandbox_workload_terminal",
        "workload wl-1 entered terminal phase=failed (AdminFailed: failed to create pod: exceeded quota)",
      )),
      "sandbox_workload_terminal",
      "workload wl-1 entered terminal phase=failed (AdminFailed: failed to create pod: exceeded quota)",
    ],
    [
      () => new SandboxAttachError(new SandboxProvisionTerminalError("sandbox_gone", "workload wl-1 disappeared")),
      "sandbox_gone", "workload wl-1 disappeared",
    ],
    [
      () => new SandboxAttachError(new Error("Create Hands failed: HTTP 503 upstream connect error")),
      "sandbox_create_failed", "Create Hands failed: HTTP 503 upstream connect error",
    ],
    [
      // A failed create's message as some other path built it, the platform's body
      // on several lines: the run's message is one line whichever way it came.
      () => new SandboxAttachError(new Error("Create Hands failed: HTTP 503 upstream\r\nconnect error\n\tretry later")),
      "sandbox_create_failed", "Create Hands failed: HTTP 503 upstream connect error retry later",
    ],
  ];
  for (const [open, reason, message] of cases) {
    const { completion, delivered } = await runTurn({ open, callback: true });
    assert.equal(completion.failed, false, reason);
    assert.equal(completion[RUN_FAILURE_REASON_FIELD], reason);
    assert.equal(completion[RUN_FAILURE_MESSAGE_FIELD], message);
    assert.equal(delivered[0]!.abortReason, "error", reason);
    assert.equal(delivered[0]!.failureReason, reason);
    assert.equal(delivered[0]!.failureMessage, message);
  }
});

test("an open that failed and was then retried into a sandbox does not fail the run", async () => {
  const { completion, delivered } = await runTurn({
    open: null,
    opens: [() => new SandboxAttachError(new Error("Create Hands failed: HTTP 503 upstream connect error")), "ok"],
    callback: true,
  });
  assert.equal(completion[RUN_FAILURE_REASON_FIELD], undefined);
  assert.equal(delivered[0]!.abortReason, undefined);
});

test("an open that failed for a reason that is not the sandbox's does not fail the run", async () => {
  const { completion } = await runTurn({ open: () => new Error("model provider timed out"), callback: true });
  assert.equal(completion[RUN_FAILURE_REASON_FIELD], undefined);
});

test("the run's failure message never carries the run's own credentials", async () => {
  const { completion, delivered } = await runTurn({
    open: () => new SandboxAttachError(new SandboxProvisionTerminalError("sandbox_rejected", `${REJECTED} (key ${PLATFORM_KEY})`)),
    callback: true,
  });
  // Masked wherever the message leaves the run, and the platform's words kept.
  for (const text of [String(completion[RUN_FAILURE_MESSAGE_FIELD]), String(delivered[0]!.failureMessage)]) {
    assert.ok(!text.includes(PLATFORM_KEY), text);
    assert.ok(text.startsWith(REJECTED), text);
  }
});

test("a run that needs its sandbox up front and is refused one fails with the code and the platform's words", async () => {
  const { completion, delivered } = await runTurn({
    open: () => new SandboxProvisionTerminalError("sandbox_rejected", `${REJECTED} (key ${PLATFORM_KEY})`),
    callback: true, script: true,
  });
  assert.equal(completion.failed, true);
  assert.equal(completion.failure_reason, "sandbox_rejected");
  const message = String(completion.failure_message);
  assert.ok(message.startsWith(REJECTED), message);
  assert.ok(!message.includes(PLATFORM_KEY), message);
  assert.equal(delivered[0]!.failureReason, "sandbox_rejected");
  assert.equal(delivered[0]!.failureMessage, message);
});

test("a run whose sandbox create keeps failing is retried, and failed with sandbox_create_failed once no retry is left", async () => {
  const UNAVAILABLE = "Create Hands failed: HTTP 503 upstream connect error";
  const open = () => new Error(UNAVAILABLE);
  // A retry is still worth making: the run naks for a redelivery.
  const early = await runTurn({ open, callback: true, script: true, expectRetry: true });
  assert.equal(early.delivered.length, 0);
  // A retryable failure that is not the sandbox's keeps its redelivery at the same point.
  const other = await runTurn({
    open: () => new Error("nats: timeout"), callback: true, script: true,
    deliveryCount: TASK_POISON_DELIVERY_COUNT - 1, deadlineAt: new Date(Date.now() + 1_000).toISOString(), expectRetry: true,
  });
  assert.equal(other.delivered.length, 0);
  // The next try would land after the run's deadline.
  const deadlineAt = new Date(Date.now() + 1_000).toISOString();
  const atDeadline = await runTurn({ open, callback: true, script: true, deadlineAt });
  // Or would be the delivery the poison guard resolves.
  const atBudget = await runTurn({ open, callback: true, script: true, deliveryCount: TASK_POISON_DELIVERY_COUNT - 1 });
  for (const [what, { completion, delivered }, note] of [
    ["deadline", atDeadline, `(no retry left before the run's deadline of ${deadlineAt})`],
    ["deliveries", atBudget, `(failed on ${TASK_POISON_DELIVERY_COUNT - 1} attempts)`],
  ] as const) {
    assert.equal(completion.failed, true, what);
    assert.equal(completion.failure_reason, "sandbox_create_failed", what);
    assert.equal(String(completion.failure_message), `${UNAVAILABLE} ${note}`, what);
    assert.equal(delivered[0]!.failureReason, "sandbox_create_failed", what);
    assert.equal(delivered[0]!.failureMessage, `${UNAVAILABLE} ${note}`, what);
  }
});

test("a deadline that falls while the sandbox create is failing fails the run for the create, not the budget", async () => {
  const UNAVAILABLE = "Create Hands failed: HTTP 503 upstream connect error";
  const deadlineAt = new Date(Date.now() - 1_000).toISOString();
  const { completion, delivered } = await runTurn({ open: () => new Error(UNAVAILABLE), callback: true, script: true, deadlineAt });
  const message = `${UNAVAILABLE} (retried until the run reached its deadline of ${deadlineAt})`;
  assert.equal(completion.failed, true);
  assert.equal(completion.failure_reason, "sandbox_create_failed");
  assert.equal(String(completion.failure_message), message);
  assert.equal(delivered[0]!.failureReason, "sandbox_create_failed");
  assert.equal(delivered[0]!.failureMessage, message);
});
