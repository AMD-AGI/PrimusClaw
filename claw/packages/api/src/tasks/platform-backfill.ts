// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Best-effort platform attribution for terminal runs, including chat callbacks. */
import pino from "pino";
import { handsSessionKey, platformFactsFromWorkloadDetail, type PlatformFacts } from "@claw/protocol";
import { readTrustedSessionCredentials } from "../auth/session-credentials.js";
import { db } from "../infra/db.js";
import { kv, sc } from "../infra/nats.js";
import { SAFE_API_URL } from "../config.js";
import { parseSandboxHandle, type SandboxHandle } from "./sandbox-handle.js";

const logger = pino({ name: "platform-backfill" });

/** One GET each, capped: this runs inside the sweeper tick. */
const FETCH_TIMEOUT_MS = 10_000;
/**
 * Bound bursts from a node loss.
 *
 * What falls past the cap is deferred, not uniformly recoverable:
 * drainPendingPlatformFacts revisits only rows left `failed` with one of its
 * sandbox/liveness reasons, inside the hour, and able to name a sandbox at all
 * -- and reapStaleTasks also closes rows as `cancelled` and with
 * `run_budget_exhausted`, which it never selects. So the cap has to be spent on
 * the rows most likely to answer -- see the ordering in backfillPlatformFacts.
 */
const MAX_PER_SWEEP = 50;
/** Concurrent reads. Small: SaFE is shared, and nothing here is urgent. */
const CONCURRENCY = 5;
/** Back off transient reads so old failures cannot monopolise every batch. */
// Claimed immediately before one bounded fetch, so this only has to outlive one
// request plus its two small database writes.
const RETRY_BASE_SEC = 60;
const RETRY_MAX_SEC = 10 * 60;

export interface SweptRow {
  task_id: string;
  session_id: string | null;
  sandbox_workload_id?: string | null;
  metadata?: Record<string, unknown> | null;
  /** The attempt the row belongs to NOW; see `metadata.sandbox_attempt`. */
  attempt_id?: string | null;
  origin?: string | null;
  created_at?: Date | string | null;
  completed_at?: Date | string | null;
}

/** Shared connection and diagnostic seam; never opens another NATS client. */
export const platformBackfillPorts = {
  // Keyed, not session-scoped: `handsSessionKey` is the single mapping from a
  // session id to its registry key -- it re-keys the ids that would otherwise
  // collide with a retained-container binding -- and a seam that accepted the
  // id would put a second copy of that mapping behind a stub, which is how the
  // hand-built `hands.${sessionId}` that used to live here survived unnoticed.
  // The one caller is readHandsEntry below.
  readHandsKey: (key: string) => kv.get(key),
  cannotRead: (fields: Record<string, unknown>) => {
    logger.warn(fields, "platform_backfill.cannot_read");
  },
};

function cannotRead(row: SweptRow, reason: string, fields: Partial<SandboxHandle> & { status?: number } = {}): void {
  platformBackfillPorts.cannotRead({ taskId: row.task_id, sessionId: row.session_id, reason, ...fields });
}

async function claimRow(row: SweptRow): Promise<SweptRow | null> {
  // A deployment with no SaFE has nothing to ask, and this module is meant to
  // be inert there. Without this line it is not inert, it is merely useless:
  // every offered row still takes the claim below -- one UPDATE that raises the
  // attempt count and defers the next retry -- and the read then declines it
  // with `missing_safe_api_url`, so the write buys nothing but a row that looks
  // like it was tried. In front of the claim rather than in either caller so
  // that the sweeper's offer and the drain are both covered by one statement.
  if (!SAFE_API_URL) return null;
  const r = await db.query(
    `UPDATE claw_tasks
        SET platform_facts_attempts = platform_facts_attempts + 1,
            platform_facts_next_retry_at = NOW() + (
              LEAST($3::int, $2::int * (1 << LEAST(platform_facts_attempts, 4)))
              * INTERVAL '1 second'
            )
      WHERE task_id = $1
        AND status IN ('completed', 'failed', 'cancelled')
        AND platform_facts_resolved_at IS NULL
        AND (platform_facts_next_retry_at IS NULL OR platform_facts_next_retry_at <= NOW())
      -- attempt_id travels with the claimed row because resolveSandbox reads
      -- THIS row, not the one the drain selected: the handle in metadata may
      -- belong to an attempt the row has since moved past.
      -- COALESCE, because this reader only ever sees SETTLED rows: settlement
      -- nulls attempt_id and moves the value to settled_attempt_id
      -- (tasks/run-claim.ts), and the drain selects status = failed. Reading the
      -- live column alone left the comparison with nothing on one side for every
      -- row it actually processes, so the guard never fired.
      RETURNING task_id, session_id, sandbox_workload_id, metadata,
                COALESCE(attempt_id, settled_attempt_id) AS attempt_id,
                origin, created_at, completed_at`,
    [row.task_id, RETRY_BASE_SEC, RETRY_MAX_SEC],
  );
  return (r.rows[0] as SweptRow | undefined) ?? null;
}

