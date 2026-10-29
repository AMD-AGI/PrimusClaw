// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSandboxEnv } from "@claw/protocol";
import { applyPlatformKeyEnv } from "../src/sandbox/params.js";

const KEY = "ak-caller-platform-key";

// Mirrors the order ensureHands uses: base (spec env + platform key), then the
// system/user/session layers through composeSandboxEnv.
function compose(opts: { k8s: boolean; spec?: Record<string, string>; userEnv?: Record<string, string>;
  systemEnv?: Record<string, string>; sessionEnv?: Record<string, string>; key?: string | undefined }) {
  const base: Record<string, string> = { ...(opts.spec ?? {}), AUTH_CLAW_TOKEN: "t" };
  applyPlatformKeyEnv(base, "key" in opts ? opts.key : KEY, opts.k8s);
  return composeSandboxEnv({ base, systemEnv: opts.systemEnv, userEnv: opts.userEnv, sessionEnv: opts.sessionEnv });
}

test("safe mode: SAFE_API_KEY equals the caller's platform key", () => {
  const env = compose({ k8s: false });
  assert.equal(env.SAFE_API_KEY, KEY);
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  assert.equal(env.OPENAI_API_KEY, KEY);
});

test("kubernetes mode: SAFE_API_KEY is not injected, LLM keys still are", () => {
  const env = compose({ k8s: true, key: "byok-key" });
  assert.equal(env.SAFE_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, "byok-key");
});

test("safe mode without a key: no SAFE_API_KEY", () => {
  assert.equal(compose({ k8s: false, key: undefined }).SAFE_API_KEY, undefined);
});

test("user, session and system env cannot override SAFE_API_KEY", () => {
  const env = compose({
    k8s: false,
    userEnv: { SAFE_API_KEY: "evil-user" },
    sessionEnv: { SAFE_API_KEY: "evil-session" },
    systemEnv: { SAFE_API_KEY: "evil-system" },
  });
  assert.equal(env.SAFE_API_KEY, KEY);
});

test("user env cannot plant SAFE_API_KEY where none is injected", () => {
  assert.equal(compose({ k8s: true, userEnv: { SAFE_API_KEY: "evil" } }).SAFE_API_KEY, undefined);
});

test("a sandbox spec env cannot supply or replace SAFE_API_KEY", () => {
  assert.equal(compose({ k8s: false, spec: { SAFE_API_KEY: "spec" } }).SAFE_API_KEY, KEY);
  assert.equal(compose({ k8s: true, spec: { SAFE_API_KEY: "spec" } }).SAFE_API_KEY, undefined);
});
