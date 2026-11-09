// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's only trace of what it handed to Teams is its log, so a finished turn must show up there: every outbound
 * operation, and whether the status message's delivery ack came or did not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { textMessage } from "@primusclaw/personal-agent";

import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { AckRegistry } from "../../src/messenger/acks.js";
import { RecordingQueue } from "../helpers/outboxes.js";
import { build } from "./fixtures.js";

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
