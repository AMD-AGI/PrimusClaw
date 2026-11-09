// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A high-risk merge Claw holds for the reviewer's own confirmation (`test_github_review`'s confirmation tests): one card to him
 * alone, the group told; only his press answers it, with his own exchanged token, once; and what Claw answers is what he and the
 * group are told.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALICE, CONV, reviewWorld } from "../../../../test-support/review-world.js";
import {
  ClawError,
  ask,
  bobUnreachable,
  cards,
  decisions,
  exchangeDown,
  groupText,
  held,
  NOTHING,
  press,
  row,
} from "./held-world.js";

test("a high risk merge sends one card to the reviewer alone and tells the group", async () => {
  const world = await held();
  const [card, ...more] = cards(world, "personal:aad-b");
  assert.equal(more.length, 0);
  assert.ok(card);
  assert.equal(card.title, "Change the release workflow");
  assert.equal(card.author, "carol-gh");
  assert.equal(card.headSha, "aaaaaaaaaaaa");
  assert.deepEqual(card.reasons, ["touches .github/workflows"]);
  assert.ok(card.checks.includes("5 passed"), card.checks);
  assert.equal(card.requester, "Alice");
  assert.equal(card.confirmationId, "cf-1");
  assert.deepEqual(cards(world, CONV), []); // not in the group
  assert.deepEqual(cards(world, "personal:aad-a"), []); // not with the asker
  assert.ok(groupText(world).includes("已私信 Bob 请其确认"));
  const stored = row(world);
  assert.equal(stored?.actorId, "aad-b");
  assert.equal(stored.requesterId, "aad-a");
  assert.equal(stored.state, "pending");
  // read with the asker's credential
  assert.ok(world.claw.calls.some((c) => c[0] === "confirmations" && c[1] === "tok-aad-a" && c[2] === "sess-1"));
});

test("the same confirmation is never sent twice", async () => {
  const world = await held();
  await ask(world, "g2");
  assert.equal(cards(world, "personal:aad-b").length, 1);
  assert.notEqual(row(world), null);
});

test("a confirmation that is not for the named reviewer is not sent", async () => {
  const world = await held({ actor_user_id: "u-mallory" });
  assert.deepEqual(cards(world, "personal:aad-b"), []);
  assert.equal(row(world), null);
});

test("a confirmation that cannot be delivered says so and merges nothing", async () => {
  const world = reviewWorld();
  bobUnreachable(world);
  await held({}, world);
  assert.ok(groupText(world).includes("没有合入"), groupText(world));
  assert.equal(row(world), null);
  assert.deepEqual(decisions(world), []);
});

test("only the reviewers click releases the merge and it is made with their own credential", async () => {
  const world = await held();
  const alice = await press(world, "allow", ALICE); // Alice presses it (it cannot reach her, but if it did)
  assert.deepEqual(decisions(world), []);
  assert.equal(row(world)?.state, "pending");
  assert.ok(alice[0]?.text.includes("Only the person this was asked of") && alice[0].buttons, alice[0]?.text ?? "");
  const [bob = NOTHING] = await press(world, "allow");
  assert.deepEqual(decisions(world), [["tok-aad-b", "cf-1", "allow"]]); // Bob's own credential, never Alice's
  assert.ok(bob.text.includes("Merged AMD-AGI/Hyperloom#12 (01234567)") && !bob.buttons, bob.text);
  assert.ok(groupText(world).includes("已确认") && groupText(world).includes("已合入"), groupText(world));
  assert.equal(row(world)?.state, "done");
});

test("do not merge closes it and the group hears that", async () => {
  const world = await held();
  world.claw.decision = { status: "denied" };
  await press(world, "deny");
  assert.deepEqual(decisions(world), [["tok-aad-b", "cf-1", "deny"]]);
  assert.ok(groupText(world).includes("选择不合入"), groupText(world));
});

for (const [answer, card, group] of [
  [{ status: "stale" }, "changed after the review", "没有合入"],
  [{ status: "expired" }, "ran out", "过期"],
  [{ status: "refused", reason: "required check missing" }, "required check missing", "required check missing"],
] as const) {
  test(`what claw answers is what the reviewer and the group are told (${answer.status})`, async () => {
    const world = await held();
    world.claw.decision = { ...answer };
    const [settled = NOTHING] = await press(world, "allow");
    assert.ok(settled.text.includes(card), settled.text);
    assert.ok(groupText(world).includes(group), groupText(world));
  });
}

for (const answer of [
  { status: "refused", reason: "github_error", wrote: true },
  { status: "stale", reason: "head_moved", wrote: true },
]) {
  test(`a try that already wrote to github is not reported as not merged (${answer.status})`, async () => {
    const world = await held();
    world.claw.decision = { ...answer };
    const [settled = NOTHING] = await press(world, "allow");
    const card = settled.text;
    assert.ok(card.includes("already sent to GitHub") && card.includes("Look at the pull request first"), card);
    assert.ok(!card.replace("cannot say it was not merged", "").includes("not merged"));
    assert.ok(!card.includes("nothing was merged"));
    assert.ok(
      groupText(world).includes("已向 GitHub 发出请求") && !groupText(world).includes("没有合入"),
      groupText(world),
    );
    assert.equal(row(world)?.state, "done");
  });
}

