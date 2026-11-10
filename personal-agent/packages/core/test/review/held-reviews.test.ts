// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review Claw holds for the reviewer, posted with his account on someone else's request (`test_github_review`'s held review
 * tests): the same one card as a merge, with what will be posted on it, and the same answer, told as a review's, never a merge's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALICE, CONV, TOKEN, reviewWorld } from "../../../../test-support/review-world.js";
import {
  ClawError,
  REVIEW,
  REVIEW_ITEM,
  ask,
  bobUnreachable,
  cards,
  confirmation,
  decisions,
  groupText,
  held,
  NOTHING,
  press,
  row,
} from "./held-world.js";

const heldReview = (changes: Record<string, unknown> = {}, world = reviewWorld()) =>
  held({ ...REVIEW_ITEM, ...changes }, world);
const reviewButtons = (text: string) => text.includes("确认发布") && text.includes("不发布");

for (const event of ["APPROVE", "REQUEST_CHANGES", "COMMENT"]) {
  test(`a review held for the reviewer is one card to him alone with what will be posted (${event})`, async () => {
    const world = await heldReview({ review: { ...REVIEW, event } });
    const [card, ...more] = cards(world, "personal:aad-b");
    assert.equal(more.length, 0);
    assert.deepEqual(card?.review, { event, body: "The retry loop never stops. Please bound it.", comments: 2 });
    assert.equal(card.title, "Change the release workflow");
    assert.equal(card.author, "carol-gh");
    assert.equal(card.requester, "Alice");
    assert.deepEqual(cards(world, CONV), []);
    assert.deepEqual(cards(world, "personal:aad-a"), []);
    const group = groupText(world);
    assert.ok(
      group.includes(`${event} review`) && group.includes("已私信 Bob 请其确认") && group.includes("确认之前不会发布"),
      group,
    );
    const stored = row(world);
    assert.deepEqual(
      [stored?.kind, stored?.event, stored?.actorId, stored?.requesterId, stored?.state],
      ["review", event, "aad-b", "aad-a", "pending"],
    );
    assert.deepEqual(decisions(world), []); // nothing is posted until he presses a button
    assert.ok(world.claw.calls.some((c) => c[0] === "confirmations" && c[1] === "tok-aad-a"));
  });
}

test("the same held review is never sent twice and a merge of the same turn is a card of its own", async () => {
  const world = await heldReview();
  await ask(world, "g2");
  assert.equal(cards(world, "personal:aad-b").length, 1);
  world.claw.confirmations = [confirmation({ id: "cf-1", ...REVIEW_ITEM }), confirmation({ id: "cf-2" })];
  await ask(world, "g3");
  const [first, second] = cards(world, "personal:aad-b");
  assert.notEqual(first?.review, undefined);
  assert.equal(second?.review, undefined);
  assert.deepEqual(
    ["cf-1", "cf-2"].map((id) => [row(world, id)?.kind, row(world, id)?.event]),
    [
      ["review", "REQUEST_CHANGES"],
      ["merge", ""],
    ],
  );
});

const NOT_OFFERED: [string, Record<string, unknown>][] = [
  ["not the reviewer", { actor_user_id: "u-mallory" }],
  ["no review", { review: null }],
  ["review as text", { review: "REQUEST_CHANGES" }],
  ["no event", { review: { body: "x", comments: [] } }],
  ["unknown event", { review: { ...REVIEW, event: "DISMISS" } }],
  ["event as list", { review: { ...REVIEW, event: ["APPROVE"] } }],
  ["unknown kind", { kind: "comment" }],
  ["null kind", { kind: null }],
  ["number kind", { kind: 7 }],
];

for (const [name, changes] of NOT_OFFERED) {
  test(`a review that is not the reviewers or that a card cannot show is not offered (${name})`, async () => {
    const world = await heldReview(changes);
    assert.deepEqual(cards(world, "personal:aad-b"), []);
    assert.equal(row(world), null);
    assert.ok(!groupText(world).includes("已私信") && !groupText(world).includes("没有发布"));
  });
}

