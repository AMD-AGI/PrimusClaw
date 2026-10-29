// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the task runner does with each `mode`.
 *
 * An `app` task goes to the AppRunner and never to the LLM engine, which is
 * what the `else` after the `script` branch would do with it: the app's input
 * would be answered as a prompt and the run would report success. A mode this
 * Brain has never heard of is still refused outright.
 *
 *   A1 an app task is handed to the AppRunner: the engine, Hands and the
 *      script runner are never touched, and a finished run is reported once
 *   A1b a failed app run is reported as a failure with the runner's reason
 *   A1c a cancel finishes the run; a drain or a lost lease leaves it to its
 *       successor
 *   A2 llm, script, app and an omitted mode are not refused
 *   A3 a mode this Brain has never heard of is refused, the engine untouched
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { TaskRunnerSideEffects } from "../src/tasks/runner.js";
import type { AppRunner, AppRunResult, AppRunOutcome } from "../src/apps/app-runner.js";

const { bindTaskRunnerDeps, runHandleTask, refuseUnsupportedMode } = await import("../src/tasks/runner.js");
const { activeAbort, SIGTERM_ABORT_REASON, LEASE_LOST_ABORT_REASON, DEADLINE_EXCEEDED_ABORT_REASON } =
  await import("../src/tasks/abort-registry.js");

interface FakeRunner {
  runs: number;
  finishes: string[];
  /** What finishNow answers; default: a failure carrying the cause. */
  finishOutcome?: AppRunOutcome;
  /** finishNow fails (the runner gave up after FINISH_NOW_MAX_FAILURES). */
  finishThrows?: boolean;
  /** The platform key and epoch each createAppRunner call got, and how often the row was closed without a runner. */
  made: Array<{ platformKey: string; epoch: number }>;
  closed: string[];
  /** What run() answers. It may also fire the abort first, as a real cancel would. */
  script: (signal: AbortSignal) => Promise<AppRunResult>;
}

function harness(runner?: FakeRunner) {
  const done: ExecuteResult[] = [];
  let acked = 0;
  let released = 0;
  let engineCalls = 0;
  let sandboxCalls = 0;
  let reaps = 0;
  let created = 0;
  let runningSignals = 0;
  let finishDone = 0;
  const events: Array<{ type?: string }> = [];
  const kv = { async get() { return null; }, async put() { return 1; }, async delete() {} } as unknown as KV;
  const engine: Engine = {
    async execute(): Promise<ExecuteResult> { engineCalls++; throw new Error("engine must not run"); },
  };
  const sideEffects = {
    postAgentDone: (async (_r: unknown, result: ExecuteResult) => { done.push(result); }) as never,
    postTaskRunning: (async () => { runningSignals++; }) as never,
    postAppFinishDone: (async () => { finishDone++; return true; }) as never,
    ensureHands: (async () => { sandboxCalls++; throw new Error("no Hands for an app run"); }) as never,
    reapPendingHands: (async () => { reaps++; }) as never,
    releaseTaskLock: (async () => { released++; }) as never,
    flushTranscript: (async () => undefined) as never,
    runScript: (async () => { engineCalls++; throw new Error("script must not run"); }) as never,
    createAppRunner: ((runId: string, platformKey: string, epoch: number) => {
      created++;
      assert.equal(runId, "t-app");
      runner?.made.push({ platformKey, epoch });
      return {
        markEnded: async (why: string) => { runner?.closed.push(why); return true; },
        run: async (signal: AbortSignal) => { runner!.runs++; return runner!.script(signal); },
        finishNow: async (cause: string): Promise<AppRunOutcome> => { runner!.finishes.push(cause); if (runner!.finishThrows) throw new Error("finish kept failing"); return runner!.finishOutcome ?? { success: false, reason: cause }; },
      } as unknown as AppRunner;
    }) as never,
  } as unknown as Partial<TaskRunnerSideEffects>;
  bindTaskRunnerDeps({ kv, kvCkpt: kv, emitter: { async emit(e: { type?: string }) { events.push(e); } } as unknown as NatsEmitter, engine, sideEffects });
  const msg = { info: { deliveryCount: 1 }, ack() { acked++; }, nak() {}, working() {}, term() {} } as unknown as JsMsg;
  return {
    msg, done, acked: () => acked, released: () => released, engineCalls: () => engineCalls,
    sandboxCalls: () => sandboxCalls, reaps: () => reaps, created: () => created,
    runningSignals: () => runningSignals, finishDone: () => finishDone, events,
  };
}

