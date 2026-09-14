// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The unreleased record, run against a real Postgres rather than a stand-in.
 *
 * Every other test of this feature replaces `unreleasedRecord` with an
 * in-memory Map, which is the right shape for asserting what the teardown does
 * with the answer -- and exactly the wrong thing to trust about the record
 * itself. A Map cannot disagree with its own implementation. These statements
 * can: they are hand-written jsonb merges against a column shared with
 * everything else a task keeps, and the failure they would have is silent.
 * A `mark` that overwrote `metadata` would wipe `derived.handle_last_user` and
 * take the DAG's whole teardown plan with it; a `clear` that missed would
 * leave a DAG permanently unconfirmed; an `any` that read the wrong path would
 * answer `nothing_held` for a leak, which is the one answer this must never
 * invent.
 *
 * PGlite is Postgres compiled to WASM and the schema is `clawTasksSchemaSql()`,
 * the same DDL the cluster gets -- so `||`, `-` and `jsonb_build_object`
 * behave here as they will there. See SCENARIOS.md.
 *
 * Coverage:
 *   U1 a mark is readable, and leaves the rest of `metadata` alone
 *   U2 marks accumulate per handle instead of replacing one another
 *   U3 clearing one handle leaves the others outstanding
 *   U4 clearing the last one makes the DAG answer "nothing outstanding"
 *   U5 clearing a handle that was never marked is a no-op, not a throw
 *   U6 the record is written to the DAG ROOT row, not to a node that shares the id
 *   U7 a DAG root that does not exist is an unknown, not "nothing outstanding"
 *   U8 the record reaches the caller through the public task read
 *   U9 a handle named `token` survives the round trip, database to redactor
 *   U10 two workloads under one handle name are separate entries, cleared apart
 *   U11 a retry stamps its key without taking the rest of `metadata` with it
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, seedSession, seedRun, type Harness } from "./scenario-harness.js";
import { publicTaskRow } from "../src/events/redaction.js";

let h: Harness;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

const { unreleasedRecord } = await import("../src/tasks/sandbox-stopper.js");

/** A DAG root carrying the metadata a real root carries. */
async function seedDagRoot(taskId = "t-root"): Promise<void> {
  await seedSession(h, "s-1");
  await seedRun(h, taskId, "s-1");
  await h.sql(
    `UPDATE claw_tasks
        SET dag_node_id = '__dag_root__',
            dag_root_task_id = $1,
            metadata = metadata || '{"derived":{"handle_last_user":{"main":"n-2"}}}'::jsonb
      WHERE task_id = $1`,
    [taskId],
  );
}

async function metadata(taskId = "t-root"): Promise<Record<string, unknown>> {
  const rows = await h.sql(`SELECT metadata FROM claw_tasks WHERE task_id = $1`, [taskId]);
  return rows[0].metadata as Record<string, unknown>;
}

beforeEach(async () => { await h.reset(); });

test("U1 a mark is readable, and leaves the rest of metadata alone", async () => {
  await seedDagRoot();
  assert.equal(await unreleasedRecord.any("t-root"), false, "nothing outstanding to begin with");

  await unreleasedRecord.mark("t-root", "main", "w-1");

  assert.equal(await unreleasedRecord.any("t-root"), true);
  const meta = await metadata();
  // The part that would be silent: `metadata` is shared, and the teardown plan
  // for this very DAG lives one key over from what was just written.
  assert.deepEqual(
    (meta.derived as Record<string, unknown>)?.handle_last_user, { main: "n-2" },
    "a write to sandbox_release must not take the rest of the row's metadata with it",
  );
  const outstanding = (meta.sandbox_release as Record<string, unknown>)
    ?.unreleased as Record<string, { handle: string; workload_id: string; at: string }>;
  // Keyed by workload identity, not by the handle name: a rebuild reuses the
  // name, and a handle a DAG legitimately calls `token` would be redacted away
  // as a key. The name is carried in the value, where it is data.
  const [entry] = Object.values(outstanding);
  assert.equal(entry.workload_id, "w-1", "and the workload id is kept, not just the fact");
  assert.equal(entry.handle, "main", "with the handle name beside it");
  assert.ok(Date.parse(entry.at) > 0, "with a timestamp an operator can age the leak by");
});

test("U2 marks accumulate per handle instead of replacing one another", async () => {
  await seedDagRoot();
  await unreleasedRecord.mark("t-root", "a", "w-a");
  await unreleasedRecord.mark("t-root", "b", "w-b");

  const outstanding = (await metadata()).sandbox_release as { unreleased: Record<string, unknown> };
  assert.deepEqual(
    Object.values(outstanding.unreleased)
      .map((e) => (e as { handle: string }).handle).sort(),
    ["a", "b"],
    "a DAG can leak more than one sandbox, and the second must not erase the first",
  );
});

