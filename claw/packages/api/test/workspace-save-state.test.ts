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
 * event consumer stores for Brain's events: `event` is the type, `data` the event.
 *
 *   W1 a session whose last turn saves nothing is not saving
 *   W2 a turn that ended saying a save follows is saving, for that turn, from its end
 *   W3 a save that finished is not, whatever its outcome -- even when its row was stored before the completion's
 *   W4 the next turn's save is saving after the last one finished; a next turn that saves nothing ends the last save
 *   W5 a save that never finished stops counting after WORKSPACE_SAVE_STALE_MS
 *   W6 another session's save, another turn's finish, a deleted completion and other event types say nothing
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
  /** A turn's end, as Brain publishes it: `workspace_save: "pending"` when a save follows. */
  const ended = (message_id: string, saves: boolean) => ({
    type: "exec_complete", message_id, failed: false, ...(saves ? { workspace_save: "pending" } : {}),
  });
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

  test("W1 a session whose last turn saves nothing is not saving", async () => {
    assert.equal(await saveState.workspaceSaving("s1"), null, "no turn at all");
    await emit("s1", ended("m1", false));
    assert.equal(await saveState.workspaceSaving("s1"), null);
  });

  test("W2 a turn that ended saying a save follows is saving, for that turn, from its end", async () => {
    await emit("s1", ended("m1", true), 59_000);
    const saving = await saveState.workspaceSaving("s1");
    assert.equal(saving?.message_id, "m1");
    const since = Date.parse(saving!.since);
    assert.ok(Math.abs(Date.now() - 59_000 - since) < 10_000, `since ${saving!.since}`);
  });

  for (const outcome of ["synced", "partial", "empty", "failed"]) {
    test(`W3 a save that finished (${outcome}) is not saving`, async () => {
      await emit("s1", ended("m1", true), 5_000);
      await emit("s1", finished("m1", outcome), 1_000);
      assert.equal(await saveState.workspaceSaving("s1"), null);
    });
  }

  test("W3 a finish stored before its completion still ends the save", async () => {
    // Published in order, stored by two replicas: the table's order is not the save's.
    await emit("s1", finished("m1", "synced"), 1_000);
    await emit("s1", ended("m1", true), 1_500);
    assert.equal(await saveState.workspaceSaving("s1"), null);
  });

  test("W4 the next turn's save is saving after the last one finished; a next turn that saves nothing ends the last", async () => {
    await emit("s1", ended("m1", true), 9_000);
    await emit("s1", finished("m1", "synced"), 8_000);
    await emit("s1", ended("m2", true), 1_000);
    assert.equal((await saveState.workspaceSaving("s1"))?.message_id, "m2");

    await emit("s2", ended("m1", true), 9_000);
    await emit("s2", ended("m2", false), 1_000);
    assert.equal(await saveState.workspaceSaving("s2"), null, "m2 ran only once m1's save let go of the workspace");
  });

  test("W5 a save that never finished stops counting after WORKSPACE_SAVE_STALE_MS", async () => {
    await emit("s1", ended("m1", true), WORKSPACE_SAVE_STALE_MS + 60_000);
    assert.equal(await saveState.workspaceSaving("s1"), null);
    await emit("s2", ended("m1", true), WORKSPACE_SAVE_STALE_MS - 60_000);
    assert.equal((await saveState.workspaceSaving("s2"))?.message_id, "m1");
  });

  test("W6 another session's save, another turn's finish, a deleted completion and other event types say nothing", async () => {
    await emit("other", ended("m9", true));
    await emit("s1", ended("m1", true), 4_000, true);
    await emit("s1", { type: "sandboxStatus", status: "workspace_sync_partial", message_id: "m1" }, 2_000);
    assert.equal(await saveState.workspaceSaving("s1"), null);
    assert.equal((await saveState.workspaceSaving("other"))?.message_id, "m9");

    await emit("s3", ended("m2", true), 3_000);
    await emit("s3", finished("m1", "synced"), 1_000);
    assert.equal((await saveState.workspaceSaving("s3"))?.message_id, "m2", "m1's finish is not m2's");
  });
});
