// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Approvals a terminal asks for, carried to the phone (`POST .../connectors/:cid/terminal-sessions`, `store.openTerminalSession`,
 * `assistant/remote-items.ts` origin `terminal`), over real HTTP on a real Postgres with the production schema. Skipped without
 * DATABASE_URL, and a skip is not a pass.
 *
 *   T1 a connector opens one session per terminal conversation: the same ref finds the same open session (200, created false), another
 *      ref or another machine gets its own; it is not one of the user's sessions (never counted against the limit, never closed to make
 *      room, never one the assistant sends work to); a closed one is opened anew; the agent must be one the machine reports
 *   T2 such a session takes an answer and a close, nothing else: a prompt, a stop, a mode or a resume is refused (409
 *      terminal_hook_session), from the routes and from the store; the answer is queued for the connector as any decision
 *   T3 the owner's switch: on until they turn it off (GET/PUT /v1/remote-agents/approvals); off, the connector is told approvals_off and
 *      nothing is opened; on again, it opens; another user's switch is theirs
 *   T4 a request is put to the user once, with its options as buttons, saying the machine, the agent, the conversation and its folder;
 *      the item waits on them; answered at the terminal the item is done (answered in the terminal) and nothing more is said; the next
 *      request reopens it and is said again; a card answered at the terminal, or still waiting when the conversation ends, is said
 *      as resolved so the channel marks it; one asked and answered in one batch is never put to the user; a closed session closes it
 *   T5 one conversation asking many times in a minute: the first five are put one by one, then one message says how many wait, once
 *   T6 new terminal sessions are limited per minute on their own
 *   T7 a terminal's request goes whole on its card (kind, input, which question): one too large keeps only the options that refuse,
 *      and one with nothing left to choose is said in words, to the terminal
 *   T8 turned off, an open session puts nothing more to the user
 *   T9 how the terminal asks too, as the request's `terminal_asks` says, in each language: Claude Code (absent) alongside the card,
 *      the first answer counting; Cursor (`after_card`) only after the card, which offers to decline or hand it back; Codex
 *      (`on_input`) once someone types there; the field goes on with the card, and a value no channel knows is read as absent
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
type Recorded = Record<string, any>;

