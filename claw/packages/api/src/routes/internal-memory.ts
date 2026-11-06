// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model's memory tools, called by Brain during a turn (`POST /v1/internal/memory/:tool`).
 *
 * Synchronous, so the model hears the actual answer: stored, already there, close to entry #N, full,
 * refused. Brain names the session and the turn; everything else is decided here from server-side rows: the
 * turn must be a live chat run of that session, the session one memory serves (`memoryAccess`), and the user
 * whose memory it is is the session's owner, never a field of the request.
 */
import type { FastifyInstance } from "fastify";
import pino from "pino";

import { internalTokenAuth } from "../auth/middleware.js";
import { db } from "../infra/db.js";
import { MEMORY_TOOL_NAMES, humanMessages, memoryAccess, runMemoryTool, type MemoryToolName } from "../memory/service.js";

const logger = pino({ name: "internal-memory" });

export async function registerInternalMemoryRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { tool: string } }>(
    "/v1/internal/memory/:tool",
    { preHandler: internalTokenAuth },
    async (req, reply) => {
      const tool = req.params.tool as MemoryToolName;
      if (!(MEMORY_TOOL_NAMES as readonly string[]).includes(tool)) return reply.status(404).send({ ok: false, text: "Error: unknown memory tool" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sessionId = typeof body.session_id === "string" ? body.session_id : "";
      const messageId = typeof body.message_id === "string" ? body.message_id : "";
      const input = (body.input && typeof body.input === "object" ? body.input : {}) as Record<string, unknown>;
      if (!sessionId || !messageId) return reply.status(400).send({ ok: false, text: "Error: session_id and message_id are required" });

      const run = (await db.query(
        `SELECT s.user_id, t.prompt FROM claw_tasks t JOIN claw_sessions s ON s.session_id = t.session_id AND s.deleted_at IS NULL
          WHERE t.session_id = $1 AND t.origin = 'chat' AND t.metadata->>'message_id' = $2
            AND t.status IN ('preparing', 'running', 'cancelling')
          LIMIT 1`,
        [sessionId, messageId],
      )).rows[0] as { user_id: string; prompt: string | null } | undefined;
      if (!run) {
        logger.warn({ sessionId, messageId, tool }, "memory.tool_outside_live_chat_turn");
        return reply.status(409).send({ ok: false, text: "Error: memory is only available in a live turn of the user's own chat; nothing was done." });
      }
      const access = await memoryAccess(sessionId, run.user_id);
      if (!access.serves) {
        logger.info({ sessionId, tool, optedIn: access.optedIn }, "memory.tool_refused_session");
        return reply.status(409).send({ ok: false, text: "Error: memory is not available in this conversation; nothing was done." });
      }
      try {
        const out = await runMemoryTool(tool, input, {
          userId: run.user_id, sessionId, humanMessages: await humanMessages(sessionId), turnMessage: run.prompt ?? "",
        });
        logger.info({ sessionId, tool, ok: out.ok }, "memory.tool");
        return out;
      } catch (err) {
        logger.error({ err, sessionId, tool }, "memory.tool_failed");
        return reply.status(500).send({ ok: false, text: "Error: memory could not be reached; nothing was done." });
      }
    },
  );
}
