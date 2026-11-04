// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant and its board of work items.
 *
 *   POST /v1/assistant                    the caller's assistant session, made on first use
 *   GET  /v1/work-items?state=            the board: in_progress | needs_you | done
 *   GET  /v1/work-items/:id               one item with its latest events
 *   POST /v1/work-items/:id/accept        {version}: the result the user saw, and only that one
 *   POST /v1/work-items/:id/stop
 *   POST /v1/assistant/reviews            reviews on someone's behalf, as items (`review-items.ts`)
 *   POST /v1/assistant/reviews/:id/restart the same pull request again, with what the body changes
 *   GET  /v1/assistant/scopes             the group chats and repositories the caller's assistant watches
 *   PUT  /v1/assistant/scopes             {scope, mode}: observe, or auto (only from a person; see `observe.ts`)
 *   POST /v1/assistant/observations       {scope, content, message_id?}: one message of a watched place, to its watcher
 *   GET  /v1/assistant/observations?scope= what the assistant would have done there, message by message
 *
 * Talking to the assistant is the existing `POST /v1/sessions/:id/messages`.
 *
 * Everything is the caller's own: the owner is the authenticated user and every
 * read and write filters on it, so another user's item answers 404 rather than
 * 403. Registered only when `CLAW_ASSISTANT_ENABLED` is on; otherwise the paths
 * do not exist.
 *
 * One exception, and it is narrow: a review someone (R) asked of another person
 * (X) is X's item, and R may read how it stands and stop it, nothing else. R is
 * answered with four facts only (`requester-view.ts`), on the read and on both
 * branches of the stop; accept and restart stay X's (404 for R), and X's session
 * is X's (its routes answer R 404 as for any other session).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pino from "pino";
import { getUser } from "../auth/middleware.js";
import { getAuthMethod } from "../auth/request-credential.js";
import { getOrCreateAssistant } from "../assistant/assistant.js";
import {
  acceptWorkItem, BOARD_STATES, getWorkItem, itemView, listWorkItems, recentEvents, stopWorkItem,
  type BoardState, type DecisionResult,
} from "../assistant/work-items.js";
import {
  parseRestartRequest, parseReviewRequest, restartReview, ReviewItemRefused, startReviews, syncReviewItem,
} from "../assistant/review-items.js";
import {
  getOrCreateScope, listObservations, listScopes, OBSERVATIONS_LIST_MAX, OBSERVED_CONTENT_MAX_CHARS, parseScope,
  queueObservation, SCOPE_MODES, setScopeMode, type ScopeMode,
} from "../assistant/observe.js";
import { MissingPlatformKeyError, stampSessionCredentials } from "../auth/session-credentials.js";
import { classifyAttendedCaller } from "../github-review/attended.js";
import { readGithubReviewSettings } from "../github-review/settings.js";
import {
  CLAW_ASSISTANT_ENABLED, CLAW_ASSISTANT_OBSERVE, CLAW_ASSISTANT_REVIEW_ITEMS, CLAW_GITHUB_REVIEW_ENABLED,
} from "../config.js";
import { asRequesterAnswer } from "../assistant/review-items.js";
import { requesterViewOf } from "../assistant/requester-view.js";
import { verifyActingAsCredentials } from "../auth/identity-token.js";
import { credentialVerifier } from "../auth/middleware.js";
import { db } from "../infra/db.js";

const logger = pino({ name: "assistant" });

function requireRealUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = getUser(req)?.userId;
  if (!userId || userId === "default") {
    reply.status(403).send({ ok: false, error: "assistant_requires_authenticated_user" });
    return null;
  }
  return userId;
}

/**
 * The credentials a service brought for the person a review is asked of, checked (`verifyActingAsCredentials`): a port, so that a test
 * can answer without an identity provider or SaFE.
 */
export const actingAsCredentialPorts = {
  verify: (input: { token: string; apiKey: string; actingAs: string }) => verifyActingAsCredentials(
    { ...input, allowedClients: readGithubReviewSettings().decisionClientIds }, credentialVerifier(),
  ),
};

function header(req: FastifyRequest, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] ?? "" : v ?? "").trim();
}

/** A review item someone else owns that this user asked for, or null. */
async function requestedItem(userId: string, itemId: string): Promise<Record<string, unknown> | null> {
  const row = (await db.query(
    "SELECT * FROM claw_work_items WHERE item_id = $1 AND kind = 'review' AND params->>'requested_by' = $2 AND user_id <> $2",
    [itemId, userId],
  )).rows[0] as Record<string, unknown> | undefined;
  return row ?? null;
}

function answer(reply: FastifyReply, result: DecisionResult) {
  if (result.status === "not_found") return reply.status(404).send({ ok: false, error: "not_found" });
  if (result.status === "conflict") return reply.status(409).send({ ok: false, error: result.error, data: result.item });
  return reply.send({ ok: true, data: result.item });
}

