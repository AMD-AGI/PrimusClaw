// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The API gives an owned turn the trigger tools as an MCP server whose `requires_approval` holds trigger_create and
 * trigger_cancel. With HITL_ENABLED=true that rule must hold those two and nothing else: counted as an operator's
 * approval policy, it made every call of the turn wait for a person, so a worker or doorbell turn nobody watches
 * stopped at its first tool. An operator's own policy still turns HITL_ENABLED on for the rest of the turn.
 *
 * End to end through the real engine; only the network edges are fake: the LLM, Hands, NATS and the MCP server.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.HITL_ENABLED = "true";
// Short, so a call that is wrongly held fails this suite in seconds rather than after the default wait.
process.env.HITL_DECISION_TIMEOUT_MS = "2000";

import { TRIGGER_MCP_SERVER } from "@claw/protocol";
import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession } from "./support/plugin-world.js";
import { fakeNats } from "./support/fake-nats.js";

const world = await startWorld();
const pw = await startPluginWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
const { HITL_ENABLED } = await import("../src/config.js");
test.after(async () => { await world.close(); await pw.close(); });

/** The server entry `applyTriggerToolsToTask` adds, pointed at the stub MCP server. */
const triggerServer = { type: "http", url: pw.mcpUrl, token: "t", requires_approval: ["trigger_create", "trigger_cancel"] };
const operatorPlugin = {
  id: 17, type: "mcp", name: "board",
  config: { mcpServers: { board: { type: "http", url: pw.mcpUrl, token: "t", requires_approval: ["stop"] } } },
};

async function run(tool: string, opts: { operatorPolicy?: boolean; decision?: string } = {}) {
  world.script([{ tool, input: {} }, { text: "done" }]);
  world.llmBodies.length = 0;
  const nats = fakeNats();
  const events: Array<Record<string, unknown>> = [];
  const onEvent = async (e: unknown) => {
    const ev = e as Record<string, unknown>;
    events.push(ev);
    if (ev.type === "permissionRequest" && opts.decision) {
      nats.answer({ type: "decision", session_id: "s", action_id: ev.actionId, decision: opts.decision });
    }
  };
  const before = pw.mcpCalls.length;
  await new AgentEngine().execute(
    baseRequest({
      session_id: uniqueSession(),
      mcp_servers: { [TRIGGER_MCP_SERVER]: triggerServer },
      ...(opts.operatorPolicy ? { plugin_id: 5, plugin_tools: [operatorPlugin] } : {}),
    }),
    onEvent as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never, natsConnection: nats } as never,
  );
  return {
    ran: pw.mcpCalls.length - before,
    asked: events.filter((e) => e.type === "permissionRequest").map((e) => e.tool),
    // The last call: a held tool first asks the summary model for its card.
    modelSaw: world.llmBodies.at(-1) ?? "",
  };
}

test("the premise: HITL_ENABLED is on and a person can be asked", () => {
  assert.equal(HITL_ENABLED, true);
});

test("with the trigger tools on, a tool they do not hold runs without asking anyone", async () => {
  const r = await run(`mcp__${TRIGGER_MCP_SERVER}__ping`);
  assert.deepEqual(r.asked, [], "nobody is asked: an unattended turn would wait here for the whole decision timeout");
  assert.equal(r.ran, 1, "the tool ran");
  assert.equal(r.modelSaw.includes("not executed"), false);
});

test("trigger_create is still held for the user", async () => {
  const r = await run(`mcp__${TRIGGER_MCP_SERVER}__trigger_create`, { decision: "deny" });
  assert.deepEqual(r.asked, [`mcp__${TRIGGER_MCP_SERVER}__trigger_create`], "the held tool is asked about");
  assert.equal(r.ran, 0, "and does not run on a deny");
  assert.match(r.modelSaw, /The user denied this action; it was not executed/);
});

test("an operator's own policy still makes HITL_ENABLED ask about the other tools", async () => {
  const r = await run(`mcp__${TRIGGER_MCP_SERVER}__ping`, { operatorPolicy: true, decision: "allow" });
  assert.deepEqual(r.asked, [`mcp__${TRIGGER_MCP_SERVER}__ping`], "HITL_ENABLED asks once an operator policy is in play");
  assert.equal(r.ran, 1, "and the allowed call runs");
});
