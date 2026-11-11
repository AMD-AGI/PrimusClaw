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

const QUEUED_1 =
  "Got it. I am still working on your previous message; this one is queued and runs as soon as that is done. " +
  "/stop stops the running task and drops what is queued.";

/** Until every message handled so far is queued (a queued turn waits on its own, not in `handle`). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("test_a_second_message_is_queued_in_claw_and_answered_after_the_first", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const first = gate();
  w.turns.hold = first.promise;
  w.turns.answers = ["first answer", "second answer"];
  await w.router.handle(message("first"));
  await w.router.handle(message("second")); // (returns once it is queued and the person is told so)
  assert.deepEqual(said(w), [QUEUED_1]);
  assert.deepEqual(w.turns.calls, [["create", "ak", "first"]]); // (it goes to Claw only once the first is over)
  first.open();
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [
    ["create", "ak", "first"],
    ["send", "ak", "sess-ak", "second"],
  ]);
  assert.deepEqual(said(w), [QUEUED_1, "first answer", "second answer"]);
  assert.equal(w.router.hasPersonalTurn(ALICE.id), false);
});

test("up to five messages wait behind the running one, each told its place, and run in the order they were sent", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const first = gate();
  w.turns.hold = first.promise;
  w.turns.answers = ["a0", "a1", "a2", "a3", "a4", "a5", "a6"];
  for (const text of ["m0", "m1", "m2", "m3", "m4", "m5", "m6"]) await w.router.handle(message(text));
  const told = said(w);
  assert.equal(told.length, 6);
  assert.equal(told[0], QUEUED_1);
  assert.equal(
    told[4],
    "Got it. This one is queued as number 5; they run in order once your previous message is done. " +
      "/stop stops the running task and drops what is queued.",
  );
  assert.equal(
    told[5],
    "5 messages already wait behind the running task, so this one was not queued. Send it once they have run, or /stop " +
      "to stop the running task and drop the queue.",
  );
  first.open();
  await w.router.settled();
  assert.deepEqual(
    w.turns.calls.map((c) => c.at(-1)),
    ["m0", "m1", "m2", "m3", "m4", "m5"],
  );
  assert.deepEqual(said(w).slice(6), ["a0", "a1", "a2", "a3", "a4", "a5"]);
  assert.equal(w.router.hasPersonalTurn(ALICE.id), false);
});

test("test_a_message_sent_before_the_first_reached_claw_goes_to_the_same_session", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const reached = gate();
  w.turns.holdBeforeRunning = reached.promise;
  await w.router.handle(message("first"));
  await w.router.handle(message("second")); // (queued behind the first, which has no session yet)
  w.turns.holdBeforeRunning = undefined;
  reached.open();
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [
    ["create", "ak", "first"],
    ["send", "ak", "sess-ak", "second"],
  ]);
});

test("a message whose turn in front is slow to start running waits for it and is not refused", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const slow = gate();
  w.turns.holdBeforeRunning = slow.promise;
  await w.router.handle(message("first"));
  await w.router.handle(message("second"));
  await w.clock.advance(60_000); // (the 15 s the router once gave the turn in front is long gone)
  await flush();
  assert.deepEqual(said(w), [QUEUED_1]);
  w.turns.holdBeforeRunning = undefined;
  slow.open();
  await w.router.settled();
  assert.deepEqual(
    w.turns.calls.map((c) => c.at(-1)),
    ["first", "second"],
  );
});

test("/stop stops the running turn and gives up every message queued behind it", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const first = gate();
  w.turns.hold = first.promise;
  await w.router.handle(message("first"));
  await w.router.handle(message("second"));
  await w.router.handle(message("third"));
  await w.router.handle(message("/stop"));
  assert.equal(said(w).at(-1), "Stopping the running task. The 2 messages queued behind it were dropped too.");
  assert.deepEqual(w.claw.calls.at(-1), ["interrupt", "ak", "sess-ak"]);
  first.open();
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [["create", "ak", "first"]]); // (neither queued message reached Claw)
  assert.equal(said(w).at(-1), "Stopped.");
  assert.equal(w.router.hasPersonalTurn(ALICE.id), false);
  w.turns.hold = undefined;
  await w.router.handle(message("after")); // (the chat takes messages again at once)
  await w.router.settled();
  assert.deepEqual(w.turns.calls.at(-1), ["send", "ak", "sess-ak", "after"]);
});

test("a message sent after /stop goes to Claw at once, even while the stopped turn has not ended", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const first = gate();
  w.turns.hold = first.promise; // (a turn stopped before Claw ran it may never report its end)
  await w.router.handle(message("first"));
  await w.router.handle(message("/stop"));
  const second = gate();
  w.turns.hold = second.promise;
  await w.router.handle(message("after"));
  await flush();
  assert.deepEqual(
    w.turns.calls.map((c) => c.at(-1)),
    ["first", "after"],
  );
  await w.router.handle(message("/stop")); // (stops the turn that runs now, not the one stopped already)
  assert.equal(said(w).at(-1), "Stopping the running task.");
  assert.equal(w.turns.runs.length, 2);
  await w.router.handle(message("third")); // (both turns in front are stopped: it goes at once too)
  await flush();
  assert.deepEqual(
    w.turns.calls.map((c) => c.at(-1)),
    ["first", "after", "third"],
  );
  first.open();
  second.open();
  await w.router.settled();
  assert.equal(w.router.hasPersonalTurn(ALICE.id), false);
});

test("one message queued and /stop says it was dropped, in the chat's language", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  w.store.prefs.learnLang(ALICE.id, "zh");
  const first = gate();
  w.turns.hold = first.promise;
  await w.router.handle(message("第一条"));
  await w.router.handle(message("第二条"));
  await w.router.handle(message("/stop"));
  first.open();
  await w.router.settled();
  assert.deepEqual(said(w).slice(0, 2), [
    "收到。我还在处理你上一条消息，这条已排在后面，上一条处理完就接着处理它。发 /stop 会停下正在运行的任务，并撤回排队的消息。",
    "正在停止运行中的任务。排在后面的那条消息也一起撤回了。",
  ]);
  assert.equal(w.turns.calls.length, 1);
});

test("in a group chat a sender's second message is queued behind their first, not refused", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  const first = gate();
  w.turns.hold = first.promise;
  w.turns.answers = ["first answer", "second answer"];
  await w.router.handle(message("first", { kind: "group" }));
  await w.router.handle(message("second", { kind: "group" }));
  assert.deepEqual(said(w), [QUEUED_1]);
  first.open();
  await w.router.settled();
  assert.deepEqual(
    w.turns.calls.map((c) => c.at(-1)),
    ["first", "second"],
  );
  assert.deepEqual(said(w), [QUEUED_1, "first answer", "second answer"]);
  assert.ok(w.turns.runs.every((r) => r.group));
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
      fields: {
        kind: "review",
        turn: {
          actingAs: "u-reviewer",
          reviewTarget: { owner: "o", repo: "r", number: 1 },
          modelKey: "ak",
          reviewModel: "",
          reviewOnly: false,
          attach: true,
          attachMessageId: "",
          lead: "",
          mention: undefined,
          shapeAnswer: (answer) => answer,
          onGithubResult: () => undefined,
        },
      },
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
