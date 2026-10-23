// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Creation and admission of an app run: `POST /v1/sessions/:sessionId/tasks`
 * with `mode: "app"` (hosting design 5.3.1).
 *
 * The route owns the HTTP and Idempotency-Key handling (routes/app-run-create.ts);
 * this module owns the decisions, in the order the design gives them:
 *
 *   1. the plugin exists, the caller may use it, and its manifest is valid;
 *   2. the input is a JSON object within the manifest's size limit (its size is
 *      the only thing looked at: Claw never parses the input, it hands it to the
 *      app as it came);
 *   3. `resources` (image, gpus, workspace, cpu, memory, grant) is valid for the
 *      manifest, and the grant is clamped to the platform caps;
 *   4. every workspace `resources` names exists and the caller may use it;
 *   5. the session has no other unfinished app run.
 *
 * Checks 1-4 read only, and run before any transaction is opened. Check 5 and
 * the writes run inside `withAdmissionTransaction`, so a refusal at any point
 * leaves no `claw_tasks` row and no `claw_app_runs` row behind.
 *
 * Nothing here executes the app. After this commits the task is dispatched as
 * any other and Brain, which does not run apps yet, refuses it as not
 * implemented.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  APP_GPU_RESOURCE,
  APP_SANDBOX_ROLES,
  appGrantTemplates,
  resolveAppResources,
  validateAppManifest,
  type AppGrantLimits,
  type AppManifestIssue,
  type AppManifestV1,
  type AppResourcesIssue,
  type AppSandboxRole,
  type ResolvedAppResources,
} from "@claw/protocol";
import { APP_RUNS_ENABLED, APP_SANDBOX_CAPS, SAFE_API_URL } from "../config.js";
import { isAdmin, type UserInfo } from "../auth/models.js";
import { MissingPlatformKeyError, stampSessionCredentials } from "../auth/session-credentials.js";
import { newMcpToken, sealAppRunSecret } from "../crypto/app-run-secrets.js";
import { db } from "../infra/db.js";
import { canViewPlugin } from "../marketplace/plugins.js";
import pino from "pino";
import { withAdmissionTransaction } from "./admission.js";
import { createSingleTask, isCreateRefusal, isTopologyRefusal } from "./dag-expander.js";
import { ulid } from "./ids.js";

const logger = pino({ name: "app-run" });

/** Applied when the manifest sets no `limits.input_max_bytes`. */
export const APP_INPUT_MAX_BYTES_DEFAULT = 1024 * 1024;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** What the grant hook is told about the run it is issuing for. */
export interface AppGrantRun {
  /** Generated before the transaction; the same on every retry of one Idempotency-Key. */
  grantId: string;
  taskId: string;
  sessionId: string;
  userId: string;
  pluginId: number;
}

/** What an issued grant leaves on the run. */
export interface AppGrantIssued {
  /** The grant's keys, by role. Sealed before they are written. */
  keys?: Partial<Record<AppSandboxRole, string>>;
  /** The limits actually granted (no keys). */
  limits?: Record<string, unknown>;
  expiresAt?: Date | string | null;
}

/** What the grant is issued from: the run's effective resources and the templates it hands over. */
export interface AppGrantRequest {
  /** Validated, defaulted and clamped; `resources.grant` is what to issue. */
  resources: ResolvedAppResources;
  /** The manifest's templates, with the run's image and workspace filled in where a template sets none. */
  templates: Array<Record<string, unknown>>;
}

/**
 * Grant hook points (sandbox-layering #4). Only `issue` exists here; `env`,
 * `extend` and `revoke` belong to the places that call them and arrive with
 * those callers.
 *
 * `issue` runs inside the creation transaction. If it throws, both rows roll
 * back and the request answers 503. The default does nothing: no grant is
 * issued and none is stored.
 */
export interface AppGrantHooks {
  issue(
    run: AppGrantRun,
    manifest: AppManifestV1,
    request: AppGrantRequest,
  ): Promise<AppGrantIssued | void>;
}

export type WorkspaceVerdict = "ok" | "not_found" | "forbidden";

/** The caller's own credentials, as presented to this API. */
export interface CallerAuth {
  authorization?: string;
  cookie?: string;
}

