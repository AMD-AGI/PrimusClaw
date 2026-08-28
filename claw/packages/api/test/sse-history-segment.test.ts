// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a client can tell from the history segment of the SSE stream.
 *
 * The case that motivated these: a session created but never spoken to sent
 * nothing at all -- no frame, no marker -- so "this chat is empty" and "the
 * history has not arrived yet" were the same bytes on the wire. The first thing
 * the client received was a keepalive comment 15 seconds later, which fires no
 * EventSource handler, so nothing ever told it to stop waiting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { historySegment, HISTORY_COMPLETE_EVENT } from "../src/routes/events.js";

const OPTS = { foldSubagents: false };

function row(id: string, data: Record<string, unknown>) {
  return { event_id: id, data };
}

/** The `event:` names a client would dispatch on, in order. */
function names(frames: string[]): string[] {
  return frames.map((f) => /^(?:id: .*\n)?event: (.+)$/m.exec(f)?.[1] ?? "");
}

function markerData(frames: string[]): Record<string, unknown> {
  const last = frames[frames.length - 1];
  return JSON.parse(/^data: (.*)$/m.exec(last)![1]);
}

test("a session with no events still tells the client the history is over", () => {
  const { frames, seenIds } = historySegment([], OPTS);

  assert.deepEqual(names(frames), [HISTORY_COMPLETE_EVENT]);
  assert.equal(markerData(frames).count, 0);
  assert.deepEqual(seenIds, [], "nothing to dedup the live loop against");
});

test("the marker comes last, after every event it is reporting", () => {
  const { frames, seenIds } = historySegment(
    [
      row("claw-1", { type: "UserMessage", content: "hello" }),
      row("claw-2", { type: "AssistantMessage", content: "hi" }),
    ],
    OPTS,
  );

  assert.deepEqual(names(frames), ["UserMessage", "AssistantMessage", HISTORY_COMPLETE_EVENT]);
  assert.equal(markerData(frames).count, 2);
  assert.deepEqual(seenIds, ["claw-1", "claw-2"]);
});

test("the marker carries no id, so a reconnect resumes from the last real event", () => {
  const { frames } = historySegment([row("claw-7", { type: "UserMessage" })], OPTS);

  const marker = frames[frames.length - 1];
  assert.equal(
    /^id:/m.test(marker),
    false,
    "an id here would become the client's Last-Event-ID, and ?after= would skip "
    + "real events or ask again for ones it already has",
  );
  assert.match(frames[0], /^id: claw-7$/m);
});

test("the count is what the client will render, not what the table held", () => {
  // exec_complete is dropped on the way out (SKIP_EVENTS), and a folded
  // sub-agent's internals are too. A count of rows read would tell a client to
  // expect events that are never coming.
  const { frames } = historySegment(
    [
      row("claw-1", { type: "UserMessage" }),
      row("claw-2", { type: "exec_complete", turns: 4 }),
      row("claw-3", { type: "AssistantMessage", subagent_id: "sub-1" }),
    ],
    { foldSubagents: true },
  );

  assert.deepEqual(names(frames), ["UserMessage", HISTORY_COMPLETE_EVENT]);
  assert.equal(markerData(frames).count, 1);
});