test("a second tap and a forged card do not reach claw", async () => {
  const world = await held();
  await press(world, "allow");
  const [second = NOTHING] = await press(world, "allow");
  const [forged = NOTHING] = await press(world, "allow", undefined, "forged");
  assert.equal(decisions(world).length, 1);
  assert.ok(second.text.includes("already answered"), second.text);
  assert.ok(forged.text.includes("no longer active"), forged.text);
});

test("a confirmation that ran out is not sent to claw", async () => {
  const world = await held();
  world.clock.setEpochMs(Date.UTC(2026, 10, 12, 0, 0, 1));
  const [settled = NOTHING] = await press(world, "allow");
  assert.deepEqual(decisions(world), []);
  assert.ok(settled.text.includes("ran out"), settled.text);
});

test("when claw cannot be asked the card comes back and pressing again works", async () => {
  const world = await held();
  world.claw.decision = new ClawError(503);
  const [first = NOTHING] = await press(world, "allow");
  assert.equal(row(world)?.state, "pending");
  assert.ok(first.buttons, first.text);
  world.claw.decision = { status: "merged", merge_sha: "abcdef0123" };
  const [second = NOTHING] = await press(world, "allow");
  assert.deepEqual(
    decisions(world).map((d) => d[2]),
    ["allow", "allow"],
  );
  assert.ok(second.text.includes("Merged"), second.text);
});

test("when claw says retry the confirmation is still open and pressing again merges", async () => {
  const world = await held();
  world.claw.decision = { status: "retry", reason: "github_rate_limited", message: "allow it again in a moment" };
  const [first = NOTHING] = await press(world, "allow");
  assert.equal(row(world)?.state, "pending");
  assert.ok(first.text.includes("could not try the merge just now (github_rate_limited)") && first.buttons, first.text);
  assert.ok(!groupText(world).includes("没有合入")); // the group is told only how it ended
  world.claw.decision = { status: "merged", merge_sha: "abcdef0123" };
  const [second = NOTHING] = await press(world, "allow");
  assert.deepEqual(
    decisions(world).map((d) => d[2]),
    ["allow", "allow"],
  );
  assert.ok(second.text.includes("Merged"));
  assert.equal(row(world)?.state, "done");
});

test("a card for someone who is not connected is not answered", async () => {
  const world = await held();
  world.bound.delete("aad-b");
  const [settled = NOTHING] = await press(world, "allow");
  assert.deepEqual(decisions(world), []);
  assert.ok(settled.text.includes("not connected") && settled.buttons, settled.text); // still pressable
  assert.ok(world.said.connect.some((c) => c.startsWith("aad-b:"))); // and the card that connects came with it
});

test("a reviewer with only a linked key cannot answer and the key is never sent", async () => {
  const world = await held();
  world.bound.delete("aad-b"); // no binding: the exchange says not bound, but the linked key is still there
  const [settled = NOTHING] = await press(world, "allow");
  assert.deepEqual(decisions(world), []);
  assert.ok(settled.text.includes("not connected to your Primus account"), settled.text);
  assert.ok(!JSON.stringify(world.surface.outbox).includes("ak-bob-linked"));
  assert.equal(row(world)?.state, "pending"); // nothing was claimed: connect, then press again
  assert.ok(settled.buttons);
  world.bound.add("aad-b");
  await press(world, "allow");
  assert.deepEqual(decisions(world), [["tok-aad-b", "cf-1", "allow"]]);
});

test("when the token cannot be exchanged the card comes back and nothing is claimed", async () => {
  const world = await held();
  const restore = exchangeDown(world);
  const [settled = NOTHING] = await press(world, "allow");
  assert.deepEqual(decisions(world), []);
  assert.equal(row(world)?.state, "pending");
  assert.ok(settled.text.includes("could not reach the Primus platform") && settled.buttons, settled.text);
  restore();
  await press(world, "allow");
  assert.deepEqual(
    decisions(world).map((d) => d[2]),
    ["allow"],
  );
});

for (const [body, text] of [
  ['{"ok":false,"error":"service_client_not_allowed"}', "does not take answers from me yet"],
  ['{"ok":false,"error":"interactive_sign_in_required"}', "did not take my credential"],
  ['{"ok":false,"error":"only_the_acting_user_can_decide"}', "not yours to give"],
  ['{"ok":false,"error":"something_new"}', "not yours to give"],
  ["not json", "not yours to give"],
] as const) {
  test(`what claw says when it refuses a service is told to the reviewer and the card stays usable (${body})`, async () => {
    const world = await held();
    world.claw.decision = new ClawError(403, body);
    const [settled = NOTHING] = await press(world, "allow");
    assert.ok(settled.text.includes(text) && settled.buttons, settled.text);
    assert.equal(row(world)?.state, "pending");
  });
}

for (const [name, changes] of [
  ["case of the repository", { repo: "amd-agi/hyperloom" }],
  ["number as text", { pr: "12" }],
] as const) {
  test(`the repository is compared without case and a number may be text (${name})`, async () => {
    const world = await held(changes);
    const [card] = cards(world, "personal:aad-b");
    // the card says the pull request that was asked for, as it was asked for
    assert.equal(`${card?.repo ?? ""}#${String(card?.number)}`, "AMD-AGI/Hyperloom#12");
  });
}
