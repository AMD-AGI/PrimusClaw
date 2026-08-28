// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import Anthropic from "@anthropic-ai/sdk";

const BASE_URL = process.env.ANTHROPIC_BASE_URL;
const API_KEY = process.env.API_KEY || process.env.ANTHROPIC_API_KEY;
if (!BASE_URL) {
  console.error("ERROR: set ANTHROPIC_BASE_URL explicitly; refusing to choose a public endpoint.");
  process.exit(1);
}
if (!API_KEY) {
  console.error("ERROR: set API_KEY (ak-...) via env, e.g. API_KEY=ak-... node <script>");
  process.exit(1);
}
const PLUGIN_ID = 2; // mcp-test-plugin, wraps @modelcontextprotocol/server-everything

const client = new Anthropic({ apiKey: API_KEY, baseURL: BASE_URL });

async function main() {
  const agent = await client.beta.agents.create({
    name: "MCP-backed agent",
    model: "claude-opus-4-6",
    metadata: { primus_claw: JSON.stringify({ plugin_id: PLUGIN_ID }) },
  });
  console.log("agent.id:", agent.id);

  const environment = await client.beta.environments.create({ name: "mcp-test-env" });
  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: environment.id,
    title: "MCP tool smoke",
  });
  console.log("session.id:", session.id);

  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [{
      type: "user.message",
      content: [{ type: "text", text: "You have an MCP tool called 'echo' available. Call it with the text 'MCP_TEST_OK' and report exactly what it returns." }],
    }],
  });

  let gotIdle = false;
  let usedTool = false;
  const toolNames = [];
  const messages = [];
  for await (const event of stream) {
    console.log(`[event] ${event.type}${event.name ? " name=" + event.name : ""}`);
    if (event.type === "agent.tool_use") {
      usedTool = true;
      toolNames.push(event.name);
      console.log("  input:", JSON.stringify(event.input));
    } else if (event.type === "agent.message") {
      for (const block of event.content) if (block.type === "text") messages.push(block.text);
    } else if (event.type === "session.status_idle") {
      gotIdle = true;
      break;
    }
  }

  console.log("\n=== RESULT ===");
  console.log("assistant text:", messages.join(""));
  console.log("used any tool:", usedTool, "names:", toolNames);
  console.log("got session.status_idle:", gotIdle);

  if (!gotIdle) { console.log("FAIL: no session.status_idle"); process.exit(1); }
  if (!usedTool) { console.log("FAIL (or inconclusive): model never called a tool -- MCP server may not have started, or model chose not to call it"); process.exit(1); }
  console.log("PASS: MCP-provided tool was invoked via the Anthropic compat layer.");
}

main().catch((err) => {
  console.error("=== ERROR ===");
  console.error(err);
  process.exit(1);
});
