// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Real ways people ask the bot to have a colleague review and merge pull requests, each with the reading a good model gives
 * (`intent`, `reviewer`, `prs`, `model`) and what the worker then does. The intent tests run the table with a model stub that
 * answers that reading; the same table is what a real model is measured against offline.
 *
 * `text` is a group message after the bot's mention; `{Name}` in it is an @mention of that person (MENTIONS has their channel
 * ids). `html` is the formatted copy (its links). `quoted`: the text of the message the request replies to. `outcome`:
 * ["start", acting user, [pull requests], model or null], ["chat"] or ["say", words the reply has].
 * (Generated from the Python worker's tests/review_requests.py, people's names replaced by made-up ones.)
 */

import type { RosterMember } from "../packages/core/src/ports/surface.js";

export interface ReviewReading {
  readonly intent: string;
  readonly reviewer: string;
  readonly reviewers: readonly string[];
  readonly prs: readonly string[];
  readonly model: string;
}

export type Outcome =
  readonly ["start", string, readonly string[], string | null] | readonly ["chat"] | readonly ["say", string];

export interface ReviewRequestCase {
  readonly id: string;
  readonly text: string;
  readonly html: string;
  readonly quoted: string;
  readonly outcome: Outcome;
  readonly reading: ReviewReading;
}

export const MENTIONS: Readonly<Record<string, string>> = {
  Bob: "29:b",
  "Lin, Mei": "29:w",
  "Lin,": "29:w",
  Mei: "29:w",
  Carol: "29:c",
};

/** A group's member list as the channel gives it. */
export const MEMBERS: readonly RosterMember[] = [
  {
    channelUserId: "29:a",
    userId: "aad-a",
    name: "Alice",
    givenName: "Alice",
    surname: "",
    email: "alice@example.com",
    userPrincipalName: "alice@example.com",
  },
  {
    channelUserId: "29:b",
    userId: "aad-b",
    name: "Bob",
    givenName: "Bob",
    surname: "",
    email: "bob.smith@example.com",
    userPrincipalName: "bob.smith@example.com",
  },
  {
    channelUserId: "29:w",
    userId: "aad-w",
    name: "Lin, Mei",
    givenName: "Mei",
    surname: "Lin",
    email: "linmei0120@example.com",
    userPrincipalName: "linmei0120@example.com",
  },
  {
    channelUserId: "29:c",
    userId: "aad-c",
    name: "Carol",
    givenName: "Carol",
    surname: "",
    email: "carol@example.com",
    userPrincipalName: "carol@example.com",
  },
  {
    channelUserId: "29:c2",
    userId: "aad-c2",
    name: "Carol (SaFE)",
    givenName: "Carol (SaFE)",
    surname: "",
    email: "carol@example.com",
    userPrincipalName: "carol@example.com",
  },
];

