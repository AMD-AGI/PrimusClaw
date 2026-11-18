// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The worker does not start without what it needs: one line that says why, and Python's exit statuses. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { neutralPlugins, type ModelRefusalPolicy } from "@primusclaw/personal-agent";

import { main } from "../../src/index.js";

test("the worker does not start when a secret cannot be read", async () => {
  const lines: string[] = [];
  assert.equal(await main({}, neutralPlugins(), (line) => lines.push(line)), 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /CRITICAL secrets: .*PA_ENCRYPTION_KEYS.*the worker does not start without them$/);
});

test("a setting that cannot work stops the worker with status 1 and says which", async () => {
  const lines: string[] = [];
  const env = { TEAMS_ENCRYPTION_KEYS: "x".repeat(43) + "=", OUTBOUND_MODE: "true" };
  const status = await main(env, neutralPlugins(), (line) => lines.push(line));
  assert.equal(status, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /CRITICAL the worker does not start: /);
});

test("a deployment's entry passes its plugin factory: it is called once and what it returns is what the worker is built with", async () => {
  const lines: string[] = [];
  const env = {
    TEAMS_ENCRYPTION_KEYS: "x".repeat(43) + "=",
    TEAMS_DB_PATH: ":memory:",
    PUBLIC_BASE_URL: "https://claw.example.com",
    CLAW_API_URL: "http://claw.invalid",
    SAFE_API_URL: "http://safe.invalid/api/v1",
    OUTBOUND_MODE: "direct",
    BOT_MSI_CLIENT_ID: "x",
    TEAMS_GATE_ENTRY: "1",
    GATE_RUN_ID: "main-test",
    TEAMS_GATE_CONNECTOR_URL: "http://127.0.0.1:9",
    // (with a refusal policy the fallback model may start; the on-behalf users still stop it, which ends the test)
    PERSONAL_AGENT_FALLBACK_MODEL: "backup-model",
    TEAMS_ON_BEHALF_USERS: "u-coordinator",
  };
  let built = 0;
  const policy = { refusal: () => undefined } as unknown as ModelRefusalPolicy;
  const status = await main(
    env,
    () => {
      built += 1;
      return { modelRefusalPolicy: policy };
    },
    (line) => lines.push(line),
  );
  assert.equal(built, 1);
  assert.equal(status, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /CRITICAL the worker does not start: TEAMS_ON_BEHALF_USERS/);
});
