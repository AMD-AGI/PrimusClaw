// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * claw_self_status on a real Postgres (`assistant/self-status.ts`; S1, S3 and S4 are in assistant-self-status.test.ts).
 *
 *   S2  it answers, over the last day and every user: messages, the first reply's p50/p90, unanswered (a system fallback is no
 *       reply, another user's say is not this user's reply, a review handed to the chat is counted apart, a message younger than
 *       the reply window is not judged), router turns, items by how they ended, runs, their failure reasons, sandbox failures and
 *       the build; nothing older than the window; and only the router is offered it
 *
 * Skipped without DATABASE_URL, and a skip is not a pass. The source is imported only once the world has set the configuration.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, TOKEN_KEY, type World } from "./support/assistant-world.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A ULID made at `ms`, as `tasks/ids.ts` makes one then. */
function ulidAt(ms: number): string {
  let out = "";
  let n = ms;
  for (let i = 0; i < 10; i++) { const mod = n % 32; out = ALPHABET[mod] + out; n = (n - mod) / 32; }
  return out + "0123456789ABCDEFGHJKMNPQ".slice(0, 16);
}

describe("claw_self_status on a database", { skip: postgresSkipReason() }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";

  before(async () => {
    w = await startWorld({ CLAW_BUILD: "202611070000" });
    app = Fastify();
    await (await import("../src/assistant/mcp.js")).registerAssistantMcpRoutes(app, true);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => { await app?.close(); await w?.stop(); });

  async function connect(claims: object): Promise<Client> {
    const token = w.mod.token.mintAssistantToken(claims as never, TOKEN_KEY);
    const client = new Client({ name: "brain-mcp-assistant", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1/internal/assistant-mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }

  test("S2 the numbers of the last day, for every user, and only the router has the tool", async () => {
    await w.q("TRUNCATE claw_assistant_messages, claw_assistant_says, claw_assistant_review_handoffs, claw_work_items, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions CASCADE");
    const alice = await w.user("alice");
    const now = Date.now();
    const ago = (min: number) => new Date(now - min * 60_000);
    const msg = async (id: string, min: number) => w.q(
      "INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, received_at) VALUES ($1, $2, 'alice', 'hi', $3)",
      [alice.routerSid, id, ago(min)],
    );
    const say = async (user: string, at: Date, fallback = false) => w.q(
      "INSERT INTO claw_assistant_says (say_id, user_id, text, fallback, created_at) VALUES ($1, $2, 'ok', $3, $4)",
      [randomUUID(), user, fallback, at],
    );
    await msg("m1", 60); await say("alice", new Date(ago(60).getTime() + 2_000));
    await msg("m2", 50); await say("alice", new Date(ago(50).getTime() + 10_000));
    await msg("m3", 40); await say("alice", new Date(ago(40).getTime() + 1_000), true); await say("bob", new Date(ago(40).getTime() + 1_000));
    await msg("m4", 30);
    await w.q(
      "INSERT INTO claw_assistant_review_handoffs (handoff_id, user_id, reviewer_user_id, prs, merge, message_id) VALUES ('h1', 'alice', 'wei', ARRAY['a/b#1'], false, 'm4')",
    );
    await msg("m5", 2);
    await msg("m6", 30 * 60);
    // A router session alice had before this one: its message and its turn in the window count, though claw_assistants names the new one.
    await w.q(
      "INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, received_at) VALUES ('old-router', 'm0', 'alice', 'hi', $1)",
      [ago(70)],
    );
    await say("alice", new Date(ago(70).getTime() + 4_000));

    const task = async (id: string, session: string, status: string, min: number, extra: { reason?: string; sandbox?: string } = {}) => w.q(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, failure_reason, sandbox_workload_id, input, metadata, depends_on, created_at)
       VALUES ($1, $2, 'chat', $3, $4, $5, '{}'::jsonb, '{}'::jsonb, '{}', $6)`,
      [id, session, status, extra.reason ?? null, extra.sandbox ?? null, ago(min)],
    );
    const tid = (min: number) => `ktsk_${ulidAt(ago(min).getTime())}`;
    for (const m of [55, 45, 35]) await task(tid(m), alice.routerSid, "completed", m);
    await task(tid(69), "old-router", "completed", 69);
    await task(tid(25), alice.routerSid, "failed", 25);
    await task(tid(30 * 60), alice.routerSid, "failed", 30 * 60);
    await task(tid(20), "ws_1", "completed", 20, { sandbox: "wl-1" });
    await task(tid(19), "ws_2", "failed", 19, { reason: "sandbox_start_timeout" });
    await task(tid(18), "ws_3", "failed", 18, { reason: "brain_timeout", sandbox: "wl-3" });
    await task(tid(17), "ws_4", "failed", 17, { reason: "connect ECONNREFUSED 10.0.0.7:5432 for bob's token sk-abc" });
    await task(tid(16), "ws_5", "failed", 16, { reason: "sk_live_4f9a2b7c" });

    const item = async (seq: number, min: number, state: string, kind: string | null, outcome: string | null) => w.q(
      `INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, last_report_kind, outcome, worker_session_id, created_at)
       VALUES ($1, 'alice', $2, 't', $3, $4, $5, $6, $7)`,
      [`kwi_${ulidAt(ago(min).getTime())}`, seq, state, kind, outcome, `ws_i${seq}`, ago(min)],
    );
    await item(1, 50, "done", "ready", "accepted");
    await item(2, 40, "needs_you", "ready", null);
    await item(3, 30, "needs_you", "failed", null);
    await item(4, 20, "done", "progress", "stopped");
    await item(5, 10, "in_progress", "progress", null);
    await item(6, 30 * 60, "done", "failed", "stopped");

    const turn = await w.routerTurn(alice);
    const router = await connect(turn);
    const item7 = await w.createItem(alice, "Fix the build");
    const worker = await connect(await w.workerTurn(item7.itemId));
    try {
      assert.ok((await router.listTools()).tools.some((t) => t.name === "claw_self_status"));
      assert.ok(!(await worker.listTools()).tools.some((t) => t.name === "claw_self_status"));
      const res = await router.callTool({ name: "claw_self_status", arguments: {} });
      assert.equal(res.isError, undefined);
      const s = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      assert.equal(s.window_hours, 24);
      assert.equal(s.version.build, "202611070000");
      // m0..m5 (m6 is older than a day).
      assert.equal(s.messages.received, 6);
      assert.deepEqual(
        { judged: s.first_reply.judged, answered: s.first_reply.answered, handed: s.first_reply.handed_to_chat, unanswered: s.first_reply.unanswered },
        { judged: 5, answered: 3, handed: 1, unanswered: 1 },
      );
      assert.equal(s.first_reply.unanswered_rate, 0.2);
      // 2, 4 and 10 seconds.
      assert.equal(s.first_reply.p50_s, 4);
      assert.equal(s.first_reply.p90_s, 8.8);
      // Besides the four in the window and the old session's one: createItem ran one more turn of alice's to its end, and routerTurn
      // opened the one now running.
      assert.deepEqual(s.router_turns.by_status, { completed: 3 + 1 + 1, failed: 1, running: 1 });
      assert.equal(s.router_turns.failed, 1);
      assert.deepEqual(s.items.by_outcome, { succeeded: 1, ready_to_accept: 1, failed: 1, stopped: 1, in_progress: 1 + 1 });
      assert.equal(s.runs.failed, 5);
      // A reason that is not a code is never repeated.
      assert.deepEqual(
        Object.fromEntries(s.runs.top_failure_reasons.map((r: { reason: string; count: number }) => [r.reason, r.count])),
        { other: 2, unknown: 1, sandbox_start_timeout: 1, brain_timeout: 1 },
      );
      assert.doesNotMatch(JSON.stringify(s), /ECONNREFUSED|sk-abc|sk_live/);
      assert.deepEqual(s.sandboxes, { runs_with_sandbox: 3, failed: 1, failure_rate: 0.333 });
    } finally {
      await router.close();
      await worker.close();
    }
  });
});
