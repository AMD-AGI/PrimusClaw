// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one wait loop for a SaFE workload that is being provisioned.
 *
 * Single-node sandboxes and multi-node GPU clusters are created with different
 * bodies and become usable on different conditions, but how they are waited on
 * has to be one behaviour: the same poll rhythm, the same reading of a status,
 * the same set of ways to stop waiting. They were two loops before this, and the
 * two came to disagree -- the multi-node one had a queue ceiling and none of the
 * three backstops, so a SaFE that stopped answering left a GPU cluster being
 * polled forever, which is the stuck `launching` session the single-node loop
 * had already been taught to end.
 *
 * What stays a parameter is only what genuinely differs: what counts as ready
 * (a phase for a sandbox, live pod IPs for an Infera cluster), what to do with
 * the workload when the wait is given up (a cluster is reaped so it stops
 * holding GPUs; a sandbox is left to the reaper), and the shape of the progress
 * events each side's consumers already parse.
 */

import pino from "pino";
import { sleep } from "@claw/utils";
import { SAFE_API_URL, SANDBOX_POLL_TIMEOUT_MS, SANDBOX_PENDING_TIMEOUT_MS } from "../config.js";
import { SandboxProvisionTerminalError, classifyWorkloadTerminalReason } from "./errors.js";

const logger = pino({ name: "workload-wait" });

/**
 * Gap between status reads.
 *
 * A constant rather than a setting. The two loops this replaces both polled every
 * 5s -- one hardcoded, one from RAY_JOB_POLL_INTERVAL_MS, which no deployment set
 * and which named only one of the two paths it would now govern. Keeping it a
 * knob would mean a key whose name implies it tunes multi-node while tuning
 * sandboxes as well; the timeouts that decide when a wait ends are the settings
 * worth exposing, and those are configured.
 */
const POLL_INTERVAL_MS = 5000;

/**
 * Phases from which a workload will never become ready.
 *
 * The union of what the two loops each used to check: the sandbox loop knew
 * Failed and Stopped, the multi-node one added Succeeded, Terminated and
 * Cancelled. None of the three can precede a Running, so recognising all of them
 * on both paths only closes a hang -- a Succeeded sandbox workload used to be
 * polled indefinitely, being neither Running nor Pending nor terminal.
 */
export const TERMINAL_PHASES = new Set([
  "failed",
  "stopped",
  "succeeded",
  "terminated",
  "cancelled",
]);

/**
 * Seams for the wait loop, defaulted to the real runtime.
 *
 * Present so the rules below can be tested with a scripted status sequence and a
 * clock the test moves itself. Every one of them is a rule about elapsed time,
 * and there is no waiting an hour to find out whether an hour-long backstop
 * fires.
 */
export interface WorkloadWaitDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
  pollMs?: number;
  /** Per-request timeout for one status read. */
  requestTimeoutMs?: number;
  /** 0 disables the backstop (wait forever even when unreadable). */
  unreadableTimeoutMs?: number;
  /** 0 disables the ceiling (queue forever). */
  pendingTimeoutMs?: number;
  /** Consecutive 404s that mean the workload is gone. */
  notFoundLimit?: number;
  /** Minimum gap between progress events. */
  notifyIntervalMs?: number;
}

/** What a caller is told about a workload that is still coming up. */
export interface WorkloadWaitProgress {
  phase: string;
  queuePosition: number;
}

/** What a caller is told about a workload that will never come up. */
export interface WorkloadWaitTerminal {
  phase: string;
  /** "stopped" for a stop, "failed" for everything else. */
  status: string;
  reason: string;
}

export interface WorkloadWaitOptions {
  workloadId: string;
  apiKey: string;
  /**
   * Whether a readable detail means the workload can be used. Also gates the
   * pod-exited check, so anything still short of ready is still watched for a
   * pod that died on the way -- for Infera that is a cluster reporting Running
   * whose role pods are gone, which is exactly when it matters.
   */
  isReady: (detail: Record<string, unknown>) => boolean;
  /** Prefix for this caller's log events, e.g. "hands" or "mn.safe". */
  logPrefix: string;
  /** Progress, throttled by the loop rather than by the caller. */
  onProgress?: (p: WorkloadWaitProgress) => Promise<void>;
  onReady?: (p: WorkloadWaitProgress) => Promise<void>;
  onTerminal?: (t: WorkloadWaitTerminal) => Promise<void>;
  /**
   * Last chance to act on the workload before the wait throws. Runs for every
   * terminal outcome, so a caller that must reclaim resources reclaims them
   * however the wait ended, rather than only on the reasons it thought of.
   */
  onGiveUp?: (g: { reason: string; phase: string }) => Promise<void>;
  deps?: WorkloadWaitDeps;
}

