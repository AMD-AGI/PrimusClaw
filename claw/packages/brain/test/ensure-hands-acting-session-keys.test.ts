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
 *
 * The keys are not the only thing of its owner's that a sandbox's environment holds: the owner's stored variables (the env vault, where
 * personal tokens are kept: GitHub, Hugging Face, W&B) arrive on the request as `user_env`, and the same model can print those. A marked
 * request is composed without them whatever it carries (the API sends none for such a session, and Brain does not rely on that).
 *
 * Nor are they the only credentials: the deployment's system env (admin-managed, shared tokens for tracing and the like), the sandbox
 * spec's env and the request's own env can hold some under any name. A marked sandbox keeps only the variables Brain sets for Hands to
 * run, and those are pinned here by name, so that a layer that starts reaching it again fails a test.
 */
import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import { ensureHands, bindSandboxReuseEffects, requestSpecFingerprint } from "../src/sandbox/ensure-hands.js";
import { resolveSandboxAction } from "../src/sandbox/params.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { HANDS_ENV_PAYLOAD_ENV } from "../src/sandbox/bootstrap.js";
import { seedSystemEnv } from "./support/system-env.js";
import type { SandboxCreateParams, SandboxProvider } from "../src/sandbox/provider.js";
import type { ExecuteRequest } from "@claw/protocol";
import { bindDagHandleModule, bindDagHandles } from "./support/dag-handle-kv.js";

before(bindDagHandles);

/** The deployment's system env: names a credential filter would not all know, and one that is plainly config. */
const SYSTEM = {
  GBRAIN_TOKEN: "system-planted-0001",
  LANGFUSE_SECRET_KEY: "system-planted-0002",
  LANGFUSE_PUBLIC_KEY: "system-planted-0003",
  GH_TOKEN: "system-planted-0004",
  SYSTEM_PLAIN_SETTING: "system-planted-0005",
};
before(() => seedSystemEnv(SYSTEM));

/** All that a marked sandbox's environment holds, whatever any layer carries: what Brain sets for Hands to run. */
const BRAIN_ONLY = ["AUTH_CLAW_TOKEN", "CLAW_SESSION_ID", "MCP_PORT", "SAFE_API_URL", "WORKSPACE_PATH"];

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
    // The ledger a displaced sandbox is retained in (a turn that is not served by the sandbox the session has).
    async create() { return 1; },
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

test("no layer can put a key back: the spec's env and the request's env have theirs taken out of a marked sandbox, the user's own variables are not applied at all, and all reach an ordinary one", async () => {
  const layers = {
    sandbox_spec: {
      handle: "main", image: "registry.test/img:1", resources: { cpu: "1", memory: "1Gi" },
      env: { ANTHROPIC_API_KEY: "planted-in-spec", SAFE_API_KEY: "planted-in-spec", SPEC_KEPT: "1" },
    },
    user_env: { OPENAI_API_KEY: "the-users-own", ANTHROPIC_API_KEY: "the-users-own", USER_KEPT: "1" },
    session_env: { OPENAI_API_KEY: "planted-in-session", ANTHROPIC_API_KEY: "planted-in-session", SESSION_KEPT: "1" },
  } as Partial<ExecuteRequest>;
  // Control: without the mark the layers do reach the sandbox (the request's env has the last word), so the absence below is the mark's.
  const ordinary = await sandboxEnvOf(layers);
  for (const env of everyEnv(ordinary)) {
    assert.deepEqual([env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY], ["planted-in-session", "planted-in-session"]);
  }
  for (const env of everyEnv(ordinary)) assert.deepEqual([env.SPEC_KEPT, env.USER_KEPT, env.SESSION_KEPT], ["1", "1", "1"], "control: every layer reaches it");
  const marked = await sandboxEnvOf({ ...layers, withhold_sandbox_keys: true });
  for (const env of everyEnv(marked)) {
    for (const name of KEY_NAMES) assert.equal(name in env, false, `${name} is not in the sandbox's environment`);
    for (const name of ["SPEC_KEPT", "USER_KEPT", "SESSION_KEPT"]) assert.equal(name in env, false, `${name}: no layer is applied to it at all`);
  }
});

