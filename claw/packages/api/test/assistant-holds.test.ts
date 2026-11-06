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
 *   HD4  the decision, the answer, or the end of the wait puts the item back in progress; another request's end does not;
 *        a failure to record it is redelivered; a wait that is over is not listed as waiting
 *   HD5  with no channel that draws it, the item's needs-you message goes at once
 *   HD6  a request a channel took is the item's needs-you message: the silent sweep does not say it again
 *   HD7  the router is shown what waits, and a worker turn waits CLAW_ASSISTANT_DECISION_WAIT_SEC for its person
 *   HD8  nothing for a closed item, a request whose wait is over, a review item, or a session that is no item's
 *   HD9  the subscription route takes the assistant_item source, and does not put it in the default set
 *   HD10 two requests at once (a worker's sub-agents run side by side): each waits until its own end, the item until the last
 *   HD11 a request whose end got here first (a redelivery, another replica) does not hold the item or send a card
 *   HD12 a run that ends while it waits (an abort sends no decision) takes its holds with it, and only its own; the
 *        interrupted run is then the sweep's to say, as any interrupted turn is
 *   HD13 the sweep releases a hold whose run ended unseen, after the grace and once, in the same tick that records the run
 *   HD14 a run that told the user something, then waited and went on, has its end recorded: the release is its last word
 *   HD15 a write held for a person who writes Chinese: what the worker found is said first, then the write is put to them in Chinese,
 *        as what it would do and what it would post, never as the tool's name; with a channel that draws it, the same order
 *   HD16 a person who writes English is asked as before, and a hold with nothing reported before it says nothing first
 *   HD17 the plain words say every field the write sets: a pull request's new title and base, an issue's labels, a draft pull
 *        request; a field the words do not know is still shown, as key=value, on the card and in the needs-you message
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
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_notification_outbox, claw_notification_subscriptions, claw_session_events, claw_assistant_messages CASCADE");
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
    assert.equal(row.params.holds.length, 1);
    assert.equal(row.params.holds[0].tool_use_id, "tu-1");
    assert.equal(row.params.holds[0].attention_seq, 1);
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
    assert.equal(row.params.holds[0].kind, "question");
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
    assert.equal(row.params.holds, undefined);
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

  test("HD4a a failure to record the end of a wait is retried, not dropped; a wait that is over is not shown as waiting", async () => {
    const item = await workingItem();
    await deliver(item.workerSid, held());
    const real = w.mod.consumer.eventNotificationPorts.releaseHold;
    let calls = 0;
    w.mod.consumer.eventNotificationPorts.releaseHold = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("connection reset");
      return real(input);
    };
    const decided = { type: "decisionResult", actionId: "tu-1", tool_use_id: "tu-1", decision: "allow", by: "user" };
    try {
      assert.deepEqual(await deliver(item.workerSid, decided), ["nak:5000"], "redelivered: nothing else would release the item");
      assert.equal((await w.item(item.itemId)).board_state, "needs_you");
      assert.deepEqual(await deliver(item.workerSid, decided), ["ack"]);
    } finally {
      w.mod.consumer.eventNotificationPorts.releaseHold = real;
    }
    assert.equal((await w.item(item.itemId)).board_state, "in_progress");

    const other = await workingItem("Wait runs out");
    await deliver(other.workerSid, held({ actionId: "tu-5", tool_use_id: "tu-5" }));
    assert.equal((await holds.heldForPersonManifest("alice")).length, 1);
    await w.q("UPDATE claw_work_items SET params = jsonb_set(params, '{holds,0,expires_at}', to_jsonb((NOW() - interval '1 minute')::text)) WHERE item_id = $1", [other.itemId]);
    assert.deepEqual(await holds.heldForPersonManifest("alice"), [], "Brain has refused it: nobody can answer it any more");
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
    assert.equal(row.params.holds, undefined, "only the record of the wait went");
  });

  test("HD5 with no channel that draws it, the item's needs-you message goes at once", async () => {
    const item = await workingItem();
    await subscribe("alice", ["assistant.say", "work_item.needs_you"], ["trigger", "long_run"]);
    await deliver(item.workerSid, held());
    const rows = await outbox();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.type, "work_item.needs_you");
    // What it would do, with its inputs masked, and where to answer it: not the board's one line.
    assert.match(rows[0].payload.text, /^#1 "Stop the sleeper" needs your approval to: Run mcp__safe__workload_stop workload_id=sa-eval-fixture-sleep token=<redacted>\.\nApprove or deny it on its card in your chat, or in this task in the console, before \d\d:\d\d UTC; after that it is refused\.$/);
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
    // No channel took the card, so its needs-you message went out at once: the router is told not to bring it up again.
    assert.match(prompt, new RegExp(`#${item.seq} \\(item_id: ${item.itemId}\\) approval \\| waits until [^|]+\\| told: the user was told of this at `));
    assert.equal(task.decision_wait_ms, undefined, "a router turn asks nobody");
    // Without a message about the item under this attention, it is not marked told.
    await w.q("DELETE FROM claw_assistant_says WHERE item_id = $1", [item.itemId]);
    const untold: Record<string, unknown> = { task_id: turn.task_id, message_id: turn.mid, prompt: "anything else?" };
    await w.mod.role.applySessionRoleToTask(untold, alice.routerSid);
    assert.match(String(untold.prompt), new RegExp(`#${item.seq} \\(item_id: ${item.itemId}\\) approval \\| waits until`));
    assert.doesNotMatch(String(untold.prompt), /\| told: /);

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

  const decided = (id: string, decision: "allow" | "deny", by = "user") =>
    ({ type: "decisionResult", actionId: id, tool_use_id: id, decision, action: decision, by });
  const completed = (sid: string, run: { mid: string; task_id: string }, over: Record<string, unknown> = {}) => ({
    type: "exec_complete", session_id: sid, user_id: "alice", message_id: run.mid, task_id: run.task_id, prompt: "work",
    final_text: "", failed: false, error_count: 0, skills_used: {}, ...over,
  });
  const ids = (holdList: Array<{ tool_use_id: string }> | undefined) => (holdList ?? []).map((h) => h.tool_use_id);

  test("HD10 two requests at once: each waits until its own end, and the item until the last", async () => {
    const item = await workingItem();
    await channel();
    await deliver(item.workerSid, held());
    await deliver(item.workerSid, held({ actionId: "tu-2", tool_use_id: "tu-2", tool: "mcp__agent-board__issue_write", input: { title: "x" } }));
    let row = await w.item(item.itemId);
    assert.equal(row.attention_seq, 2);
    assert.deepEqual(row.params.holds.map((h: { tool_use_id: string; attention_seq: number }) => [h.tool_use_id, h.attention_seq]), [["tu-1", 2], ["tu-2", 2]],
      "the first still waits, under the new attention");
    assert.equal((await outbox()).length, 2, "each request has its own card");
    assert.deepEqual((await holds.heldForPersonManifest("alice")).map((l) => l.hold.tool_use_id), ["tu-1", "tu-2"]);

    // The second ends first: the item still needs the user, for the first, and says so.
    await deliver(item.workerSid, decided("tu-2", "deny"));
    row = await w.item(item.itemId);
    assert.equal(row.board_state, "needs_you");
    assert.match(row.pending_question, /^Approve or deny: mcp__safe__workload_stop/);
    assert.deepEqual(ids(row.params.holds), ["tu-1"]);
    assert.equal(row.attention_seq, 2, "the same need, one request fewer");
    assert.equal((await w.itemEvents(item.itemId)).at(-1)!.summary, "denied");
    assert.deepEqual((await holds.heldForPersonManifest("alice")).map((l) => l.hold.tool_use_id), ["tu-1"]);

    // The first's card taken now is still the item's current need: recorded as its needs-you message.
    const sent: string[] = [];
    await w.mod.outbox.deliverDue({ transport: async (req) => { sent.push(JSON.parse(req.body).approval.tool_use_id); return 200; }, resolve: PUBLIC, allowedHosts: new Set() });
    assert.deepEqual(sent.sort(), ["tu-1", "tu-2"]);
    const says = await w.q("SELECT item_attention_seq FROM claw_assistant_says");
    assert.deepEqual(says.map((r) => Number(r.item_attention_seq)), [2]);

    await deliver(item.workerSid, decided("tu-1", "allow"));
    row = await w.item(item.itemId);
    assert.equal(row.board_state, "in_progress");
    assert.equal(row.pending_question, null);
    assert.equal(row.params.holds, undefined);
    assert.deepEqual(await holds.heldForPersonManifest("alice"), []);
  });

  test("HD11 a request whose end got here first does not hold the item", async () => {
    const item = await workingItem();
    await channel();
    await deliver(item.workerSid, decided("tu-1", "allow"));
    assert.deepEqual(await deliver(item.workerSid, held()), ["ack"]);
    let row = await w.item(item.itemId);
    assert.equal(row.board_state, "in_progress", "nobody waits on it any more");
    assert.equal(row.params.holds, undefined);
    assert.deepEqual(await outbox(), [], "no card for a request already answered");

    // A question: its start is not its end, so it still holds; its end before the request does not.
    await deliver(item.workerSid, { type: "toolUsed", tool: "ask_user_question", actionId: "tu-q", status: "start" });
    await deliver(item.workerSid, asked());
    assert.equal((await w.item(item.itemId)).board_state, "needs_you");
    await deliver(item.workerSid, { type: "toolUsed", tool: "ask_user_question", actionId: "tu-q", status: "success" });
    await deliver(item.workerSid, { type: "toolUsed", tool: "ask_user_question", actionId: "tu-q2", status: "success" });
    await deliver(item.workerSid, asked({ actionId: "tu-q2" }));
    row = await w.item(item.itemId);
    assert.equal(row.board_state, "in_progress");
    assert.equal((await outbox()).length, 1, "only the question that was still open");

    // Another session's end of the same id is not this one's.
    const other = await workingItem("Other");
    await deliver(other.workerSid, held());
    assert.equal((await w.item(other.itemId)).board_state, "needs_you");
  });

  test("HD12 a run that ends while it waits takes its holds with it, and only its own", async () => {
    await channel();
    const item = await w.createItem(alice, "Aborted wait");
    const run = await w.workerTurn(item.itemId);
    await deliver(item.workerSid, held({ message_id: run.mid }));
    let row = await w.item(item.itemId);
    assert.equal(row.params.holds[0].run_id, run.task_id, "the run that waits");
    assert.equal((await w.itemEvents(item.itemId)).at(-1)!.run_id, run.task_id);

    // Stopped from the console while it waited: Brain sends the run's completion and no decision.
    assert.deepEqual(await deliver(item.workerSid, completed(item.workerSid, run, { interrupted: true })), ["ack"]);
    row = await w.item(item.itemId);
    assert.equal(row.board_state, "in_progress");
    assert.equal(row.pending_question, null);
    assert.equal(row.params.holds, undefined);
    assert.deepEqual(await holds.heldForPersonManifest("alice"), []);
    const last = (await w.itemEvents(item.itemId)).at(-1)!;
    assert.deepEqual({ kind: last.kind, source: last.source, summary: last.summary, run_id: last.run_id },
      { kind: "progress", source: "hold", summary: holds.RUN_ENDED_HOW, run_id: run.task_id });
    // The interrupted run is the sweep's to say, as any interrupted turn is: the item does not sit in progress.
    await w.q("UPDATE claw_tasks SET completed_at = NOW() - interval '10 minutes' WHERE task_id = $1", [run.task_id]);
    assert.equal(await w.mod.turnEnd.reconcileWorkerRuns(), 1);
    row = await w.item(item.itemId);
    assert.equal(row.board_state, "needs_you");
    assert.equal(row.last_report_kind, "failed");

    // A run's end ends only what it waited on: the next run's request still waits.
    const next = await w.createItem(alice, "Next run");
    const first = await w.workerTurn(next.itemId);
    await w.closeRun(first.task_id, "completed", undefined, 0);
    const second = await w.workerTurn(next.itemId);
    await deliver(next.workerSid, held({ actionId: "tu-n", tool_use_id: "tu-n", message_id: second.mid }));
    assert.equal(await holds.releaseRunHolds(next.workerSid, [first.task_id]), false);
    assert.deepEqual(ids((await w.item(next.itemId)).params.holds), ["tu-n"]);
    assert.equal((await w.item(next.itemId)).board_state, "needs_you");
    assert.equal(await holds.releaseRunHolds(next.workerSid, [second.task_id]), true);
  });

  test("HD13 the sweep releases a hold whose run ended unseen, after the grace and once", async () => {
    await channel();
    const item = await w.createItem(alice, "Brain went away");
    const run = await w.workerTurn(item.itemId);
    await deliver(item.workerSid, held({ message_id: run.mid }));
    assert.equal(await holds.releaseHoldsOfEndedRuns(), 0, "a run still running keeps its hold");
    await w.closeRun(run.task_id, "failed", "worker_lost", 5);
    assert.equal(await holds.releaseHoldsOfEndedRuns(), 0, "within the grace it is the completion handler's");
    await w.q("UPDATE claw_tasks SET completed_at = NOW() - interval '10 minutes' WHERE task_id = $1", [run.task_id]);
    // One tick of the assistant sweep: the hold goes, and the run's end is recorded after it.
    const { sweepAssistant } = await import("../src/assistant/sweep.js");
    await sweepAssistant();
    const row = await w.item(item.itemId);
    assert.equal(row.params.holds, undefined);
    assert.equal(row.board_state, "needs_you");
    assert.equal(row.last_report_kind, "failed", "what the run did is said");
    assert.equal(await holds.releaseHoldsOfEndedRuns(), 0, "and once");
  });

  test("HD14 a run that told the user something, then waited and went on, has its end recorded", async () => {
    const item = await w.createItem(alice, "Asked then waited");
    const run = await w.workerTurn(item.itemId);
    await w.mod.reports.ingestReport({ itemId: item.itemId, workerSessionId: item.workerSid, generation: Number(run.gen), runId: run.task_id },
      { kind: "blocked", summary: "Which cluster?", question: "Which cluster?" }, "worker");
    await deliver(item.workerSid, held({ message_id: run.mid }));
    await deliver(item.workerSid, decided("tu-1", "allow"));
    assert.equal((await w.item(item.itemId)).board_state, "in_progress");
    assert.deepEqual(await deliver(item.workerSid, completed(item.workerSid, run, { final_text: "Stopped it." })), ["ack"]);
    const row = await w.item(item.itemId);
    assert.equal(row.board_state, "needs_you", "the run's end is heard, not left in progress");
    assert.equal(row.last_report_kind, "ready");
    assert.equal(row.summary, "Stopped it.");
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

  /** A message alice wrote to her assistant, in her words: what tells the system which language she reads. */
  async function wrote(content: string) {
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, attended_via, channel_context)
       VALUES ($1, $2, 'alice', $3, '{"kind":"person"}'::jsonb, '{}'::jsonb)`,
      [alice.routerSid, `claw-msg-${++seq}`, content],
    );
  }
  const COMMENT = { repo: "AMD-AGI/PrimusClaw", number: 322, body: "Worth re-checking: citations.ts:91-94 pushes past USER_ADDRESSES_MAX." };
  const commentHeld = (turn: { mid: string }, over: Record<string, unknown> = {}) => held({
    tool: "mcp__github__issue_comment", input: COMMENT, summary: "", message_id: turn.mid, ...over,
  });

  test("HD15 a write held for a person who writes Chinese: what was found first, then the write, in Chinese and in plain words", async () => {
    await wrote("看一下 AMD-AGI/PrimusClaw#322：改了什么、改了几个文件、CI 什么状态、有没有没解决的线程？然后留一条评论。");
    const item = await w.createItem(alice, "PR #322 评审并留评论");
    const turn = await w.workerTurn(item.itemId);
    const found = "改了 28 个文件（+1821/-42），给助理的回答加引用；CI 42 项：41 成功、1 跳过；未解决的评审线程 0 个。";
    await w.mod.tools.report(turn, { kind: "progress", summary: found });
    await subscribe("alice", ["assistant.say", "work_item.needs_you"], ["trigger", "long_run"]);   // draws no request
    await deliver(item.workerSid, commentHeld(turn));

    const row = await w.item(item.itemId);
    assert.equal(row.pending_question, "需要你批准：以你的 GitHub 账号在 AMD-AGI/PrimusClaw#322 上发表一条评论");
    const rows = await outbox();
    assert.deepEqual(rows.map((r) => r.payload.type), ["assistant.say", "work_item.needs_you"], "what was found, then the request");
    const first = rows[0].payload.text as string;
    assert.ok(first.startsWith(`#${item.seq} PR #322 评审并留评论 查到的结果：`), first);
    assert.ok(first.includes(found), "the worker's findings, whole");
    const asked = rows[1].payload.text as string;
    assert.ok(asked.startsWith(`#${item.seq} PR #322 评审并留评论 需要你批准一个操作：以你的 GitHub 账号在 AMD-AGI/PrimusClaw#322 上发表一条评论。`), asked);
    assert.ok(asked.includes(COMMENT.body), "the comment it would post, whole");
    assert.ok(/前有效，过时自动拒绝/.test(asked), asked);
    assert.ok(!asked.includes("mcp__github__issue_comment") && !/Approve or deny|needs your answer/.test(asked), asked);

    // A redelivered request says neither again.
    await deliver(item.workerSid, commentHeld(turn));
    assert.equal((await outbox()).length, 2);

    // With a channel that draws the request: the findings are queued before the card, and the card is in Chinese.
    await w.q("TRUNCATE claw_notification_outbox, claw_notification_subscriptions");
    const item2 = await w.createItem(alice, "PR #323 评审并留评论");
    const turn2 = await w.workerTurn(item2.itemId);
    await w.mod.tools.report(turn2, { kind: "progress", summary: "改了 3 个文件；CI 全绿；没有未解决的线程。" });
    await channel();
    await deliver(item2.workerSid, commentHeld(turn2, { actionId: "tu-2", tool_use_id: "tu-2", input: { ...COMMENT, number: 323 } }));
    const card = await outbox();
    assert.deepEqual(card.map((r) => r.payload.type), ["assistant.say", "assistant.say", "approval.requested"]);
    assert.ok((card[0].payload.text as string).includes("改了 3 个文件；CI 全绿；没有未解决的线程。"));
    // The card shows the call cut to a line: the comment it would post is said whole before it.
    assert.equal(card[1].payload.text, [
      `#${item2.seq} PR #323 评审并留评论 要做的操作：以你的 GitHub 账号在 AMD-AGI/PrimusClaw#323 上发表一条评论。`,
      "内容如下：", "---", COMMENT.body, "---", "在下面的卡片上批准或拒绝。",
    ].join("\n"));
    assert.equal(card[2].payload.title, `需要你批准：#${item2.seq} PR #323 评审并留评论`);
    assert.equal(card[2].payload.summary, "以你的 GitHub 账号在 AMD-AGI/PrimusClaw#323 上发表一条评论");
    // A Brain that explains the call itself keeps its words on the card; the write is still said whole before it.
    await w.q("TRUNCATE claw_notification_outbox");
    await deliver(item2.workerSid, commentHeld(turn2, { actionId: "tu-3", tool_use_id: "tu-3", summary: "发表评审评论", input: { ...COMMENT, number: 323, body: "second" } }));
    const again = await outbox();
    assert.deepEqual(again.map((r) => r.payload.type), ["assistant.say", "approval.requested"], "the same report is not said twice");
    assert.ok((again[0].payload.text as string).includes("\nsecond\n"));
    assert.equal(again[1].payload.summary, "发表评审评论");
  });

  test("HD16 an English writer is asked as before, and nothing reported before the hold says nothing first", async () => {
    await wrote("Look at AMD-AGI/PrimusClaw#322 and leave a comment on it, please.");
    const item = await w.createItem(alice, "Comment on PR 322");
    const turn = await w.workerTurn(item.itemId);
    await subscribe("alice", ["assistant.say", "work_item.needs_you"], ["trigger", "long_run"]);
    await deliver(item.workerSid, commentHeld(turn));
    const rows = await outbox();
    assert.deepEqual(rows.map((r) => r.payload.type), ["work_item.needs_you"], "no report, nothing said before the request");
    assert.match((await w.item(item.itemId)).pending_question, /^Approve or deny: mcp__github__issue_comment /);
    const text = rows[0].payload.text as string;
    assert.ok(text.startsWith(`#${item.seq} "Comment on PR 322" needs your approval to: Post a comment on AMD-AGI/PrimusClaw#322 as your GitHub account.`), text);
    assert.ok(text.includes(COMMENT.body));
  });

  test("HD17 the plain words say every field the write sets, and show the ones they do not know", async () => {
    await wrote("把 AMD-AGI/PrimusClaw#5 的标题和 base 改一下，再开个 issue 和一个草稿 PR。");
    await subscribe("alice", ["assistant.say", "work_item.needs_you"], ["trigger", "long_run"]);   // draws no request
    const ask = async (title: string, tool: string, input: Record<string, unknown>) => {
      await w.q("TRUNCATE claw_notification_outbox");
      const item = await w.createItem(alice, title);
      const turn = await w.workerTurn(item.itemId);
      await deliver(item.workerSid, held({ tool: `mcp__github__${tool}`, input, summary: "", message_id: turn.mid }));
      const rows = await outbox();
      assert.deepEqual(rows.map((r) => r.payload.type), ["work_item.needs_you"]);
      return { pending: (await w.item(item.itemId)).pending_question as string, text: rows[0].payload.text as string, item };
    };

    // A pull request whose title and base change: both are said, with the new values; the new description is the detail.
    const update = await ask("改 PR #5", "pr_update", { repo: "o/r", number: 5, title: "Fix the cut", base: "release", body: "New description." });
    const updated = "修改 o/r#5：标题改为「Fix the cut」，base 改为 release，正文改为下文";
    assert.equal(update.pending, `需要你批准：${updated}`);
    assert.ok(update.text.startsWith(`#${update.item.seq} 改 PR #5 需要你批准一个操作：${updated}。\n内容如下：\n---\nNew description.\n---`), update.text);
    // Closing it with a new base: the base is not dropped behind the close.
    const close = await ask("关 PR #6", "pr_update", { repo: "o/r", number: 6, base: "main", state: "closed" });
    assert.equal(close.pending, "需要你批准：修改 o/r#6：base 改为 main，关闭它");

    // An issue's labels.
    const issue = await ask("开 issue", "issue_create", { repo: "o/r", title: "Flaky test", body: "It flakes.", labels: ["bug", "flaky-test"] });
    assert.equal(issue.pending, "需要你批准：以你的 GitHub 账号在 o/r 新建 issue「Flaky test」，标签：bug, flaky-test");

    // A draft pull request is said to be one; a field the words do not know is shown as the target shows it.
    const pr = await ask("开草稿 PR", "pr_create", { repo: "o/r", head: "fix/x", base: "main", title: "Fix x", draft: true, maintainer_can_modify: false });
    const opened = "以你的 GitHub 账号在 o/r 开一个草稿 PR「Fix x」（fix/x → main）（另设 maintainer_can_modify=false）";
    assert.equal(pr.pending, `需要你批准：${opened}`);
    assert.ok(pr.text.includes(`需要你批准一个操作：${opened}。`), pr.text);

    // With a channel that draws the request, the text said before the card (there is one: the new description) and the card's
    // summary carry the same words.
    await w.q("TRUNCATE claw_notification_outbox, claw_notification_subscriptions");
    await channel();
    const item = await w.createItem(alice, "改 PR #7");
    const turn = await w.workerTurn(item.itemId);
    await deliver(item.workerSid, held({ tool: "mcp__github__pr_update", input: { repo: "o/r", number: 7, title: "T2", base: "release", body: "D2" }, summary: "", message_id: turn.mid }));
    const card = await outbox();
    assert.deepEqual(card.map((r) => r.payload.type), ["assistant.say", "approval.requested"]);
    assert.equal(card[0].payload.text, `#${item.seq} 改 PR #7 要做的操作：修改 o/r#7：标题改为「T2」，base 改为 release，正文改为下文。\n内容如下：\n---\nD2\n---\n在下面的卡片上批准或拒绝。`);
    assert.equal(card[1].payload.summary, "修改 o/r#7：标题改为「T2」，base 改为 release，正文改为下文");
  });
});
