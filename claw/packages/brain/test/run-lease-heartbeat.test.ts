// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker half of a run's lease.
 *
 * Whether a run is still alive used to be inferred from an unacknowledged
 * queue message, which conflates a dead worker with a slow one and takes the
 * redelivery budget to conclude either. The row's lease answers it directly,
 * and only if the worker actually renews it -- so what matters here is that a
 * run with a lease starts renewing before it does anything slow, stops when it
 * ends, and reports honestly whether it is executing or waiting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import {
  bindTaskRunnerDeps,
  runHandleTask,
  type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";
import type { Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import {
  activeAbort, LEASE_LOST_ABORT_REASON, RUN_ROW_TERMINAL_ABORT_REASON,
} from "../src/tasks/abort-registry.js";
import { beginRun, endRun, phaseOf, whileWaiting } from "../src/tasks/run-phase.js";

const SESSION = "sess-lease";
const MESSAGE = "msg-lease";

function fakeMsg() {
  const verdicts: string[] = [];
  return {
    verdicts,
    msg: {
      info: { deliveryCount: 1 },
      ack() { verdicts.push("ack"); },
      nak(ms?: number) { verdicts.push(`nak:${ms ?? "none"}`); },
      working() {},
      term() { verdicts.push("term"); },
    } as unknown as JsMsg,
  };
}

function fakeKv() {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  return {
    kv: {
      async get(key: string) {
        const value = store.get(key);
        return value ? { key, value } : null;
      },
      async put(key: string, value: Uint8Array | string) {
        store.set(key, typeof value === "string" ? enc.encode(value) : value);
        return 1;
      },
      async delete(key: string) { store.delete(key); },
    } as unknown as KV,
  };
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

interface Renewal {
  brainId: string;
  phase: string;
  waitedMs: number;
  leaseSeconds: number;
}

async function runScenario(opts: {
  lease?: { url: string; token: string };
  engineBehavior?: (extras: ExecuteExtras | undefined) => Promise<ExecuteResult>;
  leaseVerdict?: (n: number) => string;
}) {
  const renewals: Renewal[] = [];
  const { msg } = fakeMsg();
  const { kv } = fakeKv();
  const { kv: kvCkpt } = fakeKv();
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  const noop = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;

  const sideEffects = {
    ensureHands: noop({ handsUrl: "http://hands.test", created: true, token: "t" }),
    destroyHands: noop(undefined),
    reapPendingHands: noop(undefined),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => {}) as never,
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop(undefined),
    archiveRunToS3: noop(undefined),
    copyS3Prefix: noop({ copied: 0 }),
    syncWorkspace: noop({ ok: true }),
    restoreWorkspace: noop({ ok: true }),
    postAgentDone: noop(undefined),
    postTaskRunning: noop(undefined),
    postRunLease: ((_req: unknown, renewal: Renewal) => {
      renewals.push(renewal);
      return Promise.resolve(opts.leaseVerdict?.(renewals.length) ?? "running");
    }) as never,
    runScript: noop(result()),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({ close: async () => {} })) as never,
  } as unknown as TaskRunnerSideEffects;

  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras) {
      return opts.engineBehavior ? opts.engineBehavior(extras) : result();
    },
  };

  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });

  const request = {
    session_id: SESSION,
    prompt: "hi",
    user_id: "u1",
    ...(opts.lease ? { run_lease: opts.lease } : {}),
  } as ExecuteRequest;

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  return { renewals, abortCtrl };
}

test("a run with a lease claims it before it starts working", async () => {
  // The first renewal cannot wait for the heartbeat interval: a pod that dies
  // during sandbox provisioning would otherwise leave a row with no lease at
  // all, which reads as a run nobody has to reclaim.
  const { renewals } = await runScenario({
    lease: { url: "http://api.test/v1/internal/tasks/t-1/lease", token: "tok" },
  });

  assert.ok(renewals.length >= 1, "the lease is taken up front");
  assert.equal(renewals[0].phase, "executing");
  assert.ok(renewals[0].leaseSeconds > 0);
});

test("a run without a lease says nothing", async () => {
  // Runs dispatched before the lease existed, and everything with no row of
  // its own. Heartbeating for them would post to an endpoint that is not there.
  const { renewals } = await runScenario({});
  assert.deepEqual(renewals, []);
});

test("a waiting run reports the wait, not that it is busy", async () => {
  const key = "run-phase-unit";
  beginRun(key);
  try {
    let observed: string | undefined;
    await whileWaiting(key, "approval", async () => {
      observed = phaseOf(key).phase;
    });
    assert.equal(observed, "waiting", "time spent waiting on a person is not execution");
    assert.equal(phaseOf(key).phase, "executing", "and the run is busy again afterwards");
    assert.equal(phaseOf(key).waits, 1);
  } finally {
    endRun(key);
  }
});

