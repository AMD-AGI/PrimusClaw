// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * GitHub events for work items while CLAW_ASSISTANT_GITHUB_EVENTS is off (the default) and the assistant is on: no subscription
 * routes, no `work_subscribe` for the router, no `pr_reply` for the worker, and no loop reading GitHub. Needs no database: with the
 * switch off nothing here asks one.
 */
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

process.env.CLAW_ASSISTANT_ENABLED = "true";
delete process.env.CLAW_ASSISTANT_GITHUB_EVENTS;

describe("assistant GitHub events, switch off", () => {
  let app: FastifyInstance;
  let ev: typeof import("../src/assistant/github-events.js");
  let mcp: typeof import("../src/assistant/mcp.js");

  before(async () => {
    ev = await import("../src/assistant/github-events.js");
    mcp = await import("../src/assistant/mcp.js");
    const { registerAssistantGithubEventRoutes } = await import("../src/routes/assistant-github-events.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => { (req as any).user = { userId: "alice", userName: "alice", platformKey: "", virtualKey: "", roles: ["default"] }; });
    await registerAssistantGithubEventRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); });

  test("O1 the switch is off by default, and so is everything behind it", async () => {
    assert.equal(ev.githubEventsEnabled(), false);
    for (const [method, url] of [["POST", "/v1/work-items/x/subscriptions"], ["GET", "/v1/work-items/x/subscriptions"], ["DELETE", "/v1/work-items/x/subscriptions/1"]] as const) {
      assert.equal((await app.inject({ method, url, payload: method === "POST" ? { pr: "acme/app#1" } : undefined })).statusCode, 404, `${method} ${url}`);
    }
    const names = (claims: Record<string, unknown>) => Object.keys((mcp.createAssistantMcpServer(claims as never) as any)._registeredTools).sort();
    assert.deepEqual(names({ role: "router", sid: "s", mid: "m", task_id: "t", exp: 1 }), ["claw_self_status", "say", "work_create", "work_recall", "work_send", "work_stop"]);
    assert.deepEqual(names({ role: "worker", sid: "s", mid: "m", task_id: "t", exp: 1, item_id: "i", gen: 1 }), ["report"]);
    ev.startGithubEventWatch();
    assert.equal(ev.githubEventWatchRunning(), false, "nothing polls");
  });
});
