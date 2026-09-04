// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A late checkpoint repair must not undo the SIGTERM's cache-use correction.
 *
 * Two mechanisms that were built separately meet here. The SIGTERM path writes
 * the last checkpoint OVERLAID with what the run learned after the turn
 * boundary -- most importantly a fresher cache-use timestamp from a tool batch
 * that ran after the loop last handed state over. The ordering repair re-writes
 * `latestCheckpointState` when a write is found to have lost a race. That
 * snapshot is the PRE-overlay state, and the SIGTERM never writes its overlaid
 * copy back into it, so a repair landing after the SIGTERM republishes the
 * older timestamp -- and the next attempt reads the cache entry as colder than
 * the run knew it to be, which is the whole thing the freshening exists to
 * prevent.
 *
 * Neither mechanism is wrong on its own; the interleaving is. This file pins
 * it: the repair re-applies the same overlay from the same source.
 *
 * It owns its environment for the same reason the sibling race file does.
 */
process.env.WORKSPACE_PERSIST_BASE = "/tmp/claw-test-workspace-sigterm-repair";
process.env.WORKSPACE_SYNC_INTERVAL_MS = "600000";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import type { CheckpointState, Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";

const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { SIGTERM_ABORT_REASON, activeAbort } = await import("../src/tasks/abort-registry.js");
type SideEffects = Parameters<typeof bindTaskRunnerDeps>[0]["sideEffects"];

const SESSION = "sess-sigterm-repair";
const MESSAGE = "msg-sigterm-repair";
const USER = "0123456789abcdef0123456789abcdef";
const CKPT_KEY = `task-ckpt.${SESSION}.${MESSAGE}`;

/** The timestamp the turn boundary knew, and the fresher one the tool batch produced. */
const STALE_AT = 1_000;
const FRESH_AT = 9_000;

function state(turn: number, lastCacheUseAt?: number): CheckpointState {
  return {
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
    last_cache_use_at: lastCacheUseAt,
  } as CheckpointState;
}

/** The gated KV of the sibling race file: writes can be held by issue order. */
function gatedKv() {
  const store = new Map<string, Uint8Array>();
  let last: Uint8Array | undefined;
  const holds = new Map<number, Promise<void>>();
  const started = new Map<number, { promise: Promise<void>; fire: () => void }>();
  let issued = 0;

  const slot = () => {
    let fire!: () => void;
    const promise = new Promise<void>((r) => { fire = r; });
    return { promise, fire };
  };
  const startedSlot = (n: number) => {
    let s = started.get(n);
    if (!s) { s = slot(); started.set(n, s); }
    return s;
  };

  const kv = {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value } : null;
    },
    async put(key: string, value: Uint8Array | string) {
      const n = ++issued;
      startedSlot(n).fire();
      const held = holds.get(n);
      if (held) await held;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      store.set(key, bytes);
      if (key === CKPT_KEY) last = bytes;
      return n;
    },
    async delete(key: string) { store.delete(key); },
  };

  function holdPut(n: number): () => void {
    const s = slot();
    holds.set(n, s.promise);
    return s.fire;
  }
  const holdNextPut = () => holdPut(issued + 1);
  const putStarted = (n: number) => startedSlot(n).promise;
  const lastWritten = () => {
    assert.ok(last, "nothing was ever written to the checkpoint key");
    return JSON.parse(new TextDecoder().decode(last)) as Record<string, unknown>;
  };

  return { kv: kv as unknown as KV, holdPut, holdNextPut, putStarted, lastWritten };
}

function stubSideEffects(): SideEffects {
  const ok = <T>(value: T) => (...args: unknown[]) => {
    void args;
    return Promise.resolve(value) as never;
  };
  return {
    ensureHands: ok({
      handsUrl: "http://hands.test",
      created: true,
      token: "t",
      identity: { provider: "safe-workload", workloadId: "wl-test", platformKey: "pk" },
    }),
    destroyHands: ok(undefined),
    reapPendingHands: ok(undefined),
    probeSandboxContainer: ok("dead"),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => {}) as never,
    markRetryPending: ok(undefined),
    syncWorkspaceToS3: ok({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: ok(undefined),
    archiveRunToS3: ok(undefined),
    copyS3Prefix: ok({ copied: 0 }),
    syncWorkspace: ok({ ok: true, size: 1, durationMs: 1 }),
    restoreWorkspace: ok({ ok: true }),
    postAgentDone: ok(undefined),
    runScript: ok({} as ExecuteResult),
    refreshTaskLock: ok(undefined),
    releaseTaskLock: ok(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => ({
      endpoint: () => ({ url: "http://hands.test", token: "t" }),
      close: async () => {},
    })) as never,
  } as SideEffects;
}

test("a repair landing after the SIGTERM keeps the fresher cache timestamp", async () => {
  const kv = gatedKv();
  const plain = gatedKv();
  const msg = {
    info: { deliveryCount: 1 },
    ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  const abortCtrl = new AbortController();

  /** The write that loses the race; released only once the SIGTERM has landed. */
  let stale!: Promise<void>;
  let staleError: unknown = "never settled";

  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras: ExecuteExtras | undefined) {
      const e = extras!;
      // Write 1: held open, so it is still in flight when later writes land and
      // is therefore the one the runner finds to have been overtaken.
      const releaseStale = kv.holdNextPut();
      stale = e.onCheckpoint!(state(1, STALE_AT)).then(
        () => { staleError = undefined; },
        (err) => { staleError = err; },
      );
      // Write 2: lands, and becomes `latestCheckpointState` -- carrying the
      // turn-boundary timestamp, which is the value the repair used to resurrect.
      await e.onCheckpoint!(state(2, STALE_AT));

      // A tool batch after the boundary reads the cache entry again. This is
      // the evidence the SIGTERM overlay exists to persist.
      e.onCacheUse!(FRESH_AT);

      // Write 3 is the SIGTERM's. Release the stale write once it has started,
      // on a macrotask so the SIGTERM's put has completed and recorded its
      // sequence first -- that ordering is what makes the repair "late".
      void kv.putStarted(3).then(() => setTimeout(releaseStale, 5));

      abortCtrl.abort(SIGTERM_ABORT_REASON);
      throw SIGTERM_ABORT_REASON;
    },
  };

  bindTaskRunnerDeps({
    kv: plain.kv, kvCkpt: kv.kv, emitter, engine, sideEffects: stubSideEffects(),
  });
  activeAbort.set(`lock.${SESSION}`, abortCtrl);
  await runHandleTask(
    msg,
    { session_id: SESSION, prompt: "hi", user_id: USER, platform_key: "pk" } as ExecuteRequest,
    SESSION, `lock.${SESSION}`, MESSAGE, USER, abortCtrl,
  );

  await stale;
  assert.equal(staleError, undefined, "the repair landed, so its caller must be told so");

  const stored = kv.lastWritten();
  assert.equal(
    stored.turns_completed, 2,
    "the repair re-writes the newest conversation, which is what makes it a repair",
  );
  assert.equal(
    stored.last_cache_use_at, FRESH_AT,
    "the repair republished the pre-SIGTERM timestamp and undid the correction",
  );
});
