// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One Claw notification subscription per linked person, and with the assistant on its record is not taken on trust
 * (tests/test_subscriptions.py, and the subscription half of tests/test_assistant.py). On the real store.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ALICE, AssistantWorld, BOB } from "../../../../test-support/assistant/assistant-world.js";
import { ClawError } from "../../src/claw/errors.js";
import { APPROVAL_SOURCES, APPROVALS_TYPES_VERSION } from "../../src/subscriptions/event-types.js";
import { RETRY_SECONDS, UPGRADE_RETRY_SECONDS } from "../../src/subscriptions/subscriptions.js";
import type { FakeClawSubscriptions } from "../../../../test-support/assistant/subscription-fakes.js";

const APPROVAL_SUBSCRIPTION_TYPES = [
  "run.completed",
  "run.failed",
  "assistant.say",
  "work_item.needs_you",
  "approval.requested",
];

/** Claw answers `list` (or `updateTypes`) with `error` while the switch returned is on; the call is still counted. */
function breakList(claw: FakeClawSubscriptions, error: Error): { on: boolean } {
  const state = { on: true };
  const real = claw.list.bind(claw);
  claw.list = (key) => {
    if (!state.on) return real(key);
    claw.calls.push(`list ${key}`);
    return Promise.reject(error);
  };
  return state;
}

function breakPatch(claw: FakeClawSubscriptions, error: Error): { on: boolean } {
  const state = { on: true };
  const real = claw.updateTypes.bind(claw);
  claw.updateTypes = (key, id, types, options) => {
    if (!state.on) return real(key, id, types, options);
    claw.calls.push(`patch ${key}`);
    return Promise.reject(error);
  };
  return state;
}

function aliceRow(w: AssistantWorld) {
  const [row] = w.subsClaw.of("ak-alice");
  assert.ok(row);
  return row;
}

it("a subscription made before gets one patch and keeps its secret", async () => {
  const w = await AssistantWorld.start({ assistant: false }); // made by the worker as it was
  const made = w.store.notifySubs.getNotifySub(ALICE);
  assert.ok(made);
  w.turn(true); // the switch is turned on, some time after the subscription was made
  w.advance(UPGRADE_RETRY_SECONDS + 1);
  await w.say("hello");
  const row = aliceRow(w);
  assert.deepEqual([row.event_types, row.sources], [APPROVAL_SUBSCRIPTION_TYPES, APPROVAL_SOURCES]);
  assert.equal(w.store.notifySubs.notifyTypesVersion(ALICE), APPROVALS_TYPES_VERSION);
  assert.deepEqual(w.store.notifySubs.getNotifySub(ALICE), made);
  assert.equal(w.store.notifySubs.notifySubByRoute(made.route)?.secret, row.secret);
  assert.deepEqual(w.heard(), ["hello"], "the very message that found it behind");
  await w.say("again");
  assert.equal(w.subCalls("patch"), 1, "once, not every message");
});

it("a patch that fails is tried again after ten minutes and not on every message", async () => {
  const w = await AssistantWorld.start({ assistant: false });
  w.turn(true);
  w.advance(UPGRADE_RETRY_SECONDS + 1);
  const broken = breakPatch(w.subsClaw, new ClawError(503));
  for (const n of [0, 1, 2]) await w.say(`m${String(n)}`);
  assert.deepEqual(w.started, ["m0", "m1", "m2"]);
  assert.equal(w.subCalls("patch"), 1);
  broken.on = false;
  w.advance(UPGRADE_RETRY_SECONDS + 1);
  await w.say("later");
  assert.deepEqual(w.heard(), ["later"]);
  assert.equal(w.subCalls("patch"), 2);
});

