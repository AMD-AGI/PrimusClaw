// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A task that declared its workspace throwaway does not publish it.
 *
 * The default is to upload all of /workspace to S3 when a run ends. For a task
 * that has already delivered its own output -- a Kernel Arena run posts its
 * report to a presigned URL of its own -- that copies gigabytes a second time to
 * a prefix nobody reads, and it is what `workspace_throwaway` turns off.
 *
 * It has to stay a per-task declaration rather than anything mode-wide, because
 * WORKSPACE_PERSIST_BASE is empty in code and in the shipped Helm values alike:
 * the shared-filesystem sync is off in a default deployment, so S3 is the only
 * durable copy a workspace has. Opting out means the next sandbox in the session
 * rehydrates without these files. That is right for a throwaway workspace and
 * wrong for everything else.
 *
 * Coverage:
 *   R1 a run that declared it throwaway does not sync at the end
 *   R2 a run that did not declare it still syncs -- the guard is inert by default
 *   R3 the flag does not disable the sandbox teardown that follows the sync
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { TaskRunnerSideEffects } from "../src/tasks/runner.js";

const SESSION = "sess-throwaway";
const MESSAGE = "msg-throwaway";

const calls: string[] = [];

const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { activeAbort } = await import("../src/tasks/abort-registry.js");

function fakeKv(): KV {
  return {
    async get() { return null; },
    async put() { return 1; },
    async delete() {},
  } as unknown as KV;
}

function fakeMsg(): JsMsg {
  return {
    info: { deliveryCount: 1 },
    ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
}

function stubSideEffects(): Partial<TaskRunnerSideEffects> {
  const record = <T>(name: string, value: T) => (..._a: unknown[]) => {
    calls.push(name);
    return Promise.resolve(value) as never;
  };
  return {
    ensureHands: record("ensureHands", {
      handsUrl: "http://hands.test",
      created: true,
      token: "t",
      identity: { provider: "safe-workload", workloadId: "wl-test", platformKey: "pk" },
    }),
    destroyHands: record("destroyHands", undefined),
    reapPendingHands: record("reapPendingHands", undefined),
    unregisterSandbox: ((..._a: unknown[]) => { calls.push("unregisterSandbox"); }) as never,
    markHandsIdle: ((..._a: unknown[]) => { calls.push("markHandsIdle"); }) as never,
    // The checkpoint and the terminal sync are the same function; only the
    // destination tells them apart, so the call is logged with it.
    syncWorkspaceToS3: ((
      _h: unknown, _s: unknown, _u: unknown, opts?: { s3PrefixOverride?: string },
    ) => {
      calls.push(opts?.s3PrefixOverride ? "checkpointSync" : "syncWorkspaceToS3");
      return Promise.resolve({
        uploaded: 1, totalFiles: 1, failedCount: 0, exhausted: false, empty: false,
      });
    }) as never,
    syncWorkspaceFromS3: record("syncWorkspaceFromS3", undefined),
    archiveRunToS3: record("archiveRunToS3", undefined),
    copyS3Prefix: record("copyS3Prefix", { copied: 0 }),
    postAgentDone: record("postAgentDone", undefined),
    postTaskRunning: record("postTaskRunning", undefined),
    refreshTaskLock: record("refreshTaskLock", undefined),
    releaseTaskLock: record("releaseTaskLock", undefined),
    flushTranscript: record("flushTranscript", undefined),
    makeHandsClient: (() => ({
      close: async () => {},
      reapShells: async () => 0,
    })) as never,
  };
}

/** Set by the test that drives the checkpoint interval. */
let tickCheckpoint = false;

const RESULT: ExecuteResult = {
  finalText: "done",
  turns: 1,
  pendingMemories: [],
  pendingSkills: [],
  skillsUsed: {},
  errorCount: 0,
};

/** One successful run, with a real sandbox attached so the sync has a subject. */
async function run(over: Partial<ExecuteRequest>): Promise<string[]> {
  calls.length = 0;
  // The sandbox is provisioned lazily -- nothing attaches one until a tool asks
  // -- and a run with no sandbox skips the sync for its own reason. Attaching
  // one here is what puts the run on the branch these tests are about.
  const engine: Engine = {
    async execute(
      _req: unknown, _onEvent: unknown, _signal: unknown, _hands: unknown,
      extras?: { attachHands?: () => Promise<unknown> },
    ) {
      calls.push("engine.execute");
      await extras?.attachHands?.();
      // The checkpoint timer first fires 30 minutes in. Mock timers are enabled
      // by the test that cares; elsewhere this is a no-op.
      if (tickCheckpoint) mock.timers.tick(30 * 60 * 1000);
      return RESULT;
    },
  } as unknown as Engine;
  bindTaskRunnerDeps({
    kv: fakeKv(), kvCkpt: fakeKv(),
    emitter: { async emit() {} } as unknown as NatsEmitter,
    engine, sideEffects: stubSideEffects(),
  });

  const request = {
    session_id: SESSION,
    message_id: MESSAGE,
    workspace_id: "ws-throwaway",
    prompt: "do a thing",
    user_id: "u1",
    platform_key: "pk",
    sandbox_spec: { handle: "main", image: "img:1" },
    ...over,
  } as ExecuteRequest;

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}.${calls.length}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(fakeMsg(), request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  return [...calls];
}

test("R1 a run that declared its workspace throwaway does not sync it", async () => {
  const seen = await run({ workspace_throwaway: true });
  assert.equal(
    seen.includes("syncWorkspaceToS3"), false,
    "the whole point of the flag is that this call does not happen",
  );
});

test("R2 a run that did not declare it still syncs", async () => {
  // The guard sits in front of every ordinary run's only durable workspace
  // copy, so an inert default is the property that matters most here.
  const seen = await run({});
  assert.equal(seen.includes("syncWorkspaceToS3"), true);
});

test("R3 opting out of the sync does not opt out of the teardown", async () => {
  // The skip is an early branch inside the finalize block; taking it must not
  // carry away the sandbox release that the same block owes afterwards.
  const seen = await run({ workspace_throwaway: true });
  assert.equal(seen.includes("engine.execute"), true, "the run still ran");
  assert.equal(
    seen.some((c) => c === "destroyHands" || c === "markHandsIdle"), true,
    "the sandbox is still handed back",
  );
});

/** One run with the checkpoint interval driven forward 30 minutes. */
async function runWithCheckpointTick(over: Partial<ExecuteRequest>): Promise<string[]> {
  mock.timers.enable({ apis: ["setInterval"] });
  tickCheckpoint = true;
  try {
    return await run(over);
  } finally {
    tickCheckpoint = false;
    mock.timers.reset();
  }
}

test("R4 the in-flight checkpoint is skipped for a throwaway workspace", async () => {
  // The terminal sync was only half of it. The checkpoint uploads the whole tree
  // every 30 minutes so a failed terminal sync does not lose the run's
  // artifacts; across the 1-hour-to-3-day runs this flag exists for, that is up
  // to ~144 full uploads of a workspace nobody wants -- far more duplication
  // than the single terminal copy the flag was written to remove.
  const seen = await runWithCheckpointTick({ workspace_throwaway: true });
  assert.equal(seen.includes("checkpointSync"), false, seen.join(","));
});

test("R5 an ordinary run still gets its checkpoint", async () => {
  // The checkpoint is what saves a long run whose terminal sync fails. Skipping
  // it by default would trade a duplicate copy for a lost one.
  const seen = await runWithCheckpointTick({});
  assert.equal(seen.includes("checkpointSync"), true, seen.join(","));
});
