// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A router turn's streamed say text that is not going to be said is taken back (`toolTextVoid`, `assistant/router-speed.ts`), and the
 * session stream forwards none of that turn's say text after it (`StreamVoided`, `routes/events.ts`). On 2026-11-06 15:11Z the router
 * wrote a say in the same response as a review handoff: its first words were streamed to the person's chat, Claw refused the say, and
 * the chat kept "已把 Primus" as a message beside its own answer.
 *
 * Reverse proof: `StreamVoided.forward` forwarding every delta -> "a voided turn's later say text is not forwarded"; `voidStreamedSay`
 * publishing without the turn's message id -> "the void names the turn and the say".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamVoided } from "../src/routes/events.js";
import { TOOL_TEXT_VOID_EVENT, voidStreamedSay } from "../src/assistant/router-speed.js";

const delta = (mid: string, text: string) => ({ type: "toolTextDelta", tool: "mcp__assistant__say", actionId: "toolu_1", text, message_id: mid });

test("a voided turn's later say text is not forwarded; its void and other turns' text are", () => {
  const voided = new StreamVoided();
  assert.equal(voided.forward(delta("m1", "已把")), true, "before the void: a preview like any other");
  assert.equal(voided.forward({ type: TOOL_TEXT_VOID_EVENT, tool: "mcp__assistant__say", message_id: "m1", reason: "handed_off" }), true);
  assert.equal(voided.forward(delta("m1", "已把 Primus")), false);
  assert.equal(voided.forward(delta("m2", "节点")), true, "another turn's text");
  assert.equal(voided.forward({ type: "toolUsed", tool: "mcp__assistant__say", status: "success", message_id: "m1" }), true, "only the preview is dropped");
  assert.equal(voided.forward({ type: "toolTextDelta", text: "x" }), true, "an event naming no turn");
});

test("a void stream remembers only the newest turns", () => {
  const voided = new StreamVoided(2);
  for (const mid of ["a", "b", "c"]) voided.forward({ type: TOOL_TEXT_VOID_EVENT, message_id: mid });
  assert.equal(voided.forward(delta("a", "x")), true);
  assert.equal(voided.forward(delta("c", "x")), false);
});

test("the void names the turn and the say, and a publish that fails is not the tool's failure", async () => {
  const published: Array<[string, Record<string, unknown>]> = [];
  await voidStreamedSay("s1", "m1", "handed_off", async (sid, e) => { published.push([sid, e]); });
  assert.deepEqual(published, [["s1", { type: TOOL_TEXT_VOID_EVENT, tool: "mcp__assistant__say", message_id: "m1", reason: "handed_off" }]]);
  await voidStreamedSay("s1", undefined, "handed_off", async (sid, e) => { published.push([sid, e]); });
  assert.equal(published.length, 1, "no turn named: nothing to take back");
  await voidStreamedSay("s1", "m1", "empty_text", async () => { throw new Error("nats down"); });
});
