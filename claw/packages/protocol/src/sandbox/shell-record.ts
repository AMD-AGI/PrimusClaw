// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The durable identity of one background shell, as both sides read it.
 *
 * Hands writes it inside the sandbox; Brain reads it over the container-exec
 * channel when it has to decide the fate of a container whose Hands is the very
 * thing that is down, so an HTTP call would be circular. One declaration, so
 * the reader and the writer cannot drift into two shapes.
 */

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
  /** Null is the typed absence of a run identity, distinct from every string. */
  run_identity: string | null;
  shell_id: string;
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

export interface EpochMarker {
  epoch: string;
  bearer: ProcessIdentity;
}

/** Why background work was ended. A new path extends this, never bypasses it. */
export const RECLAIM_CAUSES = [
  "dag_node_terminal",
  "run_cancelled",
  "operator_kill_shell",
  "sandbox_idle_reclaim",
  "sandbox_absolute_deadline",
  "sandbox_replaced",
  "retry_pending_unregistered",
  "session_cleanup",
] as const;

export type ReclaimCause = typeof RECLAIM_CAUSES[number];

export function isReclaimCause(value: unknown): value is ReclaimCause {
  return typeof value === "string" && (RECLAIM_CAUSES as readonly string[]).includes(value);
}

/** What one addressed shell reached once the escalation completed. */
export type ReapOutcome = "stopped" | "escalated" | "surviving";

export interface ReapedShell {
  shell_id: string;
  owner_scope: string;
  run_identity: string;
  outcome: ReapOutcome;
  signalled_at: string;
}

/** Disjoint tallies of one outcome per addressed shell, never signal counts. */
export interface ReapReport {
  stopped: number;
  escalated: number;
  surviving: number;
  shells: ReapedShell[];
}

/** The grace domain, stated once and enforced identically on both sides. */
export const MIN_REAP_GRACE_MS = 250;
export const MAX_REAP_GRACE_MS = 60_000;

export function isReapGrace(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= MIN_REAP_GRACE_MS
    && (value as number) <= MAX_REAP_GRACE_MS;
}
