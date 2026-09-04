// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// review-p1-fixes.test.ts
//
// Two review findings whose common shape is a check written for one
// deployment shape and applied to both. None was pinned by anything.

import test from "node:test";
import assert from "node:assert/strict";

test("wait and log_s3_upload_manifest are admissible builtin tools", async () => {
  // `wait` is the tool repeat/until exists to drive, so omitting it rejected
  // the pattern this admission code validates the bounds of, one check earlier.
  const src = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../src/tasks/dags/admission.ts", import.meta.url), "utf8"));
  const block = src.slice(src.indexOf("HANDS_BUILTIN_TOOLS"), src.indexOf("export interface ToolMeta"));
  for (const t of ["wait", "log_s3_upload_manifest", "bash", "ls"]) {
    assert.ok(block.includes(`"${t}"`), `${t} must be admissible`);
  }
});

test("the backfill backlog is re-drivable, not discarded", async () => {
  // Swept rows are already terminal, so the sweeper's UPDATE cannot select
  // them again: anything over the per-sweep cap used to be dropped in memory
  // and never revisited. The drain selects by outcome instead of by memory.
  const src = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../src/tasks/platform-backfill.ts", import.meta.url), "utf8"));
  assert.ok(src.includes("export async function drainPendingPlatformFacts"), "a drain must exist");
  const q = src.slice(src.indexOf("drainPendingPlatformFacts"));
  assert.ok(q.includes("sandbox_workload_id IS NOT NULL"), "that have something to ask about");
  assert.ok(q.includes("status = 'failed'"), "liveness failures only");
  assert.ok(q.includes("platform_facts_resolved_at IS NULL"), "not already resolved");
  assert.ok(q.includes("platform_facts_next_retry_at"), "transient failures are retried with a gate");

  const sweeper = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../src/tasks/sweeper.ts", import.meta.url), "utf8"));
  const tick = sweeper.slice(sweeper.indexOf("export async function sweeperTick"));
  assert.ok(
    tick.includes('runContained("sweeper.platform_backfill_drain_failed", drainPendingPlatformFacts)'),
    "every tick must drain even when reapStaleTasks returned no rows",
  );
});
