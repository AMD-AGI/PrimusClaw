// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A sandbox costs a pod start (tens of seconds on a cold node, and a GPU
// reservation when the image asks for one), and most chat turns never touch a
// file. So a run opens one when a tool asks for it, not because a run started.
//
// The risk in deferring it is a path that assumed a sandbox was already there:
// a resumed run whose /workspace must be back before the model reads its own
// history, a script-mode run that is nothing but tool calls, a multi-node run
// whose entire purpose is the cluster. Those still provision up front, and
// these tests pin each of those decisions plus the once-only attach that the
// deferred path relies on when several tool calls race for it.

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
import { activeAbort } from "../src/tasks/abort-registry.js";

const SESSION = "sess-lazy";
const MESSAGE = "msg-lazy";

function fakeMsg() {
  const verdicts: string[] = [];
  const msg = {
    info: { deliveryCount: 1 },
    ack() { verdicts.push("ack"); },
    nak(ms?: number) { verdicts.push(`nak:${ms ?? "none"}`); },
    working() {},
    term() { verdicts.push("term"); },
  };
  return { msg: msg as unknown as JsMsg, verdicts };
}

function fakeKv() {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const kv = {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value } : null;
    },
    async put(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 1;
    },
    async delete(key: string) { store.delete(key); },
  };
  return { kv: kv as unknown as KV, store };
}

function result(over: Partial<ExecuteResult> = {}): ExecuteResult {
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
    ...over,
  } as ExecuteResult;
}

/** A v3 checkpoint as it would sit in KV for a redelivered run. */
function seededCheckpoint(): string {
  return JSON.stringify({
    version: 3,
    session_id: SESSION,
    message_id: MESSAGE,
    brain_id: "brain-1",
    brain_version: "test",
    checkpointed_at: Date.now(),
    turns_completed: 2,
    has_workspace_sync: false,
    messages: [{ role: "user", content: "hi" }],
    usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0, turns: 2 },
    text_parts: [],
    error_count: 0,
    tool_calls_by_name: {},
    total_tool_calls: 0,
    elapsed_ms_before: 1,
    setup_commands: [],
    plan_mode: false,
    todo_state: [],
    rebuilds_used: 0,
  });
}

function stubSideEffects(opts: {
  failFirstEnsure?: boolean;
  /**
   * Called while /workspace is being restored, and handed the call log so a test
   * can mark its own events in the same order as the run's.
   */
  duringRestore?: (calls: string[]) => void;
}) {
  const { failFirstEnsure, duringRestore } = opts;
  const calls: string[] = [];
  let ensureCount = 0;
  const record = <T>(name: string, value: T) => (...args: unknown[]) => {
    calls.push(name);
    void args;
    return Promise.resolve(value) as never;
  };
  const sideEffects = {
    ensureHands: ((..._a: unknown[]) => {
      ensureCount++;
      calls.push("ensureHands");
      if (failFirstEnsure && ensureCount === 1) {
        return Promise.reject(new Error("no capacity right now"));
      }
      // Slow enough that concurrent callers overlap, which is the case the
      // shared attach promise exists for.
      return new Promise((resolve) =>
        setTimeout(() => resolve({ handsUrl: "http://hands.test", created: true, token: "t" }), 20),
      );
    }) as never,
    destroyHands: record("destroyHands", undefined),
    reapPendingHands: record("reapPendingHands", undefined),
    unregisterSandbox: ((..._a: unknown[]) => { calls.push("unregisterSandbox"); }) as never,
    markHandsIdle: ((..._a: unknown[]) => { calls.push("markHandsIdle"); }) as never,
    markRetryPending: record("markRetryPending", undefined),
    syncWorkspaceToS3: record("syncWorkspaceToS3",
      { uploaded: 1, totalFiles: 1, failedCount: 0, exhausted: false, empty: false }),
    // The one side effect that runs after the client exists and before the
    // sandbox is usable, so it is given a real duration: an rsync into
    // /workspace is where a caller handed the client too early does its damage.
    syncWorkspaceFromS3: ((..._a: unknown[]) => {
      calls.push("syncWorkspaceFromS3");
      duringRestore?.(calls);
      return new Promise((resolve) => setTimeout(() => {
        calls.push("workspaceRestored");
        resolve(undefined);
      }, 10));
    }) as never,
    archiveRunToS3: record("archiveRunToS3", undefined),
    copyS3Prefix: record("copyS3Prefix", { copied: 0 }),
    syncWorkspace: record("syncWorkspace", { ok: true }),
    restoreWorkspace: record("restoreWorkspace", { ok: true }),
    postAgentDone: record("postAgentDone", undefined),
    postTaskRunning: ((_req: unknown, ownership?: { sandboxWorkloadId?: string }) => {
      calls.push(ownership?.sandboxWorkloadId === undefined
        ? "postTaskRunning:no_workload" : "postTaskRunning:workload");
      return Promise.resolve();
    }) as never,
    runScript: ((..._a: unknown[]) => {
      calls.push("runScript");
      return Promise.resolve(result());
    }) as never,
    refreshTaskLock: record("refreshTaskLock", undefined),
    releaseTaskLock: record("releaseTaskLock", undefined),
    flushTranscript: ((..._a: unknown[]) => {
      calls.push("flushTranscript");
      return Promise.resolve();
    }) as never,
    makeHandsClient: (() => {
      calls.push("makeHandsClient");
      return { close: async () => { calls.push("hands.close"); } } as never;
    }) as never,
  } as unknown as TaskRunnerSideEffects;
  return { sideEffects, calls, ensureCount: () => ensureCount };
}

