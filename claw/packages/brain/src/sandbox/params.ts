// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Sandbox parameter normalization layer (task-design.md §9 / §11).
 *
 * Brain MUST NOT read `plugin` / `task_dag` tables to assemble a sandbox spec.
 * All `image` / `resources` / `env` / `labels` / `ttl` / `image_digest_allowlist`
 * values come from `ExecuteRequest.sandbox_spec` -- a fully rendered spec the
 * Backend dispatcher writes into the request at `queued → preparing`.
 *
 * The legacy chat-mode top-level fields (`sandbox_image` / `resources` /
 * `timeout`) are still accepted so the existing `POST
 * /v1/sessions/:id/messages` path keeps working; that path does not yet
 * construct a real `sandbox_spec`.
 */
import type { ExecuteRequest, SandboxSpec, SandboxSpecCreate, SandboxSpecUse } from "@claw/protocol";
import { normalizeWorkloadResourcesEntry } from "./workload-resources.js";
// Type-only: avoids a runtime import cycle (ensure.ts -> sandbox/ensure-hands.ts -> sandbox/params.ts).
import type { MultiNodeContext } from "./multi-node/types.js";

/** Decision Brain takes about sandbox provisioning at task entry. */
export type SandboxAction =
  /** Skip sandbox entirely; only scope=backend tools may be called. */
  | { kind: "none" }
  /** Reuse an upstream-created sandbox identified by `handle` in DagHandleMap. */
  | { kind: "use"; handle: string }
  /** Provision a fresh sandbox using the normalized params below. */
  | { kind: "create"; handle: string; params: EffectiveSandboxParams };

/**
 * Flattened, rendered sandbox parameters consumed by SaFE workload create.
 *
 * Identical shape regardless of whether the call came from the new
 * `sandbox_spec` path or the legacy chat top-level fields.
 */
export interface EffectiveSandboxParams {
  image: string;
  /** SaFE workload resource keys: `cpu` / `memory` / `gpu` / `ephemeralStorage`. */
  resources: Record<string, string>;
  /** Hard wall-clock limit forwarded to SaFE workload `.timeout` (seconds). */
  timeout?: number;
  /** Idle TTL hint forwarded to SaFE workload `.ttlSecondsAfterFinished`. */
  ttl_sec?: number;
  /** Extra env merged into the sandbox at create time (under fixed AUTH/MCP keys). */
  env: Record<string, string>;
  /** Extra labels merged into the SaFE workload metadata. */
  labels: Record<string, string>;
  /** sha256 allow-list (only honoured for platform-trust DAGs). */
  image_digest_allowlist?: string[];
}

/**
 * Resolve which sandbox action Brain should take for this task.
 *
 * Order of precedence:
 *
 *   1. `request.sandbox_spec === "none"`            → `{ kind: "none" }`
 *   2. `request.sandbox_spec.use`                    → `{ kind: "use", handle }`
 *   3. `request.sandbox_spec.handle + image`         → `{ kind: "create", params }`
 *   4. Legacy top-level `sandbox_image` (chat path)  → synthesize a `"main"`
 *      handle spec so downstream `DagHandleMap` plumbing has a stable name.
 *
 * Throws when the request is missing both `sandbox_spec` and a legacy image,
 * since SaFE workload create cannot proceed without an image.
 */
export function resolveSandboxAction(request: ExecuteRequest): SandboxAction {
  const spec = request.sandbox_spec;

  if (spec === "none") return { kind: "none" };

  if (spec && typeof spec === "object" && "use" in spec) {
    const useSpec = spec as SandboxSpecUse;
    return { kind: "use", handle: useSpec.use };
  }

  if (spec && typeof spec === "object" && "handle" in spec) {
    const createSpec = spec as SandboxSpecCreate;
    return {
      kind: "create",
      handle: createSpec.handle,
      params: {
        image: createSpec.image,
        resources: normalizeResources(createSpec.resources),
        timeout: createSpec.timeout,
        ttl_sec: createSpec.ttl_sec,
        env: { ...(createSpec.env ?? {}) },
        labels: { ...(createSpec.labels ?? {}) },
        image_digest_allowlist: createSpec.image_digest_allowlist,
      },
    };
  }

  // Legacy chat fallback: build a "main" handle spec from top-level fields.
  const legacyImage = typeof request.sandbox_image === "string" ? request.sandbox_image.trim() : "";
  if (!legacyImage) {
    throw new Error(
      "no sandbox image: the request carries neither sandbox_spec nor sandbox_image, " +
        "and the resources table has no type='default' row to fall back to. Seed one " +
        "(chart value defaultSandbox.image) or send sandbox_image with the message.",
    );
  }
  return {
    kind: "create",
    handle: "main",
    params: {
      image: legacyImage,
      resources: normalizeResources(request.resources),
      timeout: normalizeTimeout(request.timeout),
      env: {},
      labels: {},
    },
  };
}

