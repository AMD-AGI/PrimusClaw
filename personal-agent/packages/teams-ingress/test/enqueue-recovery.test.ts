// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Not a port: how the inbound send gets past a Service Bus connection that has died under a kept client. The ingress
 * builds its clients through its real newClient (the ServiceBusFactory is the fake), and the fakes fail the way the
 * SDK did in production: a send that never settles on a wedged connection (each attempt then ends with the
 * DOMException TimeoutError of its own timer), "AbortError: Link has been permanently closed. Not reopening." from a
 * sender another request closed, and ServiceBusErrors with their codes.
 *
 * test/wedged-connection.test.ts runs the same recovery with the real SDK against a local broker.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ServiceBusError } from "@azure/service-bus";

import { HEALTH_LOGGER, isConnectionFailure } from "../src/health.js";
import { type Ingress, SEND_ATTEMPT_SECONDS, SEND_ATTEMPTS, SEND_DEADLINE_SECONDS } from "../src/ingress.js";
import { type QueueClient, type QueueMessage, type QueueSender, type ServiceBusFactory } from "../src/queue.js";
import { type Caplog, FULL_ENV, json, load, MESSAGE, nth, post } from "./helpers.js";

/** @azure/abort-controller's AbortError, as the SDK throws it from a sender whose link was closed. */
class AbortError extends Error {
  override name = "AbortError";
}
const linkClosed = (): Error => new AbortError("Link has been permanently closed. Not reopening.");

/** What one send does: settle (undefined), throw, or hang until its abort signal fires (a wedged connection). */
type Behaviour = "ok" | "hang" | "hang-ignoring-abort" | (() => Error);

interface FakeClient {
  readonly index: number;
  closed: boolean;
  readonly senders: { closed: boolean }[];
}

/**
 * A Service Bus whose n-th client (in build order) sends as `plan[n]` says, one entry per send on that client (the last
 * entry repeats). Records every client built and every message that reached the queue, with the client it went on.
 */
class Fleet implements ServiceBusFactory {
  readonly clients: FakeClient[] = [];
  readonly queued: { client: number; messageId: string; activityId: string }[] = [];
  /** Sends that were started, per client. */
  readonly started: number[] = [];

  constructor(private readonly plan: Behaviour[][]) {}

  fromConnectionString(): QueueClient {
    return this.build();
  }

  fromIdentity(): QueueClient {
    return this.build();
  }

  private build(): QueueClient {
    const state: FakeClient = { index: this.clients.length, closed: false, senders: [] };
    this.clients.push(state);
    this.started.push(0);
    const steps = [...(this.plan[state.index] ?? ["ok"])];
    const next = (): Behaviour => (steps.length > 1 ? (steps.shift() ?? "ok") : (steps[0] ?? "ok"));
    return {
      createSender: (): QueueSender => {
        const sender = { closed: false };
        state.senders.push(sender);
        return {
          sendMessages: (message: QueueMessage, options?: { abortSignal?: AbortSignal }) => {
            this.started[state.index] = (this.started[state.index] ?? 0) + 1;
            return this.send(state, sender, next(), message, options?.abortSignal);
          },
          createMessageBatch: () => Promise.resolve(undefined),
          close: () => {
            sender.closed = true;
            return Promise.resolve();
          },
        };
      },
      close: () => {
        state.closed = true;
        for (const s of state.senders) s.closed = true;
        return Promise.resolve();
      },
    };
  }

  private send(
    state: FakeClient,
    sender: { closed: boolean },
    behaviour: Behaviour,
    message: QueueMessage,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (state.closed || sender.closed) return Promise.reject(linkClosed());
    if (typeof behaviour === "function") return Promise.reject(behaviour());
    if (behaviour === "hang-ignoring-abort") return new Promise<void>(() => undefined);
    if (behaviour === "hang") {
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(signal.reason as Error);
        });
      });
    }
    const body = JSON.parse(message.body.toString("utf8")) as { id: string };
    this.queued.push({ client: state.index, messageId: message.messageId, activityId: body.id });
    return Promise.resolve();
  }
}

function make(plan: Behaviour[][], times: { attempt?: number; deadline?: number } = {}) {
  const fleet = new Fleet(plan);
  const { ingress, log } = load(FULL_ENV, { serviceBus: fleet });
  ingress.validate = () => Promise.resolve({});
  ingress.sendAttemptSeconds = times.attempt ?? 0.15;
  ingress.sendDeadlineSeconds = times.deadline ?? 2;
  return { fleet, ingress, log };
}

