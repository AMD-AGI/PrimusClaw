// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Two checkpoint writes for the same run can be in flight at once: the turn
 * write the agent loop awaits, and the rewrite that runs in a `.then()` after a
 * workspace sync finishes. They land in whatever order NATS gives them, so an
 * older conversation can be published over a newer one.
 *
 * The runner detects that after the fact and repairs it by re-writing the
 * newest state. What this file pins is the part that is easy to get wrong: what
 * the repair carries, and what the loser of the race is told.
 *
 * A repair that is itself overtaken has NOT persisted the state its caller
 * asked for. Reporting success there is worse than reporting failure, because
 * the agent loop reads the result to decide whether to keep retrying -- so a
 * false success loses the write and stops the retry that would have replaced
 * it.
 *
 * This file owns its environment: WORKSPACE_PERSIST_BASE is empty by default,
 * and with it empty the post-sync rewrite -- the second writer, the one that
 * makes the race possible at all -- never runs.
 */
process.env.WORKSPACE_PERSIST_BASE = "/tmp/claw-test-workspace-race";
// Large enough that only the first checkpoint of a run schedules a sync
// (lastSyncAt starts at 0, so the first comparison always passes). One sync per
// run keeps the write ordering in these tests down to what each test issues.
process.env.WORKSPACE_SYNC_INTERVAL_MS = "600000";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import type { CheckpointState, Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";

const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
type SideEffects = Parameters<typeof bindTaskRunnerDeps>[0]["sideEffects"];

const SESSION = "sess-race";
const MESSAGE = "msg-race";
/** The sync path only runs for a 32-hex user id; see TaskRunner.userIdHex. */
const USER = "0123456789abcdef0123456789abcdef";
const CKPT_KEY = `task-ckpt.${SESSION}.${MESSAGE}`;

function state(turn: number): CheckpointState {
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
  } as CheckpointState;
}

/**
 * A KV whose checkpoint writes can be held open, addressed by the order they
 * are issued in.
 *
 * Holding the put rather than mocking a sequence counter is what makes the race
 * a real one: the runner's ordering check runs across that await, which is the
 * only place it can observe having been overtaken. `putStarted(n)` lets a test
 * wait until a write is genuinely in flight before landing the next one, so the
 * interleaving is fixed rather than left to the scheduler.
 */
function gatedKv() {
  const store = new Map<string, Uint8Array>();
  // Kept separately from the store: a finished run deletes its checkpoint key,
  // so the store is empty by the time a test reads it. What each test is
  // asserting on is which write was the last one to land under that key.
  let last: Uint8Array | undefined;
  const holds = new Map<number, { promise: Promise<void>; release: () => void }>();
  const started = new Map<number, { promise: Promise<void>; fire: () => void }>();
  let issued = 0;

  const slot = (n: number) => {
    let fire!: () => void;
    const promise = new Promise<void>((r) => { fire = r; });
    return { promise, fire, n };
  };
  const startedSlot = (n: number) => {
    let s = started.get(n);
    if (!s) { s = slot(n); started.set(n, s); }
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
      if (held) await held.promise;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      store.set(key, bytes);
      if (key === CKPT_KEY) last = bytes;
      return n;
    },
    async delete(key: string) { store.delete(key); },
  };

  /** Hold the nth write issued; returns its release. */
  function holdPut(n: number): () => void {
    const s = slot(n);
    holds.set(n, { promise: s.promise, release: s.fire });
    return s.fire;
  }
  /** Hold the write that comes next. Only meaningful with none in flight. */
  const holdNextPut = () => holdPut(issued + 1);
  const putStarted = (n: number) => startedSlot(n).promise;

  const lastWritten = () => {
    assert.ok(last, "nothing was ever written to the checkpoint key");
    return JSON.parse(new TextDecoder().decode(last)) as Record<string, unknown>;
  };

  return { kv: kv as unknown as KV, holdPut, holdNextPut, putStarted, lastWritten };
}

function stubSideEffects(calls: string[], over: Partial<SideEffects> = {}): SideEffects {
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
      { uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: record("syncWorkspaceFromS3", undefined),
    archiveRunToS3: record("archiveRunToS3", undefined),
    copyS3Prefix: record("copyS3Prefix", { copied: 0 }),
    syncWorkspace: record("syncWorkspace", { ok: true, size: 1, durationMs: 1 }),
    restoreWorkspace: record("restoreWorkspace", { ok: true }),
    postAgentDone: record("postAgentDone", undefined),
    runScript: record("runScript", {} as ExecuteResult),
    refreshTaskLock: record("refreshTaskLock", undefined),
    releaseTaskLock: record("releaseTaskLock", undefined),
    flushTranscript: ((..._a: unknown[]) => Promise.resolve()) as never,
    makeHandsClient: (() => ({
      endpoint: () => ({ url: "http://hands.test", token: "t" }),
      close: async () => {},
    })) as never,
    ...over,
  } as SideEffects;
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

/** Runs one agent turn whose body is `body`, with the gated KV underneath it. */
async function run(
  body: (extras: ExecuteExtras, kv: ReturnType<typeof gatedKv>) => Promise<void>,
  over: Partial<SideEffects> = {},
) {
  const calls: string[] = [];
  const kv = gatedKv();
  const plain = gatedKv();
  const msg = {
    info: { deliveryCount: 1 },
    ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
  const emitter = { async emit() {} } as unknown as NatsEmitter;
  const abortCtrl = new AbortController();

  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras) {
      await body(extras!, kv);
      return result();
    },
  };

  bindTaskRunnerDeps({
    kv: plain.kv, kvCkpt: kv.kv, emitter, engine,
    sideEffects: stubSideEffects(calls, over),
  });

  await runHandleTask(
    msg,
    { session_id: SESSION, prompt: "hi", user_id: USER, platform_key: "pk" } as ExecuteRequest,
    SESSION, `lock.${SESSION}`, MESSAGE, USER, abortCtrl,
  );
  return { kv, calls };
}

