// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the platform did to a run, as platform facts and nothing else.
 *
 * A dispatcher above Claw has to tell three endings apart: the agent finished, the
 * agent broke, and the platform took the machine away. Today it cannot -- a run
 * killed by a node reclaim and one that crashed on its own arrive identically, so
 * both are counted against the model that happened to be running. At sweep scale
 * that pollutes the failure funnel the enablement work is chosen from *and* the
 * stability metric meant to show whether the platform is getting better.
 *
 * The distinction is only ours to make. Nobody above the platform can observe a
 * preemption, and nothing below it knows the run existed.
 *
 * Deliberately absent from everything here: the optimizer's stop reasons
 * (`conc_sweep_done`, `plateau_explore`, …). That is the dispatcher's private
 * vocabulary, it is still growing, and a platform API that knew those words would
 * have to change when they do — and would be useless to every other workload.
 * Claw answers "did the process end, was it us, and why". What the run concluded
 * is the run's own to report.
 */

/** Where a run is. `terminal` means it will not move again. */
export type RunPhase = "pending" | "running" | "terminal";

/** How a run ended. */
export type TerminalClass = "exited" | "failed" | "killed" | "cancelled";

/**
 * Why the platform killed a run. Empty for every ending that was not a kill, and
 * — importantly — also for a kill whose cause we cannot name. An unexplained kill
 * is a real state and reporting it as one is the point: guessing lands
 * infrastructure loss in the failure class that decides whether a model is worth
 * enabling.
 */
export type KillReason = "deadline" | "preempted" | "oom" | "node_lost" | "user" | "";

export interface TerminalFacts {
  class: TerminalClass;
  kill_reason: KillReason;
  exit_code: number;
  signal: string;
}

export interface RunView {
  run_id: string;
  phase: RunPhase;
  terminal: TerminalFacts | null;
  timestamps: {
    created_at: string;
    started_at: string;
    terminal_at: string;
  };
  placement: {
    node: string;
    workload_id: string;
  };
}

/**
 * Pod `status.reason` values that mean the cluster took the machine back, mapped
 * to what a caller does about it.
 *
 * An allowlist of exact first words, not a substring search over the message. The
 * message is `reason + ", " + message` and the message half is free text from
 * whatever killed the pod, so a container that logged the word "evicted" on its
 * way out would otherwise be read as an eviction. The cost of that mistake is
 * one-directional: a genuine failure recorded as preemption is retried forever
 * without ever counting as failed.
 */
const POD_REASON_TO_KILL: ReadonlyMap<string, KillReason> = new Map([
  ["evicted", "preempted"],
  ["preempted", "preempted"],
  ["nodelost", "node_lost"],
  ["nodeshutdown", "node_lost"],
  ["shutdown", "node_lost"],
  ["terminationbykubelet", "preempted"],
  ["deadlineexceeded", "deadline"],
  ["oomkilled", "oom"],
]);

/** Exit code a process killed by a signal reports: 128 + the signal number. */
const SIGNAL_BASE = 128;
const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  2: "SIGINT",
  9: "SIGKILL",
  15: "SIGTERM",
};

/** The signal an exit code encodes, or "" when it encodes none. */
export function signalOf(exitCode: number): string {
  if (!Number.isInteger(exitCode) || exitCode <= SIGNAL_BASE) return "";
  return SIGNAL_NAMES[exitCode - SIGNAL_BASE] ?? `SIG${exitCode - SIGNAL_BASE}`;
}

/**
 * The kill reason a pod's failure message names, or "".
 *
 * Reads only the first word, because that is `pod.status.reason` — SaFE builds the
 * field as `reason + ", " + message` and everything after the comma is free text.
 */
export function killReasonFromPodMessage(failedMessage: string): KillReason {
  const head = (failedMessage || "").trim().split(/[,\s]/, 1)[0] ?? "";
  return POD_REASON_TO_KILL.get(head.toLowerCase()) ?? "";
}

/** What Claw itself recorded about the run, independent of any platform read. */
export interface TaskTerminalInput {
  status: string;
  failure_reason: string | null;
  /** Set when Claw stopped the run for exceeding its own budget. */
  deadline_exceeded?: boolean;
  /** From the platform read, when there was one. */
  pod_failed_message?: string;
  /**
   * The container's own termination reason, when the platform reports one.
   *
   * The only source for an OOM: the pod-level reason describes the kills decided
   * above the container and is empty when the kernel killed one for memory. Empty
   * against a platform that does not report it, and then an OOM simply stays
   * unnamed -- exit code 137 is any SIGKILL, so reading it as memory pressure
   * would relabel every eviction and every deliberate stop.
   */
  container_reason?: string;
  exit_code?: number | null;
  node?: string;
}

