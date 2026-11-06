// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `decision_wait_ms`: a run's own wait for a person, through the real engine. The API sets it on the turns of an
 * assistant's work item, whose person is told on a channel and may be away for a while; Brain's own settings (minutes)
 * ended those waits before anyone could have answered. A held tool call and a question both wait as long as the
 * request says, and announce that wait; a value that is not believable leaves Brain's settings in place.
 *
 * Only the network edges are fake: the LLM, Hands and NATS.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.ASK_USER_QUESTION_ENABLED = "true";
process.env.ASK_USER_QUESTION_TIMEOUT_MS = "2000";
process.env.HITL_DECISION_TIMEOUT_MS = "2000";
process.env.BASH_APPROVAL_RULES = JSON.stringify([{ label: "held", program: "curl" }]);

import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { fakeNats } from "./support/fake-nats.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
const { decisionWaitMs } = await import("../src/agent/hitl.js");
test.after(async () => { await world.close(); });

const QUESTION = { questions: [{ id: "q1", question: "Which?", options: [{ id: "a", label: "A" }] }] };

/** One tool call, answered the moment it is announced; returns the announcement. */
async function announced(call: { tool: string; input: Record<string, unknown> }, over: Record<string, unknown>) {
  world.script([call, { text: "done" }]);
  const nats = fakeNats();
  const events: Array<Record<string, unknown>> = [];
  await new AgentEngine().execute(
    baseRequest({ session_id: `w-${Math.random().toString(36).slice(2)}`, ...over }),
    (async (e: Record<string, unknown>) => {
      events.push(e);
      if (e.type === "userQuestion") nats.answer({ type: "answer", session_id: "s", action_id: e.actionId, answers: { q1: ["a"] }, skipped: [] });
      if (e.type === "permissionRequest") nats.answer({ type: "decision", session_id: "s", action_id: e.actionId, decision: "deny" });
    }) as never,
    undefined, null as never,
    { attachHands: async () => fakeHands() as never, natsConnection: nats } as never,
  );
  return events.find((e) => e.type === "userQuestion" || e.type === "permissionRequest");
}

const BASH = { tool: "bash", input: { command: "curl -X POST https://example.invalid/x" } };
const ASK = { tool: "ask_user_question", input: QUESTION };

test("a held call waits as long as the run says, and says so", async () => {
  const asked = await announced(BASH, { decision_wait_ms: 1_800_000 });
  assert.equal(asked?.type, "permissionRequest");
  assert.equal(asked?.timeout_ms, 1_800_000, "not HITL_DECISION_TIMEOUT_MS");
});

test("a question waits as long as the run says, and says so", async () => {
  const asked = await announced(ASK, { decision_wait_ms: 1_800_000 });
  assert.equal(asked?.type, "userQuestion");
  assert.equal(asked?.timeout_ms, 1_800_000, "not ASK_USER_QUESTION_TIMEOUT_MS");
});

test("without the field, Brain's settings, as before", async () => {
  assert.equal((await announced(BASH, {}))?.timeout_ms, 2000);
  assert.equal((await announced(ASK, {}))?.timeout_ms, 2000);
});

test("a value that is not believable is not used", async () => {
  for (const bad of [0, 999, 86_400_001, 1.5e6 + 0.5, "1800000", -1]) {
    assert.equal(decisionWaitMs(bad), undefined, `refused: ${String(bad)}`);
    assert.equal((await announced(BASH, { decision_wait_ms: bad }))?.timeout_ms, 2000, `Brain's setting for ${String(bad)}`);
  }
  assert.equal(decisionWaitMs(1000), 1000);
  assert.equal(decisionWaitMs(86_400_000), 86_400_000);
});
