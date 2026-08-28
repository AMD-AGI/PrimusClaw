// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Unit tests for system-env governance (system-env-design.md §9):
 *   - @claw/protocol isSystemEnvKeyAllowed + SYSTEM_ENV_EXTRA_DENY_LIST
 *   - @claw/protocol composeSandboxEnv layer precedence (system + user)
 *   - api/crypto loadSystemEnvSnapshot (decrypt + skip corrupted rows)
 *
 * Run with the api package test runner (node:test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  isSystemEnvKeyAllowed,
  isUserEnvKeyAllowed,
  SYSTEM_ENV_EXTRA_DENY_LIST,
  composeSandboxEnv,
} from "@claw/protocol";

// ───────────────────────────── isSystemEnvKeyAllowed ─────────────────────

test("isSystemEnvKeyAllowed: accepts a normal global key", () => {
  assert.equal(isSystemEnvKeyAllowed("CURSOR_API_KEY"), true);
  assert.equal(isSystemEnvKeyAllowed("MY_GLOBAL_FLAG"), true);
});

test("isSystemEnvKeyAllowed: denies SaFE-managed LLM keys (extra deny)", () => {
  assert.equal(isSystemEnvKeyAllowed("ANTHROPIC_API_KEY"), false);
  assert.equal(isSystemEnvKeyAllowed("OPENAI_API_KEY"), false);
  // but the user gate still allows them (only system is stricter here)
  assert.equal(isUserEnvKeyAllowed("ANTHROPIC_API_KEY"), true);
  assert.equal(isUserEnvKeyAllowed("OPENAI_API_KEY"), true);
});

test("isSystemEnvKeyAllowed: still allows LLM base URLs (endpoint override)", () => {
  assert.equal(isSystemEnvKeyAllowed("ANTHROPIC_BASE_URL"), true);
  assert.equal(isSystemEnvKeyAllowed("OPENAI_BASE_URL"), true);
});

test("isSystemEnvKeyAllowed: inherits all user-gate rejections", () => {
  assert.equal(isSystemEnvKeyAllowed("PATH"), false);
  assert.equal(isSystemEnvKeyAllowed("CLAW_DEPLOY_ROOT"), false);
  assert.equal(isSystemEnvKeyAllowed("BASH_FUNC_x"), false);
  assert.equal(isSystemEnvKeyAllowed("lowercase"), false);
});

test("SYSTEM_ENV_EXTRA_DENY_LIST contains exactly the two LLM keys", () => {
  assert.equal(SYSTEM_ENV_EXTRA_DENY_LIST.has("ANTHROPIC_API_KEY"), true);
  assert.equal(SYSTEM_ENV_EXTRA_DENY_LIST.has("OPENAI_API_KEY"), true);
  assert.equal(SYSTEM_ENV_EXTRA_DENY_LIST.size, 2);
});

// ───────────────────────────── composeSandboxEnv ─────────────────────────

test("composeSandboxEnv: system_env fills keys absent from base", () => {
  const env = composeSandboxEnv({
    base: {},
    systemEnv: { CURSOR_API_KEY: "sys-cursor", SYS_ONLY: "sys" },
    userEnv: {},
  });
  assert.equal(env.CURSOR_API_KEY, "sys-cursor");
  assert.equal(env.SYS_ONLY, "sys");
});

test("composeSandboxEnv: user_env overrides system_env", () => {
  const env = composeSandboxEnv({
    base: {},
    systemEnv: { CURSOR_API_KEY: "sys-cursor" },
    userEnv: { CURSOR_API_KEY: "user-cursor" },
  });
  assert.equal(env.CURSOR_API_KEY, "user-cursor");
});

test("composeSandboxEnv: system layer never overrides base (sandbox_spec / CLAW / SaFE)", () => {
  const env = composeSandboxEnv({
    base: { ANTHROPIC_API_KEY: "safe-platform-key", SANDBOX_KEY: "from-spec" },
    systemEnv: { SANDBOX_KEY: "sys-should-not-win" },
    userEnv: {},
  });
  assert.equal(env.ANTHROPIC_API_KEY, "safe-platform-key");
  assert.equal(env.SANDBOX_KEY, "from-spec");
});

