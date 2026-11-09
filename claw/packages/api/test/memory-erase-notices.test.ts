// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Deleting or undoing a memory entry removes its title from the chat notices that announced it, and does that
 * through the notice index, not a scan of every session event. Over a real Postgres, skipped without
 * DATABASE_URL (and a skip is not a pass).
 *
 *   E1  the statement eraseEntries runs reaches the notices through idx_events_memory_saved, for one id and for a
 *       delete-everything-sized list, for a user whose sessions hold most of a large event table: never a
 *       sequential scan of claw_session_events, and not a walk of the user's sessions either
 *   E2  delete, undo of a new entry and delete-all take the title off that entry's notices only: another entry's
 *       notice keeps its title, and so does a notice in another user's session that carries the same memory id
 */
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

/** Every node of an EXPLAIN (FORMAT JSON) plan. */
function nodes(plan: Record<string, any>): Array<Record<string, any>> {
  return [plan, ...((plan.Plans ?? []) as Array<Record<string, any>>).flatMap(nodes)];
}

describe("memory erase notices", { skip }, () => {
  let w: World;
  let svc: typeof import("../src/memory/service.js");
  const ids: Record<"one" | "two" | "three" | "four", number> = { one: 0, two: 0, three: 0, four: 0 };

  before(async () => {
    w = await startWorld({ CLAW_MEMORY_ENABLED: "true", CLAW_MEMORY_MAX_ENTRIES: "50" });
    svc = await import("../src/memory/service.js");

    // A busy user (most of the table) and a quiet one. 2000 sessions and 400 000 events of the kinds a chat
    // writes, so the user's own events are far too many to walk and the notices are a sliver of the table.
    await w.q(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode)
       SELECT 'busy-' || g, 'chat', 'busy', 'claw' FROM generate_series(1, 2000) g
       UNION ALL SELECT 'quiet-' || g, 'chat', 'quiet', 'claw' FROM generate_series(1, 20) g`,
    );
    await w.q(
      `INSERT INTO claw_session_events (event_id, session_id, event, data)
       SELECT 'ev-' || g, CASE WHEN g % 50 = 0 THEN 'quiet-' || (g % 20 + 1) ELSE 'busy-' || (g % 2000 + 1) END,
              (ARRAY['text_delta', 'toolUsed', 'exec_complete', 'UserMessage', 'appEvent'])[g % 5 + 1],
              jsonb_build_object('n', g, 'memory_id', g % 997)
         FROM generate_series(1, 400000) g`,
    );

    const write = async (title: string) => {
      const r = await svc.writeMemory("busy", { type: "project", title, body: `${title}, in full` }, { kind: "api", attended: true });
      assert.equal(r.ok, true, JSON.stringify(r));
      return (r as { id: number }).id;
    };
    ids.one = await write("release train is on Tuesdays");
    ids.two = await write("the staging cluster is called blue");
    ids.three = await write("the lab printer is on floor 3");
    ids.four = await write("weekly sync is on Mondays");
    const notice = (sessionId: string, id: number, title: string) => w.q(
      "INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ($1, $2, 'memory_saved', $3)",
      [`notice-${sessionId}-${id}`, sessionId, { type: "memory_saved", memory_id: id, op: "add", title, undo: `undo memory #${id}` }],
    );
    await notice("busy-7", ids.one, "release train is on Tuesdays");
    await notice("busy-8", ids.two, "the staging cluster is called blue");
    await notice("busy-9", ids.three, "the lab printer is on floor 3");
    await notice("busy-10", ids.four, "weekly sync is on Mondays");
    // Another user's notice that names the same number: not the busy user's to change.
    await notice("quiet-1", ids.one, "quiet keeps this title");
    // Hundreds of other notices, so the index is a real lookup and not a whole-index walk of four rows.
    await w.q(
      `INSERT INTO claw_session_events (event_id, session_id, event, data)
       SELECT 'old-notice-' || g, 'busy-' || (g % 2000 + 1), 'memory_saved',
              jsonb_build_object('type', 'memory_saved', 'memory_id', 100000 + g, 'op', 'add', 'title', 'old ' || g)
         FROM generate_series(1, 3000) g`,
    );
    await w.q("ANALYZE claw_sessions");
    await w.q("ANALYZE claw_session_events");
  });
  after(async () => { await w?.stop(); });

  test("E1 the notices are reached through idx_events_memory_saved, never by scanning the events", async () => {
    const index = await w.q("SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('idx_events_memory_saved')");
    assert.deepEqual(index.map((r) => r.indisvalid), [true], "the migration built the notice index");

    for (const list of [[ids.one], Array.from({ length: 50 }, (_, i) => ids.one + i)]) {
      const [row] = await w.q(`EXPLAIN (FORMAT JSON) ${svc.ERASE_NOTICE_TITLES_SQL}`, [list.map(String), "busy"]);
      const plan = nodes(row["QUERY PLAN"][0].Plan);
      // The scans, not the Update node, which names the table it writes.
      const onEvents = plan.filter((n) => n["Relation Name"] === "claw_session_events" && n["Node Type"] !== "ModifyTable");
      assert.ok(onEvents.length > 0, JSON.stringify(plan.map((n) => n["Node Type"])));
      for (const n of onEvents) {
        assert.notEqual(n["Node Type"], "Seq Scan", `claw_session_events is scanned for ${list.length} id(s)`);
        assert.equal(n["Index Name"], "idx_events_memory_saved", `claw_session_events is read through ${n["Index Name"]}`);
        // Looked up by the id, not a walk of every notice filtered row by row: notices grow with every save.
        assert.match(String(n["Index Cond"] ?? ""), /memory_id/, `the notice index is walked, not searched: ${JSON.stringify(n)}`);
      }
    }
  });

  test("E2 delete, undo and delete-all clear that entry's notices and nothing else", async () => {
    const titleOf = async (sessionId: string, id: number) => (await w.q(
      "SELECT data FROM claw_session_events WHERE session_id = $1 AND event = 'memory_saved' AND data->>'memory_id' = $2",
      [sessionId, String(id)],
    )).map((r) => r.data.title ?? null);

    assert.equal(await svc.forgetMemory("busy", ids.one, "api"), true);
    assert.deepEqual(await titleOf("busy-7", ids.one), [null], "the deleted entry's notice lost its title");
    assert.deepEqual(await titleOf("busy-8", ids.two), ["the staging cluster is called blue"], "another entry's notice kept its");
    assert.deepEqual(await titleOf("quiet-1", ids.one), ["quiet keeps this title"], "another user's notice kept its");
    const kept = await w.q("SELECT data FROM claw_session_events WHERE event_id = $1", [`notice-busy-7-${ids.one}`]);
    assert.deepEqual(kept.map((r) => [r.data.memory_id, r.data.undo]), [[ids.one, `undo memory #${ids.one}`]], "the notice itself stays");

    assert.equal(await svc.undoMemory("busy", ids.two, "api"), "deleted");
    assert.deepEqual(await titleOf("busy-8", ids.two), [null], "undoing a new entry deletes it, notice title included");
    assert.deepEqual(await titleOf("busy-9", ids.three), ["the lab printer is on floor 3"]);

    assert.equal(await svc.forgetAllMemories("busy"), 2);
    assert.deepEqual(await titleOf("busy-9", ids.three), [null]);
    assert.deepEqual(await titleOf("busy-10", ids.four), [null]);
    assert.deepEqual(await titleOf("quiet-1", ids.one), ["quiet keeps this title"], "delete-all is the user's own only");
    const old = await w.q("SELECT count(*)::int AS n FROM claw_session_events WHERE event = 'memory_saved' AND data ? 'title' AND data->>'memory_id' = '100001'");
    assert.equal(old[0].n, 1, "a notice of an entry that was never this user's is untouched");
  });
});
