// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Work on the user's development environments as work items (`assistant/remote-items.ts`) and `devenv_send`
 * (`assistant/devenv-tools.ts`): the remote-agents routes over real HTTP, the assistant on a real Postgres with the production schema.
 * Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   F1  a prompt typed into a chat attached to a session (`POST .../commands`) opens a development environment item, in progress, titled
 *       with the machine, the agent and the instruction; the connector's turn_end closes it as finished with the end of the agent's answer;
 *       the router's item list says so; nobody is told (the chat showed it), not even by the silent sweep; the next prompt reopens the
 *       same item; history the session had before its first prompt is not applied; another user's chat never touches it
 *   F2  devenv_send in a turn answering the user's own signed-in message sends it at once: a new session on their one online machine
 *       with that agent, the prompt queued after it, an item the user is told the end of (once), and a permission the agent waits on
 *       put in front of them (once); the turn has read the machine's name afterwards; a replayed call sends nothing twice; an idle session
 *       of that agent continues, a busy one is not sent another
 *   F3  a turn that has read devenv_list, or a message sent with a key, only puts it to the user as a card: nothing is queued until the
 *       person lets it through (decideConfirmation allow), which sends it then; deny sends nothing; a report's turn cannot do either
 *   F4  only the user's own machines: a machine of someone else's is never chosen, even named; two machines with that agent is a
 *       question (which_machine, with the choices, and the turn has read them); an offline one is connector_offline
 *   F5  work_send refuses a development environment item (devenv_send sends to it); work_stop closes it and cancels the agent's turn;
 *       work_recall's worker_tail is the agent's answer
 *   F6  the router's prompt sends instructions with devenv_send and follows development environment items
 *   F7  every prompt sent ends, though not every one gets a turn_end: a cancel (one turn_end, its queued prompts dropped) closes the
 *       item; a prompt the connector refused before queueing it is one fewer; one refused at its start (refusal and turn_end) is one
 *   F8  the item's stop button (`POST /v1/work-items/:id/stop`) cancels the agent's turn on the machine, as work_stop does
 *   F9  what the session posts after a prompt is queued is that prompt's, even when it reaches Claw before the prompt's item is
 *       written: a first prompt's item, and a finished item reopened, both end with it; but the turn before it, ending as it was
 *       queued, never ends it
 *   F10 stop, then a new instruction at once: the end the cancel brings ends what was sent before it, never the new one, whether
 *       the stop was the item's button or the attached chat's; a prompt and a stop are queued and noted one at a time per session;
 *       a turn's end stored but not yet applied when the item was stopped is the old turn's, not the next instruction's
 *   F13 a turn that finished on its own as the stop was on its way: its end is the old turn's, whether the cancel then brings an end
 *       of its own or none
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type Claims, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
type Recorded = Record<string, any>;

