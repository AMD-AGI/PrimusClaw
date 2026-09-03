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

import { randomUUID } from "node:crypto";
import { BG_SHELL_ENABLED } from "../../config.js";
import {
  type ManagedShell,
  type ManagedShellKind,
  type ManagedShellStatus,
  logShellEvent,
  pollManagedOutput,
  spawnManagedShell,
  terminateManagedProcess,
} from "./process-runner.js";

const BG_SHELL_MAX_CONCURRENT = parseInt(process.env.BG_SHELL_MAX_CONCURRENT || "16", 10);
const BG_SHELL_BUFFER_BYTES = parseInt(process.env.BG_SHELL_BUFFER_BYTES || "1048576", 10);
/** Grace period between a background shell exiting and being removed from the
 *  registry. Lets the watchdog deliver the completion notification first. */
const BG_SHELL_REAP_DELAY_MS = parseInt(process.env.BG_SHELL_REAP_DELAY_MS || "60000", 10);

export type BgShellKind = Extract<ManagedShellKind, "background" | "monitor">;
export type BgShellStatus = ManagedShellStatus;
export type BgShell = ManagedShell;

/** Shown to the model, so it says what to do instead of just refusing. */
export const BG_SHELL_DISABLED_MESSAGE =
  "background shells are disabled in this deployment (BG_SHELL_ENABLED). "
  + "Run the command in the foreground with a suitable bash timeout instead.";

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
 * Keyed by owner and id together. The separator is a NUL, which
 * `normalizeOwner` refuses in an owner and which no shell id can contain
 * either, so one entry can never be addressed as another.
 */
const shells = new Map<string, BgEntry>();

function regKey(owner: string, id: string): string {
  return `${owner}\u0000${id}`;
}

function lookup(owner: string, id: string): BgShell | undefined {
  return shells.get(regKey(owner, id))?.shell;
}

/** Spawn a background shell process owned by `owner` and started by `run`. */
export function spawnBackground(
  owner: string,
  run: string,
  command: string,
  shellId?: string,
  kind: BgShellKind = "background",
): BgShell {
  if (!BG_SHELL_ENABLED) throw new Error(BG_SHELL_DISABLED_MESSAGE);
  if (shells.size >= BG_SHELL_MAX_CONCURRENT) {
    throw new Error(`Background shell limit reached (max ${BG_SHELL_MAX_CONCURRENT})`);
  }

  const id = shellId || `bg-${randomUUID().slice(0, 8)}`;
  const key = regKey(owner, id);
  if (shells.has(key)) throw new Error(`Shell ${id} already exists`);

  const shell = spawnManagedShell(command, {
    id,
    kind,
    bufferBytes: BG_SHELL_BUFFER_BYTES,
    unref: true,
  });
  shells.set(key, { owner, run, shell });

  // Auto-reap finished shells so the concurrency cap cannot be saturated by
  // long-lived monitor/background entries that already exited. The delay keeps
  // the final output pollable for one grace window after exit.
  shell.process.once("exit", () => {
    const t = setTimeout(() => {
      const current = shells.get(key);
      if (current && current.shell.status !== "running") shells.delete(key);
    }, BG_SHELL_REAP_DELAY_MS);
    t.unref?.();
  });

  return shell;
}

/** Read new output from one of `owner`'s shells since its last poll. */
export function pollOutput(owner: string, id: string, filter?: string): string {
  if (!BG_SHELL_ENABLED) return `Error: ${BG_SHELL_DISABLED_MESSAGE}`;
  const shell = lookup(owner, id);
  // Another owner's shell reads as absent. Saying "not yours" would confirm it
  // exists, and there is nothing the caller could do with that either way.
  if (!shell) return `Error: shell ${id} not found (possibly lost after sandbox rebuild)`;

  const output = pollManagedOutput(shell, filter);

  const statusLine = shell.status === "running"
    ? "running"
    : `${shell.status} (exit_code=${shell.exitCode ?? "?"})`;

  const parts = [`Shell: ${id}`, `Status: ${statusLine}`];
  if (shell.truncated) parts.push(`Warning: output buffer overflow, ${shell.stdoutDroppedBytes + shell.stderrDroppedBytes} bytes dropped`);
  if (output.lostBytes > 0) parts.push(`Warning: ${output.lostBytes} unread bytes were dropped from the ring buffer`);
  if (output.stdout) parts.push(`New stdout (${output.stdout.length} chars):`, output.stdout);
  if (output.stderr) parts.push(`New stderr:`, output.stderr);
  if (!output.stdout && !output.stderr) parts.push("(no new output)");

  return parts.join("\n");
}

