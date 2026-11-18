// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The replies a router's `say` suggests (`assistant/suggested.ts`, `CLAW_ASSISTANT_SUGGESTED_REPLIES`). The DB part runs on a real
 * Postgres, skipped without DATABASE_URL (a skip is not a pass).
 *
 *   SG1 at most three, one plain line each, short, none twice; an address, markup, a slash command or internal text is left out
 *   SG2 say's schema has `suggested` after `text` with the switch on and not at all with it off; what is suggested reaches the
 *       channel's payload and the web client's event as `suggested_replies`; one that does not fit never refuses the message
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("say with suggested replies, on a real Postgres", { skip }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };

  before(async () => { w = await startWorld(); });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox CASCADE");
    w.events.length = 0;
    alice = await w.user("alice");
  });
  const payloads = async () => (await w.q("SELECT payload FROM claw_notification_outbox ORDER BY created_at")).map((r) => r.payload);

  async function sayTool(on: boolean): Promise<{ client: Client; schema: Record<string, any> }> {
    const { createAssistantMcpServer } = await import("../src/assistant/mcp.js");
    const server = createAssistantMcpServer(await w.routerTurn(alice) as never, false, false, false, false, false, on, false);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await client.connect(b);
    const say = (await client.listTools()).tools.find((t) => t.name === "say")!;
    return { client, schema: say.inputSchema as Record<string, any> };
  }

  test("SG2 what say suggests reaches the channel and the web client; one that does not fit never refuses it", async () => {
    await w.subscribe("alice");
    const { SAY_SUGGESTED_PARAM } = await import("../src/assistant/suggested.js");
    const on = await sayTool(true);
    try {
      assert.deepEqual(Object.keys(on.schema.properties), ["text", "item_id", "suggested"], "suggested after text");
      assert.deepEqual(on.schema.properties.suggested, { type: "array", items: { type: "string" }, description: SAY_SUGGESTED_PARAM });
      const ok = await on.client.callTool({ name: "say", arguments: { text: "你有 21 个开着的 PR。", suggested: ["按仓库分组", "/unlink", "哪些 CI 红了"] } });
      assert.equal(ok.isError, undefined, JSON.stringify(ok.content));
      const odd = await on.client.callTool({ name: "say", arguments: { text: "好的。", suggested: "not a list" } });
      assert.equal(odd.isError, undefined, "a suggested that does not fit is read as none");
    } finally { await on.client.close(); }
    // The web client's event, through the same say with the world's publisher.
    const turn = await w.routerTurn(alice);
    await w.mod.tools.say(turn as never, { text: "你有 21 个开着的 PR。", suggested: ["按仓库分组", "/unlink", "哪些 CI 红了"] }, w.sayDeps);
    await w.mod.tools.say(turn as never, { text: "好的。" }, w.sayDeps);
    const [first, second, third, fourth] = await payloads();
    assert.deepEqual(first.suggested_replies, ["按仓库分组", "哪些 CI 红了"]);
    assert.equal(second.suggested_replies, undefined, "none, no field");
    assert.deepEqual(third.suggested_replies, first.suggested_replies);
    assert.equal(fourth.suggested_replies, undefined);
    const events = w.events.filter((e) => e.type === "AssistantSay");
    assert.deepEqual(events[0].suggested_replies, third.suggested_replies, "the web client sees what the channel gets");
    assert.equal(events[1].suggested_replies, undefined);

    const off = await sayTool(false);
    try {
      assert.deepEqual(Object.keys(off.schema.properties), ["text", "item_id"]);
      await off.client.callTool({ name: "say", arguments: { text: "off", suggested: ["继续"] } });
    } finally { await off.client.close(); }
    assert.equal((await payloads()).at(-1).suggested_replies, undefined, "off, nothing is suggested");
  });
});

// Last, and imported here: the DB suite's world sets the environment the config is read with, so nothing may load it before.
test("SG1 suggested replies are short plain lines the user could have typed", async () => {
  const { suggestedReplies, SUGGESTED_MAX, SUGGESTED_MAX_CHARS } = await import("../src/assistant/suggested.js");
  assert.deepEqual(suggestedReplies(["列出失败的那几个", "  详细说说   #12 ", "Show the logs"]), ["列出失败的那几个", "详细说说 #12", "Show the logs"]);
  assert.equal(suggestedReplies(["a", "b", "c", "d"]).length, SUGGESTED_MAX);
  assert.deepEqual(suggestedReplies(["same", "same", "other"]), ["same", "other"], "none twice");
  assert.deepEqual(suggestedReplies([
    "x".repeat(SUGGESTED_MAX_CHARS + 1), "看 https://evil.example", "www.evil.example", "**bold**", "[a](b)", "<b>x</b>", "/unlink",
    "line\nbreak", "", "   ", 42, null, "call mcp__assistant__work_stop", "ok",
  ]), ["ok"]);
  assert.deepEqual(suggestedReplies("not a list"), []);
  assert.deepEqual(suggestedReplies(undefined), []);
  assert.equal(suggestedReplies(["好".repeat(SUGGESTED_MAX_CHARS)]).length, 1, "the limit counts code points");
});
