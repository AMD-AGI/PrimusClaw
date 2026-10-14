// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A script run taken over part-way, by the real runner over the real script
 * executor.
 *
 * A DAG script step can run for a day. The pod running it is replaced on every
 * brain rollout, and the run's queue message has usually aged out of the task
 * stream by then, so there is nothing for a nak to redeliver. What has to hold:
 *
 *   T1 a draining pod hands the run over: lease released, the same request
 *      published again, the old delivery acked -- not left to a nak
 *   T2 the worker taking it over continues from the step it was on, in the same
 *      sandbox, with the earlier steps' captures; no finished step runs again
 *   T3 a takeover that finds the sandbox gone fails the run, saying so, and
 *      issues no tool call into the new sandbox
 *   T4 a drain lets a single-call step finish and records it, so the successor
 *      does not run it a second time
 *   T5 a drain that lands in the last step reports the run's own outcome rather
 *      than handing a finished run over
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult, ScriptStep } from "@claw/protocol";

const runner = await import("../src/tasks/runner.js");
const { SIGTERM_ABORT_REASON, activeAbort } = await import("../src/tasks/abort-registry.js");
type SideEffects = import("../src/tasks/runner.js")["TaskRunnerSideEffects"];

const SESSION = "sess-script-takeover";
const TASK = "task-script-takeover";
const SUBJECT = "tasks.execute";
const PAYLOAD = new TextEncoder().encode('{"the":"request"}');

/** One bucket shared by every worker in a test, which is what a takeover reads. */
function sharedKv() {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const kv = {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value, revision: 1 } : null;
    },
    async put(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 1;
    },
    async update(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 1;
    },
    async delete(key: string) { store.delete(key); },
  };
  return { kv: kv as unknown as KV, store };
}

interface Delivery {
  msg: JsMsg;
  settled: string[];
}

function delivery(seq: number): Delivery {
  const settled: string[] = [];
  const msg = {
    seq,
    subject: SUBJECT,
    data: PAYLOAD,
    info: { deliveryCount: 1 },
    ack() { settled.push("ack"); },
    nak() { settled.push("nak"); },
    term() { settled.push("term"); },
    working() {},
  } as unknown as JsMsg;
  return { msg, settled };
}

type Answer = { text?: string; structured?: unknown; isError?: boolean };

interface Worker {
  /** Every tool call this worker's sandbox client received, by step identity. */
  calls: Array<{ name: string; args: Record<string, unknown>; step?: string }>;
  republished: Array<{ subject: string; data: Uint8Array }>;
  released: Array<{ taskId: string; releaseLease: unknown }>;
  done: ExecuteResult[];
  delivery: Delivery;
  abort: AbortController;
}

/**
 * Run one worker's attempt at the script. `answer` decides what each call
 * returns and may raise the drain, the way a rollout raises it mid-call.
 */
async function runWorker(opts: {
  kvCkpt: KV;
  script: ScriptStep[];
  sandboxCreated: boolean;
  seq: number;
  requestExtra?: Record<string, unknown>;
  answer: (name: string, args: Record<string, unknown>, w: Worker, signal?: AbortSignal) => Promise<Answer>;
}): Promise<Worker> {
  const w: Worker = {
    calls: [], republished: [], released: [], done: [],
    delivery: delivery(opts.seq), abort: new AbortController(),
  };
  const noop = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;
  const sideEffects: Partial<SideEffects> = {
    ensureHands: noop({
      handsUrl: "http://hands.test", created: opts.sandboxCreated, token: "t",
      identity: { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" },
    }),
    destroyHands: noop(undefined),
    reapPendingHands: noop(undefined),
    probeSandboxContainer: noop("alive"),
    fetchPlatformFacts: noop(null),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => Promise.resolve({ outcome: "parked" })) as never,
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop(undefined),
    archiveRunToS3: noop(undefined),
    copyS3Prefix: noop({ copied: 0 }),
    syncWorkspace: noop({ ok: true }),
    restoreWorkspace: noop({ ok: true }),
    postAgentDone: ((_req: ExecuteRequest, result: ExecuteResult) => {
      w.done.push(result);
      return Promise.resolve();
    }) as never,
    postTaskRunning: noop(undefined),
    postRunLease: noop("running"),
    settleRunAttempt: ((taskId: string, _gen: unknown, _rt: unknown, releaseLease: unknown) => {
      w.released.push({ taskId, releaseLease });
      return Promise.resolve();
    }) as never,
    republishTask: (async (subject: string, data: Uint8Array) => {
      w.republished.push({ subject, data });
    }) as never,
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({
      endpoint: () => ({ url: "http://hands.test", token: "t" }),
      close: async () => {},
      reapShells: async () => ({ shells: [], stopped: 0, escalated: 0, surviving: 0 }),
      callToolFull: async (
        name: string, args: Record<string, unknown>, signal?: AbortSignal,
        ctx?: { stepIdentity?: string },
      ) => {
        w.calls.push({ name, args, step: ctx?.stepIdentity });
        const a = await opts.answer(name, args, w, signal);
        return { text: a.text ?? "", structured: a.structured, isError: !!a.isError };
      },
    })) as never,
  };
  runner.bindTaskRunnerDeps({
    kv: sharedKv().kv, kvCkpt: opts.kvCkpt,
    emitter: { async emit() {} } as never,
    engine: { async execute() { throw new Error("a script run must not reach the model engine"); } } as never,
    sideEffects,
  });
  const request = {
    session_id: SESSION, task_id: TASK, message_id: TASK, user_id: "u1",
    mode: "script", script: opts.script,
    callback_url: "http://api.test/v1/internal/dags",
    ...(opts.requestExtra ?? {}),
  } as unknown as ExecuteRequest;
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, w.abort);
  await runner.runHandleTask(w.delivery.msg, request, SESSION, lockKey, TASK, "u1", w.abort);
  activeAbort.delete(lockKey);
  return w;
}

