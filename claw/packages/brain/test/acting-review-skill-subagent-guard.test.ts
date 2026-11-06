// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The skill-read guard (`BRAIN_BLOCK_SKILL_SUBAGENTS`) and a pull request review. The review's second pass is a `task` whose prompt names
 * the files the review read; a change to two skill files names two `SKILL.md` paths and asks to read them, which is the guard's pattern.
 * In a session that acts as a user (`withhold_sandbox_keys`), which is a review, the second pass runs; in any other run the guard still
 * turns the same dispatch away. Through the real engine; only the network edges are fake.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { uniqueSession } from "./support/plugin-world.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(() => world.close());

const SECOND_PASS = "abc1234 Second-pass PR review. Read the change in skills/a/SKILL.md and skills/b/SKILL.md and their callers; report what the first pass missed.";

test("a second pass naming two SKILL.md files runs in an acting review session, and is still turned away anywhere else", async () => {
  // [what, request fields, whether the sub-agent ran]
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["acting review session", { withhold_sandbox_keys: true }, true],
    ["ordinary session", {}, false],
  ];
  for (const [what, over, ran] of cases) {
    world.script(ran
      ? [{ tool: "task", input: { description: "Second-pass PR review", subagent_type: "explore", prompt: SECOND_PASS } }, { text: "sub done" }, { text: "parent done" }]
      : [{ tool: "task", input: { description: "Second-pass PR review", subagent_type: "explore", prompt: SECOND_PASS } }, { text: "parent done" }]);
    world.llmBodies.length = 0;
    await new AgentEngine().execute(
      baseRequest({ session_id: uniqueSession(), ...over }),
      (async () => {}) as never, undefined, null as never,
      { attachHands: async () => fakeHands() as never } as never,
    );
    const subRequests = world.llmBodies.filter((raw) => JSON.stringify((JSON.parse(raw) as { messages: Array<{ content: unknown }> }).messages[0]?.content).includes("abc1234 Second-pass"));
    assert.equal(subRequests.length, ran ? 1 : 0, `${what}: ${world.llmBodies.length} requests`);
    const last = world.llmBodies.at(-1) ?? "";
    assert.equal(last.includes("skill paths detected"), !ran, `${what}: the parent's last request carries the guard's refusal only when it applied`);
  }
});
