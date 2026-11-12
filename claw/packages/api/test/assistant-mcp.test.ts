// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's MCP service as Brain's client reaches it: Streamable HTTP, a bearer, a server built per
 * request. Real Postgres, production schema. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   M1  no bearer, a wrong one, an expired one and one signed with another key get 401 and no MCP at all
 *   M2  a router is offered the five conversation tools and a worker the one it reports through, and no one the other's
 *   M3  every tool answers over the wire as it does in process; a refusal is a result the model can read
 *   M4  a tool outside the bearer's role does not exist for it
 *   M5  with the assistant off the path is not served
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
const PATH = "/v1/internal/assistant-mcp";

describe("assistant MCP service", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";
  let alice: { userId: string; routerSid: string };

  before(async () => {
    w = await startWorld();
    app = Fastify();
    await (await import("../src/assistant/mcp.js")).registerAssistantMcpRoutes(app, true);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox CASCADE");
    alice = await w.user("alice");
  });

  const bearer = (claims: object, key = TOKEN_KEY) => w.mod.token.mintAssistantToken(claims as never, key);

  /** The way Brain's MCP client connects: a bearer on every request, tools listed, then called. */
  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: "brain-mcp-assistant", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${PATH}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    let body: Record<string, any> = {};
    // An argument the tool's schema refuses is answered by the SDK in plain words, before the tool is reached.
    try { body = JSON.parse(text); } catch { /* plain text */ }
    return { isError: Boolean(res.isError), body, text };
  };

  test("M1 a request without a valid bearer is refused before any MCP", async () => {
    const turn = await w.routerTurn(alice);
    const good = bearer(turn);
    const expired = bearer({ ...turn, exp: Math.floor(Date.now() / 1000) - 1 });
    const other = bearer(turn, "another-key-another-key-another-key!!");
    for (const authorization of [undefined, "", "Bearer", "Bearer nope", `Bearer ${expired}`, `Bearer ${other}`, good.slice(0, -2) + "xx"]) {
      const res = await fetch(`${base}${PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization === undefined ? {} : { authorization }) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      assert.equal(res.status, 401, String(authorization));
      assert.equal((await res.json() as any).ok, false);
    }
    const ok = await fetch(`${base}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${good}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(ok.status, 200);
  });

  test("M2 each role is offered its own tools and no one the other's", async () => {
    const item = await w.createItem(alice, "Fix the build");
    const router = await connect(bearer(await w.routerTurn(alice)));
    const worker = await connect(bearer(await w.workerTurn(item.itemId)));
    try {
      const routerTools = (await router.listTools()).tools;
      assert.deepEqual(routerTools.map((t) => t.name).sort(), ["claw_self_status", "deliver_text", "say", "work_create", "work_recall", "work_send", "work_stop"]);
      assert.deepEqual((await worker.listTools()).tools.map((t) => t.name).sort(), ["deliver_text", "report"]);
      // The names Brain gives them are what the router's allowlist pattern selects.
      for (const t of routerTools) assert.ok(`mcp__assistant__${t.name}`.startsWith("mcp__assistant__"));
      const sayTool = routerTools.find((t) => t.name === "say")!;
      assert.deepEqual((sayTool.inputSchema as any).required, ["text"]);
      // The router is told what a repository passed to work_create costs (a clone before the work starts), on the tool itself.
      const { WORK_CREATE_REPO_PARAM } = await import("../src/assistant/prompts.js");
      const createTool = routerTools.find((t) => t.name === "work_create")!;
      assert.equal((createTool.inputSchema as any).properties.repo.description, WORK_CREATE_REPO_PARAM);
      assert.equal(routerTools.some((t) => /accept/.test(t.name)), false, "no tool accepts a result for the user");
    } finally { await router.close(); await worker.close(); }
  });

  test("M3 the tools answer over the wire, and a refusal is a result the model can read", async () => {
    await w.subscribe("alice");
    const turn = await w.routerTurn(alice);
    const router = await connect(bearer(turn));
    try {
      const created = await call(router, "work_create", { title: "Fix the build", brief: "CI is red on main." });
      assert.equal(created.isError, false);
      assert.equal(created.body.ok, true);
      assert.equal(created.body.seq, 1);
      const itemId = created.body.item_id as string;
      assert.equal((await w.item(itemId)).board_state, "in_progress");

      const said = await call(router, "say", { text: "Taken on as #1.", item_id: itemId });
      assert.equal(said.isError, false);
      assert.equal(said.body.subscribers, 1);
      assert.equal((await w.q("SELECT * FROM claw_assistant_says")).length, 1);

      const sent = await call(router, "work_send", { item_id: itemId, text: "Use the main branch." });
      assert.equal(sent.body.status, "in_progress");
      const recalled = await call(router, "work_recall", { item_id: itemId, detail: "summary" });
      assert.equal(recalled.body.item.title, "Fix the build");
      const stopped = await call(router, "work_stop", { item_id: itemId, reason: "no longer needed" });
      assert.equal(stopped.body.outcome, "stopped");

      const refused = await call(router, "work_stop", { item_id: "kwi_nope", reason: "x" });
      assert.equal(refused.isError, true);
      assert.deepEqual({ ok: refused.body.ok, error: refused.body.error }, { ok: false, error: "item_not_found" });
      assert.ok(refused.body.message.length > 10, "a refusal says what to do");
    } finally { await router.close(); }

    // The turn ends; the same bearer is now worth nothing.
    await w.closeRun(turn.task_id);
    const late = await connect(bearer(turn));
    try {
      const after = await call(late, "say", { text: "too late" });
      assert.equal(after.isError, true);
      assert.equal(after.body.error, "turn_not_live");
    } finally { await late.close(); }
  });

  test("M3b a worker reports over the wire; a bad report says what to fix", async () => {
    const item = await w.createItem(alice, "Fix the build");
    const worker = await connect(bearer(await w.workerTurn(item.itemId)));
    try {
      const bad = await call(worker, "report", { kind: "ready" });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /summary/);
      const worse = await call(worker, "report", { kind: "ready", summary: "x", question: "why?" });
      assert.deepEqual({ error: worse.body.error }, { error: "invalid_report" });
      assert.match(worse.body.message, /only allowed on a waiting or blocked/);
      const good = await call(worker, "report", { kind: "ready", summary: "PR 12 opened", result: { refs: [{ type: "pr", url: "https://example.com/pr/12" }] } });
      assert.deepEqual(good.body, { ok: true, status: "recorded", item_state: "needs_you" });
      assert.equal((await w.item(item.itemId)).result_version, 1);
    } finally { await worker.close(); }
  });

  test("M4 a tool outside the bearer's role does not exist for it", async () => {
    const item = await w.createItem(alice, "Fix the build");
    const router = await connect(bearer(await w.routerTurn(alice)));
    const worker = await connect(bearer(await w.workerTurn(item.itemId)));
    try {
      for (const [client, name] of [[router, "report"], [worker, "say"], [worker, "work_create"], [worker, "work_stop"]] as const) {
        const res = await client.callTool({ name, arguments: { text: "x", kind: "ready", summary: "x", title: "x", brief: "x", item_id: item.itemId, reason: "x" } }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: String(e.message) }] }));
        assert.equal(res.isError, true, name);
        assert.match((res.content as any)[0].text, /not found|Unknown tool|unknown/i, name);
      }
      assert.equal((await w.item(item.itemId)).board_state, "in_progress");
      assert.equal((await w.q("SELECT * FROM claw_assistant_says")).length, 0);
    } finally { await router.close(); await worker.close(); }
  });

  test("M5 with the assistant off the path is not served", async () => {
    const off = Fastify();
    await (await import("../src/assistant/mcp.js")).registerAssistantMcpRoutes(off, false);
    const res = await off.inject({ method: "POST", url: PATH, payload: {}, headers: { authorization: `Bearer ${bearer(await w.routerTurn(alice))}` } });
    assert.equal(res.statusCode, 404);
    await off.close();
  });
});
