// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run's `run.completed` survives a failed outbox write: the completion is
 * redelivered until the notification is recorded, and the receiver hears it
 * exactly once.
 *
 * Step 8 of `handleComplete` used to record the notification best-effort and
 * the consumer then stamped the event processed, so an outbox write that
 * failed (an API drain closing the pool under it) was lost for good: the
 * redelivery read the stamp and acked. Driven through `consumeEventDelivery`
 * against a real Postgres whose schema `initDb` built, with the failure
 * injected at `completionPorts.recordRunFinished` around the real write.
 * Skipped without DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import type { OutboundRequest, Transport } from "../src/notifications/transport.js";

const skip = postgresSkipReason();
const SESSION = "s-owed";
const RUN = "run-owed";
const pub = async () => [{ address: "93.184.216.34", family: 4 }];

describe("run notification after a failed outbox write", { skip }, () => {
  let h: AdmissionCluster;
  let consumer: typeof import("../src/events/consumer.js");
  let outbox: typeof import("../src/notifications/outbox.js");
  let crypto: typeof import("../src/crypto/user-env.js");
  let sc: typeof import("../src/infra/nats.js")["sc"];
  let originalPorts: Record<string, unknown>;
  let originalTombstone: (id: string) => Promise<boolean>;
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  const sent: OutboundRequest[] = [];
  const transport: Transport = async (req) => { sent.push(req); return 200; };
  const deliver = async () => {
    await q("UPDATE claw_notification_outbox SET next_attempt_at = NOW() - interval '1 second' WHERE delivered_at IS NULL AND dropped_at IS NULL");
    await outbox.deliverDue({ transport, resolve: pub, allowedHosts: new Set() });
  };
  /** Each call to the real write, and how many of them failed. */
  let writes = 0;
  let failFirst = 0;
  let summaries = 0;

  before(async () => {
    h = await startAdmissionCluster({ CLAW_NOTIFICATIONS_ENABLED: "true", NOTIFY_MIN_RUN_SECONDS: "60" });
    crypto = await import("../src/crypto/user-env.js");
    crypto.initUserEnvCrypto();
    outbox = await import("../src/notifications/outbox.js");
    consumer = await import("../src/events/consumer.js");
    sc = (await import("../src/infra/nats.js")).sc;
    originalPorts = { ...consumer.completionPorts };
    originalTombstone = consumer.tombstoneReader.has;
    consumer.tombstoneReader.has = async () => false;
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
    sent.length = 0;
    writes = 0;
    failFirst = 0;
    summaries = 0;
    (await import("../src/sessions/deleted-cache.js")).resetDeletedSessionCache();
    for (const t of ["claw_notification_outbox", "claw_notification_subscriptions", "claw_session_events",
      "claw_conversation_turns", "claw_tasks", "claw_sessions"]) {
      await q(`DELETE FROM ${t}`);
    }
    Object.assign(consumer.completionPorts, originalPorts, {
      // What an API drain does to the write: the pool is closed under it. The real write runs once it is let through.
      recordRunFinished: async (input: Parameters<typeof outbox.recordRunFinished>[0]) => {
        writes++;
        if (writes <= failFirst) throw new Error("Cannot use a pool after calling end on the pool");
        return outbox.recordRunFinished(input);
      },
      // Counts the completions `handleComplete` ran in full: the one side effect every ordinary run reaches.
      maybeSummarize: async () => { summaries++; },
    });
    await q(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, agent_gate_message_id, config)
       VALUES ($1, 'nightly', 'u1', 'claw', 'running', 'm1', '{"notify_on_finish": true}'::jsonb)`,
      [SESSION],
    );
    await q(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, metadata, claim_count,
                               queued_at, run_time_epoch_at, started_at, lease_owner, lease_expires_at)
       VALUES ($1, $2, 'chat', 'running', 'chat', 'brain', '{"message_id": "m1", "user_id": "u1"}'::jsonb, 2,
               NOW() - interval '120 seconds', NOW() - interval '120 seconds', NOW() - interval '120 seconds',
               'brain-a', NOW() + interval '60 seconds')`,
      [RUN, SESSION],
    );
    await q(
      "INSERT INTO claw_notification_subscriptions (subscription_id, owner_user_id, url, secret_enc) VALUES ($1, 'u1', $2, $3)",
      [outbox.newSubscriptionId(), "https://hooks.example.com/claw", crypto.encryptUserEnvValue("sub-secret")],
    );
  });

  const completion = (extra: Record<string, unknown> = {}) => ({
    type: "exec_complete", session_id: SESSION, task_id: RUN, message_id: "m1", user_id: "u1",
    final_text: "done", failed: false, run_claim: 2, ...extra,
  });

  /** One delivery of the message at stream sequence `seq`: "ack" or "nak". */
  async function deliverEvent(seq: number, event: Record<string, unknown>): Promise<"ack" | "nak"> {
    let answer: "ack" | "nak" | undefined;
    await consumer.consumeEventDelivery({
      subject: `events.${SESSION}`, data: sc.encode(JSON.stringify(event)), seq,
      ack: () => { answer ??= "ack"; }, nak: () => { answer ??= "nak"; },
    });
    await new Promise<void>((r) => setImmediate(r));
    assert.ok(answer, "the delivery was answered");
    return answer;
  }

  /** What JetStream does: redeliver a message until it is acked. */
  async function deliverUntilAcked(seq: number, event: Record<string, unknown>): Promise<string[]> {
    const answers: string[] = [];
    for (let i = 0; i < 6; i++) {
      const a = await deliverEvent(seq, event);
      answers.push(a);
      if (a === "ack") return answers;
    }
    return answers;
  }

  const runCompleted = () => sent.filter((r) => {
    const body = JSON.parse(String(r.body)) as { type?: string; task_id?: string };
    return body.type === "run.completed" && body.task_id === RUN;
  });

  test("an outbox write that fails is retried on redelivery, and the receiver hears the run end exactly once", async () => {
    failFirst = 2;
    const answers = await deliverUntilAcked(7, completion());
    // The two failed writes, then the one that lands; nothing after it is written again.
    assert.deepEqual(answers, ["nak", "nak", "ack"], "redelivered while the notification is owed, acked once it is recorded");
    assert.equal(writes, 3);
    assert.equal(summaries, 1, "the rest of the completion ran once, not once per redelivery");
    const ev = (await q("SELECT processed_at, run_notification_owed FROM claw_session_events WHERE event = 'exec_complete'")).rows;
    assert.equal(ev.length, 1);
    assert.notEqual(ev[0].processed_at, null);
    assert.equal(ev[0].run_notification_owed, null, "nothing is owed once recorded");
    assert.equal((await q("SELECT status FROM claw_tasks WHERE task_id = $1", [RUN])).rows[0].status, "completed");

    // A late copy of the same message, and Brain publishing the same completion again under a new sequence.
    assert.equal(await deliverEvent(7, completion()), "ack");
    assert.equal(await deliverEvent(8, completion()), "ack");
    await deliver();
    await deliver();
    assert.equal(runCompleted().length, 1, `exactly once: ${sent.length} sent`);
    const rows = (await q("SELECT count(*)::int AS n, count(delivered_at)::int AS delivered FROM claw_notification_outbox")).rows[0];
    assert.deepEqual(rows, { n: 1, delivered: 1 });
  });

  test("CONTROL: a write that does not fail is recorded on the first delivery, which is acked", async () => {
    assert.deepEqual(await deliverUntilAcked(7, completion()), ["ack"]);
    await deliver();
    assert.equal(runCompleted().length, 1);
  });

  test("a superseded claim's completion owes nothing and announces nothing", async () => {
    failFirst = 99;
    // The row was taken over (claim 2) and finished by its holder; this report is the first claim's.
    await q("UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE task_id = $1", [RUN]);
    assert.deepEqual(await deliverUntilAcked(7, completion({ run_claim: 1 })), ["ack"]);
    assert.equal(writes, 0, "never asked to record");
    const ev = (await q("SELECT run_notification_owed FROM claw_session_events WHERE event = 'exec_complete'")).rows;
    assert.equal(ev[0].run_notification_owed, null);
    await deliver();
    assert.equal(runCompleted().length, 0);
  });
});
