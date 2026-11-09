// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyInstance, FastifyRequest } from "fastify";
import { getUser } from "../auth/middleware.js";
import { getAuthMethod } from "../auth/request-credential.js";
import { IDENTITY_TOKEN_METHOD } from "../auth/identity-token.js";
import {
  forgetAllMemories, forgetMemory, getMemoryPreference, listMemories, memoryAvailable, setMemoryPreference, undoMemory,
  updateMemory, writeMemory, type MemoryDraft, type WriteResult,
} from "../memory/service.js";
import { legacyType } from "../memory/gates.js";

/**
 * Whether the request is the person's own say: an identity-provider sign-in with no service acting for them.
 * A key, a BYOK key or a cookie is not (see github-review/attended.ts): a model in a sandbox holds the
 * user's key, so what such a request writes waits for the user's confirmation instead of reaching the prompt.
 */
function attended(req: FastifyRequest): boolean {
  return getAuthMethod(req) === IDENTITY_TOKEN_METHOD && !getUser(req)?.delegation?.actorSub;
}

const WRITE_STATUS: Record<string, number> = {
  invalid: 400, secret: 400, injection: 400, similar_exists: 409, memory_full: 409, not_found: 404,
};

function writeReply(reply: any, r: WriteResult) {
  if (r.ok) return { ok: true, data: { id: r.id, op: r.op, status: r.status } };
  return reply.status(WRITE_STATUS[r.error] ?? 400).send({ ok: false, error: r.error, message: r.message, ...(r.similar ? { similar: r.similar } : {}) });
}

/** The v2 fields, also taken in the v1 shape (`category` + `content`) the earlier routes accepted. */
function draftOf(body: Record<string, unknown>): MemoryDraft & { pinned?: unknown } {
  const v1Content = typeof body.content === "string" ? body.content : undefined;
  return {
    type: body.type ?? (typeof body.category === "string" ? legacyType(body.category) : undefined),
    title: body.title ?? (v1Content !== undefined && body.title === undefined ? [...v1Content.trim()].slice(0, 60).join("") : undefined),
    body: body.body ?? v1Content,
    why: body.why,
    how_to_apply: body.how_to_apply,
    expires_in_days: body.expires_in_days,
    pinned: body.pinned,
  };
}

function entryId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
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

  // The user's preference: their own choice once they made one, the deployment's default
  // (`CLAW_MEMORY_DEFAULT_ON`, off unless set) before; `available` says whether the deployment
  // has memory at all, so a UI can explain a dead toggle.
  app.get<{ Params: { userId: string } }>("/v1/users/:userId/memory-settings", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    return { ok: true, data: { enabled: await getMemoryPreference(userId), available: memoryAvailable() } };
  });

  app.put<{ Params: { userId: string } }>("/v1/users/:userId/memory-settings", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    const enabled = (req.body as Record<string, unknown> | undefined)?.enabled;
    if (typeof enabled !== "boolean") {
      return reply.status(400).send({ ok: false, error: "enabled (boolean) required" });
    }
    await setMemoryPreference(userId, enabled);
    return { ok: true, data: { enabled, available: memoryAvailable() } };
  });

  // Everything the user has, nothing hidden: entries waiting for confirmation, entries past their review
  // date, and the profile earlier versions generated (no longer used, listed so it can be deleted).
  app.get<{ Params: { userId: string } }>("/v1/users/:userId/memories", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    return { ok: true, data: await listMemories(userId) };
  });

  // Writes take the same checks as the model's tools, the quote aside (the caller is the user's own
  // credential, not a conversation). See `attended` for when the entry waits for confirmation.
  app.post<{ Params: { userId: string } }>("/v1/users/:userId/memories", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    // The deployment's switch first: a user's own "on" writes nothing where the deployment has no memory.
    if (!memoryAvailable() || !(await getMemoryPreference(userId))) {
      return reply.status(409).send({ ok: false, error: "memory_disabled", message: "turn memory on before adding memories" });
    }
    const r = await writeMemory(userId, draftOf((req.body ?? {}) as Record<string, unknown>), { kind: "api", attended: attended(req) });
    return writeReply(reply, r);
  });

  // An edit with no field changed confirms the entry: a pending one becomes active (when attended), and one
  // past its review date gets a fresh one.
  app.put<{ Params: { userId: string; id: string } }>("/v1/users/:userId/memories/:id", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    // Editing writes memory content, so it needs the opt-in like any other write.
    // Deleting stays allowed whatever the preference.
    if (!memoryAvailable() || !(await getMemoryPreference(userId))) {
      return reply.status(409).send({ ok: false, error: "memory_disabled", message: "turn memory on before editing memories" });
    }
    const id = entryId(req.params.id);
    if (id === null) return reply.status(404).send({ ok: false, error: "not found" });
    const r = await updateMemory(userId, id, draftOf((req.body ?? {}) as Record<string, unknown>), { kind: "api", attended: attended(req) });
    return writeReply(reply, r);
  });

  // Undo the last change: an edited entry gets its previous version back, a new one is deleted.
  app.post<{ Params: { userId: string; id: string } }>("/v1/users/:userId/memories/:id/undo", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    const id = entryId(req.params.id);
    const done = id === null ? "not_found" : await undoMemory(userId, id, "api");
    if (done === "not_found") return reply.status(404).send({ ok: false, error: "not found" });
    return { ok: true, data: { id, result: done } };
  });

  // Deleting is for good: the content leaves the database (see eraseEntries).
  app.delete<{ Params: { userId: string; id: string } }>("/v1/users/:userId/memories/:id", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    const id = entryId(req.params.id);
    if (id === null || !(await forgetMemory(userId, id, "api"))) {
      return reply.status(404).send({ ok: false, error: "not found" });
    }
    return { ok: true };
  });

  app.delete<{ Params: { userId: string } }>("/v1/users/:userId/memories", async (req, reply) => {
    const userId = resolveUserId(req, reply);
    if (!userId) return;
    return { ok: true, deleted: await forgetAllMemories(userId) };
  });
}
