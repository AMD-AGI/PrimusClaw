// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// TaskRunner terminal-state lifecycle, driven through the real runHandleTask
// entry point with the outside world replaced via TaskRunnerDeps.sideEffects.
//
// What these tests are for: run()'s catch block routes every failure into one
// of four terminal states, and the difference between them is what NATS is told
// (ack vs nak) and whether the v3 checkpoint survives. Getting that routing
// wrong does not fail loudly — it strands sessions. Two specific hazards:
//
//   * the branch ORDER. A SIGTERM abort also has signal.aborted === true, so
//     the sigterm check must come first; if the generic-abort branch won the
//     race the task would be acked and the checkpoint deleted, and the session
//     would never resume after a rolling restart.
//   * the SIGTERM "detour" at the end of the happy path. hands.callTool does
//     not observe AbortSignal, so a tool that is mid-RPC when SIGTERM fires
//     returns a perfectly normal ExecuteResult. Without the explicit re-raise
//     that result falls through to finalizeSuccess, which acks and deletes the
//     checkpoint — the exact permanent-strand bug the detour exists to stop.
//
// Each test therefore asserts on the observable contract (ack/nak argument,
// checkpoint presence, emitted event types) rather than on internals.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import {
  bindTaskRunnerDeps,
  resolvePoisonedTask,
  runHandleTask,
  type TaskRunnerSideEffects,
} from "../src/tasks/runner.js";
import { HandsRebuildFailed, HandsRecoveryBudgetExhausted, HandsRecoveryRefused } from "../src/agent/index.js";
import type { CheckpointState, Engine, ExecuteExtras } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import { SIGTERM_ABORT_REASON, activeAbort } from "../src/tasks/abort-registry.js";
import { AgentDoneDeliveryError } from "../src/tasks/callback.js";
import { SandboxProvisionTerminalError } from "../src/sandbox/errors.js";
import { TASK_MAX_DELIVER } from "../src/config.js";
import { forgetDeletedSessions, markSessionDeleted } from "../src/infra/deleted-sessions.js";

// ── fakes ────────────────────────────────────────────────────────────────

/** Records the ack/nak verdict, which is the whole redelivery contract. */
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

/** In-memory stand-in for the three KV methods task-runner actually calls. */
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

function fakeEmitter() {
  const events: Array<Record<string, unknown>> = [];
  const emitter = {
    async emit(_sessionId: string, evt: Record<string, unknown>) { events.push(evt); },
  };
  return { emitter: emitter as unknown as NatsEmitter, events };
}

function result(over: Partial<ExecuteResult> = {}): ExecuteResult {
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
    ...over,
  } as ExecuteResult;
}

/**
 * Everything that leaves the process is stubbed to a no-op, and the calls are
 * recorded so a test can assert that e.g. the retry path marked retry-pending.
 * `makeHandsClient` returns a bare object: the stubbed workspace/S3 helpers
 * never dereference it, so no MCP transport is opened.
 */
function stubSideEffects(over: Partial<TaskRunnerSideEffects> = {}) {
  const calls: string[] = [];
  const transcripts: Array<Record<string, unknown>> = [];
  const transcriptLogs: Array<Array<Record<string, unknown>>> = [];
  const record = <T>(name: string, value: T) => (...args: unknown[]) => {
    calls.push(name);
    void args;
    return Promise.resolve(value) as never;
  };
  const base: TaskRunnerSideEffects = {
    ensureHands: record("ensureHands", {
      handsUrl: "http://hands.test",
      created: true,
      token: "t",
      identity: { provider: "safe-workload", workloadId: "wl-test", platformKey: "pk" },
    }),
    destroyHands: record("destroyHands", undefined),
    reapPendingHands: record("reapPendingHands", undefined),
    probeSandboxContainer: record("probeSandboxContainer", { verdict: "dead", reason: "no_kv_entry" }),
    restartHandsInSandbox: record("restartHandsInSandbox", { ok: true, detail: "healthy" }),
    unregisterSandbox: ((..._a: unknown[]) => { calls.push("unregisterSandbox"); }) as never,
    markHandsIdle: ((..._a: unknown[]) => { calls.push("markHandsIdle"); }) as never,
    markRetryPending: record("markRetryPending", undefined),
    syncWorkspaceToS3: record("syncWorkspaceToS3", { uploaded: 1, totalFiles: 1, failedCount: 0, exhausted: false, empty: false }),
    syncWorkspaceFromS3: record("syncWorkspaceFromS3", undefined),
    archiveRunToS3: record("archiveRunToS3", undefined),
    copyS3Prefix: record("copyS3Prefix", { copied: 0 }),
    syncWorkspace: record("syncWorkspace", { ok: true }),
    restoreWorkspace: record("restoreWorkspace", { ok: true }),
    postAgentDone: record("postAgentDone", undefined),
    // Stubbed for the DAG scenarios below: they carry a callback_url, so the
    // sandbox attach posts the running state to it, and left real that is an
    // outbound fetch whose behaviour depends on how DNS answers a host that
    // does not exist.
    postTaskRunning: record("postTaskRunning", undefined),
    runScript: record("runScript", result()),
    refreshTaskLock: record("refreshTaskLock", undefined),
    releaseTaskLock: record("releaseTaskLock", undefined),
    flushTranscript: ((...a: unknown[]) => {
      calls.push("flushTranscript");
      transcripts.push(a[5] as Record<string, unknown>);
      transcriptLogs.push(a[4] as Array<Record<string, unknown>>);
      return Promise.resolve();
    }) as never,
    // close() and reapShells() are the only HandsClient methods task-runner
    // calls directly; everything else goes through the helpers above.
    makeHandsClient: (() => {
      calls.push("makeHandsClient");
      return {
        close: async () => { calls.push("hands.close"); },
        reapShells: async () => { calls.push("hands.reapShells"); return 1; },
      } as never;
    }) as never,
    ...over,
  };
  return { sideEffects: base, calls, transcripts, transcriptLogs };
}

const SESSION = "sess-lifecycle";
const MESSAGE = "msg-1";
// Keyed per run, not per session: see task-runner checkpointKey.
const ckptKey = (sessionId = SESSION) => `task-ckpt.${sessionId}.${MESSAGE}`;
const CKPT_KEY = ckptKey();
/** Capture the ExecuteResult a terminal path hands the callback layer.
 *  `agent-done-body.test.ts` pins which of its fields reach the wire. */
function captureAgentDone() {
  const seen: ExecuteResult[] = [];
  return {
    seen,
    sideEffects: {
      postAgentDone: (async (_req: unknown, res: ExecuteResult) => { seen.push(res); }) as never,
    } as Partial<TaskRunnerSideEffects>,
  };
}

/**
 * Wire one scenario end to end. `engineBehavior` decides how the engine turn
 * resolves, which is the only input that selects a terminal state.
 */
