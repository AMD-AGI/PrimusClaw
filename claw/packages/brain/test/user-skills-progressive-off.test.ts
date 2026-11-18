// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Personal skills do not depend on PROGRESSIVE_SKILLS_ENABLED. That switch decides how the platform's and a plugin's
 * skills reach the prompt; a personal skill has only the one way (the API sends names and descriptions, never the
 * text), so with the switch off (its default) they are still listed and loaded, and the platform's default skills are
 * still not fetched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, skillZip, fakeHands, baseRequest } from "./support/platform-defaults-world.js";

const world = await startWorld({ skills: [{ tool_id: 41 }] });
delete process.env.PROGRESSIVE_SKILLS_ENABLED;
world.setTools([{ id: 41, name: "fleet-default", zip: skillZip("fleet-default", "PLATFORM-FLEET-BODY", "Platform fleet helper") }]);
world.internal = (url, body) => {
  if (url !== "/v1/internal/skills/read" || body.name !== "weekly-report" || body.content_sha !== "sha-1") return { status: 404, body: { ok: false, error: "not_found" } };
  return { status: 200, body: { ok: true, name: "weekly-report", version: 1, description: "d", invocation: "auto", content_sha: "sha-1", origin: "chat", content: "WR-BODY-MARKER", files: [] } };
};
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); });

test("with PROGRESSIVE_SKILLS_ENABLED off, personal skills are listed and loaded; the platform's are not fetched", async () => {
  world.script([{ tool: "load_skill", input: { name: "weekly-report" } }, { text: "done" }]);
  world.llmBodies.length = 0;
  const result = await new AgentEngine().execute(
    baseRequest({
      session_id: "s-off-1", message_id: "m1", user_skills_enabled: true,
      user_skills: [{ name: "weekly-report", version: 1, description: "Write the weekly report", invocation: "auto", content_sha: "sha-1", origin: "chat" }],
    }),
    (async () => {}) as never, undefined, null as never, { attachHands: async () => fakeHands() as never } as never,
  );
  const [first, second] = world.llmBodies;
  assert.match(first, /- weekly-report: Write the weekly report/);
  assert.equal(first.includes("fleet-default"), false, "the platform's default skills stay off");
  assert.deepEqual(world.downloads, [], "and are not fetched");
  assert.ok(second.includes("WR-BODY-MARKER"));
  assert.deepEqual(result.skillsUsed, { "weekly-report": 1 });
});
