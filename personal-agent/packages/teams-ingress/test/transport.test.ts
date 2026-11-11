// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Not a port: the Python sender's transport (AMQP over WebSockets) is here the Azure SDK given Node's built-in
 * WebSocket. This runs that real client against a local AMQP broker (rhea) behind a WebSocket server (no TLS: see
 * test/fixtures/send-once.ts) and checks what arrives: the WebSocket subprotocol and path Service Bus expects, the claims
 * exchange, and the message itself -- its body a single AMQP data section holding exactly the JSON bytes (a string
 * body would have been JSON-encoded a second time), and the properties the worker reads.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

import type * as Rhea from "rhea";
import { WebSocketServer } from "ws";

import { defined, HERE } from "./helpers.js";

// rhea is a CommonJS module whose export is a Container instance: its functions are no named exports.
const rhea = createRequire(import.meta.url)("rhea") as typeof Rhea;

interface Received {
  path: string;
  protocol: string;
  cbs: Record<string, unknown>[];
  messages: { address: string; message: Rhea.Message }[];
}

/** A broker that answers every claims request with 202 and keeps every message sent to a queue. */
function broker(container: Rhea.Container, received: Received): void {
  container.on("message", (context: Rhea.EventContext) => {
    const address = context.receiver?.target.address ?? "";
    const message = defined(context.message);
    if (address === "$cbs") {
      received.cbs.push(message.application_properties ?? {});
      const reply = context.connection.find_sender((s: Rhea.Sender) => s.source.address === "$cbs");
      // A claims answer carries no body (rhea's typings require one).
      const answer = {
        application_properties: { "status-code": 202, "status-description": "Accepted" },
      } as unknown as Rhea.Message;
      if (message.message_id !== undefined) answer.correlation_id = message.message_id;
      if (message.reply_to !== undefined) answer.to = message.reply_to;
      reply?.send(answer);
      return;
    }
    received.messages.push({ address, message });
  });
  container.on("disconnected", () => undefined); // the client closing its socket, which ends every case
  container.on("error", () => undefined);
  container.on("sender_open", (context: Rhea.EventContext) => {
    // a link the client receives on: its source is what it asked for (rhea's typings omit `remote`)
    const sender = context.sender as
      (Rhea.Sender & { remote: { attach: { source?: { address?: string } } } }) | undefined;
    const address = sender?.remote.attach.source?.address;
    sender?.set_source({ address } as Rhea.Source);
  });
}

test("the Service Bus client sends over AMQP on Node's built-in WebSocket, the body as one data section", async () => {
  const container = rhea.create_container({ id: "broker" });
  const received: Received = { path: "", protocol: "", cbs: [], messages: [] };
  broker(container, received);
  const http = createServer();
  const wss = new WebSocketServer({
    server: http,
    handleProtocols: (protocols) => (protocols.has("AMQPWSB10") ? "AMQPWSB10" : false),
  });
  wss.on("connection", (socket, request) => {
    received.path = request.url ?? "";
    received.protocol = socket.protocol;
    container.websocket_accept(socket as never, {});
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  const body = '{"type": "message", "text": "h\\u00e9llo"}';
  try {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(HERE, "fixtures", "send-once.ts"),
        `Endpoint=sb://127.0.0.1:${String(port)}/;SharedAccessKeyName=send;SharedAccessKey=not-a-real-key`,
        "inbound",
        body,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
  } finally {
    wss.close();
    http.close();
  }
  assert.equal(received.path, "/$servicebus/websocket");
  assert.equal(received.protocol, "AMQPWSB10");
  assert.ok(
    received.cbs.some((p) => p.operation === "put-token"),
    "the client did not ask for its claims",
  );
  assert.equal(received.messages.length, 1);
  const [{ address, message }] = received.messages as [{ address: string; message: Rhea.Message }];
  assert.equal(address, "inbound");
  const section = message.body as { typecode: number; content: Buffer };
  assert.equal(section.typecode, 0x75); // an AMQP data section
  assert.equal(Buffer.from(section.content).toString("utf8"), body);
  assert.equal(message.content_type, "application/json");
  assert.equal(message.correlation_id, "corr-1");
  assert.equal(message.group_id, "19:abc@thread.v2"); // the session id
  assert.equal(message.message_id, "a1");
  assert.equal(message.application_properties, undefined);
});

test("an identity-based client is built for the system-assigned and for a user-assigned identity", async () => {
  const { SERVICE_BUS } = await import("../src/servicebus.js");
  // Building the client reaches nothing: the credential is asked for a token when the first link opens.
  for (const clientId of [null, "00000000-0000-0000-0000-0000000000b2"]) {
    const sender = SERVICE_BUS.fromIdentity("example-bus.servicebus.windows.net", clientId).createSender("inbound");
    await sender.close();
  }
});
