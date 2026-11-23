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

/** A received message: its raw body, when the broker took it, and the broker's id and delivery count for the log line. */
export interface Received {
  readonly body: Uint8Array;
  readonly enqueuedAt: Date | undefined;
  /** The message's id as the sender set it (a string or number id; none for any other kind). */
  readonly messageId?: string | undefined;
  /** How many times the broker has delivered it, this time included. */
  readonly deliveryCount?: number | undefined;
}

/** The SDK's message id as text, when it is a string or a number (a byte id is not written to a log line). */
function messageIdOf(message: ServiceBusReceivedMessage): string | undefined {
  const id: unknown = message.messageId;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

/** A receiver locked on one session: messages in order, settled one by one. */
export interface SessionReceiver {
  /**
   * At most `count` messages, waiting at most `waitMs` for the first (none: the session has gone quiet). With `signal`,
   * the wait ends (rejects) when it is aborted.
   */
  receive(count: number, waitMs: number, signal?: AbortSignal): Promise<Received[]>;
  complete(message: Received): Promise<void>;
  abandon(message: Received): Promise<void>;
  deadLetter(message: Received, reason: string, description: string): Promise<void>;
  close(): Promise<void>;
}

export interface BusClient {
  sender(queue: string): BusSender;
  /** The next session that has messages; rejects (a timeout) when none has any, or when `signal` is aborted. */
  acceptNextSession(queue: string, signal?: AbortSignal): Promise<SessionReceiver>;
  /**
   * Open a new connection for what is asked next (the receivers' re-arm, when a call on the old one hangs). The old one
   * is left open, since other receivers on it may still be handling a message whose session lock it holds: closing it
   * then would drop their locks and the broker would hand the message to someone else while it is still being handled.
   * Returns the old connection's close, for the caller to run once nothing it took on the old connection is in hand.
   * Optional: a client without it is only asked again.
   */
  reopen?(): () => Promise<void>;
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
  const open = (): ServiceBusClient =>
    typeof connection === "string"
      ? new ServiceBusClient(connection)
      : new ServiceBusClient(connection.namespace, connection.credential);
  let client = open();
  return {
    sender(queue) {
      const sender = client.createSender(queue);
      return {
        send: (message) => sender.sendMessages({ body: Buffer.from(message.body), contentType: message.contentType }),
        close: () => sender.close(),
      };
    },
    async acceptNextSession(queue, signal) {
      const receiver = await client.acceptNextSession(queue, {
        maxAutoLockRenewalDurationInMs: lockRenewalMs,
        skipParsingBodyAsJson: true,
        ...(signal ? { abortSignal: signal } : {}),
      });
      const held = new Map<Received, ServiceBusReceivedMessage>();
      const sdk = (message: Received): ServiceBusReceivedMessage => {
        const found = held.get(message);
        if (!found) throw new Error("a message this receiver did not give");
        held.delete(message);
        return found;
      };
      return {
        async receive(count, waitMs, signal) {
          const messages = await receiver.receiveMessages(count, {
            maxWaitTimeInMs: waitMs,
            ...(signal ? { abortSignal: signal } : {}),
          });
          return messages.map((m) => {
            const received: Received = {
              body: rawBody(m),
              enqueuedAt: m.enqueuedTimeUtc,
              messageId: messageIdOf(m),
              deliveryCount: m.deliveryCount,
            };
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
    reopen() {
      const old = client;
      client = open();
      return () => old.close();
    },
    close: () => client.close(),
  };
}