it("a subscription claw no longer knows is made again at once", async () => {
  const w = await AssistantWorld.start({ assistant: false });
  const oldRoute = w.store.notifySubs.getNotifySub(ALICE)?.route;
  w.subsClaw.rows.clear(); // deleted in the console
  w.turn(true);
  w.advance(UPGRADE_RETRY_SECONDS + 1);
  await w.say("one"); // looked at: gone; made again, with the types, and that very message goes to the assistant
  assert.notEqual(w.store.notifySubs.getNotifySub(ALICE)?.route, oldRoute);
  assert.equal(w.store.notifySubs.notifyTypesVersion(ALICE), APPROVALS_TYPES_VERSION);
  assert.deepEqual(w.heard(), ["one"]);
  assert.equal(w.subsClaw.rows.size, 1);
});

it("a subscription deleted in claw after the upgrade is noticed within ten minutes and made again", async () => {
  const w = await AssistantWorld.start();
  const oldRoute = w.store.notifySubs.getNotifySub(ALICE)?.route;
  await w.say("one");
  w.subsClaw.rows.clear(); // deleted in the console: no reply can reach the person any more
  w.advance(5 * 60);
  await w.say("two"); // (not looked at yet: it was looked at when it was made)
  assert.equal(w.subCalls("list"), 1, "the one look is the stale check when it was made");
  assert.deepEqual(w.heard(), ["one", "two"]);
  w.advance(UPGRADE_RETRY_SECONDS);
  await w.say("three");
  assert.notEqual(w.store.notifySubs.getNotifySub(ALICE)?.route, oldRoute);
  assert.equal(w.subsClaw.rows.size, 1);
  assert.equal(w.heard().at(-1), "three");
  assert.deepEqual(aliceRow(w).event_types, APPROVAL_SUBSCRIPTION_TYPES);
});

it("a subscription claw turned off after failed deliveries is turned on again", async () => {
  const w = await AssistantWorld.start();
  aliceRow(w).enabled = false;
  w.advance(UPGRADE_RETRY_SECONDS + 1);
  await w.say("hello");
  assert.equal(aliceRow(w).enabled, true);
  assert.deepEqual(w.heard(), ["hello"]);
  assert.equal(w.subCalls("patch"), 1);
});

it("a subscription that lost the assistants types gets them back and is not turned on for that", async () => {
  const w = await AssistantWorld.start();
  aliceRow(w).event_types = ["run.completed"]; // edited in the console
  const enables: (boolean | undefined)[] = [];
  const real = w.subsClaw.updateTypes.bind(w.subsClaw);
  w.subsClaw.updateTypes = (key, id, types, options) => {
    enables.push(options?.enable);
    return real(key, id, types, options);
  };
  w.advance(UPGRADE_RETRY_SECONDS + 1);
  await w.say("hello");
  assert.deepEqual(aliceRow(w).event_types, APPROVAL_SUBSCRIPTION_TYPES);
  assert.deepEqual(enables, [false]);
  assert.deepEqual(w.heard(), ["hello"]);
});

it("a subscription that is right is only looked at and not more often than every ten minutes", async () => {
  const w = await AssistantWorld.start();
  const [lists, patches] = [w.subCalls("list"), w.subCalls("patch")];
  for (const n of [0, 1, 2]) await w.say(`m${String(n)}`);
  assert.deepEqual(
    [w.subCalls("list"), w.subCalls("patch")],
    [lists, patches],
    "inside the ten minutes: nothing asked",
  );
  w.advance(UPGRADE_RETRY_SECONDS + 1);
  await w.say("later");
  assert.deepEqual([w.subCalls("list"), w.subCalls("patch")], [lists + 1, patches]);
  assert.equal(w.heard().at(-1), "later");
  await w.say("and again");
  assert.equal(w.subCalls("list"), lists + 1);
});

it("claw not answering the look does not take the user off the assistant", async () => {
  const w = await AssistantWorld.start();
  breakList(w.subsClaw, new ClawError(503));
  w.advance(UPGRADE_RETRY_SECONDS + 1);
  await w.say("hello");
  assert.deepEqual(w.heard(), ["hello"]);
  assert.equal(w.store.notifySubs.notifyTypesVersion(ALICE), APPROVALS_TYPES_VERSION);
});