/**
 * Poll a workload until it is ready, and return the detail that said so.
 *
 * A readable Pending is a healthy queued state and is waited on indefinitely --
 * a queued workload is never dispatched and SaFE never times it out for us --
 * bounded only by the queue ceiling. The wait ends on:
 *   - ready                            -> returns the detail;
 *   - a terminal phase                 -> reason from the classifier;
 *   - a pod that exited before ready    -> sandbox_exited_before_ready;
 *   - consecutive 404s past the limit  -> sandbox_gone;
 *   - an unreadable status past the deadline -> sandbox_status_unreadable:
 *     persistent non-2xx (401 and 403 included, since a flaky auth backend can
 *     blip one and a single sample must not be terminal), fetch failures, or a
 *     2xx whose body carries no phase;
 *   - Pending past the ceiling         -> sandbox_pending_timeout, counted only
 *     while queued and reset on dispatch, because from dispatch on the
 *     workload's own SaFE timeout governs.
 *
 * Any readable status refreshes the unreadable deadline, so healthy queuing and
 * a dark SaFE are never confused for one another.
 */
export async function waitForWorkloadReady(
  opts: WorkloadWaitOptions,
): Promise<Record<string, unknown>> {
  const { workloadId, apiKey, isReady, logPrefix, deps } = opts;
  const doFetch = deps?.fetchImpl ?? fetch;
  const doSleep = deps?.sleepImpl ?? sleep;
  const now = deps?.nowImpl ?? Date.now;
  const POLL_MS = deps?.pollMs ?? POLL_INTERVAL_MS;
  const REQUEST_TIMEOUT_MS = deps?.requestTimeoutMs ?? 15_000;
  const UNREADABLE_TIMEOUT_MS = deps?.unreadableTimeoutMs ?? SANDBOX_POLL_TIMEOUT_MS;
  const PENDING_TIMEOUT_MS = deps?.pendingTimeoutMs ?? SANDBOX_PENDING_TIMEOUT_MS;
  const NOT_FOUND_LIMIT = deps?.notFoundLimit ?? 12;
  const NOTIFY_INTERVAL_MS = deps?.notifyIntervalMs ?? 600_000;

  const detailUrl = `${SAFE_API_URL}/api/v1/workloads/${workloadId}`;
  const pollStart = now();
  let lastNotifyMs = 0;
  let consecutiveNotFound = 0;
  let lastReadableMs = pollStart;
  let lastProblem = "";
  // When the workload was first seen queued. Measured only while it is still
  // Pending; leaving Pending stops the clock for good.
  let pendingSince: number | null = null;

  /** Run the caller's last-chance hook, then end the wait terminally. */
  const giveUp = async (reason: string, phase: string, message: string): Promise<never> => {
    // Swallowed deliberately: a hook that fails must not replace the reason the
    // wait ended with, which is the part the caller acts on.
    await opts.onGiveUp?.({ reason, phase }).catch((e) => {
      logger.warn({ err: String(e), workloadId, reason }, `${logPrefix}.give_up_hook_failed`);
    });
    throw new SandboxProvisionTerminalError(reason, message);
  };

  while (true) {
    await doSleep(POLL_MS);
    const elapsed = ((now() - pollStart) / 1000).toFixed(1);

    if (UNREADABLE_TIMEOUT_MS > 0 && now() - lastReadableMs > UNREADABLE_TIMEOUT_MS) {
      // Report how long the status has been unreadable rather than the whole
      // wait: a workload that queued healthily for hours before SaFE went dark
      // should read "unreadable for 3600s", not the total elapsed time.
      const unreadableFor = ((now() - lastReadableMs) / 1000).toFixed(1);
      return await giveUp(
        "sandbox_status_unreadable",
        "",
        `workload ${workloadId} status unreadable for ${unreadableFor}s (last: ${lastProblem || "unknown"})`,
      );
    }

    let phase = "";
    let queuePosition = 0;
    let detail: Record<string, unknown> = {};
    try {
      const resp = await doFetch(detailUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!resp.ok) {
        if (resp.status === 404) {
          consecutiveNotFound++;
          if (consecutiveNotFound >= NOT_FOUND_LIMIT) {
            return await giveUp(
              "sandbox_gone",
              "",
              `workload ${workloadId} disappeared (${consecutiveNotFound} consecutive 404s)`,
            );
          }
        } else {
          // A non-404 breaks the streak, so it must not leave a stale count
          // that later false-positives sandbox_gone.
          consecutiveNotFound = 0;
        }
        lastProblem = `HTTP ${resp.status}`;
        logger.warn({ workloadId, status: resp.status, elapsed, consecutiveNotFound }, `${logPrefix}.poll_error`);
        continue;
      }
      // A 2xx breaks the streak whatever its body turns out to be.
      consecutiveNotFound = 0;
      detail = (await resp.json()) as Record<string, unknown>;
      phase = String((detail.phase as string) ?? "").toLowerCase();
      queuePosition = (detail.queuePosition as number) || 0;

      // Readable means a 2xx that parsed into a phase, and only that refreshes
      // the deadline. An unparseable body throws in json() above; a 2xx with no
      // phase is not a status we can act on either, so neither may pass for
      // healthy queuing.
      if (phase) {
        lastReadableMs = now();
        lastProblem = "";
      } else {
        lastProblem = `HTTP ${resp.status} (empty phase)`;
        logger.warn({ workloadId, status: resp.status, elapsed }, `${logPrefix}.poll_empty_phase`);
      }
    } catch (e: any) {
      if (e instanceof SandboxProvisionTerminalError) throw e;
      // A fetch exception is not a 404, so it breaks the streak, and it leaves
      // the status unreadable rather than refreshing the deadline.
      consecutiveNotFound = 0;
      lastProblem = String(e?.message ?? e).slice(0, 200);
      logger.warn({ err: e, workloadId, elapsed }, `${logPrefix}.poll_exception`);
      continue;
    }

    const ready = Boolean(phase) && isReady(detail);
    logger.info({ workloadId, phase, queuePosition, ready, elapsed }, `${logPrefix}.poll_status`);

    if (ready) {
      await opts.onReady?.({ phase, queuePosition }).catch(() => {});
      logger.info({ workloadId, elapsed }, `${logPrefix}.workload_ready`);
      return detail;
    }

    // Ahead of the phase check, and deliberately: a workload can report a
    // terminal phase because its pod exited, and "the image exits instead of
    // serving" is the more useful of the two answers to hand back.
    //
    // Short of ready, so a pod that has already exited will not be coming back.
    // Gated on readiness rather than on the phase, which is the same thing for a
    // sandbox but not for an Infera cluster: that reports Running while its role
    // pods are still arriving, and a role pod that dies in that window leaves a
    // cluster that reads healthy and never becomes usable.
    const pods = Array.isArray(detail.pods) ? (detail.pods as Record<string, unknown>[]) : [];
    const exited = pods.find((p) => {
      const pp = String(p?.phase ?? "").toLowerCase();
      return pp === "succeeded" || pp === "failed";
    });
    if (exited) {
      const podPhase = String(exited.phase ?? "");
      await opts.onTerminal?.({
        phase: "Failed",
        status: "failed",
        reason: "sandbox_exited_before_ready",
      }).catch(() => {});
      logger.error({ workloadId, podPhase, elapsed }, `${logPrefix}.exited_before_ready`);
      return await giveUp(
        "sandbox_exited_before_ready",
        phase,
        `workload ${workloadId} pod terminated (phase=${podPhase}) before becoming ready`
        + " -- the image likely exits immediately instead of running its server",
      );
    }

    if (TERMINAL_PHASES.has(phase)) {
      // Keep the stop/failure distinction: Stopped covers the workload's own
      // timeout and an admin or owner stopping it, none of which are crashes,
      // and a consumer needs to tell those apart from a failure.
      const reason = classifyWorkloadTerminalReason(detail);
      const status = phase === "stopped" ? "stopped" : "failed";
      await opts.onTerminal?.({ phase, status, reason }).catch(() => {});
      return await giveUp(reason, phase, `workload ${workloadId} entered terminal phase=${phase}`);
    }

    // The queue ceiling, enforced only while genuinely queued. The moment the
    // workload leaves the queue the clock stops and stays off, so one that is
    // dispatched and busy pulling a large image is never reaped as "pending".
    // An unreadable phase leaves the clock alone; that case belongs to the
    // backstop above.
    if (phase === "pending") {
      if (pendingSince === null) pendingSince = now();
      if (PENDING_TIMEOUT_MS > 0 && now() - pendingSince > PENDING_TIMEOUT_MS) {
        const pendingFor = ((now() - pendingSince) / 1000).toFixed(1);
        return await giveUp(
          "sandbox_pending_timeout",
          phase,
          `workload ${workloadId} still queued (Pending) after ${pendingFor}s`,
        );
      }
    } else if (phase) {
      pendingSince = null;
    }

    const nowMs = now();
    if (lastNotifyMs === 0 || nowMs - lastNotifyMs >= NOTIFY_INTERVAL_MS) {
      lastNotifyMs = nowMs;
      await opts.onProgress?.({ phase, queuePosition }).catch(() => {});
    }
  }
}