export const REQUESTS: readonly ReviewRequestCase[] = [
  {
    id: "zh-mention",
    text: "请 {Bob} 帮我 review 合入 AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1"], null],
    reading: { intent: "review_merge", reviewer: "29:b", reviewers: ["29:b"], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
  {
    id: "zh-name",
    text: "请 Bob 帮我 review 合入 AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1"], null],
    reading: { intent: "review_merge", reviewer: "Bob", reviewers: ["Bob"], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
  {
    id: "robin-10:45Z",
    text: "请 Lin, Mei review 并合入 https://github.com/AMD-AGI/Primus/pull/101\r\n 请 Lin, Mei review 并合入 https://github.com/AMD-AGI/Primus/pull/102\r\n 请 Lin, Mei review 并合入 https://github.com/AMD-AGI/Primus/pull/103\r\n 请 Lin, Mei review 并合入 https://github.com/AMD-AGI/Primus/pull/104\r\n 请 Lin, Mei review 并合入 https://github.com/AMD-AGI/Primus/pull/105\r\n 请 Lin, Mei review 并合入 https://github.com/AMD-AGI/Primus/pull/106\r\n 请 Lin, Mei review 并合入 https://github.com/AMD-AGI/Primus/pull/107\r\n 请 Lin, Mei review 并合入 https://github.com/AMD-AGI/Primus/pull/108\r\n 请 Lin, Mei review 并合入 https://github.com/AMD-AGI/Primus/pull/109\r\n 请 Lin, Mei review 并合入 https://github.com/AMD-AGI/Primus/pull/110",
    html: "",
    quoted: "",
    outcome: [
      "start",
      "u-lin",
      [
        "AMD-AGI/Primus#101",
        "AMD-AGI/Primus#102",
        "AMD-AGI/Primus#103",
        "AMD-AGI/Primus#104",
        "AMD-AGI/Primus#105",
        "AMD-AGI/Primus#106",
        "AMD-AGI/Primus#107",
        "AMD-AGI/Primus#108",
        "AMD-AGI/Primus#109",
        "AMD-AGI/Primus#110",
      ],
      null,
    ],
    reading: {
      intent: "review_merge",
      reviewer: "Lin, Mei",
      reviewers: ["Lin, Mei"],
      prs: [
        "https://github.com/AMD-AGI/Primus/pull/101",
        "https://github.com/AMD-AGI/Primus/pull/102",
        "https://github.com/AMD-AGI/Primus/pull/103",
        "https://github.com/AMD-AGI/Primus/pull/104",
        "https://github.com/AMD-AGI/Primus/pull/105",
        "https://github.com/AMD-AGI/Primus/pull/106",
        "https://github.com/AMD-AGI/Primus/pull/107",
        "https://github.com/AMD-AGI/Primus/pull/108",
        "https://github.com/AMD-AGI/Primus/pull/109",
        "https://github.com/AMD-AGI/Primus/pull/110",
      ],
      model: "",
    },
  },
  {
    id: "robin-10:45Z-mentions",
    text: "请 {Lin, Mei} review 并合入 https://github.com/AMD-AGI/Primus/pull/101\r\n 请 {Lin, Mei} review 并合入 https://github.com/AMD-AGI/Primus/pull/102\r\n 请 {Lin, Mei} review 并合入 https://github.com/AMD-AGI/Primus/pull/103\r\n 请 {Lin, Mei} review 并合入 https://github.com/AMD-AGI/Primus/pull/104\r\n 请 {Lin, Mei} review 并合入 https://github.com/AMD-AGI/Primus/pull/105\r\n 请 {Lin, Mei} review 并合入 https://github.com/AMD-AGI/Primus/pull/106\r\n 请 {Lin, Mei} review 并合入 https://github.com/AMD-AGI/Primus/pull/107\r\n 请 {Lin, Mei} review 并合入 https://github.com/AMD-AGI/Primus/pull/108\r\n 请 {Lin, Mei} review 并合入 https://github.com/AMD-AGI/Primus/pull/109\r\n 请 {Lin, Mei} review 并合入 https://github.com/AMD-AGI/Primus/pull/110",
    html: "",
    quoted: "",
    outcome: [
      "start",
      "u-lin",
      [
        "AMD-AGI/Primus#101",
        "AMD-AGI/Primus#102",
        "AMD-AGI/Primus#103",
        "AMD-AGI/Primus#104",
        "AMD-AGI/Primus#105",
        "AMD-AGI/Primus#106",
        "AMD-AGI/Primus#107",
        "AMD-AGI/Primus#108",
        "AMD-AGI/Primus#109",
        "AMD-AGI/Primus#110",
      ],
      null,
    ],
    reading: {
      intent: "review_merge",
      reviewer: "29:w",
      reviewers: ["29:w"],
      prs: [
        "https://github.com/AMD-AGI/Primus/pull/101",
        "https://github.com/AMD-AGI/Primus/pull/102",
        "https://github.com/AMD-AGI/Primus/pull/103",
        "https://github.com/AMD-AGI/Primus/pull/104",
        "https://github.com/AMD-AGI/Primus/pull/105",
        "https://github.com/AMD-AGI/Primus/pull/106",
        "https://github.com/AMD-AGI/Primus/pull/107",
        "https://github.com/AMD-AGI/Primus/pull/108",
        "https://github.com/AMD-AGI/Primus/pull/109",
        "https://github.com/AMD-AGI/Primus/pull/110",
      ],
      model: "",
    },
  },
  {
    id: "zh-can-it-merge",
    text: "Bob 帮我看看这几个 PR 能不能合：AMD-AGI/Hyperloom#1, AMD-AGI/Hyperloom#2",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2"], null],
    reading: {
      intent: "review_merge",
      reviewer: "Bob",
      reviewers: ["Bob"],
      prs: ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2"],
      model: "",
    },
  },
  {
    id: "en-mention",
    text: "{Bob} please review and merge AMD-AGI/Hyperloom#1 and AMD-AGI/Hyperloom#2",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2"], null],
    reading: {
      intent: "review_merge",
      reviewer: "29:b",
      reviewers: ["29:b"],
      prs: ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2"],
      model: "",
    },
  },
  {
    id: "en-link",
    text: "Bob, could you review & merge https://github.com/AMD-AGI/Hyperloom/pull/2?",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#2"], null],
    reading: {
      intent: "review_merge",
      reviewer: "Bob",
      reviewers: ["Bob"],
      prs: ["https://github.com/AMD-AGI/Hyperloom/pull/2"],
      model: "",
    },
  },
  {
    id: "zh-then",
    text: "请 Mei Lin review 一下然后合入 AMD-AGI/Primus#3",
    html: "",
    quoted: "",
    outcome: ["start", "u-lin", ["AMD-AGI/Primus#3"], null],
    reading: {
      intent: "review_merge",
      reviewer: "Mei Lin",
      reviewers: ["Mei Lin"],
      prs: ["AMD-AGI/Primus#3"],
      model: "",
    },
  },
  {
    id: "account-name",
    text: "请 linmei0120 review合入 AMD-AGI/Hyperloom#1 AMD-AGI/Hyperloom#2",
    html: "",
    quoted: "",
    outcome: ["start", "u-lin", ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2"], null],
    reading: {
      intent: "review_merge",
      reviewer: "linmei0120",
      reviewers: ["linmei0120"],
      prs: ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2"],
      model: "",
    },
  },
  {
    id: "flat-name",
    text: "请 linmei 帮忙 review 并合入 AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["start", "u-lin", ["AMD-AGI/Hyperloom#1"], null],
    reading: {
      intent: "review_merge",
      reviewer: "linmei",
      reviewers: ["linmei"],
      prs: ["AMD-AGI/Hyperloom#1"],
      model: "",
    },
  },
  {
    id: "model-yong",
    text: "请 Bob 用 claude-opus-5.5 帮我 review 合入 AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1"], "claude-opus-5.5"],
    reading: {
      intent: "review_merge",
      reviewer: "Bob",
      reviewers: ["Bob"],
      prs: ["AMD-AGI/Hyperloom#1"],
      model: "claude-opus-5.5",
    },
  },
  {
    id: "model-colon",
    text: "review merge AMD-AGI/Hyperloom#1 by Bob, model: gpt-6-luna",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1"], "gpt-6-luna"],
    reading: {
      intent: "review_merge",
      reviewer: "Bob",
      reviewers: ["Bob"],
      prs: ["AMD-AGI/Hyperloom#1"],
      model: "gpt-6-luna",
    },
  },
  {
    id: "nobody-named",
    text: "帮我 review 合入 AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["say", "请指定由谁来 review 合入"],
    reading: { intent: "review_merge", reviewer: "", reviewers: [], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
  {
    id: "review-only-zh",
    text: "请 Bob 帮我 review AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1"], null],
    reading: { intent: "review", reviewer: "Bob", reviewers: ["Bob"], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
  {
    id: "review-only-en",
    text: "review https://github.com/AMD-AGI/Hyperloom/pull/2",
    html: "",
    quoted: "",
    outcome: ["chat"],
    reading: {
      intent: "review",
      reviewer: "",
      reviewers: [],
      prs: ["https://github.com/AMD-AGI/Hyperloom/pull/2"],
      model: "",
    },
  },
  {
    id: "question",
    text: "AMD-AGI/Hyperloom#1 这个 PR 是做什么的？",
    html: "",
    quoted: "",
    outcome: ["chat"],
    reading: { intent: "none", reviewer: "", reviewers: [], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
  {
    id: "merged-yet",
    text: "AMD-AGI/Hyperloom#1 合入了吗？",
    html: "",
    quoted: "",
    outcome: ["chat"],
    reading: { intent: "none", reviewer: "", reviewers: [], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
  {
    id: "land",
    text: "Bob 能帮忙 land 一下 AMD-AGI/Hyperloom#1 吗",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1"], null],
    reading: { intent: "review_merge", reviewer: "Bob", reviewers: ["Bob"], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
  {
    id: "name-and-mention",
    text: "请 Bob {Bob} review 合入 AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1"], null],
    reading: { intent: "review_merge", reviewer: "29:b", reviewers: ["29:b"], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
  {
    id: "hyperlink",
    text: "请 Bob review 合入 这个 PR",
    html: '<p>请 Bob review 合入 <a href="https://github.com/AMD-AGI/Hyperloom/pull/1">这个 PR</a></p>',
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1"], null],
    reading: {
      intent: "review_merge",
      reviewer: "Bob",
      reviewers: ["Bob"],
      prs: ["https://github.com/AMD-AGI/Hyperloom/pull/1"],
      model: "",
    },
  },
  {
    id: "quote",
    text: "请 Bob review 合入上面引用的 PR",
    html: "",
    quoted: "新的 PR：AMD-AGI/Hyperloom#2",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#2"], null],
    reading: { intent: "review_merge", reviewer: "Bob", reviewers: ["Bob"], prs: ["AMD-AGI/Hyperloom#2"], model: "" },
  },
  {
    id: "mixed-separators",
    text: "请 Bob review 合入 AMD-AGI/Hyperloom#1、https://github.com/AMD-AGI/Hyperloom/pull/2，AMD-AGI/Primus#3",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2", "AMD-AGI/Primus#3"], null],
    reading: {
      intent: "review_merge",
      reviewer: "Bob",
      reviewers: ["Bob"],
      prs: ["AMD-AGI/Hyperloom#1", "https://github.com/AMD-AGI/Hyperloom/pull/2", "AMD-AGI/Primus#3"],
      model: "",
    },
  },
  {
    id: "en-lines",
    text: "Bob please review+merge:\nAMD-AGI/Hyperloom#1\nAMD-AGI/Hyperloom#2",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2"], null],
    reading: {
      intent: "review_merge",
      reviewer: "Bob",
      reviewers: ["Bob"],
      prs: ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2"],
      model: "",
    },
  },
  {
    id: "merge-if-ok",
    text: "Bob 帮我 review 一下 AMD-AGI/Hyperloom#1，没问题就合了吧",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1"], null],
    reading: { intent: "review_merge", reviewer: "Bob", reviewers: ["Bob"], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
  {
    id: "only-one-of-two",
    text: "请 Bob review 合入 AMD-AGI/Hyperloom#1，另外 AMD-AGI/Hyperloom#2 先别动",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1"], null],
    reading: { intent: "review_merge", reviewer: "Bob", reviewers: ["Bob"], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
  {
    id: "about-the-words",
    text: "what does review 合入 mean? e.g. AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["chat"],
    reading: { intent: "none", reviewer: "", reviewers: [], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
  {
    id: "same-twice",
    text: "请 Bob 帮我 review 合入 AMD-AGI/Hyperloom#1 AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1"], null],
    reading: {
      intent: "review_merge",
      reviewer: "Bob",
      reviewers: ["Bob"],
      prs: ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#1"],
      model: "",
    },
  },
  {
    id: "lower-case",
    text: "请 bob review and merge amd-agi/hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1"], null],
    reading: { intent: "review_merge", reviewer: "bob", reviewers: ["bob"], prs: ["amd-agi/hyperloom#1"], model: "" },
  },
  {
    id: "other-owner",
    text: "请 Bob 帮我 review 合入 someone-else/repo#3",
    html: "",
    quoted: "",
    outcome: ["say", "我只处理这些组织的公开仓库里的 PR"],
    reading: { intent: "review_merge", reviewer: "Bob", reviewers: ["Bob"], prs: ["someone-else/repo#3"], model: "" },
  },
  {
    id: "unusable-model",
    text: "请 Bob 用 gpt-9 帮我 review 合入 AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["say", "Bob 的 key 用不了模型 gpt-9"],
    reading: {
      intent: "review_merge",
      reviewer: "Bob",
      reviewers: ["Bob"],
      prs: ["AMD-AGI/Hyperloom#1"],
      model: "gpt-9",
    },
  },
  {
    id: "zh-merge-after",
    text: "Bob，麻烦 review 后合并 AMD-AGI/Hyperloom#1 和 AMD-AGI/Hyperloom#2",
    html: "",
    quoted: "",
    outcome: ["start", "u-bob", ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2"], null],
    reading: {
      intent: "review_merge",
      reviewer: "Bob",
      reviewers: ["Bob"],
      prs: ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2"],
      model: "",
    },
  },
  {
    id: "two-carols",
    text: "请 Carol 帮我 review 合入 AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["say", "不止一位叫「Carol」"],
    reading: {
      intent: "review_merge",
      reviewer: "Carol",
      reviewers: ["Carol"],
      prs: ["AMD-AGI/Hyperloom#1"],
      model: "",
    },
  },
  {
    id: "not-in-group",
    text: "请 Zed 帮我 review 合入 AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["say", "没有找到「Zed」"],
    reading: { intent: "review_merge", reviewer: "Zed", reviewers: ["Zed"], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
  {
    id: "two-people-one-line",
    text: "请 Bob review 合入 AMD-AGI/Hyperloom#1，Carol review 合入 AMD-AGI/Hyperloom#2",
    html: "",
    quoted: "",
    outcome: ["say", "只能请同一位 reviewer"],
    reading: {
      intent: "review_merge",
      reviewer: "Bob",
      reviewers: ["Bob", "Carol"],
      prs: ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2"],
      model: "",
    },
  },
  {
    id: "two-people-mentioned",
    text: "{Bob} 合入 AMD-AGI/Hyperloom#1，{Carol} 合入 AMD-AGI/Hyperloom#2，都先 review 一下",
    html: "",
    quoted: "",
    outcome: ["say", "只能请同一位 reviewer"],
    reading: {
      intent: "review_merge",
      reviewer: "29:b",
      reviewers: ["29:b", "29:c"],
      prs: ["AMD-AGI/Hyperloom#1", "AMD-AGI/Hyperloom#2"],
      model: "",
    },
  },
  {
    id: "split-mention",
    text: "请 {Lin,} {Mei} review 并合入 AMD-AGI/Hyperloom#1",
    html: "",
    quoted: "",
    outcome: ["start", "u-lin", ["AMD-AGI/Hyperloom#1"], null],
    reading: { intent: "review_merge", reviewer: "29:w", reviewers: ["29:w"], prs: ["AMD-AGI/Hyperloom#1"], model: "" },
  },
];