describe("approvals from terminals", { skip }, () => {
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
      claw_remote_audit, claw_remote_approval_settings, claw_work_items, claw_work_item_events, claw_tasks, claw_assistants, claw_sessions,
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
  const CURSOR = { agent_id: "cursor", kind: "cursor", name: "Cursor", capabilities: { roots: ["/home/u"] } };
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
  const resolved = (actionId: string, by: string, optionId: string | null = null): [string, Recorded] => ["permission_resolved", { actionId, optionId, by }];
  const remoteItem = async (sid: string) => (await w.q("SELECT * FROM claw_work_items WHERE worker_session_id = $1", [`remote:${sid}`]))[0];
  /** What was pushed of the session of `itemId` (filed under the item or not), oldest first. */
  const pushed = async (itemId: string) => (await w.q(
    `SELECT o.payload FROM claw_notification_outbox o
      WHERE o.payload->'remote'->>'session_id' = (SELECT params->>'session_id' FROM claw_work_items WHERE item_id = $1) ORDER BY o.id`, [itemId],
  )).map((r: Recorded) => r.payload as Recorded);
  /** How many messages are filed under the item (the one per wait that told the user of it). */
  const filed = async (itemId: string) => (await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_says WHERE item_id = $1", [itemId]))[0].n;

  test("T1 one session per terminal conversation, never one of the user's sessions", async () => {
    const cid = await machine("alice", "laptop");
    const other = await machine("alice", "desktop");
    const a = await open("alice", cid, "conv-1");
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.data.created, true);
    const again = await open("alice", cid, "conv-1", { title: "renamed" });
    assert.deepEqual([again.status, again.body.data], [200, { session_id: a.body.data.session_id, created: false }]);
    assert.notEqual((await open("alice", cid, "conv-2")).body.data.session_id, a.body.data.session_id);
    assert.notEqual((await open("alice", other, "conv-1")).body.data.session_id, a.body.data.session_id);
    assert.equal((await open("alice", cid, "conv-3", { agent_id: "codex" })).status, 404);
    assert.equal((await open("alice", cid, "bad ref")).status, 400);
    assert.equal((await open("bob", cid, "conv-1")).status, 404, "another user's machine is not found");
    // Nothing queued for the connector: it opened the session itself.
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_remote_commands")).at(0).n, 0);
    const row = (await w.q("SELECT origin, ref, status FROM claw_remote_sessions WHERE session_id = $1", [a.body.data.session_id]))[0];
    assert.deepEqual(row, { origin: "terminal_hook", ref: "conv-1", status: "active" });

    // The user may open one session (the limit here); three terminal sessions neither count nor are closed to make room.
    const mine = await post("alice", "/v1/remote-agents/sessions", { connector_id: cid, agent_id: "claude", cwd: "/home/u/repo" });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    assert.equal(mine.body.reclaimed, undefined);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_remote_sessions WHERE status = 'active'"))[0].n, 4);
    // Not one the assistant lists, attaches to, or sends work to.
    const listed = (await store.sessionActivity("alice", 10)).map((s) => s.session_id);
    assert.deepEqual(listed, [mine.body.data.session_id]);
    const all = (await call("alice", "GET", "/v1/remote-agents/sessions")).body.data as Recorded[];
    assert.equal(all.find((s) => s.session_id === a.body.data.session_id)?.origin, "terminal_hook", "the list says what it is");
    void tools;

    // Closed, the next request of that conversation opens a new one.
    assert.equal((await post("alice", `/v1/remote-agents/sessions/${a.body.data.session_id}/commands`, { type: "close" })).status, 202);
    const fresh = await open("alice", cid, "conv-1");
    assert.deepEqual([fresh.status, fresh.body.data.created], [201, true]);
    assert.notEqual(fresh.body.data.session_id, a.body.data.session_id);
  });

  test("T2 a terminal session takes an answer and a close, nothing else", async () => {
    await w.user("alice");
    const cid = await machine("alice", "laptop");
    const sid = (await open("alice", cid, "conv-1")).body.data.session_id as string;
    await events("alice", cid, sid, [started, ask("act-1")]);
    for (const body of [{ type: "prompt", text: "hi" }, { type: "cancel" }, { type: "set_mode", mode_id: "default" }, { type: "resume" }, { type: "withdraw" }]) {
      const r = await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, body);
      assert.deepEqual([r.status, r.body.error], [409, "terminal_hook_session"], body.type);
    }
    // The store refuses it too, whoever asks (the assistant's own paths call it directly).
    const direct = await store.issueCommand({
      owner: "alice", client: "assistant", connectorId: cid, agentId: "claude", sessionId: sid, type: "prompt", cmdId: "x1",
      payload: { text: "hi" }, auditDetail: {}, closesSession: false, commandsPerMinute: 60,
    });
    assert.equal(direct.status, "terminal_hook_session");
    const d = await post("alice", `/v1/remote-agents/sessions/${sid}/decisions`, { action_id: "act-1", option_id: "o1" });
    assert.equal(d.status, 202, JSON.stringify(d.body));
    const cmds = await w.q("SELECT type, payload FROM claw_remote_commands WHERE session_id = $1", [sid]);
    assert.deepEqual(cmds.map((c: Recorded) => [c.type, c.payload.action_id, c.payload.option_id]), [["decision", "act-1", "o1"]]);
    assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/decisions`, { action_id: "act-1", option_id: "nope" })).status, 400);
    assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "close" })).status, 202);
  });

  test("T3 the owner's switch: on until turned off", async () => {
    const cid = await machine("alice", "laptop");
    assert.deepEqual((await call("alice", "GET", "/v1/remote-agents/approvals")).body.data, { enabled: true });
    assert.equal((await call("alice", "PUT", "/v1/remote-agents/approvals", { enabled: "no" })).status, 400);
    assert.deepEqual((await call("alice", "PUT", "/v1/remote-agents/approvals", { enabled: false })).body.data, { enabled: false });
    assert.deepEqual((await call("alice", "GET", "/v1/remote-agents/approvals")).body.data, { enabled: false });
    assert.deepEqual((await call("bob", "GET", "/v1/remote-agents/approvals")).body.data, { enabled: true }, "another user's switch is theirs");
    const off = await open("alice", cid, "conv-1");
    assert.deepEqual([off.status, off.body.error], [409, "approvals_off"]);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_remote_sessions"))[0].n, 0);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_remote_audit WHERE action = 'approvals.set'"))[0].n, 1);
    await call("alice", "PUT", "/v1/remote-agents/approvals", { enabled: true });
    assert.equal((await open("alice", cid, "conv-1")).status, 201);
  });

  test("T4 a request is put to the user once; answered at the terminal it is done and nothing more is said", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const sid = (await open("alice", cid, "conv-1")).body.data.session_id as string;
    await events("alice", cid, sid, [started]);
    assert.equal(await remoteItem(sid), undefined, "no item until it asks");
    await events("alice", cid, sid, [ask("act-1")]);
    await events("alice", cid, sid, [["permissionRequest", { ...ask("act-1")[1], resent: true }]]);
    const item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.params.origin, item.title], ["needs_you", "terminal", "laptop claude：修 CI"]);
    let got = await pushed(item.item_id);
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.equal(got[0].text, "laptop 上终端里的 claude（修 CI，work/claw）在等你回答：Which color?。在下面选，或直接在终端里回答，先答的算数。");
    assert.deepEqual([got[0].remote.kind, got[0].remote.session_id, got[0].remote.ask.action_id], ["needs_you", sid, "act-1"]);
    assert.deepEqual(got[0].remote.ask.options, OPTIONS);
    assert.deepEqual([got[0].remote.ask.title, got[0].remote.ask.cwd], ["修 CI", "/home/u/work/claw"], "where it asks, for the card");

    // Answered at the terminal after its card went out: the card is marked (kind resolved, one line for a channel that cannot).
    await events("alice", cid, sid, [resolved("act-1", "terminal")]);
    const done = await remoteItem(sid);
    assert.deepEqual([done.board_state, done.outcome, done.summary], ["done", "answered", "已在终端里回答"]);
    got = await pushed(item.item_id);
    assert.equal(got.length, 2, JSON.stringify(got));
    assert.deepEqual([got[1].remote.kind, got[1].remote.resolved, got[1].remote.ask], ["resolved", { action_id: "act-1", by: "terminal" }, undefined]);
    assert.equal(got[1].text, "（这个请求已在终端里回答）");

    await events("alice", cid, sid, [ask("act-2", "Run: make test")]);
    assert.equal((await remoteItem(sid)).board_state, "needs_you");
    got = await pushed(item.item_id);
    assert.equal(got.length, 3);
    assert.match(got[2].text, /在等你回答：Run: make test/);
    // Answered on the phone: the channel knows; nothing is said.
    await events("alice", cid, sid, [resolved("act-2", "phone", "o0")]);
    assert.equal((await remoteItem(sid)).summary, "已回答");
    assert.equal((await pushed(item.item_id)).length, 3);
    // Asked and answered at the terminal before Claw put it to anyone (one batch): never put to the user.
    await events("alice", cid, sid, [ask("act-3"), resolved("act-3", "terminal")]);
    assert.equal((await pushed(item.item_id)).length, 3);
    assert.equal((await remoteItem(sid)).board_state, "done");
    // A card still waiting when the conversation ends is marked as no longer waiting.
    await events("alice", cid, sid, [ask("act-4")]);
    await events("alice", cid, sid, [["session_closed", { reason: "terminal_ended" }]]);
    const closed = await remoteItem(sid);
    assert.deepEqual([closed.board_state, closed.outcome], ["done", "dropped"]);
    got = await pushed(item.item_id);
    assert.equal(got.length, 5, JSON.stringify(got.map((g) => g.text)));
    assert.deepEqual([got[4].remote.kind, got[4].remote.resolved], ["resolved", { action_id: "act-4", by: "session_end" }]);
  });

  test("T7 a terminal's request goes whole: its kind, what it would do, and which question of several it is", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const sid = (await open("alice", cid, "conv-1")).body.data.session_id as string;
    const plan = "## Plan\n" + "1. step\n".repeat(400);
    const options = [
      { optionId: "plan-approve", name: "Approve", kind: "allow_once" }, { optionId: "plan-reject", name: "Keep planning", kind: "reject_once" },
    ];
    await events("alice", cid, sid, [started,
      ["permissionRequest", { ...ask("act-1", "Plan: refactor auth")[1], kind: "switch_mode", input: { plan }, options, cwd: undefined }],
      ["permissionRequest", { ...ask("act-2", "Which color?")[1], question_index: 1, question_count: 2, cwd: "/home/u/other\u0007dir" }],
      ["permissionRequest", { ...ask("act-3", "Plan: huge")[1], kind: "switch_mode", input: { plan: "x".repeat(20_000) }, options }],
      ["permissionRequest", { ...ask("act-4", "Write big.txt")[1], kind: "edit", input: { content: "y".repeat(20_000) }, options: [OPTIONS[0]] }],
    ]);
    const got = await pushed((await remoteItem(sid)).item_id);
    assert.equal(got.length, 4, JSON.stringify(got.map((g) => g.text)));
    assert.equal(await filed((await remoteItem(sid)).item_id), 1, "one message is filed as the one that told of the wait");
    const [a1, a2, a3, a4] = got.map((g) => g.remote);
    assert.equal(a2.ask.cwd, "/home/u/other dir");
    assert.deepEqual([a1.ask.origin, a1.ask.kind, a1.ask.input.plan], ["terminal", "switch_mode", plan], "the whole plan, not cut");
    assert.deepEqual(a1.ask.options, options);
    assert.deepEqual([a2.ask.question_index, a2.ask.question_count, a2.ask.kind], [1, 2, "question"]);
    // A request that names no folder takes the session's; control characters never reach the card.
    assert.deepEqual([a1.ask.title, a1.ask.cwd], ["修 CI", "/home/u/work/claw"]);
    // Too large to carry whole: only the options that refuse, and no input.
    assert.deepEqual([a3.ask.input, a3.ask.options.map((o: Recorded) => o.optionId)], [undefined, ["plan-reject"]]);
    // Nothing left that may be chosen: said in words, to the terminal.
    assert.equal(a4.ask, undefined);
    assert.match(got[3].text, /Write big\.txt。这个请求没法在这里完整显示，请到终端里回答。$/);
  });

  test("T9 what the terminal does meanwhile is said per agent, in the user's language, and goes on with the card", async () => {
    const cases: Array<{ agent: string; asks?: string; zh: string; en: string; zhCut: string; enCut: string }> = [
      {
        agent: "claude",
        zh: "在下面选，或直接在终端里回答，先答的算数。",
        en: "Choose below, or answer in the terminal; whichever comes first counts.",
        zhCut: "这个请求没法在这里完整显示，请到终端里回答。",
        enCut: "It cannot be shown here in full: answer it in the terminal.",
      },
      {
        agent: "cursor", asks: "after_card",
        zh: "可以在下面拒绝，或交回终端：终端要等这里答完（或等待时间到了）才会问，批准请在终端里。",
        en: "Decline it below, or hand it back to the terminal: the terminal asks only after that (or once this wait is over), and you approve it there.",
        zhCut: "这个请求没法在这里完整显示：终端等手机的时间一过就会问你，请到终端里回答。",
        enCut: "It cannot be shown here in full: the terminal asks once its wait for the phone is over; answer it there.",
      },
      {
        agent: "codex", asks: "on_input",
        zh: "在下面选；想改在终端里回答，就在终端里随便输入点什么，问题就回到终端。",
        en: "Choose below; to answer in the terminal instead, type anything there, and the question goes back to it.",
        zhCut: "这个请求没法在这里完整显示：在终端里随便输入点什么，它就会在终端里问你。",
        enCut: "It cannot be shown here in full: type anything in the terminal, and it asks you there.",
      },
    ];
    const DECLINE = [
      { optionId: "deny", name: "No", kind: "reject_once" }, { optionId: "terminal", name: "Ask me at the terminal", kind: "allow_once" },
    ];
    for (const [owner, title, zh] of [["alice", "修 CI", true], ["bob", "fix CI", false]] as const) {
      const user = await w.user(owner);
      await w.subscribe(user.userId);
      const cid = await machine(owner, "laptop", [CLAUDE, CURSOR, CODEX]);
      for (const c of cases) {
        const ref = `${c.agent}-conv`;
        const sid = (await open(owner, cid, ref, { agent_id: c.agent, title })).body.data.session_id as string;
        const asks = c.asks ? { terminal_asks: c.asks } : {};
        await events(owner, cid, sid, [
          ["session_started", { origin: "terminal_hook", ref, title, agent: c.agent, cwd: "/home/u/work/claw" }],
          ["permissionRequest", { ...ask("act-1", "Run: make test")[1], kind: "execute", input: { command: "make test" }, options: DECLINE, ...asks }],
          // Nothing left that may be chosen: said in words, to the terminal.
          ["permissionRequest", { ...ask("act-2", "Run: big")[1], kind: "execute", input: { command: "y".repeat(20_000) }, options: [DECLINE[1]], ...asks }],
        ]);
        const got = await pushed((await remoteItem(sid)).item_id);
        assert.equal(got.length, 2, JSON.stringify(got.map((g) => g.text)));
        const where = zh ? `laptop 上终端里的 ${c.agent}（${title}，work/claw）在等你回答：` : `${c.agent} in a terminal on laptop (${title}, work/claw) is waiting for you: `;
        const stop = zh ? "。" : ". ";
        assert.equal(got[0].text, `${where}Run: make test${stop}${zh ? c.zh : c.en}`, `${c.agent} ${owner}`);
        assert.equal(got[1].text, `${where}Run: big${stop}${zh ? c.zhCut : c.enCut}`, `${c.agent} ${owner} cut`);
        assert.equal(got[0].remote.ask.terminal_asks, c.asks, "the card is told how the terminal asks too");
        assert.equal(got[1].remote.ask, undefined);
      }
    }
    // A value no channel knows is read as absent: said, and carried, as Claude Code's.
    const carol = await w.user("carol");
    await w.subscribe(carol.userId);
    const cid = await machine("carol", "box");
    const sid = (await open("carol", cid, "conv-x")).body.data.session_id as string;
    await events("carol", cid, sid, [started, ["permissionRequest", { ...ask("act-1")[1], terminal_asks: "whenever" }]]);
    const [got] = await pushed((await remoteItem(sid)).item_id);
    assert.match(got.text, /先答的算数。$/);
    assert.equal("terminal_asks" in got.remote.ask, false);
  });

  test("T8 with the approvals turned off, an open session puts nothing more to the user", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const sid = (await open("alice", cid, "conv-1")).body.data.session_id as string;
    await events("alice", cid, sid, [started, ask("act-1")]);
    const itemId = (await remoteItem(sid)).item_id;
    assert.equal((await pushed(itemId)).length, 1);
    await call("alice", "PUT", "/v1/remote-agents/approvals", { enabled: false });
    await events("alice", cid, sid, [ask("act-2")]);
    assert.equal((await pushed(itemId)).length, 1);
    assert.equal((await remoteItem(sid)).board_state, "needs_you", "still on the list");
  });

  test("T5 many requests of one conversation in a minute: five one by one, then one message says how many wait", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const sid = (await open("alice", cid, "conv-1")).body.data.session_id as string;
    await events("alice", cid, sid, [started]);
    for (let i = 1; i <= 8; i++) await events("alice", cid, sid, [ask(`act-${i}`, `Run: step ${i}`)]);
    const got = await pushed((await remoteItem(sid)).item_id);
    assert.equal(got.length, 6, JSON.stringify(got.map((g) => g.text)));
    assert.deepEqual(got.slice(0, 5).map((g) => g.remote.ask?.action_id), ["act-1", "act-2", "act-3", "act-4", "act-5"]);
    assert.equal(got[5].remote.ask, undefined);
    assert.match(got[5].text, /一分钟内问了很多次，现在有 6 个在等你/);
  });

  test("T6 new terminal sessions are limited per minute on their own", async () => {
    const cid = await machine("alice", "laptop");
    const o = { agent_id: "claude", cwd: "/home/u", title: "" };
    assert.equal((await store.openTerminalSession("alice", cid, { ...o, ref: "c1" }, 2)).status, "opened");
    assert.equal((await store.openTerminalSession("alice", cid, { ...o, ref: "c2" }, 2)).status, "opened");
    assert.equal((await store.openTerminalSession("alice", cid, { ...o, ref: "c1" }, 2)).status, "opened", "an open one is found, not counted");
    assert.equal((await store.openTerminalSession("alice", cid, { ...o, ref: "c3" }, 2)).status, "rate_limited");
  });
});