async function runScenario(opts: {
  engineBehavior: (extras: ExecuteExtras | undefined) => Promise<ExecuteResult>;
  request?: Partial<ExecuteRequest>;
  seedCheckpoint?: boolean;
  failFirstEnsure?: boolean;
  duringRestore?: (calls: string[]) => void;
}) {
  const { msg, verdicts } = fakeMsg();
  const { kv } = fakeKv();
  const { kv: kvCkpt, store: ckptStore } = fakeKv();
  if (opts.seedCheckpoint) {
    ckptStore.set(`task-ckpt.${SESSION}.${MESSAGE}`,
      new TextEncoder().encode(seededCheckpoint()));
  }
  const events: Array<Record<string, unknown>> = [];
  const emitter = {
    async emit(_sid: string, evt: Record<string, unknown>) { events.push(evt); },
  } as unknown as NatsEmitter;
  const { sideEffects, calls, ensureCount } = stubSideEffects({
    failFirstEnsure: opts.failFirstEnsure,
    duringRestore: opts.duringRestore,
  });

  let handsAtEngineStart: unknown;
  const engine: Engine = {
    async execute(_req, _onEvent, _signal, hands, extras) {
      calls.push("engine.execute");
      handsAtEngineStart = hands;
      return opts.engineBehavior(extras);
    },
  };

  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });

  const request = {
    session_id: SESSION,
    prompt: "hi",
    user_id: "u1",
    platform_key: "pk",
    ...opts.request,
  } as ExecuteRequest;

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);

  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);

  return { verdicts, events, calls, ensureCount: ensureCount(), handsAtEngineStart };
}

test("a chat turn that calls no tool never opens a sandbox", async () => {
  const r = await runScenario({ engineBehavior: async () => result() });

  assert.equal(r.ensureCount, 0, "the whole point: no pod for a question");
  assert.equal(r.handsAtEngineStart, null, "the engine is told there is no sandbox yet");
  assert.deepEqual(r.verdicts, ["ack"], "the run still completes normally");
  assert.ok(
    r.calls.includes("postTaskRunning:no_workload"),
    "the task row still learns which brain owns the run",
  );
  assert.ok(!r.calls.includes("syncWorkspaceToS3"), "there is no workspace to upload");
});

test("the first tool call opens the sandbox, and only once", async () => {
  const r = await runScenario({
    async engineBehavior(extras) {
      // Three tools reaching for the sandbox at the same moment, which is what
      // parallel tool calls in one turn look like.
      const clients = await Promise.all([
        extras!.attachHands!(), extras!.attachHands!(), extras!.attachHands!(),
      ]);
      assert.equal(clients[0], clients[1]);
      assert.equal(clients[1], clients[2], "every caller must get the same sandbox");
      return result();
    },
  });

  assert.equal(r.ensureCount, 1, "a raced attach must not provision three pods");
  assert.ok(
    r.calls.includes("postTaskRunning:workload"),
    "attaching records the sandbox on the task row so cleanup can find it",
  );
  assert.ok(r.calls.includes("syncWorkspaceToS3"), "an attached run has a workspace to keep");
});

test("a caller arriving mid-attach waits for the workspace, not just the client", async () => {
  // The attach assigns the client and only then rsyncs /workspace back into the
  // sandbox. A caller that was handed the assigned client during that window
  // would be reading and writing files the restore is still overwriting, so what
  // callers wait on is the attach in flight rather than the field it sets.
  let attach: (() => Promise<unknown>) | undefined;
  let arrival: Promise<unknown> | undefined;

  const r = await runScenario({
    duringRestore(calls) {
      arrival = attach!().then(() => { calls.push("arrivalGotTheClient"); });
    },
    async engineBehavior(extras) {
      attach = extras!.attachHands!;
      await attach();
      await arrival;
      return result();
    },
  });

  assert.equal(r.ensureCount, 1, "an arrival mid-attach must not provision a second sandbox");
  const restored = r.calls.indexOf("workspaceRestored");
  assert.ok(restored >= 0, "the restore has to have run for this to be the case it pins");
  assert.ok(
    r.calls.indexOf("arrivalGotTheClient") > restored,
    "the client is handed over only once /workspace is back",
  );
});

