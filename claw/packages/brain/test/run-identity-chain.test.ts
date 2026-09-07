// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One identity, from TaskRunner through AgentEngine into the agent loop.
 *
 * Every ledger test before this one supplied the same string literal on both
 * sides, so the production mismatch -- the runner opening the entry under the
 * workspace lock key while the loop looked it up under
 * `dag_root_task_id || session_id` -- failed nothing. These drive the real
 * chain with four deliberately different values in the four fields a proxy
 * could be taken from, so any key that is not the run's own misses.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";

process.env.BG_SHELL_ENABLED = "true";
// Three renewals inside a lease is the shipped ratio; the floor on both is
// what keeps this from becoming a busy loop while making one land mid-wait.
process.env.RUN_LEASE_HEARTBEAT_MS = "1000";
process.env.RUN_LEASE_TTL_MS = "3000";
process.env.WEB_SEARCH_PROVIDER = "disabled";
process.env.WEB_FETCH_ENABLED = "false";

const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
type TaskRunnerSideEffects = import("../src/tasks/runner.js").TaskRunnerSideEffects;
const { AgentEngine } = await import("../src/agent/engine.js");
const { AnthropicProvider } = await import("../src/llm/anthropic-provider.js");
const { OpenAiProvider } = await import("../src/llm/openai-provider.js");
const { activeAbort } = await import("../src/tasks/abort-registry.js");
const { pickLockKey } = await import("../src/tasks/lock.js");
const { phaseOf, setParkHooks } = await import("../src/tasks/run-phase.js");
const { resolveRunIdentity } = await import("../src/tasks/run-identity.js");
const { ExecutionGate } = await import("../src/tasks/execution-gate.js");
const { runSubagent } = await import("../src/agent/sub-agent.js");
type LlmSession = import("../src/llm/provider.js").LlmSession;
type LlmTurnResult = import("../src/llm/provider.js").LlmTurnResult;
type HandsClient = import("../src/clients/hands.js").HandsClient;
type RunPhaseReport = import("../src/tasks/run-phase.js").RunPhaseReport;
type RunIdentity = import("../src/tasks/run-identity.js").RunIdentity;

/** The one tool the loop treats as a wait, as the parent would offer it. */
const WAIT_SCHEMA = {
  name: "wait",
  description: "Block until a background shell finishes.",
  input_schema: { type: "object", properties: { shell_id: { type: "string" } } },
} as unknown as import("@claw/protocol").ToolSchema;

/** Four values a proxy key could be taken from, none of them equal. */
const SESSION = "sess-distinct";
const TASK = "task-distinct";
const DAG_ROOT = "dag-root-distinct";
const WORKSPACE = "workspace-distinct";
const MESSAGE = "message-distinct";

const originalAnthropic = AnthropicProvider.prototype.createSession;
const originalOpenAi = OpenAiProvider.prototype.createSession;

interface Turn { content: unknown[]; stopReason: string }

/**
 * An LLM that asks for one `wait` and then stops.
 *
 * Installed on both providers' prototypes because the deployment-wide style is
 * read at import time and the loop asks the singleton for a session.
 */
function installScriptedLlm(turns: Turn[], onTurn?: (index: number) => void): void {
  let index = 0;
  const session: LlmSession = {
    async streamTurn() {
      const turn = turns[index++];
      onTurn?.(index - 1);
      if (!turn) throw new Error(`scripted session exhausted after ${index - 1} turns`);
      return {
        content: turn.content,
        stopReason: turn.stopReason,
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 },
        firstByteMs: 1,
      } as unknown as LlmTurnResult;
    },
    async complete() { return "summary"; },
  } as unknown as LlmSession;
  AnthropicProvider.prototype.createSession = () => session;
  OpenAiProvider.prototype.createSession = () => session;
}

function waitThenFinish(onTurn?: (index: number) => void): void {
  installScriptedLlm([
    {
      content: [{ type: "tool_use", id: "t1", name: "wait", input: { shell_id: "bg-1" } }],
      stopReason: "tool_use",
    },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ], onTurn);
}

