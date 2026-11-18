// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * MCP connections across turns (`src/clients/mcp-pool.ts`) and how a turn connects (`connectPlatformMcp`), through the real
 * client against real MCP servers over Streamable HTTP:
 *
 *   R1  the same user's next turn reuses the connection: no new initialize, no new listing, and its calls go on the same session
 *   R2  users never share a connection, even with byte-identical specs; a different credential is a different connection, and
 *       each call carries its own user's credential on its own user's session
 *   R3  servers connect side by side, not one after another
 *   R4  a server not ready within the budget is left out of the turn (`deferred`), keeps connecting, and the next turn offers it
 *       without connecting again
 *   R4c a server the run cannot work without (`required`) is waited for past the budget, up to its own; the others are not
 *   R5  health: a stale connection is listed again beside the turn (which does not wait for it), and one whose session is gone
 *       is reopened before any call needs it; a call the server answers 404 (session gone) is sent again on a new connection
 *   R6  a failure is remembered for the backoff: the next turn does not wait on the server again
 *   R7  without a user the run opens its own connections and closes them, as before
 *   R8  an idle connection is closed, and a superseded spec's connection with it
 *   R9  an SSE connection (a request held open) is closed when its run ends, not kept
 *   R10 a run that is aborted while its call waits for a shared reconnect stops waiting; the reconnect goes on for others
 */
import test from "node:test";
import assert from "node:assert/strict";
import { connectPlatformMcp } from "../src/clients/mcp.js";
import { MCP_POOL_DEFAULTS, McpConnectionPool } from "../src/clients/mcp-pool.js";
import { startCountingServer } from "./support/mcp-counting-server.js";

const spec = (url: string, token = "tok-a", extra: Record<string, unknown> = {}) => ({ type: "http", url, token, ...extra });
const newPool = (over: Partial<typeof MCP_POOL_DEFAULTS> = {}) => new McpConnectionPool({ ...MCP_POOL_DEFAULTS, ...over });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("R1 the same user's next turn reuses the connection", async () => {
  const s = await startCountingServer({ stateful: true });
  const pool = newPool();
  try {
    const t1 = await connectPlatformMcp({ fx: spec(s.url) }, { pool, userId: "alice" });
    await t1.clients.get("fx")!.callTool("echo", {});
    await t1.closeAll();
    const t2 = await connectPlatformMcp({ fx: spec(s.url) }, { pool, userId: "alice" });
    assert.deepEqual(t2.schemas.map((t) => t.name), ["mcp__fx__echo"]);
    assert.equal(await t2.clients.get("fx")!.callTool("echo", {}), "ran echo");
    await t2.closeAll();
    assert.equal(s.initializes, 1, "the second turn opened a connection of its own");
    assert.equal(s.listings, 1, "the second turn listed the tools again inside the health interval");
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0]!.session, s.calls[1]!.session, "both turns' calls went on the one session");
    // A kept connection holds no request open between turns (the SDK's standalone GET stream is not opened).
    assert.equal(s.gets, 0);
  } finally { await pool.closeAll(); await s.close(); }
});

test("R2 users never share a connection, and a call carries its own user's credential on its own user's session", async () => {
  const s = await startCountingServer({ stateful: true });
  const pool = newPool();
  try {
    // Byte-identical specs for two users: still two connections.
    const a = await connectPlatformMcp({ fx: spec(s.url, "same") }, { pool, userId: "alice" });
    const b = await connectPlatformMcp({ fx: spec(s.url, "same") }, { pool, userId: "bob" });
    assert.equal(s.initializes, 2, "bob's turn reused alice's connection");
    await a.clients.get("fx")!.callTool("echo", {});
    await b.clients.get("fx")!.callTool("echo", {});
    assert.notEqual(s.calls[0]!.session, s.calls[1]!.session, "alice and bob called on the same session");
    await a.closeAll(); await b.closeAll();

    // The same user with another credential (or any other field) is another connection, and its calls carry that credential.
    s.calls.length = 0;
    const c1 = await connectPlatformMcp({ fx: spec(s.url, "carol-1") }, { pool, userId: "carol" });
    const c2 = await connectPlatformMcp({ fx: spec(s.url, "carol-2") }, { pool, userId: "carol" });
    const c3 = await connectPlatformMcp({ fx: spec(s.url, "carol-2", { headers: { "x-workspace": "w2" } }) }, { pool, userId: "carol" });
    assert.equal(s.initializes, 5);
    await c1.clients.get("fx")!.callTool("echo", {});
    await c2.clients.get("fx")!.callTool("echo", {});
    assert.deepEqual(s.calls.map((c) => c.auth), ["Bearer carol-1", "Bearer carol-2"]);
    await c1.closeAll(); await c2.closeAll(); await c3.closeAll();

    // And reuse afterwards still lands on the user's own connection.
    s.calls.length = 0;
    const a2 = await connectPlatformMcp({ fx: spec(s.url, "same") }, { pool, userId: "alice" });
    const b2 = await connectPlatformMcp({ fx: spec(s.url, "same") }, { pool, userId: "bob" });
    await a2.clients.get("fx")!.callTool("echo", {});
    await b2.clients.get("fx")!.callTool("echo", {});
    assert.equal(s.initializes, 5, "the reused turns opened connections");
    assert.notEqual(s.calls[0]!.session, s.calls[1]!.session);
    await a2.closeAll(); await b2.closeAll();
  } finally { await pool.closeAll(); await s.close(); }
});

