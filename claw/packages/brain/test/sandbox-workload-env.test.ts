// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What of a sandbox's composed environment goes into the SaFE workload.
 *
 * SaFE stores a workload's `env` and returns it to every caller allowed to read the workload, finished ones included, so anything
 * written there is readable by other users of the workspace. The workload carries an allow list; the credential names below are the
 * ones found in real Claw sandbox workloads, plus one under a name no filter would guess.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HANDS_WORKLOAD_ENV_NAMES, PLATFORM_CREDENTIAL_ENV, workloadSpecEnv } from "../src/sandbox/workload-env.js";

const SEEN_CREDENTIALS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AUTH_CLAW_TOKEN", "OPENAI_API_KEY", "SAFE_API_KEY",
  "GBRAIN_TOKEN", "LANGFUSE_SECRET_KEY", "LANGFUSE_PUBLIC_KEY", "KB_STORE_TOKEN", "GH_TOKEN",
  "HYPERLOOM_SOURCE_TOKEN", "HYPERLOOM_SIGNING_KEY_PEM", "OCTO_APIKEY", "SLACK_BOT_TOKEN",
  "MINIO_SECRET_KEY", "SERVICE_CONFIG",
];

const PLUMBING = { CLAW_SESSION_ID: "sess-1", MCP_PORT: "9100", WORKSPACE_PATH: "/workspace", SAFE_API_URL: "https://safe.example" };

test("the workload carries the plumbing Brain sets and nothing else, whatever the other names are", () => {
  const env: Record<string, string> = { ...PLUMBING, ANTHROPIC_BASE_URL: "https://gw.example", MODEL_PATH: "/m" };
  for (const name of SEEN_CREDENTIALS) env[name] = `planted-${name}`;
  const out = workloadSpecEnv(env);
  assert.deepEqual(out, PLUMBING);
  for (const value of Object.values(out)) assert.ok(!value.includes("planted"), value);
  assert.ok("ANTHROPIC_API_KEY" in env && "SERVICE_CONFIG" in env, "the composed environment is left alone: Hands still gets all of it");
});

test("a platform credential is never carried, even if an allow list named it", () => {
  const allowed = new Set([...HANDS_WORKLOAD_ENV_NAMES, ...PLATFORM_CREDENTIAL_ENV]);
  const env: Record<string, string> = { ...PLUMBING };
  for (const name of PLATFORM_CREDENTIAL_ENV) env[name] = "planted";
  assert.deepEqual(workloadSpecEnv(env, allowed), PLUMBING);
});
