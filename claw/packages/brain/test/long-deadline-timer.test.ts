// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run's deadline weeks away is waited for, not fired at once.
 *
 * The task runner stops a run at its `deadline_at` with a timer (`armDeadline`).
 * An app run's deadline is its own time limit, up to `APP_MAX_RUNTIME_SEC` (about
 * 24.8 days) from its creation, and Node fires a `setTimeout` longer than
 * 2^31 - 1 ms after 1 ms: the run was stopped as `deadline` as soon as it started.
 * The fake timers clamp the same way (`utils/test/long-timeout.test.ts` shows it),
 * so these runs are what a real process would do.
 *
 *   D1 a deadline 30 days out: the run is not stopped a millisecond early, and is
 *      stopped, as `deadline`, when it comes
 *   D2 a deadline at the longest limit admission takes, and one just past the
 *      timer's limit: the same
 *   D3 a run that ends first leaves no timer behind to stop anything
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import { APP_MAX_RUNTIME_SEC } from "@claw/protocol";
import { MAX_TIMER_DELAY_MS } from "@claw/utils";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { TaskRunnerSideEffects } from "../src/tasks/runner.js";
import type { AppRunner, AppRunResult, AppRunOutcome } from "../src/apps/app-runner.js";

const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { activeAbort, DEADLINE_EXCEEDED_ABORT_REASON } = await import("../src/tasks/abort-registry.js");

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 21, 0, 0, 0);
const LOCK = "lock.s-long";

/** An app run that runs until its signal fires, and says why it stopped. */
function harness() {
  const done: ExecuteResult[] = [];
  const finishes: string[] = [];
  let signal: AbortSignal | undefined;
  let started = false;
  const kv = { async get() { return null; }, async put() { return 1; }, async delete() {} } as unknown as KV;
  const engine: Engine = { async execute(): Promise<ExecuteResult> { throw new Error("engine must not run"); } };
  const sideEffects = {
    postAgentDone: (async (_r: unknown, result: ExecuteResult) => { done.push(result); }) as never,
    postTaskRunning: (async () => {}) as never,
    postAppFinishDone: (async () => true) as never,
    postAppFinishHandOver: (async () => true) as never,
    settleRunAttempt: (async () => {}) as never,
    ensureHands: (async () => { throw new Error("no Hands for an app run"); }) as never,
    reapPendingHands: (async () => {}) as never,
    releaseTaskLock: (async () => {}) as never,
    flushTranscript: (async () => undefined) as never,
    runScript: (async () => { throw new Error("script must not run"); }) as never,
    createAppRunner: (() => ({
      markEnded: async () => true,
      run: (s: AbortSignal): Promise<AppRunResult> => {
        signal = s;
        started = true;
        return new Promise((resolve) => {
          if (s.aborted) return resolve({ kind: "aborted" });
          s.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
        });
      },
      finishNow: async (cause: string): Promise<AppRunOutcome> => { finishes.push(cause); return { success: false, reason: `app run ended: ${cause}` }; },
    }) as unknown as AppRunner) as never,
  } as unknown as Partial<TaskRunnerSideEffects>;
  bindTaskRunnerDeps({ kv, kvCkpt: kv, emitter: { async emit() {} } as unknown as NatsEmitter, engine, sideEffects });
  const msg = { info: { deliveryCount: 1 }, ack() {}, nak() {}, working() {}, term() {} } as unknown as JsMsg;
  return { msg, done, finishes, signal: () => signal, started: () => started };
}

/** Let the run's awaits settle; the fake clock does not move. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Move the fake clock `ms` on. The fake clock runs every timer a tick passes at the
 * tick's end, and a timer armed there counts from that end; a real one counts from
 * when its callback ran. So the clock stops at the end of every timer chunk the
 * deadline is armed in (armed at T0, every {@link MAX_TIMER_DELAY_MS}), as a process
 * that is never late would.
 */
async function advance(t: TestContext, ms: number): Promise<void> {
  const target = Date.now() + ms;
  while (Date.now() < target) {
    const nextChunkEnd = T0 + (Math.floor((Date.now() - T0) / MAX_TIMER_DELAY_MS) + 1) * MAX_TIMER_DELAY_MS;
    t.mock.timers.tick(Math.min(target, nextChunkEnd) - Date.now());
    await settle();
  }
}

/** Start an app run whose deadline is `deadlineMs` after now, and wait until its runner is running. */
async function start(t: TestContext, deadlineMs: number) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const h = harness();
  const abortCtrl = new AbortController();
  activeAbort.set(LOCK, abortCtrl);
  const request = {
    session_id: "s-long", task_id: "t-long", prompt: "x", user_id: "u1", platform_key: "pk", mode: "app",
    deadline_at: new Date(T0 + deadlineMs).toISOString(),
  } as ExecuteRequest;
  const run = runHandleTask(h.msg, request, "s-long", LOCK, "m1", "u1", abortCtrl);
  await settle();
  assert.equal(h.started(), true, "the app runner is running");
  return { h, run, abortCtrl };
}

async function stopsAt(t: TestContext, deadlineMs: number): Promise<void> {
  const { h, run, abortCtrl } = await start(t, deadlineMs);
  try {
    await advance(t, 1);
    assert.equal(h.signal()!.aborted, false, "not stopped 1 ms in");
    await advance(t, deadlineMs - 2);
    assert.equal(h.signal()!.aborted, false, "not stopped 1 ms before its deadline");
    assert.deepEqual(h.finishes, []);
    await advance(t, 1);
    assert.equal(h.signal()!.aborted, true, "stopped at its deadline");
    assert.equal(abortCtrl.signal.reason, DEADLINE_EXCEEDED_ABORT_REASON);
    await run;
    assert.deepEqual(h.finishes, ["deadline"], "and finished as a deadline");
    assert.equal(h.done.length, 1);
  } finally {
    abortCtrl.abort();
    await run.catch(() => undefined);
    activeAbort.delete(LOCK);
  }
}

test("D1 a deadline 30 days out: not stopped a millisecond early, and stopped as deadline when it comes", async (t) => {
  await stopsAt(t, 30 * DAY);
});

test("D2 the longest limit admission takes, and just past one timer: the same", async (t) => {
  await stopsAt(t, APP_MAX_RUNTIME_SEC * 1000);
  t.mock.timers.reset();
  await stopsAt(t, MAX_TIMER_DELAY_MS + 1);
});

test("D3 a run that ends first leaves nothing armed: its deadline passing later stops nothing", async (t) => {
  const { h, run, abortCtrl } = await start(t, 30 * DAY);
  try {
    await advance(t, 10 * DAY);
    abortCtrl.abort();
    await run;
    assert.deepEqual(h.finishes, ["cancelled"], "a cancel, not the deadline");
    const reason = abortCtrl.signal.reason;
    await advance(t, 40 * DAY);
    assert.equal(abortCtrl.signal.reason, reason, "the deadline did not fire afterwards");
    assert.deepEqual(h.finishes, ["cancelled"]);
  } finally {
    activeAbort.delete(LOCK);
  }
});
