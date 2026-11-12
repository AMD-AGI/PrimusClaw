// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from "fastify";
import { getUser } from "../auth/middleware.js";
import {
  getAllUserSkills, getSkillDetails, saveUserSkill, deleteSkill,
  manualRollback, getSkillStats,
  addSkillFile, updateSkillFile, removeSkillFile, getSkillFiles, getSkillFile,
  type SkillWriteRefusal, type SkillWriteRefused,
} from "../marketplace/skill-service.js";

/** The HTTP status of each refusal a skill write can meet. */
const REFUSAL_STATUS: Record<SkillWriteRefusal, number> = {
  invalid_name: 400, invalid: 400, too_large: 400, too_many_files: 400, secret: 400, injection: 400,
  full: 409, not_found: 404,
};

/** A refusal as the routes answer it: `error` is the message, as it always was; `reason` and `at` say which and where. */
function refusalBody(r: SkillWriteRefused): Record<string, unknown> {
  return { ok: false, error: r.message, reason: r.error, ...(r.at ? { at: r.at } : {}) };
}

function fileRefusalBody(r: { error?: string; refusal?: SkillWriteRefusal }): Record<string, unknown> {
  return { ok: false, error: r.error, ...(r.refusal ? { reason: r.refusal } : {}) };
}

export async function registerSkillRoutes(app: FastifyInstance): Promise<void> {

  function resolveUserId(req: any, reply: any): string | null {
    const user = getUser(req);
    const paramId = req.params.userId;
    const userId = paramId === "me" ? user?.userId : paramId;
    if (!userId || (user?.userId !== userId)) {
      reply.status(403).send({ ok: false, error: "access denied" });
      return null;
    }
    return userId;
  }

  app.get<{ Params: { userId: string } }>("/v1/users/:userId/skills", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    const skills = await getAllUserSkills(userId);
    return { ok: true, data: skills };
  });

  app.get<{ Params: { userId: string; name: string } }>("/v1/users/:userId/skills/:name", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    const versions = await getSkillDetails(userId, req.params.name);
    if (!versions.length) {
      return reply.status(404).send({ ok: false, error: "skill not found" });
    }
    return { ok: true, data: versions };
  });

  app.post<{ Params: { userId: string } }>("/v1/users/:userId/skills", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const skillName = body.skill_name as string;
    const content = body.content as string;

    if (!skillName || !content || typeof skillName !== "string" || typeof content !== "string") {
      return reply.status(400).send({ ok: false, error: "skill_name and content required" });
    }

    const saved = await saveUserSkill(userId, {
      name: skillName, content, description: typeof body.description === "string" ? body.description : "",
    }, { origin: "api", actor: "api" });
    if (!saved.ok) return reply.status(REFUSAL_STATUS[saved.error]).send(refusalBody(saved));
    return { ok: true, version: saved.version };
  });

  // Edit skill — routes through saveSkill (in-place + probation-aware) for v3.0+
  // consistency. The old archive+insert flow created phantom 'archived' rows that
  // evictLeastUsedSkill (active-only filter) couldn't see, leaking storage.
  app.put<{ Params: { userId: string; name: string } }>("/v1/users/:userId/skills/:name", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const content = body.content as string;
    if (!content || typeof content !== "string") {
      return reply.status(400).send({ ok: false, error: "content required" });
    }

    const skillName = req.params.name;
    const existing = await getSkillDetails(userId, skillName);
    if (!existing.length) {
      return reply.status(404).send({ ok: false, error: "skill not found" });
    }

    // saveSkill's Case 1 (visible row exists) updates in place AND, when source='manual',
    // graduates probation rows to active — exactly what a user-initiated edit should do.
    const description = typeof body.description === "string" ? body.description : (existing[0]?.description ?? "");
    const saved = await saveUserSkill(userId, { name: skillName, content, description }, { origin: "api", actor: "api" });
    if (!saved.ok) return reply.status(REFUSAL_STATUS[saved.error]).send(refusalBody(saved));
    return { ok: true, version: saved.version };
  });

  app.delete<{ Params: { userId: string; name: string } }>("/v1/users/:userId/skills/:name", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;

    const count = await deleteSkill(req.params.name, userId);
    if (!count) {
      return reply.status(404).send({ ok: false, error: "skill not found" });
    }
    return { ok: true, deleted: count };
  });

  app.post<{ Params: { userId: string; name: string } }>("/v1/users/:userId/skills/:name/rollback", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;

    const success = await manualRollback(req.params.name, userId);
    if (!success) {
      return reply.status(400).send({ ok: false, error: "cannot rollback (no previous version or already at v1)" });
    }
    return { ok: true };
  });

  // Skill execution stats
  app.get<{ Params: { userId: string; name: string } }>("/v1/users/:userId/skills/:name/stats", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;

    const stats = await getSkillStats(req.params.name, userId);
    return { ok: true, data: stats };
  });

  // ===== E2: Sub-file endpoints =====
  // Paths: references/, templates/, scripts/, assets/

  app.get<{ Params: { userId: string; name: string } }>("/v1/users/:userId/skills/:name/files", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    const files = await getSkillFiles(userId, req.params.name);
    return { ok: true, data: files };
  });

  app.get<{ Params: { userId: string; name: string; "*": string } }>("/v1/users/:userId/skills/:name/files/*", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    const filePath = req.params["*"];
    if (!filePath) return reply.status(400).send({ ok: false, error: "file path required" });
    const file = await getSkillFile(userId, req.params.name, filePath);
    if (!file) return reply.status(404).send({ ok: false, error: "file not found" });
    return { ok: true, data: file };
  });

  app.post<{ Params: { userId: string; name: string } }>("/v1/users/:userId/skills/:name/files", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    const body = req.body as Record<string, unknown>;
    const result = await addSkillFile(userId, req.params.name, {
      file_path: body.file_path as string,
      content: body.content as string,
      is_binary: body.is_binary as boolean | undefined,
    });
    if (!result.ok) return reply.status(result.refusal ? REFUSAL_STATUS[result.refusal] : 400).send(fileRefusalBody(result));
    return { ok: true };
  });

  app.put<{ Params: { userId: string; name: string; "*": string } }>("/v1/users/:userId/skills/:name/files/*", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    const filePath = req.params["*"];
    if (!filePath) return reply.status(400).send({ ok: false, error: "file path required" });
    const body = req.body as Record<string, unknown>;
    if (body.content === undefined) return reply.status(400).send({ ok: false, error: "content required" });
    const result = await updateSkillFile(userId, req.params.name, {
      file_path: filePath,
      content: body.content as string,
      is_binary: body.is_binary as boolean | undefined,
    });
    if (!result.ok) {
      const status = result.refusal ? REFUSAL_STATUS[result.refusal] : 400;
      return reply.status(status).send(fileRefusalBody(result));
    }
    return { ok: true };
  });

  app.delete<{ Params: { userId: string; name: string; "*": string } }>("/v1/users/:userId/skills/:name/files/*", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    const filePath = req.params["*"];
    if (!filePath) return reply.status(400).send({ ok: false, error: "file path required" });
    const result = await removeSkillFile(userId, req.params.name, filePath);
    if (!result.ok) {
      const status = result.refusal ? REFUSAL_STATUS[result.refusal] : 400;
      return reply.status(status).send(fileRefusalBody(result));
    }
    return { ok: true };
  });
}
