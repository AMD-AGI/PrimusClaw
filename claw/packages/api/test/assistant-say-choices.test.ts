// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The choice a router's `say` puts to the user (`assistant/choices.ts`, `CLAW_ASSISTANT_CHOICES`). The DB part runs on a real
 * Postgres, skipped without DATABASE_URL (a skip is not a pass).
 *
 *   CH1 a choice is 2 to 10 plain lines, each short and once; a list with any option that does not fit (an address, a line break, a
 *       slash command, internal text, too long, not text) is no choice at all, never a part of one; `multiple` is a boolean or absent
 *   CH2 say's schema has `choices` after `text` with the switch on (its description tells the model to use it) and not at all with it
 *       off; a choice reaches the channel's payload and the web client's event as `choices`, single and multiple; one that does not
 *       fit never refuses the message
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("say with a choice, on a real Postgres", { skip }, () => {
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

  async function sayTool(on: boolean): Promise<{ client: Client; tool: Record<string, any> }> {
    const { createAssistantMcpServer } = await import("../src/assistant/mcp.js");
    const server = createAssistantMcpServer(await w.routerTurn(alice) as never, false, false, false, false, false, false, on);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await client.connect(b);
    const tool = (await client.listTools()).tools.find((t) => t.name === "say")!;
    return { client, tool: tool as Record<string, any> };
  }

  test("CH2 a choice reaches the channel and the web client; one that does not fit never refuses the message", async () => {
    await w.subscribe("alice");
    const { SAY_CHOICES_PARAM } = await import("../src/assistant/choices.js");
    const on = await sayTool(true);
    try {
      assert.deepEqual(Object.keys(on.tool.inputSchema.properties), ["text", "item_id", "choices"], "choices after text");
      assert.equal(on.tool.inputSchema.properties.choices.description, SAY_CHOICES_PARAM);
      assert.deepEqual(on.tool.inputSchema.properties.choices.properties.options, { type: "array", items: { type: "string" } });
      assert.match(on.tool.description, /pick among options, pass the options in choices/, "the tool itself tells the model to use it");
      const one = await on.client.callTool({ name: "say", arguments: { text: "部署到哪个集群？", choices: { options: ["prod", "staging", "prod"] } } });
      assert.equal(one.isError, undefined, JSON.stringify(one.content));
      const several = await on.client.callTool({
        name: "say", arguments: { text: "要看哪些仓库？", choices: { options: ["PrimusClaw", "Primus-SaFE", "Primus-Turbo"], multiple: true } },
      });
      assert.equal(several.isError, undefined, JSON.stringify(several.content));
      const odd = await on.client.callTool({ name: "say", arguments: { text: "好的。", choices: "not a choice" } });
      assert.equal(odd.isError, undefined, "a choices that does not fit the schema is read as none");
      const half = await on.client.callTool({ name: "say", arguments: { text: "选一个。", choices: { options: ["a", "/unlink"] } } });
      assert.equal(half.isError, undefined, "a choice with an option that does not fit is read as none");
    } finally { await on.client.close(); }
    const [single, multiple, odd, half] = await payloads();
    assert.deepEqual(single.choices, { options: ["prod", "staging"], multiple: false }, "single, the option written twice once");
    assert.deepEqual(multiple.choices, { options: ["PrimusClaw", "Primus-SaFE", "Primus-Turbo"], multiple: true });
    assert.equal(odd.choices, undefined, "none, no field");
    assert.equal(half.choices, undefined, "never a part of a choice");
    assert.equal(half.text, "选一个。", "the message goes all the same");

    // The web client's event, through the same say with the world's publisher.
    const turn = await w.routerTurn(alice);
    await w.mod.tools.say(turn as never, { text: "哪个？", choices: { options: ["甲", "乙"] } }, w.sayDeps);
    await w.mod.tools.say(turn as never, { text: "好的。" }, w.sayDeps);
    const said = await payloads();
    assert.deepEqual(said.at(-2).choices, { options: ["甲", "乙"], multiple: false });
    const events = w.events.filter((e) => e.type === "AssistantSay");
    assert.deepEqual(events.at(-2)!.choices, said.at(-2).choices, "the web client sees what the channel gets");
    assert.equal(events.at(-1)!.choices, undefined);

    const off = await sayTool(false);
    try {
      assert.deepEqual(Object.keys(off.tool.inputSchema.properties), ["text", "item_id"]);
      assert.doesNotMatch(off.tool.description, /choices/);
      await off.client.callTool({ name: "say", arguments: { text: "off", choices: { options: ["a", "b"] } } });
    } finally { await off.client.close(); }
    assert.equal((await payloads()).at(-1).choices, undefined, "off, no choice is put");
  });
});

// Last, and imported here: the DB suite's world sets the environment the config is read with, so nothing may load it before.
test("CH1 a choice is 2 to 10 plain lines; one that does not fit is no choice at all", async () => {
  const { sayChoice, CHOICES_MAX, CHOICE_MAX_CHARS } = await import("../src/assistant/choices.js");
  assert.deepEqual(sayChoice({ options: [" 部署到  prod ", "staging"] }), { options: ["部署到 prod", "staging"], multiple: false });
  assert.deepEqual(sayChoice({ options: ["a", "b", "a"], multiple: true }), { options: ["a", "b"], multiple: true }, "none twice");
  assert.deepEqual(sayChoice({ options: ["PR #12 *修复* 登录", "feature_x 分支"] }), { options: ["PR #12 *修复* 登录", "feature_x 分支"], multiple: false },
    "a card's option is plain text: what reads as markup elsewhere is only its words here");
  for (const bad of [
    "看 https://evil.example", "www.evil.example", "/unlink", "line\nbreak", "tab\there", "", "   ", "x".repeat(CHOICE_MAX_CHARS + 1),
    "call mcp__assistant__work_stop", "kwi_abcdef12", 42, null,
  ]) {
    assert.equal(sayChoice({ options: ["ok", bad] }), undefined, `one option that does not fit: no choice (${JSON.stringify(bad)})`);
  }
  assert.equal(sayChoice({ options: ["only"] }), undefined, "one option is no choice");
  assert.equal(sayChoice({ options: ["same", "same"] }), undefined, "one option written twice is one");
  assert.equal(sayChoice({ options: Array.from({ length: CHOICES_MAX + 1 }, (_, i) => `o${i}`) }), undefined, "too many");
  assert.equal(sayChoice({ options: Array.from({ length: CHOICES_MAX }, (_, i) => `o${i}`) })?.options.length, CHOICES_MAX);
  assert.equal(sayChoice({ options: ["a", "b"], multiple: "yes" }), undefined, "multiple is a boolean");
  assert.equal(sayChoice({ options: "a,b" }), undefined);
  assert.equal(sayChoice(["a", "b"]), undefined, "a bare list is not a choice");
  assert.equal(sayChoice("a"), undefined);
  assert.equal(sayChoice(undefined), undefined);
  assert.equal(sayChoice(null), undefined);
  assert.equal(sayChoice({ options: ["好".repeat(CHOICE_MAX_CHARS), "b"] })?.options.length, 2, "the limit counts code points");
  const id = "0f2b6c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
  assert.equal(sayChoice({ options: [`run ${id}`, "b"] }), undefined, "an id the user did not write is internal");
  assert.deepEqual(sayChoice({ options: [`run ${id}`, "b"] }, `what about ${id}?`)?.options, [`run ${id}`, "b"], "one they wrote is theirs");
});
