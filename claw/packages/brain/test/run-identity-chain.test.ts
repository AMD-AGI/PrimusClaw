// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Drives one identity through TaskRunner, AgentEngine, and the agent loop. */
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
const { pickLockKey, pickRunScope } = await import("../src/tasks/lock.js");
const { phaseOf, setParkHooks } = await import("../src/tasks/run-phase.js");
const { resolveRunIdentity } = await import("../src/tasks/run-identity.js");
const { ExecutionGate } = await import("../src/tasks/execution-gate.js");
const { runSubagent } = await import("../src/agent/sub-agent.js");
type LlmSession = import("../src/llm/provider.js").LlmSession;
type LlmTurnResult = import("../src/llm/provider.js").LlmTurnResult;
type HandsClient = import("../src/clients/hands.js").HandsClient;
type RunPhaseReport = import("../src/tasks/run-phase.js").RunPhaseReport;
type RunIdentity = import("../src/tasks/run-identity.js").RunIdentity;
type ExecuteExtras = import("../src/agent/index.js").ExecuteExtras;

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

const ONE_WAIT: Turn[] = [
  {
    content: [{ type: "tool_use", id: "t1", name: "wait", input: { shell_id: "bg-1" } }],
    stopReason: "tool_use",
  },
  { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
];

/** An LLM that replays `turns` and reports which one it is on. */
function scriptedSession(turns: Turn[], onTurn?: (index: number) => void): LlmSession {
  let index = 0;
  return {
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
}

/**
 * One provider stub for the whole file, dispatching by session.
 *
 * The deployment-wide style is read at import time and the loop asks the
 * singleton for a session, so a per-run stub would be overwritten by whichever
 * concurrent run installed one last.
 */
function installProviderStub(): void {
  const create = (opts: { sessionId?: string }) =>
    chains.get(opts.sessionId ?? "")?.session ?? scriptedSession(ONE_WAIT);
  AnthropicProvider.prototype.createSession = create as never;
  OpenAiProvider.prototype.createSession = create as never;
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

interface Renewal {
  phase: string; waitReason?: string; waitedMs: number; waits: number;
  runTime?: { cumulativeStateMs?: Record<string, number> };
}

interface Scenario {
  /** How long the `wait` tool blocks for. */
  waitMs?: number;
  /** Runs while the wait is in flight, given the run's own ledger key. */
  duringWait?: (key: string) => void | Promise<void>;
  /** The wait rejects instead of returning, which is the error path. */
  waitThrows?: boolean;
  request?: Partial<ExecuteRequest>;
  lease?: boolean;
  /** Distinct per concurrent run, so the shared dispatcher can tell them apart. */
  sessionId?: string;
  /** What the dispatcher computed; defaults to the fixture's message id. */
  messageId?: string;
}

/** How many chains are inside `driveChain` right now, so a test can prove overlap. */
let chainsInFlight = 0;

/**
 * Per-run handlers, keyed by session.
 *
 * `bindTaskRunnerDeps` is process-global, so two chains in flight together
 * would otherwise each overwrite the other's engine and hands. Binding one
 * dispatcher that looks the run up is what makes a concurrent test possible.
 */
const chains = new Map<string, {
  onExecute: (extras: ExecuteExtras | undefined) => void;
  callTool: (name: string) => Promise<string>;
  onRenewal: (renewal: Renewal) => void;
  session: LlmSession;
}>();

interface ChainRun {
  /** Whether another chain was in flight while this one waited. */
  overlapped: boolean;
  renewals: Renewal[];
  /** Taken on the turn after the wait, before the runner's own cleanup. */
  afterWait: RunPhaseReport | null;
  identityKey: string;
  lockKey: string;
}

/**
 * Everything that leaves the process, routed back to the chain that owns it.
 *
 * Keyed by the owner scope rather than shared, because two chains in flight
 * together must not share one hands client: the second one's wait would be the
 * only one anything recorded.
 */
function chainSideEffects(): TaskRunnerSideEffects {
  const noop = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;
  return {
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
    postRunLease: ((req: { session_id: string }, renewal: Renewal) => {
      chains.get(req.session_id)?.onRenewal(renewal);
      return Promise.resolve("running");
    }) as never,
    runScript: noop(undefined),
    refreshTaskLock: noop(undefined),
    releaseTaskLock: noop(undefined),
    flushTranscript: (() => Promise.resolve()) as never,
    // Keyed by the owner scope, which is this run's session: two chains in
    // flight together must not share one client, or the second one's wait is
    // the only one anything records.
    makeHandsClient: ((_url: string, _token: string, owner: string) => ({
      callTool: (name: string) => chains.get(owner)!.callTool(name),
      close: async () => {},
    })) as never,
  } as unknown as TaskRunnerSideEffects;

}

async function driveChain(scenario: Scenario = {}): Promise<ChainRun> {
  const renewals: Renewal[] = [];
  let afterWait: RunPhaseReport | null = null;
  const sessionId = scenario.sessionId ?? SESSION;
  const request = {
    session_id: sessionId,
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
  let overlapped = false;
  chainsInFlight++;
  // Read off the boundary rather than re-resolved: an identity-less run mints a
  // fresh key per resolution, so asking the resolver again would name a
  // different run. This also pins that the runner set the field at all.
  let threaded: RunIdentity | undefined;

  const callTool = async (name: string) => {
    if (name !== "wait") return "ok";
    overlapped ||= chainsInFlight > 1;
    await scenario.duringWait?.(threaded!.key);
    await new Promise((r) => setTimeout(r, scenario.waitMs ?? 40));
    if (scenario.waitThrows) throw new Error("the background command died");
    return "shell finished";
  };
  const chain = {
    onExecute: (extras) => { threaded = extras?.runIdentity; },
    callTool,
    onRenewal: (renewal) => { renewals.push({ ...renewal }); },
    // The turn after the tool result: the wait has closed and the runner has
    // not reached its cleanup, which is the only vantage point from which a
    // completed wait's totals are still readable.
    session: scriptedSession(ONE_WAIT, (index) => {
      if (index === 1) afterWait = phaseOf(threaded!.key);
    }),
  };
  // Under both names it is reached by: the engine and the LLM stub see the
  // session, the hands client sees the scope its shells are filed under.
  chains.set(sessionId, chain);
  chains.set(pickRunScope(request), chain);


  const sideEffects = chainSideEffects();

  const engine = new AgentEngine();
  bindTaskRunnerDeps({
    kv: fakeKv(),
    kvCkpt: fakeKv(),
    emitter: { async emit() {} } as never,
    engine: {
      execute(req, onEvent, signal, handsClient, extras) {
        chains.get(req.session_id)?.onExecute(extras);
        return engine.execute(req, onEvent, signal, handsClient, extras);
      },
    },
    sideEffects,
  });

  const abortCtrl = new AbortController();
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(fakeMsg(), request, sessionId, lockKey, messageId, "u1", abortCtrl);
  activeAbort.delete(lockKey);
  chainsInFlight--;
  chains.delete(sessionId);
  chains.delete(pickRunScope(request));
  assert.ok(threaded, "TaskRunner is the sole producer: the extras must carry an identity");
  return { renewals, afterWait, identityKey: threaded!.key, lockKey, overlapped };
}

before(() => { installProviderStub(); });
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

test("AC3 the opening renewal carries no coverage, whatever the clock did", async () => {
  // `beginRun` and the first tick are separate statements. Here the clock jumps
  // between them, so the ledger genuinely holds elapsed `executing` time by the
  // time the opening tick reads it -- which is the case a producer that decides
  // from the totals gets wrong, and the one that decides structurally does not.
  // A clock that advances on every read, so whatever pair of reads `beginRun`
  // and the opening tick happen to make, some time has passed between them.
  const realNow = Date.now;
  let reads = 0;
  Date.now = () => realNow.call(Date) + (reads++ * 2);
  let run: ChainRun;
  try {
    run = await driveChain({ waitMs: 2_400 });
  } finally {
    Date.now = realNow;
  }

  assert.ok(run.renewals.length >= 2, `expected more than the opening tick: ${run.renewals.length}`);
  assert.equal(run.renewals[0].runTime, undefined,
    "the opening tick is identity-only: no covering field at all");
  assert.ok(run.renewals.slice(1).some((r) => r.runTime?.cumulativeStateMs),
    "and every later tick does carry the coverage it has measured");
});

test("T4.1 a chat turn with only a message id is counted end to end", async () => {
  // The production fat-chat shape carries a lease; this is the one below it,
  // and the point is that a run with no task row is still tracked -- resolution
  // alone proves nothing about whether its waits reach an entry.
  const events: string[] = [];
  setParkHooks({
    park: () => { events.push("park"); return true; },
    unpark: async () => { events.push("unpark"); },
  });
  let during: RunPhaseReport | null = null;
  const run = await driveChain({
    waitMs: 40,
    request: { task_id: undefined, run_lease: undefined },
    messageId: "m-chat-only",
    lease: false,
    duringWait: (key) => { during = phaseOf(key as never); },
  });

  assert.equal(run.identityKey, "msg.m-chat-only", "the message tier, and no proxy");
  assert.ok(during, "the entry exists while the wait is in flight");
  assert.equal(during!.phase, "waiting");
  assert.equal(run.afterWait!.waits, 1);
  assert.ok(run.afterWait!.waitedMs > 0, "and the wait is counted, not merely resolvable");
  assert.deepEqual(events, ["park", "unpark"], "a top-level run still lends its slot out");
});

test("T4.5 two same-millisecond fat-chat turns are timed and parked independently", async () => {
  // Under the old message-id-only scheme both turns collapse onto one entry.
  // Driven through the real chain, at depth 0, so the parking each one does is
  // the top-level behaviour rather than the sub-agent's timing-only path.
  const shared = "1730000000042";
  const events: string[] = [];
  setParkHooks({
    park: () => { events.push("park"); return true; },
    unpark: async () => { events.push("unpark"); },
  });

  // Started together and awaited together: run sequentially, a leak between
  // the two entries has already been cleaned up by the first run's `endRun`
  // before the second one begins, so the test could not see it.
  const [first, second] = await Promise.all([
    driveChain({
      waitMs: 120, sessionId: "sess-concurrent-a",
      request: {
        task_id: undefined, dag_root_task_id: undefined, files_workspace_id: "ws-a",
        run_lease: { url: "http://api.test/v1/internal/tasks/ktsk_p/lease", token: "t" },
      },
      messageId: shared,
    }),
    driveChain({
      waitMs: 120, sessionId: "sess-concurrent-b",
      request: {
        task_id: undefined, dag_root_task_id: undefined, files_workspace_id: "ws-b",
        run_lease: { url: "http://api.test/v1/internal/tasks/ktsk_q/lease", token: "t" },
      },
      messageId: shared,
    }),
  ]);

  assert.equal(first.identityKey, "ktsk_p");
  assert.equal(second.identityKey, "ktsk_q");
  assert.notEqual(first.identityKey, second.identityKey);
  assert.notEqual(first.identityKey, shared);
  assert.equal(first.afterWait!.waits, 1, "each run's wait lands on its own entry");
  assert.equal(second.afterWait!.waits, 1);
  assert.ok(first.afterWait!.waitedMs > 0 && second.afterWait!.waitedMs > 0);
  assert.equal(events.filter((e) => e === "park").length, 2,
    "both are top-level runs, so both hand their slot back for the wait");
  assert.equal(events.filter((e) => e === "unpark").length, 2);
  assert.equal(first.overlapped, true, "the two runs really were in flight together");
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
  const subSession = scriptedSession(ONE_WAIT);
  chains.set("sub-agent", {
    onExecute: () => {}, callTool: async () => "ok", onRenewal: () => {}, session: subSession,
  });
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
      maxTurns: 4, sessionId: "sub-agent", depth: 1,
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
