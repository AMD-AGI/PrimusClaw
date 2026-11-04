// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session woken because background work in its sandbox finished while no turn was running.
 *
 * "Run the tests in the background and tell me when they pass" ends the turn that started them, and nothing
 * else ever looked again: the result sat in the sandbox until the user asked. Brain sees the work end (its
 * keepalive sweep watches an idle sandbox for exactly that) and asks for a turn here; the turn is a server
 * message on the session's queue, run by the same drain as every queued message (`queueServerMessage`,
 * `drainSessionIfIdle`), so a session that is busy by then simply runs it next.
 */
import pino from "pino";
import { db } from "../infra/db.js";
import { drainSessionIfIdle, queueServerMessage } from "../assistant/messages.js";

const logger = pino({ name: "session-wake" });

export const BACKGROUND_WORK_FINISHED_NOTICE =
  "[system-notice]: Background work you started in this session's sandbox has finished while no turn was running. "
  + "Check its result (bash_output for a background shell, or what it wrote) and tell the user what came of it, briefly. "
  + "If it was nothing you started or there is nothing worth reporting, say so in one line.";

export type WakeOutcome = "queued" | "duplicate" | "not_found" | "acting" | "no_credentials";

export const sessionWakePorts = {
  async owner(sessionId: string): Promise<{ userId: string; acting: boolean } | null> {
    const row = (await db.query(
      "SELECT user_id, (config->'acting_as') IS NOT NULL AS acting FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0] as { user_id: string; acting: boolean } | undefined;
    return row ? { userId: row.user_id, acting: row.acting === true } : null;
  },
  queue: queueServerMessage,
  drain: drainSessionIfIdle,
};

/**
 * Queue the wake and run it if the session is free. `key` names the finish Brain saw, so a sweep that reports the
 * same one again (another replica, a retried call) leaves one turn. A session that acts as a user is not woken: a
 * turn there is the person's say, and the key it would run under holds someone else's account.
 */
export async function wakeSession(sessionId: string, key: string): Promise<WakeOutcome> {
  const owner = await sessionWakePorts.owner(sessionId);
  if (!owner) return "not_found";
  if (owner.acting) return "acting";
  const queued = await sessionWakePorts.queue(db, {
    sessionId, userId: owner.userId, content: BACKGROUND_WORK_FINISHED_NOTICE, dedupeKey: `bg-done:${key}`,
  });
  if (!queued.ok) return queued.error === "session_not_found" ? "not_found" : "no_credentials";
  if (queued.deduplicated) return "duplicate";
  const drained = await sessionWakePorts.drain(sessionId, owner.userId);
  logger.info({ sessionId, drained }, "session.wake.queued");
  return "queued";
}
