// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A requested review's model calls stay on the reviewer's model and inside the reviewer's turn budget, beyond the parent loop's own turns.
 * A `task` call could name another offered model (SUB_AGENT_MODELS), and a reading sub-agent ran on the reading default
 * (SUB_AGENT_EXPLORE_MODEL), both on the reviewer's key; and the summary auto-compaction asks for was a model call no pool turn paid for.
 * Under the review profile a sub-agent runs on the run's model, and the summary takes a turn from the pool. An ordinary run is as it was.
 * Env is set before anything imports config.ts, which reads it once.
 */
process.env.SUB_AGENT_MODELS = "other-model";
process.env.SUB_AGENT_EXPLORE_MODEL = "explore-model";
process.env.COMPACTION_TRIGGER_INPUT_TOKENS = "1000";

import test from "node:test";
import assert from "node:assert/strict";

const { startWorld, fakeHands, baseRequest } = await import("./support/platform-defaults-world.js");
const { uniqueSession } = await import("./support/plugin-world.js");
const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
const { agentLoop } = await import("../src/agent/agent-loop.js");
test.after(() => world.close());

async function models(taskInput: Record<string, unknown>, over: Record<string, unknown>): Promise<string[]> {
  world.script([{ tool: "task", input: { description: "d", prompt: "p", ...taskInput } }, { text: "sub done" }, { text: "parent done" }]);
  world.llmBodies.length = 0;
  await new AgentEngine().execute(
    baseRequest({ session_id: uniqueSession(), model: "review-default", max_turns: 10, sub_agent_max_turns: 5, ...over }),
    (async () => {}) as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never } as never,
  );
  return world.llmBodies.map((b) => String(JSON.parse(b).model));
}

test("a requested review's sub-agent runs on the run's model, whatever the task call names or the reading default is", async () => {
  const review = { sandbox_profile: "review" };
  assert.deepEqual(await models({ model: "other-model" }, review), ["review-default", "review-default", "review-default"]);
  assert.deepEqual(await models({ subagent_type: "explore" }, review), ["review-default", "review-default", "review-default"]);
});

test("an ordinary run's sub-agent still runs on the model the task call names, and a reading one on the reading default", async () => {
  assert.deepEqual(await models({ model: "other-model" }, {}), ["review-default", "other-model", "review-default"]);
  assert.deepEqual(await models({ subagent_type: "explore" }, {}), ["review-default", "explore-model", "review-default"]);
});

/** One tool turn whose prompt crosses the compaction trigger, on a history long enough to compact. */
async function compactingRun(pool?: { left: number; used: number }) {
  let streamCalls = 0;
  let completeCalls = 0;
  const session = {
    async streamTurn() {
      streamCalls++;
      return {
        content: streamCalls === 1
          ? [{ type: "tool_use", id: `t${streamCalls}`, name: "read", input: { path: "x" } }]
          : [{ type: "text", text: "done" }],
        stopReason: streamCalls === 1 ? "tool_use" : "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
        promptTokens: 2000,
      };
    },
    async complete() { completeCalls++; return "summary"; },
  };
  const messages: unknown[] = [{ role: "user", content: "go" }];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `a${i}`, name: "read", input: {} }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `a${i}`, content: "ok" }] });
  }
  const result = await agentLoop(messages as never, [{ name: "read", description: "", input_schema: {} }] as never, {
    model: "m", apiUrl: "http://localhost", apiKey: "k", maxTurns: 10,
    ...(pool ? { turnPool: pool } : {}),
    llmSession: session as never,
    router: { route: async () => "ok", setHands() {} } as never,
    sessionId: uniqueSession(), userId: "u", depth: 0, onEvent: async () => {},
  } as never);
  return { streamCalls, completeCalls, turns: result.turns };
}

test("under a review's pool the compaction summary takes a turn, and with none left it is not asked for", async () => {
  // Three turns: the tool turn, the summary, the closing turn; all three reported.
  const roomy = { left: 3, used: 0 };
  assert.deepEqual(await compactingRun(roomy), { streamCalls: 2, completeCalls: 1, turns: 3 });
  assert.deepEqual(roomy, { left: 0, used: 3 });
  // Two: the summary takes the last turn, so the loop ends there; no model call beyond the two the pool gave.
  const two = { left: 2, used: 0 };
  assert.deepEqual(await compactingRun(two), { streamCalls: 1, completeCalls: 1, turns: 2 });
  // One: the tool turn took it, so there is no summary and no further turn.
  const one = { left: 1, used: 0 };
  assert.deepEqual(await compactingRun(one), { streamCalls: 1, completeCalls: 0, turns: 1 });
});

test("an ordinary run compacts as before and reports its own loop's turns", async () => {
  assert.deepEqual(await compactingRun(), { streamCalls: 2, completeCalls: 1, turns: 2 });
});
