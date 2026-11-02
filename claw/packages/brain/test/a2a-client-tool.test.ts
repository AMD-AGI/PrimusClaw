// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * a2a_call as the model and the engine see it: the published schema, and a call routed with
 * the run's context against a real identity token endpoint (the real RFC 8693 client, not a
 * stand-in) and a real peer. The token the peer receives is the one identity issued for the
 * session's owner, and is nowhere in what the tool returns.
 */
import "./a2a-client-env.js";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { initA2ARegistry } from "../src/clients/a2a.js";
import { ToolRouter } from "../src/tools/router.js";
import { SIGTERM_ABORT_REASON } from "../src/tasks/abort-registry.js";
import { startIdentityClient } from "../src/clients/identity.js";

// ── The published surface ───────────────────────────────────────────────────

test("a2a_call's schema: what it takes, what it requires, and no URL", () => {
  const schema = new ToolRouter(null).getToolSchemas().find((t) => t.name === "a2a_call");
  assert.ok(schema, "offered while the switch is on");
  const input = schema.input_schema as {
    properties: Record<string, { enum?: string[]; properties?: Record<string, unknown>; description?: string }>;
    required: string[];
  };
  assert.deepEqual(Object.keys(input.properties).sort(), ["agent", "approval", "context_id", "message", "metadata", "mode", "task_id"]);
  assert.deepEqual(input.required, ["agent"], "get, cancel and discover need no message");
  assert.deepEqual(input.properties.mode.enum, ["stream", "fire_and_forget", "discover", "get", "cancel"]);
  assert.deepEqual(Object.keys(input.properties.approval.properties ?? {}).sort(), ["action_id", "decision"]);
  assert.doesNotMatch(input.properties.agent.description ?? "", /full URL/);
  assert.match(schema.description, /state=input_required/);
});

// ── A real identity token endpoint, and a peer ──────────────────────────────

interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
const idHits: Hit[] = [];
const peerHits: Hit[] = [];
let idServer: http.Server, peerServer: http.Server;
let idUrl = "", peerUrl = "";
let refuse = false;
let minted = 0;

function listen(handler: http.RequestListener): Promise<http.Server> {
  const s = http.createServer(handler);
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}
const collect = (hits: Hit[], then: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): http.RequestListener =>
  (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      then(req, res, body);
    });
  };

before(async () => {
  idServer = await listen(collect(idHits, (req, res, body) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") {
      if (refuse) { res.writeHead(400); return res.end(JSON.stringify({ error: "invalid_grant" })); }
      minted++;
      return res.end(JSON.stringify({ access_token: `issued-for-owner-${minted}`, token_type: "Bearer", expires_in: 300 }));
    }
    res.writeHead(404); res.end("{}");
  }));
  idUrl = `http://127.0.0.1:${(idServer.address() as AddressInfo).port}`;
  peerServer = await listen(collect(peerHits, (req, res, body) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      return res.end(JSON.stringify({
        name: "claw2", description: "", version: "1", capabilities: { streaming: true }, skills: [],
        supportedInterfaces: [{ url: `${peerUrl}/a2a/plugins/7`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      }));
    }
    const rpc = JSON.parse(body || "{}") as { method?: string };
    if (rpc.method === "SendStreamingMessage") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { task: { id: "t-w", contextId: "c-w", status: { state: "TASK_STATE_WORKING" } } } })}\n\n`);
      return; // and stays open
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { id: "t-w", contextId: "c-w", status: { state: "TASK_STATE_CANCELED" } } }));
  }));
  peerUrl = `http://127.0.0.1:${(peerServer.address() as AddressInfo).port}`;
});

