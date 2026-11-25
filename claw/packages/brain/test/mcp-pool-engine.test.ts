// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * MCP connections across turns, end to end through the real engine (`AgentEngine.execute`): the engine hands its runs the
 * process's pool keyed by the request's user, and its connect budget (MCP_CONNECT_BUDGET_MS). Only the network edges are fake:
 * the LLM and the marketplace (`platform-defaults-world`), Hands; the MCP servers are real.
 *
 *   E1  a user's second turn opens no new connection; another user's turn opens its own
 *   E2  a server slower than the budget is not waited for: the turn goes on without its tools and tells the model so, and
 *       the user's next turn offers them without connecting again
 *   E3  a review session's review tools (`github_review` in a turn that acts as a user) are waited for past that budget
 *       (MCP_REQUIRED_CONNECT_BUDGET_MS): a cold connection no longer ends the review with no tool to call; a server of that
 *       name in any other turn is not
 *   E4  an assistant turn's own server (`assistant` at Claw's internal path) is waited for past that budget too: a slow connection
 *       no longer leaves the turn without `say` and `review_start`, telling the user the service is unreachable; a server of that
 *       name at another address is not
 *   E5  a server that is only slow is said to the model as slow, not as unreachable
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { startCountingServer } from "./support/mcp-counting-server.js";

process.env.MCP_CONNECT_BUDGET_MS = "400";
process.env.MCP_REQUIRED_CONNECT_BUDGET_MS = "5000";
const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
const { mcpUnavailableNote } = await import("../src/clients/mcp.js");
let n = 0;

async function run(userId: string, servers: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ body: string; ms: number }> {
  world.script([{ text: "done" }]);
  const before = world.llmBodies.length;
  const started = Date.now();
  await new AgentEngine().execute(
    baseRequest({ session_id: `pool-engine-${++n}`, user_id: userId, mcp_servers: servers, ...extra }),
    (async () => {}) as never, undefined, null as never, { attachHands: async () => fakeHands() as never } as never,
  );
  return { body: world.llmBodies[before] ?? "", ms: Date.now() - started };
}

