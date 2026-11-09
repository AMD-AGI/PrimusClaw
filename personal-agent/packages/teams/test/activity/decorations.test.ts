// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The reply style's decorations: one root entity (AI label, citations), suggested replies, and the plain retry. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  plainDecorations,
  rootEntities,
  withAiLabel,
  withCitationEntities,
  withSuggestedReplies,
} from "../../src/activity/decorations.js";
import { streamActivity, streamFinal, streamInfo } from "../../src/activity/stream-activity.js";

const ROOT = "https://schema.org/Message";

test("merging keeps one root entity whatever the activity came with", () => {
  const original = {
    type: "message",
    text: "x",
    entities: [
      { type: "mention", text: "<at>A</at>" },
      { type: ROOT, "@type": "Message", additionalType: ["Other"] },
      { type: ROOT, usageInfo: { name: "Confidential" } },
    ],
  };
  const before = JSON.stringify(original);
  const labelled = withCitationEntities(withAiLabel(withAiLabel(original)), [{ "@type": "Claim", position: 1 }]);
  const roots = rootEntities(labelled);
  const [root] = roots;
  assert.ok(root && roots.length === 1);
  assert.deepEqual(root["additionalType"], ["Other", "AIGeneratedContent"]);
  assert.deepEqual(root["usageInfo"], { name: "Confidential" });
  assert.deepEqual(root["citation"], [{ "@type": "Claim", position: 1 }]);
  assert.deepEqual((labelled["entities"] as unknown[])[0], { type: "mention", text: "<at>A</at>" });
  assert.equal(JSON.stringify(original), before);
});

test("a root entity is made where there was none, and no citations leave the activity as it was", () => {
  const plain = { type: "message", text: "x" };
  assert.deepEqual(withAiLabel(plain)["entities"], [
    {
      type: ROOT,
      "@type": "Message",
      "@context": "https://schema.org",
      "@id": "",
      additionalType: ["AIGeneratedContent"],
    },
  ]);
  assert.equal(withCitationEntities(plain, []), plain);
  const many = withCitationEntities(
    plain,
    Array.from({ length: 25 }, (_, i) => ({ position: i + 1 })),
  );
  assert.equal((rootEntities(many)[0]?.["citation"] as unknown[]).length, 20);
});

test("suggested replies: at most three, never on a card, and none when none is complete", () => {
  const replies = [
    { title: "a", value: "A" },
    { title: "", value: "B" },
    { title: "c", value: "C" },
    { title: "d", value: "D" },
  ];
  assert.deepEqual(withSuggestedReplies({ type: "message", text: "x" }, replies)["suggestedActions"], {
    actions: [
      { type: "imBack", title: "a", value: "A" },
      { type: "imBack", title: "c", value: "C" },
    ],
  });
  const card = { type: "message", attachments: [{ contentType: "x" }] };
  assert.equal(withSuggestedReplies(card, replies), card);
  const plain = { type: "message" };
  assert.equal(withSuggestedReplies(plain, [{ title: "", value: "" }]), plain);
});

test("the plain retry drops the root entity and the replies, and keeps every other entity", () => {
  assert.equal(plainDecorations({ type: "message", entities: [{ type: "mention" }] }), undefined);
  assert.deepEqual(
    plainDecorations({
      type: "message",
      entities: [{ type: ROOT }, { type: "mention" }],
      suggestedActions: { actions: [] },
    }),
    { type: "message", entities: [{ type: "mention" }] },
  );
  assert.deepEqual(plainDecorations({ type: "message", text: "x", entities: [{ type: ROOT }] }), {
    type: "message",
    text: "x",
  });
  assert.deepEqual(plainDecorations({ type: "message", suggestedActions: [1] }), { type: "message" });
  assert.equal(plainDecorations({ type: "message", suggestedActions: {} }), undefined);
});

test("a stream's requests and its final carry the stream entity", () => {
  assert.deepEqual(streamActivity("informative", "a", "m", 1), {
    type: "typing",
    text: "a",
    replyToId: "m",
    entities: [{ type: "streaminfo", streamType: "informative", streamSequence: 1 }],
  });
  const final = streamFinal(
    { type: "message", text: "x", entities: [{ type: "streaminfo", streamId: "old" }, { type: ROOT }] },
    "m",
    "s-1",
  );
  assert.deepEqual(final, {
    type: "message",
    text: "x",
    entities: [{ type: "streaminfo", streamType: "final", streamId: "s-1" }, { type: ROOT }],
    replyToId: "m",
  });
  assert.deepEqual(streamInfo(final), { type: "streaminfo", streamType: "final", streamId: "s-1" });
  assert.equal(streamInfo({ type: "message" }), undefined);
});

test("a root entity's field named like an object's prototype is kept as a field", () => {
  // (Python's dict keeps "__proto__" as a key like any other; an assignment would have set the merged object's prototype)
  const root = JSON.parse(
    '{"type":"https://schema.org/Message","__proto__":{"polluted":true},"usageInfo":{"n":1}}',
  ) as Record<string, unknown>;
  const labelled = withAiLabel({ type: "message", entities: [root] } as never);
  const [merged] = rootEntities(labelled);
  assert.ok(merged);
  assert.ok(Object.hasOwn(merged, "__proto__"));
  assert.deepEqual(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal((merged as { polluted?: unknown }).polluted, undefined);
  assert.equal(JSON.stringify(merged).includes('"__proto__":{"polluted":true}'), true);
});
