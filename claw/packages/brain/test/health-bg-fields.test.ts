// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/health`'s two background-shell fields are the rollout gates' only reading
 * of a running Brain, and they have to be the numbers a sandbox was given.
 *
 * The gates compare Brain's `bashForegroundMaxSec` against the sandbox's own
 * `bashMaxTimeoutSec` and stop the rollout when they differ. A `/health` that
 * reported the raw setting, or a flag of its own, would make that comparison
 * agree with itself and disagree with the sandbox -- and the gate would pass
 * while the schema promised one limit against a process enforcing another.
 *
 * The payload is built inside the server bootstrap and is not exported, so the
 * binding is read from the source and the values it binds are then evaluated
 * here. The enabled half is in health-bg-fields-on, because the flag is read at
 * module load and the runner gives each file its own process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BG_SHELL_ENABLED } from "../src/config.js";
import { toolTimeoutCeilingSec } from "../src/tools/hands.js";
import { handsBaseEnv } from "../src/sandbox/bootstrap.js";

const SOURCE = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

/** The `/health` payload as written, and nothing else that mentions the flag. */
function healthPayload(): string {
  const start = SOURCE.indexOf('app.get("/health"');
  assert.notEqual(start, -1, "the /health route moved");
  const end = SOURCE.indexOf("\n  }));", start);
  assert.notEqual(end, -1, "the /health payload no longer ends where it began");
  return SOURCE.slice(start, end);
}

/** What `handsBaseEnv` forwards, as the sandbox will parse it. */
function forwarded(): Record<string, string> {
  return Object.fromEntries(
    handsBaseEnv("s-1", "9100", "tok").split(" ").filter((p) => p.includes("=")).map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );
}

test("the payload binds both fields to the sources the sandbox is configured from", () => {
  const payload = healthPayload();

  assert.match(payload, /bgShellEnabled: BG_SHELL_ENABLED,/,
    "a second flag on this payload is a gate that can read true on a pod running false");
  assert.match(payload, /bashForegroundMaxSec: toolTimeoutCeilingSec\("bash"\),/,
    "the clamped ceiling, not the raw setting: the gate compares this number "
      + "against the one the sandbox enforces");
});

test("with the feature off, health and the sandbox are told the same two things", () => {
  const env = forwarded();

  assert.equal(String(BG_SHELL_ENABLED), env.BG_SHELL_ENABLED);
  assert.equal(String(toolTimeoutCeilingSec("bash")), env.BASH_MAX_TIMEOUT_SEC);
  assert.equal(BG_SHELL_ENABLED, false, "the shipped default, which no gate may assume away");
});
