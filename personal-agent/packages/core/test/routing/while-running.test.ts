// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Ported from teams/tests/test_message_while_running.py: messages sent while a turn runs (the router's queue). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALICE } from "./fixtures.js";
import { link, message, said, world } from "./world.js";

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test("test_a_second_message_is_queued_in_claw_and_answered_after_the_first", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const first = gate();
  w.turns.hold = first.promise;
  w.turns.answers = ["first answer", "second answer"];
  await w.router.handle(message("first"));
  await w.router.handle(message("second"));
  first.open();
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [
    ["create", "ak", "first"],
    ["send", "ak", "sess-ak", "second"],
  ]);
  assert.deepEqual(said(w), ["first answer", "second answer"]);
  assert.equal(w.router.hasPersonalTurn(ALICE.id), false);
});

test("test_one_message_at_most_waits", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const first = gate();
  w.turns.hold = first.promise;
  await w.router.handle(message("first"));
  await w.router.handle(message("second"));
  await w.router.handle(message("third"));
  first.open();
  await w.router.settled();
  assert.equal(w.turns.calls.length, 2);
  assert.ok(said(w)[0]?.startsWith("One message is already waiting behind the running task"));
});

test("test_a_message_sent_before_the_first_reached_claw_goes_to_the_same_session", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const reached = gate();
  w.turns.holdBeforeRunning = reached.promise;
  await w.router.handle(message("first"));
  const second = w.router.handle(message("second")); // (waits for the first to run in Claw)
  w.turns.holdBeforeRunning = undefined;
  reached.open();
  await second;
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [
    ["create", "ak", "first"],
    ["send", "ak", "sess-ak", "second"],
  ]);
});

test("a message whose turn in front never starts running in time is refused", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const never = gate();
  w.turns.holdBeforeRunning = never.promise;
  await w.router.handle(message("first"));
  const second = w.router.handle(message("second"));
  while (w.clock.pending === 0) await new Promise((resolve) => setImmediate(resolve)); // (until it waits)
  await w.clock.advance(15_000);
  await second;
  assert.deepEqual(said(w), ["I am still working on your previous message. Send /stop to interrupt it."]);
  never.open();
  await w.router.settled();
});

test("test_stop_says_the_waiting_message_runs_next", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const first = gate();
  w.turns.hold = first.promise;
  await w.router.handle(message("first"));
  await w.router.handle(message("second"));
  await w.router.handle(message("/stop"));
  first.open();
  await w.router.settled();
  assert.ok(
    said(w).includes(
      "Stopping the running task. The message you sent after it runs next; send /stop again to interrupt that one too.",
    ),
  );
});

test("test_a_message_is_not_queued_behind_a_review_for_a_colleague", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const first = gate();
  w.turns.hold = first.promise;
  const chat = w.router.chat(ALICE, w.surface.conversation(message("x").conversation));
  await w.router.startTurn({
    chat,
    credential: "tok",
    text: "review",
    messageId: "r1",
    clientPlatform: "",
    review: {
      itemId: "it-1",
      itemSessionId: "s-review",
      pull: "o/r#1",
      model: "",
      lang: "en",
      fields: { kind: "review" },
      onSession: () => undefined,
      after: () => Promise.resolve(),
    },
  });
  await w.router.handle(message("chat on")); // (the review has a session of its own: the chat is free)
  first.open();
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [
    ["send", "tok", "s-review", "review"],
    ["create", "ak", "chat on"],
  ]);
  assert.equal(w.store.sessions.getSession(ALICE.id), "sess-ak"); // (the review's session is not the chat's)
});
