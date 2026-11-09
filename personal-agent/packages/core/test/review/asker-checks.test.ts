// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an asker needs (`test_github_review`'s asker tests): on a Claw without review items the session is made here, on the
 * asker's own key, so an asker without one starts nothing and is sent the steps once a day; an asker needs no GitHub account of
 * their own to have a committer review; naming oneself asks the identity service about one account once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { UserRef } from "../../src/index.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

async function ask(
  world: ReviewWorld,
  id = "g1",
  text = `请 {Bob} 帮我 review 合入 ${PR}`,
  people?: readonly UserRef[],
) {
  const message = groupMessage(text, ALICE, people, id);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

const groupText = (world: ReviewWorld) => saidIn(world.surface, CONV);
const steps = (world: ReviewWorld) => world.said.askLink.filter((s) => s.startsWith("aad-a:"));

test("an asker with no key of their own starts nothing on a claw without review items and gets the link steps", async () => {
  const world = reviewWorld();
  world.store.links.unlink("aad-a");
  world.store.references.saveReference("aad-a", { conversation: { id: "personal:aad-a" } }); // (her chat is known)
  await ask(world);
  assert.equal(world.started.length, 0);
  const [lead = ""] = steps(world);
  assert.ok(lead.includes(PR) && lead.includes("your own key"), lead);
  assert.ok(groupText(world).includes("/link") && groupText(world).includes("已私信"), groupText(world));
  assert.deepEqual(world.surface.of("personal:aad-b"), []);
  await ask(world, "g2"); // asked again the same day: the group is told again, Alice is not sent the steps twice
  assert.equal(steps(world).length, 1);
  world.link("aad-a", "Alice", "ak-alice-new"); // she links: the same request now goes through, her key beside her token
  await ask(world, "g3");
  const [turn] = world.started;
  assert.equal(turn?.token, "tok-aad-a");
  assert.equal(turn.modelKey, "ak-alice-new");
});

test("when the askers chat cannot be opened the group says where to get the steps and tomorrow tries again", async () => {
  const world = reviewWorld();
  world.store.links.unlink("aad-a");
  (world.surface as unknown as { reachable: Set<string> }).reachable = new Set(["aad-b", "aad-c"]);
  await ask(world);
  assert.equal(world.started.length, 0);
  assert.ok(groupText(world).includes("我没能私信你"), groupText(world));
  // (not used up: the next ask tries again)
  assert.equal(world.store.reviewDelegation.claimGithubNotice("aad-a", "link", 86_400), true);
});

test("an asker needs no github account of their own to have a committer review and merge", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice"); // no GitHub account connected
  await ask(world);
  world.started[0]?.ended(); // (that review is over)
  await Promise.resolve();
  world.identity.know("aad-a", "u-alice", "alice-gh", false, true); // nor does an expired one matter
  await ask(world, "g2");
  assert.deepEqual(
    world.started.map((s) => s.turn.actingAs),
    ["u-bob", "u-bob"],
  );
  assert.ok(!world.identity.askedAbout().includes("external:teams.microsoft.com|aad-a"));
  assert.ok(!groupText(world).includes("你自己也连接 GitHub"));
  assert.deepEqual(world.surface.of("personal:aad-a"), []);
});

test("naming oneself asks the identity service about one github account once", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh", true);
  world.store.members.rememberMember("29:a", "aad-a", "Alice"); // (she has written to the bot)
  world.github.defaultAuthor = "carol-gh"; // (a pull request Alice did not write)
  await ask(world, "g1", `请 {Alice} 帮我 review 合入 ${PR}`, [ALICE]);
  assert.deepEqual(world.identity.askedAbout(), ["external:teams.microsoft.com|aad-a"], groupText(world));
  assert.equal(world.started.length, 1);
});

test("an asker with no identity binding is sent the binding card and not the link steps", async () => {
  const world = reviewWorld();
  world.bound.delete("aad-a");
  await ask(world);
  assert.equal(world.started.length, 0);
  assert.equal(world.said.onboard, 1, JSON.stringify(world.said)); // (the host sends the card that connects her: onboarding)
  assert.deepEqual(steps(world), []);
});

test("the group is never told the switch is the reason for a verdict", async () => {
  const world = reviewWorld();
  await ask(world);
  const text = world.started[0]?.turn.shapeAnswer("没有发现必须修复的问题。\nVERDICT: CLEAN", "", "", [], 0, "") ?? "";
  assert.ok(
    text.includes("没有发现必须修复的问题") && !text.includes("VERDICT") && !text.includes("未开启自动合入"),
    text,
  );
});

test("a review with nothing held makes no card and the reviewer is only told afterwards", async () => {
  const world = reviewWorld();
  await ask(world);
  const [turn] = world.started;
  assert.ok(turn);
  turn.review.sessionId = "sess-1";
  await world.service.afterTurn(
    turn.review,
    "没有发现必须修复的问题，已批准并合入。\nVERDICT: CLEAN",
    {
      moved: false,
      refusal: null,
      ranModel: "",
      wrote: [
        ["gh_review_submit", "submitted", "APPROVE"],
        ["gh_pr_merge", "merged", ""],
      ],
      prSummary: "",
    },
    world.surface.conversation(groupMessage("x").conversation),
  );
  assert.deepEqual(
    world.surface.of("personal:aad-b").filter((r) => "message" in r && r.message.body.type === "view"),
    [],
  );
  assert.deepEqual(
    world.claw.calls.filter((c) => c[0] === "decide"),
    [],
  );
  const dm = saidIn(world.surface, "personal:aad-b");
  assert.ok(dm.includes("已批准并合入") && dm.includes("Alice"), dm); // he hears it afterwards, in his own chat
});