describe("development environment items and devenv_send", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";
  let store: typeof import("../src/remote-agents/store.js");
  let tools: typeof import("../src/assistant/devenv-tools.js");
  let items: typeof import("../src/assistant/remote-items.js");
  let role: typeof import("../src/assistant/role-profile.js");
  let prompts: typeof import("../src/assistant/prompts.js");
  let schedules: typeof import("../src/assistant/schedules.js");
  let inbound: typeof import("../src/assistant/inbound.js");

  before(async () => {
    w = await startWorld({
      CLAW_REMOTE_AGENTS_ENABLED: "true", CLAW_ASSISTANT_TOOLS: "on", CLAW_ASSISTANT_ATTENDED_TTL_SEC: "600",
      CLAW_TRIGGERS_ENABLED: "true", CLAW_TRIGGER_TOOLS_ENABLED: "true", CLAW_TRIGGER_TOOLS_TOKEN_KEY: "trigger-tools-test-key-0123456789abcdef",
    });
    store = await import("../src/remote-agents/store.js");
    tools = await import("../src/assistant/devenv-tools.js");
    items = await import("../src/assistant/remote-items.js");
    role = await import("../src/assistant/role-profile.js");
    prompts = await import("../src/assistant/prompts.js");
    schedules = await import("../src/assistant/schedules.js");
    inbound = await import("../src/assistant/inbound.js");
    const { registerRemoteAgentRoutes } = await import("../src/routes/remote-agents.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") return;
      (req as any).user = { userId: id, userName: id, platformKey: "", virtualKey: "", roles: ["default"] };
      (req as any).authMethod = "identity_token";
    });
    await registerRemoteAgentRoutes(app, { pingMs: 150, pollMs: 40, retentionDays: 0 });
    const { registerAssistantRoutes } = await import("../src/routes/assistant.js");
    await registerAssistantRoutes(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_remote_events, claw_remote_commands, claw_remote_sessions, claw_remote_agents, claw_remote_connectors,
      claw_remote_audit, claw_work_items, claw_work_item_events, claw_tasks, claw_assistants, claw_sessions, claw_assistant_messages,
      claw_assistant_says, claw_assistant_confirmations, claw_notification_outbox, claw_notification_subscriptions CASCADE`);
  });

  async function post(user: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(base + path, { method: "POST", headers: { "x-test-user": user, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  const CLAUDE = { agent_id: "claude", kind: "claude", name: "Claude Code", capabilities: { roots: ["/home/u/repo"] } };
  async function machine(owner: string, name: string, opts: { online?: boolean; agents?: Recorded[] } = {}): Promise<string> {
    const row = await store.registerConnector(owner, name, "0.1.3", null, 10);
    assert.ok(row);
    await store.recordHeartbeat(row.connector_id, owner, { version: "0.1.3", cmdCursor: null, agents: (opts.agents ?? [CLAUDE]) as never });
    await w.q(
      opts.online === false
        ? "UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '1 hour' WHERE connector_id = $1"
        : "UPDATE claw_remote_connectors SET heartbeat_at = NOW(), stream_seen_at = NOW() WHERE connector_id = $1",
      [row.connector_id],
    );
    return String(row.connector_id);
  }
  /** A session the user opened through their chat, its session.new already collected by the connector. */
  async function chatSession(owner: string, cid: string, cwd = "/home/u/repo"): Promise<string> {
    const r = await post(owner, "/v1/remote-agents/sessions", { connector_id: cid, agent_id: "claude", cwd });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await w.q("DELETE FROM claw_remote_commands WHERE session_id = $1", [r.body.data.session_id]);
    return r.body.data.session_id;
  }
  const seqs = new Map<string, number>();
  /** The connector posts these events of a session, as its outbox does. */
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
  const chunk = (text: string, extra: Recorded = {}): [string, Recorded] =>
    ["agent_message_chunk", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, ...extra }];
  const end = (stopReason = "end_turn"): [string, Recorded] => ["turn_end", { stopReason }];
  const ask = (actionId: string, tool: string): [string, Recorded] => ["permissionRequest", { actionId, tool, kind: "execute", options: [{ optionId: "allow" }] }];
  const remoteItem = async (sid: string) => (await w.q("SELECT * FROM claw_work_items WHERE worker_session_id = $1", [`remote:${sid}`]))[0];
  const says = async (userId: string) => w.q("SELECT text, item_id, fallback FROM claw_assistant_says WHERE user_id = $1 ORDER BY created_at", [userId]);
  const queued = async (cid: string) => w.q("SELECT type, session_id::text AS session_id, payload FROM claw_remote_commands WHERE connector_id = $1 ORDER BY cmd_seq", [cid]);
  const manifestLine = async (userId: string, itemId: string) => {
    const line = (await role.routerManifest(userId)).find((m) => m.itemId === itemId);
    assert.ok(line, "the item is on the router's list");
    return prompts.formatManifestLine(line);
  };

  /** A live router turn answering a message the user sent: signed in (a person), or with a key (`attended: false`). */
  async function userTurn(u: { routerSid: string; userId: string }, content: string, attended = true): Promise<Claims> {
    const turn = await w.routerTurn(u);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context, received_at)
       VALUES ($1, $2, $3, 'Alice A', $4, $5::jsonb, $6::jsonb, NOW())`,
      [u.routerSid, turn.mid, u.userId, content, attended ? JSON.stringify({ kind: "person" }) : null,
        JSON.stringify(inbound.parseChannelContext({ channel: "teams", channel_message_id: `m-${turn.mid}` }))],
    );
    return turn;
  }
  const untrusted = async (turn: Claims) =>
    !!(await w.q("SELECT untrusted_read_at FROM claw_assistant_messages WHERE message_id = $1", [turn.mid]))[0].untrusted_read_at;

  test("F1 a prompt typed into an attached chat is an item the router can name, closed by the agent's turn end, told to nobody", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const sid = await chatSession("alice", cid);
    // What the session had before its first prompt (a conversation taken over replays it, and may end a turn) is not the item's.
    await events("alice", cid, sid, [chunk("old answer"), end()]);
    assert.equal(await remoteItem(sid), undefined, "no item before anything was asked");

    const sent = await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "列一下当前目录" });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    let item = await remoteItem(sid);
    assert.ok(item, "the prompt opened an item");
    assert.deepEqual([item.kind, item.board_state, item.title, item.user_id], ["remote", "in_progress", "laptop claude：列一下当前目录", "alice"]);
    assert.equal(item.params.origin, "chat");
    assert.match(await manifestLine("alice", item.item_id), /in progress: the agent on that machine is working on it.*development environment item.*machine: "laptop"/);

    await events("alice", cid, sid, [["tool_call", { update: { sessionUpdate: "tool_call", title: "ls" } }], chunk("Makefile  README.md  "), chunk("docs/  src/"), end()]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.outcome, item.last_report_kind], ["done", "answered", "answer"]);
    assert.equal(item.summary, "Makefile README.md docs/ src/");
    const line = await manifestLine("alice", item.item_id);
    assert.match(line, /finished: the agent's turn on that machine ended/);
    assert.match(line, /summary: "Makefile README.md docs\/ src\/"/);
    const evs = await w.itemEvents(item.item_id);
    assert.deepEqual(evs.map((e: Recorded) => [e.kind, e.source]), [["created", "remote"], ["progress", "remote"], ["answer", "remote"]]);
    assert.equal(evs[1].summary, "列一下当前目录");
    // The user watched it in their chat: nothing is said, and the silent sweep says nothing either.
    assert.deepEqual(await says("alice"), []);
    assert.equal(await w.mod.silent.tellSilentItems(0), 0);
    // The same events posted again (a connector retry) change nothing.
    await events("alice", cid, sid, [end()]);
    assert.equal((await remoteItem(sid)).board_state, "done");

    // The next prompt reopens the same item, under the same number.
    await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "run make test" });
    const again = await remoteItem(sid);
    assert.deepEqual([again.item_id, again.seq, again.board_state, again.title, again.outcome], [item.item_id, item.seq, "in_progress", "laptop claude: run make test", null]);
    // Stored without being applied (as if the item's write had failed), then the connector's retry of that same batch applies them.
    const n = seqs.get(sid) ?? 0;
    const batch = [chunk("312 passed"), end()].map(([type, data], i) => ({ index: i, session_id: sid, seq: n + 1 + i, type, ts: Date.now(), data }));
    seqs.set(sid, n + 2);
    await store.ingestEvents({ connector_id: cid, owner_user_id: "alice" }, batch as never);
    assert.equal((await remoteItem(sid)).board_state, "in_progress");
    const retried = await post("alice", `/v1/remote-agents/connectors/${cid}/events`, { batch_id: "retry", events: batch.map(({ index: _i, ...e }) => e) });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).summary], ["done", "312 passed"]);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_work_items WHERE user_id = 'alice'"))[0].n, 1, "one item per session");

    // Bob, without an assistant, types into his own chat: nothing of his is filed anywhere, and alice's item is untouched.
    const bobBox = await machine("bob", "bob-box");
    const bobSid = await chatSession("bob", bobBox);
    assert.equal((await post("bob", `/v1/remote-agents/sessions/${bobSid}/commands`, { type: "prompt", text: "x" })).status, 202);
    assert.equal(await remoteItem(bobSid), undefined);
    assert.equal((await post("bob", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "x" })).status, 404);
    assert.equal((await remoteItem(sid)).title, "laptop claude: run make test");
  });

  test("F2 devenv_send in the user's own signed-in turn sends it, files the item, and tells them its end once", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const turn = await userTurn(alice, "让开发机上的 claude 跑 make test");
    const out = await tools.devenvSend(turn, { text: "跑 make test", agent: "claude" });
    assert.equal(out.sent, true, JSON.stringify(out));
    assert.deepEqual([out.machine, out.agent, out.new_session], ["laptop", "claude", true]);
    assert.equal(await untrusted(turn), true, "the turn has read the machine's name");
    const cmds = await queued(cid);
    assert.deepEqual(cmds.map((c: Recorded) => c.type), ["session.new", "prompt"]);
    assert.equal(cmds[0].payload.cwd, "/home/u/repo", "a new session in the agent's root");
    assert.equal(cmds[1].payload.text, "跑 make test");
    const sid = String(out.session_id);
    let item = await remoteItem(sid);
    assert.deepEqual([item.item_id, item.seq, item.board_state, item.params.origin, item.params.lang], [out.item_id, out.seq, "in_progress", "assistant", "zh"]);

    // A replayed call (the same words in the same turn) sends nothing again.
    const again = await tools.devenvSend(turn, { text: "跑 make test", agent: "claude" });
    assert.deepEqual([again.sent, again.duplicate, again.item_id, again.session_id], [true, true, out.item_id, out.session_id]);
    assert.equal((await queued(cid)).length, 2);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_confirmations"))[0].n, 0, "and no card for it");

    // It waits for an approval: the user is told once, the item needs them; answered, it goes on.
    await events("alice", cid, sid, [ask("act-1", "Run make test")]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.pending_question], ["needs_you", "等你批准：Run make test"]);
    await events("alice", cid, sid, [["permission_resolved", { actionId: "act-1", optionId: "allow" }], chunk("All 312 tests passed,\n0 failed.")]);
    assert.equal((await remoteItem(sid)).board_state, "in_progress");
    await events("alice", cid, sid, [end()]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.outcome, item.summary], ["done", "answered", "All 312 tests passed, 0 failed."]);
    const told = await says("alice");
    assert.equal(told.length, 2, JSON.stringify(told));
    assert.match(told[0].text, /^laptop 上的 claude 在等你批准：Run make test（#\d+ 跑 make test）。发 \/agent attach /);
    // The summary is one line; the message keeps the answer's line breaks.
    assert.match(told[1].text, /^laptop 上的 claude 做完了 #\d+：跑 make test\nAll 312 tests passed,\n0 failed\.$/);
    assert.ok(told.every((s: Recorded) => s.item_id === item.item_id && s.fallback));
    await events("alice", cid, sid, [end()]);
    assert.equal((await says("alice")).length, 2, "said once");
    assert.equal(await w.mod.silent.tellSilentItems(0), 0);

    // The connector acknowledged what it collected (a heartbeat's cursor). An idle session of that agent continues; nothing new is opened.
    await store.pruneCommands((t, p) => w.h.app.db.db.query(t, p), cid, 1_000_000);
    const next = await tools.devenvSend(await userTurn(alice, "再跑一次"), { text: "再跑一次" });
    assert.deepEqual([next.sent, next.session_id, next.new_session, next.seq], [true, sid, false, item.seq]);
    assert.deepEqual((await queued(cid)).map((c: Recorded) => c.type), ["prompt"]);
    // While it works, it is not sent another: a new session is.
    const third = await tools.devenvSend(await userTurn(alice, "跑 lint"), { text: "跑 lint" });
    assert.equal(third.new_session, true);
    assert.notEqual(third.session_id, sid);
    // Named as a session that is working: refused, nothing sent.
    const busy = await tools.devenvSend(await userTurn(alice, "让它也跑 lint"), { text: "跑 lint", target: sid }).catch((e) => e);
    assert.equal((busy as Recorded).code, "busy");
    assert.equal((await queued(cid)).filter((c: Recorded) => c.type === "prompt").length, 2);
  });

  test("F3 after reading a machine's report, or from a key, only a card: sent when the person lets it through", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");

    const turn = await userTurn(alice, "让开发机上的 claude 跑 make test");
    await tools.devenvList(turn, {});
    const out = await tools.devenvSend(turn, { text: "跑 make test", agent: "claude" });
    assert.equal(out.sent, undefined);
    assert.equal(out.done, false, JSON.stringify(out));
    assert.equal(out.why_card, "read_untrusted");
    assert.deepEqual(await queued(cid), [], "nothing is sent before the person answers");
    const card = (await w.q("SELECT * FROM claw_assistant_confirmations WHERE user_id = 'alice'"))[0];
    assert.equal(card.kind, "devenv_send");
    const shown = (await w.q("SELECT payload FROM claw_notification_outbox WHERE payload ? 'confirm_write'"))[0].payload;
    assert.equal(shown.confirm_write.kind, "devenv_send");
    assert.equal(shown.confirm_write.allow_label, "发送");
    assert.match(shown.text, /^要让 laptop 上的 claude 执行这条指令吗？\n跑 make test\n会话：新会话；目录：\/home\/u\/repo\n/);
    assert.match(await schedules.renderScheduleState("alice"), /send to "claude" on the machine "laptop": "跑 make test"/);

    const decided = await schedules.decideConfirmation({ userId: "alice", confirmationId: card.confirmation_id, decision: "allow", via: "button" });
    assert.equal(decided.status, "done", JSON.stringify(decided));
    assert.deepEqual((await queued(cid)).map((c: Recorded) => c.type), ["session.new", "prompt"]);
    const item = await remoteItem(String(decided.result?.session_id));
    assert.deepEqual([item.board_state, item.params.origin], ["in_progress", "assistant"]);
    // Pressed again: answered before, nothing sent twice.
    assert.equal((await schedules.decideConfirmation({ userId: "alice", confirmationId: card.confirmation_id, decision: "allow", via: "button" })).answered_now, false);
    assert.equal((await queued(cid)).length, 2);

    // A message sent with a key: a card too; denied, nothing is sent.
    const keyed = await userTurn(alice, "让开发机上的 claude 跑 lint", false);
    const viaKey = await tools.devenvSend(keyed, { text: "跑 lint" });
    assert.equal(viaKey.why_card, "not_attended");
    const card2 = (await w.q("SELECT * FROM claw_assistant_confirmations WHERE user_id = 'alice' AND status = 'pending'"))[0];
    assert.equal((await schedules.decideConfirmation({ userId: "alice", confirmationId: card2.confirmation_id, decision: "deny", via: "button" })).status, "denied");
    assert.equal((await queued(cid)).length, 2);

    // The agent's own conversation on the machine, taken over: the card says so, with the folder, and pressing it does exactly that.
    await store.recordHeartbeat(cid, "alice", { version: "0.1.3", cmdCursor: null, agents: [{ ...CLAUDE, capabilities: { ...CLAUDE.capabilities,
      resumable: [{ ref: "c0ffee00-0000-4000-8000-0000000000aa", title: "fix the api test", cwd: "/home/u/repo/api", updated_at: Math.floor(Date.now() / 1000), state: "idle" }] } }] as never });
    await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW(), stream_seen_at = NOW() WHERE connector_id = $1", [cid]);
    const resumeTurn = await userTurn(alice, "让 laptop/claude/2 接着修", false);
    const resumed = await tools.devenvSend(resumeTurn, { text: "接着修", target: "c0ffee00-0000-4000-8000-0000000000aa" });
    assert.equal(resumed.done, false);
    const resumeCard = (await w.q("SELECT payload FROM claw_notification_outbox WHERE payload ? 'confirm_write' ORDER BY id DESC LIMIT 1"))[0].payload;
    assert.match(resumeCard.text, /会话：接管它在那台机器上已有的对话 laptop\/claude\/\d+（带着那段对话的上下文）；目录：\/home\/u\/repo\/api\n/);
    const card3 = (await w.q("SELECT * FROM claw_assistant_confirmations WHERE user_id = 'alice' AND status = 'pending'"))[0];
    assert.equal((await schedules.decideConfirmation({ userId: "alice", confirmationId: card3.confirmation_id, decision: "allow", via: "button" })).status, "done");
    const takeOver = (await queued(cid)).filter((c: Recorded) => c.type === "session.new").at(-1);
    assert.deepEqual([takeOver.payload.resume_ref, takeOver.payload.cwd], ["c0ffee00-0000-4000-8000-0000000000aa", "/home/u/repo/api"]);

    // A worker's report starts a turn that answers no message: not even a card.
    const report = await w.routerTurn(alice);
    await assert.rejects(tools.devenvSend(report, { text: "rm -rf build" }), (e: Recorded) => e.code === "not_from_user");
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_confirmations"))[0].n, 3);
  });

  test("F4 only the user's own machines; two that fit is a question; an offline one says so", async () => {
    const alice = await w.user("alice");
    await w.user("bob");
    const bobBox = await machine("bob", "bob-box");
    const laptop = await machine("alice", "laptop");
    // Named as bob's machine: not alice's, so none.
    const named = await tools.devenvSend(await userTurn(alice, "让 bob-box 上的 claude 跑 make"), { text: "make", target: "bob-box" }).catch((e) => e);
    assert.equal((named as Recorded).code, "no_machine");
    assert.deepEqual((named as Recorded).data.choices, ["laptop"]);
    // Named by bob's session id: not found among alice's, and never sent.
    const bobSid = await chatSession("bob", bobBox);
    const bySid = await tools.devenvSend(await userTurn(alice, "x"), { text: "make", target: bobSid }).catch((e) => e);
    assert.equal((bySid as Recorded).code, "no_machine");
    assert.deepEqual(await queued(bobBox), []);

    await machine("alice", "desktop");
    const two = await userTurn(alice, "让 claude 跑 make");
    const which = await tools.devenvSend(two, { text: "make", agent: "claude" }).catch((e) => e);
    assert.equal((which as Recorded).code, "which_machine");
    assert.deepEqual((which as Recorded).data.choices, ["laptop/claude", "desktop/claude"]);
    assert.equal(await untrusted(two), true, "the choices were reported by the machines");
    assert.deepEqual(await queued(laptop), []);
    // Named: the one.
    assert.equal((await tools.devenvSend(await userTurn(alice, "让 laptop 上的 claude 跑 make"), { text: "make", target: "laptop" })).machine, "laptop");

    await w.q("UPDATE claw_remote_connectors SET stream_seen_at = NULL WHERE name = 'desktop'");
    const off = await tools.devenvSend(await userTurn(alice, "让 desktop 上的 claude 跑 make"), { text: "make", target: "desktop" }).catch((e) => e);
    assert.equal((off as Recorded).code, "connector_offline");
    assert.match((off as Recorded).message, /offline/);
  });

  test("F5 work_send refuses a development environment item; work_stop closes it and cancels its turn; worker_tail is the answer", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "laptop");
    const out = await tools.devenvSend(await userTurn(alice, "跑 make test"), { text: "跑 make test" });
    const sid = String(out.session_id);
    await events("alice", cid, sid, [chunk("still running the suite")]);
    const t = w.mod.tools;
    await assert.rejects(t.workSend(await userTurn(alice, "也跑 lint"), { item_id: String(out.item_id), text: "lint" }), (e: Recorded) => e.code === "remote_item");
    const recall = await t.workRecall(await userTurn(alice, "它在干嘛"), { item_id: String(out.item_id), detail: "worker_tail" });
    assert.equal(recall.worker_tail, "still running the suite");
    const stopped = await t.workStop(await userTurn(alice, "停掉"), { item_id: String(out.item_id), reason: "user asked" });
    assert.equal(stopped.outcome, "stopped");
    assert.deepEqual((await queued(cid)).map((c: Recorded) => c.type), ["session.new", "prompt", "cancel"]);
    // The turn's end that the cancel brings changes nothing more.
    await events("alice", cid, sid, [end("cancelled")]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).outcome], ["done", "stopped"]);
  });

  test("F7 a cancel closes the item however many prompts were queued; a refused prompt is one fewer, never two", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "laptop");
    const sid = await chatSession("alice", cid);
    const prompt = async (text: string) => assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text })).status, 202);
    const rejected = (reason: string): [string, Recorded] => ["command_rejected", { type: "prompt", cmd_id: "c", reason }];

    // Two prompts typed, then stop: the connector drops the queued one with no turn_end, and the running one ends cancelled.
    await prompt("first");
    await prompt("second");
    assert.equal((await remoteItem(sid)).params.open_turns, 2);
    await events("alice", cid, sid, [chunk("half done"), end("cancelled")]);
    let item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.outcome, item.params.open_turns], ["done", "answered", 0]);
    assert.match(item.summary, /已取消|cancelled/);

    // Three more: the third is refused as one too many (no turn_end of its own); the two that ran end the item.
    await prompt("a");
    await prompt("b");
    await prompt("c");
    await events("alice", cid, sid, [rejected("too_many_queued_prompts"), end()]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.open_turns], ["in_progress", 1]);
    await events("alice", cid, sid, [chunk("b done"), end()]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).summary], ["done", "b done"]);

    // A prompt refused when its turn starts posts its refusal and a turn_end: that is one prompt, not two.
    await prompt("x");
    await prompt("y");
    await events("alice", cid, sid, [rejected("attach_busy"), end("error")]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.open_turns], ["in_progress", 1]);
    await events("alice", cid, sid, [end()]);
    assert.equal((await remoteItem(sid)).board_state, "done");

    // The only prompt open refused before it was queued: the item ends, dropped, saying why.
    await prompt("z");
    await events("alice", cid, sid, [rejected("too_many_queued_prompts")]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.outcome, item.params.open_turns], ["done", "dropped", 0]);
    assert.match(item.summary, /too_many_queued_prompts/);
  });

  test("F8 the item's stop button cancels the agent's turn on the machine", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "laptop");
    const out = await tools.devenvSend(await userTurn(alice, "跑 make test"), { text: "跑 make test" });
    const sid = String(out.session_id);
    const r = await post("alice", `/v1/work-items/${String(out.item_id)}/stop`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).outcome], ["done", "stopped"]);
    assert.deepEqual((await queued(cid)).map((c: Recorded) => c.type), ["session.new", "prompt", "cancel"]);
  });

  test("F9 a turn that ended before its prompt's item was written still ends the item", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "laptop");
    const sid = await chatSession("alice", cid);
    await events("alice", cid, sid, [chunk("history"), end()]);
    const note = (text: string, since: number) =>
      items.noteRemotePrompt({ owner: "alice", sessionId: sid, connectorId: cid, agentId: "claude", text, origin: "chat", since });

    // The prompt is queued, the connector answers at once, and only then is the item written.
    let since = await items.remoteEventMark(sid);
    await events("alice", cid, sid, [chunk("fast answer"), end()]);
    await note("quick one", since);
    let item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.summary, item.params.open_turns], ["done", "fast answer", 0]);

    // The same for the next prompt, on the item that had ended: it is reopened and ended by what came first.
    since = await items.remoteEventMark(sid);
    await events("alice", cid, sid, [chunk("second answer"), end()]);
    assert.equal((await remoteItem(sid)).summary, "fast answer", "an ended item does not take a turn it was not open for");
    await note("next one", since);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.summary, item.params.open_turns, item.title], ["done", "second answer", 0, "laptop claude: next one"]);

    // A prompt queued just as the turn before it ends: that end closes the item first, and is not taken as the new prompt's end.
    await note("third one", await items.remoteEventMark(sid));
    since = await items.remoteEventMark(sid);
    await events("alice", cid, sid, [chunk("third answer"), end()]);
    assert.equal((await remoteItem(sid)).board_state, "done");
    await note("fourth one", since);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.params.open_turns, item.title], ["in_progress", 1, "laptop claude: fourth one"]);
    await events("alice", cid, sid, [chunk("fourth answer"), end()]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).summary], ["done", "fourth answer"]);
  });

  test("F10 the end a cancel brings never ends an instruction sent after the stop", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "laptop");
    const out = await tools.devenvSend(await userTurn(alice, "跑 make test"), { text: "跑 make test" });
    const sid = String(out.session_id);
    const prompt = async (text: string) => assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text })).status, 202);

    // The item's stop button, then a new instruction typed before the cancelled turn's end reaches Claw.
    assert.equal((await post("alice", `/v1/work-items/${String(out.item_id)}/stop`, {})).status, 200);
    await prompt("run lint instead");
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.open_turns], ["in_progress", 1]);
    await events("alice", cid, sid, [chunk("partial"), end("cancelled")]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.open_turns], ["in_progress", 1], "the cancel's end is not lint's");
    await events("alice", cid, sid, [chunk("lint clean"), end()]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).summary], ["done", "lint clean"]);

    // The attached chat's stop with two open, then one more: the cancel ends the two, the third runs on.
    await prompt("a");
    await prompt("b");
    const cancel = async () => {
      const r = await fetch(`${base}/v1/remote-agents/sessions/${sid}/commands`, {
        method: "POST", headers: { "x-test-user": "alice", "content-type": "application/json", "idempotency-key": "stop-1" }, body: JSON.stringify({ type: "cancel" }),
      });
      return { status: r.status, body: await r.json() as Recorded };
    };
    assert.equal((await cancel()).status, 202);
    await prompt("c");
    // The chat retries the same stop: nothing new is queued, and the prompt sent after the stop still counts.
    assert.equal((await cancel()).body.data.duplicate, true);
    assert.equal((await remoteItem(sid)).params.open_turns, 3);
    await events("alice", cid, sid, [end("cancelled")]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.open_turns], ["in_progress", 1]);
    await events("alice", cid, sid, [chunk("c done"), end()]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).summary], ["done", "c done"]);
  });

  test("F11 a prompt waits while a stop is being queued and noted for the same session, never in between", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "laptop");
    const sid = await chatSession("alice", cid);
    // Another request holds the session's order (as a stop being queued and noted does) until released.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    const holder = items.inRemoteSessionOrder(sid, async () => { held(); await gate; });
    await holding;
    const sent = post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "after the stop" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await remoteItem(sid), undefined, "not noted while the session's order is held");
      assert.deepEqual(await queued(cid), [], "not queued either");
    } finally {
      release();
      await holder;
    }
    assert.equal((await sent).status, 202);
    assert.equal((await remoteItem(sid)).params.open_turns, 1);
  });

  test("F12 an end stored before the stop, applied after it, never ends the instruction sent after the stop", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "laptop");
    const out = await tools.devenvSend(await userTurn(alice, "跑 make test"), { text: "跑 make test" });
    const sid = String(out.session_id);
    // The turn ends on the machine; its events are stored, and their item update has not run yet.
    const n = seqs.get(sid) ?? 0;
    const batch = [chunk("tests done"), end()].map(([type, data], i) => ({ index: i, session_id: sid, seq: n + 1 + i, type, ts: Date.now(), data }));
    seqs.set(sid, n + 2);
    await store.ingestEvents({ connector_id: cid, owner_user_id: "alice" }, batch as never);
    // Stop, then a new instruction at once.
    assert.equal((await post("alice", `/v1/work-items/${String(out.item_id)}/stop`, {})).status, 200);
    assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "now lint" })).status, 202);
    let item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.params.open_turns, item.title], ["in_progress", 1, "laptop claude: now lint"]);
    // The cancel finds nothing running and says so; then the new instruction runs and ends.
    await events("alice", cid, sid, [end("cancelled")]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.open_turns], ["in_progress", 1]);
    await events("alice", cid, sid, [chunk("lint clean"), end()]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.summary], ["done", "lint clean"]);

    // Another instruction, stopped, and the cancel's own end is stored (not yet applied) before the next one: it is passed over with
    // the rest, and the cancel is no longer pending, so it takes nothing from the instructions after it.
    assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "now docs" })).status, 202);
    assert.equal((await post("alice", `/v1/work-items/${String(out.item_id)}/stop`, {})).status, 200);
    assert.equal(typeof (await remoteItem(sid)).params.cancel_after, "number");
    const m = seqs.get(sid) ?? 0;
    seqs.set(sid, m + 1);
    await store.ingestEvents({ connector_id: cid, owner_user_id: "alice" }, [{ index: 0, session_id: sid, seq: m + 1, type: "turn_end", ts: Date.now(), data: { stopReason: "cancelled" } }] as never);
    assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "and format" })).status, 202);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.params.open_turns, item.params.cancel_after ?? null], ["in_progress", 1, null]);
  });

  test("F13 a turn that finished as the stop was on its way never ends the instruction sent after the stop", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "laptop");
    const prompt = async (sid: string, text: string) => assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text })).status, 202);

    // Stop, a new instruction, then the old turn's own end, then the cancel's (it found nothing running), then the new one's.
    const one = await tools.devenvSend(await userTurn(alice, "跑 make test"), { text: "跑 make test" });
    const a = String(one.session_id);
    assert.equal((await post("alice", `/v1/work-items/${String(one.item_id)}/stop`, {})).status, 200);
    await prompt(a, "now lint");
    await events("alice", cid, a, [chunk("tests done"), end()]);
    assert.deepEqual([(await remoteItem(a)).board_state, (await remoteItem(a)).title], ["in_progress", "laptop claude: now lint"], "the old turn's end is not lint's");
    await events("alice", cid, a, [end("cancelled")]);
    assert.equal((await remoteItem(a)).board_state, "in_progress");
    await events("alice", cid, a, [chunk("lint clean"), end()]);
    assert.deepEqual([(await remoteItem(a)).board_state, (await remoteItem(a)).summary], ["done", "lint clean"]);

    // The same, but the turn ended as the cancel reached it and the cancel brought no end of its own.
    const sid = await chatSession("alice", cid);
    await prompt(sid, "first");
    assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "cancel" })).status, 202);
    await prompt(sid, "second");
    await events("alice", cid, sid, [chunk("first done"), end()]);
    assert.equal((await remoteItem(sid)).board_state, "in_progress", "the first turn's end is not the second's");
    await events("alice", cid, sid, [chunk("second done"), end()]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).summary], ["done", "second done"]);

    // A stop with nothing sent after it: the turn that ended on its own ends the item, and the cancel's end changes nothing.
    await prompt(sid, "third");
    assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "cancel" })).status, 202);
    await events("alice", cid, sid, [chunk("third done"), end()]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).summary], ["done", "third done"]);
    await events("alice", cid, sid, [end("cancelled")]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.cancel_after ?? null], ["done", null]);
  });

  test("F6 the router sends instructions with devenv_send and follows development environment items", async () => {
    const section = prompts.renderRouterDevenvSection({ actions: true, send: true });
    assert.match(section, /devenv_send, called directly and first, never after devenv_list/);
    assert.match(section, /刚才那个跑完了吗/);
    assert.match(section, /Never say something did not run when such an item says it finished/);
    assert.doesNotMatch(section, /nothing here sends it/);
    assert.match(prompts.renderRouterDevenvSection({ actions: true }), /nothing here sends it/);
    assert.equal(prompts.ROUTER_DEVENV_PROMPT_VERSION, "router-devenv-v2");
    assert.equal(items.remoteWorkerSessionId("x"), "remote:x");
  });
});
