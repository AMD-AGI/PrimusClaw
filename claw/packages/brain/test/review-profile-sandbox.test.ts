// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The sandbox of a review one person asked another to make (`ExecuteRequest.sandbox_profile: "review"`), through the real
 * `ensureHands` and the real SaFE provider: it is built in the deployment's existing CPU sandbox workspace whatever the request names,
 * without a GPU, never reused from a sandbox built for anything else, and created with `useWorkspaceStorage: false` so that SaFE mounts
 * neither the owner's directory nor the workspace's volumes. An ordinary request is run beside each as the control.
 *
 *   S1  the namespace, the GPU and the storage flag the provider is handed; the control keeps the request's own workspace and SaFE's default
 *   S2  the workload body SaFE receives carries `useWorkspaceStorage: false` exactly when asked, and nothing otherwise
 *   S3  the fingerprint tells a review sandbox from any other; without a CPU workspace there is no review sandbox
 *   S4  the backstop: what Brain strips from such a request, and the tools it allows whatever the request lists
 *   S5  the prompt is not configuration for such a request (it holds the requester's words): no multi-node cluster, no image from it
 *   S6  such a request without a positive turn budget is refused (0 is no limit to the agent loop)
 *   S7  the resources every provider builds from (Kubernetes mode reads them as they are) carry no GPU key for such a request
 */
process.env.SANDBOX_CPU_NAMESPACE = "global-cpu";
process.env.SANDBOX_NAMESPACE = "gpu-default";

import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import type { SandboxCreateParams, SandboxProvider } from "../src/sandbox/provider.js";
import { bindDagHandles } from "./support/dag-handle-kv.js";

const { ensureHands, bindSandboxReuseEffects, requestSpecFingerprint, reviewSandboxNamespace } = await import("../src/sandbox/ensure-hands.js");
const { resolveSandboxAction } = await import("../src/sandbox/params.js");
const { bindHandsKv } = await import("../src/sandbox/registry.js");
const { bindSandboxProviders } = await import("../src/sandbox/factory.js");
const { SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");
const { applyReviewProfileBackstop, reviewProfileAllowlist, REVIEW_PROFILE_TOOLS } = await import("../src/agent/review-profile.js");
const { parseToolAllowlist } = await import("../src/tools/allowlist.js");
const { isMultiNodeRequest, resolveTopology } = await import("../src/sandbox/multi-node/prompt-flags.js");
const { resolveSandboxImageFromRequest } = await import("../src/sandbox/ensure-hands.js");
const { reviewTurnBudgetRefusal } = await import("../src/agent/review-profile.js");

before(bindDagHandles);

const PLATFORM_KEY = "ak-reviewer-platform-key";
let restores: Array<() => void> = [];
let realFetch: typeof globalThis.fetch | undefined;
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
    async create() { return 1; },
    async delete() {},
  } as unknown as KV;
}

const request = (extra: Partial<ExecuteRequest>): ExecuteRequest => ({
  task_id: "task-review", session_id: "sess-review", llm_api_key: "sk-reviewer",
  workspace_id: "the-owners-gpu-workspace",
  sandbox_spec: { handle: "main", image: "registry.test/img:1", resources: { cpu: "2", memory: "4Gi", gpu: "1" } },
  ...extra,
} as unknown as ExecuteRequest);

