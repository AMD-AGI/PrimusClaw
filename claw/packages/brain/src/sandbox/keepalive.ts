// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { StringCodec, type KV } from "nats";
import { isRevisionConflict } from "@claw/utils";
import {
  SANDBOX_KEEPALIVE_INTERVAL_SEC,
  SANDBOX_KEEPALIVE_FAIL_LIMIT,
  SANDBOX_IDLE_REUSE_MS,
} from "../config.js";
import { clearRetryPending, getRetryPending, isRetryPendingExpired } from "../tasks/retry-pending.js";
import { destroyHands } from "./reaper.js";
import { sessionHasActiveRunLease } from "./registry.js";
import { getAgentSandboxProvider, getSafeWorkloadProvider } from "./factory.js";
import { countActiveShells } from "../clients/hands.js";
import pino from "pino";

const logger = pino({ name: "sandbox-keepalive" });
const sc = StringCodec();

/** Minimal info needed by keepalive to ping a sandbox. */
export interface SandboxEntry {
  /** undefined / "safe-workload": SaFE path; "agent-sandbox": kubernetes path. */
  provider?: "safe-workload" | "agent-sandbox";
  workloadId?: string;   // safe-workload
  platformKey?: string;  // safe-workload
  sessionId?: string;    // agent-sandbox
  sandboxName?: string;  // agent-sandbox
  namespace?: string;
  userId?: string;       // agent-sandbox: BYOK identity forwarded to the Router
}

interface HandsKvEntry {
  status?: "pending" | "ready";
  provider?: "safe-workload" | "agent-sandbox";
  workloadId?: string;
  sessionId?: string;
  sandboxName?: string;
  handsUrl: string;
  sandboxImage?: string | null;
  platformKey?: string;
  token?: string;
  namespace?: string;
  userId?: string;
  createdAt?: string;
  /**
   * The key the run lease is under: the DAG root when the run has one, the
   * session otherwise. Absent on entries written before it was recorded, and
   * the readers fall back to the session for those.
   */
  runScope?: string;
  /** False on a post-task idle reuse handle: kept for reuse but NOT pinged so
   *  the pod idles out via the control-plane GC. Set by stopKeepaliveAfterTask. */
  keepalive?: boolean;
  /** Epoch ms when the handle became idle; used to expire it after the window. */
  idleSince?: number;
  /** True on a handle parked by a session delete rather than by a finished task.
   *  The multi-node sweep reclaims these without waiting out the idle window,
   *  there being no next message to hold a cluster for. Set by parkHandsHandle. */
  sessionDeleted?: boolean;
}

interface KeepaliveDeps {
  kv: KV;
  /**
   * Test seam for the background-work probe, which is otherwise a live HTTP call
   * to a Hands that does not exist under test -- and whose failure path answers
   * "no work", so the interesting branch would never be reached.
   */
  countActiveShells?: (url: string, token: string, owner: string) => Promise<number>;
}

let timer: ReturnType<typeof setInterval> | null = null;
const failCounts = new Map<string, number>();

// ── In-memory registry: the primary source of truth for active sandboxes ──
// Brain itself creates these sandboxes — it knows about them without
// needing to discover them through NATS KV. NATS KV is only used as a
// secondary source to recover sessions that survived a Brain restart.
interface RegisteredSandbox {
  sessionId: string;
  entry: SandboxEntry;
}

const localRegistry = new Map<string, RegisteredSandbox>();

function sandboxRegistryKey(sessionId: string, entry: SandboxEntry): string {
  return entry.provider === "agent-sandbox"
    ? `${sessionId}:agent:${entry.sessionId || ""}:${entry.namespace || ""}:${entry.sandboxName || ""}`
    : `${sessionId}:safe:${entry.workloadId || ""}`;
}

