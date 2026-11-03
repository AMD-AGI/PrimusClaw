// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reading a skill is as harmless as reading a file, and `read` is in HITL_AUTO_ALLOW's default. `load_skill`
 * is how a skill is read now (claw-241), so it is auto-allowed too: turning HITL on must not start asking a
 * person to approve every skill the model loads, which a deployment that had HITL on (and `read` allowed)
 * was never asked before.
 */
import "./a2a-hitl-scope-env.js";
import test from "node:test";
import assert from "node:assert/strict";

import { HITL_ENABLED, HITL_AUTO_ALLOW } from "../src/config.js";
import { HitlController } from "../src/agent/hitl.js";

const dispatcher = { register: async () => ({ type: "decision", session_id: "s", action_id: "x", decision: "allow" }) };
// An approval policy exists (as it does wherever HITL asks about anything), and it holds nothing here.
const controller = () => new HitlController(dispatcher as never, async () => {}, { requireApproval: () => false });

test("the default HITL_AUTO_ALLOW names load_skill next to read", () => {
  assert.equal(HITL_ENABLED, true, "the premise: the setting is on");
  const names = HITL_AUTO_ALLOW.split(",").map((s) => s.trim());
  assert.ok(names.includes("read") && names.includes("load_skill"), HITL_AUTO_ALLOW);
});

test("with HITL on, loading a skill is auto-allowed and asks nobody; a tool outside the list still does", async () => {
  const c = controller();
  assert.equal(c.willAsk("load_skill", { name: "agent-board" }), false);
  assert.equal(c.willAsk("read", { path: "/workspace/x" }), false);
  assert.equal(c.willAsk("bash", { command: "ls" }), true, "the premise: HITL is asking about tools that are not listed");
  const res = await c.beforeToolUse({ tool: "load_skill", input: { name: "agent-board" }, actionId: "a1", sessionId: "s" } as never);
  assert.deepEqual([res.action, (res as { by: string }).by], ["allow", "auto_allow"]);
});