const health = (log: Caplog): Record<string, unknown>[] =>
  log.records.filter((r) => r.logger === HEALTH_LOGGER).map((r) => JSON.parse(r.message) as Record<string, unknown>);

const timed = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
  const started = performance.now();
  const result = await work();
  return [result, performance.now() - started];
};

// --- the limits -------------------------------------------------------------------------------------------------------

test("a send is answered inside the Bot Framework's 15 s, in attempts short enough to leave room for a new client", () => {
  // (differences, so the checks stay checks if a limit changes: the constants' literal types make a plain < "always true")
  assert.ok(
    15 - SEND_DEADLINE_SECONDS > 0,
    "a request still running at 15 s is dropped by the caller (a 499), not retried",
  );
  assert.ok(SEND_ATTEMPT_SECONDS * 2 < SEND_DEADLINE_SECONDS, "a hung first attempt must leave time for a second");
  assert.ok(SEND_ATTEMPTS - 2 >= 0, "a failed attempt is retried on a new client");
});

// --- the production failure: a wedged connection under the kept client ------------------------------------------------

test("a send that hangs on a wedged connection is given up after one attempt and goes through on a new client", async () => {
  // Client 0 served one message, then its connection wedged: every send on it, on any sender, hangs.
  const { fleet, ingress, log } = make([["ok", "hang"]]);
  assert.equal((await post(ingress, { ...MESSAGE, id: "m1" })).status, 200);
  const [reply, ms] = await timed(() => post(ingress, { ...MESSAGE, id: "m2" }));
  assert.equal(reply.status, 200);
  assert.ok(ms < 1000, `took ${String(ms)} ms: one attempt timeout, not the deadline`);
  assert.equal(fleet.clients.length, 2, "a new client, not only a new sender on the wedged one");
  assert.ok(nth(fleet.clients, 0).closed && !nth(fleet.clients, 1).closed);
  assert.deepEqual(fleet.queued, [
    { client: 0, messageId: "m1", activityId: "m1" },
    { client: 1, messageId: "m2", activityId: "m2" },
  ]);
  const [reset, ...rest] = health(log);
  assert.deepEqual(reset, {
    event: "inbound_client_reset",
    attempt: 1,
    error: "TimeoutError",
    code: null,
    client_resets: 1,
  });
  assert.deepEqual(rest, []);
  assert.ok(log.text.includes("inbound send failed; retrying on a new client"));
  // The new client is kept: the next message uses it, and builds nothing.
  assert.equal((await post(ingress, { ...MESSAGE, id: "m3" })).status, 200);
  assert.equal(fleet.clients.length, 2);
  assert.equal(nth(fleet.queued, 2).client, 1);
});

test("a send that ignores its abort signal still ends at its attempt timeout", async () => {
  const { fleet, ingress } = make([["hang-ignoring-abort"]]);
  const [reply, ms] = await timed(() => post(ingress, MESSAGE));
  assert.equal(reply.status, 200);
  assert.ok(ms < 1000);
  assert.equal(fleet.clients.length, 2);
});

test("'Link has been permanently closed' throws the client away, and the message goes through once", async () => {
  const { fleet, ingress, log } = make([[linkClosed]]);
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  assert.equal(fleet.clients.length, 2);
  assert.ok(nth(fleet.clients, 0).closed);
  assert.deepEqual(fleet.queued, [{ client: 1, messageId: "a1", activityId: "a1" }]);
  assert.equal(nth(health(log), 0)["error"], "AbortError");
});

test("a Service Bus connection error throws the client away; an error about the message keeps it", async () => {
  const communication = () => new ServiceBusError("connection lost", "ServiceCommunicationProblem");
  const tooLarge = () => new ServiceBusError("too large", "MessageSizeExceeded");
  {
    const { fleet, ingress } = make([[communication]]);
    assert.equal((await post(ingress, MESSAGE)).status, 200);
    assert.equal(fleet.clients.length, 2);
  }
  {
    const { fleet, ingress, log } = make([[tooLarge, "ok"]]);
    assert.equal((await post(ingress, MESSAGE)).status, 200);
    assert.equal(fleet.clients.length, 1, "the connection is fine: only the sender is replaced");
    assert.equal(nth(fleet.clients, 0).senders.length, 2);
    assert.ok(nth(nth(fleet.clients, 0).senders, 0).closed && !nth(fleet.clients, 0).closed);
    assert.ok(log.text.includes("inbound send failed; retrying on a new sender"));
    assert.deepEqual(health(log), []);
  }
});

