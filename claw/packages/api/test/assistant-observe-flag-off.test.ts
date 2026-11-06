// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant on, and its two P3 switches at their defaults: `CLAW_ASSISTANT_OBSERVE` off and `CLAW_ASSISTANT_WATCHDOG_SEC`
 * 0. Real Postgres with the production schema. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   FO1  the observe routes do not exist; the board does
 *   FO2  a watcher made while observing was on keeps its cut: turning the switch off never turns it into a full session
 *   FO3  the sweep leaves an item that is stuck alone
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant observe and watchdog at their defaults", { skip }, () => {
  let w: World;
  let app: FastifyInstance;

  before(async () => {
    w = await startWorld();
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as any).user = { userId: "alice", userName: "Alice", platformKey: "pk-alice", virtualKey: "vk-alice", roles: ["default"] };
      (req as any).authMethod = "identity_token";
    });
    await (await import("../src/routes/assistant.js")).registerAssistantRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await w?.stop(); });

  test("FO1 the observe routes do not exist; the board does", async () => {
    for (const [method, url] of [
      ["GET", "/v1/assistant/scopes"], ["PUT", "/v1/assistant/scopes"],
      ["POST", "/v1/assistant/observations"], ["GET", "/v1/assistant/observations?scope=repo:a/b"],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === "GET" ? undefined : { scope: "repo:a/b", mode: "auto", content: "x" } });
      assert.equal(res.statusCode, 404, `${method} ${url}`);
    }
    assert.equal((await app.inject({ method: "GET", url: "/v1/work-items" })).statusCode, 200);
    assert.equal(Number((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_scopes"))[0].n), 0);
  });

  test("FO2 a watcher made while observing was on keeps its cut", async () => {
    await w.user("alice");
    const { getOrCreateScope } = await import("../src/assistant/observe.js");
    const { row } = await getOrCreateScope("alice", "group:teams:42");
    const run = await w.openRun(row.session_id);
    const task: Record<string, unknown> = { task_id: run.taskId, message_id: run.messageId, mcp_servers: { mine: { type: "http", url: "http://elsewhere" } } };
    await w.mod.role.applySessionRoleToTask(task, row.session_id);
    assert.deepEqual(task.tools_allowlist, ["mcp__assistant__*"]);
    assert.deepEqual(Object.keys(task.mcp_servers as object), ["assistant"]);
    const token = (task.mcp_servers as any).assistant.token as string;
    const verdict = w.mod.token.verifyAssistantToken(token, (await import("./support/assistant-world.js")).TOKEN_KEY);
    assert.ok(verdict.ok && verdict.claims.role === "observer");
  });

  test("FO3 the sweep leaves an item that is stuck alone", async () => {
    const alice = await w.user("alice");
    const item = await w.createItem(alice, "Fix the build");
    await w.workerTurn(item.itemId);
    await w.q("UPDATE claw_work_items SET updated_at = NOW() - interval '30 days' WHERE item_id = $1", [item.itemId]);
    await w.q("UPDATE claw_work_item_events SET created_at = NOW() - interval '30 days' WHERE item_id = $1", [item.itemId]);
    await (await import("../src/assistant/sweep.js")).sweepAssistant();
    const row = await w.item(item.itemId);
    assert.equal(row.board_state, "in_progress");
    assert.equal((await w.itemEvents(item.itemId)).filter((e) => e.source === "watchdog").length, 0);
  });
});
