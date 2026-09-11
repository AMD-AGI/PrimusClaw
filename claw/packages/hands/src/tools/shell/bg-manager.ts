// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Background shell manager for Hands.
 * Spawns detached processes, tracks output in ring buffers,
 * provides poll/kill lifecycle for bash_output and kill_shell tools.
 *
 * Two properties this file is responsible for:
 *
 * Every shell has an owner. The registry is process-global while a sandbox can
 * be handed to a new run, so a map keyed by shell id alone let whoever came
 * next read the previous occupant's output and kill its processes -- and it
 * meant a caller-chosen `shell_id` collided across runs, which surfaced as
 * "Shell build already exists" for a shell the caller had never started.
 * Entries are keyed by owner and id together, so an id is private to its owner
 * and two owners may both use the obvious name.
 *
 * Nothing spawns while the feature is off. The refusal lives here rather than
 * in the three tools, because here is the only way to reach a process.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  MAX_REAP_GRACE_MS, MIN_REAP_GRACE_MS, isReapGrace,
  type ReapOutcome, type ReapReport, type ReapedShell,
} from "@claw/protocol";
import { BG_SHELL_ENABLED } from "../../config.js";
import { NO_RUN, currentDeadline } from "../../runtime/owner-context.js";
import { assertShellId } from "../../runtime/record-path.js";
import {
  attachRecord, claimRecord, currentEpoch, processStartToken,
  listRecordsForOwner, readRecord, recordOutcome, releaseOutput,
  type ProcessIdentity, type ShellRecord, type ShellRecordStatus,
} from "../../runtime/shell-records.js";
import {
  absenceClass, outcomeExpired, ownerLiveness, shellVerdict,
} from "../../runtime/shell-liveness.js";
import { callerVisibleClass, type ShellClass } from "../../runtime/shell-classify.js";
import {
  type ManagedShell,
  type ManagedShellKind,
  type ManagedShellStatus,
  logShellEvent,
  pollManagedOutput,
  processGroupAlive,
  spawnManagedShell,
  terminateManagedProcess,
} from "./process-runner.js";

const BG_SHELL_MAX_CONCURRENT = parseInt(process.env.BG_SHELL_MAX_CONCURRENT || "16", 10);
const BG_SHELL_BUFFER_BYTES = parseInt(process.env.BG_SHELL_BUFFER_BYTES || "1048576", 10);
/** Grace period between a background shell exiting and being removed from the
 *  registry. Lets the watchdog deliver the completion notification first. */
const BG_SHELL_REAP_DELAY_MS = parseInt(process.env.BG_SHELL_REAP_DELAY_MS || "60000", 10);
const DEFAULT_REAP_GRACE_MS = 2_000;

/**
 * How long a reaped shell is given between the signal and the escalation.
 *
 * Brain decides and Hands executes: a caller overrides it per request, and this
 * is what applies when none does. A configured value outside the domain is
 * refused at startup rather than substituted: substituting is the silent
 * shortening the domain exists to forbid, and an operator who set a number has
 * to learn it was not the one in force.
 */
export const REAP_GRACE_MS = configuredGrace(process.env.BG_SHELL_REAP_GRACE_MS);

function configuredGrace(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REAP_GRACE_MS;
  const value = Number(raw);
  if (!isReapGrace(value)) {
    throw new Error(
      `BG_SHELL_REAP_GRACE_MS=${raw} is outside the accepted range `
      + `[${MIN_REAP_GRACE_MS}, ${MAX_REAP_GRACE_MS}] of whole milliseconds`,
    );
  }
  return value;
}

export type BgShellKind = Extract<ManagedShellKind, "background" | "monitor">;
export type BgShellStatus = ManagedShellStatus;
export type BgShell = ManagedShell;

/** Shown to the model, so it says what to do instead of just refusing. */
export const BG_SHELL_DISABLED_MESSAGE =
  "background shells are disabled in this deployment (BG_SHELL_ENABLED). "
  + "Run the command in the foreground with a suitable bash timeout instead.";

/** What a start answers with: the shell, and whether this call is the one that
 *  produced it. A machine-readable field rather than an inference from wording. */
export interface BgStart {
  shell?: BgShell;
  shellId?: string;
  resolution: "first_call" | "deduplicated" | "retry_expired";
}

