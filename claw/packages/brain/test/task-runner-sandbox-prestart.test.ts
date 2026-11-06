// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A run the API marks `sandbox_prestart` (an assistant's worker turn) starts
// opening its sandbox when it starts, so the pod comes up while the first model
// call runs instead of after it. What these pin:
//
//   - the open starts before the engine has asked, and the first tool that asks
//     gets that same open rather than a second one;
//   - a prestarted sandbox nothing used is given back by the ordinary ending: a
//     ready one is parked (and its untouched workspace is not uploaded), and one
//     still being created is given up, its workload reclaimed and its PENDING
//     entry reaped -- and the run's ending waits for that, so no sandbox comes up
//     after the run has reported itself done;
//   - an abort of the run itself keeps its own reclaim rule: a restart leaves the
//     workload for the successor to adopt;
//   - a failed prestart is not cached: the first tool that asks tries again;
//   - nothing is prestarted for a run without the mark, for a run whose tool list
//     has no sandbox tool (a router turn), or with BRAIN_SANDBOX_PRESTART off.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import {
  bindTaskRunnerDeps,
  runHandleTask,
  wantsSandboxPrestart,
  type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";
import type { Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { activeAbort, SIGTERM_ABORT_REASON } from "../src/tasks/abort-registry.js";
import { SandboxProvisionTerminalError } from "../src/sandbox/errors.js";
import type { EnsureHandsOptions } from "../src/sandbox/ensure-hands.js";

const SESSION = "sess-prestart";
const MESSAGE = "msg-prestart";
const IDENTITY = { workloadId: "wl-prestart", platformKey: "pk", namespace: "ns" };

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
  return kv as unknown as KV;
}

function result(): ExecuteResult {
  return {
    finalText: "done",
    tokenUsage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
    turns: 1,
    pendingSkills: [],
    skillsUsed: {},
    errorCount: 0,
    toolStats: { total_calls: 0, error_calls: 0, by_tool: {} },
    elapsedMs: 3,
  } as ExecuteResult;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface EnsureScript {
  /** How long the open takes when nothing gives it up. */
  delayMs: number;
  /** Fail the first open with this error instead. */
  failFirst?: Error;
}

/**
 * The side effects, with an ensureHands that behaves like the real one where it
 * matters here: it takes `delayMs`, and an abort of its signal ends it at once,
 * asking `reclaimOnAbort` whether to stop what it was creating -- the wait loop's
 * contract (workload-wait.ts `interrupted`).
 */
function sideEffects(script: EnsureScript) {
  const calls: string[] = [];
  const ensure: Array<{ options: EnsureHandsOptions; reclaimed?: boolean }> = [];
  const record = <T>(name: string, value: T) => (..._a: unknown[]) => {
    calls.push(name);
    return Promise.resolve(value) as never;
  };
  const fx = {
    ensureHands: ((_sid: string, _req: unknown, _pk: string, _ev: unknown, _mn: unknown, options: EnsureHandsOptions) => {
      const call: { options: EnsureHandsOptions; reclaimed?: boolean } = { options };
      ensure.push(call);
      calls.push("ensureHands");
      if (script.failFirst && ensure.length === 1) return Promise.reject(script.failFirst);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.push("ensureHands.ready");
          resolve({ handsUrl: "http://hands.test/mcp", created: true, token: "t", identity: IDENTITY });
        }, script.delayMs);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          call.reclaimed = options.reclaimOnAbort ? options.reclaimOnAbort() : true;
          calls.push(call.reclaimed ? "ensureHands.reclaimed" : "ensureHands.left_to_caller");
          reject(new SandboxProvisionTerminalError("sandbox_wait_interrupted", "interrupted"));
        }, { once: true });
      });
    }) as never,
    destroyHands: record("destroyHands", undefined),
    reapPendingHands: record("reapPendingHands", undefined),
    unregisterSandbox: ((..._a: unknown[]) => { calls.push("unregisterSandbox"); }) as never,
    markHandsIdle: ((..._a: unknown[]) => { calls.push("markHandsIdle"); return Promise.resolve({ outcome: "parked" }); }) as never,
    markRetryPending: record("markRetryPending", undefined),
    syncWorkspaceToS3: record("syncWorkspaceToS3",
      { uploaded: 1, totalFiles: 1, failedCount: 0, exhausted: false, empty: false }),
    syncWorkspaceFromS3: record("syncWorkspaceFromS3", undefined),
    syncUploadsFromS3: record("syncUploadsFromS3", undefined),
    archiveRunToS3: record("archiveRunToS3", undefined),
    copyS3Prefix: record("copyS3Prefix", { copied: 0 }),
    syncWorkspace: record("syncWorkspace", { ok: true }),
    restoreWorkspace: record("restoreWorkspace", { ok: true }),
    postAgentDone: record("postAgentDone", undefined),
    postTaskRunning: ((_req: unknown, ownership?: { sandboxWorkloadId?: string }) => {
      calls.push(ownership?.sandboxWorkloadId === undefined ? "postTaskRunning:no_workload" : "postTaskRunning:workload");
      return Promise.resolve();
    }) as never,
    runScript: record("runScript", result()),
    refreshTaskLock: record("refreshTaskLock", undefined),
    releaseTaskLock: record("releaseTaskLock", undefined),
    flushTranscript: record("flushTranscript", undefined),
    capturePlatformFacts: record("capturePlatformFacts", null),
    fetchPlatformFacts: record("fetchPlatformFacts", null),
    makeHandsClient: (() => {
      calls.push("makeHandsClient");
      return {
        close: async () => { calls.push("hands.close"); },
        reapShells: async () => { calls.push("hands.reapShells"); return { shells: [], stopped: 0, escalated: 0, surviving: 0 }; },
      } as never;
    }) as never,
  } as unknown as TaskRunnerSideEffects;
  return { fx, calls, ensure };
}

