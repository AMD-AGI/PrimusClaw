// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The per-workspace HF_TOKEN reaches the sandbox env through ensureHands, and
 * only for the workspace that has one.
 *
 * Driven through `ensureHands` on the SaFE workload path, with the provider's
 * `create` capturing the env it is handed -- the env the sandbox pod gets --
 * rather than through the helper alone: the helper being right says nothing
 * about whether the create path calls it. The token directory and the mode are
 * read when config loads, so both are set before any dynamic import below.
 * The kubernetes-mode refusal is in workspace-hf-token-k8s.test.ts, since the
 * mode is fixed per process.
 */
import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KV } from "nats";
import type { SandboxProvider, SandboxCreateParams } from "../src/sandbox/provider.js";
import type { ExecuteRequest } from "@claw/protocol";

const TOKEN_DIR = mkdtempSync(join(tmpdir(), "claw-hf-token-"));
const WS_WITH = "ws-with-token";
const WS_WITHOUT = "ws-without-token";
const TOKEN = "hf_TestTokenForWorkspaceA1b2C3d4E5";
writeFileSync(join(TOKEN_DIR, WS_WITH), `${TOKEN}\n`);
// A file a hostile workspace id would try to reach from inside the mount.
const OUTSIDE = mkdtempSync(join(tmpdir(), "claw-hf-outside-"));
writeFileSync(join(OUTSIDE, "secret"), "must-not-leak");
mkdirSync(join(TOKEN_DIR, "nested"));
writeFileSync(join(TOKEN_DIR, "nested", "x"), "must-not-leak-either");

delete process.env.CLAW_DEPLOY_MODE;
process.env.SANDBOX_HF_TOKEN_DIR = TOKEN_DIR;

async function bindDagHandles(): Promise<void> {
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
}
before(bindDagHandles);

let restores: Array<(() => void) | void> = [];
let realFetch: typeof globalThis.fetch | undefined;
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

let seq = 0;
function request(workspace: string, extra: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    task_id: `task-${workspace}-${++seq}`,
    llm_api_key: "byok-key",
    workspace_id: workspace,
    sandbox_spec: {
      handle: "main",
      image: "registry.test/img:1",
      resources: { cpu: "1", memory: "1Gi" },
    },
    ...extra,
  } as unknown as ExecuteRequest;
}

/** Run the real create path and return the env the provider was handed. */
async function sandboxEnvFor(sessionId: string, req: ExecuteRequest): Promise<Record<string, string>> {
  const { isKubernetesMode } = await import("../src/config.js");
  assert.ok(!isKubernetesMode(), "this suite drives the SaFE workload path");
  const eh = await import("../src/sandbox/ensure-hands.js");
  const { bindHandsKv } = await import("../src/sandbox/registry.js");
  const { bindSandboxProviders } = await import("../src/sandbox/factory.js");
  const { resetWorkspaceHfTokenCache } = await import("../src/sandbox/workspace-hf-token.js");
  resetWorkspaceHfTokenCache();

  bindHandsKv(echoKv());
  let captured: SandboxCreateParams | undefined;
  const provider = {
    kind: "safe-workload",
    async create(params: SandboxCreateParams) {
      captured = params;
      return {
        provider: "safe-workload", id: `wl-${sessionId}`, sandboxName: `wl-${sessionId}`,
        namespace: params.namespace, handsBaseUrl: "", platformKey: "pk",
      };
    },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async stop() {},
    async status() { return { running: true, healthy: true }; },
  } as unknown as SandboxProvider;
  restores.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
  restores.push(eh.bindSandboxReuseEffects({ registerSandbox: () => {} } as never));
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

  await eh.ensureHands(sessionId, req, "pk", async () => {});
  assert.ok(captured, "ensureHands must have created a sandbox");
  assert.equal(captured!.namespace, (req as { workspace_id: string }).workspace_id);
  return captured!.env;
}

test("a workspace with a token gets HF_TOKEN in its sandbox env", async () => {
  const env = await sandboxEnvFor("sess-hf-with", request(WS_WITH));
  assert.equal(env.HF_TOKEN, TOKEN, "the trimmed Secret value for that workspace");
});

test("a workspace without a key gets no HF_TOKEN at all", async () => {
  const env = await sandboxEnvFor("sess-hf-without", request(WS_WITHOUT));
  assert.equal("HF_TOKEN" in env, false);
});

test("a session-supplied HF_TOKEN still wins over the workspace one", async () => {
  const env = await sandboxEnvFor(
    "sess-hf-override",
    request(WS_WITH, { session_env: { HF_TOKEN: "hf_SessionOwnTokenZ9y8X7w6V5" } } as Partial<ExecuteRequest>),
  );
  assert.equal(env.HF_TOKEN, "hf_SessionOwnTokenZ9y8X7w6V5");
});

test("a workspace id that is not a plain key never reads outside the mount", async () => {
  const { readWorkspaceHfToken, resetWorkspaceHfTokenCache } = await import("../src/sandbox/workspace-hf-token.js");
  resetWorkspaceHfTokenCache();
  const rel = join("..", OUTSIDE.split("/").pop()!, "secret");
  for (const ws of [rel, `../${WS_WITH}`, "nested/x", "..data", ".hidden", "", " ", "a..b", "/etc/passwd"]) {
    assert.equal(readWorkspaceHfToken(ws, TOKEN_DIR), undefined, `workspace id ${JSON.stringify(ws)}`);
  }
  assert.equal(readWorkspaceHfToken(WS_WITH, TOKEN_DIR), TOKEN, "and a plain one still reads");
});

test("disabled when no directory is configured", async () => {
  const { readWorkspaceHfToken, resetWorkspaceHfTokenCache } = await import("../src/sandbox/workspace-hf-token.js");
  resetWorkspaceHfTokenCache();
  assert.equal(readWorkspaceHfToken(WS_WITH, ""), undefined);
});

test("a rotated Secret is picked up after the cache TTL, not before", async () => {
  const { readWorkspaceHfToken, resetWorkspaceHfTokenCache } = await import("../src/sandbox/workspace-hf-token.js");
  resetWorkspaceHfTokenCache();
  const dir = mkdtempSync(join(tmpdir(), "claw-hf-rotate-"));
  writeFileSync(join(dir, "ws"), "hf_old");
  assert.equal(readWorkspaceHfToken("ws", dir, 1_000), "hf_old");
  writeFileSync(join(dir, "ws"), "hf_new");
  assert.equal(readWorkspaceHfToken("ws", dir, 1_000 + 29_000), "hf_old", "within TTL");
  assert.equal(readWorkspaceHfToken("ws", dir, 1_000 + 31_000), "hf_new", "after TTL");
  writeFileSync(join(dir, "ws"), "   \n");
  assert.equal(readWorkspaceHfToken("ws", dir, 1_000 + 62_000), undefined, "an empty key is no token");
});
