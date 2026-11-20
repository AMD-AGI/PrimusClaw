// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A queued message that cannot be sent, and the messages queued behind it.
 *
 * `claw_pending_messages` is FIFO per session and a drain takes only the oldest
 * row. Before tasks/pending-quarantine.ts a row whose dispatch failed every time
 * was retried on every completion and every sweeper tick with no limit, and
 * every later message on its session waited behind it while the session itself
 * read idle. These cases run on a real Postgres with the schema `initDb` builds,
 * and through the real drain: the completion consumer's delivery handler and the
 * sweeper's orphan drain, down to `dispatchPendingMessage` opening real run rows.
 * Only the NATS publishes are replaced, and the poison is the one a real NATS
 * client produces: a turn larger than the server's `max_payload`, which the
 * client refuses with MAX_PAYLOAD_EXCEEDED before sending a byte.
 *
 * Coverage:
 *   Q1 a message that keeps failing is retried within its bounds, then
 *      quarantined, and the message behind it is sent on the same drain
 *   Q2 the session is told once, in the turn the message would have been, and
 *      that notice is an ordinary completion that leaves the next turn running
 *   Q3 a failure that clears is retried and sent in order, never quarantined
 *   Q4 a notice that cannot be published is retried by the sweeper, once
 *   Q5 a message whose reserved run is still open is not quarantined under it
 *   Q6 the gauges read the queue: the failing streak and the oldest age
 *   Q7 a message with a NUL or a lone surrogate is queued, not refused, and the
 *      database itself refuses the raw value
 *   Q8 a deleted session takes its quarantined messages with it
 *   Q9 a notice that failed part-way is finished on retry, never repeated:
 *      every event reaches the session exactly once
 *   Q10 a message whose sealed credentials will not open is quarantined and
 *      counted at once, even when its notice cannot be published, and the
 *      message behind it is sent
 *   Q11 one whose move the database refuses is a counted, retried drain failure
 *
 * Skipped without DATABASE_URL, and a skip is not a pass: CI sets it.
 */
process.env.PENDING_DRAIN_MAX_FAILURES = "3";
process.env.PENDING_DRAIN_FAILURE_WINDOW_SEC = "600";

