// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A work item's worker waiting for its person (`assistant/holds.ts`): a held tool call or a question reaches the person, the
 * item waits in needs_you, and it goes back to work when the wait is over. Real Postgres with the production schema, the
 * real event consumer on the way in and the real delivery worker on the way out. Skipped without DATABASE_URL, and a skip
 * is not a pass.
 *
 *   HD1  a held call: the item needs the user (with what it waits for), and one approval.requested goes to each subscription
 *        that lists the type and the assistant_item source, with the item; nobody else is sent it, and the router is not woken
 *   HD2  a question: the same, with the questions, masked and clipped
 *   HD3  the same request again changes nothing and sends nothing more, even once it was answered
 *   HD4  the decision, the answer, or the end of the wait puts the item back in progress; another request's end does not
 *   HD5  with no channel that draws it, the item's needs-you message goes at once
 *   HD6  a request a channel took is the item's needs-you message: the silent sweep does not say it again
 *   HD7  the router is shown what waits, and a worker turn waits CLAW_ASSISTANT_DECISION_WAIT_SEC for its person
 *   HD8  nothing for a closed item, a request whose wait is over, a review item, or a session that is no item's
 *   HD9  the subscription route takes the assistant_item source, and does not put it in the default set
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];

describe("assistant holds", { skip }, () => {
  let w: World;
  let holds: typeof import("../src/assistant/holds.js");
  let alice: { userId: string; routerSid: string };
  let seq = 0;
  let kicks = 0;
  let realKick: typeof import("../src/assistant/holds.js").holdPorts.kickDelivery;
  let realTombstone: Record<string, unknown>;

  before(async () => {
    w = await startWorld({ CLAW_ASSISTANT_TOOLS: "on" });
    holds = await import("../src/assistant/holds.js");
    realKick = holds.holdPorts.kickDelivery;
    holds.holdPorts.kickDelivery = async () => { kicks += 1; };
    realTombstone = { ...w.mod.consumer.tombstoneReader };
    Object.assign(w.mod.consumer.tombstoneReader, { has: async () => false });
    w.mod.outbound.registerAssistantDeliveryHook();
    holds.registerHoldDeliveryHook();
  });
  after(async () => {
    if (holds) holds.holdPorts.kickDelivery = realKick;
    if (w) Object.assign(w.mod.consumer.tombstoneReader, realTombstone);
    await w?.stop();
  });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox, claw_notification_subscriptions, claw_session_events CASCADE");
    w.drains.length = 0;
    kicks = 0;
    alice = await w.user("alice");
  });

  /** An event from Brain, through the real consumer. */
  async function deliver(sessionId: string, event: Record<string, unknown>): Promise<string[]> {
    const verdicts: string[] = [];
    await w.mod.consumer.consumeEventDelivery({
      subject: `events.${sessionId}`,
      data: new TextEncoder().encode(JSON.stringify(event)),
      seq: ++seq,
      ack: () => { verdicts.push("ack"); },
      nak: (ms?: number) => { verdicts.push(`nak:${ms ?? ""}`); },
    });
    return verdicts;
  }
  const held = (over: Record<string, unknown> = {}) => ({
    type: "permissionRequest", actionId: "tu-1", tool_use_id: "tu-1", tool: "mcp__safe__workload_stop",
    input: { workload_id: "sa-eval-fixture-sleep", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
    summary: "Stop the workload sa-eval-fixture-sleep", timeout_ms: 3_600_000, ts: Date.now(), message_id: "m-1", ...over,
  });
  const asked = (over: Record<string, unknown> = {}) => ({
    type: "userQuestion", actionId: "tu-q",
    questions: [{ id: "q1", question: `Which cluster? ${"x".repeat(600)}`, options: [{ id: "a", label: "mi355x" }, { id: "b", label: "mi300x" }] }],
    timeout_ms: 3_600_000, ts: Date.now(), message_id: "m-1", ...over,
  });
  async function subscribe(userId: string, types: string[], sources: string[]): Promise<string> {
    const id = w.mod.outbox.newSubscriptionId();
    await w.q(
      `INSERT INTO claw_notification_subscriptions (subscription_id, owner_user_id, url, secret_enc, event_types, sources, enabled)
       VALUES ($1, $2, 'https://hooks.example.com/claw', $3, $4::text[], $5::text[], true)`,
      [id, userId, w.mod.crypto.encryptUserEnvValue(`secret-${userId}`), types, sources],
    );
    return id;
  }
  /** What a channel that draws an item's requests subscribes to. */
  const channel = (userId = "alice") => subscribe(userId, ["assistant.say", "work_item.needs_you", "approval.requested"], ["trigger", "long_run", "assistant_item"]);
  const outbox = async () => w.q("SELECT * FROM claw_notification_outbox ORDER BY id");
  const routerWakes = async () => (await w.pending(alice.routerSid)).filter((p) => String(p.content).startsWith("[work_event]"));

  async function workingItem(title = "Stop the sleeper") {
    const item = await w.createItem(alice, title);
    await w.workerTurn(item.itemId);
    return item;
  }

  test("HD1 a held call: the item needs the user and the request goes to the channels that draw it", async () => {
    const item = await workingItem();
    const drawing = await channel();
    await subscribe("alice", ["assistant.say", "work_item.needs_you", "approval.requested"], ["trigger", "long_run"]);   // no source
    await subscribe("alice", ["assistant.say", "work_item.needs_you"], ["trigger", "long_run", "assistant_item"]);        // no type
    await channel("bob");
    const ts = Date.now() - 1_000;
    assert.deepEqual(await deliver(item.workerSid, held({ ts })), ["ack"]);

    const row = await w.item(item.itemId);
    assert.equal(row.board_state, "needs_you");
    assert.equal(row.last_report_kind, "waiting");
    assert.equal(row.attention_seq, 1);
    assert.match(row.pending_question, /^Approve or deny: mcp__safe__workload_stop .*workload_id=sa-eval-fixture-sleep/);
    assert.equal(row.pending_question.includes("ghp_abcdefghijklmnop"), false, "a credential in the call is masked");
    assert.equal(row.params.hold.tool_use_id, "tu-1");
    assert.equal(row.params.hold.attention_seq, 1);
    const last = (await w.itemEvents(item.itemId)).at(-1)!;
    assert.deepEqual({ kind: last.kind, source: last.source }, { kind: "waiting", source: "hold" });

    const rows = await outbox();
    assert.equal(rows.length, 1, "only the owner's subscription that lists the type and the source");
    assert.equal(rows[0].subscription_id, drawing);
    const p = rows[0].payload;
    assert.equal(p.type, "approval.requested");
    assert.equal(p.source, "assistant_item");
    assert.equal(p.event_id, w.mod.outbox.deterministicEventId("approval.requested", item.workerSid, "tu-1"));
    assert.equal(p.session_id, item.workerSid);
    assert.deepEqual(p.item, { item_id: item.itemId, seq: item.seq, title: "Stop the sleeper", board_state: "needs_you", result_version: 0, can_accept: false });
    assert.equal(p.approval.tool, "mcp__safe__workload_stop");
    assert.equal(p.approval.tool_use_id, "tu-1");
    assert.equal(p.approval.expires_at, new Date(ts + 3_600_000).toISOString(), "the wait Brain is working to");
    assert.match(p.title, new RegExp(`^Approval needed: #${item.seq} Stop the sleeper$`));
    assert.equal(p.summary, "Stop the workload sa-eval-fixture-sleep");
    assert.equal("questions" in p, false);
    assert.equal(kicks, 1, "delivered now, not at the next poll");
    assert.deepEqual(await routerWakes(), [], "the card is the message: the router is not woken to say it again");
  });

  test("HD2 a question: the item needs the user, and the questions go with the request", async () => {
    const item = await workingItem();
    await channel();
    await deliver(item.workerSid, asked());
    const row = await w.item(item.itemId);
    assert.equal(row.board_state, "needs_you");
    assert.match(row.pending_question, /^Question for you: Which cluster\?/);
    assert.equal(row.params.hold.kind, "question");
    const [{ payload: p }] = await outbox();
    assert.equal(p.approval.tool, "ask_user_question");
    assert.equal(p.approval.tool_use_id, "tu-q");
    assert.match(p.title, /^Question: #/);
    assert.equal(p.questions.length, 1);
    assert.equal(p.questions[0].id, "q1");
    assert.equal(p.questions[0].question.length, 500, "clipped");
    assert.deepEqual(p.questions[0].options, [{ id: "a", label: "mi355x" }, { id: "b", label: "mi300x" }]);
    assert.equal(p.questions[0].allow_multiple, false);
  });

  test("HD3 the same request again changes nothing and sends nothing more", async () => {
    const item = await workingItem();
    await channel();
    await deliver(item.workerSid, held());
    await deliver(item.workerSid, held());
    assert.equal((await w.item(item.itemId)).attention_seq, 1);
    assert.equal((await outbox()).length, 1);
    assert.equal((await w.itemEvents(item.itemId)).filter((e) => e.source === "hold").length, 1);
    // Answered, then the request redelivered: the item is not held again for a request nobody waits on.
    await deliver(item.workerSid, { type: "decisionResult", actionId: "tu-1", tool_use_id: "tu-1", decision: "allow", by: "user" });
    await deliver(item.workerSid, held());
    const row = await w.item(item.itemId);
    assert.equal(row.board_state, "in_progress");
    assert.equal(row.attention_seq, 1);
    assert.equal((await outbox()).length, 1);
  });

  test("HD4 the end of the wait puts the item back in progress; another request's end does not", async () => {
    const item = await workingItem();
    await channel();
    await deliver(item.workerSid, held());
    await deliver(item.workerSid, { type: "decisionResult", actionId: "tu-other", tool_use_id: "tu-other", decision: "allow", by: "user" });
    assert.equal((await w.item(item.itemId)).board_state, "needs_you", "not this request's decision");

    await deliver(item.workerSid, { type: "decisionResult", actionId: "tu-1", tool_use_id: "tu-1", decision: "allow", action: "allow", by: "user" });
    let row = await w.item(item.itemId);
    assert.equal(row.board_state, "in_progress");
    assert.equal(row.pending_question, null);
    assert.equal(row.params.hold, undefined);
    assert.equal((await w.itemEvents(item.itemId)).at(-1)!.summary, "approved");

    await deliver(item.workerSid, asked());
    await deliver(item.workerSid, { type: "toolUsed", tool: "ask_user_question", actionId: "tu-q", status: "start" });
    assert.equal((await w.item(item.itemId)).board_state, "needs_you", "the question's start is not its end");
    await deliver(item.workerSid, { type: "toolUsed", tool: "ask_user_question", actionId: "tu-q", status: "success" });
    row = await w.item(item.itemId);
    assert.equal(row.board_state, "in_progress");
    assert.equal((await w.itemEvents(item.itemId)).at(-1)!.summary, "answered");

    await deliver(item.workerSid, held({ actionId: "tu-2", tool_use_id: "tu-2" }));
    await deliver(item.workerSid, { type: "decisionResult", actionId: "tu-2", tool_use_id: "tu-2", decision: "deny", by: "timeout" });
    assert.equal((await w.item(item.itemId)).board_state, "in_progress");
    assert.equal((await w.itemEvents(item.itemId)).at(-1)!.summary, "no decision in time");
  });

  test("HD4b a hold the worker's own report overtook is not undone by the late decision", async () => {
    const item = await workingItem();
    await deliver(item.workerSid, held());
    // The worker went on and reported its result before the decision's event got here.
    const run = (await w.q("SELECT generation FROM claw_work_items WHERE item_id = $1", [item.itemId]))[0];
    await w.mod.reports.ingestReport({ itemId: item.itemId, workerSessionId: item.workerSid, generation: Number(run.generation), runId: null },
      { kind: "ready", summary: "stopped it", result: { text: "done" } }, "sweep");
    await deliver(item.workerSid, { type: "decisionResult", actionId: "tu-1", tool_use_id: "tu-1", decision: "allow", by: "user" });
    const row = await w.item(item.itemId);
    assert.equal(row.board_state, "needs_you");
    assert.equal(row.last_report_kind, "ready", "the result still waits for the user");
    assert.equal(row.params.hold, undefined, "only the record of the wait went");
  });

  test("HD5 with no channel that draws it, the item's needs-you message goes at once", async () => {
    const item = await workingItem();
    await subscribe("alice", ["assistant.say", "work_item.needs_you"], ["trigger", "long_run"]);
    await deliver(item.workerSid, held());
    const rows = await outbox();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.type, "work_item.needs_you");
    assert.match(rows[0].payload.text, /Approve or deny: mcp__safe__workload_stop/);
    const says = await w.q("SELECT * FROM claw_assistant_says");
    assert.equal(says.length, 1);
    assert.equal(says[0].item_attention_seq, 1);
    assert.equal(await w.mod.silent.tellSilentItems(1), 0, "and once: the sweep has nothing left to say");
  });

  test("HD6 a request a channel took is the item's needs-you message: the sweep does not say it again", async () => {
    const item = await workingItem();
    await channel();
    await deliver(item.workerSid, held());
    const sent: string[] = [];
    await w.mod.outbox.deliverDue({ transport: async (req) => { sent.push(JSON.parse(req.body).type); return 200; }, resolve: PUBLIC, allowedHosts: new Set() });
    assert.deepEqual(sent, ["approval.requested"]);
    await w.q("UPDATE claw_work_items SET updated_at = NOW() - interval '1 hour' WHERE item_id = $1", [item.itemId]);
    assert.equal(await w.mod.silent.tellSilentItems(300), 0);
    const says = await w.q("SELECT * FROM claw_assistant_says");
    assert.equal(says.length, 1);
    assert.equal(says[0].fallback, true);
    assert.notEqual(says[0].delivered_at, null);
    assert.equal(says[0].say_id, w.mod.outbox.deterministicEventId("work_item.needs_you", item.itemId, "1"));

    // A request nobody took is said by the sweep, as any need is.
    const other = await workingItem("Post the topic");
    await deliver(other.workerSid, held({ actionId: "tu-9", tool_use_id: "tu-9", tool: "mcp__agent-board__issue_write" }));
    await w.mod.outbox.deliverDue({ transport: async () => 500, resolve: PUBLIC, allowedHosts: new Set() });
    await w.q("UPDATE claw_work_items SET updated_at = NOW() - interval '1 hour' WHERE item_id = $1", [other.itemId]);
    assert.equal(await w.mod.silent.tellSilentItems(300), 1);
  });

  test("HD7 the router is shown what waits; a worker turn waits for its person as configured", async () => {
    const item = await workingItem();
    await deliver(item.workerSid, held());
    const turn = await w.routerTurn(alice);
    const task: Record<string, unknown> = { task_id: turn.task_id, message_id: turn.mid, prompt: "what is waiting for me?" };
    await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
    const prompt = String(task.prompt);
    assert.match(prompt, /Waiting for you in work items/);
    assert.match(prompt, new RegExp(`#${item.seq} \\(item_id: ${item.itemId}\\) approval \\| waits until `));
    assert.match(prompt, /workload_id=sa-eval-fixture-sleep/);
    assert.equal(task.decision_wait_ms, undefined, "a router turn asks nobody");

    const worker = await w.workerTurn(item.itemId);
    const wt: Record<string, unknown> = { task_id: worker.task_id, message_id: worker.mid, prompt: "go on" };
    await w.mod.role.applySessionRoleToTask(wt, item.workerSid);
    assert.equal(wt.decision_wait_ms, 3_600_000);

    await deliver(item.workerSid, { type: "decisionResult", actionId: "tu-1", tool_use_id: "tu-1", decision: "deny", by: "user" });
    const again: Record<string, unknown> = { task_id: turn.task_id, message_id: turn.mid, prompt: "and now?" };
    await w.mod.role.applySessionRoleToTask(again, alice.routerSid);
    assert.equal(String(again.prompt).includes("Waiting for you in work items"), false, "nothing waits any more");
  });

  test("HD8 nothing for a closed item, a wait already over, a review item, or a session that is no item's", async () => {
    await channel();
    const closed = await workingItem("Closed one");
    await w.q("UPDATE claw_work_items SET board_state = 'done', outcome = 'stopped', closed_at = NOW() WHERE item_id = $1", [closed.itemId]);
    assert.deepEqual(await deliver(closed.workerSid, held()), ["ack"]);
    assert.equal((await w.item(closed.itemId)).board_state, "done");

    const late = await workingItem("Late one");
    await deliver(late.workerSid, held({ ts: Date.now() - 3_700_000 }));
    assert.equal((await w.item(late.itemId)).board_state, "in_progress", "Brain stopped waiting before the event got here");

    const review = await workingItem("A review");
    await w.q("UPDATE claw_work_items SET kind = 'review' WHERE item_id = $1", [review.itemId]);
    await deliver(review.workerSid, held());
    assert.equal((await w.item(review.itemId)).board_state, "in_progress");

    await w.q("INSERT INTO claw_sessions (session_id, name, user_id, mode, config) VALUES ('plain-1', 'plain', 'alice', 'claw', '{}'::jsonb)");
    const seen: string[] = [];
    const real = w.mod.consumer.eventNotificationPorts.recordApprovalRequested;
    w.mod.consumer.eventNotificationPorts.recordApprovalRequested = async (input) => { seen.push(input.sessionId); return 0; };
    try {
      await deliver("plain-1", held());
      await deliver(review.workerSid, held({ actionId: "tu-7", tool_use_id: "tu-7" }));
    } finally {
      w.mod.consumer.eventNotificationPorts.recordApprovalRequested = real;
    }
    assert.deepEqual(seen, ["plain-1", review.workerSid], "a session's request is any session's, as before");
    assert.deepEqual(await outbox(), []);
  });

  test("HD9 the subscription route takes the assistant_item source and leaves it out of the default set", async () => {
    const { registerNotificationSubscriptionRoutes } = await import("../src/routes/notification-subscriptions.js");
    const Fastify = (await import("fastify")).default;
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: unknown }).user = { userId: "alice", userName: "alice", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
    });
    await registerNotificationSubscriptionRoutes(app);
    await app.ready();
    try {
      const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/notification-subscriptions", payload });
      const asked = await post({ url: "https://93.184.216.34/hook", event_types: ["approval.requested"], sources: ["trigger", "long_run", "assistant_item"] });
      assert.equal(asked.statusCode, 201, asked.body);
      assert.deepEqual(asked.json().data.sources, ["trigger", "long_run", "assistant_item"]);
      const plain = await post({ url: "https://93.184.216.35/hook" });
      assert.equal(plain.statusCode, 201, plain.body);
      assert.deepEqual(plain.json().data.sources, ["trigger", "long_run"], "a receiver that did not ask is not sent an item's requests");
      const id = plain.json().data.subscription_id;
      const patched = await app.inject({ method: "PATCH", url: `/v1/notification-subscriptions/${id}`, payload: { sources: ["assistant_item", "trigger"] } });
      assert.equal(patched.statusCode, 200, patched.body);
      assert.deepEqual(patched.json().data.sources, ["assistant_item", "trigger"]);
      const wrong = await post({ url: "https://93.184.216.36/hook", sources: ["assistant"] });
      assert.equal(wrong.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});
