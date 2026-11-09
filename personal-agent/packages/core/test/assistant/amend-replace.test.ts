// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A message of the assistant that adds to (`amends`) or takes the place of (`replaces`) an earlier one of the same turn is an edit of
 * that message; when this worker no longer has it, the words come as a message of their own (tests/test_assistant_amend.py,
 * tests/test_assistant_replace.py). Through the real `Proactive`, on a channel that gives each message its id at once.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import type { Recorded } from "../../../../test-support/surface.js";
import type { JsonObject } from "../../src/json.js";
import { ALICE, world } from "../proactive/world.js";

function say(eventId: string, text: string, extra: JsonObject = {}): JsonObject {
  return {
    type: "assistant.say",
    event_id: eventId,
    occurred_at: "2026-11-06T16:00:00Z",
    user_id: "u-a",
    text,
    ...extra,
  };
}

async function run(...events: JsonObject[]) {
  const w = world();
  const outcomes = [];
  for (const e of events) outcomes.push(await w.proactive.handle(ALICE, w.reference, e));
  const outbox = w.surface.outbox;
  const posts = outbox.filter((r): r is Extract<Recorded, { op: "post" }> => r.op === "post");
  const updates = outbox.filter((r): r is Extract<Recorded, { op: "update" }> => r.op === "update");
  return { outcomes, outbox, posts, updates };
}

function words(r: { message: { body: { type: string; text?: string; markdown?: string } } }): string {
  const body = r.message.body;
  return body.text ?? body.markdown ?? "";
}

it("a later say of the turn edits its first message", async () => {
  const { outcomes, posts, updates } = await run(
    say("say-1", "你开着 37 个 PR：PrimusClaw 19 个。"),
    say("say-2", "你开着 37 个 PR：PrimusClaw 21 个。", { replaces: "say-1" }),
  );
  assert.deepEqual(outcomes, ["delivered", "delivered"]);
  assert.equal(posts.length, 1, "one message for the question");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.id, posts[0]?.id);
  const [update] = updates;
  assert.ok(update);
  const text = words(update);
  assert.ok(
    text.includes("21 个") && !text.includes("19 个"),
    "the new words take the old ones' place, not beside them",
  );
});

it("a third say of the turn edits the same message", async () => {
  const { outcomes, posts, updates } = await run(
    say("say-1", "查一下。"),
    say("say-2", "38 个。", { replaces: "say-1" }),
    say("say-3", "38 个，和上次一样。", { replaces: "say-1" }),
  );
  assert.deepEqual(outcomes, ["delivered", "delivered", "delivered"]);
  assert.equal(posts.length, 1);
  assert.deepEqual(
    updates.map((u) => u.id),
    [posts[0]?.id, posts[0]?.id],
  );
  const last = updates.at(-1);
  assert.ok(last && words(last).includes("和上次一样"));
});

it("a replacement for a message this worker does not have comes as its own", async () => {
  const { outcomes, outbox, posts } = await run(say("say-2", "38 个。", { replaces: "say-gone" }));
  assert.deepEqual(outcomes, ["delivered"]);
  assert.deepEqual(
    outbox.map((r) => r.op),
    ["post"],
  );
  assert.ok(posts[0] && words(posts[0]).includes("38 个"));
});

it("words added to the start notice edit its message", async () => {
  const { outcomes, posts, updates } = await run(
    say("say-notice", "已开始：#84 K8s 调度器简介。有结果或需要你时我会告诉你。"),
    say("say-2", "顺便：SaFE 现在有 12 个节点在线。", { amends: "say-notice" }),
  );
  assert.deepEqual(outcomes, ["delivered", "delivered"]);
  assert.equal(posts.length, 1, "one message");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.id, posts[0]?.id, "the notice's own message, edited");
  const text = updates[0] ? words(updates[0]) : "";
  assert.ok(text.includes("已开始") && text.includes("12 个节点"));
  assert.ok(text.indexOf("已开始") < text.indexOf("12 个节点"));
});

it("an addition to a message this worker does not have comes as its own", async () => {
  const { outcomes, outbox, posts } = await run(
    say("say-2", "顺便：SaFE 现在有 12 个节点在线。", { amends: "say-gone" }),
  );
  assert.deepEqual(outcomes, ["delivered"]);
  assert.deepEqual(
    outbox.map((r) => r.op),
    ["post"],
  );
  assert.ok(posts[0] && words(posts[0]).includes("12 个节点"));
});