test("a failed attach can be retried by a later tool call", async () => {
  // ensureHands failing is usually transient (no capacity, image pull, a node
  // going away). Caching the rejection would turn one bad minute into a run
  // where every later tool call fails for a reason that no longer applies.
  let firstError: unknown;
  let second: unknown;
  const r = await runScenario({
    failFirstEnsure: true,
    async engineBehavior(extras) {
      try { await extras!.attachHands!(); } catch (e) { firstError = e; }
      second = await extras!.attachHands!();
      return result();
    },
  });

  assert.ok(firstError instanceof Error, "the tool that triggered it sees the failure");
  assert.ok(second, "the next tool call gets a working sandbox");
  assert.equal(r.ensureCount, 2, "the second call has to be a real attempt, not a cached one");
});

test("a resumed run provisions before the model sees its own history", async () => {
  const r = await runScenario({
    seedCheckpoint: true,
    engineBehavior: async () => result(),
  });

  assert.equal(r.ensureCount, 1, "the workspace has to be back before turn one");
  assert.ok(
    r.calls.indexOf("ensureHands") < r.calls.indexOf("engine.execute"),
    "provisioning has to finish before the engine starts",
  );
  assert.notEqual(r.handsAtEngineStart, null, "the engine gets a live sandbox");
});

test("script mode provisions up front", async () => {
  // A script run is a fixed sequence of tool calls with no model in between,
  // so there is no turn during which a sandbox could be deferred.
  const r = await runScenario({
    request: { mode: "script" } as Partial<ExecuteRequest>,
    engineBehavior: async () => result(),
  });

  assert.equal(r.ensureCount, 1);
  assert.ok(r.calls.includes("runScript"));
  assert.ok(!r.calls.includes("engine.execute"), "script mode does not run the agent loop");
});

test("a run that declares a cluster is never deferred, valid declaration or not", async () => {
  // The third case the header names. The cluster is built as part of bringing
  // the sandbox up and its addresses are baked into that sandbox's
  // environment, so a multi-node run has nothing to defer -- and a declaration
  // that does not validate is a request for a cluster that got the spelling
  // wrong, not a request for one node. Reading it as single-node would take
  // the lazy path and finish quietly on one GPU.
  //
  // Neither case can reach a real cluster here, so what is pinned is the
  // branch: no `deferred`, no turn run without the sandbox, and the reason the
  // provisioning stopped is one the caller can act on.
  const cases: Array<[unknown, RegExp]> = [
    [{ nodes: 2, backend: "rayjob" }, /requires workspace_id/],
    [{ node: 64, backend: "rayjob" }, /did you mean nodes/],
  ];

  for (const [topology, why] of cases) {
    const r = await runScenario({
      request: { message_id: MESSAGE, topology } as Partial<ExecuteRequest>,
      engineBehavior: async () => result(),
    });

    const statuses = r.events.filter((e) => e.type === "sandboxStatus").map((e) => e.status);
    assert.ok(!statuses.includes("deferred"),
      `${JSON.stringify(topology)}: there is nothing to defer when the run is the cluster`);
    assert.ok(!r.calls.includes("engine.execute"),
      `${JSON.stringify(topology)}: running the turn anyway is the silent downgrade to avoid`);
    assert.match(JSON.stringify(r.events), why,
      `${JSON.stringify(topology)}: the caller has to be told what stopped it`);
  }
});

test("a client can tell a started run from a usable sandbox", async () => {
  // Before this, a turn starting and a sandbox existing were the same event,
  // and a client could enable a terminal or a file browser on the strength of
  // `running`. They are no longer the same event and may be minutes apart, or
  // the second may never happen -- so the run says which it means.
  const chat = await runScenario({ engineBehavior: async () => result() });
  const chatStatuses = chat.events
    .filter((e) => e.type === "sandboxStatus")
    .map((e) => e.status);
  assert.ok(chatStatuses.includes("deferred"), "a turn with no sandbox says so");
  assert.ok(!chatStatuses.includes("ready"), "and never claims one appeared");

  const withTool = await runScenario({
    async engineBehavior(extras) {
      await extras!.attachHands!();
      return result();
    },
  });
  const toolStatuses = withTool.events
    .filter((e) => e.type === "sandboxStatus")
    .map((e) => e.status);
  assert.deepEqual(
    toolStatuses.filter((s) => s === "deferred" || s === "ready"),
    ["deferred", "ready"],
    "deferred first, then ready once, in that order",
  );
});

test("readiness is announced after the sandbox can actually be used", async () => {
  // The provider already emits `running` when the pod is scheduled, which is
  // before bootstrap and the health check -- a client acting on that talks to
  // a sandbox that is not listening yet. This one is emitted where ensureHands
  // has returned, which is the first moment a request would be answered.
  const r = await runScenario({
    async engineBehavior(extras) {
      await extras!.attachHands!();
      return result();
    },
  });
  const order = r.events
    .filter((e) => e.type === "sandboxStatus" && e.status === "ready")
    .length;
  assert.equal(order, 1, "one sandbox, one readiness event");
  assert.ok(
    r.calls.indexOf("ensureHands") < r.calls.indexOf("makeHandsClient"),
    "the event sits after the health-checked provision, not after scheduling",
  );
});