async function runScenario(opts: {
  engineBehavior: (signal?: AbortSignal, extras?: ExecuteExtras) => Promise<ExecuteResult>;
  deliveryCount?: number;
  sideEffects?: Partial<TaskRunnerSideEffects>;
  onStart?: (abortCtrl: AbortController) => void;
  taskId?: string;
  // The deleted-session set is process-global and survives the scenario, so a
  // test about it runs under its own id rather than sharing SESSION.
  sessionId?: string;
  /** Extra request fields, for the terminal paths that depend on them. */
  request?: Partial<ExecuteRequest>;
  /**
   * A v3 checkpoint sitting in KV before the run starts, which is what makes
   * this a resumed run: `readKvCheckpoint` picks it up before any provisioning
   * and every "what had this run already done" question answers from it until
   * this attempt writes a checkpoint of its own.
   */
  seedCheckpoint?: Partial<CheckpointState>;
}) {
  const sessionId = opts.sessionId ?? SESSION;
  const { msg, verdicts } = fakeMsg(opts.deliveryCount ?? 1);
  const { kv } = fakeKv();
  const { kv: kvCkpt, store: ckptStore } = fakeKv();
  if (opts.seedCheckpoint) {
    ckptStore.set(
      ckptKey(sessionId),
      new TextEncoder().encode(JSON.stringify({
        version: 3,
        session_id: sessionId,
        message_id: MESSAGE,
        user_id: "u1",
        checkpointed_at: Date.now(),
        has_workspace_sync: false,
        last_sync_turn: 0,
        messages: [{ role: "user", content: "hi" }],
        turns_completed: 4,
        usage: { input_tokens: 10, output_tokens: 20, cache_read: 0, cache_create: 0 },
        text_parts: [],
        error_count: 2,
        tool_calls_by_name: { bash: 7 },
        total_tool_calls: 9,
        elapsed_ms_before: 3_600_000,
        setup_commands: [],
        ...opts.seedCheckpoint,
      })),
    );
  }
  const { emitter, events } = fakeEmitter();
  const { sideEffects, calls, transcripts, transcriptLogs } = stubSideEffects(opts.sideEffects);

  // Snapshot of what the session had been told by the time the engine started,
  // for the assertions about what must be announced before any slow work.
  let typesAtEngineStart: string[] = [];
  const engine: Engine = {
    async execute(_req, _onEvent, signal, _hands, extras) {
      calls.push("engine.execute");
      typesAtEngineStart = events.map((e) => String(e.type));
      return opts.engineBehavior(signal, extras);
    },
  };

  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });

  const request: ExecuteRequest = {
    session_id: sessionId,
    prompt: "hi",
    user_id: "u1",
    platform_key: "pk",
    ...(opts.taskId
      ? { task_id: opts.taskId, callback_url: "http://api.test/v1/internal/tasks" }
      : {}),
    ...opts.request,
  } as ExecuteRequest;

  const abortCtrl = new AbortController();
  const lockKey = `lock.${sessionId}`;
  activeAbort.set(lockKey, abortCtrl);
  opts.onStart?.(abortCtrl);

  await runHandleTask(msg, request, sessionId, lockKey, MESSAGE, "u1", abortCtrl);

  return {
    verdicts, events, calls, transcripts, transcriptLogs, ckptStore,
    typesAtEngineStart,
    types: events.map((e) => e.type),
    completion: events.find((e) => e.type === "exec_complete") as Record<string, unknown> | undefined,
  };
}

// ── success ──────────────────────────────────────────────────────────────

test("a clean run acks, reports success and drops the checkpoint", async () => {
  const r = await runScenario({ engineBehavior: async () => result({ turns: 3 }) });

  assert.deepEqual(r.verdicts, ["ack"], "a completed task must be acked exactly once");
  assert.equal(r.completion?.failed, false);
  assert.equal(r.completion?.turns, 3);
  assert.ok(r.calls.includes("postAgentDone"), "Backend must be told the task finished");
  assert.equal(r.ckptStore.has(CKPT_KEY), false, "success must not leave a resumable checkpoint");
  assert.ok(r.calls.includes("releaseTaskLock"), "the task lock must be released in finally");
});

// ── fatal ────────────────────────────────────────────────────────────────

test("a non-retryable error acks with failed=true and a presentable reason", async () => {
  const r = await runScenario({
    engineBehavior: async () => { throw new Error("schema validation blew up"); },
  });

  assert.deepEqual(r.verdicts, ["ack"], "a fatal error is terminal: ack, never redeliver");
  assert.equal(r.completion?.failed, true);
  assert.ok(String(r.completion?.final_text).length > 0, "the user must see some explanation");
  assert.ok(r.types.includes("statusUpdate"));
  assert.ok(r.calls.includes("postAgentDone"), "the DAG must learn the node failed");
  assert.equal(r.transcripts.at(-1)?.failed, true);
});

// ── terminal sandbox provisioning ──────────────────────────────────────────

test("a terminal sandbox-provisioning error acks with failed=true and never retries", async () => {
  // The routing hazard this guards: a SandboxProvisionTerminalError must be
  // caught ahead of the generic retryable check, or a terminal outcome (SaFE
  // Failed/Stopped, workload gone, unreadable status) would be naked into the
  // retry loop and strand the session in launching.
  // Script mode so the sandbox is provisioned up front. Under lazy creation an
  // ordinary chat turn asks for one only when a tool does, so the throw below
  // would sit on a path this run never takes and the failure being guarded
  // against could not happen at all.
  const r = await runScenario({
    request: { mode: "script" } as Partial<ExecuteRequest>,
    engineBehavior: async () => result(),
    sideEffects: {
      ensureHands: (async () => {
        throw new SandboxProvisionTerminalError("sandbox_status_unreadable", "SaFE status unreadable");
      }) as TaskRunnerSideEffects["ensureHands"],
    },
  });

  assert.deepEqual(r.verdicts, ["ack"], "a terminal provisioning outcome must ack, never redeliver");
  assert.equal(r.completion?.failed, true);
  assert.ok(!r.calls.includes("markRetryPending"), "a terminal outcome must not mark retry-pending");
  assert.ok(!r.calls.includes("engine.execute"), "the engine must never run when provisioning failed terminally");
  const failedEvt = r.events.find((e) => e.type === "sandboxStatus" && e.status === "failed");
  assert.equal(failedEvt?.reason, "sandbox_status_unreadable", "the machine reason must be surfaced");
});

test("a fatal error whose terminal handoff is exhausted naks and still lets go", async () => {
  // handleFatalError reports the failure from the middle of itself, so an
  // AgentDoneDeliveryError thrown there used to leave the catch chain entirely:
  // the message was neither acked nor nak'd, waiting out the whole ack_wait
  // instead of five seconds, and the release that follows the handoff never
  // ran, leaving this pod pinging a sandbox with no run on it.
  const r = await runScenario({
    taskId: "task-fatal-handoff",
    engineBehavior: async () => { throw new Error("schema validation blew up"); },
    sideEffects: {
      postAgentDone: (async () => {
        throw new AgentDoneDeliveryError("backend unavailable");
      }) as TaskRunnerSideEffects["postAgentDone"],
    },
  });

  assert.deepEqual(r.verdicts, ["nak:5000"], "the redelivery has to be asked for, and soon");
  assert.equal(
    r.ckptStore.has("task-result.task-fatal-handoff"), true,
    "the redelivery replays this entry rather than executing the task again",
  );
});

test("a terminal provisioning failure whose handoff is exhausted naks and lets go", async () => {
  // The same hazard as the case above, on the branch that routes a terminal
  // provisioning outcome. It reports through handleFatalError too, so an
  // AgentDoneDeliveryError raised in the middle of that has to be settled here
  // rather than left to escape: unsettled, the message waits out the whole
  // ack_wait instead of five seconds and the sandbox is never let go.
  //
  // Worth its own case rather than trusting the one above: this branch is
  // reached by every way provisioning can end terminally -- a workload gone, an
  // unreadable status, a queue ceiling, a pod that exited, a terminal phase --
  // so it is the more likely of the two to be taken, not the less.
  const r = await runScenario({
    taskId: "task-provision-handoff",
    request: { mode: "script" } as Partial<ExecuteRequest>,
    engineBehavior: async () => result(),
    sideEffects: {
      ensureHands: (async () => {
        throw new SandboxProvisionTerminalError("sandbox_gone", "workload disappeared");
      }) as TaskRunnerSideEffects["ensureHands"],
      postAgentDone: (async () => {
        throw new AgentDoneDeliveryError("backend unavailable");
      }) as TaskRunnerSideEffects["postAgentDone"],
    },
  });

  assert.deepEqual(r.verdicts, ["nak:5000"], "the redelivery has to be asked for, and soon");
});

// ── retryable ────────────────────────────────────────────────────────────

test("a retryable error naks for redelivery and marks retry-pending", async () => {
  const r = await runScenario({
    engineBehavior: async () => { throw new Error("ECONNREFUSED connecting to sandbox"); },
  });

  assert.deepEqual(r.verdicts, ["nak:5000"], "a retryable failure must be redelivered, not acked");
  assert.ok(r.calls.includes("markRetryPending"), "the retry must be visible to the keepalive reaper");
  assert.ok(r.calls.includes("reapPendingHands"), "a half-created sandbox must be reaped before redelivery");
  assert.equal(r.completion, undefined, "a retry is not a completion — exec_complete must not be emitted");
  assert.equal(r.transcripts.at(-1)?.retrying, true);
});

// ── user interrupt ───────────────────────────────────────────────────────

test("user interrupt vs fatal is decided by the abort signal, not the error", async () => {
  let ctrl!: AbortController;
  const r = await runScenario({
    onStart: (c) => { ctrl = c; },
    engineBehavior: async () => {
      ctrl.abort();                     // user pressed stop
      throw new Error("stream closed");  // ... and the engine unwinds
    },
  });

  assert.deepEqual(r.verdicts, ["ack"], "an interrupt is terminal for this delivery");
  assert.equal(r.completion?.interrupted, true);
  assert.equal(r.completion?.failed, false, "an interrupt is not a failure");
  assert.ok(
    String(r.completion?.final_text).includes("Interrupted by user"),
    "final_text must be non-empty so the assistant turn is persisted for future context",
  );
});

