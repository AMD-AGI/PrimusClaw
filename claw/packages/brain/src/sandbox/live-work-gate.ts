// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How much work a container still holds, read before anything destroys it.
 *
 * The old rule treated a restart refusal as licence to rebuild, asking nothing
 * about what was running: a fresh Hands has an empty registry, and empty read as
 * "destroying this is harmless" -- so a refusal on a pod with a training run in
 * it took the training run with it.
 *
 * The count comes from the durable records, over the same container-exec channel
 * the probe and the restart already use. Not an HTTP call to Hands: this runs on
 * exactly the path where Hands is what is down, so asking it would be circular.
 * And a record count is only as good as the population it covers, so the read
 * establishes first that the sandbox files records at all -- a process minting no
 * epoch marker is pre-scheme, its shells registry-only and invisible to any
 * count. Neither that nor an unreadable marker is a count of zero.
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
 * Everything the classifier needs, gathered by one command inside the sandbox.
 *
 * One command rather than several: a container-exec round trip is the expensive
 * part, and a records read split across calls could see the subtree in two
 * different states. `HANDS_STATE_DIR` is where the records live; the marker sits
 * beside them at the root, so a missing marker and an unreadable subtree are
 * distinguishable in the output rather than collapsing into one absence.
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
      // A record that will not parse is not a record that is absent: it may be
      // the live shell, and dropping it lets the count come back a determinate
      // zero -- the empty-state inference this whole read exists to refuse.
      try {
        state.records.push(JSON.parse(line.slice(7)) as ShellRecord);
      } catch {
        throw new Error("a shell record could not be read");
      }
    } else if (line.startsWith("PROCS ")) {
      for (const entry of line.slice(6).trim().split(/\s+/)) {
        const pid = Number(entry);
        if (Number.isInteger(pid) && pid > 0) state.livePids.add(pid);
      }
    }
  }
  return state;
}

/**
 * How fresh a record's epoch is, from what one exec read saw.
 *
 * Equality with the marker proves only that no newer Hands has started -- a
 * crashed one leaves its marker exactly as it wrote it -- so currency turns on
 * the marker's bearer still being in the process table. A bearer whose liveness
 * the read could not establish is neither current nor stale: reading it as stale
 * would convert unresolved live work into a class that unblocks a destroy.
 */
function freshness(record: ShellRecord, state: GatheredState): EpochFreshness {
  if (!state.marker) return "indeterminate";
  if (state.marker.epoch !== record.hands_epoch) return "stale";
  if (state.livePids.size === 0) return "indeterminate";
  return bearerAlive(state.marker.bearer, state) ? "current" : "stale";
}

function bearerAlive(bearer: ProcessIdentity | undefined, state: GatheredState): boolean {
  return !!bearer && state.livePids.has(bearer.pid);
}

/**
 * What one record classifies as over this channel.
 *
 * The in-process registry is not exec-visible, so a row this coarser view cannot
 * separate reads `unverified_running` rather than `inconsistent` -- no row moves
 * from blocking to non-blocking, which is the direction that matters.
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
 * The record-derived answer about one container, for a path about to destroy,
 * rebuild, evict, replace, or relaunch in it.
 *
 * `unknown` and `protected` differ in what an operator is told, never in what
 * the caller may do: both forbid every destructive act. Only `clear` permits one.
 */
export async function countLiveWork(
  inst: SandboxInstance,
  stateDir: string,
  signal?: AbortSignal,
): Promise<LiveWorkAnswer> {
  let stdout: string;
  try {
    const result = await execInSandbox(inst, gatherCommand(stateDir), EXEC_TIMEOUT, signal);
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

  // A sandbox that files no records has shells this count cannot see, and one
  // whose marker could not be read leaves the same question unanswered. Neither
  // is zero: that is the empty-state inference a destroy must never act on.
  if (!state.marker || state.subtree !== "ok") {
    return {
      verdict: "unknown",
      classes: {},
      reason: !state.marker ? "no_epoch_marker" : `subtree_${state.subtree ?? "unreadable"}`,
    };
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
