// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * B38 -- a resumed run settles the sends its predecessor never finished,
 * whether or not the model asks for them again.
 *
 * `dispatched` is written durably before the request is handed to the
 * transport. A crash strictly between the two leaves a commitment for a request
 * that never went out, and resolving it only on the dispatch path closes that
 * window solely for the call the resumed model happens to re-emit: anything it
 * decides differently about is left outstanding for good, answering `unknown`
 * to every later replay for work that never ran.
 *
 * Driven through the run itself rather than by calling the reconciler, because
 * a reconciler nothing calls is exactly the defect -- and the run that most
 * needs it is the one that opens no sandbox at all, since a redelivery with no
 * checkpoint provisions one only if some tool asks.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

import { HandsClient, bindShellRecordsCapabilityForTest } from "../src/clients/hands.js";
import { bgRowStore, bindBgHandleRowsForTest } from "../src/sandbox/bg-row-store.js";
import { readRow, rowKey } from "../src/sandbox/bg-handle-rows.js";
import {
  bindTaskRunnerDeps, runHandleTask, type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";
import type { Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { activeAbort } from "../src/tasks/abort-registry.js";
import { matchesKvFilter } from "./fixtures/kv-filter.js";

const SESSION = "sess-resume";
const MESSAGE = "msg-resume";
/** `runId` is the task id where there is one, and the message id otherwise. */
const RUN = MESSAGE;
const ORPHAN = { ownerScope: SESSION, runIdentity: RUN, shellId: "bg-orphan" };

/** A revision-aware bucket stand-in that outlives the "pod" using it. */
function durableBucket() {
  const map = new Map<string, { value: Uint8Array; revision: number }>();
  const conflict = () => Object.assign(new Error("wrong last sequence"), { code: "10071" });
  return {
    async get(key: string) { return map.get(key) ?? null; },
    async create(key: string, value: Uint8Array) {
      if (map.has(key)) throw conflict();
      map.set(key, { value, revision: 1 });
    },
    async update(key: string, value: Uint8Array, expected: number) {
      const current = map.get(key);
      if (current?.revision !== expected) throw conflict();
      map.set(key, { value, revision: expected + 1 });
    },
    async delete(key: string) { map.delete(key); },
    async keys(filter: string) {
      const hits = [...map.keys()].filter((k) => matchesKvFilter(k, filter));
      return (async function* () { yield* hits; })();
    },
  };
}

let bucket: ReturnType<typeof durableBucket>;
let restoreRows: (() => void) | null = null;
let restoreCapability: (() => void) | null = null;
/** What the sandbox's record subtree says, as the probe route would report it. */
let recordAnswer: { marker: boolean; subtreeReadable: boolean; present: boolean };

beforeEach(() => {
  bucket = durableBucket();
  restoreRows = bindBgHandleRowsForTest(bucket as never);
  restoreCapability = bindShellRecordsCapabilityForTest(async () => true);
  recordAnswer = { marker: true, subtreeReadable: true, present: false };
});

afterEach(() => {
  restoreRows?.();
  restoreCapability?.();
  restoreRows = null;
  restoreCapability = null;
});

/** The commitment a dead predecessor left behind: sent to nothing, confirmed by nothing. */
async function seedOrphanedDispatch(generation: string): Promise<void> {
  await bgRowStore()!.write(rowKey(ORPHAN), JSON.stringify({
    ...ORPHAN, generation, state: "dispatched",
    stepIdentity: "toolu_predecessor", sequence: 1, claimedBy: "brain-dead",
  }), null);
}

function handsClient(url: string): HandsClient {
  const hands = new HandsClient(url, "tok", SESSION, RUN);
  (hands as unknown as { connected: boolean }).connected = true;
  (hands as unknown as { client: unknown }).client = {
    callTool: async () => { throw new Error("the resumed run issued nothing"); },
  };
  (hands as unknown as { probeShellRecord: unknown }).probeShellRecord = async () => {
    if (recordAnswer.present) return { kind: "record_present" };
    if (recordAnswer.marker && recordAnswer.subtreeReadable) return { kind: "determinately_absent" };
    return { kind: "indeterminate" };
  };
  return hands;
}

const URL = "http://sandbox:9100/mcp";
/** The generation is the endpoint the row was written against. */
const GENERATION = URL;

test("a send that demonstrably never landed stops being outstanding", async () => {
  await seedOrphanedDispatch(GENERATION);

  const settled = await handsClient(URL).reconcileOutstandingStarts();

  assert.deepEqual(settled.released, [ORPHAN.shellId]);
  assert.equal(await readRow(bgRowStore()!, ORPHAN), null,
    "the commitment is released, so the call is the first call it always was");
});

test("a send that did land is confirmed rather than released", async () => {
  recordAnswer = { marker: true, subtreeReadable: true, present: true };
  await seedOrphanedDispatch(GENERATION);

  const settled = await handsClient(URL).reconcileOutstandingStarts();

  assert.deepEqual(settled.confirmed, [ORPHAN.shellId]);
  assert.equal((await readRow(bgRowStore()!, ORPHAN))?.state, "spawn_confirmed",
    "the row attests the shell the send produced");
});

test("an absence that is not determinate settles nothing", async () => {
  // Fail-closed in both directions: releasing here would license re-running a
  // command that may have run, and confirming would attest a shell nothing saw.
  recordAnswer = { marker: false, subtreeReadable: false, present: false };
  await seedOrphanedDispatch(GENERATION);

  const settled = await handsClient(URL).reconcileOutstandingStarts();

  assert.deepEqual(settled.unresolved, [ORPHAN.shellId]);
  assert.equal((await readRow(bgRowStore()!, ORPHAN))?.state, "dispatched");
});

test("a commitment under a replaced sandbox is left exactly as it stands", async () => {
  await seedOrphanedDispatch("http://sandbox-previous:9100/mcp");

  const settled = await handsClient(URL).reconcileOutstandingStarts();

  assert.deepEqual(settled.unresolved, [ORPHAN.shellId],
    "whether it ran is not determinable against a sandbox that can no longer be asked");
  assert.equal((await readRow(bgRowStore()!, ORPHAN))?.state, "dispatched");
});

test("a resumed run that opens no sandbox still settles its predecessor's send", async () => {
  // The ordinary redelivery: no checkpoint, and a turn that calls no tool, so
  // nothing ever attaches. Reconciling at the attach reaches this run never,
  // and its predecessor's commitment is the one nothing else will settle.
  await seedOrphanedDispatch(GENERATION);
  let rowDuringRun: unknown = "not read";
  let attached = false;

  await runResumedTask(async () => {
    rowDuringRun = await readRow(bgRowStore()!, ORPHAN);
    return runResult();
  }, { onAttach: () => { attached = true; } });

  assert.equal(attached, false, "precondition: this run opened no sandbox");
  assert.equal(rowDuringRun, null,
    "the predecessor's unfinished send is settled before the run issues anything");
});

test("the resumed run reconciles when it attaches too", async () => {
  await seedOrphanedDispatch(GENERATION);
  let rowDuringRun: unknown = "not read";

  await runResumedTask(async (extras) => {
    await extras!.attachHands!();
    rowDuringRun = await readRow(bgRowStore()!, ORPHAN);
    return runResult();
  });

  assert.equal(rowDuringRun, null);
});

test("the model is told the call did not go through, not left to find out", async () => {
  // Releasing the commitment is what stops the request being stranded; on its
  // own it is a deletion nothing hears about, and the call simply never happens
  // unless the same tool use is re-emitted by chance.
  await seedOrphanedDispatch(GENERATION);
  let restored: Array<{ role: string; content: unknown }> = [];

  await runResumedTask(async (extras) => {
    restored = (extras!.resumeCheckpoint?.messages ?? []) as typeof restored;
    return runResult();
  }, { checkpoint: true });

  const notices = restored.filter(
    (m) => m.role === "user" && String(m.content).startsWith("[system-notice]:"),
  );
  assert.equal(notices.length, 1, JSON.stringify(restored));
  assert.match(String(notices[0].content), /never started/);
  assert.match(String(notices[0].content), new RegExp(ORPHAN.shellId));
});

test("an undecidable start is reported as undecidable, never as one that did not run", async () => {
  // The two readings lead opposite ways: re-issuing what demonstrably never ran
  // is correct, and re-issuing what may have run is the duplicate execution the
  // whole scheme exists to avoid.
  recordAnswer = { marker: false, subtreeReadable: false, present: false };
  await seedOrphanedDispatch(GENERATION);
  let restored: Array<{ role: string; content: unknown }> = [];

  await runResumedTask(async (extras) => {
    restored = (extras!.resumeCheckpoint?.messages ?? []) as typeof restored;
    return runResult();
  }, { checkpoint: true });

  const notice = restored.find(
    (m) => m.role === "user" && String(m.content).startsWith("[system-notice]:"),
  );
  assert.match(String(notice?.content), /cannot be determined/);
  assert.doesNotMatch(String(notice?.content), /never started/);
});

/** Enough of a task run to reach the engine, with the sandbox left to the run. */
async function runResumedTask(
  behaviour: (extras: ExecuteExtras | undefined) => Promise<ExecuteResult>,
  opts: { onAttach?: () => void; checkpoint?: boolean } = {},
): Promise<void> {
  const msg = {
    info: { deliveryCount: 2 },
    ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
  // The binding the predecessor left behind. Reconciliation resolves against
  // the generation the rows name, which is this one -- provisioning a fresh
  // sandbox instead would answer every outstanding row unknown by construction.
  const kv = emptyKv({
    [`hands.${SESSION}`]: JSON.stringify({ status: "ready", handsUrl: URL, token: "tok" }),
  });
  const kvCkpt = emptyKv(opts.checkpoint
    ? { [`task-ckpt.${SESSION}.${MESSAGE}`]: seededCheckpoint() }
    : {});
  const sideEffects = {
    ensureHands: (async () => {
      opts.onAttach?.();
      return { handsUrl: URL, created: false, token: "tok" };
    }) as never,
    destroyHands: (async () => {}) as never,
    reapPendingHands: (async () => {}) as never,
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => {}) as never,
    markRetryPending: (async () => {}) as never,
    syncWorkspaceToS3: (async () => ({
      uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true,
    })) as never,
    syncWorkspaceFromS3: (async () => {}) as never,
    archiveRunToS3: (async () => {}) as never,
    copyS3Prefix: (async () => ({ copied: 0 })) as never,
    syncWorkspace: (async () => ({ ok: true })) as never,
    restoreWorkspace: (async () => ({ ok: true })) as never,
    postAgentDone: (async () => {}) as never,
    postTaskRunning: (async () => {}) as never,
    runScript: (async () => runResult()) as never,
    refreshTaskLock: (async () => {}) as never,
    releaseTaskLock: (async () => {}) as never,
    flushTranscript: (async () => {}) as never,
    makeHandsClient: ((url: string) => handsClient(url)) as never,
  } as unknown as TaskRunnerSideEffects;

  const engine: Engine = {
    async execute(_req, _onEvent, _signal, _hands, extras) { return behaviour(extras); },
  };
  bindTaskRunnerDeps({
    kv, kvCkpt,
    emitter: { async emit() {} } as unknown as NatsEmitter,
    engine, sideEffects,
  });

  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(
    msg,
    { session_id: SESSION, prompt: "carry on", user_id: "u1", platform_key: "pk" } as ExecuteRequest,
    SESSION, lockKey, MESSAGE, "u1", abortCtrl,
  );
}

function emptyKv(seed: Record<string, string> = {}): KV {
  const store = new Map<string, Uint8Array>(
    Object.entries(seed).map(([k, v]) => [k, new TextEncoder().encode(v)]),
  );
  return {
    async get(key: string) {
      const value = store.get(key);
      return value ? { key, value } : null;
    },
    async put(key: string, value: Uint8Array) { store.set(key, value); return 1; },
    async delete(key: string) { store.delete(key); },
  } as unknown as KV;
}

function runResult(): ExecuteResult {
  return {
    finalText: "done",
    tokenUsage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
    turns: 1,
    pendingMemories: [],
    pendingSkills: [],
    skillsUsed: {},
    errorCount: 0,
    toolStats: { total_calls: 0, error_calls: 0, by_tool: {} },
    elapsedMs: 1,
  } as ExecuteResult;
}

/** A v3 checkpoint, so the run restores a conversation a notice can reach. */
function seededCheckpoint(): string {
  return JSON.stringify({
    version: 3,
    session_id: SESSION,
    message_id: MESSAGE,
    brain_id: "brain-1",
    brain_version: "test",
    checkpointed_at: Date.now(),
    turns_completed: 1,
    has_workspace_sync: false,
    messages: [{ role: "user", content: "start the training run" }],
    usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0, turns: 1 },
    text_parts: [],
    error_count: 0,
    tool_calls_by_name: {},
    total_tool_calls: 0,
    elapsed_ms_before: 1,
    setup_commands: [],
    plan_mode: false,
    todo_state: [],
    rebuilds_used: 0,
  });
}
