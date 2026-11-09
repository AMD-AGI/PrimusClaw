// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The card of each review item (`github_review.py`'s `_item_cards`, `_end_item_card`, `close_ended_cards`): a card that could
 * not be sent leaves the item on the board and its end is not lost; a queued card becomes the running one once; the sweep ends
 * a task card from the owner's board as Claw says it ended, and a read that fails is tried at the next sweep.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClawError, type WorkItem } from "../../src/index.js";
import type { ItemCards } from "../../src/review/service/item-cards.js";
import { ITEM_STOPPED_ZH } from "../../src/review/progress.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  settleFollows,
  withItems,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const cardsOf = (world: ReviewWorld) => (world.service as unknown as { cards: ItemCards }).cards;

async function ask(world: ReviewWorld): Promise<void> {
  const message = groupMessage(`请 {Bob} 帮我 review 合入 ${PR}`);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

const edits = (world: ReviewWorld) =>
  world.surface
    .of("personal:aad-a")
    .flatMap((r) => (r.op === "update" && r.message.body.type === "view" ? [r.message.body.view] : []));

test("a card that cannot be sent leaves the item and its end is said all the same", async () => {
  const world = reviewWorld();
  withItems(world);
  const surface = world.surface;
  const open = surface.conversation.bind(surface);
  surface.conversation = (ref) => {
    const conversation = open(ref);
    if (ref.id === "personal:aad-a") conversation.post = () => Promise.reject(new Error("Teams said no"));
    return conversation;
  };
  world.claw.views.set("item-1", {
    status: "done",
    prUrl: "https://github.com/AMD-AGI/Hyperloom/pull/12",
    verdict: "approve",
    merged: true,
  });
  await ask(world);
  await settleFollows(world);
  assert.deepEqual(world.store.assistantCards.placedAssistantCards({ itemId: "item-1" }), []);
  assert.ok(
    world.surface
      .of(CONV)
      .some(
        (r) => r.op === "send" && r.message.body.type === "text" && r.message.body.text.includes("结论：批准，已合入"),
      ),
  );
});

test("an item that ended before its card went out gets its card ended at once", async () => {
  const world = reviewWorld();
  const cards = cardsOf(world);
  await cards.end("item-9", "已结束：结论：批准，已合入"); // (the end comes first)
  const review = {
    pull: { owner: "AMD-AGI", repo: "Hyperloom", number: 12 },
    actorName: "Bob",
    reviewOnly: false,
    lang: "zh" as const,
    item: { itemId: "item-9", seq: 9, queued: "" },
  };
  const dm = world.surface.conversation({
    id: "personal:aad-a",
    kind: "personal",
    tenantId: "t",
    wire: { conversation: { id: "personal:aad-a" } },
  });
  await cards.post(dm, "aad-a", [review as never], () => "m");
  const [ended] = edits(world);
  assert.equal(ended?.name, "endedItem");
  assert.equal((ended.model as { ended: string }).ended, "已结束：结论：批准，已合入");
});

test("a queued card becomes the running card once its review starts", async () => {
  const world = reviewWorld();
  withItems(world, { queued: () => "too_many_active_items" });
  world.claw.views.set("item-1", [{ status: "queued" }, { status: "in_progress" }, { status: "in_progress" }]);
  await ask(world);
  await settleFollows(world, 3);
  const running = edits(world).filter((v) => v.name === "reviewItem");
  assert.equal(running.length, 1);
  assert.equal((running[0]?.model as { queued: boolean }).queued, false);
  await cardsOf(world).started("item-1"); // (said once: the card no longer says it waits)
  assert.equal(edits(world).filter((v) => v.name === "reviewItem").length, 1);
});

function placeTaskCard(world: ReviewWorld, itemId: string): void {
  const cardId = world.store.assistantCards.addAssistantCard("aad-a", itemId, 1, false);
  world.store.assistantCards.placeAssistantCard(cardId, {
    activityId: "teams-7",
    reference: { conversation: { id: "personal:aad-a" } },
    render: { kind: "task", seq: 3 },
  });
}

function task(itemId: string, boardState: string, outcome: string | null): WorkItem {
  return {
    itemId,
    seq: 3,
    title: "t",
    boardState,
    resultVersion: 1,
    canAccept: false,
    lastReportKind: null,
    pendingQuestion: null,
    summary: "",
    outcome,
    kind: "task",
    params: {},
    pull: null,
    updatedAt: "",
  };
}

for (const [outcome, ended] of [
  ["accepted", "已结束：已接受"],
  ["dropped", "已结束：已放弃"],
  ["stopped", ITEM_STOPPED_ZH],
  ["answered", "已结束：已完成"],
] as const) {
  test(`the sweep ends a task card from the owners board as claw says it ended (${outcome})`, async () => {
    const world = reviewWorld();
    placeTaskCard(world, "item-t");
    world.claw.workItem = (key, itemId) => {
      assert.equal(key, "ak-alice-linked"); // (read as its owner)
      return task(itemId, "done", outcome);
    };
    assert.equal(await cardsOf(world).closeEnded(), 1);
    const [view] = edits(world);
    assert.equal((view?.model as { ended: string }).ended, ended);
  });
}

test("the sweep leaves a card whose item still runs, and one it could not read is tried again", async () => {
  const world = reviewWorld();
  placeTaskCard(world, "item-t");
  world.claw.workItem = (_key, itemId) => task(itemId, "in_progress", null);
  assert.equal(await cardsOf(world).closeEnded(), 0);
  world.claw.workItem = () => {
    throw new ClawError(503);
  };
  assert.equal(await cardsOf(world).closeEnded(), 0);
  assert.deepEqual(edits(world), []);
  world.claw.workItem = (_key, itemId) => task(itemId, "done", "accepted");
  assert.equal(await cardsOf(world).closeEnded(), 1);
});

test("a card of someone with no key left is not read", async () => {
  const world = reviewWorld();
  placeTaskCard(world, "item-t");
  world.store.links.unlink("aad-a");
  world.claw.workItem = () => assert.fail("read without a key");
  assert.equal(await cardsOf(world).closeEnded(), 0);
});
