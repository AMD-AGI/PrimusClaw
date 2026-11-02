// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a sandbox's environment holds of its owner's keys, for a session that acts as a user's GitHub account.
 *
 * Its model reads what strangers wrote and can print whatever the sandbox's environment holds, so a request marked
 * `withhold_sandbox_keys` is given a sandbox with none of the caller's keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * `SAFE_API_KEY`), while the workload is still created and owned with the caller's key. This is the SaFE half; the
 * kubernetes half is ensure-hands-acting-session-keys-k8s.test.ts. Both drive the real `ensureHands` and read what the
 * provider was handed, which is what a sandbox is built from: an ordinary request is run beside each, so that a test
 * that cannot see a key at all (a renamed variable) fails here instead of passing for want of one.
 */
import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import { ensureHands, bindSandboxReuseEffects } from "../src/sandbox/ensure-hands.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { HANDS_ENV_PAYLOAD_ENV } from "../src/sandbox/bootstrap.js";
import type { SandboxCreateParams, SandboxProvider } from "../src/sandbox/provider.js";
import type { ExecuteRequest } from "@claw/protocol";
import { bindDagHandles } from "./support/dag-handle-kv.js";

before(bindDagHandles);

const PLATFORM_KEY = "ak-owner-platform-key-0001";
const KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SAFE_API_KEY"];

let restores: Array<() => void> = [];
let realFetch: typeof globalThis.fetch;
afterEach(() => {
  for (const r of restores.reverse()) if (typeof r === "function") r();
  restores = [];
  if (realFetch) globalThis.fetch = realFetch;
});

function echoKv(): KV {
  let stored: Uint8Array | null = null;
  return {
    async get(key: string) { return stored && key.startsWith("hands.") ? { key, value: stored, revision: 1 } : null; },
    async put(_key: string, value: Uint8Array) { stored = value; return 1; },
    async update(_key: string, value: Uint8Array) { stored = value; return 2; },
    async delete() {},
  } as unknown as KV;
}

/**
 * What the provider was asked to create, and the environment file the bootstrap delivers to Hands: the two places a sandbox's
 * environment travels (the file is the one a warm pool needs, and is decoded here from the execute request's `env`).
 */
async function sandboxEnvOf(request: Partial<ExecuteRequest>): Promise<{ created: SandboxCreateParams; handsEnvFile: Record<string, string> }> {
  bindHandsKv(echoKv());
  const seen: { created?: SandboxCreateParams; handsEnvFile?: Record<string, string> } = {};
  const provider = {
    kind: "safe-workload",
    async create(params: SandboxCreateParams) {
      seen.created = params;
      return { provider: "safe-workload", id: "wl-created", sandboxName: "wl-created", namespace: "ns-test", handsBaseUrl: "", platformKey: PLATFORM_KEY };
    },
    async exec(_inst: unknown, _cmd: string, _timeout: unknown, _signal: unknown, opts?: { env?: Record<string, string> }) {
      const payload = opts?.env?.[HANDS_ENV_PAYLOAD_ENV];
      if (payload) seen.handsEnvFile = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Record<string, string>;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async stop() {},
  } as unknown as SandboxProvider;
  restores.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
  restores.push(bindSandboxReuseEffects({ registerSandbox: () => {} }));
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const full = {
    task_id: "task-acting", session_id: "sess-acting", llm_api_key: "sk-owner-virtual-key-0001",
    sandbox_spec: { handle: "main", image: "registry.test/img:1", resources: { cpu: "1", memory: "1Gi" } },
    ...request,
  } as unknown as ExecuteRequest;
  await ensureHands("sess-acting", full, PLATFORM_KEY, async () => {});
  assert.ok(seen.created, "the provider was asked to create the sandbox");
  assert.ok(seen.handsEnvFile, "the bootstrap delivered the environment file");
  return { created: seen.created, handsEnvFile: seen.handsEnvFile };
}

const everyEnv = (r: Awaited<ReturnType<typeof sandboxEnvOf>>): Array<Record<string, string>> => [r.created.env, r.handsEnvFile];

test("an ordinary session's sandbox is given the owner's platform key (SAFE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY), as always, in both places", async () => {
  const r = await sandboxEnvOf({});
  for (const env of everyEnv(r)) assert.deepEqual(KEY_NAMES.map((k) => env[k]), [PLATFORM_KEY, PLATFORM_KEY, PLATFORM_KEY]);
});

test("a session that acts as a user gets a sandbox with none of them, in what the provider creates or in the environment file Hands applies, and the workload is still owned with the key", async () => {
  const r = await sandboxEnvOf({ withhold_sandbox_keys: true });
  for (const env of everyEnv(r)) {
    for (const name of KEY_NAMES) assert.equal(name in env, false, `${name} is not in the sandbox's environment`);
    for (const [name, value] of Object.entries(env)) assert.ok(!value.includes(PLATFORM_KEY) && !value.includes("sk-owner-virtual-key-0001"), `${name} carries a key`);
  }
  assert.equal(r.created.platformKey, PLATFORM_KEY, "Brain still creates and owns the workload with the owner's key: it is not the sandbox's to read");
  assert.equal(r.created.env.AUTH_CLAW_TOKEN?.length, 64, "the rest of the environment is built as it always was");
  assert.equal(r.created.env.CLAW_SESSION_ID, "sess-acting");
});

test("a sandbox spec cannot plant SAFE_API_KEY in one either", async () => {
  const r = await sandboxEnvOf({
    withhold_sandbox_keys: true,
    sandbox_spec: { handle: "main", image: "registry.test/img:1", resources: { cpu: "1", memory: "1Gi" }, env: { SAFE_API_KEY: "planted" } },
  } as never);
  assert.equal("SAFE_API_KEY" in r.created.env, false);
});

test("the marker is a switch for a true value only: false and absent are an ordinary session", async () => {
  for (const marker of [false, undefined]) {
    const r = await sandboxEnvOf({ withhold_sandbox_keys: marker });
    assert.equal(r.created.env.SAFE_API_KEY, PLATFORM_KEY, String(marker));
  }
});
