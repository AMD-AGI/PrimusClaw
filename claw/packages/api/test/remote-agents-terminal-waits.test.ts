// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A conversation open in a terminal that waits for its person (`remote-agents/terminal-waits.ts`) on a real Postgres with remote agents
 * and the assistant on. What a connector reports is written as its heartbeat leaves it (`claw_remote_agents.capabilities.resumable`),
 * and the clock the sweep counts by (`since`) is moved, so no test waits a minute. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   T1  waiting a minute on a machine online now is told once, to its owner, in the language they write, with what it waits for;
 *       the sweeps after say nothing more
 *   T2  answered at the terminal within the minute (the person is there): never told
 *   T3  working, idle, a conversation nobody holds open, a machine offline or revoked, a ref that is not one: nothing
 *   T4  a new wait after the first ended is a new episode, told again once; still waiting is never told twice
 *   T5  a notice that could not be stored is tried again by the next sweep, and said once
 *   T6  only one replica sweeps at a time
 *   T7  told only on a report made after the minute that still says it waits: one answered just before the minute, whose last report
 *       predates the answer, is not told on that report
 *   T8  a told wait is never told again while it still waits, even when a heartbeat in between could not see it (every entry
 *       `unknown`, or this one); a list that knows its conversations and lacks it, or an agent gone from the report, ends it *   T9  an owner with no assistant yet is told once they have one, if it still waits
 *   T10 a wait whose request the terminal's hook already put to the owner as a card (a terminal-hook session of that machine and
 *       conversation with a request not yet answered) is not told again; one whose request was answered is told as before
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const WINDOW_MS = 90_000;
const MINUTE = 60_000;

