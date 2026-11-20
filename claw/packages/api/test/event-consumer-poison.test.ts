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
 * - An event Postgres refuses for its value (22P05, 22021, 22P02) is set aside
 *   at once with a durable copy, and the events after it are stored.
 * - Nothing else is set aside, however many deliveries and however old: not
 *   the backlog an outage of the database or the tombstone bucket leaves, and
 *   not a completion. The refusals are raised by a trigger on the real table,
 *   so they come back through the driver as the store's own do.
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
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  before(async () => {
    h = await startAdmissionCluster({ CLAW_NOTIFICATIONS_ENABLED: "false" });
    consumer = await import("../src/events/consumer.js");
    poison = await import("../src/events/poison.js");
    registry = (await import("../src/infra/metrics.js")).registry;
    originalPorts = { ...consumer.completionPorts };
    originalTombstone = consumer.tombstoneReader.has;
    consumer.tombstoneReader.has = async () => false;
    await q("CREATE TABLE poison_test_refuse (session_id TEXT NOT NULL, code TEXT NOT NULL, types TEXT[])");
    await q(`CREATE FUNCTION poison_test_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
             DECLARE r RECORD;
             BEGIN
               SELECT code INTO r FROM poison_test_refuse
                WHERE session_id = NEW.session_id AND (types IS NULL OR NEW.event = ANY (types)) LIMIT 1;
               IF FOUND THEN RAISE EXCEPTION 'refused for the test' USING ERRCODE = r.code; END IF;
               RETURN NEW;
             END $$`);
    await q("CREATE TRIGGER poison_test_refuse BEFORE INSERT ON claw_session_events FOR EACH ROW EXECUTE FUNCTION poison_test_refuse()");
  });
  after(async () => {
    if (consumer) {
      Object.assign(consumer.completionPorts, originalPorts);
      consumer.tombstoneReader.has = originalTombstone;
    }
    await new Promise<void>((r) => setTimeout(r, 50));
    await h?.stop();
  });
  beforeEach(async () => {
    (await import("../src/sessions/deleted-cache.js")).resetDeletedSessionCache();
    poison.eventDeliveryHealth.reset();
    consumer.tombstoneReader.has = async () => false;
    for (const t of ["poison_test_refuse", "claw_event_quarantine", "claw_session_events", "claw_conversation_turns", "claw_tasks", "claw_sessions"]) {
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

  /**
   * Make Postgres refuse this session's event rows with `code`, on every INSERT until `clear` -- a trigger on the
   * real table, so the refusal comes back through the driver the way the store's own does. `types` narrows it to
   * those event types.
   */
  async function refuseRows(session: string, code: string, types: string[] | null = null): Promise<void> {
    await q("INSERT INTO poison_test_refuse (session_id, code, types) VALUES ($1, $2, $3)", [session, code, types]);
  }
  const clearRefusals = () => q("DELETE FROM poison_test_refuse");
  const quarantined = async () =>
    (await q("SELECT event_id, session_id, event_type, reason, deliveries, last_error, payload FROM claw_event_quarantine")).rows;

  const goodEvent = (i: number) => ({ type: "AssistantMessage", message_id: `m-${i}`, content: `fine ${i}` });
  /** A delivery JetStream has handed over many times, of an event published long ago: what a backlog is after an outage. */
  const backlogged = { deliveryCount: 25, publishedAgoMs: 20 * 60_000 };

  test("an event Postgres refuses for its value is set aside at once, masked and sanitised, and the next one is stored", async () => {
    const before = await metric("claw_api_event_quarantined_total", 'reason="unstorable"');
    // 22P05 is what Postgres answers for a `\u0000` it cannot convert: the class of the incident's event.
    await refuseRows(SESSION, "22P05");
    const event = { type: "AssistantMessage", message_id: "m1", content: "unstorable", api_key: "s3cr3t-value-123", note: `a${NUL}b` };
    assert.equal(await deliver(SESSION, 100, event), "ack", "on its first delivery: no retry can store it");
    assert.equal(await deliver(OTHER, 101, goodEvent(1)), "ack");
    const rows = await quarantined();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "unstorable");
    assert.equal(rows[0].event_type, "AssistantMessage");
    assert.equal(rows[0].deliveries, 1);
    assert.match(String(rows[0].last_error), /^22P05: /);
    assert.deepEqual(JSON.parse(Buffer.from(rows[0].payload).toString("utf8")),
      { ...event, api_key: "<redacted>", note: "a�b" }, "the event, sanitised and masked as a stored one is");
    assert.equal((await storedData(SESSION)).length, 0);
    assert.equal((await storedData(OTHER)).length, 1);
    assert.equal(await metric("claw_api_event_quarantined_total", 'reason="unstorable"') - before, 1);
  });

  for (const code of ["22021", "22P02"]) {
    test(`a ${code} refusal is set aside as well`, async () => {
      await refuseRows(SESSION, code);
      assert.equal(await deliver(SESSION, 110, goodEvent(0)), "ack");
      assert.equal((await quarantined())[0]?.reason, "unstorable");
    });
  }

  test("an outage longer than any budget sets nothing aside: the backlog after it is stored, not quarantined", async () => {
    // The database refused every event for over 15 minutes, as a dead connection does ...
    await refuseRows(SESSION, "57P01");
    await refuseRows(OTHER, "57P01");
    assert.equal(await deliver(SESSION, 200, goodEvent(1), { deliveryCount: 24, publishedAgoMs: 20 * 60_000 }), "nak");
    assert.equal(await deliver(OTHER, 201, goodEvent(2), { deliveryCount: 24, publishedAgoMs: 20 * 60_000 }), "nak");
    // ... then it recovers. The first event after it is stored, and so is every old one behind it.
    await clearRefusals();
    assert.equal(await deliver(OTHER, 201, goodEvent(2), backlogged), "ack");
    assert.equal(await deliver(SESSION, 200, goodEvent(1), backlogged), "ack");
    assert.equal((await storedData(SESSION)).length, 1, "the backlogged event is stored");
    assert.equal((await quarantined()).length, 0);
  });

  test("an event failing for a reason a retry can fix is retried however long, even while others are stored", async () => {
    // One session's rows still refused (a lock timeout, a connection the pool is replacing) while others go through.
    await refuseRows(SESSION, "55P03");
    for (let d = 20; d <= 30; d++) {
      assert.equal(await deliver(OTHER, 300 + d, goodEvent(d)), "ack");
      assert.equal(await deliver(SESSION, 300, goodEvent(0), { deliveryCount: d, publishedAgoMs: 60 * 60_000 }), "nak");
    }
    assert.equal((await quarantined()).length, 0);
    assert.equal(await metric("claw_api_event_consumer_consecutive_failures"), 1, "each stored event ends the run");
    await clearRefusals();
    assert.equal(await deliver(SESSION, 300, goodEvent(0), backlogged), "ack");
    assert.equal((await storedData(SESSION)).length, 1);
  });

  test("an outage of the tombstone bucket sets nothing aside either", async () => {
    consumer.tombstoneReader.has = async (id) => { if (id === SESSION) throw new Error("no responders"); return false; };
    assert.equal(await deliver(OTHER, 401, goodEvent(1)), "ack");
    assert.equal(await deliver(SESSION, 400, goodEvent(2), backlogged), "nak");
    consumer.tombstoneReader.has = async () => false;
    assert.equal(await deliver(OTHER, 402, goodEvent(3)), "ack");
    assert.equal(await deliver(SESSION, 400, goodEvent(2), backlogged), "ack");
    assert.equal((await storedData(SESSION)).length, 1);
    assert.equal((await quarantined()).length, 0);
  });

  test("a completion Postgres refuses is retried, never set aside: its turn has not been written", async () => {
    await refuseRows(SESSION, "22P05", ["exec_complete"]);
    const completion = {
      type: "exec_complete", session_id: SESSION, task_id: RUN, message_id: "m1", user_id: "u1",
      final_text: "done", failed: false, run_claim: 1,
    };
    assert.equal(await deliver(SESSION, 500, completion), "nak");
    assert.equal(await deliver(SESSION, 500, completion, backlogged), "nak");
    assert.equal((await quarantined()).length, 0);
    assert.equal((await q("SELECT status FROM claw_tasks WHERE task_id = $1", [RUN])).rows[0].status, "running");
    await clearRefusals();
    assert.equal(await deliver(SESSION, 500, completion, backlogged), "ack");
    assert.equal((await q("SELECT status FROM claw_tasks WHERE task_id = $1", [RUN])).rows[0].status, "completed");
  });

  test("the sanitised count is of events stored: not a failed delivery, not a redelivery of a stored one", async () => {
    const dirty = { type: "AssistantMessage", message_id: "m1", content: `x${NUL}y` };
    const before = await metric("claw_api_event_sanitised_total");
    await refuseRows(SESSION, "57P01");
    assert.equal(await deliver(SESSION, 600, dirty), "nak");
    assert.equal(await metric("claw_api_event_sanitised_total") - before, 0, "a failed write stored nothing");
    await clearRefusals();
    assert.equal(await deliver(SESSION, 600, dirty), "ack");
    assert.equal(await deliver(SESSION, 600, dirty), "ack");
    assert.equal(await metric("claw_api_event_sanitised_total") - before, 1);
    consumer.tombstoneReader.has = async () => true;
    (await import("../src/sessions/deleted-cache.js")).resetDeletedSessionCache();
    assert.equal(await deliver(SESSION, 601, dirty), "ack");
    assert.equal(await metric("claw_api_event_sanitised_total") - before, 1, "a deleted session's event stored nothing");
  });

  test("an event of a deleted session that is not JSON is dropped, not copied", async () => {
    consumer.tombstoneReader.has = async (id) => id === SESSION;
    assert.equal(await deliver(SESSION, 700, new TextEncoder().encode("{not json")), "ack");
    assert.equal((await quarantined()).length, 0);
  });

  test("a quarantine copy that cannot be written is retried, not dropped", async () => {
    await refuseRows(SESSION, "22P05");
    await q(`CREATE OR REPLACE FUNCTION poison_test_refuse_copy() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN RAISE EXCEPTION 'connection reset' USING ERRCODE = '08006'; END $$`);
    await q("CREATE TRIGGER poison_test_refuse_copy BEFORE INSERT ON claw_event_quarantine FOR EACH ROW EXECUTE FUNCTION poison_test_refuse_copy()");
    try {
      assert.equal(await deliver(SESSION, 800, goodEvent(1)), "nak");
    } finally {
      await q("DROP TRIGGER poison_test_refuse_copy ON claw_event_quarantine");
    }
    assert.equal(await deliver(SESSION, 800, goodEvent(1), { deliveryCount: 2 }), "ack");
    assert.equal((await quarantined()).length, 1);
  });

  test("deleting a session deletes its quarantined copies", async () => {
    await q(
      `INSERT INTO claw_event_quarantine (event_id, session_id, subject, reason, deliveries, payload)
       VALUES ('claw-1', $1, $2, 'unstorable', 3, '\\x7b7d'::bytea)`,
      [SESSION, `events.${SESSION}`],
    );
    const { commitSessionDeletion } = await import("../src/sessions/teardown.js");
    assert.equal(await commitSessionDeletion(SESSION), true);
    assert.equal((await q("SELECT count(*)::int AS n FROM claw_event_quarantine")).rows[0].n, 0);
  });
});