/**
 * Claw's own reasons for ending a run, and the kill they amount to.
 *
 * These need no platform read: the deadline is ours to enforce and a cancellation
 * is a person pressing a button here.
 */
const OWN_REASONS: ReadonlyMap<string, KillReason> = new Map([
  ["run_budget_exhausted", "deadline"],
  ["queue_timeout", "deadline"],
  ["external_timeout", "deadline"],
]);

/**
 * Reasons that only say nobody reported back.
 *
 * `brain_timeout` is written by the sweeper when a run stops reporting, and that
 * is precisely what a node reclaim looks like from here -- the sandbox and the
 * worker watching it go together, so no callback is ever sent. Ranking it with
 * the real deadlines labelled every preemption `killed/deadline`: a confident
 * wrong answer, and worse than the empty one, because a dispatcher reading
 * "deadline" holds the model responsible for the cluster's decision.
 *
 * So it yields to anything the platform said, and stands only when the platform
 * said nothing.
 */
const WEAK_REASONS: ReadonlyMap<string, KillReason> = new Map([
  ["brain_timeout", "deadline"],
]);

/**
 * Merge what Claw knows with what the platform reported into one ending.
 *
 * Order matters and is the whole of the judgement:
 *
 * 1. A cancellation is a person, and it outranks whatever the pod said on the way
 *    down — a pod killed *because* somebody cancelled would otherwise read as an
 *    infrastructure loss.
 * 2. Claw's own deadline next, for the same reason: we enforced it, so the pod's
 *    account of being terminated is a description of us doing it.
 * 3. Then the platform's own reason, which is the only source for a preemption.
 * 4. Then `brain_timeout`, which outranks nothing: it says a run stopped
 *    reporting, and being reclaimed is one of the reasons a run does that.
 * 5. A failure nobody explained stays `failed`, not a kill with a guessed cause.
 */
export function terminalFacts(input: TaskTerminalInput): TerminalFacts | null {
  const status = (input.status || "").toLowerCase();
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    return null;
  }
  const exitCode = typeof input.exit_code === "number" ? input.exit_code : 0;
  const signal = signalOf(exitCode);

  if (status === "cancelled") {
    return { class: "cancelled", kill_reason: "user", exit_code: exitCode, signal };
  }
  if (status === "completed") {
    return { class: "exited", kill_reason: "", exit_code: exitCode, signal };
  }

  const own = OWN_REASONS.get(input.failure_reason ?? "");
  if (own || input.deadline_exceeded) {
    return { class: "killed", kill_reason: own ?? "deadline", exit_code: exitCode, signal };
  }

  // The pod's reason first: a container killed as part of an eviction reports
  // "Error" of its own, and the eviction is the more useful account of it.
  const fromPod = killReasonFromPodMessage(input.pod_failed_message ?? "");
  if (fromPod) {
    return { class: "killed", kill_reason: fromPod, exit_code: exitCode, signal };
  }
  const fromContainer = killReasonFromPodMessage(input.container_reason ?? "");
  if (fromContainer) {
    return { class: "killed", kill_reason: fromContainer, exit_code: exitCode, signal };
  }

  // Only now: a timeout that means "nobody reported back" is the best answer
  // left once the platform has been asked and had nothing to say.
  const weak = WEAK_REASONS.get(input.failure_reason ?? "");
  if (weak) return { class: "killed", kill_reason: weak, exit_code: exitCode, signal };

  // Ended badly, and nothing said the platform did it. `failed` rather than a kill
  // with an empty reason: the two are different answers to "was it us", and a
  // caller deciding whether to hold a model responsible needs them apart.
  return { class: "failed", kill_reason: "", exit_code: exitCode, signal };
}

/** Which of the three phases a task status is. */
export function phaseOf(status: string): RunPhase {
  const s = (status || "").toLowerCase();
  if (s === "completed" || s === "failed" || s === "cancelled") return "terminal";
  if (s === "running" || s === "cancelling") return "running";
  return "pending";
}
