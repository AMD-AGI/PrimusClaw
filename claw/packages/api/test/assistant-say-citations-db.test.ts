// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A router's `say` that cites (`assistant/citations.ts`), over the wire and on a real Postgres whose schema `initDb` built with the
 * assistant and notifications on. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   SC5 say's schema has `sources` after `text` with citations on and not at all with them off; the `_meta` Brain sends is what the
 *       outbox payload carries, the model's `sources` argument never is, and the counter counts each outcome; a `sources` the
 *       model got wrong in its form does not refuse the message, but a text whose [n] lost its source is refused (it would reach
 *       the user as a number that links nowhere) and the say that goes out instead is the one counted
 *   SC6 the web client's event carries the same sources as the channel's payload
 *   SC7 a router turn's request cites with say, with the addresses the user wrote, and its prompt says how; a worker turn neither
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CITE_DROPPED_META, CITE_SOURCES_META } from "@claw/protocol";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, TOKEN_KEY, type World } from "./support/assistant-world.js";

const PR = "https://github.com/AMD-AGI/PrimusClaw/pull/309";
const meta = (sources: unknown[], dropped?: Record<string, number>) => ({ [CITE_SOURCES_META]: sources, ...(dropped ? { [CITE_DROPPED_META]: dropped } : {}) });
const pr = (n: number, extra: Record<string, unknown> = {}) => ({ n, url: PR, title: "AMD-AGI/PrimusClaw#309 perf", kind: "github_pr", ...extra });

const skip = postgresSkipReason();
const PATH = "/v1/internal/assistant-mcp";