test("R3 servers connect side by side", async () => {
  const s = await startCountingServer({ initDelayMs: 300 });
  const pool = newPool();
  try {
    const started = Date.now();
    const r = await connectPlatformMcp({ a: spec(s.url), b: spec(s.url), c: spec(s.url) }, { pool, userId: "alice" });
    const ms = Date.now() - started;
    assert.equal(s.initializes, 3);
    assert.equal(s.maxInitInFlight, 3, "the servers were connected one after another");
    assert.ok(ms < 850, `three 300 ms connects took ${ms} ms`);
    assert.equal(r.schemas.length, 3);
    await r.closeAll();
  } finally { await pool.closeAll(); await s.close(); }
});

test("R4 a server not ready within the budget is left out of this turn, keeps connecting, and is offered on the next", async () => {
  const slow = await startCountingServer({ initDelayMs: 1_200 });
  const fast = await startCountingServer();
  const pool = newPool();
  try {
    const started = Date.now();
    const t1 = await connectPlatformMcp({ slow: spec(slow.url), fast: spec(fast.url) }, { pool, userId: "alice", budgetMs: 300 });
    const ms = Date.now() - started;
    assert.ok(ms < 900, `the turn waited ${ms} ms for a server past its 300 ms budget`);
    assert.deepEqual(t1.schemas.map((t) => t.name), ["mcp__fast__echo"]);
    assert.deepEqual(t1.deferred.map((d) => d.name), ["slow"]);
    assert.match(t1.deferred[0]!.reason, /within 300 ms/);
    assert.deepEqual(t1.failed, []);
    assert.equal(t1.clients.has("slow"), false);
    await t1.closeAll();

    // The connect went on without the turn.
    for (let i = 0; i < 50 && slow.listings === 0; i++) await sleep(50);
    const t2 = await connectPlatformMcp({ slow: spec(slow.url), fast: spec(fast.url) }, { pool, userId: "alice", budgetMs: 300 });
    assert.deepEqual(t2.schemas.map((t) => t.name), ["mcp__fast__echo", "mcp__slow__echo"]);
    assert.deepEqual(t2.deferred, []);
    assert.equal(await t2.clients.get("slow")!.callTool("echo", {}), "ran echo");
    assert.equal(slow.initializes, 1, "the next turn connected again instead of using the background connect");
    await t2.closeAll();
  } finally { await pool.closeAll(); await slow.close(); await fast.close(); }
});

test("R4b without a pool a deferred connection is closed when it finishes, and nothing waits past the budget", async () => {
  const slow = await startCountingServer({ initDelayMs: 600 });
  try {
    const started = Date.now();
    const t1 = await connectPlatformMcp({ slow: spec(slow.url) }, { budgetMs: 200 });
    assert.ok(Date.now() - started < 550);
    assert.deepEqual(t1.deferred.map((d) => d.name), ["slow"]);
    await t1.closeAll();
  } finally { await sleep(700); await slow.close(); }
});