function fakeMsg(): JsMsg {
  return {
    info: { deliveryCount: 1 },
    seq: 1,
    ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
}

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

interface Renewal { phase: string; waitReason?: string; waitedMs: number; waits: number }

interface Scenario {
  /** How long the `wait` tool blocks for. */
  waitMs?: number;
  /** Runs while the wait is in flight, given the run's own ledger key. */
  duringWait?: (key: string) => void | Promise<void>;
  /** The wait rejects instead of returning, which is the error path. */
  waitThrows?: boolean;
  request?: Partial<ExecuteRequest>;
  lease?: boolean;
  /** What the dispatcher computed; defaults to the fixture's message id. */
  messageId?: string;
}

interface ChainRun {
  renewals: Renewal[];
  /** Taken on the turn after the wait, before the runner's own cleanup. */
  afterWait: RunPhaseReport | null;
  identityKey: string;
  lockKey: string;
}

async function driveChain(scenario: Scenario = {}): Promise<ChainRun> {
  const renewals: Renewal[] = [];
  let afterWait: RunPhaseReport | null = null;
  const request = {
    session_id: SESSION,
    task_id: TASK,
    dag_root_task_id: DAG_ROOT,
    files_workspace_id: WORKSPACE,
    message_id: MESSAGE,
    prompt: "hi",
    user_id: "u1",
    llm_api_key: "k",
    ...(scenario.lease === false
      ? {}
      : { run_lease: { url: `http://api.test/v1/internal/tasks/${TASK}/lease`, token: "tok" } }),
    ...scenario.request,
  } as ExecuteRequest;

  const messageId = scenario.messageId ?? MESSAGE;
  const lockKey = pickLockKey(request);
  // Read off the boundary rather than re-resolved: an identity-less run mints a
  // fresh key per resolution, so asking the resolver again would name a
  // different run. This also pins that the runner set the field at all.
  let threaded: RunIdentity | undefined;

  waitThenFinish((index) => {
    // The turn after the tool result: the wait has closed and the runner has
    // not reached its cleanup, which is the only vantage point from which a
    // completed wait's totals are still readable.
    if (index === 1) afterWait = phaseOf(threaded!.key);
  });

  const hands = {
    async callTool(name: string) {
      if (name !== "wait") return "ok";
      await scenario.duringWait?.(threaded!.key);
      await new Promise((r) => setTimeout(r, scenario.waitMs ?? 40));
      if (scenario.waitThrows) throw new Error("the background command died");
      return "shell finished";
    },
    async close() {},
  } as unknown as HandsClient;

  const noop = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;
  const sideEffects = {
    ensureHands: noop({ handsUrl: "http://hands.test", created: true, token: "t" }),
    destroyHands: noop(undefined),
    reapPendingHands: noop(undefined),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => {}) as never,
    markRetryPending: noop(undefined),
    syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: noop(undefined),
    archiveRunToS3: noop(undefined),
    copyS3Prefix: noop({ copied: 0 }),
    syncWorkspace: noop({ ok: true }),
    restoreWorkspace: noop({ ok: true }),
    postAgentDone: noop(undefined),
    postTaskRunning: noop(undefined),
    postRunLease: ((_req: unknown, renewal: Renewal) => {
      renewals.push({ ...renewal });
      return Promise.resolve("running");
    }) as never,
    runScript: noop(undefined),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    makeHandsClient: (() => hands) as never,
  } as unknown as TaskRunnerSideEffects;

  const engine = new AgentEngine();
  bindTaskRunnerDeps({
    kv: fakeKv(),
    kvCkpt: fakeKv(),
    emitter: { async emit() {} } as never,
    engine: {
      execute(req, onEvent, signal, hands, extras) {
        threaded = extras?.runIdentity;
        return engine.execute(req, onEvent, signal, hands, extras);
      },
    },
    sideEffects,
  });

  const abortCtrl = new AbortController();
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(fakeMsg(), request, SESSION, lockKey, messageId, "u1", abortCtrl);
  activeAbort.delete(lockKey);
  assert.ok(threaded, "TaskRunner is the sole producer: the extras must carry an identity");
  return { renewals, afterWait, identityKey: threaded!.key, lockKey };
}

