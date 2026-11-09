// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { NOTHING, decode, remoteStep } from "../../src/remote-view/events.js";
import { RemoteTurnState } from "../../src/remote-view/turn-state.js";
import { PLAIN_ERRORS, acp, frame } from "./frames.js";

const read = (event: Parameters<typeof decode>[0]) => decode(event, PLAIN_ERRORS);

test("chunks are read in either shape", () => {
  const cases: [string, ReturnType<typeof acp>, { kind: string; text: string } | null][] = [
    [
      "ACP message chunk",
      acp("agent_message_chunk", "1", { content: { type: "text", text: "hi" } }),
      { kind: "message", text: "hi" },
    ],
    ["flat message chunk", frame("agent_message_chunk", { text: "hi" }), { kind: "message", text: "hi" }],
    ["content as a bare string", frame("agent_message_chunk", { content: "hi" }), { kind: "message", text: "hi" }],
    [
      "ACP thought chunk",
      acp("agent_thought_chunk", "1", { content: { type: "text", text: "hmm" } }),
      { kind: "thought", text: "hmm" },
    ],
    ["a chunk with no text", acp("agent_message_chunk", "1", { content: { type: "image" } }), null],
    ["a chunk whose text is not a string", frame("agent_message_chunk", { text: 7 }), null],
  ];
  for (const [label, event, expected] of cases) assert.deepEqual(read(event).chunk, expected, label);
});

test("tool calls are read with their id title and status", () => {
  const cases: [string, ReturnType<typeof acp>, [string, string, string]][] = [
    [
      "tool call starts pending",
      acp("tool_call", "1", { toolCallId: "t1", title: "Run tests", kind: "execute" }),
      ["t1", "Run tests", "pending"],
    ],
    [
      "update with a status only",
      acp("tool_call_update", "1", { toolCallId: "t1", status: "completed" }),
      ["t1", "", "completed"],
    ],
    [
      "update with a failure",
      acp("tool_call_update", "1", { toolCallId: "t1", title: "Run tests", status: "failed" }),
      ["t1", "Run tests", "failed"],
    ],
    [
      "flat shape",
      frame("tool_call", { toolCallId: "t2", title: "Read", status: "in_progress" }),
      ["t2", "Read", "in_progress"],
    ],
    ["no id at all", acp("tool_call", "1", { title: "x" }), ["", "x", "pending"]],
  ];
  for (const [label, event, [id, title, status]] of cases)
    assert.deepEqual(read(event).tool, { id, title, status }, label);
});

test("a plan is one line saying where it stands", () => {
  const entries = [
    { content: "read", status: "completed" },
    { content: "edit the README", status: "in_progress" },
    { content: "run tests", status: "pending" },
  ];
  assert.equal(read(acp("plan", "1", { entries })).plan, "\u{1f4cb} Plan: 1 of 3 done, now: edit the README");
  assert.equal(
    read(acp("plan", "1", { entries: [{ content: "a", status: "completed" }] })).plan,
    "\u{1f4cb} Plan: 1 of 1 done",
  );
  assert.equal(read(acp("plan", "1", { entries: [] })).plan, null);
  assert.equal(read(acp("plan")).plan, null);
});

test("session started says the mode and the modes", () => {
  const cases: [string, Record<string, unknown>, string | null, string[] | null][] = [
    [
      "object modes",
      { currentMode: "default", modes: [{ id: "default" }, { id: "plan", name: "Plan" }] },
      "default",
      ["default", "plan"],
    ],
    [
      "plain id modes",
      { currentMode: "read-only", modes: ["read-only", "agent"] },
      "read-only",
      ["read-only", "agent"],
    ],
    [
      "ACP session mode state",
      { modes: { currentModeId: "plan", availableModes: [{ id: "plan" }, { id: "default" }] } },
      "plan",
      ["plan", "default"],
    ],
    ["nothing said", {}, null, null],
  ];
  for (const [label, data, mode, modes] of cases) {
    const step = read(frame("session_started", data));
    assert.deepEqual([step.started, step.mode, step.modes], [true, mode, modes], label);
  }
});

test("mode update says the new mode in either spelling", () => {
  assert.equal(read(frame("mode_update", { currentModeId: "plan" })).mode, "plan");
  assert.equal(read(frame("mode_update", { currentMode: "default" })).mode, "default");
  assert.equal(read(acp("current_mode_update", "1", { currentModeId: "plan" })).mode, null); // (not a type the connector sends)
});

test("how a turn or session ends", () => {
  const cases: [string, ReturnType<typeof frame>, boolean, string, string | null][] = [
    ["a normal end", frame("turn_end", { stopReason: "end_turn" }), true, "end_turn", null],
    ["cancelled", frame("turn_end", { stopReason: "cancelled" }), true, "cancelled", null],
    ["no stop reason is a plain end", frame("turn_end", {}), true, "end_turn", null],
    ["an error event ends the turn", frame("error", { message: "boom" }), true, "error", null],
    [
      "the session closed",
      frame("session_closed", { reason: "cwd is outside the allowed roots" }),
      false,
      "",
      "cwd is outside the allowed roots",
    ],
    ["closed without a reason", frame("session_closed", {}), false, "", ""],
    ["usage is not shown", frame("usage_update", { used: 3 }), false, "", null],
    ["an unknown type is skipped", frame("brand_new_thing", { a: 1 }), false, "", null],
  ];
  for (const [label, event, finished, reason, closed] of cases) {
    const step = read(event);
    assert.deepEqual([step.finished, step.stopReason, step.closed], [finished, reason, closed], label);
  }
});

test("events the agent replayed are never new", () => {
  for (const name of ["agent_message_chunk", "tool_call", "turn_end", "permissionRequest", "session_closed"]) {
    const step = read(frame(name, { replay: true, text: "old", actionId: "a", options: [{ optionId: "x" }] }));
    assert.deepEqual(step, remoteStep({ replay: true }), name);
  }
  const state = new RemoteTurnState(PLAIN_ERRORS);
  state.feed(frame("agent_message_chunk", { replay: true, text: "old" }, "1"));
  state.feed(frame("turn_end", { replay: true, stopReason: "end_turn" }, "2"));
  assert.equal(state.answer, "");
  assert.equal(state.ended, false);
});

test("a permission request and its answer are passed on whole", () => {
  const request = {
    actionId: "a1",
    tool: "Edit README.md",
    options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
  };
  assert.deepEqual(read(frame("permissionRequest", request)).permission, request);
  const resolved = { actionId: "a1", optionId: "allow_once", by: "u" };
  assert.deepEqual(read(frame("permission_resolved", resolved)).resolved, resolved);
});

test("an unknown type is nothing", () => {
  assert.equal(read(frame("constructor")), NOTHING);
  assert.equal(read(frame("history_complete")), NOTHING);
});
