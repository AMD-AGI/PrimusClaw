// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A repository the shared-disk snapshot left out is something the user is told.
 *
 * `workspace_git_skipped` is the only place anyone can learn that commits in a
 * repository will not survive the sandbox, and the S3 sync that ends a run was the
 * only thing emitting it. A deployment that saves its workspace to the shared disk
 * (WORKSPACE_PERSIST_BASE) runs a different sync, after every checkpoint, whose
 * result carried the same facts and was dropped on the floor: a repository over a
 * bound was silently missing from every snapshot and came back without history.
 *
 * That sync runs every turn, so what is pinned here is also how often it speaks:
 * once for each change of what it has to say, not once per turn.
 *
 * This file owns its environment: the shared-disk sync only runs with a persist
 * base set, and a sync interval of zero makes every checkpoint start one.
 */
process.env.WORKSPACE_PERSIST_BASE = "/tmp/claw-test-workspace-git-event";
process.env.WORKSPACE_SYNC_INTERVAL_MS = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import type { CheckpointState, Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";

const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
type SideEffects = Parameters<typeof bindTaskRunnerDeps>[0]["sideEffects"];

const SESSION = "sess-git-event";
const MESSAGE = "msg-git-event";
const USER = "0123456789abcdef0123456789abcdef";

const state = (turn: number): CheckpointState => ({
  messages: [{ role: "user", content: `turn ${turn}` }],
  turns_completed: turn,
  usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0, turns: turn },
  text_parts: [],
  error_count: 0,
  tool_calls_by_name: {},
  total_tool_calls: 0,
  elapsed_ms_before: 10,
  setup_commands: [],
  plan_mode: false,
  todo_state: [],
  rebuilds_used: 0,
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

const sideEffects = (over: Partial<SideEffects>): SideEffects => {
  const noop = <T>(value: T) => (): Promise<T> => Promise.resolve(value);
  return {
    ensureHands: noop({
      handsUrl: "http://hands.test", created: true, token: "t",
      identity: { provider: "safe-workload", workloadId: "wl-test", platformKey: "pk" },
    }),
    destroyHands: noop(undefined),
    reapPendingHands: noop(undefined),
    probeSandboxContainer: noop("dead"),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: noop({ outcome: "parked" }),
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop(undefined),
    archiveRunToS3: noop(undefined),
    copyS3Prefix: noop({ copied: 0 }),
    syncWorkspace: noop({ size: 1, inodes: 1, durationMs: 1 }),
    restoreWorkspace: noop({ size: 1 }),
    postAgentDone: noop(undefined),
    runScript: noop({} as ExecuteResult),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: noop(undefined),
    makeHandsClient: (() => ({
      endpoint: () => ({ url: "http://hands.test", token: "t" }),
      close: async () => {},
    })) as never,
    ...over,
  } as unknown as SideEffects;
};

type GitReport = { skipped: unknown[]; unmeasured: boolean; note: string };
const NOTE_BIG = "Not saved: big/.git (412 MB, limit 300 MB). push them first.";
const NOTE_UNKNOWN = "Could not measure the git repositories in /workspace. push them first.";
const over: GitReport = { skipped: [], unmeasured: false, note: NOTE_BIG };
const unknown: GitReport = { skipped: [], unmeasured: true, note: NOTE_UNKNOWN };

/**
 * Runs a turn that checkpoints once per entry of `syncs`, each sync answering with
 * that entry, and returns the git events the run emitted. Each sync is awaited to
 * its end before the next checkpoint, as the interval between real ones does.
 */
async function turnsWith(syncs: Array<GitReport | undefined>, extra: Partial<SideEffects> = {}) {
  const events: Array<Record<string, unknown>> = [];
  let started = 0;
  let finished = 0;
  const msg = { info: { deliveryCount: 1 }, ack() {}, nak() {}, working() {}, term() {} } as unknown as JsMsg;
  const emitter = { async emit(_s: string, evt: Record<string, unknown>) { events.push(evt); } } as unknown as NatsEmitter;

  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras: ExecuteExtras | undefined) {
      await extras!.attachHands!();
      for (let i = 0; i < syncs.length; i++) {
        await extras!.onCheckpoint!(state(i + 1));
        // The sync runs behind the checkpoint; the next one waits for it.
        for (let w = 0; w < 200 && finished < i + 1; w++) await new Promise((r) => setTimeout(r, 5));
        assert.equal(finished, i + 1, `sync ${i + 1} never finished`);
      }
      return {
        finalText: "done",
        tokenUsage: { input_tokens: 1, output_tokens: 2, cache_read: 0, cache_create: 0 },
        turns: syncs.length, pendingMemories: [], pendingSkills: [], skillsUsed: {}, errorCount: 0,
        toolStats: { total_calls: 0, error_calls: 0, by_tool: {} }, elapsedMs: 5,
      } as ExecuteResult;
    },
  };
  bindTaskRunnerDeps({
    kv: memoryKv(), kvCkpt: memoryKv(), emitter, engine,
    sideEffects: sideEffects({
      syncWorkspace: (async () => {
        const git = syncs[started++];
        // Resolved after the `.then` that announces it has had its turn.
        setTimeout(() => { finished++; }, 20);
        return { size: 1, inodes: 1, durationMs: 1, ...(git ? { git } : {}) };
      }) as never,
      ...extra,
    }),
  });
  await runHandleTask(
    msg,
    { session_id: SESSION, prompt: "hi", user_id: USER, platform_key: "pk" } as ExecuteRequest,
    SESSION, `lock.${SESSION}`, MESSAGE, USER, new AbortController(),
  );
  return events.filter((e) => e.type === "sandboxStatus" && e.status === "workspace_git_skipped");
}