async function platformKeyForSession(sessionId: string | null): Promise<string> {
  if (!sessionId) return "";
  const r = await db.query(
    "SELECT config FROM claw_sessions WHERE session_id = $1",
    [sessionId],
  );
  if (r.rowCount === 0) return "";
  return readTrustedSessionCredentials(r.rows[0].config).platformKey;
}

interface HandsEntry {
  sandbox: SandboxHandle;
  platformKey: string;
  createdAt: unknown;
  /**
   * The attempt the KV entry names as holding it, if any.
   *
   * Carried so a handle pinned from this entry is stamped with WHOSE it was --
   * not with whoever happens to own the row now. The guard then refuses it on
   * the rows it does not belong to, which is the whole point of pinning it.
   */
  attemptId: string | null;
}

async function readHandsEntry(row: SweptRow): Promise<HandsEntry | null> {
  if (!row.session_id) return null;
  try {
    const entry = await platformBackfillPorts.readHandsKey(handsSessionKey(row.session_id));
    if (!entry || entry.operation === "DEL" || entry.operation === "PURGE") return null;
    const value: unknown = JSON.parse(sc.decode(entry.value));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      cannotRead(row, "invalid_kv_entry");
      return null;
    }
    const data = value as Record<string, unknown>;
    // Pending entries predate provider tagging. Only the legacy workload field
    // identifies them as SaFE; an unknown explicit provider is never guessed.
    const provider = data.provider === undefined ? "safe-workload" : data.provider;
    const sandbox = parseSandboxHandle({
      provider,
      handle: provider === "agent-sandbox" ? data.sessionId : data.workloadId,
    });
    if (!sandbox) {
      cannotRead(row, "invalid_kv_handle");
      return null;
    }
    const heldBy = typeof data.attemptId === "string" && data.attemptId
      ? data.attemptId
      : null;
    return {
      attemptId: heldBy,
      sandbox,
      platformKey: typeof data.platformKey === "string" ? data.platformKey : "",
      createdAt: data.createdAt,
    };
  } catch {
    // KV values contain credentials. Do not include their contents or a JSON
    // parser's error excerpt in diagnostics.
    cannotRead(row, "kv_read_failed");
    return null;
  }
}

function timestamp(value: unknown): number {
  return value instanceof Date ? value.getTime()
    : typeof value === "string" ? Date.parse(value) : NaN;
}

async function rememberFallback(
  row: SweptRow, sandbox: SandboxHandle, heldBy: string | null,
): Promise<boolean> {
  // Pin the observed identity so a later retry cannot follow the session into
  // its next sandbox. A concurrent ownership report wins instead of being
  // overwritten with the KV snapshot.
  const r = await db.query(
    `UPDATE claw_tasks
        -- The handle and the attempt it belonged to, together. Pinning one
        -- without the other leaves the row's own guard nothing to compare, so
        -- the shape this writer produced made the check it feeds permanently
        -- permissive for exactly the rows it wrote.
        SET metadata = COALESCE(metadata, '{}'::jsonb)
                       || jsonb_build_object('sandbox', $2::jsonb)
                       || CASE WHEN $4::text IS NULL THEN '{}'::jsonb
                               ELSE jsonb_build_object('sandbox_attempt', $4::text) END,
            sandbox_workload_id = $3
      WHERE task_id = $1
        AND (metadata->'sandbox' IS NULL OR metadata->'sandbox' = 'null'::jsonb)
        AND NULLIF(sandbox_workload_id, '') IS NULL
        AND platform_facts_resolved_at IS NULL
      RETURNING task_id`,
    [row.task_id, JSON.stringify(sandbox),
     sandbox.provider === "safe-workload" ? sandbox.handle : null, heldBy],
  );
  if (!r.rowCount) cannotRead(row, "sandbox_ownership_changed");
  return Boolean(r.rowCount);
}

