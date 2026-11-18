// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Following a review asked of someone else for its asker when things go wrong (`github_review.py`'s `_watch_batch`,
 * `_view_of`, `resume_follows`): the asker's binding gone ends the follow and its record; a moment's trouble with the identity
 * service is read again; a view Claw no longer shows the asker ends it; a record a later worker cannot read is let go.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClawError, err, type JsonObject } from "../../src/index.js";
import { GithubReview } from "../../src/review/service/github-review.js";
import { SeededRandom } from "../../../../test-support/random.js";
import {
  ALICE_DM,
  handoffEvent,
  handoffWorld,
  settleFollows,
  type HandoffWorld,
} from "../../../../test-support/review-world.js";

const LINK = "https://github.com/AMD-AGI/Hyperloom/pull/12";
const DONE = { status: "done", prUrl: LINK, verdict: "approve", merged: true };
const RUNNING = { status: "in_progress", prUrl: "" };

async function handedBack(world: HandoffWorld): Promise<void> {
  world.action.take("aad-a", handoffEvent());
  await world.action.idle();
}

const follows = (world: HandoffWorld) => world.store.reviewDelegation.askerFollows();
const told = (world: HandoffWorld) =>
  world.surface
    .of(ALICE_DM)
    .flatMap((r) => (r.op === "send" && r.message.body.type === "text" ? [r.message.body.text] : []))
    .filter((t) => t.includes("（Bob 代审）"));

test("the askers binding gone ends the follow and its record", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", [RUNNING, DONE]);
  await handedBack(world);
  world.bound.delete("aad-a");
  await settleFollows(world, 5);
  assert.deepEqual(follows(world), []);
  assert.deepEqual(told(world), []);
});

test("a moment's trouble with the identity service is read again", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", [DONE]);
  await handedBack(world);
  const exchange = world.deps.exchange as { tokenFor: HandoffWorld["deps"]["exchange"]["tokenFor"] };
  const real = exchange.tokenFor;
  exchange.tokenFor = (userId) =>
    userId === "aad-a" ? Promise.resolve(err({ kind: "exchange_failed" as const, reason: "down" })) : real(userId);
  await world.clock.advance(30_000);
  await world.clock.advance(30_000);
  assert.equal(follows(world).length, 1); // (still followed)
  exchange.tokenFor = real;
  await settleFollows(world);
  assert.equal(told(world).length, 1);
  assert.deepEqual(follows(world), []);
});

for (const status of [403, 404]) {
  test(`a view claw no longer shows the asker ends the follow (${String(status)})`, async () => {
    const world = handoffWorld();
    world.claw.views.set("item-1", [RUNNING]);
    await handedBack(world);
    const port = world.deps.claw.workItems;
    (port as { requesterView: typeof port.requesterView }).requesterView = () => Promise.reject(new ClawError(status));
    await settleFollows(world, 5);
    assert.deepEqual(follows(world), []);
    assert.deepEqual(told(world), []);
  });
}

test("a record a later worker cannot read is let go", () => {
  const world = handoffWorld();
  world.store.reviewDelegation.addAskerFollow({
    itemId: "item-x",
    batchId: "item-x",
    review: { requester_aad: 7 },
    reference: { conversation: { id: ALICE_DM } },
    deadline: world.store.now() + 3600,
  });
  const fresh = new GithubReview(world.deps, new SeededRandom(7), () => Promise.resolve());
  assert.equal(fresh.resume(), 0);
  assert.deepEqual(follows(world), []);
});

test("a record whose chat a later worker cannot read is let go", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", [{ status: "waiting_for_reviewer", prUrl: LINK, verdict: "approve", merged: false }]);
  await handedBack(world);
  const [row] = follows(world);
  assert.ok(row);
  world.store.reviewDelegation.dropAskerFollow(row.itemId);
  world.store.reviewDelegation.addAskerFollow({ ...row, review: row.review as JsonObject, reference: {} });
  const fresh = new GithubReview(world.deps, new SeededRandom(7), () => Promise.resolve());
  assert.equal(fresh.resume(), 0);
  assert.deepEqual(follows(world), []);
});
