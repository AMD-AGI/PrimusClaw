// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Multi-node provider factory. Multi-node GPU clusters are provisioned through
 * the SaFE Workload API only: SaFE owns cluster quota, priority and dispatch,
 * and an InferaDeployment is only meaningful once its dispatcher renders it into
 * a LeaderWorkerSet. A deployment without SaFE therefore cannot serve
 * multi-node, so `CLAW_DEPLOY_MODE=kubernetes` is rejected rather than silently
 * degraded. `CLAW_DEPLOY_MODE` still selects the single-node sandbox provider
 * (see sandbox/factory.ts); only multi-node requires `safe`.
 */

import { CLAW_DEPLOY_MODE } from "../../config.js";
import { SafeMultiNodeProvider } from "./safe-provider.js";
import type { MultiNodeProvider } from "./types.js";

let safeProvider: MultiNodeProvider | null = null;

export function getSafeMultiNodeProvider(): MultiNodeProvider {
  if (!safeProvider) safeProvider = new SafeMultiNodeProvider();
  return safeProvider;
}

/**
 * Whether this deployment can have multi-node clusters at all.
 *
 * Exists so callers on a cleanup path can skip the work instead of calling
 * getMultiNodeProvider and handling the throw: a deployment without SaFE has no
 * GPU clusters to reclaim, and treating "this mode has none" as a failed
 * teardown would mark every session delete incomplete.
 *
 * Invariant: false here means getMultiNodeProvider below throws.
 */
export function multiNodeAvailable(): boolean {
  return CLAW_DEPLOY_MODE === "safe";
}

/**
 * Returns the multi-node provider, or throws when the deployment has no SaFE.
 *
 * @throws Error when `CLAW_DEPLOY_MODE` is not `safe`.
 */
export function getMultiNodeProvider(): MultiNodeProvider {
  if (CLAW_DEPLOY_MODE !== "safe") {
    throw new Error(
      `multi-node requires CLAW_DEPLOY_MODE=safe (got ${CLAW_DEPLOY_MODE}): GPU clusters are ` +
      "provisioned through the SaFE Workload API, which owns quota, priority and dispatch",
    );
  }
  return getSafeMultiNodeProvider();
}
