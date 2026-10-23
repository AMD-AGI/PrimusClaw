// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The resources of an app run, requested explicitly by whoever creates it.
 *
 * `POST /v1/sessions/:sessionId/tasks` with `mode: "app"` carries two separate
 * things, as a Kubernetes Pod keeps its resources apart from the container's
 * arguments:
 *
 *  - `input`: the application's own request. Opaque to Claw, which stores it,
 *    hands it to the app and checks its size against `limits.input_max_bytes`.
 *    Nothing in this file (or anywhere in admission) reads a field of it.
 *  - `resources`: what the run gets, spelled out by the submitter: the image,
 *    the GPU count, the workspace, optional cpu and memory, and the `grant`
 *    (what the app may later ask Agent Sandbox for).
 *
 * Claw validates `resources` against the manifest, fills absent items from the
 * manifest's defaults, and takes each grant item as the smaller of the request
 * and the platform cap (`APP_SANDBOX_CAPS`). An item with no cap configured is
 * the request as it is. An item the request omits but a cap names is the cap:
 * leaving it out must not mean "unlimited". The effective grant is what Claw
 * stores and what the app sees through `env_map.grant_limits`.
 */
import { APP_SANDBOX_ROLES, type AppManifestV1, type AppSandboxRole } from "./app-manifest.js";

/** The GPU resource name a sandbox spec carries. */
export const APP_GPU_RESOURCE = "amd.com/gpu";

export interface AppRoleGrant {
  max_sandboxes?: number;
  max_gpus?: number;
}

/** A grant request, an effective grant and a platform cap all have this shape. */
export interface AppGrantLimits {
  roles?: { [R in AppSandboxRole]?: AppRoleGrant };
  gpu_hours?: number;
  max_runtime_sec?: number;
}

/** The `resources` object of a create request; see {@link resolveAppResources} for which items are required. */
export interface AppResourcesRequest {
  /** Overrides `container.image`. */
  image?: string;
  /** GPUs of the app container. */
  gpus?: number;
  /** The workspace the app container runs in. */
  workspace?: string;
  /** The workspace sandbox templates run in; defaults to `workspace`. */
  sandbox_workspace?: string;
  cpu?: number;
  memory_gi?: number;
  grant?: AppGrantLimits;
}

export interface AppResourcesIssue {
  /** Dotted path under the request, e.g. `resources.grant.roles.dev.max_gpus`. */
  field: string;
  reason: string;
}

