// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the message of a terminal's turn that ended while nobody was at it says (`terminalEndNotice`, `terminalEndSummary`): one line
 * that names the conversation first, then what the agent did in whole sentences from the start of its last answer (never a tail that
 * starts mid-sentence), then the commands for it. The answers are shaped as the connector posts them (`message`: at most the last
 * 2000 characters of the agent's last answer, "…" first when cut). An end that folds in an earlier turn that asked the person
 * something, or failed, leads with that turn (`terminalEarlierLeads`, `terminalAskSummary`): its own words, or how many when the
 * connector no longer carries them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  END_SENTENCE_MAX, END_SUMMARY_MAX, terminalAskSummary, terminalAttachCommand, terminalEarlierLeads, terminalEndNotice, terminalEndSummary,
} from "../src/assistant/remote-items.js";

/** An answer as an agent writes one: what it did first, then the details, then what comes next. */
const ANSWER = [
  "staging 已经清空：04:50Z 起没有任何 Pod，job 1930 的沙箱、app Pod 和 job 1932 的 Pod 都没了，node-a 和 node-b 上的 Pod 数是 0。"
    + "这两台节点还挂着，是否释放由集群那边决定，我没动。已经回报调度会话。",
  "下一步在等调度会话：它在加一个钉版本的参数，合入部署约一个多小时。",
  "重跑起来后，我只读观察三项：\n- 第一个测试的冷启动秒数；\n- 预读的结果文件，并确认没有 OOM；\n- 页缓存命中率。",
].join("\n\n");
const WHERE = { machine: "dev-pod", agent_id: "claude", tool: "claude" as const, lang: "zh" as const, title: "tools", cwd: "/home/u/ops/tools", name: "ops" };

