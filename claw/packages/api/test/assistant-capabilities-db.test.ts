// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * claw_capabilities on a real Postgres, through the assistant's MCP route as Brain reaches it (`assistant/capabilities.ts`, `mcp.ts`;
 * the list itself is tested in assistant-capabilities.test.ts).
 *
 *   KD1 a router turn's system prompt tells it to call claw_capabilities first; the router is offered the tool, a worker is not
 *   KD2 the tool answers the list for this user and this turn: exactly the tools the router's server offers, the deployment's switches
 *       (pull request watching on, jobs off), the user's review mode as stored, read again on every call, and the turn's chat app
 *   KD3 GET /v1/assistant/capabilities serves the same list to the user it is about, and nothing to a caller without a user
 *   KD4 a router turn that reads the list and answers from it says nothing the list contradicts; the 2026-11-23 answer does
 *
 * Skipped without DATABASE_URL, and a skip is not a pass. The source is imported only once the world has set the configuration.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, TOKEN_KEY, type World } from "./support/assistant-world.js";

describe("claw_capabilities on a database", { skip: postgresSkipReason() }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";
  let self: typeof import("./e2e/self-knowledge.js");

  before(async () => {
    w = await startWorld({ CLAW_ASSISTANT_GITHUB_EVENTS: "true", CLAW_ASSISTANT_TOOLS: "on", CLAW_GITHUB_REVIEW_ENABLED: "true" });
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") return;
      (req as any).user = { userId: id, userName: `Name ${id}`, platformKey: `pk-${id}`, virtualKey: `vk-${id}`, roles: ["default"] };
    });
    await (await import("../src/assistant/mcp.js")).registerAssistantMcpRoutes(app, true);
    await (await import("../src/routes/assistant.js")).registerAssistantRoutes(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    self = await import("./e2e/self-knowledge.js");
  });
  after(async () => { await app?.close(); await w?.stop(); });

  async function connect(claims: object): Promise<Client> {
    const token = w.mod.token.mintAssistantToken(claims as never, TOKEN_KEY);
    const client = new Client({ name: "brain-mcp-assistant", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1/internal/assistant-mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }
  const parsed = (res: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> => JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
  /** A router turn answering the user's message, which came through `channel`. */
  async function turnFrom(u: { routerSid: string; userId: string }, content: string, channel?: string) {
    const turn = await w.routerTurn(u);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context, received_at)
       VALUES ($1, $2, $3, 'Alice A', $4, '{"kind":"person"}'::jsonb, $5::jsonb, NOW())`,
      [u.routerSid, turn.mid, u.userId, content, JSON.stringify(channel ? { channel } : {})],
    );
    return turn;
  }

  test("KD1 the router turn is told to read claw_capabilities first, and only the router has it", async () => {
    await w.q("TRUNCATE claw_assistant_messages, claw_pending_messages, claw_tasks, claw_work_items, claw_assistants, claw_sessions CASCADE");
    const alice = await w.user("alice");
    const run = await w.openRun(alice.routerSid);
    const task: Record<string, unknown> = { task_id: run.taskId, message_id: run.messageId, prompt: "你有什么做不到的？" };
    await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
    assert.match(String(task.system_append), /call claw_capabilities first, before you say anything, and answer from what it returns alone/);
    await w.closeRun(run.taskId);

    const router = await connect(await w.routerTurn(alice));
    const item = await w.createItem(alice, "Fix the build");
    const worker = await connect(await w.workerTurn(item.itemId));
    try {
      assert.ok((await router.listTools()).tools.some((t) => t.name === "claw_capabilities"));
      assert.ok(!(await worker.listTools()).tools.some((t) => t.name === "claw_capabilities"));
    } finally {
      await router.close();
      await worker.close();
    }
  });

  test("KD2 the list of this user and turn: the router's own tools, the switches, the stored review mode and the chat app", async () => {
    await w.q("TRUNCATE claw_assistant_messages, claw_pending_messages, claw_tasks, claw_work_items, claw_assistants, claw_sessions, claw_github_review_settings CASCADE");
    const alice = await w.user("alice");
    const router = await connect(await turnFrom(alice, "你能做什么", "slack"));
    try {
      const offered = (await router.listTools()).tools.map((t) => t.name).sort();
      const res = await router.callTool({ name: "claw_capabilities", arguments: {} });
      assert.equal(res.isError, undefined);
      const list = parsed(res);
      assert.equal(list.ok, true);
      assert.match(list.rule, /^This list is generated from the tools and settings you have now\./);
      // Every tool the router is offered is in the list once, by how it acts; nothing else is.
      assert.deepEqual([...list.acts_at_once, ...list.asks_first, ...list.reads, "say", "deliver_text"].sort(), offered);
      assert.equal(list.unclassified, undefined);
      const ability = (id: string) => list.abilities.find((a: { id: string }) => a.id === id);
      assert.equal(ability("watch_pull_requests").on, true, "CLAW_ASSISTANT_GITHUB_EVENTS is on");
      assert.deepEqual(ability("watch_pull_requests").tools, ["work_subscribe"]);
      assert.equal(ability("watch_jobs").on, false, "CLAW_ASSISTANT_JOB_EVENTS is off");
      assert.equal(ability("see_images").on, true);
      assert.equal(ability("check_work").on, true);
      assert.equal(ability("reviews").on, true);
      assert.deepEqual(list.review_mode.mode, "high_risk_confirm", "never set: the default");
      assert.deepEqual(list.channels, ["slack", "teams"], "the turn's message came through slack");
      assert.equal(list.lookups.github, false, "alice has not connected GitHub");
      // Changed in the store, read again on the next call.
      await w.q("INSERT INTO claw_github_review_settings (user_id, review_mode) VALUES ('alice', 'fully_auto')");
      const again = parsed(await router.callTool({ name: "claw_capabilities", arguments: {} }));
      assert.equal(again.review_mode.mode, "fully_auto");
      assert.match(again.abilities.find((a: { id: string }) => a.id === "reviews").what, /fully_auto: a merge asked for happens once the review approves, without asking them/);
    } finally {
      await router.close();
    }
  });

  test("KD3 GET /v1/assistant/capabilities serves the same list to its user", async () => {
    await w.q("TRUNCATE claw_assistant_messages, claw_pending_messages, claw_tasks, claw_work_items, claw_assistants, claw_sessions, claw_github_review_settings CASCADE");
    const alice = await w.user("alice");
    await w.q("INSERT INTO claw_github_review_settings (user_id, review_mode) VALUES ('alice', 'fully_auto')");
    const router = await connect(await turnFrom(alice, "你能做什么"));
    let fromTool: Record<string, any>;
    try {
      fromTool = parsed(await router.callTool({ name: "claw_capabilities", arguments: {} }));
    } finally {
      await router.close();
    }
    const r = await app.inject({ method: "GET", url: "/v1/assistant/capabilities", headers: { "x-test-user": "alice" } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    const { ok: _ok, rule: _rule, ...tool } = fromTool;
    assert.deepEqual(r.json().data, tool);
    // A user without an assistant yet gets the list too (no GitHub, which only a session reads).
    const bob = await app.inject({ method: "GET", url: "/v1/assistant/capabilities", headers: { "x-test-user": "bob" } });
    assert.equal(bob.statusCode, 200);
    assert.equal(bob.json().data.review_mode.mode, "high_risk_confirm");
    assert.equal((await app.inject({ method: "GET", url: "/v1/assistant/capabilities" })).statusCode, 403);
  });

  test("KD4 a router turn that reads the list and answers from it says nothing it contradicts; the 2026-11-23 answer does", async () => {
    await w.q("TRUNCATE claw_assistant_messages, claw_pending_messages, claw_tasks, claw_work_items, claw_assistants, claw_sessions, claw_github_review_settings CASCADE");
    const alice = await w.user("alice");
    const router = await connect(await turnFrom(alice, "你有什么做不到的？"));
    try {
      const list = parsed(await router.callTool({ name: "claw_capabilities", arguments: {} }));
      // The answer a turn writes from the list: what is on, then what is off.
      const answer = [
        ...list.abilities.filter((a: { on: boolean }) => a.on).map((a: { what: string }) => a.what),
        ...list.limits.filter((l: { on: boolean }) => !l.on).map((l: { what: string }) => l.what),
      ].join("\n");
      assert.deepEqual(self.contradictedClaims(answer, list), []);
      const guessed = "我没有后台监控能力，只有在你发消息的时候才会工作。我看不到你发的图片。所有写操作都需要开 worker 并经过你的确认。我无法检查 worker 的结论对不对。";
      assert.deepEqual(self.contradictedClaims(guessed, list).map((c) => c.detector).sort(),
        ["denies acting directly", "denies background", "denies check_work", "denies see_images"]);
    } finally {
      await router.close();
    }
  });
});
