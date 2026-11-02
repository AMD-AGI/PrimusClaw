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
 *
 * Talking to the assistant is the existing `POST /v1/sessions/:id/messages`.
 *
 * Everything is the caller's own: the owner is the authenticated user and every
 * read and write filters on it, so another user's item answers 404 rather than
 * 403. Registered only when `CLAW_ASSISTANT_ENABLED` is on; otherwise the paths
 * do not exist.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pino from "pino";
import { getUser } from "../auth/middleware.js";
import { getOrCreateAssistant } from "../assistant/assistant.js";
import {
  acceptWorkItem, BOARD_STATES, getWorkItem, itemView, listWorkItems, recentEvents, stopWorkItem,
  type BoardState, type DecisionResult,
} from "../assistant/work-items.js";
import { CLAW_ASSISTANT_ENABLED } from "../config.js";

const logger = pino({ name: "assistant" });

function requireRealUser(req: FastifyRequest, reply: FastifyReply): string | null {
  const userId = getUser(req)?.userId;
  if (!userId || userId === "default") {
    reply.status(403).send({ ok: false, error: "assistant_requires_authenticated_user" });
    return null;
  }
  return userId;
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
    if (!row) return reply.status(404).send({ ok: false, error: "not_found" });
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
    try {
      return answer(reply, await stopWorkItem({ userId, itemId, source: "user" }));
    } catch (err) {
      // The item is already closed; saying so lets the caller press stop again
      // to send the interrupt a second time.
      logger.error({ err, itemId }, "assistant.stop_interrupt_failed");
      return reply.status(503).send({ ok: false, error: "interrupt_not_recorded" });
    }
  });
}
