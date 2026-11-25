// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which ends of a terminal's turns are pushed, and the summary of a conversation that keeps working on its own
 * (assistant/terminal-digest.ts), without a database:
 *
 *   A1 asks the person: a question at the end of the answer, or words that wait for a choice, an approval or a decision (zh, en)
 *   A2 does not: a report that only mentions a question earlier, a plain result, an empty answer
 *   S1 gathering: turns counted (a folded run counts all of its turns), failures and held-back questions counted, three results kept
 *   S2 the summary's words: which conversation, at most three sentences, and the commands; nothing needs you / asked you
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { asksPerson, gather, terminalDigestNotice } = await import("../src/assistant/terminal-digest.js");

describe("which ends ask the person", () => {
  test("A1 a question at the end, or words that wait for the person", () => {
    for (const m of [
      "测试都过了。要不要我顺手把 PR 也开了？",
      "Tests pass.\n\nShould I open the PR now?",
      "两个方案：A 改配置，B 改代码。你来定。",
      "已经准备好迁移脚本，请确认后我再执行。",
      "部署包已构建，等你批准后发布。",
      "I can go either way. Let me know which option you prefer.",
      "Ready to merge — waiting for your approval.",
      "**Question:** do you want me to rebase onto main? 🙂",
      "这样可以吗",
    ]) assert.equal(asksPerson(m), true, m);
  });

  test("A2 a plain report is not a question", () => {
    for (const m of [
      "",
      "全部测试通过，PR #12 已合入。",
      "Fixed the flaky test; CI is green.",
      "用户问：为什么会超时？\n\n原因是连接池太小，已调到 50，已验证通过。",
      "Checked whether should I worry about the cache: no, it is fine.\n\nDone.",
    ]) assert.equal(asksPerson(m), false, m);
  });
});

describe("the summary", () => {
  test("S1 gathering counts turns, failures and questions, and keeps the newest three results", () => {
    const p: { digest?: any } = {};
    gather(p, 1000, { turns: 1, failed: false, asks: false, said: ["one"] });
    gather(p, 2000, { turns: 3, failed: true, asks: false, said: ["two", "three"] });
    gather(p, 3000, { turns: 1, failed: false, asks: true, said: ["four"] });
    assert.deepEqual(p.digest, { first_at: 1000, last_at: 3000, turns: 5, failed: 1, asks: 1, said: ["two", "three", "four"] });
  });

  test("S2 its words", () => {
    const p = { machine: "laptop", agent_id: "claude", tool: "claude", lang: "zh", title: "修 CI", cwd: "/home/u/work/claw", name: "nightly-bot" } as const;
    const d = { first_at: 0, last_at: 0, turns: 4, failed: 1, asks: 0, said: ["CI 全绿。"] };
    assert.equal(terminalDigestNotice(p, 7, d, 60 * 60_000, "/agent attach conv-123"),
      "【nightly-bot】持续工作中 · laptop · work/claw · #7\n"
      + "过去 60 分钟里又跑了 4 轮，其中 1 轮出错。最近：CI 全绿。不需要你处理。\n"
      + "接入：/agent attach conv-123　静音：/approvals mute #7　间隔：/approvals summary <分钟>|off");
    const en = terminalDigestNotice({ ...p, lang: "en", name: "" }, 7, { ...d, failed: 0, asks: 2, turns: 1 }, 3 * 60 * 60_000, null);
    assert.equal(en,
      "[修 CI] still working · laptop · work/claw · #7\n"
      + "In the last 3 h it ran 1 more turn. Latest: CI 全绿。 2 of them asked you something; see the terminal.\n"
      + "Mute: /approvals mute #7  ·  How often: /approvals summary <minutes>|off");
  });
});
