// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { answerParts } from "../../src/remote/answer.js";
import { RemoteTurnState } from "../../src/remote/turn-state.js";
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
    if (n % 100 === 0) state.feed(acp("tool_call", `tc${String(n)}`, { toolCallId: "t", title: "x" }));
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
  const parts = answerParts(
    Array.from({ length: 12 }, (_, n) => `paragraph ${String(n)} ` + "w".repeat(1500)).join("\n\n"),
  );
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 3200));
  assert.ok(parts.at(-1)?.endsWith("(shortened: ask the agent to continue, or read the rest on your machine)"));
  assert.ok(parts[0]?.includes("paragraph 0"));
});

test("a credential in the answer is masked", () => {
  const secret = "sk-EXAMPLE-abcdef0123456789abcdef0123456789";
  assert.ok(!answerParts(`token: ${secret}`)[0]?.includes(secret));
});

test("a turn Claw put to the session for itself is nothing to the reader, and what follows its end is read", () => {
  const state = new RemoteTurnState(PLAIN_ERRORS, () => 8);
  const steps = [
    frame("user_prompt", { text: "What do you handle?", cmd_seq: 7, client: "seat_probe", by: "claw" }, "1"),
    acp("agent_message_chunk", "2", { content: { text: "I am responsible for the billing service." } }),
    acp("tool_call", "3", { toolCallId: "t", title: "Read" }),
    frame("mode_update", { currentMode: "plan" }, "4"),
    frame("turn_end", { stopReason: "end_turn", cmd_seq: 7 }, "5"),
  ].map((event) => state.feed(event));
  assert.ok(steps.every((step) => step.chunk === null && step.tool === null && step.mode === null && !step.finished));
  assert.deepEqual(state.segments, []);
  assert.equal(state.ended, false);
  assert.equal(state.hiding, false);
  // the person's own prompt that comes next is read as usual
  state.feed(frame("user_prompt", { text: "fix it", cmd_seq: 8, client: "personal-agent", by: "claw" }, "6"));
  state.feed(acp("agent_message_chunk", "7", { content: { text: "Fixed." } }));
  state.feed(frame("turn_end", { stopReason: "end_turn", cmd_seq: 8 }, "8"));
  assert.equal(state.answer, "Fixed.");
  assert.equal(state.ended, true);
});

test("a turn Claw put for itself ends at its refusal, at the session's end, and at another prompt's turn end", () => {
  const refused = turn();
  refused.feed(frame("user_prompt", { cmd_seq: 3, client: "seat_probe" }, "1"));
  refused.feed(frame("command_rejected", { type: "prompt", cmd_seq: 3, reason: "busy" }, "2"));
  assert.equal(refused.hiding, false);
  refused.feed(acp("agent_message_chunk", "3", { content: { text: "on its own" } }));
  assert.equal(refused.answer, "on its own");

  const closed = turn();
  closed.feed(frame("user_prompt", { cmd_seq: 3, client: "seat_probe" }, "1"));
  const step = closed.feed(frame("session_closed", { reason: "stopped" }, "2"));
  assert.equal(step.closed, "stopped");
  assert.equal(closed.hiding, false);

  const other = turn();
  other.feed(frame("user_prompt", { cmd_seq: 3, client: "seat_probe" }, "1"));
  const end = other.feed(frame("turn_end", { stopReason: "end_turn", cmd_seq: 4 }, "2"));
  assert.equal(end.finished, true);
  assert.equal(other.hiding, false);

  // a prompt of any other client is no such turn
  const mine = turn();
  mine.feed(frame("user_prompt", { cmd_seq: 3, client: "assistant" }, "1"));
  mine.feed(acp("agent_message_chunk", "2", { content: { text: "Shown." } }));
  assert.equal(mine.answer, "Shown.");
});

test("a connector that restarts in the middle of a turn Claw put for itself hides what follows while that turn goes on", () => {
  const going = turn();
  going.feed(frame("user_prompt", { cmd_seq: 3, client: "seat_probe" }, "1"));
  going.feed(frame("session_recovered", { interrupted: true, continuing: true }, "2"));
  going.feed(acp("agent_message_chunk", "3", { content: { text: "billing" } }));
  assert.equal(going.hiding, true);
  assert.equal(going.answer, "");
  going.feed(frame("turn_end", { stopReason: "end_turn", cmd_seq: 3 }, "4"));
  assert.equal(going.hiding, false);

  const gone = turn();
  gone.feed(frame("user_prompt", { cmd_seq: 3, client: "seat_probe" }, "1"));
  const step = gone.feed(frame("session_recovered", { interrupted: true, continuing: false }, "2"));
  assert.notEqual(step.recovered, null);
  assert.equal(gone.hiding, false);
});

test("the read position a reader writes stays before a turn Claw put for itself until that turn ends", () => {
  const state = turn();
  state.feed(acp("agent_message_chunk", "5", { content: { text: "mine" } }));
  assert.equal(state.holdCursor("5", "4"), "5");
  state.feed(frame("user_prompt", { cmd_seq: 3, client: "seat_probe" }, "6"));
  state.feed(acp("agent_message_chunk", "7", { content: { text: "billing" } }));
  assert.equal(state.holdCursor("7", "4"), "5");
  state.feed(frame("turn_end", { stopReason: "end_turn", cmd_seq: 3 }, "8"));
  assert.equal(state.holdCursor("8", "4"), "8");
  // a hidden turn that began with the first event read holds the position the reader started from
  const first = turn();
  first.feed(frame("user_prompt", { cmd_seq: 3, client: "seat_probe" }, "6"));
  assert.equal(first.holdCursor("6", "4"), "4");
});
