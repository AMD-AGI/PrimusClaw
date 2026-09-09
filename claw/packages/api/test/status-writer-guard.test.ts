// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One function writes `claw_tasks.status`, and every writer goes through it.
 *
 * The queue accrual rides on that statement, so a caller that issues its own
 * UPDATE does not merely bypass a helper -- it silently drops that run's whole
 * queued segment, and nothing about the row afterwards says so. Enforced in
 * code rather than by the database, which is what makes this test the guard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.join(here, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const sources = readdirSync(workspaceRoot)
  .map((pkg) => path.join(workspaceRoot, pkg, "src"))
  .filter((dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } })
  .flatMap(sourceFiles)
  .map((file) => ({
    file: path.relative(workspaceRoot, file),
    text: readFileSync(file, "utf8").replace(/\s+/g, " "),
  }));

test("no source file but the transition function writes a task's status", () => {
  const writers = sources
    .filter((s) => /UPDATE claw_tasks SET status/i.test(s.text))
    .map((s) => s.file);
  assert.deepEqual(writers, ["api/src/tasks/db.ts"],
    "a status UPDATE written anywhere else drops that run's queued segment");
});

test("the transition function contributes the accrual to every status change", () => {
  const db = sources.find((s) => s.file === "api/src/tasks/db.ts")!.text;
  assert.match(db, /queued_ms_accrued = queued_ms_accrued \+ CASE WHEN status = 'queued'/,
    "the accrual is what makes going through this function worth enforcing");
  assert.match(db, /clock_timestamp\(\) - queued_at/,
    "measured at the instant the row leaves the queue, not at transaction start");
});

test("no caller stamps queued_at behind the transition function's back", () => {
  const offenders = sources
    .filter((s) => s.file !== "api/src/tasks/db.ts" && s.file !== "api/src/infra/db.ts")
    .filter((s) => /queued_at = (NOW\(\)|clock_timestamp\(\))/i.test(s.text))
    .map((s) => s.file);
  assert.deepEqual(offenders, [],
    "a stamp outside the function reopens a segment the accrual has not banked");
});
