// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Child process of test/transport.test.ts: sends one queue message through the real client the ingress uses
 * (src/servicebus.ts: @azure/service-bus over AMQP on Node's built-in WebSocket) to the connection string in
 * argv[2], the way the Function sends one: open the sender (createMessageBatch), send, close.
 *
 * The SDK always dials wss://; the local broker has no certificate, so the built-in WebSocket is subclassed to dial
 * ws:// instead. Everything else -- the WebSocket implementation, rhea on top of it, the SDK's encoding -- is the
 * production path.
 */
const Native = globalThis.WebSocket;
class PlainWebSocket extends Native {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(String(url).replace(/^wss:/, "ws:"), protocols);
  }
}
globalThis.WebSocket = PlainWebSocket;
const { SERVICE_BUS } = await import("../../src/servicebus.js");

const [connectionString, queue, body] = process.argv.slice(2) as [string, string, string];
const sender = SERVICE_BUS.fromConnectionString(connectionString).createSender(queue);
await sender.createMessageBatch();
await sender.sendMessages({
  body: Buffer.from(body, "utf8"),
  contentType: "application/json",
  correlationId: "corr-1",
  sessionId: "19:abc@thread.v2",
  messageId: "a1",
});
await sender.close();
process.exit(0);
