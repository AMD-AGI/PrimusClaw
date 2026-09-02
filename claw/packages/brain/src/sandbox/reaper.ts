// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Hands sandbox teardown + reclamation: destroyHands (explicit stop),
 * reapPendingHands (abort-time cleanup of an in-flight create), and the
 * periodic sweeper that reclaims workloads whose Hands endpoint has gone
 * unhealthy.
 */
import { StringCodec, type KV } from "nats";
import pino from "pino";
import { parkHandsHandle } from "@claw/protocol";
import { sleep } from "@claw/utils";
import {
  BRAIN_REGISTRY_TTL_MS,
  MULTI_NODE_IDLE_RECLAIM_MS,
  MULTI_NODE_SWEEPER_INTERVAL_MS,
  SANDBOX_SWEEPER_EVICT_AFTER_FAILURES,
} from "../config.js";
import { reclaimIdleSessionClusters as realReclaimIdleSessionClusters }
  from "./multi-node/safe-provider.js";

/**
 * Indirection so a test can watch what the sweeper decides to reclaim.
 *
 * The decision is the dangerous part -- reclaiming issues a DELETE against a
 * user's cluster and nothing undoes it -- so the guards in front of it have to
 * be observable without a control plane to talk to.
 */
let reclaimClusters = realReclaimIdleSessionClusters;

export function bindClusterReclaimForTest(
  fn: (sessionId: string, apiKey: string) => Promise<number>,
): () => void {
  const prev = reclaimClusters;
  reclaimClusters = fn;
  return () => { reclaimClusters = prev; };
}

import { metrics } from "../infra/metrics.js";
import { checkHandsHealth } from "./hands-health.js";
import {
  getHandsKv,
  revokeHandsToken,
  revokeSessionHandsToken,
  sessionHasActiveRunLease,
} from "./registry.js";
import { isTombstone } from "../tasks/lock.js";
import { SandboxStopUnavailable } from "./errors.js";
import { getAgentSandboxProvider, getSafeWorkloadProvider } from "./factory.js";
import { unregisterSandbox } from "./keepalive.js";
import {
  instanceFromEntry,
  parseHandsProbeValue,
  sameHandsSandbox,
  type HandsProbeEntry,
} from "./container-probe.js";

const logger = pino({ name: "sandbox-reaper" });
const sc = StringCodec();

/**
 * Read the session's SaFE platform key out of its Hands KV entry.
 *
 * Session cleanup has no request to take the key from, and every SaFE API call
 * needs one. Callers must read it BEFORE destroyHands, which drops the entry.
 *
 * @returns The key, or "" when the session has no usable entry.
 */
export async function readSessionPlatformKey(sessionId: string): Promise<string> {
  try {
    const entry = await getHandsKv().get(`hands.${sessionId}`);
    if (!entry) return "";
    return String(JSON.parse(sc.decode(entry.value)).platformKey ?? "");
  } catch {
    return "";
  }
}

interface RecordedHandsEntry {
  state: "valid" | "missing" | "unknown";
  identity?: HandsProbeEntry;
  revision?: number;
}

/**
 * Read the session entry without folding an unavailable/corrupt value into
 * "missing". Teardown is destructive, so only a parsed, addressable identity
 * is valid evidence about what the session key owns.
 */
async function readHandsEntry(sessionId: string): Promise<RecordedHandsEntry> {
  try {
    const entry = await getHandsKv().get(`hands.${sessionId}`);
    // A deleted key reads back as an entry with an empty value, and letting it
    // reach the parser turns "gone" into "unreadable". The two are not
    // interchangeable here: `missing` lets teardown finish, while `unknown`
    // falls past both branches at the end of destroyHands and throws "hands KV
    // unavailable after confirmed sandbox stop" -- so a second teardown, or a
    // sweeper, deleting this key first would fail a user request over a
    // workload that is already stopped.
    if (!entry || isTombstone(entry)) return { state: "missing" };
    const identity = parseHandsProbeValue(sc.decode(entry.value));
    if (!instanceFromEntry(sessionId, identity)) return { state: "unknown" };
    return { state: "valid", identity, revision: entry.revision };
  } catch (err) {
    logger.warn({ err: String(err), sessionId }, "hands.entry_unreadable");
    return { state: "unknown" };
  }
}