test("DAG cancellation posts a cancelled terminal callback on clean engine return", async () => {
  let ctrl!: AbortController;
  let callbackResult: ExecuteResult | undefined;
  const r = await runScenario({
    taskId: "task-cancel-clean",
    onStart: (c) => { ctrl = c; },
    engineBehavior: async () => {
      ctrl.abort(new Error("cancelled by user"));
      return result({ finalText: "partial" });
    },
    sideEffects: {
      postAgentDone: (async (_request, callback) => {
        callbackResult = callback;
      }) as TaskRunnerSideEffects["postAgentDone"],
    },
  });

  assert.deepEqual(r.verdicts, ["ack"]);
  assert.equal(callbackResult?.abortReason, "cancelled");
  assert.equal(r.ckptStore.has("task-result.task-cancel-clean"), false);
});

// ── background shells at the end of a run ────────────────────────────────
//
// A background shell deliberately outlives the turn that started it, which for
// a conversation is the point and for a batch node is a leak: nobody will poll
// a finished node's dev server, and it keeps burning CPU in a sandbox the whole
// workspace shares. Which terminal path a run took is what decides between the
// two, so the routing is what these pin.

/** A DAG node that reaches for a sandbox, which is what leaves shells behind. */
const DAG_NODE: Partial<ExecuteRequest> = {
  dag_id: "dag-1",
  dag_node_id: "node-1",
  dag_root_task_id: "root-1",
};

const attachThen = (outcome: () => Promise<ExecuteResult>) =>
  async (_signal?: AbortSignal, extras?: ExecuteExtras) => {
    await extras!.attachHands!();
    return outcome();
  };

test("a finished DAG node takes its background shells with it", async () => {
  const r = await runScenario({
    taskId: "task-dag-done",
    request: DAG_NODE,
    engineBehavior: attachThen(async () => result()),
  });

  assert.deepEqual(r.verdicts, ["ack"]);
  assert.ok(r.calls.includes("hands.reapShells"), "nothing will read them again");
  assert.ok(
    r.calls.indexOf("hands.reapShells") < r.calls.indexOf("syncWorkspaceToS3"),
    "stopping them first is what makes the uploaded workspace their final state",
  );
});

test("a DAG node that failed still takes them", async () => {
  // Otherwise the leak is worst exactly where it is most likely: a node that
  // died halfway is the one that left a build or a server running.
  const r = await runScenario({
    taskId: "task-dag-failed",
    request: DAG_NODE,
    engineBehavior: attachThen(async () => { throw new Error("schema validation blew up"); }),
  });

  assert.equal(r.completion?.failed, true);
  assert.ok(r.calls.includes("hands.reapShells"));
});

test("a chat turn leaves its background shells running", async () => {
  // The user is still there between turns, and being able to start something in
  // one turn and poll it in the next is the whole reason the tool exists.
  const r = await runScenario({
    engineBehavior: attachThen(async () => result()),
  });

  assert.deepEqual(r.verdicts, ["ack"]);
  assert.ok(!r.calls.includes("hands.reapShells"), "the next turn is expected to poll them");
});

test("the shells are asked for once, however many steps could ask", async () => {
  // Two steps of a successful node want them stopped: the snapshot, so it is not
  // read from underneath a running process, and the release on the way out. The
  // second is the general guarantee and cannot be dropped, so the reap itself
  // has to know it has already happened.
  const r = await runScenario({
    taskId: "task-dag-reap-once",
    request: DAG_NODE,
    engineBehavior: attachThen(async () => result()),
  });

  assert.equal(
    r.calls.filter((c) => c === "hands.reapShells").length, 1,
    "the release must not repeat a reap the snapshot already did",
  );
});

test("a reap that failed is asked again on the way out", async () => {
  // A round that failed is not a round: the shells are still running, and the
  // release is the last moment this run can reach them. So the flag that stops
  // the second attempt has to mean "already stopped", not "already asked".
  let attempts = 0;
  const r = await runScenario({
    taskId: "task-dag-reap-retry",
    request: DAG_NODE,
    engineBehavior: attachThen(async () => result()),
    sideEffects: {
      makeHandsClient: (() => ({
        close: async () => {},
        reapShells: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("sandbox unreachable");
          return 1;
        },
      })) as never,
    },
  });

  assert.deepEqual(r.verdicts, ["ack"], "a failed reap is best-effort, not a failed run");
  assert.equal(attempts, 2, "the first attempt left the shells running");
});

test("a node whose handoff ran out of retries still takes its shells", async () => {
  // The compensating release, which runs because handleFatalError threw before
  // reaching its own. Nothing else stops these shells: the fatal path has no
  // snapshot to protect and so no earlier reap, and the redelivery replays the
  // callback rather than the node.
  const r = await runScenario({
    taskId: "task-dag-handoff",
    request: DAG_NODE,
    engineBehavior: async (_signal?: AbortSignal, extras?: ExecuteExtras) => {
      await extras!.attachHands!();
      throw new Error("schema validation blew up");
    },
    sideEffects: {
      postAgentDone: (async () => {
        throw new AgentDoneDeliveryError("backend unavailable");
      }) as TaskRunnerSideEffects["postAgentDone"],
    },
  });

  assert.deepEqual(r.verdicts, ["nak:5000"]);
  assert.ok(r.calls.includes("hands.reapShells"), "a nak is not a reason to leave a build running");
});

// ── SIGTERM ──────────────────────────────────────────────────────────────

test("SIGTERM naks immediately and announces the interruption", async () => {
  let ctrl!: AbortController;
  const r = await runScenario({
    onStart: (c) => { ctrl = c; },
    engineBehavior: async () => {
      ctrl.abort(SIGTERM_ABORT_REASON);
      throw SIGTERM_ABORT_REASON;
    },
  });

  assert.deepEqual(r.verdicts, ["nak:0"], "SIGTERM must requeue with no delay for the next pod");
  assert.ok(r.types.includes("taskInterrupted"), "INV-8: the API side must flip the row to interrupted");
  assert.equal(r.completion, undefined, "SIGTERM is not a completion");
  assert.equal(r.transcripts.at(-1)?.sigterm, true);
});

test("a SIGTERM records what the run had done, not what this attempt had", async () => {
  // SIGTERMed after resuming but before the first new turn finishes, which is
  // when `latestCheckpointState` is still empty and the run's hour is only in
  // the checkpoint it started from. Both halves of the record have to come
  // from the same place, or it reports an hour against no turns.
  let ctrl!: AbortController;
  const r = await runScenario({
    deliveryCount: 2,
    seedCheckpoint: {},
    onStart: (c) => { ctrl = c; },
    engineBehavior: async () => {
      ctrl.abort(SIGTERM_ABORT_REASON);
      throw SIGTERM_ABORT_REASON;
    },
  });

  const exit = r.transcriptLogs.at(-1)?.find((e) => e.type === "task_exit" && e.reason === "sigterm");
  assert.ok(exit, "a SIGTERM must leave a task_exit record");
  assert.ok((exit?.elapsedMs as number) >= 3_600_000,
    `the hour behind this attempt counts (got ${exit?.elapsedMs})`);
  assert.equal(exit?.turnsCompleted, 4,
    "and the turn count beside it, or the record pairs an hour with no turns");
  assert.equal(r.transcripts.at(-1)?.turnsCompleted, 4,
    "the transcript header the same way");
  assert.equal(
    r.events.find((e) => e.type === "taskInterrupted")?.turns_completed, 4,
    "and the event announcing the interruption, so all three agree");
});

test("a DAG node interrupted by SIGTERM keeps its shells for the pod that resumes it", async () => {
  // The run is not over: the checkpoint stays and another pod picks the same
  // task up, into the same sandbox. Reaping here would kill work mid-flight and
  // the resumed run would have no record that it ever started.
  let ctrl!: AbortController;
  const r = await runScenario({
    taskId: "task-dag-sigterm",
    request: DAG_NODE,
    onStart: (c) => { ctrl = c; },
    engineBehavior: attachThen(async () => {
      ctrl.abort(SIGTERM_ABORT_REASON);
      throw SIGTERM_ABORT_REASON;
    }),
  });

  assert.deepEqual(r.verdicts, ["nak:0"]);
  assert.ok(!r.calls.includes("hands.reapShells"), "an interrupted run is not a finished one");
});

