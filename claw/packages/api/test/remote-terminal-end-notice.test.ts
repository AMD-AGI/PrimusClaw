// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the message of a terminal's turn that ended while nobody was at it says (`terminalEndNotice`, `terminalEndSummary`): one line
 * that names the conversation first, then what the agent did in whole sentences from the start of its last answer (never a tail that
 * starts mid-sentence), then the commands for it. The answers are shaped as the connector posts them (`message`: at most the last
 * 2000 characters of the agent's last answer, "…" first when cut).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { END_SUMMARY_MAX, terminalAttachCommand, terminalEndNotice, terminalEndSummary } from "../src/assistant/remote-items.js";

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

test("whole sentences are kept while they fit; a first sentence too long is cut after a clause, with an ellipsis", () => {
  const sentence = (n: number) => `第${n}句${"很".repeat(40)}长。`;
  const long = [1, 2, 3, 4, 5].map(sentence).join("");
  const said = terminalEndSummary(long);
  assert.equal(said.summary, [1, 2, 3, 4].map(sentence).join(""));
  assert.ok(Array.from(said.summary).length <= END_SUMMARY_MAX);
  assert.equal(said.more, true);
  const one = `${"甲".repeat(120)}，${"乙".repeat(120)}。`;
  assert.deepEqual(terminalEndSummary(one), { summary: `${"甲".repeat(120)}…`, more: true });
  const words = `${"word ".repeat(60).trim()}.`;
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
