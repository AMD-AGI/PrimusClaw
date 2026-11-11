// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the owner of their own review is told when it ends without an approval (`assistant/review-result.ts`), in each language: why,
 * and what is next. The paths that send it run against Postgres in `assistant-review-items.test.ts` (RS1-RS3).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ciNamesOf, resultText, type ResultFacts } from "../src/assistant/review-result.js";

const facts = (over: Partial<ResultFacts> = {}): ResultFacts => ({
  pr: "AMD-AGI/Primus-SaFE#873", url: "https://github.com/AMD-AGI/Primus-SaFE/pull/873", seq: 195,
  headSha: "058177b4d37007d2342decbf4db3bfb62ad1ee81", event: "COMMENT", reviewId: 5856903798, findings: [],
  ci: { failed: ["codecov/patch"], pending: [] }, refused: null, reviewOnly: false, turns: 1, ended: null, ...over,
});

test("#873 as it happened, told in Chinese: CI alone held it back, it waits for CI, and the reply that reviews it again", () => {
  const zh = resultText("ci_wait", facts(), true);
  assert.equal(zh.split("\n")[0], "**AMD-AGI/Primus-SaFE#873 审完了，还没批准：在等 CI**");
  assert.match(zh, /代码里没发现阻塞问题；没批准是因为 head `058177b` 上 CI 没全绿（没通过：`codecov\/patch`）/);
  assert.match(zh, /CI 全绿后自动再审一次.*审过就发合入确认卡片/);
  assert.match(zh, /回复 `再审 #195`/);
  assert.match(zh, /评审：https:\/\/github\.com\/AMD-AGI\/Primus-SaFE\/pull\/873#pullrequestreview-5856903798/);
  assert.match(resultText("ci_wait", facts({ reviewOnly: true }), true), /审过就批准/);
  assert.match(resultText("ci_wait", facts(), false), /reply `review again #195`/);
});

test("every way a review ends without an approval says why and what is next, in both languages", () => {
  const cases: Array<[Partial<ResultFacts>, RegExp, RegExp]> = [
    [{ findings: [{ path: "a.go", line: 3, note: "nil map write" }], ci: null, event: "REQUEST_CHANGES" }, /有 1 个阻塞问题[\s\S]*`a\.go:3` nil map write[\s\S]*作者改完推送后/, /1 blocking finding[\s\S]*`a\.go:3`/],
    [{ ended: "head_moved" }, /CI 没全绿[\s\S]*PR 有了新提交[\s\S]*CI 全绿以后回复 `再审 #195`/, /new commits/],
    [{ ended: "timeout" }, /等了 24 小时/, /after 24 hours/],
    [{ turns: 2 }, /已经在 CI 转绿后自动再审过一次/, /already run again once/],
    [{ ci: null, refused: "threads_unresolved" }, /还有没解决的评审讨论/, /review threads are still open/],
    [{ ended: "threads_open" }, /CI 已经全绿，但还有没解决的评审讨论[\s\S]*讨论都解决后回复 `再审 #195`/, /CI is green now, but review threads are still open/],
    [{ ci: null, refused: "cannot_approve_own_pull_request" }, /PR 是你自己写的/, /you wrote it/],
    [{ ci: null }, /结论：只留了评论[\s\S]*`再审 #195`/, /Verdict: a comment only/],
  ];
  for (const [over, zh, en] of cases) {
    assert.match(resultText("not_approved", facts(over), true), zh, JSON.stringify(over));
    assert.match(resultText("not_approved", facts(over), false), en, JSON.stringify(over));
  }
  const many = facts({ ci: null, findings: Array.from({ length: 7 }, (_, i) => ({ path: "x.ts", line: i + 1, note: "n" })) });
  assert.match(resultText("not_approved", many, true), /还有 2 个，见评审/);
});

test("the check names are read back from the refusal's audit lines, and nothing else is", () => {
  assert.deepEqual(ciNamesOf(["evidence: x", "ci_failed: codecov/patch", "ci_pending: e2e", "ci_failed: ", 7]), { failed: ["codecov/patch"], pending: ["e2e"] });
  assert.deepEqual(ciNamesOf(null), { failed: [], pending: [] });
});