/**
 * Drop this process's own references to a session's sandbox: its accepted bearer
 * token and its keepalive registration.
 *
 * Split out of destroyHands because it has to run whatever the teardown's
 * outcome, while destroyHands runs only once the resources are confirmed gone --
 * it deletes the `hands.<sid>` entry, which an unfinished teardown still needs.
 * Leaving the local state behind is worse than it sounds: a replica that keeps
 * its keepalive registration goes on exec-ing into a stopped workload every 60s,
 * which refreshes SaFE's lastActivity and suppresses the very GC that would have
 * reclaimed the pod.
 *
 * Purely in-memory and keyed only on the session id, so it does not care whether
 * the KV entry still exists.
 */
export function releaseLocalHandsState(sessionId: string): void {
  revokeSessionHandsToken(sessionId);
  unregisterSandbox(sessionId);
}

/**
 * Attempts at a stop before teardown gives up and refuses to replace.
 *
 * Refusing is right -- a workload that may still be running must not be
 * orphaned under its replacement -- but one 503 from the control plane is not
 * evidence that it is still running, and treating it as such fails a user
 * request over a blip. Three tries over about three seconds separates a control
 * plane that is briefly unhappy from one that will not stop this workload.
 */
const STOP_ATTEMPTS = 3;
const STOP_RETRY_DELAY_MS = 1_000;

/**
 * The bounds above, parameterised for the reason bootstrap's commands are: the
 * production numbers are sized for a real control plane, and a test of the
 * never-stops path should not have to wait all of them out.
 */
let stopRetry = { attempts: STOP_ATTEMPTS, delayMs: STOP_RETRY_DELAY_MS };

/** Override the stop retry bounds; returns the call that puts them back. */
export function bindSandboxStopRetry(over: Partial<typeof stopRetry>): () => void {
  const prev = stopRetry;
  stopRetry = { ...stopRetry, ...over };
  return () => { stopRetry = prev; };
}

/**
 * Stop the named sandbox, or say why the caller must not replace it.
 *
 * Returns normally in exactly two cases: the stop was confirmed, or this
 * deployment cannot issue one at all (see SandboxStopUnavailable). Everything
 * else is retried and then thrown, because the caller's next move is to build a
 * replacement over the top of it.
 */
async function stopNamedSandbox(sessionId: string, entry: HandsProbeEntry): Promise<void> {
  const inst = instanceFromEntry(sessionId, entry);
  if (!inst) return;
  const provider = inst.provider === "agent-sandbox"
    ? getAgentSandboxProvider()
    : getSafeWorkloadProvider();
  for (let attempt = 1; ; attempt++) {
    try {
      await provider.stop(inst);
      return;
    } catch (err) {
      if (err instanceof SandboxStopUnavailable) {
        // Nothing to retry and nothing an operator can do mid-request. Leave
        // the workload to the control plane's GC and let teardown finish, or
        // the session can never be rebuilt.
        logger.warn(
          { err: String(err), sessionId, provider: inst.provider },
          "hands.stop_unavailable",
        );
        return;
      }
      if (attempt >= stopRetry.attempts) {
        logger.warn(
          { err: String(err), sessionId, provider: inst.provider, attempts: attempt },
          "hands.stop_failed",
        );
        throw err;
      }
      logger.warn(
        { err: String(err), sessionId, provider: inst.provider, attempt },
        "hands.stop_retrying",
      );
      await sleep(stopRetry.delayMs);
    }
  }
}

