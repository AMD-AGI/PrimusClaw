// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model a review for a colleague runs on (`test_review_model_default`): the model its request names, else the deployment's
 * review setting (the service's `defaultModel`); empty, the turn runs on the chat's own model. The finished review names it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const REVIEW_MODEL = "claude-opus-5.5"; // PERSONAL_AGENT_REVIEW_MODEL as a deployment sets it

function deployed(reviewModel = REVIEW_MODEL): ReviewWorld {
  const world = reviewWorld();
  (world.deps as { defaultModel: string }).defaultModel = reviewModel;
  return world;
}

async function ask(world: ReviewWorld, text: string): Promise<void> {
  const message = groupMessage(text);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

test("a review without a named model asks for the review model", async () => {
  const world = deployed();
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  const [turn] = world.started;
  assert.equal(turn?.turn.actingAs, "u-bob");
  assert.equal(turn.turn.reviewModel, REVIEW_MODEL);
});

test("a model the request names wins over the review model", async () => {
  const world = deployed();
  await ask(world, `请 {Bob} 用 gpt-6-luna 帮我 review 合入 ${PR}`);
  assert.equal(world.started[0]?.turn.reviewModel, "gpt-6-luna");
});

test("an empty review setting runs reviews on the chats own model", async () => {
  const world = deployed("");
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  // (no model asked for: the turn runs on the chat's own model, PERSONAL_AGENT_MODEL)
  assert.equal(world.started[0]?.turn.reviewModel, "");
});

for (const [name, routed, note] of [
  ["the setting", REVIEW_MODEL, "（模型：claude-opus-5.5）"],
  ["what the gateway says", "claude-opus-5.5-20261101", "（模型：claude-opus-5.5-20261101）"],
] as const) {
  test(`the finished review names the model it ran on (${name})`, async () => {
    const world = deployed();
    await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
    const [turn] = world.started;
    assert.ok(turn);
    const shown = turn.turn.shapeAnswer("没有发现必须修改的问题。\nVERDICT: CLEAN", "", routed, [], 0, "");
    assert.ok(shown.includes(note) && !shown.includes("claude-sonnet-5.5"), shown);
    turn.review.sessionId = "sess-1";
    await world.service.afterTurn(
      turn.review,
      "没有发现必须修改的问题。\nVERDICT: CLEAN",
      {
        moved: false,
        refusal: null,
        ranModel: routed,
        wrote: [["gh_review_submit", "submitted", "APPROVE"]],
        prSummary: "",
      },
      world.surface.conversation(groupMessage("x").conversation),
    );
    const dm = saidIn(world.surface, "personal:aad-b");
    assert.ok(dm.includes(note), dm);
  });
}