/** Drop orphaned READY sandboxes when a retryable attempt was never redelivered. */
async function shouldSkipExpiredRetry(
  deps: KeepaliveDeps,
  sessionId: string,
  source: "local" | "kv",
  entry?: SandboxEntry,
): Promise<boolean> {
  const pending = await getRetryPending(deps.kv, sessionId);
  const nowMs = Date.now();
  if (!pending || !isRetryPendingExpired(pending, nowMs)) return false;
  const lockKey = pending.lockKey || sessionId;
  const activeLock = await deps.kv.get(`lock.${lockKey}`).catch(() => null);
  if (activeLock) {
    logger.warn(
      {
        sessionId,
        source,
        lockKey,
        attempt: pending.attempt,
        messageId: pending.messageId,
        reasonClass: pending.reasonClass,
        workloadId: entry?.workloadId || pending.workloadId,
        deadlineMs: pending.deadlineMs,
        deadlineIso: new Date(pending.deadlineMs).toISOString(),
      },
      "keepalive.retry_pending_expired_but_lock_active",
    );
    return false;
  }

  unregisterSandbox(sessionId, entry);
  await deps.kv.delete(`hands.${sessionId}`).catch(() => {});
  await clearRetryPending(deps.kv, sessionId, pending.lockKey);
  logger.warn(
    {
      sessionId,
      source,
      attempt: pending.attempt,
      messageId: pending.messageId,
      lockKey,
      reasonClass: pending.reasonClass,
      reason: pending.reason,
      workloadId: entry?.workloadId || pending.workloadId,
      graceSec: pending.graceSec,
      ageMs: nowMs - pending.createdAtMs,
      createdAtMs: pending.createdAtMs,
      createdAtIso: new Date(pending.createdAtMs).toISOString(),
      deadlineMs: pending.deadlineMs,
      deadlineIso: new Date(pending.deadlineMs).toISOString(),
      expiredByMs: nowMs - pending.deadlineMs,
    },
    "keepalive.retry_pending_expired",
  );
  return true;
}

/** Register a sandbox for keepalive pinging. Called by ensureHands. */
export function registerSandbox(sessionId: string, entry: SandboxEntry): void {
  localRegistry.set(sandboxRegistryKey(sessionId, entry), { sessionId, entry });
  logger.info({ sessionId, workloadId: entry.workloadId }, "keepalive.registered");
}

function sameRegisteredSandbox(a: SandboxEntry, b: SandboxEntry): boolean {
  const aAgent = a.provider === "agent-sandbox";
  const bAgent = b.provider === "agent-sandbox";
  if (aAgent !== bAgent) return false;
  return aAgent
    ? !!(
      a.sessionId
      && a.sessionId === b.sessionId
      && a.sandboxName
      && a.sandboxName === b.sandboxName
      && (a.namespace || "") === (b.namespace || "")
    )
    : !!(a.workloadId && a.workloadId === b.workloadId);
}

/**
 * Unregister a sandbox. With `known`, only remove that exact registration;
 * a DAG sibling may have replaced the session-keyed local entry meanwhile.
 */
export function unregisterSandbox(sessionId: string, known?: SandboxEntry): void {
  const keys = known
    ? [sandboxRegistryKey(sessionId, known)]
    : [...localRegistry.entries()]
      .filter(([, value]) => value.sessionId === sessionId)
      .map(([key]) => key);
  let had = false;
  for (const key of keys) {
    had = localRegistry.delete(key) || had;
    failCounts.delete(key);
  }
  if (had) {
    logger.info({ sessionId }, "keepalive.unregistered");
  }
}

/** Number of locally active sandbox identities for a session. */
export function registeredSandboxCount(sessionId: string): number {
  let count = 0;
  for (const registered of localRegistry.values()) {
    if (registered.sessionId === sessionId) count++;
  }
  return count;
}

/**
 * Mark a READY `hands.<sid>` entry idle (keepalive:false) so it is kept as a
 * reuse handle but no longer pinged. Called by stopKeepaliveAfterTask instead
 * of deleting the entry outright, so the next message in the same session
 * can still reuse the pod via ensureHands within SANDBOX_IDLE_REUSE_MS
 * (collectTargets above skips pinging it and expires it after the window).
 *
 * Fire-and-forget. An entry that cannot be parsed is dropped; a KV error is
 * not, because the entry may be fine and it is the only record the idle sweeper
 * can find the session's GPU clusters through.
 */
