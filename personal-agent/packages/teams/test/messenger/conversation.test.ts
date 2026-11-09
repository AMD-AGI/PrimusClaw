// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What a Teams conversation sends for core's messages, and how it edits, deletes and stores them. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { richMessage, textMessage, type OutMessage } from "@primusclaw/personal-agent";

import { flushMicrotasks } from "../../../../test-support/clock.js";
import { DEFAULT_STYLE } from "../../src/config/style.js";
import { teamsMasker } from "../../src/activity/redact-activity.js";
import type { Renderers } from "../../src/views/registry.js";
import { RecordingDirect, RecordingQueue } from "../helpers/outboxes.js";
import { build, ref } from "./fixtures.js";

const ROOT = "https://schema.org/Message";
const MASK = (text: string) => ({ text: text.replaceAll("sk-secret", "sk-***"), masked: text.includes("sk-secret") });

test("an answer carries the AI label, the people it names, Teams' thumbs, its replies and its sources", async () => {
  const queue = new RecordingQueue();
  const { conversation } = build(queue);
  const message: OutMessage = {
    body: { type: "text", text: "All green [1]." },
    aiGenerated: true,
    feedback: true,
    mentions: [
      { id: "a", channelUserId: "29:a", name: "Lin Mei", email: "" },
      { id: "b", channelUserId: "29:b", name: "Robin", email: "" },
    ],
    suggestions: [{ title: "Back to Clawy", value: "back to Clawy" }],
    citations: [
      {
        position: 1,
        title: "The PR",
        url: "https://github.com/o/r/pull/1",
        abstract: "GitHub pull request · github.com",
      },
    ],
  };
  await conversation.send(message);
  const activity = queue.sent[0]?.activity ?? {};
  assert.equal(activity["text"], "<at>Lin Mei</at> <at>Robin</at> All green [1].");
  assert.deepEqual(activity["channelData"], { feedbackLoop: { type: "default" } });
  assert.deepEqual(activity["suggestedActions"], {
    actions: [{ type: "imBack", title: "Back to Clawy", value: "back to Clawy" }],
  });
  const entities = activity["entities"] as Array<Record<string, unknown>>;
  assert.deepEqual(
    entities.map((e) => e["type"]),
    ["mention", "mention", ROOT],
  );
  assert.deepEqual(entities[2], {
    type: ROOT,
    "@type": "Message",
    "@context": "https://schema.org",
    "@id": "",
    additionalType: ["AIGeneratedContent"],
    citation: [
      {
        "@type": "Claim",
        position: 1,
        appearance: {
          "@type": "DigitalDocument",
          name: "The PR",
          url: "https://github.com/o/r/pull/1",
          abstract: "GitHub pull request · github.com",
        },
      },
    ],
  });
});

test("the AI label is left off when the reply style has it off, and a plain message carries none", async () => {
  const queue = new RecordingQueue();
  const off = build(queue, { style: { ...DEFAULT_STYLE, aiLabel: false } });
  await off.conversation.send({ body: { type: "text", text: "x" }, aiGenerated: true });
  await build(queue).conversation.send(textMessage("y"));
  assert.deepEqual(
    queue.sent.map((e) => e.activity),
    [
      { type: "message", text: "x", textFormat: "markdown" },
      { type: "message", text: "y", textFormat: "markdown" },
    ],
  );
});

test("a view is sent as its renderer draws it", async () => {
  const queue = new RecordingQueue();
  const renderers = { demo: (model: { n: number }) => ({ type: "message", text: String(model.n) }) };
  const { conversation } = build(queue, { renderers: renderers as unknown as Renderers });
  const view = { name: "demo", model: { n: 3 } } as unknown as Extract<OutMessage["body"], { type: "view" }>["view"];
  await conversation.send({ body: { type: "view", view, fallbackText: "3" } });
  assert.deepEqual(queue.sent[0]?.activity, { type: "message", text: "3" });
});

test("an edit names the message, is remembered, and a cancelled one sends nothing", async () => {
  const queue = new RecordingQueue();
  const { conversation } = build(queue);
  await conversation.update("m-1", textMessage("x"));
  assert.deepEqual(queue.sent[0], {
    operation: "update",
    reference: ref().wire,
    activity: { type: "message", text: "x", textFormat: "markdown" },
    activity_id: "m-1",
  });
  assert.ok(conversation.edited.has("m-1"));
  conversation.markSettled("m-0");
  assert.ok(conversation.edited.has("m-0"));
  const cancelled = new AbortController();
  cancelled.abort(new Error("the turn was cancelled"));
  await assert.rejects(conversation.update("m-2", textMessage("y"), { signal: cancelled.signal }), /cancelled/);
  assert.equal(queue.sent.length, 1);
});