export class WorkspaceCheckUnavailableError extends Error {}

export interface AppRunPorts {
  enabled(): boolean;
  /** The platform caps on a grant (`APP_SANDBOX_CAPS`); an item with no cap is not capped. */
  caps(): AppGrantLimits;
  /** Whether `workspaceId` exists and `caller` may use it. Throws WorkspaceCheckUnavailableError when it cannot tell. */
  workspaceAccess(auth: CallerAuth, workspaceId: string): Promise<WorkspaceVerdict>;
  grant: AppGrantHooks;
}

/**
 * Asks SaFE, as the caller: the workspace is a SaFE object and SaFE is what
 * decides who may use it, so the caller's own credential is what gets asked,
 * never a service credential that would answer yes for everybody.
 */
export async function safeWorkspaceAccess(
  auth: CallerAuth,
  workspaceId: string,
): Promise<WorkspaceVerdict> {
  if (!SAFE_API_URL) throw new WorkspaceCheckUnavailableError("SAFE_API_URL is not configured");
  if (!auth.authorization && !auth.cookie) return "forbidden";
  const headers: Record<string, string> = {};
  if (auth.authorization) headers.authorization = auth.authorization;
  if (auth.cookie) headers.cookie = auth.cookie;
  let status: number;
  try {
    const resp = await fetch(
      `${SAFE_API_URL}/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
      { method: "GET", headers, signal: AbortSignal.timeout(5000) },
    );
    status = resp.status;
    await resp.body?.cancel().catch(() => {});
  } catch (err) {
    throw new WorkspaceCheckUnavailableError(err instanceof Error ? err.message : String(err));
  }
  if (status >= 200 && status < 300) return "ok";
  if (status === 404) return "not_found";
  if (status === 401 || status === 403) return "forbidden";
  throw new WorkspaceCheckUnavailableError(`SaFE answered ${status}`);
}

export const appRunPorts: AppRunPorts = {
  enabled: () => APP_RUNS_ENABLED,
  caps: () => APP_SANDBOX_CAPS,
  workspaceAccess: safeWorkspaceAccess,
  grant: { issue: async () => undefined },
};

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

export interface AppRunPlan {
  sandboxSpec: Record<string, unknown>;
  /** The workspace the app container lands in. */
  workspaceId: string;
  /** Every distinct workspace `resources` names, the container's first. */
  workspaceIds: string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The sandbox spec and workspaces of a run, from its resolved resources. The
 * manifest's `container.resources` are the defaults; a requested cpu or memory
 * replaces its own key and the requested GPU count replaces the GPU key.
 * Nothing here sees the input.
 */
export function planAppRun(manifest: AppManifestV1, r: ResolvedAppResources): AppRunPlan {
  const resources: Record<string, string> = { ...(manifest.container.resources ?? {}) };
  delete resources[APP_GPU_RESOURCE];
  if (r.gpus > 0) resources[APP_GPU_RESOURCE] = String(r.gpus);
  if (r.cpu !== undefined) resources.cpu = String(r.cpu);
  if (r.memoryGi !== undefined) resources.memory = `${r.memoryGi}Gi`;
  const sandboxSpec: Record<string, unknown> = { handle: "app", image: r.image, namespace: r.workspace };
  if (Object.keys(resources).length > 0) sandboxSpec.resources = resources;
  const workspaceIds = [r.workspace];
  if (!workspaceIds.includes(r.sandboxWorkspace)) workspaceIds.push(r.sandboxWorkspace);
  return { sandboxSpec, workspaceId: r.workspace, workspaceIds };
}

/** Stable per Idempotency-Key, so a retry after a rolled-back create reuses the grant. */
export function deriveGrantId(sessionId: string, idemKey: string | null): string {
  if (!idemKey) return `grt_${ulid().toLowerCase()}`;
  const h = createHash("sha256").update(`claw.app-grant/v1\n${sessionId}\n${idemKey}`).digest("hex");
  return `grt_${h.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export interface AppRunRequest {
  sessionId: string;
  user: UserInfo;
  auth: CallerAuth;
  body: { plugin_id?: unknown; input?: unknown; resources?: unknown };
  idemKey: string | null;
}

export interface AppRunOutcome {
  statusCode: number;
  response: Record<string, unknown>;
}

const refuse = (statusCode: number, error: string, extra: Record<string, unknown> = {}): AppRunOutcome => ({
  statusCode, response: { ok: false, error, ...extra },
});

class AppGrantIssueError extends Error {
  constructor(readonly cause: unknown) {
    super("grant issue failed");
  }
}

/** The run an Idempotency-Key already created in this session, if any. */
export async function findAppRunByIdempotencyKey(
  sessionId: string,
  idemKey: string,
  q: { query: typeof db.query } = db,
): Promise<string | null> {
  const r = await q.query(
    "SELECT task_id FROM claw_app_runs WHERE session_id = $1 AND idempotency_key = $2",
    [sessionId, idemKey],
  );
  return (r.rows[0]?.task_id as string | undefined) ?? null;
}

export async function activeAppRunTaskId(sessionId: string, client: PoolClient): Promise<string | null> {
  const r = await client.query(
    `SELECT r.task_id FROM claw_app_runs r JOIN claw_tasks t ON t.task_id = r.task_id
      WHERE r.session_id = $1 AND r.state <> 'ended'
        AND t.status NOT IN ('completed','failed','cancelled')
      LIMIT 1`,
    [sessionId],
  );
  return (r.rows[0]?.task_id as string | undefined) ?? null;
}

const issueText = (issues: AppManifestIssue[]) => issues.slice(0, 20);

/** Checks 1-3. A refusal is returned; success returns what the writes need. */
export async function checkAppRunRequest(
  req: AppRunRequest,
  ports: AppRunPorts = appRunPorts,
): Promise<AppRunOutcome | {
  pluginId: number; manifest: AppManifestV1; input: Record<string, unknown>;
  resolved: ResolvedAppResources; plan: AppRunPlan;
}> {
  if (!ports.enabled()) return refuse(501, "app_runs_disabled");

  const pluginId = req.body.plugin_id;
  if (typeof pluginId !== "number" || !Number.isSafeInteger(pluginId) || pluginId <= 0) {
    return refuse(400, "plugin_id_required");
  }

  // 1. The plugin, the caller's right to it, and its manifest.
  const row = (await db.query(
    `SELECT id, resource, owner_user_id, is_public FROM plugins
      WHERE id = $1 AND deleted_at IS NULL`,
    [pluginId],
  )).rows[0] as { id: string | number; resource: unknown; owner_user_id: string | null; is_public: boolean } | undefined;
  if (!row) return refuse(404, "plugin_not_found");
  if (!canViewPlugin(row as never, req.user.userId, isAdmin(req.user))) {
    return refuse(403, "plugin_access_denied");
  }
  const app = isPlainObject(row.resource) ? row.resource.app : undefined;
  const rawManifest = isPlainObject(app) ? app.manifest : undefined;
  const issues = validateAppManifest(rawManifest);
  if (issues.length > 0) return refuse(422, "app_manifest_invalid", { issues: issueText(issues) });
  const manifest = rawManifest as AppManifestV1;

  // 2. The input.
  if (!isPlainObject(req.body.input)) return refuse(400, "input_must_be_object");
  const input = req.body.input;
  const limit = manifest.limits?.input_max_bytes ?? APP_INPUT_MAX_BYTES_DEFAULT;
  const size = Buffer.byteLength(JSON.stringify(input), "utf8");
  if (size > limit) return refuse(413, "input_too_large", { max_bytes: limit });

  // 3. The resources, requested explicitly and clamped to the platform caps.
  const resolvedOrIssues = resolveAppResources(manifest, req.body.resources, ports.caps());
  if ("issues" in resolvedOrIssues) {
    return refuse(400, "app_resources_invalid", { problems: resolvedOrIssues.issues as AppResourcesIssue[] });
  }
  const resolved = resolvedOrIssues.resources;
  const plan = planAppRun(manifest, resolved);

  // 4. Every workspace the resources name.
  for (const workspaceId of plan.workspaceIds) {
    let verdict: WorkspaceVerdict;
    try {
      verdict = await ports.workspaceAccess(req.auth, workspaceId);
    } catch (err) {
      logger.warn({ sessionId: req.sessionId, err: err instanceof Error ? err.message : String(err) }, "app_run.workspace_check_unavailable");
      return refuse(503, "workspace_check_unavailable");
    }
    if (verdict === "not_found") return refuse(404, "workspace_not_found", { workspace: workspaceId });
    if (verdict !== "ok") return refuse(403, "workspace_access_denied", { workspace: workspaceId });
  }

  return { pluginId, manifest, input, resolved, plan };
}

/**
 * The whole admission. Returns the answer to give; never throws for a refusal.
 * A fault that is not a refusal propagates.
 */
export async function admitAppRun(
  req: AppRunRequest,
  ports: AppRunPorts = appRunPorts,
): Promise<AppRunOutcome> {
  const checked = await checkAppRunRequest(req, ports);
  if ("statusCode" in checked) return checked;
  const { pluginId, manifest, input, resolved, plan } = checked;
  const grantId = deriveGrantId(req.sessionId, req.idemKey);

  try {
    return await withAdmissionTransaction<AppRunOutcome>(async (client) => {
      // One app run per session, decided under a per-session lock: the
      // admission lock is only taken when a fleet ceiling is configured, and
      // two creates for one session must not both pass the read below.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('claw_app_run'), hashtext($1))", [req.sessionId]);
      const active = await activeAppRunTaskId(req.sessionId, client);
      if (active) {
        return { commit: false, value: refuse(409, "app_run_active", { task_id: active }) };
      }

      await stampSessionCredentials(req.sessionId, req.user, client);

      const created = await createSingleTask({
        session_id: req.sessionId,
        plugin_id: pluginId,
        input,
        mode: "app",
        workspace_id: plan.workspaceId,
        sandbox_spec: plan.sandboxSpec,
      }, client);
      if (isCreateRefusal(created)) {
        const value = isTopologyRefusal(created)
          ? refuse(400, "invalid_topology", { errors: created.invalidTopology })
          : refuse(429, "admission_rejected", { reason: created.reason });
        return { commit: false, value };
      }
      const taskId = created.task_id;

      let issued: AppGrantIssued | void;
      try {
        issued = await ports.grant.issue(
          { grantId, taskId, sessionId: req.sessionId, userId: req.user.userId, pluginId },
          manifest,
          { resources: resolved, templates: appGrantTemplates(manifest, resolved) },
        );
      } catch (err) {
        throw new AppGrantIssueError(err);
      }

      await client.query(
        `INSERT INTO claw_app_runs (
           task_id, session_id, plugin_id, manifest, idempotency_key, state, mcp_token_enc,
           grant_id, grant_keys_enc, grant_limits, grant_expires_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5, 'provisioning', $6, $7, $8, $9::jsonb, $10)`,
        [
          taskId, req.sessionId, pluginId, JSON.stringify(manifest), req.idemKey,
          sealAppRunSecret(newMcpToken(), taskId, "mcp_token"),
          issued ? grantId : null,
          issued?.keys ? sealAppRunSecret(JSON.stringify(sanitiseKeys(issued.keys)), taskId, "grant_keys") : null,
          JSON.stringify(issued?.limits ?? resolved.grant),
          issued?.expiresAt ?? null,
        ],
      );
      logger.info({ sessionId: req.sessionId, taskId, pluginId }, "app_run.created");
      return { commit: true, value: { statusCode: 200, response: { ok: true, task_id: taskId } } };
    });
  } catch (err) {
    if (err instanceof AppGrantIssueError) {
      logger.error(
        { sessionId: req.sessionId, grantId, err: err.cause instanceof Error ? err.cause.message : String(err.cause) },
        "app_run.grant_issue_failed",
      );
      return refuse(503, "grant_issue_failed");
    }
    if (err instanceof MissingPlatformKeyError) {
      logger.warn({ sessionId: req.sessionId, userId: req.user.userId }, "app_run.submit_without_platform_key");
      return refuse(403, "missing_platform_key");
    }
    throw err;
  }
}

function sanitiseKeys(keys: Partial<Record<AppSandboxRole, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of APP_SANDBOX_ROLES) {
    const k = keys[role];
    if (typeof k === "string" && k) out[role] = k;
  }
  return out;
}
