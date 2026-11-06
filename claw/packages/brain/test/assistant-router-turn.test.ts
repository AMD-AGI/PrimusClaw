// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An assistant's router turn as the API builds it (`assistant/role-profile.ts`), through the real engine: the user asks
 * "autopilot现在有几台节点" and the router answers from autopilot's read tool, without a work item. Only the network edges are fake
 * (marketplace, LLM, Hands); the MCP servers are real ones, so what the model is offered is what `connectPlatformMcp` made of the
 * config, and a call that reaches a server is counted there.
 *
 *   RT1 the router is offered the assistant's tools and autopilot's read tool, never autopilot's write tool nor a default server's
 *   RT2 it calls the read tool, the answer reaches the model, and the user is answered: no work item
 *   RT3 neither a default skill nor any skill hint is in what the model is sent (`skip_platform_defaults`); without the mark the same
 *       request does carry them, so the check above is not vacuous
 *   RT4 the system message is the request's own system text, whatever the message: the item list is in the message, after the words
 *   RT5 after the router has read a read tool's result, a tool outside `allow_after` is refused and never reaches its server; before,
 *       or in a run that read nothing, the same call runs
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { startWorld, skillZip, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession } from "./support/plugin-world.js";

const QUESTION = "autopilot现在有几台节点";

