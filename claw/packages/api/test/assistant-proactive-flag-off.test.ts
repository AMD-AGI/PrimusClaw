// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant on with triggers, the trigger tools and job watches off (the defaults): a router is offered the tools it had
 * before, no loop starts, the routes for the cards do not exist and the router's prompt says nothing about acting later.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.CLAW_ASSISTANT_ENABLED = "true";
process.env.CLAW_ASSISTANT_TOKEN_KEY = "assistant-test-token-key-0123456789abcdef";
delete process.env.CLAW_TRIGGERS_ENABLED;
delete process.env.CLAW_TRIGGER_TOOLS_ENABLED;
delete process.env.CLAW_ASSISTANT_JOB_EVENTS;
delete process.env.CLAW_ASSISTANT_GITHUB_EVENTS;

test("with the switches off nothing of acting later is offered, started or registered", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createAssistantMcpServer } = await import("../src/assistant/mcp.js");
  const jw = await import("../src/assistant/job-watch.js");
  const sch = await import("../src/assistant/schedules.js");
  const prompt = await import("../src/assistant/proactive-prompt.js");
  const Fastify = (await import("fastify")).default;

  const server = createAssistantMcpServer({ sid: "s", role: "router", mid: "m", task_id: "t", exp: 4102444800 } as never, false, false, false);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  assert.deepEqual((await client.listTools()).tools.map((x) => x.name).sort(), ["claw_self_status", "deliver_text", "say", "work_create", "work_recall", "work_send", "work_stop"]);
  await client.close();

  assert.equal(sch.assistantSchedulesOn(), false);
  assert.equal(jw.jobWatchesEnabled(), false);
  jw.startJobWatch(10);
  try {
    assert.equal(jw.jobWatchRunning(), false, "no loop polls");
  } finally {
    jw.stopJobWatch();
  }
  assert.equal(prompt.renderRouterProactiveSection({ schedules: false, jobs: false, pullRequests: false }), "");

  const app = Fastify();
  await (await import("../src/routes/assistant-proactive.js")).registerAssistantProactiveRoutes(app);
  await app.ready();
  const routes = app.printRoutes({ commonPrefix: false });
  assert.match(routes, /\/v1\/assistant\/brief/, "the brief needs only the assistant");
  assert.doesNotMatch(routes, /confirmations/, "no cards without the router's schedule tools");
  await app.close();
});
