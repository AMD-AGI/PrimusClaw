// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A call the model made by an offered MCP tool's short name (`tools/offered-name.ts`): the assistant router's `say` called as
 * `say` beside `web_fetch` (parity R1/R2, 2026-11-07: refused, so the answer went out as plain text without its sources).
 *
 *   N1 a short name is the one offered `mcp__<server>__<name>`; anything else keeps its name
 *   N2 the agent loop runs the call as the full name: the allowlist lets it through, the router and the hook see the full name,
 *      and the history the next request replays names it so
 *   N3 a short name that is no offered tool's is refused as before
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import { offeredToolName } from "../src/tools/offered-name.js";
import { parseToolAllowlist, toolNotAllowedMessage } from "../src/tools/allowlist.js";
import type { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";

const SAY = "mcp__assistant__say";
const ROUTER_TOOLS = ["web_search", "web_fetch", SAY, "mcp__assistant__work_create", "mcp__github__pr_get"];

test("N1 a short name is the one offered mcp__<server>__<name>; anything else keeps its name", () => {
  assert.equal(offeredToolName("say", ROUTER_TOOLS), SAY);
  assert.equal(offeredToolName("work_create", ROUTER_TOOLS), "mcp__assistant__work_create");
  assert.equal(offeredToolName("pr_get", ROUTER_TOOLS), "mcp__github__pr_get");
  assert.equal(offeredToolName("web_fetch", ROUTER_TOOLS), null, "an offered name is itself");
  assert.equal(offeredToolName(SAY, ROUTER_TOOLS), null, "a full name is itself");
  assert.equal(offeredToolName("bash", ROUTER_TOOLS), null, "no offered tool is named so");
  assert.equal(offeredToolName("say", ["mcp__assistant__say", "mcp__board__say"]), null, "two servers' tools: it means neither");
  assert.equal(offeredToolName("say", ["mcp____say"]), null, "a name with no server part");
  assert.equal(offeredToolName("b__say", ["mcp__a__b__say"]), null, "a short name with a server part is not short");
  assert.equal(offeredToolName("say", ["mcp__a__b__say"]), null, "only the last part of a one-server name");
  assert.equal(offeredToolName("", ROUTER_TOOLS), null);
  assert.equal(offeredToolName(undefined, ROUTER_TOOLS), null);
  assert.equal(offeredToolName("say", []), null);
});

const schema = (name: string): ToolSchema =>
  ({ name, description: name, input_schema: { type: "object", properties: {} } }) as unknown as ToolSchema;

function scriptedSession(turns: Array<{ content: LlmContentBlock[]; stopReason: string }>): LlmSession & { calls: Array<{ messages: Message[] }> } {
  const calls: Array<{ messages: Message[] }> = [];
  let i = 0;
  return {
    calls,
    async streamTurn(messages) {
      calls.push({ messages: JSON.parse(JSON.stringify(messages)) });
      const turn = turns[i++];
      if (!turn) throw new Error(`scripted session exhausted after ${i - 1} turns`);
      return {
        content: turn.content, stopReason: turn.stopReason,
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1,
      } as LlmTurnResult;
    },
    async complete() { return "summary"; },
  };
}

type Ev = Record<string, unknown>;

function run(content: LlmContentBlock[]) {
  const session = scriptedSession([
    { content, stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ]);
  const routed: string[] = [];
  const hooked: string[] = [];
  const router = {
    route: async (name: string) => { routed.push(name); return "ok"; },
    setHands: () => {},
    classifyShell: async () => ({ shellClass: "finished", collectorLive: false }),
  } as unknown as ToolRouter;
  const events: Ev[] = [];
  const opts: LoopOptions = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 4, router, llmSession: session,
    onEvent: async (e: unknown) => { events.push(e as Ev); }, sessionId: "s", userId: "u",
    toolAllowlist: parseToolAllowlist(["mcp__assistant__*", "mcp__github__*", "web_search", "web_fetch"]),
    hooks: { has: () => true, run: async (event: string, p: { tool_name?: string }) => { if (event === "PreToolUse") hooked.push(String(p.tool_name)); return { block: false }; } } as unknown as LoopOptions["hooks"],
  };
  return { session, routed, hooked, events, done: agentLoop([{ role: "user", content: "go" }], ROUTER_TOOLS.map(schema), opts) };
}

test("N2 the loop runs a short-named call as the offered tool, and the history names it so", async () => {
  const r = run([
    { type: "tool_use", id: "t1", name: "say", input: { text: "查一下" } },
    { type: "tool_use", id: "t2", name: "web_fetch", input: { url: "https://dl.k8s.io/release/stable.txt" } },
  ] as LlmContentBlock[]);
  const result = await r.done;
  assert.deepEqual(r.routed, [SAY, "web_fetch"], "say reached the router under its full name");
  assert.deepEqual(r.hooked, [SAY, "web_fetch"], "the hook saw the full name");
  assert.equal(result.errorCount, 0, "nothing was refused");
  assert.equal(r.events.some((e) => e.type === "toolUsed" && e.status === "error"), false);
  assert.equal(r.events.some((e) => e.type === "toolUsed" && e.tool === SAY && e.status === "start"), true);
  const replayed = r.session.calls[1].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as Ev[];
  assert.deepEqual(replayed.filter((b) => b.type === "tool_use").map((b) => b.name), [SAY, "web_fetch"]);
  assert.deepEqual(replayed.filter((b) => b.type === "tool_result").map((b) => String(b.content)), ["ok", "ok"]);
});

test("N3 a short name that is no offered tool's is refused as before", async () => {
  const r = run([{ type: "tool_use", id: "t1", name: "bash", input: { command: "id" } }] as LlmContentBlock[]);
  const result = await r.done;
  assert.deepEqual(r.routed, []);
  assert.equal(result.errorCount, 1);
  const replayed = r.session.calls[1].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as Ev[];
  assert.equal(String(replayed.find((b) => b.type === "tool_result")?.content), toolNotAllowedMessage("bash"));
});