export function markHandsIdle(
  kv: KV,
  sessionId: string,
  known: SandboxEntry | string,
): void {
  const kvKey = `hands.${sessionId}`;
  kv.get(kvKey)
    .then(async (entry) => {
      if (!entry) return; // no handle to keep; a fresh task will recreate one.
      let info: HandsKvEntry;
      try {
        info = JSON.parse(sc.decode(entry.value)) as HandsKvEntry;
      } catch (err) {
        // Unreadable ownership data is not evidence that no live sandbox is
        // referenced. Preserve it for operator repair and natural TTL expiry.
        logger.warn(
          { err: (err as Error)?.message || String(err), sessionId },
          "hands.mark_idle_unreadable",
        );
        return;
      }
      // Only keep a READY handle that still points at the workload we ran on.
      if (info.status !== "ready") return;
      const sameTarget = typeof known === "string"
        ? !(known && info.workloadId && info.workloadId !== known)
        : sameRegisteredSandbox(known, info);
      if (!sameTarget) return;
      info.keepalive = false;
      info.idleSince = Date.now();
      // Conditioned on the revision just read, because a session teardown can
      // delete this entry between the read and the write. An unconditional put
      // would resurrect the handle of a deleted session, and collectTargets
      // then refreshes its TTL for the whole reuse window rather than letting
      // it expire -- so the deleted session's platformKey and workload id would
      // outlive it by 15 minutes.
      await kv.update(kvKey, sc.encode(JSON.stringify(info)), entry.revision);
    })
    .catch((err) => {
      if (isRevisionConflict(err)) {
        // Deleted or rewritten while we were deciding; whoever did it wins. In
        // particular, do not fall through to the delete below -- that would
        // remove an entry somebody else just wrote.
        logger.info({ sessionId }, "hands.mark_idle_superseded");
        return;
      }
      // A transport failure may arrive after the CAS succeeded, and another
      // writer may already own the key. An unconditional delete here could
      // erase that sibling, so preserve the latest value.
      logger.warn({ err: err?.message || String(err), sessionId }, "hands.mark_idle_failed");
    });
}

/**
 * Build the merged ping target list: in-memory registry (primary) + NATS KV
 * (secondary, for crash-recovery of sessions created by a previous Brain pod).
 */
/**
 * Whether an idle handle's sandbox still has background work running in it.
 *
 * `stopKeepaliveAfterTask` marks the handle idle on every terminal task, and an
 * idle handle is never pinged, so the control-plane GC reclaims the pod about
 * fifteen minutes later. That is right when the sandbox is only a warm cache for
 * the next message. It is wrong when the turn left something running: Claw's own
 * rule is that a `run_in_background` shell outlives the turn that started it --
 * "the user is still there, and a shell started this turn is expected to still
 * be running when they ask about it in the next one, which is the reason
 * background shells exist at all" -- and reclaiming the pod kills it anyway. The
 * two policies contradicted each other; this is the side that reads the fact.
 *
 * Asked with the session as the owner, which is the key Hands files shells under
 * for everything except a DAG node (there it is the DAG root, and a DAG node's
 * shells are reaped when it finishes, so there is nothing left to protect). Not
 * `runScope`: that is the run *lease* key, a workspace id under
 * RUN_GATE_KEY=workspace, and it would match no owner at all.
 *
 * A failure answers false -- the same decision this code made before the check
 * existed, so an unreachable Hands cannot make things worse than they were. It
 * does leave a hole worth naming: Hands keeps this registry in memory, so a
 * Hands that restarted reports zero for shells that are still running, and the
 * sandbox is then reclaimed as if the turn had left nothing behind.
 */
async function idleHandleHasBackgroundWork(
  deps: KeepaliveDeps,
  sessionId: string,
  info: HandsKvEntry,
): Promise<boolean> {
  if (!info.handsUrl || !info.token) return false;
  try {
    const probe = deps.countActiveShells ?? countActiveShells;
    const running = await probe(info.handsUrl, info.token, sessionId);
    if (running > 0) {
      logger.info(
        { sessionId, workloadId: info.workloadId, running },
        "keepalive.idle_handle_kept_background_work",
      );
    }
    return running > 0;
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message ?? err, sessionId },
      "keepalive.background_work_check_failed",
    );
    return false;
  }
}

