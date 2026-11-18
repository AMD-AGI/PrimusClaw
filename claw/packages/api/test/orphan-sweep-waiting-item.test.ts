// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Background work does not keep the sandbox of a work item's worker once the
 * item waits for a person or is over, past WAITING_ITEM_SANDBOX_RELEASE_SECONDS.
 *
 * Measured on 2026-11-06: review sessions started a Postgres for their tests
 * and left it running; Brain's keepalive counted its six processes as running
 * background work (`keepalive.idle_handle_kept_background_work running:6`) and
 * this sweep deferred on the same verdict (`orphan_handles_background_work`),
 * so four global-cpu sandboxes stayed up for one to two hours behind review
 * items waiting on a held merge, or already done.
 *
 * These drive the real `reapOrphanHandles` with the real background-work reader
 * over a fake KV bucket, as orphan-sweep-background-work.test.ts does, and run
 * the work-item query itself on PGlite against the production DDL of
 * `claw_work_items`, `claw_tasks` and `claw_pending_messages`, so the SQL that
 * decides is the SQL that ships.
 *
 * Coverage:
 *   W1 needs_you, quiet past the release time, shells running: stopped
 *   W2 CONTROL: the same item quiet for less than the release time: kept
 *   W3 CONTROL: the same item in progress: kept
 *   W4 CONTROL: a session that is no item's worker (a chat): kept
 *   W5 done, quiet past the release time: stopped
 *   W6 a message queued for the session: kept
 *   W7 a run that ended recently counts as activity even on an old item: kept
 *   W8 a failed read keeps the sandbox
 */
import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { handsSessionKey } from "@claw/protocol";

process.env.SAFE_API_URL = "http://safe.test";
process.env.CLAW_ASSISTANT_ENABLED = "true";
process.env.WAITING_ITEM_SANDBOX_RELEASE_SECONDS = "900";

const { db, clawTasksSchemaSql } = await import("../src/infra/db.js");
const { ensureAssistantSchema } = await import("../src/assistant/schema.js");
const { handleRegistry, readSessionBackgroundWork, unreleasedRecord } = await import("../src/tasks/sandbox-stopper.js");
handleRegistry.terminalHold = async () => ({ state: "none" });
const { reapOrphanHandles } = await import("../src/tasks/sweeper.js");