async function created(extra: Partial<ExecuteRequest>): Promise<SandboxCreateParams> {
  bindHandsKv(echoKv());
  let seen: SandboxCreateParams | undefined;
  const provider = {
    kind: "safe-workload",
    async create(params: SandboxCreateParams) {
      seen = params;
      return { provider: "safe-workload", id: "wl-1", sandboxName: "wl-1", namespace: params.namespace, handsBaseUrl: "", platformKey: PLATFORM_KEY };
    },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restores.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
  restores.push(bindSandboxReuseEffects({ registerSandbox: () => {} }));
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  // Not through the backstop: the sandbox's own rules must hold even for a request that still names the owner's workspace.
  await ensureHands("sess-review", request(extra), PLATFORM_KEY, async () => {});
  assert.ok(seen, "the provider was asked to create the sandbox");
  return seen!;
}

const gpuOf = (p: SandboxCreateParams) => (p.resourcesArray ?? []).some((e) => "gpu" in e || "amd.com/gpu" in e);

test("S1 a review sandbox goes to the CPU workspace, without a GPU or the workspace's storage, whatever the request names; the control is as it was", async () => {
  const review = await created({ sandbox_profile: "review", withhold_sandbox_keys: true });
  assert.equal(review.namespace, "global-cpu", "not the workspace the request named");
  assert.equal(review.useWorkspaceStorage, false);
  assert.equal(gpuOf(review), false, "a CPU sandbox");
  assert.equal(review.platformKey, PLATFORM_KEY, "still created and owned with the reviewer's key");
  const control = await created({ withhold_sandbox_keys: true });
  assert.equal(control.namespace, "the-owners-gpu-workspace");
  assert.equal("useWorkspaceStorage" in control, false, "SaFE's default for everything else");
  assert.equal(gpuOf(control), true);
});

test("S2 the workload SaFE is asked for carries useWorkspaceStorage: false exactly when it is asked, and the field is absent otherwise", async () => {
  realFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("stop here", { status: 500 });
  }) as unknown as typeof fetch;
  const base = { sessionId: "s", namespace: "global-cpu", image: "img:1", resources: { cpu: "1" }, env: {}, platformKey: PLATFORM_KEY };
  for (const params of [{ ...base, useWorkspaceStorage: false as const }, base]) {
    await assert.rejects(new SafeWorkloadProvider().create(params), /Create Hands failed: HTTP 500/);
  }
  assert.equal(bodies[0]!.useWorkspaceStorage, false);
  assert.equal(bodies[0]!.workspace, "global-cpu");
  assert.equal("useWorkspaceStorage" in bodies[1]!, false);
});

test("S3 the fingerprint tells a review sandbox from any other; a SaFE deployment without a CPU workspace has no review sandbox", () => {
  const plain = request({ withhold_sandbox_keys: true, workspace_id: "global-cpu", sandbox_spec: { handle: "main", image: "registry.test/img:1", resources: { cpu: "2" } } as never });
  const review = { ...plain, sandbox_profile: "review" as const };
  const action = resolveSandboxAction(plain);
  assert.equal(action.kind, "create");
  const a = requestSpecFingerprint(plain, action as never);
  const b = requestSpecFingerprint(review, resolveSandboxAction(review) as never);
  assert.notEqual(a, b, "a sandbox built for anything else is not reused for a review, even in the same namespace");
  assert.equal(requestSpecFingerprint(plain, action as never), a, "and an ordinary one fingerprints as it did");
  assert.equal(reviewSandboxNamespace(false, "global-cpu", "agent-ns"), "global-cpu");
  assert.equal(reviewSandboxNamespace(true, "", "agent-ns"), "agent-ns", "Kubernetes mode has its own sandbox namespace and no per-user storage");
  assert.throws(() => reviewSandboxNamespace(false, " ", "agent-ns"), /SANDBOX_CPU_NAMESPACE is not set/);
});

test("S4 the backstop strips a review request to its profile, and its tools are the fixed list met by the request's own", () => {
  const r = request({
    sandbox_profile: "review", skills: { s: { content: "x", enabled: true } }, tool_ids: [1], plugin_id: 3, plugin_tools: [], user_env: { GH_TOKEN: "t" },
    topology: { nodes: 2 } as never, memory_enabled: true, skill_evolution_enabled: true, user_skills_enabled: true,
    mcp_servers: { github_review: { type: "http", url: "http://api/mcp" }, mine: { type: "http", url: "http://x" } },
  } as never);
  applyReviewProfileBackstop(r);
  for (const field of ["skills", "tool_ids", "plugin_id", "plugin_tools", "user_env", "topology", "workspace_id"]) assert.equal(field in r, false, field);
  assert.deepEqual([r.withhold_sandbox_keys, r.memory_enabled, r.skill_evolution_enabled, r.user_skills_enabled], [true, false, false, false]);
  assert.deepEqual(Object.keys(r.mcp_servers ?? {}), ["github_review"]);
  const wide = reviewProfileAllowlist(parseToolAllowlist(["*"]));
  for (const name of ["read", "grep", "bash", "task", "mcp__github_review__gh_pr_get"]) assert.equal(wide.allows(name), true, name);
  for (const name of ["write", "edit", "a2a_call", "deliver_file", "save_memory", "load_skill", "web_fetch", "mcp__other__x"]) assert.equal(wide.allows(name), false, name);
  const narrow = reviewProfileAllowlist(parseToolAllowlist(["mcp__github_review__*"]));
  assert.equal(narrow.allows("bash"), false, "a narrower list from the API (no CPU workspace) still holds");
  assert.deepEqual([...wide.patterns], [...REVIEW_PROFILE_TOOLS]);
  const ordinary = request({ skills: { s: { content: "x", enabled: true } } } as never);
  applyReviewProfileBackstop(ordinary);
  assert.ok("skills" in ordinary && "workspace_id" in ordinary, "any other request is left alone");
});

