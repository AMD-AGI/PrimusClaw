// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A user's personal skill, read by Brain during a turn (`POST /v1/internal/skills/read`): SKILL.md and the list of its
 * files, or one file. A turn is told only the skills' names and descriptions (`request.user_skills`); this is where the
 * model's `load_skill` gets the rest when it decides to use one.
 *
 * Brain names the session, the turn and the skill; everything else is decided here from server-side rows, as for the
 * memory tools (`internal-memory.ts`): the turn must be a live chat run of that session, the session one the user's
 * skills serve (`userSkillsServe`), and the user whose skill it is is the session's owner, never a field of the
 * request. Only a skill the turn's list would hold is read: active, enabled, not deleted.
 */
import type { FastifyInstance } from "fastify";
import pino from "pino";

import { internalTokenAuth } from "../auth/middleware.js";
import { db } from "../infra/db.js";
import { readUserSkill, readUserSkillFile } from "../marketplace/skill-service.js";
import { userSkillsServe } from "../sessions/user-skills.js";

const logger = pino({ name: "internal-skills" });

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function registerInternalSkillRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/internal/skills/read", { preHandler: internalTokenAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = str(body.session_id);
    const messageId = str(body.message_id);
    const name = str(body.name);
    const path = str(body.path);
    // The fingerprint the turn was told (`user_skills[].content_sha`): a skill changed since is answered with what is
    // current and nothing of it, so a turn never mixes one version's SKILL.md with another's files.
    const expectSha = str(body.content_sha) || undefined;
    if (!sessionId || !messageId || !name) {
      return reply.status(400).send({ ok: false, error: "bad_request", message: "session_id, message_id and name are required" });
    }
    if (body.path !== undefined && !path) {
      return reply.status(400).send({ ok: false, error: "bad_request", message: "path must be a non-empty string" });
    }

    const run = (await db.query(
      `SELECT s.user_id FROM claw_tasks t JOIN claw_sessions s ON s.session_id = t.session_id AND s.deleted_at IS NULL
        WHERE t.session_id = $1 AND t.origin = 'chat' AND t.metadata->>'message_id' = $2
          AND t.status IN ('preparing', 'running', 'cancelling')
        LIMIT 1`,
      [sessionId, messageId],
    )).rows[0] as { user_id: string } | undefined;
    if (!run) {
      logger.warn({ sessionId, messageId }, "user_skill.read_outside_live_chat_turn");
      return reply.status(409).send({ ok: false, error: "no_live_turn", message: "personal skills are read only in a live turn of the user's own chat" });
    }
    if (!(await userSkillsServe(sessionId, run.user_id))) {
      logger.info({ sessionId }, "user_skill.read_refused_session");
      return reply.status(403).send({ ok: false, error: "not_served", message: "personal skills are not available in this conversation" });
    }

    try {
      const out = path
        ? await readUserSkillFile(run.user_id, name, path, { expectSha })
        : await readUserSkill(run.user_id, name, { expectSha });
      // Names and the outcome only: never what the skill says.
      logger.info({ sessionId, skill: name, file: path || null, outcome: out.ok ? "ok" : out.error }, "user_skill.read");
      if (out.ok) return { ok: true, ...out.value };
      if (out.error === "changed") {
        return reply.status(409).send({ ok: false, error: "changed", version: out.version, content_sha: out.content_sha });
      }
      return reply.status(404).send({ ok: false, error: "not_found", message: path ? `no file ${path} in skill ${name}` : `no skill ${name}` });
    } catch (err) {
      logger.error({ sessionId, skill: name, code: (err as { code?: string })?.code ?? "" }, "user_skill.read_failed");
      return reply.status(500).send({ ok: false, error: "unavailable", message: "the skill could not be read" });
    }
  });
}
