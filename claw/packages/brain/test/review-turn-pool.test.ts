// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A requested review's turn budget covers its sub-agents (`agent-loop.ts` `TurnPool`), through the real engine. The review's `max_turns` is
 * what the reviewer's budget has left, and the API charges the review with the turns the run reports. A sub-agent ran under its own cap
 * (`sub_agent_max_turns`) beside the run's, and the run reported its own loop's turns only, so the review's `task` tool could take model
 * turns on the reviewer's quota that were neither within the budget nor charged. Under the profile every turn of the run and of its
 * sub-agents is taken from one pool of `max_turns`, and the run reports the pool's count. An ordinary run is as it was. Only the network
 * edges are fake.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";
import { uniqueSession } from "./support/plugin-world.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
const { takePooledTurn } = await import("../src/agent/agent-loop.js");
test.after(() => world.close());

/** The parent starts a sub-agent that calls bash on every turn it is given, then the parent ends. */
function script(): Turn[] {
  return [
    { tool: "task", input: { description: "d", prompt: "p" } },
    ...Array.from({ length: 12 }, () => ({ tool: "bash", input: { command: "true" } }) as Turn),
    { text: "sub done" },
    { text: "parent done" },
  ];
}

async function run(over: Record<string, unknown>): Promise<{ requests: number; turns: number }> {
  world.script(script());
  world.llmBodies.length = 0;
  const out = await new AgentEngine().execute(
    baseRequest({ session_id: uniqueSession(), sub_agent_max_turns: 20, ...over }),
    (async () => {}) as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never } as never,
  ) as { turns: number };
  return { requests: world.llmBodies.length, turns: out.turns };
}

test("a requested review's sub-agent takes its turns from the review's budget, and the run reports them: no more model turns than max_turns", async () => {
  for (const maxTurns of [1, 2, 4, 7]) {
    const r = await run({ sandbox_profile: "review", max_turns: maxTurns });
    assert.ok(r.requests <= maxTurns, `max_turns ${maxTurns}: ${r.requests} model requests`);
    assert.equal(r.turns, r.requests, `max_turns ${maxTurns}: every model request is a reported turn`);
  }
  // With room to finish: the parent's two turns and the sub-agent's 13 are all reported.
  const roomy = await run({ sandbox_profile: "review", max_turns: 50 });
  assert.deepEqual(roomy, { requests: 15, turns: 15 });
});

test("an ordinary run is as before: its sub-agent runs under its own cap and the run reports its own turns", async () => {
  // max_turns 4: the sub-agent's cap is min(20, 4), it is asked once more at its cap (5 requests), and the parent takes its own 4.
  const r = await run({ max_turns: 4 });
  assert.deepEqual(r, { requests: 9, turns: 4 });
});

test("the pool hands out exactly what it holds", () => {
  const pool = { left: 2, used: 0 };
  assert.deepEqual([takePooledTurn(pool), takePooledTurn(pool), takePooledTurn(pool)], [true, true, false]);
  assert.deepEqual(pool, { left: 0, used: 2 });
});