/** Delete only the KV revision teardown inspected before its remote stop. */
export async function deleteHandsEntryIfRevision(
  kv: Pick<KV, "delete">,
  key: string,
  revision: number,
): Promise<boolean> {
  try {
    await kv.delete(key, { previousSeq: revision });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a Hands sandbox. With `known`, that sandbox is the one stopped — not
 * whichever workload last wrote `hands.<sessionId>`.
 *
 * KV cleanup is revision-conditional, while token and keepalive cleanup are
 * scoped to the target identity so a concurrent sibling remains registered.
 *
 * There is deliberately no check that the entry still sits at the revision the
 * caller read. Every destructive step here is already scoped: the stop targets
 * `known`, the token and registry cleanup target it too, and the KV delete is
 * a CAS gated on `sameHandsSandbox`. A revision check on top of that protects
 * nothing and costs a teardown -- `hands.<sessionId>` is re-put on every
 * successful keepalive ping to refresh its TTL, so a benign bump in the window
 * between reading and acting would abort a repair that was correct, and leave
 * the workload it had already confirmed dead still running.
 */
export async function destroyHands(
  sessionId: string,
  known?: HandsProbeEntry,
  knownToken?: string,
): Promise<void> {
  const kv = getHandsKv();
  const key = `hands.${sessionId}`;
  const recorded = await readHandsEntry(sessionId);
  const target = known ?? recorded.identity;
  const ownsRecorded = recorded.state === "valid"
    && !!recorded.identity
    && !!target
    && sameHandsSandbox(target, recorded.identity);

  if (!target) {
    // A genuinely absent session key has no remote sandbox to stop. An
    // unreadable/corrupt key is different: preserve all session state because
    // it may still belong to a live workload.
    if (!known && recorded.state === "missing") releaseLocalHandsState(sessionId);
    return;
  }

  try {
    await stopNamedSandbox(sessionId, target);
    metrics.onSandboxStop("ok");
  } catch (cause) {
    // Counted before the rethrow: the caller turns this into a replacement
    // decision and never reports the teardown itself, so this is the only
    // place a failed stop is visible.
    metrics.onSandboxStop("error");
    // Every caller of this is about to build a replacement, and the raw
    // provider message ("HTTP 500") does not say why that is now refused.
    // Naming the consequence is what makes the failure actionable, and what
    // stops it reading like a bug in the request the user made.
    throw new Error(
      `could not confirm the sandbox was stopped after ${stopRetry.attempts} attempts, so it `
      + `was not replaced -- a workload that is still running must not be orphaned under `
      + `a new one: ${(cause as Error)?.message ?? cause}`,
      { cause },
    );
  }

  // Scoped local cleanup: never revoke a sibling's token or remove a
  // registration that replaced this one while stop was in flight.
  revokeHandsToken(knownToken || (ownsRecorded ? recorded.identity?.token || "" : ""));
  unregisterSandbox(sessionId, target);

  if (!ownsRecorded || recorded.revision === undefined) {
    logger.warn(
      {
        sessionId,
        stoppedWorkload: target.workloadId || target.sandboxName,
        recordedWorkload: recorded.identity?.workloadId || recorded.identity?.sandboxName,
        recordedState: recorded.state,
      },
      "sandbox.destroy.left_session_entry",
    );
    return;
  }

  const deleted = await deleteHandsEntryIfRevision(kv, key, recorded.revision);
  if (deleted) return;

  // A keepalive TTL refresh changes the revision without changing ownership.
  // Retry that benign race, but never delete a replacement sibling.
  const latest = await readHandsEntry(sessionId);
  if (latest.state === "missing") return;
  if (
    latest.state === "valid"
    && latest.identity
    && latest.revision !== undefined
    && sameHandsSandbox(target, latest.identity)
  ) {
    if (await deleteHandsEntryIfRevision(kv, key, latest.revision)) return;
    // Losing twice means the key is being written faster than we can clear
    // it -- but the workload is already stopped, which is the part callers
    // build a replacement on top of. Throwing here fails a user request over
    // a stale record the bucket TTL removes on its own, so the entry is left
    // behind and said out loud instead.
    logger.warn(
      { sessionId, workloadId: target.workloadId || target.sandboxName },
      "sandbox.destroy.entry_left_after_stop",
    );
    return;
  }
  if (latest.state === "valid") {
    logger.warn({ sessionId, revision: recorded.revision }, "sandbox.destroy.kv_owner_changed");
    return;
  }
  // Unreadable is different from contended: the stop is confirmed, but we
  // cannot see whose entry this is, so clearing it might remove a sibling's.
  // Refusing keeps the caller from building over a record it cannot vouch for.
  throw new Error("hands KV unavailable after confirmed sandbox stop");
}

/**
 * Reap only PENDING Hands KV entries (B). Used by handleTask's failure path
 * so that a task aborted mid-ensureHands does not leave an orphan SaFE
 * workload behind. A READY entry means ensureHands already completed and
 * the failure happened later in the agent loop (LLM error, tool crash,
 * etc.) — in that case the sandbox is healthy and should be kept so the
 * user's next message can reuse it; this function is a no-op for READY.
 */
export async function reapPendingHands(sessionId: string): Promise<void> {
  try {
    const kv = getHandsKv();
    const entry = await kv.get(`hands.${sessionId}`);
    if (!entry) return;
    const info = JSON.parse(sc.decode(entry.value));
    if (info.status !== "pending") return;
    logger.warn({ sessionId, workloadId: info.workloadId }, "hands.reap_pending");
    await destroyHands(
      sessionId,
      info as HandsProbeEntry,
      typeof info.token === "string" ? info.token : undefined,
    );
  } catch (e) {
    logger.warn({ err: e, sessionId }, "hands.reap_pending_failed");
  }
}

const sweeperFailureCounts = new Map<string, number>();
const SWEEPER_INTERVAL_MS = 5 * 60 * 1000;
const SWEEPER_HEALTH_TIMEOUT_MS = 3_000;
// Evict threshold now comes from config (SANDBOX_SWEEPER_EVICT_AFTER_FAILURES);
// <=0 disables sweeper-driven eviction entirely.

/**
 * Periodic sweeper: scan all `hands.*` KV entries, health-check each Hands
 * endpoint, delete KV + Workload when unhealthy for too long. Complements
 * the in-task lazy revalidation for long-idle sessions.
 */
async function sweepStaleHands(): Promise<void> {
  const kv = getHandsKv();
  let scanned = 0;
  let evicted = 0;
  try {
    const iter = await kv.keys("hands.*");
    const now = new Date().toISOString();
    for await (const key of iter) {
      scanned += 1;
      const sessionId = key.slice("hands.".length);
      let info: Record<string, unknown> = {};
      try {
        const entry = await kv.get(key);
        if (!entry) continue;
        info = JSON.parse(sc.decode(entry.value));
      } catch { continue; }

      // PENDING entries are owned by an in-flight ensureHands (legitimately
      // polling a slow GPU queue, or bootstrapping hands). Policy: wait
      // indefinitely — never reap. If the creator dies, the handleTask KV
      // refresh stops and the entry naturally expires via the bucket TTL;
      // at that point the SaFE-side workload becomes SaFE's idle-killer
      // problem, not ours. Keeping the wait unbounded avoids killing long
      // legitimate waits.
      if (info.status === "pending") {
        continue;
      }

      const handsUrl = (info.handsUrl as string) || "";
      if (!handsUrl) continue;

      const health = await checkHandsHealth(handsUrl, SWEEPER_HEALTH_TIMEOUT_MS);
      if (health.ok) { sweeperFailureCounts.delete(sessionId); continue; }

      const fails = (sweeperFailureCounts.get(sessionId) ?? 0) + 1;
      sweeperFailureCounts.set(sessionId, fails);
      logger.info({ sessionId, handsUrl, fails, now, health: health.detail }, "sweeper.unhealthy");

      // Sweeper eviction is opt-in: only when the threshold is > 0. When
      // disabled (<=0) we keep health-checking and logging, but never stop the
      // workload / delete its KV entry on transient health failures. Same
      // contract as SANDBOX_KEEPALIVE_FAIL_LIMIT: MCP /health here is not a
      // destroy license unless an operator turns that on.
      if (SANDBOX_SWEEPER_EVICT_AFTER_FAILURES > 0 && fails >= SANDBOX_SWEEPER_EVICT_AFTER_FAILURES) {
        try {
          // Stop the identity whose health was checked. destroyHands performs
          // revision-CAS cleanup and leaves a newer sibling entry untouched.
          await destroyHands(
            sessionId,
            info as HandsProbeEntry,
            typeof info.token === "string" ? info.token : undefined,
          );
          sweeperFailureCounts.delete(sessionId);
          evicted += 1;
        } catch (err) {
          logger.warn({ err, sessionId }, "sweeper.stop_failed");
        }
      }
    }
    metrics.onSandboxSweeperEvict(evicted);
    logger.info({ scanned, evicted }, "sweeper.pass_complete");
  } catch (err) {
    logger.warn({ err }, "sweeper.pass_failed");
  }
}

export function startSandboxSweeper(): void {
  setInterval(() => { sweepStaleHands().catch(() => {}); }, SWEEPER_INTERVAL_MS);
  logger.info({ intervalMs: SWEEPER_INTERVAL_MS }, "sweeper.started");
}

/**
 * May this session's GPU clusters be reclaimed now?
 *
 * `keepalive === false` comes first and is never waived: it is the only signal
 * that no task is running, and it covers DAG-rooted tasks that the session-keyed
 * task lock misses.
 *
 * Past that there are two kinds of idle and only one waits. A live session
 * between messages waits out MULTI_NODE_IDLE_RECLAIM_MS, so its cluster is still
 * warm when the next message arrives. A handle parked by a session delete skips
 * it: there is no next message to keep anything warm for, so waiting only delays
 * the GPUs going back. See parkHandsHandle for the two configurations where that
 * exemption is load-bearing rather than merely faster.
 */
export function eligibleForClusterReclaim(
  info: { keepalive?: unknown; sessionDeleted?: unknown; idleSince?: unknown },
  now: number,
): boolean {
  if (info.keepalive !== false) return false;
  if (info.sessionDeleted === true) return true;
  const idleSince = typeof info.idleSince === "number" ? info.idleSince : 0;
  return idleSince > 0 && now - idleSince >= MULTI_NODE_IDLE_RECLAIM_MS;
}

/**
 * Periodic multi-node sweeper: reclaim the GPU clusters of sessions whose sandbox
 * has gone idle, and of sessions deleted without a confirmed teardown.
 * eligibleForClusterReclaim above decides which entries qualify.
 *
 * Only reaches sessions that still hold a `hands.*` entry, since the SaFE key it
 * needs to delete a workload lives there. A cluster whose entry has already
 * expired is left to the workload's own `timeout`.
 */
async function sweepIdleMultiNodeClusters(): Promise<void> {
  const kv = getHandsKv();
  let scanned = 0;
  let reclaimed = 0;
  try {
    const iter = await kv.keys("hands.*");
    for await (const key of iter) {
      const sessionId = key.slice("hands.".length);
      let info: Record<string, unknown> = {};
      try {
        const entry = await kv.get(key);
        if (!entry) continue;
        info = JSON.parse(sc.decode(entry.value));
      } catch { continue; }

      if (!eligibleForClusterReclaim(info, Date.now())) continue;
      // The entry says idle; the run lease says whether anyone is using it.
      // Those disagree more often than the entry admits: a reuse that could
      // not clear its idle markers leaves `keepalive:false` and a stale
      // `idleSince` on a sandbox a turn is actively running in, and that is
      // exactly the shape this function reads as its licence. What it does
      // next is delete the user's cluster, which no later pass can undo.
      if (await sessionHasActiveRunLease(kv, sessionId, info.runScope)) {
        logger.info({ sessionId }, "mn_sweeper.skipped_run_in_flight");
        continue;
      }
      const platformKey = String(info.platformKey ?? "");
      if (!platformKey) continue;

      scanned += 1;
      try {
        reclaimed += await reclaimClusters(sessionId, platformKey);
      } catch (err) {
        logger.warn({ err, sessionId }, "mn_sweeper.session_failed");
      }
    }
    if (scanned) logger.info({ scanned, reclaimed }, "mn_sweeper.pass_complete");
  } catch (err) {
    logger.warn({ err }, "mn_sweeper.pass_failed");
  }
}

/** Start the periodic multi-node sweeper. No-op when disabled. */
/** One sweeper pass, for tests: the interval version is fire-and-forget. */
export async function sweepIdleMultiNodeClustersForTest(): Promise<void> {
  await sweepIdleMultiNodeClusters();
}

export function startMultiNodeSweeper(): void {
  if (MULTI_NODE_IDLE_RECLAIM_MS <= 0) {
    logger.info("mn_sweeper.disabled (MULTI_NODE_IDLE_RECLAIM_MS <= 0)");
    return;
  }
  // Its own interval rather than the health sweep's: this one has to come round
  // before a parked handle's TTL runs out, and that budget is unrelated to how
  // often it is worth health-checking a sandbox.
  setInterval(() => { sweepIdleMultiNodeClusters().catch(() => {}); }, MULTI_NODE_SWEEPER_INTERVAL_MS);
  logger.info(
    {
      intervalMs: MULTI_NODE_SWEEPER_INTERVAL_MS,
      idleReclaimMs: MULTI_NODE_IDLE_RECLAIM_MS,
      entryTtlMs: BRAIN_REGISTRY_TTL_MS,
    },
    "mn_sweeper.started",
  );
}

/**
 * Hand an unfinished teardown back to the idle-reclaim path.
 *
 * When session teardown cannot confirm it removed everything, the cheapest
 * correct thing to do is leave the `hands.<sid>` handle behind, marked idle, and
 * let the nets that already exist catch it: sweepIdleMultiNodeClusters above
 * walks `hands.*` and reclaims a deleted session's clusters on its next pass,
 * without the idle window a live session would have to sit through. The pod goes
 * with it, from the other direction -- `keepalive: false` stops the ticker
 * pinging it, so the control-plane's own sandbox idle-GC stops being suppressed.
 *
 * Deliberately does not retry on conflict or error. Losing this hand-off costs
 * the sweeper's path, not the reclamation itself: the workload's own timeout
 * remains behind it.
 */
export async function parkForIdleReclaim(sessionId: string): Promise<void> {
  const { outcome, error } = await parkHandsHandle(getHandsKv(), sessionId);
  switch (outcome) {
    case "parked":
      logger.info({ sessionId }, "hands.parked_for_idle_reclaim");
      return;
    case "gone":
      // Another replica confirmed the teardown and removed the entry, which is
      // further than parking would have got.
      return;
    case "superseded":
      // Every replica runs this teardown, so all of them park and only one can
      // win the conditional write. Losing is the expected outcome and the goal is
      // still met, so this is not a failure. Reporting it as one would mean five
      // misleading warnings per incomplete teardown, burying a real KV outage
      // among them.
      logger.info({ sessionId }, "hands.park_for_idle_reclaim_superseded");
      return;
    case "failed":
      logger.warn(
        { err: (error as Error)?.message || String(error), sessionId },
        "hands.park_for_idle_reclaim_failed",
      );
      return;
  }
}

/**
 * Classify a fatal error message as sandbox-originated. Returns a stable
 * short code (sandbox_* / mn_* / rayjob_* / infera_* ) when the error comes
 * from ensureHands, multi-node cluster provisioning, workload polling, Hands
 * bootstrap, or Hands health — else null. Used to surface a dedicated
 * sandboxStatus.failed event and a user-friendly final_text.
 */
export function classifySandboxFailure(msg: string): string | null {
  if (!msg) return null;
  if (/platformKey is required/i.test(msg)) return "sandbox_auth_missing";
  if (/sandbox_image/i.test(msg) && /missing/i.test(msg)) return "sandbox_image_missing";
  if (/GPU_TEMPLATE_SPEC_PATH/i.test(msg)) return "sandbox_template_missing";
  if (/Create Hands failed: HTTP/i.test(msg)) return "sandbox_create_failed";
  if (/Hands workload .* entered terminal phase/i.test(msg)) return "sandbox_workload_terminal";
  if (/Hands health check failed/i.test(msg)) return "sandbox_health_failed";
  if (/bootstrap\.(mkdir_workspace|install_nodejs|start_hands)/i.test(msg)) return "sandbox_bootstrap_failed";
  if (/multi-node workload create failed/i.test(msg)) return "mn_cluster_create_failed";
  if (/multi-node workload .* entered terminal phase/i.test(msg)) return "mn_cluster_terminal";
  if (/multi-node workload .* not ready within/i.test(msg)) return "mn_cluster_timeout";
  if (/RayJob create failed/i.test(msg)) return "rayjob_create_failed";
  if (/multi-node (request )?requires/i.test(msg)) return "rayjob_config_invalid";
  if (/model is required/i.test(msg) || /multi-node infera request requires/i.test(msg)) {
    return "infera_model_missing";
  }
  return null;
}
