// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Kubernetes mode hands out no workspace HF_TOKEN.
 *
 * The workspace id is caller-chosen and, unlike SaFE mode, nothing in this
 * mode binds a caller to the namespace it names -- so a token here would let
 * any caller read another workspace's token from its own sandbox. Driven
 * through the real create path with a token configured for the very workspace
 * requested, so the absence is the gate and not a missing key.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KV } from "nats";
import type { SandboxProvider, SandboxCreateParams } from "../src/sandbox/provider.js";
import type { ExecuteRequest } from "@claw/protocol";

const TOKEN_DIR = mkdtempSync(join(tmpdir(), "claw-hf-token-k8s-"));
const WS = "ws-with-token";
writeFileSync(join(TOKEN_DIR, WS), "hf_K8sModeMustNotSeeThisA1b2C3");

process.env.CLAW_DEPLOY_MODE = "kubernetes";
process.env.AGENT_SANDBOX_ROUTER_URL ||= "http://router.test";
process.env.AUTH_INTERNAL_TOKEN ||= "internal-token";
process.env.SANDBOX_HF_TOKEN_DIR = TOKEN_DIR;

before(async () => {
  const { bindDagHandleKvForTest } = await import("../src/sandbox/handles.js");
  const rows: Record<string, unknown> = {};
  const revs: Record<string, number> = {};
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  bindDagHandleKvForTest({
    async get(key: string) {
      return rows[key] === undefined
        ? null
        : { key, value: enc.encode(JSON.stringify(rows[key])), revision: revs[key]!, operation: "PUT" };
    },
    async create(key: string, value: Uint8Array) {
      if (rows[key] !== undefined) throw new Error("wrong last sequence: key exists");
      rows[key] = JSON.parse(dec.decode(value)); revs[key] = 1; return 1;
    },
    async update(key: string, value: Uint8Array, rev: number) {
      if (revs[key] !== rev) throw new Error("wrong last sequence");
      rows[key] = JSON.parse(dec.decode(value)); revs[key] = rev + 1; return revs[key];
    },
    async delete(key: string) { delete rows[key]; delete revs[key]; },
    async keys() { return (async function* () { for (const k of Object.keys(rows)) yield k; })(); },
  } as never);
});

test("kubernetes mode: no HF_TOKEN even for a workspace that has one", async () => {
  const { isKubernetesMode } = await import("../src/config.js");
  assert.ok(isKubernetesMode(), "this test is meaningless outside kubernetes mode");
  const eh = await import("../src/sandbox/ensure-hands.js");
  const { bindHandsKv } = await import("../src/sandbox/registry.js");
  const { bindSandboxProviders } = await import("../src/sandbox/factory.js");
  const { readWorkspaceHfToken } = await import("../src/sandbox/workspace-hf-token.js");
  assert.ok(readWorkspaceHfToken(WS), "the key is readable, so only the mode gate can keep it out");

  let stored: Uint8Array | null = null;
  bindHandsKv({
    async get(key: string) { return stored && key.startsWith("hands.") ? { key, value: stored, revision: 1 } : null; },
    async put(_k: string, v: Uint8Array) { stored = v; return 1; },
    async update(_k: string, v: Uint8Array) { stored = v; return 2; },
    async delete() {},
  } as unknown as KV);
  let captured: SandboxCreateParams | undefined;
  const provider = {
    kind: "agent-sandbox",
    async create(params: SandboxCreateParams) {
      captured = params;
      return {
        provider: "agent-sandbox", id: "as-k8s", sandboxName: "box-k8s",
        namespace: params.namespace, handsBaseUrl: "http://box.ns.svc:9100", userId: "u",
      };
    },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async stop() {},
    async status() { return { running: true, healthy: true }; },
  } as unknown as SandboxProvider;
  const restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreEffects = eh.bindSandboxReuseEffects({ registerSandbox: () => {} } as never);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  try {
    await eh.ensureHands("sess-hf-k8s", {
      task_id: "task-hf-k8s",
      llm_api_key: "byok-key",
      workspace_id: WS,
      sandbox_spec: { handle: "main", image: "registry.test/img:1", resources: { cpu: "1", memory: "1Gi" } },
    } as unknown as ExecuteRequest, "pk", async () => {});
  } finally {
    globalThis.fetch = realFetch;
    if (typeof restoreEffects === "function") restoreEffects();
    if (typeof restoreProviders === "function") restoreProviders();
  }
  assert.ok(captured, "ensureHands must have created a sandbox");
  assert.equal(captured!.namespace, WS);
  assert.equal("HF_TOKEN" in captured!.env, false);
});
