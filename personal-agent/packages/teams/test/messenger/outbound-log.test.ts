// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's only trace of what it handed to Teams is its log, so a finished turn must show up there: every outbound
 * operation (with the conversation it went to and whether it was a card, a message or typing, never its text), and
 * whether the status message's delivery ack came or did not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { textMessage, type OutMessage } from "@primusclaw/personal-agent";

import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { ADAPTIVE_CARD } from "../../src/cards/kit.js";
import { AckRegistry } from "../../src/messenger/acks.js";
import type { Renderers } from "../../src/views/registry.js";
import { RecordingDirect, RecordingQueue } from "../helpers/outboxes.js";
import { build, ref } from "./fixtures.js";

const SECRET_TEXT = "the user's private question and the agent's answer";

test("every outbound operation is logged without its text", async () => {
  const clock = new FakeClock();
  const acks = new AckRegistry(clock);
  const queue = new RecordingQueue(acks);
  const { conversation, logger } = build(queue, { ackTimeoutMs: 200, clock, acks });
  queue.ackWith = "teams-42";
  await conversation.typing();
  const id = await conversation.post(textMessage("Working on it..."));
  assert.equal(id, "teams-42");
  await conversation.update(id, textMessage(SECRET_TEXT));
  await conversation.send(textMessage("more"));
  const outbound = logger.lines.filter((l) => l.message === "outbound");
  assert.ok(outbound.some((l) => l.fields["operation"] === "send" && l.fields["type"] === "typing"));
  assert.ok(
    outbound.some((l) => l.fields["operation"] === "send" && l.fields["type"] === "message" && l.fields["ack"]),
  );
  const updates = outbound.filter((l) => l.fields["operation"] === "update");
  const [update] = updates;
  assert.ok(update && updates.length === 1);
  assert.equal(update.fields["chars"], Array.from(SECRET_TEXT).length);
  assert.equal(update.fields["activityId"], "teams-42");
  assert.ok(logger.lines.some((l) => l.message === "outbound ack received" && l.fields["activityId"] === "teams-42"));
  assert.ok(!logger.dump().includes(SECRET_TEXT) && !logger.dump().includes("Working on it")); // lengths and ids only
});

test("a status message whose ack never comes is reported", async () => {
  const queue = new RecordingQueue();
  const { conversation, clock, logger } = build(queue, { ackTimeoutMs: 50 });
  const posted = conversation.post(textMessage("Working on it..."));
  await flushMicrotasks();
  await clock.advance(50);
  assert.equal(await posted, undefined);
  const warnings = logger.lines.filter((l) => l.level === "warn");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? "", /ack not received in time/);
});

const CARD_TEXT = "a card line only the person should read";

/** A stand-in renderer: the view as an Adaptive Card carrying `CARD_TEXT`. */
const CARD_RENDERERS = {
  demo: () => ({
    type: "message",
    attachments: [
      {
        contentType: ADAPTIVE_CARD,
        content: { type: "AdaptiveCard", version: "1.5", body: [{ type: "TextBlock", text: CARD_TEXT }] },
      },
    ],
  }),
} as unknown as Renderers;

const CARD_MESSAGE = {
  body: { type: "view", view: { name: "demo", model: {} }, fallbackText: "demo" },
} as unknown as OutMessage;

test("every outbound line names the target conversation and whether it is a card, a message or typing", async () => {
  const queue = new RecordingQueue();
  const target = ref("a:1target-conversation");
  const { conversation, logger } = build(queue, { ref: target, renderers: CARD_RENDERERS });
  await conversation.typing();
  await conversation.send(CARD_MESSAGE);
  await conversation.send(textMessage(SECRET_TEXT));
  await conversation.update("teams-7", CARD_MESSAGE);
  const outbound = logger.lines.filter((l) => l.message === "outbound");
  assert.deepEqual(
    outbound.map((l) => [l.fields["operation"], l.fields["type"], l.fields["content"], l.fields["conversation"]]),
    [
      ["send", "typing", "typing", "a:1target-conversation"],
      ["send", "message", "card", "a:1target-conversation"],
      ["send", "message", "message", "a:1target-conversation"],
      ["update", "message", "card", "a:1target-conversation"],
    ],
  );
  // the value is the conversation the envelope goes to, read from its reference
  assert.equal((queue.sent[1]?.reference["conversation"] as { id: string }).id, "a:1target-conversation");
  const dump = logger.dump();
  assert.ok(!dump.includes(SECRET_TEXT) && !dump.includes(CARD_TEXT)); // ids and kinds only
});

test("a stream request's line names its conversation and kind, and an envelope without a conversation says -", async () => {
  const direct = new RecordingDirect();
  const { conversation, logger, clock } = build(direct, { ref: ref("19:group@thread.v2", "groupChat") });
  const opened = await conversation.openStream("user-msg-1", SECRET_TEXT);
  assert.ok(opened.ok);
  const finished = opened.value.finish(textMessage(SECRET_TEXT));
  await flushMicrotasks();
  await clock.advance(1000);
  assert.ok((await finished).ok);
  const streamed = logger.lines.filter((l) => l.message === "outbound stream");
  assert.deepEqual(
    streamed.map((l) => [l.fields["content"], l.fields["conversation"]]),
    [
      ["typing", "19:group@thread.v2"],
      ["message", "19:group@thread.v2"],
    ],
  );
  await conversation.deliver({
    operation: "send",
    reference: { serviceUrl: "https://x.test/" },
    activity: TYPING_ACTIVITY,
  });
  const last = logger.lines.filter((l) => l.message === "outbound").at(-1);
  assert.equal(last?.fields["conversation"], "-");
  assert.ok(!logger.dump().includes(SECRET_TEXT));
});

const TYPING_ACTIVITY = { type: "typing" };
