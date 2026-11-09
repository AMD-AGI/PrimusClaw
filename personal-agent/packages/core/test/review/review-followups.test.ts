// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Three follow-ups of the review for a colleague (`test_review_followups`): "请 XX 帮我 review <PR>" asks for a review only (never
 * merged: the prompt says so and the session is made review only); the prompt says which language to answer in; and the result
 * line is known the moment the stream shows the merge (or the hold, or the review of a review only).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IntentReader } from "../../src/index.js";
import { reviewPrompt } from "../../src/review/prompts.js";
import { resultLine } from "../../src/review/receipt.js";
import { reviewTurn } from "../../src/review/review-turn.js";
import { githubWrite } from "../../src/turn/github-outcome.js";
import { ALICE, CONV, groupMessage, reviewWorld, type ReviewWorld } from "../../../../test-support/review-world.js";

const PR1 = "AMD-AGI/Hyperloom#1";
const URL1 = "https://github.com/AMD-AGI/Hyperloom/pull/1";

function reading(intent: string): IntentReader {
  const answer = { intent, reviewer: "29:b", reviewers: ["29:b"], prs: [PR1], model: "" };
  return {
    read: () => Promise.resolve(answer),
    readMode: () => Promise.resolve(undefined),
    readAnswer: () => Promise.resolve(undefined),
  };
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

const groupTexts = (world: ReviewWorld) =>
  world.surface
    .of(CONV)
    .flatMap((r) => (r.op === "send" && r.message.body.type === "text" ? [r.message.body.text] : []));

test("a request for a review only reviews as the named person and may not merge", async () => {
  const world = reviewWorld();
  await ask(world, `请 {Bob} 帮我 review ${PR1}`);
  const [one, ...more] = world.started;
  assert.equal(more.length, 0);
  assert.equal(one?.turn.actingAs, "u-bob");
  assert.deepEqual(one.turn.reviewTarget, { owner: "AMD-AGI", repo: "Hyperloom", number: 1 });
  assert.equal(one.turn.reviewOnly, true);
  assert.ok(one.prompt.includes("never merge: do not call gh_pr_merge"), one.prompt);
  assert.ok(one.prompt.includes("Merging is not allowed in this session") && !one.prompt.includes("approve and merge"));
  assert.ok(
    groupTexts(world).some((t) => t.includes("只 review，不合入")) ||
      world.started.some((s) => s.review.ack.includes("只 review，不合入")),
  );
});

test("the issue 229 request with bare numbers reviews each and merges none", async () => {
  const world = reviewWorld();
  await ask(world, "请{Bob}帮我review AMD-AGI/Hyperloom PR 1和2");
  assert.deepEqual(world.started.map((s) => s.turn.reviewTarget.number).sort(), [1, 2]);
  assert.ok(world.started.every((s) => s.turn.actingAs === "u-bob" && s.turn.reviewOnly));
});

test("review and merge is unchanged", async () => {
  const world = reviewWorld();
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR1}`);
  const [one] = world.started;
  assert.equal(one?.turn.reviewOnly, false);
  assert.ok(one.prompt.includes("approve and merge") && !one.prompt.includes("never merge"));
});

test("the models review reading starts a review only", async () => {
  const world = reviewWorld(["AMD-AGI"], { intent: reading("review") });
  await ask(world, `{Bob} 能帮我看看 ${PR1} 吗`);
  const [one] = world.started;
  assert.equal(one?.turn.actingAs, "u-bob");
  assert.equal(one.turn.reviewOnly, true);
});

for (const [name, text, intent, reviewOnly] of [
  ["words say review only", `请 {Bob} 帮我 review ${PR1}`, "review_merge", true], // the model reads a merge the words do not ask for
  ["words say merge", `请 {Bob} 帮我 review 合入 ${PR1}`, "review", false], // the words ask for the merge: it is not lost
] as const) {
  test(`what the words say about merging wins over the models reading (${name})`, async () => {
    const world = reviewWorld(["AMD-AGI"], { intent: reading(intent) });
    await ask(world, text);
    const [one] = world.started;
    assert.equal(one?.turn.actingAs, "u-bob");
    assert.equal(one.turn.reviewOnly, reviewOnly);
  });
}

const turn = (lang: "zh" | "en", reviewOnly = false) =>
  reviewTurn({
    requesterId: "aad-a",
    requesterName: "Alice",
    actorId: "aad-b",
    actorUserId: "u-bob",
    actorName: "Bob",
    actorChannelId: "29:b",
    pull: { owner: "AMD-AGI", repo: "Hyperloom", number: 1 },
    lang,
    reviewOnly,
  });

test("a chinese request asks for the answer in simplified chinese", async () => {
  const world = reviewWorld();
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR1}`);
  const prompt = world.started[0]?.prompt ?? "";
  assert.ok(
    prompt.includes("Write the final answer in Simplified Chinese") &&
      !prompt.includes("Write the final answer in English"),
  );
});

