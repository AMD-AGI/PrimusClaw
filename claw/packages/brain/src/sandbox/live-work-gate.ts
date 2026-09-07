// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How much work a container still holds, read before anything destroys it.
 *
 * Over the container-exec channel rather than by asking Hands: this runs on the
 * path where Hands is what is down, so an HTTP call would be circular. A count
 * is only as good as the population it covers, so the read establishes first
 * that the sandbox files records at all -- a process minting no epoch marker
 * keeps its shells in a registry no count can see. Neither that, nor an
 * unreadable marker, nor a partial read is a count of zero.
 */

import {
  PROTECTED_CLASSES, classifyShellRecord,
  type EpochFreshness, type EpochMarker, type ProcessIdentity,
  type ShellClass, type ShellRecord,
} from "@claw/protocol";
import pino from "pino";
import { execInSandbox } from "./container-probe.js";
import type { SandboxInstance } from "./provider.js";

const logger = pino({ name: "sandbox-live-work-gate" });

export type LiveWorkVerdict = "clear" | "protected" | "unknown";

export interface LiveWorkAnswer {
  verdict: LiveWorkVerdict;
  /** Per-class tally, for operator telemetry. Never reaches a caller. */
  classes: Partial<Record<ShellClass, number>>;
  /** Why the answer is what it is, for the retention record's reason code. */
  reason: string;
}

const EXEC_TIMEOUT = "20s";

/**
 * Everything the classifier needs, in one command.
 *
 * One rather than several: a read split across calls can see the subtree in two
 * states. A missing marker and an unreadable subtree stay distinguishable in
 * the output rather than collapsing into one absence.
 */
function gatherCommand(stateDir: string): string {
  return `set -e; `
    + `printf 'MARKER '; cat ${stateDir}/epoch.json 2>/dev/null || printf 'none'; printf '\\n'; `
    + `if [ -d ${stateDir}/scopes ]; then printf 'SUBTREE ok\\n'; `
    + `find ${stateDir}/scopes -type f -exec sh -c 'printf "RECORD "; cat "$1"; printf "\\n"' _ {} \\; ; `
    + `else printf 'SUBTREE %s\\n' "$([ -e ${stateDir} ] && echo empty || echo missing)"; fi; `
    + `printf 'PROCS '; ls /proc 2>/dev/null | tr '\\n' ' '; printf '\\n'`;
}

interface GatheredState {
  marker: EpochMarker | null;
  subtree: "ok" | "empty" | "missing" | null;
  records: ShellRecord[];
  livePids: Set<number>;
}

function parseGathered(stdout: string): GatheredState {
  const state: GatheredState = { marker: null, subtree: null, records: [], livePids: new Set() };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("MARKER ")) {
      try { state.marker = JSON.parse(line.slice(7)) as EpochMarker; } catch { /* none */ }
    } else if (line.startsWith("SUBTREE ")) {
      const value = line.slice(8).trim();
      state.subtree = value === "ok" || value === "empty" || value === "missing" ? value : null;
    } else if (line.startsWith("RECORD ")) {
      // Dropping an unreadable record lets the count come back a determinate
      // zero, which is the empty-state inference this read exists to refuse.
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.slice(7));
      } catch {
        throw new Error("a shell record could not be read");
      }
      // Parseable is not usable: a value that is not a record classifies from
      // fields it does not have.
      if (!isShellRecord(parsed)) throw new Error("a shell record is not a record");
      state.records.push(parsed);
    } else if (line.startsWith("PROCS ")) {
      for (const entry of line.slice(6).trim().split(/\s+/)) {
        const pid = Number(entry);
        if (Number.isInteger(pid) && pid > 0) state.livePids.add(pid);
      }
    }
  }
  return state;
}

const OUTCOMES: readonly unknown[] = ["exited", "killed", "failed"];
const KINDS: readonly unknown[] = ["background", "monitor"];

const isInstant = (v: unknown): boolean => typeof v === "string" && Number.isFinite(Date.parse(v));
const optional = (v: unknown, ok: (x: unknown) => boolean): boolean => v === undefined || ok(v);

/**
 * Whether this is a record, in every field the classifier reads.
 *
 * Checking the four addressing fields is not enough: the class turns on
 * `status`, `process_identity` and the epoch, so a value carrying an
 * unrecognised status classifies `finished` -- which is the one class that
 * permits a destroy.
 */
