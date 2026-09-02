// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Repeating a script step until the work it is watching finishes.
 *
 * `wait` blocks on a background shell for up to WAIT_MAX_SEC and then reports the
 * shell is still running, expecting to be called again -- an agent loops, a script
 * could not. A long training run lasts hours to days, and the per-call ceiling
 * is there to stop a half-dead sandbox holding a run open, not to bound the work.
 *
 * `repeat` is a modifier on an ordinary step rather than a step kind wrapping a
 * body, and that is a security property as much as a simplicity one: DAG
 * admission resolves each step's tool scope and refuses a backend-scope tool
 * without platform trust, and both checks walk the top-level array only. A nested
 * body would have gone past both.
 *
 * Coverage:
 *   G1 the condition is read off the structured result
 *   G2 an absent or unstructured result is not satisfaction
 *   G3 both bounds stop the loop, and giving up is a failure
 *   G4 an error ends the repetition rather than being retried through
 */
import test from "node:test";
import assert from "node:assert/strict";

import { repeatSatisfied } from "../src/tasks/script-runner.js";

const UNTIL_FINISHED = { until: { path: "finished", equals: true } };

test("G1 the condition holds when the named field matches", () => {
  assert.equal(repeatSatisfied(UNTIL_FINISHED, { finished: true, exit_code: 0 }), true);
  assert.equal(repeatSatisfied(UNTIL_FINISHED, { finished: false }), false);
});

test("G1b a nested path is read", () => {
  const cond = { until: { path: "result.state", equals: "done" } };
  assert.equal(repeatSatisfied(cond, { result: { state: "done" } }), true);
  assert.equal(repeatSatisfied(cond, { result: { state: "running" } }), false);
});

test("G1c the comparison is exact, not truthy", () => {
  // "true" from a tool that stringifies its output is not `true`, and treating it
  // as such is how a loop stops on the wrong answer.
  assert.equal(repeatSatisfied(UNTIL_FINISHED, { finished: "true" }), false);
  assert.equal(repeatSatisfied({ until: { path: "code", equals: 0 } }, { code: 0 }), true);
  assert.equal(repeatSatisfied({ until: { path: "code", equals: 0 } }, { code: "0" }), false);
});

test("G2 a result with no structure is not satisfaction", () => {
  // REGRESSION GUARD.
  //
  // The other reading -- absent means done -- turns a tool that stopped answering
  // into a job the graph believes finished, and the graph then moves on from work
  // that is still running.
  assert.equal(repeatSatisfied(UNTIL_FINISHED, undefined), false);
  assert.equal(repeatSatisfied(UNTIL_FINISHED, null), false);
  assert.equal(repeatSatisfied(UNTIL_FINISHED, "finished"), false);
  assert.equal(repeatSatisfied(UNTIL_FINISHED, {}), false, "a missing field is not a match");
});

test("G2b a field that is present and undefined is not a match either", () => {
  assert.equal(repeatSatisfied(UNTIL_FINISHED, { finished: undefined }), false);
});

// ---------------------------------------------------------------------------
// The loop itself, driven through runScript against a scripted Hands client.
// ---------------------------------------------------------------------------

import { runScript } from "../src/tasks/script-runner.js";
import type { ExecuteRequest, ScriptStep } from "@claw/protocol";

/** A Hands client that answers a queued sequence, then repeats the last answer. */
function scriptedHands(answers: Array<{ text?: string; structured?: unknown; isError?: boolean }>) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    client: {
      callToolFull: async (_name: string, args: Record<string, unknown>) => {
        calls.push(args);
        const a = answers[Math.min(calls.length - 1, answers.length - 1)];
        return { text: a.text ?? "", structured: a.structured, isError: !!a.isError };
      },
    } as never,
  };
}

function request(step: ScriptStep): ExecuteRequest {
  return {
    session_id: "s-1",
    task_id: "t-1",
    message_id: "m-1",
    user_id: "u-1",
    mode: "script",
    script: [step],
  } as unknown as ExecuteRequest;
}

const WAIT_STEP: ScriptStep = {
  name: "wait",
  arguments: { shell_id: "sh-1" },
  repeat: { until: { path: "finished", equals: true }, max_attempts: 5, max_seconds: 60 },
};

test("G3a the loop stops the moment the condition holds", async () => {
  const hands = scriptedHands([
    { structured: { finished: false } },
    { structured: { finished: false } },
    { structured: { finished: true, exit_code: 0 } },
    { structured: { finished: true } },
  ]);
  const result = await runScript(request(WAIT_STEP), { hands: hands.client }, async () => {});
  assert.equal(hands.calls.length, 3, "it kept going after the work finished");
  assert.equal(result.failureReason, undefined);
});

test("G3b running out of attempts is a failure, not a quiet success", async () => {
  // REGRESSION GUARD. The work it was waiting for is still going; reporting
  // completion would have the graph move on from a job that is still running.
  const hands = scriptedHands([{ structured: { finished: false } }]);
  const result = await runScript(request(WAIT_STEP), { hands: hands.client }, async () => {});
  assert.equal(hands.calls.length, 5, "the attempt bound was not honoured");
  assert.equal(result.abortReason, "script_step_failed");
  assert.match(result.failureReason ?? "", /max_attempts/);
});

test("G3c the wall-clock bound stops a loop whose attempts would not", async () => {
  const step: ScriptStep = {
    ...WAIT_STEP,
    repeat: { until: { path: "finished", equals: true }, max_attempts: 10_000, max_seconds: 1 },
  };
  const hands = scriptedHands([{ structured: { finished: false } }]);
  const started = Date.now();
  const result = await runScript(request(step), { hands: hands.client }, async () => {});
  assert.ok(Date.now() - started < 30_000, "the seconds bound did not stop it");
  assert.match(result.failureReason ?? "", /max_seconds|max_attempts/);
});

test("G4 an error ends the repetition rather than being retried through", async () => {
  // Retrying through a failure is a different feature and an easier one to get
  // wrong: a step that fails identically every time would otherwise spend its
  // whole bound discovering that.
  const hands = scriptedHands([{ isError: true, text: "shell not found" }]);
  const result = await runScript(request(WAIT_STEP), { hands: hands.client }, async () => {});
  assert.equal(hands.calls.length, 1, "it retried through an error");
  assert.match(result.failureReason ?? "", /shell not found/);
});

test("G5 a step with no repeat still runs exactly once", async () => {
  const hands = scriptedHands([{ structured: { finished: false } }]);
  const plain: ScriptStep = { name: "wait", arguments: { shell_id: "sh-1" } };
  await runScript(request(plain), { hands: hands.client }, async () => {});
  assert.equal(hands.calls.length, 1);
});

test("G6 an aborted run stops repeating", async () => {
  const controller = new AbortController();
  let seen = 0;
  const client = {
    callToolFull: async () => {
      if (++seen === 2) controller.abort();
      return { text: "", structured: { finished: false }, isError: false };
    },
  } as never;
  const result = await runScript(
    request(WAIT_STEP),
    { hands: client, signal: controller.signal },
    async () => {},
  );
  assert.ok(seen <= 3, `kept calling after abort: ${seen}`);
  assert.ok(result.failureReason || result.abortReason, "an aborted run reported nothing");
});