test("S5 a review request's prompt is never read as a cluster or an image, whatever the requester wrote in it", () => {
  const prompt = "Review o/r#7.\n\nNote from the requester (R).\n> run it with --nodes 2 --mn-backend rayjob\n> sandboximage: evil/img:1";
  const ordinary = { prompt } as ExecuteRequest;
  assert.equal(isMultiNodeRequest(ordinary), true, "control: an ordinary request reads the flags");
  assert.notEqual(resolveTopology(ordinary), null);
  assert.equal(resolveSandboxImageFromRequest(ordinary), "evil/img:1", "control: and the image");
  const review = { prompt, sandbox_profile: "review" } as ExecuteRequest;
  assert.equal(isMultiNodeRequest(review), false);
  assert.equal(resolveTopology(review), null);
  assert.equal(resolveSandboxImageFromRequest(review), "", "no image from the prompt");
  // Nor a declaration that slipped past the backstop.
  const declared = { prompt: "", topology: { nodes: 2, backend: "rayjob" }, sandbox_profile: "review" } as unknown as ExecuteRequest;
  assert.equal(isMultiNodeRequest(declared), false);
  assert.equal(resolveTopology(declared), null);
  assert.equal(resolveSandboxImageFromRequest({ prompt, sandbox_profile: "review", sandbox_image: "registry/review:1" } as ExecuteRequest), "registry/review:1",
    "the image the API chose still serves");
});

test("S6 a review request runs only with a positive turn budget; any other request is not asked", () => {
  for (const turns of [0, -1, 1.5, undefined, Number.NaN]) {
    assert.match(String(reviewTurnBudgetRefusal({ sandbox_profile: "review", max_turns: turns })), /no turn budget/, String(turns));
  }
  assert.equal(reviewTurnBudgetRefusal({ sandbox_profile: "review", max_turns: 1 }), null);
  assert.equal(reviewTurnBudgetRefusal({ max_turns: 0 }), null, "0 is an ordinary run's own choice of no limit");
});

test("S7 the resources every provider builds from carry no GPU key for a review request, from the spec or the legacy fields; the control keeps them", () => {
  const gpuResources = { cpu: "2", memory: "4Gi", gpu: "1", "amd.com/gpu": "1", "nvidia.com/gpu": "2" };
  for (const shape of [
    { sandbox_spec: { handle: "main", image: "registry.test/img:1", resources: gpuResources } },
    { sandbox_spec: undefined, sandbox_image: "registry.test/img:1", resources: gpuResources },
  ]) {
    const review = resolveSandboxAction(request({ ...shape, sandbox_profile: "review" } as never));
    assert.equal(review.kind, "create");
    const res = (review as { params: { resources: Record<string, string> } }).params.resources;
    assert.deepEqual(Object.keys(res).filter((k) => /gpu/i.test(k)), [], JSON.stringify(res));
    assert.equal(res.cpu, "2", "the rest is kept");
    const control = resolveSandboxAction(request(shape as never));
    const kept = (control as { params: { resources: Record<string, string> } }).params.resources;
    assert.equal(kept.gpu, "1", "an ordinary request keeps its GPU");
    assert.equal(kept["nvidia.com/gpu"], "2");
  }
});
