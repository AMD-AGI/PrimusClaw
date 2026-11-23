// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The delivery probe: answered through the outbound queue, timed to the answer queued and to the relay's ack. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { DELIVERED, inboundHandler } from "../../src/assembly/inbound.js";
import { AckRegistry } from "../../src/messenger/acks.js";
import type { Outbox, TeamsEnvelope } from "../../src/outbound/outbox.js";
import { DeliveryProbe, PROBE, PROBE_CONVERSATION, PROBE_REPLY_TIMEOUT_MS } from "../../src/probe/probe.js";
import { InboundConsumer } from "../../src/servicebus/consumer.js";
import { FakeBus, FakeReceiver, received } from "../servicebus/fakes.js";

const SENT = Date.UTC(2026, 10, 23, 10, 0, 0);

class RecordingOutbox implements Outbox {
  readonly published: TeamsEnvelope[] = [];
  fails = false;
  publish(envelope: TeamsEnvelope): Promise<undefined> {
    if (this.fails) return Promise.reject(new Error("the outbound queue is gone"));
    this.published.push(envelope);
    return Promise.resolve(undefined);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function world(outbox: Outbox | undefined = new RecordingOutbox()) {
  const clock = new FakeClock(SENT);
  const logger = new RecordingLogger();
  const acks = new AckRegistry(clock, logger);
  const probed: Array<[number, number | null]> = [];
  const probe = new DeliveryProbe({
    outbox,
    acks,
    clock,
    logger,
    stats: { probed: (feedback, reply) => probed.push([feedback, reply]) },
  });
  return { clock, logger, acks, probe, probed };
}

const probeBody = (id = "4b0c-1", sentAt = new Date(SENT).toISOString()) => ({ type: PROBE, id, sent_at: sentAt });

test("a probe is answered on the outbound queue and timed to the answer queued and to the relay's ack", async () => {
  const outbox = new RecordingOutbox();
  const w = world(outbox);
  await w.clock.advance(800); // (the probe waited 0.8 s on the inbound queue)
  await w.probe.answer(probeBody());
  assert.deepEqual(outbox.published, [
    {
      operation: "probe",
      reference: { conversation: { id: PROBE_CONVERSATION } },
      activity: { type: "typing" },
      ack: "probe-4b0c-1",
    },
  ]);
  await w.clock.advance(1500);
  w.acks.resolve("probe-4b0c-1", "probe");
  await w.probe.settled();
  assert.deepEqual(w.probed, [[800, 2300]]);
  const line = w.logger.lines.find((l) => l.message === "delivery probe");
  assert.deepEqual(line?.fields, { id: "4b0c-1", outcome: "answered", feedback_ms: 800, reply_ms: 2300 });
  assert.equal(w.clock.pending, 0); // (the wait for the ack ended with it)
});

test("a probe whose ack does not come back in time is counted unanswered, and a late ack is logged as late", async () => {
  const w = world();
  await w.probe.answer(probeBody("p-2"));
  await w.clock.advance(PROBE_REPLY_TIMEOUT_MS - 1);
  assert.deepEqual(w.probed, []);
  await w.clock.advance(1);
  await w.probe.settled();
  assert.deepEqual(w.probed, [[0, null]]);
  assert.deepEqual(w.logger.lines.find((l) => l.message === "delivery probe")?.fields, {
    id: "p-2",
    outcome: "unanswered",
    feedback_ms: 0,
  });
  w.acks.resolve("probe-p-2", "probe");
  assert.ok(w.logger.lines.some((l) => l.message.startsWith("outbound ack arrived after the post stopped waiting")));
});

test("an answer the outbound queue refuses is counted unanswered at once and does not throw", async () => {
  const outbox = new RecordingOutbox();
  outbox.fails = true;
  const w = world(outbox);
  await w.probe.answer(probeBody("p-3"));
  assert.deepEqual(w.probed, [[0, null]]);
  assert.equal(w.logger.lines.find((l) => l.message === "delivery probe")?.fields["outcome"], "not_queued");
  assert.equal(w.clock.pending, 0);
});

test("a probe that cannot be read, or one with nowhere to answer, is dropped unanswered and uncounted", async () => {
  const w = world();
  for (const bad of [
    { type: PROBE },
    probeBody("has space"),
    probeBody("x".repeat(65)),
    probeBody("p", "yesterday"),
    probeBody("p", "2026-11-23T10:00:00+08:00"),
    { ...probeBody(), id: 5 },
  ]) {
    await w.probe.answer(bad);
  }
  assert.deepEqual(w.probed, []);
  assert.equal(w.logger.lines.filter((l) => l.message === "delivery probe not read").length, 6);
  const gate = world(undefined);
  await gate.probe.answer(probeBody());
  assert.deepEqual(gate.probed, []);
});

test("closing stops waiting for the acks still out without counting them", async () => {
  const w = world();
  await w.probe.answer(probeBody("p-4"));
  w.probe.close();
  await w.probe.settled();
  assert.deepEqual(w.probed, []);
  assert.equal(w.clock.pending, 0);
  await w.probe.answer(probeBody("p-5")); // (after the close: not answered)
  assert.deepEqual(w.probed, []);
});

test("through the consumer: the ack on the probe's own session is read after the probe is settled", async () => {
  const outbox = new RecordingOutbox();
  const w = world(outbox);
  const routed: unknown[] = [];
  const handle = inboundHandler({
    acks: w.acks,
    route: (event) => {
      routed.push(event);
      return Promise.resolve();
    },
    botName: "Bot",
    probe: w.probe,
  });
  const receiver = new FakeReceiver([
    [received(JSON.stringify(probeBody("p-6")), new Date(SENT), "probe-msg", 1)],
    [received(JSON.stringify({ type: DELIVERED, ack: "probe-p-6", activity_id: "probe" }), new Date(SENT), "ack", 1)],
  ]);
  const bus = new FakeBus();
  bus.sessions = [receiver];
  const consumer = new InboundConsumer({ client: bus, queue: "q", receivers: 1, clock: w.clock, handle });
  const running = consumer.run();
  await flushMicrotasks();
  await w.probe.settled();
  consumer.stop();
  await running;
  assert.deepEqual(
    receiver.done.map(([kind, m]) => [kind, m.messageId]),
    [
      ["complete", "probe-msg"],
      ["complete", "ack"],
    ],
  );
  assert.deepEqual(w.probed, [[0, 0]]);
  assert.deepEqual(routed, []); // (a probe never reaches the router)
});