interface BgEntry {
  owner: string;
  /**
   * The single run that started this shell, or NO_RUN when nothing claimed it.
   *
   * Recorded alongside the owner rather than instead of it because the two
   * answer different questions: the owner decides who may address the shell and
   * outlives one run on purpose, while this is what lets a run that ends take
   * its own processes with it. A shell with no run is reaped only at shutdown.
   */
  run: string;
  shell: BgShell;
}

/**
 * Keyed by owner scope, run identity and id together. The separator is a NUL,
 * which `normalizeOwner` and `normalizeRun` refuse in either scope and which no
 * shell id can contain either, so one entry can never be addressed as another.
 *
 * The run is part of the address rather than only a reaping key: two runs under
 * one owner scope -- a later message in a conversation, a sibling node under one
 * graph root -- are as separate as two owner scopes, and neither may read, wait
 * on, or terminate the other's shells. A start that presented no run identity
 * sits in its own bucket that no run identity can name.
 */
const shells = new Map<string, BgEntry>();

function regKey(owner: string, run: string, id: string): string {
  return `${owner}\u0000${run}\u0000${id}`;
}

function lookup(owner: string, run: string, id: string): BgShell | undefined {
  return shells.get(regKey(owner, run, id))?.shell;
}

/** The run identity as the record subtree files it: absent, not empty. */
const recordRun = (run: string): string | null => (run === NO_RUN ? null : run);

/**
 * Whether this process files durable records at all.
 *
 * A process either does or it does not, and the epoch marker is the positive
 * discriminator: one that mints none is pre-scheme, its shells registry-only,
 * and no class is overlaid on them.
 */
function filesRecords(): boolean {
  return currentEpoch() !== null;
}

/** Spawn a background shell process owned by `owner` and started by `run`. */
export function spawnBackground(
  owner: string,
  run: string,
  command: string,
  shellId?: string,
  kind: BgShellKind = "background",
): BgStart {
  if (!BG_SHELL_ENABLED) throw new Error(BG_SHELL_DISABLED_MESSAGE);
  // Running entries only. An exited shell stays in the registry for one reap
  // delay so its final output is still pollable, and counting those against the
  // cap let a sandbox that had finished every command refuse the next one for
  // the length of that window.
  if (runningShells().length >= BG_SHELL_MAX_CONCURRENT) {
    throw new Error(`Background shell limit reached (max ${BG_SHELL_MAX_CONCURRENT})`);
  }
  if (shellId) assertShellId(shellId);

  const id = shellId || `bg-${randomUUID().slice(0, 8)}`;
  const key = regKey(owner, run, id);
  // An entry is a collision while its process is running. An exited one stays
  // for a reap delay so its last output remains pollable, which is not the same
  // fact: where records are filed the record decides, and refusing here would
  // answer a replay inside that window with a collision instead of the
  // resolution its record already fixes. A process filing no records has only
  // the registry, so there any entry is the answer.
  const registered = shells.get(key);
  const collides = filesRecords() ? registered?.shell.status === "running" : !!registered;
  if (collides) throw new Error(`Shell ${id} already exists`);
  // The claim is durable before anything is spawned, and its exclusive create
  // is the arbiter: a start that lost it never reaches a process.
  if (!claimShell(owner, run, id, command, kind)) {
    // A replay whose tombstone has aged out is not a first call: what happened
    // is no longer knowable, and running the command a second time is the one
    // answer the whole scheme exists to avoid. Reported as its own resolution
    // rather than as a collision the caller might retry past.
    if (expiredTombstone(owner, run, id)) {
      return { shellId: id, resolution: "retry_expired" };
    }
    throw new Error(`Shell ${id} already exists`);
  }

  const shell = spawnManagedShell(command, {
    id,
    kind,
    bufferBytes: BG_SHELL_BUFFER_BYTES,
    unref: true,
    owner,
    run,
  });
  shells.set(key, { owner, run, shell });

  // Auto-reap finished shells so the concurrency cap cannot be saturated by
  // long-lived monitor/background entries that already exited. The delay keeps
  // the final output pollable for one grace window after exit.
  //
  // Installed before the attachment, which can fail: a shell left with no exit
  // handler is one whose outcome is never written and whose entry is never
  // dropped, on top of whatever the attachment failure already cost.
  shell.process.once("exit", () => {
    const durable = persistOutcome(owner, run, shell);
    const t = setTimeout(() => {
      const current = shells.get(key);
      // An outcome that never reached the record exists only in this entry, so
      // dropping it is the loss itself rather than the tidy-up it is otherwise.
      if (durable && current && current.shell.status !== "running") {
        shells.delete(key);
        if (filesRecords()) releaseOutput(owner, recordRun(run), shell.id);
      }
    }, BG_SHELL_REAP_DELAY_MS);
    t.unref?.();
  });
  attachSpawned(owner, run, shell);

  return { shell, resolution: "first_call" };
}

