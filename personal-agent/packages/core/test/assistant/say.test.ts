// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { openTestStore } from "../../../../test-support/store.js";
import { SayPlanner, type SayDeps } from "../../src/assistant/say.js";
import type { OutMessage } from "../../src/ports/surface.js";

const ALICE = "aad-a";
const ITEM = {
  item_id: "it-1",
  seq: 2,
  title: "Fix the flaky test",
  board_state: "needs_you",
  result_version: 3,
  can_accept: true,
  kind: "task",
};

function planner(style = { citations: true, suggestedReplies: true }) {
  const { store } = openTestStore();
  const deps: SayDeps = { store, exactCommand: (t) => /^\/(board|agent)\b/.test(t), style: () => style };
  return { store, say: new SayPlanner(deps) };
}

function shape(messages: readonly OutMessage[]): string[] {
  return messages.map((m) =>
    m.body.type === "view"
      ? `view:${m.body.view.name}`
      : `${m.body.type}:${m.body.type === "rich" ? m.body.markdown : m.body.text}`,
  );
}

it("what the assistant said is an ai answer with thumbs and the default replies under it", () => {
  const { say } = planner();
  const [only] = say.messages(ALICE, { type: "assistant.say", text: "节点：12 个就绪。" });
  assert.ok(only);
  assert.equal(only.aiGenerated, true);
  assert.equal(only.feedback, true);
  assert.deepEqual(only.body, { type: "rich", markdown: "节点：12 个就绪。", lead: false });
  assert.deepEqual(only.suggestions, [
    { title: "详细说说", value: "详细说说" },
    { title: "我的任务", value: "/board" },
  ]);
});

it("a say with no text and no files says nothing", () => {
  const { say } = planner();
  assert.deepEqual(say.messages(ALICE, { type: "assistant.say", text: "  " }), []);
});

it("a needs you notice without words still says that the task needs you", () => {
  const { say } = planner();
  const out = say.messages(ALICE, { type: "work_item.needs_you", item: { ...ITEM, can_accept: false } });
  assert.deepEqual(shape(out), ["rich:#2 Fix the flaky test needs you."]);
  assert.equal(out[0]?.suggestions, undefined);
});

it("a result that waits is a card that holds short words and is recorded first", () => {
  const { say, store } = planner();
  const out = say.messages(ALICE, { type: "work_item.needs_you", text: "Done: see the result.", item: ITEM });
  assert.deepEqual(shape(out), ["view:workCard"]);
  const card = out[0]?.body;
  assert.ok(card?.type === "view" && card.view.name === "workCard");
  const model = card.view.model;
  assert.equal(model.text, "Done: see the result.");
  const recorded = store.assistantCards.getAssistantCard(model.cardId);
  assert.deepEqual([recorded?.itemId, recorded?.version, recorded?.canAccept], ["it-1", 3, true]);
  assert.equal(model.watch, false);
});

it("long words go as messages and the card follows with its buttons and the watch offer for a pull request", () => {
  const { say } = planner();
  const long = `${"word ".repeat(150)}https://github.com/AMD-AGI/PrimusClaw/pull/12`;
  const out = say.messages(ALICE, { type: "assistant.say", text: long, item: ITEM });
  assert.deepEqual(
    shape(out).map((s) => s.split(":")[0]),
    ["rich", "view"],
  );
  const card = out[1]?.body;
  assert.ok(card?.type === "view" && card.view.name === "workCard");
  assert.equal(card.view.model.text, "");
  assert.equal(card.view.model.watch, true);
});

it("a held write is a card that lets it through or not", () => {
  const { say, store } = planner();
  const out = say.messages(ALICE, {
    type: "assistant.say",
    text: "要创建定时任务「PR 早报」吗？",
    confirm_write: { confirmation_id: "cf-1", kind: "trigger_create", allow_label: "创建" },
  });
  const card = out[0]?.body;
  assert.ok(card?.type === "view" && card.view.name === "confirmWrite");
  assert.deepEqual(
    [card.view.model.text, card.view.model.allowLabel, card.view.model.lang],
    ["要创建定时任务「PR 早报」吗？", "创建", "zh"],
  );
  assert.equal(store.assistantButtons.getConfirmCard(card.view.model.cardId)?.confirmationId, "cf-1");
});

it("a command put to the person is a run card and one that is no command is plain words", () => {
  const { say, store } = planner();
  const out = say.messages(ALICE, {
    type: "assistant.say",
    text: "Shall I show your board?",
    confirm_action: { name: "board", args: "", channel_message_id: "m-1" },
  });
  const card = out[0]?.body;
  assert.ok(card?.type === "view" && card.view.name === "actionCard");
  assert.equal(card.view.model.command, "/board");
  assert.equal(store.assistantButtons.getActionCard(card.view.model.cardId)?.channelMessageId, "m-1");
  const plain = say.messages(ALICE, {
    type: "assistant.say",
    text: "Unlink?",
    confirm_action: { name: "unlink", channel_message_id: "m-1" },
  });
  assert.deepEqual(shape(plain), ["rich:Unlink?"]);
});

it("the head and the workers own replies come first and claws are not repeated", () => {
  const { say } = planner();
  const [only] = say.messages(
    ALICE,
    { type: "assistant.say", text: "ok", suggested_replies: ["Back to Clawy", "Next"] },
    { head: "💬 **Clawy**", replies: [["Back to Clawy", "back to Clawy"]] },
  );
  assert.equal(only?.body.type === "rich" ? only.body.markdown : "", "💬 **Clawy**\n\nok");
  assert.deepEqual(only?.suggestions, [
    { title: "Back to Clawy", value: "back to Clawy" },
    { title: "Back to Clawy", value: "Back to Clawy" },
    { title: "Next", value: "Next" },
  ]);
  const four = say.messages(
    ALICE,
    { type: "assistant.say", text: "ok", suggested_replies: ["a", "b", "c"] },
    { replies: [["x", "x"]] },
  );
  assert.equal(four[0]?.suggestions?.length, 3);
});

it("only sources the words cite become citations", () => {
  const { say } = planner();
  const sources = [
    { n: 1, url: "https://example.com/a", title: "A page", kind: "web" },
    { n: 2, url: "https://example.com/b", title: "B page", kind: "web" },
  ];
  const [only] = say.messages(ALICE, { type: "assistant.say", text: "It is so [1].", sources });
  assert.deepEqual(
    only?.citations?.map((c) => [c.position, c.url]),
    [[1, "https://example.com/a"]],
  );
  const off = planner({ citations: false, suggestedReplies: false }).say.messages(ALICE, {
    type: "assistant.say",
    text: "It is so [1].",
    sources,
  });
  assert.equal(off[0]?.citations, undefined);
  assert.equal(off[0]?.suggestions?.length ?? 0, 0);
});

it("files with no link to give and no words are named", () => {
  const { say } = planner();
  const file = {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    name: "report.pdf",
    size: 10,
    media_type: "application/pdf",
    session_id: "s1",
  };
  const out = say.messages(ALICE, { type: "assistant.say", files: [file] });
  assert.equal(shape(out).length <= 1, true);
  const linked = say.messages(
    ALICE,
    { type: "assistant.say", text: "here", files: [file] },
    { linkFor: () => "https://claw.example.com/d/1" },
  );
  assert.ok(shape(linked).length >= 1);
});
