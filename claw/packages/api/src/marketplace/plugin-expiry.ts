// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Temporary plugins: a plugin written with `expires_at` (or `ttl_seconds`) is
 * soft-deleted by the sweeper once that time has passed.
 *
 * Meant for what eval and probe tooling registers for one run, which otherwise
 * stays in every listing until someone deletes it by hand. Public plugins are
 * never temporary: the database refuses the combination
 * (`plugins_temporary_not_public`), and the sweeper's statement names
 * `is_public = false` as well, so neither rule depends on the other.
 *
 * The sweep is one idempotent UPDATE, so every API replica may run it; the
 * row lock makes each plugin expire once. A plugin something still uses (an
 * unfinished task, a live app run, a queued message, a live DAG template) is
 * left alone and expires on a later pass once that is over.
 */
import pino from "pino";
import { PLUGIN_EXPIRY_SWEEP_INTERVAL_MIN, PLUGIN_TTL_MAX_DAYS } from "../config.js";
import { BadRequestError } from "../shared/errors.js";

const logger = pino({ name: "plugin-expiry" });

/** The CHECK constraint that keeps a public plugin permanent. */
export const TEMPORARY_NOT_PUBLIC_CONSTRAINT = "plugins_temporary_not_public";

/**
 * How long after `expires_at` the sweep waits. Admission refuses a plugin past
 * its `expires_at` (routes/tasks.ts, tasks/app-run.ts), so a launch that got in
 * read the plugin before then; the grace outlasts any admission, so by the
 * time the sweep looks, that launch's task row is there and keeps the plugin.
 */
export const PLUGIN_EXPIRY_GRACE_SEC = 600;

/** The condition an admission adds to its plugin read: not past its expiry. */
export const PLUGIN_NOT_EXPIRED_SQL = "(expires_at IS NULL OR expires_at > NOW())";

/** Shortest TTL a write may ask for: shorter is a mistake, not a plugin. */
export const PLUGIN_TTL_MIN_SECONDS = 60;

/**
 * The expiry a plugin write asks for.
 *
 * `undefined` when the payload names neither field (leave the row's expiry as
 * it is), `null` to clear it (the plugin becomes permanent), or the instant.
 * `ttl_seconds` counts from `now`; `expires_at` is an ISO timestamp. Either must
 * land from `PLUGIN_TTL_MIN_SECONDS` to `PLUGIN_TTL_MAX_DAYS` from now, and the
 * two together are refused. Throws BadRequestError (400 at the routes).
 */
export function requestedPluginExpiry(
  payload: Record<string, unknown>,
  now: Date = new Date(),
  maxDays: number = PLUGIN_TTL_MAX_DAYS,
): Date | null | undefined {
  const hasTtl = "ttl_seconds" in payload && payload.ttl_seconds !== undefined;
  const hasAt = "expires_at" in payload && payload.expires_at !== undefined;
  if (hasTtl && hasAt) throw new BadRequestError("give expires_at or ttl_seconds, not both");
  const maxMs = maxDays * 24 * 60 * 60 * 1000;
  let at: Date;
  if (hasTtl) {
    if (payload.ttl_seconds === null) return null;
    const ttl = payload.ttl_seconds;
    if (typeof ttl !== "number" || !Number.isSafeInteger(ttl)) throw new BadRequestError("ttl_seconds must be an integer");
    at = new Date(now.getTime() + ttl * 1000);
  } else if (hasAt) {
    if (payload.expires_at === null) return null;
    const raw = payload.expires_at;
    const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
    if (!Number.isFinite(ms)) throw new BadRequestError("expires_at must be an ISO 8601 timestamp");
    at = new Date(ms);
  } else {
    return undefined;
  }
  const delta = at.getTime() - now.getTime();
  if (delta < PLUGIN_TTL_MIN_SECONDS * 1000 || delta > maxMs) {
    throw new BadRequestError(
      `a plugin may expire from ${PLUGIN_TTL_MIN_SECONDS} seconds to ${maxDays} days from now`,
    );
  }
  return at;
}

/** Whether `err` is the database refusing a public temporary plugin. */
export function isTemporaryPublicViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === "23514" && e?.constraint === TEMPORARY_NOT_PUBLIC_CONSTRAINT;
}

/** The 400 a public temporary plugin gets, whichever check caught it. */
export function temporaryPublicError(): BadRequestError {
  return new BadRequestError("a public plugin cannot expire: clear expires_at (null) or keep the plugin private");
}

/**
 * Soft-delete every expired temporary plugin nothing uses. Returns what it
 * deleted. Never touches a public plugin.
 */
export const PLUGIN_EXPIRY_SWEEP_SQL = `
  UPDATE plugins p SET deleted_at = NOW(), updated_at = NOW()
   WHERE p.expires_at IS NOT NULL AND p.expires_at <= NOW() - INTERVAL '${PLUGIN_EXPIRY_GRACE_SEC} seconds'
     AND p.deleted_at IS NULL AND p.is_public = false
     AND NOT EXISTS (SELECT 1 FROM claw_tasks t
                      WHERE t.plugin_id = p.id AND t.status NOT IN ('completed','failed','cancelled'))
     AND NOT EXISTS (SELECT 1 FROM claw_app_runs r WHERE r.plugin_id = p.id AND r.state <> 'ended')
     AND NOT EXISTS (SELECT 1 FROM claw_pending_messages m WHERE m.plugin_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM claw_task_dags d WHERE d.plugin_id = p.id AND d.deleted_at IS NULL)
  RETURNING p.id, p.name, p.version, p.owner_user_id, p.expires_at`;

export interface ExpiredPlugin {
  id: number;
  name: string;
  version: string;
  owner_user_id: string | null;
  expires_at: Date;
}

export async function sweepExpiredPlugins(
  q: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
): Promise<ExpiredPlugin[]> {
  const r = await q.query(PLUGIN_EXPIRY_SWEEP_SQL);
  const out = (r.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    version: String(row.version ?? ""),
    owner_user_id: (row.owner_user_id as string | null) ?? null,
    expires_at: row.expires_at as Date,
  }));
  for (const p of out) logger.info(p, "plugin.expired");
  return out;
}

let started = false;

/** Start the periodic sweep (first pass 60 s after start-up). Idempotent. */
export function startPluginExpirySweeper(
  q: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
): void {
  if (started) return;
  started = true;
  const periodMs = PLUGIN_EXPIRY_SWEEP_INTERVAL_MIN * 60 * 1000;
  const pass = () => {
    sweepExpiredPlugins(q).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "plugin-expiry.sweep_failed");
    });
  };
  setTimeout(() => {
    pass();
    setInterval(pass, periodMs).unref();
  }, 60_000).unref();
  logger.info({ intervalMin: PLUGIN_EXPIRY_SWEEP_INTERVAL_MIN, maxDays: PLUGIN_TTL_MAX_DAYS }, "plugin-expiry.started");
}
