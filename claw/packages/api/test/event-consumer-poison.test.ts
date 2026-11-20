// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One bad event cannot hold up the event consumer.
 *
 * Driven through `consumeEventDelivery` against a real Postgres whose schema
 * `initDb` built, with events shaped as Brain publishes them (`JSON.stringify`
 * of the event object, which writes a NUL as `\u0000` and a lone surrogate as
 * `\ud800`, the two escapes `jsonb` refuses).
 *
 * - An event carrying either character is stored with U+FFFD in its place, and
 *   a completion carrying one still runs: its turn is written and its row is
 *   marked processed.
 * - An event that keeps failing is set aside with a durable copy once it has
 *   had its deliveries and other events are being stored -- and never while
 *   nothing is being stored, which is what an outage looks like.
 *
 * Skipped without DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const SESSION = "s-poison";
const OTHER = "s-healthy";
const RUN = "run-poison";
const NUL = String.fromCharCode(0);
const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdc00);
const PAIR = "\u{1F600}";

describe("event consumer: unstorable input and poison events", { skip }, () => {
  let h: AdmissionCluster;
  let consumer: typeof import("../src/events/consumer.js");
  let poison: typeof import("../src/events/poison.js");
  let registry: typeof import("../src/infra/metrics.js")["registry"];
  let originalPorts: Record<string, unknown>;
  let originalTombstone: (id: string) => Promise<boolean>;
  let originalPolicy: typeof import("../src/events/poison.js")["eventQuarantinePolicy"];
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  before(async () => {
    h = await startAdmissionCluster({ CLAW_NOTIFICATIONS_ENABLED: "false" });
    consumer = await import("../src/events/consumer.js");
    poison = await import("../src/events/poison.js");
    registry = (await import("../src/infra/metrics.js")).registry;
    originalPorts = { ...consumer.completionPorts };
    originalTombstone = consumer.tombstoneReader.has;
    originalPolicy = { ...poison.eventQuarantinePolicy };
    consumer.tombstoneReader.has = async () => false;
  });
  after(async () => {
    if (consumer) {
      Object.assign(consumer.completionPorts, originalPorts);
      consumer.tombstoneReader.has = originalTombstone;
      Object.assign(poison.eventQuarantinePolicy, originalPolicy);
    }
    await new Promise<void>((r) => setTimeout(r, 50));
    await h?.stop();
  });
  beforeEach(async () => {
    (await import("../src/sessions/deleted-cache.js")).resetDeletedSessionCache();
    poison.eventDeliveryHealth.reset();
    Object.assign(poison.eventQuarantinePolicy, originalPolicy);
    consumer.tombstoneReader.has = async () => false;
    for (const t of ["claw_event_quarantine", "claw_session_events", "claw_conversation_turns", "claw_tasks", "claw_sessions"]) {
      await q(`DELETE FROM ${t}`);
    }
    Object.assign(consumer.completionPorts, originalPorts, { maybeSummarize: async () => {} });
    for (const sid of [SESSION, OTHER]) {
      await q(
        `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, agent_gate_message_id, config)
         VALUES ($1, 'poison', 'u1', 'claw', 'running', 'm1', '{}'::jsonb)`,
        [sid],
      );
    }
    await q(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, metadata, claim_count,
                               queued_at, run_time_epoch_at, started_at, lease_owner, lease_expires_at)
       VALUES ($1, $2, 'chat', 'running', 'chat', 'brain', '{"message_id": "m1", "user_id": "u1"}'::jsonb, 1,
               NOW() - interval '60 seconds', NOW() - interval '60 seconds', NOW() - interval '60 seconds',
               'brain-a', NOW() + interval '60 seconds')`,
      [RUN, SESSION],
    );
  });

  async function metric(name: string, label = ""): Promise<number> {
    const line = (await registry.metrics()).split("\n").find((l) => l.startsWith(name) && l.includes(label) && !l.startsWith("#"));
    return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
  }

  /** One delivery, as JetStream hands it over: "ack", "nak", or both if the code answered twice. */
  async function deliver(
    session: string, seq: number, data: Uint8Array | Record<string, unknown>,
    info: { deliveryCount?: number; publishedAgoMs?: number } = {},
  ): Promise<string> {
    const answers: string[] = [];
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(JSON.stringify(data));
    await consumer.consumeEventDelivery({
      subject: `events.${session}`, data: bytes, seq,
      info: {
        streamSequence: seq, deliveryCount: info.deliveryCount ?? 1,
        timestampNanos: (Date.now() - (info.publishedAgoMs ?? 0)) * 1_000_000,
      },
      ack: () => { answers.push("ack"); }, nak: () => { answers.push("nak"); },
    });
    return answers.join(",");
  }

  const storedData = async (session: string) =>
    (await q("SELECT event, data FROM claw_session_events WHERE session_id = $1 ORDER BY id", [session])).rows as
      { event: string; data: Record<string, unknown> }[];

  test("a NUL and lone surrogates are stored as U+FFFD, in values and in keys", async () => {
    const before = await metric("claw_api_event_sanitised_total");
    const event = {
      type: "toolUsed", tool: "bash", status: "end", message_id: "m1",
      output: `a${NUL}b ${LONE_HIGH}x ${LONE_LOW}y ${PAIR}`,
      nested: [{ [`k${NUL}`]: `v${LONE_LOW}` }],
    };
    // The wire text Brain sends carries the characters as escapes, not as the characters.
    const wire = JSON.stringify(event);
    assert.ok(wire.includes("\\u0000") && wire.includes("\\ud800") && wire.includes("\\udc00"));
    assert.equal(await deliver(SESSION, 11, event), "ack");
    const rows = await storedData(SESSION);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.output, `a�b �x �y ${PAIR}`, "a valid pair is kept as it is");
    assert.deepEqual(rows[0].data.nested, [{ "k�": "v�" }]);
    assert.equal(await metric("claw_api_event_sanitised_total") - before, 1);
    assert.equal((await q("SELECT count(*)::int AS n FROM claw_event_quarantine")).rows[0].n, 0);
  });

  test("a completion carrying a NUL is stored and processed: its turn is written, nothing is skipped", async () => {
    const completion = {
      type: "exec_complete", session_id: SESSION, task_id: RUN, message_id: "m1", user_id: "u1",
      final_text: `done${NUL} with ${LONE_HIGH}`, failed: false, run_claim: 1, prompt: `hi${NUL}`,
    };
    assert.equal(await deliver(SESSION, 21, completion), "ack");
    const ev = (await q("SELECT processed_at, data FROM claw_session_events WHERE event = 'exec_complete'")).rows;
    assert.equal(ev.length, 1);
    assert.notEqual(ev[0].processed_at, null, "the completion ran");
    assert.equal(ev[0].data.final_text, "done� with �");
    const turns = (await q("SELECT role, content FROM claw_conversation_turns WHERE session_id = $1 ORDER BY turn_index", [SESSION])).rows;
    assert.ok(turns.some((t) => t.role === "assistant" && String(t.content).includes("done� with �")),
      `the assistant turn is written: ${JSON.stringify(turns)}`);
    assert.equal((await q("SELECT status FROM claw_tasks WHERE task_id = $1", [RUN])).rows[0].status, "completed");
  });

  test("CONTROL: the same characters straight into jsonb are refused, which is what the consumer prevents", async () => {
    await assert.rejects(q("SELECT $1::jsonb", [JSON.stringify({ a: NUL })]), (e: { code?: string }) => e.code === "22P05");
    await assert.rejects(q("SELECT $1::jsonb", [JSON.stringify({ a: LONE_HIGH })]), (e: { code?: string }) => e.code === "22P02");
  });

  test("an event that is not JSON is kept in quarantine as masked text, then acked", async () => {
    const before = await metric("claw_api_event_quarantined_total", 'reason="unparseable"');
    const text = '{"type":"toolUsed","output":"Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 and then';
    assert.equal(await deliver(SESSION, 31, new TextEncoder().encode(text)), "ack");
    const rows = (await q("SELECT event_id, session_id, reason, stream_seq, payload FROM claw_event_quarantine")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "unparseable");
    assert.equal(rows[0].event_id, "claw-31");
    assert.equal(Number(rows[0].stream_seq), 31);
    const kept = Buffer.from(rows[0].payload).toString("utf8");
    assert.ok(kept.startsWith('{"type":"toolUsed","output":"') && kept.endsWith("<redacted> and then"), kept);
    assert.ok(!kept.includes("abcdefghijklmnopqrstuvwxyz0123456789"), "the credential is masked");
    assert.equal(await metric("claw_api_event_quarantined_total", 'reason="unparseable"') - before, 1);
  });

  /** A step that fails for one session's events only, as a poison event does. */
  function failInsertsFor(session: string): () => void {
    const original = h.app.db.db.query;
    h.app.db.db.query = (async (text: string, params?: unknown[]) => {
      if (/INSERT INTO claw_session_events/.test(text) && params?.[1] === session) {
        throw Object.assign(new Error("could not write"), { code: "XX000" });
      }
      return original.call(h.app.db.db, text, params);
    }) as typeof original;
    return () => { h.app.db.db.query = original; };
  }

  const poisonEvent = { type: "AssistantMessage", message_id: "m1", content: "the event that keeps failing" };
  /** The poison event with what the copy must not keep: a credential, and a NUL. */
  const poisonWithSecret = { ...poisonEvent, api_key: "s3cr3t-value-123", note: `a${NUL}b` };
  const goodEvent = (i: number) => ({ type: "AssistantMessage", message_id: `m-${i}`, content: `fine ${i}` });

  test("a poison event is retried, then set aside once others are stored; the ones after it are stored", async () => {
    Object.assign(poison.eventQuarantinePolicy, { maxDeliveries: 3, minAgeMs: 60_000, healthyWindowMs: 60_000 });
    const restore = failInsertsFor(SESSION);
    const answers: string[] = [];
    try {
      // Interleaved as the stream redelivers: the poison event, then the events published after it.
      for (let d = 1; d <= 5; d++) {
        answers.push(await deliver(SESSION, 100, poisonWithSecret, { deliveryCount: d, publishedAgoMs: 120_000 }));
        assert.equal(await deliver(OTHER, 100 + d, goodEvent(d)), "ack", "an event after the poison one is stored");
      }
    } finally {
      restore();
    }
    // Deliveries 1-3 are its budget; the fourth is the first past it with another event stored, and is set aside.
    assert.deepEqual(answers, ["nak", "nak", "nak", "ack", "ack"].slice(0, answers.length));
    assert.equal((await storedData(OTHER)).length, 5, "nothing after it waited");
    const rows = (await q("SELECT event_id, session_id, event_type, reason, deliveries, last_error, payload FROM claw_event_quarantine")).rows;
    assert.equal(rows.length, 1, "one record, however often it is set aside");
    assert.equal(rows[0].reason, "retries_exhausted");
    assert.equal(rows[0].event_type, "AssistantMessage");
    assert.equal(rows[0].session_id, SESSION);
    assert.equal(rows[0].deliveries, 5);
    assert.match(String(rows[0].last_error), /^XX000: could not write/);
    assert.deepEqual(JSON.parse(Buffer.from(rows[0].payload).toString("utf8")),
      { ...poisonEvent, api_key: "<redacted>", note: "a\uFFFDb" }, "the event, sanitised and masked as a stored one is");
    assert.equal((await storedData(SESSION)).length, 0);
  });

  test("an outage quarantines nothing: with no event stored, every delivery is retried", async () => {
    Object.assign(poison.eventQuarantinePolicy, { maxDeliveries: 2, minAgeMs: 0, healthyWindowMs: 60_000 });
    const original = h.app.db.db.query;
    h.app.db.db.query = (async (text: string, params?: unknown[]) => {
      if (/INSERT INTO claw_session_events/.test(text)) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      return original.call(h.app.db.db, text, params);
    }) as typeof original;
    const answers: string[] = [];
    try {
      for (let d = 1; d <= 6; d++) {
        answers.push(await deliver(SESSION, 200, poisonEvent, { deliveryCount: d }));
        answers.push(await deliver(OTHER, 201, goodEvent(1), { deliveryCount: d }));
        // A streaming preview is acked without being stored: it says nothing about whether events can be stored.
        assert.equal(await deliver(OTHER, 1000 + d, { type: "toolTextDelta", tool: "say", text: "par" }), "ack");
      }
    } finally {
      h.app.db.db.query = original;
    }
    assert.ok(answers.every((a) => a === "nak"), answers.join(" "));
    assert.equal((await q("SELECT count(*)::int AS n FROM claw_event_quarantine")).rows[0].n, 0);
    assert.equal(await metric("claw_api_event_consumer_consecutive_failures"), 12, "the previews acked between them do not end the run");
    // Recovery: the same events are stored on their next delivery, and the run of failures ends.
    assert.equal(await deliver(OTHER, 201, goodEvent(1), { deliveryCount: 7 }), "ack");
    assert.equal(await metric("claw_api_event_consumer_consecutive_failures"), 0);
    // The poison event was not poison: past its budget, but stored, not set aside, because it now succeeds.
    assert.equal(await deliver(SESSION, 200, poisonEvent, { deliveryCount: 3 }), "ack");
  });

  test("a young event is retried however many deliveries it has had", async () => {
    Object.assign(poison.eventQuarantinePolicy, { maxDeliveries: 2, minAgeMs: 15 * 60_000, healthyWindowMs: 60_000 });
    const restore = failInsertsFor(SESSION);
    try {
      assert.equal(await deliver(OTHER, 301, goodEvent(1)), "ack");
      assert.equal(await deliver(SESSION, 300, poisonEvent, { deliveryCount: 9, publishedAgoMs: 60_000 }), "nak");
      assert.equal(await deliver(SESSION, 300, poisonEvent, { deliveryCount: 10, publishedAgoMs: 16 * 60_000 }), "ack");
    } finally {
      restore();
    }
    assert.equal((await q("SELECT count(*)::int AS n FROM claw_event_quarantine")).rows[0].n, 1);
  });

  test("an event of a deleted session past its budget is dropped, not copied", async () => {
    Object.assign(poison.eventQuarantinePolicy, { maxDeliveries: 1, minAgeMs: 0, healthyWindowMs: 60_000 });
    assert.equal(await deliver(OTHER, 401, goodEvent(1)), "ack");
    consumer.tombstoneReader.has = async (id) => id === SESSION;
    assert.equal(await deliver(SESSION, 400, poisonEvent, { deliveryCount: 5 }), "ack");
    assert.equal((await q("SELECT count(*)::int AS n FROM claw_event_quarantine")).rows[0].n, 0);
  });

  test("a quarantine copy that cannot be written is retried, not dropped", async () => {
    Object.assign(poison.eventQuarantinePolicy, { maxDeliveries: 1, minAgeMs: 0, healthyWindowMs: 60_000 });
    assert.equal(await deliver(OTHER, 501, goodEvent(1)), "ack");
    const original = h.app.db.db.query;
    h.app.db.db.query = (async (text: string, params?: unknown[]) => {
      if (/INSERT INTO claw_event_quarantine/.test(text)) throw new Error("connection reset");
      return original.call(h.app.db.db, text, params);
    }) as typeof original;
    try {
      assert.equal(await deliver(SESSION, 500, poisonEvent, { deliveryCount: 5 }), "nak");
    } finally {
      h.app.db.db.query = original;
    }
  });

  test("deleting a session deletes its quarantined copies", async () => {
    await q(
      `INSERT INTO claw_event_quarantine (event_id, session_id, subject, reason, deliveries, payload)
       VALUES ('claw-1', $1, $2, 'retries_exhausted', 3, '\\x7b7d'::bytea)`,
      [SESSION, `events.${SESSION}`],
    );
    const { commitSessionDeletion } = await import("../src/sessions/teardown.js");
    assert.equal(await commitSessionDeletion(SESSION), true);
    assert.equal((await q("SELECT count(*)::int AS n FROM claw_event_quarantine")).rows[0].n, 0);
  });
});
