// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Archived-session retention and the purge of deleted sessions' rows, against a
 * real Postgres whose schema `initDb` built (with the assistant's tables, so the
 * work-item exclusion is exercised). Skipped without DATABASE_URL; a skip is not
 * a pass.
 *
 * The properties are WHERE clauses, so every exclusion is a row that would be
 * deleted without it, seeded beside one that is deleted, and the assertion is
 * the exact set of sessions that ended up deleted.
 *
 * Coverage:
 *   T1 which archived sessions are deleted and which are never taken (table-driven)
 *   T2 a deletion goes through the user's delete commit: rows stamped, queue dropped, cleanup pending
 *   T3 a session that becomes ineligible after the scan is skipped under its row lock
 *      (T3c: including a team member whose run starts mid-deletion, under the member's lock)
 *   T4 the batch limit takes the oldest first; dry run reports and changes nothing; 0 is off
 *   T5 the S3 workspace and checkpoint prefixes are removed by the existing cleanup sweep
 *   T6 the purge removes stamped rows of sessions deleted past the window, and nothing else
 *   T7 archiving stamps archived_at, re-archiving keeps it, unarchiving clears it
 *   T8 the batch is the day's limit across passes and replicas, not each pass's
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

const skip = postgresSkipReason();
const cluster: PgCluster | undefined = skip ? undefined : await startPgCluster();
if (cluster) {
  process.env.DATABASE_URL = cluster.url;
  delete process.env.DB_SCHEMA;
  process.env.CLAW_ASSISTANT_ENABLED = "true";
  process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
}

const SETTINGS = { retentionDays: 30, purgeDays: 0, batch: 100, dryRun: false };

describe("session retention", { skip }, () => {
  let dbModule: typeof import("../src/infra/db.js");
  let retention: typeof import("../src/sessions/retention.js");
  let teardown: typeof import("../src/sessions/teardown.js");
  let archive: typeof import("../src/sessions/archive.js");

  const q = (text: string, params: unknown[] = []) => dbModule.db.query(text, params);
  const rows = async (text: string, params: unknown[] = []) =>
    (await q(text, params)).rows as Array<Record<string, any>>;
  const deletedIds = async () =>
    (await rows("SELECT session_id FROM claw_sessions WHERE deleted_at IS NOT NULL ORDER BY session_id"))
      .map((r) => r.session_id as string);

  interface Seed {
    id: string;
    status?: string;
    /** Days since archived_at; null leaves it NULL (archived before the column existed). */
    archivedDays?: number | null;
    updatedDays?: number;
    agent?: string;
    parent?: string;
    compat?: boolean;
    deletedDays?: number;
  }
  async function seed(s: Seed): Promise<void> {
    await q(
      `INSERT INTO claw_sessions (session_id, user_id, status, agent_status, parent_session_id, config,
                                  archived_at, updated_at, deleted_at)
       VALUES ($1, 'u1', $2, $3, $4, $5::jsonb,
               CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() - ($6::int * INTERVAL '1 day') END,
               NOW() - ($7::int * INTERVAL '1 day'),
               CASE WHEN $8::int IS NULL THEN NULL ELSE NOW() - ($8::int * INTERVAL '1 day') END)`,
      [s.id, s.status ?? "archived", s.agent ?? "idle", s.parent ?? null,
       JSON.stringify(s.compat ? { primus_anthropic_compat: {} } : {}),
       s.archivedDays === undefined ? 40 : s.archivedDays, s.updatedDays ?? 45, s.deletedDays ?? null],
    );
  }
  async function task(sessionId: string, status: string): Promise<void> {
    await q(
      `INSERT INTO claw_tasks (task_id, session_id, name, origin, executor, mode, status, metadata)
       VALUES ($1, $2, 'chat', 'chat', 'brain', 'llm', $3, '{}'::jsonb)`,
      [`t-${sessionId}-${status}`, sessionId, status],
    );
  }
  async function content(sessionId: string, stampedDays: number | null): Promise<void> {
    const stamp = stampedDays === null ? null : stampedDays;
    await q(
      `INSERT INTO claw_conversation_turns (session_id, turn_index, role, content, deleted_at)
       VALUES ($1, 0, 'user', 'hi',
               CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() - ($2::int * INTERVAL '1 day') END)`,
      [sessionId, stamp],
    );
    await q(
      `INSERT INTO claw_session_events (event_id, session_id, event, deleted_at)
       VALUES ($1, $2, 'text',
               CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() - ($3::int * INTERVAL '1 day') END),
              ($1 || '-2', $2, 'text',
               CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() - ($3::int * INTERVAL '1 day') END)`,
      [`e-${sessionId}`, sessionId, stamp],
    );
    await q(
      `INSERT INTO claw_session_summaries (session_id, summary, deleted_at)
       VALUES ($1, 'sum', CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() - ($2::int * INTERVAL '1 day') END)`,
      [sessionId, stamp],
    );
  }

  before(async () => {
    dbModule = await import("../src/infra/db.js");
    const named = (await dbModule.db.query("SELECT current_database() AS name")).rows[0] as { name: string };
    assert.equal(named.name, cluster!.schema);
    await dbModule.initDb();
    retention = await import("../src/sessions/retention.js");
    teardown = await import("../src/sessions/teardown.js");
    archive = await import("../src/sessions/archive.js");
  });
  after(async () => {
    await dbModule?.db.pool.end().catch(() => {});
    await dbModule?.db.lockPool.end().catch(() => {});
    await cluster?.end();
  });
  beforeEach(async () => {
    for (const t of ["claw_work_items", "claw_pending_messages", "claw_tasks", "claw_conversation_turns",
      "claw_session_events", "claw_session_summaries", "claw_sessions"]) {
      await q(`DELETE FROM ${t}`);
    }
  });

  test("T1 deletes the expired archived sessions and never the excluded ones", async () => {
    const cases: Array<[string, Seed, boolean, (() => Promise<void>)?]> = [
      ["archived 40 days ago", { id: "del-old" }, true],
      ["archived before archived_at existed, idle 45 days", { id: "del-legacy", archivedDays: null }, true],
      ["finished tasks do not hold it", { id: "del-done-task" }, true, () => task("del-done-task", "completed")],
      ["archived 10 days ago, idle 60", { id: "keep-recent", archivedDays: 10, updatedDays: 60 }, false],
      ["legacy archived, idle 10 days", { id: "keep-legacy-recent", archivedDays: null, updatedDays: 10 }, false],
      ["active", { id: "keep-active", status: "active", archivedDays: null, updatedDays: 90 }, false],
      ["Anthropic-compatible", { id: "keep-compat", compat: true }, false],
      ["agent running", { id: "keep-running", agent: "running" }, false],
      ["team member running", { id: "keep-parent" }, false,
        () => seed({ id: "keep-child", status: "active", archivedDays: null, updatedDays: 0, agent: "running", parent: "keep-parent" })],
      ["open task", { id: "keep-open-task" }, false, () => task("keep-open-task", "queued")],
      ["queued message", { id: "keep-pending" }, false,
        async () => { await q("INSERT INTO claw_pending_messages (session_id, content) VALUES ('keep-pending', 'x')"); }],
      ["work item worker", { id: "keep-worker" }, false,
        async () => {
          await q(`INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, worker_session_id, outcome, closed_at)
                   VALUES ('it-1', 'u1', 1, 't', 'done', 'keep-worker', 'accepted', NOW() - INTERVAL '50 days')`);
        }],
    ];
    for (const [, s, , extra] of cases) {
      await seed(s);
      await extra?.();
    }
    await seed({ id: "already-deleted", deletedDays: 5 });
    const before = (await rows("SELECT deleted_at FROM claw_sessions WHERE session_id = 'already-deleted'"))[0].deleted_at;

    const report = await retention.runSessionRetention(SETTINGS);

    const expected = [...cases.filter(([, , del]) => del).map(([, s]) => s.id), "already-deleted"].sort();
    assert.deepEqual(await deletedIds(), expected,
      `kept: ${cases.filter(([, , d]) => !d).map(([n]) => n).join("; ")}`);
    assert.equal(report.eligible, 3);
    assert.equal(report.deleted, 3);
    assert.equal(report.skipped, 0);
    const after = (await rows("SELECT deleted_at FROM claw_sessions WHERE session_id = 'already-deleted'"))[0].deleted_at;
    assert.deepEqual(after, before, "a session already deleted keeps its deletion time");
  });

  test("T2 a retention delete is the user's delete commit", async () => {
    await seed({ id: "s1" });
    await content("s1", null);
    await seed({ id: "s-other", status: "active", archivedDays: null, updatedDays: 0 });
    await content("s-other", null);

    await retention.runSessionRetention(SETTINGS);

    const s1 = (await rows("SELECT * FROM claw_sessions WHERE session_id = 's1'"))[0];
    assert.notEqual(s1.deleted_at, null);
    assert.equal(s1.cleanup_state, "pending", "the cleanup sweeper owns the S3 side");
    for (const t of retention.PURGED_TABLES) {
      const live = await rows(`SELECT DISTINCT session_id FROM ${t} WHERE deleted_at IS NULL ORDER BY session_id`);
      assert.deepEqual(live.map((r) => r.session_id), ["s-other"], `${t}: only the other session's rows stay live`);
    }
  });

  test("T3 a session that becomes ineligible after the scan is skipped", async () => {
    await seed({ id: "racy" });
    await seed({ id: "plain" });
    const original = dbModule.db.query;
    // A message queued for "racy" between the scan and its deletion: the scan
    // already picked it, so only the check under the row lock can refuse it.
    dbModule.db.query = (async (text: string, params?: unknown[]) => {
      const r = await original.call(dbModule.db, text, params);
      if (typeof text === "string" && text.includes("ORDER BY COALESCE(s.archived_at, s.updated_at)")) {
        await original.call(dbModule.db,
          "INSERT INTO claw_pending_messages (session_id, content) VALUES ('racy', 'late')");
      }
      return r;
    }) as typeof original;
    let report;
    try {
      report = await retention.runSessionRetention(SETTINGS);
    } finally {
      dbModule.db.query = original;
    }
    assert.deepEqual(await deletedIds(), ["plain"]);
    assert.equal(report.deleted, 1);
    assert.equal(report.skipped, 1);
    assert.equal((await rows("SELECT 1 FROM claw_pending_messages WHERE session_id = 'racy'")).length, 1,
      "the declined transaction dropped nothing");
  });

  test("T3c a team member starting a run while the parent is being deleted is waited for", async () => {
    await seed({ id: "lead" });
    await seed({ id: "member", status: "active", archivedDays: null, updatedDays: 1, parent: "lead" });
    // The member's run starts in a transaction of its own that has written the
    // child row but not committed: the deletion must wait on that row and then
    // see the run, not read the old value and delete the lead beside it.
    const starter = await cluster!.connect();
    await starter.query("BEGIN");
    await starter.query("UPDATE claw_sessions SET agent_status = 'running' WHERE session_id = 'member'");
    const pass = retention.runSessionRetention(SETTINGS);
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const r = await starter.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND datname = current_database()`);
      blocked = r.rows.length > 0;
      if (!blocked) await new Promise((res) => setTimeout(res, 50));
    }
    await starter.query("COMMIT");
    const report = await pass;
    assert.ok(blocked, "the deletion waited on the member's row");
    assert.deepEqual(await deletedIds(), []);
    assert.equal(report.deleted, 0);
    assert.equal(report.skipped, 1);
  });

  test("T3b commitSessionDeletion with a declining precondition writes nothing", async () => {
    await seed({ id: "s1" });
    await content("s1", null);
    assert.equal(await teardown.commitSessionDeletion("s1", { onlyIf: async () => false }), false);
    assert.deepEqual(await deletedIds(), []);
    assert.equal((await rows("SELECT 1 FROM claw_conversation_turns WHERE deleted_at IS NOT NULL")).length, 0);
    assert.equal(await teardown.commitSessionDeletion("s1", { onlyIf: async () => true }), true);
    assert.deepEqual(await deletedIds(), ["s1"]);
  });

  test("T4 the batch takes the oldest first; dry run and 0 change nothing", async () => {
    // Named so that neither id order picks the same two as age order.
    await seed({ id: "a-oldest", archivedDays: 90 });
    await seed({ id: "b-newest", archivedDays: 31 });
    await seed({ id: "c-middle", archivedDays: 60 });

    const off = await retention.runSessionRetention({ ...SETTINGS, retentionDays: 0 });
    assert.equal(off.eligible, 0);
    const dry = await retention.runSessionRetention({ ...SETTINGS, batch: 2, dryRun: true });
    assert.deepEqual([dry.eligible, dry.deleted], [3, 2]);
    assert.deepEqual(await deletedIds(), []);

    const real = await retention.runSessionRetention({ ...SETTINGS, batch: 2 });
    assert.deepEqual([real.eligible, real.deleted], [3, 2]);
    assert.deepEqual(await deletedIds(), ["a-oldest", "c-middle"]);
  });

  test("T5 the cleanup sweep removes the session's S3 prefixes", async () => {
    await seed({ id: "s-files" });
    await retention.runSessionRetention(SETTINGS);
    // Due one inline budget after the commit; make it due now.
    await q("UPDATE claw_sessions SET cleanup_next_at = NOW() WHERE session_id = 's-files'");

    const { getS3Client } = await import("../src/infra/s3-client.js");
    const { sessionWorkspacePrefix } = await import("../src/workspace/prefix.js");
    const { sweepSessionCleanups } = await import("../src/sessions/cleanup-sweep.js");
    const s3 = getS3Client();
    const originalSend = s3.send;
    const originalPorts = { ...teardown.teardownPorts };
    const listed: string[] = [];
    const deleted: string[] = [];
    (s3 as any).send = async (cmd: any) => {
      const name = cmd.constructor.name;
      if (name === "ListObjectsV2Command") {
        listed.push(cmd.input.Prefix);
        return { Contents: [{ Key: `${cmd.input.Prefix}a.txt` }], IsTruncated: false };
      }
      if (name === "DeleteObjectCommand") { deleted.push(cmd.input.Key); return {}; }
      throw new Error(`unexpected ${name}`);
    };
    // Everything but the S3 step reaches NATS, which this suite has none of.
    teardown.teardownPorts.writeTombstones = async () => "written";
    teardown.teardownPorts.notifyCleanup = () => true;
    teardown.teardownPorts.parkHands = async () => "parked";
    teardown.teardownPorts.deleteGateLocks = async () => true;
    teardown.teardownPorts.purgeSessionEvents = async () => {};
    teardown.teardownPorts.releaseWorkspaceRefs = async () => "released";
    try {
      assert.equal(await sweepSessionCleanups(), 1);
    } finally {
      (s3 as any).send = originalSend;
      Object.assign(teardown.teardownPorts, originalPorts);
    }
    const prefixes = [sessionWorkspacePrefix("u1", "s-files"), teardown.sessionCheckpointPrefix("u1", "s-files")];
    assert.deepEqual(listed, prefixes);
    assert.deepEqual(deleted, prefixes.map((p) => `${p}a.txt`));
    const row = (await rows("SELECT cleanup_state FROM claw_sessions WHERE session_id = 's-files'"))[0];
    assert.equal(row.cleanup_state, "done");
  });

  test("T6 the purge removes stamped rows past the window and nothing else", async () => {
    await seed({ id: "gone-old", deletedDays: 40 });
    await content("gone-old", 40);
    await seed({ id: "gone-recent", deletedDays: 5 });
    await content("gone-recent", 5);
    await seed({ id: "live", status: "active", archivedDays: null, updatedDays: 0 });
    await content("live", null);
    const count = async (t: string, sid: string) =>
      (await rows(`SELECT COUNT(*)::int AS n FROM ${t} WHERE session_id = $1`, [sid]))[0].n as number;
    const purge = { retentionDays: 0, purgeDays: 30, batch: 100, dryRun: false };

    const dry = await retention.runSessionRetention({ ...purge, dryRun: true });
    assert.deepEqual([dry.purgeEligible, dry.purgedSessions], [1, 1]);
    assert.deepEqual(dry.purgedRows,
      { claw_conversation_turns: 1, claw_session_events: 2, claw_session_summaries: 1 });
    assert.equal(await count("claw_session_events", "gone-old"), 2, "dry run deletes nothing");

    const real = await retention.runSessionRetention(purge);
    assert.deepEqual(real.purgedRows,
      { claw_conversation_turns: 1, claw_session_events: 2, claw_session_summaries: 1 });
    for (const t of retention.PURGED_TABLES) {
      assert.equal(await count(t, "gone-old"), 0, `${t}: purged`);
      assert.equal(await count(t, "gone-recent"), 1 + (t === "claw_session_events" ? 1 : 0), `${t}: inside the window`);
      assert.equal(await count(t, "live"), 1 + (t === "claw_session_events" ? 1 : 0), `${t}: live session untouched`);
    }
    assert.equal((await rows("SELECT 1 FROM claw_sessions WHERE session_id = 'gone-old'")).length, 1,
      "the session row stays");
    const again = await retention.runSessionRetention(purge);
    assert.equal(again.purgeEligible, 0, "a purged session is not selected again");
  });

  test("T7 archiving stamps archived_at, re-archiving keeps it, unarchiving clears it", async () => {
    await seed({ id: "idle", status: "active", archivedDays: null, updatedDays: 10 });
    await seed({ id: "owner", status: "active", archivedDays: null, updatedDays: 0 });
    assert.equal(await archive.archiveIdleSessions(7), 1);
    const idle = (await rows("SELECT archived_at FROM claw_sessions WHERE session_id = 'idle'"))[0];
    assert.ok(Date.now() - new Date(idle.archived_at).getTime() < 60_000);

    assert.equal(await archive.archiveSession("owner"), "ok");
    await q("UPDATE claw_sessions SET archived_at = NOW() - INTERVAL '3 days' WHERE session_id = 'owner'");
    assert.equal(await archive.archiveSession("owner"), "ok");
    const kept = (await rows(
      "SELECT archived_at < NOW() - INTERVAL '2 days' AS old FROM claw_sessions WHERE session_id = 'owner'"))[0];
    assert.equal(kept.old, true, "archiving an archived session does not restart its clock");

    assert.equal(await archive.unarchiveSession("owner"), true);
    const back = (await rows("SELECT status, archived_at FROM claw_sessions WHERE session_id = 'owner'"))[0];
    assert.deepEqual([back.status, back.archived_at], ["active", null]);
  });

  test("T8 the batch is the day's limit across passes and replicas, not each pass's", async () => {
    // Every replica runs a pass a minute after it boots, so one rollout of four
    // replicas was four passes, each deleting a whole batch: a batch of 5000
    // deleted 16,535 sessions in the hour after one rollout, and the cleanup
    // sweeper was hours behind on all of them.
    for (let i = 1; i <= 4; i += 1) await seed({ id: `exp-${i}`, archivedDays: 40 + i });
    // Deleted today by their owners: an archived session counts against the day,
    // since nothing on the row says who deleted it; a compatible-API session does
    // not, since its client deletes its own and retention never takes one.
    await seed({ id: "user-gone", archivedDays: 40, deletedDays: 0 });
    await seed({ id: "compat-gone", archivedDays: 40, compat: true, deletedDays: 0 });
    const batch = { ...SETTINGS, batch: 3 };

    const first = await retention.runSessionRetention(batch);
    assert.deepEqual([first.eligible, first.deleted], [4, 2], "the batch less the one deleted today");
    assert.deepEqual(await deletedIds(), ["compat-gone", "exp-3", "exp-4", "user-gone"], "oldest first");

    // Another replica's pass the same day, with a fresh batch of its own.
    const second = await retention.runSessionRetention(batch);
    assert.deepEqual([second.eligible, second.deleted], [2, 0], "the day's batch is spent");
    const dry = await retention.runSessionRetention({ ...batch, dryRun: true });
    assert.equal(dry.deleted, 0, "a dry run reports what today's pass would delete");
    assert.deepEqual(await deletedIds(), ["compat-gone", "exp-3", "exp-4", "user-gone"]);

    // A day later the window has moved past those deletions.
    await q("UPDATE claw_sessions SET deleted_at = NOW() - INTERVAL '25 hours' WHERE deleted_at IS NOT NULL");
    const nextDay = await retention.runSessionRetention(batch);
    assert.deepEqual([nextDay.eligible, nextDay.deleted], [2, 2]);
    assert.deepEqual(await deletedIds(),
      ["compat-gone", "exp-1", "exp-2", "exp-3", "exp-4", "user-gone"]);
  });
});
