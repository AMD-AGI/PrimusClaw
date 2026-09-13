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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { SHELL_GROUP_TOKEN_VAR } from "@claw/protocol";
import { nowMs } from "./clock.js";
import {
  PROTECTED_CLASSES, classifyShellRecord,
  type EpochFreshness, type ProcessView, type ShellClass,
} from "./shell-classify.js";
import {
  type ProcessIdentity, type ShellRecord, listAllRecords, listRecordsForOwner, processStartToken,
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

/**
 * Whether any process still belongs to `pid`'s group and is not a zombie.
 *
 * The leader's own state is not the answer -- a zombie leader with a live child
 * is exactly the case the orphan sweep is for -- so membership is read from the
 * process table, the same way `processGroupAlive` reads it for a shell this
 * process started.
 */
export function groupHasMember(pid: number, groupToken?: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue;
    }
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // state, ppid, pgid
    if (after[0] === "Z") continue;
    if (Number(after[2]) !== pid) continue;
    // The marker only ever *disconfirms*. A member that carries somebody else's
    // token is somebody else's, and that is the case worth catching: after the
    // leader is collected the pid is free, so a later group under the same
    // number is otherwise indistinguishable from the recorded one.
    //
    // It cannot be made to confirm. A child that sanitises its own environment
    // keeps running without the variable, and `/proc/<pid>/environ` is
    // unreadable across uids -- which configured child isolation makes the
    // ordinary case. Requiring the marker turned both of those into "this group
    // is dead", which is the defect this whole file exists to prevent. So
    // absent or unreadable means "not established", and the answer stays the
    // one the number alone was always given.
    if (groupToken !== undefined && carriesForeignToken(Number(entry), groupToken)) continue;
    return true;
  }
  return false;
}

/**
 * Whether one process demonstrably belongs to some *other* shell's group.
 *
 * True only on positive evidence: the marker was read, it is present, and it
 * names a different group. An unreadable environment and a missing marker both
 * answer `false` -- not because they are reassuring but because they establish
 * nothing, and a check that cannot be read must not be the reason live work is
 * abandoned or an orphan is left unsignalled.
 */
function carriesForeignToken(pid: number, token: string): boolean {
  let environ: string;
  try {
    environ = readFileSync(`/proc/${pid}/environ`, "utf8");
  } catch {
    return false;
  }
  const prefix = `${SHELL_GROUP_TOKEN_VAR}=`;
  const found = environ.split("\0").find((kv) => kv.startsWith(prefix));
  if (found === undefined) return false;
  return found !== `${prefix}${token}`;
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
      process: groupProcessView(record.process_identity),
    });
    classes[cls] = (classes[cls] ?? 0) + 1;
    if (PROTECTED_CLASSES.includes(cls)) active += 1;
  }
  return { active, classes, determinate: true };
}

/**
 * How many live shells the whole sandbox holds that the registry cannot name.
 *
 * The sandbox-wide counterpart of `unregisteredLiveRecords`, for the
 * concurrency limit: a slot is held by a shell whoever started it, and after a
 * restart every one of them is unregistered. Counting the map alone admitted a
 * fresh allowance beside work already running, once per restart.
 *
 * @returns zero when the subtree cannot be read, which is the same answer the
 *          per-owner form gives and carries the same caveat: not evidence of an
 *          idle sandbox.
 */
export function unregisteredLiveTotal(
  registryHas: (record: ShellRecord) => boolean,
): number {
  if (!subtreeReadable()) return 0;
  let records: ShellRecord[];
  try {
    records = listAllRecords();
  } catch {
    return 0;
  }
  let n = 0;
  for (const record of records) {
    if (registryHas(record)) continue;
    // The group first, because the leader's own state does not answer this
    // question. `sleep 600 &` leaves its sleep in the group and returns; once
    // that leader is collected it has no `/proc` entry, so classification sees
    // `terminated` and answers `ended_unreaped` -- a class kept out of the
    // protected set on the grounds that a terminated process has no work left
    // to protect. True of the leader, false of the shell: the group is still
    // holding the sandbox's CPU, and a count that missed it admitted a fresh
    // full allowance beside every group a restart left behind.
    //
    // The same rule the orphan sweep uses, and it has to be the same one: a
    // readable token that differs is a recycled pid and is refused, while an
    // unreadable one falls back to the question a reaped leader still answers.
    //
    // A record that already carries an outcome is excluded first, because this
    // branch answers ahead of classification and would otherwise skip the one
    // exclusion classification makes before any other: the outcome phase is the
    // only producer of `finished`, and a shell that has one is over. Its pid is
    // free, and a later group under that number would otherwise be counted as
    // this record's own work -- a finished shell holding a slot against the
    // live one that inherited its number.
    if (record.status) continue;
    if (groupAliveUnderIdentity(record.process_identity)) {
      n += 1;
      continue;
    }
    const cls = classifyShellRecord({
      record,
      epoch: epochFreshness(record.hands_epoch),
      registry: "absent",
      process: groupProcessView(record.process_identity),
    });
    if (PROTECTED_CLASSES.includes(cls) && record.process_identity !== undefined) n += 1;
  }
  return n;
}

/**
 * Whether the recorded identity's process group still has a live member.
 *
 * Shared by the sandbox-wide count and the orphan sweep so the two cannot drift
 * apart: one deciding a group is live work while the other declines to signal
 * it is how a slot comes to be held by something nothing will ever release.
 */
