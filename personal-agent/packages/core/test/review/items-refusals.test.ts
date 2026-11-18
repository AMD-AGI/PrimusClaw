// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What Claw answers a request for review items, and what the asker hears (`test_review_items`' refusal tests): an older Claw that
 * takes ten at most starts ten and names the rest; one pull request refused for a reason Claw names is named with it (an internal
 * reason only as a reference); a request refused whole, or not answered, starts nothing and says whether it is safe to ask again.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClawError, ClawUnreachable, ReviewsRefused } from "../../src/index.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  withItems,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const PR2 = "AMD-AGI/Hyperloom#13";

function itemsWorld(): ReviewWorld {
  const world = reviewWorld();
  withItems(world);
  return world;
}

async function ask(world: ReviewWorld, prs: readonly string[]): Promise<string> {
  const message = groupMessage(`请 {Bob} 帮我 review 合入 ${prs.join(" ")}`);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
  return saidIn(world.surface, CONV);
}

const started = (world: ReviewWorld) => world.claw.calls.filter((c) => c[0] === "startReviews").length;

test("an older claw that takes ten at most starts ten and names the rest", async () => {
  const world = itemsWorld();
  const port = world.deps.claw.assistant;
  const real = port.startReviews.bind(port);
  (port as { startReviews: typeof port.startReviews }).startReviews = (token, request) =>
    request.prs.length > 10
      ? Promise.reject(new ReviewsRefused(400, "invalid_request", "", { field: "prs" }))
      : real(token, request);
  const prs = Array.from({ length: 12 }, (_, i) => `AMD-AGI/Hyperloom#${String(i + 1)}`);
  const said = await ask(world, prs);
  assert.ok(
    said.includes("AMD-AGI/Hyperloom#11（PrimusClaw 这一版一次只接受 10 个，这个没有开始，请稍后单独再发"),
    said,
  );
  assert.equal(world.surface.of("personal:aad-a").filter((r) => r.op === "post").length, 10);
});

test("a pull request claw refuses for a reason it names is named with that reason and the other goes on", async () => {
  const world = itemsWorld();
  world.claw.refuse.set(PR2.toLowerCase(), [409, "pr_check_failed", { reason: "already_merged" }]);
  const port = world.deps.claw.assistant;
  const real = port.startReviews.bind(port);
  let calls = 0;
  (port as { startReviews: typeof port.startReviews }).startReviews = (token, request) => {
    calls += 1;
    if (calls > 1) world.claw.refuse.clear(); // (asked again without it, the other starts)
    return real(token, request);
  };
  const said = await ask(world, [PR, PR2]);
  assert.ok(said.includes(`${PR2}（已经合入了）`), said);
  assert.equal(world.surface.of("personal:aad-a").filter((r) => r.op === "post").length, 1);
});

test("a pull request check refused for an internal reason says only a reference", async () => {
  const world = itemsWorld();
  (world.deps.errors as unknown as { publicReason: () => string }).publicReason = () => "参考号 ref-1";
  world.claw.refuse.set(PR.toLowerCase(), [409, "pr_check_failed", { reason: "db at 10.0.0.7 timed out" }]);
  const said = await ask(world, [PR]);
  assert.ok(said.includes("PrimusClaw 没有接受（参考号 ref-1）"), said);
  assert.ok(!said.includes("10.0.0.7"));
});

test("a request claw refuses whole with an error status starts nothing", async () => {
  const world = itemsWorld();
  world.claw.refuseAll = new ClawError(500, "internal");
  const said = await ask(world, [PR, PR2]);
  assert.ok(said.includes("PrimusClaw 没有接受这次 review 请求（错误 500），一个也没有开始。"), said);
  assert.equal(world.surface.of("personal:aad-a").filter((r) => r.op === "post").length, 0);
});

test("no answer from claw starts nothing here and says it is safe to ask again", async () => {
  const world = itemsWorld();
  world.claw.refuseAll = new ClawUnreachable("timeout", "POST /v1/assistant/reviews");
  const said = await ask(world, [PR]);
  assert.ok(
    said.includes(
      "我暂时没能从 PrimusClaw 得到回答，不确定 review 是否已经开始。请稍后再发一次（同一个 PR 不会重复开始）。",
    ),
    said,
  );
  assert.equal(world.started.length, 0);
  assert.equal(started(world), 1);
});

test("a pull request claw answers no item for is named as not started", async () => {
  const world = itemsWorld();
  const starts = world.claw.starts;
  world.claw.starts = (token, request) => (starts?.(token, request) ?? []).slice(0, 1);
  const said = await ask(world, [PR, PR2]);
  assert.ok(said.includes(`${PR2}（PrimusClaw 没有开始它）`), said);
});