test("U3 clearing one handle leaves the others outstanding", async () => {
  await seedDagRoot();
  await unreleasedRecord.mark("t-root", "a", "w-a");
  await unreleasedRecord.mark("t-root", "b", "w-b");

  await unreleasedRecord.clear("t-root", "a", "w-a");

  assert.equal(await unreleasedRecord.any("t-root"), true, "b is still unreleased");
  const outstanding = (await metadata()).sandbox_release as { unreleased: Record<string, unknown> };
  assert.deepEqual(
    Object.values(outstanding.unreleased).map((e) => (e as { handle: string }).handle),
    ["b"],
  );
});

test("U4 clearing the last one makes the DAG answer nothing outstanding", async () => {
  // The record must not be a latch. A DAG that leaked once, and whose later
  // teardown succeeded, has to be able to say so -- otherwise every cancel of
  // it reports `unconfirmed` forever and the field stops meaning anything.
  await seedDagRoot();
  await unreleasedRecord.mark("t-root", "a", "w-a");
  await unreleasedRecord.clear("t-root", "a", "w-a");

  assert.equal(await unreleasedRecord.any("t-root"), false);
});

test("U5 clearing a handle that was never marked is a no-op", async () => {
  await seedDagRoot();
  await unreleasedRecord.clear("t-root", "never-marked", "w-x");

  assert.equal(await unreleasedRecord.any("t-root"), false);
  assert.deepEqual(
    ((await metadata()).derived as Record<string, unknown>)?.handle_last_user, { main: "n-2" },
    "and it still does not disturb the rest of the row",
  );
});

test("U6 the record is written to the DAG root row, not to a node of the same DAG", async () => {
  // Both rows carry `dag_root_task_id = 't-root'`; only one is the root. The
  // predicate that separates them is the whole reason `any` can read back what
  // `mark` wrote, and a statement missing it would write to whichever row the
  // planner reached first.
  await seedDagRoot();
  await seedRun(h, "t-node", "s-1");
  await h.sql(
    `UPDATE claw_tasks SET dag_node_id = 'n-2', dag_root_task_id = 't-root' WHERE task_id = 't-node'`,
  );

  await unreleasedRecord.mark("t-root", "main", "w-1");

  assert.equal(
    JSON.stringify(await metadata("t-node")).includes("sandbox_release"), false,
    "a node row is not where a caller of GET /v1/tasks/<dag root> would look",
  );
  assert.equal(await unreleasedRecord.any("t-root"), true);
});

test("U7 a DAG root that does not exist is an unknown, not nothing outstanding", async () => {
  // `any` backs the one answer that must never be invented. With no row there
  // is no record to read, which is not the same as a record that is empty, and
  // the teardown turns this throw into `unconfirmed`.
  await assert.rejects(() => unreleasedRecord.any("t-nonexistent"));
});

test("U8 the record reaches the caller through the public task read", () => {
  // Half the reason the record lives on `metadata` rather than in KV. A
  // `released: "unconfirmed"` says a sandbox was not released; it cannot say
  // WHICH handle, or what workload to go and look for, and an operator holding
  // only the first has nothing to act on. `publicTaskRow` strips the three
  // credential fields and redacts the rest, so this asserts the record is on
  // the readable side of that -- a redactor that grew a rule for `*_id` or for
  // anything under an unfamiliar key would take the actionable half away
  // silently, leaving an endpoint that still answers and no longer helps.
  const redacted = publicTaskRow({
    task_id: "t-root",
    internal_token_hash: "hash",
    callback_url: "https://callback",
    backend_mcp_url: "https://mcp",
    metadata: {
      sandbox_release: {
        unreleased: {
        "3f1a9c0b2d4e6f80": { handle: "token", workload_id: "w-1", at: "2026-09-14T00:00:00.000Z" },
      },
      },
    },
  } as never) as unknown as { metadata: Record<string, unknown> };

  const outstanding = (redacted.metadata.sandbox_release as { unreleased: Record<string, unknown> })
    ?.unreleased;
  // The handle is deliberately named `token` here: `redactPublicJson` replaces
  // the value under any credential-shaped KEY, and handle names are chosen by
  // whoever wrote the DAG. Keyed by name, this entry would arrive as
  // "[REDACTED]" and take the workload id -- the only actionable part -- with
  // it. Keyed by workload identity, the name is data and survives.
  assert.deepEqual(
    outstanding,
    { "3f1a9c0b2d4e6f80": { handle: "token", workload_id: "w-1", at: "2026-09-14T00:00:00.000Z" } },
    "the handle name and the workload id are the two things the caller needs to act",
  );
});

