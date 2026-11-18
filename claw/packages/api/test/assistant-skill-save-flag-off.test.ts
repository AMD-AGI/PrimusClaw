// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * With CLAW_USER_SKILLS_ENABLED off, saving skills from the conversation is not there at all (`assistant/skill-writes.ts`): over a real
 * Postgres, through the paths production runs. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   F1 the router is offered none of the skill tools
 *   F2 a router turn's request is the same, byte for byte, whether or not the user has skills and drafts and the message names one
 *   F3 the skill routes are as they were: a save answers no change to undo, the undo, disable, enable and draft routes and the current
 *      view do not exist; nor does the cards' decision route without the schedule tools
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, TOKEN_KEY, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant: saving personal skills, with the switch off", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";
  let alice: { userId: string; routerSid: string };

  before(async () => {
    w = await startWorld({ CLAW_USER_SKILLS_ENABLED: "false" });
    app = Fastify();
    await (await import("../src/assistant/mcp.js")).registerAssistantMcpRoutes(app, true);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_skills, claw_skill_files, claw_skill_events, claw_skill_drafts, claw_skill_changes, claw_work_item_events, claw_work_items,
      claw_assistant_says, claw_assistant_messages, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions RESTART IDENTITY CASCADE`);
    alice = await w.user("alice");
  });

  test("F1 the router is offered none of the skill tools", async () => {
    const turn = await w.routerTurn(alice);
    const client = new Client({ name: "brain-mcp-assistant", version: "1.0.0" }, { capabilities: {} });
    const token = w.mod.token.mintAssistantToken(turn as never, TOKEN_KEY);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1/internal/assistant-mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes("say"), "the router's tools are there: this test proves something");
      assert.deepEqual(names.filter((n) => n.startsWith("skill_")), []);
    } finally { await client.close(); await w.closeRun(turn.task_id); }
  });

  test("F2 a router turn's request is the same byte for byte, skills and drafts or none", async () => {
    const content = "用 standup-notes 写今天的站会纪要";
    const request = async () => {
      const turn = await w.routerTurn(alice);
      await w.q(
        `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context, received_at)
         VALUES ($1, $2, $3, NULL, $4, '{"kind":"person"}'::jsonb, '{}'::jsonb, NOW())`,
        [turn.sid, turn.mid, "alice", content],
      );
      const task: Record<string, any> = { task_id: "t", message_id: turn.mid, prompt: content };
      await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
      await w.closeRun(turn.task_id);
      delete task.message_id;
      // The turn's own bearer names its message: the one part that differs from turn to turn by design.
      for (const server of Object.values(task.mcp_servers ?? {}) as Array<Record<string, unknown>>) delete server.token;
      return JSON.stringify(task).split(turn.mid).join("<mid>").split(turn.task_id).join("<tid>");
    };
    const none = await request();
    await w.q(`INSERT INTO claw_skills (user_id, skill_name, version, content, description, status, source)
      VALUES ('alice', 'standup-notes', 1, '## steps', 'standup', 'active', 'manual')`);
    await w.q(`INSERT INTO claw_skill_drafts (id, user_id, skill_name, content, origin) VALUES ('d1', 'alice', 'drafted', 'c', 'chat')`);
    const some = await request();
    assert.equal(some, none);
    assert.ok(!some.includes("## steps") && !some.includes("Skill drafts"));
  });

  test("F3 the skill routes are as they were, and the cards' decision route is not there without the schedule tools", async () => {
    const rest = Fastify();
    rest.addHook("preHandler", async (req) => { (req as any).user = { userId: "alice" }; });
    await (await import("../src/routes/skills.js")).registerSkillRoutes(rest, false);
    await (await import("../src/routes/assistant-proactive.js")).registerAssistantProactiveRoutes(rest, true, false, false);
    await rest.ready();
    try {
      const saved = await rest.inject({ method: "POST", url: "/v1/users/me/skills", payload: { skill_name: "standup-notes", content: "## steps" } });
      assert.deepEqual(saved.json(), { ok: true, version: 1 });
      assert.deepEqual(await w.q("SELECT * FROM claw_skill_changes"), [], "nothing recorded to undo");
      const list = await rest.inject({ method: "GET", url: "/v1/users/me/skills?view=current" });
      assert.ok("content" in list.json().data[0], "the rows as they were, not the current view");
      for (const [method, url] of [
        ["POST", "/v1/users/me/skill-changes/x/undo"], ["POST", "/v1/users/me/skills/standup-notes/disable"],
        ["POST", "/v1/users/me/skills/standup-notes/enable"], ["GET", "/v1/users/me/skill-drafts"],
        ["POST", "/v1/assistant/confirmations/x/decision"],
      ] as const) {
        assert.equal((await rest.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, 404, `${method} ${url}`);
      }
      const deleted = await rest.inject({ method: "DELETE", url: "/v1/users/me/skills/standup-notes" });
      assert.deepEqual(deleted.json(), { ok: true, deleted: 1 });
    } finally { await rest.close(); }
  });
});
