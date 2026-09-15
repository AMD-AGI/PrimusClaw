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
import { EXEC_TRANSPORT_SLACK_MS, type SandboxInstance } from "./provider.js";

const logger = pino({ name: "sandbox-live-work-gate" });

export type LiveWorkVerdict = "clear" | "protected" | "unknown";

export interface LiveWorkAnswer {
  verdict: LiveWorkVerdict;
  /** Per-class tally, for operator telemetry. Never reaches a caller. */
  classes: Partial<Record<ShellClass, number>>;
  /** Why the answer is what it is, for the retention record's reason code. */
  reason: string;
}

/**
 * Longest the gather command may run inside the container before the container
 * runtime ends it.
 *
 * The *command's* deadline and nothing more. It is not the ceiling of the call
 * a caller awaits, and reading it as one is how a sweep comes to declare a span
 * it does not hold to -- see `LIVE_WORK_READ_CEILING_MS`.
 */
export const LIVE_WORK_EXEC_CEILING_MS = 20_000;
const EXEC_TIMEOUT = `${LIVE_WORK_EXEC_CEILING_MS / 1000}s`;

/**
 * Longest one whole live-work read may take, enforced here rather than assumed
 * of whoever answers it.
 *
 * The command timeout above travels to the runtime as a string and bounds the
 * process, not the call. Every provider adds `EXEC_TRANSPORT_SLACK_MS` on top of
 * it for the HTTP request that carries it -- deliberately, so the transport
 * never gives up before the command it is waiting for could have finished -- and
 * the SaFE path can then spend a further status lookup disambiguating a 404. So
 * a Router that accepts the connection and goes quiet holds this call for half
 * again as long as the command timeout suggests, without violating a single
 * deadline it declared.
 *
 * That gap is load-bearing for the keepalive sweep, whose declared span carries
 * a term for one of these reads: a term naming a timeout the provider does not
 * actually honour is not a bound, and the span every refresh gap and the reclaim
 * horizon are derived from is then a number the sweep routinely exceeds. Rather
 * than restate the provider's arithmetic in that term and hope it stays true,
 * the read arms the deadline itself and every caller inherits a real one. Both
 * providers combine a caller's signal with their own through `AbortSignal.any`,
 * so whichever fires first ends the call, and an abort surfaces here as an
 * exception -- which is `unknown`, the verdict that keeps what it protects.
 */
export const LIVE_WORK_READ_CEILING_MS = LIVE_WORK_EXEC_CEILING_MS + EXEC_TRANSPORT_SLACK_MS;

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
      // A marker is what says this sandbox files records at all, so a value
      // that is merely parseable cannot stand for one: an empty object would
      // clear the discriminator and let a zero count be admitted beneath it.
      try {
        const parsed: unknown = JSON.parse(line.slice(7));
        state.marker = isEpochMarker(parsed) ? parsed : null;
      } catch { /* no marker */ }
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

function isEpochMarker(value: unknown): value is EpochMarker {
  const m = value as Partial<EpochMarker> | null;
  return !!m && typeof m === "object" && !Array.isArray(m)
    && typeof m.epoch === "string" && m.epoch.length > 0
    && isProcessIdentity(m.bearer);
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
    && optional(r.signal, (v) => v === null || (typeof v === "string" && v.length > 0))
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
  // The caller's own reason to stop waiting, and this read's ceiling, are both
  // reasons to stop waiting: composed rather than chosen between, so a caller
  // that passes a signal does not thereby give up the bound.
  const deadline = AbortSignal.timeout(LIVE_WORK_READ_CEILING_MS);
  const until = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const result = await execInSandbox(inst, gatherCommand(stateDir), EXEC_TIMEOUT, until);
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

  // An unreadable marker leaves the question unanswered, and so does a subtree
  // this could not open. An `empty` subtree is neither: it is the state dir
  // standing with no `scopes/` under it, which is what a sandbox that has filed
  // no record looks like -- and filing no record is exactly zero shells.
  //
  // `scopes/` is created lazily, by the first `claimRecord`; `mintEpoch` makes
  // only the state root. So every sandbox that has never started a background
  // shell reports `SUBTREE empty` -- which, with BG_SHELL_ENABLED off, is every
  // sandbox in the fleet. Reading that as `unknown` made `countLiveWork` answer
  // `unknown` for all of them and never `clear`, and the two callers that need
  // `clear` to let go both stopped letting go: `collectIdleTarget` refreshes an
  // idle handle instead of expiring it, and `ensure-hands` retains a container
  // instead of destroying it. The fleet then only ever grows.
  //
  // Hands' own `subtreeReadable()` has always said this: absent `scopes/` with
  // the state root present is readable, not indeterminate. This is the same
  // answer, read from the other side of the exec.
  if (!state.marker || (state.subtree !== "ok" && state.subtree !== "empty")) {
    return {
      verdict: "unknown",
      classes: {},
      reason: !state.marker ? "no_epoch_marker" : `subtree_${state.subtree ?? "unreadable"}`,
    };
  }
  // No process table is no evidence about any record in it -- but a sandbox
  // that filed no records has nothing for the table to be evidence about, and
  // asking for it anyway would put the `empty` subtree above straight back into
  // `unknown` whenever `ls /proc` fails.
  if (state.records.length > 0 && state.livePids.size === 0) {
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
