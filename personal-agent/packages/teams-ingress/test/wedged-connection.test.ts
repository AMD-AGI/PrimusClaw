// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Not a port: the production failure end to end, with the real SDK. A local AMQP broker (rhea, behind a WebSocket
 * server, as in test/transport.test.ts) takes the first message, then stops reading the connection it came on: the
 * socket stays open and nothing is answered, which is what a connection the SDK can neither use nor finish closing
 * looks like from the client. Every sender opened on that client waits on it. The ingress (test/fixtures/
 * wedged-connection.ts, the real Ingress on the real client) must give the send up after one attempt and get the next
 * message through on a new connection, well before the Bot Framework stops waiting.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

import type * as Rhea from "rhea";
import { type WebSocket, WebSocketServer } from "ws";

import { defined, HERE } from "./helpers.js";

const rhea = createRequire(import.meta.url)("rhea") as typeof Rhea;

interface Seen {
  /** The message ids the broker took, with the connection (in accept order) each came on. */
  messages: { connection: number; id: string }[];
}

/** A broker that answers the claims exchange and records messages; `wedge` is called with each message's connection. */
function broker(
  seen: Seen,
  wedge: (connection: number) => void,
): { container: Rhea.Container; index: Map<unknown, number> } {
  const container = rhea.create_container({ id: "broker" });
  const index = new Map<unknown, number>();
  container.on("message", (context: Rhea.EventContext) => {
    const address = context.receiver?.target.address ?? "";
    const message = defined(context.message);
    if (address === "$cbs") {
      const reply = context.connection.find_sender((s: Rhea.Sender) => s.source.address === "$cbs");
      const answer = {
        application_properties: { "status-code": 202, "status-description": "Accepted" },
      } as unknown as Rhea.Message;
      if (message.message_id !== undefined) answer.correlation_id = message.message_id;
      if (message.reply_to !== undefined) answer.to = message.reply_to;
      reply?.send(answer);
      return;
    }
    const connection = index.get(context.connection) ?? -1;
    seen.messages.push({ connection, id: String(message.message_id) });
    wedge(connection);
  });
  container.on("connection_open", (context: Rhea.EventContext) => {
    index.set(context.connection, index.size);
  });
  container.on("disconnected", () => undefined);
  container.on("error", () => undefined);
  container.on("sender_open", (context: Rhea.EventContext) => {
    const sender = context.sender as
      (Rhea.Sender & { remote: { attach: { source?: { address?: string } } } }) | undefined;
    sender?.set_source({ address: sender.remote.attach.source?.address } as Rhea.Source);
  });
  return { container, index };
}

interface ChildReport {
  replies: { id: string; status: number; ms: number }[];
  health: Record<string, unknown>[];
  counters: Record<string, number>;
}

async function run(ids: string[]): Promise<{ seen: Seen; report: ChildReport; sockets: number }> {
  const seen: Seen = { messages: [] };
  const sockets: WebSocket[] = [];
  // The first connection stops being read once it has delivered a message: the client's next frames go unanswered.
  const { container } = broker(seen, (connection) => {
    if (connection === 0) sockets[0]?.pause();
  });
  const http = createServer();
  const wss = new WebSocketServer({
    server: http,
    handleProtocols: (protocols) => (protocols.has("AMQPWSB10") ? "AMQPWSB10" : false),
  });
  wss.on("connection", (socket) => {
    sockets.push(socket);
    container.websocket_accept(socket as never, {});
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  let out = "";
  try {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(HERE, "fixtures", "wedged-connection.ts"),
        `Endpoint=sb://127.0.0.1:${String(port)}/;SharedAccessKeyName=send;SharedAccessKey=not-a-real-key`,
        ids.join(","),
        "1",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0);
  } finally {
    for (const socket of sockets) socket.terminate();
    wss.close();
    http.close();
  }
  return { seen, report: JSON.parse(out) as ChildReport, sockets: sockets.length };
}

test(
  "a message on a wedged connection goes through on a new client within one attempt timeout",
  { timeout: 60_000 },
  async () => {
    const { seen, report, sockets } = await run(["w1", "w2", "w3"]);
    assert.deepEqual(
      report.replies.map((r) => [r.id, r.status]),
      [
        ["w1", 200],
        ["w2", 200],
        ["w3", 200],
      ],
    );
    // w2 waited one attempt (1 s here) on the wedged connection, then went through on a new one, far inside 15 s.
    const w2 = defined(report.replies[1]);
    assert.ok(w2.ms >= 900 && w2.ms < 5000, `w2 took ${String(w2.ms)} ms`);
    assert.equal(sockets, 2, "one new connection, and it is kept for w3");
    // Each message reached the broker once: w1 on the first connection, w2 and w3 on the second.
    assert.deepEqual(seen.messages, [
      { connection: 0, id: "w1" },
      { connection: 1, id: "w2" },
      { connection: 1, id: "w3" },
    ]);
    assert.deepEqual(report.health, [
      { event: "inbound_client_reset", attempt: 1, error: "TimeoutError", code: null, client_resets: 1 },
    ]);
    assert.equal(report.counters["enqueued"], 3);
    assert.equal(report.counters["enqueueFailures"], 0);
  },
);
