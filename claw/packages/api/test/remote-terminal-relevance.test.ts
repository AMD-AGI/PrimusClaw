// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which ends of a terminal's turns are pushed at once and which are summed up later (`assistant/terminal-digest.ts`), over real
 * HTTP on a real Postgres with the production schema. The events are what the connector posts (connector/test/turn-origin.test.ts:
 * `origin`, and `turns`/`earlier` for a run of ends folded into one). Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   R1 a turn another session or a schedule started that just finished: not pushed, gathered on its item
 *   R2 one that asks the person something, or failed: pushed as before
 *   R3 one a person started, and one whose connector does not say who started it: pushed as before
 *   R4 a run of ends the connector folded into one: every turn gathered, its results kept
 *   R5 the summary: not before the interval; once after it, with the conversation, the turns, the latest result and that nothing
 *      needs the person; the item's gathered ends cleared; nothing new, nothing said
 *   R6 an end held back by the gap between two pushes is gathered, not lost; the one told is not said again
 *   R7 the owner's interval (`PUT /v1/remote-agents/approvals/summary`, read back on `GET /approvals`); 0 drops what was gathered
 *   R8 pushes off: nothing gathered; muted after gathering: the summary is dropped, not said
 *   R9 two sweeps at once (two replicas): one summary
 *   R10 a folded run whose newest end asks is pushed, and its earlier turns go to the summary; a failure folded into a run that
 *       finished pushes it and is counted
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
type Recorded = Record<string, any>;

