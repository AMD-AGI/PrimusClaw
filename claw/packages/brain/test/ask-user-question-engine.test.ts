// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `ask_user_question`, end to end through the real engine. The tool waits for
 * its answer on the decision channel an approval uses, and the engine never
 * handed it that channel, so it answered "not available" whenever it was called
 * and nobody -- a web client or an A2A caller -- could be asked anything.
 *
 * Only the network edges are fake: the LLM, Hands and NATS (an in-memory
 * stand-in for the one subject the dispatcher listens on).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.ASK_USER_QUESTION_ENABLED = "true";
// Short, so a question whose answer is lost fails this suite in seconds rather than after the default wait.
process.env.ASK_USER_QUESTION_TIMEOUT_MS = "2000";
// An approval policy is what builds the decision channel; a harmless bash rule is enough.
process.env.BASH_APPROVAL_RULES = JSON.stringify([{ label: "held", program: "curl" }]);

import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { fakeNats } from "./support/fake-nats.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); });

const QUESTION = { questions: [{ id: "q1", question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] };

async function run(extra: Record<string, unknown>, onEvent: (e: Record<string, unknown>) => void | Promise<void> = () => {}) {
  world.script([{ tool: "ask_user_question", input: QUESTION }, { text: "done" }]);
  world.llmBodies.length = 0;
  const events: Array<Record<string, unknown>> = [];
  const sink = async (e: unknown) => { events.push(e as Record<string, unknown>); await onEvent(e as Record<string, unknown>); };
  await new AgentEngine().execute(
    baseRequest({ session_id: `q-${Math.random().toString(36).slice(2)}` }),
    sink as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never, ...extra } as never,
  );
  return { events, modelSaw: world.llmBodies[1] ?? "" };
}

test("a question is asked on the decision channel and the answer is what the model is told", async () => {
  const nats = fakeNats();
  const { events, modelSaw } = await run({ natsConnection: nats }, async (e) => {
    if (e.type === "userQuestion") {
      // The caller answers the moment it sees the question, and the answer is
      // heard before the announcement has finished: a waiter must already be there.
      nats.answer({ type: "answer", session_id: "s", action_id: e.actionId, answers: { q1: ["b"] }, skipped: [] });
      await new Promise((r) => setTimeout(r, 25));
    }
  });
  const asked = events.find((e) => e.type === "userQuestion");
  assert.ok(asked, "the question is announced");
  assert.deepEqual(asked.questions, QUESTION.questions);
  assert.equal(asked.timeout_ms, 2000, "with how long the answer is waited for, so a client can stop offering it then");
  assert.ok(nats.subjects.some((s) => s.startsWith("decision.")), "on the channel decisions use");
  assert.match(modelSaw, /\{\\"q1\\":\[\\"b\\"\]\}/, "the answer reaches the model as the tool result");
  assert.equal(modelSaw.includes("not available"), false);
  assert.equal(modelSaw.includes("timed out"), false, "the answer was not lost");
});

test("a question nobody answers times out as an error the model is told", async () => {
  const nats = fakeNats();
  const { modelSaw } = await run({ natsConnection: nats });
  assert.match(modelSaw, /question timed out/);
});

test("with no channel the tool says so at once, as before", async () => {
  const { events, modelSaw } = await run({});
  assert.equal(events.some((e) => e.type === "userQuestion"), false, "nothing is asked of anyone");
  assert.match(modelSaw, /dispatcher not configured/);
});