test("a shared-disk sync that left a repository out says so, with the sentence the sync wrote", async () => {
  const said = await turnsWith([over]);
  assert.equal(said.length, 1);
  assert.equal(said[0].reason, "git_over_limit");
  assert.equal(said[0].message, NOTE_BIG);
  assert.equal(said[0].message_id, MESSAGE);
});

test("one that could not measure says that, under its own reason", async () => {
  const said = await turnsWith([unknown]);
  assert.deepEqual(said.map((e) => [e.reason, e.message]), [["git_unmeasured", NOTE_UNKNOWN]]);
});

test("a sync that left nothing out says nothing", async () => {
  assert.deepEqual(await turnsWith([undefined, undefined]), []);
});

test("the same note every turn is said once; a different one, or the same one after a clean sync, is news", async () => {
  const said = await turnsWith([over, over, undefined, over, unknown, unknown]);
  assert.deepEqual(
    said.map((e) => e.message),
    [NOTE_BIG, NOTE_BIG, NOTE_UNKNOWN],
    "turn 1, then not again at turn 2, then again after turn 3 cleared it, then the new one once",
  );
});

test("an event the stream refused is tried again at the next sync, not taken as said", async () => {
  let refuse = true;
  const said: string[] = [];
  const msg = { info: { deliveryCount: 1 }, ack() {}, nak() {}, working() {}, term() {} } as unknown as JsMsg;
  const emitter = {
    async emit(_s: string, evt: Record<string, unknown>) {
      if (evt.status !== "workspace_git_skipped") return;
      if (refuse) { refuse = false; throw new Error("stream refused"); }
      said.push(String(evt.message));
    },
  } as unknown as NatsEmitter;
  let finished = 0;
  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras: ExecuteExtras | undefined) {
      await extras!.attachHands!();
      for (let i = 0; i < 2; i++) {
        await extras!.onCheckpoint!(state(i + 1));
        for (let w = 0; w < 200 && finished < i + 1; w++) await new Promise((r) => setTimeout(r, 5));
      }
      return {
        finalText: "done",
        tokenUsage: { input_tokens: 1, output_tokens: 2, cache_read: 0, cache_create: 0 },
        turns: 2, pendingMemories: [], pendingSkills: [], skillsUsed: {}, errorCount: 0,
        toolStats: { total_calls: 0, error_calls: 0, by_tool: {} }, elapsedMs: 5,
      } as ExecuteResult;
    },
  };
  bindTaskRunnerDeps({
    kv: memoryKv(), kvCkpt: memoryKv(), emitter, engine,
    sideEffects: sideEffects({
      syncWorkspace: (async () => {
        setTimeout(() => { finished++; }, 20);
        return { size: 1, inodes: 1, durationMs: 1, git: over };
      }) as never,
    }),
  });
  await runHandleTask(
    msg,
    { session_id: SESSION, prompt: "hi", user_id: USER, platform_key: "pk" } as ExecuteRequest,
    SESSION, `lock.${SESSION}`, MESSAGE, USER, new AbortController(),
  );
  assert.deepEqual(said, [NOTE_BIG], "the first was refused, so the second sync says it; nothing is said twice");
});

test("the event failing to go out does not undo a snapshot that was saved", async () => {
  // The checkpoint's workspace flag is written after the sync and before the
  // announcement; a stream that refuses the event must not be able to take it back.
  const events: Array<Record<string, unknown>> = [];
  const msg = { info: { deliveryCount: 1 }, ack() {}, nak() {}, working() {}, term() {} } as unknown as JsMsg;
  const emitter = {
    async emit(_s: string, evt: Record<string, unknown>) {
      if (evt.status === "workspace_git_skipped") throw new Error("stream refused");
      events.push(evt);
    },
  } as unknown as NatsEmitter;
  let synced = false;
  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras: ExecuteExtras | undefined) {
      await extras!.attachHands!();
      await extras!.onCheckpoint!(state(1));
      for (let w = 0; w < 200 && !synced; w++) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 50));
      return {
        finalText: "done",
        tokenUsage: { input_tokens: 1, output_tokens: 2, cache_read: 0, cache_create: 0 },
        turns: 1, pendingMemories: [], pendingSkills: [], skillsUsed: {}, errorCount: 0,
        toolStats: { total_calls: 0, error_calls: 0, by_tool: {} }, elapsedMs: 5,
      } as ExecuteResult;
    },
  };
  const kv = memoryKv();
  const written: Array<Record<string, unknown>> = [];
  const recording = {
    ...kv,
    async put(key: string, value: Uint8Array | string) {
      written.push(JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value)));
      return kv.put(key, value);
    },
  } as unknown as KV;
  bindTaskRunnerDeps({
    kv: memoryKv(), kvCkpt: recording, emitter, engine,
    sideEffects: sideEffects({
      syncWorkspace: (async () => { synced = true; return { size: 1, inodes: 1, durationMs: 1, git: over }; }) as never,
    }),
  });
  await runHandleTask(
    msg,
    { session_id: SESSION, prompt: "hi", user_id: USER, platform_key: "pk" } as ExecuteRequest,
    SESSION, `lock.${SESSION}`, MESSAGE, USER, new AbortController(),
  );
  assert.ok(
    written.some((w) => w.has_workspace_sync === true),
    "the checkpoint says the workspace was synced, whatever became of the event",
  );
});