test("which failures count as the connection's", () => {
  const sb = (code: string) => new ServiceBusError("x", code as never);
  for (const error of [
    linkClosed(),
    new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    new TypeError("fetch failed"),
    sb("ServiceCommunicationProblem"),
    sb("GeneralError"),
    sb("ServiceTimeout"),
    sb("UnauthorizedAccess"),
    "not even an error",
  ]) {
    assert.equal(isConnectionFailure(error), true, String(error));
  }
  for (const code of ["MessageSizeExceeded", "MessagingEntityNotFound", "MessagingEntityDisabled", "QuotaExceeded"]) {
    assert.equal(isConnectionFailure(sb(code)), false, code);
  }
});

// --- when nothing gets through ----------------------------------------------------------------------------------------

test("when every attempt fails the message is a 500 Teams retries, every client is closed, and one record says so", async () => {
  const { fleet, ingress, log } = make([["hang"], [linkClosed], ["hang"]]);
  const [reply, ms] = await timed(() => post(ingress, MESSAGE));
  assert.equal(reply.status, 500);
  assert.ok(ms < 1500);
  assert.equal(fleet.clients.length, 3);
  assert.deepEqual(fleet.started, [1, 1, 1], "three attempts, one per client");
  assert.ok(fleet.clients.every((c) => c.closed));
  assert.equal(ingress.inbound, null);
  assert.deepEqual(fleet.queued, []);
  const records = health(log);
  assert.deepEqual(
    records.map((r) => r["event"]),
    ["inbound_client_reset", "inbound_client_reset", "inbound_client_reset", "inbound_enqueue_failed"],
  );
  const failed = nth(records, 3);
  assert.equal(failed["kind"], "activity");
  assert.equal(failed["attempts"], 3);
  assert.equal(failed["error"], "TimeoutError");
  assert.equal(failed["enqueue_failures"], 1);
  assert.equal(failed["consecutive_failures"], 1);
  assert.equal(failed["client_resets"], 3);
  assert.equal(typeof failed["elapsed_ms"], "number");
  // The line the alert also matches, at error.
  assert.ok(log.records.some((r) => r.level === "error" && r.message === "failed to enqueue activity"));
  assert.deepEqual(ingress.health.counters, {
    enqueued: 0,
    enqueueFailures: 1,
    attemptFailures: 3,
    clientResets: 3,
    consecutiveFailures: 1,
  });
});

test("Teams' retry of a failed message is queued once, under the activity id the worker dedupes on", async () => {
  const { fleet, ingress, log } = make([["hang"], ["hang"], ["hang"], ["ok"]]);
  assert.equal((await post(ingress, { ...MESSAGE, id: "act-9" })).status, 500);
  // The Bot Framework sends the same activity again.
  assert.equal((await post(ingress, { ...MESSAGE, id: "act-9" })).status, 200);
  assert.deepEqual(fleet.queued, [{ client: 3, messageId: "act-9", activityId: "act-9" }]);
  const recovered = health(log).filter((r) => r["event"] === "inbound_enqueue_recovered");
  assert.deepEqual(recovered, [{ event: "inbound_enqueue_recovered", after_failures: 1 }]);
  assert.equal(ingress.health.counters.consecutiveFailures, 0);
  assert.equal(ingress.health.counters.enqueued, 1);
});

test("the whole send ends at its deadline however many attempts are left", async () => {
  const { fleet, ingress } = make([["hang-ignoring-abort"]], { attempt: 5, deadline: 0.3 });
  const [reply, ms] = await timed(() => post(ingress, MESSAGE));
  assert.equal(reply.status, 500);
  assert.ok(ms < 1000, `took ${String(ms)} ms`);
  assert.deepEqual(fleet.started, [1], "no attempt is started once the deadline has passed");
});

test("the deadline counts from the request's arrival: a slow token check leaves the send only what is left", async () => {
  // A cold instance: the token check fetches the OpenID metadata and the signing keys first, and then every attempt on
  // the Service Bus fails. The 500 must still come inside the deadline from arrival, not the token check plus a deadline.
  const { fleet, ingress, log } = make([["hang"], ["hang"], ["hang"]], { attempt: 0.15, deadline: 0.6 });
  ingress.validate = () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({});
      }, 400);
    });
  const [reply, ms] = await timed(() => post(ingress, MESSAGE));
  assert.equal(reply.status, 500);
  assert.ok(ms >= 400, `took ${String(ms)} ms`);
  assert.ok(ms < 600 + 120, `took ${String(ms)} ms: the token check's 400 ms came out of the 600 ms deadline`);
  assert.deepEqual(fleet.started, [1, 1], "two attempts fit in the 200 ms left, not three");
  assert.deepEqual(fleet.queued, []);
  const failed = health(log).filter((r) => r["event"] === "inbound_enqueue_failed");
  assert.equal(failed.length, 1);
  assert.equal(nth(failed, 0)["attempts"], 2);
});

