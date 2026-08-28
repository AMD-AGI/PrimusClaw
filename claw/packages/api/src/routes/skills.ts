// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from "fastify";
import { getUser } from "../auth/middleware.js";
import {
  getAllUserSkills, getSkillDetails, saveSkill, deleteSkill,
  manualRollback, getSkillStats,
  addSkillFile, updateSkillFile, removeSkillFile, getSkillFiles, getSkillFile,
} from "../marketplace/skill-service.js";
import { scanMemoryContent } from "../memory/service.js";
import { db } from "../infra/db.js";

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

    const body = req.body as Record<string, unknown>;
    const skillName = body.skill_name as string;
    const content = body.content as string;

    if (!skillName || !content) {
      return reply.status(400).send({ ok: false, error: "skill_name and content required" });
    }

    const blocked = scanMemoryContent(content);
    if (blocked) {
      return reply.status(400).send({ ok: false, error: blocked });
    }

    await saveSkill(skillName, userId, content, "manual");
    return { ok: true };
  });

  // Edit skill — routes through saveSkill (in-place + probation-aware) for v3.0+
  // consistency. The old archive+insert flow created phantom 'archived' rows that
  // evictLeastUsedSkill (active-only filter) couldn't see, leaking storage.
  app.put<{ Params: { userId: string; name: string } }>("/v1/users/:userId/skills/:name", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;

    const body = req.body as Record<string, unknown>;
    const content = body.content as string;
    if (!content) {
      return reply.status(400).send({ ok: false, error: "content required" });
    }
    const blocked = scanMemoryContent(content);
    if (blocked) {
      return reply.status(400).send({ ok: false, error: blocked });
    }

    const skillName = req.params.name;
    const existing = await getSkillDetails(userId, skillName);
    if (!existing.length) {
      return reply.status(404).send({ ok: false, error: "skill not found" });
    }

    // saveSkill's Case 1 (visible row exists) updates in place AND, when source='manual',
    // graduates probation rows to active — exactly what a user-initiated edit should do.
    const description = (body.description as string) ?? existing[0]?.description ?? "";
    await saveSkill(skillName, userId, content, "manual", undefined, description);

    // Re-fetch current version for response (may have been bumped by prior evolutions)
    const refreshed = (await db.query(
      "SELECT version FROM claw_skills WHERE skill_name = $1 AND user_id = $2 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1",
      [skillName, userId]
    )).rows[0];
    return { ok: true, version: refreshed?.version ?? 1 };
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
    if (!result.ok) return reply.status(400).send(result);
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
      const status = result.error?.includes("not found") ? 404 : 400;
      return reply.status(status).send(result);
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
      const status = result.error?.includes("not found") ? 404 : 400;
      return reply.status(status).send(result);
    }
    return { ok: true };
  });
}
