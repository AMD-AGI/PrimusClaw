// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the owner of their own review is told when it ends without an approval (`assistant/review-result.ts`), in each language: why,
 * and what is next; and what whoever asked is told of a re-review with no new commits that posted nothing. The paths that send them run
 * against Postgres in `assistant-review-items.test.ts` (RS1-RS5).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ciNamesOf, resultText, unchangedText, type ResultFacts, type UnchangedFacts } from "../src/assistant/review-result.js";

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

test("a re-review with no new commits that posted nothing (N25, #532) says so to whoever asked, and what is next, in both languages", () => {
  const f = (over: Partial<UnchangedFacts> = {}): UnchangedFacts => ({
    pr: "AMD-AGI/PrimusClaw#712", url: "https://github.com/AMD-AGI/PrimusClaw/pull/712", seq: 532,
    headSha: "1d6a0c3e2f4b5a6978877665544332211aabbccd", reviewOnly: false, turns: 1, ended: null, forRequester: true, ...over,
  });
  assert.equal(unchangedText("unchanged_wait", f(), true), [
    "**你请人评审的 AMD-AGI/PrimusClaw#712 这次没有发新评审：代码和上次审过的一样**", "",
    "- head `1d6a0c3` 已经审过，之后没有新提交，所以没有重复发评审。",
    "- 接下来：我盯着这个 PR，这个 head 的 CI 全绿后自动再审一次（只再审一次，最多等 24 小时），审过就批准并继续合入。",
    "- PR 有了新提交：再请一次评审。",
    "- PR：https://github.com/AMD-AGI/PrimusClaw/pull/712",
  ].join("\n"));
  // The owner's own: no "you asked for", and the reply that reviews it again.
  const own = unchangedText("unchanged_wait", f({ forRequester: false, reviewOnly: true }), true);
  assert.match(own, /^\*\*AMD-AGI\/PrimusClaw#712 这次没有发新评审/);
  assert.match(own, /审过就批准。\n- PR 有了新提交：回复 `再审 #532`。/);
  const cases: Array<[Partial<UnchangedFacts>, RegExp, RegExp]> = [
    [{ turns: 2 }, /已经在 CI 转绿后自动再审过一次，还是没有新内容可发。\n- 接下来：PR 有了新提交后再请一次评审。/, /already run again once after CI turned green[\s\S]*once the pull request has new commits, ask for a review again/],
    [{ ended: "threads_open" }, /CI 已经全绿，但 PR 上还有没解决的评审讨论，所以没有自动再审。\n- 接下来：讨论都解决后再请一次评审。/, /review threads are still open[\s\S]*once every thread is resolved, ask for a review again/],
    [{ ended: "timeout" }, /等了 24 小时 CI 还没全绿/, /still not green after 24 hours/],
    [{ ended: "head_moved" }, /PR 有了新提交，原来那个 head 的 CI 不再等了/, /got new commits/],
  ];
  for (const [over, zh, en] of cases) {
    assert.match(unchangedText("unchanged", f(over), true), zh, JSON.stringify(over));
    assert.match(unchangedText("unchanged", f(over), false), en, JSON.stringify(over));
    assert.doesNotMatch(unchangedText("unchanged", f(over), true), /卡住|需要你回复/);
  }
});
