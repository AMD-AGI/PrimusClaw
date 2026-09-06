// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Durable identity for one background shell, written by Hands inside the
 * sandbox and by nothing else.
 *
 * The in-process registry dies with the process, so after a restart "nothing is
 * tracked" and "nothing is running" become one answer -- and an empty registry
 * then reads as licence to destroy a container with live work in it. These
 * records are what separate the two. They live outside the user workspace so a
 * workspace sync cannot carry them out or overwrite them, and they are readable
 * over a container-exec channel with no Hands running, which is the case where
 * the question actually matters.
 *
 * Four durable phases, each committed before the next begins, because a process
 * identifier cannot exist before the process does and a crash may land between
 * any two. A claim with no attachment and a claim with an attachment but no
 * outcome are different facts, and the classifier gives each its own answer.
 */

import { randomUUID } from "node:crypto";
import {
  type Dirent,
  existsSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ABSENT_RUN, NO_RUN_SEGMENT, type RunPart, componentsMatch, recordComponents,
} from "./record-path.js";

export type ShellRecordStatus = "exited" | "killed" | "failed";

export interface ProcessIdentity {
  /** The operating-system process identifier. */
  pid: number;
  /**
   * The kernel-supplied start-time token, paired with the identifier because
   * the identifier alone is reusable after wraparound. A lookup matching the
   * identifier and not the token is a non-match, never a weaker match.
   */
  startToken: string;
}

export interface ShellRecord {
  owner_scope: string;
  /** Null is the typed absence of N4.1.2a.3, distinct from every string. */
  run_identity: string | null;
  shell_id: string;
  intent_key?: string;
  command_digest: string;
  kind: "background" | "monitor";
  claimed_at: string;
  hands_epoch: string;
  deadline_at?: string;
  process_identity?: ProcessIdentity;
  spawned_at?: string;
  status?: ShellRecordStatus;
  exit_code?: number | null;
  signal?: string | null;
  ended_at?: string;
  output_available?: boolean;
  retain_until?: string;
}

/** Where the subtree lives. Outside /workspace, and Hands-owned. */
export function stateRoot(): string {
  return process.env.HANDS_STATE_DIR || "/var/lib/claw-hands";
}

const SCOPES = "scopes";
const INTENTS = "intents";
/** Fixed names sit at the root, never under `scopes/`, so no encoded segment
 *  can collide with one. */
const EPOCH_MARKER = "epoch.json";
const STAGING = "staging";

export interface EpochMarker {
  epoch: string;
  bearer: ProcessIdentity;
}

let mintedEpoch: EpochMarker | null = null;

/**
 * The kernel-supplied start-time token for a process, paired with its
 * identifier everywhere so a wrapped-around identifier cannot pass as a weaker
 * match. Empty where the process state cannot be read, which every caller
 * treats as unreadable rather than as a match.
 */
export function processStartToken(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
  } catch {
    return "";
  }
}

/**
 * Mint this process's epoch and persist it beside the record subtree.
 *
 * The marker names a bearer that can be checked rather than only a value that
 * can be compared: a crashed Hands leaves its last marker exactly as it wrote
 * it, so equality alone proves only that no newer process has started.
 */
export function mintEpoch(bearer: ProcessIdentity): EpochMarker {
  const marker: EpochMarker = { epoch: randomUUID(), bearer };
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  atomicWrite(join(stateRoot(), EPOCH_MARKER), marker);
  mintedEpoch = marker;
  return marker;
}

export function currentEpoch(): EpochMarker | null {
  return mintedEpoch;
}

/** The marker as it is on disk, or null where none has been written. */
export function readEpochMarker(): EpochMarker | null {
  try {
    return JSON.parse(readFileSync(join(stateRoot(), EPOCH_MARKER), "utf8")) as EpochMarker;
  } catch {
    return null;
  }
}

function atomicWrite(path: string, value: unknown): void {
  const dir = join(stateRoot(), STAGING);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(dir, "w-"));
  const staged = join(tmp, "v");
  writeFileSync(staged, JSON.stringify(value), { mode: 0o600 });
  renameSync(staged, path);
  rmSync(tmp, { recursive: true, force: true });
}

function recordPath(owner: string, run: RunPart, shellId: string): string {
  return join(stateRoot(), SCOPES, ...recordComponents(owner, run, shellId));
}

function intentPath(owner: string, run: RunPart, intentKey: string): string {
  return join(stateRoot(), INTENTS, ...recordComponents(owner, run, intentKey));
}

const asRunPart = (run: string | null): RunPart => (run === null ? ABSENT_RUN : run);

/**
 * Phase 1 -- the claim, durable before anything is spawned.
 *
 * An exclusive create, which is this design's whole arbitration primitive: two
 * writers racing one triple cannot both win, so no update is lost and no second
 * process is started for one intent. Returns false where the record already
 * exists; the caller resolves against it rather than spawning.
 */
