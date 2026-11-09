// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReviewStart } from "../../src/claw/model.js";
import type { MessageRoute } from "../../src/ports/routing.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

function route(world: ReviewWorld, text: string, kind: "group" | "personal" = "group", id = "g1"): MessageRoute {
  const message = groupMessage(text, ALICE, undefined, id, kind);
  return {
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: kind === "group" ? CONV : "",
    lang: () => "zh",
  };
}

async function ask(
  world: ReviewWorld,
  text = `请 {Bob} 帮我 review 合入 ${PR}`,
  kind: "group" | "personal" = "group",
): Promise<boolean> {
  return world.service.request(route(world, text, kind));
}

const ASK_WHO = "请指定由谁来 review 合入，例如 @Clawy 请 XX 帮我 review 合入 <PR>";

test("a request that names nobody gets one question and nothing else", async () => {
  const world = reviewWorld();
  assert.equal(await ask(world, `帮我 review 合入 ${PR}`), true);
  assert.equal(saidIn(world.surface, CONV), ASK_WHO);
  assert.deepEqual(world.claw.calls, []);
  assert.deepEqual(world.identity.requests, []);
  assert.equal(world.surface.outbox.length, 1);
});

test("the question for a missing name is the one the design gives", async () => {
  const world = reviewWorld();
  await ask(world, `帮我 review 合入 ${PR}`);
  assert.equal(saidIn(world.surface, CONV), ASK_WHO);
});

test("a request without a pull request asks back", async () => {
  const world = reviewWorld();
  await ask(world, "请 {Bob} 帮我 review 合入");
  assert.ok(saidIn(world.surface, CONV).includes("请附上要 review 合入的 PR"));
  assert.deepEqual(world.claw.calls, []);
  assert.deepEqual(world.identity.requests, []);
});

test("only public repositories of the allowed owners are taken", async () => {
  const world = reviewWorld();
  await ask(world, "请 {Bob} 帮我 review 合入 someone-else/repo#3");
  assert.ok(saidIn(world.surface, CONV).includes("AMD-AGI"));
  assert.deepEqual(world.claw.calls, []);
  assert.deepEqual(world.identity.requests, []);
});

test("a named reviewer with github gets a session of the askers that acts as them", async () => {
  const world = reviewWorld();
  await ask(world);
  const [turn] = world.started;
  assert.ok(turn !== undefined, saidIn(world.surface, CONV));
  assert.equal(turn.token, "tok-aad-a");
  assert.equal(turn.turn.actingAs, "u-bob");
  assert.deepEqual(turn.turn.reviewTarget, { owner: "AMD-AGI", repo: "Hyperloom", number: 12 });
  assert.ok(turn.prompt.includes(PR) && turn.prompt.includes("https://github.com/AMD-AGI/Hyperloom/pull/12"));
  assert.ok(turn.prompt.includes("review_instructions") && !turn.prompt.includes("帮我"));
  // (a Claw without review items: the session is made here, on the asker's own key)
  assert.equal(turn.modelKey, "ak-alice-linked");
});

test("a reviewer without github gets the steps in their own chat once a day", async () => {
  const world = reviewWorld();
  world.identity.know("aad-b", "u-bob", null, true);
  await ask(world);
  await ask(world);
  assert.deepEqual(world.started, []);
  assert.ok(saidIn(world.surface, CONV).includes("Bob 还没有绑定 GitHub"));
  const steps = saidIn(world.surface, "personal:aad-b");
  assert.equal(steps.split("asked me in a group chat to review and merge").length - 1, 1);
});

test("a reviewer whose switch is off starts nothing and the group is told", async () => {
  const world = reviewWorld();
  world.identity.know("aad-b", "u-bob", "bob-gh", false);
  await ask(world);
  assert.deepEqual(world.started, []);
  assert.ok(saidIn(world.surface, CONV).includes("Bob 还没有授权我代 TA review 合入"));
});

test("a committer cannot review and merge their own pull request and nothing is started", async () => {
  const world = reviewWorld();
  world.github.authors.set("amd-agi/hyperloom#12", "bob-gh");
  await ask(world);
  assert.deepEqual(world.started, []);
  assert.ok(saidIn(world.surface, CONV).includes("是 Bob 自己提交的"));
});

test("an asker who is not connected gets the onboarding and the request is not replayed", async () => {
  const world = reviewWorld();
  world.bound.delete("aad-a");
  await ask(world);
  assert.equal(world.said.onboard, 1);
  assert.deepEqual(world.started, []);
  assert.ok(saidIn(world.surface, CONV).includes("只用 API key 连接的账号不行"));
});

function items(world: ReviewWorld, queued = ""): void {
  world.claw.starts = (_token, request) =>
    (request.prs as { pull: ReviewStart["target"] }[]).map((p, i) => ({
      target: p.pull,
      itemId: `it-${String(i + 1)}`,
      seq: 7 + i,
      title: "",
      sessionId: "",
      messageId: "",
      model: null,
      fellBackFrom: "",
      ignored: [],
      mergeNeedsConfirmation: null,
      queued,
      mergeByRequester: false,
    }));
}

test("a review asked of someone else becomes their item: the reviewer is told, the asker gets a card with Stop", async () => {
  const world = reviewWorld();
  items(world);
  await ask(world);
  assert.deepEqual(world.started, []); // (the reviewer's own item: no turn here)
  const [, token, request] = world.claw.calls.find((c) => c[0] === "startReviews") ?? [];
  assert.equal(token, "tok-aad-a");
  assert.equal((request as Record<string, unknown>).actingToken, "tok-aad-b");
  assert.equal((request as Record<string, unknown>).actingKey, "ak-bob-linked");
  assert.ok(saidIn(world.surface, "personal:aad-b").includes("请你代 review 合入 AMD-AGI/Hyperloom#12"));
  const card = world.surface.of("personal:aad-a").find((r) => r.op === "post");
  assert.ok(card !== undefined);
  // (followed for the asker, and kept so a restart follows it again)
  assert.deepEqual(
    world.store.reviewDelegation.askerFollows().map((f) => f.itemId),
    ["it-1"],
  );
});

test("two people named is a question back", async () => {
  const world = reviewWorld();
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}\n请 {Carol} review 合入 AMD-AGI/Hyperloom#13`);
  assert.deepEqual(world.started, []);
  assert.ok(saidIn(world.surface, CONV).includes("只能请同一位 reviewer"));
});

test("in a 1:1 chat naming nobody reviews with the asker's own account", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh", false);
  world.github.defaultAuthor = "someone-else";
  await ask(world, `帮我 review 合入 ${PR}`, "personal");
  const [turn] = world.started;
  assert.equal(turn?.turn.actingAs, "u-alice");
});