for (const fault of ["no notifications on Claw (404)", "Claw refuses the types (400)"]) {
  it(`a subscription that cannot be got right takes the user back to sessions until it can (${fault})`, async () => {
    const w = await AssistantWorld.start();
    let broken: { on: boolean } | undefined;
    if (fault.startsWith("no")) broken = breakList(w.subsClaw, new ClawError(404));
    else {
      aliceRow(w).event_types = ["run.completed"];
      w.subsClaw.knownTypes = new Set(["run.completed", "run.failed", "approval.requested"]); // Claw was rolled back
    }
    w.advance(UPGRADE_RETRY_SECONDS + 1);
    await w.say("one");
    assert.deepEqual([w.started, w.heard()], [["one"], []]);
    assert.equal(w.store.notifySubs.notifyTypesVersion(ALICE), 0, "no reply could reach them");
    if (broken) broken.on = false;
    for (const t of ["assistant.say", "work_item.needs_you", "assistant.action"]) w.subsClaw.knownTypes.add(t);
    w.advance(UPGRADE_RETRY_SECONDS + 1);
    await w.say("two");
    assert.deepEqual(w.heard(), ["two"]);
    assert.equal(w.store.notifySubs.notifyTypesVersion(ALICE), APPROVALS_TYPES_VERSION);
  });
}

it("lazy creation for a user linked before", async () => {
  const w = await AssistantWorld.start({ assistant: false, link: false });
  w.store.links.redeemPending(ALICE, "A", w.store.links.stashPending("ak-alice"));
  w.store.links.setClawUserId(ALICE, "u-alice");
  assert.equal(w.store.notifySubs.getNotifySub(ALICE), null);
  await w.subs?.ensure(ALICE); // (the router does this for every message of a linked person)
  assert.ok(w.store.notifySubs.getNotifySub(ALICE));
  assert.equal(w.subsClaw.of("ak-alice").length, 1);
  await w.subs?.ensure(ALICE); // and only once
  assert.equal(w.subCalls("create"), 1);
});

it("unlink deletes the subscription and the secret", async () => {
  const w = await AssistantWorld.start({ assistant: false });
  await w.link(BOB);
  const made = w.store.notifySubs.getNotifySub(ALICE);
  assert.ok(made);
  await w.subs?.remove(ALICE, "ak-alice");
  assert.equal(w.subCalls("delete"), 1);
  assert.deepEqual(w.subsClaw.of("ak-alice"), []);
  assert.equal(w.store.notifySubs.getNotifySub(ALICE), null);
  assert.equal(w.store.notifySubs.notifySubByRoute(made.route), null);
  assert.ok(w.store.notifySubs.getNotifySub(BOB), "Bob's is untouched");
  assert.equal(w.subsClaw.of("ak-bob").length, 1);
});

it("relinking makes a fresh subscription for the new key", async () => {
  const w = await AssistantWorld.start({ assistant: false });
  const first = w.store.notifySubs.getNotifySub(ALICE);
  w.store.links.redeemPending(ALICE, ALICE, w.store.links.stashPending("ak-alice2"));
  await w.subs?.ensure(ALICE);
  assert.notEqual(w.store.notifySubs.getNotifySub(ALICE)?.route, first?.route);
  assert.equal(w.subsClaw.of("ak-alice2").length, 1);
});

it("a 404 on the route is skipped and retried at most daily", async () => {
  const w = await AssistantWorld.start({ assistant: false, link: false });
  const broken = breakList(w.subsClaw, new ClawError(404));
  await w.link(ALICE); // still linked
  assert.equal(w.store.links.getKey(ALICE), "ak-alice");
  assert.equal(w.store.notifySubs.getNotifySub(ALICE), null);
  assert.equal(w.subCalls("list"), 1);
  await w.subs?.ensure(ALICE);
  w.advance(RETRY_SECONDS - 10);
  await w.subs?.ensure(ALICE);
  assert.equal(w.subCalls("list"), 1, "inside the day: no new call");
  broken.on = false;
  w.advance(20);
  await w.subs?.ensure(ALICE);
  assert.equal(w.subCalls("list"), 2);
  assert.ok(w.store.notifySubs.getNotifySub(ALICE), "Claw turned it on: created");
});
