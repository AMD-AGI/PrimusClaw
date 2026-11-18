// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run the worker already answered in the chat raises no completion card (test_no_duplicate_card.py, the turn record's
 * side): what a turn records through `turnRecorder`, and how the store matches Claw's notification of the run to it.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { openFileTestStore, openTestStore } from "../../../../test-support/store.js";
import { turnRecorder } from "../../src/turn/records.js";

const RUNNING_MAX = 1920;
const SLACK = 60;

function harness() {
  const { store, clock } = openTestStore();
  const now = (): number => clock.epochMs() / 1000;
  const answered = (finishedAt: number, messageId?: string) =>
    store.turns.answeredInChat("s1", {
      finishedAt,
      runningMax: RUNNING_MAX,
      slack: SLACK,
      ...(messageId === undefined ? {} : { messageId }),
    });
  return { store, now, answered };
}

it("test_a_turn_queued_behind_another_learns_its_message_id_on_delivery", () => {
  const { now, answered, store } = harness();
  const record = turnRecorder(store.turns, "do it", "");
  record("s1", "started", ""); // Claw queued the message: no id yet
  record("s1", "delivered", "m2");
  const finished = now() + 600;
  assert.equal(answered(finished, "m2"), "delivered");
  assert.equal(answered(finished, "m1"), null);
  assert.equal(answered(finished), null); // a Claw that names no message: the clock decides, as before
});

it("test_a_later_turn_in_the_session_does_not_unmatch_an_earlier_answered_run", () => {
  // The person writes again while Claw is still closing the first run: the second message is queued, the second turn
  // replaces the first one's row, and the first run's notification arrives after the second answer.
  const { now, answered, store } = harness();
  turnRecorder(store.turns, "first", "")("s1", "started", "m1");
  turnRecorder(store.turns, "first", "")("s1", "delivered", "m1");
  const firstClosed = now() + 80;
  const second = turnRecorder(store.turns, "second", "");
  second("s1", "started", ""); // queued: no id yet
  assert.equal(answered(firstClosed, "m1"), "delivered");
  second("s1", "delivered", "m2");
  assert.equal(answered(firstClosed, "m1"), "delivered");
  assert.equal(answered(firstClosed, "m2"), "delivered");
  assert.equal(answered(firstClosed, "m-web"), null);
});

it("test_an_earlier_turn_that_finishes_after_a_later_one_started_leaves_the_later_ones_record_alone", () => {
  // Turn B is sent (and queued by Claw) while turn A's answer is still going out: A's end must not write into B's record.
  const { now, answered, store } = harness();
  const a = turnRecorder(store.turns, "first", "turn-a");
  const b = turnRecorder(store.turns, "second", "turn-b");
  a("s1", "started", "m1");
  b("s1", "started", "");
  a("s1", "delivered", "m1");
  const later = now() + 30;
  assert.equal(answered(later, "m1"), "delivered"); // A's run: answered
  assert.equal(answered(later, "m2"), "running"); // B's run: B is still answering it
  a("s1", "failed", ""); // (a stray end of A changes nothing either)
  assert.equal(answered(later), "running");
  b("s1", "failed", ""); // B ended with no answer: its run's card is wanted
  assert.equal(answered(later), null);
  assert.equal(answered(later, "m2"), null);
});

it("test_a_queued_turn_takes_its_message_id_into_its_record_on_delivery", () => {
  // The row learns the id on delivery: a run of another message that closes inside the clock-skew slack of the answer is
  // not this turn's.
  const opened = openFileTestStore();
  try {
    const { store, raw, clock } = opened;
    const now = (): number => clock.epochMs() / 1000;
    const record = turnRecorder(store.turns, "do it", "");
    record("s1", "started", ""); // Claw queued the message: no id yet
    record("s1", "delivered", "m2");
    const row = raw.prepare("SELECT message_id FROM turn_answers WHERE session_id = 's1'").get();
    assert.equal(row?.["message_id"], "m2");
    const run = { finishedAt: now() + 5, runningMax: RUNNING_MAX, slack: SLACK };
    assert.equal(store.turns.answeredInChat("s1", { ...run, messageId: "m-web" }), null);
    assert.equal(store.turns.answeredInChat("s1", run), "delivered"); // (no id named: the clock, as before)
  } finally {
    opened.close();
  }
});

it("test_the_same_message_is_answered_whenever_its_run_closes_even_when_delivery_named_no_id", () => {
  // A turn that knew its id when it started, delivered by a path that names none: `answered_messages` has nothing, and
  // only the row's id says the run is this turn's.
  const opened = openFileTestStore();
  try {
    const { store, raw, clock } = opened;
    const now = (): number => clock.epochMs() / 1000;
    turnRecorder(store.turns, "do it", "")("s1", "started", "m1");
    store.turns.turnDelivered("s1");
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM answered_messages").get()?.["n"], 0);
    const at = (finishedAt: number, messageId?: string) =>
      store.turns.answeredInChat("s1", {
        finishedAt,
        runningMax: RUNNING_MAX,
        slack: SLACK,
        ...(messageId === undefined ? {} : { messageId }),
      });
    assert.equal(at(now() + 85, "m1"), "delivered");
    assert.equal(at(now() + 85), null); // by the clock alone it is too late
    // ... and a run of the same message stamped (clock skew) before the turn started is the same run
    assert.equal(at(now() - 30, "m1"), "delivered");
  } finally {
    opened.close();
  }
});
