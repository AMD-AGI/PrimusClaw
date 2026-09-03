// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// review-p1-fixes.test.ts
//
// Three review findings whose common shape is a check written for one
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

test("a platform key is demanded only where a SaFE workload is created", async () => {
  // deploy.sh defaults CLAW_DEPLOY_MODE to "kubernetes", where the caller
  // holds a virtual key and platformKey is "" -- so an unconditional demand
  // 403'd every task and batch on the default configuration.
  const src = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../src/auth/session-credentials.ts", import.meta.url), "utf8"));
  assert.match(src, /CLAW_DEPLOY_MODE !== "kubernetes"[\s\S]{0,80}!user\.platformKey/,
    "the demand must be gated on the mode that actually needs it");
});

test("the backfill backlog is re-drivable, not discarded", async () => {
  // Swept rows are already terminal, so the sweeper's UPDATE cannot select
  // them again: anything over the per-sweep cap used to be dropped in memory
  // and never revisited. The drain selects by outcome instead of by memory.
  const src = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../src/tasks/platform-backfill.ts", import.meta.url), "utf8"));
  assert.ok(src.includes("export async function drainPendingPlatformFacts"), "a drain must exist");
  const q = src.slice(src.indexOf("drainPendingPlatformFacts"));
  assert.ok(q.includes("platform_message IS NULL"), "select rows with no facts");
  assert.ok(q.includes("platform_kill_reason IS NULL"), "and no kill reason");
  assert.ok(q.includes("sandbox_workload_id IS NOT NULL"), "that have something to ask about");
  assert.ok(q.includes("status IN ('completed', 'failed', 'cancelled')"), "terminal rows only");

  const sweeper = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../src/tasks/sweeper.ts", import.meta.url), "utf8"));
  const tick = sweeper.slice(sweeper.indexOf("export async function sweeperTick"));
  assert.ok(
    tick.includes('runContained("sweeper.platform_backfill_drain_failed", drainPendingPlatformFacts)'),
    "every tick must drain even when reapStaleTasks returned no rows",
  );
});
