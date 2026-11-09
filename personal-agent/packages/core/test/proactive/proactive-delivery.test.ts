// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What follows a run's notification and what still reaches a person after their turn gave up (teams/tests/test_changes_card.py,
// "the same card under a finished run's notification"; teams/tests/test_turn_deadline.py). Reading the session's changes and
// drawing their card is the turns' (`RunFollowUps.offerChanges`, W4b): here it is a fake that shows a "changes" card when it has
// one, and records what it was asked with.
import assert from "node:assert/strict";
import { it } from "node:test";

import { ClawError, ClawUnreachable } from "../../src/claw/errors.js";
import type { JsonObject } from "../../src/json.js";
import { pythonIsoUtc } from "../../src/proactive/proactive.js";
import { approvalEvent } from "../../../../test-support/assistant/approval-presses.js";
import { BOB, approvalCards, referenceOf, sentViews } from "../../../../test-support/assistant/proactive-chat.js";
import { advanceSeconds } from "../../../../test-support/store.js";
import { ALICE, at, event, link, world } from "../../../../test-support/assistant/proactive-world.js";

/** Alice linked, Bob only known by his chat; `changes` says whether the session's sandbox still has its changes. */
function two(changes: boolean | Error = true) {
  const w = world({ now: at(12) });
  link(w.store, "ak-alice");
  w.store.references.saveReference(BOB, referenceOf(BOB));
  w.store.prefs.setQuiet(ALICE, ["22:00", "08:00"]);
  const asked: [string, string][] = [];
  w.runs.offerChanges = async (key, sessionId, conversation) => {
    asked.push([key, sessionId]);
    if (changes instanceof Error) throw changes; // (a failure to read or show them: the run's card stays delivered)
    if (!changes) return; // (nothing to show)
    await conversation.send({
      body: { type: "view", view: { name: "changes", model: { sessionId } } as never, fallbackText: "" },
    });
  };
  const push = (userId: string, ev: JsonObject) =>
    w.proactive.handle(userId, w.store.references.getReference(userId) ?? referenceOf(userId), ev);
  const kinds = () => sentViews(w.surface.outbox).map((v) => v.name);
  return { ...w, asked, push, kinds };
}

it("a finished runs card is followed by the changes card", async () => {
  const w = two();
  assert.equal(await w.push(ALICE, event("run.completed", "ev-1", { session_id: "s-web" })), "delivered");
  assert.deepEqual(w.kinds(), ["runEvent", "changes"]);
  assert.deepEqual(w.asked, [["ak-alice", "s-web"]]);
  const [, changes] = sentViews(w.surface.outbox);
  assert.deepEqual(changes?.model, { sessionId: "s-web" }); // (its Create PR carries the run's session)
});

it("a changes card that cannot be had leaves the runs card delivered", async () => {
  const failures = [false, new ClawError(500), new ClawUnreachable("timeout", "changes"), new Error("x")] as const;
  for (const failure of failures) {
    const w = two(failure);
    const what = failure === false ? "none" : failure.message;
    assert.equal(await w.push(ALICE, event("run.completed", "ev-1", { session_id: "s-web" })), "delivered", what);
    assert.deepEqual(w.kinds(), ["runEvent"], what);
  }
});

it("only a run that completed asks for changes", async () => {
  for (const kind of ["run.failed", "trigger.paused"]) {
    const w = two();
    await w.push(ALICE, event(kind, "ev-1", { session_id: "s-web" }));
    assert.deepEqual(w.asked, [], kind);
    assert.equal(w.surface.outbox.length, 1, kind);
  }
});

it("a user with no linked key gets the runs card and no call", async () => {
  const w = two();
  assert.equal(await w.push(BOB, event("run.completed", "ev-1", { user_id: "u-bob" })), "delivered");
  assert.deepEqual(w.kinds(), ["runEvent"]);
  assert.deepEqual(w.asked, []);
});

it("a run held for quiet hours asks for its changes when it is released", async () => {
  const w = two();
  w.clock.setEpochMs(at(23) * 1000);
  assert.equal(await w.push(ALICE, event("run.completed", "ev-1", { session_id: "s-web" })), "held");
  assert.deepEqual(w.asked, []);
  assert.equal(w.surface.outbox.length, 0);
  w.clock.setEpochMs(at(8, 5, 28) * 1000);
  await w.release.releaseDue();
  assert.deepEqual(w.kinds(), ["runEvent", "changes"]);
});

it("an approval after the deadline still reaches the phone", async () => {
  const w = two();
  w.store.turns.turnStarted("sess-ak-alice", { prompt: "do it" });
  w.store.turns.turnNotDelivered("sess-ak-alice"); // the turn's time was up: the chat stopped following it, the run goes on
  advanceSeconds(w.clock, 31 * 60);
  const ev = approvalEvent({
    sessionId: "sess-ak-alice",
    toolUseId: "late-1",
    expiresAt: pythonIsoUtc(w.store.now() + 20 * 60),
  });
  assert.equal(await w.push(ALICE, ev), "delivered");
  assert.deepEqual(approvalCards(w.surface.outbox), ["late-1"]);
  assert.equal(w.store.approvals.getApproval("sess-ak-alice", "late-1")?.state, "pending");
});
