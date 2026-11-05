// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Model choice off (`CLAW_ASSISTANT_MODEL_CHOICE` unset), with an allow-list and a fallback configured all the same: everything is as
 * it was before model choice existed. Against a real Postgres with the production schema; skipped without DATABASE_URL.
 *
 *   O1  no new tables, no settings routes
 *   O2  the tools take no model argument and there is no model_default_set; a model passed anyway is not used
 *   O3  a review's model still has to be in the user's message
 *   O4  every worker turn asks for the deployment's worker model, whatever its session names, and the router is shown no models
 *   O5  a turn the gateway refused is not run again, and the gateway's model list is never asked for
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant model choice, off", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let alice: { userId: string; routerSid: string };
  let listed = 0;

  before(async () => {
    w = await startWorld({
      CLAW_ASSISTANT_MODELS: "claude-opus-5.5=strongest,claude-sonnet-5.5=default,glm-5-3-with-fallback=no APIM key needed",
      CLAW_ASSISTANT_WORKER_MODEL: "claude-sonnet-5.5",
      CLAW_ASSISTANT_REVIEW_MODEL: "claude-opus-5.5",
      CLAW_FALLBACK_MODEL: "glm-5-3-with-fallback",
      CLAW_ASSISTANT_TOOLS: "on",
      CLAW_GITHUB_REVIEW_ENABLED: "true",
      CLAW_ASSISTANT_REVIEW_ITEMS: "true",
    });
    const mc = await import("../src/assistant/model-choice.js");
    mc.modelChoicePorts.listModels = async () => { listed += 1; return []; };
    const { registerAssistantRoutes } = await import("../src/routes/assistant.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as any).user = { userId: "alice", userName: "Alice", platformKey: "pk-alice", virtualKey: "vk-alice", roles: ["default"] };
    });
    await registerAssistantRoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await w?.stop();
  });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants,
      claw_sessions, claw_assistant_messages CASCADE`);
    alice = await w.user("alice");
  });

  test("O1 no new tables and no settings routes", async () => {
    const tables = await w.q("SELECT to_regclass('claw_user_model_prefs') AS p, to_regclass('claw_assistant_model_fallbacks') AS f");
    assert.deepEqual(tables[0], { p: null, f: null });
    for (const method of ["GET", "PUT"] as const) {
      assert.equal((await app.inject({ method, url: "/v1/assistant/settings", payload: method === "PUT" ? {} : undefined })).statusCode, 404);
    }
  });

  test("O2 the tools take no model, and a model passed anyway is not used", async () => {
    const { createAssistantMcpServer } = await import("../src/assistant/mcp.js");
    const tools = (createAssistantMcpServer({ sid: alice.routerSid, role: "router", mid: "m", task_id: "t", exp: 0 } as never) as any)._registeredTools;
    assert.equal(tools.model_default_set, undefined);
    assert.equal("model" in tools.work_create.inputSchema.shape, false);
    assert.equal("model" in tools.work_send.inputSchema.shape, false);
    assert.equal(tools.review_start.inputSchema.shape.model.description, "Only when the user named a model.");
    const turn = await w.routerTurn(alice);
    const created = await w.mod.tools.workCreate(turn, { title: "t", brief: "b", model: "claude-opus-5.5" } as never);
    assert.deepEqual(Object.keys(created).sort(), ["deduplicated", "item_id", "ok", "seq"], "the answer is the one it always was");
    const item = await w.item(created.item_id);
    assert.deepEqual(item.params, {});
    assert.equal((await w.q("SELECT model FROM claw_sessions WHERE session_id = $1", [item.worker_session_id]))[0].model, "claude-sonnet-5.5");
  });

  test("O3 a review's model still has to be named in the user's message", async () => {
    const rt = await import("../src/assistant/review-tools.js");
    const turn = await w.routerTurn(alice);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, attended_via, channel_context, received_at)
       VALUES ($1, $2, 'alice', 'review AMD-AGI/PrimusClaw#254 with the strongest model', '{"kind":"person"}'::jsonb, '{}'::jsonb, NOW())`,
      [alice.routerSid, turn.mid],
    );
    let code = "";
    try { await rt.reviewStart(turn as never, { prs: ["AMD-AGI/PrimusClaw#254"], merge: false, model: "claude-opus-5.5" }); } catch (err) { code = (err as { code: string }).code; }
    assert.equal(code, "model_not_in_message");
  });

  test("O4 every worker turn asks for the deployment's worker model, and the router is shown no models", async () => {
    const made = await w.createItem(alice, "task");
    await w.q("UPDATE claw_sessions SET model = 'claude-haiku-5.5' WHERE session_id = $1", [made.workerSid]);
    const run = await w.openRun(made.workerSid);
    const task: Record<string, unknown> = { task_id: run.taskId, message_id: run.messageId, prompt: "x", model: "claude-haiku-5.5" };
    await w.mod.role.applySessionRoleToTask(task, made.workerSid);
    assert.equal(task.model, "claude-sonnet-5.5");
    const r = await w.openRun(alice.routerSid);
    const routerTask: Record<string, unknown> = { task_id: r.taskId, message_id: r.messageId, prompt: "hi" };
    await w.mod.role.applySessionRoleToTask(routerTask, alice.routerSid);
    assert.equal(String(routerTask.system_append).includes("\nModels\n"), false);
    assert.equal(String(routerTask.system_append).includes("claude-opus-5.5"), false);
  });

  test("O5 a refused turn is not run again, and the gateway's model list is never asked for", async () => {
    const fb = await import("../src/assistant/model-fallback.js");
    const made = await w.createItem(alice, "task");
    const run = await w.openRun(made.workerSid);
    await w.closeRun(run.taskId, "failed", "agent_error", 0);
    const out = await fb.rerunOnFallback({
      sessionId: made.workerSid, runIds: [run.taskId], messageId: run.messageId, failed: true, interrupted: false,
      finalText: "403 {\"error\":\"No APIM Key binding found. Please upload your APIM Key on the SaFE platform first.\"}",
    });
    assert.equal(out, "skipped");
    assert.equal((await w.pending(made.workerSid)).length, 0);
    assert.equal(listed, 0);
  });
});
