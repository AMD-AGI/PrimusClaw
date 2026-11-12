// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A restore of a new sandbox's /workspace from S3 that fails used to be a log
// line and nothing else: the turn went on in an incomplete workspace, the user was
// told nothing, and the save after it deleted the saved copy of every file the
// restore had not brought back. What the save does is pinned in
// s3-sync-delta.test.ts (R1-R6); this pins what the run says about it.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import { bindTaskRunnerDeps, runHandleTask, type TaskRunnerSideEffects } from "../src/tasks/runner.js";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { activeAbort } from "../src/tasks/abort-registry.js";

const SESSION = "sess-restore-failed";
const MESSAGE = "msg-restore-failed";
const HANDS_URL = "http://10.0.0.9:9100/mcp";

function fakeKv(): KV {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  return {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value } : null;
    },
    async put(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 1;
    },
    async delete(key: string) { store.delete(key); },
  } as unknown as KV;
}

function result(): ExecuteResult {
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
  } as ExecuteResult;
}

async function runOnNewSandbox(restore: () => Promise<number>) {
  const calls: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const verdicts: string[] = [];
  const record = (name: string, value: unknown = undefined) => (..._a: unknown[]) => {
    calls.push(name);
    return Promise.resolve(value) as never;
  };
  const sideEffects = {
    ensureHands: (() => Promise.resolve({ handsUrl: HANDS_URL, created: true, token: "t" })) as never,
    destroyHands: record("destroyHands"),
    reapPendingHands: record("reapPendingHands"),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => Promise.resolve({ outcome: "parked" })) as never,
    markRetryPending: record("markRetryPending"),
    syncWorkspaceToS3: record("syncWorkspaceToS3",
      { uploaded: 1, totalFiles: 1, failedCount: 0, exhausted: false, empty: false }),
    syncWorkspaceFromS3: (() => { calls.push("syncWorkspaceFromS3"); return restore(); }) as never,
    syncUploadsFromS3: record("syncUploadsFromS3", 0),
    archiveRunToS3: record("archiveRunToS3"),
    copyS3Prefix: record("copyS3Prefix", { copied: 0 }),
    syncWorkspace: record("syncWorkspace", { ok: true }),
    restoreWorkspace: record("restoreWorkspace", { ok: true }),
    postAgentDone: record("postAgentDone"),
    postTaskRunning: record("postTaskRunning"),
    refreshTaskLock: record("refreshTaskLock"),
    releaseTaskLock: record("releaseTaskLock"),
    flushTranscript: record("flushTranscript"),
    makeHandsClient: (() => ({ generation: HANDS_URL, close: async () => {} })) as never,
  } as unknown as TaskRunnerSideEffects;

  const msg = {
    info: { deliveryCount: 1 },
    ack() { verdicts.push("ack"); },
    nak(ms?: number) { verdicts.push(`nak:${ms ?? "none"}`); },
    working() {},
    term() { verdicts.push("term"); },
  } as unknown as JsMsg;
  const emitter = {
    async emit(_sessionId: string, evt: Record<string, unknown>) { events.push(evt); },
  } as unknown as NatsEmitter;
  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras) {
      await extras!.attachHands!();
      calls.push("attached");
      return result();
    },
  };
  bindTaskRunnerDeps({ kv: fakeKv(), kvCkpt: fakeKv(), emitter, engine, sideEffects });
  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  const request = { session_id: SESSION, prompt: "carry on", user_id: "u1", platform_key: "pk" } as ExecuteRequest;
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  const restoreFailed = events.filter(
    (e) => e.type === "sandboxStatus" && e.status === "workspace_restore_failed",
  );
  return { calls, events, verdicts, restoreFailed };
}

test("a restore Hands refused with 413 is reported to the user, and the turn still runs", async () => {
  const { calls, verdicts, restoreFailed } = await runOnNewSandbox(
    () => Promise.reject(new Error("MCP error -32603: Request failed with status code 413 Payload Too Large")),
  );
  assert.equal(restoreFailed.length, 1, "one event says the workspace was not restored");
  assert.equal(restoreFailed[0].reason, "payload_too_large");
  assert.equal(restoreFailed[0].message_id, MESSAGE);
  assert.match(String(restoreFailed[0].message), /could not be restored/);
  assert.match(String(restoreFailed[0].message), /413/, "with what went wrong");
  assert.match(String(restoreFailed[0].message), /do not delete or replace/, "and that the saved copy is kept");
  assert.ok(calls.indexOf("syncWorkspaceFromS3") < calls.indexOf("attached"),
    "the restore ran before the engine got the sandbox");
  assert.ok(calls.includes("syncWorkspaceToS3"), "the turn still ends with its save");
  assert.deepEqual(verdicts, ["ack"]);
});

