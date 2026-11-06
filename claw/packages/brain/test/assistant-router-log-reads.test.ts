// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A router turn's log reads (`ExecuteRequest.log_reads`, `tools/log-reads.ts`), through the real engine against a real MCP server
 * shaped like SaFE's: only the LLM and Hands are fake.
 *
 *   LR1 a log read asks for at most the bound (lowered from what the model asked, set when it asked nothing), and the answer the
 *       model, the session's events and Brain's own log see has the credentials a job printed masked; a read that is not a log
 *       read, of the same server, is called and answered as it was
 *   LR2 without the field nothing changes: the read is called with what the model asked and answered as the server answered
 *   LR3 the rule itself: what it accepts, the bound, the mask, and the end of a long plain-text log
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { startWorld, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";
import { parseLogReads } from "../src/tools/log-reads.js";

// Made up here, credential-shaped: what a job may print.
const FAKE_GH = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234";
const FAKE_PW = "Hunter2-not-real-pw";

const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const server = new McpServer({ name: "safe", version: "1.0.0" });
    server.tool("workload_pod_logs", "logs", { workload_id: z.string(), pod_id: z.string(), tail_lines: z.number().optional() }, async (args) => {
      calls.push({ tool: "workload_pod_logs", args });
      const lines = Array.from({ length: Number(args.tail_lines ?? 1000) }, (_, i) => `line ${i}`);
      lines.push(`export GH_TOKEN=${FAKE_GH}`, `db password: ${FAKE_PW}`, "Error: CUDA out of memory");
      return { content: [{ type: "text" as const, text: JSON.stringify({ logs: lines.join("\n") }) }] };
    });
    server.tool("workload_get", "get", { workload_id: z.string() }, async (args) => {
      calls.push({ tool: "workload_get", args });
      return { content: [{ type: "text" as const, text: JSON.stringify({ id: args.workload_id, phase: "Failed", note: `password: ${FAKE_PW}` }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const port = (srv.address() as AddressInfo).port;

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); await new Promise<void>((r) => srv.close(() => r())); });

const LOG_READS = { tools: { mcp__safe__workload_pod_logs: "tail_lines" }, lines: 40, chars: 6000 };

function request(over: Record<string, unknown> = {}) {
  return baseRequest({
    session_id: `logreads-${Math.random().toString(36).slice(2)}`,
    prompt: "我的 workload w1 为什么失败了",
    tools_allowlist: ["mcp__safe__workload_pod_logs", "mcp__safe__workload_get"],
    max_turns: 8,
    plugin_id: 9,
    plugin_tools: [{ id: 3, type: "mcp", name: "safe-mcp", config: { mcpServers: { safe: { type: "http", url: `http://127.0.0.1:${port}/mcp`, token: "t" } } } }],
    skip_platform_defaults: true,
    ...over,
  });
}

async function run(req: unknown, turns: Turn[]) {
  world.script(turns);
  world.llmBodies.length = 0;
  calls.length = 0;
  const events: Array<Record<string, unknown>> = [];
  await new AgentEngine().execute(
    req as never, (async (e: Record<string, unknown>) => { events.push(e); }) as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never } as never,
  );
  return { bodies: [...world.llmBodies], calls: [...calls], events };
}

const LOGS = (tail?: number) => ({ tool: "mcp__safe__workload_pod_logs", input: { workload_id: "w1", pod_id: "p1", ...(tail ? { tail_lines: tail } : {}) } });

test("LR1 a log read asks for its bound and is masked before the model, the events and the log see it; another read is as it was", async () => {
  let seen = "";
  const r = await run(request({ log_reads: LOG_READS }), [
    LOGS(1000),
    LOGS(),
    LOGS(5),
    { tool: "mcp__safe__workload_get", input: { workload_id: "w1" } },
    (body) => { seen = body; return { text: "CUDA out of memory" }; },
  ]);
  assert.deepEqual(r.calls.map((c) => [c.tool, c.args.tail_lines]), [
    ["workload_pod_logs", 40], ["workload_pod_logs", 40], ["workload_pod_logs", 5], ["workload_get", undefined],
  ]);
  const logResults = r.events.filter((e) => e.type === "toolUsed" && e.tool === "mcp__safe__workload_pod_logs" && e.status === "success");
  assert.equal(logResults.length, 3);
  for (const e of logResults) {
    assert.ok(!String(e.description).includes(FAKE_GH) && !String(e.description).includes(FAKE_PW), "the event holds no credential");
  }
  // What the model was given: the log's end, masked; the other read's answer as the server gave it.
  assert.ok(!seen.split("mcp__safe__workload_get")[0].includes(FAKE_GH), "the token is not in what the model read");
  assert.match(seen, /CUDA out of memory/);
  assert.match(seen, /GH_TOKEN=<redacted>/);
  assert.match(seen, /password: <redacted>/);
  assert.ok(seen.includes(`password: ${FAKE_PW}`), "a read that is not a log read is answered as the server answered");
});

test("LR2 without log_reads the read is called and answered as before", async () => {
  let seen = "";
  const r = await run(request(), [LOGS(1000), (body) => { seen = body; return { text: "done" }; }]);
  assert.deepEqual(r.calls.map((c) => c.args.tail_lines), [1000]);
  assert.ok(seen.includes(FAKE_PW), "unchanged");
});

test("LR3 the rule: what it accepts, the bound, the mask, and the end of a long plain-text log", () => {
  for (const bad of [null, "x", [], {}, { tools: [] }, { tools: { "not a tool": "limit" } }, { tools: { mcp__s__t: "bad arg!" } }]) {
    assert.equal(parseLogReads(bad), null, JSON.stringify(bad));
  }
  const rule = parseLogReads({ tools: { mcp__s__logs: "limit" }, lines: 10, chars: 600 })!;
  assert.equal(rule.has("mcp__s__logs"), true);
  assert.equal(rule.has("mcp__s__get"), false);
  assert.deepEqual(rule.bound("mcp__s__logs", { id: 1 }), { id: 1, limit: 10 });
  assert.deepEqual(rule.bound("mcp__s__logs", { limit: 500 }), { limit: 10 });
  assert.deepEqual(rule.bound("mcp__s__logs", { limit: 3 }), { limit: 3 });
  assert.deepEqual(rule.bound("mcp__s__logs", { limit: "7" }), { limit: 7 });
  assert.deepEqual(rule.bound("mcp__s__logs", { limit: -1 }), { limit: 10 });
  assert.deepEqual(rule.bound("mcp__s__get", { limit: 500 }), { limit: 500 }, "not a log read");
  // Out-of-range numbers fall back to the defaults, never to no bound.
  const lax = parseLogReads({ tools: { mcp__s__logs: "limit" }, lines: 1_000_000, chars: 1 })!;
  assert.deepEqual(lax.bound("mcp__s__logs", {}), { limit: 40 });
  // Plain text keeps its end, at a line; JSON is left whole for the run's own cap; both are masked.
  const text = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(3, "0")} ${"x".repeat(20)}`).join("\n") + `\ntoken: ${FAKE_PW}`;
  const kept = rule.filter(text);
  assert.ok(kept.length < 700, `${kept.length}`);
  assert.match(kept, /^\[\d+ earlier characters of this log are not shown\]\nline \d{3} /);
  assert.ok(kept.endsWith("token: <redacted>"));
  const json = JSON.stringify({ logs: text });
  const whole = rule.filter(json);
  assert.ok(whole.startsWith('{"logs":"line 000'), "JSON is not cut");
  assert.ok(!whole.includes(FAKE_PW));
  // A plain-text log that starts with a bracket is plain text: it is cut to its end like any other.
  const bracketed = text.split("\n").map((l) => `[INFO] ${l}`).join("\n");
  const cut = rule.filter(bracketed);
  assert.ok(cut.length < 700, `${cut.length}`);
  assert.match(cut, /^\[\d+ earlier characters of this log are not shown\]\n\[INFO\] line \d{3} /);
});