test("SIGTERM ordering: it must win over the generic aborted branch", async () => {
  // Both conditions are true here (reason === SIGTERM *and* signal.aborted).
  // If the branches were reordered this test would see ack instead of nak,
  // which is the strand-the-session bug.
  let ctrl!: AbortController;
  const r = await runScenario({
    onStart: (c) => { ctrl = c; },
    engineBehavior: async () => {
      ctrl.abort(SIGTERM_ABORT_REASON);
      throw SIGTERM_ABORT_REASON;
    },
  });

  assert.deepEqual(r.verdicts, ["nak:0"]);
  assert.equal(r.completion, undefined, "the user-interrupt branch must not have run");
});

test("SIGTERM detour: a normally-returning engine still takes the SIGTERM path", async () => {
  // The regression this guards: hands.callTool ignores AbortSignal, so a tool
  // mid-RPC at SIGTERM finishes and the engine returns a normal result. If
  // run() trusted that result it would ack and delete the checkpoint.
  let ctrl!: AbortController;
  const r = await runScenario({
    onStart: (c) => { ctrl = c; },
    engineBehavior: async () => {
      ctrl.abort(SIGTERM_ABORT_REASON);
      return result({ turns: 2 });   // NOT a throw
    },
  });

  assert.deepEqual(
    r.verdicts, ["nak:0"],
    "a normal return during SIGTERM must still requeue, or the session is stranded",
  );
  assert.equal(r.completion, undefined, "finalizeSuccess must not have run");
  assert.ok(r.types.includes("taskInterrupted"));
  assert.ok(!r.calls.includes("postAgentDone"), "the task did not finish, so no agent_done");
});

// ── redelivery ───────────────────────────────────────────────────────────

test("a redelivered task announces taskResumed before doing expensive work", async () => {
  const r = await runScenario({
    deliveryCount: 3,
    engineBehavior: async () => result(),
  });

  const resumedAt = r.types.indexOf("taskResumed");
  assert.ok(resumedAt >= 0, "redelivery must tell the UI the brain took the task back");
  assert.equal(
    r.events[resumedAt]?.delivery_count, 3,
    "the attempt number must travel with the event",
  );
  // The event exists to clear the interrupted toast promptly, so it has to be
  // out before the run does anything slow.
  assert.ok(
    r.typesAtEngineStart.includes("taskResumed"),
    "taskResumed is emitted before the run gets to work",
  );
  assert.ok(
    !r.calls.slice(0, r.calls.indexOf("engine.execute")).includes("ensureHands"),
    "a chat turn with no tool call must not open a sandbox first",
  );
});

test("a first delivery does not claim to be resumed", async () => {
  const r = await runScenario({ deliveryCount: 1, engineBehavior: async () => result() });
  assert.ok(!r.types.includes("taskResumed"));
});

test("poisoned DAG task sends the durable terminal callback before acking", async () => {
  const { msg, verdicts } = fakeMsg(9);
  const { kv } = fakeKv();
  const { kv: kvCkpt, store } = fakeKv();
  const { emitter, events } = fakeEmitter();
  let callbackResult: ExecuteResult | undefined;
  const { sideEffects } = stubSideEffects({
    postAgentDone: (async (_request, callback) => {
      callbackResult = callback;
    }) as TaskRunnerSideEffects["postAgentDone"],
  });
  bindTaskRunnerDeps({
    kv,
    kvCkpt,
    emitter,
    engine: {} as Engine,
    sideEffects,
  });
  const request = {
    task_id: "task-poison",
    session_id: SESSION,
    prompt: "hi",
    user_id: "u1",
    callback_url: "http://api.test/v1/internal/tasks",
  } as ExecuteRequest;

  await resolvePoisonedTask(
    msg,
    request,
    "max_retries_exceeded",
    "Task failed: exceeded maximum retry attempts.",
  );

  assert.deepEqual(verdicts, ["ack"]);
  assert.equal(callbackResult?.failureReason, "max_retries_exceeded");
  assert.equal(store.has("task-result.task-poison"), false, "acked callback must clear its outbox");
  assert.equal(events.at(-1)?.type, "exec_complete");
});

test("poisoned DAG task preserves its outbox and naks when callback delivery fails", async () => {
  const { msg, verdicts } = fakeMsg(9);
  const { kv } = fakeKv();
  const { kv: kvCkpt, store } = fakeKv();
  const { emitter } = fakeEmitter();
  const { sideEffects } = stubSideEffects({
    postAgentDone: (async () => {
      throw new AgentDoneDeliveryError("backend unavailable");
    }) as TaskRunnerSideEffects["postAgentDone"],
  });
  bindTaskRunnerDeps({
    kv,
    kvCkpt,
    emitter,
    engine: {} as Engine,
    sideEffects,
  });
  const request = {
    task_id: "task-poison-retry",
    session_id: SESSION,
    prompt: "hi",
    user_id: "u1",
    callback_url: "http://api.test/v1/internal/tasks",
  } as ExecuteRequest;

  await resolvePoisonedTask(
    msg,
    request,
    "lock_contention_exhausted",
    "Task failed while waiting for an earlier task.",
  );

  assert.deepEqual(verdicts, ["nak:5000"]);
  assert.equal(
    store.has("task-result.task-poison-retry"),
    true,
    "failed callback must remain durable for the next delivery",
  );
});

// The guard fires at TASK_MAX_DELIVER-1, so a failing handoff gets exactly one
// more delivery. Naking on that last one asks for a redelivery NATS will
// refuse, and the message disappears with the session still marked running --
// the silent drop the guard exists to prevent, reached by the one route it
// cannot fix. It has to end loudly instead.
test("poisoned task whose handoff never succeeds terminates instead of vanishing", async () => {
  const { msg, verdicts } = fakeMsg(TASK_MAX_DELIVER);
  const { kv } = fakeKv();
  const { kv: kvCkpt, store } = fakeKv();
  const { emitter } = fakeEmitter();
  const { sideEffects } = stubSideEffects({
    postAgentDone: (async () => {
      throw new AgentDoneDeliveryError("backend unavailable");
    }) as TaskRunnerSideEffects["postAgentDone"],
  });
  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine: {} as Engine, sideEffects });
  const request = {
    task_id: "task-poison-final",
    session_id: SESSION,
    prompt: "hi",
    user_id: "u1",
    callback_url: "http://api.test/v1/internal/tasks",
  } as ExecuteRequest;

  await resolvePoisonedTask(
    msg,
    request,
    "lock_contention_exhausted",
    "Task failed while waiting for an earlier task.",
  );

  assert.deepEqual(
    verdicts, ["term"],
    "the last delivery has nothing left to nak into; terminate so the give-up is explicit",
  );
  assert.equal(
    store.has("task-result.task-poison-final"),
    true,
    "the outbox entry must survive for whoever reconciles the stuck session",
  );
});

test("redelivery replays a persisted callback without executing the task again", async () => {
  const { msg, verdicts } = fakeMsg(2);
  const { kv } = fakeKv();
  const { kv: kvCkpt, store } = fakeKv();
  const { emitter } = fakeEmitter();
  const { sideEffects, calls } = stubSideEffects();
  const taskId = "task-outbox";
  store.set(
    `task-result.${taskId}`,
    new TextEncoder().encode(JSON.stringify(result({ finalText: "already finished" }))),
  );
  const engine: Engine = {
    async execute() {
      calls.push("engine.execute");
      return result();
    },
  };
  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine, sideEffects });

  const request = {
    task_id: taskId,
    session_id: SESSION,
    prompt: "hi",
    user_id: "u1",
    platform_key: "pk",
  } as ExecuteRequest;
  const abortCtrl = new AbortController();
  const lockKey = `lock.${taskId}`;
  activeAbort.set(lockKey, abortCtrl);

  await runHandleTask(msg, request, SESSION, lockKey, MESSAGE, "u1", abortCtrl);

  assert.deepEqual(verdicts, ["ack"]);
  assert.equal(calls.filter((call) => call === "postAgentDone").length, 1);
  assert.ok(!calls.includes("engine.execute"), "replay must not repeat task side effects");
  assert.equal(store.has(`task-result.${taskId}`), false);
  assert.ok(calls.includes("releaseTaskLock"));
});

// ── in-flight snapshot recovery ───────────────────────────────────────────