before(() => { });
beforeEach(() => { setParkHooks(null); });
after(() => {
  AnthropicProvider.prototype.createSession = originalAnthropic;
  OpenAiProvider.prototype.createSession = originalOpenAi;
  setParkHooks(null);
});

test("T1.1 the loop's wait lands in the entry the runner opened", async () => {
  // Under the default workspace gate the lock key is `ws.<workspace>` and the
  // engine's old proxy was `dag_root_task_id`, so neither addresses the run.
  let during: RunPhaseReport | null = null;
  const run = await driveChain({
    waitMs: 60,
    duringWait: (key) => { during = phaseOf(key as never); },
  });

  assert.notEqual(run.identityKey, run.lockKey, "the fixture must not let a proxy pass by accident");
  assert.equal(run.lockKey, `ws.${WORKSPACE}`);
  assert.ok(run.afterWait, "the post-wait snapshot must have been taken");
  assert.equal(run.afterWait!.phase, "executing");
  assert.equal(run.afterWait!.waits, 1);
  assert.ok(run.afterWait!.waitedMs > 0, `the wait must be timed, got ${run.afterWait!.waitedMs}ms`);
  assert.ok(during, "the in-flight snapshot must have been taken");
  assert.equal(during!.phase, "waiting");
  assert.equal(during!.waitReason, "background_command");
});

test("T2.1 the wait is timed for as long as it lasted", async () => {
  const run = await driveChain({ waitMs: 200 });
  assert.equal(run.afterWait!.waits, 1);
  assert.ok(run.afterWait!.waitedMs >= 150,
    `a 200ms wait must be covered, got ${run.afterWait!.waitedMs}ms`);
});

test("T1.2 a renewal issued during the wait reports it on the wire", async () => {
  const run = await driveChain({ waitMs: 2_400 });
  const waiting = run.renewals.filter((r) => r.phase === "waiting");
  assert.ok(waiting.length >= 1, `no renewal reported the wait: ${JSON.stringify(run.renewals)}`);
  assert.ok(waiting.some((r) => r.waitedMs > 0), "waited_ms has been silently zero on this path");
  assert.equal(waiting[0].waitReason, "background_command");
});

test("T1.3 the entry is gone once the run is over", async () => {
  const run = await driveChain({ waitMs: 20 });
  const after = phaseOf(run.identityKey as never);
  assert.deepEqual(after, { phase: "executing", waitedMs: 0, waits: 0 },
    "an untracked key reads as a run that never waited, which is what an absent entry is");
});

test("T2.2 the slot changes hands exactly once around the wait", async () => {
  const events: string[] = [];
  let unparkedWith: boolean | undefined;
  setParkHooks({
    park: () => { events.push("park"); return true; },
    unpark: async (hadSlot) => { unparkedWith = hadSlot; events.push("unpark"); },
  });
  const run = await driveChain({
    waitMs: 30,
    duringWait: () => { assert.deepEqual(events, ["park"], "parked before the wait body runs"); },
  });

  assert.deepEqual(events, ["park", "unpark"]);
  assert.equal(unparkedWith, true, "unpark is told what park managed");
  assert.equal(run.afterWait!.phase, "executing");
});

test("T2.3 a wait that fails still gives the slot back", async () => {
  const events: string[] = [];
  setParkHooks({
    park: () => { events.push("park"); return true; },
    unpark: async () => { events.push("unpark"); },
  });
  const run = await driveChain({ waitMs: 10, waitThrows: true });

  assert.deepEqual(events, ["park", "unpark"]);
  assert.equal(run.afterWait!.phase, "executing");
  assert.equal(run.afterWait!.waits, 1, "a failed wait is still a wait that happened");
});

test("T3.1 a top-level wait really does hand its slot to the gate", async () => {
  const gate = new ExecutionGate(2, 4);
  await gate.acquire();
  setParkHooks({ park: () => gate.park(), unpark: (hadSlot) => gate.unpark(hadSlot) });
  const seen: Array<{ inflight: number; parked: number }> = [];

  await driveChain({
    waitMs: 30,
    duringWait: () => { seen.push({ inflight: gate.inflight, parked: gate.parkedRuns }); },
  });

  assert.deepEqual(seen, [{ inflight: 0, parked: 1 }], "the slot is lent out for the wait");
  assert.equal(gate.inflight, 1, "and taken again afterwards");
  assert.equal(gate.parkedRuns, 0);
  gate.release();
});