test("an english request asks for english", async () => {
  const world = reviewWorld(["AMD-AGI"], { intent: reading("review_merge") });
  await ask(world, `{Bob} please review and merge ${PR1}`);
  const prompt = world.started[0]?.prompt ?? "";
  assert.ok(prompt.includes("Write the final answer in English") && !prompt.includes("Simplified Chinese"), prompt);
  assert.ok(reviewPrompt(turn("zh")).includes("Simplified Chinese") && reviewPrompt(turn("en")).includes("in English"));
});

/** What the turn engine keeps of one tool answer. */
function wrote(status: string, event = "") {
  const tool = event ? "mcp__github-review__gh_review_submit" : "mcp__github-review__gh_pr_merge";
  return githubWrite(tool, JSON.stringify({ status, ...(event ? { detail: { event } } : {}) }));
}

for (const [name, text, outcome, line] of [
  [
    "merged",
    `请 {Bob} 帮我 review 合入 ${PR1}`,
    ["gh_pr_merge", "merged", ""],
    `${PR1}：review 通过，已合入（模型：claude-opus-5.5）\n${URL1}`,
  ],
  [
    "held",
    `请 {Bob} 帮我 review 合入 ${PR1}`,
    ["gh_pr_merge", "confirmation_required", ""],
    `${PR1}：review 通过，合入等 Bob 确认，还没有合入（模型：claude-opus-5.5）`,
  ],
  [
    "review only",
    `请 {Bob} 帮我 review ${PR1}`,
    ["gh_review_submit", "submitted", "APPROVE"],
    `${PR1}：review 完成：批准，只 review，没有合入（模型：claude-opus-5.5）`,
  ],
] as const) {
  test(`the result line shows in the progress message when the result arrives before the summary (${name})`, async () => {
    const world = reviewWorld();
    (world.deps as { defaultModel: string }).defaultModel = "claude-opus-5.5";
    await ask(world, text);
    const [one] = world.started;
    assert.ok(one);
    // (what the engine puts at the top of the progress message, the moment the write is seen)
    const shown = one.turn.onGithubResult(outcome, "claude-opus-5.5") ?? "";
    assert.ok(shown.startsWith(line), shown);
  });
}

test("an approval alone does not settle a review that may merge", () => {
  assert.equal(resultLine(turn("zh"), ["gh_review_submit", "submitted", "APPROVE"], "m"), undefined);
  assert.equal(resultLine(turn("zh", true), ["gh_pr_merge", "merged", ""], "m"), undefined); // (Claw refuses it anyway)
  assert.ok(
    resultLine(turn("en"), ["gh_review_submit", "submitted", "REQUEST_CHANGES"], "m")?.includes(
      "changes requested, not merged",
    ),
  );
  assert.ok(resultLine(turn("zh"), ["gh_pr_merge", "delegation_off", ""], "")?.includes("没有合入"));
  assert.ok(resultLine(turn("zh"), ["gh_pr_merge", "merged", ""], "")?.includes("（模型：默认模型）"));
  assert.deepEqual(wrote("confirmation_required"), undefined); // (a hold is no write: only its line says it)
});