// recoverInflightCheckpoint is the salvage path for a long run whose terminal
// workspace sync failed: it copies the last periodic snapshot, server-side,
// into `users/<u>/sessions/<sid>/`. That is the prefix a session delete has
// just finished emptying, so a copy landing after one restores a whole
// workspace under a session nothing will ever collect -- the same hazard as a
// late transcript flush, with a snapshot behind it instead of one object.
//
// Reaching it needs a snapshot to exist, and the only writer is the in-flight
// checkpoint timer, whose first fire is thirty minutes into the run. The timer
// is advanced from inside the engine turn, which is where the run still has
// somewhere to go and has not yet reached a terminal path; nothing in the runner
// is stubbed for the test's benefit that the other scenarios here do not already
// stub. The turn opens the sandbox first, the way a turn that reaches
// /workspace does, because the timer has nothing to snapshot without one -- a
// run that never touches the workspace has no in-flight checkpoint to recover.
const INFLIGHT_CHECKPOINT_FIRST_FIRE_MS = 30 * 60 * 1000;

async function fatalRunAfterInflightSnapshot(sessionId: string) {
  // setInterval only: the run's deadline and its sync grace windows are
  // setTimeout, and holding those would stall the scenario rather than advance
  // it.
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    return await runScenario({
      sessionId,
      engineBehavior: async (_signal, extras) => {
        await extras!.attachHands!();
        mock.timers.tick(INFLIGHT_CHECKPOINT_FIRST_FIRE_MS);
        // The snapshot upload is deliberately fire-and-forget so a slow S3
        // never holds up the agent loop, so the turn has to yield once for it
        // to have marked the checkpoint usable.
        await new Promise((resolve) => setImmediate(resolve));
        throw new Error("schema validation blew up");
      },
    });
  } finally {
    mock.timers.reset();
  }
}

test("a fatal run whose session was deleted copies no snapshot back", async () => {
  forgetDeletedSessions();
  markSessionDeleted("sess-inflight-gone");
  try {
    const r = await fatalRunAfterInflightSnapshot("sess-inflight-gone");

    assert.ok(
      r.calls.includes("syncWorkspaceToS3"),
      "the snapshot must have been written, or the guard is not what stopped the copy",
    );
    assert.ok(
      !r.calls.includes("copyS3Prefix"),
      "the delete already emptied this prefix; a snapshot may not be restored into it",
    );
  } finally {
    forgetDeletedSessions();
  }
});

test("a fatal run on a live session still salvages its snapshot", async () => {
  // The negative case alone would pass with the recovery deleted outright, and
  // this recovery is all that stands between a failed terminal sync and a lost
  // workspace.
  forgetDeletedSessions();

  const r = await fatalRunAfterInflightSnapshot("sess-inflight-live");

  assert.ok(
    r.calls.includes("copyS3Prefix"),
    "a run whose session is intact must still get its last snapshot back",
  );
});

// ─── Sandbox recovery: which repair, given what the sandbox actually is ──────
//
// Three facts decide it -- whether the container answers exec, whether Hands
// answers /health inside it, and whether Hands can be started again -- and the
// only combination that may destroy anything is a container that is genuinely
// gone. These pin each row of that table through the real recreateHands.

/** Stub Hands' /health for the recovery decision. Returns the restore call. */
function stubHandsHealth(ok: boolean): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    assert.match(String(input), /\/health$/, "recovery only fetches the health route");
    return { ok, status: ok ? 200 : 503 } as Response;
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

async function recoveryScenario(opts: {
  probe: { verdict: string; reason: string };
  handsHealthy: boolean;
  restartOk?: boolean;
  destroyFails?: boolean;
  /** Make the replacement provision fail, i.e. a rebuild entered and lost. */
  provisionFails?: boolean;
  allowance?: { rebuild: boolean; nondestructive: boolean };
  request?: Partial<ExecuteRequest>;
}) {
  const restoreFetch = stubHandsHealth(opts.handsHealthy);
  let action: string | undefined;
  let thrown: unknown;
  let refusal: string | undefined;
  let restartCalls = 0;
  let provisionCalls = 0;
  try {
    const r = await runScenario({
      request: opts.request,
      sideEffects: {
        probeSandboxContainer: (async () => opts.probe) as never,
        ...(opts.destroyFails
          ? { destroyHands: async () => { throw new Error("stop unavailable"); } }
          : {}),
        ...(opts.provisionFails
          ? {
            // The first call is the run's initial attach and must succeed; the
            // second is the replacement the rebuild goes looking for.
            ensureHands: (async () => {
              if (++provisionCalls > 1) {
                throw new Error("no capacity for a replacement sandbox");
              }
              return {
                handsUrl: "http://hands.test",
                created: true,
                token: "t",
                identity: { provider: "safe-workload", workloadId: "wl-test", platformKey: "pk" },
              };
            }) as never,
          }
          : {}),
        restartHandsInSandbox: (async () => {
          restartCalls++;
          return {
            ok: opts.restartOk ?? false,
            detail: opts.restartOk ? "healthy" : "started_but_unhealthy",
          };
        }) as never,
      },
      engineBehavior: async (_signal, extras) => {
        await extras?.attachHands?.();
        try {
          const outcome = await extras?.recreateHands?.(opts.allowance);
          assert.ok(outcome && typeof outcome === "object" && "action" in outcome);
          action = (outcome as { action: string }).action;
        } catch (e) {
          refusal = (e as Error).message;
          thrown = e;
        }
        return result();
      },
    });
    return { ...r, action, refusal, restartCalls, thrown };
  } finally {
    restoreFetch();
  }
}

test("a live container with a healthy Hands is reconnected, not touched", async () => {
  const r = await recoveryScenario({
    probe: { verdict: "alive", reason: "exec_ok" },
    handsHealthy: true,
  });

  assert.equal(r.action, "reconnected");
  assert.equal(
    r.calls.filter((c) => c === "destroyHands").length, 0,
    "a live container must not be stopped just because Hands MCP blipped",
  );
  assert.equal(
    r.calls.filter((c) => c === "ensureHands").length, 1,
    "a repair that only renews the transport must not provision a sandbox",
  );
  assert.equal(r.restartCalls, 0, "Hands is answering; there is nothing to restart");
  assert.ok(
    r.calls.filter((c) => c === "makeHandsClient").length >= 2,
    "the stale client is replaced, since its latched connection cannot re-handshake",
  );
});

test("a live container with a dead Hands has Hands restarted in place", async () => {
  const r = await recoveryScenario({
    probe: { verdict: "alive", reason: "exec_ok" },
    handsHealthy: false,
    restartOk: true,
  });

  assert.equal(r.action, "hands_restarted");
  assert.equal(r.restartCalls, 1);
  assert.equal(
    r.calls.filter((c) => c === "destroyHands").length, 0,
    "restarting a tool server must not cost the container its running work",
  );
});

test("a Hands that will not come back leaves the container alone anyway", async () => {
  const r = await recoveryScenario({
    probe: { verdict: "alive", reason: "exec_ok" },
    handsHealthy: false,
    restartOk: false,
  });

  // Deliberately not escalating to a rebuild: the container is demonstrably
  // alive, so destroying it to fix its tool server would kill whatever is
  // holding it. The loop's recovery budget is what stops this repeating.
  assert.equal(r.action, "left_alone");
  assert.equal(r.calls.filter((c) => c === "destroyHands").length, 0);
});

test("a probe that could not reach anything destroys nothing", async () => {
  const r = await recoveryScenario({
    probe: { verdict: "unknown", reason: "kv_unreachable" },
    handsHealthy: false,
  });

  assert.equal(r.action, "left_alone");
  assert.equal(
    r.calls.filter((c) => c === "destroyHands").length, 0,
    "an unreadable KV bucket is not evidence that a sandbox is gone",
  );
  assert.equal(
    r.restartCalls, 0,
    "there is no established container to restart Hands inside",
  );
});

test("a container that is genuinely gone is destroyed and replaced", async () => {
  const r = await recoveryScenario({
    probe: { verdict: "dead", reason: "exec_sandbox_gone" },
    handsHealthy: false,
  });

  assert.equal(r.action, "rebuilt");
  assert.ok(r.calls.includes("destroyHands"), "a dead container must still be replaced");
  assert.ok(
    r.calls.filter((c) => c === "ensureHands").length >= 2,
    "the replacement sandbox must be provisioned after destroy",
  );
});

