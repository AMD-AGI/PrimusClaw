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
 * once for each change of what it has to say, not once per turn. What it has to
 * say is which repositories and why -- the sentence carries their sizes, and a
 * repository over a bound that grows a little every turn is the same news.
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
import type { GitReport } from "../src/workspace/git-dirs.js";

// Dynamic, after the environment above is set: config.ts reads it once, on first import.
const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { SIGTERM_PROBE_TIMEOUT_SEC } = await import("../src/workspace/git-dirs.js");
const { SIGTERM_ABORT_REASON, activeAbort } = await import("../src/tasks/abort-registry.js");
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

const finalResult = (turns: number): ExecuteResult => ({
  finalText: "done",
  tokenUsage: { input_tokens: 1, output_tokens: 2, cache_read: 0, cache_create: 0 },
  turns, pendingMemories: [], pendingSkills: [], skillsUsed: {}, errorCount: 0,
  toolStats: { total_calls: 0, error_calls: 0, by_tool: {} }, elapsedMs: 5,
} as unknown as ExecuteResult);

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

const entry = (path: string, reason: "too_large" | "too_many_files", bytes = 1, files = 1) => ({ path, bytes, files, reason });
const NOTE_BIG = "Not saved this time: big/.git (412 MB, limit 300 MB). push them first.";
const NOTE_UNKNOWN = "Could not measure the git repositories in /workspace. push them first.";
const over: GitReport = { skipped: [entry("/workspace/big/.git", "too_large")], unmeasured: false, note: NOTE_BIG };
const unknown: GitReport = { skipped: [], unmeasured: true, note: NOTE_UNKNOWN };
const sized = (mb: number, path = "/workspace/big/.git"): GitReport => ({
  skipped: [entry(path, "too_large", mb * 1024 * 1024)],
  unmeasured: false,
  note: `Not saved this time: ${path} (${mb} MB, limit 300 MB). push them first.`,
});

const GIT_EVENT = (e: Record<string, unknown>): boolean => e.type === "sandboxStatus" && e.status === "workspace_git_skipped";
const msgOf = (): JsMsg => ({ info: { deliveryCount: 1 }, ack() {}, nak() {}, working() {}, term() {} }) as unknown as JsMsg;
const request = { session_id: SESSION, prompt: "hi", user_id: USER, platform_key: "pk" } as ExecuteRequest;

/**
 * One run, with `body` as the agent's turns, an emitter that refuses the events
 * `refuse` names, and the side effects `effects` replaces. Returns what was emitted.
 */
async function drive(opts: {
  body: (extras: ExecuteExtras) => Promise<void>;
  refuse?: (e: Record<string, unknown>) => boolean;
  effects?: Partial<SideEffects>;
  kvCkpt?: KV;
  abort?: AbortController;
}) {
  const events: Array<Record<string, unknown>> = [];
  const emitter = {
    async emit(_s: string, evt: Record<string, unknown>) {
      if (opts.refuse?.(evt)) throw new Error("stream refused");
      events.push(evt);
    },
  } as unknown as NatsEmitter;
  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras: ExecuteExtras | undefined) {
      await extras!.attachHands!();
      await opts.body(extras!);
      return finalResult(1);
    },
  };
  bindTaskRunnerDeps({
    kv: memoryKv(), kvCkpt: opts.kvCkpt ?? memoryKv(), emitter, engine, sideEffects: sideEffects(opts.effects ?? {}),
  });
  const abortCtrl = opts.abort ?? new AbortController();
  activeAbort.set(`lock.${SESSION}`, abortCtrl);
  await runHandleTask(msgOf(), request, SESSION, `lock.${SESSION}`, MESSAGE, USER, abortCtrl);
  return events;
}

/**
 * Checkpoints once per entry of `syncs`, each shared-disk sync answering with that
 * entry, and returns the git events the run emitted. Each sync is awaited to its
 * end before the next checkpoint, as the interval between real ones does.
 */