test("T5.5 the runner opens the ledger under the task id, not a proxy", async () => {
  const run = await driveChain({ waitMs: 20 });
  assert.equal(run.identityKey, TASK);
  for (const proxy of [SESSION, DAG_ROOT, MESSAGE, `ws.${WORKSPACE}`]) {
    assert.notEqual(run.identityKey, proxy, `the ledger key must not be ${proxy}`);
  }
});

test("T5.6 a run with nothing to identify it still gets its own entry, never a proxy", async () => {
  const run = await driveChain({
    waitMs: 20,
    request: { task_id: undefined, message_id: undefined },
    messageId: "",
    lease: false,
  });
  assert.match(run.identityKey, /^unknown\./);
  for (const proxy of [SESSION, DAG_ROOT, `ws.${WORKSPACE}`]) {
    assert.ok(!run.identityKey.includes(proxy), `${run.identityKey} contains the proxy ${proxy}`);
  }
  assert.ok(run.afterWait, "a degraded run is still tracked");
  assert.equal(run.afterWait!.waits, 1, "and its waits are still counted");
});

test("T4.2 a degraded run reports waiting, not a run that never waited", async () => {
  // The outcome AC4 forbids is silence: an identity-less run whose waits read
  // byte-identical to a run that spent its whole life executing.
  let during: RunPhaseReport | null = null;
  const run = await driveChain({
    waitMs: 60,
    request: { task_id: undefined, message_id: undefined },
    messageId: "",
    lease: false,
    duringWait: (key) => { during = phaseOf(key as never); },
  });

  assert.match(run.identityKey, /^unknown\./);
  assert.ok(during, "the entry exists while the wait is in flight");
  assert.equal(during!.phase, "waiting");
  assert.equal(during!.waitReason, "background_command");
  assert.ok(run.afterWait!.waitedMs > 0);
});

test("T3.2 a sub-agent's wait is timed against its parent's entry and parks nothing", async () => {
  // The sub-agent runs inside the slot its parent already holds. Handing that
  // slot back would admit work the pod never intended to admit, so its waits
  // are measured and nothing else.
  const { beginRun, endRun } = await import("../src/tasks/run-phase.js");
  const gate = new ExecutionGate(2, 4);
  await gate.acquire();
  const parkEvents: string[] = [];
  setParkHooks({
    park: () => { parkEvents.push("park"); return gate.park(); },
    unpark: async (hadSlot) => { parkEvents.push("unpark"); await gate.unpark(hadSlot); },
  });

  const identity = resolveRunIdentity(
    { session_id: SESSION, task_id: "parent-run" } as ExecuteRequest, "",
  ).identity;
  waitThenFinish();
  const hands = {
    async callTool(name: string) {
      if (name !== "wait") return "ok";
      assert.equal(gate.inflight, 1, "the parent's slot stays where it was");
      assert.equal(gate.parkedRuns, 0);
      await new Promise((r) => setTimeout(r, 30));
      return "shell finished";
    },
    async close() {},
  } as unknown as HandsClient;

  beginRun(identity.key);
  try {
    await runSubagent({
      description: "sub", prompt: "go",
      parentSchemas: [WAIT_SCHEMA], hands,
      onEvent: async () => {},
      model: "m", apiUrl: "http://localhost:0", apiKey: "k",
      maxTurns: 4, sessionId: SESSION, depth: 1,
      runIdentity: identity,
    });
    const report = phaseOf(identity.key);
    assert.equal(report.waits, 1, "the lookup must hit the parent's entry");
    assert.ok(report.waitedMs > 0);
    assert.deepEqual(parkEvents, [], "a timed wait never reads the park hooks");
    assert.equal(gate.inflight, 1);
    assert.equal(gate.parkedRuns, 0);
  } finally {
    endRun(identity.key);
    gate.release();
  }
});
