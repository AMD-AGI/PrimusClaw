// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The job that forgets things, and the column it forgets them by.
 *
 * Decay is a daily cron with no caller waiting on it, which is what made its
 * failure mode so quiet: `kind` was added to the query before it was added to
 * the table, so every run threw `column "kind" does not exist` into a log
 * nobody reads. Nothing else broke. Memory simply stopped fading, and the only
 * way to notice was to go looking.
 *
 * Two things are pinned here. That the query still excludes the rows it must
 * not touch -- KB rows have a supersession lifecycle and time must not erode
 * them -- and that every column the query filters on is one the startup guard
 * refuses to serve without, which is what makes the next omission of this kind
 * a failed boot instead of a silent year.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { db } from "../src/infra/db.js";
import { decayMemory } from "../src/memory/service.js";
import { REQUIRED_SCHEMA } from "../src/infra/schema-guard.js";

const originalQuery = db.query;

afterEach(() => {
  db.query = originalQuery;
});

/** Run decay against a database that records rather than answers. */
async function captureDecaySql(): Promise<string[]> {
  const statements: string[] = [];
  db.query = (async (text: string) => {
    statements.push(text);
    return { rows: [], rowCount: 0 };
  }) as typeof db.query;
  await decayMemory();
  return statements;
}

test("decay both fades and, eventually, deletes", async () => {
  const [fade, clean] = await captureDecaySql();
  assert.match(fade, /UPDATE claw_memory_entries/);
  assert.match(fade, /SET importance = GREATEST/);
  assert.match(clean, /SET deleted_at = NOW\(\)/);
});

test("neither statement touches a KB row", async () => {
  // KB rows are superseded by newer knowledge, not forgotten on a curve.
  // Without this filter the decay would delete knowledge that was still true
  // and merely old.
  for (const sql of await captureDecaySql()) {
    assert.match(sql, /kind IS NULL/, `a decay statement reached KB rows:\n${sql}`);
  }
});

test("neither statement touches a profile or an already-deleted row", async () => {
  for (const sql of await captureDecaySql()) {
    assert.match(sql, /category != 'user_profile'/);
    assert.match(sql, /deleted_at IS NULL/);
  }
});

test("every column the decay filters on is one the process refuses to boot without", async () => {
  // The tie that closes the original hole. A new filter added to the query has
  // to be added to the guard as well, or this fails -- which is the difference
  // between a startup that says the column is missing and a cron that says it
  // to nobody.
  const guarded = REQUIRED_SCHEMA.find((r) => r.table === "claw_memory_entries");
  assert.ok(guarded, "claw_memory_entries must be guarded at all");

  const sql = (await captureDecaySql()).join("\n");
  const referenced = [
    "importance", "category", "deleted_at", "kind",
    "last_accessed", "access_count", "created_at",
  ];
  for (const column of referenced) {
    assert.ok(
      new RegExp(`\\b${column}\\b`).test(sql),
      `${column} is listed as referenced but the query no longer mentions it`,
    );
    assert.ok(
      guarded.columns.includes(column),
      `decay filters on ${column}, so startup must refuse to serve without it`,
    );
  }
});
