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
 *   F2  devenv_send in the user's own signed-in turn is a card too, sent when they press it: a new session on their one online machine
 *       with that agent, the prompt queued after it, an item the user is told the end of (once), and a permission the agent waits on
 *       put in front of them (once); the turn has read the machine's name afterwards; a replayed call is the same card, nothing sent
 *       twice; an idle session of that agent continues, a busy one is not sent another
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
 *   F14 nothing is ever sent from the turn itself: whatever the words, in the user's own signed-in turn, it is a card
 *   F15 two stops in a row, each followed by an instruction, before either cancel's end has come: each end is taken in turn, and
 *       only the last instruction is left open
 *   F16 a connector that names the prompt each turn's end ends (`turn_end.cmd_seq`) is followed by name: a turn that finished on its
 *       own as the first of two stops was on its way no longer leaves the last instruction's item open after it ended; an old turn's
 *       end never ends a newer instruction; a cancel's queued prompts, refused by name, end with it; a prompt whose command id is
 *       masked as a credential on the way (a credential-shaped Idempotency-Key) still ends by its number; an end naming no prompt (an
 *       older connector) makes the item count again, as before; a stop whose cancel finds nothing running (the connector restarted
 *       mid-turn, and that turn's end never comes) ends every instruction sent before it
 *   F17 a machine revoked while a card that would send to it waits: the card closes (expired, `connector_revoked`), the router's
 *       pending cards no longer name it, a press afterwards sends nothing; another machine's card, and another user's revoke, are untouched;
 *       a card proposed while the machine is being revoked is refused (no_machine), never left waiting; a revoke never waits for a card
 *       that is being pressed (the press holds the card while its send waits for the machine: a cycle Postgres cannot see)
 *   F20 an agent that only takes over existing conversations (kind attach) is never chosen for a new session, which its connector would
 *       refuse: with another agent there, that one; alone, a question listing its conversations, else no_agent saying why
 *   F21 at the limit of open sessions a new one closes the longest unused idle session of the user's (never one working, waiting for
 *       an approval, or with a command not yet collected, unless silent for a day), tells its connector, and audits it; the route
 *       says which it closed; with none that may be closed, session_limit_reached says what to do
 *   F22 an item closed by its stop button keeps nothing open once the stopped turn's end comes: no prompt listed, no turn counted,
 *       whether the connector names the prompt or not, and whether the turn was cancelled or finished on its own; the next
 *       instruction opens it afresh and its own end closes it
 *   N1  only three things are ever pushed of an instruction the assistant sent, each once, each saying which session and which kind:
 *       it needs the user (the permission request whole: its options and when it runs out, so a channel puts it to them as buttons;
 *       the same request sent again after a reconnect is not pushed again), it finished, it failed (a turn that ended in an error, an
 *       instruction the machine refused, a session that closed before it finished); nothing else (an approval answered is not news)
 *   N2  the sessions list says what each active session waits on its user for now: a request asked and not yet answered, once even
 *       when sent again; not one answered, nor one from a turn that has ended; nothing of anyone else's
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
  /** devenv_send, then the person presses its card: what pressing it sent. */
  async function sendByCard(turn: Claims, args: Recorded): Promise<Recorded> {
    const card = await tools.devenvSend(turn, args as never);
    assert.equal(card.done, false, JSON.stringify(card));
    assert.equal(card.sent, undefined, "never sent from the turn");
    const decided = await schedules.decideConfirmation({ userId: "alice", confirmationId: String(card.confirmation_id), decision: "allow", via: "button" });
    return { ...(decided.result ?? {}), status: decided.status, card };
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
    // The answer is the agent's words: not on the list the router reads every turn (work_recall reads it, and marks the turn).
    assert.doesNotMatch(line, /Makefile/);
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

  /** What was pushed of `itemId` (each say queued for the user's subscription), oldest first. */
  const pushed = async (itemId: string) => (await w.q(
    `SELECT o.payload FROM claw_notification_outbox o JOIN claw_assistant_says s ON s.say_id::text = o.event_id
      WHERE s.item_id = $1 ORDER BY o.id`, [itemId],
  )).map((r: Recorded) => r.payload as Recorded);

  test("N1 an instruction the assistant sent is pushed only when it needs the user, finishes, or fails, each once", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const out = await sendByCard(await userTurn(alice, "让开发机上的 claude 跑 make test"), { text: "跑 make test", agent: "claude" });
    assert.equal(out.status, "done", JSON.stringify(out));
    const sid = String(out.session_id);
    const itemId = String(out.item_id);
    const options = [
      { optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" },
      { name: "no id" }, "junk",
    ];
    // Work going on is not news: nothing is pushed while the agent works.
    await events("alice", cid, sid, [chunk("running…"), ["tool_call", { update: { sessionUpdate: "tool_call", title: "make test" } }]]);
    assert.deepEqual(await pushed(itemId), []);

    // It needs the user: one push, the request whole; the same request sent again after a reconnect is not pushed again.
    await events("alice", cid, sid, [["permissionRequest", { actionId: "act-1", tool: "Run make test", kind: "execute", options, timeout_ms: 600_000 }]]);
    await events("alice", cid, sid, [["permissionRequest", { actionId: "act-1", tool: "Run make test", kind: "execute", options, timeout_ms: 600_000, resent: true }]]);
    let got = await pushed(itemId);
    assert.equal(got.length, 1, JSON.stringify(got));
    assert.equal(got[0].type, "assistant.say");
    assert.match(got[0].text, /^laptop 上的 claude 在等你批准：Run make test/);
    const remote = got[0].remote;
    assert.deepEqual([remote.kind, remote.session_id, remote.machine, remote.agent], ["needs_you", sid, "laptop", "claude"]);
    assert.deepEqual([remote.ask.action_id, remote.ask.tool], ["act-1", "Run make test"]);
    assert.deepEqual(remote.ask.options, [
      { optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" },
    ], "only the options that can be answered");
    const left = Date.parse(remote.ask.expires_at) - Date.now();
    assert.ok(left > 590_000 && left <= 600_000, `runs out when the connector stops waiting (${left} ms)`);
    assert.equal((await remoteItem(sid)).board_state, "needs_you");

    // Answered: the agent goes on, and that is not news either; then it finishes: one push, kind done.
    await events("alice", cid, sid, [["permission_resolved", { actionId: "act-1", optionId: "allow" }], chunk("312 passed")]);
    assert.equal((await pushed(itemId)).length, 1);
    await events("alice", cid, sid, [end()]);
    await events("alice", cid, sid, [end()]);
    got = await pushed(itemId);
    assert.equal(got.length, 2, JSON.stringify(got));
    assert.deepEqual([got[1].remote.kind, got[1].remote.session_id, got[1].remote.ask], ["done", sid, undefined]);
    assert.match(got[1].text, /^laptop 上的 claude 做完了 #\d+：跑 make test\nrunning…312 passed$/);

    // The next instruction fails on the machine: one push, kind error, said as an error.
    await store.pruneCommands((t, p) => w.h.app.db.db.query(t, p), cid, 1_000_000);
    const next = await sendByCard(await userTurn(alice, "再跑一次"), { text: "再跑一次" });
    assert.deepEqual([next.status, next.session_id], ["done", sid]);
    await events("alice", cid, sid, [["turn_end", { stopReason: "error", error: "adapter_unavailable" }]]);
    got = await pushed(itemId);
    assert.equal(got.length, 3, JSON.stringify(got));
    assert.equal(got[2].remote.kind, "error");
    assert.match(got[2].text, /^laptop 上的 claude 出错了，#\d+ 没有做完：再跑一次\n（出错：adapter_unavailable）/);

    // One the machine refuses, and a session that closes before it finished: errors, each once.
    await store.pruneCommands((t, p) => w.h.app.db.db.query(t, p), cid, 1_000_000);
    await sendByCard(await userTurn(alice, "第三次"), { text: "第三次" });
    await events("alice", cid, sid, [["command_rejected", { type: "prompt", reason: "too_many_queued_prompts" }]]);
    await store.pruneCommands((t, p) => w.h.app.db.db.query(t, p), cid, 1_000_000);
    await sendByCard(await userTurn(alice, "第四次"), { text: "第四次" });
    await events("alice", cid, sid, [["session_closed", { reason: "agent_exited" }]]);
    got = await pushed(itemId);
    assert.deepEqual(got.map((g) => g.remote?.kind), ["needs_you", "done", "error", "error", "error"], JSON.stringify(got.map((g) => g.text)));
    assert.match(got[3].text, /没有接下/);
    assert.match(got[4].text, /会话已关闭/);
    assert.ok(got.every((g) => g.remote.session_id === sid));
  });

  test("N2 the sessions list says what each active session waits on its user for now", async () => {
    await w.user("alice");
    const cid = await machine("alice", "laptop");
    const a = await chatSession("alice", cid);
    const b = await chatSession("alice", cid, "/home/u/repo/b");
    const list = async (user = "alice") => {
      const r = await fetch(`${base}/v1/remote-agents/sessions`, { headers: { "x-test-user": user } });
      assert.equal(r.status, 200);
      return new Map(((await r.json()) as Recorded).data.map((s: Recorded) => [s.session_id, s.waiting]));
    };
    assert.deepEqual([(await list()).get(a), (await list()).get(b)], [[], []]);
    // a asks; the same request is sent again after a reconnect; b answers its own.
    await events("alice", cid, a, [ask("act-a", "Run make test")]);
    await events("alice", cid, a, [["permissionRequest", { actionId: "act-a", tool: "Run make test", options: [{ optionId: "allow" }], resent: true }]]);
    await events("alice", cid, b, [ask("act-b", "Edit main.go"), ["permission_resolved", { actionId: "act-b", optionId: "allow" }]]);
    let now = await list();
    assert.deepEqual((now.get(a) as Recorded[]).map((x) => [x.action_id, x.tool]), [["act-a", "Run make test"]]);
    assert.ok(Date.parse((now.get(a) as Recorded[])[0].asked_at) > 0);
    assert.deepEqual(now.get(b), []);
    // Replayed history is not a request; an ask its turn ended without answering is moot.
    await events("alice", cid, b, [["permissionRequest", { actionId: "old", tool: "x", options: [{ optionId: "allow" }], replay: true }]]);
    await events("alice", cid, a, [end()]);
    now = await list();
    assert.deepEqual([now.get(a), now.get(b)], [[], []]);
    // Bob sees none of it.
    await w.user("bob");
    assert.equal((await list("bob")).size, 0);
  });

  test("F2 devenv_send in the user's own signed-in turn is a card; pressed, it sends, files the item, and tells them its end once", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const turn = await userTurn(alice, "让开发机上的 claude 跑 make test");
    const shown = await tools.devenvSend(turn, { text: "跑 make test", agent: "claude" });
    assert.deepEqual([shown.sent, shown.done, shown.why_card, shown.machine, shown.agent], [undefined, false, "confirm_first", "laptop", "claude"]);
    assert.deepEqual(await queued(cid), [], "nothing goes to the machine before the press");
    assert.equal(await untrusted(turn), true, "the turn has read the machine's name");
    const decided = await schedules.decideConfirmation({ userId: "alice", confirmationId: String(shown.confirmation_id), decision: "allow", via: "button" });
    assert.equal(decided.status, "done", JSON.stringify(decided));
    const out = decided.result as Recorded;
    assert.deepEqual([out.machine, out.agent], ["laptop", "claude"]);
    const cmds = await queued(cid);
    assert.deepEqual(cmds.map((c: Recorded) => c.type), ["session.new", "prompt"]);
    assert.equal(cmds[0].payload.cwd, "/home/u/repo", "a new session in the agent's root");
    assert.equal(cmds[1].payload.text, "跑 make test");
    const sid = String(out.session_id);
    let item = await remoteItem(sid);
    assert.deepEqual([item.item_id, item.seq, item.board_state, item.params.origin, item.params.lang], [out.item_id, out.seq, "in_progress", "assistant", "zh"]);

    // A replayed call (the same words in the same turn) is the same card, already answered: nothing is sent again.
    const again = await tools.devenvSend(turn, { text: "跑 make test", agent: "claude" });
    assert.deepEqual([again.confirmation_id, again.status], [shown.confirmation_id, "done"]);
    assert.equal((await queued(cid)).length, 2);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_confirmations"))[0].n, 1, "one card for it");

    // It waits for an approval: the user is told once, the item needs them; answered, it goes on.
    await events("alice", cid, sid, [ask("act-1", "Run make test")]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.pending_question], ["needs_you", "等你批准：Run make test"]);
    await events("alice", cid, sid, [["permission_resolved", { actionId: "act-1", optionId: "allow" }], chunk("All 312 tests passed,\n0 failed.")]);
    assert.equal((await remoteItem(sid)).board_state, "in_progress");
    await events("alice", cid, sid, [end()]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.outcome, item.summary], ["done", "answered", "All 312 tests passed, 0 failed."]);
    // Besides the card: what the item says to them.
    const told = (await says("alice")).filter((x: Recorded) => x.item_id);
    assert.equal(told.length, 2, JSON.stringify(told));
    assert.match(told[0].text, /^laptop 上的 claude 在等你批准：Run make test（#\d+ 跑 make test）。发 \/agent attach /);
    // The summary is one line; the message keeps the answer's line breaks.
    assert.match(told[1].text, /^laptop 上的 claude 做完了 #\d+：跑 make test\nAll 312 tests passed,\n0 failed\.$/);
    assert.ok(told.every((s: Recorded) => s.item_id === item.item_id && s.fallback));
    await events("alice", cid, sid, [end()]);
    assert.equal((await says("alice")).filter((x: Recorded) => x.item_id).length, 2, "said once");
    assert.equal(await w.mod.silent.tellSilentItems(0), 0);

    // The connector acknowledged what it collected (a heartbeat's cursor). An idle session of that agent continues; nothing new is opened.
    await store.pruneCommands((t, p) => w.h.app.db.db.query(t, p), cid, 1_000_000);
    const next = await sendByCard(await userTurn(alice, "再跑一次"), { text: "再跑一次" });
    assert.deepEqual([next.status, next.session_id, next.seq], ["done", sid, item.seq]);
    assert.deepEqual((await queued(cid)).map((c: Recorded) => c.type), ["prompt"]);
    // While it works, it is not sent another: a new session is.
    const third = await sendByCard(await userTurn(alice, "跑 lint"), { text: "跑 lint" });
    assert.equal(third.status, "done");
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

  test("F4b no machine gives the exact commands that connect one; a connector below the minimum starts no session", async () => {
    const alice = await w.user("alice");
    const none = await tools.devenvSend(await userTurn(alice, "让开发机上的 claude 跑 make"), { text: "make" }).catch((e) => e);
    assert.equal((none as Recorded).code, "no_machine");
    const setup = (none as Recorded).data.connect_a_machine;
    assert.equal(setup.commands[0], "npm install -g @primusclaw/connector");
    assert.match(setup.commands[2], /^claw-connector login --server /);
    assert.match(setup.text_zh, /claw-connector init/);
    assert.match(setup.text_en, /claw-connector service install/);

    const laptop = await machine("alice", "laptop");
    const open = await chatSession("alice", laptop);   // (opened while its connector was still new enough)
    await w.q("UPDATE claw_remote_connectors SET version = '0.1.2' WHERE connector_id = $1", [laptop]);
    // A session already open on it continues: only a new one is refused.
    const cont = await tools.planSend("alice", { text: "make", target: open });
    assert.equal(cont.ok, true, JSON.stringify(cont));
    await w.q("UPDATE claw_remote_sessions SET status = 'closed' WHERE session_id = $1", [open]);
    const old = await tools.devenvSend(await userTurn(alice, "让 laptop 上的 claude 跑 make"), { text: "make", target: "laptop" }).catch((e) => e);
    assert.equal((old as Recorded).code, "connector_outdated");
    assert.match((old as Recorded).message, /0\.1\.2, older than 0\.1\.3.*npm install -g @primusclaw\/connector@latest && claw-connector stop && claw-connector service install$/);
    // A card pressed after the connector went out of date sends nothing either.
    const plan = { connector_id: laptop, machine: "laptop", agent_id: "claude", agent_name: null, session_id: null, resume_ref: null, cwd: "/home/u/repo", label: "laptop/claude/new" };
    const sent = await tools.executeSend("alice", plan, "make", "k-outdated", "en");
    assert.deepEqual([sent.ok, (sent as Recorded).error], [false, "connector_outdated"]);
    assert.deepEqual(await queued(laptop), []);
  });

  test("F17 a machine revoked with its card waiting: the card closes, the router no longer puts it to them, a press sends nothing", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const laptop = await machine("alice", "laptop");
    const desktop = await machine("alice", "desktop");
    const toLaptop = await tools.devenvSend(await userTurn(alice, "让 laptop 上的 claude 跑 make test"), { text: "跑 make test", target: "laptop" });
    const toDesktop = await tools.devenvSend(await userTurn(alice, "让 desktop 上的 claude 跑 lint"), { text: "跑 lint", target: "desktop" });
    assert.equal(toLaptop.done, false, JSON.stringify(toLaptop));
    assert.equal(toDesktop.done, false, JSON.stringify(toDesktop));
    assert.match(await schedules.renderScheduleState("alice"), /on the machine "laptop"/);

    // Revoked through the user's route (the same one claw-connector logout's revoke reaches): laptop's card closes with it.
    const r = await fetch(`${base}/v1/remote-agents/connectors/${laptop}`, { method: "DELETE", headers: { "x-test-user": "alice" } });
    assert.equal(r.status, 200, await r.text());
    const card = (await w.q("SELECT * FROM claw_assistant_confirmations WHERE confirmation_id = $1", [toLaptop.confirmation_id]))[0];
    assert.deepEqual([card.status, card.decided_via, card.result?.error], ["expired", "connector_revoked", "no_machine"]);
    assert.deepEqual((await schedules.pendingConfirmations("alice")).map((c) => c.confirmation_id), [toDesktop.confirmation_id],
      "the other machine's card still waits");
    const state = await schedules.renderScheduleState("alice");
    assert.doesNotMatch(state, /on the machine "laptop"/, "the router is not told of the revoked machine's card");
    assert.match(state, /on the machine "desktop"/);

    // Pressed afterwards: answered before (closed), nothing sent; the card stays as it was closed.
    const pressed = await schedules.decideConfirmation({ userId: "alice", confirmationId: String(toLaptop.confirmation_id), decision: "allow", via: "button" });
    assert.deepEqual([pressed.status, pressed.answered_now], ["expired", false]);
    assert.deepEqual(await queued(laptop), []);
    // Another user's revoke never touches alice's cards, and revoking again is a 404 that closes nothing.
    await w.user("bob");
    await machine("bob", "bob-box");
    const again = await fetch(`${base}/v1/remote-agents/connectors/${desktop}`, { method: "DELETE", headers: { "x-test-user": "bob" } });
    assert.equal(again.status, 404);
    assert.equal((await w.q("SELECT status FROM claw_assistant_confirmations WHERE confirmation_id = $1", [toDesktop.confirmation_id]))[0].status, "pending");
  });

  test("F17b a card drawn while its machine is being revoked: the turn is refused, no card is left waiting", async () => {
    const { inTransaction } = await import("../src/infra/db.js");
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const laptop = await machine("alice", "laptop");
    // A revoke holds the machine's row (as `revokeConnector` does) while the turn plans against it.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const revoke = inTransaction(async (q) => {
      await q("UPDATE claw_remote_connectors SET revoked_at = NOW(), stream_seen_at = NULL WHERE connector_id = $1", [laptop]);
      held();
      await gate;
      await tools.closeCardsOfConnector(q, "alice", laptop);
    });
    await isHeld;
    const sent = tools.devenvSend(await userTurn(alice, "让 laptop 上的 claude 跑 make test"), { text: "跑 make test", target: "laptop" })
      .then((v) => v, (e) => e);
    // The turn is seen waiting on the machine's row; a turn that never takes it would draw its card meanwhile.
    for (let i = 0; i < 100; i++) {
      const waiting = await w.q("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%claw_remote_connectors%FOR SHARE%'");
      if (waiting.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await revoke;
    const out = await sent;
    assert.equal((out as Recorded).code, "no_machine", JSON.stringify(out));
    assert.deepEqual(await schedules.pendingConfirmations("alice"), [], "no card waits for the revoked machine");
    assert.deepEqual(await queued(laptop), []);
  });

  test("F17c a revoke while a card of that machine is being pressed: the revoke finishes, it does not wait for the press", async () => {
    const { inTransaction } = await import("../src/infra/db.js");
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const laptop = await machine("alice", "laptop");
    const card = await tools.devenvSend(await userTurn(alice, "让 laptop 上的 claude 跑 make test"), { text: "跑 make test", target: "laptop" });
    assert.equal(card.done, false, JSON.stringify(card));
    // The press holds the card's row (as `decideConfirmation` does) while its send waits for the machine's.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const press = inTransaction(async (q) => {
      await q("SELECT 1 FROM claw_assistant_confirmations WHERE confirmation_id = $1 FOR UPDATE", [card.confirmation_id]);
      held();
      await gate;
    });
    await isHeld;
    try {
      const r = await Promise.race([
        fetch(`${base}/v1/remote-agents/connectors/${laptop}`, { method: "DELETE", headers: { "x-test-user": "alice" } }),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      assert.ok(r, "the revoke waited for the card being pressed");
      assert.equal(r.status, 200, await r.text());
      assert.ok((await w.q("SELECT revoked_at FROM claw_remote_connectors WHERE connector_id = $1", [laptop]))[0].revoked_at);
    } finally {
      release();
      await press;
    }
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

  test("F17 a Windows machine's roots are folders: drive and share roots, either separator, any case, its own spelling sent", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const roots = ["C:\\Users\\alice\\repo", "\\\\fileserver\\share\\proj"];
    const cid = await machine("alice", "winbox", { agents: [{ ...CLAUDE, capabilities: { roots } }] });
    const plan = async (cwd?: string) => {
      const out = await tools.planSend("alice", { text: "dir", agent: "claude", ...(cwd === undefined ? {} : { cwd }) });
      return out.ok ? out.plan.cwd : `${out.code}: ${out.message}`;
    };
    // Nothing named: the agent's first root, which was refused as no folder at all before.
    assert.equal(await plan(), "C:\\Users\\alice\\repo");
    // A folder inside a root, however it is typed: sent as the root spells it, with the root's separator.
    assert.equal(await plan("C:\\Users\\alice\\repo\\api"), "C:\\Users\\alice\\repo\\api");
    assert.equal(await plan("c:/users/alice/repo/api/"), "C:\\Users\\alice\\repo\\api");
    assert.equal(await plan("C:\\Users\\alice\\repo\\"), "C:\\Users\\alice\\repo");
    assert.equal(await plan("\\\\FileServer\\Share\\proj\\web"), "\\\\fileserver\\share\\proj\\web");
    assert.equal(await plan("//FileServer/Share/proj/web"), "\\\\fileserver\\share\\proj\\web");
    // Outside every root, a sibling sharing a prefix, another drive, a POSIX path: no agent may work there.
    for (const outside of ["C:\\Users\\alice\\repo2", "D:\\Users\\alice\\repo", "C:\\Users", "/home/u/repo", "Users\\alice\\repo"]) {
      assert.match(await plan(outside), /^which_agent: no agent there may work in/, outside);
    }

    // The product path: pressed, the card opens the session in that folder on the machine.
    const sent = await sendByCard(await userTurn(alice, "在 winbox 的 repo/api 里 dir"), { text: "dir", agent: "claude", cwd: "c:/users/alice/repo/api" });
    assert.equal(sent.status, "done", JSON.stringify(sent));
    const cmds = await queued(cid);
    assert.deepEqual(cmds.map((c: Recorded) => [c.type, c.payload.cwd ?? null]), [["session.new", "C:\\Users\\alice\\repo\\api"], ["prompt", null]]);

    // An idle session already open in that folder continues, whichever way the folder is typed.
    const open = await chatSession("alice", cid, "C:\\Users\\alice\\repo\\web");
    const again = await tools.planSend("alice", { text: "dir", agent: "claude", cwd: "c:/Users/Alice/repo/web" });
    assert.ok(again.ok, JSON.stringify(again));
    assert.equal(again.plan.session_id, open);

    // A POSIX root that starts with two slashes is POSIX: its folders compare exactly, case and all.
    const posix = await machine("alice", "nfsbox", { agents: [{ ...CLAUDE, capabilities: { roots: ["//srv/share/proj"] } }] });
    const lower = await chatSession("alice", posix, "//srv/share/proj/web");
    const exact = await tools.planSend("alice", { text: "ls", target: "nfsbox", agent: "claude", cwd: "//srv/share/proj/web" });
    assert.ok(exact.ok, JSON.stringify(exact));
    assert.equal(exact.plan.session_id, lower);
    const other = await tools.planSend("alice", { text: "ls", target: "nfsbox", agent: "claude", cwd: "//srv/share/proj/Web" });
    assert.ok(other.ok, JSON.stringify(other));
    assert.deepEqual([other.plan.session_id, other.plan.cwd], [null, "//srv/share/proj/Web"]);
  });

  test("F5 work_send refuses a development environment item; work_stop closes it and cancels its turn; worker_tail is the answer", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "laptop");
    const out = await sendByCard(await userTurn(alice, "跑 make test"), { text: "跑 make test" });
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
    await w.user("alice");
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
    const out = await sendByCard(await userTurn(alice, "跑 make test"), { text: "跑 make test" });
    const sid = String(out.session_id);
    const r = await post("alice", `/v1/work-items/${String(out.item_id)}/stop`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).outcome], ["done", "stopped"]);
    assert.deepEqual((await queued(cid)).map((c: Recorded) => c.type), ["session.new", "prompt", "cancel"]);
  });

  test("F9 a turn that ended before its prompt's item was written still ends the item", async () => {
    await w.user("alice");
    const cid = await machine("alice", "laptop");
    const sid = await chatSession("alice", cid);
    await events("alice", cid, sid, [chunk("history"), end()]);
    const note = (text: string, since: number) =>
      items.noteRemotePrompt({ owner: "alice", sessionId: sid, connectorId: cid, agentId: "claude", text, origin: "chat", since, cmdSeq: 9000 + text.length });

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
    const out = await sendByCard(await userTurn(alice, "跑 make test"), { text: "跑 make test" });
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
    await w.user("alice");
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
    const out = await sendByCard(await userTurn(alice, "跑 make test"), { text: "跑 make test" });
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
    assert.equal((await remoteItem(sid)).params.cancels.length, 1);
    const m = seqs.get(sid) ?? 0;
    seqs.set(sid, m + 1);
    await store.ingestEvents({ connector_id: cid, owner_user_id: "alice" }, [{ index: 0, session_id: sid, seq: m + 1, type: "turn_end", ts: Date.now(), data: { stopReason: "cancelled" } }] as never);
    assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "and format" })).status, 202);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.params.open_turns, item.params.cancels.length], ["in_progress", 1, 0]);
  });

  test("F13 a turn that finished as the stop was on its way never ends the instruction sent after the stop", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "laptop");
    const prompt = async (sid: string, text: string) => assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text })).status, 202);

    // Stop, a new instruction, then the old turn's own end, then the cancel's (it found nothing running), then the new one's.
    const one = await sendByCard(await userTurn(alice, "跑 make test"), { text: "跑 make test" });
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
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.cancels.length], ["done", 0]);
  });

  test("F14 nothing is ever sent from the turn itself: whatever the words, it is a card the user presses", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    // The user's own words in their fresh signed-in turn; a command they only quoted; one nobody wrote: each a card, nothing queued.
    for (const [said, text] of [["让 claude 跑 make test", "跑 make test"], ["别跑 make deploy-prod", "make deploy-prod"], ["那个跑完了吗", "rm -rf ~/repo"]]) {
      const out = await tools.devenvSend(await userTurn(alice, said), { text });
      assert.deepEqual([out.sent, out.done, out.why_card], [undefined, false, "confirm_first"], JSON.stringify(out));
    }
    assert.deepEqual(await queued(cid), [], "nothing reaches the machine until the person presses a card");
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_confirmations WHERE status = 'pending'"))[0].n, 3);
  });

  test("F15 two stops before either cancel's end has come: each end is the oldest one's, and the last instruction stays open", async () => {
    await w.user("alice");
    const cid = await machine("alice", "laptop");
    const sid = await chatSession("alice", cid);
    const send = async (body: Recorded) => assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, body)).status, 202);
    await send({ type: "prompt", text: "p1" });
    await send({ type: "cancel" });
    await send({ type: "prompt", text: "p2" });
    await send({ type: "cancel" });
    await send({ type: "prompt", text: "p3" });
    assert.equal((await remoteItem(sid)).params.cancels.length, 2);
    await events("alice", cid, sid, [end("cancelled"), end("cancelled")]);
    let item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.params.open_turns, item.params.cancels.length], ["in_progress", 1, 0], "p3 is still running");
    await events("alice", cid, sid, [chunk("p3 done"), end()]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.summary], ["done", "p3 done"]);
  });

  test("F16 a connector that names each turn's prompt is followed by name, and one that does not is counted as before", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    /** The session's prompts, oldest first, as the connector receives them: their `cmd_seq` and `cmd_id`. */
    const promptRows = async (sid: string): Promise<Array<{ seq: number; id: string }>> =>
      (await w.q("SELECT cmd_seq, cmd_id FROM claw_remote_commands WHERE session_id = $1 AND type = 'prompt' ORDER BY cmd_seq", [sid]))
        .map((r: Recorded) => ({ seq: Number(r.cmd_seq), id: String(r.cmd_id) }));
    const promptIds = async (sid: string): Promise<number[]> => (await promptRows(sid)).map((r) => r.seq);
    /** A turn's end as the connector posts it, naming its prompt (null: a cancel that found nothing running). */
    const endOf = (seq: number | null, stopReason = "end_turn"): [string, Recorded] => ["turn_end", { stopReason, cmd_id: seq === null ? null : `id-${seq}`, cmd_seq: seq }];
    const refusedBy = (seq: number, reason: string): [string, Recorded] => ["command_rejected", { type: "prompt", cmd_id: `id-${seq}`, cmd_seq: seq, reason }];

    // The known gap of counting: p1 finishes on its own as the first stop is on its way (that stop brings no end of its own), p2 is
    // cancelled by the second stop, then p3 runs and ends. Counted, the item stayed in progress; by name, p3's end ends it.
    const one = await sendByCard(await userTurn(alice, "跑 make test"), { text: "跑 make test" });
    const sid = String(one.session_id);
    const send = async (body: Recorded) => assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, body)).status, 202);
    await send({ type: "cancel" });
    await send({ type: "prompt", text: "p2" });
    await send({ type: "cancel" });
    await send({ type: "prompt", text: "p3" });
    const [p1, p2, p3] = await promptIds(sid);
    // The card's prompt is under the command id derived from the card; the item knows each by its number.
    assert.match((await promptRows(sid))[0].id, /^k:[0-9a-f]{40}$/);
    assert.deepEqual((await remoteItem(sid)).params.open_cmd_seqs, [p1, p2, p3]);
    await events("alice", cid, sid, [chunk("tests done"), endOf(p1)]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.open_cmd_seqs], ["in_progress", [p2, p3]]);
    await events("alice", cid, sid, [endOf(p2, "cancelled")]);
    assert.equal((await remoteItem(sid)).board_state, "in_progress", "p3 is still running");
    await events("alice", cid, sid, [chunk("p3 done"), endOf(p3)]);
    let item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.outcome, item.summary, item.params.open_turns, item.params.open_cmd_seqs, item.params.cancels],
      ["done", "answered", "p3 done", 0, [], []]);

    // Stop, then a new instruction; the old turn's end and the cancel's end that names nothing come after: neither ends it.
    await send({ type: "prompt", text: "q1" });
    assert.equal((await post("alice", `/v1/work-items/${String(one.item_id)}/stop`, {})).status, 200);
    await send({ type: "prompt", text: "q2" });
    const [, , , q1, q2] = await promptIds(sid);
    assert.deepEqual((await remoteItem(sid)).params.open_cmd_seqs, [q2]);
    await events("alice", cid, sid, [chunk("q1 finished anyway"), endOf(q1), endOf(null, "cancelled")]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).title], ["in_progress", "laptop claude: q2"], "q1's end is not q2's");
    // An end naming a prompt the item never had open, or a refusal of one, changes nothing either.
    await events("alice", cid, sid, [endOf(999_999), refusedBy(999_998, "cancelled")]);
    assert.deepEqual((await remoteItem(sid)).params.open_cmd_seqs, [q2]);
    assert.equal((await remoteItem(sid)).board_state, "in_progress");
    await events("alice", cid, sid, [chunk("q2 done"), endOf(q2)]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).summary], ["done", "q2 done"]);

    // Two prompts, then stop: the queued one is refused by name (`cancelled`) and the running one ends cancelled.
    await send({ type: "prompt", text: "r1" });
    await send({ type: "prompt", text: "r2" });
    await send({ type: "cancel" });
    const [r1, r2] = (await promptIds(sid)).slice(-2);
    await events("alice", cid, sid, [refusedBy(r2, "cancelled")]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.open_cmd_seqs], ["in_progress", [r1]]);
    await events("alice", cid, sid, [chunk("half"), endOf(r1, "cancelled")]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.outcome], ["done", "answered"]);
    assert.match(item.summary, /已取消|cancelled/);

    // The only prompt open refused before it was queued, by name: the item ends, dropped.
    await send({ type: "prompt", text: "s1" });
    const s1 = (await promptIds(sid)).at(-1)!;
    await events("alice", cid, sid, [refusedBy(s1, "too_many_queued_prompts")]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.outcome, item.params.open_cmd_seqs], ["done", "dropped", []]);

    // A chat that sends a credential-shaped Idempotency-Key: the command id is masked on the way, its number is not, and ends it.
    const key = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    const typed = await fetch(`${base}/v1/remote-agents/sessions/${sid}/commands`, {
      method: "POST", headers: { "x-test-user": "alice", "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ type: "prompt", text: "k1" }),
    });
    assert.equal(typed.status, 202);
    const k1 = (await promptRows(sid)).at(-1)!;
    assert.equal(k1.id, `k:${key}`);
    await events("alice", cid, sid, [chunk("k1 done"), ["turn_end", { stopReason: "end_turn", cmd_id: k1.id, cmd_seq: k1.seq }]]);
    const stored = (await w.q("SELECT data FROM claw_remote_events WHERE session_id = $1 AND type = 'turn_end' ORDER BY id DESC LIMIT 1", [sid]))[0];
    assert.notEqual(stored.data.cmd_id, k1.id, "the id was masked as a credential on ingest");
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).summary], ["done", "k1 done"]);

    // An end that names no prompt at all (a connector from before names were sent): the item counts, as it always did.
    await send({ type: "prompt", text: "t1" });
    await send({ type: "prompt", text: "t2" });
    await events("alice", cid, sid, [end()]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.params.open_turns, item.params.open_cmd_seqs], ["in_progress", 1, null]);
    await events("alice", cid, sid, [chunk("t2 done"), end()]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).summary], ["done", "t2 done"]);
    // The next instruction is followed by name again.
    await send({ type: "prompt", text: "u1" });
    const u1 = (await promptIds(sid)).at(-1)!;
    assert.deepEqual((await remoteItem(sid)).params.open_cmd_seqs, [u1]);

    // The connector restarts while u1 runs: u1 is not delivered again and its turn's end never comes. A stop then finds nothing
    // running and its end names no prompt; it ends u1, and the item with it. The next instruction is followed as before.
    await send({ type: "cancel" });
    assert.deepEqual((await remoteItem(sid)).params.cancels.map((c: Recorded) => c.seqs), [[u1]]);
    await events("alice", cid, sid, [endOf(null, "cancelled")]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.outcome, item.params.open_cmd_seqs, item.params.cancels], ["done", "answered", [], []],
      "a stop ends an instruction whose turn's end never came");
    await send({ type: "prompt", text: "v1" });
    const v1 = (await promptIds(sid)).at(-1)!;
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.open_cmd_seqs], ["in_progress", [v1]]);
    await events("alice", cid, sid, [chunk("v1 done"), endOf(v1)]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).summary], ["done", "v1 done"]);

    // The same across an upgrade: a cancel noted before the prompts it had open were kept with it ends every prompt open but those
    // sent after it. x2, sent after the cancel and dropped by the second one, is refused by name; x1 ends with the cancel that ends it.
    await send({ type: "prompt", text: "x1" });
    await send({ type: "cancel" });
    await send({ type: "prompt", text: "x2" });
    await send({ type: "cancel" });
    await w.q(
      `UPDATE claw_work_items SET params = jsonb_set(params, '{cancels}', (SELECT jsonb_agg(c - 'seqs') FROM jsonb_array_elements(params->'cancels') c))
        WHERE worker_session_id = $1`,
      [`remote:${sid}`],
    );
    assert.deepEqual((await remoteItem(sid)).params.cancels.map((c: Recorded) => c.seqs), [undefined, undefined]);
    const [x1, x2] = (await promptIds(sid)).slice(-2);
    assert.deepEqual((await remoteItem(sid)).params.open_cmd_seqs, [x1, x2]);
    // The first cancel finds nothing running (the connector restarted as x1 ran): x1 ends, x2 is still to run.
    await events("alice", cid, sid, [endOf(null, "cancelled")]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.open_cmd_seqs], ["in_progress", [x2]]);
    await events("alice", cid, sid, [chunk("x2 half"), endOf(x2, "cancelled")]);
    item = await remoteItem(sid);
    assert.deepEqual([item.board_state, item.params.open_turns, item.params.open_cmd_seqs, item.params.cancels], ["done", 0, [], []],
      "cancels from before the upgrade end what they had open");
    // And the other order: y1 runs when both stops come, y2 sent between them is dropped by name, one cancelled end for y1.
    await send({ type: "prompt", text: "y1" });
    await send({ type: "cancel" });
    await send({ type: "prompt", text: "y2" });
    await send({ type: "cancel" });
    await w.q(
      `UPDATE claw_work_items SET params = jsonb_set(params, '{cancels}', (SELECT jsonb_agg(c - 'seqs') FROM jsonb_array_elements(params->'cancels') c))
        WHERE worker_session_id = $1`,
      [`remote:${sid}`],
    );
    const [y1, y2] = (await promptIds(sid)).slice(-2);
    await events("alice", cid, sid, [refusedBy(y2, "cancelled"), chunk("y1 half"), endOf(y1, "cancelled")]);
    assert.deepEqual([(await remoteItem(sid)).board_state, (await remoteItem(sid)).params.open_cmd_seqs], ["done", []]);
  });

  test("F20 an agent that only takes over existing conversations is never chosen for a new session; the refusal says why", async () => {
    const alice = await w.user("alice");
    const ATTACH = { agent_id: "claude-attach", kind: "attach", name: "Claude Code (existing sessions)", capabilities: { roots: ["/home/u/repo"] } };
    // Both offered, none named: the one that can start a session, not a question and never the takeover-only one.
    const cid = await machine("alice", "laptop", { agents: [ATTACH, CLAUDE] });
    const both = await sendByCard(await userTurn(alice, "让开发机跑 make test"), { text: "make test" });
    assert.equal(both.status, "done", JSON.stringify(both));
    const made = (await queued(cid)).filter((c: Recorded) => c.type === "session.new");
    assert.deepEqual(made.map((c: Recorded) => c.payload.agent_id), ["claude"]);

    // Only the takeover-only agent, with nothing to take over: no card, a refusal that says why, nothing queued.
    const only = await machine("alice", "desktop", { agents: [ATTACH] });
    const none = await tools.devenvSend(await userTurn(alice, "让 desktop 跑 make"), { text: "make", target: "desktop" }).catch((e) => e);
    assert.equal((none as Recorded).code, "no_agent", JSON.stringify(none));
    assert.match((none as Recorded).message, /only takes over a conversation already on that machine[\s\S]*cannot start a new session/);
    assert.deepEqual(await queued(only), []);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_confirmations WHERE status = 'pending'"))[0].n, 0);

    // With a conversation to take over: a question listing it; named, it is taken over (resume_ref), never a session without one.
    await store.recordHeartbeat(only, "alice", { version: "0.1.3", cmdCursor: null, agents: [{ ...ATTACH, capabilities: { ...ATTACH.capabilities,
      resumable: [{ ref: "c0ffee00-0000-4000-8000-0000000000f2", title: "t", cwd: "/home/u/repo", updated_at: Math.floor(Date.now() / 1000), state: "idle" }] } }] as never });
    await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW(), stream_seen_at = NOW() WHERE connector_id = $1", [only]);
    const which = await tools.devenvSend(await userTurn(alice, "让 desktop 跑 make"), { text: "make", target: "desktop" }).catch((e) => e);
    assert.equal((which as Recorded).code, "which_agent", JSON.stringify(which));
    assert.deepEqual((which as Recorded).data.choices, ["desktop/claude-attach/1"]);
    const taken = await sendByCard(await userTurn(alice, "让 desktop/claude-attach/1 跑 make"), { text: "make", target: "desktop/claude-attach/1" });
    assert.equal(taken.status, "done", JSON.stringify(taken));
    const newOnDesktop = (await queued(only)).filter((c: Recorded) => c.type === "session.new");
    assert.deepEqual(newOnDesktop.map((c: Recorded) => [c.payload.agent_id, c.payload.resume_ref]), [["claude-attach", "c0ffee00-0000-4000-8000-0000000000f2"]]);
  });

  test("F21 at the limit of open sessions, a new one closes the longest unused idle one instead of being refused", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "laptop");
    const sids: string[] = [];
    for (let i = 0; i < 10; i++) sids.push(await chatSession("alice", cid));
    // All ten were used within the half hour: none may be closed, and the refusal says what to do. (A folder none of them is in, so
    // the instruction needs a new session rather than continuing an idle one.)
    const full = await sendByCard(await userTurn(alice, "让 claude 跑 make"), { text: "make", target: "laptop", cwd: "/home/u/repo/web" });
    assert.deepEqual([full.status, full.error], ["failed", "session_limit_reached"], JSON.stringify(full));
    assert.match(String(full.message), /all 10 sessions[\s\S]*\/agent close/);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_remote_sessions WHERE status = 'active'"))[0].n, 10);

    // An hour unused: one working (its turn under way), one waiting for approval, one with a prompt not yet collected, and two idle.
    await w.q("UPDATE claw_remote_sessions SET updated_at = NOW() - interval '1 hour'");
    await events("alice", cid, sids[0], [chunk("still going")]);
    await events("alice", cid, sids[1], [ask("act-9", "Run rm")]);
    await events("alice", cid, sids[3], [end()]);
    await w.q("UPDATE claw_remote_sessions SET updated_at = NOW() - interval '1 hour'");
    await w.q("UPDATE claw_remote_sessions SET updated_at = NOW() - interval '2 hours' WHERE session_id = ANY($1::uuid[])", [[sids[0], sids[1], sids[2]]]);
    assert.equal((await post("alice", `/v1/remote-agents/sessions/${sids[2]}/commands`, { type: "prompt", text: "x" })).status, 202);
    await w.q("UPDATE claw_remote_sessions SET updated_at = NOW() - interval '2 hours' WHERE session_id = $1", [sids[2]]);
    await w.q("UPDATE claw_remote_sessions SET updated_at = NOW() - interval '90 minutes' WHERE session_id = $1", [sids[3]]);
    // Others' sessions are not hers to close.
    await w.user("bob");
    const bobBox = await machine("bob", "bob-box");
    const bobSid = await chatSession("bob", bobBox);
    await w.q("UPDATE claw_remote_sessions SET updated_at = NOW() - interval '3 hours' WHERE session_id = $1", [bobSid]);

    const sent = await sendByCard(await userTurn(alice, "让 claude 跑 make"), { text: "make", target: "laptop", cwd: "/home/u/repo/web" });
    assert.equal(sent.status, "done", JSON.stringify(sent));
    const closed = (await w.q("SELECT session_id::text AS s FROM claw_remote_sessions WHERE status = 'closed'")).map((r: Recorded) => r.s);
    assert.deepEqual(closed, [sids[3]], "the longest unused that is idle: not the working, the waiting or the queued one, and not bob's");
    const close = (await queued(cid)).filter((c: Recorded) => c.type === "close");
    assert.deepEqual(close.map((c: Recorded) => c.session_id), [sids[3]], "its connector is told to close it");
    const audit = (await w.q("SELECT detail FROM claw_remote_audit WHERE action = 'session.reclaimed'"))[0].detail;
    assert.equal(audit.for_session, sent.session_id);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_remote_sessions WHERE status = 'active' AND owner_user_id = 'alice'"))[0].n, 10);

    // A day without a word: even one mid-turn may be closed (its machine went away).
    await w.q("UPDATE claw_remote_sessions SET updated_at = NOW() WHERE owner_user_id = 'alice' AND status = 'active'");
    await w.q("UPDATE claw_remote_sessions SET updated_at = NOW() - interval '25 hours' WHERE session_id = $1", [sids[0]]);
    const route = await post("alice", "/v1/remote-agents/sessions", { connector_id: cid, agent_id: "claude", cwd: "/home/u/repo" });
    assert.equal(route.status, 201, JSON.stringify(route.body));
    assert.deepEqual(route.body.reclaimed, [sids[0]], "the route says which one it closed");
    const again = await post("alice", "/v1/remote-agents/sessions", { connector_id: cid, agent_id: "claude", cwd: "/home/u/repo" });
    assert.deepEqual([again.status, again.body.error], [409, "session_limit_reached"]);
  });

  test("F22 a stopped item clears what it still had open when the stopped turn's end comes, named or counted", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "laptop");
    const promptSeqs = async (sid: string): Promise<number[]> =>
      (await w.q("SELECT cmd_seq FROM claw_remote_commands WHERE session_id = $1 AND type = 'prompt' ORDER BY cmd_seq", [sid])).map((r: Recorded) => Number(r.cmd_seq));
    const endOf = (seq: number | null, stopReason = "end_turn"): [string, Recorded] => ["turn_end", { stopReason, cmd_id: seq === null ? null : `id-${seq}`, cmd_seq: seq }];
    const open = async (sid: string) => { const it = await remoteItem(sid); return [it.board_state, it.outcome, it.params.open_turns, it.params.open_cmd_seqs]; };

    for (const [named, stopReason] of [[true, "cancelled"], [true, "end_turn"], [false, "cancelled"]] as const) {
      const out = await sendByCard(await userTurn(alice, `跑 make test ${stopReason}`), { text: `跑 make test ${stopReason}` });
      const sid = String(out.session_id);
      const [p1] = await promptSeqs(sid);
      assert.equal((await post("alice", `/v1/work-items/${String(out.item_id)}/stop`, {})).status, 200);
      // Closed by the button, before the machine has said anything: the running prompt is still on the books.
      assert.deepEqual(await open(sid), ["done", "stopped", 1, [p1]]);
      await events("alice", cid, sid, [chunk("half"), named ? endOf(p1, stopReason) : end(stopReason)]);
      assert.deepEqual(await open(sid), ["done", "stopped", 0, named ? [] : null], `named=${named} ${stopReason}: nothing left open`);
      // The next instruction opens it afresh, and its own end closes it.
      assert.equal((await post("alice", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "pwd" })).status, 202);
      const p2 = (await promptSeqs(sid)).at(-1)!;
      assert.deepEqual(await open(sid), ["in_progress", null, 1, [p2]]);
      await events("alice", cid, sid, [chunk("/home/u/repo"), named ? endOf(p2) : end()]);
      assert.deepEqual(await open(sid), ["done", "answered", 0, named ? [] : null]);
    }
  });

  test("F6 the router sends instructions with devenv_send and follows development environment items", async () => {
    const section = prompts.renderRouterDevenvSection({ actions: true, send: true });
    assert.match(section, /devenv_send, called directly and first, never after devenv_list/);
    assert.match(section, /刚才那个跑完了吗/);
    assert.match(section, /Never say something did not run when such an item says it finished/);
    assert.doesNotMatch(section, /nothing here sends it/);
    assert.match(prompts.renderRouterDevenvSection({ actions: true }), /nothing here sends it/);
    assert.equal(prompts.ROUTER_DEVENV_PROMPT_VERSION, "router-devenv-v5");
    // What operators and release notes say Claw may run on a user's machine is what the code does: a card, never from the turn.
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync(new URL("../../../docs/remote-agents.md", import.meta.url), "utf8");
    const notes = readFileSync(new URL("../../../../CHANGELOG.md", import.meta.url), "utf8");
    for (const text of [doc, notes]) {
      assert.doesNotMatch(text, /runs at once/, "devenv_send never runs from the turn");
      assert.match(text, /cards_off/);
    }
    assert.match(notes, new RegExp(`devenv_send[\\s\\S]*Router prompt ${prompts.ROUTER_DEVENV_PROMPT_VERSION}\\.`));
    assert.match(doc, /cmdKey\("card", confirmationId\)/);
    assert.equal(items.remoteWorkerSessionId("x"), "remote:x");
  });
});
