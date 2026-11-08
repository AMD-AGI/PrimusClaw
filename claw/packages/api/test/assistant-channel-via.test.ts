// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a message reached the chat it came from (`channel_context.via`, `parseChannelContext`).
 *
 * Measured 2026-11-08 (Clawy's daily failure mining): the review requests a person's coordinator posts into their 1:1 chat through
 * Clawy's on-behalf endpoint were stored like messages the person typed, and the day's "real user messages" (52) were all of them.
 *
 *   V1 `on_behalf` is kept; anything else (another word, another type, a padded or cased spelling) is dropped, and a channel that says
 *      nothing is read as typed (absent), as before
 *   V2 the rest of the context is read as without it
 */
import assert from "node:assert/strict";
import test from "node:test";

test("V1 only the closed set is kept", async () => {
  const { parseChannelContext } = await import("../src/assistant/inbound.js");
  assert.equal(parseChannelContext({ channel: "teams", via: "on_behalf" }).via, "on_behalf");
  assert.ok(!("via" in parseChannelContext({ channel: "teams" })), "not said: typed");
  for (const junk of ["typed", "admin", "ON_BEHALF", " on_behalf", 1, true, null, ["on_behalf"], { via: "on_behalf" }]) {
    assert.ok(!("via" in parseChannelContext({ channel: "teams", via: junk })), JSON.stringify(junk));
  }
});

test("V2 the rest of the context is read as without it", async () => {
  const { parseChannelContext } = await import("../src/assistant/inbound.js");
  const raw = { channel: "teams", channel_message_id: "m-1", people: [{ name: "Wei Lei", user_id: "u-w" }], handoffs: ["review_for_other"] };
  const { via, ...rest } = parseChannelContext({ ...raw, via: "on_behalf" });
  assert.equal(via, "on_behalf");
  assert.deepEqual(rest, parseChannelContext(raw));
});
