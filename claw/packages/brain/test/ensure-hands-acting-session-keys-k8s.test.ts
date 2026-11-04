// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The kubernetes/BYOK half of ensure-hands-acting-session-keys.test.ts.
 *
 * There the one key is the caller's own LLM key, and it is the only credential the sandbox's environment can hold
 * (`SAFE_API_KEY` is never set in this mode). A session that acts as a user's GitHub account is given none of it
 * (`withhold_sandbox_keys`), and `ensureHands` is still handed the key to ask for the sandbox with.
 *
 * The mode is read from the environment once, when config loads, so it is set before the first import below.
 */
import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { SandboxCreateParams, SandboxProvider } from "../src/sandbox/provider.js";
import type { ExecuteRequest } from "@claw/protocol";

process.env.CLAW_DEPLOY_MODE = "kubernetes";
process.env.AGENT_SANDBOX_ROUTER_URL ||= "http://router.test";
process.env.AUTH_INTERNAL_TOKEN ||= "internal-token"; // BYOK user id is derived from it

const BYOK_KEY = "sk-owner-byok-key-0001";
const KEY_NAMES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SAFE_API_KEY"];

before(async () => (await import("./support/dag-handle-kv.js")).bindDagHandles());

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
    async get(key: string) { return stored && key.startsWith("hands.") ? { key, value: stored, revision: 1 } : null; },
    async put(_key: string, value: Uint8Array) { stored = value; return 1; },
    async update(_key: string, value: Uint8Array) { stored = value; return 2; },
    async delete() {},
  } as unknown as KV;
}

/** What the provider was asked to create, and the environment file the bootstrap delivers to Hands. */
async function sandboxEnvOf(request: Partial<ExecuteRequest>): Promise<Array<Record<string, string>>> {
  const { isKubernetesMode } = await import("../src/config.js");
  assert.ok(isKubernetesMode(), "this test is meaningless outside kubernetes mode");
  const eh = await import("../src/sandbox/ensure-hands.js");
  const { bindHandsKv } = await import("../src/sandbox/registry.js");
  const { bindSandboxProviders } = await import("../src/sandbox/factory.js");
  const { HANDS_ENV_PAYLOAD_ENV } = await import("../src/sandbox/bootstrap.js");

  bindHandsKv(echoKv());
  const seen: { created?: SandboxCreateParams; handsEnvFile?: Record<string, string> } = {};
  const provider = {
    kind: "agent-sandbox",
    async create(params: SandboxCreateParams) {
      seen.created = params;
      return { provider: "agent-sandbox", id: "as-created", sandboxName: "box-created", namespace: "ns-test", handsBaseUrl: "http://box.ns.svc:9100", userId: "u" };
    },
    async exec(_inst: unknown, _cmd: string, _timeout: unknown, _signal: unknown, opts?: { env?: Record<string, string> }) {
      const payload = opts?.env?.[HANDS_ENV_PAYLOAD_ENV];
      if (payload) seen.handsEnvFile = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Record<string, string>;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async stop() {},
    async status() { return { running: true, healthy: true }; },
  } as unknown as SandboxProvider;
  restores.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
  restores.push(eh.bindSandboxReuseEffects({ registerSandbox: () => {} } as never));
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

  const full = {
    task_id: "task-acting-k8s", session_id: "sess-acting-k8s", llm_api_key: BYOK_KEY,
    sandbox_spec: { handle: "main", image: "registry.test/img:1", resources: { cpu: "1", memory: "1Gi" } },
    ...request,
  } as unknown as ExecuteRequest;
  await eh.ensureHands("sess-acting-k8s", full, "pk", async () => {});
  assert.ok(seen.created, "the provider was asked to create the sandbox");
  return [seen.created.env, ...(seen.handsEnvFile ? [seen.handsEnvFile] : [])];
}

test("an ordinary session's sandbox is given the caller's LLM key as ANTHROPIC_API_KEY and OPENAI_API_KEY, and no SAFE_API_KEY, as always", async () => {
  const [created] = await sandboxEnvOf({});
  assert.deepEqual(KEY_NAMES.map((k) => created![k]), [BYOK_KEY, BYOK_KEY, undefined]);
});

test("a session that acts as a user gets a sandbox without the key, wherever its environment travels", async () => {
  const envs = await sandboxEnvOf({ withhold_sandbox_keys: true });
  assert.ok(envs.length >= 1);
  for (const env of envs) {
    for (const name of KEY_NAMES) assert.equal(name in env, false, `${name} is not in the sandbox's environment`);
    for (const [name, value] of Object.entries(env)) assert.ok(!value.includes(BYOK_KEY), `${name} carries the key`);
    assert.equal(env.CLAW_SESSION_ID, "sess-acting-k8s", "the rest of the environment is built as it always was");
  }
});

test("no layer can put the key back: the spec's env and the request's env have it taken out, and the user's own variables are not applied at all", async () => {
  const layers = {
    sandbox_spec: {
      handle: "main", image: "registry.test/img:1", resources: { cpu: "1", memory: "1Gi" },
      env: { ANTHROPIC_API_KEY: "planted-in-spec", SPEC_KEPT: "1" },
    },
    user_env: { OPENAI_API_KEY: "the-users-own", USER_KEPT: "1" },
    session_env: { ANTHROPIC_API_KEY: "planted-in-session", SESSION_KEPT: "1" },
  } as Partial<ExecuteRequest>;
  const [ordinary] = await sandboxEnvOf(layers);
  assert.deepEqual([ordinary!.ANTHROPIC_API_KEY, ordinary!.OPENAI_API_KEY], ["planted-in-session", "the-users-own"], "control: without the mark they reach the sandbox");
  for (const env of await sandboxEnvOf({ ...layers, withhold_sandbox_keys: true })) {
    for (const name of KEY_NAMES) assert.equal(name in env, false, `${name} is not in the sandbox's environment`);
    assert.deepEqual([env.SPEC_KEPT, env.SESSION_KEPT], ["1", "1"], "and nothing else is taken out of the layers that are applied");
    assert.equal("USER_KEPT" in env, false, "the user's own variables are not one of them: none is composed in (see the test of the stored variables)");
  }
});

test("the owner's stored variables are not in a marked sandbox either, and are in an ordinary one", async () => {
  const vault = { GITHUB_TOKEN: "ghp_vault_planted_0001", HF_TOKEN: "hf_vault_planted_0002", MY_PRIVATE_SETTING: "vault-planted-0003" };
  const layers = { user_env: { ...vault }, session_env: { SESSION_KEPT: "1" } } as Partial<ExecuteRequest>;
  const [ordinary] = await sandboxEnvOf(layers);
  for (const [name, value] of Object.entries(vault)) assert.equal(ordinary![name], value, `control: ${name} reaches an ordinary sandbox`);
  for (const env of await sandboxEnvOf({ ...layers, withhold_sandbox_keys: true })) {
    for (const name of Object.keys(vault)) assert.equal(name in env, false, `${name} is not in the sandbox's environment`);
    for (const [name, value] of Object.entries(env)) {
      for (const secret of Object.values(vault)) assert.ok(!value.includes(secret), `${name} carries a stored variable`);
    }
    assert.equal(env.SESSION_KEPT, "1", "the request's own env is not the vault");
  }
});
