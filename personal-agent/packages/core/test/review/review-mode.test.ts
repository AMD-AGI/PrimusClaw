// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ClickRoute, InboundAction } from "../../src/index.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const DM = `personal:${ALICE.id}`;

function dm(world: ReviewWorld) {
  return world.surface.conversation({ id: DM, kind: "personal", tenantId: "t", wire: { conversation: { id: DM } } });
}

async function click(world: ReviewWorld, mode: unknown): Promise<string> {
  const settled: string[] = [];
  const route = {
    action: {
      type: "action",
      verb: "primusclaw.github_mode",
      data: { primusclaw: "github_mode", mode },
    } as unknown as InboundAction,
    sender: ALICE,
    conversation: dm(world),
    scope: "",
    lang: () => "en" as const,
    settle: (card: unknown) =>
      Promise.resolve(settled.push(typeof card === "string" ? card : JSON.stringify(card)) > 0),
  } as unknown as ClickRoute;
  await world.service.routeHandlers().clicks[0]?.beforeCredential?.(route);
  return settled.join(" ");
}

function modeCards(world: ReviewWorld): number {
  return world.surface
    .of(DM)
    .filter((r) => "message" in r && r.message.body.type === "view" && r.message.body.view.name === "reviewMode")
    .length;
}

const writes = (world: ReviewWorld) => world.claw.calls.filter((c) => c[0] === "setReviewMode");

test("a bound person changes it with a click and status shows both switches", async () => {
  const world = reviewWorld();
  const answer = await click(world, "fully_auto");
  assert.ok(answer.includes("Confirmation is now: Fully automatic merge"), answer);
  assert.deepEqual(writes(world), [["setReviewMode", "tok-aad-a", "fully_auto"]]);
  await world.service.account.command(ALICE, "status", dm(world));
  const status = saidIn(world.surface, DM);
  assert.ok(status.includes("Auto-merge (colleagues may ask me to review and merge as you): off"));
  assert.ok(
    status.includes("Confirmation (for every review and merge with your account): Fully automatic merge"),
    status,
  );
});

test("a click that names no setting changes nothing", async () => {
  for (const mode of ["sometimes", undefined]) {
    const world = reviewWorld();
    assert.ok((await click(world, mode)).includes("no longer active"));
    assert.deepEqual(writes(world), []);
  }
});

test("a click before github is connected says how", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice");
  assert.ok((await click(world, "fully_auto")).includes("/github bind"));
  assert.deepEqual(writes(world), []);
});

test("a change claw does not take changes nothing and says so", async () => {
  const world = reviewWorld();
  world.claw.modeError = 503;
  const answer = await click(world, "fully_auto");
  assert.ok(answer.includes("nothing changed") && !answer.includes("已改为"), answer);
});

test("status says when the setting cannot be read", async () => {
  const world = reviewWorld();
  world.claw.modeError = 503;
  await world.service.account.command(ALICE, "status", dm(world));
  assert.ok(saidIn(world.surface, DM).includes("not known just now (PrimusClaw did not answer)"));
});

test("with no reading only the plainest words bring the card", async () => {
  for (const [text, card] of [
    ["改成全自动", true],
    ["帮我写一个 ask me anything 页面", false],
    ["代审直接合，不用问我", false],
  ] as const) {
    const world = reviewWorld();
    assert.equal(await world.service.modeMessage(ALICE, text, dm(world)), card, text);
    assert.equal(modeCards(world) > 0, card, text);
  }
});

test("before claw has the setting people are told it is not available yet", async () => {
  const world = reviewWorld();
  world.claw.modeError = 404;
  await world.service.account.command(ALICE, "mode", dm(world));
  assert.equal(modeCards(world), 0);
  assert.ok(saidIn(world.surface, DM).includes("This setting is not available yet"));
});

test("before claw has the setting a review goes on as by default", async () => {
  const world = reviewWorld();
  world.claw.modeError = 404;
  const message = groupMessage(`请 {Bob} 帮我 review 合入 ${PR}`);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
  assert.equal(world.started[0]?.review.reviewMode, "high_risk_confirm");
});

test("the group hears when the reviewer chose fully automatic", async () => {
  const world = reviewWorld();
  world.claw.reviewModes.set("tok-aad-b", "fully_auto");
  const message = groupMessage(`请 {Bob} 帮我 review 合入 ${PR}`);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
  const [turn] = world.started;
  assert.ok(turn?.review.ack.includes("Bob 已设为全自动合入"), turn?.review.ack);
  const line = turn.turn.onGithubResult(["gh_pr_merge", "merged", ""], "m");
  assert.ok(line?.includes("按 Bob 的全自动设置，无需人工确认"), line);
});

test("the review prompt asks the model to say a write was made under the fully automatic setting", async () => {
  const world = reviewWorld();
  const message = groupMessage(`请 {Bob} 帮我 review 合入 ${PR}`);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
  assert.ok(world.started[0]?.prompt.includes("已按 Bob 的全自动设置合入"));
});
