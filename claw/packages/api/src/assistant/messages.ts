// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Messages the server puts on a session by itself: the first task of a worker, an instruction forwarded to
 * it, and the report that wakes the Router.
 *
 * Each is written to the session's queue, inside the transaction of the state change it belongs to, so the
 * state and the message are both there or neither is: an accepted item is never one nobody was told to do.
 * The message carries the credentials the recipient session already holds, the same ones its owner's own
 * messages carry (`stampSessionCredentials`), because the turn it starts runs as that user.
 *
 * Running the turn is the drain, after the commit. A session that is busy drains its queue when its turn
 * ends; one that is idle is drained here; and a drain that is lost is found by the sweeper's orphan drain.
 * The dedupe key makes a replayed tool call or a redelivered event leave one row.
 */
import pino from "pino";
import { CLAW_DEPLOY_MODE, RUN_DOORBELL_DISPATCH } from "../config.js";
import { readTrustedSessionCredentials } from "../auth/session-credentials.js";
import { actingUserOf } from "../github-review/acting-as.js";
import type { AttendedProof } from "../github-review/acting-session.js";
import { loadUserEnvForSession } from "../github-review/session-tools.js";
import { db, type StatementRunner } from "../infra/db.js";
import { insertPendingMessage, submitMessagePorts } from "../sessions/submit-message.js";
import { pendingSecretColumns } from "../tasks/run-secrets.js";

const logger = pino({ name: "assistant-messages" });

export interface ServerMessage {
  sessionId: string;
  /** The session's owner, and so the user the turn runs as. */
  userId: string;
  content: string;
  /** Names this message for a retry: a second one with the same key into the same session is not queued. */
  dedupeKey?: string;
  /**
   * The person's say, for a session that acts as a user (`config.acting_as`): only the request that created it can give it
   * (`checkSessionCreate`). Without it such a session is refused, as every route refuses a turn in it to a key a sandbox holds
   * (`github-review/acting-turns.ts`): the server queuing a message is a way to start a turn too.
   */
  attended?: AttendedProof;
}

export type QueuedServerMessage =
  | { ok: true; pendingId: number | null; deduplicated: boolean }
  /** The session holds no credentials of its owner to run a turn with (it never received a message from them). */
  | { ok: false; error: "session_not_found" | "no_credentials" | "acting_session_unattended" };

export async function queueServerMessage(q: StatementRunner, m: ServerMessage): Promise<QueuedServerMessage> {
  const session = (await q.query(
    "SELECT config FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
    [m.sessionId],
  )).rows[0] as { config: unknown } | undefined;
  if (!session) return { ok: false, error: "session_not_found" };
  if (actingUserOf(session.config) !== null && !m.attended) return { ok: false, error: "acting_session_unattended" };
  const creds = readTrustedSessionCredentials(session.config);
  // The same rule a message from the owner is held to (`assertSessionCredentialsForDispatch`): on SaFE the
  // platform key is what owns the workload, so a turn without one is not started under a shared identity.
  if (CLAW_DEPLOY_MODE !== "kubernetes" && !creds.platformKey) return { ok: false, error: "no_credentials" };
  const secrets = pendingSecretColumns({
    llmKey: creds.llmApiKey,
    platformKey: creds.platformKey,
    // None for a session that acts as a user (see `loadUserEnvForSession`).
    userEnv: await loadUserEnvForSession(q, m.userId, m.sessionId, logger),
    doorbell: RUN_DOORBELL_DISPATCH,
  });
  const inserted = await insertPendingMessage(q, {
    sessionId: m.sessionId, content: m.content, userId: m.userId, toolIds: [], secrets,
    sessionEnv: {}, dedupeKey: m.dedupeKey,
  });
  return { ok: true, pendingId: inserted.id, deduplicated: inserted.deduplicated };
}

/**
 * Start the turn of a queued message if its session is free. A busy session drains its queue itself when its
 * turn completes, so there is nothing to do for it; a failed drain leaves the row for the sweeper.
 */
export async function drainSessionIfIdle(sessionId: string, userId: string): Promise<"drained" | "busy" | "failed"> {
  const idle = await db.query(
    "SELECT 1 FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL AND agent_status <> 'running'",
    [sessionId],
  );
  if (!idle.rowCount) return "busy";
  try {
    await submitMessagePorts.drainOldestPendingMessage(sessionId, userId);
    return "drained";
  } catch (err) {
    logger.warn({ err, sessionId }, "assistant.drain_failed");
    return "failed";
  }
}
