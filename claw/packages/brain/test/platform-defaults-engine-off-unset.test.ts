// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * PLATFORM_DEFAULTS_FILE unset: chats are built exactly as before.
 *
 * The prompt is compared to a literal (what main produced for the same input),
 * not to a function of this branch, so a leak of the feature into the off path
 * cannot move the expectation with it. A read of `.skills` must not write.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, skillZip, fakeHands, baseRequest } from "./support/platform-defaults-world.js";

const world = await startWorld(); // no defaults file
process.env.PROGRESSIVE_SKILLS_ENABLED = "true"; // even with the second flag on
world.setTools([{ id: 11, name: "fleet-ops", zip: skillZip("fleet-ops", "BODY", "Operate the GPU fleet") }]);
const { AgentEngine } = await import("../src/agent/engine.js");

test.after(() => world.close());

test("flag off: byte-identical prompt, no marketplace traffic, no skill write", async () => {
  const hands = fakeHands();
  world.script([{ tool: "read", input: { path: "/workspace/.skills/fleet-ops/SKILL.md" } }, { text: "done" }]);
  await new AgentEngine().execute(
    baseRequest({ skills: { local1: { enabled: true, content: "LOCAL BODY", version: 1 } } }),
    (async () => {}) as never, undefined, hands as never,
  );
  const first = JSON.parse(world.llmBodies[0]);
  const user = first.messages.find((m: { role: string }) => m.role === "user");
  const text = typeof user.content === "string" ? user.content : user.content.map((b: { text?: string }) => b.text ?? "").join("");
  assert.equal(
    text,
    "hello there\n\n\n- Available Skills: local1.\n\n=== SKILL: local1 (SKILL.md) ===\nLOCAL BODY\n=== END SKILL: local1 ===\n\n"
    + "Supporting files for each skill are at /workspace/.skills/{name}/. "
    + "Use bash/read to load them (e.g. `cat /workspace/.skills/{name}/actions/<step>.md`). "
    + "Follow the SKILL.md orchestrator above precisely.\n\n\n"
    // No "A2A Auth" line: a2a_call is off by default, and a tool that is not offered is not described.
    + "[Session Context]\n- Session ID: s1\n- User ID: u1",
  );
  assert.equal(world.listCalls, 0, "no marketplace call");
  assert.equal(hands.calls.filter((c) => c.name === "write").length, 0, "nothing written");
});
