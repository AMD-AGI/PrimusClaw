// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { ExecuteRequest } from "@claw/protocol";
import pino from "pino";

import { AUTH_INTERNAL_TOKEN, BRAIN_ID } from "../config.js";

const logger = pino({ name: "run-claim-client" });

/**
 * Cluster API base used for claim traffic.
 *
 * Read at call time so a test can point it, and so a doorbell's `claim_url`
 * is never the address we POST the cluster token to. The payload may name a
 * host; this replica already knows its own.
 */
function apiBase(): string {
  return (process.env.INTERNAL_BACKEND_URL ?? "").trim().replace(/\/$/, "");
}

function taskActionUrl(taskId: string, action: "claim" | "unclaim" | "fail-claim"): string {
  const base = apiBase();
  if (!base || !taskId) return "";
  return `${base}/v1/internal/tasks/${encodeURIComponent(taskId)}/${action}`;
}

/**
 * A run this replica now holds, and how many times the row has been handed out.
 *
 * The count is the row's `claim_count` after this claim incremented it. It is
 * the doorbell path's substitute for a JetStream delivery count: the wakeup is
 * acked the moment the claim succeeds, so nothing on the message side counts
 * attempts any more, while the row keeps counting them all the way to the
 * poison ceiling.
 */
export interface ClaimedRun {
  request: ExecuteRequest;
  claimCount: number;
}

export async function claimRun(taskId: string): Promise<ClaimedRun | null> {
  const url = taskActionUrl(taskId, "claim");
  if (!url) {
    logger.warn("run.claim.no_api_url");
    throw new Error("run.claim.no_api_url");
  }
  return postClaim(url);
}

export async function claimNextRun(): Promise<ClaimedRun | null> {
  const base = apiBase();
  if (!base) {
    logger.warn("run.claim_next.no_api_url");
    throw new Error("run.claim_next.no_api_url");
  }
  return postClaim(`${base}/v1/internal/runs/claim-next`);
}

/**
 * Give a claimed row back. `claimCount` is the generation this holder took;
 * the API refuses the release if the row has been claimed again since. See
 * releaseClaim in the API for why owner alone is not enough.
 */
export async function unclaimRun(
  taskId: string,
  claimCount?: number,
  reason?: "lock_contention" | "retry" | "drain" | "hydrate_failed",
): Promise<void> {
  await postHolderAction(taskId, "unclaim", "run.unclaim_failed", {
    ...claimExtra(claimCount), ...(reason ? { reason } : {}),
  });
}

export async function failClaimedRun(
  taskId: string,
  reason: "session_deleted" | "claim_abandoned" | "workspace_unbound" = "session_deleted",
  claimCount?: number,
): Promise<void> {
  await postHolderAction(taskId, "fail-claim", "run.fail_claim_failed", {
    reason, ...claimExtra(claimCount),
  });
}

function claimExtra(claimCount?: number): Record<string, string | number> {
  return typeof claimCount === "number" ? { claim_count: claimCount } : {};
}

async function postHolderAction(
  taskId: string,
  action: "unclaim" | "fail-claim",
  warn: string,
  extra: Record<string, string | number> = {},
): Promise<void> {
  const url = taskActionUrl(taskId, action);
  if (!url) return;
  const attempts = 3;
  let lastDetail: unknown = null;
  for (let i = 0; i < attempts; i++) {
    // Spaced, because the failures worth retrying here are a rolling API
    // deploy or a connection pool at its limit, and three requests inside a
    // few milliseconds all land in the same bad moment. Doubling from 250ms
    // spans about a second in total, which is short enough to stay in the
    // caller's path and long enough to outlast a pod swap's gap.
    if (i > 0) await sleep(HOLDER_RETRY_BASE_MS * 2 ** (i - 1));
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: claimHeaders(),
        body: JSON.stringify({ brain_id: BRAIN_ID, ...extra }),
        signal: AbortSignal.timeout(5_000),
      });
      if (resp.ok || resp.status === 409) return;
      lastDetail = `status ${resp.status}`;
      logger.warn({ taskId, action, status: resp.status, attempt: i + 1 }, warn);
    } catch (err) {
      lastDetail = err;
      logger.warn({ err, taskId, action, attempt: i + 1 }, warn);
    }
  }
  // Every attempt failed and the caller cannot act on it -- both callers are
  // settling a row they are done with. Logged at error rather than swallowed
  // because what follows is invisible otherwise: the row keeps a lease nobody
  // is renewing, and only the sweeper's requeue pass will notice, a minute or
  // more later.
  logger.error({ taskId, action, attempts, lastDetail }, `${warn}.exhausted`);
}

const HOLDER_RETRY_BASE_MS = 250;

/**
 * A wait somebody is awaiting, so the timer keeps the process alive.
 *
 * The unref that used to be here is right for a detached backoff -- see the
 * two in doorbell-delivery, which nothing awaits and which the drain covers --
 * and wrong for this one. `postHolderAction` awaits it between retries, and an
 * unref'd timer does not hold the event loop: when this sleep is the last
 * pending thing, node decides it has no work left and exits, so the await
 * never returns and the release is simply lost.
 *
 * That is exactly the case the drain exists for. `flushPendingRetries` awaits
 * `Promise.allSettled([...inFlightReleases])` so a shutdown does not walk away
 * from an unclaim it has already started -- but awaiting does not hold the
 * loop open, handles do. During SIGTERM, with the consumer stopped and one
 * release retrying a rolling API, this was the only handle left and it was
 * invisible.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function postClaim(url: string): Promise<ClaimedRun | null> {
  const resp = await fetch(url, {
    method: "POST",
    headers: claimHeaders(),
    body: JSON.stringify({ brain_id: BRAIN_ID }),
    signal: AbortSignal.timeout(10_000),
  });
  // 422 is a settled row (unclaimable / retries exhausted), not a transport
  // miss: retrying the wakeup would only nak into the same answer.
  if (resp.status === 409 || resp.status === 404 || resp.status === 422) return null;
  if (!resp.ok) {
    const body = (await resp.text()).slice(0, 300);
    throw new Error(`claim ${resp.status}: ${body}`);
  }
  const data = await resp.json() as {
    ok?: boolean; request?: ExecuteRequest | null; claim_count?: unknown;
  };
  if (!data.request) return null;
  // Floor of 1: an API too old to report the count, or a row whose column read
  // back as null, must still produce a first-attempt delay rather than a zero.
  const raw = Number(data.claim_count);
  const claimCount = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  return { request: data.request, claimCount };
}

function claimHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${AUTH_INTERNAL_TOKEN}`,
  };
}
