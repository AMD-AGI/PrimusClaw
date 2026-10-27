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

  async function seedRun(opts: { sid: string; tid: string; owner?: string; trigger?: string; seconds?: number; notify?: unknown }) {
    const cfg: Record<string, unknown> = opts.trigger ? { trigger_id: opts.trigger } : {};
    if (opts.notify !== undefined) cfg.notify_on_finish = opts.notify;
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
      await seedRun({ sid: "s-long", tid: "t-long", seconds: 120, notify: true });
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

    test("long_run requires the session's notify_on_finish opt-in", async () => {
      const cases: Array<{ name: string; seconds: number; notify?: unknown; trigger?: string; announced: boolean }> = [
        { name: "long run, no flag", seconds: 120, announced: false },
        { name: "long run, flag true", seconds: 120, notify: true, announced: true },
        { name: "long run, flag false", seconds: 120, notify: false, announced: false },
        { name: "long run, flag is the string 'true'", seconds: 120, notify: "true", announced: false },
        { name: "trigger session, no flag", seconds: 3, trigger: "trg-1", announced: true },
        { name: "short run, flag true", seconds: 3, notify: true, announced: false },
      ];
      await subscribe();
      for (const [i, c] of cases.entries()) {
        await q("DELETE FROM claw_notification_outbox");
        await seedRun({ sid: `s-c${i}`, tid: `t-c${i}`, seconds: c.seconds, notify: c.notify, trigger: c.trigger });
        await outbox.recordRunFinished({ sessionId: `s-c${i}`, taskIds: [`t-c${i}`], outcome: "completed" });
        assert.equal((await rows()).length, c.announced ? 1 : 0, c.name);
      }
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

    test("a receiver down for 30 minutes loses nothing: the subscription stays enabled and everything queued is delivered on recovery", async () => {
      const sub = await subscribe();
      const subRow = async () => (await q("SELECT enabled, consecutive_failures, failing_since FROM claw_notification_subscriptions WHERE subscription_id = $1", [sub.id])).rows[0] as any;
      for (let i = 0; i < 30; i++) {
        await q("INSERT INTO claw_notification_outbox (event_id, subscription_id, payload) VALUES ($1, $2, '{}'::jsonb)", [`ev-${i}`, sub.id]);
      }
      status = 503;
      // Far more failed attempts than the old attempt-count limit, over simulated half an hour.
      for (let pass = 0; pass < 6; pass++) { await deliver(); await makeDue(); }
      await q("UPDATE claw_notification_subscriptions SET failing_since = NOW() - interval '30 minutes'");
      await deliver();
      const mid = await subRow();
      assert.equal(mid.enabled, true, "still enabled");
      assert.ok(mid.consecutive_failures > 20, `attempts well past the old limit: ${mid.consecutive_failures}`);
      status = 200;
      await makeDue();
      for (let pass = 0; pass < 4; pass++) { await deliver(); await makeDue(); }
      assert.equal(((await q("SELECT COUNT(*)::int AS n FROM claw_notification_outbox WHERE delivered_at IS NOT NULL")).rows[0] as any).n, 30, "every queued event arrived");
      const after = await subRow();
      assert.equal(after.consecutive_failures, 0);
      assert.equal(after.failing_since, null, "recovery clears the outage clock");
    });

    test("a subscription with no success for more than a day is disabled, and its pending rows are then dropped", async () => {
      const sub = await subscribe();
      await q("INSERT INTO claw_notification_outbox (event_id, subscription_id, payload) VALUES ('ev-x', $1, '{}'::jsonb)", [sub.id]);
      status = 500;
      await deliver();
      assert.equal(((await q("SELECT enabled FROM claw_notification_subscriptions")).rows[0] as any).enabled, true, "first failure only starts the clock");
      await q("UPDATE claw_notification_subscriptions SET failing_since = NOW() - interval '25 hours'");
      await makeDue();
      await deliver();
      assert.equal(((await q("SELECT enabled FROM claw_notification_subscriptions")).rows[0] as any).enabled, false);
      await makeDue();
      sent.length = 0;
      await deliver();
      assert.equal(sent.length, 0);
    });

    test("a success in flight when another replica disables the subscription turns it back on", async () => {
      const sub = await subscribe();
      await q("UPDATE claw_notification_subscriptions SET failing_since = NOW() - interval '25 hours', consecutive_failures = 3");
      await q("INSERT INTO claw_notification_outbox (event_id, subscription_id, payload) VALUES ('ev-a', $1, '{}'::jsonb)", [sub.id]);
      await q("INSERT INTO claw_notification_outbox (event_id, subscription_id, payload, next_attempt_at) VALUES ('ev-b', $1, '{}'::jsonb, NOW() + interval '1 hour')", [sub.id]);
      const racing: Transport = async (req) => {
        if (req.headers[EVENT_ID_HEADER] !== "ev-a") return 200;
        // Meanwhile another replica fails ev-b past the 24h boundary.
        await q("UPDATE claw_notification_outbox SET next_attempt_at = NOW() - interval '1 second' WHERE event_id = 'ev-b'");
        await outbox.deliverDue({ transport: async () => 500, resolve: pub, allowedHosts: new Set() });
        assert.equal(((await q("SELECT enabled FROM claw_notification_subscriptions")).rows[0] as any).enabled, false, "the other replica disabled it");
        return 200;
      };
      await outbox.deliverDue({ transport: racing, resolve: pub, allowedHosts: new Set() });
      const row = (await q("SELECT enabled, failing_since FROM claw_notification_subscriptions")).rows[0] as any;
      assert.equal(row.enabled, true, "a working receiver must not stay disabled");
      assert.equal(row.failing_since, null);
    });

    test("a subscription its owner disabled stays disabled when a delivery in flight succeeds", async () => {
      const sub = await subscribe();
      await q("INSERT INTO claw_notification_outbox (event_id, subscription_id, payload) VALUES ('ev-a', $1, '{}'::jsonb)", [sub.id]);
      const racing: Transport = async () => {
        const r = await app.inject({ method: "PATCH", url: `/v1/notification-subscriptions/${sub.id}`, payload: { enabled: false } });
        assert.equal(r.statusCode, 200, r.body);
        return 200;
      };
      await outbox.deliverDue({ transport: racing, resolve: pub, allowedHosts: new Set() });
      assert.equal(((await q("SELECT enabled FROM claw_notification_subscriptions")).rows[0] as any).enabled, false);
    });

    test("one slow receiver does not hold up another subscription's delivery", async () => {
      const slow = await subscribe("u1", "https://slow.example.com/x");
      const fast = await subscribe("u2", "https://fast.example.com/x");
      for (const [sid, tid, owner] of [["s-slow", "t-slow", "u1"], ["s-fast", "t-fast", "u2"]]) {
        await seedRun({ sid, tid, owner, trigger: "trg" });
        await outbox.recordRunFinished({ sessionId: sid, taskIds: [tid], outcome: "completed" });
      }
      const finished: string[] = [];
      const t0 = Date.now();
      const times: Record<string, number> = {};
      const slowTransport: Transport = async (req) => {
        const host = req.target.url.hostname;
        if (host === "slow.example.com") await new Promise((r) => setTimeout(r, 1500));
        finished.push(host);
        times[host] = Date.now() - t0;
        return 200;
      };
      await outbox.deliverDue({ transport: slowTransport, resolve: pub, allowedHosts: new Set() });
      assert.deepEqual(finished, ["fast.example.com", "slow.example.com"], "the fast receiver is not queued behind the slow one");
      assert.ok(times["fast.example.com"] < 1000, `fast delivered after ${times["fast.example.com"]}ms`);
      void slow; void fast;
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