const toolNames = (body: string): string[] => ((JSON.parse(body) as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name);

test("E1 a user's next turn reuses its MCP connection; another user's turn opens its own", async () => {
  const s = await startCountingServer({ stateful: true });
  try {
    const servers = { fx: { type: "http", url: s.url, token: "user-key" } };
    const t1 = await run("pool-alice", servers);
    assert.ok(toolNames(t1.body).includes("mcp__fx__echo"));
    const t2 = await run("pool-alice", servers);
    assert.ok(toolNames(t2.body).includes("mcp__fx__echo"));
    assert.equal(s.initializes, 1, "the same user's second turn connected again");
    await run("pool-bob", servers);
    assert.equal(s.initializes, 2, "another user's turn reused the first user's connection");
  } finally { await s.close(); }
});

test("E2 a server slower than the budget is left out of the turn and offered on the next", async () => {
  const slow = await startCountingServer({ initDelayMs: 1_500 });
  const fast = await startCountingServer();
  try {
    const servers = { slow: { type: "http", url: slow.url, token: "k" }, fast: { type: "http", url: fast.url, token: "k" } };
    const t1 = await run("pool-carol", servers);
    assert.ok(t1.ms < 1_400, `the turn waited ${t1.ms} ms for a server past the 400 ms budget`);
    assert.ok(toolNames(t1.body).includes("mcp__fast__echo"));
    assert.ok(!toolNames(t1.body).includes("mcp__slow__echo"));
    assert.match(t1.body, /Not ready this turn: MCP server\(s\) slow \(did not answer within 400 ms/);

    for (let i = 0; i < 60 && slow.listings === 0; i++) await new Promise((r) => setTimeout(r, 50));
    const t2 = await run("pool-carol", servers);
    assert.ok(toolNames(t2.body).includes("mcp__slow__echo"), "the next turn did not offer the server that finished connecting");
    assert.doesNotMatch(t2.body, /Unavailable this turn|Not ready this turn/);
    assert.equal(slow.initializes, 1);
  } finally { await slow.close(); await fast.close(); }
});

test("E3 a review session's review tools are waited for past the budget; another slow server beside them is not", async () => {
  const review = await startCountingServer({ initDelayMs: 1_200 });
  const slow = await startCountingServer({ initDelayMs: 3_000 });
  try {
    const servers = { github_review: { type: "http", url: review.url, token: "k" }, slow: { type: "http", url: slow.url, token: "k" } };
    const t1 = await run("pool-dave", servers, { withhold_sandbox_keys: true });
    assert.ok(t1.ms >= 1_100 && t1.ms < 2_900, `the turn took ${t1.ms} ms: the review tools answer in 1200 ms, the other server in 3000 ms`);
    assert.ok(toolNames(t1.body).includes("mcp__github_review__echo"), "the review tools were left out of the turn");
    assert.ok(!toolNames(t1.body).includes("mcp__slow__echo"));
    assert.match(t1.body, /Not ready this turn: MCP server\(s\) slow \(did not answer within 400 ms/);
    assert.doesNotMatch(t1.body, /github_review \(did not answer/);
  } finally { await review.close(); await slow.close(); }
  // A server of that name in a turn that acts as nobody (not a review session) waits no longer than any other.
  const named = await startCountingServer({ initDelayMs: 1_500 });
  try {
    const t2 = await run("pool-erin", { github_review: { type: "http", url: named.url, token: "k" } });
    assert.ok(t2.ms < 1_400, `a turn that is not a review waited ${t2.ms} ms for a server named github_review`);
    assert.match(t2.body, /Not ready this turn: MCP server\(s\) github_review \(did not answer within 400 ms/);
  } finally { await named.close(); }
});

test("E4 an assistant turn's own server is waited for past the budget; a server of that name elsewhere is not", async () => {
  const own = await startCountingServer({ initDelayMs: 1_200, tools: ["say", "review_start"] });
  try {
    const url = own.url.replace(/\/mcp$/, "/v1/internal/assistant-mcp");
    const t1 = await run("pool-frank", { assistant: { type: "http", url, token: "per-turn" } });
    assert.ok(t1.ms >= 1_100, `the turn took ${t1.ms} ms: it went on before its own server answered in 1200 ms`);
    assert.ok(toolNames(t1.body).includes("mcp__assistant__say"), "the turn went on without say");
    assert.ok(toolNames(t1.body).includes("mcp__assistant__review_start"));
    assert.doesNotMatch(t1.body, /Unavailable this turn|Not ready this turn/);
  } finally { await own.close(); }
  const elsewhere = await startCountingServer({ initDelayMs: 1_500 });
  try {
    const t2 = await run("pool-grace", { assistant: { type: "http", url: elsewhere.url, token: "k" } });
    assert.ok(t2.ms < 1_400, `a server named assistant at another path held the turn ${t2.ms} ms`);
    assert.match(t2.body, /Not ready this turn: MCP server\(s\) assistant \(did not answer within 400 ms/);
  } finally { await elsewhere.close(); }
});

test("E5 a slow server is said as slow, not unreachable; a failed one as unreachable", () => {
  const slow = mcpUnavailableNote([], [{ name: "assistant", reason: "did not answer within 2000 ms; its tools are offered again from the next turn" }]);
  assert.match(slow, /^\[Not ready this turn: MCP server\(s\) assistant \(did not answer within 2000 ms/);
  assert.match(slow, /did not answer in time/);
  assert.doesNotMatch(slow, /tell the user that service is unreachable/);
  const down = mcpUnavailableNote([{ name: "ops", reason: "fetch failed" }], [{ name: "slow", reason: "did not answer within 400 ms" }]);
  assert.match(down, /^\[Unavailable this turn: MCP server\(s\) ops \(fetch failed\).*unreachable right now/);
  assert.match(down, /\n\[Not ready this turn: MCP server\(s\) slow /);
  assert.equal(mcpUnavailableNote([], []), "");
});

test.after(async () => { await world.close(); });
