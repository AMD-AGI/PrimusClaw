// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Requests in a group, end to end with the model stubbed (`test_bare_pull_numbers`): a reviewer typed by a short name is found
 * in Teams' member list, and pull requests written by number alone are read in the repository the message names, or asked
 * about, never guessed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IntentReader } from "../../src/index.js";
import { MEMBERS } from "../../../../test-support/review-requests.js";
import {
  ALICE,
  CONV,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const PR245 = "AMD-AGI/PrimusClaw#245";
const PR246 = "AMD-AGI/PrimusClaw#246";

/** The model, answering what a test says it answers. */
function stubIntent(prs: readonly string[]): IntentReader {
  const answer = { intent: "review_merge", reviewer: "linmei", reviewers: ["linmei"], prs: [...prs], model: "" };
  return {
    read: () => Promise.resolve(answer),
    readMode: () => Promise.resolve(undefined),
    readAnswer: () => Promise.resolve(undefined),
  };
}

/** The group's member list as Teams returns it, and nothing else about Lin: the worker has never seen her write. */
function setup(prs: readonly string[], model = true): ReviewWorld {
  const world = reviewWorld(["AMD-AGI"], {
    rosters: { [CONV]: MEMBERS },
    ...(model ? { intent: stubIntent(prs) } : {}),
  });
  world.identity.know("aad-w", "u-lin", "lin-gh", true);
  world.bound.add("aad-w");
  world.link("aad-w", "Lin, Mei", "ak-lin-linked");
  return world;
}

async function ask(world: ReviewWorld, text: string): Promise<void> {
  const message = groupMessage(text, ALICE, []);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

const targets = (world: ReviewWorld) =>
  world.started
    .filter((s) => s.turn.actingAs)
    .map(({ turn: { reviewTarget: t } }) => `${t.owner}/${t.repo}#${String(t.number)}`);
/** What the group reads: the lines said there, and a single review's acknowledgement atop its progress message. */
const groupText = (world: ReviewWorld) =>
  [saidIn(world.surface, CONV), ...world.started.map((s) => s.review.ack)].filter(Boolean).join(" ");

const MESSAGES = [
  ["full", `请 linmei 帮我review并合入PR ${PR245} 和 ${PR246}`, [PR245, PR246]],
  ["bare", "请 linmei 帮我review并合入PrimusClaw PR 245和246", ["245", "246"]],
  ["hash", "请 linmei 帮我review并合入PrimusClaw PR #245和 #246", ["#245", "#246"]],
  ["glued", "请linmei帮我review并合入PrimusClaw PR 245和246", ["245", "246"]], // (no space between the name and Chinese)
] as const;

for (const model of [true, false]) {
  for (const [name, text, prs] of MESSAGES) {
    test(`the three messages start both reviews as the named reviewer (${name}, ${model ? "model" : "rules"})`, async () => {
      const world = setup(prs, model);
      await ask(world, text);
      const said = groupText(world);
      assert.deepEqual(targets(world), [PR245, PR246], said);
      assert.deepEqual(new Set(world.started.map((s) => s.turn.actingAs)), new Set(["u-lin"]));
      assert.ok(!said.includes("认不出") && !said.includes("请附上"), said);
      assert.equal(said.includes("按 AMD-AGI/PrimusClaw 处理"), name !== "full", said);
    });
  }
}

test("a bare number with no repository anywhere is asked about", async () => {
  const world = setup(["#245"]);
  await ask(world, "请 linmei 帮我review并合入 #245");
  assert.deepEqual(targets(world), []);
  assert.ok(groupText(world).includes("是哪个仓库的 #245"), groupText(world));
});

test("a bare number takes the one other repository the message names", async () => {
  const world = setup([PR245, "#246"]);
  await ask(world, `请 linmei 帮我review并合入 ${PR245} 和 #246`);
  assert.deepEqual(targets(world), [PR245, PR246], groupText(world));
});

test("a repository name github does not have is asked about", async () => {
  const world = setup(["#245"]);
  await ask(world, "请 linmei 帮我review并合入 PrimsClaw PR #245");
  assert.deepEqual(targets(world), []);
  assert.ok(groupText(world).includes("没有找到仓库「PrimsClaw」"), groupText(world));
});

const RATE_LIMITED = { status: 403, body: { message: "API rate limit exceeded" } };

test("a rate limited github still reads the repository of the one allowed owner", async () => {
  const world = setup(["245", "246"]);
  world.github.reply = RATE_LIMITED;
  await ask(world, "请 linmei 帮我review并合入PrimusClaw PR 245和246");
  assert.deepEqual(targets(world), [PR245, PR246], groupText(world));
  assert.ok(groupText(world).includes("按 AMD-AGI/PrimusClaw 处理"));
});

for (const text of [
  "请 linmei 帮我review并合入 my PR #245",
  "请 linmei 帮我review并合入 this PR 245",
  "请 linmei 帮我review并合入 API PR #245",
]) {
  test(`a rate limited github never reads a plain word as a repository (${text})`, async () => {
    const world = setup(["#245"]);
    world.github.reply = RATE_LIMITED;
    await ask(world, text);
    const said = groupText(world);
    assert.deepEqual(targets(world), []);
    assert.ok(said.includes("是哪个仓库的 #245") && !said.includes("AMD-AGI/my"), said);
  });
}

test("the askers recent repository is the last resort", async () => {
  const world = setup(["PR 7"]);
  world.store.repoHistory.touchRecentRepo("aad-a", { repo: "AMD-AGI/Hyperloom", branch: "" });
  await ask(world, "请 linmei 帮我review并合入 PR 7");
  assert.deepEqual(targets(world), ["AMD-AGI/Hyperloom#7"], groupText(world));
  assert.ok(groupText(world).includes("按 AMD-AGI/Hyperloom 处理"));
});

test("a message that is not a review request is not read for numbers", async () => {
  const world = setup([]);
  await ask(world, "PR #245 是做什么的？");
  assert.deepEqual(targets(world), []);
  assert.ok(!groupText(world).includes("是哪个仓库"));
});

const TEN = [248, 232, 243, 241, 238, 236, 233, 234, 237, 235];
const TEN_TEXT = `请 linmei 帮我review并合入PrimusClaw PR ${TEN.join(" ")}`;
const TEN_PRS = TEN.map((n) => `AMD-AGI/PrimusClaw#${String(n)}`);
const AS_WRITTEN: Record<string, readonly string[] | undefined> = {
  full: TEN_PRS,
  bare: TEN.map(String),
  "one-entry": [`PrimusClaw PR ${TEN.join(" ")}`],
  rules: undefined,
};

for (const [name, prs] of Object.entries(AS_WRITTEN)) {
  test(`ten numbers separated by spaces start ten reviews (${name})`, async () => {
    const world = setup(prs ?? [], prs !== undefined);
    await ask(world, TEN_TEXT);
    const said = groupText(world);
    assert.deepEqual(targets(world), TEN_PRS, said);
    assert.ok(said.includes("按 AMD-AGI/PrimusClaw 处理") && said.includes("这 10 个 PR"), said);
    assert.ok(!said.includes("没有当作 PR"), said);
  });
}

test("ten numbers with github rate limited still start ten reviews", async () => {
  const world = setup(TEN_PRS);
  world.github.reply = RATE_LIMITED;
  await ask(world, TEN_TEXT);
  assert.deepEqual(targets(world), TEN_PRS, groupText(world));
});

test("a number the model leaves out is named in the acknowledgement", async () => {
  const world = setup(TEN_PRS.slice(0, 1));
  await ask(world, TEN_TEXT);
  const said = groupText(world);
  assert.deepEqual(targets(world), ["AMD-AGI/PrimusClaw#248"]);
  assert.ok(
    said.includes(
      `这些数字没有当作 PR：${TEN.slice(1)
        .map((n) => `#${String(n)}`)
        .join("、")}`,
    ),
    said,
  );
});

const MIXED: [string, number[]][] = [
  ["PrimusClaw PR 245, 246 和 #247\n248；249、250 and 251", [245, 246, 247, 248, 249, 250, 251]],
  ["PrimusClaw PR #245 246,247，248", [245, 246, 247, 248]],
  ["PrimusClaw PR\n245\n246\n247", [245, 246, 247]],
  ["PrimusClaw PR 245和246和247", [245, 246, 247]],
];

for (const model of [true, false]) {
  MIXED.forEach(([text, numbers], i) => {
    test(`a list in any mix of separators takes every number (${String(i)}, ${model ? "model" : "rules"})`, async () => {
      const prs = numbers.map((n) => `AMD-AGI/PrimusClaw#${String(n)}`);
      const world = setup(prs, model);
      await ask(world, `请 linmei 帮我review并合入${text}`);
      assert.deepEqual(targets(world), prs, groupText(world));
      assert.ok(!groupText(world).includes("没有当作 PR"));
    });
  });
  for (const taken of [[245], [245, 246]]) {
    test(`a number written apart from the list is named never dropped (${taken.length > 1 ? "several" : "one"}, ${model ? "model" : "rules"})`, async () => {
      const prs = taken.map((n) => `AMD-AGI/PrimusClaw#${String(n)}`);
      const world = setup(prs, model);
      await ask(world, `请 linmei 帮我review并合入PrimusClaw PR ${taken.join(" ")}，另外还有 247`);
      const said = groupText(world);
      assert.deepEqual(targets(world), prs, said);
      assert.ok(said.includes("这些数字没有当作 PR：#247"), said);
    });
  }
}