/** The shape of the probe that found this: start a long job, then wait on it. */
const START_THEN_WAIT: ScriptStep[] = [
  {
    name: "bash",
    arguments: { command: "./long-job.sh", run_in_background: true },
    captures: "job",
  } as ScriptStep,
  {
    name: "wait",
    arguments: { shell_id: "${captures.job.shell_id}" },
    repeat: { until: { path: "finished", equals: true }, max_attempts: 1000, max_seconds: 3600 },
  } as ScriptStep,
];

/** Rejects when the signal fires, the way an aborted MCP request does. */
function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(new Error("This operation was aborted"));
    signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true });
  });
}

test("T1/T2 a drained run is handed over and continues where it was, in the same sandbox", async () => {
  const { kv } = sharedKv();

  // The first worker starts the job and is drained while it waits on it.
  let waits = 0;
  const first = await runWorker({
    kvCkpt: kv, script: START_THEN_WAIT, sandboxCreated: true, seq: 10,
    answer: async (name, _args, w, signal) => {
      if (name === "bash") return { text: "started sh-live", structured: { shell_id: "sh-live" } };
      waits += 1;
      if (waits < 3) return { structured: { finished: false } };
      w.abort.abort(SIGTERM_ABORT_REASON);
      return untilAborted(signal);
    },
  });
  assert.deepEqual(first.done, [], "a drained run must not report an outcome");
  assert.deepEqual(first.released, [{ taskId: TASK, releaseLease: true }],
    "the lease has to be given back so the next worker's first renewal is not refused");
  assert.equal(first.republished.length, 1, "the run was not handed over: nothing will pick it up");
  assert.equal(first.republished[0].subject, SUBJECT);
  assert.deepEqual(first.republished[0].data, PAYLOAD, "the hand-over must carry the same request");
  assert.deepEqual(first.delivery.settled, ["ack"],
    "the old delivery is acked once a copy is out; a nak alone reaches nothing after the stream's max_age");

  // The second worker takes the new message and finds the same sandbox alive.
  const second = await runWorker({
    kvCkpt: kv, script: START_THEN_WAIT, sandboxCreated: false, seq: 11,
    answer: async (name) => {
      if (name === "bash") return { text: "started sh-NEW", structured: { shell_id: "sh-NEW" } };
      return { text: "exit 0", structured: { finished: true, exit_code: 0 } };
    },
  });
  assert.deepEqual(second.calls.map((c) => c.name), ["wait"],
    "the takeover ran a step that had already finished -- the background job would be started twice");
  assert.equal(second.calls[0].args.shell_id, "sh-live",
    "the takeover must re-attach to the shell the first worker started, from its capture");
  assert.equal(second.done.length, 1, "the resumed run never reported");
  assert.equal(second.done[0].abortReason, "completed");
  assert.equal(second.done[0].failureReason, undefined);
  assert.match(second.done[0].captures?.job ?? "", /sh-live/, "the earlier step's capture was lost");
  assert.deepEqual(second.republished, []);
});

