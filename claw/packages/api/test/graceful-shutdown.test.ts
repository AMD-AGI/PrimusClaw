// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An API pod leaves a rolling update without taking requests with it.
 *
 * The process used to exit the instant SIGTERM arrived: every request in
 * flight, every SSE stream and every internal MCP call on the pod was reset.
 * These run a real Fastify server on a real socket, with the hooks index.ts
 * installs, and send it what the kubelet sends.
 *
 *   G1 a request in flight when the drain starts is answered, then the process exits 0
 *   G2 an event stream is told to reconnect (SSE retry:) and ended, so close does not hang
 *   G3 while draining, /ready is 503, /health stays 200, and responses ask for a new connection
 *   G4 nothing that never finishes holds the exit past the deadline
 *   G5 the session event stream resumes from Last-Event-ID
 *   G6 an MCP call in flight when the drain starts gets its answer, though streamable HTTP sends it as an event stream, and the
 *      pools close only after it (2026-11-07 07:14Z: the drain ended that stream first, the review it started was handed over,
 *      and the router waited 60 s for an answer that never came)
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { GracefulShutdown, SSE_RECONNECT_FRAME, answersOneCall } from "../src/infra/graceful-shutdown.js";
import { lastEventIdOf } from "../src/routes/events.js";

interface Rig {
  app: FastifyInstance;
  shutdown: GracefulShutdown;
  base: string;
  exits: number[];
  steps: string[];
  release: () => void;
  /** Calls the MCP tool has begun. */
  entered: () => number;
}

const quiet = { info: () => {}, warn: () => {} };

// Whatever a failing case leaves open must not keep the file's process alive.
const servers: http.Server[] = [];
after(() => {
  for (const s of servers) { s.closeAllConnections(); s.close(); }
});

