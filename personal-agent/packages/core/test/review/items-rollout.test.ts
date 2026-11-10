// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Claw mid-rollout (`test_review_items`' RollingClaw): an older pod answers 404 for review items, so the session is made here, and
 * a newer pod refuses that session (403 `acting_as_must_be_self`). The turn engine then calls the review's `asItem`: the review is
 * asked for once more as the reviewer's item, once only, and the asker's `pr_review` count is kept only when it starts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClawError, Guardrails } from "../../src/index.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  settleFollows,
  withItems,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const PR2 = "AMD-AGI/Hyperloom#13";
const DONE = {
  status: "done",
  prUrl: "https://github.com/AMD-AGI/Hyperloom/pull/12",
  verdict: "approve",
  merged: true,
};

async function ask(world: ReviewWorld, text: string, id = "g1"): Promise<void> {
  const message = groupMessage(text, ALICE, undefined, id);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

const requests = (world: ReviewWorld) =>
  world.claw.calls.filter((c) => c[0] === "startReviews").map((c) => c[2] as Record<string, unknown>);
const groupText = (world: ReviewWorld) => saidIn(world.surface, CONV);
const itemCards = (world: ReviewWorld) =>
  world.surface
    .of("personal:aad-a")
    .filter((r) => r.op === "post" && r.message.body.type === "view" && r.message.body.view.name === "reviewItem");

/** A Claw whose review route answers 404 (an older pod), with a limit of one review per hour when `limited`. */
function rolling(limited = false): ReviewWorld {
  const world = reviewWorld();
  if (limited)
    (world.deps as { guard: unknown }).guard = new Guardrails(
      world.clock,
      () => undefined,
      new Map([["pr_review", { count: 1, windowSeconds: 3600 }]]),
    );
  world.claw.views.set("item-1", DONE);
  return world;
}

/** Alice asks Bob; the session made here is refused by a newer pod, and the engine asks for the review as Bob's item. */
async function refusedSession(world: ReviewWorld, again: (w: ReviewWorld) => void): Promise<boolean> {
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  const [turn] = world.started;
  assert.ok(turn !== undefined, "the session was made here");
  assert.ok(turn.turn.asItem !== undefined, "a review asked of someone else can be asked again as their item");
  again(world);
  return turn.turn.asItem();
}

test("a session refused mid rollout is asked again as the reviewers item", async () => {
  const world = rolling();
  const moved = await refusedSession(world, (w) => {
    withItems(w, { seqFrom: 1 });
  });
  assert.equal(moved, true);
  await settleFollows(world);
  const [first, second, ...more] = requests(world);
  assert.equal(more.length, 0);
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(world.started.length, 1); // (the legacy session was tried, acting as Bob)
  assert.equal(world.started[0]?.review.actorUserId, "u-bob");
  assert.equal(first.actingToken, "tok-aad-b");
  assert.equal(second.actingToken, "tok-aad-b");
  assert.equal(second.actingKey, "ak-bob-linked");
  assert.equal(second.modelKey, ""); // (nothing of the asker's rides it)
  const said = groupText(world);
  assert.ok(said.includes(`${PR}（Bob 代审）：结论：批准，已合入`), said);
  assert.ok(!said.includes("rejected your linked key") && !said.includes("Something went wrong"), said);
  assert.ok(saidIn(world.surface, "personal:aad-b").includes("看板上的事项开始（事项 #1）"));
  assert.equal(itemCards(world).length, 1);
});

test("a session refused mid rollout is asked again once only", async () => {
  const world = rolling();
  const moved = await refusedSession(world, () => undefined); // (404 once more: another old pod)
  assert.equal(moved, false); // (the turn says its failure)
  const [turn] = world.started;
  assert.equal(await turn?.turn.asItem?.(), false); // (never a third time)
  await settleFollows(world);
  assert.equal(requests(world).length, 2);
  assert.equal(world.started.length, 1);
  assert.equal(itemCards(world).length, 0);
  assert.ok(!groupText(world).includes("代审）：结论"), groupText(world));
});

for (const [name, again] of [
  ["404-again", () => undefined],
  [
    "refused",
    (w: ReviewWorld) => {
      withItems(w, { seqFrom: 1 });
      w.claw.refuse.set(PR.toLowerCase(), [409, "review_in_progress", {}]);
    },
  ],
  [
    "failed",
    (w: ReviewWorld) => {
      w.claw.refuseAll = new ClawError(500, "internal");
    },
  ],
  [
    "error",
    (w: ReviewWorld) => {
      w.claw.refuseAll = new Error("boom");
    },
  ],
] as const) {
  test(`a retry that does not start gives the askers review count back (${name})`, async () => {
    const world = rolling(true);
    // (the engine takes an error on the way as "not moved")
    await refusedSession(world, again).catch(() => false);
    await settleFollows(world);
    assert.equal(requests(world).length, 2); // (asked again once, and it did not start)
    assert.ok(!groupText(world).includes("代审）：结论"), groupText(world));
    world.claw.refuse.clear();
    world.claw.refuseAll = undefined;
    withItems(world, { seqFrom: 1 });
    await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`, "g2");
    await settleFollows(world);
    assert.equal(requests(world).length, 3);
    assert.ok(!groupText(world).includes("上限"), groupText(world));
    assert.ok(groupText(world).includes(`${PR}（Bob 代审）：结论：批准，已合入`), groupText(world));
  });
}

test("a retry that starts keeps the askers review count", async () => {
  const world = rolling(true);
  assert.equal(
    await refusedSession(world, (w) => {
      withItems(w, { seqFrom: 1 });
    }),
    true,
  );
  await settleFollows(world);
  assert.ok(groupText(world).includes(`${PR}（Bob 代审）：结论：批准，已合入`), groupText(world));
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR2}`, "g2");
  assert.equal(requests(world).length, 2);
  assert.ok(groupText(world).includes("上限"), groupText(world));
});
