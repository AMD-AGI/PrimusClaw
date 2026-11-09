// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A 1:1 message about the confirmation setting, read by the model (`github_review.py`'s `mode_message`): a reading that it is
 * not about the setting lets the message go on; one that asks to see it shows the status; one that names a setting offers the
 * card with it first; a message without the setting's words, or too long, is never read.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IntentReader } from "../../src/index.js";
import type { ReviewModeView } from "../../src/review/views.js";
import { ALICE, reviewWorld, saidIn, type ReviewWorld } from "../../../../test-support/review-world.js";

const DM = `personal:${ALICE.id}`;

function world(answer: Record<string, unknown> | undefined, asked: string[] = []): ReviewWorld {
  const intent: IntentReader = {
    read: () => Promise.resolve(undefined),
    readMode: (_key, text) => {
      asked.push(text);
      return Promise.resolve(answer);
    },
    readAnswer: () => Promise.resolve(undefined),
  };
  const w = reviewWorld(["AMD-AGI"], { intent });
  w.identity.know("aad-a", "u-alice", "alice-gh");
  return w;
}

async function says(w: ReviewWorld, text: string): Promise<boolean> {
  const conversation = w.surface.conversation({
    id: DM,
    kind: "personal",
    tenantId: "t",
    wire: { conversation: { id: DM } },
  });
  return w.service.modeMessage(ALICE, text, conversation);
}

const modeCards = (w: ReviewWorld) =>
  w.surface
    .of(DM)
    .flatMap((r) =>
      "message" in r && r.message.body.type === "view" && r.message.body.view.name === "reviewMode"
        ? [r.message.body.view.model]
        : [],
    );

test("a reading that it is not about the setting lets the message go on", async () => {
  const w = world({ intent: "other" });
  assert.equal(await says(w, "合入前高风险的都先人工确认一下吗，还是全自动好"), false);
  assert.deepEqual(modeCards(w), []);
});

test("a reading that asks to see the setting shows the status", async () => {
  const w = world({ intent: "show_review_mode" });
  assert.equal(await says(w, "我现在代审是哪一档"), true);
  assert.ok(
    saidIn(w.surface, DM).includes("Confirmation (for every review and merge with your account):"),
    saidIn(w.surface, DM),
  );
});

test("a reading that names a setting offers the card with it first", async () => {
  const w = world({ intent: "set_review_mode", mode: "fully_auto" });
  assert.equal(await says(w, "帮我把合入确认改成全自动"), true);
  assert.deepEqual(
    modeCards(w).map((c) => c.suggested),
    ["fully_auto"],
  );
  assert.deepEqual(
    w.claw.calls.filter((c) => c[0] === "setReviewMode"),
    [],
  ); // (nothing changes until it is pressed)
});

test("a message without the settings words or too long is never read", async () => {
  const asked: string[] = [];
  const w = world({ intent: "set_review_mode", mode: "fully_auto" }, asked);
  assert.equal(await says(w, "今天天气怎么样"), false);
  assert.equal(await says(w, `全自动${"啊".repeat(300)}`), false);
  assert.deepEqual(asked, []);
});