function isShellRecord(value: unknown): value is ShellRecord {
  const r = value as Partial<ShellRecord> | null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  return typeof r.owner_scope === "string" && r.owner_scope.length > 0
    && (typeof r.run_identity === "string" || r.run_identity === null)
    && typeof r.shell_id === "string" && r.shell_id.length > 0
    && typeof r.hands_epoch === "string" && r.hands_epoch.length > 0
    && typeof r.command_digest === "string"
    && KINDS.includes(r.kind)
    && isInstant(r.claimed_at)
    && optional(r.status, (v) => OUTCOMES.includes(v))
    && optional(r.process_identity, isProcessIdentity)
    && optional(r.spawned_at, isInstant)
    && optional(r.ended_at, isInstant)
    && optional(r.deadline_at, isInstant)
    && optional(r.retain_until, isInstant)
    && optional(r.exit_code, (v) => v === null || Number.isInteger(v))
    && optional(r.output_available, (v) => typeof v === "boolean")
    // An outcome without its end, or an end without its outcome, is a record
    // half-written by something that is not the writer.
    && (r.status === undefined) === (r.ended_at === undefined);
}

function isProcessIdentity(value: unknown): boolean {
  const id = value as { pid?: unknown; startToken?: unknown } | null;
  return !!id && typeof id === "object"
    && Number.isInteger(id.pid) && (id.pid as number) > 0
    && typeof id.startToken === "string";
}

/**
 * How fresh a record's epoch is.
 *
 * Equality with the marker proves only that no newer Hands has started -- a
 * crashed one leaves its marker exactly as it wrote it -- so currency turns on
 * the bearer still being in the process table.
 */
function freshness(record: ShellRecord, state: GatheredState): EpochFreshness {
  if (!state.marker) return "indeterminate";
  if (state.marker.epoch !== record.hands_epoch) return "stale";
  return bearerAlive(state.marker.bearer, state) ? "current" : "stale";
}

function bearerAlive(bearer: ProcessIdentity | undefined, state: GatheredState): boolean {
  return !!bearer && state.livePids.has(bearer.pid);
}

/**
 * The in-process registry is not exec-visible, so a row this coarser view cannot
 * separate reads `unverified_running`: no row moves from blocking to
 * non-blocking, which is the direction that matters.
 */
function classifyOverExec(record: ShellRecord, state: GatheredState): ShellClass {
  return classifyShellRecord({
    record,
    epoch: freshness(record, state),
    registry: "unreadable",
    process: state.livePids.has(record.process_identity?.pid ?? -1) ? "present" : "terminated",
  });
}

/**
 * The record-derived answer for a path about to destroy, rebuild, evict, replace
 * or relaunch in this container.
 *
 * `unknown` and `protected` differ in what an operator is told, never in what
 * the caller may do: both forbid every destructive act, only `clear` permits one.
 */
export async function countLiveWork(
  inst: SandboxInstance,
  stateDir: string,
  signal?: AbortSignal,
): Promise<LiveWorkAnswer> {
  let stdout: string;
  try {
    const result = await execInSandbox(inst, gatherCommand(stateDir), EXEC_TIMEOUT, signal);
    // A non-zero exit is a read that did not finish, over an unknown fraction
    // of the subtree: nothing in its stdout says which records are missing.
    if (result.exitCode !== 0) {
      return { verdict: "unknown", classes: {}, reason: `exec_exit_${result.exitCode}` };
    }
    stdout = result.stdout ?? "";
  } catch (e) {
    return { verdict: "unknown", classes: {}, reason: `exec_unanswered: ${(e as Error).message}` };
  }

  let state: GatheredState;
  try {
    state = parseGathered(stdout);
  } catch (e) {
    return { verdict: "unknown", classes: {}, reason: (e as Error).message };
  }

  // A sandbox filing no records has shells this cannot see; an unreadable
  // marker leaves the same question unanswered. Neither is zero.
  if (!state.marker || state.subtree !== "ok") {
    return {
      verdict: "unknown",
      classes: {},
      reason: !state.marker ? "no_epoch_marker" : `subtree_${state.subtree ?? "unreadable"}`,
    };
  }
  // No process table is no evidence about any record in it.
  if (state.livePids.size === 0) {
    return { verdict: "unknown", classes: {}, reason: "process_table_unreadable" };
  }

  const classes: Partial<Record<ShellClass, number>> = {};
  let protectedCount = 0;
  for (const record of state.records) {
    const cls = classifyOverExec(record, state);
    classes[cls] = (classes[cls] ?? 0) + 1;
    if (PROTECTED_CLASSES.includes(cls)) protectedCount += 1;
  }

  logger.info({ sandboxName: inst.sandboxName, classes }, "live_work_gate.counted");
  return protectedCount > 0
    ? { verdict: "protected", classes, reason: "live_work_present" }
    : { verdict: "clear", classes, reason: "no_live_work" };
}
