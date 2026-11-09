// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review's conclusion says, in one sentence, what the pull request does (`test_review_pr_summary`): shown right under the
 * verdict on the review's one message, on the progress message of reviews asked of someone else (one line per pull request),
 * on the review card once it ended, in the reviewer's notices, and on the card that asks the reviewer to confirm; nothing
 * changes when Claw gives none.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AskerView } from "../../src/index.js";
import { PR_SUMMARY_MAX_CJK } from "../../src/claw/requester-view.js";
import { cpLength } from "../../src/text/py-text.js";
import { progressText, reviewerResultText, type Followed } from "../../src/review/progress.js";
import { reviewAnswer } from "../../src/review/receipt.js";
import { reviewTurn, type ReviewTurn } from "../../src/review/review-turn.js";
import { prSummaryLine, withSummaryLine } from "../../src/review/summary.js";
import { ALICE_DM, PR, handBack, handoffEvent, handoffWorld, saidIn } from "../../../../test-support/review-world.js";
import { cards, held } from "./held-world.js";

const ZH = "给代审结论卡加一句话，概述这个 PR 做了什么";
const EN = "Adds a one-sentence summary of what the pull request does to the review conclusion card.";
const PR2 = "AMD-AGI/Hyperloom#13";
const PR3 = "AMD-AGI/Primus#3";
const LINK: Readonly<Record<string, string>> = {
  [PR]: "https://github.com/AMD-AGI/Hyperloom/pull/12",
  [PR2]: "https://github.com/AMD-AGI/Hyperloom/pull/13",
  [PR3]: "https://github.com/AMD-AGI/Primus/pull/3",
};

test("the line goes right under the verdict", () => {
  assert.equal(withSummaryLine("PR：结论\nhttps://x", prSummaryLine(ZH)), `PR：结论\nPR 概述：${ZH}\nhttps://x`);
  assert.equal(
    withSummaryLine("PR: verdict\nhttps://x", prSummaryLine(EN, "en")),
    `PR: verdict\nWhat it does: ${EN}\nhttps://x`,
  );
  assert.equal(withSummaryLine("PR：结论", prSummaryLine(ZH)), `PR：结论\nPR 概述：${ZH}`);
  assert.equal(withSummaryLine("PR：结论\nhttps://x", prSummaryLine("")), "PR：结论\nhttps://x");
});

function review(lang: "zh" | "en" = "zh"): ReviewTurn {
  return reviewTurn({
    requesterId: "aad-a",
    requesterName: "Alice",
    actorId: "aad-b",
    actorUserId: "u-bob",
    actorName: "Bob",
    actorChannelId: "29:b",
    pull: { owner: "AMD-AGI", repo: "Hyperloom", number: 12 },
    lang,
  });
}

for (const [lang, summary, label] of [
  ["zh", ZH, "PR 概述："],
  ["en", EN, "What it does: "],
] as const) {
  test(`one reviews message says what it does under its verdict (${lang})`, () => {
    const r = review(lang);
    const answer = `${lang === "zh" ? "没有必须修改的问题。" : "Nothing must be fixed."}\nVERDICT: CLEAN`;
    const results = [["gh_review_submit", "submitted", "APPROVE"] as const];
    const [first = "", second, third] = reviewAnswer(r, answer, { model: "m", results, prSummary: summary }).split(
      "\n",
    );
    assert.ok(first.includes("批准") || first.includes("approved"), first);
    assert.equal(second, label + summary);
    assert.equal(third, LINK[PR]);
    assert.equal(reviewAnswer(r, answer, { model: "m", results }).split("\n")[1], LINK[PR]);
  });
}

const view = (fields: Partial<AskerView>): AskerView => ({
  itemId: "item-1",
  status: "done",
  prUrl: LINK[PR] ?? "",
  verdict: "approve",
  merged: true,
  waitingFor: "",
  findings: null,
  note: "",
  prSummary: "",
  ...fields,
});