interface ResolvedSandbox {
  sandbox: SandboxHandle;
  hands: HandsEntry | null;
}

async function resolveSandbox(row: SweptRow): Promise<ResolvedSandbox | null> {
  // Whose sandbox the recorded handle is. A row outlives its attempts -- a
  // redelivery takes the same row over -- and the handle the previous one
  // recorded stays on it, so asking SaFE about that workload attributes its
  // ending to the attempt that replaced it. Measured: attempt A's Preempted,
  // node and exit code 137 written onto B's `worker_lost` row. Brain refuses
  // the same adoption on the KV side by comparing the attempt the entry names.
  //
  // Only when both are known. A handle recorded before this field existed
  // carries no attempt and is used as before -- the rollout window, and not a
  // licence: the alternative is refusing every handle the build being replaced
  // wrote.
  const handleAttempt = row.metadata?.sandbox_attempt;
  if (typeof handleAttempt === "string" && handleAttempt
      && typeof row.attempt_id === "string" && row.attempt_id
      && handleAttempt !== row.attempt_id) {
    cannotRead(row, "handle_from_another_attempt");
    return null;
  }
  const recorded = row.metadata?.sandbox;
  let sandbox = recorded == null
    ? parseSandboxHandle({ provider: "safe-workload", handle: row.sandbox_workload_id })
    : parseSandboxHandle(recorded);
  if (recorded != null && !sandbox) {
    cannotRead(row, "invalid_recorded_handle");
    return null;
  }
  let hands: HandsEntry | null = null;
  if (!sandbox) {
    // DAG nodes may share a session concurrently, so its latest sandbox cannot
    // establish a particular node's ownership.
    if (row.origin !== "chat") {
      cannotRead(row, "kv_handle_run_unattributed");
      return null;
    }
    hands = await readHandsEntry(row);
    if (!hands) {
      cannotRead(row, "missing_sandbox_handle");
      return null;
    }
    // A session outlives its runs. Refuse both an older sandbox this turn may
    // never have used and a replacement created after it ended. Reuse needs
    // the run's own lease report to establish ownership.
    const createdAt = timestamp(hands.createdAt);
    const runCreatedAt = timestamp(row.created_at);
    const completedAt = timestamp(row.completed_at);
    if (!Number.isFinite(createdAt) || !Number.isFinite(runCreatedAt) || !Number.isFinite(completedAt)
      || createdAt < runCreatedAt || createdAt > completedAt) {
      cannotRead(row, "kv_handle_outside_run", hands.sandbox);
      return null;
    }
    // Whose workload this is, asked of the KV entry -- the only side that knows
    // on this branch, because the row has no handle recorded to carry a stamp.
    //
    // The guard at the top of this function cannot answer here: it compares
    // `metadata.sandbox_attempt`, which exists only once a handle has been
    // recorded ON the row. A chat row with no handle takes this branch, and its
    // only other test is the createdAt window -- which another attempt's
    // workload satisfies by construction, since it was created during this
    // row's own lifetime. So the adoption that writes the facts was the one
    // adoption with nothing checking it.
    //
    // Pinning it is not the check. `readAndStore` runs `readSafeWorkload` and
    // `storePlatformRead` in the same pass, and that stamps
    // `platform_facts_resolved_at`, after which the drain never selects the row
    // again -- so a pin written here is read back only on the retry of a FAILED
    // read. The pass that actually records an ending has to refuse the handle
    // itself.
    if (typeof hands.attemptId === "string" && hands.attemptId
        && typeof row.attempt_id === "string" && row.attempt_id
        && hands.attemptId !== row.attempt_id) {
      cannotRead(row, "kv_handle_from_another_attempt", hands.sandbox);
      return null;
    }
    sandbox = hands.sandbox;
    if (!await rememberFallback(row, sandbox, hands?.attemptId ?? null)) return null;
  }
  return { sandbox, hands };
}

