// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from "fastify";
import { getUser } from "../auth/middleware.js";
import { getMemoryEntries, insertMemoryEntry, updateMemoryEntry, deleteMemoryEntry, deleteAllMemories, scanMemoryContent, maybeUpdateUserProfile } from "../memory/service.js";
import { CLAW_MEMORY_ENABLED } from "../config.js";
import pino from "pino";

const logger = pino({ name: "memory-routes" });

/**
 * Refresh the user's memory-derived profile in the background after a manual
 * mutation (non-blocking). No-op when CLAW_MEMORY_ENABLED is false, so manual
 * edits don't bypass the cold-storage contract.
 */
function scheduleProfileRefresh(userId: string): void {
  if (!CLAW_MEMORY_ENABLED) return;
  setImmediate(() => {
    maybeUpdateUserProfile(userId).catch((err: unknown) =>
      logger.warn({ err: (err as Error)?.message, userId }, "memory.profile_refresh_failed"));
  });
}

export async function registerMemoryRoutes(app: FastifyInstance): Promise<void> {

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

  app.get<{ Params: { userId: string } }>("/v1/users/:userId/memories", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;

    const entries = await getMemoryEntries(userId, 50);
    return { ok: true, data: entries };
  });

  app.post<{ Params: { userId: string } }>("/v1/users/:userId/memories", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;

    const body = req.body as Record<string, unknown>;
    const category = body.category as string;
    const content = body.content as string;
    const importance = (body.importance as number) ?? 0.7;

    if (!category || !content) {
      return reply.status(400).send({ ok: false, error: "category and content required" });
    }

    const blocked = scanMemoryContent(content);
    if (blocked) {
      return reply.status(400).send({ ok: false, error: blocked });
    }

    await insertMemoryEntry(userId, { category, content, importance, sourceType: "manual" });
    scheduleProfileRefresh(userId);
    return { ok: true };
  });

  app.put<{ Params: { userId: string; id: string } }>("/v1/users/:userId/memories/:id", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;

    const entryId = req.params.id;
    const body = req.body as Record<string, unknown>;
    const content = body.content as string | undefined;
    const category = body.category as string | undefined;
    const importance = body.importance as number | undefined;

    if (content === undefined && category === undefined && importance === undefined) {
      return reply.status(400).send({ ok: false, error: "at least one of content/category/importance required" });
    }

    if (content !== undefined) {
      const blocked = scanMemoryContent(content);
      if (blocked) return reply.status(400).send({ ok: false, error: blocked });
    }

    const updated = await updateMemoryEntry(userId, entryId, { content, category, importance });
    if (!updated) {
      return reply.status(404).send({ ok: false, error: "not found" });
    }
    scheduleProfileRefresh(userId);
    return { ok: true };
  });

  app.delete<{ Params: { userId: string; id: string } }>("/v1/users/:userId/memories/:id", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;

    const entryId = req.params.id;

    const deleted = await deleteMemoryEntry(userId, entryId);
    if (!deleted) {
      return reply.status(404).send({ ok: false, error: "not found" });
    }
    scheduleProfileRefresh(userId);
    return { ok: true };
  });

  app.delete<{ Params: { userId: string } }>("/v1/users/:userId/memories", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;

    const count = await deleteAllMemories(userId);
    // After mass-delete, profile likely has nothing to derive from; still refresh
    // so downstream consumers see a consistent (possibly empty) profile
    scheduleProfileRefresh(userId);
    return { ok: true, deleted: count };
  });
}