test("progress and the reviewers notice say it one line per pull request", () => {
  const r = review();
  const entry: Followed = {
    review: r,
    said: "end:done:approve:1",
    reviewerTold: false,
    resumed: false,
    seenQueued: false,
  };
  const told = view({ prSummary: ZH });
  assert.deepEqual(
    progressText([entry], [[entry, told]])
      .split("\n")
      .slice(0, 2),
    [`${PR}（Bob 代审）：结论：批准，已合入`, `PR 概述：${ZH}`],
  );
  assert.ok(reviewerResultText(r, told).includes(`PR 概述：${ZH}`));
  const bare = view({});
  assert.ok(!progressText([entry], [[entry, bare]]).includes("概述") && !reviewerResultText(r, bare).includes("概述"));
});

test("handed over reviews say what each pull request does in the progress message", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", {
    status: "waiting_for_reviewer",
    prUrl: LINK[PR],
    verdict: "approve",
    merged: false,
    prSummary: ZH,
  });
  world.claw.views.set("item-2", {
    status: "done",
    prUrl: LINK[PR2],
    verdict: "request_changes",
    merged: false,
    prSummary: EN,
  });
  world.claw.views.set("item-3", { status: "done", prUrl: LINK[PR3], verdict: "approve", merged: true });
  await handBack(world, handoffEvent({ prs: [PR, PR2, PR3] }));
  const summaries = world.surface
    .of(ALICE_DM)
    .flatMap((r) => (r.op === "send" && r.message.body.type === "text" ? [r.message.body.text] : []))
    .filter((t) => t.includes("代审进度"));
  assert.equal(summaries.length, 1, summaries.join("\n---\n"));
  const lines = (summaries[0] ?? "").split("\n");
  const after = (pr: string) => lines[lines.findIndex((l) => l.startsWith(`- ${pr}：`)) + 1] ?? "";
  assert.equal(after(PR), `  PR 概述：${ZH}`);
  assert.equal(after(PR2), `  PR 概述：${EN}`);
  assert.ok(!after(PR3).startsWith("  PR 概述"));
  // Bob, asked to confirm, is told what it does too
  assert.ok(saidIn(world.surface, "personal:aad-b").includes(`PR 概述：${ZH}`));
});

function endedRender(world: ReturnType<typeof handoffWorld>): Readonly<Record<string, unknown>> {
  const edits = world.surface
    .of(ALICE_DM)
    .flatMap((r) => (r.op === "update" && r.message.body.type === "view" ? [r.message.body.view] : []));
  const last = edits.at(-1);
  assert.equal(last?.name, "endedItem");
  return { ended: last.model.ended, ...last.model.render };
}

test("the ended card of a handed over review says what it does", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", { status: "done", prUrl: LINK[PR], verdict: "approve", merged: true, prSummary: ZH });
  await handBack(world, handoffEvent());
  const shown = endedRender(world);
  assert.equal(shown.ended, "已结束：结论：批准，已合入");
  assert.equal(shown.pr_summary, ZH);
});

test("a handed over review without a sentence ends as it always did", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", { status: "done", prUrl: LINK[PR], verdict: "approve", merged: true });
  await handBack(world, handoffEvent());
  const shown = endedRender(world);
  assert.equal(shown.ended, "已结束：结论：批准，已合入");
  assert.equal(shown.pr_summary, undefined);
});

test("a review followed in its session says it under the verdict", async () => {
  const world = await held({}, undefined);
  const [started] = world.started;
  assert.ok(started);
  const answer = started.turn.shapeAnswer(
    "没有必须修改的问题。\nVERDICT: CLEAN",
    "",
    "m",
    [
      ["gh_review_submit", "submitted", "APPROVE"],
      ["gh_pr_merge", "merged", ""],
    ],
    0,
    ZH,
  );
  const lines = answer.split("\n");
  const [head = ""] = lines;
  assert.ok(head.includes("批准") && head.includes("已合入"), head);
  assert.equal(lines[1], `PR 概述：${ZH}`);
  assert.equal(lines[2], LINK[PR]);
});

test("the held merge card sent to the reviewer says what it does", async () => {
  const world = await held({ pr_summary: `${ZH}${"很长".repeat(100)}` });
  const [card] = cards(world, "personal:aad-b");
  assert.ok(card?.summary.startsWith(ZH));
  assert.equal(cpLength(card?.summary ?? ""), PR_SUMMARY_MAX_CJK);
  assert.equal(card?.title, "Change the release workflow"); // the rest of the card is still there
  const without = await held();
  assert.equal(cards(without, "personal:aad-b")[0]?.summary, "");
});
