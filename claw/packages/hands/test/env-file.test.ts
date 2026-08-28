// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How the user's environment reaches a sandbox that was built before the user
 * was known.
 *
 * It used to travel one way only: as part of the pod spec, written when the
 * pod was created. That is sound while every pod is created for the request it
 * serves, and it is precisely what a warm pool cannot do -- a pooled pod exists
 * before anyone knows whose request it will take, and a running pod's
 * environment cannot be changed afterwards. So `AGENT_SANDBOX_WARM_POOL_SIZE`
 * has been pinned to 0, not because the pool does not work but because pods
 * from it would have come up healthy and without the user's credentials.
 *
 * Bootstrap reaches into the sandbox after the request is known. That is late
 * enough, so the environment goes with it, and this process applies it to
 * itself -- which is what every shell a tool spawns inherits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyEnvFile } from "../src/runtime/env-file.js";

const dir = mkdtempSync(join(tmpdir(), "hands-env-"));
let seq = 0;

/** Write a handover file the way Brain's bootstrap does. */
function handover(env: Record<string, string>): string {
  const path = join(dir, `env-${++seq}.json`);
  writeFileSync(path, JSON.stringify(env));
  return path;
}

test("the user's environment lands in this process, where spawned shells inherit it", () => {
  const path = handover({ HF_TOKEN: "hf-secret", MY_PROJECT: "alpha" });
  const applied = applyEnvFile(path);

  assert.equal(process.env.HF_TOKEN, "hf-secret");
  assert.equal(process.env.MY_PROJECT, "alpha");
  assert.deepEqual(applied.sort(), ["HF_TOKEN", "MY_PROJECT"]);
});

test("it outranks whatever a pooled pod's template happened to set", () => {
  // The case the mechanism exists for: a warm pod carries the template's
  // defaults, and the request's own values must win over them.
  process.env.ANTHROPIC_API_KEY = "from-the-template";
  applyEnvFile(handover({ ANTHROPIC_API_KEY: "the-caller-s-key" }));

  assert.equal(process.env.ANTHROPIC_API_KEY, "the-caller-s-key");
});

test("but it cannot overrule how this process was launched", () => {
  // These are decided by the launch command, after the file was written. A
  // stale token in the file would leave Hands rejecting the Brain that
  // started it, and a different port would leave it listening where nobody
  // is calling.
  process.env.AUTH_CLAW_TOKEN = "the-live-token";
  process.env.MCP_PORT = "9100";
  applyEnvFile(handover({ AUTH_CLAW_TOKEN: "stale", MCP_PORT: "1234", BG_SHELL_ENABLED: "true" }));

  assert.equal(process.env.AUTH_CLAW_TOKEN, "the-live-token");
  assert.equal(process.env.MCP_PORT, "9100");
});

test("values survive newlines, quotes and shell metacharacters", () => {
  // Why the handover is JSON rather than a KEY=VALUE file the shell sources:
  // a private key is multi-line, and `$(...)` in a password would otherwise
  // be executed rather than passed on.
  const key = "-----BEGIN KEY-----\nline two $(whoami) `id`\n-----END KEY-----";
  applyEnvFile(handover({ SSH_KEY: key, ODD: 'a"b\'c $HOME' }));

  assert.equal(process.env.SSH_KEY, key);
  assert.equal(process.env.ODD, 'a"b\'c $HOME');
});

test("the file is removed once read", () => {
  const path = handover({ SOMETHING: "x" });
  applyEnvFile(path);
  assert.equal(existsSync(path), false, "no reason to leave secrets sitting in the filesystem");
});

test("no file means no change, which is the pre-warm-pool arrangement", () => {
  assert.deepEqual(applyEnvFile(undefined), []);
  assert.deepEqual(applyEnvFile(""), []);
});

test("an unreadable handover leaves Hands running rather than refusing to start", () => {
  // A run that needed one of these values then fails on the value, which is
  // diagnosable; a sandbox that never came up is reported as a sandbox
  // failure and sends the reader somewhere else entirely.
  const path = join(dir, "not-there.json");
  assert.deepEqual(applyEnvFile(path), []);

  const bad = join(dir, "corrupt.json");
  writeFileSync(bad, "{not json");
  chmodSync(bad, 0o600);
  assert.deepEqual(applyEnvFile(bad), []);
});

test("non-string values are skipped rather than coerced", () => {
  applyEnvFile(handover({ GOOD: "1", BAD: 2 as unknown as string }));
  assert.equal(process.env.GOOD, "1");
  assert.equal(process.env.BAD, undefined);
});
