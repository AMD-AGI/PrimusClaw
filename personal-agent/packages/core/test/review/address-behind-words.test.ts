// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A pull request that is only an address behind other words (a link's text, a link preview) is the one reviewed; one that is only
 * in a quoted message is not the one asked about (`test_github_review`). The channel adapter gives the addresses as the message's
 * links and the quote apart from its words; the review reads the links with the words, never the quote's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALICE,
  CONV,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const PR_HREF = "https://github.com/AMD-AGI/Hyperloom/pull/12";

async function ask(world: ReviewWorld, text: string, more: Record<string, unknown>): Promise<void> {
  const message = { ...groupMessage(text), ...more };
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

for (const [name, text, title] of [
  ["words over the address", "请 {Bob} 帮我 review 合入 fix the plugin check", "fix the plugin check"],
  ["a link preview and no address in the words", "请 {Bob} 帮我 review 合入", "Fix the plugin check"],
] as const) {
  test(`a pull request that is only an address behind the words is reviewed (${name})`, async () => {
    const world = reviewWorld();
    await ask(world, text, { links: [{ url: PR_HREF, title }] });
    const [turn] = world.started;
    assert.equal(turn?.token, "tok-aad-a");
    assert.equal(turn.turn.actingAs, "u-bob");
    assert.ok(turn.prompt.includes("AMD-AGI/Hyperloom#12"));
    assert.deepEqual(turn.turn.reviewTarget, { owner: "AMD-AGI", repo: "Hyperloom", number: 12 });
    assert.ok(!saidIn(world.surface, CONV).includes("请附上"));
  });
}

test("a pull request that is only in the quote is not the one asked about", async () => {
  const world = reviewWorld();
  const quote = {
    messageId: "m-1",
    author: "Carol",
    text: `here: ${PR_HREF}`,
    fromBot: false,
    sentAt: "",
    deleted: false,
    source: "html" as const,
  };
  await ask(world, "请 {Bob} 帮我 review 合入", { quotes: [quote] });
  assert.equal(world.started.length, 0);
  assert.ok(saidIn(world.surface, CONV).includes("请附上要 review 合入的 PR"), saidIn(world.surface, CONV));
});
