// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What of a sandbox's composed environment goes into the SaFE workload.
 *
 * SaFE stores a workload's `env` and returns it to every caller allowed to read the workload, finished ones included, so a credential
 * written there is readable by other users of the workspace. The names below are the ones found in real Claw sandbox workloads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  hasCredentialInValue, isCredentialEnvName, PLATFORM_CREDENTIAL_ENV, workloadSpecEnv,
} from "../src/sandbox/workload-env.js";

/** Credential names seen in Claw sandbox workloads' env. */
const SEEN_CREDENTIALS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AUTH_CLAW_TOKEN", "OPENAI_API_KEY", "SAFE_API_KEY",
  "GBRAIN_TOKEN", "LANGFUSE_SECRET_KEY", "LANGFUSE_PUBLIC_KEY", "KB_STORE_TOKEN", "GH_TOKEN",
  "HYPERLOOM_SOURCE_TOKEN", "HYPERLOOM_SIGNING_KEY_PEM", "OCTO_APIKEY", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN",
  "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "GITHUB_PAT", "NATS_PASSWORD", "DATABASE_DSN", "WANDB_API_KEY",
];

/** Plain configuration seen beside them, which the workload keeps. */
const SEEN_PLAIN = {
  CLAW_SESSION_ID: "sess-1", MCP_PORT: "9100", WORKSPACE_PATH: "/workspace", SAFE_API_URL: "https://safe.example",
  ANTHROPIC_BASE_URL: "https://gw.example/anthropic", OPENAI_BASE_URL: "https://gw.example/v1", KB_STORE_URL: "https://kb.example",
  MODEL_PATH: "/models/x", NODE_TLS_REJECT_UNAUTHORIZED: "0", KEYBOARD_LAYOUT: "us", MONKEY_MODE: "1",
};

test("every credential name seen in a sandbox workload is recognised, and none of the plain settings beside them is", () => {
  for (const name of SEEN_CREDENTIALS) assert.ok(isCredentialEnvName(name) || PLATFORM_CREDENTIAL_ENV.has(name), name);
  for (const name of Object.keys(SEEN_PLAIN)) assert.equal(isCredentialEnvName(name), false, name);
});

test("the workload env keeps the plain settings and drops every credential, by any of the three routes", () => {
  const env: Record<string, string> = { ...SEEN_PLAIN };
  for (const name of SEEN_CREDENTIALS) env[name] = `planted-${name}`;
  // Named for nothing secret, but the owner's stored variable or the request's own: secret by where it came from.
  env.MY_SETTING = "planted-user";
  env.SESSION_SETTING = "planted-session";
  // Named for nothing secret, with a password in its value.
  env.CACHE_URL = "redis://cache:planted-pw@cache.example:6379/0";

  const out = workloadSpecEnv(env, ["MY_SETTING", "SESSION_SETTING"]);

  assert.deepEqual(out, SEEN_PLAIN);
  for (const value of Object.values(out)) assert.ok(!value.includes("planted"), value);
  assert.ok("ANTHROPIC_API_KEY" in env, "the composed environment itself is left alone: Hands still gets all of it");
});

test("a URL is a credential only when it carries a password", () => {
  assert.equal(hasCredentialInValue("postgres://user:pw@db:5432/x"), true);
  assert.equal(hasCredentialInValue("https://token@github.com/org/repo"), false, "userinfo without a password is a name");
  assert.equal(hasCredentialInValue("https://gw.example:8443/v1"), false);
  assert.equal(hasCredentialInValue("plain"), false);
});