async function collectTargets(deps: KeepaliveDeps): Promise<Map<string, RegisteredSandbox>> {
  const targets = new Map<string, RegisteredSandbox>();

  // 1. In-memory registry — always authoritative for this process.
  for (const [key, registered] of localRegistry) {
    if (await shouldSkipExpiredRetry(
      deps,
      registered.sessionId,
      "local",
      registered.entry,
    )) continue;
    targets.set(key, registered);
  }

  // 2. NATS KV — pick up sessions from previous Brain runs that are still alive.
  try {
    // Filtered server-side: this bucket also holds `lock.*`, `deleted.*` and
    // `brain.min_version`, and this runs every SANDBOX_KEEPALIVE_INTERVAL_SEC --
    // the most frequent of the three walks over these keys.
    const keys = await deps.kv.keys("hands.*");
    for await (const key of keys) {
      const sessionId = key.slice("hands.".length);
      const e = await deps.kv.get(key).catch(() => null);
      if (!e) continue;
      try {
        const info = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
        if (info.status && info.status !== "ready") continue;
        // Post-task idle reuse handle: keep it for reuse but never ping it, so
        // the pod idles out via the control-plane GC (no extra cost). Refresh
        // its TTL within the reuse window; expire it afterwards.
        if (info.keepalive === false && !(await idleHandleHasBackgroundWork(deps, sessionId, info))) {
          const idleSince = typeof info.idleSince === "number" ? info.idleSince : 0;
          const expired = Date.now() - idleSince > SANDBOX_IDLE_REUSE_MS;
          // A session this replica is actively running is not idle, whatever
          // the entry says. The `local wins` short-circuit that used to guard
          // the whole KV branch was removed so DAG siblings could each be
          // pinged, and it took this delete's protection with it: a reuse that
          // failed to clear the markers -- or an entry a sibling wrote while
          // this one was mid-turn -- now reads as an expired handle, and the
          // key naming the live workload goes out from under the run.
          if (expired && registeredSandboxCount(sessionId) > 0) {
            // No TTL refresh needed here: a session this replica has registered
            // is also a local ping target, and that path re-puts the entry at
            // the revision it read. Refreshing again would be a second write
            // per tick for the same effect.
            logger.info(
              { sessionId, workloadId: info.workloadId },
              "keepalive.idle_handle_kept_locally_active",
            );
            continue;
          }
          if (expired && await sessionHasActiveRunLease(deps.kv, sessionId, info.runScope)) {
            // The check above answers "is THIS replica running it", which the
            // other replicas answer with zero for a session they are not
            // running. The run lease is the fleet-wide form of the same
            // question, and without it whichever replica sweeps first deletes
            // the key naming a workload that is in use.
            logger.info(
              { sessionId, workloadId: info.workloadId },
              "keepalive.idle_handle_kept_run_in_flight",
            );
            continue;
          }
          if (expired) {
            await deps.kv.delete(key, { previousSeq: e.revision }).catch(() => {});
            logger.info({ sessionId, workloadId: info.workloadId }, "keepalive.idle_handle_expired");
          } else {
            // Refresh the TTL only, no ping -- and conditionally, because an
            // unconditional put bumps the revision that ensureHands is holding
            // while it reactivates this very handle. Losing the race is the
            // correct outcome: whoever won either refreshed the same TTL or
            // took the handle out of idle, and neither wants this write.
            await deps.kv.update(key, e.value, e.revision).catch(() => {});
          }
          continue;
        }
        const provider = info.provider === "agent-sandbox" ? "agent-sandbox" : "safe-workload";
        // safe-workload needs workloadId+platformKey; agent-sandbox needs sessionId.
        const usable = provider === "agent-sandbox"
          ? !!info.sessionId
          : !!(info.workloadId && info.platformKey);
        if (!usable) continue;
        const entry: SandboxEntry = {
          provider,
          workloadId: info.workloadId,
          platformKey: info.platformKey,
          sessionId: info.sessionId,
          sandboxName: info.sandboxName,
          namespace: info.namespace,
          userId: info.userId,
        };
        if (await shouldSkipExpiredRetry(deps, sessionId, "kv", entry)) continue;
        const targetKey = sandboxRegistryKey(sessionId, entry);
        if (!targets.has(targetKey)) targets.set(targetKey, { sessionId, entry });
      } catch { /* malformed — skip */ }
    }
  } catch (err) {
    logger.warn({ err }, "keepalive.kv_scan_failed");
  }

  return targets;
}

/**
 * Periodically exec a no-op inside every active sandbox to refresh the
 * SaFE Workload Manager's lastActivity timestamp, preventing idle GC.
 */
/**
 * One sweep, exported so its decisions can be tested without an interval.
 *
 * The branch that matters most is the idle-handle expiry: it deletes the only
 * record of a live workload, and the `local wins` short-circuit that used to
 * protect it is gone.
 */
export async function runKeepaliveTickForTest(deps: KeepaliveDeps): Promise<void> {
  return tick(deps);
}