function claimShell(
  owner: string, run: string, id: string, command: string, kind: BgShellKind,
  deadline = currentDeadline(),
): boolean {
  if (!filesRecords()) return true;
  return claimRecord({
    owner_scope: owner,
    run_identity: recordRun(run),
    shell_id: id,
    command_digest: commandDigest(owner, run, command),
    kind,
    claimed_at: new Date().toISOString(),
    hands_epoch: currentEpoch()!.epoch,
    // Fixed here rather than at the outcome, so the window a tombstone is kept
    // for comes from the run's own deadline and not from whenever it finished.
    ...(deadline ? { deadline_at: deadline } : {}),
  });
}

/**
 * A canonical, non-reversible digest of the command, scoped to the pair that
 * issued it.
 *
 * The raw text is never stored: a command routinely carries credential and
 * launch-specification material in its arguments. Both scopes are inputs rather
 * than a salt alone, because one sandbox serves several owners over its life
 * and a shared salt would digest one command identically for all of them.
 */
function commandDigest(owner: string, run: string, command: string): string {
  return createHash("sha256")
    .update(commandSalt()).update("\u0000")
    .update(owner).update("\u0000")
    .update(run).update("\u0000")
    .update(command)
    .digest("hex");
}

let salt: string | null = null;
function commandSalt(): string {
  if (!salt) salt = process.env.HANDS_RECORD_SALT || randomUUID();
  return salt;
}

/** Raised where a start ran but its durable phase could not be written. */
export class ShellStartNotDurable extends Error {}

/**
 * @throws ShellStartNotDurable where the attachment could not be written. The
 * process is running and its entry stands, so the caller can poll or terminate
 * it under the same id; what it may not do is report the start as made, since
 * the record stays claim-only and classifies as `spawn_indeterminate` for the
 * rest of the sandbox's life.
 */
function attachSpawned(owner: string, run: string, shell: BgShell): void {
  if (!filesRecords() || !shell.pid) return;
  const identity: ProcessIdentity = { pid: shell.pid, startToken: processStartToken(shell.pid) };
  try {
    attachRecord(owner, recordRun(run), shell.id, identity);
  } catch (err) {
    logShellEvent("shell.attachment_not_durable", shell, {
      level: 50, err: (err as Error)?.message ?? String(err),
    });
    throw new ShellStartNotDurable(
      `background shell ${shell.id} was started but its attachment could not be `
      + `recorded (${(err as Error)?.message ?? String(err)}); it is running and can `
      + "be polled or terminated under that id",
    );
  }
}

/** @returns false where the terminal outcome could not be made durable. */
function persistOutcome(owner: string, run: string, shell: BgShell): boolean {
  if (!filesRecords()) return true;
  try {
    recordOutcome(owner, recordRun(run), shell.id, {
      status: shell.status === "killed" ? "killed" : shell.status === "exited" ? "exited" : "failed",
      exitCode: shell.exitCode ?? null,
      signal: shell.signal ?? null,
    });
    return true;
  } catch (err) {
    logShellEvent("shell.outcome_not_durable", shell, {
      level: 50, err: (err as Error)?.message ?? String(err),
    });
    return false;
  }
}

/**
 * The one answer a caller gets for an id that names nothing it may address.
 *
 * Carries no id and no reason. An id belonging to another owner scope, another
 * run identity, another session, an expired tombstone and one never issued to
 * anyone must all read the same, or differencing the answers tells a caller
 * which absence it met.
 */
export const UNKNOWN_SHELL_MESSAGE = "shell not found";

/** What a verb resolved the caller's id to: a live entry, a record, or neither. */
export interface ShellResolution {
  cls: ShellClass;
  /** What the classifier actually produced, before the caller-visible collapse. */
  operatorClass?: ShellClass;
  collectorLive: boolean;
  shell?: BgShell;
  status?: ShellRecordStatus;
  exitCode?: number | null;
  outputAvailable: boolean;
}