import test, { after, afterEach, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const SESSION = "s-poison";
const USER = "u-poison";
const RUNNING_TURN = "m-running";
/** NATS's default `max_payload`. */
const MAX_PAYLOAD = 1024 * 1024;

describe("a queued message that cannot be sent", { skip }, () => {
  let h: AdmissionCluster;
  let consumer: typeof import("../src/events/consumer.js");
  let dispatch: typeof import("../src/tasks/pending-dispatch.js");
  let quarantine: typeof import("../src/tasks/pending-quarantine.js");
  let sweeper: typeof import("../src/tasks/sweeper.js");
  let submit: typeof import("../src/sessions/submit-message.js");
  let secrets: typeof import("../src/tasks/run-secrets.js");
  let nats: typeof import("../src/infra/nats.js");
  let registry: typeof import("../src/infra/metrics.js")["registry"];
  let originalPorts: Record<string, unknown>;
  let originalQuarantinePorts: Record<string, unknown>;

  /** Execute requests that reached the task stream, in order. */
  let published: Array<Record<string, unknown>>;
  /** Session events published, in order. */
  let events: Array<Record<string, unknown>>;
  /** Publishes still to refuse as though NATS were away; counts down. */
  let natsDownFor: number;
  /** Whether a session-event publish should fail. */
  let eventsDown: boolean;
  /** Event types whose next publish fails; `lost` reaches the stream but its acknowledgement does not. */
  let failNext: Map<string, "refused" | "lost">;
  /** The deduplication id each session event was published under. */
  let eventIds: Array<string | undefined>;
  let seq: number;

  const rows = async (text: string, params: unknown[] = []) =>
    (await h.app.db.db.query(text, params)).rows as Array<Record<string, any>>;

  before(async () => {
    h = await startAdmissionCluster({ RUN_DOORBELL_DISPATCH: "false" });
    consumer = await import("../src/events/consumer.js");
    dispatch = await import("../src/tasks/pending-dispatch.js");
    quarantine = await import("../src/tasks/pending-quarantine.js");
    sweeper = await import("../src/tasks/sweeper.js");
    submit = await import("../src/sessions/submit-message.js");
    secrets = await import("../src/tasks/run-secrets.js");
    nats = await import("../src/infra/nats.js");
    registry = (await import("../src/infra/metrics.js")).registry;
    originalPorts = { ...dispatch.pendingDispatchPorts };
    originalQuarantinePorts = { ...quarantine.pendingQuarantinePorts };
    consumer.tombstoneReader.has = async () => false;
    // The default resource row every dispatch reads.
    await rows(`INSERT INTO resources (name, type, image, resource) VALUES ('default', 'default', 'img:1', '{"cpu":"1"}'::jsonb)`);
  });

  beforeEach(async () => {
    published = [];
    events = [];
    natsDownFor = 0;
    eventsDown = false;
    failNext = new Map();
    eventIds = [];
    seq = 1000 + Math.floor(Math.random() * 1_000_000);
    Object.assign(dispatch.pendingDispatchPorts, originalPorts, {
      // The fat branch: the turn itself is the payload, so its size is what the
      // server's limit is measured against.
      doorbellDispatch: () => null,
      async publish(_subject: string, payload: string): Promise<number> {
        if (natsDownFor > 0) {
          natsDownFor -= 1;
          throw Object.assign(new Error("503 no responders"), { code: "503" });
        }
        // What the nats.js client does before writing a byte (protocol.js).
        if (Buffer.byteLength(payload) > MAX_PAYLOAD) {
          throw Object.assign(new Error("MAX_PAYLOAD_EXCEEDED"), { code: "MAX_PAYLOAD_EXCEEDED", name: "NatsError" });
        }
        published.push(JSON.parse(payload));
        return published.length;
      },
      async publishSessionEvent(_sessionId: string, event: Record<string, unknown>, msgId?: string): Promise<void> {
        if (eventsDown) throw Object.assign(new Error("503 no responders"), { code: "503" });
        const failure = failNext.get(String(event.type));
        failNext.delete(String(event.type));
        if (failure === "refused") throw Object.assign(new Error("503 no responders"), { code: "503" });
        events.push(event);
        eventIds.push(msgId);
        if (failure === "lost") throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
      },
    });
    Object.assign(quarantine.pendingQuarantinePorts, originalQuarantinePorts);
    for (const table of [
      "claw_pending_messages", "claw_pending_messages_quarantine", "claw_tasks",
      "claw_session_events", "claw_conversation_turns", "claw_sessions",
    ]) await rows(`DELETE FROM ${table}`);
    await rows(
      `INSERT INTO claw_sessions (session_id, user_id, agent_status, agent_gate_message_id)
       VALUES ($1, $2, 'running', $3)`,
      [SESSION, USER, RUNNING_TURN],
    );
    await rows(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, metadata, input, prompt, queued_at, started_at)
       VALUES ('run-running', $1, 'chat', 'running', 'chat', 'brain', $2::jsonb, '{}'::jsonb, 'first', NOW(), NOW())`,
      [SESSION, JSON.stringify({ message_id: RUNNING_TURN, user_id: USER, dispatch: "fat" })],
    );
  });

  afterEach(() => {
    Object.assign(dispatch.pendingDispatchPorts, originalPorts);
    Object.assign(quarantine.pendingQuarantinePorts, originalQuarantinePorts);
  });

  after(async () => {
    await h?.stop();
  });

  /** Queue a message through the one statement that writes the queue. */
  async function enqueue(content: string, sessionEnv: Record<string, string> = {}): Promise<number> {
    const { id } = await submit.insertPendingMessage(h.app.db.db, {
      sessionId: SESSION,
      content,
      userId: USER,
      toolIds: [],
      secrets: secrets.pendingSecretColumns({ llmKey: "vk-poison", platformKey: "pk-poison", userEnv: {}, doorbell: false }),
      sessionEnv,
    });
    assert.ok(id !== null);
    return id;
  }

  /** The completion a Brain publishes when the running turn ends, through the consumer. */
  async function completeRunningTurn(): Promise<{ acks: number; naks: number }> {
    return deliver({
      type: "exec_complete", session_id: SESSION, task_id: "run-running", user_id: USER,
      message_id: RUNNING_TURN, prompt: "first", final_text: "done", failed: false,
      error_count: 0, skills_used: {},
    });
  }

  async function deliver(event: Record<string, unknown>): Promise<{ acks: number; naks: number }> {
    let acks = 0;
    let naks = 0;
    seq += 1;
    await consumer.consumeEventDelivery({
      subject: `events.${SESSION}`,
      data: nats.sc.encode(JSON.stringify(event)),
      seq,
      ack: () => { acks += 1; },
      nak: () => { naks += 1; },
    });
    return { acks, naks };
  }

  /** One sweeper pass over the orphaned queue, the way the tick runs it. */
  async function sweep(): Promise<number> {
    return sweeper.drainOrphanedPendingMessages();
  }

  async function queue(): Promise<Array<Record<string, any>>> {
    return rows(
      "SELECT id, content, drain_failures, drain_last_error FROM claw_pending_messages WHERE session_id = $1 ORDER BY id",
      [SESSION],
    );
  }

  async function counter(name: string): Promise<number> {
    // The registry carries a default `service` label, so a sample is `name{...} value`.
    const line = (await registry.metrics()).split("\n").find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
    return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
  }

  /** Move the first failure back, as though the window had passed. */
  async function windowPasses(pendingId: number): Promise<void> {
    await rows(
      "UPDATE claw_pending_messages SET drain_first_failed_at = NOW() - INTERVAL '11 minutes' WHERE id = $1",
      [pendingId],
    );
  }

  const prompts = () => published.map((t) => String(t.prompt).slice(0, 40));
  const notices = () => events.filter((e) => e.type === "exec_complete");

  test("Q1 a message that keeps failing is quarantined, and the one behind it is sent on the same drain", async () => {
    const poison = "x".repeat(MAX_PAYLOAD + 10);
    const poisonId = await enqueue(poison);
    const goodId = await enqueue("the message behind it");
    const failuresBefore = await counter("claw_api_pending_drain_failures_total");
    const quarantinedBefore = await counter("claw_api_pending_quarantined_total");

    // The completion drains the head, which fails: the delivery is naked for a
    // retry, as it always was, and the failure is counted on the row.
    const first = await completeRunningTurn();
    assert.equal(first.naks, 1, "a failed drain still asks for a retry");
    let q = await queue();
    assert.deepEqual(q.map((r) => r.id), [poisonId, goodId], "nothing behind the head has moved");
    assert.equal(q[0].drain_failures, 1);
    assert.match(q[0].drain_last_error, /MAX_PAYLOAD_EXCEEDED/);
    assert.ok(!q[0].drain_last_error.includes("xxxx"), "the recorded error never carries the message text");

    // Within the bound: the count alone is not enough while the window is open.
    await sweep();
    await sweep();
    q = await queue();
    assert.equal(q.length, 2, "three failures inside ten minutes are still retries");
    assert.equal(q[0].drain_failures, 3);
    assert.equal(published.length, 0, "nothing was sent while the head was failing");
    assert.equal(notices().length, 0);

    // Past both bounds the next failure isolates it, and the same drain goes on.
    await windowPasses(poisonId);
    await sweep();
    assert.deepEqual(await queue(), [], "the queue drained past the poison");
    assert.deepEqual(prompts(), ["the message behind it"], "the message behind it was sent");
    const [held] = await rows("SELECT * FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.ok(held, "the poison is kept, not dropped");
    assert.equal(held.content, poison, "with every byte the user sent");
    assert.equal(held.session_id, SESSION);
    assert.equal(held.user_id, USER);
    assert.equal(held.message_id, `claw-pending-${poisonId}`);
    assert.equal(held.attempts, 4);
    assert.match(held.last_error, /NatsError:MAX_PAYLOAD_EXCEEDED/);
    assert.ok(held.notified_at, "the notice was given");
    assert.equal(await counter("claw_api_pending_drain_failures_total") - failuresBefore, 4);
    assert.equal(await counter("claw_api_pending_quarantined_total") - quarantinedBefore, 1);

    // The good turn holds the session now, under its own message id.
    const [session] = await rows("SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = $1", [SESSION]);
    assert.equal(session.agent_status, "running");
    assert.equal(session.agent_gate_message_id, `claw-pending-${goodId}`);
  });

  test("Q2 the session is told once, and the notice leaves the next turn running", async () => {
    const poisonId = await enqueue("y".repeat(MAX_PAYLOAD + 10));
    const goodId = await enqueue("the message behind it");
    await completeRunningTurn();
    await sweep();
    await sweep();
    await windowPasses(poisonId);
    await sweep();

    const told = notices();
    assert.equal(told.length, 1, "exactly one notice");
    assert.equal(told[0].message_id, `claw-pending-${poisonId}`);
    assert.equal(told[0].failed, true);
    assert.equal(told[0].failure_reason, dispatch.PENDING_DRAIN_QUARANTINED);
    const reply = events.find((e) => e.type === "AssistantMessage") as { data: { content: Array<{ text: string }> } };
    assert.match(reply.data.content[0].text, /could not be sent after repeated attempts/);
    assert.match(reply.data.content[0].text, /can be sent again/);

    // The notice is delivered like any completion. It records the user's turn
    // and does not hand back the gate the next turn is holding.
    const delivered = await deliver(told[0]);
    assert.equal(delivered.acks, 1);
    const [session] = await rows("SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = $1", [SESSION]);
    assert.equal(session.agent_status, "running");
    assert.equal(session.agent_gate_message_id, `claw-pending-${goodId}`);
    const turns = await rows(
      "SELECT role FROM claw_conversation_turns WHERE session_id = $1 AND message_id = $2 ORDER BY role",
      [SESSION, `claw-pending-${poisonId}`],
    );
    assert.ok(turns.some((t) => t.role === "user"), "the user's message is in the conversation");

    // Nothing sends it again: not the sweeper's retry, not a second drain.
    await quarantine.retryQuarantineNotices();
    await rows("UPDATE claw_pending_messages_quarantine SET notice_claimed_at = NOW() - INTERVAL '1 hour'");
    await quarantine.retryQuarantineNotices();
    await sweep();
    assert.equal(notices().length, 1);

    // Not even when the stamp was lost after the notice went out: the recorded
    // completion is the notice, and the retry stamps it instead of sending again.
    await rows(
      `UPDATE claw_pending_messages_quarantine
          SET notified_at = NULL, notice_claimed_at = NULL, quarantined_at = NOW() - INTERVAL '2 minutes'`,
    );
    assert.equal(await quarantine.retryQuarantineNotices(), 1);
    assert.equal(notices().length, 1, "the lost stamp is restored, the notice is not repeated");
    const [restamped] = await rows("SELECT notified_at FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.ok(restamped.notified_at);
  });

  test("Q3 a failure that clears is retried and sent in order, never quarantined", async () => {
    const firstId = await enqueue("first queued");
    await enqueue("second queued");
    natsDownFor = 2;

    const delivered = await completeRunningTurn();
    assert.equal(delivered.naks, 1);
    await windowPasses(firstId);
    await sweep(); // the second failure: under the count, whatever the window says
    assert.equal((await queue()).length, 2);
    await sweep(); // NATS is back
    assert.deepEqual(prompts(), ["first queued"], "the first is sent first");
    assert.equal((await rows("SELECT 1 FROM claw_pending_messages_quarantine")).length, 0);
    assert.equal(notices().length, 0);

    // The second waits for the first turn's completion, as it always has.
    assert.equal((await queue()).length, 1);
  });

  test("Q4 a notice that cannot be published is retried by the sweeper, once", async () => {
    const poisonId = await enqueue("z".repeat(MAX_PAYLOAD + 10));
    await enqueue("the message behind it");
    await completeRunningTurn();
    await sweep();
    await sweep();
    await windowPasses(poisonId);
    eventsDown = true;
    await sweep();

    assert.deepEqual(prompts(), ["the message behind it"], "an unpublishable notice does not hold the queue");
    let [held] = await rows("SELECT notified_at, notice_attempts FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.equal(held.notified_at, null);

    eventsDown = false;
    // Claimed only once the quarantine is a minute old, so the drain that moved
    // it is not raced by every replica's sweeper.
    assert.equal(await quarantine.retryQuarantineNotices(), 0);
    await rows("UPDATE claw_pending_messages_quarantine SET quarantined_at = NOW() - INTERVAL '2 minutes'");
    assert.equal(await quarantine.retryQuarantineNotices(), 1);
    assert.equal(notices().length, 1);
    [held] = await rows("SELECT notified_at, notice_attempts FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.ok(held.notified_at);
    assert.equal(held.notice_attempts, 1);
    await rows("UPDATE claw_pending_messages_quarantine SET notice_claimed_at = NOW() - INTERVAL '1 hour'");
    assert.equal(await quarantine.retryQuarantineNotices(), 0);
    assert.equal(notices().length, 1, "and never twice");
  });

  test("Q5 a message whose reserved run is still open is not quarantined under it", async () => {
    const poisonId = await enqueue("the head");
    await enqueue("the message behind it");
    await rows(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, metadata, input, prompt, queued_at)
       VALUES ('run-reserved', $1, 'chat', 'preparing', 'chat', 'brain', $2::jsonb, '{}'::jsonb, 'the head', NOW())`,
      [SESSION, JSON.stringify({ message_id: `claw-pending-${poisonId}`, user_id: USER, dispatch: "fat" })],
    );
    await rows(
      `UPDATE claw_pending_messages
          SET dispatch_task_id = 'run-reserved', drain_failures = 9,
              drain_first_failed_at = NOW() - INTERVAL '1 hour'
        WHERE id = $1`,
      [poisonId],
    );
    const verdict = await quarantine.recordPendingDrainFailure(
      { sessionId: SESSION, pendingId: poisonId, userId: USER, content: "the head" },
      new Error("boom"),
    );
    assert.equal(verdict, "retry");
    assert.equal((await queue())[0].id, poisonId, "still at the head");
    assert.equal((await rows("SELECT 1 FROM claw_pending_messages_quarantine")).length, 0);
    assert.equal(notices().length, 0);
  });

  test("Q6 the gauges read the failing streak and the oldest message's age", async () => {
    assert.deepEqual(await quarantine.observePendingQueue(), { consecutiveFailures: 0, oldestAgeSeconds: 0 });
    const poisonId = await enqueue("w".repeat(MAX_PAYLOAD + 10));
    await rows("UPDATE claw_pending_messages SET created_at = NOW() - INTERVAL '15 hours' WHERE id = $1", [poisonId]);
    await completeRunningTurn();
    await sweep();
    const stalled = await quarantine.observePendingQueue();
    assert.equal(stalled.consecutiveFailures, 2);
    assert.ok(stalled.oldestAgeSeconds >= 15 * 3600 - 5);
    const text = await registry.metrics();
    assert.match(text, /^claw_api_pending_messages_consecutive_failures(\{[^}]*\})? 2$/m);
    assert.match(text, /^claw_api_pending_messages_oldest_age_seconds(\{[^}]*\})? \d+/m);

    await windowPasses(poisonId);
    await sweep();
    assert.deepEqual(await quarantine.observePendingQueue(), { consecutiveFailures: 0, oldestAgeSeconds: 0 });
    assert.match(await registry.metrics(), /^claw_api_pending_messages_consecutive_failures(\{[^}]*\})? 0$/m);
  });

  test("Q7 a NUL or a lone surrogate is queued as U+FFFD, where the database refuses it raw", async () => {
    const hostile = "before\u0000after \uD800 lone \uDC00 pair 😀 end";
    // The database's own limit, shown rather than asserted from memory: TEXT
    // refuses the NUL byte and jsonb refuses both escapes.
    await assert.rejects(
      rows("INSERT INTO claw_pending_messages (session_id, content) VALUES ($1, $2)", [SESSION, hostile]),
      (err: { code?: string }) => err.code === "22021",
    );
    await assert.rejects(rows("SELECT $1::jsonb", [JSON.stringify({ v: "a\u0000b" })]), (err: { code?: string }) => err.code === "22P05");
    await assert.rejects(rows("SELECT $1::jsonb", [JSON.stringify({ v: "a\uD800b" })]), (err: { code?: string }) => err.code === "22P02");

    const id = await enqueue(hostile, { ["K\u0000"]: "v\uDC00" });
    const [row] = await rows("SELECT content, session_env FROM claw_pending_messages WHERE id = $1", [id]);
    assert.equal(row.content, "before�after � lone � pair 😀 end", "a whole pair is kept");
    assert.deepEqual(row.session_env, { "K�": "v�" });

    // And it is sent like any other message.
    await completeRunningTurn();
    assert.equal(published.length, 1);
    assert.equal(published[0].prompt, row.content);
  });

  test("Q8 a deleted session takes its quarantined messages with it", async () => {
    const poisonId = await enqueue("v".repeat(MAX_PAYLOAD + 10));
    await completeRunningTurn();
    await sweep();
    await windowPasses(poisonId);
    await sweep();
    assert.equal((await rows("SELECT 1 FROM claw_pending_messages_quarantine WHERE session_id = $1", [SESSION])).length, 1);
    const { commitSessionDeletion } = await import("../src/sessions/teardown.js");
    assert.equal(await commitSessionDeletion(SESSION), true);
    assert.equal((await rows("SELECT 1 FROM claw_pending_messages_quarantine WHERE session_id = $1", [SESSION])).length, 0);
  });

  /** Quarantine a poison message the way Q1 does, with whatever the event publishes are set to do. */
  async function quarantinePoison(): Promise<number> {
    const poisonId = await enqueue("p".repeat(MAX_PAYLOAD + 10));
    await enqueue("the message behind it");
    await completeRunningTurn();
    await sweep();
    await sweep();
    await windowPasses(poisonId);
    await sweep();
    return poisonId;
  }

  /** Deliver every event published so far through the consumer, and count what it stored for one message. */
  async function storedEvents(messageId: string): Promise<Record<string, number>> {
    for (const event of events) await deliver(event);
    const stored = await rows(
      `SELECT event, COUNT(*)::int AS n FROM claw_session_events
        WHERE session_id = $1 AND data->>'message_id' = $2 GROUP BY event`,
      [SESSION, messageId],
    );
    return Object.fromEntries(stored.map((r) => [r.event, r.n]));
  }

  test("Q9 a notice that failed part-way is finished on retry, and nothing in it is sent twice", async () => {
    // The reply went out; the publish after it was refused.
    failNext.set("ResultMessage", "refused");
    const poisonId = await quarantinePoison();
    const messageId = `claw-pending-${poisonId}`;
    assert.deepEqual(prompts(), ["the message behind it"]);
    let [held] = await rows("SELECT notified_at, notice_events FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.equal(held.notified_at, null, "an unfinished notice is left for the sweeper");
    assert.equal(held.notice_events, 1, "and what of it went out is recorded");

    // The next attempt: this time the publish reaches the stream and its
    // acknowledgement is lost, so the attempt fails having sent it.
    failNext.set("ResultMessage", "lost");
    await rows("UPDATE claw_pending_messages_quarantine SET quarantined_at = NOW() - INTERVAL '2 minutes'");
    assert.equal(await quarantine.retryQuarantineNotices(), 0);
    [held] = await rows("SELECT notified_at, notice_events FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.equal(held.notice_events, 1, "an unacknowledged publish is not counted as out");

    // And the one after that finishes it.
    await rows("UPDATE claw_pending_messages_quarantine SET notice_claimed_at = NOW() - INTERVAL '2 minutes'");
    assert.equal(await quarantine.retryQuarantineNotices(), 1);
    [held] = await rows("SELECT notified_at, notice_events FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.ok(held.notified_at);
    assert.equal(held.notice_events, 3);

    const mine = events.map((e, i) => ({ type: e.type, id: eventIds[i], messageId: e.message_id }))
      .filter((e) => e.messageId === messageId);
    assert.deepEqual(mine.map((e) => e.type), ["AssistantMessage", "ResultMessage", "ResultMessage", "exec_complete"],
      "the reply is never repeated; only the publish whose acknowledgement was lost is sent again");
    const key = `claw_pending_messages_quarantine:${poisonId}`;
    assert.deepEqual(mine.map((e) => e.id), [`${key}:0`, `${key}:1`, `${key}:1`, `${key}:2`],
      "under the same id each time, which the event stream drops as a duplicate");

    // What the session keeps, through the real consumer: one reply and one completion.
    const stored = await storedEvents(messageId);
    assert.equal(stored.AssistantMessage, 1, "the user is told once");
    assert.equal(stored.exec_complete, 1);
  });

  /** Queue a message whose sealed credentials will not open, as a truncated blob reads. */
  async function enqueueUnreadable(content: string): Promise<number> {
    const id = await enqueue(content);
    await rows("UPDATE claw_pending_messages SET credentials_blob = 'dHJ1bmNhdGVk' WHERE id = $1", [id]);
    return id;
  }

  test("Q10 unreadable credentials quarantine the message at once and count it, even when the notice fails", async () => {
    const badId = await enqueueUnreadable("sealed with a key that is gone");
    await enqueue("the message behind it");
    const failuresBefore = await counter("claw_api_pending_drain_failures_total");
    const quarantinedBefore = await counter("claw_api_pending_quarantined_total");
    eventsDown = true;

    const delivered = await completeRunningTurn();
    assert.equal(delivered.acks, 1, "the completion is handled, not redelivered");
    assert.deepEqual(await queue(), [], "the unreadable message left the queue");
    assert.deepEqual(prompts(), ["the message behind it"], "and the message behind it was sent");
    const [held] = await rows("SELECT * FROM claw_pending_messages_quarantine WHERE id = $1", [badId]);
    assert.ok(held, "kept, not dropped");
    assert.equal(held.content, "sealed with a key that is gone");
    assert.equal(held.failure_reason, "credentials_unreadable");
    assert.equal(held.attempts, 1);
    assert.ok(held.last_error);
    assert.equal(held.notified_at, null);
    assert.equal(await counter("claw_api_pending_quarantined_total") - quarantinedBefore, 1);
    assert.equal(await counter("claw_api_pending_drain_failures_total") - failuresBefore, 1);
    assert.equal(notices().length, 0);

    // The sweeper gives the notice, once, as the refusal it is.
    eventsDown = false;
    await rows("UPDATE claw_pending_messages_quarantine SET quarantined_at = NOW() - INTERVAL '2 minutes'");
    assert.equal(await quarantine.retryQuarantineNotices(), 1);
    await rows("UPDATE claw_pending_messages_quarantine SET notice_claimed_at = NOW() - INTERVAL '1 hour'");
    assert.equal(await quarantine.retryQuarantineNotices(), 0);
    const told = notices();
    assert.equal(told.length, 1);
    assert.equal(told[0].message_id, `claw-pending-${badId}`);
    assert.equal(told[0].failure_reason, "credentials_unreadable");
    const stored = await storedEvents(`claw-pending-${badId}`);
    assert.equal(stored.AssistantMessage, 1);
    assert.equal(stored.exec_complete, 1);
  });

  test("Q11 unreadable credentials that cannot be moved are a counted, retried failure", async () => {
    const badId = await enqueueUnreadable("the head");
    const goodId = await enqueue("the message behind it");
    const quarantinedBefore = await counter("claw_api_pending_quarantined_total");
    const failuresBefore = await counter("claw_api_pending_drain_failures_total");
    // The database refuses the move itself, the way any failed statement would.
    await rows(
      `ALTER TABLE claw_pending_messages_quarantine
         ADD CONSTRAINT q11_refuse CHECK (failure_reason IS DISTINCT FROM 'credentials_unreadable') NOT VALID`,
    );
    try {
      const delivered = await completeRunningTurn();
      assert.equal(delivered.naks, 1, "raised for a retry, as a failed drain is");
      const q = await queue();
      assert.deepEqual(q.map((r) => r.id), [badId, goodId], "still at the head, nothing behind it moved");
      assert.equal(q[0].drain_failures, 1, "and the failure is counted on the row");
      assert.match(q[0].drain_last_error, /23514|q11_refuse/);
      assert.equal((await rows("SELECT 1 FROM claw_pending_messages_quarantine")).length, 0);
      assert.equal(events.length, 0, "nobody is told of a refusal that did not happen");
    } finally {
      await rows("ALTER TABLE claw_pending_messages_quarantine DROP CONSTRAINT q11_refuse");
    }

    // The next drain moves it and goes on.
    await sweep();
    assert.deepEqual(await queue(), []);
    assert.deepEqual(prompts(), ["the message behind it"]);
    const [held] = await rows("SELECT attempts, notified_at FROM claw_pending_messages_quarantine WHERE id = $1", [badId]);
    assert.equal(held.attempts, 2, "both attempts are on the record");
    assert.ok(held.notified_at);
    assert.equal(await counter("claw_api_pending_quarantined_total") - quarantinedBefore, 1);
    assert.equal(await counter("claw_api_pending_drain_failures_total") - failuresBefore, 2, "one per attempt");
    assert.equal(notices().length, 1);
  });
});