describe("conversations open in a terminal that wait for their person", { skip }, () => {
  let w: World;
  let waits: typeof import("../src/remote-agents/terminal-waits.js");
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };

  before(async () => {
    w = await startWorld({ CLAW_REMOTE_AGENTS_ENABLED: "true" });
    waits = await import("../src/remote-agents/terminal-waits.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_remote_terminal_waits, claw_remote_agents, claw_remote_connectors, claw_assistant_says, claw_assistant_messages,
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

  async function machine(owner: string, name: string, online = true): Promise<string> {
    const id = randomUUID();
    await w.q(
      `INSERT INTO claw_remote_connectors (connector_id, owner_user_id, name, version, heartbeat_at, stream_conn, stream_seen_at)
       VALUES ($1, $2, $3, '0.1.5', NOW(), 'c1', CASE WHEN $4 THEN NOW() END)`,
      [id, owner, name, online],
    );
    return id;
  }
  /** What the connector's last heartbeat said of the conversations of agent `claude-sessions` (`capabilities.resumable`). */
  async function terminal(cid: string, owner: string, entries: Array<Record<string, unknown>>): Promise<void> {
    await w.q(
      `INSERT INTO claw_remote_agents (connector_id, agent_id, owner_user_id, kind, name, capabilities) VALUES ($1, 'claude-sessions', $2, 'claude', 'Claude Code', $3::jsonb)
       ON CONFLICT (connector_id, agent_id) DO UPDATE SET capabilities = excluded.capabilities, updated_at = NOW()`,
      [cid, owner, JSON.stringify({ resumable: entries })],
    );
  }
  const conv = (ref: string, activity: string | null, extra: Record<string, unknown> = {}) => ({
    ref, title: "fix the flaky test", cwd: "/home/u/repo", updated_at: Math.floor(Date.now() / 1000), state: "live",
    ...(activity ? { activity } : {}), ...(activity === "waiting" ? { waiting_for: "input needed" } : {}), ...extra,
  });
  /** As if the sweep had first seen it wait `ms` ago. */
  const waitedFor = (cid: string, ref: string, ms: number) => w.q(
    "UPDATE claw_remote_terminal_waits SET since = NOW() - make_interval(secs => $3::float8) WHERE connector_id = $1 AND ref = $2", [cid, ref, ms / 1000],
  );
  /** As if the connector's last report of its terminals was made `ms` ago. */
  const reportedAgo = (cid: string, ms: number) => w.q(
    "UPDATE claw_remote_agents SET updated_at = NOW() - make_interval(secs => $2::float8) WHERE connector_id = $1", [cid, ms / 1000],
  );
  const sweep = () => waits.runTerminalWaitSweep(WINDOW_MS, MINUTE);
  const says = async (userId: string) => (await w.q("SELECT text FROM claw_assistant_says WHERE user_id = $1 ORDER BY created_at", [userId])).map((r) => String(r.text));

  test("T1 waiting a minute is told once, to its owner, with what it waits for", async () => {
    const cid = await machine("alice", "dev-pod");
    await terminal(cid, "alice", [conv("s-1", "waiting"), conv("s-2", "working")]);
    let out = await sweep();
    assert.deepEqual([out.swept, out.waiting, out.notices.length], [true, 1, 0], "seen waiting: not yet a minute");
    assert.deepEqual(await says("alice"), []);
    await waitedFor(cid, "s-1", 2 * MINUTE);
    out = await sweep();
    assert.equal(out.notices.length, 1);
    assert.deepEqual(await says("alice"), ["dev-pod 上终端里的 Claude Code 在等你（input needed）：fix the flaky test。已经等了一分多钟，回到那个终端处理。"]);
    assert.deepEqual(await says("bob"), []);
    for (let i = 0; i < 3; i++) await sweep();
    assert.equal((await says("alice")).length, 1, "said once");
    // In English to someone who writes English.
    const bobs = await machine("bob", "laptop");
    await terminal(bobs, "bob", [conv("b-1", "waiting", { title: "" })]);
    await sweep();
    await waitedFor(bobs, "b-1", 2 * MINUTE);
    await sweep();
    assert.deepEqual(await says("bob"), ["Claude Code in a terminal on laptop is waiting for you (input needed): /home/u/repo. It has waited over a minute; answer it in that terminal."]);
    assert.equal((await says("alice")).length, 1);
  });

  test("T2 answered at the terminal within the minute: never told", async () => {
    const cid = await machine("alice", "dev-pod");
    await terminal(cid, "alice", [conv("s-1", "waiting")]);
    await sweep();
    await waitedFor(cid, "s-1", 30_000);
    await terminal(cid, "alice", [conv("s-1", "working")]);   // the person at the terminal answered it
    await sweep();
    await terminal(cid, "alice", [conv("s-1", "idle")]);
    await sweep();
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_remote_terminal_waits"))[0].n, 0, "the episode is over");
    assert.deepEqual(await says("alice"), []);
  });

  test("T3 working, idle, not held open, offline, revoked, or no ref: nothing", async () => {
    const up = await machine("alice", "dev-pod");
    await terminal(up, "alice", [conv("s-1", "working"), conv("s-2", "idle"), conv("s-3", null),
      { ...conv("s-4", "waiting"), state: "idle" }, conv("bad ref!", "waiting"), "junk", conv("s-5", "waiting", { ref: 7 })]);
    const down = await machine("alice", "old-box", false);
    await terminal(down, "alice", [conv("d-1", "waiting")]);
    const gone = await machine("alice", "revoked-box");
    await terminal(gone, "alice", [conv("g-1", "waiting")]);
    await w.q("UPDATE claw_remote_connectors SET revoked_at = NOW() WHERE connector_id = $1", [gone]);
    const out = await sweep();
    assert.equal(out.waiting, 0);
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_remote_terminal_waits"))[0].n, 0);
    // A machine that goes offline while one waits ends that episode: nothing is said of it.
    const flaky = await machine("alice", "flaky");
    await terminal(flaky, "alice", [conv("f-1", "waiting")]);
    await sweep();
    await waitedFor(flaky, "f-1", 2 * MINUTE);
    await w.q("UPDATE claw_remote_connectors SET stream_seen_at = NULL WHERE connector_id = $1", [flaky]);
    await sweep();
    assert.deepEqual(await says("alice"), []);
  });

  test("T4 a new wait is a new episode, told again once", async () => {
    const cid = await machine("alice", "dev-pod");
    await terminal(cid, "alice", [conv("s-1", "waiting")]);
    await sweep();
    await waitedFor(cid, "s-1", 2 * MINUTE);
    await sweep();
    await sweep();
    assert.equal((await says("alice")).length, 1);
    await terminal(cid, "alice", [conv("s-1", "working")]);
    await sweep();
    await terminal(cid, "alice", [conv("s-1", "waiting")]);
    await sweep();
    assert.equal((await says("alice")).length, 1, "a new wait is counted from now");
    await waitedFor(cid, "s-1", 2 * MINUTE);
    await sweep();
    await sweep();
    assert.equal((await says("alice")).length, 2);
  });

  test("T5 a notice that could not be stored is tried again, and said once", async () => {
    const cid = await machine("alice", "dev-pod");
    await terminal(cid, "alice", [conv("s-1", "waiting")]);
    await sweep();
    await waitedFor(cid, "s-1", 2 * MINUTE);
    const real = waits.terminalWaitPorts.tell;
    let calls = 0;
    waits.terminalWaitPorts.tell = async (n) => { calls += 1; if (calls === 1) throw new Error("db away"); return real(n); };
    try {
      await sweep();
      assert.deepEqual(await says("alice"), []);
      await sweep();
      await sweep();
    } finally {
      waits.terminalWaitPorts.tell = real;
    }
    assert.equal(calls, 2);
    assert.equal((await says("alice")).length, 1);
  });

  test("T6 only one replica sweeps at a time", async () => {
    const cid = await machine("alice", "dev-pod");
    await terminal(cid, "alice", [conv("s-1", "waiting")]);
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(7001, hashtext('terminal-waits'))");
      const out = await sweep();
      assert.equal(out.swept, false);
      await holder.query("ROLLBACK");
      assert.equal((await sweep()).swept, true);
    } finally {
      await holder.end();
    }
  });

  test("T7 told only on a report made after the minute that still says it waits", async () => {
    const cid = await machine("alice", "dev-pod");
    await terminal(cid, "alice", [conv("s-1", "waiting")]);
    await sweep();
    // A minute and a bit since the sweep first saw it wait, but the last report was made before the minute was up: the person may
    // have answered since, and the connector has not said so yet.
    await waitedFor(cid, "s-1", MINUTE + 5_000);
    await reportedAgo(cid, 10_000);
    let out = await sweep();
    assert.deepEqual([out.waiting, out.notices.length], [1, 0]);
    assert.deepEqual(await says("alice"), []);
    // It answered: the next report says so, and nothing is ever said.
    await terminal(cid, "alice", [conv("s-1", "working")]);
    await sweep();
    assert.deepEqual(await says("alice"), []);
    // Another wait; this time a report well after the minute still says it waits: told once.
    await terminal(cid, "alice", [conv("s-1", "waiting")]);
    await sweep();
    await waitedFor(cid, "s-1", MINUTE + 5_000);
    out = await sweep();
    assert.equal(out.notices.length, 0, "the report is only 5 s past the minute, inside the connector's lag");
    await waitedFor(cid, "s-1", MINUTE + waits.TERMINAL_REPORT_LAG_MS + 1_000);
    out = await sweep();
    assert.equal(out.notices.length, 1);
    assert.equal((await says("alice")).length, 1);
  });

  test("T8 a told wait is not told again after a heartbeat that could not see it", async () => {
    const cid = await machine("alice", "dev-pod");
    await terminal(cid, "alice", [conv("s-1", "waiting"), conv("s-2", "idle")]);
    await sweep();
    await waitedFor(cid, "s-1", 2 * MINUTE);
    await sweep();
    assert.equal((await says("alice")).length, 1);
    // One slow heartbeat: the connector could not list its terminals, so every entry is unknown; then it waits as before.
    await terminal(cid, "alice", [{ ...conv("s-1", null), state: "unknown" }, { ...conv("s-2", null), state: "unknown" }]);
    await sweep();
    await terminal(cid, "alice", [conv("s-1", "waiting"), conv("s-2", "idle")]);
    for (let i = 0; i < 2; i++) await sweep();
    await waitedFor(cid, "s-1", 3 * MINUTE);
    await reportedAgo(cid, 0);
    await sweep();
    // This entry alone unknown, and a report with no list at all: the same.
    await terminal(cid, "alice", [{ ...conv("s-1", null), state: "unknown" }, conv("s-2", "idle")]);
    await sweep();
    await terminal(cid, "alice", []);
    await w.q("UPDATE claw_remote_agents SET capabilities = '{}'::jsonb WHERE connector_id = $1", [cid]);
    await sweep();
    await terminal(cid, "alice", [conv("s-1", "waiting"), conv("s-2", "idle")]);
    await sweep();
    await waitedFor(cid, "s-1", 3 * MINUTE);
    await sweep();
    assert.equal((await says("alice")).length, 1, "still the same wait: told once");
    // A list that knows its conversations and no longer has it: that wait is over, and a new one is told again.
    await terminal(cid, "alice", [conv("s-2", "idle")]);
    await sweep();
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_remote_terminal_waits"))[0].n, 0);
    await terminal(cid, "alice", [conv("s-1", "waiting")]);
    await sweep();
    await waitedFor(cid, "s-1", 2 * MINUTE);
    await sweep();
    assert.equal((await says("alice")).length, 2);
    // The agent gone from the report ends it too.
    await terminal(cid, "alice", [conv("s-1", "waiting")]);
    await w.q("DELETE FROM claw_remote_agents WHERE connector_id = $1", [cid]);
    await sweep();
    assert.equal((await w.q("SELECT COUNT(*)::int AS n FROM claw_remote_terminal_waits"))[0].n, 0);
  });

  test("T9 an owner with no assistant yet is told once they have one", async () => {
    const cid = await machine("carol", "carol-box");
    await terminal(cid, "carol", [conv("c-1", "waiting")]);
    await sweep();
    await waitedFor(cid, "c-1", 2 * MINUTE);
    const out = await sweep();
    assert.equal(out.notices.length, 1, "due");
    assert.deepEqual(await says("carol"), [], "nobody to say it through");
    assert.equal((await w.q("SELECT told_at FROM claw_remote_terminal_waits WHERE connector_id = $1", [cid]))[0].told_at, null, "not told");
    const carol = await w.user("carol");
    await said(carol, "我的开发环境有哪些");
    await sweep();
    await sweep();
    assert.equal((await says("carol")).length, 1);
  });

  test("T10 a wait already put to the owner as a card by the terminal's hook is not told again", async () => {
    const cid = await machine("alice", "dev-pod");
    const card = async (ref: string, answered: boolean) => {
      const sid = randomUUID();
      await w.q(
        `INSERT INTO claw_remote_sessions (session_id, owner_user_id, connector_id, agent_id, cwd, origin, ref)
         VALUES ($1, 'alice', $2, 'claude', '/home/u/repo', 'terminal_hook', $3)`, [sid, cid, ref],
      );
      await w.q(
        `INSERT INTO claw_remote_events (session_id, seq, type, occurred_at, data) VALUES ($1, 1, 'permissionRequest', NOW(), '{"actionId":"a1"}'::jsonb)`, [sid],
      );
      if (answered) {
        await w.q(
          `INSERT INTO claw_remote_events (session_id, seq, type, occurred_at, data) VALUES ($1, 2, 'permission_resolved', NOW(), '{"actionId":"a1","by":"terminal"}'::jsonb)`, [sid],
        );
      }
    };
    await card("s-1", false);
    await card("s-2", true);
    await terminal(cid, "alice", [conv("s-1", "waiting"), conv("s-2", "waiting", { title: "second" })]);
    await sweep();
    await waitedFor(cid, "s-1", 2 * MINUTE);
    await waitedFor(cid, "s-2", 2 * MINUTE);
    await sweep();
    assert.deepEqual(await says("alice"), ["dev-pod 上终端里的 Claude Code 在等你（input needed）：second。已经等了一分多钟，回到那个终端处理。"]);
    await sweep();
    assert.equal((await says("alice")).length, 1, "the carded one is not told later either");
  });
});
