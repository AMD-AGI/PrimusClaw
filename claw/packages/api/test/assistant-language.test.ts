// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The language the assistant is told to answer in (`src/assistant/language.ts`).
 *
 *   L1  Chinese, Japanese, Korean and English are told apart, with the other things a message contains left out
 *   L2  a message that cannot be told, or is in another language, has no verdict rather than a wrong one
 *   L3  the verdict agrees with the language every evaluation message is labelled with
 *   L4  the language is the message's own, else the one the user wrote in before; a report is not the user's message
 *   L5  the line is the same every time and is added once
 */
import assert from "node:assert/strict";
import test from "node:test";

import { detectLanguage, languageToAnswerIn, replyLanguageLine, withReplyLanguage, REPLY_LANGUAGE_LABEL } from "../src/assistant/language.js";
import { WORK_EVENT_PREFIX } from "../src/assistant/prompts.js";
import { CASES } from "./e2e/assistant-router-eval-cases.js";

test("L1 the four languages are told apart", () => {
  const table: Array<[string, string]> = [
    ["帮我写个脚本，把 /data/runs 下超过 30 天的日志压缩归档", "Chinese"],
    ["帮我 review 一下 retry budget 那个 PR", "Chinese"],
    ["给 Primus-SaFE 的 README 加一节 FAQ，讲怎么申请 GPU 配额，改完提个 PR", "Chinese"],
    ["把docs/a2a.md翻成英文，代码块保持原样", "Chinese"],
    ["好的", "Chinese"],
    ["Can you find out why the nightly build on main has been red since yesterday?", "English"],
    ["Please stop the weekly one", "English"],
    ["thanks", "English"],
    ["I'm not sure it's the right item", "English"],
    ["What happened to Q3 MI300 利用率汇总 and why is it taking so long?", "English"],
    ["ビルドが赤い理由を調べてください", "Japanese"],
    ["이번 주 빌드가 왜 깨졌는지 알아봐 줘", "Korean"],
  ];
  for (const [text, want] of table) assert.equal(detectLanguage(text), want, text);
});

test("L1b code, links, paths and addresses do not decide the language", () => {
  assert.equal(detectLanguage("看看这个报错 ```\nthe build is failing and you should check that the cache is not stale\n```"), "Chinese");
  assert.equal(detectLanguage("看看 https://example.com/the/build/is/not/what/you/think 这个"), "Chinese");
  assert.equal(detectLanguage("what is `the and of to` about"), "English");
  assert.equal(detectLanguage("```\nthe and that this with you\n```"), null, "nothing outside the code is language");
  assert.equal(detectLanguage("send it to someone@example.com please"), "English");
  assert.equal(detectLanguage("see docs/the-and-that/with-you.md"), null);
});

test("L2 what cannot be told has no verdict", () => {
  for (const text of ["", "   ", "ok", "#3", "3", "👍", "stop", "Wie ist der Stand von #3?", "¿Cómo va el informe?", "Où en est le rapport ?", "Is dit klaar? Het is goed", "Это готово?"]) {
    assert.equal(detectLanguage(text), null, text);
  }
});

test("L3 the verdict is never different from the language every evaluation message is labelled with, and almost always there", async () => {
  const labelled = CASES.filter((c) => c.lang && !c.text.startsWith(WORK_EVENT_PREFIX));
  assert.ok(labelled.length >= 100, `${labelled.length} labelled messages`);
  const want = (c: { lang?: string }) => (c.lang === "zh" ? "Chinese" : "English");
  const wrong = labelled.filter((c) => { const got = detectLanguage(c.text); return got !== null && got !== want(c); });
  assert.deepEqual(wrong.map((c) => `${c.id}: ${c.text}`), [], "a wrong verdict is worse than none");
  const silent = labelled.filter((c) => detectLanguage(c.text) === null);
  assert.ok(silent.length <= 2, `no verdict for ${silent.map((c) => `${c.id}: ${c.text}`).join(" | ")}`);
  // Where the message shows nothing, the conversation does: every case that has earlier turns ends up with its label.
  for (const c of silent) {
    const earlier = [...(c.history ?? [])].reverse().map((h) => h.user);
    assert.equal(await languageToAnswerIn(c.text, () => earlier), earlier.length ? want(c) : null, c.id);
  }
  for (const turn of CASES.flatMap((c) => c.history ?? [])) {
    const language = detectLanguage(turn.user);
    assert.ok(language === null || language === "Chinese" || language === "English", turn.user);
  }
});

test("L4 the message's own language, else the user's earlier words, and a report is not the user's message", async () => {
  const asked: string[] = [];
  const earlier = (...texts: string[]) => () => { asked.push("asked"); return texts; };
  assert.equal(await languageToAnswerIn("What is the status?", earlier("请看一下")), "English");
  assert.deepEqual(asked, [], "the earlier messages are not read when the message shows its language");
  assert.equal(await languageToAnswerIn("ok", earlier("好", "请看一下")), "Chinese", "the newest of the earlier messages that has one");
  assert.equal(await languageToAnswerIn("ok", earlier("#3", "Please look")), "English", "one that cannot be told is passed over");
  assert.equal(await languageToAnswerIn(null, earlier("请看一下 the build")), "Chinese", "a report: the user's words decide");
  assert.equal(await languageToAnswerIn(null, earlier()), null);
  assert.equal(await languageToAnswerIn("ok", earlier("ok", "#2")), null, "nothing says, so no verdict");
  assert.equal(await languageToAnswerIn("ok", async () => ["Please look"]), "English", "earlier may be asked asynchronously");
});

test("L5 the line is the same every time and is added once", () => {
  assert.equal(replyLanguageLine("English"), "[Reply language: English]");
  assert.equal(REPLY_LANGUAGE_LABEL, "Reply language");
  const once = withReplyLanguage("hello there", "English");
  assert.equal(once, "hello there\n\n[Reply language: English]");
  assert.equal(withReplyLanguage(once, "English"), once);
  assert.equal(withReplyLanguage("hello there  \n", "Chinese"), "hello there  \n\n\n[Reply language: Chinese]");
  // Neutral: the line names a language and nothing else.
  assert.doesNotMatch(replyLanguageLine("English"), /claw|assistant|router/i);
});
