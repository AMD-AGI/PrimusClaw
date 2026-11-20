// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The event consumer over a real JetStream server and a real Postgres: a poison
 * event does not hold up the events published after it, and is set aside with
 * a durable copy once it has had its deliveries.
 *
 * The consumer is the production one (`startEventConsumer`: the `api-consumer`
 * durable on the event stream `initNats` provisions, pulled by `consume()`),
 * and the events are published as Brain publishes them (`JSON.stringify` of
 * the event, with a message id). The poison event fails for real: a trigger on
 * `claw_session_events` refuses its session's rows, so every delivery of it
 * fails at the INSERT the way an unstorable event used to.
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
    // Short budgets, so the test sees a quarantine in seconds; the rule is the production one.
    Object.assign(poison.eventQuarantinePolicy, { maxDeliveries: 2, minAgeMs: 0, healthyWindowMs: 60_000 });

    // The poison: Postgres refuses this session's rows, on every delivery.
    await q(`CREATE FUNCTION refuse_poisoned() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.session_id = '${POISONED}' THEN RAISE EXCEPTION 'refused for the test' USING ERRCODE = 'XX000'; END IF;
               RETURN NEW;
             END $$`);
    await q("CREATE TRIGGER refuse_poisoned BEFORE INSERT ON claw_session_events FOR EACH ROW EXECUTE FUNCTION refuse_poisoned()");

    const consumer = await import("../src/events/consumer.js");
    consumer.tombstoneReader.has = async () => false;
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

  test("the events after it are stored at once, it is set aside with its copy, and the backlog clears", async () => {
    const poisonEvent = { type: "AssistantMessage", message_id: "m-p", content: "refused on every delivery" };
    const poisonSeq = await publish(POISONED, poisonEvent);
    // Brain's shape for a tool's output that carries a NUL: stored, with U+FFFD, not refused.
    await publish(DIRTY, { type: "toolUsed", tool: "bash", status: "end", message_id: "m-d", output: `x${NUL}y` });
    const started = Date.now();
    for (let i = 0; i < 20; i++) {
      await publish(HEALTHY, { type: "AssistantMessage", message_id: `m-${i}`, content: `fine ${i}` });
    }

    // Stored well inside the poison event's first redelivery delay (5 s): nothing waited for it.
    await until("the 20 events after the poison one", async () => (await stored(HEALTHY)) === 20, 4_000, 100);
    const flowedMs = Date.now() - started;
    assert.equal(await stored(DIRTY), 1);
    const dirty = (await q("SELECT data FROM claw_session_events WHERE session_id = $1", [DIRTY])).rows[0].data;
    assert.equal(dirty.output, "x�y");
    assert.equal((await q("SELECT count(*)::int AS n FROM claw_event_quarantine")).rows[0].n, 0, "not yet set aside");

    // While it is outstanding the backlog says so: one unacknowledged event, and its age.
    await new Promise((r) => setTimeout(r, 1_500));
    const stalled = await poison.readEventConsumerBacklog(natsMod.jsm, natsMod.EVENT_STREAM, "api-consumer");
    assert.equal(stalled.ackPending, 1, JSON.stringify(stalled));
    assert.ok(stalled.oldestPendingAgeSeconds >= 1, JSON.stringify(stalled));
    assert.ok(await gauge("claw_api_event_consumer_oldest_pending_age_seconds") >= 1);

    // Two deliveries are its budget; the third is set aside.
    const row = await until("the quarantine record", async () =>
      (await q("SELECT * FROM claw_event_quarantine WHERE session_id = $1", [POISONED])).rows[0], 40_000, 250);
    assert.equal(row.reason, "retries_exhausted");
    assert.equal(row.event_id, `claw-${poisonSeq}`);
    assert.equal(Number(row.stream_seq), poisonSeq);
    assert.equal(row.deliveries, 3);
    assert.match(String(row.last_error), /^XX000: refused for the test/);
    assert.equal(Buffer.from(row.payload).toString("utf8"), JSON.stringify(poisonEvent), "the bytes as published");
    assert.ok(row.published_at instanceof Date);
    assert.equal(await stored(POISONED), 0);

    // And the consumer is clear: nothing unacknowledged, no age, no run of failures.
    const clear = await until("an empty backlog", async () => {
      const b = await poison.readEventConsumerBacklog(natsMod.jsm, natsMod.EVENT_STREAM, "api-consumer");
      return b.ackPending === 0 && b.pending === 0 ? b : null;
    }, 10_000);
    assert.equal(clear.oldestPendingAgeSeconds, 0);
    assert.equal(await gauge("claw_api_event_consumer_oldest_pending_age_seconds"), 0);
    assert.equal(await gauge("claw_api_event_consumer_consecutive_failures"), 0);
    assert.equal(await gauge("claw_api_event_quarantined_total"), 1);

    // Later events keep flowing after it.
    await publish(HEALTHY, { type: "AssistantMessage", message_id: "m-after", content: "after" });
    await until("an event after the quarantine", async () => (await stored(HEALTHY)) === 21, 5_000, 100);
    assert.ok(flowedMs < 4_000);
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
