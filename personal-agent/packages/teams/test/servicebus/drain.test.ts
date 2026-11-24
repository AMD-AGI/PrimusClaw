// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The inbound consumer at a cutover and on a wedged connection: a stop drains (the waits end, what is being handled is
 * settled, what arrives after it goes back to the queue, every session is closed), and a call on the broker that hangs
 * re-arms the receiver on a new connection, closing the old one only once no receiver still holds a session taken on it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import type { BusClient, BusSender, Received, SessionReceiver } from "../../src/servicebus/client.js";
import {
  ACCEPT_DEADLINE_MS,
  InboundConsumer,
  RECEIVE_DEADLINE_MS,
  SESSION_HOLD_MS,
  SETTLE_DEADLINE_MS,
} from "../../src/servicebus/consumer.js";
import { HANDLER_MARGIN_MS, LOCK_RENEWAL_MS } from "../../src/assembly/outbound.js";
import { turn } from "@primusclaw/personal-agent";
import { received } from "./fakes.js";

const T = { timeout: 5000 };

/** A promise the test settles. */
function deferred<V>(): { promise: Promise<V>; resolve: (value: V) => void } {
  let resolve: (value: V) => void = () => undefined;
  const promise = new Promise<V>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A receive that never answers unless its signal is aborted (or, `deaf`, never at all: a wedged link). */
function hanging(signal: AbortSignal | undefined, deaf: boolean): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!deaf)
      signal?.addEventListener("abort", () => {
        reject(signal.reason as Error);
      });
  });
}

/** A session whose receive is scripted per call. */
class ScriptedReceiver implements SessionReceiver {
  readonly done: Array<readonly [string, Received]> = [];
  closed = 0;
  constructor(private readonly script: Array<(signal: AbortSignal | undefined) => Promise<Received[]>>) {}
  receive(_count: number, _waitMs: number, signal?: AbortSignal): Promise<Received[]> {
    const next = this.script.shift();
    return next ? next(signal) : Promise.resolve([]);
  }
  complete(message: Received): Promise<void> {
    this.done.push(["complete", message]);
    return Promise.resolve();
  }
  abandon(message: Received): Promise<void> {
    this.done.push(["abandon", message]);
    return Promise.resolve();
  }
  deadLetter(message: Received): Promise<void> {
    this.done.push(["dead", message]);
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }
}

