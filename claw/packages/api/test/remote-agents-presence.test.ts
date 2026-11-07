// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Connector presence over time (`remote-agents/presence.ts`) on a real Postgres with remote agents and the assistant on.
 * Presence is driven by writing the two facts it is made of (`heartbeat_at`, `stream_seen_at`) and the clock it counts
 * by (`presence_since`), so no test waits five minutes. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   P1  the first sweep records a baseline: an online connector is online, one already offline is never told about
 *   P2  offline for five minutes is told once, with when it was last seen and the command; back online is told once
 *   P3  a break within the reconnect grace (a Claw release cuts every stream for seconds) is not even recorded; a longer
 *       short one is recorded and told nothing
 *   P4  replaced by an online connector of the same name, or revoked by the owner: nothing told
 *   P5  a connector whose sign-in ran out is told to sign in again, not just to run
 *   P5b a stream ended on an expired token that reconnected, then lost its heartbeat, is offline for the heartbeat
 *   P6  only one replica sweeps at a time
 *   P7  a notice (offline or back online) that could not be stored is tried again by the next sweep and said once
 *   P8  every notice goes to the connector's owner and nobody else
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const WINDOW_MS = 90_000;

describe("remote connector presence", { skip }, () => {
  let w: World;
  let presence: typeof import("../src/remote-agents/presence.js");
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };

  before(async () => {
    w = await startWorld({ CLAW_REMOTE_AGENTS_ENABLED: "true" });
    presence = await import("../src/remote-agents/presence.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_remote_connector_transitions, claw_remote_connectors, claw_assistant_says, claw_assistant_messages,
      claw_notification_outbox, claw_notification_subscriptions, claw_assistants, claw_sessions CASCADE`);
    alice = await w.user("alice");
    bob = await w.user("bob");
    await said(alice, "我的开发环境有哪些");
    await said(bob, "what are my dev environments");
  });

  async function said(u: { userId: string; routerSid: string }, content: string): Promise<void> {
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content) VALUES ($1, $2, $3, 'U', $4)`,
      [u.routerSid, `m-${randomUUID()}`, u.userId, content],
    );
  }

  /** A connector of `owner`'s, online (fresh heartbeat, open stream) or not. */
  async function connector(owner: string, name: string, online: boolean): Promise<string> {
    const id = randomUUID();
    await w.q(
      `INSERT INTO claw_remote_connectors (connector_id, owner_user_id, name, version, heartbeat_at, stream_conn, stream_seen_at)
       VALUES ($1, $2, $3, '0.1.2', NOW(), 'c1', CASE WHEN $4 THEN NOW() END)`,
      [id, owner, name, online],
    );
    return id;
  }
  /**
   * The command stream closed (a killed process) a minute ago and did not come back: offline, the grace for a reconnect
   * (`STREAM_GRACE_SECS`) having passed.
   */
  const streamGone = (id: string, reason = "closed") => w.q(
    `UPDATE claw_remote_connectors SET stream_seen_at = NULL, stream_closed_at = NOW() - interval '1 minute', stream_end_reason = $2
      WHERE connector_id = $1`, [id, reason],
  );
  /** The command stream closed just now (a Claw release cuts every stream; the connector is back within seconds). */
  const streamCut = (id: string) => w.q(
    "UPDATE claw_remote_connectors SET stream_seen_at = NULL, stream_closed_at = NOW(), stream_end_reason = 'closed' WHERE connector_id = $1", [id],
  );
  const streamBack = (id: string) => w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW(), stream_seen_at = NOW() WHERE connector_id = $1", [id]);
  /** As if the sweep had found it offline `minutes` ago. */
  const offlineFor = (id: string, minutes: number) => w.q(
    "UPDATE claw_remote_connectors SET presence_since = NOW() - make_interval(mins => $2::int) WHERE connector_id = $1", [id, minutes],
  );
  const sweep = () => presence.runPresenceSweep(WINDOW_MS);
  const says = async (userId: string) => (await w.q("SELECT text FROM claw_assistant_says WHERE user_id = $1 ORDER BY created_at", [userId])).map((r) => String(r.text));
  const row = async (id: string) => (await w.q("SELECT * FROM claw_remote_connectors WHERE connector_id = $1", [id]))[0];
  const transitions = async (id: string) => (await w.q(
    "SELECT from_state, to_state, reason FROM claw_remote_connector_transitions WHERE connector_id = $1 ORDER BY id", [id],
  )).map((r) => `${r.from_state ?? "-"}>${r.to_state}${r.reason ? `:${r.reason}` : ""}`);

  test("P1 the first sweep is a baseline: online is online, already offline is never told", async () => {
    const up = await connector("alice", "dev-box", true);
    const stale = await connector("alice", "old-box", false);
    await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '3 days' WHERE connector_id = $1", [stale]);
    const first = await sweep();
    assert.equal(first.swept, true);
    assert.equal(first.transitions, 2);
    assert.deepEqual(await transitions(up), ["->online"]);
    assert.deepEqual(await transitions(stale), ["->offline:no_heartbeat"]);
    assert.equal((await row(stale)).offline_notice, "baseline");
    // Long past five minutes, and still nothing: it was offline before anyone was watching.
    await offlineFor(stale, 60);
    const again = await sweep();
    assert.equal(again.transitions, 0);
    assert.deepEqual(again.notices, []);
    assert.deepEqual(await says("alice"), []);
  });

  test("P2 offline for five minutes is told once, with the last-seen time and the command; back online is told once", async () => {
    const id = await connector("alice", "dev-box", true);
    await sweep();
    await streamGone(id);
    const seen = (await row(id)).heartbeat_at as Date;   // (its last sign of life: the beat after the stream went)
    const down = await sweep();
    assert.deepEqual(await transitions(id), ["->online", "online>offline:no_heartbeat"]);
    assert.deepEqual(down.notices, [], "not before five minutes");
    await offlineFor(id, 4);
    assert.deepEqual((await sweep()).notices, [], "four minutes is not five");
    await offlineFor(id, 5);
    const told = await sweep();
    assert.equal(told.notices.length, 1);
    const hhmm = new Date(seen).toISOString().slice(11, 16);
    const texts = await says("alice");
    assert.equal(texts.length, 1);
    assert.equal(texts[0], `你的开发环境 dev-box 离线了（最后在线 ${hhmm}Z，心跳停止，多半是机器或 pod 重启、连接器进程退出）。在那台机器上运行 \`claw-connector run\` 恢复。`);
    // Every later sweep while it stays down says nothing more.
    await offlineFor(id, 30);
    for (let i = 0; i < 3; i++) assert.deepEqual((await sweep()).notices, []);
    assert.equal((await says("alice")).length, 1);
    // Back: once.
    await streamBack(id);
    assert.equal((await sweep()).notices.length, 1);
    await sweep();
    assert.deepEqual(await says("alice"), [texts[0], "你的开发环境 dev-box 已恢复在线。"]);
    assert.deepEqual(await transitions(id), ["->online", "online>offline:no_heartbeat", "offline>online"]);
    // A second outage is a new episode, told again.
    await streamGone(id);
    await sweep();
    await offlineFor(id, 6);
    await sweep();
    assert.equal((await says("alice")).length, 3);
    // The notices reach the channel the user has, as any assistant message does.
    assert.equal((await w.q("SELECT fallback FROM claw_assistant_says WHERE user_id = 'alice'")).every((r) => r.fallback === true), true);
  });

  test("P3 a short break is recorded and told nothing, the way a Claw release looks", async () => {
    const id = await connector("alice", "dev-box", true);
    await sweep();
    // A stream that has just ended, with a fresh heartbeat, is a connector on its way to the next one: still online, no row.
    await streamCut(id);
    assert.equal((await sweep()).transitions, 0, "within the reconnect grace");
    assert.deepEqual(await transitions(id), ["->online"]);
    await streamBack(id);
    for (let i = 0; i < 3; i++) {
      await streamGone(id);
      await sweep();
      await streamBack(id);
      await sweep();
    }
    assert.equal((await transitions(id)).length, 7);
    assert.deepEqual(await says("alice"), [], "no offline and no back-online");
    // A break the sweep never saw is not even a row.
    await streamGone(id);
    await streamBack(id);
    assert.equal((await sweep()).transitions, 0);
  });

  test("P4 replaced by an online connector of the same name, or revoked by the owner: nothing told", async () => {
    const old = await connector("alice", "dev-box", true);
    const gone = await connector("alice", "laptop", true);
    await sweep();
    await streamGone(old);
    await w.q("UPDATE claw_remote_connectors SET revoked_at = NOW(), stream_seen_at = NULL WHERE connector_id = $1", [gone]);
    await sweep();
    await connector("alice", "dev-box", true);
    await offlineFor(old, 10);
    assert.deepEqual((await sweep()).notices, []);
    assert.equal((await row(old)).offline_notice, "superseded");
    assert.equal((await row(gone)).presence_state, "revoked");
    assert.deepEqual(await transitions(gone), ["->online", "online>revoked:revoked"]);
    assert.deepEqual(await says("alice"), []);
    // A revoked connector is swept once, and then no more.
    assert.equal((await sweep()).transitions, 0);
  });

  test("P5 a connector whose sign-in ran out is told to sign in again", async () => {
    const id = await connector("alice", "dev-box", true);
    await sweep();
    await streamGone(id, "token_expired");
    await sweep();
    await offlineFor(id, 5);
    await sweep();
    const [text] = await says("alice");
    assert.match(text, /登录已过期或被撤销/);
    assert.match(text, /`claw-connector login`.*`claw-connector run`/);
    assert.equal((await row(id)).offline_reason, "auth_expired");
  });

  test("P5b a stream that ended on an expired token and came back: when its heartbeat later stops, the cause is the heartbeat, not the sign-in", async () => {
    const store = await import("../src/remote-agents/store.js");
    const id = await connector("alice", "dev-box", true);
    await sweep();
    // The access token expires, the server ends the stream, and the connector reconnects with a fresh one (the real store calls).
    await store.markStreamClosed(id, "c1", "token_expired");
    await store.markStreamOpen(id, "c2");
    await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() WHERE connector_id = $1", [id]);
    assert.equal((await sweep()).transitions, 0, "healthy throughout");
    // Then the machine goes: the heartbeat goes stale before the server sees the stream close (or the replica that held it died).
    await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '3 minutes' WHERE connector_id = $1", [id]);
    await sweep();
    assert.deepEqual(await transitions(id), ["->online", "online>offline:no_heartbeat"]);
    assert.equal((await row(id)).offline_reason, "no_heartbeat");
    const [listed] = await store.listConnectors("alice", WINDOW_MS);
    assert.deepEqual([listed.online, listed.offline_reason], [false, "no_heartbeat"]);
    await offlineFor(id, 5);
    await sweep();
    const [text] = await says("alice");
    assert.doesNotMatch(text, /登录已过期或被撤销/, "not told to sign in again");
    assert.doesNotMatch(text, /`claw-connector login`/);
  });

  test("P6 only one replica sweeps at a time", async () => {
    const id = await connector("alice", "dev-box", true);
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock(7001, hashtext('presence'))");
      const held = await sweep();
      assert.deepEqual([held.swept, held.transitions], [false, 0]);
      assert.equal((await row(id)).presence_state, null);
      await other.query("COMMIT");
    } finally {
      await other.end();
    }
    assert.equal((await sweep()).swept, true);
    assert.equal((await row(id)).presence_state, "online");
  });

  test("P7 a notice that could not be stored is tried again by the next sweep, and said once", async () => {
    const id = await connector("alice", "dev-box", true);
    await sweep();
    await streamGone(id);
    await sweep();
    await offlineFor(id, 5);
    const real = presence.presencePorts.tell;
    presence.presencePorts.tell = async () => { throw new Error("outbox down"); };
    try {
      await sweep();
    } finally {
      presence.presencePorts.tell = real;
    }
    assert.equal((await row(id)).offline_notice, "pending");
    assert.deepEqual(await says("alice"), []);
    await sweep();
    await sweep();
    assert.equal((await says("alice")).length, 1);
    assert.equal((await row(id)).offline_notice, "sent");
    // The same for "back online": a failure leaves it owed, and the next sweep says it, once.
    await streamBack(id);
    presence.presencePorts.tell = async () => { throw new Error("outbox down"); };
    try {
      await sweep();
    } finally {
      presence.presencePorts.tell = real;
    }
    assert.equal((await row(id)).offline_notice, "back_pending");
    assert.equal((await says("alice")).length, 1);
    await sweep();
    await sweep();
    assert.deepEqual((await says("alice")).slice(1), ["你的开发环境 dev-box 已恢复在线。"]);
    assert.equal((await row(id)).offline_notice, "back_sent");
  });

  test("P8 a notice goes to the connector's owner only, in their language", async () => {
    const a = await connector("alice", "box", true);
    const b = await connector("bob", "box", true);
    await sweep();
    await streamGone(b);
    await sweep();
    await offlineFor(b, 5);
    await sweep();
    assert.deepEqual(await says("alice"), []);
    const [text] = await says("bob");
    assert.match(text, /^Your dev environment box is offline \(last online \d\d:\d\dZ; heartbeats stopped/);
    assert.match(text, /`claw-connector run`/);
    assert.equal((await row(a)).presence_state, "online");
    // Someone with no assistant has nobody to be told through, and the sweep goes on.
    const c = await connector("carol", "box", true);
    await sweep();
    await streamGone(c);
    await sweep();
    await offlineFor(c, 5);
    const out = await sweep();
    assert.equal(out.notices.length, 1);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_assistant_says WHERE user_id = 'carol'"))[0].n, 0);
  });

  test("clock: HH:MM in UTC, with the date when it is not today's", () => {
    const now = new Date("2026-11-06T16:30:00Z");
    assert.equal(presence.clock(new Date("2026-11-06T03:45:10Z"), now), "03:45");
    assert.equal(presence.clock(new Date("2026-11-05T23:59:00Z"), now), "11-05 23:59");
    assert.equal(presence.clock(null, now), "?");
    const text = presence.noticeText({ kind: "offline", connectorId: "c", owner: "o", name: "a`b\nc", episode: 1, lastSeenAt: null, reason: null }, "zh", now);
    assert.match(text, /开发环境 a b c 离线了/, "a name cannot break the command's quoting");
  });
});
