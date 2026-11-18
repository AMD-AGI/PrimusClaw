// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ClickRoute, Conversation, InboundAction } from "../../src/index.js";
import {
  ALICE,
  BOB,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const HELD = {
  id: "conf-1",
  actor_user_id: "u-bob",
  repo: "AMD-AGI/Hyperloom",
  pr: 12,
  kind: "merge",
  reasons: ["CI"],
  title: "x",
};

async function reviewed(world: ReviewWorld, wrote = [["gh_pr_merge", "merged", ""]] as const): Promise<Conversation> {
  const message = groupMessage(`请 {Bob} 帮我 review 合入 ${PR}`);
  const conversation = world.surface.conversation(message.conversation);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation,
    scope: CONV,
    lang: () => "zh",
  });
  const [turn] = world.started;
  assert.ok(turn !== undefined);
  turn.review.sessionId = "sess-1";
  await world.service.afterTurn(
    turn.review,
    "没有问题。\nVERDICT: CLEAN",
    { moved: false, refusal: null, ranModel: "m", wrote: [...wrote], prSummary: "" },
    conversation,
  );
  return conversation;
}

function click(world: ReviewWorld, decision: string, who = BOB): { route: ClickRoute; settled: string[] } {
  const settled: string[] = [];
  const conversation = world.surface.conversation({
    id: `personal:${who.id}`,
    kind: "personal",
    tenantId: "tenant-1",
    wire: { conversation: { id: `personal:${who.id}` } },
  });
  const action = {
    type: "action",
    verb: "github_confirm",
    data: { primusclaw: "github_confirm", confirmation: "conf-1", decision },
  } as unknown as InboundAction;
  const route = {
    action,
    sender: who,
    conversation,
    scope: "",
    lang: () => "en" as const,
    settle: (card: unknown) => {
      settled.push(typeof card === "string" ? card : JSON.stringify(card));
      return Promise.resolve(true);
    },
  } as unknown as ClickRoute;
  return { route, settled };
}

async function press(world: ReviewWorld, decision: string, who = BOB): Promise<string[]> {
  const { route, settled } = click(world, decision, who);
  const handler = world.service.routeHandlers().clicks[0];
  await handler?.beforeCredential?.(route);
  return settled;
}

test("a held merge goes to the reviewer alone as a card, and the group is told it waits", async () => {
  const world = reviewWorld();
  world.claw.confirmations = [HELD];
  await reviewed(world);
  assert.ok(world.surface.of("personal:aad-b").some((r) => r.op === "send" && r.message.body.type === "view"));
  assert.ok(saidIn(world.surface, CONV).includes("是高风险变更：我已私信 Bob 请其确认"));
  assert.equal(world.store.githubConfirmations.pendingGithubConfirmations("aad-b").length, 1);
});

test("a confirmation that names another pull request or reviewer is not offered", async () => {
  const world = reviewWorld();
  world.claw.confirmations = [
    { ...HELD, pr: 13 },
    { ...HELD, id: "c2", actor_user_id: "u-x" },
  ];
  await reviewed(world);
  assert.equal(world.store.githubConfirmations.pendingGithubConfirmations("aad-b").length, 0);
});

test("only the reviewer can answer, and allowing merges as them and tells the group", async () => {
  const world = reviewWorld();
  world.claw.confirmations = [HELD];
  await reviewed(world);
  const others = await press(world, "allow", ALICE);
  assert.ok(others[0]?.includes("Only the person this was asked of can answer it."));
  const settled = await press(world, "allow");
  assert.ok(settled[0]?.includes("Merged AMD-AGI/Hyperloom#12 (01234567)."), String(settled[0]));
  assert.deepEqual(
    world.claw.calls.find((c) => c[0] === "decide"),
    ["decide", "tok-aad-b", "conf-1", "allow"],
  );
  assert.ok(saidIn(world.surface, CONV).includes("Bob 已确认，AMD-AGI/Hyperloom#12 已合入（01234567）。"));
  const again = await press(world, "allow");
  assert.ok(again[0]?.includes("already answered"), String(again[0]));
});

test("a typed answer decides as a press does", async () => {
  const world = reviewWorld();
  world.claw.confirmations = [HELD];
  await reviewed(world);
  const dm = world.surface.conversation({
    id: "personal:aad-b",
    kind: "personal",
    tenantId: "tenant-1",
    wire: { conversation: { id: "personal:aad-b" } },
  });
  assert.equal(
    await world.service.routeHandlers().personalInterceptors[0]?.intercept({
      message: groupMessage("确认 #12", BOB, [], "t1", "personal"),
      text: "确认 #12",
      sender: BOB,
      conversation: dm,
      scope: "",
      lang: () => "zh",
    }),
    true,
  );
  assert.ok(saidIn(world.surface, "personal:aad-b").includes("AMD-AGI/Hyperloom#12: Merged"));
});

test("the reviewer is told what was done as them in their own chat", async () => {
  const world = reviewWorld();
  await reviewed(world);
  const notice = saidIn(world.surface, "personal:aad-b");
  assert.ok(
    notice.includes("Alice在Primus 运维群请我以你的名义 review 合入 AMD-AGI/Hyperloom#12") && notice.includes("合入"),
    notice,
  );
  assert.equal(world.store.reviewDelegation.reviewNotices()[0]?.delivered, true);
});

test("nobody is messaged when nothing was left on GitHub", async () => {
  const world = reviewWorld();
  await reviewed(world, [] as never);
  assert.equal(saidIn(world.surface, "personal:aad-b"), "");
});
