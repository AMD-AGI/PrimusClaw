// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The first outbound message after a quiet spell is slow: the relay scales to zero and a cold instance takes 15-44 s to
 * deliver it and hand back the message's id (test_status_ack_wait.py, the turn's side). On virtual time, so a 25 s turn
 * runs at once and the timing assertions are exact.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { turnEnglish } from "../../src/locales/turn.js";
import type { OutMessage } from "../../src/ports/surface.js";
import { err } from "../../src/result.js";
import { runTurn } from "../../src/turn/engine/run-turn.js";
import type { TurnSurface } from "../../src/turn/ports.js";
import { Timeline } from "./timeline.js";
import { Bus, end, said, ScriptedClaw, textOf, world } from "./world.js";

/** How long a post waits for its id by default (the Python Messenger's ACK_TIMEOUT_SECONDS). */
const ACK_TIMEOUT_SECONDS = 60;

interface Queued {
  readonly at: number;
  readonly operation: "send" | "update";
  readonly typing: boolean;
  readonly message?: OutMessage;
  readonly id?: string;
}

interface QueueOptions {
  /** How long the relay takes to return the id of a posted message. */
  readonly ackAfter?: number;
  /** How long handing the typing indicator to the queue takes. */
  readonly typingTakes?: number;
  readonly typingFails?: boolean;
  /** How long a post waits for its id. */
  readonly ackTimeout?: number;
}

/** The outbound queue with the relay behind it; it cannot delete (the relay's contract has none). */
class QueueAndTeams implements TurnSurface {
  readonly sent: Queued[] = [];
  readonly logs: string[] = [];

  constructor(
    private readonly clock: Timeline,
    private readonly options: QueueOptions = {},
  ) {}

  async typing(): Promise<void> {
    if (this.options.typingFails) throw new Error("the queue refused the send");
    await this.clock.sleep((this.options.typingTakes ?? 0) * 1000);
    this.sent.push({ at: this.clock.now, operation: "send", typing: true });
  }

  send(message: OutMessage): Promise<void> {
    this.sent.push({ at: this.clock.now, operation: "send", typing: false, message });
    return Promise.resolve();
  }

  async post(message: OutMessage): Promise<string | undefined> {
    this.sent.push({ at: this.clock.now, operation: "send", typing: false, message });
    const id = `teams-${String(this.posts().length)}`;
    const ackAfter = this.options.ackAfter ?? 0;
    const timeout = this.options.ackTimeout ?? ACK_TIMEOUT_SECONDS;
    if (ackAfter > timeout) {
      await this.clock.sleep(timeout * 1000);
      return undefined;
    }
    await this.clock.sleep(ackAfter * 1000);
    return id;
  }

  update(id: string, message: OutMessage): Promise<void> {
    this.sent.push({ at: this.clock.now, operation: "update", typing: false, message, id });
    return Promise.resolve();
  }

  delete(): ReturnType<TurnSurface["delete"]> {
    return Promise.resolve(err({ kind: "delete_unsupported", reason: "the outbound queue cannot delete a message" }));
  }

  outgoing(message: OutMessage): ReturnType<TurnSurface["outgoing"]> {
    return { text: textOf(message) };
  }

  deliver(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }

  openStream(): ReturnType<TurnSurface["openStream"]> {
    return Promise.resolve(err({ kind: "stream_refused", reason: "a queue cannot stream", status: 0, code: "" }));
  }

  posts(): Queued[] {
    return this.sent.filter((s) => s.operation === "send" && !s.typing);
  }

  updates(): Queued[] {
    return this.sent.filter((s) => s.operation === "update");
  }
}

/** A turn that answers `answerAt` seconds after it was submitted. */
async function turnOn(
  options: QueueOptions,
  answerAt: number,
): Promise<{ queue: QueueAndTeams; took: number; log: string }> {
  const clock = new Timeline();
  const queue = new QueueAndTeams(clock, options);
  const claw = new ScriptedClaw(clock, [
    [answerAt, said("All green.")],
    [answerAt, end()],
  ]);
  const w = world(clock, new Bus(clock), claw);
  const ctx = { ...w.ctx, deps: { ...w.ctx.deps, surface: queue } };
  const started = clock.now;
  await clock.pump(runTurn(ctx, { onSession: () => undefined, stopRequested: () => false }));
  return { queue, took: clock.now - started, log: w.log.text() };
}

it("test_a_status_ack_that_comes_late_still_lets_the_status_message_be_closed_off", async () => {
  // The relay's cold start returned the id 25 s after the post: the answer is a new message, the queue cannot delete the
  // status message, so with the late id (the turn waits for it) it is edited down to one line.
  const { queue } = await turnOn({ ackAfter: 25 }, 10);
  const final = queue.updates().at(-1);
  assert.ok(final);
  assert.equal(final.id, "teams-1"); // the id Teams gave the status post
  assert.equal(queue.posts().length, 2); // the status message, and the answer as a new message
  const answer = queue.posts().at(-1)?.message;
  assert.ok(answer && textOf(answer).includes("All green.") && answer.feedback === true);
  assert.ok(textOf(final.message) === turnEnglish.doneLine && !final.message?.feedback);
  assert.ok(!queue.posts()[0]?.message?.feedback); // never on the status message
  assert.ok(!queue.updates().some((u) => u.message?.feedback && !textOf(u.message).includes("All green.")));
});

it("test_a_status_ack_that_comes_after_the_wait_gave_up_leaves_the_answer_as_a_new_message_with_the_thumbs", async () => {
  // The id arrives after the post stopped waiting for it: there is no id to edit, the answer is a new message with the
  // thumbs, and nothing is edited afterwards.
  const { queue } = await turnOn({ ackAfter: 25, ackTimeout: 5 }, 10);
  assert.ok(queue.posts().length === 2 && queue.updates().length === 0);
  const [status, answer] = queue.posts().map((p) => p.message);
  assert.ok(!status?.feedback);
  assert.ok(answer && textOf(answer).includes("All green.") && answer.feedback === true);
});

it("test_an_ack_that_never_comes_still_ends_in_the_answer_as_a_new_message", async () => {
  const { queue, took } = await turnOn({ ackAfter: 10_000 }, 10);
  const answers = queue.posts().filter((p) => textOf(p.message).includes("All green."));
  assert.ok(answers.length === 1 && queue.updates().length === 0);
  assert.equal(answers[0]?.message?.feedback, true); // a new message, so the thumbs ride on it
  assert.ok(took <= ACK_TIMEOUT_SECONDS + 1, String(took)); // the answer is held back for the id wait, no longer
});

it("test_the_status_post_does_not_wait_for_the_typing_indicator", async () => {
  // A typing send that takes 2 s (a stale queue connection reopening) used to hold the status post back for 2 s.
  const { queue } = await turnOn({ typingTakes: 2 }, 5);
  const firstPostAt = (queue.posts()[0]?.at ?? Infinity) - new Timeline().start;
  assert.ok(firstPostAt < 0.5, String(firstPostAt));
});

it("test_a_typing_indicator_that_fails_does_not_fail_the_turn", async () => {
  const { queue, log } = await turnOn({ typingFails: true }, 1);
  const texts = queue.sent.map((s) => textOf(s.message)).join(" ");
  assert.ok(texts.includes("All green.") && !texts.includes("went wrong"));
  assert.ok(log.includes("typing indicator failed"));
});
