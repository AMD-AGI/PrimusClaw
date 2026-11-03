// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model's trigger tools as Brain reaches them: Streamable HTTP, a bearer minted for one turn. Real Postgres,
 * production schema with triggers and the assistant on. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   T1  no bearer, a wrong one, an expired one and one signed with another key get 401 and no MCP at all
 *   T2  a turn's user is its session's owner: another user's triggers cannot be listed, cancelled or created for them
 *   T3  a turn that has ended can no longer act
 *   T4  max_runs and until end a trigger by themselves
 *   T5  a trigger made from a work item's worker wakes that worker, and ends with the item
 *   T6  which turns are offered the tools: every owned turn but a trigger's own run, a router and an acting session;
 *       creation and cancelling held for approval
 *   T7  a session that acts as a user can do nothing with them, even on a bearer minted before it did
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const KEY = "trigger-tools-test-key-0123456789abcdef";

describe("trigger tools", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";
  let mcpMod: typeof import("../src/triggers/mcp.js");
  let tokenMod: typeof import("../src/triggers/token.js");
  let sched: typeof import("../src/triggers/scheduler.js");
  let fire: typeof import("../src/triggers/fire.js");
  const dispatched: any[] = [];

  before(async () => {
    w = await startWorld({
      CLAW_TRIGGERS_ENABLED: "true", CLAW_TRIGGER_TOOLS_ENABLED: "true", CLAW_TRIGGER_TOOLS_TOKEN_KEY: KEY,
      CLAW_GITHUB_REVIEW_ENABLED: "true",
    });
    mcpMod = await import("../src/triggers/mcp.js");
    tokenMod = await import("../src/triggers/token.js");
    sched = await import("../src/triggers/scheduler.js");
    fire = await import("../src/triggers/fire.js");
    fire.triggerPorts.dispatch = (async (input: any) => {
      dispatched.push(input);
      return { kind: "dispatched", messageId: input.messageId, sandboxImage: undefined, runId: `run-${dispatched.length}` };
    }) as any;
    app = Fastify();
    await mcpMod.registerTriggerMcpRoutes(app, true);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_trigger_fires, claw_triggers, claw_work_item_events, claw_work_items, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions CASCADE");
    dispatched.length = 0;
    w.drains.length = 0;
    mcpMod.triggerToolSettings.enabled = true;
  });

  /** An ordinary conversation of this user, holding the credentials their own messages stamp. */
  async function chatSession(userId: string, extra: Record<string, unknown> = {}): Promise<string> {
    const sid = randomUUID();
    const sessions = await import("../src/routes/sessions.js");
    await sessions.insertSessionRow(w.h.app.db.db, {
      sessionId: sid, name: "chat", userId, mode: "claw", agentStatus: "idle", systemPrompt: "",
      config: { platform_key: `pk-${userId}`, llm_api_key: `vk-${userId}`, _server_managed_credentials: true, ...extra },
      parentSid: null, role: "",
    }, { parentSid: null });
    return sid;
  }
  async function turn(sid: string) {
    const run = await w.openRun(sid);
    return { sid, mid: run.messageId, task_id: run.taskId, exp: Math.floor(Date.now() / 1000) + 600 };
  }
  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: "brain-mcp-schedules", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${mcpMod.TRIGGER_MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    return client;
  }
  const bearer = (claims: object, key = KEY) => tokenMod.mintTriggerToken(claims as never, key);
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    let body: Record<string, any> = {};
    try { body = JSON.parse(text); } catch { /* plain text */ }
    return { isError: Boolean(res.isError), body, text };
  };
  const DAILY = { name: "brief", prompt: "summarise my runs", schedule: "0 8 * * *", timezone: "Asia/Shanghai" };
  const trig = async (id: string) => (await w.q("SELECT * FROM claw_triggers WHERE trigger_id = $1", [id]))[0];
  const makeDue = (id: string, at: string) => w.q("UPDATE claw_triggers SET next_fire_at = $2 WHERE trigger_id = $1", [id, at]);

  test("T1 a request without a valid bearer is refused before any MCP", async () => {
    const t = await turn(await chatSession("alice"));
    const good = bearer(t);
    const expired = bearer({ ...t, exp: Math.floor(Date.now() / 1000) - 1 });
    const other = bearer(t, "another-key-another-key-another-key!!");
    const assistantShaped = w.mod.token.mintAssistantToken({ ...t, role: "router" } as never, KEY);
    for (const authorization of [undefined, "", "Bearer nope", `Bearer ${expired}`, `Bearer ${other}`, `Bearer ${assistantShaped}`, `Bearer ${good.slice(0, -2)}xx`]) {
      const res = await fetch(`${base}${mcpMod.TRIGGER_MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization === undefined ? {} : { authorization }) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      assert.equal(res.status, 401, String(authorization));
    }
    const client = await connect(good);
    try {
      assert.deepEqual((await client.listTools()).tools.map((x) => x.name).sort(), ["trigger_cancel", "trigger_create", "trigger_list"]);
    } finally { await client.close(); }
  });

  test("T2 a turn reads and changes its own owner's triggers and nobody else's", async () => {
    const alice = await connect(bearer(await turn(await chatSession("alice"))));
    const bob = await connect(bearer(await turn(await chatSession("bob"))));
    try {
      const created = await call(alice, "trigger_create", { ...DAILY, max_runs: 3 });
      assert.equal(created.isError, false, created.text);
      const id = created.body.trigger.trigger_id as string;
      assert.equal((await trig(id)).owner_user_id, "alice");
      assert.equal(created.body.trigger.max_runs, 3);
      assert.equal("credential_enc" in created.body.trigger, false, "the sealed credential is never shown");

      // An argument naming another user is not how the owner is chosen.
      const smuggled = await call(bob, "trigger_create", { ...DAILY, name: "mine", user_id: "alice", owner_user_id: "alice" });
      assert.equal(smuggled.isError, false, smuggled.text);
      assert.equal((await trig(smuggled.body.trigger.trigger_id)).owner_user_id, "bob");
      // Nor behind the wire's schema, which drops unknown arguments before the tool sees them.
      const tools = await import("../src/triggers/tools.js");
      const bobTurn = await turn(await chatSession("bob"));
      const direct = (await tools.triggerCreate(bobTurn, { ...DAILY, name: "direct", user_id: "alice" })).trigger as any;
      assert.equal((await trig(direct.trigger_id)).owner_user_id, "bob");

      const bobList = await call(bob, "trigger_list", {});
      assert.deepEqual(bobList.body.triggers.map((x: any) => x.name), ["mine", "direct"]);
      const cancel = await call(bob, "trigger_cancel", { trigger_id: id });
      assert.equal(cancel.isError, true);
      assert.equal(cancel.body.error, "not_found");
      assert.ok(await trig(id), "alice's trigger is still there");

      const own = await call(alice, "trigger_cancel", { trigger_id: id });
      assert.equal(own.body.outcome, "cancelled");
      assert.equal(await trig(id), undefined);
    } finally { await alice.close(); await bob.close(); }
  });

  test("T3 a turn that has ended can no longer act, and a turn without its owner's key cannot schedule", async () => {
    const t = await turn(await chatSession("alice"));
    await w.closeRun(t.task_id);
    const client = await connect(bearer(t));
    const keyless = await connect(bearer(await turn(await chatSession("carol", { platform_key: null }))));
    try {
      const r = await call(client, "trigger_create", DAILY);
      assert.equal(r.body.error, "turn_not_live");
      assert.equal((await w.q("SELECT 1 FROM claw_triggers")).length, 0);
      assert.equal((await call(keyless, "trigger_create", DAILY)).body.error, "no_credentials");
      const bad = await call(keyless, "trigger_create", { ...DAILY, max_runs: 0 });
      assert.equal(bad.body.error, "invalid_arguments");
    } finally { await client.close(); await keyless.close(); }
  });

  test("T4 max_runs and until end a trigger by themselves", async () => {
    const t = await turn(await chatSession("alice"));
    const counted = await w.mod.tools.assertLiveRun((s: string, p?: unknown[]) => w.h.app.db.db.query(s, p), t);
    assert.equal(counted.userId, "alice");
    const tools = await import("../src/triggers/tools.js");
    const twice = (await tools.triggerCreate(t, { ...DAILY, max_runs: 2 })).trigger as any;
    for (const [i, at] of ["2026-10-27T00:00:00Z", "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z"].entries()) {
      await w.q("UPDATE claw_sessions SET agent_status = 'idle' WHERE config->>'trigger_id' = $1", [twice.trigger_id]);
      if (i < 2) await makeDue(twice.trigger_id, at);
      await sched.tickTriggers(new Date(new Date(at).getTime() + 30_000));
    }
    const ended = await trig(twice.trigger_id);
    assert.equal(dispatched.length, 2, "two runs, then none");
    assert.equal(ended.runs, 2);
    assert.equal(ended.paused_reason, "ended");
    assert.equal(ended.next_fire_at, null);

    // A row a resume brought back after its last run ends at its next firing without running.
    await w.q("UPDATE claw_triggers SET paused_reason = NULL, next_fire_at = '2026-10-30T00:00:00Z' WHERE trigger_id = $1", [twice.trigger_id]);
    await sched.tickTriggers(new Date("2026-10-30T00:00:30Z"));
    assert.equal(dispatched.length, 2);
    assert.equal((await trig(twice.trigger_id)).paused_reason, "ended");

    dispatched.length = 0;
    const bounded = (await tools.triggerCreate(t, { ...DAILY, name: "until", until: "2099-01-01T12:00:00Z" })).trigger as any;
    await w.q("UPDATE claw_triggers SET ends_at = '2026-10-27T12:00:00Z' WHERE trigger_id = $1", [bounded.trigger_id]);
    await makeDue(bounded.trigger_id, "2026-10-27T00:00:00Z");
    await sched.tickTriggers(new Date("2026-10-27T00:00:30Z"));
    const last = await trig(bounded.trigger_id);
    assert.equal(dispatched.length, 1, "the last firing before until still runs");
    assert.equal(last.paused_reason, "ended");
    assert.equal(last.next_fire_at, null);
    await assert.rejects(tools.triggerCreate(t, { ...DAILY, until: "2020-01-01T00:00:00Z" }), /does not fire before until/);
  });

  test("T5 a trigger made from a work item's worker wakes that worker and ends with the item", async () => {
    const alice = await w.user("alice");
    const item = await w.createItem(alice, "Watch PR 12");
    const wt = await w.workerTurn(item.itemId);
    const client = await connect(bearer({ sid: wt.sid, mid: wt.mid, task_id: wt.task_id, exp: wt.exp }));
    let id = "";
    try {
      const created = await call(client, "trigger_create", { ...DAILY, name: "watch", prompt: "check PR 12 for new comments" });
      assert.equal(created.isError, false, created.text);
      id = created.body.trigger.trigger_id;
      assert.equal(created.body.trigger.item_id, item.itemId);
    } finally { await client.close(); }
    await w.closeRun(wt.task_id);

    await makeDue(id, "2026-10-27T00:00:00Z");
    await sched.tickTriggers(new Date("2026-10-27T00:00:30Z"));
    assert.equal(dispatched.length, 0, "no new session");
    const queued = await w.pending(item.workerSid);
    assert.equal(queued.length, 1);
    assert.match(queued[0].content, /check PR 12 for new comments/);
    assert.deepEqual(w.drains.map((d) => d.sessionId), [item.workerSid]);
    const fired = (await w.q("SELECT * FROM claw_trigger_fires WHERE trigger_id = $1", [id]))[0];
    assert.equal(fired.status, "started");
    assert.equal(fired.session_id, item.workerSid);

    await w.q("DELETE FROM claw_pending_messages");
    await w.q("UPDATE claw_work_items SET board_state = 'needs_you' WHERE item_id = $1", [item.itemId]);
    await makeDue(id, "2026-10-28T00:00:00Z");
    await sched.tickTriggers(new Date("2026-10-28T00:00:30Z"));
    assert.equal((await w.pending(item.workerSid)).length, 0, "an item waiting for its user is not woken");
    assert.equal((await trig(id)).paused_reason, null);

    await w.q("UPDATE claw_work_items SET board_state = 'done' WHERE item_id = $1", [item.itemId]);
    await makeDue(id, "2026-10-29T00:00:00Z");
    await sched.tickTriggers(new Date("2026-10-29T00:00:30Z"));
    assert.equal((await w.pending(item.workerSid)).length, 0);
    assert.equal((await trig(id)).paused_reason, "item_closed");
  });

  test("T6 which turns are offered the tools, and creating and cancelling are held for approval", async () => {
    const offered = async (sid: string, t: { task_id: string; mid: string }, extra: Record<string, unknown> = {}) => {
      const task: Record<string, unknown> = { task_id: t.task_id, message_id: t.mid, ...extra };
      await mcpMod.applyTriggerToolsToTask(task, sid);
      await w.mod.role.applySessionRoleToTask(task, sid);
      return (task.mcp_servers as Record<string, any> | undefined)?.[mcpMod.TRIGGER_MCP_SERVER];
    };
    const sid = await chatSession("alice");
    const t = await turn(sid);
    const server = await offered(sid, t, { mcp_servers: { schedules: { type: "http", url: "https://evil.example.com/mcp", token: "x" } } });
    assert.ok(server, "an ordinary turn is offered the tools");
    assert.match(server.url, /\/v1\/internal\/trigger-mcp$/, "a request's own server of that name is replaced");
    assert.deepEqual([...server.requires_approval].sort(), ["trigger_cancel", "trigger_create"]);
    const verdict = tokenMod.verifyTriggerToken(server.token, KEY);
    assert.ok(verdict.ok);
    assert.deepEqual(verdict.ok && [verdict.claims.sid, verdict.claims.mid, verdict.claims.task_id], [sid, t.mid, t.task_id]);

    const runSid = await chatSession("alice", { trigger_id: "trg-1" });
    assert.equal(await offered(runSid, await turn(runSid)), undefined, "a trigger's own run cannot schedule more");

    const actingSid = await chatSession("alice", { acting_as: "bob" });
    assert.equal(await offered(actingSid, await turn(actingSid)), undefined, "a session acting as a user is not offered them");

    const alice = await w.user("alice");
    assert.equal(await offered(alice.routerSid, await w.routerTurn(alice)), undefined, "a router keeps to its own tools");
    const item = await w.createItem(alice, "Fix the build");
    const wt = await w.workerTurn(item.itemId);
    assert.ok(await offered(item.workerSid, wt), "an item's worker is offered them");

    mcpMod.triggerToolSettings.enabled = false;
    assert.equal(await offered(sid, await turn(sid)), undefined, "off means not offered");
  });

  test("T7 a session that acts as a user can do nothing with them, even on a bearer minted before it did", async () => {
    const sid = await chatSession("alice");
    const client = await connect(bearer(await turn(sid)));
    try {
      const made = await call(client, "trigger_create", DAILY);
      assert.equal(made.isError, false, made.text);
      const id = made.body.trigger.trigger_id;
      await w.q("UPDATE claw_sessions SET config = config || '{\"acting_as\": \"bob\"}'::jsonb WHERE session_id = $1", [sid]);
      for (const [name, args] of [["trigger_list", {}], ["trigger_cancel", { trigger_id: id }], ["trigger_create", DAILY]] as const) {
        const res = await call(client, name, args);
        assert.equal(res.isError, true, name);
        assert.equal(res.body.error, "not_allowed", name);
      }
      assert.ok(await trig(id), "nothing was cancelled");
      assert.equal((await w.q("SELECT count(*)::int AS n FROM claw_triggers"))[0].n, 1, "nothing was created");
    } finally { await client.close(); }
  });
});