test("exhausted nondestructive budget does not block an available rebuild", async () => {
  const r = await recoveryScenario({
    probe: { verdict: "dead", reason: "exec_sandbox_gone" },
    handsHealthy: false,
    allowance: { rebuild: true, nondestructive: false },
  });
  assert.equal(r.action, "rebuilt");
});

test("exhausted rebuild budget does not block an available reconnect", async () => {
  const r = await recoveryScenario({
    probe: { verdict: "alive", reason: "exec_ok" },
    handsHealthy: true,
    allowance: { rebuild: false, nondestructive: true },
  });
  assert.equal(r.action, "reconnected");
});

test("a failed stop does not provision over a possibly live sandbox", async () => {
  const r = await recoveryScenario({
    probe: { verdict: "dead", reason: "exec_sandbox_gone" },
    handsHealthy: false,
    destroyFails: true,
  });

  assert.equal(r.action, undefined);
  assert.match(String(r.refusal), /stop unavailable/);
  assert.equal(
    r.calls.filter((c) => c === "ensureHands").length,
    1,
    "only the initial attach may run when teardown was not confirmed",
  );
});

test("a DAG node refuses to rebuild a sandbox it inherited", async () => {
  // `sandbox_spec.use` names one sandbox, but destroyHands and the hands KV
  // entry are both addressed by session -- and every node of a DAG shares one.
  // Rebuilding here would stop whichever sandbox last wrote that key, which is
  // the shared one the siblings are still working in.
  const r = await recoveryScenario({
    probe: { verdict: "dead", reason: "exec_sandbox_gone" },
    handsHealthy: false,
    request: {
      sandbox_spec: { use: "train" },
      dag_root_task_id: "dag-1",
      task_id: "node-2",
    } as Partial<ExecuteRequest>,
  });

  assert.equal(r.action, undefined, "the recovery must not report having repaired anything");
  assert.match(String(r.refusal), /sandbox_spec\.use='train'/);
  assert.match(String(r.refusal), /did not create/);
  // The type is what the loop reads, and it decides whether this repeats. A
  // plain Error is charged to the non-destructive budget and latches nothing,
  // so every later batch pays for another probe and pushes the same paragraph
  // at the model; HandsRecoveryRefused says "this answer cannot change", which
  // the loop latches on first sight.
  assert.ok(r.thrown instanceof HandsRecoveryRefused,
    `the refusal must be typed as permanent, got ${(r.thrown as Error)?.name}`);
  assert.equal(
    r.calls.filter((c) => c === "destroyHands").length, 0,
    "a node must never destroy a sandbox shared with its siblings",
  );
});

test("a DAG create node stops its own sandbox, not whichever sibling wrote the session key", async () => {
  const identity = { provider: "safe-workload", workloadId: "node-a", namespace: "ns" };
  const destroyArgs: unknown[][] = [];
  const ensureArgs: unknown[][] = [];
  const restoreFetch = stubHandsHealth(false);
  try {
    let action: string | undefined;
    await runScenario({
      request: {
        dag_root_task_id: "dag-1",
        task_id: "node-create",
      } as Partial<ExecuteRequest>,
      sideEffects: {
        probeSandboxContainer: (async () => ({
          verdict: "dead",
          reason: "exec_sandbox_gone",
        })) as never,
        ensureHands: (async (...args: unknown[]) => {
          ensureArgs.push(args);
          return {
            handsUrl: "http://hands.test",
            created: true,
            token: "t",
            identity,
          };
        }) as never,
        destroyHands: (async (...args: unknown[]) => {
          destroyArgs.push(args);
        }) as never,
      },
      engineBehavior: async (_signal, extras) => {
        await extras?.attachHands?.();
        const outcome = await extras?.recreateHands?.();
        assert.ok(outcome && typeof outcome === "object" && "action" in outcome);
        action = (outcome as { action: string }).action;
        return result();
      },
    });
    assert.equal(action, "rebuilt");
    assert.equal(destroyArgs.length, 1);
    assert.equal(destroyArgs[0]![0], SESSION);
    assert.deepEqual(destroyArgs[0]![1], identity);
    assert.equal(destroyArgs[0]![2], "t", "only this sandbox's token may be revoked");
    assert.equal(ensureArgs.length, 2, "initial attach plus replacement");
    assert.equal(
      (ensureArgs[1]![5] as { skipSessionReuse?: boolean }).skipSessionReuse,
      true,
      "replacement must not attach to a sibling through the shared session key",
    );
    // The run's signal travels with it, or a cancelled rebuild goes on probing
    // and restarting Hands in a container another replica may be tearing down.
    assert.ok(
      (ensureArgs[1]![5] as { signal?: AbortSignal }).signal instanceof AbortSignal,
      "the replacement must be cancellable with the run",
    );
  } finally {
    restoreFetch();
  }
});

test("a rebuild that destroys and then cannot provision is marked as a spent rebuild", async () => {
  // The budget fix has two halves and only the loop's half was covered: every
  // existing test drove HandsRebuildFailed from a stub, so nothing pinned that
  // task-runner wraps a failed rebuild in it. Unwrap it and the loop charges
  // the failure to the non-destructive budget again, leaving the rebuild budget
  // at zero and the allowance to destroy permanently granted.
  const r = await recoveryScenario({
    probe: { verdict: "dead", reason: "exec_sandbox_gone" },
    handsHealthy: false,
    provisionFails: true,
  });

  assert.ok(r.thrown instanceof HandsRebuildFailed,
    `a rebuild past the destroy must name itself; got ${String(r.thrown)}`);
  assert.match(String(r.refusal), /no capacity/,
    "and must not swallow why the provision failed");
});

test("a spent rebuild budget refuses the destroy with the typed budget error", async () => {
  // The loop reads `instanceof HandsRecoveryBudgetExhausted` to tell a refusal
  // from a failure. Every budget test drives that error from its own stub, so
  // the production throw was unpinned: delete it and a task whose rebuild
  // budget is gone destroys the sandbox anyway, with the suite green.
  const r = await recoveryScenario({
    probe: { verdict: "dead", reason: "exec_sandbox_gone" },
    handsHealthy: false,
    allowance: { rebuild: false, nondestructive: true },
  });

  assert.ok(r.thrown instanceof HandsRecoveryBudgetExhausted,
    `a spent rebuild budget must refuse, typed; got ${String(r.thrown)}`);
  assert.equal((r.thrown as InstanceType<typeof HandsRecoveryBudgetExhausted>).kind, "rebuild");
  assert.equal(r.action, undefined, "and must not have rebuilt anything");
});

test("a spent non-destructive budget refuses the in-place repair, typed", async () => {
  const r = await recoveryScenario({
    probe: { verdict: "alive", reason: "exec_ok" },
    handsHealthy: false,
    allowance: { rebuild: true, nondestructive: false },
  });

  assert.ok(r.thrown instanceof HandsRecoveryBudgetExhausted,
    `a spent recovery budget must refuse, typed; got ${String(r.thrown)}`);
  assert.equal((r.thrown as InstanceType<typeof HandsRecoveryBudgetExhausted>).kind, "recovery");
});

test("the initial sandbox attach is cancellable too, not just the rebuild", async () => {
  // Only the replacement call was pinned. The first attach runs ensureHands'
  // reuse path -- health check, probe, restart -- which is the slowest I/O in
  // the run, so a cancelled task with no signal there waits it all out.
  const ensureArgs: unknown[][] = [];
  await runScenario({
    // The sandbox is lazy, so the run only attaches one when the engine asks.
    engineBehavior: async (_signal, extras) => {
      await extras?.attachHands?.();
      return result();
    },
    sideEffects: {
      ensureHands: (async (...args: unknown[]) => {
        ensureArgs.push(args);
        return {
          handsUrl: "http://hands.test",
          created: true,
          token: "t",
          identity: { provider: "safe-workload", workloadId: "wl-test", platformKey: "pk" },
        };
      }) as never,
    },
  });

  assert.ok(ensureArgs.length >= 1, "the run must have attached a sandbox");
  assert.ok(
    (ensureArgs[0]![5] as { signal?: AbortSignal } | undefined)?.signal instanceof AbortSignal,
    "the initial attach must carry the run's signal",
  );
});

// ── interrupt telemetry ──────────────────────────────────────────────────
//
// An interrupt is not a rare ending on this fleet -- when this was written it
// was a little under half of all turns. The event it emits carried `turns` and
// `token_usage` but neither the elapsed time nor the tool counts, so that share
// of every duration or activity measurement was a hole, and it was the share
// where a user decided the run had gone on long enough, which is the
// interesting one.