async function platformKeyForSandbox(row: SweptRow, { sandbox, hands }: ResolvedSandbox): Promise<string> {
  let apiKey = await platformKeyForSession(row.session_id).catch(() => {
    cannotRead(row, "session_credentials_read_failed", sandbox);
    return "";
  });
  if (!apiKey) {
    // Only Brain's KV entry for this exact identity may supply a missing key.
    // A newer sandbox's credentials must never be paired with an older handle.
    hands ??= await readHandsEntry(row);
    if (hands?.sandbox.provider === sandbox.provider && hands.sandbox.handle === sandbox.handle) {
      apiKey = hands.platformKey;
    } else if (hands) {
      cannotRead(row, "kv_handle_mismatch", sandbox);
    }
  }
  if (!apiKey) {
    cannotRead(row, "missing_platform_key", sandbox);
  }
  return apiKey;
}

type PlatformRead = { kind: "absent" } | { kind: "facts"; facts: PlatformFacts };

async function readSafeWorkload(row: SweptRow, resolved: ResolvedSandbox): Promise<PlatformRead | null> {
  const { sandbox } = resolved;
  if (!SAFE_API_URL) {
    cannotRead(row, "missing_safe_api_url", sandbox);
    return null;
  }
  const apiKey = await platformKeyForSandbox(row, resolved);
  if (!apiKey) return null;
  try {
    const resp = await fetch(`${SAFE_API_URL}/api/v1/workloads/${encodeURIComponent(sandbox.handle)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (resp.status === 404 || resp.status === 410) {
      return { kind: "absent" };
    }
    if (!resp.ok) {
      cannotRead(row, "platform_http_error", { ...sandbox, status: resp.status });
      return null;
    }
    const facts = platformFactsFromWorkloadDetail(await resp.json());
    if (!facts) {
      cannotRead(row, "platform_facts_unavailable", sandbox);
      return null;
    }
    return { kind: "facts", facts };
  } catch {
    cannotRead(row, "platform_read_failed", sandbox);
    return null;
  }
}

async function storePlatformRead(row: SweptRow, sandbox: SandboxHandle, read: PlatformRead): Promise<boolean> {
  if (read.kind === "absent") {
    const resolved = await db.query(
      `UPDATE claw_tasks
          SET platform_facts_resolved_at = NOW(),
              platform_facts_next_retry_at = NULL
        WHERE task_id = $1
          AND platform_facts_resolved_at IS NULL`,
      [row.task_id],
    );
    return Boolean(resolved.rowCount);
  }
  const { facts } = read;
  // COALESCE preserves a late Brain callback that reached the row between the
  // sweeper's terminal update and this read. The explicit resolved stamp is
  // separate from content: an empty pod message is still a successful read.
  const r = await db.query(
    `UPDATE claw_tasks
        SET platform_message         = COALESCE(platform_message, $2),
            platform_node            = COALESCE(NULLIF(platform_node, ''), $3),
            platform_container_reason= COALESCE(NULLIF(platform_container_reason, ''), $4),
            platform_exit_code       = COALESCE(platform_exit_code, $5),
            platform_facts_resolved_at = NOW(),
            platform_facts_next_retry_at = NULL
      WHERE task_id = $1
        AND platform_facts_resolved_at IS NULL`,
    [row.task_id, facts.message, facts.node || null,
      facts.containerReason || null, facts.exitCode],
  );
  if (r.rowCount) {
    logger.info(
      { taskId: row.task_id, ...sandbox, node: facts.node, reason: facts.containerReason },
      "platform_backfill.recorded",
    );
  }
  return Boolean(r.rowCount);
}

async function readAndStore(row: SweptRow): Promise<boolean> {
  const resolved = await resolveSandbox(row);
  if (!resolved) return false;
  if (resolved.sandbox.provider === "agent-sandbox") {
    // The router's session/recovery/audit endpoints have no pod termination
    // facts. Keep this unresolved rather than recording a successful empty read.
    cannotRead(row, "termination_facts_unavailable", resolved.sandbox);
    return false;
  }
  const read = await readSafeWorkload(row, resolved);
  return read ? storePlatformRead(row, resolved.sandbox, read) : false;
}

/** The row names its own sandbox, so no KV entry has to be found for it. */
function carriesSandboxIdentity(row: SweptRow): boolean {
  return Boolean(row.sandbox_workload_id) || row.metadata?.sandbox != null;
}

/**
 * Record what the platform says about each offered terminal run.
 *
 * Returns how many rows reached a conclusive answer. Never throws: a caller is a sweeper arm
 * that has already closed these rows, and the close must stand whatever SaFE
 * does.
 */
export async function backfillPlatformFacts(rows: SweptRow[]): Promise<number> {
  // Rows that already carry a sandbox identity take the cap first.
  //
  // Ordering, not the `rows.filter((r) => r.sandbox_workload_id)` that used to
  // stand here. That filter predates the KV fallback: a chat row with no
  // recorded handle is now attributable from Brain's registry entry, and
  // drainPendingPlatformFacts deliberately selects exactly those rows, so
  // dropping them here again would hand them straight back unclaimed on every
  // tick -- holding the drain's LIMIT open forever and never resolving.
  //
  // Position must still not be what decides who gets the reads. A handle-less
  // row spends the same claim -- one UPDATE that raises the attempt count and
  // defers the next retry by up to RETRY_MAX_SEC -- on a KV read that may find
  // nothing, or on a non-chat row that resolveSandbox refuses outright; a row
  // holding its own handle is the read that is certain to be possible. With the
  // batch taken in array order a reap could spend all fifty on the first kind
  // and drop the second kind past the cap, where, per MAX_PER_SWEEP, nothing
  // necessarily comes back for it. Deferring costs a handle-less row nothing in
  // return: unclaimed, it keeps its NULL retry stamp, so the drain still sees it
  // in the fresh lane rather than a backed-off one.
  const candidates = rows.filter(carriesSandboxIdentity)
    .concat(rows.filter((row) => !carriesSandboxIdentity(row)))
    .slice(0, MAX_PER_SWEEP);
  if (candidates.length === 0) return 0;
  if (rows.length > MAX_PER_SWEEP) {
    logger.warn(
      { swept: rows.length, asked: MAX_PER_SWEEP, deferred: rows.length - MAX_PER_SWEEP },
      "platform_backfill.capped",
    );
  }
  let resolved = 0;
  const queue = [...candidates];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const candidate = queue.shift();
      if (!candidate) return;
      const row = await claimRow(candidate).catch(() => {
        cannotRead(candidate, "claim_failed");
        return null;
      });
      if (!row) continue;
      const ok = await readAndStore(row).catch(() => {
        cannotRead(candidate, "backfill_failed");
        return false;
      });
      if (ok) resolved++;
    }
  });
  await Promise.all(workers);
  return resolved;
}

/**
 * Retry liveness losses and sandbox failures, including consumer-closed chat
 * rows. Cleanup may already have removed their KV handle or platform detail;
 * this bounded fallback cannot reconstruct evidence that no longer exists.
 *
 * Rows that could never name a sandbox are not retried at all -- see the
 * eligibility clause below, which is what keeps the per-tick LIMIT for the rows
 * a read can actually answer for.
 */
export async function drainPendingPlatformFacts(): Promise<number> {
  const r = await db.query(
    `WITH eligible AS (
       SELECT task_id, session_id, sandbox_workload_id, metadata,
              COALESCE(attempt_id, settled_attempt_id) AS attempt_id,
              platform_facts_next_retry_at IS NOT NULL AS retried,
              -- carriesSandboxIdentity, asked in SQL so that it orders the
              -- rows the LIMIT keeps rather than the ones it already dropped.
              -- The JavaScript copy runs after the truncation and so could only
              -- ever reorder a batch that was already chosen without it.
              (NULLIF(sandbox_workload_id, '') IS NOT NULL
               OR (metadata->'sandbox' IS NOT NULL
                   AND metadata->'sandbox' <> 'null'::jsonb)) AS carries_identity,
              ROW_NUMBER() OVER (
                PARTITION BY (platform_facts_next_retry_at IS NOT NULL)
                ORDER BY platform_facts_next_retry_at ASC NULLS LAST,
                         completed_at ASC, task_id ASC
              ) AS lane_position
         FROM claw_tasks
        WHERE status = 'failed'
          AND failure_reason IN (
            'brain_timeout', 'worker_lost',
            'sandbox_workload_terminal', 'sandbox_pending_timeout', 'sandbox_timed_out',
            'sandbox_exited_before_ready', 'sandbox_gone', 'sandbox_status_unreadable',
            'sandbox_health_failed', 'sandbox_bootstrap_failed'
          )
          AND platform_facts_resolved_at IS NULL
          -- A row that names no sandbox and did not come from chat can never
          -- be attributed: resolveSandbox refuses it outright, because a
          -- session's latest sandbox cannot establish a particular DAG node's
          -- ownership -- and the row is terminal, so no writer can give it a
          -- handle later either. Selected anyway it is not merely a wasted
          -- read: it costs a claim UPDATE and a diagnostic line every time its
          -- backoff expires, and it holds one of the LIMIT slots below while
          -- doing so. One batch of DAG nodes that timed out before any worker
          -- claimed them is enough to take all of them. Measured over an hour
          -- of sweeper ticks, 2000 such rows spent all 3000 slots and the 60
          -- rows that did carry a SaFE handle got zero reads before they aged
          -- out of the window below -- where nothing revisits them.
          --
          -- Chat rows stay in whether or not they name a handle: theirs is the
          -- one the KV fallback can still recover, and dropping them is what
          -- the old sandbox_workload_id IS NOT NULL filter this replaces got
          -- wrong. It has to be asked here, in SQL, and not of the offered row:
          -- the rows the sweeper hands to backfillPlatformFacts do not all
          -- carry origin, so a JavaScript test would read a missing field as
          -- "not chat" and drop exactly the rows the drain exists for. (No
          -- backticks anywhere above: this statement is a template literal.)
          AND (
            NULLIF(sandbox_workload_id, '') IS NOT NULL
            OR (metadata->'sandbox' IS NOT NULL AND metadata->'sandbox' <> 'null'::jsonb)
            OR origin = 'chat'
          )
          AND (platform_facts_next_retry_at IS NULL OR platform_facts_next_retry_at <= NOW())
          AND completed_at > NOW() - INTERVAL '1 hour'
     )
     -- metadata and attempt_id travel with the row because the reader needs
     -- both: the handle may live only in metadata (an agent-sandbox one leaves
     -- the column null), and the attempt says whether that handle is still this
     -- row's. Projecting less meant carriesSandboxIdentity read undefined for
     -- metadata-only rows and sorted them behind handle-less ones.
     SELECT task_id, session_id, sandbox_workload_id, metadata, attempt_id
       FROM eligible
      -- Identity first, and before the lanes rather than inside them: the
      -- starvation this answers is not two rows competing for one position, it
      -- is a mass of handle-less rows holding every low position in both lanes.
      -- Chat rows that name no handle stay eligible -- the KV fallback is the
      -- one thing that can still attribute them -- but a row whose handle is
      -- already on the row is a read that can answer, while theirs depends on a
      -- registry entry that may have been swept; certainty takes the cap first.
      -- Measured with the production retry SQL over an hour of ticks: 2000
      -- handle-less chat rows spent 3000 claims and the 60 rows carrying a
      -- handle got zero reads before they aged out of the window above.
      ORDER BY carries_identity DESC, lane_position ASC, retried ASC
      LIMIT $1`,
    [MAX_PER_SWEEP],
  );
  if (!r.rowCount) return 0;
  return await backfillPlatformFacts(r.rows as SweptRow[]);
}