test("R4c a required server is waited for past the budget, up to its own; the others are not held for it", async () => {
  const slow = await startCountingServer({ initDelayMs: 700 });
  const other = await startCountingServer({ initDelayMs: 700 });
  const pool = newPool();
  try {
    const started = Date.now();
    const t1 = await connectPlatformMcp({ github_review: spec(slow.url), other: spec(other.url) },
      { pool, userId: "alice", budgetMs: 200, required: ["github_review"], requiredBudgetMs: 5_000 });
    const ms = Date.now() - started;
    assert.ok(ms >= 600 && ms < 3_000, `the turn waited ${ms} ms for a required server that answers in 700 ms`);
    assert.deepEqual(t1.schemas.map((t) => t.name), ["mcp__github_review__echo"]);
    assert.deepEqual(t1.deferred.map((d) => d.name), ["other"], "a server that is not required is still left out past the budget");
    assert.match(t1.deferred[0]!.reason, /within 200 ms/);
    assert.equal(await t1.clients.get("github_review")!.callTool("echo", {}), "ran echo");
    await t1.closeAll();
  } finally { await pool.closeAll(); await slow.close(); await other.close(); }

  // Past its own budget a required server is deferred too, said with that budget, and the turn does not wait for ever.
  const slower = await startCountingServer({ initDelayMs: 1_500 });
  try {
    const started = Date.now();
    const t2 = await connectPlatformMcp({ github_review: spec(slower.url) }, { budgetMs: 100, required: ["github_review"], requiredBudgetMs: 400 });
    const ms = Date.now() - started;
    assert.ok(ms >= 350 && ms < 1_200, `the turn waited ${ms} ms for a required server with a 400 ms budget`);
    assert.deepEqual(t2.deferred.map((d) => d.name), ["github_review"]);
    assert.match(t2.deferred[0]!.reason, /within 400 ms/);
    await t2.closeAll();
  } finally { await sleep(1_300); await slower.close(); }

  // A required budget shorter than the budget is the budget.
  const s3 = await startCountingServer({ initDelayMs: 300 });
  try {
    const t3 = await connectPlatformMcp({ github_review: spec(s3.url) }, { budgetMs: 1_000, required: ["github_review"], requiredBudgetMs: 50 });
    assert.deepEqual(t3.deferred, []);
    assert.deepEqual(t3.schemas.map((t) => t.name), ["mcp__github_review__echo"]);
    await t3.closeAll();
  } finally { await s3.close(); }
});

test("R5 a stale connection is checked beside the turn, a slow check does not hold it, and a lost session is reopened", async () => {
  const s = await startCountingServer({ stateful: true });
  const pool = newPool({ healthMs: 0 });
  const until = async (cond: () => boolean) => { for (let i = 0; i < 60 && !cond(); i++) await sleep(25); };
  try {
    const t1 = await connectPlatformMcp({ fx: spec(s.url) }, { pool, userId: "alice" });
    await t1.closeAll();
    // Healthy but slow to list: listed again, same connection, and the turn does not wait for the listing.
    s.listDelayMs = 1_000;
    const started = Date.now();
    const t2 = await connectPlatformMcp({ fx: spec(s.url) }, { pool, userId: "alice", budgetMs: 2_000 });
    assert.ok(Date.now() - started < 500, `the turn waited ${Date.now() - started} ms for the health check`);
    assert.deepEqual(t2.schemas.map((t) => t.name), ["mcp__fx__echo"]);
    await t2.closeAll();
    await until(() => s.listings >= 2);
    s.listDelayMs = 0;
    await sleep(1_100);
    assert.equal(s.listings, 2, "a stale connection was not checked");
    assert.equal(s.initializes, 1);
    // The server forgets its sessions (a restart): the check fails and the connection is opened again, before any call.
    s.dropSessions();
    const t3 = await connectPlatformMcp({ fx: spec(s.url) }, { pool, userId: "alice", budgetMs: 2_000 });
    assert.deepEqual(t3.failed, []);
    assert.deepEqual(t3.schemas.map((t) => t.name), ["mcp__fx__echo"], "the turn was not offered the tools as last listed");
    await until(() => s.initializes >= 2);
    assert.equal(s.initializes, 2, "the lost session was not reopened by the check");
    assert.equal(await t3.clients.get("fx")!.callTool("echo", {}), "ran echo");
    assert.equal(s.initializes, 2);
    await t3.closeAll();
  } finally { await pool.closeAll(); await s.close(); }
});

test("R5b a call the server answers 404 (session gone) is sent again on a new connection", async () => {
  const s = await startCountingServer({ stateful: true });
  const pool = newPool();
  try {
    const t1 = await connectPlatformMcp({ fx: spec(s.url) }, { pool, userId: "alice" });
    s.dropSessions();
    assert.equal(await t1.clients.get("fx")!.callTool("echo", {}), "ran echo");
    assert.equal(s.initializes, 2);
    assert.equal(s.calls.length, 1, "the call ran more than once");
    await t1.closeAll();
  } finally { await pool.closeAll(); await s.close(); }
});

test("R6 a failure is remembered for the backoff, then tried again", async () => {
  const s = await startCountingServer();
  const pool = newPool({ failBackoffMs: 400 });
  try {
    s.refuse = true;
    const t1 = await connectPlatformMcp({ fx: spec(s.url) }, { pool, userId: "alice", budgetMs: 2_000 });
    assert.deepEqual(t1.failed.map((f) => f.name), ["fx"]);
    await t1.closeAll();
    const seen = s.requests;
    assert.ok(seen > 0);
    const t2 = await connectPlatformMcp({ fx: spec(s.url) }, { pool, userId: "alice", budgetMs: 2_000 });
    assert.deepEqual(t2.failed.map((f) => f.name), ["fx"]);
    assert.equal(s.requests, seen, "the turn inside the backoff tried the failed server again");
    await t2.closeAll();
    s.refuse = false;
    await sleep(450);
    const t3 = await connectPlatformMcp({ fx: spec(s.url) }, { pool, userId: "alice", budgetMs: 2_000 });
    assert.deepEqual(t3.failed, []);
    assert.deepEqual(t3.schemas.map((t) => t.name), ["mcp__fx__echo"]);
    await t3.closeAll();
  } finally { await pool.closeAll(); await s.close(); }
});

