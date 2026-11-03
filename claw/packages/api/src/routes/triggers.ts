// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/v1/triggers`: scheduled runs owned by the user who creates them.
 *
 * Only the creator can see or change a trigger; there is no route that creates
 * one for somebody else. Creating or resuming one records the caller's current
 * credentials on the row, since the run that fires later has no request to take
 * them from.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertSessionCredentialsForDispatch } from "../auth/session-credentials.js";
import { getUser } from "../auth/middleware.js";
import { TRIGGER_MIN_INTERVAL_MINUTES } from "../config.js";
import { db } from "../infra/db.js";
import { checkSchedule, nextFireAfter } from "../triggers/schedule.js";
import {
  deleteTrigger, insertTrigger, listTriggers, parseTriggerInput, sealTriggerCredentials,
  TRIGGER_MAX_NAME, TRIGGER_MAX_PROMPT as MAX_PROMPT, TRIGGER_PUBLIC_COLUMNS as PUBLIC_COLUMNS,
} from "../triggers/store.js";

function owner(req: FastifyRequest, reply: FastifyReply) {
  const user = getUser(req);
  if (!user?.userId || user.userId === "default") {
    reply.status(403).send({ ok: false, error: "triggers_require_authenticated_user" });
    return null;
  }
  return user;
}

function sealCredentials(user: NonNullable<ReturnType<typeof getUser>>): string {
  return sealTriggerCredentials({
    platformKey: user.platformKey || "", virtualKey: user.virtualKey || "", userName: user.userName || "",
  });
}

export async function registerTriggerRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/triggers", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    const parsed = parseTriggerInput((req.body ?? {}) as Record<string, unknown>);
    if (!parsed.ok) return reply.status(400).send({ ok: false, error: parsed.error });
    try {
      assertSessionCredentialsForDispatch("trigger", user);
    } catch {
      return reply.status(400).send({ ok: false, error: "no platform key on this request; a trigger needs its owner's key" });
    }
    const row = await insertTrigger(user.userId, parsed.input, sealCredentials(user));
    if (!row) return reply.status(409).send({ ok: false, error: "trigger_limit_reached" });
    return { ok: true, data: row };
  });

  app.get("/v1/triggers", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    return { ok: true, data: await listTriggers(user.userId) };
  });

  app.get("/v1/triggers/:id", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    const r = await db.query(
      `SELECT ${PUBLIC_COLUMNS} FROM claw_triggers WHERE trigger_id = $1 AND owner_user_id = $2`,
      [(req.params as any).id, user.userId]);
    if (!r.rows.length) return reply.status(404).send({ ok: false, error: "not_found" });
    return { ok: true, data: r.rows[0] };
  });

  app.patch("/v1/triggers/:id", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    const id = (req.params as any).id as string;
    const cur = (await db.query(
      "SELECT name, prompt, schedule, timezone FROM claw_triggers WHERE trigger_id = $1 AND owner_user_id = $2",
      [id, user.userId])).rows[0] as { name: string; prompt: string; schedule: string; timezone: string } | undefined;
    if (!cur) return reply.status(404).send({ ok: false, error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : cur.name;
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : cur.prompt;
    const schedule = typeof b.schedule === "string" ? b.schedule.trim() : cur.schedule;
    const timezone = typeof b.timezone === "string" ? b.timezone : cur.timezone;
    if (!name || name.length > TRIGGER_MAX_NAME || !prompt || prompt.length > MAX_PROMPT) {
      return reply.status(400).send({ ok: false, error: "invalid name or prompt" });
    }
    const check = checkSchedule(schedule, timezone, TRIGGER_MIN_INTERVAL_MINUTES);
    if (!check.ok) return reply.status(400).send({ ok: false, error: check.error });
    const r = await db.query(
      `UPDATE claw_triggers SET name=$3, prompt=$4, schedule=$5, timezone=$6, next_fire_at=$7,
              updated_at=NOW()
        WHERE trigger_id = $1 AND owner_user_id = $2 RETURNING ${PUBLIC_COLUMNS}`,
      // The stored credential is left alone: only create and resume re-seal it,
      // and both check that this request carries a key. An edit from a client
      // that forwards none must not replace a working key with an empty one.
      [id, user.userId, name, prompt, schedule, timezone,
        nextFireAfter(schedule, timezone, new Date())],
    );
    return { ok: true, data: r.rows[0] };
  });

  app.post("/v1/triggers/:id/pause", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    const r = await db.query(
      `UPDATE claw_triggers SET paused_reason = 'user', updated_at = NOW()
        WHERE trigger_id = $1 AND owner_user_id = $2 RETURNING ${PUBLIC_COLUMNS}`,
      [(req.params as any).id, user.userId]);
    if (!r.rows.length) return reply.status(404).send({ ok: false, error: "not_found" });
    return { ok: true, data: r.rows[0] };
  });

  app.post("/v1/triggers/:id/resume", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    const id = (req.params as any).id as string;
    const cur = (await db.query(
      "SELECT schedule, timezone FROM claw_triggers WHERE trigger_id = $1 AND owner_user_id = $2",
      [id, user.userId])).rows[0] as { schedule: string; timezone: string } | undefined;
    if (!cur) return reply.status(404).send({ ok: false, error: "not_found" });
    try {
      assertSessionCredentialsForDispatch("trigger", user);
    } catch {
      return reply.status(400).send({ ok: false, error: "no platform key on this request" });
    }
    // From the next FUTURE time: a paused trigger does not catch up on resume.
    const r = await db.query(
      `UPDATE claw_triggers SET paused_reason = NULL, consecutive_failures = 0, next_fire_at = $3,
              credential_enc = $4, updated_at = NOW()
        WHERE trigger_id = $1 AND owner_user_id = $2 RETURNING ${PUBLIC_COLUMNS}`,
      [id, user.userId, nextFireAfter(cur.schedule, cur.timezone, new Date()), sealCredentials(user)]);
    return { ok: true, data: r.rows[0] };
  });

  app.delete("/v1/triggers/:id", async (req, reply) => {
    const user = owner(req, reply);
    if (!user) return;
    if (!await deleteTrigger(user.userId, (req.params as any).id)) return reply.status(404).send({ ok: false, error: "not_found" });
    return { ok: true };
  });
}
