// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The buttons of a pushed approval card (teams/tests/test_proactive_ux.py, "the decision button"): the card is pushed by the
// proactive delivery over a real store, then pressed. Claw is called with the clicker's own key, only for the person it was pushed
// to, once, and only while it is in time. How a settled press is drawn (the card replaced in place, the line said in a new
// message) is the router's and the views': here it is the view and the line the decision settles with.
import assert from "node:assert/strict";
import { it } from "node:test";

import { ClawError, ClawUnreachable } from "../../src/claw/errors.js";
import {
  DecidingClaw,
  approvalDecisions,
  approvalEvent,
  buttonData,
  press,
  saidOf,
  settledAs,
  settledModel,
} from "../../../../test-support/assistant/approval-presses.js";
import { BOB, linkUser, referenceOf } from "../../../../test-support/assistant/proactive-chat.js";
import { ALICE, at, link, world } from "../proactive/world.js";

function two() {
  const w = world({ now: at(12) });
  link(w.store, "ak-alice");
  linkUser(w.store, BOB, "Bob", "ak-bob");
  const claw = new DecidingClaw();
  const decisions = approvalDecisions(w.store, claw);
  const pressed = (userId: string, data: Record<string, unknown>) => press(decisions, w.store, userId, data as never);
  const push = (userId: string, ev: Record<string, unknown>) =>
    w.proactive.handle(userId, w.store.references.getReference(userId) ?? referenceOf(userId), ev as never);
  const decided = () => claw.calls.filter((c) => c[0] === "decide");
  return { ...w, claw, pressed, push, decided };
}

it("expired approval is refused and claw is not called", async () => {
  const w = two();
  const ev = approvalEvent({ expiresAt: "2026-10-27T04:10:00Z" }); // 12:10 Shanghai
  assert.equal(await w.push(ALICE, ev), "delivered");
  w.clock.setEpochMs(at(12, 10) * 1000);
  const [expired] = await w.pressed(ALICE, buttonData(ev));
  assert.deepEqual(w.decided(), []);
  assert.equal(settledAs(expired), "view:approvalExpired"); // the card becomes "Expired"
  assert.ok(saidOf(expired).includes("run out and was refused"), saidOf(expired)); // ... and a line says so
  w.clock.setEpochMs(at(12, 1) * 1000); // even going back in time cannot revive it: it was closed
  await w.pressed(ALICE, buttonData(ev));
  assert.deepEqual(w.decided(), []);
});

it("a click just before the deadline is accepted", async () => {
  const w = two();
  const ev = approvalEvent({ expiresAt: "2026-10-27T04:10:00Z" });
  await w.push(ALICE, ev);
  w.clock.setEpochMs((at(12, 10) - 1) * 1000);
  await w.pressed(ALICE, buttonData(ev));
  assert.deepEqual(w.decided(), [["decide", "ak-alice", "s-trig", "tu1", "allow"]]);
});

it("approve calls claw with the clickers own key and updates the card in place", async () => {
  const w = two();
  const ev = approvalEvent();
  await w.push(ALICE, ev);
  const [settled, ...more] = await w.pressed(ALICE, buttonData(ev, "allow"));
  assert.deepEqual(w.decided(), [["decide", "ak-alice", "s-trig", "tu1", "allow"]]);
  assert.deepEqual(more, []);
  assert.equal(settledAs(settled), "view:approvalDecided"); // "✅ Approved (you, 12:00)"
  assert.deepEqual(settledModel(settled), {
    tool: "workload_stop",
    action: "allow",
    when: at(12),
    zone: "Asia/Shanghai",
  });
  assert.ok(saidOf(settled).startsWith("Approved: "), saidOf(settled));
  assert.equal(w.store.approvals.getApproval("s-trig", "tu1")?.state, "decided");
});

it("deny sends deny", async () => {
  const w = two();
  const ev = approvalEvent();
  await w.push(ALICE, ev);
  await w.pressed(ALICE, buttonData(ev, "deny"));
  assert.deepEqual(w.decided(), [["decide", "ak-alice", "s-trig", "tu1", "deny"]]);
});