const request = (mode: unknown): ExecuteRequest =>
  ({ session_id: "s-app", task_id: "t-app", prompt: "hi", user_id: "u1", platform_key: "pk", mode }) as ExecuteRequest;

const fakeRunner = (script: FakeRunner["script"]): FakeRunner => ({ runs: 0, finishes: [], made: [], closed: [], script });

async function runApp(h: ReturnType<typeof harness>) {
  const abortCtrl = new AbortController();
  activeAbort.set("lock.s-app", abortCtrl);
  await runHandleTask(h.msg, request("app"), "s-app", "lock.s-app", "m1", "u1", abortCtrl);
  return abortCtrl;
}

test("A1 an app task goes to the AppRunner; a finished run is reported once, with no engine, Hands or script", async () => {
  const runner = fakeRunner(async () => ({ kind: "ended", outcome: { success: true, reason: "app finished" } }));
  const h = harness(runner);
  await runApp(h);
  assert.equal(runner.runs, 1);
  assert.equal(h.created(), 1);
  assert.equal(h.engineCalls(), 0);
  assert.equal(h.sandboxCalls(), 0, "the app sandbox is the AppRunner's; Hands is never asked for");
  assert.equal(h.done.length, 1);
  assert.equal(h.done[0]!.abortReason, undefined, "a success carries no abort reason");
  assert.equal(h.done[0]!.finalText, "app finished");
  assert.equal(h.acked(), 1);
  assert.equal(h.released(), 1);
  assert.equal(activeAbort.has("lock.s-app"), false);
});

test("A1a the runner is made with the epoch this attempt holds the run at", async () => {
  const runner = fakeRunner(async () => ({ kind: "ended", outcome: { success: true, reason: "app finished" } }));
  const h = harness(runner);
  await runApp(h);
  assert.equal(runner.made.length, 1);
  assert.equal(runner.made[0]!.platformKey, "pk");
  assert.equal(typeof runner.made[0]!.epoch, "number");
});

test("A1f no platform key: the row is closed and the task fails", async () => {
  const runner = fakeRunner(async () => { throw new Error("must not run"); });
  const h = harness(runner);
  const abortCtrl = new AbortController();
  activeAbort.set("lock.s-app", abortCtrl);
  await runHandleTask(h.msg, { ...request("app"), platform_key: undefined } as ExecuteRequest, "s-app", "lock.s-app", "m1", "u1", abortCtrl);
  assert.equal(runner.runs, 0);
  assert.equal(runner.made[0]?.platformKey, "", "a runner is made only to close the row");
  assert.equal(runner.closed.length, 1, "the row is ended, not left running");
  assert.equal(h.done.length, 1);
  assert.equal(h.done[0]!.abortReason, "error");
});

test("A1b a failed app run is reported as a failure with the runner's reason, and not retried", async () => {
  const runner = fakeRunner(async () => ({ kind: "ended", outcome: { success: false, reason: "app exited final with return code 3 (rate limit 429)" } }));
  const h = harness(runner);
  await runApp(h);
  assert.equal(h.done.length, 1);
  assert.equal(h.done[0]!.abortReason, "error");
  assert.match(h.done[0]!.failureReason ?? h.done[0]!.finalText, /return code 3/);
  assert.equal(h.acked(), 1, "acked, not nak'ed: a '429' in the reason text must not read as a retryable error");
  assert.equal(runner.finishes.length, 0, "the runner had already wound the run up");
});

