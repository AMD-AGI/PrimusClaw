// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The doorbell rollout's startup gate and its configuration gauges.
 *
 * Separate from `index.ts` because nothing there is exported and `main()` runs
 * at import, so a test that imported the check would bind the port and exit the
 * process on the first failure. This module imports only `config.js` and
 * `infra/metrics.js`, so importing it starts nothing.
 */

import {
  ADMIT_HARD_GPU_NODES,
  ADMIT_HARD_RUNS,
  ADMIT_HARD_SANDBOXES,
  ADMIT_SOFT_GPU_NODES,
  ADMIT_SOFT_RUNS,
  ADMIT_SOFT_SANDBOXES,
  ADMIT_TREE_MAX_DEPTH,
  ADMIT_TREE_MAX_NODES,
  RUN_DOORBELL_DISPATCH,
} from "../config.js";
import { ADMISSION_DIMENSIONS, metrics, type AdmissionDimension } from "../infra/metrics.js";

export interface RolloutConfig {
  doorbellDispatch: boolean;
  ceilings: Record<AdmissionDimension, number>;
}

export type RolloutVerdict =
  | { ok: true }
  | { ok: false; reason: "reverse_order"; offending: readonly AdmissionDimension[] };

/** The env var an operator sets for a dimension, named in the refusal below. */
function envKeyOf(dimension: AdmissionDimension): string {
  return `ADMIT_${dimension.toUpperCase()}`;
}

/**
 * Whether this process may serve with the configuration it was given.
 *
 * Pure. The one illegal state is admission still metering while doorbell
 * dispatch is off, and the ordering rule that follows is clear the ceilings
 * first, disable the doorbell second.
 *
 * All eight dimensions, deliberately, and not just the soft ones. Only a soft
 * ceiling ever returns `queue` from `decideFromUsage`, so only a soft ceiling
 * can strand a run that nothing then wakes -- but that is one of the two
 * reasons this pair is illegal, not the whole of it. With dispatch off, chat
 * never reaches admission at all, so a hard or tree ceiling meters DAG and task
 * work while interactive traffic walks straight past it: not the fleet ceiling
 * the operator configured. `assertAdmissionSettings()` runs on the line after
 * this one in `main()` and refuses those two for exactly that reason, so
 * narrowing this check to the soft dimensions would end no CrashLoopBackOff --
 * it would only trade this refusal's rollback instructions for a message that
 * does not carry them, and split the gate from admission-preflight.yaml and
 * from the R1/R6 procedure in claw/docs/doorbell-rollout.md, both of which
 * clear and verify the eight as one set.
 */
export function validateRolloutConfig(cfg: RolloutConfig): RolloutVerdict {
  if (cfg.doorbellDispatch) return { ok: true };
  const offending = ADMISSION_DIMENSIONS.filter((d) => cfg.ceilings[d] > 0);
  if (offending.length === 0) return { ok: true };
  return { ok: false, reason: "reverse_order", offending };
}

export function applyRolloutConfigGauges(cfg: RolloutConfig): void {
  metrics.setDoorbellDispatchEnabled(cfg.doorbellDispatch);
  for (const dimension of ADMISSION_DIMENSIONS) {
    metrics.setAdmissionEnforced(dimension, cfg.ceilings[dimension] > 0);
  }
}

export function readRolloutConfig(): RolloutConfig {
  return {
    doorbellDispatch: RUN_DOORBELL_DISPATCH,
    ceilings: {
      soft_runs: ADMIT_SOFT_RUNS,
      hard_runs: ADMIT_HARD_RUNS,
      soft_sandboxes: ADMIT_SOFT_SANDBOXES,
      hard_sandboxes: ADMIT_HARD_SANDBOXES,
      soft_gpu_nodes: ADMIT_SOFT_GPU_NODES,
      hard_gpu_nodes: ADMIT_HARD_GPU_NODES,
      tree_max_nodes: ADMIT_TREE_MAX_NODES,
      tree_max_depth: ADMIT_TREE_MAX_DEPTH,
    },
  };
}

/**
 * Publish the rollout gauges, then refuse to serve on an illegal configuration.
 *
 * The gauges are set before the verdict is enforced so that every pod which
 * did start exports all nine series. A pod that did not start exports nothing
 * at all -- `/metrics` is registered far below this call and the socket lower
 * still -- so the observable signal for a refusal is the fleet's pod count
 * falling short, not a gauge nobody can scrape.
 */
export function assertRolloutConfigAtStartup(cfg: RolloutConfig = readRolloutConfig()): void {
  applyRolloutConfigGauges(cfg);
  const verdict = validateRolloutConfig(cfg);
  if (verdict.ok) return;
  throw new Error(
    "run doorbell dispatch is off while admission is still metering: "
      + `${verdict.offending.map(envKeyOf).join(", ")} are non-zero. `
      + "Clear the admission ceilings first, disable RUN_DOORBELL_DISPATCH second.",
  );
}
