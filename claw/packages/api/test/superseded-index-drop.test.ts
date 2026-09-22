// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Removing an index a later one replaced, without ever removing both.
 *
 * Widening a partial index means creating it under a new name: `CREATE INDEX IF
 * NOT EXISTS` will not alter the predicate of an index that already exists, so
 * `idx_tasks_platform_facts_pending` became `..._v2`. Nothing dropped the name
 * it superseded, and nothing ever had -- so every database that booted the older
 * code carries both from then on and maintains both on every write to
 * `claw_tasks`, a table this schema never prunes.
 *
 * The reason that had been left alone is real and is the thing these tests are
 * mostly about. The replacement is built through `ensureConcurrentIndexOrWarn`,
 * which swallows a raised build on purpose so one failed index cannot abort the
 * two hundred lines of DDL and the `assertSchema` below it. "The CREATE
 * returned" therefore says nothing about whether the index exists, and a drop
 * that merely follows it in program order is how a table ends up with neither.
 *
 * So the drop is conditioned on reading the replacement back out of `pg_index`,
 * and the cases below are the three endings that distinguishes -- replacement
 * valid, replacement absent, replacement present but invalid -- driven against
 * a real database, because what is at stake is which indexes exist afterwards
 * and no amount of statement-watching answers that.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { db, dropSupersededIndexWhenReplaced } from "../src/infra/db.js";

type Client = Parameters<typeof dropSupersededIndexWhenReplaced>[0];

const TABLE = "zz_superseded_probe";
const OLD = "zz_superseded_probe_idx";
const NEW = "zz_superseded_probe_idx_v2";

/** Whether a database is actually reachable, so the file can say why it skipped. */
const reachable = await db
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const skip = reachable ? false : "no database on DATABASE_URL";

after(async () => {
  if (reachable) await db.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
});

/**
 * A table carrying whichever of the two indexes a case needs.
 *
 * `replacement` is built for real rather than faked, because the guard reads
 * `pg_index.indisvalid` and the whole question is what Postgres says about an
 * index rather than what a stub was told to say. "invalid" is written straight
 * onto the catalog row: an interrupted `CREATE INDEX CONCURRENTLY` is the only
 * way to reach that state naturally and there is no way to interrupt one on
 * demand, but the row it leaves behind is exactly this.
 */
async function seed(opts: { replacement: "valid" | "invalid" | "absent" }): Promise<Client> {
  const client = (await db.pool.connect()) as unknown as Client;
  await client.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await client.query(`CREATE TABLE ${TABLE} (a INT, b INT)`);
  await client.query(`CREATE INDEX ${OLD} ON ${TABLE}(a) WHERE b > 0`);
  if (opts.replacement !== "absent") {
    await client.query(`CREATE INDEX ${NEW} ON ${TABLE}(a) WHERE b > -1`);
  }
  if (opts.replacement === "invalid") {
    await client.query(
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${NEW}'::regclass`,
    );
  }
  return client;
}

