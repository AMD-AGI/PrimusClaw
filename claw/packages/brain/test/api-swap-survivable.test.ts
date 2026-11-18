// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// An API pod swap is something brain's calls ride out, not something they report.
//
// During an API rolling update a call can find the old pod refusing
// connections, have its keep-alive socket reset mid-request, or get a 502/503/504
// from whatever fronts the Service. None of these is about the request. The
// calls that go through `sendWithTransientRetry` are ones the API applies
// idempotently, so repeating them is safe and giving up on them is not.
//
//   H1 refused / reset / 502-504 are retried, a timeout and a 500 are not
//   H2 a lease renewal through a reset socket is granted, not "unresolved"
//   H3 agent_done through a pod swap is delivered on its first attempt
//   H4 MCP: the retry policy is bounded and only for transient failures
//   H5 MCP over a real server: connect and a read-only tool ride out a reset;
//      a tool that may write is not sent twice
//   H6 MCP: a tool Claw's assistant API declares idempotent whose answer is lost
//      is sent again and answers; one that is not is sent once; two lost answers
//      are told to the model as "not known yet", not "Request timed out"
//      (2026-11-07 07:14Z: review_start's answer was cut off by a closing pod);
//      another server's idempotentHint changes nothing
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExecuteRequest } from "@claw/protocol";

import { isTransientFetchError, sendWithTransientRetry } from "../src/infra/transient-http.js";
import { askRunLease, postAgentDone } from "../src/tasks/callback.js";
import { __mcpRetryForTest, connectPlatformMcp, idempotentCallPolicy, isTransientMcpError, MCP_TRANSIENT_DELAYS_MS, trustsIdempotentHint } from "../src/clients/mcp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const noSleep = async () => {};

test("H1 refused / reset / 502-504 are retried, a timeout and a 500 are not", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
  const timedOut = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  assert.equal(isTransientFetchError(refused), true);
  assert.equal(isTransientFetchError(reset), true);
  assert.equal(isTransientFetchError(timedOut), false, "slow is not gone: a second request queues behind the first");

  const script = (steps: Array<Error | number>) => {
    let sent = 0;
    return {
      get sent() { return sent; },
      send: async () => {
        const step = steps[sent++]!;
        if (step instanceof Error) throw step;
        return new Response("{}", { status: step });
      },
    };
  };
  const swap = script([refused, 503, reset, 200]);
  const resp = await sendWithTransientRetry(swap.send, { delaysMs: [1, 1, 1], sleep: noSleep });
  assert.equal(resp.status, 200);
  assert.equal(swap.sent, 4);

  const broken = script([500, 200]);
  assert.equal((await sendWithTransientRetry(broken.send, { delaysMs: [1], sleep: noSleep })).status, 500);
  assert.equal(broken.sent, 1, "a 500 is the API's answer, not its absence");

  const slow = script([timedOut, 200]);
  await assert.rejects(sendWithTransientRetry(slow.send, { delaysMs: [1], sleep: noSleep }), /timeout/);
  assert.equal(slow.sent, 1);

  const gone = script([refused, refused, refused]);
  await assert.rejects(sendWithTransientRetry(gone.send, { delaysMs: [1, 1], sleep: noSleep }), /fetch failed/);
  assert.equal(gone.sent, 3, "bounded");
});

/** A server whose first `n` requests have their sockets destroyed, as a closing pod does. */
async function closingThenHealthy(n: number, answer: (req: IncomingMessage, res: ServerResponse) => void) {
  let seen = 0;
  const server = createServer((req, res) => {
    seen++;
    if (seen <= n) { req.socket.destroy(); return; }
    answer(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get seen() { return seen; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

test("H2 a lease renewal through a reset socket is granted, not unresolved", async () => {
  const api = await closingThenHealthy(1, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "running", claim_count: 2 }));
  });
  try {
    const answer = await askRunLease(
      { run_lease: { url: `${api.url}/lease`, token: "t" } } as unknown as ExecuteRequest,
      { brainId: "b", leaseSeconds: 45, phase: "executing", waitedMs: 0, waits: 0 } as never,
    );
    assert.deepEqual(answer, { kind: "granted", status: "running", claimCount: 2 });
    assert.equal(api.seen, 2);
  } finally {
    await api.close();
  }
});

test("H3 agent_done through a pod swap is delivered on its first attempt", async () => {
  const bodies: string[] = [];
  // Four dropped connections: more than the three attempts agent_done makes
  // for an ordinary failure, which is what a pod swap used to exhaust.
  const api = await closingThenHealthy(4, (req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { bodies.push(body); res.writeHead(200); res.end("{}"); });
  });
  try {
    await postAgentDone(
      { task_id: "t1", callback_url: api.url } as unknown as ExecuteRequest,
      { finalText: "done", turns: 1 } as never,
    );
    assert.equal(api.seen, 5);
    assert.equal(bodies.length, 1, "delivered once");
  } finally {
    await api.close();
  }
});

test("H4 MCP: transient failures are retried, bounded; others are thrown at once", async () => {
  const http503 = Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint"), { code: 503 });
  const http400 = Object.assign(new Error("Streamable HTTP error: bad request"), { code: 400 });
  const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  assert.equal(isTransientMcpError(http503), true);
  assert.equal(isTransientMcpError(reset), true);
  assert.equal(isTransientMcpError(http400), false);
  assert.equal(isTransientMcpError(new Error("MCP error -32001: Request timed out")), false);

  let calls = 0;
  const slept: number[] = [];
  const out = await __mcpRetryForTest("tools/list", "backend", async () => {
    calls++;
    if (calls < 3) throw calls === 1 ? reset : http503;
    return "listed";
  }, async (ms) => { slept.push(ms); });
  assert.equal(out, "listed");
  assert.deepEqual(slept, MCP_TRANSIENT_DELAYS_MS.slice(0, 2));

  let refusedCalls = 0;
  await assert.rejects(__mcpRetryForTest("x", "backend", async () => { refusedCalls++; throw http400; }, noSleep));
  assert.equal(refusedCalls, 1);

  let downCalls = 0;
  await assert.rejects(__mcpRetryForTest("x", "backend", async () => { downCalls++; throw reset; }, noSleep));
  assert.equal(downCalls, MCP_TRANSIENT_DELAYS_MS.length + 1);
});

