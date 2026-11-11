// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The inbound queue as the ingress sees it: the message it sends, and the parts of the Service Bus SDK it uses. */
import { createHash } from "node:crypto";

import { pyLen, utf8 } from "./py.js";

/** A message for the inbound queue: the fields the Python Function set on its ServiceBusMessage. */
export interface QueueMessage {
  /** UTF-8 JSON. A Buffer, so the SDK sends it as it is (a string would be JSON-encoded a second time). */
  body: Buffer;
  contentType: "application/json";
  correlationId: string;
  sessionId: string;
  messageId: string;
}

/** The part of a ServiceBusSender the ingress uses. */
export interface QueueSender {
  sendMessages(message: QueueMessage): Promise<void>;
  /** Opens the connection and the link (and so takes the token) without sending. */
  createMessageBatch(): Promise<unknown>;
  close(): Promise<void>;
}

/** The part of a ServiceBusClient the ingress uses. */
export interface QueueClient {
  createSender(queue: string): QueueSender;
}

/** How the inbound client is built; src/servicebus.ts has the real one, tests record what is asked. */
export interface ServiceBusFactory {
  /** An identity-based client; `clientId` null means the app's system-assigned identity. */
  fromIdentity(namespace: string, clientId: string | null): QueueClient;
  fromConnectionString(connectionString: string): QueueClient;
}

// Service Bus rejects broker properties longer than this in the client, before anything is sent. Teams conversation
// ids routinely exceed it -- a 1:1 chat id is an "a:" token of 130-160 characters -- while Web Chat ids are short.
const MAX_BROKER_ID_LENGTH = 128;

/**
 * Fit an id into the broker's length limit without losing its identity. The digest has to be stable across instances
 * and restarts, because session ordering depends on one conversation always mapping to one session id. The worker
 * reads the real ids back out of the activity body, so shortening these costs nothing downstream.
 */
export function boundedId(value: string): string {
  // Python counts characters and the JavaScript SDK counts UTF-16 units, so an id of astral characters can fit the one
  // and not the other. Such an id is hashed too: the SDK would refuse it at every send.
  if (pyLen(value) <= MAX_BROKER_ID_LENGTH && value.length <= MAX_BROKER_ID_LENGTH) return value;
  return `h:${createHash("sha256").update(utf8(value)).digest("hex")}`;
}
