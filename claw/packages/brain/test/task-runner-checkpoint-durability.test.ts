// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Two ways a run used to lose state without saying anything.
//
//   1. SIGTERM persisted the conversation to KV and the workspace nowhere. The
//      only workspace path was the shared-filesystem sync, gated on
//      WORKSPACE_PERSIST_BASE — which is empty by default, in the code and in
//      the Helm values alike. So on the default configuration a rolling restart
//      checkpointed the conversation and dropped the files, and the resumed run
//      came back against whatever the session prefix held from before it
//      started: an agent that remembers creating files, looking at a workspace
//      that does not have them.
//
//   2. A rejected KV write was logged at warn and swallowed. The rejection that
//      matters is a payload over the bucket's 16MiB max_value_size, and the
//      result was a run that kept executing while no longer being resumable,
//      with nothing emitted and the cadence timer reset as if it had succeeded.
//
// Both are asserted on the observable contract: which side effects ran, and
// which events reached the session.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import {
  bindTaskRunnerDeps,
  runHandleTask,
  type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";
import type { CheckpointState, Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import {
  LEASE_LOST_ABORT_REASON, RUN_ROW_TERMINAL_ABORT_REASON,
  SIGTERM_ABORT_REASON, activeAbort,
} from "../src/tasks/abort-registry.js";

const SESSION = "sess-durability";

/**
 * Everything the run does to the outside world, in the order it did it.
 *
 * Side effects, KV writes and the message verdict all land in one list because
 * some of what is being pinned here is an ordering between them, and separate
 * logs can only say that two things happened.
 */
function fakeMsg(timeline: string[]) {
  const verdicts: string[] = [];
  const settle = (verdict: string) => {
    verdicts.push(verdict);
    timeline.push(verdict);
  };
  const msg = {
    info: { deliveryCount: 1 },
    ack() { settle("ack"); },
    nak(ms?: number) { settle(`nak:${ms ?? "none"}`); },
    working() {},
    term() { settle("term"); },
  };
  return { msg: msg as unknown as JsMsg, verdicts };
}

/** `putFails` models the bucket rejecting an oversized value. */
function fakeKv(timeline: string[], label: string, putFails = false) {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const kv = {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value } : null;
    },
    async put(key: string, value: Uint8Array | string) {
      if (putFails) throw new Error("maximum value size exceeded");
      timeline.push(`${label}.put:${key}`);
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 1;
    },
    async delete(key: string) {
      timeline.push(`${label}.delete:${key}`);
      store.delete(key);
    },
  };
  return { kv: kv as unknown as KV, store };
}

function result(over: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    finalText: "done",
    tokenUsage: { input_tokens: 1, output_tokens: 2, cache_read: 0, cache_create: 0 },
    turns: 1,
    pendingMemories: [],
    pendingSkills: [],
    skillsUsed: {},
    errorCount: 0,
    toolStats: { total_calls: 0, error_calls: 0, by_tool: {} },
    elapsedMs: 5,
    ...over,
  } as ExecuteResult;
}

function checkpointState(turn: number): CheckpointState {
  return {
    messages: [{ role: "user", content: "hi" }],
    turns_completed: turn,
    usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0, turns: turn },
    text_parts: [],
    error_count: 0,
    tool_calls_by_name: {},
    total_tool_calls: 0,
    elapsed_ms_before: 10,
    setup_commands: [],
    plan_mode: false,
    todo_state: [],
    rebuilds_used: 0,
  } as CheckpointState;
}

function stubSideEffects(calls: string[], over: Partial<TaskRunnerSideEffects> = {}) {
  const record = <T>(name: string, value: T) => (...args: unknown[]) => {
    calls.push(name);
    void args;
    return Promise.resolve(value) as never;
  };
  const base: TaskRunnerSideEffects = {
    ensureHands: record("ensureHands", {
      handsUrl: "http://hands.test",
      created: true,
      token: "t",
      identity: { provider: "safe-workload", workloadId: "wl-test", platformKey: "pk" },
    }),
    destroyHands: record("destroyHands", undefined),
    reapPendingHands: record("reapPendingHands", undefined),
    probeSandboxContainer: record("probeSandboxContainer", "dead"),
    unregisterSandbox: ((..._a: unknown[]) => { calls.push("unregisterSandbox"); }) as never,
    markHandsIdle: ((..._a: unknown[]) => { calls.push("markHandsIdle"); }) as never,
    markRetryPending: record("markRetryPending", undefined),
    syncWorkspaceToS3: record("syncWorkspaceToS3",
      { uploaded: 2, totalFiles: 2, failedCount: 0, exhausted: false, empty: false }),
    syncWorkspaceFromS3: record("syncWorkspaceFromS3", undefined),
    archiveRunToS3: record("archiveRunToS3", undefined),
    copyS3Prefix: record("copyS3Prefix", { copied: 0 }),
    syncWorkspace: record("syncWorkspace", { ok: true }),
    restoreWorkspace: record("restoreWorkspace", { ok: true }),
    postAgentDone: record("postAgentDone", undefined),
    runScript: record("runScript", result()),
    refreshTaskLock: record("refreshTaskLock", undefined),
    releaseTaskLock: record("releaseTaskLock", undefined),
    flushTranscript: ((..._a: unknown[]) => {
      calls.push("flushTranscript");
      return Promise.resolve();
    }) as never,
    makeHandsClient: (() => {
      calls.push("makeHandsClient");
      return {
        endpoint: () => ({ url: "http://hands.test", token: "t" }),
        close: async () => { calls.push("hands.close"); },
      } as never;
    }) as never,
    ...over,
  };
  return { sideEffects: base, calls };
}

