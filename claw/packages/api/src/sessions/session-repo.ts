// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The repository a session is bound to, as a turn reads it.
 *
 * `claw_sessions.config.repo` is checked when the session is created (see
 * routes/sessions.ts and `parseSessionRepo` in @claw/protocol), and every turn
 * of the session is handed that repository on its execute request, because the
 * sandbox a turn runs in may be a new one: Brain sets the working tree up again
 * whenever it opens a sandbox for a bound session.
 *
 * Read from the row at the moment a turn is sent, not carried from the create,
 * for the same reason the session's model is: a message that waited in the queue
 * is sent on whatever the session says then.
 */
import { parseSessionRepo, type SessionRepo } from "@claw/protocol";
import pino from "pino";

const logger = pino({ name: "session-repo" });

/**
 * The value of `config.repo` from a `claw_sessions` row, ready for the request.
 *
 * Undefined, not null, when the session has no binding: an absent field is what
 * keeps a run's persisted spec byte-identical to what it was for a session that
 * never had one. A stored value that no longer passes the check (a row written
 * by hand, or by a version with a different rule) is not passed on and is
 * logged: Brain would refuse it anyway, and one bad row must not fail a turn.
 * The url is not logged; it is the user's, and a refused one may hold a credential.
 */
export function sessionRepoFromRow(
  row: { repo?: unknown } | null | undefined,
  sessionId: string,
): SessionRepo | undefined {
  const parsed = parseSessionRepo(row?.repo);
  if (!parsed.ok) {
    logger.warn({ sessionId, reason: parsed.error }, "session.repo_invalid_not_sent");
    return undefined;
  }
  return parsed.repo ?? undefined;
}
