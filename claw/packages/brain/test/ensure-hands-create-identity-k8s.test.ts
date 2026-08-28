// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The kubernetes/BYOK half of the same guarantee.
 *
 * `ensureHands` has two create returns, one per deployment mode, and the
 * identity on each is produced only in production. This drives the
 * agent-sandbox path; ensure-hands-create-identity.test.ts drives the SaFE
 * workload one. Both are needed: a deployment runs one of them, and the
 * mutation that drops `identity` is type-legal on either.
 *
 * The mode is read from the environment once, when config loads, so it is set
 * before the first import below -- which is why the modules come in through
 * dynamic `import()` rather than static ones.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { SandboxProvider } from "../src/sandbox/provider.js";
import type { ExecuteRequest } from "@claw/protocol";

process.env.CLAW_DEPLOY_MODE = "kubernetes";
process.env.AGENT_SANDBOX_ROUTER_URL ||= "http://router.test";
process.env.AUTH_INTERNAL_TOKEN ||= "internal-token"; // BYOK user id is derived from it

const SESSION = "sess-create-k8s";

let restores: Array<(() => void) | void> = [];
let realFetch: typeof globalThis.fetch;

afterEach(() => {
  for (const r of restores.reverse()) if (typeof r === "function") r();
  restores = [];
  if (realFetch) globalThis.fetch = realFetch;
});

function echoKv(): KV {
  let stored: Uint8Array | null = null;
  return {
    async get(key: string) {
      if (!stored || !key.startsWith("hands.")) return null;
      return { key, value: stored, revision: 1 };
    },
    async put(_key: string, value: Uint8Array) { stored = value; return 1; },
    async update(_key: string, value: Uint8Array) { stored = value; return 2; },
    async delete() {},
  } as unknown as KV;
}

const REQUEST = {
  task_id: "task-k8s",
  llm_api_key: "byok-key",
  sandbox_spec: {
    handle: "main",
    image: "registry.test/img:1",
    resources: { cpu: "1", memory: "1Gi" },
  },
} as unknown as ExecuteRequest;

test("the agent-sandbox create path returns the identity it registered", async () => {
  const { isKubernetesMode } = await import("../src/config.js");
  assert.ok(isKubernetesMode(), "this test is meaningless outside kubernetes mode");

  const eh = await import("../src/sandbox/ensure-hands.js");
  const { bindHandsKv } = await import("../src/sandbox/registry.js");
  const { bindSandboxProviders } = await import("../src/sandbox/factory.js");

  bindHandsKv(echoKv());
  const provider = {
    kind: "agent-sandbox",
    async create() {
      return {
        provider: "agent-sandbox", id: "as-created", sandboxName: "box-created",
        namespace: "ns-test", handsBaseUrl: "http://box.ns.svc:9100", userId: "u",
      };
    },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async stop() {},
    async status() { return { running: true, healthy: true }; },
  } as unknown as SandboxProvider;
  restores.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));

  let registered: unknown;
  restores.push(eh.bindSandboxReuseEffects({
    registerSandbox: (_sid: string, entry: unknown) => { registered = entry; },
  } as never));

  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

  const res = await eh.ensureHands(SESSION, REQUEST, "pk", async () => {});

  assert.ok(res.created, "the request asked for a new sandbox");
  assert.ok(registered, "create must register the sandbox it built");
  assert.deepEqual(res.identity, registered,
    "the caller has to be handed the same identity that was registered; "
    + "without it the recovery path addresses the shared session key instead");
});
