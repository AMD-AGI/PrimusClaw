// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How much live background work a sandbox still holds.
 *
 * The in-process registry cannot answer this after a restart. Background
 * children are spawned detached precisely so they survive the request that
 * started them, and they survive the Hands process too -- but the map that knew
 * their identifiers died with it. Asked that map, a sandbox with a training run
 * still writing answers zero, the keepalive sweep files it idle, and the
 * control plane reclaims the pod out from under the work.
 *
 * So the count is taken over the durable records, with the registry as one
 * input among several rather than as the answer. A record whose process is
 * still alive under a stale epoch is exactly the orphan case: nobody can
 * collect its exit status any more, which is a reason to report it honestly and
 * not a reason to stop protecting it.
 */

import { existsSync, readFileSync } from "node:fs";
import { nowMs } from "./clock.js";
import {
  PROTECTED_CLASSES, classifyShellRecord,
  type EpochFreshness, type ProcessView, type ShellClass,
} from "./shell-classify.js";
import {
  type ProcessIdentity, type ShellRecord, listRecordsForOwner, processStartToken,
  readEpochMarker, readRecord, subtreeReadable,
} from "./shell-records.js";

export { bindClock, nowMs } from "./clock.js";

export interface OwnerLiveness {
  /** Records in a class that blocks reclamation. */
  active: number;
  /** Per-class tally, for operator telemetry. */
  classes: Partial<Record<ShellClass, number>>;
  /** False where the subtree could not be read, which is never a count of zero. */
  determinate: boolean;
}

/**
 * Whether a process is alive, and whether it is the one the record names.
 *
 * The identifier alone is reusable after wraparound, so a match on it without
 * the start-time token is a non-match rather than a weaker match: the entry
 * belongs to some later process and says nothing about this shell.
 */
export function processView(identity: ProcessIdentity | undefined): ProcessView {
  if (!identity) return "unreadable";
  if (!existsSync(`/proc/${identity.pid}`)) return "terminated";
  const token = processStartToken(identity.pid);
  if (!token) return "unreadable";
  if (token !== identity.startToken) return "terminated";
  return readProcessState(identity.pid);
}

/** A terminated-but-unreaped entry is still present, so presence is not life. */
function readProcessState(pid: number): ProcessView {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state === "Z" ? "terminated" : "present";
  } catch {
    return "unreadable";
  }
}

/**
 * How fresh the epoch a record was written under is.
 *
 * Equality with the marker proves only that no newer Hands has started, so it
 * is necessary and not sufficient; currency turns on the marker's bearer being
 * observed alive. A bearer whose liveness cannot be established is neither
 * current nor stale, and reading it as stale would convert unresolved live work
 * into a class that unblocks a destroy.
 */
/**
 * Whether a terminal outcome is still within the window its run's deadline
 * fixed.
 *
 * A record with no durable outcome has no expiry at all: a still-running shell
 * held past any window its run gives still answers on its own evidence. A
 * tombstone with no `retain_until` is kept for the sandbox's life, which is the
 * fallback for a start that carried no deadline -- never a substituted
 * constant, which would age out a run still reading it.
 */
export function outcomeExpired(record: ShellRecord): boolean {
  if (!record.status || !record.retain_until) return false;
  const until = Date.parse(record.retain_until);
  return Number.isFinite(until) && nowMs() > until;
}

export function epochFreshness(recordEpoch: string): EpochFreshness {
  const marker = readEpochMarker();
  if (!marker) return "indeterminate";
  if (marker.epoch !== recordEpoch) return "stale";
  const bearer = processView(marker.bearer);
  if (bearer === "unreadable") return "indeterminate";
  return bearer === "present" ? "current" : "stale";
}

/**
 * Count the live work one owner scope still holds.
 *
 * `registryHas` is the in-process view, passed in rather than imported so this
 * module stays a leaf the manager can use without a cycle.
 */
export function ownerLiveness(
  owner: string,
  registryHas: (record: ShellRecord) => boolean,
): OwnerLiveness {
  if (!subtreeReadable()) return { active: 0, classes: {}, determinate: false };

  let records: ShellRecord[];
  try {
    records = listRecordsForOwner(owner);
  } catch {
    return { active: 0, classes: {}, determinate: false };
  }

  const classes: Partial<Record<ShellClass, number>> = {};
  let active = 0;
  for (const record of records) {
    const cls = classifyShellRecord({
      record,
      epoch: epochFreshness(record.hands_epoch),
      registry: registryHas(record) ? "running" : "absent",
      process: processView(record.process_identity),
    });
    classes[cls] = (classes[cls] ?? 0) + 1;
    if (PROTECTED_CLASSES.includes(cls)) active += 1;
  }
  return { active, classes, determinate: true };
}

/**
 * What one shell's record says about it, with the qualifier that decides
 * whether waiting on it can still resolve.
 *
 * `collectorLive` is true only where this very process is the one owing the
 * exit status: the epoch is current and the registry still holds the entry, so
 * the exit event is pending delivery and the class resolves to `finished`
 * without anybody re-asking. A grandchild re-parented away from Hands never
 * reaches that state and is answered by evidence alone.
 */
export interface ShellVerdict {
  cls: ShellClass;
  collectorLive: boolean;
  record: ShellRecord;
}

/**
 * Whether this owner holds the id under some other run identity.
 *
 * Bounded to the caller's own owner scope: establishing the same about another
 * owner would mean walking their subtree, which is the read the boundary exists
 * to prevent. So an id held by a different owner is `unknown_id` here, and the
 * distinction is only ever as good as one scope's own view.
 */
function heldUnderAnotherRun(owner: string, run: string | null, shellId: string): boolean {
  try {
    return listRecordsForOwner(owner).some(
      (r) => r.shell_id === shellId && (r.run_identity ?? null) !== run,
    );
  } catch {
    return false;
  }
}

/**
 * Which absence this is, for the operator surface.
 *
 * Never for a caller: `callerVisibleClass` collapses both into one answer,
 * because being able to tell an id that exists elsewhere from one that exists
 * nowhere is the existence disclosure the shared refusal closes.
 */
export function absenceClass(owner: string, run: string | null, shellId: string): ShellClass {
  if (!subtreeReadable()) return "unknown_id";
  return heldUnderAnotherRun(owner, run, shellId) ? "wrong_scope" : "unknown_id";
}

/** Null where no record exists for the triple, which is not a class. */
export function shellVerdict(
  owner: string,
  run: string | null,
  shellId: string,
  registryHas: (record: ShellRecord) => boolean,
): ShellVerdict | null {
  if (!subtreeReadable()) return null;
  let record: ShellRecord | null;
  try {
    record = readRecord(owner, run, shellId);
  } catch {
    return null;
  }
  // A tombstone past its retention answers as an absence, byte for byte like
  // an id never issued: the evidence is gone, and inventing an answer from a
  // record nobody may rely on any more is worse than saying nothing.
  if (!record || outcomeExpired(record)) return null;

  const epoch = epochFreshness(record.hands_epoch);
  const cls = classifyShellRecord({
    record,
    epoch,
    registry: registryHas(record) ? "running" : "absent",
    process: processView(record.process_identity),
  });
  return { cls, collectorLive: cls === "ended_unreaped" && epoch === "current" && registryHas(record), record };
}
