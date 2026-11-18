// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What keeps a router turn quick (`assistant/router-speed.ts`), as a rule over the turn's request; no database.
 *
 *   S1 a router turn asks for low effort unless its session chose one, and has its say streamed; each can be turned off
 */
import assert from "node:assert/strict";
import test from "node:test";

import { applyRouterTurnSpeed, STREAMED_SAY_TOOL, streamTextOn } from "../src/assistant/router-speed.js";

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

test("S2 a router turn's own text streams as its say's only when asked for, and only with the say streamed", () => {
  const on = { effort: null, streamSay: true };
  const asked: Record<string, unknown> = {};
  applyRouterTurnSpeed(asked, on, true);
  assert.equal(asked.stream_text_as, STREAMED_SAY_TOOL);
  const notAsked: Record<string, unknown> = { stream_text_as: "x" };
  applyRouterTurnSpeed(notAsked, on);
  assert.equal("stream_text_as" in notAsked, false, "off by default, whatever the request carried");
  const noSay: Record<string, unknown> = {};
  applyRouterTurnSpeed(noSay, { effort: null, streamSay: false }, true);
  assert.equal("stream_text_as" in noSay, false);
  assert.equal(streamTextOn("u1", { all: false, users: new Set() }), false);
  assert.equal(streamTextOn("u1", { all: false, users: new Set(["u1"]) }), true);
  assert.equal(streamTextOn(null, { all: false, users: new Set(["u1"]) }), false);
  assert.equal(streamTextOn("u2", { all: true, users: new Set() }), true);
});