export async function registerAssistantRoutes(app: FastifyInstance): Promise<void> {
  if (!CLAW_ASSISTANT_ENABLED) return;

  app.post("/v1/assistant", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const { sessionId, created } = await getOrCreateAssistant(userId);
    return reply.send({ ok: true, data: { session_id: sessionId, created } });
  });

  app.get("/v1/work-items", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const state = (req.query as { state?: string }).state;
    if (state !== undefined && !(BOARD_STATES as readonly string[]).includes(state)) {
      return reply.status(400).send({ ok: false, error: `state must be one of ${BOARD_STATES.join(", ")}` });
    }
    return reply.send({ ok: true, data: await listWorkItems(userId, (state as BoardState | undefined) ?? null) });
  });

  app.get("/v1/work-items/:id", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const row = await getWorkItem(userId, (req.params as { id: string }).id);
    if (!row) {
      const asked = await requestedItem(userId, (req.params as { id: string }).id);
      if (asked) return reply.send({ ok: true, data: await requesterViewOf(db, asked) });
      return reply.status(404).send({ ok: false, error: "not_found" });
    }
    return reply.send({
      ok: true,
      data: {
        ...itemView(row),
        worker_session_id: row.worker_session_id,
        repo: row.repo ?? null,
        created_at: row.created_at,
        closed_at: row.closed_at ?? null,
        events: await recentEvents(row.item_id as string),
      },
    });
  });

  app.post("/v1/work-items/:id/accept", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const version = ((req.body ?? {}) as { version?: unknown }).version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
      return reply.status(400).send({ ok: false, error: "version must be a non-negative integer" });
    }
    return answer(reply, await acceptWorkItem(userId, (req.params as { id: string }).id, version));
  });

  app.post("/v1/work-items/:id/stop", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const itemId = (req.params as { id: string }).id;
    // The person who asked for a review stops it as its owner would (the held writes are denied in X's name), and hears only the four facts.
    if (!(await getWorkItem(userId, itemId))) {
      const asked = await requestedItem(userId, itemId);
      if (asked) {
        try {
          const result = await stopWorkItem({ userId: asked.user_id as string, itemId, source: "user", reason: "stopped by the requester" });
          if (result.status === "not_found") return reply.status(404).send({ ok: false, error: "not_found" });
          if (result.status === "conflict" && result.error === "already_merged") await syncReviewItem(itemId).catch(() => null);
          const now = (await db.query("SELECT * FROM claw_work_items WHERE item_id = $1", [itemId])).rows[0] as Record<string, unknown>;
          const view = await requesterViewOf(db, now);
          if (result.status === "conflict") return reply.status(409).send({ ok: false, error: result.error, data: view });
          return reply.send({ ok: true, data: view });
        } catch (err) {
          logger.error({ err, itemId }, "assistant.stop_interrupt_failed");
          return reply.status(503).send({ ok: false, error: "interrupt_not_recorded" });
        }
      }
    }
    try {
      const result = await stopWorkItem({ userId, itemId, source: "user" });
      // A merge the board has not caught up with yet: the item says so now rather than at the next sweep.
      if (result.status === "conflict" && result.error === "already_merged") {
        const synced = await syncReviewItem(itemId).catch(() => null);
        if (synced) return reply.status(409).send({ ok: false, error: result.error, data: synced });
      }
      return answer(reply, result);
    } catch (err) {
      // The item is already closed; saying so lets the caller press stop again
      // to send the interrupt a second time.
      logger.error({ err, itemId }, "assistant.stop_interrupt_failed");
      return reply.status(503).send({ ok: false, error: "interrupt_not_recorded" });
    }
  });

  if (CLAW_ASSISTANT_OBSERVE) registerObserveRoutes(app);

  if (!CLAW_ASSISTANT_REVIEW_ITEMS || !CLAW_GITHUB_REVIEW_ENABLED) return;

  const refused = (reply: FastifyReply, err: unknown) => {
    if (!(err instanceof ReviewItemRefused)) throw err;
    return reply.status(err.status).send({ ok: false, error: err.code, message: err.message, data: err.data });
  };

  app.post("/v1/assistant/reviews", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    try {
      const request = parseReviewRequest(req.body);
      const forOther = request.actingAs !== null && request.actingAs !== userId;
      if (forOther) {
        // The person asked of proves it is theirs to give: their delegated token and their own key, brought by an allowed service.
        const verified = await actingAsCredentialPorts.verify({
          token: header(req, "x-acting-as-token"), apiKey: header(req, "x-acting-as-api-key"), actingAs: request.actingAs!,
        });
        if (!verified.ok) return reply.status(verified.status).send({ ok: false, error: verified.error, message: verified.message, data: {} });
        request.actingAsUser = verified.user;
      }
      const items = await startReviews(getUser(req)!, getAuthMethod(req), request);
      // The session is the reviewer's: the person who asked is not told its id.
      return reply.send({ ok: true, data: { items: forOther ? items.map(asRequesterAnswer) : items } });
    } catch (err) {
      return refused(reply, err);
    }
  });

  app.post("/v1/assistant/reviews/:id/restart", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    try {
      const out = await restartReview(getUser(req)!, getAuthMethod(req), (req.params as { id: string }).id, parseRestartRequest(req.body));
      return reply.send({ ok: true, data: out });
    } catch (err) {
      return refused(reply, err);
    }
  });
}

