// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The attempt boundaries no callback passes through.
 *
 * Two of them. A claimed run that succeeds is a chat row, so `postAgentDone`
 * sends nothing and the wrapper's ack used to be a no-op. A fat delivery that
 * naks for a retry has no release endpoint at all -- JetStream simply redelivers
 * -- and its declaration was left in a map only the claimed wrapper ever reads.
 * Either way the attempt ended with its record open, its coverage unreported,
 * and, on the fat path, the row still holding that attempt's token and lease.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import {
  claimedDoorbellMsg, declareFinalReport, flushPendingRetries,
} from "../src/delivery/doorbell-delivery.js";
import { AgentDoneDeliveryError } from "../src/tasks/callback.js";
import { bindTaskRunnerDeps, runHandleTask, type TaskRunnerSideEffects } from "../src/tasks/runner.js";
import { activeAbort } from "../src/tasks/abort-registry.js";

const SESSION = "sess-claimed-ack";
const MESSAGE = "msg-claimed-ack";
const CLAIM_COUNT = 3;

/** A claimed chat run: a task row, and deliberately no `callback_url`. */
function claimedRequest(taskId: string, lease = false, over: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    session_id: SESSION,
    message_id: MESSAGE,
    prompt: "hi",
    user_id: "u1",
    platform_key: "pk",
    task_id: taskId,
    ...(lease ? { run_lease: { url: `http://api.test/v1/internal/tasks/${taskId}/lease`, token: "t" } } : {}),
    ...over,
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
  // The drain, not a timer: the ack's settle is fire-and-forget, and what makes
  // it safe is that the shutdown path waits for it. A sleep here would pass just
  // as well with nothing tracking it at all.
  await flushPendingRetries();
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

test("a shutdown waits for a settle the ack has already sent", async () => {
  // The verdicts JsMsg exposes return void, so the settle is fire-and-forget by
  // construction. Nothing but the drain can keep a pod from exiting past one
  // still on the wire, leaving the row holding an attempt nobody will close.
  const settled: string[] = [];
  let deliver: (() => void) | null = null;
  const msg = claimedDoorbellMsg({ seq: 1, info: { deliveryCount: 1 } }, "ktsk-ackdrain", 1, {
    retryLater: async () => {},
    fail: async () => {},
    settle: (taskId) => new Promise<void>((resolve) => {
      deliver = () => { settled.push(taskId); resolve(); };
    }),
    sleep: async () => {},
  });

  msg.ack();
  assert.deepEqual(settled, [], "still in flight");

  let drained = false;
  const drain = flushPendingRetries().then(() => { drained = true; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(drained, false, "the drain must not walk away from a settle it can still wait for");

  deliver!();
  await drain;
  assert.deepEqual(settled, ["ktsk-ackdrain"]);
});

test("a fat retry settles its attempt, since no release endpoint will", async () => {
  // A fat delivery naks a real JetStream message: the wrapper that consumes a
  // declaration is not in this path at all. Without the settle the coverage is
  // dropped, the row keeps this attempt's token, and its lease refuses the
  // redelivery's first heartbeat until it lapses on its own.
  const attempts: Array<{ taskId: string; claimCount?: number; releaseLease?: boolean }> = [];
  const kv = fakeKv();
  const engine: Engine = { async execute() { return completed; } };
  bindTaskRunnerDeps({
    kv, kvCkpt: kv,
    emitter: { async emit() {} } as unknown as NatsEmitter,
    engine,
    sideEffects: {
      ...stubSideEffects(),
      // The handoff this run cannot complete, which is what sends it back for a
      // redelivery rather than to a terminal ack.
      postAgentDone: (async () => { throw new AgentDoneDeliveryError("backend unavailable"); }) as never,
      settleRunAttempt: (async (taskId: string, claimCount?: number, _r?: unknown, releaseLease?: boolean) => {
        attempts.push({ taskId, claimCount, releaseLease });
      }) as never,
    },
  });

  const verdicts: string[] = [];
  const msg = {
    seq: 7,
    info: { deliveryCount: 1 },
    ack() { verdicts.push("ack"); },
    nak(ms?: number) { verdicts.push(`nak:${ms ?? "none"}`); },
    working() {},
    term() { verdicts.push("term"); },
  } as unknown as Parameters<typeof runHandleTask>[0];

  const abortCtrl = new AbortController();
  const lockKey = "lock.ktsk-fatretry";
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(
    msg,
    claimedRequest("ktsk-fatretry", false, {
      callback_url: "http://api.test/v1/internal/tasks",
    } as Partial<ExecuteRequest>),
    SESSION, lockKey, MESSAGE, "u1", abortCtrl,
    null,
  );

  assert.deepEqual(verdicts, ["nak:5000"], "the redelivery was asked for");
  assert.equal(attempts.length, 1, "and the attempt it is leaving behind was settled first");
  assert.equal(attempts[0].taskId, "ktsk-fatretry");
  assert.equal(attempts[0].claimCount, 0, "a fat delivery takes no claim; 0 is the row's value");
  assert.equal(attempts[0].releaseLease, true,
    "the lease goes with it, or the next delivery renews against this one");
});
