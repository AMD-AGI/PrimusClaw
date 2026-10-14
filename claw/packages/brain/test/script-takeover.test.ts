// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A script run taken over part-way, by the real runner over the real script
 * executor.
 *
 * A DAG script step can run for a day. The pod running it is replaced on every
 * brain rollout, and the run's queue message has usually aged out of the task
 * stream by then, so there is nothing for a nak to redeliver. What has to hold:
 *
 *   T1 a draining pod hands the run over: lease released, the same request
 *      published again, the old delivery acked -- not left to a nak
 *   T2 the worker taking it over continues from the step it was on, in the same
 *      sandbox, with the earlier steps' captures; no finished step runs again
 *   T3 a takeover that finds the sandbox gone fails the run, saying so, and
 *      issues no tool call into the new sandbox
 *   T4 a drain lets a single-call step finish and records it, so the successor
 *      does not run it a second time
 *   T5 a drain that lands in the last step reports the run's own outcome rather
 *      than handing a finished run over
 *   T6 a resumed repeating step keeps the bounds it began with, and a drain
 *      waits for a single call only so long
 *
 * Run with sealed (v4) checkpoints, the only format progress is written to.
 */
import { randomBytes } from "node:crypto";

// Progress is kept only in a sealed checkpoint; see script-takeover-v3 for the
// plaintext format. Read once at module scope, so set before anything loads.
process.env.CHECKPOINT_WRITE_VERSION = "4";
process.env.BRAIN_CHECKPOINT_KEY = randomBytes(32).toString("base64");

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest, ScriptStep } from "@claw/protocol";

const {
  runWorker, sharedKv, untilAborted, SIGTERM_ABORT_REASON, START_THEN_WAIT, SUBJECT, PAYLOAD, TASK,
} = await import("./fixtures/script-worker.js");
const { runScript } = await import("../src/tasks/script-runner.js");

test("T1/T2 a drained run is handed over and continues where it was, in the same sandbox", async () => {
  const { kv } = sharedKv();

  // The first worker starts the job and is drained while it waits on it.
  let waits = 0;
  const first = await runWorker({
    kvCkpt: kv, script: START_THEN_WAIT, sandboxCreated: true, seq: 10,
    answer: async (name, _args, w, signal) => {
      if (name === "bash") return { text: "started sh-live", structured: { shell_id: "sh-live" } };
      waits += 1;
      if (waits < 3) return { structured: { finished: false } };
      w.abort.abort(SIGTERM_ABORT_REASON);
      return untilAborted(signal);
    },
  });
  assert.deepEqual(first.done, [], "a drained run must not report an outcome");
  assert.deepEqual(first.released, [{ taskId: TASK, releaseLease: true }],
    "the lease has to be given back so the next worker's first renewal is not refused");
  assert.equal(first.republished.length, 1, "the run was not handed over: nothing will pick it up");
  assert.equal(first.republished[0].subject, SUBJECT);
  assert.deepEqual(first.republished[0].data, PAYLOAD, "the hand-over must carry the same request");
  assert.deepEqual(first.delivery.settled, ["ack"],
    "the old delivery is acked once a copy is out; a nak alone reaches nothing after the stream's max_age");

  // The second worker takes the new message and finds the same sandbox alive.
  const second = await runWorker({
    kvCkpt: kv, script: START_THEN_WAIT, sandboxCreated: false, seq: 11,
    answer: async (name) => {
      if (name === "bash") return { text: "started sh-NEW", structured: { shell_id: "sh-NEW" } };
      return { text: "exit 0", structured: { finished: true, exit_code: 0 } };
    },
  });
  assert.deepEqual(second.calls.map((c) => c.name), ["wait"],
    "the takeover ran a step that had already finished -- the background job would be started twice");
  assert.equal(second.calls[0].args.shell_id, "sh-live",
    "the takeover must re-attach to the shell the first worker started, from its capture");
  assert.equal(second.done.length, 1, "the resumed run never reported");
  assert.equal(second.done[0].abortReason, "completed");
  assert.equal(second.done[0].failureReason, undefined);
  assert.match(second.done[0].captures?.job ?? "", /sh-live/, "the earlier step's capture was lost");
  assert.deepEqual(second.republished, []);
});

