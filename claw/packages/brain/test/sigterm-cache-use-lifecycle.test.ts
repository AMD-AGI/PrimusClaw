// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a SIGTERM actually persists about cache use, driven through the runner
 * rather than asserted on the overlay function in isolation.
 *
 * The overlay is unit-tested next door in sigterm-cache-use-freshness. Three
 * things it cannot see were wrong, and all three are properties of the run
 * around it:
 *
 *   1. A resumed run has no checkpoint of its OWN until its first new turn
 *      finishes, and the only source the SIGTERM path consulted was that one.
 *      So the first tool batch after a resume -- in a run that is being
 *      resumed because it was already interrupted once -- computed the fresh
 *      timestamp and dropped it.
 *
 *   2. The whole checkpoint write sat behind `&& this.hands`. A sandbox is
 *      attached lazily, and a run whose tools are all network or backend MCP
 *      calls never attaches one, so a SIGTERM wrote nothing at all for it: no
 *      conversation, no timestamp, however many turns it had completed.
 *
 *   3. Compaction discards the cache entry and the agent loop clears its own
 *      timestamp to say so -- but says it by omission, and the runner's copy
 *      is only ever moved forward. A SIGTERM then wrote the pre-compaction
 *      timestamp back, and the resumed run measured a gap against an entry
 *      that no longer existed. That is a reported cache loss that did not
 *      happen, which is the exact failure the clear was added to prevent.
 *
 * Asserted on what reaches KV, because that is the only thing the next attempt
 * ever reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import {
  bindTaskRunnerDeps,
  runHandleTask,
  type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";
import type { CheckpointState, Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { SIGTERM_ABORT_REASON, activeAbort } from "../src/tasks/abort-registry.js";

const SESSION = "sess-cache-lifecycle";
const MESSAGE = "msg-cache-lifecycle";
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

function checkpointState(over: Partial<CheckpointState> = {}): CheckpointState {
  return {
    messages: [{ role: "user", content: "hi" }],
    turns_completed: 4,
    usage: { input_tokens: 1, output_tokens: 1, cache_read: 1, cache_create: 0, turns: 4 },
    text_parts: [],
    error_count: 0,
    tool_calls_by_name: {},
    total_tool_calls: 0,
    elapsed_ms_before: 10,
    setup_commands: [],
    plan_mode: false,
    todo_state: [],
    rebuilds_used: 0,
    ...over,
  } as CheckpointState;
}

/** A checkpoint the resume path will actually accept: version, id, and freshness. */
function seededResumeCheckpoint(over: Partial<CheckpointState> = {}) {
  return JSON.stringify({
    ...checkpointState(over),
    version: 3,
    session_id: SESSION,
    message_id: MESSAGE,
    user_id: "u1",
    has_workspace_sync: false,
    last_sync_turn: 0,
    checkpointed_at: Date.now(),
  });
}

function result(): ExecuteResult {
  return {
    finalText: "done",
    tokenUsage: { input_tokens: 1, output_tokens: 2, cache_read: 0, cache_create: 0 },
    turns: 1,
    pendingMemories: [],
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
    markHandsIdle: ((..._a: unknown[]) => { calls.push("markHandsIdle"); }) as never,
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

async function runScenario(opts: {
  /** What the run does before the SIGTERM lands. */
  turn: (extras: ExecuteExtras) => Promise<void>;
  /** Seeded JSON for the checkpoint key, i.e. this run is a resume. */
  resumeFrom?: string;
}) {
  const calls: string[] = [];
  const writes: string[] = [];
  const { msg, verdicts } = fakeMsg(opts.resumeFrom ? 2 : 1);
  const { kv } = fakeKv(writes, "kv");
  const { kv: kvCkpt, store: ckptStore } = fakeKv(writes, "ckpt");
  if (opts.resumeFrom) {
    ckptStore.set(CKPT_KEY, new TextEncoder().encode(opts.resumeFrom));
  }
  const emitter = {
    async emit(_sid: string, _evt: Record<string, unknown>) {},
  } as unknown as NatsEmitter;

  const abortCtrl = new AbortController();
  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras) {
      await opts.turn(extras!);
      abortCtrl.abort(SIGTERM_ABORT_REASON);
      throw SIGTERM_ABORT_REASON;
    },
  };

  bindTaskRunnerDeps({
    kv, kvCkpt, emitter, engine, sideEffects: stubSideEffects(calls),
  });

  const request = {
    session_id: SESSION,
    prompt: "hi",
    user_id: "u1",
    platform_key: "pk",
  } as ExecuteRequest;

  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);

  const raw = ckptStore.get(CKPT_KEY);
  return {
    verdicts, calls, writes,
    /** What the next attempt will read, or undefined if nothing was written. */
    persisted: raw
      ? JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>
      : undefined,
    sigtermWrote: writes.filter((w) => w === `ckpt.put:${CKPT_KEY}`).length,
  };
}

// ── The first tool batch after a resume ─────────────────────────────────────

test("a resumed run's first batch persists the cache use it just saw", async () => {
  // No onCheckpoint: this attempt has not finished a turn yet, which is the
  // whole point. The evidence exists, and before this fix it was dropped for
  // want of a checkpoint object to put it on.
  const r = await runScenario({
    resumeFrom: seededResumeCheckpoint({ last_cache_use_at: 1_000 }),
    async turn(extras) { extras.onCacheUse!(9_000); },
  });

  assert.deepEqual(r.verdicts, ["nak:0"], "SIGTERM still requeues for the next pod");
  assert.ok(r.persisted, "the resumed conversation must still be there");
  assert.equal(r.persisted!.last_cache_use_at, 9_000,
    "the timestamp from inside the interrupted batch is the one that is true");
  assert.equal(r.persisted!.turns_completed, 4,
    "the resumed run's progress is carried over, not reset");
});

test("a resumed run with nothing fresher to say republishes nothing", async () => {
  // The counterpart, and the reason the fallback is conditional. Rewriting a
  // checkpoint this attempt did not produce would claim work it did not do.
  const r = await runScenario({
    resumeFrom: seededResumeCheckpoint({ last_cache_use_at: 9_000 }),
    async turn() {},
  });

  assert.equal(r.sigtermWrote, 0, "there was nothing new to persist");
});

test("a resumed run does not move the timestamp backwards", async () => {
  const r = await runScenario({
    resumeFrom: seededResumeCheckpoint({ last_cache_use_at: 9_000 }),
    async turn(extras) { extras.onCacheUse!(1_000); },
  });

  assert.equal(r.sigtermWrote, 0, "an older timestamp is not fresher evidence");
});

// ── A run that never opened a sandbox ───────────────────────────────────────

test("a run with no sandbox still checkpoints on SIGTERM", async () => {
  // Network tools and backend MCP calls need no /workspace, and the sandbox
  // client is attached lazily, so `hands` stays null for a run that can have
  // completed any number of turns. Gating the KV write on it threw the whole
  // conversation away.
  const r = await runScenario({
    async turn(extras) {
      await extras.onCheckpoint!(checkpointState({ last_cache_use_at: 7_000 }));
      extras.onCacheUse!(8_500);
    },
  });

  assert.ok(r.persisted, "the conversation must survive a rolling restart");
  assert.equal(r.persisted!.turns_completed, 4);
  assert.equal(r.persisted!.last_cache_use_at, 8_500,
    "and so must the timestamp, which is what the whole freshening is for");
  assert.ok(!r.calls.includes("syncWorkspaceToS3"),
    "there is still no workspace to sync -- that half is what needed a sandbox");
  assert.ok(!r.calls.includes("syncWorkspace"), "nor a shared-filesystem sync");
});

// ── Compaction ──────────────────────────────────────────────────────────────

test("compaction's cleared timestamp is not resurrected by the SIGTERM overlay", async () => {
  // The loop reports cache use, then compaction discards the entry and the
  // next checkpoint carries no timestamp at all. The runner used to keep the
  // pre-compaction value and write it back here, and the resumed run then
  // measured a gap against an entry that had already been thrown away.
  const r = await runScenario({
    async turn(extras) {
      extras.onCacheUse!(9_000);
      await extras.onCheckpoint!(checkpointState({ last_cache_use_at: undefined }));
    },
  });

  assert.ok(r.persisted, "the checkpoint itself is still written");
  assert.equal(r.persisted!.last_cache_use_at, undefined,
    "no entry exists, so there is no timestamp -- silence, not a stale number");
});

test("cache use inside the batch after a checkpoint is still the freshest thing known", async () => {
  // The turn boundary is authoritative only as of the boundary. Synchronizing
  // to it must not cost the run the evidence produced after it, which is the
  // case the overlay exists for.
  const r = await runScenario({
    async turn(extras) {
      await extras.onCheckpoint!(checkpointState({ last_cache_use_at: 1_000 }));
      extras.onCacheUse!(9_000);
    },
  });

  assert.equal(r.persisted!.last_cache_use_at, 9_000);
});

// ── The window between the clear and the next checkpoint ───────────────────
//
// Compaction clears the loop's timestamp and then awaits an event publish
// before it reaches the checkpoint call at the bottom of the turn. A SIGTERM
// inside that await used to persist the checkpoint written BEFORE the
// compaction, timestamp and all -- a live-looking entry for one that had just
// been destroyed, which is the false loss this whole path exists to prevent.

test("a SIGTERM between the compaction clear and the next checkpoint drops the stale timestamp", async () => {
  const r = await runScenario({
    async turn(extras) {
      // The turn before the compaction: a real cache use, checkpointed.
      extras.onCacheUse!(7_000);
      await extras.onCheckpoint!(checkpointState({ last_cache_use_at: 7_000 }));
      // Compaction, reported on the line that clears it. No checkpoint
      // follows -- that is the window.
      extras.onCacheUse!(undefined);
    },
  });
  assert.ok(r.persisted, "the conversation still has to be persisted");
  assert.equal(r.persisted!.last_cache_use_at, undefined,
    "the entry it described was compacted away before the SIGTERM landed");
  assert.equal(r.persisted!.turns_completed, 4,
    "and everything else about the checkpoint is unchanged");
});

test("the same window on a resumed run does not republish the resume timestamp", async () => {
  // No checkpoint of this attempt's own: the fallback to the resume
  // checkpoint must not carry that checkpoint's timestamp forward either.
  const r = await runScenario({
    resumeFrom: seededResumeCheckpoint({ last_cache_use_at: 7_000 }),
    async turn(extras) { extras.onCacheUse!(undefined); },
  });
  assert.ok(r.persisted, "the resumed conversation must still be there");
  assert.equal(r.persisted!.last_cache_use_at, undefined,
    "a compacted run has no live entry, whichever checkpoint carries the state");
});

test("cache use after a compaction is evidence again", async () => {
  // The clear is not sticky: the next read writes a new entry, and the run
  // that is SIGTERMed after that one has something true to say.
  const r = await runScenario({
    async turn(extras) {
      extras.onCacheUse!(7_000);
      await extras.onCheckpoint!(checkpointState({ last_cache_use_at: 7_000 }));
      extras.onCacheUse!(undefined);
      extras.onCacheUse!(9_500);
    },
  });
  assert.equal(r.persisted!.last_cache_use_at, 9_500,
    "the post-compaction read is a fresh entry, not a resurrected one");
});