test("A1c a user cancel finishes the run; a drain or a lost lease leaves it to the Brain that takes over", async () => {
  // user cancel: abort with no reason
  const cancel = fakeRunner(async () => ({ kind: "aborted" }));
  const h1 = harness(cancel);
  const c1 = new AbortController();
  activeAbort.set("lock.s-app", c1);
  cancel.script = async () => { c1.abort(); return { kind: "aborted" }; };
  await runHandleTask(h1.msg, request("app"), "s-app", "lock.s-app", "m1", "u1", c1);
  assert.deepEqual(cancel.finishes, ["cancelled"]);

  const deadline = fakeRunner(async () => ({ kind: "aborted" }));
  const h2 = harness(deadline);
  const c2 = new AbortController();
  activeAbort.set("lock.s-app", c2);
  deadline.script = async () => { c2.abort(DEADLINE_EXCEEDED_ABORT_REASON); return { kind: "aborted" }; };
  await runHandleTask(h2.msg, request("app"), "s-app", "lock.s-app", "m1", "u1", c2);
  assert.deepEqual(deadline.finishes, ["deadline"]);

  for (const reason of [SIGTERM_ABORT_REASON, LEASE_LOST_ABORT_REASON]) {
    const left = fakeRunner(async () => ({ kind: "aborted" }));
    const h = harness(left);
    const c = new AbortController();
    activeAbort.set("lock.s-app", c);
    left.script = async () => { c.abort(reason); return { kind: "aborted" }; };
    await runHandleTask(h.msg, request("app"), "s-app", "lock.s-app", "m1", "u1", c);
    assert.deepEqual(left.finishes, [], `${String(reason)}: the successor reconciles it; nothing is stopped here`);
  }
});

test("A1c2 a cancel whose application wrote a successful final in its grace is reported as that success, with its captures", async () => {
  for (const make of [
    () => { const c = new AbortController(); return { ctrl: c, fire: () => c.abort() }; },
  ]) {
    const { ctrl, fire } = make();
    const runner = fakeRunner(async () => { fire(); return { kind: "aborted" }; });
    runner.finishOutcome = { success: true, reason: "app finished", captures: { session_dir: "/state/run-1", stop_reason: "done" } };
    const h = harness(runner);
    activeAbort.set("lock.s-app", ctrl);
    await runHandleTask(h.msg, request("app"), "s-app", "lock.s-app", "m1", "u1", ctrl);
    assert.deepEqual(runner.finishes, ["cancelled"]);
    assert.equal(h.done.length, 1);
    assert.equal(h.done[0]!.abortReason, undefined, "a success, not an interruption");
    assert.equal(h.done[0]!.finalText, "app finished");
    assert.deepEqual((h.done[0] as { captures?: unknown }).captures, { session_dir: "/state/run-1", stop_reason: "done" });
  }
});

test("A1d a run whose lease another worker took is left alone and stood down", async () => {
  const runner = fakeRunner(async () => ({ kind: "superseded" }));
  const h = harness(runner);
  await runApp(h);
  assert.deepEqual(runner.finishes, []);
  assert.equal(h.done.length, 0, "no terminal report for a run somebody else owns");
});

test("A2 llm, script, app and an omitted mode are not refused", async () => {
  const h = harness();
  for (const mode of ["llm", "script", "app", undefined]) {
    assert.equal(await refuseUnsupportedMode(h.msg, request(mode), "s-app", "lock.s-app"), false, String(mode));
  }
  assert.equal(h.done.length, 0);
  assert.equal(h.acked(), 0);
});

