// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Hand back what this pod's previous process died holding, before taking work.
 *
 * A brain that exits through SIGTERM checkpoints its runs and gives back their
 * claims and locks on the way out (index.ts `beginShutdown`). One that crashes
 * does none of that, and its container is restarted in place under the same pod
 * name within seconds -- but until now the restarted process could not tell its
 * predecessor's runs from anybody else's, so they waited out the lock's TTL and
 * the reaper's grace: eleven minutes on 2026-11-06. The pod name is what both
 * processes share, and nothing else carries it, so:
 *
 *   1. locks naming this pod under another holder id are deleted (CAS on the
 *      revision read), and
 *   2. the API requeues doorbell rows still leased to this pod's BRAIN_ID.
 *
 * In that order, so a requeued row's next claim -- by this pod or another --
 * finds its lock free. Only when BRAIN_ID is the pod name (`incarnationPod`);
 * a local brain whose id other processes may share does nothing here.
 */
import pino from "pino";

import { incarnationPod, releaseLocksOfPreviousIncarnation } from "./lock.js";
import { apiBase, claimHeaders } from "../clients/run-claim.js";

const logger = pino({ name: "previous-incarnation" });

export interface PreviousIncarnationDeps {
  pod: string | undefined;
  releaseLocks: (pod: string) => Promise<number>;
  releaseRuns: (pod: string) => Promise<number>;
}

export async function postReleaseOrphans(brainId: string): Promise<number> {
  const base = apiBase();
  if (!base) return 0;
  const resp = await fetch(`${base}/v1/internal/runs/release-orphans`, {
    method: "POST",
    headers: claimHeaders(),
    body: JSON.stringify({ brain_id: brainId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`release-orphans ${resp.status}`);
  const body = await resp.json().catch(() => ({})) as { requeued?: unknown };
  return typeof body.requeued === "number" ? body.requeued : 0;
}

const DEFAULT_DEPS: PreviousIncarnationDeps = {
  get pod() { return incarnationPod(); },
  releaseLocks: releaseLocksOfPreviousIncarnation,
  releaseRuns: postReleaseOrphans,
};

/** Never throws: a start that cannot do this is merely as slow to recover as before. */
export async function reclaimPreviousIncarnation(
  deps: PreviousIncarnationDeps = DEFAULT_DEPS,
): Promise<{ locks: number; runs: number }> {
  const pod = deps.pod;
  if (!pod) return { locks: 0, runs: 0 };
  const locks = await deps.releaseLocks(pod);
  let runs = 0;
  try {
    runs = await deps.releaseRuns(pod);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), pod }, "brain.previous_incarnation.release_runs_failed");
  }
  if (locks || runs) logger.warn({ pod, locks, runs }, "brain.previous_incarnation.reclaimed");
  return { locks, runs };
}