/** A bus whose acceptNextSession is scripted per call; after the script, "no session" (the documented timeout). */
class ScriptedBus implements BusClient {
  reopened = 0;
  /** How many of the connections given up on were closed. */
  retired = 0;
  accepts = 0;
  constructor(private readonly script: Array<(signal: AbortSignal | undefined) => Promise<SessionReceiver>>) {}
  sender(): BusSender {
    throw new Error("not used");
  }
  acceptNextSession(_queue: string, signal?: AbortSignal): Promise<SessionReceiver> {
    this.accepts += 1;
    const next = this.script.shift();
    if (next) return next(signal);
    return Promise.reject(Object.assign(new Error("no session"), { code: "ServiceTimeout" }));
  }
  reopen(): () => Promise<void> {
    this.reopened += 1;
    return () => {
      this.retired += 1;
      return Promise.resolve();
    };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function consumerOf(bus: BusClient, clock: FakeClock, handle: () => Promise<void>, receivers = 1) {
  const logger = new RecordingLogger();
  let rearmed = 0;
  const consumer = new InboundConsumer({
    client: bus,
    queue: "q",
    receivers,
    clock,
    logger,
    handle,
    stats: {
      processed: () => undefined,
      rearmed: () => {
        rearmed += 1;
      },
    },
  });
  return { consumer, logger, rearmed: () => rearmed };
}

test("a stop ends the wait for the next message at once and closes the session, settling nothing", T, async () => {
  const clock = new FakeClock();
  const receiver = new ScriptedReceiver([(signal) => hanging(signal, false)]);
  const bus = new ScriptedBus([() => Promise.resolve(receiver)]);
  const { consumer } = consumerOf(bus, clock, () => Promise.resolve());
  const running = consumer.run();
  await flushMicrotasks();
  consumer.stop();
  await running; // (no clock moved: the wait ended with the stop, not with IDLE_MS)
  assert.equal(receiver.closed, 1);
  assert.deepEqual(receiver.done, []);
  assert.equal(bus.accepts, 1);
});

test("a stop ends the wait for the next message even when the broker call ignores the abort", T, async () => {
  const clock = new FakeClock();
  const receiver = new ScriptedReceiver([(signal) => hanging(signal, true)]);
  const bus = new ScriptedBus([() => Promise.resolve(receiver)]);
  const { consumer } = consumerOf(bus, clock, () => Promise.resolve());
  const running = consumer.run();
  await flushMicrotasks();
  consumer.stop();
  await running;
  assert.equal(receiver.closed, 1);
  assert.equal(bus.reopened, 0);
});

test("a stop ends a wait for a session even when the broker call ignores the abort", T, async () => {
  const clock = new FakeClock();
  const late = deferred<SessionReceiver>();
  const bus = new ScriptedBus([() => late.promise]);
  const { consumer } = consumerOf(bus, clock, () => Promise.resolve());
  const running = consumer.run();
  await flushMicrotasks();
  consumer.stop();
  await running;
  assert.equal(bus.accepts, 1);
  assert.equal(bus.reopened, 0);
  const receiver = new ScriptedReceiver([]);
  late.resolve(receiver); // (the broker hands the session over after all: it is closed, not left locked)
  await flushMicrotasks();
  assert.equal(receiver.closed, 1);
});

test("a message being handled when the stop comes is finished and completed before the consumer ends", T, async () => {
  const clock = new FakeClock();
  const gate = deferred<undefined>();
  const message = received(JSON.stringify({ type: "message" }), undefined, "m-1", 1);
  const receiver = new ScriptedReceiver([() => Promise.resolve([message]), (signal) => hanging(signal, false)]);
  const bus = new ScriptedBus([() => Promise.resolve(receiver)]);
  let handled = 0;
  const { consumer } = consumerOf(bus, clock, async () => {
    await gate.promise;
    handled += 1;
  });
  const running = consumer.run();
  await flushMicrotasks();
  consumer.stop();
  let ended = false;
  void running.then(() => {
    ended = true;
  });
  await flushMicrotasks();
  assert.equal(ended, false); // (still handling)
  gate.resolve(undefined);
  await running;
  assert.equal(handled, 1);
  assert.deepEqual(
    receiver.done.map(([kind, m]) => [kind, m.messageId]),
    [["complete", "m-1"]],
  );
  assert.equal(receiver.closed, 1);
});

test("a message taken after the stop is abandoned at once for the next worker, with its line", T, async () => {
  const clock = new FakeClock(Date.UTC(2026, 10, 20, 8, 44, 30));
  const message = received(JSON.stringify({ type: "message" }), new Date(Date.UTC(2026, 10, 20, 8, 44, 29)), "m-2", 1);
  const late: { consumer?: InboundConsumer } = {};
  const receiver = new ScriptedReceiver([
    () => {
      late.consumer?.stop(); // (the SIGTERM lands while the broker hands the message over)
      return Promise.resolve([message]);
    },
  ]);
  const bus = new ScriptedBus([() => Promise.resolve(receiver)]);
  let handled = 0;
  const made = consumerOf(bus, clock, () => {
    handled += 1;
    return Promise.resolve();
  });
  late.consumer = made.consumer;
  await made.consumer.run();
  assert.equal(handled, 0);
  assert.deepEqual(
    receiver.done.map(([kind, m]) => [kind, m.messageId]),
    [["abandon", "m-2"]],
  );
  assert.equal(receiver.closed, 1);
  const line = made.logger.lines.find((l) => l.message === "inbound message");
  assert.deepEqual(line?.fields, { id: "m-2", delivery: 1, outcome: "released", lag_ms: 1000, ms: 0 });
  assert.ok(made.logger.lines.some((l) => l.message.startsWith("inbound consumer stopping")));
});

test("a wait for the next message that hangs re-arms the receiver on a new connection", T, async () => {
  const clock = new FakeClock();
  const wedged = new ScriptedReceiver([(signal) => hanging(signal, true)]);
  const message = received(JSON.stringify({ type: "message" }), undefined, "m-3", 2);
  const fresh = new ScriptedReceiver([() => Promise.resolve([message])]);
  const bus = new ScriptedBus([() => Promise.resolve(wedged), () => Promise.resolve(fresh)]);
  let handled = 0;
  const made = consumerOf(bus, clock, () => {
    handled += 1;
    return Promise.resolve();
  });
  const running = made.consumer.run();
  await flushMicrotasks();
  await clock.advance(RECEIVE_DEADLINE_MS - 1);
  assert.equal(bus.reopened, 0); // (a wait inside its deadline is not a wedge)
  await clock.advance(1);
  assert.equal(bus.reopened, 1);
  assert.equal(made.rearmed(), 1);
  assert.equal(wedged.closed, 1);
  assert.equal(bus.retired, 1); // (nothing else was on the old connection: it is closed at once)
  await clock.advance(3000); // (the back-off before the session is taken again)
  assert.equal(handled, 1);
  assert.deepEqual(
    fresh.done.map(([kind, m]) => [kind, m.messageId]),
    [["complete", "m-3"]],
  );
  const warned = made.logger.lines.filter((l) => l.message === "inbound receiver re-armed");
  assert.deepEqual(
    warned.map((l) => [l.level, l.fields]),
    [["warn", { call: "receive", reopened: true }]],
  );
  made.consumer.stop();
  await running;
});

test("receivers wedged on one connection re-open it once, and a hanging settlement re-arms too", T, async () => {
  const clock = new FakeClock();
  const stuck = new ScriptedReceiver([() => Promise.resolve([received("{}", undefined, "m-4", 1)])]);
  stuck.complete = () => new Promise<void>(() => undefined);
  const bus = new ScriptedBus([
    (signal) => hanging(signal, true),
    (signal) => hanging(signal, true),
    () => Promise.resolve(stuck),
  ]);
  const made = consumerOf(bus, clock, () => Promise.resolve(), 2);
  const running = made.consumer.run();
  await flushMicrotasks();
  await clock.advance(ACCEPT_DEADLINE_MS);
  assert.equal(made.rearmed(), 1); // (counted once per connection, not once per receiver that was on it)
  assert.equal(bus.reopened, 1); // (the second receiver found the connection already re-opened)
  assert.equal(bus.retired, 1);
  assert.equal(made.logger.lines.filter((l) => l.message === "inbound receiver re-armed").length, 2);
  await clock.advance(3000);
  await clock.advance(SETTLE_DEADLINE_MS);
  assert.equal(bus.reopened, 2);
  assert.equal(made.rearmed(), 2);
  assert.equal(stuck.closed, 1);
  made.consumer.stop();
  await running;
});

test(
  "a re-arm leaves the old connection open until a message another receiver is handling there is settled",
  T,
  async () => {
    const clock = new FakeClock();
    const gate = deferred<undefined>();
    const message = received(JSON.stringify({ type: "message" }), undefined, "m-5", 1);
    const busy = new ScriptedReceiver([() => Promise.resolve([message])]);
    const wedged = new ScriptedReceiver([(signal) => hanging(signal, true)]);
    const bus = new ScriptedBus([() => Promise.resolve(busy), () => Promise.resolve(wedged)]);
    let handled = 0;
    const made = consumerOf(
      bus,
      clock,
      async () => {
        await gate.promise; // (a turn that takes longer than the other receiver's deadline)
        handled += 1;
      },
      2,
    );
    const running = made.consumer.run();
    await flushMicrotasks();
    await clock.advance(RECEIVE_DEADLINE_MS);
    assert.equal(bus.reopened, 1);
    assert.equal(wedged.closed, 1);
    assert.equal(bus.retired, 0); // (the first receiver still holds its session, and the message's lock, on it)
    assert.equal(busy.closed, 0);
    gate.resolve(undefined);
    await flushMicrotasks();
    assert.equal(handled, 1);
    assert.deepEqual(
      busy.done.map(([kind, m]) => [kind, m.messageId]),
      [["complete", "m-5"]],
    );
    assert.equal(busy.closed, 1);
    assert.equal(bus.retired, 1); // (closed once its last session was settled and closed)
    made.consumer.stop();
    await running;
    assert.equal(bus.retired, 1);
  },
);

test(
  "a session held for SESSION_HOLD_MS is closed and taken again, so its lock renewal never runs out in hand",
  T,
  async () => {
    const clock = new FakeClock();
    const first = received(JSON.stringify({ type: "message" }), undefined, "m-1", 1);
    const second = received(JSON.stringify({ type: "message" }), undefined, "m-2", 1);
    const held = new ScriptedReceiver([() => Promise.resolve([first]), () => Promise.resolve([second])]);
    const again = new ScriptedReceiver([() => Promise.resolve([second])]);
    const bus = new ScriptedBus([() => Promise.resolve(held), () => Promise.resolve(again)]);
    const handled: string[] = [];
    const { consumer } = consumerOf(bus, clock, async () => {
      handled.push(handled.length === 0 ? "m-1" : "m-2");
      if (handled.length === 1) await clock.advance(SESSION_HOLD_MS); // (a busy conversation: the hold is used up)
    });
    const running = consumer.run();
    await flushMicrotasks();
    await flushMicrotasks();
    consumer.stop();
    await running;
    assert.deepEqual(
      held.done.map(([kind, m]) => [kind, m.messageId]),
      [["complete", "m-1"]],
    );
    assert.equal(held.closed, 1); // (m-2 was not taken on the session held past the bound)
    assert.equal(bus.accepts >= 2, true);
    assert.deepEqual(
      again.done.map(([kind, m]) => [kind, m.messageId]),
      [["complete", "m-2"]],
    );
  },
);

/**
 * A broker with one session that keeps its lock the way the SDK does: renewed for `renewalMs` from the accept and then
 * let go. A lock that lapses with a message in hand gives the message back to the queue (a redelivery, its count one
 * higher), and the settlement of the receiver that had it fails as the SDK's does (SessionLockLost).
 */
class LockingBroker implements BusClient {
  readonly queued: Received[];
  redelivered = 0;
  completed: string[] = [];
  constructor(
    private readonly clock: FakeClock,
    private readonly renewalMs: number,
    messages: Received[],
  ) {
    this.queued = [...messages];
  }
  sender(): BusSender {
    throw new Error("not used");
  }
  acceptNextSession(): Promise<SessionReceiver> {
    if (this.queued.length === 0)
      return Promise.reject(Object.assign(new Error("no session"), { code: "ServiceTimeout" }));
    const released = new AbortController();
    let inHand: Received | undefined;
    let lost = false;
    this.clock.sleep(this.renewalMs, released.signal).then(
      () => {
        lost = true;
        if (inHand === undefined) return;
        this.redelivered += 1;
        this.queued.unshift({ ...inHand, deliveryCount: (inHand.deliveryCount ?? 1) + 1 });
        inHand = undefined;
      },
      () => undefined,
    );
    const settle = (message: Received): Promise<void> => {
      if (lost || inHand !== message)
        return Promise.reject(Object.assign(new Error("session lock lost"), { code: "SessionLockLost" }));
      inHand = undefined;
      return Promise.resolve();
    };
    return Promise.resolve({
      receive: () => {
        if (lost) return Promise.reject(Object.assign(new Error("session lock lost"), { code: "SessionLockLost" }));
        const next = this.queued.shift();
        if (next === undefined) return Promise.resolve([]);
        inHand = next;
        return Promise.resolve([next]);
      },
      complete: async (message) => {
        await settle(message);
        this.completed.push(message.messageId ?? "");
      },
      abandon: (message) =>
        settle(message).then(() => {
          this.queued.unshift(message);
        }),
      deadLetter: settle,
      close: () => {
        released.abort();
        return Promise.resolve();
      },
    });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * One message whose handler runs `handleMs` on the fake clock the first time (a redelivery is handled at once), on a
 * broker renewing locks for `renewalMs`.
 */
async function longHandler(renewalMs: number, handleMs: number) {
  const clock = new FakeClock();
  const broker = new LockingBroker(clock, renewalMs, [
    received(JSON.stringify({ type: "message" }), undefined, "m-1", 1),
  ]);
  let handled = 0;
  const { consumer } = consumerOf(broker, clock, async () => {
    handled += 1;
    if (handled === 1) await clock.advance(handleMs); // (a turn followed for this long, on the fake clock)
  });
  const running = consumer.run();
  for (let i = 0; i < 20; i += 1) {
    await flushMicrotasks();
    await clock.advance(1_000);
  }
  consumer.stop();
  await running;
  return { broker, handled };
}

test(
  "a handler running past the old 5-minute renewal keeps its lock: the message is completed once, not redelivered",
  T,
  async () => {
    const handleMs = turn.TURN_DEADLINE_SECONDS * 1000 + 5 * 60_000; // (the longest turn followed, and the work around it)
    const { broker, handled } = await longHandler(LOCK_RENEWAL_MS, handleMs);
    assert.equal(handled, 1);
    assert.equal(broker.redelivered, 0);
    assert.deepEqual(broker.completed, ["m-1"]);
  },
);

test(
  "the broker model is not vacuous: with the old 5-minute renewal the same handler's message is redelivered",
  T,
  async () => {
    const handleMs = turn.TURN_DEADLINE_SECONDS * 1000 + 5 * 60_000;
    const { broker, handled } = await longHandler(5 * 60_000, handleMs);
    assert.equal(broker.redelivered, 1);
    assert.equal(handled, 2); // (the request ran twice: the duplicate this renewal bound prevents)
  },
);

test("the lock renewal outlasts a held session, one more wait, a followed turn and the work around it", () => {
  // (the literal bound, not the formula the code uses: 30 minutes of turn, 4 of hold, one of wait, 10 of margin)
  assert.equal(turn.TURN_DEADLINE_SECONDS, 30 * 60);
  assert.equal(LOCK_RENEWAL_MS >= (30 + 4 + 1 + 10) * 60_000, true);
  assert.equal(
    SESSION_HOLD_MS + RECEIVE_DEADLINE_MS + turn.TURN_DEADLINE_SECONDS * 1000 + HANDLER_MARGIN_MS + SETTLE_DEADLINE_MS,
    LOCK_RENEWAL_MS,
  );
});
