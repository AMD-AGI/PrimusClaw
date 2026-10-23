// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `mode: "app"` on `POST /v1/sessions/:sessionId/tasks`: the Idempotency-Key
 * handling around `admitAppRun`.
 *
 * It is the mechanism `POST /v1/sessions` already has -- the same cache table,
 * the same per-key advisory lock on the bulkhead pool, the same lock-loss
 * check -- imported rather than rewritten. Two differences follow from what is
 * being created:
 *
 *  - The key is scoped to the session (the route string carries the session
 *    id), so one key names one run of one session.
 *  - The run row itself remembers the key (`claw_app_runs.idempotency_key`,
 *    unique per session), so a replay still finds the run after the 24h cache
 *    entry has expired or its write was lost. The cache is the fast path; the
 *    row is the proof.
 *
 * Only a success is cached. A refusal leaves nothing behind, and the retry
 * the caller makes with the same key is meant to run the checks again -- in
 * particular a grant that failed to issue has to be tried again, under the same
 * grant id.
 */
import type { FastifyRequest } from "fastify";
import pino from "pino";
import type { UserInfo } from "../auth/models.js";
import { connectionLost, db } from "../infra/db.js";
import { singleflightCreate, type FlightResult } from "../shared/singleflight.js";
import {
  admitAppRun, appRunRequestHash, findAppRunByIdempotencyKey, type AppRunByKey, type AppRunOutcome, type CallerAuth,
} from "../tasks/app-run.js";
import {
  acquireIdempotencyLock, extractIdempotencyKey, IDEM_BUSY_POLL_MS, IDEM_BUSY_POLL_TRIES,
  readIdempotency, releaseIdempotencyLock, saveIdempotencyBestEffort,
  type IdempotencyLock,
} from "./sessions.js";

const logger = pino({ name: "app-run-create" });
const inflightAppCreates = new Map<string, Promise<FlightResult>>();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The caller's own credentials, to be asked of SaFE on the caller's behalf. */
export function callerAuthOf(req: FastifyRequest): CallerAuth {
  const auth: CallerAuth = {};
  const authorization = req.headers.authorization;
  const apiKey = req.headers["x-api-key"];
  if (typeof authorization === "string" && authorization) auth.authorization = authorization;
  else if (typeof apiKey === "string" && apiKey) auth.authorization = `Bearer ${apiKey}`;
  if (typeof req.headers.cookie === "string" && req.headers.cookie) auth.cookie = req.headers.cookie;
  return auth;
}

const isClientGone = (req: FastifyRequest): boolean => {
  const raw = req.raw as unknown as { aborted?: boolean };
  return raw?.aborted === true || req.socket?.destroyed === true;
};

export async function createAppRun(
  req: FastifyRequest,
  sessionId: string,
  user: UserInfo,
  body: { plugin_id?: unknown; input?: unknown; resources?: unknown },
): Promise<AppRunOutcome> {
  const idemKey = extractIdempotencyKey(req);
  const run = (): Promise<AppRunOutcome> => admitAppRun({
    sessionId, user, auth: callerAuthOf(req), body, idemKey,
  });
  if (!idemKey) return await run();

  const userId = user.userId;
  const route = `POST /v1/sessions/${sessionId}/tasks`;
  let lock: IdempotencyLock | null = null;
  const requestHash = appRunRequestHash(body);
  // A replay answers with the run the key created, but only to the user who
  // created it and for the same request: another user's key, or the same key
  // reused for a different plugin, input or resources, is refused rather than
  // answered with a run that is not what was asked for.
  const replay = (row: AppRunByKey): FlightResult => {
    if (row.createdBy !== null && row.createdBy !== userId) {
      return { statusCode: 409, response: { ok: false, error: "idempotency_key_conflict", message: "this Idempotency-Key belongs to another request" } };
    }
    if (row.requestHash !== null && row.requestHash !== requestHash) {
      return { statusCode: 422, response: { ok: false, error: "idempotency_key_reused", message: "this Idempotency-Key was used with a different request body" } };
    }
    return { statusCode: 200, response: { ok: true, task_id: row.taskId } };
  };
  // A cached 200 is checked against the run row too: the cache does not carry
  // the request, the row does.
  const cached = async (hit: { statusCode: number; response: unknown }): Promise<FlightResult> => {
    if (hit.statusCode !== 200) return { statusCode: hit.statusCode, response: hit.response };
    const row = await findAppRunByIdempotencyKey(sessionId, idemKey);
    return row ? replay(row) : { statusCode: hit.statusCode, response: hit.response };
  };

  const execute = async (): Promise<FlightResult> => {
    try {
      lock = await acquireIdempotencyLock(userId, route, idemKey);
      if (!lock) {
        for (let i = 0; i < IDEM_BUSY_POLL_TRIES; i++) {
          const busy = await readIdempotency(db, userId, route, idemKey);
          if (busy) return await cached(busy);
          const row = await findAppRunByIdempotencyKey(sessionId, idemKey);
          if (row) return replay(row);
          await sleep(IDEM_BUSY_POLL_MS);
        }
        return {
          statusCode: 503,
          response: { ok: false, error: "in_progress_timeout", message: "creation is taking longer than expected; please retry" },
        };
      }
      const hit = await readIdempotency(lock.client, userId, route, idemKey);
      if (hit) return await cached(hit);
      const existing = await findAppRunByIdempotencyKey(sessionId, idemKey);
      if (existing) {
        const r = replay(existing);
        if (r.statusCode === 200) await saveIdempotencyBestEffort(lock, userId, route, idemKey, 200, r.response);
        return r;
      }
      // Nothing durable exists yet, so this is the last point at which a lost
      // lock can still be refused cleanly (the same boundary POST /v1/sessions
      // draws). The unique index on the run row catches whatever slips past.
      const lost = connectionLost(lock.client);
      if (lost) {
        logger.error({ userId, route, err: lost.message }, "app_run.idempotency_lock_lost_before_create");
        return {
          statusCode: 503,
          response: { ok: false, error: "lock_connection_lost", message: "creation lost its de-duplication lock; please retry" },
        };
      }
      let out: AppRunOutcome;
      try {
        out = await run();
      } catch (err) {
        // A concurrent request created the run between our lookup and our
        // insert (only possible if the lock was lost): the key's unique index
        // refused this one, and the run that won is the answer.
        if ((err as { code?: string })?.code === "23505") {
          const winner = await findAppRunByIdempotencyKey(sessionId, idemKey);
          if (winner) return replay(winner);
        }
        throw err;
      }
      if (out.statusCode === 200) await saveIdempotencyBestEffort(lock, userId, route, idemKey, 200, out.response);
      return out;
    } finally {
      if (lock) await releaseIdempotencyLock(lock);
    }
  };

  return await singleflightCreate(inflightAppCreates, `${userId}:${route}:${idemKey}`, execute, () => isClientGone(req)) as AppRunOutcome;
}
