// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** `BASH_APPROVAL_DEFAULTS_ENABLED=false`: the built-in GitHub write rules are gone and the shell runs as before. */
import test from "node:test";
import assert from "node:assert/strict";

delete process.env.BASH_APPROVAL_RULES;
process.env.BASH_APPROVAL_DEFAULTS_ENABLED = "false";

import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); });

test("turned off, a GitHub write from the shell runs without a hold", async () => {
  world.script([{ tool: "bash", input: { command: "gh pr merge 12 --squash" } }, { text: "done" }]);
  const hands = fakeHands();
  await new AgentEngine().execute(
    baseRequest({ session_id: "defaults-off" }), (async () => {}) as never, undefined, null as never,
    { attachHands: async () => hands as never } as never,
  );
  assert.equal(hands.calls.some((c) => c.name === "bash"), true);
});
