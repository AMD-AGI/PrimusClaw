// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from "fastify";
import { getUser } from "../auth/middleware.js";
import { CLAW_USER_SKILLS_ENABLED } from "../config.js";
import {
  confirmSkillDraft, deleteUserSkillRecorded, discardSkillDraft, listUserSkills, pendingSkillDrafts, saveUserSkillRecorded,
  setUserSkillEnabled, showUserSkill, undoSkillChange,
  getAllUserSkills, getSkillDetails, saveUserSkill, deleteSkill,
  manualRollback, getSkillStats,
  addSkillFile, updateSkillFile, removeSkillFile, getSkillFiles, getSkillFile,
  type SkillWriteRefusal, type SkillWriteRefused,
} from "../marketplace/skill-service.js";

/** The HTTP status of each refusal a skill write can meet. */
const REFUSAL_STATUS: Record<SkillWriteRefusal, number> = {
  invalid_name: 400, invalid: 400, too_large: 400, too_many_files: 400, secret: 400, injection: 400,
  full: 409, not_found: 404, stale: 409,
};

/** A refusal as the routes answer it: `error` is the message, as it always was; `reason` and `at` say which and where. */
function refusalBody(r: SkillWriteRefused): Record<string, unknown> {
  return { ok: false, error: r.message, reason: r.error, ...(r.at ? { at: r.at } : {}) };
}

function fileRefusalBody(r: { error?: string; refusal?: SkillWriteRefusal }): Record<string, unknown> {
  return { ok: false, error: r.error, ...(r.refusal ? { reason: r.refusal } : {}) };
}

/** What an undo answers when it does nothing: the HTTP status of each reason. */
const UNDO_STATUS: Record<string, number> = { not_found: 404, expired: 410, undone: 409, changed: 409, full: 409, too_large: 409 };

/** `invocation` as a body gives it: auto, manual, or absent (anything else is refused by the caller). */
function invocationOf(v: unknown): "auto" | "manual" | undefined | null {
  if (v === undefined || v === null || v === "") return undefined;
  return v === "auto" || v === "manual" ? v : null;
}

/**
 * The skill routes. With CLAW_USER_SKILLS_ENABLED a save, an edit, a delete and a turn-off are recorded so the user can undo them for a
 * day (`change_id`, `POST /v1/users/:userId/skill-changes/:id/undo`), a save or an edit takes `invocation`, and the routes a chat's
 * `/skills` command and a skill card's buttons use are there: the current list (`?view=current`), one skill whole (`?view=current`),
 * disable and enable, undo, and the drafts the assistant suggested. Off, the routes are exactly as they were.
 */