test("a restore that came back incomplete is reported under its own reason", async () => {
  const { WorkspaceRestoreIncomplete } = await import("../src/workspace/s3-uploader.js");
  const { restoreFailed } = await runOnNewSandbox(
    () => Promise.reject(new WorkspaceRestoreIncomplete(10, 534, 524)),
  );
  assert.equal(restoreFailed.length, 1);
  assert.equal(restoreFailed[0].reason, "WorkspaceRestoreIncomplete");
  assert.match(String(restoreFailed[0].message), /restored=10\/534/);
});

test("the event names no address: not the sandbox's, not a presigned URL", async () => {
  const { WorkspaceRestoreIncomplete } = await import("../src/workspace/s3-uploader.js");
  const { restoreFailed } = await runOnNewSandbox(() => Promise.reject(new Error(
    "fetch failed for http://10.0.0.7:8080/mcp while fetching https://s3.example/b/k?X-Amz-Signature=abc; "
    + "connect ECONNREFUSED 10.0.0.8:9000 via hands-abc.claw-sandboxes.svc.cluster.local:8080",
  )));
  assert.equal(restoreFailed.length, 1);
  assert.doesNotMatch(String(restoreFailed[0].message), /10\.0\.0\.[78]|X-Amz-Signature|https?:|\.svc/);
  assert.match(String(restoreFailed[0].message), /fetch failed for <url>.*ECONNREFUSED <address> via <address>/);

  const { withoutAddresses } = await import("../src/workspace/sync-delta.js");
  assert.equal(
    withoutAddresses("connect to [fd00::4]:9000 or fd00::4 or fe80::1:2 or ::1 or 2001:db8:0:0:0:0:0:1 failed at 12:34:56"),
    "connect to <address> or <address> or <address> or <address> or <address> failed at 12:34:56",
  );
  assert.equal(withoutAddresses("Error:: retry; std::string"), "Error:: retry; std::string");

  const incomplete = new WorkspaceRestoreIncomplete(0, 3, 3, "HTTP 413 from https://s3.example/b/k?X-Amz-Signature=abc");
  assert.match(incomplete.message, /failed=3; first: HTTP 413 from <url>/);
  assert.doesNotMatch(incomplete.message, /X-Amz-Signature/);
});

test("a restore that succeeded says nothing", async () => {
  const { restoreFailed, verdicts } = await runOnNewSandbox(() => Promise.resolve(534));
  assert.equal(restoreFailed.length, 0);
  assert.deepEqual(verdicts, ["ack"]);
});

test("a sandbox just created is not held by a hold this process kept for an earlier one at its address", async () => {
  // Pod IPs are reused. A hold left from an earlier sandbox of this session at the
  // same address must not survive into a new one -- whichever way the new one is
  // filled (here a restore the run does not route through syncWorkspaceFromS3's
  // own release, as the shared-filesystem restore does not).
  const { holdAfterFailedRestore, isRestoreHeld } = await import("../src/workspace/sync-delta.js");
  const earlier = {
    generation: HANDS_URL,
    // The sandbox's own note says "clear": only the in-memory hold is under test.
    callTool: async (tool: string) => (tool === "write" ? "Written to x" : "clear\n__claw_sync_done__"),
  } as unknown as import("../src/clients/hands.js").HandsClient;
  await holdAfterFailedRestore(earlier, SESSION, "Request failed with status code 413");
  assert.equal(await isRestoreHeld(earlier, SESSION), true, "held before the new sandbox");

  const { verdicts } = await runOnNewSandbox(() => Promise.resolve(534));
  assert.deepEqual(verdicts, ["ack"]);
  assert.equal(await isRestoreHeld(earlier, SESSION), false, "a new sandbox at that address starts unheld");
});