test("a wait that throws still stops counting as a wait", async () => {
  const key = "run-phase-throw";
  beginRun(key);
  try {
    await assert.rejects(
      whileWaiting(key, "background_command", async () => { throw new Error("denied"); }),
    );
    assert.equal(phaseOf(key).phase, "executing",
      "a run stuck in 'waiting' forever would make the measurement useless");
  } finally {
    endRun(key);
  }
});

test("nested waits are one stretch of not executing", async () => {
  // An approval requested while a background command is outstanding is still
  // one stretch of the run standing still. Counting both would put the waiting
  // fraction above one and make the number unusable for capacity planning.
  const key = "run-phase-nested";
  beginRun(key);
  try {
    await whileWaiting(key, "background_command", async () => {
      await whileWaiting(key, "approval", async () => {
        assert.equal(phaseOf(key).waitReason, "background_command",
          "the outer reason is the one that describes the stretch");
      });
      assert.equal(phaseOf(key).phase, "waiting", "the outer wait is still in progress");
    });
    assert.equal(phaseOf(key).waits, 1, "one stretch, counted once");
  } finally {
    endRun(key);
  }
});

test("an untracked run does not blow up the tool call it wraps", async () => {
  // Sub-agents and script-mode runs are not tracked. Waiting there should be a
  // no-op, not a crash inside the tool dispatch path.
  const value = await whileWaiting(undefined, "approval", async () => 42);
  assert.equal(value, 42);
  assert.equal(await whileWaiting("never-begun", "approval", async () => 7), 7);
});

test("a run whose row has gone terminal stops itself", async () => {
  // The lease is a two-way statement. A 409 means something else has already
  // decided this run is over -- the sweeper reclaimed it after a network
  // partition, or a user cancelled it -- and the row has been closed. A
  // worker that kept going from there would drive a sandbox nobody is
  // waiting on and sync a workspace it is no longer entitled to write, which
  // is how the surviving run loses its files. Same ending as a lost lock,
  // reached from the other side.
  //
  // It matters more now than it did: with ack_wait at two minutes the queue
  // hands the message to a second worker quickly, so the window where two
  // workers believe they own one run is the window this closes.
  let observed: AbortSignal | undefined;
  const { abortCtrl } = await runScenario({
    lease: { url: "http://api.test/v1/internal/tasks/t-1/lease", token: "tok" },
    leaseVerdict: () => "gone",
    engineBehavior: async (extras) => {
      observed = (extras as { signal?: AbortSignal } | undefined)?.signal;
      // Long enough for the first renewal's verdict to land.
      await new Promise((r) => setTimeout(r, 30));
      return result();
    },
  });
  assert.equal(abortCtrl.signal.aborted, true, "a closed row must stop its worker");
  assert.equal(abortCtrl.signal.reason, RUN_ROW_TERMINAL_ABORT_REASON,
    "nobody else holds this run, so this worker is the one that has to give it back");
  if (observed) assert.equal(observed.aborted, true);
});

test("a run another worker has taken over stands down instead", async () => {
  // The refusal that looks identical from the outside and asks for the
  // opposite. Here the row is live and somebody else owns it, so the sandbox
  // this worker would release is the one that worker is using, and the
  // delivery it would terminate is the one that worker is running from --
  // terminating it takes the turn away from a run that was going to finish.
  const { abortCtrl } = await runScenario({
    lease: { url: "http://api.test/v1/internal/tasks/t-1/lease", token: "tok" },
    leaseVerdict: () => "superseded",
    engineBehavior: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return result();
    },
  });

  assert.equal(abortCtrl.signal.aborted, true, "two workers on one run is still a stop");
  assert.equal(abortCtrl.signal.reason, LEASE_LOST_ABORT_REASON,
    "the ending that touches nothing, because none of it is ours any more");
});

test("a lease renewal that merely fails is not a verdict", async () => {
  // The distinction the abort depends on: an API that is down, a timeout, a
  // 500 all return null, and treating those as 'this run is over' would kill
  // every run on the fleet the moment the API had a bad minute.
  const { abortCtrl } = await runScenario({
    lease: { url: "http://api.test/v1/internal/tasks/t-1/lease", token: "tok" },
    leaseVerdict: () => null as unknown as string,
    engineBehavior: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return result();
    },
  });
  assert.equal(abortCtrl.signal.aborted, false);
});
