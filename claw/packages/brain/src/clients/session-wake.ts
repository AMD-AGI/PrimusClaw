// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import pino from "pino";

import { AUTH_INTERNAL_TOKEN } from "../config.js";
import { apiBase } from "./run-claim.js";

const logger = pino({ name: "session-wake-client" });

const WAKE_TIMEOUT_MS = 10_000;

/**
 * Ask the API for a turn on a session whose sandbox finished background work while no turn ran
 * (`/v1/internal/sessions/:id/wake`). `key` names that finish, so a repeat leaves one turn. Best effort: a wake
 * that cannot be delivered is logged, and the result is still in the sandbox for the user's next message.
 */
export async function wakeSession(sessionId: string, key: string): Promise<void> {
  const base = apiBase();
  if (!base || !AUTH_INTERNAL_TOKEN) {
    logger.warn({ sessionId }, "session.wake.no_api");
    return;
  }
  try {
    const resp = await fetch(`${base}/v1/internal/sessions/${encodeURIComponent(sessionId)}/wake`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${AUTH_INTERNAL_TOKEN}` },
      body: JSON.stringify({ reason: "background_work_finished", key }),
      signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
    });
    const body = await resp.json().catch(() => ({})) as { outcome?: string; error?: string };
    logger.info({ sessionId, status: resp.status, outcome: body.outcome ?? body.error }, "session.wake.sent");
  } catch (err) {
    logger.warn({ sessionId, err: (err as Error).message }, "session.wake.failed");
  }
}