test("a sandbox that was made with the keys is not reused for a turn that is not to have them, and one made without them is reused as any is", async () => {
  // A session's later turn finds the sandbox of an earlier one (reuse is decided by what the sandbox was built with). One built before
  // the mark existed holds the key in its environment, and cannot lose it: the next turn has to get a new one.
  const kv = echoKv();
  bindHandsKv(kv);
  const created: SandboxCreateParams[] = [];
  const provider = {
    kind: "safe-workload",
    async create(params: SandboxCreateParams) {
      created.push(params);
      return { provider: "safe-workload", id: `wl-${created.length}`, sandboxName: `wl-${created.length}`, namespace: "ns-test", handsBaseUrl: "", platformKey: PLATFORM_KEY };
    },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restores.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
  restores.push(bindSandboxReuseEffects({ registerSandbox: () => {}, probeSandboxContainer: async () => ({ verdict: "gone", reason: "test" }) } as never));
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  let turns = 0;
  const turn = (extra: Partial<ExecuteRequest>) => ensureHands("sess-reuse", {
    task_id: `task-reuse-${++turns}`, session_id: "sess-reuse", llm_api_key: "sk-owner-virtual-key-0001",
    sandbox_spec: { handle: "main", image: "registry.test/img:1", resources: { cpu: "1", memory: "1Gi" } }, ...extra,
  } as unknown as ExecuteRequest, PLATFORM_KEY, async () => {});

  await turn({});
  assert.equal(created.length, 1);
  assert.equal(created[0]!.env.SAFE_API_KEY, PLATFORM_KEY, "the first turn's sandbox holds the key");
  await turn({});
  assert.equal(created.length, 1, "control: the same request is served by the sandbox it already has");

  await turn({ withhold_sandbox_keys: true });
  assert.equal(created.length, 2, "a turn that is not to have the keys is not served by a sandbox that has them");
  assert.equal("SAFE_API_KEY" in created[1]!.env, false);
  await turn({ withhold_sandbox_keys: true });
  assert.equal(created.length, 2, "and the sandbox it was given is reused for the next one");
});

/** What an owner keeps in the env vault that is not one of the three key variables: personal tokens, under names a key filter would not know. */
const VAULT = {
  GITHUB_TOKEN: "ghp_vault_planted_0001",
  HF_TOKEN: "hf_vault_planted_0002",
  WANDB_API_KEY: "wandb_vault_planted_0003",
  MY_PRIVATE_SETTING: "vault-planted-0004",
};

test("the owner's stored variables are in an ordinary sandbox and in none of a marked one, in either place its environment travels, and what is not theirs is kept", async () => {
  const layers = {
    sandbox_spec: {
      handle: "main", image: "registry.test/img:1", resources: { cpu: "1", memory: "1Gi" },
      env: { SPEC_KEPT: "1" },
    },
    user_env: { ...VAULT },
    session_env: { SESSION_KEPT: "1" },
  } as Partial<ExecuteRequest>;
  // Control: without the mark the vault reaches both places, so that the absence below is the mark's and not a renamed variable's.
  for (const env of everyEnv(await sandboxEnvOf(layers))) {
    for (const [name, value] of Object.entries(VAULT)) assert.equal(env[name], value, `control: ${name} reaches an ordinary sandbox`);
  }
  for (const env of everyEnv(await sandboxEnvOf({ ...layers, withhold_sandbox_keys: true }))) {
    for (const name of Object.keys(VAULT)) assert.equal(name in env, false, `${name} is not in the sandbox's environment`);
    for (const [name, value] of Object.entries(env)) {
      for (const secret of Object.values(VAULT)) assert.ok(!value.includes(secret), `${name} carries a stored variable`);
    }
    assert.equal(env.CLAW_SESSION_ID, "sess-acting", "and what Brain sets for Hands to run is built as it always was");
  }
});

test("a change in the owner's stored variables is a change in an ordinary sandbox and not in a marked one: nothing was built from it", () => {
  const request = (over: Partial<ExecuteRequest>): ExecuteRequest => ({
    session_id: "s-fp", prompt: "carry on", sandbox_image: "example.io/torch:2.4", ...over,
  } as ExecuteRequest);
  const fingerprint = (r: ExecuteRequest): string => {
    const action = resolveSandboxAction(r);
    assert.equal(action.kind, "create");
    return requestSpecFingerprint(r, action as never);
  };
  assert.notEqual(fingerprint(request({ user_env: { GITHUB_TOKEN: "a" } })), fingerprint(request({ user_env: { GITHUB_TOKEN: "b" } })), "control: an ordinary sandbox is rebuilt over it");
  assert.equal(
    fingerprint(request({ user_env: { GITHUB_TOKEN: "a" }, withhold_sandbox_keys: true })),
    fingerprint(request({ user_env: { GITHUB_TOKEN: "b" }, withhold_sandbox_keys: true })),
    "a marked one is not",
  );
  assert.equal(
    fingerprint(request({ user_env: { GITHUB_TOKEN: "a" }, withhold_sandbox_keys: true })),
    fingerprint(request({ withhold_sandbox_keys: true })),
    "and a marked request that carries some is the one that carries none",
  );
});

test("the deployment's system env is in an ordinary sandbox and in none of a marked one, in either place its environment travels", async () => {
  for (const env of everyEnv(await sandboxEnvOf({}))) {
    for (const [name, value] of Object.entries(SYSTEM)) assert.equal(env[name], value, `control: ${name} reaches an ordinary sandbox`);
  }
  for (const env of everyEnv(await sandboxEnvOf({ withhold_sandbox_keys: true }))) {
    for (const name of Object.keys(SYSTEM)) assert.equal(name in env, false, `${name} is not in the sandbox's environment`);
    for (const [name, value] of Object.entries(env)) {
      for (const secret of Object.values(SYSTEM)) assert.ok(!value.includes(secret), `${name} carries a system variable`);
    }
  }
});

test("a marked sandbox holds what Brain sets for Hands to run and nothing else, whatever credentials the spec's env, the system env, the owner's variables and the request's env carry", async () => {
  const credentials = {
    GH_TOKEN: "planted-0001", GITHUB_TOKEN: "planted-0002", SAFE_API_KEY: "planted-0003", SAFE_API_SECRET: "planted-0004",
    NATS_CREDS: "planted-0005", NATS_PASSWORD: "planted-0006", ANTHROPIC_API_KEY: "planted-0007",
  };
  const layers = {
    sandbox_spec: { handle: "main", image: "registry.test/img:1", resources: { cpu: "1", memory: "1Gi" }, env: { ...credentials } },
    user_env: { ...credentials },
    session_env: { ...credentials },
  } as Partial<ExecuteRequest>;
  for (const env of everyEnv(await sandboxEnvOf(layers))) assert.equal(env.GH_TOKEN, "planted-0001", "control: they reach an ordinary one");
  for (const env of everyEnv(await sandboxEnvOf({ ...layers, withhold_sandbox_keys: true }))) {
    assert.deepEqual(Object.keys(env).sort(), BRAIN_ONLY);
    for (const [name, value] of Object.entries(env)) assert.ok(!value.startsWith("planted-") && !value.startsWith("system-planted-"), `${name} carries a layer's value`);
  }
});

/**
 * A sandbox reached by any route other than a fresh create: a DAG's `use` of a handle, a retried turn's own handle, the session's record.
 * Each of them can name a sandbox built for an ordinary turn, or by a Brain that withheld only the key variables, and so one that holds
 * the environment a marked turn must not have.
 */
async function reuseWorld(effects: Record<string, unknown> = {}) {
  restores.push(await bindDagHandleModule());
  const kv = echoKv();
  bindHandsKv(kv);
  const created: SandboxCreateParams[] = [];
  const provider = {
    kind: "safe-workload",
    async create(params: SandboxCreateParams) {
      created.push(params);
      return { provider: "safe-workload", id: `wl-${created.length}`, sandboxName: `wl-${created.length}`, namespace: "ns-test", handsBaseUrl: "", platformKey: PLATFORM_KEY };
    },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restores.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
  restores.push(bindSandboxReuseEffects({
    registerSandbox: () => {},
    probeSandboxContainer: async () => ({ verdict: "gone", reason: "test" }),
    workloadHeldByOtherDag: async () => false,
    countLiveWork: async () => ({ verdict: "clear", classes: {} }),
    ...effects,
  } as never));
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const run = (sessionId: string, over: Partial<ExecuteRequest>, multiNode?: unknown) => ensureHands(sessionId, {
    session_id: sessionId, llm_api_key: "sk-owner-virtual-key-0001",
    sandbox_spec: { handle: "main", image: "registry.test/img:1", resources: { cpu: "1", memory: "1Gi" } }, ...over,
  } as unknown as ExecuteRequest, PLATFORM_KEY, async () => {}, multiNode as never);
  return { kv, created, run };
}

test("a DAG's use of a handle serves a marked turn only when that handle was built for one", async () => {
  const { created, run } = await reuseWorld();
  await run("sess-use-ord", { task_id: "dag-use-ord" });
  await run("sess-use-act", { task_id: "dag-use-act", withhold_sandbox_keys: true });
  assert.equal(created.length, 2);
  const use = (dag: string, mark: boolean) => run(`sess-${dag}-use`, {
    task_id: `${dag}-next`, dag_root_task_id: dag, sandbox_spec: { use: "main" } as never, ...(mark ? { withhold_sandbox_keys: true } : {}),
  });
  assert.equal((await use("dag-use-ord", false)).created, false, "control: an ordinary turn uses an ordinary handle");
  await assert.rejects(use("dag-use-ord", true), /not built for a session that acts as a user/);
  assert.equal((await use("dag-use-act", true)).created, false, "a marked turn uses a handle built for one");
});

test("a retried turn's own handle serves a marked turn only when it was built for one: otherwise it is let go and a sandbox is built", async () => {
  const ordinary = await reuseWorld();
  await ordinary.run("sess-own-1", { task_id: "dag-own-ord" });
  bindHandsKv(echoKv()); // the session slot is empty: the DAG's own handle is what is left
  await ordinary.run("sess-own-2", { task_id: "dag-own-ord", withhold_sandbox_keys: true });
  assert.equal(ordinary.created.length, 2, "the ordinary sandbox the handle names is not given to the marked turn");
  assert.equal("SAFE_API_KEY" in ordinary.created[1]!.env, false);

  const marked = await reuseWorld();
  await marked.run("sess-own-3", { task_id: "dag-own-act", withhold_sandbox_keys: true });
  bindHandsKv(echoKv());
  await marked.run("sess-own-4", { task_id: "dag-own-act", withhold_sandbox_keys: true });
  assert.equal(marked.created.length, 1, "control: one built for a marked turn is reused");
});

test("the session's record serves a marked turn only on a fingerprint that matches: one recorded without a fingerprint is rebuilt", async () => {
  const stripFingerprint = async (kv: KV) => {
    const entry = await kv.get("hands.any");
    const info = JSON.parse(new TextDecoder().decode(entry!.value)) as Record<string, unknown>;
    assert.ok("specFingerprint" in info, "the record carries a fingerprint to take away");
    delete info.specFingerprint;
    await kv.put("hands.any", new TextEncoder().encode(JSON.stringify(info)));
  };
  for (const mark of [false, true]) {
    const { kv, created, run } = await reuseWorld();
    await run("sess-nofp", { task_id: "task-nofp-1", ...(mark ? { withhold_sandbox_keys: true } : {}) });
    await stripFingerprint(kv);
    await run("sess-nofp", { task_id: "task-nofp-2", ...(mark ? { withhold_sandbox_keys: true } : {}) });
    assert.equal(created.length, mark ? 2 : 1, mark ? "a marked turn is given a new sandbox" : "control: an ordinary turn reuses it, as before");
  }
});

test("a marked turn is not given a multi-node sandbox: it writes a credential no environment rule takes back", async () => {
  const { created, run } = await reuseWorld();
  const cluster = { backend: "rayjob", nodeCount: 2, serviceUrl: "http://cluster.test" };
  await assert.rejects(run("sess-mn", { task_id: "task-mn", withhold_sandbox_keys: true }, cluster), /cannot be given a multi-node sandbox/);
  assert.equal(created.length, 0);
});
