// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Best-effort platform attribution for terminal runs, including chat callbacks. */
import pino from "pino";
import { platformFactsFromWorkloadDetail, type PlatformFacts } from "@claw/protocol";
import { readTrustedSessionCredentials } from "../auth/session-credentials.js";
import { db } from "../infra/db.js";
import { kv, sc } from "../infra/nats.js";
import { SAFE_API_URL } from "../config.js";
import { parseSandboxHandle, type SandboxHandle } from "./sandbox-handle.js";

const logger = pino({ name: "platform-backfill" });

/** One GET each, capped: this runs inside the sweeper tick. */
const FETCH_TIMEOUT_MS = 10_000;
/** Bound bursts from a node loss; the drain revisits deferred rows. */
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
  origin?: string | null;
  created_at?: Date | string | null;
  completed_at?: Date | string | null;
}

/** Shared connection and diagnostic seam; never opens another NATS client. */
export const platformBackfillPorts = {
  readHandsEntry: (sessionId: string) => kv.get(`hands.${sessionId}`),
  cannotRead: (fields: Record<string, unknown>) => {
    logger.warn(fields, "platform_backfill.cannot_read");
  },
};

function cannotRead(row: SweptRow, reason: string, fields: Partial<SandboxHandle> & { status?: number } = {}): void {
  platformBackfillPorts.cannotRead({ taskId: row.task_id, sessionId: row.session_id, reason, ...fields });
}

async function claimRow(row: SweptRow): Promise<SweptRow | null> {
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
      RETURNING task_id, session_id, sandbox_workload_id, metadata, origin, created_at, completed_at`,
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
}

async function readHandsEntry(row: SweptRow): Promise<HandsEntry | null> {
  if (!row.session_id) return null;
  try {
    const entry = await platformBackfillPorts.readHandsEntry(row.session_id);
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
    return {
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

async function rememberFallback(row: SweptRow, sandbox: SandboxHandle): Promise<boolean> {
  // Pin the observed identity so a later retry cannot follow the session into
  // its next sandbox. A concurrent ownership report wins instead of being
  // overwritten with the KV snapshot.
  const r = await db.query(
    `UPDATE claw_tasks
        SET metadata = COALESCE(metadata, '{}'::jsonb)
                       || jsonb_build_object('sandbox', $2::jsonb),
            sandbox_workload_id = $3
      WHERE task_id = $1
        AND (metadata->'sandbox' IS NULL OR metadata->'sandbox' = 'null'::jsonb)
        AND NULLIF(sandbox_workload_id, '') IS NULL
        AND platform_facts_resolved_at IS NULL
      RETURNING task_id`,
    [row.task_id, JSON.stringify(sandbox), sandbox.provider === "safe-workload" ? sandbox.handle : null],
  );
  if (!r.rowCount) cannotRead(row, "sandbox_ownership_changed");
  return Boolean(r.rowCount);
}

interface ResolvedSandbox {
  sandbox: SandboxHandle;
  hands: HandsEntry | null;
}

async function resolveSandbox(row: SweptRow): Promise<ResolvedSandbox | null> {
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
    sandbox = hands.sandbox;
    if (!await rememberFallback(row, sandbox)) return null;
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

/**
 * Record what the platform says about each offered terminal run.
 *
 * Returns how many rows reached a conclusive answer. Never throws: a caller is a sweeper arm
 * that has already closed these rows, and the close must stand whatever SaFE
 * does.
 */
export async function backfillPlatformFacts(rows: SweptRow[]): Promise<number> {
  const candidates = rows.slice(0, MAX_PER_SWEEP);
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
 */
export async function drainPendingPlatformFacts(): Promise<number> {
  const r = await db.query(
    `WITH eligible AS (
       SELECT task_id, session_id, sandbox_workload_id,
              platform_facts_next_retry_at IS NOT NULL AS retried,
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
          AND (platform_facts_next_retry_at IS NULL OR platform_facts_next_retry_at <= NOW())
          AND completed_at > NOW() - INTERVAL '1 hour'
     )
     SELECT task_id, session_id, sandbox_workload_id
       FROM eligible
      ORDER BY lane_position ASC, retried ASC
      LIMIT $1`,
    [MAX_PER_SWEEP],
  );
  if (!r.rowCount) return 0;
  return await backfillPlatformFacts(r.rows as SweptRow[]);
}
