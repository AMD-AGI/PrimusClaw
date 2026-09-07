// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Three runs that end the three ways the post-task park can end, each leaving
 * its `keepalive.stopped_after_task` line on stdout.
 *
 * A child process because the line goes only to pino, which writes to fd 1
 * through sonic-boom: neither stubbing `process.stdout.write` nor `fs.writeSync`
 * sees it. Same shape as deadline-log-turns.ts, for the same reason.
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

const kv = {
  async get() { return null; },
  async put() { return 1; },
  async update() { return 1; },
  async delete() { /* nothing to clean up in a fixture */ },
} as unknown as KV;

const msg = {
  info: { deliveryCount: 1 },
  ack() {}, nak() {}, working() {}, term() {},
} as unknown as JsMsg;

const stub = <T>(value: T) => (() => Promise.resolve(value)) as never;

const engine: Engine = {
  async execute() {
    return {
      finalText: "done", turns: 1, pendingMemories: [], pendingSkills: [],
      skillsUsed: {}, errorCount: 0, elapsedMs: 1,
    } as ExecuteResult;
  },
};

function sideEffects(opts: {
  identity: Record<string, string> | undefined;
  park: unknown;
}): TaskRunnerSideEffects {
  return {
    ensureHands: stub({
      handsUrl: "http://hands.test", created: true, token: "t", identity: opts.identity,
    }),
    destroyHands: stub(undefined),
    reapPendingHands: stub(undefined),
    probeSandboxContainer: stub({ verdict: "alive", reason: "ok" }),
    fetchPlatformFacts: stub(undefined),
    restartHandsInSandbox: stub({ ok: true, detail: "healthy" }),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => Promise.resolve(opts.park)) as never,
    markRetryPending: stub(undefined),
    syncWorkspaceToS3: stub({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: stub(undefined),
    archiveRunToS3: stub(undefined),
    copyS3Prefix: stub({ copied: 0 }),
    syncWorkspace: stub({ ok: true }),
    restoreWorkspace: stub({ ok: true }),
    postAgentDone: stub(undefined),
    postTaskRunning: stub(undefined),
    postRunLease: stub(undefined),
    runScript: stub({} as ExecuteResult),
    refreshTaskLock: stub(undefined),
    releaseTaskLock: stub(undefined),
    flushTranscript: stub(undefined),
    makeHandsClient: (() => ({
      close: async () => {},
      reapShells: async () => 0,
    })) as never,
  } as TaskRunnerSideEffects;
}

const WORKLOAD = { provider: "safe-workload", workloadId: "wl", platformKey: "pk" };

const SCENARIOS = [
  { session: "sess-parked", identity: WORKLOAD, park: { outcome: "parked" } },
  {
    session: "sess-refused",
    identity: WORKLOAD,
    park: { outcome: "skipped", reason: "not_ready" },
  },
  { session: "sess-no-sandbox", identity: undefined, park: { outcome: "parked" } },
];

for (const { session, identity, park } of SCENARIOS) {
  bindTaskRunnerDeps({
    kv,
    kvCkpt: kv,
    emitter: { async emit() {} } as unknown as NatsEmitter,
    engine,
    sideEffects: sideEffects({ identity, park }),
  });

  const lock = `lock.${session}`;
  const abortCtrl = new AbortController();
  activeAbort.set(lock, abortCtrl);
  await runHandleTask(
    msg,
    { session_id: session, prompt: "hi", user_id: "u1", platform_key: "pk" } as ExecuteRequest,
    session, lock, "msg-1", "u1", abortCtrl,
  );
  // The line is emitted from the park's own continuation, not from the run.
  await new Promise((resolve) => setTimeout(resolve, 50));
}
