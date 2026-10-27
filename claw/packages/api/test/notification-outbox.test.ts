// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Outbox, delivery and subscription routes, against a real Postgres whose
 * schema `initDb` built with `CLAW_NOTIFICATIONS_ENABLED` on. Skipped without
 * DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { verifySignature, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER } from "../src/notifications/signing.js";
import type { OutboundRequest, Transport } from "../src/notifications/transport.js";

const skip = postgresSkipReason();
const user = (id: string) => ({ userId: id, userName: id, roles: ["default"], platformKey: `pk-${id}`, virtualKey: `vk-${id}` });
const pub = async () => [{ address: "93.184.216.34", family: 4 }];

describe("notification outbox", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let caller = user("u1");
  let outbox: typeof import("../src/notifications/outbox.js");
  let crypto: typeof import("../src/crypto/user-env.js");
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  /** A receiver that records what it was sent and answers with `status`. */
  const sent: OutboundRequest[] = [];
  let status = 200;
  const transport: Transport = async (req) => { sent.push(req); return status; };
  const deliver = () => outbox.deliverDue({ transport, resolve: pub, allowedHosts: new Set() });
  const makeDue = () => q("UPDATE claw_notification_outbox SET next_attempt_at = NOW() - interval '1 second' WHERE delivered_at IS NULL AND dropped_at IS NULL");

  async function seedRun(opts: { sid: string; tid: string; owner?: string; trigger?: string; seconds?: number }) {
    const cfg = opts.trigger ? { trigger_id: opts.trigger } : {};
    await q(
      "INSERT INTO claw_sessions (session_id, name, user_id, mode, config) VALUES ($1, 'nightly', $2, 'claw', $3::jsonb) ON CONFLICT DO NOTHING",
      [opts.sid, opts.owner ?? "u1", JSON.stringify(cfg)],
    );
    await q(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, started_at, completed_at)
       VALUES ($1, $2, 'run', 'completed', NOW() - make_interval(secs => $3), NOW()) ON CONFLICT DO NOTHING`,
      [opts.tid, opts.sid, opts.seconds ?? 5],
    );
  }
  async function subscribe(owner = "u1", url = "https://hooks.example.com/claw", extra: Record<string, unknown> = {}) {
    const secret = "sub-secret-" + owner;
    const id = outbox.newSubscriptionId();
    await q(
      "INSERT INTO claw_notification_subscriptions (subscription_id, owner_user_id, url, secret_enc) VALUES ($1,$2,$3,$4)",
      [id, owner, url, crypto.encryptUserEnvValue(secret)],
    );
    if (extra.sources) await q("UPDATE claw_notification_subscriptions SET sources = $2::text[] WHERE subscription_id = $1", [id, extra.sources]);
    return { id, secret };
  }
  const rows = async () => (await q("SELECT * FROM claw_notification_outbox ORDER BY id")).rows as any[];

  before(async () => {
    h = await startAdmissionCluster({ CLAW_NOTIFICATIONS_ENABLED: "true", NOTIFY_MIN_RUN_SECONDS: "60" });
    crypto = await import("../src/crypto/user-env.js");
    crypto.initUserEnvCrypto();
    outbox = await import("../src/notifications/outbox.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => { (req as any).user = caller; });
    await (await import("../src/routes/notification-subscriptions.js")).registerNotificationSubscriptionRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await h?.stop(); });
  beforeEach(async () => {
    caller = user("u1");
    sent.length = 0;
    status = 200;
    await q("DELETE FROM claw_notification_outbox");
    await q("DELETE FROM claw_notification_subscriptions");
    await q("DELETE FROM claw_tasks");
    await q("DELETE FROM claw_sessions");
  });

  describe("what is announced", () => {
    test("a trigger-started run is announced even when short; a short chat turn is not; a long one is", async () => {
      await subscribe();
      await seedRun({ sid: "s-trig", tid: "t-trig", trigger: "trg-1", seconds: 3 });
      await seedRun({ sid: "s-chat", tid: "t-chat", seconds: 3 });
      await seedRun({ sid: "s-long", tid: "t-long", seconds: 120 });
      for (const [sid, tid] of [["s-trig", "t-trig"], ["s-chat", "t-chat"], ["s-long", "t-long"]]) {
        await outbox.recordRunFinished({ sessionId: sid, taskIds: [tid], outcome: "completed" });
      }
      const got = (await rows()).map((r) => r.payload.task_id).sort();
      assert.deepEqual(got, ["t-long", "t-trig"]);
      const trig = (await rows()).find((r) => r.payload.task_id === "t-trig").payload;
      assert.equal(trig.trigger_id, "trg-1");
      assert.equal(trig.type, "run.completed");
      assert.equal(trig.user_id, "u1");
      assert.match(trig.link, /\/sessions\/s-trig$/);
    });

    test("a failure carries a redacted, clipped summary and type run.failed", async () => {
      await subscribe();
      await seedRun({ sid: "s1", tid: "t1", trigger: "trg", seconds: 3 });
      await outbox.recordRunFinished({
        sessionId: "s1", taskIds: ["t1"], outcome: "failed",
        failureReason: "boom Bearer abcdef123456 " + "x".repeat(900),
      });
      const p = (await rows())[0].payload;
      assert.equal(p.type, "run.failed");
      assert.ok(p.summary.length <= 500, String(p.summary.length));
      assert.ok(!p.summary.includes("abcdef123456"), "the bearer token must be redacted");
    });

    test("only the run's owner's subscriptions receive it, and a source filter is honoured", async () => {
      await subscribe("u1");
      await subscribe("u2");
      const onlyLong = await subscribe("u1", "https://b.example.com/x", { sources: ["long_run"] });
      await seedRun({ sid: "s1", tid: "t1", owner: "u1", trigger: "trg" });
      await outbox.recordRunFinished({ sessionId: "s1", taskIds: ["t1"], outcome: "completed" });
      const rs = await rows();
      assert.equal(rs.length, 1, "u2 and the long_run-only subscription must not receive a trigger run");
      assert.notEqual(rs[0].subscription_id, onlyLong.id);
      const owners = (await q("SELECT owner_user_id FROM claw_notification_subscriptions WHERE subscription_id = $1", [rs[0].subscription_id])).rows[0] as any;
      assert.equal(owners.owner_user_id, "u1");
    });
  });

  describe("dedup", () => {
    test("recording the same completion twice stores one row; event_id is derived, not random", async () => {
      await subscribe();
      await seedRun({ sid: "s1", tid: "t1", trigger: "trg" });
      const a = await outbox.recordRunFinished({ sessionId: "s1", taskIds: ["t1"], outcome: "completed" });
      const b = await outbox.recordRunFinished({ sessionId: "s1", taskIds: ["t1"], outcome: "completed" });
      assert.equal(a, 1);
      assert.equal(b, 0);
      assert.equal((await rows()).length, 1);
      assert.equal((await rows())[0].event_id, outbox.deterministicEventId("run.completed", "s1", "t1"));
      assert.notEqual(
        outbox.deterministicEventId("run.completed", "s1", "t1"),
        outbox.deterministicEventId("run.failed", "s1", "t1"),
      );
    });
  });

  describe("delivery and retry", () => {
    test("a delivery is signed so the subscription's secret verifies it, and is marked delivered", async () => {
      const sub = await subscribe();
      await seedRun({ sid: "s1", tid: "t1", trigger: "trg" });
      await outbox.recordRunFinished({ sessionId: "s1", taskIds: ["t1"], outcome: "completed" });
      const r = await deliver();
      assert.deepEqual(r, { delivered: 1, failed: 0 });
      assert.equal(sent.length, 1);
      const req = sent[0];
      assert.equal(verifySignature({
        secret: sub.secret, timestamp: req.headers[TIMESTAMP_HEADER], signature: req.headers[SIGNATURE_HEADER], body: req.body,
      }), "ok");
      assert.equal(verifySignature({
        secret: "wrong", timestamp: req.headers[TIMESTAMP_HEADER], signature: req.headers[SIGNATURE_HEADER], body: req.body,
      }), "bad_signature");
      assert.equal(req.headers[EVENT_ID_HEADER], (await rows())[0].event_id);
      assert.ok((await rows())[0].delivered_at);
      // Delivered rows are never sent again.
      await makeDue();
      assert.deepEqual(await deliver(), { delivered: 0, failed: 0 });
    });

    test("a failing receiver is retried on the backoff schedule with the same event id, then succeeds once", async () => {
      await subscribe();
      await seedRun({ sid: "s1", tid: "t1", trigger: "trg" });
      await outbox.recordRunFinished({ sessionId: "s1", taskIds: ["t1"], outcome: "completed" });
      status = 503;
      const wait = async () => Number(((await q(
        "SELECT EXTRACT(EPOCH FROM (next_attempt_at - NOW())) AS s FROM claw_notification_outbox",
      )).rows[0] as any).s);
      for (const [i, expected] of outbox.RETRY_BACKOFF_SECONDS.entries()) {
        assert.deepEqual(await deliver(), { delivered: 0, failed: 1 }, `attempt ${i + 1}`);
        const w = await wait();
        assert.ok(w > expected - 2 && w <= expected, `attempt ${i + 1}: waits ${w}s, expected about ${expected}s`);
        // Not due yet: nothing is sent until the wait has passed.
        assert.deepEqual(await deliver(), { delivered: 0, failed: 0 });
        await makeDue();
      }
      status = 200;
      assert.deepEqual(await deliver(), { delivered: 1, failed: 0 });
      assert.equal(new Set(sent.map((s) => s.headers[EVENT_ID_HEADER])).size, 1, "every attempt carries the same event id");
      assert.equal(sent.length, outbox.RETRY_BACKOFF_SECONDS.length + 1);
      assert.equal((await rows())[0].attempts, outbox.RETRY_BACKOFF_SECONDS.length + 1);
    });

    test("a row older than the give-up age is dropped, not retried for ever", async () => {
      await subscribe();
      await seedRun({ sid: "s1", tid: "t1", trigger: "trg" });
      await outbox.recordRunFinished({ sessionId: "s1", taskIds: ["t1"], outcome: "completed" });
      await q("UPDATE claw_notification_outbox SET created_at = NOW() - interval '25 hours'");
      status = 500;
      await deliver();
      const r = (await rows())[0];
      assert.ok(r.dropped_at, "dropped");
      await makeDue();
      assert.deepEqual(await deliver(), { delivered: 0, failed: 0 });
    });

    test("a subscription that keeps failing is disabled at the limit; a success before that resets the streak", async () => {
      const sub = await subscribe();
      const subRow = async () => (await q("SELECT enabled, consecutive_failures FROM claw_notification_subscriptions WHERE subscription_id = $1", [sub.id])).rows[0] as any;
      const addRows = async (n: number, tag: string) => {
        for (let i = 0; i < n; i++) {
          await q("INSERT INTO claw_notification_outbox (event_id, subscription_id, payload) VALUES ($1, $2, '{}'::jsonb)", [`${tag}-${i}`, sub.id]);
        }
      };
      // Five failures, then one success: the streak is back to zero.
      await addRows(5, "a");
      status = 500;
      await deliver();
      assert.equal((await subRow()).consecutive_failures, 5);
      await q("DELETE FROM claw_notification_outbox");
      await addRows(1, "b");
      status = 200;
      await deliver();
      assert.deepEqual(await subRow(), { enabled: true, consecutive_failures: 0 });
      // The limit minus one failure leaves it enabled; the next one disables it.
      await q("DELETE FROM claw_notification_outbox");
      await addRows(outbox.SUBSCRIPTION_FAILURE_LIMIT - 1, "c");
      status = 500;
      // Ten rows are claimed per pass and a failed one waits out its backoff, so two passes make nineteen attempts.
      await deliver();
      await deliver();
      assert.deepEqual(await subRow(), { enabled: true, consecutive_failures: outbox.SUBSCRIPTION_FAILURE_LIMIT - 1 });
      await q("DELETE FROM claw_notification_outbox");
      await addRows(1, "d");
      await deliver();
      assert.equal((await subRow()).enabled, false, "disabled at the failure limit");
      // A disabled subscription is dropped, not sent to.
      await q("DELETE FROM claw_notification_outbox");
      await addRows(1, "e");
      sent.length = 0;
      await deliver();
      assert.equal(sent.length, 0);
      assert.equal(((await rows())[0]).last_status, "subscription_gone");
    });

    test("a subscription pointing at a private address is refused at delivery, not connected to", async () => {
      await subscribe("u1", "https://internal.example.com/x");
      await seedRun({ sid: "s1", tid: "t1", trigger: "trg" });
      await outbox.recordRunFinished({ sessionId: "s1", taskIds: ["t1"], outcome: "completed" });
      const r = await outbox.deliverDue({
        transport, allowedHosts: new Set(), resolve: async () => [{ address: "10.1.1.1", family: 4 }],
      });
      assert.deepEqual(r, { delivered: 0, failed: 1 });
      assert.equal(sent.length, 0);
      assert.match((await rows())[0].last_status, /private_address/);
    });
  });

  describe("subscription routes", () => {
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/v1/notification-subscriptions", payload: payload as object });

    test("create returns the secret once, stores it encrypted, and list never shows it", async () => {
      // A name that resolves publicly is needed: use a literal public address.
      const res = await post({ url: "https://93.184.216.34/claw" });
      assert.equal(res.statusCode, 201, res.body);
      const created = res.json().data;
      assert.match(created.secret, /^[0-9a-f]{64}$/);
      const stored = (await q("SELECT secret_enc FROM claw_notification_subscriptions WHERE subscription_id = $1", [created.subscription_id])).rows[0] as any;
      assert.notEqual(stored.secret_enc, created.secret);
      assert.equal(crypto.decryptUserEnvValue(stored.secret_enc), created.secret);
      const list = await app.inject({ method: "GET", url: "/v1/notification-subscriptions" });
      assert.ok(!list.body.includes(created.secret));
      assert.equal(list.json().data.length, 1);
    });

    test("private, plain-http and malformed URLs and bad filters are refused with nothing stored", async () => {
      for (const url of ["https://127.0.0.1/x", "https://10.0.0.5/x", "http://93.184.216.34/x", "ftp://93.184.216.34/x", "nope"]) {
        assert.equal((await post({ url })).statusCode, 400, url);
      }
      assert.equal((await post({ url: "https://93.184.216.34/x", event_types: ["nope"] })).statusCode, 400);
      assert.equal((await post({})).statusCode, 400);
      assert.equal(Number(((await q("SELECT COUNT(*)::int AS n FROM claw_notification_subscriptions")).rows[0] as any).n), 0);
    });

    test("another user cannot see, change or delete a subscription; 404 not 403", async () => {
      const id = (await post({ url: "https://93.184.216.34/x" })).json().data.subscription_id;
      caller = user("u2");
      assert.equal((await app.inject({ method: "GET", url: "/v1/notification-subscriptions" })).json().data.length, 0);
      assert.equal((await app.inject({ method: "PATCH", url: `/v1/notification-subscriptions/${id}`, payload: { enabled: false } })).statusCode, 404);
      assert.equal((await app.inject({ method: "DELETE", url: `/v1/notification-subscriptions/${id}` })).statusCode, 404);
      caller = user("u1");
      assert.equal((await app.inject({ method: "PATCH", url: `/v1/notification-subscriptions/${id}`, payload: { enabled: false } })).json().data.enabled, false);
      assert.equal((await app.inject({ method: "DELETE", url: `/v1/notification-subscriptions/${id}` })).statusCode, 200);
    });

    test("the number of subscriptions per user is capped", async () => {
      for (let i = 0; i < 5; i++) assert.equal((await post({ url: `https://93.184.216.34/${i}` })).statusCode, 201);
      assert.equal((await post({ url: "https://93.184.216.34/6" })).statusCode, 409);
    });

    test("the anonymous sentinel user cannot subscribe", async () => {
      caller = user("default");
      assert.equal((await post({ url: "https://93.184.216.34/x" })).statusCode, 403);
    });
  });
});
