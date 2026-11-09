// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The part of an Azure Service Bus client the worker uses, as an interface: the SDK's client satisfies it
 * (`azureBusClient`), and tests give a fake. Sessions: the inbound queue keeps each conversation's messages in order.
 */
import { ServiceBusClient, type ServiceBusReceivedMessage } from "@azure/service-bus";
import type { TokenCredential } from "@azure/core-auth";

export interface BusMessage {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface BusSender {
  send(message: BusMessage): Promise<void>;
  close(): Promise<void>;
}

/** A received message: its raw body and when the broker took it. */
export interface Received {
  readonly body: Uint8Array;
  readonly enqueuedAt: Date | undefined;
}

/** A receiver locked on one session: messages in order, settled one by one. */
export interface SessionReceiver {
  /** At most `count` messages, waiting at most `waitMs` for the first (none: the session has gone quiet). */
  receive(count: number, waitMs: number): Promise<Received[]>;
  complete(message: Received): Promise<void>;
  abandon(message: Received): Promise<void>;
  deadLetter(message: Received, reason: string, description: string): Promise<void>;
  close(): Promise<void>;
}

export interface BusClient {
  sender(queue: string): BusSender;
  /** The next session that has messages; rejects (a timeout) when none has any. */
  acceptNextSession(queue: string): Promise<SessionReceiver>;
  close(): Promise<void>;
}

/** How the worker reaches a namespace: a SAS connection string, or an Entra identity on the namespace's host name. */
export type BusConnection = string | { readonly namespace: string; readonly credential: TokenCredential };

function rawBody(message: ServiceBusReceivedMessage): Uint8Array {
  const body: unknown = message.body;
  if (body instanceof Uint8Array) return body;
  // (the SDK was told not to parse JSON, so a data section arrives as bytes; anything else is not what the ingress sends)
  return Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? null));
}

/** The SDK's client behind `BusClient`. Bodies are sent as one data section of bytes and read back unparsed. */
export function azureBusClient(connection: BusConnection, lockRenewalMs: number): BusClient {
  const client =
    typeof connection === "string"
      ? new ServiceBusClient(connection)
      : new ServiceBusClient(connection.namespace, connection.credential);
  return {
    sender(queue) {
      const sender = client.createSender(queue);
      return {
        send: (message) => sender.sendMessages({ body: Buffer.from(message.body), contentType: message.contentType }),
        close: () => sender.close(),
      };
    },
    async acceptNextSession(queue) {
      const receiver = await client.acceptNextSession(queue, {
        maxAutoLockRenewalDurationInMs: lockRenewalMs,
        skipParsingBodyAsJson: true,
      });
      const held = new Map<Received, ServiceBusReceivedMessage>();
      const sdk = (message: Received): ServiceBusReceivedMessage => {
        const found = held.get(message);
        if (!found) throw new Error("a message this receiver did not give");
        held.delete(message);
        return found;
      };
      return {
        async receive(count, waitMs) {
          const messages = await receiver.receiveMessages(count, { maxWaitTimeInMs: waitMs });
          return messages.map((m) => {
            const received: Received = { body: rawBody(m), enqueuedAt: m.enqueuedTimeUtc };
            held.set(received, m);
            return received;
          });
        },
        complete: (message) => receiver.completeMessage(sdk(message)),
        abandon: (message) => receiver.abandonMessage(sdk(message)),
        deadLetter: (message, reason, description) =>
          receiver.deadLetterMessage(sdk(message), {
            deadLetterReason: reason,
            deadLetterErrorDescription: description,
          }),
        close: () => receiver.close(),
      };
    },
    close: () => client.close(),
  };
}
