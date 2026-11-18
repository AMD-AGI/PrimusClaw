/**
 * What keeps a message's own time short: one inbound sender per instance, and a start-up prefetch. A port of
 * ingress-function/tests/test_warm_path.py (test names match).
 *
 * These pin that the sender is opened once and kept, that a broken one is replaced, and that the prefetch opens it on
 * every kind of hosted instance (Flex Consumption included), never in tests or local runs, and hands it to the first
 * message.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type Deps, type Ingress } from "../src/ingress.js";
import { type QueueClient, type QueueMessage, type QueueSender } from "../src/queue.js";
import { HOSTED_INSTANCE_SETTINGS } from "../src/settings.js";
import { type Caplog, FULL_ENV, load, MESSAGE, nth, post } from "./helpers.js";

class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

class Sender implements QueueSender {
  opened = false;
  closed = false;
  /** Replaces the open step (create_message_batch), as the Python tests monkeypatch it. */
  static openHook: ((sender: Sender) => Promise<void>) | null = null;
  /** Runs before a send; what it returns (or throws) is the send's outcome when it does not return undefined. */
  static sendHook: ((sender: Sender, id: string) => Promise<void> | undefined) | null = null;

  constructor(
    readonly bus: Bus,
    readonly queue: string,
    public failSends: number,
    readonly failOpen: boolean,
  ) {}

  async createMessageBatch(): Promise<void> {
    if (Sender.openHook) return Sender.openHook(this);
    return this.open();
  }

  open(): Promise<void> {
    if (this.failOpen) return Promise.reject(new ConnectionError("open failed"));
    this.opened = true;
    return Promise.resolve();
  }

  sendMessages(message: QueueMessage): Promise<void> {
    const hooked = Sender.sendHook?.(this, (JSON.parse(message.body.toString()) as { id: string }).id);
    if (hooked !== undefined) return hooked.then(() => void this.bus.sent.push([this, message]));
    if (this.failSends) {
      this.failSends -= 1;
      return Promise.reject(new ConnectionError("link detached"));
    }
    this.bus.sent.push([this, message]);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** A ServiceBusClient that hands out Senders, failing the first sends or opens it is told to. */
class Bus implements QueueClient {
  readonly senders: Sender[] = [];
  readonly sent: [Sender, QueueMessage][] = [];

  constructor(
    private readonly failingSends: number[] = [], // per sender, in creation order: sends that raise
    private failingOpens = 0,
  ) {}

  createSender(queue: string): Sender {
    const failSends = this.failingSends.shift() ?? 0;
    const failOpen = this.failingOpens > 0;
    if (failOpen) this.failingOpens -= 1;
    const sender = new Sender(this, queue, failSends, failOpen);
    this.senders.push(sender);
    return sender;
  }
}

function make(bus: Bus, overrides: Partial<Deps> = {}): { ingress: Ingress; log: Caplog } {
  Sender.openHook = null;
  Sender.sendHook = null;
  const { ingress, log } = load(FULL_ENV, overrides);
  ingress.newClient = () => bus;
  ingress.validate = () => Promise.resolve({});
  return { ingress, log };
}

const ids = (bus: Bus) => bus.sent.map(([, m]) => (JSON.parse(m.body.toString()) as { id: string }).id);

test("test_one_sender_serves_every_message_and_stays_open", async () => {
  const bus = new Bus();
  const { ingress } = make(bus);
  for (const id of ["a1", "a2", "a3"]) assert.equal((await post(ingress, { ...MESSAGE, id })).status, 200);
  assert.equal(bus.senders.length, 1);
  assert.deepEqual(ids(bus), ["a1", "a2", "a3"]);
  assert.ok(!nth(bus.senders, 0).closed);
});

test("test_a_failed_send_is_retried_once_on_a_new_sender", async () => {
  const bus = new Bus([1]); // the kept sender's connection was dropped
  const { ingress, log } = make(bus);
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  assert.equal(bus.senders.length, 2);
  assert.ok(nth(bus.senders, 0).closed && !nth(bus.senders, 1).closed);
  assert.deepEqual(
    bus.sent.map(([s]) => s),
    [bus.senders[1]],
  );
  assert.ok(log.text.includes("retrying once on a new sender"));
  // The new sender is the one kept.
  assert.equal((await post(ingress, { ...MESSAGE, id: "a2" })).status, 200);
  assert.equal(bus.senders.length, 2);
});

test("test_a_message_that_fails_on_two_senders_is_a_500_and_the_next_one_starts_clean", async () => {
  const bus = new Bus([1, 1]);
  const { ingress } = make(bus);
  assert.equal((await post(ingress, MESSAGE)).status, 500);
  assert.deepEqual(bus.sent, []);
  assert.ok(bus.senders.every((s) => s.closed));
  assert.equal(ingress.inbound, null);
  assert.equal((await post(ingress, { ...MESSAGE, id: "a2" })).status, 200);
  assert.equal(bus.senders.length, 3);
});

test("test_the_delivery_ack_uses_the_same_sender", async () => {
  const bus = new Bus();
  // The Connector answers with the posted activity's id.
  const { ingress } = make(bus, {
    fetch: () => Promise.resolve(new Response(JSON.stringify({ id: "posted-1" }), { status: 200 })),
  });
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  ingress.connectorUrl = () => "https://smba.trafficmanager.net/teams/v3/x";
  ingress.tokens.get = () => Promise.resolve("tok");
  await ingress.deliverOutbound({
    operation: "send",
    reference: { conversation: { id: "c" } },
    activity: {},
    ack: "ack-1",
  });
  assert.equal(bus.senders.length, 1);
  assert.equal(bus.sent.length, 2);
});

// --- concurrent sends on one instance ----------------------------------------

test("a send that hangs holds up only its own request, which is a 500 at the deadline", { timeout: 5000 }, async () => {
  const bus = new Bus();
  const { ingress } = make(bus);
  ingress.sendDeadlineSeconds = 0.3;
  // The hung send ignores its abort signal: the deadline must end the request all the same.
  Sender.sendHook = (_sender, id) => (id === "stuck" ? new Promise<void>(() => undefined) : undefined);
  const started = performance.now();
  const stuck = post(ingress, { ...MESSAGE, id: "stuck" });
  const others = await Promise.all(["a2", "a3", "a4"].map((id) => post(ingress, { ...MESSAGE, id })));
  // Answered while the hung send was still in flight, on the same sender: nothing waited behind it.
  assert.ok(performance.now() - started < 250, "the other requests waited for the hung send");
  assert.deepEqual(
    others.map((r) => r.status),
    [200, 200, 200],
  );
  assert.deepEqual(ids(bus), ["a2", "a3", "a4"]);
  assert.equal(bus.senders.length, 1);
  assert.equal((await stuck).status, 500);
  assert.ok(performance.now() - started < 1000);
  // No second attempt once the deadline has passed, and the sender it used is not kept.
  assert.equal(bus.senders.length, 1);
  assert.ok(nth(bus.senders, 0).closed);
  assert.equal((await post(ingress, { ...MESSAGE, id: "a5" })).status, 200);
  assert.equal(bus.senders.length, 2);
});

test(
  "a failed send discards only the sender it used, never one another request has just opened",
  { timeout: 5000 },
  async () => {
    const bus = new Bus();
    const { ingress, log } = make(bus);
    // Both messages are in flight on the first sender when its connection drops; each fails there.
    const g = gate();
    Sender.sendHook = (sender) =>
      sender === bus.senders[0]
        ? g.wait(5000).then(() => Promise.reject(new ConnectionError("link detached")))
        : undefined;
    const replies = [post(ingress, { ...MESSAGE, id: "a1" }), post(ingress, { ...MESSAGE, id: "a2" })];
    await new Promise((resolve) => setImmediate(resolve));
    g.set();
    assert.deepEqual(
      (await Promise.all(replies)).map((r) => r.status),
      [200, 200],
    );
    // The first failure replaced the sender; the second found it replaced and kept the new one.
    assert.equal(bus.senders.length, 2);
    assert.ok(nth(bus.senders, 0).closed && !nth(bus.senders, 1).closed);
    assert.equal(ingress.inbound, bus.senders[1]);
    assert.deepEqual(ids(bus).sort(), ["a1", "a2"]);
    assert.ok(bus.sent.every(([s]) => s === bus.senders[1]));
    assert.equal(log.text.split("retrying once on a new sender").length - 1, 2);
  },
);

// --- the start-up prefetch ---------------------------------------------------

test("test_no_prefetch_off_azure", () => {
  const { ingress, spawned } = load(FULL_ENV);
  assert.deepEqual(spawned, []);
  assert.equal(ingress.prefetch, null);
});

test("test_prefetch_starts_on_every_kind_of_hosted_instance", async (t) => {
  // WEBSITE_POD_NAME is what a Flex Consumption instance has: WEBSITE_INSTANCE_ID alone never started it there.
  for (const hosted of HOSTED_INSTANCE_SETTINGS) {
    await t.test(hosted, () => {
      const { spawned } = load({ ...FULL_ENV, [hosted]: "0--e8206a8d" });
      assert.deepEqual(spawned, ["ingress-prefetch"]);
    });
  }
});

test("test_no_prefetch_without_an_inbound_queue_setting", () => {
  const { spawned } = load({ PRIMUSCLAW_BOT_APP_ID: "claw-app", WEBSITE_POD_NAME: "0--e8206a8d" });
  assert.deepEqual(spawned, []);
});

test("test_prefetch_opens_the_sender_the_first_message_uses", async () => {
  const bus = new Bus();
  const { ingress, log } = make(bus);
  await ingress.prefetchSender();
  assert.equal(bus.senders.length, 1);
  assert.ok(nth(bus.senders, 0).opened);
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  assert.equal((await post(ingress, { ...MESSAGE, id: "a2" })).status, 200);
  assert.equal(bus.senders.length, 1);
  assert.equal(bus.sent.length, 2);
  const reports = log.records
    .filter((r) => r.logger === "function_app" && r.level === "info" && r.message.includes("start-up prefetch"))
    .map((r) => r.message);
  assert.equal(reports.length, 1); // once, by the first invocation
  assert.ok(nth(reports, 0).includes("inbound sender") && !nth(reports, 0).includes("failed"));
});

test("test_a_failed_prefetch_leaves_the_work_to_the_message", async () => {
  const bus = new Bus([], 1);
  const { ingress, log } = make(bus);
  await ingress.prefetchSender();
  assert.equal(ingress.inbound, null);
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  assert.equal(bus.senders.length, 2);
  assert.deepEqual(
    bus.sent.map(([s]) => s),
    [bus.senders[1]],
  );
  assert.ok(nth(bus.senders, 0).closed); // the one that could not open is not left behind
  assert.ok(log.text.includes("inbound sender failed (ConnectionError)"));
});

test("test_a_sender_the_prefetch_opens_after_a_message_opened_one_is_closed", async () => {
  const bus = new Bus();
  const { ingress } = make(bus);
  assert.equal((await post(ingress, MESSAGE)).status, 200); // the message did not wait: no prefetch was running
  await ingress.prefetchSender(); // a slow prefetch finishing late
  assert.equal(bus.senders.length, 2);
  assert.ok(nth(bus.senders, 1).closed);
  assert.equal(ingress.inbound, bus.senders[0]);
});

/** threading.Event: wait(ms) returns when set() is called or the time is up. */
function gate(): { wait: (ms: number) => Promise<void>; set: () => void } {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return {
    wait: async (ms) => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([opened, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
      clearTimeout(timer);
    },
    set: () => {
      release();
    },
  };
}

test("test_a_message_waits_for_a_running_prefetch_instead_of_opening_a_second_sender", async () => {
  const bus = new Bus();
  const { ingress } = make(bus);
  const g = gate();
  Sender.openHook = async (sender) => {
    await g.wait(5000);
    await sender.open();
  };
  void ingress.startPrefetch();
  const timer = setTimeout(g.set, 200);
  try {
    assert.equal((await post(ingress, MESSAGE)).status, 200);
  } finally {
    clearTimeout(timer);
    g.set();
    Sender.openHook = null;
  }
  assert.equal(bus.senders.length, 1);
  assert.ok(nth(bus.senders, 0).opened);
  assert.equal(bus.sent.length, 1);
});

test("test_a_message_does_not_wait_long_for_a_stuck_prefetch", async () => {
  const bus = new Bus();
  const { ingress } = make(bus);
  ingress.prefetchWaitSeconds = 0.2;
  const g = gate();
  Sender.openHook = () => g.wait(5000);
  void ingress.startPrefetch();
  try {
    assert.equal((await post(ingress, MESSAGE)).status, 200);
    assert.equal(bus.sent.length, 1);
    assert.equal(nth(bus.sent, 0)[0], bus.senders[1]);
  } finally {
    g.set();
    await ingress.prefetch;
    Sender.openHook = null;
  }
  assert.ok(nth(bus.senders, 0).closed);
  assert.equal(ingress.inbound, bus.senders[1]);
});