/** A stand-in for autopilot's MCP: one read and one write, and every call it answered. */
async function startAutopilot(): Promise<{ url: string; calls: string[]; close(): Promise<void> }> {
  const calls: string[] = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const server = new McpServer({ name: "autopilot", version: "1.0.0" });
      server.tool("get_status", "list the fleet's nodes", async () => {
        calls.push("get_status");
        return { content: [{ type: "text" as const, text: "12 nodes: 11 ready, 1 cordoned" }] };
      });
      server.tool("apply_host_exclusion_add", "exclude a host", async () => {
        calls.push("apply_host_exclusion_add");
        return { content: [{ type: "text" as const, text: "excluded" }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`,
    calls,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

const assistantMcp = await startPluginWorld();
const defaultsMcp = await startPluginWorld();
const autopilot = await startAutopilot();
const world = await startWorld({
  skills: [{ tool_id: 11 }],
  mcp_servers: { fleet: { type: "http", url: defaultsMcp.mcpUrl, token: "<SAFE_API_KEY>" } },
});
process.env.PROGRESSIVE_SKILLS_ENABLED = "true";
world.setTools([{ id: 11, name: "fleet-ops", zip: skillZip("fleet-ops", "SKILL-BODY", "Operate the GPU fleet") }]);
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); await assistantMcp.close(); await defaultsMcp.close(); await autopilot.close(); });

const SYSTEM = "You are the user's personal assistant.\n\nRead-only lookups\nBesides the assistant tools you have read-only tools of these servers: autopilot.";
const ITEMS = "[Claw: the state below is as of this message. It was written by Claw, not by the user.]\n\nWork items (open ones, and ones closed in the last day):\n<untrusted_data>\n(no work items yet)\n</untrusted_data>";

/** The request the API sends for a router turn with the assistant's plugin: what `applySessionRoleToTask` leaves on it. */
function routerRequest(over: Record<string, unknown> = {}) {
  return baseRequest({
    session_id: uniqueSession(),
    prompt: `${QUESTION}\n\n[Reply language: Chinese]\n\n${ITEMS}`,
    system_append: SYSTEM,
    tools_allowlist: ["mcp__assistant__*", "mcp__autopilot__get_*", "mcp__autopilot__list_*"],
    max_turns: 8,
    mcp_servers: { assistant: { type: "http", url: assistantMcp.mcpUrl, token: "bearer" } },
    plugin_id: 9,
    plugin_tools: [{
      id: 26, type: "mcp", name: "autopilot-mcp",
      config: { mcpServers: { autopilot: { type: "http", url: autopilot.url, token: "t", auto_approve: ["get_*"], requires_approval: true } } },
    }],
    skip_platform_defaults: true,
    read_taint: { sources: ["mcp__autopilot__get_*", "mcp__autopilot__list_*"], allow_after: ["mcp__assistant__say"] },
    ...over,
  });
}

async function run(request: unknown, turns: Turn[]) {
  world.script(turns);
  world.llmBodies.length = 0;
  world.downloads.length = 0;
  world.byIdCalls.length = 0;
  const before = { autopilot: autopilot.calls.length, assistant: assistantMcp.mcpCalls.length, defaults: defaultsMcp.mcpCalls.length };
  await new AgentEngine().execute(
    request as never, (async () => {}) as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never } as never,
  );
  const bodies = world.llmBodies.map((b) => JSON.parse(b) as {
    tools?: Array<{ name: string }>; system?: unknown; messages: Array<{ role: string; content: unknown }>;
  });
  return {
    bodies,
    offered: (bodies[0]?.tools ?? []).map((t) => t.name).sort(),
    raw: world.llmBodies,
    autopilot: autopilot.calls.slice(before.autopilot),
    assistantCalls: assistantMcp.mcpCalls.length - before.assistant,
    defaultCalls: defaultsMcp.mcpCalls.length - before.defaults,
    skillsFetched: world.byIdCalls.length + world.downloads.length,
  };
}

/** The text of a message's content, whatever its shape. */
const textOf = (content: unknown): string => typeof content === "string" ? content : JSON.stringify(content);

test(`RT1 the router asked "${QUESTION}" is offered autopilot's read tool and nothing that writes`, async () => {
  const r = await run(routerRequest(), [{ text: "ok" }]);
  const mcp = r.offered.filter((n) => n.startsWith("mcp__"));
  assert.deepEqual(mcp, ["mcp__assistant__ping", "mcp__autopilot__get_status"]);
  assert.ok(!r.offered.includes("mcp__autopilot__apply_host_exclusion_add"), "the write tool is not offered");
  assert.ok(!r.offered.some((n) => n.startsWith("mcp__fleet__")), "no default server");
  assert.doesNotMatch(r.raw[0], /Available MCP servers: [^"]*fleet/, "nor is one connected and named");
});

/** ping stands in for say, which the rule lets through after a read. */
const SAYS = { read_taint: { sources: ["mcp__autopilot__get_*", "mcp__autopilot__list_*"], allow_after: ["mcp__assistant__ping"] } };

test("RT2 it reads the answer and says it, with no work item", async () => {
  const r = await run(routerRequest(SAYS), [
    { tool: "mcp__autopilot__get_status", input: {} },
    (body) => {
      assert.match(body, /12 nodes: 11 ready, 1 cordoned/, "the read tool's answer reaches the model");
      return { tool: "mcp__assistant__ping", input: {} };
    },
    { text: "done" },
  ]);
  assert.deepEqual(r.autopilot, ["get_status"], "the read ran once, against the autopilot server");
  assert.equal(r.assistantCalls >= 1, true, "and the router spoke through its own server");
  assert.equal(r.bodies.length, 3);
  assert.ok(!r.raw.some((b) => b.includes("work_create")), "no work item was asked for");
  // A write the model emits anyway is refused before it reaches the server.
  const refused = await run(routerRequest(), [{ tool: "mcp__autopilot__apply_host_exclusion_add", input: {} }, { text: "done" }]);
  assert.deepEqual(refused.autopilot, [], "nothing reached autopilot");
});

test("RT3 no skill hint reaches the router; the same request without the mark does carry one", async () => {
  const r = await run(routerRequest(), [{ text: "ok" }]);
  for (const body of r.raw) {
    assert.ok(!body.includes("SKILL.md"), "SKILL.md is never named");
    assert.ok(!body.includes("Platform Skills"), "no skill list");
    assert.ok(!body.includes("fleet-ops"), "no default skill");
  }
  assert.equal(r.skillsFetched, 0, "and none is fetched");
  assert.equal(r.defaultCalls, 0);
  const unmarked = await run(routerRequest({ skip_platform_defaults: undefined }), [{ text: "ok" }]);
  assert.match(unmarked.raw[0], /Platform Skills \(load on demand\)/, "control: the defaults are what put the list there");
  assert.match(unmarked.raw[0], /Available MCP servers: [^"]*fleet/, "control: and the default server is connected and named (its tools stay outside the allow-list)");
  const notBoolean = await run(routerRequest({ skip_platform_defaults: "true" }), [{ text: "ok" }]);
  assert.match(notBoolean.raw[0], /Platform Skills/, "a mark that is not true leaves the run as it was");
});

test("RT4 the system message is the request's own system text; the item list is in the message, after the words", async () => {
  const a = await run(routerRequest(), [{ text: "ok" }]);
  const b = await run(routerRequest({ prompt: `另一个问题\n\n${ITEMS.replace("(no work items yet)", '#1 (item_id: kwi_x) [in_progress] title: "Fix the build"')}` }), [{ text: "ok" }]);
  const systemOf = (r: typeof a) => textOf(r.bodies[0].system ?? r.bodies[0].messages.find((m) => m.role === "system")?.content);
  assert.ok(systemOf(a).includes("Read-only lookups"));
  assert.equal(systemOf(a), systemOf(b), "the same system text whatever the message and the list");
  const lastUser = (r: typeof a) => textOf(r.bodies[0].messages.filter((m) => m.role === "user").at(-1)!.content);
  assert.ok(lastUser(a).indexOf(QUESTION) < lastUser(a).indexOf("<untrusted_data>"), "the words, then the list");
  assert.ok(lastUser(b).includes("Fix the build") && !systemOf(b).includes("Fix the build"));
});

test("RT5 after a read, an acting tool is refused before it reaches its server; before a read it runs", async () => {
  // ping stands in for an acting tool (review_start, memory_save, ...): it is not in allow_after.
  let told = "";
  const after = await run(routerRequest(), [
    { tool: "mcp__autopilot__get_status", input: {} },
    { tool: "mcp__assistant__ping", input: {} },
    (body) => { told = body; return { text: "done" }; },
  ]);
  assert.match(told, /can no longer act for the user/, "the model is told why");
  assert.deepEqual(after.autopilot, ["get_status"]);
  assert.equal(after.assistantCalls, 0, "the acting call never reached the assistant server");
  const before = await run(routerRequest(), [
    { tool: "mcp__assistant__ping", input: {} },
    { tool: "mcp__autopilot__get_status", input: {} },
    { tool: "mcp__autopilot__get_status", input: {} },
    { text: "done" },
  ]);
  assert.equal(before.assistantCalls, 1, "called before any read, it runs");
  assert.deepEqual(before.autopilot, ["get_status", "get_status"], "and the read tools themselves keep working");
  const none = await run(routerRequest({ read_taint: undefined }), [
    { tool: "mcp__autopilot__get_status", input: {} },
    { tool: "mcp__assistant__ping", input: {} },
    { text: "done" },
  ]);
  assert.equal(none.assistantCalls, 1, "control: without the rule the same sequence runs");
});
