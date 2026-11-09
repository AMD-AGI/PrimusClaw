// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Acks of queued messages: a late one is told from a stray one, and a slow hand-off to the queue is logged. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { textMessage } from "@primusclaw/personal-agent";

import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { AckRegistry, LATE_ACKS_REMEMBERED } from "../../src/messenger/acks.js";
import { RecordingQueue } from "../helpers/outboxes.js";
import { RecordingLogger } from "../helpers/recording-logger.js";
import { build } from "./fixtures.js";

test("an ack that arrives after the wait is logged as late", async () => {
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const acks = new AckRegistry(clock, logger);
  const queue = new RecordingQueue();
  const { conversation } = build(queue, { ackTimeoutMs: 10_000, clock, acks });
  const posted = conversation.post(textMessage("x"));
  await flushMicrotasks();
  await clock.advance(10_000); // gave up at 10 s
  assert.equal(await posted, undefined);
  await clock.advance(20_000); // the ack lands at 30 s
  const ack = queue.sent[0]?.ack ?? "";
  acks.resolve(ack, "teams-1");
  const late = logger.lines.filter((l) => l.message.includes("after the post stopped waiting"));
  assert.equal(late.length, 1);
  assert.equal(late[0]?.fields["lateMs"], 20_000);
});

test("a stray ack is not reported as late", () => {
  const logger = new RecordingLogger();
  new AckRegistry(new FakeClock(), logger).resolve("never-expected", "teams-1");
  assert.deepEqual(logger.lines, []);
});

test("only the newest acks given up on are remembered", () => {
  const logger = new RecordingLogger();
  const acks = new AckRegistry(new FakeClock(), logger);
  for (let i = 0; i <= LATE_ACKS_REMEMBERED; i += 1) acks.gaveUp(`ack-${String(i)}`);
  acks.resolve("ack-0", "x"); // (forgotten: the oldest)
  acks.resolve(`ack-${String(LATE_ACKS_REMEMBERED)}`, undefined);
  assert.equal(logger.lines.length, 1);
  assert.equal(logger.lines[0]?.fields["activityId"], "-");
});

test("a slow hand off to the queue is logged", async () => {
  const queue = new RecordingQueue();
  const { conversation, clock, logger } = build(queue);
  queue.delay = () => clock.sleep(1500);
  const typing = conversation.typing();
  await flushMicrotasks();
  await clock.advance(1500);
  await typing;
  const slow = logger.lines.filter((l) => l.message.includes("to hand to the queue"));
  assert.equal(slow.length, 1);
  assert.equal(slow[0]?.level, "warn");
});
