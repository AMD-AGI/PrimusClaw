// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Suggested replies under what the assistant says (tests/test_assistant_suggested.py): Claw's own when it sends any, else the
 * defaults in the reply's language; never under a card, a needs-you notice, or with the switch off. Under the reply with the AI
 * label and the thumbs: alone, and as the receipt's final.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { finals, liveWorld } from "../../../../test-support/assistant/live-world.js";
import { flushMicrotasks } from "../../../../test-support/clock.js";
import { openTestStore } from "../../../../test-support/store.js";
import { ASSISTANT_SUGGESTED_REPLIES } from "../../src/assistant/events.js";
import { SAY_TOOL } from "../../src/assistant/follow.js";
import { SayPlanner } from "../../src/assistant/say.js";
import type { JsonObject } from "../../src/json.js";
import type { OutMessage } from "../../src/ports/surface.js";

const ALICE = "aad-a";

function say(event: JsonObject, suggestedReplies = true): OutMessage[] {
  const { store } = openTestStore();
  const planner = new SayPlanner({
    store,
    exactCommand: () => false,
    style: () => ({ citations: true, suggestedReplies }),
  });
  return planner.messages(ALICE, event);
}

const buttons = (m: OutMessage | undefined) => (m?.suggestions ?? []).map((s) => [s.title, s.value]);

it("claws own replies are the buttons under the reply with its ai label and thumbs", () => {
  const [said, ...more] = say({
    type: "assistant.say",
    text: "你有 21 个开着的 PR。",
    suggested_replies: ["按仓库分组", "哪些 CI 红了"],
  });
  assert.deepEqual(more, []);
  assert.deepEqual(buttons(said), [
    ["按仓库分组", "按仓库分组"],
    ["哪些 CI 红了", "哪些 CI 红了"],
  ]);
  assert.deepEqual([said?.aiGenerated, said?.feedback], [true, true]);
});

for (const [text, lang] of [
  ["你有 21 个开着的 PR。", "zh"],
  ["You have 21 open pull requests.", "en"],
] as const) {
  it(`without claws own the defaults in the replys language (${lang})`, () => {
    const [said] = say({ type: "assistant.say", text });
    assert.deepEqual(
      buttons(said),
      ASSISTANT_SUGGESTED_REPLIES[lang].map(([t, v]) => [t, v]),
    );
    assert.ok(buttons(said).every(([, v]) => v !== "/new"));
  });
}

it("none with the switch off under a card or a needs you notice", () => {
  const item = {
    item_id: "kwi_1",
    seq: 1,
    title: "Fix",
    board_state: "needs_you",
    result_version: 1,
    can_accept: true,
  };
  const off = say({ type: "assistant.say", text: "好的。", suggested_replies: ["继续"] }, false);
  const card = say({ type: "assistant.say", text: "结果好了。", item, suggested_replies: ["继续"] });
  const notice = say({ type: "work_item.needs_you", text: "#1 Fix 在等你。" });
  for (const out of [off, card, notice]) for (const m of out) assert.deepEqual(buttons(m), []);
  assert.ok(card.some((m) => m.body.type === "view"));
});

it("a reply said as several messages has the buttons on its last only", () => {
  const first = `第一段。${"甲".repeat(2990)}`;
  const second = `第二段。${"乙".repeat(2000)}`;
  const said = say({ type: "assistant.say", text: `${first}\n\n${second}`, suggested_replies: ["继续"] });
  assert.equal(said.length, 2);
  assert.deepEqual(buttons(said[0]), []);
  assert.deepEqual(buttons(said[1]), [["继续", "继续"]]);
});

for (const [name, words] of [
  ["words streamed", ["你有 21 个", "你有 21 个开着的"]],
  ["no words streamed", []],
] as const) {
  it(`the receipts final carries the buttons the ai label and the thumbs (${name})`, async () => {
    const l = await liveWorld();
    await l.w.say("我有几个开着的 PR？");
    for (const text of words) await l.live("toolTextDelta", { tool: SAY_TOOL, actionId: "t3", text });
    await l.live("toolUsed", { tool: SAY_TOOL, actionId: "t3", status: "start" });
    await l.push({
      type: "assistant.say",
      event_id: "e-1",
      text: "你有 21 个开着的 PR。",
      suggested_replies: ["按仓库分组"],
    });
    await flushMicrotasks();
    const [final, ...more] = finals(l.w.surface.outbox);
    assert.deepEqual(more, []);
    const body = final?.body;
    const text = body?.type === "text" ? body.text : body?.type === "rich" ? body.markdown : "";
    assert.ok(text.includes("你有 21 个开着的 PR。"));
    assert.deepEqual(buttons(final), [["按仓库分组", "按仓库分组"]]);
    assert.deepEqual([final?.aiGenerated, final?.feedback], [true, true]);
  });
}
