// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `auto_approve`, end to end through the real engine: a plugin's MCP server spec
 * carries `requires_approval` and `auto_approve`, a session with no approval
 * channel (nobody to ask, as for an unattended run) makes the call, and a real
 * MCP server says whether the tool ran. Only the network edges are fake: LLM,
 * S3, the MCP server, Hands.
 *
 * Pins, as rows: a listed tool runs without a decision; the same tool unlisted,
 * listed with a `when` its call does not meet, listed under a malformed field,
 * or with no `auto_approve` at all (today's behaviour) is held, never runs, and
 * the model is told it was not done.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession } from "./support/plugin-world.js";

const world = await startWorld();
const pw = await startPluginWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); await pw.close(); });

const mcpTool = (server: Record<string, unknown>) => ({
  id: 17, type: "mcp", name: "board",
  config: { mcpServers: { board: { type: "http", url: pw.mcpUrl, token: "t", ...server } } },
});

async function run(server: Record<string, unknown>, input: Record<string, unknown> = {}) {
  world.script([{ tool: "mcp__board__ping", input }, { text: "done" }]);
  world.llmBodies.length = 0;
  const events: Array<Record<string, unknown>> = [];
  const onEvent = async (e: unknown) => { events.push(e as Record<string, unknown>); };
  const before = pw.mcpCalls.length;
  // No natsConnection in the extras: nobody can be asked.
  const extras = { attachHands: async () => fakeHands() as never };
  await new AgentEngine().execute(
    baseRequest({ session_id: uniqueSession(), plugin_id: 5, plugin_tools: [mcpTool(server)] }),
    onEvent as never, undefined, null as never, extras as never,
  );
  return { ran: pw.mcpCalls.length - before, events, modelSaw: world.llmBodies[1] ?? "" };
}

const rows: Array<{ name: string; server: Record<string, unknown>; input?: Record<string, unknown>; runs: boolean; unheld?: boolean }> = [
  { name: "listed by name", server: { requires_approval: true, auto_approve: ["ping"] }, runs: true },
  { name: "listed by prefix, camelCase spellings", server: { requiresApproval: ["pi*"], autoApprove: ["pi*"] }, runs: true },
  { name: "listed with a when the call meets", server: { requires_approval: true, auto_approve: [{ tool: "ping", when: { target: "j1" } }] }, input: { target: "j1" }, runs: true },
  { name: "held and not listed", server: { requires_approval: true, auto_approve: ["other"] }, runs: false },
  { name: "no auto_approve: today's behaviour", server: { requires_approval: true }, runs: false },
  { name: "listed with a when the call does not meet", server: { requires_approval: true, auto_approve: [{ tool: "ping", when: { target: "j1" } }] }, input: { target: "j2" }, runs: false },
  { name: "a when on an argument the call lacks", server: { requires_approval: true, auto_approve: [{ tool: "ping", when: { target: "j1" } }] }, runs: false },
  { name: "malformed auto_approve releases nothing", server: { requires_approval: true, auto_approve: ["ping", 5] }, runs: false },
  { name: "a bare * is not a release", server: { requires_approval: true, auto_approve: ["*"] }, runs: false },
  { name: "auto_approve without requires_approval changes nothing: the tool just runs", server: { auto_approve: ["other"] }, runs: true, unheld: true },
];

for (const row of rows) {
  test(row.name, async () => {
    const r = await run(row.server, row.input);
    assert.equal(r.ran, row.runs ? 1 : 0, row.runs ? "the MCP tool ran in Brain" : "the MCP tool did not run");
    assert.equal(r.events.some((e) => e.type === "permissionRequest"), false, "no card: nobody is there to read it");
    const decided = r.events.filter((e) => e.type === "decisionResult");
    // A release is recorded as the policy's; a tool nothing held has no decision to record.
    const released = row.runs && !row.unheld;
    assert.deepEqual(decided.map((e) => e.by), released ? ["policy"] : [], "released by policy, recorded as such");
    if (!row.runs) assert.match(r.modelSaw, /No approval channel is available, so this action required approval and was not executed/);
  });
}
