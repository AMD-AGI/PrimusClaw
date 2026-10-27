// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Brain's grant hooks: inject the grant into the app, revoke it at the end,
 * extend it, and re-sign it when the execution copy is gone.
 * Bound at startup only when a signing key is configured.
 */
import {
  GRANT_CALL_TIMEOUT_MS, GRANT_REVOKE_TIMEOUT_MS, appGrantTemplates, grantWorkspaces, openSandboxGrantClient,
  type SandboxGrantClient, type SandboxGrantMaterial, type SandboxSpecCreate,
} from "@claw/protocol";
import { bindAppRunnerExtensions } from "./app-runner-wiring.js";
import type { AppGrantRun, AppGrantRunHooks } from "./app-runner.js";

/** Replace the empty runner hooks when this process can sign grants. */
export function bindBrainAppGrant(): void {
  const client = openSandboxGrantClient();
  if (!client) return;
  bindAppRunnerExtensions({ grant: brainGrantHooks(client) });
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
