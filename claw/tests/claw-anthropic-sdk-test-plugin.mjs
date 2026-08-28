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
const PLUGIN_ID = 1; // skill-test-plugin, wraps secret-marker-skill

const client = new Anthropic({ apiKey: API_KEY, baseURL: BASE_URL });

function log(step, obj) {
  console.log(`\n=== ${step} ===`);
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const agent = await client.beta.agents.create({
    name: "Plugin-backed agent",
    model: "claude-opus-4-6",
    metadata: { primus_claw: JSON.stringify({ plugin_id: PLUGIN_ID }) },
  });
  log("agents.create", agent);
  if (agent.id !== `plugin_${PLUGIN_ID}`) {
    console.log(`FAIL: expected agent.id="plugin_${PLUGIN_ID}", got "${agent.id}"`);
    process.exit(1);
  }
  console.log(`OK: agent.id correctly resolved to plugin_${PLUGIN_ID}`);

  const environment = await client.beta.environments.create({ name: "plugin-test-env" });
  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: environment.id,
    title: "Plugin skill smoke",
  });
  log("sessions.create", session);
  if (session.agent.id !== `plugin_${PLUGIN_ID}`) {
    console.log(`FAIL: expected session.agent.id="plugin_${PLUGIN_ID}", got "${session.agent.id}"`);
    process.exit(1);
  }

  const stream = await client.beta.sessions.events.stream(session.id);
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: [{ type: "text", text: "Say hello in exactly three words." }] }],
  });

  let gotIdle = false;
  const messages = [];
  for await (const event of stream) {
    console.log(`[event] ${event.type}`);
    if (event.type === "agent.message") {
      for (const block of event.content) if (block.type === "text") messages.push(block.text);
    } else if (event.type === "session.status_idle") {
      gotIdle = true;
      break;
    }
  }

  const fullText = messages.join("");
  console.log("\n=== RESULT ===");
  console.log("assistant text:", fullText);
  console.log("got session.status_idle:", gotIdle);

  const hasMarker = fullText.includes("SKILL_MARKER_7f3a9c");
  console.log("skill marker present:", hasMarker);

  if (!gotIdle) {
    console.log("FAIL: no session.status_idle");
    process.exit(1);
  }
  if (!hasMarker) {
    console.log("FAIL: skill content did not reach the model (marker missing)");
    process.exit(1);
  }
  console.log("PASS: plugin_id -> skill pipeline verified end-to-end.");
}

main().catch((err) => {
  console.error("=== ERROR ===");
  console.error(err);
  process.exit(1);
});