test("T3 a takeover that finds its sandbox gone fails the run and says why", async () => {
  const { kv } = sharedKv();
  await runWorker({
    kvCkpt: kv, script: START_THEN_WAIT, sandboxCreated: true, seq: 20,
    answer: async (name, _args, w, signal) => {
      if (name === "bash") return { text: "started", structured: { shell_id: "sh-live" } };
      w.abort.abort(SIGTERM_ABORT_REASON);
      return untilAborted(signal);
    },
  });

  // The sandbox died meanwhile: attaching to the session provisioned a new one.
  const second = await runWorker({
    kvCkpt: kv, script: START_THEN_WAIT, sandboxCreated: true, seq: 21,
    answer: async () => ({ structured: { finished: true } }),
  });
  assert.deepEqual(second.calls, [],
    "nothing may run in a new sandbox: the job the later steps wait on is not there");
  assert.equal(second.done.length, 1, "a lost run must still report, or the DAG waits on it");
  assert.match(second.done[0].failureReason ?? second.done[0].finalText ?? "", /script_sandbox_lost/);
  assert.deepEqual(second.republished, []);
});

test("T4 a drain lets a single-call step finish, and the successor does not run it again", async () => {
  const { kv } = sharedKv();
  const script: ScriptStep[] = [
    { name: "bash", arguments: { command: "./migrate.sh" }, captures: "migrated" } as ScriptStep,
    { name: "bash", arguments: { command: "./report.sh" } } as ScriptStep,
  ];
  let callSawAbort = false;
  const first = await runWorker({
    kvCkpt: kv, script, sandboxCreated: true, seq: 30,
    answer: async (_name, args, w, signal) => {
      // The rollout arrives while the first, non-repeatable step is running.
      w.abort.abort(SIGTERM_ABORT_REASON);
      await new Promise((r) => setTimeout(r, 20));
      callSawAbort = signal?.aborted === true;
      return { text: `ran ${String(args.command)}` };
    },
  });
  assert.equal(callSawAbort, false, "the drain cut off a call that may already have done its work");
  assert.deepEqual(first.calls.map((c) => c.args.command), ["./migrate.sh"],
    "a draining worker must not start the next step");
  assert.equal(first.republished.length, 1);

  const second = await runWorker({
    kvCkpt: kv, script, sandboxCreated: false, seq: 31,
    answer: async (_name, args) => ({ text: `ran ${String(args.command)}` }),
  });
  assert.deepEqual(second.calls.map((c) => c.args.command), ["./report.sh"],
    "the finished step ran twice");
  assert.equal(second.done[0].abortReason, "completed");
  assert.match(second.done[0].captures?.migrated ?? "", /ran \.\/migrate\.sh/);
});

test("T4b a user's Stop still cuts a single-call step off at once", async () => {
  const { kv } = sharedKv();
  let sawAbort = false;
  const w = await runWorker({
    kvCkpt: kv,
    script: [{ name: "bash", arguments: { command: "sleep 600" } } as ScriptStep],
    sandboxCreated: true, seq: 35,
    answer: async (_name, _args, worker, signal) => {
      worker.abort.abort();
      sawAbort = signal?.aborted === true;
      return untilAborted(signal);
    },
  });
  assert.equal(sawAbort, true, "only a drain is let finish; a Stop is not");
  assert.deepEqual(w.republished, []);
});

test("T5 a drain in the last step reports the run's own outcome instead of handing it over", async () => {
  const { kv } = sharedKv();
  const w = await runWorker({
    kvCkpt: kv,
    script: [{ name: "bash", arguments: { command: "./last.sh" } } as ScriptStep],
    sandboxCreated: true, seq: 40,
    answer: async (_name, _args, worker) => {
      worker.abort.abort(SIGTERM_ABORT_REASON);
      return { text: "done" };
    },
  });
  assert.deepEqual(w.republished, [], "a finished run was handed over, so its last step would run again");
  assert.equal(w.done.length, 1);
  assert.equal(w.done[0].abortReason, "completed");
});

