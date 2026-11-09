// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A run the worker already answered in the chat raises no completion card of its own (teams/tests/test_no_duplicate_card.py).
// The chat turn is the turn engine's: here it is what the turn engine records of it in the store (started, delivered with the
// message it answered, ended without an answer), which is all the delivery of a run's notification reads.
import assert from "node:assert/strict";
import { it } from "node:test";

import type { JsonObject } from "../../src/json.js";
import { pythonIsoUtc } from "../../src/proactive/proactive.js";
import { sentViews } from "../../../../test-support/assistant/proactive-chat.js";
import { advanceSeconds } from "../../../../test-support/store.js";
import { ALICE, link, world } from "./world.js";

const SESSION = "sess-ak-alice";

/** Claw's notification of a run of `sessionId` that finished at `at` (Python `completed`). */
function completed(sessionId: string, at: number, kind = "run.completed", messageId?: string): JsonObject {
  return {
    event_id: `ev-${sessionId}-${String(at)}`,
    type: kind,
    occurred_at: pythonIsoUtc(at),
    user_id: "u",
    session_id: sessionId,
    task_id: "t1",
    trigger_id: null,
    title: "Run completed",
    summary: "",
    link: "/x",
    ...(messageId === undefined ? {} : { message_id: messageId }),
  };
}

function start() {
  const w = world();
  link(w.store, "ak-alice");
  const deliver = (event: JsonObject) => w.proactive.handle(ALICE, w.reference, event);
  /** The run's cards (the ones with Show here). */
  const cards = () => sentViews(w.surface.outbox).filter((v) => v.name === "runEvent");
  /** A chat turn in the session whose answer reached the chat. */
  const answered = (messageId?: string) => {
    w.store.turns.turnStarted(SESSION, { prompt: "do it", ...(messageId ? { messageId } : {}) });
    w.store.turns.turnDelivered(SESSION, messageId ? { messageId } : {});
  };
  return { ...w, deliver, cards, answered };
}

it("answered turn drops the event", async () => {
  const w = start();
  const startedAt = w.store.now();
  w.answered();
  advanceSeconds(w.clock, 90); // the run finished while the turn was streaming: the card arrives later
  assert.equal(await w.deliver(completed(SESSION, startedAt)), "dropped");
  assert.deepEqual(w.cards(), []);
});

it("event for a run that started elsewhere after the turn still shows a card", async () => {
  const w = start();
  w.answered();
  advanceSeconds(w.clock, 3600); // a later run (web console, trigger) in the same session
  assert.equal(await w.deliver(completed(SESSION, w.store.now())), "delivered");
  assert.equal(w.cards().length, 1);
});

it("turn that lost its stream leaves the card", async () => {
  const w = start();
  w.store.turns.turnStarted(SESSION, { prompt: "do it" });
  w.store.turns.turnNotDelivered(SESSION); // the turn ended as "lost the connection": nothing was delivered
  assert.equal(await w.deliver(completed(SESSION, w.store.now())), "delivered");
  assert.equal(w.cards().length, 1);
});

it("turn that hit its deadline leaves the card", async () => {
  const w = start();
  w.store.turns.turnStarted(SESSION, { prompt: "do it" });
  w.store.turns.turnNotDelivered(SESSION); // the chat stopped following the turn ("still running")
  assert.equal(await w.deliver(completed(SESSION, w.store.now())), "delivered");
  assert.equal(w.cards().length, 1);
});

it("event before delivery is recorded waits for the turn then is dropped", async () => {
  const w = start();
  w.store.turns.turnStarted(SESSION, { prompt: "do it" });
  const event = completed(SESSION, w.store.now() + 1);
  const first = w.deliver(event); // the race: the card is first; not consumed yet
  await w.clock.advance(4000);
  assert.equal(await first, "retry");
  w.store.turns.turnDelivered(SESSION);
  assert.equal(await w.deliver(event), "dropped"); // the sender's retry
  assert.deepEqual(w.cards(), []);
});

it("event during a turn that then fails is shown on the retry", async () => {
  const w = start();
  w.store.turns.turnStarted(SESSION, { prompt: "do it" });
  const event = completed(SESSION, w.store.now() + 1);
  const first = w.deliver(event);
  await w.clock.advance(4000);
  assert.equal(await first, "retry");
  w.store.turns.turnNotDelivered(SESSION);
  assert.equal(await w.deliver(event), "delivered");
  assert.equal(w.cards().length, 1);
});

it("event while the turn posts its answer is dropped at once", async () => {
  const w = start();
  w.store.turns.turnStarted(SESSION, { prompt: "do it" });
  let outcome: string | undefined;
  const notified = w.deliver(completed(SESSION, w.store.now() + 1)).then((o) => (outcome = o));
  await w.clock.advance(300); // the notification is in, the turn has not posted its answer yet
  assert.equal(outcome, undefined);
  w.store.turns.turnDelivered(SESSION);
  await w.clock.advance(200); // well inside the settle wait: no retry is asked for
  assert.equal(outcome, "dropped");
  await notified;
  assert.deepEqual(w.cards(), []);
});

it("held notice answered in chat meanwhile is not released", async () => {
  const w = start();
  w.store.held.holdEvent(ALICE, completed(SESSION, w.store.now()));
  w.answered();
  const before = w.surface.outbox.length;
  await w.release.release(ALICE);
  assert.equal(w.surface.outbox.length - before, 0);
});

it("stale running turn from a dead worker does not mute the session", async () => {
  const w = start();
  w.store.turns.turnStarted(SESSION, { prompt: "do it" }); // the worker restarted mid-turn: no delivery was ever recorded
  advanceSeconds(w.clock, 3 * 3600);
  assert.equal(await w.deliver(completed(SESSION, w.store.now())), "delivered");
});

it("other session shows its card", async () => {
  const w = start();
  w.answered();
  assert.equal(await w.deliver(completed("some-other-session", w.store.now())), "delivered");
  assert.equal(w.cards().length, 1);
});

it("a failed run whose answer was delivered is also dropped but an errored turn is not", async () => {
  const w = start();
  w.store.turns.turnStarted(SESSION, { prompt: "do it" });
  w.store.turns.turnNotDelivered(SESSION); // the turn's result was an error: no answer was delivered
  assert.equal(await w.deliver(completed(SESSION, w.store.now(), "run.failed")), "delivered");
});

it("a later turn cannot claim the event of an earlier failed turn", () => {
  const w = start();
  const earlierRun = w.store.now() - 1;
  w.store.turns.turnStarted(SESSION);
  advanceSeconds(w.clock, 30); // turn B starts 30 s after the run of turn A finished
  assert.equal(w.store.turns.answeredInChat(SESSION, { finishedAt: earlierRun, runningMax: 1920, slack: 60 }), null);
});

it("a run that closes long after its delivered answer is still that turns run", async () => {
  const w = start();
  w.answered("m1");
  advanceSeconds(w.clock, 85);
  assert.equal(await w.deliver(completed(SESSION, w.store.now(), "run.completed", "m1")), "dropped");
  assert.deepEqual(w.cards(), []);
});

it("a run of another message in the same session still shows its card", async () => {
  const w = start();
  w.answered("m1");
  advanceSeconds(w.clock, 5); // within the clock-skew slack, but the run is of a message sent elsewhere (the web console)
  assert.equal(await w.deliver(completed(SESSION, w.store.now(), "run.completed", "m-web")), "delivered");
  assert.equal(w.cards().length, 1);
});
