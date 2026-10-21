// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A request cannot put a name this service owns into a command's environment,
 * or into this service's own configuration, by way of the env file.
 *
 * The env file is built from `sandbox_spec.env`, `user_env` and `session_env`.
 * The request gate rejects `HANDS_*` and `CLAW_*` there, but nothing rejects
 * `BASH_OUTPUT_BYTES`, `AUTH_INTERNAL_TOKEN` or `ENVD_*` -- they look like any
 * other name. Applied to this process, `BASH_OUTPUT_BYTES` would set the output
 * cap the bash tool reads after the file is applied, and every name the file
 * applies would then be handed to the command whatever the runtime withholds.
 *
 * The launch environment is set before the module is imported and the file is
 * applied by the import, as in production.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORK = mkdtempSync(join(tmpdir(), "claw-child-env-req-"));
const STATE = mkdtempSync(join(tmpdir(), "claw-child-env-req-state-"));

/** Names the request tries to set, with values nothing else uses. */
const FROM_THE_REQUEST = {
  BASH_OUTPUT_BYTES: "7",
  AUTH_INTERNAL_TOKEN: "request-chosen-internal-token",
  ENVD_AUTH_PUBLIC_KEY: "request-chosen-envd-key",
  ENVD_SESSION_ID_FILE: "/request/chosen/session-file",
  CLAW_INTERNAL_FLAG: "request-chosen-claw-flag",
  CLAW_SESSION_ID: "request-chosen-session",
};

const envFile = join(WORK, "hands-env.json");
writeFileSync(envFile, JSON.stringify({ ...FROM_THE_REQUEST, USER_PROJECT: "alpha" }));
// The output cap is left to its default, as Brain's launch command leaves it:
// a value the file applied would be the only one there is.
delete process.env.BASH_OUTPUT_BYTES;
delete process.env.AUTH_INTERNAL_TOKEN;
Object.assign(process.env, {
  AUTH_CLAW_TOKEN: "launch-token",
  CLAW_SESSION_ID: "sess-from-launch",
  WORKSPACE_PATH: WORK,
  HANDS_STATE_DIR: STATE,
  HANDS_CHILD_ISOLATION: "unenforced",
  HANDS_ENV_FILE: envFile,
});

const envFileModule = await import("../src/runtime/env-file.js");
const privilege = await import("../src/runtime/child-privilege.js");
const { runForegroundShell } = await import("../src/tools/shell/process-runner.js");
const { unisolatedSandbox, releaseSandboxIsolation } = await import("./support/sandbox-isolation.js");

after(() => {
  releaseSandboxIsolation();
  rmSync(WORK, { recursive: true, force: true });
  rmSync(STATE, { recursive: true, force: true });
});

test("the env file applies none of this service's names", () => {
  assert.deepEqual(envFileModule.APPLIED_ENV_KEYS, ["USER_PROJECT"]);
  // Read by the bash tool after the file is applied: a value here would be the
  // request choosing how much of a command's output this service keeps.
  assert.equal(process.env.BASH_OUTPUT_BYTES, undefined);
  assert.equal(process.env.AUTH_INTERNAL_TOKEN, undefined);
  assert.equal(process.env.CLAW_SESSION_ID, "sess-from-launch");
});

test("a name the request tried to set does not reach the command", () => {
  const env = privilege.childEnvironment();
  for (const key of Object.keys(FROM_THE_REQUEST)) {
    if (key === "CLAW_SESSION_ID") continue;
    assert.equal(env[key], undefined, `${key} reached the command`);
  }
  assert.equal(env.CLAW_SESSION_ID, "sess-from-launch");
  assert.equal(env.USER_PROJECT, "alpha");
});

test("nor does it reach a spawned shell", async () => {
  unisolatedSandbox();
  const realLog = console.log;
  console.log = () => {};
  let result;
  try {
    result = await runForegroundShell("env", {
      timeoutMs: 5_000, bufferBytes: 1 << 20, owner: "sess-from-launch", run: "run",
    });
  } finally {
    console.log = realLog;
  }
  assert.equal(result.exitCode, 0, result.stderr);
  const names = new Set(result.stdout.split("\n").map((l) => l.slice(0, l.indexOf("="))));
  for (const key of Object.keys(FROM_THE_REQUEST)) {
    if (key === "CLAW_SESSION_ID") continue;
    assert.ok(!names.has(key), `${key} reached the shell`);
  }
  assert.ok(result.stdout.split("\n").includes("CLAW_SESSION_ID=sess-from-launch"));
  assert.ok(result.stdout.split("\n").includes("USER_PROJECT=alpha"));
});
