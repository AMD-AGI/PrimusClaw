// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The API's grant hooks: issue before the run row exists, revoke if it does not.
 * Bound at startup only when a signing key is configured.
 */
import {
  APP_SANDBOX_ROLES, appGrantTemplates, grantWorkspaces, openSandboxGrantClient,
  type AppGrantLimits, type AppManifestV1, type AppSandboxRoles, type SandboxGrantClient, type SandboxGrantMaterial,
} from "@claw/protocol";
import { readTrustedSessionCredentials } from "../auth/session-credentials.js";
import { db } from "../infra/db.js";
import { readAppRun, type AppRunView } from "../tasks/app-run-state.js";
import { appRunPorts, type AppGrantHooks, type AppGrantRequest, type AppGrantRun } from "../tasks/app-run.js";

let boundClient: SandboxGrantClient | null = null;

/** Replace the empty issue hook when this process can sign grants. */
export function bindApiAppGrant(): void {
  const client = openSandboxGrantClient();
  if (!client) return;
  boundClient = client;
  appRunPorts.grant = apiGrantHooks(client);
}

/** The API's signer, for extend and reissue that Brain asks for. */
export function appGrantSigner(): SandboxGrantClient | null {
  return boundClient;
}

/** Issue and revoke against Agent Sandbox. */
export function apiGrantHooks(client: SandboxGrantClient): AppGrantHooks {
  return {
    async issue(run, manifest, request, signal) {
      // No declared role means this run creates no child sandbox, so nothing is signed or stored.
      if (!declaredSandboxRole(manifest.sandbox_roles)) return;
      const issued = await client.issue(materialOf(run, manifest, request), signal);
      return { keys: issued.keys, limits: { ...request.resources.grant }, expiresAt: issued.expiresAt };
    },
    async revoke(run, signal) {
      await client.revoke(run.grantId, signal);
    },
  };
}

/** True when a role lists at least one template. An absent or empty map is not a grant. */
function declaredSandboxRole(roles: AppSandboxRoles | undefined): boolean {
  if (!roles) return false;
  return APP_SANDBOX_ROLES.some((role) => (roles[role]?.length ?? 0) > 0);
}

export type StoredGrantSign =
  | { ok: true; keys?: Record<string, string>; expiresAt: string }
  | { ok: false; reason: "not_configured" | "not_found" | "no_grant" | "revoked" | "no_platform_key" | "refused" };

/** Sign the same grant id again. Brain stores the returned keys. */
export async function reissueStoredGrant(taskId: string, signal?: AbortSignal): Promise<StoredGrantSign> {
  const client = boundClient;
  if (!client) return { ok: false, reason: "not_configured" };
  const loaded = await loadStoredMaterial(taskId);
  if (!loaded.ok) return loaded;
  try {
    const issued = await client.issue(loaded.material, signal, "reissue");
    return { ok: true, keys: issued.keys, expiresAt: issued.expiresAt.toISOString() };
  } catch {
    return { ok: false, reason: "refused" };
  }
}

/** Move the grant's expiry. The attestation is signed here, not in Brain. */
export async function extendStoredGrant(taskId: string, expiresAt: Date, signal?: AbortSignal): Promise<StoredGrantSign> {
  const client = boundClient;
  if (!client) return { ok: false, reason: "not_configured" };
  const loaded = await loadStoredMaterial(taskId);
  if (!loaded.ok) return loaded;
  try {
    const extended = await client.extend(loaded.material, expiresAt, signal);
    return { ok: true, expiresAt: extended.expiresAt };
  } catch {
    return { ok: false, reason: "refused" };
  }
}

async function loadStoredMaterial(taskId: string): Promise<{ ok: true; material: SandboxGrantMaterial } | Exclude<StoredGrantSign, { ok: true }>> {
  const run = await readAppRun(taskId);
  if (!run) return { ok: false, reason: "not_found" };
  if (!run.grant_id) return { ok: false, reason: "no_grant" };
  if (run.grant_revoked_at) return { ok: false, reason: "revoked" };
  const platformKey = await platformKeyForSession(run.session_id);
  if (!platformKey) return { ok: false, reason: "no_platform_key" };
  try {
    return { ok: true, material: materialForStoredRun(run, platformKey) };
  } catch {
    return { ok: false, reason: "refused" };
  }
}

/** The issue body Brain used to sign itself, rebuilt from the stored run. */
function materialForStoredRun(run: AppRunView, platformKey: string): SandboxGrantMaterial {
  const manifest = run.manifest as unknown as AppManifestV1;
  const spec = run.sandbox_spec;
  const image = textOf(spec, "image") || manifest.container?.image || "";
  const workspace = run.workspace_id ?? "";
  const sandboxWorkspace = textOf(spec, "sandbox_workspace") || workspace;
  const templates = appGrantTemplates(manifest, { image, sandboxWorkspace });
  return {
    grantId: run.grant_id ?? "",
    appRunId: run.run_id,
    sessionId: run.session_id,
    userId: run.user_id ?? "",
    platformKey,
    workspaces: grantWorkspaces(workspace, sandboxWorkspace, templates),
    limits: (run.grant_limits ?? {}) as AppGrantLimits,
    templates,
    roles: manifest.sandbox_roles,
    expiresAt: run.grant_expires_at ? new Date(run.grant_expires_at) : undefined,
  };
}

async function platformKeyForSession(sessionId: string): Promise<string> {
  const r = await db.query("SELECT config FROM claw_sessions WHERE session_id = $1", [sessionId]);
  if (r.rowCount === 0) return "";
  return readTrustedSessionCredentials(r.rows[0].config).platformKey;
}

function textOf(spec: Record<string, unknown> | null, key: string): string {
  const value = spec?.[key];
  return typeof value === "string" ? value.trim() : "";
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
