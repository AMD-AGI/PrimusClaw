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
// An approval policy is what builds the decision channel; a harmless bash rule is enough.
process.env.BASH_APPROVAL_RULES = JSON.stringify([{ label: "held", program: "curl" }]);

import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); });

/** The subject a dispatcher subscribes to, fed by hand. */
function fakeNats() {
  const queue: Array<{ data: Uint8Array } | null> = [];
  let wake: (() => void) | null = null;
  const sc = new TextEncoder();
  const nc = {
    subscribe(subject: string) {
      nc.subjects.push(subject);
      return {
        async drain() { queue.push(null); wake?.(); },
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (!queue.length) await new Promise<void>((r) => { wake = r; });
            const next = queue.shift();
            if (next === null) return;
            yield next as { data: Uint8Array };
          }
        },
      };
    },
    subjects: [] as string[],
    answer(msg: Record<string, unknown>) { queue.push({ data: sc.encode(JSON.stringify(msg)) }); wake?.(); },
  };
  return nc;
}

const QUESTION = { questions: [{ id: "q1", question: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] };

async function run(extra: Record<string, unknown>, onEvent: (e: Record<string, unknown>) => void = () => {}) {
  world.script([{ tool: "ask_user_question", input: QUESTION }, { text: "done" }]);
  world.llmBodies.length = 0;
  const events: Array<Record<string, unknown>> = [];
  const sink = async (e: unknown) => { events.push(e as Record<string, unknown>); onEvent(e as Record<string, unknown>); };
  await new AgentEngine().execute(
    baseRequest({ session_id: `q-${Math.random().toString(36).slice(2)}` }),
    sink as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never, ...extra } as never,
  );
  return { events, modelSaw: world.llmBodies[1] ?? "" };
}

test("a question is asked on the decision channel and the answer is what the model is told", async () => {
  const nats = fakeNats();
  const { events, modelSaw } = await run({ natsConnection: nats }, (e) => {
    if (e.type === "userQuestion") {
      nats.answer({ type: "answer", session_id: "s", action_id: e.actionId, answers: { q1: ["b"] }, skipped: [] });
    }
  });
  const asked = events.find((e) => e.type === "userQuestion");
  assert.ok(asked, "the question is announced");
  assert.deepEqual(asked.questions, QUESTION.questions);
  assert.ok(nats.subjects.some((s) => s.startsWith("decision.")), "on the channel decisions use");
  assert.match(modelSaw, /\{\\"q1\\":\[\\"b\\"\]\}/, "the answer reaches the model as the tool result");
  assert.equal(modelSaw.includes("not available"), false);
});

test("with no channel the tool says so at once, as before", async () => {
  const { events, modelSaw } = await run({});
  assert.equal(events.some((e) => e.type === "userQuestion"), false, "nothing is asked of anyone");
  assert.match(modelSaw, /dispatcher not configured/);
});
