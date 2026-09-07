// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What happened to this shell, decided from evidence rather than from absence.
 *
 * Two facts drive most of it. A terminated process whose parent has not
 * collected its exit status keeps a process-table entry, so presence there is
 * not liveness and a finished-but-unreaped process needs an answer of its own.
 * And the registry's status field is set at spawn and changed only when the
 * exit event is delivered, so between termination and that delivery it still
 * reads running -- a caller must not be told `running` in that window.
 *
 * The epoch has three values, not two. Equality with the marker proves only
 * that no newer Hands has started; a crashed one leaves its marker exactly as
 * it wrote it. Where the marker's bearer cannot be observed either way the
 * epoch is indeterminate, and unresolved live work must not be converted into
 * `lost` on evidence nobody obtained.
 */

import type { ShellRecord } from "./shell-record.js";

export type ShellClass =
  | "running"
  | "unverified_running"
  | "spawn_indeterminate"
  | "ended_unreaped"
  | "finished"
  | "lost"
  | "inconsistent"
  | "unknown";

export type EpochFreshness = "current" | "stale" | "indeterminate";
/** What the in-process registry says, where it can be read at all. */
export type RegistryView = "running" | "absent" | "unreadable";
/** What a narrow read-only question to the operating system answered. */
export type ProcessView = "terminated" | "present" | "unreadable";

export interface ShellEvidence {
  record: ShellRecord;
  epoch: EpochFreshness;
  registry: RegistryView;
  process: ProcessView;
}

/**
 * The class blocking a destroy, for the counts §7.3 takes over the exec
 * channel. `ended_unreaped` is absent on purpose: a terminated process has no
 * work left to protect, and treating its lingering entry as live work would
 * hold sandboxes open indefinitely.
 */
export const PROTECTED_CLASSES: readonly ShellClass[] = [
  "running", "unverified_running", "spawn_indeterminate", "inconsistent", "lost",
];

export function classifyShellRecord(evidence: ShellEvidence): ShellClass {
  const { record, epoch, registry, process } = evidence;

  // The outcome phase is the only producer of `finished`: the exit status is
  // delivered to one party, and every other observation is an inference.
  if (record.status) return "finished";
  if (!record.process_identity) return "spawn_indeterminate";

  if (epoch === "indeterminate") return "unverified_running";
  if (epoch === "stale") {
    // Losing the collecting process loses the exit code permanently, so a
    // terminated process reads as ended and never as finished with a code
    // synthesised across the restart.
    return process === "terminated" ? "ended_unreaped" : "lost";
  }

  if (registry === "unreadable" || process === "unreadable") return "unverified_running";
  if (process === "terminated") return "ended_unreaped";
  if (registry === "running") return "running";
  // A current epoch, a live process and no registry entry for it is a state
  // this process should not be able to reach; it is reported as itself rather
  // than resolved into whichever neighbouring class is convenient.
  return "inconsistent";
}

/** What a caller is told. `inconsistent` is an operator fact, not a caller's. */
export function callerVisibleClass(cls: ShellClass): ShellClass {
  return cls === "inconsistent" ? "unknown" : cls;
}