async function runScenario(opts: {
  engineBehavior: (
    signal: AbortSignal | undefined,
    extras: ExecuteExtras | undefined,
    abortCtrl: AbortController,
  ) => Promise<ExecuteResult>;
  ckptPutFails?: boolean;
  seedCheckpoint?: boolean;
  /** Set to exercise the outbox: without one there is no durable handoff. */
  taskId?: string;
}) {
  const calls: string[] = [];
  const { msg, verdicts } = fakeMsg(calls);
  const { kv } = fakeKv(calls, "kv");
  const { kv: kvCkpt, store: ckptStore } = fakeKv(calls, "ckpt", opts.ckptPutFails ?? false);
  if (opts.seedCheckpoint) {
    ckptStore.set(`task-ckpt.${SESSION}.msg-durability`,
      new TextEncoder().encode("{}"));
  }
  const events: Array<Record<string, unknown>> = [];
  const emitter = {
    async emit(_sid: string, evt: Record<string, unknown>) { events.push(evt); },
  } as unknown as NatsEmitter;
  const { sideEffects } = stubSideEffects(calls);

  const abortCtrl = new AbortController();
  const engine: Engine = {
    async execute(_req, _onEvent, signal, _hands, extras) {
      calls.push("engine.execute");
      return opts.engineBehavior(signal, extras, abortCtrl);
    },
  };

  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });

  const request = {
    session_id: SESSION,
    prompt: "hi",
    user_id: "u1",
    platform_key: "pk",
    task_id: opts.taskId,
  } as ExecuteRequest;

  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);

  await runHandleTask(msg, request, SESSION, lockKey, "msg-durability", "u1", abortCtrl);

  return {
    verdicts, events, calls, ckptStore,
    types: events.map((e) => e.type),
    completion: events.find((e) => e.type === "exec_complete"),
  };
}

test("SIGTERM falls back to S3 when the shared-filesystem sync is not configured", async () => {
  // WORKSPACE_PERSIST_BASE is unset here, which is the default. Before the
  // fallback existed this run persisted no workspace at all.
  const r = await runScenario({
    async engineBehavior(_signal, extras, abortCtrl) {
      await extras!.attachHands!();   // a run with files is a run that opened a sandbox
      await extras!.onCheckpoint!(checkpointState(4));
      abortCtrl.abort(SIGTERM_ABORT_REASON);
      throw SIGTERM_ABORT_REASON;
    },
  });

  assert.deepEqual(r.verdicts, ["nak:0"], "SIGTERM still requeues for the next pod");
  assert.ok(
    r.calls.includes("syncWorkspaceToS3"),
    "with no shared filesystem configured the workspace must still reach S3",
  );
  assert.ok(
    !r.calls.includes("syncWorkspace"),
    "the shared-filesystem sync is unconfigured, so it must not have been attempted",
  );
});

test("a run that never opened a sandbox has no workspace to persist", async () => {
  // The counterpart to the case above: a chat turn answered without touching a
  // file has no /workspace, and an upload attempt against a sandbox that was
  // never created would fail on every SIGTERM of every such run.
  const r = await runScenario({
    async engineBehavior(_signal, extras, abortCtrl) {
      await extras!.onCheckpoint!(checkpointState(4));
      abortCtrl.abort(SIGTERM_ABORT_REASON);
      throw SIGTERM_ABORT_REASON;
    },
  });

  assert.deepEqual(r.verdicts, ["nak:0"], "SIGTERM still requeues for the next pod");
  assert.ok(!r.calls.includes("ensureHands"), "no tool ran, so no sandbox was opened");
  assert.ok(!r.calls.includes("syncWorkspaceToS3"), "there is nothing to upload");
  assert.ok(
    r.events.some((e) => e.type === "taskInterrupted"),
    "the conversation checkpoint still has to be announced",
  );
});

