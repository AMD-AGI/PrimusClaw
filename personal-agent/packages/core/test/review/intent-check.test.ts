// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkIntent, pullsWritten } from "../../src/review/intent-check.js";
import { pullKey, pullRef, pullsIn, shortName } from "../../src/review-text/pull-ref.js";

const H1 = "AMD-AGI/Hyperloom#1";
const TEXT = `请 Bob 帮我 review 合入 ${H1}`;
const reading = (changes: Record<string, unknown> = {}) => ({
  intent: "review_merge",
  reviewer: "Bob",
  prs: [H1],
  model: "",
  ...changes,
});

function verdictOf(answer: Record<string, unknown>, text = TEXT) {
  return checkIntent(answer, text, [], pullsIn(text));
}

test("the model's reading is held to what the message says", () => {
  const cases: readonly [string, Record<string, unknown>, number[], string | null, string][] = [
    ["made-up-pr-dropped", reading({ prs: [H1, "AMD-AGI/Hyperloom#99"] }), [1], null, "ask"],
    ["only-made-up-prs", reading({ prs: ["AMD-AGI/Hyperloom#99"] }), [], "没认出要 review 合入哪个 PR", "question"],
    ["no-prs", reading({ prs: [] }), [], "没认出要 review 合入哪个 PR", "question"],
    ["reviewer-not-in-message", reading({ reviewer: "Mallory" }), [], "没在你的消息里找到「Mallory」", "question"],
    ["id-not-a-mention", reading({ reviewer: "29:x" }), [], "没在你的消息里找到", "question"],
    ["no-reviewer", reading({ reviewer: "" }), [], "请指定由谁来 review 合入", "question"],
    ["model-not-in-message", reading({ model: "claude-opus-5.5" }), [], "不确定你要用哪个模型", "question"],
    ["review-only-as-bob", reading({ intent: "review" }), [1], null, "ask"],
    ["review-only-nobody-is-chat", reading({ intent: "review", reviewer: "", reviewers: [] }), [], null, "chat"],
    ["none-is-chat", reading({ intent: "none" }), [], null, "chat"],
  ];
  for (const [id, answer, started, says, kind] of cases) {
    const verdict = verdictOf(answer);
    assert.equal(verdict.kind, kind, id);
    if (verdict.kind === "ask") {
      assert.deepEqual(
        verdict.ask.pulls.map((p) => p.number),
        started,
        id,
      );
      assert.equal(verdict.ask.who, "Bob", id);
    }
    if (says !== null) assert.ok(verdict.kind === "question" && verdict.text.includes(says), id);
  }
});

test("a reading that is no reading is left to the rules", () => {
  assert.deepEqual(verdictOf({ intent: "maybe" }), { kind: "unreadable", why: "unknown intent" });
  assert.deepEqual(verdictOf(reading({ reviewer: 3 })), { kind: "unreadable", why: "field types" });
  assert.deepEqual(verdictOf(reading({ prs: "x" })), { kind: "unreadable", why: "field types" });
  assert.deepEqual(verdictOf(reading({ reviewers: "Bob" })), { kind: "unreadable", why: "field types" });
});

test("a request that asks two people starts nothing, even when the model names one", () => {
  const verdict = verdictOf(reading({ reviewers: ["Bob", "Carol"] }));
  assert.ok(verdict.kind === "question" && verdict.text.includes("只能请同一位 reviewer（这次有 Bob、Carol）"));
});

test("the same person named several ways is one reviewer", () => {
  const mentions = [{ channelUserId: "29:w", userId: "", name: "Lin, Mei" }];
  const text = `请 ⟦0⟧ review 合入 ${H1}`;
  const verdict = checkIntent(
    reading({ reviewer: "29:w", reviewers: ["29:w", "Lin, Mei", "lin mei"] }),
    text,
    mentions,
    pullsIn(H1),
  );
  assert.ok(verdict.kind === "ask" && verdict.ask.who === "⟦0⟧");
});

test("a model reading that names a mentioned person by name is that mention", () => {
  const mentions = [{ channelUserId: "29:w", userId: "", name: "Lin, Mei" }];
  const verdict = checkIntent(reading({ reviewer: "Lin, Mei" }), `请 ⟦0⟧ review 合入 ${H1}`, mentions, pullsIn(H1));
  assert.ok(verdict.kind === "ask" && verdict.ask.who === "⟦0⟧");
});

test("in a 1:1 chat naming nobody is the asker, unless someone was named", () => {
  const own = checkIntent(reading({ reviewer: "", reviewers: [] }), TEXT, [], pullsIn(TEXT), true);
  assert.ok(own.kind === "ask" && own.ask.who === "");
  const unsure = checkIntent(reading({ reviewer: "", reviewers: ["Bob"] }), TEXT, [], pullsIn(TEXT), true);
  assert.ok(unsure.kind === "question" && unsure.text.startsWith("我不确定你请的是谁"));
});

test("a model the message writes is taken", () => {
  const text = `请 Bob 用 gpt-6-luna 帮我 review 合入 ${H1}`;
  const verdict = verdictOf(reading({ model: "gpt-6-luna" }), text);
  assert.ok(verdict.kind === "ask");
  assert.deepEqual(verdict.ask.models, ["gpt-6-luna"]);
  assert.equal(verdictOf(reading({ model: "bad model" }), `${text} bad model`).kind, "question");
});

test("an entry of the reading's prs is matched to the message's pull requests", () => {
  const pulls = [
    pullRef("AMD-AGI", "PrimusClaw", 245),
    pullRef("AMD-AGI", "Other", 245),
    pullRef("AMD-AGI", "PrimusClaw", 246),
  ];
  const keys = new Set(pulls.map(pullKey));
  const shorts = (item: string) => pulls.filter((p) => pullsWritten(item, keys).has(pullKey(p))).map(shortName);
  assert.deepEqual(shorts("246"), ["AMD-AGI/PrimusClaw#246"]);
  assert.deepEqual(shorts("#245"), []); // (two have that number)
  assert.deepEqual(shorts("PrimusClaw#245"), ["AMD-AGI/PrimusClaw#245"]);
  assert.deepEqual(shorts("PrimusClaw PR 245 246"), ["AMD-AGI/PrimusClaw#245", "AMD-AGI/PrimusClaw#246"]);
  assert.deepEqual(shorts("amd-agi/other#245"), ["AMD-AGI/Other#245"]);
  assert.deepEqual(shorts("AMD-AGI/Nope#1"), []);
});
