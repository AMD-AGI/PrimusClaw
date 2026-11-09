// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The inbound queue's consumer and the outbound queue's sender. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { DeleteUnsupportedError } from "../../src/outbound/outbox.js";
import { InboundConsumer, isIdleTimeout, queueLagMs } from "../../src/servicebus/consumer.js";
import { IDLE_REOPEN_MS, ServiceBusOutbox } from "../../src/servicebus/outbox.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { FakeBus, FakeReceiver, received } from "./fakes.js";

const envelope = {
  operation: "send" as const,
  reference: { conversation: { id: "c" } },
  activity: { type: "message" },
};

test("poison message is dead lettered and handler failure abandoned", async () => {
  const calls: unknown[] = [];
  const receiver = new FakeReceiver([
    [received("not json")],
    [received("[1]")],
    [received(JSON.stringify({ boom: 1 }))],
    [received(JSON.stringify({ ok: 1 }))],
    [received(new Uint8Array([0xff, 0xfe]))],
  ]);
  const bus = new FakeBus();
  bus.sessions = [receiver];
  const clock = new FakeClock();
  const consumer = new InboundConsumer({
    client: bus,
    queue: "q",
    receivers: 1,
    clock,
    handle: (body) => {
      calls.push(body);
      if (body["boom"]) return Promise.reject(new Error("x"));
      return Promise.resolve();
    },
  });
  const running = consumer.run();
  await flushMicrotasks();
  consumer.stop();
  await clock.runAll();
  await running;
  assert.deepEqual(
    receiver.done.map(([kind]) => kind),
    ["dead", "dead", "abandon", "complete", "dead"],
  );
  assert.deepEqual(calls, [{ boom: 1 }, { ok: 1 }]);
  assert.ok(receiver.closed);
});

test("only the idle timeout is silent: other service bus errors are logged", async () => {
  const bus = new FakeBus();
  bus.sessions = [
    Object.assign(new Error("no session"), { code: "ServiceTimeout" }),
    Object.assign(new Error("the session lock was lost"), { code: "SessionLockLost" }),
    new Error("unauthorized"),
  ];
  const clock = new FakeClock();
  const logger = new RecordingLogger();
  const consumer = new InboundConsumer({
    client: bus,
    queue: "q",
    receivers: 1,
    clock,
    logger,
    handle: () => Promise.resolve(),
  });
  const running = consumer.run();
  await flushMicrotasks();
  await clock.advance(1000); // (the idle timeout: one second, no line)
  await clock.advance(3000);
  await clock.advance(3000);
  consumer.stop();
  await clock.runAll();
  await running;
  const warned = logger.lines.filter((l) => l.level === "warn");
  assert.equal(warned.length, 2); // the lost lock (it says "session", yet is not swallowed) and the refusal
  assert.ok(isIdleTimeout({ code: "SessionCannotBeLocked" }) && !isIdleTimeout(new Error("no session")));
});

test("the handled messages are counted with how long they waited in the queue", async () => {
  const clock = new FakeClock(Date.UTC(2026, 10, 9, 12));
  const seen: Array<[number | undefined, number, boolean]> = [];
  const bus = new FakeBus();
  bus.sessions = [new FakeReceiver([[received("{}", new Date(Date.UTC(2026, 10, 9, 12) - 2500))], [received("{}")]])];
  const consumer = new InboundConsumer({
    client: bus,
    queue: "q",
    receivers: 1,
    clock,
    stats: { processed: (lag, ms, ok) => seen.push([lag, ms, ok]) },
    handle: () => Promise.resolve(),
  });
  const running = consumer.run();
  await flushMicrotasks();
  consumer.stop();
  await clock.runAll();
  await running;
  assert.deepEqual(seen, [
    [2500, 0, true],
    [undefined, 0, true],
  ]);
  assert.equal(queueLagMs(received("{}", new Date(5000)), 4000), 0);
});

test("a sender idle for minutes is replaced before the send, not after it fails", async () => {
  const clock = new FakeClock();
  const bus = new FakeBus();
  const outbox = new ServiceBusOutbox(bus, "q", clock);
  await outbox.publish(envelope);
  await clock.advance(60_000);
  await outbox.publish(envelope); // a minute of quiet: the same sender
  assert.equal(bus.senders.length, 1);
  await clock.advance(IDLE_REOPEN_MS + 1);
  await outbox.publish(envelope); // past the idle limit: the first send goes over a new sender
  assert.equal(bus.senders.length, 2);
  assert.deepEqual(
    bus.senders.map((s) => s.sent.length),
    [2, 1],
  );
  const [first] = bus.senders;
  assert.ok(first?.closed);
  const [sent] = first.sent;
  assert.ok(sent);
  const body = Buffer.from(sent.body).toString("utf8");
  assert.equal(
    body,
    '{"operation": "send", "reference": {"conversation": {"id": "c"}}, "activity": {"type": "message"}}',
  );
  assert.equal(sent.contentType, "application/json");
});

test("a stale sender that cannot even be closed does not stop the send", async () => {
  const clock = new FakeClock();
  const bus = new FakeBus(true);
  const outbox = new ServiceBusOutbox(bus, "q", clock);
  await clock.advance(IDLE_REOPEN_MS + 1);
  await outbox.publish(envelope);
  assert.equal(bus.senders.length, 2);
  assert.equal(bus.senders[1]?.sent.length, 1);
});

test("the queue cannot delete, and a cancelled send is not queued", async () => {
  const bus = new FakeBus();
  const outbox = new ServiceBusOutbox(bus, "q", new FakeClock());
  await assert.rejects(outbox.publish({ ...envelope, operation: "delete", activity_id: "m" }), DeleteUnsupportedError);
  const cancelled = new AbortController();
  cancelled.abort(new Error("cancelled"));
  await assert.rejects(outbox.publish(envelope, { signal: cancelled.signal }), /cancelled/);
  assert.equal(bus.senders[0]?.sent.length, 0);
  await outbox.close();
});
