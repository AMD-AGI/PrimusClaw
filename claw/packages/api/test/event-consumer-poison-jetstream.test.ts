// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The event consumer over a real JetStream server and a real Postgres: an
 * event Postgres refuses for its value is set aside on its first delivery with
 * a durable copy, and does not hold up the events published after it; an event
 * failing for any other reason is redelivered, never set aside, and is stored
 * once it can be.
 *
 * The consumer is the production one (`startEventConsumer`: the `api-consumer`
 * durable on the event stream `initNats` provisions, pulled by `consume()`),
 * and the events are published as Brain publishes them (`JSON.stringify` of
 * the event, with a message id). The failures are real: triggers on
 * `claw_session_events` refuse a session's rows with the SQLSTATE the store
 * answers (22P05 for an untranslatable character, 55P03 for a lock timeout).
 *
 * Needs a nats-server binary (CLAW_CHAOS_NATS_SERVER) and a Postgres server
 * (DATABASE_URL); skipped without them, and run by the rolling-restart CI job,
 * which has both.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { freePort, Proc, until } from "./chaos-harness.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const NATS_SERVER = process.env.CLAW_CHAOS_NATS_SERVER ?? "";
const skip = !NATS_SERVER || !process.env.DATABASE_URL
  ? "needs CLAW_CHAOS_NATS_SERVER and DATABASE_URL (the rolling-restart CI job sets both)"
  : false;

const POISONED = "js-poisoned";
const HEALTHY = "js-healthy";
const DIRTY = "js-dirty";
const RETRYING = "js-retrying";
const NUL = String.fromCharCode(0);