const UNKNOWN_RESOLUTION: ShellResolution = {
  cls: "unknown", collectorLive: false, outputAvailable: false,
};

/** The same absence, carrying which one it was for the operator surface. */
function absent(owner: string, run: string, id: string): ShellResolution {
  return { ...UNKNOWN_RESOLUTION, operatorClass: absenceClass(owner, recordRun(run), id) };
}

/**
 * Resolve one id to a class, from the durable record first and the registry
 * only as one of the classifier's inputs.
 *
 * The registry alone cannot answer: it drops an entry one reap delay after the
 * exit, after which a shell whose outcome is durably committed would read as
 * absent -- a `finished` shell answering the possibly-lost wording. A process
 * that files no records has no record to read and keeps the registry-only
 * behaviour it had before the scheme existed.
 */
export function resolveShell(owner: string, run: string, id: string): ShellResolution {
  const shell = lookup(owner, run, id);
  if (!filesRecords()) {
    if (!shell) return absent(owner, run, id);
    return {
      cls: shell.status === "running" ? "running" : "finished",
      collectorLive: false,
      shell,
      status: shell.status === "running" ? undefined : outcomeStatus(shell),
      exitCode: shell.exitCode,
      outputAvailable: true,
    };
  }

  const verdict = shellVerdict(owner, recordRun(run), id, (record) => (
    shells.get(regKey(owner, record.run_identity ?? NO_RUN, record.shell_id))?.shell.status === "running"
  ));
  if (!verdict) return absent(owner, run, id);
  return {
    cls: callerVisibleClass(verdict.cls),
    operatorClass: verdict.cls,
    collectorLive: verdict.collectorLive,
    shell,
    status: verdict.record.status,
    exitCode: verdict.record.exit_code ?? null,
    outputAvailable: verdict.record.output_available === true && !!shell,
  };
}

/** Whether the record blocking a claim is a terminal outcome past its window. */
function expiredTombstone(owner: string, run: string, id: string): boolean {
  if (!filesRecords()) return false;
  try {
    const record = readRecord(owner, recordRun(run), id);
    return !!record && outcomeExpired(record);
  } catch {
    return false;
  }
}

function outcomeStatus(shell: BgShell): ShellRecordStatus {
  return shell.status === "killed" ? "killed" : shell.status === "exited" ? "exited" : "failed";
}

/** What a verb hands back: prose for a reader, the class for a program. */
export interface ShellAnswer {
  text: string;
  isError: boolean;
  structured: { shell_class: ShellClass } & Record<string, unknown>;
}

/** The refusal every verb gives for an id it may not address, byte for byte. */
function unknownAnswer(): ShellAnswer {
  return {
    text: `Error: ${UNKNOWN_SHELL_MESSAGE}`,
    isError: true,
    structured: { shell_class: "unknown" },
  };
}

function disabledAnswer(): ShellAnswer {
  return {
    text: `Error: ${BG_SHELL_DISABLED_MESSAGE}`,
    isError: true,
    structured: { shell_class: "unknown" },
  };
}

/** Read new output from one of this run's shells since its last poll. */
export function pollOutput(owner: string, run: string, id: string, filter?: string): ShellAnswer {
  if (!BG_SHELL_ENABLED) return disabledAnswer();
  const resolved = resolveShell(owner, run, id);
  // Another owner's shell reads as absent, and so does a tombstone past its
  // retention. Saying which would confirm the shell exists, and there is
  // nothing the caller could do with that either way.
  if (resolved.cls === "unknown") return unknownAnswer();

  const structured = {
    shell_class: resolved.cls,
    shell_id: id,
    output_available: resolved.outputAvailable,
    ...(resolved.status ? { status: resolved.status, exit_code: resolved.exitCode ?? null } : {}),
  };

  const parts = [`Shell: ${id}`, `Class: ${resolved.cls}`];
  if (!resolved.shell) {
    // The record says what happened; the buffers went with the process that
    // held them, so there is nothing left to read out of them.
    parts.push(resolved.status ? `Outcome: ${resolved.status} (exit_code=${resolved.exitCode ?? "?"})` : "(no output retained)");
    return { text: parts.join("\n"), isError: false, structured };
  }

  const shell = resolved.shell;
  const output = pollManagedOutput(shell, filter);
  if (resolved.status) parts.push(`Outcome: ${resolved.status} (exit_code=${resolved.exitCode ?? "?"})`);
  if (shell.truncated) parts.push(`Warning: output buffer overflow, ${shell.stdoutDroppedBytes + shell.stderrDroppedBytes} bytes dropped`);
  if (output.lostBytes > 0) parts.push(`Warning: ${output.lostBytes} unread bytes were dropped from the ring buffer`);
  if (output.stdout) parts.push(`New stdout (${output.stdout.length} chars):`, output.stdout);
  if (output.stderr) parts.push(`New stderr:`, output.stderr);
  if (!output.stdout && !output.stderr) parts.push("(no new output)");

  return { text: parts.join("\n"), isError: false, structured };
}

