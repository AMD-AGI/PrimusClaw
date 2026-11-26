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
 *   S3 the agent's quoted result ends in a sentence's end, and the fixed sentence after it never runs into it (zh: its own line; en: after a space)
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { asksPerson, closeSentence, gather, terminalDigestNotice } = await import("../src/assistant/terminal-digest.js");

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
    gather(p, 1000, { turns: 1, failed: 0, asks: false, said: ["one"] });
    gather(p, 2000, { turns: 3, failed: 1, asks: false, said: ["two", "three"] });
    gather(p, 3000, { turns: 1, failed: 0, asks: true, said: ["four"] });
    assert.deepEqual(p.digest, { first_at: 1000, last_at: 3000, turns: 5, failed: 1, asks: 1, said: ["two", "three", "four"] });
  });

  test("S2 its words", () => {
    const p = { machine: "laptop", agent_id: "claude", tool: "claude", lang: "zh", title: "修 CI", cwd: "/home/u/work/claw", name: "nightly-bot" } as const;
    const d = { first_at: 0, last_at: 0, turns: 4, failed: 1, asks: 0, said: ["CI 全绿。"] };
    assert.equal(terminalDigestNotice(p, 7, d, 60 * 60_000, "/agent attach conv-123"),
      "【nightly-bot】持续工作中 · laptop · work/claw · #7\n"
      + "过去 60 分钟里又跑了 4 轮，其中 1 轮出错。最近：CI 全绿。\n不需要你处理。\n"
      + "接入：/agent attach conv-123　静音：/approvals mute #7　间隔：/approvals summary <分钟>|off");
    const en = terminalDigestNotice({ ...p, lang: "en", name: "" }, 7, { ...d, failed: 0, asks: 2, turns: 1 }, 3 * 60 * 60_000, null);
    assert.equal(en,
      "[修 CI] still working · laptop · work/claw · #7\n"
      + "In the last 3 h it ran 1 more turn. Latest: CI 全绿。 2 of them asked you something; see the terminal.\n"
      + "Mute: /approvals mute #7  ·  How often: /approvals summary <minutes>|off");
  });

  // Results a real Claude Code left as the last words of a turn: a bare token (a one-word `claude -p` reply, which the summary said as
  // "最近：S21A-35791359不需要你处理。"), a Chinese result without its stop, an English one.
  const sayIt = (lang: "zh" | "en", said: string[], extra: { turns?: number; asks?: number } = {}) =>
    terminalDigestNotice(
      { machine: "laptop", agent_id: "claude", tool: "claude", lang, title: "t", cwd: "/home/u/work/claw", name: "nightly-bot" }, 7,
      { first_at: 0, last_at: 0, turns: extra.turns ?? 1, failed: 0, asks: extra.asks ?? 0, said }, 15 * 60_000, null,
    ).split("\n").slice(1, -1).join("\n");

  test("S3 a result that ends without a sentence end gets one, and the fixed sentence starts after it", () => {
    // (the stop is the one of the agent's own language, whatever language the notice around it is in)
    for (const [said, closed] of [
      ["S21A-35791359", "S21A-35791359."],
      ["测试全部通过，已推送", "测试全部通过，已推送。"],
      ["已推送到 main", "已推送到 main。"],
      ["All 214 tests pass and the branch is pushed", "All 214 tests pass and the branch is pushed."],
      ["构建通过，", "构建通过。"],
      ["Next steps:", "Next steps."],
    ] as const) {
      assert.equal(sayIt("zh", [said]), `过去 15 分钟里又跑了 1 轮。最近：${closed}\n不需要你处理。`, said);
      assert.equal(sayIt("en", [said]), `In the last 15 min it ran 1 more turn. Latest: ${closed} Nothing needs you.`, said);
    }
  });

  test("S3 one that already ends in a sentence end, or an ellipsis where it was cut, is left as it is", () => {
    for (const said of ["CI 全绿。", "Done.", "已经推送！", "Did it push?", "（已推送。）", "他说：“已推送。”", "第一步做完了，第二步…", "Tests pass..."]) {
      assert.equal(sayIt("zh", [said]), `过去 15 分钟里又跑了 1 轮。最近：${said}\n不需要你处理。`, said);
      assert.equal(sayIt("en", [said]), `In the last 15 min it ran 1 more turn. Latest: ${said} Nothing needs you.`, said);
    }
  });

  test("S3 several lines are one result: the stop comes after the last; markdown the agent wrote stays inert", () => {
    assert.equal(sayIt("en", ["(pushed.)"]), "In the last 15 min it ran 1 more turn. Latest: \\(pushed.\\) Nothing needs you.", "a stop inside a bracket is one");
    assert.equal(sayIt("zh", ["- 构建通过\n- 测试通过"]), "过去 15 分钟里又跑了 1 轮。最近：- 构建通过；- 测试通过。\n不需要你处理。");
    assert.equal(sayIt("en", ["- build passes\n- tests pass"]), "In the last 15 min it ran 1 more turn. Latest: - build passes; - tests pass. Nothing needs you.");
    assert.equal(sayIt("zh", ["改了 foo_bar()"]), "过去 15 分钟里又跑了 1 轮。最近：改了 foo\\_bar\\(\\)。\n不需要你处理。");
  });

  test("S3 what asks the person, or no result at all, reads the same way", () => {
    assert.equal(sayIt("zh", ["S21A-35791359"], { asks: 2, turns: 3 }), "过去 15 分钟里又跑了 3 轮。最近：S21A-35791359.\n有 2 轮在问你，详情见终端。");
    assert.equal(sayIt("en", ["S21A-35791359"], { asks: 2, turns: 3 }),
      "In the last 15 min it ran 3 more turns. Latest: S21A-35791359. 2 of them asked you something; see the terminal.");
    // nothing quoted, nothing to part: the system's sentences stay on one line as before
    assert.equal(sayIt("zh", []), "过去 15 分钟里又跑了 1 轮。不需要你处理。");
    assert.equal(sayIt("zh", ["  "]), "过去 15 分钟里又跑了 1 轮。不需要你处理。");
    assert.equal(sayIt("en", []), "In the last 15 min it ran 1 more turn. Nothing needs you.");
  });

  test("S3 closeSentence", () => {
    for (const [text, want] of [
      ["", ""], ["  \n ", ""], ["，；", ""],
      ["已推送", "已推送。"], ["pushed", "pushed."], ["pushed;", "pushed."], ["已推送；", "已推送。"], ["かんりょう", "かんりょう。"],
      ["已推送。", "已推送。"], ["pushed.", "pushed."], ["pushed!", "pushed!"], ["pushed)", "pushed)."], ["v1.2", "v1.2."],
    ] as const) assert.equal(closeSentence(text), want, JSON.stringify(text));
  });
});
