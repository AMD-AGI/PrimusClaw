// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox whose restore failed writes no shared-filesystem snapshot.
 *
 * With WORKSPACE_PERSIST_BASE set, every checkpoint snapshots /workspace to the
 * shared disk and marks the checkpoint `has_workspace_sync`; the next sandbox of
 * the session is filled from that snapshot by a restore that succeeds, which
 * leaves it unheld. A snapshot of an incomplete /workspace would therefore come
 * back as a whole one, and the new sandbox's S3 saves would prune what it lacks.
 *
 * This file owns its environment: the shared-disk sync only runs with a persist
 * base set, and a sync interval of zero makes every checkpoint start one.
 */
process.env.WORKSPACE_PERSIST_BASE = "/tmp/claw-test-restore-held-shared-sync";
process.env.WORKSPACE_SYNC_INTERVAL_MS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import type { CheckpointState, Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { HandsClient } from "../src/clients/hands.js";

const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { activeAbort } = await import("../src/tasks/abort-registry.js");
const { holdAfterFailedRestore } = await import("../src/workspace/sync-delta.js");
type SideEffects = Parameters<typeof bindTaskRunnerDeps>[0]["sideEffects"];

const SESSION = "sess-held-shared-sync";
const MESSAGE = "msg-held-shared-sync";
const USER = "0123456789abcdef0123456789abcdef";
const HANDS_URL = "http://10.0.0.11:9100/mcp";

const state = (turn: number): CheckpointState => ({
  messages: [{ role: "user", content: `turn ${turn}` }],
  turns_completed: turn,
  usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0, turns: turn },
  text_parts: [], error_count: 0, tool_calls_by_name: {}, total_tool_calls: 0, elapsed_ms_before: 10,
  setup_commands: [], plan_mode: false, todo_state: [], rebuilds_used: 0,
} as CheckpointState);

function memoryKv(): KV {
  const store = new Map<string, Uint8Array>();
  return {
    async get(key: string) { const value = store.get(key); return value ? { key, value } : null; },
    async put(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
      return 1;
    },
    async delete(key: string) { store.delete(key); },
  } as unknown as KV;
}

/** One run whose restore fails (holding the sandbox, as the real one does) or succeeds; counts shared syncs. */
async function runWith(restoreFails: boolean): Promise<number> {
  let sharedSyncs = 0;
  const noop = <T>(value: T) => (): Promise<T> => Promise.resolve(value);
  const sideEffects = {
    ensureHands: noop({ handsUrl: HANDS_URL, created: true, token: "t" }),
    destroyHands: noop(undefined),
    reapPendingHands: noop(undefined),
    probeSandboxContainer: noop("dead"),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: noop({ outcome: "parked" }),
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 1, totalFiles: 1, failedCount: 0, exhausted: false, empty: false }),
    syncWorkspaceFromS3: (async (hands: HandsClient, sessionId: string) => {
      if (!restoreFails) return 1;
      await holdAfterFailedRestore(hands, sessionId, "Request failed with status code 413");
      throw new Error("Request failed with status code 413");
    }) as never,
    syncUploadsFromS3: noop(0),
    archiveRunToS3: noop(undefined),
    copyS3Prefix: noop({ copied: 0 }),
    syncWorkspace: (async () => { sharedSyncs++; return { size: 1, inodes: 1, durationMs: 1 }; }) as never,
    restoreWorkspace: noop({ size: 1 }),
    postAgentDone: noop(undefined),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: noop(undefined),
    makeHandsClient: (() => ({
      generation: HANDS_URL,
      endpoint: () => ({ url: HANDS_URL, token: "t" }),
      // The sandbox's own note says "clear"; the write of it is taken.
      callTool: async (tool: string) => (tool === "write" ? "Written to x" : "clear\n__claw_sync_done__"),
      close: async () => {},
    })) as never,
  } as unknown as SideEffects;
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras) {
      await extras!.attachHands!();
      for (let turn = 1; turn <= 2; turn++) {
        await extras!.onCheckpoint!(state(turn));
        await new Promise((r) => setTimeout(r, 30));
      }
      return {
        finalText: "done", tokenUsage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
        turns: 2, pendingSkills: [], skillsUsed: {}, errorCount: 0,
        toolStats: { total_calls: 0, error_calls: 0, by_tool: {} }, elapsedMs: 5,
      } as unknown as ExecuteResult;
    },
  };
  bindTaskRunnerDeps({ kv: memoryKv(), kvCkpt: memoryKv(), emitter, engine, sideEffects });
  const abortCtrl = new AbortController();
  activeAbort.set(`lock.${SESSION}`, abortCtrl);
  const msg = { info: { deliveryCount: 1 }, ack() {}, nak() {}, working() {}, term() {} } as unknown as JsMsg;
  const request = { session_id: SESSION, prompt: "hi", user_id: USER, platform_key: "pk" } as ExecuteRequest;
  await runHandleTask(msg, request, SESSION, `lock.${SESSION}`, MESSAGE, USER, abortCtrl);
  return sharedSyncs;
}

test("a sandbox whose restore failed writes no shared-filesystem snapshot", async () => {
  assert.equal(await runWith(true), 0, "its incomplete /workspace would come back as the next sandbox's whole one");
});

test("a sandbox restored in full snapshots to the shared filesystem as before", async () => {
  assert.ok(await runWith(false) >= 1);
});

test("the shared-disk sync command itself refuses a sandbox carrying the hold note, before writing anything", async () => {
  // Another Brain process has no in-memory note, and a separate check could fail
  // to answer; the sandbox's note is read by the very command that would write
  // the snapshot.
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { restoreHeldGuard, syncWorkspace } = await import("../src/workspace/sync.js");
  const { RESTORE_HOLD_PATH } = await import("../src/workspace/sync-delta.js");

  const dir = mkdtempSync(join(tmpdir(), "claw-hold-guard-"));
  try {
    const note = join(dir, "restore-incomplete");
    const guard = restoreHeldGuard().replaceAll(RESTORE_HOLD_PATH, note);
    const run = () => spawnSync("bash", ["-c", `${guard}echo OK`], { encoding: "utf-8" });
    assert.equal(run().stdout.trim(), "OK", "no note: the sync runs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(note, "{}");
    const held = run();
    assert.equal(held.status, 3);
    assert.equal(held.stdout, "", "nothing after the guard ran");
    assert.match(held.stderr, /workspace_sync_held/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const commands: string[] = [];
  const hands = {
    generation: "http://10.0.0.12:9100/mcp",
    callTool: async (_tool: string, args: { command?: string }) => {
      const command = String(args.command ?? "");
      if (command.includes("__claw_git_begin__")) return "__claw_git_begin__\n__claw_git_end__:0";
      commands.push(command);
      return "exit 3\nstdout: \nstderr: workspace_sync_held: this sandbox's restore failed";
    },
  } as unknown as HandsClient;
  await assert.rejects(() => syncWorkspace(hands, "6f1c2a8e-3b4d-4e5f-9a0b-1c2d3e4f5a6b", USER, 1), /workspace_sync_held/);
  assert.equal(commands.length, 1);
  assert.ok(commands[0].startsWith(restoreHeldGuard()), "the guard comes first in the sync command");
});
