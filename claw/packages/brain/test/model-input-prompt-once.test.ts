// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the model is sent for a turn, through the real engine: the request's history as given, then this turn's
 * prompt, once. The API keeps its side of this (api/test/model-input-prompt-once.test.ts): the history it hands over
 * is the stored turns and never ends with the prompt, because Brain adds the prompt itself, wrapped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, baseRequest } from "./support/platform-defaults-world.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); });

type Body = { messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> };
const textOf = (c: Body["messages"][number]["content"]) =>
  typeof c === "string" ? c : c.map((b) => (typeof b.text === "string" ? b.text : "")).join("");
const noSandbox = { attachHands: async () => { throw new Error("this turn needs no sandbox"); } };

test("the model is sent the history as given, then the prompt once", async () => {
  world.llmBodies.length = 0;
  world.script([{ text: "the nodes are fine" }]);
  const earlier = "earlier question about pods";
  const answer = "earlier answer: kubectl get pods";
  const prompt = "and what about the nodes?";
  await new AgentEngine().execute(
    baseRequest({
      prompt,
      history: [
        { role: "system", content: "## Session Summary\nnothing yet" },
        { role: "user", content: earlier },
        { role: "assistant", content: answer },
      ],
    }),
    (async () => {}) as never, undefined, null, noSandbox as never,
  );
  assert.equal(world.llmBodies.length, 1);
  const messages = (JSON.parse(world.llmBodies[0]!) as Body).messages;
  const seen = (words: string) => messages.filter((m) => textOf(m.content).includes(words)).length;
  assert.equal(seen(prompt), 1, `the prompt reaches the model once: ${JSON.stringify(messages)}`);
  assert.equal(seen(earlier), 1);
  assert.equal(seen(answer), 1);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"], "the stored turns, then this turn");
  assert.ok(textOf(messages[2]!.content).includes(prompt), "and the last message is this turn's prompt");
});