/** Kill one of `owner`'s background shells. SIGTERM first, SIGKILL after 5s. */
export function killShell(owner: string, id: string): string {
  if (!BG_SHELL_ENABLED) return `Error: ${BG_SHELL_DISABLED_MESSAGE}`;
  const shell = lookup(owner, id);
  if (!shell) return `Error: shell ${id} not found`;
  if (shell.status !== "running") {
    return `Shell ${id} already ${shell.status} (exit_code=${shell.exitCode})`;
  }

  terminateManagedProcess(shell, "SIGTERM");
  logShellEvent("shell.background.terminate_requested", shell);

  setTimeout(() => {
    if (shell.status === "running") {
      terminateManagedProcess(shell, "SIGKILL");
      logShellEvent("shell.background.kill_requested", shell);
    }
  }, 5000);

  return `Shell ${id} terminating (SIGTERM sent to process group, SIGKILL in 5s if needed)`;
}

/**
 * Block until one of `owner`'s shells exits, or until `timeoutMs` elapses.
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
  id: string,
  timeoutMs: number,
): Promise<BgShell | null> | { error: string } {
  if (!BG_SHELL_ENABLED) return { error: BG_SHELL_DISABLED_MESSAGE };
  const shell = lookup(owner, id);
  if (!shell) return { error: `shell ${id} not found (possibly lost after sandbox rebuild)` };
  if (shell.status !== "running") return Promise.resolve(shell);

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

/** Ids of `owner`'s live shells. Exists for tests and for shutdown logging. */
export function listRunningShells(owner: string): string[] {
  return [...shells.values()]
    .filter((e) => e.owner === owner && e.shell.status === "running")
    .map((e) => e.shell.id);
}

/**
 * SIGTERM a set of shells, wait out the grace period, SIGKILL what is left.
 *
 * Resolves only after the escalation so a caller that is about to exit, or about
 * to report a run finished, knows the processes are actually gone rather than
 * merely asked to leave. `reason` names the log events so the two callers stay
 * distinguishable in the shell log.
 */
async function terminateShells(
  running: BgEntry[],
  graceMs: number,
  reason: "shutdown" | "run_end",
): Promise<number> {
  if (running.length === 0) return 0;

  for (const { shell } of running) {
    terminateManagedProcess(shell, "SIGTERM");
    logShellEvent(`shell.background.${reason}_terminate`, shell);
  }

  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, graceMs);
    t.unref?.();
  });

  for (const { shell } of running) {
    if (shell.status === "running") {
      terminateManagedProcess(shell, "SIGKILL");
      logShellEvent(`shell.background.${reason}_kill`, shell);
    }
  }
  return running.length;
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
export async function shutdownAllShells(graceMs = 2000): Promise<number> {
  return terminateShells([...shells.values()].filter((e) => e.shell.status === "running"), graceMs, "shutdown");
}

/**
 * Stop the shells one finished run started, leaving the rest of the owner alone.
 *
 * A batch node's dev server has no one left to read it once the node reports a
 * result, and the sandbox it is holding CPU in belongs to the whole workspace,
 * so the run that started it is the last party who can reasonably end it. A
 * conversation is the opposite case and is why this is by run and not by owner:
 * the user is still there between turns, and a shell they started in one turn is
 * expected to still be running in the next.
 *
 * A run that started nothing is not an error -- most runs never spawn a shell --
 * so this reports zero rather than refusing.
 */
/**
 * How many of `owner`'s background shells are still running.
 *
 * The same predicate the reap uses, asked without reaping. Brain needs it when a
 * task reaches a terminal state: a background shell is meant to outlive the turn
 * that started it -- that is the whole point of `run_in_background` -- but the
 * sandbox is marked idle on every terminal task regardless, and the control
 * plane reclaims an idle sandbox 15 minutes later, taking the shell with it.
 *
 * Scoped to the owner rather than the run because that is the key the keepalive
 * sweep can address: it walks `hands.<session>` entries and knows the session,
 * while the run is a per-task id it never sees. The owner is also the right
 * granularity for the question being asked -- "is anything still running in this
 * sandbox" -- which is about the pod, not about one task that used it.
 *
 * Only `running` counts. An exited shell is one nobody is waiting on, and
 * counting it would hold a sandbox open for a process that ended hours ago.
 */
export function runningShellCount(owner: string): number {
  if (!owner) return 0;
  return [...shells.values()].filter(
    (e) => e.owner === owner && e.shell.status === "running",
  ).length;
}

export async function shutdownRunShells(run: string, graceMs = 2000): Promise<number> {
  // NO_RUN would otherwise match every shell spawned without a run header, which
  // is precisely the set nothing is entitled to reap.
  if (!run) return 0;
  return terminateShells(
    [...shells.values()].filter((e) => e.run === run && e.shell.status === "running"),
    graceMs,
    "run_end",
  );
}