describe("event consumer over JetStream: a poison event", { skip, timeout: 120_000 }, () => {
  let dir: string;
  let nats: Proc;
  let h: AdmissionCluster;
  let natsMod: typeof import("../src/infra/nats.js");
  let poison: typeof import("../src/events/poison.js");
  let registry: typeof import("../src/infra/metrics.js")["registry"];
  let consumerLoop: Promise<void>;
  const stopConsumer = new AbortController();
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "claw-poison-js-"));
    const port = await freePort();
    nats = new Proc("nats", NATS_SERVER, ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(dir, "js")], {
      cwd: dir, env: process.env, log: join(dir, "nats.log"),
    });
    process.env.NATS_URL = `nats://127.0.0.1:${port}`;
    process.env.NATS_REPLICAS = "1";
    h = await startAdmissionCluster({ CLAW_NOTIFICATIONS_ENABLED: "false" });
    natsMod = await import("../src/infra/nats.js");
    await until("nats-server", async () => { await natsMod.initNats(); return true; }, 20_000, 300);
    poison = await import("../src/events/poison.js");
    registry = (await import("../src/infra/metrics.js")).registry;

    // The poison: Postgres refuses this session's rows, on every delivery.
    await q(`CREATE FUNCTION refuse_poisoned() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.session_id = '${POISONED}' THEN RAISE EXCEPTION 'refused for the test' USING ERRCODE = '22P05'; END IF;
               RETURN NEW;
             END $$`);
    await q("CREATE TRIGGER refuse_poisoned BEFORE INSERT ON claw_session_events FOR EACH ROW EXECUTE FUNCTION refuse_poisoned()");

    const consumer = await import("../src/events/consumer.js");
    consumer.tombstoneReader.has = async () => false;
    consumer.completionPorts.maybeSummarize = async () => {};
    consumerLoop = consumer.startEventConsumer({ signal: stopConsumer.signal });
    consumerLoop.catch(() => {});
    // The durable delivers only what is published after it exists.
    await until("api-consumer durable", async () => !!(await natsMod.jsm.consumers.info(natsMod.EVENT_STREAM, "api-consumer")), 10_000);
  });

  after(async () => {
    stopConsumer.abort();
    await Promise.race([consumerLoop, new Promise((r) => setTimeout(r, 5_000))]);
    await natsMod?.nc?.close().catch(() => {});
    await nats?.stop("SIGTERM", 10_000);
    await h?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const publish = async (session: string, event: Record<string, unknown>) =>
    (await natsMod.js.publish(`events.${session}`, natsMod.sc.encode(JSON.stringify(event)), { msgID: crypto.randomUUID() })).seq;
  const stored = async (session: string) =>
    (await q("SELECT count(*)::int AS n FROM claw_session_events WHERE session_id = $1", [session])).rows[0].n as number;
  const gauge = async (name: string) => {
    const line = (await registry.metrics()).split("\n").find((l) => l.startsWith(`${name}{`) || l.startsWith(`${name} `));
    return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : NaN;
  };

  test("an unstorable event is set aside at once, the events after it are stored, and the backlog clears", async () => {
    const poisonEvent = { type: "AssistantMessage", message_id: "m-p", content: "refused on every delivery" };
    const poisonSeq = await publish(POISONED, poisonEvent);
    // Brain's shape for a tool's output that carries a NUL: stored, with U+FFFD, not refused.
    await publish(DIRTY, { type: "toolUsed", tool: "bash", status: "end", message_id: "m-d", output: `x${NUL}y` });
    for (let i = 0; i < 20; i++) {
      await publish(HEALTHY, { type: "AssistantMessage", message_id: `m-${i}`, content: `fine ${i}` });
    }

    // Inside the first redelivery delay (5 s): nothing waited for it, and it was not retried at all.
    await until("the 20 events after the poison one", async () => (await stored(HEALTHY)) === 20, 4_000, 100);
    assert.equal(await stored(DIRTY), 1);
    const dirty = (await q("SELECT data FROM claw_session_events WHERE session_id = $1", [DIRTY])).rows[0].data;
    assert.equal(dirty.output, "x�y");
    const row = await until("the quarantine record", async () =>
      (await q("SELECT * FROM claw_event_quarantine WHERE session_id = $1", [POISONED])).rows[0], 4_000, 100);
    assert.equal(row.reason, "unstorable");
    assert.equal(row.event_id, `claw-${poisonSeq}`);
    assert.equal(Number(row.stream_seq), poisonSeq);
    assert.equal(row.deliveries, 1, "set aside on its first delivery");
    assert.match(String(row.last_error), /^22P05: refused for the test/);
    assert.equal(Buffer.from(row.payload).toString("utf8"), JSON.stringify(poisonEvent), "the bytes as published");
    assert.ok(row.published_at instanceof Date);
    assert.equal(await stored(POISONED), 0);

    const clear = await until("an empty backlog", async () => {
      const b = await poison.readEventConsumerBacklog(natsMod.jsm, natsMod.EVENT_STREAM, "api-consumer");
      return b.ackPending === 0 && b.pending === 0 ? b : null;
    }, 10_000);
    assert.equal(clear.oldestPendingAgeSeconds, 0);
    assert.equal(await gauge("claw_api_event_consumer_consecutive_failures"), 0);
    assert.equal(await gauge("claw_api_event_quarantined_total"), 1);
  });

  test("an event failing for a reason a retry can fix is redelivered, never set aside, and stored once it can be", async () => {
    // Postgres refusing this session's rows the way a lock timeout does: nothing about the event itself.
    await q("CREATE TABLE js_retrying (on_off BOOLEAN)");
    await q("INSERT INTO js_retrying VALUES (true)");
    await q(`CREATE FUNCTION refuse_retrying() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.session_id = '${RETRYING}' AND (SELECT on_off FROM js_retrying) THEN
                 RAISE EXCEPTION 'lock timeout for the test' USING ERRCODE = '55P03';
               END IF;
               RETURN NEW;
             END $$`);
    await q("CREATE TRIGGER refuse_retrying BEFORE INSERT ON claw_session_events FOR EACH ROW EXECUTE FUNCTION refuse_retrying()");
    const failures = async () => {
      const line = (await registry.metrics()).split("\n").find((l) => l.startsWith("claw_api_event_persisted_total") && l.includes('outcome="error"'));
      return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
    };
    const before = await failures();
    await publish(RETRYING, { type: "AssistantMessage", message_id: "m-r", content: "stored once it can be" });
    for (let i = 0; i < 5; i++) await publish(HEALTHY, { type: "AssistantMessage", message_id: `m-r${i}`, content: "fine" });
    await until("the events after it", async () => (await stored(HEALTHY)) === 25, 4_000, 100);

    // Three deliveries, each refused and answered with a retry, while others were stored: still not set aside.
    await until("three refused deliveries", async () => (await failures()) - before >= 3, 30_000, 250);
    assert.equal((await q("SELECT count(*)::int AS n FROM claw_event_quarantine WHERE session_id = $1", [RETRYING])).rows[0].n, 0);
    const stalled = await poison.readEventConsumerBacklog(natsMod.jsm, natsMod.EVENT_STREAM, "api-consumer");
    assert.equal(stalled.ackPending, 1, JSON.stringify(stalled));
    assert.ok(stalled.oldestPendingAgeSeconds >= 5, JSON.stringify(stalled));
    assert.ok(await gauge("claw_api_event_consumer_oldest_pending_age_seconds") >= 5);

    await q("UPDATE js_retrying SET on_off = false");
    await until("the retried event stored", async () => (await stored(RETRYING)) === 1, 15_000, 250);
    await until("an empty backlog", async () => {
      const b = await poison.readEventConsumerBacklog(natsMod.jsm, natsMod.EVENT_STREAM, "api-consumer");
      return b.ackPending === 0 && b.pending === 0 ? b : null;
    }, 10_000);
    assert.equal(await gauge("claw_api_event_consumer_consecutive_failures"), 0);
    assert.equal(await gauge("claw_api_event_quarantined_total"), 1, "only the unstorable one, from the test before");
  });

  test("a completion nested deeper than Postgres parses is run on its first delivery, with a bounded copy", async () => {
    const session = "js-deep";
    const run = "run-js-deep";
    await q(`INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, agent_gate_message_id, config)
             VALUES ($1, 'deep', 'u1', 'claw', 'running', 'm1', '{}'::jsonb)`, [session]);
    await q(`INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, metadata, claim_count,
                                     queued_at, run_time_epoch_at, started_at, lease_owner, lease_expires_at)
             VALUES ($1, $2, 'chat', 'running', 'chat', 'brain', '{"message_id": "m1", "user_id": "u1"}'::jsonb, 1,
                     NOW() - interval '60 seconds', NOW() - interval '60 seconds', NOW() - interval '60 seconds',
                     'brain-a', NOW() + interval '60 seconds')`, [run, session]);
    // 17,000 levels: Postgres answers 54001 for the whole event; about 100 KB, inside a NATS payload.
    let inner = '"x"';
    for (let i = 0; i < 17_000; i++) inner = `{"a":${inner}}`;
    const head = JSON.stringify({
      type: "exec_complete", session_id: session, task_id: run, message_id: "m1", user_id: "u1",
      final_text: "done", failed: false, run_claim: 1,
    });
    const wire = `${head.slice(0, -1)},"tool_stats":{"bash":{"calls":1,"input":${inner}}}}`;
    const seq = (await natsMod.js.publish(`events.${session}`, natsMod.sc.encode(wire), { msgID: crypto.randomUUID() })).seq;

    // Inside the first redelivery delay: it was not refused and retried.
    await until("the run completed", async () =>
      (await q("SELECT status FROM claw_tasks WHERE task_id = $1", [run])).rows[0].status === "completed", 4_000, 100);
    const ev = (await q("SELECT processed_at, data FROM claw_session_events WHERE session_id = $1", [session])).rows;
    assert.equal(ev.length, 1);
    assert.notEqual(ev[0].processed_at, null);
    let v: unknown = ev[0].data.tool_stats.bash.input;
    while (v && typeof v === "object") v = (v as { a: unknown }).a;
    assert.equal(v, poison.TOO_DEEP_PLACEHOLDER);
    const kept = (await q("SELECT reason, stream_seq, deliveries FROM claw_event_quarantine WHERE session_id = $1", [session])).rows;
    assert.deepEqual(kept.map((r) => [r.reason, Number(r.stream_seq), r.deliveries]), [["bounded", seq, 1]]);
    await until("an empty backlog", async () => {
      const b = await poison.readEventConsumerBacklog(natsMod.jsm, natsMod.EVENT_STREAM, "api-consumer");
      return b.ackPending === 0 && b.pending === 0 ? b : null;
    }, 10_000);
  });

  test("the oldest pending age skips a range a session deletion purged from the stream", async () => {
    // A durable that is never pulled: everything published from now on is pending on it, and its ack floor stays put.
    await natsMod.jsm.consumers.add(natsMod.EVENT_STREAM, {
      durable_name: "backlog-probe", filter_subject: "events.>", deliver_policy: "new" as never, ack_policy: "explicit" as never,
    });
    try {
      await publish("js-purged", { type: "AssistantMessage", message_id: "m-gone", content: "deleted" });
      await publish("js-purged", { type: "AssistantMessage", message_id: "m-gone-2", content: "deleted" });
      await publish("js-kept", { type: "AssistantMessage", message_id: "m-kept", content: "kept" });
      // What deleting a session does to its events on the stream; the first pending sequence is now a gap.
      await natsMod.jsm.streams.purge(natsMod.EVENT_STREAM, { filter: "events.js-purged" });
      await new Promise((r) => setTimeout(r, 1_200));
      const b = await poison.readEventConsumerBacklog(natsMod.jsm, natsMod.EVENT_STREAM, "backlog-probe");
      assert.equal(b.pending, 1, JSON.stringify(b));
      assert.ok(b.oldestPendingAgeSeconds >= 1 && b.oldestPendingAgeSeconds < 30, JSON.stringify(b));
    } finally {
      await natsMod.jsm.consumers.delete(natsMod.EVENT_STREAM, "backlog-probe");
    }
  });
});