export function claimRecord(record: ShellRecord): boolean {
  const path = recordPath(record.owner_scope, asRunPart(record.run_identity), record.shell_id);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  if (record.intent_key) {
    const link = intentPath(record.owner_scope, asRunPart(record.run_identity), record.intent_key);
    mkdirSync(join(link, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(link, record.shell_id, { mode: 0o600 });
  }
  return true;
}

function amend(
  owner: string, run: string | null, shellId: string,
  change: (record: ShellRecord) => ShellRecord,
): void {
  const path = recordPath(owner, asRunPart(run), shellId);
  const current = JSON.parse(readFileSync(path, "utf8")) as ShellRecord;
  atomicWrite(path, change(current));
}

/** Phase 2 -- the attachment, written once the process exists. */
export function attachRecord(
  owner: string, run: string | null, shellId: string, identity: ProcessIdentity,
): void {
  amend(owner, run, shellId, (r) => ({
    ...r, process_identity: identity, spawned_at: new Date().toISOString(),
  }));
}

/**
 * Phase 3 -- the outcome, appended only after the parent has collected the
 * exit status. `retain_until` is fixed by this write from the deadline the
 * claim carried, and an absent deadline never expires.
 */
export function recordOutcome(
  owner: string, run: string | null, shellId: string,
  outcome: { status: ShellRecordStatus; exitCode: number | null; signal: string | null },
): void {
  amend(owner, run, shellId, (r) => ({
    ...r,
    status: outcome.status,
    exit_code: outcome.exitCode,
    signal: outcome.signal,
    ended_at: new Date().toISOString(),
    output_available: true,
    ...(r.deadline_at ? { retain_until: r.deadline_at } : {}),
  }));
}

/**
 * Phase 4 -- the buffer release, written by the process whose own state it
 * reports as it drops the buffers. Separate from the outcome because the two
 * are separated by the reap delay, so a value written at exit would be stale
 * for that whole delay and wrong afterwards.
 */
export function releaseOutput(owner: string, run: string | null, shellId: string): void {
  try {
    amend(owner, run, shellId, (r) => ({ ...r, output_available: false }));
  } catch { /* the record is gone with its sandbox; nothing to release */ }
}

/**
 * Read one record, rejecting one whose own fields do not reproduce its path.
 *
 * The check is what makes the encoding's injectivity load-bearing rather than
 * assumed: a record hand-written into another triple's location fails it.
 */
export function readRecord(
  owner: string, run: string | null, shellId: string,
): ShellRecord | null {
  const runPart = asRunPart(run);
  let raw: string;
  try {
    raw = readFileSync(recordPath(owner, runPart, shellId), "utf8");
  } catch {
    return null;
  }
  const record = JSON.parse(raw) as ShellRecord;
  const onDisk = recordComponents(owner, runPart, shellId);
  return componentsMatch(onDisk, record.owner_scope, asRunPart(record.run_identity), record.shell_id)
    ? record
    : null;
}

/** The shell id this run already committed to for an intent, if any. */
export function resolveIntent(
  owner: string, run: string | null, intentKey: string,
): string | null {
  try {
    return readFileSync(intentPath(owner, asRunPart(run), intentKey), "utf8") || null;
  } catch {
    return null;
  }
}

/**
 * Every record filed under one owner scope, across all of its run identities.
 *
 * Throws where the subtree exists and cannot be walked: an unreadable subtree
 * is not an empty one, and a caller deciding whether a sandbox still holds live
 * work must not read the first as the second.
 */
export function listRecordsForOwner(owner: string): ShellRecord[] {
  const root = join(stateRoot(), SCOPES, ...ownerComponents(owner));
  const out: ShellRecord[] = [];
  walkRecords(root, out);
  return out;
}

/** Raised where a record exists and cannot be used. Never a smaller count. */
export class UnreadableRecord extends Error {}

/** The owner's own path components, taken from a triple whose other parts are
 *  fixed, so the chunking rule is applied in exactly one place. */
function ownerComponents(owner: string): string[] {
  const components = recordComponents(owner, ABSENT_RUN, "x");
  return components.slice(0, components.indexOf(NO_RUN_SEGMENT));
}

function walkRecords(dir: string, out: ShellRecord[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRecords(path, out);
      continue;
    }
    // Raised, not skipped. A record that cannot be read may be the live shell,
    // and dropping it lets the count come back a determinate zero -- which is
    // the sandbox being reclaimed on the strength of a file nobody could open.
    // The writer is atomic, so a torn read is a fault worth surfacing.
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      throw new UnreadableRecord(`record ${path} could not be read: ${(e as Error).message}`);
    }
    try {
      out.push(JSON.parse(raw) as ShellRecord);
    } catch (e) {
      throw new UnreadableRecord(`record ${path} is not a record: ${(e as Error).message}`);
    }
  }
}

/**
 * Whether the record subtree can be read at all.
 *
 * An unreadable subtree is not a count of zero. Reading it as one is the empty
 * -state inference that lets a destroy proceed over live work, so every caller
 * that would act on an absence has to be able to tell the two apart.
 */
export function subtreeReadable(): boolean {
  const scopes = join(stateRoot(), SCOPES);
  if (!existsSync(scopes)) return existsSync(stateRoot());
  try {
    opendirSync(scopes).closeSync();
    return true;
  } catch {
    return false;
  }
}
