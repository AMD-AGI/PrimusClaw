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
 *   Q12 one sealed under a key this replica does not hold is retried within its
 *       bounds, not quarantined at once, and the replica that holds the key sends it
 *   Q13 a notice that may have stored an event is retried up to the horizon,
 *       and given up on past it, never published after the event stream has
 *       forgotten its ids; one that never could have is given whenever NATS
 *       is back, past the horizon and past its attempts
 *   Q14 a NATS outage longer than both bounds quarantines nothing: every queued
 *       message waits, and is sent in order once NATS is back
 *   Q15 a notice attempt that never recorded its outcome is read as one that
 *       may have stored an event
 *   Q16 a publish TIMEOUT while NATS answers nobody -- what a full server
 *       outage raises -- is not counted, past both bounds, and the queue is
 *       sent in order once NATS is back
 *   Q17 a message whose own publish times out while NATS answers everything
 *       else is counted and quarantined, and the message behind it is sent
 *   Q18 a notice is not attempted while NATS answers nobody, and one whose
 *       attempt timed out because NATS went away is not charged for it; it is
 *       given, once, when NATS is back
 *   Q19 a message that failed as many times as the bound allows, but inside
 *       the window, and then recovers is sent, not refused as spent
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

/** An error as the nats.js client raises it: a `NatsError` with the client's code. */
function natsError(code: "503" | "TIMEOUT"): Error {
  return Object.assign(new Error(code === "503" ? "503" : "TIMEOUT"), { name: "NatsError", code });
}

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
  /** Task publishes that time out, by the prompt they carry. */
  let timesOut: (prompt: string) => boolean;
  /** Whether the streams answer the probe that tells NATS away from a slow request. */
  let natsAnswers: boolean;
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
    timesOut = () => false;
    natsAnswers = true;
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
          throw natsError("503");
        }
        if (timesOut(String(JSON.parse(payload).prompt))) throw natsError("TIMEOUT");
        // What the nats.js client does before writing a byte (protocol.js).
        if (Buffer.byteLength(payload) > MAX_PAYLOAD) {
          throw Object.assign(new Error("MAX_PAYLOAD_EXCEEDED"), { code: "MAX_PAYLOAD_EXCEEDED", name: "NatsError" });
        }
        published.push(JSON.parse(payload));
        return published.length;
      },
      async publishSessionEvent(_sessionId: string, event: Record<string, unknown>, msgId?: string): Promise<void> {
        if (eventsDown) throw natsError("503");
        const failure = failNext.get(String(event.type));
        failNext.delete(String(event.type));
        if (failure === "refused") throw natsError("503");
        events.push(event);
        eventIds.push(msgId);
        if (failure === "lost") throw natsError("TIMEOUT");
      },
    });
    Object.assign(quarantine.pendingQuarantinePorts, originalQuarantinePorts, {
      natsStreamsAnswer: async () => natsAnswers,
    });
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

  /** Seal credentials under another key, as a replica holding a different key wrote them, and load ours back. */
  async function sealedUnder(key: string, creds: { llm_api_key: string; platform_key: string }): Promise<string> {
    const crypto = await import("../src/crypto/user-env.js");
    const ours = process.env.USER_ENV_ENCRYPTION_KEY;
    try {
      process.env.USER_ENV_ENCRYPTION_KEY = key;
      crypto.initUserEnvCrypto();
      return secrets.sealRunCredentials(creds);
    } finally {
      process.env.USER_ENV_ENCRYPTION_KEY = ours;
      crypto.initUserEnvCrypto();
    }
  }

  /** Run `fn` as the replica that holds `key`. */
  async function asReplicaWith<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const crypto = await import("../src/crypto/user-env.js");
    const ours = process.env.USER_ENV_ENCRYPTION_KEY;
    try {
      process.env.USER_ENV_ENCRYPTION_KEY = key;
      crypto.initUserEnvCrypto();
      return await fn();
    } finally {
      process.env.USER_ENV_ENCRYPTION_KEY = ours;
      crypto.initUserEnvCrypto();
    }
  }

  test("Q12 credentials another key opens are retried within their bounds, and the replica with the key sends them", async () => {
    const otherKey = Buffer.alloc(32, 9).toString("base64");
    const blob = await sealedUnder(otherKey, { llm_api_key: "vk-other-replica", platform_key: "pk-other-replica" });
    const headId = await enqueue("sealed by the other key");
    await rows("UPDATE claw_pending_messages SET credentials_blob = $2 WHERE id = $1", [headId, blob]);
    await enqueue("the message behind it");
    const quarantinedBefore = await counter("claw_api_pending_quarantined_total");

    // This replica's key does not authenticate the blob. That is also what a
    // replica with a stale key sees, so the row is not moved on it.
    const delivered = await completeRunningTurn();
    assert.equal(delivered.naks, 1, "a failed drain, retried as any other");
    let q = await queue();
    assert.equal(q[0].id, headId, "still at the head");
    assert.equal(q[0].drain_failures, 1, "and counted");
    assert.match(q[0].drain_last_error, /RunCredentialFault/);
    assert.equal((await rows("SELECT 1 FROM claw_pending_messages_quarantine")).length, 0, "not quarantined on one replica's say");
    assert.equal(events.length, 0, "and nobody is told it was refused");
    assert.equal(await counter("claw_api_pending_quarantined_total") - quarantinedBefore, 0);

    // The replica that holds the key drains it next, and it is sent with the keys it was sealed with.
    await asReplicaWith(otherKey, () => sweep());
    q = await queue();
    assert.deepEqual(q.map((r) => r.content), ["the message behind it"]);
    assert.deepEqual(prompts(), ["sealed by the other key"]);
    assert.equal(published[0].llm_api_key, "vk-other-replica");
    assert.equal(published[0].platform_key, "pk-other-replica");
    assert.equal(notices().length, 0);
  });

  test("Q12b credentials no replica opens on any attempt are quarantined past their bounds, as unreadable", async () => {
    const blob = await sealedUnder(Buffer.alloc(32, 11).toString("base64"), { llm_api_key: "k", platform_key: "p" });
    const headId = await enqueue("sealed by a key that is gone");
    await rows("UPDATE claw_pending_messages SET credentials_blob = $2 WHERE id = $1", [headId, blob]);
    await enqueue("the message behind it");
    await completeRunningTurn();
    await sweep();
    await sweep();
    assert.equal((await queue())[0].id, headId, "three failures inside the window are still retries");
    await windowPasses(headId);
    await sweep();
    assert.deepEqual(prompts(), ["the message behind it"]);
    const [held] = await rows("SELECT failure_reason, attempts, notified_at FROM claw_pending_messages_quarantine WHERE id = $1", [headId]);
    assert.equal(held.failure_reason, "credentials_unreadable");
    assert.equal(held.attempts, 4);
    assert.ok(held.notified_at);
    assert.equal(notices().length, 1);
    assert.equal(notices()[0].failure_reason, "credentials_unreadable");
  });

  /**
   * Quarantine a poison whose notice could not be published, and age the
   * quarantine, and the attempt that failed, by `ageSec`. `refused`: NATS said
   * no stream was there, so nothing was stored. `lost`: the reply reached the
   * stream and its acknowledgement did not.
   */
  async function unsentNoticeAged(ageSec: number, failure: "refused" | "lost"): Promise<number> {
    if (failure === "refused") eventsDown = true;
    else failNext.set("AssistantMessage", "lost");
    const poisonId = await quarantinePoison();
    eventsDown = false;
    failNext.clear();
    const [held] = await rows(
      "SELECT notified_at, notice_events, notice_started_at, notice_unsure_since, notice_attempts FROM claw_pending_messages_quarantine WHERE id = $1",
      [poisonId],
    );
    assert.equal(held.notified_at, null);
    assert.equal(held.notice_events, 0);
    assert.equal(held.notice_started_at, null, "the attempt's outcome is recorded");
    assert.equal(held.notice_attempts, 0);
    if (failure === "refused") assert.equal(held.notice_unsure_since, null, "a refused publish stored nothing");
    else assert.ok(held.notice_unsure_since, "an unacknowledged publish may be on the stream");
    await rows(
      `UPDATE claw_pending_messages_quarantine
          SET quarantined_at = quarantined_at - make_interval(secs => $2),
              notice_unsure_since = notice_unsure_since - make_interval(secs => $2)
        WHERE id = $1`,
      [poisonId, ageSec],
    );
    return poisonId;
  }

  test("Q13 a notice is retried up to the horizon, which the stream's duplicate window covers twice over", async () => {
    assert.ok(quarantine.QUARANTINE_NOTICE_RETRY_HORIZON_SEC >= 10 * 60, "ten attempts a minute apart fit inside it");
    assert.ok(
      quarantine.QUARANTINE_NOTICE_RETRY_HORIZON_SEC * 1000 <= nats.EVENT_STREAM_DUPLICATE_WINDOW_MS / 2,
      "the horizon leaves half the stream's duplicate window for a slow publish",
    );
    const poisonId = await unsentNoticeAged(quarantine.QUARANTINE_NOTICE_RETRY_HORIZON_SEC - 30, "lost");
    events = [];
    eventIds = [];
    assert.equal(await quarantine.retryQuarantineNotices(), 1);
    assert.equal(notices().length, 1);
    const [held] = await rows("SELECT notified_at FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.ok(held.notified_at);
  });

  test("Q13b a notice that may have stored an event is given up on past the horizon, never published", async () => {
    // The event stream may have forgotten the ids the earlier attempt stored
    // under, so a retry now could tell the user twice.
    const poisonId = await unsentNoticeAged(quarantine.QUARANTINE_NOTICE_RETRY_HORIZON_SEC + 30, "lost");
    events = [];
    assert.equal(await quarantine.retryQuarantineNotices(), 0);
    assert.equal(events.length, 0, "nothing is published past the horizon");
    const [held] = await rows("SELECT notified_at, notice_attempts FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.equal(held.notified_at, null);
    assert.equal(held.notice_attempts, 10, "marked given up on, so no later sweep picks it up");
    await rows("UPDATE claw_pending_messages_quarantine SET notice_claimed_at = NULL");
    assert.equal(await quarantine.retryQuarantineNotices(), 0);
    assert.equal(events.length, 0);
  });

  test("Q13c a notice NATS refused for longer than the horizon and every attempt is given once NATS is back", async () => {
    const poisonId = await unsentNoticeAged(30, "refused");
    const quarantinedAt = async () =>
      (await rows("SELECT notified_at, notice_attempts, notice_unsure_since FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]))[0];

    // NATS stays away: a sweeper retry a minute apart, three times as many as
    // the attempts a notice is given, reaching well past the horizon.
    eventsDown = true;
    for (let i = 0; i < 30; i++) {
      await rows(
        `UPDATE claw_pending_messages_quarantine
            SET quarantined_at = quarantined_at - INTERVAL '61 seconds',
                notice_claimed_at = notice_claimed_at - INTERVAL '61 seconds'
          WHERE id = $1`,
        [poisonId],
      );
      assert.equal(await quarantine.retryQuarantineNotices(), 0);
    }
    let held = await quarantinedAt();
    assert.equal(held.notified_at, null);
    assert.equal(held.notice_unsure_since, null, "no attempt stored anything");
    assert.ok(held.notice_attempts < 10, "a refused attempt is not one of the notice's attempts");
    const [age] = await rows("SELECT EXTRACT(EPOCH FROM NOW() - quarantined_at)::int AS sec FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.ok(age.sec > quarantine.QUARANTINE_NOTICE_RETRY_HORIZON_SEC, "past the horizon");
    assert.equal(events.length, 0);

    // NATS is back: the user is told, once.
    eventsDown = false;
    await rows("UPDATE claw_pending_messages_quarantine SET notice_claimed_at = notice_claimed_at - INTERVAL '61 seconds' WHERE id = $1", [poisonId]);
    assert.equal(await quarantine.retryQuarantineNotices(), 1);
    held = await quarantinedAt();
    assert.ok(held.notified_at);
    assert.equal(notices().length, 1);
    assert.equal(notices()[0].message_id, `claw-pending-${poisonId}`);
    const stored = await storedEvents(`claw-pending-${poisonId}`);
    assert.equal(stored.AssistantMessage, 1, "the user is told once");
    assert.equal(stored.exec_complete, 1);
  });

  test("Q14 a NATS outage longer than both bounds quarantines nothing, and the queue is sent in order once it is back", async () => {
    const firstId = await enqueue("first queued");
    await enqueue("second queued");
    natsDownFor = Number.MAX_SAFE_INTEGER;

    // Twice the attempts, and past the window: what a twenty-minute outage
    // looks like to the queue's head.
    const delivered = await completeRunningTurn();
    assert.equal(delivered.naks, 1, "a failed drain still asks for a retry");
    for (let i = 0; i < 5; i++) await sweep();
    await windowPasses(firstId);
    for (let i = 0; i < 5; i++) await sweep();
    const q = await queue();
    assert.deepEqual(q.map((r) => r.content), ["first queued", "second queued"], "nothing left the queue");
    assert.equal(q[0].drain_failures, 0, "an unreachable NATS is not counted against the message");
    assert.match(q[0].drain_last_error, /NatsError:503/, "but is recorded on it");
    assert.equal((await rows("SELECT 1 FROM claw_pending_messages_quarantine")).length, 0);
    assert.equal(events.length, 0, "nobody is told a good message was refused");
    assert.equal(published.length, 0);

    // NATS is back: the head is sent, first.
    natsDownFor = 0;
    await sweep();
    assert.deepEqual(prompts(), ["first queued"]);
    assert.deepEqual((await queue()).map((r) => r.content), ["second queued"]);
  });

  test("Q15 a notice attempt that never recorded its outcome may have stored an event", async () => {
    // The attempt's replica died between its publish and the record of it.
    const poisonId = await unsentNoticeAged(30, "refused");
    await rows(
      `UPDATE claw_pending_messages_quarantine
          SET notice_started_at = NOW() - INTERVAL '2 minutes', notice_claimed_at = NOW() - INTERVAL '2 minutes'
        WHERE id = $1`,
      [poisonId],
    );
    eventsDown = true;
    assert.equal(await quarantine.retryQuarantineNotices(), 0);
    let [held] = await rows("SELECT notice_unsure_since, notice_attempts FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.ok(held.notice_unsure_since, "the unrecorded attempt is taken as one that may have stored an event");
    assert.equal(held.notice_attempts, 0, "this attempt itself was refused, and is not counted");

    // So the horizon applies from that attempt, and past it the notice is given up on.
    eventsDown = false;
    await rows(
      `UPDATE claw_pending_messages_quarantine
          SET notice_unsure_since = notice_unsure_since - make_interval(secs => $2),
              notice_claimed_at = notice_claimed_at - INTERVAL '2 minutes'
        WHERE id = $1`,
      [poisonId, quarantine.QUARANTINE_NOTICE_RETRY_HORIZON_SEC],
    );
    assert.equal(await quarantine.retryQuarantineNotices(), 0);
    assert.equal(events.length, 0);
    [held] = await rows("SELECT notified_at, notice_attempts FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.equal(held.notified_at, null);
    assert.equal(held.notice_attempts, 10);
  });

  test("Q16 a TIMEOUT while NATS answers nobody is not counted, and the queue is sent in order once it is back", async () => {
    // What the real client raises for every request while the server is down
    // or the connection is being re-established (measured against nats-server).
    const firstId = await enqueue("first queued");
    await enqueue("second queued");
    timesOut = () => true;
    natsAnswers = false;

    // Each timed-out publish leaves its run open until the sweeper finds
    // nothing was delivered; then the next drain publishes again, and times out.
    const delivered = await completeRunningTurn();
    assert.equal(delivered.naks, 1, "a failed drain still asks for a retry");
    for (let i = 0; i < 10; i++) {
      if (i === 5) await windowPasses(firstId);
      await reapUndeliveredRun(firstId);
      await sweep();
    }
    const q = await queue();
    assert.deepEqual(q.map((r) => r.content), ["first queued", "second queued"], "nothing left the queue");
    assert.equal(q[0].drain_failures, 0, "a timeout during an outage is not counted against the message");
    assert.match(q[0].drain_last_error, /NatsError:TIMEOUT/, "but is recorded on it");
    assert.equal((await rows("SELECT 1 FROM claw_pending_messages_quarantine")).length, 0);
    assert.equal(events.length, 0, "nobody is told a good message was refused");

    // NATS is back: the head is sent, first.
    timesOut = () => false;
    natsAnswers = true;
    await reapUndeliveredRun(firstId);
    await sweep();
    assert.deepEqual(prompts(), ["first queued"]);
    assert.deepEqual((await queue()).map((r) => r.content), ["second queued"]);
  });

  test("Q17 a message whose own publish times out while NATS answers is quarantined, and the one behind it is sent", async () => {
    const slowId = await enqueue("the turn that always times out");
    await enqueue("the message behind it");
    timesOut = (prompt) => prompt.startsWith("the turn that always");

    // A timed-out publish may be on the stream, so its run stays open until the
    // sweeper finds nothing was delivered; each attempt is one such cycle.
    await completeRunningTurn();
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await sweep();
      const [head] = await queue();
      assert.equal(head.id, slowId);
      assert.equal(head.drain_failures, attempt, "each timeout is counted while the streams answer");
      assert.match(head.drain_last_error, /NatsError:TIMEOUT/);
      await sweep();
      assert.equal((await queue())[0].drain_failures, attempt, "an open run is waited for, not sent again");
      await reapUndeliveredRun(slowId);
    }
    assert.equal(published.length, 0);
    await windowPasses(slowId);
    await sweep();

    assert.deepEqual(await queue(), [], "the queue drained past it");
    assert.deepEqual(prompts(), ["the message behind it"]);
    const [held] = await rows("SELECT attempts, last_error, notified_at FROM claw_pending_messages_quarantine WHERE id = $1", [slowId]);
    assert.ok(held, "kept, not dropped");
    assert.equal(held.attempts, 4);
    assert.match(held.last_error, /NatsError:TIMEOUT/, "why it failed, not the refusal to send it again");
    assert.ok(held.notified_at);
    assert.equal(notices().length, 1);
    assert.equal(notices()[0].message_id, `claw-pending-${slowId}`);
  });

  test("Q19 a message that fails its bound of times inside the window and then recovers is sent, not refused as spent", async () => {
    const slowId = await enqueue("the turn that times out for a while");
    await enqueue("the message behind it");
    timesOut = (prompt) => prompt.startsWith("the turn that times out");

    await completeRunningTurn();
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await sweep();
      assert.equal((await queue())[0].drain_failures, attempt, "each timeout is counted while the streams answer");
      await reapUndeliveredRun(slowId);
    }

    // Failed as often as the bound allows, but the window has not passed.
    timesOut = () => false;
    await sweep();
    assert.deepEqual(prompts(), ["the turn that times out for a while"], "sent once it goes through, in order");
    assert.deepEqual((await queue()).map((r) => r.content), ["the message behind it"]);
    assert.equal((await rows("SELECT 1 FROM claw_pending_messages_quarantine")).length, 0, "nothing quarantined");
    assert.equal(notices().length, 0, "nobody is told a good message was refused");
  });

  /**
   * What the sweeper does with the run of a publish that timed out once the
   * task stream says nothing is in flight: closes it as never delivered, and
   * hands the session back.
   */
  async function reapUndeliveredRun(pendingId: number): Promise<void> {
    const [run] = await rows(
      `UPDATE claw_tasks SET started_at = NOW() - INTERVAL '2 days', queued_at = NOW() - INTERVAL '2 days'
        WHERE task_id = (SELECT dispatch_task_id FROM claw_pending_messages WHERE id = $1)
        RETURNING task_id, status`,
      [pendingId],
    );
    assert.ok(run, "the timed-out publish left its run");
    const settlement = sweeper.sweeperPorts.deliverySettlement;
    sweeper.sweeperPorts.deliverySettlement = async () => ({ ackFloor: 1, lastSeq: 1 });
    try {
      assert.equal(await sweeper.reapOrphanedFatRuns(), 1, `the run (${run.status}) is reaped`);
    } finally {
      sweeper.sweeperPorts.deliverySettlement = settlement;
    }
    await sweeper.finalizeDispatchCompensations();
  }

  test("Q18 a notice waits out a NATS outage uncharged, and is given once NATS is back", async () => {
    // Quarantined while NATS is away: the client refuses an oversized turn by
    // itself, so a poison can be quarantined during an outage.
    natsAnswers = false;
    const poisonId = await quarantinePoison();
    const held = async () => (await rows(
      `SELECT notified_at, notice_attempts, notice_started_at, notice_unsure_since, notice_events
         FROM claw_pending_messages_quarantine WHERE id = $1`,
      [poisonId],
    ))[0];
    let h0 = await held();
    assert.ok(h0, "quarantined");
    assert.equal(events.length, 0, "no notice is attempted while NATS answers nobody");
    assert.equal(h0.notice_started_at, null, "the attempt that was not made is settled");
    assert.equal(h0.notice_unsure_since, null, "and stored nothing");

    // Past the notice's attempts and past its horizon, a sweeper retry a minute apart.
    const ageMinute = () => rows(
      `UPDATE claw_pending_messages_quarantine
          SET quarantined_at = quarantined_at - INTERVAL '61 seconds',
              notice_claimed_at = notice_claimed_at - INTERVAL '61 seconds'
        WHERE id = $1`,
      [poisonId],
    );
    for (let i = 0; i < 40; i++) {
      await ageMinute();
      assert.equal(await quarantine.retryQuarantineNotices(), 0);
    }
    h0 = await held();
    assert.equal(h0.notice_attempts, 0, "no attempt is begun while NATS is away");
    assert.equal(events.length, 0);

    // The probe answers, then the outage starts under the attempt: the reply
    // times out and may be in the client's buffer, so the attempt may have
    // stored it, but it failed for the outage and is not one of the notice's
    // attempts.
    natsAnswers = true;
    const realPublish = dispatch.pendingDispatchPorts.publishSessionEvent;
    dispatch.pendingDispatchPorts.publishSessionEvent = async (sessionId, event, msgId) => {
      if (event.type === "AssistantMessage") {
        natsAnswers = false;
        throw natsError("TIMEOUT");
      }
      return realPublish(sessionId, event, msgId);
    };
    await ageMinute();
    assert.equal(await quarantine.retryQuarantineNotices(), 0);
    dispatch.pendingDispatchPorts.publishSessionEvent = realPublish;
    h0 = await held();
    assert.equal(h0.notified_at, null);
    assert.equal(h0.notice_attempts, 0, "an attempt that timed out while NATS was away is given back");
    assert.equal(h0.notice_started_at, null);
    assert.ok(h0.notice_unsure_since, "but what it may have stored starts the horizon");

    // NATS is back: the user is told, once.
    natsAnswers = true;
    await ageMinute();
    assert.equal(await quarantine.retryQuarantineNotices(), 1);
    h0 = await held();
    assert.ok(h0.notified_at);
    assert.equal(h0.notice_attempts, 1);
    const stored = await storedEvents(`claw-pending-${poisonId}`);
    assert.equal(stored.AssistantMessage, 1, "the user is told once");
    assert.equal(stored.exec_complete, 1);
  });
});
