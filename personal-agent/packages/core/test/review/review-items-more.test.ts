// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reviews Claw makes as items (`test_review_items`, continued): one of the asker's own that waits for a slot says which and
 * where its result goes; a review someone else runs is followed through its waits to its end; a review only goes to Claw as one.
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
  settleFollows,
  withItems,
  type ItemOptions,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const PR2 = "AMD-AGI/Hyperloom#13";

function itemsWorld(options: ItemOptions = { seqFrom: 1 }): ReviewWorld {
  const world = reviewWorld();
  withItems(world, options);
  return world;
}

async function ask(world: ReviewWorld, text: string, id = "g1", people?: readonly UserRef[]): Promise<void> {
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

/** Alice asks a review of herself (her own account, her own key): followed in its session. */
async function askSelf(world: ReviewWorld, text: string): Promise<void> {
  world.store.members.rememberMember("29:a", "aad-a", "Alice");
  world.identity.know("aad-a", "u-alice", "alice-gh", true);
  world.github.defaultAuthor = "carol-gh"; // (pull requests Alice did not write)
  await ask(world, text, "g1", [ALICE]);
}

const groupText = (world: ReviewWorld) => saidIn(world.surface, CONV);
const followed = (world: ReviewWorld) =>
  world.started.filter((s) => s.turn.attach).map((s) => s.review.item?.sessionId);
const bodies = (world: ReviewWorld) =>
  world.claw.calls.filter((c) => c[0] === "startReviews").map((c) => c[2] as Record<string, unknown>);
const itemCards = (world: ReviewWorld) =>
  world.surface
    .of("personal:aad-a")
    .flatMap((r) =>
      r.op === "post" && r.message.body.type === "view" && r.message.body.view.name === "reviewItem"
        ? [r.message.body.view.model]
        : [],
    );

test("one of her own that is queued says so and where its result is", async () => {
  const world = itemsWorld({ seqFrom: 1, queueAfter: 0, queueReason: "too_many_active_items" });
  await askSelf(world, `请 {Alice} 帮我 review 合入 ${PR}`);
  const said = groupText(world);
  assert.ok(said.includes(`已建事项：${PR} #1。`), said);
  assert.ok(
    said.includes("排队的这些开始后，结果不会发在这里，请在看板上看（/board）") ||
      said.includes("名额空出后会自动开始"),
    said,
  );
  assert.deepEqual(followed(world), []);
});

test("several of her own with one queued say which waits and where its result is", async () => {
  const world = itemsWorld({ seqFrom: 1, queueAfter: 1, queueReason: "too_many_active_items" });
  await askSelf(world, `请 {Alice} 帮我 review 合入 ${PR} ${PR2}`);
  const said = groupText(world);
  assert.ok(
    said.includes(
      `已建事项：${PR} #1、${PR2} #2。已开始 1 个（${PR}），排队 1 个（${PR2}；你进行中的任务已满），排队的会自动开始，不用再发。`,
    ),
    said,
  );
  assert.ok(said.includes("排队的这些开始后，结果不会发在这里，请在看板上看（/board）"), said);
  assert.deepEqual(followed(world), ["s-1"]);
  // The sentence that says results come here names only the review that started.
  const leads = world.started.map((s) => s.turn.lead).join(" ") + said;
  assert.ok(leads.includes("同时 review 合入这 1 个 PR") && !leads.includes(`：${PR}、${PR2}`), leads);
  assert.equal(itemCards(world).length, 2, "both items have their card");
});

test("bob is told once when his item waits for him", async () => {
  const world = itemsWorld();
  world.claw.views.set("item-1", [
    { status: "waiting_for_reviewer" },
    { status: "waiting_for_reviewer" },
    { status: "done", verdict: "approve", merged: true },
  ]);
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  await settleFollows(world);
  assert.equal(saidIn(world.surface, "personal:aad-b").split("在等你确认").length - 1, 1);
});

test("a review waiting for its reviewer is followed on to its end", async () => {
  const world = itemsWorld();
  world.claw.views.set("item-1", [
    { status: "waiting_for_reviewer", prUrl: "" },
    { status: "waiting_for_reviewer", prUrl: "" },
    { status: "done", prUrl: "https://github.com/AMD-AGI/Hyperloom/pull/12", verdict: "approve", merged: true },
  ]);
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  await settleFollows(world);
  assert.equal(world.claw.calls.filter((c) => c[0] === "view").length, 3);
  const said = groupText(world);
  assert.equal(said.split("代审）：").length - 1, 2, said);
  assert.ok(said.includes(`${PR}（Bob 代审）：还没有结论，在等 Bob 处理`), said);
  assert.ok(said.includes(`${PR}（Bob 代审）：结论：批准，已合入`), said);
  assert.equal(saidIn(world.surface, "personal:aad-b").split("在等你确认").length - 1, 1);
});

test("the model named is checked against the reviewers key", async () => {
  const world = itemsWorld();
  await ask(world, `请 {Bob} 用 claude-opus-5.5 帮我 review ${PR}`);
  assert.deepEqual(
    world.claw.calls.filter((c) => c[0] === "models").map((c) => c[1]),
    ["ak-bob-linked"],
  );
});

test("a review only request with a model goes to claw as review only on that model", async () => {
  const world = itemsWorld();
  await ask(world, `请 {Bob} 用 claude-opus-5.5 帮我 review ${PR}`);
  const [body] = bodies(world);
  assert.equal(body?.reviewOnly, true);
  assert.equal(body.model, "claude-opus-5.5");
  const message = (body.prs as { message: string }[])[0]?.message ?? "";
  assert.ok(message.includes("只 review") || message.toLowerCase().includes("review only"), message);
  const [card] = itemCards(world);
  assert.deepEqual([card?.reviewOnly, card?.model, card?.who], [true, "claude-opus-5.5", "Bob"]);
});

test("a merge is asked for only when the words ask for one", async () => {
  const world = itemsWorld();
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  await ask(world, `请 {Bob} 帮我 review ${PR2}`, "g2");
  assert.deepEqual(
    bodies(world).map((b) => b.reviewOnly),
    [false, true],
  );
});

test("the default review model is what claw is asked for when none is named", async () => {
  const world = itemsWorld();
  (world.deps as { defaultModel: string }).defaultModel = "claude-opus-5.5";
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.equal(bodies(world)[0]?.model, "claude-opus-5.5");
});
