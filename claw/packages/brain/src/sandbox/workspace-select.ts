// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which SaFE workspace (== Kubernetes namespace) a sandbox is created in.
 *
 * Today that is the request's `workspace_id`, else SANDBOX_NAMESPACE. A deployment
 * whose GPU workspace cannot take CPU-only sandboxes (no schedulable node, or a
 * quota nobody wants spent on them) names a second workspace, SANDBOX_CPU_NAMESPACE,
 * and the rule becomes:
 *
 *   - no GPU requested -> the request's own workspace if it named one, else the CPU workspace;
 *   - a GPU requested  -> the request's own workspace if it named one other than the CPU
 *                         workspace, else SANDBOX_NAMESPACE (the GPU workspace).
 *
 * The one exception to "a named workspace wins" is the CPU workspace itself: it has no
 * GPUs by definition, so a GPU request naming it would queue for ever. The console names
 * the server's default workspace on every turn, so without the exception a deployment
 * could not make its default a CPU workspace and still run a GPU sandbox from it.
 *
 * With SANDBOX_CPU_NAMESPACE unset nothing changes: the function returns exactly what
 * `request.workspace_id?.trim() || SANDBOX_NAMESPACE` did.
 */
import { SANDBOX_CPU_NAMESPACE, SANDBOX_NAMESPACE } from "../config.js";

/** SaFE spells the GPU count `gpu`; a manifest may spell it as the Kubernetes resource name. */
const GPU_KEYS = ["gpu", "amd.com/gpu"] as const;

function entryNeedsGpu(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const obj = entry as Record<string, unknown>;
  for (const key of GPU_KEYS) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "number") {
      if (!(v === 0)) return true;
      continue;
    }
    const text = String(v).trim();
    if (text === "") continue;
    const n = Number(text);
    // "0" and "0.0" ask for nothing; a count above zero, or a value that is not a
    // number at all, asks for a GPU. An unreadable value must not send a sandbox
    // that may need one to a workspace that cannot have it.
    if (!(Number.isFinite(n) && n === 0)) return true;
  }
  return false;
}

/**
 * Whether the sandbox's resources ask for a GPU. Takes the map the spec carries, the
 * `resources[]` array SaFE's workload API takes, or nothing (no GPU).
 */
export function resourcesNeedGpu(resources: unknown): boolean {
  if (Array.isArray(resources)) return resources.some(entryNeedsGpu);
  return entryNeedsGpu(resources);
}

/** The rule above, with every input explicit. */
export function pickSandboxNamespace(args: {
  /** The workspace the request named, if any. */
  requested?: string | null;
  needsGpu: boolean;
  /** SANDBOX_NAMESPACE: where a request that names nothing goes, and where GPU sandboxes go. */
  defaultNamespace: string;
  /** SANDBOX_CPU_NAMESPACE; empty keeps the single-workspace behaviour. */
  cpuNamespace: string;
}): string {
  const requested = args.requested?.trim() ?? "";
  const cpu = args.cpuNamespace.trim();
  if (!cpu) return requested || args.defaultNamespace;
  if (args.needsGpu) return requested && requested !== cpu ? requested : args.defaultNamespace;
  return requested || cpu;
}

/** The rule, with this deployment's settings. */
export function sandboxNamespaceForResources(
  requested: string | null | undefined,
  resources: unknown,
): string {
  return pickSandboxNamespace({
    requested,
    needsGpu: resourcesNeedGpu(resources),
    defaultNamespace: SANDBOX_NAMESPACE,
    cpuNamespace: SANDBOX_CPU_NAMESPACE,
  });
}
