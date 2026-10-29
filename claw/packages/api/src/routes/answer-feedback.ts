// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A thumbs up or down on one answer of a session.
 *
 *   PUT    /v1/sessions/:sessionId/feedback             { message_id, vote, reason? }
 *   DELETE /v1/sessions/:sessionId/feedback/:messageId
 *
 * Both answer `{ ok: true }`. The vote is stored in `claw_answer_feedback`, one
 * row per (session, message, user): a PUT for a message that already has a vote
 * replaces it, so a retry or a changed mind is the same request, and a DELETE
 * takes it back (and is also `ok` when there was nothing to take back).
 *
 * Only the session's creator may vote on it. Another user's session, a deleted
 * one and one that does not exist all answer the same 404, so the route does not
 * tell a caller which session ids exist. That check comes before the body is
 * looked at.
 *
 * `message_id` is the key the client was given with the answer (`claw-<seq>` for
 * a run's events). It is text, and only its shape is checked here: Claw does not
 * promise it is a number, and whether a message by that id exists is not this
 * route's question.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { getUser } from "../auth/middleware.js";
import { canAccessSession } from "../auth/models.js";
import { db } from "../infra/db.js";

/**
 * At most 100 characters, the length Fastify allows a path parameter: the same
 * id has to be accepted by the DELETE route as well as the PUT body, and a
 * longer one would be a vote that could be cast and never taken back.
 */
export const FEEDBACK_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,100}$/;
/**
 * The reason a vote came with. The web client packs the categories, a comment of
 * up to 500 characters and a short excerpt of the conversation into it (about
 * 4.5 KiB at most); this leaves room above that and is still a bound.
 */
export const FEEDBACK_REASON_MAX_CHARS = 8192;
/**
 * Votes one user may hold on one session. A bound on what an authenticated
 * caller can make the table grow by, not a limit a person reaches: it is
 * several times the length of the longest conversations. It is checked in the
 * statement that writes, and two concurrent first votes can both pass it, so it
 * can be overshot by the number of requests in flight at that moment and no more.
 */
export const FEEDBACK_MAX_VOTES_PER_SESSION = 1000;

type Vote = "up" | "down";

export type ParsedVote =
  | { ok: true; messageId: string; vote: Vote; reason: string | null }
  | { ok: false; error: string; reason: string };

/** The request body, or why it is refused. Pure, so the table of spellings can be tested without a server. */
export function parseVoteBody(body: unknown): ParsedVote {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "invalid_body", reason: "the body must be a JSON object" };
  }
  const { message_id: messageId, vote, reason } = body as Record<string, unknown>;
  if (typeof messageId !== "string" || !FEEDBACK_MESSAGE_ID_PATTERN.test(messageId)) {
    return {
      ok: false,
      error: "invalid_message_id",
      reason: "message_id must be 1 to 100 characters from A-Z a-z 0-9 . _ : @ -",
    };
  }
  if (vote !== "up" && vote !== "down") {
    return { ok: false, error: "invalid_vote", reason: 'vote must be "up" or "down"' };
  }
  if (reason === undefined || reason === null) {
    return { ok: true, messageId, vote, reason: null };
  }
  if (typeof reason !== "string") {
    return { ok: false, error: "invalid_reason", reason: "reason must be a string" };
  }
  if (reason.length > FEEDBACK_REASON_MAX_CHARS) {
    return {
      ok: false,
      error: "invalid_reason",
      reason: `reason must be at most ${FEEDBACK_REASON_MAX_CHARS} characters`,
    };
  }
  // PostgreSQL cannot store a NUL in text: left in, the insert would fail and
  // the caller would see a 500 for a request that is theirs to correct.
  if (reason.includes("\u0000")) {
    return { ok: false, error: "invalid_reason", reason: "reason must not contain NUL characters" };
  }
  return { ok: true, messageId, vote, reason: reason === "" ? null : reason };
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.status(404).send({ ok: false, error: "not_found", reason: "session not found" });
}

/** The live (not deleted) session's creator: undefined when there is no such session, null when it has none. */
async function liveSessionOwner(sessionId: string): Promise<string | null | undefined> {
  const row = (await db.query(
    "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
    [sessionId],
  )).rows[0] as { user_id: string | null } | undefined;
  return row ? row.user_id : undefined;
}

export async function registerAnswerFeedbackRoutes(app: FastifyInstance): Promise<void> {
  app.put<{ Params: { sessionId: string } }>("/v1/sessions/:sessionId/feedback", async (req, reply) => {
    const user = getUser(req);
    if (!user) return reply.status(401).send({ ok: false, error: "authentication_required", reason: "authentication required" });
    const { sessionId } = req.params;
    // Creator only, and no administrator exception: a vote is the user's own.
    const owner = await liveSessionOwner(sessionId);
    if (owner === undefined || !canAccessSession(owner, user.userId)) return notFound(reply);

    const parsed = parseVoteBody(req.body);
    if (!parsed.ok) return reply.status(400).send({ ok: false, error: parsed.error, reason: parsed.reason });

    // One statement, so the bound and the write cannot be separated: it inserts
    // while the user is under the bound, or when this message already has a vote
    // (a replacement adds no row), and the key's conflict turns a repeat into an
    // update.
    const written = await db.query(
      `INSERT INTO claw_answer_feedback (session_id, message_id, user_id, vote, reason)
       SELECT $1::text, $2::text, $3::text, $4::text, $5::text
        WHERE (SELECT COUNT(*) FROM claw_answer_feedback WHERE session_id = $1 AND user_id = $3) < $6::int
           OR EXISTS (SELECT 1 FROM claw_answer_feedback
                       WHERE session_id = $1 AND message_id = $2 AND user_id = $3)
       ON CONFLICT (session_id, message_id, user_id)
       DO UPDATE SET vote = EXCLUDED.vote, reason = EXCLUDED.reason, updated_at = NOW()
       RETURNING 1`,
      [sessionId, parsed.messageId, user.userId, parsed.vote, parsed.reason, FEEDBACK_MAX_VOTES_PER_SESSION],
    );
    if (written.rowCount === 0) {
      return reply.status(409).send({
        ok: false,
        error: "feedback_limit_reached",
        reason: `a session holds at most ${FEEDBACK_MAX_VOTES_PER_SESSION} votes per user; take one back first`,
      });
    }
    return { ok: true };
  });

  app.delete<{ Params: { sessionId: string; messageId: string } }>(
    "/v1/sessions/:sessionId/feedback/:messageId",
    async (req, reply) => {
      const user = getUser(req);
      if (!user) return reply.status(401).send({ ok: false, error: "authentication_required", reason: "authentication required" });
      const { sessionId, messageId } = req.params;
      const owner = await liveSessionOwner(sessionId);
      if (owner === undefined || !canAccessSession(owner, user.userId)) return notFound(reply);
      if (!FEEDBACK_MESSAGE_ID_PATTERN.test(messageId)) {
        return reply.status(400).send({
          ok: false,
          error: "invalid_message_id",
          reason: "message id must be 1 to 100 characters from A-Z a-z 0-9 . _ : @ -",
        });
      }
      await db.query(
        "DELETE FROM claw_answer_feedback WHERE session_id = $1 AND message_id = $2 AND user_id = $3",
        [sessionId, messageId, user.userId],
      );
      return { ok: true };
    },
  );
}
