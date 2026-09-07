// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one terminal path that reports to nobody: a claimed run that succeeds.
 *
 * Its row is a chat row, so it carries no `callback_url` and `postAgentDone`
 * returns without sending anything; its message is the claimed-doorbell wrapper,
 * whose ack used to be a no-op. Between the two, a run that finished cleanly
 * left its attempt record open with no instant on it, and only a reap or a
 * release -- neither of which happens to a healthy run -- would ever close one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { claimedDoorbellMsg, declareFinalReport } from "../src/delivery/doorbell-delivery.js";
import { bindTaskRunnerDeps, runHandleTask, type TaskRunnerSideEffects } from "../src/tasks/runner.js";
import { activeAbort } from "../src/tasks/abort-registry.js";

const SESSION = "sess-claimed-ack";
const MESSAGE = "msg-claimed-ack";
const CLAIM_COUNT = 3;

/** A claimed chat run: a task row, and deliberately no `callback_url`. */
function claimedRequest(taskId: string, lease = false): ExecuteRequest {
  return {
    session_id: SESSION,
    message_id: MESSAGE,
    prompt: "hi",
    user_id: "u1",
    platform_key: "pk",
    task_id: taskId,
    ...(lease ? { run_lease: { url: `http://api.test/v1/internal/tasks/${taskId}/lease`, token: "t" } } : {}),
  } as ExecuteRequest;
}

const completed: ExecuteResult = {
  finalText: "done",
  tokenUsage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
  turns: 1,
  pendingMemories: [],
  pendingSkills: [],
  skillsUsed: {},
  errorCount: 0,
  toolStats: { total_calls: 0, error_calls: 0, by_tool: {} },
  elapsedMs: 1,
} as ExecuteResult;

function fakeKv(): KV {
  return {
    async get() { return null; },
    async put() { return 1; },
    async delete() {},
  } as unknown as KV;
}

/**
 * Everything that leaves the process, except `postAgentDone`.
 *
 * That one is the real implementation: whether it sends anything for a request
 * with no `callback_url` is half of what this file is about, and a stub that
 * accepted the call would report a report nobody actually posted.
 */
function stubSideEffects(): Partial<TaskRunnerSideEffects> {
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
    makeHandsClient: (() => ({
      close: async () => {},
      reapShells: async () => 1,
    })) as never,
  };
}

interface Settlement {
  taskId: string;
  claimCount?: number;
  runTime?: unknown;
}

/** Drive one claimed run to completion, through the real wrapper it acks. */
async function runClaimed(taskId: string, opts: { lease?: boolean; workMs?: number } = {}): Promise<{
  settled: Settlement[]; retried: string[]; failed: string[];
}> {
  const settled: Settlement[] = [];
  const retried: string[] = [];
  const failed: string[] = [];
  const msg = claimedDoorbellMsg(
    { seq: 0, info: { deliveryCount: 1 } },
    taskId,
    CLAIM_COUNT,
    {
      settle: async (id, claimCount, runTime) => { settled.push({ taskId: id, claimCount, runTime }); },
      retryLater: async (id) => { retried.push(id); },
      fail: async (id) => { failed.push(id); },
      sleep: async () => {},
    },
  );

  const kv = fakeKv();
  const engine: Engine = {
    async execute() {
      if (opts.workMs) await new Promise((r) => setTimeout(r, opts.workMs));
      return completed;
    },
  };
  bindTaskRunnerDeps({
    kv, kvCkpt: kv,
    emitter: { async emit() {} } as unknown as NatsEmitter,
    engine, sideEffects: stubSideEffects(),
  });

  const abortCtrl = new AbortController();
  const lockKey = `lock.${taskId}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(
    msg, claimedRequest(taskId, opts.lease), SESSION, lockKey, MESSAGE, "u1", abortCtrl,
    { claimCount: CLAIM_COUNT },
  );
  // The ack settles without awaiting; a turn of the loop is what the production
  // caller gives it too, since nothing downstream of the ack depends on it.
  await new Promise((r) => setTimeout(r, 0));
  return { settled, retried, failed };
}

test("a claimed run that succeeds settles its attempt on the ack", async () => {
  const { settled, retried, failed } = await runClaimed("ktsk-ack-plain");

  assert.deepEqual(retried, [], "a successful run is not handed back to the queue");
  assert.deepEqual(failed, [], "nor failed");
  assert.equal(settled.length, 1, "the ack is the boundary that ends the attempt");
  assert.equal(settled[0].taskId, "ktsk-ack-plain");
  assert.equal(settled[0].claimCount, CLAIM_COUNT,
    "fenced on the generation, so a settle that lost the row is refused");
});

test("the coverage the attempt declared travels with that settle", async () => {
  // `declareFinalReport` is how the runner hands the delivery loop what it
  // measured; before the ack consumed one, a successful run's declaration sat
  // in the map until some later attempt of the same run took it.
  const report = {
    key: "ktsk-ack-covered", attemptId: "att-1", claimCount: CLAIM_COUNT,
    deliverySeq: 0, deliveryCount: 0,
    basis: { kind: "same_domain", domain: "brain" },
    cumulativeStateMs: { executing: 90 },
  } as unknown as Parameters<typeof declareFinalReport>[1];
  declareFinalReport("ktsk-ack-covered", report);

  const { settled } = await runClaimed("ktsk-ack-covered");
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0].runTime, report);

  // Taken once: a later attempt must not settle under its predecessor's totals.
  const again = await runClaimed("ktsk-ack-covered");
  assert.equal(again.settled[0].runTime, undefined);
});

test("the runner hands the ack what it measured, not only what a caller declared", async () => {
  // The declaration itself, from the run rather than from the test: with a lease
  // the heartbeat opens this attempt's coverage, so the terminal ack has real
  // per-state totals to settle with. Nothing else on this path would carry them.
  const { settled } = await runClaimed("ktsk-ack-measured", { lease: true, workMs: 25 });

  assert.equal(settled.length, 1);
  const runTime = settled[0].runTime as { key: string; cumulativeStateMs?: Record<string, number> };
  assert.ok(runTime, "a run that measured its own time must not settle with nothing");
  assert.equal(runTime.key, "ktsk-ack-measured", "banked against the run's own ledger entry");
  assert.ok((runTime.cumulativeStateMs?.executing ?? 0) > 0,
    "and the totals are the ones the run actually accrued");
});
