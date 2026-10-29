// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Brain's grant hooks: inject the grant into the app, revoke it at the end,
 * and ask the API to extend or re-sign it. The signing key stays on the API.
 * Bound at startup when the sandbox grant URL is configured.
 */
import {
  GRANT_CALL_TIMEOUT_MS, GRANT_REVOKE_TIMEOUT_MS, SandboxGrantClient, appGrantTemplates,
  clusterServiceAccountToken, grantWorkspaces,
  type AppSandboxRole, type SandboxGrantMaterial, type SandboxSpecCreate,
} from "@claw/protocol";
import { BRAIN_ID } from "../config.js";
import { apiBase, claimHeaders } from "../clients/run-claim.js";
import { bindAppRunnerExtensions } from "./app-runner-wiring.js";
import type { AppGrantRun, AppGrantRunHooks } from "./app-runner.js";

/** Replace the empty runner hooks when this process can reach the grant service. */
export function bindBrainAppGrant(): void {
  const baseUrl = process.env.AGENT_SANDBOX_GRANT_URL?.trim();
  if (!baseUrl) return;
  const reader = new SandboxGrantClient({ baseUrl, token: clusterServiceAccountToken });
  const hooks = brainGrantHooks(reader);
  bindAppRunnerExtensions({
    grant: {
      ...hooks,
      extend: (run, expiresAt) => extendThroughApi(run, expiresAt),
      reissue: (run) => reissueThroughApi(run),
    },
  });
}

/** Env, revoke, extend, and takeover re-issue. */
export function brainGrantHooks(client: SandboxGrantClient): AppGrantRunHooks {
  return {
    async env() {
      return { e2bApiUrl: envText("E2B_API_URL"), e2bSandboxUrl: envText("E2B_SANDBOX_URL") };
    },
    async revoke(run) {
      if (!run.grantId) return;
      await client.revoke(run.grantId, AbortSignal.timeout(GRANT_REVOKE_TIMEOUT_MS));
    },
    async extend(run, expiresAt) {
      const at = new Date(expiresAt);
      return client.extend(materialOf(run, at), at, AbortSignal.timeout(GRANT_CALL_TIMEOUT_MS));
    },
    inspect(run) {
      if (!run.grantId) return Promise.resolve("missing");
      return client.inspect(run.grantId, AbortSignal.timeout(GRANT_CALL_TIMEOUT_MS));
    },
    async reissue(run) {
      if (!run.grantId) throw new Error("grant id is required");
      const expiresAt = run.expiresAt ? new Date(run.expiresAt) : undefined;
      const issued = await client.issue(materialOf(run, expiresAt), AbortSignal.timeout(GRANT_CALL_TIMEOUT_MS), "reissue");
      return { keys: issued.keys, expiresAt: issued.expiresAt.toISOString() };
    },
  };
}

function materialOf(run: AppGrantRun, expiresAt?: Date): SandboxGrantMaterial {
  const image = run.sandboxSpec?.image?.trim() || run.manifest.container.image || "";
  const workspace = run.workspaceId ?? "";
  const sandboxWorkspace = sandboxWorkspaceOf(run.sandboxSpec) || workspace;
  const templates = appGrantTemplates(run.manifest, { image, sandboxWorkspace });
  return {
    grantId: run.grantId ?? "",
    appRunId: run.runId,
    sessionId: run.sessionId,
    userId: run.userId ?? "",
    platformKey: run.platformKey ?? "",
    workspaces: grantWorkspaces(workspace, sandboxWorkspace, templates),
    limits: (run.limits ?? {}) as SandboxGrantMaterial["limits"],
    templates,
    roles: run.manifest.sandbox_roles,
    expiresAt,
  };
}

/** The workspace sandbox templates run in, when admission stored one apart from the app workspace. */
function sandboxWorkspaceOf(spec: SandboxSpecCreate | null | undefined): string {
  const value = (spec as { sandbox_workspace?: unknown } | null | undefined)?.sandbox_workspace;
  return typeof value === "string" ? value.trim() : "";
}

function envText(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Ask the API to sign. The answer's keys are returned to the caller and are not logged. */
async function postSignedGrant(run: AppGrantRun, action: "extend" | "reissue", extra: Record<string, unknown>): Promise<{ keys?: Partial<Record<AppSandboxRole, string>>; expiresAt?: string }> {
  const base = apiBase();
  if (!base) throw new Error("INTERNAL_BACKEND_URL is not configured");
  if (!run.claimCount) throw new Error("claim count is required");
  const resp = await fetch(`${base}/v1/internal/app-runs/${encodeURIComponent(run.runId)}/grant/${action}`, {
    method: "POST",
    headers: claimHeaders(),
    body: JSON.stringify({ brain_id: BRAIN_ID, claim_count: run.claimCount, ...extra }),
    signal: AbortSignal.timeout(GRANT_CALL_TIMEOUT_MS),
  });
  const body = await resp.json().catch(() => null) as { expiresAt?: unknown; keys?: unknown; error?: unknown } | null;
  if (!resp.ok || typeof body?.expiresAt !== "string") {
    const code = typeof body?.error === "string" ? body.error : "";
    throw new Error(`grant ${action} answered ${resp.status}${code ? ` ${code}` : ""}`);
  }
  const keys = action === "reissue" ? keysOf(body.keys) : undefined;
  if (action === "reissue" && !keys) throw new Error(`grant reissue answered ${resp.status}`);
  return { expiresAt: body.expiresAt, keys };
}

async function extendThroughApi(run: AppGrantRun, expiresAt: string): Promise<{ expiresAt: string }> {
  const signed = await postSignedGrant(run, "extend", { expires_at: expiresAt });
  return { expiresAt: signed.expiresAt! };
}

async function reissueThroughApi(run: AppGrantRun): Promise<{ keys: Partial<Record<AppSandboxRole, string>>; expiresAt: string }> {
  if (!run.grantId) throw new Error("grant id is required");
  const signed = await postSignedGrant(run, "reissue", {});
  return { keys: signed.keys!, expiresAt: signed.expiresAt! };
}

function keysOf(value: unknown): Partial<Record<AppSandboxRole, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Partial<Record<AppSandboxRole, string>> = {};
  for (const name of ["measurement", "subrun", "dev"] as const) {
    const key = (value as Record<string, unknown>)[name];
    if (typeof key === "string" && key) out[name] = key;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