async function run(opts: {
  script: EnsureScript;
  request?: Partial<ExecuteRequest>;
  engine: (extras: ExecuteExtras | undefined, t: { calls: string[]; abort: AbortController }) => Promise<ExecuteResult>;
}) {
  const { msg, verdicts } = fakeMsg();
  const events: Array<Record<string, unknown>> = [];
  const emitter = {
    async emit(_sid: string, evt: Record<string, unknown>) { events.push(evt); },
  } as unknown as NatsEmitter;
  const { fx, calls, ensure } = sideEffects(opts.script);
  const abortCtrl = new AbortController();
  let handsAtEngineStart: unknown;
  const engine: Engine = {
    async execute(_req, _onEvent, _signal, hands, extras) {
      calls.push("engine.execute");
      handsAtEngineStart = hands;
      const r = await opts.engine(extras, { calls, abort: abortCtrl });
      calls.push("engine.done");
      return r;
    },
  };
  bindTaskRunnerDeps({ kv: fakeKv(), kvCkpt: fakeKv(), emitter, engine, sideEffects: fx });
  const request = {
    session_id: SESSION,
    task_id: "task-prestart",
    message_id: MESSAGE,
    prompt: "work on the item",
    user_id: "u1",
    platform_key: "pk",
    sandbox_prestart: true,
    ...opts.request,
  } as ExecuteRequest;
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  const startedAt = Date.now();
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  return { verdicts, events, calls, ensure, handsAtEngineStart, elapsedMs: Date.now() - startedAt };
}

const statuses = (events: Array<Record<string, unknown>>) =>
  events.filter((e) => e.type === "sandboxStatus").map((e) => `${e.status}${e.reason ? `:${e.reason}` : ""}`);

