// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The platform's account of a dead sandbox reaches the callback.
 *
 * The parser and the read contract on the API side were both built and tested
 * before anything connected them: `platformFactsFromWorkloadDetail` had no
 * caller, no code put `platform_*` into an agent_done body, and so the columns
 * `GET /v1/runs/{id}` reads were NULL for every run ever. The endpoint answered
 * `class=failed, kill_reason=""` for a preempted run -- the exact conflation the
 * whole feature exists to remove -- and every test still passed, because each
 * half was correct on its own.
 *
 * These tests are about the join, so they assert on what leaves the process.
 *
 * Coverage:
 *   R1 a failed run asks the platform and delivers what it said
 *   R2 the wire body carries the platform fields
 *   R3 a run the platform said nothing about sends no platform fields at all
 *   R4 the facts are read before the sandbox is destroyed, not after
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { TaskRunnerSideEffects } from "../src/tasks/runner.js";

const SESSION = "sess-facts";
const MESSAGE = "msg-facts";

const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { activeAbort } = await import("../src/tasks/abort-registry.js");
const { postAgentDone } = await import("../src/tasks/callback.js");

const EVICTED = {
  message: "Evicted, the node was low on resource: memory",
  node: "gpu-node-7",
  exitCode: 137,
  containerReason: "OOMKilled",
};

function fakeKv(): KV {
  return {
    async get() { return null; }, async put() { return 1; }, async delete() {},
  } as unknown as KV;
}

function fakeMsg(): JsMsg {
  return {
    info: { deliveryCount: 1 }, ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
}

interface Seen {
  order: string[];
  delivered: ExecuteResult | null;
}

/** One run that fails inside the engine, with a stubbed platform read. */
async function runFailing(facts: unknown): Promise<Seen> {
  const seen: Seen = { order: [], delivered: null };
  const note = <T>(name: string, value: T) => (..._a: unknown[]) => {
    seen.order.push(name);
    return Promise.resolve(value) as never;
  };

  const sideEffects: Partial<TaskRunnerSideEffects> = {
    ensureHands: note("ensureHands", {
      handsUrl: "http://hands.test", created: true, token: "t",
      identity: { provider: "safe-workload", workloadId: "wl-1", platformKey: "pk" },
    }),
    destroyHands: note("destroyHands", undefined),
    reapPendingHands: note("reapPendingHands", undefined),
    fetchPlatformFacts: note("fetchPlatformFacts", facts),
    unregisterSandbox: ((..._a: unknown[]) => { seen.order.push("unregisterSandbox"); }) as never,
    markHandsIdle: ((..._a: unknown[]) => { seen.order.push("markHandsIdle"); }) as never,
    syncWorkspaceToS3: note("syncWorkspaceToS3", {
      uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true,
    }),
    syncWorkspaceFromS3: note("syncWorkspaceFromS3", undefined),
    archiveRunToS3: note("archiveRunToS3", undefined),
    copyS3Prefix: note("copyS3Prefix", { copied: 0 }),
    postTaskRunning: note("postTaskRunning", undefined),
    refreshTaskLock: note("refreshTaskLock", undefined),
    releaseTaskLock: note("releaseTaskLock", undefined),
    flushTranscript: note("flushTranscript", undefined),
    postAgentDone: ((_req: ExecuteRequest, result: ExecuteResult) => {
      seen.order.push("postAgentDone");
      seen.delivered = result;
      return Promise.resolve();
    }) as never,
    makeHandsClient: (() => ({ close: async () => {}, reapShells: async () => 0 })) as never,
  };

  const engine: Engine = {
    async execute(
      _req: unknown, _onEvent: unknown, _signal: unknown, _hands: unknown,
      extras?: { attachHands?: () => Promise<unknown> },
    ) {
      seen.order.push("engine.execute");
      await extras?.attachHands?.();
      throw new Error("the sandbox went away mid-run");
    },
  } as unknown as Engine;

  bindTaskRunnerDeps({
    kv: fakeKv(), kvCkpt: fakeKv(),
    emitter: { async emit() {} } as unknown as NatsEmitter,
    engine, sideEffects,
  });

  const request = {
    session_id: SESSION, message_id: MESSAGE, workspace_id: "ws-facts",
    prompt: "do a thing", user_id: "u1", platform_key: "pk",
    task_id: "ktsk_facts", callback_url: "http://api.test/v1/internal/tasks/ktsk_facts",
    sandbox_spec: { handle: "main", image: "img:1" },
  } as ExecuteRequest;

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}.${Math.round(performance.now() * 1000)}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(fakeMsg(), request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  return seen;
}

test("R1 a failed run asks the platform and delivers what it said", async () => {
  const seen = await runFailing(EVICTED);
  assert.ok(seen.order.includes("fetchPlatformFacts"), "the platform was asked");
  assert.deepEqual(
    seen.delivered?.platformFacts, EVICTED,
    "and the answer rides on the result that gets checkpointed and posted",
  );
});

test("R2 the wire body carries the platform fields", async () => {
  // The mapping from camelCase facts to the snake_case columns applyAgentDone
  // writes is the last place this can be lost, and it is invisible from inside
  // the process, so this asserts on the JSON that actually leaves.
  let body: Record<string, unknown> = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200 } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  try {
    await postAgentDone(
      { task_id: "ktsk_1", callback_url: "http://api.test/t" } as ExecuteRequest,
      {
        finalText: "", turns: 0, pendingMemories: [], pendingSkills: [],
        skillsUsed: {}, errorCount: 1, platformFacts: EVICTED,
      } as ExecuteResult,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(body.platform_message, EVICTED.message);
  assert.equal(body.platform_node, "gpu-node-7");
  assert.equal(body.platform_exit_code, 137);
  assert.equal(body.platform_container_reason, "OOMKilled");
});

test("R3 a run the platform said nothing about sends no platform fields", async () => {
  // applyAgentDone writes every platform field it receives, so an empty string
  // here would erase a reason an earlier attempt managed to read. Absence has to
  // stay absence all the way to the wire.
  let body: Record<string, unknown> = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200 } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  try {
    await postAgentDone(
      { task_id: "ktsk_2", callback_url: "http://api.test/t" } as ExecuteRequest,
      {
        finalText: "ok", turns: 1, pendingMemories: [], pendingSkills: [],
        skillsUsed: {}, errorCount: 0,
      } as ExecuteResult,
    );
  } finally {
    globalThis.fetch = original;
  }
  for (const k of ["platform_message", "platform_node", "platform_exit_code", "platform_container_reason"]) {
    assert.equal(k in body, false, `${k} must not be sent when nothing was read`);
  }
});

test("R4 the platform is asked before the sandbox is destroyed", async () => {
  // SaFE serves a pod's account of its own ending from the pod. Asking after the
  // teardown is asking a workload that no longer has one.
  const seen = await runFailing(EVICTED);
  const asked = seen.order.indexOf("fetchPlatformFacts");
  const destroyed = seen.order.indexOf("destroyHands");
  assert.notEqual(asked, -1, "asked at all");
  if (destroyed !== -1) {
    assert.ok(asked < destroyed, `asked at ${asked}, destroyed at ${destroyed}`);
  }
});
