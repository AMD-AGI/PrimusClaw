// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A fake Service Bus client: senders that record, and sessions the test lines up. */
import type { BusClient, BusMessage, BusSender, Received, SessionReceiver } from "../../src/servicebus/client.js";

export class FakeSender implements BusSender {
  readonly sent: BusMessage[] = [];
  closed = false;
  constructor(private readonly closeFails = false) {}
  send(message: BusMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closeFails ? Promise.reject(new Error("the connection is already gone")) : Promise.resolve();
  }
}

export class FakeReceiver implements SessionReceiver {
  readonly done: Array<readonly [string, Received]> = [];
  closed = false;
  constructor(private readonly batches: Received[][] = []) {}
  receive(): Promise<Received[]> {
    return Promise.resolve(this.batches.shift() ?? []);
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
    this.closed = true;
    return Promise.resolve();
  }
}

export class FakeBus implements BusClient {
  readonly senders: FakeSender[] = [];
  /** What each acceptNextSession gives, in order: a receiver, or an error to throw. */
  sessions: Array<FakeReceiver | Error> = [];
  constructor(private readonly closeFails = false) {}
  sender(): BusSender {
    const sender = new FakeSender(this.closeFails);
    this.senders.push(sender);
    return sender;
  }
  acceptNextSession(): Promise<SessionReceiver> {
    const next = this.sessions.shift() ?? Object.assign(new Error("no session"), { code: "ServiceTimeout" });
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export function received(
  body: string | Uint8Array,
  enqueuedAt?: Date,
  messageId?: string,
  deliveryCount?: number,
): Received {
  return { body: typeof body === "string" ? Buffer.from(body) : body, enqueuedAt, messageId, deliveryCount };
}