/** Normalize resources with the same SaFE workload logic used by legacy chat. */
function normalizeResources(input: Record<string, unknown> | undefined): Record<string, string> {
  const norm = normalizeWorkloadResourcesEntry(input);
  if (!norm) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(norm)) {
    if (k === "replica") continue;
    if (v != null) out[k] = String(v);
  }
  return out;
}

function normalizeTimeout(timeout: unknown): number | undefined {
  if (timeout === undefined || timeout === null || String(timeout).trim() === "") return undefined;
  const parsed = Number(timeout);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.trunc(parsed);
  return normalized > 0 ? normalized : undefined;
}

/**
 * SaFE workload `resources[]` expects ONE object whose keys are the actual
 * resource names (cpu / memory / gpu / ephemeralStorage / replica), NOT an
 * array of {key,value} tuples. Keep this path identical to legacy chat-mode
 * by delegating to `normalizeWorkloadResourcesEntry`.
 */
export function resourcesMapToWorkloadArray(map: Record<string, string>): Array<Record<string, string | number>> {
  const entry = normalizeWorkloadResourcesEntry(map);
  return entry ? [entry] : [];
}

/**
 * Hand the cluster Brain already provisioned to Hyperloom (see Hyperloom
 * `multi_node/SKILL.md` "Cluster hand-off").
 *
 * `SAFE_API_URL` is dropped so nothing sandbox-side can reach the workload API
 * and create a second cluster. The caller's key is left alone: it reaches the
 * sandbox as `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, which the LLM gateway and
 * other sandbox callers authenticate with. Hyperloom keys the hand-off purely off
 * `HYPERLOOM_MN_EXT_SERVICE_URL`, so no credential variable selects the mode.
 *
 * The two backends drive the cluster through entirely different control planes:
 * rayjob talks to the head over Ray Dashboard REST (:8265) / GCS (:6379) and
 * needs no pod IPs, while infera SSHes into the GPU pods directly and needs
 * their IPs plus a private key. Only the variables the active backend reads are
 * set, since Hyperloom infers the mode from which ones are present.
 *
 * Nothing about the shared filesystem is set here. `USER_DATA_PATH` is the
 * workspace root Hyperloom resolves its session directories from, and SaFE's
 * dispatcher already injects it from the workspace volume that declares
 * `enableUserDir`, which is the same volume the pods mount. Setting it from here
 * would win over that -- SaFE leaves an env key the workload already carries
 * alone -- and the two are computed differently, so ours could quietly redirect
 * a workspace root that was already correct.
 */
export function applyMultiNodeExternalEnv(env: Record<string, string>, ctx: MultiNodeContext): void {
  delete env.SAFE_API_URL;
  env.INFERENCE_OPTIMIZER_MN_BACKEND = ctx.backend;
  env.INFERENCE_OPTIMIZER_NODES = String(ctx.nodeCount);
  // Required: presence alone is what flips Hyperloom into external mode.
  env.HYPERLOOM_MN_EXT_SERVICE_URL = ctx.serviceUrl;

  if (ctx.backend === "rayjob") {
    // Recommended: enables per-round restart-server via Ray Dashboard/GCS;
    // benchmark-only still works if this were omitted.
    if (ctx.headHost) env.HYPERLOOM_MN_EXT_HEAD_IP = ctx.headHost;
    if (ctx.dashboardToken) env.HYPERLOOM_MN_EXT_RAY_DASHBOARD_TOKEN = ctx.dashboardToken;
    return;
  }

  // infera: the optimizer SSHes into the GPU pods to relaunch the engine, so it
  // needs the key path plus at least one role's pod IPs.
  if (ctx.sshKeyPath) env.HYPERLOOM_MN_EXT_SSH_KEY = ctx.sshKeyPath;
  if (ctx.sshPortBase) env.HYPERLOOM_MN_EXT_SSH_PORT = String(ctx.sshPortBase);
  if (ctx.prefillIps?.length) env.HYPERLOOM_MN_EXT_PREFILL_IPS = ctx.prefillIps.join(",");
  if (ctx.decodeIps?.length) env.HYPERLOOM_MN_EXT_DECODE_IPS = ctx.decodeIps.join(",");
  if (ctx.workerIps?.length) env.HYPERLOOM_MN_EXT_WORKER_IPS = ctx.workerIps.join(",");
}

/**
 * platform-trust guard: when `image_digest_allowlist` is set, the rendered
 * `image` MUST contain a digest from the allow-list. Other trust levels are
 * not allowed to set the field at all (admission rejects them upstream).
 *
 * Returns the image unchanged when the check passes; throws otherwise.
 */
export function assertImageDigest(spec: SandboxSpec | undefined, image: string): string {
  if (!spec || typeof spec !== "object" || !("image_digest_allowlist" in spec)) return image;
  const allow = (spec as SandboxSpecCreate).image_digest_allowlist;
  if (!allow || allow.length === 0) return image;
  const match = allow.some((digest) => image.includes(digest));
  if (!match) {
    throw new Error(`sandbox image '${image}' does not match any digest in image_digest_allowlist`);
  }
  return image;
}
