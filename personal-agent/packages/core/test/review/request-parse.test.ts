// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { markText } from "../../src/review/message.js";
import { shortName } from "../../src/review/pull-ref.js";
import { asksReviewOnly, otherReviewers, parseReviewAsk, saysReviewAndMerge } from "../../src/review/request-parse.js";

const PR = "AMD-AGI/Hyperloom#12";
const BOB = { channelUserId: "29:b", userId: "", name: "Bob", shown: "<at>Bob</at>" };

/** A message as the router hands it over: the bot's own mention gone, `{Bob}` an @mention of Bob. */
function read(text: string, mentions = [BOB]) {
  const marked = markText(text.replaceAll("{Bob}", "<at>Bob</at>"), mentions, []);
  return parseReviewAsk(marked.text, marked.mentions);
}

test("a named request is read with the mention kept apart from typed words", () => {
  const parsed = read(`请 {Bob} 帮我 review 合入 ${PR}`);
  assert.equal(parsed?.who, "⟦0⟧");
  assert.equal(parsed.mentions[0]?.channelUserId, "29:b");
  assert.deepEqual(parsed.pulls.map(shortName), [PR]);
});

test("pull requests are found by link or short form", () => {
  const cases: readonly [string, string[]][] = [
    ["请 Bob 帮我 review 合入 https://github.com/AMD-AGI/Hyperloom/pull/12", [PR]],
    ["请 Bob 帮我 review合入 AMD-AGI/Hyperloom#12", [PR]],
    ["请 Bob 帮我 review 合入 https://github.com/AMD-AGI/Hyperloom/pull/12 也就是 AMD-AGI/hyperloom#12", [PR]],
    ["请 Bob 帮我 review 合入 AMD-AGI/Hyperloom#12 和 AMD-AGI/Hyperloom#13", [PR, "AMD-AGI/Hyperloom#13"]],
    ["请 Bob 帮我 review 合入", []],
  ];
  for (const [text, pulls] of cases) {
    const parsed = read(text, []);
    assert.equal(parsed?.who, "Bob", text);
    assert.deepEqual(parsed.pulls.map(shortName), pulls, text);
  }
});

test("a request that names nobody is still a request", () => {
  for (const text of [
    `帮我 review 合入 ${PR}`,
    `请帮我 review 合入 ${PR}`,
    `review 合入 ${PR}`,
    "请 帮我 review 合入",
  ]) {
    assert.equal(read(text, [])?.who, "", text);
  }
});

test("chat that only looks like one is chat", () => {
  for (const text of [
    "review https://github.com/AMD-AGI/Hyperloom/pull/12",
    "请问 review 合入的流程是什么？",
    "lunch?",
    "帮我 review 一下 AMD-AGI/Hyperloom#12",
    "请问谁能帮我 review AMD-AGI/Hyperloom#12",
  ]) {
    assert.equal(read(text, []), undefined, text);
  }
});

test("a typed marker is not a mention", () => {
  assert.deepEqual(read(`请 ⟦0⟧ 帮我 review 合入 ${PR}`, [])?.mentions, []);
});

test("a review only names the reviewer and a pull request, and says nothing of merging", () => {
  const only = read(`请 Bob 帮我 review ${PR}`, []);
  assert.deepEqual([only?.who, only?.merge], ["Bob", false]);
  assert.equal(read("请 Bob 帮我 review 一下", []), undefined);
  assert.equal(asksReviewOnly(`请 Bob 帮我 review 合入 ${PR}`), undefined);
  assert.equal(asksReviewOnly(`请 model: x 帮我 review ${PR}`), undefined);
  assert.equal(saysReviewAndMerge("review 然后合入"), true);
});

test("the model is taken out of the name, and every later line names its reviewer", () => {
  const parsed = read(
    `请 Bob 用 claude-opus-5.5 帮我 review 合入 ${PR}\n请 Carol review 合入 AMD-AGI/x#1 model: gpt-6-luna`,
    [],
  );
  assert.equal(parsed?.who, "Bob");
  assert.deepEqual(parsed.models, ["gpt-6-luna", "claude-opus-5.5"]);
  assert.deepEqual(parsed.again, ["Carol"]);
  assert.deepEqual(otherReviewers(parsed), ["Carol"]);
});

test("a later line that names the same person in another way is that person", () => {
  const mentions = [
    { channelUserId: "29:w", userId: "", name: "Lin, Mei", shown: "<at>Lin, Mei</at>" },
    { channelUserId: "29:w", userId: "", name: "Mei", shown: "<at>Mei</at>" },
  ];
  const marked = markText(
    `请 <at>Lin, Mei</at> review 合入 ${PR}\n请 Mei Lin review 合入 AMD-AGI/x#2\n请 <at>Mei</at> review 合入 AMD-AGI/x#3\n请 review 合入 AMD-AGI/x#4`,
    mentions,
    [],
  );
  const parsed = parseReviewAsk(marked.text, marked.mentions);
  assert.ok(parsed);
  assert.deepEqual(otherReviewers(parsed), []);
});