/**
 * The recorded identity's state, answered about its group rather than its
 * leader.
 *
 * `processView` is about one pid, and classification tests `terminated` before
 * it consults the registry at all -- so a shell whose leader exited into a
 * living group was classified `ended_unreaped` while its registry entry
 * correctly still read `running`. Two surfaces then contradicted each other
 * over the same shell in the same second: `wait` said still running and
 * `bash_output` said ended, and a caller reading the second stops waiting for
 * work that is still going.
 *
 * Only the terminated answer is revisited. `present` and `unreadable` already
 * say what they mean, and widening either of them would be a different rule
 * than the one this needs.
 */
function groupProcessView(identity: ProcessIdentity | undefined): ProcessView {
  const view = processView(identity);
  if (view !== "terminated") return view;
  return groupAliveUnderIdentity(identity) ? "present" : "terminated";
}

export function groupAliveUnderIdentity(identity: ProcessIdentity | undefined): boolean {
  if (!identity) return false;
  const token = processStartToken(identity.pid);
  if (token && token !== identity.startToken) return false;
  // A readable, matching token settles it: the leader is the one recorded, so
  // its group is the recorded group. Where the leader has been collected there
  // is nothing left to read, and the pid number on its own cannot distinguish
  // this group from a later one that happens to have been given the same
  // number -- so the group token decides, and a record old enough not to carry
  // one keeps the weaker answer it was always given rather than losing its
  // group to a check that did not exist when it was written.
  if (token) return groupHasMember(identity.pid);
  return groupHasMember(identity.pid, identity.groupToken);
}

/**
 * The owner's live shells that this process's registry cannot address.
 *
 * `ownerLiveness` counts these -- that is the whole reason it reads records
 * rather than the map -- but counting was as far as it went: `kill_shell` and
 * `shutdownAllShells` looked only at the registry, so a child that outlived a
 * Hands restart answered "one still running" and then "nothing was signalled".
 * A conversation shell has no run identity either, so the per-run shutdown
 * could not reach it from the other side.
 *
 * Identity is the record's, not a bare pid: `processView` checks the start
 * token before it answers, so a pid the kernel has since handed to something
 * else reads as terminated here rather than being signalled.
 *
 * @returns the records worth signalling, empty when the subtree cannot be read
 *          -- an unreadable store is not evidence that nothing is running, and
 *          the caller must not treat it as a clean sandbox.
 */
/**
 * Every live shell in the sandbox the registry cannot address, as records.
 *
 * The list form of `unregisteredLiveTotal`, and the one shutdown needs. Its
 * first version derived the owners to sweep from the in-process map, which is
 * empty after exactly the restart that leaves these records behind -- so it
 * examined nothing and signalled nothing in the one situation it was written
 * for. The records are the input; the map only says which of them are already
 * addressable.
 */
export function allUnregisteredLiveRecords(
  registryHas: (record: ShellRecord) => boolean,
): ShellRecord[] {
  if (!subtreeReadable()) return [];
  let records: ShellRecord[];
  try {
    records = listAllRecords();
  } catch {
    return [];
  }
  return records.filter((record) => {
    if (registryHas(record)) return false;
    // Identity first, liveness second -- and they are different questions.
    //
    // Classification can answer `unverified_running` on an indeterminate epoch,
    // and that answer is about the *record*, not about the pid: acting on it
    // let the sweep signal a group that merely inherited a recycled pid, the
    // start token having said so and been outvoted. So the token is checked
    // here and is not advisory; killing somebody else's work is the cost of
    // getting it wrong.
    //
    // But `processView` answers `terminated` for a zombie leader, and a zombie
    // leader is the ordinary shape of a group that outlived it -- which is
    // precisely the group this sweep exists to reach. Gating on `present`
    // alone excluded them, and left running what the previous implementation
    // killed. The group is the unit: a leader whose identity matches and whose
    // group still has a member is a target whatever the leader's own state.
    const identity = record.process_identity;
    if (!identity) return false;
    // Same rule the escalation uses, and it has to be the same rule: a leader
    // that has been reaped has no token to read, and requiring one here dropped
    // its record before the escalation's own fallback could ever apply. A
    // readable token that differs is a different process and is refused; an
    // unreadable one falls back to the question a reaped leader still answers,
    // which is whether its group has a member. A pid number stays reserved
    // while it does, so a live group under that number is not a recycled one.
    if (!groupAliveUnderIdentity(identity)) return false;
    // The group is alive under the recorded identity, which is the whole of the
    // question here: classification's remaining job is to exclude records that
    // are not this sweep's to act on at all.
    const cls = classifyShellRecord({
      record,
      epoch: epochFreshness(record.hands_epoch),
      registry: "absent",
      process: "present",
    });
    return PROTECTED_CLASSES.includes(cls);
  });
}

export function unregisteredLiveRecords(
  owner: string,
  registryHas: (record: ShellRecord) => boolean,
): ShellRecord[] {
  if (!subtreeReadable()) return [];
  let records: ShellRecord[];
  try {
    records = listRecordsForOwner(owner);
  } catch {
    return [];
  }
  return records.filter((record) => {
    if (registryHas(record)) return false;
    const cls = classifyShellRecord({
      record,
      epoch: epochFreshness(record.hands_epoch),
      registry: "absent",
      process: groupProcessView(record.process_identity),
    });
    return PROTECTED_CLASSES.includes(cls) && record.process_identity !== undefined;
  });
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
    process: groupProcessView(record.process_identity),
  });
  return { cls, collectorLive: cls === "ended_unreaped" && epoch === "current" && registryHas(record), record };
}
