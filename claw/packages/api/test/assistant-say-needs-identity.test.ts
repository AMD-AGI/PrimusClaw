// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A router turn answering a message that came with a key (no confirmed identity) that was refused something only the person may do
 * (`not_attended`) says so to the channel: its say carries `needs_identity`, so the channel can offer the person to confirm their
 * identity once (2026-11-11: a new user with a key asked "连接我的开发机" and was never told why there was no one-line command).
 * Runs on a real Postgres, skipped without DATABASE_URL (a skip is not a pass).
 *
 *   NI1 a key turn refused not_attended: the refusal is noted on its message, and its say carries needs_identity to the channel's
 *       payload and the web client's event
 *   NI2 a signed-in turn refused for another reason, and a key turn that was refused nothing: no needs_identity, nothing noted
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("say after a not_attended refusal, on a real Postgres", { skip }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };

  before(async () => { w = await startWorld(); });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox, claw_assistant_messages CASCADE");
    w.events.length = 0;
    alice = await w.user("alice");
    await w.subscribe("alice");
  });
  const payloads = async () => (await w.q("SELECT payload FROM claw_notification_outbox ORDER BY created_at")).map((r) => r.payload);
  const noted = async (mid: string) =>
    (await w.q("SELECT identity_refused_at IS NOT NULL AS n FROM claw_assistant_messages WHERE message_id = $1", [mid]))[0].n;

  /** A live router turn answering `content`, sent signed in (`signedIn`) or with a key (attended_via NULL). */
  async function turn(content: string, signedIn: boolean) {
    const t = await w.routerTurn(alice);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, received_at)
       VALUES ($1, $2, $3, 'Alice A', $4, $5::jsonb, NOW())`,
      [alice.routerSid, t.mid, alice.userId, content, signedIn ? JSON.stringify({ kind: "person" }) : null],
    );
    return t;
  }

  async function client(claims: unknown): Promise<Client> {
    const { createAssistantMcpServer } = await import("../src/assistant/mcp.js");
    const server = createAssistantMcpServer(claims as never, false, true, false, false, false, false);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await c.connect(b);
    return c;
  }
  const save = (c: Client) => c.callTool({ name: "memory_save", arguments: {
    type: "user", title: "prefers zh", body: "answer in Chinese", evidence_quote: "记住我用中文",
  } }) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

  test("NI1 a key turn refused not_attended: noted, and its say carries needs_identity to the channel and the web client", async () => {
    const t = await turn("记住我用中文", false);
    const c = await client(t);
    try {
      const refused = await save(c);
      assert.equal(refused.isError, true);
      assert.equal(JSON.parse(refused.content[0].text).error, "not_attended");
      assert.equal(await noted(t.mid), true, "the refusal is noted on the message");
      const said = await c.callTool({ name: "say", arguments: { text: "这一步需要你本人确认身份后才能做。" } });
      assert.equal(said.isError, undefined, JSON.stringify(said.content));
    } finally { await c.close(); }
    const [p] = await payloads();
    assert.equal(p.type, "assistant.say");
    assert.equal(p.needs_identity, true);
    assert.equal(p.text, "这一步需要你本人确认身份后才能做。");
    // The web client's event, through the same say with the world's publisher.
    await w.mod.tools.say(t as never, { text: "再说一遍。" }, w.sayDeps);
    const ev = w.events.filter((e) => e.type === "AssistantSay").at(-1);
    assert.equal(ev?.needs_identity, true);
  });

  test("NI2 a signed-in turn refused something else, and a key turn refused nothing: no needs_identity, nothing noted", async () => {
    const signedIn = await turn("记住我用中文", true);
    const c = await client(signedIn);
    try {
      // Refused for another reason (memory is off for alice), never not_attended: nothing is noted.
      const other = await save(c);
      assert.notEqual(JSON.parse(other.content[0].text).error, "not_attended", other.content[0].text);
      await c.callTool({ name: "say", arguments: { text: "记住了。" } });
    } finally { await c.close(); }
    assert.equal(await noted(signedIn.mid), false);
    const key = await turn("你好", false);
    const k = await client(key);
    try { await k.callTool({ name: "say", arguments: { text: "你好！" } }); } finally { await k.close(); }
    assert.equal(await noted(key.mid), false);
    const all = await payloads();
    assert.deepEqual([...new Set(all.map((p) => p.text))].sort(), ["你好！", "记住了。"].sort(), JSON.stringify(all));
    for (const p of all) assert.equal(p.needs_identity, undefined, JSON.stringify(p));
  });
});
