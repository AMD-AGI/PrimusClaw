// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A file the user uploads while the session's sandbox is up lands in S3 only.
// A new sandbox gets it from the S3 restore; a reused one would not, so the run
// that attaches to a reused sandbox puts the uploads in, and the one whose
// sandbox was just filled from S3 does not do it twice.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import { bindTaskRunnerDeps, runHandleTask, type TaskRunnerSideEffects } from "../src/tasks/runner.js";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { activeAbort } from "../src/tasks/abort-registry.js";

const SESSION = "sess-uploads";
const MESSAGE = "msg-uploads";

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


async function attachOnce(created: boolean, failSync = false) {
  const calls: string[] = [];
  const record = (name: string, value: unknown = undefined) => (..._a: unknown[]) => {
    calls.push(name);
    return Promise.resolve(value) as never;
  };
  const sideEffects = {
    ensureHands: (() => Promise.resolve({ handsUrl: "http://hands.test", created, token: "t" })) as never,
    destroyHands: record("destroyHands"),
    reapPendingHands: record("reapPendingHands"),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => Promise.resolve({ outcome: "parked" })) as never,
    markRetryPending: record("markRetryPending"),
    syncWorkspaceToS3: record("syncWorkspaceToS3",
      { uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: record("syncWorkspaceFromS3", 0),
    syncUploadsFromS3: ((_h: unknown, sessionId: string, userId: string) => {
      calls.push(`syncUploadsFromS3:${sessionId}:${userId}`);
      return failSync ? Promise.reject(new Error("S3 unreachable")) : Promise.resolve(1);
    }) as never,
    archiveRunToS3: record("archiveRunToS3"),
    copyS3Prefix: record("copyS3Prefix", { copied: 0 }),
    syncWorkspace: record("syncWorkspace", { ok: true }),
    restoreWorkspace: record("restoreWorkspace", { ok: true }),
    postAgentDone: record("postAgentDone"),
    postTaskRunning: record("postTaskRunning"),
    refreshTaskLock: record("refreshTaskLock"),
    releaseTaskLock: record("releaseTaskLock"),
    flushTranscript: record("flushTranscript"),
    makeHandsClient: (() => ({ close: async () => {} })) as never,
  } as unknown as TaskRunnerSideEffects;

  const { msg, verdicts } = fakeMsg();
  const { kv } = fakeKv();
  const { kv: kvCkpt } = fakeKv();
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras) {
      await extras!.attachHands!();
      calls.push("attached");
      return result();
    },
  };
  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });
  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  const request = { session_id: SESSION, prompt: "read the file I sent", user_id: "u1", platform_key: "pk" } as ExecuteRequest;
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  return { calls, verdicts };
}

test("a reused sandbox is given the uploads before the tool that asked for it runs", async () => {
  const { calls, verdicts } = await attachOnce(false);
  const synced = calls.indexOf(`syncUploadsFromS3:${SESSION}:u1`);
  assert.ok(synced >= 0, "the uploads were put into the reused sandbox");
  assert.ok(synced < calls.indexOf("attached"), "before the caller got the sandbox");
  assert.ok(!calls.includes("syncWorkspaceFromS3"), "a reused sandbox is not restored from S3");
  assert.deepEqual(verdicts, ["ack"]);
});

test("a new sandbox filled from S3 already has the uploads and is not given them again", async () => {
  const { calls } = await attachOnce(true);
  assert.ok(calls.includes("syncWorkspaceFromS3"));
  assert.ok(!calls.some((c) => c.startsWith("syncUploadsFromS3")));
});

test("uploads that cannot be put in do not fail the turn", async () => {
  const { calls, verdicts } = await attachOnce(false, true);
  assert.ok(calls.includes("attached"), "the tool still got its sandbox");
  assert.deepEqual(verdicts, ["ack"]);
});
