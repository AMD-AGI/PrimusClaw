// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A turn is followed in the chat for TURN_DEADLINE_SECONDS (test_turn_deadline.py). When that is up the run is still
 * going: the chat says so (it does not claim a lost connection), and the turn is recorded as not delivered, so what the
 * run does later still reaches the person.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { ClawError, ClawUnreachable } from "../../src/claw/errors.js";
import type { SseEvent } from "../../src/claw/model.js";
import { stillRunningText } from "../../src/turn/engine/outcome.js";
import { play, type PlayOptions, type Run } from "./play.js";
import { Timeline } from "./timeline.js";
import { Bus, PUBLIC, ScriptedClaw, textOf, world } from "./world.js";

const LOST = "I lost the connection to PrimusClaw";
const REPORT = "Did something go wrong? You can tell the PrimusClaw team.";

function chatText(run: Run): string {
  return run.bus.sent
    .filter((s) => s.kind === "message" && s.operation !== "delete")
    .map((s) => textOf(s.message))
    .filter((t) => t)
    .join("\n");
}

function reportCards(run: Run): number {
  return run.bus.sent.filter((s) => textOf(s.message) === REPORT).length;
}

/** A turn whose stream stays open past the deadline (the run is still going). */
function start(options: PlayOptions = {}): Promise<Run> {
  return play([], {
    hang: true,
    ...options,
    request: { key: "ak-alice", text: "do it", ...options.request },
    hooks: { reportMessage: () => ({ body: { type: "text", text: REPORT } }), ...options.hooks },
  });
}

function ctxOf(
  text: string,
  extra: { group?: boolean; notifies?: boolean } = {},
): Parameters<typeof stillRunningText>[0] {
  const clock = new Timeline();
  return world(clock, new Bus(clock), new ScriptedClaw(clock), { request: { text, ...extra }, sessionId: "s1" }).ctx;
}

/** A stream that fails as soon as it is opened. */
function broken(failure: Error): NonNullable<PlayOptions["setUp"]> {
  return (w) => {
    const claw = w.claw;
    claw.stream = async function* (key: string, sessionId: string, after?: string): AsyncGenerator<SseEvent> {
      claw.calls.push(["stream", key, sessionId, after ?? null]);
      await Promise.resolve();
      yield* [];
      throw failure;
    };
  };
}

// --- the words -------------------------------------------------------------------------------------------------------

it("test_a_turn_whose_time_is_up_says_the_task_is_still_running_not_that_the_connection_was_lost", async () => {
  const run = await start();
  const text = chatText(run);
  assert.ok(
    text.includes("still running in PrimusClaw") && !text.includes(LOST) && !text.toLowerCase().includes("failed"),
  );
  assert.ok(text.includes("Open the session to follow it") && !text.includes("I will message you")); // no notifications here
  assert.ok(text.includes(`[Open the session](${PUBLIC}/primus-claw/sess-ak-alice)`));
  assert.equal(reportCards(run), 0); // nothing went wrong, so no "Report a problem"
});

it("test_the_push_is_promised_only_where_the_worker_knows_it_will_come", () => {
  for (const [notifies, group, promised] of [
    [true, false, true], // Claw will push this person the run's end and its approvals
    [false, false, false], // notifications are off for them: no promise the worker cannot keep
    [true, true, false], // a group chat: pushes go to the person's 1:1 chat, not to "here"
  ] as const) {
    const text = stillRunningText(ctxOf("do it", { group, notifies }));
    assert.equal(text.includes("I will message you here when it finishes or needs your approval"), promised);
    assert.equal(text.includes("Open the session to follow it"), !promised);
  }
});

it("test_the_words_are_chinese_for_a_user_who_writes_chinese", () => {
  assert.equal(
    stillRunningText(ctxOf("帮我推送分支", { notifies: true })),
    "任务仍在 PrimusClaw 中运行；我已在 30 分钟后停止在这里跟踪它。 完成或需要你批准时，我会在这里通知你。",
  );
});

it("test_the_minutes_in_the_words_are_the_deadline", () => {
  const ctx = ctxOf("do it");
  assert.ok(stillRunningText(ctx).includes("after 30 minutes"));
  assert.ok(stillRunningText(ctx, 45 * 60).includes("after 45 minutes"));
});

it("test_a_user_with_notifications_is_promised_the_push_through_the_agent", async () => {
  // (the agent reads whether notifications are on for the person from the store; the turn is told so)
  const run = await start({ request: { notifies: true } });
  assert.ok(chatText(run).includes("I will message you here when it finishes or needs your approval"));
});

// --- what is still a lost connection ---------------------------------------------------------------------------------

it("test_a_stream_that_keeps_dropping_is_still_a_lost_connection", async () => {
  const run = await start({ hang: false, setUp: broken(new ClawError(500)) });
  assert.ok(chatText(run).includes(LOST) && !chatText(run).includes("still running"));
  assert.ok(reportCards(run) > 0);
});

it("test_a_network_error_is_still_a_lost_connection", async () => {
  const run = await start({ hang: false, setUp: broken(new ClawUnreachable("network", "refused")) });
  assert.ok(chatText(run).includes(LOST) && !chatText(run).includes("still running"));
});

it("test_a_deadline_that_passes_before_the_message_reached_claw_is_not_a_task_still_running", async () => {
  const run = await start({
    setUp: (w) => {
      w.claw.create = () => new Promise(() => undefined); // Claw never answered the submit: nothing is running
    },
  });
  assert.ok(chatText(run).includes(LOST) && !chatText(run).includes("still running"));
});

// --- what still reaches the person afterwards -------------------------------------------------------------------------

it("test_the_run_ending_after_the_deadline_still_pushes_its_completion_card", async () => {
  // The turn is recorded as not delivered: the run's own completion notification is not muted as "answered in the chat"
  // (the notification itself is the proactive path's).
  const run = await start();
  assert.deepEqual(run.told, ["started", "failed"]);
});
