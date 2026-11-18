// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A NATS timeout is a reason to try the run again, not a reason it ended.
//
// 2026-11-06 14:21:42Z-14:22:07Z JetStream did not answer for about twenty
// seconds. Two review runs (Primus-SaFE #843 and #846, tasks
// ktsk_01M6RKKX5XWE5EYV56CMPHM30K and ktsk_01M6RKKXSR4JR8S7NFK8468FXZ) logged
// `task.failed` with errorClass NatsError, errorMessage TIMEOUT, and were stored
// as failure_reason upstream_timeout -- "the model call timed out" -- with no
// retry. nats-stall-survivable.test.ts pins the error functions for the bare
// NatsError; this file pins what the runner itself does with it, end to end,
// and the shape that still ended a run for good after that fix: the same
// NatsError wrapped by the sandbox layer in a sentence of its own.
//
//   N1 the runner naks a NatsError TIMEOUT, bare or wrapped, and reports nothing
//   N2 a model that really timed out is still a terminal upstream_timeout
//   N3 a wrapped TIMEOUT is retryable and is not called the model's
//   N4 retries back off, bounded, on both delivery paths
import { test } from "node:test";
import assert from "node:assert/strict";
import { NatsError } from "nats";
import type { KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { SandboxAttachError } from "../src/agent/attach-error.js";
import { claimedDoorbellMsg } from "../src/delivery/doorbell-delivery.js";
import { isRetryable, retryableNakMs, RETRYABLE_NAK_MAX_MS } from "../src/infra/retry.js";
import { TASK_LOCK_NAK_MAX_MS, RETRY_PENDING_KEEPALIVE_GRACE_SEC } from "../src/config.js";
import { SandboxProvisionTerminalError } from "../src/sandbox/errors.js";
import { __test__, bindTaskRunnerDeps, runHandleTask, type TaskRunnerSideEffects } from "../src/tasks/runner.js";
import { activeAbort } from "../src/tasks/abort-registry.js";

const { classifyTaskFailure, classifyRetryableReason } = __test__;

const natsTimeout = () => NatsError.errorForCode("TIMEOUT");
/** What ensure-hands throws when the hands KV read times out. */
const handsKvTimeout = () =>
  new Error("hands KV is unavailable; refusing unsafe sandbox replacement", { cause: natsTimeout() });
/** What ensure-hands throws when a DAG handle binding write times out: the cause's message is in the text. */
const bindingWriteTimeout = () =>
  new Error(
    "this DAG recovered onto the sandbox its handle 'h' names, but the session binding that keeps it "
    + "could not be written (TIMEOUT). Without it nothing records that the container is in use.",
    { cause: natsTimeout() },
  );

const SESSION = "sess-nats-timeout";
const MESSAGE = "msg-nats-timeout";

function fakeKv(): KV {
  return {
    async get() { return null; },
    async put() { return 1; },
    async delete() {},
  } as unknown as KV;
}

interface Reported { failureReason?: string; finalText?: string }

function sideEffects(reported: Reported[]): Partial<TaskRunnerSideEffects> {
  const nothing = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;
  return {
    ensureHands: nothing({
      handsUrl: "http://hands.test",
      created: true,
      token: "t",
      identity: { provider: "safe-workload", workloadId: "wl-test", platformKey: "pk" },
    }),
    destroyHands: nothing(undefined),
    reapPendingHands: nothing(undefined),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => {}) as never,
    syncWorkspaceToS3: nothing({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: nothing(undefined),
    archiveRunToS3: nothing(undefined),
    copyS3Prefix: nothing({ copied: 0 }),
    postTaskRunning: nothing(undefined),
    postRunLease: nothing("running"),
    refreshTaskLock: nothing(undefined),
    releaseTaskLock: nothing(undefined),
    flushTranscript: nothing(undefined),
    markRetryPending: nothing(undefined),
    settleRunAttempt: nothing(undefined),
    postAgentDone: (async (_req: unknown, result: ExecuteResult & Reported) => {
      reported.push({ failureReason: result.failureReason, finalText: result.finalText });
    }) as never,
    makeHandsClient: (() => ({
      close: async () => {},
      reapShells: async () => 1,
    })) as never,
  };
}

/** One fat delivery of a run whose engine throws `err`, through the real runner. */
async function runFailing(err: () => unknown, deliveryCount = 1) {
  const reported: Reported[] = [];
  const events: Array<Record<string, unknown>> = [];
  const kv = fakeKv();
  const engine: Engine = { async execute() { throw err(); } };
  bindTaskRunnerDeps({
    kv, kvCkpt: kv,
    emitter: {
      async emit(_s: string, event: Record<string, unknown>) { events.push(event); },
    } as unknown as NatsEmitter,
    engine,
    sideEffects: sideEffects(reported),
  });

  const verdicts: string[] = [];
  const msg = {
    seq: 7,
    info: { deliveryCount },
    ack() { verdicts.push("ack"); },
    nak(ms?: number) { verdicts.push(`nak:${ms ?? "none"}`); },
    working() {},
    term() { verdicts.push("term"); },
  } as unknown as Parameters<typeof runHandleTask>[0];

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(
    msg,
    {
      session_id: SESSION,
      message_id: MESSAGE,
      prompt: "review a pull request",
      user_id: "u1",
      platform_key: "pk",
      task_id: "ktsk-nats-timeout",
      callback_url: "http://api.test/v1/internal/tasks",
    } as ExecuteRequest,
    SESSION, lockKey, MESSAGE, "u1", abortCtrl,
    null,
  );
  const failed = events.filter((e) => e.type === "exec_complete" && e.failed === true);
  return {
    verdicts, reported,
    failedCompletion: failed.length > 0,
    failureReasons: failed.map((e) => e.failure_reason),
  };
}

for (const [name, err] of [
  ["a bare NatsError TIMEOUT (the 2026-11-06 error itself)", natsTimeout],
  ["a NatsError TIMEOUT wrapped by the hands KV read", handsKvTimeout],
  ["a NatsError TIMEOUT wrapped by the DAG binding write", bindingWriteTimeout],
] as const) {
  test(`N1 ${name} is redelivered, not reported`, async () => {
    const r = await runFailing(err);
    assert.deepEqual(r.verdicts, ["nak:5000"], "the run is asked for again, and soon");
    assert.deepEqual(r.reported, [], "no terminal result reaches the task row");
    assert.equal(r.failedCompletion, false, "and the session is not told the run failed");
  });
}

test("N2 a model call that really timed out is still terminal, and still says so", async () => {
  const r = await runFailing(() => new Error("Request timeout after 600s"));
  assert.deepEqual(r.verdicts, ["ack"]);
  assert.equal(r.reported.length, 1, "the terminal result reaches the task row");
  assert.deepEqual(r.failureReasons, ["upstream_timeout"], "under the reason the row and the review flow read");
});

test("N3 a wrapped NATS timeout is retryable and is not reported as the model's", () => {
  for (const err of [handsKvTimeout(), bindingWriteTimeout(), new SandboxAttachError(handsKvTimeout())]) {
    assert.equal(isRetryable(err), true, (err as Error).message);
    const failure = classifyTaskFailure((err as Error).message, err);
    assert.equal(failure.reason, "infra_transient", (err as Error).message);
    assert.doesNotMatch(failure.userText, /model/i);
    assert.equal(classifyRetryableReason(err), "nats_transient");
  }

  // What a second attempt cannot change stays terminal, wrapped or not.
  const refused = new Error("hands KV is unavailable", { cause: NatsError.errorForCode("PERMISSIONS_VIOLATION") });
  assert.equal(isRetryable(refused), false);
  // A provisioning give-up is terminal by contract, whatever caused it.
  const gaveUp = Object.assign(
    new SandboxProvisionTerminalError("sandbox_workload_terminal", "gave up"), { cause: natsTimeout() },
  );
  assert.equal(isRetryable(gaveUp), false);
  // Prose is not the client: a sentence saying TIMEOUT with no NatsError behind it.
  assert.equal(isRetryable(new Error("could not be written (TIMEOUT)")), false);
});

test("N4 a retry backs off, and the backoff is bounded", async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 22].map(retryableNakMs), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  assert.equal(retryableNakMs(0), 5_000);
  assert.equal(retryableNakMs(Number.NaN), 5_000);
  assert.ok(RETRYABLE_NAK_MAX_MS <= TASK_LOCK_NAK_MAX_MS, "within the nak ceiling the stream retention is derived from");
  assert.ok(RETRYABLE_NAK_MAX_MS < RETRY_PENDING_KEEPALIVE_GRACE_SEC * 1000,
    "and shorter than the grace the kept sandbox waits for the retry");

  // A fat delivery backs off by its delivery count.
  const fat = await runFailing(natsTimeout, 3);
  assert.deepEqual(fat.verdicts, ["nak:20000"]);

  // A claimed run by its claim count, through the real wrapper.
  const slept: number[] = [];
  const retried: string[] = [];
  const kv = fakeKv();
  bindTaskRunnerDeps({
    kv, kvCkpt: kv,
    emitter: { async emit() {} } as unknown as NatsEmitter,
    engine: { async execute() { throw natsTimeout(); } },
    sideEffects: sideEffects([]),
  });
  const msg = claimedDoorbellMsg(
    { seq: 0, info: { deliveryCount: 1 } },
    "ktsk-claimed-timeout",
    2,
    {
      settle: async () => { throw new Error("a retryable failure must not settle the row"); },
      retryLater: async (id) => { retried.push(id); },
      fail: async () => { throw new Error("a retryable failure must not fail the row"); },
      sleep: async (ms) => { slept.push(ms); },
    },
  );
  const abortCtrl = new AbortController();
  const lockKey = "lock.ktsk-claimed-timeout";
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(
    msg,
    {
      session_id: SESSION, message_id: MESSAGE, prompt: "hi", user_id: "u1",
      platform_key: "pk", task_id: "ktsk-claimed-timeout",
    } as ExecuteRequest,
    SESSION, lockKey, MESSAGE, "u1", abortCtrl,
    { claimCount: 2 },
  );
  for (let i = 0; i < 20 && retried.length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(slept, [10_000], "the second claim waits twice as long as the first");
  assert.deepEqual(retried, ["ktsk-claimed-timeout"], "and the row goes back on the queue");
});
