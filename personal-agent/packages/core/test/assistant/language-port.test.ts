// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the assistant says of its own (the board, the suggested replies) is in the language of the conversation, not in that of
 * what it shows (teams/tests/test_conversation_language.py, where the assistant's code decides the language). The language a
 * message is learnt from is the router's (`learnLang`, W4), used here as the router uses it before it hands the message on; the
 * Teams client's language is only the fallback until the person writes something.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ALICE, CardsWorld } from "../../../../test-support/assistant/cards-world.js";
import { answerLang } from "../../src/language/detect.js";
import { learnLang } from "../../src/routing/chat.js";

const KEY = "ak-alice";

/** One 1:1 message from a Teams client in `locale`: the router learns its language and the client's locale is known. */
function said(w: CardsWorld, text: string, locale = "zh-CN"): void {
  learnLang(w.store, ALICE, text);
  w.locale = locale;
}

function lastBoard(w: CardsWorld) {
  const board = [...w.views()].reverse().find((v) => v.name === "board");
  assert.ok(board?.name === "board", "no board");
  return board.model;
}

/** The titles of the replies to tap under the one message a push sent. */
function suggested(w: CardsWorld): string[] {
  const sent = w.sent().filter((o) => o.message.body.type !== "view");
  assert.equal(sent.length, 1);
  return (sent[0]?.message.suggestions ?? []).map((s) => s.title);
}

it("the conversation decides and the client or the content only while nothing was written", () => {
  assert.equal(answerLang("en", "", "📋 你的事项"), "en");
  assert.equal(answerLang("zh", "", "Fix the flaky test"), "zh");
  assert.equal(answerLang("", "zh-CN", "Fix the flaky test"), "zh"); // a message of theirs is being handled: their client's language
  assert.equal(answerLang("", "", "#13 支持对比"), "zh"); // a notice on its own: what it shows
  assert.equal(answerLang("", "", "Fix it"), "en");
});

it("an english conversation gets an english board of chinese titles and a chinese one a chinese board", async () => {
  const w = CardsWorld.start();
  w.server.addItem(KEY, "vLLM vs SGLang MI300X 支持对比", { board: "done", outcome: "accepted" });
  w.server.addItem(KEY, "只回复这一个词", { board: "done", outcome: "accepted" });
  said(w, "show my tasks"); // (a sentence help teaches: the router runs /board for it, and it is English)
  assert.equal(w.store.prefs.getPrefs(ALICE).lang, "en");
  await w.showBoard();
  const board = lastBoard(w);
  assert.equal(board.lang, "en"); // ("📋 Your tasks", not "📋 你的事项")
  assert.ok(board.items.some((i) => i.title === "vLLM vs SGLang MI300X 支持对比")); // (the titles themselves stay as they are)
  said(w, "看看我的任务");
  await w.showBoard();
  assert.equal(lastBoard(w).lang, "zh");
});

it("an english answer that names a chinese title is followed by english replies", async () => {
  const w = CardsWorld.start();
  said(w, "research how vLLM and SGLang support AMD MI300X");
  w.locale = ""; // (a push is not a message of theirs)
  const answer = "✅ This was already done as #13 vLLM vs SGLang MI300X 支持对比 (finished today, 08:50).";
  assert.equal(await w.push(w.server.say(KEY, answer)), "delivered");
  assert.deepEqual(suggested(w), ["Tell me more", "My tasks"]);
});

it("a chinese conversation is unchanged", async () => {
  const w = CardsWorld.start();
  said(w, "帮我调研一下 vLLM 和 SGLang 对 MI300X 的支持", "en-US");
  w.locale = "";
  assert.equal(await w.push(w.server.say(KEY, "已开始 #1 vLLM vs SGLang MI300X support comparison。")), "delivered");
  assert.deepEqual(suggested(w), ["详细说说", "我的任务"]);
  w.server.addItem(KEY, "vLLM vs SGLang MI300X support comparison");
  said(w, "/board", "en-US");
  await w.showBoard();
  assert.equal(lastBoard(w).lang, "zh");
});
