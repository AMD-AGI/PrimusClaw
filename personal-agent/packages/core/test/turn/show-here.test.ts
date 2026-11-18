// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A phone cannot open the web console: every answer must be readable inside the chat (test_show_here.py, the turn's
 * side). "Show here" reads the session's last finished answer with the clicker's own key (`lastAnswer`), and a long answer
 * is split at paragraphs over at most three messages, only the overflow left to the link.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { ClawError } from "../../src/claw/errors.js";
import type { SseEvent } from "../../src/claw/model.js";
import type { JsonObject } from "../../src/json.js";
import { answerParts, MAX_ANSWER_CHARS, MAX_ANSWER_MESSAGES } from "../../src/turn/answer-parts.js";
import { LAST_ANSWER_TAIL, lastAnswer } from "../../src/turn/last-answer.js";
import { play } from "./play.js";
import { Timeline } from "./timeline.js";
import { ev, RecordingErrors, RecordingLogger, result, ScriptedClaw, textOf } from "./world.js";

const LINK = "https://x/primus-claw/s1";

function reader(events: SseEvent[]): { clock: Timeline; claw: ScriptedClaw; deps: Parameters<typeof lastAnswer>[0] } {
  const clock = new Timeline();
  const claw = new ScriptedClaw(
    clock,
    events.map((e) => [0, e] as const),
  );
  claw.rows = events.map((e): JsonObject => ({ event_id: e.id, event_type: e.name, data: e.data, created_at: null }));
  return { clock, claw, deps: { claw, clock, log: new RecordingLogger(), errors: new RecordingErrors() } };
}

// --- the click ---------------------------------------------------------------------------------------------------------

it("test_the_owner_gets_the_answer_in_the_chat_and_the_session_becomes_current", async () => {
  // (the click's routing, and the session becoming the chat's current one, are the router's; here: what is read, and how)
  const { clock, claw, deps } = reader([
    ev("AssistantMessage", "m1", { data: { content: [{ type: "text", text: "draft" }] } }),
    result("The sweep found 3 stale jobs.", "m1"),
  ]);
  assert.equal(await clock.pump(lastAnswer(deps, "ak-alice", "s1")), "The sweep found 3 stale jobs.");
  // the tail of the session, with the owner's key
  assert.ok(
    claw.calls.some((c) => c[0] === "events" && c[1] === "ak-alice" && c[2] === "s1" && c[3] === LAST_ANSWER_TAIL),
  );
});

it("test_a_non_owner_is_refused_and_reads_and_switches_nothing", async () => {
  const { clock, claw, deps } = reader([result("Alice's private answer", "m1")]);
  claw.rows = new ClawError(404); // Claw answers a session only to its owner
  await assert.rejects(clock.pump(lastAnswer(deps, "ak-bob", "s1")), ClawError);
  assert.deepEqual(
    claw.calls.filter((c) => c[0] === "stream" || c[0] === "events").map((c) => c[1]),
    ["ak-bob"],
  ); // only ever Bob's own key
});

it("test_the_last_finished_turn_wins_over_earlier_ones", async () => {
  const { clock, deps } = reader([
    result("first answer", "m1"),
    result("second answer", "m2"),
    ev("AssistantMessage", "m3", { data: { content: [{ type: "text", text: "still running" }] } }),
  ]);
  assert.equal(await clock.pump(lastAnswer(deps, "ak-alice", "s1")), "second answer");
});

it("test_a_session_with_no_finished_turn_is_said_so_and_not_switched", async () => {
  const { clock, deps } = reader([]);
  assert.equal(await clock.pump(lastAnswer(deps, "ak-alice", "s1")), undefined); // (the router says "no finished answer")
});

// --- long answers -------------------------------------------------------------------------------------------------------

function paragraphs(n: number, width = 900): string {
  return Array.from({ length: n }, (_, i) => `${String(i)}:${"x".repeat(width)}`).join("\n\n");
}

it("test_a_long_1to1_answer_is_split_at_paragraphs_and_only_the_overflow_is_a_link", () => {
  for (const [paras, expectMessages, truncated] of [
    [1, 1, false], // short: one message, no link
    [3, 1, false], // 2700 chars: still within one message
    [6, 2, false], // needs a follow-up
    [9, 3, false], // three messages, nothing lost
    [30, 3, true], // beyond the cap: the link
  ] as const) {
    const text = paragraphs(paras);
    const parts = answerParts(text, LINK);
    assert.equal(parts.length, expectMessages, String(paras));
    assert.ok(parts.every((p) => p.length <= MAX_ANSWER_CHARS + 120));
    assert.equal((parts.at(-1) ?? "").includes(`(${LINK})`), truncated);
    if (!truncated)
      assert.equal(parts.join("\n\n"), text); // every paragraph arrives, in order, whole
    else assert.ok(parts[0]?.startsWith("0:"));
  }
});

it("test_a_group_answer_is_split_like_a_1to1_one_and_only_the_link_for_the_rest_says_who_can_open_it", () => {
  const text = paragraphs(30);
  const group = answerParts(text, LINK, true);
  const one = answerParts(text, LINK);
  assert.ok(group.length === MAX_ANSWER_MESSAGES && one.length === MAX_ANSWER_MESSAGES);
  assert.deepEqual(group.slice(0, -1), one.slice(0, -1));
  assert.ok(
    (group.at(-1) ?? "").includes("(only the person who asked can open it)") &&
      (group.at(-1) ?? "").includes(`(${LINK})`),
  );
  assert.ok(!(one.at(-1) ?? "").includes("only the person") && (one.at(-1) ?? "").includes(`(${LINK})`));
  assert.deepEqual(answerParts("short", LINK, true), ["short"]);
});

it("test_the_agent_sends_the_follow_up_messages_in_a_1to1_chat", async () => {
  const run = await play([[0, result(paragraphs(6))]], { request: { key: "ak-alice", text: "long please" } });
  const texts = run.bus.sent
    .map((s) => textOf(s.message))
    .filter((t) => ["0:", "3:", "4:", "5:"].some((p) => t.startsWith(p)));
  assert.equal(texts.length, 2);
  assert.ok(texts.at(-1)?.includes("5:"));
});
