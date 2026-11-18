// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { bareGroups, looksLikeRepo, strayNumbers, writtenRepos } from "../../src/review-text/bare-numbers.js";

function numbersOf(text: string): number[] | undefined {
  const groups = bareGroups(text);
  return groups.length ? groups.flatMap((g) => g.numbers) : undefined;
}

const FORMS: readonly [string, number[] | undefined][] = [
  ["PR 245和246", [245, 246]],
  ["#245、#246", [245, 246]],
  ["PR #245 #246", [245, 246]],
  ["PrimusClaw PR #245和 #246", [245, 246]],
  ["linmei0120", undefined],
  ["claude-opus-5.5", undefined],
  ["&#160;", undefined],
];

test("the forms a bare number is written in", () => {
  for (const [text, numbers] of FORMS) assert.deepEqual(numbersOf(text), numbers, text);
});

const TEN = [248, 232, 243, 241, 238, 236, 233, 234, 237, 235];
const ROBIN_TEN = "请 linmei 帮我review并合入PrimusClaw PR 248 232 243 241 238 236 233 234 237 235";

const ENDS: readonly [string, number[], number[]][] = [
  [ROBIN_TEN, TEN, []],
  ["PR 248 10 分钟内", [248], []],
  ["PR 248 10分钟内", [248], []],
  ["PR 248\n1. 修复", [248], []],
  ["PR 248 2 小时内合", [248], []],
  ["用 claude-opus-5.5 合入 PR 5 6", [5, 6], []],
  ["16:23 合入 PR 9", [9], []],
  ["PR 248 10:30 前合入", [248], []],
  ["PR 248 10：30 前合入", [248], []],
  ["PR 248 11-03 合入", [248], []],
  ["PR 248 11/03 合入", [248], []],
  ["PR 248 1.5 倍", [248], []],
  ["PR 245 另外 246", [245], [246]],
  ["PR 245 246 请尽快", [245, 246], []],
];

test("where a list of numbers ends", () => {
  for (const [text, numbers, stray] of ENDS) {
    const groups = bareGroups(text);
    assert.deepEqual(
      groups.flatMap((g) => g.numbers),
      numbers,
      text,
    );
    assert.deepEqual(strayNumbers(text, groups), stray, text);
  }
});

test("a list in any mix of separators is one group", () => {
  const mixed: readonly [string, number[]][] = [
    ["PrimusClaw PR 245, 246 和 #247\n248；249、250 and 251", [245, 246, 247, 248, 249, 250, 251]],
    ["PrimusClaw PR #245 246,247，248", [245, 246, 247, 248]],
    ["PrimusClaw PR\n245\n246\n247", [245, 246, 247]],
    ["PrimusClaw PR 245和246和247", [245, 246, 247]],
  ];
  for (const [text, numbers] of mixed) {
    const groups = bareGroups(`请 linmei 帮我review并合入${text}`);
    assert.deepEqual(
      groups.flatMap((g) => g.numbers),
      numbers,
      text,
    );
    assert.equal(groups[0]?.repo, "PrimusClaw", text);
  }
});

test("the repository word and whether the numbers are explicit", () => {
  const read = (text: string) => bareGroups(text).map((g) => [g.repo, g.explicit, g.numbers]);
  assert.deepEqual(read("请linmei帮我review并合入PrimusClaw PR 245和246"), [["PrimusClaw", true, [245, 246]]]);
  assert.deepEqual(read("合入 AMD-AGI/PrimusClaw 245"), [["AMD-AGI/PrimusClaw", false, [245]]]);
  assert.deepEqual(read("合入PR 245"), [["", true, [245]]]);
});

test("links, owner/repo#N and mentions are not read as bare numbers", () => {
  assert.deepEqual(bareGroups("合入 https://github.com/AMD-AGI/x/pull/12 和 AMD-AGI/x#13 ⟦0⟧"), []);
  assert.deepEqual(strayNumbers("合入 AMD-AGI/x#13 和 14", []), [14]);
});

test("a repository name must look like one", () => {
  assert.equal(looksLikeRepo("PrimusClaw"), true);
  assert.equal(looksLikeRepo("fleet-tools"), true);
  assert.equal(looksLikeRepo("Primus2"), true);
  assert.equal(looksLikeRepo("API"), false);
  assert.equal(looksLikeRepo("my"), false);
  assert.equal(looksLikeRepo("review"), false);
});

test("the repositories a message writes, each once", () => {
  assert.deepEqual(writtenRepos("合入 AMD-AGI/Hyperloom#1 和 amd-agi/hyperloom 以及 AMD-AGI/Primus"), [
    "AMD-AGI/Hyperloom",
    "AMD-AGI/Primus",
  ]);
  assert.deepEqual(writtenRepos("see https://github.com/AMD-AGI/x.git/pull/3"), ["AMD-AGI/x"]);
});