test("U9 a handle named `token` survives the round trip, database to redactor", () => {
  // U8 asserts a constructed record passes the redactor; this asserts the key
  // the code actually writes does, for the handle name that provoked the
  // design. `isSensitiveKey` splits a key into words, so `token`, `w-1:token`
  // and `handle_token` are all redacted alike -- and a DAG author is entitled
  // to call a handle `token`. Only a key with no word in it survives, which is
  // why the key is a digest and both names live in the value.
  //
  // Written as one assertion over the real `mark` statement's key, rather than
  // trusting that the digest "looks safe".
  return (async () => {
    await seedDagRoot();
    await unreleasedRecord.mark("t-root", "token", "w-1");

    const stored = await metadata();
    const redacted = publicTaskRow({
      task_id: "t-root", internal_token_hash: "h", callback_url: "c", backend_mcp_url: "m",
      metadata: stored,
    } as never) as unknown as { metadata: Record<string, unknown> };

    const outstanding = (redacted.metadata.sandbox_release as { unreleased: Record<string, unknown> })
      .unreleased;
    const entries = Object.values(outstanding) as Array<{ handle?: string; workload_id?: string }>;
    assert.equal(entries.length, 1);
    assert.equal(
      entries[0]!.workload_id, "w-1",
      "the workload id is the actionable half, and a redacted key would have taken it",
    );
    assert.equal(entries[0]!.handle, "token", "with the handle name intact beside it");
  })();
});

test("U10 two workloads under one handle name are separate entries, cleared apart", async () => {
  // What the digest is FOR, and what nothing else here would catch: a key made
  // only of the handle name passes every other test in this file, because every
  // other test uses one workload per name.
  //
  // A handle name is reused -- a rebuild registers a second workload under the
  // same name. Keyed by name, the two share an entry: the newer failure
  // overwrites the older, and worse, an older workload's stop succeeding clears
  // the newer one's failure. That is a confirmed release assembled out of two
  // unrelated events, and the leaked workload is the one nobody is now looking
  // for.
  await seedDagRoot();
  await unreleasedRecord.mark("t-root", "main", "w-old");
  await unreleasedRecord.mark("t-root", "main", "w-new");

  const both = (await metadata()).sandbox_release as { unreleased: Record<string, unknown> };
  assert.equal(
    Object.keys(both.unreleased).length, 2,
    "same name, different workloads: two things leaked, so two entries",
  );

  // The older workload's stop lands. It says nothing about the newer one.
  await unreleasedRecord.clear("t-root", "main", "w-old");

  const left = Object.values(
    ((await metadata()).sandbox_release as { unreleased: Record<string, unknown> }).unreleased,
  ) as Array<{ workload_id: string }>;
  assert.deepEqual(
    left.map((e) => e.workload_id), ["w-new"],
    "clearing the one that was released must not clear the one that was not",
  );
  assert.equal(await unreleasedRecord.any("t-root"), true, "so the DAG is still outstanding");
});

test("U11 a retry stamps its key without taking the rest of metadata with it", async () => {
  // Run against a real database because this exact line has now been wrong
  // twice, in opposite directions, and neither version could be caught by
  // reading it. The first wrote back a snapshot read before the INSERT, so a
  // record written in between was reverted. The second patched only
  // `retried_into`, on the belief that `updateTask` merges -- it assigns, so
  // that replaced the whole column with one key and destroyed `derived` along
  // with the record, deterministically. Both statements look right.
  //
  // A STANDALONE row, because that is the only kind `retryTask` accepts: chat
  // rows and anything with a `dag_root_task_id` are refused before the write.
  // It is also the kind that matters here -- the sweeper records an unreleased
  // handle against the owner row, and for a standalone task that is this row.
  await seedSession(h, "s-1");
  await seedRun(h, "t-solo", "s-1", { origin: "api", status: "failed" });
  await h.sql(
    `UPDATE claw_tasks SET metadata = metadata || '{"derived":{"keep":"me"}}'::jsonb
      WHERE task_id = 't-solo'`,
  );
  await unreleasedRecord.mark("t-solo", "main", "w-1");
  assert.equal(await unreleasedRecord.any("t-solo"), true, "the row starts out leaking");

  const { retryTask } = await import("../src/tasks/lifecycle.js");
  const r = await retryTask("t-solo");
  assert.equal(r.ok, true, "the retry has to actually happen, or this test proves nothing");

  const rows = await h.sql(`SELECT metadata FROM claw_tasks WHERE task_id = 't-solo'`);
  const meta = rows[0].metadata as Record<string, unknown>;
  assert.equal(meta.retried_into, r.new_task_id, "the stamp is written");
  assert.equal(
    await unreleasedRecord.any("t-solo"), true,
    "and the leak record survives it -- losing it makes the workload unfindable",
  );
  assert.deepEqual(
    meta.derived, { keep: "me" },
    "as does everything else the column held",
  );
});
