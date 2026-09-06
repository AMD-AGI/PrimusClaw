// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The termination path survives the flag being turned off.
 *
 * Rollback disables `BG_SHELL_ENABLED` while shells started under the previous
 * configuration are still running, and every step after that reads or ends them
 * through these two routes. If either were put behind the flag -- the obvious
 * change to make when removing a feature -- the rollback would lose its only
 * way to count and stop the work it is rolling back, in the one configuration
 * where it has to work.
 *
 * The spawn refusal in bg-shell-disabled.test.ts is the other half: what the
 * flag turns off is starting new shells, not reaching the ones already there.
 *
 * Separate file because the flag is read at module load and the runner gives
 * each file its own process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.WORKSPACE_PATH = tmpdir();
delete process.env.BG_SHELL_ENABLED;
process.env.AUTH_CLAW_TOKEN = "test-internal-token";
// Gates the listen at the bottom of index.ts, so importing it binds no port.
if (!process.argv.includes("--self-check")) process.argv.push("--self-check");

const { app } = await import("../src/index.js");
const { UNOWNED } = await import("../src/runtime/owner-context.js");

const AUTH = { authorization: "Bearer test-internal-token" };

function post(url: string, payload: unknown, headers: Record<string, string> = AUTH) {
  return app.inject({ method: "POST", url, headers, payload: payload as object });
}

test("the active-shells route answers with the feature off", async () => {
  const res = await post("/internal/shells/active", { owner: "sess-off" });

  assert.equal(res.statusCode, 200,
    "the count the rollback polls to zero is unreachable with the flag off");
  assert.deepEqual(res.json(), { running: 0 });
});

test("the reap route answers with the feature off", async () => {
  const res = await post("/internal/shells/reap", { run: "run-off" });

  assert.equal(res.statusCode, 200,
    "the rollback's termination path is unreachable with the flag off");
  assert.deepEqual(res.json(), { stopped: 0 });
});

test("both routes still authenticate with the feature off", async () => {
  for (const url of ["/internal/shells/active", "/internal/shells/reap"]) {
    const res = await post(url, { owner: "sess-off", run: "run-off" }, {});
    assert.equal(res.statusCode, 401, `${url} served an unauthenticated caller`);
  }
});

test("both routes still validate their argument with the feature off", async () => {
  // The flag must not soften the checks either: an owner that only reached the
  // shared bucket by failing normalization would otherwise be answered with
  // every caller's work, which is what keeps a drained sandbox alive.
  const active = await post("/internal/shells/active", {});
  assert.equal(active.statusCode, 400);
  assert.equal(active.json().error, "owner_required");

  const reap = await post("/internal/shells/reap", {});
  assert.equal(reap.statusCode, 400);
  assert.equal(reap.json().error, "run_required");

  // A caller naming the bucket deliberately is asking a real question.
  const named = await post("/internal/shells/active", { owner: UNOWNED });
  assert.equal(named.statusCode, 200);
});

test("/health reports the feature off, and the ceiling that goes with it", async () => {
  // The gate's only view into a running sandbox's configuration: the tool list
  // is identical in both switch states, so a check that reads it passes on a
  // sandbox with the feature off.
  const { MAX_TIMEOUT_SEC } = await import("../src/tools/shell/bash.js");
  const health = (await app.inject({ method: "GET", url: "/health" })).json();

  assert.equal(health.bgShellEnabled, false);
  assert.equal(health.bashMaxTimeoutSec, MAX_TIMEOUT_SEC,
    "the advertised ceiling must be the one this process enforces");
});