test("a rejected checkpoint write is raised to the caller and announced", async () => {
  let raised: unknown;
  const r = await runScenario({
    ckptPutFails: true,
    async engineBehavior(_signal, extras) {
      try {
        await extras!.onCheckpoint!(checkpointState(2));
      } catch (e) {
        raised = e;
      }
      return result();
    },
  });

  assert.ok(raised instanceof Error,
    "a failed checkpoint write must reach the loop so it does not treat it as success");
  const failure = r.events.find((e) => e.status === "checkpoint_write_failed");
  assert.ok(failure, "the session must be told the run is no longer resumable");
  assert.equal(typeof failure!.payload_bytes, "number",
    "payload size is what distinguishes an oversized payload from a transient failure");
});

test("losing the lease stands the run down without disturbing the replica that has it", async () => {
  // Another replica now holds the lease, so it owns the sandbox, the workspace
  // and this checkpoint key. Every ordinary terminal path would damage that:
  // syncing overwrites its files, deleting the checkpoint strands it, marking
  // the sandbox idle tells the fleet to stop pinging one that is in use, and a
  // terminal event tells the API the run ended while it is still going.
  const r = await runScenario({
    seedCheckpoint: true,
    async engineBehavior(_signal, _extras, abortCtrl) {
      abortCtrl.abort(LEASE_LOST_ABORT_REASON);
      throw new Error("aborted mid-turn");
    },
  });

  assert.equal(r.ckptStore.size, 1, "the live replica's checkpoint must survive");
  assert.equal(r.completion, undefined, "a stand-down is not this run's completion to report");
  assert.ok(!r.types.includes("taskInterrupted"),
    "the run has not been interrupted — it changed hands");
  assert.ok(!r.calls.includes("postAgentDone"), "the holder reports the outcome, not us");
  assert.ok(!r.calls.includes("syncWorkspace") && !r.calls.includes("syncWorkspaceToS3"),
    "the workspace belongs to the holder now");
  assert.ok(!r.calls.includes("markHandsIdle"),
    "the sandbox is in use, so it must not be marked idle");
  assert.deepEqual(r.verdicts, [],
    "the message is left to ack_wait, which produces the redelivery task-dispatch stands down");
  assert.ok(r.calls.includes("releaseTaskLock"),
    "release still runs, and is holder-checked so it will not take the holder's lock");
});

test("a row that went terminal underneath the run gives everything back", async () => {
  // The mirror image of the case above, and it used to share that path. Here
  // the sweeper reaped the row or the user cancelled it, so there is no other
  // replica: nobody inherits the sandbox, and nobody else holds a copy of this
  // delivery. Standing down quietly pinned the workload until the idle
  // collector happened past, and left the message to come back every ack_wait
  // and provision a sandbox again until the delivery budget ran out -- at which
  // point the poison guard wrote off a task that simply had nowhere to go.
  const r = await runScenario({
    seedCheckpoint: true,
    async engineBehavior(_signal, _extras, abortCtrl) {
      abortCtrl.abort(RUN_ROW_TERMINAL_ABORT_REASON);
      throw new Error("aborted mid-turn");
    },
  });

  assert.deepEqual(r.verdicts, ["term"],
    "left unsettled, this message comes back every ack_wait to do it all again");
  assert.ok(!r.calls.includes("postAgentDone"),
    "the row already has a terminal state; reporting another would overwrite it");
  assert.equal(r.completion, undefined);
});

test("the result is durable before the message is settled", async () => {
  // The outbox is the whole reason a delivery can be acked at all: the result
  // is written where a redelivery can find it, then reported, and only then is
  // the message settled. Acking first would make a crash before the callback
  // lands unrecoverable -- the queue considers the task done, and the result
  // exists nowhere. The key is dropped afterwards, since a settled message has
  // nothing left to replay.
  const r = await runScenario({
    taskId: "task-outbox-1",
    async engineBehavior() { return result(); },
  });

  const at = (name: string) => r.calls.findIndex((c) => c.startsWith(name));
  const written = at("ckpt.put:task-result.task-outbox-1");
  const reported = at("postAgentDone");
  const settled = at("ack");
  const cleared = at("ckpt.delete:task-result.task-outbox-1");

  assert.ok(written >= 0 && reported >= 0 && settled >= 0 && cleared >= 0,
    `every step should have happened: ${r.calls.join(" -> ")}`);
  assert.ok(written < reported, "a result reported before it is stored can be lost by a crash");
  assert.ok(reported < settled, "settling before the callback lands throws the result away");
  assert.ok(settled < cleared, "clearing the outbox first reopens the gap it exists to close");
});

test("a checkpoint write that lands neither raises nor announces a failure", async () => {
  let raised: unknown;
  const r = await runScenario({
    async engineBehavior(_signal, extras) {
      try {
        await extras!.onCheckpoint!(checkpointState(2));
      } catch (e) {
        raised = e;
      }
      return result();
    },
  });

  assert.equal(raised, undefined, "the happy path must stay silent");
  assert.equal(r.events.find((e) => e.status === "checkpoint_write_failed"), undefined);
  assert.deepEqual(r.verdicts, ["ack"]);
});
