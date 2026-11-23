// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The end of a turn in a terminal nobody was at (`terminal_turn_end`, posted by the connector on the conversation's terminal-hook
 * session) and the per-conversation mute (`PUT /v1/remote-agents/approvals/mutes`), over real HTTP on a real Postgres with the
 * production schema. The events are what the connector posts for the hook payloads Claude Code 2.1.328 and Codex 0.153.4 hand it
 * (measured; connector/test/turn-ends.test.ts). Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   U1 a finished turn: the item is made (or closed) with the end, and the owner is told once, naming the machine, the tool, the
 *      conversation and its folder, the item, the agent's last words and how to mute it; `remote.kind` done
 *   U2 a turn that failed: told as an error, with its reason (`remote.kind` error)
 *   U3 several ends of one conversation within the gap: each recorded on the item, one told
 *   U4 the conversation's own name (the connector's list) is said instead of its folder's
 *   U5 off for the owner (`/approvals off`): recorded, not told
 *   U6 muted by its item: nothing more told (ends, requests), its open session closed for the connector, a new one refused
 *      (`session_muted`) while every other conversation goes on; unmuted, it opens again
 *   U7 a mute names a terminal item of the caller's own: anything else is refused
 *   U8 a muted conversation's wait in its terminal is not told either
 *   U9 a Codex conversation's end is said as Codex's
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
type Recorded = Record<string, any>;

