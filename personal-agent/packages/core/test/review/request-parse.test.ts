// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { markedText } from "../../src/inbound-text/marked-text.js";
import { shortName } from "../../src/review-text/pull-ref.js";
import { asksReviewOnly, saysReviewAndMerge } from "../../src/review-text/asks.js";
import { otherReviewers, NAMED_ASK_MAX, parseReviewAsk } from "../../src/review/request-parse.js";

const PR = "AMD-AGI/Hyperloom#12";
const BOB = { channelUserId: "29:b", userId: "", name: "Bob", shown: "Bob", offset: 0 };

/** A message as the router hands it over: the bot's own mention gone, `{Bob}` an @mention of Bob. */
/** The mentions placed where their words stand in `text` (code points), as the channel adapter places them. */
function placed(text: string, mentions: readonly (typeof BOB)[]) {
  return mentions.map((m) => ({ ...m, offset: Array.from(text.slice(0, Math.max(text.indexOf(m.shown), 0))).length }));
}

function read(text: string, mentions = [BOB]) {
  const shown = text.replaceAll("{Bob}", "Bob");
  const marked = markedText(shown, text.includes("{Bob}") ? placed(shown, mentions) : []);
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
    { channelUserId: "29:w", userId: "", name: "Lin, Mei", shown: "Lin, Mei", offset: 2 },
    { channelUserId: "29:w", userId: "", name: "Mei", shown: "@Mei", offset: 0 },
  ];
  const text = `请 Lin, Mei review 合入 ${PR}\n请 Mei Lin review 合入 AMD-AGI/x#2\n请 @Mei review 合入 AMD-AGI/x#3\n请 review 合入 AMD-AGI/x#4`;
  const marked = markedText(text, placed(text, mentions));
  const parsed = parseReviewAsk(marked.text, marked.mentions);
  assert.ok(parsed);
  assert.deepEqual(otherReviewers(parsed), []);
});

// --- several pull requests in one request (`test_github_review_many`) -------------------------------------------------------

const PR1 = "AMD-AGI/Hyperloom#1";
const PR2 = "AMD-AGI/Hyperloom#2";
const PR3 = "AMD-AGI/Primus#3";
const URL2 = "https://github.com/AMD-AGI/Hyperloom/pull/2";

for (const [name, rest, expected] of [
  ["comma space", `${PR1}, ${PR2}`, [PR1, PR2]],
  ["comma", `${PR1},${PR2}`, [PR1, PR2]],
  ["fullwidth comma", `${PR1}，${PR2}`, [PR1, PR2]],
  ["dun hao", `${PR1}、${PR2}、${PR3}`, [PR1, PR2, PR3]],
  ["space", `${PR1} ${PR2}`, [PR1, PR2]],
  ["newline", `${PR1}\n${PR2}\n${PR3}`, [PR1, PR2, PR3]],
  ["he", `${PR1}和${PR2}`, [PR1, PR2]],
  ["link then short", `${URL2} ${PR1}`, [PR2, PR1]], // a link and a short form, in the order written
  ["mixed three", `${PR3}、${URL2}，${PR1}`, [PR3, PR2, PR1]],
  ["duplicate", `${PR1}、${URL2}、amd-agi/hyperloom#1`, [PR1, PR2]], // the same one twice is one
] as const) {
  test(`several pull requests are read whatever separates them (${name})`, () => {
    assert.deepEqual(read(`请 {Bob} 帮我 review 合入 ${rest}`)?.pulls.map(shortName), expected);
  });
}

for (const [text, isRequest] of [
  [`请 {Bob} 帮我 review 合入 ${PR1} ${PR2}`, true],
  [`请 {Bob} review 并合入 ${PR1} ${PR2}`, true],
  [`请 {Bob} 帮我 review 并合入 ${PR1}`, true],
  [`请 {Bob} review 合入 ${PR1}`, true],
  [`请 {Bob} 帮我 review ${PR1} ${PR2}`, true], // a review only, as Bob, never merged
  [`review ${PR1}, ${PR2}`, false],
  ["请问 review 合入的流程是什么？", false],
  ["请 {Bob} review 并合入", false], // without 帮我 it is one only with a pull request
  [`请 {Bob} review和合入 ${PR1}`, true],
  [`请 {Bob} review、合入 ${PR1}`, true],
  [`请 {Bob} review 然后合入 ${PR1}`, true],
  [`请 {Bob} 帮 review 并合入 ${PR1}`, true],
  [`{Bob} review 并合入 ${PR1}`, true], // nobody asked by 请: the group is asked who
] as const) {
  test(`review and merge is a request and review alone stays chat: ${text}`, () => {
    assert.equal(read(text) !== undefined, isRequest);
  });
}

for (const [name, text, models, who] of [
  ["yong", `请 {Bob} 用 claude-opus-5.5 帮我 review 合入 ${PR1} ${PR2}`, ["claude-opus-5.5"], "⟦0⟧"],
  ["model colon", `请 {Bob} 帮我 review 合入 ${PR1} model: gpt-6-luna`, ["gpt-6-luna"], "⟦0⟧"],
  ["moxing colon", `请 {Bob} 帮我 review 合入 ${PR1} 模型：gpt-6-luna`, ["gpt-6-luna"], "⟦0⟧"],
  ["model equals in name", `请 {Bob} model=gpt-6-luna 帮我 review 合入 ${PR1}`, ["gpt-6-luna"], "⟦0⟧"],
  ["typed name", `请 Bob 用 claude-opus-5.5 帮我 review 合入 ${PR1}`, ["claude-opus-5.5"], "Bob"],
  ["two", `请 {Bob} 用 a 帮我 review 合入 ${PR1} model: b`, ["b", "a"], "⟦0⟧"],
  ["none", `请 {Bob} 帮我 review 合入 ${PR1}`, [], "⟦0⟧"],
] as const) {
  test(`the model is read from the request and never taken for the reviewer (${name})`, () => {
    const parsed = read(text);
    assert.deepEqual(parsed?.models, models);
    assert.equal(parsed.who, who);
  });
}

test("a long message is read in linear time, and who it names only up to the limit", () => {
  // (each 请 after the first request was scanned to the end of the text: ~0.4 s for 30000 characters)
  const head = "请 Bob 帮我 review 合入 AMD-AGI/x#1\n";
  for (const tail of ["请".repeat(30_000), "请 ".repeat(15_000), "请 review ".repeat(3_333)]) {
    const started = performance.now();
    parseReviewAsk(head + tail, []);
    assert.ok(performance.now() - started < 100, `took ${String(performance.now() - started)} ms`);
  }
  // (up to NAMED_ASK_MAX code points the reviewer is read as before; past it, never)
  const filler = (n: number) => " ".repeat(n - Array.from(head).length);
  assert.equal(parseReviewAsk(head + filler(NAMED_ASK_MAX), [])?.who, "Bob");
  assert.equal(parseReviewAsk(head + filler(NAMED_ASK_MAX + 1), [])?.who, "");
  // (with no review word, or no 合入 or merge, there is nothing to name)
  assert.equal(parseReviewAsk("请 Bob 帮我看看 AMD-AGI/x#1", []), undefined);
});