export async function registerSkillRoutes(app: FastifyInstance, userSkills: boolean = CLAW_USER_SKILLS_ENABLED): Promise<void> {

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
    if (userSkills && (req.query as { view?: string } | undefined)?.view === "current") return { ok: true, data: await listUserSkills(userId) };
    const skills = await getAllUserSkills(userId);
    return { ok: true, data: skills };
  });

  app.get<{ Params: { userId: string; name: string } }>("/v1/users/:userId/skills/:name", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    if (userSkills && (req.query as { view?: string } | undefined)?.view === "current") {
      const skill = await showUserSkill(userId, req.params.name);
      if (!skill) return reply.status(404).send({ ok: false, error: "skill not found" });
      return { ok: true, data: skill };
    }
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

    if (userSkills) {
      const invocation = invocationOf(body.invocation);
      if (invocation === null) return reply.status(400).send({ ok: false, error: "invocation is auto or manual" });
      const saved = await saveUserSkillRecorded(userId, {
        name: skillName, content, description: typeof body.description === "string" ? body.description : "", ...(invocation ? { invocation } : {}),
      }, { origin: "api", actor: "api" });
      if (!saved.ok) return reply.status(REFUSAL_STATUS[saved.error]).send(refusalBody(saved));
      return { ok: true, version: saved.version, ...("change_id" in saved ? { change_id: saved.change_id, undo_expires_at: saved.undo_expires_at } : {}) };
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
    if (userSkills) {
      const invocation = invocationOf(body.invocation);
      if (invocation === null) return reply.status(400).send({ ok: false, error: "invocation is auto or manual" });
      const saved = await saveUserSkillRecorded(userId, { name: skillName, content, description, ...(invocation ? { invocation } : {}) }, { origin: "api", actor: "api" });
      if (!saved.ok) return reply.status(REFUSAL_STATUS[saved.error]).send(refusalBody(saved));
      return { ok: true, version: saved.version, changed: saved.changed, ...("change_id" in saved ? { change_id: saved.change_id, undo_expires_at: saved.undo_expires_at } : {}) };
    }
    const saved = await saveUserSkill(userId, { name: skillName, content, description }, { origin: "api", actor: "api" });
    if (!saved.ok) return reply.status(REFUSAL_STATUS[saved.error]).send(refusalBody(saved));
    return { ok: true, version: saved.version };
  });

  app.delete<{ Params: { userId: string; name: string } }>("/v1/users/:userId/skills/:name", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;

    if (userSkills) {
      const out = await deleteUserSkillRecorded(userId, req.params.name, { actor: "api" });
      if (!out.ok) return reply.status(404).send({ ok: false, error: "skill not found" });
      return { ok: true, deleted: out.rows ?? 1, change_id: out.change_id, undo_expires_at: out.undo_expires_at };
    }
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

  if (userSkills) {
    for (const [verb, enabled] of [["disable", false], ["enable", true]] as const) {
      app.post<{ Params: { userId: string; name: string } }>(`/v1/users/:userId/skills/:name/${verb}`, async (req, reply) => {
        const userId = resolveUserId(req, reply);
        if (!userId) return;
        const out = await setUserSkillEnabled(userId, req.params.name, enabled, { actor: "api" });
        if (!out.ok) return reply.status(404).send({ ok: false, error: "skill not found" });
        return { ok: true, enabled, changed: out.changed, version: out.version, ...(out.change_id ? { change_id: out.change_id, undo_expires_at: out.undo_expires_at } : {}) };
      });
    }

    // A skill card's Undo: one change of the user's, taken back while the skill is still as that change left it.
    app.post<{ Params: { userId: string; id: string } }>("/v1/users/:userId/skill-changes/:id/undo", async (req, reply) => {
      const userId = resolveUserId(req, reply);
      if (!userId) return;
      const out = await undoSkillChange(userId, req.params.id, { actor: "api" });
      if (!out.ok) return reply.status(UNDO_STATUS[out.error] ?? 409).send({ ok: false, error: out.message, reason: out.error });
      return { ok: true, data: out };
    });

    // Drafts the assistant suggested where it has no card of its own to answer them (a chat without the assistant).
    app.get<{ Params: { userId: string } }>("/v1/users/:userId/skill-drafts", async (req, reply) => {
      const userId = resolveUserId(req, reply);
      if (!userId) return;
      return { ok: true, data: await pendingSkillDrafts(userId) };
    });
    app.post<{ Params: { userId: string; id: string } }>("/v1/users/:userId/skill-drafts/:id/confirm", async (req, reply) => {
      const userId = resolveUserId(req, reply);
      if (!userId) return;
      const saved = await confirmSkillDraft(userId, req.params.id, { actor: "api" });
      if (!saved.ok) return reply.status(REFUSAL_STATUS[saved.error]).send(refusalBody(saved));
      return { ok: true, name: saved.draft.skill_name, version: saved.version, ...(saved.change_id ? { change_id: saved.change_id, undo_expires_at: saved.undo_expires_at } : {}) };
    });
    app.delete<{ Params: { userId: string; id: string } }>("/v1/users/:userId/skill-drafts/:id", async (req, reply) => {
      const userId = resolveUserId(req, reply);
      if (!userId) return;
      if (!(await discardSkillDraft(userId, req.params.id))) return reply.status(404).send({ ok: false, error: "draft not found" });
      return { ok: true };
    });
  }

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
