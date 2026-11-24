// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a machine's replies get through (`remote-agents/delivery-health.ts`), over the real connector routes on a real Postgres
 * with remote agents, the assistant and notifications on. Batches and heartbeats have the shapes the connector posts; a batch the
 * database refuses is made by a trigger that raises, on a marked event, the error a full disk raises (53100): one the route
 * cannot set aside as that event's own (an event it cannot store, class 22 or 54, is refused alone and the rest kept), so the
 * same batch fails on every retry and the 5xx comes from the real `ingestEvents` and the real route. Time is moved by writing the instants the sweep counts from, so no test
 * waits two minutes. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   D1  the heartbeat's outbox report is recorded; a malformed one is ignored and the heartbeat still answers 200
 *   D2  a batch Claw keeps failing (5xx) is counted per connector; after two minutes the owner is told once that replies are
 *       delayed, the next batches that store clear it, and once the connector's report is clean they are told once that the
 *       replies get through again
 *   D3  a stall only the connector sees (a network that drops its posts) is told from its report, with the counts it gave
 *   D4  under two minutes nothing is said; a connector that goes quiet while stalled (offline) is not told it recovered
 *   D5  a notice that could not be stored is tried again by the next sweep and said once; one owner's failure does not hold up
 *       another's notice
 *   D6  a revoked connector is told nothing
 *   D7  the delivery gauges: backlog age and size by queue, per-connector series only for connectors behind or failing now,
 *       the notification outbox's oldest waiting row and failing subscriptions, the post outcomes
 *   D8  only one replica sweeps at a time
 *   D9  the heartbeat and the events batch are answered without waiting on their delivery-health writes: with the rows locked
 *       they still answer at once, at most DELIVERY_WRITE_CONCURRENCY writes wait on the database, a connector's reports queued
 *       meanwhile land as its latest one, and everything lands once the lock is gone
 *   D10 a connector restarted mid-stall reports no failure (its count is of the new run) while its backlog still waits: not
 *       "recovered" until a batch gets through
 *   D11 a notice is marked said only once said: a replica that died between the sweep and the saying, or an owner with no
 *       assistant to say it through, is told by a later sweep, once
 *   D14 a stall that ends while its "delayed" is still being said is not told it recovered unless that was said: not when the
 *       replica died before saying it, nor when there was no assistant to say it through (one set up meanwhile); yes when it
 *       was said and the replica died before marking it
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const AGENT = { agent_id: "claude", kind: "claude-code", name: "Claude Code", capabilities: { loadSession: true } };
const POISON = "poison-marker-7f3a";