test("R7 without a user (or with `default`) a run opens its own connections and closes them", async () => {
  const s = await startCountingServer({ stateful: true });
  const pool = newPool();
  try {
    for (const userId of [undefined, "default", undefined]) {
      const t = await connectPlatformMcp({ fx: spec(s.url) }, { pool, userId });
      await t.clients.get("fx")!.callTool("echo", {});
      await t.closeAll();
    }
    assert.equal(s.initializes, 3);
    assert.equal(pool.size, 0);
    // A closed run's caller does not reopen anything.
    const t = await connectPlatformMcp({ fx: spec(s.url) });
    await t.closeAll();
    await assert.rejects(t.clients.get("fx")!.callTool("echo", {}), /closed/);
  } finally { await pool.closeAll(); await s.close(); }
});

test("R8 an idle connection is closed, and a superseded spec's connection with it", async () => {
  const s = await startCountingServer({ stateful: true });
  const pool = newPool({ idleMs: 50 });
  try {
    const t1 = await connectPlatformMcp({ fx: spec(s.url, "turn-1") }, { pool, userId: "alice" });
    await t1.closeAll();
    const t2 = await connectPlatformMcp({ fx: spec(s.url, "turn-2") }, { pool, userId: "alice" });
    assert.equal(pool.size, 1, "the superseded spec's idle connection was kept");
    // In use: not swept, however long.
    await sleep(80);
    pool.sweep();
    assert.equal(pool.size, 1);
    // A third spec while the second is in use: the second is closed when its run lets go, not kept for reuse.
    const t3 = await connectPlatformMcp({ fx: spec(s.url, "turn-3") }, { pool, userId: "alice" });
    assert.equal(pool.size, 2);
    await t2.closeAll();
    assert.equal(pool.size, 1, "a superseded spec's connection was kept after its run let go");
    await t3.closeAll();
    await sleep(80);
    pool.sweep();
    assert.equal(pool.size, 0);
  } finally { await pool.closeAll(); await s.close(); }
});

test("R9 an SSE connection is closed when its run ends, not kept", async () => {
  const pool = newPool();
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
  const http = await import("node:http");
  const transports = new Map<string, InstanceType<typeof SSEServerTransport>>();
  let opened = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/mcp") { res.writeHead(405); res.end("Method Not Allowed"); return; }
    if (req.method === "GET") {
      opened++;
      const t = new SSEServerTransport("/messages", res);
      transports.set(t.sessionId, t);
      const mcp = new McpServer({ name: "sse", version: "1.0.0" });
      mcp.tool("echo", "echo", async () => ({ content: [{ type: "text" as const, text: "ran echo" }] }));
      await mcp.connect(t);
      return;
    }
    const sid = new URL(req.url ?? "/", "http://x").searchParams.get("sessionId") ?? "";
    await transports.get(sid)?.handlePostMessage(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/mcp`;
  try {
    const t1 = await connectPlatformMcp({ fx: spec(url) }, { pool, userId: "alice" });
    assert.equal(await t1.clients.get("fx")!.callTool("echo", {}), "ran echo");
    await t1.closeAll();
    assert.equal(pool.size, 0, "an SSE connection was kept after its run");
    const t2 = await connectPlatformMcp({ fx: spec(url) }, { pool, userId: "alice" });
    await t2.closeAll();
    assert.equal(opened, 2);
  } finally {
    await pool.closeAll();
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  }
});

test("R10 an aborted run stops waiting for a shared reconnect, which goes on for the others", async () => {
  const s = await startCountingServer({ stateful: true });
  const pool = newPool();
  try {
    const t1 = await connectPlatformMcp({ fx: spec(s.url) }, { pool, userId: "alice" });
    // The session is gone and the reconnect is slow: the call waits for it.
    s.dropSessions();
    s.initDelayMs = 1_000;
    const ctrl = new AbortController();
    const started = Date.now();
    const call = t1.clients.get("fx")!.callTool("echo", {}, undefined, undefined, ctrl.signal);
    setTimeout(() => ctrl.abort(new Error("run stopped")), 100);
    await assert.rejects(call, /run stopped/);
    assert.ok(Date.now() - started < 700, `the aborted call waited ${Date.now() - started} ms for the reconnect`);
    // Another holder's call still gets the connection the reconnect makes.
    assert.equal(await t1.clients.get("fx")!.callTool("echo", {}), "ran echo");
    assert.equal(s.initializes, 2);
    await t1.closeAll();
  } finally { await pool.closeAll(); await s.close(); }
});
