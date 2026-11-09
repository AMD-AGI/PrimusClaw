// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A request that cannot start says why, in one line where it was asked, and starts nothing (`github_review.py`'s `_group_request`
 * checks): too many pull requests, two models, only other owners' repositories, a reviewer whose GitHub cannot be read now or who
 * has not allowed it, one who cannot be acted as, a model the paying key cannot use or that cannot be checked.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClawError, err } from "../../src/index.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

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

async function refused(world: ReviewWorld, text: string, expected: string): Promise<void> {
  await ask(world, text);
  const said = saidIn(world.surface, CONV);
  assert.ok(said.includes(expected), said);
  assert.equal(world.started.length, 0);
  assert.deepEqual(
    world.claw.calls.filter((c) => c[0] === "startReviews"),
    [],
  );
}

test("more pull requests than one request takes start nothing", async () => {
  const many = Array.from({ length: 31 }, (_, i) => `AMD-AGI/Hyperloom#${String(i + 1)}`).join(" ");
  await refused(
    reviewWorld(),
    `请 {Bob} 帮我 review 合入 ${many}`,
    "一次最多交给我 30 个 PR（前 10 个立即开始，其余排队自动开始），这次有 31 个",
  );
});

test("two models in one request start nothing", async () => {
  const world = reviewWorld();
  await refused(world, `请 {Bob} 用 gpt-6-luna 帮我 review 合入 ${PR} model: claude-opus-5.5`, "一次只能指定一个模型");
  assert.deepEqual(world.identity.requests, []);
});

test("only other owners pull requests start nothing and say which owners are taken", async () => {
  await refused(
    reviewWorld(),
    `请 {Bob} 帮我 review 合入 someone/x#1 someone/y#2`,
    "没有开始任何 review：someone/x#1（只处理 AMD-AGI 的公开仓库）",
  );
});

test("a reviewer whose github cannot be read now starts nothing", async () => {
  const world = reviewWorld();
  world.identity.down = true;
  await refused(world, `请 {Bob} 帮我 review 合入 ${PR}`, "暂时无法确认 Bob 的 GitHub 绑定，请稍后再试。");
});

test("a reviewer who has not allowed it starts nothing", async () => {
  const world = reviewWorld();
  world.identity.know("aad-b", "u-bob", "bob-gh", false);
  await refused(
    world,
    `请 {Bob} 帮我 review 合入 ${PR}`,
    "Bob 还没有授权我代 TA review 合入（需要 TA 在 1:1 里发 `/github auto-merge on`",
  );
});

test("a reviewer whose token cannot be exchanged now starts nothing", async () => {
  const world = reviewWorld();
  const exchange = world.deps.exchange as { tokenFor: ReviewWorld["deps"]["exchange"]["tokenFor"] };
  const real = exchange.tokenFor;
  exchange.tokenFor = (userId) =>
    userId === "aad-b" ? Promise.resolve(err({ kind: "exchange_failed" as const, reason: "down" })) : real(userId);
  await refused(
    world,
    `请 {Bob} 帮我 review 合入 ${PR}`,
    "我暂时联系不上 Primus 平台，没能确认 Bob 的身份，所以没有开始 review。",
  );
});

test("a model whose availability cannot be checked starts nothing", async () => {
  const world = reviewWorld();
  world.claw.models = new ClawError(503);
  await refused(
    world,
    `请 {Bob} 用 claude-opus-5.5 帮我 review 合入 ${PR}`,
    "暂时没法向 PrimusClaw 确认Bob 的 key 能用哪些模型，所以没有用 claude-opus-5.5 开始 review。",
  );
});

test("a model the paying key cannot use says which it can", async () => {
  const world = reviewWorld();
  world.claw.models = ["claude-sonnet-5.5"];
  await refused(
    world,
    `请 {Bob} 用 gpt-6-luna 帮我 review 合入 ${PR}`,
    "Bob 的 key 用不了模型 gpt-6-luna，所以没有开始 review。可以用的模型：claude-sonnet-5.5。",
  );
  const none = reviewWorld();
  none.claw.models = [];
  await refused(none, `请 {Bob} 用 gpt-6-luna 帮我 review 合入 ${PR}`, "Bob 的 key 目前没有可用的模型。");
});

test("a model written in another case is the one the key can use", async () => {
  const world = reviewWorld();
  await ask(world, `请 {Bob} 用 Claude-Opus-5.5 帮我 review 合入 ${PR}`);
  assert.equal(world.started[0]?.turn.reviewModel, "claude-opus-5.5");
});

test("a reviewer who has not allowed it is told for a review only too", async () => {
  const world = reviewWorld();
  world.identity.know("aad-b", "u-bob", "bob-gh", false);
  await refused(
    world,
    `请 {Bob} 帮我 review ${PR}`,
    "Bob 还没有授权我代 TA review（需要 TA 在 1:1 里发 `/github auto-merge on`",
  );
});

test("asking oneself needs no authorization of ones own", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh", false);
  world.store.members.rememberMember("29:a", "aad-a", "Alice");
  world.github.defaultAuthor = "carol-gh";
  const message = groupMessage(`请 {Alice} 帮我 review 合入 ${PR}`, ALICE, [ALICE]);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
  assert.deepEqual(
    world.started.map((s) => s.turn.actingAs),
    ["u-alice"],
  );
});

test("a reviewer with no name the worker knows is called the other person", async () => {
  const world = reviewWorld();
  world.identity.know("aad-b", "u-bob", "bob-gh", false);
  world.store.members.rememberMember("29:b", "aad-b", "");
  const message = groupMessage(`请 {Bob} 帮我 review 合入 ${PR}`);
  const nameless = { ...message, mentions: message.mentions.map((m) => ({ ...m, name: "" })) };
  await world.service.request({
    message: nameless,
    text: nameless.text,
    sender: ALICE,
    conversation: world.surface.conversation(nameless.conversation),
    scope: CONV,
    lang: () => "zh",
  });
  assert.equal(world.started.length, 0);
  assert.ok(saidIn(world.surface, CONV).includes("还没有授权我代 TA review 合入"), saidIn(world.surface, CONV));
});

test("a reviewer whose token the exchange is not set up to give starts nothing", async () => {
  const world = reviewWorld();
  const exchange = world.deps.exchange as { tokenFor: ReviewWorld["deps"]["exchange"]["tokenFor"] };
  const real = exchange.tokenFor;
  exchange.tokenFor = (userId) =>
    userId === "aad-b" ? Promise.resolve(err({ kind: "exchange_unavailable" as const })) : real(userId);
  await refused(
    world,
    `请 {Bob} 帮我 review 合入 ${PR}`,
    "我暂时联系不上 Primus 平台，没能确认 Bob 的身份，所以没有开始 review。",
  );
});
