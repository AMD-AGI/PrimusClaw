// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Display names for everything Claw creates through the SaFE Workload API.
 *
 * One shape across the board -- `claw-<epoch-ms>-<kind>` -- so a `get workloads`
 * listing reads as one family:
 *
 *   claw-1785291793209-sandbox    the Hands sandbox (session-scoped)
 *   claw-1785291151001-ray        a multi-node RayJob cluster (message-scoped)
 *   claw-1785291151001-infera     a multi-node InferaDeployment (message-scoped)
 *
 * SaFE appends its own random suffix to derive the workload id, so these names
 * are prefixes of the ids seen in the cluster.
 *
 * Kept import-free so it is directly testable (the providers that consume it
 * pull in the k8s HTTP client, which cannot load under tsx here).
 */

/** Longest name SaFE/Kubernetes will accept for a workload. */
const MAX_NAME_LEN = 63;

/** Session-scoped Hands sandbox. Timestamped at create time: a session has no message of its own. */
export function sandboxWorkloadName(now: number = Date.now()): string {
  return `claw-${now}-sandbox`;
}

/**
 * Message-scoped multi-node cluster. Derived from the message id (itself
 * `claw-<epoch-ms>`) rather than the clock, so a redelivered message maps onto
 * the same name.
 */
export function multiNodeWorkloadName(messageId: string, backend: "rayjob" | "infera"): string {
  const base = sanitizeMessageIdBase(messageId);
  const suffix = backend === "infera" ? "-infera" : "-ray";
  const maxBaseLen = MAX_NAME_LEN - suffix.length;
  const trimmed = base.length > maxBaseLen ? base.slice(0, maxBaseLen).replace(/-+$/, "") : base;
  return `${trimmed}${suffix}`;
}

/** Normalise a message id into a DNS-safe name fragment. */
function sanitizeMessageIdBase(messageId: string): string {
  const base = messageId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) throw new Error("message_id is required to name the workload");
  return base;
}
