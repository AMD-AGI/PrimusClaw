// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// One approval is one card (teams/tests/test_approval_dedupe.py): the turn's own card and Claw's approval.requested notification
// never show the same (session, tool_use_id) twice, and a card that never reached the chat does not use the approval up. The turn
// is what the turn engine does with an approval it shows (`turnApprovalsFor`: recorded with its card before the send, marked sent
// after it, given back when the send fails); the notification goes through the proactive delivery, both over one real store.
import assert from "node:assert/strict";
import { it } from "node:test";

import { EXPIRES_KEY } from "../../src/proactive/proactive.js";
import { approvalEvent } from "../../../../test-support/assistant/approval-presses.js";
import {
  Gate,
  approvalCards,
  gateApprovalCards,
  turnShowsApproval,
} from "../../../../test-support/assistant/proactive-chat.js";
import { openTestStore } from "../../../../test-support/store.js";
import { ALICE, at, link, world } from "../proactive/world.js";

const SESSION = "sess-ak-alice"; // what the fake Claw names Alice's first session

function notification(toolUseId = "tu1", expiresAt?: string) {
  return approvalEvent({ sessionId: SESSION, toolUseId, ...(expiresAt ? { expiresAt } : {}) });
}

function two() {
  const w = world({ now: at(12) });
  link(w.store, "ak-alice");
  const conversation = () => w.deps.conversationFor(w.reference);
  const push = (ev = notification()) => w.proactive.handle(ALICE, w.reference, ev);
  const turn = (toolUseId = "tu1", more: { send?: boolean; fails?: boolean } = {}) =>
    turnShowsApproval(w.store, conversation(), { userId: ALICE, sessionId: SESSION, toolUseId, ...more });
  const cards = () => approvalCards(w.surface.outbox);
  return { ...w, push, turn, cards };
}

const save = (store: ReturnType<typeof openTestStore>["store"], sessionId: string, toolUseId: string) =>
  store.approvals.saveApproval({ userId: ALICE, sessionId, toolUseId, tool: "bash", expiresAt: store.now() + 600 });

it("the store says whether this call recorded the approval", () => {
  const { store } = openTestStore();
  assert.equal(save(store, "s1", "tu1"), true);
  assert.equal(save(store, "s1", "tu1"), false); // the same approval again
  assert.equal(save(store, "s1", "tu2"), true); // another one in the same session
  assert.equal(save(store, "s2", "tu1"), true); // the same id in another session
});

it("a forgotten approval can be recorded again but an answered one cannot", () => {
  const { store } = openTestStore();
  save(store, "s1", "tu1");
  store.approvals.forgetApproval("s1", "tu1");
  assert.equal(store.approvals.getApproval("s1", "tu1"), null);
  assert.equal(save(store, "s1", "tu1"), true);
  store.approvals.closeApproval("s1", "tu1", "decided");
  store.approvals.forgetApproval("s1", "tu1"); // answered meanwhile: the record stays, so the answer is not offered again
  assert.equal(store.approvals.getApproval("s1", "tu1")?.state, "decided");
  assert.equal(save(store, "s1", "tu1"), false);
});

it("the notification for an approval the turn already showed sends no second card", async () => {
  const w = two();
  assert.equal(await w.turn(), true);
  assert.deepEqual(w.cards(), ["tu1"]);
  assert.equal(w.store.approvals.getApproval(SESSION, "tu1")?.userId, ALICE); // 1:1 turns record too
  const sent = w.surface.outbox.length;
  assert.equal(await w.push(), "dropped");
  assert.equal(w.surface.outbox.length, sent);
});

it("once the notifications card is sent a second notification for it is dropped not asked again", async () => {
  const w = two();
  assert.equal(await w.push(), "delivered");
  assert.equal(w.store.approvals.approvalInFlight(SESSION, "tu1"), false); // sent: no longer in flight
  assert.equal(await w.push(), "dropped");
  assert.deepEqual(w.cards(), ["tu1"]);
});

it("a notification that got there first leaves the turn with no card of its own", async () => {
  const w = two();
  assert.equal(await w.push(), "delivered");
  assert.equal(await w.turn(), false); // the turn saw the same approval and said nothing
  assert.deepEqual(w.cards(), ["tu1"]);
  assert.equal(w.store.approvals.getApproval(SESSION, "tu1")?.state, "pending");
});

it("a second approval in the same turn still gets its card", async () => {
  const w = two();
  await w.turn("tu1");
  await w.turn("tu2");
  assert.deepEqual(w.cards(), ["tu1", "tu2"]);
  assert.equal(await w.push(notification("tu2")), "dropped");
  assert.equal(await w.push(notification("tu3")), "delivered");
});

it("the same tool use id in another session is another approval", async () => {
  const w = two();
  await w.turn();
  const other = approvalEvent({ sessionId: "some-other-session", toolUseId: "tu1" });
  assert.equal(await w.push(other), "delivered");
  assert.equal(w.cards().length, 2);
});

it("a notification held in quiet hours is not shown after the turn showed the approval", async () => {
  const w = two();
  w.store.prefs.setQuiet(ALICE, ["22:00", "08:00"]);
  w.clock.setEpochMs(at(23) * 1000); // quiet hours: the notification is held, the turn's card is not
  assert.equal(await w.push(notification("tu1", "2026-10-28T00:30:00Z")), "held");
  await w.turn();
  assert.equal(w.cards().length, 1);
  w.clock.setEpochMs(at(8, 5, 28) * 1000);
  await w.release.releaseDue();
  assert.equal(w.cards().length, 1); // nothing new at the release: it had been shown
});

