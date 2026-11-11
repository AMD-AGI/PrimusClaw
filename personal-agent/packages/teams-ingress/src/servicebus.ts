// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The real inbound Service Bus client: @azure/service-bus with @azure/identity, over AMQP on WebSockets.
 *
 * The Python sender used `TransportType.AmqpOverWebsocket` (port 443). Here the same transport is `webSocketOptions.webSocket`, given Node's built-in WebSocket (global since Node 22), so no
 * WebSocket package is needed. The retry policy is the Python client's default: three retries, exponential backoff
 * from 0.8 s up to 120 s.
 */
import { ManagedIdentityCredential } from "@azure/identity";
import { RetryMode, ServiceBusClient, type ServiceBusClientOptions } from "@azure/service-bus";

import { type QueueClient, type QueueMessage, type QueueSender, type ServiceBusFactory } from "./queue.js";

export const CLIENT_OPTIONS: ServiceBusClientOptions = {
  webSocketOptions: { webSocket: globalThis.WebSocket },
  retryOptions: { maxRetries: 3, retryDelayInMs: 800, maxRetryDelayInMs: 120_000, mode: RetryMode.Exponential },
};

function wrap(client: ServiceBusClient): QueueClient {
  return {
    createSender(queue: string): QueueSender {
      const sender = client.createSender(queue);
      return {
        sendMessages: (message: QueueMessage) => sender.sendMessages({ ...message }),
        createMessageBatch: () => sender.createMessageBatch(),
        close: () => sender.close(),
      };
    },
  };
}

export const SERVICE_BUS: ServiceBusFactory = {
  fromIdentity(namespace, clientId) {
    // No client id: the app's system-assigned identity.
    const credential = clientId ? new ManagedIdentityCredential({ clientId }) : new ManagedIdentityCredential();
    return wrap(new ServiceBusClient(namespace, credential, CLIENT_OPTIONS));
  },
  fromConnectionString(connectionString) {
    return wrap(new ServiceBusClient(connectionString, CLIENT_OPTIONS));
  },
};