it("bob cannot answer alices approval and alices key is never used for him", async () => {
  const w = two();
  const ev = approvalEvent();
  await w.push(ALICE, ev);
  const forwarded = buttonData(ev); // Alice's card, forwarded to Bob
  const [refused] = await w.pressed(BOB, forwarded);
  assert.deepEqual(w.decided(), []);
  assert.ok(saidOf(refused).includes("no longer active"), saidOf(refused));
  assert.equal(w.store.approvals.getApproval("s-trig", "tu1")?.state, "pending"); // Bob did not use it up either
  await w.pressed(ALICE, forwarded);
  assert.deepEqual(
    w.decided().map((c) => c[1]),
    ["ak-alice"],
  );
});

it("every decide call carries the key of whoever clicked", async () => {
  const w = two();
  const alice = approvalEvent({ eventId: "a", toolUseId: "ta" });
  const bob = approvalEvent({ eventId: "b", toolUseId: "tb", userId: "u-bob", sessionId: "s-bob" });
  await w.push(ALICE, alice);
  await w.push(BOB, bob);
  await w.pressed(BOB, buttonData(bob));
  await w.pressed(ALICE, buttonData(alice));
  assert.deepEqual(
    w.decided().map((c) => c.slice(0, 2)),
    [
      ["decide", "ak-bob"],
      ["decide", "ak-alice"],
    ],
  );
});

it("a forged card naming someone elses approval is refused", async () => {
  const w = two();
  const ev = approvalEvent();
  await w.push(ALICE, ev);
  const forged = { ...buttonData(ev), action: "allow" };
  await w.pressed(BOB, forged);
  w.store.sessions.setSession(BOB, { sessionId: "s-trig" }); // even if Bob's own session had the same id, it is Alice's
  await w.pressed(BOB, forged);
  assert.deepEqual(w.decided(), []);
});

it("an unknown action is refused", async () => {
  const w = two();
  const ev = approvalEvent();
  await w.push(ALICE, ev);
  await w.pressed(ALICE, { ...buttonData(ev), action: "always_allow" });
  assert.deepEqual(w.decided(), []);
});

it("double tap calls claw once", async () => {
  const w = two();
  const ev = approvalEvent();
  await w.push(ALICE, ev);
  await w.pressed(ALICE, buttonData(ev));
  const [again] = await w.pressed(ALICE, buttonData(ev));
  assert.equal(w.decided().length, 1);
  assert.ok(saidOf(again).includes("already answered"), saidOf(again));
});

it("claw saying the approval is gone turns the card into expired", async () => {
  const w = two();
  const ev = approvalEvent();
  await w.push(ALICE, ev);
  w.claw.fail = new ClawError(404);
  const [settled] = await w.pressed(ALICE, buttonData(ev));
  assert.equal(settledAs(settled), "view:approvalExpired");
  assert.ok(saidOf(settled) !== ""); // (said in a new message as well)
  assert.equal(w.store.approvals.getApproval("s-trig", "tu1")?.state, "expired");
});

it("a transient claw error leaves the approval answerable", async () => {
  const w = two();
  const ev = approvalEvent();
  await w.push(ALICE, ev);
  w.claw.fail = new ClawError(503);
  const [failed] = await w.pressed(ALICE, buttonData(ev));
  assert.ok(saidOf(failed).includes("error 503"), saidOf(failed));
  assert.equal(w.store.approvals.getApproval("s-trig", "tu1")?.state, "pending");
  w.claw.fail = undefined;
  await w.pressed(ALICE, buttonData(ev));
  assert.equal(w.store.approvals.getApproval("s-trig", "tu1")?.state, "decided");
});

it("a network failure on the decision leaves the approval answerable", async () => {
  const w = two();
  const ev = approvalEvent();
  await w.push(ALICE, ev);
  w.claw.fail = new ClawUnreachable("network", "decide");
  const [failed] = await w.pressed(ALICE, buttonData(ev));
  assert.ok(saidOf(failed).includes("could not reach"), saidOf(failed));
  assert.equal(w.store.approvals.getApproval("s-trig", "tu1")?.state, "pending");
  w.claw.fail = undefined;
  await w.pressed(ALICE, buttonData(ev));
  assert.equal(w.store.approvals.getApproval("s-trig", "tu1")?.state, "decided");
});