test("H5 MCP over a real server: connect and a read-only tool ride out a reset, a write is not sent twice", async () => {
  const executed: Record<string, number> = { lookup: 0, post_comment: 0 };
  // Which requests a closing pod drops: by JSON-RPC method (and tool), the
  // first time each is seen.
  const dropOnce = new Set(["initialize", "tools/call:lookup", "tools/call:post_comment"]);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const tag = body?.method === "tools/call" ? `tools/call:${body.params?.name}` : String(body?.method);
    if (dropOnce.delete(tag)) {
      // The write is executed before its connection is lost: that is the case
      // a blind resend would turn into two comments.
      if (tag === "tools/call:post_comment") executed.post_comment++;
      req.socket.destroy();
      return;
    }
    const mcp = new McpServer({ name: "backend", version: "1.0.0" });
    mcp.registerTool("lookup", { description: "reads", annotations: { readOnlyHint: true } }, async () => {
      executed.lookup++;
      return { content: [{ type: "text", text: "found" }] };
    });
    mcp.registerTool("post_comment", { description: "writes" }, async () => {
      executed.post_comment++;
      return { content: [{ type: "text", text: "posted" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as never });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const mcp = await connectPlatformMcp({ backend: { type: "http", url: `http://127.0.0.1:${port}/mcp`, token: "t" } });
  try {
    assert.deepEqual(mcp.failed, [], "a server mid-swap at connect time is not dropped from the run");
    const caller = mcp.clients.get("backend")!;
    assert.equal(await caller.callTool("lookup", {}), "found");
    assert.equal(executed.lookup, 1);

    await assert.rejects(caller.callTool("post_comment", {}), "the failure reaches the model, which can look before acting");
    assert.equal(executed.post_comment, 1, "and the write was not sent a second time");
  } finally {
    await mcp.closeAll();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("H6 MCP: an idempotent tool whose answer is lost is sent again; a write that is not, once", async () => {
  const saved = { ...idempotentCallPolicy };
  idempotentCallPolicy.timeoutMs = 300;
  const executed: Record<string, number> = { review_start: 0, post_comment: 0, never: 0 };
  // Which calls never get an answer, as when a closing pod ends the stream it was to come on.
  const unanswered: Record<string, number> = { review_start: 1, post_comment: 1, never: 99 };
  const held: ServerResponse[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const tool = body?.method === "tools/call" ? String(body.params?.name) : "";
    if (tool && unanswered[tool]! > 0) {
      unanswered[tool]!--;
      executed[tool]!++;
      held.push(res);
      return;
    }
    const mcp = new McpServer({ name: "assistant", version: "1.0.0" });
    mcp.registerTool("review_start", { description: "hands over", annotations: { idempotentHint: true } }, async () => {
      executed.review_start!++;
      return { content: [{ type: "text", text: "handed_off" }] };
    });
    mcp.registerTool("never", { description: "hands over", annotations: { idempotentHint: true } }, async () => {
      return { content: [{ type: "text", text: "unreachable" }] };
    });
    mcp.registerTool("post_comment", { description: "writes" }, async () => {
      executed.post_comment!++;
      return { content: [{ type: "text", text: "posted" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as never });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const mcp = await connectPlatformMcp({
    assistant: { type: "http", url: `http://127.0.0.1:${port}/v1/internal/assistant-mcp`, token: "t" },
    // The same tools on any other server: a request's or a plugin's.
    thirdparty: { type: "http", url: `http://127.0.0.1:${port}/mcp`, token: "t" },
  });
  try {
    const caller = mcp.clients.get("assistant")!;
    assert.equal(await caller.callTool("review_start", {}), "handed_off", "the repeat answers what happened");
    assert.equal(executed.review_start, 2);

    await assert.rejects(caller.callTool("never", {}), /not known yet[\s\S]*still being confirmed/, "the model is told what it may do");
    assert.equal(executed.never, 2, "bounded: one resend");

    // Another server's hint: sent once, on the SDK's own wait (cut short here by the caller's signal).
    unanswered.review_start = 1;
    const before = executed.review_start!;
    await assert.rejects(mcp.clients.get("thirdparty")!.callTool("review_start", {}, undefined, undefined, AbortSignal.timeout(800)));
    assert.equal(executed.review_start! - before, 1, "a hint from a server Claw does not run is not acted on");
    assert.equal(trustsIdempotentHint("assistant", "http://api/v1/internal/assistant-mcp"), true);
    assert.equal(trustsIdempotentHint("assistant", "http://elsewhere/mcp"), false, "the name alone is not enough");
    assert.equal(trustsIdempotentHint("github", "http://api/v1/internal/assistant-mcp"), false);

    idempotentCallPolicy.timeoutMs = saved.timeoutMs;
    const write = caller.callTool("post_comment", {}, undefined, undefined, AbortSignal.timeout(400));
    await assert.rejects(write);
    assert.equal(executed.post_comment, 1, "a write the server does not call idempotent is not sent again");
  } finally {
    Object.assign(idempotentCallPolicy, saved);
    for (const res of held) res.destroy();
    await mcp.closeAll();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
