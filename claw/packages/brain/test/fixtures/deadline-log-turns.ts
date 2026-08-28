// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A resumed run whose budget expired while it was queued, driven far enough to
 * make the deadline fire, with the checkpoint read settling on a macrotask.
 *
 * The macrotask is the point. `armDeadline` computes `delay = 0` for a deadline
 * already past on arrival, so the timer is a macrotask too, and whether it wins
 * decides whether `pendingResumeCkpt` exists when it logs how far the run had
 * got. Every fake in the suite settles on a microtask, so the timer never gets
 * a timers-phase turn ahead of the prologue and the race the log line loses in
 * production cannot happen in a test. `slowKv.get` awaits a real timer, which
 * is what a KV round trip does.
 *
 * The fakes are its own rather than shared: the same duplication every other
 * task-runner test file makes, and this one needs a KV that is deliberately
 * slower than the rest of them want.
 */
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import {
  bindTaskRunnerDeps,
  runHandleTask,
  type TaskRunnerSideEffects,
} from "../../src/tasks/runner.js";
import type { Engine } from "../../src/agent/index.js";
import type { NatsEmitter } from "../../src/events/emitter.js";
import { activeAbort } from "../../src/tasks/abort-registry.js";

const SESSION = "sess-deadline-log";
const MESSAGE = "msg-1";
const LOCK = `lock.${SESSION}`;
const encoder = new TextEncoder();

/** Four turns and an hour of work, in KV, from the attempt before this one. */
const RESUMED_CHECKPOINT = JSON.stringify({
  version: 3,
  session_id: SESSION,
  message_id: MESSAGE,
  user_id: "u1",
  checkpointed_at: Date.now(),
  has_workspace_sync: false,
  last_sync_turn: 0,
  messages: [{ role: "user", content: "hi" }],
  turns_completed: 4,
  usage: { input_tokens: 10, output_tokens: 20, cache_read: 0, cache_create: 0 },
  text_parts: [],
  error_count: 2,
  tool_calls_by_name: { bash: 7 },
  total_tool_calls: 9,
  elapsed_ms_before: 3_600_000,
  setup_commands: [],
});

const slowKv = {
  async get(key: string) {
    // A macrotask, so the already-expired deadline's timer can be ahead of this
    // in the queue -- the ordering the in-process fakes cannot produce.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return key === `task-ckpt.${SESSION}.${MESSAGE}`
      ? { key, value: encoder.encode(RESUMED_CHECKPOINT) }
      : null;
  },
  async put() { return 1; },
  async update() { return 1; },
  async delete() { /* nothing to clean up in a fixture */ },
} as unknown as KV;

const msg = {
  info: { deliveryCount: 2 },
  ack() {}, nak() {}, working() {}, term() {},
} as unknown as JsMsg;

const stub = <T>(value: T) => (() => Promise.resolve(value)) as never;
const sideEffects = {
  ensureHands: stub({
    handsUrl: "http://hands.test", created: true, token: "t",
    identity: { provider: "safe-workload", workloadId: "wl", platformKey: "pk" },
  }),
  destroyHands: stub(undefined),
  reapPendingHands: stub(undefined),
  probeSandboxContainer: stub({ verdict: "dead", reason: "no_kv_entry" }),
  restartHandsInSandbox: stub({ ok: true, detail: "healthy" }),
  unregisterSandbox: (() => {}) as never,
  markHandsIdle: (() => {}) as never,
  markRetryPending: stub(undefined),
  syncWorkspaceToS3: stub({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
  syncWorkspaceFromS3: stub(undefined),
  archiveRunToS3: stub(undefined),
  copyS3Prefix: stub({ copied: 0 }),
  syncWorkspace: stub({ ok: true }),
  restoreWorkspace: stub({ ok: true }),
  postAgentDone: stub(undefined),
  postTaskRunning: stub(undefined),
  runScript: stub({} as ExecuteResult),
  refreshTaskLock: stub(undefined),
  releaseTaskLock: stub(undefined),
  flushTranscript: stub(undefined),
  makeHandsClient: (() => ({
    close: async () => {},
    reapShells: async () => 1,
  })) as never,
} as TaskRunnerSideEffects;

/** Runs until the deadline aborts it, so the timer is what ends the run. */
const engine: Engine = {
  async execute(_req, _onEvent, signal) {
    await new Promise<void>((done) => {
      if (signal?.aborted) { done(); return; }
      signal?.addEventListener("abort", () => done());
    });
    return {
      finalText: "", turns: 0, pendingMemories: [], pendingSkills: [],
      skillsUsed: {}, errorCount: 0, elapsedMs: 1,
    } as ExecuteResult;
  },
};

bindTaskRunnerDeps({
  kv: slowKv,
  kvCkpt: slowKv,
  emitter: { async emit() {} } as unknown as NatsEmitter,
  engine,
  sideEffects,
});

const abortCtrl = new AbortController();
activeAbort.set(LOCK, abortCtrl);
await runHandleTask(
  msg,
  {
    session_id: SESSION, prompt: "hi", user_id: "u1", platform_key: "pk",
    // Already past on arrival: the redelivery case the log line reports on.
    deadline_at: new Date(Date.now() - 1_000).toISOString(),
  } as ExecuteRequest,
  SESSION, LOCK, MESSAGE, "u1", abortCtrl,
);
