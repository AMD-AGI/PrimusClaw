// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a session's files are still being saved, read off the session's own
 * events over a real Postgres with the production schema. Skipped without
 * DATABASE_URL; a skip is not a pass.
 *
 * A turn ends on the session before Brain uploads its workspace, so an idle
 * session's listing can trail its last turn by as long as the upload takes (an
 * hour, for a turn that cloned a large repository). The rows below are what the
 * event consumer stores for Brain's `workspaceSave` events: `event` is the type,
 * `data` the event.
 *
 *   W1 a session that never saved is not saving
 *   W2 a save that started and has not finished is saving, for that turn, since it started
 *   W3 a save that finished is not, whatever its outcome
 *   W4 the next turn's save is, after the last one finished
 *   W5 a save that never finished stops counting after WORKSPACE_SAVE_STALE_MS
 *   W6 another session's save, a deleted event and other event types say nothing
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import { WORKSPACE_SAVE_STALE_MS } from "@claw/protocol";

import { postgresSkipReason, startPgCluster, type PgCluster } from "./support/pg-cluster.js";

const skip = postgresSkipReason();
const cluster: PgCluster | undefined = skip ? undefined : await startPgCluster();
if (cluster) {
  process.env.DATABASE_URL = cluster.url;
  delete process.env.DB_SCHEMA;
  process.env.USER_ENV_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
}

describe("workspace save state", { skip }, () => {
  let dbModule: typeof import("../src/infra/db.js");
  let saveState: typeof import("../src/workspace/save-state.js");
  let seq = 0;

  const q = (text: string, params: unknown[] = []) => dbModule.db.query(text, params);
  /** Store one event as the consumer does, `ageMs` old. */
  async function emit(sessionId: string, data: Record<string, unknown>, ageMs = 0, deleted = false): Promise<void> {
    seq += 1;
    await q(
      `INSERT INTO claw_session_events (event_id, session_id, event, data, created_at, deleted_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW() - ($5::bigint * INTERVAL '1 millisecond'),
               CASE WHEN $6::boolean THEN NOW() END)`,
      [`ev-${seq}`, sessionId, String(data.type), JSON.stringify(data), ageMs, deleted],
    );
  }
  const started = (message_id: string) => ({ type: "workspaceSave", phase: "started", message_id });
  const finished = (message_id: string, outcome: string) => ({ type: "workspaceSave", phase: "finished", outcome, message_id });

  before(async () => {
    dbModule = await import("../src/infra/db.js");
    const named = (await dbModule.db.query("SELECT current_database() AS name")).rows[0] as { name: string };
    assert.equal(named.name, cluster!.schema);
    await dbModule.initDb();
    saveState = await import("../src/workspace/save-state.js");
  });
  after(async () => {
    await dbModule?.db.pool.end().catch(() => {});
    await dbModule?.db.lockPool.end().catch(() => {});
    await cluster?.end();
  });
  beforeEach(async () => {
    await q("DELETE FROM claw_session_events");
  });

  test("W1 a session that never saved is not saving", async () => {
    await emit("s1", { type: "exec_complete", message_id: "m1", failed: false });
    assert.equal(await saveState.workspaceSaving("s1"), null);
  });

  test("W2 a save that started and has not finished is saving, for that turn, since it started", async () => {
    await emit("s1", { type: "exec_complete", message_id: "m1", failed: false }, 60_000);
    await emit("s1", started("m1"), 59_000);
    const saving = await saveState.workspaceSaving("s1");
    assert.equal(saving?.message_id, "m1");
    const since = Date.parse(saving!.since);
    assert.ok(Math.abs(Date.now() - 59_000 - since) < 10_000, `since ${saving!.since}`);
  });

  for (const outcome of ["synced", "partial", "empty", "failed"]) {
    test(`W3 a save that finished (${outcome}) is not saving`, async () => {
      await emit("s1", started("m1"), 5_000);
      await emit("s1", finished("m1", outcome), 1_000);
      assert.equal(await saveState.workspaceSaving("s1"), null);
    });
  }

  test("W4 the next turn's save is saving, after the last one finished", async () => {
    await emit("s1", started("m1"), 9_000);
    await emit("s1", finished("m1", "synced"), 8_000);
    await emit("s1", started("m2"), 1_000);
    assert.equal((await saveState.workspaceSaving("s1"))?.message_id, "m2");
  });

  test("W5 a save that never finished stops counting after WORKSPACE_SAVE_STALE_MS", async () => {
    await emit("s1", started("m1"), WORKSPACE_SAVE_STALE_MS + 60_000);
    assert.equal(await saveState.workspaceSaving("s1"), null);
    await emit("s2", started("m1"), WORKSPACE_SAVE_STALE_MS - 60_000);
    assert.equal((await saveState.workspaceSaving("s2"))?.message_id, "m1");
  });

  test("W6 another session's save, a deleted event and other event types say nothing", async () => {
    await emit("other", started("m9"));
    await emit("s1", started("m1"), 3_000, true);
    await emit("s1", { type: "sandboxStatus", status: "workspace_sync_partial", message_id: "m1" }, 2_000);
    assert.equal(await saveState.workspaceSaving("s1"), null);
    assert.equal((await saveState.workspaceSaving("other"))?.message_id, "m9");
  });
});
