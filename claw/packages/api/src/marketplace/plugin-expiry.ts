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
 * A plugin something still uses (an unfinished task, a live app run, a queued
 * message, a live DAG template) is left alone and expires on a later pass once
 * that is over. "Still uses" includes a write in flight: every transaction that
 * writes such a reference holds the plugin row `FOR SHARE` until it commits
 * (`holdPluginForAdmission` for runs, `holdPluginReference` for queued messages
 * and DAG templates), the sweep takes its candidates `FOR UPDATE SKIP LOCKED`, and only
 * then, in a later statement that sees everything committed before the lock,
 * checks for references. So an admission either commits its task first (and
 * the sweep sees it) or waits for the sweep and finds the plugin gone. Every
 * API replica may run the sweep; the row locks make each plugin expire once.
 */
import type { PoolClient } from "pg";
import pino from "pino";
import { PLUGIN_EXPIRY_SWEEP_INTERVAL_MIN, PLUGIN_TTL_MAX_DAYS } from "../config.js";
import { BadRequestError } from "../shared/errors.js";

const logger = pino({ name: "plugin-expiry" });

/** The CHECK constraint that keeps a public plugin permanent. */
export const TEMPORARY_NOT_PUBLIC_CONSTRAINT = "plugins_temporary_not_public";

/**
 * How long after `expires_at` the sweep waits, so an owner who sees a plugin
 * expire has a moment to extend it. Correctness does not rest on it: the row
 * locks above do that.
 */
export const PLUGIN_EXPIRY_GRACE_SEC = 600;

/** The condition an admission adds to its plugin read: not past its expiry. */
export const PLUGIN_NOT_EXPIRED_SQL = "(expires_at IS NULL OR expires_at > NOW())";

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

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
    // ISO 8601 with a time and an offset only: Date.parse also takes forms
    // whose meaning depends on the server's locale and time zone.
    const ms = typeof raw === "string" && ISO_INSTANT_RE.test(raw) ? Date.parse(raw) : NaN;
    if (!Number.isFinite(ms)) throw new BadRequestError("expires_at must be an ISO 8601 timestamp");
    at = new Date(ms);
  } else {
    return undefined;
  }
  const delta = at.getTime() - now.getTime();
  if (!Number.isFinite(delta) || delta < PLUGIN_TTL_MIN_SECONDS * 1000 || delta > maxMs) {
    throw new BadRequestError(
      `a plugin may expire from ${PLUGIN_TTL_MIN_SECONDS} seconds to ${maxDays} days from now`,
    );
  }
  return at;
}

/** A write named a plugin that is gone by the time it was held; routes answer 404 plugin_not_found. */
export class PluginGoneError extends Error {
  constructor() {
    super("plugin_not_found");
  }
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
 * Hold a plugin for the rest of an admission transaction, or false when it is
 * gone (deleted, or past its expiry). Every admission that writes a reference
 * to a plugin (a task, an app run) calls this inside its transaction before
 * the write; see the module comment for why.
 */
export async function holdPluginForAdmission(client: PoolClient, pluginId: number | string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM plugins WHERE id = $1 AND deleted_at IS NULL AND ${PLUGIN_NOT_EXPIRED_SQL} FOR SHARE`,
    [pluginId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Hold a plugin row for the rest of a transaction that writes a reference to
 * it without admitting a run (a queued message, a DAG template). False when
 * the plugin is gone (deleted, or past its expiry), and the caller refuses
 * the write rather than store a reference to it. True for a null id.
 */
export async function holdPluginReference(
  q: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  pluginId: number | string | null | undefined,
): Promise<boolean> {
  if (pluginId === null || pluginId === undefined) return true;
  // Read after the lock is granted: a sweep that held the row first has
  // committed by then, and a plugin it deleted reads as gone here.
  const r = await q.query(
    `SELECT 1 FROM plugins WHERE id = $1 AND deleted_at IS NULL AND ${PLUGIN_NOT_EXPIRED_SQL} FOR SHARE`,
    [pluginId],
  ) as { rows?: unknown[] };
  return (r.rows?.length ?? 0) > 0;
}

/** The expired private plugins this pass may take, locked; one an admission holds is skipped. */
export const PLUGIN_EXPIRY_CANDIDATES_SQL = `
  SELECT id FROM plugins
   WHERE expires_at IS NOT NULL AND expires_at <= NOW() - INTERVAL '${PLUGIN_EXPIRY_GRACE_SEC} seconds'
     AND deleted_at IS NULL AND is_public = false
   ORDER BY id
   FOR UPDATE SKIP LOCKED`;

/**
 * Soft-delete the locked candidates nothing uses. Returns what it deleted.
 * Never touches a public plugin.
 */
export const PLUGIN_EXPIRY_SWEEP_SQL = `
  UPDATE plugins p SET deleted_at = NOW(), updated_at = NOW()
   WHERE p.id = ANY($1::bigint[])
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

export async function sweepExpiredPlugins(pool: { connect(): Promise<PoolClient> }): Promise<ExpiredPlugin[]> {
  const client = await pool.connect();
  let r: { rows: unknown[] };
  let broken = false;
  try {
    await client.query("BEGIN");
    const ids = (await client.query(PLUGIN_EXPIRY_CANDIDATES_SQL)).rows.map((x) => String((x as { id: unknown }).id));
    // A separate statement: under READ COMMITTED it sees every reference
    // committed before the candidates were locked.
    r = ids.length ? await client.query(PLUGIN_EXPIRY_SWEEP_SQL, [ids]) : { rows: [] };
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { broken = true; });
    throw err;
  } finally {
    client.release(broken);
  }
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
export function startPluginExpirySweeper(pool: { connect(): Promise<PoolClient> }): void {
  if (started) return;
  started = true;
  const periodMs = PLUGIN_EXPIRY_SWEEP_INTERVAL_MIN * 60 * 1000;
  const pass = () => {
    sweepExpiredPlugins(pool).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "plugin-expiry.sweep_failed");
    });
  };
  setTimeout(() => {
    pass();
    setInterval(pass, periodMs).unref();
  }, 60_000).unref();
  logger.info({ intervalMin: PLUGIN_EXPIRY_SWEEP_INTERVAL_MIN, maxDays: PLUGIN_TTL_MAX_DAYS }, "plugin-expiry.started");
}