let pg: PGlite;
before(async () => {
  pg = await PGlite.create();
  for (const sql of clawTasksSchemaSql()) await pg.exec(sql).catch(() => {});
  await pg.exec("CREATE TABLE IF NOT EXISTS claw_pending_messages (id BIGSERIAL PRIMARY KEY, session_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await ensureAssistantSchema({ query: (text: string) => pg.query(text) } as never);
});
after(async () => { await pg.close(); });

const originalQuery = db.query;
const originalRegistry = { ...handleRegistry };
const originalRecord = { ...unreleasedRecord };
const originalFetch = globalThis.fetch;
function restoreAll(): void {
  db.query = originalQuery;
  Object.assign(handleRegistry, originalRegistry);
  Object.assign(unreleasedRecord, originalRecord);
  globalThis.fetch = originalFetch;
}
afterEach(restoreAll);

let stopped: string[];
/** Set by W8: the work-item read throws. */
let failItemRead = false;

beforeEach(async () => {
  stopped = [];
  failItemRead = false;
  await pg.exec("DELETE FROM claw_work_items; DELETE FROM claw_pending_messages; DELETE FROM claw_tasks;");
  handleRegistry.retained = async () => false;
  unreleasedRecord.mark = async () => {};
  unreleasedRecord.clear = async () => {};
  unreleasedRecord.any = async () => false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    stopped.push(/\/workloads\/([^/]+)\/stop$/.exec(url)?.[1] ?? url);
    return new Response("", { status: 200 });
  }) as typeof globalThis.fetch;
  // The DAG row is terminal and nothing in the session is live (as G1-G12); the
  // work-item read goes to Postgres.
  db.query = (async (text: string, params?: unknown[]) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT w.item_id, w.board_state")) {
      if (failItemRead) throw new Error("connection reset");
      const r = await pg.query(text, params as never[]);
      return { rows: r.rows, rowCount: r.rows.length };
    }
    if (sql.startsWith("SELECT status, session_id FROM claw_tasks")) {
      return { rows: [{ status: "completed", session_id: "s-1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;

  const live = new Map([["main", { workload_id: "w-1", session_id: "s-1" }]]);
  const rows = () => Object.fromEntries(live);
  handleRegistry.listAll = async () => [["t-chat", rows()]];
  handleRegistry.listForDag = async () => rows();
  handleRegistry.listForDagConsistent = async () => rows();
  handleRegistry.listDagRoots = async () => ["t-chat"];
  handleRegistry.lookup = async (_d: string, n: string) => live.get(n) ?? null;
  handleRegistry.destroy = async (_d: string, n: string) => {
    const w = live.get(n)?.workload_id ?? null;
    live.delete(n);
    return w;
  };

  // A parked sandbox with six processes measured running in this idle period.
  const idleSince = Date.now() - 2 * 3_600_000;
  const entry = {
    status: "ready", provider: "safe-workload", workloadId: "w-1", platformKey: "pk-1",
    handsUrl: "http://hands.test", token: "tok-1", keepalive: false,
    idleSince, idleEpoch: idleSince, idleRev: 7,
    bgCheckedAt: Date.now() - 1_000, bgRunning: 6, bgEpoch: idleSince, bgIdleSince: idleSince, bgIdleRev: 7, bgRev: 6,
  };
  const enc = new TextEncoder();
  const kv = {
    async get(key: string) {
      return key === handsSessionKey("s-1") ? { value: enc.encode(JSON.stringify(entry)), revision: 7 } : null;
    },
  };
  handleRegistry.backgroundWork = (sessionId, workloadIds) =>
    readSessionBackgroundWork(kv, sessionId, workloadIds, Date.now(), 0);
});

/** The session's work item, last changed `minutesAgo`, with one finished run that ended `runEndedMinutesAgo`. */
async function item(boardState: string, minutesAgo: number, runEndedMinutesAgo = minutesAgo): Promise<void> {
  await pg.query(
    `INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, worker_session_id, updated_at)
     VALUES ('kwi_1', 'u-1', 1, 'review', $1, 's-1', NOW() - make_interval(mins => $2::int))`,
    [boardState, minutesAgo],
  );
  await pg.query(
    `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, created_at, started_at, completed_at)
     VALUES ('t-chat', 's-1', 'chat', 'completed', 'chat', NOW() - make_interval(mins => $1::int + 5),
             NOW() - make_interval(mins => $1::int + 4), NOW() - make_interval(mins => $1::int))`,
    [runEndedMinutesAgo],
  );
}

test("W1 needs_you, quiet past the release time, shells running: stopped", async () => {
  await item("needs_you", 120);
  await reapOrphanHandles();
  assert.deepEqual(stopped, ["w-1"], "an item waiting for a person does not keep its sandbox for background work");
});

test("W2 CONTROL: the same item quiet for less than the release time: kept", async () => {
  await item("needs_you", 5);
  await reapOrphanHandles();
  assert.deepEqual(stopped, []);
});

test("W3 CONTROL: the same item in progress: kept", async () => {
  await item("in_progress", 120);
  await reapOrphanHandles();
  assert.deepEqual(stopped, [], "a worker still at work keeps its background shells");
});

test("W4 CONTROL: a session that is no item's worker (a chat): kept", async () => {
  await reapOrphanHandles();
  assert.deepEqual(stopped, [], "a chat's background work is the user's, and holds its sandbox as before");
});

test("W5 done, quiet past the release time: stopped", async () => {
  await item("done", 60);
  await reapOrphanHandles();
  assert.deepEqual(stopped, ["w-1"]);
});

test("W6 a message queued for the session: kept", async () => {
  await item("needs_you", 120);
  await pg.query("INSERT INTO claw_pending_messages (session_id) VALUES ('s-1')");
  await reapOrphanHandles();
  assert.deepEqual(stopped, [], "a turn is about to start on that sandbox");
});

test("W7 a run that ended recently counts as activity even on an old item: kept", async () => {
  await item("needs_you", 120, 3);
  await reapOrphanHandles();
  assert.deepEqual(stopped, []);
});

test("W8 a failed read keeps the sandbox", async () => {
  await item("needs_you", 120);
  failItemRead = true;
  await reapOrphanHandles();
  assert.deepEqual(stopped, [], "an unknown answer defers, as every other unknown on this path");
});