/** Kill one of this run's background shells. SIGTERM first, SIGKILL after 5s. */
export function killShell(owner: string, run: string, id: string): ShellAnswer {
  if (!BG_SHELL_ENABLED) return disabledAnswer();
  const resolved = resolveShell(owner, run, id);
  if (resolved.cls === "unknown") return unknownAnswer();

  const structured = { shell_class: resolved.cls, shell_id: id };
  const shell = resolved.shell;
  if (!shell || shell.status !== "running") {
    // Nothing this process can signal. The class already says why -- finished,
    // ended and uncollected, lost with its epoch, or never spawned -- so the
    // caller is told that rather than a synthesised success.
    return { text: `Shell ${id} is ${resolved.cls}; nothing was signalled`, isError: false, structured };
  }

  terminateManagedProcess(shell, "SIGTERM");
  logShellEvent("shell.background.terminate_requested", shell);

  setTimeout(() => {
    if (shell.status === "running") {
      terminateManagedProcess(shell, "SIGKILL");
      logShellEvent("shell.background.kill_requested", shell);
    }
  }, 5000);

  return {
    text: `Shell ${id} terminating (SIGTERM sent to process group, SIGKILL in 5s if needed)`,
    isError: false,
    structured,
  };
}

/**
 * Block until one of this run's shells exits, or until `timeoutMs` elapses.
 *
 * Returns the shell so the caller can report how it ended, or `null` when the
 * wait timed out with it still running. Resolves immediately for a shell that
 * has already finished, which is the common case when the model asks a second
 * time.
 *
 * The timer is unref'd: a wait in progress must not be the reason the process
 * stays alive through a shutdown.
 */