test("a stale write that loses the race is repaired with the newest state", async () => {
  let stale: Promise<void> | undefined;
  let staleError: unknown = "never settled";

  const { kv } = await run(async (extras, gk) => {
    // Turn 4's write is held open. Turn 5 then lands underneath it, which is
    // the ordering the .then() rewrite produces in production.
    const release = gk.holdNextPut();
    stale = extras.onCheckpoint!(state(4)).then(
      () => { staleError = undefined; },
      (e) => { staleError = e; },
    );
    await extras.onCheckpoint!(state(5));
    release();
    await stale;
  });

  assert.equal(staleError, undefined, "the repair succeeded, so the caller must be told so");
  assert.equal(
    kv.lastWritten().turns_completed, 5,
    "the key must hold the newest conversation, not the one that landed last",
  );
});

test("a repair that is itself overtaken is reported as the failure it is", async () => {
  let staleError: unknown = "never settled";

  const { kv } = await run(async (extras, gk) => {
    const releaseStale = gk.holdPut(1);
    const stale = extras.onCheckpoint!(state(4)).then(
      () => { staleError = undefined; },
      (e) => { staleError = e; },
    );
    await extras.onCheckpoint!(state(5));

    // Release the stale write and hold the repair it triggers -- the third
    // write this run issues -- so a fourth can land while the repair is still
    // in flight. This is the case the bounded single retry cannot fix: the
    // repair is not repaired again, so it has to say that it did not persist
    // what it was given.
    const releaseRepair = gk.holdPut(3);
    releaseStale();
    await gk.putStarted(3);
    await extras.onCheckpoint!(state(6));
    releaseRepair();
    await stale;
  });

  assert.ok(
    staleError instanceof Error,
    "an overtaken repair left the key holding other state, and must not report success",
  );
  assert.match(String(staleError), /checkpoint/i);
  assert.equal(
    kv.lastWritten().turns_completed, 5,
    "the overtaken repair landed last, which is exactly why it must not claim success:"
    + " the key now holds an older conversation than the caller was handed",
  );
});

test("a repair carries the workspace flag of the state it re-writes", async () => {
  // The repair re-writes `latestCheckpointState`, which is NOT the state its
  // caller was given. Pairing that newest conversation with the workspace
  // metadata its caller captured is how a repair used to clear
  // has_workspace_sync on a run that had in fact synced -- which sends the next
  // attempt to restore from S3 instead of the shared disk it wrote to.
  //
  // Reproducing that needs a turn write issued while the sync is still in
  // flight, so it captures `undefined` for the workspace, and landing after the
  // sync's own rewrite has moved the sequence past it. The sync is held open to
  // put those two in that order.
  let staleError: unknown = "never settled";
  let releaseSync!: () => void;
  const syncGate = new Promise<void>((r) => { releaseSync = r; });
  let syncs = 0;

  const { kv } = await run(async (extras, gk) => {
    await extras.attachHands!();
    // Schedules the sync, which now blocks in syncWorkspace.
    await extras.onCheckpoint!(state(1));

    // Issued before the sync finishes: this call sees lastSyncedTurn === 0 and
    // captures no workspace metadata at all. Its write is held so the sync's
    // rewrite lands first and it becomes the stale one.
    const releaseStale = gk.holdNextPut();
    const stale = extras.onCheckpoint!(state(4)).then(
      () => { staleError = undefined; },
      (e) => { staleError = e; },
    );

    releaseSync();
    for (let i = 0; i < 100 && !gk.lastWritten().has_workspace_sync; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(gk.lastWritten().has_workspace_sync, true, "the sync rewrite never landed");

    releaseStale();
    await stale;
  }, {
    syncWorkspace: (async (...args: unknown[]) => {
      void args;
      syncs++;
      await syncGate;
      return { ok: true, size: 1, durationMs: 1 };
    }) as never,
  });

  assert.equal(syncs, 1, "the shared-filesystem sync must have run, exactly once");
  assert.equal(staleError, undefined, "the repair landed, so the caller must be told so");
  const stored = kv.lastWritten();
  assert.equal(stored.turns_completed, 4, "the repair re-writes the newest state");
  assert.equal(
    stored.has_workspace_sync, true,
    "the repair must not clear a workspace sync that happened",
  );
  assert.equal(stored.last_sync_turn, 1, "and it carries the turn that synced");
});
