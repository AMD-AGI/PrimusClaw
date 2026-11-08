// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A research report with too much of it unverified goes back to its writer before it is delivered (`ExecuteRequest.cite_check.revise`,
 * `tools/cite-revise.ts`). The network and the judge are fakes; the check, the router and the engine are the real code.
 *
 *   CR1 more than the ratio unverified, a round left: the call is refused, nothing delivered, with the marked statements listed; the
 *       next delivery is made with its marks once the rounds are spent
 *   CR2 at or under the ratio, or without `revise`, the checked text is delivered at once
 *   CR3 what `revise` accepts: whole rounds from 1, capped at 2; a ratio in [0, 1); anything else is no revise
 *   CR4 through the engine, as the API sends it: the worker's first deliver_text is refused and the second reaches the server; the same
 *       run without `revise` delivers both
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { startWorld, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";
import type { CheckedPage, CiteCheckPorts } from "../src/tools/cite-check.js";
type ToolRouter = import("../src/tools/router.js").ToolRouter;

// The world sets the LLM's address in the environment, which Brain's config reads once at import: it starts before Brain is imported.
const world = await startWorld();
const { parseCiteCheck } = await import("../src/tools/cite-check.js");
const { bindCiteRevise, citeReviseFor, parseCiteRevise, unverifiedLines, CITE_REVISE_MAX_ROUNDS } = await import("../src/tools/cite-revise.js");
const { ToolRouter } = await import("../src/tools/router.js");
const { AgentEngine } = await import("../src/agent/engine.js");

const A = "https://rocm.docs.amd.com/en/latest/vllm.html";
const TOOL = "mcp__assistant__deliver_text";

/** A report of `n` cited statements, the first `supported` of which its page supports (the page holds their key word). */
function report(n: number, supported: number): { text: string; ports: CiteCheckPorts } {
  const lines = Array.from({ length: n }, (_, i) => `- Statement ${i} says {${i < supported ? `yes${i}` : `no${i}`}} [1].`);
  const page = Array.from({ length: supported }, (_, i) => `yes${i}`).join(" ");
  const ports: CiteCheckPorts = {
    fetchPage: async (): Promise<CheckedPage> => ({ ok: true, text: page }),
    judge: async ({ page: p, claims }) => claims.map((c) => p.split(" ").includes(c.match(/\{(\w+)\}/)?.[1] ?? "-")),
  };
  return { text: [...lines, "", `[1]: vLLM on ROCm — ${A}`].join("\n"), ports };
}

function routerWithAssistant() {
  const sent: Array<Record<string, unknown>> = [];
  const caller = { callTool: async (_tool: string, input: Record<string, unknown>) => { sent.push(input); return "{\"ok\":true}"; } };
  return { router: new ToolRouter(null, new Map([["assistant", caller as never]])), sent };
}

async function deliver(router: ToolRouter, text: string) {
  const outcome = { isError: false };
  const answer = await router.route(TOOL, { name: "r.md", text }, undefined, outcome);
  return { answer, isError: outcome.isError };
}

test("CR1 a report over the ratio comes back once with its unverified statements, then is delivered with its marks", async () => {
  const { router, sent } = routerWithAssistant();
  const { text, ports } = report(10, 7);
  router.citeCheck = parseCiteCheck({ tools: [TOOL] }, ports);
  bindCiteRevise(router.citeCheck, parseCiteRevise({ tools: [TOOL], revise: { rounds: 1, unverified_ratio: 0.2 } }));

  const first = await deliver(router, text);
  assert.equal(first.isError, true);
  assert.equal(sent.length, 0, "nothing reaches the user");
  assert.match(first.answer, /^Error: not delivered\. The citation check found 3 of 10 cited statements unverified \(more than 20%\)/);
  assert.match(first.answer, /That delivery is made whatever the check finds\./);
  const listed = first.answer.split("by line:\n")[1].split("\n");
  assert.deepEqual(listed, [
    "- - Statement 7 says {no7} (unverified).", "- - Statement 8 says {no8} (unverified).", "- - Statement 9 says {no9} (unverified).",
  ], "only the marked statements, never the closing line");
  assert.equal(citeReviseFor(router.citeCheck!)!.roundsLeft, 0);

  const second = await deliver(router, text);
  assert.equal(second.isError, false);
  assert.equal(sent.length, 1);
  assert.match(String(sent[0].text), /Statement 9 says \{no9\} \(unverified\)\./);
  assert.match(second.answer, /^Citation check before delivery: 7 of 10/);

  // Two rounds: refused twice, the first saying one more may follow.
  const two = routerWithAssistant();
  two.router.citeCheck = parseCiteCheck({ tools: [TOOL] }, ports);
  bindCiteRevise(two.router.citeCheck, parseCiteRevise({ revise: { rounds: 2, unverified_ratio: 0.2 } }));
  const r1 = await deliver(two.router, text);
  assert.match(r1.answer, /1 more round like this may follow\./);
  assert.equal((await deliver(two.router, text)).isError, true);
  assert.equal((await deliver(two.router, text)).isError, false);
  assert.equal(two.sent.length, 1);
});

test("CR2 at or under the ratio, or without revise, the checked text is delivered at once", async () => {
  for (const [n, ok, ratio] of [[10, 8, 0.2], [10, 10, 0], [10, 9, 0.1]] as const) {
    const { router, sent } = routerWithAssistant();
    const { text, ports } = report(n, ok);
    router.citeCheck = parseCiteCheck({ tools: [TOOL] }, ports);
    bindCiteRevise(router.citeCheck, parseCiteRevise({ revise: { rounds: 1, unverified_ratio: ratio } }));
    const r = await deliver(router, text);
    assert.equal(r.isError, false, `${n - ok} of ${n} at ratio ${ratio}`);
    assert.equal(sent.length, 1);
  }
  const { router, sent } = routerWithAssistant();
  const { text, ports } = report(10, 0);
  router.citeCheck = parseCiteCheck({ tools: [TOOL] }, ports);
  bindCiteRevise(router.citeCheck, parseCiteRevise({ tools: [TOOL] }));
  assert.equal((await deliver(router, text)).isError, false, "no revise: delivered whatever the check finds");
  assert.equal(sent.length, 1);
});

test("CR3 what revise accepts", () => {
  for (const bad of [undefined, null, {}, { revise: null }, { revise: { rounds: 0, unverified_ratio: 0.1 } }, { revise: { rounds: 1.5, unverified_ratio: 0.1 } },
    { revise: { rounds: "1", unverified_ratio: 0.1 } }, { revise: { rounds: 1, unverified_ratio: 1 } }, { revise: { rounds: 1, unverified_ratio: -0.1 } },
    { revise: { rounds: 1 } }, { revise: { rounds: 1, unverified_ratio: Number.NaN } }]) {
    assert.equal(parseCiteRevise(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseCiteRevise({ revise: { rounds: 9, unverified_ratio: 0 } })!.roundsLeft, CITE_REVISE_MAX_ROUNDS);
  assert.equal(CITE_REVISE_MAX_ROUNDS, 2);
  assert.equal(parseCiteRevise({ revise: { rounds: 1, unverified_ratio: 0.05 } })!.unverifiedRatio, 0.05);
  // Chinese marks are listed as well; the closing line, which names the mark, is not.
  assert.deepEqual(unverifiedLines("甲（未证实）。\n乙 [1]。\n\n引用核对：2 条中 1 条标为“未证实”（未证实）"), ["甲（未证实）。"]);
});

// --- CR4: the engine, with an assistant server that records deliver_text ---------------------------------------------------------
const delivered: string[] = [];
const srv = http.createServer((req, res) => {
  if (!req.url?.startsWith("/mcp")) { res.statusCode = 404; res.end(); return; }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const server = new McpServer({ name: "assistant", version: "1.0.0" });
    server.tool("deliver_text", "deliver a file", { name: z.string(), text: z.string() }, async (args) => {
      delivered.push(args.text);
      return { content: [{ type: "text" as const, text: "{\"ok\":true}" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const port = (srv.address() as AddressInfo).port;
test.after(async () => { await world.close(); await new Promise<void>((r) => srv.close(() => r())); });

// Its one source does not open (the server answers 404 there), so every statement is unverified.
const ENGINE_REPORT = ["- vLLM supports MI300X [1].", "- SGLang supports MI355X [1].", "", `[1]: a page — http://127.0.0.1:${port}/gone`].join("\n");

async function runWorker(citeCheck: Record<string, unknown>) {
  delivered.length = 0;
  let afterFirst = "";
  const turns: Turn[] = [
    { tool: TOOL, input: { name: "r.md", text: ENGINE_REPORT } },
    (body) => { afterFirst = body; return { tool: TOOL, input: { name: "r.md", text: ENGINE_REPORT } }; },
    { text: "done" },
  ];
  world.script(turns);
  await new AgentEngine().execute(
    baseRequest({
      session_id: `revise-${Math.random().toString(36).slice(2)}`,
      prompt: "research it",
      tools_allowlist: [TOOL],
      max_turns: 6,
      plugin_id: 9,
      plugin_tools: [{ id: 3, type: "mcp", name: "assistant", config: { mcpServers: { assistant: { type: "http", url: `http://127.0.0.1:${port}/mcp`, token: "t" } } } }],
      skip_platform_defaults: true,
      cite_check: citeCheck,
    }) as never,
    (async () => {}) as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never } as never,
  );
  return { delivered: [...delivered], afterFirst };
}

test("CR4 through the engine: the first delivery of a report over the ratio is refused, the second is made", async () => {
  const r = await runWorker({ tools: [TOOL], revise: { rounds: 1, unverified_ratio: 0.05 } });
  assert.equal(r.delivered.length, 1, "one file reaches the user");
  assert.match(r.delivered[0], /vLLM supports MI300X \(unverified\)\./);
  assert.match(r.afterFirst, /not delivered\. The citation check found 2 of 2 cited statements unverified/);

  const plain = await runWorker({ tools: [TOOL] });
  assert.equal(plain.delivered.length, 2, "without revise each delivery is made");
  assert.doesNotMatch(plain.afterFirst, /not delivered/);
});
