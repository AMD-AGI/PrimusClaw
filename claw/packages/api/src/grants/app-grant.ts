// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The API's grant hooks: issue before the run row exists, revoke if it does not.
 * Bound at startup only when a signing key is configured.
 */
import {
  grantWorkspaces, openSandboxGrantClient, type AppManifestV1, type SandboxGrantClient, type SandboxGrantMaterial,
} from "@claw/protocol";
import { appRunPorts, type AppGrantHooks, type AppGrantRequest, type AppGrantRun } from "../tasks/app-run.js";

/** Replace the empty issue hook when this process can sign grants. */
export function bindApiAppGrant(): void {
  const client = openSandboxGrantClient();
  if (!client) return;
  appRunPorts.grant = apiGrantHooks(client);
}

/** Issue and revoke against Agent Sandbox. */
export function apiGrantHooks(client: SandboxGrantClient): AppGrantHooks {
  return {
    async issue(run, manifest, request, signal) {
      const issued = await client.issue(materialOf(run, manifest, request), signal);
      return { keys: issued.keys, limits: { ...request.resources.grant }, expiresAt: issued.expiresAt };
    },
    async revoke(run, signal) {
      await client.revoke(run.grantId, signal);
    },
  };
}

function materialOf(run: AppGrantRun, manifest: AppManifestV1, request: AppGrantRequest): SandboxGrantMaterial {
  const templates = request.templates;
  return {
    grantId: run.grantId,
    appRunId: run.taskId,
    sessionId: run.sessionId,
    userId: run.userId,
    userName: request.userName,
    platformKey: request.platformKey ?? "",
    workspaces: grantWorkspaces(request.resources.workspace, request.resources.sandboxWorkspace, templates),
    limits: request.resources.grant,
    templates,
    roles: manifest.sandbox_roles,
  };
}