/** The probe table's indexes, by name. */
async function indexesOn(): Promise<string[]> {
  const r = await db.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`,
    [TABLE],
  );
  return r.rows.map((row: { indexname: string }) => row.indexname);
}

test("a superseded index is gone once its replacement is valid", { skip }, async () => {
  // The finding: nothing has ever removed one of these, so the table pays the
  // write amplification of both for the life of the deployment.
  const client = await seed({ replacement: "valid" });
  try {
    assert.deepEqual(await indexesOn(), [OLD, NEW], "the premise: both are there to begin with");
    await dropSupersededIndexWhenReplaced(client, OLD, NEW);
    assert.deepEqual(
      await indexesOn(),
      [NEW],
      "the superseded index must actually be gone from the table, not merely unreferenced",
    );
  } finally {
    (client as unknown as { release(): void }).release();
  }
});

test("a replacement that was never built leaves the old index alone", { skip }, async () => {
  // The ending the guard exists for. `ensureConcurrentIndexOrWarn` swallows a
  // build that raised -- 40P01 against a writer, 53100 out of sort space, 57014
  // on the ceiling -- so control reaches the drop having created nothing. An
  // unguarded drop here is the one outcome that is worse than the residue: a
  // drain with no index at all, on a table that is never pruned.
  const client = await seed({ replacement: "absent" });
  try {
    await dropSupersededIndexWhenReplaced(client, OLD, NEW);
    assert.deepEqual(
      await indexesOn(),
      [OLD],
      "with nothing to replace it, the old index is the only access path there is",
    );
  } finally {
    (client as unknown as { release(): void }).release();
  }
});

test("a replacement left INVALID by an interrupted build is not a replacement", { skip }, async () => {
  // An invalid index exists in `pg_indexes` and is ignored by the planner, so
  // "it is there" is the wrong question and `IF NOT EXISTS` matching it for ever
  // is what makes this state persistent rather than transient.
  const client = await seed({ replacement: "invalid" });
  try {
    await dropSupersededIndexWhenReplaced(client, OLD, NEW);
    assert.deepEqual(
      await indexesOn(),
      [OLD, NEW],
      "an index the planner will not use cannot be the reason to drop the one it does use",
    );
  } finally {
    (client as unknown as { release(): void }).release();
  }
});

test("a database that never had the old index is unaffected", { skip }, async () => {
  // The fresh-install path: the superseded name was never created, so the
  // statement has to be a no-op rather than an error that gets logged on every
  // boot of a database that has nothing wrong with it.
  const client = await seed({ replacement: "valid" });
  try {
    await client.query(`DROP INDEX ${OLD}`);
    await dropSupersededIndexWhenReplaced(client, OLD, NEW);
    assert.deepEqual(await indexesOn(), [NEW]);
    // And again, because every boot runs this.
    await dropSupersededIndexWhenReplaced(client, OLD, NEW);
    assert.deepEqual(await indexesOn(), [NEW], "idempotent, since it runs on every start");
  } finally {
    (client as unknown as { release(): void }).release();
  }
});

test("an unsafe identifier stops the process instead of reaching DDL", async () => {
  // Same reasoning as the guard in `ensureConcurrentIndex`: the name is
  // interpolated into the statement, so this is a caller bug rather than a data
  // condition, and a booted pod that quietly logged it is the outcome to avoid.
  const seen: string[] = [];
  const client = {
    query: async (text: string) => {
      seen.push(text);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Client;
  await assert.rejects(
    () => dropSupersededIndexWhenReplaced(client, "bad-name", "fine_name"),
    /unsafe index name/,
  );
  assert.deepEqual(seen, [], "and it stops before issuing anything");
});

test("the drop is concurrent, so it does not take an exclusive lock on claw_tasks", async () => {
  // A plain DROP INDEX takes ACCESS EXCLUSIVE on the table. Doing that to
  // `claw_tasks` during a boot would stall every claim and every dispatch in
  // the fleet for its duration, which is the same reason the build above it is
  // concurrent.
  const seen: string[] = [];
  const client = {
    query: async (text: string) => {
      seen.push(text.replace(/\s+/g, " ").trim());
      if (/indisvalid/.test(text)) return { rows: [{ indisvalid: true }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Client;
  await dropSupersededIndexWhenReplaced(client, "old_idx", "new_idx");
  const drop = seen.find((s) => s.startsWith("DROP INDEX"));
  assert.ok(drop, `no drop was issued: ${JSON.stringify(seen)}`);
  assert.match(drop!, /^DROP INDEX CONCURRENTLY IF EXISTS "old_idx"$/);
  assert.ok(
    seen.findIndex((s) => /indisvalid/.test(s)) < seen.indexOf(drop!),
    "and the replacement is read before the drop, or the guard guards nothing",
  );
});

const SRC = readFileSync(
  fileURLToPath(new URL("../src/infra/db.ts", import.meta.url)),
  "utf8",
);

test("the migration drops the platform-facts predecessor, after building its replacement", () => {
  // The ordering is the property, and it is a property of the call site rather
  // than of the helper: the helper cannot tell whether the CREATE it is being
  // asked to follow has been issued yet.
  const INIT = SRC.slice(SRC.indexOf("export async function initDb"));
  const createAt = INIT.indexOf("idx_tasks_platform_facts_pending_v2");
  const dropAt = INIT.indexOf("dropSupersededIndexWhenReplaced(");
  assert.ok(createAt >= 0, "the replacement is built in the migration");
  assert.ok(dropAt > createAt, "and the predecessor is dropped strictly after that build");
  assert.match(
    INIT.slice(dropAt, dropAt + 200),
    /"idx_tasks_platform_facts_pending",\s*\n\s*"idx_tasks_platform_facts_pending_v2",/,
    "the superseded name is the argument, and the v2 name is what it is checked against",
  );
});

test("the retention comment no longer tells a reader every older variant is kept", () => {
  // A stale comment on this file has already been cited to justify accepting a
  // defect. The rule it states is still the default, but the platform-facts
  // pair is now an exception to it and a reader has to be able to see that from
  // the comment rather than from the call three statements above it.
  const rule = SRC.slice(
    SRC.indexOf("// Older variants are intentionally retained"),
    SRC.indexOf("idx_tasks_plugin"),
  );
  assert.match(rule, /dropSupersededIndexWhenReplaced/,
    "the comment has to name the mechanism that now removes one");
  assert.match(rule, /unguarded/,
    "and say that what it refuses is the unguarded drop, not every drop");
});