test("the message names the conversation first, says what it did in whole sentences, and ends with its commands", () => {
  // Before: `#268 dev-pod 上终端里的 Claude Code（ops，ops/tools）做完了，之后终端那边一直没人操作。\n它最后说：\n…的沙箱、app Pod …`
  const said = terminalEndSummary(ANSWER);
  assert.deepEqual(said, {
    summary: "staging 已经清空：04:50Z 起没有任何 Pod，job 1930 的沙箱、app Pod 和 job 1932 的 Pod 都没了，node-a 和 node-b 上的 Pod 数是 0。"
      + "这两台节点还挂着，是否释放由集群那边决定，我没动。已经回报调度会话。",
    more: true,
  });
  assert.equal(terminalEndNotice(WHERE, 268, false, "", said, "/agent attach 3f2a9c1d"), [
    "【ops】做完了 · dev-pod · ops/tools · 终端空闲 · #268",
    `${said.summary}（全文见终端）`,
    "接入：/agent attach 3f2a9c1d　静音：/approvals mute #268",
  ].join("\n"));
  assert.equal(
    terminalEndNotice({ ...WHERE, lang: "en", name: undefined }, 7, true, "rate_limit", { summary: "Hit the rate limit.", more: false }, null),
    "[tools] stopped with an error (rate\\_limit) · dev-pod · ops/tools · terminal idle · #7\nHit the rate limit.\nMute: /approvals mute #7",
  );
  // What the agent or its machine wrote is inert in the text, which a channel reads as markdown: no link, image or markup.
  const sly = terminalEndNotice(
    { ...WHERE, lang: "en", name: "[Confirm](https://x.example)" }, 9, false, "",
    terminalEndSummary("See [the report](https://x.example/r) and ![x](https://x.example/i.png) at www.x.example."), null,
  );
  assert.equal(sly.split("\n")[0], "[\\[Confirm\\]\\(https:/\u200b/x.example\\)] finished · dev-pod · ops/tools · terminal idle · #9");
  assert.doesNotMatch(sly, /\]\(|https:\/\/|(?<!\\)!\[|www\.x/u);
  // No name and no title: the tool names it. Nothing said: the head and the commands only.
  assert.equal(
    terminalEndNotice({ ...WHERE, name: undefined, title: "" }, 3, false, "", { summary: "", more: false }, null),
    "【Claude Code】做完了 · dev-pod · ops/tools · 终端空闲 · #3\n静音：/approvals mute #3",
  );
});

test("an answer the connector cut is read from the block that sums it up, else from its last paragraph, never from mid-sentence", () => {
  const cut = `…${ANSWER.slice(-150)}`;
  assert.deepEqual(terminalEndSummary(cut), {
    summary: "重跑起来后，我只读观察三项：\n- 第一个测试的冷启动秒数；\n- 预读的结果文件，并确认没有 OOM；",
    more: true,
  });
  assert.deepEqual(terminalEndSummary("…the details.\n\n## Summary\n- Fixed the flaky test\n- Added a regression test\n\nShall I open the PR?"), {
    summary: "- Fixed the flaky test\n- Added a regression test", more: true,
  });
  assert.deepEqual(terminalEndSummary("Working on it.\n\n**Summary:** all 312 tests pass; lint is clean."), {
    summary: "all 312 tests pass; lint is clean.", more: true,
  });
  // One cut paragraph: from its first sentence that starts whole.
  assert.deepEqual(terminalEndSummary("…ed the server first. Then the test passed. Done."), { summary: "Then the test passed. Done.", more: true });
});

test("a whole answer is read from its start: its first paragraph, its emphasis and code ticks dropped, a list kept to three lines", () => {
  assert.deepEqual(terminalEndSummary("I fixed the flaky test in `api/foo.test.ts`. **All 312 tests pass.**"), {
    summary: "I fixed the flaky test in api/foo.test.ts. All 312 tests pass.", more: false,
  });
  assert.deepEqual(terminalEndSummary("Done:\n- a\n- b\n- c\n- d"), { summary: "Done:\n- a\n- b", more: true });
  assert.deepEqual(terminalEndSummary("全部测试通过。\n下一步：发 PR。"), { summary: "全部测试通过。下一步：发 PR。", more: false });
  assert.deepEqual(terminalEndSummary(""), { summary: "", more: false });
  assert.deepEqual(terminalEndSummary("  \n "), { summary: "", more: false });
});

test("whole sentences are kept while they fit; a first sentence much too long is cut after a clause, with an ellipsis", () => {
  const sentence = (n: number) => `第${n}句${"很".repeat(40)}长。`;
  const long = [1, 2, 3, 4, 5].map(sentence).join("");
  const said = terminalEndSummary(long);
  assert.equal(said.summary, [1, 2, 3, 4].map(sentence).join(""));
  assert.ok(Array.from(said.summary).length <= END_SUMMARY_MAX);
  assert.equal(said.more, true);
  // A first sentence somewhat longer than the limit is still said whole; only a much longer one is cut, after a clause.
  const whole = `${"甲".repeat(120)}，${"乙".repeat(120)}。`;
  assert.deepEqual(terminalEndSummary(`${whole}后面还有。`), { summary: whole, more: true });
  assert.deepEqual(terminalEndSummary(whole), { summary: whole, more: false });
  assert.ok(Array.from(whole).length > END_SUMMARY_MAX && Array.from(whole).length <= END_SENTENCE_MAX);
  const one = `${"甲".repeat(150)}，${"乙".repeat(250)}。`;
  assert.deepEqual(terminalEndSummary(one), { summary: `${"甲".repeat(150)}…`, more: true });
  const words = `${"word ".repeat(80).trim()}.`;
  const cutWords = terminalEndSummary(words).summary;
  assert.match(cutWords, /^word( word)+…$/);
  assert.ok(Array.from(cutWords).length <= END_SUMMARY_MAX);
});

test("the attach command names a conversation by the start of its ref, and only a ref the channel can carry", () => {
  assert.equal(terminalAttachCommand("3f2a9c1d-7b6e-4c1a-9d2e-0a1b2c3d4e5f"), "/agent attach 3f2a9c1d");
  assert.equal(terminalAttachCommand("conv-1"), "/agent attach conv-1");
  assert.equal(terminalAttachCommand("abc"), null);
  assert.equal(terminalAttachCommand("a b c d e f"), null);
  assert.equal(terminalAttachCommand(null), null);
});

test("an earlier turn that asked or failed leads the message: its question in whole sentences, then the latest turn", () => {
  const kept = [
    { text: "构建通过。", failed: false },
    { text: "…部署包已经构建好，测试也都过了。\n\n发布前还有一件事：staging 的配置我没改。要不要我现在发布到生产？", failed: false },
    { text: "API Error: 429 [rate limited](https://evil.example)", failed: true },
    { text: "日志已归档。", failed: false },
  ];
  const leads = terminalEarlierLeads(kept, 1, 1);
  assert.deepEqual(leads, [
    { kind: "asked", text: "发布前还有一件事：staging 的配置我没改。要不要我现在发布到生产？", count: 1 },
    { kind: "failed", text: "API Error: 429 [rate limited](https://evil.example)", count: 1 },
  ]);
  const notice = terminalEndNotice(WHERE, 9, false, "", { summary: "日志已归档。", more: false }, "/agent attach conv-1", leads);
  assert.equal(notice.split("\n")[1], "早先一轮在问你：发布前还有一件事：staging 的配置我没改。要不要我现在发布到生产？");
  assert.match(notice.split("\n")[2] ?? "", /^早先一轮出错停下：API Error: 429 \\\[rate limited\\\]\\\(https/u, "inert");
  assert.equal(notice.split("\n")[3], "最新一轮：日志已归档。");
  assert.equal(notice.split("\n")[4], "接入：/agent attach conv-1　静音：/approvals mute #9");
  const en = terminalEndNotice({ ...WHERE, lang: "en" }, 9, false, "", { summary: "Logs archived.", more: false }, null,
    terminalEarlierLeads([{ text: "Build is ready.\n\nShould I publish it?", failed: false }], 2, 0));
  assert.deepEqual(en.split("\n").slice(1, 3), [
    "An earlier turn asked: Should I publish it? (2 earlier turns asked; see the terminal)", "Latest turn: Logs archived.",
  ]);
});

test("an earlier question whose words the connector no longer carries is still said, with how many and where to look", () => {
  const leads = terminalEarlierLeads([{ text: "report 6", failed: false }], 2, 0);
  assert.deepEqual(leads, [{ kind: "asked", text: "", count: 2 }]);
  assert.equal(terminalEndNotice(WHERE, 3, false, "", { summary: "第七份报告。", more: false }, "/agent attach conv-1", leads),
    "【ops】做完了 · dev-pod · ops/tools · 终端空闲 · #3\n早先有 2 轮在问你，详见终端\n最新一轮：第七份报告。\n接入：/agent attach conv-1　静音：/approvals mute #3");
  // A failure an older connector does not place among the words: counted, said, never quoted from a turn that did not fail.
  assert.deepEqual(terminalEarlierLeads([{ text: "API Error: 429", failed: false }], 0, 1), [{ kind: "failed", text: "", count: 1 }]);
  assert.equal(terminalEndNotice({ ...WHERE, lang: "en" }, 3, false, "", { summary: "", more: false }, null, [{ kind: "failed", text: "", count: 3 }]),
    "[ops] finished · dev-pod · ops/tools · terminal idle · #3\n3 earlier turns stopped with an error; see the terminal\nMute: /approvals mute #3");
  assert.deepEqual(terminalEarlierLeads([{ text: "构建通过。", failed: false }], 0, 0), [], "nothing asked or failed: nothing leads");
});

test("an asking turn's words are the end of its last paragraph, in whole sentences", () => {
  const sentence = (n: number) => `第${n}句${"很".repeat(40)}长。`;
  const ask = "要不要我现在合入？";
  const long = `${[1, 2, 3, 4, 5].map(sentence).join("")}${ask}`;
  const said = terminalAskSummary(long);
  assert.equal(said, `…${[2, 3, 4, 5].map(sentence).join("")}${ask}`);
  assert.ok(Array.from(said).length <= END_SUMMARY_MAX + 1);
  assert.equal(terminalAskSummary("Done.\n\n**Should I** open the PR?"), "Should I open the PR?");
  const longAsk = `${"甲".repeat(250)}，要不要继续？`;
  assert.equal(terminalAskSummary(`前面一句。${longAsk}`), `…${longAsk}`, "a last sentence a little too long is kept whole");
  assert.ok(Array.from(longAsk).length <= END_SENTENCE_MAX);
  const huge = `${"乙".repeat(500)}，可以吗？`;
  const tail = terminalAskSummary(huge);
  assert.ok(tail.startsWith("…") && tail.endsWith("可以吗？") && Array.from(tail).length === END_SUMMARY_MAX, tail);
  assert.equal(terminalAskSummary("  "), "");
});
