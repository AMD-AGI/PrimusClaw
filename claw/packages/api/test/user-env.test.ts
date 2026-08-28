// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Unit tests for @claw/protocol user-env governance helpers + api/crypto AES
 * round-trip + mask. Covers user-env-vars-design.md v1.5 §9.1.
 *
 * Run with `pnpm --filter @claw/api test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  isUserEnvKeyAllowed,
  isClawInternalEnv,
  isBashFuncInjection,
  USER_ENV_KEY_NAME_RE,
  USER_ENV_DENY_LIST,
} from "@claw/protocol";

// ───────────────────────────── protocol helpers ─────────────────────────

test("isUserEnvKeyAllowed: accepts plain user key", () => {
  assert.equal(isUserEnvKeyAllowed("OPENAI_API_KEY"), true);
  assert.equal(isUserEnvKeyAllowed("CURSOR_API_KEY"), true);
  assert.equal(isUserEnvKeyAllowed("FOO_BAR"), true);
});

test("isUserEnvKeyAllowed: rejects deny list entries", () => {
  for (const name of USER_ENV_DENY_LIST) {
    assert.equal(isUserEnvKeyAllowed(name), false, `${name} should be denied`);
  }
});

test("isUserEnvKeyAllowed: rejects CLAW_* prefix wholesale", () => {
  assert.equal(isClawInternalEnv("CLAW_INTERNAL_SECRET"), true);
  assert.equal(isUserEnvKeyAllowed("CLAW_DEPLOY_ROOT"), false);
  assert.equal(isUserEnvKeyAllowed("CLAW_NEW_FUTURE_VAR"), false);
  assert.equal(isUserEnvKeyAllowed("CLAW_X"), false);
});

test("isUserEnvKeyAllowed: rejects BASH_FUNC_ prefix wholesale", () => {
  assert.equal(isBashFuncInjection("BASH_FUNC_x"), true);
  assert.equal(isUserEnvKeyAllowed("BASH_FUNC_my_function"), false);
});

test("isUserEnvKeyAllowed: rejects malformed key names", () => {
  assert.equal(isUserEnvKeyAllowed(""), false);
  assert.equal(isUserEnvKeyAllowed("lowercase"), false);
  assert.equal(isUserEnvKeyAllowed("1STARTS_WITH_DIGIT"), false);
  assert.equal(isUserEnvKeyAllowed("HAS-DASH"), false);
  assert.equal(isUserEnvKeyAllowed("HAS SPACE"), false);
  assert.equal(isUserEnvKeyAllowed("A".repeat(65)), false); // > 64 chars
});

test("USER_ENV_KEY_NAME_RE: regex shape sanity", () => {
  assert.match("OPENAI_API_KEY", USER_ENV_KEY_NAME_RE);
  assert.match("A", USER_ENV_KEY_NAME_RE);
  assert.match("A".repeat(64), USER_ENV_KEY_NAME_RE);
  assert.doesNotMatch("a", USER_ENV_KEY_NAME_RE);
  assert.doesNotMatch("A".repeat(65), USER_ENV_KEY_NAME_RE);
});

// ───────────────────────────── api/crypto AES round-trip ─────────────

// initUserEnvCrypto reads process.env at call time, so set + reset the env
// var per test block to verify both happy and fail paths in isolation.
const ENV_NAME = "USER_ENV_ENCRYPTION_KEY";

async function withMasterKey<T>(b64: string | null, fn: () => Promise<T>): Promise<T> {
  const before = process.env[ENV_NAME];
  if (b64 === null) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = b64;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = before;
  }
}

function freshKey(): string {
  return randomBytes(32).toString("base64");
}

test("crypto/user-env: encrypt/decrypt roundtrip", async () => {
  await withMasterKey(freshKey(), async () => {
    const mod = await import("../src/crypto/user-env.js");
    mod.initUserEnvCrypto();
    const plain = "sk-userA-secret-1234567890";
    const enc = mod.encryptUserEnvValue(plain);
    assert.notEqual(enc, plain, "ciphertext must not equal plaintext");
    const dec = mod.decryptUserEnvValue(enc);
    assert.equal(dec, plain);
  });
});

test("crypto/user-env: each PUT generates a unique nonce", async () => {
  await withMasterKey(freshKey(), async () => {
    const mod = await import("../src/crypto/user-env.js");
    mod.initUserEnvCrypto();
    const a = mod.encryptUserEnvValue("same-plaintext");
    const b = mod.encryptUserEnvValue("same-plaintext");
    assert.notEqual(a, b, "two encryptions of the same plaintext must differ (random nonce)");
  });
});

test("crypto/user-env: rejects tampered ciphertext (GCM tag mismatch)", async () => {
  await withMasterKey(freshKey(), async () => {
    const mod = await import("../src/crypto/user-env.js");
    mod.initUserEnvCrypto();
    const enc = mod.encryptUserEnvValue("hello");
    // Flip a byte in the middle of the blob (avoid version byte + nonce).
    const buf = Buffer.from(enc, "base64");
    buf[20] ^= 0x01;
    const tampered = buf.toString("base64");
    assert.throws(() => mod.decryptUserEnvValue(tampered));
  });
});

test("crypto/user-env: rejects unknown version byte", async () => {
  await withMasterKey(freshKey(), async () => {
    const mod = await import("../src/crypto/user-env.js");
    mod.initUserEnvCrypto();
    const enc = mod.encryptUserEnvValue("hello");
    const buf = Buffer.from(enc, "base64");
    buf[0] = 0xff;
    assert.throws(() => mod.decryptUserEnvValue(buf.toString("base64")));
  });
});

test("crypto/user-env: fail-fast when env var missing", async () => {
  await withMasterKey(null, async () => {
    const mod = await import("../src/crypto/user-env.js");
    assert.throws(() => mod.initUserEnvCrypto(), /not set/);
  });
});

test("crypto/user-env: fail-fast when key decodes to wrong length", async () => {
  // 16 raw bytes (b64 -> 24 chars), should be rejected (we need 32)
  await withMasterKey(randomBytes(16).toString("base64"), async () => {
    const mod = await import("../src/crypto/user-env.js");
    assert.throws(() => mod.initUserEnvCrypto(), /length is 16/);
  });
});

// ───────────────────────────── mask format ─────────────────────────

test("maskUserEnvValue: long value shows prefix/suffix", async () => {
  await withMasterKey(freshKey(), async () => {
    const mod = await import("../src/crypto/user-env.js");
    assert.equal(mod.maskUserEnvValue("sk-1234567890ab"), "sk-***90ab");
  });
});

test("maskUserEnvValue: value length 7 fully masked", async () => {
  await withMasterKey(freshKey(), async () => {
    const mod = await import("../src/crypto/user-env.js");
    assert.equal(mod.maskUserEnvValue("seven77"), "***");
  });
});

test("maskUserEnvValue: single char masked", async () => {
  await withMasterKey(freshKey(), async () => {
    const mod = await import("../src/crypto/user-env.js");
    assert.equal(mod.maskUserEnvValue("x"), "***");
  });
});

test("maskUserEnvValue: empty string masked", async () => {
  await withMasterKey(freshKey(), async () => {
    const mod = await import("../src/crypto/user-env.js");
    assert.equal(mod.maskUserEnvValue(""), "***");
  });
});