for (const [name, kind] of [
  ["merge", {}],
  ["review", REVIEW_ITEM],
] as const) {
  for (const [what, changes] of [
    ["another number", { pr: 13 }],
    ["another repository", { repo: "AMD-AGI/Other" }],
  ] as const) {
    test(`a confirmation for another pull request is ignored and the group is not told of it (${name}, ${what})`, async () => {
      const world = await held({ ...kind, ...changes });
      assert.deepEqual(cards(world, "personal:aad-b"), []);
      assert.equal(row(world), null);
      assert.ok(!groupText(world).includes("已私信") && !groupText(world).includes("没有合入"));
    });
  }
}

test("a confirmation without a kind is a merge even when it carries a review", async () => {
  const world = await held({ review: REVIEW });
  const [card] = cards(world, "personal:aad-b");
  assert.equal(card?.review, undefined);
  assert.deepEqual([row(world)?.kind, row(world)?.event], ["merge", ""]);
});

test("a held review that cannot be delivered says so and posts nothing", async () => {
  const world = reviewWorld();
  bobUnreachable(world);
  await heldReview({}, world);
  const group = groupText(world);
  assert.ok(group.includes("没有发布") && !group.includes("没有合入"), group);
  assert.equal(row(world), null);
  assert.deepEqual(decisions(world), []);
});

test("only the reviewers click posts the review and it is made with their own credential", async () => {
  const world = await heldReview();
  const [alice = NOTHING] = await press(world, "allow", ALICE);
  assert.deepEqual(decisions(world), []);
  assert.equal(row(world)?.state, "pending");
  assert.ok(alice.text.includes("Only the person this was asked of"), alice.text);
  assert.ok(alice.text.includes("Review needs confirmation") && reviewButtons(alice.text), alice.text);
  world.claw.decision = {
    status: "submitted",
    review_id: 77,
    url: "https://github.com/AMD-AGI/Hyperloom/pull/12#pullrequestreview-77",
  };
  const [bob = NOTHING] = await press(world, "allow");
  assert.deepEqual(decisions(world), [["tok-aad-b", "cf-1", "allow"]]);
  assert.ok(bob.text.includes("Posted the REQUEST_CHANGES review on AMD-AGI/Hyperloom#12."), bob.text);
  assert.ok(!bob.text.includes("erge"));
  const group = groupText(world);
  assert.ok(
    group.includes("已确认") && group.includes("REQUEST_CHANGES review 已发布") && !group.includes("合入"),
    group,
  );
  assert.equal(row(world)?.state, "done");
});

test("do not post drops the review and the group hears that", async () => {
  const world = await heldReview();
  world.claw.decision = { status: "denied" };
  const [settled = NOTHING] = await press(world, "deny");
  assert.deepEqual(decisions(world), [["tok-aad-b", "cf-1", "deny"]]);
  assert.ok(
    settled.text.includes("Not posted: the REQUEST_CHANGES review on AMD-AGI/Hyperloom#12 was dropped."),
    settled.text,
  );
  const group = groupText(world);
  assert.ok(group.includes("选择不发布") && !group.includes("不合入"), group);
  assert.equal(row(world)?.state, "done");
});

for (const [name, answer, card, group] of [
  ["stale", { status: "stale", reason: "head_moved" }, "changed after the review, so nothing was posted", "没有发布"],
  [
    "expired",
    { status: "expired" },
    "ran out, so the REQUEST_CHANGES review on AMD-AGI/Hyperloom#12 was not posted",
    "确认已过期，没有发布",
  ],
  [
    "refused with reason",
    { status: "refused", reason: "ci_not_green" },
    "The REQUEST_CHANGES review on AMD-AGI/Hyperloom#12 was not posted: ci_not_green",
    "没有发布：ci_not_green",
  ],
  ["refused", { status: "refused" }, "was not posted.", "没有发布。"],
  // a merge's word is not a review's: it is never read as "posted"
  ["a status that is not a reviews", { status: "merged" }, "was not posted", "没有发布"],
] as const) {
  test(`what claw answers to a held review is what the reviewer and the group are told (${name})`, async () => {
    const world = await heldReview();
    world.claw.decision = { ...answer };
    const [settled = NOTHING] = await press(world, "allow");
    const said = groupText(world);
    assert.ok(settled.text.includes(card) && said.includes(group), `${settled.text} / ${said}`);
    assert.ok(!settled.text.includes("Posted") && !said.includes("已发布") && !said.includes("合入"), said);
    assert.equal(row(world)?.state, "done");
  });
}

