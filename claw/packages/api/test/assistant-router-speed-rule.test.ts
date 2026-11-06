// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What keeps a router turn quick (`assistant/router-speed.ts`), as a rule over the turn's request; no database.
 *
 *   S1 a router turn asks for low effort unless its session chose one, and has its say streamed; each can be turned off
 */
import assert from "node:assert/strict";
import test from "node:test";

import { applyRouterTurnSpeed, STREAMED_SAY_TOOL } from "../src/assistant/router-speed.js";

test("S1 a router turn asks for low effort unless its session chose one, and has its say streamed", () => {
  const on = { effort: "low", streamSay: true };
  const plain: Record<string, unknown> = { prompt: "hi" };
  applyRouterTurnSpeed(plain, on);
  assert.deepEqual(plain, { prompt: "hi", effort: "low", stream_tool_text: ["mcp__assistant__say"] });
  assert.equal(STREAMED_SAY_TOOL, "mcp__assistant__say");

  const chosen: Record<string, unknown> = { effort: "high" };
  applyRouterTurnSpeed(chosen, on);
  assert.equal(chosen.effort, "high", "the session's own choice stands");

  // `default` (null): the model's own effort; the switch off: nothing streamed, whatever the request carried.
  const off: Record<string, unknown> = { stream_tool_text: ["mcp__other__tool"] };
  applyRouterTurnSpeed(off, { effort: null, streamSay: false });
  assert.deepEqual(off, {});
});

