// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * (A tool of the trigger server itself that the tool catalog does not list is held by the catalog, mcp-approval-catalog.test.ts;
 * "a tool they do not hold" here is another server's.)
 *
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

import { GITHUB_MCP_PATH, GITHUB_MCP_SERVER, TRIGGER_MCP_PATH, TRIGGER_MCP_SERVER } from "@claw/protocol";
import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession } from "./support/plugin-world.js";
import { fakeNats } from "./support/fake-nats.js";

const world = await startWorld();
const pw = await startPluginWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
const { HITL_ENABLED, BASH_APPROVAL_DEFAULTS_ENABLED } = await import("../src/config.js");
test.after(async () => { await world.close(); await pw.close(); });

/** The server entry `applyTriggerToolsToTask` adds, at the API's path on the stub MCP server (it answers any path). */
const triggerUrl = `${new URL(pw.mcpUrl).origin}${TRIGGER_MCP_PATH}`;
const triggerServer = { type: "http", url: triggerUrl, token: "t", requires_approval: ["trigger_create", "trigger_cancel"] };
/** The server entry `githubMcpServers` adds: every tool held, its reads released (the stub's `ping` stands in for one). */
const githubServer = {
  type: "http", url: `${new URL(pw.mcpUrl).origin}${GITHUB_MCP_PATH}`, token: "t", requires_approval: true, auto_approve: ["ping"],
};
const operatorPlugin = (name: string) => ({
  id: 17, type: "mcp", name,
  config: { mcpServers: { [name]: { type: "http", url: pw.mcpUrl, token: "t", requires_approval: ["stop"] } } },
});

async function run(tool: string, opts: { operatorPolicy?: string; trigger?: boolean; github?: boolean; decision?: string } = {}) {
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
      mcp_servers: {
        // A server no rule and no catalog entry covers: its tool is the one "nobody holds".
        scratch: { type: "http", url: pw.mcpUrl, token: "t" },
        ...(opts.trigger === false ? {} : { [TRIGGER_MCP_SERVER]: triggerServer }),
        ...(opts.github ? { [GITHUB_MCP_SERVER]: githubServer } : {}),
      },
      ...(opts.operatorPolicy ? { plugin_id: 5, plugin_tools: [operatorPlugin(opts.operatorPolicy)] } : {}),
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
  // The built-in bash rules are on too (the default): they are the platform's like the trigger hold, so they must
  // not make every other call of the turn wait either.
  assert.equal(BASH_APPROVAL_DEFAULTS_ENABLED, true);
});

test("with the trigger tools on, a tool they do not hold runs without asking anyone", async () => {
  const r = await run("mcp__scratch__ping");
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
  const r = await run(`mcp__${TRIGGER_MCP_SERVER}__ping`, { operatorPolicy: "board", decision: "allow" });
  assert.deepEqual(r.asked, [`mcp__${TRIGGER_MCP_SERVER}__ping`], "HITL_ENABLED asks once an operator policy is in play");
  assert.equal(r.ran, 1, "and the allowed call runs");
});

test("an operator's server that only shares the trigger server's name is still a policy", async () => {
  const r = await run(`mcp__${TRIGGER_MCP_SERVER}__ping`, { operatorPolicy: TRIGGER_MCP_SERVER, trigger: false, decision: "allow" });
  assert.deepEqual(r.asked, [`mcp__${TRIGGER_MCP_SERVER}__ping`], "known by name and path, not by name alone");
  assert.equal(r.ran, 1);
});

test("with the GitHub tools on, a tool they do not hold runs without asking anyone", async () => {
  const r = await run("mcp__scratch__ping", { github: true });
  assert.deepEqual(r.asked, [], "the GitHub server's hold is the platform's: it holds its own tools only");
  assert.equal(r.ran, 1);
});

test("a GitHub write is still held for the user, and a released read runs", async () => {
  const w = await run(`mcp__${GITHUB_MCP_SERVER}__issue_comment`, { github: true, decision: "deny" });
  assert.deepEqual(w.asked, [`mcp__${GITHUB_MCP_SERVER}__issue_comment`]);
  assert.equal(w.ran, 0);
  const r = await run(`mcp__${GITHUB_MCP_SERVER}__ping`, { github: true });
  assert.deepEqual(r.asked, []);
  assert.equal(r.ran, 1);
});

test("an operator's server named github at another path is still a policy", async () => {
  const r = await run(`mcp__${TRIGGER_MCP_SERVER}__ping`, { operatorPolicy: GITHUB_MCP_SERVER, decision: "allow" });
  assert.deepEqual(r.asked, [`mcp__${TRIGGER_MCP_SERVER}__ping`]);
  assert.equal(r.ran, 1);
});
