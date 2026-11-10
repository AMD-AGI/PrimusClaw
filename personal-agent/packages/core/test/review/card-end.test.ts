// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review item's card ends where it was posted, whichever worker sees the item end (`test_review_card_end`): where each card
 * went is kept with it in the store, every end edits it from there, the reviewer's held-step card ends with the item as well, a
 * sweep ends any open card whose item is over, and a card the channel refuses to edit gets a plain end in its place.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonObject, WorkItem } from "../../src/index.js";
import { ITEM_CARD_ENDED_PLAIN_ZH } from "../../src/review/service/item-cards.js";
import { GithubReview } from "../../src/review/service/github-review.js";
import { FakeClock } from "../../../../test-support/clock.js";
import { SeededRandom } from "../../../../test-support/random.js";
import {
  ALICE,
  ALICE_DM,
  CONV,
  PR,
  groupMessage,
  handBack,
  handoffEvent,
  handoffWorld,
  reviewWorld,
  settleFollows,
  withItems,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const LINK = "https://github.com/AMD-AGI/Hyperloom/pull/12";
const DONE = { status: "done", prUrl: LINK, verdict: "approve", merged: true };
const HELD = { status: "waiting_for_reviewer", prUrl: LINK, verdict: "approve", merged: false };
const BOB_DM = "personal:aad-b";

/** A new worker on the same store and the same chats (a release): nothing of the first one's memory, and its time is its own. */
function restarted(world: ReviewWorld) {
  const clock = new FakeClock(world.clock.epochMs());
  const fresh = new GithubReview({ ...world.deps, clock }, new SeededRandom(7), () => Promise.resolve());
  return { fresh, clock };
}

async function followOn(world: ReviewWorld): Promise<GithubReview> {
  const { fresh, clock } = restarted(world);
  assert.equal(fresh.resume(), 1);
  for (let i = 0; i < 20 && clock.pending > 0; i += 1) await clock.advance(30_000);
  await fresh.idle();
  return fresh;
}

/** The cards posted in that chat (their ids), and the edits each got. */
function cardsIn(world: ReviewWorld, conversation = ALICE_DM) {
  const ops = world.surface.of(conversation);
  const posted = ops.flatMap((r) => (r.op === "post" ? [r.id] : []));
  const edits = ops.flatMap((r) =>
    r.op === "update" && r.message.body.type === "view" ? [{ id: r.id, view: r.message.body.view }] : [],
  );
  return { posted, edits };
}

/** Each card in that chat was edited into its end; the end each last shows. */
function endedWithoutButtons(world: ReviewWorld, conversation = ALICE_DM): string[] {
  const { posted, edits } = cardsIn(world, conversation);
  assert.ok(posted.length > 0, "no card was posted");
  return posted.map((id) => {
    const last = edits.filter((e) => e.id === id).at(-1);
    assert.equal(last?.view.name, "endedItem", `${id} was not ended`);
    return last.view.model.ended;
  });
}

const cardState = (world: ReviewWorld, itemId = "item-1") =>
  world.store.assistantCards.placedAssistantCards({ itemId }).length === 0 ? "ended" : "open";

test("a review followed on by a restarted worker ends its card", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", [HELD]);
  await handBack(world, handoffEvent());
  assert.ok(cardsIn(world).posted.length === 1 && cardsIn(world).edits.length === 0);
  world.claw.views.set("item-1", [HELD, DONE]);
  await followOn(world);
  const [ended = ""] = endedWithoutButtons(world);
  assert.ok(ended.includes("已结束：结论：批准，已合入"), ended);
  assert.equal(cardState(world), "ended");
});

test("the conclusion said first then the end still ends the card", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", [HELD, HELD, DONE]);
  await handBack(world, handoffEvent());
  const [ended = ""] = endedWithoutButtons(world);
  assert.ok(ended.includes("已结束：结论：批准，已合入"), ended);
  assert.equal(cardsIn(world).edits.length, 1);
});

function bobsItem(itemId: string): WorkItem {
  return {
    itemId,
    seq: 1,
    title: `Review ${PR}`,
    boardState: "needs_you",
    resultVersion: 1,
    canAccept: false,
    lastReportKind: null,
    pendingQuestion: "合入吗？",
    summary: "",
    outcome: null,
    kind: "review",
    params: {},
    pull: null,
    updatedAt: "",
  };
}