test("a token check that used the whole deadline is a 500 at once, with no send started", async () => {
  const { fleet, ingress, log } = make([["ok"]], { attempt: 0.15, deadline: 0.2 });
  ingress.validate = () =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({});
      }, 300);
    });
  const [reply, ms] = await timed(() => post(ingress, MESSAGE));
  assert.equal(reply.status, 500);
  assert.ok(ms < 300 + 100, `took ${String(ms)} ms`);
  assert.equal(fleet.clients.length, 0, "no client is opened for a send that cannot finish in time");
  assert.equal(fleet.queued.length, 0);
  const failed = health(log).filter((r) => r["event"] === "inbound_enqueue_failed");
  assert.deepEqual(
    failed.map((r) => [r["attempts"], r["error"]]),
    [[0, "TimeoutError"]],
  );
  // A send on its own (the delivery ack) has no request to count from: its deadline starts at the call.
  await ingress.sendInbound({ ...queueMessage(), messageId: "ack-1" }, undefined, "ack");
  assert.deepEqual(
    fleet.queued.map((q) => q.messageId),
    ["ack-1"],
  );
});

test("waiting for a start-up prefetch that never finishes is bounded by the deadline too", async () => {
  const { fleet, ingress, log } = make([["ok"]], { attempt: 0.15, deadline: 0.3 });
  ingress.prefetchWaitSeconds = 3;
  ingress.prefetch = new Promise<void>(() => undefined);
  const [reply, ms] = await timed(() => post(ingress, MESSAGE));
  assert.equal(reply.status, 500);
  assert.ok(ms < 300 + 150, `took ${String(ms)} ms: the 3 s prefetch wait was not cut to the deadline`);
  assert.deepEqual(fleet.started, [], "no send is started once the deadline has passed");
  assert.deepEqual(fleet.queued, []);
  assert.equal(health(log).filter((r) => r["event"] === "inbound_enqueue_failed").length, 1);
});

test("a card action that cannot be queued gets the unavailable card", async () => {
  const { ingress } = make([["hang"], ["hang"]], { attempt: 0.05, deadline: 0.4 });
  ingress.sendAttempts = 2;
  const reply = await post(ingress, { ...MESSAGE, type: "invoke", name: "adaptiveCard/action" });
  assert.equal(reply.status, 200);
  assert.match(JSON.stringify(json(reply)), /The agent is temporarily unavailable/);
});

// --- the start-up prefetch and a reset --------------------------------------------------------------------------------

test("a sender the prefetch opens on a client thrown away meanwhile is closed, not kept", async () => {
  const { fleet, ingress } = make([[linkClosed]], { attempt: 0.05, deadline: 0.5 });
  ingress.sendAttempts = 1;
  let release = (): void => undefined;
  const opened = new Promise<void>((resolve) => (release = resolve));
  const prefetching = prefetchWith(ingress, opened);
  // A message opens its own sender on the same client meanwhile; its send fails and throws the client away.
  assert.equal((await post(ingress, MESSAGE)).status, 500);
  assert.ok(nth(fleet.clients, 0).closed);
  release();
  await prefetching;
  assert.equal(ingress.inbound, null, "the prefetched sender belongs to a closed client");
  assert.ok(nth(nth(fleet.clients, 0).senders, 0).closed);
});

/** Run the prefetch with its open step held until `opened` settles. */
function prefetchWith(ingress: Ingress, opened: Promise<void>): Promise<void> {
  const newClient = ingress.newClient.bind(ingress);
  ingress.newClient = (log) => {
    const client = newClient(log);
    let first = true;
    return {
      close: () => client.close(),
      createSender: (queue) => {
        const sender = client.createSender(queue);
        if (!first) return sender;
        first = false;
        return { ...sender, createMessageBatch: () => opened.then(() => sender.createMessageBatch()) };
      },
    };
  };
  return ingress.prefetchSender();
}

/** A message for sendInbound itself, shaped like the activity the ingress queues. */
function queueMessage(): QueueMessage {
  return {
    body: Buffer.from(JSON.stringify(MESSAGE), "utf8"),
    contentType: "application/json",
    correlationId: "c1",
    sessionId: "s1",
    messageId: "m1",
  };
}