test("T3 a takeover that finds its sandbox gone fails the run and says why", async () => {
  const { kv } = sharedKv();
  await runWorker({
    kvCkpt: kv, script: START_THEN_WAIT, sandboxCreated: true, seq: 20,
    answer: async (name, _args, w, signal) => {
      if (name === "bash") return { text: "started", structured: { shell_id: "sh-live" } };
      w.abort.abort(SIGTERM_ABORT_REASON);
      return untilAborted(signal);
    },
  });

  // The sandbox died meanwhile: attaching to the session provisioned a new one.
  const second = await runWorker({
    kvCkpt: kv, script: START_THEN_WAIT, sandboxCreated: true, seq: 21,
    answer: async () => ({ structured: { finished: true } }),
  });
  assert.deepEqual(second.calls, [],
    "nothing may run in a new sandbox: the job the later steps wait on is not there");
  assert.equal(second.done.length, 1, "a lost run must still report, or the DAG waits on it");
  assert.match(second.done[0].failureReason ?? second.done[0].finalText ?? "", /script_sandbox_lost/);
  assert.deepEqual(second.republished, []);
});

test("T4 a drain lets a single-call step finish, and the successor does not run it again", async () => {
  const { kv } = sharedKv();
  const script: ScriptStep[] = [
    { name: "bash", arguments: { command: "./migrate.sh" }, captures: "migrated" } as ScriptStep,
    { name: "bash", arguments: { command: "./report.sh" } } as ScriptStep,
  ];
  let callSawAbort = false;
  const first = await runWorker({
    kvCkpt: kv, script, sandboxCreated: true, seq: 30,
    answer: async (_name, args, w, signal) => {
      // The rollout arrives while the first, non-repeatable step is running.
      w.abort.abort(SIGTERM_ABORT_REASON);
      await new Promise((r) => setTimeout(r, 20));
      callSawAbort = signal?.aborted === true;
      return { text: `ran ${String(args.command)}` };
    },
  });
  assert.equal(callSawAbort, false, "the drain cut off a call that may already have done its work");
  assert.deepEqual(first.calls.map((c) => c.args.command), ["./migrate.sh"],
    "a draining worker must not start the next step");
  assert.equal(first.republished.length, 1);

  const second = await runWorker({
    kvCkpt: kv, script, sandboxCreated: false, seq: 31,
    answer: async (_name, args) => ({ text: `ran ${String(args.command)}` }),
  });
  assert.deepEqual(second.calls.map((c) => c.args.command), ["./report.sh"],
    "the finished step ran twice");
  assert.equal(second.done[0].abortReason, "completed");
  assert.match(second.done[0].captures?.migrated ?? "", /ran \.\/migrate\.sh/);
});

test("T4b a user's Stop still cuts a single-call step off at once", async () => {
  const { kv } = sharedKv();
  let sawAbort = false;
  const w = await runWorker({
    kvCkpt: kv,
    script: [{ name: "bash", arguments: { command: "sleep 600" } } as ScriptStep],
    sandboxCreated: true, seq: 35,
    answer: async (_name, _args, worker, signal) => {
      worker.abort.abort();
      sawAbort = signal?.aborted === true;
      return untilAborted(signal);
    },
  });
  assert.equal(sawAbort, true, "only a drain is let finish; a Stop is not");
  assert.deepEqual(w.republished, []);
});

test("T5 a drain in the last step reports the run's own outcome instead of handing it over", async () => {
  const { kv } = sharedKv();
  const w = await runWorker({
    kvCkpt: kv,
    script: [{ name: "bash", arguments: { command: "./last.sh" } } as ScriptStep],
    sandboxCreated: true, seq: 40,
    answer: async (_name, _args, worker) => {
      worker.abort.abort(SIGTERM_ABORT_REASON);
      return { text: "done" };
    },
  });
  assert.deepEqual(w.republished, [], "a finished run was handed over, so its last step would run again");
  assert.equal(w.done.length, 1);
  assert.equal(w.done[0].abortReason, "completed");
});

// ---------------------------------------------------------------------------
// The executor alone: a resumed repeating step keeps the bounds it began with.
// ---------------------------------------------------------------------------

import { runScript } from "../src/tasks/script-runner.js";

function waitOnly(max: { attempts: number; seconds: number }): ExecuteRequest {
  return {
    session_id: "s", task_id: "t", message_id: "m", user_id: "u", mode: "script",
    script: [{
      name: "wait", arguments: { shell_id: "sh" },
      repeat: { until: { path: "finished", equals: true }, max_attempts: max.attempts, max_seconds: max.seconds },
    }],
  } as unknown as ExecuteRequest;
}