async function turnsWith(syncs: Array<GitReport | undefined>, opts: { refuseFirst?: boolean } = {}) {
  let started = 0;
  let finished = 0;
  let refuse = opts.refuseFirst === true;
  const events = await drive({
    refuse: (e) => GIT_EVENT(e) && refuse && !(refuse = false),
    body: async (extras) => {
      for (let i = 0; i < syncs.length; i++) {
        await extras.onCheckpoint!(state(i + 1));
        // The sync runs behind the checkpoint; the next one waits for it.
        for (let w = 0; w < 200 && finished < i + 1; w++) await new Promise((r) => setTimeout(r, 5));
        assert.equal(finished, i + 1, `sync ${i + 1} never finished`);
      }
    },
    effects: {
      syncWorkspace: (async () => {
        const git = syncs[started++];
        // Resolved after the `.then` that announces it has had its turn.
        setTimeout(() => { finished++; }, 20);
        return { size: 1, inodes: 1, durationMs: 1, ...(git ? { git } : {}) };
      }) as never,
    },
  });
  return events.filter(GIT_EVENT);
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

test("the same repositories every turn are said once; others, or the same ones after a clean sync, are news", async () => {
  const said = await turnsWith([over, over, undefined, over, unknown, unknown]);
  assert.deepEqual(
    said.map((e) => e.message),
    [NOTE_BIG, NOTE_BIG, NOTE_UNKNOWN],
    "turn 1, then not again at turn 2, then again after turn 3 cleared it, then the new one once",
  );
});

test("a repository over its bound that grows a little every turn is one piece of news, not one per turn", async () => {
  const said = await turnsWith([sized(350), sized(351), sized(353), sized(353)]);
  assert.deepEqual(said.map((e) => e.message), [sized(350).note], "the sentence has a different size each turn; the news does not");
});

test("another repository over its bound, or the same one for another reason, is news", async () => {
  const other = sized(350, "/workspace/other/.git");
  const said = await turnsWith([
    sized(350), other,
    { ...sized(350), skipped: [entry("/workspace/big/.git", "too_many_files")] },
  ]);
  assert.equal(said.length, 3);
});

test("an event the stream refused is tried again at the next sync, not taken as said", async () => {
  const said = await turnsWith([over, over], { refuseFirst: true });
  assert.deepEqual(said.map((e) => e.message), [NOTE_BIG], "the first was refused, so the second sync says it; nothing is said twice");
});

test("the event failing to go out does not undo a snapshot that was saved", async () => {
  // The checkpoint's workspace flag is written after the sync and before the
  // announcement; a stream that refuses the event must not be able to take it back.
  const written: Array<Record<string, unknown>> = [];
  const kv = memoryKv();
  const recording = {
    ...kv,
    async put(key: string, value: Uint8Array | string) {
      written.push(JSON.parse(typeof value === "string" ? value : new TextDecoder().decode(value)));
      return kv.put(key, value);
    },
  } as unknown as KV;
  let synced = false;
  await drive({
    kvCkpt: recording,
    refuse: GIT_EVENT,
    body: async (extras) => {
      await extras.onCheckpoint!(state(1));
      for (let w = 0; w < 200 && !synced; w++) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 50));
    },
    effects: {
      syncWorkspace: (async () => { synced = true; return { size: 1, inodes: 1, durationMs: 1, git: over }; }) as never,
    },
  });
  assert.ok(
    written.some((w) => w.has_workspace_sync === true),
    "the checkpoint says the workspace was synced, whatever became of the event",
  );
});

test("the terminal S3 sync that succeeded is not turned into a failed one by the event failing", async () => {
  // The catch around the sync emits workspace_sync_failed and copies an older
  // in-flight checkpoint over the session prefix, over the files just uploaded. A
  // refused event is not a failed upload.
  const synced = { uploaded: 1, totalFiles: 1, failedCount: 0, exhausted: false, empty: false, git: over };
  let uploads = 0;
  const events = await drive({
    refuse: GIT_EVENT,
    body: async () => {},
    effects: { syncWorkspaceToS3: (async () => { uploads++; return synced; }) as never },
  });
  assert.equal(uploads, 1, "the S3 sync ran");
  const statuses = events.filter((e) => e.type === "sandboxStatus").map((e) => e.status);
  assert.ok(!statuses.includes("workspace_sync_failed"), `a sync that landed is not reported as failed (${statuses})`);
  assert.ok(events.some((e) => e.type === "exec_complete"), "and the run still completes");
});

test("a SIGTERM sync to S3 gives the git measurement the short budget", async () => {
  // With the shared disk unset, which is the default, this is the only sync a
  // SIGTERM runs: its budget is smaller than one default measurement.
  const calls: Array<{ options: unknown }> = [];
  const ctrl = new AbortController();
  await drive({
    abort: ctrl,
    body: async (extras) => {
      await extras.onCheckpoint!(state(1));
      ctrl.abort(SIGTERM_ABORT_REASON);
      throw SIGTERM_ABORT_REASON;
    },
    effects: {
      // The shared-disk SIGTERM sync is what failing here sends the run to S3.
      syncWorkspace: (async (...a: unknown[]) => {
        if ((a[4] as { kind?: string } | undefined)?.kind === "sigterm") throw new Error("shared disk gone");
        return { size: 1, inodes: 1, durationMs: 1 };
      }) as never,
      syncWorkspaceToS3: (async (...a: unknown[]) => {
        calls.push({ options: a[3] });
        return { uploaded: 1, totalFiles: 1, failedCount: 0, exhausted: false, empty: false };
      }) as never,
    },
  });
  assert.deepEqual(calls.map((c) => c.options), [{ gitProbeTimeoutSec: SIGTERM_PROBE_TIMEOUT_SEC }]);
});