test("A3 an unknown mode is refused, failed with its name, and never reaches the engine or the AppRunner", async () => {
  const runner = fakeRunner(async () => { throw new Error("must not run"); });
  const h = harness(runner);
  const abortCtrl = new AbortController();
  activeAbort.set("lock.s-app", abortCtrl);
  await runHandleTask(h.msg, request("dag"), "s-app", "lock.s-app", "m1", "u1", abortCtrl);
  assert.equal(h.created(), 0);
  assert.equal(h.engineCalls(), 0);
  assert.equal(h.sandboxCalls(), 0);
  assert.equal(h.reaps(), 0, "a refused task never becomes a TaskRunner run");
  assert.equal(h.done.length, 1);
  assert.equal(h.done[0]!.abortReason, "error");
  assert.match(h.done[0]!.failureReason ?? "", /task mode "dag" is not implemented/);
  assert.equal(h.acked(), 1);
  assert.equal(h.released(), 1);
  assert.equal(activeAbort.has("lock.s-app"), false);
});

test("A1g a finish-only dispatch (the task already closed) ends the run row and reports no terminal state of its own", async () => {
  const runner = fakeRunner(async () => ({ kind: "ended", outcome: { success: false, reason: "app run ended: cancelled" } }));
  const h = harness(runner);
  const abortCtrl = new AbortController();
  activeAbort.set("lock.s-app", abortCtrl);
  await runHandleTask(h.msg, { ...request("app"), app_finish_only: true } as ExecuteRequest, "s-app", "lock.s-app", "m1", "u1", abortCtrl);
  assert.equal(runner.runs, 1);
  assert.equal(h.done.length, 0, "no agent_done: the user was told how this run ended when it ended");
  assert.equal(h.runningSignals(), 0, "nothing says the run is running again");
  assert.equal(h.events.filter((e) => e.type === "statusUpdate").length, 0);
  assert.equal(h.finishDone(), 1, "the task is handed back to its terminal state once");
  assert.equal(h.acked(), 1);
});

async function finishOnly(runner: FakeRunner, reason: unknown, req: Partial<ExecuteRequest> = {}) {
  const h = harness(runner);
  const c = new AbortController();
  activeAbort.set("lock.s-app", c);
  runner.script = async () => { if (reason === "cancel") c.abort(); else c.abort(reason as never); return { kind: "aborted" }; };
  await runHandleTask(h.msg, { ...request("app"), app_finish_only: true, ...req } as ExecuteRequest, "s-app", "lock.s-app", "m1", "u1", c);
  return h;
}

test("A1h finish-only: a finish that keeps failing, or the deadline, reports no terminal state and leaves the task to the sweeper", async () => {
  for (const reason of ["cancel", DEADLINE_EXCEEDED_ABORT_REASON]) {
    const runner = fakeRunner(async () => ({ kind: "aborted" }));
    runner.finishThrows = true;
    const h = await finishOnly(runner, reason);
    assert.equal(runner.finishes.length, 1, "the finish was attempted");
    assert.equal(h.done.length, 0, "no agent_done for a task the user already cancelled");
    assert.equal(h.events.filter((e) => e.type === "statusUpdate").length, 0, "no status update either");
    assert.equal(h.finishDone(), 0, "not reported as finished");
    assert.equal(h.acked(), 1, "the delivery is settled; the sweeper hands the finish over");
    assert.equal(h.released(), 1);
  }
});

test("A1i finish-only without a platform key: nothing is reported and the run row is not closed", async () => {
  const runner = fakeRunner(async () => { throw new Error("must not run"); });
  const h = harness(runner);
  const c = new AbortController();
  activeAbort.set("lock.s-app", c);
  await runHandleTask(h.msg, { ...request("app"), app_finish_only: true, platform_key: undefined } as ExecuteRequest, "s-app", "lock.s-app", "m1", "u1", c);
  assert.equal(runner.closed.length, 0, "the row is left for a Brain that has a key");
  assert.equal(h.done.length, 0);
  assert.equal(h.events.filter((e) => e.type === "statusUpdate").length, 0);
  assert.equal(h.acked(), 1);
});
