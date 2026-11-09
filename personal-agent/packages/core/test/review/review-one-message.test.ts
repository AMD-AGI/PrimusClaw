// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review for a colleague ends as ONE message where it was asked (`test_review_one_message`, the review service's part): the
 * acknowledgement goes at the top of the progress message (the turn's `lead`), never as a message of its own, and the one answer
 * the turn is given to send (`shapeAnswer`) says the link, the verdict, whether it was merged, the inline comments, the model and
 * the summary, the result before the summary. How the engine edits and replaces the progress message is its own tests'.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { githubWrite, reviewComments } from "../../src/turn/github-outcome.js";
import { ALICE, CONV, PR, groupMessage, reviewWorld, type ReviewWorld } from "../../../../test-support/review-world.js";

const URL = "https://github.com/AMD-AGI/Hyperloom/pull/12";
const SUMMARY = "没有发现必须修改的问题。src/a.py:3 有两处建议已作为行内评论留下。";

async function ask(world: ReviewWorld, text = `请 {Bob} 帮我 review 合入 ${PR}`, kind: "group" | "personal" = "group") {
  const message = groupMessage(text, ALICE, undefined, "g1", kind);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: kind === "group" ? CONV : "",
    lang: () => "zh",
  });
  const [turn] = world.started;
  assert.ok(turn);
  return turn;
}

const submitted = (event: string, comments: number) =>
  JSON.stringify({ status: "submitted", detail: { event, comments, review_id: 7 } });
const SUBMIT = "mcp__github-review__gh_review_submit";
const MERGE = "mcp__github-review__gh_pr_merge";

/** The answer the turn sends, from the tool answers as the engine reads them (`githubWrite`, `reviewComments`). */
function answerOf(turn: Awaited<ReturnType<typeof ask>>, calls: readonly (readonly [string, string])[]): string {
  const results = calls.flatMap(([tool, answer]) => {
    const found = githubWrite(tool, answer);
    return found === undefined ? [] : [found];
  });
  const comments = calls.reduce((n, [, answer]) => n + reviewComments(answer), 0);
  return turn.turn.shapeAnswer(`${SUMMARY}\nVERDICT: CLEAN`, "", "", results, comments, "");
}

for (const [origin, kind, text] of [
  ["group", "group", `请 {Bob} 帮我 review 合入 ${PR}`],
  ["1:1", "personal", `请 Bob 帮我 review 合入 ${PR}`],
] as const) {
  test(`a review ends as one message with the link verdict merge comments and summary (${origin})`, async () => {
    const turn = await ask(reviewWorld(), text, kind);
    const final = answerOf(turn, [
      [SUBMIT, submitted("APPROVE", 2)],
      [MERGE, JSON.stringify({ status: "merged" })],
    ]);
    for (const expected of [PR, URL, "批准", "已合入", "2 条行内评论", "（模型：", "没有发现必须修改的问题"]) {
      assert.ok(final.includes(expected), `${expected} in ${final}`);
    }
    assert.ok(final.indexOf("已合入") < final.indexOf("没有发现必须修改的问题")); // the result first, then the summary
    assert.ok(!final.includes("完整结论随后发出") && !final.includes("VERDICT"));
  });
}

for (const [name, calls, verdict, merge, comments] of [
  ["changes requested", [[SUBMIT, submitted("REQUEST_CHANGES", 3)]], "要求修改", "没有合入", "3 条行内评论"],
  ["commented", [[SUBMIT, submitted("COMMENT", 1)]], "评论", "没有合入", "1 条行内评论"],
  [
    "approved merged",
    [
      [SUBMIT, submitted("APPROVE", 0)],
      [MERGE, JSON.stringify({ status: "merged" })],
    ],
    "批准",
    "已合入",
    "0 条行内评论",
  ],
] as const) {
  test(`the one message says the verdict and whether it was merged (${name})`, async () => {
    const turn = await ask(reviewWorld());
    const [head = ""] = answerOf(turn, calls).split("\n");
    for (const expected of [PR, verdict, merge, comments, "（模型："])
      assert.ok(head.includes(expected), `${expected} in ${head}`);
  });
}

test("a review only says it was not merged", async () => {
  const turn = await ask(reviewWorld(), `请 {Bob} 帮我 review ${PR}`);
  // (acknowledged as before, but at the top of the progress message: the chat is left with the one answer)
  assert.ok(turn.turn.lead.startsWith("收到") && turn.turn.lead.includes("review"), turn.turn.lead);
  const final = answerOf(turn, [[SUBMIT, submitted("APPROVE", 0)]]);
  assert.ok(final.includes("review 完成：批准") && final.includes("只 review，没有合入") && final.includes(URL), final);
});

test("an acknowledged review still ends as one message", async () => {
  const world = reviewWorld();
  const turn = await ask(world, `请 {Bob} 用 gpt-6-luna 帮我 review 合入 ${PR}`);
  // (said the moment the review starts, at the top of the progress message, never as a message of its own)
  assert.ok(turn.turn.lead.startsWith("收到") && turn.turn.lead.includes("gpt-6-luna"), turn.turn.lead);
  assert.ok(
    !world.surface
      .of(CONV)
      .some((r) => r.op === "send" && r.message.body.type === "text" && r.message.body.text.startsWith("收到")),
  );
  const final = answerOf(turn, [
    [SUBMIT, submitted("APPROVE", 0)],
    [MERGE, JSON.stringify({ status: "merged" })],
  ]);
  assert.ok((final.includes("review 完成") || final.includes("review 通过")) && !final.startsWith("收到"), final);
});