test("the queue cannot delete; a direct send can", async () => {
  const queued = build(new RecordingQueue()).conversation;
  assert.deepEqual(await queued.delete("m-1"), {
    ok: false,
    error: { kind: "delete_unsupported", reason: "the outbound queue cannot delete a message" },
  });
  const direct = new RecordingDirect();
  assert.deepEqual(await build(direct).conversation.delete("m-1"), { ok: true, value: undefined });
  assert.deepEqual(direct.sent[0], {
    operation: "delete",
    reference: ref().wire,
    activity: { type: "message" },
    activity_id: "m-1",
  });
});

test("a direct send's id comes back at once, and a stored envelope is delivered as it was built", async () => {
  const direct = new RecordingDirect();
  const { conversation } = build(direct);
  assert.equal(await conversation.post(textMessage("x")), "teams-1");
  const stored = JSON.parse(JSON.stringify(conversation.outgoing(textMessage("card")))) as Parameters<
    typeof conversation.deliver
  >[0];
  await conversation.deliver(stored);
  assert.deepEqual(direct.sent[1], { operation: "send", reference: ref().wire, activity: textMessage2("card") });
  await assert.rejects(conversation.deliver({ operation: "nope" }), TypeError);
});

function textMessage2(text: string): Record<string, unknown> {
  return { type: "message", text, textFormat: "markdown" };
}

test("in a group chat what is posted is masked, and an answer's markdown before it becomes HTML", async () => {
  const queue = new RecordingQueue();
  const masker = teamsMasker(MASK, "(a credential was masked)");
  const { conversation } = build(queue, { ref: ref("g", "groupChat"), masker });
  await conversation.send(textMessage("key sk-secret"));
  await conversation.send(richMessage("**Key**: sk-secret", { lead: false }));
  assert.equal(queue.sent[0]?.activity["text"], "key sk-***\n\n(a credential was masked)");
  const rich = queue.sent[1]?.activity["text"];
  assert.ok(typeof rich === "string");
  assert.ok(rich.includes("sk-***") && !rich.includes("sk-secret") && rich.includes("(a credential was masked)"));
});

test("messenger masks every post kind in a group only", async () => {
  const secret = "sk-secret-value";
  const masker = teamsMasker(MASK, "(a credential was masked)");
  async function sent(kind: "groupChat" | "personal"): Promise<string> {
    const queue = new RecordingQueue();
    const { conversation, clock } = build(queue, {
      ref: ref("c", kind),
      masker: kind === "groupChat" ? masker : undefined,
      ackTimeoutMs: 10,
    } as Parameters<typeof build>[1]);
    await conversation.send(textMessage(`a ${secret}`));
    const posted = conversation.post(textMessage(`b ${secret}`));
    await flushMicrotasks();
    await clock.advance(10);
    await posted;
    await conversation.update("id1", textMessage(`c ${secret}`));
    await conversation.typing();
    assert.equal(queue.sent.length, 4);
    return JSON.stringify(queue.sent);
  }
  assert.ok(!(await sent("groupChat")).includes("sk-secret"));
  assert.ok((await sent("personal")).includes(secret)); // 1:1 and proactive posts are unchanged
});

test("a group chat shows the plan through the same redaction as everything else", async () => {
  const secret = "ghp_" + "A1b2C3d4".repeat(4) + "wxyz";
  const ghp = (text: string) => ({
    text: text.replace(/ghp_[A-Za-z0-9]{36}/g, "ghp_***"),
    masked: /ghp_[A-Za-z0-9]{36}/.test(text),
  });
  const queue = new RecordingQueue();
  const { conversation } = build(queue, { ref: ref("g", "groupChat"), masker: teamsMasker(ghp, "(masked)") });
  const plan = `**Plan: 0 of 2 done**\n- Push with ${secret}\n- Open the PR`;
  await conversation.send(richMessage(plan, { lead: true }));
  await conversation.update("m-1", richMessage(plan, { lead: true }));
  const everything = JSON.stringify(queue.sent);
  assert.ok(everything.includes("Plan: 0 of 2 done") && everything.includes("Open the PR"));
  assert.ok(!everything.includes(secret));
});