test("a worker turn starts opening its sandbox before its first model call returns, and its first tool gets that one", async () => {
  let openedBeforeTheModelAnswered = false;
  let clients: unknown[] = [];
  const r = await run({
    script: { delayMs: 60 },
    async engine(extras, t) {
      // The first model call: the open is already under way while it runs.
      openedBeforeTheModelAnswered = t.calls.includes("ensureHands");
      await sleep(30);
      // Then the model asks for the sandbox, from two tools at once.
      clients = await Promise.all([extras!.attachHands!(), extras!.attachHands!()]);
      return result();
    },
  });
  assert.ok(openedBeforeTheModelAnswered, "the open is not waiting for a tool to ask");
  assert.equal(r.handsAtEngineStart, null, "the engine reaches the sandbox through attachHands, which claims it");
  assert.equal(r.ensure.length, 1, "the tool joins the open in flight instead of starting another");
  assert.equal(clients[0], clients[1]);
  assert.ok(r.calls.includes("syncWorkspaceToS3"), "a sandbox the run used is a workspace to keep");
  assert.ok(r.calls.includes("markHandsIdle"), "and is parked at the end like any other");
  assert.ok(!r.calls.includes("reapPendingHands"), "a used sandbox is not given up");
  assert.deepEqual(statuses(r.events).filter((s) => s.startsWith("deferred") || s.startsWith("ready")),
    ["deferred:opening_ahead", "ready:created"]);
  assert.deepEqual(r.verdicts, ["ack"]);
});

test("the first tool waits only for what is left of the open, not for all of it", async () => {
  // The model call and the open overlap: a tool asking 40ms into a 60ms open is
  // answered about 20ms later, where the lazy open would have started it then.
  let waitedMs = 0;
  await run({
    script: { delayMs: 60 },
    async engine(extras) {
      await sleep(40);
      const asked = Date.now();
      await extras!.attachHands!();
      waitedMs = Date.now() - asked;
      return result();
    },
  });
  assert.ok(waitedMs < 55, `the tool waited ${waitedMs}ms, which is the whole open again`);
});

test("a prestarted sandbox nothing used is parked by the ordinary ending, and its untouched workspace is not uploaded", async () => {
  const r = await run({
    script: { delayMs: 5 },
    async engine() {
      // Answered from the conversation, after the sandbox came up.
      await sleep(40);
      return result();
    },
  });
  assert.equal(r.ensure.length, 1);
  assert.ok(r.calls.indexOf("ensureHands.ready") < r.calls.indexOf("engine.done"), "the sandbox was up before the run ended");
  assert.ok(!r.calls.includes("syncWorkspaceToS3"), "nothing of the run's is in it, and an upload would only delay the reply");
  assert.ok(!r.calls.includes("hands.reapShells"), "nor are any of its shells");
  assert.ok(r.calls.includes("unregisterSandbox"), "the run stops pinging it");
  assert.ok(r.calls.includes("markHandsIdle"), "and parks it for the session's next message: the idle reclaim ends it otherwise");
  assert.ok(!r.calls.includes("reapPendingHands"), "a ready sandbox is not reaped");
  assert.deepEqual(r.verdicts, ["ack"]);
});

test("a prestart still opening when the run ends is given up: the workload reclaimed and the PENDING entry reaped, before the run reports", async () => {
  const r = await run({
    script: { delayMs: 60_000 },
    async engine() { return result(); },
  });
  assert.ok(r.elapsedMs < 10_000, `the run waited ${r.elapsedMs}ms for a sandbox it did not use`);
  assert.equal(r.ensure.length, 1);
  assert.equal(r.ensure[0]!.reclaimed, true, "the run still holds its lock, so what the wait created is stopped");
  assert.ok(r.calls.includes("reapPendingHands"), "and the PENDING entry naming it is reaped");
  const reaped = r.calls.indexOf("reapPendingHands");
  assert.ok(reaped < r.calls.indexOf("postAgentDone"), "before the run reports itself done, not after");
  assert.ok(!r.calls.includes("ensureHands.ready"));
  assert.ok(!r.calls.includes("markHandsIdle"), "there is no sandbox to park");
  assert.ok(!statuses(r.events).some((s) => s.startsWith("ready")), "no sandbox is announced");
  assert.deepEqual(r.verdicts, ["ack"]);
});