export function waitForShellExit(
  owner: string,
  run: string,
  id: string,
  timeoutMs: number,
): Promise<BgShell | null> | ShellResolution {
  if (!BG_SHELL_ENABLED) return UNKNOWN_RESOLUTION;
  const resolved = resolveShell(owner, run, id);
  const shell = resolved.shell;
  // Only an entry this process still owes an exit event for can be waited on,
  // which is exactly the collector-live window: `ended_unreaped` qualifies
  // there and resolves to `finished` without a second call, while every other
  // class is answered at once rather than sat on until the timeout.
  if (!shell || shell.status !== "running") return resolved;

  return new Promise<BgShell | null>((resolve) => {
    let settled = false;
    const done = (value: BgShell | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const onExit = () => {
      clearTimeout(timer);
      // One tick, so process-runner's own exit handler has set status and
      // exitCode before the caller reads them off the shell.
      setImmediate(() => done(shell));
    };
    const timer = setTimeout(() => {
      // The listener leaves with the wait that registered it. A wait that runs
      // out is expected to be repeated -- the documented way to sit on a
      // twelve-hour job is a series of waits -- so one left behind per timeout
      // accumulates on the same emitter until Node reports a
      // MaxListenersExceededWarning against a leak that is not one.
      shell.process.removeListener("exit", onExit);
      done(null);
    }, timeoutMs);
    timer.unref?.();
    shell.process.once("exit", onExit);
  });
}

/**
 * The entries whose process is still running.
 *
 * An exited shell stays in the registry for one reap delay so its final output
 * remains pollable, so registry membership is not liveness and every count that
 * means "live work" has to go through here.
 */
function runningShells(): BgEntry[] {
  return [...shells.values()].filter((e) => e.shell.status === "running");
}

/** Ids of `owner`'s live shells. Exists for tests and for shutdown logging. */
export function listRunningShells(owner: string): string[] {
  return runningShells().filter((e) => e.owner === owner).map((e) => e.shell.id);
}

export type { ReapOutcome, ReapReport, ReapedShell };
export { MAX_REAP_GRACE_MS, MIN_REAP_GRACE_MS };

/**
 * SIGTERM a set of shells, wait out one shared grace window, SIGKILL what is
 * left, and report what each one actually reached.
 *
 * The counts are disjoint tallies of a per-shell outcome, not counts of what was
 * signalled: a shell that ignored both signals is `surviving`, which is the
 * honest answer and the one a caller about to report a run finished needs. One
 * window for the whole set rather than a serial wait per shell, so a wide reap
 * costs one grace rather than N.
 */
async function terminateShells(
  running: BgEntry[],
  graceMs: number,
  reason: "shutdown" | "run_end",
): Promise<ReapReport> {
  const report: ReapReport = { stopped: 0, escalated: 0, surviving: 0, shells: [] };
  if (running.length === 0) return report;

  const signalledAt = new Date().toISOString();
  for (const { shell } of running) {
    terminateManagedProcess(shell, "SIGTERM");
    logShellEvent(`shell.background.${reason}_terminate`, shell);
  }

  await sleepUnref(graceMs);

  // The leader's exit status is not the group's liveness: a descendant that
  // stayed in the group outlives it, and reading the leader alone reports the
  // work gone while it is still holding the sandbox's CPU.
  const escalated: BgEntry[] = [];
  for (const entry of running) {
    if (processGroupAlive(entry.shell)) {
      terminateManagedProcess(entry.shell, "SIGKILL");
      logShellEvent(`shell.background.${reason}_kill`, entry.shell);
      escalated.push(entry);
    }
  }
  // The escalated signal is not the same fact as the group being gone, and
  // reporting it as one is how a reap came to answer `stopped` over work that
  // ignored SIGKILL. Read again after a short settle, and say `surviving` where
  // termination is still not established.
  if (escalated.length > 0) await sleepUnref(Math.min(graceMs, 1_000));

  for (const entry of running) {
    const wasEscalated = escalated.includes(entry);
    const outcome: ReapOutcome = processGroupAlive(entry.shell)
      ? "surviving"
      : wasEscalated ? "escalated" : "stopped";
    report[outcome] += 1;
    report.shells.push({
      shell_id: entry.shell.id,
      owner_scope: entry.owner,
      run_identity: entry.run,
      outcome,
      signalled_at: signalledAt,
    });
  }
  return report;
}

function sleepUnref(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Stop every tracked shell, regardless of owner, and wait for the escalation.
 *
 * Background children are spawned detached and unref'd so that they survive the
 * request that started them. That also means Node exits without them: on a pod
 * eviction or a rolling update, Hands went away and left its training runs and
 * dev servers holding the sandbox's CPU with no one left who could name them.
 * Whether the container runtime eventually tears down the PID namespace is the
 * runtime's business and not something the process should rely on for a signal
 * it was given directly.
 *
 * Resolves once the grace period has passed and stragglers have been SIGKILLed,
 * so the caller can exit knowing it did what it could.
 */
export async function shutdownAllShells(graceMs = REAP_GRACE_MS): Promise<number> {
  return (await terminateShells(runningShells(), graceMs, "shutdown")).shells.length;
}

/**
 * How much live background work `owner` still holds in this sandbox.
 *
 * Brain needs it when a task reaches a terminal state: a background shell is
 * meant to outlive the turn that started it -- that is the whole point of
 * `run_in_background` -- but the sandbox is marked idle on every terminal task
 * regardless, and the control plane reclaims an idle sandbox about fifteen
 * minutes later, taking the shell with it.
 *
 * Read from the durable records where this process files them, and from the
 * in-process map only as one input to that. The map alone cannot answer after a
 * restart: background children are detached precisely so they survive the
 * request that started them, and they survive the process too, but the map that
 * knew their identifiers died with it -- so a sandbox with a training run still
 * writing would answer zero and be reclaimed out from under it. A process that
 * files no records still answers from the map, which is what it did before.
 *
 * Scoped to the owner rather than the run because that is the key the keepalive
 * sweep can address, and because the question is about the pod rather than
 * about one task that used it.
 *
 * Only live work counts. A shell that has ended is one nobody is waiting on,
 * and counting it would hold a sandbox open for a process that finished hours
 * ago.
 *
 * Null where this process files records and cannot read them. That is not zero
 * and must not be rounded to it: after a restart the in-memory view is empty
 * for reasons that say nothing about the sandbox, so answering with it would
 * file a sandbox full of orphaned work idle. The caller turns null into the
 * probe's own unanswered case, which keeps the sandbox and gives up only after
 * a run of them.
 */
export function runningShellCount(owner: string): number | null {
  if (!owner) return 0;
  const inMemory = runningShells().filter((e) => e.owner === owner).length;
  if (!filesRecords()) return inMemory;

  const liveness = ownerLiveness(owner, (record) => {
    const entry = shells.get(regKey(owner, record.run_identity ?? NO_RUN, record.shell_id));
    return entry?.shell.status === "running";
  });
  if (!liveness.determinate) return inMemory > 0 ? inMemory : null;
  return Math.max(inMemory, liveness.active);
}

/** Raised where a reap could not establish what it was supposed to address. */
export class UnreadableRecords extends Error {}

export async function shutdownRunShells(
  owner: string, run: string, graceMs = REAP_GRACE_MS,
): Promise<ReapReport> {
  // NO_RUN would otherwise match every shell spawned without a run header, which
  // is precisely the set nothing is entitled to reap. The owner is required for
  // the same reason: two owners may each hold a run of this id, and the
  // credential proved one pair, not one half of it.
  if (!run || !owner) return { stopped: 0, escalated: 0, surviving: 0, shells: [] };
  return terminateShells(addressedByReap(owner, run), graceMs, "run_end");
}

/**
 * Every shell of this pair a reap must address.
 *
 * The in-process registry alone cannot answer it: background children are
 * detached so they survive the request, and they survive the process too, but
 * the map that knew them died with it -- so after a restart a reap over live
 * work reports an empty set and the work runs on unreachable. The durable
 * records name what the map has forgotten, and a record whose process is still
 * in the table is re-attached to a signalable entry here.
 */
function addressedByReap(owner: string, run: string): BgEntry[] {
  const tracked = runningShells().filter((e) => e.owner === owner && e.run === run);
  if (!filesRecords()) return tracked;

  const seen = new Set(tracked.map((e) => e.shell.id));
  const recovered: BgEntry[] = [];
  let records: ShellRecord[];
  try {
    records = listRecordsForOwner(owner);
  } catch (e) {
    // Unreadable is not empty, and the in-process set alone is empty after a
    // restart for reasons that say nothing about the sandbox. Reporting what it
    // holds would be an all-clear over work nobody could enumerate.
    throw new UnreadableRecords(
      `the shell records for ${owner} could not be read (${(e as Error).message}), `
      + "so what this run still holds could not be established",
    );
  }
  for (const record of records) {
    if ((record.run_identity ?? NO_RUN) !== run || seen.has(record.shell_id)) continue;
    if (record.status || !record.process_identity) continue;
    if (processStartToken(record.process_identity.pid) !== record.process_identity.startToken) continue;
    recovered.push({ owner, run, shell: untrackedShell(record) });
  }
  return [...tracked, ...recovered];
}

/**
 * A signalable stand-in for a shell this process never started.
 *
 * Carries the identity and nothing else: there are no buffers to read and no
 * exit event to await, which is exactly why its outcome is read from the
 * process group rather than from a status field.
 */
function untrackedShell(record: ShellRecord): BgShell {
  return {
    id: record.shell_id,
    kind: record.kind,
    command: "",
    pid: record.process_identity!.pid,
    process: { pid: record.process_identity!.pid } as BgShell["process"],
    status: "running",
    exitCode: null,
    signal: null,
    timedOut: false,
    stdoutBuf: [], stderrBuf: [],
    stdoutBytes: 0, stderrBytes: 0,
    stdoutReadOffset: 0, stderrReadOffset: 0,
    stdoutDroppedBytes: 0, stderrDroppedBytes: 0,
    truncated: false,
    startedAt: Date.parse(record.spawned_at ?? record.claimed_at) || Date.now(),
    lastOutputAt: Date.now(),
    endedAt: null,
  };
}