test("a review that already reached github is not reported as not posted", async () => {
  const world = await heldReview();
  world.claw.decision = { status: "refused", reason: "github_error", wrote: true };
  const [settled = NOTHING] = await press(world, "allow");
  const card = settled.text;
  assert.ok(
    card.includes("already sent to GitHub") &&
      card.includes("cannot say it was not posted") &&
      card.includes("Look at the pull request first"),
    card,
  );
  assert.ok(!card.includes("Nothing was posted"));
  assert.ok(groupText(world).includes("已向 GitHub 发出请求") && !groupText(world).includes("没有发布"));
  assert.equal(row(world)?.state, "done");
});

test("a held review that ran out is not sent to claw", async () => {
  const world = await heldReview();
  world.clock.setEpochMs(Date.UTC(2026, 10, 12, 0, 0, 1));
  const [settled = NOTHING] = await press(world, "allow");
  assert.deepEqual(decisions(world), []);
  assert.ok(
    settled.text.includes("ran out, so the REQUEST_CHANGES review on AMD-AGI/Hyperloom#12 was not posted"),
    settled.text,
  );
  assert.equal(row(world)?.state, "done");
});

for (const status of [404, 409, 410]) {
  test(`a held review claw no longer holds says nothing was posted (${String(status)})`, async () => {
    const world = await heldReview();
    world.claw.decision = new ClawError(status);
    const [settled = NOTHING] = await press(world, "allow");
    assert.ok(settled.text.includes("no longer active, so nothing was posted"), settled.text);
    assert.ok(!settled.text.includes("merged"));
    assert.equal(row(world)?.state, "done");
  });
}

test("when claw says retry the held review is still open and pressing again posts it", async () => {
  const world = await heldReview();
  world.claw.decision = { status: "retry", reason: "github_rate_limited" };
  const [first = NOTHING] = await press(world, "allow");
  assert.equal(row(world)?.state, "pending");
  assert.ok(first.text.includes("could not try the review just now (github_rate_limited)"), first.text);
  assert.ok(!first.text.includes("merge") && reviewButtons(first.text));
  assert.ok(!groupText(world).includes("没有发布"));
  world.claw.decision = { status: "submitted", review_id: 5 };
  const [second = NOTHING] = await press(world, "allow");
  assert.deepEqual(
    decisions(world).map((d) => d[2]),
    ["allow", "allow"],
  );
  assert.ok(second.text.includes("Posted the REQUEST_CHANGES review"), second.text);
});

test("when claw refuses the worker the held review stays usable and nothing was posted", async () => {
  const world = await heldReview();
  world.claw.decision = new ClawError(403, '{"ok":false,"error":"service_client_not_allowed"}');
  const [settled = NOTHING] = await press(world, "allow");
  assert.ok(
    settled.text.includes("does not take answers from me yet") && settled.text.includes("Nothing was posted."),
    settled.text,
  );
  assert.ok(reviewButtons(settled.text));
  assert.equal(row(world)?.state, "pending");
});

test("a held review for someone who is not connected is not answered", async () => {
  const world = await heldReview();
  world.bound.delete("aad-b");
  const [settled = NOTHING] = await press(world, "allow");
  assert.deepEqual(decisions(world), []);
  assert.ok(settled.text.includes("not connected") && settled.text.includes("Review needs confirmation"), settled.text);
  assert.ok(reviewButtons(settled.text));
  assert.equal(row(world)?.state, "pending");
});

test("the text of a held review reaches the card masked", async () => {
  const world = await heldReview({
    review: { ...REVIEW, event: "APPROVE", body: `fine, token ${TOKEN} was in the log`, comments: [] },
  });
  const [card] = cards(world, "personal:aad-b");
  assert.ok(card?.review?.body.includes("[hidden]") && !card.review.body.includes(TOKEN), card?.review?.body ?? "");
});