test("a run whose engine fails while its prestart is still opening gives the open up before the failure path reads the sandbox", async () => {
  const r = await run({
    script: { delayMs: 60_000 },
    async engine() { throw new Error("the model gateway refused the request"); },
  });
  assert.ok(r.elapsedMs < 10_000, `the run waited ${r.elapsedMs}ms for a sandbox it did not use`);
  assert.equal(r.ensure[0]!.reclaimed, true);
  const reaped = r.calls.indexOf("reapPendingHands");
  assert.ok(reaped >= 0 && reaped < r.calls.indexOf("postAgentDone"), "given up before the failure is reported");
  assert.ok(!statuses(r.events).some((s) => s.startsWith("ready")));
});

test("a run that is restarted while its prestart is still opening leaves the workload to its successor", async () => {
  const r = await run({
    script: { delayMs: 60_000 },
    async engine(_extras, t) {
      t.abort.abort(SIGTERM_ABORT_REASON);
      return result();
    },
  });
  assert.equal(r.ensure.length, 1);
  assert.equal(r.ensure[0]!.reclaimed, false, "a restart is not a cancel: the next run adopts what was being created");
  assert.ok(!r.calls.includes("reapPendingHands"), "and nothing reaps the entry it will adopt it by");
});

test("a prestart that failed is not cached: the first tool that asks tries again", async () => {
  let toolClient: unknown;
  const r = await run({
    script: { delayMs: 5, failFirst: new Error("no capacity right now") },
    async engine(extras) {
      await sleep(20);
      toolClient = await extras!.attachHands!();
      return result();
    },
  });
  assert.equal(r.ensure.length, 2, "the tool's ask is a real attempt");
  assert.ok(toolClient, "and gets a sandbox");
  assert.ok(r.calls.includes("syncWorkspaceToS3"));
  assert.deepEqual(r.verdicts, ["ack"]);
});

test("nothing is prestarted for a run without the mark, or for a router turn whose tools reach no sandbox", async () => {
  const unmarked = await run({ script: { delayMs: 5 }, request: { sandbox_prestart: undefined }, async engine() { await sleep(20); return result(); } });
  assert.equal(unmarked.ensure.length, 0);
  assert.ok(statuses(unmarked.events).includes("deferred:no_tool_called_yet"));

  const router = await run({
    script: { delayMs: 5 },
    request: { tools_allowlist: ["mcp__assistant__*", "mcp__github__get_issue"] },
    async engine() { await sleep(20); return result(); },
  });
  assert.equal(router.ensure.length, 0, "a turn cut to MCP tools has nothing that would use a sandbox");
});

test("wantsSandboxPrestart: the mark, the switch, and a tool list that leaves a sandbox tool", () => {
  const req = (over: Partial<ExecuteRequest>) => ({ session_id: "s", sandbox_prestart: true, ...over }) as ExecuteRequest;
  assert.equal(wantsSandboxPrestart(req({}), true), true, "no list: every tool");
  assert.equal(wantsSandboxPrestart(req({ tools_allowlist: [] }), true), true, "an empty list is no restriction");
  assert.equal(wantsSandboxPrestart(req({}), false), false, "BRAIN_SANDBOX_PRESTART off");
  assert.equal(wantsSandboxPrestart(req({ sandbox_prestart: undefined }), true), false);
  assert.equal(wantsSandboxPrestart(req({ sandbox_prestart: "true" as unknown as boolean }), true), false, "only `true` is the mark");
  assert.equal(wantsSandboxPrestart(req({ tools_allowlist: ["mcp__assistant__*"] }), true), false);
  assert.equal(wantsSandboxPrestart(req({ tools_allowlist: ["mcp__assistant__*", "bash"] }), true), true);
  assert.equal(wantsSandboxPrestart(req({ tools_allowlist: ["task"] }), true), true, "a sub-agent runs on its parent's sandbox");
  assert.equal(wantsSandboxPrestart(req({ tools_allowlist: ["deliver_file"] }), true), true);
  assert.equal(wantsSandboxPrestart(req({ tools_allowlist: ["*"] }), true), true);
  assert.equal(wantsSandboxPrestart(req({ tools_allowlist: "bash" as unknown as string[] }), true), false, "an unreadable list allows nothing");
});
