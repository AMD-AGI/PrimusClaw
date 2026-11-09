// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every person the assistant is on for is subscribed to what their assistant's tasks hold for them, whether or not they have
 * written since the worker started (tests/test_item_approvals.py, the subscription half).
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ALICE, AssistantWorld, BOB, CAROL, DAVE } from "../../../../test-support/assistant/assistant-world.js";
import {
  APPROVAL_SOURCES,
  APPROVALS_TYPES_VERSION,
  ASSISTANT_TYPES_VERSION,
} from "../../src/subscriptions/event-types.js";
import { UPGRADE_RETRY_SECONDS } from "../../src/subscriptions/subscriptions.js";

const LISTED = [ALICE, BOB, CAROL];
const APPROVAL_SUBSCRIPTION_TYPES = [
  "run.completed",
  "run.failed",
  "assistant.say",
  "work_item.needs_you",
  "approval.requested",
];

function rowOf(w: AssistantWorld, key: string) {
  const [row] = w.subsClaw.of(key);
  assert.ok(row, key);
  return row;
}

it("every listed person gets the assistants events and its approvals without writing first", async () => {
  const w = await AssistantWorld.start({ assistant: false, link: false, users: LISTED }); // linked while the switch was off
  for (const aad of [ALICE, BOB, CAROL, DAVE]) await w.link(aad);
  assert.deepEqual(
    [ALICE, BOB, CAROL, DAVE].map((a) => w.store.notifySubs.notifyTypesVersion(a)),
    [0, 0, 0, 0],
  );
  w.turn(true); // the switch is turned on; nobody writes
  w.advance(UPGRADE_RETRY_SECONDS + 1);
  assert.equal(await w.subs?.ensureAll(), 3);
  for (const [key, aad] of [
    ["ak-alice", ALICE],
    ["ak-bob", BOB],
    ["ak-carol", CAROL],
  ] as const) {
    const row = rowOf(w, key);
    assert.deepEqual([row.event_types, row.sources], [APPROVAL_SUBSCRIPTION_TYPES, APPROVAL_SOURCES]);
    assert.equal(w.store.notifySubs.notifyTypesVersion(aad), APPROVALS_TYPES_VERSION);
    assert.equal(w.chat.on(aad), true);
  }
  assert.deepEqual(rowOf(w, "ak-dave").event_types, ["run.completed", "run.failed"]);
  assert.equal(w.chat.on(DAVE), false, "not listed");
  assert.deepEqual([w.heard(), w.surface.outbox], [[], []], "nobody was written to for it");
  const calls = w.subsClaw.calls.length;
  assert.equal(await w.subs?.ensureAll(), 3);
  assert.equal(w.subsClaw.calls.length, calls, "inside the ten minutes nobody's subscription is asked about again");
});

it("a claw without the work items source keeps the person on the assistant and is asked again", async () => {
  const w = await AssistantWorld.start({ itemApprovals: false });
  const row = rowOf(w, "ak-alice");
  assert.ok(!row.event_types.includes("approval.requested"));
  assert.equal(w.store.notifySubs.notifyTypesVersion(ALICE), ASSISTANT_TYPES_VERSION);
  assert.equal(w.chat.on(ALICE), true);
  w.subsClaw.knownSources.add("assistant_item"); // Claw is upgraded: the next look mends it, with nobody writing
  w.advance(UPGRADE_RETRY_SECONDS + 1);
  await w.subs?.ensureAll();
  assert.deepEqual([row.event_types, row.sources], [APPROVAL_SUBSCRIPTION_TYPES, APPROVAL_SOURCES]);
  assert.equal(w.store.notifySubs.notifyTypesVersion(ALICE), APPROVALS_TYPES_VERSION);
});