describe("say with citations, on a real Postgres", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";
  let alice: { userId: string; routerSid: string };

  before(async () => {
    w = await startWorld({ CLAW_ASSISTANT_CITATIONS: "true" });
    app = Fastify();
    await (await import("../src/assistant/mcp.js")).registerAssistantMcpRoutes(app, true);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox CASCADE");
    w.events.length = 0;
    alice = await w.user("alice");
  });

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: "brain-mcp-assistant", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${PATH}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }
  const payloads = async () => (await w.q("SELECT payload FROM claw_notification_outbox ORDER BY created_at")).map((r) => r.payload);

  test("SC5 the outbox carries what Brain sent in _meta, never the model's sources; the schema has sources only when on", async () => {
    await w.subscribe("alice");
    const family = w.h.app.metrics.registry.getSingleMetric("claw_assistant_say_sources_total");
    assert.ok(family, "the counter is on the api registry");
    const counted = async (outcome: string) => (await family.get()).values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
    const before = {
      cited: await counted("cited"), missing: await counted("dropped_not_in_turn"), unreferenced: await counted("unreferenced"),
      suppressed: await counted("suppressed_link_text"),
    };

    const router = await connect(w.mod.token.mintAssistantToken(await w.routerTurn(alice) as never, TOKEN_KEY));
    try {
      const say = (await router.listTools()).tools.find((t) => t.name === "say")!;
      assert.deepEqual(Object.keys((say.inputSchema as any).properties), ["text", "item_id", "sources", "suggested"], "sources after text");
      assert.deepEqual((say.inputSchema as any).required, ["text"]);
      const { SAY_SOURCES_PARAM } = await import("../src/assistant/mcp.js");
      assert.deepEqual((say.inputSchema as any).properties.sources, { type: "array", items: { type: "string" }, description: SAY_SOURCES_PARAM },
        "the model is shown a list of addresses");

      const lost = await router.callTool({
        name: "say",
        arguments: { text: "#309 已合入 [1]，CI 全绿 [2]。", sources: [PR, "https://made-up.example/ci"] },
        _meta: meta([pr(1), pr(3)], { not_in_turn: 1, invalid: 0, over_cap: 0 }),
      });
      assert.equal(lost.isError, true, "[2] lost its address: the user would see a number that links nowhere");
      assert.match(JSON.stringify(lost.content), /citation_not_found/);
      const text = "#309 已合入 [1]，CI 全绿。";
      const res = await router.callTool({
        name: "say",
        arguments: { text, sources: [PR, "https://made-up.example/ci"] },
        _meta: meta([pr(1), pr(3)], { not_in_turn: 1, invalid: 0, over_cap: 0 }),
      });
      assert.equal(res.isError, undefined, JSON.stringify(res.content));
      const fabricated = await router.callTool({ name: "say", arguments: { text: "made up [1]", sources: ["https://made-up.example/x"] } });
      assert.equal(fabricated.isError, undefined);
      // `sources` as objects, as one address, as a number: what Brain sent is still what is cited, and the message is not refused.
      for (const sources of [[{ url: PR, title: "x" }], PR, 7, [PR, 3]]) {
        const typo = await router.callTool({ name: "say", arguments: { text: "typed wrong [1]", sources }, _meta: meta([pr(1)]) });
        assert.equal(typo.isError, undefined, `${JSON.stringify(sources)}: ${JSON.stringify(typo.content)}`);
      }
      const linked = await router.callTool({ name: "say", arguments: { text: "merged [1], see www.example.com" }, _meta: meta([pr(1)]) });
      assert.equal(linked.isError, undefined);
    } finally { await router.close(); }

    const [cited, fabricated, ...rest] = await payloads();
    const typos = rest.slice(0, 4);
    assert.deepEqual(typos.map((p) => [p.text, p.sources]), Array.from({ length: 4 }, () => ["typed wrong [1]", [pr(1)]]));
    assert.equal(rest[4].sources, undefined, "a text with a link of its own cites nothing");
    assert.equal(await counted("suppressed_link_text") - before.suppressed, 1);
    assert.equal(cited.text, "#309 已合入 [1]，CI 全绿。", "the text as written");
    assert.deepEqual(cited.sources, [pr(1)]);
    assert.equal(fabricated.sources, undefined, "the model's own addresses are never sources");
    assert.equal(await counted("cited") - before.cited, 1 + 4);
    assert.equal(await counted("dropped_not_in_turn") - before.missing, 1);
    assert.equal(await counted("unreferenced") - before.unreferenced, 1);

    // Off: the same server offers no sources and reads no _meta.
    const { createAssistantMcpServer } = await import("../src/assistant/mcp.js");
    const turn = await w.routerTurn(alice);
    const server = createAssistantMcpServer(turn as never, false, false, false, false, false, false);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const plain = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await plain.connect(b);
    try {
      const say = (await plain.listTools()).tools.find((t) => t.name === "say")!;
      assert.deepEqual(Object.keys((say.inputSchema as any).properties), ["text", "item_id"]);
      await plain.callTool({ name: "say", arguments: { text: "off [1]" }, _meta: meta([pr(1)]) });
    } finally { await plain.close(); }
    assert.equal((await payloads()).at(-1).text, "off [1]");
    assert.equal((await payloads()).at(-1).sources, undefined, "with citations off, _meta is not read");
  });

  test("SC6 the web client's event carries the same sources as the channel's payload", async () => {
    await w.subscribe("alice");
    const turn = await w.routerTurn(alice);
    await w.mod.tools.say(turn as never, { text: "见 [2]" }, w.sayDeps, meta([pr(2)]));
    const [payload] = await payloads();
    const event = w.events.find((e) => e.type === "AssistantSay");
    assert.ok(event);
    assert.deepEqual(payload.sources, [pr(2)]);
    assert.deepEqual(event.sources, payload.sources);
    await w.mod.tools.say(turn as never, { text: "nothing cited" }, w.sayDeps, meta([]));
    assert.equal(w.events.filter((e) => e.type === "AssistantSay").at(-1)!.sources, undefined, "no sources, no field");
  });

  test("SC7 a router turn's request cites with say, and its prompt says how; a worker turn neither", async () => {
    const turn = await w.routerTurn(alice);
    const task: Record<string, any> = { task_id: turn.task_id, message_id: turn.mid, prompt: "#309 合了吗" };
    await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
    assert.deepEqual(task.cite, { tools: ["mcp__assistant__say"], source_servers: [] }, "no GitHub server for a user without a token");
    const reading = await w.routerTurn(alice);
    const rtask: Record<string, any> = { task_id: reading.task_id, message_id: reading.mid, prompt: "总结一下 https://example.com/post" };
    await w.mod.role.applySessionRoleToTask(rtask, alice.routerSid);
    assert.deepEqual(rtask.cite.user_urls, ["https://example.com/post"], "the address the user wrote, which a page read may confirm");
    assert.match(task.system_append, /Citing what you looked up/);
    assert.deepEqual(task.stream_tool_text, ["mcp__assistant__say"], "the say still streams");
    const item = await w.createItem(alice, "Fix the build");
    const worker = await w.workerTurn(item.itemId);
    const wtask: Record<string, any> = { task_id: worker.task_id, message_id: worker.mid, prompt: "go" };
    await w.mod.role.applySessionRoleToTask(wtask, item.workerSid);
    assert.equal(wtask.cite, undefined);
    assert.doesNotMatch(wtask.system_append, /Citing what you looked up/);
  });
});