test("the reviewers held step card ends with the item", async () => {
  // (the assistant's work card, as its line posts it: sent, and where it went kept with it)
  const world = handoffWorld(
    { seqFrom: 1 },
    {
      postWorkCard: async (conversation, owner, item) => {
        const cardId = world.store.assistantCards.addAssistantCard(owner, item.itemId, 1, false);
        const id = await conversation.post({
          body: { type: "view", view: { name: "reviewItem", model: {} as never }, fallbackText: item.title },
        });
        world.store.assistantCards.placeAssistantCard(cardId, {
          activityId: id ?? "",
          reference: conversation.ref.wire as JsonObject,
          render: { kind: "work" },
        });
      },
    },
  );
  world.claw.workItem = (_key, itemId) => bobsItem(itemId);
  world.claw.views.set("item-1", [HELD]);
  await handBack(world, handoffEvent());
  assert.equal(cardsIn(world, BOB_DM).posted.length, 1, "Bob got the card that answers the held merge");
  world.claw.views.set("item-1", [HELD, DONE]);
  await followOn(world);
  const [ended = ""] = endedWithoutButtons(world, BOB_DM);
  assert.ok(ended.includes("已结束"), ended);
});

test("a card nothing follows any more is ended by the sweep", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", [HELD]);
  await handBack(world, handoffEvent());
  for (const row of world.store.reviewDelegation.askerFollows())
    world.store.reviewDelegation.dropAskerFollow(row.itemId);
  const { fresh } = restarted(world);
  const sweep = () => (fresh as unknown as { cards: { closeEnded: () => Promise<number> } }).cards.closeEnded();
  assert.equal(await sweep(), 0); // (still waiting: left open)
  assert.equal(cardsIn(world).edits.length, 0);
  world.claw.views.set("item-1", [DONE]);
  assert.ok((await sweep()) >= 1);
  const [ended = ""] = endedWithoutButtons(world);
  assert.ok(ended.includes("已结束：结论：批准，已合入"), ended);
  assert.equal(await sweep(), 0); // (ended once: never edited again)
});

test("a review typed in a group ends its card after a restart", async () => {
  const world = reviewWorld();
  withItems(world);
  world.claw.views.set("item-1", { status: "in_progress", prUrl: "" });
  const message = groupMessage(`请 {Bob} 帮我 review 合入 ${PR}`);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
  await settleFollows(world, 2);
  assert.ok(cardsIn(world).posted.length === 1 && cardsIn(world).edits.length === 0);
  world.claw.views.set("item-1", { status: "done", prUrl: LINK, verdict: "request_changes", merged: false });
  await followOn(world);
  const [ended = ""] = endedWithoutButtons(world);
  assert.ok(ended.includes("已结束：结论：要求修改，没有合入"), ended);
});

test("a card the channel refuses to edit gets the plain end", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", [HELD, DONE]);
  let refused = 0;
  const surface = world.surface;
  const open = surface.conversation.bind(surface);
  surface.conversation = (ref) => {
    const conversation = open(ref);
    const update = conversation.update.bind(conversation);
    conversation.update = (id, message, options) => {
      const view = message.body.type === "view" ? message.body.view : undefined;
      if (refused === 0 && view?.name === "endedItem" && view.model.cardId !== "") {
        refused += 1;
        return Promise.reject(new Error("Teams said 400"));
      }
      return update(id, message, options);
    };
    return conversation;
  };
  await handBack(world, handoffEvent());
  assert.equal(refused, 1);
  const [ended = ""] = endedWithoutButtons(world);
  assert.equal(ended, ITEM_CARD_ENDED_PLAIN_ZH);
  assert.equal(cardState(world), "ended");
});

for (const outcome of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
  test(`an item that ended with an outcome named like an object property ends its card as done (${outcome})`, async () => {
    // (Python's BOARD_OUTCOME_ZH.get(outcome, "已完成"): a word Claw sends is a key of the table or nothing)
    const world = reviewWorld();
    const conversation = world.surface.conversation({
      id: BOB_DM,
      kind: "personal",
      tenantId: "tenant-1",
      wire: { conversation: { id: BOB_DM } },
    });
    const cardId = world.store.assistantCards.addAssistantCard("aad-b", "item-9", 1, false);
    const id = await conversation.post({
      body: { type: "view", view: { name: "reviewItem", model: {} as never }, fallbackText: "work" },
    });
    world.store.assistantCards.placeAssistantCard(cardId, {
      activityId: id ?? "",
      reference: conversation.ref.wire as JsonObject,
      render: { kind: "work" },
    });
    world.claw.workItem = (_key, itemId) => ({ ...bobsItem(itemId), boardState: "done", outcome });
    const sweep = (world.service as unknown as { cards: { closeEnded: () => Promise<number> } }).cards.closeEnded();
    assert.equal(await sweep, 1);
    const [ended = ""] = endedWithoutButtons(world, BOB_DM);
    assert.equal(ended, "已结束：已完成");
  });
}