/** Drive a run that checkpoints once, then is interrupted by the user. */
async function interruptedAfterCheckpoint(state: Partial<CheckpointState> = {}) {
  let abort: AbortController | undefined;
  return runScenario({
    onStart: (ctrl) => { abort = ctrl; },
    engineBehavior: async (signal, extras) => {
      await extras?.onCheckpoint?.({
        messages: [], turns_completed: 4, text_parts: [],
        usage: { input_tokens: 1, output_tokens: 2, cache_read: 0, cache_create: 0 },
        error_count: 2, tool_calls_by_name: { bash: 7 }, total_tool_calls: 9,
        elapsed_ms_before: 61_000, setup_commands: [],
        ...state,
      } as CheckpointState);
      abort?.abort();
      // The engine returns rather than throwing: the runner decides the ending
      // from the abort signal, and this is the shape a real engine exits with.
      return result({ turns: 4 });
    },
  });
}

test("an interrupt reports how long the turn it landed in had been running", async () => {
  // An interrupt lands inside a turn by definition -- and a user presses stop
  // because a turn is dragging, so that turn is systematically the longest one
  // the run had. The checkpoint cannot see it: it is written at a turn boundary
  // and skipped outright once the signal is aborted. Reporting the checkpoint's
  // own clock would drop exactly the part worth measuring.
  let abort: AbortController | undefined;
  const r = await runScenario({
    onStart: (ctrl) => { abort = ctrl; },
    engineBehavior: async (_signal, extras) => {
      await extras?.onCheckpoint?.({
        messages: [], turns_completed: 4, text_parts: [],
        usage: { input_tokens: 1, output_tokens: 2, cache_read: 0, cache_create: 0 },
        error_count: 2, tool_calls_by_name: { bash: 7 }, total_tool_calls: 9,
        elapsed_ms_before: 1, setup_commands: [],
      } as CheckpointState);
      await new Promise((done) => setTimeout(done, 80));
      abort?.abort();
      return result({ turns: 4 });
    },
  });

  assert.equal(r.completion?.interrupted, true, "this must be the interrupt path");
  assert.equal(r.completion?.turns, 4, "and a checkpoint must be in play");
  assert.ok((r.completion?.elapsed_ms as number) >= 60,
    "the 80ms the interrupted turn ran, not the 1ms the last checkpoint recorded "
    + `(got ${r.completion?.elapsed_ms})`);
});

test("an interrupt reports what the run had been doing", async () => {
  const r = await interruptedAfterCheckpoint();

  assert.deepEqual(r.completion?.tool_stats,
    { total_calls: 9, error_calls: 2, by_tool: { bash: 7 } },
    "same shape as the completion path, so the two can be counted together");
});

test("an interrupt before the first checkpoint reports no tool counts rather than zeroes", async () => {
  // How long and what it was doing are not knowable on the same terms. The
  // clock always is -- the run has been going since the runner was built. The
  // tool counts are not: with no checkpoint anywhere nothing counted them, and
  // zeroes would be indistinguishable from a run that really made no calls.
  // A zero meaning "unknown" survives into percentiles without ever looking
  // wrong, which is the failure that made a wall-clock proxy for this read 0
  // across hundreds of sessions.
  let abort: AbortController | undefined;
  const r = await runScenario({
    onStart: (ctrl) => { abort = ctrl; },
    engineBehavior: async () => { abort?.abort(); return result({ turns: 0 }); },
  });

  assert.equal(r.completion?.interrupted, true);
  assert.equal(r.completion?.tool_stats, undefined,
    "absent, not zeroes: nothing counted them, and 0 would be a count");
  assert.equal(typeof r.completion?.elapsed_ms, "number",
    "the clock, though, was never unknown");
});

// ── which checkpoint a terminal path reads ───────────────────────────────
//
// `latestCheckpointState` is written only by this attempt's own onCheckpoint,
// so on a resumed run it stays null until the first new turn finishes -- and a
// run gets resumed precisely because it has hours behind it. Every terminal
// path that reports progress therefore has to fall back to the checkpoint the
// run resumed from, or it reports the longest runs on the fleet as the
// shortest ones. The fallback is `pendingResumeCkpt`, read before any
// provisioning, and not `resumeCheckpoint`, which is assigned only at the end
// of a successful attach and so is still unset for the resumed run that dies
// while its sandbox is coming back up.

test("an interrupt before this attempt's first turn still reports the work it resumed with", async () => {
  let abort: AbortController | undefined;
  const r = await runScenario({
    deliveryCount: 2,
    seedCheckpoint: {},
    onStart: (ctrl) => { abort = ctrl; },
    engineBehavior: async () => { abort?.abort(); return result({ turns: 0 }); },
  });

  assert.equal(r.completion?.interrupted, true, "this must be the interrupt path");
  const elapsed = r.completion?.elapsed_ms as number;
  assert.ok(elapsed >= 3_600_000 && elapsed < 3_660_000,
    "the hour already worked, plus this attempt's own milliseconds. Starting "
    + `over at zero would throw away an hour that was measured (got ${elapsed})`);
  assert.deepEqual(r.completion?.tool_stats,
    { total_calls: 9, error_calls: 2, by_tool: { bash: 7 } });
  assert.equal(r.completion?.turns, 4,
    "from the same snapshot, so the event cannot claim an hour and zero turns");
  assert.match(String(r.completion?.final_text), /after 4 turns/,
    "and the placeholder turn the API persists says so too, rather than "
    + "telling the LLM its own last hour never happened");

  // The S3 transcript is the third sink for this ending and the one an
  // after-the-fact analysis reads. The completion and failure paths write all
  // four figures into it; an interrupt that writes none is invisible to
  // exactly the question this change exists to answer.
  const flushed = r.transcripts.at(-1);
  assert.equal(flushed?.interrupted, true, "this must be the interrupt's transcript");
  assert.equal(flushed?.turns, 4);
  assert.ok((flushed?.elapsedMs as number) >= 3_600_000,
    `the run's clock, not an empty header (got ${flushed?.elapsedMs})`);
  assert.deepEqual(flushed?.toolStats,
    { total_calls: 9, error_calls: 2, by_tool: { bash: 7 } });
  assert.equal((flushed?.tokenUsage as Record<string, number>)?.input_tokens, 10);
});

test("a resumed run that has checkpointed again reports the newer figures", async () => {
  // The one combination the rest of these miss: both checkpoints present. It
  // pins the direction of the fallback -- this attempt's own state wins, and
  // reversing it would report the run as further behind than it is -- and that
  // the elapsed figure adds this attempt's wall clock to the resumed base
  // exactly once, rather than to the newer checkpoint's clock, which already
  // contains that base.
  let abort: AbortController | undefined;
  const r = await runScenario({
    deliveryCount: 2,
    seedCheckpoint: {},
    onStart: (ctrl) => { abort = ctrl; },
    engineBehavior: async (_signal, extras) => {
      await extras?.onCheckpoint?.({
        messages: [], turns_completed: 6, text_parts: [],
        usage: { input_tokens: 30, output_tokens: 40, cache_read: 0, cache_create: 0 },
        error_count: 3, tool_calls_by_name: { grep: 2 }, total_tool_calls: 11,
        elapsed_ms_before: 3_700_000, setup_commands: [],
      } as CheckpointState);
      abort?.abort();
      return result({ turns: 6 });
    },
  });

  assert.equal(r.completion?.turns, 6, "this attempt's checkpoint, not the one it resumed from");
  assert.deepEqual(r.completion?.tool_stats,
    { total_calls: 11, error_calls: 3, by_tool: { grep: 2 } });
  const elapsed = r.completion?.elapsed_ms as number;
  assert.ok(elapsed >= 3_600_000 && elapsed < 3_660_000,
    "the resumed hour plus this attempt's milliseconds. 3_700_000 would mean the "
    + `newer checkpoint's clock replaced it; ~7_300_000 would mean both were added (got ${elapsed})`);
});

test("an interrupt keeps the output the run had already produced", async () => {
  // `text_parts` now come from the resumed checkpoint too, so a run stopped
  // before its first new turn reports what it had already said instead of an
  // empty placeholder. It is this run's own output -- the checkpoint is keyed
  // by message id -- and the attempt that produced it ended in a nak with no
  // `exec_complete`, so nothing has persisted it yet and this does not double
  // it up. It is the one user-visible change in what an interrupt writes.
  let abort: AbortController | undefined;
  const r = await runScenario({
    deliveryCount: 2,
    seedCheckpoint: { text_parts: ["I have read the config and found three problems."] },
    onStart: (ctrl) => { abort = ctrl; },
    engineBehavior: async () => { abort?.abort(); return result({ turns: 0 }); },
  });

  const text = String(r.completion?.final_text);
  assert.match(text, /three problems/,
    "an hour of work must not be replaced by a bare interrupt marker");
  assert.match(text, /Interrupted by user after 4 turns/);
});

