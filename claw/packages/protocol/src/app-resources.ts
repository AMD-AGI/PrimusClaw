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
 * manifest's defaults, and takes each grant item as the smallest of the request,
 * the manifest's `limits` and the platform cap (`APP_SANDBOX_CAPS`). An item with no bound is
 * the request as it is. An item the request omits but a cap names is the cap:
 * leaving it out must not mean "unlimited". The effective grant is what Claw
 * stores and what the app sees through `env_map.grant_limits`.
 */
import type { AppManifestV1 } from "./app-manifest.js";

/** The GPU resource name a sandbox spec carries. */
export const APP_GPU_RESOURCE = "amd.com/gpu";
/**
 * The spelling of a GPU count that admission counts as "this pod wants GPUs". Used by
 * the TypeScript read and bound into the SQL aggregate, so the two cannot differ.
 */
export const APP_GPU_COUNT_PATTERN = "^[1-9][0-9]*$";

/**
 * A grant request, an effective grant and a platform cap all have this shape:
 * one set of totals for the whole run. How an app divides them between its own
 * roles is the app's business, not Claw's.
 */
export interface AppGrantLimits {
  max_sandboxes?: number;
  max_gpus?: number;
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
  /** Dotted path under the request, e.g. `resources.grant.max_gpus`. */
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
/**
 * A cpu or memory request as a plain decimal in [min, max]: no exponent form (the
 * value is written into the spec as `String(n)` plus a unit, and `1e-7Gi` is not a
 * Kubernetes quantity), at most six fractional digits, and nothing so small it
 * rounds to zero in the unit it is sent in.
 */
const isPlainQuantity = (v: unknown, min: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && /^[0-9]+(?:\.[0-9]{1,6})?$/.test(String(v));

/** What one app container may ask for on the platform, whatever its manifest says. */
export interface AppContainerCaps {
  /** GPUs of one app container. A pod runs on one node, so this is at most a node's GPUs. */
  gpus: number;
  cpu: number;
  memory_gi: number;
}

/**
 * Applied when `APP_CONTAINER_CAPS` is not set: one node of the fleet's usual
 * shape (8 GPUs). A cap that is never configured must not mean "unlimited": a
 * request for more GPUs than any node has can never be scheduled and would sit on
 * the session's one app-run slot for ever.
 */
export const DEFAULT_APP_CONTAINER_CAPS: AppContainerCaps = { gpus: 8, cpu: 256, memory_gi: 4096 };

/**
 * Parse `APP_CONTAINER_CAPS`: a JSON object with any of `gpus`, `cpu`, `memory_gi`
 * (positive numbers; `gpus` a whole number). An item left out keeps its default. Throws on
 * anything else, so a misconfigured platform fails at start-up.
 */
export function parseAppContainerCaps(raw: string | undefined): AppContainerCaps {
  if (raw === undefined || raw.trim() === "") return { ...DEFAULT_APP_CONTAINER_CAPS };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("APP_CONTAINER_CAPS is not valid JSON");
  }
  if (!isObj(v)) throw new Error("APP_CONTAINER_CAPS must be a JSON object");
  const problems: string[] = [];
  for (const k of Object.keys(v)) if (!(k in DEFAULT_APP_CONTAINER_CAPS)) problems.push(`${k}: unknown field`);
  const out = { ...DEFAULT_APP_CONTAINER_CAPS };
  for (const k of ["gpus", "cpu", "memory_gi"] as const) {
    if (v[k] === undefined) continue;
    const ok = k === "gpus" ? isCount(v[k]) && (v[k] as number) > 0 : isPlainQuantity(v[k], 0.001);
    if (ok) out[k] = v[k] as number;
    else problems.push(`${k}: must be a positive ${k === "gpus" ? "whole number" : "plain decimal number"}`);
  }
  if (problems.length > 0) throw new Error(`APP_CONTAINER_CAPS is invalid: ${problems.join("; ")}`);
  return out;
}
const isNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isName = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

const RESOURCE_KEYS = ["image", "gpus", "workspace", "sandbox_workspace", "cpu", "memory_gi", "grant"];
const GRANT_KEYS = ["max_sandboxes", "max_gpus", "gpu_hours", "max_runtime_sec"];

function unknownKeys(at: string, v: Record<string, unknown>, known: string[], out: AppResourcesIssue[]): void {
  for (const k of Object.keys(v)) {
    if (!known.includes(k)) out.push({ field: `${at}.${k}`, reason: "unknown field" });
  }
}

/** Check the shape of a grant (a request's `grant`, or the platform caps). */
export function validateAppGrantLimits(at: string, v: unknown, out: AppResourcesIssue[]): void {
  if (!isObj(v)) {
    out.push({ field: at, reason: "must be an object" });
    return;
  }
  unknownKeys(at, v, GRANT_KEYS, out);
  for (const k of ["max_sandboxes", "max_gpus"]) {
    if (v[k] !== undefined && !isCount(v[k])) out.push({ field: `${at}.${k}`, reason: "must be a whole number >= 0" });
  }
  if (v.gpu_hours !== undefined && !isNonNeg(v.gpu_hours)) out.push({ field: `${at}.gpu_hours`, reason: "must be a number >= 0" });
  if (v.max_runtime_sec !== undefined && !isNonNeg(v.max_runtime_sec)) {
    out.push({ field: `${at}.max_runtime_sec`, reason: "must be a number >= 0" });
  }
}

/**
 * Parse `APP_SANDBOX_CAPS`: a JSON object of the grant shape (`max_sandboxes`,
 * `max_gpus`, `gpu_hours`, `max_runtime_sec`); any item left out has no cap. Throws on a
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
  validateAppGrantLimits("APP_SANDBOX_CAPS", v, issues);
  if (issues.length > 0) {
    throw new Error(`APP_SANDBOX_CAPS is invalid: ${issues.map((i) => `${i.field}: ${i.reason}`).join("; ")}`);
  }
  return v as AppGrantLimits;
}

/** The smallest of the values that are set: a bound alone stands in for an absent request. */
const smallest = (...values: Array<number | undefined>): number | undefined => {
  const set = values.filter((x): x is number => x !== undefined);
  return set.length === 0 ? undefined : Math.min(...set);
};

const QUANTITY_SUFFIX: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
};
/** A Kubernetes quantity ("8", "500m", "32Gi", "1e3", "1G") as a number; undefined when not one. */
function quantity(q: string): number | undefined {
  const m = /^([0-9]+(?:\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+|[numkMGTPE]|Ki|Mi|Gi|Ti|Pi|Ei)?$/.exec(q.trim());
  if (!m) return undefined;
  const n = Number(m[1]) * (m[2] === undefined ? 1 : /^[eE][+-]?[0-9]/.test(m[2]) ? 10 ** Number(m[2].slice(1)) : QUANTITY_SUFFIX[m[2]]!);
  return Number.isFinite(n) ? n : undefined;
}
/**
 * Validate `resources` and work out what the run gets. `{ issues }` lists every
 * problem; the request is refused as a whole.
 *
 * Defaults, in order: the request, then the manifest. A run with no image, no
 * GPU count or no workspace from either is refused rather than started with a
 * guess; `gpus` has no manifest default (the manifest cannot carry a GPU key).
 * Every one of `gpus`, `cpu` and `memory_gi` is also bounded by the platform's
 * `containerCaps` (default: one node), whether or not the manifest declares
 * anything. A `cpu` or `memory_gi` above what the manifest declares for that resource in
 * `container.resources` is refused, naming the field. The grant: each
 * item is the smallest of the request, the manifest's `limits` value (where the
 * manifest has one: `max_sandboxes`, `max_runtime_sec`) and the platform cap; an
 * absent request takes the smaller of the other two.
 */
export function resolveAppResources(
  manifest: AppManifestV1,
  raw: unknown,
  caps: AppGrantLimits = {},
  containerCaps: AppContainerCaps = DEFAULT_APP_CONTAINER_CAPS,
): { resources: ResolvedAppResources } | { issues: AppResourcesIssue[] } {
  const issues: AppResourcesIssue[] = [];
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
    if (!isCount(r.gpus)) issues.push({ field: "resources.gpus", reason: "must be a whole number >= 0" });
    else if (r.gpus > containerCaps.gpus) {
      issues.push({ field: "resources.gpus", reason: `exceeds the platform maximum ${containerCaps.gpus} GPUs for one app container` });
    } else gpus = r.gpus;
  } else {
    issues.push({ field: "resources.gpus", reason: "required: the GPU count comes only from the request" });
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

  const quantityIssue = (field: string, v: unknown, min: number, max: number): void => {
    if (v === undefined) return;
    if (!isPlainQuantity(v, min)) issues.push({ field, reason: `must be a plain decimal number >= ${min} (no exponent, at most 6 decimals)` });
    else if (v > max) issues.push({ field, reason: `exceeds the platform maximum ${max}` });
  };
  quantityIssue("resources.cpu", r.cpu, 0.001, containerCaps.cpu);
  quantityIssue("resources.memory_gi", r.memory_gi, 0.001, containerCaps.memory_gi);

  // The manifest's container resources are also the most a request may ask for.
  const declared = manifest.container.resources ?? {};
  // `max` converts a declared quantity to the request's unit. A declared value that
  // cannot be read is a refusal of any request for that resource, never "no maximum".
  const over = (field: string, asked: unknown, text: string | undefined, max: (q: number) => number): void => {
    if (typeof asked !== "number" || text === undefined) return;
    const q = quantity(text);
    if (q === undefined) issues.push({ field, reason: `the manifest maximum ${JSON.stringify(text)} is not a readable quantity` });
    else if (asked > max(q)) issues.push({ field, reason: `exceeds the manifest maximum ${text}` });
  };
  over("resources.cpu", r.cpu, declared.cpu, (q) => q);
  over("resources.memory_gi", r.memory_gi, declared.memory, (q) => q / 1024 ** 3);

  const req: AppGrantLimits = {};
  if (r.grant !== undefined) {
    const before = issues.length;
    validateAppGrantLimits("resources.grant", r.grant, issues);
    if (issues.length === before) Object.assign(req, r.grant as AppGrantLimits);
  }

  if (issues.length > 0 || image === undefined || gpus === undefined || workspace === undefined) return { issues };

  const grant: AppGrantLimits = {};
  const sandboxes = smallest(req.max_sandboxes, manifest.limits?.max_sandboxes, caps.max_sandboxes);
  if (sandboxes !== undefined) grant.max_sandboxes = sandboxes;
  const gpuTotal = smallest(req.max_gpus, caps.max_gpus);
  if (gpuTotal !== undefined) grant.max_gpus = gpuTotal;
  const hours = smallest(req.gpu_hours, caps.gpu_hours);
  if (hours !== undefined) grant.gpu_hours = hours;
  const runtime = smallest(req.max_runtime_sec, manifest.limits?.max_runtime_sec, caps.max_runtime_sec);
  if (runtime !== undefined) grant.max_runtime_sec = runtime;

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