// ---------------------------------------------------------------------------
// The executor alone: a resumed repeating step keeps the bounds it began with.
// ---------------------------------------------------------------------------


function waitOnly(max: { attempts: number; seconds: number }): ExecuteRequest {
  return {
    session_id: "s", task_id: "t", message_id: "m", user_id: "u", mode: "script",
    script: [{
      name: "wait", arguments: { shell_id: "sh" },
      repeat: { until: { path: "finished", equals: true }, max_attempts: max.attempts, max_seconds: max.seconds },
    }],
  } as unknown as ExecuteRequest;
}

const neverDone = {
  calls: 0,
  async callToolFull() { this.calls += 1; return { text: "", structured: { finished: false }, isError: false }; },
};

test("T6 a resumed repeat counts the time it already ran against max_seconds", async () => {
  const hands = { ...neverDone, calls: 0 };
  const result = await runScript(waitOnly({ attempts: 1000, seconds: 60 }), {
    hands: hands as never,
    resume: { step: 0, captures: {}, last_text: "", repeat_started_at: Date.now() - 61_000, repeat_attempts: 3 },
  }, async () => {});
  assert.equal(hands.calls, 0, "the step's 60s were already spent; a takeover must not grant it another 60");
  assert.match(result.failureReason ?? "", /max_seconds/);
});

test("T6b a resumed repeat counts the calls it already made against max_attempts", async () => {
  const hands = { ...neverDone, calls: 0 };
  const result = await runScript(waitOnly({ attempts: 5, seconds: 3600 }), {
    hands: hands as never,
    resume: { step: 0, captures: {}, last_text: "", repeat_started_at: Date.now(), repeat_attempts: 4 },
  }, async () => {});
  assert.equal(hands.calls, 1, "four of five calls were made before the takeover");
  assert.match(result.failureReason ?? "", /max_attempts/);
});

test("T6c progress is reported after every finished step", async () => {
  const seen: number[] = [];
  const req = {
    session_id: "s", task_id: "t", message_id: "m", user_id: "u", mode: "script",
    script: [
      { name: "bash", arguments: { command: "a" }, captures: "a" },
      { name: "bash", arguments: { command: "b" } },
    ],
  } as unknown as ExecuteRequest;
  const hands = { async callToolFull() { return { text: "ok", structured: undefined, isError: false }; } };
  await runScript(req, { hands: hands as never, onProgress: async (p) => { seen.push(p.step); } }, async () => {});
  assert.deepEqual(seen, [1, 2]);
});

test("T6d a drain gives up on a single call that will not come back in time", async () => {
  const ctl = new AbortController();
  const req = {
    session_id: "s", task_id: "t", message_id: "m", user_id: "u", mode: "script",
    script: [
      { name: "bash", arguments: { command: "./hangs.sh" } },
      { name: "bash", arguments: { command: "./next.sh" } },
    ],
  } as unknown as ExecuteRequest;
  const seen: number[] = [];
  let cutOff = false;
  const hands = {
    async callToolFull(_n: string, _a: unknown, signal?: AbortSignal) {
      ctl.abort(SIGTERM_ABORT_REASON);
      // Bounded, so a drain that never cuts the call off fails here rather than hanging.
      await Promise.race([
        untilAborted(signal).catch(() => { cutOff = true; }),
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
      throw new Error("This operation was aborted");
    },
  };
  const result = await runScript(req, {
    hands: hands as never, signal: ctl.signal, drainStepWaitMs: 20,
    onProgress: async (p) => { seen.push(p.step); },
  }, async () => {});
  assert.equal(cutOff, true, "an unbounded wait outlives the pod's grace and nothing is handed over");
  assert.equal(result.abortReason, "cancelled",
    "a call cut off by the drain is not the step's answer: the run must stop, to be handed over");
  assert.deepEqual(seen, [], "a step that was cut off must not be recorded as finished");
});
