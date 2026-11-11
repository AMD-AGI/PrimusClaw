// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock } from "../../../../test-support/clock.js";
import {
  ActiveTurn,
  chatTurnKey,
  Latch,
  QUEUED_TURNS_MAX,
  reviewTurnKey,
  TurnRegistry,
} from "../../src/routing/turn-registry.js";

test("a chat has its running turn and up to five queued behind it; a review queues behind nothing", () => {
  const turns = new TurnRegistry();
  const chat = chatTurnKey("u1");
  const first = new ActiveTurn();
  assert.ok(turns.claim(chat, first));
  first.launched = true; // (as the starter does once it sends it)
  assert.equal(turns.claim(chat, new ActiveTurn()), false);
  const second = new ActiveTurn();
  assert.deepEqual(turns.enqueue(chat, second), { front: first, waiting: 1 });
  for (let n = 2; n <= QUEUED_TURNS_MAX; n += 1) {
    assert.deepEqual(turns.enqueue(chat, new ActiveTurn()), { front: first, waiting: n });
  }
  assert.equal(turns.enqueue(chat, new ActiveTurn()), "queue_full");
  assert.equal(turns.enqueue(chat, new ActiveTurn(true)), "still_working");
  assert.equal(turns.of(chat).length, 1 + QUEUED_TURNS_MAX);
  assert.equal(turns.withdrawQueued(chat), QUEUED_TURNS_MAX);
  assert.ok(second.over && second.ended.isSet);
  assert.deepEqual(turns.of(chat), [first]);
  assert.deepEqual(turns.enqueue(chat, second), { front: first, waiting: 1 });
  second.launched = true; // (a turn that went to Claw is not withdrawn, nor counted as waiting)
  const third = new ActiveTurn();
  assert.deepEqual(turns.enqueue(chat, third), { front: first, waiting: 1 });
  assert.equal(turns.withdrawQueued(chat), 1);
  assert.deepEqual(turns.of(chat), [first, second]);
  turns.drop(chat, first);
  assert.ok(first.running.isSet && first.ended.isSet);
  assert.deepEqual(turns.of(chat), [second]);
  assert.equal(turns.withdrawQueued(chat), 0); // (the running turn is not given up)
  turns.drop(chat, second);
  assert.equal(turns.has(chat), false);
  turns.drop(chat, second); // (a turn dropped twice is a no-op)
  const fresh = new ActiveTurn();
  assert.deepEqual(turns.enqueue(chat, fresh), { front: fresh, waiting: 0 }); // (a chat with no turn: it is the first)
});

test("a review is kept per item (or per pull request) beside the chat turn, and counted with it", () => {
  const turns = new TurnRegistry();
  turns.claim(chatTurnKey("u1"), new ActiveTurn());
  const review = new ActiveTurn(true, "item-9");
  turns.claim(reviewTurnKey("u1", "", "item-9", "o/r#1"), review);
  turns.claim(reviewTurnKey("u1", "g1", "", "O/R#2"), new ActiveTurn(true));
  turns.claim(chatTurnKey("u2", "g1"), new ActiveTurn());
  assert.equal(turns.countFor("u1"), 3);
  assert.deepEqual([...turns.reviewItemsOf("u1")], ["item-9"]);
  assert.equal(turns.size, 4);
  assert.equal(turns.enqueue(reviewTurnKey("u1", "", "item-9", "x"), new ActiveTurn(true)), "still_working");
  turns.itemStopped("item-9");
  turns.itemStopped("");
  assert.ok(review.stopRequested && review.stopConfirmed);
  assert.equal(reviewTurnKey("u", "", "", "O/R#2").review, "pull:o/r#2");
});

test("a message queued behind a turn waits for it to run, at most as long as it is given", async () => {
  const clock = new FakeClock();
  const latch = new Latch();
  const waited = latch.wait(15_000, clock);
  latch.set();
  latch.set();
  assert.equal(await waited, true);
  assert.equal(await latch.wait(1, clock), true); // (already set)
  const late = new Latch();
  const timedOut = late.wait(15_000, clock);
  await clock.advance(15_000);
  assert.equal(await timedOut, false);
  const ended = new Latch();
  const whenSet = ended.whenSet();
  ended.set();
  await whenSet;
  await ended.whenSet(); // (already set)
});
