// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Through the real `ensureHands`: with Hands reached through a Router that runs
 * with --enable-auth, the health checks of a new sandbox and of a reused one
 * present the sandbox owner's key to the Router. The reuse runs after the
 * remembered keys are dropped, as after a Brain restart, so the key must come
 * from the registry entry, not from memory of the create.
 */
process.env.SANDBOX_ROUTER_URL = "http://router.test";
process.env.SANDBOX_HANDS_VIA_ROUTER = "true";
process.env.SANDBOX_ROUTER_AUTH_ENABLED = "true";
process.env.SANDBOX_NAMESPACE = "ns-a";

import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import type { SandboxCreateParams, SandboxProvider } from "../src/sandbox/provider.js";
import { bindDagHandles } from "./support/dag-handle-kv.js";

const { ensureHands, bindSandboxReuseEffects } = await import("../src/sandbox/ensure-hands.js");
const { bindHandsKv } = await import("../src/sandbox/registry.js");
const { bindSandboxProviders } = await import("../src/sandbox/factory.js");
const { resetRouterCredentialsForTest } = await import("../src/sandbox/sandbox-router.js");

before(bindDagHandles);

const OWNER_KEY = "ak-owner-platform-key";
let restores: Array<() => void> = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  for (const r of restores.reverse()) if (typeof r === "function") r();
  restores = [];
  globalThis.fetch = realFetch;
});

function echoKv(): KV {
  let stored: Uint8Array | null = null;
  return {
    async get(key: string) { return stored && key.startsWith("hands.") ? { key, value: stored, revision: 1 } : null; },
    async put(_key: string, value: Uint8Array) { stored = value; return 1; },
    async update(_key: string, value: Uint8Array) { stored = value; return 2; },
    async create() { return 1; },
    async delete() {},
    async *keys() {},
  } as unknown as KV;
}

const request = { task_id: "t-1", session_id: "s-1", llm_api_key: "sk-x",
  sandbox_spec: { handle: "main", image: "registry.test/img:1", resources: { cpu: "2" } } } as unknown as ExecuteRequest;

test("a new sandbox, and the same sandbox reused after a restart, are health-checked with the owner's key", async () => {
  bindHandsKv(echoKv());
  let creates = 0;
  const provider = {
    kind: "safe-workload",
    async create(params: SandboxCreateParams) {
      creates += 1;
      return { provider: "safe-workload", id: "wl-9", sandboxName: "wl-9", namespace: params.namespace, handsBaseUrl: "", platformKey: params.platformKey };
    },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async stop() {},
    async get() { return { running: true, healthy: true, state: "running" }; },
  } as unknown as SandboxProvider;
  restores.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
  restores.push(bindSandboxReuseEffects({ registerSandbox: () => {} }));

  const routed: Array<{ url: string; auth: string | null }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/invocations/proxy/")) {
      const auth = new Headers(init?.headers).get("authorization");
      routed.push({ url, auth });
      // The Router with --enable-auth: only the owner's key gets through.
      if (auth !== `Bearer ${OWNER_KEY}`) return new Response("{}", { status: 401 });
    }
    return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const first = await ensureHands("s-1", request, OWNER_KEY, async () => {});
  assert.equal(creates, 1);
  assert.match(first.handsUrl, /\/code-interpreters\/wl-9\/invocations\/proxy\/9100/);
  assert.ok(routed.length > 0, "the new sandbox was health-checked through the Router");
  assert.ok(routed.every((r) => r.auth === `Bearer ${OWNER_KEY}`), JSON.stringify(routed));

  resetRouterCredentialsForTest();
  routed.length = 0;
  const again = await ensureHands("s-1", request, OWNER_KEY, async () => {});
  assert.equal(creates, 1, "reused, not rebuilt");
  assert.equal(again.handsUrl, first.handsUrl);
  assert.ok(routed.length > 0, "the reused sandbox was health-checked through the Router");
  assert.ok(routed.every((r) => r.auth === `Bearer ${OWNER_KEY}`), JSON.stringify(routed));
});
