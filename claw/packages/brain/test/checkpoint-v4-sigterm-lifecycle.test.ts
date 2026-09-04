// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Sealed checkpoints and the SIGTERM cache-use lifecycle, in one run.
 *
 * These two arrived separately. One changed what a checkpoint IS -- an opaque
 * blob whose conversation nothing outside the codec can read -- and the other
 * changed what a SIGTERM PUTS in one: a cache-use timestamp that has to be
 * freshened when the entry is still live and dropped when compaction destroyed
 * it. Every existing test of the second reads the checkpoint as plaintext JSON,
 * so all of them would keep passing on a v4 fleet that had quietly stopped
 * writing the timestamp at all.
 *
 * This file drives a v4 run and reads what it wrote back through the codec, so
 * the lifecycle is asserted where a v4 deployment actually stores it.
 *
 * It owns its environment: both settings are read once at module scope.
 */
import { randomBytes } from "node:crypto";

const KEY = randomBytes(32);
process.env.CHECKPOINT_WRITE_VERSION = "4";
process.env.BRAIN_CHECKPOINT_KEY = KEY.toString("base64");

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import type { CheckpointState, Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { decodeCheckpoint } from "../src/tasks/checkpoint-codec.js";

const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { SIGTERM_ABORT_REASON, activeAbort } = await import("../src/tasks/abort-registry.js");
type SideEffects = Parameters<typeof bindTaskRunnerDeps>[0]["sideEffects"];

const SESSION = "sess-v4-sigterm";
const MESSAGE = "msg-v4-sigterm";
const USER = "u1";
const CKPT_KEY = `task-ckpt.${SESSION}.${MESSAGE}`;
const IDENTITY = { sessionId: SESSION, messageId: MESSAGE, userId: USER };
/** A recognisable phrase, to prove it is not sitting in the bucket in the clear. */
const UTTERANCE = "the plan is to run the migration against the staging replica first";

function checkpointState(over: Partial<CheckpointState> = {}): CheckpointState {
  return {
    messages: [{ role: "assistant", content: UTTERANCE }],
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

function fakeKv() {
  const store = new Map<string, Uint8Array>();
  let last: Uint8Array | undefined;
  const enc = new TextEncoder();
  const kv = {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value, revision: 1 } : null;
    },
    async put(key: string, value: Uint8Array | string) {
      const bytes = typeof value === "string" ? enc.encode(value) : value;
      store.set(key, bytes);
      if (key === CKPT_KEY) last = bytes;
      return 1;
    },
    async update(key: string, value: Uint8Array | string) {
      store.set(key, typeof value === "string" ? enc.encode(value) : value);
      return 1;
    },
    async delete(key: string) { store.delete(key); },
  };
  // A finished run deletes its own checkpoint key, so what a test reads is the
  // last thing written to it rather than what survives in the bucket.
  return { kv: kv as unknown as KV, store, written: () => last };
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

function stubSideEffects(): SideEffects {
  const record = <T>(value: T) => (...args: unknown[]) => {
    void args;
    return Promise.resolve(value) as never;
  };
  return {
    ensureHands: record({
      handsUrl: "http://hands.test",
      created: true,
      token: "t",
      identity: { provider: "safe-workload", workloadId: "wl-test", platformKey: "pk" },
    }),
    destroyHands: record(undefined),
    reapPendingHands: record(undefined),
    probeSandboxContainer: record("dead"),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => {}) as never,
    markRetryPending: record(undefined),
    syncWorkspaceToS3: record(
      { uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: record(undefined),
    archiveRunToS3: record(undefined),
    copyS3Prefix: record({ copied: 0 }),
    syncWorkspace: record({ ok: true }),
    restoreWorkspace: record({ ok: true }),
    postAgentDone: record(undefined),
    runScript: record(result()),
    refreshTaskLock: record(undefined),
    releaseTaskLock: record(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({
      endpoint: () => ({ url: "http://hands.test", token: "t" }),
      close: async () => {},
    })) as never,
  } as SideEffects;
}

/** One run that ends in a SIGTERM, with `turn` deciding what it did first. */
async function sigtermRun(opts: {
  turn: (extras: ExecuteExtras) => Promise<void>;
  /** Seeds the checkpoint key, i.e. this attempt is a resume. */
  resumeFrom?: Uint8Array;
}) {
  const ckpt = fakeKv();
  const plain = fakeKv();
  if (opts.resumeFrom) ckpt.store.set(CKPT_KEY, opts.resumeFrom);

  const msg = {
    info: { deliveryCount: opts.resumeFrom ? 2 : 1 },
    ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  const abortCtrl = new AbortController();

  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras) {
      await opts.turn(extras!);
      abortCtrl.abort(SIGTERM_ABORT_REASON);
      throw SIGTERM_ABORT_REASON;
    },
  };

  bindTaskRunnerDeps({
    kv: plain.kv, kvCkpt: ckpt.kv, emitter, engine, sideEffects: stubSideEffects(),
  });
  activeAbort.set(`lock.${SESSION}`, abortCtrl);
  await runHandleTask(
    msg,
    { session_id: SESSION, prompt: "hi", user_id: USER, platform_key: "pk" } as ExecuteRequest,
    SESSION, `lock.${SESSION}`, MESSAGE, USER, abortCtrl,
  );

  const bytes = ckpt.written();
  assert.ok(bytes, "the SIGTERM wrote no checkpoint at all");
  return { bytes, raw: JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> };
}

function open(bytes: Uint8Array): CheckpointState {
  const decoded = decodeCheckpoint(bytes, KEY, IDENTITY);
  assert.ok(decoded.ok, `expected a decode, got ${!decoded.ok && decoded.reason}`);
  assert.equal(decoded.version, 4, "this run is configured to write sealed checkpoints");
  return decoded.value.state;
}

test("a v4 SIGTERM seals the conversation and still carries the cache timestamp", async () => {
  const at = Date.now() - 30_000;
  const { bytes, raw } = await sigtermRun({
    async turn(extras) {
      await extras.onCheckpoint!(checkpointState({ last_cache_use_at: at }));
      // A tool batch after the checkpoint: the cache entry is still being read,
      // and this is the fresher evidence the SIGTERM overlay exists to keep.
      extras.onCacheUse!(Date.now());
    },
  });

  assert.equal(raw.version, 4);
  assert.ok(
    !new TextDecoder().decode(bytes).includes(UTTERANCE),
    "a sealed checkpoint must not carry the conversation in the clear",
  );

  const state = open(bytes);
  assert.equal((state.messages[0] as { content: string }).content, UTTERANCE);
  assert.ok(
    (state.last_cache_use_at ?? 0) > at,
    "the SIGTERM must persist the fresher cache-use timestamp, not the checkpoint's",
  );
});

test("a v4 SIGTERM after compaction persists no cache timestamp at all", async () => {
  // Compaction destroys the cache entry and the agent loop says so by clearing
  // its timestamp. Writing the pre-compaction value back is what made a resumed
  // run measure a gap against an entry that no longer existed and report a cache
  // loss that never happened. Sealing the payload must not lose the clear.
  const { bytes } = await sigtermRun({
    async turn(extras) {
      await extras.onCheckpoint!(checkpointState({ last_cache_use_at: Date.now() - 60_000 }));
      extras.onCacheUse!(Date.now());
      // Compaction: the loop drops the entry, then checkpoints without one.
      extras.onCacheUse!(undefined);
      await extras.onCheckpoint!(checkpointState({ last_cache_use_at: undefined }));
    },
  });

  const state = open(bytes);
  assert.equal(
    state.last_cache_use_at, undefined,
    "a cleared timestamp must stay cleared through the seal",
  );
});

test("a v4 run resumed from a v4 checkpoint keeps the cache timestamp forward", async () => {
  // The window the resume half of the lifecycle was written for: a run
  // interrupted once, resumed, and interrupted again during its first tool
  // batch -- before it has produced a checkpoint of its own. The only source of
  // conversation is the checkpoint it resumed from, and under v4 that means the
  // SIGTERM path has to open a sealed checkpoint, overlay the fresher
  // timestamp, and seal it again.
  const seeded = (await sigtermRun({
    async turn(extras) {
      await extras.onCheckpoint!(checkpointState({ last_cache_use_at: Date.now() - 120_000 }));
    },
  })).bytes;

  const fresh = Date.now();
  const { bytes } = await sigtermRun({
    resumeFrom: seeded,
    async turn(extras) {
      // No checkpoint of its own: one tool batch, then the pod goes away.
      extras.onCacheUse!(fresh);
    },
  });

  const state = open(bytes);
  assert.equal(
    (state.messages[0] as { content: string }).content, UTTERANCE,
    "the resumed conversation has to survive being opened and re-sealed",
  );
  assert.ok(
    (state.last_cache_use_at ?? 0) >= fresh,
    "the fresh timestamp from the batch that ran must reach the next attempt",
  );
});
