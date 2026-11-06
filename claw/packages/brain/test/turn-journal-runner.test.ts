// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The turn journal through the runner: a SIGTERM drain lands after a review
 * comment was posted and before the turn ended, and the run is taken over by
 * another delivery. Asserted on what reaches the checkpoint bucket, since that
 * is all the next attempt reads, and on the side effects across both.
 *
 * The agent loop is the real one; only the model, the tool router and the
 * runner's I/O are stubbed. See turn-journal-resume for the loop on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult, Message, ToolSchema } from "@claw/protocol";
import {
  bindTaskRunnerDeps,
  runHandleTask,
  type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { LlmSession } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";
import { SIGTERM_ABORT_REASON, activeAbort } from "../src/tasks/abort-registry.js";

const SESSION = "sess-turn-journal";
const MESSAGE = "msg-turn-journal";
const CKPT_KEY = `task-ckpt.${SESSION}.${MESSAGE}`;

function fakeMsg(deliveryCount = 1) {
  const verdicts: string[] = [];
  const msg = {
    info: { deliveryCount },
    ack() { verdicts.push("ack"); },
    nak(ms?: number) { verdicts.push(`nak:${ms ?? "none"}`); },
    working() {},
    term() { verdicts.push("term"); },
  };
  return { msg: msg as unknown as JsMsg, verdicts };
}

function fakeKv(writes: string[], label: string) {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const kv = {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value, revision: 1 } : null;
    },
    async put(key: string, value: Uint8Array | string) {
      writes.push(`${label}.put:${key}`);
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

function result(): ExecuteResult {
  return {
    finalText: "done",
    tokenUsage: { input_tokens: 1, output_tokens: 2, cache_read: 0, cache_create: 0 },
    turns: 1,
    pendingSkills: [],
    skillsUsed: {},
    errorCount: 0,
    toolStats: { total_calls: 0, error_calls: 0, by_tool: {} },
    elapsedMs: 5,
  } as ExecuteResult;
}

function stubSideEffects(calls: string[]): TaskRunnerSideEffects {
  const record = <T>(name: string, value: T) => (...args: unknown[]) => {
    calls.push(name);
    void args;
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
    probeSandboxContainer: record("probeSandboxContainer", "dead"),
    unregisterSandbox: ((..._a: unknown[]) => { calls.push("unregisterSandbox"); }) as never,
    markHandsIdle: ((..._a: unknown[]) => { calls.push("markHandsIdle"); return Promise.resolve({ outcome: "parked" }); }) as never,
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
        close: async () => {},
      } as never;
    }) as never,
  };
}


const TOOLS: ToolSchema[] = [
  { name: "post_comment", description: "post a review comment", input_schema: { type: "object", properties: {} } },
] as unknown as ToolSchema[];

/** Asked the person's prompt it posts a comment; shown the comment's result it finishes. */
function reviewer(): { session: LlmSession; calls: number } {
  const state = { calls: 0, session: undefined as unknown as LlmSession };
  state.session = {
    async streamTurn(messages: Message[]) {
      state.calls++;
      const last = messages.at(-1)!;
      const answered = Array.isArray(last.content)
        && (last.content as Array<{ type?: string }>).some((b) => b.type === "tool_result");
      return answered
        ? { content: [{ type: "text", text: "reviewed" }], stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 }, firstByteMs: 1 }
        : { content: [{ type: "tool_use", id: `c${state.calls}`, name: "post_comment", input: { body: "LGTM" } }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 }, firstByteMs: 1 };
    },
    async complete() { return "summary"; },
  } as unknown as LlmSession;
  return state;
}

async function attempt(opts: {
  ckptStore?: Map<string, Uint8Array>;
  deliveryCount: number;
  posted: string[];
  /** SIGTERM the run once the comment has been posted. */
  drainAfterPost: boolean;
}) {
  const calls: string[] = [];
  const writes: string[] = [];
  const { msg, verdicts } = fakeMsg(opts.deliveryCount);
  const { kv } = fakeKv(writes, "kv");
  const { kv: kvCkpt, store } = fakeKv(writes, "ckpt");
  for (const [k, v] of opts.ckptStore ?? []) store.set(k, v);
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  const model = reviewer();
  const abortCtrl = new AbortController();
  const engine: Engine = {
    async execute(_req, onEvent, signal, _hands, extras) {
      await agentLoop([{ role: "user", content: "review the PR" }], TOOLS, {
        model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 5,
        sessionId: SESSION, userId: "u1", onEvent, signal,
        llmSession: model.session,
        onCheckpoint: extras?.onCheckpoint,
        onTurnJournal: extras?.onTurnJournal,
        resumeFrom: extras?.resumeCheckpoint,
        router: {
          route: async (_name: string, input: Record<string, unknown>) => {
            opts.posted.push(String(input.body));
            if (opts.drainAfterPost) abortCtrl.abort(SIGTERM_ABORT_REASON);
            return "comment posted";
          },
          setHands: () => {},
        } as unknown as ToolRouter,
      } as unknown as LoopOptions);
      return result();
    },
  };
  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects: stubSideEffects(calls) });
  const request = { session_id: SESSION, prompt: "review the PR", user_id: "u1", platform_key: "pk" } as ExecuteRequest;
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  return { verdicts, calls, store, modelCalls: model.calls };
}

test("RJ1: a comment posted just before a SIGTERM drain is not posted again by the delivery that takes the run over", async () => {
  const posted: string[] = [];
  const first = await attempt({ deliveryCount: 1, posted, drainAfterPost: true });
  assert.equal(posted.length, 1);
  assert.ok(first.verdicts.some((v) => v.startsWith("nak")), `the drained run is handed back, got ${first.verdicts}`);
  const raw = first.store.get(CKPT_KEY);
  assert.ok(raw, "the drain must leave a checkpoint to take the run over from");
  const persisted = JSON.parse(new TextDecoder().decode(raw)) as { pending_turn?: { results: Record<string, string> } };
  assert.deepEqual(persisted.pending_turn?.results, { c1: "comment posted" },
    "the checkpoint records the posted comment's result");

  const second = await attempt({ ckptStore: first.store, deliveryCount: 2, posted, drainAfterPost: false });
  assert.deepEqual(posted, ["LGTM"], "one comment across both deliveries");
  assert.equal(second.modelCalls, 1, "the taking-over run asks the model only for the turn after the interrupted one");
  assert.ok(second.verdicts.includes("ack"), `the resumed run completes, got ${second.verdicts}`);
});