describe("turn ends and mutes from terminals", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";
  let store: typeof import("../src/remote-agents/store.js");
  let tools: typeof import("../src/assistant/devenv-tools.js");

  before(async () => {
    w = await startWorld({ CLAW_REMOTE_AGENTS_ENABLED: "true", CLAW_ASSISTANT_TOOLS: "on" });
    store = await import("../src/remote-agents/store.js");
    tools = await import("../src/assistant/devenv-tools.js");
    const { registerRemoteAgentRoutes } = await import("../src/routes/remote-agents.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") return;
      (req as any).user = { userId: id, userName: id, platformKey: "", virtualKey: "", roles: ["default"] };
      (req as any).authMethod = "identity_token";
    });
    await registerRemoteAgentRoutes(app, { pingMs: 150, pollMs: 40, retentionDays: 0, undeliveredSweepMs: 0, presenceSweepMs: 0, maxActiveSessionsPerUser: 1 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_remote_events, claw_remote_commands, claw_remote_sessions, claw_remote_agents, claw_remote_connector_transitions, claw_remote_connectors,
      claw_remote_audit, claw_remote_approval_settings, claw_remote_terminal_mutes, claw_remote_terminal_waits, claw_work_items, claw_work_item_events, claw_tasks, claw_assistants, claw_sessions,
      claw_assistant_messages, claw_assistant_says, claw_notification_outbox, claw_notification_subscriptions CASCADE`);
    seqs.clear();
  });

  async function call(user: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(base + path, {
      method, headers: { "x-test-user": user, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  const post = (user: string, path: string, body: unknown) => call(user, "POST", path, body);
  const CLAUDE = { agent_id: "claude", kind: "claude", name: "Claude Code", capabilities: { roots: ["/home/u"] } };
  const CODEX = { agent_id: "codex", kind: "codex", name: "Codex", capabilities: { roots: ["/home/u"] } };
  async function machine(owner: string, name: string, agents: Recorded[] = [CLAUDE]): Promise<string> {
    const row = await store.registerConnector(owner, name, "0.1.23", null, 10);
    assert.ok(row);
    await store.recordHeartbeat(row.connector_id, owner, { version: "0.1.23", cmdCursor: null, agents: agents as never });
    await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW(), stream_seen_at = NOW() WHERE connector_id = $1", [row.connector_id]);
    return String(row.connector_id);
  }
  const open = (owner: string, cid: string, ref: string, extra: Recorded = {}) =>
    post(owner, `/v1/remote-agents/connectors/${cid}/terminal-sessions`, { agent_id: "claude", ref, cwd: "/home/u/work/claw", title: "修 CI", ...extra });
  const seqs = new Map<string, number>();
  async function events(owner: string, cid: string, sid: string, list: Array<[string, Recorded]>): Promise<void> {
    const out = list.map(([type, data]) => {
      const n = (seqs.get(sid) ?? 0) + 1;
      seqs.set(sid, n);
      return { session_id: sid, seq: n, type, ts: Date.now(), data };
    });
    const r = await post(owner, `/v1/remote-agents/connectors/${cid}/events`, { batch_id: `b${Math.random()}`, events: out });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.rejected, []);
  }
  const started: [string, Recorded] = ["session_started", { origin: "terminal_hook", ref: "conv-1", title: "修 CI", agent: "claude", cwd: "/home/u/work/claw" }];
  const OPTIONS = [
    { optionId: "o0", name: "Red", kind: "allow_once" }, { optionId: "o1", name: "Blue", kind: "allow_once" },
  ];
  const ask = (actionId: string, tool = "Which color?"): [string, Recorded] =>
    ["permissionRequest", { actionId, tool, kind: "question", input: null, toolCallId: null, options: OPTIONS, timeout_ms: 3_600_000, origin: "terminal_hook", cwd: "/home/u/work/claw" }];
  const remoteItem = async (sid: string) => (await w.q("SELECT * FROM claw_work_items WHERE worker_session_id = $1", [`remote:${sid}`]))[0];
  /** What was pushed of the session of `itemId` (filed under the item or not), oldest first. */
  const pushed = async (itemId: string) => (await w.q(
    `SELECT o.payload FROM claw_notification_outbox o
      WHERE o.payload->'remote'->>'session_id' = (SELECT params->>'session_id' FROM claw_work_items WHERE item_id = $1) ORDER BY o.id`, [itemId],
  )).map((r: Recorded) => r.payload as Recorded);
  /** How many messages are filed under the item (the one per wait that told the user of it). */
  const filed = async (itemId: string) => (await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_says WHERE item_id = $1", [itemId]))[0].n;

  const end = (extra: Recorded = {}): [string, Recorded] => ["terminal_turn_end", {
    ref: "conv-1", outcome: "done", message: "probe done.", agent: "claude", cwd: "/home/u/work/claw",
    ended_at: "2026-11-23T10:10:59.905Z", away_ms: 61_000, ...extra,
  }];
  const mute = (user: string, item: unknown, muted = true) => call(user, "PUT", "/v1/remote-agents/approvals/mutes", { item, muted });

  test("U1 a finished turn is told once, with where, the item, the last words and how to mute it", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const sid = (await open("alice", cid, "conv-1")).body.data.session_id as string;
    await events("alice", cid, sid, [started]);
    assert.equal(await remoteItem(sid), undefined, "no item until it asks or ends");
    await events("alice", cid, sid, [end({ message: "全部测试通过。\n下一步：发 PR。" })]);
    const item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.outcome, item.params.origin], ["done", "answered", "terminal"]);
    assert.match(item.summary, /^已完成 全部测试通过/);
    const got = await pushed(item.item_id);
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.equal(got[0].text, `#${item.seq} laptop 上终端里的 Claude Code（修 CI，work/claw）做完了，之后终端那边一直没人操作。\n它最后说：\n全部测试通过。\n下一步：发 PR。\n（不想再收到这个会话的推送：/approvals mute #${item.seq}）`);
    assert.deepEqual([got[0].remote.kind, got[0].remote.session_id, got[0].remote.machine, got[0].remote.tool, got[0].remote.ask], ["done", sid, "laptop", "claude", undefined]);
    assert.equal(await filed(item.item_id), 1, "filed under the item");
    // The same event posted again (a connector's retry) says nothing twice.
    await events("alice", cid, sid, []);
    assert.equal((await pushed(item.item_id)).length, 1);
  });

  test("U2 a turn that failed is told as an error, with its reason", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const sid = (await open("alice", cid, "conv-1", { title: "fix CI" })).body.data.session_id as string;
    await events("alice", cid, sid, [["session_started", { ...started[1], title: "fix CI" }], end({
      outcome: "error", error: "unknown",
      message: "API Error: 400 400: {'error': 'anthropic_messages: Invalid model name passed in model=claude-nonexistent-xyz-1.'}",
    })]);
    const item = await remoteItem(sid);
    const got = await pushed(item.item_id);
    assert.equal(got.length, 1);
    assert.equal(got[0].remote.kind, "error");
    assert.match(got[0].text, new RegExp(`^#${item.seq} Claude Code in a terminal on laptop \\(fix CI, work/claw\\) stopped with an error \\(unknown\\); nobody has typed in that terminal since\\.$`, "m"));
    assert.match(got[0].text, /Invalid model name/);
    assert.match(got[0].text, new RegExp(`/approvals mute #${item.seq}\\)$`));
  });

  test("U3 several ends of one conversation within the gap: each recorded, one told", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const sid = (await open("alice", cid, "conv-1")).body.data.session_id as string;
    await events("alice", cid, sid, [started, end({ message: "one" })]);
    await events("alice", cid, sid, [end({ message: "two" })]);
    await events("alice", cid, sid, [end({ outcome: "error", error: "rate_limit", message: "three" })]);
    const item = await remoteItem(sid);
    assert.equal((await pushed(item.item_id)).length, 1);
    const answers = await w.q("SELECT summary FROM claw_work_item_events WHERE item_id = $1 AND kind = 'answer' ORDER BY id", [item.item_id]);
    assert.deepEqual(answers.map((a: Recorded) => a.summary), ["已完成 one", "已完成 two", "出错停下了（rate_limit） three"]);
    // Past the gap, the next one is told again.
    await w.q("UPDATE claw_work_items SET params = params || '{\"end_told_at\": 1}'::jsonb WHERE item_id = $1", [item.item_id]);
    await events("alice", cid, sid, [end({ message: "four" })]);
    assert.equal((await pushed(item.item_id)).length, 2);
  });

  test("U4 the conversation's own name, as its machine lists it, is said instead of the folder's", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop", [{ ...CLAUDE, capabilities: { roots: ["/home/u"], resumable: [
      { ref: "conv-1", title: "支付服务重构", cwd: "/home/u/work/claw", updated_at: 1, state: "live" },
    ] } }]);
    const sid = (await open("alice", cid, "conv-1")).body.data.session_id as string;
    await events("alice", cid, sid, [started, end()]);
    const item = await remoteItem(sid);
    assert.match((await pushed(item.item_id))[0].text, /Claude Code（支付服务重构，work\/claw）做完了/);
  });

  test("U5 off for the owner: the end is recorded, not told", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const sid = (await open("alice", cid, "conv-1")).body.data.session_id as string;
    await call("alice", "PUT", "/v1/remote-agents/approvals", { enabled: false });
    await events("alice", cid, sid, [started, end()]);
    const item = await remoteItem(sid);
    assert.equal(item.board_state, "done");
    assert.equal((await pushed(item.item_id)).length, 0);
  });

  test("U6 muted by its item: nothing more told, its session closed, a new one refused; others go on; unmuted it opens again", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const sid = (await open("alice", cid, "conv-1")).body.data.session_id as string;
    const other = (await open("alice", cid, "conv-2")).body.data.session_id as string;
    await events("alice", cid, sid, [started, end()]);
    const item = await remoteItem(sid);
    const m = await mute("alice", item.seq);
    assert.equal(m.status, 200, JSON.stringify(m.body));
    assert.deepEqual(m.body.data, { item: item.seq, muted: true, machine: "laptop", title: "修 CI" });
    // Its open session is closed: the connector gives what waits back to the terminal.
    assert.equal((await w.q("SELECT status FROM claw_remote_sessions WHERE session_id = $1", [sid]))[0].status, "closed");
    assert.deepEqual((await w.q("SELECT type FROM claw_remote_commands WHERE session_id = $1", [sid])).map((c: Recorded) => c.type), ["close"]);
    const again = await open("alice", cid, "conv-1");
    assert.deepEqual([again.status, again.body.error], [409, "session_muted"]);
    assert.equal((await open("alice", cid, "conv-2")).status, 200, "another conversation of the machine goes on");
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_remote_audit WHERE action = 'terminal_mute.set'"))[0].n, 1);
    // An event still on its way for the muted conversation is recorded, not told.
    await events("alice", cid, other, [["session_started", { ...started[1], ref: "conv-2" }]]);
    await w.q("UPDATE claw_remote_sessions SET status = 'active' WHERE session_id = $1", [sid]);
    await events("alice", cid, sid, [ask("act-1"), end({ message: "late" })]);
    assert.equal((await pushed(item.item_id)).length, 1, "nothing after the mute");
    await w.q("UPDATE claw_remote_sessions SET status = 'closed' WHERE session_id = $1", [sid]);
    // Unmuted: it opens again, and is told again.
    assert.deepEqual((await mute("alice", item.seq, false)).body.data.muted, false);
    const back = await open("alice", cid, "conv-1");
    assert.equal(back.status, 201);
  });

  test("U7 a mute names a terminal item of the caller's own", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const sid = (await open("alice", cid, "conv-1")).body.data.session_id as string;
    await events("alice", cid, sid, [started, end()]);
    const item = await remoteItem(sid);
    assert.deepEqual([(await mute("bob", item.seq)).status, (await mute("bob", item.seq)).body.error], [404, "item_not_found"]);
    assert.equal((await mute("alice", 9999)).status, 404);
    assert.deepEqual([(await mute("alice", "1")).status, (await mute("alice", 0)).status], [400, 400]);
    assert.equal((await call("alice", "PUT", "/v1/remote-agents/approvals/mutes", { item: item.seq })).status, 400);
    await w.q("UPDATE claw_work_items SET params = params || '{\"origin\": \"assistant\"}'::jsonb WHERE item_id = $1", [item.item_id]);
    assert.deepEqual([(await mute("alice", item.seq)).status, (await mute("alice", item.seq)).body.error], [409, "not_a_terminal_item"]);
  });

  test("U8 a muted conversation's wait in its terminal is not told either", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const waits = await import("../src/remote-agents/terminal-waits.js");
    const resumable = (state: string) => [{ ref: "conv-1", title: "修 CI", cwd: "/home/u/work/claw", updated_at: 1, state, activity: "waiting", waiting_for: "input needed" }];
    const cid = await machine("alice", "laptop", [{ ...CLAUDE, capabilities: { roots: ["/home/u"], resumable: resumable("live") } }]);
    const sid = (await open("alice", cid, "conv-1")).body.data.session_id as string;
    await events("alice", cid, sid, [started, end()]);
    const item = await remoteItem(sid);
    assert.equal((await mute("alice", item.seq)).status, 200);
    const told: unknown[] = [];
    const tell = waits.terminalWaitPorts.tell;
    waits.terminalWaitPorts.tell = async (n) => { told.push(n); return true; };
    try {
      await waits.runTerminalWaitSweep(60_000, 0);
      await w.q("UPDATE claw_remote_terminal_waits SET since = NOW() - interval '5 minutes'");
      await w.q("UPDATE claw_remote_agents SET updated_at = NOW() + interval '1 minute'");
      const out = await waits.runTerminalWaitSweep(60_000, 0);
      assert.equal(out.waiting, 1, "it waits");
      assert.deepEqual(told, [], "muted: not told");
      // Unmuted, a new episode is told.
      await mute("alice", item.seq, false);
      await w.q("DELETE FROM claw_remote_terminal_waits");
      await waits.runTerminalWaitSweep(60_000, 0);
      await w.q("UPDATE claw_remote_terminal_waits SET since = NOW() - interval '5 minutes'");
      await waits.runTerminalWaitSweep(60_000, 0);
      assert.equal(told.length, 1);
    } finally { waits.terminalWaitPorts.tell = tell; }
  });

  test("U9 a Codex conversation's end is said as Codex's", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop", [CODEX]);
    const sid = (await open("alice", cid, "conv-1", { agent_id: "codex", title: "fix CI" })).body.data.session_id as string;
    await events("alice", cid, sid, [["session_started", { ...started[1], title: "fix CI", agent: "codex" }], end({ agent: "codex", message: "codex probe done." })]);
    const item = await remoteItem(sid);
    const got = await pushed(item.item_id);
    assert.equal(got[0].remote.tool, "codex");
    assert.match(got[0].text, /Codex in a terminal on laptop \(fix CI, work\/claw\) finished/);
    assert.match(got[0].text, /codex probe done\./);
  });
});
