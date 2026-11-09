// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Real ways people ask about the confirmation setting in their own chat, the reading a good model gives, and what follows
 * (`test_github_review_mode.PHRASES`): the card with that setting first, the status, or the message going on as chat. Nothing
 * changes without a click, and each message is read with the person's own key.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IntentReader } from "../../src/index.js";
import { ALICE, reviewWorld, saidIn } from "../../../../test-support/review-world.js";

const DM = `personal:${ALICE.id}`;

type Outcome = readonly ["card", string] | readonly ["status"] | readonly ["chat"];

const set = (mode: string) => ({ intent: "set_review_mode", mode });
const show = { intent: "show_review_mode", mode: "" };
const none = { intent: "none", mode: "" };

const PHRASES: readonly (readonly [string, Record<string, string>, Outcome])[] = [
  ["改成全自动合入", set("fully_auto"), ["card", "fully_auto"]],
  ["代审直接合，不用问我", set("fully_auto"), ["card", "fully_auto"]],
  ["我审的 PR 全自动合入", set("fully_auto"), ["card", "fully_auto"]],
  ["高风险的还是问我", set("high_risk_confirm"), ["card", "high_risk_confirm"]],
  ["合入前高风险的都先人工确认一下", set("high_risk_confirm"), ["card", "high_risk_confirm"]],
  ["make my merges fully automatic", set("fully_auto"), ["card", "fully_auto"]],
  ["please ask me again for high risk ones", set("high_risk_confirm"), ["card", "high_risk_confirm"]],
  ["我的代审设置是什么", show, ["status"]],
  ["现在是哪一档？", show, ["status"]],
  ["what is my review mode?", show, ["status"]],
  ["全自动驾驶是什么原理", none, ["chat"]],
  ["帮我写一个 ask me anything 页面", none, ["chat"]],
  ["别再让同事代审了", none, ["chat"]],
];

for (const [text, reading, outcome] of PHRASES) {
  test(`in their own chat a person asks in their own words: ${text}`, async () => {
    const asked: [string, string][] = [];
    const intent: IntentReader = {
      read: () => Promise.resolve(undefined),
      readMode: (key, said) => {
        asked.push([key, said]);
        return Promise.resolve(reading);
      },
      readAnswer: () => Promise.resolve(undefined),
    };
    const w = reviewWorld(["AMD-AGI"], { intent });
    w.identity.know("aad-a", "u-alice", "alice-gh");
    const conversation = w.surface.conversation({
      id: DM,
      kind: "personal",
      tenantId: "t",
      wire: { conversation: { id: DM } },
    });
    const handled = await w.service.modeMessage(ALICE, text, conversation);
    const cards = w.surface
      .of(DM)
      .flatMap((r) =>
        "message" in r && r.message.body.type === "view" && r.message.body.view.name === "reviewMode"
          ? [r.message.body.view.model as { suggested: string }]
          : [],
      );
    assert.deepEqual(
      w.claw.calls.filter((c) => c[0] === "setReviewMode"),
      [],
    ); // (nothing changes without a click)
    if (outcome[0] === "card") {
      assert.equal(handled, true);
      assert.deepEqual(
        cards.map((c) => c.suggested),
        [outcome[1]],
      );
    } else if (outcome[0] === "status") {
      assert.equal(handled, true);
      assert.deepEqual(cards, []);
      assert.ok(saidIn(w.surface, DM).includes("Confirmation (for every review and merge with your account)"));
    } else {
      assert.equal(handled, false); // (the message goes on to the chat, as any message)
      assert.deepEqual(cards, []);
    }
    assert.deepEqual(asked, [["ak-alice-linked", text]]); // read with the person's own key
  });
}