it("a notification for an approval the turn showed is dropped not held in quiet hours", async () => {
  const w = two();
  await w.turn();
  w.store.prefs.setQuiet(ALICE, ["22:00", "08:00"]);
  w.clock.setEpochMs(at(23) * 1000); // quiet hours now: a notification would be held for later
  assert.equal(await w.push(notification("tu1", "2026-10-28T00:30:00Z")), "dropped");
  assert.deepEqual(w.store.held.usersWithHeld(), []); // nothing is kept for a card that is already on the phone
});

it("the send says when it sent nothing and the handler says dropped when it lost a race", async () => {
  const w = two();
  w.store.approvals.saveApproval({
    userId: ALICE,
    sessionId: SESSION,
    toolUseId: "tu1",
    tool: "bash",
    expiresAt: w.store.now() + 600,
  }); // shown by the turn
  const send = (toolUseId: string) =>
    w.proactive.deliveries.send(ALICE, w.reference, {
      ...notification(toolUseId),
      [EXPIRES_KEY]: w.store.now() + 600,
    });
  assert.equal(await send("tu1"), false);
  assert.deepEqual(w.cards(), []);
  assert.equal(await send("tu9"), true);
  assert.equal(w.cards().length, 1);
  // the turn records it between the handler's look and its send: the handler's answer is "dropped", and nothing is sent
  w.store.approvals.getApproval = () => null;
  assert.equal(await w.push(notification("tu1")), "dropped");
  assert.equal(w.cards().length, 1);
});

it("the store knows which cards are being sent", () => {
  const { store } = openTestStore();
  assert.equal(store.approvals.approvalInFlight("s1", "tu1"), false);
  assert.equal(save(store, "s1", "tu1"), true);
  assert.equal(store.approvals.approvalInFlight("s1", "tu1"), true);
  assert.equal(store.approvals.approvalInFlight("s1", "tu2"), false);
  assert.equal(save(store, "s1", "tu1"), false); // a repeat does not start another send
  store.approvals.approvalSent("s1", "tu1");
  assert.equal(store.approvals.approvalInFlight("s1", "tu1"), false);
  assert.equal(store.approvals.getApproval("s1", "tu1")?.state, "pending");
  save(store, "s1", "tu2");
  store.approvals.forgetApproval("s1", "tu2");
  assert.equal(store.approvals.approvalInFlight("s1", "tu2"), false);
  assert.equal(store.approvals.getApproval("s1", "tu2"), null);
});

it("a notification that arrives while the turns card is being sent is asked again and then dropped", async () => {
  const w = two();
  const gate = new Gate();
  gateApprovalCards(w.surface, gate.pass);
  const turn = w.turn(); // the turn is inside its send of the card
  assert.equal(w.store.approvals.approvalInFlight(SESSION, "tu1"), true);
  assert.deepEqual(w.cards(), []);
  const inFlight = await w.push(); // not consumed while it could still be the only way
  gate.open();
  await turn;
  assert.deepEqual([inFlight, await w.push()], ["retry", "dropped"]); // dropped once shown
  assert.deepEqual(w.cards(), ["tu1"]);
  assert.equal(w.store.approvals.approvalInFlight(SESSION, "tu1"), false);
});

it("if that card then fails the notification the sender asks again with shows it", async () => {
  const w = two();
  const gate = new Gate();
  const restore = gateApprovalCards(w.surface, gate.pass);
  const conversation = w.deps.conversationFor(w.reference);
  const turn = turnShowsApprovalThatMayFail(w, conversation);
  const inFlight = await w.push();
  gate.fail(new Error("the queue is down")); // the send fails: the turn gives the approval back and ends
  await turn;
  assert.equal(w.store.approvals.getApproval(SESSION, "tu1"), null);
  assert.equal(w.store.approvals.approvalInFlight(SESSION, "tu1"), false);
  restore();
  assert.deepEqual([inFlight, await w.push()], ["retry", "delivered"]);
  assert.deepEqual(w.cards(), ["tu1"]);
});

/** The turn's send of its card, which gives the approval back when the send fails (what the turn engine does). */
async function turnShowsApprovalThatMayFail(
  w: ReturnType<typeof two>,
  conversation: ReturnType<ReturnType<typeof two>["deps"]["conversationFor"]>,
) {
  try {
    await turnShowsApproval(w.store, conversation, { userId: ALICE, sessionId: SESSION, toolUseId: "tu1" });
  } catch {
    w.store.approvals.forgetApproval(SESSION, "tu1");
  }
}

it("a notification card that could not be sent leaves the approval to the retry", async () => {
  const w = two();
  let refusals = 1;
  gateApprovalCards(w.surface, () => {
    if (refusals === 0) return Promise.resolve();
    refusals -= 1;
    return Promise.reject(new Error("the queue is down"));
  });
  await assert.rejects(w.push(), /the queue is down/);
  assert.equal(w.store.approvals.getApproval(SESSION, "tu1"), null); // nobody saw it, so it is not recorded as shown
  assert.equal(await w.push(), "delivered"); // the sender's retry
  assert.deepEqual(w.cards(), ["tu1"]);
  assert.equal(w.store.approvals.getApproval(SESSION, "tu1")?.state, "pending");
});

it("a turn card that could not be sent leaves the approval to the notification", async () => {
  const w = two();
  assert.equal(await w.turn("tu1", { fails: true }), false); // the turn fails on the card: it says so, and goes on its way
  assert.equal(w.store.approvals.getApproval(SESSION, "tu1"), null);
  assert.equal(await w.push(), "delivered");
  assert.deepEqual(w.cards(), ["tu1"]);
});