async function rig(opts: { deadlineMs?: number; delayMs?: number } = {}): Promise<Rig> {
  const app = Fastify();
  const exits: number[] = [];
  const steps: string[] = [];
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const shutdown = new GracefulShutdown({
    logger: quiet,
    deadlineMs: opts.deadlineMs ?? 10_000,
    delayMs: opts.delayMs ?? 0,
    closeServer: () => app.close(),
    steps: [
      { name: "nats", run: async () => { steps.push("nats"); } },
      { name: "db", run: async () => { steps.push("db"); } },
    ],
    exit: (code) => { exits.push(code); },
  });
  // As index.ts wires it.
  app.addHook("onRequest", async (_req, reply) => { shutdown.watchResponse(reply.raw); });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_req, reply) => (shutdown.draining ? reply.status(503).send({ status: "draining" }) : { status: "ok" }));
  app.get("/slow", async () => { await gate; return { done: true }; });
  // The shape routes/events.ts uses: hijacked, its own head, a stream that never ends by itself.
  app.get("/stream", async (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
    reply.raw.write("id: claw-1\nevent: x\ndata: {}\n\n");
  });
  // The shape of the assistant's MCP route (`assistant/mcp.ts`): stateless, one server and transport per request, a tool that
  // waits on the gate as review_start waits on GitHub and the database.
  app.all("/mcp", async (req, reply) => {
    const mcp = new McpServer({ name: "assistant", version: "1.0.0" });
    mcp.tool("review_start", "hands a review over", async () => {
      entered++;
      await gate;
      steps.push("answered");
      return { content: [{ type: "text", text: "handed_off" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as never });
    await mcp.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  servers.push(app.server);
  const { port } = app.server.address() as AddressInfo;
  return { app, shutdown, base: `http://127.0.0.1:${port}`, exits, steps, release, entered: () => entered };
}

function get(url: string, agent: http.Agent | false = false): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, { agent }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("G1 a request in flight when the drain starts is answered, then the process exits 0", { timeout: 30_000 }, async () => {
  const r = await rig();
  const inflight = get(`${r.base}/slow`);
  await new Promise((res) => setTimeout(res, 50));
  const done = r.shutdown.begin("SIGTERM");
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(r.exits, [], "still waiting on the request");
  await assert.rejects(get(`${r.base}/health`), "a new connection is not accepted any more");
  r.release();
  const resp = await inflight;
  assert.equal(resp.status, 200);
  assert.deepEqual(JSON.parse(resp.body), { done: true });
  await done;
  assert.deepEqual(r.steps, ["nats", "db"], "consumers and pools close after the server, in order");
  assert.deepEqual(r.exits, [0]);
});

test("G2 an event stream is told to reconnect and ended, so the drain does not hang", { timeout: 30_000 }, async () => {
  const r = await rig();
  let received = "";
  let ended = false;
  await new Promise<void>((resolve, reject) => {
    http.get(`${r.base}/stream`, { agent: false }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => { received += c; if (received.includes("claw-1")) resolve(); });
      res.on("end", () => { ended = true; });
    }).on("error", reject);
  });
  assert.equal(r.shutdown.openStreams, 1);
  await r.shutdown.begin("SIGTERM");
  await until(() => ended);
  assert.ok(received.endsWith(SSE_RECONNECT_FRAME), `the last frame tells the client to reconnect: ${JSON.stringify(received)}`);
  assert.deepEqual(r.exits, [0], "and the drain finished without waiting for the deadline");
});

test("G3 while draining, /ready is 503, /health stays 200, and responses ask for a new connection", { timeout: 30_000 }, async () => {
  const r = await rig({ delayMs: 300 });
  // A client that keeps its connections, as brain's undici pool and a proxy do.
  const keepAlive = new http.Agent({ keepAlive: true });
  const before = await get(`${r.base}/ready`, keepAlive);
  assert.equal(before.status, 200);
  assert.equal(before.headers.connection, "keep-alive", "serving: the connection is kept");
  const done = r.shutdown.begin("SIGTERM");
  const ready = await get(`${r.base}/ready`, keepAlive);
  const health = await get(`${r.base}/health`, keepAlive);
  keepAlive.destroy();
  assert.equal(ready.status, 503, "out of rotation");
  assert.equal(health.status, 200, "but alive: liveness must not restart a pod finishing its work");
  assert.equal(health.headers.connection, "close", "keep-alive clients reconnect elsewhere");
  await done;
});

test("G4 nothing that never finishes holds the exit past the deadline", { timeout: 30_000 }, async () => {
  const r = await rig({ deadlineMs: 300 });
  const hung = get(`${r.base}/slow`).catch(() => null);
  await new Promise((res) => setTimeout(res, 50));
  void r.shutdown.begin("SIGTERM");
  await until(() => r.exits.length > 0, 3_000);
  // Whichever of the deadline and the bounded server close notices first.
  await new Promise((res) => setTimeout(res, 200));
  assert.deepEqual(r.exits, [1], "a forced exit is reported as one, and only once");
  r.release();
  await hung;
});

test("G5 the session event stream resumes from Last-Event-ID", () => {
  assert.equal(lastEventIdOf("claw-12345"), "claw-12345");
  assert.equal(lastEventIdOf(["claw-7", "claw-8"]), "claw-7");
  assert.equal(lastEventIdOf(undefined), null);
  assert.equal(lastEventIdOf("x'; DROP TABLE"), null, "only ids this stream hands out");
});

test("G6 an MCP call in flight when the drain starts gets its answer, and the pools close after it", { timeout: 30_000 }, async () => {
  const r = await rig();
  const client = new Client({ name: "brain", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${r.base}/mcp`)));
  // Shorter than the SDK's 60 s, so a lost answer fails the case instead of hanging it.
  const call = client.callTool({ name: "review_start", arguments: {} }, undefined, { timeout: 5_000 });
  await until(() => r.entered() === 1);
  const done = r.shutdown.begin("SIGTERM");
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(r.steps, [], "the pools wait for the call");
  r.release();
  const result = await call;
  assert.deepEqual(result.content, [{ type: "text", text: "handed_off" }], "the caller hears what the tool did");
  await done;
  assert.deepEqual(r.steps, ["answered", "nats", "db"]);
  assert.deepEqual(r.exits, [0]);
  await client.close().catch(() => undefined);
});

test("G7 what counts as one call's answer: a POST that accepts JSON and an event stream, as the MCP specification has it", () => {
  const res = (method: string, accept?: string) => ({ req: { method, headers: accept === undefined ? {} : { accept } } }) as never;
  assert.equal(answersOneCall(res("POST", "application/json, text/event-stream")), true, "MCP streamable HTTP");
  assert.equal(answersOneCall(res("GET", "application/json, text/event-stream")), false, "a GET stream is a subscription");
  assert.equal(answersOneCall(res("POST", "text/event-stream")), false, "A2A message/stream has no end of its own");
  assert.equal(answersOneCall(res("POST")), false);
  assert.equal(answersOneCall({} as never), false, "a response without its request");
});
