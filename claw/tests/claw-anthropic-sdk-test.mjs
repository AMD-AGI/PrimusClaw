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

const client = new Anthropic({ apiKey: API_KEY, baseURL: BASE_URL });

function log(step, obj) {
  console.log(`\n=== ${step} ===`);
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  console.log(`baseURL=${BASE_URL}`);

  const agent = await client.beta.agents.create({
    name: "SDK Compat Smoke",
    model: "claude-opus-4-6",
    system: "You are a concise coding assistant.",
    tools: [{ type: "agent_toolset_20260401" }],
  });
  log("agents.create", agent);

  const environment = await client.beta.environments.create({
    name: "sdk-compat-env",
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  log("environments.create", environment);

  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: environment.id,
    title: "SDK compat smoke",
  });
  log("sessions.create", session);

  const stream = await client.beta.sessions.events.stream(session.id);
  console.log("\n=== stream() resolved, sending user.message ===");

  const sendResult = await client.beta.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: [{ type: "text", text: "Say hello in exactly three words." }] }],
  });
  log("events.send", sendResult);

  let gotMessage = false;
  let gotIdle = false;
  const messages = [];
  const timeoutMs = 120_000;
  const deadline = Date.now() + timeoutMs;

  console.log("\n=== consuming stream ===");
  for await (const event of stream) {
    console.log(`[event] ${event.type}`);
    if (event.type === "agent.message") {
      gotMessage = true;
      for (const block of event.content) {
        if (block.type === "text") messages.push(block.text);
      }
    } else if (event.type === "agent.tool_use") {
      console.log(`  tool_use name=${event.name}`);
    } else if (event.type === "session.status_idle") {
      gotIdle = true;
      break;
    }
    if (Date.now() > deadline) {
      console.log("TIMEOUT waiting for session.status_idle");
      break;
    }
  }

  console.log("\n=== RESULT ===");
  console.log("got agent.message:", gotMessage);
  console.log("got session.status_idle:", gotIdle);
  console.log("assistant text:", messages.join(""));

  if (!gotMessage || !gotIdle) {
    console.log("\nFAIL: Quickstart flow did not complete as expected.");
    process.exit(1);
  }
  console.log("\nPASS: Quickstart flow completed.");
}

main().catch((err) => {
  console.error("\n=== ERROR ===");
  console.error(err);
  process.exit(1);
});
