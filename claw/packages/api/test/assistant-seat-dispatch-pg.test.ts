// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Handing tasks to seats (`assistant/seat-dispatch.ts`, the errand items of `remote-items.ts`) on a real Postgres with the production
 * schema. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   D1  a seat is a target only by its seat_id: an alias or a machine name is no seat; a turn answering no message of the user's hands
 *       nothing over, not even as a card; a list too long is no target
 *   D2  what goes without a card: a suggested seat is a card every time; a confirmed one the first time, and directly after that card
 *       was pressed; "confirm each" puts the card back; a key-sent message, a turn that read a machine's words, and an unattended
 *       agent are cards (and pressing the unattended one never makes it direct)
 *   D3  several seats are a choice card with options; a press must name one of them (else 400, nothing sent), a card without options
 *       takes none, a typed approval does not answer it, and the seat picked is the one sent to
 *   D4  one task at a time per seat: the rest queue in order with their place, at most three; the next goes when the running one ends;
 *       a queued task stopped leaves the queue
 *   D5  a conversation open in a terminal that someone used in the last ten minutes is not typed into; one quiet for ten is
 *   D6  a task waiting for its machine fails after a day, said once, and the router hears of it
 *   D7  a task's events and the session's own item never mix
 *   D8  a permission request is a needs_you notice naming the item and seat; a parked one is said once more, once
 *   D9  an older connector's approval timeout fails the task, saying how to send it again
 *   D10 a task running over an hour is said once an hour, with its latest step
 *   D11 a task's end wakes the router (no notice of its own); its failure is an error notice too
 *   D12 the prompt asks for parking only from a connector that can park
 *   D13 off: no seat target, and the router's seat section says seats are only shown
 *   D19 the sandbox picked on a choice card when it cannot start: nothing written for it, the task dropped, no task left in progress
 *   D20 one more instruction to a finished task, on a seat that asks first: the task is unchanged until the card is pressed; a no, a
 *       lapse and the sweep keep its result; a yes opens it again and sends; a second card pressed after that sends nothing
 *   D21 a finished task opened again whose instruction cannot be sent (its seat's queue full) is put back as it ended
 *   D22 the same words sent to a task twice in one router turn (at once, or one after the other) go once: one command to a running
 *       task, one reopening of a finished one, one card, one place in the queue; the second call answers that they were already sent;
 *       the next turn sends them again
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type Claims, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
type Recorded = Record<string, any>;

describe("seat dispatch", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";
  let store: typeof import("../src/remote-agents/store.js");
  let seats: typeof import("../src/assistant/seats.js");
  let dispatch: typeof import("../src/assistant/seat-dispatch.js");
  let schedules: typeof import("../src/assistant/schedules.js");
  let tools: typeof import("../src/assistant/tools.js");
  let inbound: typeof import("../src/assistant/inbound.js");
  let prompts: typeof import("../src/assistant/prompts.js");
  let role: typeof import("../src/assistant/role-profile.js");
  let protocol: typeof import("@claw/protocol");

  before(async () => {
    w = await startWorld({
      CLAW_REMOTE_AGENTS_ENABLED: "true", CLAW_ASSISTANT_TOOLS: "on", CLAW_ASSISTANT_ATTENDED_TTL_SEC: "600",
      CLAW_TRIGGERS_ENABLED: "true", CLAW_TRIGGER_TOOLS_ENABLED: "true", CLAW_TRIGGER_TOOLS_TOKEN_KEY: "trigger-tools-test-key-0123456789abcdef",
      CLAW_DEVENV_SEATS_USERS: "alice",
    });
    store = await import("../src/remote-agents/store.js");
    seats = await import("../src/assistant/seats.js");
    dispatch = await import("../src/assistant/seat-dispatch.js");
    schedules = await import("../src/assistant/schedules.js");
    tools = await import("../src/assistant/tools.js");
    inbound = await import("../src/assistant/inbound.js");
    prompts = await import("../src/assistant/prompts.js");
    role = await import("../src/assistant/role-profile.js");
    protocol = await import("@claw/protocol");
    const { registerRemoteAgentRoutes } = await import("../src/routes/remote-agents.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") return;
      (req as any).user = { userId: id, userName: id, platformKey: "", virtualKey: "", roles: ["default"] };
      (req as any).authMethod = "identity_token";
    });
    await registerRemoteAgentRoutes(app, { pingMs: 150, pollMs: 40, retentionDays: 0, undeliveredSweepMs: 0, presenceSweepMs: 0, deliverySweepMs: 0, seatSweepMs: 0 });
    const { registerAssistantProactiveRoutes } = await import("../src/routes/assistant-proactive.js");
    await registerAssistantProactiveRoutes(app, true, true, false, false);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  after(async () => {
    await app?.close();
    await w?.stop();
  });
  beforeEach(async () => {
    seats.seatDispatchSettings.on = true;
    await w.q(`TRUNCATE claw_devenv_seats, claw_remote_workspaces, claw_remote_events, claw_remote_commands, claw_remote_sessions, claw_remote_agents,
      claw_remote_connector_transitions, claw_remote_connectors, claw_remote_hidden, claw_remote_audit, claw_work_items, claw_work_item_events, claw_tasks,
      claw_assistants, claw_sessions, claw_assistant_messages, claw_assistant_says, claw_assistant_confirmations, claw_notification_outbox,
      claw_notification_subscriptions, claw_pending_messages CASCADE`);
  });

  async function http(method: string, user: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(base + path, {
      method, headers: { "x-test-user": user, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  const claude = (caps: Recorded = {}): Recorded => ({
    agent_id: "claude", kind: "claude", name: "Claude Code",
    capabilities: { roots: ["/home/u"], answer_only: true, ask_mode: "default", read_only_modes: ["plan"], unattended: false, ...caps },
  });
  async function machine(owner: string, name: string, agents: Recorded[] = [claude()]): Promise<string> {
    const row = await store.registerConnector(owner, name, "0.3.2", null, 10);
    assert.ok(row);
    await beat(owner, String(row.connector_id), agents);
    return String(row.connector_id);
  }
  async function beat(owner: string, cid: string, agents: Recorded[] = [claude()]): Promise<void> {
    const hb = protocol.parseHeartbeat({ version: "0.3.2", agents });
    assert.ok(hb.ok, JSON.stringify(hb));
    await store.recordHeartbeat(cid, owner, hb.value);
    await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW(), stream_seen_at = NOW() WHERE connector_id = $1", [cid]);
  }
  async function chatSession(owner: string, cid: string, cwd: string): Promise<string> {
    const r = await http("POST", owner, "/v1/remote-agents/sessions", { connector_id: cid, agent_id: "claude", cwd });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await w.q("DELETE FROM claw_remote_commands WHERE session_id = $1", [r.body.data.session_id]);
    return r.body.data.session_id;
  }
  /** A seat of alice's at `cwd` (with a session open there), as the user confirmed it, or as asked. */
  async function seat(cid: string, cwd: string, set: Recorded = { alias: null, role: "负责发布", role_state: "confirmed" }): Promise<{ seatId: string; sid: string }> {
    const sid = await chatSession("alice", cid, cwd);
    await seats.syncSeats("alice");
    const row = (await w.q("SELECT seat_id FROM claw_devenv_seats WHERE owner_user_id = 'alice' AND cwd = $1", [cwd]))[0];
    const cols = Object.keys(set);
    if (cols.length) {
      await w.q(`UPDATE claw_devenv_seats SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE seat_id = $1`, [row.seat_id, ...cols.map((c) => set[c])]);
    }
    return { seatId: String(row.seat_id), sid };
  }
  const seqs = new Map<string, number>();
  async function events(owner: string, cid: string, sid: string, list: Array<[string, Recorded]>): Promise<void> {
    const out = list.map(([type, data]) => {
      const n = (seqs.get(sid) ?? 0) + 1;
      seqs.set(sid, n);
      return { session_id: sid, seq: n, type, ts: Date.now(), data };
    });
    const r = await http("POST", owner, `/v1/remote-agents/connectors/${cid}/events`, { batch_id: `b${Math.random()}`, events: out });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const chunk = (text: string): [string, Recorded] => ["agent_message_chunk", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }];
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
  const refusal = async (p: Promise<unknown>): Promise<{ code: string; data?: Recorded }> => {
    try { await p; } catch (err) { return { code: String((err as { code?: string }).code ?? (err as Error).message), data: (err as { data?: Recorded }).data }; }
    assert.fail("not refused");
  };
  const press = (id: unknown, decision: "allow" | "deny" = "allow", choice?: string) =>
    schedules.decideConfirmation({ userId: "alice", confirmationId: String(id), decision, via: "button", ...(choice !== undefined ? { choice } : {}) });
  const create = (turn: Claims, target: unknown, title = "发布 1.2.1", brief = "按发布流程发 1.2.1", extra: Recorded = {}) =>
    dispatch.seatWorkCreate(turn, { title, brief, target, ...extra });
  /** The prompts queued for the machine, and the newest one's number. */
  const prompted = async (cid: string) => w.q(
    "SELECT cmd_seq, session_id::text AS session_id, payload FROM claw_remote_commands WHERE connector_id = $1 AND type = 'prompt' ORDER BY cmd_seq", [cid],
  );
  /** The connector collected everything queued (as its heartbeat acknowledges it). */
  const collect = async (cid: string) => store.pruneCommands((t, p) => w.h.app.db.db.query(t, p), cid, 1_000_000_000);
  const item = async (id: unknown) => (await w.q("SELECT * FROM claw_work_items WHERE item_id = $1", [String(id)]))[0];
  const notices = async () => (await w.q(
    `SELECT o.payload FROM claw_notification_outbox o JOIN claw_assistant_says s ON s.say_id::text = o.event_id WHERE s.user_id = 'alice' ORDER BY o.id`,
  )).map((r) => r.payload as Recorded).filter((p) => p.remote);
  const wakes = async (routerSid: string) => (await w.pending(routerSid)).map((m: Recorded) => String(m.content));

  test("D1 only a seat_id is a target; a turn answering no message of the user's hands nothing over; a list too long is none", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const { seatId } = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const turn = await userTurn(alice, "把发布交给发布台");
    for (const t of ["发布台", "seat:发布台", "devbox", "seat:devbox"]) {
      assert.equal((await refusal(create(turn, t))).code, "seat_not_found", t);
    }
    assert.equal((await refusal(create(turn, ["sandbox", `seat:${seatId}`, "seat:a", "seat:b", "seat:c", "seat:d"]))).code, "invalid_target");
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_work_items"))[0].n, 0, "nothing was made");
    // A wake (no message of the user's): refused, and no card either.
    const wake = await w.routerTurn(alice);
    assert.equal((await refusal(create(wake, `seat:${seatId}`))).code, "not_from_user");
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_confirmations"))[0].n, 0);
    assert.deepEqual(await prompted(cid), []);
  });

  test("D2 a suggested seat is a card every time; a confirmed one the first time, then directly; confirm_each brings the card back", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const sug = await seat(cid, "/home/u/docs", { role_state: "suggested" });
    for (let i = 0; i < 2; i += 1) {
      const out = await create(await userTurn(alice, "整理文档"), `seat:${sug.seatId}`, `整理文档 ${i}`);
      assert.deepEqual([out.dispatch, out.why_card], ["card", "suggested"], JSON.stringify(out));
    }
    assert.deepEqual(await prompted(cid), [], "nothing is sent for a card");
    const rel = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed" });
    const first = await create(await userTurn(alice, "让发布台发 1.2.1"), `seat:${rel.seatId}`);
    assert.deepEqual([first.dispatch, first.why_card, first.alias], ["card", "first_dispatch", "发布台"]);
    assert.equal((await item(first.item_id)).params.queued, "card");
    const pressed = await press(first.confirmation_id);
    assert.equal(pressed.status, "done", JSON.stringify(pressed));
    assert.equal(pressed.result?.dispatch, "sent", JSON.stringify(pressed));
    const p1 = await prompted(cid);
    assert.equal(p1.length, 1);
    assert.equal(p1[0].session_id, rel.sid, "into the seat's own idle session");
    assert.match(String(p1[0].payload.text), /^（你的助手 代你交代的任务，事项 #\d+。完成时用一段话总结：结果、改了什么、还剩什么。）\n\n按发布流程发 1.2.1$/);
    const s1 = (await w.q("SELECT dispatch_mode, auto_since FROM claw_devenv_seats WHERE seat_id = $1", [rel.seatId]))[0];
    assert.equal(s1.dispatch_mode, "auto");
    assert.ok(s1.auto_since);
    // Its turn ends: from now on a task goes to it directly.
    await collect(cid);
    await events("alice", cid, rel.sid, [chunk("done"), ["turn_end", { stopReason: "end_turn", cmd_seq: Number(p1[0].cmd_seq) }]]);
    const direct = await create(await userTurn(alice, "让发布台再发 1.2.2"), `seat:${rel.seatId}`, "发布 1.2.2");
    assert.equal(direct.dispatch, "sent", JSON.stringify(direct));
    await collect(cid);
    // A message that came with a key, and a turn that read a machine's words: cards.
    await events("alice", cid, rel.sid, [["turn_end", { stopReason: "end_turn", cmd_seq: Number((await w.q("SELECT (data->>'cmd_seq')::int AS s FROM claw_remote_events WHERE type = 'user_prompt' ORDER BY id DESC LIMIT 1"))[0].s) }]]);
    const keyed = await create(await userTurn(alice, "再发一次", false), `seat:${rel.seatId}`, "发布 1.2.3");
    assert.deepEqual([keyed.dispatch, keyed.why_card], ["card", "not_attended"]);
    const reader = await userTurn(alice, "看看机器然后发");
    await inbound.markUntrustedRead((t, p) => w.h.app.db.db.query(t, p), reader.sid, reader.mid);
    const read = await create(reader, `seat:${rel.seatId}`, "发布 1.2.4");
    assert.deepEqual([read.dispatch, read.why_card], ["card", "read_untrusted"]);
    // "每次都确认": a card again, at once, with no card for the setting itself.
    const set = await seats.seatSet(await userTurn(alice, "发布台每次都确认"), { seat: rel.seatId, confirm_each: true });
    assert.equal(set.confirm_each, true, JSON.stringify(set));
    const each = await create(await userTurn(alice, "让发布台发 1.2.5"), `seat:${rel.seatId}`, "发布 1.2.5");
    assert.deepEqual([each.dispatch, each.why_card], ["card", "confirm_each"]);
    // An unattended agent: a card, and pressing it never makes the seat direct.
    const cid2 = await machine("alice", "ci-box", [claude({ unattended: true })]);
    const bot = await seat(cid2, "/home/u/bot", { alias: "bot", role: "跑 CI", role_state: "confirmed" });
    const unat = await create(await userTurn(alice, "让 bot 跑一下"), `seat:${bot.seatId}`, "跑 CI");
    assert.deepEqual([unat.dispatch, unat.why_card], ["card", "first_dispatch"]);
    assert.equal((await press(unat.confirmation_id)).status, "done");
    assert.equal((await w.q("SELECT dispatch_mode FROM claw_devenv_seats WHERE seat_id = $1", [bot.seatId]))[0].dispatch_mode, "card");
    const card = (await w.q("SELECT params FROM claw_assistant_confirmations WHERE confirmation_id = $1", [unat.confirmation_id]))[0];
    assert.equal(card.params.why_card, "first_dispatch");
    // A card made while the agent asked, pressed after it turned unattended: nothing is sent, and the task is dropped.
    const cid3 = await machine("alice", "gpu-box");
    const gpu = await seat(cid3, "/home/u/gpu", { alias: "gpu", role: "跑训练", role_state: "confirmed" });
    const before = await create(await userTurn(alice, "让 gpu 跑"), `seat:${gpu.seatId}`, "跑训练");
    await beat("alice", cid3, [claude({ unattended: true })]);
    const late = await press(before.confirmation_id);
    assert.deepEqual([late.status, late.result?.error], ["failed", "seat_unattended"], JSON.stringify(late));
    assert.deepEqual(await prompted(cid3), []);
    assert.equal((await item(before.item_id)).outcome, "dropped");
  });

  test("D3 several seats are a choice card: a press must name one of its options, and that seat is the one sent to", async () => {
    const alice = await w.user("alice");
    await w.subscribe("alice");
    const cid = await machine("alice", "devbox");
    const a = await seat(cid, "/home/u/hl-ci", { alias: "hl-ci", role: "Hyperloom CI", role_state: "confirmed" });
    const b = await seat(cid, "/home/u/hl-ci2", { alias: "hl-ci2", role: "Hyperloom CI 2", role_state: "confirmed" });
    const out = await create(await userTurn(alice, "修一下 Hyperloom CI"), [`seat:${a.seatId}`, `seat:${b.seatId}`, "sandbox"], "修 CI");
    assert.deepEqual([out.dispatch, out.why_card], ["card", "choice"], JSON.stringify(out));
    assert.deepEqual(out.choices, [a.seatId, b.seatId, "sandbox"]);
    const say = (await w.q("SELECT o.payload FROM claw_notification_outbox o ORDER BY o.id DESC LIMIT 1"))[0].payload;
    assert.equal(say.confirm_write.kind, "seat_dispatch");
    assert.deepEqual(say.confirm_write.options.map((o: Recorded) => [o.id, o.label]), [[a.seatId, "hl-ci"], [b.seatId, "hl-ci2"], ["sandbox", "沙箱"]]);
    assert.equal(say.confirm_write.options[0].detail, "/home/u/hl-ci");
    // No choice, a choice it did not offer: 400 at the route, and nothing sent.
    const id = String(out.confirmation_id);
    for (const body of [{ decision: "allow" }, { decision: "allow", choice: "seat_nope" }]) {
      const r = await http("POST", "alice", `/v1/assistant/confirmations/${id}/decision`, body);
      assert.deepEqual([r.status, r.body.error], [400, "invalid_choice"], JSON.stringify(r.body));
    }
    assert.deepEqual(await prompted(cid), []);
    assert.equal((await w.q("SELECT status FROM claw_assistant_confirmations WHERE confirmation_id = $1", [id]))[0].status, "pending");
    // A card without options takes no choice.
    const single = await create(await userTurn(alice, "让 hl-ci 修"), `seat:${a.seatId}`, "修 CI 单");
    const r1 = await http("POST", "alice", `/v1/assistant/confirmations/${single.confirmation_id}/decision`, { decision: "allow", choice: a.seatId });
    assert.deepEqual([r1.status, r1.body.error], [400, "invalid_choice"]);
    // A typed approval does not answer a choice card.
    const typed = await userTurn(alice, `批准 #${out.ref}`);
    assert.equal((await refusal(schedules.scheduleConfirmationAnswer(typed, { decision: "allow" }))).code, "choice_card");
    // The second seat picked: sent there, and the item is that seat's.
    const r2 = await http("POST", "alice", `/v1/assistant/confirmations/${id}/decision`, { decision: "allow", choice: b.seatId });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.data.status, "done", JSON.stringify(r2.body));
    const sent = await prompted(cid);
    assert.deepEqual(sent.map((s) => s.session_id), [b.sid]);
    const it = await item(out.item_id);
    assert.deepEqual([it.params.seat_id, it.params.alias, it.params.queued], [b.seatId, "hl-ci2", undefined]);
    // The sandbox picked on another: the task becomes a worker's item under its own number.
    const other = await create(await userTurn(alice, "再修一个"), [`seat:${a.seatId}`, "sandbox"], "修 CI 沙箱");
    const toSandbox = await press(other.confirmation_id, "allow", "sandbox");
    assert.equal(toSandbox.status, "done", JSON.stringify(toSandbox));
    const sb = await item(other.item_id);
    assert.deepEqual([sb.kind, sb.seq], ["task", other.seq]);
    assert.equal((await w.pending(sb.worker_session_id)).length, 1);
    // Denied: dropped, nothing sent.
    const denied = await create(await userTurn(alice, "第三个"), [`seat:${a.seatId}`, `seat:${b.seatId}`], "修 CI 3");
    assert.equal((await press(denied.confirmation_id, "deny")).status, "denied");
    assert.deepEqual([(await item(denied.item_id)).board_state, (await item(denied.item_id)).outcome], ["done", "dropped"]);
  });

  test("D4 one task at a time per seat: the rest queue in order with their place, three at most; the next goes when the running one ends", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const rel = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const first = await create(await userTurn(alice, "发布 1"), `seat:${rel.seatId}`, "任务 1");
    assert.equal(first.dispatch, "sent");
    await collect(cid);
    const queued: Recorded[] = [];
    for (let i = 2; i <= 4; i += 1) queued.push(await create(await userTurn(alice, `发布 ${i}`), `seat:${rel.seatId}`, `任务 ${i}`));
    assert.deepEqual(queued.map((q) => [q.dispatch, q.queued_reason, q.position]), [["queued", "seat_busy", 2], ["queued", "seat_busy", 3], ["queued", "seat_busy", 4]]);
    assert.deepEqual(queued[2]!.ahead, [first.seq, queued[0]!.seq, queued[1]!.seq]);
    const full = await refusal(create(await userTurn(alice, "发布 5"), `seat:${rel.seatId}`, "任务 5"));
    assert.equal(full.code, "seat_queue_full");
    assert.deepEqual(full.data?.choices.slice(0, 2), ["wait", "sandbox"]);
    const roster = await seats.rosterOf("alice");
    assert.deepEqual([roster[0]!.state, roster[0]!.queue_len], ["working", 3]);
    // The second, stopped, leaves the queue; nothing was ever sent for it.
    await tools.workStop(await userTurn(alice, "第二个不要了"), { item_id: String(queued[0]!.item_id), reason: "not needed" });
    assert.equal((await item(queued[0]!.item_id)).outcome, "stopped");
    // The first ends: the third goes, into the same session.
    const sent1 = Number((await w.q("SELECT (data->>'cmd_seq')::int AS s FROM claw_remote_events WHERE type = 'user_prompt' ORDER BY id DESC LIMIT 1"))[0].s);
    await events("alice", cid, rel.sid, [chunk("ok"), ["turn_end", { stopReason: "end_turn", cmd_seq: sent1 }]]);
    assert.equal((await item(first.item_id)).board_state, "done");
    const next = await item(queued[1]!.item_id);
    assert.equal(next.params.queued, undefined, JSON.stringify(next.params));
    assert.equal(next.params.session_id, rel.sid);
    assert.equal((await item(queued[2]!.item_id)).params.queued, "seat_busy");
  });

  test("D5 a terminal someone used in the last ten minutes is not typed into; once quiet for ten minutes it is", async () => {
    const alice = await w.user("alice");
    const now = Math.floor(Date.now() / 1000);
    const attach = (updated: number, activity = "idle") => ({
      agent_id: "claude-sessions", kind: "attach", name: "Claude Code (existing sessions)",
      capabilities: { terminal_input: true, watch_live: true, resumable: [{ ref: "11111111-1111-4111-8111-111111111111", title: "rel", cwd: "/home/u/rel", updated_at: updated, state: "live", activity, input: "terminal" }] },
    });
    const cid = await machine("alice", "devbox", [claude(), attach(now)]);
    await seats.syncSeats("alice");
    const row = (await w.q("SELECT seat_id FROM claw_devenv_seats WHERE agent_id = 'claude' AND cwd = '/home/u/rel'"))[0]
      ?? (await w.q("SELECT seat_id FROM claw_devenv_seats WHERE cwd = '/home/u/rel'"))[0];
    await w.q("UPDATE claw_devenv_seats SET alias = '发布台', role = '负责发布', role_state = 'confirmed', dispatch_mode = 'auto' WHERE seat_id = $1", [row.seat_id]);
    const out = await create(await userTurn(alice, "发布"), `seat:${row.seat_id}`);
    assert.deepEqual([out.dispatch, out.queued_reason], ["queued", "in_terminal"], JSON.stringify(out));
    assert.equal((await seats.rosterOf("alice")).find((s) => s.seat_id === row.seat_id)!.state, "in_terminal");
    // Eleven minutes of quiet: the sweep types it into that terminal's conversation.
    await beat("alice", cid, [claude(), attach(now - 11 * 60)]);
    await dispatch.runErrandSweep("alice");
    const it = await item(out.item_id);
    assert.equal(it.params.queued, undefined, JSON.stringify(it.params));
    assert.ok(it.params.session_id);
    const opened = (await w.q("SELECT payload FROM claw_remote_commands WHERE connector_id = $1 AND type = 'session.new'", [cid]))[0];
    assert.equal(opened?.payload?.resume_ref, "11111111-1111-4111-8111-111111111111", JSON.stringify(opened));
  });

  test("D6 a task waiting for its machine fails after a day, said once, and the router hears of it", async () => {
    const alice = await w.user("alice");
    await w.subscribe("alice");
    const cid = await machine("alice", "laptop");
    const s = await seat(cid, "/home/u/notes", { alias: "notes", role: "笔记", role_state: "confirmed", dispatch_mode: "auto" });
    await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '2 hours', stream_seen_at = NULL WHERE connector_id = $1", [cid]);
    const out = await create(await userTurn(alice, "让 notes 整理"), `seat:${s.seatId}`, "整理笔记");
    assert.deepEqual([out.dispatch, out.queued_reason], ["queued", "machine_offline"]);
    const exp = Date.parse((await item(out.item_id)).params.queue_expires_at);
    assert.ok(Math.abs(exp - (Date.now() + 24 * 3600_000)) < 60_000);
    await dispatch.runErrandSweep("alice");
    assert.equal((await item(out.item_id)).params.queued, "machine_offline", "still waiting within the day");
    await w.q("UPDATE claw_work_items SET params = params || '{\"queue_expires_at\": \"2020-01-01T00:00:00Z\"}'::jsonb WHERE item_id = $1", [out.item_id]);
    await dispatch.runErrandSweep("alice");
    await dispatch.runErrandSweep("alice");
    const it = await item(out.item_id);
    assert.deepEqual([it.board_state, it.last_report_kind, it.params.queued], ["needs_you", "failed", undefined]);
    const told = (await notices()).filter((n) => n.remote.item_seq === out.seq);
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.equal(told[0]!.remote.kind, "error");
    assert.match(told[0]!.text, /机器 24 小时没上线/);
    assert.ok((await wakes(alice.routerSid)).some((m) => m.includes(`#${out.seq}`)), "the router is woken");
  });

  test("D7 a task's events and the session's own item never mix", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const out = await create(await userTurn(alice, "发布"), `seat:${s.seatId}`);
    assert.equal(out.dispatch, "sent");
    const errandSeq = Number((await prompted(cid))[0].cmd_seq);
    await collect(cid);
    // The user types into the attached chat: the session's own item.
    const typed = await http("POST", "alice", `/v1/remote-agents/sessions/${s.sid}/commands`, { type: "prompt", text: "顺便看下日志" });
    assert.equal(typed.status, 202, JSON.stringify(typed.body));
    const chatSeq = Number((await prompted(cid))[0].cmd_seq);
    const own = async () => (await w.q("SELECT * FROM claw_work_items WHERE worker_session_id = $1", [`remote:${s.sid}`]))[0];
    assert.equal((await own()).board_state, "in_progress");
    await events("alice", cid, s.sid, [chunk("released"), ["turn_end", { stopReason: "end_turn", cmd_seq: errandSeq }]]);
    assert.equal((await item(out.item_id)).board_state, "done", "the task ends with its own turn");
    assert.equal((await own()).board_state, "in_progress", "the session's item is untouched");
    await events("alice", cid, s.sid, [["permissionRequest", { actionId: "a1", tool: "tail log", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], cmd_seq: chatSeq }]]);
    assert.equal((await own()).board_state, "needs_you");
    assert.equal((await item(out.item_id)).board_state, "done");
    await events("alice", cid, s.sid, [["permission_resolved", { actionId: "a1", by: "phone" }], chunk("log ok"), ["turn_end", { stopReason: "end_turn", cmd_seq: chatSeq }]]);
    assert.equal((await own()).board_state, "done");
    const errand = await item(out.item_id);
    assert.equal(errand.outcome, "answered");
    assert.match(errand.summary, /released/);
  });

  test("D8 a permission request is a needs_you notice naming the item and seat; a parked one is said once more, once", async () => {
    const alice = await w.user("alice");
    await w.subscribe("alice");
    const cid = await machine("alice", "devbox", [claude({ permission_park: true })]);
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const out = await create(await userTurn(alice, "发布"), `seat:${s.seatId}`);
    const seq = Number((await prompted(cid))[0].cmd_seq);
    await collect(cid);
    const req = ["permissionRequest", { actionId: "act-1", tool: "git push", kind: "execute", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], timeout_ms: 600_000, cmd_seq: seq }] as [string, Recorded];
    await events("alice", cid, s.sid, [req]);
    let told = await notices();
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.deepEqual([told[0]!.remote.kind, told[0]!.remote.item_seq, told[0]!.remote.seat], ["needs_you", out.seq, { seat_id: s.seatId, alias: "发布台" }]);
    assert.equal(told[0]!.remote.ask.action_id, "act-1");
    assert.match(told[0]!.text, new RegExp(`^#${out.seq} 发布台 在等你批准：git push`));
    assert.equal((await item(out.item_id)).board_state, "needs_you");
    const until = new Date(Date.now() + 24 * 3600_000).toISOString();
    await events("alice", cid, s.sid, [["permission_parked", { actionId: "act-1", cmd_seq: seq, parked_until: until }]]);
    await events("alice", cid, s.sid, [["permission_parked", { actionId: "act-1", cmd_seq: seq, parked_until: until }]]);
    told = await notices();
    assert.equal(told.length, 2, JSON.stringify(told.map((t) => t.text)));
    assert.deepEqual([told[1]!.remote.kind, told[1]!.remote.ask.parked, told[1]!.remote.ask.expires_at], ["needs_you", true, until]);
    assert.match(told[1]!.text, /还在等你批准/);
    assert.equal((await item(out.item_id)).board_state, "needs_you", "still waiting for the user");
    await events("alice", cid, s.sid, [["permission_resolved", { actionId: "act-1", by: "phone" }]]);
    assert.equal((await item(out.item_id)).board_state, "in_progress");
    // A park that ends unanswered fails it.
    await events("alice", cid, s.sid, [["permissionRequest", { ...req[1], actionId: "act-2" }], ["permission_resolved", { actionId: "act-2", by: "park_expired", cmd_seq: seq }]]);
    const it = await item(out.item_id);
    assert.deepEqual([it.board_state, it.last_report_kind], ["needs_you", "failed"]);
  });

  test("D9 an older connector's approval timeout fails the task, saying how to send it again", async () => {
    const alice = await w.user("alice");
    await w.subscribe("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const out = await create(await userTurn(alice, "发布"), `seat:${s.seatId}`);
    assert.equal((await prompted(cid))[0].payload.park_permissions, undefined, "no parking asked of a connector that cannot");
    await collect(cid);
    // (0.3.1 and older: no cmd_seq on a permission request)
    await events("alice", cid, s.sid, [["permissionRequest", { actionId: "x", tool: "rm build", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }],
      ["permission_resolved", { actionId: "x", by: "timeout" }]]);
    const it = await item(out.item_id);
    assert.deepEqual([it.board_state, it.last_report_kind], ["needs_you", "failed"]);
    const err = (await notices()).find((n) => n.remote.kind === "error");
    assert.ok(err, "an error notice");
    assert.match(err!.text, new RegExp(`^#${out.seq} 发布台 没有做完：因审批超时停了。回复“继续”重发`));
    assert.ok((await wakes(alice.routerSid)).some((m) => m.includes(`#${out.seq}`)));
    // The turn then ends on the machine (the agent was refused); "继续": sent again into its seat, the same item.
    await events("alice", cid, s.sid, [["turn_end", { stopReason: "end_turn" }]]);
    assert.deepEqual([(await item(out.item_id)).board_state, (await item(out.item_id)).last_report_kind], ["needs_you", "failed"], "a late end changes nothing");
    const again = await tools.workSend(await userTurn(alice, "继续"), { item_id: String(out.item_id), text: "继续" }) as Recorded;
    assert.equal(again.dispatch, "sent", JSON.stringify(again));
    assert.equal((await item(out.item_id)).board_state, "in_progress");
  });

  test("D10 a task running over an hour is said once an hour, with its latest step", async () => {
    const alice = await w.user("alice");
    await w.subscribe("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const out = await create(await userTurn(alice, "发布"), `seat:${s.seatId}`);
    await collect(cid);
    const plan = (done: number): [string, Recorded] => ["plan", { update: { sessionUpdate: "plan", entries: [
      { content: "build", status: done > 0 ? "completed" : "in_progress" }, { content: "tag\u0007 release", status: done > 1 ? "completed" : "pending" }, { content: "publish", status: "pending" },
    ] } }];
    await events("alice", cid, s.sid, [plan(1)]);
    assert.deepEqual((await item(out.item_id)).params.progress.current, "tag release");
    await dispatch.runErrandSweep("alice");
    assert.equal((await notices()).filter((n) => n.remote.kind === "progress").length, 0, "nothing within the first hour");
    await w.q("UPDATE claw_work_items SET params = params || jsonb_build_object('dispatched_at', (NOW() - interval '2 hours 5 minutes')::text) WHERE item_id = $1", [out.item_id]);
    await dispatch.runErrandSweep("alice");
    await dispatch.runErrandSweep("alice");
    let progress = (await notices()).filter((n) => n.remote.kind === "progress");
    assert.equal(progress.length, 1);
    assert.equal(progress[0]!.text, `#${out.seq} 发布台 已进行 2 小时：“tag release”（1/3）`);
    await events("alice", cid, s.sid, [plan(2)]);
    await w.q("UPDATE claw_work_items SET params = params || jsonb_build_object('dispatched_at', (NOW() - interval '3 hours 1 minute')::text) WHERE item_id = $1", [out.item_id]);
    await dispatch.runErrandSweep("alice");
    progress = (await notices()).filter((n) => n.remote.kind === "progress");
    assert.equal(progress.length, 2);
    assert.equal(progress[1]!.text, `#${out.seq} 发布台 已进行 3 小时：“publish”（2/3）`);
    // In the item list, as quoted data.
    const line = prompts.formatManifestLine((await role.routerManifest("alice")).find((m) => m.itemId === out.item_id)!);
    assert.match(line, /step: "publish" \(2\/3\)/);
  });

  test("D11 a task's end wakes the router and says nothing of its own; a failure is an error notice too", async () => {
    const alice = await w.user("alice");
    await w.subscribe("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const out = await create(await userTurn(alice, "发布"), `seat:${s.seatId}`);
    const seq = Number((await prompted(cid))[0].cmd_seq);
    await collect(cid);
    await events("alice", cid, s.sid, [chunk("发布完成：1.2.1 已打 tag。"), ["turn_end", { stopReason: "end_turn", cmd_seq: seq }]]);
    await events("alice", cid, s.sid, [["turn_end", { stopReason: "end_turn", cmd_seq: seq }]]);
    const it = await item(out.item_id);
    assert.deepEqual([it.board_state, it.outcome, it.last_report_kind], ["done", "answered", "answer"]);
    assert.equal(it.params.report_due, undefined);
    assert.deepEqual(await notices(), [], "no done notice: the router says it");
    const woke = await wakes(alice.routerSid);
    assert.equal(woke.filter((m) => m.includes(`#${out.seq}`)).length, 1, JSON.stringify(woke));
    assert.match(woke[0]!, /发布完成/);
    // A failed turn: an error notice, and the router is woken too.
    const two = await create(await userTurn(alice, "再发"), `seat:${s.seatId}`, "发布 2");
    const seq2 = Number((await prompted(cid))[0].cmd_seq);
    await collect(cid);
    await events("alice", cid, s.sid, [["turn_end", { stopReason: "error", error: "rate_limit", cmd_seq: seq2 }]]);
    const errs = (await notices()).filter((n) => n.remote.kind === "error");
    assert.equal(errs.length, 1);
    assert.equal(errs[0]!.remote.item_seq, two.seq);
    // Stopped in its terminal: closed as stopped, said by nobody.
    const three = await create(await userTurn(alice, "第三次"), `seat:${s.seatId}`, "发布 3");
    const seq3 = Number((await prompted(cid))[0].cmd_seq);
    await collect(cid);
    await events("alice", cid, s.sid, [["turn_end", { stopReason: "cancelled", cmd_seq: seq3 }]]);
    const t3 = await item(three.item_id);
    assert.deepEqual([t3.board_state, t3.outcome, t3.summary], ["done", "stopped", "在终端里停止"]);
    assert.equal((await notices()).length, 1);
  });

  test("D14 asks across seats: five a minute one by one, then one line; a machine offline over an hour under a task is said once", async () => {
    const alice = await w.user("alice");
    await w.subscribe("alice");
    const cid = await machine("alice", "devbox");
    const made: Array<{ sid: string; seq: number; cmd: number; item: string }> = [];
    for (let i = 0; i < 7; i += 1) {
      const s = await seat(cid, `/home/u/w${i}`, { alias: `w${i}`, role: "工作", role_state: "confirmed", dispatch_mode: "auto" });
      const out = await create(await userTurn(alice, `任务 ${i}`), `seat:${s.seatId}`, `任务 ${i}`);
      assert.equal(out.dispatch, "sent", JSON.stringify(out));
      made.push({ sid: s.sid, seq: Number(out.seq), cmd: Number((await prompted(cid)).at(-1)!.cmd_seq), item: String(out.item_id) });
    }
    await collect(cid);
    for (const [i, m] of made.entries()) {
      await events("alice", cid, m.sid, [["permissionRequest", { actionId: `a${i}`, tool: `step ${i}`, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], cmd_seq: m.cmd }]]);
    }
    const told = (await notices()).filter((n) => n.remote.kind === "needs_you");
    assert.equal(told.filter((n) => n.remote.ask).length, 5, "five asks one by one");
    const lines = told.filter((n) => !n.remote.ask);
    assert.equal(lines.length, 1, JSON.stringify(told.map((t) => t.text)));
    assert.match(lines[0]!.text, /个交给工位的事项在等你批准/);
    for (const m of made) assert.equal((await item(m.item)).board_state, "needs_you", "every one waits for the user all the same");
    // The machine goes away for over an hour: said once, not every sweep, and no hourly line while it is away.
    await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '2 hours', stream_seen_at = NULL WHERE connector_id = $1", [cid]);
    await w.q("UPDATE claw_work_items SET params = params || jsonb_build_object('dispatched_at', (NOW() - interval '3 hours')::text) WHERE item_id = $1", [made[0]!.item]);
    await dispatch.runErrandSweep("alice");
    await dispatch.runErrandSweep("alice");
    const away = (await notices()).filter((n) => n.remote.item_seq === made[0]!.seq && n.remote.kind === "progress");
    assert.equal(away.length, 1, JSON.stringify(away.map((a) => a.text)));
    assert.match(away[0]!.text, /离线超过 1 小时/);
  });

  test("D15 what was let through is checked again as a task leaves the queue; a card says whether its press makes the seat direct", async () => {
    const alice = await w.user("alice");
    await w.subscribe("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const first = await create(await userTurn(alice, "发布 1"), `seat:${s.seatId}`, "任务 1");
    const seq1 = Number((await prompted(cid))[0].cmd_seq);
    await collect(cid);
    const second = await create(await userTurn(alice, "发布 2"), `seat:${s.seatId}`, "任务 2");
    assert.equal(second.dispatch, "queued");
    // The user asks for a card each time while it waits: it is not sent when the seat frees, and they are told how to send it.
    await seats.seatSet(await userTurn(alice, "发布台每次都确认"), { seat: s.seatId, confirm_each: true });
    await events("alice", cid, s.sid, [["turn_end", { stopReason: "end_turn", cmd_seq: seq1 }]]);
    assert.deepEqual(await prompted(cid), [], "nothing sent");
    const it = await item(second.item_id);
    assert.deepEqual([it.board_state, it.last_report_kind, it.params.queued], ["needs_you", "failed", undefined]);
    assert.match((await notices()).find((n) => n.remote.item_seq === second.seq)!.text, /要先确认/);
    assert.equal((await item(first.item_id)).board_state, "done");
    // A card made while the agent ran unattended says nothing of going direct; pressed once it asks again, it sends but makes nothing direct.
    const cid2 = await machine("alice", "ci-box", [claude({ unattended: true })]);
    const bot = await seat(cid2, "/home/u/bot", { alias: "bot", role: "跑 CI", role_state: "confirmed" });
    const card = await create(await userTurn(alice, "让 bot 跑"), `seat:${bot.seatId}`, "跑 CI");
    await beat("alice", cid2, [claude()]);
    assert.equal((await press(card.confirmation_id)).status, "done");
    assert.equal((await prompted(cid2)).length, 1);
    assert.equal((await w.q("SELECT dispatch_mode FROM claw_devenv_seats WHERE seat_id = $1", [bot.seatId]))[0].dispatch_mode, "card");
  });

  test("D16 two tasks with one title are two tasks; a cancel that ends nothing is no task's end; an instruction right after an end loses neither answer", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const a = await create(await userTurn(alice, "修测试 A"), `seat:${s.seatId}`, "修测试", "修 A 的测试");
    const seqA = Number((await prompted(cid))[0].cmd_seq);
    const b = await create(await userTurn(alice, "修测试 B"), `seat:${s.seatId}`, "修测试", "修 B 的测试");
    assert.notEqual(a.item_id, b.item_id);
    assert.equal(b.dispatch, "queued");
    await collect(cid);
    // The end a cancel brings when nothing ran names no prompt (cmd_seq: null): no task's.
    await events("alice", cid, s.sid, [["turn_end", { stopReason: "cancelled", cmd_seq: null }]]);
    assert.deepEqual((await item(a.item_id)).params.open_cmd_seqs, [seqA]);
    assert.equal((await item(a.item_id)).board_state, "in_progress");
    // Its end applied but not yet reported, and one more instruction lands then: the first answer is reported, the item opened again.
    await w.q("UPDATE claw_work_items SET params = params || jsonb_build_object('open_cmd_seqs', '[]'::jsonb, 'report_due', jsonb_build_object('kind', 'answer', 'summary', '第一段回答', 'generation', generation)) WHERE item_id = $1", [a.item_id]);
    const gen = Number((await item(a.item_id)).generation);
    const tools = await import("../src/assistant/devenv-tools.js");
    const sent = await tools.executeSend("alice", {
      connector_id: cid, machine: "devbox", agent_id: "claude", agent_name: null, session_id: s.sid, resume_ref: null, cwd: "/home/u/rel", label: "x",
    }, "再补一个用例", "errand-test-followup", "zh", undefined, { errandItemId: String(a.item_id), queueBehind: true });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const after = await item(a.item_id);
    assert.deepEqual([after.board_state, Number(after.generation), after.params.report_due], ["in_progress", gen + 1, undefined]);
    assert.ok((await wakes(alice.routerSid)).some((m) => m.includes("第一段回答")), "the first answer reached the router");
    const seqF = Number((await prompted(cid)).at(-1)!.cmd_seq);
    await collect(cid);
    await events("alice", cid, s.sid, [chunk("第二段回答"), ["turn_end", { stopReason: "end_turn", cmd_seq: seqF }]]);
    assert.equal((await item(a.item_id)).board_state, "done");
    assert.ok((await wakes(alice.routerSid)).some((m) => m.includes("第二段回答")), "and the second");
  });

  test("D17 one more instruction to a running task passes the same gate: a card once the seat asks for one, sent when pressed", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const out = await create(await userTurn(alice, "发布"), `seat:${s.seatId}`);
    await collect(cid);
    const direct = await tools.workSend(await userTurn(alice, "顺便更新 changelog"), { item_id: String(out.item_id), text: "顺便更新 changelog" }) as Recorded;
    assert.equal(direct.dispatch, "sent", JSON.stringify(direct));
    assert.equal((await item(out.item_id)).params.open_cmd_seqs.length, 2, "queued behind the turn under way, the task's own");
    await collect(cid);
    await seats.seatSet(await userTurn(alice, "发布台每次都确认"), { seat: s.seatId, confirm_each: true });
    const carded = await tools.workSend(await userTurn(alice, "再打个 tag"), { item_id: String(out.item_id), text: "再打个 tag" }) as Recorded;
    assert.deepEqual([carded.dispatch, carded.why_card], ["card", "confirm_each"]);
    assert.deepEqual(await prompted(cid), [], "nothing sent for the card");
    const pressed = await press(carded.confirmation_id);
    assert.equal(pressed.result?.dispatch, "sent", JSON.stringify(pressed));
    assert.equal((await item(out.item_id)).params.open_cmd_seqs.length, 3);
    // A wake hands nothing more over.
    assert.equal((await refusal(tools.workSend(await w.routerTurn(alice), { item_id: String(out.item_id), text: "x" }))).code, "not_from_user");
  });

  test("D18 an end reported as the next instruction lands, with a router that cannot be woken, is still said to the user", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const out = await create(await userTurn(alice, "发布"), `seat:${s.seatId}`);
    await collect(cid);
    await w.q("UPDATE claw_work_items SET params = params || jsonb_build_object('open_cmd_seqs', '[]'::jsonb, 'report_due', jsonb_build_object('kind', 'answer', 'summary', '发布完成', 'generation', generation)) WHERE item_id = $1", [out.item_id]);
    // The router session holds no credentials now (made again after a delete, before the user's next message): its wake is refused.
    await w.q("UPDATE claw_sessions SET config = '{}'::jsonb WHERE session_id = $1", [alice.routerSid]);
    const tools = await import("../src/assistant/devenv-tools.js");
    const sent = await tools.executeSend("alice", {
      connector_id: cid, machine: "devbox", agent_id: "claude", agent_name: null, session_id: s.sid, resume_ref: null, cwd: "/home/u/rel", label: "x",
    }, "再补一个", "errand-test-unwoken", "zh", undefined, { errandItemId: String(out.item_id), queueBehind: true });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const said = await w.q("SELECT text FROM claw_assistant_says WHERE user_id = 'alice' AND item_id = $1", [out.item_id]);
    assert.ok(said.some((r) => String(r.text).includes("发布完成")), JSON.stringify(said));
    assert.equal((await item(out.item_id)).board_state, "in_progress");
  });

  test("D18 an end reported as the next instruction lands, after the user deleted their assistant session, is still said to the user", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const out = await create(await userTurn(alice, "发布"), `seat:${s.seatId}`);
    await collect(cid);
    await w.q("UPDATE claw_work_items SET params = params || jsonb_build_object('open_cmd_seqs', '[]'::jsonb, 'report_due', jsonb_build_object('kind', 'answer', 'summary', '发布完成', 'generation', generation)) WHERE item_id = $1", [out.item_id]);
    // The user deleted the assistant's session: nobody would read it, and no sweep says a seat task's answer later.
    await w.q("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = $1", [alice.routerSid]);
    const tools = await import("../src/assistant/devenv-tools.js");
    const sent = await tools.executeSend("alice", {
      connector_id: cid, machine: "devbox", agent_id: "claude", agent_name: null, session_id: s.sid, resume_ref: null, cwd: "/home/u/rel", label: "x",
    }, "再补一个", "errand-test-deleted", "zh", undefined, { errandItemId: String(out.item_id), queueBehind: true });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const now = (await w.q("SELECT session_id FROM claw_assistants WHERE user_id = 'alice'"))[0]?.session_id;
    assert.ok(now && now !== alice.routerSid, "the assistant has a session again");
    const said = await w.q("SELECT text FROM claw_assistant_says WHERE user_id = 'alice' AND item_id = $1", [out.item_id]);
    const woke = await w.q("SELECT content FROM claw_pending_messages WHERE session_id = $1", [now]);
    assert.ok(said.some((r) => String(r.text).includes("发布完成")) || woke.some((r) => String(r.content).includes("发布完成")),
      JSON.stringify({ said, woke }));
    assert.equal((await item(out.item_id)).board_state, "in_progress");
  });

  test("D18 a failed end reported as the next instruction lands, after the user deleted their assistant session, is still said", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const out = await create(await userTurn(alice, "发布"), `seat:${s.seatId}`);
    await collect(cid);
    await w.q("UPDATE claw_work_items SET params = params || jsonb_build_object('open_cmd_seqs', '[]'::jsonb, 'report_due', jsonb_build_object('kind', 'failed', 'summary', '机器拒绝了这条指令', 'generation', generation)) WHERE item_id = $1", [out.item_id]);
    await w.q("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = $1", [alice.routerSid]);
    const tools = await import("../src/assistant/devenv-tools.js");
    const sent = await tools.executeSend("alice", {
      connector_id: cid, machine: "devbox", agent_id: "claude", agent_name: null, session_id: s.sid, resume_ref: null, cwd: "/home/u/rel", label: "x",
    }, "再试一次", "errand-test-deleted-failed", "zh", undefined, { errandItemId: String(out.item_id), queueBehind: true });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const now = (await w.q("SELECT session_id FROM claw_assistants WHERE user_id = 'alice'"))[0]?.session_id;
    assert.ok(now && now !== alice.routerSid, "the assistant has a session again");
    const said = await w.q("SELECT text FROM claw_assistant_says WHERE user_id = 'alice' AND text LIKE '%机器拒绝了这条指令%'");
    assert.equal(said.length, 1, JSON.stringify(said));
  });

  test("D19 the sandbox picked when it cannot start: nothing is written for it, the task is dropped, no task is left in progress", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const a = await seat(cid, "/home/u/hl-ci", { alias: "hl-ci", role: "Hyperloom CI", role_state: "confirmed" });
    const out = await create(await userTurn(alice, "修一下 CI"), [`seat:${a.seatId}`, "sandbox"], "修 CI 沙箱");
    assert.equal(out.dispatch, "card", JSON.stringify(out));
    // No key of the user's reached Claw: the worker's first message cannot be queued.
    await w.q("UPDATE claw_sessions SET config = config - 'platform_key' - 'llm_api_key' - '_server_managed_credentials' WHERE session_id = $1", [alice.routerSid]);
    const sessionsBefore = (await w.q("SELECT COUNT(*)::int AS n FROM claw_sessions"))[0].n;
    const pressed = await press(out.confirmation_id, "allow", "sandbox");
    assert.deepEqual([pressed.status, pressed.result?.error], ["failed", "no_credentials"], JSON.stringify(pressed));
    const it = await item(out.item_id);
    assert.deepEqual([it.kind, it.board_state, it.outcome], ["remote", "done", "dropped"], "not left as a task in progress");
    assert.equal(it.params.brief, "按发布流程发 1.2.1", "its brief is kept");
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_sessions"))[0].n, sessionsBefore, "no worker session was made");
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_work_items WHERE board_state <> 'done'"))[0].n, 0, "no item holds a slot");
  });

  /** A task of the seat's that ran and finished with an answer. */
  async function finished(alice: { routerSid: string; userId: string }, cid: string, s: { seatId: string; sid: string }, title: string): Promise<Recorded> {
    const out = await create(await userTurn(alice, title), `seat:${s.seatId}`, title);
    assert.equal(out.dispatch, "sent", JSON.stringify(out));
    const seq = Number((await prompted(cid)).at(-1)!.cmd_seq);
    await collect(cid);
    await events("alice", cid, s.sid, [chunk(`${title} 完成了`), ["turn_end", { stopReason: "end_turn", cmd_seq: seq }]]);
    const it = await item(out.item_id);
    assert.equal(it.board_state, "done", JSON.stringify(it));
    return it;
  }
  const ended = (it: Recorded) => [it.board_state, it.outcome, it.summary, String(it.closed_at), Number(it.generation), it.params.brief];

  test("D20 one more instruction to a finished task on a seat that asks first: nothing changes until the card is pressed; a no or a lapse keeps its result", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const done = await finished(alice, cid, s, "发布 1.2.1");
    const was = ended(done);
    await seats.seatSet(await userTurn(alice, "发布台每次都确认"), { seat: s.seatId, confirm_each: true });
    const carded = await tools.workSend(await userTurn(alice, "再打个 tag"), { item_id: String(done.item_id), text: "再打个 tag" }) as Recorded;
    assert.deepEqual([carded.dispatch, carded.why_card], ["card", "confirm_each"], JSON.stringify(carded));
    assert.deepEqual(ended(await item(done.item_id)), was, "the card alone changes nothing");
    // No: the finished task stays as it was, its answer and all.
    const no = await press(carded.confirmation_id, "deny");
    assert.equal(no.status, "denied", JSON.stringify(no));
    assert.deepEqual(ended(await item(done.item_id)), was);
    assert.notEqual((await item(done.item_id)).outcome, "dropped");
    // A card left to lapse, and the sweep after it: still as it was.
    const lapsing = await tools.workSend(await userTurn(alice, "再打个 tag 吧"), { item_id: String(done.item_id), text: "再打个 tag 吧" }) as Recorded;
    await w.q("UPDATE claw_assistant_confirmations SET expires_at = NOW() - INTERVAL '1 second' WHERE confirmation_id = $1", [lapsing.confirmation_id]);
    assert.equal((await press(lapsing.confirmation_id)).status, "expired");
    await dispatch.runErrandSweep("alice");
    assert.deepEqual(ended(await item(done.item_id)), was);
    assert.deepEqual(await prompted(cid), [], "nothing more was sent");
    // Two cards for it: the first pressed opens it again and sends; the second, pressed after, is for a task that changed.
    const one = await tools.workSend(await userTurn(alice, "打 tag v1"), { item_id: String(done.item_id), text: "打 tag v1" }) as Recorded;
    const two = await tools.workSend(await userTurn(alice, "打 tag v2"), { item_id: String(done.item_id), text: "打 tag v2" }) as Recorded;
    const yes = await press(one.confirmation_id);
    assert.deepEqual([yes.status, yes.result?.dispatch], ["done", "sent"], JSON.stringify(yes));
    const open = await item(done.item_id);
    assert.deepEqual([open.board_state, open.outcome, Number(open.generation), open.params.brief, open.params.approved], ["in_progress", null, was[4] as number + 1, "打 tag v1", "card"]);
    const sent = await prompted(cid);
    assert.equal(sent.length, 1);
    assert.match(String(sent[0].payload.text), /打 tag v1$/);
    const stale = await press(two.confirmation_id);
    assert.deepEqual([stale.status, stale.result?.error], ["failed", "item_changed"], JSON.stringify(stale));
    assert.equal((await prompted(cid)).length, 1, "the second card sent nothing");
  });

  test("D21 a finished task opened again whose instruction cannot be sent is put back as it ended", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const done = await finished(alice, cid, s, "发布 1.2.1");
    const was = ended(done);
    // The seat busy with one task and three waiting: its queue is full.
    assert.equal((await create(await userTurn(alice, "任务 1"), `seat:${s.seatId}`, "任务 1")).dispatch, "sent");
    for (let i = 2; i <= 4; i += 1) assert.equal((await create(await userTurn(alice, `任务 ${i}`), `seat:${s.seatId}`, `任务 ${i}`)).dispatch, "queued");
    const full = await refusal(tools.workSend(await userTurn(alice, "再打个 tag"), { item_id: String(done.item_id), text: "再打个 tag" }));
    assert.equal(full.code, "seat_queue_full");
    const back = await item(done.item_id);
    assert.deepEqual(ended(back).filter((_, i) => i !== 4), was.filter((_, i) => i !== 4), "its end, answer and brief are back");
    assert.equal(back.params.queued, undefined);
  });

  test("D22 the same words to a task twice in one turn go once, and the second call says they were already sent", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    const send = (turn: Claims, id: unknown, text: string) => tools.workSend(turn, { item_id: String(id), text }) as Promise<Recorded>;
    // Running: two calls at once, then a third after them, in one turn: one command to the machine.
    const out = await create(await userTurn(alice, "发布"), `seat:${s.seatId}`);
    await collect(cid);
    const turn = await userTurn(alice, "顺便更新 changelog");
    const both = await Promise.all([send(turn, out.item_id, "顺便更新 changelog"), send(turn, out.item_id, "顺便更新  changelog ")]);
    assert.deepEqual(both.map((r) => r.dispatch).sort(), ["already_sent", "sent"], JSON.stringify(both));
    assert.equal((await send(turn, out.item_id, "顺便更新 changelog")).dispatch, "already_sent");
    assert.equal((await prompted(cid)).length, 1, "one command reached the machine");
    assert.equal((await item(out.item_id)).params.open_cmd_seqs.length, 2);
    // Other words in the same turn, and the same words in the next turn, are sent.
    assert.equal((await send(turn, out.item_id, "再跑一次测试")).dispatch, "sent");
    assert.equal((await send(await userTurn(alice, "顺便更新 changelog"), out.item_id, "顺便更新 changelog")).dispatch, "sent");
    assert.equal((await prompted(cid)).length, 3);

    // Finished: opened again once and sent once.
    const cid2 = await machine("alice", "devbox2");
    const s2 = await seat(cid2, "/home/u/docs", { alias: "文档台", role: "负责文档", role_state: "confirmed", dispatch_mode: "auto" });
    const done = await finished(alice, cid2, s2, "整理文档");
    const gen = Number(done.generation);
    const again = await userTurn(alice, "再补一节");
    const reopened = await Promise.all([send(again, done.item_id, "再补一节"), send(again, done.item_id, "再补一节")]);
    assert.deepEqual(reopened.map((r) => r.dispatch).sort(), ["already_sent", "sent"], JSON.stringify(reopened));
    const open = await item(done.item_id);
    assert.deepEqual([open.board_state, Number(open.generation), open.params.open_cmd_seqs.length], ["in_progress", gen + 1, 1]);
    assert.equal((await prompted(cid2)).length, 1, "the finished task's machine got one command");

    // A seat that asks first: one card, and pressing it sends once.
    await collect(cid);
    await seats.seatSet(await userTurn(alice, "发布台每次都确认"), { seat: s.seatId, confirm_each: true });
    const carded = await userTurn(alice, "再打个 tag");
    const cards = await Promise.all([send(carded, out.item_id, "再打个 tag"), send(carded, out.item_id, "再打个 tag")]);
    assert.deepEqual(cards.map((r) => r.dispatch).sort(), ["already_sent", "card"], JSON.stringify(cards));
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_confirmations WHERE kind = 'seat_dispatch' AND status = 'pending'"))[0].n, 1, "one card");
    const pressed = await press(cards.find((r) => r.dispatch === "card")!.confirmation_id);
    assert.equal(pressed.result?.dispatch, "sent", JSON.stringify(pressed));
    assert.equal((await prompted(cid)).length, 1, "one command for the card");

    // Queued (its seat busy): one place in the queue, and the second call is told it was sent, not that the task has not started.
    const cid3 = await machine("alice", "devbox3");
    const s3 = await seat(cid3, "/home/u/ops", { alias: "运维台", role: "负责运维", role_state: "confirmed", dispatch_mode: "auto" });
    const old = await finished(alice, cid3, s3, "清理日志");
    assert.equal((await create(await userTurn(alice, "扩容"), `seat:${s3.seatId}`, "扩容")).dispatch, "sent");
    const busy = await userTurn(alice, "再清理一次");
    const first = await send(busy, old.item_id, "再清理一次");
    assert.equal(first.dispatch, "queued", JSON.stringify(first));
    assert.equal((await send(busy, old.item_id, "再清理一次")).dispatch, "already_sent");
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_work_items WHERE params->>'seat_id' = $1 AND params ? 'queued'", [s3.seatId]))[0].n, 1);
  });

  test("D12 the prompt asks for parking only from a connector that can park", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox", [claude({ permission_park: true })]);
    const s = await seat(cid, "/home/u/rel", { alias: "发布台", role: "负责发布", role_state: "confirmed", dispatch_mode: "auto" });
    await create(await userTurn(alice, "发布"), `seat:${s.seatId}`);
    assert.equal((await prompted(cid))[0].payload.park_permissions, true);
  });

  test("D13 off: no seat target, and the router's seat section says seats are only shown", async () => {
    const alice = await w.user("alice");
    const cid = await machine("alice", "devbox");
    const s = await seat(cid, "/home/u/rel");
    seats.seatDispatchSettings.on = false;
    assert.equal((await refusal(create(await userTurn(alice, "发布"), `seat:${s.seatId}`))).code, "not_enabled");
    assert.match(prompts.renderRouterSeatsSection(), /Seats are only shown for now/);
    assert.doesNotMatch(prompts.renderRouterSeatsSection(), /Dispatching work/);
    // With dispatch the "only shown" rule is left out; the dispatch section is its own (role-profile.ts appends both).
    assert.doesNotMatch(prompts.renderRouterSeatsSection({ dispatch: true }), /only shown/);
    assert.doesNotMatch(prompts.renderRouterSeatsSection({ dispatch: true }), /Dispatching work/);
    const d = prompts.renderRouterDispatchSection();
    // It comes before the development environments section's devenv_send rule, follows a seat's task with work_send, and an offline
    // seat's task waits for its machine (contract §3.6) rather than being refused.
    assert.match(d, /take precedence over the development environments section/);
    assert.match(d, /followed with work_send, never devenv_send/);
    assert.match(d, /offline: a task for it waits in its queue until its machine is back/);
    assert.doesNotMatch(d, /offline\/unsupported cannot take work/);
    assert.match(prompts.renderRouterDevenvSection({ actions: true, send: true }), /"task handed to seat" is not one of these: another instruction for it is work_send/);
  });
});