/** What admission works with once `resources` is validated and defaulted. */
export interface ResolvedAppResources {
  image: string;
  gpus: number;
  workspace: string;
  sandboxWorkspace: string;
  cpu?: number;
  memoryGi?: number;
  grant: AppGrantLimits;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isQuantity = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const isNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isName = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

const RESOURCE_KEYS = ["image", "gpus", "workspace", "sandbox_workspace", "cpu", "memory_gi", "grant"];
const GRANT_KEYS = ["roles", "gpu_hours", "max_runtime_sec"];
const ROLE_KEYS = ["max_sandboxes", "max_gpus"];

function unknownKeys(at: string, v: Record<string, unknown>, known: string[], out: AppResourcesIssue[]): void {
  for (const k of Object.keys(v)) {
    if (!known.includes(k)) out.push({ field: `${at}.${k}`, reason: "unknown field" });
  }
}

/**
 * Check the shape of a grant (a request's `grant`, or the platform caps).
 * `roles` may only name roles in `declaredRoles`.
 */
export function validateAppGrantLimits(
  at: string,
  v: unknown,
  declaredRoles: readonly string[],
  out: AppResourcesIssue[],
): void {
  if (!isObj(v)) {
    out.push({ field: at, reason: "must be an object" });
    return;
  }
  unknownKeys(at, v, GRANT_KEYS, out);
  if (v.gpu_hours !== undefined && !isNonNeg(v.gpu_hours)) out.push({ field: `${at}.gpu_hours`, reason: "must be a number >= 0" });
  if (v.max_runtime_sec !== undefined && !isNonNeg(v.max_runtime_sec)) {
    out.push({ field: `${at}.max_runtime_sec`, reason: "must be a number >= 0" });
  }
  if (v.roles === undefined) return;
  if (!isObj(v.roles)) {
    out.push({ field: `${at}.roles`, reason: "must be an object" });
    return;
  }
  for (const [role, g] of Object.entries(v.roles)) {
    const rat = `${at}.roles.${role}`;
    if (!declaredRoles.includes(role)) {
      out.push({ field: rat, reason: `role ${JSON.stringify(role)} is not declared in the manifest's sandbox_roles` });
      continue;
    }
    if (!isObj(g)) {
      out.push({ field: rat, reason: "must be an object" });
      continue;
    }
    unknownKeys(rat, g, ROLE_KEYS, out);
    for (const k of ROLE_KEYS) {
      if (g[k] !== undefined && !isCount(g[k])) out.push({ field: `${rat}.${k}`, reason: "must be a whole number >= 0" });
    }
  }
}

/** The roles a manifest declares. */
export const declaredRolesOf = (m: AppManifestV1): AppSandboxRole[] =>
  APP_SANDBOX_ROLES.filter((r) => Array.isArray(m.sandbox_roles?.[r]));

/**
 * Parse `APP_SANDBOX_CAPS`: a JSON object of the grant shape (`roles`,
 * `gpu_hours`, `max_runtime_sec`); any item left out has no cap. Throws on a
 * value that is not that, so a misconfigured platform fails at start-up
 * rather than silently capping nothing.
 */
export function parseAppSandboxCaps(raw: string | undefined): AppGrantLimits {
  if (raw === undefined || raw.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("APP_SANDBOX_CAPS is not valid JSON");
  }
  const issues: AppResourcesIssue[] = [];
  validateAppGrantLimits("APP_SANDBOX_CAPS", v, APP_SANDBOX_ROLES, issues);
  if (issues.length > 0) {
    throw new Error(`APP_SANDBOX_CAPS is invalid: ${issues.map((i) => `${i.field}: ${i.reason}`).join("; ")}`);
  }
  return v as AppGrantLimits;
}

/** An item is the smaller of request and cap; a cap alone stands in for an absent request. */
const capped = (request: number | undefined, cap: number | undefined): number | undefined =>
  cap === undefined ? request : request === undefined ? cap : Math.min(request, cap);

/**
 * Validate `resources` and work out what the run gets. `{ issues }` lists every
 * problem; the request is refused as a whole.
 *
 * Defaults, in order: the request, then the manifest. A run with no image, no
 * GPU count or no workspace from either is refused rather than started with a
 * guess. The grant: the request's item (or the manifest's `limits` default),
 * then the platform cap per item; `max_runtime_sec` is also bounded by the
 * manifest's `limits.max_runtime_sec`.
 */
export function resolveAppResources(
  manifest: AppManifestV1,
  raw: unknown,
  caps: AppGrantLimits = {},
): { resources: ResolvedAppResources } | { issues: AppResourcesIssue[] } {
  const issues: AppResourcesIssue[] = [];
  const roles = declaredRolesOf(manifest);
  if (raw !== undefined && !isObj(raw)) return { issues: [{ field: "resources", reason: "must be an object" }] };
  const r = (raw ?? {}) as Record<string, unknown>;
  unknownKeys("resources", r, RESOURCE_KEYS, issues);

  let image: string | undefined;
  if (r.image !== undefined) {
    if (isName(r.image)) image = r.image.trim();
    else issues.push({ field: "resources.image", reason: "must be a non-empty string" });
  } else if (manifest.container.image !== undefined && isName(manifest.container.image)) {
    image = manifest.container.image.trim();
  } else {
    issues.push({ field: "resources.image", reason: "no image: the request gives none and the manifest has no container.image default" });
  }

  let gpus: number | undefined;
  if (r.gpus !== undefined) {
    if (isCount(r.gpus)) gpus = r.gpus;
    else issues.push({ field: "resources.gpus", reason: "must be a whole number >= 0" });
  } else {
    const d = manifest.container.resources?.[APP_GPU_RESOURCE];
    if (d !== undefined && /^[0-9]+$/.test(d)) gpus = Number(d);
    else issues.push({ field: "resources.gpus", reason: "required: the request gives none and the manifest has no default" });
  }

  let workspace: string | undefined;
  if (r.workspace === undefined) issues.push({ field: "resources.workspace", reason: "required" });
  else if (isName(r.workspace)) workspace = r.workspace.trim();
  else issues.push({ field: "resources.workspace", reason: "must be a non-empty string" });

  let sandboxWorkspace: string | undefined;
  if (r.sandbox_workspace !== undefined) {
    if (isName(r.sandbox_workspace)) sandboxWorkspace = r.sandbox_workspace.trim();
    else issues.push({ field: "resources.sandbox_workspace", reason: "must be a non-empty string" });
  }

  if (r.cpu !== undefined && !isQuantity(r.cpu)) issues.push({ field: "resources.cpu", reason: "must be a number > 0" });
  if (r.memory_gi !== undefined && !isQuantity(r.memory_gi)) issues.push({ field: "resources.memory_gi", reason: "must be a number > 0" });

  const req: AppGrantLimits = {};
  if (r.grant !== undefined) {
    const before = issues.length;
    validateAppGrantLimits("resources.grant", r.grant, roles, issues);
    if (issues.length === before) Object.assign(req, r.grant as AppGrantLimits);
  }

  if (issues.length > 0 || image === undefined || gpus === undefined || workspace === undefined) return { issues };

  const grant: AppGrantLimits = {};
  const outRoles: NonNullable<AppGrantLimits["roles"]> = {};
  for (const role of roles) {
    const asked = req.roles?.[role];
    const cap = caps.roles?.[role];
    const item: AppRoleGrant = {};
    const sandboxes = capped(asked?.max_sandboxes ?? manifest.limits?.max_sandboxes?.[role], cap?.max_sandboxes);
    const g = capped(asked?.max_gpus, cap?.max_gpus);
    if (sandboxes !== undefined) item.max_sandboxes = sandboxes;
    if (g !== undefined) item.max_gpus = g;
    if (Object.keys(item).length > 0) outRoles[role] = item;
  }
  if (Object.keys(outRoles).length > 0) grant.roles = outRoles;
  const hours = capped(req.gpu_hours, caps.gpu_hours);
  if (hours !== undefined) grant.gpu_hours = hours;
  const runtime = [req.max_runtime_sec, manifest.limits?.max_runtime_sec, caps.max_runtime_sec]
    .filter((x): x is number => x !== undefined);
  if (runtime.length > 0) grant.max_runtime_sec = Math.min(...runtime);

  const out: ResolvedAppResources = { image, gpus, workspace, sandboxWorkspace: sandboxWorkspace ?? workspace, grant };
  if (r.cpu !== undefined) out.cpu = r.cpu as number;
  if (r.memory_gi !== undefined) out.memoryGi = r.memory_gi as number;
  return { resources: out };
}

/**
 * The manifest's templates as the grant hands them to Agent Sandbox. A template
 * that sets its own `image` or `workspace` keeps it; one that does not inherits
 * the run's image and `sandbox_workspace` (which defaults to `workspace`).
 * Everything else in a template passes through untouched.
 */
export function appGrantTemplates(
  manifest: AppManifestV1,
  resolved: Pick<ResolvedAppResources, "image" | "sandboxWorkspace">,
): Array<Record<string, unknown>> {
  return (manifest.sandbox_templates ?? []).map((t) => ({
    ...t,
    image: t.image ?? resolved.image,
    workspace: t.workspace ?? resolved.sandboxWorkspace,
  }));
}
