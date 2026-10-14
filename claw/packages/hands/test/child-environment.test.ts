// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A command run for the model sees the container's environment, as
 * `kubectl exec` would, minus the sandbox runtime's own configuration.
 *
 * The environment used to be rebuilt from a short list of names, so everything
 * the image declared -- library search paths, toolchain locations, runtime
 * tuning -- and everything the pod spec set for the workload was missing from
 * every command, with no error. A workload then ran with a configuration its
 * image's author never intended.
 *
 * The process environment is set before the module is imported, exactly as the
 * container runtime and Brain's launch command set it before Hands starts, and
 * the env file is applied by the import, as in production.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORK = mkdtempSync(join(tmpdir(), "claw-child-env-"));

/** What the image's config and the pod spec put in the container. */
const CONTAINER = {
  ROCPROFILER_QUEUE_INTERPOSITION: "0",
  LD_LIBRARY_PATH: "/opt/rocm/lib:/usr/local/lib",
  PYTORCH_ROCM_ARCH: "gfx942;gfx950",
  NCCL_SOCKET_IFNAME: "eth0",
  // Set by reference (a secretKeyRef in the pod spec) for the workload's own
  // use. It reaches the command the way it reaches `kubectl exec`; nothing here
  // copies it anywhere else.
  HF_TOKEN: "hf-by-reference-for-the-workload",
  // Overridden by the request below.
  IMAGE_DEFAULT_OVERRIDDEN: "from-the-image",
  // Set to the empty string on purpose. `kubectl exec` passes it as set, and
  // "set but empty" and "unset" mean different things to many programs.
  SET_BUT_EMPTY: "",
};

/** What Brain's launch command and the sandbox daemon set for Hands itself. */
const RUNTIME_OWNED = {
  AUTH_CLAW_TOKEN: "hands-bearer-token-no-child-may-read",
  AUTH_INTERNAL_TOKEN: "legacy-hands-token-no-child-may-read",
  MCP_PORT: "9100",
  WORKSPACE_PATH: WORK,
  BASH_MAX_TIMEOUT_SEC: "3600",
  BASH_DEFAULT_TIMEOUT_SEC: "120",
  BASH_OUTPUT_BYTES: "1048576",
  WAIT_MAX_SEC: "3600",
  WAIT_DEFAULT_SEC: "60",
  BG_SHELL_ENABLED: "false",
  BG_SHELL_REAP_GRACE_MS: "1000",
  HANDS_STATE_DIR: mkdtempSync(join(tmpdir(), "claw-child-env-state-")),
  HANDS_CHILD_ISOLATION: "unenforced",
  ENVD_AUTH_PUBLIC_KEY: "envd-public-key-material",
  ENVD_SESSION_ID_FILE: "/var/run/envd/session-id",
  // Claw's internal namespace, reserved whole as the request gate reserves it.
  CLAW_DEPLOY_MODE: "claw-internal-setting",
};

const REQUEST = {
  IMAGE_DEFAULT_OVERRIDDEN: "from-the-request",
  USER_PROJECT: "alpha",
};

const envFile = join(WORK, "hands-env.json");
writeFileSync(envFile, JSON.stringify(REQUEST));
Object.assign(process.env, CONTAINER, RUNTIME_OWNED, {
  CLAW_SESSION_ID: "sess-child-env",
  HANDS_ENV_FILE: envFile,
});

const privilege = await import("../src/runtime/child-privilege.js");
const { runForegroundShell } = await import("../src/tools/shell/process-runner.js");
const { unisolatedSandbox, releaseSandboxIsolation } = await import("./support/sandbox-isolation.js");

after(() => {
  releaseSandboxIsolation();
  rmSync(WORK, { recursive: true, force: true });
  rmSync(RUNTIME_OWNED.HANDS_STATE_DIR, { recursive: true, force: true });
});

test("the image's and the pod spec's environment reach the command", () => {
  const env = privilege.childEnvironment();
  for (const [key, value] of Object.entries(CONTAINER)) {
    if (key === "IMAGE_DEFAULT_OVERRIDDEN") continue;
    assert.equal(env[key], value, key);
  }
  assert.equal(env.CLAW_SESSION_ID, "sess-child-env");
});

test("the request's environment still wins over the image's", () => {
  const env = privilege.childEnvironment();
  assert.equal(env.IMAGE_DEFAULT_OVERRIDDEN, "from-the-request");
  assert.equal(env.USER_PROJECT, "alpha");
});

test("the runtime's own configuration and credentials do not", () => {
  const env = privilege.childEnvironment();
  for (const key of Object.keys(RUNTIME_OWNED)) {
    assert.equal(env[key], undefined, `${key} reached the command`);
  }
  assert.equal(env.HANDS_ENV_FILE, undefined);
  // And by value, over the whole environment: a token that arrived under some
  // other name would pass the check above and fail here.
  const serialised = JSON.stringify(env);
  assert.doesNotMatch(serialised, /hands-bearer-token-no-child-may-read/);
  assert.doesNotMatch(serialised, /legacy-hands-token-no-child-may-read/);
  assert.doesNotMatch(serialised, /envd-public-key-material/);
  assert.doesNotMatch(serialised, /claw-internal-setting/);
});

test("a spawned shell sees the same thing", async () => {
  unisolatedSandbox();
  const realLog = console.log;
  console.log = () => {};
  let result;
  try {
    result = await runForegroundShell("env", {
      timeoutMs: 5_000, bufferBytes: 1 << 20, owner: "sess-child-env", run: "run",
    });
  } finally {
    console.log = realLog;
  }
  assert.equal(result.exitCode, 0, result.stderr);
  const lines = new Set(result.stdout.split("\n"));
  assert.ok(lines.has("ROCPROFILER_QUEUE_INTERPOSITION=0"));
  assert.ok(lines.has(`LD_LIBRARY_PATH=${CONTAINER.LD_LIBRARY_PATH}`));
  assert.ok(lines.has("IMAGE_DEFAULT_OVERRIDDEN=from-the-request"));
  assert.ok(lines.has("SET_BUT_EMPTY="), "an empty value is a value");
  const names = new Set([...lines].map((l) => l.slice(0, l.indexOf("="))));
  for (const key of [...Object.keys(RUNTIME_OWNED), "HANDS_ENV_FILE"]) {
    assert.ok(!names.has(key), `${key} reached the shell`);
  }
  for (const value of [
    "hands-bearer-token-no-child-may-read", "legacy-hands-token-no-child-may-read",
    "envd-public-key-material", "claw-internal-setting",
  ]) {
    assert.ok(!result.stdout.includes(value), `${value} reached the shell`);
  }
  assert.ok(lines.has("CLAW_SESSION_ID=sess-child-env"));
});

test("a blank path-shaped name is left out rather than passed as nothing", () => {
  const previous = process.env.HOME;
  process.env.HOME = "";
  try {
    const env = privilege.childEnvironment();
    assert.equal("HOME" in env, false);
    assert.equal(env.SET_BUT_EMPTY, "");
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});
