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
  APP_RUN_CAUSES, APP_RUN_EXIT_CAUSES, appRunCauseOf, appRunErrorText, appRunLastExitOf, appRunOutcomeOf, appRunStatusOf,
} from "../src/tasks/app-run-status.js";
import { appRunMaxRuntimeSec } from "../src/tasks/app-run.js";
import { APP_MAX_STOP_GRACE_SEC, appStopGraceSec, type AppManifestV1 } from "@claw/protocol";

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

test("last_exit: every cause the Brain writes, its return code and time; nothing else", () => {
  const cases: Array<[Record<string, unknown>, number, unknown]> = [
    [exit({ cause: "exit", returncode: 11, error: "crash", stop_reason: "x" }), 1, { returncode: 11, at: AT, cause: "exited" }],
    [exit({ cause: "exit", final: true, returncode: 0 }), 0, { returncode: 0, at: AT, cause: "exited" }],
    [exit({ cause: "exit" }), 2, { returncode: null, at: AT, cause: "exited" }],
    [exit({ cause: "exit", returncode: 1.5 }), 2, { returncode: null, at: AT, cause: "exited" }],
    [exit({ cause: "start_failed", stop_reason: "no user data directory" }), 0, { returncode: null, at: AT, cause: "start_failed" }],
    [exit({ cause: "sandbox_lost" }), 1, { returncode: null, at: AT, cause: "sandbox_lost" }],
    [exit({ cause: "sandbox_lost", platform_losses: 2 }), 0, { returncode: null, at: AT, cause: "sandbox_lost" }],
    [exit({ cause: "restarts_exhausted", returncode: 15 }), 4, { returncode: 15, at: AT, cause: "restarts_exhausted" }],
    [exit({ cause: "deadline" }), 0, { returncode: null, at: AT, cause: "deadline" }],
    [exit({ cause: "cancelled" }), 0, { returncode: null, at: AT, cause: "cancelled" }],
    [exit({ cause: "row_terminal" }), 0, { returncode: null, at: AT, cause: "task_closed" }],
  ];
  for (const [lastExit, restarts, want] of cases) assert.deepEqual(appRunLastExitOf(lastExit, restarts), want, JSON.stringify(lastExit));
  const reached = new Set(cases.map(([, , want]) => (want as { cause: string }).cause));
  assert.deepEqual([...APP_RUN_EXIT_CAUSES].filter((c) => !reached.has(c)), [], "every cause in the list is reached");
  // Not shown: no record, a cause outside the list, an unreadable time, and the carrier of a create
  // that keeps failing before anything ran (no restart, no platform loss counted).
  assert.equal(appRunLastExitOf(null, 0), null);
  assert.equal(appRunLastExitOf(exit({ cause: "something_new" }), 0), null);
  assert.equal(appRunLastExitOf({ cause: "exit", at: "yesterday" }, 1), null);
  assert.equal(appRunLastExitOf(exit({ cause: "sandbox_lost", sandbox_reason: "sandbox_create_failed" }), 0), null);
  assert.equal(appRunLastExitOf(exit({ cause: "sandbox_lost", platform_losses: 0 }), 0), null);
  // The time is normalised.
  assert.equal(appRunLastExitOf({ cause: "exit", at: "2026-11-21T08:00:00+08:00", final: false }, 1)?.at, "2026-11-21T00:00:00.000Z");
});

test("status: restarts and last_exit beside the sandbox, from the row; restarts never below zero", () => {
  const row = { task_id: "t", state: "restarting", sandbox_workload_id: "w", sandbox_state: "running", sandbox_since: AT };
  const s = appRunStatusOf({ ...row, restarts: "3", last_exit: exit({ cause: "exit", returncode: 13 }) });
  assert.deepEqual({ restarts: s.restarts, crash_restarts: s.crash_restarts, platform_losses: s.platform_losses, last_exit: s.last_exit, outcome: s.outcome },
    { restarts: 3, crash_restarts: 3, platform_losses: 0, last_exit: { returncode: 13, at: AT, cause: "exited" }, outcome: null });
  assert.deepEqual(Object.keys(s), ["sandbox", "restarts", "crash_restarts", "platform_losses", "last_exit", "outcome"]);
  const counts = (r: Record<string, unknown>) => {
    const v = appRunStatusOf({ ...row, ...r } as never);
    return [v.restarts, v.crash_restarts, v.platform_losses];
  };
  assert.deepEqual(counts({ restarts: null, last_exit: null }), [0, 0, 0]);
  assert.deepEqual(counts({ restarts: -1, last_exit: null }), [0, 0, 0]);
});

test("status: crash_restarts from the row's restarts, platform_losses from last_exit, restarts their total", () => {
  const row = { task_id: "t", state: "provisioning", sandbox_workload_id: null, sandbox_state: "pending", sandbox_since: AT };
  const counts = (restarts: unknown, lastExit: Record<string, unknown> | null) => {
    const v = appRunStatusOf({ ...row, restarts, last_exit: lastExit } as never);
    return { restarts: v.restarts, crash_restarts: v.crash_restarts, platform_losses: v.platform_losses };
  };
  assert.deepEqual(counts(2, exit({ cause: "sandbox_lost", platform_losses: 3 })), { restarts: 5, crash_restarts: 2, platform_losses: 3 });
  assert.deepEqual(counts(0, exit({ cause: "sandbox_lost", platform_losses: 1 })), { restarts: 1, crash_restarts: 0, platform_losses: 1 });
  // Carried onto an ending the run reached afterwards, which still says so.
  assert.deepEqual(counts(1, exit({ cause: "exit", final: true, returncode: 0, platform_losses: 2 })), { restarts: 3, crash_restarts: 1, platform_losses: 2 });
  // Anything that is not a positive whole number is no loss.
  for (const bad of [-1, 1.5, "2", null, true, Number.NaN]) {
    assert.deepEqual(counts(1, exit({ cause: "sandbox_lost", platform_losses: bad })), { restarts: 1, crash_restarts: 1, platform_losses: 0 }, String(bad));
  }
});

test("the run's time limit: the smaller of the manifest's and the request's grant; the stop grace bounded", () => {
  const m = (sec?: number) => ({ limits: sec === undefined ? undefined : { max_runtime_sec: sec } }) as unknown as AppManifestV1;
  assert.equal(appRunMaxRuntimeSec(m(3600), { grant: { max_runtime_sec: 7200 } }), 3600);
  assert.equal(appRunMaxRuntimeSec(m(7200), { grant: { max_runtime_sec: 1800 } }), 1800);
  assert.equal(appRunMaxRuntimeSec(m(), { grant: { max_runtime_sec: 900 } }), 900);
  assert.equal(appRunMaxRuntimeSec(m(600), {}), 600);
  assert.equal(appRunMaxRuntimeSec(m(600), undefined), 600);
  assert.equal(appRunMaxRuntimeSec(m(), {}), undefined);
  // A request the grant would not take (zero, a fraction) does not set it.
  assert.equal(appRunMaxRuntimeSec(m(600), { grant: { max_runtime_sec: 0 } }), 600);
  assert.equal(appRunMaxRuntimeSec(m(), { grant: { max_runtime_sec: 1.5 } }), undefined);
  assert.equal(appStopGraceSec({}), 900);
  assert.equal(appStopGraceSec({ stop_grace_sec: 5 }), 5);
  assert.equal(appStopGraceSec({ stop_grace_sec: 99_999 }), APP_MAX_STOP_GRACE_SEC);
});