test("an interrupt while a resumed sandbox comes back reports the work it resumed with", async () => {
  // The interrupt-path twin of the attach-time failure below, and the reason
  // this path reads `pendingResumeCkpt` too: a run stopped before its sandbox
  // is back has no `resumeCheckpoint` yet either.
  let abort: AbortController | undefined;
  const r = await runScenario({
    deliveryCount: 2,
    seedCheckpoint: {},
    onStart: (ctrl) => { abort = ctrl; },
    sideEffects: {
      ensureHands: (async () => {
        abort?.abort();
        throw new Error("attach abandoned");
      }) as never,
    },
    engineBehavior: async () => result(),
  });

  assert.equal(r.completion?.interrupted, true, "this must be the interrupt path");
  const elapsed = r.completion?.elapsed_ms as number;
  assert.ok(elapsed >= 3_600_000 && elapsed < 3_660_000, `got ${elapsed}`);
  assert.deepEqual(r.completion?.tool_stats,
    { total_calls: 9, error_calls: 2, by_tool: { bash: 7 } });
});

test("the interrupt callback carries the progress the interrupt reports", async () => {
  // The task DAG reads its turn and tool counts from here, through
  // applyAgentDone into `claw_tasks`. On a resumed run these came from
  // `latestCheckpointState` and were therefore zero.
  const done = captureAgentDone();
  let abort: AbortController | undefined;
  await runScenario({
    deliveryCount: 2,
    taskId: "task-interrupt-progress",
    // `usage.turns` lagging the real count is not hypothetical: agent-loop
    // keeps `turnsExecuted` separately because a gateway that omits `usage`
    // leaves this at zero. Seeded behind so the reported figure has to come
    // from `turns_completed`.
    seedCheckpoint: { usage: { input_tokens: 10, output_tokens: 20, cache_read: 0, cache_create: 0, turns: 1 } },
    sideEffects: done.sideEffects,
    onStart: (ctrl) => { abort = ctrl; },
    engineBehavior: async () => { abort?.abort(); return result({ turns: 0 }); },
  });

  assert.equal(done.seen.length, 1, "the DAG must be told the run ended");
  assert.equal(done.seen[0]?.turns, 4);
  assert.deepEqual(done.seen[0]?.toolStats,
    { total_calls: 9, error_calls: 2, by_tool: { bash: 7 } });
  assert.equal(done.seen[0]?.tokenUsage?.input_tokens, 10);
  assert.equal(done.seen[0]?.tokenUsage?.turns, 4,
    "the checkpoint's turn count, not `usage.turns`, which a gateway can leave behind");
});

test("an interrupt with nothing counted sends no counts, rather than zeroes", async () => {
  // The event's `tool_stats: undefined` and the callback's `{0, 0, {}}` were
  // one claim made two ways, and the callback's way is the one applyAgentDone
  // writes to `claw_tasks` -- a stored row asserting the run made no tool calls
  // and spent no tokens, which is not what was known about it.
  const done = captureAgentDone();
  let abort: AbortController | undefined;
  const r = await runScenario({
    taskId: "task-interrupt-unknown",
    sideEffects: done.sideEffects,
    onStart: (ctrl) => { abort = ctrl; },
    engineBehavior: async () => { abort?.abort(); return result({ turns: 0 }); },
  });

  assert.equal(r.completion?.tool_stats, undefined, "this must be the nothing-counted case");
  assert.equal(done.seen[0]?.toolStats, undefined,
    "absent, not zeroes: applyAgentDone stores a zero as a fact about the run");
  assert.equal(done.seen[0]?.tokenUsage, undefined);
});

test("the failure callback carries the progress the failure reports", async () => {
  // These were hard-coded zeroes ten lines under an `exec_complete` reporting
  // the real figures, so every failed task in the DAG recorded itself in
  // `claw_tasks` as having done nothing -- a resumed one included.
  const done = captureAgentDone();
  const r = await runScenario({
    deliveryCount: 2,
    taskId: "task-failure-progress",
    seedCheckpoint: {},
    sideEffects: done.sideEffects,
    engineBehavior: async () => { throw new Error("boom"); },
  });

  assert.equal(r.completion?.failed, true, "this must be the failure path");
  assert.equal(done.seen[0]?.turns, 4, "not 0, which is what the hard-coded zero said");
  assert.deepEqual(done.seen[0]?.toolStats,
    { by_tool: { bash: 7 }, total_calls: 9, error_calls: 2 });
  assert.equal(done.seen[0]?.tokenUsage?.input_tokens, 10);
});

test("a failure reports how long the turn that threw had been running", async () => {
  // A checkpoint is written at a turn boundary and a failure is by definition
  // inside the turn after one, so the checkpoint's own clock stops short by
  // exactly the turn that died -- which on a long run is most of the number.
  // The wall clock this path has always used does see it.
  const r = await runScenario({
    engineBehavior: async (_signal, extras) => {
      await extras?.onCheckpoint?.({
        messages: [], turns_completed: 3, text_parts: [],
        usage: { input_tokens: 1, output_tokens: 2, cache_read: 0, cache_create: 0 },
        error_count: 0, tool_calls_by_name: {}, total_tool_calls: 0,
        elapsed_ms_before: 1, setup_commands: [],
      } as CheckpointState);
      await new Promise((done) => setTimeout(done, 80));
      throw new Error("boom");
    },
  });

  assert.equal(r.completion?.failed, true, "this must be the failure path");
  assert.equal(r.completion?.turns, 3, "and a checkpoint must be in play");
  assert.ok((r.completion?.elapsed_ms as number) >= 60,
    "the 80ms the failing turn ran, not the 1ms the last checkpoint recorded "
    + `(got ${r.completion?.elapsed_ms})`);
});

test("a run that outlives its budget says how many turns it really took", async () => {
  // The deadline is the run's, spent across resumes, and the sentence the
  // budget path writes is recorded beside the `turns` field the same failure
  // reports. Counting only this attempt puts two numbers for one thing in one
  // transcript entry.
  const r = await runScenario({
    deliveryCount: 2,
    seedCheckpoint: {},
    request: { deadline_at: new Date(Date.now() - 1_000).toISOString() },
    engineBehavior: async (signal) => {
      await new Promise<void>((settle) => {
        if (signal?.aborted) { settle(); return; }
        signal?.addEventListener("abort", () => settle());
      });
      return result();
    },
  });

  assert.equal(r.completion?.failure_reason, "run_budget_exhausted",
    "the budget path, not the generic interrupt one");
  assert.equal(r.completion?.turns, 4);
  assert.match(String(r.transcripts.at(-1)?.error), /after 4 turns/,
    "the stated reason and the turn count beside it must not contradict each other");
});

test("a failure while a resumed sandbox comes back reports the work it resumed with", async () => {
  // Where a resumed run actually dies: the attach, not a turn. That is also the
  // only moment `resumeCheckpoint` and `pendingResumeCkpt` differ -- the former
  // is assigned by the last line of a successful attach, so reading it here
  // finds nothing and reports an hour of work as no work at all.
  const r = await runScenario({
    deliveryCount: 2,
    seedCheckpoint: {},
    sideEffects: {
      ensureHands: (async () => {
        throw new SandboxProvisionTerminalError("sandbox_gone", "workload gone");
      }) as never,
    },
    engineBehavior: async () => result(),
  });

  assert.equal(r.completion?.failed, true, "this must be the failure path");
  assert.equal(r.completion?.failure_reason, "sandbox_gone",
    "and the attach must be what failed, by the reason it failed with");
  const elapsed = r.completion?.elapsed_ms as number;
  assert.ok(elapsed >= 3_600_000 && elapsed < 3_660_000,
    `the resumed hour plus this attempt's own milliseconds, got ${elapsed}`);
  assert.deepEqual(r.completion?.tool_stats,
    { total_calls: 9, error_calls: 2, by_tool: { bash: 7 } },
    "zeroes here would say the run had done nothing before it died");
  assert.equal(r.completion?.turns, 4);
});