describe("remote delivery health", { skip }, () => {
  let w: World;
  let health: typeof import("../src/remote-agents/delivery-health.js");
  let metricsMod: typeof import("../src/infra/metrics.js");
  let app: FastifyInstance;
  let base = "";

  before(async () => {
    w = await startWorld({ CLAW_REMOTE_AGENTS_ENABLED: "true" });
    health = await import("../src/remote-agents/delivery-health.js");
    metricsMod = await import("../src/infra/metrics.js");
    const { registerRemoteAgentRoutes } = await import("../src/routes/remote-agents.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id === "string") (req as any).user = { userId: id, userName: id, platformKey: "", virtualKey: "", roles: ["default"] };
    });
    await registerRemoteAgentRoutes(app, { pingMs: 150, pollMs: 40, retentionDays: 0, presenceSweepMs: 0, undeliveredSweepMs: 0, deliverySweepMs: 0 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    // The database refusing a batch with an error that is not one event's value (a full disk): the batch fails as a whole, on
    // every retry while it lasts.
    await w.q(`CREATE OR REPLACE FUNCTION test_poison_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.data::text LIKE '%${POISON}%' THEN
          RAISE EXCEPTION 'could not extend file: No space left on device' USING ERRCODE = '53100';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await w.q("DROP TRIGGER IF EXISTS test_poison_event ON claw_remote_events");
    await w.q("CREATE TRIGGER test_poison_event BEFORE INSERT ON claw_remote_events FOR EACH ROW EXECUTE FUNCTION test_poison_event()");
  });
  after(async () => {
    await w?.q("DROP TRIGGER IF EXISTS test_poison_event ON claw_remote_events").catch(() => undefined);
    await app?.close();
    metricsMod?.metrics.setDeliverySampler(null);
    await w?.stop();
  });

  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };
  beforeEach(async () => {
    health.deliveryPorts.tell = realTell;
    await w.q(`TRUNCATE claw_remote_delivery_health, claw_remote_connectors, claw_assistant_says, claw_assistant_messages,
      claw_notification_outbox, claw_notification_subscriptions, claw_assistants, claw_sessions CASCADE`);
    alice = await w.user("alice");
    bob = await w.user("bob");
    await said(alice, "帮我看看开发环境上的会话");
    await said(bob, "how are my sessions doing");
    await w.subscribe("alice");
    await w.subscribe("bob");
  });
  let realTell: (typeof import("../src/remote-agents/delivery-health.js"))["deliveryPorts"]["tell"];
  before(() => { realTell = health.deliveryPorts.tell; });

  async function said(u: { userId: string; routerSid: string }, content: string): Promise<void> {
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content) VALUES ($1, $2, $3, 'U', $4)`,
      [u.routerSid, `m-${randomUUID()}`, u.userId, content],
    );
  }

  type Res = { status: number; body: any };
  async function call(user: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Res> {
    const r = await fetch(base + path, {
      method, signal, headers: { "x-test-user": user, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  async function connector(user: string, name: string): Promise<string> {
    const r = await call(user, "POST", "/v1/remote-agents/connectors", { name, version: "0.2.3" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.connector_id;
  }
  /** A heartbeat as the connector sends it, with its outbox report (`outbox`), or none (a connector from before it). */
  /** The answer, once what it left to be written off the request path (`deliveryWritesIdle`) has landed too. */
  const settled = async (r: Promise<Res>): Promise<Res> => { const out = await r; await health.deliveryWritesIdle(); return out; };
  const heartbeatNow = (user: string, cid: string, outbox?: unknown, signal?: AbortSignal) =>
    call(user, "POST", `/v1/remote-agents/connectors/${cid}/heartbeat`, { version: "0.2.3", agents: [AGENT], cmd_cursor: null, ...(outbox === undefined ? {} : { outbox }) }, signal);
  const heartbeat = (user: string, cid: string, outbox?: unknown) => settled(heartbeatNow(user, cid, outbox));
  const report = (o: { pending?: number; oldestMs?: number; failures?: number; failingMs?: number; lastError?: string | null; sessions?: Array<[string, number, number]> } = {}) => ({
    pending: o.pending ?? 0, oldest_age_ms: o.oldestMs ?? 0, failures: o.failures ?? 0, failing_ms: o.failingMs ?? 0,
    last_error: o.lastError ?? null, sessions: (o.sessions ?? []).map(([sid, pending, age]) => ({ session_id: sid, pending, oldest_age_ms: age })),
  });
  async function session(user: string, cid: string): Promise<string> {
    // Online first: a session is opened only on a connector with an open command stream and its agent advertised.
    assert.equal((await heartbeat(user, cid)).status, 200);
    await w.q("UPDATE claw_remote_connectors SET stream_conn = 'c1', stream_seen_at = NOW() WHERE connector_id = $1", [cid]);
    const r = await call(user, "POST", "/v1/remote-agents/sessions", { connector_id: cid, agent_id: "claude", cwd: "/work/repo" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.session_id;
  }
  /** Events with the shapes a Claude Code session posts: the turn's text in chunks, then its end. */
  const chunk = (sid: string, seq: number, text: string) => ({
    session_id: sid, seq, type: "agent_message_chunk", ts: Date.now(), data: { content: { type: "text", text } },
  });
  const turnEnd = (sid: string, seq: number) => ({ session_id: sid, seq, type: "turn_end", ts: Date.now(), data: { stopReason: "end_turn" } });
  const postNow = (user: string, cid: string, events: unknown[], signal?: AbortSignal) =>
    call(user, "POST", `/v1/remote-agents/connectors/${cid}/events`, { batch_id: `b-${randomUUID().slice(0, 8)}`, events }, signal);
  const post = (user: string, cid: string, events: unknown[]) => settled(postNow(user, cid, events));

  const row = async (cid: string) => (await w.q("SELECT * FROM claw_remote_delivery_health WHERE connector_id = $1", [cid]))[0];
  const says = async (userId: string) => (await w.q("SELECT text FROM claw_assistant_says WHERE user_id = $1 ORDER BY created_at", [userId])).map((r) => String(r.text));
  /** What reached the user's chat channel: the notification rows their subscription was given for the notices. */
  const outboxTexts = async (userId: string) => (await w.q(
    `SELECT o.payload FROM claw_notification_outbox o JOIN claw_notification_subscriptions s USING (subscription_id)
      WHERE s.owner_user_id = $1 ORDER BY o.id`, [userId],
  )).map((r) => JSON.stringify(r.payload));
  const sweep = () => health.runDeliveryHealthSweep();
  /** As if what failed had started failing `minutes` ago. */
  const failingFor = (cid: string, minutes: number) => w.q(
    `UPDATE claw_remote_delivery_health SET api_failing_since = NOW() - make_interval(mins => $2::int),
            post_failing_since = CASE WHEN post_failures > 0 THEN NOW() - make_interval(mins => $2::int) END WHERE connector_id = $1`,
    [cid, minutes],
  );

  test("D1 the outbox report is recorded with each heartbeat; a malformed one is ignored and the heartbeat still answers", async () => {
    const cid = await connector("alice", "dev-box");
    const sid = randomUUID();
    const r = await heartbeat("alice", cid, report({ pending: 3, oldestMs: 45_000, failures: 2, failingMs: 30_000, lastError: "http_500", sessions: [[sid, 3, 45_000]] }));
    assert.equal(r.status, 200);
    const h = await row(cid);
    assert.equal(h.owner_user_id, "alice");
    assert.equal(h.pending, 3);
    assert.equal(h.post_failures, 2);
    assert.equal(h.post_last_error, "http_500");
    assert.deepEqual(h.sessions, [{ session_id: sid, pending: 3, oldest_age_ms: 45_000 }]);
    const age = (Date.now() - new Date(h.oldest_since).getTime()) / 1000;
    assert.ok(age > 40 && age < 60, `oldest_since is 45 s ago on Claw's clock (${age})`);
    for (const bad of ["nope", { pending: -1 }, { pending: 1, oldest_age_ms: "x", failures: 0, failing_ms: 0 }]) {
      assert.equal((await heartbeat("alice", cid, bad)).status, 200, JSON.stringify(bad));
    }
    assert.equal((await row(cid)).pending, 3, "a malformed report changes nothing");
    assert.equal((await heartbeat("alice", cid, report())).status, 200);
    const clean = await row(cid);
    assert.deepEqual([clean.pending, clean.post_failures, clean.oldest_since, clean.post_last_error, clean.sessions], [0, 0, null, null, []]);
  });

  test("D2 a batch Claw keeps failing is told once after two minutes, and once again when the replies get through", async () => {
    const cid = await connector("alice", "dev-box");
    const sid = await session("alice", cid);
    assert.equal((await post("alice", cid, [chunk(sid, 1, "Looking at the failing test"), turnEnd(sid, 2)])).status, 200);
    // One event the database refuses, and the connector posting the same batch again and again.
    const stuck = [chunk(sid, 3, `the log says ${POISON}`), chunk(sid, 4, "and the fix is"), turnEnd(sid, 5)];
    for (let i = 0; i < 3; i++) assert.equal((await post("alice", cid, stuck)).status, 500);
    const h = await row(cid);
    assert.equal(h.api_failures, 3);
    assert.equal(h.api_last_error, "pg_53100");
    // What the connector says meanwhile, with every heartbeat.
    await heartbeat("alice", cid, report({ pending: 3, oldestMs: 30_000, failures: 3, failingMs: 30_000, lastError: "http_500", sessions: [[sid, 3, 30_000]] }));
    assert.deepEqual((await sweep()).notices, [], "not before two minutes");
    await failingFor(cid, 1);
    assert.deepEqual((await sweep()).notices, [], "one minute is not two");
    await failingFor(cid, 2);
    await w.q("UPDATE claw_remote_delivery_health SET oldest_since = NOW() - interval '2 minutes 30 seconds' WHERE connector_id = $1", [cid]);
    const told = await sweep();
    assert.equal(told.notices.length, 1);
    assert.equal(told.notices[0].kind, "delayed");
    const delayed = "你的开发环境 dev-box 上的会话回复暂时没能送到（3 条在排队，最早的已等 2 分钟），正在自动重试；恢复后会再告诉你。";
    assert.deepEqual(await says("alice"), [delayed]);
    assert.equal((await outboxTexts("alice")).filter((p) => p.includes("暂时没能送到")).length, 1, "it reaches alice's chat channel once");
    // The connector goes on retrying, and every sweep meanwhile says nothing more.
    for (let i = 0; i < 3; i++) {
      assert.equal((await post("alice", cid, stuck)).status, 500);
      assert.deepEqual((await sweep()).notices, []);
    }
    assert.equal((await says("alice")).length, 1);
    assert.equal((await row(cid)).stall_state, "stalled");
    // The batch stores (the event got past, however): Claw's side clears at once; the connector's own report says so next.
    assert.equal((await post("alice", cid, [chunk(sid, 3, "the log says it"), chunk(sid, 4, "and the fix is"), turnEnd(sid, 5)])).status, 200);
    assert.equal((await row(cid)).api_failures, 0);
    assert.deepEqual((await sweep()).notices, [], "not until the connector says its posts succeed");
    await heartbeat("alice", cid, report());
    const back = await sweep();
    assert.deepEqual(back.notices.map((n) => n.kind), ["recovered"]);
    await sweep();
    assert.deepEqual(await says("alice"), [delayed, "你的开发环境 dev-box 上的会话回复已恢复送达，排队的回复正在补发。"]);
    assert.equal((await says("bob")).length, 0, "nobody else is told");
    // The events are all there, in order: nothing was lost behind the stall.
    const seqs = (await w.q("SELECT seq FROM claw_remote_events WHERE session_id = $1 ORDER BY seq", [sid])).map((r) => Number(r.seq));
    assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
    // A second stall is a new episode, told again.
    for (let i = 0; i < 2; i++) assert.equal((await post("alice", cid, [chunk(sid, 6, POISON)])).status, 500);
    await failingFor(cid, 3);
    assert.equal((await sweep()).notices.length, 1);
    assert.equal((await says("alice")).length, 3);
  });

  test("D3 a stall only the connector sees is told from its report, in the owner's language", async () => {
    const cid = await connector("bob", "build-host");
    const [s1, s2] = [randomUUID(), randomUUID()];
    // Its posts never reach Claw (a proxy drops them): only the heartbeat says so.
    await heartbeat("bob", cid, report({ pending: 7, oldestMs: 200_000, failures: 9, failingMs: 190_000, lastError: "network", sessions: [[s1, 5, 200_000], [s2, 2, 10_000]] }));
    const told = await sweep();
    assert.deepEqual(told.notices.map((n) => [n.kind, n.pending, n.oldestMinutes, n.sessions]), [["delayed", 7, 3, 2]]);
    assert.deepEqual(await says("bob"), [
      "Replies from the sessions on your dev environment build-host are delayed (7 waiting, the oldest for 3 min). They are being retried; you will be told when they get through.",
    ]);
    // Draining (posts get through, events still waiting) is recovery: the failures are what was told. A clean report alone is not
    // (see D10); the batch that got through is.
    await heartbeat("bob", cid, report({ pending: 4, oldestMs: 1_000, failures: 0 }));
    assert.deepEqual((await sweep()).notices, [], "no batch got through yet");
    const sid = await session("bob", cid);
    assert.equal((await post("bob", cid, [chunk(sid, 1, "the build is green"), turnEnd(sid, 2)])).status, 200);
    await heartbeat("bob", cid, report({ pending: 4, oldestMs: 1_000, failures: 0 }));
    assert.deepEqual((await sweep()).notices.map((n) => n.kind), ["recovered"]);
    assert.equal((await says("bob"))[1], "Replies from the sessions on your dev environment build-host are getting through again; the delayed ones are being delivered now.");
  });

  test("D4 under two minutes nothing is said; a connector that goes quiet while stalled is not told it recovered", async () => {
    const cid = await connector("alice", "dev-box");
    await heartbeat("alice", cid, report({ pending: 2, oldestMs: 100_000, failures: 4, failingMs: 100_000, lastError: "http_502" }));
    assert.deepEqual((await sweep()).notices, []);
    // Events waiting long, but no post failed (a slow disk on the machine, a long first batch): not this notice.
    await heartbeat("alice", cid, report({ pending: 2, oldestMs: 600_000, failures: 0 }));
    assert.deepEqual((await sweep()).notices, []);
    await heartbeat("alice", cid, report({ pending: 2, oldestMs: 300_000, failures: 4, failingMs: 300_000, lastError: "http_502" }));
    assert.equal((await sweep()).notices.length, 1);
    // Offline now: its report goes stale. Nothing here says it got better, so nothing is said.
    await w.q("UPDATE claw_remote_delivery_health SET reported_at = NOW() - interval '10 minutes' WHERE connector_id = $1", [cid]);
    assert.deepEqual((await sweep()).notices, []);
    assert.equal((await row(cid)).stall_state, "stalled");
    assert.equal((await says("alice")).length, 1);
    // An old connector (no report) whose posts Claw failed long ago, and that stopped posting: not a stall now.
    const old = await connector("alice", "old-box");
    await post("alice", old, [chunk(randomUUID(), 1, POISON)]);
    await w.q("UPDATE claw_remote_delivery_health SET api_failing_since = NOW() - interval '1 hour', api_failed_at = NOW() - interval '30 minutes' WHERE connector_id = $1", [old]);
    assert.deepEqual((await sweep()).notices, []);
  });

  test("D5 a notice that could not be stored is tried again and said once; one owner's failure does not hold up another's", async () => {
    const a = await connector("alice", "dev-box");
    const b = await connector("bob", "build-host");
    for (const [u, c] of [["alice", a], ["bob", b]] as const) {
      await heartbeat(u, c, report({ pending: 1, oldestMs: 180_000, failures: 3, failingMs: 180_000, lastError: "http_500" }));
    }
    let calls = 0;
    health.deliveryPorts.tell = async (n) => {
      calls += 1;
      if (n.owner === "alice" && calls <= 2) throw new Error("the database blinked");
      return realTell(n);
    };
    const first = await sweep();
    assert.deepEqual(first.notices.map((n) => n.owner).sort(), ["alice", "bob"]);
    assert.equal((await says("alice")).length, 0);
    assert.equal((await says("bob")).length, 1, "bob is told although alice's notice failed");
    assert.equal((await row(a)).stall_notice, "pending");
    await sweep();
    await sweep();
    await sweep();
    assert.equal((await says("alice")).length, 1);
    assert.equal((await says("bob")).length, 1);
    // Recovered, and the first "back" fails too: tried again, said once.
    calls = 0;
    const sid = await session("alice", a);
    assert.equal((await post("alice", a, [chunk(sid, 1, "done"), turnEnd(sid, 2)])).status, 200);
    await heartbeat("alice", a, report());
    await sweep();
    assert.equal((await row(a)).stall_notice, "back_pending");
    await sweep();
    await sweep();
    assert.equal((await says("alice")).length, 2);
  });

  test("D6 a revoked connector is told nothing", async () => {
    const cid = await connector("alice", "dev-box");
    await heartbeat("alice", cid, report({ pending: 1, oldestMs: 300_000, failures: 3, failingMs: 300_000, lastError: "http_500" }));
    assert.equal((await call("alice", "DELETE", `/v1/remote-agents/connectors/${cid}`)).status, 200);
    assert.deepEqual((await sweep()).notices, []);
    assert.deepEqual(await says("alice"), []);
  });

  test("D7 the delivery gauges read the backlog, the failing connectors and the notification outbox", async () => {
    const { metrics, registry } = metricsMod;
    // Alice's channel is not the one under test here: her notice must not add a row (or a failing receiver) of its own.
    await w.q("DELETE FROM claw_notification_subscriptions WHERE owner_user_id = 'alice'");
    const behind = await connector("alice", "dev-box");
    const fine = await connector("bob", "build-host");
    const quiet = await connector("bob", "spare");
    await heartbeat("alice", behind, report({ pending: 4, oldestMs: 700_000, failures: 6, failingMs: 650_000, lastError: "http_500" }));
    await heartbeat("bob", fine, report({ pending: 1, oldestMs: 2_000 }));
    await heartbeat("bob", quiet, report());
    await sweep();
    // A notification nobody could deliver for 15 minutes, and its subscription failing.
    const sub = (await w.q("SELECT subscription_id FROM claw_notification_subscriptions WHERE owner_user_id = 'bob'"))[0].subscription_id;
    await w.q(
      `INSERT INTO claw_notification_outbox (event_id, subscription_id, payload, attempts, next_attempt_at, last_status, created_at)
       VALUES ('ev-stuck', $1, '{}'::jsonb, 9, NOW() + interval '1 minute', 'http_503', NOW() - interval '15 minutes')`, [sub],
    );
    // And one held on purpose, not due and never tried: not late.
    await w.q(
      `INSERT INTO claw_notification_outbox (event_id, subscription_id, payload, attempts, next_attempt_at, created_at)
       VALUES ('ev-held', $1, '{}'::jsonb, 0, NOW() + interval '1 hour', NOW() - interval '2 hours')`, [sub],
    );
    await w.q("UPDATE claw_notification_subscriptions SET consecutive_failures = 9, failing_since = NOW() - interval '15 minutes' WHERE subscription_id = $1", [sub]);
    metrics.setDeliverySampler(() => health.sampleDeliveryHealth());
    const text = await registry.metrics();
    const value = (re: RegExp): number => {
      const m = re.exec(text);
      assert.ok(m, `no line matching ${re}`);
      return Number(m[1]);
    };
    const remoteAge = value(/^claw_delivery_backlog_oldest_age_seconds\{queue="remote_events",service="claw-api"\} (\S+)$/m);
    assert.ok(remoteAge >= 699 && remoteAge < 760, String(remoteAge));
    assert.equal(value(/^claw_delivery_backlog_size\{queue="remote_events",service="claw-api"\} (\S+)$/m), 5);
    const outboxAge = value(/^claw_delivery_backlog_oldest_age_seconds\{queue="notification_outbox",service="claw-api"\} (\S+)$/m);
    assert.ok(outboxAge >= 899 && outboxAge < 960, String(outboxAge));
    // The stuck row; not the held one.
    assert.equal(value(/^claw_delivery_backlog_size\{queue="notification_outbox",service="claw-api"\} (\S+)$/m), 1);
    assert.ok(value(new RegExp(`^claw_remote_connector_backlog_age_seconds\\{connector_id="${behind}",service="claw-api"\\} (\\S+)$`, "m")) >= 699);
    assert.equal(value(new RegExp(`^claw_remote_connector_post_failures\\{connector_id="${behind}",side="connector",service="claw-api"\\} (\\S+)$`, "m")), 6);
    assert.ok(!text.includes(fine) && !text.includes(quiet), "a connector that is not behind exports no series");
    assert.equal(value(/^claw_remote_delivery_stalled\{service="claw-api"\} (\S+)$/m), 1);
    assert.equal(value(/^claw_notification_subscriptions_failing\{service="claw-api"\} (\S+)$/m), 1);
    assert.equal(value(/^claw_notification_subscription_failures_max\{service="claw-api"\} (\S+)$/m), 9);
    assert.ok(value(/^claw_delivery_stall_notices_total\{kind="delayed",outcome="told",service="claw-api"\} (\S+)$/m) >= 1);
    assert.ok(value(/^claw_remote_events_post_total\{outcome="server_error",service="claw-api"\} (\S+)$/m) >= 1);
    assert.ok(value(/^claw_remote_events_post_total\{outcome="ok",service="claw-api"\} (\S+)$/m) >= 1);
    // A sampler that fails exports nothing rather than a stale or zero backlog.
    metrics.setDeliverySampler(async () => { throw new Error("database gone"); });
    assert.doesNotMatch(await registry.metrics(), /^claw_delivery_backlog_oldest_age_seconds\{/m);
    metrics.setDeliverySampler(null);
  });

  test("D8 only one replica sweeps at a time", async () => {
    const cid = await connector("alice", "dev-box");
    await heartbeat("alice", cid, report({ pending: 1, oldestMs: 300_000, failures: 3, failingMs: 300_000, lastError: "http_500" }));
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(7001, hashtext('delivery-health'))");
      const out = await sweep();
      assert.equal(out.swept, false);
      assert.deepEqual(await says("alice"), []);
      await holder.query("COMMIT");
    } finally {
      await holder.end();
    }
    assert.equal((await sweep()).notices.length, 1);
  });
  test("D9 the routes answer without waiting on their delivery-health writes, with bounded writes behind them", async () => {
    const cids: string[] = [];
    for (let i = 0; i < 10; i++) cids.push(await connector(i % 2 ? "bob" : "alice", `box-${i}`));
    const cid = cids[0];
    const sid = await session("alice", cid);
    // Every connector has its row, and the first one a failing answer of Claw's to clear (so a stored batch writes).
    for (const [i, c] of cids.entries()) await heartbeat(i % 2 ? "bob" : "alice", c, report({ pending: 1, oldestMs: 1_000 }));
    assert.equal((await post("alice", cid, [chunk(sid, 1, POISON)])).status, 500);
    assert.equal((await row(cid)).api_failures, 1);
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    const waiting = async () => Number((await w.q(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%claw_remote_delivery_health%'`,
    ))[0].n);
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM claw_remote_delivery_health FOR UPDATE");
      // A heartbeat and a stored batch, each answered at once although what they record cannot be written.
      const t0 = Date.now();
      const hb = await heartbeatNow("alice", cid, report({ pending: 2, oldestMs: 5_000 }), AbortSignal.timeout(3_000));
      assert.equal(hb.status, 200);
      const ok = await postNow("alice", cid, [chunk(sid, 1, "the fix is in"), turnEnd(sid, 2)], AbortSignal.timeout(3_000));
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.ok(Date.now() - t0 < 2_000, `answered in ${Date.now() - t0} ms`);
      // Every other connector's heartbeat too, and three more reports of the first one's, the last saying 9 wait.
      for (const [i, c] of cids.entries()) {
        if (i) assert.equal((await heartbeatNow(i % 2 ? "bob" : "alice", c, report({ pending: 10 + i, oldestMs: 1_000 }), AbortSignal.timeout(3_000))).status, 200);
      }
      for (const n of [7, 8, 9]) assert.equal((await heartbeatNow("alice", cid, report({ pending: n, oldestMs: 1_000 }), AbortSignal.timeout(3_000))).status, 200);
      // The writes wait on the lock, never more than the bound of them at once.
      const deadline = Date.now() + 5_000;
      while ((await waiting()) < health.DELIVERY_WRITE_CONCURRENCY && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      assert.equal(await waiting(), health.DELIVERY_WRITE_CONCURRENCY);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await waiting(), health.DELIVERY_WRITE_CONCURRENCY, "no more than the bound pile up");
      await holder.query("COMMIT");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
    await health.deliveryWritesIdle();
    const first = await row(cid);
    assert.equal(first.pending, 9, "the connector's latest report");
    assert.equal(first.api_failures, 0, "the stored batch cleared Claw's failing answer");
    for (const [i, c] of cids.entries()) if (i) assert.equal((await row(c)).pending, 10 + i);
  });

  test("D10 a connector restarted mid-stall is not told it recovered until a batch gets through", async () => {
    const cid = await connector("bob", "build-host");
    const s1 = randomUUID();
    // Its posts never reach Claw (a proxy drops them), for three minutes: told.
    await heartbeat("bob", cid, report({ pending: 7, oldestMs: 200_000, failures: 9, failingMs: 190_000, lastError: "network", sessions: [[s1, 7, 200_000]] }));
    assert.deepEqual((await sweep()).notices.map((n) => n.kind), ["delayed"]);
    // Restarted: the outbox is read back from disk (its events count from the new run's start) and the new run has failed no
    // post yet, the shape its first heartbeat has.
    await heartbeat("bob", cid, report({ pending: 7, oldestMs: 2_000, failures: 0, sessions: [[s1, 7, 2_000]] }));
    assert.deepEqual((await sweep()).notices, [], "nothing got through: not recovered");
    assert.equal((await row(cid)).stall_state, "stalled");
    // Its posts still fail.
    await heartbeat("bob", cid, report({ pending: 7, oldestMs: 30_000, failures: 2, failingMs: 25_000, lastError: "network", sessions: [[s1, 7, 30_000]] }));
    assert.deepEqual((await sweep()).notices, []);
    // The network is back: the batch gets through, then the report is clean.
    const sid = await session("bob", cid);
    assert.equal((await post("bob", cid, [chunk(sid, 1, "replies after the restart"), turnEnd(sid, 2)])).status, 200);
    await heartbeat("bob", cid, report());
    assert.deepEqual((await sweep()).notices.map((n) => n.kind), ["recovered"]);
    assert.equal((await says("bob")).length, 2);
  });

  test("D12 a stall whose backlog drained before the sweep declared it is told it recovered once nothing waits", async () => {
    const cid = await connector("bob", "build-host");
    const sid = await session("bob", cid);
    // Its posts never reach Claw (a proxy drops them; Claw answers no 5xx), for two and a half minutes: only the report says so.
    await heartbeat("bob", cid, report({ pending: 2, oldestMs: 150_000, failures: 4, failingMs: 150_000, lastError: "network", sessions: [[sid, 2, 150_000]] }));
    // The network comes back and the backlog goes in one batch, before the next sweep: no failure to clear, no stall yet, so this
    // batch leaves nothing behind it.
    assert.equal((await post("bob", cid, [chunk(sid, 1, "the replies that waited"), turnEnd(sid, 2)])).status, 200);
    // The sweep reads the report it still has, fresh: stalled, and told.
    assert.deepEqual((await sweep()).notices.map((n) => n.kind), ["delayed"]);
    assert.equal((await row(cid)).stall_notice, "sent");
    // The next heartbeats: nothing waits, nothing fails. No batch follows, there is nothing left to post.
    await heartbeat("bob", cid, report());
    assert.deepEqual((await sweep()).notices.map((n) => n.kind), ["recovered"]);
    assert.equal((await says("bob"))[1], "Replies from the sessions on your dev environment build-host are getting through again; the delayed ones are being delivered now.");
    const r = await row(cid);
    assert.equal(r.stall_state, "ok");
    assert.equal(r.stall_notice, "back_sent");
    assert.equal((await health.sampleDeliveryHealth()).stalled, 0, "the stall alert stops firing");
    await heartbeat("bob", cid, report());
    assert.deepEqual((await sweep()).notices, []);
    assert.equal((await says("bob")).length, 2);
  });

  test("D13 a report that drained before the stall was declared, or that is stale, does not end it", async () => {
    const cid = await connector("alice", "dev-box");
    await heartbeat("alice", cid, report({ pending: 3, oldestMs: 200_000, failures: 6, failingMs: 200_000, lastError: "network" }));
    assert.deepEqual((await sweep()).notices.map((n) => n.kind), ["delayed"]);
    // A clean, empty report from before the stall began says nothing about after it.
    await w.q("UPDATE claw_remote_delivery_health SET pending = 0, oldest_since = NULL, post_failures = 0, post_failing_since = NULL, reported_at = stall_since - interval '1 second' WHERE connector_id = $1", [cid]);
    assert.deepEqual((await sweep()).notices, []);
    assert.equal((await row(cid)).stall_state, "stalled");
    // Nor does one after it that went stale: the connector went quiet, presence says so.
    await w.q("UPDATE claw_remote_delivery_health SET stall_since = NOW() - interval '20 minutes', reported_at = NOW() - interval '10 minutes' WHERE connector_id = $1", [cid]);
    assert.deepEqual((await sweep()).notices, []);
    assert.equal((await row(cid)).stall_state, "stalled");
    // Nor one with nothing waiting while Claw still fails its posts.
    await heartbeat("alice", cid, report());
    await w.q("UPDATE claw_remote_delivery_health SET api_failures = 2, api_failing_since = NOW() - interval '30 seconds', api_failed_at = NOW() WHERE connector_id = $1", [cid]);
    assert.deepEqual((await sweep()).notices, []);
    assert.equal((await row(cid)).stall_state, "stalled");
  });

  test("D14 a stall that ends while its notice is being said is told it recovered only if the delay was said", async () => {
    const recovered = "Replies from the sessions on your dev environment build-host are getting through again; the delayed ones are being delivered now.";
    // Posts dropped on the way for two and a half minutes (only the report says so), then the backlog drains: the D12 shape.
    const stallThenDrain = async (cid: string) => {
      await heartbeat("bob", cid, report({ pending: 2, oldestMs: 150_000, failures: 4, failingMs: 150_000, lastError: "network" }));
      const handed = await health.sweepDeliveryHealth();
      assert.deepEqual(handed.notices.map((n) => n.kind), ["delayed"]);
      return handed.notices[0];
    };
    const expire = (cid: string) => w.q("UPDATE claw_remote_delivery_health SET stall_notice_at = NOW() - interval '2 minutes' WHERE connector_id = $1", [cid]);

    // 1. The replica that swept died after its commit, before saying it. The backlog drains within the retry interval.
    const c1 = await connector("bob", "build-host");
    await stallThenDrain(c1);
    await heartbeat("bob", c1, report());
    assert.deepEqual((await sweep()).notices, [], "not 'recovered' while the 'delayed' may still be being said");
    assert.equal((await row(c1)).stall_state, "stalled");
    assert.deepEqual(await says("bob"), []);
    await expire(c1);
    await heartbeat("bob", c1, report());
    assert.deepEqual((await sweep()).notices, [], "never told it was delayed: not told it recovered");
    const r1 = await row(c1);
    assert.deepEqual([r1.stall_state, r1.stall_notice, r1.stall_notice_at], ["ok", null, null]);
    assert.deepEqual(await says("bob"), []);
    assert.deepEqual(await outboxTexts("bob"), [], "nothing reached bob's chat channel");
    assert.equal((await health.sampleDeliveryHealth()).stalled, 0);
    await sweep();
    assert.deepEqual(await says("bob"), []);

    // 2. No assistant to say it through when it stalled; one is set up within the retry interval, as the backlog drains.
    const c2 = await connector("bob", "build-host");
    const assistant = (await w.q("SELECT row_to_json(a) AS r FROM claw_assistants a WHERE user_id = 'bob'"))[0].r;
    await w.q("DELETE FROM claw_assistants WHERE user_id = 'bob'");
    await heartbeat("bob", c2, report({ pending: 2, oldestMs: 150_000, failures: 4, failingMs: 150_000, lastError: "network" }));
    assert.deepEqual((await sweep()).notices.map((n) => n.kind), ["delayed"]);
    assert.equal((await row(c2)).stall_notice, "pending", "nobody to say it through");
    await w.q("INSERT INTO claw_assistants SELECT * FROM json_populate_record(NULL::claw_assistants, $1::json)", [JSON.stringify(assistant)]);
    await heartbeat("bob", c2, report());
    assert.deepEqual((await sweep()).notices, []);
    await expire(c2);
    await heartbeat("bob", c2, report());
    assert.deepEqual((await sweep()).notices, []);
    assert.equal((await row(c2)).stall_state, "ok");
    assert.deepEqual(await says("bob"), []);

    // 3. Said, and the replica died before marking it: the stall ends once the interval runs out, and he is told it recovered.
    const c3 = await connector("bob", "build-host");
    const notice = await stallThenDrain(c3);
    assert.equal(await realTell(notice), true);
    assert.equal((await row(c3)).stall_notice, "pending", "not marked");
    await heartbeat("bob", c3, report());
    assert.deepEqual((await sweep()).notices, []);
    await expire(c3);
    await heartbeat("bob", c3, report());
    assert.deepEqual((await sweep()).notices.map((n) => n.kind), ["recovered"]);
    assert.deepEqual((await says("bob")).slice(1), [recovered]);
    assert.equal((await says("bob")).length, 2);
    assert.equal((await row(c3)).stall_notice, "back_sent");
  });

  test("D11 a notice is marked said only once it is said, and is said once", async () => {
    const a = await connector("alice", "dev-box");
    await heartbeat("alice", a, report({ pending: 1, oldestMs: 180_000, failures: 3, failingMs: 180_000, lastError: "http_500" }));
    // The replica that swept died before saying it: the sweep's half committed, the saying never ran.
    const handed = await health.sweepDeliveryHealth();
    assert.equal(handed.notices.length, 1);
    assert.equal((await row(a)).stall_notice, "pending", "not marked said before it is said");
    // Another replica within the retry interval leaves it to the one saying it.
    assert.deepEqual((await sweep()).notices, []);
    assert.deepEqual(await says("alice"), []);
    const expire = () => w.q("UPDATE claw_remote_delivery_health SET stall_notice_at = NOW() - interval '2 minutes' WHERE connector_id = $1", [a]);
    await expire();
    const again = await sweep();
    assert.deepEqual(again.notices.map((n) => n.kind), ["delayed"]);
    assert.equal((await says("alice")).length, 1);
    assert.equal((await row(a)).stall_notice, "sent");
    // Died after saying it, before marking it: said again by the next sweep, which says nothing twice.
    await w.q("UPDATE claw_remote_delivery_health SET stall_notice = 'pending', stall_notice_at = NOW() - interval '2 minutes' WHERE connector_id = $1", [a]);
    await sweep();
    assert.equal((await says("alice")).length, 1);
    assert.equal((await row(a)).stall_notice, "sent");
    // Bob has no assistant when his replies stall: nothing said, and it stays to be said.
    const b = await connector("bob", "build-host");
    const assistant = (await w.q("SELECT row_to_json(a) AS r FROM claw_assistants a WHERE user_id = 'bob'"))[0].r;
    await w.q("DELETE FROM claw_assistants WHERE user_id = 'bob'");
    await heartbeat("bob", b, report({ pending: 2, oldestMs: 300_000, failures: 4, failingMs: 300_000, lastError: "network" }));
    assert.deepEqual((await sweep()).notices.map((n) => n.owner), ["bob"]);
    assert.equal((await row(b)).stall_notice, "pending");
    // Once he has one, a later sweep tells him.
    await w.q("INSERT INTO claw_assistants SELECT * FROM json_populate_record(NULL::claw_assistants, $1::json)", [JSON.stringify(assistant)]);
    await w.q("UPDATE claw_remote_delivery_health SET stall_notice_at = NOW() - interval '2 minutes' WHERE connector_id = $1", [b]);
    await sweep();
    assert.equal((await says("bob")).length, 1);
    assert.equal((await row(b)).stall_notice, "sent");
  });
});