const neverDone = {
  calls: 0,
  async callToolFull() { this.calls += 1; return { text: "", structured: { finished: false }, isError: false }; },
};

test("T6 a resumed repeat counts the time it already ran against max_seconds", async () => {
  const hands = { ...neverDone, calls: 0 };
  const result = await runScript(waitOnly({ attempts: 1000, seconds: 60 }), {
    hands: hands as never,
    resume: { step: 0, captures: {}, last_text: "", repeat_started_at: Date.now() - 61_000, repeat_attempts: 3 },
  }, async () => {});
  assert.equal(hands.calls, 0, "the step's 60s were already spent; a takeover must not grant it another 60");
  assert.match(result.failureReason ?? "", /max_seconds/);
});

test("T6b a resumed repeat counts the calls it already made against max_attempts", async () => {
  const hands = { ...neverDone, calls: 0 };
  const result = await runScript(waitOnly({ attempts: 5, seconds: 3600 }), {
    hands: hands as never,
    resume: { step: 0, captures: {}, last_text: "", repeat_started_at: Date.now(), repeat_attempts: 4 },
  }, async () => {});
  assert.equal(hands.calls, 1, "four of five calls were made before the takeover");
  assert.match(result.failureReason ?? "", /max_attempts/);
});

test("T6c progress is reported after every finished step", async () => {
  const seen: number[] = [];
  const req = {
    session_id: "s", task_id: "t", message_id: "m", user_id: "u", mode: "script",
    script: [
      { name: "bash", arguments: { command: "a" }, captures: "a" },
      { name: "bash", arguments: { command: "b" } },
    ],
  } as unknown as ExecuteRequest;
  const hands = { async callToolFull() { return { text: "ok", structured: undefined, isError: false }; } };
  await runScript(req, { hands: hands as never, onProgress: async (p) => { seen.push(p.step); } }, async () => {});
  assert.deepEqual(seen, [1, 2]);
});

test("T6d a drain gives up on a single call that will not come back in time", async () => {
  const ctl = new AbortController();
  const req = {
    session_id: "s", task_id: "t", message_id: "m", user_id: "u", mode: "script",
    script: [
      { name: "bash", arguments: { command: "./hangs.sh" } },
      { name: "bash", arguments: { command: "./next.sh" } },
    ],
  } as unknown as ExecuteRequest;
  const seen: number[] = [];
  let cutOff = false;
  const hands = {
    async callToolFull(_n: string, _a: unknown, signal?: AbortSignal) {
      ctl.abort(SIGTERM_ABORT_REASON);
      // Bounded, so a drain that never cuts the call off fails here rather than hanging.
      await Promise.race([
        untilAborted(signal).catch(() => { cutOff = true; }),
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
      throw new Error("This operation was aborted");
    },
  };
  const result = await runScript(req, {
    hands: hands as never, signal: ctl.signal, drainStepWaitMs: 20,
    onProgress: async (p) => { seen.push(p.step); },
  }, async () => {});
  assert.equal(cutOff, true, "an unbounded wait outlives the pod's grace and nothing is handed over");
  assert.equal(result.abortReason, "cancelled",
    "a call cut off by the drain is not the step's answer: the run must stop, to be handed over");
  assert.deepEqual(seen, [], "a step that was cut off must not be recorded as finished");
});

test("T7 a v3 checkpoint puts a script's progress through the same redaction as a conversation", async () => {
  const { kv, store } = sharedKv();
  const TOKEN = "backend-token-0123456789abcdef";
  await runWorker({
    kvCkpt: kv, script: START_THEN_WAIT, sandboxCreated: true, seq: 50,
    requestExtra: { backend_internal_token: TOKEN },
    answer: async (name, _args, w, signal) => {
      if (name === "bash") {
        return { text: `started with ${TOKEN}`, structured: { shell_id: "sh-live", echoed: TOKEN } };
      }
      w.abort.abort(SIGTERM_ABORT_REASON);
      return untilAborted(signal);
    },
  });
  const stored = [...store.entries()].find(([key]) => key.startsWith("task-ckpt."));
  assert.ok(stored, "the drained run left no checkpoint to be taken over from");
  const text = new TextDecoder().decode(stored[1]);
  assert.ok(text.includes("sh-live"), "the capture the next step needs must survive");
  assert.ok(!text.includes(TOKEN), "a run secret reached the checkpoint in the clear");
});
