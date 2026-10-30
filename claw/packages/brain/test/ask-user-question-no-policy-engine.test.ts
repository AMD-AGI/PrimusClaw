// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `ask_user_question` in a deployment that turned questions on and has no
 * approval policy at all. The decision channel is what a question waits on, so
 * it is built for the question alone; before, only an approval policy built it
 * and the tool answered "not available" however it was configured.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.ASK_USER_QUESTION_ENABLED = "true";
process.env.ASK_USER_QUESTION_TIMEOUT_MS = "2000";
delete process.env.BASH_APPROVAL_RULES;

import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); });

test("the question is asked and answered with no approval policy in force", async () => {
  const queue: Array<{ data: Uint8Array } | null> = [];
  let wake: (() => void) | null = null;
  const subjects: string[] = [];
  const nats = {
    subscribe(subject: string) {
      subjects.push(subject);
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
  };
  world.script([
    { tool: "ask_user_question", input: { questions: [{ id: "q1", question: "Which?", options: [{ id: "a", label: "A" }] }] } },
    { text: "done" },
  ]);
  world.llmBodies.length = 0;
  const events: Array<Record<string, unknown>> = [];
  const sink = async (e: unknown) => {
    const event = e as Record<string, unknown>;
    events.push(event);
    if (event.type === "userQuestion") {
      queue.push({ data: new TextEncoder().encode(JSON.stringify({ type: "answer", session_id: "s", action_id: event.actionId, answers: { q1: ["a"] } })) });
      wake?.();
    }
  };
  await new AgentEngine().execute(
    baseRequest({ session_id: "no-policy-1" }), sink as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never, natsConnection: nats } as never,
  );
  assert.ok(events.some((e) => e.type === "userQuestion"), "a question was asked");
  assert.equal(events.some((e) => e.type === "permissionRequest"), false, "and no approval was involved");
  assert.ok(subjects.some((s) => s.startsWith("decision.")));
  assert.match(world.llmBodies[1] ?? "", /\{\\"q1\\":\[\\"a\\"\]\}/);
});
