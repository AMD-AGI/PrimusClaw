// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

export * from "./types.js";
export * from "./subjects.js";
export * from "./user-env.js";
export * from "./task-consumer.js";
export * from "./run-lease.js";
export * from "./run-identity.js";
export * from "./run-time.js";
export * from "./topology.js";
export * from "./run-doorbell.js";
export * from "./sandbox/base32.js";
export * from "./sandbox/hands-key.js";
export * from "./sandbox/shell-record.js";
export * from "./sandbox/shell-classify.js";
// The one definition of what a published background-work verdict is and when
// it may still be believed. Exported from the package because the writer lives
// in Brain and one of the readers lives in the API, and a second copy of these
// rules is a defect waiting for the two to drift.
export {
  BG_VERDICT_TTL_MS,
  SHARED_VERDICT_FIELDS,
  measuredUnderThisIdlePeriod,
  reuseWindowStart,
  sameIdlePeriod,
  usableSharedVerdict,
  type BackgroundWork,
  type IdlePeriodFields,
  type SharedVerdictFields,
} from "./sandbox/bg-verdict.js";
export {
  parkHandsHandle,
  parkHandsAfterRun,
  applyRunEndedIdleFields,
  type ParkOutcome,
  type ParkResult,
  type RunEndedParkOutcome,
  type RunEndedParkResult,
  type RevisionedKv,
} from "./sandbox/park-hands.js";
// Shared because both sides read the same SaFE payload: Brain reads it when a
// sandbox dies under a live run, the API backfills it for a run whose worker
// died with it. Two copies of this reading would be two answers to "was it
// preempted".
export { platformFactsFromWorkloadDetail } from "./sandbox/platform-facts.js";
export type { PlatformFacts } from "./sandbox/platform-facts.js";
export { DagHandleMap, HANDLE_MAP_PREFIX } from "./sandbox/handle-map.js";
export type { HandleInfo } from "./sandbox/handle-map.js";
export { getHandleEntry, setHandleEntry } from "./sandbox/handle-map.js";
