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
 *   claw-1785291151001-atom       a multi-node Atom workload (message-scoped)
 *   claw-1785291151001-sglangrouter  a multi-node SGLangRouter workload (message-scoped)
 *
 * SaFE appends its own random suffix to derive the workload id, so these names
 * are prefixes of the ids seen in the cluster.
 *
 * Suffixes are keyed by TopologyBackend so a new backend fails to compile here
 * until it gets a name, rather than silently falling through to `-ray`.
 */

import type { TopologyBackend } from "@claw/protocol";

/** Longest name SaFE/Kubernetes will accept for a workload. */
const MAX_NAME_LEN = 63;

/** Display-name suffix for each multi-node engine. */
const MULTI_NODE_NAME_SUFFIX: Record<TopologyBackend, string> = {
  rayjob: "-ray",
  infera: "-infera",
  atom: "-atom",
  sglangrouter: "-sglangrouter",
};

/** Session-scoped Hands sandbox. Timestamped at create time: a session has no message of its own. */
export function sandboxWorkloadName(now: number = Date.now()): string {
  return `claw-${now}-sandbox`;
}

/**
 * Message-scoped multi-node cluster. Derived from the message id (itself
 * `claw-<epoch-ms>`) rather than the clock, so a redelivered message maps onto
 * the same name.
 */
export function multiNodeWorkloadName(
  messageId: string,
  backend: TopologyBackend,
): string {
  const base = sanitizeMessageIdBase(messageId);
  const suffix = MULTI_NODE_NAME_SUFFIX[backend];
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