after(async () => {
  for (const s of [idServer, peerServer]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  initA2ARegistry("");
});

function useIdentity(): void {
  Object.assign(process.env, {
    IDENTITY_CLIENT_ENABLED: "true",
    IDENTITY_ISSUER_URL: idUrl,
    IDENTITY_CLIENT_ID: "claw-brain",
    IDENTITY_CLIENT_SECRET: "brain-secret-sentinel",
    IDENTITY_TOKEN_URL: `${idUrl}/token`,
  });
  // The process-wide client the router's a2a path reads, built the way Brain builds it.
  assert.ok(startIdentityClient({ error() {}, warn() {}, info() {} } as never));
}

const registry = () => initA2ARegistry(JSON.stringify([
  { name: "claw2", card_url: `${peerUrl}/.well-known/agent-card.json`, audience: "claw-api", scope: "claw.api", allow_local: true },
]));
const form = (hit: Hit) => Object.fromEntries(new URLSearchParams(hit.body));

test("the run's owner is the subject of the exchange; the peer gets the issued token; the model gets neither", async () => {
  useIdentity();
  registry();
  const router = new ToolRouter(null);
  router.a2aContext = { userId: "owner-7", sessionId: "sess-1" };
  const outcome = { isError: false };
  const out = await router.route("a2a_call", { agent: "claw2", message: "hi", mode: "fire_and_forget" }, undefined, outcome);

  const exchange = idHits.find((h) => h.url === "/token")!;
  assert.ok(exchange, "identity was asked");
  assert.deepEqual(form(exchange), {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: "user_id:owner-7",
    subject_token_type: "urn:primus:params:oauth:token-type:user-ref",
    audience: "claw-api",
    scope: "claw.api",
  });
  assert.match(exchange.headers.authorization ?? "", /^Basic /, "as the service client, not as the user");

  const sentToPeer = peerHits.map((h) => h.headers.authorization);
  assert.ok(sentToPeer.length >= 2 && sentToPeer.every((a) => a === "Bearer issued-for-owner-1"), JSON.stringify(sentToPeer));
  assert.equal(peerHits.find((h) => h.method === "POST")!.url, "/a2a/plugins/7", "the card's endpoint");
  assert.ok(!out.includes("issued-for-owner"), "the token is not in the tool result");
  assert.ok(!out.includes("brain-secret-sentinel"));
  assert.equal(outcome.isError, false);
  for (const h of peerHits) assert.ok(!h.body.includes("issued-for-owner"), "nor in anything sent to the peer");
});

test("a sub-agent's router acts for the same user", async () => {
  registry();
  const parent = new ToolRouter(null);
  parent.a2aContext = { userId: "owner-8" };
  const child = new ToolRouter(null);
  parent.registerChild(child);
  idHits.length = 0;
  await child.route("a2a_call", { agent: "claw2", mode: "discover" });
  assert.equal(form(idHits.find((h) => h.url === "/token")!).subject_token, "user_id:owner-8");
});

test("a revoked binding stops the call with a message the model can act on, and nothing reaches the peer", async () => {
  registry();
  refuse = true;
  try {
    const router = new ToolRouter(null);
    router.a2aContext = { userId: "owner-revoked" };
    peerHits.length = 0;
    const outcome = { isError: false };
    const out = await router.route("a2a_call", { agent: "claw2", message: "hi" }, undefined, outcome);
    assert.match(out, /primus-identity refused to issue a token for this user.*invalid_grant/);
    assert.equal(outcome.isError, true);
    assert.equal(peerHits.length, 0);
  } finally {
    refuse = false;
  }
});

test("Stop through the router cancels the peer's task; a restart abort does not", async () => {
  registry();
  const run = async (reason: unknown) => {
    const router = new ToolRouter(null);
    router.a2aContext = { userId: "owner-9" };
    peerHits.length = 0;
    const stop = new AbortController();
    setTimeout(() => stop.abort(reason), 250);
    const out = JSON.parse(await router.route("a2a_call", { agent: "claw2", message: "slow" }, stop.signal));
    const methods = peerHits.filter((h) => h.method === "POST").map((h) => (JSON.parse(h.body) as { method: string }).method);
    return { out, methods };
  };
  const stopped = await run(undefined);
  assert.deepEqual(stopped.methods, ["SendStreamingMessage", "CancelTask"]);
  assert.equal(stopped.out.state, "canceled");

  const restarted = await run(SIGTERM_ABORT_REASON);
  assert.deepEqual(restarted.methods, ["SendStreamingMessage"]);
  assert.equal(restarted.out.task_id, "t-w");
});
