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
import { HANDS_WORKLOAD_ENV_NAMES, PLATFORM_CREDENTIAL_ENV, isHandsRuntimeSetting, workloadSpecEnv } from "../src/sandbox/workload-env.js";
import { serviceOwned } from "../../hands/src/runtime/env-file.js";

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

/**
 * Hands refuses its own settings from the env file, so the container is the only way a deployment's value for one reaches it: those
 * stay in the workload, or a system env `BG_SHELL_MAX_CONCURRENT` / `BASH_OUTPUT_BYTES` would silently fall back to Hands' default.
 */
test("Hands' own runtime settings stay in the workload, by the same rule Hands refuses them from the env file", () => {
  const names = ["BG_SHELL_MAX_CONCURRENT", "BASH_OUTPUT_BYTES", "HANDS_CHILD_ISOLATION", "BASH_MAX_TIMEOUT_SEC", "WAIT_MAX_SEC",
    "ENVD_SESSION_FILE", "MCP_PORT", "WORKSPACE_PATH", "SOME_SETTING", "AUTH_CLAW_TOKEN", "HF_TOKEN"];
  for (const name of names) assert.equal(isHandsRuntimeSetting(name), serviceOwned(name) && !name.startsWith("AUTH_"), name);
  const env = { ...PLUMBING, BG_SHELL_MAX_CONCURRENT: "1", BASH_OUTPUT_BYTES: "65536", HANDS_CHILD_ISOLATION: "1", SOME_SETTING: "x" };
  assert.deepEqual(workloadSpecEnv(env), { ...PLUMBING, BG_SHELL_MAX_CONCURRENT: "1", BASH_OUTPUT_BYTES: "65536", HANDS_CHILD_ISOLATION: "1" });
});

test("a credential-looking name is not kept on the strength of a Hands prefix", () => {
  const env = { ...PLUMBING, ENVD_ACCESS_KEY: "planted", HANDS_API_TOKEN: "planted", CLAW_SECRET: "planted" };
  assert.deepEqual(workloadSpecEnv(env), PLUMBING);
});

test("the spec's own plain settings are baked into the workload; its credential-looking ones and a value another layer replaced are not", () => {
  const spec = { BOOT_MODE: "fast", API_TOKEN: "planted", CACHE_URL: "redis://u:planted@c:6379", OVERRIDDEN: "spec" };
  const env = { ...PLUMBING, ...spec, OVERRIDDEN: "planted-by-user", SYSTEM_SETTING: "planted-system" };
  assert.deepEqual(workloadSpecEnv(env, spec), { ...PLUMBING, BOOT_MODE: "fast" });
});

test("a Hands setting name set by the owner's variables or the request's env is the user's, and stays out of the workload", () => {
  const env = { ...PLUMBING, BG_SHELL_CUSTOM_VALUE: "planted-user", ENVD_CUSTOM_VALUE: "planted-session", BG_SHELL_MAX_CONCURRENT: "2" };
  assert.deepEqual(workloadSpecEnv(env, {}, ["BG_SHELL_CUSTOM_VALUE", "ENVD_CUSTOM_VALUE"]), { ...PLUMBING, BG_SHELL_MAX_CONCURRENT: "2" });
});