async function tick(deps: KeepaliveDeps): Promise<void> {
  const targets = await collectTargets(deps);

  // Reap stale failCounts for sessions no longer tracked.
  for (const key of failCounts.keys()) {
    if (!targets.has(key)) failCounts.delete(key);
  }

  if (!targets.size) return;

  const localCount = localRegistry.size;
  const kvOnlyCount = targets.size - localCount;
  logger.info(
    { total: targets.size, local: localCount, kvOnly: kvOnlyCount,
      sessions: [...new Set([...targets.values()].map((target) => target.sessionId))] },
    "keepalive.tick_scan",
  );

  await Promise.all([...targets.entries()].map(async ([targetKey, target]) => {
    const { sessionId, entry } = target;
    const isAgent = entry.provider === "agent-sandbox";
    if (isAgent ? !entry.sessionId : (!entry.workloadId || !entry.platformKey)) return;

    try {
      if (isAgent) {
        // agent-sandbox: GET /sessions/{id} refreshes lastActivity (design §16.6),
        // preventing the sandbox's idle GC from reaping an active session.
        await getAgentSandboxProvider().get({
          provider: "agent-sandbox",
          id: entry.sessionId!,
          sandboxName: entry.sandboxName ?? "",
          namespace: entry.namespace ?? "",
          handsBaseUrl: "",
          userId: entry.userId,
        });
      } else {
        // safe-workload: exec a no-op to refresh SaFE Workload Manager lastActivity.
        await getSafeWorkloadProvider().exec({
          provider: "safe-workload",
          id: entry.workloadId!,
          sandboxName: entry.workloadId!,
          namespace: entry.namespace ?? "",
          handsBaseUrl: "",
          platformKey: entry.platformKey!,
        }, "date -Iseconds > /tmp/keepalive_ts", "15s");
      }
      failCounts.delete(targetKey);
      // Refresh KV TTL so the entry survives across Brain restarts.
      const kvKey = `hands.${sessionId}`;
      const existing = await deps.kv.get(kvKey).catch(() => null);
      if (existing) {
        try {
          const recorded = JSON.parse(sc.decode(existing.value)) as HandsKvEntry;
          if (sameRegisteredSandbox(entry, recorded)) {
            await deps.kv.update(kvKey, existing.value, existing.revision);
          }
        } catch (err) {
          logger.warn({ err, sessionId }, "keepalive.kv_refresh_failed");
        }
      }
      logger.info({ sessionId, provider: entry.provider ?? "safe-workload", workloadId: entry.workloadId }, "keepalive.ping");
    } catch (err: any) {
      const fails = (failCounts.get(targetKey) || 0) + 1;
      failCounts.set(targetKey, fails);
      logger.warn(
        { err: err?.message || String(err), sessionId, workloadId: entry.workloadId, fails },
        "keepalive.ping_failed",
      );
      // Auto-eviction is opt-in: only when FAIL_LIMIT > 0. When disabled (<=0)
      // we keep the sandbox registered and keep pinging it forever — never
      // abort the task, never destroy the sandbox on keepalive failures, so a
      // transient control-plane outage cannot tear down a healthy long-running
      // sandbox. Dead sandboxes are still reclaimed by the control-plane idle-GC.
      //
      // In-flight rebuild and ensureHands reuse now probe exec before destroy.
      // This ticker does not: FAIL_LIMIT is the operator opting in to "enough
      // missed pings means the pod is gone". Leave it at 0 unless that is the
      // policy you want.
      if (SANDBOX_KEEPALIVE_FAIL_LIMIT > 0 && fails >= SANDBOX_KEEPALIVE_FAIL_LIMIT) {
        // Session-level abort would cancel healthy DAG siblings, so eviction
        // stops this exact sandbox instead. Note what that does not do: a loop
        // already parked in an MCP call unblocks only if stopping the workload
        // breaks its connection, and the case that brought us here -- a pod
        // that stopped answering pings -- is the one where it may not. Nothing
        // has replaced the abort for that path yet.
        await destroyHands(sessionId, entry).catch((err2) =>
          logger.warn({ err: err2, sessionId }, "keepalive.destroy_failed"),
        );
        failCounts.delete(targetKey);
        localRegistry.delete(targetKey);
        logger.error(
          { sessionId, workloadId: entry.workloadId, fails },
          "keepalive.sandbox_evicted",
        );
      }
    }
  }));
}

/** Start the periodic keepalive. Idempotent. */
export function startSandboxKeepalive(deps: KeepaliveDeps): void {
  if (SANDBOX_KEEPALIVE_INTERVAL_SEC <= 0) {
    logger.info("keepalive.disabled (SANDBOX_KEEPALIVE_INTERVAL_SEC <= 0)");
    return;
  }
  if (timer) return;
  logger.info(
    {
      intervalSec: SANDBOX_KEEPALIVE_INTERVAL_SEC,
      failLimit: SANDBOX_KEEPALIVE_FAIL_LIMIT,
    },
    "keepalive.start",
  );
  tick(deps).catch((err) => logger.warn({ err }, "keepalive.tick_unhandled"));
  timer = setInterval(() => {
    tick(deps).catch((err) => logger.warn({ err }, "keepalive.tick_unhandled"));
  }, SANDBOX_KEEPALIVE_INTERVAL_SEC * 1000);
  timer.unref?.();
}

/** Stop the periodic keepalive. */
export function stopSandboxKeepalive(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  failCounts.clear();
  localRegistry.clear();
  logger.info("keepalive.stop");
}