describe("which terminal ends are pushed, and the summary", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";
  let store: typeof import("../src/remote-agents/store.js");
  let digest: typeof import("../src/assistant/terminal-digest.js");

  before(async () => {
    w = await startWorld({ CLAW_REMOTE_AGENTS_ENABLED: "true", CLAW_ASSISTANT_TOOLS: "on" });
    store = await import("../src/remote-agents/store.js");
    digest = await import("../src/assistant/terminal-digest.js");
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

  const auto = (message: string, extra: Recorded = {}) => end({ origin: "automation", message, ...extra });
  const HOUR = 60 * 60_000;
  async function convo(owner = "alice") {
    const u = await w.user(owner);
    await w.subscribe(u.userId);
    const cid = await machine(owner, "laptop", [{ ...CLAUDE, capabilities: { roots: ["/home/u"], resumable: [
      { ref: "conv-1", title: "nightly-bot", cwd: "/home/u/work/claw", updated_at: 1, state: "live" },
    ] } }]);
    const sid = (await open(owner, cid, "conv-1")).body.data.session_id as string;
    await events(owner, cid, sid, [started]);
    return { cid, sid };
  }

  test("R1 a turn nobody typed that just finished: not pushed, gathered", async () => {
    const { cid, sid } = await convo();
    await events("alice", cid, sid, [auto("CI 全绿，3 个 PR 都已合入。\n\n细节见日志。")]);
    const item = await remoteItem(sid);
    assert.equal(item.board_state, "done", "the item still records the end");
    assert.equal((await pushed(item.item_id)).length, 0);
    assert.deepEqual({ ...item.params.digest, first_at: 0, last_at: 0 },
      { first_at: 0, last_at: 0, turns: 1, failed: 0, asks: 0, said: ["CI 全绿，3 个 PR 都已合入。"] });
  });

  test("R2 one that asks the person, or failed: pushed", async () => {
    const { cid, sid } = await convo();
    await events("alice", cid, sid, [auto("两个方案都能修。要不要我直接合入方案 A？")]);
    const item = await remoteItem(sid);
    const got = await pushed(item.item_id);
    assert.equal(got.length, 1);
    assert.equal(got[0].remote.kind, "done");
    assert.match(got[0].text, /要不要我直接合入方案 A？/);
    assert.equal((await remoteItem(sid)).params.digest, undefined);
    await w.q("UPDATE claw_work_items SET params = params || '{\"end_told_at\": 1}'::jsonb WHERE item_id = $1", [item.item_id]);
    await events("alice", cid, sid, [auto("API Error: 429", { outcome: "error", error: "rate_limit" })]);
    const after = await pushed(item.item_id);
    assert.deepEqual(after.map((n: Recorded) => n.remote.kind), ["done", "error"]);
  });

  test("R3 a person's turn, and an older connector's end: pushed as before", async () => {
    const { cid, sid } = await convo();
    await events("alice", cid, sid, [end({ origin: "person", message: "修好了。" })]);
    const item = await remoteItem(sid);
    assert.equal((await pushed(item.item_id)).length, 1);
    const bob = await convo("bob");
    await events("bob", bob.cid, bob.sid, [end({ message: "done." })]);
    const other = await remoteItem(bob.sid);
    assert.equal((await pushed(other.item_id)).length, 1, "no origin: told as before");
  });

  test("R4 a folded run: every turn gathered, its results kept", async () => {
    const { cid, sid } = await convo();
    await events("alice", cid, sid, [auto("第三轮：部署完成。", { turns: 3, earlier: ["第一轮：构建通过。", "…长输出的末尾。第二轮：测试通过。"], since: "2026-11-25T01:00:00Z" })]);
    const item = await remoteItem(sid);
    assert.equal((await pushed(item.item_id)).length, 0);
    assert.equal(item.params.digest.turns, 3);
    assert.deepEqual(item.params.digest.said, ["第一轮：构建通过。", "第二轮：测试通过。", "第三轮：部署完成。"]);
  });

  test("R5 the summary: once after the interval, then nothing until something new", async () => {
    const { cid, sid } = await convo();
    await events("alice", cid, sid, [auto("构建通过。")]);
    await events("alice", cid, sid, [auto("测试全部通过，已推送。")]);
    const item = await remoteItem(sid);
    const first = Number(item.params.digest.first_at);
    assert.deepEqual(await digest.runTerminalDigestSweep(first + HOUR - 60_000), { told: 0, dropped: 0 }, "not before the hour");
    assert.deepEqual(await digest.runTerminalDigestSweep(first + HOUR + 1), { told: 1, dropped: 0 });
    const got = await pushed(item.item_id);
    assert.equal(got.length, 1);
    assert.equal(got[0].remote.kind, "progress");
    assert.equal(got[0].remote.item_seq, item.seq);
    assert.equal(got[0].text,
      `【nightly-bot】持续工作中 · laptop · work/claw · #${item.seq}\n`
      + "过去 60 分钟里又跑了 2 轮。最近：测试全部通过，已推送。不需要你处理。\n"
      + `接入：/agent attach conv-1　静音：/approvals mute #${item.seq}　间隔：/approvals summary <分钟>|off`);
    const cleared = await remoteItem(sid);
    assert.equal(cleared.params.digest, undefined);
    assert.equal(cleared.params.summary_told_at, first + HOUR + 1);
    assert.deepEqual(await digest.runTerminalDigestSweep(first + 3 * HOUR), { told: 0, dropped: 0 }, "nothing new");
    assert.equal((await pushed(item.item_id)).length, 1);
  });

  test("R6 an end held back by the gap is gathered, and the one told is not said again", async () => {
    const { cid, sid } = await convo();
    await events("alice", cid, sid, [end({ origin: "person", message: "第一件做完了。" })]);
    await events("alice", cid, sid, [end({ origin: "person", message: "第二件也做完了。" })]);
    const item = await remoteItem(sid);
    assert.equal((await pushed(item.item_id)).length, 1);
    assert.deepEqual(item.params.digest.said, ["第二件也做完了。"]);
    await digest.runTerminalDigestSweep(Number(item.params.digest.first_at) + HOUR + 1);
    const got = await pushed(item.item_id);
    assert.equal(got.length, 2);
    assert.match(got[1].text, /又跑了 1 轮。最近：第二件也做完了。/);
    assert.doesNotMatch(got[1].text, /第一件/);
  });

  test("R7 the owner's interval; 0 drops what was gathered; out of range refused", async () => {
    const { cid, sid } = await convo();
    assert.equal((await call("alice", "GET", "/v1/remote-agents/approvals")).body.data.summary_minutes, 60);
    assert.equal((await call("alice", "PUT", "/v1/remote-agents/approvals/summary", { minutes: 5 })).status, 400);
    assert.equal((await call("alice", "PUT", "/v1/remote-agents/approvals/summary", { minutes: "30" })).status, 400);
    const set = await call("alice", "PUT", "/v1/remote-agents/approvals/summary", { minutes: 30 });
    assert.deepEqual([set.status, set.body.data.summary_minutes], [200, 30]);
    const read = (await call("alice", "GET", "/v1/remote-agents/approvals")).body.data;
    assert.deepEqual([read.enabled, read.summary_minutes], [true, 30], "a new setting keeps the approvals on");
    await events("alice", cid, sid, [auto("一轮。")]);
    const item = await remoteItem(sid);
    const first = Number(item.params.digest.first_at);
    assert.deepEqual(await digest.runTerminalDigestSweep(first + 29 * 60_000), { told: 0, dropped: 0 });
    assert.deepEqual(await digest.runTerminalDigestSweep(first + 31 * 60_000), { told: 1, dropped: 0 });
    await call("alice", "PUT", "/v1/remote-agents/approvals/summary", { minutes: 0 });
    await events("alice", cid, sid, [auto("又一轮。")]);
    const again = await remoteItem(sid);
    assert.deepEqual(await digest.runTerminalDigestSweep(Number(again.params.digest.first_at) + 24 * HOUR), { told: 0, dropped: 1 });
    assert.equal((await remoteItem(sid)).params.digest, undefined);
    assert.equal((await pushed(item.item_id)).length, 1);
  });

  test("R8 pushes off: nothing gathered; muted after gathering: dropped", async () => {
    const { cid, sid } = await convo();
    await call("alice", "PUT", "/v1/remote-agents/approvals", { enabled: false });
    await events("alice", cid, sid, [auto("一轮。")]);
    const item = await remoteItem(sid);
    assert.equal(item.params.digest, undefined);
    await call("alice", "PUT", "/v1/remote-agents/approvals", { enabled: true });
    await events("alice", cid, sid, [auto("又一轮。")]);
    const gathered = await remoteItem(sid);
    assert.equal(gathered.params.digest.turns, 1);
    assert.equal((await mute("alice", item.seq)).status, 200);
    assert.deepEqual(await digest.runTerminalDigestSweep(Number(gathered.params.digest.first_at) + 2 * HOUR), { told: 0, dropped: 1 });
    assert.equal((await pushed(item.item_id)).length, 0);
  });

  test("R9 two sweeps at once: one summary", async () => {
    const { cid, sid } = await convo();
    await events("alice", cid, sid, [auto("一轮。")]);
    const item = await remoteItem(sid);
    const at = Number(item.params.digest.first_at) + HOUR + 1;
    const [a, b] = await Promise.all([digest.runTerminalDigestSweep(at), digest.runTerminalDigestSweep(at)]);
    assert.equal(a.told + b.told, 1);
    assert.equal((await pushed(item.item_id)).length, 1);
  });

  test("R10 a pushed run's earlier turns are summed up; a folded failure is pushed and counted", async () => {
    const { cid, sid } = await convo();
    await events("alice", cid, sid, [auto("构建和测试都过了。要不要发布？", { turns: 3, earlier: ["构建通过。", "测试通过。"], since: "2026-11-25T01:00:00Z" })]);
    const item = await remoteItem(sid);
    assert.equal((await pushed(item.item_id)).length, 1, "the question is pushed");
    assert.deepEqual([item.params.digest.turns, item.params.digest.said, item.params.digest.failed], [2, ["构建通过。", "测试通过。"], 0]);

    const bob = await convo("bob");
    await events("bob", bob.cid, bob.sid, [auto("重试后完成。", { turns: 2, earlier: ["API Error: 429"], failed_earlier: 1, since: "2026-11-25T01:00:00Z" })]);
    const other = await remoteItem(bob.sid);
    assert.equal((await pushed(other.item_id)).length, 1, "a failure in the run pushes it");
    assert.deepEqual([other.params.digest.turns, other.params.digest.failed], [1, 1]);

    // a question in an earlier turn of the run, the newest a plain report: pushed, and the summary says something asked
    const carol = await convo("carol");
    await events("carol", carol.cid, carol.sid, [auto("日志已归档。", { turns: 2, earlier: ["可以合入了。要不要我现在合？"], since: "2026-11-25T01:00:00Z" })]);
    const third = await remoteItem(carol.sid);
    assert.equal((await pushed(third.item_id)).length, 1);
    assert.deepEqual([third.params.digest.turns, third.params.digest.asks], [1, 1]);
  });
});