/** The scope a request names, or a 400 that says what one looks like. */
function requestScope(reply: FastifyReply, raw: unknown): string | null {
  const scope = parseScope(raw);
  if (!scope) {
    reply.status(400).send({ ok: false, error: "invalid_scope", message: "scope is group:<channel>:<id> or repo:<owner>/<repo>" });
  }
  return scope;
}

function scopeView(row: { scope: string; mode: ScopeMode; session_id: string; mode_set_at: Date | null; created_at: Date }) {
  // Acting in `auto` is not built yet: the record is kept in both modes, and nothing is done in either.
  return { scope: row.scope, mode: row.mode, session_id: row.session_id, acting: false, mode_set_at: row.mode_set_at, created_at: row.created_at };
}

function registerObserveRoutes(app: FastifyInstance): void {
  app.get("/v1/assistant/scopes", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    return reply.send({ ok: true, data: (await listScopes(userId)).map(scopeView) });
  });

  app.put("/v1/assistant/scopes", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const body = (req.body ?? {}) as { scope?: unknown; mode?: unknown };
    const scope = requestScope(reply, body.scope);
    if (!scope) return;
    const mode = body.mode ?? "observe";
    if (typeof mode !== "string" || !(SCOPE_MODES as readonly string[]).includes(mode)) {
      return reply.status(400).send({ ok: false, error: "invalid_mode", message: `mode is one of ${SCOPE_MODES.join(", ")}` });
    }
    const method = getAuthMethod(req);
    let via: Record<string, unknown> = { method };
    if (mode === "auto") {
      // Letting the assistant act in a place is the person's say, and a key a sandbox holds is not a person.
      const caller = classifyAttendedCaller(method, getUser(req)!, readGithubReviewSettings().decisionClientIds);
      if (!caller.ok) {
        return reply.status(403).send({ ok: false, error: caller.error, message: "only you, signed in, can let the assistant act there" });
      }
      via = { method, service: caller.via };
    }
    return reply.send({ ok: true, data: scopeView(await setScopeMode(userId, scope, mode as ScopeMode, via)) });
  });

  app.post("/v1/assistant/observations", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const body = (req.body ?? {}) as { scope?: unknown; content?: unknown; message_id?: unknown };
    const scope = requestScope(reply, body.scope);
    if (!scope) return;
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content || content.length > OBSERVED_CONTENT_MAX_CHARS) {
      return reply.status(400).send({ ok: false, error: "invalid_content", message: `content is 1 to ${OBSERVED_CONTENT_MAX_CHARS} characters` });
    }
    const messageId = body.message_id;
    if (messageId !== undefined && (typeof messageId !== "string" || !messageId || messageId.length > 200)) {
      return reply.status(400).send({ ok: false, error: "invalid_message_id" });
    }
    const { row } = await getOrCreateScope(userId, scope);
    try {
      // The watcher's turns run as the person who handed it the message, as their own messages run.
      await stampSessionCredentials(row.session_id, getUser(req)!);
    } catch (err) {
      if (err instanceof MissingPlatformKeyError) return reply.status(403).send({ ok: false, error: "platform_key_required" });
      throw err;
    }
    const queued = await queueObservation({
      userId, sessionId: row.session_id, scope, mode: row.mode, content, messageId: (messageId as string | undefined) ?? null,
    });
    if (!queued.ok) {
      const status = queued.error === "observe_backlog" ? 429 : 409;
      return reply.status(status).send({ ok: false, error: queued.error });
    }
    return reply.send({ ok: true, data: { ...queued, acting: false } });
  });

  app.get("/v1/assistant/observations", async (req, reply) => {
    const userId = requireRealUser(req, reply);
    if (!userId) return;
    const query = req.query as { scope?: string; limit?: string };
    const scope = requestScope(reply, query.scope);
    if (!scope) return;
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > OBSERVATIONS_LIST_MAX) {
      return reply.status(400).send({ ok: false, error: `limit is 1 to ${OBSERVATIONS_LIST_MAX}` });
    }
    const record = await listObservations(userId, scope, limit);
    if (!record) return reply.status(404).send({ ok: false, error: "not_found" });
    return reply.send({ ok: true, data: record });
  });
}
