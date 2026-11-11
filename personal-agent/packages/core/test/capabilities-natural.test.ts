// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Ported from teams/tests/test_capabilities.py: the plain sentences read as the command they mean (`naturalCommand`). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isKnownCommand } from "../src/commands/names.js";
import { naturalCommand } from "../src/capabilities/natural.js";
import { CAPABILITIES } from "../src/capabilities/registry.js";
import { pySplit } from "../src/text/py-text.js";

const EXAMPLES = CAPABILITIES.filter((c) => c.sayZh !== "");

test("test_ways_of_saying_the_same", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["帮助", "/help"],
    ["怎么用？", "/help"],
    ["What can you do?", "/help"],
    ["晚上十点到早上八点别打扰我", "/quiet 22:00-08:00"],
    ["晚上 11 点半到早上 7 点不要打扰我", "/quiet 23:30-07:00"],
    ["免打扰改成 23:00-07:00", "/quiet 23:00-07:00"],
    ["关掉免打扰", "/quiet off"],
    ["暂停通知半小时", "/pause 30m"],
    ["3 小时内别打扰我", "/pause 3h"],
    ["暂停通知", "/pause"],
    ["工作日早上 8 点半发简报给我", "/brief on 08:30"],
    ["不要简报了", "/brief off"],
    ["解绑 GitHub", "/github unbind"],
    ["我的 GitHub 连上了吗", "/github status"],
    ["关掉自动合入", "/github auto-merge off"],
    ["反馈: it hangs", "/feedback it hangs"],
    ["我要反馈", "/feedback"],
    ["切到 AMD-AGI/PrimusClaw dev 分支", "/repo AMD-AGI/PrimusClaw dev"],
  ];
  for (const [text, command] of cases) assert.equal(naturalCommand(text), command, text);
});

test("test_anything_else_is_a_request_for_claw", () => {
  for (const text of [
    "help me",
    "帮我看看这个 CI 为什么挂了",
    "晚上 10 点提醒我开会",
    "暂停一下这个任务然后看看日志",
    "帮我把 GitHub 的 PR 合了",
    "反馈一下这个 bug 给 Bob",
    "停止服务的命令是什么",
    "/quiet off",
    "link database",
    "",
    "切到仓库 not a repo",
  ]) {
    assert.equal(naturalCommand(text), text, text);
  }
});

test("test_a_group_reads_only_what_a_group_may_do", () => {
  assert.equal(naturalCommand("你能做什么", true), "/help");
  assert.equal(naturalCommand("停一下", true), "/stop");
  for (const text of ["晚上 10 点到早上 8 点别打扰我", "把我的 GitHub 连上", "看看我电脑上的 agent"]) {
    assert.equal(naturalCommand(text, true), text);
  }
});

test("test_a_sentence_for_what_this_chat_does_not_have_stays_words_for_claw", () => {
  assert.equal(naturalCommand("看看我的任务"), "/board");
  assert.equal(naturalCommand("看看我的任务", false, new Set(["board"])), "看看我的任务");
  assert.equal(naturalCommand("把我的 GitHub 连上", false, new Set(["github"])), "把我的 GitHub 连上");
  assert.equal(naturalCommand("停一下", false, new Set(["github", "board"])), "/stop");
});

test("test_every_command_a_sentence_means_is_one_the_worker_handles", () => {
  for (const c of EXAMPLES) {
    for (const say of [c.sayZh, c.sayEn]) {
      for (const group of [false, true]) {
        const command = naturalCommand(say, group);
        if (command === say) continue;
        const word = pySplit(command.slice(1))[0] ?? "";
        assert.ok(isKnownCommand(word) || word === "github" || word === "board", `${say} -> ${command}`);
      }
    }
  }
});

test("test_short_generic_words_are_no_longer_triggers", () => {
  for (const text of ["我的agent", "my agents", "agent会话"]) assert.equal(naturalCommand(text), text);
});

test("test_without_the_brief_a_brief_sentence_is_words_for_claw (natural_command part)", () => {
  assert.equal(naturalCommand("每天早上 9 点给我发简报", false, new Set(["brief"])), "每天早上 9 点给我发简报");
  assert.equal(naturalCommand("回来吧", false, new Set(["agent detach"])), "回来吧");
  assert.equal(naturalCommand("我的 agent 会话", false, new Set(["agent detach"])), "/agent sessions");
});

test("asking to introduce itself is help in a group and stays words in a 1:1 chat", () => {
  for (const text of [
    "介绍一下你自己",
    "介绍一下你自己！",
    "你是谁？",
    "自我介绍一下",
    "Introduce yourself.",
    "who are you",
  ]) {
    assert.equal(naturalCommand(text, true), "/help", text);
    assert.equal(naturalCommand(text), text, text);
  }
  // only the whole message: a request that starts the same way is still a request
  assert.equal(naturalCommand("介绍一下你自己是怎么审 PR 的", true), "介绍一下你自己是怎么审 PR 的");
});
