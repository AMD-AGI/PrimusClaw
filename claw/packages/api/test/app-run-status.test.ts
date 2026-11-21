// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How an app run's `last_exit` (brain `AppLastExit`) reads as `app.outcome`, and
 * how a row's state reads as `app.sandbox`: every cause in the closed list from the
 * row shapes the Brain writes, and nothing outside the list. The end-to-end proof
 * over a real Postgres and the real AppRunner is app-run-status-e2e-pg.test.ts;
 * this covers the shapes that suite cannot reach in seconds (a sandbox that never
 * became ready, a row written before the sandbox columns).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_RUN_CAUSES, appRunCauseOf, appRunErrorText, appRunOutcomeOf, appRunStatusOf,
} from "../src/tasks/app-run-status.js";

const AT = "2026-11-21T00:00:00.000Z";
const exit = (over: Record<string, unknown>) => ({ at: AT, final: false, ...over });

test("every cause, from the last_exit the Brain leaves for it", () => {
  const cases: Array<[Record<string, unknown> | null, string]> = [
    [exit({ cause: "exit", final: true, returncode: 0 }), "exited"],
    [exit({ cause: "exit", final: true, returncode: 9 }), "exited"],
    [exit({ cause: "restarts_exhausted", returncode: 1 }), "restarts_exhausted"],
    [exit({ cause: "restarts_exhausted", stop_reason: "the platform lost the app's sandbox 24 times" }), "restarts_exhausted"],
    [exit({ cause: "start_failed", stop_reason: "no user data directory" }), "start_failed"],
    [exit({ cause: "deadline" }), "deadline"],
    [exit({ cause: "deadline", sandbox_reason: "sandbox_unschedulable" }), "deadline"],
    [exit({ cause: "cancelled" }), "cancelled"],
    [exit({ cause: "cancelled", sandbox_reason: "sandbox_rejected" }), "cancelled"],
    [exit({ cause: "row_terminal" }), "task_closed"],
    [null, "no_exit_record"],
    [exit({ cause: "restarts_exhausted", sandbox_reason: "sandbox_rejected" }), "sandbox_rejected"],
    [exit({ cause: "restarts_exhausted", sandbox_reason: "sandbox_workspace_forbidden" }), "sandbox_rejected"],
    [exit({ cause: "restarts_exhausted", sandbox_reason: "sandbox_workspace_not_allowed" }), "sandbox_rejected"],
    [exit({ cause: "restarts_exhausted", sandbox_reason: "sandbox_placement_invalid" }), "sandbox_rejected"],
    [exit({ cause: "deadline", sandbox_reason: "sandbox_create_failed" }), "sandbox_create_failed"],
    [exit({ cause: "restarts_exhausted", sandbox_reason: "sandbox_unschedulable" }), "sandbox_unschedulable"],
    [exit({ cause: "restarts_exhausted", sandbox_reason: "sandbox_pending_timeout" }), "sandbox_unschedulable"],
    [exit({ cause: "restarts_exhausted", sandbox_reason: "sandbox_start_timeout" }), "sandbox_start_timeout"],
    [exit({ cause: "restarts_exhausted", sandbox_reason: "sandbox_workload_terminal" }), "sandbox_failed"],
    [exit({ cause: "restarts_exhausted", sandbox_reason: "sandbox_exited_before_ready" }), "sandbox_failed"],
    [exit({ cause: "sandbox_lost", sandbox_reason: "sandbox_gone" }), "sandbox_failed"],
    [exit({ cause: "something_new" }), "no_exit_record"],
  ];
  for (const [lastExit, want] of cases) assert.equal(appRunCauseOf(lastExit), want, JSON.stringify(lastExit));
  const reached = new Set(cases.map(([, want]) => want));
  assert.deepEqual([...APP_RUN_CAUSES].filter((c) => !reached.has(c)), [], "every cause in the list is reached");
  for (const c of reached) assert.ok((APP_RUN_CAUSES as readonly string[]).includes(c), `${c} is in the closed list`);
});

test("the outcome: null until ended; returncode only an integer; error the platform's for a sandbox cause", () => {
  assert.equal(appRunOutcomeOf("finishing", exit({ cause: "exit", final: true, returncode: 0 })), null);
  assert.deepEqual(appRunOutcomeOf("ended", exit({ cause: "exit", final: true, returncode: 4, error: "boom" })),
    { cause: "exited", returncode: 4, final: true, error: "boom" });
  assert.deepEqual(appRunOutcomeOf("ended", exit({ cause: "exit", final: true, returncode: "4" })),
    { cause: "exited", returncode: null, final: true, error: null });
  assert.deepEqual(appRunOutcomeOf("ended", exit({
    cause: "restarts_exhausted", sandbox_reason: "sandbox_rejected", sandbox_message: "denied", error: "stale app error",
  })), { cause: "sandbox_rejected", returncode: null, final: false, error: "denied" });
  assert.deepEqual(appRunOutcomeOf("ended", exit({ cause: "restarts_exhausted", returncode: 1, error: "app error", sandbox_message: "x" })),
    { cause: "restarts_exhausted", returncode: 1, final: false, error: "app error" });
});

test("error: masked before it is cut, one line, at most 300 characters", () => {
  const token = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
  const text = `${"w".repeat(290)} ${token} tail`;
  const shown = appRunErrorText(text)!;
  assert.equal(shown.length, 300);
  assert.ok(!shown.includes("ghp_A1b2"), shown);
  assert.equal(appRunErrorText("line one\n\tline two\r\n"), "line one line two");
  assert.equal(appRunErrorText("Authorization: Bearer abcdef0123456789"), "Authorization: Bearer <redacted>");
  assert.equal(appRunErrorText(""), null);
  assert.equal(appRunErrorText("   "), null);
  assert.equal(appRunErrorText(undefined), null);
  assert.equal(appRunErrorText("short"), "short");
  assert.equal(appRunErrorText("x".repeat(300)), "x".repeat(300));
  assert.equal(appRunErrorText("x".repeat(301)), `${"x".repeat(299)}…`);
});

test("sandbox: the stored state; a row from before the column reads its run state, with no since", () => {
  const row = { task_id: "t", last_exit: null, sandbox_workload_id: "claw-1-sandbox-a1b2c", sandbox_since: new Date(AT) };
  assert.deepEqual(appRunStatusOf({ ...row, state: "finishing", sandbox_state: "pending" }).sandbox,
    { state: "pending", workload_id: "claw-1-sandbox-a1b2c", since: AT });
  for (const [state, want] of [["provisioning", "pending"], ["starting", "running"], ["running", "running"], ["restarting", "running"], ["finishing", "running"], ["ended", "ended"]]) {
    assert.deepEqual(appRunStatusOf({ ...row, state: state!, sandbox_state: null, sandbox_since: null, sandbox_workload_id: null }).sandbox,
      { state: want, workload_id: "", since: null }, state);
  }
});
