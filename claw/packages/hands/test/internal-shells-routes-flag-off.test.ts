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
import { mintScopeCredential } from "@claw/utils";

process.env.WORKSPACE_PATH = tmpdir();
delete process.env.BG_SHELL_ENABLED;
process.env.AUTH_CLAW_TOKEN = "test-internal-token";
// Gates the listen at the bottom of index.ts, so importing it binds no port.
if (!process.argv.includes("--self-check")) process.argv.push("--self-check");

const { app } = await import("../src/index.js");
const { UNOWNED } = await import("../src/runtime/owner-context.js");

const { isolatingSandbox } = await import("./support/sandbox-isolation.js");
isolatingSandbox();

const TOKEN = "test-internal-token";
const proving = (owner: string, run: string | null = null) => ({
  authorization: `Bearer ${mintScopeCredential({ owner, run }, TOKEN)}`,
});

function post(url: string, headers: Record<string, string>, payload: unknown = {}) {
  return app.inject({ method: "POST", url, headers, payload: payload as object });
}

test("the active-shells route answers with the feature off", async () => {
  const res = await post("/internal/shells/active", proving("sess-off"));

  assert.equal(res.statusCode, 200,
    "the count the rollback polls to zero is unreachable with the flag off");
  assert.deepEqual(res.json(), { running: 0 });
});

test("the reap route answers with the feature off", async () => {
  const res = await post("/internal/shells/reap", proving("sess-off", "run-off"));

  assert.equal(res.statusCode, 200,
    "the rollback's termination path is unreachable with the flag off");
  assert.deepEqual(res.json(), { stopped: 0 });
});

test("both routes still authenticate with the feature off", async () => {
  for (const url of ["/internal/shells/active", "/internal/shells/reap"]) {
    assert.equal((await post(url, {})).statusCode, 401, `${url} served an unauthenticated caller`);
    // The bare sandbox token names no scope, and the flag must not restore it
    // as a way in: the rollback path keeps working, the boundary does not move.
    assert.equal((await post(url, { authorization: `Bearer ${TOKEN}` })).statusCode, 401);
  }
});

test("both routes still bind their scope to the credential with the feature off", async () => {
  // The flag must not soften the boundary either: a body field naming a scope
  // would otherwise let a rollback count and terminate somebody else's work.
  for (const url of ["/internal/shells/active", "/internal/shells/reap"]) {
    const res = await post(url, proving("sess-off", "run-off"), { owner: "sess-other" });
    assert.equal(res.statusCode, 400, `${url} read a scope out of the body`);
    assert.deepEqual(res.json(), { error: "scope_not_in_body", field: "owner" });
  }

  // A credential proving no run identity authorises no reap: that bucket holds
  // every shell started without one, which nothing may end by run.
  const reap = await post("/internal/shells/reap", proving("sess-off"));
  assert.equal(reap.statusCode, 400);
  assert.equal(reap.json().error, "run_required");

  // The shared bucket is an addressable scope like any other, by proving it.
  const named = await post("/internal/shells/active", proving(UNOWNED));
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