test("composeSandboxEnv: system_env cannot shadow SaFE LLM keys even when base unset", () => {
  const env = composeSandboxEnv({
    base: {},
    systemEnv: { ANTHROPIC_API_KEY: "sys-anthropic", OPENAI_API_KEY: "sys-openai" },
    userEnv: {},
  });
  // both blocked by isSystemEnvKeyAllowed → never injected by the system layer
  assert.equal("ANTHROPIC_API_KEY" in env, false);
  assert.equal("OPENAI_API_KEY" in env, false);
});

test("composeSandboxEnv: user_env still cannot override CLAW internal / deny-list keys", () => {
  const env = composeSandboxEnv({
    base: { AUTH_CLAW_TOKEN: "real-token" },
    systemEnv: {},
    userEnv: { AUTH_CLAW_TOKEN: "hacked", PATH: "/evil", CLAW_X: "x" },
  });
  assert.equal(env.AUTH_CLAW_TOKEN, "real-token");
  assert.equal("PATH" in env, false);
  assert.equal("CLAW_X" in env, false);
});

test("composeSandboxEnv: skips non-string and invalid system/user entries", () => {
  const env = composeSandboxEnv({
    base: {},
    systemEnv: { GOOD: "ok", "BAD KEY": "x", NUMERIC: 5 as unknown as string },
    userEnv: { UGOOD: "ok", UNUM: 7 as unknown, "u bad": "x" } as Record<string, unknown>,
  });
  assert.equal(env.GOOD, "ok");
  assert.equal(env.UGOOD, "ok");
  assert.equal("BAD KEY" in env, false);
  assert.equal("NUMERIC" in env, false);
  assert.equal("UNUM" in env, false);
});

test("composeSandboxEnv: does not mutate its inputs", () => {
  const base = { A: "1" };
  const systemEnv = { B: "2" };
  const out = composeSandboxEnv({ base, systemEnv, userEnv: {} });
  assert.notEqual(out, base);
  assert.deepEqual(base, { A: "1" });
  assert.deepEqual(systemEnv, { B: "2" });
});

// ───────────────────────────── loadSystemEnvSnapshot ─────────────────────

const ENV_NAME = "USER_ENV_ENCRYPTION_KEY";

async function withMasterKey<T>(b64: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env[ENV_NAME];
  process.env[ENV_NAME] = b64;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = before;
  }
}

/** Minimal db stub returning a fixed row set for a single SELECT. */
function dbStub(rows: Array<{ key_name: string; key_value_enc: string }>) {
  return { query: async () => ({ rows }) };
}

test("loadSystemEnvSnapshot: decrypts all rows into a flat map", async () => {
  await withMasterKey(randomBytes(32).toString("base64"), async () => {
    const mod = await import("../src/crypto/user-env.js");
    mod.initUserEnvCrypto();
    const rows = [
      { key_name: "FOO", key_value_enc: mod.encryptUserEnvValue("foo-val") },
      { key_name: "BAR", key_value_enc: mod.encryptUserEnvValue("bar-val") },
    ];
    const map = await mod.loadSystemEnvSnapshot(dbStub(rows));
    assert.deepEqual(map, { FOO: "foo-val", BAR: "bar-val" });
  });
});

test("loadSystemEnvSnapshot: skips a corrupted row, keeps the rest", async () => {
  await withMasterKey(randomBytes(32).toString("base64"), async () => {
    const mod = await import("../src/crypto/user-env.js");
    mod.initUserEnvCrypto();
    const rows = [
      { key_name: "OK", key_value_enc: mod.encryptUserEnvValue("good") },
      { key_name: "CORRUPT", key_value_enc: "not-a-valid-blob" },
    ];
    const map = await mod.loadSystemEnvSnapshot(dbStub(rows));
    assert.deepEqual(map, { OK: "good" });
  });
});

test("loadSystemEnvSnapshot: empty table → empty map", async () => {
  await withMasterKey(randomBytes(32).toString("base64"), async () => {
    const mod = await import("../src/crypto/user-env.js");
    mod.initUserEnvCrypto();
    const map = await mod.loadSystemEnvSnapshot(dbStub([]));
    assert.deepEqual(map, {});
  });
});
