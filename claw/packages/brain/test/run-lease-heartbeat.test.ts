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
import type { LeaseRenewal } from "../src/tasks/callback.js";
import type { SandboxEntry } from "../src/sandbox/keepalive.js";
import { handsSessionKey } from "../src/sandbox/hands-key.js";
import { RUN_LEASE_HEARTBEAT_MS } from "../src/config.js";
import { testRunKey } from "./support/run-identity.js";

const SESSION = "sess-lease";
const MESSAGE = "msg-lease";
const TASK = "task-lease";

function fakeMsg() {
  const verdicts: string[] = [];
  return {
    verdicts,
    msg: {
      seq: 7,
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

interface ScenarioControls {
  /** The same bucket the runner reads, so a test can play `onProvisioned`. */
  kv: KV;
  /** Let a held `ensureHands` return, ending the pre-ready window. */
  releaseHands: () => void;
  /**
   * The attempt id the runner handed to `ensureHands`.
   *
   * An entry the scenario writes has to carry it, because that is what
   * `makeOnProvisioned` records and what the report identifies the entry by --
   * a task id alone cannot tell this attempt from the delivery before it.
   */
  attemptId: () => string | null;
}

async function runScenario(opts: {
  lease?: { url: string; token: string };
  identity?: SandboxEntry;
  /** Park `ensureHands` until the scenario says so, to hold the run pre-ready. */
  holdHands?: boolean;
  engineBehavior?: (
    extras: ExecuteExtras | undefined, ctl: ScenarioControls,
  ) => Promise<ExecuteResult>;
  leaseVerdict?: (n: number) => string;
}) {
  const renewals: LeaseRenewal[] = [];
  const { msg } = fakeMsg();
  const { kv } = fakeKv();
  const { kv: kvCkpt } = fakeKv();
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  const noop = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;

  let releaseHands = () => {};
  const handsHeld = new Promise<void>((resolve) => { releaseHands = () => resolve(); });

  // Captured from the options the runner passes, the way the real
  // `makeOnProvisioned` gets it: an entry written below has to name the ATTEMPT
  // that minted it, or the report will not recognise it as this run's.
  let attemptId: string | null = null;
  const sideEffects = {
    ensureHands: (async (
      _sid: string, _req: unknown, _pk: unknown, _ev: unknown, _mn: unknown,
      o?: { attemptId?: string },
    ) => {
      attemptId = o?.attemptId ?? null;
      if (opts.holdHands) await handsHeld;
      return { handsUrl: "http://hands.test", created: true, token: "t", identity: opts.identity };
    }) as never,
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
    postRunLease: ((_req: unknown, renewal: LeaseRenewal) => {
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
      return opts.engineBehavior
        ? opts.engineBehavior(extras, { kv, releaseHands, attemptId: () => attemptId })
        : result();
    },
  };

  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });

  const request = {
    session_id: SESSION,
    // A real task id, so the ledger this scenario reads is the one the runner
    // opened rather than an entry a synthetic lock key happened to agree with.
    task_id: TASK,
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
  assert.equal(renewals[0].sandbox, undefined);
});

for (const identity of [
  { workloadId: "workload-1", platformKey: "private-key" },
  { provider: "agent-sandbox" as const, sessionId: "router-session-1", sandboxName: "pod-1" },
]) {
  test(`a later heartbeat reports the lazily attached ${identity.provider ?? "safe-workload"} handle`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { renewals } = await runScenario({
      lease: { url: "http://api.test/v1/internal/tasks/t-1/lease", token: "tok" },
      identity,
      async engineBehavior(extras) {
        await extras!.attachHands!();
        t.mock.timers.tick(RUN_LEASE_HEARTBEAT_MS);
        return result();
      },
    });
    assert.equal(renewals[0].sandbox, undefined);
    assert.deepEqual(renewals.at(-1)?.sandbox, {
      provider: identity.provider ?? "safe-workload",
      handle: identity.provider === "agent-sandbox" ? identity.sessionId : identity.workloadId,
    });
    assert.ok(renewals.length > 1);
  });
}
/** Drain the KV read and the POST the heartbeat now chains behind it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

test("a renewal sent while the sandbox is still provisioning names the pending workload", async (t) => {
  // The three endings this branch exists to explain -- sandbox_pending_timeout,
  // sandbox_exited_before_ready, sandbox_gone -- all happen before ensureHands
  // returns, so `handsIdentity` is null for every renewal any of them will ever
  // send. The renewal is where the API gets the handle it later asks SaFE about
  // (recordLeaseSandbox -> platform-backfill), and backfill's KV fallback
  // refuses a reused sandbox, so a row with no handle on it is a kill nobody
  // can attribute. The id does exist by then: onProvisioned writes a PENDING
  // entry naming it before it starts waiting for the pod.
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { renewals } = await runScenario({
    lease: { url: "http://api.test/v1/internal/tasks/t-1/lease", token: "tok" },
    identity: { workloadId: "workload-ready", platformKey: "private-key" },
    holdHands: true,
    async engineBehavior(extras, ctl) {
      const attaching = extras!.attachHands!();
      await settle();
      // What onProvisioned writes, field for field, while the provision is
      // still waiting on the pod -- no `provider`, which is why sandboxForLease
      // has to fall back to safe-workload for it.
      await ctl.kv.put(handsSessionKey(SESSION), JSON.stringify({
        status: "pending",
        // Recorded by `makeOnProvisioned` alongside everything else, and what
        // the report establishes ownership by -- the task, and which attempt of
        // it.
        taskId: TASK,
        attemptId: ctl.attemptId(),
        workloadId: "workload-pending-1",
        platformKey: "private-key",
        sandboxImage: null,
        createdAt: new Date().toISOString(),
      }));
      t.mock.timers.tick(RUN_LEASE_HEARTBEAT_MS);
      await settle();
      ctl.releaseHands();
      await attaching;
      // The PENDING entry is still sitting in KV, unchanged, so the last
      // renewal naming the attached sandbox is the guard short-circuiting on
      // `handsIdentity` rather than the entry happening to have moved on.
      t.mock.timers.tick(RUN_LEASE_HEARTBEAT_MS);
      await settle();
      return result();
    },
  });

  assert.equal(renewals[0].sandbox, undefined,
    "nothing was provisioned when the lease was taken, so there is nothing to name");
  assert.deepEqual(renewals[1]?.sandbox, { provider: "safe-workload", handle: "workload-pending-1" },
    "a run the cluster kills here must still leave the workload id on its row");
  assert.deepEqual(renewals.at(-1)?.sandbox, { provider: "safe-workload", handle: "workload-ready" },
    "and the attached sandbox still wins once ensureHands has returned");
});

test("a renewal does not claim a sandbox this run never attached to", async (t) => {
  // The other half of the same read. A session whose previous message left a
  // READY entry behind is exactly the case backfill's KV fallback refuses, and
  // reporting that live workload as this run's handle would file a placement
  // -- and later an ending -- against a run that never touched it. Only a
  // PENDING entry belongs to the provision this run is waiting on.
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { renewals } = await runScenario({
    lease: { url: "http://api.test/v1/internal/tasks/t-1/lease", token: "tok" },
    identity: { workloadId: "workload-ready", platformKey: "private-key" },
    holdHands: true,
    async engineBehavior(extras, ctl) {
      const attaching = extras!.attachHands!();
      await settle();
      await ctl.kv.put(handsSessionKey(SESSION), JSON.stringify({
        status: "ready",
        workloadId: "workload-someone-elses",
        platformKey: "private-key",
      }));
      t.mock.timers.tick(RUN_LEASE_HEARTBEAT_MS);
      await settle();
      ctl.releaseHands();
      await attaching;
      return result();
    },
  });

  assert.ok(
    renewals.every((r) => r.sandbox?.handle !== "workload-someone-elses"),
    "a READY entry is some earlier message's sandbox, not this run's",
  );
});

test("B22 a fat-path renewal presents the row's non-null attempt token", async () => {
  const { renewals } = await runScenario({
    lease: { url: "http://api.test/v1/internal/tasks/t-1/lease", token: "tok" },
  });

  const attempt = renewals[0]?.attempt;
  assert.ok(attempt, "the renewal carries the attempt it was sent for");
  assert.equal(attempt.claimCount, 0);
  assert.equal(attempt.deliverySeq, 7);
  assert.equal(attempt.deliveryCount, 1);
  assert.ok(attempt.attemptId);
});

test("a run without a lease says nothing", async () => {
  // Runs dispatched before the lease existed, and everything with no row of
  // its own. Heartbeating for them would post to an endpoint that is not there.
  const { renewals } = await runScenario({});
  assert.deepEqual(renewals, []);
});

test("a waiting run reports the wait, not that it is busy", async () => {
  const key = testRunKey("run-phase-unit");
  beginRun(key);
  try {
    let observed: string | undefined;
    await whileWaiting(key, "approval", "timed+park", async () => {
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
  const key = testRunKey("run-phase-throw");
  beginRun(key);
  try {
    await assert.rejects(
      whileWaiting(key, "background_command", "timed+park", async () => { throw new Error("denied"); }),
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
  const key = testRunKey("run-phase-nested");
  beginRun(key);
  try {
    await whileWaiting(key, "background_command", "timed+park", async () => {
      await whileWaiting(key, "approval", "timed+park", async () => {
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
  const value = await whileWaiting(undefined, "approval", "timed+park", async () => 42);
  assert.equal(value, 42);
  assert.equal(await whileWaiting(testRunKey("never-begun"), "approval", "timed+park", async () => 7), 7);
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

test("a run the user stopped learns it from its own renewal, not from the wire", async () => {
  // The Stop that never reaches its holder. The interrupt is core NATS and
  // at-most-once, and every pod with no abort registered for the address drops
  // it -- which this pod is between the claim writing the lease and
  // `activeAbort` being populated two KV round trips later. A Stop landing in
  // that window moves the row to `cancelling` and then has nothing left to
  // reach, because the durable half deliberately leaves a held row to its
  // holder. Without this the turn runs to completion and answers a user who
  // asked it to stop; the same is true of any lost publish, a pod restarting
  // or a blip on the subject.
  //
  // `postRunLease` has returned the row's status all along for exactly this
  // purpose, and the fat delivery path already stops on it.
  let observed: AbortSignal | undefined;
  const { abortCtrl } = await runScenario({
    lease: { url: "http://api.test/v1/internal/tasks/t-1/lease", token: "tok" },
    leaseVerdict: () => "cancelling",
    engineBehavior: async (extras) => {
      observed = (extras as { signal?: AbortSignal } | undefined)?.signal;
      await new Promise((r) => setTimeout(r, 30));
      return result();
    },
  });

  assert.equal(abortCtrl.signal.aborted, true, "a stopped row must stop its worker");
  // Deliberately the generic reason: `cancelling` is not a terminal row and
  // this replica still owns everything it holds, so the ending that reads as a
  // user interrupt is the true account. The two named reasons would file it as
  // a reap or a takeover and put the wrong sentence in the transcript.
  assert.notEqual(abortCtrl.signal.reason, RUN_ROW_TERMINAL_ABORT_REASON);
  assert.notEqual(abortCtrl.signal.reason, LEASE_LOST_ABORT_REASON);
  if (observed) assert.equal(observed.aborted, true, "the engine sees the stop too");
});

test("but a run whose row is merely running is left alone", async () => {
  // The positive control. Without it the case above holds just as well against
  // a heartbeat that aborts on every renewal it reads.
  const { abortCtrl } = await runScenario({
    lease: { url: "http://api.test/v1/internal/tasks/t-1/lease", token: "tok" },
    leaseVerdict: () => "running",
    engineBehavior: async () => {
      await new Promise((r) => setTimeout(r, 30));
      return result();
    },
  });

  assert.equal(abortCtrl.signal.aborted, false, "a live row is not a stop");
});
