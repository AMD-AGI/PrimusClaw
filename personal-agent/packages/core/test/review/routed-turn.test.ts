// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review's turn on the router's `startTurn` (`routedReviewTurns`, Python `_start_turn` and `_guarded` for a review): what the
 * router is given for it, the session that is the review's own and is noted as acting at once, and what follows its end.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { routedReviewTurns, type StartReviewTurn } from "../../src/index.js";
import type { Chat } from "../../src/routing/chat.js";
import type { StartTurn } from "../../src/routing/turn-start.js";
import type { ReviewTurnOutcome } from "../../src/turn/runner.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  withItems,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const OUTCOME: ReviewTurnOutcome = { moved: false, refusal: null, ranModel: "m", wrote: [], prSummary: "" };

async function asked(world: ReviewWorld, text: string, people = undefined as Parameters<typeof groupMessage>[2]) {
  const message = groupMessage(text, ALICE, people);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
  const [request] = world.started;
  assert.ok(request !== undefined);
  return request as StartReviewTurn;
}

function routed(world: ReviewWorld, running: { done: Promise<void> } | "refused" = { done: Promise.resolve() }) {
  const starts: StartTurn[] = [];
  const after: [string, string, ReviewTurnOutcome, string][] = [];
  const chat = { scope: CONV } as unknown as Chat;
  const startTurn = routedReviewTurns(
    (request) => {
      starts.push(request);
      return Promise.resolve(running === "refused" ? undefined : running);
    },
    () => chat,
    world.store,
    (review, finalAnswer, outcome, conversation) => {
      after.push([review.sessionId, finalAnswer, outcome, conversation.ref.id]);
      return Promise.resolve();
    },
  );
  return { startTurn, starts, after, chat };
}

test("a review asked of someone else is started on the router as a session of its own", async () => {
  const world = reviewWorld();
  const request = await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  const { startTurn, starts, chat } = routed(world);
  const started = await startTurn(request);
  assert.ok(started !== undefined);
  const [start] = starts;
  assert.ok(start?.review !== undefined);
  assert.equal(start.chat, chat);
  assert.deepEqual(
    [start.credential, start.text, start.messageId, start.clientPlatform],
    [request.token, request.prompt, request.message.id, request.message.clientPlatform],
  );
  const { review } = start;
  // (no item: the turn makes the session, and the review is kept per pull request)
  assert.deepEqual([review.itemId, review.itemSessionId, review.pull, review.lang], ["", null, PR, "zh"]);
  assert.deepEqual(review.fields, { kind: "review", turn: request.turn });
});

test("a review of ones own item follows the item's session", async () => {
  const world = reviewWorld();
  withItems(world, { seqFrom: 1 });
  world.store.members.rememberMember("29:a", "aad-a", "Alice");
  world.identity.know("aad-a", "u-alice", "alice-gh", true);
  world.github.defaultAuthor = "carol-gh";
  const request = await asked(world, `请 {Alice} 帮我 review 合入 ${PR}`, [ALICE]);
  const { startTurn, starts } = routed(world);
  await startTurn(request);
  assert.deepEqual([starts[0]?.review?.itemId, starts[0]?.review?.itemSessionId], ["item-1", "s-1"]);
});

test("the session is the review's and is noted as acting at once", async () => {
  const world = reviewWorld();
  const request = await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  const { startTurn, starts } = routed(world);
  await startTurn(request);
  assert.equal(world.store.reviewDelegation.isActingSession("sess-9"), false);
  starts[0]?.review?.onSession("sess-9");
  assert.equal(request.review.sessionId, "sess-9");
  assert.equal(world.store.reviewDelegation.isActingSession("sess-9"), true);
});

test("the review service reads the turn once it is over, and only a review's outcome", async () => {
  const world = reviewWorld();
  const request = await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  const { startTurn, starts, after } = routed(world);
  await startTurn(request);
  const review = starts[0]?.review;
  assert.ok(review !== undefined);
  await review.after({ finalAnswer: "chat only" });
  assert.deepEqual(after, []);
  review.onSession("sess-9");
  await review.after({ finalAnswer: "VERDICT: CLEAN", review: OUTCOME });
  assert.deepEqual(after, [["sess-9", "VERDICT: CLEAN", OUTCOME, CONV]]);
});

test("a turn the router did not start is no turn, and one it started ends with the router's", async () => {
  const world = reviewWorld();
  const request = await asked(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.equal(await routed(world, "refused").startTurn(request), undefined);
  let end: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    end = resolve;
  });
  const started = await routed(world, { done }).startTurn(request);
  let ended = false;
  void started?.ended.then(() => {
    ended = true;
  });
  await Promise.resolve();
  assert.equal(ended, false);
  end();
  await done;
  await Promise.resolve();
  assert.equal(ended, true);
});
