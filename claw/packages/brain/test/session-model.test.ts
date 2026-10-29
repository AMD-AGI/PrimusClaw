// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model a session chose is the model every LLM call of its turn is made on.
 *
 * The API puts the session's choice on the execute request as `model`; Brain must
 * carry it into the request body it sends the gateway, for the main loop and for
 * the sub-agents the loop launches, and must fall back on DEFAULT_MODEL when the
 * request names none. The body is read off a fake gateway the real engine talks
 * to, not off an engine variable: what matters is the name on the wire.
 *
 *   S1 the main loop's request carries the request's model (table-driven, with the
 *      "no model" spellings falling back on DEFAULT_MODEL)
 *   S2 a sub-agent launched by the turn is called on the same model
 *   S3 the model of one turn does not leak into the next turn's request
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";

const DEFAULT = "platform-default-model";
// config.ts reads the environment once, at import.
process.env.DEFAULT_MODEL = DEFAULT;
process.env.WEB_FETCH_ENABLED = "false";
const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");

test.after(() => world.close());

/** Run one turn and return the `model` of every request the gateway received. */
async function modelsOnTheWire(
  request: Record<string, unknown>,
  turns: Parameters<typeof world.script>[0],
): Promise<string[]> {
  world.llmBodies.length = 0;
  world.script(turns);
  await new AgentEngine().execute(
    baseRequest(request), (async () => {}) as never, undefined, fakeHands() as never,
  );
  return world.llmBodies.map((body) => (JSON.parse(body) as { model: string }).model);
}

const CASES: Array<{ name: string; request: Record<string, unknown>; expected: string }> = [
  { name: "a chosen model", request: { model: "claude-sonnet-5.5" }, expected: "claude-sonnet-5.5" },
  { name: "a fallback alias", request: { model: "glm-5-3-with-fallback" }, expected: "glm-5-3-with-fallback" },
  { name: "no model on the request", request: { model: undefined }, expected: DEFAULT },
  { name: "an empty model", request: { model: "" }, expected: DEFAULT },
];

for (const c of CASES) {
  test(`S1 the main loop is called on ${c.name}`, async () => {
    const models = await modelsOnTheWire(c.request, [{ text: "done" }]);
    assert.deepEqual(models, [c.expected]);
  });
}

test("S2 a sub-agent launched by the turn is called on the session's model", async () => {
  const models = await modelsOnTheWire({ model: "claude-sonnet-5.5" }, [
    { tool: "task", input: { description: "look", prompt: "look around", subagent_type: "explore" } },
    { text: "sub-agent done" },
    { text: "done" },
  ]);
  // The parent asks, the sub-agent answers on its own window, the parent finishes.
  assert.equal(models.length, 3, `expected three gateway calls, saw ${JSON.stringify(models)}`);
  assert.deepEqual(models, ["claude-sonnet-5.5", "claude-sonnet-5.5", "claude-sonnet-5.5"]);
});

test("S3 one turn's model does not leak into the next turn's request", async () => {
  const first = await modelsOnTheWire({ model: "claude-sonnet-5.5" }, [{ text: "done" }]);
  const second = await modelsOnTheWire({ model: undefined }, [{ text: "done" }]);
  assert.deepEqual(first, ["claude-sonnet-5.5"]);
  assert.deepEqual(second, [DEFAULT]);
});
