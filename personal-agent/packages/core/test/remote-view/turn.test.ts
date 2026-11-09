// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { answerParts } from "../../src/remote-view/answer.js";
import { RemoteTurnState } from "../../src/remote-view/turn-state.js";
import { PLAIN_ERRORS, acp, frame } from "./frames.js";

const turn = () => new RemoteTurnState(PLAIN_ERRORS);

test("the answer is the agents last piece of text not its narration", () => {
  const state = turn();
  for (const event of [
    acp("agent_message_chunk", "1", { content: { text: "I will look. " } }),
    acp("agent_message_chunk", "2", { content: { text: "Reading." } }),
    acp("tool_call", "3", { toolCallId: "t", title: "Read" }),
    acp("agent_message_chunk", "4", { content: { text: "Done: " } }),
    acp("agent_message_chunk", "5", { content: { text: "added the line." } }),
    frame("turn_end", { stopReason: "end_turn" }, "6"),
  ]) {
    state.feed(event);
  }
  assert.deepEqual(state.segments, ["I will look. Reading.", "Done: added the line."]);
  assert.equal(state.answer, "Done: added the line.");
  assert.equal(state.ended, true);
  assert.equal(state.stopReason, "end_turn");
});

test("a turn that ends on a tool still has its last text as the answer", () => {
  const state = turn();
  state.feed(acp("agent_message_chunk", "1", { content: { text: "Editing the file." } }));
  state.feed(acp("tool_call", "2", { toolCallId: "t", title: "Edit" }));
  state.feed(frame("turn_end", { stopReason: "end_turn" }, "3"));
  assert.equal(state.answer, "Editing the file.");
});

test("a turn that never ends holds a bounded amount of text and ids", () => {
  const state = turn();
  for (let n = 0; n < 5000; n += 1) {
    state.feed(acp("agent_message_chunk", String(n + 1), { content: { text: "w".repeat(1000) } }));
    if (n % 100 === 0) state.feed(acp("tool_call", `tc${n}`, { toolCallId: "t", title: "x" }));
  }
  assert.ok(state.segments.every((seg) => seg.length <= 12_000) && state.segments.length <= 4);
  assert.ok(state.seen.size <= 2000 && state.answer.startsWith("w"));
  assert.ok(answerParts(state.answer).at(-1)?.includes("(shortened")); // what is kept is still more than the answer shows
});

test("a repeat of a recent event is dropped even after many others", () => {
  const state = turn();
  for (let n = 1; n < 2500; n += 1) state.feed(acp("agent_message_chunk", String(n), { content: { text: "a" } }));
  const count = state.segments.reduce((sum, s) => sum + s.length, 0);
  state.feed(acp("agent_message_chunk", "2499", { content: { text: "REPEAT" } }));
  assert.equal(
    state.segments.reduce((sum, s) => sum + s.length, 0),
    count,
  );
});

test("an event seen twice counts once", () => {
  const state = turn();
  for (let i = 0; i < 2; i += 1) state.feed(acp("agent_message_chunk", "7", { content: { text: "x" } }));
  assert.deepEqual(state.segments, ["x"]);
});

test("the session closing is noted with its reason", () => {
  const state = turn();
  state.feed(frame("session_closed", { reason: "the mode could not be set" }, "1"));
  assert.equal(state.closed, "the mode could not be set");
  assert.equal(state.ended, false);
});

test("take answer forgets the text but not the events seen", () => {
  const state = turn();
  state.feed(acp("agent_message_chunk", "1", { content: { text: "first" } }));
  state.feed(frame("turn_end", {}, "2"));
  assert.equal(state.takeAnswer(), "first");
  assert.deepEqual([state.segments, state.ended, state.stopReason, state.note], [[], false, "", null]);
  state.feed(acp("agent_message_chunk", "1", { content: { text: "again" } }));
  assert.equal(state.answer, "");
});

test("an empty answer still says something", () => {
  assert.deepEqual(answerParts("   "), ["Done. There was no text output."]);
  assert.deepEqual(answerParts("   ", "zh"), ["完成了，没有文字输出。"]);
});

test("a long answer is split and then cut with a line that says so", () => {
  const parts = answerParts(Array.from({ length: 12 }, (_, n) => `paragraph ${n} ` + "w".repeat(1500)).join("\n\n"));
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 3200));
  assert.ok(parts.at(-1)?.endsWith("(shortened: ask the agent to continue, or read the rest on your machine)"));
  assert.ok(parts[0]?.includes("paragraph 0"));
});

test("a credential in the answer is masked", () => {
  const secret = "sk-EXAMPLE-abcdef0123456789abcdef0123456789";
  assert.ok(!answerParts(`token: ${secret}`)[0]?.includes(secret));
});
