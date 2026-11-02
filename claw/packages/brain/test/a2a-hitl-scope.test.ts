// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Turning a2a_call on builds an approval controller for a run that had none, so that an allow answering a
 * peer's approval request can be held for the user. That controller must hold that and nothing else: with
 * HITL_ENABLED=true and no approval policy, Brain has never asked about any tool (the setting did nothing
 * without a policy), and a controller that appears because of a2a_call must not start.
 */
import "./a2a-hitl-scope-env.js";
import test from "node:test";
import assert from "node:assert/strict";

import { HITL_ENABLED } from "../src/config.js";
import { a2aApprovalHold } from "../src/clients/a2a.js";
import { HitlController } from "../src/agent/hitl.js";

const dispatcher = { register: async () => ({ type: "decision", session_id: "s", action_id: "x", decision: "allow" }) };
const controller = (onlyHeld: boolean) =>
  new HitlController(dispatcher as never, async () => {}, { requireApprovalFor: a2aApprovalHold, onlyHeld });

test("with HITL_ENABLED on, a controller that exists only for a2a approvals asks about nothing else", () => {
  assert.equal(HITL_ENABLED, true, "the premise: the setting is on");
  const approval = { agent: "p", task_id: "t", approval: { action_id: "x", decision: "allow" } };

  const only = controller(true);
  for (const tool of ["write", "edit", "bash", "mcp__x__y", "a2a_call"]) {
    assert.equal(only.willAsk(tool, { agent: "p", message: "hi" }), false, `${tool} runs as it did before`);
  }
  assert.equal(only.willAsk("a2a_call", approval), true, "the one thing it holds");

  const general = controller(false);
  assert.equal(general.willAsk("write", {}), true, "without the option the setting would have taken hold");
  assert.equal(general.willAsk("a2a_call", approval), true);
});
